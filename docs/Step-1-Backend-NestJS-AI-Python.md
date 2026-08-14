# AI & Backend Scope — Mini ERP

## 1. Purpose

This document defines the complete boundary between the NestJS Backend and the Python AgentCore AI layer.

The goal is to:

- Build a complete ERP backend that works without AI.
- Keep PostgreSQL and all ERP business logic under NestJS control.
- Prevent the same business logic from being implemented twice.
- Define which NestJS functions can later be consumed by AgentCore.
- Separate deterministic calculations from AI reasoning.
- Keep AI read-only for the MVP.
- Keep future AI features from changing the core ERP architecture unnecessarily.

### Source of Truth

For the current MVP:

- `Backend-Plan-Features.md`
- `Features-Functions.md`
- This document

Older AI concepts such as the Supervisor/multi-agent architecture are considered future scope unless explicitly approved by the team.

---

## 2. Core Architecture

```
                    MINI ERP
                       |
          ┌────────────┴────────────┐
          |                         |
     NestJS Backend             AgentCore AI
       CORE / NOW                LATER
          |                         |
      Prisma                    AI Tools
          |                         |
     PostgreSQL              HTTP/API calls
                                    |
                                    ↓
                              NestJS Backend
```

The most important rule:

> NestJS owns the database, business logic, validation, permissions, inventory calculations, transaction state, and all ERP writes. AgentCore consumes controlled backend data and provides natural-language understanding, reasoning, explanations, and recommendations.

AgentCore:

- does not access PostgreSQL;
- does not receive database credentials;
- does not execute SQL;
- does not duplicate NestJS calculations;
- does not directly modify inventory;
- does not complete/cancel ERP transactions.

---

## 3. NestJS Backend Structure

```
backend/
    │       └── update-product.dto.ts
    │
    ├── warehouses/
    │   ├── warehouses.module.ts
    │   ├── warehouses.controller.ts
    │   ├── warehouses.service.ts
    │   └── dto/
    │       ├── create-warehouse.dto.ts
    │       └── update-warehouse.dto.ts
    │
    ├── suppliers/
    │   ├── suppliers.module.ts
    │   ├── suppliers.controller.ts
    │   ├── suppliers.service.ts
    │   └── dto/
    │       ├── create-supplier.dto.ts
    │       └── update-supplier.dto.ts
    │
    ├── warehouse-inventory/
    │   ├── warehouse-inventory.module.ts
    │   ├── warehouse-inventory.controller.ts
    │   ├── warehouse-inventory.service.ts
    │   └── dto/
    │       └── set-reorder-threshold.dto.ts
    │
    ├── stock-movements/
    │   ├── stock-movements.module.ts
    │   ├── stock-movements.controller.ts
    │   └── stock-movements.service.ts
    │
    ├── reservations/
    │   ├── reservations.module.ts
    │   └── reservations.service.ts
    │
    ├── inventory-transactions/
    │   ├── inventory-transactions.module.ts
    │   ├── inventory-transactions.controller.ts
    │   ├── inventory-transactions.service.ts
    │   └── dto/
    │       ├── create-incoming.dto.ts
    │       ├── create-outgoing.dto.ts
    │       ├── create-transfer.dto.ts
    │       └── update-transaction.dto.ts
    │
    ├── document-review/
    │   ├── document-review.module.ts
    │   ├── document-review.controller.ts
    │   ├── document-review.service.ts
    │   └── dto/
    │       ├── upload-document.dto.ts
    │       └── review-document.dto.ts
    │
    ├── stock-insights/
    │   ├── stock-insights.module.ts
    │   ├── stock-insights.controller.ts
    │   └── stock-insights.service.ts
    │
    ├── analytics/
    │   ├── analytics.module.ts
    │   ├── analytics.controller.ts
    │   └── analytics.service.ts
    │
    └── integrations/
        ├── s3/
        │   ├── s3.module.ts
        │   └── s3.service.ts
        ├── email/
        │   ├── email.module.ts
        │   └── email.service.ts
        └── calendar/
            ├── calendar.module.ts
            └── calendar.service.ts
```

`email/` and `calendar/` are integration-layer components and can be implemented after the core ERP is stable.

---

## 4. Authentication & Authorization

### Roles

Only two roles exist:

