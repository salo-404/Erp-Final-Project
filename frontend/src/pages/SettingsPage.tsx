import { useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useTheme } from "../theme/ThemeContext";
import { useDisplayName } from "../settings/DisplayNameContext";
import { CheckIcon, MoonIcon, SunIcon } from "../components/ui/icons";
import { createUser } from "../lib/users.api";
import type { UserRole } from "../types/api";

const cardStyle: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, padding: 22 };
const labelStyle: React.CSSProperties = { fontSize: 11.5, color: "var(--color-text-secondary)", fontWeight: 600, marginBottom: 6, display: "block" };
const inputStyle: React.CSSProperties = { width: "100%", background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text)", fontSize: 13, padding: "10px 12px", borderRadius: 8, fontFamily: "var(--font-body)" };
const readonlyInputStyle: React.CSSProperties = { ...inputStyle, color: "var(--color-text-muted)", cursor: "not-allowed" };

const ACCENT_SWATCHES = [
  { label: "Purple", value: "#6D3FD9" },
  { label: "Gold", value: "#F4C430" },
  { label: "Blue", value: "#3B82F6" },
  { label: "Green", value: "#10B981" },
  { label: "Coral", value: "#F43F5E" },
  { label: "Teal", value: "#14B8A6" },
];

export function SettingsPage() {
  const { user } = useAuth();
  const { theme, toggleTheme, accentColor, setAccentColor } = useTheme();
  const { displayName, isOverridden, setDisplayName, resetDisplayName } = useDisplayName();

  const [nameDraft, setNameDraft] = useState(displayName);
  const [saved, setSaved] = useState(false);
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [newUserRole, setNewUserRole] = useState<UserRole>("EMPLOYEE");
  const [creatingUser, setCreatingUser] = useState(false);
  const [createUserError, setCreateUserError] = useState<string | null>(null);
  const [createUserSuccess, setCreateUserSuccess] = useState<string | null>(null);

  function handleSaveName() {
    setDisplayName(nameDraft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleCreateUser(event: React.FormEvent) {
    event.preventDefault();
    setCreateUserError(null);
    setCreateUserSuccess(null);
    setCreatingUser(true);
    try {
      const created = await createUser({
        name: newUserName.trim(),
        email: newUserEmail.trim(),
        role: newUserRole,
      });
      setCreateUserSuccess(`Account created and invitation sent to ${created.email}.`);
      setNewUserName("");
      setNewUserEmail("");
      setNewUserRole("EMPLOYEE");
    } catch (error) {
      setCreateUserError(error instanceof Error ? error.message : "Unable to create the user.");
    } finally {
      setCreatingUser(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 760 }}>
      {/* Account */}
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 20 }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: "var(--color-accent)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 18, color: "var(--color-on-accent)", flexShrink: 0 }}>
            {(displayName || user?.email || "?").slice(0, 1).toUpperCase()}
          </div>
          <div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 17 }}>{displayName || "Unnamed"}</div>
            <div style={{ fontSize: 12.5, color: "var(--color-text-muted)", marginTop: 3 }}>{user?.role ?? "—"}</div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, marginBottom: 16 }}>
          <div>
            <label style={labelStyle}>Email</label>
            <input value={user?.email ?? ""} readOnly style={readonlyInputStyle} />
          </div>
          <div>
            <label style={labelStyle}>Role</label>
            <input value={user?.role ?? ""} readOnly style={readonlyInputStyle} />
          </div>
        </div>

        <div>
          <label style={labelStyle}>Display name</label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="Your name" style={{ ...inputStyle, flex: "1 1 200px" }} />
            <button
              type="button"
              onClick={handleSaveName}
              disabled={!nameDraft.trim() || nameDraft === displayName}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, padding: "10px 16px", borderRadius: 8, background: "var(--color-accent)", color: "var(--color-on-accent)", border: "none", cursor: !nameDraft.trim() || nameDraft === displayName ? "default" : "pointer", opacity: !nameDraft.trim() || nameDraft === displayName ? 0.5 : 1 }}
            >
              {saved ? <CheckIcon className="h-3 w-3" /> : null}
              {saved ? "Saved" : "Save"}
            </button>
            {isOverridden && (
              <button
                type="button"
                onClick={() => { resetDisplayName(); setNameDraft(user?.name ?? ""); }}
                style={{ fontSize: 12, fontWeight: 600, padding: "10px 12px", borderRadius: 8, background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", cursor: "pointer" }}
              >
                Reset to account default
              </button>
            )}
          </div>
          <p style={{ fontSize: 11, color: "var(--color-text-muted)", marginTop: 8, lineHeight: 1.5 }}>
            Stored locally in your browser only — this doesn't change your real account name on the server. Full account management (renaming, password, etc.) will be handled by AWS Cognito.
          </p>
        </div>
      </div>

      {user?.role === "ADMIN" && (
        <div style={cardStyle}>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
            Create user
          </div>
          <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginBottom: 16 }}>
            The user will receive a temporary password by email and must replace it on first sign-in.
          </div>
          <form onSubmit={handleCreateUser} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14 }}>
              <div>
                <label style={labelStyle}>Name</label>
                <input required value={newUserName} onChange={(event) => setNewUserName(event.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Email</label>
                <input required type="email" value={newUserEmail} onChange={(event) => setNewUserEmail(event.target.value)} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Role</label>
                <select value={newUserRole} onChange={(event) => setNewUserRole(event.target.value as UserRole)} style={inputStyle}>
                  <option value="EMPLOYEE">Employee</option>
                  <option value="ADMIN">Admin</option>
                </select>
              </div>
            </div>
            <button
              type="submit"
              disabled={creatingUser || !newUserName.trim() || !newUserEmail.trim()}
              style={{ alignSelf: "flex-start", background: "var(--color-accent)", color: "var(--color-on-accent)", padding: "10px 16px", borderRadius: 8, border: "none", fontWeight: 600, cursor: creatingUser ? "default" : "pointer", opacity: creatingUser ? 0.7 : 1 }}
            >
              {creatingUser ? "Creating..." : "Create user and send invitation"}
            </button>
            {createUserError && <div style={{ fontSize: 12.5, color: "var(--color-danger)" }}>{createUserError}</div>}
            {createUserSuccess && <div style={{ fontSize: 12.5, color: "var(--color-success, #10B981)" }}>{createUserSuccess}</div>}
          </form>
        </div>
      )}

      {/* Appearance */}
      <div style={cardStyle}>
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 15, marginBottom: 4 }}>Theme</div>
        <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginBottom: 16 }}>Choose how Nexora looks. Applies immediately, persists across visits.</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 22 }}>
          {(["light", "dark"] as const).map((t) => (
            <div
              key={t}
              onClick={() => { if (theme !== t) toggleTheme(); }}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                padding: "16px",
                borderRadius: 10,
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                border: theme === t ? "2px solid var(--color-accent)" : "1px solid var(--color-border)",
                background: theme === t ? "var(--color-surface-2)" : "transparent",
                color: "var(--color-text)",
              }}
            >
              {t === "dark" ? <MoonIcon className="h-4 w-4" /> : <SunIcon className="h-4 w-4" />}
              {t === "dark" ? "Dark" : "Light"}
            </div>
          ))}
        </div>

        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Accent color</div>
        <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", marginBottom: 14 }}>Applied across buttons, highlights, and charts via the existing theme variables.</div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          {ACCENT_SWATCHES.map((s) => {
            const isActive = accentColor?.toLowerCase() === s.value.toLowerCase();
            return (
              <button
                key={s.value}
                type="button"
                title={s.label}
                onClick={() => setAccentColor(s.value)}
                style={{
                  width: 34,
                  height: 34,
                  borderRadius: "50%",
                  background: s.value,
                  border: isActive ? "3px solid var(--color-text)" : "1px solid var(--color-border)",
                  boxShadow: isActive ? "0 0 0 2px var(--color-surface)" : "none",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {isActive && <CheckIcon className="h-4 w-4" style={{ color: "#FFFFFF" }} />}
              </button>
            );
          })}
          {accentColor && (
            <button
              type="button"
              onClick={() => setAccentColor(null)}
              style={{ fontSize: 12, fontWeight: 600, padding: "9px 14px", borderRadius: 8, background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)", cursor: "pointer" }}
            >
              Use theme default
            </button>
          )}
        </div>
      </div>

      {/* Honest scope note */}
      <div style={{ ...cardStyle, background: "var(--color-surface-2)" }}>
        <div style={{ fontSize: 12.5, color: "var(--color-text-secondary)", lineHeight: 1.6 }}>
          Notifications, AI preferences, and general ERP preferences (default warehouse, currency, timezone, etc.) aren't implemented here — there's no backend storage for them yet, and this page only implements settings that are genuinely real: local display name, theme, and accent color.
        </div>
      </div>
    </div>
  );
}
