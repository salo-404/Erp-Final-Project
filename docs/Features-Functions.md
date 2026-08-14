# Mini ERP — Backend Feature Checklist

This is the list to keep separately as the backend feature checklist.

---

## 🟢 A. CORE / REQUIRED — originally asked

These are the actual ERP capabilities you were expected to build.

### Authentication & Users

- JWT authentication
- User management
- Role-based access
    - ADMIN
    - EMPLOYEE

### Products

- Product CRUD
- Product catalog
- Product validation

### Warehouses

- Warehouse CRUD
- Independent warehouse catalog
- Warehouse-specific inventory

### Suppliers

- Supplier CRUD
- Supplier information
- Supplier transaction history

### Warehouse Inventory

- Stock per warehouse
- Stock per product
- Available stock
- Reserved stock
- Low-stock products
- Reorder thresholds
- Warehouse capacity

### Stock Management

- Immutable stock movement ledger
- Incoming stock
- Outgoing stock
- Warehouse-to-warehouse transfers
- Available vs reserved stock
- Stock history

### Reservations

- Reserve stock
- Release reservation
- Fulfill reservation
- Prevent overselling

### Inventory Transactions

```
INCOMING
OUTGOING
TRANSFER
```

with:

```
PENDING
COMPLETED
CANCELLED
```

Functions:

- Create incoming
- Create outgoing
- Create transfer
- Update pending transaction
- Complete transaction
- Cancel transaction
- Get transactions
- Get transaction details

### Invoices / Documents

- Upload invoice
- S3 storage
- Human review
- Supplier information
- Invoice date
- Items
- Warehouse
- Product resolution
- Approve
- Reject
- Rejection reason

### Stock Insights

- Dead stock
- Stockout risk / repeated stockout monitoring
- Consumption anomalies / spikes

### Analytics

- Top-selling products
- Lowest-selling products
- Fast-moving products
- Slow-moving products
- Sales trends
- Purchase trends
- Stock history
- Warehouse demand
- Product demand
- Supplier comparison

---

## 🔵 B. NEW — backend improvements we added

These are things that weren't simply "CRUD requirements"; we added them to make the backend production-realistic.

### Security & authorization

- JWT guards
- Role guards
- Endpoint-level permissions
- DTO validation
- Structured error handling

### Inventory correctness

- Reservation synchronization when pending quantities change
- Transfer source/destination validation
- Same-warehouse transfer rejection
- Null-safe `maxCapacity`
- Historical deletion protection
- 409 Conflict for protected historical records

### Concurrency

- Prisma `$transaction()`
- Conditional `WHERE status = PENDING`
- PostgreSQL row locking
- Deterministic `(warehouseId, productId)` lock ordering
- Atomic stock movement + inventory update
- Atomic reservation operations
- Concurrency-safe transaction completion

### Transaction safety

- PENDING-only editing
- PENDING-only cancellation
- `PENDING → COMPLETED` only once
- `PENDING → CANCELLED` only once
- Correct reservation release
- Transfer reservation
- Incoming/outgoing/transfer-specific completion logic

### Document workflow

- Manual product resolution
- Warehouse selection during document review
- `rejectionReason`
- S3 abstraction
- File validation
- PDF/JPG/JPEG/PNG
- 10 MB limit

### Operational queries

- Upcoming deliveries
- Overdue transactions
- Supplier statistics

These are the things that make the backend more than a simple CRUD project.

---

## 🟡 C. AI-SUPPORTING BACKEND FEATURES

These are still NestJS functions.

You build the deterministic logic. The AI engineer consumes the results later.

### Inventory

```
getByWarehouse()
getByProduct()
getAvailable()
getLowStockProducts()
getWarehouseCapacity()
```

### Stock

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

### Supplier intelligence

```
getSupplierStats()
compareSuppliers()
```

The principle is:

```
NestJS:
"I calculate the facts."

AgentCore:
"I interpret/explain the facts."
```

---

## 🟡 D. Backend extensions mainly supporting AI

These are useful but shouldn't steal time from the core transaction system:

