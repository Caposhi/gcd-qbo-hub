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

  it("coworker stub has no cash-sheet powers yet (§1)", () => {
    expect(can("coworker", "view_dashboard")).toBe(false);
    expect(can("coworker", "approve_posting")).toBe(false);
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
