"""Central configuration for the multi-agent system.

Everything here is pulled from environment variables (via python-dotenv for
local development) so that no AWS credentials, OpenAI keys, or other
account-specific values are hardcoded. Real credential resolution (AWS via
boto3's default credential chain, OpenAI via OPENAI_API_KEY, Ollama via a
local/remote host URL) is left to the respective SDKs - we never read or
store a secret key directly beyond passing it through from the environment.

Provider switching
-------------------
MODEL_PROVIDER selects which model backend build_model() constructs:

  - "openai"  (current default) - for local development without AWS access.
    Uses OPENAI_API_KEY + per-agent *_MODEL_ID settings (defaulting to
    "gpt-5.4-mini").
  - "ollama"  - for fully offline/local development against a local Ollama
    server. Uses OLLAMA_HOST + per-agent *_MODEL_ID settings (defaulting to
    "llama3.1").
  - "bedrock" - the target production provider. Uses the existing
    aws_region / bedrock_model_id / per-agent *_MODEL_ID settings, resolved
    via boto3's default credential chain.

build_model() is the single place that decides which provider to
instantiate - agents never construct a Model directly, so switching
providers is a config-only change. See README.md "Switching providers".

SUPERVISOR_MODEL_ID / build_model("supervisor") is the Supervisor's MAIN
routing/response model - the one that reads a user query, decides which
specialist tool(s) to call, and composes the final answer. GATE_MODEL_ID /
build_model("gate") is a SEPARATE, smaller/cheaper model used only for the
scope pre-check in agents/supervisor/gate.py - a single fast classification
call made before the query ever reaches the Supervisor's main model or any
specialist tool. NARRATION_MODEL_ID / build_model("narration") is yet
another separate model, used only by narration/control_tower.py's batch
alert narration - a plain, non-tool-calling completion call, not part of
the agents/ package at all (Control Tower is explicitly not a fourth
agent). Bedrock Guardrails (agents/supervisor/guardrails.py) remains a
stub - deferred until AWS access returns, not implemented here.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from dotenv import load_dotenv

if TYPE_CHECKING:
    from strands.models.model import Model

# Loaded at import time so every setting below sees .env values immediately.
load_dotenv()

ModelProvider = Literal["openai", "ollama", "bedrock"]
AgentName = Literal["insights", "document", "supervisor", "gate", "narration"]

# Per-provider default model IDs for local dev (used only when the
# corresponding *_MODEL_ID env var is unset - an explicit env var always
# wins, for any provider).
_DEFAULT_OPENAI_MODEL_ID = "gpt-5.4-mini"
_DEFAULT_OLLAMA_MODEL_ID = "llama3.1"
_DEFAULT_BEDROCK_SUPERVISOR_MODEL_ID = "openai.gpt-oss-120b-1:0"
_DEFAULT_BEDROCK_AGENT_MODEL_ID = "openai.gpt-oss-20b-1:0"
_DEFAULT_BEDROCK_SQL_MODEL_ID = "mistral.ministral-3-8b-instruct"
_DEFAULT_BEDROCK_EMBEDDING_MODEL_ID = "amazon.titan-embed-text-v2:0"


def _environment_flag(name: str, default: bool = False) -> bool:
    """Parse a boolean environment flag without accepting ambiguous values."""
    value = os.getenv(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{name} must be true or false")


def _default_model_id_for_provider(provider: str, bedrock_fallback: str) -> str:
    """Pick the right default model ID for whichever provider is active.

    Shared by every per-agent *_model_id field below so all three agents
    follow the exact same per-provider default pattern.
    """
    if provider == "openai":
        return _DEFAULT_OPENAI_MODEL_ID
    if provider == "ollama":
        return _DEFAULT_OLLAMA_MODEL_ID
    return bedrock_fallback


@dataclass(frozen=True)
class Settings:
    # ------------------------------------------------------------------
    # Provider selection
    # ------------------------------------------------------------------
    # "openai" for local dev without AWS access (current default), "ollama"
    # for fully offline local dev, or "bedrock" for the target production
    # provider. See build_model().
    model_provider: str = os.getenv("MODEL_PROVIDER", "openai").strip().lower()

    # ------------------------------------------------------------------
    # OpenAI (used when model_provider == "openai")
    # ------------------------------------------------------------------
    # No default - must come from the environment. Never hardcode a key.
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")

    # ------------------------------------------------------------------
    # Ollama (used when model_provider == "ollama")
    # ------------------------------------------------------------------
    ollama_host: str = os.getenv("OLLAMA_HOST", "http://localhost:11434")

    # ------------------------------------------------------------------
    # AWS / Bedrock (used when model_provider == "bedrock"; kept populated
    # and valid even while running on OpenAI/Ollama, so switching providers
    # is a single env var change with nothing else to configure).
    # ------------------------------------------------------------------
    aws_region: str = os.getenv("AWS_REGION", "eu-west-1")

    # SQL-RAG model used to generate read-only PostgreSQL queries.
    bedrock_sql_model_id: str = os.getenv(
        "BEDROCK_SQL_MODEL_ID",
        _DEFAULT_BEDROCK_SQL_MODEL_ID,
    )

    # Bedrock embedding model used for semantic retrieval of QueryExample rows.
    bedrock_embedding_model_id: str = os.getenv(
        "BEDROCK_EMBEDDING_MODEL_ID",
        _DEFAULT_BEDROCK_EMBEDDING_MODEL_ID,
    )
    embedding_dimensions: int = int(os.getenv("EMBEDDING_DIMENSIONS", "512"))

    # Generic Bedrock fallback for any future role without an explicit model.
    # Keep this on the cost-conscious 20B direct in-region model; the 120B
    # model is reserved for the Supervisor role below.
    bedrock_model_id: str = os.getenv(
        "BEDROCK_MODEL_ID", _DEFAULT_BEDROCK_AGENT_MODEL_ID
    )

    # ------------------------------------------------------------------
    # Per-agent model IDs, used by build_model() for ALL THREE providers:
    #   - model_provider == "openai"  -> defaults to _DEFAULT_OPENAI_MODEL_ID
    #   - model_provider == "ollama"  -> defaults to _DEFAULT_OLLAMA_MODEL_ID
    #   - model_provider == "bedrock" -> explicit role defaults below
    # An explicit *_MODEL_ID env var always wins, regardless of provider -
    # set it to a real Bedrock inference profile ID when switching to
    # Bedrock.
    # ------------------------------------------------------------------

    # The Supervisor's main routing/response model (reads the user query,
    # picks which specialist tool(s) to call, composes the final answer).
    # NOT the gate/classification model below - different job, different
    # (cheaper) model.
    supervisor_model_id: str = os.getenv("SUPERVISOR_MODEL_ID", "") or _default_model_id_for_provider(
        model_provider, _DEFAULT_BEDROCK_SUPERVISOR_MODEL_ID
    )
    insights_model_id: str = os.getenv("INSIGHTS_MODEL_ID", "") or _default_model_id_for_provider(
        model_provider, _DEFAULT_BEDROCK_AGENT_MODEL_ID
    )
    document_model_id: str = os.getenv("DOCUMENT_MODEL_ID", "") or _default_model_id_for_provider(
        model_provider, _DEFAULT_BEDROCK_AGENT_MODEL_ID
    )

    # The Supervisor's scope-gate classification model (agents/supervisor/gate.py)
    # - a single fast, cheap, tool-free call that decides in-scope vs.
    # out-of-scope before anything else runs. Deliberately reuses the same
    # lightweight defaults as the other agents under openai/ollama, since a
    # classification task doesn't need a bigger model than the specialists
    # that do the real work.
    #
    gate_model_id: str = os.getenv("GATE_MODEL_ID", "") or _default_model_id_for_provider(
        model_provider, _DEFAULT_BEDROCK_AGENT_MODEL_ID
    )

    # The Control Tower batch narration model (narration/control_tower.py) -
    # a plain, non-tool-calling completion call per alert, not part of the
    # agents/ package. Same lightweight per-provider defaults as gate_model_id,
    # for the same reason: narrating one alert's evidence into plain
    # language doesn't need a bigger model than the specialists.
    narration_model_id: str = os.getenv("NARRATION_MODEL_ID", "") or _default_model_id_for_provider(
        model_provider, _DEFAULT_BEDROCK_AGENT_MODEL_ID
    )

    # AWS Bedrock AgentCore deployment identifiers.
    # TODO: populate once the AgentCore Runtime resource is provisioned.
    agentcore_runtime_id: str = os.getenv("AGENTCORE_RUNTIME_ID", "")
    agentcore_endpoint_name: str = os.getenv("AGENTCORE_ENDPOINT_NAME", "DEFAULT")
    agentcore_cognito_discovery_url: str = os.getenv(
        "AGENTCORE_COGNITO_DISCOVERY_URL", ""
    )
    agentcore_allowed_cognito_client_id: str = os.getenv(
        "AGENTCORE_ALLOWED_COGNITO_CLIENT_ID", ""
    )
    agentcore_request_header_allowlist: str = os.getenv(
        "AGENTCORE_REQUEST_HEADER_ALLOWLIST", "Authorization"
    )
    agentcore_memory_id: str = os.getenv("AGENTCORE_MEMORY_ID", "")
    agentcore_memory_required: bool = _environment_flag(
        "AGENTCORE_MEMORY_REQUIRED", False
    )

    # Bedrock Guardrails (see agents/supervisor/guardrails.py). Empty by
    # default - real guardrail wiring is a TODO. Only meaningful when
    # model_provider == "bedrock" - agents/supervisor/agent.py is
    # responsible for not applying these to a non-Bedrock model.
    guardrail_id: str = os.getenv("BEDROCK_GUARDRAIL_ID", "")
    guardrail_version: str = os.getenv("BEDROCK_GUARDRAIL_VERSION", "DRAFT")

    # ------------------------------------------------------------------
    # Backend connection (ai-agent's OWN service-account auth against the
    # NestJS backend - see backend_client.py. Entirely separate from
    # model_provider above: this is about calling the ERP backend's REST
    # API for real data, not about which LLM answers a query. Also
    # separate from any END-USER auth - the AI layer authenticates as its
    # own least-privilege EMPLOYEE service account (see
    # backend/prisma/seed.ts), never as the human asking the question.
    # ------------------------------------------------------------------
    backend_url: str = os.getenv("BACKEND_URL", "http://localhost:3000")
    cognito_user_pool_id: str = os.getenv("COGNITO_USER_POOL_ID", "")
    cognito_app_client_id: str = os.getenv("COGNITO_APP_CLIENT_ID", "")
    cognito_service_app_client_id: str = os.getenv(
        "COGNITO_SERVICE_APP_CLIENT_ID", ""
    )
    backend_service_cognito_username: str = os.getenv(
        "BACKEND_SERVICE_COGNITO_USERNAME", ""
    )
    backend_service_cognito_password: str = os.getenv(
        "BACKEND_SERVICE_COGNITO_PASSWORD", ""
    )
    backend_request_timeout_seconds: float = float(os.getenv("BACKEND_REQUEST_TIMEOUT_SECONDS", "10"))

    # Direct read-only PostgreSQL connection used by the SQL-RAG pipeline.
    ai_database_url: str = os.getenv(
        "AI_DATABASE_URL",
        "",
    )

    # Maintenance-only connection used by the offline embedding-generation
    # script. This must never be supplied to the AgentCore runtime or used as
    # a fallback for SQL-RAG reads.
    query_example_write_database_url: str = os.getenv(
        "QUERY_EXAMPLE_WRITE_DATABASE_URL",
        "",
    )

    # General
    environment: str = os.getenv("APP_ENV", "development")
    log_level: str = os.getenv("LOG_LEVEL", "INFO")

    def __post_init__(self) -> None:
        if self.embedding_dimensions != 512:
            raise ValueError(
                "EMBEDDING_DIMENSIONS must be exactly 512 to match QueryExample.embedding"
            )

    def require_ai_database_url(self) -> str:
        """Return the dedicated SQL-RAG URL, failing closed when absent."""
        database_url = self.ai_database_url.strip()
        if not database_url:
            raise RuntimeError(
                "AI_DATABASE_URL must be configured for the SQL-RAG read-only database connection"
            )
        return database_url

    def require_query_example_write_database_url(self) -> str:
        """Return the maintenance embedding-write URL, failing closed."""
        database_url = self.query_example_write_database_url.strip()
        if not database_url:
            raise RuntimeError(
                "QUERY_EXAMPLE_WRITE_DATABASE_URL must be configured for QueryExample embedding generation"
            )
        return database_url

    # ------------------------------------------------------------------
    # Model construction
    # ------------------------------------------------------------------

    def build_model(self, agent_name: AgentName) -> "Model":
        """Construct the strands Model for a given agent, per model_provider.

        This is the ONLY place in the codebase that decides which model
        provider to instantiate. Agents call settings.build_model(name) and
        never construct a Model themselves, so switching model_provider in
        .env is a config-only change - no agent/tool code changes needed.

        Args:
            agent_name: Which agent's model to build - "insights",
                "document", "supervisor", "gate", or "narration".
                "supervisor" builds the Supervisor's main routing/response
                model; "gate" builds its separate, smaller scope-
                classification model (agents/supervisor/gate.py);
                "narration" builds the Control Tower batch narration
                model (narration/control_tower.py) - each a different job,
                each its own (typically smaller/cheaper) model.

        Returns:
            A strands Model instance (OpenAIModel, OllamaModel, or
            BedrockModel).

        Raises:
            ValueError: If agent_name or model_provider is unrecognized.
        """
        model_ids: dict[str, str] = {
            "insights": self.insights_model_id,
            "document": self.document_model_id,
            "supervisor": self.supervisor_model_id,
            "gate": self.gate_model_id,
            "narration": self.narration_model_id,
        }
        if agent_name not in model_ids:
            raise ValueError(
                f"Unknown agent_name: {agent_name!r} "
                "(expected 'insights', 'document', 'supervisor', 'gate', or 'narration')"
            )
        model_id = model_ids[agent_name]

        if self.model_provider == "openai":
            # Imported lazily so the optional `openai` dependency is only
            # required when it's actually the active provider.
            from strands.models.openai import OpenAIModel

            return OpenAIModel(
                client_args={"api_key": self.openai_api_key},
                model_id=model_id,
            )

        if self.model_provider == "ollama":
            # Imported lazily so the optional `ollama` dependency is only
            # required when it's actually the active provider.
            from strands.models.ollama import OllamaModel

            return OllamaModel(self.ollama_host, model_id=model_id)

        if self.model_provider == "bedrock":
            from strands.models import BedrockModel

            return BedrockModel(model_id=model_id, region_name=self.aws_region)

        raise ValueError(
            f"Unknown MODEL_PROVIDER: {self.model_provider!r} (expected 'openai', 'ollama', or 'bedrock')"
        )


settings = Settings()
