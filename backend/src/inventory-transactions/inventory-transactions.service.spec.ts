/// <reference types="jest" />

import { InventoryTransactionsService } from './inventory-transactions.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ReservationsService,
  ReserveInput,
} from '../reservations/reservations.service';
import {
  RecordMovementInput,
  StockMovementsService,
} from '../stock-movements/stock-movements.service';
import type {
  Prisma,
  Reservation,
  StockMovement,
} from '../../generated/prisma/client';

function createMockTx() {
  return {
    supplier: { findUnique: jest.fn() },
    warehouse: { findUnique: jest.fn() },
    product: { findUnique: jest.fn() },
    inventoryTransaction: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
    inventoryTransactionItem: { update: jest.fn() },
    reservation: { findFirst: jest.fn(), findMany: jest.fn() },
  };
}

type MockTx = ReturnType<typeof createMockTx>;

function createMockPrismaRoot() {
  return {
    inventoryTransaction: { findUnique: jest.fn(), findMany: jest.fn() },
  };
}

type MockPrismaRoot = ReturnType<typeof createMockPrismaRoot>;

function createMockPrisma(tx: MockTx, root: MockPrismaRoot) {
  return {
    ...root,
    $transaction: jest.fn((callback: (tx: MockTx) => unknown) => callback(tx)),
  } as unknown as PrismaService;
}

function createMockReservationsService() {
  const reserve = jest.fn<
    Promise<Reservation>,
    [ReserveInput, Prisma.TransactionClient?]
  >();
  reserve.mockResolvedValue({ id: 1, status: 'ACTIVE' } as Reservation);
  const fulfill = jest.fn<
    Promise<Reservation>,
    [number, Prisma.TransactionClient?]
  >();
  fulfill.mockResolvedValue({ id: 1, status: 'FULFILLED' } as Reservation);
  const release = jest.fn<
    Promise<Reservation>,
    [number, Prisma.TransactionClient?]
  >();
  release.mockResolvedValue({ id: 1, status: 'CANCELLED' } as Reservation);
  const service = {
    reserve,
    fulfill,
    release,
  } as unknown as ReservationsService;
  return { service, reserve, fulfill, release };
}

function createMockStockMovementsService() {
  const recordMovement = jest.fn<
    Promise<StockMovement>,
    [RecordMovementInput, Prisma.TransactionClient?]
  >();
  recordMovement.mockResolvedValue({ id: 1 } as StockMovement);
  const service = { recordMovement } as unknown as StockMovementsService;
  return { service, recordMovement };
}

function buildService(tx: MockTx) {
  const {
    service: reservationsService,
    reserve,
    fulfill,
    release,
  } = createMockReservationsService();
  const { service: stockMovementsService, recordMovement } =
    createMockStockMovementsService();
  const prismaRoot = createMockPrismaRoot();
  const service = new InventoryTransactionsService(
    createMockPrisma(tx, prismaRoot),
    reservationsService,
    stockMovementsService,
  );
  return { service, reserve, fulfill, release, recordMovement, prismaRoot };
}

const SUPPLIER = { id: 1, name: 'Acme Supplies', isActive: true };
const WAREHOUSE_A = { id: 10, name: 'Warehouse A', isActive: true };
const WAREHOUSE_B = { id: 20, name: 'Warehouse B', isActive: true };
const PRODUCT = { id: 100, name: 'Widget', isActive: true };

function setupExistenceChecks(tx: MockTx) {
  tx.supplier.findUnique.mockResolvedValue(SUPPLIER);
  tx.warehouse.findUnique.mockImplementation(
    ({ where }: { where: { id: number } }) => {
      if (where.id === WAREHOUSE_A.id) return Promise.resolve(WAREHOUSE_A);
      if (where.id === WAREHOUSE_B.id) return Promise.resolve(WAREHOUSE_B);
      return Promise.resolve(null);
    },
  );
  tx.product.findUnique.mockResolvedValue(PRODUCT);
}

