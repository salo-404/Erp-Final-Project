import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";

const DISPLAY_NAME_STORAGE_KEY = "nexora.settings.displayName";

interface DisplayNameContextValue {
  /** The real logged-in user's name (from AuthContext) with any local override applied. */
  displayName: string;
  /** True when a local override is active, distinct from the real account name. */
  isOverridden: boolean;
  setDisplayName: (name: string) => void;
  resetDisplayName: () => void;
}

const DisplayNameContext = createContext<DisplayNameContextValue | null>(null);

function readStoredOverride(): string | null {
  return localStorage.getItem(DISPLAY_NAME_STORAGE_KEY);
}

// Frontend-only preference layered on top of the real AuthContext user — no
// backend endpoint exists for renaming an account (Cognito will own that
// later), so this never calls the API. Purely a local display override,
// persisted the same way ThemeContext persists theme/accent.
export function DisplayNameProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [override, setOverride] = useState<string | null>(readStoredOverride);

  useEffect(() => {
    if (override) {
      localStorage.setItem(DISPLAY_NAME_STORAGE_KEY, override);
    } else {
      localStorage.removeItem(DISPLAY_NAME_STORAGE_KEY);
    }
  }, [override]);

  const value = useMemo(
    () => ({
      displayName: override ?? user?.name ?? "",
      isOverridden: override !== null && override !== user?.name,
      setDisplayName: (name: string) => setOverride(name.trim() || null),
      resetDisplayName: () => setOverride(null),
    }),
    [override, user?.name],
  );

  return <DisplayNameContext.Provider value={value}>{children}</DisplayNameContext.Provider>;
}

export function useDisplayName(): DisplayNameContextValue {
  const ctx = useContext(DisplayNameContext);
  if (!ctx) throw new Error("useDisplayName must be used within DisplayNameProvider");
  return ctx;
}
