/**
 * Multi-month Tekmetric Operations composition — the "Last year"/"YTD"
 * wide-range view built by reading N already-cached MONTHLY `tek_snapshot`
 * rows sequentially and merging them, instead of a live pull across the
 * whole range. See snapshot.ts's `MAX_REFRESH_RANGE_DAYS` guard: a live pull
 * that wide once held two full calendar years of repair-order detail in
 * memory at once and OOM-crashed the hub. This module exists so a wide-range
 * VIEW is still possible, just never via that path again.
 *
 * Peak memory here never exceeds "one month's full snapshot in flight at a
 * time, plus small running totals" — the same discipline history-service.ts
 * already uses for the 5 headline KPIs, extended here to the full advisor/
 * tech/make breakdown and a real, deduplicated multi-month car count +
 * repeat-visit list.
 *
 * What composes exactly vs. approximately:
 *  - roCount, revenue (derived per month as aro×roCount), grossProfit sum
 *    cleanly across months; aro and grossMarginPct are RECOMPUTED from the
 *    summed revenue/grossProfit/roCount at the end, never averaged month to
 *    month — a naive average of monthly percentages is wrong when months
 *    have uneven volume.
 *  - carCount is NOT a sum of monthly car counts (the same car serviced in
 *    two different months is one car, not two) — it's the size of a
 *    deduplicated vehicle tally built by merging each month's
 *    `tallyRepairOrdersByVehicle` output (normalize.ts), which also drives
 *    the composed repeat-visit list (vehicles with 2+ ROs across the WHOLE
 *    range, not just within any single month — a car serviced once a month
 *    for three different months would never show up in any single month's
 *    own repeat-visit table, but is a real repeat visitor at the yearly
 *    grain).
 *  - techUtilization/revenueByMake/advisorPerformance merge by key
 *    (technicianId/make/advisorId), summing base quantities and
 *    recomputing rates the same sum-then-divide way. `availableHours` sums
 *    exactly (it's purely a function of each month's own business days, not
 *    of RO volume), so `utilizationPct`/`effectiveLaborRate` come out exact.
 *    One real approximation: `postedLaborRate` isn't stored with enough
 *    detail to recompose exactly (only each month's already-divided rate is
 *    cached, not the rate×hours/hours pair it came from) — the composed
 *    value is a billedHours-weighted average across months instead.
 *  - advisor/make-level `carCount` is a straight sum of monthly distinct
 *    counts, not a true year-long dedup (that would need per-key vehicle-ID
 *    tracking per advisor/make) — a car serviced by the same advisor in two
 *    different months double-counts there. The TOP-LINE carCount above does
 *    not have this limitation.
 */
import { round2, buildKpi, tallyRepairOrdersByVehicle, type TekRepeatVisit } from "./normalize";
import { monthsInRange } from "./periods";
import { readOperationsSnapshotAnyComparison } from "./snapshot";
import type {
  TekPeriod,
  TekOperationsData,
  TekKpiSummary,
  TekTechUtilization,
  TekRevenueByMake,
  TekAdvisorPerformance,
} from "./types";

/** Cap on the composed repeat-visits table — a full year surfaces far more
 *  repeat vehicles than a single month; show the biggest repeaters, not an
 *  unbounded list. */
const REPEAT_VISIT_CAP = 50;

function pct(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return round2((numerator / denominator) * 100);
}

// ===========================================================================
// Per-side (current or comparison range) running accumulator
// ===========================================================================

interface KpiAcc {
  roCount: number;
  revenue: number;
  grossProfit: number;
}

interface TechAcc {
  technicianId: string;
  technicianName: string;
  billedHours: number;
  availableHours: number;
  laborRevenue: number;
  /** Σ(postedLaborRate × billedHours) — for the weighted-average approximation. */
  postedRateWeighted: number;
}

interface MakeAcc {
  make: string;
  roCount: number;
  revenue: number;
  grossProfit: number;
}

interface AdvisorAcc {
  advisorId: string;
  advisorName: string;
  roCount: number;
  /** Sum of monthly distinct counts — approximate, see module doc. */
  carCount: number;
  totalSales: number;
  grossProfit: number;
}

export interface MonthRef {
  start: string;
  end: string;
  label: string;
}

