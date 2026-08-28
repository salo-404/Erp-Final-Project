import type { InventoryTransactionStatus } from "../types/domain";

export interface StatusBadge {
  label: string;
  bg: string;
  color: string;
}

function utcDateKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

// Real 3-state model only (PENDING/COMPLETED/CANCELLED) — "Overdue" is a
// computed flag on top of PENDING (expectedDate in the past), not a 4th
// stored status. No fictional in-transit/picking/shipped states.
export function transactionStatusBadge(
  status: InventoryTransactionStatus,
  expectedDate: string | null,
  referenceDate: Date = new Date(),
): StatusBadge {
  if (status === "COMPLETED") {
    return { label: "Completed", bg: "rgba(34,197,94,0.14)", color: "var(--color-success)" };
  }
  if (status === "CANCELLED") {
    return { label: "Cancelled", bg: "rgba(138,143,156,0.16)", color: "var(--color-text-muted)" };
  }
  if (expectedDate && utcDateKey(new Date(expectedDate)) < utcDateKey(referenceDate)) {
    return { label: "Overdue", bg: "rgba(239,68,68,0.14)", color: "var(--color-danger)" };
  }
  return { label: "Pending", bg: "rgba(244,196,48,0.16)", color: "var(--color-warning)" };
}
