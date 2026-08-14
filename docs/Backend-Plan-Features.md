# Mini ERP — Backend Architecture & Implementation Plan

# 1. Core Modules

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

Any operation that writes to multiple related tables must be atomic so partial updates cannot occur.

This includes:

- transaction + transaction items
- transaction + reservations
- stock movement + warehouse inventory update
- document approval + transaction creation
- new product creation during document approval
- transaction completion
- transaction cancellation where reservations are involved

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

This prevents two simultaneous requests from both seeing the same available stock and reserving/using it.

### Lock ordering

Whenever multiple inventory rows are locked, sort them by **warehouseId + productId** together — not productId alone. A single product can have multiple `WarehouseInventory` rows (one per warehouse), so productId alone doesn't produce a unique, consistent lock order across warehouses. Ordering by both fields guarantees any two concurrent operations touching overlapping rows always acquire locks in the same order, preventing deadlocks.

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

JWT authentication. Passwords are hashed before storage.

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
EMPLOYEE
```

There is no MANAGER role — this was evaluated and dropped since no permission in this system genuinely required a tier between EMPLOYEE and ADMIN.

### Permissions

- **ADMIN:** full administrative access, including user management, document approval/rejection, transaction completion/cancellation, sensitive deletes where allowed, and normal ERP entity management
- **EMPLOYEE:** normal operational/read access, including viewing inventory/products/warehouses/suppliers, creating pending transactions, uploading documents, and using normal ERP functionality — no approval, completion, cancellation, or deletion rights

Guards enforce permissions based on `User.role`. Deletion of historical entities is ADMIN-only.

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

`getCatalog()` returns the products/inventory associated with a warehouse.

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
rankSuppliers()
getBestSupplier()
getSupplierStats()
compareSuppliers()
```

Supplier statistics are calculated dynamically by NestJS from historical INCOMING transactions/items — never stored as a permanent score:

- average price
- on-time %
- late %
- cancellation rate
- purchase frequency
- supplied products
- last purchase date

AgentCore only explains/recommends from these values; it does not calculate them.

## rankSuppliers()

Ranks suppliers dynamically using historical INCOMING transaction data.

Possible ranking inputs:

- average product price
- on-time percentage
- late percentage
- cancellation rate
- purchase frequency
- products supplied
- last purchase date

The backend calculates the ranking deterministically.

No permanent supplier score is stored in the database.

## getBestSupplier()

Returns the best supplier for a requested product or restocking need.

Possible inputs:

- productId
- required quantity
- preferred delivery date

Flow:

```
get candidate suppliers
↓
calculate supplier statistics
↓
rank suppliers
↓
return the best matching supplier
```

The result can later be interpreted by AgentCore when generating a purchase recommendation.

---

# 7. Warehouse Inventory

```
getByWarehouse()
getByProduct()
getAvailable()
getLowStockProducts()
getWarehouseCapacity()
setReorderThreshold()
findBestWarehouseForOrder()
```

Available stock:

```
available = onHand - SUM(ACTIVE reservations)
```

`onHand` is changed only through stock movement operations — never directly through this module.

### Capacity

```
usedCapacity = SUM(onHand)
utilization = usedCapacity / maxCapacity
```

If `maxCapacity = null`, return capacity/utilization as **not configured**.

Capacity is **informational**, not a hard limit.

### findBestWarehouseForOrder()

Used for customer OUTGOING orders, to automatically route the order to the closest warehouse that can fulfill it.

Inputs:

- deliveryCountry
- deliveryRegion
- required products/quantities

Flow:

```
Get warehouses
↓
Check available stock
↓
Eliminate warehouses that cannot fulfill the order
↓
Compare remaining warehouse locations with the customer delivery location
↓
Return/recommend the closest suitable warehouse
```

