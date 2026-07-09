import { describe, it, expect } from "vitest";
import {
  projectCashFlow,
  summarize,
  parseAssumptions,
  DEFAULT_ASSUMPTIONS,
  type ProjectionAssumptions,
} from "@/lib/projections/engine";

describe("projectCashFlow — flat scenario (0 growth)", () => {
  it("accumulates linearly when growth is zero", () => {
    const rows = projectCashFlow({
      openingBalance: 1000,
      horizonMonths: 3,
      monthlyInflow: 500,
      monthlyOutflow: 200,
      monthlyGrowthPct: 0,
    });
    expect(rows).toHaveLength(3);
    // net = 300 each month
    expect(rows[0].net).toBe(300);
    expect(rows[0].endingBalance).toBe(1300);
    expect(rows[1].endingBalance).toBe(1600);
    expect(rows[2].endingBalance).toBe(1900);
    // inflow/outflow are flat with no growth
    expect(rows.every((r) => r.inflow === 500 && r.outflow === 200)).toBe(true);
  });
});

describe("projectCashFlow — positive growth compounds", () => {
  it("scales inflow and outflow by (1+g)^i", () => {
    const rows = projectCashFlow({
      openingBalance: 0,
      horizonMonths: 3,
      monthlyInflow: 100,
      monthlyOutflow: 0,
      monthlyGrowthPct: 10,
    });
    expect(rows[0].inflow).toBe(100); // (1.1)^0
    expect(rows[1].inflow).toBe(110); // (1.1)^1
    expect(rows[2].inflow).toBeCloseTo(121, 2); // (1.1)^2
    // ending balance is the running sum of inflow
    expect(rows[2].endingBalance).toBeCloseTo(331, 2);
  });

  it("handles negative growth (decline)", () => {
    const rows = projectCashFlow({
      openingBalance: 0,
      horizonMonths: 2,
      monthlyInflow: 100,
      monthlyOutflow: 0,
      monthlyGrowthPct: -50,
    });
    expect(rows[0].inflow).toBe(100);
    expect(rows[1].inflow).toBe(50);
  });
});

describe("projectCashFlow — one-offs", () => {
  it("lands a one-off in the right month and affects ending balance", () => {
    const rows = projectCashFlow({
      openingBalance: 0,
      horizonMonths: 3,
      monthlyInflow: 0,
      monthlyOutflow: 0,
      monthlyGrowthPct: 0,
      oneOffs: [{ monthIndex: 1, amount: 5000, label: "Loan draw" }],
    });
    expect(rows[0].net).toBe(0);
    expect(rows[0].endingBalance).toBe(0);
    expect(rows[1].net).toBe(5000);
    expect(rows[1].endingBalance).toBe(5000);
    expect(rows[1].oneOffs).toEqual([{ amount: 5000, label: "Loan draw" }]);
    // carries forward
    expect(rows[2].endingBalance).toBe(5000);
  });

  it("supports negative one-offs (cash out) and multiple in one month", () => {
    const rows = projectCashFlow({
      openingBalance: 1000,
      horizonMonths: 1,
      monthlyInflow: 0,
      monthlyOutflow: 0,
      monthlyGrowthPct: 0,
      oneOffs: [
        { monthIndex: 0, amount: -300, label: "Tax" },
        { monthIndex: 0, amount: 100, label: "Refund" },
      ],
    });
    expect(rows[0].net).toBe(-200);
    expect(rows[0].endingBalance).toBe(800);
    expect(rows[0].oneOffs).toHaveLength(2);
  });

  it("ignores one-offs outside the horizon range", () => {
    const rows = projectCashFlow({
      openingBalance: 0,
      horizonMonths: 2,
      monthlyInflow: 0,
      monthlyOutflow: 0,
      monthlyGrowthPct: 0,
      oneOffs: [
        { monthIndex: 5, amount: 999, label: "Too late" },
        { monthIndex: -1, amount: 999, label: "Too early" },
      ],
    });
    expect(rows.every((r) => r.net === 0 && r.oneOffs.length === 0)).toBe(true);
  });
});

