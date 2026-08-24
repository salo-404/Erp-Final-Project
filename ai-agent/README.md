# ERP Multi-Agent System

Python AI runtime for the mini-ERP, built with the Strands Agents SDK and
targeting Amazon Bedrock AgentCore. Active tools use the authenticated NestJS
backend or the guarded read-only SQL-RAG database connection. Test fixtures and
the local supplier-narration demo are the only consumers of `tools/mocks/`.

## Locked runtime architecture

There are exactly three conversational agents:

1. Supervisor — the only user-facing agent. Its exact tools are
   `insights_agent_tool` and `document_agent_tool`.
2. Insights — inventory, fulfillment, supplier, procurement-analysis, and
   SQL-RAG specialist. Its runtime registry contains exactly 11 tools.
3. Document — operates on existing backend `PendingDocumentReview` records.
   Its runtime registry contains exactly 7 tools.

Control Tower is sequential batch narration, not a fourth agent. Textract is
an upstream extraction service, not an agent.

The Supervisor prompt performs model-driven routing. Mixed document/inventory
requests run Document first, consume only complete `[MATCHED_DATA]`, and then
run Insights. Document line-item resolution is owned by Document; pure Insights
requests may use guarded read-only SQL discovery to resolve one unique product
ID from a product name.

## Backend and authentication

Normal read tools call the NestJS API through the service-user `BackendClient`.
The client obtains a Cognito access token through the service-only app client,
caches it, and performs one refresh on a 401.

AgentCore invocations must carry the authenticated human Cognito access token.
Before any reusable session state or Supervisor is used, the entrypoint calls
backend `GET /auth/me` with that exact bearer. PostgreSQL `User.id` and `role`
returned by the backend are authoritative. Document approval and rejection use
the exact human bearer through `HumanAuthenticatedBackendClient`; there is no
service-user fallback, and the backend requires ADMIN.

The canonical runtime session ID is:

```text
erp-user-{ERP_USER_ID}-{32-character-lowercase-UUID-hex}
```

The authenticated ERP user must own the session. One Supervisor instance is
kept per active session, same-session execution is serialized, and different
sessions may execute concurrently.

## AgentCore Memory and streaming

Short-term AgentCore Memory is attached only to the Supervisor. Its actor ID is
the authoritative ERP `User.id` as a string, its session ID is the canonical
runtime session ID, and asynchronous writes remain enabled. Set
`AGENTCORE_MEMORY_REQUIRED=true` in production so configured Memory cannot
silently fall back to in-process state. Tokens, credentials, and authorization
metadata are not passed to Memory.

The public stream emits only:

```json
{"type":"text_delta","text":"..."}
{"type":"done"}
{"type":"error","message":"The assistant could not complete this request."}
```

Raw model events, tool payloads, reasoning, SQL, exceptions, and credentials are
not public stream events. Runtime Strands agents use a null callback handler so
the SDK does not separately print model/tool internals to process output.

## Model configuration

Bedrock is the source default. The locked direct in-region mapping is:

- Supervisor: `mistral.ministral-3-14b-instruct`
- Insights: `mistral.ministral-3-14b-instruct`
- Document: `mistral.ministral-3-14b-instruct`
- Gate: `mistral.ministral-3-14b-instruct`
- Control Tower narration: `mistral.ministral-3-14b-instruct`
- SQL generation: `mistral.ministral-3-14b-instruct`
- Embeddings: `amazon.titan-embed-text-v2:0`, exactly 512 dimensions
- Region: `eu-west-1`

Every conversational/classification/narration/SQL role deliberately shares
one model ID. GPT-OSS (`openai.gpt-oss-120b-1:0` / `-20b-1:0`) and
Nova/Claude-Haiku were tried first and are unusable in this account -
GPT-OSS confirmed dead on live testing, Nova blocked by the org Bedrock
SCP's cross-region inference profile routing, Claude-Haiku denied outright.
`mistral.ministral-3-14b-instruct` is the one model confirmed reachable and
reliable, so it is used everywhere, including SQL generation, rather than
pairing it with a separate unverified smaller model.

