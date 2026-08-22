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

describe("refund search result shape", () => {
  it("separates sweepable refunds from near misses so the diagnostic can differ", () => {
    // pickRefundsForGap only ever sees the sweepable list; a near miss must not
    // be linkable, but must survive for messaging ("exists, wrong account").
    const search = {
      refunds: [refund("uf", 50)],
      nearMisses: [
        { txnId: "rr9", kind: "RefundReceipt" as const, amount: 1728.05, date: "2026-08-05", reason: 'deposited to "Chase Checking 9680" instead of Undeposited Funds' },
      ],
    };
    const gap = Math.round(1728.05 * 100);
    // Nothing sweepable ties, so no link is made...
    expect(pickRefundsForGap(search.refunds, gap).refunds).toEqual([]);
    // ...but the near miss at exactly the gap is available to explain why.
    expect(search.nearMisses.filter((n) => Math.round(n.amount * 100) === gap)).toHaveLength(1);
  });
});

describe("refund JE direction (§the 08-06 refund)", () => {
  // Back Office credits Undeposited Funds for a refund — the SAME direction as a
  // card fee — so only the memo separates them. These assert the contract the
  // live data proved: credit + non-fee memo = refund; credit + fee memo = fee.
  const REFUND_MEMO = "Applied to: 73962 | OSORIO, STEVEN on 08/05/26 for $-1728.05";
  const FEE_MEMO = "FEE | Credit Card: Visa | OSORIO, STEVEN | 08/05/26";

  it("a refund memo is not a fee memo, and vice versa", () => {
    expect(/credit card/i.test(REFUND_MEMO)).toBe(false);
    expect(/credit card/i.test(FEE_MEMO)).toBe(true);
  });

  it("links the refund JE line by its UF line id", () => {
    const je: UndepositedRefund = {
      txnId: "9911",
      kind: "JournalEntry",
      lineId: "1",
      amount: 1728.05,
      date: "2026-08-05",
      memo: REFUND_MEMO,
      customerName: "OSORIO, STEVEN",
    };
    const pick = pickRefundsForGap([je], Math.round(1728.05 * 100));
    expect(pick.exact).toBe(true);
    expect(pick.refunds[0].lineId).toBe("1");
    expect(refundKey(je)).toBe("JournalEntry:9911:1");
  });

  it("the whole 08-06 payout ties once the refund is swept in", () => {
    const payments = 12505.42;
    const fees = 312.99;
    const refund = 1728.05;
    const net = 10464.38;
    const c = (n: number) => Math.round(n * 100);
    // Before: payments − fees leaves the refund-sized gap the checksum caught.
    expect(c(payments) - c(fees) - c(net)).toBe(c(refund));
    // After: payments − fees − refund is the payout exactly.
    expect(c(payments) - c(fees) - c(refund)).toBe(c(net));
  });
});

describe("same-amount collision (§the second 1,728.05)", () => {
  // QBO's own search showed TWO 1,728.05 items in the window: the OSORIO refund
  // JE on 08-05, and an unrelated PENEV item already deposited on 07-23. Amount
  // alone is not unique, so picking the first match could sweep the wrong txn —
  // the deposit would still tie, which is exactly what makes it dangerous.
  const osorio: UndepositedRefund = {
    txnId: "je-osorio", kind: "JournalEntry", lineId: "1", amount: 1728.05,
    date: "2026-08-05", memo: "Applied to: 73962 | OSORIO, STEVEN", customerName: "OSORIO, STEVEN",
  };
  const other: UndepositedRefund = {
    txnId: "je-other", kind: "JournalEntry", lineId: "1", amount: 1728.05,
    date: "2026-06-14", memo: "Applied to: 70001 | SOMEONE ELSE", customerName: "SOMEONE ELSE",
  };
  const gap = Math.round(1728.05 * 100);

  it("picks the refund closest to the settlement date, not merely the first found", () => {
    // `other` deliberately comes first in the array.
    const pick = pickRefundsForGap([other, osorio], gap, new Set(), "2026-08-06");
    expect(pick.exact).toBe(true);
    expect(pick.refunds.map((r) => r.txnId)).toEqual(["je-osorio"]);
  });

  it("reports that the amount was ambiguous so the choice is auditable", () => {
    const pick = pickRefundsForGap([other, osorio], gap, new Set(), "2026-08-06");
    expect(pick.exactCandidates).toBe(2);
    // A single candidate is not flagged.
    expect(pickRefundsForGap([osorio], gap, new Set(), "2026-08-06").exactCandidates).toBe(1);
  });

  it("still works with no settlement date (falls back to first exact match)", () => {
    const pick = pickRefundsForGap([osorio], gap);
    expect(pick.refunds.map((r) => r.txnId)).toEqual(["je-osorio"]);
  });
});
