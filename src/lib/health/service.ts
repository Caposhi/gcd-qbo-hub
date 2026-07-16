/**
 * System-health aggregator (owner operator view) — IO, READ-ONLY, no network.
 *
 * Answers "is everything working right now?" in one place by reading state the
 * app already persists: the QBO credential row (never a live token refresh — that
 * would race the data path, §oauth), the last Cash Sheet sync run, Tekmetric
 * backfill completeness/integrity, transcript freshness, the month's AI-council
 * spend against its cap, and the email-alert delivery backlog. Every check is a
 * plain DB read; nothing here calls QBO/Tekmetric/Anthropic.
 */
import { prisma } from "@/lib/db";
import { getQboEnvironment } from "@/lib/config-store";
import { hasStoredCredential } from "@/lib/qbo/oauth";
import { isTekmetricConfigured } from "@/lib/tekmetric/client";
import { readOperationsKpis } from "@/lib/tekmetric/snapshot";
import { looksLikePartialMonth } from "@/lib/tekmetric/forecast";
import { monthRangesBack, shopToday, DEFAULT_COMPARISON } from "@/lib/tekmetric/periods";
import { isTranscriptsConfigured } from "@/lib/transcripts/client";
import { MONTHLY_CAP_USD } from "@/lib/ai/budget";

export type HealthStatus = "ok" | "warn" | "error" | "idle";

export interface HealthCheck {
  key: string;
  label: string;
  status: HealthStatus;
  /** One-line summary of the current state. */
  headline: string;
  /** Optional supporting detail. */
  detail?: string;
  /** Where to go to act on it. */
  href?: string;
}

export interface SystemHealth {
  generatedAt: string; // ISO
  checks: HealthCheck[];
}

