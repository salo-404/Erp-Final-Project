import { useState, type FormEvent } from "react";
import { Modal } from "../ui/Modal";
import { ErrorMessage } from "../ui/ErrorMessage";
import type { Warehouse } from "../../types/domain";

interface WarehouseFormModalProps {
  warehouse: Warehouse | null; // null = create mode
  onClose: () => void;
  onSubmit: (input: { name: string; location?: string; maxCapacity?: number }) => Promise<void>;
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

export function WarehouseFormModal({ warehouse, onClose, onSubmit }: WarehouseFormModalProps) {
  const [name, setName] = useState(warehouse?.name ?? "");
  const [location, setLocation] = useState(warehouse?.location ?? "");
  const [maxCapacity, setMaxCapacity] = useState(warehouse?.maxCapacity?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        name: name.trim(),
        location: location.trim() || undefined,
        maxCapacity: maxCapacity.trim() ? Number(maxCapacity) : undefined,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save warehouse.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={warehouse ? "Edit Warehouse" : "Create Warehouse"} onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>
            Name
          </label>
          <input required value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>
            Location
          </label>
          <input value={location} onChange={(e) => setLocation(e.target.value)} style={inputStyle} />
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>
            Max capacity (units, optional)
          </label>
          <input
            type="number"
            min={0}
            value={maxCapacity}
            onChange={(e) => setMaxCapacity(e.target.value)}
            style={inputStyle}
          />
        </div>

        {error && <ErrorMessage message={error} />}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 6 }}>
          <button
            type="button"
            onClick={onClose}
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
            type="submit"
            disabled={submitting}
            style={{
              padding: "9px 16px",
              borderRadius: 7,
              border: "none",
              background: "var(--color-accent)",
              color: "#FFFFFF",
              fontSize: 13,
              fontWeight: 600,
              cursor: submitting ? "default" : "pointer",
              opacity: submitting ? 0.7 : 1,
            }}
          >
            {submitting ? "Saving..." : warehouse ? "Save changes" : "Create warehouse"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