describe('InventoryTransactionsService.createIncoming', () => {
  it('bug fix: rejects a duplicate productId across items', async () => {
    const tx = createMockTx();
    const { service } = buildService(tx);

    await expect(
      service.createIncoming({
        supplierId: 1,
        destinationWarehouseId: 10,
        items: [
          { productId: 100, quantity: 5, price: 10 },
          { productId: 100, quantity: 3, price: 12 },
        ],
      }),
    ).rejects.toThrow('Duplicate productId 100 in items');

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
  });

  it('creates a PENDING INCOMING transaction with its items and touches no reservation/stock', async () => {
    const tx = createMockTx();
    setupExistenceChecks(tx);
    tx.inventoryTransaction.create.mockResolvedValue({
      id: 1,
      type: 'INCOMING',
      status: 'PENDING',
      items: [{ productId: 100, quantity: 5, price: 10 }],
    });
    const { service, reserve, recordMovement } = buildService(tx);

    const result = await service.createIncoming({
      supplierId: 1,
      destinationWarehouseId: 10,
      items: [{ productId: 100, quantity: 5, price: 10 }],
    });

    expect(tx.inventoryTransaction.create).toHaveBeenCalledWith({
      data: {
        type: 'INCOMING',
        status: 'PENDING',
        supplierId: 1,
        destinationWarehouseId: 10,
        expectedDate: undefined,
        documentUrl: undefined,
        items: { create: [{ productId: 100, quantity: 5, price: 10 }] },
      },
      include: { items: true },
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(recordMovement).not.toHaveBeenCalled();
    expect(result.status).toBe('PENDING');
  });

  it('rejects when the supplier does not exist', async () => {
    const tx = createMockTx();
    tx.supplier.findUnique.mockResolvedValue(null);
    const { service } = buildService(tx);

    await expect(
      service.createIncoming({
        supplierId: 999,
        destinationWarehouseId: 10,
        items: [{ productId: 100, quantity: 5, price: 10 }],
      }),
    ).rejects.toThrow('Supplier 999 not found');

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects when the supplier is inactive', async () => {
    const tx = createMockTx();
    tx.supplier.findUnique.mockResolvedValue({ ...SUPPLIER, isActive: false });
    const { service } = buildService(tx);

    await expect(
      service.createIncoming({
        supplierId: 1,
        destinationWarehouseId: 10,
        items: [{ productId: 100, quantity: 5, price: 10 }],
      }),
    ).rejects.toThrow(
      'Supplier 1 is inactive and cannot be used for a new transaction',
    );

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects when the destination warehouse does not exist', async () => {
    const tx = createMockTx();
    tx.supplier.findUnique.mockResolvedValue(SUPPLIER);
    tx.warehouse.findUnique.mockResolvedValue(null);
    const { service } = buildService(tx);

    await expect(
      service.createIncoming({
        supplierId: 1,
        destinationWarehouseId: 999,
        items: [{ productId: 100, quantity: 5, price: 10 }],
      }),
    ).rejects.toThrow('Warehouse 999 not found');

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects when the destination warehouse is inactive', async () => {
    const tx = createMockTx();
    tx.supplier.findUnique.mockResolvedValue(SUPPLIER);
    tx.warehouse.findUnique.mockResolvedValue({
      ...WAREHOUSE_A,
      isActive: false,
    });
    const { service } = buildService(tx);

    await expect(
      service.createIncoming({
        supplierId: 1,
        destinationWarehouseId: 10,
        items: [{ productId: 100, quantity: 5, price: 10 }],
      }),
    ).rejects.toThrow(
      'Warehouse 10 is inactive and cannot be used for a new transaction',
    );

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects when a product does not exist', async () => {
    const tx = createMockTx();
    tx.supplier.findUnique.mockResolvedValue(SUPPLIER);
    tx.warehouse.findUnique.mockResolvedValue(WAREHOUSE_A);
    tx.product.findUnique.mockResolvedValue(null);
    const { service } = buildService(tx);

    await expect(
      service.createIncoming({
        supplierId: 1,
        destinationWarehouseId: 10,
        items: [{ productId: 999, quantity: 5, price: 10 }],
      }),
    ).rejects.toThrow('Product 999 not found');

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects when a product is inactive', async () => {
    const tx = createMockTx();
    tx.supplier.findUnique.mockResolvedValue(SUPPLIER);
    tx.warehouse.findUnique.mockResolvedValue(WAREHOUSE_A);
    tx.product.findUnique.mockResolvedValue({ ...PRODUCT, isActive: false });
    const { service } = buildService(tx);

    await expect(
      service.createIncoming({
        supplierId: 1,
        destinationWarehouseId: 10,
        items: [{ productId: 100, quantity: 5, price: 10 }],
      }),
    ).rejects.toThrow(
      'Product 100 is inactive and cannot be used for a new transaction',
    );

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects an item without a price (purchase items must have a price)', async () => {
    const tx = createMockTx();
    const { service } = buildService(tx);

    await expect(
      service.createIncoming({
        supplierId: 1,
        destinationWarehouseId: 10,
        items: [{ productId: 100, quantity: 5 }],
      }),
    ).rejects.toThrow(
      'price is required for product 100 on a purchase (INCOMING) transaction',
    );

    expect(tx.supplier.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an item with an explicit null price (missing price is never treated as 0)', async () => {
    const tx = createMockTx();
    const { service } = buildService(tx);

    await expect(
      service.createIncoming({
        supplierId: 1,
        destinationWarehouseId: 10,
        items: [{ productId: 100, quantity: 5, price: null as never }],
      }),
    ).rejects.toThrow(
      'price is required for product 100 on a purchase (INCOMING) transaction',
    );
  });

  it('rejects a negative or non-finite price', async () => {
    const tx = createMockTx();
    const { service } = buildService(tx);

    for (const badPrice of [-1, NaN, Infinity]) {
      await expect(
        service.createIncoming({
          supplierId: 1,
          destinationWarehouseId: 10,
          items: [{ productId: 100, quantity: 5, price: badPrice }],
        }),
      ).rejects.toThrow('price for product 100 must be a non-negative number');
    }
  });

  it('rejects empty items without touching the database', async () => {
    const tx = createMockTx();
    const { service } = buildService(tx);

    await expect(
      service.createIncoming({
        supplierId: 1,
        destinationWarehouseId: 10,
        items: [],
      }),
    ).rejects.toThrow('items must not be empty');

    expect(tx.supplier.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a non-positive/non-integer quantity', async () => {
    const tx = createMockTx();
    const { service } = buildService(tx);

    for (const badQuantity of [0, -1, 1.5]) {
      await expect(
        service.createIncoming({
          supplierId: 1,
          destinationWarehouseId: 10,
          items: [{ productId: 100, quantity: badQuantity }],
        }),
      ).rejects.toThrow(/must be a positive integer/);
    }

    expect(tx.supplier.findUnique).not.toHaveBeenCalled();
  });
});

describe('InventoryTransactionsService.createOutgoing', () => {
  it('bug fix: rejects a duplicate productId across items (would make later reservation lookups by productId ambiguous)', async () => {
    const tx = createMockTx();
    const { service, reserve } = buildService(tx);

    await expect(
      service.createOutgoing({
        sourceWarehouseId: 10,
        items: [
          { productId: 100, quantity: 5 },
          { productId: 100, quantity: 3 },
        ],
      }),
    ).rejects.toThrow('Duplicate productId 100 in items');

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('creates a PENDING OUTGOING transaction and reserves every item at the source warehouse', async () => {
    const tx = createMockTx();
    setupExistenceChecks(tx);
    tx.inventoryTransaction.create.mockResolvedValue({
      id: 5,
      type: 'OUTGOING',
      status: 'PENDING',
      items: [
        { productId: 200, quantity: 2 },
        { productId: 100, quantity: 5 },
      ],
    });
    const { service, reserve } = buildService(tx);

    const result = await service.createOutgoing({
      sourceWarehouseId: 10,
      partyName: 'Customer X',
      items: [
        { productId: 200, quantity: 2 },
        { productId: 100, quantity: 5 },
      ],
    });

    expect(tx.inventoryTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest matcher, not real data
        data: expect.objectContaining({
          type: 'OUTGOING',
          status: 'PENDING',
          sourceWarehouseId: 10,
          partyName: 'Customer X',
        }),
      }),
    );
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve.mock.calls[0][0]).toEqual({
      transactionId: 5,
      productId: 100,
      warehouseId: 10,
      quantity: 5,
    });
    expect(reserve.mock.calls[1][0]).toEqual({
      transactionId: 5,
      productId: 200,
      warehouseId: 10,
      quantity: 2,
    });
    expect(reserve.mock.calls[0][1]).toBe(tx);
    expect(result.status).toBe('PENDING');
  });

  it('confirmed rule: the transaction -> reservation flow validates active warehouse/product BEFORE reserve() runs, and reserve() itself performs no isActive check (InventoryTransactionsService is the sole controlled entry point)', async () => {
    const tx = createMockTx();
    const callOrder: string[] = [];
    tx.warehouse.findUnique.mockImplementation(() => {
      callOrder.push('assertWarehouseExists');
      return Promise.resolve(WAREHOUSE_A);
    });
    tx.product.findUnique.mockImplementation(() => {
      callOrder.push('assertProductsExist');
      return Promise.resolve(PRODUCT);
    });
    tx.inventoryTransaction.create.mockResolvedValue({
      id: 5,
      type: 'OUTGOING',
      status: 'PENDING',
      items: [{ productId: 100, quantity: 5 }],
    });
    const { service, reserve } = buildService(tx);
    reserve.mockImplementation(() => {
      callOrder.push('reserve');
      return Promise.resolve({ id: 1, status: 'ACTIVE' } as never);
    });

    const result = await service.createOutgoing({
      sourceWarehouseId: 10,
      items: [{ productId: 100, quantity: 5 }],
    });

    expect(callOrder).toEqual([
      'assertWarehouseExists',
      'assertProductsExist',
      'reserve',
    ]);
    expect(result.status).toBe('PENDING');
  });

  it('rejects when the source warehouse does not exist', async () => {
    const tx = createMockTx();
    tx.warehouse.findUnique.mockResolvedValue(null);
    const { service, reserve } = buildService(tx);

    await expect(
      service.createOutgoing({
        sourceWarehouseId: 999,
        items: [{ productId: 100, quantity: 5 }],
      }),
    ).rejects.toThrow('Warehouse 999 not found');

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects when the source warehouse is inactive', async () => {
    const tx = createMockTx();
    tx.warehouse.findUnique.mockResolvedValue({
      ...WAREHOUSE_A,
      isActive: false,
    });
    const { service, reserve } = buildService(tx);

    await expect(
      service.createOutgoing({
        sourceWarehouseId: 10,
        items: [{ productId: 100, quantity: 5 }],
      }),
    ).rejects.toThrow(
      'Warehouse 10 is inactive and cannot be used for a new transaction',
    );

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects when a product is inactive', async () => {
    const tx = createMockTx();
    tx.warehouse.findUnique.mockResolvedValue(WAREHOUSE_A);
    tx.product.findUnique.mockResolvedValue({ ...PRODUCT, isActive: false });
    const { service, reserve } = buildService(tx);

    await expect(
      service.createOutgoing({
        sourceWarehouseId: 10,
        items: [{ productId: 100, quantity: 5 }],
      }),
    ).rejects.toThrow(
      'Product 100 is inactive and cannot be used for a new transaction',
    );

    expect(reserve).not.toHaveBeenCalled();
  });

  it('propagates a reservation failure so the whole transaction rolls back', async () => {
    const tx = createMockTx();
    setupExistenceChecks(tx);
    tx.inventoryTransaction.create.mockResolvedValue({
      id: 5,
      type: 'OUTGOING',
      status: 'PENDING',
      items: [{ productId: 100, quantity: 5 }],
    });
    const { service, reserve } = buildService(tx);
    reserve.mockRejectedValue(new Error('Insufficient available stock'));

    await expect(
      service.createOutgoing({
        sourceWarehouseId: 10,
        items: [{ productId: 100, quantity: 5 }],
      }),
    ).rejects.toThrow('Insufficient available stock');
  });
});

describe('InventoryTransactionsService.createTransfer', () => {
  it('bug fix: rejects a duplicate productId across items', async () => {
    const tx = createMockTx();
    const { service, reserve } = buildService(tx);

    await expect(
      service.createTransfer({
        sourceWarehouseId: 10,
        destinationWarehouseId: 20,
        items: [
          { productId: 100, quantity: 3 },
          { productId: 100, quantity: 2 },
        ],
      }),
    ).rejects.toThrow('Duplicate productId 100 in items');

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('creates a PENDING TRANSFER transaction and reserves stock at the SOURCE warehouse only', async () => {
    const tx = createMockTx();
    setupExistenceChecks(tx);
    tx.inventoryTransaction.create.mockResolvedValue({
      id: 7,
      type: 'TRANSFER',
      status: 'PENDING',
      items: [{ productId: 100, quantity: 3 }],
    });
    const { service, reserve } = buildService(tx);

    await service.createTransfer({
      sourceWarehouseId: 10,
      destinationWarehouseId: 20,
      items: [{ productId: 100, quantity: 3 }],
    });

    expect(tx.inventoryTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest matcher, not real data
        data: expect.objectContaining({
          type: 'TRANSFER',
          sourceWarehouseId: 10,
          destinationWarehouseId: 20,
        }),
      }),
    );
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith(
      { transactionId: 7, productId: 100, warehouseId: 10, quantity: 3 },
      tx,
    );
  });

  it('rejects when source and destination warehouses are the same', async () => {
    const tx = createMockTx();
    const { service, reserve } = buildService(tx);

    await expect(
      service.createTransfer({
        sourceWarehouseId: 10,
        destinationWarehouseId: 10,
        items: [{ productId: 100, quantity: 3 }],
      }),
    ).rejects.toThrow(
      'sourceWarehouseId and destinationWarehouseId must be different',
    );

    expect(tx.warehouse.findUnique).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects when the destination warehouse does not exist', async () => {
    const tx = createMockTx();
    tx.warehouse.findUnique.mockImplementation(
      ({ where }: { where: { id: number } }) =>
        Promise.resolve(where.id === WAREHOUSE_A.id ? WAREHOUSE_A : null),
    );
    const { service, reserve } = buildService(tx);

    await expect(
      service.createTransfer({
        sourceWarehouseId: 10,
        destinationWarehouseId: 999,
        items: [{ productId: 100, quantity: 3 }],
      }),
    ).rejects.toThrow('Warehouse 999 not found');

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects when the source warehouse is inactive', async () => {
    const tx = createMockTx();
    tx.warehouse.findUnique.mockResolvedValue({
      ...WAREHOUSE_A,
      isActive: false,
    });
    const { service, reserve } = buildService(tx);

    await expect(
      service.createTransfer({
        sourceWarehouseId: 10,
        destinationWarehouseId: 20,
        items: [{ productId: 100, quantity: 3 }],
      }),
    ).rejects.toThrow(
      'Warehouse 10 is inactive and cannot be used for a new transaction',
    );

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects when the destination warehouse is inactive', async () => {
    const tx = createMockTx();
    tx.warehouse.findUnique.mockImplementation(
      ({ where }: { where: { id: number } }) =>
        Promise.resolve(
          where.id === WAREHOUSE_A.id
            ? WAREHOUSE_A
            : { ...WAREHOUSE_B, id: where.id, isActive: false },
        ),
    );
    const { service, reserve } = buildService(tx);

    await expect(
      service.createTransfer({
        sourceWarehouseId: 10,
        destinationWarehouseId: 20,
        items: [{ productId: 100, quantity: 3 }],
      }),
    ).rejects.toThrow(
      'Warehouse 20 is inactive and cannot be used for a new transaction',
    );

    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects when a product is inactive', async () => {
    const tx = createMockTx();
    tx.warehouse.findUnique.mockResolvedValue(WAREHOUSE_A);
    tx.product.findUnique.mockResolvedValue({ ...PRODUCT, isActive: false });
    const { service, reserve } = buildService(tx);

    await expect(
      service.createTransfer({
        sourceWarehouseId: 10,
        destinationWarehouseId: 20,
        items: [{ productId: 100, quantity: 3 }],
      }),
    ).rejects.toThrow(
      'Product 100 is inactive and cannot be used for a new transaction',
    );

    expect(reserve).not.toHaveBeenCalled();
  });

  it('reuses a caller-supplied transaction client instead of opening its own', async () => {
    const tx = createMockTx();
    setupExistenceChecks(tx);
    tx.inventoryTransaction.create.mockResolvedValue({
      id: 7,
      type: 'TRANSFER',
      status: 'PENDING',
      items: [{ productId: 100, quantity: 3 }],
    });
    const prisma = createMockPrisma(tx, createMockPrismaRoot());
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.fn() mock, safe to reference detached
    const transactionSpy = prisma.$transaction as jest.Mock;
    const { service: reservationsService } = createMockReservationsService();
    const { service: stockMovementsService } =
      createMockStockMovementsService();
    const service = new InventoryTransactionsService(
      prisma,
      reservationsService,
      stockMovementsService,
    );

    await service.createTransfer(
      {
        sourceWarehouseId: 10,
        destinationWarehouseId: 20,
        items: [{ productId: 100, quantity: 3 }],
      },
      tx as never,
    );

    expect(transactionSpy).not.toHaveBeenCalled();
  });
});

describe('InventoryTransactionsService.complete', () => {
  it('completes a PENDING INCOMING transaction via recordMovement(INCOMING) per item', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    const txnRow = {
      id: 1,
      type: 'INCOMING',
      status: 'COMPLETED',
      destinationWarehouseId: 10,
      sourceWarehouseId: null,
      items: [
        { id: 1, productId: 100, quantity: 5 },
        { id: 2, productId: 200, quantity: 2 },
      ],
    };
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue(txnRow);
    const { service, fulfill, recordMovement } = buildService(tx);

    const result = await service.complete(1);

    expect(tx.inventoryTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: 'PENDING' },
      data: { status: 'COMPLETED', actualDate: expect.any(Date) as Date },
    });
    expect(recordMovement).toHaveBeenCalledTimes(2);
    expect(recordMovement).toHaveBeenNthCalledWith(
      1,
      {
        productId: 100,
        warehouseId: 10,
        type: 'INCOMING',
        quantity: 5,
        transactionId: 1,
      },
      tx,
    );
    expect(fulfill).not.toHaveBeenCalled();
    expect(result.status).toBe('COMPLETED');
  });

  it('completes a PENDING OUTGOING transaction by fulfilling each ACTIVE reservation', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    const txnRow = {
      id: 2,
      type: 'OUTGOING',
      status: 'COMPLETED',
      sourceWarehouseId: 10,
      destinationWarehouseId: null,
      items: [{ id: 1, productId: 100, quantity: 5 }],
    };
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue(txnRow);
    tx.reservation.findFirst.mockResolvedValue({
      id: 55,
      productId: 100,
      status: 'ACTIVE',
    });
    const { service, fulfill, recordMovement } = buildService(tx);

    await service.complete(2);

    expect(fulfill).toHaveBeenCalledWith(55, tx);
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('completes a PENDING TRANSFER by fulfilling the source reservation and recording TRANSFER_IN at the destination, in deterministic (warehouseId, productId) order', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    const txnRow = {
      id: 3,
      type: 'TRANSFER',
      status: 'COMPLETED',
      sourceWarehouseId: 10,
      destinationWarehouseId: 20,
      items: [{ id: 1, productId: 100, quantity: 3 }],
    };
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue(txnRow);
    tx.reservation.findFirst.mockResolvedValue({
      id: 77,
      productId: 100,
      status: 'ACTIVE',
    });
    const callOrder: string[] = [];
    const { service, fulfill, recordMovement } = buildService(tx);
    fulfill.mockImplementation(() => {
      callOrder.push('fulfill-source');
      return Promise.resolve({ id: 77, status: 'FULFILLED' } as Reservation);
    });
    recordMovement.mockImplementation(() => {
      callOrder.push('recordMovement-destination');
      return Promise.resolve({ id: 1 } as StockMovement);
    });

    await service.complete(3);

    // sourceWarehouseId=10 < destinationWarehouseId=20 -> source op runs first
    expect(callOrder).toEqual(['fulfill-source', 'recordMovement-destination']);
    expect(fulfill).toHaveBeenCalledWith(77, tx);
    expect(recordMovement).toHaveBeenCalledWith(
      {
        productId: 100,
        warehouseId: 20,
        type: 'TRANSFER_IN',
        quantity: 3,
        transactionId: 3,
      },
      tx,
    );
  });

  it('rejects completing a transaction that is not PENDING', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 0 });
    tx.inventoryTransaction.findUnique.mockResolvedValue({
      id: 1,
      status: 'CANCELLED',
    });
    const { service, recordMovement } = buildService(tx);

    await expect(service.complete(1)).rejects.toThrow(
      'InventoryTransaction 1 is not PENDING (status: CANCELLED) — cannot complete',
    );
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('rejects completing a transaction that does not exist', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 0 });
    tx.inventoryTransaction.findUnique.mockResolvedValue(null);
    const { service } = buildService(tx);

    await expect(service.complete(999)).rejects.toThrow(
      'InventoryTransaction 999 not found',
    );
  });

  it('rejects completion when an OUTGOING item has no ACTIVE reservation (data integrity guard)', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 2,
      type: 'OUTGOING',
      sourceWarehouseId: 10,
      items: [{ id: 1, productId: 100, quantity: 5 }],
    });
    tx.reservation.findFirst.mockResolvedValue(null);
    const { service, fulfill } = buildService(tx);

    await expect(service.complete(2)).rejects.toThrow(
      'No ACTIVE reservation found for product 100 on transaction 2',
    );
    expect(fulfill).not.toHaveBeenCalled();
  });
});

