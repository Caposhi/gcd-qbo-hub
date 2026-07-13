/**
 * Report-specific normalizers (Financial Reporting, Phase 1).
 *
 * Turn a generic {@link QboReport} (flat rows from qbo.ts) into flat, typed
 * metric series per report type. These normalized objects are exactly what gets
 * persisted as `ProjReportSnapshot.payloadJson` and read by the page and the
 * (later) AI job — QBO's nested envelope never leaks past this layer.
 *
 * Pure, IO-free, unit-tested (§20).
 */
import {
  type QboReport,
  type QboFlatRow,
  periodColumnIndices,
} from "./qbo";

export type ReportType =
  | "pnl"
  | "balance_sheet"
  | "ar_aging"
  | "ap_aging"
  | "customer_sales"
  | "item_sales";

export const REPORT_TYPES: ReportType[] = [
  "pnl",
  "balance_sheet",
  "ar_aging",
  "ap_aging",
  "customer_sales",
  "item_sales",
];

export type AccountingMethod = "accrual" | "cash";

/** A named line item with one value per period column. */
export interface LineSeries {
  label: string;
  id?: string;
  values: number[];
}

/** One value per period column, plus the period labels they align to. */
export interface PnlNormalized {
  periods: string[];
  income: number[];
  cogs: number[];
  grossProfit: number[];
  expenses: number[];
  netOperatingIncome: number[];
  netIncome: number[];
  /** Detail income lines (revenue accounts) across the same periods. */
  incomeLines: LineSeries[];
  /** Detail expense lines (operating-expense accounts) across the same periods. */
  expenseLines: LineSeries[];
}

export interface BalanceSheetNormalized {
  asOf?: string;
  cash: number;
  totalCurrentAssets: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  /** Bank/cash accounts, for a drill-down. */
  bankAccounts: LineSeries[];
}

export interface AgingBucket {
  label: string;
  amount: number;
}
export interface AgingRow {
  name: string;
  id?: string;
  buckets: number[];
  total: number;
}
export interface AgingNormalized {
  asOf?: string;
  bucketLabels: string[];
  /** Grand-total across all entities, per bucket. */
  totals: number[];
  /** Grand-total across all buckets. */
  total: number;
  /** Per customer / vendor. */
  rows: AgingRow[];
}

export interface SalesRow {
  name: string;
  id?: string;
  amount: number;
}
export interface SalesNormalized {
  total: number;
  rows: SalesRow[];
}

const ZERO_IF_NULL = (v: number | null | undefined): number => (typeof v === "number" ? v : 0);

/** Values at the period columns (grand-total column dropped) for a row. */
function periodValues(report: QboReport, row: QboFlatRow): number[] {
  return periodColumnIndices(report).map((i) => ZERO_IF_NULL(row.values[i]));
}

function periodLabels(report: QboReport): string[] {
  return periodColumnIndices(report).map((i) => report.columns[i]?.title ?? `Period ${i + 1}`);
}

/** Find the first row matching a group code (case-insensitive) and kind preference. */
function findByGroup(
  report: QboReport,
  groupCode: string,
  prefer: "section_summary" | "data" | "any" = "any"
): QboFlatRow | undefined {
  const matches = report.rows.filter(
    (r) => (r.groupCode ?? "").toLowerCase() === groupCode.toLowerCase()
  );
  if (prefer !== "any") {
    return matches.find((r) => r.kind === prefer) ?? matches[0];
  }
  return matches[0];
}

/** Find a section summary whose label matches a regex (fallback when no group code). */
function findSummaryByLabel(report: QboReport, re: RegExp): QboFlatRow | undefined {
  return report.rows.find((r) => r.kind === "section_summary" && re.test(r.label));
}

function seriesFor(
  report: QboReport,
  groupCode: string,
  labelFallback: RegExp,
  prefer: "section_summary" | "data" | "any"
): number[] {
  const row =
    findByGroup(report, groupCode, prefer) ?? findSummaryByLabel(report, labelFallback);
  const len = periodColumnIndices(report).length;
  return row ? periodValues(report, row) : new Array(len).fill(0);
}

/** Detail leaf rows belonging to a group (e.g. income/expense accounts). */
function detailLines(report: QboReport, groupCode: string): LineSeries[] {
  return report.rows
    .filter(
      (r) =>
        r.kind === "data" &&
        (r.groupCode ?? "").toLowerCase() === groupCode.toLowerCase() &&
        // Exclude the special single-line totals (GrossProfit/NetIncome) that
        // carry their own distinct group code, not this section's.
        r.label.trim() !== ""
    )
    .map((r) => ({ label: r.label, id: r.id, values: periodValues(report, r) }));
}

export function normalizePnl(report: QboReport): PnlNormalized {
  return {
    periods: periodLabels(report),
    income: seriesFor(report, "Income", /^total income$/i, "section_summary"),
    cogs: seriesFor(report, "COGS", /cost of goods sold/i, "section_summary"),
    grossProfit: seriesFor(report, "GrossProfit", /^gross profit$/i, "data"),
    expenses: seriesFor(report, "Expenses", /^total expenses$/i, "section_summary"),
    netOperatingIncome: seriesFor(
      report,
      "NetOperatingIncome",
      /^net operating income$/i,
      "data"
    ),
    netIncome: seriesFor(report, "NetIncome", /^net income$/i, "data"),
    incomeLines: detailLines(report, "Income"),
    expenseLines: detailLines(report, "Expenses"),
  };
}

