/**
 * Council orchestration (AI C-suite, Phase 3) — IO.
 *
 * Runs the meeting: build the shared cached context → officers produce first-pass
 * memos (concurrent) → multi-round debate where each officer sees the others and
 * probes the weakest assumption → CEO synthesizes → the INDEPENDENT layer (Al the
 * auditor from raw data only, then the Board over the finished officer set)
 * reviews → persist. The $15 token budget is enforced in code: when another
 * debate round would risk the cap, the loop stops and forces CEO synthesis.
 *
 * The firewall (who may read whom) comes from orchestration.ts and is unit-tested
 * there; this file wires it to the API and the database.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import type { AccountingMethod } from "@/lib/projections/reports";
import { runAgentTurn, isCouncilConfigured, type Effort } from "./client";
import { BudgetTracker, MONTHLY_CAP_USD } from "./budget";
import {
  INSIGHT_SCHEMA,
  BOARD_SCHEMA,
  parseInsight,
  parseBoardReport,
  type AgentInsight,
} from "./insights";
import { debatingOfficers, ceo, auditor, board, type Persona } from "./personas";
import { buildMonthlyContext } from "./context";
import { isTekmetricConfigured } from "@/lib/tekmetric/client";
import { refreshOperations } from "@/lib/tekmetric/snapshot";
import { comparisonRange } from "@/lib/tekmetric/periods";
import {
  priorMonthRange,
  renderContext,
  visiblePeers,
  type MonthRange,
  type OfficerReport,
} from "./orchestration";

const MAX_DEBATE_ROUNDS = 2;
/** Floor estimate for a turn's cost when we have no history yet ($). */
const TURN_ESTIMATE_FLOOR = 0.05;

export interface RunCouncilOptions {
  now: Date;
  kind: "monthly" | "on_demand";
  method?: AccountingMethod;
  month?: MonthRange;
  createdByEmail?: string;
}

export interface RunCouncilResult {
  runId: string;
  status: "complete" | "failed" | "not_connected" | "not_configured";
  spentUsd: number;
}

function peerDigest(reports: OfficerReport[]): string {
  if (reports.length === 0) return "(none yet)";
  return reports
    .map((r) => `${r.personaName}: ${r.insight.takeaway}\n  - ${r.insight.bullets.join("\n  - ")}`)
    .join("\n\n");
}

function effortFor(persona: Persona): Effort {
  if (persona.synthesizer || persona.layer !== "officer") return "high";
  return "medium";
}

/**
 * Run a full monthly council meeting (or a scoped on-demand run). Never throws to
 * the caller: on any failure it records the run as failed and returns the status.
 */
