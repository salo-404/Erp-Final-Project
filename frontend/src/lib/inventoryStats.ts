import type { StockMovement, WarehouseInventory } from "../types/domain";

export type InventoryStatusKey = "in-stock" | "low-stock" | "out-of-stock";

export interface InventoryStatusStyle {
  status: InventoryStatusKey;
  label: string;
  bg: string;
  color: string;
}

// Status is based on `available` (onHand - active reservations), not raw
// onHand, so it matches what a picker could actually fulfill right now.
export function inventoryStatus(available: number, reorderThreshold: number): InventoryStatusStyle {
  if (available <= 0) {
    return { status: "out-of-stock", label: "Out of Stock", bg: "rgba(239,68,68,0.14)", color: "var(--color-danger)" };
  }
  if (available <= reorderThreshold) {
    return { status: "low-stock", label: "Low Stock", bg: "rgba(244,196,48,0.16)", color: "var(--color-warning)" };
  }
  return { status: "in-stock", label: "In Stock", bg: "rgba(34,197,94,0.12)", color: "var(--color-success)" };
}

// Sum of INCOMING + TRANSFER_IN ledger quantity within whatever window the
// caller fetched the ledger for (the page uses a trailing-7-day fetch).
export function arrivedTotal(movements: StockMovement[]): number {
  return movements
    .filter((m) => m.type === "INCOMING" || m.type === "TRANSFER_IN")
    .reduce((sum, m) => sum + Math.abs(m.quantity), 0);
}

export interface TopProductEntry {
  productId: number;
  name: string;
  onHand: number;
  pct: number;
}

// Ranked by current on-hand stock, not recent movement — a warehouse with
// little recent ledger activity still has a meaningful "what's actually
// sitting here" answer, which a movement-based ranking wouldn't give.
export function topProductsByStock(inventories: WarehouseInventory[], topN = 6): TopProductEntry[] {
  const stocked = inventories.filter((i) => i.onHand > 0).sort((a, b) => b.onHand - a.onHand).slice(0, topN);
  const max = Math.max(1, ...stocked.map((i) => i.onHand));

  return stocked.map((i) => ({
    productId: i.productId,
    name: i.product?.name ?? `Product #${i.productId}`,
    onHand: i.onHand,
    pct: Math.round((i.onHand / max) * 100),
  }));
}
