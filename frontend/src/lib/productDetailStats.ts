import type { RestockRecommendation, StockHistoryEntry } from "../types/domain";
import type { ProductWarehouseStockRow } from "./productStock.api";

export interface StockAggregate {
  totalOnHand: number;
  totalReserved: number;
  totalAvailable: number;
  totalReorderThreshold: number;
}

export function aggregateStock(rows: ProductWarehouseStockRow[]): StockAggregate {
  return rows.reduce(
    (acc, r) => ({
      totalOnHand: acc.totalOnHand + r.onHand,
      totalReserved: acc.totalReserved + r.reserved,
      totalAvailable: acc.totalAvailable + r.available,
      totalReorderThreshold: acc.totalReorderThreshold + r.reorderThreshold,
    }),
    { totalOnHand: 0, totalReserved: 0, totalAvailable: 0, totalReorderThreshold: 0 },
  );
}

// Bar reads as "how full relative to the combined reorder threshold" — 100%
// means at or above threshold, matching the same line the status badge uses.
export function stockBarPct(totalAvailable: number, totalReorderThreshold: number): number {
  if (totalReorderThreshold <= 0) return totalAvailable > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.round((totalAvailable / totalReorderThreshold) * 100)));
}

// Picks the single most urgent recommendation for this product across
// whichever warehouses have one — highest recommendedQuantity first.
export function pickRestockRecommendation(
  recommendations: RestockRecommendation[],
  productId: number,
): RestockRecommendation | null {
  const matches = recommendations.filter((r) => r.productId === productId);
  if (matches.length === 0) return null;
  return matches.reduce((best, r) => (r.recommendedQuantity > best.recommendedQuantity ? r : best));
}

const MOVEMENT_VERBS: Record<StockHistoryEntry["type"], string> = {
  INCOMING: "Incoming to",
  OUTGOING: "Outgoing from",
  TRANSFER_IN: "Transfer in to",
  TRANSFER_OUT: "Transfer out from",
  ADJUSTMENT: "Adjustment in",
};

export function movementNote(entry: StockHistoryEntry): string {
  return `${MOVEMENT_VERBS[entry.type]} ${entry.warehouse.name}`;
}

export function movementIsIncrease(entry: StockHistoryEntry): boolean {
  if (entry.type === "ADJUSTMENT") return entry.quantity > 0;
  return entry.type === "INCOMING" || entry.type === "TRANSFER_IN";
}
