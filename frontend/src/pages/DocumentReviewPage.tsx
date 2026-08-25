import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { useFetch } from "../lib/useFetch";
import {
  approveReview,
  getReview,
  getReviewPresignedUrl,
  listPendingReviews,
  rejectReview,
  resolveProduct,
  resolveSupplier,
} from "../lib/documentReview.api";
import { listWarehouses } from "../lib/warehouses.api";
import { listProducts } from "../lib/products.api";
import { DocumentPreviewPane } from "../components/documentReview/DocumentPreviewPane";
import { ResolveSearchInput } from "../components/documentReview/ResolveSearchInput";
import { NewProductInput } from "../components/documentReview/NewProductInput";
import { SampleDocumentsPanel } from "../components/documentReview/SampleDocumentsPanel";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import { ErrorMessage } from "../components/ui/ErrorMessage";
import { Modal } from "../components/ui/Modal";
import type { ApproveDocumentReviewInput, Product, Warehouse } from "../types/domain";

interface ItemRow {
  extractedName: string;
  productId: number | null;
  resolvedName: string | null;
  quantity: string;
  price: string;
  isNewProduct: boolean;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 7,
  padding: "9px 10px",
  fontSize: 13,
  color: "var(--color-text)",
  outline: "none",
};
const labelStyle: React.CSSProperties = { fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" };
const fieldLabelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: 4, display: "block" };

