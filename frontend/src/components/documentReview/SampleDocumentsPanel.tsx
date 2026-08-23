import { useEffect, useState } from "react";
import { uploadDocument } from "../../lib/documentReview.api";
import { UploadIcon } from "../ui/icons";
import { ErrorMessage } from "../ui/ErrorMessage";

interface SampleManifestEntry {
  file: string;
  label: string;
}

interface SampleDocumentsPanelProps {
  onUploaded: (reviewId: number) => void;
}

/**
 * Lets you pick from a short list of ready-made sample documents
 * (frontend/public/sample-documents/) instead of using the OS file picker
 * every time. Each pick still goes through the real upload endpoint
 * (uploadDocument -> POST /document-review/upload) — nothing about the
 * resulting review is faked beyond whatever the extraction provider itself
 * does for any upload, sample or not.
 */
export function SampleDocumentsPanel({ onUploaded }: SampleDocumentsPanelProps) {
  const [samples, setSamples] = useState<SampleManifestEntry[]>([]);
  const [selected, setSelected] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/sample-documents/manifest.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: SampleManifestEntry[]) => {
        setSamples(list);
        if (list.length > 0) setSelected(list[0].file);
      })
      .catch(() => setSamples([]));
  }, []);

  async function handleUse() {
    if (!selected) return;
    setError(null);
    setUploading(true);
    try {
      const fileResponse = await fetch(`/sample-documents/${selected}`);
      if (!fileResponse.ok) throw new Error(`Could not load sample file ${selected}`);
      const blob = await fileResponse.blob();
      const file = new File([blob], selected, { type: "application/pdf" });
      const review = await uploadDocument(file);
      onUploaded(review.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload sample document.");
    } finally {
      setUploading(false);
    }
  }

  if (samples.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        background: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        borderRadius: 10,
        padding: "10px 14px",
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-text-secondary)" }}>Sample document:</span>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 6, padding: "6px 9px", fontSize: 12.5, color: "var(--color-text)" }}
      >
        {samples.map((s) => (
          <option key={s.file} value={s.file}>{s.label}</option>
        ))}
      </select>
      <button
        type="button"
        onClick={handleUse}
        disabled={uploading}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, padding: "7px 12px", borderRadius: 6, background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text)", cursor: uploading ? "default" : "pointer", opacity: uploading ? 0.7 : 1 }}
      >
        <UploadIcon className="h-3 w-3" />
        {uploading ? "Uploading..." : "Use sample"}
      </button>
      {error && <ErrorMessage message={error} />}
    </div>
  );
}
