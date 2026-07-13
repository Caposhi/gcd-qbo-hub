/**
 * Hybrid projection engine v2 (Projections, Phase 2).
 *
 * The forward model. Every coefficient is a {derived, override} pair — the
 * derived value comes from auditable regression on our QBO history (see
 * regression/baseline.ts), and the user may override any of them; the effective
 * value is `override ?? derived` (locked decision: editable defaults, no black
 * boxes, both persisted). From the coefficients it projects revenue → COGS →
 * gross profit → OpEx → net income → cash forward month by month, and answers
 * "how many months of runway?" and "which single variable moves the result
 * most?" (sensitivity / tornado).
 *
 * Pure, deterministic, IO-free (§20): same inputs → same output, no clocks.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface HybridCoefficient {
  /** Regression-derived default. */
  derived: number;
  /** User override, or null to use the derived value. */
  override: number | null;
  r2?: number;
  n?: number;
}

export function effective(c: HybridCoefficient): number {
  return c.override ?? c.derived;
}

export interface CoefficientSet {
  /** Monthly compounding revenue growth (fraction, e.g. 0.02 = +2%/mo). */
  revenueGrowthMonthlyPct: HybridCoefficient;
  /** COGS as a fraction of revenue. */
  cogsPctOfRevenue: HybridCoefficient;
  /** Fixed operating expense per month ($). */
  opexFixedMonthly: HybridCoefficient;
  /** Variable operating expense as a fraction of revenue. */
  opexVarPctOfRevenue: HybridCoefficient;
}

export type DriverKey = keyof CoefficientSet | "startMonthlyRevenue";

export interface StepChange {
  monthIndex: number;
  amount: number;
  label: string;
}

export interface ProjectionInputsV2 {
  openingCash: number;
  startMonthlyRevenue: number;
  horizonMonths: number;
  startLabel?: string;
  coefficients: CoefficientSet;
  /** One-off cash movements (+in / -out) — equipment buy, loan draw, tax. */
  oneOffs?: StepChange[];
  /** Recurring monthly OpEx delta applied from monthIndex onward (hiring/firing). */
  opexAdjustments?: StepChange[];
  /** Recurring revenue % uplift applied from monthIndex onward (expansion/capacity). */
  revenueUpliftPct?: StepChange[];
}

export interface ProjectionRowV2 {
  monthIndex: number;
  label: string;
  revenue: number;
  cogs: number;
  grossProfit: number;
  opex: number;
  netIncome: number;
  endingCash: number;
}

export interface ProjectionSummaryV2 {
  endingCash: number;
  lowestCash: number;
  lowestMonthLabel: string;
  totalNetIncome: number;
  avgMonthlyNetIncome: number;
  /** Months until cash first goes negative, or null if it never does in-horizon. */
  runwayMonths: number | null;
}

export const HORIZON_MIN = 1;
export const HORIZON_MAX = 120;

