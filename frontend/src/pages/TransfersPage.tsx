import { useMemo, useState } from "react";
import { useFetch } from "../lib/useFetch";
import { listWarehouses } from "../lib/warehouses.api";
import { listProducts } from "../lib/products.api";
import { cancelTransaction, completeTransaction, listTransactions } from "../lib/inventoryTransactions.api";
import { transactionStatusBadge } from "../lib/transactionStatus";
import { StatusDonut } from "../components/ui/StatusDonut";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import { ErrorMessage } from "../components/ui/ErrorMessage";
import { CheckIcon, XCircleIcon } from "../components/ui/icons";
import { ShowMoreRow } from "../components/ui/ShowMoreRow";
import { useShowMore } from "../lib/useShowMore";
import { TransferDetailModal } from "../components/inventoryTransactions/TransferDetailModal";
import type { InventoryTransactionWithItems, Product, Warehouse } from "../types/domain";

const cardStyle: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 22 };

export function TransfersPage() {
  const transfersFetch = useFetch(() => listTransactions({ type: "TRANSFER" }), []);
  const warehousesFetch = useFetch<Warehouse[]>(() => listWarehouses(), []);
  const productsFetch = useFetch<Product[]>(() => listProducts(), []);

  const [confirmingTxAction, setConfirmingTxAction] = useState<{ id: number; action: "complete" | "cancel" } | null>(null);
  const [viewingTransfer, setViewingTransfer] = useState<InventoryTransactionWithItems | null>(null);

  const transfers = useMemo(() => transfersFetch.data ?? [], [transfersFetch.data]);
  const transfersShowMore = useShowMore(transfers, 10, 10);
  const warehouses = useMemo(() => warehousesFetch.data ?? [], [warehousesFetch.data]);
  const products = useMemo(() => productsFetch.data ?? [], [productsFetch.data]);
  const warehouseNames = useMemo(() => new Map(warehouses.map((w) => [w.id, w.name])), [warehouses]);
  const productNames = useMemo(() => new Map(products.map((p) => [p.id, p.name])), [products]);
  function productName(productId: number): string {
    return productNames.get(productId) ?? `Product #${productId}`;
  }

  const statusSegments = useMemo(
    () => [
      { label: "Completed", value: transfers.filter((t) => t.status === "COMPLETED").length, color: "var(--color-success)" },
      { label: "Pending", value: transfers.filter((t) => t.status === "PENDING").length, color: "var(--color-warning)" },
      { label: "Cancelled", value: transfers.filter((t) => t.status === "CANCELLED").length, color: "var(--color-text-muted)" },
    ],
    [transfers],
  );

  // Busiest source -> destination pairs, by transfer count — helps spot
  // which routes are actually moving stock most often.
  const busiestRoutes = useMemo(() => {
    const counts = new Map<string, { from: number; to: number; count: number }>();
    for (const t of transfers) {
      if (t.sourceWarehouseId === null || t.destinationWarehouseId === null) continue;
      const key = `${t.sourceWarehouseId}->${t.destinationWarehouseId}`;
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { from: t.sourceWarehouseId, to: t.destinationWarehouseId, count: 1 });
    }
    return Array.from(counts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [transfers]);

  // Most-transferred products, by total units moved across all transfers
  // (any status) — a volume ranking mirroring Orders' "Top Products Ordered".
  const topProducts = useMemo(() => {
    const totals = new Map<number, number>();
    for (const t of transfers) {
      for (const item of t.items) {
        totals.set(item.productId, (totals.get(item.productId) ?? 0) + item.quantity);
      }
    }
    return Array.from(totals.entries())
      .map(([productId, quantity]) => ({ productId, quantity, name: productNames.get(productId) ?? `Product #${productId}` }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 6);
  }, [transfers, productNames]);

  async function handleConfirmTxAction() {
    if (!confirmingTxAction) return;
    if (confirmingTxAction.action === "complete") {
      await completeTransaction(confirmingTxAction.id);
    } else {
      await cancelTransaction(confirmingTxAction.id);
    }
    transfersFetch.refetch();
    setConfirmingTxAction(null);
  }

  if (transfersFetch.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner label="Loading transfers..." />
      </div>
    );
  }
  const pageError = transfersFetch.error || warehousesFetch.error || productsFetch.error;
  if (pageError) {
    return (
      <ErrorMessage
        message={pageError}
        onRetry={() => {
          transfersFetch.refetch();
          warehousesFetch.refetch();
          productsFetch.refetch();
        }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 18 }}>
        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div>
              <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Busiest Routes</div>
              <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 4 }}>By transfer count</div>
            </div>
          </div>
          {busiestRoutes.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>No transfers yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {busiestRoutes.map((r) => {
                const max = Math.max(1, ...busiestRoutes.map((x) => x.count));
                return (
                  <div key={`${r.from}-${r.to}`}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                      <span style={{ color: "var(--color-text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {warehouseNames.get(r.from) ?? `#${r.from}`} → {warehouseNames.get(r.to) ?? `#${r.to}`}
                      </span>
                      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--color-text-secondary)" }}>{r.count}</span>
                    </div>
                    <div style={{ height: 6, background: "var(--color-border)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${(r.count / max) * 100}%`, height: "100%", background: "var(--color-accent)", borderRadius: 3 }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div style={cardStyle}>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Transfer Status</div>
          <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginBottom: 16 }}>Live pipeline snapshot</div>
          <StatusDonut segments={statusSegments} centerLabel="transfers" />
        </div>

        <div style={cardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 16 }}>
            <div>
              <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Most Transferred Products</div>
              <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 4 }}>By units moved, all-time</div>
            </div>
          </div>
          {topProducts.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>No transfers yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {topProducts.map((p) => {
                const max = Math.max(1, ...topProducts.map((x) => x.quantity));
                return (
                  <div key={p.productId}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                      <span style={{ color: "var(--color-text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</span>
                      <span style={{ fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--color-text-secondary)" }}>{p.quantity}</span>
                    </div>
                    <div style={{ height: 6, background: "var(--color-border)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${(p.quantity / max) * 100}%`, height: "100%", background: "var(--color-accent)", borderRadius: 3 }} />
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
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Warehouse Transfers</div>
            <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 2 }}>{transfers.length} total</div>
          </div>
        </div>

        {transfers.length === 0 ? (
          <div style={{ padding: "36px 20px", textAlign: "center", fontSize: 12.5, color: "var(--color-text-muted)" }}>
            No transfers yet — start one from a product's transfer action on the Inventory page.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
              <thead>
                <tr style={{ background: "var(--color-surface-2)" }}>
                  {["Transfer ID", "From", "To", "Items", "Status", "Expected", "Actions"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {transfersShowMore.visible.map((t) => {
                  const badge = transactionStatusBadge(t.status, t.expectedDate);
                  return (
                    <tr key={t.id}>
                      <td style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)" }}>
                        <button
                          type="button"
                          onClick={() => setViewingTransfer(t)}
                          style={{ padding: 0, border: "none", background: "none", font: "inherit", fontSize: 12.5, fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--color-accent)", textDecoration: "underline", cursor: "pointer" }}
                        >
                          TXN-{t.id}
                        </button>
                      </td>
                      <td style={{ padding: "10px 16px", fontSize: 13, color: "var(--color-text-secondary)", borderTop: "1px solid var(--color-border)" }}>
                        {t.sourceWarehouseId ? warehouseNames.get(t.sourceWarehouseId) ?? `#${t.sourceWarehouseId}` : "—"}
                      </td>
                      <td style={{ padding: "10px 16px", fontSize: 13, color: "var(--color-text-secondary)", borderTop: "1px solid var(--color-border)" }}>
                        {t.destinationWarehouseId ? warehouseNames.get(t.destinationWarehouseId) ?? `#${t.destinationWarehouseId}` : "—"}
                      </td>
                      <td style={{ padding: "10px 16px", fontSize: 13, fontFamily: "var(--font-mono)", fontWeight: 600, borderTop: "1px solid var(--color-border)" }}>{t.items.length}</td>
                      <td style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)" }}>
                        <span style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 9px", borderRadius: 4, background: badge.bg, color: badge.color }}>{badge.label}</span>
                      </td>
                      <td style={{ padding: "10px 16px", fontSize: 12.5, color: "var(--color-text-secondary)", borderTop: "1px solid var(--color-border)" }}>
                        {t.status === "COMPLETED" && t.actualDate
                          ? new Date(t.actualDate).toLocaleDateString()
                          : t.expectedDate
                            ? new Date(t.expectedDate).toLocaleDateString()
                            : "—"}
                      </td>
                      <td style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)" }}>
                        <div style={{ display: "flex", gap: 6 }}>
                          {t.status === "PENDING" && (
                            <>
                              <button type="button" title="Accept" onClick={() => setConfirmingTxAction({ id: t.id, action: "complete" })} style={{ width: 26, height: 26, borderRadius: 6, background: "rgba(34,197,94,0.12)", border: "1px solid var(--color-border)", color: "var(--color-success)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                                <CheckIcon className="h-[13px] w-[13px]" />
                              </button>
                              <button type="button" title="Cancel" onClick={() => setConfirmingTxAction({ id: t.id, action: "cancel" })} style={{ width: 26, height: 26, borderRadius: 6, background: "rgba(239,68,68,0.1)", border: "1px solid var(--color-border)", color: "var(--color-danger)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                                <XCircleIcon className="h-[13px] w-[13px]" />
                              </button>
                            </>
                          )}
                          {t.status !== "PENDING" && (
                            <span style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                <ShowMoreRow colSpan={7} shown={transfersShowMore.shown} total={transfersShowMore.total} canShowLess={transfersShowMore.canShowLess} onShowMore={transfersShowMore.showMore} onShowLess={transfersShowMore.showLess} />
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirmingTxAction && (
        <ConfirmDialog
          title={confirmingTxAction.action === "complete" ? "Accept Transfer" : "Cancel Transfer"}
          message={
            confirmingTxAction.action === "complete"
              ? "Accept this transfer? This will move the reserved stock into the destination warehouse and deduct it from the source."
              : "Cancel this transfer? This cannot be undone."
          }
          confirmLabel={confirmingTxAction.action === "complete" ? "Accept" : "Cancel Transfer"}
          danger={confirmingTxAction.action === "cancel"}
          onCancel={() => setConfirmingTxAction(null)}
          onConfirm={handleConfirmTxAction}
        />
      )}

      {viewingTransfer && (
        <TransferDetailModal
          transfer={viewingTransfer}
          sourceWarehouseName={viewingTransfer.sourceWarehouseId ? warehouseNames.get(viewingTransfer.sourceWarehouseId) ?? `#${viewingTransfer.sourceWarehouseId}` : "—"}
          destinationWarehouseName={viewingTransfer.destinationWarehouseId ? warehouseNames.get(viewingTransfer.destinationWarehouseId) ?? `#${viewingTransfer.destinationWarehouseId}` : "—"}
          productName={productName}
          onClose={() => setViewingTransfer(null)}
        />
      )}
    </div>
  );
}
