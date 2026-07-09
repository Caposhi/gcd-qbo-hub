import { describe, it, expect } from "vitest";
import {
  diffSnapshots,
  isChangedAfterPosting,
  findRemovedAfterPosting,
} from "@/lib/cashsheet/detection";

describe("changed-after-posting detection (§11)", () => {
  it("flags a hash mismatch as changed", () => {
    expect(isChangedAfterPosting("hashA", "hashB")).toBe(true);
    expect(isChangedAfterPosting("hashA", "hashA")).toBe(false);
  });

  it("no baseline hash → not flagged", () => {
    expect(isChangedAfterPosting(null, "hashB")).toBe(false);
  });

  it("produces a field-level diff (§11)", () => {
    const original = { amountPaidOut: 1080, purpose: "PART", name: "Fusion" };
    const current = { amountPaidOut: 1500, purpose: "PART", name: "Fusion" };
    const diffs = diffSnapshots(original, current);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ field: "amountPaidOut", oldValue: 1080, newValue: 1500 });
  });

  it("ignores whitespace-only and row-number churn", () => {
    const original = { name: "Fusion", rowNumber: 4 };
    const current = { name: " Fusion ", rowNumber: 40 };
    expect(diffSnapshots(original, current)).toHaveLength(0);
  });
});

describe("removed-after-posting detection (§11)", () => {
  it("flags posted uuids that vanished from a full tab scan", () => {
    const posted = ["gcdqbo-1", "gcdqbo-2", "gcdqbo-3"];
    const seen = new Set(["gcdqbo-1", "gcdqbo-3"]); // #2 disappeared
    expect(findRemovedAfterPosting(posted, seen)).toEqual(["gcdqbo-2"]);
  });

  it("a moved row (still present by uuid) is NOT removed (§11)", () => {
    const posted = ["gcdqbo-1"];
    const seen = ["gcdqbo-1"]; // moved to a new row number but still found
    expect(findRemovedAfterPosting(posted, seen)).toEqual([]);
  });
});
