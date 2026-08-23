import type { Product, ProductMovementStat, PurchaseTrendPoint, SalesTrendPoint } from "../types/domain";
import type { TopSellingProduct } from "./analytics.api";

export type DateRange = "7d" | "30d" | "90d" | "all";

export const RANGE_OPTIONS: { value: DateRange; label: string; days: number | null }[] = [
  { value: "7d", label: "7D", days: 7 },
  { value: "30d", label: "30D", days: 30 },
  { value: "90d", label: "90D", days: 90 },
  { value: "all", label: "All", days: null },
];

function cutoffDate(range: DateRange): string | null {
  const opt = RANGE_OPTIONS.find((r) => r.value === range);
  if (!opt || opt.days === null) return null;
  const d = new Date();
  d.setDate(d.getDate() - opt.days);
  return d.toISOString().split("T")[0];
}

export function filterSalesByRange(points: SalesTrendPoint[], range: DateRange): SalesTrendPoint[] {
  const cutoff = cutoffDate(range);
  return cutoff ? points.filter((p) => p.date >= cutoff) : points;
}

export function filterPurchasesByRange(points: PurchaseTrendPoint[], range: DateRange): PurchaseTrendPoint[] {
  const cutoff = cutoffDate(range);
  return cutoff ? points.filter((p) => p.date >= cutoff) : points;
}

export interface MergedTrendPoint {
  date: string;
  revenue: number;
  purchaseCost: number;
}

/** Union of every date present in either series, each real value kept, missing days filled with 0 (never interpolated/guessed). */
export function mergeTrends(sales: SalesTrendPoint[], purchases: PurchaseTrendPoint[]): MergedTrendPoint[] {
  const byDate = new Map<string, MergedTrendPoint>();
  for (const s of sales) {
    byDate.set(s.date, { date: s.date, revenue: s.revenue, purchaseCost: byDate.get(s.date)?.purchaseCost ?? 0 });
  }
  for (const p of purchases) {
    const existing = byDate.get(p.date);
    byDate.set(p.date, { date: p.date, revenue: existing?.revenue ?? 0, purchaseCost: p.purchaseCost });
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export interface AnalyticsKpis {
  totalRevenue: number;
  totalPurchaseCost: number;
  netMargin: number;
  totalOrders: number;
}

export function computeKpis(sales: SalesTrendPoint[], purchases: PurchaseTrendPoint[]): AnalyticsKpis {
  const totalRevenue = sales.reduce((sum, s) => sum + s.revenue, 0);
  const totalPurchaseCost = purchases.reduce((sum, p) => sum + p.purchaseCost, 0);
  const totalOrders = sales.reduce((sum, s) => sum + s.transactionCount, 0);
  return { totalRevenue, totalPurchaseCost, netMargin: totalRevenue - totalPurchaseCost, totalOrders };
}

/** Client-side category filter — none of the product-performance endpoints take a category param, so this joins against the real Product.category already fetched via listProducts(). */
export function filterByCategory<T extends { productId: number }>(
  rows: T[],
  productsById: Map<number, Product>,
  category: string | "all",
): T[] {
  if (category === "all") return rows;
  return rows.filter((r) => (productsById.get(r.productId)?.category ?? "Uncategorized") === category);
}

export type ProductPerformanceView = "best" | "lowest" | "fast" | "slow";

export const PRODUCT_PERFORMANCE_VIEWS: { value: ProductPerformanceView; label: string }[] = [
  { value: "best", label: "Best Selling" },
  { value: "lowest", label: "Lowest Selling" },
  { value: "fast", label: "Fast-Moving" },
  { value: "slow", label: "Slow-Moving" },
];

export function isTopSellingRow(row: TopSellingProduct | ProductMovementStat): row is TopSellingProduct {
  return "totalQuantitySold" in row;
}