Geographic distance can later use a geocoding/distance API; for now, matching is based on `deliveryCountry`/`deliveryRegion` against `Warehouse.location`. The selected warehouse becomes the outgoing transaction's `sourceWarehouseId`.

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

`getLedger()` is read-only, filterable by product, warehouse, transaction, movement type, and date.

Movement types:

```
INCOMING
OUTGOING
TRANSFER_IN
TRANSFER_OUT
ADJUSTMENT
```

---

# 9. Reservations

Reservations are used for stock that is promised but has not physically left the warehouse yet.

Used for:

- OUTGOING transactions
- TRANSFER transactions at the source warehouse

Not used for INCOMING.

Functions:

```
reserve()
release()
fulfill()
```

Before creating/updating a reservation:

1. Lock affected inventory rows.
2. Calculate available stock.
3. Verify quantity.
4. Create/update reservation.

For multiple products, lock rows in sorted `warehouseId + productId` order.

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

`deliveryCountry` and `deliveryRegion` on `InventoryTransaction` represent where an OUTGOING customer order is going. `sourceWarehouseId` represents which warehouse fulfills it.

---

## Create Incoming

```
createIncoming()
```

Creates:

```
type = INCOMING
status = PENDING
supplierId required
destinationWarehouseId required
partyName = null
```

Also creates transaction items. No reservation. No stock change until the incoming transaction is completed.

---

## Create Outgoing

```
createOutgoing()
```

Typical data: `partyName` (customer), `deliveryCountry`, `deliveryRegion`, `sourceWarehouseId`, items, `expectedDate`.

If warehouse routing is automatic:

```
deliveryCountry + deliveryRegion
↓
findBestWarehouseForOrder()
↓
sourceWarehouseId
```

Flow:

```
Validate
↓
Lock inventory rows
↓
Check available stock
↓
Create PENDING OUTGOING transaction/items
↓
Create ACTIVE reservations
↓
COMMIT
```

Everything is atomic. No physical stock movement happens when the outgoing transaction is created.

---

## Create Transfer

```
createTransfer()
```

Validation:

```
sourceWarehouseId !== destinationWarehouseId
```

Flow:

```
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
COMMIT
```

The stock is NOT physically moved when the transfer is created. The reservation only prevents the source stock from being used elsewhere while the transfer is pending. Everything is atomic.

---

# 11. Update Transaction

```
update()
```

Only `PENDING` transactions can be edited.

### OUTGOING

If quantity changes:

```
quantity increases
→ verify additional availability
→ increase reservation
```

```
quantity decreases
→ release reservation difference
```

If product changes:

```
release old reservation
→ validate new product
→ reserve new product
```

If source warehouse changes:

```
release old reservation
→ verify availability in new warehouse
→ create new reservation
```

### TRANSFER

Because pending transfers also reserve source stock, reservation synchronization is required when a transfer is edited.

If quantity changes:

```
quantity increases
→ verify additional source availability
→ increase reservation
```

```
quantity decreases
→ release reservation difference
```

If source warehouse changes:

```
release old source reservation
→ verify availability in new source warehouse
→ create new reservation
```

If destination warehouse changes:

```
validate destination != source
→ update destination
```

