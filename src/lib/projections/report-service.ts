/**
 * Report snapshot service (Financial Reporting, Phase 1) — the IO layer.
 *
 * Fetch-through-cache over `proj_report_snapshot`: given a report type + range +
 * accounting method, return the NORMALIZED metric series, fetching from the
 * read-only QBO Reports API and caching only when the snapshot is missing or
 * older than the TTL. A permission-gated manual refresh forces a re-fetch.
 *
 * This is the module's service/engine seam (§ handoff): it wires the pure
 * normalization layer (src/lib/projections/reports/*) to Prisma and the QBO
 * client. The pure layer never imports this file.
 */
import { prisma } from "@/lib/db";
import { fetchReport, QBO_REPORT_ENTITY } from "@/lib/qbo/reports";
import { QboNotConnectedError, isQboConnectivityError } from "@/lib/qbo/client";
import { getQboEnvironment } from "@/lib/config-store";
import type { QboContext } from "@/lib/qbo/client";
import { getContext } from "@/lib/qbo/client";
import {
  parseQboReport,
  normalizePnl,
  normalizeBalanceSheet,
  normalizeAging,
  normalizeSales,
  parseReportPayload,
  deriveKpis,
  sum,
  resolveRange,
  comparisonRange,
  rollupSeries,
  type ReportType,
  type AccountingMethod,
  type ReportPayload,
  type PnlNormalized,
  type BalanceSheetNormalized,
  type AgingNormalized,
  type SalesNormalized,
  type DateRange,
  type RangePreset,
  type ComparisonMode,
  type Granularity,
  type Kpi,
} from "@/lib/projections/reports";
import { Prisma } from "@prisma/client";

/** Default cache lifetime for a snapshot before a fetch-through refresh. */
export const SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/** How QBO should summarise the P&L trend columns. */
const PNL_SUMMARIZE = "Month";

function toDate(d: string): Date {
  return new Date(`${d}T00:00:00.000Z`);
}

/** Normalize raw QBO JSON for a report type into the stored payload shape. */
function normalizeFor(reportType: ReportType, raw: unknown): ReportPayload {
  const report = parseQboReport(raw);
  switch (reportType) {
    case "pnl":
      return normalizePnl(report);
    case "balance_sheet":
      return normalizeBalanceSheet(report);
    case "ar_aging":
    case "ap_aging":
      return normalizeAging(report);
    case "customer_sales":
    case "item_sales":
      return normalizeSales(report);
  }
}

export interface SnapshotResult<T extends ReportPayload = ReportPayload> {
  payload: T;
  fetchedAt: Date;
  /** True when this call fetched fresh data from QBO (vs. served from cache). */
  refreshed: boolean;
}

export interface GetSnapshotOptions {
  method: AccountingMethod;
  maxAgeMs?: number;
  /** Skip the cache and re-fetch from QBO, overwriting the snapshot. */
  forceRefresh?: boolean;
  /** Reuse an open QBO context so many reports share one token refresh. */
  ctx?: QboContext;
}

/**
 * Return the normalized snapshot for (reportType, range, method), fetching
 * through the cache. Throws {@link QboNotConnectedError} when QBO isn't
 * connected AND there's no cached snapshot to fall back to.
 */
