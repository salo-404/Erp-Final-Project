# Mini ERP — Backend Architecture & Implementation Plan

## 1. Core Modules

```
auth/
users/
products/
warehouses/
suppliers/
warehouse-inventory/
stock-movements/
reservations/
inventory-transactions/
document-review/
stock-insights/
analytics/
integrations/
agent-core/
```

Shared:

```
prisma/
common/
```

---

# 2. Global Rules

### Database

**Schema is finalized. No DB changes required.**

`PendingDocumentReview.rejectionReason String?` has already been added.

### API

Controllers remain thin.

```
Controller → DTO → Service → Prisma
```

### Business Logic

All business rules belong in services.

### Atomicity

Use Prisma `$transaction()` for operations affecting multiple records.

### Concurrency

`$transaction()` alone is not considered sufficient.

For state transitions, use conditional updates:

```
WHERE id = X AND status = PENDING
```

and check the affected row count.

For inventory rows that can be concurrently modified, use:

```
SELECT ... FOR UPDATE
```

through Prisma `$queryRaw` inside an interactive `$transaction()`.

### Lock ordering

Whenever multiple inventory rows are locked, sort them by a stable key such as `productId` before acquiring locks.

This applies to:

- outgoing orders
- transfers
- reservations
- any multi-product stock operation

### AI

NestJS calculates deterministic facts.

AgentCore interprets those facts.

AgentCore cannot:

- execute raw SQL
- directly modify inventory
- complete/cancel transactions
- delete records

---

# 3. Auth / Users

### AuthService

```
validateUser()
login()
```

JWT authentication.

### UsersService

```
create()
findAll()
findOne()
update()
remove()
```

Roles:

```
ADMIN
MANAGER
EMPLOYEE
```

### Permissions

- **ADMIN:** full access
- **MANAGER:** operational management, transaction completion/cancellation, document approval
- **EMPLOYEE:** normal operational/read access, but no approval, completion, cancellation, or deletion

Deletion of historical entities is ADMIN-only.

---

# 4. Products

```
create()
update()
remove()
findAll()
findOne()
```

Products do not directly modify stock.

### Delete

If historical records exist, `remove()` returns a clear `409 Conflict` instead of exposing a raw Prisma foreign-key error.

No historical records are deleted.

---

# 5. Warehouses

```
create()
update()
remove()
findAll()
findOne()
getCatalog()
```

Warehouse capacity calculation belongs to `WarehouseInventoryService` to avoid duplicate implementations.

### Delete

Same historical-data rule as Products.

---

# 6. Suppliers

```
create()
update()
remove()
findAll()
findOne()
getTransactionHistory()
getSupplierStats()
compareSuppliers()
```

Supplier statistics are calculated by NestJS:

- average price
- on-time %
- cancellation rate
- purchase frequency
- supplied products

AgentCore only explains/recommends from these values.

---

# 7. Warehouse Inventory

```
getByWarehouse()
getByProduct()
getAvailable()
getLowStockProducts()
getWarehouseCapacity()
setReorderThreshold()
```

Available stock:

```
available = onHand - active reservations
```

`onHand` is changed only through stock movement operations.

### Capacity

```
usedCapacity / maxCapacity
```

If `maxCapacity = null`, return capacity/utilization as not configured.

Capacity is **informational**, not a hard limit.

---

# 8. Stock Movements

Immutable inventory ledger.

```
recordMovement()
getLedger()
```

A movement must update:

```
StockMovement
+
WarehouseInventory.onHand
```

atomically.

No normal endpoint should directly modify `onHand`.

---

# 9. Reservations

Reservations are used for stock that is promised but has not physically left the warehouse yet.

Used for:

- OUTGOING transactions
- TRANSFER transactions at the source warehouse

Functions:

reserve()
release()
fulfill()

Before creating/updating a reservation:

1. Lock affected inventory rows.
2. Calculate available stock.
3. Verify quantity.
4. Create/update reservation.

For multiple products, lock rows in sorted `productId` order.

### OUTGOING

When a PENDING OUTGOING transaction is created, reserve the required stock in its source warehouse.

### TRANSFER

When a PENDING TRANSFER transaction is created, reserve the required stock in the source warehouse.

This prevents the same stock from being sold or included in another transfer before the transfer is completed.

On completion:

- OUTGOING reservation → FULFILLED
- TRANSFER reservation → FULFILLED

On cancellation:

- reservation → CANCELLED / released

---

# 10. Inventory Transactions

Transaction types:

```
INCOMING
OUTGOING
TRANSFER
```

Statuses:

```
PENDING
COMPLETED
CANCELLED
```

No `CONFIRMED` status.

---

## Create Incoming

```
createIncoming()
```

Creates:

```
INCOMING
PENDING
```

No stock change until the incoming transaction is completed.

---

