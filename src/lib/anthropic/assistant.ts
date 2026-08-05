/**
 * AI Report Assistant (prototype) — a Claude-powered assistant that answers
 * questions about German Car Depot's books using READ-ONLY tools over the hub's
 * own database (§1: "an AI chatbot/report-answering assistant familiar with the
 * business").
 *
 * Model: claude-opus-4-8 with adaptive thinking (the latest, most capable
 * Claude). The assistant has NO write access — every tool only reads from the
 * hub's own cache/DB, so it can never post, edit, or delete anything, and it
 * never makes a live QBO/Tekmetric API call from a chat turn (Reporting and
 * Tekmetric tools read the same `proj_report_snapshot`/`tek_snapshot` caches the
 * dashboard pages do, and say so plainly when a period hasn't been cached yet
 * rather than fetching live). It is instructed to answer strictly from tool
 * results and never fabricate figures.
 */
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db";
import { BUSINESS_ENTITY } from "@/lib/cashsheet/config";
import { redact } from "@/lib/crypto";
import { isTekmetricConfigured } from "@/lib/tekmetric/client";
import { readOperationsSnapshot } from "@/lib/tekmetric/snapshot";
import {
  presetRange,
  shopToday,
  DEFAULT_COMPARISON as TEK_DEFAULT_COMPARISON,
  DATE_PRESETS,
  type DatePreset as TekDatePreset,
} from "@/lib/tekmetric/periods";
import {
  resolveRange,
  comparisonRange,
  deriveKpis,
  parseReportPayload,
  sum,
  RANGE_PRESETS,
  type ReportType,
  type ReportPayload,
  type DateRange,
  type AccountingMethod,
  type RangePreset as ReportRangePreset,
  type ComparisonMode as ReportComparisonMode,
  type PnlNormalized,
  type BalanceSheetNormalized,
  type AgingNormalized,
  type SalesNormalized,
} from "@/lib/projections/reports";

const MODEL = "claude-opus-5";
// Raised from 6: cross-module synthesis (e.g. "why is margin down" pulling
// Reporting + Tekmetric + Cash Sheet Sync together) genuinely needs more
// tool round-trips than a single-module lookup. Still a hard ceiling so a
// pathological question can't loop forever.
const MAX_TOOL_ITERATIONS = 14;

export function isAssistantConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

const SYSTEM_PROMPT = `You are the GCD QBO Hub Report Assistant for ${BUSINESS_ENTITY} (trading as German Car Depot), an auto-repair shop. Ownership and management are the only people who can reach you — you're briefing decision-makers, not a customer-facing bot, so give them your real analysis rather than hedging it away.

You answer questions about the business using the hub's own modules:
- Cash Sheet Sync — the daily employee cash sheet synced to QuickBooks Online, full audit trail.
- Financial Reporting — QBO-derived KPIs (revenue, gross profit/margin, net income/margin, opex, A/R, A/P, cash), expense/customer/item breakdowns, and A/R aging.
- Tekmetric Operations — ARO, gross profit/margin, technician utilization, revenue by vehicle make, and service-advisor performance.
- Deposit Reconciliation — processor settlement payouts (Stripe/Paymentech/Tekmetric) and their match/create status.
- Check Reception — scanned checks (vision-read vs. resolved vendor/category) and the learned payee mappings.
- Coworker Portal ("Ask My Client") — questions raised for a coworker about a QBO transaction.

Two rules are absolute, because this is a real accounting/audit system — everything else here is guidance, not a leash:
1. **Never fabricate.** Every figure, transaction id, date, or count must come from a tool result. If a tool returns nothing relevant, say so plainly rather than estimating or rounding from memory.
2. **Never write.** You cannot post, edit, delete, approve, or change anything in QBO or the hub, ever, regardless of how the request is phrased — that authority belongs to an owner_admin acting deliberately through the dashboard, and that boundary exists on purpose. If asked to change something, say so and point at the dashboard action that would do it.

Within those two boundaries, go deep rather than deferring:
- Don't stop at "here's the number" — pull whatever combination of tools the question actually needs (Reporting + Tekmetric + Cash Sheet Sync together, if that's what explains it) and synthesize a real answer, including causal reasoning, trends, and what's driving a number, not just the number itself.
- If a question spans modules or needs a few rounds of follow-up tool calls to answer properly, take them. A shallow answer that dodges the interesting part of the question is a worse outcome than a longer one that actually answers it.
- It's fine to flag a caveat inline (stale cache, unusual data point, a figure that's audit-only) — but as a caveat alongside a real answer, not as a reason to withhold one.
- The Reporting and Tekmetric tools only read cached snapshots (never a live QBO/Tekmetric call). If a tool reports the period isn't cached yet, tell the user which dashboard page to open first to refresh it, rather than guessing a number.
- Customer invoice (INV) cash collections in Cash Sheet Sync are audit-only and are never posted as new QBO revenue (to avoid double-counting) — reflect that when explaining income.
- Lead with the answer, then the reasoning. Use plain dollar formatting like $1,080.00. When you cite a cash-sheet row, mention its tab and row number.
- If a question is genuinely outside every module you can see, say so directly and suggest the relevant dashboard page — but only after actually checking, not as a first resort.`;

