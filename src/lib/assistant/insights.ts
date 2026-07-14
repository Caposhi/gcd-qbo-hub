/**
 * GCD Pal insights — deterministic, READ-ONLY, cache/DB-only.
 *
 * Powers the companion's per-module bullets with REAL figures drawn from the
 * same data the modules already show. Design constraints (deliberate):
 *   - No fabrication: every number here comes straight from the DB or an existing
 *     cached snapshot. If there's nothing to say, we return [] and the Pal falls
 *     back to its static, figure-free copy.
 *   - No network: this must never trigger a QBO / Tekmetric / transcript fetch
 *     (those are gated, and a fetch on a companion that pops up everywhere is
 *     exactly what we don't want). We only read the DB and cached snapshots.
 *   - No LLM: it's cheap and instant, and can't hallucinate. The seeded `prompt`
 *     still routes the user to the full assistant for a deeper answer.
 *
 * Each builder is defensive — any failure yields [] rather than throwing, so the
 * Pal degrades to static copy instead of erroring.
 */
import { prisma } from "@/lib/db";
import { RowStatus } from "@/lib/cashsheet/status";
import { getRolloutStage } from "@/lib/config-store";
import { readOperationsSnapshot } from "@/lib/tekmetric/snapshot";
import { presetRange, shopToday, DEFAULT_PRESET, DEFAULT_COMPARISON } from "@/lib/tekmetric/periods";

export type PalTone = "good" | "watch" | "bad" | "info";
export interface PalInsight {
  tone: PalTone;
  text: string;
  prompt: string;
}

const money = (n: number): string => "$" + Math.round(n).toLocaleString("en-US");
const plural = (n: number, one: string, many = one + "s"): string => (n === 1 ? one : many);

/** Order bad → watch → info/good and cap at 4 so the panel stays tight. */
function rank(items: PalInsight[]): PalInsight[] {
  const weight: Record<PalTone, number> = { bad: 0, watch: 1, good: 2, info: 3 };
  return [...items].sort((a, b) => weight[a.tone] - weight[b.tone]).slice(0, 4);
}

export async function buildModuleInsights(moduleId: string): Promise<PalInsight[]> {
  try {
    switch (moduleId) {
      case "cash-sheet-sync":
        return await cashSheetInsights();
      case "tekmetric":
        return await tekmetricInsights();
      case "coworker-portal":
        return await coworkerInsights();
      case "deposit-reconciliation":
        return await depositInsights();
      case "check-reception":
        return await checkInsights();
      default:
        return [];
    }
  } catch {
    return [];
  }
}

async function cashSheetInsights(): Promise<PalInsight[]> {
  const [grouped, lastRun, stage] = await Promise.all([
    prisma.sheetRow.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
    getRolloutStage().catch(() => null),
  ]);
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;

  const out: PalInsight[] = [];
  const changed = counts[RowStatus.ChangedAfterPosting] ?? 0;
  const removed = counts[RowStatus.RemovedFromSheetAfterPosting] ?? 0;
  const dupes = counts[RowStatus.PossibleDuplicate] ?? 0;
  const missingMap = counts[RowStatus.MissingAccountMapping] ?? 0;
  const errors = lastRun?.rowsError ?? 0;

  if (changed + removed > 0) {
    out.push({
      tone: "bad",
      text: `${changed + removed} ${plural(changed + removed, "row")} changed or removed after posting — QuickBooks was not touched. Check the diff.`,
      prompt: "Show the field-level diff for any rows changed or removed after posting.",
    });
  }
  if (errors > 0) {
    out.push({
      tone: "bad",
      text: `The last sync logged ${errors} ${plural(errors, "error")}.`,
      prompt: "What errored in the last sync, and why?",
    });
  }
  if (dupes > 0) {
    out.push({
      tone: "watch",
      text: `${dupes} possible ${plural(dupes, "duplicate")} flagged. Review before the next post.`,
      prompt: "List the possible-duplicate rows from the last sync and why each was flagged.",
    });
  }
  if (missingMap > 0) {
    out.push({
      tone: "watch",
      text: `${missingMap} ${plural(missingMap, "row")} have no account mapping yet.`,
      prompt: "Which rows are missing an account mapping, and what purposes do they use?",
    });
  }
  if (stage) {
    out.push({
      tone: "info",
      text: `You're on the ${stage} rollout stage.`,
      prompt: `What does the ${stage} rollout stage do, and what's the next stage?`,
    });
  }
  return rank(out);
}

