import { describe, it, expect } from "vitest";
import { composeMonths } from "@/lib/tekmetric/compose";
import type {
  TekOperationsData,
  TekKpi,
  TekRepairOrder,
  TekVehicle,
  TekTechUtilization,
  TekRevenueByMake,
  TekAdvisorPerformance,
} from "@/lib/tekmetric/types";

// ---------------------------------------------------------------------------
// A minimal, hand-built two-month fixture pair (rather than routing through
// buildOperationsData/raw Tekmetric JSON) so the composition arithmetic —
// weighted rates, vehicle dedup across months, KPI deltas — can be asserted
// precisely against known-by-construction numbers. This mirrors exactly what
// compose.ts reads back from two cached monthly `tek_snapshot` rows.
// ---------------------------------------------------------------------------

function kpi(value: number): TekKpi {
  return { value, priorValue: null, deltaAbs: null, deltaPct: null };
}

function ro(id: string, vehicleId: string, customerId: string): TekRepairOrder {
  return {
    id,
    shopId: "1",
    status: "posted",
    rawStatus: "POSTED",
    openedAt: null,
    closedAt: null,
    customerId,
    vehicleId,
    serviceAdvisorId: "a1",
    totals: { labor: 0, parts: 0, subtotal: 0, tax: 0, total: 0 },
    grossProfit: 0,
    jobs: [],
  };
}

const V1: TekVehicle = { id: "v1", vin: "VIN1", year: 2020, make: "Toyota", model: "Camry", mileage: null };
const V2: TekVehicle = { id: "v2", vin: null, year: 2019, make: "Honda", model: "Civic", mileage: null };

const TECH_JAN: TekTechUtilization = {
  technicianId: "t1",
  technicianName: "Tech One",
  billedHours: 10,
  availableHours: 160,
  utilizationPct: 6.25,
  laborRevenue: 600,
  effectiveLaborRate: 60,
  postedLaborRate: 100,
};

const TECH_FEB: TekTechUtilization = {
  technicianId: "t1",
  technicianName: "Tech One",
  billedHours: 5,
  availableHours: 150,
  utilizationPct: 3.33,
  laborRevenue: 300,
  effectiveLaborRate: 60,
  postedLaborRate: 120,
};

const MAKE_TOYOTA_JAN: TekRevenueByMake = { make: "Toyota", roCount: 1, revenue: 600, grossProfit: 250, grossMarginPct: 41.67, aro: 600 };
const MAKE_HONDA_JAN: TekRevenueByMake = { make: "Honda", roCount: 1, revenue: 400, grossProfit: 150, grossMarginPct: 37.5, aro: 400 };
const MAKE_TOYOTA_FEB: TekRevenueByMake = { make: "Toyota", roCount: 1, revenue: 700, grossProfit: 300, grossMarginPct: 42.86, aro: 700 };

const ADVISOR_JAN: TekAdvisorPerformance = {
  advisorId: "a1",
  advisorName: "Advisor One",
  roCount: 2,
  carCount: 2, // v1 + v2, distinct within January
  totalSales: 1000,
  grossProfit: 400,
  grossMarginPct: 40,
  aro: 500,
};

const ADVISOR_FEB: TekAdvisorPerformance = {
  advisorId: "a1",
  advisorName: "Advisor One",
  roCount: 1,
  carCount: 1, // v1, distinct within February
  totalSales: 700,
  grossProfit: 300,
  grossMarginPct: 42.86,
  aro: 700,
};

// January: 2 ROs (v1 once, v2 once). aro=500 → revenue=1000. grossProfit=400.
const JAN: TekOperationsData = {
  period: { start: "2026-01-01", end: "2026-01-31" },
  repairOrders: [ro("ro1", "v1", "c1"), ro("ro2", "v2", "c2")],
  technicians: [],
  serviceAdvisors: [],
  vehicles: [V1, V2],
  appointments: [],
  kpis: { roCount: kpi(2), aro: kpi(500), grossProfit: kpi(400), grossMarginPct: kpi(40), carCount: kpi(2) },
  techUtilization: [TECH_JAN],
  revenueByMake: [MAKE_TOYOTA_JAN, MAKE_HONDA_JAN],
  advisorPerformance: [ADVISOR_JAN],
};

