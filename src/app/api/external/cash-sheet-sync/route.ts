/**
 * Arcade bridge for the redesigned Cash Sheet Sync page.
 *
 * Same standalone-secret trust boundary as the other /api/external/* bridges
 * (see reporting/route.ts's header comment). Read-only: this module's own
 * posting logic (engine.ts) is never touched from here.
 *
 * GET ?window=30|90|365&granularity=week|month|year
 *   window   — how many days of SheetRow history the trend/leaderboard cover.
 *   granularity — trend bucket size.
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getRolloutStage, getQboEnvironment } from "@/lib/config-store";
import { RowStatus } from "@/lib/cashsheet/status";
import { buildModuleInsights } from "@/lib/assistant/insights";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

function authorized(req: Request): boolean {
  const secret = process.env.ARCADE_BRIDGE_SECRET;
  if (!secret) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

const WINDOW_DAYS = new Set([30, 90, 365]);
const GRANULARITIES = new Set(["week", "month", "year"]);

const POSTED_STATUSES = [RowStatus.Posted, RowStatus.PostedWithWarning, RowStatus.DepositCreated];
const EXCEPTION_ALWAYS_STATUSES = [
  RowStatus.UnknownPurpose,
  RowStatus.MissingAccountMapping,
  RowStatus.MissingPayeeMapping,
  RowStatus.ChangedAfterPosting,
  RowStatus.RemovedFromSheetAfterPosting,
  RowStatus.Error,
];
const EXCEPTION_REVIEW_STATUSES = [RowStatus.PossibleDuplicate, RowStatus.DuplicateRowId];

function rowAmount(r: { amtCollected: unknown; amountPaidOut: unknown; bankDeposit: unknown }): number {
  const v = r.amtCollected ?? r.amountPaidOut ?? r.bankDeposit;
  return v === null || v === undefined ? 0 : Number(v);
}

/** Bucket key for a date at the given granularity, sortable as a string. */
function bucketKey(d: Date, granularity: "week" | "month" | "year"): { key: string; label: string } {
  if (granularity === "year") {
    const y = d.getUTCFullYear();
    return { key: String(y), label: String(y) };
  }
  if (granularity === "month") {
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth();
    const key = `${y}-${String(m + 1).padStart(2, "0")}`;
    const label = new Date(Date.UTC(y, m, 1)).toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    return { key, label };
  }
  // week: Monday-anchored ISO-ish week start.
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);
  const key = monday.toISOString().slice(0, 10);
  const label = monday.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return { key, label };
}

function rowUrl(id: string): string | null {
  const base = process.env.PUBLIC_APP_URL;
  return base ? new URL(`/cash-sheet-sync/rows/${id}`, base).toString() : null;
}

