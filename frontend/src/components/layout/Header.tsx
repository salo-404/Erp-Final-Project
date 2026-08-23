import { useAuth } from "../../auth/AuthContext";
import { useTheme } from "../../theme/ThemeContext";
import { useDisplayName } from "../../settings/DisplayNameContext";
import { BellIcon, MoonIcon, SearchIcon, SunIcon } from "../ui/icons";

export function Header() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { displayName } = useDisplayName();

  return (
    <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6">
      <div>
        <h1 className="font-[var(--font-heading)] text-base font-semibold text-[var(--color-text)]">Nexora ERP</h1>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex w-60 items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
          <SearchIcon className="h-[15px] w-[15px] flex-shrink-0 text-[var(--color-text-muted)]" />
          <input
            type="text"
            placeholder="Search products, SKUs..."
            className="w-full border-none bg-transparent text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]"
          />
        </div>

        <button
          type="button"
          aria-label="Notifications"
          className="relative flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
        >
          <BellIcon className="h-4 w-4" />
          <span className="absolute right-[7px] top-[7px] h-1.5 w-1.5 rounded-full bg-[var(--color-danger)]" />
        </button>

        <button
          type="button"
          onClick={toggleTheme}
          aria-label="Toggle theme"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
        >
          {theme === "light" ? <MoonIcon className="h-4 w-4" /> : <SunIcon className="h-4 w-4" />}
        </button>

        {user && (
          <div className="flex items-center gap-2 text-sm">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-accent)] text-xs font-semibold text-white">
              {displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="hidden text-left sm:block">
              <p className="font-medium text-[var(--color-text)]">{displayName}</p>
              <p className="text-xs text-[var(--color-text-muted)]">{user.role}</p>
            </div>
          </div>
        )}

        <button
          type="button"
          onClick={logout}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
        >
          Log out
        </button>
      </div>
    </header>
  );
}
