/**
 * Currency parsing (§5).
 *
 * The sheet holds human-entered money: "$1,080.00", "1080", "1,080",
 * "(1,080.00)" (parentheses = negative in accounting notation). We parse
 * defensively and return a number, or null when the cell is empty / not a
 * number. We never throw — a bad cell becomes a validation flag, not a crash.
 */

export function parseCurrency(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;

  // Google Sheets may already hand us a number.
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }

  let s = String(raw).trim();
  if (s === "") return null;

  // Accounting parentheses → negative.
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  // A leading minus sign is also negative.
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  }

  // Strip currency symbols, thousands separators, and spaces. Keep digits and
  // a single decimal point.
  s = s.replace(/[$,\s]/g, "");

  // Reject anything left that isn't a plain decimal number (e.g. "abc", "1.2.3").
  if (!/^\d+(\.\d+)?$/.test(s)) return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  return negative ? -n : n;
}

/**
 * A transaction amount must be numeric and strictly greater than zero (§5).
 * Returns the positive amount, or null if invalid.
 */
export function parsePositiveAmount(raw: unknown): number | null {
  const n = parseCurrency(raw);
  if (n === null) return null;
  if (n <= 0) return null;
  return n;
}

/** True when a cell holds a usable, non-empty value (any parseable number). */
export function hasAmount(raw: unknown): boolean {
  return parseCurrency(raw) !== null;
}
