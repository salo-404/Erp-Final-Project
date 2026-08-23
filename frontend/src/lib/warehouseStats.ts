import type { StockMovement, WarehouseCapacity, WarehouseInventory } from "../types/domain";

export type WarehouseStatus = "healthy" | "warning" | "critical" | "unmetered";

export interface StatusStyle {
  status: WarehouseStatus;
  label: string;
  color: string;
  bg: string;
}

// Thresholds are a judgment call — no backend field defines these tiers.
export function capacityStatus(capacity: WarehouseCapacity): StatusStyle {
  if (capacity.maxCapacity === null) {
    return { status: "unmetered", label: "No limit set", color: "var(--color-text-muted)", bg: "var(--color-surface-2)" };
  }
  const pct = capacityPercent(capacity);
  if (pct >= 92) {
    return { status: "critical", label: "Critical", color: "var(--color-danger)", bg: "rgba(239,68,68,0.12)" };
  }
  if (pct >= 75) {
    return { status: "warning", label: "Warning", color: "var(--color-warning)", bg: "rgba(244,196,48,0.14)" };
  }
  return { status: "healthy", label: "Healthy", color: "var(--color-success)", bg: "rgba(34,197,94,0.12)" };
}

export function capacityPercent(capacity: WarehouseCapacity): number {
  if (capacity.maxCapacity === null || capacity.maxCapacity === 0) return 0;
  return Math.min(100, Math.round((capacity.currentStock / capacity.maxCapacity) * 100));
}

const CATEGORY_PALETTE = ["#6D3FD9", "#22C55E", "#F4C430", "#3B82F6", "#EC4899", "#14B8A6", "#F97316", "#8A8F9C"];

export interface CategoryBreakdownEntry {
  name: string;
  units: number;
  pct: number;
  color: string;
}

export function categoryBreakdown(inventories: WarehouseInventory[]): CategoryBreakdownEntry[] {
  const totals = new Map<string, number>();
  for (const row of inventories) {
    const name = row.product?.category?.trim() || "Uncategorized";
    totals.set(name, (totals.get(name) ?? 0) + row.onHand);
  }

  const totalUnits = [...totals.values()].reduce((sum, v) => sum + v, 0);
  const entries = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, units], i) => ({
      name,
      units,
      pct: totalUnits === 0 ? 0 : Math.round((units / totalUnits) * 100),
      color: CATEGORY_PALETTE[i % CATEGORY_PALETTE.length],
    }));

  return entries;
}

export function totalUnits(inventories: WarehouseInventory[]): number {
  return inventories.reduce((sum, row) => sum + row.onHand, 0);
}

export function activeSkuCount(inventories: WarehouseInventory[]): number {
  return inventories.filter((row) => row.onHand > 0).length;
}

export interface MonthBucket {
  label: string;
  total: number;
}

// Buckets |quantity| across the trailing 12 calendar months (oldest first).
// "Throughput" here means total units moved (in or out), not a net delta.
export function monthlyThroughput(movements: StockMovement[], referenceDate = new Date()): MonthBucket[] {
  const months: MonthBucket[] = [];
  const cursor = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 1);

  const keys: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(cursor.getFullYear(), cursor.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${d.getMonth()}`);
    months.push({ label: d.toLocaleDateString(undefined, { month: "short" }), total: 0 });
  }

  const indexByKey = new Map(keys.map((k, i) => [k, i]));
  for (const m of movements) {
    const d = new Date(m.createdAt);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const idx = indexByKey.get(key);
    if (idx !== undefined) {
      months[idx].total += Math.abs(m.quantity);
    }
  }

  return months;
}

export function currentMonthThroughput(movements: StockMovement[], referenceDate = new Date()): number {
  return movements
    .filter((m) => {
      const d = new Date(m.createdAt);
      return d.getFullYear() === referenceDate.getFullYear() && d.getMonth() === referenceDate.getMonth();
    })
    .reduce((sum, m) => sum + Math.abs(m.quantity), 0);
}
