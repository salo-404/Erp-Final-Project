import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useFetch } from "../lib/useFetch";
import { listWarehouses } from "../lib/warehouses.api";
import { listProducts } from "../lib/products.api";
import { getTopSellingProducts } from "../lib/analytics.api";
import {
  cancelTransaction,
  completeTransaction,
  createOutgoing,
  listTransactions,
} from "../lib/inventoryTransactions.api";
import { uploadDocument } from "../lib/documentReview.api";
import { transactionStatusBadge } from "../lib/transactionStatus";
import { categorySalesBreakdown } from "../lib/orderStats";
import { StatusDonut } from "../components/ui/StatusDonut";
import { CreateCustomerOrderModal } from "../components/orders/CreateCustomerOrderModal";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import { ErrorMessage } from "../components/ui/ErrorMessage";
import { CheckIcon, PlusIcon, UploadIcon, XCircleIcon } from "../components/ui/icons";
import { ShowMoreRow } from "../components/ui/ShowMoreRow";
import { useShowMore } from "../lib/useShowMore";
import type { CreateOutgoingInput, Product, Warehouse } from "../types/domain";

const cardStyle: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 22 };

export function OrdersPage() {
  const navigate = useNavigate();
  const ordersFetch = useFetch(() => listTransactions({ type: "OUTGOING" }), []);
  const warehousesFetch = useFetch<Warehouse[]>(() => listWarehouses(), []);
  const productsFetch = useFetch<Product[]>(() => listProducts(), []);
  const topSellingFetch = useFetch(() => getTopSellingProducts(), []);

  const [creatingOrder, setCreatingOrder] = useState(false);
  const [confirmingTxAction, setConfirmingTxAction] = useState<{ id: number; action: "complete" | "cancel" } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const orders = useMemo(() => ordersFetch.data ?? [], [ordersFetch.data]);
  const ordersShowMore = useShowMore(orders, 10, 10);
  const warehouses = useMemo(() => warehousesFetch.data ?? [], [warehousesFetch.data]);
  const products = useMemo(() => productsFetch.data ?? [], [productsFetch.data]);
  const warehouseNames = useMemo(() => new Map(warehouses.map((w) => [w.id, w.name])), [warehouses]);
  const productsById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const statusSegments = useMemo(
    () => [
      { label: "Completed", value: orders.filter((o) => o.status === "COMPLETED").length, color: "var(--color-success)" },
      { label: "Pending", value: orders.filter((o) => o.status === "PENDING").length, color: "var(--color-warning)" },
      { label: "Cancelled", value: orders.filter((o) => o.status === "CANCELLED").length, color: "var(--color-text-muted)" },
    ],
    [orders],
  );

  const categoryBreakdown = useMemo(() => categorySalesBreakdown(orders, productsById), [orders, productsById]);

  async function handleCreateOrder(input: CreateOutgoingInput) {
    await createOutgoing(input);
    ordersFetch.refetch();
  }
  async function handleConfirmTxAction() {
    if (!confirmingTxAction) return;
    if (confirmingTxAction.action === "complete") {
      await completeTransaction(confirmingTxAction.id);
    } else {
      await cancelTransaction(confirmingTxAction.id);
    }
    ordersFetch.refetch();
    setConfirmingTxAction(null);
  }

  async function handleUploadInvoice(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const review = await uploadDocument(file);
      navigate(`/document-review/${review.id}`);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  if (ordersFetch.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner label="Loading orders..." />
      </div>
    );
  }
  const pageError = ordersFetch.error || warehousesFetch.error || productsFetch.error;
  if (pageError) {
    return (
      <ErrorMessage
        message={pageError}
        onRetry={() => {
          ordersFetch.refetch();
          warehousesFetch.refetch();
          productsFetch.refetch();
        }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" onChange={handleUploadInvoice} style={{ display: "none" }} />
      {uploadError && <ErrorMessage message={uploadError} />}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18 }}>
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div>
              <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Top Product Categories</div>
              <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 4 }}>By units ordered</div>
            </div>
          </div>
          {categoryBreakdown.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>No customer orders yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {categoryBreakdown.map((c) => (
                <div key={c.name}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: c.color, display: "inline-block" }} />
                      {c.name}
                    </span>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>{c.pct}%</span>
                  </div>
                  <div style={{ height: 6, background: "var(--color-border)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${c.pct}%`, height: "100%", background: c.color }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={cardStyle}>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Order Status</div>
          <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginBottom: 16 }}>Live pipeline snapshot</div>
          <StatusDonut segments={statusSegments} centerLabel="orders" />
        </div>

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div>
              <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Top Products Ordered</div>
              <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 4 }}>Volume ranking, all-time</div>
            </div>
          </div>
          {topSellingFetch.loading ? (
            <LoadingSpinner />
          ) : topSellingFetch.error ? (
            <ErrorMessage message={topSellingFetch.error} onRetry={topSellingFetch.refetch} />
          ) : (topSellingFetch.data ?? []).length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>No completed sales yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {(topSellingFetch.data ?? []).slice(0, 6).map((p) => {
                const max = Math.max(1, ...(topSellingFetch.data ?? []).slice(0, 6).map((x) => x.totalQuantitySold));
                return (
                  <div key={p.productId}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                      <span style={{ color: "var(--color-text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--color-text-secondary)" }}>{p.totalQuantitySold}</span>
                    </div>
                    <div style={{ height: 6, background: "var(--color-border)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${(p.totalQuantitySold / max) * 100}%`, height: "100%", background: "var(--color-accent)", borderRadius: 3 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 22px", borderBottom: "1px solid var(--color-border)", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Customer Orders</div>
            <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 2 }}>{orders.length} total</div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600, padding: "10px 16px", borderRadius: 8, background: "var(--color-surface-2)", color: "var(--color-text)", border: "1px solid var(--color-border)", cursor: uploading ? "default" : "pointer", opacity: uploading ? 0.7 : 1 }}
            >
              <UploadIcon className="h-[14px] w-[14px]" />
              {uploading ? "Uploading..." : "Upload Invoice"}
            </button>
            <button
              type="button"
              onClick={() => setCreatingOrder(true)}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600, padding: "10px 16px", borderRadius: 8, background: "var(--color-accent)", color: "var(--color-on-accent)", border: "none", cursor: "pointer" }}
            >
              <PlusIcon className="h-[14px] w-[14px]" />
              Create Customer Order
            </button>
          </div>
        </div>

        {orders.length === 0 ? (
          <div style={{ padding: "36px 20px", textAlign: "center", fontSize: 12.5, color: "var(--color-text-muted)" }}>No customer orders yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
              <thead>
                <tr style={{ background: "var(--color-surface-2)" }}>
                  {["Order ID", "Customer", "Warehouse", "Items", "Status", "Delivery", "Actions"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ordersShowMore.visible.map((o) => {
                  const badge = transactionStatusBadge(o.status, o.expectedDate);
                  return (
                    <tr key={o.id}>
                      <td style={{ padding: "10px 16px", fontSize: 12.5, fontFamily: "var(--font-mono)", fontWeight: 600, borderTop: "1px solid var(--color-border)" }}>TXN-{o.id}</td>
                      <td style={{ padding: "10px 16px", fontSize: 13, fontWeight: 500, borderTop: "1px solid var(--color-border)" }}>{o.partyName ?? "—"}</td>
                      <td style={{ padding: "10px 16px", fontSize: 13, color: "var(--color-text-secondary)", borderTop: "1px solid var(--color-border)" }}>
                        {o.sourceWarehouseId ? warehouseNames.get(o.sourceWarehouseId) ?? `#${o.sourceWarehouseId}` : "—"}
                      </td>
                      <td style={{ padding: "10px 16px", fontSize: 13, fontFamily: "var(--font-mono)", fontWeight: 600, borderTop: "1px solid var(--color-border)" }}>{o.items.length}</td>
                      <td style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)" }}>
                        <span style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 9px", borderRadius: 4, background: badge.bg, color: badge.color }}>{badge.label}</span>
                      </td>
                      <td style={{ padding: "10px 16px", fontSize: 12.5, color: "var(--color-text-secondary)", borderTop: "1px solid var(--color-border)" }}>
                        {o.status === "COMPLETED" && o.actualDate
                          ? new Date(o.actualDate).toLocaleDateString()
                          : o.expectedDate
                            ? new Date(o.expectedDate).toLocaleDateString()
                            : "—"}
                      </td>
                      <td style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)" }}>
                        <div style={{ display: "flex", gap: 6 }}>
                          {o.status === "PENDING" && (
                            <>
                              <button type="button" title="Complete" onClick={() => setConfirmingTxAction({ id: o.id, action: "complete" })} style={{ width: 26, height: 26, borderRadius: 6, background: "rgba(34,197,94,0.12)", border: "1px solid var(--color-border)", color: "var(--color-success)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                                <CheckIcon className="h-[13px] w-[13px]" />
                              </button>
                              <button type="button" title="Cancel" onClick={() => setConfirmingTxAction({ id: o.id, action: "cancel" })} style={{ width: 26, height: 26, borderRadius: 6, background: "rgba(239,68,68,0.1)", border: "1px solid var(--color-border)", color: "var(--color-danger)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                                <XCircleIcon className="h-[13px] w-[13px]" />
                              </button>
                            </>
                          )}
                          {o.status !== "PENDING" && (
                            <span style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                <ShowMoreRow colSpan={7} shown={ordersShowMore.shown} total={ordersShowMore.total} onShowMore={ordersShowMore.showMore} />
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creatingOrder && (
        <CreateCustomerOrderModal
          warehouses={warehouses}
          products={products}
          onClose={() => setCreatingOrder(false)}
          onSubmit={handleCreateOrder}
        />
      )}
      {confirmingTxAction && (
        <ConfirmDialog
          title={confirmingTxAction.action === "complete" ? "Complete Order" : "Cancel Order"}
          message={
            confirmingTxAction.action === "complete"
              ? "Mark this order as completed? This will deduct the fulfilled stock from inventory."
              : "Cancel this order? This cannot be undone."
          }
          confirmLabel={confirmingTxAction.action === "complete" ? "Complete" : "Cancel Order"}
          danger={confirmingTxAction.action === "cancel"}
          onCancel={() => setConfirmingTxAction(null)}
          onConfirm={handleConfirmTxAction}
        />
      )}
    </div>
  );
}
