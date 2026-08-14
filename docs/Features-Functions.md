# Mini ERP — Features & Requirements

## Core Features Requested in the Original Project

### 🔐 Authentication & Users

- User accounts
- JWT authentication
- Role-based access control
- Two finalized roles:
    - `ADMIN`
    - `EMPLOYEE`

---

### 📦 Products

- Product CRUD
- Product catalog
- Product information management
- Products shared across warehouses
- New-product creation during invoice/document review

---

### 🏭 Warehouses

- Warehouse CRUD
- Independent inventory per warehouse
- Warehouse catalog
- Warehouse location
- Warehouse capacity/utilization
- Automatic warehouse selection for customer orders

---

### 📊 Warehouse Inventory

- Track `onHand` stock per product/warehouse
- Calculate available stock:

```
available = onHand - ACTIVE reservations
```

- Reorder thresholds
- Low-stock products
- Capacity information
- Inventory lookup by warehouse
- Inventory lookup by product
- Closest suitable warehouse selection for customer orders

---

### 📋 Stock Management

- Immutable stock movement ledger
- `INCOMING` movements
- `OUTGOING` movements
- `TRANSFER_IN` movements
- `TRANSFER_OUT` movements
- `ADJUSTMENT` movements
- Atomic inventory updates
- Warehouse-to-warehouse transfers
- Full historical audit trail

Physical `onHand` inventory changes only through stock-movement logic.

---

### 🔒 Reservations

- Warehouse-specific reservations
- Reserve stock for outgoing customer orders
- Reserve source stock for warehouse transfers
- Release reservations
- Fulfill reservations
- Prevent overselling
- Prevent the same stock from being simultaneously sold and transferred
- Keep reservations synchronized when pending orders/transfers are edited
- Include reservations when calculating available stock

---

### 🚚 Inventory Transactions

Three transaction types:

```
INCOMING
OUTGOING
TRANSFER
```

Three statuses:

```
PENDING
COMPLETED
CANCELLED
```

There are intentionally no additional purchase-order states such as `DRAFT`, `SENT`, `CONFIRMED`, or `RECEIVED`. A transaction remains `PENDING` until completed or cancelled.

Features:

- Create incoming transactions
- Create outgoing/customer transactions
- Create warehouse transfers
- Edit pending transactions
- Complete transactions
- Cancel transactions
- Upcoming deliveries
- Overdue transactions
- Expected dates
- Actual completion dates
- Customer delivery country/region
- Automatic source-warehouse routing

---

### 📍 Automatic Customer Order Routing

Customer orders can contain:

```
deliveryCountry
deliveryRegion
```

The backend uses:

```
findBestWarehouseForOrder()
```

Flow:

```
Customer order
↓
Check warehouses
↓
Calculate available stock
↓
Remove warehouses unable to fulfill order
↓
Compare remaining warehouse locations with customer delivery location
↓
Recommend closest suitable warehouse
↓
Use as sourceWarehouseId
```

A geocoding/distance API can later improve the geographic calculation.

---

# 🧾 Invoices / Document Review

### Upload

- Upload PDF/image invoices
- Supported formats:
    - PDF
    - JPG
    - JPEG
    - PNG
- Maximum file size: 10 MB
- File validation before processing
- Store documents in AWS S3
- Create pending document review

### AI Extraction

AI can extract:

- transaction type
- supplier/customer
- date
- warehouse
- customer delivery country
- customer delivery region
- products
- quantities
- prices
- invoice information

### Human Review

- Review extracted information
- Exact product matching
- Fuzzy product suggestions
- Manual product selection
- Human confirmation of ambiguous matches
- Create missing products during review
- `EXISTING` vs `CREATE` product resolution
- Warehouse matching/confirmation
- Manual warehouse selection when extraction cannot determine one
- Approve document
- Reject document
- Store rejection reason

---

## Supplier Invoice Approval

Approving an invoice **does not immediately change physical inventory**.

Instead:

```
AI extraction accepted
↓
Supplier resolved
↓
Products resolved
↓
Warehouse confirmed
↓
Create PENDING INCOMING transaction
↓
Document = APPROVED
```

Later, when goods physically arrive:

```
complete(transactionId)
↓
Create INCOMING StockMovement
↓
Increase onHand
↓
Transaction = COMPLETED
```

Therefore:

