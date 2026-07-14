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
  | "manage_users"
  // Financial Projections module (prototype)
  | "view_projections"
  | "edit_projections"
  // AI Report Assistant module (prototype)
  | "use_assistant"
  // Coworker Portal module (prototype) — "Ask My Client"
  | "view_coworker_portal"
  | "ask_coworker_questions"
  | "answer_coworker_questions"
  | "import_coworker_questions"
  // AI C-suite (Financial Projections module, Phase 3)
  | "view_ai_council"
  | "run_ai_council"
  // Tekmetric integration module (Build Phase 4 groundwork) — read-only
  | "view_tekmetric"
  | "refresh_tekmetric"
  // Call-transcript integration (Build Phase 4) — read-only aggregated insights
  | "view_transcripts"
  | "refresh_transcripts";

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
    // Full access to the prototype modules too.
    "view_projections",
    "edit_projections",
    "use_assistant",
    "view_coworker_portal",
    "ask_coworker_questions",
    "answer_coworker_questions",
    "import_coworker_questions",
    "view_ai_council",
    "run_ai_council",
    // Tekmetric: owners can view the operations page and trigger a refresh.
    "view_tekmetric",
    "refresh_tekmetric",
    // Transcripts: owners can view aggregated call insights and refresh them.
    "view_transcripts",
    "refresh_transcripts",
  ],
  reviewer: [
    "view_dashboard",
    "mark_warning_reviewed",
    "recheck_qbo_match",
    "run_dry_run",
    // Reviewers can explore projections and the assistant, and raise coworker
    // questions, but not edit projections or answer on the coworker's behalf.
    "view_projections",
    "use_assistant",
    "view_coworker_portal",
    "ask_coworker_questions",
    // Reviewers can pull the "Ask My Client" transactions in from QBO (read-only).
    "import_coworker_questions",
    // Reviewers can read the AI council's output, but only an owner can spend
    // tokens running it.
    "view_ai_council",
    // Reviewers can view Tekmetric operations, but not trigger a refresh.
    "view_tekmetric",
    // Reviewers can read aggregated call insights, but not trigger a refresh.
    "view_transcripts",
  ],
  // The coworker role is now active for the "Ask My Client" portal (§1): a
  // coworker can view the portal and answer questions directed at them, but has
  // no Cash Sheet Sync powers.
  coworker: ["view_coworker_portal", "answer_coworker_questions"],
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
