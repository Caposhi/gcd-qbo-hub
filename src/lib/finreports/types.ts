/**
 * Financial Reports — shared shapes (Phase 1).
 *
 * Two report shapes cover everything in the catalog, and the distinction is
 * deliberate:
 *
 *  - `Statement` — a hierarchical financial statement with ONE money value per
 *    line and real subtotals (P&L, Balance Sheet, Statement of Cash Flows).
 *    Because it carries subtotals, it can be *checked*: every subtotal must equal
 *    the sum of its children and the grand total must equal QBO's own total row.
 *    That check is this module's equivalent of the deposit checksum.
 *  - `TabularReport` — a flat rows × named-columns grid for reports that aren't
 *    statements (Trial Balance's debit/credit, P&L Detail / General Ledger
 *    transaction listings, Vendor Expenses). Forcing these into a single-value
 *    hierarchy would lose columns and invent subtotals that don't exist.
 *
 * IO-free: no Prisma / Next / network imports (§20).
 */

/** QBO accounting basis. Mirrors projections' AccountingMethod. */
export type AccountingBasis = "cash" | "accrual";

/** Which departmental tab a report belongs to (§2 of docs/FINANCIAL_REPORTS.md). */
export type ReportTab =
  | "accounting"
  | "executive"
  | "operations"
  | "sales"
  | "parts"
  | "labor"
  | "cash"
  | "tax";

export const REPORT_TABS: ReadonlyArray<{ id: ReportTab; label: string; audience: string; blurb: string }> = [
  { id: "accounting", label: "Accounting", audience: "Bookkeeper, CPA, owner", blurb: "Are the books right and closeable?" },
  { id: "executive", label: "Executive", audience: "Owner, director", blurb: "Are we making money, and is it improving?" },
  { id: "operations", label: "Operations", audience: "Service manager", blurb: "Are the bays and techs producing?" },
  { id: "sales", label: "Sales & Customers", audience: "Owner, service manager", blurb: "Where is revenue coming from?" },
  { id: "parts", label: "Parts & Purchasing", audience: "Parts manager", blurb: "Are we buying well and holding margin?" },
  { id: "labor", label: "Labor & Payroll", audience: "Owner, service manager", blurb: "Is labor earning its cost?" },
  { id: "cash", label: "Cash & Banking", audience: "Owner, bookkeeper", blurb: "What's in the bank, owed, and coming?" },
  { id: "tax", label: "Tax & Compliance", audience: "Owner, CPA", blurb: "What do we owe, and to whom?" },
];

/**
 * A statement line.
 *
 * `kind` drives both rendering and validation:
 *  - `section`  — a section header with no own value (QBO emits these for
 *                 "Income", "Expenses"); children follow at greater depth.
 *  - `detail`   — an account/leaf line carrying a value.
 *  - `subtotal` — a section's own total ("Total Income"); MUST equal the sum of
 *                 that section's descendant detail lines.
 *  - `total`    — a statement-level total (Net Income, Total Assets).
 */
export type StatementLineKind = "section" | "detail" | "subtotal" | "total";

export interface StatementLine {
  label: string;
  depth: number;
  kind: StatementLineKind;
  /** QBO account id when the line is an account leaf. */
  accountId?: string;
  /** QBO row group code when present ("Income", "NetIncome", "TotalAssets"…). */
  groupCode?: string;
  /** Value for the reporting period. Null when QBO left the cell blank. */
  value: number | null;
  /** Same line in the comparison period (see `withComparison`). */
  priorValue?: number | null;
  /** value − priorValue, when both are present. */
  deltaAbs?: number | null;
  /** Percent change vs prior; null when prior is 0 or missing. */
  deltaPct?: number | null;
  /** Line as a share of the statement's revenue base (see `withPctOfRevenue`). */
  pctOfRevenue?: number | null;
}

export interface StatementPeriod {
  start: string; // YYYY-MM-DD
  end: string;
}

export interface Statement {
  /** Catalog key (e.g. "pnl", "balance_sheet", "cash_flow"). */
  key: string;
  title: string;
  period: StatementPeriod;
  comparison?: StatementPeriod;
  basis: AccountingBasis;
  lines: StatementLine[];
  /**
   * Statement-level totals QBO reported, keyed by group code where available
   * (e.g. { NetIncome: 24577.03 }). Used by the validator and by consumers that
   * want the headline without walking `lines`.
   */
  totals: Record<string, number>;
  /** ISO timestamp of the underlying QBO snapshot. */
  fetchedAt?: string;
}

// --- tabular reports -------------------------------------------------------

export interface TabularColumn {
  key: string;
  label: string;
  /** money → right-align + currency format; text/date → left. */
  type: "money" | "number" | "text" | "date";
}

export interface TabularRow {
  /** Cell values keyed by column key. */
  cells: Record<string, string | number | null>;
  /** Nesting depth when the source report grouped rows. */
  depth?: number;
  /** True for QBO section-summary rows (renders bold, excluded from row sums). */
  isSummary?: boolean;
}

export interface TabularReport {
  key: string;
  title: string;
  period: StatementPeriod;
  basis: AccountingBasis;
  columns: TabularColumn[];
  rows: TabularRow[];
  fetchedAt?: string;
}
