/**
 * Pure date-range helpers for the Tekmetric Operations page filter bar.
 *
 * No IO and no ambient clock: the caller passes `today` (the page passes the
 * request time), so the same inputs always produce the same ranges — unit
 * testable like the rest of src/lib/tekmetric. Ranges are inclusive ISO dates
 * (YYYY-MM-DD), which is what the Tekmetric date filters accept.
 */
import type { TekPeriod } from "./types";

export type DatePreset =
  | "this_month"
  | "last_month"
  | "last_30_days"
  | "last_90_days"
  | "ytd"
  | "last_year";

export type ComparisonMode = "none" | "prior_period" | "prior_year";

export const DATE_PRESETS: Array<{ value: DatePreset; label: string }> = [
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_90_days", label: "Last 90 days" },
  { value: "ytd", label: "Year to date" },
  { value: "last_year", label: "Last year" },
];

export const COMPARISON_MODES: Array<{ value: ComparisonMode; label: string }> = [
  { value: "prior_period", label: "vs prior period" },
  { value: "prior_year", label: "vs prior year" },
  { value: "none", label: "No comparison" },
];

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utc(y: number, m: number, day: number): Date {
  return new Date(Date.UTC(y, m, day));
}

/** Days in month m (0-based) of year y. */
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
}

/** Resolve a preset into an inclusive [start, end] range relative to `today`. */
export function presetRange(preset: DatePreset, today: Date): TekPeriod {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const d = today.getUTCDate();
  switch (preset) {
    case "this_month":
      return { start: iso(utc(y, m, 1)), end: iso(utc(y, m, d)) };
    case "last_month": {
      const start = utc(y, m - 1, 1);
      const end = utc(y, m, 0); // day 0 of this month = last day of prior month
      return { start: iso(start), end: iso(end) };
    }
    case "last_30_days":
      return { start: iso(utc(y, m, d - 29)), end: iso(utc(y, m, d)) };
    case "last_90_days":
      return { start: iso(utc(y, m, d - 89)), end: iso(utc(y, m, d)) };
    case "ytd":
      return { start: iso(utc(y, 0, 1)), end: iso(utc(y, m, d)) };
    case "last_year":
      return { start: iso(utc(y - 1, 0, 1)), end: iso(utc(y - 1, 11, 31)) };
    default:
      return { start: iso(utc(y, m, 1)), end: iso(utc(y, m, d)) };
  }
}

/** Days in an inclusive range (used to shift the prior-period comparison, and
 *  by the live-refresh size guard in snapshot.ts to cap how much repair-order
 *  detail a single request may pull). */
