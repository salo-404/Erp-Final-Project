import re

import sqlglot
from sqlglot import exp
from sqlglot.optimizer.scope import Scope, traverse_scope

from sql.database_context import ALLOWED_TABLES, DATABASE_SCHEMA


FORBIDDEN_KEYWORDS = {
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "UPSERT",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "COPY",
    "GRANT",
    "REVOKE",
    "CALL",
    "DO",
    "EXECUTE",
    "VACUUM",
    "ANALYZE",
    "REFRESH",
}


FORBIDDEN_SCHEMAS = {
    "pg_catalog",
    "information_schema",
}


def _columns_from_database_schema() -> dict[str, set[str]]:
    """Extract SQL-visible columns from the canonical DATABASE_SCHEMA text."""
    columns = {table: set() for table in ALLOWED_TABLES}
    current_table: str | None = None

    for raw_line in DATABASE_SCHEMA.splitlines():
        line = raw_line.strip()
        if line in ALLOWED_TABLES:
            current_table = line
        elif current_table and line.startswith("- ") and ":" in line:
            columns[current_table].add(line[2:].split(":", 1)[0].strip())
        elif line and not line.startswith("-"):
            current_table = None

    return columns


DATABASE_COLUMNS = _columns_from_database_schema()
PRISMA_CAMEL_CASE_COLUMNS = {
    column
    for columns in DATABASE_COLUMNS.values()
    for column in columns
    if any(character.isupper() for character in column)
}


class IdentifierQuotingError(ValueError):
    """Raised when a case-sensitive Prisma column is not double-quoted."""


class SchemaValidationError(ValueError):
    """Raised when SQL references a column absent from its database source."""


def _source_columns(source: exp.Expression | Scope) -> set[str]:
    if isinstance(source, exp.Table):
        return DATABASE_COLUMNS.get(source.name, set())

    if isinstance(source, Scope):
        output_columns = set(source.expression.named_selects)
        if "*" not in output_columns:
            return output_columns

        expanded_columns = output_columns - {"*"}
        for nested_source in source.sources.values():
            expanded_columns.update(_source_columns(nested_source))
        return expanded_columns

    return set()


def _resolve_source(scope: Scope, qualifier: str) -> exp.Expression | Scope | None:
    """Resolve a local or correlated outer-query source alias."""
    current_scope: Scope | None = scope
    while current_scope is not None:
        source = current_scope.sources.get(qualifier)
        if source is not None:
            return source
        current_scope = current_scope.parent
    return None


def _validate_schema_columns(statement: exp.Expression) -> None:
    """Validate physical columns while preserving aliases and derived outputs."""
    for scope in traverse_scope(statement):
        result_aliases = set(scope.expression.named_selects)

        for column in scope.columns:
            column_name = column.name
            qualifier = column.table

            if qualifier:
                source = _resolve_source(scope, qualifier)
                if source is None:
                    raise SchemaValidationError(
                        f"Unknown table or derived-table alias: {qualifier}"
                    )
                if column_name not in _source_columns(source):
                    source_name = source.name if isinstance(source, exp.Table) else qualifier
                    raise SchemaValidationError(
                        f"Column {qualifier}.{column_name} does not exist in source {source_name}"
                    )
                continue

            if column_name in result_aliases:
                continue

            matching_sources = [
                alias
                for alias, source in scope.sources.items()
                if column_name in _source_columns(source)
            ]
            if len(matching_sources) == 1:
                continue
            if not matching_sources:
                raise SchemaValidationError(
                    f"Column {column_name} does not exist in any referenced source"
                )
            raise SchemaValidationError(
                f"Unqualified column {column_name} is ambiguous across sources: "
                f"{', '.join(sorted(matching_sources))}"
            )