```
ADMIN
EMPLOYEE
```

#### ADMIN

Full system access, including:

- user management;
- product management;
- warehouse management;
- supplier management;
- sensitive transaction operations;
- document approval/rejection;
- transaction completion/cancellation;
- deletion where permitted.

#### EMPLOYEE

Operational access:

- read ERP data;
- create pending transactions;
- upload documents;
- perform normal operational tasks;
- cannot perform ADMIN-only management operations;
- cannot approve/reject sensitive documents unless explicitly authorized;
- cannot complete/cancel restricted transactions.

Exact endpoint permissions must be enforced using `RolesGuard`.

---

## 5. Auth Module

### Functions

```
validateUser(email, password)
login(dto)
```

### Responsibilities

- Password hashing/verification.
- JWT generation.
- Authentication.
- JWT strategy.
- Protected endpoints.

---

## 6. Users Module

### Functions

```
create(dto)
findAll()
findOne(id)
update(id, dto)
remove(id)
```

### Responsibilities

- User CRUD.
- Role assignment.
- User validation.
- ADMIN-only management.

---

## 7. Products Module

### Functions

```
create(dto)
findAll()
findOne(id)
update(id, dto)
remove(id)
```

### Responsibilities

- Product catalog.
- Product information.
- Product validation.
- Historical-data protection.

If a product has historical stock/transaction records, deletion should return:

```
409 Conflict
```

rather than exposing a raw database foreign-key error.

---

## 8. Warehouses Module

### Functions

```
create(dto)
findAll()
findOne(id)
update(id, dto)
remove(id)
getCatalog(warehouseId)
```

### Responsibilities

- Warehouse CRUD.
- Warehouse information.
- Independent warehouse catalog.
- Warehouse-specific inventory access.

Warehouse deletion must respect historical records.

---

## 9. Suppliers Module

### Functions

```
create(dto)
findAll()
findOne(id)
update(id, dto)
remove(id)

getTransactionHistory(supplierId)

getSupplierStats(supplierId)
compareSuppliers(productId)
```

### Supplier statistics

NestJS calculates deterministic values such as:

- average purchase price;
- on-time delivery percentage;
- late deliveries;
- cancellation rate;
- purchase frequency;
- transaction history.

### AI-supporting

The following can later be consumed by AgentCore:

```
getSupplierStats()
compareSuppliers()
```

The AI explains the results; it does not calculate them.

---

## 10. Warehouse Inventory Module

### Functions

```
getByWarehouse(warehouseId)
getByProduct(productId)
getAvailable(productId, warehouseId)
getLowStockProducts()
getWarehouseCapacity(warehouseId)
setReorderThreshold(id, value)
```

### Available stock

```
available = onHand - active reservations
```

`available` should be calculated, not stored as an independent source of truth.

### Capacity

`maxCapacity` is informational.

If:

```
maxCapacity = null
```

return an appropriate "capacity not configured" result instead of dividing by null.

### AI-supporting

```
getByWarehouse()
getByProduct()
getAvailable()
getLowStockProducts()
getWarehouseCapacity()
```

---

## 11. Stock Movements Module

This is the immutable stock ledger.

### Functions

```
recordMovement(...)
getLedger(filters)
```

### recordMovement()

Must atomically:

```
Create StockMovement
+
Update WarehouseInventory.onHand
```

Only stock-movement logic may change `onHand`.

### Responsibilities

- Incoming stock.
- Outgoing stock.
- Transfer movements.
- Historical stock audit.
- Immutable ledger.

### AI-supporting

```
getLedger()
```

AgentCore can later use this for stock history questions.

---

## 12. Reservations Module

Reservations protect stock while transactions are pending.

### Functions

```
reserve(...)
release(...)
fulfill(...)
```

### Used by

```
OUTGOING
TRANSFER
```

while they are PENDING.

### Reservation logic

Before reserving:

```
Lock inventory row
↓
Calculate available
↓
Validate quantity
↓
Create/update reservation
```

This prevents concurrent requests from reserving the same stock.

---

## 13. Inventory Transactions Module

This is the core ERP transaction engine.

### Transaction types

```
INCOMING
OUTGOING
TRANSFER
```

### Statuses

```
PENDING
COMPLETED
CANCELLED
```

There is no `CONFIRMED` status.