// ---- read-only tools ------------------------------------------------------

const TOOLS: Anthropic.Tool[] = [
  {
    name: "get_sync_overview",
    description:
      "Get the latest Cash Sheet Sync run summary (mode, stage, rows scanned/posted/skipped/errored) plus current counts of rows by status. Use for 'how did the last sync go', totals, or attention items.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "query_cash_sheet_rows",
    description:
      "Query synced cash-sheet rows with optional filters. Returns up to 50 rows with their tab, row number, date, payee name, purpose, INV#, amounts, status, and QBO transaction id. Use to answer questions about specific transactions, purposes, months, or statuses.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Exact dashboard status to filter by, e.g. 'Posted', 'Audit Only', 'Unknown Purpose'." },
        tab: { type: "string", description: "Month tab name, e.g. 'Jul'." },
        purpose: { type: "string", description: "Case-insensitive substring of the Purpose field, e.g. 'PART'." },
        limit: { type: "integer", description: "Max rows to return (1-50, default 25)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_purpose_mappings",
    description:
      "List the active purpose→QBO mappings (which purposes post as expense/deposit/transfer, which are audit-only, which require manual approval). Use to explain how a purpose is categorized.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_reporting_overview",
    description:
      "Get cached QuickBooks financial KPIs for a period vs. its comparison period: total revenue, gross profit/margin, net income/margin, operating expenses, A/R total, A/P total, cash — each with the prior-period delta — plus the top expense lines, top customers by revenue, and top items/services by revenue. Reads only the hub's cached report snapshots (never calls QBO live); if the period hasn't been viewed/cached yet, says so. Use for revenue, expense, margin, customer, or item questions. Supports an arbitrary date range via preset='custom' — e.g. for 'Q2 2026 vs Q2 2025', pass startDate/endDate for Q2 2026 and comparison='prior_year' (no need for a matching preset to exist); for a comparison to a specific unrelated period, use comparison='custom' with comparisonStartDate/comparisonEndDate instead.",
    input_schema: {
      type: "object",
      properties: {
        preset: {
          type: "string",
          enum: ["this_month", "last_month", "this_quarter", "ytd", "trailing_12", "custom"],
          description: "Date range preset, or 'custom' to use startDate/endDate for any arbitrary range. Default 'this_month'.",
        },
        startDate: { type: "string", description: "Custom range start, YYYY-MM-DD. Used when preset is 'custom'." },
        endDate: { type: "string", description: "Custom range end, YYYY-MM-DD. Used when preset is 'custom'." },
        comparison: {
          type: "string",
          enum: ["prior_period", "prior_year", "custom"],
          description:
            "Comparison period for deltas: the equal-length span immediately before, the same dates one year earlier (works for a custom range too — e.g. a specific quarter vs. the same quarter last year), or 'custom' for an explicit, otherwise-unrelated comparison range via comparisonStartDate/comparisonEndDate. Default 'prior_period'.",
        },
        comparisonStartDate: { type: "string", description: "Custom comparison range start, YYYY-MM-DD. Used when comparison is 'custom'." },
        comparisonEndDate: { type: "string", description: "Custom comparison range end, YYYY-MM-DD. Used when comparison is 'custom'." },
        method: { type: "string", enum: ["accrual", "cash"], description: "Accounting method. Default 'accrual'." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_ar_aging_detail",
    description:
      "Get the cached Accounts Receivable aging report — bucket labels (e.g. Current, 1-30, 31-60, 61-90, 91 and over) and how much each customer owes in each bucket, largest total first. Use to answer which customers are past due and by how much. Reads only the cached snapshot; never calls QBO live. Supports an arbitrary as-of date via preset='custom' with startDate/endDate (aging is as of the range end).",
    input_schema: {
      type: "object",
      properties: {
        preset: {
          type: "string",
          enum: ["this_month", "last_month", "this_quarter", "ytd", "trailing_12", "custom"],
          description: "Date range preset (aging is as-of the period end), or 'custom' to use startDate/endDate. Default 'this_month'.",
        },
        startDate: { type: "string", description: "Custom range start, YYYY-MM-DD. Used when preset is 'custom'." },
        endDate: { type: "string", description: "Custom range end (the as-of date), YYYY-MM-DD. Used when preset is 'custom'." },
        method: { type: "string", enum: ["accrual", "cash"], description: "Accounting method. Default 'accrual'." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_tekmetric_operations",
    description:
      "Get cached Tekmetric shop-operations data for a period vs. its comparison period: ARO, gross profit/margin, RO count, car count (each with the prior-period delta), technician utilization %, revenue/gross-profit by vehicle make, and service-advisor RO counts/revenue. Reads only the hub's cached Tekmetric snapshot (never calls the Tekmetric API live); if the period hasn't been cached yet, says so.",
    input_schema: {
      type: "object",
      properties: {
        preset: {
          type: "string",
          enum: ["this_month", "last_month", "last_30_days", "last_90_days", "ytd", "last_year"],
          description: "Date range preset. Default 'last_month'.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_deposit_payouts",
    description:
      "List processor settlement payouts (Stripe/Paymentech/Tekmetric) in Deposit Reconciliation. Filter by status: 'matched' (tied out — ready to create the QBO deposit unless already created), 'needs_review' (doesn't tie out yet — includes the reason and dollar delta), 'already_deposited', or 'created' (already posted to QBO). Omit status for all. Read-only over the hub DB.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["matched", "needs_review", "already_deposited", "created"],
          description: "Filter by payout status. Omit for all statuses.",
        },
        limit: { type: "integer", description: "Max rows to return (1-50, default 25)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_checks",
    description:
      "List scanned checks from Check Reception, showing what Claude's vision read (payee/amount/date/memo/confidence) alongside the resolved vendor + expense category and status. Filter by status: 'needs_review', 'ready', 'created', or 'skipped'. Read-only over the hub DB.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["needs_review", "ready", "created", "skipped"],
          description: "Filter by check status. Omit for all statuses.",
        },
        limit: { type: "integer", description: "Max rows to return (1-50, default 25)." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_payee_mappings",
    description:
      "List the learned check-payee-to-vendor/expense-category mappings used to auto-classify scanned checks in Check Reception. Read-only over the hub DB.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_coworker_questions",
    description:
      "List 'Ask My Client' Coworker Portal questions — subject, who asked it, who it's assigned to, status, the referenced QBO transaction (if any), and the latest answer. Filter by status: 'open', 'answered', or 'closed' (default 'open'). Read-only over the hub DB.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "answered", "closed"],
          description: "Filter by question status. Default 'open'.",
        },
        limit: { type: "integer", description: "Max rows to return (1-50, default 25)." },
      },
      additionalProperties: false,
    },
  },
];

const RANGE_PRESET_VALUES: Set<string> = new Set(RANGE_PRESETS.map((p) => p.value));
const TEK_DATE_PRESET_VALUES: Set<string> = new Set(DATE_PRESETS.map((p) => p.value));

/** Cache-only read of a reporting snapshot — never fetches from QBO. */
async function readCachedReport<T extends ReportPayload>(
  reportType: ReportType,
  range: DateRange,
  method: AccountingMethod
): Promise<{ payload: T; fetchedAt: Date } | null> {
  const row = await prisma.projReportSnapshot.findUnique({
    where: {
      reportType_periodStart_periodEnd_method: {
        reportType,
        periodStart: new Date(`${range.start}T00:00:00.000Z`),
        periodEnd: new Date(`${range.end}T00:00:00.000Z`),
        method,
      },
    },
  });
  return row ? { payload: parseReportPayload(reportType, row.payloadJson) as T, fetchedAt: row.fetchedAt } : null;
}

function money(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "get_sync_overview": {
      const [lastRun, grouped] = await Promise.all([
        prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
        prisma.sheetRow.groupBy({ by: ["status"], _count: { _all: true } }),
      ]);
      return {
        lastRun: lastRun && {
          startedAt: lastRun.startedAt,
          mode: lastRun.mode,
          rolloutStage: lastRun.rolloutStage,
          status: lastRun.status,
          rowsScanned: lastRun.rowsScanned,
          rowsPosted: lastRun.rowsPosted,
          rowsSkipped: lastRun.rowsSkipped,
          rowsError: lastRun.rowsError,
          tabsScanned: lastRun.tabsScanned,
        },
        statusCounts: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])),
      };
    }
    case "query_cash_sheet_rows": {
      const where: Record<string, unknown> = {};
      if (typeof input.status === "string") where.status = input.status;
      if (typeof input.tab === "string") where.tabName = input.tab;
      if (typeof input.purpose === "string") where.purpose = { contains: input.purpose, mode: "insensitive" };
      const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 50);
      const rows = await prisma.sheetRow.findMany({
        where,
        orderBy: [{ tabName: "asc" }, { rowNumberLastSeen: "asc" }],
        take: limit,
      });
      return {
        count: rows.length,
        rows: rows.map((r) => ({
          tab: r.tabName,
          row: r.rowNumberLastSeen,
          date: r.date ? r.date.toISOString().slice(0, 10) : null,
          name: r.name,
          purpose: r.purpose,
          inv: r.invNumber,
          amtCollected: money(r.amtCollected),
          amountPaidOut: money(r.amountPaidOut),
          bankDeposit: money(r.bankDeposit),
          status: r.status,
          qboTransactionId: r.qboTransactionId,
        })),
      };
    }
    case "list_purpose_mappings": {
      const maps = await prisma.purposeMapping.findMany({ where: { active: true }, orderBy: { normalizedPurpose: "asc" } });
      return maps.map((m) => ({
        purpose: m.purposePattern,
        action: m.qboAction,
        account: m.qboAccountName,
        auditOnly: m.auditOnly,
        requiresManualApproval: m.requiresManualApproval,
      }));
    }
    case "get_reporting_overview": {
      const preset = RANGE_PRESET_VALUES.has(input.preset as string) ? (input.preset as ReportRangePreset) : "this_month";
      const comparison: ReportComparisonMode =
        input.comparison === "prior_year" ? "prior_year" : input.comparison === "custom" ? "custom" : "prior_period";
      const method: AccountingMethod = input.method === "cash" ? "cash" : "accrual";
      const range = resolveRange(preset, new Date(), input.startDate as string | undefined, input.endDate as string | undefined);
      const priorRange = comparisonRange(
        range,
        comparison,
        input.comparisonStartDate as string | undefined,
        input.comparisonEndDate as string | undefined
      );

      const [pnl, pnlPrev, bs, bsPrev, ar, arPrev, ap, apPrev, cust, item] = await Promise.all([
        readCachedReport<PnlNormalized>("pnl", range, method),
        readCachedReport<PnlNormalized>("pnl", priorRange, method),
        readCachedReport<BalanceSheetNormalized>("balance_sheet", range, method),
        readCachedReport<BalanceSheetNormalized>("balance_sheet", priorRange, method),
        readCachedReport<AgingNormalized>("ar_aging", range, method),
        readCachedReport<AgingNormalized>("ar_aging", priorRange, method),
        readCachedReport<AgingNormalized>("ap_aging", range, method),
        readCachedReport<AgingNormalized>("ap_aging", priorRange, method),
        readCachedReport<SalesNormalized>("customer_sales", range, method),
        readCachedReport<SalesNormalized>("item_sales", range, method),
      ]);

      if (!pnl || !pnlPrev || !bs || !bsPrev || !ar || !arPrev || !ap || !apPrev) {
        return {
          error: `No cached report data for ${range.start}..${range.end} (${method}) yet. Open /projections with that period to warm the cache, then ask again.`,
        };
      }

      const kpis = deriveKpis({
        pnl: pnl.payload,
        pnlPrev: pnlPrev.payload,
        balanceSheet: bs.payload,
        balanceSheetPrev: bsPrev.payload,
        arTotal: ar.payload.total,
        arTotalPrev: arPrev.payload.total,
        apTotal: ap.payload.total,
        apTotalPrev: apPrev.payload.total,
      });

      const topN = <T extends { name: string; amount: number }>(rows: T[]): Array<{ name: string; amount: number }> =>
        [...rows].sort((a, b) => b.amount - a.amount).slice(0, 10).map((r) => ({ name: r.name, amount: r.amount }));

      return {
        range,
        comparison: priorRange,
        method,
        kpis: kpis.map((k) => ({
          key: k.key,
          label: k.label,
          format: k.format,
          value: k.value,
          deltaPct: k.delta.pct,
          direction: k.delta.direction,
        })),
        topExpenseLines: [...pnl.payload.expenseLines]
          .map((l) => ({ name: l.label, amount: sum(l.values) }))
          .sort((a, b) => b.amount - a.amount)
          .slice(0, 10),
        topCustomersByRevenue: cust ? topN(cust.payload.rows) : [],
        topItemsByRevenue: item ? topN(item.payload.rows) : [],
      };
    }
    case "get_ar_aging_detail": {
      const preset = RANGE_PRESET_VALUES.has(input.preset as string) ? (input.preset as ReportRangePreset) : "this_month";
      const method: AccountingMethod = input.method === "cash" ? "cash" : "accrual";
      const range = resolveRange(preset, new Date(), input.startDate as string | undefined, input.endDate as string | undefined);
      const ar = await readCachedReport<AgingNormalized>("ar_aging", range, method);
      if (!ar) {
        return {
          error: `No cached A/R aging report for ${range.start}..${range.end} (${method}) yet. Open /projections with that period to warm the cache, then ask again.`,
        };
      }
      return {
        asOf: ar.payload.asOf ?? range.end,
        bucketLabels: ar.payload.bucketLabels,
        total: ar.payload.total,
        rows: [...ar.payload.rows]
          .sort((a, b) => b.total - a.total)
          .slice(0, 30)
          .map((r) => ({ name: r.name, buckets: r.buckets, total: r.total })),
      };
    }
    case "get_tekmetric_operations": {
      if (!isTekmetricConfigured()) return { error: "Tekmetric integration is not configured." };
      const preset = TEK_DATE_PRESET_VALUES.has(input.preset as string) ? (input.preset as TekDatePreset) : "last_month";
      const period = presetRange(preset, shopToday());
      const { data } = await readOperationsSnapshot(period, TEK_DEFAULT_COMPARISON);
      if (!data) {
        return {
          error: `No cached Tekmetric snapshot for ${period.start}..${period.end} yet. Open /tekmetric with that period to refresh it, then ask again.`,
        };
      }
      return {
        period: data.period,
        kpis: data.kpis,
        technicianUtilization: [...data.techUtilization].sort((a, b) => a.utilizationPct - b.utilizationPct),
        revenueByMake: [...data.revenueByMake].sort((a, b) => b.revenue - a.revenue),
        serviceAdvisors: [...data.advisorPerformance].sort((a, b) => b.totalSales - a.totalSales),
      };
    }
    case "list_deposit_payouts": {
      const where: Record<string, unknown> = {};
      if (typeof input.status === "string") where.status = input.status;
      const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 50);
      const payouts = await prisma.depPayout.findMany({
        where,
        orderBy: [{ settlementDate: "desc" }, { createdAt: "desc" }],
        take: limit,
      });
      const needsReviewIds = payouts.filter((p) => p.status === "needs_review").map((p) => p.id);
      const reasonEvents = needsReviewIds.length
        ? await prisma.depEvent.findMany({
            where: { eventType: "locate_payments", payoutId: { in: needsReviewIds } },
            orderBy: { createdAt: "desc" },
          })
        : [];
      const reasonByPayout = new Map<string, string>();
      for (const e of reasonEvents) {
        if (e.payoutId && !reasonByPayout.has(e.payoutId)) reasonByPayout.set(e.payoutId, e.message);
      }
      return {
        count: payouts.length,
        payouts: payouts.map((p) => ({
          processor: p.processor,
          settlementDate: p.settlementDate,
          netAmount: money(p.netAmount),
          status: p.status,
          readyToCreate: p.status === "matched" && !p.qboDepositId,
          deltaDollars: p.deltaCents != null ? p.deltaCents / 100 : null,
          reason: reasonByPayout.get(p.id) ?? null,
          qboDepositId: p.qboDepositId,
        })),
      };
    }
    case "list_checks": {
      const where: Record<string, unknown> = {};
      if (typeof input.status === "string") where.status = input.status;
      const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 50);
      const checks = await prisma.chkCheck.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { batch: { select: { fileName: true } } },
      });
      return {
        count: checks.length,
        checks: checks.map((c) => ({
          checkNumber: c.checkNumber,
          amount: money(c.amount),
          checkDate: c.checkDate,
          payeeRaw: c.payeeRaw,
          payeeResolved: c.payeeResolved,
          categoryAccountName: c.categoryAccountName,
          confidence: c.confidence,
          status: c.status,
          statusReason: c.statusReason,
          batchFile: c.batch?.fileName ?? null,
        })),
      };
    }
    case "list_payee_mappings": {
      const maps = await prisma.chkPayeeMapping.findMany({ where: { active: true }, orderBy: { payeeDisplay: "asc" } });
      return maps.map((m) => ({
        payee: m.payeeDisplay,
        qboVendorName: m.qboVendorName,
        categoryAccountName: m.categoryAccountName,
        timesConfirmed: m.timesConfirmed,
        knownMisreads: m.rawAliases,
      }));
    }
    case "list_coworker_questions": {
      const status = typeof input.status === "string" ? input.status : "open";
      const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 50);
      const questions = await prisma.cwpQuestion.findMany({
        where: { status },
        orderBy: { createdAt: "desc" },
        take: limit,
        include: { answers: { orderBy: { createdAt: "desc" }, take: 1 } },
      });
      return {
        count: questions.length,
        questions: questions.map((q) => ({
          subject: q.subject,
          askedBy: q.askedByEmail,
          assignedTo: q.assignedEmail,
          status: q.status,
          qboTxnName: q.qboTxnName,
          qboTxnAmount: money(q.qboTxnAmount),
          qboTxnDate: q.qboTxnDate,
          latestAnswer: q.answers[0]?.body ?? null,
          answeredBy: q.answers[0]?.answeredByEmail ?? null,
          createdAt: q.createdAt.toISOString().slice(0, 10),
        })),
      };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantReply {
  text: string;
  /** Redacted usage for cost visibility (never secrets). */
  usage: { inputTokens: number; outputTokens: number; toolCalls: number };
}

