"use server";

/**
 * Server actions for the Financial Projections module (prototype).
 *
 * Mutating actions are gated server-side by role (§14, §18): only holders of
 * `edit_projections` may create, update, or delete scenarios. Assumptions are
 * always run through `parseAssumptions` so a malformed form submission can
 * never persist unsafe values that would later crash the projection engine.
 */
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth/session";
import { parseAssumptions, type ProjectionAssumptions } from "@/lib/projections/engine";
import { loadReporting, type ReportFilters } from "@/lib/projections/report-service";
import {
  isRangePreset,
  isComparisonMode,
  isAccountingMethod,
} from "@/lib/projections/reports";
import { loadBaseline } from "@/lib/projections/baseline-service";
import {
  parseScenarioV2,
  inputsFromBaseline,
  type StoredScenarioV2,
} from "@/lib/projections/scenario";
import { getTemplate } from "@/lib/projections/scenarios";
import type { StepChange } from "@/lib/projections/engine-v2";

function assumptionsFromForm(formData: FormData): ProjectionAssumptions {
  return parseAssumptions({
    openingBalance: formData.get("openingBalance"),
    horizonMonths: formData.get("horizonMonths"),
    monthlyInflow: formData.get("monthlyInflow"),
    monthlyOutflow: formData.get("monthlyOutflow"),
    monthlyGrowthPct: formData.get("monthlyGrowthPct"),
    startLabel: formData.get("startLabel"),
  });
}

export async function createScenarioAction(formData: FormData) {
  const user = await requirePermission("edit_projections");
  const name = String(formData.get("name") ?? "").trim() || "Untitled scenario";
  const description = String(formData.get("description") ?? "").trim() || null;
  const assumptions = assumptionsFromForm(formData);

  await prisma.projScenario.create({
    data: {
      name,
      description,
      createdByEmail: user.email,
      assumptionsJson: assumptions as unknown as Prisma.InputJsonValue,
      active: true,
    },
  });
  revalidatePath("/projections");
}