### createIncoming(dto)

Creates:

```
INCOMING + PENDING
```

No physical stock change.

### createOutgoing(dto)

Creates:

```
OUTGOING + PENDING
```

Then reserves the required stock.

No physical deduction yet.

### createTransfer(dto)

Creates:

```
TRANSFER + PENDING
```

Rules:

- source and destination must be different;
- source must have enough available stock;
- source stock is reserved.

### update(id, dto)

Only `PENDING` transactions may be edited.

If item quantities or warehouses change, reservations must be synchronized in the same database transaction.

### complete(id)

This is the point where physical stock changes.

```
INCOMING
StockMovement +
onHand +
```

```
OUTGOING
StockMovement -
onHand -
reservation fulfilled
```

```
TRANSFER
Source:
StockMovement -
onHand -

Destination:
StockMovement +
onHand +
```

Everything must be atomic.

### cancel(id)

Only `PENDING`.

```
OUTGOING
Release reservation.

TRANSFER
Release source reservation.

INCOMING
No stock release is required.
```

All become:

```
CANCELLED
```

No physical stock changes.

### Read functions

```
findAll(filters)
findOne(id)
getUpcomingDeliveries()
getOverdueTransactions()
```

### AI-supporting

These can later become read-only AgentCore tools.

---

## 14. Concurrency Rules

These rules apply to all stock-affecting operations.

### Atomicity

Use:

```
Prisma $transaction()
```

for operations that modify multiple related records.

### State transition protection

Do not rely only on:

```
read status
→ check PENDING
→ update
```

Use a conditional database update where appropriate:

```
WHERE id = X
AND status = PENDING
```

and verify the affected-row count.

### Row locking

Use PostgreSQL:

```
SELECT ... FOR UPDATE
```

inside an interactive Prisma transaction where stock rows need to be locked.

### Lock ordering

When multiple inventory rows are locked, always order them consistently by:

```
warehouseId
productId
```

This reduces deadlock risk.

These rules apply to:

- reservations;
- outgoing completion;
- transfer completion;
- stock movements;
- pending transaction edits;
- other operations that concurrently affect stock.

---

## 15. Document Review Module

The core backend supports invoice/document review without AI.

### Functions

```
upload(file)
findOne(id)
findAllPending()
approve(...)
reject(...)
```

### Upload

Validate:

```
PDF
JPG
JPEG
PNG
maximum 10 MB
```

Then:

```
Upload
↓
S3
↓
PendingDocumentReview
```

### Manual review

The reviewer provides:

- supplier;
- date;
- warehouse;
- items;
- quantities;
- prices where required.

### Product resolution

For the core backend:

```
Exact match
OR
manual product selection
```

AI fuzzy matching is later.

### Approve

Approval creates:

```
PENDING INCOMING
```

It does not immediately change stock.

Later:

```
complete()
↓
stock movement
↓
stock increases
```

This keeps:

> invoice approval ≠ physical receipt.

### Reject

Stores:

```
rejectionReason
reviewedBy
reviewedAt
```

---

## 16. S3 Integration

### S3Service

```
upload()
get()
delete()
```

Used by Document Review.

S3 stores the document; PostgreSQL stores the associated review/business information.

---

## 17. Stock Insights Module

### Functions

```
getDeadStock(days)
getStockoutRisk()
getConsumptionAnomalies()
```

### Dead Stock

Find products with no meaningful recent movement.

### Stockout Risk

Use deterministic backend data:

```
available stock
+
consumption rate
+
pending incoming
+
expected delivery
+
reorder information
```

NestJS calculates the risk.

### Consumption Anomalies

Detect unusual consumption patterns.

### AI-supporting

```
getDeadStock()
getStockoutRisk()
getConsumptionAnomalies()
```

---

## 18. Analytics Module

### Functions

