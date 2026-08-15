# Mini ERP — Backend Team Split

## 1. Final NestJS Architecture

```
backend/
└── src/
    │
    ├── auth/
    ├── users/
    ├── products/
    ├── warehouses/
    ├── suppliers/
    ├── warehouse-inventory/
    ├── stock-movements/
    ├── reservations/
    ├── inventory-transactions/
    ├── document-review/
    ├── stock-insights/
    ├── analytics/
    ├── integrations/
    │   ├── email/
    │   └── calendar/
    ├── prisma/
    └── common/
        ├── guards/
        ├── decorators/
        ├── filters/
        └── pipes/
```

There is no `src/agent-core/`. The Python AgentCore system communicates with these NestJS modules through APIs only.

---

## 2. Salman

Salman's side owns **Security + Inventory Operations + Document Workflow + Backend Intelligence**.

### `auth/`

```
AuthService
├── validateUser()
└── login()
```

Security:

```
JwtStrategy
JwtAuthGuard
RolesGuard
@Roles()
@CurrentUser()
```

Responsibilities: JWT authentication, password hashing, authentication failures, role authorization, protecting sensitive endpoints.

⭐ Presentation highlight: JWT + role-based authorization.

### `users/`

```
create()
findAll()
findOne()
update()
remove()
```

Security responsibilities also include making sure user deletion/update respects the project's authorization rules.

⭐ Presentation highlight: Role-based access control with ADMIN / EMPLOYEE.

### `suppliers/` — Supplier Intelligence

Joseph owns the supplier CRUD. Salman owns the intelligence functions.

```
getSupplierStats()
compareSuppliers()
rankSuppliers()
getBestSupplier()
```

These calculate average price, on-time rate, cancellation rate, purchase frequency, and supplier performance — especially relevant to the future Insights Agent.

⭐ Presentation highlight: deterministic supplier ranking instead of letting the LLM invent supplier scores.

### `warehouse-inventory/` — Warehouse Routing

Joseph owns the normal inventory queries. Salman owns:

```
findBestWarehouseForOrder()
```

Uses `deliveryCountry`, `deliveryRegion`, `warehouse.location`, and available stock to determine which warehouse is appropriate.

⭐ Presentation highlight: automatic warehouse selection based on location + real availability.

### `stock-movements/`

```
recordMovement()  ⭐
getLedger()
```

`recordMovement()` is particularly important — it must atomically:

```
create StockMovement
        +
update WarehouseInventory.onHand
```

using Prisma transactions.

⭐ Presentation highlight: immutable stock ledger + atomic inventory updates.

### `reservations/`

```
reserve()   ⭐
release()
fulfill()
```

Responsibilities: OUTGOING reservations, TRANSFER reservations, available-stock validation, reservation synchronization, releasing reserved stock, fulfilling reservations, row locking.

Core calculation:

```
available = onHand - active reservations
```

⭐ Presentation highlight: preventing overselling through reservations + concurrency control.

### `inventory-transactions/`

This is one of Salman's biggest modules.

```
createIncoming()   ⭐
createOutgoing()   ⭐
createTransfer()   ⭐
update()
complete()         ⭐
cancel()
findAll()
findOne()
getUpcomingDeliveries()
getOverdueTransactions()
```

`complete()` is a major demo feature. It handles:

```
INCOMING  → increase destination stock
OUTGOING  → decrease stock
TRANSFER  → decrease source, increase destination
```

using:

```
Prisma $transaction()
+
SELECT ... FOR UPDATE
+
conditional status update
+
deterministic lock ordering
```

⭐ Presentation highlight: concurrent inventory transactions without double-completion or inconsistent stock.

### `document-review/`

```
upload()   ⭐
approve()  ⭐
reject()
```

Supporting operations for the review workflow:

```
getReview()
getPendingReviews()
resolveProduct()
resolveSupplier()
```

Workflow:

```
Upload
 ↓
S3
 ↓
PendingDocumentReview
 ↓
AI / human review
 ↓
Product + supplier + warehouse resolution
 ↓
Approve
 ↓
PENDING INCOMING transaction
 ↓
Physical receipt
 ↓
complete()
 ↓
Stock increases
```

The AI extraction itself is not Salman's NestJS responsibility.

⭐ Presentation highlight: human-in-the-loop invoice processing with AI separated from authoritative ERP state.

### `stock-insights/`

This is where the newest backend intelligence lives.

```
getDeadStock()               ⭐
getStockoutRisk()            ⭐
getConsumptionAnomalies()
getRestockRecommendations()  ⭐
getTransferRecommendations() ⭐
getControlTowerAlerts()      ⭐
```

#### `getControlTowerAlerts()`

The aggregation function:

```
getLowStockProducts()
getStockoutRisk()
getOverdueTransactions()
getConsumptionAnomalies()
        ↓
getControlTowerAlerts()
```

Gives the AI a unified operational view.

⭐ Presentation highlight: Control Tower / centralized operational risk detection.

