import json
import os

import boto3
import psycopg


DATABASE_URL = os.getenv(
    "AI_DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5433/mini_erp_vector",
)

AWS_REGION = os.getenv("AWS_REGION", "eu-west-1")
MODEL_ID = "amazon.titan-embed-text-v2:0"
EMBEDDING_DIMENSIONS = 512


def create_embedding(text: str) -> list[float]:
    bedrock = boto3.client(
        "bedrock-runtime",
        region_name=AWS_REGION,
    )

    response = bedrock.invoke_model(
        modelId=MODEL_ID,
        body=json.dumps(
            {
                "inputText": text,
                "dimensions": EMBEDDING_DIMENSIONS,
                "normalize": True,
            }
        ),
    )

    result = json.loads(response["body"].read())
    embedding = result["embedding"]

    if len(embedding) != EMBEDDING_DIMENSIONS:
        raise ValueError(
            f"Expected {EMBEDDING_DIMENSIONS} dimensions, "
            f"got {len(embedding)}"
        )

    return embedding


def vector_to_pgvector(embedding: list[float]) -> str:
    return "[" + ",".join(str(value) for value in embedding) + "]"


def main():
    print("Loading QueryExample rows...")

    with psycopg.connect(DATABASE_URL) as conn:
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

                embedding = create_embedding(question)
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

    print("✅ All query embeddings generated and stored.")


if __name__ == "__main__":
    main()