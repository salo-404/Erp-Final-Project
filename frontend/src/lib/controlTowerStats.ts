import type {
  ControlTowerAlert,
  ControlTowerAlertCategory,
  ControlTowerAlertSeverity,
  OverdueTransactionAlertData,
  TransferRecommendationAlertData,
} from "../types/domain";

export interface SeverityBadge {
  label: string;
  bg: string;
  color: string;
}

export function severityBadge(severity: ControlTowerAlertSeverity): SeverityBadge {
  if (severity === "CRITICAL") return { label: "Critical", bg: "rgba(239,68,68,0.14)", color: "var(--color-danger)" };
  if (severity === "WARNING") return { label: "Warning", bg: "rgba(244,196,48,0.16)", color: "var(--color-warning)" };
  return { label: "Info", bg: "rgba(138,143,156,0.16)", color: "var(--color-text-muted)" };
}

export const CATEGORY_LABELS: Record<ControlTowerAlertCategory, string> = {
  STOCKOUT_RISK: "Stockout Risk",
  RESTOCK_RECOMMENDATION: "Restock Recommendation",
  TRANSFER_RECOMMENDATION: "Transfer Recommendation",
  OVERDUE_TRANSACTION: "Overdue Transaction",
  DEAD_STOCK: "Dead Stock",
  CONSUMPTION_ANOMALY: "Consumption Anomaly",
  PENDING_DOCUMENT_REVIEW: "Pending Document Review",
};

export const CATEGORY_FILTERS: { value: ControlTowerAlertCategory | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "STOCKOUT_RISK", label: "Stockout" },
  { value: "RESTOCK_RECOMMENDATION", label: "Restock" },
  { value: "TRANSFER_RECOMMENDATION", label: "Transfer" },
  { value: "DEAD_STOCK", label: "Dead Stock" },
  { value: "CONSUMPTION_ANOMALY", label: "Anomaly" },
  { value: "PENDING_DOCUMENT_REVIEW", label: "Document" },
  { value: "OVERDUE_TRANSACTION", label: "Overdue" },
];

/**
 * The relevant warehouse id(s) for one alert, by category — used for the
 * Warehouse filter. PENDING_DOCUMENT_REVIEW has no reliable warehouse id
 * before it's approved (only a raw extractedWarehouseName string), so it
 * always returns [] and is never excluded by the warehouse filter, rather
 * than guessing a match from unstructured text.
 */
export function alertWarehouseIds(alert: ControlTowerAlert): number[] {
  switch (alert.category) {
    case "DEAD_STOCK":
    case "CONSUMPTION_ANOMALY":
    case "STOCKOUT_RISK":
    case "RESTOCK_RECOMMENDATION": {
      const d = alert.data as { warehouseId: number };
      return [d.warehouseId];
    }
    case "TRANSFER_RECOMMENDATION": {
      const d = alert.data as unknown as TransferRecommendationAlertData;
      return [d.fromWarehouseId, d.toWarehouseId];
    }
    case "OVERDUE_TRANSACTION": {
      const d = alert.data as unknown as OverdueTransactionAlertData;
      return [d.sourceWarehouseId, d.destinationWarehouseId].filter((id): id is number => id !== null);
    }
    case "PENDING_DOCUMENT_REVIEW":
      return [];
  }
}

export interface AlertFilters {
  category: ControlTowerAlertCategory | "all";
  severity: ControlTowerAlertSeverity | "all";
  warehouseId: number | "all";
}

export function filterAlerts(alerts: ControlTowerAlert[], filters: AlertFilters): ControlTowerAlert[] {
  return alerts.filter((a) => {
    if (filters.category !== "all" && a.category !== filters.category) return false;
    if (filters.severity !== "all" && a.severity !== filters.severity) return false;
    if (filters.warehouseId !== "all") {
      const ids = alertWarehouseIds(a);
      if (ids.length > 0 && !ids.includes(filters.warehouseId)) return false;
    }
    return true;
  });
}

const ATTENTION_CATEGORIES: ReadonlySet<ControlTowerAlertCategory> = new Set([
  "STOCKOUT_RISK",
  "RESTOCK_RECOMMENDATION",
  "TRANSFER_RECOMMENDATION",
  "OVERDUE_TRANSACTION",
]);
const INSIGHT_CATEGORIES: ReadonlySet<ControlTowerAlertCategory> = new Set([
  "DEAD_STOCK",
  "CONSUMPTION_ANOMALY",
]);

export interface GroupedAlerts {
  attention: ControlTowerAlert[];
  insights: ControlTowerAlert[];
  documents: ControlTowerAlert[];
}

export function groupAlerts(alerts: ControlTowerAlert[]): GroupedAlerts {
  return {
    attention: alerts.filter((a) => ATTENTION_CATEGORIES.has(a.category)),
    insights: alerts.filter((a) => INSIGHT_CATEGORIES.has(a.category)),
    documents: alerts.filter((a) => a.category === "PENDING_DOCUMENT_REVIEW"),
  };
}

export interface SeverityCounts {
  critical: number;
  warning: number;
  info: number;
  total: number;
}

export function severityCounts(alerts: ControlTowerAlert[]): SeverityCounts {
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const a of alerts) {
    if (a.severity === "CRITICAL") critical++;
    else if (a.severity === "WARNING") warning++;
    else info++;
  }
  return { critical, warning, info, total: alerts.length };
}