All transaction/item/reservation changes are atomic.

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
Set actualDate
↓
Transaction = COMPLETED
↓
COMMIT
```

This is the point where incoming goods physically become part of warehouse inventory.

---

## OUTGOING

```
Claim transaction
↓
Lock inventory rows
↓
Validate ACTIVE reservation
↓
Re-check source stock
↓
Create OUTGOING movement
↓
Decrease onHand
↓
Fulfill reservation
↓
Set actualDate
↓
Transaction = COMPLETED
↓
COMMIT
```

## TRANSFER

```
Claim transaction
↓
Lock source/destination inventory rows
↓
Validate ACTIVE source reservations
↓
Re-check source stock
```

If reservation is invalid or source stock is insufficient:

```
409 Conflict
Transaction remains PENDING
No movement created
Reservation remains ACTIVE
ROLLBACK
```

If sufficient:

```
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
Set actualDate
↓
Transaction = COMPLETED
↓
COMMIT
```

Source and destination inventory rows are locked in deterministic (`warehouseId + productId`) order. The physical stock movement happens only when the transfer is completed, not when it is created. Everything is atomic — if any step fails, the entire operation is rolled back.

---

# 13. Cancel Transaction

Only `PENDING` transactions can be cancelled. Use the same conditional state-transition protection.

### OUTGOING

```
Claim PENDING transaction
↓
Release source reservation
↓
Transaction = CANCELLED
↓
COMMIT
```

No stock movement.

### INCOMING

```
Claim PENDING transaction
↓
Transaction = CANCELLED
↓
COMMIT
```

No stock movement.

### TRANSFER

```
Claim PENDING transaction
↓
Release source reservation
↓
Transaction = CANCELLED
↓
COMMIT
```

No stock movement because the transfer has not physically happened yet. Everything is atomic.

---

# 14. Reads

```
findAll(filters)
findOne(id)
getUpcomingDeliveries()
getOverdueTransactions()
```

Examples:

```
upcoming:
PENDING + expectedDate in future

overdue:
PENDING + expectedDate < now
```

These read purely from `InventoryTransaction` state — no AI involved — and feed the shipment calendar reminder feature directly.

---

# 15. Document Review

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
Warehouse Confirmation
↓
Approve / Reject
```

### Upload

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

Upload flow:

```
Browser uploads invoice
↓
NestJS validates file
↓
Upload to S3
↓
Store document URL/reference
↓
Create PendingDocumentReview
↓
Run AI extraction
```

### Duplicate Documents

Use a document hash where practical to detect accidental duplicate uploads.

For the capstone, duplicate detection is a reliability feature and must not require a new database field. If the finalized schema cannot persist a hash cleanly, document the limitation rather than changing the DB.

---

# 16. AI Extraction

Extract:

- transaction type
- supplier/customer
- date
- destination warehouse from invoice when available
- delivery country
- delivery region
- products
- quantities
- prices
- invoice information

Staging fields on `PendingDocumentReview`:

```
extractedPartyName
extractedSupplierName
extractedDate
extractedWarehouseName
extractedDeliveryCountry
extractedDeliveryRegion
extractedItems
```

Extraction is provisional until human review. The extracted warehouse should be matched against existing ERP warehouses. The reviewer confirms or corrects the warehouse before approval. If the invoice does not contain a usable warehouse, the reviewer manually selects one.

### Extraction failure

No new DB status is required.

If extraction fails or times out:

```
status = REJECTED
rejectionReason = "System extraction failed: <reason>"
```

This prevents a failed document from remaining indefinitely as `PENDING_REVIEW`.

---

# 17. Product Matching

Order:

```
Exact match
↓
Fuzzy suggestion
↓
Human confirmation
```

Fuzzy matching must use a predefined/tested similarity threshold. Ambiguous matches require human selection. No product can remain unresolved when approval is submitted. The LLM/AI can suggest matches, but the final product mapping is confirmed before database changes are made.

---

# 18. New Product During Approval

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

# 19. Document Approval

Approval means the human has reviewed and accepted the AI-extracted invoice information.

Approval does **NOT** mean the products have physically arrived.

Therefore, approving a supplier invoice creates a **PENDING INCOMING transaction**.

Flow:

```
Validate review = PENDING_REVIEW
↓
Confirm/match destination warehouse
↓
Resolve supplier
↓
Resolve all products
↓
Create new products if required
↓
Create INCOMING transaction
↓
Transaction = PENDING
↓
Create transaction items
↓
Document = APPROVED
↓
Set reviewedById / reviewedAt
↓
Link transactionId
↓
COMMIT
```

No `StockMovement` is created during invoice approval. `WarehouseInventory.onHand` does NOT change during approval.

