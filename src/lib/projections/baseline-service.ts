/**
 * Baseline service (Projections engine v2, Phase 2) — the IO layer.
 *
 * Pulls trailing monthly QBO history through the read-only reports cache and
 * feeds the pure derivation (regression/baseline.ts) to produce the editable
 * default coefficients. Also derives the parts-vs-labor revenue split from Item
 * Sales for the margin-mix scenario.
 *
 * Read-only over QBO. The regression/derivation math it calls is pure.
 */
import { getReportSnapshot } from "./report-service";
import { QboNotConnectedError } from "@/lib/qbo/client";
import { deriveBaseline, type MonthlyHistory, type DerivedBaseline } from "./regression/baseline";
import type { PnlNormalized, SalesNormalized, AccountingMethod, DateRange } from "./reports";

/** Classify an Item Sales line as labor vs. parts by name (QBO-only heuristic). */
function isLabor(name: string): boolean {
  return /labor|diag|service|repair|inspect|align|hour/i.test(name);
}

function trailingRange(now: Date, months: number): DateRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  // End at the last day of the PRIOR month (only complete months).
  const end = new Date(Date.UTC(y, m, 0)); // day 0 of this month = last day of prior month
  const startMonth = end.getUTCMonth() - (months - 1);
  const start = new Date(Date.UTC(end.getUTCFullYear(), startMonth, 1));
  const pad = (n: number) => String(n).padStart(2, "0");
  const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return { start: iso(start), end: iso(end) };
}

function historyFromPnl(pnl: PnlNormalized): MonthlyHistory["months"] {
  return pnl.periods.map((period, i) => ({
    period,
    revenue: pnl.income[i] ?? 0,
    cogs: pnl.cogs[i] ?? 0,
    grossProfit: pnl.grossProfit[i] ?? 0,
    opex: pnl.expenses[i] ?? 0,
    netIncome: pnl.netIncome[i] ?? 0,
  }));
}

function partsLaborSplit(items: SalesNormalized): { partsRevenue: number; laborRevenue: number } {
  let parts = 0;
  let labor = 0;
  for (const r of items.rows) {
    if (isLabor(r.name)) labor += r.amount;
    else parts += r.amount;
  }
  return { partsRevenue: parts, laborRevenue: labor };
}

export interface BaselineResult {
  connected: true;
  baseline: DerivedBaseline;
  range: DateRange;
  method: AccountingMethod;
  fetchedAt: Date;
}
export interface BaselineUnavailable {
  connected: false;
  reason: "not_connected";
  range: DateRange;
}

export interface LoadBaselineOptions {
  months?: number;
  method?: AccountingMethod;
  forceRefresh?: boolean;
}

/**
 * Derive the baseline coefficients from the trailing `months` (default 24) of
 * QBO history. Returns `{ connected: false }` when QBO isn't connected and there
 * is no cached history to fall back to.
 */
export async function loadBaseline(
  now: Date,
  opts: LoadBaselineOptions = {}
): Promise<BaselineResult | BaselineUnavailable> {
  const months = Math.max(3, Math.min(60, opts.months ?? 24));
  const method: AccountingMethod = opts.method ?? "accrual";
  const range = trailingRange(now, months);

  try {
    const [pnlR, itemR] = await Promise.all([
      getReportSnapshot("pnl", range, { method, forceRefresh: opts.forceRefresh }),
      getReportSnapshot("item_sales", range, { method, forceRefresh: opts.forceRefresh }),
    ]);
    const pnl = pnlR.payload as PnlNormalized;
    const items = itemR.payload as SalesNormalized;

    const history: MonthlyHistory = {
      months: historyFromPnl(pnl),
      ...partsLaborSplit(items),
    };
    return {
      connected: true,
      baseline: deriveBaseline(history),
      range,
      method,
      fetchedAt: pnlR.fetchedAt < itemR.fetchedAt ? pnlR.fetchedAt : itemR.fetchedAt,
    };
  } catch (err) {
    if (err instanceof QboNotConnectedError) {
      return { connected: false, reason: "not_connected", range };
    }
    throw err;
  }
}
