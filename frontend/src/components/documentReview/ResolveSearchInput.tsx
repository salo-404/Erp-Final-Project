import { useRef, useState } from "react";
import { SearchIcon, CheckIcon } from "../ui/icons";
import { ErrorMessage } from "../ui/ErrorMessage";
import type { MatchSuggestion } from "../../types/domain";

interface ResolveSearchInputProps {
  initialQuery: string;
  search: (query: string) => Promise<MatchSuggestion[]>;
  resolvedLabel: string | null;
  onResolve: (suggestion: MatchSuggestion) => void;
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
export function ResolveSearchInput({ initialQuery, search, resolvedLabel, onResolve, placeholder }: ResolveSearchInputProps) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<MatchSuggestion[] | null>(null);
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
      setResults(null);
      setSearchError(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      const found = await search(trimmed);
      if (requestId !== requestIdRef.current) return;
      setResults(found);
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setSearchError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      if (requestId === requestIdRef.current) setSearching(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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

      {resolvedLabel && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 5, fontSize: 11.5, color: "var(--color-success)", fontWeight: 600 }}>
          <CheckIcon className="h-3 w-3" />
          Matched: {resolvedLabel}
        </div>
      )}

      {results && results.length > 0 && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
          {results.map((r) => (
            <button
              key={r.productId ?? r.supplierId}
              type="button"
              onClick={() => {
                onResolve(r);
                setResults(null);
                setQuery(r.name);
              }}
              style={{ display: "flex", justifyContent: "space-between", fontSize: 12, padding: "6px 9px", borderRadius: 6, border: "1px solid var(--color-border)", background: "var(--color-surface-2)", color: "var(--color-text)", cursor: "pointer", textAlign: "left" }}
            >
              <span>{r.name}</span>
              <span style={{ color: "var(--color-text-muted)", fontFamily: "var(--font-mono)" }}>{Math.round(r.score * 100)}%</span>
            </button>
          ))}
        </div>
      )}
      {results && results.length === 0 && (
        <p style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginTop: 5 }}>No matches found.</p>
      )}
      {searchError && (
        <div style={{ marginTop: 6 }}>
          <ErrorMessage message={searchError} onRetry={handleSearch} />
        </div>
      )}
    </div>
  );
}
