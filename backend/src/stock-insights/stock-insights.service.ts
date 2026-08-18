import { BadRequestException, Injectable } from '@nestjs/common';
import {
  InventoryTransactionStatus,
  InventoryTransactionType,
  Prisma,
  ReservationStatus,
  StockMovementType,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StockMovementsService } from '../stock-movements/stock-movements.service';
import { InventoryTransactionsService } from '../inventory-transactions/inventory-transactions.service';
import { DocumentReviewService } from '../document-review/document-review.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Same two outgoing-movement types StockMovementsService treats as decreasing onHand — not redefined, just referenced. */
const CONSUMPTION_TYPES: ReadonlySet<StockMovementType> = new Set([
  StockMovementType.OUTGOING,
  StockMovementType.TRANSFER_OUT,
]);

export interface DeadStockEntry {
  productId: number;
  warehouseId: number;
  onHand: number;
  /** null when this product/warehouse pair has never had a StockMovement (of ANY type). */
  lastMovementAt: Date | null;
  /** null when lastMovementAt is null. */
  daysSinceLastMovement: number | null;
  /**
   * Same idea as lastMovementAt, but scoped to OUTGOING/TRANSFER_OUT only —
   * the customer-facing "did anyone actually take this stock" signal Control
   * Tower needs to explain an alert, distinct from warehouse-side movement
   * (INCOMING/TRANSFER_IN/ADJUSTMENT) which isn't customer demand. null when
   * this product/warehouse pair has never had a consumption-type movement.
   * Purely additional information — does NOT change which rows are flagged
   * as dead stock; the existing any-movement-type cutoff below is unchanged.
   */
  lastOutgoingMovementAt: Date | null;
  /** null when lastOutgoingMovementAt is null. */
  daysSinceLastOutgoingMovement: number | null;
}

export type ConsumptionAnomalyDirection = 'INCREASE' | 'DECREASE';

export interface ConsumptionAnomaly {
  productId: number;
  recentQuantity: number;
  baselineQuantity: number;
  /** null when baselineQuantity is 0 (percentage change is undefined from a zero base). */
  percentChange: number | null;
  direction: ConsumptionAnomalyDirection;
}

export type StockoutRiskLevel = 'OUT_OF_STOCK' | 'AT_RISK' | 'OK';

/**
 * Severity order for sorting — lower index is more urgent. Not a business
 * rule of its own, just a display ordering of the three states classifyRisk()
 * already produces from the existing reorderThreshold field.
 */
const RISK_SEVERITY: Readonly<Record<StockoutRiskLevel, number>> = {
  OUT_OF_STOCK: 0,
  AT_RISK: 1,
  OK: 2,
};

export interface StockoutRiskEntry {
  productId: number;
  warehouseId: number;
  onHand: number;
  activeReserved: number;
  /** onHand - activeReserved, the same authoritative formula ReservationsService.reserve() uses inline. */
  available: number;
  reorderThreshold: number;
  /** Classified from `available` vs. the existing reorderThreshold field — no invented threshold. */
  riskLevel: StockoutRiskLevel;
  /** Sum of item quantities on PENDING INCOMING/TRANSFER transactions whose destinationWarehouseId is this warehouse. */
  pendingIncomingQuantity: number;
  /** available + pendingIncomingQuantity. */
  projectedAvailable: number;
  /** Classified from `projectedAvailable` vs. reorderThreshold. */
  projectedRiskLevel: StockoutRiskLevel;
  /** Total OUTGOING+TRANSFER_OUT quantity in the lookback window, divided by the window length. 0 when there was no consumption. */
  avgDailyConsumption: number;
  /** available / avgDailyConsumption; null when avgDailyConsumption is 0 (indefinite runway, not computable). */
  daysOfSupply: number | null;
  /**
   * referenceDate + daysOfSupply days — derived from daysOfSupply, not a
   * separate calculation. null under exactly the same condition
   * daysOfSupply is null (zero/no consumption data): never invented, never
   * a guessed date.
   */
  predictedStockoutDate: Date | null;
}

/**
 * Why a restock recommendation exists, per the confirmed decision tree:
 * low/at-risk stock (still at risk AFTER pending incoming is accounted for —
 * a row pending incoming would fully resolve is excluded entirely, not
 * returned as a third "no action needed" reason) -> can another warehouse
 * provide it (getTransferRecommendations())? -> YES: transfer_available.
 * NO -> purchase_required.
 */
export type RestockReason = 'transfer_available' | 'purchase_required';

export interface RestockRecommendation {
  productId: number;
  warehouseId: number;
  available: number;
  pendingIncomingQuantity: number;
  projectedAvailable: number;
  reorderThreshold: number;
  riskLevel: StockoutRiskLevel;
  projectedRiskLevel: StockoutRiskLevel;
  /** max(reorderThreshold - projectedAvailable, 0) — the quantity needed to bring projected available back up to the existing reorderThreshold. */
  recommendedQuantity: number;
  avgDailyConsumption: number;
  daysOfSupply: number | null;
  reason: RestockReason;
  /** Human-readable explanation of why this recommendation (and its reason) exists — for Control Tower/dashboard display, built entirely from fields already on this entry. */
  explanation: string;
}

