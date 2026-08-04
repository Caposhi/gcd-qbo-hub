import { describe, it, expect } from "vitest";
import {
  findDuplicateRowIds,
  findPossibleDuplicate,
  isAlreadyPosted,
  normalizeInvNumber,
  findInvNumberSibling,
  type ScannedRowRef,
  type PostedRowRef,
  type InvNumberRowRef,
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

describe("INV# re-identification guard (§4, §10, §11)", () => {
  it("normalizes an INV#/RO to its leading token, upper-cased", () => {
    expect(normalizeInvNumber("73801")).toBe("73801");
    expect(normalizeInvNumber("73663 GILLIS")).toBe("73663");
    expect(normalizeInvNumber("  73801  ")).toBe("73801");
    expect(normalizeInvNumber(null)).toBe("");
    expect(normalizeInvNumber("")).toBe("");
  });

  it("flags a row whose INV# already resolved on a DIFFERENT row after a name edit — the WITYY -> WITTY case", () => {
    // A typo fix ("WITYY" -> "WITTY") changes the content fingerprint, so the
    // engine sees what looks like a brand-new row for the same invoice. The
    // ORIGINAL row already has a QBO deposit; the corrected row must be
    // caught here even though its fingerprint no longer matches anything.
    const siblings: InvNumberRowRef[] = [
      { id: "row-wityy", tabName: "July", invNumber: "73801", status: "Deposit Created" },
    ];
    const sibling = findInvNumberSibling(
      { id: "row-witty", tabName: "July", invNumber: "73801" },
      ["Posted", "Posted With Warning", "Deposit Created"],
      siblings
    );
    expect(sibling?.id).toBe("row-wityy");
  });

  it("flags a row whose INV# already resolved after a date edit — the VEGA 7/21 -> 7/24 case", () => {
    const siblings: InvNumberRowRef[] = [
      { id: "row-vega-721", tabName: "July", invNumber: "73845", status: "Deposit Created" },
    ];
    const sibling = findInvNumberSibling(
      { id: "row-vega-724", tabName: "July", invNumber: "73845" },
      ["Posted", "Posted With Warning", "Deposit Created"],
      siblings
    );
    expect(sibling).not.toBeNull();
  });

  it("does not flag a row against its own prior state (same id excluded)", () => {
    const siblings: InvNumberRowRef[] = [
      { id: "row-1", tabName: "July", invNumber: "73801", status: "Deposit Created" },
    ];
    expect(
      findInvNumberSibling({ id: "row-1", tabName: "July", invNumber: "73801" }, ["Deposit Created"], siblings)
    ).toBeNull();
  });

  it("does not flag across different tabs (same INV# can legitimately repeat by month)", () => {
    const siblings: InvNumberRowRef[] = [
      { id: "row-june", tabName: "June", invNumber: "73801", status: "Deposit Created" },
    ];
    expect(
      findInvNumberSibling({ id: "row-july", tabName: "July", invNumber: "73801" }, ["Deposit Created"], siblings)
    ).toBeNull();
  });

  it("does not flag when the sibling isn't in a resolved status yet", () => {
    const siblings: InvNumberRowRef[] = [
      { id: "row-1", tabName: "July", invNumber: "73801", status: "Ready To Post" },
    ];
    expect(
      findInvNumberSibling({ id: "row-2", tabName: "July", invNumber: "73801" }, ["Deposit Created"], siblings)
    ).toBeNull();
  });

  it("a row with no INV# is never matched (nothing to key off of)", () => {
    const siblings: InvNumberRowRef[] = [
      { id: "row-1", tabName: "July", invNumber: null, status: "Deposit Created" },
    ];
    expect(
      findInvNumberSibling({ id: "row-2", tabName: "July", invNumber: null }, ["Deposit Created"], siblings)
    ).toBeNull();
  });
});
