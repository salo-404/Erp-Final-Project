import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFetch } from "../lib/useFetch";
import { getControlTowerAlerts } from "../lib/controlTower.api";
import { listWarehouses } from "../lib/warehouses.api";
import { listProducts } from "../lib/products.api";
import { listSuppliers } from "../lib/suppliers.api";
import { createTransfer, createIncoming } from "../lib/inventoryTransactions.api";
import {
  CATEGORY_FILTERS,
  CATEGORY_LABELS,
  filterAlerts,
  findMatchingTransferRecommendation,
  groupAlerts,
  severityBadge,
  severityCounts,
  type AlertFilters,
} from "../lib/controlTowerStats";
import { TransferStockModal } from "../components/inventory/TransferStockModal";
import { CreatePurchaseOrderModal } from "../components/suppliers/CreatePurchaseOrderModal";
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
  StockoutRiskAlertData,
  TransferRecommendationAlertData,
  Warehouse,
} from "../types/domain";

const cardStyle: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 22 };
const kpiCardStyle: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "14px 16px" };
const sectionLabelStyle: React.CSSProperties = { fontFamily: "var(--font-heading)", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--color-text-muted)", marginBottom: 12 };
const inputStyle: React.CSSProperties = { background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, color: "var(--color-text)" };

interface TransferModalState {
  productId: number;
  productName: string;
  sourceWarehouseId: number;
  destinationWarehouseId: number;
  quantity: number;
  available: number;
}

interface PoModalState {
  warehouseId: number;
  productId: number;
  quantity: number;
}

