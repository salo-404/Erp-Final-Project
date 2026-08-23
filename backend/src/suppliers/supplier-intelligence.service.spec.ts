/// <reference types="jest" />

import { Prisma } from '../../generated/prisma/client';
import {
  SupplierSummary,
  SuppliersHistoryProvider,
  SupplierIntelligenceService,
  SupplierTransactionHistory,
} from './supplier-intelligence.service';

type Transaction = SupplierTransactionHistory['transactions'][number];

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    type: 'INCOMING',
    status: 'COMPLETED',
    sourceWarehouseId: null,
    destinationWarehouseId: 1,
    supplierId: 1,
    deliveryCountry: null,
    deliveryRegion: null,
    deliveryAddress: null,
    expectedDate: null,
    actualDate: null,
    partyName: null,
    documentUrl: null,
    documentKey: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    items: [],
    ...overrides,
  };
}

function makeItem(productId: number, price: number | null, quantity = 1) {
  return {
    id: Math.floor(Math.random() * 100000),
    transactionId: 1,
    productId,
    quantity,
    price: price === null ? null : new Prisma.Decimal(price),
    product: {
      id: productId,
      name: `Product ${productId}`,
      category: null,
      description: null,
      createdAt: new Date(),
    },
  } as Transaction['items'][number];
}

/** Single-supplier provider — used by the getSupplierStats() regression tests. */
function makeSingleSupplierProvider(
  transactions: Transaction[] | null,
): SuppliersHistoryProvider {
  return {
    getTransactionHistory: jest
      .fn()
      .mockResolvedValue(transactions === null ? null : { transactions }),
    findAll: jest.fn().mockResolvedValue([]),
  };
}

/** Multi-supplier provider — used by the compareSuppliers()/ranking tests. */
function makeMultiSupplierProvider(
  suppliers: {
    id: number;
    name: string;
    transactions: Transaction[] | null;
    isActive?: boolean;
  }[],
): SuppliersHistoryProvider {
  const summaries: SupplierSummary[] = suppliers.map((s) => ({
    id: s.id,
    name: s.name,
    isActive: s.isActive ?? true,
  }));
  const historyById = new Map(suppliers.map((s) => [s.id, s.transactions]));

  return {
    findAll: jest.fn().mockResolvedValue(summaries),
    getTransactionHistory: jest.fn((supplierId: number) => {
      const transactions = historyById.get(supplierId) ?? null;
      return Promise.resolve(
        transactions === null
          ? null
          : ({ transactions } as unknown as SupplierTransactionHistory),
      );
    }),
  };
}