export async function getReportSnapshot(
  reportType: ReportType,
  range: DateRange,
  opts: GetSnapshotOptions
): Promise<SnapshotResult> {
  const method = opts.method;
  const maxAge = opts.maxAgeMs ?? SNAPSHOT_TTL_MS;
  const periodStart = toDate(range.start);
  const periodEnd = toDate(range.end);
  const key = {
    reportType_periodStart_periodEnd_method: { reportType, periodStart, periodEnd, method },
  };

  const existing = await prisma.projReportSnapshot.findUnique({ where: key });
  const fresh =
    existing && !opts.forceRefresh && Date.now() - existing.fetchedAt.getTime() < maxAge;
  if (existing && fresh) {
    return {
      payload: parseReportPayload(reportType, existing.payloadJson),
      fetchedAt: existing.fetchedAt,
      refreshed: false,
    };
  }

  try {
    const raw = await fetchReport(
      reportType as keyof typeof QBO_REPORT_ENTITY,
      {
        startDate: range.start,
        endDate: range.end,
        method,
        summarizeColumnBy: reportType === "pnl" ? PNL_SUMMARIZE : undefined,
      },
      opts.ctx
    );
    const payload = normalizeFor(reportType, raw);
    const saved = await prisma.projReportSnapshot.upsert({
      where: key,
      create: {
        reportType,
        periodStart,
        periodEnd,
        method,
        payloadJson: payload as unknown as Prisma.InputJsonValue,
      },
      update: { payloadJson: payload as unknown as Prisma.InputJsonValue, fetchedAt: new Date() },
    });
    return {
      payload: parseReportPayload(reportType, saved.payloadJson),
      fetchedAt: saved.fetchedAt,
      refreshed: true,
    };
  } catch (err) {
    // Serve a stale cached snapshot rather than crash the page when QBO is
    // temporarily unreachable; only surface the error if we have nothing.
    if (existing) {
      return {
        payload: parseReportPayload(reportType, existing.payloadJson),
        fetchedAt: existing.fetchedAt,
        refreshed: false,
      };
    }
    throw err;
  }
}

export interface ReportFilters {
  preset: RangePreset;
  comparison: ComparisonMode;
  method: AccountingMethod;
  customStart?: string;
  customEnd?: string;
  /** Trend/rollup granularity for the P&L trend chart. */
  granularity?: Granularity;
  /** Top-N cap for customer/item breakdowns. */
  topN?: number;
}

export interface TrendPoint {
  period: string;
  revenue: number;
  netIncome: number;
}
export interface CategoryDatum {
  name: string;
  value: number;
}

export interface ReportingData {
  connected: true;
  range: DateRange;
  comparison: DateRange;
  filters: ReportFilters;
  kpis: Kpi[];
  trend: TrendPoint[];
  expenseBreakdown: CategoryDatum[];
  revenueByCustomer: CategoryDatum[];
  revenueByItem: CategoryDatum[];
  arAging: AgingNormalized;
  apAging: AgingNormalized;
  pnl: PnlNormalized;
  balanceSheet: BalanceSheetNormalized;
  /** Oldest snapshot timestamp among the reports powering the page. */
  fetchedAt: Date;
}

export interface ReportingUnavailable {
  connected: false;
  range: DateRange;
  comparison: DateRange;
  filters: ReportFilters;
  /**
   * `not_connected` — no QBO credential on file for this environment.
   * `reconnect_required` — a credential exists but QBO rejected the token
   *   (e.g. the refresh token expired or was revoked → a 400 on refresh); the
   *   owner needs to re-run the Connect QBO flow. We surface this instead of
   *   letting the token error crash the whole page.
   */
  reason: "not_connected" | "reconnect_required";
}

