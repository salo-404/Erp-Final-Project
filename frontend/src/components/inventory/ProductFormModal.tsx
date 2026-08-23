import { useState, type FormEvent } from "react";
import { Modal } from "../ui/Modal";
import { ErrorMessage } from "../ui/ErrorMessage";
import type { Product } from "../../types/domain";

interface ProductFormModalProps {
  product: Product | null; // null = create mode
  onClose: () => void;
  onSubmit: (input: { name: string; category?: string; description?: string }) => Promise<void>;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 7,
  padding: "10px 12px",
  fontSize: 13.5,
  color: "var(--color-text)",
  fontFamily: "var(--font-body)",
  outline: "none",
};

export function ProductFormModal({ product, onClose, onSubmit }: ProductFormModalProps) {
  const [name, setName] = useState(product?.name ?? "");
  const [category, setCategory] = useState(product?.category ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        category: category.trim() || undefined,
        description: description.trim() || undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save product.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={product ? "Edit Product" : "Add Product"} onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>
            Name
          </label>
          <input required value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>
            Category
          </label>
          <input value={category} onChange={(e) => setCategory(e.target.value)} style={inputStyle} />
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </div>

        {!product && (
          <p style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>
            New products won't show a row in this warehouse's table until stock actually moves for them here.
          </p>
        )}

        {error && <ErrorMessage message={error} />}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 6 }}>
          <button
            type="button"
            onClick={onClose}
            style={{ padding: "9px 16px", borderRadius: 7, border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-text-secondary)", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            style={{ padding: "9px 16px", borderRadius: 7, border: "none", background: "var(--color-accent)", color: "var(--color-on-accent)", fontSize: 13, fontWeight: 600, cursor: submitting ? "default" : "pointer", opacity: submitting ? 0.7 : 1 }}
          >
            {submitting ? "Saving..." : product ? "Save changes" : "Add product"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
