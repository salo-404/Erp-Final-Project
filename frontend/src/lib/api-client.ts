import { API_URL } from "./env";
import type { ApiErrorBody } from "../types/api";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly details: string[];

  constructor(body: ApiErrorBody, statusCode: number) {
    const details = Array.isArray(body.message) ? body.message : [body.message];
    super(details.join(" "));
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

const TOKEN_STORAGE_KEY = "nexora.accessToken";

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredToken(token: string | null): void {
  if (token) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Omit only for the login call itself — every other endpoint requires auth. */
  auth?: boolean;
}

// Every list/detail endpoint on this backend returns raw JSON (no {data,meta}
// envelope, no /api prefix) — see the full survey in project memory.
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, auth = true } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (auth) {
    const token = getStoredToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  const response = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      (payload as ApiErrorBody) ?? { statusCode: response.status, message: response.statusText, error: "Error" },
      response.status,
    );
  }

  return payload as T;
}
