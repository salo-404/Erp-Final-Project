import type { OrderStatus } from "../types";

const STATUS_STYLES: Record<OrderStatus, string> = {
  Pending: "bg-zinc-800 text-zinc-300",
  "Sent to Supplier": "bg-blue-950 text-blue-300",
  "Invoice Received": "bg-indigo-950 text-indigo-300",
  "Discrepancy Flagged": "bg-red-950 text-red-300",
  Fulfilled: "bg-emerald-950 text-emerald-300",
};

/** Color-coded pill for an Order's status column. */
export function StatusBadge({ status }: { status: OrderStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}
