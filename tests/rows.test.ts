import { describe, it, expect } from "vitest";
import { isTransactionCandidate, isBlankRow, validateRow } from "@/lib/cashsheet/rows";
import { AUTOMATION_START_DATE } from "@/lib/cashsheet/dates";
import { parse } from "./fixtures";

describe("row parsing, candidacy & validation (§5)", () => {
  it("parses the expected first July row (§19)", () => {
    const r = parse({ date: "7/7/2026", rcv: "Eddie", name: "McAdam", purpose: "INV", inv: "73735", amtCollected: "$800.00" }, 6);
    expect(r.amountType).toBe("amt_collected");
    expect(r.amount).toBe(800);
    expect(r.name).toBe("McAdam");
    expect(r.purpose).toBe("INV");
    expect(r.rowNumber).toBe(6);
  });

  it("blank rows are detected and ignored (§5)", () => {
    const r = parse({});
    expect(isBlankRow(r)).toBe(true);
    expect(isTransactionCandidate(r)).toBe(false);
  });

  it("a row with any amount is a candidate (§5)", () => {
    expect(isTransactionCandidate(parse({ amountPaidOut: "50" }))).toBe(true);
    expect(isTransactionCandidate(parse({ bankDeposit: "1000" }))).toBe(true);
    // No amount at all → not a candidate even with text.
    expect(isTransactionCandidate(parse({ purpose: "PART", name: "X" }))).toBe(false);
  });

  it("rejects rows with more than one amount column populated (§5)", () => {
    const r = parse({ date: "7/8/2026", purpose: "PART", amtCollected: "10", amountPaidOut: "20" });
    const v = validateRow(r, AUTOMATION_START_DATE);
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => /more than one amount/i.test(e))).toBe(true);
  });

  it("requires a positive amount, date, and purpose (§5)", () => {
    expect(validateRow(parse({ date: "7/8/2026", purpose: "PART", amountPaidOut: "0" }), AUTOMATION_START_DATE).valid).toBe(false);
    expect(validateRow(parse({ purpose: "PART", amountPaidOut: "10" }), AUTOMATION_START_DATE).errors).toContain(
      "Missing or unparseable date"
    );
    expect(validateRow(parse({ date: "7/8/2026", amountPaidOut: "10" }), AUTOMATION_START_DATE).errors).toContain(
      "Missing purpose"
    );
  });

  it("future-dated valid rows are NOT rejected (§5)", () => {
    const r = parse({ date: "12/25/2026", purpose: "PART", amountPaidOut: "100" });
    const v = validateRow(r, AUTOMATION_START_DATE);
    expect(v.valid).toBe(true);
  });

  it("flags before-start-date rows with a warning (§3)", () => {
    const r = parse({ date: "1/5/2026", purpose: "PART", amountPaidOut: "100" });
    const v = validateRow(r, AUTOMATION_START_DATE);
    expect(v.warnings.some((w) => /before the automation start date/i.test(w))).toBe(true);
  });
});
