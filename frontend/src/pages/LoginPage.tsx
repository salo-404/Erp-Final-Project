import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import loginHero from "../assets/login-hero.png";

// Layout, copy, and styling below are ported 1:1 from the Nexora Claude
// Design export (frontend/claude_plan handoff) — see the "isLoginPage"
// branch of NexoraERP.dc.html. Do not restyle without re-checking that
// source; the design intentionally uses inline styles, not Tailwind here.
const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  borderRadius: 7,
  padding: "11px 13px",
  fontSize: 13.5,
  color: "var(--color-text)",
  fontFamily: "var(--font-body)",
  outline: "none",
};

export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Set when Cognito reports the account's password is a temporary one
  // (CognitoAdminService.createUser() always issues one) — the same
  // credential form then asks for a permanent replacement instead of
  // retrying the original sign-in.
  const [newPasswordChallenge, setNewPasswordChallenge] = useState<{
    completeNewPassword: (newPassword: string) => Promise<void>;
  } | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");

  if (status === "loading") {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--color-bg)]">
        <LoadingSpinner label="Checking session..." />
      </div>
    );
  }

  if (status === "authenticated") {
    const redirectTo = (location.state as { from?: string } | null)?.from ?? "/";
    return <Navigate to={redirectTo} replace />;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const outcome = await login(email, password);
      if (outcome.status === "newPasswordRequired") {
        setNewPasswordChallenge({ completeNewPassword: outcome.completeNewPassword });
        return;
      }
      const redirectTo = (location.state as { from?: string } | null)?.from ?? "/";
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSetNewPassword(event: FormEvent) {
    event.preventDefault();
    if (!newPasswordChallenge) return;
    if (newPassword !== newPasswordConfirm) {
      setError("Passwords don't match.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await newPasswordChallenge.completeNewPassword(newPassword);
      const redirectTo = (location.state as { from?: string } | null)?.from ?? "/";
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to set a new password. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100vh",
        background: "var(--color-bg)",
        color: "var(--color-text)",
        fontFamily: "var(--font-body)",
      }}
    >
      <div
        style={{
          width: "46%",
          flex: "none",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          alignItems: "center",
          padding: "0 40px",
        }}
      >
        <div style={{ width: "100%", maxWidth: 400, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 36 }}>
            <div
              style={{
                width: 32,
                height: 32,
                background: "var(--color-accent)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: "var(--font-heading)",
                fontWeight: 700,
                fontSize: 17,
                color: "var(--color-on-accent)",
              }}
            >
              N
            </div>
            <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 19 }}>NEXORA</div>
          </div>

          {newPasswordChallenge ? (
            <>
              <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 30, marginBottom: 8 }}>
                Set a new password
              </div>
              <div style={{ fontSize: 13.5, color: "var(--color-text-secondary)", marginBottom: 32 }}>
                Your account was created with a temporary password. Choose a permanent one to continue.
              </div>

              <form onSubmit={handleSetNewPassword} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6 }}>
                    New password
                  </div>
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    placeholder="••••••••"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    style={inputStyle}
                  />
                </div>

                <div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6 }}>
                    Confirm new password
                  </div>
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    placeholder="••••••••"
                    value={newPasswordConfirm}
                    onChange={(e) => setNewPasswordConfirm(e.target.value)}
                    style={inputStyle}
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  style={{
                    marginTop: 6,
                    background: "var(--color-accent)",
                    color: "var(--color-on-accent)",
                    textAlign: "center",
                    padding: 12,
                    borderRadius: 7,
                    fontFamily: "var(--font-heading)",
                    fontWeight: 600,
                    fontSize: 14,
                    cursor: submitting ? "default" : "pointer",
                    border: "none",
                    opacity: submitting ? 0.7 : 1,
                  }}
                >
                  {submitting ? "Saving..." : "Set password and sign in"}
                </button>

                {error && (
                  <div style={{ fontSize: 12.5, color: "var(--color-danger)", textAlign: "center" }}>{error}</div>
                )}
              </form>
            </>
          ) : (
            <>
              <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 30, marginBottom: 8 }}>
                Sign in to Nexora
              </div>
              <div style={{ fontSize: 13.5, color: "var(--color-text-secondary)", marginBottom: 32 }}>
                Warehouse &amp; logistics operations, in one place.
              </div>

              <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6 }}>
                    Work email
                  </div>
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="you@company.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={inputStyle}
                  />
                </div>

                <div>
                  <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 6 }}>Password</div>
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoComplete="current-password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={inputStyle}
                  />
                </div>

                <button
                  type="submit"
                  disabled={submitting}
                  style={{
                    marginTop: 6,
                    background: "var(--color-accent)",
                    color: "var(--color-on-accent)",
                    textAlign: "center",
                    padding: 12,
                    borderRadius: 7,
                    fontFamily: "var(--font-heading)",
                    fontWeight: 600,
                    fontSize: 14,
                    cursor: submitting ? "default" : "pointer",
                    border: "none",
                    opacity: submitting ? 0.7 : 1,
                  }}
                >
                  {submitting ? "Signing in..." : "Sign in"}
                </button>

                {error && (
                  <div style={{ fontSize: 12.5, color: "var(--color-danger)", textAlign: "center" }}>{error}</div>
                )}

                <div style={{ fontSize: 11.5, color: "var(--color-text-muted)", textAlign: "center", marginTop: 4 }}>
                  Protected routes · SSO available for enterprise accounts
                </div>
              </form>
            </>
          )}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          position: "relative",
          background: "var(--color-surface)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <img
          src={loginHero}
          alt="Warehouse and logistics facility"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      </div>
    </div>
  );
}
