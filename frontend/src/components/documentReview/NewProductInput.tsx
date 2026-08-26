import { useEffect, useState } from "react";
import { createProduct } from "../../lib/products.api";
import { friendlyErrorMessage } from "../../lib/friendlyError";
import { ErrorMessage } from "../ui/ErrorMessage";
import { CheckIcon, SparkleIcon } from "../ui/icons";

interface NewProductInputProps {
  initialName: string;
  /** The Document agent's recommended category for this NO_MATCH item, when it gave one — pre-fills the dropdown, never auto-submitted. */
  initialCategory?: string | null;
  /** True while the parent's background category search is still running — shows a small "looking up" indicator in place of the suggestion box. */
  categoryLoading?: boolean;
  categories: string[];
  existingNames: string[];
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

const NEW_CATEGORY_VALUE = "__new_category__";

// Backs the "new product" checkbox in Document Review — lets a reviewer add
// a product the extracted invoice line doesn't match to anything in the
// system yet, without leaving the review to go create it on the Inventory
// page first. Creates immediately on submit (mirrors ResolveSearchInput's
// resolve-on-click), then reports the new productId back so the row counts
// as resolved for approval, same as picking an existing match would.
export function NewProductInput({ initialName, initialCategory, categoryLoading, categories, existingNames, onCreated }: NewProductInputProps) {
  const [name, setName] = useState(initialName);
  const [category, setCategory] = useState(initialCategory ?? "");
  // Whether the reviewer has touched the category dropdown themselves —
  // once true, a suggestion arriving later (e.g. a background category
  // lookup that was still running when this form mounted) must never
  // overwrite their own choice.
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [addingNewCategory, setAddingNewCategory] = useState(false);
  const [newCategory, setNewCategory] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdName, setCreatedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // initialCategory can arrive AFTER this component already mounted (the
  // parent kicks off a background category search when "new product" is
  // checked with nothing searched yet — see DocumentReviewPage) — a plain
  // useState initializer only reads its value once, so without this the
  // dropdown would stay stuck on "No category" even once a real suggestion
  // comes in.
  useEffect(() => {
    if (!categoryTouched && initialCategory) {
      setCategory(initialCategory);
    }
  }, [initialCategory, categoryTouched]);

  const trimmedName = name.trim();
  const duplicateMatch = !createdName && trimmedName
    ? existingNames.find((n) => n.toLowerCase() === trimmedName.toLowerCase())
    : undefined;

  function handleCategorySelect(value: string) {
    setCategoryTouched(true);
    if (value === NEW_CATEGORY_VALUE) {
      setAddingNewCategory(true);
      setCategory("");
    } else {
      setAddingNewCategory(false);
      setCategory(value);
    }
  }

  async function handleCreate() {
    if (!name.trim() || duplicateMatch) return;
    setCreating(true);
    setError(null);
    try {
      const resolvedCategory = (addingNewCategory ? newCategory : category).trim();
      const product = await createProduct({ name: name.trim(), category: resolvedCategory || undefined });
      setCreatedName(product.name);
      onCreated({ productId: product.id, name: product.name });
    } catch (err) {
      setError(friendlyErrorMessage(err, "Failed to create product."));
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
          disabled={creating || !!createdName || !!duplicateMatch}
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
            cursor: creating || createdName || duplicateMatch ? "default" : "pointer",
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
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <select
          value={addingNewCategory ? NEW_CATEGORY_VALUE : category}
          onChange={(e) => handleCategorySelect(e.target.value)}
          disabled={!!createdName}
          style={{ ...inputStyle, flex: 1 }}
        >
          <option value="">No category</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
          <option value={NEW_CATEGORY_VALUE}>+ Add new category...</option>
        </select>
        {addingNewCategory && (
          <input
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            placeholder="New category name"
            disabled={!!createdName}
            style={inputStyle}
            autoFocus
          />
        )}
      </div>
      {categoryLoading && !categoryTouched && !initialCategory && !createdName && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5, fontSize: 11, color: "var(--color-text-muted)" }}>
          <span className="h-2.5 w-2.5 flex-shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--color-border)] border-t-[var(--color-text-muted)]" role="status" aria-label="Looking up a suggested category" />
          Looking up a suggested category…
        </div>
      )}
      {/* Only while the reviewer hasn't touched the dropdown themselves —
          the moment they pick something else, this isn't a "suggestion"
          anymore, it's their own choice, and claiming otherwise would be
          dishonest. */}
      {initialCategory && !categoryTouched && !addingNewCategory && !createdName && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5, fontSize: 11, fontWeight: 600, padding: "5px 8px", borderRadius: 6, background: "rgba(34,197,94,0.12)", color: "var(--color-success)" }}>
          <SparkleIcon className="h-3 w-3" />
          Suggested category: {initialCategory} — change it above if it's not right.
        </div>
      )}
      {createdName && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5, fontSize: 11.5, color: "var(--color-success)", fontWeight: 600 }}>
          <CheckIcon className="h-3 w-3" />
          Added to system: {createdName}
        </div>
      )}
      {duplicateMatch && (
        <div style={{ marginTop: 5, fontSize: 11.5, color: "var(--color-warning)", fontWeight: 600 }}>
          "{duplicateMatch}" already exists — uncheck "new product" and search for it instead.
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
