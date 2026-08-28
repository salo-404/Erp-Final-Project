import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { CognitoTokenVerifier } from '../src/auth/cognito-token-verifier.service';
import { cognitoAuthHeaderFor, mockCognitoVerifier } from './cognito-auth-test-helper';

describe('Supplier Intelligence (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authHeader: string;

  let laptopId: number;
  let techSourceId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(CognitoTokenVerifier)
      .useValue(mockCognitoVerifier)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');

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

    const laptop = await prisma.product.findFirstOrThrow({
      where: { name: 'Laptop Pro 14' },
    });

    const techSource = await prisma.supplier.findFirstOrThrow({
      where: { name: 'TechSource Lebanon' },
    });

    laptopId = laptop.id;
    techSourceId = techSource.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('returns supplier statistics from transaction history', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/supplier-intelligence/${techSourceId}/stats`)
      .set('Authorization', authHeader)
      .expect(200);

    expect(response.body.supplierId).toBe(techSourceId);

    expect(response.body.totalTransactions).toBeGreaterThan(0);
    expect(response.body.completedTransactions).toBeGreaterThan(0);

    expect(response.body.averagePrice).not.toBeNull();
    expect(response.body.pricedItemCount).toBeGreaterThan(0);

    expect(response.body.cancellationRate).toBeGreaterThanOrEqual(0);
    expect(response.body.cancellationRate).toBeLessThanOrEqual(1);

    expect(response.body.purchaseFrequency).toBeGreaterThanOrEqual(0);
  });

  it('compares only suppliers that supplied the requested product', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/supplier-intelligence/compare')
      .set('Authorization', authHeader)
      .query({
        productId: laptopId,
      })
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    for (const supplier of response.body) {
      expect(supplier.productId).toBe(laptopId);
      expect(supplier.supplierId).toBeDefined();
      expect(supplier.supplierName).toBeDefined();
      expect(supplier.totalTransactions).toBeGreaterThan(0);
    }

    const names = response.body.map((supplier: any) => supplier.supplierName);

    expect(names).toContain('TechSource Lebanon');
    expect(names).toContain('Cedar Electronics');
    expect(names).toContain('Levant Trading');

    // Inactive suppliers must not be recommended/compared.
    expect(names).not.toContain('Old Supplier');
  });

  it('ranks suppliers and clearly marks insufficient data', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/supplier-intelligence/rank')
      .set('Authorization', authHeader)
      .query({
        productId: laptopId,
      })
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);

    for (const supplier of response.body) {
      expect(supplier.supplierId).toBeDefined();
      expect(supplier.productId).toBe(laptopId);

      expect(typeof supplier.insufficientData).toBe('boolean');

      expect(supplier.componentScores).toBeDefined();
      expect(supplier.componentScores.cancellationPerformance).toBeDefined();

      if (supplier.insufficientData) {
        expect(supplier.rank).toBeNull();
        expect(supplier.score).toBeNull();

        expect(Array.isArray(supplier.insufficientDataReasons)).toBe(true);
        expect(supplier.insufficientDataReasons.length).toBeGreaterThan(0);
      } else {
        expect(supplier.rank).toBeGreaterThan(0);
        expect(supplier.score).toBeGreaterThanOrEqual(0);
        expect(supplier.score).toBeLessThanOrEqual(100);
      }
    }
  });

  it('returns null for best supplier when no supplier has enough ranking evidence', async () => {
    const rankedResponse = await request(app.getHttpServer())
      .get('/api/supplier-intelligence/rank')
      .set('Authorization', authHeader)
      .query({
        productId: laptopId,
      })
      .expect(200);

    const hasFullyRankedSupplier = rankedResponse.body.some(
      (supplier: any) => supplier.rank === 1,
    );

    const bestResponse = await request(app.getHttpServer())
      .get('/api/supplier-intelligence/best')
      .set('Authorization', authHeader)
      .query({
        productId: laptopId,
      })
      .expect(200);

    if (hasFullyRankedSupplier) {
      expect(bestResponse.body.rank).toBe(1);
      expect(bestResponse.body.productId).toBe(laptopId);
    } else {
      // Nest serializes a returned null as an empty response body in some setups,
      // so allow either null or empty string/object depending on adapter behavior.
      expect(
        bestResponse.body === null ||
          bestResponse.body === '' ||
          Object.keys(bestResponse.body ?? {}).length === 0,
      ).toBe(true);
    }
  });
});
