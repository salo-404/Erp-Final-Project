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
- leadTimeDays: nullable integer
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
- SUM(
    Reservation.quantity
    WHERE Reservation.status = 'ACTIVE'
    for the same product and warehouse
  )

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

For true customer-consumption analysis, use OUTGOING activity.
TRANSFER_OUT represents internal movement between company warehouses and is not customer consumption.

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

Supplier.leadTimeDays is optional supplier metadata representing expected delivery lead time when configured.
Do not invent a lead time when leadTimeDays is NULL.

7. Pending supplier deliveries
There is NO PurchaseOrder table.

Expected supplier deliveries are represented by:

InventoryTransaction.type = 'INCOMING'
AND InventoryTransaction.status = 'PENDING'

Do not invent or query a PurchaseOrder table.

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

Reservation.warehouseId for a transfer therefore refers to the source warehouse.

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
StockMovement is the authoritative inventory movement history.

IMPORTANT:
StockMovement.quantity is stored as a quantity magnitude for normal movement types.
The effect on warehouse stock depends on StockMovement.type.

For net-stock calculations, interpret movement types as:

- INCOMING      => +quantity
- TRANSFER_IN   => +quantity
- OUTGOING      => -quantity
- TRANSFER_OUT  => -quantity
- ADJUSTMENT    => quantity as stored

Therefore, NEVER use plain:

SUM(StockMovement.quantity)

to calculate net inventory movement or reconcile current stock.

Use an explicit CASE expression such as:

SUM(
  CASE
    WHEN type IN ('INCOMING', 'TRANSFER_IN')
      THEN quantity
    WHEN type IN ('OUTGOING', 'TRANSFER_OUT')
      THEN -quantity
    WHEN type = 'ADJUSTMENT'
      THEN quantity
    ELSE 0
  END
)

Inventory reconciliation may compare:

WarehouseInventory.onHand

against the type-aware net sum of StockMovement quantities
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
Use actualDate for COMPLETED transaction timing when asking when inventory was actually received, sold, or transferred.

Use expectedDate for PENDING transaction timing.

createdAt means when the database record was created, not necessarily when physical inventory movement occurred.

18. Prices
InventoryTransactionItem.price is nullable.

For calculations involving value or revenue:

- explicitly handle NULL prices
- COALESCE(price, 0) may be used when appropriate
- do not invent prices

If a result depends on complete pricing and some prices are NULL, make that limitation clear.

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

Use PENDING INCOMING InventoryTransaction rows for expected supplier deliveries.

23. No customer model
There is NO Customer table.

Use InventoryTransaction.partyName for OUTGOING customers.

24. Internal SQL-RAG infrastructure
QueryExample and its embedding column are internal SQL-RAG retrieval infrastructure.

They are intentionally NOT part of DATABASE_SCHEMA and are NOT available for user-generated SQL.

Never generate SQL that queries QueryExample or any other internal AI infrastructure table.

25. Do not invent schema
Only use tables and fields explicitly listed in DATABASE_SCHEMA.

25a. Case-insensitive text matching
PostgreSQL text comparison is case-sensitive. A user referring to a
product, warehouse, supplier, or customer by name will rarely type the
exact stored capitalization (e.g. "wireless mouse" vs the stored
"Wireless Mouse").

Never compare a user-supplied name with plain "=" or "IN (...)" against
Product.name, Warehouse.name, Supplier.name, or
InventoryTransaction.partyName. Always match case-insensitively, for
example:

LOWER(p.name) = LOWER('wireless mouse')

or, for a partial/fuzzy match:

p.name ILIKE '%wireless mouse%'

This applies to every value in a multi-value list too - each name in an
IN-style comparison must be matched case-insensitively, not just the
first. A real product silently failing to match due to case is a
correctness bug, not a "not found" result - it is indistinguishable at
the SQL level from a name that is genuinely absent, so getting the
comparison right here is the only thing standing between the two.

25b. ALWAYS PARENTHESIZE an OR group combined with AND filters
PostgreSQL evaluates AND before OR. Matching several candidate names
with ILIKE/OR (rule 25a) inside a WHERE clause that also has AND filters
(type, status, date range, etc.) is a common real mistake: without
parentheses, only the first OR-branch stays inside those AND filters -
every other branch silently escapes them and matches rows regardless of
type/status/date. This is not hypothetical - it has produced real,
wrong answers, including a cancelled transaction and orders from months
outside the requested one, once the OR chain left the AND filters
behind.

WRONG (the AND filters only bind to the FIRST OR condition):

WHERE it.type = 'OUTGOING' AND it.status = 'COMPLETED'
  AND p.name ILIKE '%a%' OR p.name ILIKE '%b%'
  AND it."actualDate" >= DATE_TRUNC('month', CURRENT_DATE)

CORRECT (the OR group is wrapped so the AND filters apply to every
candidate):

WHERE it.type = 'OUTGOING' AND it.status = 'COMPLETED'
  AND (p.name ILIKE '%a%' OR p.name ILIKE '%b%')
  AND it."actualDate" >= DATE_TRUNC('month', CURRENT_DATE)

Whenever a query needs to match ANY of several names/values, wrap that
whole OR group in its own parentheses before combining it with any other
AND condition - never let an OR chain span outside its own parentheses
into the surrounding filter.

26. SQL is read-only
Generated SQL must only answer questions.

Never generate:

INSERT
UPDATE
DELETE
MERGE
TRUNCATE
CREATE
ALTER
DROP
GRANT
REVOKE
COPY
CALL
DO

or any other write, DDL, administrative, or side-effecting statement.

27. Warehouse fullness terminology
Warehouse utilization is based on physical stock:

SUM(WarehouseInventory.onHand) / Warehouse.maxCapacity

When the user says:

- "almost full"
- "nearly full"
- "close to capacity"

treat this as utilization >= 80%.

When the user asks for exact utilization, calculate and return the percentage.

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