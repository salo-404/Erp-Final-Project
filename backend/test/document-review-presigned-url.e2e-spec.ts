import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { InventoryTransactionType } from '../generated/prisma/client';

describe('DocumentReview presigned-url regeneration (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let authHeader: string;

  let reviewId: number;
  let reviewIdWithoutKey: number;

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

    const loginResponse = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'employee@minierp.com', password: 'Password123!' })
      .expect(200);
    authHeader = `Bearer ${loginResponse.body.access_token}`;

    // A row with a real (but nonexistent) S3 key — getPresignedUrl() only
    // signs a URL, it never checks the object actually exists, so this
    // exercises real AWS signing without needing a real uploaded file.
    const review = await prisma.pendingDocumentReview.create({
      data: {
        documentUrl:
          'https://invoice-documents-mini-erp.s3.amazonaws.com/documents/e2e-presigned-url-test.pdf',
        documentKey: 'documents/e2e-presigned-url-test.pdf',
        transactionType: InventoryTransactionType.INCOMING,
        extractedItems: [],
      },
    });
    reviewId = review.id;

    // Simulates a pre-existing row created before documentKey existed.
    const reviewWithoutKey = await prisma.pendingDocumentReview.create({
      data: {
        documentUrl:
          'https://invoice-documents-mini-erp.s3.amazonaws.com/documents/legacy-no-key.pdf',
        transactionType: InventoryTransactionType.INCOMING,
        extractedItems: [],
      },
    });
    reviewIdWithoutKey = reviewWithoutKey.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  it('rejects the request with no JWT at all', async () => {
    await request(app.getHttpServer())
      .get(`/document-review/${reviewId}/presigned-url`)
      .expect(401);
  });

  it('regenerates a fresh presigned URL for an existing document, scoped to its stored S3 key', async () => {
    const response = await request(app.getHttpServer())
      .get(`/document-review/${reviewId}/presigned-url`)
      .set('Authorization', authHeader)
      .expect(200);

    expect(typeof response.body.url).toBe('string');
    expect(response.body.url).toContain('invoice-documents-mini-erp');
    expect(response.body.url).toContain(
      '/documents/e2e-presigned-url-test.pdf',
    );
    // A presigned URL carries a signature query string — proof it's not
    // just the permanent (non-expiring) documentUrl being echoed back.
    expect(response.body.url).toMatch(/X-Amz-Signature=/);
    expect(response.body.url).toMatch(/X-Amz-Expires=300\b/);
  });

  it('is generated fresh on each call and never persisted on the review row', async () => {
    await request(app.getHttpServer())
      .get(`/document-review/${reviewId}/presigned-url`)
      .set('Authorization', authHeader)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/document-review/${reviewId}/presigned-url`)
      .set('Authorization', authHeader)
      .expect(200);

    const storedReview = await prisma.pendingDocumentReview.findUniqueOrThrow({
      where: { id: reviewId },
    });
    // Calling the endpoint (twice) never wrote a presigned URL anywhere —
    // the permanent reference is still exactly the object key/URL persisted
    // at upload time.
    expect(storedReview.documentKey).toBe(
      'documents/e2e-presigned-url-test.pdf',
    );
    expect(storedReview.documentUrl).toBe(
      'https://invoice-documents-mini-erp.s3.amazonaws.com/documents/e2e-presigned-url-test.pdf',
    );
  });

  it('returns 404 for a nonexistent review id', async () => {
    await request(app.getHttpServer())
      .get('/document-review/999999999/presigned-url')
      .set('Authorization', authHeader)
      .expect(404);
  });

  it('returns 404 for a review with no stored S3 key', async () => {
    await request(app.getHttpServer())
      .get(`/document-review/${reviewIdWithoutKey}/presigned-url`)
      .set('Authorization', authHeader)
      .expect(404);
  });
});
