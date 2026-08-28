import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useFetch } from "../lib/useFetch";
import { friendlyErrorMessage } from "../lib/friendlyError";
import {
  createSupplier,
  deleteSupplier,
  getSupplierTransactionHistory,
  listSuppliers,
  updateSupplier,
} from "../lib/suppliers.api";
import { getSupplierStats, rankSuppliers } from "../lib/supplierIntelligence.api";
import { listProducts } from "../lib/products.api";
import { listWarehouses } from "../lib/warehouses.api";
import { createIncoming, completeTransaction, cancelTransaction, listTransactions } from "../lib/inventoryTransactions.api";
import { uploadDocument } from "../lib/documentReview.api";
import { transactionStatusBadge } from "../lib/transactionStatus";
import { SupplierFormModal } from "../components/suppliers/SupplierFormModal";
import { CreatePurchaseOrderModal } from "../components/suppliers/CreatePurchaseOrderModal";
import { InvoicePreviewModal } from "../components/inventoryTransactions/InvoicePreviewModal";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import { ErrorMessage } from "../components/ui/ErrorMessage";
import { CheckIcon, EditIcon, PlusIcon, SearchIcon, TrashIcon, UploadIcon, XCircleIcon } from "../components/ui/icons";
import { ShowMoreRow } from "../components/ui/ShowMoreRow";
import { useShowMore } from "../lib/useShowMore";
import type { CreateIncomingInput, Product, Supplier, Warehouse } from "../types/domain";

const cardStyle: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 22 };
const compactCardStyle: React.CSSProperties = { ...cardStyle, padding: 16 };
const inputStyle: React.CSSProperties = { background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "var(--color-text)" };

function scoreBarColor(score: number): string {
  if (score >= 75) return "var(--color-success)";
  if (score >= 50) return "var(--color-warning)";
  return "var(--color-danger)";
}

