/**
 * Arcade bridge for the redesigned Coworker Portal page.
 *
 * Same standalone-secret trust boundary as the other /api/external/*
 * bridges (see reporting/route.ts's header comment). Read-only — asking,
 * answering, closing/reopening a question, and importing from QuickBooks
 * are all real mutations this module performs on its native page, and none
 * of them are exposed here. The Arcade shell's own "Open full app" link
 * (already wired at the tile level, unrelated to this bridge) is the
 * intended way to actually act on a question; this bridge exists purely so
 * ownership/management can see the board and ask GCD Pal about it without
 * leaving the Arcade.
 *
 * Unlike the native page, this does NOT scope questions to the requesting
 * user (the native page restricts a `coworker`-role viewer to their own
 * assigned + unassigned questions) — the Arcade's own access boundary is
 * "ownership/management only" (see the redesign's Q8 answer), so full
 * visibility here is the correct behavior, matching every other QBO Hub
 * bridge's full-org view.
 *
 * GET ?status=open|answered|closed|all (default "open")
 */
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
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

const STATUS_VALUES = new Set(["open", "answered", "closed", "all"]);
const QUESTIONS_CAP = 50;
const LEADERBOARD_CAP = 10;

function questionUrl(id: string): string | null {
  const base = process.env.PUBLIC_APP_URL;
  return base ? new URL(`/coworker-portal/${id}`, base).toString() : null;
}

async function loadSnapshot() {
  const [grouped, unassignedOpen, oldestOpen, bySourceGrouped, answered] = await Promise.all([
    prisma.cwpQuestion.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.cwpQuestion.count({ where: { status: "open", assignedEmail: null } }),
    prisma.cwpQuestion.findFirst({ where: { status: "open" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    prisma.cwpQuestion.groupBy({ by: ["source"], _count: { _all: true } }),
    // Response time: the gap between a question's createdAt and its FIRST
    // answer's createdAt, averaged across every question that has at least
    // one answer (answered or closed — closed questions were answered too).
    prisma.cwpQuestion.findMany({
      where: { status: { in: ["answered", "closed"] } },
      select: { createdAt: true, answers: { orderBy: { createdAt: "asc" }, take: 1, select: { createdAt: true } } },
    }),
  ]);

  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;
  const bySource: Record<string, number> = {};
  for (const g of bySourceGrouped) bySource[g.source] = g._count._all;

  const responseHours = answered
    .filter((q) => q.answers.length > 0)
    .map((q) => (q.answers[0].createdAt.getTime() - q.createdAt.getTime()) / 3_600_000);
  const avgResponseHours =
    responseHours.length > 0 ? Math.round((responseHours.reduce((a, b) => a + b, 0) / responseHours.length) * 10) / 10 : null;

  const oldestOpenDays = oldestOpen
    ? Math.round(((Date.now() - oldestOpen.createdAt.getTime()) / 86_400_000) * 10) / 10
    : null;

  return {
    counts: { open: counts.open ?? 0, answered: counts.answered ?? 0, closed: counts.closed ?? 0 },
    unassignedOpen,
    oldestOpenDays,
    avgResponseHours,
    bySource: { manual: bySource.manual ?? 0, askMyClient: bySource.ask_my_client ?? 0 },
  };
}

async function loadAssignedLeaderboard() {
  const grouped = await prisma.cwpQuestion.groupBy({
    by: ["assignedEmail"],
    where: { status: "open", assignedEmail: { not: null } },
    _count: { _all: true },
  });
  return grouped
    .map((g) => ({ email: g.assignedEmail as string, openCount: g._count._all }))
    .sort((a, b) => b.openCount - a.openCount)
    .slice(0, LEADERBOARD_CAP);
}

async function loadQuestions(status: string) {
  const where = status === "all" ? {} : { status };
  // Open questions surface oldest-first (what's been waiting longest is
  // what needs attention); every other view is most-recent-first.
  const orderBy = status === "open" ? { createdAt: "asc" as const } : { createdAt: "desc" as const };

  const rows = await prisma.cwpQuestion.findMany({
    where,
    orderBy,
    take: QUESTIONS_CAP,
    include: { _count: { select: { answers: true } } },
  });

  return rows.map((q) => ({
    id: q.id,
    subject: q.subject,
    status: q.status,
    askedByEmail: q.askedByEmail,
    assignedEmail: q.assignedEmail,
    source: q.source,
    qboTxnName: q.qboTxnName,
    qboTxnAmount: q.qboTxnAmount === null ? null : Number(q.qboTxnAmount),
    qboTxnDate: q.qboTxnDate,
    createdAt: q.createdAt.toISOString(),
    answerCount: q._count.answers,
    url: questionUrl(q.id),
  }));
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? "open";
  const status = STATUS_VALUES.has(statusParam) ? statusParam : "open";

  try {
    const [snapshot, assignedLeaderboard, questions, insights] = await Promise.all([
      loadSnapshot(),
      loadAssignedLeaderboard(),
      loadQuestions(status),
      buildModuleInsights("coworker-portal"),
    ]);
    return NextResponse.json({ snapshot, assignedLeaderboard, questions, insights });
  } catch (err) {
    return NextResponse.json({ error: "coworker_portal_failed", message: String(err) }, { status: 500 });
  }
}
