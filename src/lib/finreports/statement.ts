/**
 * Financial Reports — build & validate hierarchical statements (Phase 1).
 *
 * Turns a parsed QBO report (see lib/projections/reports/qbo.ts, the hub's shared
 * QBO report grammar) into a {@link Statement}: an ordered, depth-aware list of
 * lines with real subtotals, plus the comparison/percent-of-revenue derivations
 * the page and GCD Pal both read.
 *
 * The validator is the point of this file. A financial statement is the one place
 * in the hub where we can prove we read QBO correctly *from the data itself*:
 * every subtotal must equal the sum of its own detail lines, and the grand total
 * must equal the total QBO printed. Same discipline as the deposit checksum — if
 * it doesn't tie, we say so instead of rendering a confident wrong number.
 *
 * Pure: no Prisma / Next / network imports (§20).
 */
import type { QboReport, QboFlatRow } from "@/lib/projections/reports/qbo";
import type {
  AccountingBasis,
  Statement,
  StatementLine,
  StatementLineKind,
  StatementPeriod,
} from "./types";

/** Cent-level tolerance for subtotal checks (QBO rounds each line to cents). */
const TOLERANCE = 0.011;

function round2(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Which value column carries the statement figure.
 *
 * A statement is fetched WITHOUT `summarize_column_by`, so QBO returns a single
 * money column ("Total"). We still resolve it defensively: the declared total
 * column, else a money-typed column, else the last column — and we never pick a
 * quantity/percent column (the bug that made "Revenue by Service" plot units as
 * dollars).
 */
export function pickStatementValueColumn(report: QboReport): number {
  const cols = report.columns;
  if (cols.length === 0) return -1;
  const NON_VALUE = /qty|quantity|units|avg|average|price|rate|%|percent|margin|memo|name|date|num\b/i;
  const usable = cols
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => !NON_VALUE.test(c.title) && !NON_VALUE.test(c.type) && !NON_VALUE.test(c.colKey ?? ""));
  if (report.totalColumnIndex >= 0 && usable.some(({ i }) => i === report.totalColumnIndex)) {
    return report.totalColumnIndex;
  }
  const money = usable.find(({ c }) => /money/i.test(c.type));
  if (money) return money.i;
  return usable.length > 0 ? usable[usable.length - 1].i : cols.length - 1;
}

/**
 * Statement-level totals, by QBO group code or label. Everything else that closes
 * a section is a subtotal.
 *
 * Depth can't make this call: QBO's flattener emits a top-level section's summary
 * at the PARENT's depth (0), so "Total Income" and "Net Income" are both depth 0.
 * The group code (or the label, for reports QBO doesn't code) is what separates
 * "this section's total" from "the statement's bottom line".
 */
const STATEMENT_TOTAL_CODE =
  /^(netincome|netoperatingincome|netcashincrease|totalassets|totalliabilitiesandequity)$/i;
const STATEMENT_TOTAL_LABEL =
  /^(net income|net operating income|net cash (increase|decrease)|total assets|total liabilities and equity)\b/i;

/** Classify a flattened QBO row as a statement line kind. */
function kindOf(row: QboFlatRow, valueIdx: number): StatementLineKind {
  if (row.kind === "section_summary") {
    const code = row.groupCode ?? "";
    return STATEMENT_TOTAL_CODE.test(code) || STATEMENT_TOTAL_LABEL.test(row.label.trim())
      ? "total"
      : "subtotal";
  }
  // A data row with no value in ANY column is a bare label (rare — QBO usually
  // models these as sections, which we synthesize from the group path instead).
  const v = row.values[valueIdx];
  if (v === null || v === undefined) {
    const hasAnyValue = row.values.some((x) => x !== null && x !== undefined);
    if (!hasAnyValue) return "section";
  }
  return "detail";
}

export interface BuildStatementInput {
  key: string;
  title: string;
  period: StatementPeriod;
  basis: AccountingBasis;
  report: QboReport;
  fetchedAt?: string;
}

/**
 * Build a {@link Statement} from a parsed QBO report. Row order is preserved —
 * QBO's flattener emits children before their section summary, which is exactly
 * how a statement reads on paper.
 *
 * Section HEADERS are synthesized from each row's `group` path: QBO's flattener
 * keeps section labels only as breadcrumbs on the child rows and never emits the
 * header itself, so without this an "Income" / "Expenses" statement would render
 * as a bare list of accounts with mystery subtotals.
 */
export function buildStatement(input: BuildStatementInput): Statement {
  const valueIdx = pickStatementValueColumn(input.report);
  const lines: StatementLine[] = [];
  const totals: Record<string, number> = {};
  /** Section path currently "open", so each header is emitted exactly once. */
  let openPath: string[] = [];

  for (const row of input.report.rows) {
    if (row.label.trim() === "" && row.values.every((v) => v === null || v === undefined)) continue;

    // Open any sections this row sits inside that aren't open yet.
    const path = row.group ?? [];
    let common = 0;
    while (common < path.length && common < openPath.length && path[common] === openPath[common]) common++;
    for (let level = common; level < path.length; level++) {
      lines.push({ label: path[level], depth: level, kind: "section", value: null });
    }
    openPath = path;

    const raw = valueIdx >= 0 ? row.values[valueIdx] : null;
    const value = raw === null || raw === undefined ? null : round2(raw);
    const kind = kindOf(row, valueIdx);
    lines.push({
      label: row.label,
      depth: row.depth,
      kind,
      accountId: row.id,
      groupCode: row.groupCode,
      value,
    });
    if ((kind === "total" || kind === "subtotal") && row.groupCode && value !== null) {
      // First writer wins so a nested section can't clobber the statement total.
      if (!(row.groupCode in totals)) totals[row.groupCode] = value;
    }
  }

  return {
    key: input.key,
    title: input.title,
    period: input.period,
    basis: input.basis,
    lines,
    totals,
    fetchedAt: input.fetchedAt,
  };
}