```
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

All calculations are performed by NestJS.

The LLM does not independently calculate business metrics.

### AI-supporting

These functions can later be exposed through AgentCore tools.

---

## 19. Additional Deterministic Functions

These are valid NestJS capabilities from the expanded plan:

```
rankSuppliers()
getBestSupplier()
findBestWarehouseForOrder()
getRestockRecommendations()
getTransferRecommendations()
```

### Scope

These are not required for the basic ERP engine to function.

They are:

> AI-supporting deterministic backend features.

If the team has enough time, implement them after the core transaction/inventory system is stable.

They can later feed AgentCore recommendations.

---

## 20. Email Integration — Later

```
EmailService
├── sendEmail()
└── sendPurchaseRecommendation()
```

NestJS owns the actual email provider/API integration.

AgentCore may later decide what recommendation should be communicated.

This is not a blocker for the core ERP backend.

---

## 21. Calendar Integration — Later

```
CalendarService
└── createShipmentReminder()
```

NestJS handles the calendar API integration.

AgentCore can later determine when a shipment reminder is appropriate.

This is also not a blocker for the core ERP.

---

## 22. Backend Features Required From the Original ERP Specification

The core backend must support:

### Warehouses

- Warehouse CRUD.
- Independent warehouse catalog.
- Independent warehouse stock.

### Stock

- Immutable movement ledger.
- Available vs reserved stock.
- Warehouse-to-warehouse transfers.
- Stock reservations.
- Stock integrity/concurrency.

### Invoices

- Invoice/document upload.
- S3 storage.
- Human review.
- Supplier/date/items/warehouse information.
- Product resolution.
- Approval/rejection.
- Rejection reason.
- Creation of incoming transaction.

### Orders

```
Purchase/incoming flow
PENDING → COMPLETED/CANCELLED

Customer/outgoing flow
PENDING → COMPLETED/CANCELLED

Transfers
PENDING → COMPLETED/CANCELLED
```

### Insights

- Dead stock.
- Stockout risk.
- Consumption anomalies.

### Analytics

- Product performance.
- Sales trends.
- Purchase trends.
- Warehouse demand.
- Product demand.
- Supplier comparison.

---

## 23. New Backend Engineering Features

These were added/refined during the architecture review and should remain in the implementation:

- JWT authentication.
- Role-based authorization.
- DTO validation.
- Structured error handling.
- Historical-record deletion protection.
- Supplier statistics.
- Supplier comparison.
- Warehouse capacity calculation.
- Null-safe `maxCapacity`.
- Reorder thresholds.
- Upcoming deliveries.
- Overdue transactions.
- Pending transaction editing.
- Reservation synchronization.
- Atomic stock operations.
- Conditional status transitions.
- PostgreSQL row locking.
- Deterministic (warehouseId, productId) lock ordering.
- Same-warehouse transfer protection.
- Transfer reservations.
- Manual product resolution.
- `rejectionReason`.
- S3 abstraction.
- Pagination/filtering.
- Clean API contracts.

These are backend features, not AI features.

---

## 24. NestJS Functions AgentCore Can Eventually Consume

The AI engineer should build tools around these existing backend capabilities.

### Inventory

```
getByWarehouse()
getByProduct()
getAvailable()
getLowStockProducts()
getWarehouseCapacity()
```

### Stock history

```
getLedger()
```

### Transactions

```
findAll()
findOne()
getUpcomingDeliveries()
getOverdueTransactions()
```

### Insights

```
getDeadStock()
getStockoutRisk()
getConsumptionAnomalies()
```

### Analytics

```
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

### Suppliers

```
getSupplierStats()
compareSuppliers()
```

### AI-supporting backend extensions

```
rankSuppliers()
getBestSupplier()
getRestockRecommendations()
getTransferRecommendations()
findBestWarehouseForOrder()
```

---

## 25. What AgentCore Must NOT Do

AgentCore must not directly call or reproduce:

```
create()
update()
remove()

reserve()
release()
fulfill()

recordMovement()

createIncoming()
createOutgoing()
createTransfer()

complete()
cancel()

approve()
reject()
```

Especially:

```
AgentCore → PostgreSQL              ❌
AgentCore → Prisma                  ❌
AgentCore → modify onHand           ❌
AgentCore → complete transaction    ❌
AgentCore → cancel transaction      ❌
AgentCore → raw SQL                 ❌
```

For the current MVP:

```
AgentCore = READ + ANALYZE + RECOMMEND
NestJS    = READ + WRITE + ENFORCE
```

---

## 26. AI Layer — Separate From NestJS

The AI engineer owns:

```
ai-agent/
├── agent/
├── tools/
├── services/
├── prompts/
└── main.py
```

### MVP

