import { useState, type FormEvent } from "react";
import { Modal } from "../ui/Modal";
import { ErrorMessage } from "../ui/ErrorMessage";
import { friendlyErrorMessage } from "../../lib/friendlyError";
import type { Supplier } from "../../types/domain";

interface SupplierFormModalProps {
  supplier: Supplier | null; // null = create mode
  onClose: () => void;
  onSubmit: (input: { name: string; email?: string; leadTimeDays?: number }) => Promise<void>;
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

export function SupplierFormModal({ supplier, onClose, onSubmit }: SupplierFormModalProps) {
  const [name, setName] = useState(supplier?.name ?? "");
  const [email, setEmail] = useState(supplier?.email ?? "");
  const [leadTimeDays, setLeadTimeDays] = useState(supplier?.leadTimeDays?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        email: email.trim() || undefined,
        leadTimeDays: leadTimeDays.trim() ? Number(leadTimeDays) : undefined,
      });
      onClose();
    } catch (err) {
      setError(friendlyErrorMessage(err, "Failed to save supplier."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={supplier ? "Edit Supplier" : "Add Supplier"} onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>
            Name
          </label>
          <input required value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>
            Email
          </label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} style={inputStyle} />
        </div>
        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>
            Lead time (days)
          </label>
          <input
            type="number"
            min={0}
            value={leadTimeDays}
            onChange={(e) => setLeadTimeDays(e.target.value)}
            style={inputStyle}
          />
        </div>

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
            {submitting ? "Saving..." : supplier ? "Save changes" : "Add supplier"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
