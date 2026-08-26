import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  UserRole,
  InventoryTransactionType,
  InventoryTransactionStatus,
  StockMovementType,
  ReservationStatus,
  DocumentReviewStatus,
} from '../generated/prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function daysFromNow(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

async function main() {
  console.log('🌱 Starting seed...');

  // ---------------------------------------------------
  // 1. CLEAN DATABASE
  // ---------------------------------------------------

  await prisma.pendingDocumentReview.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.stockMovement.deleteMany();
  await prisma.inventoryTransactionItem.deleteMany();
  await prisma.inventoryTransaction.deleteMany();
  await prisma.warehouseInventory.deleteMany();
  await prisma.product.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.warehouse.deleteMany();
  await prisma.user.deleteMany();

  console.log('🧹 Existing data cleared');

  // ---------------------------------------------------
  // 2. USERS
  // ---------------------------------------------------
  // NOTE: this section is deliberately untouched by the seed redesign below.
  // These are real Cognito-linked identities (the two env-gated dev/service
  // accounts plus three real teammates' hardcoded sub/username pairs,
  // confirmed against the eu-west-1_mEm3nENz8 user pool) — deleting and
  // recreating them with the SAME hardcoded values on every seed run is
  // safe (Cognito itself is never touched, only this mirrored Postgres
  // row), but the values themselves must never be changed or dropped here.

  const cognitoIdentity = (key: string, fallback: string) => {
    const value = process.env[key];
    if (value) return value;
    if (
      process.env.NODE_ENV?.toLowerCase() === 'production' ||
      process.env.APP_ENV?.toLowerCase() === 'production'
    ) {
      throw new Error(`${key} is required when seeding production`);
    }
    console.warn(`${key} is unset; using an explicit non-authenticating development mapping`);
    return fallback;
  };

  const admin = await prisma.user.create({
    data: {
      cognitoSub: cognitoIdentity('SEED_ADMIN_COGNITO_SUB', 'UNMAPPED_DEV_ADMIN_SUB'),
      cognitoUsername: cognitoIdentity(
        'SEED_ADMIN_COGNITO_USERNAME',
        'UNMAPPED_DEV_ADMIN_USERNAME',
      ),
      name: 'Admin User',
      email: 'admin@minierp.com',
      role: UserRole.ADMIN,
    },
  });

  const employee = await prisma.user.create({
    data: {
      cognitoSub: cognitoIdentity('SEED_EMPLOYEE_COGNITO_SUB', 'UNMAPPED_DEV_EMPLOYEE_SUB'),
      cognitoUsername: cognitoIdentity(
        'SEED_EMPLOYEE_COGNITO_USERNAME',
        'UNMAPPED_DEV_EMPLOYEE_USERNAME',
      ),
      name: 'Employee User',
      email: 'employee@minierp.com',
      role: UserRole.EMPLOYEE,
    },
  });

  // AI layer's own Cognito service account (see ai-agent/backend_client.py).
  // EMPLOYEE role, deliberately least-privilege: every AI tool call is a
  // read (or a proposal a human still confirms), so this account has no
  const aiServiceAccount = await prisma.user.create({
    data: {
      cognitoSub: cognitoIdentity(
        'AI_SERVICE_COGNITO_SUB',
        'UNMAPPED_DEV_AI_SERVICE_SUB',
      ),
      cognitoUsername: cognitoIdentity(
        'AI_SERVICE_COGNITO_USERNAME',
        'UNMAPPED_DEV_AI_SERVICE_USERNAME',
      ),
      name: 'AI Agent Service Account',
      email: 'ai-agent@internal.local',
      role: UserRole.EMPLOYEE,
    },
  });

  // Real personal Cognito accounts for the people actively working on this
  // repo (confirmed against the eu-west-1_mEm3nENz8 user pool) - hardcoded
  // rather than env-var-gated like ADMIN/EMPLOYEE above, because these are
  // the same three specific people on every machine that runs this seed,
  // not "whoever is testing locally" placeholders.

  await prisma.user.create({
    data: {
      cognitoSub: 'b2c55464-6021-7079-5a90-5b9782aedf4e',
      cognitoUsername: 'erp-b1b0a928-e398-4a2e-b7ef-58f13e3f6bfd',
      name: 'Salman Bou Diab',
      email: 'salmanbudiab@gmail.com',
      role: UserRole.ADMIN,
    },
  });

  await prisma.user.create({
    data: {
      cognitoSub: 'd215e444-50a1-705d-8839-a544d73556a3',
      cognitoUsername: 'erp-0f61390c-e65f-482c-b8a6-c4b8a0ea157d',
      name: 'Ribal Saleh',
      email: 'rribalsaleh@gmail.com',
      role: UserRole.EMPLOYEE,
    },
  });

  await prisma.user.create({
    data: {
      cognitoSub: '1295a424-10d1-702e-5d28-4b028ef7bc23',
      cognitoUsername: 'erp-d34084db-bf3f-451d-9d8e-b0872c053633',
      name: 'Joseph Chahine',
      email: 'josephchahine@gmail.com',
      role: UserRole.EMPLOYEE,
    },
  });

  // ---------------------------------------------------
  // 3. SUPPLIERS
  // ---------------------------------------------------
  // One supplier per product family, plus TechSource/Cedar Electronics both
  // competing on Laptop Pro 14 so supplier ranking has real signal to compare.

  const techSource = await prisma.supplier.create({
    data: { name: 'TechSource Lebanon', email: 'sales@techsource.com', leadTimeDays: 5 },
  });

  const cedarElectronics = await prisma.supplier.create({
    data: { name: 'Cedar Electronics', email: 'orders@cedarelectronics.com', leadTimeDays: 4 },
  });

  const campusSupply = await prisma.supplier.create({
    data: { name: 'Campus Supply Co', email: 'orders@campussupply.com', leadTimeDays: 6 },
  });

  const beirutTextiles = await prisma.supplier.create({
    data: { name: 'Beirut Textiles', email: 'sales@beiruttextiles.com', leadTimeDays: 7 },
  });

  const cedarHomeOffice = await prisma.supplier.create({
    data: { name: 'Cedar Home & Office', email: 'sales@cedarhomeoffice.com', leadTimeDays: 12 },
  });

  // Third Laptop Pro 14 competitor, purely so the supplier-ranking test has
  // three suppliers (not two) — with exactly two candidates, min-max
  // normalization always produces a flat 100/0 split on every factor; a
  // third, "middle" supplier is what makes the weighted formula actually
  // show a graded, realistic comparison.
  const levantTrading = await prisma.supplier.create({
    data: { name: 'Levant Trading', email: 'contact@levanttrading.com', leadTimeDays: 8 },
  });

  // ---------------------------------------------------
  // 4. PRODUCTS
  // ---------------------------------------------------
  // Exactly 4 categories, ~one clear item each (no color/size variants).
  // Product has no dedicated sku/cost/price columns in the schema — a short
  // SKU tag is folded into `description` (a real, displayed field) instead
  // of inventing new columns; cost/selling price live consistently on each
  // transaction item instead (see PRICE table below), since that IS how
  // this schema models price (per InventoryTransactionItem, not per Product).

  const laptop = await prisma.product.create({
    data: { name: 'Laptop Pro 14', category: 'Electronics', description: 'SKU: ELEC-LAPTOP14 — 14-inch business laptop' },
  });
  const headphones = await prisma.product.create({
    data: { name: 'Wireless Headphones', category: 'Electronics', description: 'SKU: ELEC-HEADPH — Over-ear wireless headphones' },
  });
  const keyboard = await prisma.product.create({
    data: { name: 'Mechanical Keyboard', category: 'Electronics', description: 'SKU: ELEC-KEYBD — Mechanical keyboard, tactile switches' },
  });
  const monitor = await prisma.product.create({
    data: { name: '27-inch Monitor', category: 'Electronics', description: 'SKU: ELEC-MON27 — 27-inch IPS monitor' },
  });
  const mouse = await prisma.product.create({
    data: { name: 'Wireless Mouse', category: 'Electronics', description: 'SKU: ELEC-MOUSE — Wireless optical mouse' },
  });

  const tshirt = await prisma.product.create({
    data: { name: 'Cotton T-Shirt', category: 'Apparel', description: 'SKU: APP-TSHIRT — Unisex cotton crew-neck t-shirt' },
  });
  const hoodie = await prisma.product.create({
    data: { name: 'Hooded Sweatshirt', category: 'Apparel', description: 'SKU: APP-HOODIE — Fleece-lined hooded sweatshirt' },
  });

  const notebook = await prisma.product.create({
    data: { name: 'Notebook Set', category: 'School & University Supplies', description: 'SKU: SCH-NOTEBK — 3-pack ruled notebooks' },
  });
  const backpack = await prisma.product.create({
    data: { name: 'Backpack', category: 'School & University Supplies', description: 'SKU: SCH-BAGPK — Laptop-compatible campus backpack' },
  });
  const calculator = await prisma.product.create({
    data: { name: 'Scientific Calculator', category: 'School & University Supplies', description: 'SKU: SCH-CALC — Scientific calculator' },
  });

  // No `category` set — the frontend/analytics already treat a null/empty
  // category as "Uncategorized" everywhere (e.g. InventoryPage's
  // `category?.trim() || "Uncategorized"`), so this is the literal "4th
  // category" rather than a fabricated string that only some code paths
  // would recognize.
  const chair = await prisma.product.create({
    data: { name: 'Office Chair', description: 'SKU: MISC-CHAIR — Ergonomic office chair' },
  });

  // Consistent base cost / selling price per product, applied to every
  // transaction item below — not a schema field, just a seed-time
  // convention so "what does this cost / sell for" has one stable answer.
  const SELL_PRICE: Record<number, number> = {
    [laptop.id]: 999,
    [headphones.id]: 89,
    [keyboard.id]: 79,
    [monitor.id]: 259,
    [mouse.id]: 24,
    [tshirt.id]: 15,
    [hoodie.id]: 32,
    [notebook.id]: 5,
    [backpack.id]: 19,
    [calculator.id]: 34,
  };

  // ---------------------------------------------------
  // 5. WAREHOUSES
  // ---------------------------------------------------

  const beirut = await prisma.warehouse.create({
    data: { name: 'Beirut Warehouse', location: 'Beirut, Lebanon', maxCapacity: 1200 },
  });
  const tripoli = await prisma.warehouse.create({
    data: { name: 'Tripoli Warehouse', location: 'Tripoli, Lebanon', maxCapacity: 500 },
  });
  const saida = await prisma.warehouse.create({
    data: { name: 'Saida Warehouse', location: 'Saida, Lebanon', maxCapacity: 500 },
  });

  // ---------------------------------------------------
  // HELPERS
  // ---------------------------------------------------

  /** Completed purchase (INCOMING). `lateByDays` > 0 makes actualDate land after expectedDate, for supplier on-time-rate signal. */
  async function completedIncoming(params: {
    supplierId: number;
    warehouseId: number;
    productId: number;
    quantity: number;
    price: number;
    daysAgoValue: number;
    lateByDays?: number;
  }) {
    const expected = daysAgo(params.daysAgoValue);
    const actual = params.lateByDays
      ? new Date(expected.getTime() + params.lateByDays * 24 * 60 * 60 * 1000)
      : expected;

    const transaction = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.INCOMING,
        status: InventoryTransactionStatus.COMPLETED,
        supplierId: params.supplierId,
        destinationWarehouseId: params.warehouseId,
        expectedDate: expected,
        actualDate: actual,
        createdAt: expected,
        items: { create: { productId: params.productId, quantity: params.quantity, price: params.price } },
      },
    });

    await prisma.stockMovement.create({
      data: {
        transactionId: transaction.id,
        productId: params.productId,
        warehouseId: params.warehouseId,
        type: StockMovementType.INCOMING,
        quantity: params.quantity,
        createdAt: actual,
      },
    });

    return transaction;
  }

  /** Completed sale (OUTGOING) — fulfilled reservation + OUTGOING movement, in one step (matches how a real order ends up COMPLETED). */
  async function completedOutgoing(params: {
    warehouseId: number;
    productId: number;
    quantity: number;
    daysAgoValue: number;
    customer: string;
  }) {
    const date = daysAgo(params.daysAgoValue);
    const price = SELL_PRICE[params.productId];

    const transaction = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.OUTGOING,
        status: InventoryTransactionStatus.COMPLETED,
        sourceWarehouseId: params.warehouseId,
        partyName: params.customer,
        expectedDate: date,
        actualDate: date,
        createdAt: date,
        items: { create: { productId: params.productId, quantity: params.quantity, price } },
      },
    });

    await prisma.reservation.create({
      data: {
        transactionId: transaction.id,
        productId: params.productId,
        warehouseId: params.warehouseId,
        quantity: params.quantity,
        status: ReservationStatus.FULFILLED,
        createdAt: date,
      },
    });

    await prisma.stockMovement.create({
      data: {
        transactionId: transaction.id,
        productId: params.productId,
        warehouseId: params.warehouseId,
        type: StockMovementType.OUTGOING,
        quantity: params.quantity,
        createdAt: date,
      },
    });

    return transaction;
  }

  /** Completed internal transfer — fulfilled source reservation + TRANSFER_OUT/TRANSFER_IN pair. */
  async function completedTransfer(params: {
    sourceWarehouseId: number;
    destinationWarehouseId: number;
    productId: number;
    quantity: number;
    daysAgoValue: number;
  }) {
    const date = daysAgo(params.daysAgoValue);

    const transaction = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.TRANSFER,
        status: InventoryTransactionStatus.COMPLETED,
        sourceWarehouseId: params.sourceWarehouseId,
        destinationWarehouseId: params.destinationWarehouseId,
        expectedDate: date,
        actualDate: date,
        createdAt: date,
        items: { create: { productId: params.productId, quantity: params.quantity } },
      },
    });

    await prisma.reservation.create({
      data: {
        transactionId: transaction.id,
        productId: params.productId,
        warehouseId: params.sourceWarehouseId,
        quantity: params.quantity,
        status: ReservationStatus.FULFILLED,
        createdAt: date,
      },
    });

    await prisma.stockMovement.createMany({
      data: [
        {
          transactionId: transaction.id,
          productId: params.productId,
          warehouseId: params.sourceWarehouseId,
          type: StockMovementType.TRANSFER_OUT,
          quantity: params.quantity,
          createdAt: date,
        },
        {
          transactionId: transaction.id,
          productId: params.productId,
          warehouseId: params.destinationWarehouseId,
          type: StockMovementType.TRANSFER_IN,
          quantity: params.quantity,
          createdAt: date,
        },
      ],
    });

    return transaction;
  }

  /** PENDING outgoing order — active reservation only, never touches onHand until completed. */
  async function pendingOutgoing(params: {
    warehouseId: number;
    productId: number;
    quantity: number;
    customer: string;
    expectedDate: Date;
    delivery?: { country: string; region: string; address: string };
  }) {
    const transaction = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.OUTGOING,
        status: InventoryTransactionStatus.PENDING,
        sourceWarehouseId: params.warehouseId,
        partyName: params.customer,
        deliveryCountry: params.delivery?.country,
        deliveryRegion: params.delivery?.region,
        deliveryAddress: params.delivery?.address,
        expectedDate: params.expectedDate,
        items: { create: { productId: params.productId, quantity: params.quantity, price: SELL_PRICE[params.productId] } },
      },
    });

    await prisma.reservation.create({
      data: {
        transactionId: transaction.id,
        productId: params.productId,
        warehouseId: params.warehouseId,
        quantity: params.quantity,
        status: ReservationStatus.ACTIVE,
      },
    });

    return transaction;
  }

  /** PENDING incoming purchase order — no reservation, no movement; only counts toward pendingIncomingQuantity/overdue/upcoming. */
  async function pendingIncoming(params: {
    supplierId: number;
    warehouseId: number;
    productId: number;
    quantity: number;
    price: number;
    expectedDate: Date;
  }) {
    return prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.INCOMING,
        status: InventoryTransactionStatus.PENDING,
        supplierId: params.supplierId,
        destinationWarehouseId: params.warehouseId,
        expectedDate: params.expectedDate,
        items: { create: { productId: params.productId, quantity: params.quantity, price: params.price } },
      },
    });
  }

  /** PENDING transfer — active reservation at the source only (matches createTransfer()'s real behavior). */
  async function pendingTransfer(params: {
    sourceWarehouseId: number;
    destinationWarehouseId: number;
    productId: number;
    quantity: number;
    expectedDate: Date;
  }) {
    const transaction = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.TRANSFER,
        status: InventoryTransactionStatus.PENDING,
        sourceWarehouseId: params.sourceWarehouseId,
        destinationWarehouseId: params.destinationWarehouseId,
        expectedDate: params.expectedDate,
        items: { create: { productId: params.productId, quantity: params.quantity } },
      },
    });

    await prisma.reservation.create({
      data: {
        transactionId: transaction.id,
        productId: params.productId,
        warehouseId: params.sourceWarehouseId,
        quantity: params.quantity,
        status: ReservationStatus.ACTIVE,
      },
    });

    return transaction;
  }

  // =====================================================
  // 6. LAPTOP PRO 14 — healthy stock + reserved-stock demo
  //    + supplier price/on-time comparison (TechSource vs Cedar Electronics)
  // =====================================================
  // Beirut: incoming 80+15 (TechSource, on-time) + 20 (Cedar Electronics,
  // 3 days late) = 115 → sold 8+10+10+9=37 (split evenly across the 30/60-day
  // windows so this does NOT also read as a consumption anomaly) → onHand 78.
  // Then a 40-unit active reservation: onHand(78) > reserved(40) > available(38).

  await completedIncoming({ supplierId: techSource.id, warehouseId: beirut.id, productId: laptop.id, quantity: 80, price: 780, daysAgoValue: 90 });
  await completedIncoming({ supplierId: techSource.id, warehouseId: beirut.id, productId: laptop.id, quantity: 15, price: 770, daysAgoValue: 20 });
  await completedIncoming({ supplierId: cedarElectronics.id, warehouseId: beirut.id, productId: laptop.id, quantity: 20, price: 800, daysAgoValue: 60, lateByDays: 3 });

  await completedOutgoing({ warehouseId: beirut.id, productId: laptop.id, quantity: 8, daysAgoValue: 50, customer: 'ABC Corporation' });
  await completedOutgoing({ warehouseId: beirut.id, productId: laptop.id, quantity: 10, daysAgoValue: 35, customer: 'Cedars Consulting' });
  await completedOutgoing({ warehouseId: beirut.id, productId: laptop.id, quantity: 10, daysAgoValue: 20, customer: 'North Lebanon Traders' });
  await completedOutgoing({ warehouseId: beirut.id, productId: laptop.id, quantity: 9, daysAgoValue: 5, customer: 'Future Systems' });

  await pendingOutgoing({
    warehouseId: beirut.id,
    productId: laptop.id,
    quantity: 40,
    customer: 'North Lebanon Traders',
    expectedDate: daysFromNow(3),
    delivery: { country: 'Lebanon', region: 'North Lebanon', address: 'Tripoli Port Road' },
  });

  // Tripoli / Saida: plain healthy stock, no reservations.
  await completedIncoming({ supplierId: techSource.id, warehouseId: tripoli.id, productId: laptop.id, quantity: 40, price: 790, daysAgoValue: 80 });
  await completedOutgoing({ warehouseId: tripoli.id, productId: laptop.id, quantity: 5, daysAgoValue: 20, customer: 'North Lebanon Traders' });

  await completedIncoming({ supplierId: techSource.id, warehouseId: saida.id, productId: laptop.id, quantity: 30, price: 800, daysAgoValue: 70 });
  await completedOutgoing({ warehouseId: saida.id, productId: laptop.id, quantity: 5, daysAgoValue: 18, customer: 'Saida Wholesale Group' });

  // Upcoming replenishment, healthy — just gives the calendar another entry.
  await pendingIncoming({ supplierId: techSource.id, warehouseId: beirut.id, productId: laptop.id, quantity: 40, price: 780, expectedDate: daysFromNow(5) });

  // --- Supplier-ranking test data for Laptop Pro 14 (3-way comparison) ---
  // Routed to Tripoli/Saida (not Beirut) so none of this disturbs the
  // Beirut reserved-stock numbers above — it only adds healthy surplus to
  // two warehouses that already have no Laptop deficit to speak of.
  //
  // TechSource Lebanon (existing 4 batches above): avgPrice 785, 4/4 on-time
  //   (100%), 0% cancelled, 4 completed transactions for this product.
  // Cedar Electronics: cheaper reputation undercut by being pricier AND
  //   less reliable, but highest purchase volume/history.
  await completedIncoming({ supplierId: cedarElectronics.id, warehouseId: tripoli.id, productId: laptop.id, quantity: 25, price: 820, daysAgoValue: 50 });
  await completedIncoming({ supplierId: cedarElectronics.id, warehouseId: tripoli.id, productId: laptop.id, quantity: 18, price: 810, daysAgoValue: 38, lateByDays: 5 });
  await completedIncoming({ supplierId: cedarElectronics.id, warehouseId: tripoli.id, productId: laptop.id, quantity: 22, price: 815, daysAgoValue: 25 });
  await completedIncoming({ supplierId: cedarElectronics.id, warehouseId: tripoli.id, productId: laptop.id, quantity: 16, price: 805, daysAgoValue: 12, lateByDays: 2 });
  await completedIncoming({ supplierId: cedarElectronics.id, warehouseId: tripoli.id, productId: laptop.id, quantity: 14, price: 795, daysAgoValue: 4 });
  // A cancelled Cedar order — never touches stock, but does count toward
  // cancellationRate (1/7 ≈ 14%) and is included in averagePrice per the
  // ranking service's own formula (it doesn't filter by status).
  await prisma.inventoryTransaction.create({
    data: {
      type: InventoryTransactionType.INCOMING,
      status: InventoryTransactionStatus.CANCELLED,
      supplierId: cedarElectronics.id,
      destinationWarehouseId: tripoli.id,
      expectedDate: daysAgo(15),
      items: { create: { productId: laptop.id, quantity: 15, price: 815 } },
    },
  });
  // Cedar Electronics totals for Laptop Pro 14: avgPrice ≈ 808.6 (7 priced
  // items incl. the cancelled one), onTime 3/6 = 50%, cancellationRate ≈
  // 14.3%, 6 completed transactions (highest volume of the three).

  // Levant Trading: a genuine "middle" option — priced and timed between
  // the other two, moderate volume.
  await completedIncoming({ supplierId: levantTrading.id, warehouseId: saida.id, productId: laptop.id, quantity: 20, price: 795, daysAgoValue: 55 });
  await completedIncoming({ supplierId: levantTrading.id, warehouseId: saida.id, productId: laptop.id, quantity: 18, price: 792, daysAgoValue: 40 });
  await completedIncoming({ supplierId: levantTrading.id, warehouseId: saida.id, productId: laptop.id, quantity: 20, price: 798, daysAgoValue: 22, lateByDays: 4 });
  await completedIncoming({ supplierId: levantTrading.id, warehouseId: saida.id, productId: laptop.id, quantity: 15, price: 793, daysAgoValue: 9 });
  // Levant Trading totals for Laptop Pro 14: avgPrice = 794.5, onTime 3/4 =
  // 75%, cancellationRate 0%, 4 completed transactions.

  // =====================================================
  // 7. WIRELESS HEADPHONES — the flagship transfer recommendation
  //    (Tripoli low, Saida surplus → system should recommend a transfer)
  // =====================================================
  // Beirut: incoming 33 - outgoing 8 = onHand 25 = reorderThreshold(25) exactly
  //   → OK, and NOT a donor (available - threshold = 0), so it stays neutral
  //   and doesn't split the transfer recommendation across two donors.
  await completedIncoming({ supplierId: cedarElectronics.id, warehouseId: beirut.id, productId: headphones.id, quantity: 33, price: 59, daysAgoValue: 80 });
  await completedOutgoing({ warehouseId: beirut.id, productId: headphones.id, quantity: 8, daysAgoValue: 18, customer: 'ABC Corporation' });

  // Tripoli: incoming 15 - outgoing 10 = onHand 5, threshold 25 → AT_RISK,
  //   deficit of 20, no pending incoming of its own.
  await completedIncoming({ supplierId: cedarElectronics.id, warehouseId: tripoli.id, productId: headphones.id, quantity: 15, price: 60, daysAgoValue: 75 });
  await completedOutgoing({ warehouseId: tripoli.id, productId: headphones.id, quantity: 10, daysAgoValue: 10, customer: 'North Lebanon Traders' });

  // Saida: incoming 75 - outgoing 20 = onHand 55, threshold 25 → OK,
  //   donatable surplus of 30 — comfortably covers Tripoli's 20-unit deficit.
  await completedIncoming({ supplierId: cedarElectronics.id, warehouseId: saida.id, productId: headphones.id, quantity: 75, price: 58, daysAgoValue: 70 });
  await completedOutgoing({ warehouseId: saida.id, productId: headphones.id, quantity: 20, daysAgoValue: 25, customer: 'Saida Wholesale Group' });

  // =====================================================
  // 8. MECHANICAL KEYBOARD — out-of-stock / purchase-required everywhere
  //    (no warehouse has surplus, so this needs buying, not transferring)
  // =====================================================
  // Beirut: incoming 45 - outgoing 30 = onHand 15, threshold 20 → AT_RISK.
  await completedIncoming({ supplierId: techSource.id, warehouseId: beirut.id, productId: keyboard.id, quantity: 45, price: 52, daysAgoValue: 90 });
  await completedOutgoing({ warehouseId: beirut.id, productId: keyboard.id, quantity: 18, daysAgoValue: 22, customer: 'ABC Corporation' });
  await completedOutgoing({ warehouseId: beirut.id, productId: keyboard.id, quantity: 12, daysAgoValue: 6, customer: 'BlueTech SARL' });

  // Tripoli: incoming 30 - outgoing 30 = onHand 0 → OUT_OF_STOCK. A small
  //   overdue pending incoming (5 units, 4 days late) keeps it AT_RISK even
  //   after projection, so it's still a live restock recommendation.
  await completedIncoming({ supplierId: techSource.id, warehouseId: tripoli.id, productId: keyboard.id, quantity: 30, price: 50, daysAgoValue: 75 });
  await completedOutgoing({ warehouseId: tripoli.id, productId: keyboard.id, quantity: 25, daysAgoValue: 15, customer: 'North Lebanon Traders' });
  await completedOutgoing({ warehouseId: tripoli.id, productId: keyboard.id, quantity: 5, daysAgoValue: 3, customer: 'North Lebanon Traders' });
  await pendingIncoming({ supplierId: techSource.id, warehouseId: tripoli.id, productId: keyboard.id, quantity: 5, price: 51, expectedDate: daysAgo(4) });

  // Saida: incoming 20 - outgoing 20 = onHand 0 → OUT_OF_STOCK, no pending incoming at all.
  await completedIncoming({ supplierId: techSource.id, warehouseId: saida.id, productId: keyboard.id, quantity: 20, price: 51, daysAgoValue: 70 });
  await completedOutgoing({ warehouseId: saida.id, productId: keyboard.id, quantity: 14, daysAgoValue: 12, customer: 'Saida Wholesale Group' });
  await completedOutgoing({ warehouseId: saida.id, productId: keyboard.id, quantity: 6, daysAgoValue: 4, customer: 'Saida Wholesale Group' });

  // =====================================================
  // 9. 27-INCH MONITOR — healthy everywhere, one overdue delivery
  // =====================================================
  await completedIncoming({ supplierId: techSource.id, warehouseId: beirut.id, productId: monitor.id, quantity: 70, price: 210, daysAgoValue: 90 });
  await completedOutgoing({ warehouseId: beirut.id, productId: monitor.id, quantity: 6, daysAgoValue: 35, customer: 'Beirut Retail Co' });
  await completedOutgoing({ warehouseId: beirut.id, productId: monitor.id, quantity: 9, daysAgoValue: 10, customer: 'BlueTech SARL' });

  await completedIncoming({ supplierId: techSource.id, warehouseId: tripoli.id, productId: monitor.id, quantity: 40, price: 215, daysAgoValue: 80 });
  await completedOutgoing({ warehouseId: tripoli.id, productId: monitor.id, quantity: 10, daysAgoValue: 25, customer: 'North Lebanon Traders' });
  await completedOutgoing({ warehouseId: tripoli.id, productId: monitor.id, quantity: 15, daysAgoValue: 5, customer: 'North Lebanon Traders' });
  // Overdue delivery — onHand is already fine, this is purely a calendar/overdue-alert example.
  await pendingIncoming({ supplierId: techSource.id, warehouseId: tripoli.id, productId: monitor.id, quantity: 25, price: 212, expectedDate: daysAgo(4) });

  await completedIncoming({ supplierId: techSource.id, warehouseId: saida.id, productId: monitor.id, quantity: 30, price: 205, daysAgoValue: 70 });
  await completedOutgoing({ warehouseId: saida.id, productId: monitor.id, quantity: 5, daysAgoValue: 12, customer: 'Saida Wholesale Group' });

  // =====================================================
  // 10. WIRELESS MOUSE — the consumption-anomaly demo (clear recent spike)
  // =====================================================
  // Beirut: baseline window (31-60 days ago) = 10 units; recent window
  //   (0-30 days ago) = 14 + 65 = 79 units → +690%, well past the 50% threshold.
  await completedIncoming({ supplierId: cedarElectronics.id, warehouseId: beirut.id, productId: mouse.id, quantity: 150, price: 17, daysAgoValue: 90 });
  await completedIncoming({ supplierId: cedarElectronics.id, warehouseId: beirut.id, productId: mouse.id, quantity: 70, price: 16, daysAgoValue: 20 });
  await completedOutgoing({ warehouseId: beirut.id, productId: mouse.id, quantity: 10, daysAgoValue: 40, customer: 'Cedars Consulting' });
  await completedOutgoing({ warehouseId: beirut.id, productId: mouse.id, quantity: 14, daysAgoValue: 25, customer: 'BlueTech SARL' });
  await completedOutgoing({ warehouseId: beirut.id, productId: mouse.id, quantity: 65, daysAgoValue: 2, customer: 'Mega Office SARL' });

  // A pending internal transfer out of Beirut (Beirut has plenty) — also
  // exercises "reserved but not yet completed" without threatening stock.
  await pendingTransfer({ sourceWarehouseId: beirut.id, destinationWarehouseId: tripoli.id, productId: mouse.id, quantity: 20, expectedDate: daysFromNow(2) });

  await completedIncoming({ supplierId: cedarElectronics.id, warehouseId: tripoli.id, productId: mouse.id, quantity: 90, price: 18, daysAgoValue: 80 });
  await completedOutgoing({ warehouseId: tripoli.id, productId: mouse.id, quantity: 20, daysAgoValue: 15, customer: 'North Lebanon Traders' });

  await completedIncoming({ supplierId: cedarElectronics.id, warehouseId: saida.id, productId: mouse.id, quantity: 60, price: 17, daysAgoValue: 70 });
  await completedOutgoing({ warehouseId: saida.id, productId: mouse.id, quantity: 15, daysAgoValue: 12, customer: 'Saida Wholesale Group' });

  // =====================================================
  // 11. COTTON T-SHIRT — healthy everywhere, one overdue customer order
  // =====================================================
  await completedIncoming({ supplierId: beirutTextiles.id, warehouseId: beirut.id, productId: tshirt.id, quantity: 150, price: 6, daysAgoValue: 60 });
  await completedOutgoing({ warehouseId: beirut.id, productId: tshirt.id, quantity: 15, daysAgoValue: 35, customer: 'ABC Corporation' });
  await completedOutgoing({ warehouseId: beirut.id, productId: tshirt.id, quantity: 20, daysAgoValue: 10, customer: 'North Lebanon Traders' });
  await completedOutgoing({ warehouseId: beirut.id, productId: tshirt.id, quantity: 10, daysAgoValue: 3, customer: 'Future Systems' });
  // Overdue — customer order, not yet fulfilled, expected 2 days ago.
  await pendingOutgoing({
    warehouseId: beirut.id,
    productId: tshirt.id,
    quantity: 15,
    customer: 'Beirut Retail Co',
    expectedDate: daysAgo(2),
    delivery: { country: 'Lebanon', region: 'Beirut', address: 'Hamra' },
  });

  await completedIncoming({ supplierId: beirutTextiles.id, warehouseId: tripoli.id, productId: tshirt.id, quantity: 80, price: 6.2, daysAgoValue: 55 });
  await completedOutgoing({ warehouseId: tripoli.id, productId: tshirt.id, quantity: 15, daysAgoValue: 20, customer: 'North Lebanon Traders' });

  await completedIncoming({ supplierId: beirutTextiles.id, warehouseId: saida.id, productId: tshirt.id, quantity: 60, price: 6.3, daysAgoValue: 50 });
  await completedOutgoing({ warehouseId: saida.id, productId: tshirt.id, quantity: 10, daysAgoValue: 15, customer: 'Saida Wholesale Group' });

  // =====================================================
  // 12. HOODED SWEATSHIRT — a second, plain "low stock, needs buying"
  //     example outside Electronics (Beirut only; Tripoli/Saida sit exactly
  //     at their own reorder threshold, so neither one reads as a donor)
  // =====================================================
  await completedIncoming({ supplierId: beirutTextiles.id, warehouseId: beirut.id, productId: hoodie.id, quantity: 60, price: 14, daysAgoValue: 55 });
  await completedOutgoing({ warehouseId: beirut.id, productId: hoodie.id, quantity: 15, daysAgoValue: 30, customer: 'ABC Corporation' });
  await completedOutgoing({ warehouseId: beirut.id, productId: hoodie.id, quantity: 20, daysAgoValue: 15, customer: 'North Lebanon Traders' });
  await completedOutgoing({ warehouseId: beirut.id, productId: hoodie.id, quantity: 10, daysAgoValue: 5, customer: 'Future Systems' });

  await completedIncoming({ supplierId: beirutTextiles.id, warehouseId: tripoli.id, productId: hoodie.id, quantity: 40, price: 14.2, daysAgoValue: 45 });
  await completedOutgoing({ warehouseId: tripoli.id, productId: hoodie.id, quantity: 15, daysAgoValue: 20, customer: 'North Lebanon Traders' });

  await completedIncoming({ supplierId: beirutTextiles.id, warehouseId: saida.id, productId: hoodie.id, quantity: 37, price: 14.1, daysAgoValue: 40 });
  await completedOutgoing({ warehouseId: saida.id, productId: hoodie.id, quantity: 12, daysAgoValue: 10, customer: 'Saida Wholesale Group' });

  // =====================================================
  // 13. NOTEBOOK SET — healthy, high-volume (top-selling-by-quantity candidate)
  // =====================================================
  await completedIncoming({ supplierId: campusSupply.id, warehouseId: beirut.id, productId: notebook.id, quantity: 300, price: 2, daysAgoValue: 60 });
  await completedOutgoing({ warehouseId: beirut.id, productId: notebook.id, quantity: 60, daysAgoValue: 20, customer: 'Mount Lebanon University' });
  await completedOutgoing({ warehouseId: beirut.id, productId: notebook.id, quantity: 30, daysAgoValue: 6, customer: 'ABC Corporation' });

  await completedIncoming({ supplierId: campusSupply.id, warehouseId: tripoli.id, productId: notebook.id, quantity: 120, price: 2.1, daysAgoValue: 45 });
  await completedOutgoing({ warehouseId: tripoli.id, productId: notebook.id, quantity: 30, daysAgoValue: 15, customer: 'North Lebanon Traders' });

  await completedIncoming({ supplierId: campusSupply.id, warehouseId: saida.id, productId: notebook.id, quantity: 100, price: 2.05, daysAgoValue: 40 });
  await completedOutgoing({ warehouseId: saida.id, productId: notebook.id, quantity: 25, daysAgoValue: 10, customer: 'Saida Wholesale Group' });
  // Upcoming order — stays comfortably above reorderThreshold, just gives the calendar another "upcoming" entry.
  await pendingOutgoing({
    warehouseId: saida.id,
    productId: notebook.id,
    quantity: 20,
    customer: 'Saida Wholesale Group',
    expectedDate: daysFromNow(2),
    delivery: { country: 'Lebanon', region: 'South Lebanon', address: 'Saida Old Souk' },
  });

  // =====================================================
  // 14. BACKPACK — healthy, includes one COMPLETED transfer (history)
  //     and one CANCELLED order (status coverage)
  // =====================================================
  await completedIncoming({ supplierId: campusSupply.id, warehouseId: beirut.id, productId: backpack.id, quantity: 80, price: 8, daysAgoValue: 55 });
  await completedOutgoing({ warehouseId: beirut.id, productId: backpack.id, quantity: 20, daysAgoValue: 18, customer: 'Mount Lebanon University' });
  await completedOutgoing({ warehouseId: beirut.id, productId: backpack.id, quantity: 5, daysAgoValue: 6, customer: 'ABC Corporation' });
  await completedTransfer({ sourceWarehouseId: beirut.id, destinationWarehouseId: tripoli.id, productId: backpack.id, quantity: 10, daysAgoValue: 8 });

  await completedIncoming({ supplierId: campusSupply.id, warehouseId: tripoli.id, productId: backpack.id, quantity: 40, price: 8.2, daysAgoValue: 40 });
  await completedOutgoing({ warehouseId: tripoli.id, productId: backpack.id, quantity: 10, daysAgoValue: 12, customer: 'North Lebanon Traders' });

  await completedIncoming({ supplierId: campusSupply.id, warehouseId: saida.id, productId: backpack.id, quantity: 35, price: 8.1, daysAgoValue: 35 });
  await completedOutgoing({ warehouseId: saida.id, productId: backpack.id, quantity: 8, daysAgoValue: 9, customer: 'Saida Wholesale Group' });

  const cancelledBackpackOrder = await prisma.inventoryTransaction.create({
    data: {
      type: InventoryTransactionType.OUTGOING,
      status: InventoryTransactionStatus.CANCELLED,
      sourceWarehouseId: saida.id,
      partyName: 'Saida Wholesale Group',
      expectedDate: daysAgo(3),
      items: { create: { productId: backpack.id, quantity: 10, price: SELL_PRICE[backpack.id] } },
    },
  });
  await prisma.reservation.create({
    data: {
      transactionId: cancelledBackpackOrder.id,
      productId: backpack.id,
      warehouseId: saida.id,
      quantity: 10,
      status: ReservationStatus.CANCELLED,
      createdAt: daysAgo(3),
    },
  });

  // =====================================================
  // 15. SCIENTIFIC CALCULATOR — plain healthy baseline, boring on purpose
  // =====================================================
  await completedIncoming({ supplierId: campusSupply.id, warehouseId: beirut.id, productId: calculator.id, quantity: 60, price: 18, daysAgoValue: 50 });
  await completedOutgoing({ warehouseId: beirut.id, productId: calculator.id, quantity: 20, daysAgoValue: 15, customer: 'Mount Lebanon University' });

  await completedIncoming({ supplierId: campusSupply.id, warehouseId: tripoli.id, productId: calculator.id, quantity: 25, price: 18.5, daysAgoValue: 35 });
  await completedOutgoing({ warehouseId: tripoli.id, productId: calculator.id, quantity: 8, daysAgoValue: 10, customer: 'North Lebanon Traders' });

  await completedIncoming({ supplierId: campusSupply.id, warehouseId: saida.id, productId: calculator.id, quantity: 20, price: 18.3, daysAgoValue: 30 });
  await completedOutgoing({ warehouseId: saida.id, productId: calculator.id, quantity: 5, daysAgoValue: 8, customer: 'Saida Wholesale Group' });

  // =====================================================
  // 16. OFFICE CHAIR (Uncategorized) — the dead-stock flagship
  //     Bought once, 120 days ago, never sold since → dead stock by the
  //     ACTUAL rule (onHand > 0 and no OUTGOING movement ever/in 60+ days).
  //     Only stocked at Beirut; Tripoli/Saida stay at 0 (never dead stock —
  //     the real getDeadStock() only flags onHand > 0 rows).
  // =====================================================
  await completedIncoming({ supplierId: cedarHomeOffice.id, warehouseId: beirut.id, productId: chair.id, quantity: 35, price: 70, daysAgoValue: 125, lateByDays: 5 });

  // =====================================================
  // 17. PENDING DOCUMENT REVIEW
  // =====================================================

  await prisma.pendingDocumentReview.create({
    data: {
      documentUrl: 'https://example-bucket.s3.amazonaws.com/documents/sample-invoice.pdf',
      transactionType: InventoryTransactionType.INCOMING,
      extractedSupplierName: 'TechSource Lebanon',
      extractedDate: new Date(),
      extractedWarehouseName: 'Beirut Warehouse',
      extractedItems: [
        { product: 'Laptop Pro 14', quantity: 10, price: 790 },
        { product: 'Wireless Mouse', quantity: 25, price: 17 },
      ],
      status: DocumentReviewStatus.PENDING_REVIEW,
    },
  });

  await prisma.pendingDocumentReview.create({
    data: {
      documentUrl: 'https://example-bucket.s3.amazonaws.com/documents/approved-invoice.pdf',
      transactionType: InventoryTransactionType.OUTGOING,
      extractedPartyName: 'ABC Corporation',
      extractedDate: daysAgo(10),
      extractedWarehouseName: 'Beirut Warehouse',
      extractedItems: [{ product: 'Cotton T-Shirt', quantity: 20, price: 15 }],
      status: DocumentReviewStatus.APPROVED,
      reviewedById: admin.id,
      reviewedAt: daysAgo(9),
    },
  });

  // ---------------------------------------------------
  // 18. BUILD WAREHOUSE INVENTORY FROM LEDGER
  // ---------------------------------------------------
  // Same approach as before: onHand is never hand-typed, it's replayed from
  // the StockMovement ledger every product/transaction helper above already
  // wrote — the only thing guaranteed to match the real system's own math.

  const activeWarehouses = [beirut, tripoli, saida];
  const products = [laptop, headphones, keyboard, monitor, mouse, tshirt, hoodie, notebook, backpack, calculator, chair];

  const thresholds: Record<number, number> = {
    [laptop.id]: 20,
    [headphones.id]: 25,
    [keyboard.id]: 20,
    [monitor.id]: 15,
    [mouse.id]: 30,
    [tshirt.id]: 40,
    [hoodie.id]: 25,
    [notebook.id]: 50,
    [backpack.id]: 20,
    [calculator.id]: 15,
    [chair.id]: 10,
  };

  for (const warehouse of activeWarehouses) {
    for (const product of products) {
      const movements = await prisma.stockMovement.findMany({
        where: { warehouseId: warehouse.id, productId: product.id },
      });

      const onHand = movements.reduce((total, movement) => {
        switch (movement.type) {
          case StockMovementType.INCOMING:
          case StockMovementType.TRANSFER_IN:
            return total + movement.quantity;
          case StockMovementType.OUTGOING:
          case StockMovementType.TRANSFER_OUT:
            return total - movement.quantity;
          case StockMovementType.ADJUSTMENT:
            return total + movement.quantity;
          default:
            return total;
        }
      }, 0);

      await prisma.warehouseInventory.create({
        data: {
          warehouseId: warehouse.id,
          productId: product.id,
          onHand,
          reorderThreshold: thresholds[product.id] ?? 10,
        },
      });
    }
  }

  console.log('');
  console.log('✅ Seed completed successfully');
  console.log('');
  console.log('Test users:');
  console.log('ADMIN:    admin@minierp.com (credentials are managed in Cognito)');
  console.log('EMPLOYEE: employee@minierp.com (credentials are managed in Cognito)');
  console.log('AI_AGENT: ai-agent@internal.local (credentials are managed in Cognito)');
  console.log('');
  console.log('Seed includes:');
  console.log('- 11 products across exactly 4 categories (Electronics, Apparel, School & University Supplies, Uncategorized)');
  console.log('- 3 warehouses, 6 suppliers, 8 customers');
  console.log('- Wireless Headphones: Tripoli AT_RISK / Saida surplus -> real transfer recommendation');
  console.log('- Mechanical Keyboard: OUT_OF_STOCK at Tripoli & Saida, no donor anywhere -> purchase-required restock recommendations');
  console.log('- Wireless Mouse @ Beirut: consumption anomaly (recent 30d spike vs prior 30d baseline)');
  console.log('- Office Chair @ Beirut: dead stock (bought once, never sold)');
  console.log('- Laptop Pro 14 @ Beirut: reserved-stock demo (onHand 78 > reserved 40 > available 38)');
  console.log('- Laptop Pro 14 supplier ranking: TechSource (cheap+reliable) vs Cedar Electronics (highest volume, pricier, 1 cancellation) vs Levant Trading (middle option)');
  console.log('- Hooded Sweatshirt @ Beirut: a second, non-Electronics low-stock/purchase-required example');
  console.log('- overdue + upcoming incoming/outgoing/transfer transactions for the Calendar');
  console.log('- one completed transfer, one cancelled order, one pending + one approved document review');
}

main()
  .catch((error) => {
    console.error('❌ Seed failed');
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });