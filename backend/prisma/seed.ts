import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  UserRole,
  InventoryTransactionType,
  InventoryTransactionStatus,
  StockMovementType,
  ReservationStatus,
} from '../generated/prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

// ============================================================================
// FINAL DEMO SEED
// ----------------------------------------------------------------------------
// Goals:
// - rich enough to demo every major UI/analytics/AI path
// - deterministic relative to one reference date
// - WarehouseInventory is reconstructed from the immutable StockMovement ledger
// - no cartesian "0-stock everywhere" inventory rows (avoids fake stockouts)
// - intentionally contains a small number of clear, named operational scenarios
// ============================================================================

const systemNow = new Date();
const defaultReferenceDate = new Date(
  Date.UTC(
    systemNow.getUTCFullYear(),
    systemNow.getUTCMonth(),
    systemNow.getUTCDate(),
    12,
    0,
    0,
    0,
  ),
);
const REFERENCE_DATE = process.env.SEED_REFERENCE_DATE
  ? new Date(process.env.SEED_REFERENCE_DATE)
  : defaultReferenceDate;

if (!Number.isFinite(REFERENCE_DATE.getTime())) {
  throw new Error(
    'SEED_REFERENCE_DATE must be a valid ISO date/time when provided',
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

function shiftDays(base: Date, days: number): Date {
  return new Date(base.getTime() + days * DAY_MS);
}
function daysAgo(days: number): Date {
  return shiftDays(REFERENCE_DATE, -days);
}
function daysFromNow(days: number): Date {
  return shiftDays(REFERENCE_DATE, days);
}
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Seed assertion failed: ${message}`);
}

const isProduction =
  process.env.NODE_ENV?.toLowerCase() === 'production' ||
  process.env.APP_ENV?.toLowerCase() === 'production';

function cognitoIdentity(key: string, fallback: string): string {
  const value = process.env[key]?.trim();
  if (value) return value;
  if (isProduction) {
    throw new Error(`${key} is required when seeding production`);
  }
  console.warn(`${key} is unset; using non-authenticating local seed value`);
  return fallback;
}

type SupplierSpec = {
  key: string;
  name: string;
  email: string;
  leadTimeDays: number;
  isActive?: boolean;
};

type ProductSpec = {
  key: string;
  name: string;
  category: string | null;
  sku: string;
  description: string;
  sellPrice: number;
  baseCost: number;
  reorderThreshold: number;
};

type WarehouseSpec = {
  key: string;
  name: string;
  location: string;
  maxCapacity: number;
};

type Line = {
  productKey: string;
  quantity: number;
  price?: number;
};

type Delivery = {
  country: string;
  region: string;
  address: string;
};

async function main() {
  console.log(`🌱 Starting FINAL demo seed @ ${REFERENCE_DATE.toISOString()}`);

  // --------------------------------------------------------------------------
  // 1. CLEAN APPLICATION DATA
  // --------------------------------------------------------------------------
  // QueryExample is seeded separately by prisma/seed-query-examples.ts.
  // Resetting identities makes demo IDs stable after each full seed.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "PendingDocumentReview",
      "Reservation",
      "StockMovement",
      "InventoryTransactionItem",
      "InventoryTransaction",
      "WarehouseInventory",
      "Product",
      "Supplier",
      "Warehouse",
      "User"
    RESTART IDENTITY CASCADE
  `);

  console.log('🧹 Application tables cleared and identities reset');

  // --------------------------------------------------------------------------
  // 2. USERS
  // --------------------------------------------------------------------------
  // These three identities reuse the env-backed mapping convention already
  // used by the project. In production the real Cognito sub/username values
  // MUST be supplied. The seed never creates/deletes Cognito users itself.
  const admin = await prisma.user.create({
    data: {
      cognitoSub: cognitoIdentity(
        'SEED_ADMIN_COGNITO_SUB',
        'UNMAPPED_DEV_ADMIN_SUB',
      ),
      cognitoUsername: cognitoIdentity(
        'SEED_ADMIN_COGNITO_USERNAME',
        'UNMAPPED_DEV_ADMIN_USERNAME',
      ),
      name: 'Demo Administrator',
      email: 'admin@minierp.demo',
      role: UserRole.ADMIN,
      createdAt: daysAgo(365),
    },
  });

  await prisma.user.create({
    data: {
      cognitoSub: cognitoIdentity(
        'SEED_EMPLOYEE_COGNITO_SUB',
        'UNMAPPED_DEV_EMPLOYEE_SUB',
      ),
      cognitoUsername: cognitoIdentity(
        'SEED_EMPLOYEE_COGNITO_USERNAME',
        'UNMAPPED_DEV_EMPLOYEE_USERNAME',
      ),
      name: 'Demo Employee',
      email: 'employee@minierp.demo',
      role: UserRole.EMPLOYEE,
      createdAt: daysAgo(300),
    },
  });

  await prisma.user.create({
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
      createdAt: daysAgo(250),
    },
  });

  // --------------------------------------------------------------------------
  // 3. SUPPLIERS
  // --------------------------------------------------------------------------
  const supplierSpecs: SupplierSpec[] = [
    {
      key: 'techSource',
      name: 'TechSource Lebanon',
      email: 'sales@techsource.demo',
      leadTimeDays: 4,
    },
    {
      key: 'cedarElectronics',
      name: 'Cedar Electronics',
      email: 'orders@cedarelectronics.demo',
      leadTimeDays: 6,
    },
    {
      key: 'levantTrading',
      name: 'Levant Trading',
      email: 'procurement@levanttrading.demo',
      leadTimeDays: 8,
    },
    {
      key: 'medTech',
      name: 'Mediterranean Tech',
      email: 'sales@medtech.demo',
      leadTimeDays: 5,
    },
    {
      key: 'officeWorks',
      name: 'OfficeWorks Lebanon',
      email: 'orders@officeworks.demo',
      leadTimeDays: 7,
    },
    {
      key: 'cedarHome',
      name: 'Cedar Home & Office',
      email: 'sales@cedarhome.demo',
      leadTimeDays: 12,
    },
    {
      key: 'beirutTextiles',
      name: 'Beirut Textiles',
      email: 'sales@beiruttextiles.demo',
      leadTimeDays: 7,
    },
    {
      key: 'campusSupply',
      name: 'Campus Supply Co',
      email: 'orders@campussupply.demo',
      leadTimeDays: 6,
    },
    {
      key: 'homePlus',
      name: 'HomePlus Distribution',
      email: 'supply@homeplus.demo',
      leadTimeDays: 9,
    },
    {
      key: 'activeLife',
      name: 'ActiveLife Wholesale',
      email: 'orders@activelife.demo',
      leadTimeDays: 8,
    },
    {
      key: 'carePlus',
      name: 'CarePlus Distribution',
      email: 'orders@careplus.demo',
      leadTimeDays: 5,
    },
    {
      key: 'legacyTech',
      name: 'Legacy Tech Imports',
      email: 'archive@legacytech.demo',
      leadTimeDays: 14,
      isActive: false,
    },
  ];

  const suppliers = new Map<string, { id: number; name: string }>();
  for (const [index, spec] of supplierSpecs.entries()) {
    const row = await prisma.supplier.create({
      data: {
        name: spec.name,
        email: spec.email,
        leadTimeDays: spec.leadTimeDays,
        isActive: spec.isActive ?? true,
        createdAt: daysAgo(420 - index),
      },
    });
    suppliers.set(spec.key, row);
  }

  // --------------------------------------------------------------------------
  // 4. PRODUCT CATALOG
  // --------------------------------------------------------------------------
  // 8 real categories x 3 products + 1 intentionally uncategorized product.
  // Prices are seed conventions only; Product has no price/cost columns.
  const productSpecs: ProductSpec[] = [
    // Electronics
    {
      key: 'laptop',
      name: 'Laptop Pro 14',
      category: 'Electronics',
      sku: 'ELEC-LAP14',
      description: '14-inch business laptop',
      sellPrice: 999,
      baseCost: 782,
      reorderThreshold: 25,
    },
    {
      key: 'monitor',
      name: '27-inch Monitor',
      category: 'Electronics',
      sku: 'ELEC-MON27',
      description: '27-inch IPS productivity monitor',
      sellPrice: 259,
      baseCost: 205,
      reorderThreshold: 18,
    },
    {
      key: 'dock',
      name: 'USB-C Dock',
      category: 'Electronics',
      sku: 'ELEC-DOCK',
      description: 'USB-C multi-port docking station',
      sellPrice: 119,
      baseCost: 72,
      reorderThreshold: 20,
    },

    // Computer Accessories
    {
      key: 'mouse',
      name: 'Wireless Mouse',
      category: 'Computer Accessories',
      sku: 'ACC-MOUSE',
      description: 'Wireless ergonomic optical mouse',
      sellPrice: 29,
      baseCost: 16,
      reorderThreshold: 30,
    },
    {
      key: 'keyboard',
      name: 'Mechanical Keyboard',
      category: 'Computer Accessories',
      sku: 'ACC-KEYBD',
      description: 'Mechanical keyboard with tactile switches',
      sellPrice: 89,
      baseCost: 52,
      reorderThreshold: 15,
    },
    {
      key: 'headphones',
      name: 'Wireless Headphones',
      category: 'Computer Accessories',
      sku: 'ACC-HEADPH',
      description: 'Over-ear wireless headphones',
      sellPrice: 99,
      baseCost: 58,
      reorderThreshold: 25,
    },

    // Office & Furniture
    {
      key: 'chair',
      name: 'Ergonomic Office Chair',
      category: 'Office & Furniture',
      sku: 'OFF-CHAIR',
      description: 'Adjustable ergonomic office chair',
      sellPrice: 189,
      baseCost: 93,
      reorderThreshold: 10,
    },
    {
      key: 'desk',
      name: 'Standing Desk',
      category: 'Office & Furniture',
      sku: 'OFF-DESK',
      description: 'Electric height-adjustable standing desk',
      sellPrice: 399,
      baseCost: 235,
      reorderThreshold: 8,
    },
    {
      key: 'deskLamp',
      name: 'LED Desk Lamp',
      category: 'Office & Furniture',
      sku: 'OFF-LAMP',
      description: 'Dimmable LED desk lamp',
      sellPrice: 49,
      baseCost: 24,
      reorderThreshold: 15,
    },

    // Apparel
    {
      key: 'tshirt',
      name: 'Cotton T-Shirt',
      category: 'Apparel',
      sku: 'APP-TSHIRT',
      description: 'Unisex cotton crew-neck T-shirt',
      sellPrice: 18,
      baseCost: 6,
      reorderThreshold: 35,
    },
    {
      key: 'hoodie',
      name: 'Hooded Sweatshirt',
      category: 'Apparel',
      sku: 'APP-HOODIE',
      description: 'Fleece-lined hooded sweatshirt',
      sellPrice: 39,
      baseCost: 14,
      reorderThreshold: 25,
    },
    {
      key: 'rainJacket',
      name: 'Rain Jacket',
      category: 'Apparel',
      sku: 'APP-RAIN',
      description: 'Lightweight waterproof rain jacket',
      sellPrice: 69,
      baseCost: 31,
      reorderThreshold: 20,
    },

    // School & University Supplies
    {
      key: 'notebook',
      name: 'Notebook Set',
      category: 'School & University Supplies',
      sku: 'SCH-NOTE',
      description: 'Three-pack ruled notebook set',
      sellPrice: 7,
      baseCost: 2,
      reorderThreshold: 60,
    },
    {
      key: 'calculator',
      name: 'Scientific Calculator',
      category: 'School & University Supplies',
      sku: 'SCH-CALC',
      description: 'Scientific calculator for university courses',
      sellPrice: 39,
      baseCost: 18,
      reorderThreshold: 20,
    },
    {
      key: 'campusBackpack',
      name: 'Campus Backpack',
      category: 'School & University Supplies',
      sku: 'SCH-BAG',
      description: 'Laptop-compatible campus backpack',
      sellPrice: 45,
      baseCost: 19,
      reorderThreshold: 20,
    },

    // Home & Kitchen
    {
      key: 'kettle',
      name: 'Electric Kettle',
      category: 'Home & Kitchen',
      sku: 'HOME-KETTLE',
      description: '1.7L automatic electric kettle',
      sellPrice: 45,
      baseCost: 22,
      reorderThreshold: 20,
    },
    {
      key: 'coffeeMaker',
      name: 'Coffee Maker',
      category: 'Home & Kitchen',
      sku: 'HOME-COFFEE',
      description: 'Programmable drip coffee maker',
      sellPrice: 79,
      baseCost: 41,
      reorderThreshold: 15,
    },
    {
      key: 'waterBottle',
      name: 'Insulated Water Bottle',
      category: 'Home & Kitchen',
      sku: 'HOME-BOTTLE',
      description: 'Vacuum-insulated stainless-steel bottle',
      sellPrice: 28,
      baseCost: 11,
      reorderThreshold: 30,
    },

    // Fitness & Outdoors
    {
      key: 'yogaMat',
      name: 'Yoga Mat',
      category: 'Fitness & Outdoors',
      sku: 'FIT-YOGA',
      description: 'Non-slip exercise yoga mat',
      sellPrice: 35,
      baseCost: 15,
      reorderThreshold: 20,
    },
    {
      key: 'bands',
      name: 'Resistance Band Set',
      category: 'Fitness & Outdoors',
      sku: 'FIT-BANDS',
      description: 'Five-level resistance band set',
      sellPrice: 25,
      baseCost: 9,
      reorderThreshold: 25,
    },
    {
      key: 'hikingBackpack',
      name: 'Hiking Backpack',
      category: 'Fitness & Outdoors',
      sku: 'FIT-HIKEBAG',
      description: '35L outdoor hiking backpack',
      sellPrice: 79,
      baseCost: 34,
      reorderThreshold: 15,
    },

    // Personal Care
    {
      key: 'hairDryer',
      name: 'Hair Dryer',
      category: 'Personal Care',
      sku: 'CARE-DRYER',
      description: 'Compact ionic hair dryer',
      sellPrice: 49,
      baseCost: 23,
      reorderThreshold: 15,
    },
    {
      key: 'toothbrush',
      name: 'Electric Toothbrush',
      category: 'Personal Care',
      sku: 'CARE-TOOTH',
      description: 'Rechargeable electric toothbrush',
      sellPrice: 59,
      baseCost: 28,
      reorderThreshold: 18,
    },
    {
      key: 'groomingKit',
      name: 'Grooming Kit',
      category: 'Personal Care',
      sku: 'CARE-GROOM',
      description: 'Rechargeable multi-use grooming kit',
      sellPrice: 65,
      baseCost: 31,
      reorderThreshold: 15,
    },

    // Edge case for null category handling.
    {
      key: 'storageBin',
      name: 'Storage Bin',
      category: null,
      sku: 'MISC-BIN',
      description: 'Stackable multipurpose storage bin',
      sellPrice: 22,
      baseCost: 8,
      reorderThreshold: 20,
    },
  ];

  const products = new Map<
    string,
    { id: number; name: string; category: string | null }
  >();
  const productSpecByKey = new Map(
    productSpecs.map((spec) => [spec.key, spec]),
  );

  for (const [index, spec] of productSpecs.entries()) {
    const row = await prisma.product.create({
      data: {
        name: spec.name,
        category: spec.category,
        description: `SKU: ${spec.sku} — ${spec.description}`,
        isActive: true,
        createdAt: daysAgo(360 - index),
      },
    });
    products.set(spec.key, row);
  }

  // --------------------------------------------------------------------------
  // 5. WAREHOUSES
  // --------------------------------------------------------------------------
  const warehouseSpecs: WarehouseSpec[] = [
    {
      key: 'beirut',
      name: 'Beirut Warehouse',
      location: 'Beirut, Lebanon',
      maxCapacity: 10000,
    },
    {
      key: 'tripoli',
      name: 'Tripoli Warehouse',
      location: 'Tripoli, Lebanon',
      maxCapacity: 3000,
    },
    {
      key: 'saida',
      name: 'Saida Warehouse',
      location: 'Saida, Lebanon',
      maxCapacity: 2000,
    },
    {
      key: 'zahle',
      name: 'Zahle Warehouse',
      location: 'Zahle, Lebanon',
      maxCapacity: 5000,
    },
  ];

  const warehouses = new Map<string, { id: number; name: string }>();
  for (const [index, spec] of warehouseSpecs.entries()) {
    const row = await prisma.warehouse.create({
      data: {
        name: spec.name,
        location: spec.location,
        maxCapacity: spec.maxCapacity,
        isActive: true,
        createdAt: daysAgo(340 - index),
      },
    });
    warehouses.set(spec.key, row);
  }

  const customerDelivery: Record<string, Delivery> = {
    'Cedar Retail Group': {
      country: 'Lebanon',
      region: 'Beirut',
      address: 'Hamra Street, Beirut',
    },
    'AUB Campus Store': {
      country: 'Lebanon',
      region: 'Beirut',
      address: 'Bliss Street, Beirut',
    },
    'NorthStar Trading': {
      country: 'Lebanon',
      region: 'North Lebanon',
      address: 'Mina Road, Tripoli',
    },
    'Saida Wholesale Group': {
      country: 'Lebanon',
      region: 'South Lebanon',
      address: 'Saida Commercial District',
    },
    'Bekaa Office Solutions': {
      country: 'Lebanon',
      region: 'Bekaa',
      address: 'Zahle Boulevard',
    },
    'Levant Corporate Services': {
      country: 'Lebanon',
      region: 'Mount Lebanon',
      address: 'Jdeideh Industrial Zone',
    },
    'Amman Tech Market': {
      country: 'Jordan',
      region: 'Amman',
      address: 'Shmeisani, Amman',
    },
    'Cyprus Retail Partners': {
      country: 'Cyprus',
      region: 'Nicosia',
      address: 'Strovolos, Nicosia',
    },
  };

  const customerNames = Object.keys(customerDelivery);

  function product(key: string) {
    const row = products.get(key);
    ensure(row, `unknown product key ${key}`);
    return row;
  }
  function productSpec(key: string) {
    const spec = productSpecByKey.get(key);
    ensure(spec, `unknown product spec key ${key}`);
    return spec;
  }
  function warehouse(key: string) {
    const row = warehouses.get(key);
    ensure(row, `unknown warehouse key ${key}`);
    return row;
  }
  function supplier(key: string) {
    const row = suppliers.get(key);
    ensure(row, `unknown supplier key ${key}`);
    return row;
  }

  function incomingItems(lines: Line[]) {
    return lines.map((line) => ({
      productId: product(line.productKey).id,
      quantity: line.quantity,
      price: line.price ?? productSpec(line.productKey).baseCost,
    }));
  }

  function outgoingItems(lines: Line[]) {
    return lines.map((line) => ({
      productId: product(line.productKey).id,
      quantity: line.quantity,
      price: line.price ?? productSpec(line.productKey).sellPrice,
    }));
  }

  function transferItems(lines: Line[]) {
    return lines.map((line) => ({
      productId: product(line.productKey).id,
      quantity: line.quantity,
    }));
  }

  // --------------------------------------------------------------------------
  // 6. TRANSACTION HELPERS
  // --------------------------------------------------------------------------

  async function completedIncoming(params: {
    supplierKey: string;
    warehouseKey: string;
    lines: Line[];
    daysAgoValue: number;
    lateByDays?: number;
  }) {
    const expectedDate = daysAgo(params.daysAgoValue);
    const actualDate = shiftDays(expectedDate, params.lateByDays ?? 0);

    const tx = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.INCOMING,
        status: InventoryTransactionStatus.COMPLETED,
        supplierId: supplier(params.supplierKey).id,
        destinationWarehouseId: warehouse(params.warehouseKey).id,
        expectedDate,
        actualDate,
        createdAt: expectedDate,
        items: { create: incomingItems(params.lines) },
      },
    });

    await prisma.stockMovement.createMany({
      data: params.lines.map((line) => ({
        transactionId: tx.id,
        productId: product(line.productKey).id,
        warehouseId: warehouse(params.warehouseKey).id,
        type: StockMovementType.INCOMING,
        quantity: line.quantity,
        createdAt: actualDate,
      })),
    });

    return tx;
  }

  async function pendingIncoming(params: {
    supplierKey: string;
    warehouseKey: string;
    lines: Line[];
    expectedDate: Date;
    createdDaysAgo?: number;
  }) {
    return prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.INCOMING,
        status: InventoryTransactionStatus.PENDING,
        supplierId: supplier(params.supplierKey).id,
        destinationWarehouseId: warehouse(params.warehouseKey).id,
        expectedDate: params.expectedDate,
        createdAt: daysAgo(params.createdDaysAgo ?? 2),
        items: { create: incomingItems(params.lines) },
      },
    });
  }

  async function cancelledIncoming(params: {
    supplierKey: string;
    warehouseKey: string;
    lines: Line[];
    expectedDaysAgo: number;
  }) {
    return prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.INCOMING,
        status: InventoryTransactionStatus.CANCELLED,
        supplierId: supplier(params.supplierKey).id,
        destinationWarehouseId: warehouse(params.warehouseKey).id,
        expectedDate: daysAgo(params.expectedDaysAgo),
        createdAt: daysAgo(params.expectedDaysAgo + 4),
        items: { create: incomingItems(params.lines) },
      },
    });
  }

  async function completedOutgoing(params: {
    warehouseKey: string;
    lines: Line[];
    daysAgoValue: number;
    customer: string;
  }) {
    const date = daysAgo(params.daysAgoValue);
    const delivery = customerDelivery[params.customer];

    const tx = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.OUTGOING,
        status: InventoryTransactionStatus.COMPLETED,
        sourceWarehouseId: warehouse(params.warehouseKey).id,
        partyName: params.customer,
        deliveryCountry: delivery?.country,
        deliveryRegion: delivery?.region,
        deliveryAddress: delivery?.address,
        expectedDate: date,
        actualDate: date,
        createdAt: date,
        items: { create: outgoingItems(params.lines) },
      },
    });

    await prisma.reservation.createMany({
      data: params.lines.map((line) => ({
        transactionId: tx.id,
        productId: product(line.productKey).id,
        warehouseId: warehouse(params.warehouseKey).id,
        quantity: line.quantity,
        status: ReservationStatus.FULFILLED,
        createdAt: date,
      })),
    });

    await prisma.stockMovement.createMany({
      data: params.lines.map((line) => ({
        transactionId: tx.id,
        productId: product(line.productKey).id,
        warehouseId: warehouse(params.warehouseKey).id,
        type: StockMovementType.OUTGOING,
        quantity: line.quantity,
        createdAt: date,
      })),
    });

    return tx;
  }

  async function pendingOutgoing(params: {
    warehouseKey: string;
    lines: Line[];
    expectedDate: Date;
    customer: string;
    createdDaysAgo?: number;
  }) {
    const createdAt = daysAgo(params.createdDaysAgo ?? 1);
    const delivery = customerDelivery[params.customer];

    const tx = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.OUTGOING,
        status: InventoryTransactionStatus.PENDING,
        sourceWarehouseId: warehouse(params.warehouseKey).id,
        partyName: params.customer,
        deliveryCountry: delivery?.country,
        deliveryRegion: delivery?.region,
        deliveryAddress: delivery?.address,
        expectedDate: params.expectedDate,
        createdAt,
        items: { create: outgoingItems(params.lines) },
      },
    });

    await prisma.reservation.createMany({
      data: params.lines.map((line) => ({
        transactionId: tx.id,
        productId: product(line.productKey).id,
        warehouseId: warehouse(params.warehouseKey).id,
        quantity: line.quantity,
        status: ReservationStatus.ACTIVE,
        createdAt,
      })),
    });

    return tx;
  }

  async function cancelledOutgoing(params: {
    warehouseKey: string;
    lines: Line[];
    expectedDaysAgo: number;
    customer: string;
  }) {
    const createdAt = daysAgo(params.expectedDaysAgo + 4);
    const delivery = customerDelivery[params.customer];

    const tx = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.OUTGOING,
        status: InventoryTransactionStatus.CANCELLED,
        sourceWarehouseId: warehouse(params.warehouseKey).id,
        partyName: params.customer,
        deliveryCountry: delivery?.country,
        deliveryRegion: delivery?.region,
        deliveryAddress: delivery?.address,
        expectedDate: daysAgo(params.expectedDaysAgo),
        createdAt,
        items: { create: outgoingItems(params.lines) },
      },
    });

    await prisma.reservation.createMany({
      data: params.lines.map((line) => ({
        transactionId: tx.id,
        productId: product(line.productKey).id,
        warehouseId: warehouse(params.warehouseKey).id,
        quantity: line.quantity,
        status: ReservationStatus.CANCELLED,
        createdAt,
      })),
    });

    return tx;
  }

  async function completedTransfer(params: {
    sourceWarehouseKey: string;
    destinationWarehouseKey: string;
    lines: Line[];
    daysAgoValue: number;
  }) {
    const date = daysAgo(params.daysAgoValue);

    const tx = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.TRANSFER,
        status: InventoryTransactionStatus.COMPLETED,
        sourceWarehouseId: warehouse(params.sourceWarehouseKey).id,
        destinationWarehouseId: warehouse(params.destinationWarehouseKey).id,
        expectedDate: date,
        actualDate: date,
        createdAt: date,
        items: { create: transferItems(params.lines) },
      },
    });

    await prisma.reservation.createMany({
      data: params.lines.map((line) => ({
        transactionId: tx.id,
        productId: product(line.productKey).id,
        warehouseId: warehouse(params.sourceWarehouseKey).id,
        quantity: line.quantity,
        status: ReservationStatus.FULFILLED,
        createdAt: date,
      })),
    });

    await prisma.stockMovement.createMany({
      data: params.lines.flatMap((line) => [
        {
          transactionId: tx.id,
          productId: product(line.productKey).id,
          warehouseId: warehouse(params.sourceWarehouseKey).id,
          type: StockMovementType.TRANSFER_OUT,
          quantity: line.quantity,
          createdAt: date,
        },
        {
          transactionId: tx.id,
          productId: product(line.productKey).id,
          warehouseId: warehouse(params.destinationWarehouseKey).id,
          type: StockMovementType.TRANSFER_IN,
          quantity: line.quantity,
          createdAt: date,
        },
      ]),
    });

    return tx;
  }

  async function pendingTransfer(params: {
    sourceWarehouseKey: string;
    destinationWarehouseKey: string;
    lines: Line[];
    expectedDate: Date;
    createdDaysAgo?: number;
  }) {
    const createdAt = daysAgo(params.createdDaysAgo ?? 1);
    const tx = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.TRANSFER,
        status: InventoryTransactionStatus.PENDING,
        sourceWarehouseId: warehouse(params.sourceWarehouseKey).id,
        destinationWarehouseId: warehouse(params.destinationWarehouseKey).id,
        expectedDate: params.expectedDate,
        createdAt,
        items: { create: transferItems(params.lines) },
      },
    });

    await prisma.reservation.createMany({
      data: params.lines.map((line) => ({
        transactionId: tx.id,
        productId: product(line.productKey).id,
        warehouseId: warehouse(params.sourceWarehouseKey).id,
        quantity: line.quantity,
        status: ReservationStatus.ACTIVE,
        createdAt,
      })),
    });

    return tx;
  }

  async function cancelledTransfer(params: {
    sourceWarehouseKey: string;
    destinationWarehouseKey: string;
    lines: Line[];
    expectedDaysAgo: number;
  }) {
    const createdAt = daysAgo(params.expectedDaysAgo + 3);
    const tx = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.TRANSFER,
        status: InventoryTransactionStatus.CANCELLED,
        sourceWarehouseId: warehouse(params.sourceWarehouseKey).id,
        destinationWarehouseId: warehouse(params.destinationWarehouseKey).id,
        expectedDate: daysAgo(params.expectedDaysAgo),
        createdAt,
        items: { create: transferItems(params.lines) },
      },
    });

    await prisma.reservation.createMany({
      data: params.lines.map((line) => ({
        transactionId: tx.id,
        productId: product(line.productKey).id,
        warehouseId: warehouse(params.sourceWarehouseKey).id,
        quantity: line.quantity,
        status: ReservationStatus.CANCELLED,
        createdAt,
      })),
    });

    return tx;
  }

  async function adjustment(params: {
    warehouseKey: string;
    productKey: string;
    quantity: number;
    daysAgoValue: number;
  }) {
    ensure(params.quantity !== 0, 'adjustment quantity must be non-zero');
    return prisma.stockMovement.create({
      data: {
        productId: product(params.productKey).id,
        warehouseId: warehouse(params.warehouseKey).id,
        type: StockMovementType.ADJUSTMENT,
        quantity: params.quantity,
        createdAt: daysAgo(params.daysAgoValue),
      },
    });
  }

  // Generic "boring healthy" history used for products that exist to make the
  // dashboard, charts and SQL-RAG realistic without accidentally generating
  // Control Tower alerts. Baseline and recent 30-day OUTGOING quantities are
  // deliberately equal.
  async function healthyHistory(params: {
    productKey: string;
    supplierKey: string;
    primaryWarehouseKey: string;
    secondaryWarehouseKey: string;
    customerOffset: number;
  }) {
    const spec = productSpec(params.productKey);
    const primaryStock = spec.reorderThreshold * 8 + 80;
    const secondaryStock = spec.reorderThreshold * 5 + 50;

    await completedIncoming({
      supplierKey: params.supplierKey,
      warehouseKey: params.primaryWarehouseKey,
      lines: [{ productKey: params.productKey, quantity: primaryStock }],
      daysAgoValue: 330,
    });
    await completedIncoming({
      supplierKey: params.supplierKey,
      warehouseKey: params.secondaryWarehouseKey,
      lines: [{ productKey: params.productKey, quantity: secondaryStock }],
      daysAgoValue: 240,
    });
    await completedIncoming({
      supplierKey: params.supplierKey,
      warehouseKey: params.primaryWarehouseKey,
      lines: [
        {
          productKey: params.productKey,
          quantity: spec.reorderThreshold * 2 + 10,
        },
      ],
      daysAgoValue: 90,
    });

    const c0 = customerNames[params.customerOffset % customerNames.length];
    const c1 =
      customerNames[(params.customerOffset + 1) % customerNames.length];
    const c2 =
      customerNames[(params.customerOffset + 2) % customerNames.length];

    await completedOutgoing({
      warehouseKey: params.primaryWarehouseKey,
      lines: [{ productKey: params.productKey, quantity: 5 }],
      daysAgoValue: 280,
      customer: c0,
    });
    await completedOutgoing({
      warehouseKey: params.primaryWarehouseKey,
      lines: [{ productKey: params.productKey, quantity: 8 }],
      daysAgoValue: 190,
      customer: c1,
    });
    await completedOutgoing({
      warehouseKey: params.secondaryWarehouseKey,
      lines: [{ productKey: params.productKey, quantity: 6 }],
      daysAgoValue: 120,
      customer: c2,
    });
    await completedOutgoing({
      warehouseKey: params.primaryWarehouseKey,
      lines: [{ productKey: params.productKey, quantity: 12 }],
      daysAgoValue: 45,
      customer: c0,
    });
    await completedOutgoing({
      warehouseKey: params.primaryWarehouseKey,
      lines: [{ productKey: params.productKey, quantity: 12 }],
      daysAgoValue: 15,
      customer: c1,
    });
    await completedOutgoing({
      warehouseKey: params.secondaryWarehouseKey,
      lines: [{ productKey: params.productKey, quantity: 8 }],
      daysAgoValue: 45,
      customer: c1,
    });
    await completedOutgoing({
      warehouseKey: params.secondaryWarehouseKey,
      lines: [{ productKey: params.productKey, quantity: 8 }],
      daysAgoValue: 15,
      customer: c2,
    });
  }

  // ==========================================================================
  // 7. TARGETED DEMO SCENARIOS
  // ==========================================================================

  // --------------------------------------------------------------------------
  // LAPTOP PRO 14
  // Healthy stock + reservations + strongest supplier-comparison dataset.
  //
  // TechSource: 4 completed, cheapest, 100% on-time, 0 cancellations.
  // Cedar:      5 completed + 1 cancelled, more expensive, multiple late.
  // Levant:     4 completed, middle price/reliability.
  // MedTech:    only 2 completed -> deliberately "insufficient data" in ranking.
  //
  // Also has an OVERDUE PENDING Cedar purchase so Control Tower can invoke
  // the "recommend alternative supplier" AI scenario.
  // --------------------------------------------------------------------------
  for (const entry of [
    {
      supplierKey: 'techSource',
      warehouseKey: 'beirut',
      qty: 22,
      price: 782,
      age: 95,
      late: 0,
    },
    {
      supplierKey: 'techSource',
      warehouseKey: 'beirut',
      qty: 20,
      price: 780,
      age: 70,
      late: 0,
    },
    {
      supplierKey: 'techSource',
      warehouseKey: 'beirut',
      qty: 22,
      price: 785,
      age: 48,
      late: 0,
    },
    {
      supplierKey: 'techSource',
      warehouseKey: 'beirut',
      qty: 19,
      price: 779,
      age: 40,
      late: 0,
    },

    {
      supplierKey: 'cedarElectronics',
      warehouseKey: 'tripoli',
      qty: 18,
      price: 810,
      age: 90,
      late: 0,
    },
    {
      supplierKey: 'cedarElectronics',
      warehouseKey: 'tripoli',
      qty: 16,
      price: 812,
      age: 65,
      late: 4,
    },
    {
      supplierKey: 'cedarElectronics',
      warehouseKey: 'tripoli',
      qty: 17,
      price: 808,
      age: 42,
      late: 0,
    },
    {
      supplierKey: 'cedarElectronics',
      warehouseKey: 'tripoli',
      qty: 18,
      price: 815,
      age: 40,
      late: 3,
    },
    {
      supplierKey: 'cedarElectronics',
      warehouseKey: 'tripoli',
      qty: 16,
      price: 805,
      age: 40,
      late: 2,
    },

    {
      supplierKey: 'levantTrading',
      warehouseKey: 'saida',
      qty: 20,
      price: 795,
      age: 88,
      late: 0,
    },
    {
      supplierKey: 'levantTrading',
      warehouseKey: 'saida',
      qty: 18,
      price: 792,
      age: 60,
      late: 0,
    },
    {
      supplierKey: 'levantTrading',
      warehouseKey: 'saida',
      qty: 20,
      price: 798,
      age: 38,
      late: 4,
    },
    {
      supplierKey: 'levantTrading',
      warehouseKey: 'saida',
      qty: 15,
      price: 793,
      age: 40,
      late: 0,
    },

    {
      supplierKey: 'medTech',
      warehouseKey: 'zahle',
      qty: 20,
      price: 776,
      age: 55,
      late: 0,
    },
    {
      supplierKey: 'medTech',
      warehouseKey: 'zahle',
      qty: 20,
      price: 779,
      age: 40,
      late: 0,
    },
  ]) {
    await completedIncoming({
      supplierKey: entry.supplierKey,
      warehouseKey: entry.warehouseKey,
      lines: [
        { productKey: 'laptop', quantity: entry.qty, price: entry.price },
      ],
      daysAgoValue: entry.age,
      lateByDays: entry.late,
    });
  }

  await cancelledIncoming({
    supplierKey: 'cedarElectronics',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'laptop', quantity: 15, price: 820 }],
    expectedDaysAgo: 14,
  });

  // Balanced baseline/recent customer demand at each warehouse -> NOT anomaly.
  for (const entry of [
    { wh: 'beirut', qty: 10, age: 45, customer: 'Cedar Retail Group' },
    { wh: 'beirut', qty: 10, age: 15, customer: 'AUB Campus Store' },
    { wh: 'tripoli', qty: 10, age: 45, customer: 'NorthStar Trading' },
    { wh: 'tripoli', qty: 10, age: 15, customer: 'NorthStar Trading' },
    { wh: 'saida', qty: 9, age: 45, customer: 'Saida Wholesale Group' },
    { wh: 'saida', qty: 9, age: 15, customer: 'Saida Wholesale Group' },
    { wh: 'zahle', qty: 4, age: 45, customer: 'Bekaa Office Solutions' },
    { wh: 'zahle', qty: 4, age: 15, customer: 'Bekaa Office Solutions' },
  ]) {
    await completedOutgoing({
      warehouseKey: entry.wh,
      lines: [{ productKey: 'laptop', quantity: entry.qty }],
      daysAgoValue: entry.age,
      customer: entry.customer,
    });
  }

  // Active reservations make Beirut show onHand > available.
  await pendingOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'laptop', quantity: 20 }],
    expectedDate: daysFromNow(2),
    customer: 'Levant Corporate Services',
  });

  await pendingTransfer({
    sourceWarehouseKey: 'beirut',
    destinationWarehouseKey: 'zahle',
    lines: [{ productKey: 'laptop', quantity: 8 }],
    expectedDate: daysFromNow(4),
  });

  // Overdue incoming: specifically useful for Control Tower's AI alternative
  // supplier recommendation. TechSource/Levant have enough history to rank.
  await pendingIncoming({
    supplierKey: 'cedarElectronics',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'laptop', quantity: 12, price: 812 }],
    expectedDate: daysAgo(4),
    createdDaysAgo: 12,
  });

  await pendingIncoming({
    supplierKey: 'techSource',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'laptop', quantity: 10, price: 783 }],
    expectedDate: daysFromNow(3),
  });

  // Historical inactive supplier data: visible historically, excluded from
  // future supplier recommendations because the supplier is inactive.
  await completedIncoming({
    supplierKey: 'legacyTech',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'laptop', quantity: 8, price: 760 }],
    daysAgoValue: 300,
    lateByDays: 10,
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'laptop', quantity: 8 }],
    daysAgoValue: 250,
    customer: 'Cedar Retail Group',
  });

  // --------------------------------------------------------------------------
  // MECHANICAL KEYBOARD — TRUE STOCKOUT, no donor warehouse.
  // Beirut is intentionally sold exactly to zero. Tripoli and Saida sit
  // exactly at their thresholds, so there is no transfer surplus.
  // --------------------------------------------------------------------------
  await completedIncoming({
    supplierKey: 'techSource',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'keyboard', quantity: 60, price: 52 }],
    daysAgoValue: 85,
  });
  await completedIncoming({
    supplierKey: 'techSource',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'keyboard', quantity: 25, price: 51 }],
    daysAgoValue: 70,
  });
  await completedIncoming({
    supplierKey: 'techSource',
    warehouseKey: 'saida',
    lines: [{ productKey: 'keyboard', quantity: 25, price: 53 }],
    daysAgoValue: 65,
  });

  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'keyboard', quantity: 30 }],
    daysAgoValue: 45,
    customer: 'Cedar Retail Group',
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'keyboard', quantity: 30 }],
    daysAgoValue: 15,
    customer: 'Levant Corporate Services',
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'keyboard', quantity: 10 }],
    daysAgoValue: 45,
    customer: 'NorthStar Trading',
  });
  await completedOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'keyboard', quantity: 10 }],
    daysAgoValue: 45,
    customer: 'Saida Wholesale Group',
  });

  // Tripoli/Saida each end at 15, exactly threshold.
  // Add recent quantity equal to baseline by topping up first.
  await completedIncoming({
    supplierKey: 'techSource',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'keyboard', quantity: 10, price: 52 }],
    daysAgoValue: 30,
  });
  await completedIncoming({
    supplierKey: 'techSource',
    warehouseKey: 'saida',
    lines: [{ productKey: 'keyboard', quantity: 10, price: 52 }],
    daysAgoValue: 30,
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'keyboard', quantity: 10 }],
    daysAgoValue: 15,
    customer: 'NorthStar Trading',
  });
  await completedOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'keyboard', quantity: 10 }],
    daysAgoValue: 15,
    customer: 'Saida Wholesale Group',
  });

  // --------------------------------------------------------------------------
  // WIRELESS HEADPHONES — RESTOCK + TRANSFER recommendation.
  // Tripoli: 8 available, threshold 25 -> AT_RISK, ~15 days of supply (a
  // sharper, more urgent stockout-risk narrative than a longer runway).
  // Recent (last 30 days) and baseline (30-60 days ago) OUTGOING are kept
  // equal (16 each) specifically so this tuning doesn't also trip a
  // consumption-anomaly alert as an unintended side effect.
  // Saida:   70 on hand, threshold 25 -> donor surplus, no pending incoming.
  // Beirut:  exactly 25 -> neutral.
  // --------------------------------------------------------------------------
  await completedIncoming({
    supplierKey: 'cedarElectronics',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'headphones', quantity: 41, price: 59 }],
    daysAgoValue: 95,
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'headphones', quantity: 8 }],
    daysAgoValue: 45,
    customer: 'Cedar Retail Group',
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'headphones', quantity: 8 }],
    daysAgoValue: 15,
    customer: 'Cedar Retail Group',
  });

  await completedIncoming({
    supplierKey: 'cedarElectronics',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'headphones', quantity: 40, price: 58 }],
    daysAgoValue: 90,
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'headphones', quantity: 16 }],
    daysAgoValue: 45,
    customer: 'NorthStar Trading',
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'headphones', quantity: 8 }],
    daysAgoValue: 15,
    customer: 'NorthStar Trading',
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'headphones', quantity: 8 }],
    daysAgoValue: 5,
    customer: 'NorthStar Trading',
  });

  await completedIncoming({
    supplierKey: 'cedarElectronics',
    warehouseKey: 'saida',
    lines: [{ productKey: 'headphones', quantity: 90, price: 57 }],
    daysAgoValue: 90,
  });
  await completedOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'headphones', quantity: 10 }],
    daysAgoValue: 45,
    customer: 'Saida Wholesale Group',
  });
  await completedOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'headphones', quantity: 10 }],
    daysAgoValue: 15,
    customer: 'Saida Wholesale Group',
  });

  // --------------------------------------------------------------------------
  // USB-C DOCK — currently low, but pending incoming fully fixes it.
  // Current 5 < threshold 20; pending +20 -> projected 25 -> NO restock action.
  // --------------------------------------------------------------------------
  await completedIncoming({
    supplierKey: 'medTech',
    warehouseKey: 'saida',
    lines: [{ productKey: 'dock', quantity: 35, price: 72 }],
    daysAgoValue: 80,
  });
  await completedOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'dock', quantity: 15 }],
    daysAgoValue: 45,
    customer: 'Saida Wholesale Group',
  });
  await completedOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'dock', quantity: 15 }],
    daysAgoValue: 15,
    customer: 'Saida Wholesale Group',
  });
  await pendingIncoming({
    supplierKey: 'medTech',
    warehouseKey: 'saida',
    lines: [{ productKey: 'dock', quantity: 20, price: 71 }],
    expectedDate: daysFromNow(2),
  });

  // Give USB-C Dock supplier history enough depth for normal AI questions.
  await completedIncoming({
    supplierKey: 'medTech',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'dock', quantity: 45, price: 70 }],
    daysAgoValue: 160,
  });
  await completedIncoming({
    supplierKey: 'medTech',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'dock', quantity: 30, price: 73 }],
    daysAgoValue: 110,
    lateByDays: 2,
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'dock', quantity: 10 }],
    daysAgoValue: 45,
    customer: 'AUB Campus Store',
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'dock', quantity: 10 }],
    daysAgoValue: 15,
    customer: 'AUB Campus Store',
  });

  // --------------------------------------------------------------------------
  // WIRELESS MOUSE — clear positive consumption anomaly, healthy stock.
  // Beirut baseline = 10, recent = 50 => +400%.
  // --------------------------------------------------------------------------
  await completedIncoming({
    supplierKey: 'cedarElectronics',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'mouse', quantity: 220, price: 16 }],
    daysAgoValue: 120,
  });
  await completedIncoming({
    supplierKey: 'cedarElectronics',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'mouse', quantity: 80, price: 16.5 }],
    daysAgoValue: 20,
  });
  await completedIncoming({
    supplierKey: 'cedarElectronics',
    warehouseKey: 'saida',
    lines: [{ productKey: 'mouse', quantity: 90, price: 16.2 }],
    daysAgoValue: 100,
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'mouse', quantity: 10 }],
    daysAgoValue: 45,
    customer: 'Cedar Retail Group',
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'mouse', quantity: 20 }],
    daysAgoValue: 20,
    customer: 'AUB Campus Store',
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'mouse', quantity: 30 }],
    daysAgoValue: 5,
    customer: 'Levant Corporate Services',
  });
  await completedOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'mouse', quantity: 12 }],
    daysAgoValue: 45,
    customer: 'Saida Wholesale Group',
  });
  await completedOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'mouse', quantity: 12 }],
    daysAgoValue: 15,
    customer: 'Saida Wholesale Group',
  });

  // --------------------------------------------------------------------------
  // NOTEBOOK SET — clear negative consumption anomaly, still healthy.
  // Tripoli baseline 80, recent 20 => -75%.
  // --------------------------------------------------------------------------
  await completedIncoming({
    supplierKey: 'campusSupply',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'notebook', quantity: 420, price: 2 }],
    daysAgoValue: 110,
  });
  await completedIncoming({
    supplierKey: 'campusSupply',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'notebook', quantity: 500, price: 1.9 }],
    daysAgoValue: 150,
  });
  await completedIncoming({
    supplierKey: 'campusSupply',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'notebook', quantity: 180, price: 2.1 }],
    daysAgoValue: 70,
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'notebook', quantity: 80 }],
    daysAgoValue: 45,
    customer: 'NorthStar Trading',
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'notebook', quantity: 20 }],
    daysAgoValue: 15,
    customer: 'NorthStar Trading',
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'notebook', quantity: 90 }],
    daysAgoValue: 45,
    customer: 'AUB Campus Store',
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'notebook', quantity: 90 }],
    daysAgoValue: 15,
    customer: 'AUB Campus Store',
  });

  // --------------------------------------------------------------------------
  // YOGA MAT — zero-baseline anomaly special case.
  // No OUTGOING in baseline window, 20 units in recent window.
  // --------------------------------------------------------------------------
  await completedIncoming({
    supplierKey: 'activeLife',
    warehouseKey: 'saida',
    lines: [{ productKey: 'yogaMat', quantity: 100, price: 15 }],
    daysAgoValue: 90,
  });
  await completedIncoming({
    supplierKey: 'activeLife',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'yogaMat', quantity: 80, price: 15.5 }],
    daysAgoValue: 75,
  });
  await completedIncoming({
    supplierKey: 'activeLife',
    warehouseKey: 'saida',
    lines: [{ productKey: 'yogaMat', quantity: 30, price: 14.8 }],
    daysAgoValue: 40,
  });
  await completedOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'yogaMat', quantity: 20 }],
    daysAgoValue: 10,
    customer: 'Saida Wholesale Group',
  });
  // Beirut gets normal balanced history so only Saida is anomalous.
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'yogaMat', quantity: 8 }],
    daysAgoValue: 45,
    customer: 'AUB Campus Store',
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'yogaMat', quantity: 8 }],
    daysAgoValue: 15,
    customer: 'AUB Campus Store',
  });

  // --------------------------------------------------------------------------
  // ERGONOMIC OFFICE CHAIR — flagship DEAD STOCK AI scenario.
  // Beirut has inventory and has NEVER had customer OUTGOING. A recent
  // ADJUSTMENT proves non-customer movement does not reset dead-stock clock.
  // Tripoli has recent customer demand, so the dead-stock recommendation AI
  // has a real destination with evidence.
  // --------------------------------------------------------------------------
  await completedIncoming({
    supplierKey: 'officeWorks',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'chair', quantity: 30, price: 93 }],
    daysAgoValue: 125,
  });
  await adjustment({
    warehouseKey: 'beirut',
    productKey: 'chair',
    quantity: 2,
    daysAgoValue: 10,
  });

  await completedIncoming({
    supplierKey: 'officeWorks',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'chair', quantity: 40, price: 95 }],
    daysAgoValue: 80,
  });
  await completedIncoming({
    supplierKey: 'officeWorks',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'chair', quantity: 15, price: 92 }],
    daysAgoValue: 35,
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'chair', quantity: 8 }],
    daysAgoValue: 40,
    customer: 'NorthStar Trading',
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'chair', quantity: 7 }],
    daysAgoValue: 12,
    customer: 'NorthStar Trading',
  });

  // --------------------------------------------------------------------------
  // STANDING DESK — second dead-stock pattern.
  // Last customer OUTGOING was 95 days ago, then a recent INCOMING arrived.
  // It is still dead stock because INCOMING does not reset customer-demand age.
  // --------------------------------------------------------------------------
  await completedIncoming({
    supplierKey: 'cedarHome',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'desk', quantity: 24, price: 235 }],
    daysAgoValue: 150,
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'desk', quantity: 4 }],
    daysAgoValue: 95,
    customer: 'NorthStar Trading',
  });
  await completedIncoming({
    supplierKey: 'cedarHome',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'desk', quantity: 8, price: 238 }],
    daysAgoValue: 20,
  });
  // Healthy demand elsewhere gives a real redistribution destination.
  await completedIncoming({
    supplierKey: 'cedarHome',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'desk', quantity: 30, price: 232 }],
    daysAgoValue: 100,
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'desk', quantity: 5 }],
    daysAgoValue: 45,
    customer: 'Levant Corporate Services',
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'desk', quantity: 5 }],
    daysAgoValue: 15,
    customer: 'Levant Corporate Services',
  });

  // --------------------------------------------------------------------------
  // HOODED SWEATSHIRT — low stock, PURCHASE_REQUIRED, no donor.
  // Beirut ends 15 with threshold 25. Tripoli/Saida end exactly threshold.
  // --------------------------------------------------------------------------
  await completedIncoming({
    supplierKey: 'beirutTextiles',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'hoodie', quantity: 55, price: 14 }],
    daysAgoValue: 80,
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'hoodie', quantity: 20 }],
    daysAgoValue: 45,
    customer: 'Cedar Retail Group',
  });
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'hoodie', quantity: 20 }],
    daysAgoValue: 15,
    customer: 'Cedar Retail Group',
  });

  for (const wh of ['tripoli', 'saida']) {
    await completedIncoming({
      supplierKey: 'beirutTextiles',
      warehouseKey: wh,
      lines: [{ productKey: 'hoodie', quantity: 35, price: 14.2 }],
      daysAgoValue: 70,
    });
    await completedOutgoing({
      warehouseKey: wh,
      lines: [{ productKey: 'hoodie', quantity: 5 }],
      daysAgoValue: 45,
      customer:
        wh === 'tripoli' ? 'NorthStar Trading' : 'Saida Wholesale Group',
    });
    await completedOutgoing({
      warehouseKey: wh,
      lines: [{ productKey: 'hoodie', quantity: 5 }],
      daysAgoValue: 15,
      customer:
        wh === 'tripoli' ? 'NorthStar Trading' : 'Saida Wholesale Group',
    });
  }

  // --------------------------------------------------------------------------
  // ELECTRIC KETTLE — low stock with pending incoming that is NOT enough.
  // Tripoli current 8, threshold 20; pending +5 -> projected 13 -> restock 7.
  // --------------------------------------------------------------------------
  await completedIncoming({
    supplierKey: 'homePlus',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'kettle', quantity: 38, price: 22 }],
    daysAgoValue: 85,
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'kettle', quantity: 15 }],
    daysAgoValue: 45,
    customer: 'NorthStar Trading',
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'kettle', quantity: 15 }],
    daysAgoValue: 15,
    customer: 'NorthStar Trading',
  });
  await pendingIncoming({
    supplierKey: 'homePlus',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'kettle', quantity: 5, price: 21.5 }],
    expectedDate: daysFromNow(3),
  });

  // Other kettle warehouses are neutral, not donors.
  for (const wh of ['beirut', 'saida']) {
    await completedIncoming({
      supplierKey: 'homePlus',
      warehouseKey: wh,
      lines: [{ productKey: 'kettle', quantity: 30, price: 22.5 }],
      daysAgoValue: 70,
    });
    await completedOutgoing({
      warehouseKey: wh,
      lines: [{ productKey: 'kettle', quantity: 5 }],
      daysAgoValue: 45,
      customer: wh === 'beirut' ? 'AUB Campus Store' : 'Saida Wholesale Group',
    });
    await completedOutgoing({
      warehouseKey: wh,
      lines: [{ productKey: 'kettle', quantity: 5 }],
      daysAgoValue: 15,
      customer: wh === 'beirut' ? 'AUB Campus Store' : 'Saida Wholesale Group',
    });
  }

  // ==========================================================================
  // 8. LARGE HEALTHY DATASET
  // ==========================================================================
  // These products all have:
  // - multiple completed INCOMING transactions
  // - multiple completed OUTGOING transactions
  // - sales across old + recent periods
  // - two warehouses
  // - balanced anomaly windows
  // This makes Analytics, SQL-RAG and the AI agent feel like a real ERP.
  // rainJacket, coffeeMaker, and bands are deliberately NOT here (see
  // "DEAD-STOCK DONORS FOR RESTOCK AI" below) - each needs exactly ONE real
  // donor warehouse for its Restock "Recommend Solution" transfer_in demo,
  // and the real donor-matching algorithm (stock-insights.service.ts's
  // getTransferRecommendations) processes candidate donors in warehouseId
  // order, taking the first that qualifies - it does not prefer a
  // dead-stock donor over a merely-healthy one. Giving these 3 products
  // healthyConfigs stock at Beirut (warehouseId 1, lower than every
  // intended donor) silently gave Beirut's enormous, unrelated surplus
  // priority over the real, intentional dead-stock donor every time,
  // making that donor block completely inert - a real, confirmed bug this
  // fixed. The intended donor is now the ONLY warehouse (besides the
  // at-risk one) holding any stock of these 3 products at all.
  const healthyConfigs = [
    ['monitor', 'techSource', 'beirut', 'tripoli'],
    ['deskLamp', 'officeWorks', 'beirut', 'saida'],
    ['tshirt', 'beirutTextiles', 'beirut', 'tripoli'],
    ['calculator', 'campusSupply', 'beirut', 'saida'],
    ['campusBackpack', 'campusSupply', 'beirut', 'tripoli'],
    ['waterBottle', 'homePlus', 'saida', 'beirut'],
    ['hikingBackpack', 'activeLife', 'tripoli', 'beirut'],
    ['hairDryer', 'carePlus', 'beirut', 'saida'],
    ['toothbrush', 'carePlus', 'saida', 'beirut'],
    ['groomingKit', 'carePlus', 'tripoli', 'zahle'],
    ['storageBin', 'cedarHome', 'beirut', 'tripoli'],
  ] as const;

  for (const [
    index,
    [productKey, supplierKey, primary, secondary],
  ] of healthyConfigs.entries()) {
    await healthyHistory({
      productKey,
      supplierKey,
      primaryWarehouseKey: primary,
      secondaryWarehouseKey: secondary,
      customerOffset: index,
    });
  }

  // A normal completed transfer supplies TRANSFER_OUT + TRANSFER_IN history.
  await completedTransfer({
    sourceWarehouseKey: 'beirut',
    destinationWarehouseKey: 'tripoli',
    lines: [{ productKey: 'campusBackpack', quantity: 12 }],
    daysAgoValue: 25,
  });

  // Positive and negative ADJUSTMENT coverage.
  await adjustment({
    warehouseKey: 'tripoli',
    productKey: 'groomingKit',
    quantity: -3,
    daysAgoValue: 8,
  });
  await adjustment({
    warehouseKey: 'beirut',
    productKey: 'waterBottle',
    quantity: 5,
    daysAgoValue: 12,
  });

  // --------------------------------------------------------------------------
  // STATUS + CALENDAR COVERAGE
  // --------------------------------------------------------------------------

  // Overdue OUTGOING: warning, but no AI alternative-supplier button.
  await pendingOutgoing({
    warehouseKey: 'beirut',
    lines: [{ productKey: 'tshirt', quantity: 15 }],
    expectedDate: daysAgo(2),
    customer: 'Cedar Retail Group',
    createdDaysAgo: 8,
  });

  // Overdue TRANSFER.
  await pendingTransfer({
    sourceWarehouseKey: 'tripoli',
    destinationWarehouseKey: 'beirut',
    lines: [{ productKey: 'campusBackpack', quantity: 6 }],
    expectedDate: daysAgo(1),
    createdDaysAgo: 7,
  });

  // Cancelled OUTGOING + CANCELLED reservation.
  await cancelledOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'rainJacket', quantity: 6 }],
    expectedDaysAgo: 3,
    customer: 'Saida Wholesale Group',
  });

  // Cancelled TRANSFER + CANCELLED reservation.
  await cancelledTransfer({
    sourceWarehouseKey: 'beirut',
    destinationWarehouseKey: 'tripoli',
    lines: [{ productKey: 'monitor', quantity: 4 }],
    expectedDaysAgo: 5,
  });

  // One more cancelled purchase in a non-electronics category.
  await cancelledIncoming({
    supplierKey: 'homePlus',
    warehouseKey: 'zahle',
    lines: [{ productKey: 'coffeeMaker', quantity: 8 }],
    expectedDaysAgo: 6,
  });

  // A few explicitly upcoming transactions so Calendar is visually populated.
  await pendingOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'calculator', quantity: 5 }],
    expectedDate: daysFromNow(5),
    customer: 'Amman Tech Market',
  });
  await pendingIncoming({
    supplierKey: 'campusSupply',
    warehouseKey: 'beirut',
    lines: [{ productKey: 'notebook', quantity: 100, price: 2 }],
    expectedDate: daysFromNow(6),
  });

  // Historical multi-line customer order: useful for transaction detail and
  // "whole order" AI questions.
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [
      { productKey: 'monitor', quantity: 2 },
      { productKey: 'mouse', quantity: 4 },
      { productKey: 'deskLamp', quantity: 3 },
    ],
    daysAgoValue: 75,
    customer: 'Levant Corporate Services',
  });

  // More geographic/customer variety for SQL-RAG.
  await completedOutgoing({
    warehouseKey: 'beirut',
    lines: [
      { productKey: 'laptop', quantity: 2 },
      { productKey: 'dock', quantity: 3 },
    ],
    daysAgoValue: 65,
    customer: 'Amman Tech Market',
  });
  await completedOutgoing({
    warehouseKey: 'saida',
    lines: [
      { productKey: 'waterBottle', quantity: 10 },
      { productKey: 'yogaMat', quantity: 5 },
    ],
    daysAgoValue: 70,
    customer: 'Cyprus Retail Partners',
  });
  // ==========================================================================
  // EXTRA TRANSFER RECOMMENDATION DEMO SCENARIOS
  // ==========================================================================
  // Baseline/recent demand is balanced so these do NOT create fake
  // consumption-anomaly alerts.

  // Rain Jacket @ Tripoli: 14 available, threshold 20.
  // Donor is Zahle - see "DEAD-STOCK DONORS FOR RESTOCK AI" below.
  await completedIncoming({
    supplierKey: 'beirutTextiles',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'rainJacket', quantity: 18, price: 31 }],
    daysAgoValue: 80,
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'rainJacket', quantity: 2 }],
    daysAgoValue: 45,
    customer: 'NorthStar Trading',
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'rainJacket', quantity: 2 }],
    daysAgoValue: 15,
    customer: 'NorthStar Trading',
  });

  // Coffee Maker @ Tripoli: 11 available, threshold 15.
  // Donor is Saida - see "DEAD-STOCK DONORS FOR RESTOCK AI" below.
  await completedIncoming({
    supplierKey: 'homePlus',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'coffeeMaker', quantity: 15, price: 41 }],
    daysAgoValue: 80,
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'coffeeMaker', quantity: 2 }],
    daysAgoValue: 45,
    customer: 'NorthStar Trading',
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'coffeeMaker', quantity: 2 }],
    daysAgoValue: 15,
    customer: 'NorthStar Trading',
  });

  // Resistance Band Set @ Saida: 19 available, threshold 25.
  // Donor is Tripoli - see "DEAD-STOCK DONORS FOR RESTOCK AI" below.
  await completedIncoming({
    supplierKey: 'activeLife',
    warehouseKey: 'saida',
    lines: [{ productKey: 'bands', quantity: 25, price: 9 }],
    daysAgoValue: 80,
  });
  await completedOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'bands', quantity: 3 }],
    daysAgoValue: 45,
    customer: 'Saida Wholesale Group',
  });
  await completedOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'bands', quantity: 3 }],
    daysAgoValue: 15,
    customer: 'Saida Wholesale Group',
  });

  // ==========================================================================
  // DEAD-STOCK DONORS FOR RESTOCK AI
  // ==========================================================================
  // These warehouses intentionally hold surplus stock that has not had a
  // customer OUTGOING for 60+ days, so Restock "Recommend Solution" can
  // recommend an internal transfer from dead stock before suggesting purchase.
  //
  // For rainJacket/bands/coffeeMaker, the warehouse named here as the donor
  // is the ONLY warehouse (besides the at-risk one above) that holds any
  // stock of that product at all - see healthyConfigs above for why that
  // matters: the real donor-matching algorithm picks the first QUALIFYING
  // warehouse in warehouseId order, not the "best" one, so a second,
  // unrelated warehouse with its own (larger, healthier) surplus would
  // silently outrank this one and make it never get picked.

  // Wireless Headphones:
  // Tripoli is low. Saida becomes a dead-stock donor.
  await completedIncoming({
    supplierKey: 'cedarElectronics',
    warehouseKey: 'saida',
    lines: [{ productKey: 'headphones', quantity: 20, price: 58 }],
    daysAgoValue: 70,
  });

  // Rain Jacket:
  // Tripoli is low. Zahle holds surplus dead stock.
  await completedIncoming({
    supplierKey: 'beirutTextiles',
    warehouseKey: 'zahle',
    lines: [{ productKey: 'rainJacket', quantity: 60, price: 31 }],
    daysAgoValue: 90,
  });
  await completedOutgoing({
    warehouseKey: 'zahle',
    lines: [{ productKey: 'rainJacket', quantity: 5 }],
    daysAgoValue: 75,
    customer: 'Bekaa Office Solutions',
  });

  // Resistance Band Set:
  // Saida is low. Tripoli holds surplus dead stock.
  await completedIncoming({
    supplierKey: 'activeLife',
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'bands', quantity: 70, price: 9 }],
    daysAgoValue: 100,
  });
  await completedOutgoing({
    warehouseKey: 'tripoli',
    lines: [{ productKey: 'bands', quantity: 5 }],
    daysAgoValue: 75,
    customer: 'NorthStar Trading',
  });

  // Coffee Maker:
  // Tripoli is low. Saida holds surplus dead stock.
  await completedIncoming({
    supplierKey: 'homePlus',
    warehouseKey: 'saida',
    lines: [{ productKey: 'coffeeMaker', quantity: 55, price: 41 }],
    daysAgoValue: 95,
  });
  await completedOutgoing({
    warehouseKey: 'saida',
    lines: [{ productKey: 'coffeeMaker', quantity: 5 }],
    daysAgoValue: 75,
    customer: 'Saida Wholesale Group',
  });
  // ==========================================================================
  // 9. RECENT REVENUE & WAREHOUSE BALANCE (last 30 days)
  // ==========================================================================
  // Extra COMPLETED OUTGOING sales, spread across products/customers/all 4
  // warehouses, entirely within the last 30 days, using existing selling
  // prices and existing (already-healthy, high-buffer) stock. This is
  // additive on top of the targeted demo scenarios above — it never touches
  // a product/warehouse pair that's part of an engineered anomaly, dead
  // stock, restock, transfer, or true-stockout scenario, so none of those
  // are affected. Zahle gets two brand-new product lines (Desk Lamp, Water
  // Bottle) on top of its existing Grooming Kit stock so it isn't carrying
  // its whole recent history on a single product.
  //
  // Every recent-window (0-30 days ago) sale below has a same-quantity
  // companion in the baseline window (30-60 days ago, all placed at day
  // -45) for the exact same product/warehouse pair — same technique as the
  // Wireless Headphones Tripoli tuning above. Without this, each addition
  // would silently create an unintended consumption anomaly (a healthy
  // product's real getConsumptionAnomalies() baseline-vs-recent comparison
  // is genuinely 50%-threshold-sensitive, and healthyHistory()'s own
  // baseline/recent quantities are deliberately small), on top of the 3
  // actually-engineered anomaly demos (Mouse/Notebook/Yoga Mat).
  await completedIncoming({
    supplierKey: 'officeWorks',
    warehouseKey: 'zahle',
    lines: [{ productKey: 'deskLamp', quantity: 100, price: 24 }],
    daysAgoValue: 100,
  });
  await completedIncoming({
    supplierKey: 'homePlus',
    warehouseKey: 'zahle',
    lines: [{ productKey: 'waterBottle', quantity: 120, price: 11 }],
    daysAgoValue: 100,
  });

  for (const entry of [
    // Beirut
    { wh: 'beirut', product: 'monitor', qty: 15, age: 3, customer: 'AUB Campus Store' },
    { wh: 'beirut', product: 'deskLamp', qty: 20, age: 9, customer: 'Cedar Retail Group' },
    { wh: 'beirut', product: 'hikingBackpack', qty: 18, age: 17, customer: 'Amman Tech Market' },
    { wh: 'beirut', product: 'storageBin', qty: 25, age: 24, customer: 'Cyprus Retail Partners' },
    { wh: 'beirut', product: 'calculator', qty: 20, age: 6, customer: 'AUB Campus Store' },
    // Tripoli
    { wh: 'tripoli', product: 'monitor', qty: 12, age: 4, customer: 'NorthStar Trading' },
    { wh: 'tripoli', product: 'campusBackpack', qty: 20, age: 11, customer: 'NorthStar Trading' },
    { wh: 'tripoli', product: 'tshirt', qty: 30, age: 19, customer: 'Amman Tech Market' },
    { wh: 'tripoli', product: 'storageBin', qty: 15, age: 26, customer: 'NorthStar Trading' },
    { wh: 'tripoli', product: 'groomingKit', qty: 15, age: 7, customer: 'Cyprus Retail Partners' },
    // Saida
    { wh: 'saida', product: 'deskLamp', qty: 18, age: 5, customer: 'Saida Wholesale Group' },
    { wh: 'saida', product: 'calculator', qty: 16, age: 12, customer: 'Saida Wholesale Group' },
    { wh: 'saida', product: 'waterBottle', qty: 25, age: 20, customer: 'Saida Wholesale Group' },
    { wh: 'saida', product: 'hairDryer', qty: 14, age: 27, customer: 'Levant Corporate Services' },
    { wh: 'saida', product: 'toothbrush', qty: 20, age: 9, customer: 'Saida Wholesale Group' },
    // Zahle
    { wh: 'zahle', product: 'groomingKit', qty: 14, age: 24, customer: 'Bekaa Office Solutions' },
    { wh: 'zahle', product: 'groomingKit', qty: 12, age: 11, customer: 'Levant Corporate Services' },
    { wh: 'zahle', product: 'groomingKit', qty: 10, age: 4, customer: 'Bekaa Office Solutions' },
    { wh: 'zahle', product: 'deskLamp', qty: 14, age: 20, customer: 'Bekaa Office Solutions' },
    { wh: 'zahle', product: 'deskLamp', qty: 12, age: 7, customer: 'Levant Corporate Services' },
    { wh: 'zahle', product: 'waterBottle', qty: 18, age: 19, customer: 'Bekaa Office Solutions' },
    { wh: 'zahle', product: 'waterBottle', qty: 14, age: 6, customer: 'Bekaa Office Solutions' },
  ]) {
    await completedOutgoing({
      warehouseKey: entry.wh,
      lines: [{ productKey: entry.product, quantity: entry.qty }],
      daysAgoValue: entry.age,
      customer: entry.customer,
    });
  }

  // Baseline-window companions (day -45) — same product/warehouse pair,
  // quantity equal to the SUM of that pair's recent-window additions above,
  // so recent stays close to baseline and none of these trip a new
  // unintended consumption anomaly. These sit outside the last-30-day
  // window, so they do not affect the 30-day revenue figures above.
  for (const entry of [
    { wh: 'beirut', product: 'monitor', qty: 15, customer: 'AUB Campus Store' },
    { wh: 'beirut', product: 'deskLamp', qty: 20, customer: 'Cedar Retail Group' },
    { wh: 'beirut', product: 'hikingBackpack', qty: 18, customer: 'Amman Tech Market' },
    { wh: 'beirut', product: 'storageBin', qty: 25, customer: 'Cyprus Retail Partners' },
    { wh: 'beirut', product: 'calculator', qty: 20, customer: 'AUB Campus Store' },
    { wh: 'tripoli', product: 'monitor', qty: 12, customer: 'NorthStar Trading' },
    { wh: 'tripoli', product: 'campusBackpack', qty: 20, customer: 'NorthStar Trading' },
    { wh: 'tripoli', product: 'tshirt', qty: 30, customer: 'NorthStar Trading' },
    { wh: 'tripoli', product: 'storageBin', qty: 15, customer: 'NorthStar Trading' },
    { wh: 'tripoli', product: 'groomingKit', qty: 15, customer: 'NorthStar Trading' },
    { wh: 'saida', product: 'deskLamp', qty: 18, customer: 'Saida Wholesale Group' },
    { wh: 'saida', product: 'calculator', qty: 16, customer: 'Saida Wholesale Group' },
    { wh: 'saida', product: 'waterBottle', qty: 25, customer: 'Saida Wholesale Group' },
    { wh: 'saida', product: 'hairDryer', qty: 14, customer: 'Saida Wholesale Group' },
    { wh: 'saida', product: 'toothbrush', qty: 20, customer: 'Saida Wholesale Group' },
    { wh: 'zahle', product: 'groomingKit', qty: 36, customer: 'Bekaa Office Solutions' },
    { wh: 'zahle', product: 'deskLamp', qty: 26, customer: 'Bekaa Office Solutions' },
    { wh: 'zahle', product: 'waterBottle', qty: 32, customer: 'Bekaa Office Solutions' },
  ]) {
    await completedOutgoing({
      warehouseKey: entry.wh,
      lines: [{ productKey: entry.product, quantity: entry.qty }],
      daysAgoValue: 45,
      customer: entry.customer,
    });
  }

  // ==========================================================================
  // 10. REBUILD WAREHOUSE INVENTORY FROM THE LEDGER
  // ==========================================================================
  // CRITICAL: only create rows for pairs that have an actual StockMovement.
  // Do NOT create Product x Warehouse zero rows. getStockoutRisk() legitimately
  // treats a real inventory row with available <= 0 as OUT_OF_STOCK; making
  // fake zero rows for never-stocked pairs would manufacture fake alerts.
  const movements = await prisma.stockMovement.findMany({
    orderBy: { id: 'asc' },
  });

  const onHandByKey = new Map<string, number>();
  for (const movement of movements) {
    const key = `${movement.productId}:${movement.warehouseId}`;
    const current = onHandByKey.get(key) ?? 0;
    let delta = 0;
    switch (movement.type) {
      case StockMovementType.INCOMING:
      case StockMovementType.TRANSFER_IN:
        delta = movement.quantity;
        break;
      case StockMovementType.OUTGOING:
      case StockMovementType.TRANSFER_OUT:
        delta = -movement.quantity;
        break;
      case StockMovementType.ADJUSTMENT:
        delta = movement.quantity;
        break;
    }
    const next = current + delta;
    ensure(next >= 0, `ledger would make ${key} negative (${next})`);
    onHandByKey.set(key, next);
  }

  const specByProductId = new Map(
    productSpecs.map((spec) => [product(spec.key).id, spec]),
  );

  for (const [key, onHand] of onHandByKey.entries()) {
    const [productIdRaw, warehouseIdRaw] = key.split(':');
    const productId = Number(productIdRaw);
    const warehouseId = Number(warehouseIdRaw);
    const spec = specByProductId.get(productId);
    ensure(spec, `missing threshold for product id ${productId}`);

    await prisma.warehouseInventory.create({
      data: {
        productId,
        warehouseId,
        onHand,
        reorderThreshold: spec.reorderThreshold,
      },
    });
  }

  // ==========================================================================
  // 11. SEED ASSERTIONS — FAIL FAST IF A FUTURE EDIT BREAKS THE DEMO
  // ==========================================================================

  async function available(productKey: string, warehouseKey: string) {
    const p = product(productKey);
    const w = warehouse(warehouseKey);
    const inv = await prisma.warehouseInventory.findUnique({
      where: {
        productId_warehouseId: {
          productId: p.id,
          warehouseId: w.id,
        },
      },
    });
    ensure(inv, `${p.name} should have inventory at ${w.name}`);

    const active = await prisma.reservation.aggregate({
      _sum: { quantity: true },
      where: {
        productId: p.id,
        warehouseId: w.id,
        status: ReservationStatus.ACTIVE,
      },
    });

    return {
      onHand: inv.onHand,
      threshold: inv.reorderThreshold,
      reserved: active._sum.quantity ?? 0,
      available: inv.onHand - (active._sum.quantity ?? 0),
    };
  }

  async function pendingIncomingQuantity(
    productKey: string,
    warehouseKey: string,
  ) {
    const p = product(productKey);
    const w = warehouse(warehouseKey);

    const items = await prisma.inventoryTransactionItem.findMany({
      where: {
        productId: p.id,
        transaction: {
          status: InventoryTransactionStatus.PENDING,
          destinationWarehouseId: w.id,
          type: {
            in: [
              InventoryTransactionType.INCOMING,
              InventoryTransactionType.TRANSFER,
            ],
          },
        },
      },
    });

    return items.reduce((sum, item) => sum + item.quantity, 0);
  }

  async function outgoingQty(
    productKey: string,
    warehouseKey: string,
    startDaysAgo: number,
    endDaysAgo: number,
  ) {
    const p = product(productKey);
    const w = warehouse(warehouseKey);
    const older = daysAgo(startDaysAgo);
    const newer = daysAgo(endDaysAgo);

    const rows = await prisma.stockMovement.findMany({
      where: {
        productId: p.id,
        warehouseId: w.id,
        type: StockMovementType.OUTGOING,
        createdAt: {
          gte: older,
          lt: newer,
        },
      },
    });
    return rows.reduce((sum, row) => sum + row.quantity, 0);
  }

  const keyboardBeirut = await available('keyboard', 'beirut');
  ensure(
    keyboardBeirut.available === 0,
    `Keyboard Beirut must be true stockout; got ${keyboardBeirut.available}`,
  );

  const hpTripoli = await available('headphones', 'tripoli');
  const hpSaida = await available('headphones', 'saida');
  ensure(
    hpTripoli.available > 0 && hpTripoli.available < hpTripoli.threshold,
    'Headphones Tripoli must be low-but-not-zero',
  );
  ensure(
    hpSaida.available > hpSaida.threshold,
    'Headphones Saida must have donor surplus',
  );

  // Same shape as the headphones checks above, for the 3 dead-stock-donor
  // Restock scenarios that healthyConfigs' removal (see that array's own
  // comment) specifically protects: without it, a real, confirmed bug let
  // an unrelated warehouse's much larger surplus silently outrank the
  // intended donor in the real donor-matching algorithm, making these
  // assertions the only thing that would have caught it.
  const rainJacketTripoli = await available('rainJacket', 'tripoli');
  const rainJacketZahle = await available('rainJacket', 'zahle');
  ensure(
    rainJacketTripoli.available > 0 &&
      rainJacketTripoli.available < rainJacketTripoli.threshold,
    'Rain Jacket Tripoli must be low-but-not-zero',
  );
  ensure(
    rainJacketZahle.available > rainJacketZahle.threshold,
    'Rain Jacket Zahle must have donor surplus',
  );

  const coffeeMakerTripoli = await available('coffeeMaker', 'tripoli');
  const coffeeMakerSaida = await available('coffeeMaker', 'saida');
  ensure(
    coffeeMakerTripoli.available > 0 &&
      coffeeMakerTripoli.available < coffeeMakerTripoli.threshold,
    'Coffee Maker Tripoli must be low-but-not-zero',
  );
  ensure(
    coffeeMakerSaida.available > coffeeMakerSaida.threshold,
    'Coffee Maker Saida must have donor surplus',
  );

  const bandsSaida = await available('bands', 'saida');
  const bandsTripoli = await available('bands', 'tripoli');
  ensure(
    bandsSaida.available > 0 && bandsSaida.available < bandsSaida.threshold,
    'Resistance Band Set Saida must be low-but-not-zero',
  );
  ensure(
    bandsTripoli.available > bandsTripoli.threshold,
    'Resistance Band Set Tripoli must have donor surplus',
  );

  const dockSaida = await available('dock', 'saida');
  const dockPending = await pendingIncomingQuantity('dock', 'saida');
  ensure(
    dockSaida.available > 0 && dockSaida.available < dockSaida.threshold,
    'Dock Saida must currently be at risk',
  );
  ensure(
    dockSaida.available + dockPending >= dockSaida.threshold,
    'Dock pending incoming must fully resolve its risk',
  );

  const hoodieBeirut = await available('hoodie', 'beirut');
  ensure(
    hoodieBeirut.available > 0 &&
      hoodieBeirut.available < hoodieBeirut.threshold,
    'Hoodie Beirut must be low stock',
  );

  const kettleTripoli = await available('kettle', 'tripoli');
  const kettlePending = await pendingIncomingQuantity('kettle', 'tripoli');
  ensure(
    kettleTripoli.available > 0 &&
      kettleTripoli.available + kettlePending < kettleTripoli.threshold,
    'Kettle Tripoli must remain low even after pending incoming',
  );

  const mouseBaseline = await outgoingQty('mouse', 'beirut', 60, 30);
  const mouseRecent = await outgoingQty('mouse', 'beirut', 30, 0);
  ensure(
    mouseBaseline === 10,
    `Mouse baseline must be 10, got ${mouseBaseline}`,
  );
  ensure(mouseRecent === 50, `Mouse recent must be 50, got ${mouseRecent}`);

  const notebookBaseline = await outgoingQty('notebook', 'tripoli', 60, 30);
  const notebookRecent = await outgoingQty('notebook', 'tripoli', 30, 0);
  ensure(
    notebookBaseline === 80 && notebookRecent === 20,
    `Notebook anomaly expected 80 -> 20, got ${notebookBaseline} -> ${notebookRecent}`,
  );

  const yogaBaseline = await outgoingQty('yogaMat', 'saida', 60, 30);
  const yogaRecent = await outgoingQty('yogaMat', 'saida', 30, 0);
  ensure(
    yogaBaseline === 0 && yogaRecent === 20,
    `Yoga zero-baseline anomaly expected 0 -> 20, got ${yogaBaseline} -> ${yogaRecent}`,
  );

  const chairBeirut = await available('chair', 'beirut');
  const chairLastOutgoing = await prisma.stockMovement.findFirst({
    where: {
      productId: product('chair').id,
      warehouseId: warehouse('beirut').id,
      type: StockMovementType.OUTGOING,
    },
    orderBy: { createdAt: 'desc' },
  });
  ensure(chairBeirut.onHand > 0, 'Chair Beirut must still hold dead stock');
  ensure(
    chairLastOutgoing === null,
    'Chair Beirut must never have customer OUTGOING',
  );

  const standingDeskLastOutgoing = await prisma.stockMovement.findFirst({
    where: {
      productId: product('desk').id,
      warehouseId: warehouse('tripoli').id,
      type: StockMovementType.OUTGOING,
    },
    orderBy: { createdAt: 'desc' },
  });
  ensure(
    standingDeskLastOutgoing !== null &&
      standingDeskLastOutgoing.createdAt.getTime() <= daysAgo(60).getTime(),
    'Standing Desk Tripoli last customer OUTGOING must be older than dead-stock cutoff',
  );

  // Every movement enum and reservation status exists.
  for (const movementType of Object.values(StockMovementType)) {
    const count = await prisma.stockMovement.count({
      where: { type: movementType },
    });
    ensure(count > 0, `missing movement type ${movementType}`);
  }
  for (const reservationStatus of Object.values(ReservationStatus)) {
    const count = await prisma.reservation.count({
      where: { status: reservationStatus },
    });
    ensure(count > 0, `missing reservation status ${reservationStatus}`);
  }

  // Every transaction type has completed data. Every status exists globally.
  for (const type of Object.values(InventoryTransactionType)) {
    const count = await prisma.inventoryTransaction.count({
      where: { type, status: InventoryTransactionStatus.COMPLETED },
    });
    ensure(count > 0, `missing completed transaction type ${type}`);
  }
  for (const status of Object.values(InventoryTransactionStatus)) {
    const count = await prisma.inventoryTransaction.count({
      where: { status },
    });
    ensure(count > 0, `missing transaction status ${status}`);
  }

  // Every product participates in real operational history.
  for (const spec of productSpecs) {
    const p = product(spec.key);
    const txCount = await prisma.inventoryTransactionItem.count({
      where: { productId: p.id },
    });
    ensure(txCount > 0, `${p.name} has no transaction history`);
  }

  // Reconciliation invariant: WarehouseInventory exactly equals movement ledger.
  for (const [key, expectedOnHand] of onHandByKey.entries()) {
    const [productId, warehouseId] = key.split(':').map(Number);
    const inv = await prisma.warehouseInventory.findUnique({
      where: { productId_warehouseId: { productId, warehouseId } },
    });
    ensure(inv?.onHand === expectedOnHand, `inventory mismatch for ${key}`);
  }

  // --------------------------------------------------------------------------
  // 12. SUMMARY
  // --------------------------------------------------------------------------
  const [
    userCount,
    supplierCount,
    productCount,
    warehouseCount,
    inventoryCount,
    transactionCount,
    movementCount,
    reservationCount,
    reviewCount,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.supplier.count(),
    prisma.product.count(),
    prisma.warehouse.count(),
    prisma.warehouseInventory.count(),
    prisma.inventoryTransaction.count(),
    prisma.stockMovement.count(),
    prisma.reservation.count(),
    prisma.pendingDocumentReview.count(),
  ]);

  const categorized = new Set(
    productSpecs.map((p) => p.category ?? 'Uncategorized'),
  );

  console.log('');
  console.log('✅ FINAL DEMO SEED COMPLETE');
  console.log(`Users: ${userCount}`);
  console.log(`Suppliers: ${supplierCount}`);
  console.log(
    `Products: ${productCount} across ${categorized.size} category buckets`,
  );
  console.log(`Warehouses: ${warehouseCount}`);
  console.log(`Inventory rows (real ledger pairs only): ${inventoryCount}`);
  console.log(`Transactions: ${transactionCount}`);
  console.log(`Stock movements: ${movementCount}`);
  console.log(`Reservations: ${reservationCount}`);
  console.log(`Document reviews: ${reviewCount}`);
  console.log('');
  console.log('🎯 Demo scenarios guaranteed by assertions:');
  console.log('- Mechanical Keyboard @ Beirut: OUT OF STOCK (available = 0)');
  console.log(
    '- Wireless Headphones @ Tripoli: RESTOCK + Saida TRANSFER donor',
  );
  console.log(
    '- Rain Jacket @ Tripoli: RESTOCK + Zahle dead-stock TRANSFER donor',
  );
  console.log(
    '- Coffee Maker @ Tripoli: RESTOCK + Saida dead-stock TRANSFER donor',
  );
  console.log(
    '- Resistance Band Set @ Saida: RESTOCK + Tripoli dead-stock TRANSFER donor',
  );
  console.log(
    '- USB-C Dock @ Saida: low now, pending incoming fully resolves it',
  );
  console.log('- Hooded Sweatshirt @ Beirut: RESTOCK / purchase required');
  console.log(
    '- Electric Kettle @ Tripoli: pending incoming exists but is still insufficient',
  );
  console.log(
    '- Wireless Mouse @ Beirut: positive consumption anomaly (10 -> 50)',
  );
  console.log(
    '- Notebook Set @ Tripoli: negative consumption anomaly (80 -> 20)',
  );
  console.log('- Yoga Mat @ Saida: zero-baseline anomaly (0 -> 20)');
  console.log(
    '- Ergonomic Office Chair @ Beirut: dead stock despite recent ADJUSTMENT',
  );
  console.log('- Standing Desk @ Tripoli: dead stock despite recent INCOMING');
  console.log(
    '- Laptop Pro 14: 4-supplier comparison, reservations, overdue supplier order',
  );
  console.log(
    '- all StockMovement types, Reservation statuses and Transaction statuses present',
  );
  console.log('');
  console.log(
    'ℹ️ Run `npm run seed` (not only seed:app) to also seed SQL-RAG QueryExamples and generate their embeddings.',
  );
  console.log(
    'ℹ️ No seeded Document Review rows — that feature is demoed only through a real S3 invoice upload.',
  );
}

main()
  .catch((error) => {
    console.error('❌ Final demo seed failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