> Note: `getExpiringInventory()` — previously flagged as a possible Control Tower input requiring new expiry-tracking schema — is **not** part of this finalized list. It has been dropped rather than pursued, so Control Tower ships without it and no schema change is needed for it.

#### `getRestockRecommendations()`

Uses available stock, active reservations, consumption, pending incoming stock, expected delivery, and other-warehouse stock to decide whether to purchase, transfer, or wait for incoming.

⭐ Presentation highlight: deterministic restocking recommendation engine.

### Salman — Summary (40 functions)

```
AUTH / USERS
1.  validateUser()
2.  login()
3.  createUser()
4.  findAllUsers()
5.  findOneUser()
6.  updateUser()
7.  removeUser()

SUPPLIER INTELLIGENCE
8.  getSupplierStats()
9.  compareSuppliers()
10. rankSuppliers()
11. getBestSupplier()

WAREHOUSE ROUTING
12. findBestWarehouseForOrder()

STOCK MOVEMENTS
13. recordMovement()
14. getLedger()

RESERVATIONS
15. reserve()
16. release()
17. fulfill()

INVENTORY TRANSACTIONS
18. createIncoming()
19. createOutgoing()
20. createTransfer()
21. update()
22. complete()
23. cancel()
24. findAllTransactions()
25. findOneTransaction()
26. getUpcomingDeliveries()
27. getOverdueTransactions()

DOCUMENT REVIEW
28. upload()
29. approve()
30. reject()
31. getReview()
32. getPendingReviews()
33. resolveProduct()
34. resolveSupplier()

STOCK INSIGHTS
35. getDeadStock()
36. getStockoutRisk()
37. getConsumptionAnomalies()
38. getRestockRecommendations()
39. getTransferRecommendations()
40. getControlTowerAlerts()
```

Salman's side is 40 named functions — larger than the earlier rough 35/36 split because the document-review support functions (`getReview()`, `getPendingReviews()`, `resolveProduct()`, `resolveSupplier()`) and the Control Tower scope were added.

---

## 3. Joseph

Joseph owns **Master Data + Warehouse Inventory Queries + Analytics + Integrations**.

### `products/`

```
create()
update()
remove()
findAll()
findOne()
```

Responsibilities: product validation, CRUD, historical deletion protection, product relationships.

### `warehouses/`

```
create()
update()
remove()
findAll()
findOne()
getCatalog()
```

`Warehouse.location` is already part of the current DB design, so this module owns the warehouse entity itself.

### `suppliers/` — Supplier Management

```
create()
update()
remove()
findAll()
findOne()
getTransactionHistory()
```

Joseph owns the supplier data. Salman consumes it for `getSupplierStats()`, `rankSuppliers()`, `getBestSupplier()` — a clean dependency rather than duplicated supplier logic.

### `warehouse-inventory/`

```
getByWarehouse()
getByProduct()
getAvailable()          ⭐
getLowStockProducts()
getWarehouseCapacity()
setReorderThreshold()
```

```
getAvailable() = onHand - active reservations
```

Critical shared function — Salman's `reserve()`, `createOutgoing()`, and `createTransfer()` all depend on it being correct.

⭐ Presentation highlight: available vs. reserved stock.

### `analytics/`

```
getTopSellingProducts()    ⭐
getLowestSellingProducts()
getFastMovingProducts()
getSlowMovingProducts()
getSalesTrends()            ⭐
getPurchaseTrends()
getStockHistory()
getWarehouseDemand()        ⭐
getProductDemand()
getSupplierComparison()
```

Deterministic PostgreSQL/NestJS aggregations. The AI can consume them later through the Insights Agent.

⭐ Presentation highlight: real-time ERP analytics generated from transactional data.

### `integrations/email/`

```
sendEmail()
```

The service knows how to send the email. The AI can later decide what email should be sent.

### `integrations/calendar/`

```
createCalendarEvent()
createShipmentReminder()
```

Integration plumbing.

### Joseph — Summary (36 functions)

```
PRODUCTS
1.  createProduct()
2.  updateProduct()
3.  removeProduct()
4.  findAllProducts()
5.  findOneProduct()

WAREHOUSES
6.  createWarehouse()
7.  updateWarehouse()
8.  removeWarehouse()
9.  findAllWarehouses()
10. findOneWarehouse()
11. getCatalog()

SUPPLIERS
12. createSupplier()
13. updateSupplier()
14. removeSupplier()
15. findAllSuppliers()
16. findOneSupplier()
17. getTransactionHistory()

WAREHOUSE INVENTORY
18. getByWarehouse()
19. getByProduct()
20. getAvailable()
21. getLowStockProducts()
22. getWarehouseCapacity()
23. setReorderThreshold()

ANALYTICS
24. getTopSellingProducts()
25. getLowestSellingProducts()
26. getFastMovingProducts()
27. getSlowMovingProducts()
28. getSalesTrends()
29. getPurchaseTrends()
30. getStockHistory()
31. getWarehouseDemand()
32. getProductDemand()
33. getSupplierComparison()

INTEGRATIONS
34. sendEmail()
35. createCalendarEvent()
36. createShipmentReminder()
```

---

## 4. Shared Infrastructure

Neither developer "owns" these as independent business modules:

```
prisma/
common/
```

**Prisma** — `PrismaService`. Both developers use the same Prisma service.

**Common** — `guards/`, `decorators/`, `filters/`, `pipes/`, `interceptors/`. Salman will naturally handle most security-related pieces, but changes to shared infrastructure should be coordinated.

### How dependencies work in practice

Joseph builds:

```
WarehouseInventoryService
    ↓
getAvailable()
```

Salman needs it:

```
ReservationService
    ↓
WarehouseInventoryService.getAvailable()
```

That's a normal NestJS dependency — Salman doesn't copy the function.

Joseph:

```
SupplierService
    ↓
getTransactionHistory()
```

Salman:

```
SupplierIntelligenceService
    ↓
getTransactionHistory()
    ↓
getSupplierStats()
    ↓
rankSuppliers()
```

---

## 5. What the AI Will Consume

Once the backend is finished, the AI engineer builds Python tools around these endpoints.

### Insights Agent

```
getByProduct()
getByWarehouse()
getAvailable()
getLowStockProducts()

getDeadStock()
getStockoutRisk()
getConsumptionAnomalies()
getControlTowerAlerts()

getRestockRecommendations()
getTransferRecommendations()

getUpcomingDeliveries()
getOverdueTransactions()

getSupplierStats()
compareSuppliers()
rankSuppliers()
getBestSupplier()

findBestWarehouseForOrder()

analytics functions
```

### Document Agent

Consumes the document-review API: upload/document retrieval, product resolution, supplier resolution, approve/reject workflow.

The AI never calls Prisma directly:

```
Python Agent
     ↓
HTTP/HTTPS
     ↓
NestJS API
     ↓
Service
     ↓
Prisma
     ↓
PostgreSQL
```

---

## 6. What NOT to Create

Don't create:

```
❌ src/agent-core/
❌ src/insights-agent/
❌ src/document-agent/
❌ src/control-tower/
❌ src/supplier-intelligence/
❌ src/warehouse-routing/
```

unless the architecture later gives those concepts enough independent responsibility to justify separate modules.

For the current design:

```
Supplier Intelligence → suppliers/
Warehouse Routing     → warehouse-inventory/
Control Tower         → stock-insights/
AgentCore             → separate Python application
```

---

## 7. Presentation Highlights

If preparing a final presentation, build the story around six technical achievements:

**1. Secure ERP**

```
JWT
+
RBAC
+
ADMIN / EMPLOYEE
+
protected operations
```

**2. Concurrency-safe inventory**

```
Reservations
+
row locking
+
Prisma transactions
+
conditional state transitions
```

Probably the strongest backend engineering topic.

**3. Immutable stock ledger**

```
Transaction
      ↓
Stock Movement
      ↓
Warehouse Inventory
```

**4. Human-in-the-loop document processing**

```
Invoice
 ↓
S3
 ↓
AI extraction
 ↓
Human verification
 ↓
PENDING transaction
 ↓
Physical receipt
 ↓
Stock
```

**5. Deterministic intelligence**

```
Supplier ranking
Stockout risk
Restocking
Transfer recommendations
Warehouse selection
```

The backend calculates the facts; the AI explains them.

**6. Multi-agent AI integration**

```
Supervisor
   ├── Insights Agent
   └── Document Agent
           ↓
     NestJS APIs
           ↓
       PostgreSQL
```

Demonstrates that AI is an intelligence layer over a reliable ERP backend, rather than being allowed to directly manipulate the database.

---

## Git Workflow

Recommended:

```
main
 │
 ├── feature/salman-backend
 │
 └── feature/joseph-backend
```

Each person works on their own branch.

When Joseph finishes a module:

```
Joseph branch
     ↓
Pull Request
     ↓
review
     ↓
main
```

Same for Salman.

Do not have both of you modify the same files unnecessarily.

For shared files such as:

```
app.module.ts
prisma.service.ts
common/
package.json
docker-compose.yml
```

coordinate before editing them.

---

## Most Important Rule

Before one developer calls another developer's service, agree on the function signature and return shape.

For example:

```ts
getAvailable(
  warehouseId: string,
  productId: string
): Promise<number>
```

Then Salman can safely write:

```ts
const available =
  await this.warehouseInventoryService.getAvailable(
    warehouseId,
    productId,
  );
```

You can develop independently and integrate without rewriting each other's logic.

This split also matches the current backend/AI architecture: NestJS owns the business rules and deterministic calculations, while the multi-agent AgentCore system (Supervisor, Insights, Document — see `AI-Agent-Plan.md`) consumes controlled backend capabilities.