describe('SupplierIntelligenceService.getSupplierStats', () => {
  it('handles a supplier with no transaction history safely', async () => {
    const service = new SupplierIntelligenceService(
      makeSingleSupplierProvider(null),
    );

    const stats = await service.getSupplierStats(99);

    expect(stats).toEqual({
      supplierId: 99,
      totalTransactions: 0,
      completedTransactions: 0,
      cancelledTransactions: 0,
      cancellationRate: 0,
      averagePrice: null,
      pricedItemCount: 0,
      onTimeDeliveryRate: null,
      evaluatedForOnTimeCount: 0,
      purchaseFrequency: 0,
      firstPurchaseDate: null,
      lastPurchaseDate: null,
    });
  });

  it('handles a supplier with transactions but no line items', async () => {
    const service = new SupplierIntelligenceService(
      makeSingleSupplierProvider([makeTransaction({ items: [] })]),
    );

    const stats = await service.getSupplierStats(1);

    expect(stats.totalTransactions).toBe(1);
    expect(stats.averagePrice).toBeNull();
    expect(stats.pricedItemCount).toBe(0);
  });

  it('computes cancellationRate from status counts', async () => {
    const service = new SupplierIntelligenceService(
      makeSingleSupplierProvider([
        makeTransaction({ id: 1, status: 'COMPLETED' }),
        makeTransaction({ id: 2, status: 'CANCELLED' }),
        makeTransaction({ id: 3, status: 'CANCELLED' }),
        makeTransaction({ id: 4, status: 'PENDING' }),
      ]),
    );

    const stats = await service.getSupplierStats(1);

    expect(stats.totalTransactions).toBe(4);
    expect(stats.completedTransactions).toBe(1);
    expect(stats.cancelledTransactions).toBe(2);
    expect(stats.cancellationRate).toBe(0.5);
  });

  it('computes averagePrice across items, ignoring null prices', async () => {
    const service = new SupplierIntelligenceService(
      makeSingleSupplierProvider([
        makeTransaction({
          id: 1,
          items: [makeItem(1, 10), makeItem(1, 20), makeItem(1, null)],
        }),
        makeTransaction({ id: 2, items: [makeItem(1, 30)] }),
      ]),
    );

    const stats = await service.getSupplierStats(1);

    // (10 + 20 + 30) / 3 priced items = 20, the null-priced item is excluded
    expect(stats.pricedItemCount).toBe(3);
    expect(stats.averagePrice).toBe(20);
  });

  it('computes onTimeDeliveryRate only from transactions with both dates set', async () => {
    const service = new SupplierIntelligenceService(
      makeSingleSupplierProvider([
        // on time: delivered before/at expected date
        makeTransaction({
          id: 1,
          expectedDate: new Date('2026-01-10T00:00:00Z'),
          actualDate: new Date('2026-01-09T00:00:00Z'),
        }),
        // late
        makeTransaction({
          id: 2,
          expectedDate: new Date('2026-01-10T00:00:00Z'),
          actualDate: new Date('2026-01-15T00:00:00Z'),
        }),
        // not evaluable: missing expectedDate
        makeTransaction({
          id: 3,
          expectedDate: null,
          actualDate: new Date('2026-01-09T00:00:00Z'),
        }),
        // not evaluable: missing actualDate (e.g. still PENDING)
        makeTransaction({
          id: 4,
          expectedDate: new Date('2026-01-10T00:00:00Z'),
          actualDate: null,
        }),
      ]),
    );

    const stats = await service.getSupplierStats(1);

    expect(stats.evaluatedForOnTimeCount).toBe(2);
    expect(stats.onTimeDeliveryRate).toBe(0.5);
  });

  it('returns null onTimeDeliveryRate when no transaction has both dates', async () => {
    const service = new SupplierIntelligenceService(
      makeSingleSupplierProvider([
        makeTransaction({ expectedDate: null, actualDate: null }),
      ]),
    );

    const stats = await service.getSupplierStats(1);

    expect(stats.evaluatedForOnTimeCount).toBe(0);
    expect(stats.onTimeDeliveryRate).toBeNull();
  });

  it('derives firstPurchaseDate and lastPurchaseDate from createdAt', async () => {
    const service = new SupplierIntelligenceService(
      makeSingleSupplierProvider([
        makeTransaction({ id: 1, createdAt: new Date('2026-03-01T00:00:00Z') }),
        makeTransaction({ id: 2, createdAt: new Date('2026-01-01T00:00:00Z') }),
        makeTransaction({ id: 3, createdAt: new Date('2026-02-01T00:00:00Z') }),
      ]),
    );

    const stats = await service.getSupplierStats(1);

    expect(stats.firstPurchaseDate).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(stats.lastPurchaseDate).toEqual(new Date('2026-03-01T00:00:00Z'));
  });

  it('computes purchaseFrequency as transactions per 30-day window', async () => {
    const service = new SupplierIntelligenceService(
      makeSingleSupplierProvider([
        makeTransaction({ id: 1, createdAt: new Date('2026-01-01T00:00:00Z') }),
        makeTransaction({ id: 2, createdAt: new Date('2026-01-31T00:00:00Z') }),
        makeTransaction({ id: 3, createdAt: new Date('2026-03-02T00:00:00Z') }),
      ]),
    );

    const stats = await service.getSupplierStats(1);

    // span = 60 days, 3 transactions -> (3 / 60) * 30 = 1.5 per 30-day window
    expect(stats.purchaseFrequency).toBeCloseTo(1.5);
  });

  it('does not divide by zero when all transactions share the same createdAt', async () => {
    const sameDate = new Date('2026-01-01T00:00:00Z');
    const service = new SupplierIntelligenceService(
      makeSingleSupplierProvider([
        makeTransaction({ id: 1, createdAt: sameDate }),
        makeTransaction({ id: 2, createdAt: sameDate }),
      ]),
    );

    const stats = await service.getSupplierStats(1);

    expect(Number.isFinite(stats.purchaseFrequency)).toBe(true);
  });
});

const PRODUCT_X = 10;
const PRODUCT_Y = 20;

