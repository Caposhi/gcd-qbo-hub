import { describe, it, expect } from "vitest";
import {
  canPostRow,
  modeForStage,
  environmentForStage,
  type RolloutStage,
} from "@/lib/cashsheet/rollout";

const base = { credentialsValid: true, mappingRequiresApproval: false, rowApproved: false };

describe("rollout ladder & posting gate (§12, §16, §22)", () => {
  it("dry_run NEVER posts, even with valid credentials and approval (§19)", () => {
    const res = canPostRow({ ...base, stage: "dry_run", rowApproved: true });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("dry_run_never_posts");
    expect(res.environment).toBeNull();
  });

  it("no valid credentials → never posts in any posting stage (§16, §22)", () => {
    for (const stage of ["sandbox_manual", "sandbox_auto", "live_manual", "live_auto"] as RolloutStage[]) {
      const res = canPostRow({ ...base, stage, credentialsValid: false, rowApproved: true });
      expect(res.allowed).toBe(false);
      expect(res.reason).toBe("credentials_invalid");
    }
  });

  it("manual stages require explicit per-row approval", () => {
    expect(canPostRow({ ...base, stage: "sandbox_manual", rowApproved: false }).allowed).toBe(false);
    expect(canPostRow({ ...base, stage: "sandbox_manual", rowApproved: true }).allowed).toBe(true);
    expect(canPostRow({ ...base, stage: "live_manual", rowApproved: false }).reason).toBe(
      "awaiting_manual_approval"
    );
  });

  it("auto stages post without per-row approval", () => {
    const sb = canPostRow({ ...base, stage: "sandbox_auto" });
    expect(sb.allowed).toBe(true);
    expect(sb.environment).toBe("sandbox");

    const live = canPostRow({ ...base, stage: "live_auto" });
    expect(live.allowed).toBe(true);
    expect(live.environment).toBe("live");
  });

  it("a mapping can force manual approval even at an auto stage (§12 Employee Loans)", () => {
    const res = canPostRow({ ...base, stage: "live_auto", mappingRequiresApproval: true, rowApproved: false });
    expect(res.allowed).toBe(false);
    expect(res.reason).toBe("mapping_requires_manual_approval");
    // ...unless the row is approved.
    expect(canPostRow({ ...base, stage: "live_auto", mappingRequiresApproval: true, rowApproved: true }).allowed).toBe(
      true
    );
  });

  it("stage → mode and environment mapping", () => {
    expect(modeForStage("dry_run")).toBe("dry_run");
    expect(modeForStage("sandbox_auto")).toBe("sandbox_post");
    expect(modeForStage("live_manual")).toBe("live_post");
    expect(environmentForStage("sandbox_manual")).toBe("sandbox");
    expect(environmentForStage("live_auto")).toBe("live");
  });
});