describe('InventoryTransactionsService.cancel', () => {
  it('cancels a PENDING transaction and releases every ACTIVE reservation, never touching stock', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.reservation.findMany.mockResolvedValue([
      { id: 1, status: 'ACTIVE' },
      { id: 2, status: 'ACTIVE' },
    ]);
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 5,
      status: 'CANCELLED',
      items: [],
    });
    const { service, release, recordMovement } = buildService(tx);

    const result = await service.cancel(5);

    expect(tx.inventoryTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: 5, status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledWith(1, tx);
    expect(release).toHaveBeenCalledWith(2, tx);
    expect(recordMovement).not.toHaveBeenCalled();
    expect(result.status).toBe('CANCELLED');
  });

  it('is a no-op on reservations for an INCOMING transaction (none exist)', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.reservation.findMany.mockResolvedValue([]);
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 6,
      status: 'CANCELLED',
      items: [],
    });
    const { service, release } = buildService(tx);

    await service.cancel(6);

    expect(release).not.toHaveBeenCalled();
  });

  it('rejects cancelling an already-completed transaction', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 0 });
    tx.inventoryTransaction.findUnique.mockResolvedValue({
      id: 5,
      status: 'COMPLETED',
    });
    const { service, release } = buildService(tx);

    await expect(service.cancel(5)).rejects.toThrow(
      'InventoryTransaction 5 is not PENDING (status: COMPLETED) — cannot cancel',
    );
    expect(release).not.toHaveBeenCalled();
  });

  it('rejects cancelling an already-cancelled transaction', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 0 });
    tx.inventoryTransaction.findUnique.mockResolvedValue({
      id: 5,
      status: 'CANCELLED',
    });
    const { service } = buildService(tx);

    await expect(service.cancel(5)).rejects.toThrow(
      'InventoryTransaction 5 is not PENDING (status: CANCELLED) — cannot cancel',
    );
  });
});

