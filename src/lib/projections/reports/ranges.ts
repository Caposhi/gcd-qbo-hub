/**
 * QBO-style date-range presets and comparison-period math (Financial
 * Reporting, Phase 1).
 *
 * Pure and unit-tested (§20): `now` is always passed in — never read from a
 * clock here — so a given (preset, now) pair is deterministic. Dates are
 * handled as plain YYYY-MM-DD strings in UTC to match what the QBO Reports API
 * expects for `start_date` / `end_date` and to avoid timezone drift.
 */

export type RangePreset =
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "ytd"
  | "trailing_12"
  | "custom";

export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: "this_month", label: "This Month" },
  { value: "last_month", label: "Last Month" },
  { value: "this_quarter", label: "This Quarter" },
  { value: "ytd", label: "Year to Date" },
  { value: "trailing_12", label: "Trailing 12" },
  { value: "custom", label: "Custom" },
];

export type ComparisonMode = "prior_period" | "prior_year";

export interface DateRange {
  /** Inclusive start, YYYY-MM-DD. */
  start: string;
  /** Inclusive end, YYYY-MM-DD. */
  end: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
function iso(y: number, m0: number, d: number): string {
  return `${y}-${pad(m0 + 1)}-${pad(d)}`;
}
/** Days in month m0 (0-based) of year y. */
function daysInMonth(y: number, m0: number): number {
  return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
}

interface YMD {
  y: number;
  m0: number;
  d: number;
}
function partsOf(date: Date): YMD {
  return { y: date.getUTCFullYear(), m0: date.getUTCMonth(), d: date.getUTCDate() };
}
function parseIso(s: string): YMD | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const m0 = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (m0 < 0 || m0 > 11 || d < 1 || d > 31) return null;
  return { y, m0, d };
}

/**
 * Resolve a preset into an inclusive {start,end} range as of `now`.
 * For "custom", `customStart`/`customEnd` are used (falling back to the current
 * month when either is missing/invalid), and start/end are ordered.
 */
export function resolveRange(
  preset: RangePreset,
  now: Date,
  customStart?: string,
  customEnd?: string
): DateRange {
  const { y, m0 } = partsOf(now);

  switch (preset) {
    case "this_month":
      return { start: iso(y, m0, 1), end: iso(y, m0, daysInMonth(y, m0)) };
    case "last_month": {
      const py = m0 === 0 ? y - 1 : y;
      const pm = m0 === 0 ? 11 : m0 - 1;
      return { start: iso(py, pm, 1), end: iso(py, pm, daysInMonth(py, pm)) };
    }
    case "this_quarter": {
      const qStart = Math.floor(m0 / 3) * 3;
      const qEnd = qStart + 2;
      return { start: iso(y, qStart, 1), end: iso(y, qEnd, daysInMonth(y, qEnd)) };
    }
    case "ytd":
      return { start: iso(y, 0, 1), end: iso(y, m0, daysInMonth(y, m0)) };
    case "trailing_12": {
      // The 12 full months ending with the current month.
      const startM = m0 - 11;
      const sy = y + Math.floor(startM / 12);
      const sm = ((startM % 12) + 12) % 12;
      return { start: iso(sy, sm, 1), end: iso(y, m0, daysInMonth(y, m0)) };
    }
    case "custom":
    default: {
      const s = customStart ? parseIso(customStart) : null;
      const e = customEnd ? parseIso(customEnd) : null;
      if (!s && !e) return { start: iso(y, m0, 1), end: iso(y, m0, daysInMonth(y, m0)) };
      const startYmd = s ?? e!;
      const endYmd = e ?? s!;
      const a = iso(startYmd.y, startYmd.m0, startYmd.d);
      const b = iso(endYmd.y, endYmd.m0, endYmd.d);
      return a <= b ? { start: a, end: b } : { start: b, end: a };
    }
  }
}

/** Whole-day span of a range (inclusive), used to shift by a prior period. */
function dayCount(range: DateRange): number {
  const s = Date.parse(`${range.start}T00:00:00Z`);
  const e = Date.parse(`${range.end}T00:00:00Z`);
  return Math.round((e - s) / 86_400_000) + 1;
}

/**
 * The comparison range for a given range.
 *   - prior_period: the equal-length span ending the day before `start`.
 *   - prior_year:   the same calendar dates one year earlier (clamped for leap
 *                   days so Feb 29 → Feb 28).
 */
export function comparisonRange(range: DateRange, mode: ComparisonMode): DateRange {
  if (mode === "prior_year") {
    const s = parseIso(range.start);
    const e = parseIso(range.end);
    if (!s || !e) return range;
    const sd = Math.min(s.d, daysInMonth(s.y - 1, s.m0));
    const ed = Math.min(e.d, daysInMonth(e.y - 1, e.m0));
    return { start: iso(s.y - 1, s.m0, sd), end: iso(e.y - 1, e.m0, ed) };
  }
  // prior_period
  const days = dayCount(range);
  const startMs = Date.parse(`${range.start}T00:00:00Z`);
  const prevEnd = new Date(startMs - 86_400_000);
  const prevStart = new Date(startMs - days * 86_400_000);
  const ps = partsOf(prevStart);
  const pe = partsOf(prevEnd);
  return { start: iso(ps.y, ps.m0, ps.d), end: iso(pe.y, pe.m0, pe.d) };
}

export function isRangePreset(v: unknown): v is RangePreset {
  return (
    v === "this_month" ||
    v === "last_month" ||
    v === "this_quarter" ||
    v === "ytd" ||
    v === "trailing_12" ||
    v === "custom"
  );
}
export function isComparisonMode(v: unknown): v is ComparisonMode {
  return v === "prior_period" || v === "prior_year";
}
