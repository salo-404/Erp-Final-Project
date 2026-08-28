import asyncio
import io
import importlib
import inspect
import json
from dataclasses import replace
from pathlib import Path

import pytest

from backend_client import BackendError, ServiceUnavailable
from retrieval import embedding_service, query_example_repository
from sql import read_only_db
from sql.sql_guard import IdentifierQuotingError


settings_module = importlib.import_module("config.settings")
query_database_module = importlib.import_module("tools.query_database")
generate_embeddings_module = importlib.import_module(
    "scripts.generate_query_embeddings"
)


class _FakeAsyncBackendClient:
    """Stands in for backend_client.get_backend_client() - records every
    POST call and returns one canned response, so tests can assert on the
    exact SQL text sent to POST /ai/query-database without any real HTTP
    or database connection.
    """

    def __init__(self, response: dict) -> None:
        self.response = response
        self.calls: list[tuple[str, dict]] = []

    async def post(self, path: str, json: dict | None = None) -> dict:
        self.calls.append((path, json))
        return self.response


def test_final_bedrock_model_map_and_dimensions() -> None:
    assert settings_module._DEFAULT_BEDROCK_MODEL_ID == (
        "mistral.ministral-3-14b-instruct"
    )
    assert settings_module._DEFAULT_BEDROCK_EMBEDDING_MODEL_ID == (
        "amazon.titan-embed-text-v2:0"
    )
    assert settings_module.settings.embedding_dimensions == 512
    assert "claude" not in settings_module._DEFAULT_BEDROCK_MODEL_ID.lower()
    assert "gpt-oss" not in settings_module._DEFAULT_BEDROCK_MODEL_ID.lower()
    assert "nova" not in settings_module._DEFAULT_BEDROCK_MODEL_ID.lower()
    assert not hasattr(settings_module, "_DEFAULT_OPENAI_MODEL_ID")
    assert not hasattr(settings_module, "_DEFAULT_OLLAMA_MODEL_ID")
    assert 'os.getenv("MODEL_PROVIDER", "bedrock")' in inspect.getsource(
        settings_module.Settings
    )

    for role in ("supervisor", "insights", "document", "gate", "narration"):
        assert settings_module._default_model_id_for_provider(
            "bedrock", settings_module._DEFAULT_BEDROCK_MODEL_ID
        ) == "mistral.ministral-3-14b-instruct", role
    assert settings_module._default_model_id_for_provider("openai", "unused") == ""


def test_checked_in_bedrock_runtime_config_has_no_stale_model() -> None:
    project_root = Path(__file__).resolve().parents[1]
    environment = json.loads((project_root / "bedrock-env-vars.json").read_text())
    policy = (project_root / "bedrock-invoke-policy.json").read_text()

    assert environment["SUPERVISOR_MODEL_ID"] == "mistral.ministral-3-14b-instruct"
    assert environment["INSIGHTS_MODEL_ID"] == "mistral.ministral-3-14b-instruct"
    assert environment["DOCUMENT_MODEL_ID"] == "mistral.ministral-3-14b-instruct"
    assert environment["GATE_MODEL_ID"] == "mistral.ministral-3-14b-instruct"
    assert environment["NARRATION_MODEL_ID"] == "mistral.ministral-3-14b-instruct"
    assert environment["BEDROCK_SQL_MODEL_ID"] == "mistral.ministral-3-14b-instruct"
    assert environment["BEDROCK_EMBEDDING_MODEL_ID"] == "amazon.titan-embed-text-v2:0"
    assert environment["EMBEDDING_DIMENSIONS"] == "512"
    assert "gpt-oss" not in policy.lower()
    assert "nova" not in policy.lower()
    assert "anthropic" not in policy.lower()


def test_embedding_dimension_must_match_vector_column() -> None:
    with pytest.raises(ValueError, match="must be exactly 512"):
        replace(settings_module.settings, embedding_dimensions=1024)


