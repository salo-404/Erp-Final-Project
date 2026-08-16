import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  StockMovement,
  StockMovementType,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface RecordMovementInput {
  productId: number;
  warehouseId: number;
  type: StockMovementType;
  quantity: number;
  transactionId?: number;
}

export interface GetLedgerFilters {
  productId?: number;
  warehouseId?: number;
  transactionId?: number;
  type?: StockMovementType;
  /** Inclusive lower bound on createdAt. */
  dateFrom?: Date;
  /** Inclusive upper bound on createdAt. */
  dateTo?: Date;
}

const INCREASING_TYPES: ReadonlySet<StockMovementType> = new Set([
  StockMovementType.INCOMING,
  StockMovementType.TRANSFER_IN,
]);

const DECREASING_TYPES: ReadonlySet<StockMovementType> = new Set([
  StockMovementType.OUTGOING,
  StockMovementType.TRANSFER_OUT,
]);

@Injectable()
export class StockMovementsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Atomically creates an immutable StockMovement ledger row and applies the
   * corresponding delta to WarehouseInventory.onHand. This is the ONLY code
   * path allowed to change onHand — no other service should write it.
   *
   * Pass `tx` when calling this from inside a larger Prisma interactive
   * transaction (e.g. the future Transfer/Inventory Transaction module doing
   * TRANSFER_OUT + TRANSFER_IN as one atomic operation) so both movements
   * share the same transaction rather than each opening their own. When two
   * rows are touched in one outer transaction, the CALLER is responsible for
   * invoking recordMovement() in deterministic (warehouseId, productId) order
   * to match the project's lock-ordering rule — a single call here only ever
   * locks one row, so it cannot enforce cross-call ordering itself.
   *
   * If `tx` is omitted, a new transaction is opened for this single movement.
   */
  async recordMovement(
    input: RecordMovementInput,
    tx?: Prisma.TransactionClient,
  ): Promise<StockMovement> {
    this.validateInput(input);

    if (tx) {
      return this.recordMovementWithClient(tx, input);
    }

    return this.prisma.$transaction((innerTx) =>
      this.recordMovementWithClient(innerTx, input),
    );
  }

  /**
   * Read-only query over the immutable StockMovement ledger. All filters are
   * optional and combine with AND. Never touches WarehouseInventory or writes
   * anything — pure reporting on top of what recordMovement() already wrote.
   */
  async getLedger(filters: GetLedgerFilters = {}): Promise<StockMovement[]> {
    const { productId, warehouseId, transactionId, type, dateFrom, dateTo } =
      filters;

    const where: Prisma.StockMovementWhereInput = {};

    if (productId !== undefined) {
      where.productId = productId;
    }
    if (warehouseId !== undefined) {
      where.warehouseId = warehouseId;
    }
    if (transactionId !== undefined) {
      where.transactionId = transactionId;
    }
    if (type !== undefined) {
      where.type = type;
    }
    if (dateFrom !== undefined || dateTo !== undefined) {
      where.createdAt = {
        ...(dateFrom !== undefined ? { gte: dateFrom } : {}),
        ...(dateTo !== undefined ? { lte: dateTo } : {}),
      };
    }

    return this.prisma.stockMovement.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  private validateInput(input: RecordMovementInput): void {
    if (!Object.values(StockMovementType).includes(input.type)) {
      throw new BadRequestException(`Invalid movement type: ${input.type}`);
    }

    if (input.type === StockMovementType.ADJUSTMENT) {
      // Confirmed by the database owner: ADJUSTMENT's quantity is a signed
      // delta applied directly to onHand — positive increases, negative
      // decreases. Zero is meaningless (no-op) and rejected.
      if (!Number.isInteger(input.quantity) || input.quantity === 0) {
        throw new BadRequestException(
          'ADJUSTMENT quantity must be a non-zero integer',
        );
      }
      return;
    }

    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('quantity must be a positive integer');
    }
  }

  private async recordMovementWithClient(
    tx: Prisma.TransactionClient,
    input: RecordMovementInput,
  ): Promise<StockMovement> {
    const { productId, warehouseId, type, quantity, transactionId } = input;

    const product = await tx.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new NotFoundException(`Product ${productId} not found`);
    }

    const warehouse = await tx.warehouse.findUnique({
      where: { id: warehouseId },
    });
    if (!warehouse) {
      throw new NotFoundException(`Warehouse ${warehouseId} not found`);
    }

    const currentOnHand = await this.lockOrCreateInventoryRow(
      tx,
      productId,
      warehouseId,
    );

    // ADJUSTMENT's quantity is already the signed delta (validated non-zero
    // integer above) — apply it as-is rather than treating it as a magnitude.
    const delta =
      type === StockMovementType.ADJUSTMENT
        ? quantity
        : INCREASING_TYPES.has(type)
          ? quantity
          : DECREASING_TYPES.has(type)
            ? -quantity
            : 0;
    const newOnHand = currentOnHand + delta;

    if (newOnHand < 0) {
      throw new ConflictException(
        `Movement would result in negative onHand for product ${productId} ` +
          `in warehouse ${warehouseId} (current: ${currentOnHand}, change: ${delta})`,
      );
    }

    await tx.warehouseInventory.update({
      where: { productId_warehouseId: { productId, warehouseId } },
      data: { onHand: newOnHand },
    });

    return tx.stockMovement.create({
      data: { productId, warehouseId, type, quantity, transactionId },
    });
  }

  /**
   * Locks the WarehouseInventory row for (productId, warehouseId) via
   * SELECT ... FOR UPDATE so concurrent movements against the same row
   * serialize correctly. If the row doesn't exist yet (first-ever movement
   * for this product/warehouse pair), it's created with onHand = 0 inside
   * this same transaction. A concurrent first-insert race is handled by
   * catching the unique-constraint violation and re-locking the row the
   * other transaction just committed.
   */
  private async lockOrCreateInventoryRow(
    tx: Prisma.TransactionClient,
    productId: number,
    warehouseId: number,
  ): Promise<number> {
    const existing = await tx.$queryRaw<{ onHand: number }[]>`
      SELECT "onHand" FROM "WarehouseInventory"
      WHERE "productId" = ${productId} AND "warehouseId" = ${warehouseId}
      FOR UPDATE
    `;

    if (existing.length > 0) {
      return existing[0].onHand;
    }

    try {
      await tx.warehouseInventory.create({
        data: { productId, warehouseId, onHand: 0 },
      });
      return 0;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const retried = await tx.$queryRaw<{ onHand: number }[]>`
          SELECT "onHand" FROM "WarehouseInventory"
          WHERE "productId" = ${productId} AND "warehouseId" = ${warehouseId}
          FOR UPDATE
        `;
        if (retried.length > 0) {
          return retried[0].onHand;
        }
      }
      throw error;
    }
  }
}
