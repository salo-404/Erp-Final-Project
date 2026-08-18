import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Inventory integrity (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let adminId: number;
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

    const admin = await prisma.user.findFirstOrThrow({
      where: { email: 'admin@minierp.com' },
    });

    const beirut = await prisma.warehouse.findFirstOrThrow({
      where: { name: 'Beirut Warehouse' },
    });

    const mouse = await prisma.product.findFirstOrThrow({
      where: { name: 'Wireless Mouse' },
    });

    adminId = admin.id;
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
      .send({
        productId: mouseId,
        warehouseId: beirutId,
        quantity: 7,
        reason: 'E2E physical stock correction',
        requestedBy: {
          id: adminId,
          role: 'ADMIN',
        },
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
    const employee = await prisma.user.findFirstOrThrow({
      where: { email: 'employee@minierp.com' },
    });

    await request(app.getHttpServer())
      .post('/stock-movements/adjust')
      .send({
        productId: mouseId,
        warehouseId: beirutId,
        quantity: 5,
        reason: 'Unauthorized adjustment test',
        requestedBy: {
          id: employee.id,
          role: 'EMPLOYEE',
        },
      })
      .expect(403);
  });

  it('reconciliation reports no mismatch when inventory matches the ledger', async () => {
    const response = await request(app.getHttpServer())
      .get('/stock-movements/reconcile')
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
});
