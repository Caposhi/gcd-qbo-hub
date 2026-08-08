import { describe, it, expect } from "vitest";
import { matchRegisterToHub, netAmount, summarizeReconciliation, fullyExplained } from "@/lib/cashsheet/reconciliation";

describe("matchRegisterToHub (§20)", () => {
  it("splits a register into matched vs. foreign by transaction id", () => {
    const register = [
      { id: "51544", direction: "out" as const, amount: 1080 }, // hub-posted PR
      { id: "recurring-1", direction: "out" as const, amount: 1080 }, // the recurring template
      { id: "52311", direction: "in" as const, amount: 1100 }, // hub-posted deposit
    ];
    const known = new Set(["51544", "52311"]);
    const { matched, foreign } = matchRegisterToHub(register, known);
    expect(matched.map((t) => t.id)).toEqual(["51544", "52311"]);
    expect(foreign.map((t) => t.id)).toEqual(["recurring-1"]);
  });

  it("an empty known set makes everything foreign", () => {
    const register = [{ id: "x", direction: "out" as const, amount: 10 }];
    const { matched, foreign } = matchRegisterToHub(register, new Set());
    expect(matched).toEqual([]);
    expect(foreign).toHaveLength(1);
  });
});

describe("netAmount (§20)", () => {
  it("deposits add, expenses subtract", () => {
    expect(
      netAmount([
        { id: "1", direction: "in", amount: 800 },
        { id: "2", direction: "out", amount: 120 },
      ])
    ).toBe(680);
  });

  it("empty list nets to zero", () => {
    expect(netAmount([])).toBe(0);
  });
});

// Grounded in the real July 2026 petty-cash reconciliation this feature was
// built to automate — see the session's own numbers, not invented ones.
describe("summarizeReconciliation — the July petty cash story (§20)", () => {
  const beginningBalance = 5119; // June 30 reconciled balance
  const trueEndingBalance = 8300; // the cash sheet's own physical envelope total

  // QBO's register before either fix: 10 real deposits (hub-matched) + 3
  // hub-matched expenses (7/3 pre-automation Jose, the Row 8 PR draw, Ebay
  // parts) + 5 phantom recurring-template "Jose PR" $1,080 expenses.
  const hubDeposits = Array.from({ length: 10 }, (_, i) => ({
    id: `dep-${i}`,
    direction: "in" as const,
    amount: [800, 241, 492, 743, 392, 118, 1500, 930, 225, 1100][i],
  })); // sums to 6541
  const hubExpenses = [
    { id: "pre-0703", direction: "out" as const, amount: 1080 },
    { id: "row8-0709", direction: "out" as const, amount: 1080 },
    { id: "ebay", direction: "out" as const, amount: 120 },
  ];
  const foreignExpenses = Array.from({ length: 5 }, (_, i) => ({
    id: `recurring-${i}`,
    direction: "out" as const,
    amount: 1080,
  })); // sums to 5400

  const register = [...hubDeposits, ...hubExpenses, ...foreignExpenses];
  const knownTxnIds = new Set([...hubDeposits, ...hubExpenses].map((t) => t.id));

  // The two rows sitting un-posted at the time of the reconciliation.
  const missingRows = [
    { id: "row16-0731-pr", direction: "out" as const, amount: 980 },
    { id: "row17-0731-lunch", direction: "out" as const, amount: 100 },
  ];

  it("registerNet matches QBO's actual book balance ($3,980)", () => {
    const { foreign } = matchRegisterToHub(register, knownTxnIds);
    const summary = summarizeReconciliation(register, foreign, missingRows, beginningBalance, trueEndingBalance);
    expect(beginningBalance + summary.registerNet).toBe(3980);
  });

  it("identifies exactly the 5 foreign expenses and their net effect (-$5,400)", () => {
    const { foreign } = matchRegisterToHub(register, knownTxnIds);
    expect(foreign).toHaveLength(5);
    expect(netAmount(foreign)).toBe(-5400);
  });

  it("the residual matches QBO's own reconciliation difference ($4,320)", () => {
    const { foreign } = matchRegisterToHub(register, knownTxnIds);
    const summary = summarizeReconciliation(register, foreign, missingRows, beginningBalance, trueEndingBalance);
    expect(summary.residual).toBe(4320);
  });

  it("foreign + missing findings fully explain the residual, with no leftover mystery", () => {
    const { foreign } = matchRegisterToHub(register, knownTxnIds);
    const summary = summarizeReconciliation(register, foreign, missingRows, beginningBalance, trueEndingBalance);
    // Removing the phantom -5400 and accounting for the still-missing -1080:
    // -1080 − (−5400) = 4320, exactly the residual.
    expect(summary.explainedByFindings).toBe(4320);
    expect(fullyExplained(summary)).toBe(true);
  });

  it("an unexplained leftover means the findings do NOT fully account for the gap", () => {
    const { foreign } = matchRegisterToHub(register, knownTxnIds);
    // Drop one missing row, as if it hadn't been noticed — the findings now
    // undershoot the true residual.
    const partial = summarizeReconciliation(register, foreign, [missingRows[0]], beginningBalance, trueEndingBalance);
    expect(fullyExplained(partial)).toBe(false);
  });

  it("without a beginning/ending balance, there's no residual to explain — findings still stand alone", () => {
    const { foreign } = matchRegisterToHub(register, knownTxnIds);
    const summary = summarizeReconciliation(register, foreign, missingRows, null, null);
    expect(summary.residual).toBeNull();
    expect(fullyExplained(summary)).toBeNull();
    expect(summary.foreignNet).toBe(-5400);
  });
});
