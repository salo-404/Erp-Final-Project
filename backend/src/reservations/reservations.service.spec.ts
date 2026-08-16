/// <reference types="jest" />

import { ReservationsService } from './reservations.service';
import { PrismaService } from '../prisma/prisma.service';
import { StockMovementsService } from '../stock-movements/stock-movements.service';

function createMockTx() {
  return {
    $queryRaw: jest.fn(),
    reservation: {
      aggregate: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
  };
}

type MockTx = ReturnType<typeof createMockTx>;

function createMockPrisma(tx: MockTx) {
  return {
    $transaction: jest.fn((callback: (tx: MockTx) => unknown) => callback(tx)),
  } as unknown as PrismaService;
}

function createMockStockMovementsService() {
  const recordMovement = jest.fn().mockResolvedValue({ id: 1 });
  const service = { recordMovement } as unknown as StockMovementsService;
  return { service, recordMovement };
}

const RESERVATION_INPUT = {
  transactionId: 50,
  productId: 1,
  warehouseId: 10,
  quantity: 5,
};

describe('ReservationsService.reserve', () => {
  it('creates an ACTIVE reservation when enough available stock exists', async () => {
    const tx = createMockTx();
    tx.$queryRaw.mockResolvedValue([{ onHand: 20 }]);
    tx.reservation.aggregate.mockResolvedValue({ _sum: { quantity: 5 } }); // already 5 reserved
    tx.reservation.create.mockResolvedValue({
      id: 1,
      ...RESERVATION_INPUT,
      status: 'ACTIVE',
    });
    const service = new ReservationsService(
      createMockPrisma(tx),
      createMockStockMovementsService().service,
    );

    // available = 20 - 5 = 15, requesting 5 -> allowed
    const result = await service.reserve(RESERVATION_INPUT);

    expect(tx.reservation.create).toHaveBeenCalledWith({
      data: {
        transactionId: 50,
        productId: 1,
        warehouseId: 10,
        quantity: 5,
        status: 'ACTIVE',
      },
    });
    expect(result.status).toBe('ACTIVE');
  });

  it('rejects when requested quantity exceeds available stock (onHand minus active reservations)', async () => {
    const tx = createMockTx();
    tx.$queryRaw.mockResolvedValue([{ onHand: 10 }]);
    tx.reservation.aggregate.mockResolvedValue({ _sum: { quantity: 8 } }); // available = 2
    const service = new ReservationsService(
      createMockPrisma(tx),
      createMockStockMovementsService().service,
    );

    await expect(
      service.reserve({ ...RESERVATION_INPUT, quantity: 5 }),
    ).rejects.toThrow(/Insufficient available stock/);

    expect(tx.reservation.create).not.toHaveBeenCalled();
  });

  it('treats a missing WarehouseInventory row as zero stock and rejects any reservation', async () => {
    const tx = createMockTx();
    tx.$queryRaw.mockResolvedValue([]); // no inventory row at all
    tx.reservation.aggregate.mockResolvedValue({ _sum: { quantity: null } });
    const service = new ReservationsService(
      createMockPrisma(tx),
      createMockStockMovementsService().service,
    );

    await expect(service.reserve(RESERVATION_INPUT)).rejects.toThrow(
      /Insufficient available stock/,
    );

    expect(tx.reservation.create).not.toHaveBeenCalled();
  });

  it('rejects a zero/negative/non-integer quantity without touching the database', async () => {
    const tx = createMockTx();
    const service = new ReservationsService(
      createMockPrisma(tx),
      createMockStockMovementsService().service,
    );

    for (const badQuantity of [0, -1, 1.5]) {
      await expect(
        service.reserve({ ...RESERVATION_INPUT, quantity: badQuantity }),
      ).rejects.toThrow('quantity must be a positive integer');
    }

    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.reservation.create).not.toHaveBeenCalled();
  });

  it('reuses a caller-supplied transaction client instead of opening its own', async () => {
    const tx = createMockTx();
    tx.$queryRaw.mockResolvedValue([{ onHand: 20 }]);
    tx.reservation.aggregate.mockResolvedValue({ _sum: { quantity: 0 } });
    tx.reservation.create.mockResolvedValue({ id: 1 });
    const prisma = createMockPrisma(tx);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest.fn() mock, safe to reference detached
    const transactionSpy = prisma.$transaction as jest.Mock;
    const service = new ReservationsService(
      prisma,
      createMockStockMovementsService().service,
    );

    await service.reserve(RESERVATION_INPUT, tx as never);

    expect(transactionSpy).not.toHaveBeenCalled();
    expect(tx.reservation.create).toHaveBeenCalled();
  });
});

