# Nexora ERP

A mini ERP system for warehouse and inventory operations — products, warehouses,
stock, suppliers, purchase/customer orders, transfers, document review (invoice
extraction), and an AI assistant for inventory questions and recommendations.

## Architecture

This is a monorepo with three independent apps and one shared database:

| Directory   | Stack                                                              | What it is                                                                 |
| ----------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `backend/`  | NestJS + Prisma + PostgreSQL (pgvector)                            | The REST API (`/api/*`) — all business logic, auth, and data access.       |
| `frontend/` | React 19 + Vite + Tailwind CSS 4                                    | The web app.                                                               |
| `ai-agent/` | Python + [Strands Agents SDK](https://strandsagents.com) + AWS Bedrock | The AI assistant (chat + Control Tower recommendations), deployable as an AWS Bedrock AgentCore Runtime. |

The backend is the only thing that talks to the database directly. The
frontend and the AI agent both go through the backend's REST API — the AI
agent never has its own database credential (see `ai-agent/README.md`'s
SQL-RAG section for why).

## Local setup

**1. Database** (repo root) — starts PostgreSQL with the `pgvector` extension
pre-installed, on `localhost:5433`:

```bash
docker compose up -d
```

**2. Backend** (`backend/`):

```bash
cd backend
npm install
copy .env.example .env      # fill in the values described in that file
npx prisma migrate deploy
npm run seed:app            # core demo data (products, warehouses, orders, ...)
npm run start:dev           # http://localhost:3000/api
```

**3. Frontend** (`frontend/`):

```bash
cd frontend
npm install
copy .env.example .env      # fill in the values described in that file
npm run dev                 # http://localhost:5173
```

**4. AI agent** (`ai-agent/`, optional — the rest of the app works without it):

```bash
cd ai-agent
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env      # fill in the values described in that file
set PORT=8081
python agentcore_entrypoint.py
```

Port **8081** matters — `frontend/vite.config.ts` proxies `/agentcore` there
for local dev (the local AgentCore dev server can't answer a browser's CORS
preflight on its own). See `ai-agent/README.md` for the full architecture,
including the Supervisor/Insights/Document agents, SQL-RAG, and Control
Tower narration.

### Signing in without a real AWS/Cognito account

Real deployments authenticate through Amazon Cognito. For local development
without a Cognito pool (or any AWS account at all), both the backend and
frontend support `LOCAL_AUTH_MODE`:

- `backend/.env`: `LOCAL_AUTH_MODE="true"`
- `frontend/.env`: `VITE_LOCAL_AUTH_MODE="true"`

With both set, sign in with any already-seeded user's email (e.g.
`admin@minierp.demo` or `employee@minierp.demo` after `npm run seed:app`) and
any password — the password field is ignored. This can only log in as a user
that already exists in the local database; it never invents an identity. The
real Cognito path is untouched and still used whenever `LOCAL_AUTH_MODE` is
off (the default) — never enable it in a real deployment.

## Backend API routing

The NestJS backend exposes every controller under the global `/api` prefix.
The local API base is `http://localhost:3000/api`, and the root controller is
available at `GET /api` for health checks. A production deployment must route
`/api/*` to the backend and use `/api` as its health-check path.

## Tests

```bash
# backend (from backend/)
npm run test        # unit
npm run test:e2e     # end-to-end
npm run test:cov     # coverage

# ai-agent (from ai-agent/)
pytest

# frontend (from frontend/)
npm run test
```