/** Sum a row's values across periods (BS is usually single-column, but be safe). */
function rowTotal(report: QboReport, row: QboFlatRow | undefined): number {
  if (!row) return 0;
  // Prefer the grand-total column if present, else the first value column.
  const idx = report.totalColumnIndex >= 0 ? report.totalColumnIndex : 0;
  return ZERO_IF_NULL(row.values[idx]);
}

export function normalizeBalanceSheet(report: QboReport): BalanceSheetNormalized {
  const bankSummary =
    findByGroup(report, "BankAccounts", "section_summary") ??
    findSummaryByLabel(report, /^total bank accounts$/i);
  const bankAccounts = report.rows
    .filter(
      (r) =>
        r.kind === "data" &&
        ((r.groupCode ?? "").toLowerCase() === "bankaccounts" ||
          r.group.some((g) => /bank accounts/i.test(g)))
    )
    .map((r) => ({
      label: r.label,
      id: r.id,
      values: [rowTotal(report, r)],
    }));

  return {
    asOf: report.endPeriod,
    cash: rowTotal(report, bankSummary),
    totalCurrentAssets: rowTotal(
      report,
      findByGroup(report, "TotalCurrentAssets", "section_summary") ??
        findSummaryByLabel(report, /^total current assets$/i)
    ),
    totalAssets: rowTotal(
      report,
      findByGroup(report, "TotalAssets", "any") ??
        findSummaryByLabel(report, /^total assets$/i)
    ),
    totalLiabilities: rowTotal(
      report,
      findByGroup(report, "TotalLiabilities", "any") ??
        findSummaryByLabel(report, /^total liabilities$/i)
    ),
    totalEquity: rowTotal(
      report,
      findByGroup(report, "TotalEquity", "any") ??
        findSummaryByLabel(report, /^total equity$/i)
    ),
    bankAccounts: bankAccounts.length
      ? bankAccounts
      : bankSummary
        ? [{ label: bankSummary.label, values: [rowTotal(report, bankSummary)] }]
        : [],
  };
}

/**
 * Aging (A/R or A/P). Value columns are the buckets plus a trailing Total; the
 * bucket labels come straight from the column titles so QBO wording drives the
 * chart. The grand-total row is the section summary / "Total" row.
 */
export function normalizeAging(report: QboReport): AgingNormalized {
  const totalIdx = report.totalColumnIndex;
  const bucketIdx = report.columns
    .map((_, i) => i)
    .filter((i) => i !== totalIdx);
  const bucketLabels = bucketIdx.map((i) => report.columns[i]?.title ?? `Bucket ${i + 1}`);

  const summaryRow =
    report.rows.find((r) => r.kind === "section_summary") ??
    report.rows.find((r) => /^total$/i.test(r.label));

  // Per-entity rows: real data rows, excluding blanks and any grand-total row
  // (QBO sometimes emits the total as a flat data row labelled "Total").
  const dataRows = report.rows.filter(
    (r) => r.kind === "data" && r.label.trim() !== "" && r !== summaryRow && !/^total$/i.test(r.label)
  );
  const rows: AgingRow[] = dataRows.map((r) => {
    const buckets = bucketIdx.map((i) => ZERO_IF_NULL(r.values[i]));
    const total =
      totalIdx >= 0
        ? ZERO_IF_NULL(r.values[totalIdx])
        : buckets.reduce((a, b) => a + b, 0);
    return { name: r.label, id: r.id, buckets, total };
  });

  const totals = summaryRow
    ? bucketIdx.map((i) => ZERO_IF_NULL(summaryRow.values[i]))
    : bucketLabels.map((_, bi) => rows.reduce((a, row) => a + (row.buckets[bi] ?? 0), 0));
  const total = totals.reduce((a, b) => a + b, 0);

  return { asOf: report.endPeriod, bucketLabels, totals, total, rows };
}

/**
 * Sales by customer / item. Picks the money column (prefer the grand-total, then
 * a column titled Amount/Total, then the last value column) and one row per
 * entity, sorted by amount descending.
 */
export function normalizeSales(report: QboReport): SalesNormalized {
  const moneyIdx =
    report.totalColumnIndex >= 0
      ? report.totalColumnIndex
      : (() => {
          const byTitle = report.columns.findIndex((c) => /amount|total/i.test(c.title));
          if (byTitle >= 0) return byTitle;
          const lastMoney = [...report.columns]
            .map((c, i) => ({ c, i }))
            .reverse()
            .find(({ c }) => /money/i.test(c.type));
          return lastMoney ? lastMoney.i : report.columns.length - 1;
        })();

  const rows: SalesRow[] = report.rows
    .filter(
      (r) =>
        r.kind === "data" &&
        r.label.trim() !== "" &&
        !/^total\b/i.test(r.label) &&
        !/not specified/i.test(r.label)
    )
    .map((r) => ({ name: r.label, id: r.id, amount: ZERO_IF_NULL(r.values[moneyIdx]) }))
    .filter((r) => r.amount !== 0)
    .sort((a, b) => b.amount - a.amount);

  const summaryRow =
    report.rows.find((r) => r.kind === "section_summary") ??
    report.rows.find((r) => /^total\b/i.test(r.label));
  const total = summaryRow
    ? ZERO_IF_NULL(summaryRow.values[moneyIdx])
    : rows.reduce((a, r) => a + r.amount, 0);

  return { total, rows };
}

export function isReportType(v: unknown): v is ReportType {
  return typeof v === "string" && (REPORT_TYPES as string[]).includes(v);
}
export function isAccountingMethod(v: unknown): v is AccountingMethod {
  return v === "accrual" || v === "cash";
}
