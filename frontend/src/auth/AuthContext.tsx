import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchCurrentIdentity, login as loginRequest } from "./auth.api";
import { getStoredToken, setStoredToken, SESSION_EXPIRED_EVENT } from "../lib/api-client";
import type { User } from "../types/api";

const USER_STORAGE_KEY = "nexora.user";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export type LoginOutcome =
  | { status: "success" }
  | { status: "newPasswordRequired"; completeNewPassword: (newPassword: string) => Promise<void> };

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  login: (email: string, password: string) => Promise<LoginOutcome>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function readCachedUser(): User | null {
  const raw = localStorage.getItem(USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

function writeCachedUser(user: User | null): void {
  if (user) {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(USER_STORAGE_KEY);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setStatus("unauthenticated");
      return;
    }

    // Re-validate the stored token against the backend on load rather than
    // trusting localStorage — /auth/me only returns {id,email,role}, so we
    // keep the cached `name` (from login) and reconcile the rest.
    const cached = readCachedUser();
    fetchCurrentIdentity()
      .then((identity) => {
        const resolved: User = {
          id: identity.id,
          email: identity.email,
          role: identity.role,
          name: cached?.name ?? identity.email,
          createdAt: cached?.createdAt ?? "",
          updatedAt: cached?.updatedAt ?? "",
        };
        setUser(resolved);
        writeCachedUser(resolved);
        setStatus("authenticated");
      })
      .catch(() => {
        setStoredToken(null);
        writeCachedUser(null);
        setUser(null);
        setStatus("unauthenticated");
      });
  }, []);

  // Resolves either sign-in outcome into an authenticated session: stores
  // the Cognito access token, then reconciles it against /auth/me the same
  // way the on-load re-validation above does (id/email/role are backend-
  // authoritative; name comes from the ID token since /auth/me doesn't
  // return it).
  const finishLogin = useCallback(async (accessToken: string, cognitoName: string | null) => {
    setStoredToken(accessToken);
    const identity = await fetchCurrentIdentity();
    const resolved: User = {
      id: identity.id,
      email: identity.email,
      role: identity.role,
      name: cognitoName ?? identity.email,
      createdAt: "",
      updatedAt: "",
    };
    writeCachedUser(resolved);
    setUser(resolved);
    setStatus("authenticated");
  }, []);

  const login = useCallback(
    async (email: string, password: string): Promise<LoginOutcome> => {
      const result = await loginRequest(email, password);
      if (result.status === "success") {
        await finishLogin(result.accessToken, result.name);
        return { status: "success" };
      }
      return {
        status: "newPasswordRequired",
        completeNewPassword: async (newPassword: string) => {
          const completed = await result.completeNewPassword(newPassword);
          await finishLogin(completed.accessToken, completed.name);
        },
      };
    },
    [finishLogin],
  );

  const logout = useCallback(() => {
    setStoredToken(null);
    writeCachedUser(null);
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  // A 401 on an authenticated request means the session is no longer valid
  // (expired/revoked token) — log out and let ProtectedRoute redirect to
  // /login, instead of leaving every page stuck on a dead "Retry" error.
  useEffect(() => {
    function handleSessionExpired() {
      logout();
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  }, [logout]);

  const value = useMemo(() => ({ status, user, login, logout }), [status, user, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
