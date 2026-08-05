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
  type QboColumn,
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
  /**
   * COGS "Labor Wages" line (its own rolled-up total, inclusive of any
   * sub-accounts like an owner's contract-labor draw) — the real,
   * payroll-sourced labor cost, for Tekmetric Operations to subtract from
   * gross profit instead of treating labor as free (see
   * src/lib/tekmetric/labor-cost.ts). `null` when the company's COGS section
   * has no such line — deliberately not zero-filled, so "no such line" isn't
   * mistaken for "labor cost is zero."
   */
  laborCost: number[] | null;
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

/**
 * Find the grand-total row for a group code (case-insensitive), honouring a kind
 * preference. When a section nests sub-sections that inherit the same group code
 * (e.g. an "Expenses" section with expense sub-groups), each sub-total carries
 * the same group code, so we must return the OUTERMOST (shallowest `depth`) row
 * — the group's grand total — not merely the first one encountered (which is an
 * inner sub-total, and was the cause of Operating Expenses reading a tiny
 * sub-section figure instead of Total Expenses).
 */
function findByGroup(
  report: QboReport,
  groupCode: string,
  prefer: "section_summary" | "data" | "any" = "any"
): QboFlatRow | undefined {
  const matches = report.rows.filter(
    (r) => (r.groupCode ?? "").toLowerCase() === groupCode.toLowerCase()
  );
  const preferred = prefer !== "any" ? matches.filter((r) => r.kind === prefer) : matches;
  const pool = preferred.length > 0 ? preferred : matches;
  return pool.reduce<QboFlatRow | undefined>(
    (best, r) => (best === undefined || r.depth < best.depth ? r : best),
    undefined
  );
}

/** Find a section summary whose label matches a regex (fallback when no group code). */
function findSummaryByLabel(report: QboReport, re: RegExp): QboFlatRow | undefined {
  return report.rows.find((r) => r.kind === "section_summary" && re.test(r.label));
}

/**
 * Find a specific account (or account group) inside a section by label match
 * — e.g. "Labor Wages" within COGS — preferring the OUTERMOST (shallowest
 * `depth`) match, same reasoning as {@link findByGroup}: an account with
 * sub-accounts reports both its own rolled-up "Total X" summary row AND each
 * sub-account's individual leaf row under it, and the summary already
 * includes the sub-accounts — summing both would double-count.
 *
 * Matches by `groupCode` OR by the row's own section-header path mentioning
 * `sectionLabelRe` — a sub-account line doesn't always inherit its section's
 * groupCode (confirmed against a real chart of accounts with
 * scripts/qbo-diagnose-cogs.ts, which found "OWNER - Contract Labor" only via
 * its group path, not a shared groupCode). Returns `null` — not a zero-filled
 * array — when nothing matches, so a caller can tell "this company's chart of
 * accounts has no such line" from "this line is genuinely zero," which
 * matters when the caller would otherwise treat a wrong silent 0 as real.
 */
