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

describe("per-sync change tracking (§11)", () => {
  // The engine flags a row as edited-since-last-sync whenever diffSnapshots of
  // the previous vs current snapshot is non-empty — deliberately snapshot-based,
  // not hash-based, so cells that are NOT part of the posting fingerprint (e.g.
  // cashBalanceEnvelope, amountType) are still tracked.
  it("detects a change in a non-fingerprint cell (cashBalanceEnvelope)", () => {
    const prev = { amtCollected: 500, cashBalanceEnvelope: 1200 };
    const curr = { amtCollected: 500, cashBalanceEnvelope: 1350 };
    const diffs = diffSnapshots(prev, curr);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ field: "cashBalanceEnvelope", oldValue: 1200, newValue: 1350 });
  });

  it("an unchanged row across syncs yields no diff (no false edit)", () => {
    const snap = { date: "2026-07-10", name: "Fusion", amtCollected: 500, cashBalanceEnvelope: 1200 };
    expect(diffSnapshots(snap, { ...snap })).toHaveLength(0);
  });

  it("reports every changed field in a multi-cell edit", () => {
    const prev = { name: "Fusion", purpose: "PART", amountPaidOut: 100 };
    const curr = { name: "Explorer", purpose: "PART", amountPaidOut: 250 };
    const diffs = diffSnapshots(prev, curr).map((d) => d.field).sort();
    expect(diffs).toEqual(["amountPaidOut", "name"]);
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
