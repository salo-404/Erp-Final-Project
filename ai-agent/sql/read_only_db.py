import psycopg

from config.settings import settings


DATABASE_URL = settings.ai_database_url

STATEMENT_TIMEOUT_MS = 3000
MAX_ROWS = 200


def execute_query(sql: str) -> list[dict]:
    """
    Execute already-validated read-only SQL and return rows as dictionaries.

    IMPORTANT:
    This function assumes sql_guard.validate_sql() was called first.
    """

    database_url = settings.require_ai_database_url()

    with psycopg.connect(database_url) as conn:
        conn.execute("SET TRANSACTION READ ONLY")
        conn.execute(
            f"SET LOCAL statement_timeout = {STATEMENT_TIMEOUT_MS}"
        )

        with conn.cursor() as cur:
            cur.execute(sql)

            if cur.description is None:
                return []

            columns = [column.name for column in cur.description]

            rows = cur.fetchmany(MAX_ROWS + 1)

            if len(rows) > MAX_ROWS:
                raise ValueError(
                    f"Query returned more than {MAX_ROWS} rows"
                )

            return [
                dict(zip(columns, row))
                for row in rows
            ]