function clampHorizon(n: number): number {
  if (!Number.isFinite(n)) return 12;
  const i = Math.floor(n);
  return i < HORIZON_MIN ? HORIZON_MIN : i > HORIZON_MAX ? HORIZON_MAX : i;
}
function money(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}
function num(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

function parseStartLabel(label: string | undefined): { year: number; month: number } | null {
  if (!label) return null;
  const m = label.trim().match(/^([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const idx = MONTHS.findIndex((x) => x.toLowerCase() === m[1].slice(0, 3).toLowerCase());
  return idx < 0 ? null : { year: Number(m[2]), month: idx };
}
function labelFor(start: { year: number; month: number } | null, i: number): string {
  if (!start) return `Month ${i + 1}`;
  const total = start.month + i;
  const year = start.year + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  return `${MONTHS[month]} ${year}`;
}

/** Sum step-change amounts active in a given month (recurring: monthIndex onward). */
function recurringAt(steps: StepChange[] | undefined, i: number): number {
  let total = 0;
  for (const s of steps ?? []) {
    if (Number.isFinite(s.monthIndex) && Number.isFinite(s.amount) && i >= Math.floor(s.monthIndex)) {
      total += s.amount;
    }
  }
  return total;
}
function oneOffAt(steps: StepChange[] | undefined, i: number): number {
  let total = 0;
  for (const s of steps ?? []) {
    if (Number.isFinite(s.monthIndex) && Number.isFinite(s.amount) && Math.floor(s.monthIndex) === i) {
      total += s.amount;
    }
  }
  return total;
}

/**
 * Project the P&L and cash balance forward.
 *
 * For month i (0-based):
 *   revenue  = startRevenue·(1+g)^i · (1 + Σ active revenue uplifts)
 *   cogs     = cogsPct · revenue
 *   opex     = fixedOpex + varOpexPct·revenue + Σ active opex adjustments
 *   net      = revenue - cogs - opex
 *   cash_i   = cash_{i-1} + net + Σ one-offs at i
 * Net income approximates operating cash flow (a forward simplification —
 * working-capital timing is out of scope for Phase 2).
 */
export function projectFinancials(inputs: ProjectionInputsV2): ProjectionRowV2[] {
  const horizon = clampHorizon(inputs.horizonMonths);
  const g = num(effective(inputs.coefficients.revenueGrowthMonthlyPct));
  const cogsPct = num(effective(inputs.coefficients.cogsPctOfRevenue));
  const opexFixed = num(effective(inputs.coefficients.opexFixedMonthly));
  const opexVarPct = num(effective(inputs.coefficients.opexVarPctOfRevenue));
  const startRevenue = num(inputs.startMonthlyRevenue);
  const start = parseStartLabel(inputs.startLabel);

  const rows: ProjectionRowV2[] = [];
  let cash = num(inputs.openingCash);
  for (let i = 0; i < horizon; i++) {
    const uplift = recurringAt(inputs.revenueUpliftPct, i);
    const revenue = startRevenue * Math.pow(1 + g, i) * (1 + uplift);
    const cogs = cogsPct * revenue;
    const grossProfit = revenue - cogs;
    const opex = opexFixed + opexVarPct * revenue + recurringAt(inputs.opexAdjustments, i);
    const netIncome = grossProfit - opex;
    cash = cash + netIncome + oneOffAt(inputs.oneOffs, i);
    rows.push({
      monthIndex: i,
      label: labelFor(start, i),
      revenue: money(revenue),
      cogs: money(cogs),
      grossProfit: money(grossProfit),
      opex: money(opex),
      netIncome: money(netIncome),
      endingCash: money(cash),
    });
  }
  return rows;
}

export function summarizeV2(rows: ProjectionRowV2[]): ProjectionSummaryV2 {
  if (rows.length === 0) {
    return {
      endingCash: 0,
      lowestCash: 0,
      lowestMonthLabel: "",
      totalNetIncome: 0,
      avgMonthlyNetIncome: 0,
      runwayMonths: null,
    };
  }
  let lowestCash = rows[0].endingCash;
  let lowestMonthLabel = rows[0].label;
  let totalNet = 0;
  let runwayMonths: number | null = null;
  for (const r of rows) {
    if (r.endingCash < lowestCash) {
      lowestCash = r.endingCash;
      lowestMonthLabel = r.label;
    }
    if (runwayMonths === null && r.endingCash < 0) runwayMonths = r.monthIndex;
    totalNet += r.netIncome;
  }
  return {
    endingCash: rows[rows.length - 1].endingCash,
    lowestCash: money(lowestCash),
    lowestMonthLabel,
    totalNetIncome: money(totalNet),
    avgMonthlyNetIncome: money(totalNet / rows.length),
    runwayMonths,
  };
}

export type TargetMetric = "endingCash" | "totalNetIncome" | "lowestCash";

function metricValue(inputs: ProjectionInputsV2, metric: TargetMetric): number {
  const s = summarizeV2(projectFinancials(inputs));
  return metric === "endingCash"
    ? s.endingCash
    : metric === "lowestCash"
      ? s.lowestCash
      : s.totalNetIncome;
}

export interface TornadoBar {
  driver: DriverKey;
  label: string;
  low: number;
  high: number;
  base: number;
  /** |high - low| — how much this single driver swings the target. */
  swing: number;
}

const DRIVER_LABELS: Record<DriverKey, string> = {
  startMonthlyRevenue: "Starting revenue",
  revenueGrowthMonthlyPct: "Revenue growth",
  cogsPctOfRevenue: "COGS % of revenue",
  opexFixedMonthly: "Fixed OpEx",
  opexVarPctOfRevenue: "Variable OpEx %",
};

function withDriver(inputs: ProjectionInputsV2, driver: DriverKey, factor: number): ProjectionInputsV2 {
  if (driver === "startMonthlyRevenue") {
    return { ...inputs, startMonthlyRevenue: inputs.startMonthlyRevenue * factor };
  }
  const coef = inputs.coefficients[driver];
  const scaled: HybridCoefficient = { ...coef, override: effective(coef) * factor };
  return { ...inputs, coefficients: { ...inputs.coefficients, [driver]: scaled } };
}

/**
 * Sensitivity / tornado analysis: vary each driver by ±`delta` (relative) and
 * measure the swing in the target metric, largest first — i.e. which single
 * variable moves the result most.
 */
export function tornado(
  inputs: ProjectionInputsV2,
  metric: TargetMetric = "endingCash",
  delta = 0.1,
  drivers: DriverKey[] = [
    "startMonthlyRevenue",
    "revenueGrowthMonthlyPct",
    "cogsPctOfRevenue",
    "opexFixedMonthly",
    "opexVarPctOfRevenue",
  ]
): TornadoBar[] {
  const base = metricValue(inputs, metric);
  return drivers
    .map((driver) => {
      const low = metricValue(withDriver(inputs, driver, 1 - delta), metric);
      const high = metricValue(withDriver(inputs, driver, 1 + delta), metric);
      return {
        driver,
        label: DRIVER_LABELS[driver],
        low: money(low),
        high: money(high),
        base: money(base),
        swing: money(Math.abs(high - low)),
      };
    })
    .sort((a, b) => b.swing - a.swing);
}
