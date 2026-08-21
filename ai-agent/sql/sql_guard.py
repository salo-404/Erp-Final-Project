import re

import sqlglot
from sqlglot import exp

from sql.database_context import ALLOWED_TABLES


FORBIDDEN_KEYWORDS = {
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "COPY",
    "GRANT",
    "REVOKE",
    "CALL",
    "DO",
    "VACUUM",
    "ANALYZE",
    "REFRESH",
}


FORBIDDEN_SCHEMAS = {
    "pg_catalog",
    "information_schema",
}


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
    )

    for node in statement.walk():
        if isinstance(node, forbidden_expression_types):
            raise ValueError(
                f"Forbidden SQL operation detected: "
                f"{type(node).__name__}"
            )

    # ------------------------------------------------------------
    # 6. Check every referenced table
    # ------------------------------------------------------------

    for table in statement.find_all(exp.Table):
        table_name = table.name
        schema_name = table.db

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
    ]

    for pattern in forbidden_patterns:
        if re.search(pattern, sql, flags=re.IGNORECASE):
            raise ValueError(
                "Forbidden PostgreSQL system access detected"
            )

    return sql