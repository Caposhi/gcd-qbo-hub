/**
 * The /console/* contract, hub-side (§1, §21).
 *
 * gcd-arcade reads this hub over the same read-only contract as the other
 * backends. The hub advertises ONE tile with per-module sub-items (programs[]):
 * Cash Sheet Sync (live) plus Projections / Assistant / Coworker Portal stubs.
 * Same shared-secret gate (CONSOLE_TOKEN) as gcd-webhook.
 *
 * Read-only, no secrets: never expose QBO tokens or financial detail here —
 * only counts and health (§18).
 */
import { prisma } from "@/lib/db";
import { getRolloutStage, getQboEnvironment } from "@/lib/config-store";
import { RowStatus } from "@/lib/cashsheet/status";

export const CONSOLE_MANIFEST = {
  id: "gcd-qbo-hub",
  name: "GCD QBO Hub",
  tagline: "QuickBooks Online automations, reporting & portals",
  description: "Cash Sheet Sync (live) with Projections, AI Report Assistant & Coworker Portal to come.",
  theme: { palette: ["#0d1b2a", "#2ec4b6", "#e0fbfc"], style: "ledger control room", icon: "📒" },
  programs: [
    { id: "cash-sheet-sync", name: "Cash Sheet Sync", icon: "💵", externalUrl: "/cash-sheet-sync" },
    { id: "projections", name: "Financial Projections", icon: "📈" },
    { id: "assistant", name: "AI Report Assistant", icon: "🤖" },
    { id: "coworker-portal", name: "Coworker Portal", icon: "🧑‍🔧" },
  ],
  endpoints: { state: "/console/state", stream: "/console/stream" },
  get externalUrl() {
    return process.env.PUBLIC_APP_URL ?? null;
  },
};

// ---- in-memory event ring buffer for /console/stream --------------------
export interface ConsoleEvent {
  id: number;
  program?: string;
  kind: string;
  message?: string;
  data?: unknown;
  createdAt: string;
}
const events: ConsoleEvent[] = [];
let seq = 0;
const subscribers = new Set<(e: ConsoleEvent) => void>();

export function pushConsole(program: string, kind: string, message?: string, data?: unknown): ConsoleEvent {
  const e: ConsoleEvent = { id: ++seq, program, kind, message, data: data ?? null, createdAt: new Date().toISOString() };
  events.push(e);
  if (events.length > 1000) events.shift();
  for (const fn of subscribers) {
    try {
      fn(e);
    } catch {
      /* telemetry must never throw into real work */
    }
  }
  return e;
}

export function recentEvents(sinceId = 0): ConsoleEvent[] {
  return events.filter((e) => e.id > sinceId);
}
export function subscribe(fn: (e: ConsoleEvent) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Build the /console/state snapshot (counts only, no secrets). */
export async function buildConsoleState() {
  const [stage, environment, lastRun, statusCounts] = await Promise.all([
    getRolloutStage().catch(() => "dry_run"),
    getQboEnvironment().catch(() => "sandbox"),
    prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } }).catch(() => null),
    countByStatus().catch(() => ({}) as Record<string, number>),
  ]);

  const setupRequired = (lastRun?.summaryJson as any)?.setupRequired ?? false;

  return {
    id: "gcd-qbo-hub",
    environment,
    rolloutStage: stage,
    modules: {
      "cash-sheet-sync": {
        lastSyncAt: lastRun?.finishedAt ?? lastRun?.startedAt ?? null,
        rowsScanned: lastRun?.rowsScanned ?? 0,
        rowsPosted: lastRun?.rowsPosted ?? 0,
        rowsSkipped: lastRun?.rowsSkipped ?? 0,
        rowsError: lastRun?.rowsError ?? 0,
        possibleDuplicates: statusCounts[RowStatus.PossibleDuplicate] ?? 0,
        changedAfterPosting: statusCounts[RowStatus.ChangedAfterPosting] ?? 0,
        removedAfterPosting: statusCounts[RowStatus.RemovedFromSheetAfterPosting] ?? 0,
        auditOnly: statusCounts[RowStatus.AuditOnly] ?? 0,
        awaitingQboMatch: statusCounts[RowStatus.AwaitingQboMatch] ?? 0,
        unknownPurpose: statusCounts[RowStatus.UnknownPurpose] ?? 0,
        setupRequired,
      },
    },
    recentEvents: recentEvents().slice(-30),
  };
}

async function countByStatus(): Promise<Record<string, number>> {
  const grouped = await prisma.sheetRow.groupBy({ by: ["status"], _count: { _all: true } });
  const out: Record<string, number> = {};
  for (const g of grouped) out[g.status] = g._count._all;
  return out;
}

// ---- shared token gate (same pattern as gcd-webhook) --------------------
export function consoleAuthorized(req: Request): boolean {
  const token = process.env.CONSOLE_TOKEN;
  if (!token) return true;
  const url = new URL(req.url);
  const got = req.headers.get("x-console-token") || url.searchParams.get("key");
  return got === token;
}

export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,x-console-token",
  };
}
