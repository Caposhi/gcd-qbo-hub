/**
 * Baseline coefficient derivation (Projections engine v2, Phase 2).
 *
 * Given our own monthly QBO history, derive the forward-looking coefficients the
 * projection engine needs — revenue growth, COGS as % of revenue, the fixed +
 * variable split of operating expenses, and margins — each via auditable OLS
 * regression and tagged with a confidence signal (R² + sample size). These are
 * the *editable defaults* the user can override (locked decision: no black
 * boxes — every default shows the fit behind it).
 *
 * Pure and IO-free (§20). The QBO fetch that produces `MonthlyHistory` lives in
 * ../baseline-service.ts.
 */
import { linearRegression, confidenceOf, type Confidence } from "./ols";

/** One month of actuals, oldest-first when passed to the deriver. */
export interface MonthlyActual {
  period: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
  opex: number;
  netIncome: number;
}

export interface MonthlyHistory {
  months: MonthlyActual[];
  /** Optional revenue split for the parts-vs-labor margin-mix scenario. */
  partsRevenue?: number;
  laborRevenue?: number;
}

export type CoefficientUnit = "pct" | "money" | "ratio";

/** A derived coefficient carrying the evidence behind it. */
export interface Coefficient {
  /** The derived value (a fraction for "pct", dollars for "money"). */
  value: number;
  r2: number;
  n: number;
  confidence: Confidence;
  unit: CoefficientUnit;
  /** Plain-language note on how it was derived. */
  basis: string;
}

export interface DerivedBaseline {
  months: number;
  /** Latest actual monthly revenue (projection start point). */
  latestMonthlyRevenue: number;
  avgMonthlyRevenue: number;
  revenueGrowthMonthlyPct: Coefficient;
  cogsPctOfRevenue: Coefficient;
  opexFixedMonthly: Coefficient;
  opexVarPctOfRevenue: Coefficient;
  grossMarginPct: number;
  netMarginPct: number;
  partsPctOfRevenue: number | null;
  laborPctOfRevenue: number | null;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function ratio(num: number, den: number): number {
  return Math.abs(den) < 1e-9 ? 0 : num / den;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Derive the baseline coefficients from monthly history (oldest-first).
 *
 * - Revenue growth: regress revenue on the month index; express the slope as a
 *   monthly % of average revenue.
 * - COGS %: regress COGS on revenue (slope ≈ variable cost ratio); fall back to
 *   the aggregate ratio when the slope is implausible.
 * - OpEx: regress OpEx on revenue — intercept = fixed monthly, slope = variable
 *   % of revenue — with the same plausibility guard.
 */
export function deriveBaseline(history: MonthlyHistory): DerivedBaseline {
  const months = history.months;
  const n = months.length;
  const revenues = months.map((m) => m.revenue);
  const avgRevenue = mean(revenues);
  const latestRevenue = n > 0 ? revenues[n - 1] : 0;

  // Revenue growth vs month index.
  const revFit = linearRegression(months.map((m, i) => ({ x: i, y: m.revenue })));
  const growthPct = avgRevenue > 0 ? revFit.slope / avgRevenue : 0;
  const revenueGrowthMonthlyPct: Coefficient = {
    value: clamp(growthPct, -0.5, 0.5),
    r2: revFit.r2,
    n,
    confidence: confidenceOf(revFit.r2, n),
    unit: "pct",
    basis: `Trend of ${n} months of revenue (slope ${round2(revFit.slope)}/mo on avg ${round0(avgRevenue)}).`,
  };

  // COGS ~ revenue.
  const cogsFit = linearRegression(months.map((m) => ({ x: m.revenue, y: m.cogs })));
  const cogsAggregate = ratio(
    months.reduce((s, m) => s + m.cogs, 0),
    months.reduce((s, m) => s + m.revenue, 0)
  );
  const cogsSlopePlausible = cogsFit.n >= 2 && cogsFit.slope > 0 && cogsFit.slope < 1.5;
  const cogsPctOfRevenue: Coefficient = {
    value: clamp(cogsSlopePlausible ? cogsFit.slope : cogsAggregate, 0, 1.5),
    r2: cogsFit.r2,
    n,
    confidence: confidenceOf(cogsFit.r2, n),
    unit: "pct",
    basis: cogsSlopePlausible
      ? `Regression of COGS on revenue over ${n} months.`
      : `Aggregate COGS ÷ revenue over ${n} months (regression too weak).`,
  };

  // OpEx ~ revenue → fixed (intercept) + variable (slope).
  const opexFit = linearRegression(months.map((m) => ({ x: m.revenue, y: m.opex })));
  const avgOpex = mean(months.map((m) => m.opex));
  const opexSlopePlausible = opexFit.n >= 2 && opexFit.slope >= 0 && opexFit.slope < 1.5;
  const opexFixed = opexSlopePlausible ? Math.max(0, opexFit.intercept) : avgOpex;
  const opexVar = opexSlopePlausible ? clamp(opexFit.slope, 0, 1.5) : 0;
  const opexFixedMonthly: Coefficient = {
    value: round2(opexFixed),
    r2: opexFit.r2,
    n,
    confidence: confidenceOf(opexFit.r2, n),
    unit: "money",
    basis: opexSlopePlausible
      ? `Intercept of OpEx-on-revenue regression over ${n} months.`
      : `Average monthly OpEx over ${n} months (regression too weak).`,
  };
  const opexVarPctOfRevenue: Coefficient = {
    value: opexVar,
    r2: opexFit.r2,
    n,
    confidence: confidenceOf(opexFit.r2, n),
    unit: "pct",
    basis: opexSlopePlausible
      ? `Slope of OpEx-on-revenue regression over ${n} months.`
      : `Set to 0 — OpEx treated as fixed (regression too weak).`,
  };

  const grossMarginPct = ratio(mean(months.map((m) => m.grossProfit)), avgRevenue);
  const netMarginPct = ratio(mean(months.map((m) => m.netIncome)), avgRevenue);

  const hasSplit =
    typeof history.partsRevenue === "number" && typeof history.laborRevenue === "number";
  const splitTotal = hasSplit ? history.partsRevenue! + history.laborRevenue! : 0;

  return {
    months: n,
    latestMonthlyRevenue: round2(latestRevenue),
    avgMonthlyRevenue: round2(avgRevenue),
    revenueGrowthMonthlyPct,
    cogsPctOfRevenue,
    opexFixedMonthly,
    opexVarPctOfRevenue,
    grossMarginPct,
    netMarginPct,
    partsPctOfRevenue: hasSplit && splitTotal > 0 ? ratio(history.partsRevenue!, splitTotal) : null,
    laborPctOfRevenue: hasSplit && splitTotal > 0 ? ratio(history.laborRevenue!, splitTotal) : null,
  };
}

function round2(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}
function round0(n: number): number {
  return Math.round(n);
}
