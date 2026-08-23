# ERP Multi-Agent System (Strands Agents SDK / AWS Bedrock AgentCore)

Python multi-agent scaffold for the ERP's AI layer, built on the
[Strands Agents SDK](https://strandsagents.com/) and targeting deployment on
**AWS Bedrock AgentCore**. Every tool in this scaffold is **mocked** - there
are no real backend/database calls yet. The goal of this stage is a correct,
testable, three-agent architecture with a draft API contract (the Pydantic
schemas in `tools/schemas/`) that the backend team can build against.

## Architecture - locked at 3 agents

```
                    ┌───────────────┐
   user query ────▶ │  Supervisor   │
                    └───────┬───────┘
                            │ Agents-as-Tools
              ┌─────────────┴─────────────┐
              ▼                           ▼
     ┌─────────────────┐         ┌─────────────────┐
     │  Insights agent  │         │  Document agent  │
     │ (+ Procurement)  │         │                  │
     └─────────────────┘         └─────────────────┘
```

1. **Supervisor** (`agents/supervisor/`) - the only agent exposed to end
   users. Imports the Insights and Document agents as `@tool`-wrapped
   functions (the "Agents-as-Tools" pattern) and routes queries to them.
   Real routing logic is a TODO - see `agents/supervisor/agent.py`.
2. **Insights agent** (`agents/insights_agent/`) - inventory analytics
   *and* procurement (stock levels, stockout risk, restocking, transfers,
   expiry, dead stock, consumption anomalies, supplier comparison, purchase
   orders).
3. **Document agent** (`agents/document_agent/`) - processes uploaded
   invoice/order documents after extraction: product/supplier/customer
   matching, PO matching, fulfillment warehouse choice, duplicate and
   discrepancy detection.

### Why Procurement lives inside Insights, not as its own agent

The architecture is intentionally locked at these three agents. Procurement
(supplier comparison, reorder quantities, draft purchase orders) is closely
coupled to the same inventory data Insights already reasons about - a
restock recommendation, a supplier comparison, and a draft PO are all
downstream of the same stock/risk numbers. Splitting Procurement into a
fourth agent would mean either duplicating that inventory context in two
places or adding cross-agent hops for what is fundamentally one continuous
line of reasoning ("this product is low → here's why → here's who to
reorder from → here's a draft order"). Procurement's tools
(`compare_suppliers`, `calculate_reorder_quantity`, `get_open_purchase_orders`,
`draft_purchase_order`) therefore live in `agents/insights_agent/tools.py`
alongside the analytics tools, under one system prompt
(`agents/insights_agent/prompts.py`). **Do not** split Procurement out into
a separate specialist agent, and do not add a fourth agent to the
Supervisor's tool list without revisiting this decision explicitly.

## Directory layout

```
agents/
  supervisor/       # Agents-as-Tools composition, gate, guardrails, hardened prompt
  insights_agent/    # Inventory analytics + Procurement (standalone-runnable)
  document_agent/    # Document processing (standalone-runnable)
tools/
  mocks/             # Realistic mocked backend responses, per tool
  schemas/           # Pydantic response models = draft API contract
narration/
  control_tower.py    # Batch alert narration - NOT an agent, see below
  supplier_analysis.py # On-demand single-supplier narration - NOT an agent either
tests/               # Smoke tests (no credentials required; a couple of
                     # live-model tests opt in when OPENAI_API_KEY is set)
config/
  settings.py        # Model provider selection + build_model(), AWS region,
                     # Bedrock/OpenAI/Ollama model IDs, env loading
scripts/
  chat_locally.py                # Manual REPL for a real Supervisor conversation
  run_control_tower_narration.py # Manual run of the batch narration layer
  run_supplier_analysis.py       # Manual run of the on-demand supplier narration
```

## Setup

```bash
cd ai-agent
python -m venv .venv && source .venv/bin/activate   # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
cp .env.example .env   # then edit as needed - no AWS credentials go in this file
```

AWS credentials are resolved by boto3's default credential chain
(environment variables, shared config/credentials file, or an IAM role);
OpenAI credentials come from `OPENAI_API_KEY`. Neither is read from `.env`
in this repo beyond your own local, untracked copy, and neither is
hardcoded anywhere in this codebase. See "Switching providers" below for
which one is active and how to change it.

## Running each specialist standalone

Both specialists are fully independent of the Supervisor - they can be
imported, built, and invoked entirely on their own. By default
(`MODEL_PROVIDER=openai`) this only requires `OPENAI_API_KEY` in `.env` - no
AWS access needed:

```bash
# Insights agent
python -m agents.insights_agent.agent

# Document agent
python -m agents.document_agent.agent
```

Or in Python:

```python
from agents.insights_agent.agent import build_insights_agent

agent = build_insights_agent()
response = agent("Which products are at risk of stocking out this week?")
print(response)
```

Neither module imports anything from `agents/supervisor/`.

## Running the Supervisor

```bash
python -m agents.supervisor.agent
```

This wires the Insights and Document agents in as tools and proves the
three-agent architecture compiles end to end. Like the two specialists, the
Supervisor's own model goes through `settings.build_model("supervisor")`, so
by default (`MODEL_PROVIDER=openai`) this also runs with just
`OPENAI_API_KEY` set - no AWS access needed. **Routing logic is a TODO** -
today the Supervisor relies on the underlying model's own tool selection
based on the (also TODO/placeholder) system prompt in
`agents/supervisor/prompts.py`.

For manually poking at a real multi-turn conversation instead of the single
canned query above, use the small REPL script:

```bash
python -m scripts.chat_locally
```

It builds the Supervisor agent from your current `.env` and loops:
read a line from stdin, send it to the Supervisor, print the response, type
`exit` to quit. This is a manual sanity-check tool, not an automated test.

## Deploying to AgentCore Runtime

`agentcore_entrypoint.py` (project root) is **separate from
`scripts/chat_locally.py`** and serves a different purpose:
`chat_locally.py` is a stdin/stdout REPL for local development only and is
never deployed anywhere. `agentcore_entrypoint.py` is the actual deployment
artifact - it wraps the same `build_supervisor_agent()` in an HTTP service
using [`BedrockAgentCoreApp`](https://pypi.org/project/bedrock-agentcore/)
(Option A / SDK Integration from Strands' official AgentCore deployment
guide), so it's what AgentCore Runtime actually runs in AWS.

It does not add a fourth agent or change routing: the same Supervisor, gate,
and two specialists are used. The entrypoint validates the human bearer with
backend `/auth/me` on every invocation, treats AgentCore's
`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` as the authoritative
conversation ID, and requires the canonical
`erp-user-{ERP_USER_ID}-{32-character-lowercase-UUID-hex}` format. The encoded
user ID is only a non-secret ownership namespace: the exact Cognito bearer and
backend `/auth/me` response remain authoritative. The namespace must match the
returned ERP user ID before the local session registry, gate, or Supervisor is
used. The entrypoint then lazily creates one mutable Supervisor per active
session, reuses it for same-session continuity, and serializes only invocations
for that session. Different sessions use different Supervisor instances and
independent locks. The registry repeats the owner check as defense-in-depth.

The registry is in-process, bounded to 256 entries, and removes inactive
sessions after one idle hour. It preserves history while that entry remains in
the active runtime. After eviction or complete runtime/microVM termination,
Supervisor history and locks are gone. A later invocation revalidates the
session's stateless owner namespace: the correct user can resume the logical
session with fresh history, while a different authenticated ERP user is still
rejected. Durable conversation recovery would require external session storage
and is deliberately outside the current scope.

For a new frontend conversation, use the authenticated Cognito session to call
backend `/auth/me`, generate a fresh UUID, construct
`erp-user-{user.id}-{uuid.hex}`, and send it in
`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`. Reuse that exact header for
follow-ups and generate a new UUID for a new conversation. Never reuse another
logged-in user's session ID. Payload fields such as `userId`, `sessionId`, and
`conversationId` are not identity or session authorities.

**Model-agnostic, independent of Bedrock permissions.** `build_supervisor_agent()`
already resolves its model through `settings.build_model("supervisor")` -
see "Switching providers" above - so this entrypoint works with whichever
`MODEL_PROVIDER` is set in `.env` right now (currently `openai`), with zero
code changes. Deploying this to AgentCore Runtime does not require AWS
Bedrock model-invoke permissions unless `MODEL_PROVIDER=bedrock` - the
Runtime *hosting* layer (the container, the HTTP endpoint, the deployment
pipeline) is a separate AWS capability from the Bedrock model backend, and
this wrapper only needs the former to run.

### Testing the wrapper locally before any real AWS deployment

Per the official guide's manual verification steps - confirm the HTTP
service works before attempting a real `agentcore launch`:

```bash
# Terminal 1 - start the service
python agentcore_entrypoint.py
```

Use a current human Cognito access token for the authenticated invocation;
never commit or print it.

```bash
# Terminal 2 - health check
curl http://localhost:8080/ping

# Terminal 2 - a real query
curl -X POST http://localhost:8080/invocations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $HUMAN_TOKEN" \
  -H "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: erp-user-7-7f3d91b7d15d40dfa96b8f02086b7dad" \
  -d '{"prompt": "Which products are at risk of stocking out?"}'
```

You should get back `{"status":"Healthy",...}` from `/ping` and
`{"result": "..."}` from `/invocations` - the same kind of answer you'd see
from `scripts/chat_locally.py`, just over HTTP instead of a REPL. An
out-of-scope or prompt-injection-shaped prompt still gets declined by the
gate here too, before it ever reaches a specialist - the whole point of
this file is that it's a thin transport shell, not a different code path.
Replace `7` with the ERP user ID returned by `/auth/me` and the sample suffix
with a freshly generated UUID hex value. Reuse the same runtime-session header
for follow-ups in one conversation; generate a new UUID for a new conversation.
`scripts/test_agentcore_local.py` automates exactly this sequence (start
the server, hit `/ping`, hit `/invocations` with both an in-scope and an
out-of-scope prompt, print the results) if you'd rather run one command
than juggle two terminals.

Real AWS deployment (`agentcore configure` / `agentcore launch`, IAM roles,
ECR image build) is not covered here - this section only covers proving the
wrapper itself works, which is the prerequisite the official guide expects
before you attempt that.

## Control Tower narration (not a fourth agent)

`narration/control_tower.py` is a **batch process, not a chat entry point,
and explicitly not a fourth agent** - the architecture stays locked at
Supervisor + Insights + Document (see "Architecture" above). Its job:
fetch structured alerts from the authenticated backend
`GET /control-tower/alerts` feed and turn each alert into a plain-language
narrative plus one concrete proposed action.

It is deliberately **not** a Strands `Agent` with tools. Narrating one
alert is a single request/response - read the evidence, produce two
strings - with no need for a tool registry or a multi-turn conversation
loop, and this may run over many alerts in one batch. So
`narrate_alert()` calls the underlying strands `Model` directly via
`.structured_output()`, one level lighter than even the Supervisor's
no-tools gate check (`agents/supervisor/gate.py`), which still wraps a
`Model` in an `Agent`. It gets its own small/cheap model via a new
`settings.build_model("narration")` - same per-provider pattern as
everything else (`gpt-5.4-mini` / `llama3.1` / TODO-verified-Bedrock).

Run it manually against the real authenticated backend alert feed:

```bash
python -m scripts.run_control_tower_narration
```

This prints each alert's category, severity, generated narrative, and
proposed action - a one-shot batch run, not a REPL (there's nothing to
converse with). Every proposed action is phrased as a proposal ("Reorder
14 units...") never as something already done ("Reordered...") - the
narration layer doesn't execute anything, same rule as everywhere else in
this codebase.

## Supplier analysis narration ("explain this supplier")

`narration/supplier_analysis.py` is the on-demand sibling of Control
Tower's batch narration - same lightweight pattern (a direct
`.structured_output()` call via `settings.build_model("narration")`, no
Strands `Agent`, no tools), but triggered for **one specific supplier at a
time**, not looped over a set. It narrates a supplier's existing stats
(cost, lead time, reliability, delivery history - the backend's
`getSupplierStats()` / `rankSuppliers()` / `getTransactionHistory()`,
mocked today in `tools/mocks/supplier_mock_data.py`) into a plain-language
explanation of that supplier's trade-offs, plus context for a human's own
decision - never a directive telling the reader which supplier to pick.

Run it against a known mock supplier ID (5, 7, 12, or 3 - see
`tools/mocks/supplier_mock_data.py`):

```bash
python scripts/run_supplier_analysis.py 5
```

Prints the supplier's stats followed by the generated narrative and
recommendation context. An unknown supplier ID errors clearly instead of
narrating a fabricated result - same "don't guess" principle as the
Document agent's `document_id` requirement.

## Running the tests

No credentials or network access required for the bulk of the suite - tests
call the `@tool`-decorated functions directly (Strands tools remain plain,
directly-callable Python functions) against the mocked data, and verify
agent construction/wiring without invoking a real model:

```bash
pytest
```

Two tests (`test_insights_agent_live_openai_smoke`,
`test_document_agent_live_openai_smoke`) additionally make one real OpenAI
call each, through the exact same `build_*_agent()` / `settings.build_model()`
path the app uses - everything downstream of the model call (the tools) is
still mocked. They're marked `@pytest.mark.skipif` on `OPENAI_API_KEY` being
unset, so they skip automatically with no credentials and run automatically
once you add a key to `.env`.

## Switching providers

This scaffold currently runs on **OpenAI (`gpt-5.4-mini`)** for local
development, so it's fully testable without AWS access. A fully offline
**Ollama** option is also available for local dev with no external API
calls at all. Production uses direct in-region Bedrock models in `eu-west-1`:
GPT-OSS 120B for the Supervisor, GPT-OSS 20B for Insights, Document, scope
gate, and narration, Ministral 3 8B for SQL generation, and Titan Text
Embeddings V2 at 512 dimensions for retrieval.

`config/settings.py` has exactly one function that decides which provider
gets instantiated - `settings.build_model(agent_name)` - and all three
agents (`agents/insights_agent/agent.py`, `agents/document_agent/agent.py`,
`agents/supervisor/agent.py`) call only that function, never a provider's
Model class directly. Switching is therefore a **config-only change, with
zero agent/tool/schema code edits**:

1. Set `MODEL_PROVIDER=bedrock` in `.env` (or `openai` / `ollama` for local
   dev - see `.env.example`).
2. Use the role-specific direct model IDs documented in `.env.example`, and
   confirm `AWS_REGION=eu-west-1`.
3. That's it - `build_model()` will construct `BedrockModel` (instead of
   `OpenAIModel`/`OllamaModel`) for every agent the next time it's built.

Whichever provider isn't active just goes unused - e.g. `OPENAI_API_KEY`
and `OLLAMA_HOST` are simply ignored once `MODEL_PROVIDER=bedrock`; nothing
needs to be unset.

### SQL-RAG database credentials and deployment sequence

`AI_DATABASE_URL` is the AgentCore/runtime SELECT-only credential. Its role
needs SELECT on the eight allowed operational ERP tables and on
`QueryExample` for internal pgvector retrieval. `QueryExample` is still
excluded from the generated-SQL allowlist, so database-role permission does
not make it queryable by model-generated SQL.

`QUERY_EXAMPLE_WRITE_DATABASE_URL` is maintenance/bootstrap-only. Give its
role only enough permission to SELECT `QueryExample` and UPDATE
`QueryExample.embedding`; never provide it to AgentCore and never use it as a
fallback for `AI_DATABASE_URL`.

Fresh deployment order:

1. Use a migration/admin credential and create the `vector` extension if the
   migration cannot create it itself.
2. Run `prisma migrate deploy`.
3. Seed QueryExamples.
4. Set `QUERY_EXAMPLE_WRITE_DATABASE_URL`, run
   `python scripts/generate_query_embeddings.py`, and verify every intended
   embedding is non-null and exactly 512-dimensional.
5. Run the application with the SELECT-only `AI_DATABASE_URL` role.

**After switching, still do a short validation pass against the real GPT-OSS
models** - the code path doesn't change, but prompt behavior (how
literally a model follows the `agents/*/prompts.py` instructions, tool-call
triggering, output verbosity) can differ meaningfully between model
families even with an identical system prompt. Re-run the standalone agents
manually (`python -m agents.insights_agent.agent`, `python -m
agents.document_agent.agent`, `python -m scripts.chat_locally` for the
Supervisor) and spot-check a few of the scenarios in
`tests/test_insights_agent.py` / `tests/test_document_agent.py` by hand
before trusting it in production.

**`SUPERVISOR_MODEL_ID` / `build_model("supervisor")` is the Supervisor's
main routing/response model only** - the one that reads a query, decides
which specialist tool(s) to call, and composes the final answer. It is a
separate concern from the gate/classification model in
`agents/supervisor/gate.py`, which uses the cheaper GPT-OSS 20B role default.

## Security posture (Supervisor)

The Supervisor is the only agent directly exposed to end users, so it has a
three-layer defense against prompt injection and scope creep:

1. **Bedrock Guardrails** (`agents/supervisor/guardrails.py`) - TODO, not
   yet wired to a real guardrail; deferred until AWS access returns.
2. **Scope gate** (`agents/supervisor/gate.py`) - implemented. A separate,
   small, fast classification call (`settings.build_model("gate")`)
   rejects out-of-scope queries and prompt-injection/override attempts
   before they ever reach the Supervisor's own model call or a specialist
   tool - see `tests/test_gate.py`.
3. **Hardened system prompt** (`agents/supervisor/prompts.py`) -
   implemented. Real scope/override-resistance content, not a placeholder.

Layers 2 and 3 don't require AWS and are both real; layer 1 stays a stub
until Bedrock access returns. See the docstrings in each file for details.

## What's mocked vs. real

- **Mocked**: every tool body in `agents/insights_agent/tools.py` and
  `agents/document_agent/tools.py`. They call into `tools/mocks/` and
  validate the result against `tools/schemas/` before returning - no real
  backend, database, or extraction/OCR call is made anywhere in this
  scaffold.
- **Real**: the Strands `Agent`/`@tool` wiring, the Pydantic schemas (draft
  API contract), and the model calls themselves - the Insights and Document
  agents talk to a real OpenAI model by default (`MODEL_PROVIDER=openai`),
  or a real Bedrock model once switched (see "Switching providers" above).
  The exact Bedrock model ID should still be verified against your
  account's enabled models before deploying - see the TODO comment in
  `config/settings.py`.

## Not implemented (see TODO markers in code)

- Real Supervisor routing logic beyond the gate + prompt-driven tool
  selection (`agents/supervisor/agent.py`)
- Real Bedrock Guardrails config (`agents/supervisor/guardrails.py`) -
  deferred until AWS access returns
- Adversarial/red-team testing of the scope gate and hardened system
  prompt (`agents/supervisor/gate.py`, `agents/supervisor/prompts.py`) -
  both are real, not stubs, but not yet stress-tested against a
  determined attacker
- Real backend calls in place of every mocked tool body, and in place of
  `tools/mocks/control_tower_mock_data.py` once the backend's
  `getControlTowerAlerts()` exists
- AWS Bedrock AgentCore Runtime deployment wiring (entry point, request/
  response shape, `AGENTCORE_RUNTIME_ID` in `config/settings.py`)