/**
 * Answer a question given prior turns (plain text) + the new user message.
 * Runs a bounded manual tool loop. Adaptive thinking is on; the full response
 * content (including thinking + tool_use blocks) is echoed back each turn as
 * required when continuing on the same model.
 */
export async function askAssistant(history: ChatTurn[], userMessage: string): Promise<AssistantReply> {
  if (!isAssistantConfigured()) {
    throw new Error("Assistant is not configured (ANTHROPIC_API_KEY is unset).");
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content }) as Anthropic.MessageParam),
    { role: "user", content: userMessage },
  ];

  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16384,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;

    if (response.stop_reason !== "tool_use") {
      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { text: text || "(no answer)", usage: { inputTokens, outputTokens, toolCalls } };
    }

    // Echo the full assistant turn (thinking + tool_use blocks) back verbatim.
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        toolCalls++;
        let result: unknown;
        try {
          result = await runTool(block.name, (block.input ?? {}) as Record<string, unknown>);
        } catch (err) {
          result = { error: String(err) };
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  return {
    text: "I wasn't able to finish looking that up (too many steps). Please narrow the question.",
    usage: { inputTokens, outputTokens, toolCalls },
  };
}

/** For logging/debug only — never expose the key. */
export function assistantKeyHint(): string {
  return redact(process.env.ANTHROPIC_API_KEY);
}
