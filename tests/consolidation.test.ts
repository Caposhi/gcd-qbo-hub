import { describe, it, expect } from "vitest";
import { findConsolidatedMatch, type PaymentCandidate } from "@/lib/deposits/consolidation";

function p(id: string, amount: number, customer: string): PaymentCandidate {
  return { id, amount, customer };
}

describe("findConsolidatedMatch", () => {
  it("finds the same-customer pair that sums to a consolidated charge (the Desroches case)", () => {
    const pool = [
      p("73764", 443.53, "DESROCHES, JUSTIN"),
      p("73775", 978.61, "DESROCHES, JUSTIN"),
      p("73849", 329.83, "DIYASHEV, ISKANDER"),
      p("73848", 195.33, "FLORES, LARRY"),
    ];
    const { match, ambiguous } = findConsolidatedMatch(1422.14, pool);
    expect(ambiguous).toEqual([]);
    expect(match).not.toBeNull();
    expect(match!.ids.sort()).toEqual(["73764", "73775"]);
    expect(match!.customer).toBe("DESROCHES, JUSTIN");
  });

  it("handles a group of 3+ same-customer payments", () => {
    const pool = [p("a", 100, "X"), p("b", 200, "X"), p("c", 300, "X"), p("z", 50, "Y")];
    const { match } = findConsolidatedMatch(600, pool);
    expect(match!.ids.sort()).toEqual(["a", "b", "c"]);
  });

  it("never groups across different customers", () => {
    // 443.53 (Desroches) + 195.33 (Flores) = 638.86, but different customers → no match.
    const pool = [p("1", 443.53, "DESROCHES, JUSTIN"), p("2", 195.33, "FLORES, LARRY")];
    const { match, ambiguous } = findConsolidatedMatch(638.86, pool);
    expect(match).toBeNull();
    expect(ambiguous).toEqual([]);
  });

  it("declines (ambiguous) when two distinct groupings sum to the charge", () => {
    // Same customer, amounts 100,100,100 → target 200 has three distinct pairs.
    const pool = [p("a", 100, "X"), p("b", 100, "X"), p("c", 100, "X")];
    const { match, ambiguous } = findConsolidatedMatch(200, pool);
    expect(match).toBeNull();
    expect(ambiguous.length).toBeGreaterThan(1);
  });

  it("declines when two different customers each have a group summing to the charge", () => {
    const pool = [p("a1", 150, "X"), p("a2", 150, "X"), p("b1", 100, "Y"), p("b2", 200, "Y")];
    const { match, ambiguous } = findConsolidatedMatch(300, pool);
    expect(match).toBeNull();
    expect(ambiguous.length).toBe(2);
  });

  it("returns nothing when no group sums to the charge", () => {
    const pool = [p("a", 100, "X"), p("b", 250, "X")];
    expect(findConsolidatedMatch(999, pool).match).toBeNull();
  });

  it("ignores payments with no customer (can't be safely grouped)", () => {
    const pool = [p("a", 443.53, ""), p("b", 978.61, "")];
    expect(findConsolidatedMatch(1422.14, pool).match).toBeNull();
  });

  it("requires at least two payments (a single-amount match is the 1:1 caller's job)", () => {
    const pool = [p("a", 1422.14, "DESROCHES, JUSTIN")];
    expect(findConsolidatedMatch(1422.14, pool).match).toBeNull();
  });
});
