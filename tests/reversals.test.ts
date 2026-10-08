import { describe, it, expect } from "vitest";
import { parseReversalMemo, paymentRo, pairReversals, reversalPairKey, type OpenPayment, type OpenReversal } from "@/lib/qbo/reversals";

// Fictional data shaped like Tekmetric Back Office's QBO export.
const pay = (id: string, amount: number, method: string, ro = "70001", name = "DOE, JANE", date = "2026-03-10"): OpenPayment => ({
  id,
  amount,
  date,
  customerName: name,
  method,
  refNum: method,
  note: `${ro} | GCD | ${method} | ${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}`,
});
const rev = (jeId: string, amount: number, ref: string, ro = "70001", name = "DOE, JANE", date = "03/10/26"): OpenReversal => ({
  jeId,
  lineId: "0",
  amount,
  date: "2026-03-10",
  customerName: name,
  memo: `Applied to: ${ro} | ${name} on ${date} for $-${amount.toFixed(2)}`,
  ref,
});

describe("parseReversalMemo", () => {
  it("reads repair order, customer, date and amount", () => {
    expect(parseReversalMemo("Applied to: 70001 | DOE, JANE on 03/10/26 for $-1500.00")).toEqual({
      ro: "70001",
      name: "DOE, JANE",
      date: "2026-03-10",
      amount: 1500,
    });
    expect(parseReversalMemo("Applied to: 70002 | ROE, RICK on 3/9/26 for $-1,206.10")?.amount).toBe(1206.1);
  });
  it("ignores fee and other memos", () => {
    expect(parseReversalMemo("FEE | Credit Card: Visa | DOE, JANE | 03/10/26")).toBeNull();
    expect(parseReversalMemo("Reverse duplicate fees")).toBeNull();
  });
});

describe("pairReversals", () => {
  it("pairs a reversal with the open payment it cancels, never the real ones", () => {
    // One repair paid by Financing, Visa and cash; two "Other" entries were each reversed.
    const payments = [
      pay("p-other-1", 1000, "Other"),
      pay("p-visa", 1000, "Visa"),
      pay("p-fin", 1000, "Financing (i.e. snap, synchrony)"),
      pay("p-other-2", 1000, "Other"),
      pay("p-cash", 47.78, "Cash"),
    ];
    const pairs = pairReversals(payments, [rev("j1", 1000, "Other"), rev("j2", 1000, "Other")]);
    expect(pairs.map((p) => p.paymentId).sort()).toEqual(["p-other-1", "p-other-2"]);
    expect(pairs.every((p) => p.ro === "70001")).toBe(true);
  });

  it("of two identical payments with one reversal, only one is cancelled", () => {
    const pairs = pairReversals([pay("a", 500, "Visa"), pay("b", 500, "Visa")], [rev("j", 500, "Visa")]);
    expect(pairs).toHaveLength(1);
  });

  it("needs the same repair order, amount and customer", () => {
    expect(pairReversals([pay("x", 500, "Other", "70009")], [rev("j", 500, "Other")])).toEqual([]);
    expect(pairReversals([pay("x", 500.01, "Other")], [rev("j", 500, "Other")])).toEqual([]);
    expect(pairReversals([pay("x", 500, "Other", "70001", "ROE, RICK")], [rev("j", 500, "Other")])).toEqual([]);
  });

  it("respects the method the reversal names, and pairs without one when it names none", () => {
    expect(pairReversals([pay("x", 500, "Visa")], [rev("j", 500, "Other")])).toEqual([]);
    expect(pairReversals([pay("x", 500, "Visa")], [rev("j", 500, "")])).toHaveLength(1);
  });

  it("builds a stable key for the cleanup form", () => {
    const [p] = pairReversals([pay("x", 500, "Other")], [rev("j", 500, "Other")]);
    expect(reversalPairKey(p)).toBe("x~j~0");
    expect(paymentRo("70001 | GCD | Other | 03/10/2026")).toBe("70001");
  });
});