export async function updateScenarioAction(formData: FormData) {
  await requirePermission("edit_projections");
  const id = String(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim() || "Untitled scenario";
  const description = String(formData.get("description") ?? "").trim() || null;
  const active = formData.get("active") === "on";
  const assumptions = assumptionsFromForm(formData);

  await prisma.projScenario.update({
    where: { id },
    data: {
      name,
      description,
      active,
      assumptionsJson: assumptions as unknown as Prisma.InputJsonValue,
    },
  });
  revalidatePath("/projections");
}

export async function deleteScenarioAction(id: string) {
  await requirePermission("edit_projections");
  await prisma.projScenario.delete({ where: { id } });
  revalidatePath("/projections");
}

/**
 * Force a re-fetch of the report snapshots powering the active filters, then
 * revalidate the page. Gated by `view_projections` (portal is full-view users
 * only). Reads live from the read-only QBO Reports API — it never writes to QBO.
 * Filters arrive as hidden fields mirroring the current URL so the same range /
 * comparison / method is refreshed.
 */
export async function refreshReportSnapshotsAction(formData: FormData) {
  await requirePermission("view_projections");

  const presetRaw = String(formData.get("preset") ?? "");
  const cmpRaw = String(formData.get("cmp") ?? "");
  const methodRaw = String(formData.get("method") ?? "");
  const granRaw = String(formData.get("gran") ?? "");

  const filters: ReportFilters = {
    preset: isRangePreset(presetRaw) ? presetRaw : "this_month",
    comparison: isComparisonMode(cmpRaw) ? cmpRaw : "prior_period",
    method: isAccountingMethod(methodRaw) ? methodRaw : "accrual",
    granularity: granRaw === "quarter" || granRaw === "year" ? granRaw : "month",
    customStart: String(formData.get("start") ?? "") || undefined,
    customEnd: String(formData.get("end") ?? "") || undefined,
  };

  // Best-effort: if QBO is unreachable we still revalidate so the page reflects
  // whatever cache exists rather than surfacing an error to the user.
  try {
    await loadReporting(filters, new Date(), { forceRefresh: true });
  } catch {
    // swallow — the page will render its "not connected" / stale state
  }
  revalidatePath("/projections");
}

// ── Projections engine v2 (Phase 2) ─────────────────────────────────────────

function numField(fd: FormData, name: string, fallback = 0): number {
  const raw = String(fd.get(name) ?? "").trim();
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
/** Empty → null (use derived); otherwise the parsed override. */
function overrideField(fd: FormData, name: string): number | null {
  const raw = String(fd.get(name) ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
/** A single step change from an amount+month pair, or [] when no amount given. */
function stepField(fd: FormData, amountName: string, monthName: string, label: string): StepChange[] {
  const raw = String(fd.get(amountName) ?? "").trim();
  if (raw === "") return [];
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount === 0) return [];
  const monthIndex = Math.max(0, Math.floor(numField(fd, monthName, 0)));
  return [{ monthIndex, amount, label }];
}

/**
 * Create a v2 scenario from a library template, seeding its editable defaults
 * from the regression-derived baseline (persists derived values + empty
 * overrides). Gated by `edit_projections`.
 */
export async function createScenarioV2Action(formData: FormData) {
  const user = await requirePermission("edit_projections");
  const templateId = String(formData.get("templateId") ?? "runway");
  const template = getTemplate(templateId);
  if (!template || template.status !== "available") {
    throw new Error(`Unknown or unavailable scenario template: ${templateId}`);
  }

  const baselineRes = await loadBaseline(new Date(), { months: 24 });
  if (!baselineRes.connected) {
    throw new Error("Cannot derive a baseline: QuickBooks is not connected.");
  }

  const seeded = inputsFromBaseline(baselineRes.baseline, {
    ...template.seed,
    openingCash: baselineRes.baseline.avgMonthlyRevenue * 0, // start at 0 until the user sets it
  });
  const name =
    String(formData.get("name") ?? "").trim() || `${template.name} — ${baselineRes.range.end}`;

  await prisma.projScenario.create({
    data: {
      name,
      description: template.description,
      createdByEmail: user.email,
      assumptionsJson: seeded as unknown as Prisma.InputJsonValue,
      active: true,
    },
  });
  revalidatePath("/projections");
}

/**
 * Update a v2 scenario's overrides, horizon, opening cash, start revenue, and
 * step changes (capex one-off, recurring OpEx adjustment, revenue uplift). The
 * regression-derived defaults are preserved; only overrides change. Gated by
 * `edit_projections`.
 */
export async function updateScenarioV2Action(formData: FormData) {
  await requirePermission("edit_projections");
  const id = String(formData.get("id"));
  const existing = await prisma.projScenario.findUnique({ where: { id } });
  if (!existing) throw new Error("Scenario not found");

  const prev = parseScenarioV2(existing.assumptionsJson);
  const c = prev.coefficients;

  const next: StoredScenarioV2 = {
    ...prev,
    openingCash: numField(formData, "openingCash", prev.openingCash),
    startMonthlyRevenue: numField(formData, "startMonthlyRevenue", prev.startMonthlyRevenue),
    horizonMonths: Math.max(1, Math.min(120, numField(formData, "horizonMonths", prev.horizonMonths))),
    coefficients: {
      revenueGrowthMonthlyPct: { ...c.revenueGrowthMonthlyPct, override: overrideField(formData, "override_growth") },
      cogsPctOfRevenue: { ...c.cogsPctOfRevenue, override: overrideField(formData, "override_cogs") },
      opexFixedMonthly: { ...c.opexFixedMonthly, override: overrideField(formData, "override_opexFixed") },
      opexVarPctOfRevenue: { ...c.opexVarPctOfRevenue, override: overrideField(formData, "override_opexVar") },
    },
    oneOffs: stepField(formData, "capex_amount", "capex_month", "Capital / one-off"),
    opexAdjustments: stepField(formData, "opexadj_amount", "opexadj_month", "OpEx change"),
    revenueUpliftPct: stepField(formData, "uplift_pct", "uplift_month", "Revenue uplift"),
  };

  const name = String(formData.get("name") ?? "").trim() || existing.name;
  await prisma.projScenario.update({
    where: { id },
    data: { name, assumptionsJson: next as unknown as Prisma.InputJsonValue },
  });
  revalidatePath("/projections");
}
