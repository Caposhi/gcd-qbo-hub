import { describe, it, expect } from "vitest";
import { linearRegression, predict, confidenceOf } from "@/lib/projections/regression/ols";
import { deriveBaseline, type MonthlyHistory } from "@/lib/projections/regression/baseline";
import {
  projectFinancials,
  summarizeV2,
  tornado,
  effective,
  type ProjectionInputsV2,
} from "@/lib/projections/engine-v2";
import {
  parseScenarioV2,
  inputsFromBaseline,
  isScenarioV2,
} from "@/lib/projections/scenario";
import { availableTemplates, deferredTemplates, getTemplate } from "@/lib/projections/scenarios";

describe("linearRegression", () => {
  it("recovers a perfect line with R²=1", () => {
    const fit = linearRegression([
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 5 },
    ]);
    expect(fit.slope).toBeCloseTo(2, 6);
    expect(fit.intercept).toBeCloseTo(1, 6);
    expect(fit.r2).toBeCloseTo(1, 6);
    expect(predict(fit, 3)).toBeCloseTo(7, 6);
  });

  it("degrades safely: <2 points → flat mean, no NaN", () => {
    const one = linearRegression([{ x: 5, y: 10 }]);
    expect(one).toMatchObject({ slope: 0, intercept: 10, r2: 0, n: 1 });
    const none = linearRegression([]);
    expect(none.n).toBe(0);
    expect(Number.isFinite(none.slope)).toBe(true);
  });

  it("handles zero x-variance without dividing by zero", () => {
    const fit = linearRegression([
      { x: 3, y: 1 },
      { x: 3, y: 5 },
    ]);
    expect(fit.slope).toBe(0);
    expect(fit.intercept).toBe(3); // meanY
    expect(fit.r2).toBe(0);
  });

  it("weighs sample size in the confidence band", () => {
    expect(confidenceOf(0.95, 2)).toBe("weak"); // great fit, too few points
    expect(confidenceOf(0.8, 8)).toBe("strong");
    expect(confidenceOf(0.5, 5)).toBe("moderate");
  });
});

function makeHistory(): MonthlyHistory {
  // 6 months: revenue grows 10k→15k, COGS ~40% of revenue, OpEx ~ 5k fixed + 10%.
  const months = [10000, 11000, 12000, 13000, 14000, 15000].map((revenue, i) => {
    const cogs = revenue * 0.4;
    const opex = 5000 + revenue * 0.1;
    const grossProfit = revenue - cogs;
    return { period: `M${i}`, revenue, cogs, grossProfit, opex, netIncome: grossProfit - opex };
  });
  return { months, partsRevenue: 30000, laborRevenue: 45000 };
}

describe("deriveBaseline", () => {
  const b = deriveBaseline(makeHistory());

  it("recovers the cost structure from history", () => {
    expect(b.cogsPctOfRevenue.value).toBeCloseTo(0.4, 2);
    expect(b.opexFixedMonthly.value).toBeCloseTo(5000, 0);
    expect(b.opexVarPctOfRevenue.value).toBeCloseTo(0.1, 2);
  });

  it("expresses revenue growth as a positive monthly % with high confidence", () => {
    expect(b.revenueGrowthMonthlyPct.value).toBeGreaterThan(0);
    expect(b.revenueGrowthMonthlyPct.confidence).toBe("strong");
    expect(b.latestMonthlyRevenue).toBe(15000);
  });

  it("derives the parts/labor split", () => {
    expect(b.partsPctOfRevenue).toBeCloseTo(30000 / 75000, 4);
    expect(b.laborPctOfRevenue).toBeCloseTo(45000 / 75000, 4);
  });
});

describe("projectFinancials", () => {
  const inputs: ProjectionInputsV2 = {
    openingCash: 20000,
    startMonthlyRevenue: 10000,
    horizonMonths: 3,
    coefficients: {
      revenueGrowthMonthlyPct: { derived: 0, override: null },
      cogsPctOfRevenue: { derived: 0.4, override: null },
      opexFixedMonthly: { derived: 5000, override: null },
      opexVarPctOfRevenue: { derived: 0.1, override: null },
    },
  };

  it("projects P&L and accumulates cash", () => {
    const rows = projectFinancials(inputs);
    expect(rows).toHaveLength(3);
    // month 0: rev 10000, cogs 4000, gp 6000, opex 6000, net 0
    expect(rows[0]).toMatchObject({ revenue: 10000, cogs: 4000, grossProfit: 6000, opex: 6000, netIncome: 0 });
    expect(rows[0].endingCash).toBe(20000);
  });

  it("compounds growth and honors overrides over derived values", () => {
    const grown = projectFinancials({
      ...inputs,
      coefficients: {
        ...inputs.coefficients,
        revenueGrowthMonthlyPct: { derived: 0, override: 0.1 },
      },
    });
    expect(grown[1].revenue).toBeCloseTo(11000, 2);
    expect(grown[2].revenue).toBeCloseTo(12100, 2);
  });

  it("applies one-offs, recurring opex adjustments and revenue uplifts", () => {
    const rows = projectFinancials({
      ...inputs,
      horizonMonths: 3,
      oneOffs: [{ monthIndex: 1, amount: -30000, label: "Equipment" }],
      opexAdjustments: [{ monthIndex: 1, amount: 2000, label: "New hire" }],
      revenueUpliftPct: [{ monthIndex: 2, amount: 0.5, label: "New bay" }],
    });
    // month 1 opex up by 2000 → 6000+2000 = 8000; net = 6000-8000 = -2000; cash 20000-2000-30000
    expect(rows[1].opex).toBe(8000);
    expect(rows[1].endingCash).toBe(-12000);
    // month 2 revenue +50%
    expect(rows[2].revenue).toBeCloseTo(15000, 2);
  });
});

