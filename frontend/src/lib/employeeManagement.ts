import type { User, UserRole } from "../types/api";

// Pure client-side mirror of the SAME invariant the backend independently
// enforces (UsersService.update()/remove() in backend/src/users/users.service.ts)
// — never the actual source of truth, just enough to disable a control and
// explain why before a doomed request round-trips to the server. True only
// when targetId is currently an ADMIN and no OTHER employee in the list is
// also an ADMIN.
export function isLastRemainingAdmin(employees: User[], targetId: number): boolean {
  const target = employees.find((e) => e.id === targetId);
  if (!target || target.role !== "ADMIN") return false;
  return !employees.some((e) => e.id !== targetId && e.role === "ADMIN");
}

export async function updateRoleAndRefreshIdentity(options: {
  targetUserId: number;
  role: UserRole;
  isSelf: boolean;
  updateRole: (id: number, role: UserRole) => Promise<User>;
  refreshIdentity: () => Promise<void>;
}): Promise<void> {
  await options.updateRole(options.targetUserId, options.role);
  if (options.isSelf) await options.refreshIdentity();
}
