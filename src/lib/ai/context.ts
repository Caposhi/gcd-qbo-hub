/**
 * Shared monthly context builder (AI C-suite, Phase 3) — IO.
 *
 * Assembles the single data context every agent reads, from the Phase 1
 * reporting cache and the Phase 2 derived baseline. This is the cached baseline
 * the cheap on-demand runs and the monthly meeting both share. Read-only.
 */
import { loadReporting } from "@/lib/projections/report-service";
import { loadBaseline } from "@/lib/projections/baseline-service";
import type { AccountingMethod } from "@/lib/projections/reports";
import type { MonthRange, MonthlyContext, MonthlyKpi } from "./orchestration";

function money2(v: number): string {
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
function pctStr(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * Build the shared context for a month, or return null when QBO isn't connected
 * (and no cache exists) — callers surface a "not available" state.
 */
export async function buildMonthlyContext(
  month: MonthRange,
  method: AccountingMethod,
  now: Date
): Promise<MonthlyContext | null> {
  const reporting = await loadReporting(
    {
      preset: "custom",
      comparison: "prior_period",
      method,
      customStart: month.start,
      customEnd: month.end,
      granularity: "month",
      topN: 8,
    },
    now
  );
  if (!reporting.connected) return null;

  const kpis: MonthlyKpi[] = reporting.kpis.map((k) => ({
    label: k.label,
    value: k.format === "percent" ? pctStr(k.value) : money2(k.value),
    deltaPct: k.delta.pct,
    deltaAbs:
      k.format === "percent"
        ? `${(k.delta.absolute * 100).toFixed(1)} pts`
        : money2(k.delta.absolute),
    sentiment: k.delta.sentiment,
  }));

  const baselineRes = await loadBaseline(now, { months: 24, method });
  const baseline = baselineRes.connected
    ? {
        months: baselineRes.baseline.months,
        revenueGrowthMonthlyPct: baselineRes.baseline.revenueGrowthMonthlyPct.value,
        cogsPctOfRevenue: baselineRes.baseline.cogsPctOfRevenue.value,
        grossMarginPct: baselineRes.baseline.grossMarginPct,
        netMarginPct: baselineRes.baseline.netMarginPct,
        partsPctOfRevenue: baselineRes.baseline.partsPctOfRevenue,
        laborPctOfRevenue: baselineRes.baseline.laborPctOfRevenue,
      }
    : null;

  return {
    month,
    method,
    kpis,
    trend: reporting.trend,
    arTotal: reporting.arAging.total,
    apTotal: reporting.apAging.total,
    topCustomers: reporting.revenueByCustomer.map((c) => ({ name: c.name, amount: c.value })),
    topItems: reporting.revenueByItem.map((i) => ({ name: i.name, amount: i.value })),
    expenseBreakdown: reporting.expenseBreakdown.map((e) => ({ name: e.name, amount: e.value })),
    baseline,
  };
}
