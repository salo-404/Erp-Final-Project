# AI and Backend Scope Agreement

## Purpose

This document defines the work boundary between the Backend Engineer and the AI Engineer for the Mini ERP project.

Its goals are to:

- prevent the same business logic from being implemented twice;
- keep PostgreSQL and inventory state under backend control;
- define which NestJS functions are exposed to AgentCore as tools;
- define which calculations belong to NestJS and which responsibilities belong to AgentCore;
- document shared contracts that both engineers must agree on;
- identify planned AI features that are not supported by the finalized backend or database schema;
- provide a safe path for adding future AI actions.

This document follows the finalized decisions in:

- `Backend-Plan-Features.md`
- `Features-Functions.md`
- `AI-Architecture.md`
- `Features.md`
- `Ribal-AWS.md`

When older feature ideas conflict with the finalized backend plan, `Backend-Plan-Features.md` and this scope agreement are the source of truth for the MVP.

---

## Core Ownership Rule

> NestJS owns database access, deterministic calculations, validation, permissions, transaction state, and all writes. AgentCore owns natural-language understanding, tool selection, orchestration, combination of backend results, recommendations, and explanations.

**Backend/NestJS owns:**

- PostgreSQL
- Prisma
- database access
- validation
- authentication
- authorization
- deterministic calculations
- inventory state
- reservations
- stock movements
- transaction state
- all ERP writes
- S3/document persistence
- business rules
- concurrency/atomicity

**AI/AgentCore owns:**

- Supervisor orchestration
- specialist-agent routing
- natural-language understanding
- tool selection
- combining backend results
- recommendations
- explanations
- AI invoice extraction
- AI/fuzzy matching suggestions
- evidence/risk/alternative presentation

> AgentCore tools wrap or consume NestJS backend capabilities. They must not duplicate authoritative backend calculations.

> AgentCore never accesses PostgreSQL directly, never uses Prisma directly, never executes SQL, and never modifies ERP state directly.

An AgentCore tool may wrap a NestJS function, but it must not duplicate the backend calculation.

The basic architecture is:

```text
User
  |
  v
Supervisor Agent
  |
  v
Specialist Agent
  |
  v
Typed AgentCore Tool
  |
  v
NestJS API / Service
  |
  v
Prisma
  |
  v
PostgreSQL
```

The AI service does not receive database credentials and does not execute SQL.

---

## Backend Engineer Scope

The Backend Engineer owns the NestJS application and all authoritative ERP behavior.

### Database and persistence

The Backend Engineer owns:

- Prisma schema and migrations;
- PostgreSQL access;
- relationships and foreign-key behavior;
- seed data;
- historical-data protection;
- transaction boundaries;
- row-level locking;
- deterministic lock ordering;
- concurrency protection;
- persistent audit data.

### Authentication and authorization

The Backend Engineer owns:

- user creation and management;
- password hashing;
- JWT authentication;
- `ADMIN` and `EMPLOYEE` permissions;
- guards for sensitive operations;
- authorization for document approval and rejection;
- authorization for completing or cancelling transactions.

### Core ERP services

The Backend Engineer owns:

```text
AuthService
UsersService
ProductsService
WarehousesService
SuppliersService
WarehouseInventoryService
StockMovementService
ReservationService
InventoryTransactionService
DocumentReviewService
StockInsightsService
AnalyticsService
EmailService
CalendarService
```

### Inventory integrity

Only backend stock-movement logic may change `WarehouseInventory.onHand`.

The backend enforces:

```text
available = onHand - SUM(ACTIVE reservations)
```

The backend also enforces:

- outgoing reservations;
- transfer source reservations;
- prevention of negative stock;
- atomic stock movements;
- atomic transfer completion;
- transaction state transitions;
- synchronization of reservations after pending transaction edits;
- deterministic locking by `warehouseId + productId`.

### Deterministic intelligence

The following functions may appear intelligent, but they belong to the backend because they calculate reproducible ERP facts:

