import { useState } from "react";
import { Modal } from "./Modal";
import { ErrorMessage } from "./ErrorMessage";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}

export function ConfirmDialog({ title, message, confirmLabel = "Confirm", danger, onCancel, onConfirm }: ConfirmDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleConfirm() {
    setError(null);
    setSubmitting(true);
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
      setSubmitting(false);
    }
  }

  return (
    <Modal title={title} onClose={onCancel}>
      <p style={{ fontSize: 13.5, color: "var(--color-text-secondary)", marginBottom: 16 }}>{message}</p>
      {error && (
        <div style={{ marginBottom: 12 }}>
          <ErrorMessage message={error} />
        </div>
      )}
      <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            padding: "9px 16px",
            borderRadius: 7,
            border: "1px solid var(--color-border)",
            background: "transparent",
            color: "var(--color-text-secondary)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={submitting}
          style={{
            padding: "9px 16px",
            borderRadius: 7,
            border: "none",
            background: danger ? "var(--color-danger)" : "var(--color-accent)",
            color: danger ? "#FFFFFF" : "var(--color-on-accent)",
            fontSize: 13,
            fontWeight: 600,
            cursor: submitting ? "default" : "pointer",
            opacity: submitting ? 0.7 : 1,
          }}
        >
          {submitting ? "Working..." : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
