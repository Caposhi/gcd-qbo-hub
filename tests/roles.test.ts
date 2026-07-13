import { describe, it, expect } from "vitest";
import { can, assertCan, PermissionError } from "@/lib/auth/roles";

describe("role-gated actions (§14, §18, §20)", () => {
  it("owner_admin can do everything gated", () => {
    for (const p of [
      "approve_posting",
      "edit_mappings",
      "change_rollout_stage",
      "toggle_live_mode",
      "connect_qbo",
      "manage_users",
    ] as const) {
      expect(can("owner_admin", p)).toBe(true);
    }
  });

  it("reviewer CANNOT approve postings or change mappings/stage (critical §20)", () => {
    expect(can("reviewer", "approve_posting")).toBe(false);
    expect(can("reviewer", "edit_mappings")).toBe(false);
    expect(can("reviewer", "change_rollout_stage")).toBe(false);
    expect(can("reviewer", "toggle_live_mode")).toBe(false);
  });

  it("reviewer CAN view and mark warnings reviewed", () => {
    expect(can("reviewer", "view_dashboard")).toBe(true);
    expect(can("reviewer", "mark_warning_reviewed")).toBe(true);
    expect(can("reviewer", "run_dry_run")).toBe(true);
  });

  it("coworker has no cash-sheet powers", () => {
    expect(can("coworker", "view_dashboard")).toBe(false);
    expect(can("coworker", "approve_posting")).toBe(false);
    expect(can("coworker", "edit_mappings")).toBe(false);
  });

  it("coworker role is active for the Ask My Client portal (§1)", () => {
    expect(can("coworker", "view_coworker_portal")).toBe(true);
    expect(can("coworker", "answer_coworker_questions")).toBe(true);
    // A coworker answers questions but does not raise them.
    expect(can("coworker", "ask_coworker_questions")).toBe(false);
    // No access to the other prototype modules.
    expect(can("coworker", "use_assistant")).toBe(false);
    expect(can("coworker", "edit_projections")).toBe(false);
  });

  it("reviewer can explore prototype modules but not edit them", () => {
    expect(can("reviewer", "view_projections")).toBe(true);
    expect(can("reviewer", "use_assistant")).toBe(true);
    expect(can("reviewer", "ask_coworker_questions")).toBe(true);
    expect(can("reviewer", "edit_projections")).toBe(false);
    expect(can("reviewer", "answer_coworker_questions")).toBe(false);
  });

  it("AI council: owner can run, reviewer can only view, coworker neither (§ Phase 3)", () => {
    expect(can("owner_admin", "run_ai_council")).toBe(true);
    expect(can("owner_admin", "view_ai_council")).toBe(true);
    expect(can("reviewer", "view_ai_council")).toBe(true);
    expect(can("reviewer", "run_ai_council")).toBe(false);
    expect(can("coworker", "view_ai_council")).toBe(false);
  });

  it("anonymous / null role is denied everything", () => {
    expect(can(null, "view_dashboard")).toBe(false);
    expect(can(undefined, "approve_posting")).toBe(false);
  });

  it("assertCan throws PermissionError for a forbidden action", () => {
    expect(() => assertCan("reviewer", "approve_posting")).toThrow(PermissionError);
    expect(() => assertCan("owner_admin", "approve_posting")).not.toThrow();
  });
});