```text
findBestWarehouseForOrder()
rankSuppliers()
getBestSupplier()
getSupplierStats()
compareSuppliers()
getDeadStock()
getStockoutRisk()
getConsumptionAnomalies()
getRestockRecommendations()
getTransferRecommendations()
getTopSellingProducts()
getLowestSellingProducts()
getFastMovingProducts()
getSlowMovingProducts()
getSalesTrends()
getPurchaseTrends()
getStockHistory()
getWarehouseDemand()
getProductDemand()
getSupplierComparison()
```

The Backend Engineer implements and tests the formulas. AgentCore consumes the results.

### Protected actions

The Backend Engineer exclusively owns functions that change ERP state:

```text
createIncoming()
createOutgoing()
createTransfer()
updateTransaction()
completeTransaction()
cancelTransaction()
reserve()
release()
fulfill()
approveDocument()
rejectDocument()
createProduct()
updateProduct()
removeProduct()
```

AgentCore must not call sensitive write operations until a separate human-confirmation and permission flow has been implemented and approved.

---

## AI Engineer Scope

The AI Engineer owns the Python AgentCore service and its controlled interaction with NestJS.

### Agent architecture

The AI Engineer owns:

```text
Supervisor Agent
Inventory Agent
Risk and Insights Agent
Procurement Agent
Invoice Agent
Fulfillment Agent
```

The Supervisor Agent:

- understands the user's request;
- selects the required specialist;
- decides which controlled tools are required;
- combines results from multiple tools;
- identifies missing evidence;
- generates a recommendation;
- returns evidence, risk, and alternatives;
- never bypasses backend permissions.

Specialist agents return results to the Supervisor. They should not freely call one another in loops.

### AgentCore tools

The AI Engineer owns:

- tool schemas;
- tool names and descriptions;
- input validation before API calls;
- the HTTP client used to call NestJS;
- authentication propagation to NestJS;
- mapping backend DTOs into agent-friendly results;
- timeout and retry behavior for safe read operations;
- handling backend errors without inventing facts;
- tool execution traces;
- tests proving that tools call the expected endpoint.

Tool adapters may rename or reshape fields, but they must not recalculate authoritative values.

### Language and reasoning

The AI Engineer owns:

- natural-language query understanding;
- determining user intent;
- selecting tools;
- comparing backend-provided alternatives;
- explaining calculated facts;
- generating warehouse summaries;
- creating recommendations;
- presenting uncertainty;
- presenting evidence;
- presenting risks;
- listing alternatives considered;
- proposing actions without executing them.

### Model-based document extraction

The AI Engineer owns model-dependent extraction of provisional document fields:

```text
transaction type
supplier or customer name
document date
warehouse name
delivery country
delivery region
product names
quantities
prices
other invoice information
```

The extraction result is provisional. The Backend Engineer owns file validation, S3 storage, persistence, human review, approval, rejection, transaction creation, and inventory effects.

### Fuzzy matching

The AI Engineer can suggest fuzzy product, supplier, or warehouse matches.

The backend and human reviewer remain responsible for confirming the final IDs before any database changes are made.

### Explainability and observability

The AI Engineer owns the user-facing response structure:

```text
Recommendation
Reason
Evidence
Alternatives Considered
Risk
Proposed Actions
```

The AI Engineer also owns a safe execution trace such as:

```text
Supervisor received the request
Inventory Agent checked available stock
Risk Agent checked stockout risk
Procurement Agent compared suppliers
Supervisor generated a recommendation
Awaiting human action
```

The trace must show agents and tools used, not hidden chain-of-thought.

---

## Shared Work

Some work requires agreement from both engineers.

### Tool and API contracts

Before implementing an AI tool, both engineers agree on:

```text
Backend endpoint
HTTP method
Request DTO
Response DTO
Authentication requirement
Permission requirement
Error responses
Pagination behavior
Whether the operation writes data
AI tool name
AI tool description
Timeout expectations
```

### Response evidence

Analytical backend responses should contain enough evidence for AgentCore to explain the result without recalculating it.

Recommended shared fields include:

```json
{
  "calculatedAt": "2026-08-14T10:00:00Z",
  "source": "stock-insights-service",
  "parameters": {},
  "evidence": [],
  "warnings": []
}
```

