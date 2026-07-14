/**
 * Operations forecast engine (pure, IO-free) — projection scenarios grounded in
 * the backfilled 24-month Tekmetric history.
 *
 * The Projections module already forecasts the P&L from QBO history. This is its
 * operational sibling: it derives per-series monthly trends (RO count, ARO, gross
 * margin) from the shop's own Tekmetric snapshots by auditable linear regression,
 * then projects them forward under editable scenario levers. Revenue is a derived
 * identity — ARO × RO count — and gross profit is revenue × margin, so the whole
 * forecast ties out from three transparent drivers rather than a black box.
 *
 * Everything here is deterministic and takes its inputs as arguments (no clock,
 * no randomness, no IO) so it is fully unit-testable; the cache read lives in the
 * history service.
 */
import { linearRegression, predict, confidenceOf, type Confidence } from "@/lib/projections/regression/ols";

/** One historical month of the operational drivers we project. */
export interface OpsMonth {
  /** First day of the month, "YYYY-MM-DD". */
  start: string;
  /** Display label, e.g. "Jul 2026". */
  label: string;
  roCount: number;
  carCount: number;
  /** Average repair order (USD) = revenue / roCount. */
  aro: number;
  /** Pre-tax revenue (USD) = aro × roCount. */
  revenue: number;
  grossProfit: number;
  /** Gross margin as a percent number (e.g. 55.2), not a fraction. */
  grossMarginPct: number;
}

export interface OpsTrend {
  /** Fitted level at the most recent month (smoother than the raw last point). */
  current: number;
  /** Relative month-over-month growth implied by the raw fit (slope / mean). */
  monthlyGrowthPct: number;
  /**
   * The growth actually used to project, DAMPED by fit confidence: a weak fit
   * (near-zero R²) is indistinguishable from no trend, so we hold it flat (0)
   * rather than compounding noise into a fake decline/climb; moderate fits are
   * halved; strong fits pass through. Prevents a low-R² slope from producing a
   * confident-looking monotonic trend.
   */
  effectiveMonthlyGrowthPct: number;
  r2: number;
  n: number;
  confidence: Confidence;
}

export interface OpsBaseline {
  months: number;
  lastStart: string;
  lastLabel: string;
  roCount: OpsTrend;
  aro: OpsTrend;
  grossMarginPct: OpsTrend;
}

/** Editable levers; when a field is omitted the derived trend is used. */
export interface OpsScenario {
  /** 1–24 months to project. */
  horizonMonths: number;
  /** Month-over-month RO-count growth (fraction, e.g. 0.02 = +2%/mo). */
  roMonthlyGrowthPct?: number;
  /** Month-over-month ARO growth (fraction). */
  aroMonthlyGrowthPct?: number;
  /** Fixed gross-margin override, as a percent number (e.g. 56). */
  grossMarginPct?: number;
}

export interface OpsProjectionMonth {
  monthIndex: number; // 1-based months into the future
  start: string;
  label: string;
  roCount: number;
  aro: number;
  revenue: number;
  grossProfit: number;
  grossMarginPct: number;
}

