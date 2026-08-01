/**
 * Projection scenario model (v2, Phase 2) — pure.
 *
 * A saved scenario persists BOTH the regression-derived defaults and the user's
 * overrides (locked decision), plus any step changes (hiring, expansion, capex).
 * `parseScenarioV2` validates/coerces stored JSON on read — mirroring
 * `parseAssumptions` — so a malformed or partial row can never crash the page.
 * `inputsFromBaseline` seeds a fresh scenario's defaults from a `DerivedBaseline`.
 *
 * IO-free (§20).
 */
import type { DerivedBaseline } from "./regression/baseline";
import type {
  ProjectionInputsV2,
  HybridCoefficient,
  CoefficientSet,
  StepChange,
} from "./engine-v2";
import { HORIZON_MAX, HORIZON_MIN } from "./engine-v2";

/** Stored scenario blob (assumptionsJson) — the engine inputs plus metadata. */
export interface StoredScenarioV2 extends ProjectionInputsV2 {
  version: 2;
  scenarioType: string;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function num(v: unknown, fallback = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = num(v, NaN);
  return Number.isFinite(n) ? n : null;
}
function clampHorizon(n: number): number {
  const i = Math.floor(n);
  return i < HORIZON_MIN ? HORIZON_MIN : i > HORIZON_MAX ? HORIZON_MAX : i;
}

function coef(v: unknown): HybridCoefficient {
  const o = obj(v);
  return {
    derived: num(o.derived),
    override: numOrNull(o.override),
    r2: typeof o.r2 === "number" ? o.r2 : undefined,
    n: typeof o.n === "number" ? o.n : undefined,
  };
}

function steps(v: unknown): StepChange[] {
  return (Array.isArray(v) ? v : [])
    .map((s) => {
      const o = obj(s);
      const monthIndex = num(o.monthIndex, NaN);
      const amount = num(o.amount, NaN);
      if (!Number.isFinite(monthIndex) || !Number.isFinite(amount)) return null;
      return {
        monthIndex: Math.floor(monthIndex),
        amount,
        label: typeof o.label === "string" ? o.label : "",
      };
    })
    .filter((s): s is StepChange => s !== null);
}

/** Validate/coerce a stored scenario blob into safe engine inputs. Never throws. */
export function parseScenarioV2(json: unknown): StoredScenarioV2 {
  const o = obj(json);
  const c = obj(o.coefficients);
  const coefficients: CoefficientSet = {
    revenueGrowthMonthlyPct: coef(c.revenueGrowthMonthlyPct),
    cogsPctOfRevenue: coef(c.cogsPctOfRevenue),
    opexFixedMonthly: coef(c.opexFixedMonthly),
    opexVarPctOfRevenue: coef(c.opexVarPctOfRevenue),
  };
  return {
    version: 2,
    scenarioType: typeof o.scenarioType === "string" ? o.scenarioType : "custom",
    openingCash: num(o.openingCash),
    startMonthlyRevenue: num(o.startMonthlyRevenue),
    horizonMonths: clampHorizon(num(o.horizonMonths, 12)),
    startLabel: typeof o.startLabel === "string" ? o.startLabel : "",
    coefficients,
    oneOffs: steps(o.oneOffs),
    opexAdjustments: steps(o.opexAdjustments),
    revenueUpliftPct: steps(o.revenueUpliftPct),
  };
}

/** True when the stored blob is a v2 scenario (vs. the v1 prototype shape). */
export function isScenarioV2(json: unknown): boolean {
  return obj(json).version === 2;
}

export interface SeedOptions {
  scenarioType?: string;
  horizonMonths?: number;
  openingCash?: number;
  startLabel?: string;
}

/** Build a fresh scenario from a derived baseline, with no overrides yet. */
export function inputsFromBaseline(
  baseline: DerivedBaseline,
  opts: SeedOptions = {}
): StoredScenarioV2 {
  const mk = (value: number, r2?: number, n?: number): HybridCoefficient => ({
    derived: value,
    override: null,
    r2,
    n,
  });
  return {
    version: 2,
    scenarioType: opts.scenarioType ?? "runway",
    openingCash: opts.openingCash ?? 0,
    startMonthlyRevenue: baseline.latestMonthlyRevenue || baseline.avgMonthlyRevenue,
    horizonMonths: clampHorizon(opts.horizonMonths ?? 12),
    startLabel: opts.startLabel ?? "",
    coefficients: {
      revenueGrowthMonthlyPct: mk(
        baseline.revenueGrowthMonthlyPct.value,
        baseline.revenueGrowthMonthlyPct.r2,
        baseline.revenueGrowthMonthlyPct.n
      ),
      cogsPctOfRevenue: mk(
        baseline.cogsPctOfRevenue.value,
        baseline.cogsPctOfRevenue.r2,
        baseline.cogsPctOfRevenue.n
      ),
      opexFixedMonthly: mk(
        baseline.opexFixedMonthly.value,
        baseline.opexFixedMonthly.r2,
        baseline.opexFixedMonthly.n
      ),
      opexVarPctOfRevenue: mk(
        baseline.opexVarPctOfRevenue.value,
        baseline.opexVarPctOfRevenue.r2,
        baseline.opexVarPctOfRevenue.n
      ),
    },
    oneOffs: [],
    opexAdjustments: [],
    revenueUpliftPct: [],
  };
}
