# Mini ERP — Backend Feature Checklist

This is the list to keep separately as the backend feature checklist.

---

## 1. BASIC — Required Core Backend

These are the ERP capabilities that form the main required system.

### Authentication & Users

```
validateUser()
login()
```

- User CRUD
- JWT authentication
- Role-based authorization
- ADMIN / EMPLOYEE

### Products

```
create()
findAll()
findOne()
update()
remove()
```

### Warehouses

```
create()
findAll()
findOne()
update()
remove()
getCatalog()
```

### Suppliers

```
create()
findAll()
findOne()
update()
remove()
getTransactionHistory()
```

### Warehouse Inventory

```
getByWarehouse()
getByProduct()
getAvailable()
getLowStockProducts()
getWarehouseCapacity()
setReorderThreshold()
```

### Stock Movements

```
recordMovement()
getLedger()
```

### Reservations

```
reserve()
release()
fulfill()
```

### Inventory Transactions

```
createIncoming()
createOutgoing()
createTransfer()
update()
complete()
cancel()
findAll()
findOne()
getUpcomingDeliveries()
getOverdueTransactions()
```

### Document Review

```
upload()
approve()
reject()
```

- Product resolution
- Supplier resolution
- Human review workflow
- S3 document storage

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

---

## 2. NEW — Features We Added / Expanded

These are the features added or significantly expanded beyond the original core.

### Stock Intelligence

```
getDeadStock()
getStockoutRisk()
getConsumptionAnomalies()
```

### Supplier Intelligence

```
getSupplierStats()
compareSuppliers()
rankSuppliers()
getBestSupplier()
```

### Warehouse Routing

```
findBestWarehouseForOrder()
```

Current logic uses:

```
delivery country
+
delivery region
+
warehouse location
+
available stock
```

### Restocking

```
getRestockRecommendations()
```

Considers:

```
available stock
+
reservations
+
consumption
+
pending incoming
+
expected delivery
+
other warehouses
```

### Transfers

```
getTransferRecommendations()
```

Determines whether stock should be moved between warehouses.

### Control Tower

```
getControlTowerAlerts()
```

Combines signals such as:

- low stock
- stockout risk
- overdue transactions
- consumption anomalies
- restock/transfer signals

into a unified operational view.

### Backend Safety / Engineering Features

These are also important additions:

- Atomic stock movements
- Atomic transaction operations
- Reservation synchronization
- OUTGOING + TRANSFER reservations
- Conditional `WHERE status = PENDING` transitions
- PostgreSQL row locking
- Deterministic `(warehouseId, productId)` lock ordering
- Same-warehouse transfer prevention
- Historical deletion protection
- Null-safe warehouse capacity
- File validation
- `rejectionReason`
- Human confirmation before document approval
- S3 document storage

These are particularly good technical presentation features because they demonstrate that the ERP isn't just CRUD.

---

## 3. FUTURE — Post-MVP / Expansion

These are things that can be added after the core system and current AI scope are stable.

### 🤖 AI / Marketing

**AI Marketing Assistant**

Possible capabilities:

- Generate supplier/customer emails
- Generate promotional campaigns
- Generate product descriptions
- Generate social-media content
- Generate marketing recommendations from sales trends
- Identify products that could benefit from promotions
- Customer segmentation
- Personalized offers
- Campaign performance analysis
- Automated marketing calendar

Example:

```
Sales data
    ↓
AI Marketing Agent
    ↓
"Product X is declining in sales"
    ↓
Suggested promotion
    ↓
Generate campaign
```

---

## 4. Future Business Features

### Procurement

- Purchase-order optimization
- Supplier negotiation recommendations
- Supplier performance forecasting
- Automatic reorder planning
- Budget-aware purchasing
- Price trend analysis
- Supplier risk scoring

### Sales

- Customer demand forecasting
- Customer purchase patterns
- Repeat-order prediction
- Sales opportunity detection
- Dynamic product recommendations

### Warehouse

- Multi-warehouse optimization
- Warehouse workload balancing
- Capacity planning
- Automated stock redistribution
- Advanced warehouse utilization analysis

### Business Intelligence

- Executive dashboard
- KPI tracking
- Profitability analysis
- Cost analysis
- Revenue forecasting
- Supplier cost trends
- Inventory carrying-cost analysis

---

## 5. Future Technical Features

### Pick-Path Optimization

Once the database supports:

```
warehouse
→ zone
→ bin
→ coordinates
```

you could implement:

```
calculatePickPath()
```

to determine the most efficient route for warehouse workers.

### Expiry / Lot Management

If the team later decides to support it properly:

```
lot/batch
expiryDate
quantity
warehouse
```

then:

```
getExpiringInventory()
```

could be implemented.

Currently, this is intentionally outside the scope — see `Backend-Team-Split.md` and `Salman-Backend-Plan.md`, where it was dropped from the Control Tower feature rather than deferred as blocked.

### Advanced Security

- Refresh tokens
- Token rotation
- MFA
- API rate limiting
- Audit logs
- Login anomaly detection
- IP/device tracking
- Fine-grained permissions
- Security event monitoring

### Technical Improvements

- Redis caching
- Background job queues
- Event-driven architecture
- WebSockets for live inventory
- Advanced API rate limiting
- Distributed tracing
- Automated backups
- Disaster recovery
- CI/CD pipelines
- Blue/green deployments
- Horizontal ECS scaling

---

## 6. Best Features for Your Final Presentation

If you need to select the strongest features later, prioritize:

**Business**

- Multi-warehouse inventory
- Reservations preventing overselling
- Supplier ranking
- Restock recommendations
- Warehouse selection
- Control Tower

**Technical**

- Concurrency-safe transactions
- Atomic stock movements
- Immutable stock ledger
- JWT + RBAC
- Human-in-the-loop document processing
- S3 + RDS + ECS AWS architecture

**AI**

- Multi-agent Supervisor
- Insights Agent
- Document Agent
- AI consuming deterministic NestJS tools
- AI recommendations backed by actual ERP data

The strongest overall story is:

> A reliable transactional ERP backend first, deterministic business intelligence second, and AI as a controlled reasoning layer on top.