describe('SupplierIntelligenceService.compareSuppliers', () => {
  it('includes suppliers that supplied the requested product', async () => {
    const provider = makeMultiSupplierProvider([
      {
        id: 1,
        name: 'Supplier A',
        transactions: [
          makeTransaction({ id: 1, items: [makeItem(PRODUCT_X, 50)] }),
        ],
      },
      {
        id: 2,
        name: 'Supplier B',
        transactions: [
          makeTransaction({ id: 2, items: [makeItem(PRODUCT_X, 60)] }),
        ],
      },
    ]);
    const service = new SupplierIntelligenceService(provider);

    const comparison = await service.compareSuppliers(PRODUCT_X);

    expect(comparison.map((c) => c.supplierId).sort()).toEqual([1, 2]);
    expect(comparison.map((c) => c.supplierName).sort()).toEqual([
      'Supplier A',
      'Supplier B',
    ]);
  });

  it('excludes an inactive supplier even if it supplied the requested product (cannot be selected for a new purchase)', async () => {
    const provider = makeMultiSupplierProvider([
      {
        id: 1,
        name: 'Supplier A',
        isActive: false,
        transactions: [
          makeTransaction({ id: 1, items: [makeItem(PRODUCT_X, 50)] }),
        ],
      },
      {
        id: 2,
        name: 'Supplier B',
        transactions: [
          makeTransaction({ id: 2, items: [makeItem(PRODUCT_X, 60)] }),
        ],
      },
    ]);
    const service = new SupplierIntelligenceService(provider);

    const comparison = await service.compareSuppliers(PRODUCT_X);

    expect(comparison.map((c) => c.supplierId)).toEqual([2]);
  });

  it('excludes a supplier that never supplied the requested product', async () => {
    const provider = makeMultiSupplierProvider([
      {
        id: 1,
        name: 'Supplier A',
        transactions: [
          makeTransaction({ id: 1, items: [makeItem(PRODUCT_X, 50)] }),
        ],
      },
      {
        id: 2,
        name: 'Supplier C (other product only)',
        transactions: [
          makeTransaction({ id: 2, items: [makeItem(PRODUCT_Y, 999)] }),
        ],
      },
    ]);
    const service = new SupplierIntelligenceService(provider);

    const comparison = await service.compareSuppliers(PRODUCT_X);

    expect(comparison).toHaveLength(1);
    expect(comparison[0].supplierId).toBe(1);
  });

  it("uses only the requested product's items for averagePrice, not the supplier's overall average", async () => {
    const provider = makeMultiSupplierProvider([
      {
        id: 1,
        name: 'Supplier A',
        transactions: [
          makeTransaction({
            id: 1,
            items: [makeItem(PRODUCT_X, 50), makeItem(PRODUCT_Y, 100)],
          }),
        ],
      },
    ]);
    const service = new SupplierIntelligenceService(provider);

    const comparison = await service.compareSuppliers(PRODUCT_X);

    // Must be 50 (Product X only), never 75 (the blended average with Product Y).
    expect(comparison[0].averagePrice).toBe(50);
    expect(comparison[0].pricedItemCount).toBe(1);
  });

  it('ignores null prices for the requested product, never treating them as 0', async () => {
    const provider = makeMultiSupplierProvider([
      {
        id: 1,
        name: 'Supplier A',
        transactions: [
          makeTransaction({
            id: 1,
            items: [makeItem(PRODUCT_X, null), makeItem(PRODUCT_X, 40)],
          }),
        ],
      },
    ]);
    const service = new SupplierIntelligenceService(provider);

    const comparison = await service.compareSuppliers(PRODUCT_X);

    expect(comparison[0].pricedItemCount).toBe(1);
    expect(comparison[0].averagePrice).toBe(40);
  });

  it('only counts transactions containing the requested product toward transactionCount', async () => {
    const provider = makeMultiSupplierProvider([
      {
        id: 1,
        name: 'Supplier A',
        transactions: [
          makeTransaction({ id: 1, items: [makeItem(PRODUCT_X, 50)] }),
          makeTransaction({ id: 2, items: [makeItem(PRODUCT_Y, 999)] }), // unrelated product
        ],
      },
    ]);
    const service = new SupplierIntelligenceService(provider);

    const comparison = await service.compareSuppliers(PRODUCT_X);

    expect(comparison[0].totalTransactions).toBe(1);
  });

  it('excludes transactions missing delivery dates from onTimeDeliveryRate', async () => {
    const provider = makeMultiSupplierProvider([
      {
        id: 1,
        name: 'Supplier A',
        transactions: [
          makeTransaction({
            id: 1,
            items: [makeItem(PRODUCT_X, 50)],
            expectedDate: new Date('2026-01-10T00:00:00Z'),
            actualDate: new Date('2026-01-09T00:00:00Z'),
          }),
          makeTransaction({
            id: 2,
            items: [makeItem(PRODUCT_X, 55)],
            expectedDate: null,
            actualDate: null,
          }),
        ],
      },
    ]);
    const service = new SupplierIntelligenceService(provider);

    const comparison = await service.compareSuppliers(PRODUCT_X);

    expect(comparison[0].evaluatedForOnTimeCount).toBe(1);
    expect(comparison[0].onTimeDeliveryRate).toBe(1);
  });

  it('returns an empty array when no supplier has supplied the requested product', async () => {
    const provider = makeMultiSupplierProvider([
      {
        id: 1,
        name: 'Supplier A',
        transactions: [
          makeTransaction({ id: 1, items: [makeItem(PRODUCT_Y, 50)] }),
        ],
      },
    ]);
    const service = new SupplierIntelligenceService(provider);

    const comparison = await service.compareSuppliers(PRODUCT_X);

    expect(comparison).toEqual([]);
  });

  it('returns an empty array when there are no suppliers at all', async () => {
    const service = new SupplierIntelligenceService(
      makeMultiSupplierProvider([]),
    );

    const comparison = await service.compareSuppliers(PRODUCT_X);

    expect(comparison).toEqual([]);
  });
});

