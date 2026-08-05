/**
 * Financial Reports — build flat tabular reports (Phase 1).
 *
 * For QBO reports that aren't single-value statements: Trial Balance (Debit /
 * Credit columns), P&L Detail and General Ledger (transaction listings), Vendor
 * Expenses. These keep every column QBO returned rather than collapsing to one
 * money value, so nothing is silently dropped and no subtotal is invented.
 *
 * Pure: no Prisma / Next / network imports (§20).
 */
import type { QboReport } from "@/lib/projections/reports/qbo";
import type {
  AccountingBasis,
  StatementPeriod,
  TabularColumn,
  TabularReport,
  TabularRow,
} from "./types";

/** Infer a column type from QBO's ColType/title so the UI can align/format. */
function columnType(title: string, type: string): TabularColumn["type"] {
  const t = `${type} ${title}`;
  if (/money|amount|debit|credit|balance|total|subt/i.test(t)) return "money";
  if (/date/i.test(t)) return "date";
  if (/qty|quantity|units|num\b/i.test(t)) return "number";
  return "text";
}

export interface BuildTabularInput {
  key: string;
  title: string;
  period: StatementPeriod;
  basis: AccountingBasis;
  report: QboReport;
  /** Label for the leading (row-label) column, e.g. "Account" or "Vendor". */
  labelColumn?: string;
  fetchedAt?: string;
}

/**
 * Build a {@link TabularReport}. The leading label column QBO strips from
 * `columns` is re-added as the first column so the grid is self-describing.
 */
export function buildTabular(input: BuildTabularInput): TabularReport {
  const columns: TabularColumn[] = [
    { key: "label", label: input.labelColumn ?? "Account", type: "text" },
    ...input.report.columns.map((c, i) => ({
      key: `c${i}`,
      label: c.title || `Column ${i + 1}`,
      type: columnType(c.title, c.type),
    })),
  ];

  const rows: TabularRow[] = [];
  for (const r of input.report.rows) {
    const blank = r.label.trim() === "" && r.values.every((v) => v === null || v === undefined);
    if (blank) continue;
    const cells: Record<string, string | number | null> = { label: r.label };
    input.report.columns.forEach((c, i) => {
      const num = r.values[i];
      const type = columnType(c.title, c.type);
      // Money/number columns keep the parsed number; text/date keep QBO's string
      // so a memo or a date renders exactly as QBO printed it.
      cells[`c${i}`] =
        type === "money" || type === "number"
          ? (num ?? null)
          : (r.rawValues[i] ?? null) || (num !== null && num !== undefined ? String(num) : null);
    });
    rows.push({ cells, depth: r.depth, isSummary: r.kind === "section_summary" });
  }

  return {
    key: input.key,
    title: input.title,
    period: input.period,
    basis: input.basis,
    columns,
    rows,
    fetchedAt: input.fetchedAt,
  };
}

/**
 * Sum a money column across non-summary rows — used to sanity-check a tabular
 * report against a statement figure (e.g. Vendor Expenses vs P&L expenses).
 * Summary rows are excluded so QBO's own totals aren't double counted.
 */
export function sumColumn(report: TabularReport, columnKey: string): number {
  let sum = 0;
  for (const r of report.rows) {
    if (r.isSummary) continue;
    const v = r.cells[columnKey];
    if (typeof v === "number") sum += v;
  }
  return Math.round((sum + Number.EPSILON) * 100) / 100;
}
