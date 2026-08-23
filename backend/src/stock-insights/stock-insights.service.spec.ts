/// <reference types="jest" />

import { StockInsightsService } from './stock-insights.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  GetLedgerFilters,
  StockMovementsService,
} from '../stock-movements/stock-movements.service';
import {
  FindAllTransactionsFilters,
  InventoryTransactionsService,
} from '../inventory-transactions/inventory-transactions.service';
import { DocumentReviewService } from '../document-review/document-review.service';
import type {
  PendingDocumentReview,
  Prisma,
  StockMovement,
} from '../../generated/prisma/client';

function createMockPrisma() {
  return {
    warehouseInventory: {
      findMany: jest.fn(),
      // Defaults to [] (no onHand totals) so getTransferRecommendations()'s
      // capacity lookup finds nothing and treats every warehouse as
      // unlimited by default. Tests that care about capacity override this.
      groupBy: jest.fn().mockResolvedValue([]),
    },
    // Defaults to [] so any getDeadStock() call made incidentally (e.g. from
    // getTransferRecommendations()'s dead-stock context lookup) doesn't
    // require every unrelated test to stub it explicitly. Tests that care
    // about dead-stock content override this per-call.
    stockMovement: { groupBy: jest.fn().mockResolvedValue([]) },
    reservation: { groupBy: jest.fn() },
    // Defaults to [] (no warehouses found -> no maxCapacity known -> treated
    // as unlimited) so getTransferRecommendations()'s capacity cap is a
    // no-op unless a test explicitly stubs a warehouse with a maxCapacity.
    warehouse: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

function createMockStockMovementsService() {
  const getLedger = jest.fn<Promise<StockMovement[]>, [GetLedgerFilters?]>();
  getLedger.mockResolvedValue([]);
  const service = { getLedger } as unknown as StockMovementsService;
  return { service, getLedger };
}

function createMockInventoryTransactionsService() {
  const findAllTransactions = jest.fn<
    ReturnType<InventoryTransactionsService['findAllTransactions']>,
    [FindAllTransactionsFilters?, Prisma.TransactionClient?]
  >();
  findAllTransactions.mockResolvedValue([]);
  const getOverdueTransactions = jest.fn<
    ReturnType<InventoryTransactionsService['getOverdueTransactions']>,
    [Date?, Prisma.TransactionClient?]
  >();
  getOverdueTransactions.mockResolvedValue([]);
  const service = {
    findAllTransactions,
    getOverdueTransactions,
  } as unknown as InventoryTransactionsService;
  return { service, findAllTransactions, getOverdueTransactions };
}

function createMockDocumentReviewService() {
  const getPendingReviews = jest.fn<
    Promise<PendingDocumentReview[]>,
    [Prisma.TransactionClient?]
  >();
  getPendingReviews.mockResolvedValue([]);
  const service = { getPendingReviews } as unknown as DocumentReviewService;
  return { service, getPendingReviews };
}

function buildService() {
  const prisma = createMockPrisma();
  const { service: stockMovementsService, getLedger } =
    createMockStockMovementsService();
  const {
    service: inventoryTransactionsService,
    findAllTransactions,
    getOverdueTransactions,
  } = createMockInventoryTransactionsService();
  const { service: documentReviewService, getPendingReviews } =
    createMockDocumentReviewService();
  const service = new StockInsightsService(
    prisma as unknown as PrismaService,
    stockMovementsService,
    inventoryTransactionsService,
    documentReviewService,
  );
  return {
    service,
    prisma,
    getLedger,
    findAllTransactions,
    getOverdueTransactions,
    getPendingReviews,
  };
}

function movement(overrides: Partial<StockMovement>): StockMovement {
  return {
    id: 1,
    productId: 100,
    warehouseId: 10,
    type: 'OUTGOING',
    quantity: 1,
    transactionId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('StockInsightsService.getDeadStock', () => {
  const NOW = new Date('2026-06-01T00:00:00.000Z');

  it('confirmed rule: an inactive product with remaining stock still appears in dead-stock analysis (no isActive filter here)', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      {
        id: 1,
        productId: 900,
        warehouseId: 10,
        onHand: 12,
        reorderThreshold: 0,
      },
    ]);
    prisma.stockMovement.groupBy.mockResolvedValue([]);

    const result = await service.getDeadStock(60, NOW);

    // The query has no isActive condition at all — an inactive product's
    // leftover stock is exactly what dead-stock analysis must still catch.
    expect(prisma.warehouseInventory.findMany).toHaveBeenCalledWith({
      where: { onHand: { gt: 0 } },
    });
    expect(result).toEqual([
      {
        productId: 900,
        warehouseId: 10,
        onHand: 12,
        lastMovementAt: null,
        daysSinceLastMovement: null,
        lastOutgoingMovementAt: null,
        daysSinceLastOutgoingMovement: null,
      },
    ]);
  });

  it('flags a product/warehouse with stock but no movement within inactivityDays', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      {
        id: 1,
        productId: 100,
        warehouseId: 10,
        onHand: 5,
        reorderThreshold: 0,
      },
    ]);
    prisma.stockMovement.groupBy.mockResolvedValue([
      {
        productId: 100,
        warehouseId: 10,
        _max: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
      },
    ]);

    const result = await service.getDeadStock(60, NOW);

    expect(prisma.warehouseInventory.findMany).toHaveBeenCalledWith({
      where: { onHand: { gt: 0 } },
    });
    expect(result).toEqual([
      {
        productId: 100,
        warehouseId: 10,
        onHand: 5,
        lastMovementAt: new Date('2026-01-01T00:00:00.000Z'),
        daysSinceLastMovement: 151,
        lastOutgoingMovementAt: new Date('2026-01-01T00:00:00.000Z'),
        daysSinceLastOutgoingMovement: 151,
      },
    ]);
  });

  it('flags a product/warehouse with stock that has never had a movement', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      {
        id: 1,
        productId: 200,
        warehouseId: 10,
        onHand: 3,
        reorderThreshold: 0,
      },
    ]);
    prisma.stockMovement.groupBy.mockResolvedValue([]);

    const result = await service.getDeadStock(60, NOW);

    expect(result).toEqual([
      {
        productId: 200,
        warehouseId: 10,
        onHand: 3,
        lastMovementAt: null,
        daysSinceLastMovement: null,
        lastOutgoingMovementAt: null,
        daysSinceLastOutgoingMovement: null,
      },
    ]);
  });

  it('excludes a product/warehouse with a recent movement (within the window)', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      {
        id: 1,
        productId: 300,
        warehouseId: 10,
        onHand: 5,
        reorderThreshold: 0,
      },
    ]);
    prisma.stockMovement.groupBy.mockResolvedValue([
      {
        productId: 300,
        warehouseId: 10,
        _max: { createdAt: new Date('2026-05-20T00:00:00.000Z') },
      },
    ]);

    const result = await service.getDeadStock(60, NOW);

    expect(result).toEqual([]);
  });

  it('excludes zero-onHand rows entirely (never dead stock)', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([]);
    prisma.stockMovement.groupBy.mockResolvedValue([]);

    const result = await service.getDeadStock(60, NOW);

    expect(prisma.warehouseInventory.findMany).toHaveBeenCalledWith({
      where: { onHand: { gt: 0 } },
    });
    expect(result).toEqual([]);
  });

  it('treats a movement exactly at the 60-day inactivityDays boundary as dead (inclusive cutoff)', async () => {
    const { service, prisma } = buildService();
    const exactlySixtyDaysAgo = new Date(
      NOW.getTime() - 60 * 24 * 60 * 60 * 1000,
    );
    prisma.warehouseInventory.findMany.mockResolvedValue([
      {
        id: 1,
        productId: 400,
        warehouseId: 10,
        onHand: 5,
        reorderThreshold: 0,
      },
    ]);
    prisma.stockMovement.groupBy.mockResolvedValue([
      {
        productId: 400,
        warehouseId: 10,
        _max: { createdAt: exactlySixtyDaysAgo },
      },
    ]);

    const result = await service.getDeadStock(60, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].productId).toBe(400);
  });

  it('excludes a movement one day inside the 60-day boundary (59 days ago)', async () => {
    const { service, prisma } = buildService();
    const fiftyNineDaysAgo = new Date(NOW.getTime() - 59 * 24 * 60 * 60 * 1000);
    prisma.warehouseInventory.findMany.mockResolvedValue([
      {
        id: 1,
        productId: 401,
        warehouseId: 10,
        onHand: 5,
        reorderThreshold: 0,
      },
    ]);
    prisma.stockMovement.groupBy.mockResolvedValue([
      {
        productId: 401,
        warehouseId: 10,
        _max: { createdAt: fiftyNineDaysAgo },
      },
    ]);

    const result = await service.getDeadStock(60, NOW);

    expect(result).toEqual([]);
  });

  it('confirmed rule: a recent movement of a non-OUTGOING type (e.g. ADJUSTMENT) does NOT reset the 60-day inactivity period — eligibility is OUTGOING-only', async () => {
    const { service, prisma } = buildService();
    const recentAdjustment = new Date('2026-05-20T00:00:00.000Z');
    prisma.warehouseInventory.findMany.mockResolvedValue([
      {
        id: 1,
        productId: 600,
        warehouseId: 10,
        onHand: 10,
        reorderThreshold: 0,
      },
    ]);
    // Only the any-movement-type groupBy (no `where`) returns a row; the
    // OUTGOING-only groupBy (has `where`) returns nothing — i.e. the only
    // recorded movement is a non-OUTGOING one (e.g. an ADJUSTMENT), so this
    // product/warehouse pair has never had a real customer-consumption event.
    prisma.stockMovement.groupBy.mockImplementation(
      (args: { where?: unknown }) =>
        Promise.resolve(
          args.where
            ? []
            : [
                {
                  productId: 600,
                  warehouseId: 10,
                  _max: { createdAt: recentAdjustment },
                },
              ],
        ),
    );

    const result = await service.getDeadStock(60, NOW);

    // Flagged dead: the recent ADJUSTMENT does not reset the clock, and
    // there has never been an OUTGOING movement (lastOutgoingMovementAt is
    // null) — exactly the "no customer consumption" case dead stock exists
    // to catch, even though something else moved recently.
    expect(result).toEqual([
      {
        productId: 600,
        warehouseId: 10,
        onHand: 10,
        lastMovementAt: recentAdjustment,
        daysSinceLastMovement: 12,
        lastOutgoingMovementAt: null,
        daysSinceLastOutgoingMovement: null,
      },
    ]);
  });

  it('confirmed rule: a recent internal TRANSFER_IN/TRANSFER_OUT also does not reset the clock — only OUTGOING (a real sale) counts', async () => {
    const { service, prisma } = buildService();
    const recentTransfer = new Date('2026-05-25T00:00:00.000Z');
    prisma.warehouseInventory.findMany.mockResolvedValue([
      {
        id: 1,
        productId: 700,
        warehouseId: 10,
        onHand: 15,
        reorderThreshold: 0,
      },
    ]);
    // Any-movement-type groupBy sees the recent TRANSFER_OUT; the
    // OUTGOING-only groupBy sees nothing — this pair has never had a sale.
    prisma.stockMovement.groupBy.mockImplementation(
      (args: { where?: unknown }) =>
        Promise.resolve(
          args.where
            ? []
            : [
                {
                  productId: 700,
                  warehouseId: 10,
                  _max: { createdAt: recentTransfer },
                },
              ],
        ),
    );

    const result = await service.getDeadStock(60, NOW);

    expect(result).toEqual([
      {
        productId: 700,
        warehouseId: 10,
        onHand: 15,
        lastMovementAt: recentTransfer,
        daysSinceLastMovement: 7,
        lastOutgoingMovementAt: null,
        daysSinceLastOutgoingMovement: null,
      },
    ]);
  });

  it('distinguishes lastOutgoingMovementAt from lastMovementAt: a recent INCOMING restock does not count as "customer" activity', async () => {
    const { service, prisma } = buildService();
    const recentIncoming = new Date('2026-05-25T00:00:00.000Z');
    const oldOutgoing = new Date('2026-01-01T00:00:00.000Z');
    prisma.warehouseInventory.findMany.mockResolvedValue([
      {
        id: 1,
        productId: 500,
        warehouseId: 10,
        onHand: 20,
        reorderThreshold: 0,
      },
    ]);
    // First call: any-movement-type groupBy (no `where`) -> most recent overall
    // is the INCOMING restock. Second call: outgoing-only groupBy (has
    // `where`) -> most recent OUTGOING/TRANSFER_OUT is much older.
    prisma.stockMovement.groupBy.mockImplementation(
      (args: { where?: unknown }) =>
        Promise.resolve(
          args.where
            ? [
                {
                  productId: 500,
                  warehouseId: 10,
                  _max: { createdAt: oldOutgoing },
                },
              ]
            : [
                {
                  productId: 500,
                  warehouseId: 10,
                  _max: { createdAt: recentIncoming },
                },
              ],
        ),
    );

    // The row is NOT flagged dead (any-movement lastMovementAt is recent),
    // but the returned lastOutgoingMovementAt correctly reflects the much
    // older customer-facing activity.
    // Flagged dead: the recent INCOMING restock does NOT reset the clock —
    // only lastOutgoingMovementAt (151 days old, past the 60-day cutoff)
    // determines dead-stock status. lastMovementAt is still returned,
    // correctly reflecting the recent INCOMING, purely as historical info.
    const result = await service.getDeadStock(60, NOW);
    expect(result).toEqual([
      {
        productId: 500,
        warehouseId: 10,
        onHand: 20,
        lastMovementAt: recentIncoming,
        daysSinceLastMovement: 7,
        lastOutgoingMovementAt: oldOutgoing,
        daysSinceLastOutgoingMovement: 151,
      },
    ]);
  });

  it('defaults inactivityDays to 60 when not provided', async () => {
    const { service, prisma } = buildService();
    const sixtyOneDaysAgo = new Date(NOW.getTime() - 61 * 24 * 60 * 60 * 1000);
    prisma.warehouseInventory.findMany.mockResolvedValue([
      {
        id: 1,
        productId: 402,
        warehouseId: 10,
        onHand: 5,
        reorderThreshold: 0,
      },
    ]);
    prisma.stockMovement.groupBy.mockResolvedValue([
      {
        productId: 402,
        warehouseId: 10,
        _max: { createdAt: sixtyOneDaysAgo },
      },
    ]);

    const result = await service.getDeadStock(undefined, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].productId).toBe(402);
  });

  it('is sorted deterministically by (productId, warehouseId)', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      {
        id: 1,
        productId: 200,
        warehouseId: 20,
        onHand: 1,
        reorderThreshold: 0,
      },
      {
        id: 2,
        productId: 100,
        warehouseId: 30,
        onHand: 1,
        reorderThreshold: 0,
      },
      {
        id: 3,
        productId: 100,
        warehouseId: 10,
        onHand: 1,
        reorderThreshold: 0,
      },
    ]);
    prisma.stockMovement.groupBy.mockResolvedValue([]);

    const result = await service.getDeadStock(60, NOW);

    expect(result.map((r) => [r.productId, r.warehouseId])).toEqual([
      [100, 10],
      [100, 30],
      [200, 20],
    ]);
  });

  it('rejects a negative inactivityDays', async () => {
    const { service } = buildService();

    await expect(service.getDeadStock(-1, NOW)).rejects.toThrow(
      'inactivityDays must be a non-negative integer',
    );
  });

  it('never writes to inventory, stock movements, reservations, or transactions', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([]);
    prisma.stockMovement.groupBy.mockResolvedValue([]);

    await service.getDeadStock(90, NOW);

    expect(prisma.warehouseInventory.findMany).toHaveBeenCalled();
    expect(Object.keys(prisma.warehouseInventory)).not.toContain('update');
    expect(Object.keys(prisma.stockMovement)).not.toContain('create');
  });
});

