/**
 * Pure cash-flow projection engine (Financial Projections module, prototype).
 *
 * Deliberately free of Prisma, Next.js, and any network/IO imports so the
 * business rules are unit-testable in isolation (§20) — mirroring the design of
 * the Cash Sheet Sync domain logic under src/lib/cashsheet.
 *
 * Given a set of assumptions (opening balance, baseline monthly inflow/outflow,
 * a compounding growth rate, and optional one-off adjustments), it projects the
 * cash balance forward month by month. Everything here is deterministic and
 * pure: same input → same output, no clocks, no randomness.
 */

export interface ProjectionAssumptions {
  openingBalance: number;
  /** Number of months to project. Clamped to [1, 60]. */
  horizonMonths: number;
  /** Baseline cash in per month (before growth). */
  monthlyInflow: number;
  /** Baseline cash out per month (before growth). */
  monthlyOutflow: number;
  /** % applied compounding to BOTH inflow and outflow each month (can be negative). */
  monthlyGrowthPct: number;
  /** One-off adjustments; monthIndex is 0-based, amount is +in / -out. */
  oneOffs?: Array<{ monthIndex: number; amount: number; label: string }>;
  /** e.g. "Jul 2026" — purely for display labeling. */
  startLabel?: string;
}

export interface ProjectionRow {
  monthIndex: number;
  label: string;
  inflow: number;
  outflow: number;
  net: number;
  endingBalance: number;
  oneOffs: Array<{ amount: number; label: string }>;
}

export interface ProjectionSummary {
  endingBalance: number;
  lowestBalance: number;
  lowestMonthLabel: string;
  totalNet: number;
}

export const HORIZON_MIN = 1;
export const HORIZON_MAX = 60;

