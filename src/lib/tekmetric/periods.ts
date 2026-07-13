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

/** Days in an inclusive range (used to shift the prior-period comparison). */
function rangeLengthDays(range: TekPeriod): number {
  const start = new Date(range.start);
  const end = new Date(range.end);
  return Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
}

/**
 * Comparison range for a given range + mode:
 *  - prior_period: the equal-length window immediately before `range`.
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
  const len = rangeLengthDays(range);
  const start = new Date(range.start);
  const priorEnd = utc(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() - 1);
  const priorStart = utc(priorEnd.getUTCFullYear(), priorEnd.getUTCMonth(), priorEnd.getUTCDate() - (len - 1));
  return { start: iso(priorStart), end: iso(priorEnd) };
}

export const DEFAULT_PRESET: DatePreset = "last_month";
export const DEFAULT_COMPARISON: ComparisonMode = "prior_period";

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
