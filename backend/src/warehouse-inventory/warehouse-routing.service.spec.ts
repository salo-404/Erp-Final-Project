/// <reference types="jest" />

import { WarehouseRoutingService } from './warehouse-routing.service';
import { PrismaService } from '../prisma/prisma.service';

function createMockPrisma() {
  const findMany = jest.fn();
  const groupBy = jest.fn();
  const prisma = {
    warehouseInventory: { findMany },
    reservation: { groupBy },
  } as unknown as PrismaService;
  return { prisma, findMany, groupBy };
}

function inventoryRow(
  warehouseId: number,
  warehouseName: string,
  location: string | null,
  productId: number,
  onHand: number,
) {
  return {
    id: warehouseId * 1000 + productId,
    productId,
    warehouseId,
    onHand,
    reorderThreshold: 0,
    warehouse: {
      id: warehouseId,
      name: warehouseName,
      location,
      maxCapacity: null,
      createdAt: new Date(),
    },
  };
}

function reservationSum(
  warehouseId: number,
  productId: number,
  quantity: number,
) {
  return { warehouseId, productId, _sum: { quantity } };
}

describe('WarehouseRoutingService.findEligibleWarehousesForOrder', () => {
  it('returns a warehouse that can fulfill the entire order', async () => {
    const { prisma, findMany, groupBy } = createMockPrisma();
    findMany.mockResolvedValue([
      inventoryRow(1, 'Beirut', 'Beirut, Lebanon', 100, 20),
    ]);
    groupBy.mockResolvedValue([]);
    const service = new WarehouseRoutingService(prisma);

    const result = await service.findEligibleWarehousesForOrder(
      undefined,
      undefined,
      [{ productId: 100, quantity: 10 }],
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      warehouseId: 1,
      warehouseName: 'Beirut',
      location: 'Beirut, Lebanon',
      items: [
        {
          productId: 100,
          onHand: 20,
          reserved: 0,
          available: 20,
          requestedQuantity: 10,
        },
      ],
    });
  });

  it('excludes a warehouse with insufficient stock for one item', async () => {
    const { prisma, findMany, groupBy } = createMockPrisma();
    findMany.mockResolvedValue([
      inventoryRow(1, 'Warehouse 1', null, 100, 5), // only 5, needs 10
    ]);
    groupBy.mockResolvedValue([]);
    const service = new WarehouseRoutingService(prisma);

    const result = await service.findEligibleWarehousesForOrder(
      undefined,
      undefined,
      [{ productId: 100, quantity: 10 }],
    );

    expect(result).toEqual([]);
  });

  it('excludes a warehouse with enough onHand but insufficient AVAILABLE stock due to ACTIVE reservations', async () => {
    const { prisma, findMany, groupBy } = createMockPrisma();
    findMany.mockResolvedValue([
      inventoryRow(1, 'Warehouse 1', null, 100, 20), // onHand=20
    ]);
    groupBy.mockResolvedValue([reservationSum(1, 100, 15)]); // 15 reserved -> available=5
    const service = new WarehouseRoutingService(prisma);

    const result = await service.findEligibleWarehousesForOrder(
      undefined,
      undefined,
      [
        { productId: 100, quantity: 10 }, // needs 10, only 5 available
      ],
    );

    expect(result).toEqual([]);
  });

  it('returns multiple eligible warehouses', async () => {
    const { prisma, findMany, groupBy } = createMockPrisma();
    findMany.mockResolvedValue([
      inventoryRow(1, 'Warehouse 1', null, 100, 20),
      inventoryRow(2, 'Warehouse 2', null, 100, 30),
    ]);
    groupBy.mockResolvedValue([]);
    const service = new WarehouseRoutingService(prisma);

    const result = await service.findEligibleWarehousesForOrder(
      undefined,
      undefined,
      [{ productId: 100, quantity: 10 }],
    );

    expect(result.map((w) => w.warehouseId).sort()).toEqual([1, 2]);
  });

  it('requires availability across ALL requested products (multi-product order)', async () => {
    const { prisma, findMany, groupBy } = createMockPrisma();
    findMany.mockResolvedValue([
      // Warehouse 1: enough of both A and B
      inventoryRow(1, 'Warehouse 1', null, 100, 20),
      inventoryRow(1, 'Warehouse 1', null, 200, 8),
      // Warehouse 2: enough A, NOT enough B
      inventoryRow(2, 'Warehouse 2', null, 100, 20),
      inventoryRow(2, 'Warehouse 2', null, 200, 3),
    ]);
    groupBy.mockResolvedValue([]);
    const service = new WarehouseRoutingService(prisma);

    const result = await service.findEligibleWarehousesForOrder(
      undefined,
      undefined,
      [
        { productId: 100, quantity: 10 },
        { productId: 200, quantity: 5 },
      ],
    );

    expect(result).toHaveLength(1);
    expect(result[0].warehouseId).toBe(1);
  });

  it('excludes a warehouse missing an inventory row entirely for one requested product (treated as 0)', async () => {
    const { prisma, findMany, groupBy } = createMockPrisma();
    findMany.mockResolvedValue([
      // Warehouse 1 only has a row for product 100, never stocked product 200
      inventoryRow(1, 'Warehouse 1', null, 100, 50),
    ]);
    groupBy.mockResolvedValue([]);
    const service = new WarehouseRoutingService(prisma);

    const result = await service.findEligibleWarehousesForOrder(
      undefined,
      undefined,
      [
        { productId: 100, quantity: 10 },
        { productId: 200, quantity: 1 },
      ],
    );

    expect(result).toEqual([]);
  });

  it('returns an empty array when no warehouse can fulfill the order', async () => {
    const { prisma, findMany, groupBy } = createMockPrisma();
    findMany.mockResolvedValue([
      inventoryRow(1, 'Warehouse 1', null, 100, 2),
      inventoryRow(2, 'Warehouse 2', null, 100, 3),
    ]);
    groupBy.mockResolvedValue([]);
    const service = new WarehouseRoutingService(prisma);

    const result = await service.findEligibleWarehousesForOrder(
      undefined,
      undefined,
      [{ productId: 100, quantity: 10 }],
    );

    expect(result).toEqual([]);
  });

  it('rejects an empty items array without querying the database', async () => {
    const { prisma, findMany } = createMockPrisma();
    const service = new WarehouseRoutingService(prisma);

    await expect(
      service.findEligibleWarehousesForOrder(undefined, undefined, []),
    ).rejects.toThrow('items must not be empty');

    expect(findMany).not.toHaveBeenCalled();
  });

  it('rejects a non-positive or non-integer quantity', async () => {
    const { prisma, findMany } = createMockPrisma();
    const service = new WarehouseRoutingService(prisma);

    for (const badQuantity of [0, -1, 1.5]) {
      await expect(
        service.findEligibleWarehousesForOrder(undefined, undefined, [
          { productId: 100, quantity: badQuantity },
        ]),
      ).rejects.toThrow(/must be a positive integer/);
    }

    expect(findMany).not.toHaveBeenCalled();
  });

  it('rejects duplicate productId entries in items', async () => {
    const { prisma, findMany } = createMockPrisma();
    const service = new WarehouseRoutingService(prisma);

    await expect(
      service.findEligibleWarehousesForOrder(undefined, undefined, [
        { productId: 100, quantity: 5 },
        { productId: 100, quantity: 3 },
      ]),
    ).rejects.toThrow('Duplicate productId 100 in items');

    expect(findMany).not.toHaveBeenCalled();
  });
});