export async function runCouncil(opts: RunCouncilOptions): Promise<RunCouncilResult> {
  const method: AccountingMethod = opts.method ?? "accrual";
  const month = opts.month ?? priorMonthRange(opts.now);

  const run = await prisma.aiAgentRun.create({
    data: {
      kind: opts.kind,
      monthLabel: month.label,
      periodStart: new Date(`${month.start}T00:00:00.000Z`),
      periodEnd: new Date(`${month.end}T00:00:00.000Z`),
      method,
      status: "running",
      createdByEmail: opts.createdByEmail,
    },
  });

  const finish = async (
    status: RunCouncilResult["status"],
    spentUsd: number,
    extra: { error?: string; ceoTakeaway?: string } = {}
  ): Promise<RunCouncilResult> => {
    await prisma.aiAgentRun.update({
      where: { id: run.id },
      data: { status, spentUsd, finishedAt: new Date(), ...extra },
    });
    return { runId: run.id, status, spentUsd };
  };

  if (!isCouncilConfigured()) return finish("not_configured", 0);

  try {
    // Best-effort: refresh this month's Tekmetric operations snapshot so the
    // shared context carries fresh ops actuals (utilization, revenue-by-make,
    // advisor performance). Read-only over QBO; a Tekmetric failure or missing
    // config must never block the council — the ops section just stays absent.
    if (opts.kind === "monthly" && isTekmetricConfigured()) {
      try {
        const tekPeriod = { start: month.start, end: month.end };
        await refreshOperations(tekPeriod, "prior_period", comparisonRange(tekPeriod, "prior_period"));
      } catch {
        /* ignore — ops data is optional context */
      }
    }

    const ctx = await buildMonthlyContext(month, method, opts.now);
    if (!ctx) return finish("not_connected", 0);
    const shared = renderContext(ctx);
    const budget = new BudgetTracker(MONTHLY_CAP_USD);

    const officerList = debatingOfficers();
    const perTurn = () =>
      budget.turnCount() > 0 ? budget.spentUsd() / budget.turnCount() : TURN_ESTIMATE_FLOOR;

    // ── First pass (concurrent) ──────────────────────────────────────────────
    let reports: OfficerReport[] = await Promise.all(
      officerList.map(async (p) => {
        const { data, usage } = await runAgentTurn({
          personaSystem: p.systemPrompt,
          sharedContext: shared,
          task: `This is your FIRST-PASS analysis of ${month.label}. Study the shared monthly data and produce your view as JSON matching the schema: one-line takeaway, 2–4 insight bullets each tied to a figure, an expandable memo, a confidence level, and references. Stay strictly in your lane.`,
          schema: INSIGHT_SCHEMA as unknown as Record<string, unknown>,
          effort: effortFor(p),
        });
        budget.record(`first_pass:${p.id}`, usage);
        return { personaId: p.id, personaName: p.name, insight: parseInsight(data) };
      })
    );

    // ── Debate rounds (budget-gated) ──────────────────────────────────────────
    for (let round = 0; round < MAX_DEBATE_ROUNDS; round++) {
      const estRound = perTurn() * officerList.length;
      const reserveSynthesis = perTurn() * 3; // CEO + Al + Board
      if (budget.shouldStopRounds(estRound, reserveSynthesis)) break;

      reports = await Promise.all(
        reports.map(async (rep) => {
          const persona = officerList.find((p) => p.id === rep.personaId)!;
          const peers = visiblePeers(persona, "debate", reports);
          const { data, usage } = await runAgentTurn({
            personaSystem: persona.systemPrompt,
            sharedContext: shared,
            task: `DEBATE round ${round + 1}. Your current position:\n${rep.insight.takeaway}\n\nThe other officers said:\n${peerDigest(peers)}\n\nProbe the single weakest assumption on the table (yours or a peer's). Forced agreement and forced disagreement are both failures. Revise or defend your view. Return updated JSON matching the schema.`,
            schema: INSIGHT_SCHEMA as unknown as Record<string, unknown>,
            effort: effortFor(persona),
          });
          budget.record(`debate${round + 1}:${persona.id}`, usage);
          return { personaId: persona.id, personaName: persona.name, insight: parseInsight(data) };
        })
      );
    }

    // ── CEO synthesis ─────────────────────────────────────────────────────────
    const ceoP = ceo();
    const ceoTurn = await runAgentTurn({
      personaSystem: ceoP.systemPrompt,
      sharedContext: shared,
      task: `Synthesize. The officers' final positions:\n\n${peerDigest(reports)}\n\nWeigh the tradeoffs and own ONE clear directional recommendation for ${month.label} with the 2–3 moves that matter most. Return JSON matching the schema.`,
      schema: INSIGHT_SCHEMA as unknown as Record<string, unknown>,
      effort: "high",
    });
    budget.record("synthesis:ceo", ceoTurn.usage);
    const ceoInsight = parseInsight(ceoTurn.data);
    const officerReportsFinal: OfficerReport[] = [
      ...reports,
      { personaId: ceoP.id, personaName: ceoP.name, insight: ceoInsight },
    ];

    // ── Independent layer: Al (raw data only), then the Board ─────────────────
    const alP = auditor();
    const alTurn = await runAgentTurn({
      personaSystem: alP.systemPrompt,
      sharedContext: shared,
      task: `Independent audit of ${month.label}. Working ONLY from the shared raw data (you do not see the officers' analysis), look for control/risk anomalies: unusual/round-dollar entries, aging anomalies, unreconciled or concentrated balances, period-end effects. Return JSON matching the schema — bullets are your findings; if nothing is anomalous, return an empty bullet list and say the controls looked clean for what you could see.`,
      schema: INSIGHT_SCHEMA as unknown as Record<string, unknown>,
      effort: "high",
    });
    budget.record("audit:al", alTurn.usage);
    const alInsight = parseInsight(alTurn.data);

    const boardP = board();
    const boardTurn = await runAgentTurn({
      personaSystem: boardP.systemPrompt,
      sharedContext: shared,
      task: `End-of-month governance review for ${month.label}. You see ONLY the finished officer reports and the auditor's findings.\n\nOFFICER REPORTS:\n${peerDigest(officerReportsFinal)}\n\nAUDITOR (Al) FINDINGS:\n${alInsight.takeaway}\n  - ${alInsight.bullets.join("\n  - ")}\n\nConfer with the auditor's view, give an unbiased second opinion and a governance check, and protect long-term and succession interests. Return the long-form board report as JSON matching the schema.`,
      schema: BOARD_SCHEMA as unknown as Record<string, unknown>,
      effort: "high",
    });
    budget.record("board", boardTurn.usage);
    const boardReport = parseBoardReport(boardTurn.data);

    // ── Persist ───────────────────────────────────────────────────────────────
    const allReports: Array<{ persona: Persona; insight: AgentInsight }> = [
      ...reports.map((r) => ({ persona: officerList.find((p) => p.id === r.personaId)!, insight: r.insight })),
      { persona: ceoP, insight: ceoInsight },
      { persona: alP, insight: alInsight },
    ];

    await prisma.$transaction([
      prisma.aiAgentReport.createMany({
        data: allReports.map((r) => ({
          runId: run.id,
          personaId: r.persona.id,
          personaName: r.persona.name,
          layer: r.persona.layer,
          takeaway: r.insight.takeaway,
          insightJson: r.insight as unknown as Prisma.InputJsonValue,
        })),
      }),
      prisma.aiBoardReport.create({
        data: {
          runId: run.id,
          takeaway: boardReport.takeaway,
          reportJson: boardReport as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);

    return finish("complete", budget.spentUsd(), { ceoTakeaway: ceoInsight.takeaway });
  } catch (err) {
    return finish("failed", 0, { error: String(err).slice(0, 500) });
  }
}

/**
 * Cheap on-demand run of a SINGLE officer against the latest cached baseline.
 * Persists a small `on_demand` run with one report.
 */
export async function runSingleAgent(opts: {
  personaId: string;
  persona: Persona;
  now: Date;
  method?: AccountingMethod;
  createdByEmail?: string;
}): Promise<RunCouncilResult> {
  const method: AccountingMethod = opts.method ?? "accrual";
  const month = priorMonthRange(opts.now);
  const run = await prisma.aiAgentRun.create({
    data: {
      kind: "on_demand",
      monthLabel: `${month.label} · ${opts.persona.name}`,
      periodStart: new Date(`${month.start}T00:00:00.000Z`),
      periodEnd: new Date(`${month.end}T00:00:00.000Z`),
      method,
      status: "running",
      createdByEmail: opts.createdByEmail,
    },
  });

  if (!isCouncilConfigured()) {
    await prisma.aiAgentRun.update({ where: { id: run.id }, data: { status: "not_configured", finishedAt: new Date() } });
    return { runId: run.id, status: "not_configured", spentUsd: 0 };
  }

  try {
    const ctx = await buildMonthlyContext(month, method, opts.now);
    if (!ctx) {
      await prisma.aiAgentRun.update({ where: { id: run.id }, data: { status: "not_connected", finishedAt: new Date() } });
      return { runId: run.id, status: "not_connected", spentUsd: 0 };
    }
    const shared = renderContext(ctx);
    const budget = new BudgetTracker(MONTHLY_CAP_USD);
    const { data, usage } = await runAgentTurn({
      personaSystem: opts.persona.systemPrompt,
      sharedContext: shared,
      task: `On-demand analysis of ${month.label}. Give your current read as JSON matching the schema: one-line takeaway, 2–4 bullets tied to figures, a memo, confidence, and references.`,
      schema: INSIGHT_SCHEMA as unknown as Record<string, unknown>,
      effort: effortFor(opts.persona),
    });
    budget.record(`on_demand:${opts.persona.id}`, usage);
    const insight = parseInsight(data);
    await prisma.aiAgentReport.create({
      data: {
        runId: run.id,
        personaId: opts.persona.id,
        personaName: opts.persona.name,
        layer: opts.persona.layer,
        takeaway: insight.takeaway,
        insightJson: insight as unknown as Prisma.InputJsonValue,
      },
    });
    await prisma.aiAgentRun.update({
      where: { id: run.id },
      data: { status: "complete", spentUsd: budget.spentUsd(), ceoTakeaway: insight.takeaway, finishedAt: new Date() },
    });
    return { runId: run.id, status: "complete", spentUsd: budget.spentUsd() };
  } catch (err) {
    await prisma.aiAgentRun.update({
      where: { id: run.id },
      data: { status: "failed", error: String(err).slice(0, 500), finishedAt: new Date() },
    });
    return { runId: run.id, status: "failed", spentUsd: 0 };
  }
}
