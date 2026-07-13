/**
 * QBO Reports API client — STRICTLY READ-ONLY (Financial Reporting, Phase 1).
 *
 * Extends the existing Accounting API client (client.ts) to the Reports
 * endpoints the reporting/projections hub reads from: ProfitAndLoss,
 * BalanceSheet, AgedReceivables, AgedPayables, CustomerSales, ItemSales.
 *
 * This module NEVER posts, edits, or deletes — it only issues GET /reports/*
 * requests. It reuses the client's auth/auto-refresh (`getContext`),
 * base-URL-per-environment, minorversion, and the "QBO not connected" handling
 * (`QboNotConnectedError`) so the reporting page degrades exactly like the rest
 * of the hub when credentials are missing.
 *
 * Returns RAW QBO report JSON. Normalization into typed metric series happens in
 * the pure layer (src/lib/projections/reports/*), which this file never imports.
 */
import { get, getContext, type QboContext } from "./client";
import { currentEnvironment } from "./oauth";
import type { AccountingMethod } from "@/lib/projections/reports/normalize";

/** QBO report entity names, keyed by our internal report type. */
export const QBO_REPORT_ENTITY = {
  pnl: "ProfitAndLoss",
  balance_sheet: "BalanceSheet",
  ar_aging: "AgedReceivables",
  ap_aging: "AgedPayables",
  customer_sales: "CustomerSales",
  item_sales: "ItemSales",
} as const;

/** How QBO wants the accounting method spelled in the query string. */
function qboMethod(method: AccountingMethod): "Accrual" | "Cash" {
  return method === "cash" ? "Cash" : "Accrual";
}

export interface ReportParams {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  method: AccountingMethod;
  /** e.g. "Month" | "Quarter" | "Year" | "Total" — where the report supports it. */
  summarizeColumnBy?: string;
}

/**
 * Build a `reports/<Entity>?...` path with only the params a report supports.
 *
 * Aged A/R & A/P are point-in-time: they take a single `report_date` (as of the
 * range end) and neither an accounting method nor a summarize column. P&L / BS /
 * sales take start_date + end_date + accounting_method, and P&L / BS also accept
 * a summarize column.
 */
function buildPath(reportType: keyof typeof QBO_REPORT_ENTITY, params: ReportParams): string {
  const entity = QBO_REPORT_ENTITY[reportType];
  const q = new URLSearchParams();

  if (reportType === "ar_aging" || reportType === "ap_aging") {
    q.set("report_date", params.endDate);
    return `reports/${entity}?${q.toString()}`;
  }

  q.set("start_date", params.startDate);
  q.set("end_date", params.endDate);
  q.set("accounting_method", qboMethod(params.method));
  const supportsSummarize = reportType === "pnl" || reportType === "balance_sheet";
  if (supportsSummarize && params.summarizeColumnBy) {
    q.set("summarize_column_by", params.summarizeColumnBy);
  }
  return `reports/${entity}?${q.toString()}`;
}

/**
 * Fetch a report by our internal type against the (read-only) QBO Reports API.
 * Returns raw QBO JSON; normalization happens in the pure layer.
 */
export async function fetchReport(
  reportType: keyof typeof QBO_REPORT_ENTITY,
  params: ReportParams,
  ctx?: QboContext
): Promise<unknown> {
  const context = ctx ?? (await getContext(currentEnvironment()));
  return get<unknown>(context, buildPath(reportType, params));
}
