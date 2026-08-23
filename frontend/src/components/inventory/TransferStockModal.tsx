import { useState, type FormEvent } from "react";
import { Modal } from "../ui/Modal";
import { ErrorMessage } from "../ui/ErrorMessage";
import type { CreateTransferInput, Warehouse } from "../../types/domain";

interface TransferStockModalProps {
  productName: string;
  productId: number;
  sourceWarehouse: Warehouse;
  destinationWarehouses: Warehouse[];
  available: number;
  /** Prefills the quantity field (e.g. from a Control Tower transfer recommendation) — still editable, never auto-submitted. */
  initialQuantity?: number;
  onClose: () => void;
  onSubmit: (input: CreateTransferInput) => Promise<void>;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--color-surface-2)",
  border: "1px solid var(--color-border)",
  borderRadius: 7,
  padding: "9px 10px",
  fontSize: 13,
  color: "var(--color-text)",
  fontFamily: "var(--font-body)",
  outline: "none",
};

export function TransferStockModal({
  productName,
  productId,
  sourceWarehouse,
  destinationWarehouses,
  available,
  initialQuantity,
  onClose,
  onSubmit,
}: TransferStockModalProps) {
  const [destinationWarehouseId, setDestinationWarehouseId] = useState(destinationWarehouses[0]?.id.toString() ?? "");
  const [quantity, setQuantity] = useState(initialQuantity ? String(initialQuantity) : "");
  const [expectedDate, setExpectedDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const qty = Number(quantity);
    if (!qty || qty <= 0) {
      setError("Enter a quantity greater than zero.");
      return;
    }
    if (qty > available) {
      setError(`Only ${available} unit(s) available at ${sourceWarehouse.name}.`);
      return;
    }
    if (!destinationWarehouseId) {
      setError("Select a destination warehouse.");
      return;
    }

    setSubmitting(true);
    try {
      await onSubmit({
        sourceWarehouseId: sourceWarehouse.id,
        destinationWarehouseId: Number(destinationWarehouseId),
        expectedDate: expectedDate || undefined,
        items: [{ productId, quantity: qty }],
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create transfer.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Transfer Stock" onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{productName}</div>
          <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 2 }}>
            {available} available at {sourceWarehouse.name}
          </div>
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>Destination warehouse</label>
          {destinationWarehouses.length === 0 ? (
            <p style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>No other warehouses exist to transfer to.</p>
          ) : (
            <select required value={destinationWarehouseId} onChange={(e) => setDestinationWarehouseId(e.target.value)} style={inputStyle}>
              {destinationWarehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>Quantity</label>
          <input
            type="number"
            min={1}
            max={available}
            placeholder="Qty"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            style={inputStyle}
          />
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>Expected date (optional)</label>
          <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} style={inputStyle} />
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
            disabled={submitting || destinationWarehouses.length === 0}
            style={{ padding: "9px 16px", borderRadius: 7, border: "none", background: "var(--color-accent)", color: "var(--color-on-accent)", fontSize: 13, fontWeight: 600, cursor: submitting ? "default" : "pointer", opacity: submitting ? 0.7 : 1 }}
          >
            {submitting ? "Creating..." : "Create transfer"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
