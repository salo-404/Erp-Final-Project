import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryTransactionType,
  Prisma,
  Reservation,
  ReservationStatus,
  StockMovementType,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StockMovementsService } from '../stock-movements/stock-movements.service';

export interface ReserveInput {
  /** Required by the schema (Reservation.transactionId is a mandatory FK) — the
   *  future Inventory Transactions module must create the parent transaction
   *  first and pass its id here. */
  transactionId: number;
  productId: number;
  warehouseId: number;
  quantity: number;
}

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockMovementsService: StockMovementsService,
  ) {}

  /**
   * Creates an ACTIVE reservation only if enough available stock exists:
   * available = onHand - SUM(ACTIVE reservations). Never allows available
   * stock to go negative. Locks the WarehouseInventory row (when it exists)
   * for the duration of the check + insert so concurrent reserve() calls for
   * the same (productId, warehouseId) cannot both succeed and oversell.
   */
  async reserve(
    input: ReserveInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Reservation> {
    this.validateReserveInput(input);

    if (tx) {
      return this.reserveWithClient(tx, input);
    }

    return this.prisma.$transaction((innerTx) =>
      this.reserveWithClient(innerTx, input),
    );
  }

  /**
   * Releases (cancels) an ACTIVE reservation. Never touches
   * WarehouseInventory.onHand — releasing simply frees the reserved quantity
   * back into "available" for future reserve() calls. Uses a conditional
   * `WHERE id = X AND status = ACTIVE` update (the project's standard state-
   * transition pattern) so two concurrent releases/fulfillments of the same
   * reservation can't both succeed.
   */
  async release(
    reservationId: number,
    tx?: Prisma.TransactionClient,
  ): Promise<Reservation> {
    if (tx) {
      return this.releaseWithClient(tx, reservationId);
    }

    return this.prisma.$transaction((innerTx) =>
      this.releaseWithClient(innerTx, reservationId),
    );
  }

  /**
   * Fulfills an ACTIVE reservation: the actual stock decrease is delegated to
   * StockMovementsService.recordMovement() (never a direct onHand write here),
   * called with the SAME transaction client so the movement and the
   * reservation's status flip to FULFILLED commit or roll back together. If
   * recordMovement() fails (e.g. its own negative-onHand safety net trips),
   * the reservation stays ACTIVE — nothing is left half-done.
   *
   * The StockMovementType to record (OUTGOING vs TRANSFER_OUT) is derived
   * from the reservation's parent InventoryTransaction.type, per the docs:
   * reservations exist for OUTGOING transactions and for TRANSFER
   * transactions at the source warehouse.
   */
  async fulfill(
    reservationId: number,
    tx?: Prisma.TransactionClient,
  ): Promise<Reservation> {
    if (tx) {
      return this.fulfillWithClient(tx, reservationId);
    }

    return this.prisma.$transaction((innerTx) =>
      this.fulfillWithClient(innerTx, reservationId),
    );
  }

  private validateReserveInput(input: ReserveInput): void {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
      throw new BadRequestException('quantity must be a positive integer');
    }
  }

  private async reserveWithClient(
    tx: Prisma.TransactionClient,
    input: ReserveInput,
  ): Promise<Reservation> {
    const { transactionId, productId, warehouseId, quantity } = input;

    // Lock the inventory row (if it exists) so a concurrent reserve() for the
    // same product/warehouse can't read a stale onHand/available snapshot.
    // If no row exists yet, onHand is treated as 0 — there's nothing to
    // oversell in that case since any positive quantity will correctly fail
    // the availability check below regardless of concurrency.
    const inventoryRows = await tx.$queryRaw<{ onHand: number }[]>`
      SELECT "onHand" FROM "WarehouseInventory"
      WHERE "productId" = ${productId} AND "warehouseId" = ${warehouseId}
      FOR UPDATE
    `;
    const onHand = inventoryRows.length > 0 ? inventoryRows[0].onHand : 0;

    const reservedResult = await tx.reservation.aggregate({
      where: { productId, warehouseId, status: ReservationStatus.ACTIVE },
      _sum: { quantity: true },
    });
    const activeReserved = reservedResult._sum.quantity ?? 0;
    const available = onHand - activeReserved;

    if (quantity > available) {
      throw new ConflictException(
        `Insufficient available stock for product ${productId} in warehouse ${warehouseId} ` +
          `(available: ${available}, requested: ${quantity})`,
      );
    }

    return tx.reservation.create({
      data: {
        transactionId,
        productId,
        warehouseId,
        quantity,
        status: ReservationStatus.ACTIVE,
      },
    });
  }

  private async releaseWithClient(
    tx: Prisma.TransactionClient,
    reservationId: number,
  ): Promise<Reservation> {
    const result = await tx.reservation.updateMany({
      where: { id: reservationId, status: ReservationStatus.ACTIVE },
      data: { status: ReservationStatus.CANCELLED },
    });

    if (result.count === 0) {
      await this.throwForNonActiveReservation(tx, reservationId);
    }

    return tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  }

  private async fulfillWithClient(
    tx: Prisma.TransactionClient,
    reservationId: number,
  ): Promise<Reservation> {
    const reservation = await tx.reservation.findUnique({
      where: { id: reservationId },
      include: { transaction: true },
    });

    if (!reservation) {
      throw new NotFoundException(`Reservation ${reservationId} not found`);
    }
    if (reservation.status !== ReservationStatus.ACTIVE) {
      throw new ConflictException(
        `Reservation ${reservationId} is not ACTIVE (status: ${reservation.status})`,
      );
    }

    const movementType = this.resolveFulfillMovementType(
      reservation.transaction.type,
    );

    await this.stockMovementsService.recordMovement(
      {
        productId: reservation.productId,
        warehouseId: reservation.warehouseId,
        type: movementType,
        quantity: reservation.quantity,
        transactionId: reservation.transactionId,
      },
      tx,
    );

    const result = await tx.reservation.updateMany({
      where: { id: reservationId, status: ReservationStatus.ACTIVE },
      data: { status: ReservationStatus.FULFILLED },
    });

    if (result.count === 0) {
      // Reservation was released/fulfilled concurrently between our check
      // above and this update — abort so the stock movement rolls back too.
      throw new ConflictException(
        `Reservation ${reservationId} was modified concurrently`,
      );
    }

    return tx.reservation.findUniqueOrThrow({ where: { id: reservationId } });
  }

  private resolveFulfillMovementType(
    transactionType: InventoryTransactionType,
  ): StockMovementType {
    switch (transactionType) {
      case InventoryTransactionType.OUTGOING:
        return StockMovementType.OUTGOING;
      case InventoryTransactionType.TRANSFER:
        return StockMovementType.TRANSFER_OUT;
      default:
        throw new BadRequestException(
          `Reservations cannot be fulfilled for transaction type ${transactionType}`,
        );
    }
  }

  private async throwForNonActiveReservation(
    tx: Prisma.TransactionClient,
    reservationId: number,
  ): Promise<never> {
    const existing = await tx.reservation.findUnique({
      where: { id: reservationId },
    });
    if (!existing) {
      throw new NotFoundException(`Reservation ${reservationId} not found`);
    }
    throw new ConflictException(
      `Reservation ${reservationId} is not ACTIVE (status: ${existing.status})`,
    );
  }
}
