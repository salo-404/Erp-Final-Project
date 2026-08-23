import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchCurrentIdentity, login as loginRequest } from "./auth.api";
import { getStoredToken, setStoredToken } from "../lib/api-client";
import type { User } from "../types/api";

const USER_STORAGE_KEY = "nexora.user";

type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
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

  const login = useCallback(async (email: string, password: string) => {
    const response = await loginRequest(email, password);
    setStoredToken(response.access_token);
    writeCachedUser(response.user);
    setUser(response.user);
    setStatus("authenticated");
  }, []);

  const logout = useCallback(() => {
    setStoredToken(null);
    writeCachedUser(null);
    setUser(null);
    setStatus("unauthenticated");
  }, []);

  const value = useMemo(() => ({ status, user, login, logout }), [status, user, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
