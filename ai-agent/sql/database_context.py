DATABASE_SCHEMA = """
PostgreSQL schema used by the ERP system.

Product
- id: integer primary key
- name: text
- category: nullable text
- description: nullable text
- isActive: boolean
- createdAt: timestamp

Warehouse
- id: integer primary key
- name: text
- location: nullable text
- maxCapacity: nullable integer
- isActive: boolean
- createdAt: timestamp

WarehouseInventory
- id: integer primary key
- productId: foreign key -> Product.id
- warehouseId: foreign key -> Warehouse.id
- onHand: integer
- reorderThreshold: integer
- unique(productId, warehouseId)

Supplier
- id: integer primary key
- name: text
- email: nullable text
- isActive: boolean
- createdAt: timestamp

InventoryTransaction
- id: integer primary key
- type: INCOMING | OUTGOING | TRANSFER
- status: PENDING | COMPLETED | CANCELLED
- sourceWarehouseId: nullable foreign key -> Warehouse.id
- destinationWarehouseId: nullable foreign key -> Warehouse.id
- supplierId: nullable foreign key -> Supplier.id
- deliveryCountry: nullable text
- deliveryRegion: nullable text
- deliveryAddress: nullable text
- expectedDate: nullable timestamp
- actualDate: nullable timestamp
- partyName: nullable text
- documentUrl: nullable text
- createdAt: timestamp
- updatedAt: timestamp

InventoryTransactionItem
- id: integer primary key
- transactionId: foreign key -> InventoryTransaction.id
- productId: foreign key -> Product.id
- quantity: integer
- price: nullable decimal

StockMovement
- id: integer primary key
- productId: foreign key -> Product.id
- warehouseId: foreign key -> Warehouse.id
- type: INCOMING | OUTGOING | TRANSFER_IN | TRANSFER_OUT | ADJUSTMENT
- quantity: integer
- transactionId: nullable foreign key -> InventoryTransaction.id
- createdAt: timestamp

Reservation
- id: integer primary key
- transactionId: foreign key -> InventoryTransaction.id
- productId: foreign key -> Product.id
- warehouseId: foreign key -> Warehouse.id
- quantity: integer
- status: ACTIVE | FULFILLED | CANCELLED
- createdAt: timestamp
"""


BUSINESS_RULES = """
ERP business rules:

1. Available stock
Available stock is NOT stored directly.
For a product in a warehouse:

available =
WarehouseInventory.onHand
- SUM(Reservation.quantity WHERE Reservation.status = 'ACTIVE'
      for the same product and warehouse)

2. Physical stock
WarehouseInventory.onHand represents the current physical quantity.

3. Reservations
Only ACTIVE reservations reduce available stock.

Reservations are warehouse-specific and product-specific.

4. Customer sales / consumption
Customer sales are represented by:
InventoryTransaction.type = 'OUTGOING'
AND InventoryTransaction.status = 'COMPLETED'

OUTGOING transactions consume stock from sourceWarehouseId.

5. Customers
There is NO Customer table.

For OUTGOING transactions, the customer name is stored in:
InventoryTransaction.partyName

Do not invent Customer, CustomerOrder, SalesOrder, or similar tables.

6. Supplier purchases / receipts
Supplier receipts are represented by:
InventoryTransaction.type = 'INCOMING'
AND InventoryTransaction.status = 'COMPLETED'

INCOMING transactions normally use supplierId.

Supplier information comes from:
InventoryTransaction.supplierId -> Supplier.id

7. Pending supplier deliveries
There is NO PurchaseOrder table.

Expected supplier deliveries are represented by:
InventoryTransaction.type = 'INCOMING'
AND InventoryTransaction.status = 'PENDING'

8. Transfers
Warehouse transfers are represented by:
InventoryTransaction.type = 'TRANSFER'

Transfers are internal stock movements.
Transfers are NOT customer sales or customer consumption.

A completed transfer causes:
- TRANSFER_OUT movement at source warehouse
- TRANSFER_IN movement at destination warehouse

9. Transfer reservations
A PENDING transfer reserves stock only at its source warehouse.

The Reservation.warehouseId for a transfer therefore refers to the source warehouse.

10. Outgoing reservations
PENDING OUTGOING transactions can reserve stock at the source warehouse.

11. Overdue reservations / transactions
A transaction is overdue when:
status = 'PENDING'
AND expectedDate IS NOT NULL
AND expectedDate < CURRENT_TIMESTAMP

Overdue reservations are NOT automatically released.
A human must complete, reschedule, or cancel the transaction.

12. Warehouse capacity
Warehouse.maxCapacity is based on PHYSICAL stock.

Capacity calculations should use:
SUM(WarehouseInventory.onHand)

Do NOT subtract reservations when checking physical warehouse capacity.

13. Stock movement ledger
StockMovement is the authoritative movement history.

StockMovement.quantity is signed according to the movement recorded by the backend.

Inventory reconciliation can compare:
WarehouseInventory.onHand
against
SUM(StockMovement.quantity)
for the same product and warehouse.

14. Product activity
When showing normal operational data, prefer active products:
Product.isActive = TRUE

15. Warehouse activity
When showing normal operational data, prefer active warehouses:
Warehouse.isActive = TRUE

16. Supplier activity
When showing normal operational supplier data, prefer active suppliers:
Supplier.isActive = TRUE

17. Dates
Use actualDate for completed transaction timing when asking when inventory was actually received, sold, or transferred.

Use expectedDate for pending transaction timing.

createdAt means when the database record was created, not necessarily when physical inventory movement occurred.

18. Prices
InventoryTransactionItem.price is nullable.

For calculations involving value or revenue:
- explicitly handle NULL prices
- COALESCE(price, 0) may be used when appropriate
- do not invent prices

19. Sales revenue
Sales revenue may be calculated from COMPLETED OUTGOING transaction items as:
quantity * price

20. Purchasing spend
Purchasing spend may be calculated from COMPLETED INCOMING transaction items as:
quantity * price

21. No expiry model
There is NO expiry-date, batch, lot, or shelf-life model in the current database.

Do not generate queries involving expiry dates, batches, lots, or expiration risk.

22. No purchase order model
There is NO PurchaseOrder table.

Use PENDING INCOMING transactions for expected supplier deliveries.

23. No customer model
There is NO Customer table.

Use InventoryTransaction.partyName for OUTGOING customers.

24. Do not invent schema
Only use tables and fields explicitly listed in DATABASE_SCHEMA.

25. SQL is read-only
Generated SQL must only answer questions.
Never generate INSERT, UPDATE, DELETE, MERGE, TRUNCATE, CREATE, ALTER, DROP,
GRANT, REVOKE, COPY, CALL, DO, or any other write/DDL statement.

26. Warehouse fullness terminology
Warehouse utilization is:

SUM(WarehouseInventory.onHand) / Warehouse.maxCapacity

When the user says:
- "almost full"
- "nearly full"
- "close to capacity"

treat this as utilization >= 80%.

When the user asks for the exact utilization, calculate and return the percentage.

A warehouse with maxCapacity = NULL has no configured finite capacity and should not be included in fullness percentage checks.
"""


ALLOWED_TABLES = {
    "Product",
    "Warehouse",
    "WarehouseInventory",
    "Supplier",
    "InventoryTransaction",
    "InventoryTransactionItem",
    "StockMovement",
    "Reservation",
}