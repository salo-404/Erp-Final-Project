import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFetch } from "../lib/useFetch";
import { getControlTowerAlerts } from "../lib/controlTower.api";
import { listWarehouses } from "../lib/warehouses.api";
import { listProducts } from "../lib/products.api";
import {
  alertKey,
  CATEGORY_FILTERS,
  CATEGORY_LABELS,
  filterAlerts,
  groupAlerts,
  isRecommendableAlert,
  severityBadge,
  severityCounts,
  type AlertFilters,
} from "../lib/controlTowerStats";
import { RecommendSolutionAction } from "../components/control-tower/RecommendSolutionAction";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import { ErrorMessage } from "../components/ui/ErrorMessage";
import { ControlTowerIcon } from "../components/ui/icons";
import type {
  ControlTowerAlert,
  ConsumptionAnomalyAlertData,
  DeadStockAlertData,
  OverdueTransactionAlertData,
  PendingDocumentReviewAlertData,
  Product,
  RestockRecommendation,
  TransferRecommendationAlertData,
  Warehouse,
} from "../types/domain";

const cardStyle: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 22 };
const kpiCardStyle: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "14px 16px" };
const sectionLabelStyle: React.CSSProperties = { fontFamily: "var(--font-heading)", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 12 };
const inputStyle: React.CSSProperties = { background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, color: "var(--color-text)" };

