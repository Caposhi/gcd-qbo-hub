import { describe, it, expect } from "vitest";
import { pickRefundsForGap, refundKey, type UndepositedRefund } from "@/lib/qbo/refunds";

function refund(
  txnId: string,
  amount: number,
  kind: UndepositedRefund["kind"] = "RefundReceipt",
  lineId?: string
): UndepositedRefund {
  return { txnId, kind, lineId, amount, date: "2026-08-05", memo: "", customerName: "" };
}

describe("pickRefundsForGap", () => {
  it("links a single refund that closes the gap exactly (the 08-06 payout)", () => {
    // gross − net was 2,041.04 while real fees were 312.99 → a 1,728.05 refund.
    const gap = Math.round(1728.05 * 100);
    const pick = pickRefundsForGap([refund("r1", 1728.05), refund("r2", 50)], gap);
    expect(pick.exact).toBe(true);
    expect(pick.refunds.map((r) => r.txnId)).toEqual(["r1"]);
  });

  it("links several refunds when together they close the gap exactly", () => {
    const gap = Math.round(300 * 100);
    const pick = pickRefundsForGap([refund("a", 100), refund("b", 200)], gap);
    expect(pick.exact).toBe(true);
    expect(pick.refunds.map((r) => r.txnId)).toEqual(["a", "b"]);
  });

  it("prefers one exact refund over summing several", () => {
    const gap = Math.round(300 * 100);
    const pick = pickRefundsForGap([refund("exact", 300), refund("a", 100), refund("b", 200)], gap);
    expect(pick.refunds.map((r) => r.txnId)).toEqual(["exact"]);
  });

  it("links nothing when no combination ties — never assembles a guess", () => {
    const gap = Math.round(1728.05 * 100);
    const pick = pickRefundsForGap([refund("a", 500), refund("b", 700)], gap);
    expect(pick.exact).toBe(false);
    expect(pick.refunds).toEqual([]);
  });

  it("won't reuse a refund already claimed by another payout in the batch", () => {
    const r = refund("r1", 1728.05);
    const used = new Set([refundKey(r)]);
    const pick = pickRefundsForGap([r], Math.round(1728.05 * 100), used);
    expect(pick.exact).toBe(false);
    expect(pick.refunds).toEqual([]);
  });

  it("treats a zero gap as already tied and links nothing", () => {
    const pick = pickRefundsForGap([refund("r1", 100)], 0);
    expect(pick.refunds).toEqual([]);
    expect(pick.exact).toBe(true);
  });

  it("ignores a negative gap (fees already over-explain the payout)", () => {
    const pick = pickRefundsForGap([refund("r1", 100)], -500);
    expect(pick.refunds).toEqual([]);
    expect(pick.exact).toBe(false);
  });

  it("distinguishes a journal-entry refund line from a refund receipt", () => {
    const je = refund("je1", 1728.05, "JournalEntry", "3");
    const pick = pickRefundsForGap([je], Math.round(1728.05 * 100));
    expect(pick.refunds[0].kind).toBe("JournalEntry");
    expect(pick.refunds[0].lineId).toBe("3");
    // The key includes the line so two lines of one JE are tracked separately.
    expect(refundKey(je)).toBe("JournalEntry:je1:3");
    expect(refundKey(refund("r1", 5))).toBe("RefundReceipt:r1:");
  });
});
