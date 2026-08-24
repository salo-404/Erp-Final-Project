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
import { S3DocumentStorageService } from '../document-review/s3-document-storage.service';
import {
  ALLOWED_DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_SIZE_BYTES,
  type AllowedDocumentMimeType,
} from '../document-review/document-validation.constants';

export interface AttachDocumentInput {
  filename: string;
  mimeType: string;
  content: Buffer;
}

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
  documentKey?: string;
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
  documentKey?: string;
  items: TransactionItemInput[];
}

export interface CreateTransferInput {
  sourceWarehouseId: number;
  destinationWarehouseId: number;
  expectedDate?: Date;
  documentUrl?: string;
  documentKey?: string;
  items: TransactionItemInput[];
}

export interface UpdateTransactionItemChange {
  itemId: number;
  productId?: number;
  quantity?: number;
  price?: number;
}

export interface UpdateTransactionInput {
  /** OUTGOING/TRANSFER only — changing this resynchronizes every item's reservation. */
  sourceWarehouseId?: number;
  /** INCOMING/TRANSFER only — never touches a reservation (only the source leg is ever reserved). */
  destinationWarehouseId?: number;
  /** INCOMING only. */
  supplierId?: number;
  /** Any transaction type. */
  expectedDate?: Date;
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

/**
 * Duck-typed against InventoryTransactionItem — `price` is only ever a
 * Prisma Decimal (from `.toNumber()`-bearing decimal.js) or null, per the
 * schema's `price Decimal?` — deliberately not importing the concrete
 * Decimal type so this stays trivial to unit test with a plain object.
 */
export interface TransactionCostItem {
  quantity: number;
  price: { toNumber(): number } | null;
}

export interface TransactionCostSummary {
  /** Sum of quantity × price across every item that HAS a recorded price. null only when no item has one. */
  totalCost: number | null;
  /** How many items contributed to totalCost. */
  pricedItemCount: number;
  totalItemCount: number;
  /** true only when every item has a price — i.e. totalCost is complete, not partial. */
  fullyPriced: boolean;
}

export interface InventoryTransactionWithCost {
  transaction: InventoryTransactionWithItems;
  cost: TransactionCostSummary;
}

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
    private readonly documentStorage: S3DocumentStorageService,
  ) {}

  /**
   * Attaches a document (e.g. a delivered customer order's invoice) to an
   * already-existing transaction — regardless of status, unlike update()
   * which is PENDING-only. Reuses the exact same S3 upload path and
   * MIME/size validation as DocumentReviewService.upload(), just without
   * the AI-extraction/review pipeline: this is a direct "attach a file to
   * a record that already exists," not a new transaction proposal.
   */
  async attachDocument(
    id: number,
    input: AttachDocumentInput,
  ): Promise<InventoryTransactionWithItems> {
    await this.findOneTransaction(id);
    this.validateDocumentFile(input);

    const uploaded = await this.documentStorage.upload({
      filename: input.filename,
      mimeType: input.mimeType,
      content: input.content,
    });

    return this.prisma.inventoryTransaction.update({
      where: { id },
      data: { documentUrl: uploaded.url, documentKey: uploaded.key },
      include: { items: true },
    });
  }

  /** Presigned URL for a transaction's attached document — mirrors DocumentReviewService.getDocumentPresignedUrl(). */
  async getDocumentPresignedUrl(id: number): Promise<{ url: string }> {
    const transaction = await this.prisma.inventoryTransaction.findUnique({
      where: { id },
      select: { documentKey: true },
    });
    if (!transaction) {
      throw new NotFoundException(`InventoryTransaction ${id} not found`);
    }
    if (!transaction.documentKey) {
      throw new NotFoundException(
        `InventoryTransaction ${id} has no stored S3 object key`,
      );
    }

    const url = await this.documentStorage.getPresignedUrl(
      transaction.documentKey,
    );
    return { url };
  }

  private validateDocumentFile(input: AttachDocumentInput): void {
    if (
      !ALLOWED_DOCUMENT_MIME_TYPES.includes(
        input.mimeType as AllowedDocumentMimeType,
      )
    ) {
      throw new BadRequestException(`Unsupported file type: ${input.mimeType}`);
    }
    if (input.content.length === 0) {
      throw new BadRequestException('Uploaded file is empty');
    }
    if (input.content.length > MAX_DOCUMENT_SIZE_BYTES) {
      throw new BadRequestException(
        `File exceeds the maximum allowed size of ${MAX_DOCUMENT_SIZE_BYTES} bytes`,
      );
    }
  }

  /**
   * Creates a PENDING INCOMING transaction and its items. Stock is never
   * touched here — onHand only changes when complete() runs (not implemented
   * in this phase). No reservation is created either: INCOMING never reserves.
   *
   * INCOMING is the purchase transaction (buying from a supplier), so every
   * item MUST carry a price — `requirePrice: true` below. A missing price is
   * rejected outright at creation time rather than silently accepted and
   * later treated as 0 in cost calculations (see
   * calculateTransactionCost()'s `fullyPriced` — this is what guarantees
   * every INCOMING transaction is always fully priced).
   */
  async createIncoming(
    input: CreateIncomingInput,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryTransactionWithItems> {
    this.validateItems(input.items, { requirePrice: true });

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
   * Updates a PENDING transaction — only planned/not-yet-executed data:
   * sourceWarehouseId (OUTGOING/TRANSFER only), destinationWarehouseId
   * (INCOMING/TRANSFER only), supplierId (INCOMING only), expectedDate (any
   * type), and/or individual items' productId/quantity/price. Transaction
   * type, status, and identity (id) are never editable here — there is no
   * field for them on UpdateTransactionInput, so there is nothing for a
   * caller to even attempt to change; the PENDING-only guard below is what
   * enforces "not yet executed."
   *
   * Every changed item's reservation (if the transaction type has one) is
   * synchronized by releasing the old reservation and creating a new one
   * reflecting the updated product/quantity/warehouse — the same
   * release()+reserve() primitives used everywhere else, never a direct
   * reservation mutation. If the new reservation can't be made (e.g.
   * insufficient stock), the whole update rolls back, including the
   * already-released old reservation, so nothing is left missing or
   * incorrect. INCOMING transactions have no reservations to synchronize;
   * item changes are applied directly. destinationWarehouseId/supplierId/
   * expectedDate never touch a reservation regardless of type (only the
   * source leg is ever reserved, per createOutgoing()/createTransfer()).
   *
   * The final item list (after applying every change) must not contain two
   * items with the same productId — same rule validateItems() already
   * enforces at creation, applied here too since a duplicate would make
   * reservation lookups keyed on (transactionId, productId) ambiguous.
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
   * Pure, deterministic total-purchase-cost calculation: sums quantity ×
   * price across every item that has a recorded price
   * (InventoryTransactionItem.price is optional in the schema — `Decimal?`).
   * Items without a price are excluded from the sum rather than treated as
   * zero, since silently treating "unknown price" as "free" would
   * misrepresent the total; `fullyPriced` tells the caller whether
   * `totalCost` is a complete total or a partial one. `totalCost` is null
   * only when NO item has a price at all (nothing to sum).
   *
   * No I/O, no side effects — safe to call from any other service (Document
   * Review, Stock Insights, Control Tower, a future controller, etc.)
   * without a database round-trip, and safe to reuse here without
   * duplicating the formula anywhere else in this file.
   */
  calculateTransactionCost(
    items: TransactionCostItem[],
  ): TransactionCostSummary {
    const pricedItems = items.filter(
      (item): item is TransactionCostItem & { price: { toNumber(): number } } =>
        item.price !== null,
    );

    const totalCost =
      pricedItems.length === 0
        ? null
        : pricedItems.reduce(
            (sum, item) => sum + item.quantity * item.price.toNumber(),
            0,
          );

    return {
      totalCost,
      pricedItemCount: pricedItems.length,
      totalItemCount: items.length,
      fullyPriced: pricedItems.length === items.length && items.length > 0,
    };
  }

  /**
   * Fetches one transaction via findOneTransaction() (reused as-is — no
   * duplicated lookup logic) and attaches its cost summary. This is the
   * "transaction details" entry point the total purchase cost is made
   * available through, without changing findOneTransaction()'s own return
   * shape or any existing caller of it. Read-only.
   */
  async getTransactionWithCost(
    id: number,
    tx?: Prisma.TransactionClient,
  ): Promise<InventoryTransactionWithCost> {
    const transaction = await this.findOneTransaction(id, tx);
    return {
      transaction,
      cost: this.calculateTransactionCost(transaction.items),
    };
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

    const newSourceWarehouseIdForValidation =
      input.sourceWarehouseId ?? transaction.sourceWarehouseId;
    const newDestinationWarehouseIdForValidation =
      input.destinationWarehouseId ?? transaction.destinationWarehouseId;

    if (
      input.sourceWarehouseId !== undefined &&
      transaction.type === InventoryTransactionType.INCOMING
    ) {
      throw new BadRequestException(
        'sourceWarehouseId cannot be set on an INCOMING transaction',
      );
    }
    if (
      input.destinationWarehouseId !== undefined &&
      transaction.type === InventoryTransactionType.OUTGOING
    ) {
      throw new BadRequestException(
        'destinationWarehouseId cannot be set on an OUTGOING transaction',
      );
    }
    if (
      (input.sourceWarehouseId !== undefined ||
        input.destinationWarehouseId !== undefined) &&
      transaction.type === InventoryTransactionType.TRANSFER &&
      newSourceWarehouseIdForValidation ===
        newDestinationWarehouseIdForValidation
    ) {
      throw new BadRequestException(
        'sourceWarehouseId and destinationWarehouseId must be different',
      );
    }
    if (
      input.supplierId !== undefined &&
      transaction.type !== InventoryTransactionType.INCOMING
    ) {
      throw new BadRequestException(
        'supplierId can only be set on an INCOMING transaction',
      );
    }

    if (input.sourceWarehouseId !== undefined) {
      await this.assertWarehouseExists(tx, input.sourceWarehouseId);
    }
    if (input.destinationWarehouseId !== undefined) {
      await this.assertWarehouseExists(tx, input.destinationWarehouseId);
    }
    if (input.supplierId !== undefined) {
      await this.assertSupplierExists(tx, input.supplierId);
    }

    const itemChangesById = new Map(
      (input.items ?? []).map((change) => [change.itemId, change]),
    );
    if (itemChangesById.size !== (input.items?.length ?? 0)) {
      throw new BadRequestException(
        'items must not contain duplicate itemId values',
      );
    }
    for (const itemId of itemChangesById.keys()) {
      if (!transaction.items.some((item) => item.id === itemId)) {
        throw new NotFoundException(
          `Transaction item ${itemId} not found on transaction ${id}`,
        );
      }
    }

    // The final item list (after every change is applied) must not contain
    // two items with the same productId — see update()'s doc comment.
    const finalProductIds = transaction.items.map(
      (item) => itemChangesById.get(item.id)?.productId ?? item.productId,
    );
    if (new Set(finalProductIds).size !== finalProductIds.length) {
      throw new BadRequestException(
        'Update would result in duplicate productId values across items',
      );
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

      const resyncPlans: Array<{
        item: (typeof sorted)[number];
        change: UpdateTransactionItemChange | undefined;
        newProductId: number;
        newQuantity: number;
        existingReservationId: number;
      }> = [];
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
        resyncPlans.push({
          item,
          change,
          newProductId,
          newQuantity,
          existingReservationId: existingReservation.id,
        });
      }

      // Release the complete old set before creating any replacement. A new
      // reservation for one swapped product can therefore never be mistaken
      // for another item's old reservation lookup.
      for (const plan of resyncPlans) {
        await this.reservationsService.release(
          plan.existingReservationId,
          tx,
        );
      }

      for (const plan of resyncPlans) {
        await this.reservationsService.reserve(
          {
            transactionId: id,
            productId: plan.newProductId,
            warehouseId: newSourceWarehouseId!,
            quantity: plan.newQuantity,
          },
          tx,
        );

        if (plan.change) {
          await tx.inventoryTransactionItem.update({
            where: { id: plan.item.id },
            data: {
              ...(plan.change.productId !== undefined
                ? { productId: plan.change.productId }
                : {}),
              ...(plan.change.quantity !== undefined
                ? { quantity: plan.change.quantity }
                : {}),
              ...(plan.change.price !== undefined
                ? { price: plan.change.price }
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
            ...(change.price !== undefined ? { price: change.price } : {}),
          },
        });
      }
    }

    const transactionFieldChanges: Prisma.InventoryTransactionUpdateInput = {
      ...(sourceWarehouseChanging
        ? { sourceWarehouseId: input.sourceWarehouseId }
        : {}),
      ...(input.destinationWarehouseId !== undefined
        ? { destinationWarehouseId: input.destinationWarehouseId }
        : {}),
      ...(input.supplierId !== undefined
        ? { supplierId: input.supplierId }
        : {}),
      ...(input.expectedDate !== undefined
        ? { expectedDate: input.expectedDate }
        : {}),
    };
    if (Object.keys(transactionFieldChanges).length > 0) {
      await tx.inventoryTransaction.update({
        where: { id },
        data: transactionFieldChanges,
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
      if (
        change.price !== undefined &&
        (typeof change.price !== 'number' ||
          !Number.isFinite(change.price) ||
          change.price < 0)
      ) {
        throw new BadRequestException(
          `price for item ${change.itemId} must be a non-negative number`,
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
        documentKey: input.documentKey,
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
        documentKey: input.documentKey,
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
        documentKey: input.documentKey,
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

  /**
   * `requirePrice` is set only by createIncoming() — INCOMING is the
   * purchase transaction, where a missing price must be rejected outright
   * rather than silently accepted (see createIncoming()'s doc comment).
   * OUTGOING/TRANSFER items may omit price (no purchase cost applies), but
   * when a price IS given for any transaction type it must be a valid,
   * non-negative amount — never NaN/Infinity/negative.
   *
   * Also rejects a duplicate productId across items in the same call — the
   * same check WarehouseRoutingService.validateItems() already applies for
   * an order, reused here for the same reason: reservation lookups
   * throughout this service (findActiveReservationOrThrow, and the resync
   * loop in update()) key on (transactionId, productId) via `findFirst`, so
   * two items sharing a productId within one transaction would make those
   * lookups ambiguous — which reservation is "the" one for that product is
   * no longer well-defined. Rejecting the duplicate at creation time closes
   * that off at the source rather than guessing at a tiebreak later.
   */
  private validateItems(
    items: TransactionItemInput[],
    options: { requirePrice?: boolean } = {},
  ): void {
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
      if (
        options.requirePrice &&
        (item.price === undefined || item.price === null)
      ) {
        throw new BadRequestException(
          `price is required for product ${item.productId} on a purchase (INCOMING) transaction`,
        );
      }
      if (
        item.price !== undefined &&
        item.price !== null &&
        (typeof item.price !== 'number' ||
          !Number.isFinite(item.price) ||
          item.price < 0)
      ) {
        throw new BadRequestException(
          `price for product ${item.productId} must be a non-negative number`,
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

  private sortedByProductId<T extends { productId: number }>(items: T[]): T[] {
    return [...items].sort((a, b) => a.productId - b.productId);
  }

  /**
   * Existence + isActive gate for every entity a NEW transaction (or a
   * change to a PENDING one) references. Inactive entities remain fully
   * readable everywhere else (findOneTransaction, findAllTransactions,
   * getUpcomingDeliveries, getOverdueTransactions, an already-PENDING
   * transaction's complete()/cancel()) — this check only runs at the point
   * a NEW operational decision is being made, per the confirmed rule that
   * inactive entities must not participate in new decisions while historical
   * data stays readable. Single choke point so isActive is never checked
   * (or missed) ad hoc at each call site.
   */
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
    if (!supplier.isActive) {
      throw new BadRequestException(
        `Supplier ${supplierId} is inactive and cannot be used for a new transaction`,
      );
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
    if (!warehouse.isActive) {
      throw new BadRequestException(
        `Warehouse ${warehouseId} is inactive and cannot be used for a new transaction`,
      );
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
      if (!product.isActive) {
        throw new BadRequestException(
          `Product ${productId} is inactive and cannot be used for a new transaction`,
        );
      }
    }
  }
}
