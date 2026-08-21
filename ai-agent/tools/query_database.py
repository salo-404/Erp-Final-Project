from strands import tool

from retrieval.embedding_service import embed_text
from retrieval.query_example_repository import find_similar_examples
from sql.sql_generator import generate_sql
from sql.sql_guard import validate_sql
from sql.read_only_db import execute_query


@tool
def query_database(question: str) -> dict:
    """
    Answer a flexible ERP database question using:
    1. Titan embeddings
    2. pgvector example retrieval
    3. Nova SQL generation
    4. SQL safety validation
    5. read-only PostgreSQL execution
    """

    if not question or not question.strip():
        raise ValueError("Question cannot be empty")

    # 1. Convert the user's question into a 512-d embedding.
    embedding = embed_text(question)

    # 2. Retrieve the 3 closest verified question -> SQL examples.
    examples = find_similar_examples(
        embedding,
        limit=3,
    )

    if not examples:
        raise RuntimeError(
            "No similar SQL examples were found"
        )

    # 3. Ask Nova to generate SQL using:
    #    - schema
    #    - business rules
    #    - retrieved examples
    #    - user's question
    generated_sql = generate_sql(
        question=question,
        examples=examples,
    )

    # 4. Programmatically reject unsafe SQL.
    safe_sql = validate_sql(generated_sql)

    # 5. Execute only the validated SQL.
    rows = execute_query(safe_sql)

    return {
        "question": question,
        "sql": safe_sql,
        "rows": rows,
        "retrievedExamples": [
            {
                "question": example["question"],
                "similarity": example["similarity"],
                "category": example["category"],
            }
            for example in examples
        ],
    }
