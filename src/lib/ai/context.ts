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
import { isTekmetricConfigured } from "@/lib/tekmetric/client";
import { readOperationsSnapshot } from "@/lib/tekmetric/snapshot";
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

  // Operational actuals from Tekmetric for the same month, read from the cache
  // (no network here — the monthly cron refreshes it first when configured).
  // Absent → ops stays null and the officers note ops data isn't available.
  let ops: MonthlyContext["ops"] = null;
  if (isTekmetricConfigured()) {
    try {
      const snap = await readOperationsSnapshot(
        { start: month.start, end: month.end },
        "prior_period"
      );
      if (snap.data) {
        const d = snap.data;
        ops = {
          kpis: {
            roCount: d.kpis.roCount.value,
            aro: d.kpis.aro.value,
            grossProfit: d.kpis.grossProfit.value,
            grossMarginPct: d.kpis.grossMarginPct.value,
            carCount: d.kpis.carCount.value,
          },
          utilization: d.techUtilization.slice(0, 12).map((u) => ({
            tech: u.technicianName,
            utilizationPct: u.utilizationPct,
            billedHours: u.billedHours,
            effectiveLaborRate: u.effectiveLaborRate,
            postedLaborRate: u.postedLaborRate,
          })),
          revenueByMake: [...d.revenueByMake]
            .sort((a, b) => b.revenue - a.revenue)
            .slice(0, 6)
            .map((m) => ({
              make: m.make,
              revenue: m.revenue,
              grossMarginPct: m.grossMarginPct,
              roCount: m.roCount,
            })),
          advisors: d.advisorPerformance.slice(0, 8).map((a) => ({
            advisor: a.advisorName,
            roCount: a.roCount,
            totalSales: a.totalSales,
            grossMarginPct: a.grossMarginPct,
          })),
        };
      }
    } catch {
      ops = null; // never let an ops read break the council context
    }
  }

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
    ops,
  };
}