describe("projectCashFlow — horizon clamping", () => {
  it("clamps horizon below 1 up to 1", () => {
    expect(projectCashFlow({ ...DEFAULT_ASSUMPTIONS, horizonMonths: 0 })).toHaveLength(1);
    expect(projectCashFlow({ ...DEFAULT_ASSUMPTIONS, horizonMonths: -10 })).toHaveLength(1);
  });

  it("clamps horizon above 60 down to 60", () => {
    expect(projectCashFlow({ ...DEFAULT_ASSUMPTIONS, horizonMonths: 999 })).toHaveLength(60);
  });
});

describe("projectCashFlow — labels", () => {
  it("advances a parseable 'Mon YYYY' start label across year boundaries", () => {
    const rows = projectCashFlow({
      ...DEFAULT_ASSUMPTIONS,
      horizonMonths: 3,
      startLabel: "Nov 2026",
    });
    expect(rows.map((r) => r.label)).toEqual(["Nov 2026", "Dec 2026", "Jan 2027"]);
  });

  it("falls back to 'Month N' when start label is missing or invalid", () => {
    const rows = projectCashFlow({ ...DEFAULT_ASSUMPTIONS, horizonMonths: 2, startLabel: "garbage" });
    expect(rows.map((r) => r.label)).toEqual(["Month 1", "Month 2"]);
  });
});

describe("summarize", () => {
  it("finds the lowest balance and the month it occurs", () => {
    const rows = projectCashFlow({
      openingBalance: 1000,
      horizonMonths: 3,
      monthlyInflow: 0,
      monthlyOutflow: 0,
      monthlyGrowthPct: 0,
      startLabel: "Jan 2026",
      oneOffs: [
        { monthIndex: 1, amount: -900, label: "Dip" },
        { monthIndex: 2, amount: 500, label: "Recovery" },
      ],
    });
    const s = summarize(rows);
    expect(s.endingBalance).toBe(600); // 1000 -900 +500
    expect(s.lowestBalance).toBe(100); // month index 1
    expect(s.lowestMonthLabel).toBe("Feb 2026");
    expect(s.totalNet).toBe(-400);
  });

  it("returns zeros for an empty projection", () => {
    const s = summarize([]);
    expect(s).toEqual({ endingBalance: 0, lowestBalance: 0, lowestMonthLabel: "", totalNet: 0 });
  });
});

describe("parseAssumptions", () => {
  it("coerces missing/invalid input to defaults", () => {
    const a = parseAssumptions(null);
    expect(a).toEqual({ ...DEFAULT_ASSUMPTIONS });
  });

  it("coerces bad field types to defaults and keeps valid ones", () => {
    const a = parseAssumptions({
      openingBalance: "5000",
      horizonMonths: "999", // clamped to 60
      monthlyInflow: "not a number",
      monthlyGrowthPct: 3,
      oneOffs: "nope",
      startLabel: 42,
    });
    expect(a.openingBalance).toBe(5000);
    expect(a.horizonMonths).toBe(60);
    expect(a.monthlyInflow).toBe(DEFAULT_ASSUMPTIONS.monthlyInflow);
    expect(a.monthlyGrowthPct).toBe(3);
    expect(a.oneOffs).toEqual([]);
    expect(a.startLabel).toBe("");
  });

  it("filters out malformed one-offs and coerces valid ones", () => {
    const a = parseAssumptions({
      oneOffs: [
        { monthIndex: 2, amount: 100, label: "Good" },
        { monthIndex: "bad", amount: 100, label: "x" },
        { amount: 50 },
        "junk",
        null,
      ],
    });
    expect(a.oneOffs).toEqual([{ monthIndex: 2, amount: 100, label: "Good" }]);
  });

  it("produces assumptions the engine can consume without throwing", () => {
    const a: ProjectionAssumptions = parseAssumptions({ garbage: true });
    expect(() => projectCashFlow(a)).not.toThrow();
  });
});
