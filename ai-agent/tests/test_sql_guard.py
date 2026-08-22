import re

import pytest

from sql.sql_guard import validate_sql


def test_normal_select_on_allowed_table_passes() -> None:
    sql = 'SELECT "id", "name" FROM "Product"'

    assert validate_sql(sql) == sql


def test_cte_over_allowed_table_and_cte_alias_passes() -> None:
    sql = (
        'WITH active_products AS ('
        'SELECT "id", "name" FROM "Product" WHERE "isActive" = TRUE'
        ') SELECT * FROM active_products'
    )

    assert validate_sql(sql) == sql


@pytest.mark.parametrize(
    ("column", "alias", "table"),
    [
        ("warehouseId", "wi", "WarehouseInventory"),
        ("isActive", "p", "Product"),
        ("leadTimeDays", "s", "Supplier"),
    ],
)
def test_unquoted_prisma_camel_case_column_is_rejected(
    column: str,
    alias: str,
    table: str,
) -> None:
    sql = f'SELECT {alias}.{column} FROM "{table}" {alias}'

    with pytest.raises(ValueError, match=rf'{alias}\.{column} must be double-quoted'):
        validate_sql(sql)


@pytest.mark.parametrize(
    ("column", "alias", "table"),
    [
        ("warehouseId", "wi", "WarehouseInventory"),
        ("isActive", "p", "Product"),
        ("leadTimeDays", "s", "Supplier"),
    ],
)
def test_quoted_prisma_camel_case_column_is_accepted(
    column: str,
    alias: str,
    table: str,
) -> None:
    sql = f'SELECT {alias}."{column}" FROM "{table}" {alias}'

    assert validate_sql(sql) == sql


@pytest.mark.parametrize(
    ("sql", "invalid_reference"),
    [
        ('SELECT wi.warehouse_id FROM "WarehouseInventory" AS wi', "wi.warehouse_id"),
        ('SELECT p.product_name FROM "Product" AS p', "p.product_name"),
        ('SELECT s.lead_time_days FROM "Supplier" AS s', "s.lead_time_days"),
    ],
)
def test_invented_physical_columns_are_rejected_before_execution(
    sql: str,
    invalid_reference: str,
) -> None:
    with pytest.raises(ValueError, match=rf"Column {re.escape(invalid_reference)} does not exist"):
        validate_sql(sql)


def test_ordinary_lowercase_sql_aliases_remain_valid() -> None:
    sql = 'SELECT p."name" AS product_name FROM "Product" AS p ORDER BY product_name'

    assert validate_sql(sql) == sql


def test_cte_alias_remains_valid_with_quoted_columns() -> None:
    sql = (
        'WITH active_products AS ('
        'SELECT p."id", p."isActive" FROM "Product" AS p'
        ') SELECT * FROM active_products'
    )

    assert validate_sql(sql) == sql


def test_valid_cte_output_column_remains_accepted() -> None:
    sql = (
        'WITH product_names AS ('
        'SELECT p."name" AS product_name FROM "Product" AS p'
        ') SELECT product_name FROM product_names'
    )

    assert validate_sql(sql) == sql


def test_aggregate_alias_remains_accepted() -> None:
    sql = 'SELECT COUNT(*) AS product_count FROM "Product" ORDER BY product_count'

    assert validate_sql(sql) == sql


def test_cte_containing_disallowed_real_table_fails() -> None:
    sql = 'WITH hidden AS (SELECT * FROM "User") SELECT * FROM hidden'

    with pytest.raises(ValueError, match="Table is not allowed: User"):
        validate_sql(sql)


def test_query_example_remains_forbidden() -> None:
    with pytest.raises(ValueError, match="Table is not allowed: QueryExample"):
        validate_sql('SELECT * FROM "QueryExample"')


def test_schema_qualified_table_remains_forbidden() -> None:
    with pytest.raises(ValueError, match="Schema-qualified table references are not allowed"):
        validate_sql('SELECT * FROM public."Product"')


def test_select_for_update_remains_forbidden() -> None:
    with pytest.raises(ValueError):
        validate_sql('SELECT * FROM "Product" FOR UPDATE')


@pytest.mark.parametrize("function_call", ["pg_sleep(1)", "set_config('x', 'y', false)", "nextval('seq')"])
def test_select_side_effect_functions_are_blocked(function_call: str) -> None:
    with pytest.raises(ValueError, match="Forbidden PostgreSQL system access detected"):
        validate_sql(f"SELECT {function_call}")


@pytest.mark.parametrize(
    "sql",
    [
        'INSERT INTO "Product" ("name") VALUES (\'unsafe\')',
        'UPDATE "Product" SET "name" = \'unsafe\'',
        'DELETE FROM "Product"',
        'DROP TABLE "Product"',
    ],
)
def test_write_statements_remain_blocked(sql: str) -> None:
    with pytest.raises(ValueError):
        validate_sql(sql)