describe('InventoryTransactionsService.update', () => {
  it('synchronizes the reservation when an item quantity changes (release old, reserve new)', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      type: 'OUTGOING',
      sourceWarehouseId: 10,
      destinationWarehouseId: null,
      items: [{ id: 11, productId: 100, quantity: 5 }],
    });
    tx.reservation.findFirst.mockResolvedValue({
      id: 99,
      productId: 100,
      status: 'ACTIVE',
    });
    const { service, release, reserve } = buildService(tx);

    await service.update(1, { items: [{ itemId: 11, quantity: 8 }] });

    expect(release).toHaveBeenCalledWith(99, tx);
    expect(reserve).toHaveBeenCalledWith(
      { transactionId: 1, productId: 100, warehouseId: 10, quantity: 8 },
      tx,
    );
    expect(tx.inventoryTransactionItem.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { quantity: 8 },
    });
  });

  it('confirmed rule: a quantity-only change never re-validates the unchanged product — succeeds even if that product has since become inactive', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      type: 'OUTGOING',
      sourceWarehouseId: 10,
      destinationWarehouseId: null,
      items: [{ id: 11, productId: 100, quantity: 5 }],
    });
    tx.reservation.findFirst.mockResolvedValue({
      id: 99,
      productId: 100,
      status: 'ACTIVE',
    });
    // Deliberately never stub tx.product.findUnique to resolve a value —
    // if update() ever called it for this unchanged item, the mock would
    // resolve `undefined` and the (existing) assertProductsExist NotFound
    // check would make this test fail, proving the product is never
    // re-checked.
    const { service, release, reserve } = buildService(tx);

    await expect(
      service.update(1, { items: [{ itemId: 11, quantity: 9 }] }),
    ).resolves.toBeDefined();

    expect(tx.product.findUnique).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(99, tx);
    expect(reserve).toHaveBeenCalledWith(
      { transactionId: 1, productId: 100, warehouseId: 10, quantity: 9 },
      tx,
    );
  });

  it('confirmed rule: an item change never re-validates the unchanged sourceWarehouseId — succeeds even if that warehouse has since become inactive', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      type: 'OUTGOING',
      sourceWarehouseId: 10,
      destinationWarehouseId: null,
      items: [{ id: 11, productId: 100, quantity: 5 }],
    });
    tx.reservation.findFirst.mockResolvedValue({
      id: 99,
      productId: 100,
      status: 'ACTIVE',
    });
    // sourceWarehouseId is NOT part of this update input, so
    // assertWarehouseExists must never be called for it, regardless of
    // whether warehouse 10 is active or inactive in reality.
    const { service, release, reserve } = buildService(tx);

    await expect(
      service.update(1, { items: [{ itemId: 11, quantity: 9 }] }),
    ).resolves.toBeDefined();

    expect(tx.warehouse.findUnique).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(99, tx);
    expect(reserve).toHaveBeenCalledWith(
      { transactionId: 1, productId: 100, warehouseId: 10, quantity: 9 },
      tx,
    );
  });

  it('synchronizes the reservation when an item product changes', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      type: 'OUTGOING',
      sourceWarehouseId: 10,
      destinationWarehouseId: null,
      items: [{ id: 11, productId: 100, quantity: 5 }],
    });
    tx.reservation.findFirst.mockResolvedValue({
      id: 99,
      productId: 100,
      status: 'ACTIVE',
    });
    tx.product.findUnique.mockResolvedValue({
      id: 200,
      name: 'Gadget',
      isActive: true,
    });
    const { service, release, reserve } = buildService(tx);

    await service.update(1, { items: [{ itemId: 11, productId: 200 }] });

    expect(tx.product.findUnique).toHaveBeenCalledWith({ where: { id: 200 } });
    expect(release).toHaveBeenCalledWith(99, tx);
    expect(reserve).toHaveBeenCalledWith(
      { transactionId: 1, productId: 200, warehouseId: 10, quantity: 5 },
      tx,
    );
  });

  it('resynchronizes every item when sourceWarehouseId changes', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      type: 'TRANSFER',
      sourceWarehouseId: 10,
      destinationWarehouseId: 30,
      items: [
        { id: 11, productId: 100, quantity: 5 },
        { id: 12, productId: 200, quantity: 2 },
      ],
    });
    tx.warehouse.findUnique.mockResolvedValue(WAREHOUSE_B);
    tx.reservation.findFirst.mockResolvedValue({
      id: 99,
      productId: 100,
      status: 'ACTIVE',
    });
    const { service, release, reserve } = buildService(tx);

    await service.update(1, { sourceWarehouseId: 20 });

    expect(release).toHaveBeenCalledTimes(2);
    expect(reserve).toHaveBeenCalledTimes(2);
    expect(reserve.mock.calls[0][0]).toEqual({
      transactionId: 1,
      productId: 100,
      warehouseId: 20,
      quantity: 5,
    });
    expect(tx.inventoryTransaction.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { sourceWarehouseId: 20 },
    });
  });

  it('rejects changing to an inactive product', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      type: 'OUTGOING',
      sourceWarehouseId: 10,
      destinationWarehouseId: null,
      items: [{ id: 11, productId: 100, quantity: 5 }],
    });
    tx.product.findUnique.mockResolvedValue({
      id: 200,
      name: 'Gadget',
      isActive: false,
    });
    const { service, release, reserve } = buildService(tx);

    await expect(
      service.update(1, { items: [{ itemId: 11, productId: 200 }] }),
    ).rejects.toThrow(
      'Product 200 is inactive and cannot be used for a new transaction',
    );

    expect(release).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects changing sourceWarehouseId to an inactive warehouse', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      type: 'TRANSFER',
      sourceWarehouseId: 10,
      destinationWarehouseId: 30,
      items: [{ id: 11, productId: 100, quantity: 5 }],
    });
    tx.warehouse.findUnique.mockResolvedValue({
      ...WAREHOUSE_B,
      isActive: false,
    });
    const { service, release, reserve } = buildService(tx);

    await expect(service.update(1, { sourceWarehouseId: 20 })).rejects.toThrow(
      'Warehouse 20 is inactive and cannot be used for a new transaction',
    );

    expect(release).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it('rejects sourceWarehouseId equal to destinationWarehouseId', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      type: 'TRANSFER',
      sourceWarehouseId: 10,
      destinationWarehouseId: 20,
      items: [{ id: 11, productId: 100, quantity: 5 }],
    });
    const { service, reserve } = buildService(tx);

    await expect(service.update(1, { sourceWarehouseId: 20 })).rejects.toThrow(
      'sourceWarehouseId and destinationWarehouseId must be different',
    );
    expect(reserve).not.toHaveBeenCalled();
  });

  it('updates an INCOMING transaction item directly, with no reservation involved', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      type: 'INCOMING',
      sourceWarehouseId: null,
      destinationWarehouseId: 10,
      items: [{ id: 11, productId: 100, quantity: 5 }],
    });
    const { service, release, reserve } = buildService(tx);

    await service.update(1, { items: [{ itemId: 11, quantity: 9 }] });

    expect(release).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(tx.inventoryTransactionItem.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: { quantity: 9 },
    });
  });

  it('rolls back (including the already-released old reservation) when the new reservation fails', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      type: 'OUTGOING',
      sourceWarehouseId: 10,
      destinationWarehouseId: null,
      items: [{ id: 11, productId: 100, quantity: 5 }],
    });
    tx.reservation.findFirst.mockResolvedValue({
      id: 99,
      productId: 100,
      status: 'ACTIVE',
    });
    const { service, release, reserve } = buildService(tx);
    reserve.mockRejectedValue(new Error('Insufficient available stock'));

    await expect(
      service.update(1, { items: [{ itemId: 11, quantity: 999 }] }),
    ).rejects.toThrow('Insufficient available stock');

    // release() was still called before the failing reserve() — this proves
    // the whole operation is wrapped in one transaction, so the DB rollback
    // (not application code) is what restores the old reservation.
    expect(release).toHaveBeenCalledWith(99, tx);
  });

  it('rejects updating an item that does not belong to the transaction', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 1 });
    tx.inventoryTransaction.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      type: 'OUTGOING',
      sourceWarehouseId: 10,
      items: [{ id: 11, productId: 100, quantity: 5 }],
    });
    const { service } = buildService(tx);

    await expect(
      service.update(1, { items: [{ itemId: 999, quantity: 1 }] }),
    ).rejects.toThrow('Transaction item 999 not found on transaction 1');
  });

  it('rejects updating a transaction that is not PENDING', async () => {
    const tx = createMockTx();
    tx.inventoryTransaction.updateMany.mockResolvedValue({ count: 0 });
    tx.inventoryTransaction.findUnique.mockResolvedValue({
      id: 1,
      status: 'COMPLETED',
    });
    const { service } = buildService(tx);

    await expect(
      service.update(1, { items: [{ itemId: 11, quantity: 1 }] }),
    ).rejects.toThrow(
      'InventoryTransaction 1 is not PENDING (status: COMPLETED) — cannot update',
    );
  });

  it('rejects a non-positive/non-integer quantity change without claiming the transaction', async () => {
    const tx = createMockTx();
    const { service } = buildService(tx);

    await expect(
      service.update(1, { items: [{ itemId: 11, quantity: -1 }] }),
    ).rejects.toThrow(/must be a positive integer/);

    expect(tx.inventoryTransaction.updateMany).not.toHaveBeenCalled();
  });
});

