/**
 * Orchestration logic (AI C-suite, Phase 3) — pure.
 *
 * The IO-free decisions the orchestrator relies on: which prior month to run,
 * how to render the shared monthly context that gets prompt-cached, and — most
 * importantly — the FIREWALL that decides which peer outputs each persona is
 * allowed to see. Keeping the firewall here (pure + tested) means the
 * independence of Al and the Board is a verifiable property, not a convention.
 *
 * IO-free and unit-tested (§20). The API calls live in orchestrator.ts.
 */
import type { Persona } from "./personas";
import type { AgentInsight } from "./insights";

export interface MonthRange {
  start: string; // YYYY-MM-DD
  end: string;
  label: string; // e.g. "Jun 2026"
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The prior full calendar month relative to `now` (the monthly cron runs on the 1st). */
export function priorMonthRange(now: Date): MonthRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const py = m === 0 ? y - 1 : y;
  const pm = m === 0 ? 11 : m - 1;
  const pad = (x: number) => String(x).padStart(2, "0");
  const lastDay = new Date(Date.UTC(py, pm + 1, 0)).getUTCDate();
  return {
    start: `${py}-${pad(pm + 1)}-01`,
    end: `${py}-${pad(pm + 1)}-${pad(lastDay)}`,
    label: `${MONTHS[pm]} ${py}`,
  };
}

export interface MonthlyKpi {
  label: string;
  value: string; // pre-formatted
  deltaPct: number | null;
  deltaAbs: string;
  sentiment: "good" | "bad" | "neutral";
}

/** The shared monthly data context — the single cached baseline all agents read. */
export interface MonthlyContext {
  month: MonthRange;
  method: string;
  /** The period the KPI deltas are measured against, e.g. "May 2026 (…→…)". */
  comparisonLabel?: string;
  kpis: MonthlyKpi[];
  trend: Array<{ period: string; revenue: number; netIncome: number }>;
  arTotal: number;
  apTotal: number;
  topCustomers: Array<{ name: string; amount: number }>;
  topItems: Array<{ name: string; amount: number }>;
  expenseBreakdown: Array<{ name: string; amount: number }>;
  baseline: null | {
    months: number;
    revenueGrowthMonthlyPct: number;
    cogsPctOfRevenue: number;
    grossMarginPct: number;
    netMarginPct: number;
    partsPctOfRevenue: number | null;
    laborPctOfRevenue: number | null;
  };
  /** Operational data from Tekmetric for the same month, when available. */
  ops: null | {
    kpis: {
      roCount: number;
      aro: number;
      grossProfit: number;
      grossMarginPct: number;
      carCount: number;
    };
    utilization: Array<{
      tech: string;
      utilizationPct: number;
      billedHours: number;
      effectiveLaborRate: number;
      postedLaborRate: number;
    }>;
    revenueByMake: Array<{ make: string; revenue: number; grossMarginPct: number; roCount: number }>;
    advisors: Array<{ advisor: string; roCount: number; totalSales: number; grossMarginPct: number }>;
  };
  /** Aggregated customer-call insights from the transcript service, when available. */
  transcripts: null | {
    totalInbound: number;
    transcripts: number;
    analyzedPct: number;
    topKeywords: Array<{ keyword: string; mentions: number; calls: number }>;
    negativeSamples: string[];
  };
}

