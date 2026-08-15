# Mini ERP — AI Plan (Folder Structure & Agent Functions)

## Scope Note

This document replaces `Backend-Plan-Features.md` and `Step-1-Backend-NestJS-AI-Python.md`, both removed. It covers **only the AI/AgentCore side** of the project.

- Backend module scope (functions, folders, per-developer split) lives in `Backend-Team-Split.md` and `Features-Functions.md`.
- The backend/AI ownership boundary and tool contracts live in `AI-Backend-Scope.md`.
- The confirmed agent architecture (three agents, not five) and what changed from the earlier design live in `Work-Split-Alignment.md` — this document builds on that decision.
- `AI-Architecture.md` remains the reference for reasoning patterns (explainability structure, human-in-the-loop approval, evidence/risk framing) but its five-specialist agent breakdown is superseded by the three-agent design below.

Core principle, unchanged from every other doc in this set:

> Backend calculates every fact and executes every write. AI reasons over the results, routes requests, and explains — it never calculates anything itself and never touches the database.

---

## Confirmed Architecture

```
User
  |
  v
Supervisor Agent
  |
  ├── Insights Agent
  └── Document Agent
  |
  v
Typed AgentCore Tools
  |
  v
NestJS Backend API
```

- **Supervisor Agent** — classifies intent, routes to Insights and/or Document, filters out-of-context requests, combines specialist results into one answer.
- **Insights Agent** — everything stock/risk/procurement: stockout risk, dead stock, anomalies, transfers, reorder, supplier comparison, purchase recommendation narration.
- **Document Agent** — everything invoice/order document related: extraction, matching, discrepancy/duplicate explanation.

There is no Fulfillment Agent, and no separate Inventory Agent, Risk Agent, or Procurement Agent — those responsibilities are folded into the Insights Agent.

AgentCore:

- does not access PostgreSQL;
- does not receive database credentials;
- does not execute SQL;
- does not duplicate NestJS calculations;
- does not directly modify inventory;
- does not complete/cancel ERP transactions;
- does not approve/reject documents.

---

## Folder Structure

```
ai-agent/
├── agents/
│   ├── supervisor.py
│   ├── insights_agent.py
│   └── document_agent.py
│
├── tools/
│   ├── inventory_tools.py
│   ├── risk_tools.py
│   ├── procurement_tools.py
│   ├── document_tools.py
│   └── control_tower_tools.py
│
├── clients/
│   └── nestjs_client.py
│
├── prompts/
│   ├── supervisor_prompt.py
│   ├── insights_prompt.py
│   ├── document_prompt.py
│   └── guardrails.py
│
├── workflows/
│   ├── extraction_workflow.py
│   └── narration_workflow.py
│
├── tracing/
│   └── execution_trace.py
│
├── tests/
│
└── main.py
```

- `agents/` — one file per agent; each defines the agent's system behavior and which tools it's allowed to call.
- `tools/` — typed tool wrappers, one per backend capability area, each calling `clients/nestjs_client.py` rather than a database.
- `clients/nestjs_client.py` — the single HTTP client used to reach the NestJS API; owns auth-token propagation, timeouts, retries, and error mapping.
- `prompts/` — system prompts per agent, plus `guardrails.py` for the Supervisor's three-layer defense (Guardrails + gate + hardened prompt).
- `workflows/` — multi-step flows that aren't a single tool call: document extraction end-to-end, and the batch narration flow used by Control Tower.
- `tracing/` — the safe execution trace (agents/tools used, not raw chain-of-thought) shown in the UI.

---

## Supervisor Agent

### Responsibilities

- Understand the user's request and classify intent: Insights, Document, or both.
- Filter out-of-context or unsafe requests (guardrail layer).
- Decide which specialist agent(s) to invoke.
- Combine specialist results into a single coherent answer.
- Apply the explainability structure to the final response:

```
Recommendation
Reason
Evidence
Alternatives Considered
Risk
Proposed Actions
```

### Three-layer defense

1. **Guardrails** — input/output content filtering before anything reaches the model.
2. **Gate** — intent classification that rejects or redirects requests outside ERP scope before routing to a specialist.
3. **Hardened prompt** — the Supervisor's own system prompt is written to resist instruction override from user input.

### Functions

```
route(request)
combineResults(insightsResult, documentResult)
buildExecutionTrace()
```

`route()` never calls a specialist's tools directly — it delegates to the specialist agent, which owns its own tool selection.

---

## Insights Agent

Owns all stock/risk/procurement reasoning. Absorbs what would previously have been three separate agents (Inventory, Risk & Insights, Procurement).

### Tool mappings