`settings.build_model(role)` is the single conversational/narration model
factory. OpenAI remains an optional local-development provider, but there
is intentionally no implicit local model fallback: when selecting it,
configure every role-specific `*_MODEL_ID` with a compatible model.

AWS credentials are never stored in source; the AWS SDK default credential
chain or runtime IAM role supplies them.

## SQL-RAG

`query_database` is an Insights-only read path. Generated SQL is parsed and
validated before execution: one SELECT/query statement, operational ERP tables
only, no schema qualification, no writes/DDL, no unsafe system functions,
validated Prisma identifiers/columns, bounded results, and CTE support.

`AI_DATABASE_URL` is required at runtime and must identify a SELECT-only role.
That role needs SELECT on the eight operational ERP tables plus `QueryExample`
for internal pgvector retrieval. `QueryExample` is excluded from the generated
SQL table allowlist despite that database-role permission.

`QUERY_EXAMPLE_WRITE_DATABASE_URL` is maintenance/bootstrap-only. Its role only
needs SELECT on `QueryExample` and UPDATE on `QueryExample.embedding`. Never
provide it to AgentCore and never use it as a fallback for `AI_DATABASE_URL`.

Fresh SQL-RAG deployment order:

1. Use a migration/admin credential and create the `vector` extension if needed.
2. Run `prisma migrate deploy`.
3. Seed QueryExamples.
4. Configure `QUERY_EXAMPLE_WRITE_DATABASE_URL` and run
   `python scripts/generate_query_embeddings.py`.
5. Verify intended embeddings are non-null and exactly 512-dimensional.
6. Run AgentCore with the SELECT-only `AI_DATABASE_URL` role.

## Document extraction and review

The backend owns the final flow:

```text
browser upload
  -> NestJS (PDF/JPEG/PNG, single-page invoice, max 10 MB)
  -> private S3 object
  -> Amazon Textract AnalyzeExpense with Bucket + Name
  -> deterministic provisional mapping
  -> PendingDocumentReview
  -> human ADMIN review
  -> PENDING inventory transaction on approval
```

The invoice must explicitly contain `Transaction Type: INCOMING` or
`Transaction Type: OUTGOING`; direction is never inferred. Extraction does not
resolve database IDs, create products/suppliers, approve documents, or mutate
inventory. Human viewing uses a separate temporary presigned URL endpoint; a
presigned URL is not the extraction source. S3 cleanup compensates failures
before review persistence.

## Control Tower narration

`narration/control_tower.py` fetches the authenticated real backend
`GET /control-tower/alerts` feed and narrates alerts sequentially. It calls the
configured narration model directly, has no tool registry or conversation
loop, and cannot execute its proposed actions.

Run the manual batch:

```bash
python -m scripts.run_control_tower_narration
```

`narration/supplier_analysis.py` is a separate local demo that intentionally
uses `tools/mocks/supplier_mock_data.py`; it is not an agent or production
runtime data path.

## Setup and local commands

```bash
cd ai-agent
python -m venv .venv
# Windows: .venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
```

Then configure the non-secret identifiers and external credentials described in
`.env.example`. Do not commit the local `.env`.

Useful commands:

```bash
python -m agents.insights_agent.agent
python -m agents.document_agent.agent
python -m agents.supervisor.agent
python -m scripts.chat_locally
pytest
```

Live-model and live-backend tests are conditional; ordinary unit/wiring tests
use local fakes or `httpx.MockTransport` and do not call live AWS services.

## Deployment requirements

Before launching AgentCore, provision/configure externally:

- Cognito user pool, frontend app client, service-only app client, and mapped
  PostgreSQL users.
- AgentCore CUSTOM_JWT discovery URL/client restriction and Authorization
  header allowlist.
- AgentCore Runtime IAM permissions for the locked Bedrock models, Cognito
  service authentication, backend network access, and short-term Memory.
- Private S3 bucket and backend IAM permissions for S3 and
  `textract:AnalyzeExpense`.
- Runtime SELECT-only SQL role and separate QueryExample embedding-writer role.
- `AGENTCORE_MEMORY_ID`, with Memory required in production.

Optional Bedrock Guardrails remain an unprovisioned deployment hardening layer;
the implemented scope gate and hardened Supervisor prompt remain active without
it.
