import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { CognitoTokenVerifier } from '../src/auth/cognito-token-verifier.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { cognitoAuthHeaderFor, mockCognitoVerifier } from './cognito-auth-test-helper';

describe('Suppliers (e2e)', () => {
  let app: INestApplication;
  let authHeader: string;
  let createdSupplierId: number;

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

    // Create/update are ADMIN-only (see SuppliersController).
    authHeader = await cognitoAuthHeaderFor(
      app.get(PrismaService),
      'admin@minierp.com',
    );
  });

  afterAll(async () => {
    if (createdSupplierId) {
      await request(app.getHttpServer())
        .delete(`/suppliers/${createdSupplierId}`)
        .set('Authorization', authHeader);
    }
    if (app) {
      await app.close();
    }
  });

  it('round-trips leadTimeDays through create, get, list, and update', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/suppliers')
      .set('Authorization', authHeader)
      .send({ name: 'E2E Lead Time Test Supplier', leadTimeDays: 7 })
      .expect(201);

    expect(createResponse.body.leadTimeDays).toBe(7);
    createdSupplierId = createResponse.body.id;

    const getResponse = await request(app.getHttpServer())
      .get(`/suppliers/${createdSupplierId}`)
      .set('Authorization', authHeader)
      .expect(200);

    expect(getResponse.body.leadTimeDays).toBe(7);

    const listResponse = await request(app.getHttpServer())
      .get('/suppliers')
      .set('Authorization', authHeader)
      .expect(200);

    const listed = listResponse.body.find(
      (supplier: any) => supplier.id === createdSupplierId,
    );
    expect(listed).toBeDefined();
    expect(listed.leadTimeDays).toBe(7);

    const updateResponse = await request(app.getHttpServer())
      .patch(`/suppliers/${createdSupplierId}`)
      .set('Authorization', authHeader)
      .send({ leadTimeDays: 14 })
      .expect(200);

    expect(updateResponse.body.leadTimeDays).toBe(14);
  });

  it('defaults leadTimeDays to null when not provided on create', async () => {
    const response = await request(app.getHttpServer())
      .post('/suppliers')
      .set('Authorization', authHeader)
      .send({ name: 'E2E No Lead Time Supplier' })
      .expect(201);

    expect(response.body.leadTimeDays).toBeNull();

    await request(app.getHttpServer())
      .delete(`/suppliers/${response.body.id}`)
      .set('Authorization', authHeader);
  });
});
