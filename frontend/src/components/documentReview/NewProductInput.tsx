import { useEffect, useState } from "react";
import { SparkleIcon } from "../ui/icons";

interface NewProductInputProps {
  name: string;
  onNameChange: (name: string) => void;
  category: string;
  onCategoryChange: (category: string) => void;
  /** The Document agent's recommended category for this NO_MATCH item, when it gave one — offered as a live suggestion, never auto-submitted. */
  categorySuggestion?: string | null;
  /** True while the parent's background category search is still running — shows a small "looking up" indicator in place of the suggestion box. */
  categoryLoading?: boolean;
  categories: string[];
  existingNames: string[];
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

// Backs the "new product" checkbox in Document Review — lets a reviewer
// DEFINE a product the extracted invoice line doesn't match to anything in
// the system yet. Purely a controlled name/category editor: nothing here
// ever calls the Products API. The definition lives in the parent
// (DocumentReviewPage's ItemRow) and is only ever turned into a real
// Product row atomically inside the backend's Approve & Sync transaction —
// see DocumentReviewService.resolveApprovalItems() — so a duplicate name,
// or any other failure in the same approval, rolls it back like everything
// else instead of leaving an orphaned product from a review that never
// completed.
export function NewProductInput({
  name,
  onNameChange,
  category,
  onCategoryChange,
  categorySuggestion,
  categoryLoading,
  categories,
  existingNames,
}: NewProductInputProps) {
  const [customCategoryMode, setCustomCategoryMode] = useState(() => !!category && !categories.includes(category));
  // Whether the reviewer has touched the category themselves — once true, a
  // suggestion arriving later (e.g. a background category lookup that was
  // still running when this form mounted) must never overwrite their own
  // choice.
  const [categoryTouched, setCategoryTouched] = useState(false);

  // categorySuggestion can arrive AFTER this component already mounted (the
  // parent kicks off a background category search when "new product" is
  // checked with nothing searched yet — see DocumentReviewPage) — apply it
  // live as long as the reviewer hasn't overridden it themselves.
  // Only ever fills an EMPTY category — never overwrites one that's already
  // set, whether from a prior manual choice (e.g. the reviewer unchecked
  // and rechecked "new product", remounting this component and resetting
  // categoryTouched) or an earlier application of this same suggestion.
  useEffect(() => {
    if (!categoryTouched && categorySuggestion && !category) {
      onCategoryChange(categorySuggestion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categorySuggestion, categoryTouched]);

  const trimmedName = name.trim();
  const duplicateMatch = trimmedName
    ? existingNames.find((n) => n.toLowerCase() === trimmedName.toLowerCase())
    : undefined;

  function handleCategorySelect(value: string) {
    setCategoryTouched(true);
    if (value === NEW_CATEGORY_VALUE) {
      setCustomCategoryMode(true);
      onCategoryChange("");
    } else {
      setCustomCategoryMode(false);
      onCategoryChange(value);
    }
  }

  return (
    <div>
      <input
        value={name}
        onChange={(e) => onNameChange(e.target.value)}
        placeholder="New product name"
        style={{ ...inputStyle, width: "100%" }}
      />
      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
        <select
          value={customCategoryMode ? NEW_CATEGORY_VALUE : category}
          onChange={(e) => handleCategorySelect(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
        >
          <option value="">No category</option>
          {categories.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
          <option value={NEW_CATEGORY_VALUE}>+ Add new category...</option>
        </select>
        {customCategoryMode && (
          <input
            value={category}
            onChange={(e) => {
              setCategoryTouched(true);
              onCategoryChange(e.target.value);
            }}
            placeholder="New category name"
            style={inputStyle}
            autoFocus
          />
        )}
      </div>
      {categoryLoading && !categoryTouched && !category && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5, fontSize: 11, color: "var(--color-text-muted)" }}>
          <span className="h-2.5 w-2.5 flex-shrink-0 animate-spin rounded-full border-[1.5px] border-[var(--color-border)] border-t-[var(--color-text-muted)]" role="status" aria-label="Looking up a suggested category" />
          Looking up a suggested category…
        </div>
      )}
      {/* Only while the CURRENT category value actually IS the suggestion
          (not just "a suggestion exists somewhere") — if the reviewer
          already had a different category set when this suggestion showed
          up (e.g. a prior manual choice surviving a checkbox toggle), the
          suggestion was deliberately never applied (see the effect above),
          so claiming it's "the suggestion" in effect here would be
          dishonest. */}
      {categorySuggestion && categorySuggestion === category && !categoryTouched && !customCategoryMode && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5, fontSize: 11, fontWeight: 600, padding: "5px 8px", borderRadius: 6, background: "rgba(34,197,94,0.12)", color: "var(--color-success)" }}>
          <SparkleIcon className="h-3 w-3" />
          Suggested category: {categorySuggestion} — change it above if it's not right.
        </div>
      )}
      {duplicateMatch && (
        <div style={{ marginTop: 5, fontSize: 11.5, color: "var(--color-warning)", fontWeight: 600 }}>
          "{duplicateMatch}" already exists — uncheck "new product" and search for it instead.
        </div>
      )}
    </div>
  );
}