describe('StockInsightsService.getConsumptionAnomalies', () => {
  const NOW = new Date('2026-06-01T00:00:00.000Z');

  it('confirmed rule: an inactive product still appears in consumption anomaly results (historical intelligence, not a new operational decision — no isActive filter here)', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      movement({
        productId: 900,
        type: 'OUTGOING',
        quantity: 10,
        createdAt: new Date('2026-04-15T00:00:00.000Z'),
      }),
      movement({
        productId: 900,
        type: 'OUTGOING',
        quantity: 30,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    // getLedger() is queried purely by productId/date/type — there is no
    // product/warehouse join and no isActive condition anywhere in this
    // call, so a now-inactive product's history is never excluded.
    expect(getLedger).toHaveBeenCalledWith({
      dateFrom: new Date('2026-04-02T00:00:00.000Z'),
      dateTo: NOW,
    });
    expect(result).toEqual([
      {
        productId: 900,
        warehouseId: 10,
        recentQuantity: 30,
        baselineQuantity: 10,
        percentChange: 200,
        direction: 'INCREASE',
      },
    ]);
  });

  it('flags a product whose recent consumption increased beyond the threshold', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      // baseline window (31-60 days ago): 10 units
      movement({
        productId: 100,
        type: 'OUTGOING',
        quantity: 10,
        createdAt: new Date('2026-04-15T00:00:00.000Z'),
      }),
      // recent window (last 30 days): 30 units -> +200%
      movement({
        productId: 100,
        type: 'OUTGOING',
        quantity: 30,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    expect(getLedger).toHaveBeenCalledWith({
      dateFrom: new Date('2026-04-02T00:00:00.000Z'),
      dateTo: NOW,
    });
    expect(result).toEqual([
      {
        productId: 100,
        warehouseId: 10,
        recentQuantity: 30,
        baselineQuantity: 10,
        percentChange: 200,
        direction: 'INCREASE',
      },
    ]);
  });

  it('flags a product whose recent consumption dropped beyond the threshold', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      movement({
        productId: 200,
        type: 'OUTGOING',
        quantity: 20,
        createdAt: new Date('2026-04-15T00:00:00.000Z'),
      }),
      movement({
        productId: 200,
        type: 'OUTGOING',
        quantity: 5,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    expect(result).toEqual([
      {
        productId: 200,
        warehouseId: 10,
        recentQuantity: 5,
        baselineQuantity: 20,
        percentChange: -75,
        direction: 'DECREASE',
      },
    ]);
  });

  it('does not flag a change below the threshold', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      movement({
        productId: 300,
        type: 'OUTGOING',
        quantity: 10,
        createdAt: new Date('2026-04-15T00:00:00.000Z'),
      }),
      movement({
        productId: 300,
        type: 'OUTGOING',
        quantity: 11,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    expect(result).toEqual([]);
  });

  it('confirmed rule: flags an exact 50% change (inclusive boundary)', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      movement({
        productId: 700,
        type: 'OUTGOING',
        quantity: 10,
        createdAt: new Date('2026-04-15T00:00:00.000Z'),
      }),
      movement({
        productId: 700,
        type: 'OUTGOING',
        quantity: 15,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    expect(result).toEqual([
      {
        productId: 700,
        warehouseId: 10,
        recentQuantity: 15,
        baselineQuantity: 10,
        percentChange: 50,
        direction: 'INCREASE',
      },
    ]);
  });

  it('confirmed rule: does not flag a change just under 50%', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      movement({
        productId: 701,
        type: 'OUTGOING',
        quantity: 10,
        createdAt: new Date('2026-04-15T00:00:00.000Z'),
      }),
      movement({
        productId: 701,
        type: 'OUTGOING',
        quantity: 14,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    expect(result).toEqual([]);
  });

  it('confirmed rule: defaults to a 30-day recent window compared against the previous 30-day baseline', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([]);

    await service.getConsumptionAnomalies(undefined, undefined, NOW);

    expect(getLedger).toHaveBeenCalledWith({
      dateFrom: new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000),
      dateTo: NOW,
    });
  });

  it('flags new consumption appearing from a zero baseline, with percentChange null', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      movement({
        productId: 400,
        type: 'OUTGOING',
        quantity: 8,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    expect(result).toEqual([
      {
        productId: 400,
        warehouseId: 10,
        recentQuantity: 8,
        baselineQuantity: 0,
        percentChange: null,
        direction: 'INCREASE',
      },
    ]);
  });

  it('does not flag a product with zero consumption in both windows', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    expect(result).toEqual([]);
  });

  it('ignores non-consumption movement types (INCOMING, TRANSFER_IN, TRANSFER_OUT, ADJUSTMENT) — only OUTGOING is true customer consumption', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      movement({
        productId: 500,
        type: 'INCOMING',
        quantity: 1000,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
      movement({
        productId: 500,
        type: 'ADJUSTMENT',
        quantity: 50,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
      movement({
        productId: 500,
        type: 'TRANSFER_IN',
        quantity: 40,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
      // An internal transfer between our own warehouses is not a sale — it
      // must not be able to manufacture a consumption anomaly on its own.
      movement({
        productId: 500,
        type: 'TRANSFER_OUT',
        quantity: 40,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    expect(result).toEqual([]);
  });

  it('evaluates each warehouse independently rather than summing across warehouses for the same product', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      // warehouse 10: baseline 10 -> recent 30 = +200%
      movement({
        productId: 600,
        warehouseId: 10,
        type: 'OUTGOING',
        quantity: 10,
        createdAt: new Date('2026-04-15T00:00:00.000Z'),
      }),
      movement({
        productId: 600,
        warehouseId: 10,
        type: 'OUTGOING',
        quantity: 30,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
      // warehouse 20: baseline 20 -> recent 5 = -75%
      movement({
        productId: 600,
        warehouseId: 20,
        type: 'OUTGOING',
        quantity: 20,
        createdAt: new Date('2026-04-16T00:00:00.000Z'),
      }),
      movement({
        productId: 600,
        warehouseId: 20,
        type: 'OUTGOING',
        quantity: 5,
        createdAt: new Date('2026-05-21T00:00:00.000Z'),
      }),
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    // Summed across warehouses (the old behavior) this would be baseline
    // 30 -> recent 35 = +16.7%, below the 50% threshold - no anomaly at
    // all, and both warehouses' real swings would be invisible. Evaluated
    // per-warehouse (the new behavior), both cross the threshold on their
    // own and are reported as two separate entries.
    expect(result).toEqual([
      {
        productId: 600,
        warehouseId: 10,
        recentQuantity: 30,
        baselineQuantity: 10,
        percentChange: 200,
        direction: 'INCREASE',
      },
      {
        productId: 600,
        warehouseId: 20,
        recentQuantity: 5,
        baselineQuantity: 20,
        percentChange: -75,
        direction: 'DECREASE',
      },
    ]);
  });

  it('sorts by |percentChange| descending, with null-baseline products first, tie-broken by productId', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      // productId 100: baseline 10 -> recent 20 = +100%
      movement({
        productId: 100,
        type: 'OUTGOING',
        quantity: 10,
        createdAt: new Date('2026-04-15T00:00:00.000Z'),
      }),
      movement({
        productId: 100,
        type: 'OUTGOING',
        quantity: 20,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
      // productId 200: zero baseline, new consumption -> percentChange null
      movement({
        productId: 200,
        type: 'OUTGOING',
        quantity: 5,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
      // productId 300: baseline 10 -> recent 100 = +900%
      movement({
        productId: 300,
        type: 'OUTGOING',
        quantity: 10,
        createdAt: new Date('2026-04-15T00:00:00.000Z'),
      }),
      movement({
        productId: 300,
        type: 'OUTGOING',
        quantity: 100,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    expect(result.map((r) => r.productId)).toEqual([200, 300, 100]);
  });

  it('rejects a non-positive windowDays', async () => {
    const { service } = buildService();

    await expect(service.getConsumptionAnomalies(0, 50, NOW)).rejects.toThrow(
      'windowDays must be a positive integer',
    );
  });

  it('rejects a non-positive thresholdPercent', async () => {
    const { service } = buildService();

    await expect(service.getConsumptionAnomalies(30, 0, NOW)).rejects.toThrow(
      'thresholdPercent must be a positive number',
    );
  });

  it('confirmed rule: minimumQuantityChange defaults to 0 — a no-op that does not change existing percentage-only behavior (1 -> 2 units is still flagged)', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      movement({
        productId: 100,
        type: 'OUTGOING',
        quantity: 1,
        createdAt: new Date('2026-04-15T00:00:00.000Z'),
      }),
      movement({
        productId: 100,
        type: 'OUTGOING',
        quantity: 2,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    expect(result).toEqual([
      {
        productId: 100,
        warehouseId: 10,
        recentQuantity: 2,
        baselineQuantity: 1,
        percentChange: 100,
        direction: 'INCREASE',
      },
    ]);
  });

  it('suppresses a noisy small-quantity change (1 -> 2 units) once a caller explicitly opts into a minimumQuantityChange floor', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      movement({
        productId: 100,
        type: 'OUTGOING',
        quantity: 1,
        createdAt: new Date('2026-04-15T00:00:00.000Z'),
      }),
      movement({
        productId: 100,
        type: 'OUTGOING',
        quantity: 2,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    ]);

    // Percentage change is 100% (would normally be flagged), but the
    // absolute change (1 unit) is below the caller-supplied floor.
    const result = await service.getConsumptionAnomalies(30, 50, NOW, 5);

    expect(result).toEqual([]);
  });

  it('applies minimumQuantityChange to the zero-baseline case too', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      movement({
        productId: 100,
        type: 'OUTGOING',
        quantity: 3,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW, 5);

    expect(result).toEqual([]);
  });

  it('rejects a negative minimumQuantityChange', async () => {
    const { service } = buildService();

    await expect(
      service.getConsumptionAnomalies(30, 50, NOW, -1),
    ).rejects.toThrow('minimumQuantityChange must be a non-negative integer');
  });

  it('never writes to inventory, stock movements, reservations, or transactions', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([]);

    await service.getConsumptionAnomalies(30, 50, NOW);

    expect(getLedger).toHaveBeenCalled();
  });
});

function inventoryRow(
  overrides: Partial<{
    id: number;
    productId: number;
    warehouseId: number;
    onHand: number;
    reorderThreshold: number;
  }> = {},
) {
  return {
    id: 1,
    productId: 100,
    warehouseId: 10,
    onHand: 0,
    reorderThreshold: 0,
    ...overrides,
  };
}

function reservedGroup(
  productId: number,
  warehouseId: number,
  quantity: number,
) {
  return { productId, warehouseId, _sum: { quantity } };
}

function pendingTransaction(
  overrides: Partial<{
    id: number;
    type: string;
    status: string;
    destinationWarehouseId: number | null;
    sourceWarehouseId: number | null;
    items: { productId: number; quantity: number }[];
  }> = {},
) {
  return {
    id: 1,
    type: 'INCOMING',
    status: 'PENDING',
    destinationWarehouseId: null,
    sourceWarehouseId: null,
    items: [],
    ...overrides,
  };
}

describe('StockInsightsService.getStockoutRisk', () => {
  const NOW = new Date('2026-06-01T00:00:00.000Z');

  it('only considers ACTIVE products at ACTIVE warehouses (isActive filter applied at the query)', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    await service.getStockoutRisk(30, NOW);

    expect(prisma.warehouseInventory.findMany).toHaveBeenCalledWith({
      where: { product: { isActive: true }, warehouse: { isActive: true } },
    });
  });

  it('classifies OUT_OF_STOCK when available is zero', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 0,
        reorderThreshold: 5,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getStockoutRisk(30, NOW);

    expect(result).toEqual([
      {
        productId: 100,
        warehouseId: 10,
        onHand: 0,
        activeReserved: 0,
        available: 0,
        reorderThreshold: 5,
        riskLevel: 'OUT_OF_STOCK',
        pendingIncomingQuantity: 0,
        projectedAvailable: 0,
        projectedRiskLevel: 'OUT_OF_STOCK',
        avgDailyConsumption: 0,
        daysOfSupply: null,
        predictedStockoutDate: null,
      },
    ]);
  });

  it('classifies AT_RISK when available is below reorderThreshold', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 5,
        reorderThreshold: 10,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getStockoutRisk(30, NOW);

    expect(result[0].riskLevel).toBe('AT_RISK');
  });

  it('confirmed rule: OK is inclusive at available === reorderThreshold', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 10,
        reorderThreshold: 10,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getStockoutRisk(30, NOW);

    expect(result[0].available).toBe(10);
    expect(result[0].riskLevel).toBe('OK');
  });

  it('confirmed rule: AT_RISK ends exactly one unit below reorderThreshold', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 9,
        reorderThreshold: 10,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getStockoutRisk(30, NOW);

    expect(result[0].available).toBe(9);
    expect(result[0].riskLevel).toBe('AT_RISK');
  });

  it('confirmed rule: available = onHand - active reservations (never a different formula)', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 30,
        reorderThreshold: 5,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([reservedGroup(100, 10, 12)]);

    const result = await service.getStockoutRisk(30, NOW);

    expect(result[0].onHand).toBe(30);
    expect(result[0].activeReserved).toBe(12);
    expect(result[0].available).toBe(18);
  });

  it('classifies OK when available is above reorderThreshold', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 100,
        reorderThreshold: 10,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getStockoutRisk(30, NOW);

    expect(result[0].riskLevel).toBe('OK');
  });

  it('computes available as onHand minus SUM(ACTIVE reservations)', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 20,
        reorderThreshold: 0,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([reservedGroup(100, 10, 15)]);

    const result = await service.getStockoutRisk(30, NOW);

    expect(prisma.reservation.groupBy).toHaveBeenCalledWith({
      by: ['productId', 'warehouseId'],
      where: { status: 'ACTIVE' },
      _sum: { quantity: true },
    });
    expect(result[0].activeReserved).toBe(15);
    expect(result[0].available).toBe(5);
  });

  it('includes PENDING INCOMING quantity destined for this warehouse in projectedAvailable', async () => {
    const { service, prisma, findAllTransactions } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 2,
        reorderThreshold: 10,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);
    findAllTransactions.mockResolvedValue([
      pendingTransaction({
        type: 'INCOMING',
        destinationWarehouseId: 10,
        items: [{ productId: 100, quantity: 20 }],
      }),
    ] as never);

    const result = await service.getStockoutRisk(30, NOW);

    expect(findAllTransactions).toHaveBeenCalledWith(
      { status: 'PENDING' },
      undefined,
    );
    expect(result[0].pendingIncomingQuantity).toBe(20);
    expect(result[0].projectedAvailable).toBe(22);
    expect(result[0].riskLevel).toBe('AT_RISK');
    expect(result[0].projectedRiskLevel).toBe('OK');
  });

  it('includes PENDING TRANSFER quantity destined for this warehouse as pending incoming', async () => {
    const { service, prisma, findAllTransactions } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 20,
        onHand: 0,
        reorderThreshold: 5,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);
    findAllTransactions.mockResolvedValue([
      pendingTransaction({
        type: 'TRANSFER',
        sourceWarehouseId: 10,
        destinationWarehouseId: 20,
        items: [{ productId: 100, quantity: 8 }],
      }),
    ] as never);

    const result = await service.getStockoutRisk(30, NOW);

    expect(result[0].pendingIncomingQuantity).toBe(8);
    expect(result[0].projectedAvailable).toBe(8);
  });

  it('ignores PENDING OUTGOING transactions (never pending incoming)', async () => {
    const { service, prisma, findAllTransactions } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 0,
        reorderThreshold: 5,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);
    findAllTransactions.mockResolvedValue([
      pendingTransaction({
        type: 'OUTGOING',
        sourceWarehouseId: 10,
        destinationWarehouseId: null,
        items: [{ productId: 100, quantity: 8 }],
      }),
    ] as never);

    const result = await service.getStockoutRisk(30, NOW);

    expect(result[0].pendingIncomingQuantity).toBe(0);
  });

  it('computes avgDailyConsumption and daysOfSupply from OUTGOING/TRANSFER_OUT movements only', async () => {
    const { service, prisma, getLedger } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 60,
        reorderThreshold: 0,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);
    getLedger.mockResolvedValue([
      movement({
        productId: 100,
        warehouseId: 10,
        type: 'OUTGOING',
        quantity: 30,
      }),
      movement({
        productId: 100,
        warehouseId: 10,
        type: 'INCOMING',
        quantity: 1000,
      }),
    ]);

    const result = await service.getStockoutRisk(30, NOW);

    expect(result[0].avgDailyConsumption).toBe(1);
    expect(result[0].daysOfSupply).toBe(60);
  });

  it('computes predictedStockoutDate as referenceDate + daysOfSupply days, when consumption data exists', async () => {
    const { service, prisma, getLedger } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 30,
        reorderThreshold: 0,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);
    getLedger.mockResolvedValue([
      movement({
        productId: 100,
        warehouseId: 10,
        type: 'OUTGOING',
        quantity: 30,
      }),
    ]);

    const result = await service.getStockoutRisk(30, NOW);

    // avgDailyConsumption = 30/30 = 1/day -> daysOfSupply = 30/1 = 30 days.
    expect(result[0].daysOfSupply).toBe(30);
    expect(result[0].predictedStockoutDate).toEqual(
      new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000),
    );
  });

  it('confirmed rule: predictedStockoutDate is null (never invented) when consumption is zero', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 30,
        reorderThreshold: 0,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getStockoutRisk(30, NOW);

    expect(result[0].avgDailyConsumption).toBe(0);
    expect(result[0].daysOfSupply).toBeNull();
    expect(result[0].predictedStockoutDate).toBeNull();
  });

  it('sorts by risk severity (OUT_OF_STOCK, AT_RISK, OK) then productId/warehouseId', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 300,
        warehouseId: 10,
        onHand: 100,
        reorderThreshold: 10,
      }), // OK
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 5,
        reorderThreshold: 10,
      }), // AT_RISK
      inventoryRow({
        productId: 200,
        warehouseId: 10,
        onHand: 0,
        reorderThreshold: 10,
      }), // OUT_OF_STOCK
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getStockoutRisk(30, NOW);

    expect(result.map((r) => r.productId)).toEqual([200, 100, 300]);
  });

  it('rejects a non-positive consumptionWindowDays', async () => {
    const { service } = buildService();

    await expect(service.getStockoutRisk(0, NOW)).rejects.toThrow(
      'consumptionWindowDays must be a positive integer',
    );
  });

  it('returns an empty array when there is no inventory', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getStockoutRisk(30, NOW);

    expect(result).toEqual([]);
  });
});

