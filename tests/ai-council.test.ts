import { describe, it, expect } from "vitest";
import {
  costOf,
  BudgetTracker,
  MONTHLY_CAP_USD,
  PRICING,
} from "@/lib/ai/budget";
import {
  parseInsight,
  parseBoardReport,
  INSIGHT_SCHEMA,
  BOARD_SCHEMA,
} from "@/lib/ai/insights";
import {
  PERSONAS,
  officers,
  debatingOfficers,
  ceo,
  auditor,
  board,
} from "@/lib/ai/personas";
import {
  priorMonthRange,
  renderContext,
  visiblePeers,
  auditorIsFirewalled,
  type MonthlyContext,
  type OfficerReport,
} from "@/lib/ai/orchestration";

describe("budget — cost accounting", () => {
  it("prices an Opus 4.8 turn from token usage", () => {
    const usd = costOf({ inputTokens: 1000, outputTokens: 1000 });
    // (1000*5 + 1000*25)/1e6 = 0.03
    expect(usd).toBeCloseTo(0.03, 6);
  });

  it("charges cache reads/writes at their discounted rates", () => {
    const usd = costOf({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 });
    expect(usd).toBeCloseTo(PRICING.cacheReadPerM, 6);
  });

  it("halves cost for Batch API turns", () => {
    const sync = costOf({ inputTokens: 1000, outputTokens: 1000 });
    const batch = costOf({ inputTokens: 1000, outputTokens: 1000 }, { batch: true });
    expect(batch).toBeCloseTo(sync / 2, 6);
  });
});

describe("budget — $15 circuit breaker", () => {
  it("tracks spend and remaining against the cap", () => {
    const b = new BudgetTracker(MONTHLY_CAP_USD);
    b.record("t1", { inputTokens: 0, outputTokens: 200_000 }); // $5
    expect(b.spentUsd()).toBeCloseTo(5, 4);
    expect(b.remainingUsd()).toBeCloseTo(10, 4);
    expect(b.turnCount()).toBe(1);
  });

  it("stops adding rounds when a round + reserved synthesis would exceed the cap", () => {
    const b = new BudgetTracker(15);
    b.record("spent", { inputTokens: 0, outputTokens: 400_000 }); // $10
    // Another round est $4 + reserve $2 = $16 total > $15 → stop
    expect(b.shouldStopRounds(4, 2)).toBe(true);
    // A cheap round $1 + reserve $1 = $12 ≤ $15 → continue
    expect(b.shouldStopRounds(1, 1)).toBe(false);
  });

  it("stops once spend has reached the cap regardless of estimate", () => {
    const b = new BudgetTracker(15);
    b.record("spent", { inputTokens: 0, outputTokens: 600_000 }); // $15
    expect(b.shouldStopRounds(0, 0)).toBe(true);
  });
});

describe("insights — validation (never throws)", () => {
  it("clamps bullets to 2–4 and coerces confidence", () => {
    const i = parseInsight({
      takeaway: "Revenue up",
      bullets: ["a", "b", "c", "d", "e", "f"],
      memo: "…",
      confidence: "bogus",
      references: [{ report: "P&L Jun 2026", note: "revenue $39k" }],
    });
    expect(i.bullets).toHaveLength(4);
    expect(i.confidence).toBe("medium");
    expect(i.references[0].report).toBe("P&L Jun 2026");
  });

  it("produces a safe empty insight from garbage", () => {
    const i = parseInsight("nonsense");
    expect(i.takeaway).toBe("(no takeaway)");
    expect(i.bullets).toEqual([]);
    expect(i.references).toEqual([]);
  });

  it("validates a board report and drops empty sections", () => {
    const b = parseBoardReport({
      takeaway: "Hold course",
      longForm: "…",
      sections: [{ heading: "Liquidity", body: "ok" }, {}, "junk"],
      concerns: ["DSO creeping", ""],
      endorsements: ["marketing ROI"],
    });
    expect(b.sections).toHaveLength(1);
    expect(b.concerns).toEqual(["DSO creeping"]);
    expect(b.endorsements).toEqual(["marketing ROI"]);
  });

  it("schemas are well-formed structured-output objects", () => {
    expect(INSIGHT_SCHEMA.required).toContain("takeaway");
    expect(INSIGHT_SCHEMA.additionalProperties).toBe(false);
    expect(BOARD_SCHEMA.required).toContain("longForm");
  });
});

describe("personas — team shape", () => {
  it("has six debating officers plus a CEO synthesizer, in order", () => {
    const debate = debatingOfficers();
    expect(debate.map((p) => p.id)).toEqual(["cmo", "pacman", "cam", "coo", "data_analyst", "cro"]);
    expect(ceo().synthesizer).toBe(true);
    // CEO is last among officers.
    expect(officers()[officers().length - 1].id).toBe("ceo");
  });

  it("Al and the Board are the independent layer", () => {
    expect(auditor().layer).toBe("auditor");
    expect(board().layer).toBe("board");
    // Every persona has a non-empty system prompt.
    expect(PERSONAS.every((p) => p.systemPrompt.length > 50)).toBe(true);
  });
});

