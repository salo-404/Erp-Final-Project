import { useMemo, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { useFetch } from "../lib/useFetch";
import { deleteEmployee, listEmployees, updateEmployeeRole } from "../lib/users.api";
import { isLastRemainingAdmin, updateRoleAndRefreshIdentity } from "../lib/employeeManagement";
import { friendlyErrorMessage } from "../lib/friendlyError";
import { LoadingSpinner } from "../components/ui/LoadingSpinner";
import { ErrorMessage } from "../components/ui/ErrorMessage";
import { Modal } from "../components/ui/Modal";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { TrashIcon, UsersIcon } from "../components/ui/icons";
import type { User, UserRole } from "../types/api";

const cardStyle: React.CSSProperties = { background: "var(--color-surface)", border: "1px solid var(--color-border)", borderRadius: 12, overflow: "hidden" };
const roleBadgeStyle = (role: UserRole): React.CSSProperties => ({
  fontSize: 10.5,
  fontWeight: 700,
  padding: "3px 9px",
  borderRadius: 4,
  background: role === "ADMIN" ? "rgba(244,196,48,0.16)" : "var(--color-surface-2)",
  color: role === "ADMIN" ? "var(--color-warning)" : "var(--color-text-secondary)",
});

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// Detail/manage panel for one employee — the ONLY place role can be
// changed or the account deleted from this page. Name/email/Cognito
// identity are shown read-only; there is deliberately no edit control for
// any of them here (see UpdateUserDto on the backend, which now
// structurally accepts nothing but `role` — this panel can't outrun that
// even if someone tried to wire up more fields later).
function EmployeeDetail({
  employee,
  isSelf,
  isLastAdmin,
  onClose,
  onChanged,
}: {
  employee: User;
  isSelf: boolean;
  isLastAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { refreshIdentity } = useAuth();
  const [role, setRole] = useState<UserRole>(employee.role);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const roleChanged = role !== employee.role;
  // Client-side hint only, for immediate feedback — the backend
  // independently re-enforces this and is the actual source of truth;
  // this just avoids a pointless round trip for the common case. Only
  // the last-admin case blocks a role change — self-editing one's OWN
  // role is otherwise allowed (only self-DELETE is restricted; demoting
  // a SOLE admin, the actually dangerous self-lockout case, is already
  // covered by isLastAdmin regardless of who's making the change).
  const blockedReason =
    isLastAdmin && roleChanged
      ? "This is the last remaining admin — demote another admin first, or promote someone else."
      : null;

  async function handleSaveRole() {
    setSaveError(null);
    setSaving(true);
    try {
      await updateRoleAndRefreshIdentity({
        targetUserId: employee.id,
        role,
        isSelf,
        updateRole: updateEmployeeRole,
        refreshIdentity,
      });
      onChanged();
      onClose();
    } catch (err) {
      setSaveError(friendlyErrorMessage(err, "Failed to update role."));
      setSaving(false);
    }
  }

  async function handleDelete() {
    await deleteEmployee(employee.id);
    onChanged();
    onClose();
  }

  return (
    <Modal title="Employee Details" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <div>
          <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 18 }}>{employee.name}</div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginTop: 2 }}>{employee.email}</div>
        </div>

        <div>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: 4 }}>
            Created
          </div>
          <div style={{ fontSize: 13 }}>{formatDate(employee.createdAt)}</div>
        </div>

        <div>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "var(--color-text-muted)", marginBottom: 6 }}>
            Role
          </div>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            disabled={saving}
            style={{ width: "100%", background: "var(--color-surface-2)", border: "1px solid var(--color-border)", borderRadius: 7, padding: "8px 10px", fontSize: 13, color: "var(--color-text)" }}
          >
            <option value="EMPLOYEE">Employee</option>
            <option value="ADMIN">Admin</option>
          </select>
          {blockedReason && (
            <div style={{ fontSize: 11.5, color: "var(--color-warning)", marginTop: 6 }}>{blockedReason}</div>
          )}
          {saveError && (
            <div style={{ marginTop: 8 }}>
              <ErrorMessage message={saveError} />
            </div>
          )}
          {roleChanged && !blockedReason && (
            <button
              type="button"
              onClick={handleSaveRole}
              disabled={saving}
              style={{ marginTop: 10, padding: "8px 14px", borderRadius: 7, border: "none", background: "var(--color-accent)", color: "var(--color-on-accent)", fontSize: 12.5, fontWeight: 600, cursor: saving ? "default" : "pointer", opacity: saving ? 0.7 : 1 }}
            >
              {saving ? "Saving..." : "Save role"}
            </button>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--color-border)", paddingTop: 14, display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={() => setConfirmingDelete(true)}
            disabled={isSelf || isLastAdmin}
            title={isSelf ? "You cannot delete your own account" : isLastAdmin ? "Cannot delete the last remaining admin" : undefined}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              fontSize: 12.5,
              fontWeight: 600,
              padding: "9px 14px",
              borderRadius: 7,
              background: "transparent",
              border: "1px solid rgba(239,68,68,0.35)",
              color: "var(--color-danger)",
              cursor: isSelf || isLastAdmin ? "not-allowed" : "pointer",
              opacity: isSelf || isLastAdmin ? 0.5 : 1,
            }}
          >
            <TrashIcon className="h-[13px] w-[13px]" />
            Delete employee
          </button>
        </div>
      </div>

      {confirmingDelete && (
        <ConfirmDialog
          title="Delete Employee"
          message={`Delete "${employee.name}"? This permanently removes their account and sign-in access. If they have review history on file, deletion will be blocked instead.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={handleDelete}
        />
      )}
    </Modal>
  );
}

export function EmployeesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "ADMIN";

  const employeesFetch = useFetch<User[]>(() => (isAdmin ? listEmployees() : Promise.resolve([])), [isAdmin]);
  const employees = useMemo(() => employeesFetch.data ?? [], [employeesFetch.data]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selectedEmployee = employees.find((e) => e.id === selectedId) ?? null;

  if (!isAdmin) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <UsersIcon className="h-8 w-8 text-[var(--color-text-muted)]" />
        <p className="font-[var(--font-heading)] text-lg font-semibold">Admins only</p>
        <p className="text-sm text-[var(--color-text-muted)]">Employee management is restricted to admin accounts.</p>
      </div>
    );
  }

  if (employeesFetch.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner label="Loading employees..." />
      </div>
    );
  }

  if (employeesFetch.error) {
    return <ErrorMessage message={employeesFetch.error} onRetry={employeesFetch.refetch} />;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, fontSize: 20 }}>Employees</div>
        <div style={{ fontSize: 12.5, color: "var(--color-text-muted)" }}>{employees.length} total</div>
      </div>

      <div style={cardStyle}>
        {employees.length === 0 ? (
          <div style={{ padding: "36px 20px", textAlign: "center", fontSize: 12.5, color: "var(--color-text-muted)" }}>No employees found.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
              <thead>
                <tr style={{ background: "var(--color-surface-2)" }}>
                  {["Name", "Email", "Role", "Created"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "10px 16px", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--color-text-muted)" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {employees.map((employee) => (
                  <tr
                    key={employee.id}
                    onClick={() => setSelectedId(employee.id)}
                    style={{ cursor: "pointer" }}
                  >
                    <td style={{ padding: "10px 16px", fontSize: 13, fontWeight: 500, borderTop: "1px solid var(--color-border)" }}>
                      {employee.name}
                      {employee.id === user?.id && (
                        <span style={{ marginLeft: 8, fontSize: 10.5, color: "var(--color-text-muted)" }}>(you)</span>
                      )}
                    </td>
                    <td style={{ padding: "10px 16px", fontSize: 13, color: "var(--color-text-secondary)", borderTop: "1px solid var(--color-border)" }}>{employee.email}</td>
                    <td style={{ padding: "10px 16px", borderTop: "1px solid var(--color-border)" }}>
                      <span style={roleBadgeStyle(employee.role)}>{employee.role === "ADMIN" ? "Admin" : "Employee"}</span>
                    </td>
                    <td style={{ padding: "10px 16px", fontSize: 13, color: "var(--color-text-secondary)", borderTop: "1px solid var(--color-border)" }}>{formatDate(employee.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {selectedEmployee && (
        <EmployeeDetail
          employee={selectedEmployee}
          isSelf={selectedEmployee.id === user?.id}
          isLastAdmin={isLastRemainingAdmin(employees, selectedEmployee.id)}
          onClose={() => setSelectedId(null)}
          onChanged={() => employeesFetch.refetch()}
        />
      )}
    </div>
  );
}
