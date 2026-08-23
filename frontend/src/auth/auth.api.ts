import { apiRequest } from "../lib/api-client";
import type { AuthenticatedIdentity, LoginResponse } from "../types/api";

export function login(email: string, password: string): Promise<LoginResponse> {
  return apiRequest<LoginResponse>("/auth/login", {
    method: "POST",
    body: { email, password },
    auth: false,
  });
}

export function fetchCurrentIdentity(): Promise<AuthenticatedIdentity> {
  return apiRequest<AuthenticatedIdentity>("/auth/me");
}
