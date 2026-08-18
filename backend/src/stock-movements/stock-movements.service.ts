import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  StockMovement,
  StockMovementType,
  UserRole,
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

export interface AdjustInventoryInput {
  productId: number;
  warehouseId: number;
  /** Signed delta applied directly to onHand — same convention recordMovement() already uses for ADJUSTMENT: positive increases, negative decreases, never zero. */
  quantity: number;
  /** Required — the audit trail this adjustment leaves is the log line built from this plus requestedBy (see adjustInventory()'s doc comment; no schema field exists to persist it durably). */
  reason: string;
  requestedBy: { id: number; role: UserRole };
}

export interface InventoryReconciliationMismatch {
  productId: number;
  warehouseId: number;
  /** WarehouseInventory.onHand as currently stored. */
  recordedOnHand: number;
  /** Recomputed from scratch by summing every StockMovement's delta for this (productId, warehouseId) — the same delta rule recordMovement() itself applies. */
  calculatedOnHand: number;
  /** recordedOnHand - calculatedOnHand. */
  difference: number;
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
  private readonly logger = new Logger(StockMovementsService.name);

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

  /**
   * Admin-only manual correction of onHand — e.g. after a physical stocktake
   * finds a discrepancy. Product/warehouse existence is validated by
   * recordMovement() itself (the same existing check every other movement
   * type already goes through — not duplicated here), and the ADJUSTMENT
   * quantity/negative-onHand rules are the same ones recordMovement() always
   * enforces. `onHand` is never written directly — this only ever creates an
   * ADJUSTMENT movement through recordMovement(), the sole code path allowed
   * to change it.
   *
   * "Auditable": there is no schema field to durably persist `reason`/who
   * requested it (schema changes are out of scope here), so this logs a
   * structured audit line (productId, warehouseId, quantity, reason,
   * requestedBy, resulting movement id) via Nest's Logger instead of
   * silently discarding that context. A real durable audit trail would need
   * a schema field — flagged in the report rather than added unasked.
   */
  async adjustInventory(
    input: AdjustInventoryInput,
    tx?: Prisma.TransactionClient,
  ): Promise<StockMovement> {
    if (input.requestedBy.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Only an ADMIN may adjust inventory');
    }
    if (!input.reason || !input.reason.trim()) {
      throw new BadRequestException(
        'reason is required for an inventory adjustment',
      );
    }

    const movement = await this.recordMovement(
      {
        productId: input.productId,
        warehouseId: input.warehouseId,
        type: StockMovementType.ADJUSTMENT,
        quantity: input.quantity,
      },
      tx,
    );

    this.logger.log(
      `Inventory adjustment: product ${input.productId} in warehouse ${input.warehouseId}, ` +
        `quantity ${input.quantity}, reason "${input.reason}", requested by user ${input.requestedBy.id} ` +
        `(movement ${movement.id})`,
    );

    return movement;
  }

  /**
   * Read-only. Recomputes what onHand SHOULD be for every (productId,
   * warehouseId) pair, purely from summing every StockMovement's delta
   * (the exact same increasing/decreasing/ADJUSTMENT delta rule
   * recordMovementWithClient() applies to each movement as it's written —
   * reused via movementDelta(), not reimplemented), and returns only the
   * pairs where that disagrees with the currently stored
   * WarehouseInventory.onHand. Never writes anything — no movement is
   * created, no onHand is corrected; a real fix still has to go through
   * adjustInventory() (or another recordMovement() call) explicitly.
   */
  async reconcileInventory(
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryReconciliationMismatch[]> {
    const client = tx ?? this.prisma;

    const [inventoryRows, movements] = await Promise.all([
      client.warehouseInventory.findMany(),
      client.stockMovement.findMany(),
    ]);

    const calculatedByKey = new Map<string, number>();
    for (const movement of movements) {
      const key = this.inventoryKey(movement.productId, movement.warehouseId);
      calculatedByKey.set(
        key,
        (calculatedByKey.get(key) ?? 0) +
          this.movementDelta(movement.type, movement.quantity),
      );
    }

    const mismatches: InventoryReconciliationMismatch[] = [];
    for (const row of inventoryRows) {
      const calculatedOnHand =
        calculatedByKey.get(
          this.inventoryKey(row.productId, row.warehouseId),
        ) ?? 0;
      if (calculatedOnHand !== row.onHand) {
        mismatches.push({
          productId: row.productId,
          warehouseId: row.warehouseId,
          recordedOnHand: row.onHand,
          calculatedOnHand,
          difference: row.onHand - calculatedOnHand,
        });
      }
    }

    return mismatches.sort(
      (a, b) => a.productId - b.productId || a.warehouseId - b.warehouseId,
    );
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

    const delta = this.movementDelta(type, quantity);
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

  /**
   * The single source of truth for "what does this movement type do to
   * onHand" — used by recordMovementWithClient() when actually applying a
   * movement, and by reconcileInventory() when recomputing what onHand
   * SHOULD be from the ledger. One formula, two callers; never duplicated.
   */
  private movementDelta(type: StockMovementType, quantity: number): number {
    if (type === StockMovementType.ADJUSTMENT) {
      // Already the signed delta (validated non-zero integer by
      // validateInput()) — apply as-is rather than treating it as a
      // magnitude.
      return quantity;
    }
    if (INCREASING_TYPES.has(type)) {
      return quantity;
    }
    if (DECREASING_TYPES.has(type)) {
      return -quantity;
    }
    return 0;
  }

  private inventoryKey(productId: number, warehouseId: number): string {
    return `${productId}:${warehouseId}`;
  }
}
