import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryTransactionStatus,
  InventoryTransactionType,
  Prisma,
  ReservationStatus,
  StockMovementType,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReservationsService } from '../reservations/reservations.service';
import { StockMovementsService } from '../stock-movements/stock-movements.service';

export interface TransactionItemInput {
  productId: number;
  quantity: number;
  price?: number;
}

export interface CreateIncomingInput {
  supplierId: number;
  destinationWarehouseId: number;
  expectedDate?: Date;
  documentUrl?: string;
  items: TransactionItemInput[];
}

export interface CreateOutgoingInput {
  sourceWarehouseId: number;
  partyName?: string;
  deliveryCountry?: string;
  deliveryRegion?: string;
  deliveryAddress?: string;
  expectedDate?: Date;
  documentUrl?: string;
  items: TransactionItemInput[];
}

export interface CreateTransferInput {
  sourceWarehouseId: number;
  destinationWarehouseId: number;
  expectedDate?: Date;
  documentUrl?: string;
  items: TransactionItemInput[];
}

export interface UpdateTransactionItemChange {
  itemId: number;
  productId?: number;
  quantity?: number;
}

export interface UpdateTransactionInput {
  /** OUTGOING/TRANSFER only — changing this resynchronizes every item's reservation. */
  sourceWarehouseId?: number;
  items?: UpdateTransactionItemChange[];
}

export interface FindAllTransactionsFilters {
  type?: InventoryTransactionType;
  status?: InventoryTransactionStatus;
  sourceWarehouseId?: number;
  destinationWarehouseId?: number;
  supplierId?: number;
  /** Inclusive. Must be a UTC instant (e.g. an ISO string with a `Z` suffix). */
  expectedDateFrom?: Date;
  /** Inclusive. Must be a UTC instant (e.g. an ISO string with a `Z` suffix). */
  expectedDateTo?: Date;
}

type InventoryTransactionWithItems = Prisma.InventoryTransactionGetPayload<{
  include: { items: true };
}>;

type InventoryTransactionWithItemsAndSupplier =
  Prisma.InventoryTransactionGetPayload<{
    include: { items: true; supplier: true };
  }>;

