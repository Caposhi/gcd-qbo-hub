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
import { fillMissingMonths, MAX_FILL_PER_CLICK } from "@/lib/tekmetric/fill-gaps";
import {
  comparisonRange,
  monthKeyToRange,
  presetRange,
  shopToday,
  DEFAULT_COMPARISON,
  DEFAULT_PRESET,
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
    params.set("error", `Refresh failed: ${msg}`.slice(0, 300));
    redirect(`/tekmetric?${params.toString()}`);
  }

  revalidatePath("/tekmetric");
  redirect(`/tekmetric?${params.toString()}`);
}

/**
 * Fill specific missing months for a composed wide-range view (see
 * compose.ts's `monthsMissing`) — the in-app promotion of
 * `npm run tekmetric:backfill` for just the gaps a "Last year"/YTD view
 * actually needs, rather than always requiring the trailing 24 months.
 *
 * `months` is a comma-separated list of "YYYY-MM" keys — never a raw
 * start/end pair from the client — validated server-side via
 * `monthKeyToRange`; anything malformed is silently dropped rather than
 * trusted. Each valid month is refreshed through the same size-guarded,
 * permission-gated `refreshOperations` a single-month manual refresh uses
 * (see fill-gaps.ts for why this is safe: one calendar month is always well
 * under the live-pull size cap that guards against the OOM this whole
 * effort exists to avoid), sequentially, so one bad month never aborts the
 * rest of the batch.
 *
 * Capped to `MAX_FILL_PER_CLICK` months regardless of how many were posted
 * — the page only ever puts that many in the hidden field, but the cap is
 * re-applied here too (never trust the client) since filling more months
 * than that in one request risks an HTTP timeout well before it risks
 * memory (see fill-gaps.ts).
 */
export async function fillMissingTekmetricMonthsAction(formData: FormData) {
  await requirePermission("refresh_tekmetric");

  const preset = (String(formData.get("preset") ?? DEFAULT_PRESET) || DEFAULT_PRESET) as DatePreset;
  const comparison = (String(formData.get("comparison") ?? DEFAULT_COMPARISON) || DEFAULT_COMPARISON) as ComparisonMode;
  const params = new URLSearchParams({ preset, comparison });

  const monthKeys = String(formData.get("months") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const months = monthKeys
    .map(monthKeyToRange)
    .filter((m): m is { start: string; end: string; label: string } => m !== null)
    .slice(0, MAX_FILL_PER_CLICK);

  if (months.length === 0) {
    params.set("error", "No valid months to fill.");
    redirect(`/tekmetric?${params.toString()}`);
  }

  try {
    const result = await fillMissingMonths(months);
    if (result.failCount > 0) {
      const failed = result.results
        .filter((r) => !r.ok)
        .map((r) => r.label)
        .join(", ");
      params.set("error", `Filled ${result.okCount}/${months.length} month(s); failed: ${failed}`.slice(0, 300));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Fill failed.";
    params.set("error", `Fill failed: ${msg}`.slice(0, 300));
    redirect(`/tekmetric?${params.toString()}`);
  }

  revalidatePath("/tekmetric");
  redirect(`/tekmetric?${params.toString()}`);
}
