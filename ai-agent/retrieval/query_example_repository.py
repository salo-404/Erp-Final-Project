from backend_client import get_backend_client

TOP_K = 3


def vector_to_pgvector(embedding: list[float]) -> str:
    return "[" + ",".join(str(value) for value in embedding) + "]"


async def find_similar_examples(
    embedding: list[float],
    limit: int = TOP_K,
) -> list[dict]:
    """Retrieve the closest verified question -> SQL examples via pgvector.

    Not LLM-generated SQL, so sql_guard.py was never applicable to it (that
    guard validates against the ERP schema's ALLOWED_TABLES, which
    deliberately excludes "QueryExample" - see this module's README
    section). This fixed, code-authored query only ever varies by the
    embedding vector (built purely from floats via vector_to_pgvector -
    never free text, so there is no injection surface in inlining it) and
    an integer limit.

    Like execute_query() in sql/read_only_db.py, this can no longer open a
    direct psycopg connection to RDS from the AgentCore Runtime (not
    VPC-attached - see read_only_db.py's own docstring for why), so it
    POSTs the query text to the same POST /ai/query-database backend
    endpoint, authenticated as the AI service identity.
    """
    # The 512-dim vector literal is ~10-11K characters on its own - built as
    # a WITH clause and referenced twice by name, rather than inlined twice
    # directly, so the request body doesn't nearly double in size for no
    # reason (and comfortably clears the backend's MaxLength(sql) cap).
    vector = vector_to_pgvector(embedding)
    sql = (
        f"WITH q AS (SELECT '{vector}'::vector AS v) "
        'SELECT id, question, "sqlQuery", category, description, '
        "1 - (embedding <=> q.v) AS similarity "
        'FROM "QueryExample", q '
        "WHERE embedding IS NOT NULL "
        "ORDER BY embedding <=> q.v "
        f"LIMIT {int(limit)}"
    )

    client = get_backend_client()
    response = await client.post("/ai/query-database", json={"sql": sql})

    return [
        {
            "id": row["id"],
            "question": row["question"],
            "sqlQuery": row["sqlQuery"],
            "category": row["category"],
            "description": row["description"],
            "similarity": float(row["similarity"]),
        }
        for row in response["rows"]
    ]
