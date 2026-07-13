"use server";

/**
 * AI council server actions (Phase 3). Both are gated by `run_ai_council` — only
 * an owner can spend tokens. Read-only over QBO; the orchestrator enforces the
 * $15 budget cap on a full run.
 */
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { runCouncil, runSingleAgent } from "@/lib/ai/orchestrator";
import { getPersona } from "@/lib/ai/personas";

/** Run a cheap single-officer analysis against the latest cached baseline. */
export async function runOnDemandAgentAction(formData: FormData) {
  const user = await requirePermission("run_ai_council");
  const personaId = String(formData.get("personaId") ?? "");
  const persona = getPersona(personaId);
  if (!persona) throw new Error(`Unknown persona: ${personaId}`);
  if (persona.layer === "board") {
    throw new Error("The Board only convenes over a full monthly run.");
  }
  await runSingleAgent({ personaId, persona, now: new Date(), createdByEmail: user.email });
  revalidatePath("/projections");
}

/** Trigger a full monthly council meeting on demand (same path as the cron). */
export async function runMonthlyCouncilAction() {
  const user = await requirePermission("run_ai_council");
  await runCouncil({ now: new Date(), kind: "monthly", createdByEmail: user.email });
  revalidatePath("/projections");
}