def validate_sql(sql: str) -> str:
    """
    Validate that generated SQL is a single safe, read-only PostgreSQL query.

    Returns the cleaned SQL if valid.
    Raises ValueError if unsafe.
    """

    if not sql or not sql.strip():
        raise ValueError("SQL cannot be empty")

    sql = sql.strip()

    # ------------------------------------------------------------
    # 1. Quick keyword rejection
    # ------------------------------------------------------------

    upper_sql = sql.upper()

    for keyword in FORBIDDEN_KEYWORDS:
        if re.search(rf"\b{re.escape(keyword)}\b", upper_sql):
            raise ValueError(
                f"Forbidden SQL keyword detected: {keyword}"
            )

    # SELECT ... FOR UPDATE is technically SELECT,
    # but it obtains row locks and should not be allowed.
    if re.search(r"\bFOR\s+UPDATE\b", upper_sql):
        raise ValueError("SELECT FOR UPDATE is not allowed")

    # ------------------------------------------------------------
    # 2. Parse SQL into an AST
    # ------------------------------------------------------------

    try:
        statements = sqlglot.parse(
            sql,
            read="postgres",
        )
    except Exception as exc:
        raise ValueError(
            f"Invalid PostgreSQL syntax: {exc}"
        ) from exc

    # ------------------------------------------------------------
    # 3. Exactly one SQL statement
    # ------------------------------------------------------------

    if len(statements) != 1:
        raise ValueError(
            "Exactly one SQL statement is allowed"
        )

    statement = statements[0]

    # ------------------------------------------------------------
    # 4. Must ultimately be a query
    # ------------------------------------------------------------

    if not isinstance(statement, exp.Query):
        raise ValueError(
            "Only SELECT queries are allowed"
        )

    # ------------------------------------------------------------
    # 5. Reject dangerous AST node types
    # ------------------------------------------------------------

    forbidden_expression_types = (
        exp.Insert,
        exp.Update,
        exp.Delete,
        exp.Create,
        exp.Drop,
        exp.Alter,
        exp.Command,
        exp.Merge,
        exp.Into,
    )

    for node in statement.walk():
        if isinstance(node, forbidden_expression_types):
            raise ValueError(
                f"Forbidden SQL operation detected: "
                f"{type(node).__name__}"
            )

    # Prisma created camelCase PostgreSQL columns as quoted, case-sensitive
    # identifiers. PostgreSQL folds an unquoted reference such as
    # wi.warehouseId to wi.warehouseid, so reject it rather than executing a
    # query that names a different/nonexistent identifier.
    for column in statement.find_all(exp.Column):
        identifier = column.this
        if (
            column.name in PRISMA_CAMEL_CASE_COLUMNS
            and isinstance(identifier, exp.Identifier)
            and not identifier.args.get("quoted")
        ):
            reference = f"{column.table}.{column.name}" if column.table else column.name
            raise IdentifierQuotingError(
                f'Prisma camelCase column {reference} must be double-quoted as "{column.name}"'
            )

    # ------------------------------------------------------------
    # 6. Check every referenced table
    # ------------------------------------------------------------

    cte_names = {
        cte.alias_or_name
        for cte in statement.find_all(exp.CTE)
        if cte.alias_or_name
    }

    for table in statement.find_all(exp.Table):
        table_name = table.name
        schema_name = table.db

        if not schema_name and table_name in cte_names:
            continue

        if schema_name:
            if schema_name.lower() in FORBIDDEN_SCHEMAS:
                raise ValueError(
                    f"System schema is not allowed: {schema_name}"
                )

            # We do not need schema-qualified tables at all.
            raise ValueError(
                "Schema-qualified table references are not allowed"
            )

        if table_name not in ALLOWED_TABLES:
            raise ValueError(
                f"Table is not allowed: {table_name}"
            )

    _validate_schema_columns(statement)

    # ------------------------------------------------------------
    # 7. Block PostgreSQL system-function style access
    # ------------------------------------------------------------

    forbidden_patterns = [
        r"\bpg_catalog\b",
        r"\binformation_schema\b",
        r"\bpg_read_file\s*\(",
        r"\bpg_ls_dir\s*\(",
        r"\bpg_stat_file\s*\(",
        r"\blo_import\s*\(",
        r"\blo_export\s*\(",
        r"\bdblink\s*\(",
        r"\bset_config\s*\(",
        r"\bsetval\s*\(",
        r"\bnextval\s*\(",
        r"\bpg_advisory_lock\s*\(",
        r"\bpg_try_advisory_lock\s*\(",
        r"\bpg_terminate_backend\s*\(",
        r"\bpg_cancel_backend\s*\(",
        r"\bpg_sleep\s*\(",
    ]

    for pattern in forbidden_patterns:
        if re.search(pattern, sql, flags=re.IGNORECASE):
            raise ValueError(
                "Forbidden PostgreSQL system access detected"
            )

    return sql