describe('InventoryTransactionsService.findOneTransaction', () => {
  it('returns a transaction with its items', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    const txnRow = {
      id: 1,
      type: 'OUTGOING',
      status: 'PENDING',
      items: [{ id: 11, productId: 100, quantity: 5 }],
    };
    prismaRoot.inventoryTransaction.findUnique.mockResolvedValue(txnRow);

    const result = await service.findOneTransaction(1);

    expect(prismaRoot.inventoryTransaction.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      include: { items: true },
    });
    expect(result).toEqual(txnRow);
  });

  it('remains readable for a historical transaction whose product/warehouse have since become inactive (no isActive filter on reads)', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    const txnRow = {
      id: 1,
      type: 'OUTGOING',
      status: 'COMPLETED',
      sourceWarehouseId: 10,
      items: [{ id: 11, productId: 100, quantity: 5 }],
    };
    prismaRoot.inventoryTransaction.findUnique.mockResolvedValue(txnRow);

    const result = await service.findOneTransaction(1);

    // No isActive-related where clause was ever applied to this read.
    expect(prismaRoot.inventoryTransaction.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      include: { items: true },
    });
    expect(result).toEqual(txnRow);
  });

  it('throws NotFoundException when the transaction does not exist', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findUnique.mockResolvedValue(null);

    await expect(service.findOneTransaction(999)).rejects.toThrow(
      'InventoryTransaction 999 not found',
    );
  });

  it('does not touch stock, reservations, or transaction status', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, reserve, fulfill, release, recordMovement } =
      buildService(tx);
    prismaRoot.inventoryTransaction.findUnique.mockResolvedValue({
      id: 1,
      status: 'PENDING',
      items: [],
    });

    await service.findOneTransaction(1);

    expect(reserve).not.toHaveBeenCalled();
    expect(fulfill).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(recordMovement).not.toHaveBeenCalled();
    expect(tx.inventoryTransaction.update).not.toHaveBeenCalled();
    expect(tx.inventoryTransaction.updateMany).not.toHaveBeenCalled();
  });

  it('reuses a caller-supplied transaction client instead of the default prisma client', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    tx.inventoryTransaction.findUnique.mockResolvedValue({
      id: 1,
      status: 'PENDING',
      items: [],
    });

    await service.findOneTransaction(1, tx as never);

    expect(tx.inventoryTransaction.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      include: { items: true },
    });
    expect(prismaRoot.inventoryTransaction.findUnique).not.toHaveBeenCalled();
  });
});

