import type { AlertSeverity, NarratedAlert } from "../types";

interface AlertCardProps {
  alert: NarratedAlert;
  onProposeAction?: (alert: NarratedAlert) => void;
}

const SEVERITY_STYLES: Record<AlertSeverity, { badge: string; ring: string }> = {
  low: {
    badge: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    ring: "border-slate-200 dark:border-slate-700",
  },
  medium: {
    badge: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
    ring: "border-amber-300 dark:border-amber-700",
  },
  high: {
    badge: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
    ring: "border-orange-300 dark:border-orange-700",
  },
  critical: {
    badge: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    ring: "border-red-400 dark:border-red-700",
  },
};

const CATEGORY_LABELS: Record<NarratedAlert["category"], string> = {
  low_stock: "Low stock",
  stockout_risk: "Stockout risk",
  overdue_transaction: "Overdue transaction",
  consumption_anomaly: "Consumption anomaly",
  expiring_inventory: "Expiring inventory",
  invoice_discrepancy: "Invoice discrepancy",
  order_discrepancy: "Order discrepancy",
};

/**
 * Renders one NarratedAlert exactly as returned by
 * ai-agent/narration/control_tower.py's narrate_alert() - see
 * ai-agent/tools/schemas/control_tower_schema.py for the field contract
 * (category, severity, narrative, proposed_action, etc.).
 */
export function AlertCard({ alert, onProposeAction }: AlertCardProps) {
  const styles = SEVERITY_STYLES[alert.severity];

  return (
    <div
      className={`flex flex-col gap-3 rounded-xl border bg-white p-4 shadow-sm dark:bg-slate-900 ${styles.ring}`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
          {CATEGORY_LABELS[alert.category]}
        </span>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${styles.badge}`}
        >
          {alert.severity}
        </span>
      </div>

      <p className="text-sm leading-relaxed text-slate-700 dark:text-slate-200">
        {alert.narrative}
      </p>

      <div className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        <span className="font-medium text-slate-500 dark:text-slate-400">
          Proposed:{" "}
        </span>
        {alert.proposed_action}
      </div>

      <button
        type="button"
        onClick={() => onProposeAction?.(alert)}
        className="self-start rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-300 dark:hover:bg-indigo-900"
      >
        Propose Action
      </button>
    </div>
  );
}
