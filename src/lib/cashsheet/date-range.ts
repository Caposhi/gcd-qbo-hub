/**
 * Shared date-range presets for any page listing transactions (Queue,
 * Deposits) — pure and unit-tested (§20), no DB/network dependency.
 *
 * All dates are UTC calendar days (time zeroed), matching dates.ts's
 * convention for cash-sheet dates: a "date" here is a calendar day, not an
 * instant, so range math never drifts with server timezone.
 */

export type DateRangePreset =
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "last_quarter"
  | "this_year"
  | "last_year"
  | "custom"
  | "all";

export interface DateRangePresetOption {
  value: DateRangePreset;
  label: string;
}

/** Display order for the preset pills. "All time" is deliberately first —
 *  see resolveDateRange's default: an absent/unknown preset means no filter,
 *  so a Queue link from a status tile (Phase 1) never silently loses rows
 *  outside the current month. */
export const DATE_RANGE_PRESETS: DateRangePresetOption[] = [
  { value: "all", label: "All time" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "this_quarter", label: "This quarter" },
  { value: "last_quarter", label: "Last quarter" },
  { value: "this_year", label: "This year" },
  { value: "last_year", label: "Last year" },
  { value: "custom", label: "Custom" },
];

export interface DateRange {
  /** Inclusive start (UTC midnight), or null for "no lower bound". */
  start: Date | null;
  /** Inclusive end (UTC 23:59:59.999), or null for "no upper bound". */
  end: Date | null;
}

function utcDate(year: number, month0: number, day: number): Date {
  return new Date(Date.UTC(year, month0, day));
}

/** End-of-day (23:59:59.999 UTC) for an inclusive upper bound. */
function endOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
}

/** Parse a plain "YYYY-MM-DD" (e.g. from an <input type="date">) as a UTC date-only. Invalid input → null. */
export function parseDateOnly(raw: string | null | undefined): Date | null {
  const s = (raw ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = utcDate(Number(y), Number(mo) - 1, Number(d));
  // Reject overflow like 2026-02-30.
  if (date.getUTCMonth() !== Number(mo) - 1 || date.getUTCDate() !== Number(d)) return null;
  return date;
}

/**
 * Resolve a preset (relative to `now`) to a concrete {start, end}. An unknown
 * preset — including the absence of one — resolves to "all" (no bound) so a
 * link that doesn't specify a range never silently narrows what it shows.
 */
export function resolveDateRange(
  preset: string | null | undefined,
  opts: { customFrom?: string | null; customTo?: string | null; now?: Date } = {}
): DateRange {
  const now = opts.now ?? new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  const q = Math.floor(m / 3); // 0-3

  switch (preset) {
    case "this_month":
      return { start: utcDate(y, m, 1), end: endOfDay(utcDate(y, m + 1, 0)) };
    case "last_month":
      return { start: utcDate(y, m - 1, 1), end: endOfDay(utcDate(y, m, 0)) };
    case "this_quarter":
      return { start: utcDate(y, q * 3, 1), end: endOfDay(utcDate(y, q * 3 + 3, 0)) };
    case "last_quarter": {
      // JS Date normalizes an out-of-range month (e.g. month -3 in Jan's
      // quarter), so this stays correct across a year boundary without
      // special-casing Q1 → previous year's Q4.
      return { start: utcDate(y, (q - 1) * 3, 1), end: endOfDay(utcDate(y, (q - 1) * 3 + 3, 0)) };
    }
    case "this_year":
      return { start: utcDate(y, 0, 1), end: endOfDay(utcDate(y, 11, 31)) };
    case "last_year":
      return { start: utcDate(y - 1, 0, 1), end: endOfDay(utcDate(y - 1, 11, 31)) };
    case "custom": {
      const start = parseDateOnly(opts.customFrom);
      const endDay = parseDateOnly(opts.customTo);
      return { start, end: endDay ? endOfDay(endDay) : null };
    }
    case "all":
    default:
      return { start: null, end: null };
  }
}

/** Build a Prisma-shaped date filter, omitting bounds that are null. Returns
 *  undefined when the range is fully open (nothing to filter on). */
export function dateRangeWhere(range: DateRange): { gte?: Date; lte?: Date } | undefined {
  if (!range.start && !range.end) return undefined;
  const where: { gte?: Date; lte?: Date } = {};
  if (range.start) where.gte = range.start;
  if (range.end) where.lte = range.end;
  return where;
}

/** Human label for the active range, for a page's filter summary line. */
export function describeDateRange(preset: string, range: DateRange): string {
  const known = DATE_RANGE_PRESETS.find((p) => p.value === preset);
  if (preset === "custom") {
    const f = range.start ? range.start.toISOString().slice(0, 10) : "…";
    const t = range.end ? range.end.toISOString().slice(0, 10) : "…";
    return `${f} → ${t}`;
  }
  return known?.label ?? "All time";
}