describe('InventoryTransactionsService.findAllTransactions', () => {
  it('returns every transaction when no filters are given', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    const rows = [
      { id: 1, type: 'OUTGOING', status: 'PENDING', items: [] },
      { id: 2, type: 'INCOMING', status: 'COMPLETED', items: [] },
    ];
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue(rows);

    const result = await service.findAllTransactions();

    expect(prismaRoot.inventoryTransaction.findMany).toHaveBeenCalledWith({
      where: {},
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toEqual(rows);
  });

  it('filters by type and status together', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);

    await service.findAllTransactions({
      type: 'TRANSFER' as never,
      status: 'PENDING' as never,
    });

    expect(prismaRoot.inventoryTransaction.findMany).toHaveBeenCalledWith({
      where: { type: 'TRANSFER', status: 'PENDING' },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('filters by sourceWarehouseId, destinationWarehouseId, and supplierId', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);

    await service.findAllTransactions({
      sourceWarehouseId: 10,
      destinationWarehouseId: 20,
      supplierId: 1,
    });

    expect(prismaRoot.inventoryTransaction.findMany).toHaveBeenCalledWith({
      where: {
        sourceWarehouseId: 10,
        destinationWarehouseId: 20,
        supplierId: 1,
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('filters by an expectedDate UTC range using gte/lte', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-31T23:59:59.999Z');

    await service.findAllTransactions({
      expectedDateFrom: from,
      expectedDateTo: to,
    });

    expect(prismaRoot.inventoryTransaction.findMany).toHaveBeenCalledWith({
      where: { expectedDate: { gte: from, lte: to } },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('supports a one-sided expectedDate range (from only)', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);
    const from = new Date('2026-01-01T00:00:00.000Z');

    await service.findAllTransactions({ expectedDateFrom: from });

    expect(prismaRoot.inventoryTransaction.findMany).toHaveBeenCalledWith({
      where: { expectedDate: { gte: from } },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('returns an empty array when nothing matches the filters', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);

    const result = await service.findAllTransactions({
      status: 'CANCELLED' as never,
    });

    expect(result).toEqual([]);
  });

  it('reuses a caller-supplied transaction client instead of the default prisma client', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    tx.inventoryTransaction.findMany.mockResolvedValue([]);

    await service.findAllTransactions({}, tx as never);

    expect(tx.inventoryTransaction.findMany).toHaveBeenCalled();
    expect(prismaRoot.inventoryTransaction.findMany).not.toHaveBeenCalled();
  });
});

function decimal(value: number) {
  return { toNumber: () => value };
}

describe('InventoryTransactionsService.calculateTransactionCost', () => {
  it('sums quantity × price across every item, all priced', () => {
    const tx = createMockTx();
    const { service } = buildService(tx);

    const result = service.calculateTransactionCost([
      { quantity: 3, price: decimal(19.99) },
      { quantity: 2, price: decimal(5) },
    ]);

    expect(result.totalCost).toBeCloseTo(69.97, 5);
    expect(result.pricedItemCount).toBe(2);
    expect(result.totalItemCount).toBe(2);
    expect(result.fullyPriced).toBe(true);
  });

  it('excludes unpriced items from the sum rather than treating them as free, and marks the result as not fully priced', () => {
    const tx = createMockTx();
    const { service } = buildService(tx);

    const result = service.calculateTransactionCost([
      { quantity: 3, price: decimal(10) },
      { quantity: 5, price: null },
    ]);

    expect(result.totalCost).toBe(30);
    expect(result.pricedItemCount).toBe(1);
    expect(result.totalItemCount).toBe(2);
    expect(result.fullyPriced).toBe(false);
  });

  it('returns totalCost: null when no item has a price', () => {
    const tx = createMockTx();
    const { service } = buildService(tx);

    const result = service.calculateTransactionCost([
      { quantity: 3, price: null },
      { quantity: 5, price: null },
    ]);

    expect(result.totalCost).toBeNull();
    expect(result.pricedItemCount).toBe(0);
    expect(result.fullyPriced).toBe(false);
  });

  it('handles an empty items array deterministically', () => {
    const tx = createMockTx();
    const { service } = buildService(tx);

    const result = service.calculateTransactionCost([]);

    expect(result).toEqual({
      totalCost: null,
      pricedItemCount: 0,
      totalItemCount: 0,
      fullyPriced: false,
    });
  });

  it('is a pure calculation — same input always produces the same output, no DB access', () => {
    const tx = createMockTx();
    const { service } = buildService(tx);
    const items = [{ quantity: 4, price: decimal(2.5) }];

    const first = service.calculateTransactionCost(items);
    const second = service.calculateTransactionCost(items);

    expect(first).toEqual(second);
    expect(first.totalCost).toBe(10);
  });
});

describe('InventoryTransactionsService.getTransactionWithCost', () => {
  it('fetches the transaction via findOneTransaction() and attaches its cost summary', async () => {
    const txClient = createMockTx();
    const { service, prismaRoot } = buildService(txClient);
    const txnRow = {
      id: 1,
      type: 'INCOMING',
      status: 'PENDING',
      items: [
        { id: 11, productId: 100, quantity: 3, price: decimal(10) },
        { id: 12, productId: 200, quantity: 2, price: decimal(5) },
      ],
    };
    prismaRoot.inventoryTransaction.findUnique.mockResolvedValue(txnRow);

    const result = await service.getTransactionWithCost(1);

    expect(prismaRoot.inventoryTransaction.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      include: { items: true },
    });
    expect(result.transaction).toEqual(txnRow);
    expect(result.cost).toEqual({
      totalCost: 40,
      pricedItemCount: 2,
      totalItemCount: 2,
      fullyPriced: true,
    });
  });

  it('propagates NotFoundException when the transaction does not exist', async () => {
    const txClient = createMockTx();
    const { service, prismaRoot } = buildService(txClient);
    prismaRoot.inventoryTransaction.findUnique.mockResolvedValue(null);

    await expect(service.getTransactionWithCost(999)).rejects.toThrow(
      'InventoryTransaction 999 not found',
    );
  });

  it('never touches stock, reservations, or transaction status', async () => {
    const txClient = createMockTx();
    const { service, prismaRoot, reserve, fulfill, release, recordMovement } =
      buildService(txClient);
    prismaRoot.inventoryTransaction.findUnique.mockResolvedValue({
      id: 1,
      status: 'PENDING',
      items: [{ id: 11, productId: 100, quantity: 3, price: decimal(10) }],
    });

    await service.getTransactionWithCost(1);

    expect(reserve).not.toHaveBeenCalled();
    expect(fulfill).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(recordMovement).not.toHaveBeenCalled();
    expect(txClient.inventoryTransaction.update).not.toHaveBeenCalled();
    expect(txClient.inventoryTransaction.updateMany).not.toHaveBeenCalled();
  });
});

describe('InventoryTransactionsService.getUpcomingDeliveries', () => {
  const NOW = new Date('2026-01-10T12:00:00.000Z');

  it('returns pending deliveries due within the window, with items and supplier included', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    const rows = [
      {
        id: 1,
        type: 'INCOMING',
        status: 'PENDING',
        expectedDate: new Date('2026-01-12T00:00:00.000Z'),
        items: [{ id: 1, productId: 100, quantity: 5 }],
        supplier: { id: 1, name: 'Acme Supplies' },
      },
    ];
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue(rows);

    const result = await service.getUpcomingDeliveries(7, NOW);

    expect(prismaRoot.inventoryTransaction.findMany).toHaveBeenCalledWith({
      where: {
        status: 'PENDING',
        expectedDate: {
          gte: NOW,
          lte: new Date('2026-01-17T12:00:00.000Z'),
        },
      },
      include: { items: true, supplier: true },
      orderBy: { expectedDate: 'asc' },
    });
    expect(result).toEqual(rows);
  });

  it('excludes a transaction not yet due by using an exclusive-of-nothing upper bound (window end)', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);

    // A delivery due in 30 days is outside a 7-day window — verified via the
    // query bound itself, since filtering happens in the database.
    await service.getUpcomingDeliveries(7, NOW);

    const [call] = prismaRoot.inventoryTransaction.findMany.mock.calls[0] as [
      { where: { expectedDate: { lte: Date } } },
    ];
    const farFutureDate = new Date('2026-02-09T12:00:00.000Z');
    expect(farFutureDate.getTime()).toBeGreaterThan(
      call.where.expectedDate.lte.getTime(),
    );
  });

  it('only queries PENDING transactions (COMPLETED/CANCELLED are excluded via the status filter)', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);

    await service.getUpcomingDeliveries(7, NOW);

    expect(prismaRoot.inventoryTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest matcher, not real data
        where: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
  });

  it('computes the window boundary with UTC-safe millisecond arithmetic across a month boundary', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);
    const referenceDate = new Date('2026-01-31T23:00:00.000Z');

    await service.getUpcomingDeliveries(1, referenceDate);

    expect(prismaRoot.inventoryTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest matcher, not real data
        where: expect.objectContaining({
          expectedDate: {
            gte: referenceDate,
            lte: new Date('2026-02-01T23:00:00.000Z'),
          },
        }),
      }),
    );
  });

  it('treats windowDays=0 as "due exactly now" (gte === lte === referenceDate)', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);

    await service.getUpcomingDeliveries(0, NOW);

    expect(prismaRoot.inventoryTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest matcher, not real data
        where: expect.objectContaining({
          expectedDate: { gte: NOW, lte: NOW },
        }),
      }),
    );
  });

  it('rejects a negative or non-integer windowDays', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);

    await expect(service.getUpcomingDeliveries(-1, NOW)).rejects.toThrow(
      'windowDays must be a non-negative integer',
    );
    await expect(service.getUpcomingDeliveries(1.5, NOW)).rejects.toThrow(
      'windowDays must be a non-negative integer',
    );
    expect(prismaRoot.inventoryTransaction.findMany).not.toHaveBeenCalled();
  });

  it('returns an empty array when nothing is due soon', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);

    const result = await service.getUpcomingDeliveries(7, NOW);

    expect(result).toEqual([]);
  });

  it('never modifies transactions, stock, or reservations', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, reserve, fulfill, release, recordMovement } =
      buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);

    await service.getUpcomingDeliveries(7, NOW);

    expect(reserve).not.toHaveBeenCalled();
    expect(fulfill).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(recordMovement).not.toHaveBeenCalled();
    expect(tx.inventoryTransaction.update).not.toHaveBeenCalled();
    expect(tx.inventoryTransaction.updateMany).not.toHaveBeenCalled();
  });

  it('reuses a caller-supplied transaction client instead of the default prisma client', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    tx.inventoryTransaction.findMany.mockResolvedValue([]);

    await service.getUpcomingDeliveries(7, NOW, tx as never);

    expect(tx.inventoryTransaction.findMany).toHaveBeenCalled();
    expect(prismaRoot.inventoryTransaction.findMany).not.toHaveBeenCalled();
  });
});

