import psycopg

from config.settings import settings
from retrieval.embedding_service import embed_text


def vector_to_pgvector(embedding: list[float]) -> str:
    return "[" + ",".join(str(value) for value in embedding) + "]"


def main() -> None:
    print("Loading QueryExample rows...")

    database_url = settings.require_query_example_write_database_url()

    with psycopg.connect(database_url) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, question
                FROM "QueryExample"
                ORDER BY id;
                """
            )

            examples = cur.fetchall()

            print(f"Found {len(examples)} query examples.")

            for index, (example_id, question) in enumerate(examples, start=1):
                print(
                    f"[{index}/{len(examples)}] "
                    f"Embedding QueryExample {example_id}: {question}"
                )

                embedding = embed_text(question)
                vector = vector_to_pgvector(embedding)

                cur.execute(
                    """
                    UPDATE "QueryExample"
                    SET embedding = %s::vector
                    WHERE id = %s;
                    """,
                    (vector, example_id),
                )

            conn.commit()

    print("All query embeddings generated and stored.")


if __name__ == "__main__":
    main()