function money(v: number): string {
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * Render the shared context as a compact, deterministic text block. Deterministic
 * ordering matters: this string is prompt-cached across every agent turn, so it
 * must be byte-identical each time it's built for a given month.
 */
export function renderContext(ctx: MonthlyContext): string {
  const lines: string[] = [];
  lines.push(`GERMAN CAR DEPOT — shared monthly data context`);
  lines.push(`Month: ${ctx.month.label} (${ctx.month.start} → ${ctx.month.end}), accounting method: ${ctx.method}`);
  if (ctx.comparisonLabel) lines.push(`Deltas (Δ) are measured against: ${ctx.comparisonLabel}`);
  lines.push("");
  lines.push(
    `KEY PERFORMANCE INDICATORS (figure — Δ vs ${ctx.comparisonLabel ?? "the prior comparison period"}):`
  );
  for (const k of ctx.kpis) {
    const d = k.deltaPct === null ? "n/a" : pct(k.deltaPct);
    lines.push(`  - ${k.label}: ${k.value} (Δ ${d} / ${k.deltaAbs}, ${k.sentiment})`);
  }
  lines.push("");
  lines.push(`A/R total: ${money(ctx.arTotal)} · A/P total: ${money(ctx.apTotal)}`);
  lines.push("");
  lines.push("REVENUE & NET INCOME TREND:");
  for (const t of ctx.trend) {
    lines.push(`  - ${t.period}: revenue ${money(t.revenue)}, net income ${money(t.netIncome)}`);
  }
  lines.push("");
  lines.push("TOP CUSTOMERS (by revenue):");
  for (const c of ctx.topCustomers) lines.push(`  - ${c.name}: ${money(c.amount)}`);
  lines.push("");
  lines.push("REVENUE BY SERVICE / PRODUCT:");
  for (const i of ctx.topItems) lines.push(`  - ${i.name}: ${money(i.amount)}`);
  lines.push("");
  lines.push("OPERATING EXPENSE BREAKDOWN:");
  for (const e of ctx.expenseBreakdown) lines.push(`  - ${e.name}: ${money(e.amount)}`);
  if (ctx.baseline) {
    const b = ctx.baseline;
    lines.push("");
    lines.push(`DERIVED BASELINE (from ${b.months} months of history):`);
    lines.push(`  - monthly revenue growth: ${pct(b.revenueGrowthMonthlyPct)}`);
    lines.push(`  - COGS % of revenue: ${pct(b.cogsPctOfRevenue)}`);
    lines.push(`  - gross margin: ${pct(b.grossMarginPct)} · net margin: ${pct(b.netMarginPct)}`);
    if (b.partsPctOfRevenue !== null && b.laborPctOfRevenue !== null) {
      lines.push(`  - parts/labor mix: ${pct(b.partsPctOfRevenue)} / ${pct(b.laborPctOfRevenue)}`);
    }
  }
  if (ctx.ops) {
    const o = ctx.ops;
    lines.push("");
    lines.push("OPERATIONS (Tekmetric — shop-management actuals for the month):");
    lines.push(
      `  KPIs: ${o.kpis.roCount} ROs · car count ${o.kpis.carCount} · ARO ${money(o.kpis.aro)} · gross profit ${money(o.kpis.grossProfit)} · gross margin ${pct(o.kpis.grossMarginPct / 100)}`
    );
    if (o.utilization.length) {
      lines.push("  Technician utilization (billed÷available; effective vs posted labor rate):");
      for (const u of o.utilization) {
        lines.push(
          `    - ${u.tech}: ${u.utilizationPct.toFixed(0)}% util, ${u.billedHours.toFixed(1)}h billed, eff $${u.effectiveLaborRate.toFixed(0)}/h vs posted $${u.postedLaborRate.toFixed(0)}/h`
        );
      }
    }
    if (o.revenueByMake.length) {
      lines.push("  Revenue by make:");
      for (const m of o.revenueByMake) {
        lines.push(`    - ${m.make}: ${money(m.revenue)} (${m.roCount} ROs, ${m.grossMarginPct.toFixed(0)}% margin)`);
      }
    }
    if (o.advisors.length) {
      lines.push("  Service advisors:");
      for (const a of o.advisors) {
        lines.push(`    - ${a.advisor}: ${a.roCount} ROs, ${money(a.totalSales)} sales, ${a.grossMarginPct.toFixed(0)}% margin`);
      }
    }
  }
  if (ctx.transcripts) {
    const t = ctx.transcripts;
    lines.push("");
    lines.push("CUSTOMER CALLS (transcript service — aggregated, not raw calls):");
    lines.push(
      `  ${t.totalInbound} inbound calls · ${t.transcripts} transcribed · ${t.analyzedPct}% AI-analyzed`
    );
    if (t.topKeywords.length) {
      lines.push(
        `  Top call topics: ${t.topKeywords.map((k) => `${k.keyword} (${k.calls} calls)`).join(", ")}`
      );
    }
    if (t.negativeSamples.length) {
      lines.push("  Sample of negative-sentiment calls (AI summaries; a sample, not a full count):");
      for (const s of t.negativeSamples) lines.push(`    - ${s}`);
    }
  }
  return lines.join("\n");
}

/** A completed officer report, tagged with who produced it. */
export interface OfficerReport {
  personaId: string;
  personaName: string;
  insight: AgentInsight;
}

export type Phase = "first_pass" | "debate" | "synthesis" | "audit" | "board";

/**
 * THE FIREWALL. Given a persona, the current phase, and all officer reports so
 * far, return the peer reports this persona is permitted to see.
 *
 *  - officer, first_pass: sees nothing (independent first draft).
 *  - officer, debate/synthesis: sees the OTHER officers' reports (never its own,
 *    to avoid echo).
 *  - auditor: sees NOTHING — Al works only from raw data, never officer analysis.
 *  - board: sees ALL finished officer reports (audit report is passed separately).
 */
export function visiblePeers(
  persona: Persona,
  phase: Phase,
  officerReports: OfficerReport[]
): OfficerReport[] {
  if (persona.layer === "auditor") return [];
  if (persona.layer === "board") return officerReports;
  // officer
  if (phase === "first_pass") return [];
  return officerReports.filter((r) => r.personaId !== persona.id);
}

/** Structural assertion used in tests: the auditor is never fed officer analysis. */
export function auditorIsFirewalled(persona: Persona, phase: Phase, reports: OfficerReport[]): boolean {
  return persona.layer !== "auditor" || visiblePeers(persona, phase, reports).length === 0;
}
