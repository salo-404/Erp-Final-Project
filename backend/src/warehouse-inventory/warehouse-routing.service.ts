import { BadRequestException, Injectable } from '@nestjs/common';
import { ReservationStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface OrderItem {
  productId: number;
  quantity: number;
}

export interface EligibleWarehouseItemAvailability {
  productId: number;
  onHand: number;
  reserved: number;
  available: number;
  requestedQuantity: number;
}

export interface EligibleWarehouse {
  warehouseId: number;
  warehouseName: string;
  location: string | null;
  items: EligibleWarehouseItemAvailability[];
}

@Injectable()
export class WarehouseRoutingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns every warehouse capable of fulfilling the ENTIRE order (every
   * requested item, at the requested quantity) — not warehouses that can
   * fulfill only some of it. Does not rank, sort by distance, or mark any
   * warehouse as "nearest"/"recommended" — that is the future Path
   * Optimizer's responsibility, not this function's.
   *
   * `deliveryCountry`/`deliveryRegion` are accepted per the required
   * signature but are NOT used to filter warehouses in this implementation —
   * see the Step report for why (Warehouse.location is unstructured free
   * text with no reliable, deterministic way to compare it against a
   * structured country/region without inventing fuzzy matching, which was
   * explicitly out of scope here).
   */
  async findEligibleWarehousesForOrder(
    deliveryCountry: string | undefined,
    deliveryRegion: string | undefined,
    items: OrderItem[],
  ): Promise<EligibleWarehouse[]> {
    this.validateItems(items);

    const productIds = items.map((item) => item.productId);

    // One query: every WarehouseInventory row (across all warehouses) for
    // any of the requested products, with the owning warehouse included.
    const inventoryRows = await this.prisma.warehouseInventory.findMany({
      where: { productId: { in: productIds } },
      include: { warehouse: true },
    });

    // One query: ACTIVE reservation quantity, summed per (warehouseId, productId),
    // for the requested products only.
    const reservationSums = await this.prisma.reservation.groupBy({
      by: ['warehouseId', 'productId'],
      where: {
        productId: { in: productIds },
        status: ReservationStatus.ACTIVE,
      },
      _sum: { quantity: true },
    });
    const reservedByKey = new Map<string, number>();
    for (const row of reservationSums) {
      reservedByKey.set(
        this.key(row.warehouseId, row.productId),
        row._sum.quantity ?? 0,
      );
    }

    // Group inventory rows by warehouse, keeping only what's needed for the
    // eligibility check and the caller-facing result.
    const warehouseById = new Map<
      number,
      {
        warehouseId: number;
        warehouseName: string;
        location: string | null;
        onHandByProduct: Map<number, number>;
      }
    >();

    for (const row of inventoryRows) {
      let entry = warehouseById.get(row.warehouseId);
      if (!entry) {
        entry = {
          warehouseId: row.warehouseId,
          warehouseName: row.warehouse.name,
          location: row.warehouse.location,
          onHandByProduct: new Map(),
        };
        warehouseById.set(row.warehouseId, entry);
      }
      entry.onHandByProduct.set(row.productId, row.onHand);
    }

    const eligible: EligibleWarehouse[] = [];

    for (const warehouse of warehouseById.values()) {
      const itemAvailability: EligibleWarehouseItemAvailability[] = [];
      let canFulfillEverything = true;

      for (const item of items) {
        // A warehouse that never had an inventory row created for one of the
        // requested products has zero stock of it — same "missing row = 0"
        // convention used by recordMovement()/reserve().
        const onHand = warehouse.onHandByProduct.get(item.productId) ?? 0;
        const reserved =
          reservedByKey.get(this.key(warehouse.warehouseId, item.productId)) ??
          0;
        const available = onHand - reserved;

        itemAvailability.push({
          productId: item.productId,
          onHand,
          reserved,
          available,
          requestedQuantity: item.quantity,
        });

        if (available < item.quantity) {
          canFulfillEverything = false;
        }
      }

      if (canFulfillEverything) {
        eligible.push({
          warehouseId: warehouse.warehouseId,
          warehouseName: warehouse.warehouseName,
          location: warehouse.location,
          items: itemAvailability,
        });
      }
    }

    return eligible;
  }

  private validateItems(items: OrderItem[]): void {
    if (!items || items.length === 0) {
      throw new BadRequestException('items must not be empty');
    }

    const seenProductIds = new Set<number>();

    for (const item of items) {
      if (!Number.isInteger(item.productId) || item.productId <= 0) {
        throw new BadRequestException(
          `Invalid productId: ${String(item.productId)}`,
        );
      }
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
        throw new BadRequestException(
          `quantity for product ${item.productId} must be a positive integer`,
        );
      }
      if (seenProductIds.has(item.productId)) {
        throw new BadRequestException(
          `Duplicate productId ${item.productId} in items`,
        );
      }
      seenProductIds.add(item.productId);
    }
  }

  private key(warehouseId: number, productId: number): string {
    return `${warehouseId}:${productId}`;
  }
}
