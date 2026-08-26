/// <reference types="jest" />

import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  ApproveDocumentReviewInput,
  DocumentExtractionProvider,
  DocumentReviewNotifier,
  DocumentReviewService,
  DocumentSemanticMatchProvider,
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
    // Only touched by resolveApprovalItems() for a newProduct line — see
    // the DocumentReviewService.approve newProduct tests below.
    product: {
      findFirst: jest.fn(),
      create: jest.fn(),
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
  const deleteObject = jest.fn<Promise<void>, [string]>().mockResolvedValue();
  const provider: DocumentStorageProvider = {
    upload,
    getPresignedUrl,
    delete: deleteObject,
  };
  return { provider, upload, getPresignedUrl, deleteObject };
}

function createMockExtractionProvider() {
  const extract = jest.fn<
    Promise<ExtractedDocumentData>,
    [{ mimeType: string; documentKey: string }]
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

/**
 * Defaults to REJECTING both methods — matching an unconfigured/unreachable
 * AI service — so every EXISTING resolveProduct/resolveSupplier test below
 * (written before this provider existed) keeps exercising the fuzzy
 * fallback path unchanged, with no per-test setup required. Tests that
 * specifically want the semantic path override matchProduct/matchSupplier's
 * mock return value.
 */
function createMockSemanticMatchProvider() {
  const matchProduct = jest.fn<
    ReturnType<DocumentSemanticMatchProvider['matchProduct']>,
    Parameters<DocumentSemanticMatchProvider['matchProduct']>
  >();
  matchProduct.mockRejectedValue(
    new Error('semantic match provider not configured in this test'),
  );
  const matchSupplier = jest.fn<
    ReturnType<DocumentSemanticMatchProvider['matchSupplier']>,
    Parameters<DocumentSemanticMatchProvider['matchSupplier']>
  >();
  matchSupplier.mockRejectedValue(
    new Error('semantic match provider not configured in this test'),
  );
  const provider: DocumentSemanticMatchProvider = {
    matchProduct,
    matchSupplier,
  };
  return { provider, matchProduct, matchSupplier };
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
    deleteObject,
  } = createMockStorageProvider();
  const { provider: extractionProvider, extract } =
    createMockExtractionProvider();
  const { provider: notifier, notifyNewInvoice } = createMockNotifier();
  const {
    provider: semanticMatchProvider,
    matchProduct,
    matchSupplier,
  } = createMockSemanticMatchProvider();

  const service = new DocumentReviewService(
    createMockPrisma(tx, prismaRoot),
    inventoryTransactionsService,
    storageProvider,
    extractionProvider,
    notifier,
    semanticMatchProvider,
  );

  return {
    service,
    prismaRoot,
    createIncoming,
    createOutgoing,
    upload,
    getPresignedUrl,
    deleteObject,
    extract,
    notifyNewInvoice,
    matchProduct,
    matchSupplier,
  };
}

const VALID_UPLOAD_INPUT: UploadDocumentInput = {
  filename: 'invoice.pdf',
  mimeType: 'application/pdf',
  content: Buffer.from('%PDF-1.4 fake content'),
};

