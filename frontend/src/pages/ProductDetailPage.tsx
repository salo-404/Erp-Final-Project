import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useFetch } from "../lib/useFetch";
import { getProduct, updateProduct } from "../lib/products.api";
import { getProductStockByWarehouse } from "../lib/productStock.api";
import { getBestSupplier } from "../lib/supplierIntelligence.api";
import { getSupplier } from "../lib/suppliers.api";
import { getRestockRecommendations } from "../lib/stockInsights.api";
import { getProductDemand, getStockHistory } from "../lib/analytics.api";
import { inventoryStatus } from "../lib/inventoryStats";
import { aggregateStock, movementIsIncrease, movementNote, pickRestockRecommendation, stockBarPct } from "../lib/productDetailStats";
import { ProductFormModal } from "../components/inventory/ProductFormModal";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import { ErrorMessage } from "../components/ui/ErrorMessage";
import { EditIcon } from "../components/ui/icons";

const cardStyle: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 10, padding: 20 };
const heading: React.CSSProperties = { fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 14, marginBottom: 14 };

export function ProductDetailPage() {
  const { id: idParam } = useParams();
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const [editing, setEditing] = useState(false);

  const id = Number(idParam);
  const validId = idParam !== undefined && Number.isInteger(id) && id > 0;

  const productFetch = useFetch(() => (validId ? getProduct(id) : Promise.reject(new Error("Invalid product ID"))), [id, validId]);
  const stockFetch = useFetch(() => (validId ? getProductStockByWarehouse(id) : Promise.resolve([])), [id, validId]);
  const bestSupplierFetch = useFetch(() => (validId ? getBestSupplier(id) : Promise.resolve(null)), [id, validId]);
  const restockFetch = useFetch(() => getRestockRecommendations(), []);
  const historyFetch = useFetch(() => (validId ? getStockHistory(id) : Promise.resolve([])), [id, validId]);
  const demandFetch = useFetch(() => (validId ? getProductDemand(id) : Promise.resolve(null)), [id, validId]);

  const supplierId = bestSupplierFetch.data?.supplierId ?? null;
  const supplierDetailFetch = useFetch(
    () => (supplierId !== null ? getSupplier(supplierId) : Promise.resolve(null)),
    [supplierId],
  );

  const stockRows = useMemo(() => stockFetch.data ?? [], [stockFetch.data]);
  const stockAgg = useMemo(() => aggregateStock(stockRows), [stockRows]);
  const status = inventoryStatus(stockAgg.totalAvailable, stockAgg.totalReorderThreshold);
  const barPct = stockBarPct(stockAgg.totalAvailable, stockAgg.totalReorderThreshold);
  const recommendation = useMemo(
    () => pickRestockRecommendation(restockFetch.data ?? [], id),
    [restockFetch.data, id],
  );
  const recommendationWarehouseName =
    stockRows.find((r) => r.warehouseId === recommendation?.warehouseId)?.warehouseName ?? null;

  async function handleEditSubmit(input: { name: string; category?: string; description?: string }) {
    await updateProduct(id, input);
    productFetch.refetch();
  }

  if (!validId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="font-[var(--font-heading)] text-lg font-semibold">Invalid product ID</p>
        <Link to="/inventory" className="text-sm font-medium text-[var(--color-accent)] hover:underline">
          Back to inventory
        </Link>
      </div>
    );
  }

  if (productFetch.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner label="Loading product..." />
      </div>
    );
  }

  if (productFetch.errorStatus === 404) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="font-[var(--font-heading)] text-lg font-semibold">Product not found</p>
        <p className="text-sm text-[var(--color-text-muted)]">PRD-{id} doesn't exist or was removed.</p>
        <Link to="/inventory" className="mt-1 text-sm font-medium text-[var(--color-accent)] hover:underline">
          Back to inventory
        </Link>
      </div>
    );
  }

  if (productFetch.error || !productFetch.data) {
    return <ErrorMessage message={productFetch.error ?? "Failed to load product."} onRetry={productFetch.refetch} />;
  }

  const product = productFetch.data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <Link
        to="/inventory"
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--color-text-secondary)", width: "fit-content" }}
      >
        ← Back to inventory
      </Link>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 18 }}>
        {/* Product header — decorative clipped corner, matching the Nexora design */}
        <div
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            clipPath: "polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 0 100%)",
            padding: 22,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18, gap: 12 }}>
            <div>
              <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 20, marginBottom: 6 }}>{product.name}</div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--color-text-secondary)" }}>
                PRD-{product.id} · {product.category?.trim() || "Uncategorized"}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
              <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", padding: "4px 9px", borderRadius: 4, background: status.bg, color: status.color }}>
                {status.label}
              </div>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, padding: "5px 10px", borderRadius: 6, background: "var(--color-surface)", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", cursor: "pointer" }}
                >
                  <EditIcon className="h-3 w-3" />
                  Edit
                </button>
              )}
            </div>
          </div>

          {stockFetch.loading ? (
            <LoadingSpinner label="Loading stock..." />
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 20 }}>
                <div>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 4 }}>Total On Hand</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 19, fontWeight: 500 }}>{stockAgg.totalOnHand.toLocaleString()}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 4 }}>Total Available</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 19, fontWeight: 500 }}>{stockAgg.totalAvailable.toLocaleString()}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 4 }}>Avg. Purchase Price</div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 19, fontWeight: 500 }}>
                    {bestSupplierFetch.data?.averagePrice != null ? `$${bestSupplierFetch.data.averagePrice.toFixed(2)}` : "—"}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginBottom: 8 }}>Stock level</div>
              <div style={{ height: 8, borderRadius: 4, background: "var(--color-border)", overflow: "hidden" }}>
                <div style={{ height: "100%", background: status.color, width: `${barPct}%` }} />
              </div>
            </>
          )}
        </div>

        {/* Supplier & Reorder Info */}
        <div style={cardStyle}>
          <div style={heading}>Supplier & Reorder Info</div>
          {bestSupplierFetch.loading || supplierDetailFetch.loading ? (
            <LoadingSpinner label="Loading supplier info..." />
          ) : !bestSupplierFetch.data ? (
            <p style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>No purchase history for this product yet.</p>
          ) : (
            <>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 2 }}>{bestSupplierFetch.data.supplierName}</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 16 }}>
                {bestSupplierFetch.data.score != null ? `${Math.round(bestSupplierFetch.data.score)}/100 score` : "Score unavailable"}
                {bestSupplierFetch.data.onTimeDeliveryRate != null && ` · ${Math.round(bestSupplierFetch.data.onTimeDeliveryRate * 100)}% on-time`}
              </div>
              <Link to="/suppliers" style={{ display: "inline-block", fontSize: 12.5, color: "var(--color-accent)", marginBottom: 16 }}>
                View supplier &amp; orders →
              </Link>
              <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 14, fontSize: 12, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
                {supplierDetailFetch.data?.leadTimeDays != null ? (
                  <>Lead time: {supplierDetailFetch.data.leadTimeDays} days. </>
                ) : (
                  <>Lead time not on record. </>
                )}
                {recommendation ? (
                  <>
                    Suggested reorder: {recommendation.recommendedQuantity} units for {recommendationWarehouseName ?? `warehouse #${recommendation.warehouseId}`}.
                  </>
                ) : (
                  <>No restock currently recommended.</>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Stock by Warehouse */}
      <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>
          Stock by Warehouse
        </div>
        {stockFetch.loading ? (
          <div style={{ padding: 18 }}>
            <LoadingSpinner />
          </div>
        ) : stockFetch.error ? (
          <div style={{ padding: 20 }}>
            <ErrorMessage message={stockFetch.error} onRetry={stockFetch.refetch} />
          </div>
        ) : stockRows.length === 0 ? (
          <div style={{ padding: "36px 20px", textAlign: "center", fontSize: 12.5, color: "var(--color-text-muted)" }}>
            No warehouse stocks this product yet.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 600 }}>
              <thead>
                <tr style={{ background: "var(--color-surface-2)" }}>
                  {["Warehouse", "On Hand", "Reserved", "Available", "Reorder Threshold"].map((h, i) => (
                    <th
                      key={h}
                      style={{ textAlign: i === 0 ? "left" : "right", padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stockRows.map((row) => (
                  <tr key={row.warehouseId}>
                    <td style={{ padding: "10px 16px", fontSize: 13, fontWeight: 500, borderTop: "1px solid var(--color-border)" }}>{row.warehouseName}</td>
                    <td style={{ padding: "10px 16px", fontSize: 13, textAlign: "right", fontFamily: "var(--font-mono)", borderTop: "1px solid var(--color-border)" }}>{row.onHand}</td>
                    <td style={{ padding: "10px 16px", fontSize: 13, textAlign: "right", fontFamily: "var(--font-mono)", borderTop: "1px solid var(--color-border)" }}>{row.reserved}</td>
                    <td style={{ padding: "10px 16px", fontSize: 13, textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700, borderTop: "1px solid var(--color-border)" }}>{row.available}</td>
                    <td style={{ padding: "10px 16px", fontSize: 13, textAlign: "right", fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)", borderTop: "1px solid var(--color-border)" }}>{row.reorderThreshold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Movement History */}
      <div style={cardStyle}>
        <div style={heading}>Movement History</div>
        {historyFetch.loading ? (
          <LoadingSpinner />
        ) : historyFetch.error ? (
          <ErrorMessage message={historyFetch.error} onRetry={historyFetch.refetch} />
        ) : !historyFetch.data || historyFetch.data.length === 0 ? (
          <p style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>No movement history yet.</p>
        ) : (
          <div>
            {historyFetch.data
              .slice()
              .reverse()
              .map((mv) => {
                const increase = movementIsIncrease(mv);
                return (
                  <div key={mv.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--color-border)" }}>
                    <div style={{ fontSize: 13 }}>{movementNote(mv)}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                      <div style={{ fontSize: 12, color: "var(--color-text-muted)" }}>
                        {new Date(mv.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                      </div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: increase ? "var(--color-success)" : "var(--color-danger)" }}>
                        {increase ? "+" : "-"}
                        {Math.abs(mv.quantity)}
                      </div>
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {/* Product Demand */}
      <div style={cardStyle}>
        <div style={heading}>Product Demand</div>
        {demandFetch.loading ? (
          <LoadingSpinner />
        ) : demandFetch.error ? (
          <ErrorMessage message={demandFetch.error} onRetry={demandFetch.refetch} />
        ) : !demandFetch.data || demandFetch.data.totalQuantitySold === 0 ? (
          <p style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>No completed sales for this product yet.</p>
        ) : (
          <>
            <div style={{ display: "flex", gap: 32, marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 4 }}>Total Quantity Sold</div>
                <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 22 }}>{demandFetch.data.totalQuantitySold.toLocaleString()}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 4 }}>Total Revenue</div>
                <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 22 }}>${demandFetch.data.totalRevenue.toLocaleString()}</div>
              </div>
            </div>
            {demandFetch.data.warehouseDemand.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {demandFetch.data.warehouseDemand.map((w) => {
                  const max = Math.max(1, ...demandFetch.data!.warehouseDemand.map((x) => x.quantitySold));
                  return (
                    <div key={w.warehouseId}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                        <span style={{ color: "var(--color-text-secondary)" }}>{w.warehouseName}</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--color-text-secondary)" }}>{w.quantitySold}</span>
                      </div>
                      <div style={{ height: 7, background: "var(--color-border)", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ width: `${(w.quantitySold / max) * 100}%`, height: "100%", background: "var(--color-accent)", borderRadius: 4 }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>

      {editing && (
        <ProductFormModal product={product} onClose={() => setEditing(false)} onSubmit={handleEditSubmit} />
      )}
    </div>
  );
}