// --- derivations -----------------------------------------------------------

/** Stable identity for joining the same line across two periods. */
function lineKey(l: StatementLine): string {
  return l.accountId ? `id:${l.accountId}` : `l:${l.depth}:${l.label.trim().toLowerCase()}`;
}

/**
 * Join a comparison-period statement onto `current`, filling priorValue/deltas.
 * Lines absent from the prior period get priorValue null (not 0) — "didn't exist"
 * and "was zero" are different facts and a 0 would fabricate a −100% delta.
 */
export function withComparison(current: Statement, prior: Statement): Statement {
  const priorByKey = new Map<string, number | null>();
  for (const l of prior.lines) {
    const k = lineKey(l);
    if (!priorByKey.has(k)) priorByKey.set(k, l.value);
  }
  const lines = current.lines.map((l) => {
    const pv = priorByKey.has(lineKey(l)) ? priorByKey.get(lineKey(l))! : null;
    if (pv === null || l.value === null) {
      return { ...l, priorValue: pv, deltaAbs: null, deltaPct: null };
    }
    const deltaAbs = round2(l.value - pv);
    return {
      ...l,
      priorValue: pv,
      deltaAbs,
      deltaPct: pv !== 0 ? round2((deltaAbs / Math.abs(pv)) * 100) : null,
    };
  });
  return { ...current, comparison: prior.period, lines };
}

/**
 * The statement's revenue base for "% of revenue" — QBO's Income/Total Revenue
 * total when present. Returns null when the statement has no revenue concept
 * (a Balance Sheet), in which case percent-of-revenue is meaningless and omitted.
 */
export function revenueBase(s: Statement): number | null {
  for (const code of ["Income", "TotalIncome", "TotalRevenue"]) {
    const v = s.totals[code];
    if (typeof v === "number" && v !== 0) return v;
  }
  const line = s.lines.find(
    (l) => (l.kind === "subtotal" || l.kind === "total") && /^total (income|revenue)$/i.test(l.label.trim())
  );
  return line && line.value ? line.value : null;
}

/** Add `pctOfRevenue` to every valued line. No-op when there's no revenue base. */
export function withPctOfRevenue(s: Statement, base?: number | null): Statement {
  const rev = base ?? revenueBase(s);
  if (!rev) return s;
  return {
    ...s,
    lines: s.lines.map((l) =>
      l.value === null ? l : { ...l, pctOfRevenue: round2((l.value / rev) * 100) }
    ),
  };
}

// --- validation ------------------------------------------------------------

export interface StatementIssue {
  /** Which line failed (index into `lines`). */
  lineIndex: number;
  label: string;
  kind: "subtotal_mismatch" | "total_mismatch";
  expected: number;
  actual: number;
  diff: number;
}

/**
 * Prove we read the statement correctly: every subtotal/total must equal the sum
 * of the DETAIL lines beneath it (its descendants until a sibling at the same or
 * lower depth). Returns every discrepancy found; an empty array means the
 * statement ties.
 *
 * Callers should treat a non-empty result as "do not present this as fact" — the
 * same stance the deposit reconciler takes when a checksum fails.
 */
export function validateStatement(s: Statement): StatementIssue[] {
  const issues: StatementIssue[] = [];
  const lines = s.lines;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind !== "subtotal" && line.kind !== "total") continue;
    if (line.value === null) continue;

    // Sum the detail lines this subtotal covers: walk BACK to the start of its
    // block — the rows above it at greater depth, stopping at another
    // subtotal/total at the same depth (the previous sibling section).
    let sum = 0;
    let sawDetail = false;
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j];
      if (prev.depth < line.depth) break; // left the enclosing section
      // Its own section header, or the previous sibling's total, bounds the block
      // — so a subtotal can never absorb a neighbouring section's detail lines.
      if (prev.depth === line.depth && (prev.kind === "subtotal" || prev.kind === "total" || prev.kind === "section")) {
        break;
      }
      if (prev.kind === "detail" && prev.value !== null && prev.depth > line.depth) {
        sum += prev.value;
        sawDetail = true;
      }
    }
    if (!sawDetail) continue; // nothing to check against (e.g. a derived total)

    const expected = round2(sum);
    if (Math.abs(expected - line.value) > TOLERANCE) {
      issues.push({
        lineIndex: i,
        label: line.label,
        kind: line.kind === "total" ? "total_mismatch" : "subtotal_mismatch",
        expected,
        actual: line.value,
        diff: round2(line.value - expected),
      });
    }
  }
  return issues;
}

/** Convenience: does the statement tie? */
export function statementTies(s: Statement): boolean {
  return validateStatement(s).length === 0;
}
