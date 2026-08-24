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
