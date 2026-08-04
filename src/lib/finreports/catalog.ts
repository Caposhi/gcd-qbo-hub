/**
 * Financial Reports — the report catalog (Phase 1).
 *
 * ONE registry that drives three things, so they can never drift apart:
 *   1. the page's departmental tabs,
 *   2. GCD Pal's report tools (the assistant offers exactly what the page shows),
 *   3. the fetch layer (which QBO entity + params each report needs).
 *
 * Adding a report here makes it appear in its tab AND become answerable by the
 * assistant — that's why "GCD Pal access" isn't a build phase.
 *
 * `requires` marks reports that only exist when the company actually uses the
 * feature (classes, budgets, inventory). The capability probe resolves those at
 * runtime so we never show an empty report (see capabilities.ts).
 *
 * Pure: no Prisma / Next / network imports (§20).
 */
import type { AccountingBasis, ReportTab } from "./types";

/** QBO Reports API entity names this module can fetch. */
export type FinQboEntity =
  | "ProfitAndLoss"
  | "ProfitAndLossDetail"
  | "BalanceSheet"
  | "CashFlow"
  | "TrialBalance"
  | "GeneralLedger"
  | "VendorExpenses"
  | "CustomerSales"
  | "ItemSales"
  | "AgedReceivables"
  | "AgedPayables"
  | "ClassSales"
  | "BudgetVsActuals"
  | "InventoryValuationSummary";

/** Optional company features a report can depend on. */
export type FinCapability = "classes" | "budgets" | "inventory";

export interface ReportDef {
  /** Stable key used in URLs, the cache, and GCD Pal tool arguments. */
  key: string;
  title: string;
  /** One line the page shows under the title, and the assistant uses to choose. */
  description: string;
  tab: ReportTab;
  entity: FinQboEntity;
  /** Hierarchical statement (checksum-validated) vs flat grid. */
  shape: "statement" | "tabular";
  /**
   * Default accounting basis (owner's rule: cash for P&L-style, accrual for
   * Balance-Sheet-style). `null` = the report takes no basis (agings are
   * point-in-time).
   */
  defaultBasis: AccountingBasis | null;
  /** True when the report is as-of a date rather than for a range. */
  pointInTime?: boolean;
  /** Only available when the company uses this feature. */
  requires?: FinCapability;
  /** Label for the leading column of a tabular report. */
  labelColumn?: string;
}

