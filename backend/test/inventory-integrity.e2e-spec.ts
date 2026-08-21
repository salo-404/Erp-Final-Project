import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Inventory integrity (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminAuthHeader: string;
  let employeeAuthHeader: string;

  let beirutId: number;
  let mouseId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

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

    const adminLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'admin@minierp.com', password: 'Password123!' })
      .expect(200);
    adminAuthHeader = `Bearer ${adminLogin.body.access_token}`;

    const employeeLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'employee@minierp.com', password: 'Password123!' })
      .expect(200);
    employeeAuthHeader = `Bearer ${employeeLogin.body.access_token}`;

    const beirut = await prisma.warehouse.findFirstOrThrow({
      where: { name: 'Beirut Warehouse' },
    });

    const mouse = await prisma.product.findFirstOrThrow({
      where: { name: 'Wireless Mouse' },
    });

    beirutId = beirut.id;
    mouseId = mouse.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('adjusts inventory through an ADJUSTMENT movement', async () => {
    const before = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: mouseId,
          warehouseId: beirutId,
        },
      },
    });

    const response = await request(app.getHttpServer())
      .post('/stock-movements/adjust')
      .set('Authorization', adminAuthHeader)
      .send({
        productId: mouseId,
        warehouseId: beirutId,
        quantity: 7,
        reason: 'E2E physical stock correction',
      })
      .expect(201);

    expect(response.body.type).toBe('ADJUSTMENT');
    expect(response.body.quantity).toBe(7);

    const after = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: mouseId,
          warehouseId: beirutId,
        },
      },
    });

    expect(after.onHand).toBe(before.onHand + 7);

    const movement = await prisma.stockMovement.findUniqueOrThrow({
      where: {
        id: response.body.id,
      },
    });

    expect(movement.type).toBe('ADJUSTMENT');
    expect(movement.quantity).toBe(7);
    expect(movement.productId).toBe(mouseId);
    expect(movement.warehouseId).toBe(beirutId);
  });

  it('rejects inventory adjustment from an EMPLOYEE', async () => {
    await request(app.getHttpServer())
      .post('/stock-movements/adjust')
      .set('Authorization', employeeAuthHeader)
      .send({
        productId: mouseId,
        warehouseId: beirutId,
        quantity: 5,
        reason: 'Unauthorized adjustment test',
      })
      .expect(403);
  });

  it('rejects inventory adjustment with no JWT at all', async () => {
    await request(app.getHttpServer())
      .post('/stock-movements/adjust')
      .send({
        productId: mouseId,
        warehouseId: beirutId,
        quantity: 5,
        reason: 'Unauthenticated adjustment test',
      })
      .expect(401);
  });

  it('rejects a request that sends a requestedBy/role field in the body — the backend never reads it, it does not even parse as a valid body', async () => {
    // Sent by a real ADMIN (so the role guard itself isn't what blocks this)
    // to isolate the actual assertion: requestedBy is no longer part of the
    // DTO, so forbidNonWhitelisted rejects it outright as an unrecognized
    // property, before the request could ever use it as an identity.
    await request(app.getHttpServer())
      .post('/stock-movements/adjust')
      .set('Authorization', adminAuthHeader)
      .send({
        productId: mouseId,
        warehouseId: beirutId,
        quantity: 5,
        reason: 'Impersonation attempt',
        requestedBy: { id: 1, role: 'ADMIN' },
      })
      .expect(400);
  });

  it('EMPLOYEE cannot impersonate ADMIN via a fake requestedBy/role in the body — still 403, from the authenticated EMPLOYEE identity', async () => {
    await request(app.getHttpServer())
      .post('/stock-movements/adjust')
      .set('Authorization', employeeAuthHeader)
      .send({
        productId: mouseId,
        warehouseId: beirutId,
        quantity: 5,
        reason: 'Impersonation attempt',
        requestedBy: { id: 1, role: 'ADMIN' },
      })
      .expect(403);
  });

  it('reconciliation reports no mismatch when inventory matches the ledger', async () => {
    const response = await request(app.getHttpServer())
      .get('/stock-movements/reconcile')
      .set('Authorization', adminAuthHeader)
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toEqual([]);
  });

  it('reconciliation detects a deliberately corrupted inventory row', async () => {
    const inventory = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: mouseId,
          warehouseId: beirutId,
        },
      },
    });

    // Deliberately bypass the normal movement system ONLY for this test
    // so reconciliation has something incorrect to detect.
    await prisma.warehouseInventory.update({
      where: {
        id: inventory.id,
      },
      data: {
        onHand: inventory.onHand + 11,
      },
    });

    const response = await request(app.getHttpServer())
      .get('/stock-movements/reconcile')
      .set('Authorization', adminAuthHeader)
      .expect(200);

    const mismatch = response.body.find(
      (item: any) =>
        item.productId === mouseId && item.warehouseId === beirutId,
    );

    expect(mismatch).toBeDefined();
    expect(mismatch.difference).toBe(11);

    // Restore the row so later tests aren't polluted.
    await prisma.warehouseInventory.update({
      where: {
        id: inventory.id,
      },
      data: {
        onHand: inventory.onHand,
      },
    });
  });

  it('rejects completing an INCOMING transaction that would exceed warehouse capacity', async () => {
    const warehouse = await prisma.warehouse.create({
      data: {
        name: `Capacity Test Incoming ${Date.now()}`,
        maxCapacity: 10,
      },
    });

    await prisma.warehouseInventory.create({
      data: {
        warehouseId: warehouse.id,
        productId: mouseId,
        onHand: 8,
        reorderThreshold: 0,
      },
    });

    // Matching ledger entry so reconciliation remains consistent.
    await prisma.stockMovement.create({
      data: {
        productId: mouseId,
        warehouseId: warehouse.id,
        type: 'ADJUSTMENT',
        quantity: 8,
      },
    });

    const transaction = await prisma.inventoryTransaction.create({
      data: {
        type: 'INCOMING',
        status: 'PENDING',
        destinationWarehouseId: warehouse.id,
        items: {
          create: {
            productId: mouseId,
            quantity: 5,
          },
        },
      },
      include: { items: true },
    });

    await request(app.getHttpServer())
      .post(`/inventory-transactions/${transaction.id}/complete`)
      .set('Authorization', adminAuthHeader)
      .expect(409);

    const afterTransaction =
      await prisma.inventoryTransaction.findUniqueOrThrow({
        where: { id: transaction.id },
      });

    expect(afterTransaction.status).toBe('PENDING');

    const inventory = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: mouseId,
          warehouseId: warehouse.id,
        },
      },
    });

    expect(inventory.onHand).toBe(8);

    const movements = await prisma.stockMovement.findMany({
      where: { transactionId: transaction.id },
    });

    expect(movements).toHaveLength(0);
  });

  it('rejects completing a TRANSFER that would exceed destination warehouse capacity', async () => {
    const source = await prisma.warehouse.create({
      data: {
        name: `Capacity Test Source ${Date.now()}`,
      },
    });

    const destination = await prisma.warehouse.create({
      data: {
        name: `Capacity Test Destination ${Date.now()}`,
        maxCapacity: 10,
      },
    });

    await prisma.warehouseInventory.create({
      data: {
        warehouseId: source.id,
        productId: mouseId,
        onHand: 20,
        reorderThreshold: 0,
      },
    });

    // Matching source ledger entry.
    await prisma.stockMovement.create({
      data: {
        productId: mouseId,
        warehouseId: source.id,
        type: 'ADJUSTMENT',
        quantity: 20,
      },
    });

    await prisma.warehouseInventory.create({
      data: {
        warehouseId: destination.id,
        productId: mouseId,
        onHand: 8,
        reorderThreshold: 0,
      },
    });

    // Matching destination ledger entry.
    await prisma.stockMovement.create({
      data: {
        productId: mouseId,
        warehouseId: destination.id,
        type: 'ADJUSTMENT',
        quantity: 8,
      },
    });

    const transaction = await prisma.inventoryTransaction.create({
      data: {
        type: 'TRANSFER',
        status: 'PENDING',
        sourceWarehouseId: source.id,
        destinationWarehouseId: destination.id,
        items: {
          create: {
            productId: mouseId,
            quantity: 5,
          },
        },
      },
      include: { items: true },
    });

    await prisma.reservation.create({
      data: {
        transactionId: transaction.id,
        productId: mouseId,
        warehouseId: source.id,
        quantity: 5,
        status: 'ACTIVE',
      },
    });

    await request(app.getHttpServer())
      .post(`/inventory-transactions/${transaction.id}/complete`)
      .set('Authorization', adminAuthHeader)
      .expect(409);

    const afterTransaction =
      await prisma.inventoryTransaction.findUniqueOrThrow({
        where: { id: transaction.id },
      });

    expect(afterTransaction.status).toBe('PENDING');

    const sourceInventory = await prisma.warehouseInventory.findUniqueOrThrow({
      where: {
        productId_warehouseId: {
          productId: mouseId,
          warehouseId: source.id,
        },
      },
    });

    expect(sourceInventory.onHand).toBe(20);

    const destinationInventory =
      await prisma.warehouseInventory.findUniqueOrThrow({
        where: {
          productId_warehouseId: {
            productId: mouseId,
            warehouseId: destination.id,
          },
        },
      });

    expect(destinationInventory.onHand).toBe(8);

    const reservation = await prisma.reservation.findFirstOrThrow({
      where: { transactionId: transaction.id },
    });

    expect(reservation.status).toBe('ACTIVE');

    const movements = await prisma.stockMovement.findMany({
      where: { transactionId: transaction.id },
    });

    expect(movements).toHaveLength(0);
  });
});