/**
 * Supplier A: best on price, on-time rate, and cancellation rate; equal history (3
 * completed) to B. Supplier B: worst on price, on-time rate, and cancellation rate;
 * equal history to A. Both suppliers meet the >=3-completed-transaction evidence
 * threshold, so both are fully evaluated and history normalizes to a tie (100/100),
 * meaning A must win purely on price(40%) + onTime(30%) + cancellation(20%) = 90%.
 */
function bestVsWorstProvider() {
  const aCompleted = (id: number, day: number) =>
    makeTransaction({
      id,
      status: 'COMPLETED',
      items: [makeItem(PRODUCT_X, 10)],
      expectedDate: new Date(`2026-01-${10 + day}T00:00:00Z`),
      actualDate: new Date(`2026-01-${9 + day}T00:00:00Z`), // on time
      createdAt: new Date(`2026-01-0${day}T00:00:00Z`),
    });
  const bCompletedLate = (id: number, day: number) =>
    makeTransaction({
      id,
      status: 'COMPLETED',
      items: [makeItem(PRODUCT_X, 100)],
      expectedDate: new Date(`2026-01-${10 + day}T00:00:00Z`),
      actualDate: new Date(`2026-01-${20 + day}T00:00:00Z`), // late
      createdAt: new Date(`2026-01-0${day}T00:00:00Z`),
    });

  return makeMultiSupplierProvider([
    {
      id: 1,
      name: 'Supplier A',
      transactions: [aCompleted(1, 1), aCompleted(2, 2), aCompleted(3, 3)],
    },
    {
      id: 2,
      name: 'Supplier B',
      transactions: [
        makeTransaction({
          id: 4,
          status: 'CANCELLED',
          items: [makeItem(PRODUCT_X, 100)],
          expectedDate: null,
          actualDate: null,
          createdAt: new Date('2026-01-04T00:00:00Z'),
        }),
        bCompletedLate(5, 1),
        bCompletedLate(6, 2),
        bCompletedLate(7, 3),
      ],
    },
  ]);
}