function findLineByLabel(
  report: QboReport,
  groupCode: string,
  sectionLabelRe: RegExp,
  labelRe: RegExp
): number[] | null {
  const matches = report.rows.filter(
    (r) =>
      labelRe.test(r.label) &&
      ((r.groupCode ?? "").toLowerCase() === groupCode.toLowerCase() || r.group.some((g) => sectionLabelRe.test(g)))
  );
  const row = matches.reduce<QboFlatRow | undefined>(
    (best, r) => (best === undefined || r.depth < best.depth ? r : best),
    undefined
  );
  return row ? periodValues(report, row) : null;
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

/** True when the report actually carries a row for this group code. */
function hasGroup(report: QboReport, groupCode: string): boolean {
  return report.rows.some((r) => (r.groupCode ?? "").toLowerCase() === groupCode.toLowerCase());
}

export function normalizePnl(report: QboReport): PnlNormalized {
  const income = seriesFor(report, "Income", /^total income$/i, "section_summary");
  const cogs = seriesFor(report, "COGS", /cost of goods sold/i, "section_summary");
  const expenses = seriesFor(report, "Expenses", /^total expenses$/i, "section_summary");

  // The single-line totals (Gross Profit / Net Operating Income / Net Income)
  // may arrive as a `data` row OR a summary-only row depending on the QBO
  // company, so match on "any" kind. When a company has no COGS section QBO
  // omits Gross Profit entirely — fall back to the accounting identity
  // (income − cogs) so the tile shows the real figure instead of 0. Likewise
  // derive Net Income from the operating figures if QBO didn't surface it.
  const grossProfit = hasGroup(report, "GrossProfit")
    ? seriesFor(report, "GrossProfit", /^gross profit$/i, "any")
    : income.map((v, i) => v - (cogs[i] ?? 0));

  const netOperatingIncome = hasGroup(report, "NetOperatingIncome")
    ? seriesFor(report, "NetOperatingIncome", /^net operating income$/i, "any")
    : grossProfit.map((v, i) => v - (expenses[i] ?? 0));

  const netIncome = hasGroup(report, "NetIncome")
    ? seriesFor(report, "NetIncome", /^net income$/i, "any")
    : netOperatingIncome.slice();

  return {
    periods: periodLabels(report),
    income,
    cogs,
    grossProfit,
    expenses,
    netOperatingIncome,
    netIncome,
    incomeLines: detailLines(report, "Income"),
    expenseLines: detailLines(report, "Expenses"),
    laborCost: findLineByLabel(report, "COGS", /cost of goods sold/i, /labor.*wages/i),
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
/**
 * Choose the dollar column for a sales report. Prefer the grand-total column;
 * otherwise pick the sales amount, never a quantity / avg-price / %-of-sales /
 * margin / cost column. A Sales-by-Item report leads with a "Qty" (Numeric)
 * column and also carries "Avg Price" (Money), so a naive "last money column"
 * or "last column" pick lands on the wrong figure — this picker excludes those.
 */
function pickMoneyColumnIndex(report: QboReport): number {
  const cols = report.columns;
  if (cols.length === 0) return -1;

  // A column that is definitely NOT the sales amount — quantity, unit/avg price,
  // %-of-sales, margin, cost, SKU. Checked against title, ColType, AND ColKey,
  // because QBO's Sales-by-Item report labels these inconsistently (a leading
  // "Qty" column can carry a blank title), and picking it plots units as dollars.
  const NON_AMOUNT = /qty|quantity|units|avg|average|price|rate|%|percent|margin|\bcost\b|sku/i;
  const excluded = (c: QboColumn) => NON_AMOUNT.test(c.title) || NON_AMOUNT.test(c.type) || NON_AMOUNT.test(c.colKey ?? "");
  const looksAmount = (c: QboColumn) =>
    c.colKey === "total" || /amount|sales|subt_?nat|^total$/i.test(c.title) || /amount|sales|subt/i.test(c.colKey ?? "");

  const candidates = cols.map((c, i) => ({ c, i })).filter(({ c }) => !excluded(c));

  // 1) An explicit amount/sales/total column that isn't a qty/price/% column.
  const explicit = candidates.find(({ c }) => looksAmount(c));
  if (explicit) return explicit.i;

  // 2) The report's declared total column — but only if it isn't itself a
  //    qty/price/% column (QBO sometimes flags the wrong one).
  if (report.totalColumnIndex >= 0 && !excluded(cols[report.totalColumnIndex])) return report.totalColumnIndex;

  // 3) Ambiguous metadata (blank titles/types): the sales amount is the column
  //    with the largest dollar magnitude across data rows — Amount dwarfs Qty,
  //    Avg Price, and %. Self-correcting when the labels don't help.
  const dataRows = report.rows.filter((r) => r.kind === "data");
  let best = -1;
  let bestMag = -1;
  for (const { i } of candidates) {
    const mag = dataRows.reduce((s, r) => s + Math.abs(ZERO_IF_NULL(r.values[i])), 0);
    if (mag > bestMag) {
      bestMag = mag;
      best = i;
    }
  }
  if (best >= 0) return best;

  // 4) last resort
  return report.totalColumnIndex >= 0 ? report.totalColumnIndex : cols.length - 1;
}

/**
 * Pick the sales-dollar column from the report's OWN arithmetic, not its column
 * titles.
 *
 * Title heuristics are brittle — QBO titles this column inconsistently across
 * report variants — and a mis-pick silently charts the wrong series. On the live
 * ItemSales report the picker landed on **Qty**: parts showed "1,483.79", which
 * is the quantity, not the $98,938.69 of parts sales.
 *
 * Two report-internal facts identify the right column without trusting names:
 *
 *  1. ADDITIVITY — the column's item rows must sum to that column's own Total
 *     row. This eliminates per-unit columns (an average of averages never sums
 *     to the overall average) but NOT Qty, which is also additive.
 *
 *  2. THE "% of Sales" COLUMN — QBO computes those percentages from the dollar
 *     column, so for the right column each row's share of the total matches its
 *     stated percentage. Parts is 42.3% of sales: 98,938.69 / 233,913.96 = 42.3%
 *     ✓, while 1,483.79 / 2,197.92 = 67.5% ✗. This is what separates dollars
 *     from quantity.
 *
 * Returns -1 when the report gives us nothing to check against, so the caller
 * falls back to the title heuristics.
 */
function pickColumnByTotalReconciliation(
  report: QboReport,
  dataRows: QboFlatRow[],
  totalRow: QboFlatRow
): number {
  const cols = report.columns;
  const val = (r: QboFlatRow, i: number) => ZERO_IF_NULL(r.values[i]);
  const idxs = cols.map((_, i) => i);
  if (dataRows.length === 0) return -1;

  // The "% of Sales" column: titled as a percentage, or whose rows sum to ~100.
  const pctIdx = idxs.find((i) => {
    if (/%|percent/i.test(cols[i].title)) return true;
    if (/money/i.test(cols[i].type)) return false;
    const s = dataRows.reduce((a, r) => a + val(r, i), 0);
    return dataRows.length > 1 && Math.abs(s - 100) < 1.5;
  });

  // Columns whose rows sum to their own Total (within 1% for rounding).
  const additive = idxs.filter((i) => {
    if (i === pctIdx) return false;
    const total = val(totalRow, i);
    if (total === 0) return false;
    const sum = dataRows.reduce((a, r) => a + val(r, i), 0);
    return Math.abs(sum - total) / Math.abs(total) <= 0.01;
  });

  if (additive.length === 0) return -1;
  if (additive.length === 1) return additive[0];

  // More than one additive column (classic ItemSales: Qty AND Amount). Ask the
  // percentages which one they were derived from.
  if (pctIdx !== undefined) {
    let best = -1;
    let bestErr = Infinity;
    for (const i of additive) {
      const total = val(totalRow, i);
      const err = dataRows.reduce(
        (a, r) => a + Math.abs((val(r, i) / total) * 100 - val(r, pctIdx)),
        0
      );
      if (err < bestErr) {
        bestErr = err;
        best = i;
      }
    }
    // Average deviation under a point per row means these percentages really
    // came from this column.
    if (best >= 0 && bestErr / dataRows.length <= 1) return best;
  }

  // No percentages to arbitrate: fall back to names, but never a quantity column.
  const isQty = (t: string) => /qty|quantity|units/i.test(t);
  const titled = additive.find((i) => /amount|sales|total/i.test(cols[i].title) && !isQty(cols[i].title));
  if (titled !== undefined) return titled;
  const money = additive.find((i) => /money/i.test(cols[i].type) && !isQty(cols[i].title));
  if (money !== undefined) return money;
  const notQty = additive.find((i) => !isQty(cols[i].title));
  return notQty !== undefined ? notQty : additive[additive.length - 1];
}

export function normalizeSales(report: QboReport): SalesNormalized {
  const dataRows = report.rows.filter(
    (r) =>
      r.kind === "data" &&
      r.label.trim() !== "" &&
      !/^total\b/i.test(r.label) &&
      !/not specified/i.test(r.label)
  );

  const summaryRow =
    report.rows.find((r) => r.kind === "section_summary") ??
    report.rows.find((r) => /^total\b/i.test(r.label));

  // Prefer the column that actually reconciles to the report's own Total row;
  // only fall back to title heuristics when there's no total to check against.
  const reconciled =
    summaryRow && report.totalColumnIndex < 0
      ? pickColumnByTotalReconciliation(report, dataRows, summaryRow)
      : -1;
  const moneyIdx = reconciled >= 0 ? reconciled : pickMoneyColumnIndex(report);

  const rows: SalesRow[] = dataRows
    .map((r) => ({ name: r.label, id: r.id, amount: ZERO_IF_NULL(r.values[moneyIdx]) }))
    .filter((r) => r.amount !== 0)
    .sort((a, b) => b.amount - a.amount);

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