describe('DocumentReviewService.upload', () => {
  it('validates, stores, extracts the private S3 object by key, creates a PENDING_REVIEW row, and emits the new-invoice event', async () => {
    const tx = createMockTx();
    const {
      service,
      prismaRoot,
      upload,
      getPresignedUrl,
      deleteObject,
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
    expect(getPresignedUrl).not.toHaveBeenCalled();
    expect(extract).toHaveBeenCalledWith({
      mimeType: 'application/pdf',
      documentKey: 'documents/doc-1.pdf',
    });
    // The raw Buffer must never be handed to the extraction provider.
    const extractCallArg = extract.mock.calls[0][0] as unknown as Record<
      string,
      unknown
    >;
    expect(extractCallArg).not.toHaveProperty('content');
    expect(extractCallArg).not.toHaveProperty('documentUrl');
    expect(prismaRoot.pendingDocumentReview.create).toHaveBeenCalledWith({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest matcher, not real data
      data: expect.objectContaining({
        documentUrl: 'https://s3.example.com/doc-1.pdf',
        // The permanent reference is the private S3 object key used by
        // Textract and by the separate viewing-URL flow.
        documentKey: 'documents/doc-1.pdf',
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
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('deletes the newly uploaded object when extraction fails', async () => {
    const tx = createMockTx();
    const { service, extract, deleteObject, prismaRoot } = buildService(tx);
    const original = new Error('extraction unavailable');
    extract.mockRejectedValue(original);

    await expect(service.upload(VALID_UPLOAD_INPUT)).rejects.toBe(original);
    expect(deleteObject).toHaveBeenCalledWith('documents/doc-1.pdf');
    expect(prismaRoot.pendingDocumentReview.create).not.toHaveBeenCalled();
  });

  it('deletes the newly uploaded object when explicit transaction-marker extraction fails', async () => {
    const tx = createMockTx();
    const { service, extract, deleteObject, prismaRoot } = buildService(tx);
    const markerError = new Error(
      'Textract extraction could not find an explicit Transaction Type marker',
    );
    extract.mockRejectedValue(markerError);

    await expect(service.upload(VALID_UPLOAD_INPUT)).rejects.toBe(markerError);
    expect(deleteObject).toHaveBeenCalledWith('documents/doc-1.pdf');
    expect(prismaRoot.pendingDocumentReview.create).not.toHaveBeenCalled();
  });

  it('deletes the newly uploaded object when review persistence fails', async () => {
    const tx = createMockTx();
    const { service, deleteObject, prismaRoot } = buildService(tx);
    const original = new Error('database unavailable');
    prismaRoot.pendingDocumentReview.create.mockRejectedValue(original);

    await expect(service.upload(VALID_UPLOAD_INPUT)).rejects.toBe(original);
    expect(deleteObject).toHaveBeenCalledWith('documents/doc-1.pdf');
  });

  it('preserves the original pipeline error when object cleanup also fails', async () => {
    const tx = createMockTx();
    const { service, extract, deleteObject } = buildService(tx);
    const original = new Error('original extraction failure');
    extract.mockRejectedValue(original);
    deleteObject.mockRejectedValue(new Error('cleanup failure'));

    await expect(service.upload(VALID_UPLOAD_INPUT)).rejects.toBe(original);
    expect(deleteObject).toHaveBeenCalledWith('documents/doc-1.pdf');
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
    const { service, extract, prismaRoot, notifyNewInvoice, deleteObject } =
      buildService(tx);
    extract.mockResolvedValue({
      transactionType: 'TRANSFER' as never,
      items: [],
    });

    await expect(service.upload(VALID_UPLOAD_INPUT)).rejects.toThrow(
      'Invalid extraction response: transactionType must be INCOMING or OUTGOING',
    );

    expect(prismaRoot.pendingDocumentReview.create).not.toHaveBeenCalled();
    expect(notifyNewInvoice).not.toHaveBeenCalled();
    expect(deleteObject).toHaveBeenCalledWith('documents/doc-1.pdf');
  });

  it.each([
    [{ transactionType: 'INCOMING', items: 'bad' }, 'items must be an array'],
    [
      {
        transactionType: 'INCOMING',
        items: [{ product: 'Widget', quantity: 1.5 }],
      },
      'quantity must be a positive integer',
    ],
    [
      {
        transactionType: 'INCOMING',
        items: [{ product: 'Widget', quantity: 0 }],
      },
      'quantity must be a positive integer',
    ],
    [
      {
        transactionType: 'INCOMING',
        items: [{ product: 'Widget', quantity: -1 }],
      },
      'quantity must be a positive integer',
    ],
    [
      {
        transactionType: 'INCOMING',
        items: [
          { product: 'Widget', quantity: 1, price: Number.POSITIVE_INFINITY },
        ],
      },
      'price must be a finite non-negative number',
    ],
    [
      { transactionType: 'INCOMING', date: 'not-a-date', items: [] },
      'date must be a valid date',
    ],
  ] as const)(
    'rejects malformed extracted data and cleans up the object',
    async (extracted, expectedMessage) => {
      const tx = createMockTx();
      const { service, extract, deleteObject, prismaRoot } = buildService(tx);
      extract.mockResolvedValue(extracted as never);

      await expect(service.upload(VALID_UPLOAD_INPUT)).rejects.toThrow(
        expectedMessage,
      );
      expect(deleteObject).toHaveBeenCalledWith('documents/doc-1.pdf');
      expect(prismaRoot.pendingDocumentReview.create).not.toHaveBeenCalled();
    },
  );
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

  it('creates a brand-new product atomically for an INCOMING newProduct line, then uses its real id in createIncoming()', async () => {
    const tx = createMockTx();
    const { service, createIncoming } = buildService(tx);
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
    tx.product.findFirst.mockResolvedValue(null);
    tx.product.create.mockResolvedValue({ id: 777, name: 'USB-C Hub', category: 'Accessories' });

    const input: ApproveDocumentReviewInput = {
      reviewedById: 9,
      supplierId: 1,
      destinationWarehouseId: 10,
      items: [
        { productId: 100, quantity: 5, price: 10 },
        { newProduct: { name: 'USB-C Hub', category: 'Accessories' }, quantity: 3, price: 15 },
      ],
    };

    await service.approve(1, input);

    expect(tx.product.findFirst).toHaveBeenCalledWith({
      where: { name: { equals: 'USB-C Hub', mode: 'insensitive' }, isActive: true },
      select: { id: true },
    });
    expect(tx.product.create).toHaveBeenCalledWith({
      data: { name: 'USB-C Hub', category: 'Accessories', isActive: true },
    });
    expect(createIncoming).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          { productId: 100, quantity: 5, price: 10 },
          { productId: 777, quantity: 3, price: 15 },
        ],
      }),
      tx,
    );
  });

  it('trims the new-product name/category and stores a null category when none was given', async () => {
    const tx = createMockTx();
    const { service, createIncoming } = buildService(tx);
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
    tx.product.findFirst.mockResolvedValue(null);
    tx.product.create.mockResolvedValue({ id: 778, name: 'Desk Lamp', category: null });

    await service.approve(1, {
      reviewedById: 9,
      supplierId: 1,
      destinationWarehouseId: 10,
      items: [{ newProduct: { name: '  Desk Lamp  ' }, quantity: 1, price: 20 }],
    });

    expect(tx.product.create).toHaveBeenCalledWith({
      data: { name: 'Desk Lamp', category: null, isActive: true },
    });
    expect(createIncoming).toHaveBeenCalledWith(
      expect.objectContaining({ items: [{ productId: 778, quantity: 1, price: 20 }] }),
      tx,
    );
  });

  it('rejects an INCOMING newProduct whose name exactly (case-insensitively) matches an already-active product, and never creates it', async () => {
    const tx = createMockTx();
    const { service, createIncoming } = buildService(tx);
    tx.pendingDocumentReview.updateMany.mockResolvedValue({ count: 1 });
    tx.pendingDocumentReview.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      transactionType: 'INCOMING',
      documentUrl: 'https://s3.example.com/doc-1.pdf',
    });
    tx.product.findFirst.mockResolvedValue({ id: 42 });

    await expect(
      service.approve(1, {
        reviewedById: 9,
        supplierId: 1,
        destinationWarehouseId: 10,
        items: [{ newProduct: { name: 'usb-c hub' }, quantity: 1 }],
      }),
    ).rejects.toThrow('A product named "usb-c hub" already exists');

    expect(tx.product.create).not.toHaveBeenCalled();
    expect(createIncoming).not.toHaveBeenCalled();
    expect(tx.pendingDocumentReview.update).not.toHaveBeenCalled();
  });

  it('rejects two lines in the same approval defining the same new product name, and never creates either', async () => {
    const tx = createMockTx();
    const { service, createIncoming } = buildService(tx);
    tx.pendingDocumentReview.updateMany.mockResolvedValue({ count: 1 });
    tx.pendingDocumentReview.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      transactionType: 'INCOMING',
      documentUrl: 'https://s3.example.com/doc-1.pdf',
    });
    tx.product.findFirst.mockResolvedValue(null);
    tx.product.create.mockResolvedValue({ id: 777, name: 'USB-C Hub' });

    await expect(
      service.approve(1, {
        reviewedById: 9,
        supplierId: 1,
        destinationWarehouseId: 10,
        items: [
          { newProduct: { name: 'USB-C Hub' }, quantity: 1 },
          { newProduct: { name: 'usb-c hub' }, quantity: 2 },
        ],
      }),
    ).rejects.toThrow('"usb-c hub" is defined as a new product on more than one line in this approval');

    expect(createIncoming).not.toHaveBeenCalled();
    expect(tx.pendingDocumentReview.update).not.toHaveBeenCalled();
  });

  it('rejects an INCOMING line with neither an existing product nor a new-product definition', async () => {
    const tx = createMockTx();
    const { service, createIncoming } = buildService(tx);
    tx.pendingDocumentReview.updateMany.mockResolvedValue({ count: 1 });
    tx.pendingDocumentReview.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      transactionType: 'INCOMING',
      documentUrl: 'https://s3.example.com/doc-1.pdf',
    });

    await expect(
      service.approve(1, {
        reviewedById: 9,
        supplierId: 1,
        destinationWarehouseId: 10,
        items: [{ quantity: 1 }],
      }),
    ).rejects.toThrow('Every line item must reference an existing product or define a new one');

    expect(createIncoming).not.toHaveBeenCalled();
  });

  it('rejects an INCOMING newProduct with a blank/whitespace-only name', async () => {
    const tx = createMockTx();
    const { service, createIncoming } = buildService(tx);
    tx.pendingDocumentReview.updateMany.mockResolvedValue({ count: 1 });
    tx.pendingDocumentReview.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      transactionType: 'INCOMING',
      documentUrl: 'https://s3.example.com/doc-1.pdf',
    });

    await expect(
      service.approve(1, {
        reviewedById: 9,
        supplierId: 1,
        destinationWarehouseId: 10,
        items: [{ newProduct: { name: '   ' }, quantity: 1 }],
      }),
    ).rejects.toThrow('Every line item must reference an existing product or define a new one');

    expect(createIncoming).not.toHaveBeenCalled();
    expect(tx.product.create).not.toHaveBeenCalled();
  });

  it('rejects an OUTGOING line with no productId even if a newProduct definition was supplied — no create-path for a non-INCOMING review', async () => {
    const tx = createMockTx();
    const { service, createOutgoing } = buildService(tx);
    tx.pendingDocumentReview.updateMany.mockResolvedValue({ count: 1 });
    tx.pendingDocumentReview.findUniqueOrThrow.mockResolvedValue({
      id: 2,
      transactionType: 'OUTGOING',
      documentUrl: 'https://s3.example.com/doc-2.pdf',
    });

    await expect(
      service.approve(2, {
        reviewedById: 9,
        sourceWarehouseId: 10,
        items: [{ newProduct: { name: 'Ghost Product' }, quantity: 1 }],
      }),
    ).rejects.toThrow(
      'Every line item must reference an existing product for a non-INCOMING review',
    );

    expect(tx.product.create).not.toHaveBeenCalled();
    expect(createOutgoing).not.toHaveBeenCalled();
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

describe('DocumentReviewService.getDocumentPresignedUrl', () => {
  it("looks up the review's stored documentKey and asks the storage provider for a fresh presigned URL", async () => {
    const tx = createMockTx();
    const { service, prismaRoot, getPresignedUrl } = buildService(tx);
    prismaRoot.pendingDocumentReview.findUnique.mockResolvedValue({
      documentKey: 'documents/doc-1.pdf',
    });
    getPresignedUrl.mockResolvedValue(
      'https://s3.example.com/doc-1.pdf?X-Amz-Signature=fresh',
    );

    const result = await service.getDocumentPresignedUrl(1);

    expect(prismaRoot.pendingDocumentReview.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { documentKey: true },
    });
    expect(getPresignedUrl).toHaveBeenCalledWith('documents/doc-1.pdf');
    expect(result).toEqual({
      url: 'https://s3.example.com/doc-1.pdf?X-Amz-Signature=fresh',
    });
  });

  it('throws NotFoundException when the review does not exist', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, getPresignedUrl } = buildService(tx);
    prismaRoot.pendingDocumentReview.findUnique.mockResolvedValue(null);

    await expect(service.getDocumentPresignedUrl(999)).rejects.toThrow(
      'PendingDocumentReview 999 not found',
    );
    expect(getPresignedUrl).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the review has no stored documentKey (e.g. a pre-existing/seeded row)', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, getPresignedUrl } = buildService(tx);
    prismaRoot.pendingDocumentReview.findUnique.mockResolvedValue({
      documentKey: null,
    });

    await expect(service.getDocumentPresignedUrl(1)).rejects.toThrow(
      'PendingDocumentReview 1 has no stored S3 object key',
    );
    expect(getPresignedUrl).not.toHaveBeenCalled();
  });

  it('propagates a storage-provider failure (e.g. S3/presigned-URL generation error)', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, getPresignedUrl } = buildService(tx);
    prismaRoot.pendingDocumentReview.findUnique.mockResolvedValue({
      documentKey: 'documents/doc-1.pdf',
    });
    getPresignedUrl.mockRejectedValue(
      new Error(
        'Failed to generate a presigned URL for S3 object "documents/doc-1.pdf": SignatureError',
      ),
    );

    await expect(service.getDocumentPresignedUrl(1)).rejects.toThrow(
      'Failed to generate a presigned URL',
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

const HUMAN_BEARER_TOKEN = 'human-reviewer-token';
const ERP_USER_ID = 7;

describe('DocumentReviewService.resolveProduct (fuzzy fallback path — matchProduct rejects by default, see buildService())', () => {
  it('ranks an exact case-insensitive match above a partial match', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([
      { id: 1, name: 'Widget Pro' },
      { id: 2, name: 'widget' },
    ]);

    const result = await service.resolveProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Widget');

    expect(prismaRoot.product.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
    });
    expect(result.status).toBe('RESOLVED');
    expect(result.candidates).toEqual([
      { id: 2, name: 'widget', confidence: 1, reason: expect.any(String) },
    ]);
    expect(result.recommendation).toBeNull();
  });

  it('scores a conflicting spec number well below a real match, even with heavy word overlap', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([
      { id: 1, name: '22-inch Monitor' },
      { id: 2, name: '24-inch Monitor' },
    ]);

    const result = await service.resolveProduct(
      HUMAN_BEARER_TOKEN,
      ERP_USER_ID,
      '24-inch Monitor',
    );

    expect(result.status).toBe('RESOLVED');
    expect(result.candidates).toEqual([
      { id: 2, name: '24-inch Monitor', confidence: 1, reason: expect.any(String) },
    ]);
  });

  it('drops candidates below the minimum suggestion score as noise', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([
      { id: 1, name: 'Laptop Pro 14' },
      { id: 2, name: 'Office Chair' },
    ]);

    const result = await service.resolveProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Laptop Pro 14');

    expect(result.candidates.map((c) => c.id)).toEqual([1]);
  });

  it('caps fuzzy UNRESOLVED candidates at 3, same as the AI path', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([
      { id: 1, name: 'Laptop Pro' },
      { id: 2, name: 'Laptop Air' },
      { id: 3, name: 'Laptop Max' },
      { id: 4, name: 'Laptop Mini' },
    ]);

    const result = await service.resolveProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Laptop');

    expect(result.status).toBe('UNRESOLVED');
    expect(result.candidates.length).toBeLessThanOrEqual(3);
  });

  it('rejects an empty query without touching the database', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);

    await expect(
      service.resolveProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, '   '),
    ).rejects.toThrow('query must not be empty');
    expect(prismaRoot.product.findMany).not.toHaveBeenCalled();
  });

  it('returns NO_MATCH with a minimal, honest recommendation when nothing matches', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([]);

    const result = await service.resolveProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Nonexistent');

    expect(result).toEqual({
      status: 'NO_MATCH',
      candidates: [],
      recommendation: { normalizedName: 'Nonexistent', category: null, description: null },
    });
  });
});