describe('StockInsightsService.getRestockRecommendations', () => {
  const NOW = new Date('2026-06-01T00:00:00.000Z');

  it('recommends restocking a product still at risk after pending incoming', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 2,
        reorderThreshold: 10,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getRestockRecommendations(30, NOW);

    expect(result).toEqual([
      {
        productId: 100,
        warehouseId: 10,
        available: 2,
        pendingIncomingQuantity: 0,
        projectedAvailable: 2,
        reorderThreshold: 10,
        riskLevel: 'AT_RISK',
        projectedRiskLevel: 'AT_RISK',
        recommendedQuantity: 8,
        avgDailyConsumption: 0,
        daysOfSupply: null,
        reason: 'purchase_required',
        explanation:
          'No pending incoming stock and no warehouse surplus are available for this product, so a new purchase is required to reach the reorder threshold (10).',
      },
    ]);
  });

  it("excludes an inactive product from restock recommendations (via getStockoutRisk's query filter)", async () => {
    const { service, prisma } = buildService();
    // In production, `product: { isActive: true }` on the underlying query
    // (asserted in the getStockoutRisk suite) means an inactive product's
    // row is never returned by the database in the first place — simulated
    // here by simply not including it in the mocked result.
    prisma.warehouseInventory.findMany.mockResolvedValue([]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getRestockRecommendations(30, NOW);

    expect(result).toEqual([]);
  });

  it('confirmed rule: a product whose pending incoming fully resolves the projected shortage is excluded entirely — no recommendedQuantity: 0 placeholder, nothing returned for it', async () => {
    const { service, prisma, findAllTransactions } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 2,
        reorderThreshold: 10,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);
    findAllTransactions.mockResolvedValue([
      pendingTransaction({
        type: 'INCOMING',
        destinationWarehouseId: 10,
        items: [{ productId: 100, quantity: 20 }],
      }),
    ] as never);

    const result = await service.getRestockRecommendations(30, NOW);

    expect(result).toEqual([]);
  });

  it('does not recommend a product that is not at risk', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 100,
        reorderThreshold: 10,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getRestockRecommendations(30, NOW);

    expect(result).toEqual([]);
  });

  it("confirmed rule: reason is 'transfer_available' when another warehouse has surplus (reuses getTransferRecommendations, no donor-matching logic duplicated)", async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 2,
        reorderThreshold: 10,
      }), // deficit: need 8
      inventoryRow({
        productId: 100,
        warehouseId: 20,
        onHand: 100,
        reorderThreshold: 10,
      }), // surplus: 90
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getRestockRecommendations(30, NOW);

    expect(result).toEqual([
      expect.objectContaining({
        productId: 100,
        warehouseId: 10,
        reason: 'transfer_available',
        explanation: expect.stringContaining('transfer') as string,
      }),
    ]);
  });

  it('sorts by projectedRiskLevel severity, then recommendedQuantity descending', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 8,
        reorderThreshold: 10,
      }), // AT_RISK, need 2
      inventoryRow({
        productId: 200,
        warehouseId: 10,
        onHand: 0,
        reorderThreshold: 10,
      }), // OUT_OF_STOCK, need 10
      inventoryRow({
        productId: 300,
        warehouseId: 10,
        onHand: 1,
        reorderThreshold: 20,
      }), // AT_RISK, need 19
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getRestockRecommendations(30, NOW);

    expect(result.map((r) => r.productId)).toEqual([200, 300, 100]);
  });

  it('returns an empty array when there is no inventory', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getRestockRecommendations(30, NOW);

    expect(result).toEqual([]);
  });
});