| Tool | Backend function | Notes |
| --- | --- | --- |
| `get_stock` | `getByProduct()` | |
| `get_available_stock` | `getAvailable()` | |
| `get_stock_by_warehouse` | `getByWarehouse()` | |
| `get_low_stock_products` | `getLowStockProducts()` | |
| `get_stockout_risk` | `getStockoutRisk()` | |
| `analyze_dead_stock` | `getDeadStock()` | |
| `detect_consumption_spike` | `getConsumptionAnomalies()` | |
| `get_restock_recommendations` | `getRestockRecommendations()` (refined 3-check version, see `Work-Split-Alignment.md`) | Returns `needsReorder`, `reason`, quantity/candidate |
| `find_transfer_candidates` | `getTransferRecommendations()` | |
| `get_suppliers` | `SuppliersService.findAll()` | |
| `get_supplier_stats` | `getSupplierStats()` | |
| `compare_suppliers` | `compareSuppliers()` | |
| `rank_suppliers` | `rankSuppliers()` | |
| `get_best_supplier` | `getBestSupplier()` | |
| `get_upcoming_deliveries` | `getUpcomingDeliveries()` | |
| `get_overdue_transactions` | `getOverdueTransactions()` | |
| `get_expiring_inventory` | *not yet available* | Blocked on a schema decision — see `Work-Split-Alignment.md`. Do not implement this tool until the backend function exists. |

### Narration responsibilities

- Explain stockout risk, dead stock, and anomaly results in plain language with evidence.
- Narrate purchase/restock recommendations, including the 3-check reasoning (available stock, incoming PO, transfer candidate) behind each one.
- Power the **Control Tower narration layer**: given a batch of alerts from `getControlTowerAlerts()`, turn each alert's evidence into a plain-language "proposed action" line. This runs in batch, not as live chat.
- Power **on-demand supplier analysis**: given a supplier's existing stats (`getSupplierStats()`, `rankSuppliers()`), produce the "explain this supplier" narration for a UI button — no new backend calculation, just explanation of existing numbers.

### Functions

```
answerInventoryQuery(question)
explainStockoutRisk(productId, warehouseId)
explainRestockRecommendation(productId)
narrateControlTowerAlerts(alerts)
explainSupplier(supplierId)
compareSuppliersNarration(productId)
```

---

## Document Agent

Owns invoice/order extraction and matching. Absorbs what would previously have been the Invoice Agent.

### Responsibilities

- Run provisional extraction on uploaded invoices/customer-order documents (supplier/customer, date, warehouse, delivery country/region, product names, quantities, prices).
- Suggest fuzzy product/supplier/warehouse matches with a similarity score.
- Explain discrepancies (e.g., invoiced quantity vs. expected) and possible duplicates.
- Never persists anything itself — extraction output is provisional until the backend's human review/approval flow confirms it.

### Tool mappings

| Tool | Backend workflow | Notes |
| --- | --- | --- |
| `extract_document` | Document review extraction flow | Provisional fields only |
| `find_supplier` | Supplier resolution during review | Suggests candidates; backend persists confirmed ID |
| `suggest_product_matches` | Product resolution during review | Fuzzy suggestion + similarity score; human confirms |
| `check_possible_duplicate_document` | Document review duplicate check | Must communicate its own limitation (no persistent hash field) rather than claim guaranteed detection |
| `get_document_review_status` | `findOne()` for `PendingDocumentReview` | |

### Functions

```
runExtraction(documentId)
suggestProductMatches(invoiceItem)
suggestSupplierMatch(extractedSupplierName)
explainDiscrepancy(expected, actual)
checkPossibleDuplicate(document)
```

---

## Cross-Cutting Concerns

### Tool definitions and schemas

Owned by the AI engineer. Each tool has a typed input schema, a description that tells the agent when to use it, and calls exactly one agreed backend endpoint — no recalculating authoritative values.

### AgentCore deployment

Bedrock/Strands setup, session handling — owned by the AI engineer, deployed separately from the NestJS backend per `Step-1`'s (now superseded, but still true) rule: the ERP must run completely with AI turned off.

### Observability / execution trace

```
Supervisor received the request
Insights Agent checked available stock
Insights Agent checked stockout risk
Supervisor generated a recommendation
Awaiting human action
```

Shows agents and tools used — never raw chain-of-thought.

---

## What AgentCore Must NOT Do

Carried forward unchanged from `AI-Backend-Scope.md`:

```
AgentCore → PostgreSQL              ❌
AgentCore → Prisma                  ❌
AgentCore → modify onHand           ❌
AgentCore → complete transaction    ❌
AgentCore → cancel transaction      ❌
AgentCore → approve/reject document ❌
AgentCore → raw SQL                 ❌
```

```
AgentCore = READ + ANALYZE + RECOMMEND
NestJS    = READ + WRITE + ENFORCE
```

---

## Open Items (from Ribal's note, still unresolved)

- Confirm `analyze_dead_stock`, `get_consumption_anomalies`, and `get_expiring_inventory` are all on the exposed backend tool list — the first two exist, the third is blocked on a schema decision.
- Agree the exact request/response JSON shape and auth mechanism for every tool, so mocked responses match reality on integration day.
- Agree `getControlTowerAlerts()`'s response shape (`severity`, `evidence`, `category` fields) before the narration workflow is built against it.