describe("orchestration — prior month + context", () => {
  it("computes the prior full calendar month, crossing year boundaries", () => {
    expect(priorMonthRange(new Date(Date.UTC(2026, 6, 1)))).toEqual({
      start: "2026-06-01",
      end: "2026-06-30",
      label: "Jun 2026",
    });
    expect(priorMonthRange(new Date(Date.UTC(2026, 0, 15)))).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
      label: "Dec 2025",
    });
  });

  it("renders a deterministic context string (stable for caching)", () => {
    const ctx: MonthlyContext = {
      month: { start: "2026-06-01", end: "2026-06-30", label: "Jun 2026" },
      method: "accrual",
      kpis: [
        { label: "Total Revenue", value: "$39,000", deltaPct: 0.1, deltaAbs: "$3,500", sentiment: "good" },
      ],
      trend: [{ period: "Jun 2026", revenue: 39000, netIncome: 12000 }],
      arTotal: 4000,
      apTotal: 8000,
      topCustomers: [{ name: "Acme", amount: 20000 }],
      topItems: [{ name: "Labor", amount: 22000 }],
      expenseBreakdown: [{ name: "Wages", amount: 12500 }],
      baseline: {
        months: 24,
        revenueGrowthMonthlyPct: 0.02,
        cogsPctOfRevenue: 0.4,
        grossMarginPct: 0.6,
        netMarginPct: 0.3,
        partsPctOfRevenue: 0.4,
        laborPctOfRevenue: 0.6,
      },
      ops: null,
      transcripts: null,
    };
    const a = renderContext(ctx);
    const b = renderContext(ctx);
    expect(a).toBe(b); // deterministic
    expect(a).toContain("Total Revenue: $39,000");
    expect(a).toContain("DERIVED BASELINE");
    // No Tekmetric / transcript snapshots → those sections are absent.
    expect(a).not.toContain("OPERATIONS (Tekmetric");
    expect(a).not.toContain("CUSTOMER CALLS");
  });

  it("names the comparison period the deltas are measured against", () => {
    const ctx: MonthlyContext = {
      month: { start: "2026-06-01", end: "2026-06-30", label: "Jun 2026" },
      method: "accrual",
      comparisonLabel: "May 2026 (2026-05-01 → 2026-05-31)",
      kpis: [{ label: "Net Income", value: "$17,346", deltaPct: -0.53, deltaAbs: "-$19,000", sentiment: "bad" }],
      trend: [],
      arTotal: 0,
      apTotal: 0,
      topCustomers: [],
      topItems: [],
      expenseBreakdown: [],
      baseline: null,
      ops: null,
      transcripts: null,
    };
    const out = renderContext(ctx);
    expect(out).toContain("May 2026 (2026-05-01 → 2026-05-31)");
    expect(out).toContain("measured against: May 2026");
    // No longer the vague "vs comparison period" with no period named.
    expect(out).not.toContain("Δ vs comparison period)");
  });

  it("renders the OPERATIONS (Tekmetric) section when ops data is present", () => {
    const ctx: MonthlyContext = {
      month: { start: "2026-06-01", end: "2026-06-30", label: "Jun 2026" },
      method: "accrual",
      kpis: [],
      trend: [],
      arTotal: 0,
      apTotal: 0,
      topCustomers: [],
      topItems: [],
      expenseBreakdown: [],
      baseline: null,
      ops: {
        kpis: { roCount: 120, aro: 640, grossProfit: 42000, grossMarginPct: 55, carCount: 98 },
        utilization: [
          { tech: "Hans", utilizationPct: 82, billedHours: 132, effectiveLaborRate: 118, postedLaborRate: 135 },
        ],
        revenueByMake: [{ make: "BMW", revenue: 41000, grossMarginPct: 57, roCount: 62 }],
        advisors: [{ advisor: "Dana", roCount: 70, totalSales: 48000, grossMarginPct: 54 }],
      },
      transcripts: {
        totalInbound: 500,
        transcripts: 410,
        analyzedPct: 95,
        topKeywords: [{ keyword: "warranty", mentions: 30, calls: 22 }],
        negativeSamples: ["Caller upset about a repeat oil leak after service."],
      },
    };
    const out = renderContext(ctx);
    expect(out).toContain("OPERATIONS (Tekmetric");
    expect(out).toContain("Hans");
    expect(out).toContain("BMW");
    expect(out).toContain("Dana");
    expect(out).toContain("CUSTOMER CALLS");
    expect(out).toContain("warranty");
    expect(out).toContain("repeat oil leak");
  });
});

describe("orchestration — the firewall", () => {
  const reports: OfficerReport[] = debatingOfficers().map((p) => ({
    personaId: p.id,
    personaName: p.name,
    insight: parseInsight({ takeaway: `${p.name} view`, bullets: ["x"], memo: "", confidence: "medium", references: [] }),
  }));

  it("officers see no peers on the first pass", () => {
    const cmo = debatingOfficers()[0];
    expect(visiblePeers(cmo, "first_pass", reports)).toEqual([]);
  });

  it("officers see the OTHER officers (not themselves) during debate", () => {
    const cmo = debatingOfficers()[0];
    const peers = visiblePeers(cmo, "debate", reports);
    expect(peers.some((r) => r.personaId === cmo.id)).toBe(false);
    expect(peers).toHaveLength(reports.length - 1);
  });

  it("the auditor is NEVER fed officer analysis, in any phase", () => {
    const al = auditor();
    for (const phase of ["first_pass", "debate", "synthesis", "audit", "board"] as const) {
      expect(visiblePeers(al, phase, reports)).toEqual([]);
      expect(auditorIsFirewalled(al, phase, reports)).toBe(true);
    }
  });

  it("the board sees all finished officer reports", () => {
    expect(visiblePeers(board(), "board", reports)).toHaveLength(reports.length);
  });
});
