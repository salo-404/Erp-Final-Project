import io
import importlib
import inspect
import json
from dataclasses import replace
from pathlib import Path

import pytest

from retrieval import embedding_service, query_example_repository
from sql import read_only_db
from sql.sql_guard import IdentifierQuotingError


settings_module = importlib.import_module("config.settings")
query_database_module = importlib.import_module("tools.query_database")
generate_embeddings_module = importlib.import_module(
    "scripts.generate_query_embeddings"
)


def test_final_bedrock_model_map_and_dimensions() -> None:
    assert settings_module._DEFAULT_BEDROCK_SUPERVISOR_MODEL_ID == (
        "openai.gpt-oss-120b-1:0"
    )
    assert settings_module._DEFAULT_BEDROCK_AGENT_MODEL_ID == (
        "openai.gpt-oss-20b-1:0"
    )
    assert settings_module._DEFAULT_BEDROCK_SQL_MODEL_ID == (
        "mistral.ministral-3-8b-instruct"
    )
    assert settings_module._DEFAULT_BEDROCK_EMBEDDING_MODEL_ID == (
        "amazon.titan-embed-text-v2:0"
    )
    assert settings_module.settings.embedding_dimensions == 512
    assert "claude" not in settings_module._DEFAULT_BEDROCK_AGENT_MODEL_ID.lower()
    assert "claude" not in settings_module._DEFAULT_BEDROCK_SUPERVISOR_MODEL_ID.lower()
    assert not hasattr(settings_module, "_DEFAULT_OPENAI_MODEL_ID")
    assert not hasattr(settings_module, "_DEFAULT_OLLAMA_MODEL_ID")
    assert 'os.getenv("MODEL_PROVIDER", "bedrock")' in inspect.getsource(
        settings_module.Settings
    )

    assert settings_module._default_model_id_for_provider(
        "bedrock", settings_module._DEFAULT_BEDROCK_SUPERVISOR_MODEL_ID
    ) == "openai.gpt-oss-120b-1:0"
    for role in ("insights", "document", "gate", "narration"):
        assert settings_module._default_model_id_for_provider(
            "bedrock", settings_module._DEFAULT_BEDROCK_AGENT_MODEL_ID
        ) == "openai.gpt-oss-20b-1:0", role
    assert settings_module._default_model_id_for_provider("openai", "unused") == ""
    assert settings_module._default_model_id_for_provider("ollama", "unused") == ""


def test_checked_in_bedrock_runtime_config_has_no_stale_model() -> None:
    project_root = Path(__file__).resolve().parents[1]
    environment = json.loads((project_root / "bedrock-env-vars.json").read_text())
    policy = (project_root / "bedrock-invoke-policy.json").read_text()

    assert environment["SUPERVISOR_MODEL_ID"] == "openai.gpt-oss-120b-1:0"
    assert environment["INSIGHTS_MODEL_ID"] == "openai.gpt-oss-20b-1:0"
    assert environment["DOCUMENT_MODEL_ID"] == "openai.gpt-oss-20b-1:0"
    assert environment["GATE_MODEL_ID"] == "openai.gpt-oss-20b-1:0"
    assert environment["NARRATION_MODEL_ID"] == "openai.gpt-oss-20b-1:0"
    assert environment["BEDROCK_SQL_MODEL_ID"] == "mistral.ministral-3-8b-instruct"
    assert environment["BEDROCK_EMBEDDING_MODEL_ID"] == "amazon.titan-embed-text-v2:0"
    assert environment["EMBEDDING_DIMENSIONS"] == "512"
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
    rows = [
        (1, "nearest", "SELECT 1", "stock", None, 0.95),
        (2, "next", "SELECT 2", "stock", None, 0.80),
    ]
    cursor = _FakeCursor(rows)
    connection = _FakeConnection(cursor)
    connected_urls: list[str] = []
    configured = replace(
        settings_module.settings,
        ai_database_url="postgresql://runtime-readonly",
        query_example_write_database_url="postgresql://embedding-writer",
    )
    monkeypatch.setattr(query_example_repository, "settings", configured)
    monkeypatch.setattr(
        query_example_repository.psycopg,
        "connect",
        lambda url: connected_urls.append(url) or connection,
    )

    examples = query_example_repository.find_similar_examples([0.1, 0.2])

    sql, params = cursor.executions[0]
    assert 'WHERE embedding IS NOT NULL' in sql
    assert 'ORDER BY embedding <=> %s::vector' in sql
    assert params[2] == 3
    assert [example["question"] for example in examples] == ["nearest", "next"]
    assert connected_urls == ["postgresql://runtime-readonly"]


@pytest.mark.parametrize("module", [query_example_repository, read_only_db])
def test_missing_ai_database_url_fails_closed(monkeypatch, module) -> None:
    configured = replace(
        settings_module.settings,
        ai_database_url="",
        query_example_write_database_url="postgresql://embedding-writer",
    )
    monkeypatch.setattr(module, "settings", configured)
    monkeypatch.setattr(
        module.psycopg,
        "connect",
        lambda *_: pytest.fail("database connection must not be attempted"),
    )

    with pytest.raises(RuntimeError, match="AI_DATABASE_URL must be configured"):
        if module is query_example_repository:
            module.find_similar_examples([0.1])
        else:
            module.execute_query('SELECT "id" FROM "Product"')


def test_missing_embedding_write_url_fails_before_connecting(monkeypatch) -> None:
    configured = replace(
        settings_module.settings,
        ai_database_url="postgresql://runtime-readonly",
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
        ai_database_url="postgresql://runtime-readonly",
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


def test_read_only_timeout_and_200_row_cap(monkeypatch) -> None:
    description = [type("Column", (), {"name": "id"})()]
    cursor = _FakeCursor(rows=[(index,) for index in range(201)], description=description)
    connection = _FakeConnection(cursor)
    configured = replace(settings_module.settings, ai_database_url="postgresql://readonly")
    monkeypatch.setattr(read_only_db, "settings", configured)
    monkeypatch.setattr(read_only_db.psycopg, "connect", lambda url: connection)

    with pytest.raises(ValueError, match="more than 200 rows"):
        read_only_db.execute_query('SELECT "id" FROM "Product"')

    assert connection.executions == [
        "SET TRANSACTION READ ONLY",
        "SET LOCAL statement_timeout = 3000",
    ]
    assert cursor.executions[0][0] == 'SELECT "id" FROM "Product"'


def _configure_query_database_dependencies(monkeypatch) -> None:
    monkeypatch.setattr(query_database_module, "embed_text", lambda question: [0.1])
    monkeypatch.setattr(
        query_database_module,
        "find_similar_examples",
        lambda embedding, limit: [
            {
                "question": "example",
                "sqlQuery": 'SELECT "id" FROM "Product"',
                "similarity": 0.9,
                "category": "inventory",
            }
        ],
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

    monkeypatch.setattr(query_database_module, "generate_sql", generate_sql)
    monkeypatch.setattr(query_database_module, "validate_sql", validate_sql)
    monkeypatch.setattr(
        query_database_module, "execute_query", lambda sql: [{"id": 1}]
    )

    result = query_database_module.query_database("show products")

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
    monkeypatch.setattr(
        query_database_module,
        "execute_query",
        lambda sql: pytest.fail("unsafe SQL must never execute"),
    )

    with pytest.raises(ValueError, match="Forbidden SQL keyword"):
        query_database_module.query_database("delete products")

    assert len(generation_calls) == 1