```
APPROVE INVOICE ≠ CHANGE STOCK

COMPLETE INCOMING = CHANGE STOCK
```

This is the finalized document behavior.

---

## Customer Document Approval

Outgoing/customer documents can similarly create:

```
PENDING OUTGOING
+
ACTIVE source reservations
```

The source warehouse can be selected using `findBestWarehouseForOrder()`.

Physical stock decreases only when the outgoing transaction is completed.

---

# 🏢 Suppliers

### Supplier Management

- Supplier CRUD
- Supplier name
- Supplier email/contact information
- Supplier transaction history

### Supplier Analytics

Calculate dynamically:

- average price
- on-time %
- late %
- cancellation rate
- purchase frequency
- products supplied
- last purchase date

### Supplier Ranking

```
rankSuppliers()
```

Ranks suppliers dynamically using historical ERP data.

No permanent supplier score is stored.

### Best Supplier

```
getBestSupplier()
```

Can determine the best supplier for a product/restocking requirement using supplier performance, price, and purchasing history.

Conceptually:

```
Restocking requirement
↓
Candidate suppliers
↓
Supplier statistics
↓
rankSuppliers()
↓
getBestSupplier()
```

---

# ⚠️ Stock Insights

### Dead Stock

```
getDeadStock()
```

Detect products with no relevant movement during a configured period, such as 60 days.

### Stockout Risk

```
getStockoutRisk()
```

Can use:

- available stock
- historical consumption
- pending incoming quantities
- expected delivery dates
- reorder threshold

### Consumption Anomalies

```
getConsumptionAnomalies()
```

Detect unusual increases/decreases in consumption relative to historical behavior.

---

# 🛒 Restock Recommendations

```
getRestockRecommendations()
```

Uses:

- `onHand`
- active reservations
- available stock
- reorder threshold
- historical consumption
- stockout risk
- pending incoming quantities
- expected incoming dates
- supplier history

Flow:

```
Current inventory
↓
Consumption analysis
↓
Pending incoming stock
↓
Stockout risk
↓
Determine whether restocking is needed
↓
Recommend quantity
↓
Optionally find best supplier
```

NestJS performs the calculations; AgentCore interprets/explains the recommendation.

---

# 🔁 Warehouse Transfer Recommendations

```
getTransferRecommendations()
```

Before purchasing new stock, the system can determine whether another warehouse has excess inventory.

Uses:

- available stock by warehouse
- reorder thresholds
- warehouse demand
- consumption history
- stockout risk
- excess stock elsewhere

Flow:

```
Warehouse shortage
↓
Check other warehouses
↓
Find excess inventory
↓
Determine suitable source
↓
Recommend destination
↓
Recommend transfer quantity
```

This **only recommends** a transfer. It does not automatically create or complete one.

---

# 📈 Analytics

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

All numerical/deterministic calculations remain in NestJS.

AgentCore interprets and explains them.

---

# 🤖 AI Agent / AgentCore

### Natural-Language ERP Queries

Users can ask questions such as:

```
"How much Product X is available?"

"Which products are running low?"

"Which supplier is best for Product X?"

"Which warehouse should fulfill this customer order?"

"What products should we restock?"

"Could we transfer stock instead of buying more?"

"What shipments are overdue?"
```

### Controlled Backend Tools

AgentCore can use controlled tools such as:

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

AgentCore has **no unrestricted database access**.

It cannot:

- execute arbitrary SQL
- directly modify inventory
- complete transactions
- cancel transactions
- delete ERP records

NestJS remains the deterministic source of truth.

---

# 📧 Purchase Recommendations & Email

The system can combine:

```
Stockout risk
+
Restock recommendation
+
Supplier ranking
+
Best supplier
```

to generate purchase recommendations.

Flow:

```
NestJS calculations
↓
AgentCore interpretation
↓
Purchase recommendation
↓
EmailService
↓
Recommendation email
```

---

# 📅 Shipment & Calendar Reminders

Functions:

```
getUpcomingDeliveries()
getOverdueTransactions()
```

Upcoming:

```
PENDING + expectedDate in future
```

Overdue:

```
PENDING + expectedDate < now
```

`CalendarService` can use these dates to create/manage external shipment reminders.

---

# New / Advanced Engineering Features We Added

These features make the project more production-realistic than a normal CRUD ERP.

## 🔐 Security & Authorization

