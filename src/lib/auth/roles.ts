/**
 * Roles & permission gating (§1, §14, §18).
 *
 * Roles (extensible from day one):
 *   - owner_admin : full access — mappings, live-mode toggle, rollout stage,
 *                   approvals, everything.
 *   - reviewer    : view the dashboard, mark warnings reviewed. CANNOT change
 *                   mappings, advance the rollout stage, or approve postings.
 *   - coworker    : reserved stub for the future "Ask My Client" portal (§1).
 *                   No hub dashboard privileges yet.
 *
 * Pure and unit-tested (§20): a reviewer must never be able to approve a
 * posting or change mappings/stage.
 */

export type Role = "owner_admin" | "reviewer" | "coworker";

export const ROLES: Role[] = ["owner_admin", "reviewer", "coworker"];

/** Every gated action in the hub. */
export type Permission =
  | "view_dashboard"
  | "mark_warning_reviewed"
  | "recheck_qbo_match"
  | "run_dry_run"
  | "run_sandbox_sync"
  | "approve_posting"
  | "edit_mappings"
  | "change_rollout_stage"
  | "toggle_live_mode"
  | "connect_qbo"
  | "manage_users";

const PERMISSIONS: Record<Role, Permission[]> = {
  owner_admin: [
    "view_dashboard",
    "mark_warning_reviewed",
    "recheck_qbo_match",
    "run_dry_run",
    "run_sandbox_sync",
    "approve_posting",
    "edit_mappings",
    "change_rollout_stage",
    "toggle_live_mode",
    "connect_qbo",
    "manage_users",
  ],
  reviewer: [
    "view_dashboard",
    "mark_warning_reviewed",
    "recheck_qbo_match",
    "run_dry_run",
  ],
  // The coworker stub can view its (future) portal but has no cash-sheet powers.
  coworker: [],
};

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return PERMISSIONS[role]?.includes(permission) ?? false;
}

/** Throwing guard for server actions / route handlers. */
export function assertCan(role: Role | null | undefined, permission: Permission): void {
  if (!can(role, permission)) {
    throw new PermissionError(permission, role ?? null);
  }
}

export class PermissionError extends Error {
  constructor(
    public permission: Permission,
    public role: Role | null
  ) {
    super(`Role "${role ?? "anonymous"}" is not permitted to: ${permission}`);
    this.name = "PermissionError";
  }
}
