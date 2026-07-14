/**
 * Operations history reader (cache-only) for the ops forecast.
 *
 * Reads the backfilled monthly Tekmetric snapshots straight from the cache —
 * NO network fetch (the refresh path is gated and lives elsewhere). Returns the
 * trailing `months` of operational drivers oldest → newest, or an unavailable
 * result when too few months have been backfilled to derive a trend.
 */
import { readOperationsSnapshot } from "./snapshot";
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

  const snapshots = await Promise.all(
    ranges.map((r) => readOperationsSnapshot(r, DEFAULT_COMPARISON).catch(() => ({ data: null, fetchedAt: null })))
  );

  const history: OpsMonth[] = [];
  ranges.forEach((r, i) => {
    const data = snapshots[i]?.data;
    if (!data) return; // month not backfilled yet — skip it
    const roCount = data.kpis.roCount.value;
    const aro = data.kpis.aro.value;
    history.push({
      start: r.start,
      label: r.label,
      roCount,
      carCount: data.kpis.carCount.value,
      aro,
      // Revenue ties out from the two drivers: ARO = revenue / RO count.
      revenue: aro * roCount,
      grossProfit: data.kpis.grossProfit.value,
      grossMarginPct: data.kpis.grossMarginPct.value,
    });
  });

  if (history.length < MIN_MONTHS) {
    return { connected: false, reason: "no_history", found: history.length };
  }
  return { connected: true, history, months: history.length };
}
