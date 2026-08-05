/**
 * On-demand gap-filling for the composed multi-month Operations view
 * (compose.ts). `composeOperationsRange` already reports exactly which
 * calendar months in a requested range have no cached snapshot yet
 * (`monthsMissing`); this module is what an owner's "Fill missing months"
 * click turns into actual cache writes — the SAME per-month refresh path
 * `npm run tekmetric:backfill` already uses, just for a specific, possibly
 * short list of months instead of the trailing 24.
 *
 * Each month is refreshed via the existing, size-guarded `refreshOperations`
 * (see snapshot.ts's `MAX_REFRESH_RANGE_DAYS`) — a single calendar month is
 * always well under that cap, so this can never reintroduce the OOM this
 * whole effort exists to avoid. What it CAN do is take real wall-clock time:
 * each month is a full Tekmetric pull (paginated) plus a QBO labor-cost
 * lookup, done SEQUENTIALLY (never Promise.all, matching every other
 * multi-month path in this module) to keep peak memory bounded the same way
 * composing already does. Filling a dozen missing months in one call could
 * itself approach an HTTP request timeout well before any memory limit —
 * callers filling more than a handful of months should call this with a
 * SMALL batch (or one month) at a time and show progress between calls,
 * not hand it every missing month in one shot.
 *
 * Always caches under comparisonMode "prior_period", matching the backfill
 * script and the AI council's monthly refresh — the two systematic sources
 * of monthly cache coverage — regardless of what comparison the wide-range
 * VIEW that surfaced the gap happens to be showing. Composition never reads
 * a month's own stored deltas (see `readOperationsSnapshotAnyComparison`),
 * so which comparison mode a month is cached under doesn't affect what
 * composition reads back from it.
 */
import { refreshOperations, fetchTekmetricRoster, type TekRosterCache } from "./snapshot";
import { comparisonRange } from "./periods";
import type { TekPeriod } from "./types";

export interface FillMonthResult {
  label: string;
  start: string;
  end: string;
  ok: boolean;
  /** Present when ok. */
  roCount?: number;
  /** Present when !ok. */
  error?: string;
}

export interface FillMonthsResult {
  results: FillMonthResult[];
  okCount: number;
  failCount: number;
}

/**
 * Refresh a list of calendar months sequentially, sharing one roster
 * (vehicles/employees) pull across all of them the same way the backfill
 * script does — Tekmetric's own docs ask integrations to avoid redundant
 * requests for account-wide data that barely changes month to month. A
 * month that fails (a transient Tekmetric error, a partial-pull refusal,
 * etc.) is recorded and skipped, never aborting the rest of the batch — one
 * bad month shouldn't cost the others.
 */
export async function fillMissingMonths(
  months: Array<{ start: string; end: string; label: string }>,
  roster?: TekRosterCache
): Promise<FillMonthsResult> {
  const sharedRoster = roster ?? (months.length > 0 ? await fetchTekmetricRoster() : undefined);
  const results: FillMonthResult[] = [];

  for (const m of months) {
    const period: TekPeriod = { start: m.start, end: m.end };
    try {
      const data = await refreshOperations(period, "prior_period", comparisonRange(period, "prior_period"), sharedRoster);
      results.push({ label: m.label, start: m.start, end: m.end, ok: true, roCount: data.kpis.roCount.value });
    } catch (err) {
      results.push({
        label: m.label,
        start: m.start,
        end: m.end,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    results,
    okCount: results.filter((r) => r.ok).length,
    failCount: results.filter((r) => !r.ok).length,
  };
}