describe('SupplierIntelligenceService.rankSuppliers', () => {
  it('ranks the objectively better supplier first per the weighted formula', async () => {
    const service = new SupplierIntelligenceService(bestVsWorstProvider());

    const ranked = await service.rankSuppliers(PRODUCT_X);

    expect(ranked).toHaveLength(2);
    expect(ranked[0].supplierId).toBe(1);
    expect(ranked[0].rank).toBe(1);
    // price 100 + onTime 100 + cancellation 100 + history 100 (tied 3-vs-3) all weighted
    expect(ranked[0].score).toBeCloseTo(100);
    expect(ranked[1].supplierId).toBe(2);
    expect(ranked[1].rank).toBe(2);
    // price 0 + onTime 0 + cancellation 0 + history 100 (tied) -> only the 10% history weight
    expect(ranked[1].score).toBeCloseTo(10);
  });

  it('produces the same ranking on repeated calls with the same data (deterministic)', async () => {
    const service = new SupplierIntelligenceService(bestVsWorstProvider());

    const first = await service.rankSuppliers(PRODUCT_X);
    const second = await service.rankSuppliers(PRODUCT_X);

    expect(second).toEqual(first);
  });

  it('breaks tied scores deterministically by supplierId, not insertion order', async () => {
    const identicalTx = (id: number, day: number) =>
      makeTransaction({
        id,
        status: 'COMPLETED',
        items: [makeItem(PRODUCT_X, 50)],
        expectedDate: new Date(`2026-01-${10 + day}T00:00:00Z`),
        actualDate: new Date(`2026-01-${9 + day}T00:00:00Z`),
        createdAt: new Date(`2026-01-0${day}T00:00:00Z`),
      });
    const threeCompleted = (baseId: number) => [
      identicalTx(baseId, 1),
      identicalTx(baseId + 1, 2),
      identicalTx(baseId + 2, 3),
    ];

    // Higher supplierId listed first in findAll(), to prove sorting doesn't rely on
    // insertion/discovery order.
    const provider = makeMultiSupplierProvider([
      { id: 7, name: 'Supplier Seven', transactions: threeCompleted(1) },
      { id: 3, name: 'Supplier Three', transactions: threeCompleted(4) },
    ]);
    const service = new SupplierIntelligenceService(provider);

    const ranked = await service.rankSuppliers(PRODUCT_X);

    expect(ranked[0].score).toBe(ranked[1].score); // confirms this is genuinely a tie
    expect(ranked.map((r) => r.supplierId)).toEqual([3, 7]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
  });

  it('flags a supplier with fewer than 3 completed product transactions as insufficient', async () => {
    const provider = makeMultiSupplierProvider([
      {
        id: 1,
        name: 'Supplier A (only 2 completed)',
        transactions: [
          makeTransaction({
            id: 1,
            status: 'COMPLETED',
            items: [makeItem(PRODUCT_X, 10)],
            expectedDate: new Date('2026-01-10T00:00:00Z'),
            actualDate: new Date('2026-01-09T00:00:00Z'),
          }),
          makeTransaction({
            id: 2,
            status: 'COMPLETED',
            items: [makeItem(PRODUCT_X, 10)],
            expectedDate: new Date('2026-01-10T00:00:00Z'),
            actualDate: new Date('2026-01-09T00:00:00Z'),
          }),
        ],
      },
    ]);
    const service = new SupplierIntelligenceService(provider);

    const ranked = await service.rankSuppliers(PRODUCT_X);

    expect(ranked).toHaveLength(1);
    expect(ranked[0].insufficientData).toBe(true);
    expect(ranked[0].rank).toBeNull();
    expect(ranked[0].score).toBeNull();
    expect(ranked[0].componentScores.productSupplyHistory).toBeNull();
    expect(ranked[0].insufficientDataReasons).toContain(
      'productSupplyHistory unavailable: fewer than 3 completed transactions for this product (has 2)',
    );
  });

  it('gives a supplier with more completed product transactions a better history score when other metrics are equal', async () => {
    const completedTx = (id: number, day: number) =>
      makeTransaction({
        id,
        status: 'COMPLETED',
        items: [makeItem(PRODUCT_X, 50)],
        expectedDate: new Date(`2026-02-${10 + day}T00:00:00Z`),
        actualDate: new Date(`2026-02-${9 + day}T00:00:00Z`),
        createdAt: new Date(`2026-02-0${day}T00:00:00Z`),
      });

    const provider = makeMultiSupplierProvider([
      {
        id: 1,
        name: 'Supplier A (3 completed)',
        transactions: [completedTx(1, 1), completedTx(2, 2), completedTx(3, 3)],
      },
      {
        id: 2,
        name: 'Supplier B (5 completed)',
        transactions: [
          completedTx(4, 1),
          completedTx(5, 2),
          completedTx(6, 3),
          completedTx(7, 4),
          completedTx(8, 5),
        ],
      },
    ]);
    const service = new SupplierIntelligenceService(provider);

    const ranked = await service.rankSuppliers(PRODUCT_X);
    const supplierA = ranked.find((r) => r.supplierId === 1)!;
    const supplierB = ranked.find((r) => r.supplierId === 2)!;

    // Price/onTime/cancellation are identical between A and B, so history alone
    // must decide: B (5 completed) beats A (3 completed).
    expect(supplierB.componentScores.productSupplyHistory).toBeGreaterThan(
      supplierA.componentScores.productSupplyHistory!,
    );
    expect(supplierB.rank).toBe(1);
    expect(supplierA.rank).toBe(2);
  });

  it('places a supplier with no priced items after fully-evaluated suppliers, with a clear reason, no fabricated score', async () => {
    const provider = makeMultiSupplierProvider([
      {
        id: 1,
        name: 'Supplier A (fully evaluated)',
        transactions: [
          makeTransaction({
            id: 1,
            status: 'COMPLETED',
            items: [makeItem(PRODUCT_X, 10)],
            expectedDate: new Date('2026-01-10T00:00:00Z'),
            actualDate: new Date('2026-01-09T00:00:00Z'),
          }),
          makeTransaction({
            id: 11,
            status: 'COMPLETED',
            items: [makeItem(PRODUCT_X, 10)],
            expectedDate: new Date('2026-01-11T00:00:00Z'),
            actualDate: new Date('2026-01-10T00:00:00Z'),
          }),
          makeTransaction({
            id: 12,
            status: 'COMPLETED',
            items: [makeItem(PRODUCT_X, 10)],
            expectedDate: new Date('2026-01-12T00:00:00Z'),
            actualDate: new Date('2026-01-11T00:00:00Z'),
          }),
        ],
      },
      {
        id: 2,
        name: 'Supplier B (no priced items)',
        transactions: [
          makeTransaction({
            id: 2,
            status: 'COMPLETED',
            items: [makeItem(PRODUCT_X, null)],
          }),
        ],
      },
    ]);
    const service = new SupplierIntelligenceService(provider);

    const ranked = await service.rankSuppliers(PRODUCT_X);

    expect(ranked).toHaveLength(2);
    expect(ranked[0].supplierId).toBe(1);
    expect(ranked[0].insufficientData).toBe(false);

    const insufficient = ranked[1];
    expect(insufficient.supplierId).toBe(2);
    expect(insufficient.insufficientData).toBe(true);
    expect(insufficient.rank).toBeNull();
    expect(insufficient.score).toBeNull();
    expect(insufficient.componentScores.price).toBeNull();
    expect(insufficient.insufficientDataReasons).toContain(
      'averagePrice unavailable: no priced items for this product from this supplier',
    );
  });

  it('returns an empty array when no supplier has supplied the product', async () => {
    const service = new SupplierIntelligenceService(bestVsWorstProvider());

    const ranked = await service.rankSuppliers(PRODUCT_Y); // neither supplier supplied Y

    expect(ranked).toEqual([]);
  });
});

describe('SupplierIntelligenceService.getBestSupplier', () => {
  it('returns the rank-1 supplier from rankSuppliers()', async () => {
    const service = new SupplierIntelligenceService(bestVsWorstProvider());

    const best = await service.getBestSupplier(PRODUCT_X);

    expect(best?.supplierId).toBe(1);
    expect(best?.rank).toBe(1);
  });

  it('is consistent with rankSuppliers() rather than running a separate algorithm', async () => {
    const service = new SupplierIntelligenceService(bestVsWorstProvider());

    const [best, ranked] = await Promise.all([
      service.getBestSupplier(PRODUCT_X),
      service.rankSuppliers(PRODUCT_X),
    ]);

    expect(best).toEqual(ranked[0]);
  });

  it('returns null when there are no suppliers for the product', async () => {
    const service = new SupplierIntelligenceService(
      makeMultiSupplierProvider([]),
    );

    const best = await service.getBestSupplier(PRODUCT_X);

    expect(best).toBeNull();
  });

  it('returns null (does not invent a supplier) when the only candidate has insufficient data', async () => {
    const provider = makeMultiSupplierProvider([
      {
        id: 1,
        name: 'Supplier A (no priced items)',
        transactions: [
          makeTransaction({
            id: 1,
            status: 'COMPLETED',
            items: [makeItem(PRODUCT_X, null)],
          }),
        ],
      },
    ]);
    const service = new SupplierIntelligenceService(provider);

    const best = await service.getBestSupplier(PRODUCT_X);

    expect(best).toBeNull();
  });
});