Later, when the products physically arrive:

```
complete(transactionId)
```

is called. That completion then:

```
Create INCOMING StockMovements
↓
Increase WarehouseInventory.onHand
↓
Set actualDate
↓
Transaction = COMPLETED
```

Everything affecting multiple records is atomic. If anything fails: ROLLBACK.

### OUTGOING Customer Document Approval

For an OUTGOING customer document, approval follows the same human-review principle but creates a pending outgoing transaction:

```
Resolve customer + delivery location
↓
Determine/confirm suitable source warehouse
↓
Create PENDING OUTGOING transaction
↓
Create transaction items
↓
Create ACTIVE source reservations
↓
Document = APPROVED
↓
COMMIT
```

If automatic warehouse routing is used, `findBestWarehouseForOrder()` chooses the closest suitable warehouse that has enough available stock. Approval still does not physically remove stock — physical stock decreases later through `complete(transactionId)`.

---

# 20. Invoice Warehouse

The AI attempts to extract the destination warehouse from the invoice.

During review, the extracted warehouse is matched against an existing ERP Warehouse. The reviewer confirms or corrects the warehouse before approving the document. If no usable warehouse can be determined from the invoice, the reviewer selects one manually.

Conceptually:

```
approve(
  reviewId,
  warehouseId,
  correctedItems,
  reviewerId
)
```

The final confirmed `warehouseId` becomes the `destinationWarehouseId` of the resulting PENDING INCOMING transaction. No additional warehouse field is required on `InventoryTransaction` because `destinationWarehouseId` already exists.

---

# 21. Document Rejection

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

Already approved/rejected documents cannot be processed again. A rejected invoice does not create an inventory transaction and does not modify stock. The uploaded S3 document may remain stored for audit/history purposes.

---

# 22. Stock Insights

```
getDeadStock()
getStockoutRisk()
getConsumptionAnomalies()
getRestockRecommendations()
getTransferRecommendations()
```

### Dead Stock

Products with no relevant movement during a configured period, for example 60 days.

### Stockout Risk

Can use:

- available stock
- historical consumption rate
- pending incoming quantities
- expected delivery dates
- reorder threshold

NestJS calculates the numbers. The LLM does not calculate stockout risk itself.

### Consumption Anomalies

Compare recent consumption against historical behavior and flag unusual spikes or drops. Deterministic calculations remain in NestJS.

### getRestockRecommendations()

Generates deterministic restocking recommendations for products that are low in stock or at risk of stocking out.

Can use:

- onHand
- ACTIVE reservations
- available stock
- reorderThreshold
- historical consumption rate
- stockout risk
- pending INCOMING quantities
- expected incoming dates
- supplier history

Flow:

```
calculate current available stock
↓
calculate recent/historical consumption
↓
check pending incoming stock
↓
calculate stockout risk
↓
determine whether restocking is needed
↓
estimate recommended reorder quantity
↓
optionally call getBestSupplier()
```

The backend calculates the recommendation inputs and quantities.

AgentCore can explain the recommendation and decide whether it should be emailed.

### getTransferRecommendations()

Detects when stock should be moved between warehouses instead of purchasing new stock.

Can use:

- available stock by warehouse
- reorderThreshold
- warehouse demand
- recent consumption
- stockout risk
- excess stock in other warehouses

Flow:

```
identify warehouse with shortage/risk
↓
check same product in other warehouses
↓
eliminate warehouses without sufficient excess stock
↓
compare available quantities and locations
↓
recommend source warehouse
↓
recommend destination warehouse
↓
recommend transfer quantity
```

This function only recommends a transfer. It does not create or complete an `InventoryTransaction` automatically.

---

# 23. Analytics

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

All deterministic calculations remain in NestJS. AgentCore can interpret and explain the calculated results.

Example:

```
NestJS: "Product X sales increased 32%"

Agent: "Product X is showing strong recent demand and may require earlier restocking."
```

