import { useMemo, useState } from "react";
import { useFetch } from "../lib/useFetch";
import { listWarehouses } from "../lib/warehouses.api";
import { listProducts } from "../lib/products.api";
import {
  getFastMovingProducts,
  getLowestSellingProducts,
  getPurchaseTrends,
  getSalesTrends,
  getSlowMovingProducts,
  getSupplierComparison,
  getTopSellingProducts,
  getWarehouseDemand,
  type TopSellingProduct,
} from "../lib/analytics.api";
import {
  PRODUCT_PERFORMANCE_VIEWS,
  RANGE_OPTIONS,
  computeKpis,
  filterByCategory,
  filterPurchasesByRange,
  filterSalesByRange,
  isTopSellingRow,
  mergeTrends,
  type DateRange,
  type ProductPerformanceView,
} from "../lib/analyticsStats";
import { RevenueTrendChart } from "../components/analytics/RevenueTrendChart";
import { WarehousePerformanceChart } from "../components/analytics/WarehousePerformanceChart";
import { SupplierComparisonGrid } from "../components/analytics/SupplierComparisonGrid";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import { ErrorMessage } from "../components/ui/ErrorMessage";
import type { Product, Warehouse } from "../types/domain";

const cardStyle: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 22 };
const compactCardStyle: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 16 };
const kpiCardStyle: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "14px 16px" };
const inputStyle: React.CSSProperties = { background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, color: "var(--color-text)" };
const thStyle: React.CSSProperties = { textAlign: "left", padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" };
const tdStyle: React.CSSProperties = { padding: "10px 16px", fontSize: 13, borderTop: "1px solid var(--color-border)" };

function money(n: number): string {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function AnalyticsPage() {
  const warehousesFetch = useFetch<Warehouse[]>(() => listWarehouses(), []);
  const productsFetch = useFetch<Product[]>(() => listProducts(), []);
  const salesFetch = useFetch(() => getSalesTrends(), []);
  const purchasesFetch = useFetch(() => getPurchaseTrends(), []);
  const warehouseDemandFetch = useFetch(() => getWarehouseDemand(), []);
  const supplierComparisonFetch = useFetch(() => getSupplierComparison(), []);

  const [warehouseFilter, setWarehouseFilter] = useState<number | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [range, setRange] = useState<DateRange>("30d");
  const [performanceView, setPerformanceView] = useState<ProductPerformanceView>("best");

  const warehouseId = warehouseFilter === "all" ? undefined : warehouseFilter;
  const bestSellingFetch = useFetch(() => getTopSellingProducts(warehouseId), [warehouseId]);
  const lowestSellingFetch = useFetch(() => getLowestSellingProducts(warehouseId), [warehouseId]);
  const fastMovingFetch = useFetch(() => getFastMovingProducts(30, warehouseId), [warehouseId]);
  const slowMovingFetch = useFetch(() => getSlowMovingProducts(30, warehouseId), [warehouseId]);

  const warehouses = useMemo(() => warehousesFetch.data ?? [], [warehousesFetch.data]);
  const products = useMemo(() => productsFetch.data ?? [], [productsFetch.data]);
  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of products) set.add(p.category?.trim() || "Uncategorized");
    return [...set].sort();
  }, [products]);

  const sales = useMemo(() => filterSalesByRange(salesFetch.data ?? [], range), [salesFetch.data, range]);
  const purchases = useMemo(() => filterPurchasesByRange(purchasesFetch.data ?? [], range), [purchasesFetch.data, range]);
  const merged = useMemo(() => mergeTrends(sales, purchases), [sales, purchases]);
  const kpis = useMemo(() => computeKpis(sales, purchases), [sales, purchases]);
  const activeSkus = useMemo(() => products.filter((p) => p.isActive).length, [products]);

  const performanceRows = useMemo(() => {
    const map: Record<ProductPerformanceView, (TopSellingProduct | { productId: number; name: string; quantityMoved: number })[]> = {
      best: bestSellingFetch.data ?? [],
      lowest: lowestSellingFetch.data ?? [],
      fast: fastMovingFetch.data ?? [],
      slow: slowMovingFetch.data ?? [],
    };
    return filterByCategory(map[performanceView], productsById, categoryFilter);
  }, [performanceView, bestSellingFetch.data, lowestSellingFetch.data, fastMovingFetch.data, slowMovingFetch.data, productsById, categoryFilter]);

  const performanceLoading =
    (performanceView === "best" && bestSellingFetch.loading) ||
    (performanceView === "lowest" && lowestSellingFetch.loading) ||
    (performanceView === "fast" && fastMovingFetch.loading) ||
    (performanceView === "slow" && slowMovingFetch.loading);

  const warehouseDemand = useMemo(() => warehouseDemandFetch.data ?? [], [warehouseDemandFetch.data]);
  const suppliers = useMemo(() => supplierComparisonFetch.data ?? [], [supplierComparisonFetch.data]);

  const isLoading = warehousesFetch.loading || productsFetch.loading || salesFetch.loading || purchasesFetch.loading;
  const loadError = warehousesFetch.error || productsFetch.error || salesFetch.error || purchasesFetch.error;

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner label="Loading analytics..." />
      </div>
    );
  }
  if (loadError) {
    return (
      <ErrorMessage
        message={loadError}
        onRetry={() => {
          warehousesFetch.refetch();
          productsFetch.refetch();
          salesFetch.refetch();
          purchasesFetch.refetch();
        }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
        <div style={{ ...kpiCardStyle, borderLeft: "3px solid var(--color-success)" }}>
          <div style={{ fontSize: 11.5, color: "var(--color-text-secondary)", marginBottom: 6 }}>Total Revenue</div>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 22, color: "var(--color-success)" }}>{money(kpis.totalRevenue)}</div>
        </div>
        <div style={{ ...kpiCardStyle, borderLeft: "3px solid var(--color-danger)" }}>
          <div style={{ fontSize: 11.5, color: "var(--color-text-secondary)", marginBottom: 6 }}>Total Purchase Cost</div>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 22, color: "var(--color-danger)" }}>{money(kpis.totalPurchaseCost)}</div>
        </div>
        <div style={{ ...kpiCardStyle, borderLeft: `3px solid ${kpis.netMargin >= 0 ? "var(--color-success)" : "var(--color-danger)"}` }}>
          <div style={{ fontSize: 11.5, color: "var(--color-text-secondary)", marginBottom: 6 }}>Net Margin</div>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 22, color: kpis.netMargin >= 0 ? "var(--color-success)" : "var(--color-danger)" }}>{money(kpis.netMargin)}</div>
        </div>
        <div style={{ ...kpiCardStyle, borderLeft: "3px solid var(--color-accent)" }}>
          <div style={{ fontSize: 11.5, color: "var(--color-text-secondary)", marginBottom: 6 }}>Active SKUs</div>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 22, color: "var(--color-accent)" }}>{activeSkus}</div>
        </div>
      </div>

      {/* Revenue vs Purchase Cost trend */}
      <div style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
          <div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15, marginBottom: 2 }}>Revenue vs Purchase Cost</div>
            <div style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>Completed transactions, by day</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r.value}
                type="button"
                onClick={() => setRange(r.value)}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "7px 13px",
                  borderRadius: 7,
                  border: "1px solid var(--color-border)",
                  background: range === r.value ? "var(--color-accent)" : "var(--color-surface-2)",
                  color: range === r.value ? "#FFFFFF" : "var(--color-text-secondary)",
                  cursor: "pointer",
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        <RevenueTrendChart points={merged} />
      </div>

      {/* Warehouse Performance + Supplier Comparison */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 14 }}>
        <div style={compactCardStyle}>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 13.5, marginBottom: 2 }}>Warehouse Performance</div>
          <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 12 }}>Completed customer sales, all-time, all warehouses</div>
          {warehouseDemandFetch.loading ? (
            <LoadingSpinner />
          ) : (
            <WarehousePerformanceChart warehouses={warehouseDemand} compact />
          )}
        </div>

        <div style={{ ...compactCardStyle, padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "14px 16px 2px" }}>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 13.5 }}>Supplier Comparison</div>
            <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>All active suppliers, purchase history</div>
          </div>
          {supplierComparisonFetch.loading ? (
            <div style={{ padding: 16 }}><LoadingSpinner /></div>
          ) : (
            <SupplierComparisonGrid suppliers={suppliers} compact />
          )}
        </div>
      </div>

      {/* Product Performance filters */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>Product Performance filters:</span>
        <select value={warehouseFilter === "all" ? "all" : String(warehouseFilter)} onChange={(e) => setWarehouseFilter(e.target.value === "all" ? "all" : Number(e.target.value))} style={inputStyle}>
          <option value="all">All warehouses</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>{w.name}</option>
          ))}
        </select>
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} style={inputStyle}>
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* Product Performance */}
      <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 22px", borderBottom: "1px solid var(--color-border)", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Product Performance</div>
            <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 2 }}>Filtered by warehouse and category</div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {PRODUCT_PERFORMANCE_VIEWS.map((v) => (
              <button
                key={v.value}
                type="button"
                onClick={() => setPerformanceView(v.value)}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid var(--color-border)",
                  background: performanceView === v.value ? "var(--color-accent)" : "var(--color-surface-2)",
                  color: performanceView === v.value ? "#FFFFFF" : "var(--color-text-secondary)",
                  cursor: "pointer",
                }}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
        {performanceView === "fast" || performanceView === "slow" ? (
          <div style={{ padding: "10px 22px 0", fontSize: 11.5, color: "var(--color-text-muted)" }}>Based on the last 30 days of outgoing movement.</div>
        ) : null}
        {performanceLoading ? (
          <div style={{ padding: 20 }}><LoadingSpinner /></div>
        ) : performanceRows.length === 0 ? (
          <div style={{ padding: "36px 20px", textAlign: "center", fontSize: 12.5, color: "var(--color-text-muted)" }}>No products match this view.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
              <thead>
                <tr style={{ background: "var(--color-surface-2)" }}>
                  <th style={thStyle}>ID</th>
                  <th style={thStyle}>Product</th>
                  <th style={thStyle}>Category</th>
                  {performanceView === "best" || performanceView === "lowest" ? (
                    <>
                      <th style={{ ...thStyle, textAlign: "right" }}>Sold</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Revenue</th>
                    </>
                  ) : (
                    <th style={{ ...thStyle, textAlign: "right" }}>Quantity Moved</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {performanceRows.slice(0, 15).map((row) => (
                  <tr key={row.productId}>
                    <td style={{ ...tdStyle, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-secondary)" }}>PRD-{row.productId}</td>
                    <td style={{ ...tdStyle, fontWeight: 500 }}>{row.name}</td>
                    <td style={{ ...tdStyle, color: "var(--color-text-secondary)", fontSize: 12.5 }}>{productsById.get(row.productId)?.category?.trim() || "Uncategorized"}</td>
                    {isTopSellingRow(row) ? (
                      <>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "var(--font-mono)" }}>{row.totalQuantitySold}</td>
                        <td style={{ ...tdStyle, textAlign: "right", fontFamily: "var(--font-mono)", color: "var(--color-success)" }}>{money(row.totalRevenue)}</td>
                      </>
                    ) : (
                      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "var(--font-mono)" }}>{row.quantityMoved}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