@Injectable()
export class InventoryTransactionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reservationsService: ReservationsService,
    private readonly stockMovementsService: StockMovementsService,
  ) {}

  /**
   * Creates a PENDING INCOMING transaction and its items. Stock is never
   * touched here — onHand only changes when complete() runs (not implemented
   * in this phase). No reservation is created either: INCOMING never reserves.
   */
  async createIncoming(
    input: CreateIncomingInput,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryTransactionWithItems> {
    this.validateItems(input.items);

    if (tx) {
      return this.createIncomingWithClient(tx, input);
    }

    return this.prisma.$transaction((innerTx) =>
      this.createIncomingWithClient(innerTx, input),
    );
  }

  /**
   * Creates a PENDING OUTGOING transaction and its items, then reserves the
   * required stock at sourceWarehouseId for every item via
   * ReservationsService.reserve() — sharing this same transaction so a
   * shortfall on any item rolls back the whole thing (transaction, items,
   * and any reservations already made). Items are reserved in productId
   * order (all share one warehouse here, so warehouseId is constant) per the
   * project's deterministic lock-ordering rule.
   */
  async createOutgoing(
    input: CreateOutgoingInput,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryTransactionWithItems> {
    this.validateItems(input.items);

    if (tx) {
      return this.createOutgoingWithClient(tx, input);
    }

    return this.prisma.$transaction((innerTx) =>
      this.createOutgoingWithClient(innerTx, input),
    );
  }

  /**
   * Creates a PENDING TRANSFER transaction and its items, then reserves the
   * required stock at the SOURCE warehouse only — the destination warehouse
   * is never reserved (matches ReservationsService, which only ever produces
   * a source-side reservation for TRANSFER). Rejects source === destination.
   */
  async createTransfer(
    input: CreateTransferInput,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryTransactionWithItems> {
    if (input.sourceWarehouseId === input.destinationWarehouseId) {
      throw new BadRequestException(
        'sourceWarehouseId and destinationWarehouseId must be different',
      );
    }
    this.validateItems(input.items);

    if (tx) {
      return this.createTransferWithClient(tx, input);
    }

    return this.prisma.$transaction((innerTx) =>
      this.createTransferWithClient(innerTx, input),
    );
  }

  /**
   * Completes a PENDING transaction, applying the actual stock change.
   * Claims the transaction FIRST via a conditional
   * `WHERE id=X AND status=PENDING -> COMPLETED` update — this single UPDATE
   * statement both prevents two concurrent complete() calls (or a concurrent
   * cancel()) from both succeeding, and takes a row lock on the transaction
   * itself, all inside the same $transaction() so the claim rolls back too if
   * any subsequent stock/reservation operation fails.
   *   INCOMING  -> recordMovement(INCOMING) per item at destinationWarehouseId
   *   OUTGOING  -> fulfill() each item's ACTIVE reservation (which itself
   *               calls recordMovement(OUTGOING) and flips it to FULFILLED)
   *   TRANSFER  -> fulfill() the source reservation AND recordMovement
   *               (TRANSFER_IN) at the destination, per item — both kinds of
   *               operation across both warehouses are merged into one list
   *               and executed in deterministic (warehouseId, productId)
   *               order, per the project's lock-ordering rule.
   */
  async complete(
    id: number,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryTransactionWithItems> {
    if (tx) {
      return this.completeWithClient(tx, id);
    }

    return this.prisma.$transaction((innerTx) =>
      this.completeWithClient(innerTx, id),
    );
  }

  /**
   * Cancels a PENDING transaction. Claims it FIRST (same conditional-update
   * pattern as complete() — also what prevents a complete()-vs-cancel() race
   * on the same transaction), then releases every ACTIVE reservation
   * belonging to it. Never touches WarehouseInventory.onHand. For INCOMING
   * transactions (which never reserve), the reservation list is naturally
   * empty and this is a no-op beyond the status change.
   */
  async cancel(
    id: number,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryTransactionWithItems> {
    if (tx) {
      return this.cancelWithClient(tx, id);
    }

    return this.prisma.$transaction((innerTx) =>
      this.cancelWithClient(innerTx, id),
    );
  }

  /**
   * Updates a PENDING transaction. Supports changing sourceWarehouseId
   * (OUTGOING/TRANSFER only) and/or individual items' productId/quantity.
   * Every changed item's reservation (if the transaction type has one) is
   * synchronized by releasing the old reservation and creating a new one
   * reflecting the updated product/quantity/warehouse — the same
   * release()+reserve() primitives used everywhere else, never a direct
   * reservation mutation. If the new reservation can't be made (e.g.
   * insufficient stock), the whole update rolls back, including the
   * already-released old reservation, so nothing is left missing or
   * incorrect. INCOMING transactions have no reservations to synchronize;
   * item changes are applied directly.
   */
  async update(
    id: number,
    input: UpdateTransactionInput,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryTransactionWithItems> {
    this.validateUpdateInput(input);

    if (tx) {
      return this.updateWithClient(tx, id, input);
    }

    return this.prisma.$transaction((innerTx) =>
      this.updateWithClient(innerTx, id, input),
    );
  }

  /**
   * Returns a single transaction with its items, or throws if it doesn't
   * exist. Read-only — never touches stock, reservations, or status.
   */
  async findOneTransaction(
    id: number,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryTransactionWithItems> {
    const client = tx ?? this.prisma;
    const transaction = await client.inventoryTransaction.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!transaction) {
      throw new NotFoundException(`InventoryTransaction ${id} not found`);
    }
    return transaction;
  }

  /**
   * Returns transactions with their items, filtered by any combination of
   * the fields the schema actually has (type, status, either warehouse leg,
   * supplier, expectedDate range). All filters are optional and AND'd
   * together; omitting all of them returns every transaction. Date-range
   * bounds are compared as UTC instants — callers must pass UTC Date values
   * (e.g. parsed from an ISO string with a `Z` suffix), since
   * `expectedDate` is stored without an offset. Read-only — never touches
   * stock, reservations, or status.
   */
  async findAllTransactions(
    filters: FindAllTransactionsFilters = {},
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryTransactionWithItems[]> {
    const client = tx ?? this.prisma;

    const expectedDateFilter =
      filters.expectedDateFrom || filters.expectedDateTo
        ? {
            expectedDate: {
              ...(filters.expectedDateFrom
                ? { gte: filters.expectedDateFrom }
                : {}),
              ...(filters.expectedDateTo
                ? { lte: filters.expectedDateTo }
                : {}),
            },
          }
        : {};

    return client.inventoryTransaction.findMany({
      where: {
        ...(filters.type !== undefined ? { type: filters.type } : {}),
        ...(filters.status !== undefined ? { status: filters.status } : {}),
        ...(filters.sourceWarehouseId !== undefined
          ? { sourceWarehouseId: filters.sourceWarehouseId }
          : {}),
        ...(filters.destinationWarehouseId !== undefined
          ? { destinationWarehouseId: filters.destinationWarehouseId }
          : {}),
        ...(filters.supplierId !== undefined
          ? { supplierId: filters.supplierId }
          : {}),
        ...expectedDateFilter,
      },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Returns PENDING transactions whose expectedDate falls between now and
   * `windowDays` from now (inclusive), i.e. deliveries that are due soon —
   * a supplier delivery (INCOMING), a customer delivery (OUTGOING), or a
   * warehouse transfer (TRANSFER), whichever schema-tracked type has a
   * scheduled date. Includes items and supplier so the frontend and later
   * Google Email/Calendar integrations have enough to work with without a
   * second lookup. `windowDays` defaults to 7 but is caller-configurable —
   * no fixed "approaching" threshold is hard-coded. `referenceDate` is "now"
   * and is injectable for tests; both bounds are compared as UTC instants
   * (a JS Date's underlying value is always a UTC epoch offset, so no
   * timezone conversion is needed as long as callers don't build
   * `referenceDate` from local-timezone field getters). Read-only.
   */
  async getUpcomingDeliveries(
    windowDays = 7,
    referenceDate: Date = new Date(),
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryTransactionWithItemsAndSupplier[]> {
    if (!Number.isInteger(windowDays) || windowDays < 0) {
      throw new BadRequestException(
        'windowDays must be a non-negative integer',
      );
    }
    const client = tx ?? this.prisma;
    const windowEnd = new Date(
      referenceDate.getTime() + windowDays * 24 * 60 * 60 * 1000,
    );

    return client.inventoryTransaction.findMany({
      where: {
        status: InventoryTransactionStatus.PENDING,
        expectedDate: { gte: referenceDate, lte: windowEnd },
      },
      include: { items: true, supplier: true },
      orderBy: { expectedDate: 'asc' },
    });
  }

  /**
   * Returns PENDING transactions whose expectedDate is strictly before now —
   * i.e. deliveries that are late. Never changes status, stock, or
   * reservations: staying PENDING is exactly what makes a transaction
   * "overdue" rather than complete/cancelled, and that decision is left to
   * complete()/cancel() being called explicitly elsewhere. Same
   * items+supplier include and UTC-instant comparison as
   * getUpcomingDeliveries(). Read-only.
   */
  async getOverdueTransactions(
    referenceDate: Date = new Date(),
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryTransactionWithItemsAndSupplier[]> {
    const client = tx ?? this.prisma;

    return client.inventoryTransaction.findMany({
      where: {
        status: InventoryTransactionStatus.PENDING,
        expectedDate: { lt: referenceDate },
      },
      include: { items: true, supplier: true },
      orderBy: { expectedDate: 'asc' },
    });
  }

  private async completeWithClient(
    tx: Prisma.TransactionClient,
    id: number,
  ): Promise<InventoryTransactionWithItems> {
    const claimed = await tx.inventoryTransaction.updateMany({
      where: { id, status: InventoryTransactionStatus.PENDING },
      data: {
        status: InventoryTransactionStatus.COMPLETED,
        actualDate: new Date(),
      },
    });
    if (claimed.count === 0) {
      await this.throwForNonPendingTransaction(tx, id, 'complete');
    }

    const transaction = await tx.inventoryTransaction.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });

    switch (transaction.type) {
      case InventoryTransactionType.INCOMING:
        await this.completeIncoming(tx, transaction);
        break;
      case InventoryTransactionType.OUTGOING:
        await this.completeOutgoing(tx, transaction);
        break;
      case InventoryTransactionType.TRANSFER:
        await this.completeTransfer(tx, transaction);
        break;
    }

    return tx.inventoryTransaction.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });
  }

  private async completeIncoming(
    tx: Prisma.TransactionClient,
    transaction: InventoryTransactionWithItems,
  ): Promise<void> {
    for (const item of this.sortedByProductId(transaction.items)) {
      await this.stockMovementsService.recordMovement(
        {
          productId: item.productId,
          warehouseId: transaction.destinationWarehouseId!,
          type: StockMovementType.INCOMING,
          quantity: item.quantity,
          transactionId: transaction.id,
        },
        tx,
      );
    }
  }

  private async completeOutgoing(
    tx: Prisma.TransactionClient,
    transaction: InventoryTransactionWithItems,
  ): Promise<void> {
    for (const item of this.sortedByProductId(transaction.items)) {
      const reservation = await this.findActiveReservationOrThrow(
        tx,
        transaction.id,
        item.productId,
      );
      await this.reservationsService.fulfill(reservation.id, tx);
    }
  }

  private async completeTransfer(
    tx: Prisma.TransactionClient,
    transaction: InventoryTransactionWithItems,
  ): Promise<void> {
    interface Op {
      warehouseId: number;
      productId: number;
      run: () => Promise<unknown>;
    }
    const ops: Op[] = [];

    for (const item of transaction.items) {
      const reservation = await this.findActiveReservationOrThrow(
        tx,
        transaction.id,
        item.productId,
      );

      ops.push({
        warehouseId: transaction.sourceWarehouseId!,
        productId: item.productId,
        run: () => this.reservationsService.fulfill(reservation.id, tx),
      });
      ops.push({
        warehouseId: transaction.destinationWarehouseId!,
        productId: item.productId,
        run: () =>
          this.stockMovementsService.recordMovement(
            {
              productId: item.productId,
              warehouseId: transaction.destinationWarehouseId!,
              type: StockMovementType.TRANSFER_IN,
              quantity: item.quantity,
              transactionId: transaction.id,
            },
            tx,
          ),
      });
    }

    ops.sort(
      (a, b) => a.warehouseId - b.warehouseId || a.productId - b.productId,
    );

    for (const op of ops) {
      await op.run();
    }
  }

  private async cancelWithClient(
    tx: Prisma.TransactionClient,
    id: number,
  ): Promise<InventoryTransactionWithItems> {
    const claimed = await tx.inventoryTransaction.updateMany({
      where: { id, status: InventoryTransactionStatus.PENDING },
      data: { status: InventoryTransactionStatus.CANCELLED },
    });
    if (claimed.count === 0) {
      await this.throwForNonPendingTransaction(tx, id, 'cancel');
    }

    const activeReservations = await tx.reservation.findMany({
      where: { transactionId: id, status: ReservationStatus.ACTIVE },
    });

    for (const reservation of activeReservations) {
      await this.reservationsService.release(reservation.id, tx);
    }

    return tx.inventoryTransaction.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });
  }

  private async updateWithClient(
    tx: Prisma.TransactionClient,
    id: number,
    input: UpdateTransactionInput,
  ): Promise<InventoryTransactionWithItems> {
    // Conditional update as a lock + PENDING guard, same pattern as
    // complete()/cancel(); `updatedAt` is a real field write so this is a
    // genuine UPDATE statement (not a no-op the DB could optimize away).
    const claimed = await tx.inventoryTransaction.updateMany({
      where: { id, status: InventoryTransactionStatus.PENDING },
      data: { updatedAt: new Date() },
    });
    if (claimed.count === 0) {
      await this.throwForNonPendingTransaction(tx, id, 'update');
    }

    const transaction = await tx.inventoryTransaction.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });

    if (input.sourceWarehouseId !== undefined) {
      if (transaction.type === InventoryTransactionType.INCOMING) {
        throw new BadRequestException(
          'sourceWarehouseId cannot be set on an INCOMING transaction',
        );
      }
      if (input.sourceWarehouseId === transaction.destinationWarehouseId) {
        throw new BadRequestException(
          'sourceWarehouseId and destinationWarehouseId must be different',
        );
      }
      await this.assertWarehouseExists(tx, input.sourceWarehouseId);
    }

    const itemChangesById = new Map(
      (input.items ?? []).map((change) => [change.itemId, change]),
    );
    for (const itemId of itemChangesById.keys()) {
      if (!transaction.items.some((item) => item.id === itemId)) {
        throw new NotFoundException(
          `Transaction item ${itemId} not found on transaction ${id}`,
        );
      }
    }

    const hasReservations =
      transaction.type !== InventoryTransactionType.INCOMING;
    const sourceWarehouseChanging = input.sourceWarehouseId !== undefined;
    const newSourceWarehouseId =
      input.sourceWarehouseId ?? transaction.sourceWarehouseId;

    if (hasReservations) {
      const itemsToResync = transaction.items.filter(
        (item) => itemChangesById.has(item.id) || sourceWarehouseChanging,
      );
      const sorted = [...itemsToResync].sort((a, b) => {
        const productA = itemChangesById.get(a.id)?.productId ?? a.productId;
        const productB = itemChangesById.get(b.id)?.productId ?? b.productId;
        return productA - productB;
      });

      for (const item of sorted) {
        const change = itemChangesById.get(item.id);
        const newProductId = change?.productId ?? item.productId;
        const newQuantity = change?.quantity ?? item.quantity;

        if (change?.productId !== undefined) {
          await this.assertProductsExist(tx, [
            { productId: newProductId, quantity: newQuantity },
          ]);
        }

        const existingReservation = await this.findActiveReservationOrThrow(
          tx,
          id,
          item.productId,
        );
        await this.reservationsService.release(existingReservation.id, tx);
        await this.reservationsService.reserve(
          {
            transactionId: id,
            productId: newProductId,
            warehouseId: newSourceWarehouseId!,
            quantity: newQuantity,
          },
          tx,
        );

        if (change) {
          await tx.inventoryTransactionItem.update({
            where: { id: item.id },
            data: {
              ...(change.productId !== undefined
                ? { productId: change.productId }
                : {}),
              ...(change.quantity !== undefined
                ? { quantity: change.quantity }
                : {}),
            },
          });
        }
      }
    } else {
      for (const [itemId, change] of itemChangesById) {
        if (change.productId !== undefined) {
          await this.assertProductsExist(tx, [
            {
              productId: change.productId,
              quantity: change.quantity ?? 1,
            },
          ]);
        }
        await tx.inventoryTransactionItem.update({
          where: { id: itemId },
          data: {
            ...(change.productId !== undefined
              ? { productId: change.productId }
              : {}),
            ...(change.quantity !== undefined
              ? { quantity: change.quantity }
              : {}),
          },
        });
      }
    }

    if (sourceWarehouseChanging) {
      await tx.inventoryTransaction.update({
        where: { id },
        data: { sourceWarehouseId: input.sourceWarehouseId },
      });
    }

    return tx.inventoryTransaction.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });
  }

  private validateUpdateInput(input: UpdateTransactionInput): void {
    for (const change of input.items ?? []) {
      if (
        change.quantity !== undefined &&
        (!Number.isInteger(change.quantity) || change.quantity <= 0)
      ) {
        throw new BadRequestException(
          `quantity for item ${change.itemId} must be a positive integer`,
        );
      }
      if (
        change.productId !== undefined &&
        (!Number.isInteger(change.productId) || change.productId <= 0)
      ) {
        throw new BadRequestException(
          `Invalid productId for item ${change.itemId}: ${change.productId}`,
        );
      }
    }
  }

  private async findActiveReservationOrThrow(
    tx: Prisma.TransactionClient,
    transactionId: number,
    productId: number,
  ) {
    const reservation = await tx.reservation.findFirst({
      where: {
        transactionId,
        productId,
        status: ReservationStatus.ACTIVE,
      },
    });
    if (!reservation) {
      throw new ConflictException(
        `No ACTIVE reservation found for product ${productId} on transaction ${transactionId}`,
      );
    }
    return reservation;
  }

  private async throwForNonPendingTransaction(
    tx: Prisma.TransactionClient,
    id: number,
    action: string,
  ): Promise<never> {
    const existing = await tx.inventoryTransaction.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`InventoryTransaction ${id} not found`);
    }
    throw new ConflictException(
      `InventoryTransaction ${id} is not PENDING (status: ${existing.status}) — cannot ${action}`,
    );
  }

  private async createIncomingWithClient(
    tx: Prisma.TransactionClient,
    input: CreateIncomingInput,
  ): Promise<InventoryTransactionWithItems> {
    await this.assertSupplierExists(tx, input.supplierId);
    await this.assertWarehouseExists(tx, input.destinationWarehouseId);
    await this.assertProductsExist(tx, input.items);

    return tx.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.INCOMING,
        status: InventoryTransactionStatus.PENDING,
        supplierId: input.supplierId,
        destinationWarehouseId: input.destinationWarehouseId,
        expectedDate: input.expectedDate,
        documentUrl: input.documentUrl,
        items: {
          create: input.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            price: item.price,
          })),
        },
      },
      include: { items: true },
    });
  }

  private async createOutgoingWithClient(
    tx: Prisma.TransactionClient,
    input: CreateOutgoingInput,
  ): Promise<InventoryTransactionWithItems> {
    await this.assertWarehouseExists(tx, input.sourceWarehouseId);
    await this.assertProductsExist(tx, input.items);

    const transaction = await tx.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.OUTGOING,
        status: InventoryTransactionStatus.PENDING,
        sourceWarehouseId: input.sourceWarehouseId,
        partyName: input.partyName,
        deliveryCountry: input.deliveryCountry,
        deliveryRegion: input.deliveryRegion,
        deliveryAddress: input.deliveryAddress,
        expectedDate: input.expectedDate,
        documentUrl: input.documentUrl,
        items: {
          create: input.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            price: item.price,
          })),
        },
      },
      include: { items: true },
    });

    for (const item of this.sortedByProductId(input.items)) {
      await this.reservationsService.reserve(
        {
          transactionId: transaction.id,
          productId: item.productId,
          warehouseId: input.sourceWarehouseId,
          quantity: item.quantity,
        },
        tx,
      );
    }

    return transaction;
  }

  private async createTransferWithClient(
    tx: Prisma.TransactionClient,
    input: CreateTransferInput,
  ): Promise<InventoryTransactionWithItems> {
    await this.assertWarehouseExists(tx, input.sourceWarehouseId);
    await this.assertWarehouseExists(tx, input.destinationWarehouseId);
    await this.assertProductsExist(tx, input.items);

    const transaction = await tx.inventoryTransaction.create({
      data: {
        type: InventoryTransactionType.TRANSFER,
        status: InventoryTransactionStatus.PENDING,
        sourceWarehouseId: input.sourceWarehouseId,
        destinationWarehouseId: input.destinationWarehouseId,
        expectedDate: input.expectedDate,
        documentUrl: input.documentUrl,
        items: {
          create: input.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            price: item.price,
          })),
        },
      },
      include: { items: true },
    });

    // Source-only reservation — the destination warehouse is never reserved,
    // matching ReservationsService's own TRANSFER handling.
    for (const item of this.sortedByProductId(input.items)) {
      await this.reservationsService.reserve(
        {
          transactionId: transaction.id,
          productId: item.productId,
          warehouseId: input.sourceWarehouseId,
          quantity: item.quantity,
        },
        tx,
      );
    }

    return transaction;
  }

  private validateItems(items: TransactionItemInput[]): void {
    if (!items || items.length === 0) {
      throw new BadRequestException('items must not be empty');
    }

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
    }
  }

  private sortedByProductId<T extends { productId: number }>(items: T[]): T[] {
    return [...items].sort((a, b) => a.productId - b.productId);
  }

  private async assertSupplierExists(
    tx: Prisma.TransactionClient,
    supplierId: number,
  ): Promise<void> {
    const supplier = await tx.supplier.findUnique({
      where: { id: supplierId },
    });
    if (!supplier) {
      throw new NotFoundException(`Supplier ${supplierId} not found`);
    }
  }

  private async assertWarehouseExists(
    tx: Prisma.TransactionClient,
    warehouseId: number,
  ): Promise<void> {
    const warehouse = await tx.warehouse.findUnique({
      where: { id: warehouseId },
    });
    if (!warehouse) {
      throw new NotFoundException(`Warehouse ${warehouseId} not found`);
    }
  }

  private async assertProductsExist(
    tx: Prisma.TransactionClient,
    items: TransactionItemInput[],
  ): Promise<void> {
    const uniqueProductIds = [...new Set(items.map((item) => item.productId))];

    for (const productId of uniqueProductIds) {
      const product = await tx.product.findUnique({ where: { id: productId } });
      if (!product) {
        throw new NotFoundException(`Product ${productId} not found`);
      }
    }
  }
}
