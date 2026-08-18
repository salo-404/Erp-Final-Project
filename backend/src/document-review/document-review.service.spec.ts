/// <reference types="jest" />

import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  ApproveDocumentReviewInput,
  DocumentExtractionProvider,
  DocumentReviewNotifier,
  DocumentReviewService,
  DocumentStorageProvider,
  ExtractedDocumentData,
  MAX_DOCUMENT_SIZE_BYTES,
  NewInvoiceNotificationEvent,
  UploadDocumentInput,
  UploadedDocument,
} from './document-review.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateIncomingInput,
  CreateOutgoingInput,
  InventoryTransactionsService,
} from '../inventory-transactions/inventory-transactions.service';
import type { Prisma } from '../../generated/prisma/client';

function createMockTx() {
  return {
    pendingDocumentReview: {
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
  };
}

type MockTx = ReturnType<typeof createMockTx>;

function createMockPrismaRoot() {
  return {
    pendingDocumentReview: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    product: { findMany: jest.fn() },
    supplier: { findMany: jest.fn() },
  };
}

type MockPrismaRoot = ReturnType<typeof createMockPrismaRoot>;

function createMockPrisma(tx: MockTx, root: MockPrismaRoot) {
  return {
    ...root,
    $transaction: jest.fn((callback: (tx: MockTx) => unknown) => callback(tx)),
  } as unknown as PrismaService;
}

function createMockInventoryTransactionsService() {
  const createIncoming = jest.fn<
    ReturnType<InventoryTransactionsService['createIncoming']>,
    [CreateIncomingInput, Prisma.TransactionClient?]
  >();
  createIncoming.mockResolvedValue({
    id: 501,
    type: 'INCOMING',
    status: 'PENDING',
  } as never);
  const createOutgoing = jest.fn<
    ReturnType<InventoryTransactionsService['createOutgoing']>,
    [CreateOutgoingInput, Prisma.TransactionClient?]
  >();
  createOutgoing.mockResolvedValue({
    id: 502,
    type: 'OUTGOING',
    status: 'PENDING',
  } as never);
  const service = {
    createIncoming,
    createOutgoing,
  } as unknown as InventoryTransactionsService;
  return { service, createIncoming, createOutgoing };
}

function createMockStorageProvider() {
  const upload = jest.fn<
    Promise<UploadedDocument>,
    [{ filename: string; mimeType: string; content: Buffer }]
  >();
  upload.mockResolvedValue({
    url: 'https://s3.example.com/doc-1.pdf',
    key: 'documents/doc-1.pdf',
  });
  const getPresignedUrl = jest.fn<Promise<string>, [string]>();
  getPresignedUrl.mockResolvedValue(
    'https://s3.example.com/doc-1.pdf?X-Amz-Signature=fake',
  );
  const provider: DocumentStorageProvider = { upload, getPresignedUrl };
  return { provider, upload, getPresignedUrl };
}

function createMockExtractionProvider() {
  const extract = jest.fn<
    Promise<ExtractedDocumentData>,
    [{ mimeType: string; documentUrl: string }]
  >();
  extract.mockResolvedValue({
    transactionType: 'INCOMING' as never,
    supplierName: 'Acme Supplies',
    date: new Date('2026-01-01T00:00:00.000Z'),
    items: [{ product: 'Widget', quantity: 5, price: 10 }],
  });
  const provider: DocumentExtractionProvider = { extract };
  return { provider, extract };
}

function createMockNotifier() {
  const notifyNewInvoice = jest.fn<
    Promise<void>,
    [NewInvoiceNotificationEvent]
  >();
  notifyNewInvoice.mockResolvedValue(undefined);
  const provider: DocumentReviewNotifier = { notifyNewInvoice };
  return { provider, notifyNewInvoice };
}

function buildService(tx: MockTx) {
  const prismaRoot = createMockPrismaRoot();
  const {
    service: inventoryTransactionsService,
    createIncoming,
    createOutgoing,
  } = createMockInventoryTransactionsService();
  const {
    provider: storageProvider,
    upload,
    getPresignedUrl,
  } = createMockStorageProvider();
  const { provider: extractionProvider, extract } =
    createMockExtractionProvider();
  const { provider: notifier, notifyNewInvoice } = createMockNotifier();

  const service = new DocumentReviewService(
    createMockPrisma(tx, prismaRoot),
    inventoryTransactionsService,
    storageProvider,
    extractionProvider,
    notifier,
  );

  return {
    service,
    prismaRoot,
    createIncoming,
    createOutgoing,
    upload,
    getPresignedUrl,
    extract,
    notifyNewInvoice,
  };
}

const VALID_UPLOAD_INPUT: UploadDocumentInput = {
  filename: 'invoice.pdf',
  mimeType: 'application/pdf',
  content: Buffer.from('%PDF-1.4 fake content'),
};

describe('DocumentReviewService.upload', () => {
  it('validates, stores, generates a presigned URL, extracts via that URL (never the raw bytes), creates a PENDING_REVIEW row, and emits the new-invoice event', async () => {
    const tx = createMockTx();
    const {
      service,
      prismaRoot,
      upload,
      getPresignedUrl,
      extract,
      notifyNewInvoice,
    } = buildService(tx);
    const createdReview = {
      id: 1,
      documentUrl: 'https://s3.example.com/doc-1.pdf',
      transactionType: 'INCOMING',
      extractedSupplierName: 'Acme Supplies',
      extractedPartyName: null,
      status: 'PENDING_REVIEW',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    prismaRoot.pendingDocumentReview.create.mockResolvedValue(createdReview);

    const result = await service.upload(VALID_UPLOAD_INPUT);

    expect(upload).toHaveBeenCalledWith({
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      content: VALID_UPLOAD_INPUT.content,
    });
    expect(getPresignedUrl).toHaveBeenCalledWith('documents/doc-1.pdf');
    expect(extract).toHaveBeenCalledWith({
      mimeType: 'application/pdf',
      documentUrl: 'https://s3.example.com/doc-1.pdf?X-Amz-Signature=fake',
    });
    // The raw Buffer must never be handed to the extraction provider.
    const extractCallArg = extract.mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(extractCallArg).not.toHaveProperty('content');
    expect(prismaRoot.pendingDocumentReview.create).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest matcher, not real data
      data: expect.objectContaining({
        documentUrl: 'https://s3.example.com/doc-1.pdf',
        transactionType: 'INCOMING',
        extractedSupplierName: 'Acme Supplies',
        status: 'PENDING_REVIEW',
        extractedItems: [{ product: 'Widget', quantity: 5, price: 10 }],
      }),
    });
    expect(notifyNewInvoice).toHaveBeenCalledWith({
      reviewId: 1,
      documentUrl: 'https://s3.example.com/doc-1.pdf',
      transactionType: 'INCOMING',
      extractedSupplierName: 'Acme Supplies',
      extractedPartyName: null,
      createdAt: createdReview.createdAt,
    });
    expect(result).toEqual(createdReview);
  });

  it.each(ALLOWED_DOCUMENT_MIME_TYPES)(
    'accepts the allowed file type %s',
    async (mimeType) => {
      const tx = createMockTx();
      const { service, prismaRoot } = buildService(tx);
      prismaRoot.pendingDocumentReview.create.mockResolvedValue({
        id: 1,
        status: 'PENDING_REVIEW',
      });

      await expect(
        service.upload({ ...VALID_UPLOAD_INPUT, mimeType }),
      ).resolves.toBeDefined();
    },
  );

  it('rejects an unsupported file type before storing or extracting anything', async () => {
    const tx = createMockTx();
    const { service, upload, extract, prismaRoot, notifyNewInvoice } =
      buildService(tx);

    await expect(
      service.upload({ ...VALID_UPLOAD_INPUT, mimeType: 'text/plain' }),
    ).rejects.toThrow('Unsupported file type: text/plain');

    expect(upload).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(prismaRoot.pendingDocumentReview.create).not.toHaveBeenCalled();
    expect(notifyNewInvoice).not.toHaveBeenCalled();
  });

  it('rejects an empty file', async () => {
    const tx = createMockTx();
    const { service, upload } = buildService(tx);

    await expect(
      service.upload({ ...VALID_UPLOAD_INPUT, content: Buffer.alloc(0) }),
    ).rejects.toThrow('Uploaded file is empty');

    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects a file larger than the maximum allowed size', async () => {
    const tx = createMockTx();
    const { service, upload } = buildService(tx);
    const oversized = Buffer.alloc(MAX_DOCUMENT_SIZE_BYTES + 1);

    await expect(
      service.upload({ ...VALID_UPLOAD_INPUT, content: oversized }),
    ).rejects.toThrow(/exceeds the maximum allowed size/);

    expect(upload).not.toHaveBeenCalled();
  });

  it('rejects a document whose extracted transactionType is not INCOMING/OUTGOING, without creating a review row', async () => {
    const tx = createMockTx();
    const { service, extract, prismaRoot, notifyNewInvoice } = buildService(tx);
    extract.mockResolvedValue({
      transactionType: 'TRANSFER' as never,
      items: [],
    });

    await expect(service.upload(VALID_UPLOAD_INPUT)).rejects.toThrow(
      'Document review only supports INCOMING or OUTGOING documents, got TRANSFER',
    );

    expect(prismaRoot.pendingDocumentReview.create).not.toHaveBeenCalled();
    expect(notifyNewInvoice).not.toHaveBeenCalled();
  });
});