export function ControlTowerPage() {
  const navigate = useNavigate();

  const alertsFetch = useFetch(() => getControlTowerAlerts(), []);
  const warehousesFetch = useFetch<Warehouse[]>(() => listWarehouses(), []);
  const productsFetch = useFetch<Product[]>(() => listProducts(), []);

  const alerts = useMemo(() => alertsFetch.data ?? [], [alertsFetch.data]);
  const warehouses = useMemo(() => warehousesFetch.data ?? [], [warehousesFetch.data]);
  const products = useMemo(() => productsFetch.data ?? [], [productsFetch.data]);
  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const warehousesById = useMemo(() => new Map(warehouses.map((w) => [w.id, w])), [warehouses]);

  const [categoryFilter, setCategoryFilter] = useState<AlertFilters["category"]>("all");
  const [severityFilter, setSeverityFilter] = useState<AlertFilters["severity"]>("all");
  const [warehouseFilter, setWarehouseFilter] = useState<AlertFilters["warehouseId"]>("all");

  const counts = useMemo(() => severityCounts(alerts), [alerts]);
  const filtered = useMemo(
    () => filterAlerts(alerts, { category: categoryFilter, severity: severityFilter, warehouseId: warehouseFilter }),
    [alerts, categoryFilter, severityFilter, warehouseFilter],
  );
  const grouped = useMemo(() => groupAlerts(filtered), [filtered]);

  function productName(productId: number): string {
    return productsById.get(productId)?.name ?? `Product #${productId}`;
  }
  function warehouseName(warehouseId: number): string {
    return warehousesById.get(warehouseId)?.name ?? `Warehouse #${warehouseId}`;
  }

  function attentionTitle(alert: ControlTowerAlert): string {
    switch (alert.category) {
      case "STOCKOUT_RISK":
      case "RESTOCK_RECOMMENDATION": {
        const d = alert.data as unknown as { productId: number; warehouseId: number };
        return `${productName(d.productId)} — ${warehouseName(d.warehouseId)}`;
      }
      case "TRANSFER_RECOMMENDATION": {
        const d = alert.data as unknown as TransferRecommendationAlertData;
        return `${productName(d.productId)} — ${warehouseName(d.fromWarehouseId)} → ${warehouseName(d.toWarehouseId)}`;
      }
      case "OVERDUE_TRANSACTION": {
        const d = alert.data as unknown as OverdueTransactionAlertData;
        return `${d.type} Transaction TXN-${d.id}`;
      }
      default:
        return CATEGORY_LABELS[alert.category];
    }
  }

  function niceDate(iso: string | null): string {
    if (!iso) return "an unknown date";
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  // The backend's own alert.message is deliberately id-only, plain text
  // (see getControlTowerAlerts()'s docstring in stock-insights.service.ts —
  // `data` is kept verbatim there for a future NotificationService/dashboard
  // that has no product/warehouse names of its own to resolve against).
  // This page already has both loaded, so it re-renders each alert's body
  // from `data` with real names and a readable date instead of showing
  // alert.message directly — never a bare id, never a raw ISO timestamp,
  // and never an internal enum literal like "transfer_available" leaking
  // into what a reviewer reads. Titles (attentionTitle() above, or the
  // product name alone for insight cards) already name the product/
  // warehouse, so this never repeats them — only the extra detail the
  // title doesn't already carry.
  function alertDescription(alert: ControlTowerAlert): string {
    switch (alert.category) {
      case "DEAD_STOCK": {
        const d = alert.data as unknown as DeadStockAlertData;
        const staleness =
          d.daysSinceLastOutgoingMovement === null
            ? "has never had a customer sale"
            : `has had no customer sale in ${d.daysSinceLastOutgoingMovement} days`;
        return `${d.onHand} units on hand at ${warehouseName(d.warehouseId)}, and ${staleness}.`;
      }
      case "CONSUMPTION_ANOMALY": {
        const d = alert.data as unknown as ConsumptionAnomalyAlertData;
        const where = `at ${warehouseName(d.warehouseId)}`;
        if (d.percentChange === null) {
          return `Consumption increased from ${d.baselineQuantity} to ${d.recentQuantity} units ${where} in the recent window.`;
        }
        const direction = d.direction === "INCREASE" ? "increased" : "decreased";
        return `Consumption ${direction} ${Math.abs(d.percentChange).toFixed(1)}% ${where} (baseline ${d.baselineQuantity} → recent ${d.recentQuantity}).`;
      }
      case "STOCKOUT_RISK":
        // Only ever OUT_OF_STOCK now (available <= 0) — AT_RISK is
        // RESTOCK_RECOMMENDATION's alert instead, so the two categories
        // never overlap for the same product/warehouse (see
        // getControlTowerAlerts() in stock-insights.service.ts). Available
        // is always 0 here, so it's not worth repeating, and a "predicted
        // stockout" date makes no sense for something already at zero —
        // that's only meaningful for RESTOCK_RECOMMENDATION, where stock
        // remains but is trending toward running out.
        return "Out of stock.";
      case "RESTOCK_RECOMMENDATION": {
        // Operational facts only — deliberately never the backend's
        // `reason` ('transfer_available'/'purchase_required'), `explanation`
        // text, or `transferSourceWarehouseIds` here, all of which reveal
        // the final decision. That decision is only ever surfaced through
        // the Recommend Solution action below, on demand.
        const d = alert.data as unknown as RestockRecommendation;
        const stockoutSuffix = d.predictedStockoutDate ? ` Predicted stockout: ${niceDate(d.predictedStockoutDate)}.` : "";
        const pendingSuffix = d.pendingIncomingQuantity > 0 ? ` ${d.pendingIncomingQuantity} units pending incoming.` : "";
        return `${d.available} available — needs ${d.recommendedQuantity} more units.${pendingSuffix}${stockoutSuffix}`;
      }
      case "TRANSFER_RECOMMENDATION": {
        const d = alert.data as unknown as TransferRecommendationAlertData;
        return `Transfer ${d.transferQuantity} units to cover the shortfall.`;
      }
      case "OVERDUE_TRANSACTION": {
        const d = alert.data as unknown as OverdueTransactionAlertData;
        return `Overdue — expected ${niceDate(d.expectedDate)}.`;
      }
      default:
        return alert.message;
    }
  }

  const isLoading = alertsFetch.loading || warehousesFetch.loading || productsFetch.loading;
  const loadError = alertsFetch.error || warehousesFetch.error || productsFetch.error;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner label="Loading Control Tower..." />
      </div>
    );
  }
  if (loadError) {
    return <ErrorMessage message={loadError} onRetry={() => { alertsFetch.refetch(); warehousesFetch.refetch(); productsFetch.refetch(); }} />;
  }

  const noAlertsAtAll = alerts.length === 0;
  const noFilteredResults = !noAlertsAtAll && filtered.length === 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* KPI strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14 }}>
        {[
          { label: "Critical", value: counts.critical, color: "var(--color-danger)" },
          { label: "Warning", value: counts.warning, color: "var(--color-warning)" },
          { label: "Info", value: counts.info, color: "var(--color-text-muted)" },
          { label: "Total", value: counts.total, color: "var(--color-accent)" },
        ].map((k) => (
          <div key={k.label} style={{ ...kpiCardStyle, borderLeft: `3px solid ${k.color}` }}>
            <div style={{ fontSize: 11.5, color: "var(--color-text-secondary)", marginBottom: 6 }}>{k.label}</div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 22, color: k.color }}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {CATEGORY_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setCategoryFilter(f.value)}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: "7px 13px",
                borderRadius: 7,
                border: "1px solid var(--color-border)",
                background: categoryFilter === f.value ? "var(--color-accent)" : "var(--color-surface)",
                color: categoryFilter === f.value ? "var(--color-on-accent)" : "var(--color-text-secondary)",
                cursor: "pointer",
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <select value={warehouseFilter === "all" ? "all" : String(warehouseFilter)} onChange={(e) => setWarehouseFilter(e.target.value === "all" ? "all" : Number(e.target.value))} style={inputStyle}>
            <option value="all">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
          <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value as AlertFilters["severity"])} style={inputStyle}>
            <option value="all">All severities</option>
            <option value="CRITICAL">Critical</option>
            <option value="WARNING">Warning</option>
            <option value="INFO">Info</option>
          </select>
        </div>
      </div>

      {noAlertsAtAll ? (
        <div style={{ ...cardStyle, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 20px", textAlign: "center" }}>
          <ControlTowerIcon className="h-8 w-8" style={{ color: "var(--color-text-muted)", marginBottom: 12 }} />
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 16, marginBottom: 6 }}>Operations are clear</div>
          <div style={{ fontSize: 12.5, color: "var(--color-text-muted)", maxWidth: 320 }}>No operational issues require attention.</div>
        </div>
      ) : noFilteredResults ? (
        <div style={{ ...cardStyle, padding: "40px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>No alerts match these filters</div>
          <div style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>Try a different category, severity, or warehouse.</div>
        </div>
      ) : (
        <>
          {grouped.attention.length > 0 && (
            <div>
              <div style={sectionLabelStyle}>Needs Attention</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 900 }}>
                {grouped.attention.map((alert) => {
                  const badge = severityBadge(alert.severity);
                  return (
                    <div key={alertKey(alert)} style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderLeft: `3px solid ${badge.color}`, borderRadius: 8, padding: "18px 20px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, marginBottom: 10 }}>
                        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>{attentionTitle(alert)}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 9, flexShrink: 0 }}>
                          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 4, background: badge.bg, color: badge.color }}>{badge.label}</span>
                          <span style={{ fontSize: 10, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{CATEGORY_LABELS[alert.category]}</span>
                        </div>
                      </div>
                      <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5, maxWidth: 640 }}>{alertDescription(alert)}</div>
                      {(alert.severity === "CRITICAL" || alert.severity === "WARNING") && isRecommendableAlert(alert) && (
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <RecommendSolutionAction alert={alert} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {grouped.insights.length > 0 && (
            <div>
              <div style={sectionLabelStyle}>Operational Insights</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, maxWidth: 900 }}>
                {grouped.insights.map((alert) => {
                  const badge = severityBadge(alert.severity);
                  const productId =
                    alert.category === "DEAD_STOCK"
                      ? (alert.data as unknown as DeadStockAlertData).productId
                      : (alert.data as unknown as ConsumptionAnomalyAlertData).productId;
                  return (
                    <div key={alertKey(alert)} style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderLeft: `3px solid ${badge.color}`, borderRadius: 8, padding: "16px 18px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
                        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 14 }}>{productName(productId)}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
                          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", padding: "3px 7px", borderRadius: 4, background: badge.bg, color: badge.color }}>{badge.label}</span>
                          <span style={{ fontSize: 10, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{CATEGORY_LABELS[alert.category]}</span>
                        </div>
                      </div>
                      <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>{alertDescription(alert)}</div>
                      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
                        {(alert.severity === "CRITICAL" || alert.severity === "WARNING") && isRecommendableAlert(alert) ? (
                          <RecommendSolutionAction alert={alert} />
                        ) : (
                          <div onClick={() => navigate(`/products/${productId}`)} style={{ fontSize: 12, color: "var(--color-accent)", fontWeight: 600, cursor: "pointer" }}>
                            View Product
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {grouped.documents.length > 0 && (
            <div>
              <div style={sectionLabelStyle}>Documents Requiring Review</div>
              <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, overflow: "hidden", maxWidth: 900 }}>
                {grouped.documents.map((alert, i) => {
                  const d = alert.data as unknown as PendingDocumentReviewAlertData;
                  const badge = severityBadge(alert.severity);
                  return (
                    <div key={alertKey(alert)} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: i < grouped.documents.length - 1 ? "1px solid var(--color-border)" : "none", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>DOC-{d.id}</div>
                        <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)" }}>
                          {d.transactionType === "INCOMING" ? d.extractedSupplierName ?? "Unknown supplier" : d.extractedPartyName ?? "Unknown customer"}
                        </div>
                        <span style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 9px", borderRadius: 4, background: badge.bg, color: badge.color }}>{d.transactionType}</span>
                      </div>
                      <div onClick={() => navigate(`/document-review/${d.id}`)} style={{ fontSize: 12, color: "var(--color-accent)", fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>
                        Review
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