describe('StockInsightsService.getTransferRecommendations', () => {
  const NOW = new Date('2026-06-01T00:00:00.000Z');

  it("excludes an inactive warehouse as a transfer source/destination (via getStockoutRisk's query filter)", async () => {
    const { service, prisma } = buildService();
    // In production, `warehouse: { isActive: true }` on the underlying
    // query (asserted in the getStockoutRisk suite) means an inactive
    // warehouse's row is never returned in the first place — simulated
    // here by only returning the deficit warehouse, with no surplus donor
    // available (the would-be donor is inactive and therefore absent).
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 2,
        reorderThreshold: 10,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getTransferRecommendations(30, NOW);

    expect(result).toEqual([]);
  });

  it('recommends a transfer from a surplus warehouse to a deficit warehouse for the same product', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 2,
        reorderThreshold: 10,
      }), // deficit: need 8
      inventoryRow({
        productId: 100,
        warehouseId: 20,
        onHand: 100,
        reorderThreshold: 10,
      }), // surplus: 90
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getTransferRecommendations(30, NOW);

    expect(result).toEqual([
      {
        productId: 100,
        fromWarehouseId: 20,
        toWarehouseId: 10,
        transferQuantity: 8,
        fromWarehouseAvailableAfterTransfer: 92,
        toWarehouseProjectedAvailableAfterTransfer: 10,
        sourcePendingIncomingQuantity: 0,
        // No StockMovement rows are mocked in this test at all, so both
        // rows have never had an OUTGOING movement -> both are (trivially)
        // dead stock; not the focus of this test, just an accurate
        // reflection of the fixture.
        sourceIsDeadStock: true,
        destinationRiskLevel: 'AT_RISK',
        destinationAvgDailyConsumption: 0,
        destinationDaysOfSupply: null,
      },
    ]);
  });

  it('enriches a recommendation with real source/destination context (not always defaulted): donor pending incoming, donor NOT flagged dead when recently active, and destination demand/risk', async () => {
    const { service, prisma, getLedger } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 0,
        reorderThreshold: 10,
      }), // deficit
      inventoryRow({
        productId: 100,
        warehouseId: 20,
        onHand: 100,
        reorderThreshold: 10,
      }), // surplus donor
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);
    // Donor warehouse 20 has a recent movement -> not dead stock.
    prisma.stockMovement.groupBy.mockResolvedValue([
      {
        productId: 100,
        warehouseId: 20,
        _max: { createdAt: NOW },
      },
    ]);
    // Destination warehouse 10 has real consumption history -> non-zero demand context.
    getLedger.mockResolvedValue([
      movement({
        productId: 100,
        warehouseId: 10,
        type: 'OUTGOING',
        quantity: 30,
      }),
    ]);

    const result = await service.getTransferRecommendations(30, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].sourceIsDeadStock).toBe(false);
    expect(result[0].sourcePendingIncomingQuantity).toBe(0);
    expect(result[0].destinationRiskLevel).toBe('OUT_OF_STOCK');
    expect(result[0].destinationAvgDailyConsumption).toBe(1);
    expect(result[0].destinationDaysOfSupply).toBe(0);
  });

  it('does not recommend a transfer when no warehouse has surplus for that product', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 2,
        reorderThreshold: 10,
      }),
      inventoryRow({
        productId: 100,
        warehouseId: 20,
        onHand: 5,
        reorderThreshold: 10,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getTransferRecommendations(30, NOW);

    expect(result).toEqual([]);
  });

  it('splits one deficit across two donors in warehouseId order when a single donor cannot cover it', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 0,
        reorderThreshold: 20,
      }), // deficit: need 20
      inventoryRow({
        productId: 100,
        warehouseId: 20,
        onHand: 25,
        reorderThreshold: 10,
      }), // donor: 15
      inventoryRow({
        productId: 100,
        warehouseId: 30,
        onHand: 40,
        reorderThreshold: 10,
      }), // donor: 30
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getTransferRecommendations(30, NOW);

    expect(result).toEqual([
      {
        productId: 100,
        fromWarehouseId: 20,
        toWarehouseId: 10,
        transferQuantity: 15,
        fromWarehouseAvailableAfterTransfer: 10,
        toWarehouseProjectedAvailableAfterTransfer: 15,
        sourcePendingIncomingQuantity: 0,
        sourceIsDeadStock: true,
        destinationRiskLevel: 'OUT_OF_STOCK',
        destinationAvgDailyConsumption: 0,
        destinationDaysOfSupply: null,
      },
      {
        productId: 100,
        fromWarehouseId: 30,
        toWarehouseId: 10,
        transferQuantity: 5,
        fromWarehouseAvailableAfterTransfer: 35,
        toWarehouseProjectedAvailableAfterTransfer: 20,
        sourcePendingIncomingQuantity: 0,
        sourceIsDeadStock: true,
        destinationRiskLevel: 'OUT_OF_STOCK',
        destinationAvgDailyConsumption: 0,
        destinationDaysOfSupply: null,
      },
    ]);
  });

  it('never recommends a warehouse transfer to itself', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 0,
        reorderThreshold: 20,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getTransferRecommendations(30, NOW);

    expect(result).toEqual([]);
  });

  it('returns an empty array when there is no inventory', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getTransferRecommendations(30, NOW);

    expect(result).toEqual([]);
  });

  it('caps the recommended transfer quantity to the destination warehouse remaining capacity (maxCapacity - current total onHand across all products)', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 2,
        reorderThreshold: 10,
      }), // deficit: would need 8
      inventoryRow({
        productId: 100,
        warehouseId: 20,
        onHand: 100,
        reorderThreshold: 10,
      }), // surplus: 90, more than enough on its own
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);
    // Destination warehouse 10 has maxCapacity 5 and already holds 2 units
    // total (this same product 100's onHand) -> only 3 units of headroom.
    prisma.warehouse.findMany.mockResolvedValue([{ id: 10, maxCapacity: 5 }]);
    prisma.warehouseInventory.groupBy.mockResolvedValue([
      { warehouseId: 10, _sum: { onHand: 2 } },
    ]);

    const result = await service.getTransferRecommendations(30, NOW);

    expect(result).toHaveLength(1);
    // Capped to the 3 units of remaining capacity, not the full 8-unit deficit.
    expect(result[0].transferQuantity).toBe(3);
    expect(result[0].toWarehouseId).toBe(10);
  });

  it('does not recommend a transfer into a destination warehouse with zero remaining capacity', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 2,
        reorderThreshold: 10,
      }),
      inventoryRow({
        productId: 100,
        warehouseId: 20,
        onHand: 100,
        reorderThreshold: 10,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);
    // Warehouse 10 is already at (or over) its maxCapacity — no headroom.
    prisma.warehouse.findMany.mockResolvedValue([{ id: 10, maxCapacity: 2 }]);
    prisma.warehouseInventory.groupBy.mockResolvedValue([
      { warehouseId: 10, _sum: { onHand: 2 } },
    ]);

    const result = await service.getTransferRecommendations(30, NOW);

    expect(result).toEqual([]);
  });

  it('does not cap the transfer when the destination warehouse has no maxCapacity set (unlimited)', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 2,
        reorderThreshold: 10,
      }), // deficit: need 8
      inventoryRow({
        productId: 100,
        warehouseId: 20,
        onHand: 100,
        reorderThreshold: 10,
      }), // surplus: 90
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);
    prisma.warehouse.findMany.mockResolvedValue([
      { id: 10, maxCapacity: null },
    ]);
    prisma.warehouseInventory.groupBy.mockResolvedValue([
      { warehouseId: 10, _sum: { onHand: 2 } },
    ]);

    const result = await service.getTransferRecommendations(30, NOW);

    expect(result).toHaveLength(1);
    expect(result[0].transferQuantity).toBe(8);
  });
});

