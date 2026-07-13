/**
 * Period-over-period deltas and KPI derivation (Financial Reporting, Phase 1).
 *
 * The bookkeeper's monthly PDF showed each figure with its up/down % and $
 * delta versus a comparison period, coloured for good/bad. This module is the
 * pure math behind those KPI tiles: it computes deltas, decides whether a move
 * is favourable given the metric's polarity, and assembles the standard KPI set
 * from normalized P&L / Balance Sheet / aging reports.
 *
 * Pure, IO-free, unit-tested (§20).
 */
import type { PnlNormalized, BalanceSheetNormalized } from "./normalize";

export type Direction = "up" | "down" | "flat";
/** Whether a rise in this metric is good, bad, or neither. */
export type Polarity = "higher_better" | "lower_better" | "neutral";
/** Whether the actual move was favourable. */
export type Sentiment = "good" | "bad" | "neutral";

export interface Delta {
  current: number;
  previous: number;
  /** current - previous. */
  absolute: number;
  /** Fractional change vs |previous| (e.g. 0.125 = +12.5%); null when previous is 0. */
  pct: number | null;
  direction: Direction;
  sentiment: Sentiment;
}

const EPS = 0.005; // sub-cent / sub-tenth-of-a-percent noise floor

/** Compute a delta between current and previous, given metric polarity. */
export function computeDelta(
  current: number,
  previous: number,
  polarity: Polarity
): Delta {
  const absolute = round2(current - previous);
  const direction: Direction =
    Math.abs(absolute) < EPS ? "flat" : absolute > 0 ? "up" : "down";
  const pct = Math.abs(previous) < EPS ? null : (current - previous) / Math.abs(previous);

  let sentiment: Sentiment = "neutral";
  if (direction !== "flat" && polarity !== "neutral") {
    const favourableUp = polarity === "higher_better";
    sentiment = (direction === "up") === favourableUp ? "good" : "bad";
  }
  return { current: round2(current), previous: round2(previous), absolute, pct, direction, sentiment };
}

function round2(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/** Safe margin: numerator/denominator as a fraction, 0 when denominator ~0. */
export function marginPct(numerator: number, denominator: number): number {
  if (Math.abs(denominator) < EPS) return 0;
  return numerator / denominator;
}

/** Sum an array (used to collapse a multi-period series to a single figure). */
export function sum(values: number[]): number {
  return round2(values.reduce((a, b) => a + b, 0));
}

export type KpiKey =
  | "total_revenue"
  | "gross_profit"
  | "gross_margin_pct"
  | "net_income"
  | "net_margin_pct"
  | "operating_expenses"
  | "ar_total"
  | "ap_total"
  | "cash";

export type KpiFormat = "money" | "percent";

export interface Kpi {
  key: KpiKey;
  label: string;
  format: KpiFormat;
  value: number;
  polarity: Polarity;
  delta: Delta;
}

export interface KpiInputs {
  pnl: PnlNormalized;
  pnlPrev: PnlNormalized;
  balanceSheet: BalanceSheetNormalized;
  balanceSheetPrev: BalanceSheetNormalized;
  arTotal: number;
  arTotalPrev: number;
  apTotal: number;
  apTotalPrev: number;
}

const KPI_META: Record<KpiKey, { label: string; format: KpiFormat; polarity: Polarity }> = {
  total_revenue: { label: "Total Revenue", format: "money", polarity: "higher_better" },
  gross_profit: { label: "Gross Profit", format: "money", polarity: "higher_better" },
  gross_margin_pct: { label: "Gross Margin", format: "percent", polarity: "higher_better" },
  net_income: { label: "Net Income", format: "money", polarity: "higher_better" },
  net_margin_pct: { label: "Net Margin", format: "percent", polarity: "higher_better" },
  operating_expenses: { label: "Operating Expenses", format: "money", polarity: "lower_better" },
  ar_total: { label: "A/R Total", format: "money", polarity: "lower_better" },
  ap_total: { label: "A/P Total", format: "money", polarity: "lower_better" },
  cash: { label: "Cash Position", format: "money", polarity: "higher_better" },
};

function kpi(key: KpiKey, value: number, prev: number): Kpi {
  const meta = KPI_META[key];
  return {
    key,
    label: meta.label,
    format: meta.format,
    value: meta.format === "percent" ? value : round2(value),
    polarity: meta.polarity,
    delta: computeDelta(value, prev, meta.polarity),
  };
}

/**
 * Assemble the standard KPI set the Reporting page renders as tiles.
 * Revenue/GP/OpEx/NI are summed across the P&L periods (so a multi-month range
 * collapses to a single figure); margins are ratios of those sums.
 */
export function deriveKpis(inp: KpiInputs): Kpi[] {
  const revenue = sum(inp.pnl.income);
  const revenuePrev = sum(inp.pnlPrev.income);
  const grossProfit = sum(inp.pnl.grossProfit);
  const grossProfitPrev = sum(inp.pnlPrev.grossProfit);
  const netIncome = sum(inp.pnl.netIncome);
  const netIncomePrev = sum(inp.pnlPrev.netIncome);
  const opex = sum(inp.pnl.expenses);
  const opexPrev = sum(inp.pnlPrev.expenses);

  return [
    kpi("total_revenue", revenue, revenuePrev),
    kpi("gross_profit", grossProfit, grossProfitPrev),
    kpi("gross_margin_pct", marginPct(grossProfit, revenue), marginPct(grossProfitPrev, revenuePrev)),
    kpi("net_income", netIncome, netIncomePrev),
    kpi("net_margin_pct", marginPct(netIncome, revenue), marginPct(netIncomePrev, revenuePrev)),
    kpi("operating_expenses", opex, opexPrev),
    kpi("ar_total", inp.arTotal, inp.arTotalPrev),
    kpi("ap_total", inp.apTotal, inp.apTotalPrev),
    kpi("cash", inp.balanceSheet.cash, inp.balanceSheetPrev.cash),
  ];
}
