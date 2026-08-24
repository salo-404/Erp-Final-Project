import { useFetch } from "../../lib/useFetch";
import { getTransactionDocumentPresignedUrl } from "../../lib/inventoryTransactions.api";
import { DocumentPreviewPane } from "../documentReview/DocumentPreviewPane";
import { CloseIcon } from "../ui/icons";

interface InvoicePreviewModalProps {
  transactionId: number;
  onClose: () => void;
}

export function InvoicePreviewModal({ transactionId, onClose }: InvoicePreviewModalProps) {
  const presignedFetch = useFetch(() => getTransactionDocumentPresignedUrl(transactionId), [transactionId]);
  const url = presignedFetch.data?.url ?? null;

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          borderRadius: 12,
          width: "100%",
          maxWidth: 760,
          height: "calc(100vh - 64px)",
          maxHeight: 820,
          margin: 16,
          boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid var(--color-border)", flexShrink: 0 }}>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 16 }}>Invoice — TXN-{transactionId}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-accent)", textDecoration: "none" }}
              >
                Open in new tab
              </a>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              style={{ background: "transparent", border: "none", color: "var(--color-text-muted)", cursor: "pointer", display: "flex" }}
            >
              <CloseIcon className="h-[18px] w-[18px]" />
            </button>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, padding: 16 }}>
          <DocumentPreviewPane
            url={url}
            loading={presignedFetch.loading}
            error={presignedFetch.error}
            onRetry={presignedFetch.refetch}
          />
        </div>
      </div>
    </div>
  );
}