async function loadSnapshot() {
  const [lastRun, grouped, stage, environment] = await Promise.all([
    prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.sheetRow.groupBy({ by: ["status"], _count: { _all: true } }),
    getRolloutStage(),
    getQboEnvironment(),
  ]);
  const dupUnreviewed = await prisma.sheetRow.groupBy({
    by: ["status"],
    where: { status: { in: EXCEPTION_REVIEW_STATUSES }, reviewedAt: null },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;
  const dupCounts: Record<string, number> = {};
  for (const g of dupUnreviewed) dupCounts[g.status] = g._count._all;

  return {
    rolloutStage: stage,
    environment,
    lastRun: lastRun
      ? {
          startedAt: lastRun.startedAt.toISOString(),
          mode: lastRun.mode,
          status: lastRun.status,
          rowsScanned: lastRun.rowsScanned,
          rowsPosted: lastRun.rowsPosted,
          rowsSkipped: lastRun.rowsSkipped,
          rowsError: lastRun.rowsError,
          rowsWarning: lastRun.rowsWarning,
          tabsScanned: lastRun.tabsScanned,
        }
      : null,
    attention: {
      possibleDuplicates: dupCounts[RowStatus.PossibleDuplicate] ?? 0,
      duplicateRowIds: dupCounts[RowStatus.DuplicateRowId] ?? 0,
      unknownPurpose: counts[RowStatus.UnknownPurpose] ?? 0,
      missingAccountMapping: counts[RowStatus.MissingAccountMapping] ?? 0,
      missingPayeeMapping: counts[RowStatus.MissingPayeeMapping] ?? 0,
      changedAfterPosting: counts[RowStatus.ChangedAfterPosting] ?? 0,
      removedAfterPosting: counts[RowStatus.RemovedFromSheetAfterPosting] ?? 0,
      auditOnly: counts[RowStatus.AuditOnly] ?? 0,
      awaitingQboMatch: counts[RowStatus.AwaitingQboMatch] ?? 0,
      error: counts[RowStatus.Error] ?? 0,
    },
  };
}

async function loadTrend(windowDays: number, granularity: "week" | "month" | "year") {
  const since = new Date(Date.now() - windowDays * 86400000);
  const rows = await prisma.sheetRow.findMany({
    where: { date: { gte: since } },
    select: { date: true, status: true, amtCollected: true, amountPaidOut: true, bankDeposit: true },
  });

  const buckets = new Map<string, { label: string; rowsPosted: number; volumePosted: number; rowsError: number; rowsDuplicate: number }>();
  for (const r of rows) {
    if (!r.date) continue;
    const { key, label } = bucketKey(r.date, granularity);
    if (!buckets.has(key)) buckets.set(key, { label, rowsPosted: 0, volumePosted: 0, rowsError: 0, rowsDuplicate: 0 });
    const b = buckets.get(key)!;
    if ((POSTED_STATUSES as string[]).includes(r.status)) {
      b.rowsPosted += 1;
      b.volumePosted += rowAmount(r);
    } else if (r.status === RowStatus.Error) {
      b.rowsError += 1;
    } else if (r.status === RowStatus.PossibleDuplicate || r.status === RowStatus.DuplicateRowId) {
      b.rowsDuplicate += 1;
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, b]) => ({ period: b.label, rowsPosted: b.rowsPosted, volumePosted: Math.round(b.volumePosted * 100) / 100, rowsError: b.rowsError, rowsDuplicate: b.rowsDuplicate }));
}

async function loadExceptions() {
  const rows = await prisma.sheetRow.findMany({
    where: {
      OR: [
        { status: { in: EXCEPTION_REVIEW_STATUSES }, reviewedAt: null },
        { status: { in: EXCEPTION_ALWAYS_STATUSES } },
      ],
    },
    orderBy: { lastSeenAt: "desc" },
    take: 30,
  });
  return rows.map((r) => ({
    id: r.id,
    tab: r.tabName,
    row: r.rowNumberLastSeen,
    status: r.status,
    date: r.date ? r.date.toISOString().slice(0, 10) : null,
    name: r.name,
    purpose: r.purpose,
    amount: rowAmount(r),
    url: rowUrl(r.id),
  }));
}

async function loadRecentEdits() {
  const events = await prisma.rowEvent.findMany({
    where: { eventType: "row_changed" },
    orderBy: { createdAt: "desc" },
    take: 12,
    include: { sheetRow: { select: { id: true, tabName: true, rowNumberLastSeen: true } } },
  });
  return events.map((e) => ({
    id: e.id,
    when: e.createdAt.toISOString(),
    tab: e.sheetRow?.tabName ?? null,
    row: e.sheetRow?.rowNumberLastSeen ?? null,
    url: e.sheetRow ? rowUrl(e.sheetRow.id) : null,
    fields: Array.isArray(e.diffJson)
      ? e.diffJson.map((d) => (d && typeof d === "object" && "field" in d ? String((d as { field: unknown }).field) : "")).filter(Boolean)
      : [],
    message: e.eventMessage,
  }));
}

async function loadPayeeLeaderboard(windowDays: number) {
  const since = new Date(Date.now() - windowDays * 86400000);
  const rows = await prisma.sheetRow.findMany({
    where: { status: { in: POSTED_STATUSES }, date: { gte: since } },
    select: { name: true, amtCollected: true, amountPaidOut: true, bankDeposit: true },
  });
  const byName = new Map<string, { amount: number; count: number }>();
  for (const r of rows) {
    const name = (r.name ?? "").trim() || "(unnamed)";
    if (!byName.has(name)) byName.set(name, { amount: 0, count: 0 });
    const b = byName.get(name)!;
    b.amount += rowAmount(r);
    b.count += 1;
  }
  return [...byName.entries()]
    .map(([name, b]) => ({ name, amount: Math.round(b.amount * 100) / 100, count: b.count }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const windowDays = WINDOW_DAYS.has(Number(url.searchParams.get("window"))) ? Number(url.searchParams.get("window")) : 90;
  const granularity = (GRANULARITIES.has(url.searchParams.get("granularity") ?? "") ? url.searchParams.get("granularity") : "week") as
    | "week"
    | "month"
    | "year";

  try {
    const [snapshot, trend, exceptions, recentEdits, payeeLeaderboard, insights] = await Promise.all([
      loadSnapshot(),
      loadTrend(windowDays, granularity),
      loadExceptions(),
      loadRecentEdits(),
      loadPayeeLeaderboard(windowDays),
      buildModuleInsights("cash-sheet-sync"),
    ]);
    return NextResponse.json({ snapshot, trend, exceptions, recentEdits, payeeLeaderboard, insights });
  } catch (err) {
    return NextResponse.json({ error: "cash_sheet_sync_failed", message: String(err) }, { status: 500 });
  }
}