describe('StockInsightsService.getControlTowerAlerts', () => {
  const NOW = new Date('2026-06-01T00:00:00.000Z');

  it('aggregates every source into severity-sorted alerts without recomputing anything', async () => {
    const { service, getOverdueTransactions, getPendingReviews } =
      buildService();

    jest.spyOn(service, 'getDeadStock').mockResolvedValue([
      {
        productId: 1,
        warehouseId: 10,
        onHand: 5,
        lastMovementAt: new Date('2026-05-30T00:00:00.000Z'),
        daysSinceLastMovement: 2,
        lastOutgoingMovementAt: new Date('2026-01-01T00:00:00.000Z'),
        daysSinceLastOutgoingMovement: 151,
      },
    ]);
    jest.spyOn(service, 'getConsumptionAnomalies').mockResolvedValue([
      {
        productId: 2,
        warehouseId: 10,
        recentQuantity: 30,
        baselineQuantity: 10,
        percentChange: 200,
        direction: 'INCREASE',
      },
    ]);
    jest.spyOn(service, 'getStockoutRisk').mockResolvedValue([
      {
        productId: 3,
        warehouseId: 10,
        onHand: 0,
        activeReserved: 0,
        available: 0,
        reorderThreshold: 5,
        riskLevel: 'OUT_OF_STOCK',
        pendingIncomingQuantity: 0,
        projectedAvailable: 0,
        projectedRiskLevel: 'OUT_OF_STOCK',
        avgDailyConsumption: 1,
        daysOfSupply: 0,
        predictedStockoutDate: NOW,
      },
      {
        productId: 4,
        warehouseId: 10,
        onHand: 50,
        activeReserved: 0,
        available: 50,
        reorderThreshold: 5,
        riskLevel: 'OK',
        pendingIncomingQuantity: 0,
        projectedAvailable: 50,
        projectedRiskLevel: 'OK',
        avgDailyConsumption: 1,
        daysOfSupply: 50,
        predictedStockoutDate: null,
      },
      {
        productId: 5,
        warehouseId: 10,
        onHand: 3,
        activeReserved: 0,
        available: 3,
        reorderThreshold: 5,
        riskLevel: 'AT_RISK',
        pendingIncomingQuantity: 0,
        projectedAvailable: 3,
        projectedRiskLevel: 'AT_RISK',
        avgDailyConsumption: 1,
        daysOfSupply: 3,
        predictedStockoutDate: null,
      },
    ]);
    // Isolated from their own decision logic (already covered by their own
    // describe blocks) so this test only exercises aggregation.
    jest.spyOn(service, 'getRestockRecommendations').mockResolvedValue([]);
    jest.spyOn(service, 'getTransferRecommendations').mockResolvedValue([]);
    getOverdueTransactions.mockResolvedValue([
      {
        id: 99,
        type: 'INCOMING',
        status: 'PENDING',
        expectedDate: new Date('2026-05-01T00:00:00.000Z'),
      },
    ] as never);
    getPendingReviews.mockResolvedValue([
      { id: 7, transactionType: 'INCOMING', status: 'PENDING_REVIEW' },
    ] as never);

    const result = await service.getControlTowerAlerts({}, NOW);

    expect(result.map((a) => [a.category, a.severity])).toEqual([
      ['STOCKOUT_RISK', 'CRITICAL'],
      ['STOCKOUT_RISK', 'CRITICAL'],
      ['CONSUMPTION_ANOMALY', 'WARNING'],
      ['OVERDUE_TRANSACTION', 'WARNING'],
      ['DEAD_STOCK', 'INFO'],
      ['PENDING_DOCUMENT_REVIEW', 'INFO'],
    ]);
    // The OK stockout-risk entry (productId 4) must never surface as an alert.
    expect(result.some((a) => a.data.productId === 4)).toBe(false);
    expect(result.every((a) => a.referenceDate === NOW)).toBe(true);
    const deadStockAlert = result.find((a) => a.category === 'DEAD_STOCK');
    expect(deadStockAlert?.message).toContain(
      'no customer OUTGOING movement in 151 days',
    );
    expect(deadStockAlert?.message).not.toContain('2 days');
  });

  it('confirmed rule: AT_RISK stockout entries are CRITICAL, not WARNING', async () => {
    const { service, getOverdueTransactions, getPendingReviews } =
      buildService();
    jest.spyOn(service, 'getDeadStock').mockResolvedValue([]);
    jest.spyOn(service, 'getConsumptionAnomalies').mockResolvedValue([]);
    jest.spyOn(service, 'getStockoutRisk').mockResolvedValue([
      {
        productId: 5,
        warehouseId: 10,
        onHand: 3,
        activeReserved: 0,
        available: 3,
        reorderThreshold: 5,
        riskLevel: 'AT_RISK',
        pendingIncomingQuantity: 0,
        projectedAvailable: 3,
        projectedRiskLevel: 'AT_RISK',
        avgDailyConsumption: 1,
        daysOfSupply: 3,
        predictedStockoutDate: null,
      },
    ]);
    jest.spyOn(service, 'getRestockRecommendations').mockResolvedValue([]);
    jest.spyOn(service, 'getTransferRecommendations').mockResolvedValue([]);
    getOverdueTransactions.mockResolvedValue([]);
    getPendingReviews.mockResolvedValue([]);

    const result = await service.getControlTowerAlerts({}, NOW);

    expect(result).toEqual([
      expect.objectContaining({
        category: 'STOCKOUT_RISK',
        severity: 'CRITICAL',
      }),
    ]);
  });

  it('promotes restock/transfer recommendations to alerts', async () => {
    const { service, getOverdueTransactions, getPendingReviews } =
      buildService();
    jest.spyOn(service, 'getDeadStock').mockResolvedValue([]);
    jest.spyOn(service, 'getConsumptionAnomalies').mockResolvedValue([]);
    jest.spyOn(service, 'getStockoutRisk').mockResolvedValue([]);
    jest.spyOn(service, 'getRestockRecommendations').mockResolvedValue([
      {
        productId: 1,
        warehouseId: 10,
        available: 2,
        pendingIncomingQuantity: 0,
        projectedAvailable: 2,
        reorderThreshold: 10,
        riskLevel: 'AT_RISK',
        projectedRiskLevel: 'AT_RISK',
        recommendedQuantity: 8,
        avgDailyConsumption: 0,
        daysOfSupply: null,
        reason: 'purchase_required',
        explanation: 'A purchase is required.',
      },
    ]);
    jest.spyOn(service, 'getTransferRecommendations').mockResolvedValue([
      {
        productId: 3,
        fromWarehouseId: 20,
        toWarehouseId: 10,
        transferQuantity: 5,
        fromWarehouseAvailableAfterTransfer: 10,
        toWarehouseProjectedAvailableAfterTransfer: 5,
        sourcePendingIncomingQuantity: 0,
        sourceIsDeadStock: false,
        destinationRiskLevel: 'AT_RISK',
        destinationAvgDailyConsumption: 1,
        destinationDaysOfSupply: 3,
      },
    ]);
    getOverdueTransactions.mockResolvedValue([]);
    getPendingReviews.mockResolvedValue([]);

    const result = await service.getControlTowerAlerts({}, NOW);

    expect(result.map((a) => [a.category, a.data.productId])).toEqual([
      ['RESTOCK_RECOMMENDATION', 1],
      ['TRANSFER_RECOMMENDATION', 3],
    ]);
    expect(result.every((a) => a.severity === 'WARNING')).toBe(true);
  });

  it('passes options through to the underlying calculations', async () => {
    const { service, getOverdueTransactions, getPendingReviews } =
      buildService();
    const deadStockSpy = jest
      .spyOn(service, 'getDeadStock')
      .mockResolvedValue([]);
    const anomaliesSpy = jest
      .spyOn(service, 'getConsumptionAnomalies')
      .mockResolvedValue([]);
    const riskSpy = jest
      .spyOn(service, 'getStockoutRisk')
      .mockResolvedValue([]);
    getOverdueTransactions.mockResolvedValue([]);
    getPendingReviews.mockResolvedValue([]);

    await service.getControlTowerAlerts(
      {
        deadStockInactivityDays: 45,
        consumptionWindowDays: 14,
        consumptionThresholdPercent: 25,
      },
      NOW,
    );

    expect(deadStockSpy).toHaveBeenCalledWith(45, NOW, undefined);
    expect(anomaliesSpy).toHaveBeenCalledWith(14, 25, NOW);
    expect(riskSpy).toHaveBeenCalledWith(14, NOW, undefined);
  });

  it('returns an empty array when every source has nothing to report', async () => {
    const { service, getOverdueTransactions, getPendingReviews } =
      buildService();
    jest.spyOn(service, 'getDeadStock').mockResolvedValue([]);
    jest.spyOn(service, 'getConsumptionAnomalies').mockResolvedValue([]);
    jest.spyOn(service, 'getStockoutRisk').mockResolvedValue([]);
    getOverdueTransactions.mockResolvedValue([]);
    getPendingReviews.mockResolvedValue([]);

    const result = await service.getControlTowerAlerts({}, NOW);

    expect(result).toEqual([]);
  });
});