export function ControlTowerPage() {
  const navigate = useNavigate();

  const alertsFetch = useFetch(() => getControlTowerAlerts(), []);
  const warehousesFetch = useFetch<Warehouse[]>(() => listWarehouses(), []);
  const productsFetch = useFetch<Product[]>(() => listProducts(), []);
  const suppliersFetch = useFetch(() => listSuppliers(), []);

  const alerts = useMemo(() => alertsFetch.data ?? [], [alertsFetch.data]);
  const warehouses = useMemo(() => warehousesFetch.data ?? [], [warehousesFetch.data]);
  const products = useMemo(() => productsFetch.data ?? [], [productsFetch.data]);
  const suppliers = useMemo(() => suppliersFetch.data ?? [], [suppliersFetch.data]);
  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const warehousesById = useMemo(() => new Map(warehouses.map((w) => [w.id, w])), [warehouses]);

  const [categoryFilter, setCategoryFilter] = useState<AlertFilters["category"]>("all");
  const [severityFilter, setSeverityFilter] = useState<AlertFilters["severity"]>("all");
  const [warehouseFilter, setWarehouseFilter] = useState<AlertFilters["warehouseId"]>("all");

  const [transferModal, setTransferModal] = useState<TransferModalState | null>(null);
  const [poModal, setPoModal] = useState<PoModalState | null>(null);

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

  async function handleTransferSubmit(input: { sourceWarehouseId: number; destinationWarehouseId: number; expectedDate?: string; items: { productId: number; quantity: number }[] }) {
    await createTransfer(input);
    alertsFetch.refetch();
  }
  async function handlePoSubmit(input: Parameters<typeof createIncoming>[0]) {
    await createIncoming(input);
    alertsFetch.refetch();
  }

  function openTransferForRecommendation(d: TransferRecommendationAlertData) {
    setTransferModal({
      productId: d.productId,
      productName: productName(d.productId),
      sourceWarehouseId: d.fromWarehouseId,
      destinationWarehouseId: d.toWarehouseId,
      quantity: d.transferQuantity,
      available: d.fromWarehouseAvailableAfterTransfer + d.transferQuantity,
    });
  }

  function renderAttentionAction(alert: ControlTowerAlert) {
    if (alert.category === "STOCKOUT_RISK") {
      const d = alert.data as unknown as StockoutRiskAlertData;
      return { label: "View Product", onClick: () => navigate(`/products/${d.productId}`) };
    }
    if (alert.category === "RESTOCK_RECOMMENDATION") {
      const d = alert.data as unknown as RestockRecommendation;
      if (d.reason === "transfer_available") {
        const match = findMatchingTransferRecommendation(d, alerts);
        if (!match) return { label: "View Product", onClick: () => navigate(`/products/${d.productId}`) };
        return { label: "Suggest Transfer", onClick: () => openTransferForRecommendation(match) };
      }
      return {
        label: "Create Purchase Order",
        onClick: () => setPoModal({ warehouseId: d.warehouseId, productId: d.productId, quantity: d.recommendedQuantity }),
      };
    }
    if (alert.category === "TRANSFER_RECOMMENDATION") {
      const d = alert.data as unknown as TransferRecommendationAlertData;
      return { label: "Create Transfer", onClick: () => openTransferForRecommendation(d) };
    }
    if (alert.category === "OVERDUE_TRANSACTION") {
      const d = alert.data as unknown as OverdueTransactionAlertData;
      if (d.type === "INCOMING") return { label: "View in Suppliers", onClick: () => navigate("/suppliers") };
      if (d.type === "OUTGOING") return { label: "View in Orders", onClick: () => navigate("/orders") };
      return { label: "View in Warehouses", onClick: () => navigate("/warehouses") };
    }
    return null;
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

  const isLoading = alertsFetch.loading || warehousesFetch.loading || productsFetch.loading || suppliersFetch.loading;
  const loadError = alertsFetch.error || warehousesFetch.error || productsFetch.error || suppliersFetch.error;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner label="Loading Control Tower..." />
      </div>
    );
  }
  if (loadError) {
    return <ErrorMessage message={loadError} onRetry={() => { alertsFetch.refetch(); warehousesFetch.refetch(); productsFetch.refetch(); suppliersFetch.refetch(); }} />;
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
                color: categoryFilter === f.value ? "#FFFFFF" : "var(--color-text-secondary)",
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
                {grouped.attention.map((alert, i) => {
                  const badge = severityBadge(alert.severity);
                  const action = renderAttentionAction(alert);
                  return (
                    <div key={i} style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderLeft: `3px solid ${badge.color}`, borderRadius: 8, padding: "18px 20px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 14, marginBottom: 10 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                          <span style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", padding: "3px 8px", borderRadius: 4, background: badge.bg, color: badge.color }}>{badge.label}</span>
                          <span style={{ fontSize: 10, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{CATEGORY_LABELS[alert.category]}</span>
                        </div>
                      </div>
                      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{attentionTitle(alert)}</div>
                      <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginBottom: 14, lineHeight: 1.5, maxWidth: 640 }}>{alert.message}</div>
                      {action && (
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <div onClick={action.onClick} style={{ fontSize: 12.5, fontWeight: 600, padding: "8px 14px", borderRadius: 6, background: "var(--color-accent)", color: "#FFFFFF", cursor: "pointer" }}>
                            {action.label}
                          </div>
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
                {grouped.insights.map((alert, i) => {
                  const badge = severityBadge(alert.severity);
                  const productId =
                    alert.category === "DEAD_STOCK"
                      ? (alert.data as unknown as DeadStockAlertData).productId
                      : (alert.data as unknown as ConsumptionAnomalyAlertData).productId;
                  return (
                    <div key={i} style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderLeft: `3px solid ${badge.color}`, borderRadius: 8, padding: "16px 18px" }}>
                      <div style={{ fontSize: 10, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>{CATEGORY_LABELS[alert.category]}</div>
                      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{productName(productId)}</div>
                      <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", marginBottom: 12, lineHeight: 1.5 }}>{alert.message}</div>
                      <div onClick={() => navigate(`/products/${productId}`)} style={{ fontSize: 12, color: "var(--color-accent)", fontWeight: 600, cursor: "pointer" }}>
                        View Product
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
                    <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: i < grouped.documents.length - 1 ? "1px solid var(--color-border)" : "none", gap: 12, flexWrap: "wrap" }}>
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

      {transferModal && warehousesById.get(transferModal.sourceWarehouseId) && (
        <TransferStockModal
          productId={transferModal.productId}
          productName={transferModal.productName}
          available={transferModal.available}
          initialQuantity={transferModal.quantity}
          sourceWarehouse={warehousesById.get(transferModal.sourceWarehouseId)!}
          destinationWarehouses={warehousesById.get(transferModal.destinationWarehouseId) ? [warehousesById.get(transferModal.destinationWarehouseId)!] : []}
          onClose={() => setTransferModal(null)}
          onSubmit={handleTransferSubmit}
        />
      )}

      {poModal && (
        <CreatePurchaseOrderModal
          suppliers={suppliers}
          warehouses={warehouses}
          products={products}
          initialWarehouseId={poModal.warehouseId}
          initialItem={{ productId: poModal.productId, quantity: poModal.quantity }}
          onClose={() => setPoModal(null)}
          onSubmit={handlePoSubmit}
        />
      )}
    </div>
  );
}