export function DocumentReviewPage() {
  const { id: idParam } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const pendingFetch = useFetch(() => listPendingReviews(), []);
  const warehousesFetch = useFetch<Warehouse[]>(() => listWarehouses(), []);
  const productsFetch = useFetch<Product[]>(() => listProducts(), []);
  const warehouses = useMemo(() => warehousesFetch.data ?? [], [warehousesFetch.data]);
  const pending = useMemo(() => pendingFetch.data ?? [], [pendingFetch.data]);
  const existingCategories = useMemo(() => {
    const set = new Set<string>();
    for (const p of productsFetch.data ?? []) {
      const trimmed = p.category?.trim();
      if (trimmed) set.add(trimmed);
    }
    return [...set].sort();
  }, [productsFetch.data]);

  const urlId = idParam ? Number(idParam) : null;

  useEffect(() => {
    if (urlId === null && !pendingFetch.loading && pending.length > 0) {
      navigate(`/document-review/${pending[0].id}`, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlId, pendingFetch.loading, pending.length]);

  const reviewFetch = useFetch(
    () => (urlId !== null ? getReview(urlId) : Promise.resolve(null)),
    [urlId],
  );
  const presignedFetch = useFetch(
    () => (urlId !== null ? getReviewPresignedUrl(urlId) : Promise.resolve(null)),
    [urlId],
  );

  const [items, setItems] = useState<ItemRow[]>([]);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [supplierResolvedName, setSupplierResolvedName] = useState<string | null>(null);
  const [partyName, setPartyName] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [expectedDate, setExpectedDate] = useState("");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const review = reviewFetch.data;
    if (!review) return;
    setItems(
      review.extractedItems.map((it) => ({
        extractedName: it.product,
        productId: null,
        resolvedName: null,
        quantity: String(it.quantity),
        price: it.price != null ? String(it.price) : "",
        isNewProduct: false,
      })),
    );
    setSupplierId(null);
    setSupplierResolvedName(null);
    setPartyName(review.extractedPartyName ?? "");
    setExpectedDate(review.extractedDate ? review.extractedDate.slice(0, 10) : "");
    setRejecting(false);
    setRejectReason("");
    setDecisionError(null);
    const match = review.extractedWarehouseName
      ? warehouses.find((w) => w.name.toLowerCase().includes(review.extractedWarehouseName!.toLowerCase()))
      : undefined;
    setWarehouseId(match ? String(match.id) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewFetch.data]);

  function updateItem(index: number, patch: Partial<ItemRow>) {
    setItems((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  // Catalog names plus anything already resolved/created for another line
  // item in this same review, so the "new product" flow can't create the
  // same product twice - once for this document, once again for a
  // duplicate/near-duplicate extracted line.
  const existingProductNames = useMemo(() => {
    const names = (productsFetch.data ?? []).map((p) => p.name);
    for (const it of items) {
      if (it.resolvedName) names.push(it.resolvedName);
    }
    return names;
  }, [productsFetch.data, items]);

  const itemsTotal = useMemo(
    () =>
      items.reduce((sum, it) => {
        const quantity = Number(it.quantity);
        const price = Number(it.price);
        if (!Number.isFinite(quantity) || !Number.isFinite(price)) return sum;
        return sum + quantity * price;
      }, 0),
    [items],
  );

  async function handleApprove() {
    if (urlId === null || !reviewFetch.data) return;
    setDecisionError(null);

    if (items.some((it) => it.productId === null)) {
      setDecisionError("Resolve every line item to a real product before approving.");
      return;
    }
    if (reviewFetch.data.transactionType === "INCOMING" && (supplierId === null || !warehouseId)) {
      setDecisionError("Resolve the supplier and select a destination warehouse.");
      return;
    }
    if (reviewFetch.data.transactionType === "OUTGOING" && !warehouseId) {
      setDecisionError("Select a source warehouse.");
      return;
    }

    setSubmitting(true);
    try {
      const base = {
        items: items.map((it) => ({
          productId: it.productId!,
          quantity: Number(it.quantity),
          price: it.price ? Number(it.price) : undefined,
        })),
        expectedDate: expectedDate || undefined,
      };
      const input: ApproveDocumentReviewInput =
        reviewFetch.data.transactionType === "INCOMING"
          ? { ...base, supplierId: supplierId!, destinationWarehouseId: Number(warehouseId) }
          : { ...base, sourceWarehouseId: Number(warehouseId), partyName: partyName || undefined };

      await approveReview(urlId, input);
      pendingFetch.refetch();
      reviewFetch.refetch();
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : "Failed to approve.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReject() {
    if (urlId === null) return;
    if (!rejectReason.trim()) {
      setDecisionError("Enter a rejection reason.");
      return;
    }
    setSubmitting(true);
    try {
      await rejectReview(urlId, rejectReason.trim());
      pendingFetch.refetch();
      reviewFetch.refetch();
      setRejecting(false);
    } catch (err) {
      setDecisionError(err instanceof Error ? err.message : "Failed to reject.");
    } finally {
      setSubmitting(false);
    }
  }

  if ((pendingFetch.loading || warehousesFetch.loading) && urlId === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner label="Loading document reviews..." />
      </div>
    );
  }

  const listPageError = pendingFetch.error || warehousesFetch.error;
  if (urlId === null && listPageError) {
    return (
      <ErrorMessage
        message={listPageError}
        onRetry={() => {
          pendingFetch.refetch();
          warehousesFetch.refetch();
        }}
      />
    );
  }

  if (urlId === null && !pendingFetch.loading && pending.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="font-[var(--font-heading)] text-lg font-semibold">No pending reviews</p>
        <p className="text-sm text-[var(--color-text-muted)]">
          Upload an invoice from the Suppliers page, or attach one to a completed customer order, to see it here.
        </p>
      </div>
    );
  }

  const review = reviewFetch.data;
  const isDecided = review && review.status !== "PENDING_REVIEW";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, height: "100%" }}>
      <SampleDocumentsPanel
        onUploaded={(reviewId) => {
          pendingFetch.refetch();
          navigate(`/document-review/${reviewId}`);
        }}
      />

      {pending.length > 0 && (
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 2 }}>
          {pending.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => navigate(`/document-review/${p.id}`)}
              style={{
                flexShrink: 0,
                fontSize: 12,
                fontWeight: 600,
                padding: "8px 14px",
                borderRadius: 8,
                border: "1px solid var(--color-border)",
                background: p.id === urlId ? "var(--color-accent)" : "var(--color-surface)",
                color: p.id === urlId ? "var(--color-on-accent)" : "var(--color-text-secondary)",
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              #{p.id} · {p.transactionType} · {new Date(p.createdAt).toLocaleDateString()}
            </button>
          ))}
        </div>
      )}

      {reviewFetch.loading || presignedFetch.loading ? (
        <div className="flex flex-1 items-center justify-center">
          <LoadingSpinner label="Loading review..." />
        </div>
      ) : reviewFetch.error || !review ? (
        <ErrorMessage message={reviewFetch.error ?? "Failed to load review."} onRetry={reviewFetch.refetch} />
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(380px, 1fr))", gap: 18, flex: 1, minHeight: 0 }}>
          <DocumentPreviewPane
            url={presignedFetch.data?.url ?? null}
            loading={presignedFetch.loading}
            error={presignedFetch.error}
            onRetry={presignedFetch.refetch}
          />

          <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 22, overflowY: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18, gap: 10 }}>
              <div>
                <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 17 }}>ERP Invoice Review</div>
                <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 3 }}>
                  #{review.id} · {review.transactionType} · uploaded {new Date(review.createdAt).toLocaleDateString()}
                </div>
              </div>
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  padding: "4px 10px",
                  borderRadius: 5,
                  background:
                    review.status === "APPROVED" ? "rgba(34,197,94,0.14)" : review.status === "REJECTED" ? "rgba(239,68,68,0.14)" : "rgba(244,196,48,0.16)",
                  color: review.status === "APPROVED" ? "var(--color-success)" : review.status === "REJECTED" ? "var(--color-danger)" : "var(--color-warning)",
                }}
              >
                {review.status.replace("_", " ")}
              </span>
            </div>

            {isDecided ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
                {review.reviewedBy && (
                  <p>
                    Reviewed by <strong>{review.reviewedBy.name}</strong>
                    {review.reviewedAt && ` on ${new Date(review.reviewedAt).toLocaleString()}`}.
                  </p>
                )}
                {review.status === "REJECTED" && review.rejectionReason && (
                  <ErrorMessage message={`Rejection reason: ${review.rejectionReason}`} />
                )}
                {review.status === "APPROVED" && review.transaction && (
                  <p>
                    Synced to{" "}
                    <button
                      type="button"
                      onClick={() => navigate(review.transaction!.type === "OUTGOING" ? "/orders" : "/suppliers")}
                      style={{ color: "var(--color-accent)", background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 13, textDecoration: "underline" }}
                    >
                      TXN-{review.transaction.id}
                    </button>
                    .
                  </p>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                {review.transactionType === "INCOMING" ? (
                  <div>
                    <label style={labelStyle}>Supplier</label>
                    <ResolveSearchInput
                      initialQuery={review.extractedSupplierName ?? ""}
                      search={resolveSupplier}
                      resolvedLabel={supplierResolvedName}
                      placeholder="Search suppliers..."
                      onResolve={(s) => {
                        setSupplierId(s.supplierId!);
                        setSupplierResolvedName(s.name);
                      }}
                    />
                  </div>
                ) : (
                  <div>
                    <label style={labelStyle}>Customer name</label>
                    <input value={partyName} onChange={(e) => setPartyName(e.target.value)} style={inputStyle} />
                  </div>
                )}

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  <div>
                    <label style={labelStyle}>{review.transactionType === "INCOMING" ? "Destination warehouse" : "Source warehouse"}</label>
                    <select value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)} style={inputStyle}>
                      <option value="">Select...</option>
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>{w.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Date</label>
                    <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} style={inputStyle} />
                  </div>
                </div>

                <div>
                  <label style={{ ...labelStyle, marginBottom: 10 }}>Line items</label>
                  <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                    {items.map((row, i) => (
                      <div key={i} style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 8, padding: 12 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Extracted: "{row.extractedName}"</div>

                        {review.transactionType === "INCOMING" && (
                          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--color-text-secondary)", marginBottom: 8, cursor: "pointer" }}>
                            <input
                              type="checkbox"
                              checked={row.isNewProduct}
                              onChange={(e) => updateItem(i, { isNewProduct: e.target.checked, productId: null, resolvedName: null })}
                            />
                            This is a new product — not yet in the system
                          </label>
                        )}

                        {row.isNewProduct ? (
                          <NewProductInput
                            initialName={row.extractedName}
                            categories={existingCategories}
                            existingNames={existingProductNames}
                            onCreated={({ productId, name }) => updateItem(i, { productId, resolvedName: name })}
                          />
                        ) : (
                          <ResolveSearchInput
                            initialQuery={row.extractedName}
                            search={resolveProduct}
                            resolvedLabel={row.resolvedName}
                            placeholder="Search products..."
                            onResolve={(s) => updateItem(i, { productId: s.productId!, resolvedName: s.name })}
                          />
                        )}

                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                          <div>
                            {review.transactionType === "INCOMING" && <label style={fieldLabelStyle}>Quantity</label>}
                            <input type="number" min={1} placeholder="Quantity" value={row.quantity} onChange={(e) => updateItem(i, { quantity: e.target.value })} style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }} />
                          </div>
                          <div>
                            {review.transactionType === "INCOMING" && <label style={fieldLabelStyle}>Price</label>}
                            <input type="number" min={0} step="0.01" placeholder="Price" value={row.price} onChange={(e) => updateItem(i, { price: e.target.value })} style={{ ...inputStyle, padding: "7px 9px", fontSize: 12.5 }} />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--color-border)" }}>
                    <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-text-secondary)" }}>Total</span>
                    <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 15 }}>
                      ${itemsTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>

                {!isAdmin ? (
                  <p style={{ fontSize: 12, color: "var(--color-text-muted)", borderTop: "1px solid var(--color-border)", paddingTop: 16 }}>
                    Only an admin can approve or reject a review — you can still resolve items above to help prepare it.
                  </p>
                ) : rejecting ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <label style={labelStyle}>Rejection reason</label>
                    <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} style={inputStyle} autoFocus />
                    <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                      <button type="button" onClick={() => setRejecting(false)} style={{ padding: "9px 16px", borderRadius: 7, border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
                        Back
                      </button>
                      <button type="button" onClick={handleReject} disabled={submitting} style={{ padding: "9px 16px", borderRadius: 7, border: "none", background: "var(--color-danger)", color: "#FFFFFF", fontSize: 13, fontWeight: 600, cursor: submitting ? "default" : "pointer", opacity: submitting ? 0.7 : 1 }}>
                        {submitting ? "Rejecting..." : "Confirm reject"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, borderTop: "1px solid var(--color-border)", paddingTop: 16 }}>
                    <button type="button" onClick={() => setRejecting(true)} style={{ padding: "10px 18px", borderRadius: 8, border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-danger)", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
                      Reject
                    </button>
                    <button type="button" onClick={handleApprove} disabled={submitting} style={{ padding: "10px 20px", borderRadius: 8, border: "none", background: "var(--color-accent)", color: "var(--color-on-accent)", fontSize: 12.5, fontWeight: 600, cursor: submitting ? "default" : "pointer", opacity: submitting ? 0.7 : 1 }}>
                      {submitting ? "Syncing..." : "Approve & Sync"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {decisionError && (
        <Modal title="Couldn't complete this action" onClose={() => setDecisionError(null)}>
          <ErrorMessage message={decisionError} />
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
            <button
              type="button"
              onClick={() => setDecisionError(null)}
              style={{ padding: "9px 16px", borderRadius: 7, border: "none", background: "var(--color-accent)", color: "var(--color-on-accent)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
            >
              OK
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
