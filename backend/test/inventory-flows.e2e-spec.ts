import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { CognitoTokenVerifier } from '../src/auth/cognito-token-verifier.service';
import { cognitoAuthHeaderFor, mockCognitoVerifier } from './cognito-auth-test-helper';

describe('Inventory transaction flows (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authHeader: string;

  let beirutId: number;
  let tripoliId: number;

  let laptopId: number;
  let dockId: number;
  let keyboardId: number;

  let supplierId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CognitoTokenVerifier)
      .useValue(mockCognitoVerifier)
      .compile();

    app = moduleFixture.createNestApplication();

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    await app.init();

    prisma = app.get(PrismaService);

    authHeader = await cognitoAuthHeaderFor(prisma, 'employee@minierp.com');

    const beirut = await prisma.warehouse.findFirstOrThrow({
      where: { name: 'Beirut Warehouse' },
    });

    const tripoli = await prisma.warehouse.findFirstOrThrow({
      where: { name: 'Tripoli Warehouse' },
    });

    const laptop = await prisma.product.findFirstOrThrow({
      where: { name: 'Laptop Pro 14' },
    });

    const dock = await prisma.product.findFirstOrThrow({
      where: { name: 'USB-C Dock' },
    });

    const keyboard = await prisma.product.findFirstOrThrow({
      where: { name: 'Mechanical Keyboard' },
    });

    const supplier = await prisma.supplier.findFirstOrThrow({
      where: { name: 'TechSource Lebanon' },
    });

    beirutId = beirut.id;
    tripoliId = tripoli.id;

    laptopId = laptop.id;
    dockId = dock.id;
    keyboardId = keyboard.id;

    supplierId = supplier.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  // --------------------------------------------------
  // 1. INCOMING
  // --------------------------------------------------

  it('creates and completes an INCOMING transaction', async () => {
    const before = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: keyboardId,
          warehouseId: beirutId,
        },
      },
    });

    const createResponse = await request(app.getHttpServer())
      .post('/inventory-transactions/incoming')
      .set('Authorization', authHeader)
      .send({
        supplierId,
        destinationWarehouseId: beirutId,
        expectedDate: new Date(Date.now() + 86400000).toISOString(),
        items: [
          {
            productId: keyboardId,
            quantity: 5,
            price: 50,
          },
        ],
      })
      .expect(201);

    const transactionId = createResponse.body.id;

    expect(createResponse.body.status).toBe('PENDING');
    expect(createResponse.body.type).toBe('INCOMING');

    // Creating incoming stock should NOT change physical inventory yet.
    const afterCreate = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: keyboardId,
          warehouseId: beirutId,
        },
      },
    });

    expect(afterCreate.onHand).toBe(before.onHand);

    await request(app.getHttpServer())
      .post(`/inventory-transactions/${transactionId}/complete`)
      .set('Authorization', authHeader)
      .expect(201);

    const afterComplete = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: keyboardId,
          warehouseId: beirutId,
        },
      },
    });

    expect(afterComplete.onHand).toBe(before.onHand + 5);

    const movement = await prisma.stockMovement.findFirst({
      where: {
        transactionId,
        productId: keyboardId,
        warehouseId: beirutId,
        type: 'INCOMING',
      },
    });

    expect(movement).not.toBeNull();
    expect(movement?.quantity).toBe(5);

    const completedTransaction =
      await prisma.inventoryTransaction.findUniqueOrThrow({
        where: { id: transactionId },
      });

    expect(completedTransaction.status).toBe('COMPLETED');
  });

  // --------------------------------------------------
  // 2. OUTGOING
  // --------------------------------------------------

  it('creates an OUTGOING reservation and fulfills it on completion', async () => {
    const before = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: laptopId,
          warehouseId: beirutId,
        },
      },
    });

    const createResponse = await request(app.getHttpServer())
      .post('/inventory-transactions/outgoing')
      .set('Authorization', authHeader)
      .send({
        sourceWarehouseId: beirutId,
        partyName: 'E2E Test Customer',
        deliveryCountry: 'Lebanon',
        deliveryRegion: 'Beirut',
        deliveryAddress: 'Downtown',
        items: [
          {
            productId: laptopId,
            quantity: 3,
          },
        ],
      })
      .expect(201);

    const transactionId = createResponse.body.id;

    const reservation = await prisma.reservation.findFirstOrThrow({
      where: {
        transactionId,
        productId: laptopId,
      },
    });

    expect(reservation.status).toBe('ACTIVE');
    expect(reservation.quantity).toBe(3);
    expect(reservation.warehouseId).toBe(beirutId);

    // Reservation should NOT physically reduce onHand.
    const afterCreate = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: laptopId,
          warehouseId: beirutId,
        },
      },
    });

    expect(afterCreate.onHand).toBe(before.onHand);

    await request(app.getHttpServer())
      .post(`/inventory-transactions/${transactionId}/complete`)
      .set('Authorization', authHeader)
      .expect(201);

    const afterComplete = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: laptopId,
          warehouseId: beirutId,
        },
      },
    });

    expect(afterComplete.onHand).toBe(before.onHand - 3);

    const fulfilledReservation = await prisma.reservation.findUniqueOrThrow({
      where: {
        id: reservation.id,
      },
    });

    expect(fulfilledReservation.status).toBe('FULFILLED');

    const movement = await prisma.stockMovement.findFirst({
      where: {
        transactionId,
        productId: laptopId,
        warehouseId: beirutId,
        type: 'OUTGOING',
      },
    });

    expect(movement).not.toBeNull();
    expect(movement?.quantity).toBe(3);
  });

  // --------------------------------------------------
  // 3. TRANSFER
  // --------------------------------------------------

  it('transfers stock between warehouses correctly', async () => {
    const sourceBefore = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: dockId,
          warehouseId: beirutId,
        },
      },
    });

    const destinationBefore = await prisma.warehouseInventory.findUniqueOrThrow(
      {
        where: {
          productId_warehouseId: {
            productId: dockId,
            warehouseId: tripoliId,
          },
        },
      },
    );

    const createResponse = await request(app.getHttpServer())
      .post('/inventory-transactions/transfer')
      .set('Authorization', authHeader)
      .send({
        sourceWarehouseId: beirutId,
        destinationWarehouseId: tripoliId,
        items: [
          {
            productId: dockId,
            quantity: 4,
          },
        ],
      })
      .expect(201);

    const transactionId = createResponse.body.id;

    const reservation = await prisma.reservation.findFirstOrThrow({
      where: {
        transactionId,
        productId: dockId,
      },
    });

    expect(reservation.status).toBe('ACTIVE');
    expect(reservation.warehouseId).toBe(beirutId);

    await request(app.getHttpServer())
      .post(`/inventory-transactions/${transactionId}/complete`)
      .set('Authorization', authHeader)
      .expect(201);

    const sourceAfter = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: dockId,
          warehouseId: beirutId,
        },
      },
    });

    const destinationAfter = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: dockId,
          warehouseId: tripoliId,
        },
      },
    });

    expect(sourceAfter.onHand).toBe(sourceBefore.onHand - 4);
    expect(destinationAfter.onHand).toBe(destinationBefore.onHand + 4);

    const transferOut = await prisma.stockMovement.findFirst({
      where: {
        transactionId,
        warehouseId: beirutId,
        type: 'TRANSFER_OUT',
      },
    });

    const transferIn = await prisma.stockMovement.findFirst({
      where: {
        transactionId,
        warehouseId: tripoliId,
        type: 'TRANSFER_IN',
      },
    });

    expect(transferOut).not.toBeNull();
    expect(transferOut?.quantity).toBe(4);

    expect(transferIn).not.toBeNull();
    expect(transferIn?.quantity).toBe(4);
  });

  it.each(['outgoing', 'transfer'] as const)(
    'resynchronizes a two-product %s reservation swap without collisions',
    async (kind) => {
      const productIds = [laptopId, dockId];
      const quantities = [1, 2];
      const inventoryBefore = await prisma.warehouseInventory.findMany({
        where: { warehouseId: beirutId, productId: { in: productIds } },
      });
      const reservedBefore = await Promise.all(
        productIds.map((productId) =>
          prisma.reservation.aggregate({
            where: { warehouseId: beirutId, productId, status: 'ACTIVE' },
            _sum: { quantity: true },
          }),
        ),
      );

      const payload = {
        sourceWarehouseId: beirutId,
        ...(kind === 'transfer'
          ? { destinationWarehouseId: tripoliId }
          : {
              partyName: 'Reservation Swap E2E',
              deliveryCountry: 'Lebanon',
              deliveryRegion: 'Beirut',
              deliveryAddress: 'Downtown',
            }),
        items: productIds.map((productId, index) => ({
          productId,
          quantity: quantities[index],
        })),
      };
      const created = await request(app.getHttpServer())
        .post(`/inventory-transactions/${kind}`)
        .set('Authorization', authHeader)
        .send(payload)
        .expect(201);

      await request(app.getHttpServer())
        .patch(`/inventory-transactions/${created.body.id}`)
        .set('Authorization', authHeader)
        .send({
          items: [
            { itemId: created.body.items[0].id, productId: productIds[1] },
            { itemId: created.body.items[1].id, productId: productIds[0] },
          ],
        })
        .expect(200);

      const reservations = await prisma.reservation.findMany({
        where: { transactionId: created.body.id },
        orderBy: { id: 'asc' },
      });
      const active = reservations.filter((row) => row.status === 'ACTIVE');
      expect(active).toHaveLength(2);
      expect(reservations.filter((row) => row.status === 'CANCELLED')).toHaveLength(2);
      expect(
        active
          .map((row) => [row.productId, row.quantity, row.warehouseId])
          .sort((a, b) => a[0] - b[0]),
      ).toEqual([
        [productIds[0], quantities[1], beirutId],
        [productIds[1], quantities[0], beirutId],
      ]);

      const inventoryAfter = await prisma.warehouseInventory.findMany({
        where: { warehouseId: beirutId, productId: { in: productIds } },
      });
      expect(
        inventoryAfter.map((row) => [row.productId, row.onHand]).sort(),
      ).toEqual(inventoryBefore.map((row) => [row.productId, row.onHand]).sort());
      const reservedAfter = await Promise.all(
        productIds.map((productId) =>
          prisma.reservation.aggregate({
            where: { warehouseId: beirutId, productId, status: 'ACTIVE' },
            _sum: { quantity: true },
          }),
        ),
      );
      expect(reservedAfter[0]._sum.quantity).toBe(
        (reservedBefore[0]._sum.quantity ?? 0) + quantities[1],
      );
      expect(reservedAfter[1]._sum.quantity).toBe(
        (reservedBefore[1]._sum.quantity ?? 0) + quantities[0],
      );

      await request(app.getHttpServer())
        .post(`/inventory-transactions/${created.body.id}/cancel`)
        .set('Authorization', authHeader)
        .expect(201);
    },
  );

  // --------------------------------------------------
  // 4. CANCEL
  // --------------------------------------------------

  it('releases reservation when an OUTGOING transaction is cancelled', async () => {
    const before = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: laptopId,
          warehouseId: beirutId,
        },
      },
    });

    const createResponse = await request(app.getHttpServer())
      .post('/inventory-transactions/outgoing')
      .set('Authorization', authHeader)
      .send({
        sourceWarehouseId: beirutId,
        partyName: 'Cancelled E2E Customer',
        items: [
          {
            productId: laptopId,
            quantity: 2,
          },
        ],
      })
      .expect(201);

    const transactionId = createResponse.body.id;

    const reservation = await prisma.reservation.findFirstOrThrow({
      where: {
        transactionId,
        productId: laptopId,
      },
    });

    expect(reservation.status).toBe('ACTIVE');

    await request(app.getHttpServer())
      .post(`/inventory-transactions/${transactionId}/cancel`)
      .set('Authorization', authHeader)
      .expect(201);

    const cancelledReservation = await prisma.reservation.findUniqueOrThrow({
      where: { id: reservation.id },
    });

    expect(cancelledReservation.status).toBe('CANCELLED');

    const cancelledTransaction =
      await prisma.inventoryTransaction.findUniqueOrThrow({
        where: { id: transactionId },
      });

    expect(cancelledTransaction.status).toBe('CANCELLED');

    // Cancellation should not physically alter stock.
    const after = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: laptopId,
          warehouseId: beirutId,
        },
      },
    });

    expect(after.onHand).toBe(before.onHand);

    const movements = await prisma.stockMovement.count({
      where: {
        transactionId,
      },
    });

    expect(movements).toBe(0);
  });
});
