import assert from "node:assert/strict";
import test from "node:test";

import {
  isLastRemainingAdmin,
  updateRoleAndRefreshIdentity,
} from "../src/lib/employeeManagement.ts";
import type { User } from "../src/types/api.ts";

function employee(id: number, role: User["role"]): User {
  return {
    id,
    role,
    name: `User ${id}`,
    email: `user${id}@example.com`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("the sole admin in the list is the last remaining admin", () => {
  const employees = [employee(1, "ADMIN"), employee(2, "EMPLOYEE")];
  assert.equal(isLastRemainingAdmin(employees, 1), true);
});

test("an admin is not the last remaining admin when another admin exists", () => {
  const employees = [employee(1, "ADMIN"), employee(2, "ADMIN"), employee(3, "EMPLOYEE")];
  assert.equal(isLastRemainingAdmin(employees, 1), false);
  assert.equal(isLastRemainingAdmin(employees, 2), false);
});

test("an EMPLOYEE is never the last remaining admin, even alone in the list", () => {
  const employees = [employee(1, "EMPLOYEE")];
  assert.equal(isLastRemainingAdmin(employees, 1), false);
});

test("an id not present in the list is never the last remaining admin", () => {
  const employees = [employee(1, "ADMIN")];
  assert.equal(isLastRemainingAdmin(employees, 999), false);
});

test("a self role change refreshes the authenticated identity immediately", async () => {
  const calls: string[] = [];
  await updateRoleAndRefreshIdentity({
    targetUserId: 7,
    role: "EMPLOYEE",
    isSelf: true,
    updateRole: async () => {
      calls.push("update");
      return employee(7, "EMPLOYEE");
    },
    refreshIdentity: async () => {
      calls.push("refresh");
    },
  });
  assert.deepEqual(calls, ["update", "refresh"]);
});

test("changing another employee does not refresh the acting admin identity", async () => {
  let refreshes = 0;
  await updateRoleAndRefreshIdentity({
    targetUserId: 8,
    role: "ADMIN",
    isSelf: false,
    updateRole: async () => employee(8, "ADMIN"),
    refreshIdentity: async () => {
      refreshes += 1;
    },
  });
  assert.equal(refreshes, 0);
});
