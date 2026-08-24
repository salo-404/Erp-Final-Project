import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  // 1. Products with the highest completed customer sales.
  // Returns both quantity sold and revenue.
  async getTopSellingProducts(warehouseId?: number) {
    const items = await this.prisma.inventoryTransactionItem.findMany({
      where: {
        transaction: {
          type: 'OUTGOING',
          status: 'COMPLETED',
          ...(warehouseId !== undefined && {
            sourceWarehouseId: warehouseId,
          }),
        },
      },
      include: {
        product: true,
      },
    });

    const products = new Map<
      number,
      {
        productId: number;
        name: string;
        totalQuantitySold: number;
        totalRevenue: number;
      }
    >();

    for (const item of items) {
      const existing = products.get(item.productId);

      const revenue = item.quantity * Number(item.price ?? 0);

      if (existing) {
        existing.totalQuantitySold += item.quantity;
        existing.totalRevenue += revenue;
      } else {
        products.set(item.productId, {
          productId: item.productId,
          name: item.product.name,
          totalQuantitySold: item.quantity,
          totalRevenue: revenue,
        });
      }
    }

    return Array.from(products.values()).sort(
      (a, b) => b.totalQuantitySold - a.totalQuantitySold,
    );
  }

  // 2. Products with the lowest completed customer sales.
  // Includes active products with zero sales.
  async getLowestSellingProducts(warehouseId?: number) {
    const products = await this.prisma.product.findMany({
      where: {
        isActive: true,
        ...(warehouseId !== undefined && {
          inventories: {
            some: { warehouseId },
          },
        }),
      },
    });

    const items = await this.prisma.inventoryTransactionItem.findMany({
      where: {
        transaction: {
          type: 'OUTGOING',
          status: 'COMPLETED',
          ...(warehouseId !== undefined && {
            sourceWarehouseId: warehouseId,
          }),
        },
      },
    });

    const sales = new Map<
      number,
      {
        totalQuantitySold: number;
        totalRevenue: number;
      }
    >();

    for (const item of items) {
      const existing = sales.get(item.productId);

      const revenue = item.quantity * Number(item.price ?? 0);

      if (existing) {
        existing.totalQuantitySold += item.quantity;
        existing.totalRevenue += revenue;
      } else {
        sales.set(item.productId, {
          totalQuantitySold: item.quantity,
          totalRevenue: revenue,
        });
      }
    }

    return products
      .map((product) => {
        const productSales = sales.get(product.id);

        return {
          productId: product.id,
          name: product.name,
          totalQuantitySold: productSales?.totalQuantitySold ?? 0,
          totalRevenue: productSales?.totalRevenue ?? 0,
        };
      })
      .sort((a, b) => a.totalQuantitySold - b.totalQuantitySold);
  }

  // 3. Products with the most outgoing stock movement
  // during the last X days.
  async getFastMovingProducts(days = 30, warehouseId?: number) {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    const movements = await this.prisma.stockMovement.findMany({
      where: {
        type: 'OUTGOING',
        createdAt: {
          gte: fromDate,
        },
        ...(warehouseId !== undefined && {
          warehouseId,
        }),
      },
      include: {
        product: true,
      },
    });

    const products = new Map<
      number,
      {
        productId: number;
        name: string;
        quantityMoved: number;
      }
    >();

    for (const movement of movements) {
      const existing = products.get(movement.productId);
      const quantity = Math.abs(movement.quantity);

      if (existing) {
        existing.quantityMoved += quantity;
      } else {
        products.set(movement.productId, {
          productId: movement.productId,
          name: movement.product.name,
          quantityMoved: quantity,
        });
      }
    }

    return Array.from(products.values()).sort(
      (a, b) => b.quantityMoved - a.quantityMoved,
    );
  }

  // 4. Active products with the least outgoing movement
  // during the last X days.
  async getSlowMovingProducts(days = 30, warehouseId?: number) {
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);

    const products = await this.prisma.product.findMany({
      where: {
        isActive: true,
        ...(warehouseId !== undefined && {
          inventories: {
            some: { warehouseId },
          },
        }),
      },
    });

    const movements = await this.prisma.stockMovement.findMany({
      where: {
        type: 'OUTGOING',
        createdAt: {
          gte: fromDate,
        },
        ...(warehouseId !== undefined && {
          warehouseId,
        }),
      },
    });

    const movementTotals = new Map<number, number>();

    for (const movement of movements) {
      const quantity = Math.abs(movement.quantity);

      movementTotals.set(
        movement.productId,
        (movementTotals.get(movement.productId) ?? 0) + quantity,
      );
    }

    return products
      .map((product) => ({
        productId: product.id,
        name: product.name,
        quantityMoved: movementTotals.get(product.id) ?? 0,
      }))
      .sort((a, b) => a.quantityMoved - b.quantityMoved);
  }

  // 5. Completed sales grouped by day.
  async getSalesTrends(warehouseId?: number) {
    const transactions = await this.prisma.inventoryTransaction.findMany({
      where: {
        type: 'OUTGOING',
        status: 'COMPLETED',
        ...(warehouseId !== undefined && { sourceWarehouseId: warehouseId }),
      },
      include: {
        items: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    const trends = new Map<
      string,
      {
        date: string;
        quantitySold: number;
        revenue: number;
        transactionCount: number;
      }
    >();

    for (const transaction of transactions) {
      const dateSource = transaction.actualDate ?? transaction.createdAt;

      const date = dateSource.toISOString().split('T')[0];

      const existing = trends.get(date) ?? {
        date,
        quantitySold: 0,
        revenue: 0,
        transactionCount: 0,
      };

      existing.transactionCount += 1;

      for (const item of transaction.items) {
        existing.quantitySold += item.quantity;
        existing.revenue += item.quantity * Number(item.price ?? 0);
      }

      trends.set(date, existing);
    }

    return Array.from(trends.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }

  // 6. Completed incoming purchases grouped by day.
  async getPurchaseTrends(warehouseId?: number) {
    const transactions = await this.prisma.inventoryTransaction.findMany({
      where: {
        type: 'INCOMING',
        status: 'COMPLETED',
        ...(warehouseId !== undefined && {
          destinationWarehouseId: warehouseId,
        }),
      },
      include: {
        items: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    const trends = new Map<
      string,
      {
        date: string;
        quantityPurchased: number;
        purchaseCost: number;
        transactionCount: number;
      }
    >();

    for (const transaction of transactions) {
      const dateSource = transaction.actualDate ?? transaction.createdAt;

      const date = dateSource.toISOString().split('T')[0];

      const existing = trends.get(date) ?? {
        date,
        quantityPurchased: 0,
        purchaseCost: 0,
        transactionCount: 0,
      };

      existing.transactionCount += 1;

      for (const item of transaction.items) {
        existing.quantityPurchased += item.quantity;
        existing.purchaseCost += item.quantity * Number(item.price ?? 0);
      }

      trends.set(date, existing);
    }

    return Array.from(trends.values()).sort((a, b) =>
      a.date.localeCompare(b.date),
    );
  }

  // 7. Full stock movement history for one product.
  // warehouseId can optionally narrow it to one warehouse.
  async getStockHistory(productId: number, warehouseId?: number) {
    const product = await this.prisma.product.findUnique({
      where: {
        id: productId,
      },
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${productId} not found`);
    }

    return this.prisma.stockMovement.findMany({
      where: {
        productId,
        ...(warehouseId !== undefined && {
          warehouseId,
        }),
      },
      include: {
        warehouse: true,
        transaction: true,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  // 8. Total completed outgoing demand per warehouse.
  async getWarehouseDemand(warehouseId?: number) {
    const transactions = await this.prisma.inventoryTransaction.findMany({
      where: {
        type: 'OUTGOING',
        status: 'COMPLETED',
        sourceWarehouseId:
          warehouseId !== undefined ? warehouseId : { not: null },
      },
      include: {
        sourceWarehouse: true,
        items: true,
      },
    });

    const warehouses = new Map<
      number,
      {
        warehouseId: number;
        warehouseName: string;
        totalQuantitySold: number;
        orderCount: number;
      }
    >();

    for (const transaction of transactions) {
      if (
        transaction.sourceWarehouseId === null ||
        transaction.sourceWarehouse === null
      ) {
        continue;
      }

      const warehouseId = transaction.sourceWarehouseId;

      const existing = warehouses.get(warehouseId) ?? {
        warehouseId,
        warehouseName: transaction.sourceWarehouse.name,
        totalQuantitySold: 0,
        orderCount: 0,
      };

      existing.orderCount += 1;

      for (const item of transaction.items) {
        existing.totalQuantitySold += item.quantity;
      }

      warehouses.set(warehouseId, existing);
    }

    return Array.from(warehouses.values()).sort(
      (a, b) => b.totalQuantitySold - a.totalQuantitySold,
    );
  }

  // 9. Demand details for one product.
  async getProductDemand(productId: number) {
    const product = await this.prisma.product.findUnique({
      where: {
        id: productId,
      },
    });

    if (!product) {
      throw new NotFoundException(`Product with ID ${productId} not found`);
    }

    const items = await this.prisma.inventoryTransactionItem.findMany({
      where: {
        productId,
        transaction: {
          type: 'OUTGOING',
          status: 'COMPLETED',
        },
      },
      include: {
        transaction: {
          include: {
            sourceWarehouse: true,
          },
        },
      },
    });

    let totalQuantitySold = 0;
    let totalRevenue = 0;

    const warehouseDemand = new Map<
      number,
      {
        warehouseId: number;
        warehouseName: string;
        quantitySold: number;
      }
    >();

    for (const item of items) {
      totalQuantitySold += item.quantity;
      totalRevenue += item.quantity * Number(item.price ?? 0);

      const warehouse = item.transaction.sourceWarehouse;

      if (warehouse) {
        const existing = warehouseDemand.get(warehouse.id) ?? {
          warehouseId: warehouse.id,
          warehouseName: warehouse.name,
          quantitySold: 0,
        };

        existing.quantitySold += item.quantity;

        warehouseDemand.set(warehouse.id, existing);
      }
    }

    return {
      productId: product.id,
      productName: product.name,
      totalQuantitySold,
      totalRevenue,
      warehouseDemand: Array.from(warehouseDemand.values()).sort(
        (a, b) => b.quantitySold - a.quantitySold,
      ),
    };
  }

  // 10. Basic supplier comparison using purchase history.
  async getSupplierComparison() {
    const suppliers = await this.prisma.supplier.findMany({
      where: {
        isActive: true,
      },
      include: {
        transactions: {
          where: {
            type: 'INCOMING',
          },
          include: {
            items: true,
          },
        },
      },
    });

    return suppliers.map((supplier) => {
      let totalPurchasedQuantity = 0;
      let totalPurchaseCost = 0;
      let completedTransactions = 0;
      let cancelledTransactions = 0;
      let onTimeTransactions = 0;
      let lateTransactions = 0;

      for (const transaction of supplier.transactions) {
        if (transaction.status === 'COMPLETED') {
          completedTransactions++;

          for (const item of transaction.items) {
            totalPurchasedQuantity += item.quantity;
            totalPurchaseCost += item.quantity * Number(item.price ?? 0);
          }

          if (transaction.expectedDate && transaction.actualDate) {
            if (transaction.actualDate <= transaction.expectedDate) {
              onTimeTransactions++;
            } else {
              lateTransactions++;
            }
          }
        }

        if (transaction.status === 'CANCELLED') {
          cancelledTransactions++;
        }
      }

      const averageUnitCost =
        totalPurchasedQuantity === 0
          ? 0
          : totalPurchaseCost / totalPurchasedQuantity;

      return {
        supplierId: supplier.id,
        supplierName: supplier.name,
        completedTransactions,
        cancelledTransactions,
        onTimeTransactions,
        lateTransactions,
        totalPurchasedQuantity,
        totalPurchaseCost,
        averageUnitCost,
      };
    });
  }
}
