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
  /** Relative month-over-month growth implied by the fit (slope / mean). */
  monthlyGrowthPct: number;
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

function deriveTrend(history: OpsMonth[], pick: (m: OpsMonth) => number): OpsTrend {
  const points = history.map((m, i) => ({ x: i, y: pick(m) }));
  const fit = linearRegression(points);
  const lastX = Math.max(0, history.length - 1);
  const current = Math.max(0, predict(fit, lastX));
  const monthlyGrowthPct = fit.meanY !== 0 ? fit.slope / fit.meanY : 0;
  return {
    current,
    monthlyGrowthPct,
    r2: fit.r2,
    n: fit.n,
    confidence: confidenceOf(fit.r2, fit.n),
  };
}

/** Derive the operational baseline from trailing monthly history (oldest → newest). */
export function deriveOpsBaseline(history: OpsMonth[]): OpsBaseline {
  const last = history[history.length - 1];
  return {
    months: history.length,
    lastStart: last?.start ?? "1970-01-01",
    lastLabel: last?.label ?? "—",
    roCount: deriveTrend(history, (m) => m.roCount),
    aro: deriveTrend(history, (m) => m.aro),
    grossMarginPct: deriveTrend(history, (m) => m.grossMarginPct),
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
  const roGrowth = clampGrowth(scenario.roMonthlyGrowthPct ?? baseline.roCount.monthlyGrowthPct);
  const aroGrowth = clampGrowth(scenario.aroMonthlyGrowthPct ?? baseline.aro.monthlyGrowthPct);
  const margin =
    scenario.grossMarginPct !== undefined
      ? Math.max(0, Math.min(100, scenario.grossMarginPct))
      : Math.max(0, Math.min(100, baseline.grossMarginPct.current));

  const out: OpsProjectionMonth[] = [];
  for (let t = 1; t <= horizon; t++) {
    const { start, label } = monthAfter(baseline.lastStart, t);
    const roCount = Math.max(0, baseline.roCount.current * Math.pow(1 + roGrowth, t));
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
