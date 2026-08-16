/// <reference types="jest" />

import { StockMovementsService } from './stock-movements.service';
import { PrismaService } from '../prisma/prisma.service';

function createMockTx() {
  return {
    product: { findUnique: jest.fn() },
    warehouse: { findUnique: jest.fn() },
    warehouseInventory: { create: jest.fn(), update: jest.fn() },
    stockMovement: { create: jest.fn() },
    $queryRaw: jest.fn(),
  };
}

type MockTx = ReturnType<typeof createMockTx>;

function createMockPrisma(tx: MockTx) {
  return {
    $transaction: jest.fn((callback: (tx: MockTx) => unknown) => callback(tx)),
  } as unknown as PrismaService;
}

const PRODUCT = { id: 1, name: 'Widget' };
const WAREHOUSE = { id: 10, name: 'Main Warehouse' };

/** Configures the "happy path" existence checks and an existing inventory row. */
function setupHappyPath(tx: MockTx, currentOnHand: number) {
  tx.product.findUnique.mockResolvedValue(PRODUCT);
  tx.warehouse.findUnique.mockResolvedValue(WAREHOUSE);
  tx.$queryRaw.mockResolvedValue([{ onHand: currentOnHand }]);
  tx.warehouseInventory.update.mockResolvedValue({});
  tx.stockMovement.create.mockImplementation((args: { data: unknown }) =>
    Promise.resolve({ id: 1, ...(args.data as object) }),
  );
}