class _EmbeddingClient:
    def __init__(self, dimensions: int = 512) -> None:
        self.dimensions = dimensions
        self.request: dict | None = None

    def invoke_model(self, **kwargs):
        self.request = kwargs
        body = json.dumps({"embedding": [0.0] * self.dimensions}).encode()
        return {"body": io.BytesIO(body)}


def test_titan_embedding_call_explicitly_requests_512(monkeypatch) -> None:
    client = _EmbeddingClient()
    monkeypatch.setattr(embedding_service.boto3, "client", lambda *args, **kwargs: client)

    result = embedding_service.embed_text("inventory")

    assert len(result) == 512
    assert client.request["modelId"] == "amazon.titan-embed-text-v2:0"
    assert json.loads(client.request["body"])["dimensions"] == 512


def test_wrong_embedding_size_is_rejected(monkeypatch) -> None:
    client = _EmbeddingClient(dimensions=256)
    monkeypatch.setattr(embedding_service.boto3, "client", lambda *args, **kwargs: client)

    with pytest.raises(ValueError, match="Expected 512 dimensions, got 256"):
        embedding_service.embed_text("inventory")


class _FakeCursor:
    def __init__(self, rows=(), description=None) -> None:
        self.rows = list(rows)
        self.description = description
        self.executions: list[tuple[object, object]] = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params=None) -> None:
        self.executions.append((sql, params))

    def fetchall(self):
        return self.rows

    def fetchmany(self, count):
        return self.rows[:count]


class _FakeConnection:
    def __init__(self, cursor: _FakeCursor) -> None:
        self._cursor = cursor
        self.executions: list[str] = []
        self.committed = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return self._cursor

    def execute(self, sql) -> None:
        self.executions.append(sql)

    def commit(self) -> None:
        self.committed = True


def test_retrieval_is_top_three_non_null_nearest_first(monkeypatch) -> None:
    """find_similar_examples() no longer opens a direct DB connection - it
    POSTs fixed, code-authored SQL (only the embedding vector and limit
    vary) to the real backend's POST /ai/query-database, same as
    execute_query() - see read_only_db.py and this module's own docstring
    for why (the AgentCore Runtime cannot reach RDS directly)."""
    response = {
        "rows": [
            {
                "id": 1,
                "question": "nearest",
                "sqlQuery": "SELECT 1",
                "category": "stock",
                "description": None,
                "similarity": 0.95,
            },
            {
                "id": 2,
                "question": "next",
                "sqlQuery": "SELECT 2",
                "category": "stock",
                "description": None,
                "similarity": 0.80,
            },
        ]
    }
    fake_client = _FakeAsyncBackendClient(response)
    monkeypatch.setattr(
        query_example_repository, "get_backend_client", lambda: fake_client
    )

    examples = asyncio.run(query_example_repository.find_similar_examples([0.1, 0.2]))

    path, body = fake_client.calls[0]
    assert path == "/ai/query-database"
    assert 'WHERE embedding IS NOT NULL' in body["sql"]
    assert 'ORDER BY embedding <=> ' in body["sql"]
    assert body["sql"].rstrip().endswith("LIMIT 3")
    assert [example["question"] for example in examples] == ["nearest", "next"]
    assert [example["similarity"] for example in examples] == [0.95, 0.80]


def test_missing_embedding_write_url_fails_before_connecting(monkeypatch) -> None:
    configured = replace(
        settings_module.settings,
        query_example_write_database_url="",
    )
    monkeypatch.setattr(generate_embeddings_module, "settings", configured)
    monkeypatch.setattr(
        generate_embeddings_module.psycopg,
        "connect",
        lambda *_: pytest.fail("database connection must not be attempted"),
    )

    with pytest.raises(
        RuntimeError,
        match="QUERY_EXAMPLE_WRITE_DATABASE_URL must be configured",
    ):
        generate_embeddings_module.main()


