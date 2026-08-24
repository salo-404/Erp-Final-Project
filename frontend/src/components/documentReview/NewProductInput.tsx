import { useState } from "react";
import { createProduct } from "../../lib/products.api";
import { ErrorMessage } from "../ui/ErrorMessage";
import { CheckIcon } from "../ui/icons";

interface NewProductInputProps {
  initialName: string;
  onCreated: (product: { productId: number; name: string }) => void;
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 6,
  padding: "7px 9px",
  fontSize: 12.5,
  color: "var(--color-text)",
  outline: "none",
};

// Backs the "new product" checkbox in Document Review — lets a reviewer add
// a product the extracted invoice line doesn't match to anything in the
// system yet, without leaving the review to go create it on the Inventory
// page first. Creates immediately on submit (mirrors ResolveSearchInput's
// resolve-on-click), then reports the new productId back so the row counts
// as resolved for approval, same as picking an existing match would.
export function NewProductInput({ initialName, onCreated }: NewProductInputProps) {
  const [name, setName] = useState(initialName);
  const [creating, setCreating] = useState(false);
  const [createdName, setCreatedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const product = await createProduct({ name: name.trim() });
      setCreatedName(product.name);
      onCreated({ productId: product.id, name: product.name });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create product.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New product name"
          style={inputStyle}
          disabled={!!createdName}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleCreate())}
        />
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating || !!createdName}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 5,
            padding: "0 12px",
            height: 30,
            borderRadius: 6,
            border: "1px solid var(--color-border)",
            background: createdName ? "rgba(34,197,94,0.12)" : "var(--color-surface-2)",
            color: createdName ? "var(--color-success)" : "var(--color-text-secondary)",
            fontSize: 12,
            fontWeight: 600,
            cursor: creating || createdName ? "default" : "pointer",
            flexShrink: 0,
          }}
        >
          {createdName ? (
            <>
              <CheckIcon className="h-3 w-3" /> Added
            </>
          ) : creating ? (
            "Adding..."
          ) : (
            "Add product"
          )}
        </button>
      </div>
      {createdName && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5, fontSize: 11.5, color: "var(--color-success)", fontWeight: 600 }}>
          <CheckIcon className="h-3 w-3" />
          Added to system: {createdName}
        </div>
      )}
      {error && (
        <div style={{ marginTop: 6 }}>
          <ErrorMessage message={error} onRetry={handleCreate} />
        </div>
      )}
    </div>
  );
}
