import { useRef, useState } from "react";
import { SearchIcon, CheckIcon } from "../ui/icons";
import { ErrorMessage } from "../ui/ErrorMessage";
import { friendlyErrorMessage } from "../../lib/friendlyError";
import type { DocumentMatchCandidate, DocumentMatchResult } from "../../types/domain";

interface ResolveSearchInputProps {
  initialQuery: string;
  search: (query: string) => Promise<DocumentMatchResult>;
  resolvedLabel: string | null;
  onResolve: (candidate: DocumentMatchCandidate) => void;
  /**
   * Reports every completed search result (RESOLVED/UNRESOLVED/NO_MATCH
   * alike), or null once a candidate is picked — this component only ever
   * displays the result read-only, it never creates anything itself. The
   * parent (DocumentReviewPage) uses this to offer a category starting
   * point in the "new product" flow: the AI's own NO_MATCH recommendation
   * when there is one, otherwise the top candidate's real category (looked
   * up from its own already-loaded catalog) even when that candidate
   * wasn't confident enough to auto-resolve — e.g. a 22" LED search
   * surfacing a 24" screen as an UNRESOLVED candidate still points at the
   * right category for a genuinely different, newly-added product.
   */
  onSearchResult?: (result: DocumentMatchResult | null) => void;
  /**
   * Called the moment the reviewer edits the query box after a match was
   * already picked (resolvedLabel was set) — the text no longer describes
   * what was resolved, so the parent's productId/supplierId must be
   * cleared too, not just the visible "Matched: X" label. Without this,
   * editing the box after picking a match silently leaves the OLD id
   * selected underneath text that no longer names it.
   */
  onResolutionCleared?: () => void;
  /**
   * When set, a NO_MATCH result renders as a red alert with this message
   * instead of the neutral "No matching record" text + new-product
   * recommendation — for a context where NO_MATCH can't actually be
   * resolved here (e.g. an outgoing shipment: there's no "create it" path
   * for a product that was never in the catalog, so this needs to visibly
   * block the reviewer rather than quietly suggesting a flow that doesn't
   * exist on this form).
   */
  noMatchAlert?: string;
  placeholder?: string;
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

// Backs both resolve-product and resolve-supplier — the reviewer types the
// AI-extracted name, searches, and picks the real ERP record it matches.
// The search itself is a real Document agent LLM call (with an automatic
// fuzzy-matcher fallback on the backend) — this component always shows the
// full result (status, each candidate's confidence + the agent's own
// reason, and a suggested new-product name/category when nothing matched)
// rather than a bare ranked list. Human confirmation is still mandatory
// either way: nothing here is ever auto-applied, the reviewer always picks.
export function ResolveSearchInput({ initialQuery, search, resolvedLabel, onResolve, onSearchResult, onResolutionCleared, noMatchAlert, placeholder }: ResolveSearchInputProps) {
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<DocumentMatchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Guards against an earlier, slower search resolving AFTER a newer one
  // and clobbering its results — without this, editing the query and
  // re-searching quickly could intermittently show/keep stale results, or
  // make a fresh search look like it "didn't take" (see requestId pattern
  // in lib/useFetch.ts — this component predates that hook and never had
  // the same guard).
  const requestIdRef = useRef(0);

  async function handleSearch() {
    const trimmed = query.trim();
    const requestId = ++requestIdRef.current;
    if (!trimmed) {
      setResult(null);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const found = await search(trimmed);
      if (requestId !== requestIdRef.current) return;
      setResult(found);
      onSearchResult?.(found);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setSearchError(friendlyErrorMessage(err, "Search failed."));
    } finally {
      if (requestId === requestIdRef.current) setSearching(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            // Only fires the moment there's an actual resolution to
            // invalidate — not on every keystroke of an ordinary,
            // never-yet-resolved search.
            if (resolvedLabel) onResolutionCleared?.();
          }}
          placeholder={placeholder}
          style={inputStyle}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), handleSearch())}
        />
        <button
          type="button"
          onClick={handleSearch}
          disabled={searching}
          style={{ width: 30, height: 30, borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text-secondary)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", flexShrink: 0 }}
        >
          <SearchIcon className="h-[13px] w-[13px]" />
        </button>
      </div>

      {searching && (
        <p style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 6, marginBottom: 4 }}>
          Searching — this calls the Document agent's own reasoning, so it can take a few seconds…
        </p>
      )}

      {resolvedLabel && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5, fontSize: 11.5, color: "var(--color-success)", fontWeight: 600 }}>
          <CheckIcon className="h-3 w-3" />
          Matched: {resolvedLabel}
        </div>
      )}

      {result && result.status === "UNRESOLVED" && (
        <p style={{ fontSize: 11, color: "var(--color-warning, #b58900)", marginTop: 6, marginBottom: 4 }}>
          Not confident enough to auto-suggest one — review the candidates below and pick the right one.
        </p>
      )}

      {result && result.candidates.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
          {result.candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              onClick={() => {
                // onResolve() is the caller's (DocumentReviewPage's) own
                // callback — if it throws, clearing the result/query below
                // would show "Matched" even though the parent's productId
                // was never actually set, hiding the real failure. Logged
                // and left showing the candidates so a retry is possible
                // rather than silently claiming success.
                try {
                  onResolve(candidate);
                } catch (err) {
                  console.error("onResolve threw while applying a match candidate:", err);
                  return;
                }
                setResult(null);
                setQuery(candidate.name);
                onSearchResult?.(null);
              }}
              style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12, padding: "6px 9px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text)", cursor: "pointer", textAlign: "left" }}
            >
              <span style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{candidate.name}</span>
                <span style={{ color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>{Math.round(candidate.confidence * 100)}%</span>
              </span>
              <span style={{ fontSize: 12, lineHeight: 1.4, color: "var(--color-text-muted)" }}>{candidate.reason}</span>
            </button>
          ))}
        </div>
      )}

      {result && result.status === "NO_MATCH" && (
        noMatchAlert ? (
          <div style={{ marginTop: 6 }}>
            <ErrorMessage message={noMatchAlert} />
          </div>
        ) : (
          <div style={{ marginTop: 6 }}>
            <p style={{ fontSize: 11.5, color: "var(--color-text-muted)" }}>No matching record found in the catalog.</p>
            {result.recommendation && (
              <div style={{ marginTop: 4, fontSize: 11, padding: "6px 9px", borderRadius: 6, border: "1px dashed var(--color-border)", color: "var(--color-text-secondary)" }}>
                Suggested new product: <strong>{result.recommendation.normalizedName}</strong>
                {result.recommendation.category && <> · {result.recommendation.category}</>}
                {result.recommendation.description && (
                  <div style={{ marginTop: 2, color: "var(--color-text-muted)" }}>{result.recommendation.description}</div>
                )}
                <div style={{ marginTop: 4, fontStyle: "italic" }}>
                  Check "This is a new product" above to create it — nothing is created automatically.
                </div>
              </div>
            )}
          </div>
        )
      )}

      {searchError && (
        <div style={{ marginTop: 6 }}>
          <ErrorMessage message={searchError} onRetry={handleSearch} />
        </div>
      )}
    </div>
  );
}