describe('DocumentReviewService.approve', () => {
  it('approves an INCOMING review by creating a PENDING InventoryTransaction via createIncoming()', async () => {
    const tx = createMockTx();
    const { service, createIncoming, createOutgoing } = buildService(tx);
    tx.pendingDocumentReview.updateMany.mockResolvedValue({ count: 1 });
    tx.pendingDocumentReview.findUniqueOrThrow.mockResolvedValueOnce({
      id: 1,
      transactionType: 'INCOMING',
      documentUrl: 'https://s3.example.com/doc-1.pdf',
    });
    tx.pendingDocumentReview.findUniqueOrThrow.mockResolvedValueOnce({
      id: 1,
      status: 'APPROVED',
      transactionId: 501,
    });

    const input: ApproveDocumentReviewInput = {
      reviewedById: 9,
      supplierId: 1,
      destinationWarehouseId: 10,
      items: [{ productId: 100, quantity: 5, price: 10 }],
    };

    const result = await service.approve(1, input);

    expect(createIncoming).toHaveBeenCalledWith(
      {
        supplierId: 1,
        destinationWarehouseId: 10,
        expectedDate: undefined,
        documentUrl: 'https://s3.example.com/doc-1.pdf',
        items: [{ productId: 100, quantity: 5, price: 10 }],
      },
      tx,
    );
    expect(createOutgoing).not.toHaveBeenCalled();
    expect(tx.pendingDocumentReview.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { transactionId: 501 },
    });
    expect(result.transactionId).toBe(501);
  });

  it('approves an OUTGOING review by creating a PENDING InventoryTransaction via createOutgoing()', async () => {
    const tx = createMockTx();
    const { service, createIncoming, createOutgoing } = buildService(tx);
    tx.pendingDocumentReview.updateMany.mockResolvedValue({ count: 1 });
    tx.pendingDocumentReview.findUniqueOrThrow.mockResolvedValueOnce({
      id: 2,
      transactionType: 'OUTGOING',
      documentUrl: 'https://s3.example.com/doc-2.pdf',
    });
    tx.pendingDocumentReview.findUniqueOrThrow.mockResolvedValueOnce({
      id: 2,
      status: 'APPROVED',
      transactionId: 502,
    });

    const input: ApproveDocumentReviewInput = {
      reviewedById: 9,
      sourceWarehouseId: 10,
      partyName: 'Customer X',
      items: [{ productId: 100, quantity: 2 }],
    };

    await service.approve(2, input);

    expect(createOutgoing).toHaveBeenCalledWith(
      {
        sourceWarehouseId: 10,
        partyName: 'Customer X',
        deliveryCountry: undefined,
        deliveryRegion: undefined,
        deliveryAddress: undefined,
        expectedDate: undefined,
        documentUrl: 'https://s3.example.com/doc-2.pdf',
        items: [{ productId: 100, quantity: 2 }],
      },
      tx,
    );
    expect(createIncoming).not.toHaveBeenCalled();
  });

  it('rejects approving an INCOMING review missing supplierId/destinationWarehouseId', async () => {
    const tx = createMockTx();
    const { service, createIncoming } = buildService(tx);
    tx.pendingDocumentReview.updateMany.mockResolvedValue({ count: 1 });
    tx.pendingDocumentReview.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      transactionType: 'INCOMING',
      documentUrl: 'https://s3.example.com/doc-1.pdf',
    });

    await expect(
      service.approve(1, { reviewedById: 9, items: [] }),
    ).rejects.toThrow(
      'supplierId and destinationWarehouseId are required to approve an INCOMING review',
    );
    expect(createIncoming).not.toHaveBeenCalled();
  });

  it('rejects approving an OUTGOING review missing sourceWarehouseId', async () => {
    const tx = createMockTx();
    const { service, createOutgoing } = buildService(tx);
    tx.pendingDocumentReview.updateMany.mockResolvedValue({ count: 1 });
    tx.pendingDocumentReview.findUniqueOrThrow.mockResolvedValue({
      id: 2,
      transactionType: 'OUTGOING',
      documentUrl: 'https://s3.example.com/doc-2.pdf',
    });

    await expect(
      service.approve(2, { reviewedById: 9, items: [] }),
    ).rejects.toThrow(
      'sourceWarehouseId is required to approve an OUTGOING review',
    );
    expect(createOutgoing).not.toHaveBeenCalled();
  });

  it('rejects approving a review that is not PENDING_REVIEW', async () => {
    const tx = createMockTx();
    const { service, createIncoming } = buildService(tx);
    tx.pendingDocumentReview.updateMany.mockResolvedValue({ count: 0 });
    tx.pendingDocumentReview.findUnique.mockResolvedValue({
      id: 1,
      status: 'APPROVED',
    });

    await expect(
      service.approve(1, { reviewedById: 9, items: [] }),
    ).rejects.toThrow(
      'PendingDocumentReview 1 is not PENDING_REVIEW (status: APPROVED) — cannot approve',
    );
    expect(createIncoming).not.toHaveBeenCalled();
  });

  it('rejects approving a review that does not exist', async () => {
    const tx = createMockTx();
    const { service } = buildService(tx);
    tx.pendingDocumentReview.updateMany.mockResolvedValue({ count: 0 });
    tx.pendingDocumentReview.findUnique.mockResolvedValue(null);

    await expect(
      service.approve(999, { reviewedById: 9, items: [] }),
    ).rejects.toThrow('PendingDocumentReview 999 not found');
  });
});