// February: 1 RO, SAME vehicle v1 as January (a real repeat visitor across
// months, but never 2+ within either single month — the exact case a
// per-month findRepeatVehicleVisits call would miss). aro=700 → revenue=700.
const FEB: TekOperationsData = {
  period: { start: "2026-02-01", end: "2026-02-28" },
  repairOrders: [ro("ro3", "v1", "c1")],
  technicians: [],
  serviceAdvisors: [],
  vehicles: [V1],
  appointments: [],
  kpis: { roCount: kpi(1), aro: kpi(700), grossProfit: kpi(300), grossMarginPct: kpi(42.86), carCount: kpi(1) },
  techUtilization: [TECH_FEB],
  revenueByMake: [MAKE_TOYOTA_FEB],
  advisorPerformance: [ADVISOR_FEB],
};

const RANGE = { start: "2026-01-01", end: "2026-02-28" };

describe("composeMonths — KPI sums and recomputed rates", () => {
  const composed = composeMonths(RANGE, [JAN, FEB]);

  it("sums roCount and grossProfit across months", () => {
    expect(composed.data.kpis.roCount.value).toBe(3);
    expect(composed.data.kpis.grossProfit.value).toBe(700);
  });

  it("recomputes aro/margin from summed revenue, not a naive average of monthly percentages", () => {
    // revenue = Σ(aro × roCount) = 500×2 + 700×1 = 1700; aro = 1700/3.
    expect(composed.data.kpis.aro.value).toBeCloseTo(566.67, 2);
    // margin = grossProfit/revenue = 700/1700×100 — NOT (40+42.86)/2 = 41.43.
    expect(composed.data.kpis.grossMarginPct.value).toBeCloseTo(41.18, 2);
  });

  it("does NOT naively average a naive per-month margin (guards against that regression)", () => {
    const naiveAverage = (40 + 42.86) / 2;
    expect(composed.data.kpis.grossMarginPct.value).not.toBeCloseTo(naiveAverage, 1);
  });
});

describe("composeMonths — deduplicated car count vs. per-advisor approximation", () => {
  const composed = composeMonths(RANGE, [JAN, FEB]);

  it("top-line carCount is the TRUE distinct-vehicle count across months (v1 counted once, not twice)", () => {
    // v1 appears in both Jan and Feb; v2 only in Jan → 2 distinct vehicles,
    // NOT 2 (Jan) + 1 (Feb) = 3.
    expect(composed.data.kpis.carCount.value).toBe(2);
  });

  it("documents the advisor-level carCount approximation: it IS a sum of monthly distinct counts", () => {
    // Jan: 2 distinct cars for a1 (v1, v2). Feb: 1 (v1). Sum = 3, even though
    // the true year-long distinct count for this advisor is 2 (v1, v2) — a
    // known, documented approximation (see compose.ts's module doc), not a bug.
    const a1 = composed.data.advisorPerformance.find((a) => a.advisorId === "a1");
    expect(a1?.carCount).toBe(3);
  });
});

describe("composeMonths — repeat visits across months a single month would miss", () => {
  const composed = composeMonths(RANGE, [JAN, FEB]);

  it("finds v1 as a repeat visitor (1 RO each in two different months) with both ROs merged", () => {
    const v1Visit = composed.repeatVisits.find((v) => v.vehicleKey === "vin:VIN1");
    expect(v1Visit).toBeDefined();
    expect(v1Visit?.roCount).toBe(2);
    expect(v1Visit?.roIds.sort()).toEqual(["ro1", "ro3"]);
  });

  it("does not list v2 (only 1 RO across the whole range)", () => {
    expect(composed.repeatVisits.some((v) => v.vehicleKey === "veh:v2")).toBe(false);
  });

  it("repeatVisitsTotal matches the uncapped count", () => {
    expect(composed.repeatVisitsTotal).toBe(composed.repeatVisits.length);
  });
});

describe("composeMonths — techUtilization merges by technicianId", () => {
  const composed = composeMonths(RANGE, [JAN, FEB]);
  const t1 = composed.data.techUtilization.find((t) => t.technicianId === "t1");

  it("sums billedHours, availableHours, and laborRevenue exactly", () => {
    expect(t1?.billedHours).toBe(15);
    expect(t1?.availableHours).toBe(310);
    expect(t1?.laborRevenue).toBe(900);
  });

  it("recomputes utilizationPct and effectiveLaborRate from the summed values", () => {
    expect(t1?.utilizationPct).toBeCloseTo((15 / 310) * 100, 2);
    expect(t1?.effectiveLaborRate).toBeCloseTo(60, 2); // 900 / 15
  });

  it("approximates postedLaborRate as a billedHours-weighted average across months", () => {
    // (100×10 + 120×5) / 15 = 1600/15.
    expect(t1?.postedLaborRate).toBeCloseTo(1600 / 15, 2);
  });
});