describe('DocumentReviewService.resolveSupplier (fuzzy fallback path)', () => {
  it('ranks an exact case-insensitive match above a partial match', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.supplier.findMany.mockResolvedValue([
      { id: 1, name: 'Acme Supplies Co.' },
      { id: 2, name: 'acme supplies' },
    ]);

    const result = await service.resolveSupplier(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Acme Supplies');

    expect(prismaRoot.supplier.findMany).toHaveBeenCalledWith({
      where: { isActive: true },
    });
    expect(result.status).toBe('RESOLVED');
    expect(result.candidates).toEqual([
      { id: 2, name: 'acme supplies', confidence: 1, reason: expect.any(String) },
    ]);
    expect(result.recommendation).toBeNull();
  });

  it('rejects an empty query without touching the database', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);

    await expect(
      service.resolveSupplier(HUMAN_BEARER_TOKEN, ERP_USER_ID, ''),
    ).rejects.toThrow('query must not be empty');
    expect(prismaRoot.supplier.findMany).not.toHaveBeenCalled();
  });

  it('returns NO_MATCH with no recommendation (suppliers never get one) when nothing matches', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.supplier.findMany.mockResolvedValue([]);

    const result = await service.resolveSupplier(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Nonexistent');

    expect(result).toEqual({ status: 'NO_MATCH', candidates: [], recommendation: null });
  });
});

