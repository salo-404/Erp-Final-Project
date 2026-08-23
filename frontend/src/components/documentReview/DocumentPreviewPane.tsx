import { LoadingSpinner } from "../ui/LoadingSpinner";
import { ErrorMessage } from "../ui/ErrorMessage";

interface DocumentPreviewPaneProps {
  url: string | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}

// PendingDocumentReview doesn't store a mime type — inferred from the
// presigned URL's file extension (the URL path before the query string).
function isPdf(url: string): boolean {
  return url.split("?")[0].toLowerCase().endsWith(".pdf");
}

export function DocumentPreviewPane({ url, loading, error, onRetry }: DocumentPreviewPaneProps) {
  return (
    <div style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, overflow: "hidden", height: "100%", minHeight: 480, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--color-border)", fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 14 }}>
        Document Preview
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--color-surface-2)", padding: loading || error ? 20 : 0 }}>
        {loading ? (
          <LoadingSpinner label="Loading document..." />
        ) : error ? (
          <ErrorMessage message={error} onRetry={onRetry} />
        ) : !url ? (
          <p style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>No document to preview.</p>
        ) : isPdf(url) ? (
          <embed src={url} type="application/pdf" style={{ width: "100%", height: "100%", minHeight: 480, border: "none" }} />
        ) : (
          <img src={url} alt="Uploaded document" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        )}
      </div>
    </div>
  );
}
