"use server";

/**
 * Server actions for the Cash Sheet Sync module (§14).
 *
 * Every mutating action is gated by role (§14, §18): owner_admin may approve
 * postings, edit mappings, and advance the rollout stage; a reviewer may only
 * mark warnings reviewed and run a dry-run. Gating is enforced server-side via
 * requirePermission — never trusted from the client.
 */
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth/session";
import { runSync } from "@/lib/cashsheet/engine";
import { setRolloutStage } from "@/lib/config-store";
import { findInvoiceMatch } from "@/lib/qbo/posting";
import { getQboEnvironment } from "@/lib/config-store";
import type { RolloutStage } from "@/lib/cashsheet/rollout";

export async function runDryRunAction() {
  const user = await requirePermission("run_dry_run");
  await runSync({ forceDryRun: true, triggeredBy: user.email });
  revalidatePath("/cash-sheet-sync");
}

export async function runSandboxSyncAction() {
  const user = await requirePermission("run_sandbox_sync");
  await runSync({ triggeredBy: user.email });
  revalidatePath("/cash-sheet-sync");
}

/**
 * Backfill sync (§19 backfill tool). Lifts the 2026-07-07 go-live date gate so
 * historical rows already in the workbook (e.g. earlier months) become eligible.
 * It still respects the current rollout stage: in `dry_run` this is a harmless
 * dry-run that just shows how those older rows classify; only once the stage is
 * advanced to a sandbox/live posting stage does a backfill actually post. Used
 * to exercise end-to-end posting against the sandbox without editing the sheet.
 */
export async function runBackfillAction() {
  const user = await requirePermission("run_sandbox_sync");
  // Enforce the "backfill is never live" rule (§3): posting historical, pre
  // go-live rows to the real company is never allowed. Sandbox and dry-run only.
  const environment = await getQboEnvironment();
  if (environment === "live") {
    throw new Error("Backfill is disabled in the live environment — it would post historical rows to real QuickBooks.");
  }
  await runSync({ backfill: true, triggeredBy: user.email });
  revalidatePath("/cash-sheet-sync");
  revalidatePath("/cash-sheet-sync/queue");
}

export async function approveRowAction(rowId: string) {
  const user = await requirePermission("approve_posting");
  await prisma.sheetRow.update({
    where: { id: rowId },
    data: { approvedAt: new Date(), approvedByEmail: user.email },
  });
  await prisma.rowEvent.create({
    data: { sheetRowId: rowId, eventType: "approved", eventMessage: `Approved by ${user.email}` },
  });
  revalidatePath(`/cash-sheet-sync/rows/${rowId}`);
  revalidatePath("/cash-sheet-sync/queue");
}

export async function markReviewedAction(rowId: string) {
  const user = await requirePermission("mark_warning_reviewed");
  await prisma.sheetRow.update({
    where: { id: rowId },
    data: { reviewedAt: new Date(), reviewedByEmail: user.email },
  });
  await prisma.rowEvent.create({
    data: { sheetRowId: rowId, eventType: "reviewed", eventMessage: `Marked reviewed by ${user.email}` },
  });
  revalidatePath(`/cash-sheet-sync/rows/${rowId}`);
}

export async function setSheetWritebackAction(enabled: boolean) {
  const user = await requirePermission("change_rollout_stage");
  const { setConfig } = await import("@/lib/config-store");
  const { CONFIG_KEYS } = await import("@/lib/cashsheet/config");
  await setConfig(
    CONFIG_KEYS.sheetWriteback,
    enabled ? "true" : "false",
    user.id,
    `Sheet write-back ${enabled ? "enabled" : "disabled"} via dashboard by ${user.email}`
  );
  revalidatePath("/cash-sheet-sync/settings");
  revalidatePath("/cash-sheet-sync");
}

export async function advanceStageAction(next: RolloutStage) {
  const user = await requirePermission("change_rollout_stage");
  // Extra guard for the live jump — toggling into live also requires toggle_live_mode.
  if (next === "live_manual" || next === "live_auto") {
    await requirePermission("toggle_live_mode");
  }
  await setRolloutStage(next, user.id, `Advanced via dashboard by ${user.email}`);
  revalidatePath("/cash-sheet-sync/settings");
  revalidatePath("/cash-sheet-sync");
}

export async function recheckQboMatchAction(rowId: string) {
  await requirePermission("recheck_qbo_match");
  const row = await prisma.sheetRow.findUnique({ where: { id: rowId } });
  if (!row) return;
  const environment = await getQboEnvironment();
  const parsed = {
    rowNumber: row.rowNumberLastSeen,
    date: row.date,
    invNumber: row.invNumber ?? "",
    amount: row.amtCollected ? Number(row.amtCollected) : null,
  } as Parameters<typeof findInvoiceMatch>[0];
  try {
    const match = await findInvoiceMatch(parsed, environment);
    await prisma.sheetRow.update({
      where: { id: rowId },
      data: {
        status: match.found ? "Audit Only" : "Awaiting QBO Match",
        statusReason: match.found
          ? `Matched QBO ${match.candidates[0]?.type} ${match.candidates[0]?.id}`
          : "QBO Match Not Found — audit only",
      },
    });
    await prisma.rowEvent.create({
      data: { sheetRowId: rowId, eventType: "qbo_recheck", eventMessage: match.found ? "match found" : "no match", diffJson: match as object },
    });
  } catch (err) {
    await prisma.rowEvent.create({
      data: { sheetRowId: rowId, eventType: "qbo_recheck_error", eventMessage: String(err) },
    });
  }
  revalidatePath(`/cash-sheet-sync/rows/${rowId}`);
}

