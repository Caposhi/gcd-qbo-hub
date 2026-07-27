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