### Error contract

AgentCore must distinguish between:

```text
400 Invalid input
401 Unauthenticated
403 Not authorized
404 Entity not found
409 Business-state conflict
422 Insufficient or unresolved data
500 Backend failure
503 Integration temporarily unavailable
```

The agent must not turn a backend error into an invented result.

### Integration testing

Both engineers jointly test:

- AgentCore tool input against backend DTO validation;
- backend response compatibility with tool schemas;
- authentication propagation;
- error handling;
- empty datasets;
- pagination;
- timeouts;
- unavailable external services;
- permissions;
- evidence returned with recommendations.

### Shared contract ownership

Shared DTOs or OpenAPI-generated clients should be stored in a clearly defined shared location, for example:

```text
packages/contracts/
```

Changes to shared contracts require review from both engineers.

---

## Functions Common to Both Plans

The following AI tools directly correspond to backend functions. The Backend Engineer implements the calculation or query. The AI Engineer implements the controlled tool wrapper and explanation.

### Inventory mappings

| AI tool | NestJS function | Backend responsibility | AI responsibility |
|---|---|---|---|
| `get_stock()` | `getByProduct()` | Return authoritative product inventory | Present or combine the result |
| `get_available_stock()` | `getAvailable()` | Calculate on-hand minus active reservations | Explain availability |
| `get_stock_by_warehouse()` | `getByWarehouse()` | Return inventory for a warehouse | Answer warehouse questions |
| `get_warehouse_inventory()` | `getByWarehouse()` / `getCatalog()` | Return warehouse catalog and quantities | Summarize inventory |
| `get_product_movements()` | `getLedger()` | Query immutable movement records | Explain movement history |
| `get_stock_timeline()` | `getLedger()` / `getStockHistory()` | Return time-based stock records | Summarize the timeline |
| `find_transfer_candidates()` | `getTransferRecommendations()` | Calculate source, destination, and quantity | Explain transfer alternatives |

### Risk and insight mappings

| AI tool | NestJS function | Backend responsibility | AI responsibility |
|---|---|---|---|
| `detect_consumption_spike()` | `getConsumptionAnomalies()` | Calculate unusual changes | Explain why the change matters |
| `analyze_dead_stock()` | `getDeadStock()` | Identify inactive products | Recommend investigation or action |

### Procurement mappings

| AI tool | NestJS function | Backend responsibility | AI responsibility |
|---|---|---|---|
| `get_suppliers()` | `SuppliersService.findAll()` | Return suppliers | Select relevant candidates |
| `compare_suppliers()` | `compareSuppliers()` | Calculate comparison statistics | Explain tradeoffs |
| `rank_suppliers()` | `rankSuppliers()` | Calculate deterministic ranking | Explain ranking evidence |
| `calculate_reorder_quantity()` | `getRestockRecommendations()` | Calculate recommended quantity | Explain the recommendation |

### Document mappings

| AI tool | Matching backend workflow | Backend responsibility | AI responsibility |
|---|---|---|---|
| `extract_invoice()` | Document review extraction flow | Validate, store, and persist | Extract provisional fields |
| `find_supplier()` | Supplier resolution during review | Return candidates and persist confirmed ID | Suggest likely supplier |

### Fulfillment mappings

| AI tool | NestJS function | Backend responsibility | AI responsibility |
|---|---|---|---|
| `get_customer_order()` | `findOne()` for OUTGOING | Return transaction facts | Explain the order |
| `evaluate_order_inventory()` | `getAvailable()` and reservation checks | Calculate availability | Combine results for the order |
| `choose_fulfillment_warehouse()` | `findBestWarehouseForOrder()` | Calculate suitable warehouse | Explain the selection |
| `get_order_status()` | `findOne()` | Return transaction status | Present status and implications |

---

## Partial Matches Requiring an Agreed Contract

### Demand forecasting

The AI plan mentions:

```text
forecast_demand()
```

The finalized backend plan currently provides:

```text
getProductDemand()
getWarehouseDemand()
historical consumption calculations
```

