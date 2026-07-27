"use server";

/**
 * Server actions for manually correcting a month's Tekmetric top-line KPIs
 * (Ops History tab). Owner-only (`override_tekmetric_ops`) — this is a
 * financial-data correction, not a read. The hub never writes to Tekmetric;
 * this only changes what the hub itself reads back for that month (see
 * src/lib/tekmetric/overrides.ts for how it flows into Ops History and the
 * Ops forecast baseline).
 */
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requirePermission } from "@/lib/auth/session";
import { saveMonthOverride, clearMonthOverride } from "@/lib/tekmetric/overrides";

const OPS_PATH = "/projections?tab=opshistory";

function num(v: FormDataEntryValue | null): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function saveTekmetricOverrideAction(formData: FormData) {
  const user = await requirePermission("override_tekmetric_ops");

  const [periodStart, periodEnd] = String(formData.get("period") ?? "").split("|");
  if (!periodStart || !periodEnd) {
    redirect(`${OPS_PATH}&error=${encodeURIComponent("Pick a month to correct.")}`);
  }

  try {
    await saveMonthOverride({
      periodStart,
      periodEnd,
      roCount: num(formData.get("roCount")),
      carCount: num(formData.get("carCount")),
      aro: num(formData.get("aro")),
      grossProfit: num(formData.get("grossProfit")),
      note: String(formData.get("note") ?? ""),
      byEmail: user.email,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Save failed.";
    redirect(`${OPS_PATH}&error=${encodeURIComponent(msg.slice(0, 300))}`);
  }

  revalidatePath("/projections");
  redirect(OPS_PATH);
}

export async function clearTekmetricOverrideAction(formData: FormData) {
  const user = await requirePermission("override_tekmetric_ops");
  const periodStart = String(formData.get("periodStart") ?? "");
  if (!periodStart) redirect(OPS_PATH);

  try {
    await clearMonthOverride(periodStart, user.email);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Clear failed.";
    redirect(`${OPS_PATH}&error=${encodeURIComponent(msg.slice(0, 300))}`);
  }

  revalidatePath("/projections");
  redirect(OPS_PATH);
}

/** Last day of the calendar month a "YYYY-MM-DD" (1st-of-month) start falls in. */
function endOfMonth(startIso: string): string {
  const [y, m] = startIso.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Read an uploaded Tekmetric End of Day Report (image or PDF) and redirect
 * back to the "Correct a month" form with its fields pre-filled from what was
 * extracted — nothing is saved to tek_month_overrides here. See
 * reportExtract.ts for why the derived gross profit adds the report's own
 * labor cost back in.
 */
export async function extractTekmetricReportAction(formData: FormData) {
  await requirePermission("override_tekmetric_ops");

  const file = formData.get("reportFile");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file) || (file as File).size === 0) {
    redirect(`${OPS_PATH}&error=${encodeURIComponent("Choose an image or PDF of the End of Day Report first.")}`);
    return;
  }
  const f = file as File;

  const { extractEndOfDayReport, deriveOverrideFromReport, isReportReaderConfigured } = await import(
    "@/lib/tekmetric/reportExtract"
  );
  if (!isReportReaderConfigured()) {
    redirect(`${OPS_PATH}&error=${encodeURIComponent("Report reader isn't configured (ANTHROPIC_API_KEY unset).")}`);
    return;
  }

  const bytes = Buffer.from(await f.arrayBuffer());
  type Figures = Awaited<ReturnType<typeof extractEndOfDayReport>>;
  let figures: Figures | null = null;
  try {
    figures = await extractEndOfDayReport(bytes, f.type || "image/png");
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Extraction failed.";
    redirect(`${OPS_PATH}&error=${encodeURIComponent(msg.slice(0, 300))}`);
    return;
  }
  if (!figures) return;

  const { periodStart, periodEnd, totalRepairOrders, grandNetSales, grandProfit, laborCost, notes } = figures;
  if (
    periodStart === null ||
    periodEnd === null ||
    totalRepairOrders === null ||
    grandNetSales === null ||
    grandProfit === null ||
    laborCost === null
  ) {
    redirect(
      `${OPS_PATH}&error=${encodeURIComponent(`Couldn't read every needed figure from that file${notes ? `: ${notes}` : "."}`)}`
    );
    return;
  }

  // Our overrides are per exact calendar month — reject a custom/partial range.
  const isFirstOfMonth = periodStart.slice(8, 10) === "01";
  if (!isFirstOfMonth || periodEnd !== endOfMonth(periodStart)) {
    redirect(
      `${OPS_PATH}&error=${encodeURIComponent(
        `That report covers ${periodStart} to ${periodEnd}, not one full calendar month — ` +
          "run the End of Day Report for a single month and re-upload."
      )}`
    );
    return;
  }

  const derived = deriveOverrideFromReport({ totalRepairOrders, grandNetSales, grandProfit, laborCost });

  const params = new URLSearchParams({
    tab: "opshistory",
    draftStart: periodStart,
    draftEnd: periodEnd,
    draftRoCount: String(derived.roCount),
    draftAro: String(derived.aro),
    draftGrossProfit: String(derived.grossProfit),
    draftNetSales: String(grandNetSales),
    draftReportProfit: String(grandProfit),
    draftLaborCost: String(laborCost),
  });
  redirect(`/projections?${params.toString()}`);
}