## Create Outgoing

```
createOutgoing()
```

Flow:

```
Validate
↓
Lock inventory rows
↓
Check available stock
↓
Create transaction/items
↓
Create reservations
↓
Commit
```

Everything is atomic.

---

## Create Transfer

createTransfer()

Validation:

sourceWarehouseId !== destinationWarehouseId

Flow:

Validate
↓
Lock source inventory rows
↓
Check available stock
↓
Create PENDING TRANSFER transaction/items
↓
Create ACTIVE reservations at source warehouse
↓
Commit

The stock is NOT physically moved when the transfer is created.

The reservation only prevents the source stock from being used elsewhere while the transfer is pending.

Everything is atomic.

---

# 11. Update Transaction

```
update()
```

Only `PENDING` transactions can be edited.

For OUTGOING transactions:

- quantity increases → verify additional availability and increase reservation
- quantity decreases → release reservation difference
- warehouse changes → release old reservation and create new one after availability check

All changes are atomic.

---

# 12. Complete Transaction

```
complete()
```

### State protection

Claim the transaction using:

```
UPDATE ...
WHERE id = X
AND status = PENDING
```

If affected rows = `0`:

```
409 Conflict
```

This prevents two users from completing the same transaction.

---

## INCOMING

```
Claim transaction
↓
Lock inventory rows
↓
Create INCOMING movement
↓
Increase onHand
↓
COMMIT
```

---

## OUTGOING

```
Claim transaction
↓
Lock inventory rows
↓
Validate reservation/availability
↓
Create OUTGOING movement
↓
Decrease onHand
↓
Fulfill reservation
↓
COMMIT
```

---

## TRANSFER

Claim transaction
↓
Lock source/destination inventory rows
↓
Validate ACTIVE source reservations
↓
Re-check source stock

If reservation is invalid or source stock is insufficient:

409 Conflict
Transaction remains PENDING
No movement created
Reservation remains ACTIVE
ROLLBACK

If sufficient:

Create TRANSFER_OUT
↓
Decrease source onHand
↓
Create TRANSFER_IN
↓
Increase destination onHand
↓
Fulfill source reservation
↓
Transaction = COMPLETED
↓
COMMIT

Source and destination inventory rows are locked in deterministic order.

The physical stock movement happens only when the transfer is completed, not when it is created.

Everything is atomic. If any step fails, the entire operation is rolled back.

---

# 13. Cancel Transaction

Only `PENDING` transactions can be cancelled.

Use the same conditional state-transition protection.

### OUTGOING

```
Release reservation
↓
CANCELLED
```

No stock movement.

### INCOMING

```
CANCELLED
```

No stock movement.

### TRANSFER

```
CANCELLED
```

No stock movement because the transfer has not happened yet.

---

# 14. Document Review

Flow:

```
Upload
↓
S3
↓
AI Extraction
↓
Human Review
↓
Product Matching
↓
Warehouse Selection
↓
Approve / Reject
```

---

## Upload

Allowed:

```
PDF
JPG
JPEG
PNG
```

Maximum:

```
10 MB
```

Invalid files are rejected before S3/AI processing.

---

## Duplicate Documents

Use a document hash where practical to detect accidental duplicate uploads.

For the capstone, duplicate detection is a reliability feature and must not require a new database field.

If the finalized schema cannot persist a hash cleanly, document the limitation rather than changing the DB.

---

# 15. AI Extraction

Extract:

- supplier
- date
- products
- quantities
- prices
- invoice information

Extraction is provisional until human review.

### Extraction failure

No new DB status is required.

If extraction fails or times out:

```
status = REJECTED
rejectionReason =
"System extraction failed: <reason>"
```

This prevents a failed document from remaining indefinitely as `PENDING_REVIEW`.

---

# 16. Product Matching

Order:

```
Exact match
↓
Fuzzy suggestion
↓
Human confirmation
```

Fuzzy matching must use a predefined/tested similarity threshold.

Ambiguous matches require human selection.

No product can remain unresolved when approval is submitted.

---

# 17. New Product During Approval

`correctedItems` must explicitly distinguish:

```
EXISTING
```

and:

```
CREATE
```

Conceptually:

```json
{
  "action": "EXISTING",
  "productId": "...",
  "quantity": 20
}
```

or:

```json
{
  "action": "CREATE",
  "newProduct": {
    "name": "...",
    "category": "..."
  },
  "quantity": 20
}
```

For `CREATE`:

```
Create Product
↓
Get productId
↓
Create transaction item
```

All inside the same database transaction.

---

# 18. Document Approval

Approval means the invoice has been reviewed **and the stock is officially received**.

Therefore approval directly completes the incoming transaction.

Flow:

```
Validate review = PENDING_REVIEW
↓
Validate warehouse
↓
Resolve all products
↓
Create new products if required
↓
Create INCOMING transaction
↓
Create transaction items
↓
Create INCOMING stock movements
↓
Increase warehouse stock
↓
Transaction = COMPLETED
↓
Document = APPROVED
↓
COMMIT
```

There is **no second manual `complete()` step** for an approved incoming invoice.

Everything is atomic.

If anything fails:

```
ROLLBACK
```

---

# 19. Invoice Warehouse

The reviewer selects the destination warehouse during approval.

Conceptually:

```
approve(
  reviewId,
  warehouseId,
  correctedItems,
  reviewerId
)
```

No `warehouseId` needs to be added to `PendingDocumentReview`.

---

# 20. Document Rejection

```
reject()
```

Only `PENDING_REVIEW` can be rejected.

Store:

```
REJECTED
reviewedById
reviewedAt
rejectionReason
```

Already approved/rejected documents cannot be processed again.

---

# 21. Stock Insights

```
getDeadStock()
getStockoutRisk()
getConsumptionAnomalies()
```

Stockout risk can use:

- available stock
- consumption rate
- pending incoming
- expected delivery

NestJS calculates the numbers.

---

# 22. Analytics

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

All deterministic calculations remain in NestJS.

---

# 23. Email / Calendar

### Email

```
EmailService
```

Agent decides **what** should be sent.

EmailService decides **how** to send it.

### Calendar

```
CalendarService
```

Handles external calendar API communication.

---

# 24. AgentCore

NestJS communicates with the Python AgentCore service.

AgentCore can use controlled read/analysis tools such as:

```
get_inventory
get_available_stock
get_low_stock_products
get_transactions
get_stock_history
get_stockout_risk
get_supplier_stats
compare_suppliers
get_sales_trends
```

AgentCore cannot:

- run raw SQL
- modify stock
- complete/cancel transactions
- delete records

---

# 25. AWS Architecture

The application is built **once**, then deployed locally and on AWS using environment-specific configuration.

```
Local:
React → NestJS → PostgreSQL → Python AgentCore

AWS:
Frontend → NestJS → RDS
                    ├── S3
                    └── AgentCore
```

Expected AWS services:

```
PostgreSQL → RDS
Documents → S3
NestJS → AWS compute
AgentCore → AWS deployment
Frontend → AWS hosting
Email → SES/provider
Calendar → External API
```

No second implementation for AWS.

---

# 26. Configuration

Use environment variables:

```
DATABASE_URL
JWT_SECRET
AWS_REGION
S3_BUCKET
AGENTCORE_URL
```

Never hardcode credentials, URLs, or AWS resources.

---

# 27. Build Order

```
1. Prisma
2. Common / Guards
3. Auth / Users
4. Products
5. Warehouses
6. Suppliers
7. Warehouse Inventory
8. Stock Movements
9. Reservations
10. Inventory Transactions
11. Document Review
12. Stock Insights
13. Analytics
14. Email
15. Calendar
16. AgentCore
17. AWS Infrastructure
18. Deployment & testing
```

---

# 28. Final Rules

### 🔒 Database

**Frozen. No further DB changes.**

### 🔒 Stock

Only stock movement logic changes `onHand`.

### 🔒 Reservations

Only OUTGOING uses reservations.

### 🔒 Transfers

No reservation; availability is rechecked under row lock during completion.

### 🔒 Concurrency

Use:

```
Conditional UPDATE
+
SELECT ... FOR UPDATE
+
Prisma $transaction()
```

### 🔒 Multiple inventory rows

Always lock in deterministic `productId` order.

### 🔒 Invoice approval

Approval **posts the incoming stock immediately** and creates a `COMPLETED` incoming transaction.

### 🔒 AI

AI is not the source of truth for inventory numbers.

### 🔒 AWS

Same backend code locally and in production.

---

## Final status

| Issue | Resolution | DB change |
| --- | --- | --- |
| AI extraction failure | `REJECTED` + `rejectionReason` | ❌ |
| New product creation | Explicit `EXISTING` / `CREATE` DTO | ❌ |
| Role permissions | Defined role matrix | ❌ |
| Concurrency | Conditional updates + row locking | ❌ |
| Transfer race | Lock + recheck at completion | ❌ |
| File validation | PDF/JPG/JPEG/PNG, max 10 MB | ❌ |
| Duplicate invoice | Hash-based protection where supported | ❌ |
| Raw SQL locking | `$queryRaw` inside interactive `$transaction()` | ❌ |
| Deadlocks | Stable productId lock ordering | ❌ |
| Invoice warehouse | Reviewer selects during approval | ❌ |
| Invoice approval | Directly posts stock + COMPLETED transaction | ❌ |
| Capacity | Informational, null-safe | ❌ |
| `rejectionReason` | Already added | ✅ |

**This is the version I would use as the coding baseline.**