For the MVP, the AI tool should be named:

```text
get_product_demand()
```

A real future forecast should only be called `forecast_demand()` after a Forecast Service, prediction horizon, model, accuracy metric, and response contract are defined.

### Stockout prediction

The AI plan mentions:

```text
predict_stockout()
```

The backend plan provides:

```text
getStockoutRisk()
```

AgentCore may expose the name `predict_stockout`, but it should call the backend `getStockoutRisk()` endpoint.

The agreed backend response should include:

```json
{
  "productId": 12,
  "warehouseId": 3,
  "onHand": 500,
  "reserved": 100,
  "available": 400,
  "averageDailyConsumption": 65,
  "pendingIncomingQuantity": 0,
  "daysUntilStockout": 6,
  "predictedStockoutDate": "2026-08-20",
  "riskLevel": "HIGH",
  "confidence": "HIGH",
  "calculatedAt": "2026-08-14T10:00:00Z"
}
```

NestJS calculates every numeric field. AgentCore explains the result.

### Inventory risk summary

Instead of independently recalculating `calculate_inventory_risk()`, AgentCore should call and combine:

```text
getStockoutRisk()
getConsumptionAnomalies()
getDeadStock()
getTransferRecommendations()
```

The tool can be named:

```text
get_inventory_risk_summary()
```

The summary combines backend conclusions; it does not replace their calculations.

### Open purchase orders

The finalized schema does not have a separate Purchase Order entity. For the MVP, use:

```text
get_pending_incoming_transactions()
```

This maps to an inventory transaction query with:

```json
{
  "type": "INCOMING",
  "status": "PENDING"
}
```

The system should not call these records purchase orders unless a dedicated Purchase Order model is added later.

### Purchase cost

The backend stores item quantity and price but does not name a dedicated cost function in the current plan.

The Backend Engineer should provide a deterministic calculation such as:

```text
totalCost = SUM(item.quantity * item.price)
```

AgentCore may expose:

```text
calculate_purchase_cost()
```

The tool calls the backend calculation and does not perform invoice arithmetic inside the LLM.

### Duplicate document detection

The finalized schema has no persistent document-hash field. Therefore, the MVP tool should be called:

```text
check_possible_duplicate_document()
```

It must communicate its limitation and must not claim guaranteed duplicate detection.

---

## Final MVP Tools Used by AgentCore

### Inventory tools

```text
get_stock
get_available_stock
get_stock_by_warehouse
get_warehouse_inventory
get_product_movements
get_stock_timeline
get_transfer_recommendations
```

### Risk and insight tools

```text
get_product_demand
get_stockout_risk
get_consumption_anomalies
get_dead_stock
get_inventory_risk_summary
```

### Procurement tools

```text
get_suppliers
get_supplier_stats
compare_suppliers
rank_suppliers
get_best_supplier
get_pending_incoming_transactions
get_restock_recommendations
calculate_purchase_cost
generate_purchase_recommendation
```

`generate_purchase_recommendation` creates a proposed payload only. It does not create or modify a transaction.

### Document tools

```text
extract_document
find_supplier
suggest_product_matches
check_possible_duplicate_document
get_document_review_status
```

### Fulfillment tools

```text
get_customer_order
evaluate_order_inventory
find_best_warehouse
get_order_status
get_upcoming_deliveries
get_overdue_transactions
```

### Analytics tools

```text
get_top_selling_products
get_lowest_selling_products
get_fast_moving_products
get_slow_moving_products
get_sales_trends
get_purchase_trends
get_stock_history
get_warehouse_demand
get_product_demand
```

---

## Tool Contract Examples

### Available stock

```text
AI tool: get_available_stock
Backend endpoint: GET /warehouse-inventory/available
Method type: Read-only
Calculation owner: Backend Engineer
Tool owner: AI Engineer
Approval required: No
```

Example input:

```json
{
  "productId": 12,
  "warehouseId": 3
}
```

Example output:

```json
{
  "productId": 12,
  "warehouseId": 3,
  "onHand": 500,
  "reserved": 100,
  "available": 400,
  "calculatedAt": "2026-08-14T10:00:00Z"
}
```