interface RangeAccumulator {
  kpi: KpiAcc;
  techById: Map<string, TechAcc>;
  makeByKey: Map<string, MakeAcc>;
  advisorById: Map<string, AdvisorAcc>;
  /** Deduplicated across the whole range — see module doc. */
  vehicleTally: Map<string, TekRepeatVisit>;
  monthsFound: string[];
  monthsMissing: MonthRef[];
  /**
   * How many months were actually folded in, regardless of path —
   * `foldRange`'s real cache hits/misses (which is what `monthsFound` also
   * tracks) OR `composeMonths`'s direct fold of already-fetched test data
   * (which has no found/missing concept at all, so `monthsFound` stays
   * empty there even when real months were folded). Used to distinguish
   * "the comparison range genuinely has zero activity" from "the
   * comparison range has zero CACHED DATA" — see finishAccumulator.
   */
  monthsFoldedCount: number;
}

function emptyAccumulator(): RangeAccumulator {
  return {
    kpi: { roCount: 0, revenue: 0, grossProfit: 0 },
    techById: new Map(),
    makeByKey: new Map(),
    advisorById: new Map(),
    vehicleTally: new Map(),
    monthsFound: [],
    monthsMissing: [],
    monthsFoldedCount: 0,
  };
}

function mergeVehicleTally(into: Map<string, TekRepeatVisit>, from: Map<string, TekRepeatVisit>) {
  for (const [key, v] of from) {
    const existing = into.get(key);
    if (!existing) {
      into.set(key, { ...v, roIds: [...v.roIds] });
    } else {
      existing.roCount += v.roCount;
      existing.roIds.push(...v.roIds);
    }
  }
}

/** Fold one month's normalized TekOperationsData into the running accumulator. */
function foldMonth(acc: RangeAccumulator, month: TekOperationsData): void {
  acc.monthsFoldedCount += 1;
  acc.kpi.roCount += month.kpis.roCount.value;
  acc.kpi.revenue += month.kpis.aro.value * month.kpis.roCount.value;
  acc.kpi.grossProfit += month.kpis.grossProfit.value;

  for (const t of month.techUtilization) {
    let a = acc.techById.get(t.technicianId);
    if (!a) {
      a = {
        technicianId: t.technicianId,
        technicianName: t.technicianName,
        billedHours: 0,
        availableHours: 0,
        laborRevenue: 0,
        postedRateWeighted: 0,
      };
      acc.techById.set(t.technicianId, a);
    }
    a.billedHours += t.billedHours;
    a.availableHours += t.availableHours;
    a.laborRevenue += t.laborRevenue;
    a.postedRateWeighted += t.postedLaborRate * t.billedHours;
  }

  for (const m of month.revenueByMake) {
    let a = acc.makeByKey.get(m.make);
    if (!a) {
      a = { make: m.make, roCount: 0, revenue: 0, grossProfit: 0 };
      acc.makeByKey.set(m.make, a);
    }
    a.roCount += m.roCount;
    a.revenue += m.revenue;
    a.grossProfit += m.grossProfit;
  }

  for (const adv of month.advisorPerformance) {
    let a = acc.advisorById.get(adv.advisorId);
    if (!a) {
      a = { advisorId: adv.advisorId, advisorName: adv.advisorName, roCount: 0, carCount: 0, totalSales: 0, grossProfit: 0 };
      acc.advisorById.set(adv.advisorId, a);
    }
    a.roCount += adv.roCount;
    a.carCount += adv.carCount; // approximate — see module doc
    a.totalSales += adv.totalSales;
    a.grossProfit += adv.grossProfit;
  }

  mergeVehicleTally(acc.vehicleTally, tallyRepairOrdersByVehicle(month.repairOrders, month.vehicles));
}

/**
 * Read + fold N calendar months SEQUENTIALLY (never Promise.all) — each
 * month's full snapshot (including its raw `repairOrders`) is read, folded
 * into the small running accumulator, and then falls out of scope before
 * the next iteration begins. This is the entire memory-safety property this
 * module exists to provide.
 */
async function foldRange(months: MonthRef[]): Promise<RangeAccumulator> {
  const acc = emptyAccumulator();
  for (const m of months) {
    const period: TekPeriod = { start: m.start, end: m.end };
    const { data } = await readOperationsSnapshotAnyComparison(period);
    if (!data) {
      acc.monthsMissing.push(m);
      continue;
    }
    acc.monthsFound.push(m.label);
    foldMonth(acc, data);
  }
  return acc;
}

