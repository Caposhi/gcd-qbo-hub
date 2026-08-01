"use server";

/**
 * Server action for the Tekmetric Operations module (read-only integration).
 *
 * The only mutation this module performs is refreshing the `tek_snapshot`
 * cache from the live Tekmetric API. It is gated server-side by
 * `requirePermission("refresh_tekmetric")` (§14, §18) — never trust the client.
 * The Tekmetric API itself is only ever read from; no write endpoint is called.
 *
 * A failed refresh (e.g. a Tekmetric API error) must never crash the page: we
 * catch it and redirect back with an `?error=` message the page renders as a
 * notice, leaving any previously cached snapshot intact.
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/session";
import { refreshOperations } from "@/lib/tekmetric/snapshot";
import {
  comparisonRange,
  presetRange,
  shopToday,
  type ComparisonMode,
  type DatePreset,
} from "@/lib/tekmetric/periods";

export async function refreshTekmetricAction(formData: FormData) {
  await requirePermission("refresh_tekmetric");

  const preset = (String(formData.get("preset") ?? "last_month") || "last_month") as DatePreset;
  const comparison = (String(formData.get("comparison") ?? "prior_period") || "prior_period") as ComparisonMode;

  const period = presetRange(preset, shopToday());
  const prior = comparisonRange(period, comparison);
  const params = new URLSearchParams({ preset, comparison });

  try {
    await refreshOperations(period, comparison, prior);
  } catch (err) {
    // Surface the failure as a notice instead of crashing the page; the
    // redirect() below throws NEXT_REDIRECT which propagates out as a redirect.
    const msg = err instanceof Error ? err.message : "Refresh failed.";
    params.set("error", msg.slice(0, 300));
    redirect(`/tekmetric?${params.toString()}`);
  }

  revalidatePath("/tekmetric");
  redirect(`/tekmetric?${params.toString()}`);
}