def test_embedding_generation_uses_only_maintenance_write_url(monkeypatch) -> None:
    cursor = _FakeCursor(rows=[(7, "How much stock is available?")])
    connection = _FakeConnection(cursor)
    connected_urls: list[str] = []
    configured = replace(
        settings_module.settings,
        query_example_write_database_url="postgresql://embedding-writer",
    )
    monkeypatch.setattr(generate_embeddings_module, "settings", configured)
    monkeypatch.setattr(
        generate_embeddings_module.psycopg,
        "connect",
        lambda url: connected_urls.append(url) or connection,
    )
    monkeypatch.setattr(
        generate_embeddings_module,
        "embed_text",
        lambda question: [0.0] * 512,
    )

    generate_embeddings_module.main()

    assert connected_urls == ["postgresql://embedding-writer"]
    assert "runtime-readonly" not in connected_urls
    assert 'SELECT id, question' in cursor.executions[0][0]
    assert 'UPDATE "QueryExample"' in cursor.executions[1][0]
    assert cursor.executions[1][1][1] == 7
    assert connection.committed is True


def test_execute_query_posts_already_validated_sql_and_returns_backend_rows(monkeypatch) -> None:
    """The statement-timeout/200-row-cap/read-only enforcement itself now
    lives on the backend (backend/src/ai-query/ai-query.service.ts, and
    its own spec) - the AI-agent side has no database connection left to
    test at all, only that it sends the exact validated SQL and returns
    whatever rows the backend answers with."""
    response = {"rows": [{"id": index} for index in range(5)]}
    fake_client = _FakeAsyncBackendClient(response)
    monkeypatch.setattr(read_only_db, "get_backend_client", lambda: fake_client)

    rows = asyncio.run(read_only_db.execute_query('SELECT "id" FROM "Product"'))

    assert rows == response["rows"]
    assert fake_client.calls == [
        ("/ai/query-database", {"sql": 'SELECT "id" FROM "Product"'})
    ]


def test_execute_query_propagates_a_typed_backend_error(monkeypatch) -> None:
    """A rejection from the backend's own independent read-only guard (or
    any other BackendError) propagates uncaught from execute_query() -
    query_database()'s _RETRYABLE_ERRORS is what decides whether to retry
    it, exactly like a sql_guard rejection (see test_sql_rag_config.py's
    query_database()-level retry tests below)."""
    class _RejectingClient:
        async def post(self, path: str, json: dict | None = None) -> dict:
            raise ServiceUnavailable(0, "Could not reach the backend: ConnectTimeout")

    monkeypatch.setattr(read_only_db, "get_backend_client", lambda: _RejectingClient())

    with pytest.raises(ServiceUnavailable):
        asyncio.run(read_only_db.execute_query('SELECT "id" FROM "Product"'))


def _configure_query_database_dependencies(monkeypatch) -> None:
    monkeypatch.setattr(query_database_module, "embed_text", lambda question: [0.1])

    async def fake_find_similar_examples(embedding, limit):
        return [
            {
                "question": "example",
                "sqlQuery": 'SELECT "id" FROM "Product"',
                "similarity": 0.9,
                "category": "inventory",
            }
        ]

    monkeypatch.setattr(
        query_database_module, "find_similar_examples", fake_find_similar_examples
    )


def test_quoting_error_retries_once_with_exact_feedback(monkeypatch) -> None:
    _configure_query_database_dependencies(monkeypatch)
    generation_calls: list[dict] = []
    validation_calls: list[str] = []

    def generate_sql(**kwargs):
        generation_calls.append(kwargs)
        return "bad sql" if len(generation_calls) == 1 else 'SELECT "id" FROM "Product"'

    def validate_sql(sql):
        validation_calls.append(sql)
        if len(validation_calls) == 1:
            raise IdentifierQuotingError(
                'Prisma camelCase column p.isActive must be double-quoted as "isActive"'
            )
        return sql

    async def execute_query(sql):
        return [{"id": 1}]

    monkeypatch.setattr(query_database_module, "generate_sql", generate_sql)
    monkeypatch.setattr(query_database_module, "validate_sql", validate_sql)
    monkeypatch.setattr(query_database_module, "execute_query", execute_query)

    result = asyncio.run(query_database_module.query_database("show products"))

    assert len(generation_calls) == 2
    assert generation_calls[1]["validation_feedback"] == (
        'Prisma camelCase column p.isActive must be double-quoted as "isActive"'
    )
    assert validation_calls == ["bad sql", 'SELECT "id" FROM "Product"']
    assert result["rows"] == [{"id": 1}]


