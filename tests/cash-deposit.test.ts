import { describe, it, expect } from "vitest";
import {
  memoRoToken,
  matchPaymentByRo,
  planCashDeposit,
  cents,
  MAX_OVER_SHORT_CENTS,
  type PaymentLike,
} from "../src/lib/cashsheet/cash-deposit";

describe("memoRoToken", () => {
  it("extracts the leading RO# from a Back Office memo", () => {
    expect(memoRoToken("73534 | GCD | Cash | 06/10/2026")).toBe("73534");
    expect(memoRoToken("73637 | GCD | Visa | 06/22/2026")).toBe("73637");
  });
  it("handles blank / odd memos", () => {
    expect(memoRoToken("")).toBe("");
    expect(memoRoToken(null)).toBe("");
    expect(memoRoToken("   ")).toBe("");
    expect(memoRoToken("no-pipes-here")).toBe("no-pipes-here");
  });
});

describe("matchPaymentByRo", () => {
  const cands: PaymentLike[] = [
    { id: "p1", amount: 1000, privateNote: "73534 | GCD | Cash | 06/10/2026", date: "2026-06-10" },
    { id: "p2", amount: 871.78, privateNote: "73637 | GCD | Cash | 06/22/2026", date: "2026-06-22" },
    { id: "p3", amount: 500, privateNote: "73999 | GCD | Visa | 06/22/2026", date: "2026-06-22" },
  ];

  it("finds the payment whose memo RO matches", () => {
    expect(matchPaymentByRo(cands, "73534", 1000)?.id).toBe("p1");
    expect(matchPaymentByRo(cands, "73637", 872)?.id).toBe("p2");
  });

  it("returns null when no memo RO matches", () => {
    expect(matchPaymentByRo(cands, "00000", 100)).toBeNull();
    expect(matchPaymentByRo(cands, "", 100)).toBeNull();
  });

  it("is tolerant of spacing/case in the RO", () => {
    expect(matchPaymentByRo(cands, " 73534 ", 1000)?.id).toBe("p1");
  });

  it("matches when the sheet RO carries a trailing name", () => {
    // Sheet cell "73534 MCADAM" should still match memo token "73534".
    expect(matchPaymentByRo(cands, "73534 MCADAM", 1000)?.id).toBe("p1");
  });

  it("among same-RO ties picks the amount closest to the deposit", () => {
    const dup: PaymentLike[] = [
      { id: "a", amount: 100, privateNote: "555 | GCD | Cash | 06/01/2026", date: "2026-06-01" },
      { id: "b", amount: 872, privateNote: "555 | GCD | Cash | 06/01/2026", date: "2026-06-01" },
    ];
    expect(matchPaymentByRo(dup, "555", 872)?.id).toBe("b");
  });
});

describe("planCashDeposit", () => {
  it("ties exactly when the deposit equals the payment (GIEL)", () => {
    const p = planCashDeposit(1000, 1000);
    expect(p.overShortCents).toBe(0);
    expect(p.withinThreshold).toBe(true);
    expect(p.paymentCents + p.overShortCents).toBe(p.depositedCents);
  });

  it("computes a small cash-over plug (ANDERSON $871.78 → $872.00)", () => {
    const p = planCashDeposit(871.78, 872.0);
    expect(p.overShortCents).toBe(22); // +$0.22 over
    expect(p.withinThreshold).toBe(true);
    expect(p.paymentCents + p.overShortCents).toBe(p.depositedCents);
  });

  it("computes a short (negative) plug when less was deposited", () => {
    const p = planCashDeposit(100.0, 99.95);
    expect(p.overShortCents).toBe(-5);
    expect(p.withinThreshold).toBe(true);
  });

  it("refuses to plug a difference beyond the sanity cap", () => {
    const p = planCashDeposit(100, 200);
    expect(p.overShortCents).toBe(10000);
    expect(p.withinThreshold).toBe(false);
    expect(Math.abs(p.overShortCents)).toBeGreaterThan(MAX_OVER_SHORT_CENTS);
  });

  it("cents() rounds float noise safely", () => {
    expect(cents(871.78)).toBe(87178);
    expect(cents(0.1 + 0.2)).toBe(30);
  });
});
