import { Inject, Injectable } from '@nestjs/common';
import {
  InventoryTransactionStatus,
  Prisma,
} from '../../generated/prisma/client';

/**
 * DI token for SuppliersHistoryProvider — interfaces have no runtime
 * identity, so NestJS can't resolve it by type alone the way it does for a
 * concrete class. SupplierIntelligenceModule does NOT bind this token
 * itself (Joseph's SuppliersService isn't present on this branch); it must
 * be provided at merge time, e.g. `{ provide: SUPPLIERS_HISTORY_PROVIDER,
 * useExisting: SuppliersService }` in whichever module composes both.
 */
export const SUPPLIERS_HISTORY_PROVIDER = Symbol('SUPPLIERS_HISTORY_PROVIDER');

/**
 * Matches the real return shape of SuppliersService.getTransactionHistory()
 * on feature/joseph-backend: a Supplier row with nested transactions -> items -> product.
 * Typed against Joseph's actual query rather than owning/importing his file directly.
 */
export type SupplierTransactionHistory = Prisma.SupplierGetPayload<{
  include: {
    transactions: {
      include: {
        items: {
          include: {
            product: true;
          };
        };
      };
    };
  };
}>;

type SupplierTransaction = SupplierTransactionHistory['transactions'][number];

export interface SupplierSummary {
  id: number;
  name: string;
  /**
   * Added when Supplier.isActive landed in the schema. Joseph's real
   * findAll() already selects full Supplier rows, so it structurally
   * satisfies this extended contract without any change to his file — same
   * technique already used for adding findAll() itself (see below).
   */
  isActive: boolean;
}

/**
 * The only things this service depends on from Joseph's SuppliersService.
 * Depending on this contract (not the concrete class) keeps this file free of any
 * import into suppliers.service.ts / suppliers.module.ts, per the file-ownership split
 * in Backend-Team-Split.md / Salman-Backend-Plan.md.
 *
 * findAll() was added here (Combined Step 3) because there is no direct
 * Supplier <-> Product relation in the schema — the only way to discover which
 * suppliers have supplied a given product is to enumerate suppliers and inspect
 * each one's transaction items. Joseph's real findAll() (feature/joseph-backend)
 * already returns Supplier rows with at least `id`/`name`, so it structurally
 * satisfies this without any change to his file.
 */
export interface SuppliersHistoryProvider {
  getTransactionHistory(
    supplierId: number,
  ): Promise<SupplierTransactionHistory | null>;
  findAll(): Promise<SupplierSummary[]>;
}

export interface SupplierStats {
  supplierId: number;

  totalTransactions: number;
  completedTransactions: number;
  cancelledTransactions: number;
  cancellationRate: number;

  averagePrice: number | null;
  pricedItemCount: number;

  onTimeDeliveryRate: number | null;
  evaluatedForOnTimeCount: number;

  purchaseFrequency: number;
  firstPurchaseDate: Date | null;
  lastPurchaseDate: Date | null;
}

/**
 * getSupplierStats() plus the identifying/context fields needed when a supplier
 * is being compared against others for one specific product. Reuses SupplierStats
 * rather than duplicating its fields.
 */
export interface SupplierProductComparison extends SupplierStats {
  supplierName: string;
  productId: number;
}

/**
 * Normalized (0-100) per-factor scores, before weighting. price/onTimeDelivery/
 * productSupplyHistory are null when that supplier lacks the underlying stat
 * (insufficient data) — never fabricated. cancellationPerformance is always
 * present because compareSuppliers() only returns suppliers with at least one
 * relevant transaction, so cancellationRate is always computable.
 */
export interface SupplierRankingComponentScores {
  price: number | null;
  onTimeDelivery: number | null;
  cancellationPerformance: number;
  productSupplyHistory: number | null;
}

export interface RankedSupplier extends SupplierProductComparison {
  /** 1-based rank among fully-evaluated suppliers; null for insufficient-data suppliers (not ranked). */
  rank: number | null;
  /** Weighted composite score (0-100); null when insufficientData is true. */
  score: number | null;
  insufficientData: boolean;
  /** Human-readable reasons a composite score could not be computed. Empty when insufficientData is false. */
  insufficientDataReasons: string[];
  componentScores: SupplierRankingComponentScores;
}

