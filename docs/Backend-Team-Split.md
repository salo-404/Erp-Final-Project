# Mini ERP — Backend Team Split

## 👤 Salman

### 1. Authentication & Security

Folders:

```
src/auth/
src/users/
src/common/guards/
```

Functions:

```
AuthService
├── validateUser()
└── login()

UsersService
├── create()
├── findAll()
├── findOne()
├── update()
└── remove()
```

Security responsibilities:

- JWT authentication
- Password hashing
- JwtStrategy
- AuthGuard
- RolesGuard
- Role decorators
- ADMIN / EMPLOYEE authorization
- Endpoint permission enforcement
- Sensitive-operation protection

Permissions:

```
ADMIN
├── user management
├── document approval/rejection
├── transaction completion/cancellation
├── sensitive deletes
└── normal ERP operations

EMPLOYEE
├── normal reads
├── create pending transactions
├── upload documents
└── normal operational functionality
```

### 2. Supplier Intelligence

Folder:

```
src/suppliers/
```

Functions:

```
getSupplierStats()
compareSuppliers()
rankSuppliers()
getBestSupplier()
```

Calculates:

- average price
- on-time percentage
- late percentage
- cancellation rate
- purchase frequency
- products supplied
- last purchase date

These values remain deterministic NestJS calculations and can later be consumed by the Procurement Agent.

### 3. Warehouse Routing

Folder:

```
src/warehouse-inventory/
```

Function:

```
findBestWarehouseForOrder()
```

Flow:

```
Delivery country/region
        ↓
Available stock
        ↓
Warehouses that can fulfill
        ↓
Location comparison
        ↓
Recommended warehouse
```

The result can later be consumed by the Fulfillment Agent.

### 4. Stock Movements

Folder:

```
src/stock-movements/
```

Functions:

```
recordMovement()
getLedger()
```

`recordMovement()` is responsible for:

```
StockMovement
+
WarehouseInventory.onHand
```

being changed atomically.

`onHand` should not be directly modified by normal endpoints.

### 5. Reservations

Folder:

```
src/reservations/
```

Functions:

```
reserve()
release()
fulfill()
```

Responsibilities:

- available-stock verification
- reservation creation
- reservation updates
- reservation release
- reservation fulfillment
- OUTGOING reservations
- TRANSFER reservations
- concurrency protection
- deterministic `(warehouseId, productId)` locking

Core calculation:

```
available = onHand - ACTIVE reservations
```

### 6. Inventory Transactions

Folder:

```
src/inventory-transactions/
```

Functions:

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

Incoming:

```
PENDING
↓
complete()
↓
increase onHand
↓
COMPLETED
```

Outgoing:

```
PENDING
↓
reserve stock
↓
complete()
↓
decrease onHand
↓
COMPLETED
```

Transfer:

```
PENDING
↓
reserve source stock
↓
complete()
↓
source decreases
destination increases
↓
COMPLETED
```

`complete()` must use:

```
WHERE id = X
AND status = PENDING
```

plus the required row locking and Prisma `$transaction()`.

`cancel()` only operates on PENDING transactions and releases reservations where applicable.

`update()` must keep reservations synchronized when quantities/products/source warehouse change.

### 7. Document Review

Folder:

```
src/document-review/
```

Functions:

```
upload()
approve()
reject()
```

Upload:

```
Validate PDF/JPG/JPEG/PNG
10 MB maximum
Upload to S3
Create PendingDocumentReview
Start extraction workflow
```

Approve:

```
Review
↓
Warehouse confirmation
↓
Supplier resolution
↓
Product resolution
↓
EXISTING / CREATE
↓
Create PENDING transaction
↓
Approve document
```

No stock change occurs during approval.

Reject stores:

```
REJECTED
reviewedById
reviewedAt
rejectionReason
```

### 8. Stock Insights

Folder:

```
src/stock-insights/
```

Functions:

```
getDeadStock()
getStockoutRisk()
getConsumptionAnomalies()
getRestockRecommendations()
getTransferRecommendations()
```

These calculate deterministic backend results.

For example:

```
stock
+
reservations
+
consumption
+
pending incoming
+
reorder threshold
        ↓
stockout/restock analysis
```

The AI can later interpret these results.

