# Mini ERP — Work Split Alignment (Backend Team ↔ Ribal/AI)

## Purpose

This document reconciles `Step-1-Backend-NestJS-AI-Python.md` (the backend team's scope doc) with Ribal's "Work Split: Backend Team vs AI" note.

Going forward: where the two disagree, **Ribal's version wins on anything AI-side**, since he owns that layer. This doc records what stayed the same (common ground) and what changed because of his note (adopted differences), so neither doc has to be read as contradicting the other.

---

## Common Ground — Unchanged

Everything below is agreed by both documents and stays exactly as already planned.

### Core principle

> Backend calculates every fact and executes every write. AI reasons over the results, routes requests, and explains — it never calculates anything itself and never touches the database.

### Backend team — full scope, untouched

- Auth / Users — JWT auth, roles (ADMIN / EMPLOYEE)
- Products, Warehouses, Suppliers — CRUD, capacity, historical-delete protection
- Warehouse Inventory — available-stock calculation, capacity, `findBestWarehouseForOrder()`
- Stock Movements — immutable ledger, `onHand` updates
- Reservations — reserve/release/fulfill, locking, concurrency
- Inventory Transactions — create/update/complete/cancel for INCOMING, OUTGOING, TRANSFER
- Document Review — upload, S3 storage, staging fields, product matching, approval → transaction creation
- Stock Insights — `getDeadStock()`, `getStockoutRisk()`, `getConsumptionAnomalies()`, `getRestockRecommendations()`, `getTransferRecommendations()`
- Analytics — all `get*Trends`/`get*Selling`/`getWarehouseDemand` functions
- Email / Calendar services — sending and calendar API integration; AI decides *what*, backend handles *how*
- Typed tool endpoints for AgentCore — the tool list in Step-1 §24/§25
- AWS infra, Docker, deployment
- Roles (ADMIN/EMPLOYEE only, no MANAGER), transaction model (INCOMING/OUTGOING/TRANSFER × PENDING/COMPLETED/CANCELLED, no CONFIRMED), and the "invoice approval ≠ physical stock change" rule

### AI ownership that didn't change

- Natural-language understanding, intent routing
- Tool selection and calling backend endpoints
- Combining backend results into one answer
- Explanations, evidence, recommendations
- Invoice/order field extraction (provisional; backend persists the confirmed result)
- Fuzzy product/supplier/warehouse matching suggestions (human/backend confirms before DB changes)
- Never: direct PostgreSQL/Prisma access, raw SQL, modifying inventory, completing/cancelling transactions, approving/rejecting documents

---

## Ribal's Adopted Differences

These changes come from Ribal's note and are now the accepted direction. They supersede the conflicting parts of `Step-1-Backend-NestJS-AI-Python.md` noted below.

### 1. AI architecture: three agents, not five

**Adopted:** Supervisor Agent + **Insights Agent** + **Document Agent**.

- Insights Agent absorbs what was previously split across Inventory Agent, Risk & Insights Agent, and Procurement Agent — all stock/risk/procurement tool calls and their explanations (stockout risk, dead stock, anomalies, transfers, reorder, supplier comparison, PO recommendation narration).
- Document Agent absorbs what was previously the Invoice Agent — invoice and customer-order extraction/matching, discrepancy/duplicate explanation.
- **Fulfillment Agent is dropped** — no longer part of the active design.
- Supervisor keeps its role: intent classification/routing (Insights vs. Document vs. both), out-of-context/guardrail filtering, combining specialist results into one answer, plus a three-layer defense (Guardrails + gate + hardened prompt).

**Supersedes:** Step-1 §26 "Target architecture" (which lists Supervisor + Inventory + Risk + Procurement + Invoice + Fulfillment). That five-agent list should be read as superseded by this three-agent design. `AI-Architecture.md` remains the detailed reference for the reasoning/explainability patterns, but its five-specialist breakdown is no longer the agent count in use.

### 2. New backend work requested to support AI features

| Feature | Backend builds | Status |
| --- | --- | --- |
| **Control Tower** | One aggregation function, `getControlTowerAlerts()`, pulling together `getLowStockProducts()`, `getStockoutRisk()`, `getOverdueTransactions()`, `getConsumptionAnomalies()`, plus invoice/order discrepancies from Document Review. Returns an array with severity + evidence per alert. | Adopted — builds on existing functions, no schema change. |
| **Predictive Replenishment (refined)** | Enhance `getRestockRecommendations()` to run a 3-check sequence: (1) confirm it nets `available = onHand − reservations`, not raw `onHand`; (2) check incoming PO quantity/expected date; (3) only treat another warehouse's stock as a transfer candidate if that product's turnover there is low — never suggest pulling from a warehouse actively selling it. Returns `needsReorder`, a `reason` code (`covered_by_incoming_po` / `transfer_available` / `no_incoming_no_transfer`), and the relevant quantity/candidate. | Adopted — refines an existing planned function, no schema change. |
| **Supplier dashboard** | List endpoint (name, email, rating) built on already-planned `getSupplierStats()` / `rankSuppliers()` / `getTransactionHistory()`. | Adopted — no new calculation logic needed. |
| **Pick-Path Optimizer** | Bin/zone location data model (does not exist yet), grid/graph representation, shortest-path algorithm, `calculate_pick_path()` endpoint. 100% deterministic, no AI involvement. | **Flagged, not yet built.** This requires a new database model (bins/zones/coordinates) on a schema previously declared frozen, and was explicitly listed as 🔴 Future / out-of-MVP in Step-1 §29 and as needing new entities in `AI-Backend-Scope.md`'s "Features Outside the MVP" section. We're accepting this as the new direction per Ribal's request, but it needs an explicit schema-change decision before backend starts building it — not a silent scope change. |
| **`getExpiringInventory()`** (used inside Control Tower) | Requires expiry-date tracking, which doesn't exist in the current schema. | **Flagged, same reason as Pick-Path.** Needs an explicit schema decision (new field/entity) before backend implements it. Until then, Control Tower can ship without this input and add it once the schema question is resolved. |

**Supersedes:** Step-1 §29's 🔴 bucket, which listed "Pick-path optimization" as not-MVP. That line is now under active discussion rather than settled as out-of-scope — but it is *not* settled as in-scope either, since it needs a schema decision first.

### 3. Open items still needing a direct conversation (per Ribal's note, unresolved)

- Confirm `analyze_dead_stock()`, `get_consumption_anomalies()`, `get_expiring_inventory()` are added to the exposed AgentCore tool list — currently only partially listed (the first two exist in some form; `get_expiring_inventory` depends on the schema decision above).
- Exact request/response JSON shape + auth mechanism for every tool the agents call, so mocked responses match reality on integration day.
- `getControlTowerAlerts()` response shape — agree on fields (`severity`, `evidence`, `category`) up front so the narration layer isn't guessing at structure.

---

## Net Effect

- Backend's core module scope (Auth through Analytics, concurrency rules, transaction model) is unchanged — build it exactly as `Step-1-Backend-NestJS-AI-Python.md` and `Backend-Plan-Features.md` already describe.
- Two new backend functions are now planned on top of that: `getControlTowerAlerts()` and the refined `getRestockRecommendations()` 3-check logic — both buildable now, no schema impact.
- Two items (Pick-Path Optimizer, expiry tracking) are accepted in direction but blocked on a schema decision — treat them as "next up for a schema conversation," not yet part of the buildable backlog.
- AI side moves from a 5-agent design to a 3-agent design (Supervisor, Insights, Document) — this is Ribal's call to make since he owns that layer.