export const REPORTS: readonly ReportDef[] = [
  // --- Accounting ---------------------------------------------------------
  {
    key: "pnl",
    title: "Profit & Loss",
    description: "Income, cost of sales and expenses for the period, with prior-period comparison and % of revenue.",
    tab: "accounting",
    entity: "ProfitAndLoss",
    shape: "statement",
    defaultBasis: "cash",
  },
  {
    key: "balance_sheet",
    title: "Balance Sheet",
    description: "Assets, liabilities and equity as of the period end.",
    tab: "accounting",
    entity: "BalanceSheet",
    shape: "statement",
    defaultBasis: "accrual",
    pointInTime: true,
  },
  {
    key: "cash_flow",
    title: "Statement of Cash Flows",
    description: "Cash generated and used by operating, investing and financing activities.",
    tab: "accounting",
    entity: "CashFlow",
    shape: "statement",
    defaultBasis: "cash",
  },
  {
    key: "pnl_detail",
    title: "Profit & Loss Detail",
    description: "Every transaction behind each P&L line — the drill-down for 'why did this move?'.",
    tab: "accounting",
    entity: "ProfitAndLossDetail",
    shape: "tabular",
    defaultBasis: "cash",
    labelColumn: "Account / transaction",
  },
  {
    key: "trial_balance",
    title: "Trial Balance",
    description: "Debit and credit balance per account — the CPA hand-off that proves the books tie.",
    tab: "accounting",
    entity: "TrialBalance",
    shape: "tabular",
    defaultBasis: "accrual",
    pointInTime: true,
    labelColumn: "Account",
  },
  {
    key: "general_ledger",
    title: "General Ledger",
    description: "Full posting detail by account for the period.",
    tab: "accounting",
    entity: "GeneralLedger",
    shape: "tabular",
    defaultBasis: "accrual",
    labelColumn: "Account / transaction",
  },

  // --- Cash & Banking ----------------------------------------------------
  {
    key: "ar_aging",
    title: "A/R Aging",
    description: "What customers owe, by how overdue.",
    tab: "cash",
    entity: "AgedReceivables",
    shape: "tabular",
    defaultBasis: null,
    pointInTime: true,
    labelColumn: "Customer",
  },
  {
    key: "ap_aging",
    title: "A/P Aging",
    description: "What we owe vendors, by how overdue.",
    tab: "cash",
    entity: "AgedPayables",
    shape: "tabular",
    defaultBasis: null,
    pointInTime: true,
    labelColumn: "Vendor",
  },

  // --- Sales & Customers -------------------------------------------------
  {
    key: "customer_sales",
    title: "Sales by Customer",
    description: "Revenue per customer, with concentration (top-10 share).",
    tab: "sales",
    entity: "CustomerSales",
    shape: "tabular",
    defaultBasis: "cash",
    labelColumn: "Customer",
  },
  {
    key: "item_sales",
    title: "Sales by Service / Product",
    description: "Revenue by Tekmetric line type — labor, parts, sublet, discounts, fees.",
    tab: "sales",
    entity: "ItemSales",
    shape: "tabular",
    defaultBasis: "cash",
    labelColumn: "Service / product",
  },
  {
    key: "class_sales",
    title: "Sales by Class",
    description: "Revenue per QBO class, when the books are segmented by class.",
    tab: "sales",
    entity: "ClassSales",
    shape: "tabular",
    defaultBasis: "cash",
    requires: "classes",
    labelColumn: "Class",
  },

  // --- Parts & Purchasing ------------------------------------------------
  {
    key: "vendor_expenses",
    title: "Expenses by Vendor",
    description: "Who we actually pay, ranked by spend for the period.",
    tab: "parts",
    entity: "VendorExpenses",
    shape: "tabular",
    defaultBasis: "cash",
    labelColumn: "Vendor",
  },
  {
    key: "inventory_valuation",
    title: "Inventory Valuation",
    description: "On-hand quantity and value per inventory item.",
    tab: "parts",
    entity: "InventoryValuationSummary",
    shape: "tabular",
    defaultBasis: null,
    pointInTime: true,
    requires: "inventory",
    labelColumn: "Item",
  },

  // --- Executive ---------------------------------------------------------
  {
    key: "budget_vs_actual",
    title: "Budget vs Actual",
    description: "Performance against the QBO budget, by account.",
    tab: "executive",
    entity: "BudgetVsActuals",
    shape: "tabular",
    defaultBasis: "accrual",
    requires: "budgets",
    labelColumn: "Account",
  },
] as const;

export function getReport(key: string): ReportDef | undefined {
  return REPORTS.find((r) => r.key === key);
}

/** Reports in a tab, hiding any whose required capability the company lacks. */
export function reportsForTab(tab: ReportTab, caps: Partial<Record<FinCapability, boolean>> = {}): ReportDef[] {
  return REPORTS.filter((r) => r.tab === tab && (!r.requires || caps[r.requires] === true));
}

/** Every report available given the company's capabilities (drives GCD Pal). */
export function availableReports(caps: Partial<Record<FinCapability, boolean>> = {}): ReportDef[] {
  return REPORTS.filter((r) => !r.requires || caps[r.requires] === true);
}

/**
 * The basis a report should use: the caller's override when the report accepts a
 * basis at all, else the report's default. Reports with `defaultBasis: null`
 * (agings, inventory) never take one, so an override is ignored rather than
 * silently sent to QBO.
 */
export function basisFor(def: ReportDef, override?: AccountingBasis): AccountingBasis | null {
  if (def.defaultBasis === null) return null;
  return override ?? def.defaultBasis;
}