export function SuppliersPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const suppliersFetch = useFetch<Supplier[]>(() => listSuppliers(), []);
  const productsFetch = useFetch<Product[]>(() => listProducts(), []);
  const warehousesFetch = useFetch<Warehouse[]>(() => listWarehouses(), []);
  const purchasesFetch = useFetch(() => listTransactions({ type: "INCOMING" }), []);

  const suppliers = useMemo(() => suppliersFetch.data ?? [], [suppliersFetch.data]);
  const products = useMemo(() => productsFetch.data ?? [], [productsFetch.data]);
  const productsSortedByName = useMemo(
    () => [...products].sort((a, b) => a.name.localeCompare(b.name)),
    [products],
  );
  const warehouses = useMemo(() => warehousesFetch.data ?? [], [warehousesFetch.data]);
  const warehouseNames = useMemo(() => new Map(warehouses.map((w) => [w.id, w.name])), [warehouses]);
  const supplierNames = useMemo(() => new Map(suppliers.map((s) => [s.id, s.name])), [suppliers]);

  const [rankProductId, setRankProductId] = useState<number | null>(null);
  const [rankProductSearch, setRankProductSearch] = useState("");
  const [perfSupplierId, setPerfSupplierId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<number | null>(null);
  const [confirmingTxAction, setConfirmingTxAction] = useState<{ id: number; action: "complete" | "cancel" } | null>(null);
  const [previewingInvoiceId, setPreviewingInvoiceId] = useState<number | null>(null);
  const [creatingPO, setCreatingPO] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!productsFetch.loading && products.length > 0 && rankProductId === null) setRankProductId(products[0].id);
  }, [productsFetch.loading, products, rankProductId]);
  useEffect(() => {
    if (!suppliersFetch.loading && suppliers.length > 0 && perfSupplierId === null) setPerfSupplierId(suppliers[0].id);
  }, [suppliersFetch.loading, suppliers, perfSupplierId]);

  // The Top Suppliers product selector, filtered by rankProductSearch but
  // always keeping the currently selected product visible even when the
  // search text no longer matches it — losing it from the list would
  // silently reset the ranking away from what the user picked.
  const rankProductOptions = useMemo(() => {
    const query = rankProductSearch.trim().toLowerCase();
    const filtered = query
      ? productsSortedByName.filter((p) => p.name.toLowerCase().includes(query))
      : productsSortedByName;
    if (rankProductId !== null && !filtered.some((p) => p.id === rankProductId)) {
      const selected = productsSortedByName.find((p) => p.id === rankProductId);
      if (selected) return [selected, ...filtered];
    }
    return filtered;
  }, [productsSortedByName, rankProductSearch, rankProductId]);

  const rankFetch = useFetch(() => (rankProductId !== null ? rankSuppliers(rankProductId) : Promise.resolve([])), [rankProductId]);
  const statsFetch = useFetch(() => (perfSupplierId !== null ? getSupplierStats(perfSupplierId) : Promise.resolve(null)), [perfSupplierId]);
  const historyFetch = useFetch(
    () => (perfSupplierId !== null ? getSupplierTransactionHistory(perfSupplierId) : Promise.resolve(null)),
    [perfSupplierId],
  );

  // Newest arrival/expected date first - see the matching comment on
  // OrdersPage's `orders` for why this differs from the backend's default
  // createdAt-desc ordering. Ranked by the same date the row displays
  // (actualDate once completed, otherwise expectedDate).
  const purchases = useMemo(() => {
    const list = purchasesFetch.data ?? [];
    const effectiveDate = (o: (typeof list)[number]) => (o.status === "COMPLETED" && o.actualDate ? o.actualDate : o.expectedDate);
    return [...list].sort((a, b) => {
      const aDate = effectiveDate(a);
      const bDate = effectiveDate(b);
      const aTime = aDate ? new Date(aDate).getTime() : -Infinity;
      const bTime = bDate ? new Date(bDate).getTime() : -Infinity;
      return bTime - aTime;
    });
  }, [purchasesFetch.data]);
  const purchasesShowMore = useShowMore(purchases, 10, 10);

  const filteredSuppliers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter((s) => s.name.toLowerCase().includes(q) || s.email?.toLowerCase().includes(q));
  }, [suppliers, search]);

  async function handleCreateSupplier(input: { name: string; email?: string; leadTimeDays?: number }) {
    await createSupplier(input);
    suppliersFetch.refetch();
  }
  async function handleUpdateSupplier(input: { name: string; email?: string; leadTimeDays?: number }) {
    if (!editingSupplier) return;
    await updateSupplier(editingSupplier.id, input);
    suppliersFetch.refetch();
  }
  async function handleDeleteSupplier() {
    if (confirmingDeleteId === null) return;
    await deleteSupplier(confirmingDeleteId);
    suppliersFetch.refetch();
    setConfirmingDeleteId(null);
  }
  async function handleCreatePO(input: CreateIncomingInput) {
    await createIncoming(input);
    purchasesFetch.refetch();
  }
  async function handleConfirmTxAction() {
    if (!confirmingTxAction) return;
    if (confirmingTxAction.action === "complete") {
      await completeTransaction(confirmingTxAction.id);
    } else {
      await cancelTransaction(confirmingTxAction.id);
    }
    purchasesFetch.refetch();
    setConfirmingTxAction(null);
  }

  async function handleUploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const review = await uploadDocument(file);
      navigate(`/document-review/${review.id}`);
    } catch (err) {
      setUploadError(friendlyErrorMessage(err, "Upload failed."));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  if (suppliersFetch.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner label="Loading suppliers..." />
      </div>
    );
  }
  const pageError = suppliersFetch.error || productsFetch.error || warehousesFetch.error;
  if (pageError) {
    return (
      <ErrorMessage
        message={pageError}
        onRetry={() => {
          suppliersFetch.refetch();
          productsFetch.refetch();
          warehousesFetch.refetch();
        }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Top Suppliers + Supplier Performance */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))", gap: 14 }}>
        <div style={compactCardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 13.5 }}>Top Suppliers</div>
              <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 2 }}>Ranked for the selected product</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 170 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "5px 9px" }}>
                <SearchIcon className="h-[12px] w-[12px] flex-shrink-0 text-[var(--color-text-muted)]" />
                <input
                  value={rankProductSearch}
                  onChange={(e) => setRankProductSearch(e.target.value)}
                  placeholder="Search products..."
                  style={{ border: "none", outline: "none", background: "transparent", fontSize: 11.5, color: "var(--color-text)", width: "100%" }}
                />
              </div>
              <select value={rankProductId ?? ""} onChange={(e) => setRankProductId(Number(e.target.value))} style={{ ...inputStyle, padding: "6px 9px", fontSize: 12 }}>
                {rankProductOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          </div>

          {rankFetch.loading ? (
            <LoadingSpinner />
          ) : rankFetch.error ? (
            <ErrorMessage message={rankFetch.error} onRetry={rankFetch.refetch} />
          ) : (rankFetch.data ?? []).length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>No supplier has supplied this product yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              {(rankFetch.data ?? []).slice(0, 4).map((s) => (
                <div key={s.supplierId} style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "9px 11px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 20, height: 20, borderRadius: "50%", background: s.rank === 1 ? "rgba(244,196,48,0.2)" : "var(--color-surface)", color: s.rank === 1 ? "var(--color-warning)" : "var(--color-text-secondary)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800, fontFamily: "var(--font-heading)" }}>
                        {s.rank ?? "—"}
                      </div>
                      <span style={{ fontSize: 12.5, fontWeight: 600 }}>{s.supplierName}</span>
                    </div>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, color: s.score !== null ? scoreBarColor(s.score) : "var(--color-text-muted)" }}>
                      {s.score !== null ? `${Math.round(s.score)}/100` : "insufficient data"}
                    </span>
                  </div>
                  {s.score !== null && (
                    <div style={{ height: 4, background: "var(--color-border)", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ width: `${s.score}%`, height: "100%", background: scoreBarColor(s.score) }} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={compactCardStyle}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10, gap: 8 }}>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 13.5 }}>Supplier Performance</div>
            <select value={perfSupplierId ?? ""} onChange={(e) => setPerfSupplierId(Number(e.target.value))} style={{ ...inputStyle, padding: "6px 9px", fontSize: 12 }}>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          {statsFetch.loading ? (
            <LoadingSpinner />
          ) : statsFetch.error ? (
            <ErrorMessage message={statsFetch.error} onRetry={statsFetch.refetch} />
          ) : statsFetch.data ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
              {[
                { label: "On-Time Delivery", value: statsFetch.data.onTimeDeliveryRate != null ? `${Math.round(statsFetch.data.onTimeDeliveryRate * 100)}%` : "—" },
                { label: "Cancellation Rate", value: `${Math.round(statsFetch.data.cancellationRate * 100)}%` },
                { label: "Average Price", value: statsFetch.data.averagePrice != null ? `$${statsFetch.data.averagePrice.toFixed(2)}` : "—" },
                { label: "Purchase Frequency", value: `${statsFetch.data.purchaseFrequency.toFixed(1)}/mo` },
              ].map((st) => (
                <div key={st.label} style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "9px 11px" }}>
                  <div style={{ fontSize: 10, color: "var(--color-text-secondary)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 6 }}>{st.label}</div>
                  <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 18 }}>{st.value}</div>
                </div>
              ))}
            </div>
          ) : null}

          <div style={{ fontSize: 10.5, color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700, marginBottom: 6 }}>Recent Transactions</div>
          {historyFetch.loading ? (
            <LoadingSpinner />
          ) : !historyFetch.data || historyFetch.data.transactions.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--color-text-muted)" }}>No transactions with this supplier yet.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {historyFetch.data.transactions.slice(0, 4).map((t) => {
                const badge = transactionStatusBadge(t.status, t.expectedDate);
                return (
                  <div key={t.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--color-border)" }}>
                    <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--color-text-secondary)" }}>TXN-{t.id}</span>
                    <span style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>{new Date(t.createdAt).toLocaleDateString()}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4, background: badge.bg, color: badge.color }}>{badge.label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" onChange={handleUploadFile} style={{ display: "none" }} />
      {uploadError && <ErrorMessage message={uploadError} />}

      {/* Suppliers list */}
      <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 22px", borderBottom: "1px solid var(--color-border)", gap: 12, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Suppliers</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: "8px 12px", width: 220 }}>
              <SearchIcon className="h-[13px] w-[13px] flex-shrink-0 text-[var(--color-text-muted)]" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search suppliers..." style={{ border: "none", outline: "none", background: "transparent", fontSize: 12.5, color: "var(--color-text)", width: "100%" }} />
            </div>
          </div>
          {isAdmin && (
            <button type="button" onClick={() => setFormMode("create")} style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600, padding: "8px 14px", borderRadius: 7, background: "var(--color-accent)", color: "var(--color-on-accent)", border: "none", cursor: "pointer" }}>
              <PlusIcon className="h-[14px] w-[14px]" />
              Add Supplier
            </button>
          )}
        </div>
        {filteredSuppliers.length === 0 ? (
          <div style={{ padding: "36px 20px", textAlign: "center", fontSize: 12.5, color: "var(--color-text-muted)" }}>No suppliers match your search.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 600 }}>
              <thead>
                <tr style={{ background: "var(--color-surface-2)" }}>
                  {["Name", "Email", "Lead Time", "Status", "Actions"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredSuppliers.map((s) => (
                  <tr key={s.id}>
                    <td style={{ padding: "10px 16px", fontSize: 13, fontWeight: 500, borderTop: "1px solid var(--color-border)" }}>{s.name}</td>
                    <td style={{ padding: "10px 16px", fontSize: 13, color: "var(--color-text-secondary)", borderTop: "1px solid var(--color-border)" }}>{s.email ?? "—"}</td>
                    <td style={{ padding: "10px 16px", fontSize: 13, fontFamily: "var(--font-mono)", borderTop: "1px solid var(--color-border)" }}>{s.leadTimeDays != null ? `${s.leadTimeDays}d` : "—"}</td>
                    <td style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)" }}>
                      <span style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 9px", borderRadius: 4, background: s.isActive ? "rgba(34,197,94,0.14)" : "var(--color-surface-2)", color: s.isActive ? "var(--color-success)" : "var(--color-text-muted)" }}>
                        {s.isActive ? "Active" : "Inactive"}
                      </span>
                    </td>
                    <td style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)" }}>
                      {isAdmin && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button type="button" title="Edit" onClick={() => { setEditingSupplier(s); setFormMode("edit"); }} style={{ width: 26, height: 26, borderRadius: 6, background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                            <EditIcon className="h-[13px] w-[13px]" />
                          </button>
                          <button type="button" title="Delete" onClick={() => setConfirmingDeleteId(s.id)} style={{ width: 26, height: 26, borderRadius: 6, background: "var(--color-surface-2)", border: "1px solid rgba(239,68,68,0.35)", color: "var(--color-danger)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                            <TrashIcon className="h-[13px] w-[13px]" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Purchase & Arrival */}
      <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 22px", borderBottom: "1px solid var(--color-border)", gap: 12, flexWrap: "wrap" }}>
          <div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15 }}>Purchase & Arrival</div>
            <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 2 }}>Product → Supplier → Quantity → Arrival Info</div>
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
              onClick={() => setCreatingPO(true)}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12.5, fontWeight: 600, padding: "10px 16px", borderRadius: 8, background: "var(--color-accent)", color: "var(--color-on-accent)", border: "none", cursor: "pointer" }}
            >
              <PlusIcon className="h-[14px] w-[14px]" />
              Create Purchase Order
            </button>
          </div>
        </div>
        {purchasesFetch.loading ? (
          <div style={{ padding: 20 }}><LoadingSpinner /></div>
        ) : purchasesFetch.error ? (
          <div style={{ padding: 20 }}><ErrorMessage message={purchasesFetch.error} onRetry={purchasesFetch.refetch} /></div>
        ) : purchases.length === 0 ? (
          <div style={{ padding: "36px 20px", textAlign: "center", fontSize: 12.5, color: "var(--color-text-muted)" }}>No purchase orders yet.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 780 }}>
              <thead>
                <tr style={{ background: "var(--color-surface-2)" }}>
                  {["Order", "Supplier", "Warehouse", "Items", "Arrival Info", "Status", "Actions"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {purchasesShowMore.visible.map((tx) => {
                  const badge = transactionStatusBadge(tx.status, tx.expectedDate);
                  return (
                    <tr key={tx.id}>
                      <td style={{ padding: "10px 16px", fontSize: 12.5, fontFamily: "var(--font-mono)", borderTop: "1px solid var(--color-border)" }}>
                        {tx.documentKey ? (
                          <button
                            type="button"
                            title="View invoice"
                            onClick={() => setPreviewingInvoiceId(tx.id)}
                            style={{ padding: 0, border: "none", background: "none", font: "inherit", fontFamily: "var(--font-mono)", color: "var(--color-accent)", textDecoration: "underline", cursor: "pointer" }}
                          >
                            TXN-{tx.id}
                          </button>
                        ) : (
                          `TXN-${tx.id}`
                        )}
                      </td>
                      <td style={{ padding: "10px 16px", fontSize: 13, borderTop: "1px solid var(--color-border)" }}>
                        {tx.supplierId != null ? supplierNames.get(tx.supplierId) ?? `#${tx.supplierId}` : "—"}
                      </td>
                      <td style={{ padding: "10px 16px", fontSize: 13, color: "var(--color-text-secondary)", borderTop: "1px solid var(--color-border)" }}>
                        {tx.destinationWarehouseId ? warehouseNames.get(tx.destinationWarehouseId) ?? `#${tx.destinationWarehouseId}` : "—"}
                      </td>
                      <td style={{ padding: "10px 16px", fontSize: 13, fontFamily: "var(--font-mono)", borderTop: "1px solid var(--color-border)" }}>{tx.items.length}</td>
                      <td style={{ padding: "10px 16px", fontSize: 12.5, color: "var(--color-text-secondary)", borderTop: "1px solid var(--color-border)" }}>
                        {tx.status === "COMPLETED" && tx.actualDate
                          ? `Arrived ${new Date(tx.actualDate).toLocaleDateString()}`
                          : tx.expectedDate
                            ? `Expected ${new Date(tx.expectedDate).toLocaleDateString()}`
                            : "—"}
                      </td>
                      <td style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)" }}>
                        <span style={{ fontSize: 10.5, fontWeight: 700, padding: "3px 9px", borderRadius: 4, background: badge.bg, color: badge.color }}>{badge.label}</span>
                      </td>
                      <td style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)" }}>
                        {tx.status === "PENDING" && (
                          <div style={{ display: "flex", gap: 6 }}>
                            <button type="button" title="Complete" onClick={() => setConfirmingTxAction({ id: tx.id, action: "complete" })} style={{ width: 26, height: 26, borderRadius: 6, background: "rgba(34,197,94,0.12)", border: "1px solid var(--color-border)", color: "var(--color-success)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                              <CheckIcon className="h-[13px] w-[13px]" />
                            </button>
                            <button type="button" title="Cancel" onClick={() => setConfirmingTxAction({ id: tx.id, action: "cancel" })} style={{ width: 26, height: 26, borderRadius: 6, background: "rgba(239,68,68,0.1)", border: "1px solid var(--color-border)", color: "var(--color-danger)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
                              <XCircleIcon className="h-[13px] w-[13px]" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <ShowMoreRow colSpan={7} shown={purchasesShowMore.shown} total={purchasesShowMore.total} canShowLess={purchasesShowMore.canShowLess} onShowMore={purchasesShowMore.showMore} onShowLess={purchasesShowMore.showLess} />
              </tbody>
            </table>
          </div>
        )}
      </div>

      {formMode && (
        <SupplierFormModal
          supplier={formMode === "edit" ? editingSupplier : null}
          onClose={() => { setFormMode(null); setEditingSupplier(null); }}
          onSubmit={formMode === "edit" ? handleUpdateSupplier : handleCreateSupplier}
        />
      )}
      {confirmingDeleteId !== null && (
        <ConfirmDialog
          title="Delete Supplier"
          message="Delete this supplier? If it has related purchase history it will be deactivated instead of removed."
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmingDeleteId(null)}
          onConfirm={handleDeleteSupplier}
        />
      )}
      {confirmingTxAction && (
        <ConfirmDialog
          title={confirmingTxAction.action === "complete" ? "Complete Purchase" : "Cancel Purchase"}
          message={
            confirmingTxAction.action === "complete"
              ? "Mark this purchase as completed? This will add the received stock to inventory."
              : "Cancel this purchase? This cannot be undone."
          }
          confirmLabel={confirmingTxAction.action === "complete" ? "Complete" : "Cancel Purchase"}
          danger={confirmingTxAction.action === "cancel"}
          onCancel={() => setConfirmingTxAction(null)}
          onConfirm={handleConfirmTxAction}
        />
      )}
      {creatingPO && (
        <CreatePurchaseOrderModal
          suppliers={suppliers}
          warehouses={warehouses}
          products={products}
          onClose={() => setCreatingPO(false)}
          onSubmit={handleCreatePO}
        />
      )}
      {previewingInvoiceId !== null && (
        <InvoicePreviewModal transactionId={previewingInvoiceId} onClose={() => setPreviewingInvoiceId(null)} />
      )}
    </div>
  );
}
