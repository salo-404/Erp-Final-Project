import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';

import { StockInsightsModule } from '../src/stock-insights/stock-insights.module';

describe('Stock Insights + Control Tower (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [StockInsightsModule],
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
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('returns dead-stock results', async () => {
    const response = await request(app.getHttpServer())
      .get('/stock-insights/dead-stock')
      .query({
        inactivityDays: 60,
      })
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);

    for (const item of response.body) {
      expect(item.productId).toBeDefined();
      expect(item.warehouseId).toBeDefined();
      expect(item.onHand).toBeGreaterThan(0);

      expect(
        item.lastMovementAt === null || typeof item.lastMovementAt === 'string',
      ).toBe(true);
    }
  });

  it('returns consumption anomalies', async () => {
    const response = await request(app.getHttpServer())
      .get('/stock-insights/consumption-anomalies')
      .query({
        windowDays: 7,
        thresholdPercent: 50,
        minimumQuantityChange: 1,
      })
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);

    for (const item of response.body) {
      expect(item.productId).toBeDefined();
      expect(item.recentQuantity).toBeGreaterThanOrEqual(0);
      expect(item.baselineQuantity).toBeGreaterThanOrEqual(0);

      expect(['INCREASE', 'DECREASE']).toContain(item.direction);

      if (item.percentChange !== null) {
        expect(typeof item.percentChange).toBe('number');
      }
    }
  });

  it('returns stockout-risk calculations', async () => {
    const response = await request(app.getHttpServer())
      .get('/stock-insights/stockout-risk')
      .query({
        consumptionWindowDays: 30,
      })
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    for (const item of response.body) {
      expect(item.productId).toBeDefined();
      expect(item.warehouseId).toBeDefined();

      expect(item.available).toBe(item.onHand - item.activeReserved);

      expect(item.projectedAvailable).toBe(
        item.available + item.pendingIncomingQuantity,
      );

      expect(['OUT_OF_STOCK', 'AT_RISK', 'OK']).toContain(item.riskLevel);

      expect(['OUT_OF_STOCK', 'AT_RISK', 'OK']).toContain(
        item.projectedRiskLevel,
      );

      expect(item.avgDailyConsumption).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns restock recommendations', async () => {
    const response = await request(app.getHttpServer())
      .get('/stock-insights/restock-recommendations')
      .query({
        consumptionWindowDays: 30,
      })
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);

    for (const item of response.body) {
      expect(item.productId).toBeDefined();
      expect(item.warehouseId).toBeDefined();

      expect(item.recommendedQuantity).toBeGreaterThan(0);

      expect(['transfer_available', 'purchase_required']).toContain(
        item.reason,
      );

      expect(typeof item.explanation).toBe('string');
      expect(item.explanation.length).toBeGreaterThan(0);

      // A recommendation should only exist if projected stock
      // is still not OK after pending incoming is considered.
      expect(item.projectedRiskLevel).not.toBe('OK');
    }
  });

  it('returns transfer recommendations with valid warehouse movement', async () => {
    const response = await request(app.getHttpServer())
      .get('/stock-insights/transfer-recommendations')
      .query({
        consumptionWindowDays: 30,
      })
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);

    for (const item of response.body) {
      expect(item.productId).toBeDefined();

      expect(item.fromWarehouseId).toBeDefined();
      expect(item.toWarehouseId).toBeDefined();

      expect(item.fromWarehouseId).not.toBe(item.toWarehouseId);

      expect(item.transferQuantity).toBeGreaterThan(0);

      expect(item.fromWarehouseAvailableAfterTransfer).toBeGreaterThanOrEqual(
        0,
      );

      expect(
        item.toWarehouseProjectedAvailableAfterTransfer,
      ).toBeGreaterThanOrEqual(0);

      expect(['OUT_OF_STOCK', 'AT_RISK', 'OK']).toContain(
        item.destinationRiskLevel,
      );
    }
  });

  it('returns structured Control Tower alerts', async () => {
    const response = await request(app.getHttpServer())
      .get('/control-tower/alerts')
      .query({
        deadStockInactivityDays: 60,
        consumptionWindowDays: 30,
        consumptionThresholdPercent: 50,
      })
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    const allowedCategories = [
      'DEAD_STOCK',
      'CONSUMPTION_ANOMALY',
      'STOCKOUT_RISK',
      'OVERDUE_TRANSACTION',
      'PENDING_DOCUMENT_REVIEW',
      'RESTOCK_RECOMMENDATION',
      'TRANSFER_RECOMMENDATION',
    ];

    const allowedSeverities = ['CRITICAL', 'WARNING', 'INFO'];

    for (const alert of response.body) {
      expect(allowedCategories).toContain(alert.category);
      expect(allowedSeverities).toContain(alert.severity);

      expect(typeof alert.message).toBe('string');
      expect(alert.message.length).toBeGreaterThan(0);

      expect(alert.data).toBeDefined();
      expect(alert.referenceDate).toBeDefined();
    }

    // Our seed contains an overdue incoming transaction.
    const overdueAlert = response.body.find(
      (alert: any) => alert.category === 'OVERDUE_TRANSACTION',
    );

    expect(overdueAlert).toBeDefined();

    // Our seed also contains a pending document review.
    const pendingReviewAlert = response.body.find(
      (alert: any) => alert.category === 'PENDING_DOCUMENT_REVIEW',
    );

    expect(pendingReviewAlert).toBeDefined();
  });
});
