/**
 * Scenario library (Projections, Phase 2).
 *
 * The catalogue of forward scenarios. Phase 2 ships the ones our QBO history can
 * drive on its own; the cuts that need per-technician / per-bay / per-advisor /
 * per-make operational data are declared here but marked `needs_tekmetric` so
 * they surface as "coming in Phase 4" rather than silently missing (the roadmap
 * stubs these contracts now and wires them when Tekmetric lands).
 *
 * Pure data + seed metadata (§20). Seeding a template into engine inputs is done
 * by `inputsFromBaseline` in scenario.ts.
 */
import type { SeedOptions } from "./scenario";

export type ScenarioCategory =
  | "cashflow"
  | "growth"
  | "margin"
  | "capacity"
  | "workforce"
  | "risk"
  | "succession";

export type ScenarioStatus = "available" | "needs_tekmetric";

export interface ScenarioTemplate {
  id: string;
  name: string;
  description: string;
  category: ScenarioCategory;
  dataSource: "qbo" | "tekmetric";
  status: ScenarioStatus;
  /** Default seed options when creating this scenario from the baseline. */
  seed?: SeedOptions;
  /** Which engine levers this scenario is designed to exercise (UI hint). */
  levers?: Array<"growth" | "cogs" | "opexFixed" | "opexVar" | "oneOff" | "opexStep" | "revenueStep">;
}

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  {
    id: "runway",
    name: "Cash-flow runway forecast",
    description:
      "Project cash forward from today's balance at the derived growth and cost structure — see the lowest point and whether/when cash runs out. Directly relevant to the new-building build-out and the abatement ending this month.",
    category: "cashflow",
    dataSource: "qbo",
    status: "available",
    seed: { scenarioType: "runway", horizonMonths: 18 },
    levers: ["growth", "cogs", "opexFixed", "opexVar", "oneOff"],
  },
  {
    id: "growth",
    name: "Revenue growth / decline",
    description:
      "Flex the monthly revenue growth rate around the derived trend and watch gross profit, net income, and cash respond.",
    category: "growth",
    dataSource: "qbo",
    status: "available",
    seed: { scenarioType: "growth", horizonMonths: 12 },
    levers: ["growth", "cogs"],
  },
  {
    id: "margin_mix",
    name: "Parts-margin vs. labor-margin mix",
    description:
      "Uses the parts/labor revenue split from Item Sales to test how shifting the mix and their respective margins moves overall gross profit.",
    category: "margin",
    dataSource: "qbo",
    status: "available",
    seed: { scenarioType: "margin_mix", horizonMonths: 12 },
    levers: ["cogs", "revenueStep"],
  },
  {
    id: "expansion",
    name: "Capacity / expansion / equipment",
    description:
      "Model a step up in revenue capacity plus the added fixed cost and up-front equipment spend — e.g. the added lifts in the new building.",
    category: "capacity",
    dataSource: "qbo",
    status: "available",
    seed: { scenarioType: "expansion", horizonMonths: 24 },
    levers: ["revenueStep", "opexStep", "oneOff"],
  },
  {
    id: "workforce",
    name: "Hiring / firing",
    description:
      "Add or remove monthly payroll load from a chosen month and see the effect on net income and runway.",
    category: "workforce",
    dataSource: "qbo",
    status: "available",
    seed: { scenarioType: "workforce", horizonMonths: 18 },
    levers: ["opexStep", "revenueStep"],
  },
  {
    id: "succession_buyin",
    name: "Succession buy-in cash flow",
    description:
      "Cash-flow the phased equity buy-in as scheduled one-off inflows/outflows against the operating baseline.",
    category: "succession",
    dataSource: "qbo",
    status: "available",
    seed: { scenarioType: "succession_buyin", horizonMonths: 36 },
    levers: ["oneOff", "opexStep"],
  },
  // ── Deferred to Phase 4 (need Tekmetric operational data) ──────────────────
  {
    id: "per_technician_profit",
    name: "Profitability per technician",
    description: "Requires per-tech billed vs. available hours and labor attribution from Tekmetric.",
    category: "workforce",
    dataSource: "tekmetric",
    status: "needs_tekmetric",
  },
  {
    id: "tech_utilization",
    name: "Technician utilization & effective labor rate",
    description: "Billed vs. available hours and effective vs. posted labor rate — Tekmetric time data.",
    category: "capacity",
    dataSource: "tekmetric",
    status: "needs_tekmetric",
  },
  {
    id: "per_bay_profit",
    name: "Profitability per bay",
    description: "Needs per-bay throughput from Tekmetric to allocate revenue and cost.",
    category: "capacity",
    dataSource: "tekmetric",
    status: "needs_tekmetric",
  },
  {
    id: "per_advisor",
    name: "Revenue & profit per service advisor",
    description: "Needs per-advisor sales attribution from Tekmetric.",
    category: "growth",
    dataSource: "tekmetric",
    status: "needs_tekmetric",
  },
  {
    id: "per_make",
    name: "Revenue & profit per make",
    description: "Needs vehicle-make tagging from Tekmetric repair orders.",
    category: "margin",
    dataSource: "tekmetric",
    status: "needs_tekmetric",
  },
  {
    id: "warranty_comeback",
    name: "Warranty comeback cost",
    description: "Comeback cost as % of revenue (quality signal) — needs Tekmetric comeback flags.",
    category: "risk",
    dataSource: "tekmetric",
    status: "needs_tekmetric",
  },
];

export function getTemplate(id: string): ScenarioTemplate | undefined {
  return SCENARIO_TEMPLATES.find((t) => t.id === id);
}
export function availableTemplates(): ScenarioTemplate[] {
  return SCENARIO_TEMPLATES.filter((t) => t.status === "available");
}
export function deferredTemplates(): ScenarioTemplate[] {
  return SCENARIO_TEMPLATES.filter((t) => t.status === "needs_tekmetric");
}