describe('DocumentReviewService.reject', () => {
  it('rejects a PENDING_REVIEW row, storing rejectionReason and reviewer information', async () => {
    const tx = createMockTx();
    const { service } = buildService(tx);
    tx.pendingDocumentReview.updateMany.mockResolvedValue({ count: 1 });
    tx.pendingDocumentReview.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      status: 'REJECTED',
      rejectionReason: 'Illegible scan',
      reviewedById: 9,
    });

    const result = await service.reject(1, {
      reviewedById: 9,
      rejectionReason: 'Illegible scan',
    });

    expect(tx.pendingDocumentReview.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: 'PENDING_REVIEW' },
      data: {
        status: 'REJECTED',
        rejectionReason: 'Illegible scan',
        reviewedById: 9,
        reviewedAt: expect.any(Date) as Date,
      },
    });
    expect(result.status).toBe('REJECTED');
  });

  it('rejects an empty rejectionReason without touching the database', async () => {
    const tx = createMockTx();
    const { service } = buildService(tx);

    await expect(
      service.reject(1, { reviewedById: 9, rejectionReason: '   ' }),
    ).rejects.toThrow('rejectionReason must not be empty');

    expect(tx.pendingDocumentReview.updateMany).not.toHaveBeenCalled();
  });

  it('rejects rejecting a review that is not PENDING_REVIEW', async () => {
    const tx = createMockTx();
    const { service } = buildService(tx);
    tx.pendingDocumentReview.updateMany.mockResolvedValue({ count: 0 });
    tx.pendingDocumentReview.findUnique.mockResolvedValue({
      id: 1,
      status: 'REJECTED',
    });

    await expect(
      service.reject(1, { reviewedById: 9, rejectionReason: 'Duplicate' }),
    ).rejects.toThrow(
      'PendingDocumentReview 1 is not PENDING_REVIEW (status: REJECTED) — cannot reject',
    );
  });
});