export async function updateMappingAction(formData: FormData) {
  await requirePermission("edit_mappings");
  const id = String(formData.get("id"));
  const qboAccountId = String(formData.get("qboAccountId") ?? "").trim() || null;
  const requiresManualApproval = formData.get("requiresManualApproval") === "on";
  const active = formData.get("active") === "on";
  await prisma.purposeMapping.update({
    where: { id },
    data: { qboAccountId, requiresManualApproval, active },
  });
  revalidatePath("/cash-sheet-sync/mappings");
}

export async function updateAccountMappingAction(formData: FormData) {
  await requirePermission("edit_mappings");
  const id = String(formData.get("id"));
  const qboAccountId = String(formData.get("qboAccountId") ?? "").trim() || null;
  await prisma.accountMapping.update({ where: { id }, data: { qboAccountId } });
  revalidatePath("/cash-sheet-sync/mappings");
}

/**
 * Auto-resolve account IDs from the connected QBO company by matching each
 * account slot's name against the company's chart of accounts (fully-qualified
 * name first, then plain name). Fills what it can and leaves the rest for manual
 * mapping. Also propagates resolved IDs onto the purpose mappings that reference
 * the same account name. In a fresh sandbox many GCD-specific names won't exist,
 * so this typically resolves more in production than in sandbox — use the
 * "Fetch QBO accounts" list to map the rest by hand.
 */
export async function autoResolveAccountsFromQboAction() {
  await requirePermission("edit_mappings");
  const { getQboEnvironment } = await import("@/lib/config-store");
  const { getContext, listAccounts } = await import("@/lib/qbo/client");
  const environment = await getQboEnvironment();
  const ctx = await getContext(environment); // throws QboNotConnectedError if not connected

  const accounts = await listAccounts(ctx);
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();
  const byKey = new Map<string, string>();
  for (const a of accounts) {
    if (a.FullyQualifiedName) byKey.set(norm(a.FullyQualifiedName), String(a.Id));
    if (a.Name) byKey.set(norm(a.Name), String(a.Id));
  }

  const accountMaps = await prisma.accountMapping.findMany();
  for (const m of accountMaps) {
    const id = byKey.get(norm(m.qboAccountName ?? m.friendlyName));
    if (id && id !== m.qboAccountId) {
      await prisma.accountMapping.update({ where: { id: m.id }, data: { qboAccountId: id } });
    }
  }

  // Propagate to purpose mappings that name a category account.
  const purposeMaps = await prisma.purposeMapping.findMany({ where: { auditOnly: false } });
  for (const p of purposeMaps) {
    if (!p.qboAccountName) continue;
    const id = byKey.get(norm(p.qboAccountName));
    if (id && id !== p.qboAccountId) {
      await prisma.purposeMapping.update({ where: { id: p.id }, data: { qboAccountId: id } });
    }
  }
  revalidatePath("/cash-sheet-sync/mappings");
}

/**
 * Load (or restore) the default German Car Depot seed mappings (§7, §14).
 * Idempotent: upserts by key and never overwrites a resolved qboAccountId or a
 * mapping's active flag on re-run — so clicking it again is safe and won't undo
 * account IDs you've already mapped. Use it to populate an empty mappings table
 * (e.g. before the DB has been seeded) or to restore any deleted defaults.
 */
export async function seedDefaultMappingsAction() {
  await requirePermission("edit_mappings");
  const { buildSeedPurposeMappings, SEED_ACCOUNT_MAPPINGS } = await import("@/lib/cashsheet/seed-mappings");

  for (const m of buildSeedPurposeMappings()) {
    await prisma.purposeMapping.upsert({
      where: { normalizedPurpose: m.normalizedPurpose },
      create: m,
      update: {
        purposePattern: m.purposePattern,
        amountType: m.amountType,
        qboAction: m.qboAction,
        qboAccountName: m.qboAccountName,
        postToQbo: m.postToQbo,
        auditOnly: m.auditOnly,
        requiresPayee: m.requiresPayee,
        requiresManualApproval: m.requiresManualApproval,
        invoiceMatching: m.invoiceMatching,
        // Deliberately NOT touching qboAccountId or active — preserve resolved IDs.
      },
    });
  }
  for (const a of SEED_ACCOUNT_MAPPINGS) {
    await prisma.accountMapping.upsert({
      where: { friendlyName: a.friendlyName },
      create: a,
      update: { qboAccountName: a.qboAccountName, qboAccountType: a.qboAccountType },
    });
  }
  revalidatePath("/cash-sheet-sync/mappings");
}