def test_unsafe_sql_is_not_retried_or_executed(monkeypatch) -> None:
    _configure_query_database_dependencies(monkeypatch)
    generation_calls: list[dict] = []
    monkeypatch.setattr(
        query_database_module,
        "generate_sql",
        lambda **kwargs: generation_calls.append(kwargs) or 'DELETE FROM "Product"',
    )
    monkeypatch.setattr(
        query_database_module,
        "validate_sql",
        lambda sql: (_ for _ in ()).throw(ValueError("Forbidden SQL keyword detected: DELETE")),
    )

    async def execute_query(sql):
        pytest.fail("unsafe SQL must never execute")

    monkeypatch.setattr(query_database_module, "execute_query", execute_query)

    with pytest.raises(ValueError, match="Forbidden SQL keyword"):
        asyncio.run(query_database_module.query_database("delete products"))

    assert len(generation_calls) == 1


def test_execution_error_retries_once_with_exact_feedback(monkeypatch) -> None:
    """A real execution failure the backend surfaces (e.g. a GROUP BY
    violation sql_guard's static AST check can't predict - reproduced live
    against real data, not hypothetical - now arriving as a BackendError
    from POST /ai/query-database rather than a raw psycopg error) gets
    exactly one regenerate-and-retry, same as a fixable sql_guard rejection
    above - not left unretried."""
    _configure_query_database_dependencies(monkeypatch)
    generation_calls: list[dict] = []
    execution_calls: list[str] = []

    def generate_sql(**kwargs):
        generation_calls.append(kwargs)
        return 'SELECT it.id FROM "InventoryTransaction" it'

    async def execute_query(sql):
        execution_calls.append(sql)
        if len(execution_calls) == 1:
            raise BackendError(
                400,
                'column "it.id" must appear in the GROUP BY clause or be used in an aggregate function',
            )
        return [{"id": 86}]

    monkeypatch.setattr(query_database_module, "generate_sql", generate_sql)
    monkeypatch.setattr(query_database_module, "validate_sql", lambda sql: sql)
    monkeypatch.setattr(query_database_module, "execute_query", execute_query)

    result = asyncio.run(query_database_module.query_database("last completed order"))

    assert len(generation_calls) == 2
    assert generation_calls[1]["validation_feedback"] == (
        'Backend error 400: column "it.id" must appear in the GROUP BY '
        "clause or be used in an aggregate function"
    )
    assert len(execution_calls) == 2
    assert result["rows"] == [{"id": 86}]


def test_execution_error_not_retried_twice(monkeypatch) -> None:
    """A second consecutive execution failure propagates uncaught rather
    than retrying again - same "at most one retry" bound as every other
    retryable error."""
    _configure_query_database_dependencies(monkeypatch)
    monkeypatch.setattr(
        query_database_module, "generate_sql", lambda **kwargs: 'SELECT it.id FROM "InventoryTransaction" it'
    )
    monkeypatch.setattr(query_database_module, "validate_sql", lambda sql: sql)

    async def always_fails(sql):
        raise BackendError(400, "still broken")

    monkeypatch.setattr(query_database_module, "execute_query", always_fails)

    with pytest.raises(BackendError, match="still broken"):
        asyncio.run(query_database_module.query_database("last completed order"))