---

# 24. Email / Calendar

### Email

```
EmailService
```

Agent decides **what** should be sent. EmailService decides **how** to send it.

Example:

```
Backend calculations
↓
Agent determines restocking recommendation
↓
Agent decides recommendation should be sent
↓
EmailService sends email
```

Email code remains separate from agent reasoning.

### Calendar

```
CalendarService
```

Handles external calendar API communication.

For shipment reminders:

```
Transaction expectedDate
↓
Reminder logic
↓
CalendarService
↓
External calendar API
```

The integration implementation is separate from the business/agent logic.

---

# 25. AgentCore

NestJS communicates with the Python AgentCore service.

AgentCore can use controlled read/analysis tools such as:

```
get_inventory
get_available_stock
get_low_stock_products

get_transactions
get_upcoming_deliveries
get_stock_history
get_stockout_risk

get_restock_recommendations
get_transfer_recommendations

get_supplier_stats
compare_suppliers
rank_suppliers
get_best_supplier

get_sales_trends
get_top_selling_products
get_lowest_selling_products

find_best_warehouse
```

Tool definitions call controlled backend functionality rather than giving the agent unrestricted database access.

AgentCore cannot:

- run raw SQL
- directly modify stock
- complete/cancel transactions
- delete records

Deterministic calculations remain in NestJS. The agent handles:

- natural-language understanding
- deciding which tools to call
- combining tool results
- explaining results
- recommendations
- deciding when appropriate integrations such as email should be invoked

Write tools can be added later, after permissions and human-confirmation flows are explicitly defined.

---

# 26. AWS Architecture

The application is built **once**, then deployed locally and on AWS using environment-specific configuration.

```
LOCAL

React
↓
NestJS
↓
Prisma
↓
PostgreSQL

NestJS
├── S3
└── Python AgentCore
```

AWS:

```
Internet
↓
Frontend
↓
ALB / API entry
↓
NestJS on ECS Fargate
↓
Prisma
↓
RDS PostgreSQL

NestJS
├── S3
└── AgentCore
```

Expected AWS services:

```
PostgreSQL → RDS
Documents → S3
NestJS → ECS/Fargate
Backend image → ECR
AgentCore → AWS deployment
Frontend → AWS hosting
Email → SES/provider
Calendar → External API
```

RDS should remain private. The backend can also run in private subnets. Backend → RDS communication occurs privately inside the VPC. RDS security group should allow PostgreSQL port `5432` from the backend/Fargate security group.

The backend does not need internet access merely to communicate with RDS. NAT Gateway or appropriate VPC endpoints are required only where private resources need outbound access to external/AWS services.

No second backend implementation is created for AWS.

---

# 27. Configuration

Use environment variables:

```
DATABASE_URL
JWT_SECRET
AWS_REGION
S3_BUCKET
AGENTCORE_URL
```

Additional integration-specific secrets/configuration can also be environment variables or stored in an appropriate secret-management service. Never hardcode credentials, URLs, or AWS resources.

### DATABASE_URL

The same backend code works against different PostgreSQL environments by changing `DATABASE_URL`.

Local PostgreSQL:

```
postgresql://...@localhost:5432/mini_erp
```

Docker Compose:

```
postgresql://...@postgres:5432/mini_erp
```

AWS:

```
postgresql://...@<RDS-ENDPOINT>:5432/mini_erp
```

`DATABASE_URL` is used both by Prisma migrations and NestJS/Prisma runtime database access.

---

# 28. Local Docker / Testing

After the backend is implemented:

```
Create backend Dockerfile
↓
Create docker-compose.yml
↓
Backend container + PostgreSQL container
↓
Run Prisma migrations
↓
Seed test database
↓
Test endpoints using Postman
```

The seed should contain enough realistic data to test:

