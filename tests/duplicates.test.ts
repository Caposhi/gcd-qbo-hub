import { describe, it, expect } from "vitest";
import {
  findDuplicateRowIds,
  findPossibleDuplicate,
  isAlreadyPosted,
  type ScannedRowRef,
  type PostedRowRef,
} from "@/lib/cashsheet/duplicates";

describe("duplicate detection (§10)", () => {
  it("detects a hidden row id copied onto multiple rows", () => {
    const rows: ScannedRowRef[] = [
      { rowUuid: "gcdqbo-1", rowNumber: 4, tabName: "Jul", fingerprint: "a" },
      { rowUuid: "gcdqbo-1", rowNumber: 9, tabName: "Jul", fingerprint: "b" },
      { rowUuid: "gcdqbo-2", rowNumber: 5, tabName: "Jul", fingerprint: "c" },
    ];
    const dupes = findDuplicateRowIds(rows);
    expect(dupes.has("gcdqbo-1")).toBe(true);
    expect(dupes.get("gcdqbo-1")).toHaveLength(2);
    expect(dupes.has("gcdqbo-2")).toBe(false);
  });

  it("ignores rows without a uuid", () => {
    const rows: ScannedRowRef[] = [
      { rowUuid: null, rowNumber: 4, tabName: "Jul", fingerprint: "a" },
      { rowUuid: null, rowNumber: 5, tabName: "Jul", fingerprint: "a" },
    ];
    expect(findDuplicateRowIds(rows).size).toBe(0);
  });

  it("possible duplicate: matching fingerprint on a DIFFERENT uuid (§10)", () => {
    const posted: PostedRowRef[] = [{ rowUuid: "gcdqbo-A", fingerprint: "fp1", qboTransactionId: "145" }];
    // Copied row without the hidden id (uuid null) but same fingerprint.
    expect(findPossibleDuplicate(null, "fp1", posted)?.qboTransactionId).toBe("145");
    // Different uuid, same fingerprint → possible duplicate.
    expect(findPossibleDuplicate("gcdqbo-B", "fp1", posted)).not.toBeNull();
    // Same uuid → this is the same row, NOT a duplicate.
    expect(findPossibleDuplicate("gcdqbo-A", "fp1", posted)).toBeNull();
    // No fingerprint match → nothing.
    expect(findPossibleDuplicate("gcdqbo-B", "fp-other", posted)).toBeNull();
  });

  it("already-posted rows are never re-posted (§10)", () => {
    expect(isAlreadyPosted("145")).toBe(true);
    expect(isAlreadyPosted("")).toBe(false);
    expect(isAlreadyPosted(null)).toBe(false);
    expect(isAlreadyPosted(undefined)).toBe(false);
  });
});