async function tekmetricInsights(): Promise<PalInsight[]> {
  const period = presetRange(DEFAULT_PRESET, shopToday());
  const { data } = await readOperationsSnapshot(period, DEFAULT_COMPARISON);
  if (!data) return []; // no cached snapshot → static fallback

  const out: PalInsight[] = [];
  const aro = data.kpis.aro;
  if (aro.deltaPct !== null) {
    const up = aro.deltaPct >= 0;
    out.push({
      tone: up ? "good" : "watch",
      text: `ARO is ${money(aro.value)}, ${up ? "up" : "down"} ${Math.abs(aro.deltaPct).toFixed(1)}% vs the comparison period.`,
      prompt: "What's driving the change in ARO this period versus the comparison period?",
    });
  }
  const low = data.techUtilization
    .filter((t) => t.utilizationPct < 60)
    .sort((a, b) => a.utilizationPct - b.utilizationPct);
  if (low.length > 0) {
    out.push({
      tone: "watch",
      text: `${low.length} ${plural(low.length, "tech", "techs")} under 60% utilization (lowest: ${low[0].technicianName} at ${Math.round(low[0].utilizationPct)}%).`,
      prompt: "Which technicians are below 60% utilization and by how much?",
    });
  }
  const topMake = data.revenueByMake[0];
  if (topMake) {
    out.push({
      tone: "info",
      text: `Top revenue make is ${topMake.make} at ${money(topMake.revenue)}.`,
      prompt: "Show revenue and gross profit by make, largest first.",
    });
  }
  return rank(out);
}

async function coworkerInsights(): Promise<PalInsight[]> {
  const open = await prisma.cwpQuestion.count({ where: { status: "open" } });
  if (open === 0) return [];
  return [
    {
      tone: "watch",
      text: `${open} coworker ${plural(open, "question is", "questions are")} open and waiting on answers.`,
      prompt: "Summarize the open coworker questions and who they're assigned to.",
    },
  ];
}

async function depositInsights(): Promise<PalInsight[]> {
  const grouped = await prisma.depPayout.groupBy({ by: ["status"], _count: { _all: true } });
  const counts: Record<string, number> = {};
  for (const g of grouped) counts[g.status] = g._count._all;

  const out: PalInsight[] = [];
  const ready = (counts["matched"] ?? 0) + (counts["proposed"] ?? 0);
  const needsReview = counts["needs_review"] ?? 0;
  if (ready > 0) {
    out.push({
      tone: "good",
      text: `${ready} ${plural(ready, "payout")} matched and ready to create as QBO deposits.`,
      prompt: "Which matched payouts are ready to create, and what will each deposit total?",
    });
  }
  if (needsReview > 0) {
    out.push({
      tone: "watch",
      text: `${needsReview} ${plural(needsReview, "payout")} need review — the amounts don't tie yet.`,
      prompt: "Why are these payouts flagged needs-review, and what's the delta on each?",
    });
  }
  return rank(out);
}

async function checkInsights(): Promise<PalInsight[]> {
  const [needsReview, mappings] = await Promise.all([
    prisma.chkCheck.count({ where: { status: "needs_review" } }),
    prisma.chkPayeeMapping.count(),
  ]);
  const out: PalInsight[] = [];
  if (needsReview > 0) {
    out.push({
      tone: "watch",
      text: `${needsReview} ${plural(needsReview, "check")} need review before they post to QBO.`,
      prompt: "Which checks need review and what did vision read for each?",
    });
  }
  if (mappings > 0) {
    out.push({
      tone: "info",
      text: `${mappings} learned payee ${plural(mappings, "mapping")} pre-fill repeat payees.`,
      prompt: "List the learned payee-to-category mappings.",
    });
  }
  return rank(out);
}
