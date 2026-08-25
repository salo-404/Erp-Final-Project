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

  const techSource = await prisma.supplier.create({
    data: {
      name: 'TechSource Lebanon',
      email: 'sales@techsource.com',
      // Placeholder only — no real lead-time data source yet.
      leadTimeDays: 5,
    },
  });

  const cedarElectronics = await prisma.supplier.create({
    data: {
      name: 'Cedar Electronics',
      email: 'orders@cedarelectronics.com',
      // Placeholder only — no real lead-time data source yet.
      leadTimeDays: 3,
    },
  });

  const levantTrading = await prisma.supplier.create({
    data: {
      name: 'Levant Trading',
      email: 'contact@levanttrading.com',
      // Placeholder only — no real lead-time data source yet.
      leadTimeDays: 8,
    },
  });

  const oldSupplier = await prisma.supplier.create({
    data: {
      name: 'Old Supplier',
      email: 'old@supplier.com',
      isActive: false,
      // Placeholder only — no real lead-time data source yet.
      leadTimeDays: 10,
    },
  });

  // ---------------------------------------------------
  // 4. PRODUCTS
  // ---------------------------------------------------

  const laptop = await prisma.product.create({
    data: {
      name: 'Laptop Pro 14',
      category: 'Computers',
      description: '14-inch business laptop',
    },
  });

  const mouse = await prisma.product.create({
    data: {
      name: 'Wireless Mouse',
      category: 'Accessories',
    },
  });

  const keyboard = await prisma.product.create({
    data: {
      name: 'Mechanical Keyboard',
      category: 'Accessories',
    },
  });

  const monitor = await prisma.product.create({
    data: {
      name: '27-inch Monitor',
      category: 'Displays',
    },
  });

  const dock = await prisma.product.create({
    data: {
      name: 'USB-C Dock',
      category: 'Accessories',
    },
  });

  const headset = await prisma.product.create({
    data: {
      name: 'Office Headset',
      category: 'Audio',
    },
  });

  const webcam = await prisma.product.create({
    data: {
      name: 'HD Webcam',
      category: 'Cameras',
    },
  });

  const chair = await prisma.product.create({
    data: {
      name: 'Office Chair',
      category: 'Furniture',
    },
  });

  const inactiveProduct = await prisma.product.create({
    data: {
      name: 'Discontinued Tablet',
      category: 'Computers',
      isActive: false,
    },
  });

  // ---------------------------------------------------
  // 5. WAREHOUSES
  // ---------------------------------------------------

  const beirut = await prisma.warehouse.create({
    data: {
      name: 'Beirut Warehouse',
      location: 'Beirut, Lebanon',
      maxCapacity: 1000,
    },
  });

  const tripoli = await prisma.warehouse.create({
    data: {
      name: 'Tripoli Warehouse',
      location: 'Tripoli, Lebanon',
      maxCapacity: 700,
    },
  });

  const saida = await prisma.warehouse.create({
    data: {
      name: 'Saida Warehouse',
      location: 'Saida, Lebanon',
      maxCapacity: 600,
    },
  });

  const inactiveWarehouse = await prisma.warehouse.create({
    data: {
      name: 'Old Warehouse',
      location: 'Jounieh, Lebanon',
      isActive: false,
      maxCapacity: 300,
    },
  });

  // ---------------------------------------------------
  // HELPER: COMPLETED INCOMING
  // ---------------------------------------------------

  async function completedIncoming(params: {
    supplierId: number;
    warehouseId: number;
    productId: number;
    quantity: number;
    price: number;
    daysAgoValue: number;
  }) {
    const date = daysAgo(params.daysAgoValue);

    const transaction = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.INCOMING,
        status: InventoryTransactionStatus.COMPLETED,
        supplierId: params.supplierId,
        destinationWarehouseId: params.warehouseId,
        expectedDate: date,
        actualDate: date,
        createdAt: date,
        items: {
          create: {
            productId: params.productId,
            quantity: params.quantity,
            price: params.price,
          },
        },
      },
    });

    await prisma.stockMovement.create({
      data: {
        transactionId: transaction.id,
        productId: params.productId,
        warehouseId: params.warehouseId,
        type: StockMovementType.INCOMING,
        quantity: params.quantity,
        createdAt: date,
      },
    });

    return transaction;
  }

  // ---------------------------------------------------
  // HELPER: COMPLETED OUTGOING
  // ---------------------------------------------------

  async function completedOutgoing(params: {
    warehouseId: number;
    productId: number;
    quantity: number;
    price?: number;
    daysAgoValue: number;
    customer: string;
  }) {
    const date = daysAgo(params.daysAgoValue);

    const transaction = await prisma.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.OUTGOING,
        status: InventoryTransactionStatus.COMPLETED,
        sourceWarehouseId: params.warehouseId,
        partyName: params.customer,
        expectedDate: date,
        actualDate: date,
        createdAt: date,
        items: {
          create: {
            productId: params.productId,
            quantity: params.quantity,
            price: params.price,
          },
        },
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

  // ---------------------------------------------------
  // 6. INITIAL STOCK
  // ---------------------------------------------------

  await completedIncoming({
    supplierId: techSource.id,
    warehouseId: beirut.id,
    productId: laptop.id,
    quantity: 100,
    price: 850,
    daysAgoValue: 90,
  });

  await completedIncoming({
    supplierId: cedarElectronics.id,
    warehouseId: beirut.id,
    productId: mouse.id,
    quantity: 200,
    price: 18,
    daysAgoValue: 90,
  });

  await completedIncoming({
    supplierId: techSource.id,
    warehouseId: beirut.id,
    productId: keyboard.id,
    quantity: 120,
    price: 55,
    daysAgoValue: 90,
  });

  await completedIncoming({
    supplierId: levantTrading.id,
    warehouseId: beirut.id,
    productId: monitor.id,
    quantity: 75,
    price: 210,
    daysAgoValue: 90,
  });

  await completedIncoming({
    supplierId: techSource.id,
    warehouseId: beirut.id,
    productId: dock.id,
    quantity: 80,
    price: 70,
    daysAgoValue: 90,
  });

  await completedIncoming({
    supplierId: cedarElectronics.id,
    warehouseId: beirut.id,
    productId: headset.id,
    quantity: 90,
    price: 42,
    daysAgoValue: 90,
  });

  await completedIncoming({
    supplierId: cedarElectronics.id,
    warehouseId: beirut.id,
    productId: webcam.id,
    quantity: 60,
    price: 35,
    daysAgoValue: 90,
  });

  // Chair intentionally gets old stock but no sales afterwards.
  // Useful for dead-stock testing.
  await completedIncoming({
    supplierId: levantTrading.id,
    warehouseId: beirut.id,
    productId: chair.id,
    quantity: 35,
    price: 95,
    daysAgoValue: 120,
  });

  // Tripoli inventory
  await completedIncoming({
    supplierId: techSource.id,
    warehouseId: tripoli.id,
    productId: laptop.id,
    quantity: 60,
    price: 870,
    daysAgoValue: 80,
  });

  await completedIncoming({
    supplierId: cedarElectronics.id,
    warehouseId: tripoli.id,
    productId: mouse.id,
    quantity: 100,
    price: 19,
    daysAgoValue: 80,
  });

  await completedIncoming({
    supplierId: levantTrading.id,
    warehouseId: tripoli.id,
    productId: monitor.id,
    quantity: 40,
    price: 215,
    daysAgoValue: 80,
  });

  // Saida inventory
  await completedIncoming({
    supplierId: techSource.id,
    warehouseId: saida.id,
    productId: laptop.id,
    quantity: 40,
    price: 860,
    daysAgoValue: 70,
  });

  await completedIncoming({
    supplierId: cedarElectronics.id,
    warehouseId: saida.id,
    productId: mouse.id,
    quantity: 80,
    price: 17,
    daysAgoValue: 70,
  });

  await completedIncoming({
    supplierId: levantTrading.id,
    warehouseId: saida.id,
    productId: monitor.id,
    quantity: 30,
    price: 205,
    daysAgoValue: 70,
  });

  // ---------------------------------------------------
  // 7. HISTORICAL OUTGOING SALES
  // ---------------------------------------------------

  // Laptop demand over several weeks
  await completedOutgoing({
    warehouseId: beirut.id,
    productId: laptop.id,
    quantity: 8,
    daysAgoValue: 45,
    customer: 'ABC Corporation',
  });

  await completedOutgoing({
    warehouseId: beirut.id,
    productId: laptop.id,
    quantity: 10,
    daysAgoValue: 30,
    customer: 'Cedars Consulting',
  });

  await completedOutgoing({
    warehouseId: beirut.id,
    productId: laptop.id,
    quantity: 12,
    daysAgoValue: 15,
    customer: 'BlueTech SARL',
  });

  await completedOutgoing({
    warehouseId: beirut.id,
    productId: laptop.id,
    quantity: 15,
    daysAgoValue: 4,
    customer: 'Future Systems',
  });

  // Mouse normal demand
  await completedOutgoing({
    warehouseId: beirut.id,
    productId: mouse.id,
    quantity: 12,
    daysAgoValue: 40,
    customer: 'ABC Corporation',
  });

  await completedOutgoing({
    warehouseId: beirut.id,
    productId: mouse.id,
    quantity: 14,
    daysAgoValue: 25,
    customer: 'BlueTech SARL',
  });

  await completedOutgoing({
    warehouseId: beirut.id,
    productId: mouse.id,
    quantity: 10,
    daysAgoValue: 12,
    customer: 'Cedars Consulting',
  });

  // Big recent spike — useful for anomaly testing.
  await completedOutgoing({
    warehouseId: beirut.id,
    productId: mouse.id,
    quantity: 65,
    daysAgoValue: 2,
    customer: 'Mega Office SARL',
  });

  // Monitor sales
  await completedOutgoing({
    warehouseId: tripoli.id,
    productId: monitor.id,
    quantity: 10,
    daysAgoValue: 25,
    customer: 'North Lebanon Group',
  });

  await completedOutgoing({
    warehouseId: tripoli.id,
    productId: monitor.id,
    quantity: 15,
    daysAgoValue: 5,
    customer: 'Tripoli Systems',
  });

  // ---------------------------------------------------
  // 8. COMPLETED TRANSFER
  // ---------------------------------------------------

  const transferDate = daysAgo(8);

  const completedTransfer = await prisma.inventoryTransaction.create({
    data: {
      type: InventoryTransactionType.TRANSFER,
      status: InventoryTransactionStatus.COMPLETED,
      sourceWarehouseId: beirut.id,
      destinationWarehouseId: saida.id,
      expectedDate: transferDate,
      actualDate: transferDate,
      createdAt: transferDate,
      items: {
        create: {
          productId: dock.id,
          quantity: 20,
        },
      },
    },
  });

  await prisma.reservation.create({
    data: {
      transactionId: completedTransfer.id,
      productId: dock.id,
      warehouseId: beirut.id,
      quantity: 20,
      status: ReservationStatus.FULFILLED,
      createdAt: transferDate,
    },
  });

  await prisma.stockMovement.createMany({
    data: [
      {
        transactionId: completedTransfer.id,
        productId: dock.id,
        warehouseId: beirut.id,
        type: StockMovementType.TRANSFER_OUT,
        quantity: 20,
        createdAt: transferDate,
      },
      {
        transactionId: completedTransfer.id,
        productId: dock.id,
        warehouseId: saida.id,
        type: StockMovementType.TRANSFER_IN,
        quantity: 20,
        createdAt: transferDate,
      },
    ],
  });

  // ---------------------------------------------------
  // 9. ACTIVE OUTGOING RESERVATION
  // ---------------------------------------------------

  const pendingOutgoing = await prisma.inventoryTransaction.create({
    data: {
      type: InventoryTransactionType.OUTGOING,
      status: InventoryTransactionStatus.PENDING,
      sourceWarehouseId: beirut.id,
      partyName: 'Pending Customer',
      deliveryCountry: 'Lebanon',
      deliveryRegion: 'Mount Lebanon',
      deliveryAddress: 'Dbayeh',
      expectedDate: daysFromNow(3),
      items: {
        create: {
          productId: laptop.id,
          quantity: 10,
        },
      },
    },
  });

  await prisma.reservation.create({
    data: {
      transactionId: pendingOutgoing.id,
      productId: laptop.id,
      warehouseId: beirut.id,
      quantity: 10,
      status: ReservationStatus.ACTIVE,
    },
  });

  // ---------------------------------------------------
  // 10. PENDING INCOMING
  // ---------------------------------------------------

  await prisma.inventoryTransaction.create({
    data: {
      type: InventoryTransactionType.INCOMING,
      status: InventoryTransactionStatus.PENDING,
      supplierId: techSource.id,
      destinationWarehouseId: beirut.id,
      expectedDate: daysFromNow(5),
      items: {
        create: {
          productId: laptop.id,
          quantity: 30,
          price: 825,
        },
      },
    },
  });

  // ---------------------------------------------------
  // 11. OVERDUE INCOMING
  // ---------------------------------------------------

  await prisma.inventoryTransaction.create({
    data: {
      type: InventoryTransactionType.INCOMING,
      status: InventoryTransactionStatus.PENDING,
      supplierId: cedarElectronics.id,
      destinationWarehouseId: tripoli.id,
      expectedDate: daysAgo(4),
      items: {
        create: {
          productId: monitor.id,
          quantity: 25,
          price: 200,
        },
      },
    },
  });

  // ---------------------------------------------------
  // 11b. MORE OVERDUE + UPCOMING DELIVERIES FOR THE CALENDAR
  // ---------------------------------------------------
  // A wider spread of PENDING transactions (both overdue and upcoming, both
  // customer OUTGOING orders and supplier INCOMING deliveries) so the
  // Calendar page - which reads GET /inventory-transactions/overdue and
  // /upcoming-deliveries directly, no separate calendar data of its own -
  // has more than a single example of each to show.

  const overdueOutgoingBeirut = await prisma.inventoryTransaction.create({
    data: {
      type: InventoryTransactionType.OUTGOING,
      status: InventoryTransactionStatus.PENDING,
      sourceWarehouseId: beirut.id,
      partyName: 'Beirut Retail Co',
      deliveryCountry: 'Lebanon',
      deliveryRegion: 'Beirut',
      deliveryAddress: 'Hamra',
      expectedDate: daysAgo(2),
      items: {
        create: {
          productId: keyboard.id,
          quantity: 12,
        },
      },
    },
  });

  await prisma.reservation.create({
    data: {
      transactionId: overdueOutgoingBeirut.id,
      productId: keyboard.id,
      warehouseId: beirut.id,
      quantity: 12,
      status: ReservationStatus.ACTIVE,
    },
  });

  const overdueOutgoingSaida = await prisma.inventoryTransaction.create({
    data: {
      type: InventoryTransactionType.OUTGOING,
      status: InventoryTransactionStatus.PENDING,
      sourceWarehouseId: saida.id,
      partyName: 'Saida Wholesale Traders',
      deliveryCountry: 'Lebanon',
      deliveryRegion: 'South Lebanon',
      deliveryAddress: 'Saida Old Souk',
      expectedDate: daysAgo(6),
      items: {
        create: {
          productId: headset.id,
          quantity: 8,
        },
      },
    },
  });

  await prisma.reservation.create({
    data: {
      transactionId: overdueOutgoingSaida.id,
      productId: headset.id,
      warehouseId: saida.id,
      quantity: 8,
      status: ReservationStatus.ACTIVE,
    },
  });

  await prisma.inventoryTransaction.create({
    data: {
      type: InventoryTransactionType.INCOMING,
      status: InventoryTransactionStatus.PENDING,
      supplierId: levantTrading.id,
      destinationWarehouseId: tripoli.id,
      expectedDate: daysAgo(1),
      items: {
        create: {
          productId: webcam.id,
          quantity: 18,
          price: 55,
        },
      },
    },
  });

  const upcomingOutgoingTripoli = await prisma.inventoryTransaction.create({
    data: {
      type: InventoryTransactionType.OUTGOING,
      status: InventoryTransactionStatus.PENDING,
      sourceWarehouseId: tripoli.id,
      partyName: 'North Region Distributors',
      deliveryCountry: 'Lebanon',
      deliveryRegion: 'North Lebanon',
      deliveryAddress: 'Tripoli Port Road',
      expectedDate: daysFromNow(2),
      items: {
        create: {
          productId: dock.id,
          quantity: 6,
        },
      },
    },
  });

  await prisma.reservation.create({
    data: {
      transactionId: upcomingOutgoingTripoli.id,
      productId: dock.id,
      warehouseId: tripoli.id,
      quantity: 6,
      status: ReservationStatus.ACTIVE,
    },
  });

  await prisma.inventoryTransaction.create({
    data: {
      type: InventoryTransactionType.INCOMING,
      status: InventoryTransactionStatus.PENDING,
      supplierId: cedarElectronics.id,
      destinationWarehouseId: beirut.id,
      expectedDate: daysFromNow(10),
      items: {
        create: {
          productId: mouse.id,
          quantity: 40,
          price: 12,
        },
      },
    },
  });

  // ---------------------------------------------------
  // 12. CANCELLED OUTGOING + CANCELLED RESERVATION
  // ---------------------------------------------------

  const cancelledTransaction = await prisma.inventoryTransaction.create({
    data: {
      type: InventoryTransactionType.OUTGOING,
      status: InventoryTransactionStatus.CANCELLED,
      sourceWarehouseId: saida.id,
      partyName: 'Cancelled Customer',
      expectedDate: daysAgo(3),
      items: {
        create: {
          productId: mouse.id,
          quantity: 5,
        },
      },
    },
  });

  await prisma.reservation.create({
    data: {
      transactionId: cancelledTransaction.id,
      productId: mouse.id,
      warehouseId: saida.id,
      quantity: 5,
      status: ReservationStatus.CANCELLED,
    },
  });

  // ---------------------------------------------------
  // 13. MULTIPLE SUPPLIER HISTORY FOR RANKING
  // ---------------------------------------------------

  await completedIncoming({
    supplierId: techSource.id,
    warehouseId: beirut.id,
    productId: laptop.id,
    quantity: 20,
    price: 810,
    daysAgoValue: 20,
  });

  await completedIncoming({
    supplierId: cedarElectronics.id,
    warehouseId: beirut.id,
    productId: laptop.id,
    quantity: 15,
    price: 835,
    daysAgoValue: 35,
  });

  await completedIncoming({
    supplierId: levantTrading.id,
    warehouseId: beirut.id,
    productId: laptop.id,
    quantity: 15,
    price: 875,
    daysAgoValue: 50,
  });

  // ---------------------------------------------------
  // 14. PENDING DOCUMENT REVIEW
  // ---------------------------------------------------

  await prisma.pendingDocumentReview.create({
    data: {
      documentUrl:
        'https://example-bucket.s3.amazonaws.com/documents/sample-invoice.pdf',
      transactionType: InventoryTransactionType.INCOMING,
      extractedSupplierName: 'TechSource Lebanon',
      extractedDate: new Date(),
      extractedWarehouseName: 'Beirut Warehouse',
      extractedItems: [
        {
          product: 'Laptop Pro 14',
          quantity: 5,
          price: 820,
        },
        {
          product: 'Wireless Mouse',
          quantity: 10,
          price: 17,
        },
      ],
      status: DocumentReviewStatus.PENDING_REVIEW,
    },
  });

  // Approved historical review
  await prisma.pendingDocumentReview.create({
    data: {
      documentUrl:
        'https://example-bucket.s3.amazonaws.com/documents/approved-invoice.pdf',
      transactionType: InventoryTransactionType.OUTGOING,
      extractedPartyName: 'Example Customer',
      extractedDate: daysAgo(10),
      extractedWarehouseName: 'Beirut Warehouse',
      extractedItems: [
        {
          product: 'Wireless Mouse',
          quantity: 3,
          price: 25,
        },
      ],
      status: DocumentReviewStatus.APPROVED,
      reviewedById: admin.id,
      reviewedAt: daysAgo(9),
    },
  });

  // ---------------------------------------------------
  // 15. BUILD WAREHOUSE INVENTORY FROM LEDGER
  // ---------------------------------------------------

  const activeWarehouses = [beirut, tripoli, saida];

  const products = [
    laptop,
    mouse,
    keyboard,
    monitor,
    dock,
    headset,
    webcam,
    chair,
  ];

  const thresholds: Record<string, number> = {
    [laptop.id]: 25,
    [mouse.id]: 40,
    [keyboard.id]: 20,
    [monitor.id]: 15,
    [dock.id]: 20,
    [headset.id]: 15,
    [webcam.id]: 10,
    [chair.id]: 10,
  };

  for (const warehouse of activeWarehouses) {
    for (const product of products) {
      const movements = await prisma.stockMovement.findMany({
        where: {
          warehouseId: warehouse.id,
          productId: product.id,
        },
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
  console.log('- normal inventory');
  console.log('- historical incoming/outgoing');
  console.log('- active reservation');
  console.log('- completed transfer');
  console.log('- cancelled transaction');
  console.log('- pending incoming');
  console.log('- overdue incoming');
  console.log('- dead-stock candidate');
  console.log('- consumption spike');
  console.log('- supplier price history');
  console.log('- pending document review');
  console.log('- inactive supplier/product/warehouse');
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