describe('DocumentReviewService.getReview', () => {
  it('returns a review with its transaction and reviewer included', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    const review = { id: 1, status: 'PENDING_REVIEW', transaction: null };
    prismaRoot.pendingDocumentReview.findUnique.mockResolvedValue(review);

    const result = await service.getReview(1);

    expect(prismaRoot.pendingDocumentReview.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      include: { transaction: { include: { items: true } }, reviewedBy: true },
    });
    expect(result).toEqual(review);
  });

  it('throws NotFoundException when the review does not exist', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.pendingDocumentReview.findUnique.mockResolvedValue(null);

    await expect(service.getReview(999)).rejects.toThrow(
      'PendingDocumentReview 999 not found',
    );
  });
});

describe('DocumentReviewService.getPendingReviews', () => {
  it('returns every PENDING_REVIEW row, oldest first', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    const rows = [{ id: 1, status: 'PENDING_REVIEW' }];
    prismaRoot.pendingDocumentReview.findMany.mockResolvedValue(rows);

    const result = await service.getPendingReviews();

    expect(prismaRoot.pendingDocumentReview.findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING_REVIEW' },
      orderBy: { createdAt: 'asc' },
    });
    expect(result).toEqual(rows);
  });

  it('returns an empty array when nothing is pending', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.pendingDocumentReview.findMany.mockResolvedValue([]);

    const result = await service.getPendingReviews();

    expect(result).toEqual([]);
  });
});