- users/roles (ADMIN + EMPLOYEE)
- warehouses
- products
- suppliers
- warehouse inventory
- historical incoming transactions
- historical outgoing transactions
- transfers
- stock movements
- reservations
- supplier statistics
- stock insights
- analytics

The goal is to verify business logic before AWS deployment.

---

# 29. AWS Deployment Flow

After local testing succeeds:

```
Create/configure VPC
↓
Private subnets
↓
Create RDS PostgreSQL
↓
Configure security groups
↓
Set production DATABASE_URL
↓
Run Prisma migrations against RDS
↓
Build backend Docker image
↓
Push image to ECR
↓
Deploy NestJS on ECS Fargate
↓
Connect Fargate → RDS privately
↓
Configure S3 / AgentCore / integrations
↓
Expose backend through appropriate API/ALB architecture
↓
End-to-end production testing
```

RDS replaces the local PostgreSQL container in production. The application does not deploy a PostgreSQL Docker container to RDS.

---

# 30. Build Order

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
16. AgentCore integration
17. Docker / local full-system testing
18. AWS Infrastructure
19. Deployment & production testing
```

---

# 31. Final Rules

### 🔒 Roles

ADMIN / EMPLOYEE only. There is no MANAGER role.

### 🔒 Database

**Frozen. No further DB changes currently required.**

### 🔒 Stock

Only stock movement logic changes `onHand`.

### 🔒 Available Stock

```
available = onHand - ACTIVE reservations
```

### 🔒 Reservations

Both OUTGOING and TRANSFER reserve stock at their source warehouse while PENDING.

### 🔒 Incoming

Creating a PENDING incoming transaction does not change stock. Stock increases only on `complete()`.

### 🔒 Outgoing

Creating a PENDING outgoing transaction reserves stock. Physical stock decreases only on `complete()`.

### 🔒 Transfers

Creating a transfer does NOT physically move stock. A PENDING transfer creates ACTIVE source reservations.

Physical TRANSFER_OUT + TRANSFER_IN movements happen only on completion. Cancellation releases source reservations without changing `onHand`.

### 🔒 Invoice Approval

Approving a supplier invoice means: AI extraction accepted + products resolved + warehouse confirmed + PENDING INCOMING transaction created.

It does **NOT** mean goods have physically arrived. Therefore: APPROVE INVOICE ≠ CHANGE STOCK. Later: COMPLETE INCOMING = CHANGE STOCK.

### 🔒 Invoice Warehouse

AI attempts to extract the destination warehouse from the invoice. The reviewer confirms/corrects the match. If unavailable, the reviewer selects the warehouse manually. The confirmed warehouse becomes the incoming transaction's `destinationWarehouseId`.

### 🔒 Customer Destination

For OUTGOING customer orders, `deliveryCountry` + `deliveryRegion` represent where the customer order is going.

### 🔒 Order Source

`sourceWarehouseId` represents the warehouse that fulfills the outgoing order.

### 🔒 Warehouse Routing

Automatic warehouse selection uses available stock + customer delivery location through `findBestWarehouseForOrder()` to recommend the closest suitable warehouse that can fulfill the order.

### 🔒 Concurrency

Use conditional UPDATE + `SELECT ... FOR UPDATE` + Prisma `$transaction()` where appropriate.

### 🔒 Multiple Inventory Rows

Always lock inventory rows in deterministic `warehouseId + productId` order.

### 🔒 Atomicity

Related writes either all succeed or all fail. Never allow partial reservations, movements, transaction items, inventory changes, or document approvals.

### 🔒 New Invoice Products

Invoice review supports EXISTING or CREATE. New products are created atomically as part of approval when necessary.

### 🔒 AI

AI is not the source of truth for inventory calculations. NestJS computes deterministic values. AgentCore interprets, reasons, recommends, and orchestrates controlled tools.

### 🔒 AWS

Same backend code locally and in production. Environment/configuration changes, not business logic.
