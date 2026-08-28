from backend_client import get_backend_client


async def execute_query(sql: str) -> list[dict]:
    """
    Execute already-validated read-only SQL and return rows as dictionaries.

    IMPORTANT:
    This function assumes sql_guard.validate_sql() was called first.

    The AgentCore Runtime cannot reach RDS directly (it is not VPC-attached
    - RDS is private-only, and VPC-attaching the runtime would cut off its
    own access to Bedrock/Cognito unless a NAT Gateway or per-service VPC
    endpoints were also added, a real cost/complexity tradeoff that was
    deliberately avoided). Instead, this POSTs the already-validated SQL to
    POST /ai/query-database on the real ERP backend, which already runs
    inside the VPC with a working DATABASE_URL. The backend independently
    re-enforces read-only/single-statement/row-cap/timeout - see
    backend/src/ai-query/ai-query.service.ts's own docstring - it never
    trusts that sql_guard.py already validated the text.

    Authenticates as the AI service Cognito identity (get_backend_client()
    - the same shared, cached-token client every other tool uses), not a
    per-user token - no database credential of any kind is ever available
    to this process.
    """
    client = get_backend_client()
    response = await client.post("/ai/query-database", json={"sql": sql})
    return response["rows"]