### Stockout risk

```text
AI tool: get_stockout_risk
Backend endpoint: GET /stock-insights/stockout-risk
Method type: Read-only analysis
Calculation owner: Backend Engineer
Tool owner: AI Engineer
Approval required: No
```

### Restock recommendation

```text
AI tool: get_restock_recommendations
Backend endpoint: GET /stock-insights/restock-recommendations
Method type: Read-only analysis
Calculation owner: Backend Engineer
Tool owner: AI Engineer
Approval required: No
```

The result may recommend a purchase but cannot create one.

### Transfer recommendation

```text
AI tool: get_transfer_recommendations
Backend endpoint: GET /stock-insights/transfer-recommendations
Method type: Read-only analysis
Calculation owner: Backend Engineer
Tool owner: AI Engineer
Approval required: No
```

The result may recommend a source, destination, and quantity but cannot create or complete a transfer.

### Supplier ranking

```text
AI tool: rank_suppliers
Backend endpoint: GET /suppliers/rank
Method type: Read-only analysis
Calculation owner: Backend Engineer
Tool owner: AI Engineer
Approval required: No
```

### Document extraction

```text
AI tool: extract_document
Backend workflow: upload -> S3 -> AgentCore -> PendingDocumentReview
Method type: Provisional extraction
Extraction owner: AI Engineer
File and persistence owner: Backend Engineer
Human confirmation required: Yes
```

---

## Write and External-Action Policy

### MVP policy

AgentCore is read-only with respect to authoritative ERP state.

AgentCore may:

```text
Read
Analyze
Compare
Recommend
Explain
Generate a proposed payload
```

AgentCore must NOT directly:

```text
complete transactions
cancel transactions
approve documents
reject documents
reserve stock
release reservations
fulfill reservations
modify inventory
create/update/delete ERP records
send email automatically
create calendar events automatically
```

unless a future human-confirmation and permission system is explicitly designed and approved.

### Email and calendar behavior

For the MVP:

```text
Agent prepares recommendation or message
  |
  v
ADMIN reviews it in the frontend
  |
  v
ADMIN explicitly confirms
  |
  v
NestJS EmailService or CalendarService performs the action
```

The agent should never silently perform an external action.

### Future write tools

Write tools may be introduced only after the backend has:

- a clear approval model;
- an authenticated requesting user;
- an authorized approver;
- an action payload stored for review;
- action expiry;
- replay protection;
- audit records;
- backend validation at execution time;
- idempotency protection.

Even with an approval, the backend must revalidate current inventory and transaction state before execution.

---

## Features Outside the MVP

The following ideas appear in older planning notes but are not supported by the finalized backend schema or implementation plan.

### Forecasting and safety stock

```text
forecast_demand()
calculate_safety_stock()
```

These require an agreed forecasting model, horizon, training/history requirements, confidence metrics, and validation strategy.

### Expiry and FEFO

```text
get_expiring_inventory()
FEFO allocation
lot tracking
batch tracking
serial tracking
recall workflows
```

These require new database entities for lots, batches, serials, and expiry dates.

### Purchase order drafting

```text
draft_purchase_order()
```

The finalized transaction model has no `DRAFT` state. The MVP should generate a recommendation, not a stored draft purchase order.

### Three-way invoice matching

```text
match_invoice_to_po()
match_invoice_to_receipt()
detect_invoice_anomaly()
calculate_invoice_variance()
```

True three-way matching requires distinct Purchase Order, Goods Receipt, and Invoice entities. The finalized schema currently represents the workflow through inventory transactions and document review.

### Warehouse spatial optimization

```text
calculate_pick_path()
recommend_slotting()
find_crossdock_matches()
smart slotting heatmap
```

These require zones, bins, coordinates, product placement, dispatch points, and cross-dock data that are not present in the finalized schema.

### Digital twin and what-if simulation

```text
simulate demand increase
simulate supplier delay
simulate warehouse outage
simulate large customer order
```