describe('ReservationsService.release', () => {
  it('cancels an ACTIVE reservation without touching WarehouseInventory', async () => {
    const tx = createMockTx();
    tx.reservation.updateMany.mockResolvedValue({ count: 1 });
    tx.reservation.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      status: 'CANCELLED',
    });
    const service = new ReservationsService(
      createMockPrisma(tx),
      createMockStockMovementsService().service,
    );

    const result = await service.release(1);

    expect(tx.reservation.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: 'ACTIVE' },
      data: { status: 'CANCELLED' },
    });
    expect(result.status).toBe('CANCELLED');
    // No warehouseInventory field even exists on this mock — proves release()
    // never attempts to touch onHand.
    expect((tx as Record<string, unknown>).warehouseInventory).toBeUndefined();
  });

  it('throws NotFound when the reservation does not exist', async () => {
    const tx = createMockTx();
    tx.reservation.updateMany.mockResolvedValue({ count: 0 });
    tx.reservation.findUnique.mockResolvedValue(null);
    const service = new ReservationsService(
      createMockPrisma(tx),
      createMockStockMovementsService().service,
    );

    await expect(service.release(999)).rejects.toThrow(
      'Reservation 999 not found',
    );
  });

  it('throws Conflict when the reservation is not ACTIVE', async () => {
    const tx = createMockTx();
    tx.reservation.updateMany.mockResolvedValue({ count: 0 });
    tx.reservation.findUnique.mockResolvedValue({ id: 1, status: 'FULFILLED' });
    const service = new ReservationsService(
      createMockPrisma(tx),
      createMockStockMovementsService().service,
    );

    await expect(service.release(1)).rejects.toThrow(
      'Reservation 1 is not ACTIVE (status: FULFILLED)',
    );
  });
});

describe('ReservationsService.fulfill', () => {
  it('records an OUTGOING stock movement (via StockMovementsService) and marks the reservation FULFILLED', async () => {
    const tx = createMockTx();
    tx.reservation.findUnique.mockResolvedValue({
      id: 1,
      productId: 1,
      warehouseId: 10,
      quantity: 5,
      transactionId: 50,
      status: 'ACTIVE',
      transaction: { id: 50, type: 'OUTGOING' },
    });
    tx.reservation.updateMany.mockResolvedValue({ count: 1 });
    tx.reservation.findUniqueOrThrow.mockResolvedValue({
      id: 1,
      status: 'FULFILLED',
    });
    const { service: stockMovementsService, recordMovement } =
      createMockStockMovementsService();
    const service = new ReservationsService(
      createMockPrisma(tx),
      stockMovementsService,
    );

    const result = await service.fulfill(1);

    expect(recordMovement).toHaveBeenCalledWith(
      {
        productId: 1,
        warehouseId: 10,
        type: 'OUTGOING',
        quantity: 5,
        transactionId: 50,
      },
      tx,
    );
    expect(tx.reservation.updateMany).toHaveBeenCalledWith({
      where: { id: 1, status: 'ACTIVE' },
      data: { status: 'FULFILLED' },
    });
    expect(result.status).toBe('FULFILLED');
  });

  it('records a TRANSFER_OUT stock movement for a TRANSFER-type reservation', async () => {
    const tx = createMockTx();
    tx.reservation.findUnique.mockResolvedValue({
      id: 2,
      productId: 1,
      warehouseId: 10,
      quantity: 3,
      transactionId: 51,
      status: 'ACTIVE',
      transaction: { id: 51, type: 'TRANSFER' },
    });
    tx.reservation.updateMany.mockResolvedValue({ count: 1 });
    tx.reservation.findUniqueOrThrow.mockResolvedValue({
      id: 2,
      status: 'FULFILLED',
    });
    const { service: stockMovementsService, recordMovement } =
      createMockStockMovementsService();
    const service = new ReservationsService(
      createMockPrisma(tx),
      stockMovementsService,
    );

    await service.fulfill(2);

    expect(recordMovement).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TRANSFER_OUT' }),
      tx,
    );
  });

  it('rejects fulfilling a reservation that is not ACTIVE', async () => {
    const tx = createMockTx();
    tx.reservation.findUnique.mockResolvedValue({
      id: 1,
      status: 'CANCELLED',
      transaction: { type: 'OUTGOING' },
    });
    const { service: stockMovementsService, recordMovement } =
      createMockStockMovementsService();
    const service = new ReservationsService(
      createMockPrisma(tx),
      stockMovementsService,
    );

    await expect(service.fulfill(1)).rejects.toThrow(
      'Reservation 1 is not ACTIVE (status: CANCELLED)',
    );
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('rejects fulfilling a reservation whose parent transaction is INCOMING (invalid)', async () => {
    const tx = createMockTx();
    tx.reservation.findUnique.mockResolvedValue({
      id: 1,
      status: 'ACTIVE',
      transaction: { type: 'INCOMING' },
    });
    const { service: stockMovementsService, recordMovement } =
      createMockStockMovementsService();
    const service = new ReservationsService(
      createMockPrisma(tx),
      stockMovementsService,
    );

    await expect(service.fulfill(1)).rejects.toThrow(
      /Reservations cannot be fulfilled for transaction type INCOMING/,
    );
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('does not mark the reservation FULFILLED if recordMovement() fails (rollback path)', async () => {
    const tx = createMockTx();
    tx.reservation.findUnique.mockResolvedValue({
      id: 1,
      productId: 1,
      warehouseId: 10,
      quantity: 5,
      transactionId: 50,
      status: 'ACTIVE',
      transaction: { type: 'OUTGOING' },
    });
    const { service: stockMovementsService, recordMovement } =
      createMockStockMovementsService();
    recordMovement.mockRejectedValue(
      new Error('simulated recordMovement failure'),
    );
    const service = new ReservationsService(
      createMockPrisma(tx),
      stockMovementsService,
    );

    await expect(service.fulfill(1)).rejects.toThrow(
      'simulated recordMovement failure',
    );

    // The status update must never be reached — both the movement and the
    // status flip live in the same $transaction callback, so this failure
    // rolls the whole thing back and the reservation stays ACTIVE.
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
  });
});
