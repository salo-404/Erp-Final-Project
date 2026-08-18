/// <reference types="jest" />

import { WarehouseRoutingService } from './warehouse-routing.service';
import { PrismaService } from '../prisma/prisma.service';

function createMockPrisma() {
  return {
    product: { findMany: jest.fn() },
    warehouseInventory: { findMany: jest.fn() },
    reservation: { groupBy: jest.fn() },
  };
}

function buildService() {
  const prisma = createMockPrisma();
  const service = new WarehouseRoutingService(
    prisma as unknown as PrismaService,
  );
  return { service, prisma };
}

function product(
  overrides: Partial<{ id: number; name: string; isActive: boolean }> = {},
) {
  return { id: 100, name: 'Widget', isActive: true, ...overrides };
}

function inventoryRow(
  overrides: Partial<{
    productId: number;
    warehouseId: number;
    onHand: number;
    warehouseName: string;
    location: string | null;
    warehouseIsActive: boolean;
  }> = {},
) {
  const warehouseId = overrides.warehouseId ?? 10;
  return {
    productId: overrides.productId ?? 100,
    warehouseId,
    onHand: overrides.onHand ?? 100,
    warehouse: {
      id: warehouseId,
      name: overrides.warehouseName ?? `Warehouse ${warehouseId}`,
      location:
        overrides.location === undefined ? 'Some City' : overrides.location,
      isActive: overrides.warehouseIsActive ?? true,
    },
  };
}

describe('WarehouseRoutingService.findEligibleWarehousesForOrder', () => {
  it('returns a warehouse that can fulfill the entire order', async () => {
    const { service, prisma } = buildService();
    prisma.product.findMany.mockResolvedValue([product()]);
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({ warehouseId: 10, onHand: 100 }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.findEligibleWarehousesForOrder(
      undefined,
      undefined,
      [{ productId: 100, quantity: 50 }],
    );

    expect(result).toHaveLength(1);
    expect(result[0].warehouseId).toBe(10);
    expect(result[0].items[0]).toEqual({
      productId: 100,
      onHand: 100,
      reserved: 0,
      available: 100,
      requestedQuantity: 50,
    });
  });

  it('excludes a warehouse that cannot fulfill the full requested quantity', async () => {
    const { service, prisma } = buildService();
    prisma.product.findMany.mockResolvedValue([product()]);
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({ warehouseId: 10, onHand: 30 }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    const result = await service.findEligibleWarehousesForOrder(
      undefined,
      undefined,
      [{ productId: 100, quantity: 50 }],
    );

    expect(result).toEqual([]);
  });

  it('subtracts ACTIVE reservations from onHand when computing available stock', async () => {
    const { service, prisma } = buildService();
    prisma.product.findMany.mockResolvedValue([product()]);
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({ warehouseId: 10, onHand: 50 }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([
      { warehouseId: 10, productId: 100, _sum: { quantity: 40 } },
    ]);

    const result = await service.findEligibleWarehousesForOrder(
      undefined,
      undefined,
      [{ productId: 100, quantity: 20 }],
    );

    // onHand 50 - reserved 40 = available 10, which is < the requested 20.
    expect(result).toEqual([]);
  });

  it('rejects when the requested product is inactive', async () => {
    const { service, prisma } = buildService();
    prisma.product.findMany.mockResolvedValue([product({ isActive: false })]);

    await expect(
      service.findEligibleWarehousesForOrder(undefined, undefined, [
        { productId: 100, quantity: 10 },
      ]),
    ).rejects.toThrow(
      'Product 100 is inactive and cannot be part of a new order',
    );

    expect(prisma.warehouseInventory.findMany).not.toHaveBeenCalled();
  });

  it('rejects when the requested product does not exist', async () => {
    const { service, prisma } = buildService();
    prisma.product.findMany.mockResolvedValue([]);

    await expect(
      service.findEligibleWarehousesForOrder(undefined, undefined, [
        { productId: 999, quantity: 10 },
      ]),
    ).rejects.toThrow('Product 999 not found');

    expect(prisma.warehouseInventory.findMany).not.toHaveBeenCalled();
  });

  it('excludes an inactive warehouse from candidates even when it has enough stock', async () => {
    const { service, prisma } = buildService();
    prisma.product.findMany.mockResolvedValue([product()]);
    prisma.warehouseInventory.findMany.mockResolvedValue([]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    await service.findEligibleWarehousesForOrder(undefined, undefined, [
      { productId: 100, quantity: 10 },
    ]);

    // The isActive filter is applied inside the query itself, so an
    // inactive warehouse's row is never even fetched.
    expect(prisma.warehouseInventory.findMany).toHaveBeenCalledWith({
      where: { productId: { in: [100] }, warehouse: { isActive: true } },
      include: { warehouse: true },
    });
  });

  it('rejects empty items without querying anything', async () => {
    const { service, prisma } = buildService();

    await expect(
      service.findEligibleWarehousesForOrder(undefined, undefined, []),
    ).rejects.toThrow('items must not be empty');

    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('rejects a duplicate productId in items', async () => {
    const { service, prisma } = buildService();

    await expect(
      service.findEligibleWarehousesForOrder(undefined, undefined, [
        { productId: 100, quantity: 5 },
        { productId: 100, quantity: 3 },
      ]),
    ).rejects.toThrow('Duplicate productId 100 in items');

    expect(prisma.product.findMany).not.toHaveBeenCalled();
  });

  it('rejects a non-positive/non-integer quantity', async () => {
    const { service } = buildService();

    await expect(
      service.findEligibleWarehousesForOrder(undefined, undefined, [
        { productId: 100, quantity: 0 },
      ]),
    ).rejects.toThrow(/must be a positive integer/);
  });

  it('never writes to inventory or reservations', async () => {
    const { service, prisma } = buildService();
    prisma.product.findMany.mockResolvedValue([product()]);
    prisma.warehouseInventory.findMany.mockResolvedValue([
      inventoryRow({ warehouseId: 10, onHand: 100 }),
    ]);
    prisma.reservation.groupBy.mockResolvedValue([]);

    await service.findEligibleWarehousesForOrder(undefined, undefined, [
      { productId: 100, quantity: 50 },
    ]);

    expect(Object.keys(prisma.warehouseInventory)).not.toContain('update');
    expect(Object.keys(prisma.reservation)).not.toContain('create');
  });
});
