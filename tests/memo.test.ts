import { describe, it, expect } from "vitest";
import { buildMemo, buildDocNumber } from "@/lib/cashsheet/memo";
import { parse } from "./fixtures";

describe("memo & doc number (§9)", () => {
  it("formats the memo with all §9 fields and the GCD row UUID", () => {
    const r = parse({ date: "7/7/2026", rcv: "Eddie", name: "McAdam", purpose: "INV", inv: "73735", approvedBy: "MC" }, 6);
    const memo = buildMemo("Jul", r, "gcdqbo-abcdef01-2345-6789-abcd-ef0123456789");
    expect(memo).toContain("Cash Sheet | Jul | Row 6 | 2026-07-07");
    expect(memo).toContain("Rcv/Paid By: Eddie");
    expect(memo).toContain("Name: McAdam");
    expect(memo).toContain("Purpose: INV");
    expect(memo).toContain("INV#: 73735");
    expect(memo).toContain("Approved By: MC");
    expect(memo).toContain("GCD Row ID: gcdqbo-abcdef01-2345-6789-abcd-ef0123456789");
  });

  it("uses '-' placeholders for blank fields", () => {
    const r = parse({ date: "7/8/2026", purpose: "PART", amountPaidOut: "100" }, 7);
    const memo = buildMemo("Jul", r, "gcdqbo-x");
    expect(memo).toContain("Name: -");
    expect(memo).toContain("Approved By: -");
  });

  it("doc number is deterministic and prefixed", () => {
    const uuid = "gcdqbo-abcdef01-2345-6789-abcd-ef0123456789";
    expect(buildDocNumber(uuid)).toBe(buildDocNumber(uuid));
    expect(buildDocNumber(uuid).startsWith("GCD-")).toBe(true);
  });
});
