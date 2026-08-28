import type { InventoryTransactionWithItems, Product } from "../types/domain";

export interface CategorySales {
  name: string;
  units: number;
  pct: number;
  color: string;
}

const PALETTE = ["#6D3FD9", "#22C55E", "#F4C430", "#3B82F6", "#EC4899", "#14B8A6", "#F97316", "#8A8F9C"];

// Design's "Top Customer Categories" assumed customer segments, which don't
// exist in the schema — replaced with product-category breakdown of what
// was actually ordered, a real, derivable substitute.
export function categorySalesBreakdown(
  orders: InventoryTransactionWithItems[],
  productsById: Map<number, Product>,
): CategorySales[] {
  const totals = new Map<string, number>();
  for (const order of orders) {
    for (const item of order.items) {
      const category = productsById.get(item.productId)?.category?.trim() || "Uncategorized";
      totals.set(category, (totals.get(category) ?? 0) + item.quantity);
    }
  }

  const total = [...totals.values()].reduce((sum, v) => sum + v, 0);
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, units], i) => ({
      name,
      units,
      pct: total === 0 ? 0 : Math.round((units / total) * 100),
      color: PALETTE[i % PALETTE.length],
    }));
}