export function rangeLengthDays(range: TekPeriod): number {
  const start = new Date(range.start);
  const end = new Date(range.end);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

/**
 * Whole calendar month(s)? True when `range` starts on the 1st and ends on the
 * last day of a month. "Last month" and month-to-month ranges are the common
 * case, and for those the honest comparison is the PRIOR CALENDAR MONTH — not an
 * equal-length day shift, which would drag in the last day of the month before
 * (e.g. Jul 1–31 → May 31–Jun 30) and compare 31 days against June's 30.
 */
function wholeCalendarMonths(range: TekPeriod): number | null {
  const s = new Date(`${range.start}T00:00:00Z`);
  const e = new Date(`${range.end}T00:00:00Z`);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
  if (s.getUTCDate() !== 1) return null;
  if (e.getUTCDate() !== daysInMonth(e.getUTCFullYear(), e.getUTCMonth())) return null;
  const months =
    (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth()) + 1;
  return months >= 1 ? months : null;
}

/**
 * Comparison range for a given range + mode:
 *  - prior_period: the prior calendar month(s) when `range` is whole calendar
 *    months; otherwise the equal-length window immediately before `range`.
 *  - prior_year:   the same calendar window shifted back one year.
 *  - none:         null (no comparison).
 */
export function comparisonRange(range: TekPeriod, mode: ComparisonMode): TekPeriod | null {
  if (mode === "none") return null;
  if (mode === "prior_year") {
    const start = new Date(range.start);
    const end = new Date(range.end);
    // Clamp the day-of-month so a Feb-29 boundary maps to Feb 28 in a non-leap
    // prior year instead of overflowing to Mar 1 (which would shift and shrink
    // the year-over-year window).
    const sY = start.getUTCFullYear() - 1;
    const eY = end.getUTCFullYear() - 1;
    const sD = Math.min(start.getUTCDate(), daysInMonth(sY, start.getUTCMonth()));
    const eD = Math.min(end.getUTCDate(), daysInMonth(eY, end.getUTCMonth()));
    return {
      start: iso(utc(sY, start.getUTCMonth(), sD)),
      end: iso(utc(eY, end.getUTCMonth(), eD)),
    };
  }
  // prior_period
  // Whole calendar month(s) → the immediately preceding same number of whole
  // calendar months (Jul 1–31 → Jun 1–30), so a 31-day month isn't compared
  // against a 31-day window that straddles two months.
  const months = wholeCalendarMonths(range);
  if (months !== null) {
    const s = new Date(`${range.start}T00:00:00Z`);
    const endM = s.getUTCMonth() - 1; // month before the range starts
    const endY = s.getUTCFullYear();
    const priorEnd = utc(endY, endM + 1, 0); // last day of that month
    const priorStart = utc(priorEnd.getUTCFullYear(), priorEnd.getUTCMonth() - (months - 1), 1);
    return { start: iso(priorStart), end: iso(priorEnd) };
  }
  const len = rangeLengthDays(range);
  const start = new Date(range.start);
  const priorEnd = utc(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - 1);
  const priorStart = utc(priorEnd.getUTCFullYear(), priorEnd.getUTCMonth(), priorEnd.getUTCDate() - (len - 1));
  return { start: iso(priorStart), end: iso(priorEnd) };
}

export const DEFAULT_PRESET: DatePreset = "last_month";
export const DEFAULT_COMPARISON: ComparisonMode = "prior_period";

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The `count` full calendar months ending with the month BEFORE `today`
 * (oldest first). Used by the backfill to snapshot per-month history so trend
 * charts and the projections engine have a series to work with. Pure.
 */
export function monthRangesBack(
  today: Date,
  count: number
): Array<{ start: string; end: string; label: string }> {
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth();
  const out: Array<{ start: string; end: string; label: string }> = [];
  // i = 1 is the prior full month; i = count is the oldest.
  for (let i = count; i >= 1; i--) {
    const monthOffset = m - i;
    const yy = y + Math.floor(monthOffset / 12);
    const mm = ((monthOffset % 12) + 12) % 12;
    out.push({
      start: iso(utc(yy, mm, 1)),
      end: iso(utc(yy, mm, daysInMonth(yy, mm))),
      label: `${MONTH_ABBR[mm]} ${yy}`,
    });
  }
  return out;
}

/**
 * The calendar months a whole-month-aligned range spans, oldest first — the
 * decomposition a wide-range Operations view (e.g. "Last year") composes
 * from the existing per-month `tek_snapshot` cache instead of a live pull
 * (see snapshot.ts's `MAX_REFRESH_RANGE_DAYS` guard and compose.ts).
 *
 * Deliberately narrow: `range` MUST start on the 1st of a month and end on
 * the last day of a month (the same test `wholeCalendarMonths` uses above),
 * because that's exactly how every cached monthly snapshot is keyed
 * (`monthRangesBack`/the backfill script/the AI council's monthly refresh
 * all write one row per exact calendar month). A range like "last_90_days"
 * or "last_30_days" doesn't align to month boundaries at either end, so
 * there is no whole-months decomposition of it that wouldn't either miss
 * partial-month data or double-count days from an adjacent month — callers
 * with a non-aligned range, or "YTD"'s trailing partial current month, must
 * trim to the last full month themselves before calling this. Returns null
 * (never a wrong answer) when `range` isn't whole-month-aligned.
 */
export function monthsInRange(range: TekPeriod): Array<{ start: string; end: string; label: string }> | null {
  const months = wholeCalendarMonths(range);
  if (months === null) return null;
  const s = new Date(`${range.start}T00:00:00Z`);
  const y = s.getUTCFullYear();
  const m = s.getUTCMonth();
  const out: Array<{ start: string; end: string; label: string }> = [];
  for (let i = 0; i < months; i++) {
    const abs = m + i;
    const yy = y + Math.floor(abs / 12);
    const mm = ((abs % 12) + 12) % 12;
    out.push({
      start: iso(utc(yy, mm, 1)),
      end: iso(utc(yy, mm, daysInMonth(yy, mm))),
      label: `${MONTH_ABBR[mm]} ${yy}`,
    });
  }
  return out;
}

/**
 * The one clock-reading helper: "today" as a UTC date whose Y/M/D equal the
 * calendar date in the shop's timezone (SYNC_TZ, default America/New_York).
 * `presetRange` stays pure — callers pass this in — but both the page and the
 * refresh action must call this (not a raw `new Date()`), or a US-evening
 * request (already the next UTC day) computes period boundaries a day off, and
 * a refresh can write a row the page then can't find. Deterministic within a
 * shop-local day.
 */
export function shopToday(tz: string = process.env.SYNC_TZ || "America/New_York"): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const y = get("year");
  const m = get("month");
  const d = get("day");
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    // Fall back to raw UTC if the timezone is somehow unresolvable.
    return new Date();
  }
  return utc(y, m - 1, d);
}