These remain future features until snapshot inputs, simulation assumptions, formulas, and output contracts are defined.

---

## Recommended Repository Ownership

```text
backend/                         Backend Engineer
  src/auth/
  src/users/
  src/products/
  src/warehouses/
  src/suppliers/
  src/warehouse-inventory/
  src/stock-movements/
  src/reservations/
  src/inventory-transactions/
  src/document-review/
  src/stock-insights/
  src/analytics/
  src/integrations/

ai-agent/                        AI Engineer
  agents/
  tools/
  clients/
  workflows/
  extraction/
  prompts/
  tracing/
  tests/

packages/contracts/              Shared ownership
  requests/
  responses/
  errors/
  generated-client/
```

If `packages/contracts/` is not introduced, the backend OpenAPI specification should be the shared contract and the AI client should be generated or validated against it.

---

## Development Workflow Between Both Engineers

### Step 1: AI requirement

The AI Engineer writes the tool requirement:

```text
Tool name
User questions it answers
Required input
Required output
Required evidence
Expected errors
```

### Step 2: Backend contract

The Backend Engineer confirms:

```text
Existing endpoint that satisfies it
Existing endpoint requiring extension
New endpoint required
Unavailable data
Permission requirements
```

### Step 3: Shared DTO agreement

Both engineers approve example request and response objects before implementation.

### Step 4: Independent implementation

The Backend Engineer implements and tests the NestJS endpoint.

The AI Engineer implements the AgentCore tool against a mock response matching the agreed contract.

### Step 5: Integration test

Both implementations are connected and tested with:

- normal data;
- missing products;
- missing warehouses;
- empty history;
- insufficient history;
- authentication failure;
- permission failure;
- backend timeout;
- invalid response;
- concurrent inventory changes where applicable.

### Step 6: Agent behavior test

The AI Engineer verifies that the agent:

- chooses the correct tool;
- does not invent missing fields;
- communicates warnings;
- cites backend evidence in its explanation;
- does not attempt prohibited writes;
- asks for human action when necessary.

---

## Definition of Done

### Backend function

A backend function is complete when:

- its DTO is validated;
- authentication and authorization are enforced;
- its business logic is deterministic;
- database operations are safe and atomic where required;
- concurrency-sensitive paths are protected;
- errors are explicit;
- tests cover normal and failure cases;
- its response matches the shared contract;
- its OpenAPI documentation is updated.

### AI tool

An AI tool is complete when:

- its input schema is typed;
- its description clearly tells the agent when to use it;
- it calls only the agreed backend endpoint;
- it forwards authentication correctly;
- it handles errors and timeouts;
- it does not recalculate authoritative values;
- it returns evidence in a consistent format;
- tool-selection tests pass;
- it produces a safe execution trace;
- it performs no unapproved writes.

### End-to-end feature

An AI-assisted ERP feature is complete when:

- the backend result is correct;
- the AgentCore tool receives the correct result;
- the agent explains it accurately;
- the frontend can display the evidence;
- permission boundaries are preserved;
- failure behavior is visible and safe;
- no business calculation is duplicated between NestJS and AgentCore.

---

## Final Decision Guide

When ownership is unclear, use these questions in order:

1. Does it read or modify PostgreSQL?
   - Backend Engineer.
2. Does it validate inventory, permissions, or transaction state?
   - Backend Engineer.
3. Is it a deterministic calculation used by the ERP or frontend?
   - Backend Engineer.
4. Does it understand natural language or select tools?
   - AI Engineer.
5. Does it combine multiple verified results into a recommendation?
   - AI Engineer.
6. Does it extract uncertain information from an unstructured document?
   - AI Engineer for extraction; Backend Engineer for persistence and approval.
7. Does it perform a write or external action?
   - Backend Engineer, with explicit human confirmation.
8. Is the required data absent from the schema?
   - Future scope until both engineers approve a schema and contract change.

The shortest summary is:

> The Backend Engineer answers: What is true, valid, and allowed?
>
> The AI Engineer answers: What does the user mean, which verified tools are needed, what should be recommended, and how should the evidence be explained?