Use:

```
Single AgentCore
      ↓
Read-only tools
      ↓
NestJS API
```

The older architecture containing:

```
Supervisor Agent
Inventory Agent
Risk Agent
Procurement Agent
Invoice Agent
Fulfillment Agent
```

is future scope and should not drive the current NestJS implementation.

---

## 27. AI-Specific Features

These are not part of your core NestJS implementation.

### AI invoice extraction

```
runExtraction()
```

AI extracts:

- supplier;
- invoice date;
- product names;
- quantities;
- prices;
- warehouse/delivery information.

NestJS then validates and persists the confirmed result.

### Fuzzy product matching

AI may suggest:

```
Invoice name
↓
possible Product
↓
similarity score
↓
human confirmation
```

Final product ID selection remains controlled by the backend/reviewer.

### Natural-language inventory queries

AgentCore handles:

```
"What products are low?"
"Where is Product X?"
"Which supplier is better?"
"Which deliveries are late?"
```

and calls the appropriate NestJS tools.

### Recommendations

AgentCore can combine backend results to produce:

- supplier recommendations;
- restock recommendations;
- transfer recommendations;
- inventory explanations.

### Email / Calendar automation

Later:

```
AgentCore
↓
decision
↓
NestJS integration service
↓
Email / Calendar
```

---

## 28. Final Ownership Matrix

| Responsibility | NestJS | AgentCore |
| --- | --- | --- |
| PostgreSQL | ✅ | ❌ |
| Prisma | ✅ | ❌ |
| Database writes | ✅ | ❌ |
| Inventory calculations | ✅ | ❌ |
| Stock movements | ✅ | ❌ |
| Reservations | ✅ | ❌ |
| Transactions | ✅ | ❌ |
| Authorization | ✅ | ❌ |
| S3 storage | ✅ | ❌ |
| Document review | ✅ | ❌ |
| Analytics calculations | ✅ | ❌ |
| Supplier statistics | ✅ | ❌ |
| Stockout calculations | ✅ | ❌ |
| Natural-language understanding | ❌ | ✅ |
| Tool selection | ❌ | ✅ |
| Combining backend results | ❌ | ✅ |
| Explanation | ❌ | ✅ |
| AI invoice extraction | ❌ | ✅ |
| AI recommendations | ❌ | ✅ |
| AI tool adapters | ❌ | ✅ |
| Email/Calendar API | ✅ | Decides/requests |
| Direct SQL | ❌ | ❌ |

---

## 29. Final MVP Boundary

### 🟢 Build now — NestJS Core

- Auth
- Users
- Products
- Warehouses
- Suppliers
- Warehouse Inventory
- Stock Movements
- Reservations
- Inventory Transactions
- Document Review
- S3
- Stock Insights
- Analytics
- Concurrency/Safety
- Validation
- Authorization
- Error Handling

### 🟡 Build after core if time allows

- `rankSuppliers()`
- `getBestSupplier()`
- `findBestWarehouseForOrder()`
- `getRestockRecommendations()`
- `getTransferRecommendations()`
- EmailService
- CalendarService

These are deterministic backend capabilities or integrations that primarily support the later AI layer.

### 🔵 AI engineer

- AgentCore
- AI tools
- Natural-language queries
- AI invoice extraction
- Fuzzy matching
- Recommendations
- AI explanations
- Email/calendar decisions

### 🔴 Future — not MVP

- Supervisor / multi-agent architecture
- Forecasting models
- Pick-path optimization
- Advanced AI memory
- AI write actions

---

## 30. Final Rule

The project should be able to run as a complete ERP with the AI service completely turned off.

```
                 CORE ERP
                    │
       ┌────────────┴────────────┐
       ↓                         ↓
    PostgreSQL                  S3
       ↑                         ↑
       └──────── NestJS ─────────┘
                    │
              REST/API layer
                    │
                    ↓
             AgentCore (later)
                    │
          Read-only AI tools
                    │
                    ↓
          Natural-language UX
```

This is the version I would use as the team's baseline. It combines the GitHub scope agreement with the NestJS implementation plan without letting the older multi-agent AI architecture expand the current backend scope. The GitHub document's strongest parts — ownership, deterministic calculations, protected writes, concurrency, and explicit AI/backend contracts — are retained.