export interface TransferRecommendation {
  productId: number;
  fromWarehouseId: number;
  toWarehouseId: number;
  transferQuantity: number;
  /** Donor's `available` after this and any earlier recommended transfers from it are applied. */
  fromWarehouseAvailableAfterTransfer: number;
  /** Recipient's `projectedAvailable` after this and any earlier recommended transfers into it are applied. */
  toWarehouseProjectedAvailableAfterTransfer: number;
  /** Donor's own pending incoming for this product — context: the donor may itself be about to be replenished. Drawn straight from the same getStockoutRisk() entry already used to compute this match, not a new query. */
  sourcePendingIncomingQuantity: number;
  /** True when this exact (productId, fromWarehouseId) pair also appears in getDeadStock() — the donor's surplus is also slow-moving/idle stock, which is useful context for why donating it is low-cost. */
  sourceIsDeadStock: boolean;
  /** Recipient's CURRENT (pre-transfer) risk level, for urgency context. */
  destinationRiskLevel: StockoutRiskLevel;
  /** Recipient's average daily consumption — the demand signal behind the shortage. */
  destinationAvgDailyConsumption: number;
  /** Recipient's current days of supply before this transfer is applied. */
  destinationDaysOfSupply: number | null;
}

export type ControlTowerAlertSeverity = 'CRITICAL' | 'WARNING' | 'INFO';

export type ControlTowerAlertCategory =
  | 'DEAD_STOCK'
  | 'CONSUMPTION_ANOMALY'
  | 'STOCKOUT_RISK'
  | 'OVERDUE_TRANSACTION'
  | 'PENDING_DOCUMENT_REVIEW'
  | 'RESTOCK_RECOMMENDATION'
  | 'TRANSFER_RECOMMENDATION';

/**
 * One structured alert wrapping an entry already produced by an existing,
 * reused calculation. `data` is that entry verbatim — getControlTowerAlerts()
 * never recomputes or reshapes the underlying numbers, only classifies
 * severity and writes a human-readable `message` for the frontend/future
 * NotificationService.
 */
export interface ControlTowerAlert {
  category: ControlTowerAlertCategory;
  severity: ControlTowerAlertSeverity;
  message: string;
  data: Record<string, unknown>;
  referenceDate: Date;
}

const ALERT_SEVERITY_ORDER: Readonly<
  Record<ControlTowerAlertSeverity, number>
> = {
  CRITICAL: 0,
  WARNING: 1,
  INFO: 2,
};

export interface ControlTowerAlertOptions {
  deadStockInactivityDays?: number;
  consumptionWindowDays?: number;
  consumptionThresholdPercent?: number;
}