describe('StockMovementsService.recordMovement', () => {
  it('increases onHand for INCOMING', async () => {
    const tx = createMockTx();
    setupHappyPath(tx, 10);
    const service = new StockMovementsService(createMockPrisma(tx));

    await service.recordMovement({
      productId: 1,
      warehouseId: 10,
      type: 'INCOMING',
      quantity: 5,
    });

    expect(tx.warehouseInventory.update).toHaveBeenCalledWith({
      where: { productId_warehouseId: { productId: 1, warehouseId: 10 } },
      data: { onHand: 15 },
    });
  });

  it('decreases onHand for OUTGOING', async () => {
    const tx = createMockTx();
    setupHappyPath(tx, 10);
    const service = new StockMovementsService(createMockPrisma(tx));

    await service.recordMovement({
      productId: 1,
      warehouseId: 10,
      type: 'OUTGOING',
      quantity: 4,
    });

    expect(tx.warehouseInventory.update).toHaveBeenCalledWith({
      where: { productId_warehouseId: { productId: 1, warehouseId: 10 } },
      data: { onHand: 6 },
    });
  });

  it('increases onHand for TRANSFER_IN', async () => {
    const tx = createMockTx();
    setupHappyPath(tx, 10);
    const service = new StockMovementsService(createMockPrisma(tx));

    await service.recordMovement({
      productId: 1,
      warehouseId: 10,
      type: 'TRANSFER_IN',
      quantity: 7,
    });

    expect(tx.warehouseInventory.update).toHaveBeenCalledWith({
      where: { productId_warehouseId: { productId: 1, warehouseId: 10 } },
      data: { onHand: 17 },
    });
  });

  it('decreases onHand for TRANSFER_OUT', async () => {
    const tx = createMockTx();
    setupHappyPath(tx, 10);
    const service = new StockMovementsService(createMockPrisma(tx));

    await service.recordMovement({
      productId: 1,
      warehouseId: 10,
      type: 'TRANSFER_OUT',
      quantity: 3,
    });

    expect(tx.warehouseInventory.update).toHaveBeenCalledWith({
      where: { productId_warehouseId: { productId: 1, warehouseId: 10 } },
      data: { onHand: 7 },
    });
  });

  it('creates the immutable StockMovement ledger row with the right fields', async () => {
    const tx = createMockTx();
    setupHappyPath(tx, 10);
    const service = new StockMovementsService(createMockPrisma(tx));

    await service.recordMovement({
      productId: 1,
      warehouseId: 10,
      type: 'INCOMING',
      quantity: 5,
      transactionId: 99,
    });

    expect(tx.stockMovement.create).toHaveBeenCalledWith({
      data: {
        productId: 1,
        warehouseId: 10,
        type: 'INCOMING',
        quantity: 5,
        transactionId: 99,
      },
    });
  });

  it('creates a new WarehouseInventory row (onHand=0) on the first-ever movement for a product/warehouse pair', async () => {
    const tx = createMockTx();
    tx.product.findUnique.mockResolvedValue(PRODUCT);
    tx.warehouse.findUnique.mockResolvedValue(WAREHOUSE);
    tx.$queryRaw.mockResolvedValue([]); // no existing row
    tx.warehouseInventory.create.mockResolvedValue({});
    tx.warehouseInventory.update.mockResolvedValue({});
    tx.stockMovement.create.mockResolvedValue({ id: 1 });
    const service = new StockMovementsService(createMockPrisma(tx));

    await service.recordMovement({
      productId: 1,
      warehouseId: 10,
      type: 'INCOMING',
      quantity: 5,
    });

    expect(tx.warehouseInventory.create).toHaveBeenCalledWith({
      data: { productId: 1, warehouseId: 10, onHand: 0 },
    });
    expect(tx.warehouseInventory.update).toHaveBeenCalledWith({
      where: { productId_warehouseId: { productId: 1, warehouseId: 10 } },
      data: { onHand: 5 },
    });
  });

  it('rejects a zero/negative/non-integer quantity without touching the database', async () => {
    const tx = createMockTx();
    const service = new StockMovementsService(createMockPrisma(tx));

    for (const badQuantity of [0, -5, 2.5]) {
      await expect(
        service.recordMovement({
          productId: 1,
          warehouseId: 10,
          type: 'INCOMING',
          quantity: badQuantity,
        }),
      ).rejects.toThrow('quantity must be a positive integer');
    }

    expect(tx.product.findUnique).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('rejects a movement that would drive onHand negative, without writing anything', async () => {
    const tx = createMockTx();
    setupHappyPath(tx, 3); // only 3 on hand
    const service = new StockMovementsService(createMockPrisma(tx));

    await expect(
      service.recordMovement({
        productId: 1,
        warehouseId: 10,
        type: 'OUTGOING',
        quantity: 5, // would go to -2
      }),
    ).rejects.toThrow(/negative onHand/);

    expect(tx.warehouseInventory.update).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('rejects when the product does not exist', async () => {
    const tx = createMockTx();
    tx.product.findUnique.mockResolvedValue(null);
    const service = new StockMovementsService(createMockPrisma(tx));

    await expect(
      service.recordMovement({
        productId: 999,
        warehouseId: 10,
        type: 'INCOMING',
        quantity: 5,
      }),
    ).rejects.toThrow('Product 999 not found');

    expect(tx.warehouse.findUnique).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('rejects when the warehouse does not exist', async () => {
    const tx = createMockTx();
    tx.product.findUnique.mockResolvedValue(PRODUCT);
    tx.warehouse.findUnique.mockResolvedValue(null);
    const service = new StockMovementsService(createMockPrisma(tx));

    await expect(
      service.recordMovement({
        productId: 1,
        warehouseId: 999,
        type: 'INCOMING',
        quantity: 5,
      }),
    ).rejects.toThrow('Warehouse 999 not found');

    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('increases onHand for a positive ADJUSTMENT (signed delta)', async () => {
    const tx = createMockTx();
    setupHappyPath(tx, 100);
    const service = new StockMovementsService(createMockPrisma(tx));

    await service.recordMovement({
      productId: 1,
      warehouseId: 10,
      type: 'ADJUSTMENT',
      quantity: 5,
    });

    expect(tx.warehouseInventory.update).toHaveBeenCalledWith({
      where: { productId_warehouseId: { productId: 1, warehouseId: 10 } },
      data: { onHand: 105 },
    });
  });

  it('decreases onHand for a negative ADJUSTMENT (signed delta)', async () => {
    const tx = createMockTx();
    setupHappyPath(tx, 100);
    const service = new StockMovementsService(createMockPrisma(tx));

    await service.recordMovement({
      productId: 1,
      warehouseId: 10,
      type: 'ADJUSTMENT',
      quantity: -3,
    });

    expect(tx.warehouseInventory.update).toHaveBeenCalledWith({
      where: { productId_warehouseId: { productId: 1, warehouseId: 10 } },
      data: { onHand: 97 },
    });
  });

  it('stores the signed quantity as-is on the StockMovement ledger row for ADJUSTMENT', async () => {
    const tx = createMockTx();
    setupHappyPath(tx, 100);
    const service = new StockMovementsService(createMockPrisma(tx));

    await service.recordMovement({
      productId: 1,
      warehouseId: 10,
      type: 'ADJUSTMENT',
      quantity: -3,
    });

    expect(tx.stockMovement.create).toHaveBeenCalledWith({
      data: {
        productId: 1,
        warehouseId: 10,
        type: 'ADJUSTMENT',
        quantity: -3,
        transactionId: undefined,
      },
    });
  });

  it('rejects an ADJUSTMENT of exactly zero', async () => {
    const tx = createMockTx();
    const service = new StockMovementsService(createMockPrisma(tx));

    await expect(
      service.recordMovement({
        productId: 1,
        warehouseId: 10,
        type: 'ADJUSTMENT',
        quantity: 0,
      }),
    ).rejects.toThrow('ADJUSTMENT quantity must be a non-zero integer');

    expect(tx.product.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a decimal ADJUSTMENT quantity', async () => {
    const tx = createMockTx();
    const service = new StockMovementsService(createMockPrisma(tx));

    await expect(
      service.recordMovement({
        productId: 1,
        warehouseId: 10,
        type: 'ADJUSTMENT',
        quantity: 2.5,
      }),
    ).rejects.toThrow('ADJUSTMENT quantity must be a non-zero integer');

    await expect(
      service.recordMovement({
        productId: 1,
        warehouseId: 10,
        type: 'ADJUSTMENT',
        quantity: -1.5,
      }),
    ).rejects.toThrow('ADJUSTMENT quantity must be a non-zero integer');

    expect(tx.product.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a negative ADJUSTMENT that would make onHand negative', async () => {
    const tx = createMockTx();
    setupHappyPath(tx, 2); // only 2 on hand
    const service = new StockMovementsService(createMockPrisma(tx));

    await expect(
      service.recordMovement({
        productId: 1,
        warehouseId: 10,
        type: 'ADJUSTMENT',
        quantity: -5, // would go to -3
      }),
    ).rejects.toThrow(/negative onHand/);

    expect(tx.warehouseInventory.update).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).not.toHaveBeenCalled();
  });

  it('propagates a ledger-write failure so the whole transaction is rejected (rollback)', async () => {
    const tx = createMockTx();
    setupHappyPath(tx, 10);
    tx.stockMovement.create.mockRejectedValue(
      new Error('simulated DB failure writing StockMovement'),
    );
    const service = new StockMovementsService(createMockPrisma(tx));

    await expect(
      service.recordMovement({
        productId: 1,
        warehouseId: 10,
        type: 'INCOMING',
        quantity: 5,
      }),
    ).rejects.toThrow('simulated DB failure writing StockMovement');

    // Both writes happen inside the single $transaction callback, so a failure
    // here causes Prisma to roll back the onHand update too — nothing commits.
    expect(tx.warehouseInventory.update).toHaveBeenCalled(); // attempted...
    expect(tx.stockMovement.create).toHaveBeenCalled(); // ...but the callback rejected as a whole
  });

  it('reuses a caller-supplied transaction client instead of opening its own', async () => {
    const tx = createMockTx();
    setupHappyPath(tx, 10);
    const prisma = createMockPrisma(tx);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.fn() mock, safe to reference detached
    const transactionSpy = prisma.$transaction as jest.Mock;
    const service = new StockMovementsService(prisma);

    await service.recordMovement(
      { productId: 1, warehouseId: 10, type: 'INCOMING', quantity: 5 },
      tx as never,
    );

    expect(transactionSpy).not.toHaveBeenCalled();
    expect(tx.stockMovement.create).toHaveBeenCalled();
  });
});

function createMockPrismaForLedger() {
  const findMany = jest.fn().mockResolvedValue([]);
  const prisma = { stockMovement: { findMany } } as unknown as PrismaService;
  return { prisma, findMany };
}

describe('StockMovementsService.getLedger', () => {
  it('queries with no filters and orders newest first', async () => {
    const { prisma, findMany } = createMockPrismaForLedger();
    const service = new StockMovementsService(prisma);

    await service.getLedger();

    expect(findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
    });
  });

  it('filters by productId alone', async () => {
    const { prisma, findMany } = createMockPrismaForLedger();
    const service = new StockMovementsService(prisma);

    await service.getLedger({ productId: 1 });

    expect(findMany).toHaveBeenCalledWith({
      where: { productId: 1 },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('filters by warehouseId alone', async () => {
    const { prisma, findMany } = createMockPrismaForLedger();
    const service = new StockMovementsService(prisma);

    await service.getLedger({ warehouseId: 10 });

    expect(findMany).toHaveBeenCalledWith({
      where: { warehouseId: 10 },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('filters by transactionId alone', async () => {
    const { prisma, findMany } = createMockPrismaForLedger();
    const service = new StockMovementsService(prisma);

    await service.getLedger({ transactionId: 99 });

    expect(findMany).toHaveBeenCalledWith({
      where: { transactionId: 99 },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('filters by type alone', async () => {
    const { prisma, findMany } = createMockPrismaForLedger();
    const service = new StockMovementsService(prisma);

    await service.getLedger({ type: 'OUTGOING' });

    expect(findMany).toHaveBeenCalledWith({
      where: { type: 'OUTGOING' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('filters by a date range (dateFrom and dateTo)', async () => {
    const { prisma, findMany } = createMockPrismaForLedger();
    const service = new StockMovementsService(prisma);
    const dateFrom = new Date('2026-01-01T00:00:00Z');
    const dateTo = new Date('2026-01-31T23:59:59Z');

    await service.getLedger({ dateFrom, dateTo });

    expect(findMany).toHaveBeenCalledWith({
      where: { createdAt: { gte: dateFrom, lte: dateTo } },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('filters by dateFrom only (open-ended upper bound)', async () => {
    const { prisma, findMany } = createMockPrismaForLedger();
    const service = new StockMovementsService(prisma);
    const dateFrom = new Date('2026-01-01T00:00:00Z');

    await service.getLedger({ dateFrom });

    expect(findMany).toHaveBeenCalledWith({
      where: { createdAt: { gte: dateFrom } },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('combines multiple filters in one query (AND)', async () => {
    const { prisma, findMany } = createMockPrismaForLedger();
    const service = new StockMovementsService(prisma);

    await service.getLedger({
      productId: 1,
      warehouseId: 10,
      type: 'INCOMING',
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { productId: 1, warehouseId: 10, type: 'INCOMING' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns an empty array when nothing matches, without throwing', async () => {
    const { prisma } = createMockPrismaForLedger(); // findMany already resolves []
    const service = new StockMovementsService(prisma);

    const result = await service.getLedger({ productId: 12345 });

    expect(result).toEqual([]);
  });

  it('does not write anything (read-only)', async () => {
    const { prisma, findMany } = createMockPrismaForLedger();
    const service = new StockMovementsService(prisma);

    await service.getLedger({ productId: 1 });

    expect(findMany).toHaveBeenCalledTimes(1);
    // No other prisma methods exist on this mock at all — getLedger() only
    // ever touches stockMovement.findMany, proving it can't mutate anything.
  });
});
