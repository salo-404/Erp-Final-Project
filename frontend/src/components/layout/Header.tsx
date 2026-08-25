import { useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthContext";
import { useTheme } from "../../theme/ThemeContext";
import { useDisplayName } from "../../settings/DisplayNameContext";
import { BellIcon, MoonIcon, SunIcon } from "../ui/icons";

export function Header() {
  const { user } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const { displayName } = useDisplayName();
  const navigate = useNavigate();

  return (
    <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6">
      <div>
        <h1 className="font-[var(--font-heading)] text-base font-semibold text-[var(--color-text)]">Nexora ERP</h1>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          aria-label="Notifications"
          onClick={() => navigate("/")}
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
          <button
            type="button"
            onClick={() => navigate("/settings")}
            aria-label="Open settings"
            className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-[var(--color-surface-2)]"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-accent)] text-xs font-semibold text-[var(--color-on-accent)]">
              {displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="hidden text-left sm:block">
              <p className="font-medium text-[var(--color-text)]">{displayName}</p>
              <p className="text-xs text-[var(--color-text-muted)]">{user.role}</p>
            </div>
          </button>
        )}
      </div>
    </header>
  );
}
