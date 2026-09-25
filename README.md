# Nexora — Mini ERP

Nexora is a mini enterprise resource planning system for inventory and warehouse
operations — products, warehouses, suppliers, incoming/outgoing/transfer orders —
built around a **Control Tower** that surfaces what needs attention (stockouts, dead
stock, overdue orders) and an **AI assistant** that can answer questions about that
data in plain language and help review incoming documents.

The project is three independently-run services that only ever talk to each other
over HTTP, the way they would in production:

| Service | Role | Stack |
|---|---|---|
| [`backend/`](backend) | Owns all data and business rules — the single source of truth | NestJS 11 · TypeScript · Prisma 7 · PostgreSQL |
| [`frontend/`](frontend) | The only thing the browser loads | React 19 · TypeScript · Vite · Tailwind CSS v4 |
| [`ai-agent/`](ai-agent) | A separate, swappable-model reasoning layer | Python 3.11 · Strands Agents SDK · Amazon Bedrock AgentCore |

Identity for the whole system is AWS Cognito — the backend never issues or stores a
password.

## Table of contents

- [Screenshots](#screenshots)
- [Architecture](#architecture)
- [AWS architecture](#aws-architecture)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Project structure](#project-structure)
- [Core features](#core-features)
- [Testing](#testing)
- [Deployment](#deployment)
- [Contributors](#contributors)

## Screenshots

<!-- Stored in infra/pictures/. Drop more in there, named after the page's
     sidebar title, and add a row below to show them. -->

### Sign in

| Login |
|---|
| ![Login](infra/pictures/log%20in%20page.png) |

### Operations

| Warehouses | Inventory |
|---|---|
| ![Warehouses](infra/pictures/warehouse%20page.png) | ![Inventory](infra/pictures/inventroy%20page.png) |

| Calendar |
|---|
| ![Calendar](infra/pictures/calendar%20page.png) |

### Procurement

| Document Review |
|---|
| ![Document Review](infra/pictures/Document%20Review.png) |

### Intelligence

| Analytics | AI Agent |
|---|---|
| ![Analytics](infra/pictures/analytics%20page.png) | ![AI Agent](infra/pictures/ai%20chatbot.png) |

*Not pictured yet: Control Tower, Transfers, Suppliers, Orders, Employees, Settings — drop a screenshot into `infra/pictures/` and add it above.*

## Architecture

```
                              AWS Cognito
                         (the only identity provider)
                         /            |            \
                  SRP login    verify access token   service-account login
                       /               |                \
                Frontend  ── REST/JSON ──▶  Backend  ◀── tool calls ──  AI Agent
             (React SPA, :5173)      (NestJS, :3001/api)      (Strands, :8080)
                       \                    |                    /
                    SSE (proxied)      Prisma / :5433       SQL-RAG, read-only
                        \                   ▼                   /
                         ╲──────────▶  PostgreSQL  ◀───────────╯
```

- **Frontend ↔ Backend** — plain REST/JSON under the backend's global `/api`
  prefix, authenticated with a Cognito bearer token on every request.
- **Frontend ↔ AI Agent** — the local AgentCore dev server only implements
  `POST /invocations` and can't answer a browser's CORS preflight, so Vite proxies
  `/agentcore/*` to the agent same-origin. Responses stream as Server-Sent Events
  (`text_delta` / `tool_status` / `done` / `error`) — the same shape a deployed
  AgentCore Runtime produces.
- **AI Agent ↔ Backend** — the agent's tools call the exact same REST API the
  frontend uses. The chat-routed Insights specialist is read-only by design —
  nothing it does mutates stock.
- **AI Agent ↔ PostgreSQL** — one exception: open-ended natural-language data
  questions run through a dedicated, read-only `erp_ai_readonly` database role,
  completely bypassing the backend for that one tool (SQL-RAG, backed by a
  `pgvector` example-question store).

## AWS architecture

Every AWS service in this system has one concrete job — nothing is used just
because it's part of the ecosystem:

| Service | Role |
|---|---|
| **Cognito** | The single identity provider for the whole system. One User Pool, two app clients — a human-facing client (used by the frontend's SRP login) and a machine "service" client (the AI agent's own service account). The backend never issues a token, only verifies one (`aws-jwt-verify`) against the pool's public signing keys. |
| **Bedrock** | Production LLM provider. Every agent role — Supervisor routing, the Insights/Document specialists, the scope gate, Control Tower narration, and SQL generation — currently runs on **Mistral Ministral-3-14B**, with **Amazon Titan Embed Text v2** for the SQL-RAG example-question embeddings. The settings layer (`ai-agent/config/settings.py`) can swap any of these per-role (e.g. to Claude Sonnet 5) with a config change alone. |
| **Bedrock AgentCore Runtime** | Hosts the Python agent as a managed HTTP/SSE service in production — the exact same `agentcore_entrypoint.py` used for local dev, just deployed rather than run with `uvicorn` on a laptop. Assumed via a dedicated IAM role trusted only for the `bedrock-agentcore.amazonaws.com` service principal. |
| **S3** | Stores every uploaded invoice/PO document. The backend never streams a file itself — it issues short-lived presigned URLs for both upload and download. |
| **Textract** | Server-side OCR. `AnalyzeExpense` extracts line items, totals, and party details from an uploaded document before a human ever opens the review screen. |
| **ECS / Fargate** | Runs the backend container behind an Application Load Balancer. Fully stateless — no `.env` file or credentials are baked into the image; every setting (`DATABASE_URL`, `AWS_REGION`, `COGNITO_*`, …) comes from the ECS task definition's environment/secrets at deploy time, the same shape `dotenv` reads locally. |
| **ECR** | Hosts the container images for both the backend (ECS) and the AI agent's deployment package. |
| **CloudFront** | Serves the built frontend's static assets and fronts the API, with `frontend/.env.production` pointing the deployed SPA at the real backend and AgentCore Runtime endpoints. |

```
        CloudFront                          Cognito
     (frontend static assets)          (identity, both clients)
              │                          │           │
              ▼                          ▼           ▼
     ┌─────────────────┐   REST/JSON   ┌────────────────────┐   assume-role   ┌──────────────────────┐
     │   React SPA      │ ────────────▶│  ECS / Fargate       │◀───────────────│ Bedrock AgentCore     │
     │  (served by CF)  │◀──SSE(proxy)─│  NestJS backend (ALB)│   tool calls   │  Runtime (Python agent)│
     └─────────────────┘               └─────────┬────────────┘◀───────────────└──────────┬────────────┘
                                                    │ S3, Textract                          │ Bedrock
                                                    ▼                                       ▼
                                            PostgreSQL (RDS-style)  ◀── SQL-RAG, read-only ──┘
```

## Tech stack

### Backend (`backend/`)

| Library | Purpose |
|---|---|
| `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-express` | Framework — modules, dependency injection, Express adapter |
| `@prisma/client`, `@prisma/adapter-pg`, `prisma` | Type-safe ORM and migrations over PostgreSQL |
| `pg` | Postgres driver underneath Prisma's adapter |
| `aws-jwt-verify` | Verifies Cognito access tokens against the User Pool |
| `@aws-sdk/client-cognito-identity-provider`, `@aws-sdk/credential-providers` | Admin-side Cognito operations |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | Document storage + presigned download URLs |
| `@aws-sdk/client-textract` | OCR / line-item extraction for uploaded invoices |
| `class-validator`, `class-transformer` | Request DTO validation (unknown fields hard-reject) |
| `googleapis`, `@google-cloud/local-auth` | Google Calendar sync + email notifications |
| `rxjs` | NestJS's internal reactive-stream primitive |

*Dev-only:* `@nestjs/cli`, `jest` + `ts-jest`, `eslint` + `prettier`, `supertest`.

### Frontend (`frontend/`)

| Library | Purpose |
|---|---|
| `react`, `react-dom` | UI runtime — v19 |
| `react-router-dom` | Client-side routing — v7 |
| `amazon-cognito-identity-js` | Runs the Cognito SRP login challenge directly in the browser |
| `tailwindcss`, `@tailwindcss/vite` | Utility-class styling — v4, compiled by its own Vite plugin |
| `react-markdown`, `remark-gfm` | Renders the AI assistant's Markdown replies |

*Dev-only:* `vite` + `@vitejs/plugin-react`, `vite-plugin-node-polyfills` (Node
`global`/`Buffer` shims Cognito's SRP math needs in-browser), `typescript`, `oxlint`.

There is deliberately **no UI component library, icon library, chart library, or
global state library** — every component, icon (`components/ui/icons.tsx`), and
chart (e.g. `RevenueTrendChart.tsx`) is hand-built against the app's own CSS custom
property design tokens (`src/index.css`), and data fetching runs through a ~30-line
hand-rolled `useFetch` hook instead of a query library.

### AI Agent (`ai-agent/`)

| Library | Purpose |
|---|---|
| `strands-agents` | Agent framework — the "agents-as-tools" pattern |
| `bedrock-agentcore` | Deployment shell (`BedrockAgentCoreApp`) for Amazon Bedrock AgentCore Runtime |
| `boto3` | AWS SDK — Cognito service-account auth, Bedrock model calls |
| `httpx` | Calls back into the NestJS backend from agent tools |
| `psycopg` | Direct, read-only Postgres access for the SQL-RAG tool |
| `openai` | Local-dev model provider (default) |
| `pydantic`, `pydantic-settings` | Config and tool-schema validation |
| `pytest` | Test suite |

Model provider is a single setting (`MODEL_PROVIDER` in `.env`): `openai` (local dev
default), `ollama` (fully offline), or `bedrock` (production — Claude Sonnet 5 for
routing/reasoning, smaller Mistral Ministral models for cheaper SQL-generation and
document-matching paths) — no agent code changes either way.

## Getting started

### Prerequisites

- Node.js 20+, Python 3.11+, Docker Desktop
- An AWS Cognito User Pool (or set `LOCAL_AUTH_MODE=true` — see below — to skip AWS
  entirely for local dev)

### 1. Database

```bash
docker compose up -d
```

Starts `pgvector/pgvector:pg16` on host port **5433** (container `mini-erp-postgres`).

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env      # fill in DATABASE_URL / Cognito values
npx prisma migrate deploy
npm run seed:app          # or `npm run seed` to also generate SQL-RAG embeddings
npm run start:dev         # http://localhost:3000/api (PORT in .env overrides)
```

No reachable Cognito pool yet? Set `LOCAL_AUTH_MODE="true"` in `backend/.env` (and
the matching `VITE_LOCAL_AUTH_MODE="true"` in `frontend/.env`) — the login form's
password is then ignored and any already-seeded user's email signs in directly.
Never set this in a real deployment.

### 3. AI Agent

```bash
cd ai-agent
python -m venv .venv && .venv\Scripts\activate   # or source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env      # BACKEND_URL, MODEL_PROVIDER, DB roles, etc.
python -m scripts.dev_server   # http://localhost:8080
```

### 4. Frontend

```bash
cd frontend
npm install
cp .env.example .env      # VITE_API_URL, Cognito IDs, VITE_AGENTCORE_URL
npm run dev                # http://localhost:5173
```

## Project structure

```
backend/
  src/
    auth/ users/ products/ warehouses/ warehouse-inventory/
    suppliers/ supplier-intelligence/ inventory-transactions/
    stock-movements/ reservations/ document-review/ stock-insights/
    ai-query/ analytics/ integrations/{email,calendar}/
  prisma/
    schema.prisma  seed.ts  seed-query-examples.ts

frontend/
  src/
    pages/            # one component per sidebar page
    components/       # agent/ layout/ ui/ + one folder per domain
    agent/             # AgentContext, AgentCore transport, page-context
    auth/  lib/  theme/  types/

ai-agent/
  agents/
    supervisor/        # scope gate + routing (agents-as-tools)
    insights_agent/     # 11 read-only tools — stock, risk, suppliers, SQL-RAG
    document_agent/     # 7 tools — review, matching, duplicate detection
  agentcore_entrypoint.py   # HTTP/SSE deployment shell
  backend_client.py         # authenticated HTTP client back to the backend
```

## Core features

- **Control Tower** — one aggregation endpoint merging stockout risk, dead stock,
  consumption anomalies, restock/transfer recommendations, overdue transactions, and
  pending document reviews into a single severity-sorted feed.
- **Stock insights** — dead stock (no real customer-facing movement in 60+ days),
  stockout risk (`onHand − activeReserved` against a per-warehouse reorder
  threshold), consumption anomalies (30-day trailing window comparison), and
  transfer recommendations that only fire when a real donor warehouse exists.
- **Supplier intelligence** — weighted ranking (40% price, 30% on-time delivery, 20%
  cancellation rate, 10% product-specific history) so a cheap-but-unreliable
  supplier can't win by default.
- **Document review** — AWS Textract extracts invoice line items; the AI Document
  specialist can semantically match extracted products/suppliers against the
  catalog, with a fuzzy-match fallback if the AI call fails.
- **AI Assistant** — a floating chat widget on every page (and a full-page view)
  backed by a Supervisor → Insights specialist routing chain, streamed over SSE,
  with page-aware quick actions.
- **Employee management** — admin-only role changes and removal, reusing the
  existing `/users` auth model.
- **Calendar & email** — Google Calendar sync and email notifications for
  deliveries, credentials supplied via env vars (no local file dependency in
  production).

## Testing

```bash
# Backend
cd backend && npm run test        # Jest unit tests
cd backend && npm run test:e2e    # e2e

# AI Agent
cd ai-agent && pytest

# Frontend
cd frontend && npm run test
```

## Deployment

- **Backend** ships as a Docker image (`backend/Dockerfile`) targeting
  `node:22-slim` / ECS Fargate; Prisma's query engine is generated for both
  `native` (local dev) and `debian-openssl-3.0.x` (the container) targets.
- **AI Agent** deploys to Amazon Bedrock AgentCore Runtime (`agentcore_entrypoint.py`
  is the same HTTP shell used locally); `scripts/package_for_s3_deploy.py` packages
  it for that pipeline.
- **Frontend** builds static assets (`npm run build`) served behind CloudFront, with
  `frontend/.env.production` pointing at the deployed API and the real AgentCore
  Runtime endpoint.

## Contributors

- [Salman Bou Diab](https://github.com/salo-404)
- [Ribal Saleh](https://github.com/Ribalthecoder)
- [Joseph Chahine](https://github.com/Joseph-CH7)