/**
 * Ranking formula (business rule, confirmed 2026-08-16, updated 2026-08-16 — not invented):
 *   40% price (lower is better)
 *   30% on-time delivery rate (higher is better)
 *   20% cancellation performance (lower cancellation rate is better)
 *   10% product supply history (higher COMPLETED-transaction count for this product is better)
 * Each factor is normalized 0-100 relative to the candidate set for that product
 * (min-max normalization), not against suppliers outside the comparison.
 */
const RANKING_WEIGHTS = {
  price: 0.4,
  onTimeDelivery: 0.3,
  cancellationPerformance: 0.2,
  productSupplyHistory: 0.1,
} as const;

/**
 * Evidence rule: fewer than this many COMPLETED transactions for the requested
 * product means the supply-history stat is not reliable enough to score — the
 * supplier is treated as insufficientData rather than fabricating a low score.
 */
const MIN_COMPLETED_TRANSACTIONS_FOR_HISTORY = 3;

const DAY_MS = 24 * 60 * 60 * 1000;
const FREQUENCY_WINDOW_DAYS = 30;

function minMax(values: number[]): { min: number; max: number } | null {
  if (values.length === 0) {
    return null;
  }
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Min-max normalization to a 0-100 scale. When every candidate has the same
 * value (max === min), there is no basis to prefer one over another on this
 * factor, so everyone gets 100 (no relative disadvantage) rather than an
 * arbitrary midpoint.
 */
function normalize(
  value: number,
  range: { min: number; max: number },
  higherIsBetter: boolean,
): number {
  if (range.max === range.min) {
    return 100;
  }
  const ratio = (value - range.min) / (range.max - range.min);
  return (higherIsBetter ? ratio : 1 - ratio) * 100;
}

@Injectable()
export class SupplierIntelligenceService {
  constructor(
    @Inject(SUPPLIERS_HISTORY_PROVIDER)
    private readonly suppliersService: SuppliersHistoryProvider,
  ) {}

  async getSupplierStats(supplierId: number): Promise<SupplierStats> {
    const supplier =
      await this.suppliersService.getTransactionHistory(supplierId);

    return this.computeStats(supplierId, supplier?.transactions ?? []);
  }

  /**
   * Compares suppliers that have actually supplied `productId`, using only that
   * product's transactions/line items for every metric (price, transaction count,
   * on-time rate, cancellation rate) — not the supplier's overall history. There is
   * no Supplier <-> Product relation in the schema, so candidates are discovered by
   * enumerating all suppliers and checking their transaction items for this product.
   *
   * Suppliers who never supplied this product are excluded entirely, not scored as 0.
   * Returns [] (not an error) when no supplier has supplied this product.
   *
   * Inactive suppliers are excluded from candidates — compareSuppliers()
   * feeds rankSuppliers()/getBestSupplier(), which recommend who to buy
   * from NEXT, a new-purchase decision an inactive supplier must not
   * participate in. getSupplierStats(id) (direct lookup, historical) is
   * unaffected — a formerly-active supplier's past stats stay readable.
   */
  async compareSuppliers(
    productId: number,
  ): Promise<SupplierProductComparison[]> {
    const suppliers = await this.suppliersService.findAll();
    const comparisons: SupplierProductComparison[] = [];

    for (const supplier of suppliers) {
      if (!supplier.isActive) {
        continue;
      }
      const history = await this.suppliersService.getTransactionHistory(
        supplier.id,
      );
      const relevantTransactions = this.scopeTransactionsToProduct(
        history?.transactions ?? [],
        productId,
      );

      if (relevantTransactions.length === 0) {
        continue;
      }

      comparisons.push({
        ...this.computeStats(supplier.id, relevantTransactions),
        supplierName: supplier.name,
        productId,
      });
    }

    return comparisons;
  }

  /**
   * Ranks suppliers that have supplied `productId`, using the weighted formula in
   * RANKING_WEIGHTS. Reuses compareSuppliers() for supplier discovery and stats —
   * no independent database query, no duplicated discovery logic.
   *
   * Suppliers missing averagePrice, onTimeDeliveryRate, or with fewer than
   * MIN_COMPLETED_TRANSACTIONS_FOR_HISTORY completed transactions for this product
   * get insufficientData: true, score: null, rank: null — never a fabricated score.
   * They are sorted after every fully-evaluated supplier, ordered by supplierId for
   * determinism. Fully-evaluated suppliers are sorted by score descending, ties
   * broken by supplierId ascending (a stable, documented tie-breaker rather than
   * insertion order or randomness).
   */
  async rankSuppliers(productId: number): Promise<RankedSupplier[]> {
    const candidates = await this.compareSuppliers(productId);

    if (candidates.length === 0) {
      return [];
    }

    // cancellationRate is always defined here: compareSuppliers() only returns
    // suppliers with >=1 relevant transaction, so it's always computable.
    const priceRange = minMax(
      candidates
        .filter((c) => c.averagePrice !== null)
        .map((c) => c.averagePrice as number),
    );
    const onTimeRange = minMax(
      candidates
        .filter((c) => c.onTimeDeliveryRate !== null)
        .map((c) => c.onTimeDeliveryRate as number),
    );
    const cancellationRange = minMax(candidates.map((c) => c.cancellationRate));
    // Product supply history = COMPLETED transactions for this product. Only
    // suppliers meeting the evidence threshold contribute to (and are eligible
    // for) this factor's normalization range.
    const historyRange = minMax(
      candidates
        .filter(
          (c) =>
            c.completedTransactions >= MIN_COMPLETED_TRANSACTIONS_FOR_HISTORY,
        )
        .map((c) => c.completedTransactions),
    );

    const scored: RankedSupplier[] = candidates.map((candidate) => {
      const insufficientDataReasons: string[] = [];
      if (candidate.averagePrice === null) {
        insufficientDataReasons.push(
          'averagePrice unavailable: no priced items for this product from this supplier',
        );
      }
      if (candidate.onTimeDeliveryRate === null) {
        insufficientDataReasons.push(
          'onTimeDeliveryRate unavailable: no transactions with both expectedDate and actualDate',
        );
      }
      const hasSufficientHistory =
        candidate.completedTransactions >=
        MIN_COMPLETED_TRANSACTIONS_FOR_HISTORY;
      if (!hasSufficientHistory) {
        insufficientDataReasons.push(
          `productSupplyHistory unavailable: fewer than ${MIN_COMPLETED_TRANSACTIONS_FOR_HISTORY} completed transactions for this product (has ${candidate.completedTransactions})`,
        );
      }

      const priceScore =
        candidate.averagePrice === null || !priceRange
          ? null
          : normalize(candidate.averagePrice, priceRange, false);
      const onTimeScore =
        candidate.onTimeDeliveryRate === null || !onTimeRange
          ? null
          : normalize(candidate.onTimeDeliveryRate, onTimeRange, true);
      // Guaranteed non-null: see comment above on cancellationRange.
      const cancellationScore = normalize(
        candidate.cancellationRate,
        cancellationRange!,
        false,
      );
      const historyScore =
        !hasSufficientHistory || !historyRange
          ? null
          : normalize(candidate.completedTransactions, historyRange, true);

      const insufficientData =
        priceScore === null || onTimeScore === null || historyScore === null;
      const score = insufficientData
        ? null
        : RANKING_WEIGHTS.price * priceScore +
          RANKING_WEIGHTS.onTimeDelivery * onTimeScore +
          RANKING_WEIGHTS.cancellationPerformance * cancellationScore +
          RANKING_WEIGHTS.productSupplyHistory * historyScore;

      return {
        ...candidate,
        rank: null,
        score,
        insufficientData,
        insufficientDataReasons,
        componentScores: {
          price: priceScore,
          onTimeDelivery: onTimeScore,
          cancellationPerformance: cancellationScore,
          productSupplyHistory: historyScore,
        },
      };
    });

    const fullyEvaluated = scored
      .filter((s) => !s.insufficientData)
      .sort((a, b) => b.score! - a.score! || a.supplierId - b.supplierId);
    fullyEvaluated.forEach((s, index) => {
      s.rank = index + 1;
    });

    const insufficientData = scored
      .filter((s) => s.insufficientData)
      .sort((a, b) => a.supplierId - b.supplierId);

    return [...fullyEvaluated, ...insufficientData];
  }

  /**
   * The single highest-ranked (rank === 1) supplier for `productId`, per
   * rankSuppliers() — no separate scoring algorithm. Returns null (not a thrown
   * error) when there are no suppliers for the product, or when none of them
   * could be fully evaluated (no supplier reached rank 1).
   */
  async getBestSupplier(productId: number): Promise<RankedSupplier | null> {
    const ranked = await this.rankSuppliers(productId);
    return ranked.find((s) => s.rank === 1) ?? null;
  }

  /**
   * Narrows transactions to only those containing at least one line item for
   * `productId`, and narrows each surviving transaction's `items` to just that
   * product's items. This is what makes averagePrice/pricedItemCount (computed
   * from `items`) product-specific, while totalTransactions/completedTransactions/
   * cancellationRate/onTimeDeliveryRate (computed from the transaction list itself)
   * are scoped to "transactions where this product appears".
   */
  private scopeTransactionsToProduct(
    transactions: SupplierTransaction[],
    productId: number,
  ): SupplierTransaction[] {
    return transactions
      .map((transaction) => ({
        ...transaction,
        items: transaction.items.filter((item) => item.productId === productId),
      }))
      .filter((transaction) => transaction.items.length > 0);
  }

  private computeStats(
    supplierId: number,
    transactions: SupplierTransaction[],
  ): SupplierStats {
    const totalTransactions = transactions.length;

    const completedTransactions = transactions.filter(
      (t) => t.status === InventoryTransactionStatus.COMPLETED,
    ).length;
    const cancelledTransactions = transactions.filter(
      (t) => t.status === InventoryTransactionStatus.CANCELLED,
    ).length;
    const cancellationRate =
      totalTransactions === 0 ? 0 : cancelledTransactions / totalTransactions;

    const prices = transactions
      .flatMap((t) => t.items)
      .filter((item) => item.price !== null)
      .map((item) => item.price!.toNumber());
    const pricedItemCount = prices.length;
    const averagePrice =
      pricedItemCount === 0
        ? null
        : prices.reduce((sum, price) => sum + price, 0) / pricedItemCount;

    const evaluable = transactions.filter(
      (t) => t.expectedDate !== null && t.actualDate !== null,
    );
    const evaluatedForOnTimeCount = evaluable.length;
    const onTimeCount = evaluable.filter(
      (t) => t.actualDate!.getTime() <= t.expectedDate!.getTime(),
    ).length;
    const onTimeDeliveryRate =
      evaluatedForOnTimeCount === 0
        ? null
        : onTimeCount / evaluatedForOnTimeCount;

    const sortedDates = transactions
      .map((t) => t.createdAt)
      .sort((a, b) => a.getTime() - b.getTime());
    const firstPurchaseDate = sortedDates[0] ?? null;
    const lastPurchaseDate = sortedDates[sortedDates.length - 1] ?? null;

    let purchaseFrequency = 0;
    if (totalTransactions > 0 && firstPurchaseDate && lastPurchaseDate) {
      const spanDays = Math.max(
        (lastPurchaseDate.getTime() - firstPurchaseDate.getTime()) / DAY_MS,
        1,
      );
      purchaseFrequency =
        (totalTransactions / spanDays) * FREQUENCY_WINDOW_DAYS;
    }

    return {
      supplierId,
      totalTransactions,
      completedTransactions,
      cancelledTransactions,
      cancellationRate,
      averagePrice,
      pricedItemCount,
      onTimeDeliveryRate,
      evaluatedForOnTimeCount,
      purchaseFrequency,
      firstPurchaseDate,
      lastPurchaseDate,
    };
  }
}
