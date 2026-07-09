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