function finishTech(a: TechAcc): TekTechUtilization {
  return {
    technicianId: a.technicianId,
    technicianName: a.technicianName,
    billedHours: round2(a.billedHours),
    availableHours: round2(a.availableHours),
    utilizationPct: pct(a.billedHours, a.availableHours),
    laborRevenue: round2(a.laborRevenue),
    effectiveLaborRate: a.billedHours > 0 ? round2(a.laborRevenue / a.billedHours) : 0,
    postedLaborRate: a.billedHours > 0 ? round2(a.postedRateWeighted / a.billedHours) : 0,
  };
}

function finishMake(a: MakeAcc): TekRevenueByMake {
  return {
    make: a.make,
    roCount: a.roCount,
    revenue: round2(a.revenue),
    grossProfit: round2(a.grossProfit),
    grossMarginPct: pct(a.grossProfit, a.revenue),
    aro: a.roCount > 0 ? round2(a.revenue / a.roCount) : 0,
  };
}

function finishAdvisor(a: AdvisorAcc): TekAdvisorPerformance {
  return {
    advisorId: a.advisorId,
    advisorName: a.advisorName,
    roCount: a.roCount,
    carCount: a.carCount,
    totalSales: round2(a.totalSales),
    grossProfit: round2(a.grossProfit),
    grossMarginPct: pct(a.grossProfit, a.totalSales),
    aro: a.roCount > 0 ? round2(a.totalSales / a.roCount) : 0,
  };
}

// ===========================================================================
// Public entry point
// ===========================================================================

export interface ComposedRange {
  /**
   * `repairOrders`/`vehicles`/`technicians`/`serviceAdvisors`/`appointments`
   * are intentionally always empty here (the safe-empty convention
   * snapshot.ts's `emptyOperations` also uses) — retaining any month's raw
   * entities past its own turn in the fold is exactly what this module
   * exists to avoid. Use `repeatVisits` below, not
   * `findRepeatVehicleVisits(data.repairOrders, data.vehicles)`, for the
   * repeat-visit table on a composed range.
   */
  data: TekOperationsData;
  /** Vehicles with 2+ ROs across the WHOLE range, capped to the top
   *  `REPEAT_VISIT_CAP` by RO count. */
  repeatVisits: TekRepeatVisit[];
  /** How many distinct vehicles had 2+ ROs before capping — for an honest
   *  "showing top 50 of N" label when the cap bites. */
  repeatVisitsTotal: number;
  /** Calendar month labels actually found cached, oldest first — the
   *  CURRENT range only. */
  monthsFound: string[];
  /** Calendar months in the CURRENT range with no cached snapshot yet,
   *  oldest first — surface these plainly rather than silently
   *  under-counting; the caller can offer to fill them via
   *  fillMissingMonths (fill-gaps.ts), one month at a time. */
  monthsMissing: MonthRef[];
  /** Same as `monthsFound`, for the COMPARISON range — a gap here doesn't
   *  shrink the current-range figures shown, but it DOES mean every KPI
   *  delta/comparison is computed against an incomplete prior range and
   *  should be flagged just as plainly (this is exactly the year-over-year
   *  comparison the whole composed view exists for — a silently-partial
   *  comparison side defeats the point). Empty when there's no comparison
   *  range at all. */
  comparisonMonthsFound: string[];
  /** Same as `monthsMissing`, for the COMPARISON range. Empty when there's
   *  no comparison range at all. */
  comparisonMonthsMissing: MonthRef[];
}

export interface NotMonthAligned {
  error: "not_month_aligned";
  /** Which side of the request failed the check, for a precise message. */
  side: "range" | "comparisonRange";
}

/**
 * Turn a folded current-range accumulator (plus an optional folded
 * comparison-range accumulator) into the final composed shape. Pure — no I/O,
 * no sequencing concerns — so it's the single place the actual merge
 * arithmetic (weighted rates, vehicle dedup, KPI deltas) lives, shared by
 * both the production sequential-fetch path below and `composeMonths`
 * (exported for direct unit testing against fixture data, no database).
 */
