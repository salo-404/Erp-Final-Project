/// <reference types="jest" />

import {
  AnalyzeExpenseCommand,
  AnalyzeExpenseCommandOutput,
  ExpenseDocument,
  ExpenseField,
  TextractClient,
} from '@aws-sdk/client-textract';
import { InventoryTransactionType } from '../../generated/prisma/client';
import * as documentReviewService from './document-review.service';
import { TextractDocumentExtractionProvider } from './textract-document-extraction.provider';

const marker = (value: string, label = 'Transaction Type'): ExpenseField => ({
  LabelDetection: { Text: label },
  ValueDetection: { Text: value },
});

const field = (
  type: string,
  value: string,
  groups: string[] = [],
): ExpenseField => ({
  Type: { Text: type },
  ValueDetection: { Text: value },
  ...(groups.length
    ? { GroupProperties: [{ Types: groups, Id: 'group-1' }] }
    : {}),
});

const output = (document: ExpenseDocument): AnalyzeExpenseCommandOutput => ({
  ExpenseDocuments: [document],
  $metadata: {},
});

describe('TextractDocumentExtractionProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AWS_REGION = 'eu-west-1';
    process.env.AWS_S3_BUCKET = 'private-invoices';
    delete process.env.TEXTRACT_TIMEOUT_MS;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  const mockDocument = (document: ExpenseDocument) =>
    jest
      .spyOn(TextractClient.prototype, 'send')
      .mockResolvedValue(output(document) as never);

  const extract = (document: ExpenseDocument) => {
    mockDocument(document);
    return new TextractDocumentExtractionProvider().extract({
      mimeType: 'application/pdf',
      documentKey: 'documents/invoice.pdf',
    });
  };

  it('requires AWS_REGION', () => {
    delete process.env.AWS_REGION;
    expect(() => new TextractDocumentExtractionProvider()).toThrow(
      'AWS_REGION is not configured',
    );
  });

  it('requires AWS_S3_BUCKET', () => {
    delete process.env.AWS_S3_BUCKET;
    expect(() => new TextractDocumentExtractionProvider()).toThrow(
      'AWS_S3_BUCKET is not configured',
    );
  });

  it.each([undefined, '', 'invalid', '0', '-5'])(
    'defaults a missing/invalid timeout (%s) to 30000 ms',
    async (configured) => {
      if (configured === undefined) delete process.env.TEXTRACT_TIMEOUT_MS;
      else process.env.TEXTRACT_TIMEOUT_MS = configured;
      const timeoutSpy = jest
        .spyOn(AbortSignal, 'timeout')
        .mockReturnValue(new AbortController().signal);
      mockDocument({ SummaryFields: [marker('INCOMING')] });

      await new TextractDocumentExtractionProvider().extract({
        mimeType: 'application/pdf',
        documentKey: 'documents/invoice.pdf',
      });

      expect(timeoutSpy).toHaveBeenCalledWith(30000);
    },
  );

  it('honors a valid configured timeout', async () => {
    process.env.TEXTRACT_TIMEOUT_MS = '1250';
    const timeoutSpy = jest
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(new AbortController().signal);
    mockDocument({ SummaryFields: [marker('INCOMING')] });

    await new TextractDocumentExtractionProvider().extract({
      mimeType: 'image/png',
      documentKey: 'documents/invoice.png',
    });

    expect(timeoutSpy).toHaveBeenCalledWith(1250);
  });

  it('sends AnalyzeExpense the configured private S3 object only', async () => {
    const send = mockDocument({ SummaryFields: [marker('INCOMING')] });
    const fetchSpy = jest.spyOn(global, 'fetch');

    await new TextractDocumentExtractionProvider().extract({
      mimeType: 'application/pdf',
      documentKey: 'documents/invoice.pdf',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as unknown as AnalyzeExpenseCommand;
    expect(command.input).toEqual({
      Document: {
        S3Object: {
          Bucket: 'private-invoices',
          Name: 'documents/invoice.pdf',
        },
      },
    });
    expect(command.input.Document).not.toHaveProperty('Bytes');
    expect(command.input).not.toHaveProperty('documentUrl');
    expect(command.input).not.toHaveProperty('content');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['INCOMING', InventoryTransactionType.INCOMING],
    ['OUTGOING', InventoryTransactionType.OUTGOING],
    ['  incoming : ', InventoryTransactionType.INCOMING],
  ])(
    'maps the explicit SummaryField marker %s strictly',
    async (value, expected) => {
      await expect(
        extract({ SummaryFields: [marker(value, '  Transaction Type:  ')] }),
      ).resolves.toEqual(
        expect.objectContaining({ transactionType: expected }),
      );
    },
  );

  it('uses only the tightly controlled LINE marker as fallback', async () => {
    await expect(
      extract({
        Blocks: [{ BlockType: 'LINE', Text: ' Transaction Type: INCOMING ' }],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        transactionType: InventoryTransactionType.INCOMING,
      }),
    );
  });

  it.each([
    [
      { Blocks: [{ BlockType: 'LINE', Text: 'Incoming delivery' }] },
      'could not find',
    ],
    [{ SummaryFields: [] }, 'could not find'],
    [{ SummaryFields: [marker('TRANSFER')] }, 'invalid explicit'],
    [
      {
        SummaryFields: [marker('INCOMING')],
        Blocks: [{ BlockType: 'LINE', Text: 'Transaction Type: OUTGOING' }],
      },
      'conflicting',
    ],
  ] as const)(
    'fails safely for invalid/absent/conflicting markers',
    async (document, message) => {
      await expect(extract(document as ExpenseDocument)).rejects.toThrow(
        message,
      );
    },
  );

  it('maps normalized and grouped supplier/receiver names without reversing them', async () => {
    const incoming = await extract({
      SummaryFields: [
        marker('INCOMING'),
        field('VENDOR_NAME', 'Normalized Supplier'),
        field('RECEIVER_NAME', 'Wrong Incoming Party'),
      ],
    });
    expect(incoming.supplierName).toBe('Normalized Supplier');
    expect(incoming.partyName).toBeUndefined();

    jest.restoreAllMocks();
    const outgoing = await extract({
      SummaryFields: [
        marker('OUTGOING'),
        field('NAME', 'Ship-To Customer', ['RECEIVER_SHIP_TO']),
        field('NAME', 'Vendor', ['VENDOR_SUPPLIER']),
      ],
    });
    expect(outgoing.partyName).toBe('Ship-To Customer');
    expect(outgoing.supplierName).toBeUndefined();
  });

  it('uses a grouped vendor NAME when VENDOR_NAME is absent', async () => {
    const result = await extract({
      SummaryFields: [
        marker('INCOMING'),
        field('NAME', 'Grouped Supplier', ['VENDOR_SUPPLIER']),
        field('NAME', 'Remit Recipient', ['VENDOR_REMIT_TO']),
      ],
    });
    expect(result.supplierName).toBe('Grouped Supplier');
  });

  it('maps preferred/fallback dates and safely omits malformed optional dates', async () => {
    const preferred = await extract({
      SummaryFields: [
        marker('INCOMING'),
        field('ORDER_DATE', '2026-02-01'),
        field('INVOICE_RECEIPT_DATE', '2026-01-15'),
      ],
    });
    expect(preferred.date).toEqual(new Date('2026-01-15'));

    jest.restoreAllMocks();
    const malformed = await extract({
      SummaryFields: [
        marker('INCOMING'),
        field('INVOICE_RECEIPT_DATE', 'nope'),
      ],
    });
    expect(malformed.date).toBeUndefined();
  });

  it('maps only explicit warehouse labels and receiver-group delivery fields', async () => {
    const result = await extract({
      SummaryFields: [
        marker('OUTGOING'),
        {
          LabelDetection: { Text: 'Destination Warehouse:' },
          ValueDetection: { Text: 'Main Warehouse' },
        },
        field('ADDRESS', '12 Harbor Road', ['RECEIVER_SHIP_TO']),
        field('COUNTRY', 'Lebanon', ['RECEIVER_SHIP_TO']),
        field('STATE', 'Beirut', ['RECEIVER_SHIP_TO']),
      ],
    });
    expect(result).toEqual(
      expect.objectContaining({
        warehouseName: 'Main Warehouse',
        deliveryAddress: '12 Harbor Road',
        deliveryCountry: 'Lebanon',
        deliveryRegion: 'Beirut',
      }),
    );
  });

  it('prefers RECEIVER_ADDRESS over receiver-grouped address fields', async () => {
    const result = await extract({
      SummaryFields: [
        marker('OUTGOING'),
        field('RECEIVER_ADDRESS', 'Preferred Receiver Address'),
        field('ADDRESS_BLOCK', 'Grouped Address Block', ['RECEIVER_SHIP_TO']),
        field('ADDRESS', 'Grouped Address', ['RECEIVER_SHIP_TO']),
      ],
    });
    expect(result.deliveryAddress).toBe('Preferred Receiver Address');
  });

  it('falls back to receiver-grouped ADDRESS_BLOCK before ADDRESS', async () => {
    const result = await extract({
      SummaryFields: [
        marker('OUTGOING'),
        field('ADDRESS_BLOCK', 'Grouped Address Block', ['RECEIVER_SHIP_TO']),
        field('ADDRESS', 'Grouped Address', ['RECEIVER_SHIP_TO']),
      ],
    });
    expect(result.deliveryAddress).toBe('Grouped Address Block');
  });

  it('falls back to receiver-grouped ADDRESS', async () => {
    const result = await extract({
      SummaryFields: [
        marker('OUTGOING'),
        field('ADDRESS', 'Grouped Address', ['RECEIVER_BILL_TO']),
      ],
    });
    expect(result.deliveryAddress).toBe('Grouped Address');
  });

  it('does not use a vendor address as outgoing deliveryAddress', async () => {
    const result = await extract({
      SummaryFields: [
        marker('OUTGOING'),
        field('ADDRESS_BLOCK', 'Vendor Address', ['VENDOR_SUPPLIER']),
        field('ADDRESS', 'Vendor Remit Address', ['VENDOR_REMIT_TO']),
      ],
    });
    expect(result.deliveryAddress).toBeUndefined();
  });

  it('maps ITEM and quantity while valid UNIT_PRICE wins over PRICE', async () => {
    const result = await extract({
      SummaryFields: [marker('INCOMING')],
      LineItemGroups: [
        {
          LineItems: [
            {
              LineItemExpenseFields: [
                field('ITEM', 'USB-C Docking Station'),
                field('QUANTITY', '5'),
                field('UNIT_PRICE', '$80.00'),
                field('PRICE', '999.00'),
              ],
            },
            {
              LineItemExpenseFields: [
                field('ITEM', 'Cable'),
                field('QUANTITY', '5.0'),
                field('UNIT_PRICE', 'USD 1,250.50'),
              ],
            },
          ],
        },
      ],
    });

    expect(result.items).toEqual([
      { product: 'USB-C Docking Station', quantity: 5, price: 80 },
      { product: 'Cable', quantity: 5, price: 1250.5 },
    ]);
  });

  it('derives unit price from PRICE line total when UNIT_PRICE is absent', async () => {
    const result = await extract({
      SummaryFields: [marker('INCOMING')],
      LineItemGroups: [
        {
          LineItems: [
            {
              LineItemExpenseFields: [
                field('ITEM', 'Five Units'),
                field('QUANTITY', '5'),
                field('PRICE', '$400.00'),
              ],
            },
            {
              LineItemExpenseFields: [
                field('ITEM', 'Single Unit'),
                field('QUANTITY', '1'),
                field('PRICE', '$25.00'),
              ],
            },
            {
              LineItemExpenseFields: [
                field('ITEM', 'Fractional Unit Price'),
                field('QUANTITY', '4'),
                field('PRICE', 'USD 10.00'),
              ],
            },
          ],
        },
      ],
    });
    expect(result.items).toEqual([
      { product: 'Five Units', quantity: 5, price: 80 },
      { product: 'Single Unit', quantity: 1, price: 25 },
      { product: 'Fractional Unit Price', quantity: 4, price: 2.5 },
    ]);
  });

  it.each(['2.7', '0', '-1', ''])(
    'omits a line with invalid quantity %s',
    async (quantity) => {
      const result = await extract({
        SummaryFields: [marker('INCOMING')],
        LineItemGroups: [
          {
            LineItems: [
              {
                LineItemExpenseFields: [
                  field('ITEM', 'Widget'),
                  ...(quantity ? [field('QUANTITY', quantity)] : []),
                ],
              },
            ],
          },
        ],
      });
      expect(result.items).toEqual([]);
    },
  );

  it('omits invalid prices and never falls back from an invalid present UNIT_PRICE', async () => {
    const result = await extract({
      SummaryFields: [marker('INCOMING')],
      LineItemGroups: [
        {
          LineItems: [
            {
              LineItemExpenseFields: [
                field('ITEM', 'No Price'),
                field('QUANTITY', '1'),
              ],
            },
            {
              LineItemExpenseFields: [
                field('ITEM', 'Invalid Price'),
                field('QUANTITY', '2'),
                field('UNIT_PRICE', '-5'),
                field('PRICE', '20'),
              ],
            },
            {
              LineItemExpenseFields: [
                field('ITEM', 'Zero Price'),
                field('QUANTITY', '3'),
                field('UNIT_PRICE', '0'),
              ],
            },
            {
              LineItemExpenseFields: [
                field('ITEM', 'Infinite Price'),
                field('QUANTITY', '4'),
                field('UNIT_PRICE', 'Infinity'),
              ],
            },
            {
              LineItemExpenseFields: [
                field('ITEM', 'Invalid Total Price'),
                field('QUANTITY', '5'),
                field('PRICE', 'not a price'),
              ],
            },
          ],
        },
      ],
    });
    expect(result.items).toEqual([
      { product: 'No Price', quantity: 1 },
      { product: 'Invalid Price', quantity: 2 },
      { product: 'Zero Price', quantity: 3, price: 0 },
      { product: 'Infinite Price', quantity: 4 },
      { product: 'Invalid Total Price', quantity: 5 },
    ]);
  });

  it.each([
    [undefined, 'no expense document'],
    [[], 'no expense document'],
    [
      [
        { SummaryFields: [marker('INCOMING')] },
        { SummaryFields: [marker('OUTGOING')] },
      ],
      'multiple expense documents',
    ],
  ] as const)(
    'fails cleanly for invalid ExpenseDocuments cardinality',
    async (documents, message) => {
      jest.spyOn(TextractClient.prototype, 'send').mockResolvedValue({
        ExpenseDocuments: documents,
        $metadata: {},
      } as never);
      await expect(
        new TextractDocumentExtractionProvider().extract({
          mimeType: 'application/pdf',
          documentKey: 'documents/invoice.pdf',
        }),
      ).rejects.toThrow(message);
    },
  );

  it('turns an SDK failure into a clean error without leaking SDK details', async () => {
    jest
      .spyOn(TextractClient.prototype, 'send')
      .mockRejectedValue(new Error('AccessDenied request signature secret'));
    await expect(
      new TextractDocumentExtractionProvider().extract({
        mimeType: 'application/pdf',
        documentKey: 'documents/invoice.pdf',
      }),
    ).rejects.toThrow('Textract extraction failed');
  });

  it('times out using the actual AbortSignal timeout reason', async () => {
    process.env.TEXTRACT_TIMEOUT_MS = '10';
    jest.spyOn(TextractClient.prototype, 'send').mockImplementation(
      ((_command: unknown, options?: { abortSignal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          const signal = options?.abortSignal;
          if (!signal) return reject(new Error('missing abort signal'));
          const rejectWithReason = () => reject(signal.reason);
          if (signal.aborted) rejectWithReason();
          else
            signal.addEventListener('abort', rejectWithReason, { once: true });
        })) as never,
    );

    await expect(
      new TextractDocumentExtractionProvider().extract({
        mimeType: 'application/pdf',
        documentKey: 'documents/invoice.pdf',
      }),
    ).rejects.toThrow('Textract extraction timed out after 10ms');
  });

  it('passes the deterministic mapped object through the existing validator', async () => {
    const validator = jest.spyOn(
      documentReviewService,
      'validateExtractedDocumentData',
    );
    await extract({ SummaryFields: [marker('INCOMING')] });
    expect(validator).toHaveBeenCalledTimes(1);
  });
});