describe("composeMonths — revenueByMake merges by make", () => {
  const composed = composeMonths(RANGE, [JAN, FEB]);
  const toyota = composed.data.revenueByMake.find((m) => m.make === "Toyota");
  const honda = composed.data.revenueByMake.find((m) => m.make === "Honda");

  it("sums roCount/revenue/grossProfit and recomputes margin/aro for a make seen in both months", () => {
    expect(toyota?.roCount).toBe(2);
    expect(toyota?.revenue).toBe(1300);
    expect(toyota?.grossProfit).toBe(550);
    expect(toyota?.aro).toBe(650);
    expect(toyota?.grossMarginPct).toBeCloseTo((550 / 1300) * 100, 2);
  });

  it("carries a make seen in only one month through unchanged", () => {
    expect(honda?.roCount).toBe(1);
    expect(honda?.revenue).toBe(400);
  });
});

describe("composeMonths — comparison range composes the same way and drives real deltas", () => {
  // Compare Jan+Feb (current) against a single flat comparison month with
  // known, different figures, so the delta math is checkable by hand.
  const COMPARISON: TekOperationsData = {
    ...JAN,
    period: { start: "2025-01-01", end: "2025-01-31" },
    kpis: { roCount: kpi(3), aro: kpi(500), grossProfit: kpi(600), grossMarginPct: kpi(40), carCount: kpi(3) },
  };
  const composed = composeMonths(RANGE, [JAN, FEB], [COMPARISON]);

  it("computes priorValue/deltaAbs/deltaPct against the composed comparison range, not any single month", () => {
    // current roCount = 3, comparison roCount = 3 → flat.
    expect(composed.data.kpis.roCount.priorValue).toBe(3);
    expect(composed.data.kpis.roCount.deltaAbs).toBe(0);
    // current grossProfit = 700, comparison = 600 → +100, +16.67%.
    expect(composed.data.kpis.grossProfit.priorValue).toBe(600);
    expect(composed.data.kpis.grossProfit.deltaAbs).toBe(100);
    expect(composed.data.kpis.grossProfit.deltaPct).toBeCloseTo((100 / 600) * 100, 2);
  });
});

describe("composeMonths — a requested-but-empty comparison range is honest 'no comparison', not a fake 100% jump", () => {
  it("does not treat a zero-coverage comparison range as a real all-zero prior", () => {
    // A comparison range was requested (comparisonMonths=[]), but nothing was
    // actually folded into it — this must read the same as "no comparison
    // requested at all" (priorValue/deltaAbs/deltaPct all null), not as
    // "the prior period genuinely had $0 gross profit, so this is up
    // infinity percent."
    const composed = composeMonths(RANGE, [JAN, FEB], []);
    expect(composed.data.kpis.grossProfit.priorValue).toBeNull();
    expect(composed.data.kpis.grossProfit.deltaAbs).toBeNull();
    expect(composed.data.kpis.grossProfit.deltaPct).toBeNull();
    expect(composed.data.kpis.roCount.priorValue).toBeNull();
  });
});

describe("composeMonths — degenerate zero-month input", () => {
  // composeMonths takes already-fetched month data (no I/O) — tracking which
  // calendar months were found vs. missing in the cache is foldRange's job
  // (composeOperationsRange's sequential fetch path), not testable here
  // without a database. This just guards the fold doesn't throw/NaN on empty
  // input, e.g. before any month in a brand-new range has been backfilled.
  it("composes to all-zero KPIs without throwing or producing NaN", () => {
    const composed = composeMonths(RANGE, []);
    expect(composed.data.kpis.roCount.value).toBe(0);
    expect(composed.data.kpis.carCount.value).toBe(0);
    expect(composed.data.kpis.aro.value).toBe(0);
    expect(composed.data.kpis.grossMarginPct.value).toBe(0);
    expect(composed.repeatVisits).toEqual([]);
  });
});
