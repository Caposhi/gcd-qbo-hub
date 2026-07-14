/**
 * Operations history reader (cache-only) for the ops forecast.
 *
 * Reads the backfilled monthly Tekmetric snapshots straight from the cache —
 * NO network fetch (the refresh path is gated and lives elsewhere). Returns the
 * trailing `months` of operational drivers oldest → newest, or an unavailable
 * result when too few months have been backfilled to derive a trend.
 */
import { readOperationsKpis } from "./snapshot";
import { monthRangesBack, DEFAULT_COMPARISON } from "./periods";
import type { OpsMonth } from "./forecast";

export interface OpsHistoryResult {
  connected: true;
  history: OpsMonth[];
  months: number;
}
export interface OpsHistoryUnavailable {
  connected: false;
  reason: "no_history";
  found: number;
}

/** Minimum months of snapshots needed before a forecast is meaningful. */
const MIN_MONTHS = 3;

export async function loadOpsHistory(
  now: Date,
  months = 24
): Promise<OpsHistoryResult | OpsHistoryUnavailable> {
  const count = Math.max(MIN_MONTHS, Math.min(36, months));
  const ranges = monthRangesBack(now, count); // oldest → newest

  // Read KPIs only, one month at a time. Each snapshot payload also carries the
  // whole month's repair orders/jobs/vehicles/appointments; loading 24 of those
  // at once (Promise.all + full parse) exhausted the 512MB instance. Sequential +
  // KPI-only keeps peak memory to a single row.
  const history: OpsMonth[] = [];
  for (const r of ranges) {
    const kpis = await readOperationsKpis(r, DEFAULT_COMPARISON).catch(() => null);
    if (!kpis) continue; // month not backfilled yet — skip it
    history.push({
      start: r.start,
      label: r.label,
      roCount: kpis.roCount,
      carCount: kpis.carCount,
      aro: kpis.aro,
      // Revenue ties out from the two drivers: ARO = revenue / RO count.
      revenue: kpis.aro * kpis.roCount,
      grossProfit: kpis.grossProfit,
      grossMarginPct: kpis.grossMarginPct,
    });
  }

  if (history.length < MIN_MONTHS) {
    return { connected: false, reason: "no_history", found: history.length };
  }
  return { connected: true, history, months: history.length };
}
