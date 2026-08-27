from strands import tool

from backend_client import BackendError
from retrieval.embedding_service import embed_text
from retrieval.query_example_repository import TOP_K, find_similar_examples
from sql.sql_generator import generate_sql
from sql.sql_guard import IdentifierQuotingError, SchemaValidationError, validate_sql
from sql.read_only_db import execute_query

# Errors worth exactly one regenerate-and-retry attempt: either sql_guard
# rejected the SQL for a fixable reason (an unquoted Prisma identifier, a
# column/table its static AST check disproved), or the real ERP backend's
# POST /ai/query-database rejected/failed it at execution time - a real
# PostgreSQL error (e.g. a GROUP BY violation - confirmed to happen on
# live data, not hypothetical) the backend surfaced as a BackendError, or
# the backend's own independent read-only guard catching something
# sql_guard's static checks couldn't have caught. Never retried more than
# once - see query_database()'s own docstring below.
_RETRYABLE_ERRORS = (IdentifierQuotingError, SchemaValidationError, BackendError)


async def _generate_validate_execute(
    question: str,
    examples: list[dict],
    validation_feedback: str | None = None,
) -> tuple[str, list[dict]]:
    generated_sql = generate_sql(
        question=question,
        examples=examples,
        validation_feedback=validation_feedback,
    )
    safe_sql = validate_sql(generated_sql)
    rows = await execute_query(safe_sql)
    return safe_sql, rows


@tool
async def query_database(question: str) -> dict:
    """
    Answer a flexible ERP database question using:
    1. Titan embeddings
    2. pgvector example retrieval
    3. Bedrock SQL generation
    4. SQL safety validation
    5. read-only execution via the real ERP backend (POST
       /ai/query-database - see sql/read_only_db.py's own docstring for
       why this is no longer a direct psycopg connection)

    Generation, validation, and execution are retried together, exactly
    once, if the first attempt fails for a retryable reason (a fixable
    sql_guard rejection, or a real execution error sql_guard's static
    checks couldn't have caught - either from PostgreSQL itself or from
    the backend's own independent read-only enforcement) - see
    _RETRYABLE_ERRORS. A second failure propagates uncaught rather than
    retrying again.
    """

    if not question or not question.strip():
        raise ValueError("Question cannot be empty")

    # 1. Convert the user's question into a 512-d embedding.
    embedding = embed_text(question)

    # 2. Retrieve the 3 closest verified question -> SQL examples.
    examples = await find_similar_examples(
        embedding,
        limit=TOP_K,
    )

    if not examples:
        raise RuntimeError(
            "No similar SQL examples were found"
        )

    # 3-5. Generate, validate, and execute - retried once as a unit on a
    # retryable failure, feeding the real error back to the model.
    try:
        safe_sql, rows = await _generate_validate_execute(question, examples)
    except _RETRYABLE_ERRORS as exc:
        safe_sql, rows = await _generate_validate_execute(
            question, examples, validation_feedback=str(exc)
        )

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