describe('DocumentReviewService semantic-match integration (Document agent path via DocumentSemanticMatchProvider)', () => {
  const aiSuccess = (
    status: 'RESOLVED' | 'UNRESOLVED' | 'NO_MATCH',
    candidates: { id: number; name: string; confidence: number; reason: string }[],
    recommendation: { normalizedName: string; category: string | null; description: string | null } | null = null,
  ) => ({ status, candidates, recommendation });

  it('resolveProduct uses the Document agent result when it succeeds, forwarding auth + real category AND description', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchProduct } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([
      {
        id: 1,
        name: 'Laptop Pro 14',
        category: 'Electronics',
        description: '14-inch business laptop',
      },
      { id: 2, name: 'Wireless Mouse', category: 'Electronics', description: null },
    ]);
    matchProduct.mockResolvedValue(
      aiSuccess('RESOLVED', [
        { id: 2, name: 'Wireless Mouse', confidence: 0.91, reason: 'Same product, reworded.' },
      ]),
    );

    const result = await service.resolveProduct(
      HUMAN_BEARER_TOKEN,
      ERP_USER_ID,
      'Compact Rodent Pointer',
    );

    expect(matchProduct).toHaveBeenCalledWith(
      HUMAN_BEARER_TOKEN,
      ERP_USER_ID,
      'Compact Rodent Pointer',
      [
        {
          id: 1,
          name: 'Laptop Pro 14',
          category: 'Electronics',
          description: '14-inch business laptop',
        },
        { id: 2, name: 'Wireless Mouse', category: 'Electronics', description: null },
      ],
    );
    expect(result).toEqual({
      status: 'RESOLVED',
      candidates: [
        { id: 2, name: 'Wireless Mouse', confidence: 0.91, reason: 'Same product, reworded.' },
      ],
      recommendation: null,
    });
  });

  it('resolveProduct falls back to the fuzzy matcher when the Document agent call throws (network error, timeout, misconfiguration)', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchProduct } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([
      { id: 1, name: 'Laptop Pro 14', category: null, description: null },
    ]);
    matchProduct.mockRejectedValue(new Error('AgentCore document_match request timed out'));

    const result = await service.resolveProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Laptop Pro 14');

    expect(matchProduct).toHaveBeenCalled();
    // Same result the pure-fuzzy test above ("ranks an exact case-insensitive
    // match") produces - the fallback path is byte-for-byte the original code.
    expect(result.status).toBe('RESOLVED');
    expect(result.candidates[0].id).toBe(1);
  });

  it('resolveProduct returns a NO_MATCH result with the Document agent recommendation as-is', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchProduct } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([
      { id: 1, name: 'Laptop Pro 14', category: 'Electronics', description: null },
    ]);
    matchProduct.mockResolvedValue(
      aiSuccess('NO_MATCH', [], { normalizedName: 'Standing Desk Lamp', category: 'Electronics', description: null }),
    );

    const result = await service.resolveProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Standing Desk Lamp');

    expect(result).toEqual({
      status: 'NO_MATCH',
      candidates: [],
      recommendation: { normalizedName: 'Standing Desk Lamp', category: 'Electronics', description: null },
    });
  });

  it('resolveSupplier uses the Document agent result when it succeeds, forwarding real email/leadTimeDays metadata', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchSupplier } = buildService(tx);
    prismaRoot.supplier.findMany.mockResolvedValue([
      {
        id: 41,
        name: 'TechSource Lebanon',
        email: 'sales@techsource.example',
        leadTimeDays: 7,
      },
    ]);
    matchSupplier.mockResolvedValue(
      aiSuccess('RESOLVED', [
        { id: 41, name: 'TechSource Lebanon', confidence: 0.91, reason: 'Matches despite extra wording.' },
      ]),
    );

    const result = await service.resolveSupplier(
      HUMAN_BEARER_TOKEN,
      ERP_USER_ID,
      'Tech Source Lebanon Ltd',
    );

    expect(matchSupplier).toHaveBeenCalledWith(
      HUMAN_BEARER_TOKEN,
      ERP_USER_ID,
      'Tech Source Lebanon Ltd',
      [{ id: 41, name: 'TechSource Lebanon', email: 'sales@techsource.example', leadTimeDays: 7 }],
    );
    expect(result.status).toBe('RESOLVED');
    expect(result.candidates[0].id).toBe(41);
  });

  it('resolveSupplier falls back to the fuzzy matcher when the Document agent call throws', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchSupplier } = buildService(tx);
    prismaRoot.supplier.findMany.mockResolvedValue([
      { id: 1, name: 'Acme Supplies Co.' },
      { id: 2, name: 'acme supplies' },
    ]);
    matchSupplier.mockRejectedValue(new Error('HTTP 503'));

    const result = await service.resolveSupplier(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Acme Supplies');

    expect(result.status).toBe('RESOLVED');
    expect(result.candidates[0].id).toBe(2);
  });

  // --- Backend-side re-validation (point 4): every violation below must
  // fall back to the fuzzy matcher, never reach the reviewer unvalidated. ---

  it('rejects an invented id and falls back to the fuzzy matcher', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchProduct } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([
      { id: 1, name: 'Laptop Pro 14', category: null, description: null },
    ]);
    matchProduct.mockResolvedValue(
      aiSuccess('RESOLVED', [{ id: 99999, name: 'Made Up', confidence: 0.9, reason: 'r' }]),
    );

    const result = await service.resolveProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Laptop Pro 14');

    // Falls back to fuzzy - the invented id never reaches the reviewer.
    expect(result.candidates.every((c) => c.id === 1)).toBe(true);
  });

  it('rejects a candidate whose name does not match the real name for its id', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchProduct } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([
      { id: 1, name: 'Laptop Pro 14', category: null, description: null },
      { id: 2, name: 'Wireless Mouse', category: null, description: null },
    ]);
    // Real id (1) but a name that belongs to a DIFFERENT real candidate (2).
    matchProduct.mockResolvedValue(
      aiSuccess('RESOLVED', [{ id: 1, name: 'Wireless Mouse', confidence: 0.9, reason: 'r' }]),
    );

    const result = await service.resolveProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Laptop Pro 14');

    // Falls back to fuzzy, not the mismatched AI result.
    expect(result.candidates.every((c) => c.name !== 'Wireless Mouse' || c.id !== 1)).toBe(true);
  });

  it('rejects more than 3 candidates and falls back to the fuzzy matcher', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchProduct } = buildService(tx);
    const products = [1, 2, 3, 4].map((id) => ({ id, name: `Product ${id}`, category: null, description: null }));
    prismaRoot.product.findMany.mockResolvedValue(products);
    matchProduct.mockResolvedValue(
      aiSuccess(
        'UNRESOLVED',
        products.map((p) => ({ id: p.id, name: p.name, confidence: 0.5, reason: 'r' })),
      ),
    );

    const result = await service.resolveProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Product');

    expect(result.candidates.length).toBeLessThanOrEqual(3);
    // Confirms the fuzzy path answered, not the 4-candidate AI result.
    expect(result.candidates.every((c) => c.reason.includes('AI-based matching was unavailable'))).toBe(true);
  });

  it('rejects duplicate candidate ids and falls back to the fuzzy matcher', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchProduct } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([
      { id: 1, name: 'Laptop Pro 14', category: null, description: null },
    ]);
    matchProduct.mockResolvedValue(
      aiSuccess('UNRESOLVED', [
        { id: 1, name: 'Laptop Pro 14', confidence: 0.7, reason: 'r' },
        { id: 1, name: 'Laptop Pro 14', confidence: 0.6, reason: 'r2' },
      ]),
    );

    const result = await service.resolveProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Laptop Pro 14');

    expect(result.candidates.every((c) => c.reason.includes('AI-based matching was unavailable'))).toBe(true);
  });

  it('rejects an empty candidate reason and falls back to the fuzzy matcher', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchProduct } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([
      { id: 1, name: 'Laptop Pro 14', category: 'Electronics', description: null },
    ]);
    matchProduct.mockResolvedValue(
      aiSuccess('RESOLVED', [
        { id: 1, name: 'Laptop Pro 14', confidence: 0.95, reason: '   ' },
      ]),
    );

    const result = await service.resolveProduct(
      HUMAN_BEARER_TOKEN,
      ERP_USER_ID,
      'Laptop Pro 14',
    );

    expect(result.status).toBe('RESOLVED');
    expect(result.candidates[0].reason).toContain('AI-based matching was unavailable');
  });

  it('rejects product NO_MATCH without a recommendation and falls back to the fuzzy matcher', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchProduct } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([]);
    matchProduct.mockResolvedValue(aiSuccess('NO_MATCH', [], null));

    const result = await service.resolveProduct(
      HUMAN_BEARER_TOKEN,
      ERP_USER_ID,
      'Standing Desk Lamp',
    );

    expect(result).toEqual({
      status: 'NO_MATCH',
      candidates: [],
      recommendation: {
        normalizedName: 'Standing Desk Lamp',
        category: null,
        description: null,
      },
    });
  });

  it('rejects a product NO_MATCH recommendation with an empty normalized name', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchProduct } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([]);
    matchProduct.mockResolvedValue(
      aiSuccess('NO_MATCH', [], { normalizedName: '   ', category: null, description: null }),
    );

    const result = await service.resolveProduct(
      HUMAN_BEARER_TOKEN,
      ERP_USER_ID,
      'Standing Desk Lamp',
    );

    expect(result.recommendation?.normalizedName).toBe('Standing Desk Lamp');
  });

  it('rejects a category recommendation outside the real supplied categories', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchProduct } = buildService(tx);
    prismaRoot.product.findMany.mockResolvedValue([
      { id: 1, name: 'Laptop Pro 14', category: 'Electronics', description: null },
    ]);
    matchProduct.mockResolvedValue(
      aiSuccess('NO_MATCH', [], { normalizedName: 'X', category: 'Made Up Category', description: null }),
    );

    const result = await service.resolveProduct(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'X');

    // Falls back to fuzzy - the ungrounded category recommendation never reaches the reviewer.
    expect(result.recommendation?.category).not.toBe('Made Up Category');
  });

  it('rejects a supplier result carrying a recommendation and falls back to the fuzzy matcher', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, matchSupplier } = buildService(tx);
    prismaRoot.supplier.findMany.mockResolvedValue([
      { id: 41, name: 'TechSource Lebanon' },
    ]);
    matchSupplier.mockResolvedValue(
      aiSuccess('NO_MATCH', [], { normalizedName: 'New Supplier', category: null, description: null }),
    );

    const result = await service.resolveSupplier(HUMAN_BEARER_TOKEN, ERP_USER_ID, 'Totally Unrelated');

    // Suppliers never carry a recommendation - the fuzzy fallback confirms this.
    expect(result.recommendation).toBeNull();
  });
});
