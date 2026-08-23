// Mirrors the real NestJS backend (backend/src/auth, backend/prisma/schema.prisma).
// Only ADMIN and EMPLOYEE exist — do not add a third role without a schema change.
export type UserRole = "ADMIN" | "EMPLOYEE";

export interface User {
  id: number;
  name: string;
  email: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

// POST /auth/login response shape (backend/src/auth/auth.controller.ts).
export interface LoginResponse {
  access_token: string;
  user: User;
}

// GET /auth/me returns only what JwtStrategy.validate() puts on the request — no `name`.
export interface AuthenticatedIdentity {
  id: number;
  email: string;
  role: UserRole;
}

// Default Nest HTTP exception shape (no global exception filter is registered).
export interface ApiErrorBody {
  statusCode: number;
  message: string | string[];
  error: string;
}