@Injectable()
export class StockInsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockMovementsService: StockMovementsService,
    private readonly inventoryTransactionsService: InventoryTransactionsService,
    private readonly documentReviewService: DocumentReviewService,
  ) {}

  /**
   * Read-only. Flags every (productId, warehouseId) pair that currently
   * holds stock (onHand > 0) but has had no StockMovement in the last
   * `inactivityDays` — or has never had one at all. Zero-onHand rows are
   * never "dead stock": there is nothing sitting idle to flag.
   *
   * `inactivityDays` defaults to 60 (the project's confirmed dead-stock
   * threshold) but remains an explicit, caller-configurable parameter
   * rather than a hard-coded, hidden constant. `referenceDate` is
   * injectable for deterministic testing and defaults to "now"; comparisons
   * use the Date object's underlying UTC instant, consistent with the rest
   * of this codebase's date handling.
   *
   * Reuses WarehouseInventory (read-only) and the StockMovement ledger
   * directly via Prisma — the same read pattern already used elsewhere for
   * cross-boundary data (e.g. WarehouseRoutingService) — and never touches
   * StockMovementsService.recordMovement() or any write path, so onHand and
   * the ledger itself are computed exactly as they already are; nothing is
   * duplicated or recalculated here.
   *
   * Results are sorted by (productId, warehouseId) ascending for
   * deterministic output, suitable for direct consumption by
   * ControlTowerService.
   */
  async getDeadStock(
    inactivityDays = 60,
    referenceDate: Date = new Date(),
    tx?: Prisma.TransactionClient,
  ): Promise<DeadStockEntry[]> {
    if (!Number.isInteger(inactivityDays) || inactivityDays < 0) {
      throw new BadRequestException(
        'inactivityDays must be a non-negative integer',
      );
    }
    const client = tx ?? this.prisma;
    const cutoff = new Date(referenceDate.getTime() - inactivityDays * DAY_MS);

    const [inventoryRows, lastMovements, lastOutgoingMovements] =
      await Promise.all([
        client.warehouseInventory.findMany({ where: { onHand: { gt: 0 } } }),
        client.stockMovement.groupBy({
          by: ['productId', 'warehouseId'],
          _max: { createdAt: true },
        }),
        client.stockMovement.groupBy({
          by: ['productId', 'warehouseId'],
          where: { type: { in: [...CONSUMPTION_TYPES] } },
          _max: { createdAt: true },
        }),
      ]);

    const lastMovementByKey = new Map<string, Date>();
    for (const movement of lastMovements) {
      if (movement._max.createdAt) {
        lastMovementByKey.set(
          this.inventoryKey(movement.productId, movement.warehouseId),
          movement._max.createdAt,
        );
      }
    }

    const lastOutgoingMovementByKey = new Map<string, Date>();
    for (const movement of lastOutgoingMovements) {
      if (movement._max.createdAt) {
        lastOutgoingMovementByKey.set(
          this.inventoryKey(movement.productId, movement.warehouseId),
          movement._max.createdAt,
        );
      }
    }

    return inventoryRows
      .map((row) => {
        const key = this.inventoryKey(row.productId, row.warehouseId);
        const lastMovementAt = lastMovementByKey.get(key) ?? null;
        const daysSinceLastMovement = lastMovementAt
          ? Math.floor(
              (referenceDate.getTime() - lastMovementAt.getTime()) / DAY_MS,
            )
          : null;
        const lastOutgoingMovementAt =
          lastOutgoingMovementByKey.get(key) ?? null;
        const daysSinceLastOutgoingMovement = lastOutgoingMovementAt
          ? Math.floor(
              (referenceDate.getTime() - lastOutgoingMovementAt.getTime()) /
                DAY_MS,
            )
          : null;
        return {
          productId: row.productId,
          warehouseId: row.warehouseId,
          onHand: row.onHand,
          lastMovementAt,
          daysSinceLastMovement,
          lastOutgoingMovementAt,
          daysSinceLastOutgoingMovement,
        };
      })
      .filter(
        (entry) =>
          entry.lastMovementAt === null ||
          entry.lastMovementAt.getTime() <= cutoff.getTime(),
      )
      .sort(
        (a, b) => a.productId - b.productId || a.warehouseId - b.warehouseId,
      );
  }

  /**
   * Read-only. Compares each product's total consumption (OUTGOING +
   * TRANSFER_OUT quantity, summed across warehouses) in the most recent
   * `windowDays` against the same-length window immediately before it, and
   * flags products whose change exceeds `thresholdPercent`. Consumption
   * scope (OUTGOING + TRANSFER_OUT) matches exactly the "decreasing" types
   * StockMovementsService already treats as reducing onHand — not a new
   * rule, just the existing one applied read-only.
   *
   * `windowDays` (default 30) and `thresholdPercent` (default 50) are not
   * documented anywhere in the schema/project docs, so both are explicit,
   * caller-configurable parameters rather than hidden hard-coded policy.
   * `referenceDate` is injectable for deterministic testing.
   *
   * A product with zero baseline consumption that has any recent
   * consumption is always flagged (percentChange is undefined from a zero
   * base, reported as null) — new consumption appearing from nothing is
   * itself the anomaly. A product with zero consumption in both windows is
   * never flagged (no change to speak of).
   *
   * Fetches the combined date range in a single call to
   * StockMovementsService.getLedger() (reused, not reimplemented) and
   * aggregates in memory — no direct StockMovement query, no duplicated
   * filtering logic. Results are sorted by |percentChange| descending
   * (products with no baseline — percentChange null — sort first, since
   * they represent the most extreme case: a change from zero), tie-broken
   * by productId ascending, for deterministic output suitable for
   * ControlTowerService.
   *
   * `minimumQuantityChange` (default 0 — a no-op) exists to let a caller
   * suppress noise like "1 unit -> 2 units = 100% increase": when set above
   * 0, a product is only flagged if the ABSOLUTE unit change also meets
   * this floor, in addition to the percentage threshold. No schema field or
   * documented business rule currently defines what that floor should be
   * (no "typical order size"/"minimum meaningful quantity" concept exists
   * anywhere in this project), so no non-zero default is invented here —
   * this stays exactly the existing percentage-only behavior until a real
   * value is confirmed and passed in by a caller. See the report for this
   * open decision.
   */
  async getConsumptionAnomalies(
    windowDays = 30,
    thresholdPercent = 50,
    referenceDate: Date = new Date(),
    minimumQuantityChange = 0,
  ): Promise<ConsumptionAnomaly[]> {
    if (!Number.isInteger(windowDays) || windowDays <= 0) {
      throw new BadRequestException('windowDays must be a positive integer');
    }
    if (typeof thresholdPercent !== 'number' || thresholdPercent <= 0) {
      throw new BadRequestException(
        'thresholdPercent must be a positive number',
      );
    }
    if (!Number.isInteger(minimumQuantityChange) || minimumQuantityChange < 0) {
      throw new BadRequestException(
        'minimumQuantityChange must be a non-negative integer',
      );
    }

    const recentStart = new Date(referenceDate.getTime() - windowDays * DAY_MS);
    const baselineStart = new Date(
      referenceDate.getTime() - 2 * windowDays * DAY_MS,
    );

    const movements = await this.stockMovementsService.getLedger({
      dateFrom: baselineStart,
      dateTo: referenceDate,
    });

    const recentByProduct = new Map<number, number>();
    const baselineByProduct = new Map<number, number>();

    for (const movement of movements) {
      if (!CONSUMPTION_TYPES.has(movement.type)) {
        continue;
      }
      const bucket =
        movement.createdAt.getTime() >= recentStart.getTime()
          ? recentByProduct
          : baselineByProduct;
      bucket.set(
        movement.productId,
        (bucket.get(movement.productId) ?? 0) + movement.quantity,
      );
    }

    const productIds = new Set([
      ...recentByProduct.keys(),
      ...baselineByProduct.keys(),
    ]);

    const anomalies: ConsumptionAnomaly[] = [];
    for (const productId of productIds) {
      const recentQuantity = recentByProduct.get(productId) ?? 0;
      const baselineQuantity = baselineByProduct.get(productId) ?? 0;

      if (baselineQuantity === 0) {
        if (recentQuantity > 0 && recentQuantity >= minimumQuantityChange) {
          anomalies.push({
            productId,
            recentQuantity,
            baselineQuantity,
            percentChange: null,
            direction: 'INCREASE',
          });
        }
        continue;
      }

      const percentChange =
        ((recentQuantity - baselineQuantity) / baselineQuantity) * 100;
      const absoluteChange = Math.abs(recentQuantity - baselineQuantity);
      if (
        Math.abs(percentChange) >= thresholdPercent &&
        absoluteChange >= minimumQuantityChange
      ) {
        anomalies.push({
          productId,
          recentQuantity,
          baselineQuantity,
          percentChange,
          direction:
            recentQuantity >= baselineQuantity ? 'INCREASE' : 'DECREASE',
        });
      }
    }

    return anomalies.sort((a, b) => {
      const magnitudeA =
        a.percentChange === null ? Infinity : Math.abs(a.percentChange);
      const magnitudeB =
        b.percentChange === null ? Infinity : Math.abs(b.percentChange);
      return magnitudeB - magnitudeA || a.productId - b.productId;
    });
  }

  /**
   * Read-only. For every WarehouseInventory row (including onHand === 0 —
   * unlike getDeadStock(), a zero-stock row is exactly what this function
   * needs to catch), computes:
   *   - `available` = onHand - SUM(ACTIVE reservations for that row) — the
   *     same formula ReservationsService.reserve() already applies inline
   *     before allowing a reservation; there is no existing bulk-read method
   *     for it, so it is recomputed here as a read-only aggregate rather than
   *     left undiscoverable, but the formula itself is not altered.
   *   - `riskLevel`, classified purely from `available` vs. the existing
   *     WarehouseInventory.reorderThreshold field — no numeric threshold is
   *     invented; reorderThreshold already IS the schema's reorder-trigger
   *     concept.
   *   - `pendingIncomingQuantity`, the sum of item quantities on PENDING
   *     INCOMING/TRANSFER transactions whose destinationWarehouseId matches
   *     this row, fetched via a single call to
   *     InventoryTransactionsService.findAllTransactions({status: PENDING})
   *     (reused, not reimplemented).
   *   - `projectedAvailable`/`projectedRiskLevel`, what risk looks like once
   *     that pending incoming stock actually arrives.
   *   - `avgDailyConsumption`/`daysOfSupply`, from the same
   *     StockMovementsService.getLedger() + OUTGOING/TRANSFER_OUT scope
   *     getConsumptionAnomalies() already uses, over `consumptionWindowDays`
   *     (default 30, caller-configurable, not a hidden constant).
   *   - `predictedStockoutDate` = referenceDate + daysOfSupply — derived
   *     from daysOfSupply, not a separate calculation. null whenever
   *     daysOfSupply is null (zero or insufficient consumption data): never
   *     an invented date.
   *
   * Never writes anything. Sorted by risk severity (OUT_OF_STOCK, then
   * AT_RISK, then OK), tie-broken by (productId, warehouseId), for
   * deterministic output suitable for getRestockRecommendations(),
   * getTransferRecommendations(), getControlTowerAlerts(), and the frontend.
   *
   * Only considers ACTIVE products at ACTIVE warehouses — restocking or
   * transferring stock for a discontinued product, or into/out of a
   * decommissioned warehouse, is a NEW operational decision this data feeds
   * directly (getRestockRecommendations/getTransferRecommendations reuse
   * this method's output verbatim), so the isActive filter lives here once
   * rather than being duplicated in each of them. getDeadStock() and
   * getConsumptionAnomalies() are deliberately NOT filtered — they answer a
   * different, historical question ("what happened / what's sitting idle"),
   * where an inactive product with leftover stock is exactly what should
   * still surface.
   */
  async getStockoutRisk(
    consumptionWindowDays = 30,
    referenceDate: Date = new Date(),
    tx?: Prisma.TransactionClient,
  ): Promise<StockoutRiskEntry[]> {
    if (
      !Number.isInteger(consumptionWindowDays) ||
      consumptionWindowDays <= 0
    ) {
      throw new BadRequestException(
        'consumptionWindowDays must be a positive integer',
      );
    }
    const client = tx ?? this.prisma;
    const windowStart = new Date(
      referenceDate.getTime() - consumptionWindowDays * DAY_MS,
    );

    const [inventoryRows, reservedGroups, pendingTransactions, movements] =
      await Promise.all([
        client.warehouseInventory.findMany({
          where: { product: { isActive: true }, warehouse: { isActive: true } },
        }),
        client.reservation.groupBy({
          by: ['productId', 'warehouseId'],
          where: { status: ReservationStatus.ACTIVE },
          _sum: { quantity: true },
        }),
        this.inventoryTransactionsService.findAllTransactions(
          { status: InventoryTransactionStatus.PENDING },
          tx,
        ),
        this.stockMovementsService.getLedger({
          dateFrom: windowStart,
          dateTo: referenceDate,
        }),
      ]);

    const activeReservedByKey = new Map<string, number>();
    for (const group of reservedGroups) {
      activeReservedByKey.set(
        this.inventoryKey(group.productId, group.warehouseId),
        group._sum.quantity ?? 0,
      );
    }

    const pendingIncomingByKey = new Map<string, number>();
    for (const transaction of pendingTransactions) {
      const isIncomingLike =
        transaction.type === InventoryTransactionType.INCOMING ||
        transaction.type === InventoryTransactionType.TRANSFER;
      if (!isIncomingLike || transaction.destinationWarehouseId === null) {
        continue;
      }
      for (const item of transaction.items) {
        const key = this.inventoryKey(
          item.productId,
          transaction.destinationWarehouseId,
        );
        pendingIncomingByKey.set(
          key,
          (pendingIncomingByKey.get(key) ?? 0) + item.quantity,
        );
      }
    }

    const consumptionByKey = new Map<string, number>();
    for (const movement of movements) {
      if (!CONSUMPTION_TYPES.has(movement.type)) {
        continue;
      }
      const key = this.inventoryKey(movement.productId, movement.warehouseId);
      consumptionByKey.set(
        key,
        (consumptionByKey.get(key) ?? 0) + movement.quantity,
      );
    }

    return inventoryRows
      .map((row) => {
        const key = this.inventoryKey(row.productId, row.warehouseId);
        const activeReserved = activeReservedByKey.get(key) ?? 0;
        const available = row.onHand - activeReserved;
        const pendingIncomingQuantity = pendingIncomingByKey.get(key) ?? 0;
        const projectedAvailable = available + pendingIncomingQuantity;
        const totalConsumption = consumptionByKey.get(key) ?? 0;
        const avgDailyConsumption = totalConsumption / consumptionWindowDays;
        const daysOfSupply =
          avgDailyConsumption > 0 ? available / avgDailyConsumption : null;
        // Derived from daysOfSupply, not a separate calculation — null under
        // the exact same "no/insufficient consumption data" condition, so no
        // date is ever invented.
        const predictedStockoutDate =
          daysOfSupply !== null
            ? new Date(referenceDate.getTime() + daysOfSupply * DAY_MS)
            : null;

        return {
          productId: row.productId,
          warehouseId: row.warehouseId,
          onHand: row.onHand,
          activeReserved,
          available,
          reorderThreshold: row.reorderThreshold,
          riskLevel: this.classifyRisk(available, row.reorderThreshold),
          pendingIncomingQuantity,
          projectedAvailable,
          projectedRiskLevel: this.classifyRisk(
            projectedAvailable,
            row.reorderThreshold,
          ),
          avgDailyConsumption,
          daysOfSupply,
          predictedStockoutDate,
        };
      })
      .sort(
        (a, b) =>
          RISK_SEVERITY[a.riskLevel] - RISK_SEVERITY[b.riskLevel] ||
          a.productId - b.productId ||
          a.warehouseId - b.warehouseId,
      );
  }

  /**
   * Read-only. Reuses getStockoutRisk() (no separate risk calculation) and
   * walks the confirmed decision tree for every row STILL at risk AFTER
   * pending incoming stock is accounted for (`projectedRiskLevel !== 'OK'`):
   * a row pending incoming would fully resolve is excluded from the results
   * entirely — no recommendation, no `recommendedQuantity: 0` placeholder,
   * nothing to act on.
   *   1. Can another warehouse provide it? Reuses getTransferRecommendations()
   *      (no donor-matching logic duplicated here) and checks whether this
   *      (productId, warehouseId) appears as a `toWarehouseId` in its output
   *      -> reason: 'transfer_available'.
   *   2. Otherwise -> reason: 'purchase_required'.
   * `recommendedQuantity` brings `projectedAvailable` back up to the
   * existing `reorderThreshold` field; no separate "target stock level"
   * field exists in the schema, so reorderThreshold is used as both trigger
   * and target (see report — flagged as an assumption, not invented
   * silently). `explanation` is a human-readable sentence built entirely
   * from fields already on the entry — no new computation. Sorted by
   * projectedRiskLevel severity, then recommended quantity descending, then
   * (productId, warehouseId).
   *
   * Note: this calls getStockoutRisk() once directly and once more inside
   * getTransferRecommendations() (which calls it independently) — a known,
   * accepted minor re-fetch of read-only data, not a duplication of
   * business logic; both calls reuse the exact same formulas.
   *
   * Inactive products/warehouses are already excluded by getStockoutRisk()
   * itself, so they never reach this method — no separate isActive check
   * needed here.
   */
  async getRestockRecommendations(
    consumptionWindowDays = 30,
    referenceDate: Date = new Date(),
    tx?: Prisma.TransactionClient,
  ): Promise<RestockRecommendation[]> {
    const riskEntries = await this.getStockoutRisk(
      consumptionWindowDays,
      referenceDate,
      tx,
    );

    // Only rows STILL at risk after pending incoming is accounted for.
    // A row pending incoming would fully resolve is excluded entirely —
    // there is nothing to recommend for it, not even a zero-quantity,
    // informational row.
    const candidates = riskEntries.filter(
      (entry) => entry.projectedRiskLevel !== 'OK',
    );

    const transferAvailableKeys = candidates.length
      ? new Set(
          (
            await this.getTransferRecommendations(
              consumptionWindowDays,
              referenceDate,
              tx,
            )
          ).map((transfer) =>
            this.inventoryKey(transfer.productId, transfer.toWarehouseId),
          ),
        )
      : new Set<string>();

    return candidates
      .map((entry) => {
        const recommendedQuantity = Math.max(
          entry.reorderThreshold - entry.projectedAvailable,
          0,
        );
        const reason: RestockReason = transferAvailableKeys.has(
          this.inventoryKey(entry.productId, entry.warehouseId),
        )
          ? 'transfer_available'
          : 'purchase_required';
        const explanation = this.explainRestockReason(reason, entry);

        return {
          productId: entry.productId,
          warehouseId: entry.warehouseId,
          available: entry.available,
          pendingIncomingQuantity: entry.pendingIncomingQuantity,
          projectedAvailable: entry.projectedAvailable,
          reorderThreshold: entry.reorderThreshold,
          riskLevel: entry.riskLevel,
          projectedRiskLevel: entry.projectedRiskLevel,
          recommendedQuantity,
          avgDailyConsumption: entry.avgDailyConsumption,
          daysOfSupply: entry.daysOfSupply,
          reason,
          explanation,
        };
      })
      .sort(
        (a, b) =>
          RISK_SEVERITY[a.projectedRiskLevel] -
            RISK_SEVERITY[b.projectedRiskLevel] ||
          b.recommendedQuantity - a.recommendedQuantity ||
          a.productId - b.productId ||
          a.warehouseId - b.warehouseId,
      );
  }

  private explainRestockReason(
    reason: RestockReason,
    entry: StockoutRiskEntry,
  ): string {
    switch (reason) {
      case 'transfer_available':
        return `Another warehouse currently holds surplus stock of this product, so the shortfall can be covered by an internal transfer instead of a new purchase.`;
      case 'purchase_required':
        return `No pending incoming stock and no warehouse surplus are available for this product, so a new purchase is required to reach the reorder threshold (${entry.reorderThreshold}).`;
    }
  }

  /**
   * Read-only. Reuses getStockoutRisk() (no separate risk calculation) and,
   * per product, greedily matches warehouses still at risk after pending
   * incoming (`projectedRiskLevel !== 'OK'`) against warehouses currently
   * holding more than their own reorderThreshold (`available -
   * reorderThreshold` donatable). Donor capacity is based on CURRENT
   * `available` (only stock a warehouse physically holds today can be
   * shipped); recipient need is based on `projectedAvailable` (a recipient
   * whose own pending incoming already fixes it is not matched). Matching
   * is deterministic: within a product, deficits and donors are each
   * processed in warehouseId order, each donor filling each deficit by
   * min(remaining need, remaining donatable) before moving to the next.
   * This is a simple availability-matching recommendation, not a logistics/
   * route optimizer (out of scope — see Path Optimizer in other phases;
   * Path Optimizer answers "which eligible warehouse is nearest", this
   * answers "where should stock come from" — kept separate, no dependency
   * between them). Never writes anything; a real transfer still has to go
   * through InventoryTransactionsService.createTransfer() + complete()
   * elsewhere.
   *
   * Each recommendation also carries context drawn from data already
   * fetched for this call — no new formula, no extra query beyond one
   * reused getDeadStock() call: the donor's own pending incoming quantity,
   * whether the donor's stock is itself flagged dead/slow-moving (useful
   * context for why donating it is low-cost), and the recipient's current
   * risk level / demand / days of supply (why the shortage matters).
   * "Warehouse capacity" (Warehouse.maxCapacity) is NOT factored in — see
   * report, flagged as an open decision rather than guessed.
   *
   * Inactive products/warehouses are already excluded by getStockoutRisk()
   * itself (both as a potential source and a potential destination), so
   * they never reach this method — no separate isActive check needed here.
   */
  async getTransferRecommendations(
    consumptionWindowDays = 30,
    referenceDate: Date = new Date(),
    tx?: Prisma.TransactionClient,
  ): Promise<TransferRecommendation[]> {
    const riskEntries = await this.getStockoutRisk(
      consumptionWindowDays,
      referenceDate,
      tx,
    );

    const byProduct = new Map<number, StockoutRiskEntry[]>();
    for (const entry of riskEntries) {
      const list = byProduct.get(entry.productId) ?? [];
      list.push(entry);
      byProduct.set(entry.productId, list);
    }

    const availableRemainingByKey = new Map<string, number>();
    const projectedRemainingByKey = new Map<string, number>();
    for (const entry of riskEntries) {
      const key = this.inventoryKey(entry.productId, entry.warehouseId);
      availableRemainingByKey.set(key, entry.available);
      projectedRemainingByKey.set(key, entry.projectedAvailable);
    }

    // Only fetched when at least one row is at risk — reused (the same
    // confirmed 60-day rule), not recalculated, and gives each recommended
    // donor extra context: is the stock it's donating also slow-moving?
    const hasAnyDeficit = riskEntries.some(
      (entry) => entry.projectedRiskLevel !== 'OK',
    );
    const deadStockKeys = hasAnyDeficit
      ? new Set(
          (await this.getDeadStock(undefined, referenceDate, tx)).map((entry) =>
            this.inventoryKey(entry.productId, entry.warehouseId),
          ),
        )
      : new Set<string>();

    const recommendations: TransferRecommendation[] = [];

    for (const [productId, entries] of byProduct) {
      const entryByWarehouseId = new Map(
        entries.map((entry) => [entry.warehouseId, entry]),
      );

      const deficits = entries
        .filter((entry) => entry.projectedRiskLevel !== 'OK')
        .map((entry) => ({
          warehouseId: entry.warehouseId,
          remaining: Math.max(
            entry.reorderThreshold - entry.projectedAvailable,
            0,
          ),
        }))
        .filter((deficit) => deficit.remaining > 0)
        .sort((a, b) => a.warehouseId - b.warehouseId);

      const donors = entries
        .map((entry) => ({
          warehouseId: entry.warehouseId,
          remaining: Math.max(entry.available - entry.reorderThreshold, 0),
        }))
        .filter((donor) => donor.remaining > 0)
        .sort((a, b) => a.warehouseId - b.warehouseId);

      if (deficits.length === 0 || donors.length === 0) {
        continue;
      }

      for (const deficit of deficits) {
        for (const donor of donors) {
          if (deficit.remaining <= 0) {
            break;
          }
          if (
            donor.warehouseId === deficit.warehouseId ||
            donor.remaining <= 0
          ) {
            continue;
          }

          const transferQuantity = Math.min(deficit.remaining, donor.remaining);
          if (transferQuantity <= 0) {
            continue;
          }

          const donorKey = this.inventoryKey(productId, donor.warehouseId);
          const recipientKey = this.inventoryKey(
            productId,
            deficit.warehouseId,
          );
          const fromWarehouseAvailableAfterTransfer =
            (availableRemainingByKey.get(donorKey) ?? 0) - transferQuantity;
          const toWarehouseProjectedAvailableAfterTransfer =
            (projectedRemainingByKey.get(recipientKey) ?? 0) + transferQuantity;
          availableRemainingByKey.set(
            donorKey,
            fromWarehouseAvailableAfterTransfer,
          );
          projectedRemainingByKey.set(
            recipientKey,
            toWarehouseProjectedAvailableAfterTransfer,
          );

          // Present on every row processed here — entryByWarehouseId is
          // built from the same `entries` deficits/donors were derived from.
          const donorEntry = entryByWarehouseId.get(donor.warehouseId)!;
          const recipientEntry = entryByWarehouseId.get(deficit.warehouseId)!;

          recommendations.push({
            productId,
            fromWarehouseId: donor.warehouseId,
            toWarehouseId: deficit.warehouseId,
            transferQuantity,
            fromWarehouseAvailableAfterTransfer,
            toWarehouseProjectedAvailableAfterTransfer,
            sourcePendingIncomingQuantity: donorEntry.pendingIncomingQuantity,
            sourceIsDeadStock: deadStockKeys.has(donorKey),
            destinationRiskLevel: recipientEntry.riskLevel,
            destinationAvgDailyConsumption: recipientEntry.avgDailyConsumption,
            destinationDaysOfSupply: recipientEntry.daysOfSupply,
          });

          deficit.remaining -= transferQuantity;
          donor.remaining -= transferQuantity;
        }
      }
    }

    return recommendations.sort(
      (a, b) =>
        a.productId - b.productId ||
        a.fromWarehouseId - b.fromWarehouseId ||
        a.toWarehouseId - b.toWarehouseId,
    );
  }

  /**
   * Read-only. Aggregates already-computed results from this service
   * (getDeadStock, getConsumptionAnomalies, getStockoutRisk,
   * getRestockRecommendations, getTransferRecommendations),
   * InventoryTransactionsService.getOverdueTransactions(), and
   * DocumentReviewService.getPendingReviews() into one structured alert
   * list — no calculation happens here beyond severity classification and
   * message formatting; `data` on every alert is the underlying entry
   * verbatim, for the future NotificationService/dashboard to act on
   * without re-deriving anything. Confirmed severity mapping: stockout risk
   * (OUT_OF_STOCK and AT_RISK alike) -> CRITICAL; overdue transactions and
   * consumption anomalies -> WARNING; dead stock and pending document
   * review -> INFO. Restock/transfer recommendations -> WARNING (new in
   * this phase, not previously confirmed — see report). Sorted by severity
   * (CRITICAL, WARNING, INFO); order within a severity follows the
   * already-deterministic order of the underlying source list (stable
   * sort).
   *
   * Calling getRestockRecommendations()/getTransferRecommendations() here
   * means getStockoutRisk() is recomputed multiple times within one
   * aggregation call (see notes on those two methods) — an accepted,
   * documented tradeoff of composing existing read-only functions as black
   * boxes rather than duplicating any of their logic.
   */
  async getControlTowerAlerts(
    options: ControlTowerAlertOptions = {},
    referenceDate: Date = new Date(),
    tx?: Prisma.TransactionClient,
  ): Promise<ControlTowerAlert[]> {
    const [
      deadStock,
      anomalies,
      stockoutRisk,
      overdueTransactions,
      pendingReviews,
      restockRecommendations,
      transferRecommendations,
    ] = await Promise.all([
      this.getDeadStock(options.deadStockInactivityDays, referenceDate, tx),
      this.getConsumptionAnomalies(
        options.consumptionWindowDays,
        options.consumptionThresholdPercent,
        referenceDate,
      ),
      this.getStockoutRisk(options.consumptionWindowDays, referenceDate, tx),
      this.inventoryTransactionsService.getOverdueTransactions(
        referenceDate,
        tx,
      ),
      this.documentReviewService.getPendingReviews(tx),
      this.getRestockRecommendations(
        options.consumptionWindowDays,
        referenceDate,
        tx,
      ),
      this.getTransferRecommendations(
        options.consumptionWindowDays,
        referenceDate,
        tx,
      ),
    ]);

    const alerts: ControlTowerAlert[] = [];

    for (const entry of deadStock) {
      alerts.push({
        category: 'DEAD_STOCK',
        severity: 'INFO',
        message:
          entry.lastMovementAt === null
            ? `Product ${entry.productId} in warehouse ${entry.warehouseId} has ${entry.onHand} units on hand and has never had a stock movement`
            : `Product ${entry.productId} in warehouse ${entry.warehouseId} has ${entry.onHand} units on hand with no movement in ${entry.daysSinceLastMovement} days`,
        data: entry as unknown as Record<string, unknown>,
        referenceDate,
      });
    }

    for (const entry of anomalies) {
      alerts.push({
        category: 'CONSUMPTION_ANOMALY',
        severity: 'WARNING',
        message:
          entry.percentChange === null
            ? `Product ${entry.productId} consumption appeared from zero: ${entry.recentQuantity} units in the recent window`
            : `Product ${entry.productId} consumption ${entry.direction === 'INCREASE' ? 'increased' : 'decreased'} ${Math.abs(entry.percentChange).toFixed(1)}% (baseline ${entry.baselineQuantity} -> recent ${entry.recentQuantity})`,
        data: entry as unknown as Record<string, unknown>,
        referenceDate,
      });
    }

    for (const entry of stockoutRisk) {
      if (entry.riskLevel === 'OK') {
        continue;
      }
      // Confirmed severity mapping: every non-OK stockout risk entry
      // (OUT_OF_STOCK and AT_RISK alike) is CRITICAL — stockout risk has no
      // WARNING tier of its own.
      const stockoutDateSuffix =
        entry.predictedStockoutDate !== null
          ? ` (predicted stockout: ${entry.predictedStockoutDate.toISOString()})`
          : '';
      alerts.push({
        category: 'STOCKOUT_RISK',
        severity: 'CRITICAL',
        message:
          (entry.riskLevel === 'OUT_OF_STOCK'
            ? `Product ${entry.productId} is out of stock in warehouse ${entry.warehouseId} (available: ${entry.available})`
            : `Product ${entry.productId} in warehouse ${entry.warehouseId} is at risk (available: ${entry.available}, reorderThreshold: ${entry.reorderThreshold})`) +
          stockoutDateSuffix,
        data: entry as unknown as Record<string, unknown>,
        referenceDate,
      });
    }

    for (const transaction of overdueTransactions) {
      alerts.push({
        category: 'OVERDUE_TRANSACTION',
        severity: 'WARNING',
        message: `${transaction.type} transaction ${transaction.id} is overdue (expected ${transaction.expectedDate?.toISOString() ?? 'unknown'})`,
        data: transaction,
        referenceDate,
      });
    }

    for (const review of pendingReviews) {
      alerts.push({
        category: 'PENDING_DOCUMENT_REVIEW',
        severity: 'INFO',
        message: `Document review ${review.id} (${review.transactionType}) is awaiting a decision`,
        data: review,
        referenceDate,
      });
    }

    for (const recommendation of restockRecommendations) {
      alerts.push({
        category: 'RESTOCK_RECOMMENDATION',
        severity: 'WARNING',
        message: `Product ${recommendation.productId} in warehouse ${recommendation.warehouseId} needs ${recommendation.recommendedQuantity} more units (${recommendation.reason}): ${recommendation.explanation}`,
        data: recommendation as unknown as Record<string, unknown>,
        referenceDate,
      });
    }

    for (const transfer of transferRecommendations) {
      alerts.push({
        category: 'TRANSFER_RECOMMENDATION',
        severity: 'WARNING',
        message: `Transfer ${transfer.transferQuantity} units of product ${transfer.productId} from warehouse ${transfer.fromWarehouseId} to warehouse ${transfer.toWarehouseId}`,
        data: transfer as unknown as Record<string, unknown>,
        referenceDate,
      });
    }

    return alerts.sort(
      (a, b) =>
        ALERT_SEVERITY_ORDER[a.severity] - ALERT_SEVERITY_ORDER[b.severity],
    );
  }

  private classifyRisk(
    available: number,
    reorderThreshold: number,
  ): StockoutRiskLevel {
    if (available <= 0) {
      return 'OUT_OF_STOCK';
    }

    if (available < reorderThreshold) {
      return 'AT_RISK';
    }

    return 'OK';
  }

  private inventoryKey(productId: number, warehouseId: number): string {
    return `${productId}:${warehouseId}`;
  }
}
