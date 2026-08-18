import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Analytics (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let laptopId: number;
  let beirutWarehouseId: number;

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

    const laptop = await prisma.product.findFirstOrThrow({
      where: {
        name: 'Laptop Pro 14',
      },
    });

    const beirutWarehouse = await prisma.warehouse.findFirstOrThrow({
      where: {
        name: 'Beirut Warehouse',
      },
    });

    laptopId = laptop.id;
    beirutWarehouseId = beirutWarehouse.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('returns top-selling products', async () => {
    const response = await request(app.getHttpServer())
      .get('/analytics/top-selling-products')
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    for (const item of response.body) {
      expect(item.productId).toBeDefined();
      expect(item.name).toBeDefined();
      expect(item.totalQuantitySold).toBeGreaterThanOrEqual(0);
      expect(item.totalRevenue).toBeGreaterThanOrEqual(0);
    }

    for (let i = 1; i < response.body.length; i++) {
      expect(response.body[i - 1].totalQuantitySold).toBeGreaterThanOrEqual(
        response.body[i].totalQuantitySold,
      );
    }
  });

  it('returns lowest-selling products including zero-sale products', async () => {
    const response = await request(app.getHttpServer())
      .get('/analytics/lowest-selling-products')
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    for (const item of response.body) {
      expect(item.productId).toBeDefined();
      expect(item.totalQuantitySold).toBeGreaterThanOrEqual(0);
    }

    for (let i = 1; i < response.body.length; i++) {
      expect(response.body[i - 1].totalQuantitySold).toBeLessThanOrEqual(
        response.body[i].totalQuantitySold,
      );
    }
  });

  it('returns fast-moving products', async () => {
    const response = await request(app.getHttpServer())
      .get('/analytics/fast-moving-products')
      .query({
        days: 30,
      })
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);

    for (const item of response.body) {
      expect(item.productId).toBeDefined();
      expect(item.name).toBeDefined();
      expect(item.quantityMoved).toBeGreaterThanOrEqual(0);
    }

    for (let i = 1; i < response.body.length; i++) {
      expect(response.body[i - 1].quantityMoved).toBeGreaterThanOrEqual(
        response.body[i].quantityMoved,
      );
    }
  });

  it('returns slow-moving products', async () => {
    const response = await request(app.getHttpServer())
      .get('/analytics/slow-moving-products')
      .query({
        days: 30,
      })
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    for (let i = 1; i < response.body.length; i++) {
      expect(response.body[i - 1].quantityMoved).toBeLessThanOrEqual(
        response.body[i].quantityMoved,
      );
    }
  });

  it('returns sales trends', async () => {
    const response = await request(app.getHttpServer())
      .get('/analytics/sales-trends')
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);

    for (const item of response.body) {
      expect(item.date).toBeDefined();
      expect(item.quantitySold).toBeGreaterThanOrEqual(0);
      expect(item.revenue).toBeGreaterThanOrEqual(0);
      expect(item.transactionCount).toBeGreaterThan(0);
    }
  });

  it('returns purchase trends', async () => {
    const response = await request(app.getHttpServer())
      .get('/analytics/purchase-trends')
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);

    for (const item of response.body) {
      expect(item.date).toBeDefined();
    }
  });

  it('returns stock history for a product', async () => {
    const response = await request(app.getHttpServer())
      .get(`/analytics/stock-history/${laptopId}`)
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    for (const item of response.body) {
      expect(item.productId).toBe(laptopId);
    }
  });

  it('returns warehouse demand', async () => {
    const response = await request(app.getHttpServer())
      .get('/analytics/warehouse-demand')
      .query({
        warehouseId: beirutWarehouseId,
      })
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
  });

  it('returns demand for one product', async () => {
    const response = await request(app.getHttpServer())
      .get(`/analytics/product-demand/${laptopId}`)
      .expect(200);

    expect(response.body).toBeDefined();
  });

  it('returns supplier comparison analytics', async () => {
    const response = await request(app.getHttpServer())
      .get('/analytics/supplier-comparison')
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    for (const item of response.body) {
      expect(item.supplierId).toBeDefined();
      expect(item.supplierName).toBeDefined();

      expect(item.completedTransactions).toBeGreaterThanOrEqual(0);
      expect(item.cancelledTransactions).toBeGreaterThanOrEqual(0);
      expect(item.onTimeTransactions).toBeGreaterThanOrEqual(0);
      expect(item.lateTransactions).toBeGreaterThanOrEqual(0);
      expect(item.totalPurchasedQuantity).toBeGreaterThanOrEqual(0);
      expect(item.totalPurchaseCost).toBeGreaterThanOrEqual(0);
      expect(item.averageUnitCost).toBeGreaterThanOrEqual(0);
    }
  });
});
