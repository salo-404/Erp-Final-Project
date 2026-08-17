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
    warehouseInventory: { findMany: jest.fn() },
    stockMovement: { groupBy: jest.fn() },
    reservation: { groupBy: jest.fn() },
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
        type: 'TRANSFER_OUT',
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

  it('ignores non-consumption movement types (INCOMING, TRANSFER_IN, ADJUSTMENT)', async () => {
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
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    expect(result).toEqual([]);
  });

  it('sums consumption across multiple warehouses for the same product', async () => {
    const { service, getLedger } = buildService();
    getLedger.mockResolvedValue([
      movement({
        productId: 600,
        warehouseId: 10,
        type: 'OUTGOING',
        quantity: 10,
        createdAt: new Date('2026-04-15T00:00:00.000Z'),
      }),
      movement({
        productId: 600,
        warehouseId: 20,
        type: 'OUTGOING',
        quantity: 20,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      }),
      movement({
        productId: 600,
        warehouseId: 30,
        type: 'TRANSFER_OUT',
        quantity: 10,
        createdAt: new Date('2026-05-21T00:00:00.000Z'),
      }),
    ]);

    const result = await service.getConsumptionAnomalies(30, 50, NOW);

    expect(result).toEqual([
      {
        productId: 600,
        recentQuantity: 30,
        baselineQuantity: 10,
        percentChange: 200,
        direction: 'INCREASE',
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
      },
    ]);
  });

  it('classifies AT_RISK when available is at or below reorderThreshold', async () => {
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

  it('confirmed rule: AT_RISK is inclusive at available === reorderThreshold', async () => {
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
    expect(result[0].riskLevel).toBe('AT_RISK');
  });

  it('confirmed rule: OK begins exactly one unit above reorderThreshold', async () => {
    const { service, prisma } = buildService();
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({
        productId: 100,
        warehouseId: 10,
        onHand: 11,
        reorderThreshold: 10,
      }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.getStockoutRisk(30, NOW);

    expect(result[0].available).toBe(11);
    expect(result[0].riskLevel).toBe('OK');
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
      },
    ]);
  });

  it('does not recommend a product whose pending incoming already resolves the risk', async () => {
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
      },
    ]);
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
      },
      {
        productId: 100,
        fromWarehouseId: 30,
        toWarehouseId: 10,
        transferQuantity: 5,
        fromWarehouseAvailableAfterTransfer: 35,
        toWarehouseProjectedAvailableAfterTransfer: 20,
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
        lastMovementAt: null,
        daysSinceLastMovement: null,
      },
    ]);
    jest.spyOn(service, 'getConsumptionAnomalies').mockResolvedValue([
      {
        productId: 2,
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
      },
    ]);
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
      },
    ]);
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