function toCategory(rows: { name: string; amount: number }[], topN: number): CategoryDatum[] {
  const sorted = [...rows].sort((a, b) => b.amount - a.amount);
  const head = sorted.slice(0, topN).map((r) => ({ name: r.name, value: r.amount }));
  const rest = sorted.slice(topN);
  if (rest.length > 0) {
    const other = rest.reduce((a, r) => a + r.amount, 0);
    if (Math.abs(other) >= 0.005) head.push({ name: `Other (${rest.length})`, value: round2(other) });
  }
  return head;
}
function round2(n: number): number {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Assemble everything the Reporting page renders, from the active filters.
 * Opens ONE QBO context (single token refresh) and fetches each report through
 * the cache. Returns `{ connected: false }` when QBO isn't connected and there's
 * no cache — the page shows a setup notice instead of crashing.
 */
export async function loadReporting(
  filters: ReportFilters,
  now: Date,
  opts: { forceRefresh?: boolean } = {}
): Promise<ReportingData | ReportingUnavailable> {
  const range = resolveRange(filters.preset, now, filters.customStart, filters.customEnd);
  const comparison = comparisonRange(range, filters.comparison);
  const method = filters.method;
  const topN = filters.topN ?? 8;
  const granularity = filters.granularity ?? "month";

  let ctx: QboContext | undefined;
  // Tracks a QBO connectivity problem so a failure to open the context (missing
  // credential, or a token the server rejected) degrades to cache / a friendly
  // notice instead of throwing a server-side exception that white-screens the
  // whole route.
  let connectionIssue: ReportingUnavailable["reason"] | null = null;
  try {
    ctx = await getContext(await getQboEnvironment());
  } catch (err) {
    // No credential at all vs. a credential QBO rejected (e.g. token refresh
    // returned 400 — the refresh token expired/was revoked → reconnect needed).
    // A genuine (non-QBO) error still throws rather than masquerading as a
    // connection problem.
    if (err instanceof QboNotConnectedError) connectionIssue = "not_connected";
    else if (isQboConnectivityError(err)) connectionIssue = "reconnect_required";
    else throw err;
    ctx = undefined;
  }

  const shared: GetSnapshotOptions = { method, ctx, forceRefresh: opts.forceRefresh };
  try {
    const [pnlR, pnlPrevR, bsR, bsPrevR, arR, arPrevR, apR, apPrevR, custR, itemR] =
      await Promise.all([
        getReportSnapshot("pnl", range, shared),
        getReportSnapshot("pnl", comparison, shared),
        getReportSnapshot("balance_sheet", range, shared),
        getReportSnapshot("balance_sheet", comparison, shared),
        getReportSnapshot("ar_aging", range, shared),
        getReportSnapshot("ar_aging", comparison, shared),
        getReportSnapshot("ap_aging", range, shared),
        getReportSnapshot("ap_aging", comparison, shared),
        getReportSnapshot("customer_sales", range, shared),
        getReportSnapshot("item_sales", range, shared),
      ]);

    const pnl = pnlR.payload as PnlNormalized;
    const pnlPrev = pnlPrevR.payload as PnlNormalized;
    const bs = bsR.payload as BalanceSheetNormalized;
    const bsPrev = bsPrevR.payload as BalanceSheetNormalized;
    const ar = arR.payload as AgingNormalized;
    const arPrev = arPrevR.payload as AgingNormalized;
    const ap = apR.payload as AgingNormalized;
    const apPrev = apPrevR.payload as AgingNormalized;
    const cust = custR.payload as SalesNormalized;
    const item = itemR.payload as SalesNormalized;

    const kpis = deriveKpis({
      pnl,
      pnlPrev,
      balanceSheet: bs,
      balanceSheetPrev: bsPrev,
      arTotal: ar.total,
      arTotalPrev: arPrev.total,
      apTotal: ap.total,
      apTotalPrev: apPrev.total,
    });

    // Trend: revenue & net income per period (grand-total column already dropped
    // by the normalizer), rolled up to the requested granularity.
    const revenueRollup = rollupSeries(pnl.periods, pnl.income, granularity);
    const netRollup = rollupSeries(pnl.periods, pnl.netIncome, granularity);
    const trend: TrendPoint[] = revenueRollup.map((b, i) => ({
      period: b.label,
      revenue: b.value,
      netIncome: netRollup[i]?.value ?? 0,
    }));

    const expenseBreakdown = toCategory(
      pnl.expenseLines.map((l) => ({ name: l.label, amount: sum(l.values) })),
      topN
    );

    const fetchedAt = [pnlR, bsR, arR, apR, custR, itemR]
      .map((r) => r.fetchedAt)
      .reduce((a, b) => (a < b ? a : b));

    return {
      connected: true,
      range,
      comparison,
      filters,
      kpis,
      trend,
      expenseBreakdown,
      revenueByCustomer: toCategory(cust.rows, topN),
      revenueByItem: toCategory(item.rows, topN),
      arAging: ar,
      apAging: ap,
      pnl,
      balanceSheet: bs,
      fetchedAt,
    };
  } catch (err) {
    // If QBO is unreachable (bad/absent credential, rejected token, API error)
    // and there's no cache to fall back on, report it as unavailable rather than
    // crashing the route. Genuine (non-QBO) errors still surface.
    if (connectionIssue || err instanceof QboNotConnectedError || isQboConnectivityError(err)) {
      const reason =
        connectionIssue ?? (err instanceof QboNotConnectedError ? "not_connected" : "reconnect_required");
      return { connected: false, range, comparison, filters, reason };
    }
    throw err;
  }
}