export interface OpsProjectionSummary {
  horizonMonths: number;
  totalRevenue: number;
  totalGrossProfit: number;
  endingMonthlyRevenue: number;
  endingRoCount: number;
  endingAro: number;
  avgGrossMarginPct: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Add `add` calendar months to a "YYYY-MM-DD" and return the 1st-of-month ISO + "Mon YYYY" label. */
export function monthAfter(startIso: string, add: number): { start: string; label: string } {
  const [y, m] = startIso.split("-").map((s) => parseInt(s, 10));
  // m is 1-based in the ISO string; move to a 0-based absolute month count.
  const abs = (y || 0) * 12 + ((m || 1) - 1) + add;
  const year = Math.floor(abs / 12);
  const monthIdx = ((abs % 12) + 12) % 12;
  const mm = String(monthIdx + 1).padStart(2, "0");
  return { start: `${year}-${mm}-01`, label: `${MONTHS[monthIdx]} ${year}` };
}

/** How much of the fitted slope to trust when projecting, by confidence tier. */
const DAMP: Record<Confidence, number> = { strong: 1, moderate: 0.5, weak: 0 };

/**
 * Flags a month whose figures can only come from a bad/partial data pull, not a
 * real month. At this shop labor carries no COGS, so a real gross margin can't
 * fall near single digits; a meaningful RO count with ~$0 ARO or a sub-20% margin
 * means the sales/cost detail didn't come through. Such months are refused at
 * write time and excluded from the forecast fit so one corrupt pull can't poison
 * the baseline. (Kept intentionally lax — only catches clearly-impossible data.)
 */
export function looksLikePartialMonth(x: { roCount: number; grossMarginPct: number; aro: number }): boolean {
  if (![x.roCount, x.grossMarginPct, x.aro].every(Number.isFinite)) return true;
  return x.roCount >= 10 && (x.grossMarginPct < 20 || x.aro <= 0);
}

/** Median of a numeric list (0 for empty). */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A robust "where we are now": the median of the last up-to-3 observed values. */
function robustCurrent(values: number[]): number {
  return Math.max(0, median(values.slice(-3)));
}

function deriveTrend(history: OpsMonth[], pick: (m: OpsMonth) => number): OpsTrend {
  const values = history.map(pick);
  const points = values.map((y, i) => ({ x: i, y }));
  const fit = linearRegression(points);
  const monthlyGrowthPct = fit.meanY !== 0 ? fit.slope / fit.meanY : 0;
  const confidence = confidenceOf(fit.r2, fit.n);
  const effectiveMonthlyGrowthPct = monthlyGrowthPct * DAMP[confidence];
  // Launch level: when we actually project a trend, start from the fitted line's
  // latest point; when we hold flat (weak fit), anchor at the robust recent
  // actual so the forecast reflects where the shop truly is — not a noisy fit's
  // endpoint that an outlier could have dragged off.
  const current =
    effectiveMonthlyGrowthPct !== 0 ? Math.max(0, predict(fit, Math.max(0, values.length - 1))) : robustCurrent(values);
  return { current, monthlyGrowthPct, effectiveMonthlyGrowthPct, r2: fit.r2, n: fit.n, confidence };
}

/** Derive the operational baseline from trailing monthly history (oldest → newest). */
export function deriveOpsBaseline(history: OpsMonth[]): OpsBaseline {
  // Exclude months that can only be bad data so they can't skew the fit or the
  // current level. Fall back to the full set if that would leave too little.
  const cleaned = history.filter((m) => !looksLikePartialMonth(m));
  const used = cleaned.length >= 3 ? cleaned : history;
  const last = history[history.length - 1]; // labels project forward from the real latest month
  return {
    months: used.length,
    lastStart: last?.start ?? "1970-01-01",
    lastLabel: last?.label ?? "—",
    roCount: deriveTrend(used, (m) => m.roCount),
    aro: deriveTrend(used, (m) => m.aro),
    grossMarginPct: deriveTrend(used, (m) => m.grossMarginPct),
  };
}

/** Clamp a monthly growth rate to a sane band so a noisy fit can't explode. */
function clampGrowth(g: number): number {
  if (!Number.isFinite(g)) return 0;
  return Math.max(-0.5, Math.min(0.5, g));
}

/** Project the operational drivers forward under a scenario. */
export function projectOps(baseline: OpsBaseline, scenario: OpsScenario): OpsProjectionMonth[] {
  const horizon = Math.max(1, Math.min(24, Math.round(scenario.horizonMonths)));
  // Default to the confidence-damped growth (a weak fit projects flat); an
  // explicit scenario override always wins.
  const roGrowth = clampGrowth(scenario.roMonthlyGrowthPct ?? baseline.roCount.effectiveMonthlyGrowthPct);
  const aroGrowth = clampGrowth(scenario.aroMonthlyGrowthPct ?? baseline.aro.effectiveMonthlyGrowthPct);
  const margin =
    scenario.grossMarginPct !== undefined
      ? Math.max(0, Math.min(100, scenario.grossMarginPct))
      : Math.max(0, Math.min(100, baseline.grossMarginPct.current));

  const out: OpsProjectionMonth[] = [];
  for (let t = 1; t <= horizon; t++) {
    const { start, label } = monthAfter(baseline.lastStart, t);
    // RO count is discrete — round it so revenue (= ARO × RO count) ties out in
    // the table instead of using a fractional count behind a rounded display.
    const roCount = Math.max(0, Math.round(baseline.roCount.current * Math.pow(1 + roGrowth, t)));
    const aro = Math.max(0, baseline.aro.current * Math.pow(1 + aroGrowth, t));
    const revenue = roCount * aro;
    const grossProfit = (revenue * margin) / 100;
    out.push({ monthIndex: t, start, label, roCount, aro, revenue, grossProfit, grossMarginPct: margin });
  }
  return out;
}

export function summarizeOpsProjection(rows: OpsProjectionMonth[]): OpsProjectionSummary {
  const last = rows[rows.length - 1];
  const totalRevenue = rows.reduce((a, r) => a + r.revenue, 0);
  const totalGrossProfit = rows.reduce((a, r) => a + r.grossProfit, 0);
  const avgGrossMarginPct = rows.length ? rows.reduce((a, r) => a + r.grossMarginPct, 0) / rows.length : 0;
  return {
    horizonMonths: rows.length,
    totalRevenue,
    totalGrossProfit,
    endingMonthlyRevenue: last?.revenue ?? 0,
    endingRoCount: last?.roCount ?? 0,
    endingAro: last?.aro ?? 0,
    avgGrossMarginPct,
  };
}
