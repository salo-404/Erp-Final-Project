import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type Theme = "light" | "dark";

// v2: bumped so browsers that auto-detected "dark" from OS preference under
// the old key don't carry that over — default is now always light until the
// user explicitly toggles.
const THEME_STORAGE_KEY = "nexora.theme.v2";
const ACCENT_STORAGE_KEY = "nexora.accentColor";

interface ThemeContextValue {
  theme: Theme;
  toggleTheme: () => void;
  /** null means "use the theme's own default accent" — no inline override applied. */
  accentColor: string | null;
  setAccentColor: (color: string | null) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialTheme(): Theme {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  // Default to light regardless of OS preference — toggle switches and
  // persists to dark from here on.
  return "light";
}

function readInitialAccentColor(): string | null {
  return localStorage.getItem(ACCENT_STORAGE_KEY);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);
  const [accentColor, setAccentColorState] = useState<string | null>(readInitialAccentColor);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  // Inline style on the root element takes precedence over the :root /
  // [data-theme="dark"] rules in index.css that normally set --color-accent
  // — removing the property (accentColor === null) lets that cascaded
  // per-theme default show through again, unmodified.
  useEffect(() => {
    if (accentColor) {
      document.documentElement.style.setProperty("--color-accent", accentColor);
      localStorage.setItem(ACCENT_STORAGE_KEY, accentColor);
    } else {
      document.documentElement.style.removeProperty("--color-accent");
      localStorage.removeItem(ACCENT_STORAGE_KEY);
    }
  }, [accentColor]);

  const value = useMemo(
    () => ({
      theme,
      toggleTheme: () => setTheme((t) => (t === "light" ? "dark" : "light")),
      accentColor,
      setAccentColor: setAccentColorState,
    }),
    [theme, accentColor],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