export const DEFAULT_ASSUMPTIONS: ProjectionAssumptions = {
  openingBalance: 0,
  horizonMonths: 12,
  monthlyInflow: 0,
  monthlyOutflow: 0,
  monthlyGrowthPct: 0,
  oneOffs: [],
  startLabel: "",
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Round to 2 decimals, avoiding negative-zero and float dust. */
function money(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

function clampHorizon(n: number): number {
  if (!Number.isFinite(n)) return HORIZON_MIN;
  const i = Math.floor(n);
  if (i < HORIZON_MIN) return HORIZON_MIN;
  if (i > HORIZON_MAX) return HORIZON_MAX;
  return i;
}

/**
 * Parse a "Mon YYYY" start label into a {year, month} pair (month 0-based).
 * Returns null when the label is missing or not parseable, so callers can fall
 * back to generic "Month N" labels.
 */
function parseStartLabel(label: string | undefined): { year: number; month: number } | null {
  if (!label) return null;
  const m = label.trim().match(/^([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return null;
  const monName = m[1].slice(0, 3).toLowerCase();
  const monthIdx = MONTHS.findIndex((x) => x.toLowerCase() === monName);
  if (monthIdx < 0) return null;
  return { year: Number(m[2]), month: monthIdx };
}

function labelFor(
  start: { year: number; month: number } | null,
  i: number
): string {
  if (!start) return `Month ${i + 1}`;
  const total = start.month + i;
  const year = start.year + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  return `${MONTHS[month]} ${year}`;
}

/**
 * Project cash flow forward from the given assumptions.
 *
 * Month 0 starts from openingBalance. For month i:
 *   inflow_i  = monthlyInflow  * (1 + g)^i
 *   outflow_i = monthlyOutflow * (1 + g)^i     where g = monthlyGrowthPct / 100
 *   net_i     = inflow_i - outflow_i + sum(oneOffs at monthIndex i)
 *   ending_i  = (previous ending or openingBalance) + net_i
 */
export function projectCashFlow(a: ProjectionAssumptions): ProjectionRow[] {
  const horizon = clampHorizon(a.horizonMonths);
  const g = (Number.isFinite(a.monthlyGrowthPct) ? a.monthlyGrowthPct : 0) / 100;
  const opening = Number.isFinite(a.openingBalance) ? a.openingBalance : 0;
  const baseInflow = Number.isFinite(a.monthlyInflow) ? a.monthlyInflow : 0;
  const baseOutflow = Number.isFinite(a.monthlyOutflow) ? a.monthlyOutflow : 0;
  const start = parseStartLabel(a.startLabel);

  // Group in-range one-offs by their month index.
  const oneOffsByMonth = new Map<number, Array<{ amount: number; label: string }>>();
  for (const o of a.oneOffs ?? []) {
    if (!o || !Number.isFinite(o.monthIndex) || !Number.isFinite(o.amount)) continue;
    const idx = Math.floor(o.monthIndex);
    if (idx < 0 || idx >= horizon) continue; // ignore one-offs outside range
    const list = oneOffsByMonth.get(idx) ?? [];
    list.push({ amount: o.amount, label: String(o.label ?? "") });
    oneOffsByMonth.set(idx, list);
  }

  const rows: ProjectionRow[] = [];
  let running = opening;
  for (let i = 0; i < horizon; i++) {
    const factor = Math.pow(1 + g, i);
    const inflow = baseInflow * factor;
    const outflow = baseOutflow * factor;
    const monthOneOffs = oneOffsByMonth.get(i) ?? [];
    const oneOffSum = monthOneOffs.reduce((s, o) => s + o.amount, 0);
    const net = inflow - outflow + oneOffSum;
    running = running + net;
    rows.push({
      monthIndex: i,
      label: labelFor(start, i),
      inflow: money(inflow),
      outflow: money(outflow),
      net: money(net),
      endingBalance: money(running),
      oneOffs: monthOneOffs.map((o) => ({ amount: money(o.amount), label: o.label })),
    });
  }
  return rows;
}

/**
 * Summarize a projection: final ending balance, the lowest balance reached and
 * the month it occurred, and the total net movement across the horizon.
 */
export function summarize(rows: ProjectionRow[]): ProjectionSummary {
  if (rows.length === 0) {
    return { endingBalance: 0, lowestBalance: 0, lowestMonthLabel: "", totalNet: 0 };
  }
  let lowestBalance = rows[0].endingBalance;
  let lowestMonthLabel = rows[0].label;
  let totalNet = 0;
  for (const r of rows) {
    if (r.endingBalance < lowestBalance) {
      lowestBalance = r.endingBalance;
      lowestMonthLabel = r.label;
    }
    totalNet += r.net;
  }
  return {
    endingBalance: rows[rows.length - 1].endingBalance,
    lowestBalance: money(lowestBalance),
    lowestMonthLabel,
    totalNet: money(totalNet),
  };
}

function coerceNumber(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Validate/coerce a stored JSON blob into safe ProjectionAssumptions so the
 * page and server actions never crash on bad or partial data. Missing or
 * invalid fields fall back to DEFAULT_ASSUMPTIONS.
 */
export function parseAssumptions(json: unknown): ProjectionAssumptions {
  const src: Record<string, unknown> =
    json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};

  const oneOffsRaw = Array.isArray(src.oneOffs) ? src.oneOffs : [];
  const oneOffs = oneOffsRaw
    .map((o) => {
      if (!o || typeof o !== "object") return null;
      const r = o as Record<string, unknown>;
      const monthIndex = coerceNumber(r.monthIndex, NaN);
      const amount = coerceNumber(r.amount, NaN);
      if (!Number.isFinite(monthIndex) || !Number.isFinite(amount)) return null;
      return {
        monthIndex: Math.floor(monthIndex),
        amount,
        label: typeof r.label === "string" ? r.label : "",
      };
    })
    .filter((o): o is { monthIndex: number; amount: number; label: string } => o !== null);

  return {
    openingBalance: coerceNumber(src.openingBalance, DEFAULT_ASSUMPTIONS.openingBalance),
    horizonMonths: clampHorizon(coerceNumber(src.horizonMonths, DEFAULT_ASSUMPTIONS.horizonMonths)),
    monthlyInflow: coerceNumber(src.monthlyInflow, DEFAULT_ASSUMPTIONS.monthlyInflow),
    monthlyOutflow: coerceNumber(src.monthlyOutflow, DEFAULT_ASSUMPTIONS.monthlyOutflow),
    monthlyGrowthPct: coerceNumber(src.monthlyGrowthPct, DEFAULT_ASSUMPTIONS.monthlyGrowthPct),
    oneOffs,
    startLabel: typeof src.startLabel === "string" ? src.startLabel : "",
  };
}
