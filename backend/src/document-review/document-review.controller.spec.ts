/// <reference types="jest" />

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { DocumentReviewController } from './document-review.controller';
import {
  DocumentExtractionProvider,
  DocumentReviewNotifier,
  DocumentReviewService,
  DocumentStorageProvider,
  ExtractedDocumentData,
  UploadedDocument,
} from './document-review.service';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryTransactionsService } from '../inventory-transactions/inventory-transactions.service';

/**
 * Builds a real DocumentReviewService (not a mock of the service itself) so
 * these tests exercise the actual upload() flow — file-type validation,
 * S3-style storage, presigned-URL generation, and extraction — through the
 * real HTTP multipart layer, with only the three external provider
 * boundaries (storage/extraction/notifier) and Prisma/InventoryTransactions
 * mocked out.
 */
function buildApp() {
  const upload = jest.fn<
    Promise<UploadedDocument>,
    [{ filename: string; mimeType: string; content: Buffer }]
  >();
  const getPresignedUrl = jest.fn<Promise<string>, [string]>();
  const storageProvider: DocumentStorageProvider = {
    upload,
    getPresignedUrl,
  };

  const extract = jest.fn<
    Promise<ExtractedDocumentData>,
    [{ mimeType: string; documentUrl: string }]
  >();
  const extractionProvider: DocumentExtractionProvider = { extract };

  const notifyNewInvoice = jest.fn().mockResolvedValue(undefined);
  const notifier: DocumentReviewNotifier = { notifyNewInvoice };

  const prismaCreate = jest.fn();
  const prisma = {
    pendingDocumentReview: { create: prismaCreate },
  } as unknown as PrismaService;

  const inventoryTransactionsService = {} as InventoryTransactionsService;

  const service = new DocumentReviewService(
    prisma,
    inventoryTransactionsService,
    storageProvider,
    extractionProvider,
    notifier,
  );

  return {
    service,
    upload,
    getPresignedUrl,
    extract,
    notifyNewInvoice,
    prismaCreate,
  };
}

async function createTestApp(
  service: DocumentReviewService,
): Promise<INestApplication<any>> {
  const moduleRef = await Test.createTestingModule({
    controllers: [DocumentReviewController],
    providers: [{ provide: DocumentReviewService, useValue: service }],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

describe('DocumentReviewController.upload', () => {
  let app: INestApplication<any>;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  it('accepts a PDF upload, stores it, generates a presigned URL, extracts via that URL, and returns the created review', async () => {
    const { service, upload, getPresignedUrl, extract, prismaCreate } =
      buildApp();
    upload.mockResolvedValue({
      url: 'https://s3.example.com/doc-1.pdf',
      key: 'documents/doc-1.pdf',
    });
    getPresignedUrl.mockResolvedValue(
      'https://s3.example.com/doc-1.pdf?X-Amz-Signature=fake',
    );
    extract.mockResolvedValue({
      transactionType: 'INCOMING',
      supplierName: 'Acme Supplies',
      items: [{ product: 'Widget', quantity: 5, price: 10 }],
    });
    prismaCreate.mockResolvedValue({
      id: 1,
      documentUrl: 'https://s3.example.com/doc-1.pdf',
      status: 'PENDING_REVIEW',
    });
    app = await createTestApp(service);

    const response = await request(app.getHttpServer())
      .post('/document-review/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake content'), {
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      id: 1,
      documentUrl: 'https://s3.example.com/doc-1.pdf',
      status: 'PENDING_REVIEW',
    });

    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
      }),
    );
    const uploadArg = upload.mock.calls[0][0];
    expect(Buffer.isBuffer(uploadArg.content)).toBe(true);
    expect(uploadArg.content.toString()).toBe('%PDF-1.4 fake content');

    expect(getPresignedUrl).toHaveBeenCalledWith('documents/doc-1.pdf');

    // Extraction must receive the presigned documentUrl, never the Buffer.
    expect(extract).toHaveBeenCalledWith({
      mimeType: 'application/pdf',
      documentUrl: 'https://s3.example.com/doc-1.pdf?X-Amz-Signature=fake',
    });
    const extractArg = extract.mock.calls[0][0];
    expect(extractArg).not.toHaveProperty('content');
  });

  it('accepts a supported image upload (image/png)', async () => {
    const { service, upload, getPresignedUrl, extract, prismaCreate } =
      buildApp();
    upload.mockResolvedValue({
      url: 'https://s3.example.com/doc-2.png',
      key: 'documents/doc-2.png',
    });
    getPresignedUrl.mockResolvedValue(
      'https://s3.example.com/doc-2.png?X-Amz-Signature=fake',
    );
    extract.mockResolvedValue({ transactionType: 'OUTGOING', items: [] });
    prismaCreate.mockResolvedValue({ id: 2, status: 'PENDING_REVIEW' });
    app = await createTestApp(service);

    const response = await request(app.getHttpServer())
      .post('/document-review/upload')
      .attach('file', Buffer.from('fake png bytes'), {
        filename: 'scan.png',
        contentType: 'image/png',
      });

    expect(response.status).toBe(201);
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'image/png' }),
    );
  });

  it('rejects an unsupported file type with 400, without calling the storage provider', async () => {
    const { service, upload } = buildApp();
    app = await createTestApp(service);

    const response = await request(app.getHttpServer())
      .post('/document-review/upload')
      .attach('file', Buffer.from('hello'), {
        filename: 'notes.txt',
        contentType: 'text/plain',
      });

    expect(response.status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects a request with no file attached', async () => {
    const { service } = buildApp();
    app = await createTestApp(service);

    const response = await request(app.getHttpServer()).post(
      '/document-review/upload',
    );

    expect(response.status).toBe(400);
  });

  it('propagates a storage-provider (S3) failure as a 500', async () => {
    const { service, upload } = buildApp();
    upload.mockRejectedValue(
      new Error('Failed to upload document to S3: AccessDenied'),
    );
    app = await createTestApp(service);

    const response = await request(app.getHttpServer())
      .post('/document-review/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake'), {
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
      });

    expect(response.status).toBe(500);
  });

  it('propagates an extraction-provider failure as a 500', async () => {
    const { service, upload, getPresignedUrl, extract } = buildApp();
    upload.mockResolvedValue({
      url: 'https://s3.example.com/doc-1.pdf',
      key: 'documents/doc-1.pdf',
    });
    getPresignedUrl.mockResolvedValue('https://s3.example.com/signed');
    extract.mockRejectedValue(
      new Error('Ribal extraction agent returned HTTP 503'),
    );
    app = await createTestApp(service);

    const response = await request(app.getHttpServer())
      .post('/document-review/upload')
      .attach('file', Buffer.from('%PDF-1.4 fake'), {
        filename: 'invoice.pdf',
        contentType: 'application/pdf',
      });

    expect(response.status).toBe(500);
  });
});