- JWT authentication
- Only `ADMIN` and `EMPLOYEE` roles
- Role-based endpoint permissions
- Sensitive operations protected with guards
- AgentCore receives no direct database credentials
- No arbitrary AI-generated SQL
- AI cannot directly modify stock
- AI cannot complete/cancel transactions
- AI cannot delete ERP records

---

## ⚡ Concurrency & Data Consistency

- Atomic multi-table operations using Prisma `$transaction()`
- Conditional state transitions:
    - `PENDING → COMPLETED`
    - `PENDING → CANCELLED`
- Prevent double completion
- Prevent double cancellation
- Prevent duplicate document approval
- Row-level locking using `SELECT ... FOR UPDATE`
- Inventory rows locked before reservation/stock-sensitive operations
- Concurrency-safe reservations
- Concurrency-safe transfers
- Source stock revalidated at transfer completion
- Prevention of negative stock caused by simultaneous operations

### Deterministic Lock Ordering

The finalized ordering is:

```
warehouseId + productId
```

**not product ID alone.**

When multiple inventory rows are involved, they are always locked in the same deterministic order to reduce deadlock risk.

---

## 📦 Inventory Integrity

- `onHand` changed only through stock movement logic
- Immutable stock ledger
- Warehouse-specific inventory
- Warehouse-specific reservations
- `available = onHand - ACTIVE reservations`
- Reservation synchronization when pending outgoing transactions change
- Reservation synchronization when pending transfers change
- Source ≠ destination validation
- Transfer cancellation creates no unnecessary reversal movement
- Movement + inventory update are atomic
- Transfer physically moves stock only on completion

---

## 🧾 Document Integrity

- File-type validation
- File-size validation
- Duplicate-document protection where practical
- AI extraction failure handling
- System-generated rejection reason
- Human confirmation of ambiguous matches
- Explicit `EXISTING` vs `CREATE`
- Atomic new-product creation during approval
- Warehouse confirmation
- Customer destination extraction
- Prevent repeated processing of approved/rejected documents
- Approval creates a pending transaction rather than falsely claiming physical inventory has already moved

---

## 🛡️ Historical-Data Protection

- Products with historical references cannot simply be deleted
- Warehouses with historical references cannot simply be deleted
- Suppliers with historical references cannot simply be deleted
- Foreign-key restrictions preserved
- Clear `409 Conflict` responses instead of raw database errors
- Historical stock and transaction records preserved

---

## 🧠 Inventory Intelligence We Added

Beyond the original CRUD/ERP functionality:

```
findBestWarehouseForOrder()

rankSuppliers()
getBestSupplier()

getStockoutRisk()
getConsumptionAnomalies()

getRestockRecommendations()
getTransferRecommendations()

getUpcomingDeliveries()
getOverdueTransactions()
```

These give the ERP proactive decision-support capabilities rather than simply storing records.

---

## 📊 API / Backend Quality

- DTO validation
- Consistent error handling
- HTTP exception handling
- Pagination for growing datasets
- Controller / DTO / Service / Prisma separation
- Atomic service operations
- Deterministic calculations in NestJS
- AI used for reasoning/interpretation rather than authoritative inventory arithmetic

---

## ☁️ AWS-Ready Architecture

- Same backend code locally and on AWS
- Environment-based configuration
- No hardcoded credentials
- PostgreSQL → AWS RDS
- Documents → S3
- NestJS → AWS compute/ECS Fargate
- Backend image → ECR
- AgentCore → AWS deployment
- Frontend → AWS hosting
- Email → SES/provider
- Calendar → external calendar API
- Private RDS architecture
- Infrastructure separated from application business logic

---

# The Important Distinction

If your mentor asks:

> **"What were you asked to build?"**

Focus on the **Core Features**: inventory, warehouses, transactions, invoices, stock insights, analytics, AI queries, recommendations, reminders, and AWS deployment.

If they ask:

> **"What did you add/improve from an engineering perspective?"**

The strongest answer is:

> **We added concurrency-safe inventory operations, atomic multi-table transactions, row-level locking and deterministic lock ordering, warehouse-specific reservation consistency, historical-data protection, controlled AI access, stronger document validation and human-review flows, automatic customer-order warehouse routing, supplier ranking, best-supplier selection, restock recommendations, warehouse-transfer recommendations, and an AWS-ready deployment architecture.**

That version now matches the finalized backend plan rather than the older design.
