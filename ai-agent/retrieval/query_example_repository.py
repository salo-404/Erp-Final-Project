import psycopg

from config.settings import settings


DATABASE_URL = settings.ai_database_url


def vector_to_pgvector(embedding: list[float]) -> str:
    return "[" + ",".join(str(value) for value in embedding) + "]"


def find_similar_examples(
    embedding: list[float],
    limit: int = 5,
) -> list[dict]:
    vector = vector_to_pgvector(embedding)

    with psycopg.connect(DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                    id,
                    question,
                    "sqlQuery",
                    category,
                    description,
                    1 - (embedding <=> %s::vector) AS similarity
                FROM "QueryExample"
                WHERE embedding IS NOT NULL
                ORDER BY embedding <=> %s::vector
                LIMIT %s;
                """,
                (vector, vector, limit),
            )

            rows = cur.fetchall()

    return [
        {
            "id": row[0],
            "question": row[1],
            "sqlQuery": row[2],
            "category": row[3],
            "description": row[4],
            "similarity": float(row[5]),
        }
        for row in rows
    ]
