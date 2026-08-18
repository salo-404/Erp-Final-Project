import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateReorderThresholdDto } from './dto/update-reorder-threshold.dto';

@Injectable()
export class WarehouseInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async getByWarehouse(warehouseId: number) {
    return this.prisma.warehouseInventory.findMany({
      where: { warehouseId },
      include: {
        product: true,
      },
      orderBy: {
        productId: 'asc',
      },
    });
  }

  async getByProduct(productId: number) {
    return this.prisma.warehouseInventory.findMany({
      where: { productId },
      include: {
        warehouse: true,
      },
      orderBy: {
        warehouseId: 'asc',
      },
    });
  }

  async getAvailable(warehouseId: number, productId: number) {
    const inventory = await this.prisma.warehouseInventory.findUnique({
      where: {
        productId_warehouseId: {
          productId,
          warehouseId,
        },
      },
    });

    if (!inventory) {
      throw new NotFoundException(
        `Inventory for product ${productId} in warehouse ${warehouseId} not found`,
      );
    }

    const reservationResult = await this.prisma.reservation.aggregate({
      where: {
        warehouseId,
        productId,
        status: 'ACTIVE',
      },
      _sum: {
        quantity: true,
      },
    });

    const reserved = reservationResult._sum.quantity ?? 0;
    const available = inventory.onHand - reserved;

    return {
      warehouseId,
      productId,
      onHand: inventory.onHand,
      reserved,
      available,
    };
  }

  async getLowStockProducts(warehouseId: number) {
    const inventories = await this.getByWarehouse(warehouseId);

    const lowStockProducts: any[] = [];

    for (const inventory of inventories) {
      const stock = await this.getAvailable(warehouseId, inventory.productId);

      if (stock.available <= inventory.reorderThreshold) {
        lowStockProducts.push({
          ...inventory,
          reserved: stock.reserved,
          available: stock.available,
        });
      }
    }

    return lowStockProducts;
  }

  async getWarehouseCapacity(warehouseId: number) {
    const warehouse = await this.prisma.warehouse.findUnique({
      where: { id: warehouseId },
    });

    if (!warehouse) {
      throw new NotFoundException(`Warehouse with ID ${warehouseId} not found`);
    }

    const stockResult = await this.prisma.warehouseInventory.aggregate({
      where: { warehouseId },
      _sum: {
        onHand: true,
      },
    });

    const currentStock = stockResult._sum.onHand ?? 0;

    return {
      warehouseId,
      maxCapacity: warehouse.maxCapacity,
      currentStock,
      remainingCapacity:
        warehouse.maxCapacity === null
          ? null
          : warehouse.maxCapacity - currentStock,
    };
  }

  async setReorderThreshold(
    warehouseId: number,
    productId: number,
    dto: UpdateReorderThresholdDto,
  ) {
    const inventory = await this.prisma.warehouseInventory.findUnique({
      where: {
        productId_warehouseId: {
          productId,
          warehouseId,
        },
      },
    });

    if (!inventory) {
      throw new NotFoundException(
        `Inventory for product ${productId} in warehouse ${warehouseId} not found`,
      );
    }

    return this.prisma.warehouseInventory.update({
      where: {
        productId_warehouseId: {
          productId,
          warehouseId,
        },
      },
      data: {
        reorderThreshold: dto.reorderThreshold,
      },
    });
  }
}
