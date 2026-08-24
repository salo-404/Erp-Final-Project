import { useEffect, useState, type FormEvent } from "react";
import { Modal } from "../ui/Modal";
import { ErrorMessage } from "../ui/ErrorMessage";
import { PlusIcon, TrashIcon } from "../ui/icons";
import { ApiError } from "../../lib/api-client";
import { getProductAvailability } from "../../lib/warehouses.api";
import type { CreateOutgoingInput, Product, Warehouse } from "../../types/domain";

interface ItemRow {
  productId: string;
  quantity: string;
  price: string;
}

interface AvailabilityState {
  status: "idle" | "loading" | "ready" | "error";
  available: number | null;
}

const IDLE_AVAILABILITY: AvailabilityState = { status: "idle", available: null };

interface CreateCustomerOrderModalProps {
  warehouses: Warehouse[];
  products: Product[];
  onClose: () => void;
  onSubmit: (input: CreateOutgoingInput) => Promise<void>;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 7,
  padding: "9px 10px",
  fontSize: 13,
  color: "var(--color-text)",
  fontFamily: "var(--font-body)",
  outline: "none",
};

export function CreateCustomerOrderModal({ warehouses, products, onClose, onSubmit }: CreateCustomerOrderModalProps) {
  const [partyName, setPartyName] = useState("");
  const [sourceWarehouseId, setSourceWarehouseId] = useState(warehouses[0]?.id.toString() ?? "");
  const [expectedDate, setExpectedDate] = useState("");
  const [items, setItems] = useState<ItemRow[]>([{ productId: products[0]?.id.toString() ?? "", quantity: "", price: "" }]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function updateItem(index: number, patch: Partial<ItemRow>) {
    setItems((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const parsedItems = items
        .filter((r) => r.productId && r.quantity)
        .map((r) => ({ productId: Number(r.productId), quantity: Number(r.quantity), price: r.price ? Number(r.price) : undefined }));
      if (parsedItems.length === 0) {
        throw new Error("Add at least one item with a quantity.");
      }
      await onSubmit({
        sourceWarehouseId: Number(sourceWarehouseId),
        partyName: partyName.trim() || undefined,
        expectedDate: expectedDate || undefined,
        items: parsedItems,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create customer order.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title="Create Customer Order" onClose={onClose}>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>Customer name</label>
            <input value={partyName} onChange={(e) => setPartyName(e.target.value)} placeholder="Optional" style={inputStyle} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>Warehouse</label>
            <select required value={sourceWarehouseId} onChange={(e) => setSourceWarehouseId(e.target.value)} style={inputStyle}>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6, display: "block" }}>Expected delivery date (optional)</label>
          <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} style={inputStyle} />
        </div>

        <div>
          <label style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 8, display: "block" }}>Items</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((row, i) => (
              <OrderItemRow
                key={i}
                row={row}
                products={products}
                warehouseId={sourceWarehouseId ? Number(sourceWarehouseId) : null}
                onChange={(patch) => updateItem(i, patch)}
                onRemove={() => setItems((rows) => rows.filter((_, idx) => idx !== i))}
                removeDisabled={items.length === 1}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setItems((rows) => [...rows, { productId: products[0]?.id.toString() ?? "", quantity: "", price: "" }])}
            style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, fontSize: 12, fontWeight: 600, color: "var(--color-accent)", background: "transparent", border: "none", cursor: "pointer" }}
          >
            <PlusIcon className="h-3 w-3" />
            Add item
          </button>
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
            {submitting ? "Creating..." : "Create order"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface OrderItemRowProps {
  row: ItemRow;
  products: Product[];
  warehouseId: number | null;
  onChange: (patch: Partial<ItemRow>) => void;
  onRemove: () => void;
  removeDisabled: boolean;
}

// Live "Available: N units" hint per line — purely informational (the
// backend's reserve() call remains the sole authority on whether an order
// actually goes through, see handleSubmit's 409 fallback). Refetches
// whenever the row's product or the order's warehouse changes.
function OrderItemRow({ row, products, warehouseId, onChange, onRemove, removeDisabled }: OrderItemRowProps) {
  const productId = row.productId ? Number(row.productId) : null;
  const [availability, setAvailability] = useState<AvailabilityState>(IDLE_AVAILABILITY);

  useEffect(() => {
    if (!productId || !warehouseId) {
      setAvailability(IDLE_AVAILABILITY);
      return;
    }
    let cancelled = false;
    setAvailability({ status: "loading", available: null });
    getProductAvailability(warehouseId, productId)
      .then((res) => {
        if (!cancelled) setAvailability({ status: "ready", available: res.available });
      })
      .catch((err) => {
        if (cancelled) return;
        // No WarehouseInventory row for this product/warehouse pair means
        // it's never been stocked there — that's genuinely zero available,
        // not a failed lookup.
        if (err instanceof ApiError && err.statusCode === 404) {
          setAvailability({ status: "ready", available: 0 });
        } else {
          setAvailability({ status: "error", available: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [productId, warehouseId]);

  const requestedQuantity = row.quantity ? Number(row.quantity) : null;
  const isInsufficient =
    availability.status === "ready" &&
    availability.available !== null &&
    requestedQuantity !== null &&
    requestedQuantity > availability.available;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1.6fr 0.7fr 0.8fr auto", gap: 8, alignItems: "center" }}>
        <select value={row.productId} onChange={(e) => onChange({ productId: e.target.value })} style={inputStyle}>
          {products.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <input type="number" min={1} placeholder="Qty" value={row.quantity} onChange={(e) => onChange({ quantity: e.target.value })} style={inputStyle} />
        <input type="number" min={0} step="0.01" placeholder="Price (optional)" value={row.price} onChange={(e) => onChange({ price: e.target.value })} style={inputStyle} />
        <button
          type="button"
          onClick={onRemove}
          disabled={removeDisabled}
          style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid var(--color-border)", background: "transparent", color: "var(--color-danger)", cursor: removeDisabled ? "default" : "pointer", opacity: removeDisabled ? 0.4 : 1, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <TrashIcon className="h-[13px] w-[13px]" />
        </button>
      </div>
      {productId && warehouseId && availability.status !== "idle" && (
        <div style={{ fontSize: 11.5, marginTop: 4, paddingLeft: 2, color: isInsufficient ? "var(--color-danger)" : "var(--color-text-muted)", fontWeight: isInsufficient ? 600 : 400 }}>
          {availability.status === "loading" && "Checking availability..."}
          {availability.status === "error" && "Could not check availability."}
          {availability.status === "ready" && !isInsufficient && `Available: ${availability.available} units`}
          {availability.status === "ready" && isInsufficient && (
            <>
              Available: {availability.available} units · Requested: {requestedQuantity}
              <br />
              Insufficient available stock
            </>
          )}
        </div>
      )}
    </div>
  );
}