describe("summarizeV2 runway", () => {
  it("finds the month cash first goes negative", () => {
    const rows = projectFinancials({
      openingCash: 5000,
      startMonthlyRevenue: 0,
      horizonMonths: 4,
      coefficients: {
        revenueGrowthMonthlyPct: { derived: 0, override: null },
        cogsPctOfRevenue: { derived: 0, override: null },
        opexFixedMonthly: { derived: 2000, override: null },
        opexVarPctOfRevenue: { derived: 0, override: null },
      },
    });
    const s = summarizeV2(rows);
    // burn 2000/mo from 5000: ends 3000,1000,-1000,-3000 → negative at index 2
    expect(s.runwayMonths).toBe(2);
    expect(s.endingCash).toBe(-3000);
    expect(s.lowestCash).toBe(-3000);
  });

  it("returns null runway when cash never goes negative", () => {
    const s = summarizeV2(
      projectFinancials({
        openingCash: 100000,
        startMonthlyRevenue: 10000,
        horizonMonths: 3,
        coefficients: {
          revenueGrowthMonthlyPct: { derived: 0, override: null },
          cogsPctOfRevenue: { derived: 0.4, override: null },
          opexFixedMonthly: { derived: 1000, override: null },
          opexVarPctOfRevenue: { derived: 0.1, override: null },
        },
      })
    );
    expect(s.runwayMonths).toBeNull();
  });
});

describe("tornado sensitivity", () => {
  const inputs: ProjectionInputsV2 = {
    openingCash: 0,
    startMonthlyRevenue: 20000,
    horizonMonths: 12,
    coefficients: {
      revenueGrowthMonthlyPct: { derived: 0.01, override: null },
      cogsPctOfRevenue: { derived: 0.4, override: null },
      opexFixedMonthly: { derived: 5000, override: null },
      opexVarPctOfRevenue: { derived: 0.1, override: null },
    },
  };

  it("ranks drivers by how much they swing the target, largest first", () => {
    const bars = tornado(inputs, "totalNetIncome", 0.1);
    expect(bars.length).toBe(5);
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i - 1].swing).toBeGreaterThanOrEqual(bars[i].swing);
    }
    // Starting revenue should swing net income more than fixed OpEx here.
    const rev = bars.find((b) => b.driver === "startMonthlyRevenue")!;
    const fixed = bars.find((b) => b.driver === "opexFixedMonthly")!;
    expect(rev.swing).toBeGreaterThan(fixed.swing);
  });
});

describe("parseScenarioV2 (stored-JSON validation)", () => {
  it("round-trips a seeded scenario", () => {
    const seeded = inputsFromBaseline(deriveBaseline(makeHistory()), { openingCash: 50000 });
    const round = parseScenarioV2(JSON.parse(JSON.stringify(seeded)));
    expect(round.coefficients.cogsPctOfRevenue.derived).toBeCloseTo(0.4, 2);
    expect(round.openingCash).toBe(50000);
    expect(isScenarioV2(seeded)).toBe(true);
  });

  it("coerces malformed input to safe defaults and honors override=0", () => {
    const s = parseScenarioV2({
      coefficients: {
        cogsPctOfRevenue: { derived: "0.4", override: 0 },
        opexFixedMonthly: { derived: 5000, override: null },
      },
      horizonMonths: "999",
      oneOffs: "nope",
    });
    expect(s.coefficients.cogsPctOfRevenue.derived).toBe(0.4);
    // override of literal 0 must be preserved, not treated as "unset"
    expect(s.coefficients.cogsPctOfRevenue.override).toBe(0);
    expect(effective(s.coefficients.cogsPctOfRevenue)).toBe(0);
    expect(s.horizonMonths).toBe(120); // clamped
    expect(s.oneOffs).toEqual([]);
  });

  it("v1 prototype blobs are not misread as v2", () => {
    expect(isScenarioV2({ openingBalance: 0, horizonMonths: 12 })).toBe(false);
  });
});

describe("scenario library", () => {
  it("ships QBO-derivable scenarios and defers Tekmetric ones", () => {
    const avail = availableTemplates().map((t) => t.id);
    expect(avail).toContain("runway");
    expect(avail).toContain("margin_mix");
    const deferred = deferredTemplates();
    expect(deferred.every((t) => t.dataSource === "tekmetric")).toBe(true);
    expect(getTemplate("per_technician_profit")?.status).toBe("needs_tekmetric");
  });
});
