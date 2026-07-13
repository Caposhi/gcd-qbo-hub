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