/** Human "time ago" from a past date (coarse; for at-a-glance freshness). */
function ago(from: Date, now: Date): string {
  const mins = Math.floor((now.getTime() - from.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function money(v: number): string {
  return `$${v.toFixed(2)}`;
}

async function checkQbo(now: Date): Promise<HealthCheck> {
  const env = await getQboEnvironment();
  const base = { key: "qbo", label: "QuickBooks connection", href: "/cash-sheet-sync/settings" };
  try {
    const stored = await hasStoredCredential(env);
    if (!stored) {
      return { ...base, status: "error", headline: `Not connected (${env})`, detail: "Connect QBO in Settings & rollout." };
    }
    const cred = await prisma.qboCredential.findFirst({
      where: { environment: env },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true, accessTokenExpires: true, refreshTokenExpires: true, connectedByEmail: true },
    });
    const refreshLapsed = cred?.refreshTokenExpires && cred.refreshTokenExpires.getTime() <= now.getTime();
    if (refreshLapsed) {
      return { ...base, status: "error", headline: `Reconnect required (${env})`, detail: "The saved connection expired — reconnect QBO." };
    }
    const detail = cred
      ? `Credential refreshed ${ago(cred.updatedAt, now)}${cred.connectedByEmail ? ` by ${cred.connectedByEmail}` : ""}.`
      : undefined;
    return { ...base, status: "ok", headline: `Connected (${env})`, detail };
  } catch {
    return { ...base, status: "warn", headline: `Unknown (${env})`, detail: "Couldn't read the credential row." };
  }
}

async function checkSync(now: Date): Promise<HealthCheck> {
  const base = { key: "sync", label: "Cash Sheet Sync", href: "/cash-sheet-sync" };
  const run = await prisma.syncRun.findFirst({
    orderBy: { startedAt: "desc" },
    select: { startedAt: true, status: true, mode: true, rolloutStage: true, rowsPosted: true, rowsError: true },
  });
  if (!run) return { ...base, status: "idle", headline: "No sync has run yet." };
  const status: HealthStatus = run.status === "success" ? "ok" : run.status === "error" ? "error" : "warn";
  return {
    ...base,
    status,
    headline: `Last run ${run.status} · ${run.mode} · ${run.rolloutStage} (${ago(run.startedAt, now)})`,
    detail: `${run.rowsPosted} posted, ${run.rowsError} error${run.rowsError === 1 ? "" : "s"}.`,
  };
}

async function checkTekmetric(now: Date): Promise<HealthCheck> {
  const base = { key: "tekmetric", label: "Tekmetric backfill", href: "/projections?tab=opshistory" };
  if (!isTekmetricConfigured()) {
    return { ...base, status: "idle", headline: "Not configured." };
  }
  const ranges = monthRangesBack(shopToday(), 24); // oldest → newest
  let present = 0;
  const missing: string[] = [];
  const suspect: string[] = [];
  for (const r of ranges) {
    const kpis = await readOperationsKpis(r, DEFAULT_COMPARISON).catch(() => null);
    if (!kpis) {
      missing.push(r.label);
      continue;
    }
    present += 1;
    if (looksLikePartialMonth({ roCount: kpis.roCount, grossMarginPct: kpis.grossMarginPct, aro: kpis.aro })) {
      suspect.push(r.label);
    }
  }
  const clean = missing.length === 0 && suspect.length === 0;
  const status: HealthStatus = present === 0 ? "error" : clean ? "ok" : "warn";
  const parts: string[] = [];
  if (missing.length) parts.push(`${missing.length} missing`);
  if (suspect.length) parts.push(`${suspect.length} suspect (${suspect.join(", ")})`);
  return {
    ...base,
    status,
    headline: `${present}/${ranges.length} months cached${clean ? " · all clean" : ""}`,
    detail: parts.length ? parts.join(" · ") + ". Re-run the backfill to fix." : undefined,
  };
}

async function checkTranscripts(now: Date): Promise<HealthCheck> {
  const base = { key: "transcripts", label: "Call transcripts", href: "/tekmetric" };
  if (!isTranscriptsConfigured()) return { ...base, status: "idle", headline: "Not configured." };
  const snap = await prisma.transcriptSnapshot.findFirst({
    orderBy: { fetchedAt: "desc" },
    select: { fetchedAt: true },
  });
  if (!snap) return { ...base, status: "warn", headline: "Configured, but nothing cached yet." };
  const staleDays = (now.getTime() - snap.fetchedAt.getTime()) / 86_400_000;
  return {
    ...base,
    status: staleDays > 45 ? "warn" : "ok",
    headline: `Last refreshed ${ago(snap.fetchedAt, now)}`,
    detail: staleDays > 45 ? "Insights are getting stale — refresh them." : undefined,
  };
}

async function checkAiBudget(now: Date): Promise<HealthCheck> {
  const base = { key: "ai_budget", label: "AI Council budget", href: "/projections?tab=council" };
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const runs = await prisma.aiAgentRun.findMany({
    where: { startedAt: { gte: monthStart } },
    select: { spentUsd: true },
  });
  const spent = runs.reduce((a, r) => a + (r.spentUsd ?? 0), 0);
  const pct = MONTHLY_CAP_USD > 0 ? spent / MONTHLY_CAP_USD : 0;
  const status: HealthStatus = pct >= 1 ? "error" : pct >= 0.8 ? "warn" : "ok";
  return {
    ...base,
    status,
    headline: `${money(spent)} / ${money(MONTHLY_CAP_USD)} this month`,
    detail: `${runs.length} run${runs.length === 1 ? "" : "s"} so far. Cap stops further runs.`,
  };
}

async function checkAlerts(now: Date): Promise<HealthCheck> {
  const base = { key: "alerts", label: "Email alert delivery", href: "/cash-sheet-sync" };
  const [failed, pending] = await Promise.all([
    prisma.alert.count({ where: { status: "failed" } }),
    prisma.alert.count({ where: { status: "pending" } }),
  ]);
  const status: HealthStatus = failed > 0 ? "error" : pending > 0 ? "warn" : "ok";
  const headline =
    failed > 0
      ? `${failed} failed to send`
      : pending > 0
        ? `${pending} pending delivery`
        : "All alerts delivered";
  return {
    ...base,
    status,
    headline,
    detail: failed > 0 ? "Check SendGrid config / diagnostics." : undefined,
  };
}

/** Assemble the full system-health snapshot. Read-only, no network. */
export async function loadSystemHealth(now: Date): Promise<SystemHealth> {
  const checks = await Promise.all([
    checkQbo(now),
    checkSync(now),
    checkTekmetric(now),
    checkTranscripts(now),
    checkAiBudget(now),
    checkAlerts(now),
  ]);
  return { generatedAt: now.toISOString(), checks };
}
