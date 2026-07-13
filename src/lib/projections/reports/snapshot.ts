/**
 * Snapshot payload validation (Financial Reporting, Phase 1).
 *
 * `ProjReportSnapshot.payloadJson` stores a NORMALIZED report (never raw QBO).
 * Mirroring `parseAssumptions` (§ handoff): every stored blob is validated and
 * coerced on READ so a malformed / partially-written snapshot can never crash a
 * page — a bad field falls back to an empty/zero shape rather than throwing.
 *
 * Pure, IO-free, unit-tested (§20).
 */
import type { ReportType } from "./normalize";
import type {
  PnlNormalized,
  BalanceSheetNormalized,
  AgingNormalized,
  SalesNormalized,
  LineSeries,
  AgingRow,
  SalesRow,
} from "./normalize";

export type ReportPayload =
  | PnlNormalized
  | BalanceSheetNormalized
  | AgingNormalized
  | SalesNormalized;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function num(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
function numArray(v: unknown): number[] {
  return Array.isArray(v) ? v.map(num) : [];
}
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str) : [];
}
function lineSeries(v: unknown): LineSeries[] {
  return (Array.isArray(v) ? v : []).map((r) => {
    const o = obj(r);
    return { label: str(o.label), id: optStr(o.id), values: numArray(o.values) };
  });
}

export function parsePnl(json: unknown): PnlNormalized {
  const o = obj(json);
  return {
    periods: strArray(o.periods),
    income: numArray(o.income),
    cogs: numArray(o.cogs),
    grossProfit: numArray(o.grossProfit),
    expenses: numArray(o.expenses),
    netOperatingIncome: numArray(o.netOperatingIncome),
    netIncome: numArray(o.netIncome),
    incomeLines: lineSeries(o.incomeLines),
    expenseLines: lineSeries(o.expenseLines),
  };
}

export function parseBalanceSheet(json: unknown): BalanceSheetNormalized {
  const o = obj(json);
  return {
    asOf: optStr(o.asOf),
    cash: num(o.cash),
    totalCurrentAssets: num(o.totalCurrentAssets),
    totalAssets: num(o.totalAssets),
    totalLiabilities: num(o.totalLiabilities),
    totalEquity: num(o.totalEquity),
    bankAccounts: lineSeries(o.bankAccounts),
  };
}

export function parseAging(json: unknown): AgingNormalized {
  const o = obj(json);
  const rows: AgingRow[] = (Array.isArray(o.rows) ? o.rows : []).map((r) => {
    const ro = obj(r);
    return {
      name: str(ro.name),
      id: optStr(ro.id),
      buckets: numArray(ro.buckets),
      total: num(ro.total),
    };
  });
  return {
    asOf: optStr(o.asOf),
    bucketLabels: strArray(o.bucketLabels),
    totals: numArray(o.totals),
    total: num(o.total),
    rows,
  };
}

export function parseSales(json: unknown): SalesNormalized {
  const o = obj(json);
  const rows: SalesRow[] = (Array.isArray(o.rows) ? o.rows : []).map((r) => {
    const ro = obj(r);
    return { name: str(ro.name), id: optStr(ro.id), amount: num(ro.amount) };
  });
  return { total: num(o.total), rows };
}

/** Validate/coerce a stored payload for the given report type. Never throws. */
export function parseReportPayload(reportType: ReportType, json: unknown): ReportPayload {
  switch (reportType) {
    case "pnl":
      return parsePnl(json);
    case "balance_sheet":
      return parseBalanceSheet(json);
    case "ar_aging":
    case "ap_aging":
      return parseAging(json);
    case "customer_sales":
    case "item_sales":
      return parseSales(json);
  }
}