```
rankSuppliers()
getBestSupplier()
getRestockRecommendations()
getTransferRecommendations()
findBestWarehouseForOrder()
```

They are not AI themselves. They're deterministic backend algorithms that can give AgentCore better information.

---

## 🔮 E. Future — Security

These are good future improvements once the MVP works.

### Security

- Refresh-token rotation
- MFA/2FA
- Account lockout after repeated failed login
- Password reset flow
- Rate limiting
- API throttling
- Security audit logs
- Login/activity tracking
- Fine-grained permission policies
- API key management for service-to-service communication
- Secrets rotation
- IP/device anomaly detection
- Signed URLs for private S3 documents
- Antivirus/file scanning before document processing
- Data encryption policies
- Security headers
- Request tracing

I would especially prioritize audit logs + rate limiting + MFA + S3 private access if there's time later.

---

## 🔮 F. Future — Business features

These could make the ERP feel like a real commercial product rather than a capstone CRUD system.

### Procurement

- Supplier quotation management
- Purchase approval workflow
- Purchase order versioning
- Supplier performance scorecards
- Contract/price history
- Minimum order quantities
- Supplier lead-time tracking

### Inventory

- Batch/lot tracking
- Expiry-date tracking
- Serial-number tracking
- Barcode/QR support
- Cycle counting
- Inventory adjustments
- Stock valuation
- FIFO/FEFO
- Multi-location warehouse zones

### Sales

- Customer management
- Customer credit limits
- Customer-specific pricing
- Discounts
- Returns/refunds
- Partial shipments
- Backorders

### Finance

- Multi-currency
- Tax/VAT handling
- Payment tracking
- Cost-of-goods calculation
- Profit margins
- Invoice/payment reconciliation

---

## 🔮 G. Future — Creative technical features

These would be strong additions if you want something that stands out technically.

### 1. Event-driven inventory architecture

Instead of every operation directly triggering everything:

```
Transaction Completed
        ↓
Domain Event
        ↓
Inventory Updated
        ↓
Analytics Updated
        ↓
Notifications
```

This would make the system more scalable.

### 2. Inventory audit timeline

A complete timeline for every product:

```
Product X

Aug 10  +100 received
Aug 11  -20 customer order
Aug 12  +50 transfer
Aug 13  -15 customer order
```

Very useful for debugging and demonstrations.

### 3. Warehouse heatmap backend

Calculate warehouse utilization:

```
Warehouse A → 82%
Warehouse B → 41%
Warehouse C → 93%
```

The frontend can visualize it.

### 4. Supplier reliability scoring

Backend computes:

```
Price
+ On-time delivery
+ Cancellation rate
+ Lead time
+ Historical quality
```

and produces a deterministic supplier score.

This can later become an AI recommendation input.

### 5. Inventory simulation / what-if API

For example:

> "What happens if we receive 500 units next week?"

Backend calculates the scenario without modifying real inventory.

This is a strong business feature and can later become an AI tool.

### 6. Idempotency

Protect APIs from duplicate requests:

```
POST /transactions
Idempotency-Key: abc123
```

If the same request arrives twice, only one transaction is created.

This is particularly useful for real production systems.

### 7. Outbox pattern

For reliable integrations:

```
Database transaction
        ↓
Outbox event
        ↓
Email / Calendar / AI / Analytics
```

This becomes useful when moving further into AWS/event-driven architecture.

---

## Priority Order

With 1.5 weeks full-time, don't touch the future features yet.

```
PHASE 1
Auth + Users
Products
Warehouses
Suppliers

        ↓

PHASE 2
Warehouse Inventory
Reservations
Stock Movements

        ↓

PHASE 3
Inventory Transactions
Concurrency
Atomicity

        ↓

PHASE 4
Document Review
S3

        ↓

PHASE 5
Stock Insights
Analytics

        ↓

PHASE 6
Testing + API cleanup + AWS deployment

        ↓

PHASE 7
AI engineer consumes your backend
```

The most important thing is Phase 2 → Phase 3. The inventory/transaction engine needs to be correct before spending time on anything impressive-looking.

Once those are solid, that's a real backend. The AI layer can then sit on top without forcing a rebuild of the ERP.