describe('InventoryTransactionsService.getOverdueTransactions', () => {
  const NOW = new Date('2026-01-10T12:00:00.000Z');

  it('returns pending deliveries whose expectedDate has already passed, with items and supplier included', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    const rows = [
      {
        id: 2,
        type: 'INCOMING',
        status: 'PENDING',
        expectedDate: new Date('2026-01-05T00:00:00.000Z'),
        items: [{ id: 1, productId: 100, quantity: 5 }],
        supplier: { id: 1, name: 'Acme Supplies' },
      },
    ];
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue(rows);

    const result = await service.getOverdueTransactions(NOW);

    expect(prismaRoot.inventoryTransaction.findMany).toHaveBeenCalledWith({
      where: { status: 'PENDING', expectedDate: { lt: NOW } },
      include: { items: true, supplier: true },
      orderBy: { expectedDate: 'asc' },
    });
    expect(result).toEqual(rows);
  });

  it('excludes a transaction due exactly now via a strict less-than boundary', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);

    await service.getOverdueTransactions(NOW);

    expect(prismaRoot.inventoryTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest matcher, not real data
        where: expect.objectContaining({ expectedDate: { lt: NOW } }),
      }),
    );
  });

  it('only queries PENDING transactions (COMPLETED/CANCELLED are excluded via the status filter)', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);

    await service.getOverdueTransactions(NOW);

    expect(prismaRoot.inventoryTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- jest matcher, not real data
        where: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
  });

  it('returns an empty array when nothing is overdue', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([]);

    const result = await service.getOverdueTransactions(NOW);

    expect(result).toEqual([]);
  });

  it('never completes, cancels, or otherwise modifies an overdue transaction', async () => {
    const tx = createMockTx();
    const { service, prismaRoot, reserve, fulfill, release, recordMovement } =
      buildService(tx);
    prismaRoot.inventoryTransaction.findMany.mockResolvedValue([
      { id: 2, status: 'PENDING', items: [], supplier: null },
    ]);

    await service.getOverdueTransactions(NOW);

    expect(reserve).not.toHaveBeenCalled();
    expect(fulfill).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(recordMovement).not.toHaveBeenCalled();
    expect(tx.inventoryTransaction.update).not.toHaveBeenCalled();
    expect(tx.inventoryTransaction.updateMany).not.toHaveBeenCalled();
  });

  it('reuses a caller-supplied transaction client instead of the default prisma client', async () => {
    const tx = createMockTx();
    const { service, prismaRoot } = buildService(tx);
    tx.inventoryTransaction.findMany.mockResolvedValue([]);

    await service.getOverdueTransactions(NOW, tx as never);

    expect(tx.inventoryTransaction.findMany).toHaveBeenCalled();
    expect(prismaRoot.inventoryTransaction.findMany).not.toHaveBeenCalled();
  });
});
