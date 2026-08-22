import boto3

from config.settings import settings
from sql.database_context import DATABASE_SCHEMA, BUSINESS_RULES


AWS_REGION = settings.aws_region
MODEL_ID = settings.bedrock_sql_model_id


def format_examples(examples: list[dict]) -> str:
    sections = []

    for index, example in enumerate(examples, start=1):
        sections.append(
            f"""
EXAMPLE {index}

Similarity:
{example["similarity"]:.4f}

Question:
{example["question"]}

Description:
{example.get("description") or "None"}

SQL:
{example["sqlQuery"]}
""".strip()
        )

    return "\n\n".join(sections)


def clean_sql(text: str) -> str:
    """
    Remove accidental Markdown fences if the model returns them.

    This does NOT validate SQL safety.
    sql_guard.py will do that separately.
    """
    text = text.strip()

    if text.startswith("```sql"):
        text = text[6:]
    elif text.startswith("```"):
        text = text[3:]

    if text.endswith("```"):
        text = text[:-3]

    return text.strip()


def generate_sql(
    question: str,
    examples: list[dict],
    validation_feedback: str | None = None,
) -> str:
    """
    Generate one read-only PostgreSQL query for the user's question.

    The caller is responsible for:
    1. retrieving relevant QueryExamples
    2. validating the generated SQL with sql_guard.py
    3. executing it using the read-only DB connection
    """

    if not question.strip():
        raise ValueError("Question cannot be empty")

    if not examples:
        raise ValueError("At least one retrieved SQL example is required")

    if not MODEL_ID:
        raise RuntimeError(
            "BEDROCK_SQL_MODEL_ID must be configured for SQL generation"
        )

    example_text = format_examples(examples)
    retry_feedback = ""
    if validation_feedback:
        retry_feedback = f"""

VALIDATION FAILURE FROM THE PREVIOUS ATTEMPT
--------------------------------------------
{validation_feedback}

Correct that exact problem in the regenerated SQL.
"""

    prompt = f"""
You generate PostgreSQL queries for an inventory ERP system.

Your task is to convert the user's question into exactly ONE read-only SQL query.

DATABASE SCHEMA
---------------
{DATABASE_SCHEMA}

BUSINESS RULES
--------------
{BUSINESS_RULES}

RELEVANT VERIFIED EXAMPLES
--------------------------
{example_text}

USER QUESTION
-------------
{question}
{retry_feedback}

STRICT OUTPUT RULES
-------------------
1. Return ONLY the SQL query.
2. Do not explain the query.
3. Do not use Markdown.
4. Do not use ```sql fences.
5. Generate exactly ONE statement.
6. The statement must be read-only.
7. It must be a SELECT query, or a WITH/CTE query whose final operation is SELECT.
8. Never generate INSERT, UPDATE, DELETE, MERGE, CREATE, ALTER, DROP,
   TRUNCATE, COPY, GRANT, REVOKE, CALL, DO, or other write operations.
9. Only use tables and columns explicitly listed in DATABASE_SCHEMA.
10. Do not query system schemas.
11. Do not invent Customer, PurchaseOrder, Batch, Expiry, or other nonexistent tables.
12. Follow the ERP business rules exactly.
13. Use PostgreSQL syntax.
14. Prefer explicit JOIN conditions.
15. Handle nullable values appropriately.
16. Do not use SELECT FOR UPDATE.
17. Do not include multiple SQL statements.
18. If returning potentially many detail rows, include a reasonable LIMIT.
19. Do not modify the database under any circumstance.
20. Every database table name from DATABASE_SCHEMA MUST be double-quoted exactly
    as written, for example "Product", "Warehouse", "InventoryTransaction",
    "InventoryTransactionItem", "WarehouseInventory", "StockMovement", and
    "Reservation".

21. Every camelCase column name MUST be double-quoted exactly as written,
    for example "productId", "warehouseId", "sourceWarehouseId",
    "destinationWarehouseId", "expectedDate", "actualDate", "partyName",
    "onHand", and "isActive".

22. Never write Prisma table names as unquoted PostgreSQL identifiers.

The examples are ordered from most semantically similar to least similar.
Use higher-similarity examples as stronger guidance, but always follow the
database schema and business rules over any example.

PostgreSQL identifiers in this schema are case-sensitive because Prisma created
quoted PascalCase table names and camelCase columns. Preserve their exact
spelling and double quotes.

Return only the SQL.
""".strip()

    client = boto3.client(
        "bedrock-runtime",
        region_name=AWS_REGION,
    )

    response = client.converse(
        modelId=MODEL_ID,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "text": prompt,
                    }
                ],
            }
        ],
        inferenceConfig={
            "temperature": 0,
            "maxTokens": 1200,
        },
    )

    content = response["output"]["message"]["content"]

    if not content:
        raise RuntimeError("SQL model returned an empty response")

    text_parts = [
        item["text"]
        for item in content
        if "text" in item
    ]

    if not text_parts:
        raise RuntimeError("SQL model did not return SQL text")

    generated = "\n".join(text_parts)

    return clean_sql(generated)
