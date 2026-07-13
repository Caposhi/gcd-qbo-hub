"use server";

/**
 * Server action for the Tekmetric Operations module (read-only integration).
 *
 * The only mutation this module performs is refreshing the `tek_snapshot`
 * cache from the live Tekmetric API. It is gated server-side by
 * `requirePermission("refresh_tekmetric")` (§14, §18) — never trust the client.
 * The Tekmetric API itself is only ever read from; no write endpoint is called.
 */
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth/session";
import { refreshOperations } from "@/lib/tekmetric/snapshot";
import {
  comparisonRange,
  presetRange,
  type ComparisonMode,
  type DatePreset,
} from "@/lib/tekmetric/periods";

export async function refreshTekmetricAction(formData: FormData) {
  await requirePermission("refresh_tekmetric");

  const preset = (String(formData.get("preset") ?? "last_month") || "last_month") as DatePreset;
  const comparison = (String(formData.get("comparison") ?? "prior_period") || "prior_period") as ComparisonMode;

  const period = presetRange(preset, new Date());
  const prior = comparisonRange(period, comparison);

  await refreshOperations(period, prior);
  revalidatePath("/tekmetric");
}
