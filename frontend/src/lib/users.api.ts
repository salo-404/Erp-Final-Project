import { apiRequest } from "./api-client";
import type { User, UserRole } from "../types/api";

export interface CreateUserInput {
  name: string;
  email: string;
  role: UserRole;
}

export function createUser(input: CreateUserInput): Promise<User> {
  return apiRequest<User>("/users", { method: "POST", body: input });
}

// Backs the admin Employee Management page (EmployeesPage.tsx) — all
// ADMIN-only, same guard the backend already enforces on every /users
// route. listEmployees/getEmployee are plain reads; updateEmployeeRole is
// deliberately the ONLY mutation exposed here — the backend's
// UpdateUserDto now structurally accepts nothing but `role`, so there is
// no name/email/password edit path to accidentally wire up here either.
export function listEmployees(): Promise<User[]> {
  return apiRequest<User[]>("/users");
}

export function getEmployee(id: number): Promise<User> {
  return apiRequest<User>(`/users/${id}`);
}

export function updateEmployeeRole(id: number, role: UserRole): Promise<User> {
  return apiRequest<User>(`/users/${id}`, { method: "PATCH", body: { role } });
}

export function deleteEmployee(id: number): Promise<void> {
  return apiRequest<void>(`/users/${id}`, { method: "DELETE" });
}