---

## 👤 Joseph

### 1. Products

Folder:

```
src/products/
```

Functions:

```
create()
update()
remove()
findAll()
findOne()
```

Responsibilities:

- Product CRUD
- validation
- historical deletion protection
- 409 Conflict when historical records prevent deletion

Products do not directly modify stock.

### 2. Warehouses

Folder:

```
src/warehouses/
```

Functions:

```
create()
update()
remove()
findAll()
findOne()
getCatalog()
```

`getCatalog()` returns products/inventory associated with the warehouse.

Warehouse capacity calculation stays in `WarehouseInventoryService`.

### 3. Supplier Management

Folder:

```
src/suppliers/
```

Functions:

```
create()
update()
remove()
findAll()
findOne()
getTransactionHistory()
```

Joseph owns the supplier entity and its historical data.

Salman's supplier-intelligence functions consume this information.

### 4. Warehouse Inventory

Folder:

```
src/warehouse-inventory/
```

Functions:

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
onHand - ACTIVE reservations
```

Capacity:

```
usedCapacity / maxCapacity
```

If:

```
maxCapacity = null
```

return capacity as not configured.

This service provides the inventory information that Salman's transaction/routing logic consumes.

### 5. Analytics

Folder:

```
src/analytics/
```

Functions:

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

Later, the AI agents can consume these results through their tools.

### 6. Integrations

Folder:

```
src/integrations/
├── email/
└── calendar/
```

Responsibilities:

```
EmailService
CalendarService
```

Email:

```
Agent decides WHAT
        ↓
EmailService handles HOW
```

Calendar:

```
Transaction expectedDate
        ↓
CalendarService
        ↓
External calendar API
```

---

## Final Function Count

### Salman — 35

**Auth / Users**

```
validateUser()
login()
createUser()
findAllUsers()
findOneUser()
updateUser()
removeUser()
```

**Supplier Intelligence**

```
getSupplierStats()
compareSuppliers()
rankSuppliers()
getBestSupplier()
```

**Warehouse Routing**

```
findBestWarehouseForOrder()
```

**Stock Movements**

```
recordMovement()
getLedger()
```

**Reservations**

```
reserve()
release()
fulfill()
```

**Inventory Transactions**

```
createIncoming()
createOutgoing()
createTransfer()
update()
complete()
cancel()
findAllTransactions()
findOneTransaction()
getUpcomingDeliveries()
getOverdueTransactions()
```

**Document Review**

```
upload()
approve()
reject()
```

**Stock Insights**

```
getDeadStock()
getStockoutRisk()
getConsumptionAnomalies()
getRestockRecommendations()
getTransferRecommendations()
```

### Joseph — 36

**Products**

```
createProduct()
updateProduct()
removeProduct()
findAllProducts()
findOneProduct()
```

**Warehouses**

```
createWarehouse()
updateWarehouse()
removeWarehouse()
findAllWarehouses()
findOneWarehouse()
getCatalog()
```

**Suppliers**

```
createSupplier()
updateSupplier()
removeSupplier()
findAllSuppliers()
findOneSupplier()
getTransactionHistory()
```

**Warehouse Inventory**

```
getByWarehouse()
getByProduct()
getAvailable()
getLowStockProducts()
getWarehouseCapacity()
setReorderThreshold()
```

**Analytics**

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

**Integrations**

```
sendEmail()
createCalendarEvent()
createShipmentReminder()
```

---

## How You Connect Both Parts Later

This is actually straightforward because NestJS is one application.

You are not building two separate backends.

The structure stays:

```
mini-erp/
└── backend/
    └── src/
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
        └── integrations/
```

Both of you work in different modules but use the same:

- PrismaService
- DTOs
- entities/types
- common guards
- database
- NestJS application

### Example

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

That's a normal NestJS dependency. You don't copy the function.

### Another example

Joseph:

```
SupplierService
    ↓
getTransactionHistory()
```

Salman:

```
SupplierService
    ↓
getTransactionHistory()
    ↓
getSupplierStats()
    ↓
rankSuppliers()
```

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

This split also matches the current backend plan's architecture: NestJS owns the business rules and deterministic calculations, while the later multi-agent AgentCore system consumes controlled backend capabilities.
