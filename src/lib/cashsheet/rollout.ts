/**
 * Staged rollout ladder & posting gate (§12, §16, §22).
 *
 * This is the safety interlock for a real accounting system. It decides, for a
 * single row, whether the automation may actually create a QBO transaction
 * right now — and to which environment. Live auto-posting is NEVER the default
 * and is only reachable when the config has been deliberately advanced to
 * `live_auto` by an owner (§12, §22).
 *
 * Pure and unit-tested (§20): given a stage, credential validity, the mapping's
 * approval requirement, and whether a reviewer approved the row, the answer is
 * deterministic.
 */

export type RolloutStage =
  | "dry_run"
  | "sandbox_manual"
  | "sandbox_auto"
  | "live_manual"
  | "live_auto";

export type SyncMode = "dry_run" | "sandbox_post" | "live_post";

export type QboEnvironment = "sandbox" | "live";

export const ROLLOUT_STAGES: RolloutStage[] = [
  "dry_run",
  "sandbox_manual",
  "sandbox_auto",
  "live_manual",
  "live_auto",
];

/** The sync mode implied by a stage. */
export function modeForStage(stage: RolloutStage): SyncMode {
  switch (stage) {
    case "dry_run":
      return "dry_run";
    case "sandbox_manual":
    case "sandbox_auto":
      return "sandbox_post";
    case "live_manual":
    case "live_auto":
      return "live_post";
  }
}

/** The QBO environment a stage targets (dry_run still evaluates against sandbox). */
export function environmentForStage(stage: RolloutStage): QboEnvironment {
  return stage === "live_manual" || stage === "live_auto" ? "live" : "sandbox";
}

export function isManualStage(stage: RolloutStage): boolean {
  return stage === "sandbox_manual" || stage === "live_manual";
}

export function isAutoStage(stage: RolloutStage): boolean {
  return stage === "sandbox_auto" || stage === "live_auto";
}

export interface PostGateInput {
  stage: RolloutStage;
  /** Whether valid QBO credentials exist for the stage's environment (§16). */
  credentialsValid: boolean;
  /** The purpose mapping's requires_manual_approval flag (§7, §12). */
  mappingRequiresApproval: boolean;
  /** Whether a reviewer/admin has explicitly approved this specific row. */
  rowApproved: boolean;
}

export interface PostGateResult {
  allowed: boolean;
  /** null when not allowed. */
  environment: QboEnvironment | null;
  mode: SyncMode;
  /** Machine-readable reason when not allowed. */
  reason:
    | "ok"
    | "dry_run_never_posts"
    | "credentials_invalid"
    | "awaiting_manual_approval"
    | "mapping_requires_manual_approval";
}

/**
 * The single decision point for "may this row post now?".
 *
 * Order of checks matters:
 *   1. dry_run never posts, period (§12, §19).
 *   2. no valid credentials → never post (§16, §22).
 *   3. manual stage → requires per-row approval.
 *   4. auto stage → posts, UNLESS the mapping itself demands manual approval
 *      (e.g. Employee Loans stay manual even after Bank Deposits auto-post, §12).
 */
export function canPostRow(input: PostGateInput): PostGateResult {
  const mode = modeForStage(input.stage);
  const environment = environmentForStage(input.stage);

  if (input.stage === "dry_run") {
    return { allowed: false, environment: null, mode, reason: "dry_run_never_posts" };
  }

  if (!input.credentialsValid) {
    return { allowed: false, environment: null, mode, reason: "credentials_invalid" };
  }

  if (isManualStage(input.stage)) {
    return input.rowApproved
      ? { allowed: true, environment, mode, reason: "ok" }
      : { allowed: false, environment: null, mode, reason: "awaiting_manual_approval" };
  }

  // Auto stage.
  if (input.mappingRequiresApproval && !input.rowApproved) {
    return {
      allowed: false,
      environment: null,
      mode,
      reason: "mapping_requires_manual_approval",
    };
  }

  return { allowed: true, environment, mode, reason: "ok" };
}