function finishAccumulator(range: TekPeriod, current: RangeAccumulator, prior: RangeAccumulator | null): ComposedRange {
  const aro = (k: KpiAcc): number => (k.roCount > 0 ? round2(k.revenue / k.roCount) : 0);
  const margin = (k: KpiAcc): number => (k.revenue > 0 ? round2((k.grossProfit / k.revenue) * 100) : 0);

  // A comparison range with genuinely ZERO cached months folds to an
  // all-zero accumulator — computing deltas against that would read as "up
  // 100%" or similar nonsense, not the honest "no comparison data yet" this
  // should be. Only treat `prior` as a real baseline once at least one of
  // its months actually got folded in.
  const priorForDeltas = prior && prior.monthsFoldedCount > 0 ? prior : null;

  const kpis: TekKpiSummary = {
    roCount: buildKpi(current.kpi.roCount, priorForDeltas ? priorForDeltas.kpi.roCount : null),
    aro: buildKpi(aro(current.kpi), priorForDeltas ? aro(priorForDeltas.kpi) : null),
    grossProfit: buildKpi(current.kpi.grossProfit, priorForDeltas ? priorForDeltas.kpi.grossProfit : null),
    grossMarginPct: buildKpi(margin(current.kpi), priorForDeltas ? margin(priorForDeltas.kpi) : null),
    carCount: buildKpi(current.vehicleTally.size, priorForDeltas ? priorForDeltas.vehicleTally.size : null),
  };

  const data: TekOperationsData = {
    period: range,
    repairOrders: [],
    technicians: [],
    serviceAdvisors: [],
    vehicles: [],
    appointments: [],
    kpis,
    techUtilization: [...current.techById.values()].map(finishTech).sort((a, b) => b.billedHours - a.billedHours),
    revenueByMake: [...current.makeByKey.values()].map(finishMake).sort((a, b) => b.revenue - a.revenue),
    advisorPerformance: [...current.advisorById.values()].map(finishAdvisor).sort((a, b) => b.totalSales - a.totalSales),
  };

  const allRepeatVisits = [...current.vehicleTally.values()]
    .filter((v) => v.roCount >= 2)
    .sort((a, b) => b.roCount - a.roCount);

  return {
    data,
    repeatVisits: allRepeatVisits.slice(0, REPEAT_VISIT_CAP),
    repeatVisitsTotal: allRepeatVisits.length,
    monthsFound: current.monthsFound,
    monthsMissing: current.monthsMissing,
    comparisonMonthsFound: prior?.monthsFound ?? [],
    comparisonMonthsMissing: prior?.monthsMissing ?? [],
  };
}

/**
 * Pure: fold a list of already-fetched monthly `TekOperationsData` into one
 * composed result — the exact same merge arithmetic
 * `composeOperationsRange` uses, minus the sequential fetch-and-discard I/O.
 * Exists so the tricky parts (weighted-average rates, vehicle dedup across
 * months, KPI deltas) are directly unit-testable against fixture data with
 * no database, the same way `buildOperationsData` is tested against fixture
 * repair orders in tekmetric-normalize.test.ts.
 *
 * NOT the production entry point for a live request — building the input
 * array here means holding every month's full data at once, which is
 * exactly what `composeOperationsRange` avoids. Tests only.
 */
export function composeMonths(range: TekPeriod, months: TekOperationsData[], comparisonMonths: TekOperationsData[] | null = null): ComposedRange {
  const current = emptyAccumulator();
  for (const m of months) foldMonth(current, m);
  let prior: RangeAccumulator | null = null;
  if (comparisonMonths) {
    prior = emptyAccumulator();
    for (const m of comparisonMonths) foldMonth(prior, m);
  }
  return finishAccumulator(range, current, prior);
}

/**
 * Compose a wide-range `TekOperationsData` from cached monthly snapshots.
 *
 * `range` and `comparisonRange` must each be whole-calendar-month-aligned
 * (start on the 1st, end on the last day of a month — see periods.ts's
 * `monthsInRange`) — the caller is responsible for trimming a non-aligned
 * selection (e.g. "YTD"'s trailing partial current month) before calling
 * this. Returns a `NotMonthAligned` error rather than silently composing a
 * wrong answer when that invariant is violated.
 */
export async function composeOperationsRange(
  range: TekPeriod,
  comparisonRangeValue: TekPeriod | null
): Promise<ComposedRange | NotMonthAligned> {
  const months = monthsInRange(range);
  if (!months) return { error: "not_month_aligned", side: "range" };
  const comparisonMonths = comparisonRangeValue ? monthsInRange(comparisonRangeValue) : null;
  if (comparisonRangeValue && !comparisonMonths) return { error: "not_month_aligned", side: "comparisonRange" };

  const current = await foldRange(months);
  const prior = comparisonMonths ? await foldRange(comparisonMonths) : null;

  return finishAccumulator(range, current, prior);
}
