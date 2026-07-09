/**
 * Date parsing and the automation start-date rule (§3, §5).
 *
 * Sheet dates are US-format, human-entered: "7/7/2026", "07/07/2026",
 * "2026-07-07", or a Google Sheets serial number. We normalize to a UTC
 * calendar date (time zeroed) so comparisons are stable regardless of the
 * server timezone — a cash-sheet "date" is a calendar day, not an instant.
 */

/** The automation start date. Rows dated before this are ignored in normal
 *  mode (already manually reconciled); backfill mode can override (§3). */
export const AUTOMATION_START_DATE = new Date(Date.UTC(2026, 6, 7)); // 2026-07-07

// Google Sheets serial date epoch is 1899-12-30 (the well-known Lotus bug).
const SHEETS_EPOCH_UTC = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

export function parseSheetDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined) return null;

  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : utcDateOnly(raw);
  }

  // Numeric serial (or numeric string) from Sheets.
  if (typeof raw === "number") {
    return serialToDate(raw);
  }

  const s = String(raw).trim();
  if (s === "") return null;

  // Pure number as string → treat as serial only if it has no separators and
  // is a plausible serial (> 1000 ≈ year 1902+). Small bare numbers are more
  // likely typos than serials, so we don't guess.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n > 1000) return serialToDate(n);
    return null;
  }

  // ISO: YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const [, y, mo, d] = m;
    return makeUtc(Number(y), Number(mo), Number(d));
  }

  // US: M/D/YYYY or M/D/YY (also accepts '-' separators).
  m = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{2,4})$/);
  if (m) {
    const [, mo, d, yRaw] = m;
    let y = Number(yRaw);
    if (y < 100) y += 2000; // "26" → 2026
    return makeUtc(y, Number(mo), Number(d));
  }

  return null;
}

function makeUtc(year: number, month1: number, day: number): Date | null {
  if (month1 < 1 || month1 > 12) return null;
  if (day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month1 - 1, day));
  // Reject overflow like 2/30 (which JS would roll into March).
  if (d.getUTCMonth() !== month1 - 1 || d.getUTCDate() !== day) return null;
  return d;
}

function serialToDate(serial: number): Date | null {
  if (!Number.isFinite(serial)) return null;
  const ms = SHEETS_EPOCH_UTC + Math.round(serial) * MS_PER_DAY;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : utcDateOnly(d);
}

function utcDateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** True when the row date is on/after the automation start date (§3, §5). */
export function isOnOrAfterStartDate(
  date: Date | null,
  startDate: Date = AUTOMATION_START_DATE
): boolean {
  if (!date) return false;
  return date.getTime() >= startDate.getTime();
}

/** Format a parsed date as YYYY-MM-DD for memos/snapshots. */
export function formatDate(date: Date | null): string {
  if (!date) return "";
  const y = date.getUTCFullYear();
  const mo = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}
