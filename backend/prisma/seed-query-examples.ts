import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

type QueryExampleSeed = {
  category: string;
  question: string;
  description: string;
  sql: string;
};
const QUERY_EXAMPLES: QueryExampleSeed[] = [
  {
    category: 'inventory',
    question: 'Show the physical stock of every product in every warehouse.',
    description: 'Current physical inventory uses WarehouseInventory.onHand.',
    sql: `
SELECT
    p.id AS product_id,
    p.name AS product_name,
    w.id AS warehouse_id,
    w.name AS warehouse_name,
    wi."onHand" AS on_hand
FROM "WarehouseInventory" wi
JOIN "Product" p ON p.id = wi."productId"
JOIN "Warehouse" w ON w.id = wi."warehouseId"
WHERE p."isActive" = TRUE
  AND w."isActive" = TRUE
ORDER BY p.name, w.name
`,
  },

  {
    category: 'inventory',
    question:
      'How much stock is actually available after reservations in each warehouse?',
    description:
      'Available stock equals onHand minus ACTIVE reservations for the same product and warehouse.',
    sql: `
SELECT
    p.id AS product_id,
    p.name AS product_name,
    w.id AS warehouse_id,
    w.name AS warehouse_name,
    wi."onHand" AS on_hand,
    COALESCE(SUM(r.quantity), 0) AS reserved,
    wi."onHand" - COALESCE(SUM(r.quantity), 0) AS available
FROM "WarehouseInventory" wi
JOIN "Product" p ON p.id = wi."productId"
JOIN "Warehouse" w ON w.id = wi."warehouseId"
LEFT JOIN "Reservation" r
    ON r."productId" = wi."productId"
   AND r."warehouseId" = wi."warehouseId"
   AND r.status = 'ACTIVE'
WHERE p."isActive" = TRUE
  AND w."isActive" = TRUE
GROUP BY
    p.id,
    p.name,
    w.id,
    w.name,
    wi."onHand"
ORDER BY p.name, w.name
`,
  },

  {
    category: 'inventory',
    question:
      'What is the total available quantity of each product across all warehouses?',
    description:
      'Calculate availability per warehouse first, then total it across warehouses.',
    sql: `
WITH warehouse_availability AS (
    SELECT
        wi."productId",
        wi."warehouseId",
        wi."onHand",
        wi."onHand" - COALESCE(SUM(r.quantity), 0) AS available
    FROM "WarehouseInventory" wi
    LEFT JOIN "Reservation" r
        ON r."productId" = wi."productId"
       AND r."warehouseId" = wi."warehouseId"
       AND r.status = 'ACTIVE'
    GROUP BY
        wi."productId",
        wi."warehouseId",
        wi."onHand"
)
SELECT
    p.id AS product_id,
    p.name AS product_name,
    SUM(wa."onHand") AS total_on_hand,
    SUM(wa.available) AS total_available
FROM warehouse_availability wa
JOIN "Product" p ON p.id = wa."productId"
WHERE p."isActive" = TRUE
GROUP BY p.id, p.name
ORDER BY total_available DESC
`,
  },

  {
    category: 'inventory',
    question: 'How many units of Laptop are available in each warehouse?',
    description:
      'Example of filtering a product by name while still subtracting active reservations.',
    sql: `
SELECT
    p.name AS product_name,
    w.name AS warehouse_name,
    wi."onHand" AS on_hand,
    COALESCE(SUM(r.quantity), 0) AS reserved,
    wi."onHand" - COALESCE(SUM(r.quantity), 0) AS available
FROM "WarehouseInventory" wi
JOIN "Product" p ON p.id = wi."productId"
JOIN "Warehouse" w ON w.id = wi."warehouseId"
LEFT JOIN "Reservation" r
    ON r."productId" = wi."productId"
   AND r."warehouseId" = wi."warehouseId"
   AND r.status = 'ACTIVE'
WHERE p.name ILIKE '%Laptop%'
  AND p."isActive" = TRUE
  AND w."isActive" = TRUE
GROUP BY
    p.id,
    p.name,
    w.id,
    w.name,
    wi."onHand"
ORDER BY w.name
`,
  },

  {
    category: 'inventory',
    question:
      'What products and available quantities are currently in the Main warehouse?',
    description: 'Example of filtering current inventory by warehouse name.',
    sql: `
SELECT
    p.id AS product_id,
    p.name AS product_name,
    wi."onHand" AS on_hand,
    COALESCE(SUM(r.quantity), 0) AS reserved,
    wi."onHand" - COALESCE(SUM(r.quantity), 0) AS available
FROM "WarehouseInventory" wi
JOIN "Product" p ON p.id = wi."productId"
JOIN "Warehouse" w ON w.id = wi."warehouseId"
LEFT JOIN "Reservation" r
    ON r."productId" = wi."productId"
   AND r."warehouseId" = wi."warehouseId"
   AND r.status = 'ACTIVE'
WHERE w.name ILIKE '%Main%'
  AND p."isActive" = TRUE
  AND w."isActive" = TRUE
GROUP BY
    p.id,
    p.name,
    wi."onHand"
ORDER BY p.name
`,
  },

  {
    category: 'inventory',
    question: 'Summarize current stock by product category.',
    description:
      'Category-level inventory summary including physical, reserved, and available stock.',
    sql: `
WITH inventory_availability AS (
    SELECT
        wi."productId",
        wi."onHand",
        wi."onHand" - COALESCE(SUM(r.quantity), 0) AS available,
        COALESCE(SUM(r.quantity), 0) AS reserved
    FROM "WarehouseInventory" wi
    LEFT JOIN "Reservation" r
        ON r."productId" = wi."productId"
       AND r."warehouseId" = wi."warehouseId"
       AND r.status = 'ACTIVE'
    GROUP BY
        wi.id,
        wi."productId",
        wi."onHand"
)
SELECT
    COALESCE(p.category, 'Uncategorized') AS category,
    SUM(ia."onHand") AS on_hand,
    SUM(ia.reserved) AS reserved,
    SUM(ia.available) AS available
FROM inventory_availability ia
JOIN "Product" p ON p.id = ia."productId"
WHERE p."isActive" = TRUE
GROUP BY COALESCE(p.category, 'Uncategorized')
ORDER BY category
`,
  },

  {
    category: 'inventory',
    question:
      'Which products are physically stocked in more than one warehouse?',
    description:
      'Find products whose on-hand stock is positive in multiple warehouses.',
    sql: `
SELECT
    p.id AS product_id,
    p.name AS product_name,
    COUNT(*) AS warehouse_count,
    SUM(wi."onHand") AS total_on_hand
FROM "WarehouseInventory" wi
JOIN "Product" p ON p.id = wi."productId"
JOIN "Warehouse" w ON w.id = wi."warehouseId"
WHERE wi."onHand" > 0
  AND p."isActive" = TRUE
  AND w."isActive" = TRUE
GROUP BY p.id, p.name
HAVING COUNT(*) > 1
ORDER BY warehouse_count DESC, p.name
`,
  },

  {
    category: 'inventory',
    question:
      'Which active products do not have an inventory record in any warehouse?',
    description: 'Find active products missing WarehouseInventory rows.',
    sql: `
SELECT
    p.id AS product_id,
    p.name AS product_name,
    p.category
FROM "Product" p
WHERE p."isActive" = TRUE
  AND NOT EXISTS (
      SELECT 1
      FROM "WarehouseInventory" wi
      WHERE wi."productId" = p.id
  )
ORDER BY p.name
`,
  },

  {
    category: 'inventory',
    question:
      'How much stock is reserved and available in each warehouse overall?',
    description: 'Warehouse-level availability summary.',
    sql: `
WITH inventory_availability AS (
    SELECT
        wi."warehouseId",
        wi."onHand",
        COALESCE(SUM(r.quantity), 0) AS reserved,
        wi."onHand" - COALESCE(SUM(r.quantity), 0) AS available
    FROM "WarehouseInventory" wi
    LEFT JOIN "Reservation" r
        ON r."productId" = wi."productId"
       AND r."warehouseId" = wi."warehouseId"
       AND r.status = 'ACTIVE'
    GROUP BY
        wi.id,
        wi."warehouseId",
        wi."onHand"
)
SELECT
    w.id AS warehouse_id,
    w.name AS warehouse_name,
    SUM(ia."onHand") AS on_hand,
    SUM(ia.reserved) AS reserved,
    SUM(ia.available) AS available
FROM inventory_availability ia
JOIN "Warehouse" w ON w.id = ia."warehouseId"
WHERE w."isActive" = TRUE
GROUP BY w.id, w.name
ORDER BY w.name
`,
  },

  {
    category: 'sales',
    question: 'Which products have sold the most units?',
    description: 'Customer sales are COMPLETED OUTGOING transactions.',
    sql: `
SELECT
    p.id AS product_id,
    p.name AS product_name,
    SUM(iti.quantity) AS units_sold
FROM "InventoryTransaction" it
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
JOIN "Product" p
    ON p.id = iti."productId"
WHERE it.type = 'OUTGOING'
  AND it.status = 'COMPLETED'
GROUP BY p.id, p.name
ORDER BY units_sold DESC
LIMIT 10
`,
  },

  {
    category: 'sales',
    question: 'Which products generated the most sales revenue?',
    description:
      'Revenue uses COMPLETED OUTGOING quantity multiplied by item price.',
    sql: `
SELECT
    p.id AS product_id,
    p.name AS product_name,
    SUM(iti.quantity) AS units_sold,
    ROUND(SUM(iti.quantity * COALESCE(iti.price, 0)), 2) AS revenue
FROM "InventoryTransaction" it
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
JOIN "Product" p
    ON p.id = iti."productId"
WHERE it.type = 'OUTGOING'
  AND it.status = 'COMPLETED'
GROUP BY p.id, p.name
ORDER BY revenue DESC
LIMIT 10
`,
  },

  {
    category: 'sales',
    question: 'Who are our biggest customers by sales value?',
    description:
      'Customers are represented by partyName on OUTGOING transactions.',
    sql: `
SELECT
    it."partyName" AS customer,
    COUNT(DISTINCT it.id) AS completed_orders,
    SUM(iti.quantity) AS units_purchased,
    ROUND(SUM(iti.quantity * COALESCE(iti.price, 0)), 2) AS sales_value
FROM "InventoryTransaction" it
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
WHERE it.type = 'OUTGOING'
  AND it.status = 'COMPLETED'
  AND it."partyName" IS NOT NULL
GROUP BY it."partyName"
ORDER BY sales_value DESC
LIMIT 10
`,
  },

  {
    category: 'sales',
    question: 'Show me the order history for customer Acme.',
    description:
      'Example of filtering OUTGOING customer history using partyName.',
    sql: `
SELECT
    it.id AS transaction_id,
    it.status,
    it."createdAt",
    it."expectedDate",
    it."actualDate",
    w.name AS source_warehouse,
    SUM(iti.quantity) AS total_units,
    ROUND(SUM(iti.quantity * COALESCE(iti.price, 0)), 2) AS order_value
FROM "InventoryTransaction" it
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
LEFT JOIN "Warehouse" w
    ON w.id = it."sourceWarehouseId"
WHERE it.type = 'OUTGOING'
  AND it."partyName" ILIKE '%Acme%'
GROUP BY
    it.id,
    it.status,
    it."createdAt",
    it."expectedDate",
    it."actualDate",
    w.name
ORDER BY it."createdAt" DESC
`,
  },

  {
    category: 'sales',
    question: 'Which warehouse has shipped the most products to customers?',
    description:
      'Completed OUTGOING transactions consume stock from sourceWarehouseId.',
    sql: `
SELECT
    w.id AS warehouse_id,
    w.name AS warehouse_name,
    COUNT(DISTINCT it.id) AS completed_orders,
    SUM(iti.quantity) AS units_shipped
FROM "InventoryTransaction" it
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
JOIN "Warehouse" w
    ON w.id = it."sourceWarehouseId"
WHERE it.type = 'OUTGOING'
  AND it.status = 'COMPLETED'
GROUP BY w.id, w.name
ORDER BY units_shipped DESC
`,
  },

  {
    category: 'sales',
    question: 'Show daily sales for the last 30 days.',
    description:
      'Daily trend using completion date of completed customer sales.',
    sql: `
SELECT
    DATE(it."actualDate") AS sale_date,
    SUM(iti.quantity) AS units_sold,
    ROUND(SUM(iti.quantity * COALESCE(iti.price, 0)), 2) AS revenue
FROM "InventoryTransaction" it
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
WHERE it.type = 'OUTGOING'
  AND it.status = 'COMPLETED'
  AND it."actualDate" >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(it."actualDate")
ORDER BY sale_date
`,
  },

  {
    category: 'sales',
    question:
      'What has our monthly sales trend looked like over the last year?',
    description: 'Monthly completed OUTGOING trend.',
    sql: `
SELECT
    DATE_TRUNC('month', it."actualDate") AS month,
    SUM(iti.quantity) AS units_sold,
    ROUND(SUM(iti.quantity * COALESCE(iti.price, 0)), 2) AS revenue
FROM "InventoryTransaction" it
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
WHERE it.type = 'OUTGOING'
  AND it.status = 'COMPLETED'
  AND it."actualDate" >=
      DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '11 months'
GROUP BY DATE_TRUNC('month', it."actualDate")
ORDER BY month
`,
  },

  {
    category: 'sales',
    question: 'Which countries receive the most customer orders?',
    description:
      'OUTGOING deliveryCountry represents the customer delivery destination.',
    sql: `
SELECT
    it."deliveryCountry" AS country,
    COUNT(DISTINCT it.id) AS orders,
    SUM(iti.quantity) AS units_shipped,
    ROUND(SUM(iti.quantity * COALESCE(iti.price, 0)), 2) AS sales_value
FROM "InventoryTransaction" it
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
WHERE it.type = 'OUTGOING'
  AND it.status = 'COMPLETED'
  AND it."deliveryCountry" IS NOT NULL
GROUP BY it."deliveryCountry"
ORDER BY orders DESC
`,
  },

  {
    category: 'purchasing',
    question: 'How many units has each supplier delivered to us?',
    description:
      'Supplier purchases are COMPLETED INCOMING transactions linked by supplierId.',
    sql: `
SELECT
    s.id AS supplier_id,
    s.name AS supplier_name,
    SUM(iti.quantity) AS units_received
FROM "InventoryTransaction" it
JOIN "Supplier" s
    ON s.id = it."supplierId"
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
WHERE it.type = 'INCOMING'
  AND it.status = 'COMPLETED'
GROUP BY s.id, s.name
ORDER BY units_received DESC
`,
  },

  {
    category: 'purchasing',
    question: 'How much have we spent with each supplier?',
    description:
      'Historical supplier spend based on completed incoming item quantities and prices.',
    sql: `
SELECT
    s.id AS supplier_id,
    s.name AS supplier_name,
    COUNT(DISTINCT it.id) AS deliveries,
    ROUND(SUM(iti.quantity * COALESCE(iti.price, 0)), 2) AS total_spend
FROM "InventoryTransaction" it
JOIN "Supplier" s
    ON s.id = it."supplierId"
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
WHERE it.type = 'INCOMING'
  AND it.status = 'COMPLETED'
GROUP BY s.id, s.name
ORDER BY total_spend DESC
`,
  },

  {
    category: 'purchasing',
    question: 'What average price has each supplier charged for each product?',
    description:
      'Compare historical completed incoming unit prices without applying supplier-ranking business logic.',
    sql: `
SELECT
    s.id AS supplier_id,
    s.name AS supplier_name,
    p.id AS product_id,
    p.name AS product_name,
    ROUND(AVG(iti.price), 2) AS average_unit_price,
    SUM(iti.quantity) AS units_received
FROM "InventoryTransaction" it
JOIN "Supplier" s
    ON s.id = it."supplierId"
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
JOIN "Product" p
    ON p.id = iti."productId"
WHERE it.type = 'INCOMING'
  AND it.status = 'COMPLETED'
  AND iti.price IS NOT NULL
GROUP BY
    s.id,
    s.name,
    p.id,
    p.name
ORDER BY p.name, average_unit_price
`,
  },

  {
    category: 'purchasing',
    question:
      'What incoming deliveries are still pending and when are they expected?',
    description:
      'Future supplier deliveries are PENDING INCOMING transactions, not PurchaseOrder records.',
    sql: `
SELECT
    it.id AS transaction_id,
    s.name AS supplier_name,
    w.name AS destination_warehouse,
    it."expectedDate",
    SUM(iti.quantity) AS expected_units
FROM "InventoryTransaction" it
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
LEFT JOIN "Supplier" s
    ON s.id = it."supplierId"
LEFT JOIN "Warehouse" w
    ON w.id = it."destinationWarehouseId"
WHERE it.type = 'INCOMING'
  AND it.status = 'PENDING'
GROUP BY
    it.id,
    s.name,
    w.name,
    it."expectedDate"
ORDER BY it."expectedDate" NULLS LAST
`,
  },

  {
    category: 'purchasing',
    question: 'Which supplier deliveries are overdue?',
    description:
      'An overdue incoming delivery is a PENDING INCOMING transaction whose expectedDate has passed.',
    sql: `
SELECT
    it.id AS transaction_id,
    s.name AS supplier_name,
    w.name AS destination_warehouse,
    it."expectedDate",
    CURRENT_TIMESTAMP - it."expectedDate" AS overdue_by
FROM "InventoryTransaction" it
LEFT JOIN "Supplier" s
    ON s.id = it."supplierId"
LEFT JOIN "Warehouse" w
    ON w.id = it."destinationWarehouseId"
WHERE it.type = 'INCOMING'
  AND it.status = 'PENDING'
  AND it."expectedDate" IS NOT NULL
  AND it."expectedDate" < CURRENT_TIMESTAMP
ORDER BY it."expectedDate"
`,
  },

  {
    category: 'reservations',
    question: 'Show all active stock reservations.',
    description:
      'Reservations belong to a specific product and source warehouse and reference a transaction.',
    sql: `
SELECT
    r.id AS reservation_id,
    p.name AS product_name,
    w.name AS warehouse_name,
    r.quantity,
    it.id AS transaction_id,
    it.type AS transaction_type,
    it."partyName",
    it."expectedDate",
    r."createdAt"
FROM "Reservation" r
JOIN "Product" p
    ON p.id = r."productId"
JOIN "Warehouse" w
    ON w.id = r."warehouseId"
JOIN "InventoryTransaction" it
    ON it.id = r."transactionId"
WHERE r.status = 'ACTIVE'
ORDER BY r."createdAt"
`,
  },

  {
    category: 'reservations',
    question:
      'How many units of each product are currently reserved in each warehouse?',
    description: 'Only ACTIVE reservations reduce available stock.',
    sql: `
SELECT
    p.id AS product_id,
    p.name AS product_name,
    w.id AS warehouse_id,
    w.name AS warehouse_name,
    SUM(r.quantity) AS reserved_quantity
FROM "Reservation" r
JOIN "Product" p
    ON p.id = r."productId"
JOIN "Warehouse" w
    ON w.id = r."warehouseId"
WHERE r.status = 'ACTIVE'
GROUP BY
    p.id,
    p.name,
    w.id,
    w.name
ORDER BY reserved_quantity DESC
`,
  },

  {
    category: 'reservations',
    question: 'Which customer orders currently have stock reserved?',
    description:
      'Customer reservations belong to PENDING OUTGOING transactions.',
    sql: `
SELECT
    it.id AS transaction_id,
    it."partyName" AS customer,
    it."expectedDate",
    w.name AS source_warehouse,
    SUM(r.quantity) AS reserved_units
FROM "Reservation" r
JOIN "InventoryTransaction" it
    ON it.id = r."transactionId"
JOIN "Warehouse" w
    ON w.id = r."warehouseId"
WHERE r.status = 'ACTIVE'
  AND it.type = 'OUTGOING'
  AND it.status = 'PENDING'
GROUP BY
    it.id,
    it."partyName",
    it."expectedDate",
    w.name
ORDER BY it."expectedDate" NULLS LAST
`,
  },

  {
    category: 'reservations',
    question: 'Which pending warehouse transfers currently reserve stock?',
    description:
      'A pending transfer reserves stock only at its source warehouse.',
    sql: `
SELECT
    it.id AS transaction_id,
    source.name AS source_warehouse,
    destination.name AS destination_warehouse,
    p.name AS product_name,
    r.quantity AS reserved_quantity,
    it."expectedDate"
FROM "Reservation" r
JOIN "InventoryTransaction" it
    ON it.id = r."transactionId"
JOIN "Product" p
    ON p.id = r."productId"
JOIN "Warehouse" source
    ON source.id = r."warehouseId"
LEFT JOIN "Warehouse" destination
    ON destination.id = it."destinationWarehouseId"
WHERE r.status = 'ACTIVE'
  AND it.type = 'TRANSFER'
  AND it.status = 'PENDING'
ORDER BY it."expectedDate" NULLS LAST
`,
  },

  {
    category: 'warehouse_transfer',
    question: 'Which warehouse transfers are currently pending?',
    description:
      'There is no separate in-transit model; pending transfers are PENDING TRANSFER transactions.',
    sql: `
SELECT
    it.id AS transaction_id,
    source.name AS source_warehouse,
    destination.name AS destination_warehouse,
    it."expectedDate",
    SUM(iti.quantity) AS units_to_transfer
FROM "InventoryTransaction" it
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
LEFT JOIN "Warehouse" source
    ON source.id = it."sourceWarehouseId"
LEFT JOIN "Warehouse" destination
    ON destination.id = it."destinationWarehouseId"
WHERE it.type = 'TRANSFER'
  AND it.status = 'PENDING'
GROUP BY
    it.id,
    source.name,
    destination.name,
    it."expectedDate"
ORDER BY it."expectedDate" NULLS LAST
`,
  },

  {
    category: 'warehouse_transfer',
    question: 'Show warehouse transfers completed in the last 30 days.',
    description: 'Recent completed internal transfers.',
    sql: `
SELECT
    it.id AS transaction_id,
    source.name AS source_warehouse,
    destination.name AS destination_warehouse,
    it."actualDate",
    SUM(iti.quantity) AS units_transferred
FROM "InventoryTransaction" it
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
LEFT JOIN "Warehouse" source
    ON source.id = it."sourceWarehouseId"
LEFT JOIN "Warehouse" destination
    ON destination.id = it."destinationWarehouseId"
WHERE it.type = 'TRANSFER'
  AND it.status = 'COMPLETED'
  AND it."actualDate" >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY
    it.id,
    source.name,
    destination.name,
    it."actualDate"
ORDER BY it."actualDate" DESC
`,
  },

  {
    category: 'warehouse_transfer',
    question: 'Between which warehouses do we transfer the most stock?',
    description:
      'Aggregate completed transfer quantities by source and destination warehouse.',
    sql: `
SELECT
    source.name AS source_warehouse,
    destination.name AS destination_warehouse,
    COUNT(DISTINCT it.id) AS completed_transfers,
    SUM(iti.quantity) AS units_transferred
FROM "InventoryTransaction" it
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
JOIN "Warehouse" source
    ON source.id = it."sourceWarehouseId"
JOIN "Warehouse" destination
    ON destination.id = it."destinationWarehouseId"
WHERE it.type = 'TRANSFER'
  AND it.status = 'COMPLETED'
GROUP BY
    source.id,
    source.name,
    destination.id,
    destination.name
ORDER BY units_transferred DESC
`,
  },

  {
    category: 'warehouse_transfer',
    question: 'Which products are transferred between warehouses most often?',
    description: 'Internal transfers are not customer sales.',
    sql: `
SELECT
    p.id AS product_id,
    p.name AS product_name,
    COUNT(DISTINCT it.id) AS transfer_count,
    SUM(iti.quantity) AS units_transferred
FROM "InventoryTransaction" it
JOIN "InventoryTransactionItem" iti
    ON iti."transactionId" = it.id
JOIN "Product" p
    ON p.id = iti."productId"
WHERE it.type = 'TRANSFER'
  AND it.status = 'COMPLETED'
GROUP BY p.id, p.name
ORDER BY units_transferred DESC
LIMIT 10
`,
  },

  {
    category: 'warehouse_transfer',
    question: 'Which warehouses are more than 80 percent full?',
    description:
      'Warehouse capacity uses physical onHand stock, not available stock.',
    sql: `
SELECT
    w.id AS warehouse_id,
    w.name AS warehouse_name,
    w."maxCapacity",
    COALESCE(SUM(wi."onHand"), 0) AS current_stock,
    ROUND(
        100.0 * COALESCE(SUM(wi."onHand"), 0)
        / NULLIF(w."maxCapacity", 0),
        2
    ) AS utilization_percent
FROM "Warehouse" w
LEFT JOIN "WarehouseInventory" wi
    ON wi."warehouseId" = w.id
WHERE w."isActive" = TRUE
  AND w."maxCapacity" IS NOT NULL
GROUP BY w.id, w.name, w."maxCapacity"
HAVING
    100.0 * COALESCE(SUM(wi."onHand"), 0)
    / NULLIF(w."maxCapacity", 0) >= 80
ORDER BY utilization_percent DESC
`,
  },

  {
    category: 'warehouse_transfer',
    question: 'How much unused physical capacity does each warehouse have?',
    description: 'Capacity is based on physical onHand inventory.',
    sql: `
SELECT
    w.id AS warehouse_id,
    w.name AS warehouse_name,
    w."maxCapacity",
    COALESCE(SUM(wi."onHand"), 0) AS current_stock,
    w."maxCapacity" - COALESCE(SUM(wi."onHand"), 0) AS remaining_capacity
FROM "Warehouse" w
LEFT JOIN "WarehouseInventory" wi
    ON wi."warehouseId" = w.id
WHERE w."isActive" = TRUE
  AND w."maxCapacity" IS NOT NULL
GROUP BY w.id, w.name, w."maxCapacity"
ORDER BY remaining_capacity
`,
  },

  {
    category: 'history',
    question: 'Show the full stock movement history for Laptop.',
    description:
      'StockMovement is the authoritative inventory movement ledger.',
    sql: `
SELECT
    sm.id AS movement_id,
    sm."createdAt",
    sm.type,
    sm.quantity,
    p.name AS product_name,
    w.name AS warehouse_name,
    sm."transactionId"
FROM "StockMovement" sm
JOIN "Product" p
    ON p.id = sm."productId"
JOIN "Warehouse" w
    ON w.id = sm."warehouseId"
WHERE p.name ILIKE '%Laptop%'
ORDER BY sm."createdAt" DESC
`,
  },

  {
    category: 'history',
    question:
      'How much inventory movement occurred in each warehouse during the last 30 days?',
    description:
      'Summarize raw movement quantity by warehouse and movement type; direction is determined by the movement type.',
    sql: `
SELECT
    w.id AS warehouse_id,
    w.name AS warehouse_name,
    sm.type AS movement_type,
    SUM(sm.quantity) AS movement_quantity
FROM "StockMovement" sm
JOIN "Warehouse" w
    ON w.id = sm."warehouseId"
WHERE sm."createdAt" >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY
    w.id,
    w.name,
    sm.type
ORDER BY w.name, sm.type
`,
  },

  {
    category: 'history',
    question: 'Does the current inventory match the stock movement ledger?',
    description:
      'Integrity check comparing WarehouseInventory.onHand with the type-aware net StockMovement ledger.',
    sql: `
SELECT
    p.id AS product_id,
    p.name AS product_name,
    w.id AS warehouse_id,
    w.name AS warehouse_name,
    wi."onHand" AS recorded_on_hand,
    COALESCE(
        SUM(
            CASE
                WHEN sm.type IN ('INCOMING', 'TRANSFER_IN')
                    THEN sm.quantity
                WHEN sm.type IN ('OUTGOING', 'TRANSFER_OUT')
                    THEN -sm.quantity
                WHEN sm.type = 'ADJUSTMENT'
                    THEN sm.quantity
                ELSE 0
            END
        ),
        0
    ) AS ledger_on_hand,
    wi."onHand" - COALESCE(
        SUM(
            CASE
                WHEN sm.type IN ('INCOMING', 'TRANSFER_IN')
                    THEN sm.quantity
                WHEN sm.type IN ('OUTGOING', 'TRANSFER_OUT')
                    THEN -sm.quantity
                WHEN sm.type = 'ADJUSTMENT'
                    THEN sm.quantity
                ELSE 0
            END
        ),
        0
    ) AS difference
FROM "WarehouseInventory" wi
JOIN "Product" p
    ON p.id = wi."productId"
JOIN "Warehouse" w
    ON w.id = wi."warehouseId"
LEFT JOIN "StockMovement" sm
    ON sm."productId" = wi."productId"
   AND sm."warehouseId" = wi."warehouseId"
GROUP BY
    p.id,
    p.name,
    w.id,
    w.name,
    wi."onHand"
HAVING wi."onHand" <> COALESCE(
    SUM(
        CASE
            WHEN sm.type IN ('INCOMING', 'TRANSFER_IN')
                THEN sm.quantity
            WHEN sm.type IN ('OUTGOING', 'TRANSFER_OUT')
                THEN -sm.quantity
            WHEN sm.type = 'ADJUSTMENT'
                THEN sm.quantity
            ELSE 0
        END
    ),
    0
)
ORDER BY ABS(
    wi."onHand" - COALESCE(
        SUM(
            CASE
                WHEN sm.type IN ('INCOMING', 'TRANSFER_IN')
                    THEN sm.quantity
                WHEN sm.type IN ('OUTGOING', 'TRANSFER_OUT')
                    THEN -sm.quantity
                WHEN sm.type = 'ADJUSTMENT'
                    THEN sm.quantity
                ELSE 0
            END
        ),
        0
    )
) DESC
`,
  },

  {
    category: 'history',
    question: 'How many transactions do we have of each type and status?',
    description:
      'General transaction summary across incoming, outgoing, and transfer transactions.',
    sql: `
SELECT
    type,
    status,
    COUNT(*) AS transaction_count
FROM "InventoryTransaction"
GROUP BY type, status
ORDER BY type, status
`,
  },

  {
    category: 'history',
    question: 'Show recently cancelled inventory transactions.',
    description: 'Inspect cancelled transactions without changing any data.',
    sql: `
SELECT
    it.id AS transaction_id,
    it.type,
    it.status,
    it."partyName",
    s.name AS supplier_name,
    it."sourceWarehouseId",
    it."destinationWarehouseId",
    it."expectedDate",
    it."updatedAt"
FROM "InventoryTransaction" it
LEFT JOIN "Supplier" s
    ON s.id = it."supplierId"
WHERE it.status = 'CANCELLED'
ORDER BY it."updatedAt" DESC
LIMIT 50
`,
  },

  {
    category: 'history',
    question:
      'When was each product last sold and last received from a supplier?',
    description:
      'Compare each product latest completed OUTGOING and INCOMING transaction dates.',
    sql: `
SELECT
    p.id AS product_id,
    p.name AS product_name,
    MAX(it."actualDate")
        FILTER (
            WHERE it.type = 'OUTGOING'
              AND it.status = 'COMPLETED'
        ) AS last_sold_at,
    MAX(it."actualDate")
        FILTER (
            WHERE it.type = 'INCOMING'
              AND it.status = 'COMPLETED'
        ) AS last_received_at
FROM "Product" p
LEFT JOIN "InventoryTransactionItem" iti
    ON iti."productId" = p.id
LEFT JOIN "InventoryTransaction" it
    ON it.id = iti."transactionId"
GROUP BY p.id, p.name
ORDER BY p.name
`,
  },

  {
    category: 'history',
    question: 'Show every inventory transaction involving Laptop.',
    description:
      'Flexible product history across incoming, outgoing, and transfer transaction types.',
    sql: `
SELECT
    it.id AS transaction_id,
    it.type,
    it.status,
    iti.quantity,
    iti.price,
    it."partyName",
    s.name AS supplier_name,
    it."sourceWarehouseId",
    it."destinationWarehouseId",
    it."expectedDate",
    it."actualDate",
    it."createdAt"
FROM "InventoryTransactionItem" iti
JOIN "InventoryTransaction" it
    ON it.id = iti."transactionId"
JOIN "Product" p
    ON p.id = iti."productId"
LEFT JOIN "Supplier" s
    ON s.id = it."supplierId"
WHERE p.name ILIKE '%Laptop%'
ORDER BY it."createdAt" DESC
`,
  },

  {
    category: 'history',
    question:
      'What was the net stock change for each product and warehouse during the last 30 days?',
    description:
      'Calculate net inventory change by applying direction from StockMovement.type.',
    sql: `
SELECT
    p.id AS product_id,
    p.name AS product_name,
    w.id AS warehouse_id,
    w.name AS warehouse_name,
    SUM(
        CASE
            WHEN sm.type IN ('INCOMING', 'TRANSFER_IN')
                THEN sm.quantity
            WHEN sm.type IN ('OUTGOING', 'TRANSFER_OUT')
                THEN -sm.quantity
            WHEN sm.type = 'ADJUSTMENT'
                THEN sm.quantity
            ELSE 0
        END
    ) AS net_stock_change
FROM "StockMovement" sm
JOIN "Product" p
    ON p.id = sm."productId"
JOIN "Warehouse" w
    ON w.id = sm."warehouseId"
WHERE sm."createdAt" >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY
    p.id,
    p.name,
    w.id,
    w.name
ORDER BY ABS(
    SUM(
        CASE
            WHEN sm.type IN ('INCOMING', 'TRANSFER_IN')
                THEN sm.quantity
            WHEN sm.type IN ('OUTGOING', 'TRANSFER_OUT')
                THEN -sm.quantity
            WHEN sm.type = 'ADJUSTMENT'
                THEN sm.quantity
            ELSE 0
        END
    )
) DESC
`,
  },
];

async function main() {
  console.log('🌱 Seeding query examples...');

  await prisma.queryExample.deleteMany();

  for (const example of QUERY_EXAMPLES) {
    await prisma.queryExample.create({
      data: {
        question: example.question,
        sqlQuery: example.sql,
        category: example.category,
        description: example.description,
      },
    });
  }

  const count = await prisma.queryExample.count();

  console.log(`✅ Seeded ${count} query examples`);
}

main()
  .catch((error) => {
    console.error('❌ QueryExample seed failed');
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