describe('DocumentReviewService.resolveProduct', () => {
  it('ranks an exact case-insensitive match above a partial match', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([
      { id: 1, name: 'Widget Pro' },
      { id: 2, name: 'widget' },
    ]);

    const result = await service.resolveProduct('Widget');

    expect(prismaRoot.product.findMany).toHaveBeenCalledWith({
      where: {
        name: { contains: 'Widget', mode: 'insensitive' },
        isActive: true,
      },
      take: 10,
    });
    expect(result[0]).toEqual({ productId: 2, name: 'widget', score: 1 });
    expect(result[1].productId).toBe(1);
    expect(result[1].score).toBeLessThan(1);
  });

  it('rejects an empty query without touching the database', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);

    await expect(service.resolveProduct('   ')).rejects.toThrow(
      'query must not be empty',
    );
    expect(prismaRoot.product.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty array when nothing matches', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([]);

    const result = await service.resolveProduct('Nonexistent');

    expect(result).toEqual([]);
  });
});

describe('DocumentReviewService.resolveSupplier', () => {
  it('ranks an exact case-insensitive match above a partial match', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.supplier.findMany.mockResolvedValue([
      { id: 1, name: 'Acme Supplies Co.' },
      { id: 2, name: 'acme supplies' },
    ]);

    const result = await service.resolveSupplier('Acme Supplies');

    expect(prismaRoot.supplier.findMany).toHaveBeenCalledWith({
      where: {
        name: { contains: 'Acme Supplies', mode: 'insensitive' },
        isActive: true,
      },
      take: 10,
    });
    expect(result[0]).toEqual({
      supplierId: 2,
      name: 'acme supplies',
      score: 1,
    });
  });

  it('rejects an empty query without touching the database', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);

    await expect(service.resolveSupplier('')).rejects.toThrow(
      'query must not be empty',
    );
    expect(prismaRoot.supplier.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty array when nothing matches', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.supplier.findMany.mockResolvedValue([]);

    const result = await service.resolveSupplier('Nonexistent');

    expect(result).toEqual([]);
  });
});
