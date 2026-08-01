/**
 * Time-series roll-up (Financial Reporting, Phase 1).
 *
 * QBO monthly reports come back with period columns like "Jan 2026". This rolls
 * those monthly series up to month / quarter / year buckets by summing, so the
 * trend charts can switch granularity without another QBO call.
 *
 * Pure, IO-free, unit-tested (§20).
 */

export type Granularity = "month" | "quarter" | "year";

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

/** Parse a "Mon YYYY" period label into {year, month0}; null if unparseable. */
export function parsePeriodLabel(label: string): { year: number; month0: number } | null {
  const m = /^([A-Za-z]{3,})\.?\s+(\d{4})$/.exec(label.trim());
  if (!m) return null;
  const idx = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (idx < 0) return null;
  return { year: Number(m[2]), month0: idx };
}

export interface RollupBucket {
  label: string;
  value: number;
}

/**
 * Roll a monthly series up to the requested granularity.
 *
 * `periods[i]` labels `values[i]`. Labels that don't parse as "Mon YYYY" are
 * passed through as their own bucket (so a single "Total" column survives). When
 * granularity is "month" the series is returned unchanged.
 */
export function rollupSeries(
  periods: string[],
  values: number[],
  granularity: Granularity
): RollupBucket[] {
  const pairs = periods.map((label, i) => ({ label, value: values[i] ?? 0 }));
  if (granularity === "month") return pairs;

  const order: string[] = [];
  const acc = new Map<string, number>();
  for (const { label, value } of pairs) {
    const parsed = parsePeriodLabel(label);
    let key: string;
    if (!parsed) {
      key = label;
    } else if (granularity === "year") {
      key = String(parsed.year);
    } else {
      const q = Math.floor(parsed.month0 / 3) + 1;
      key = `Q${q} ${parsed.year}`;
    }
    if (!acc.has(key)) order.push(key);
    acc.set(key, round2((acc.get(key) ?? 0) + value));
  }
  return order.map((label) => ({ label, value: acc.get(label) ?? 0 }));
}

function round2(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}
