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
import { Prisma, type SheetRow } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth/session";
import { runSync } from "@/lib/cashsheet/engine";
import { setRolloutStage } from "@/lib/config-store";
import { findInvoiceMatch } from "@/lib/qbo/posting";
import { getQboEnvironment } from "@/lib/config-store";
import { RowStatus } from "@/lib/cashsheet/status";
import type { RolloutStage } from "@/lib/cashsheet/rollout";

/**
 * One-time go-live reset (§12/§16). Sandbox test posts leave a QBO transaction
 * id stamped on the sheet row, so once live the engine treats that row as
 * "already posted" and skips it — even though the live company never received
 * it. This clears the posting state on rows whose ONLY posting was in the
 * sandbox (never touching a row that has a real live posting), and deletes the
 * sandbox qbo_transactions, so live starts clean. Owner-only and irreversible,
 * but safe: it only removes throwaway sandbox test residue.
 */
export async function resetSandboxPostingsAction() {
  await requirePermission("toggle_live_mode");

  const sandboxTxns = await prisma.qboTransaction.findMany({
    where: { qboEnvironment: "sandbox" },
    select: { sheetRowId: true },
  });
  const rowIds = [
    ...new Set(sandboxTxns.map((t) => t.sheetRowId).filter((id): id is string => id !== null)),
  ];

  for (const rowId of rowIds) {
    const liveTxn = await prisma.qboTransaction.findFirst({
      where: { sheetRowId: rowId, qboEnvironment: "live" },
      select: { id: true },
    });
    if (liveTxn) continue; // has a real live posting — never touch it
    await prisma.sheetRow.update({
      where: { id: rowId },
      data: {
        status: RowStatus.New,
        statusReason: "Reset for go-live — sandbox posting cleared",
        qboTransactionId: null,
        qboTransactionType: null,
        qboPostedAt: null,
        originalHash: null,
        originalSnapshotJson: Prisma.DbNull,
        // Require fresh, deliberate approval before any live post.
        approvedAt: null,
        approvedByEmail: null,
        reviewedAt: null,
        reviewedByEmail: null,
      },
    });
  }

  await prisma.qboTransaction.deleteMany({ where: { qboEnvironment: "sandbox" } });
  revalidatePath("/cash-sheet-sync");
  revalidatePath("/cash-sheet-sync/queue");
  revalidatePath("/cash-sheet-sync/settings");
}

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

/**
 * Read-only "Locate in QBO" for the cash-sheet → Bank Deposit pilot (§6C/§19).
 * For every candidate row (customer cash collection with a bank-deposit amount,
 * not yet deposited), find the Undeposited-Funds payment by RO# and record the
 * exact deposit that WOULD be created. Never writes to QBO — this is the
 * dry-run gate the operator reviews before creating any deposit.
 */
export async function locateCashDepositsAction() {
  await requirePermission("recheck_qbo_match");
  const environment = await getQboEnvironment();
  const { getContext } = await import("@/lib/qbo/client");
  const { findCashDepositCandidates, resolveDepositAccounts, locateRow, alreadyHasDeposit } = await import(
    "@/lib/cashsheet/cash-deposit-service"
  );

  const { collectDepositedPaymentIds } = await import("@/lib/qbo/deposits");

  const accounts = await resolveDepositAccounts();
  const ctx = await getContext(environment); // throws QboNotConnectedError if not connected
  const rows = await findCashDepositCandidates();

  // One pass to learn which payments are ALREADY on a QBO deposit, over the full
  // span of candidate dates (buffered), so the matcher can skip anything that
  // was already deposited/reconciled — never double-count.
  const dated = rows.map((r) => r.date).filter((d): d is Date => !!d);
  let depositedPaymentIds = new Set<string>();
  if (dated.length) {
    const min = new Date(Math.min(...dated.map((d) => d.getTime())));
    const max = new Date(Math.max(...dated.map((d) => d.getTime())));
    const scanStart = new Date(min.getTime());
    scanStart.setUTCDate(scanStart.getUTCDate() - 14);
    const scanEnd = new Date(max.getTime());
    scanEnd.setUTCDate(scanEnd.getUTCDate() + 14);
    depositedPaymentIds = await collectDepositedPaymentIds(
      ctx,
      scanStart.toISOString().slice(0, 10),
      scanEnd.toISOString().slice(0, 10)
    );
  }

  let found = 0;
  let notFound = 0;
  let alreadyDeposited = 0;
  for (const row of rows) {
    if (alreadyHasDeposit(row)) continue;
    try {
      const located = await locateRow(ctx, row, depositedPaymentIds);
      if (located.found) found++;
      else if (located.alreadyDeposited) alreadyDeposited++;
      else notFound++;
      await prisma.rowEvent.create({
        data: {
          sheetRowId: row.id,
          eventType: "cash_deposit_plan",
          eventMessage: located.found
            ? `Deposit plan ready: payment ${located.payment?.amount.toFixed(2)} + over/short ${(
                (located.plan?.overShortCents ?? 0) / 100
              ).toFixed(2)} → ${located.depositedAmount.toFixed(2)}`
            : located.reason,
          diffJson: {
            ...located,
            accounts,
            environment,
          } as unknown as object,
        },
      });
    } catch (err) {
      await prisma.rowEvent.create({
        data: { sheetRowId: row.id, eventType: "cash_deposit_locate_error", eventMessage: String(err) },
      });
    }
  }

  // Always leave a breadcrumb — even a zero-candidate run — so the operator can
  // see the locate actually ran and what it found (visible on the deposits page
  // and in the row-events audit trail; no DB access needed).
  await prisma.rowEvent.create({
    data: {
      eventType: "cash_deposit_locate_summary",
      eventMessage: `Locate run: ${rows.length} candidate row(s), ${found} ready, ${alreadyDeposited} already deposited, ${notFound} not found · env ${environment}`,
    },
  });

  revalidatePath("/cash-sheet-sync/deposits");
}

interface DepositContext {
  gateEnv: "sandbox" | "live";
  accounts: { depositToId: string; overShortId: string };
  ctx: Awaited<ReturnType<typeof import("@/lib/qbo/client").getContext>>;
}

/**
 * Resolve the shared context for creating deposits: the rollout gate (never
 * dry-run, valid creds), the resolved Cash-on-hand / Cash-over-short accounts,
 * and a live QBO context. Returns a blocked reason instead of throwing so both
 * the single and batch actions surface it the same way.
 */
async function prepareDepositContext(): Promise<
  { ok: true; value: DepositContext } | { ok: false; reason: string }
> {
  const { canPostRow } = await import("@/lib/cashsheet/rollout");
  const { getRolloutStage } = await import("@/lib/config-store");
  const { hasValidCredentials } = await import("@/lib/qbo/oauth");
  const { getContext } = await import("@/lib/qbo/client");
  const { resolveDepositAccounts } = await import("@/lib/cashsheet/cash-deposit-service");

  const stage = await getRolloutStage();
  const environment = await getQboEnvironment();
  const credsValid = await hasValidCredentials(environment);
  // Clicking Create (single or batch) IS the approval; the gate still enforces
  // "never in dry-run" and "valid credentials".
  const gate = canPostRow({ stage, credentialsValid: credsValid, mappingRequiresApproval: false, rowApproved: true });
  if (!gate.allowed) return { ok: false, reason: `Not created: ${gate.reason}` };

  const accounts = await resolveDepositAccounts();
  if (!accounts.depositToId || !accounts.overShortId) {
    return {
      ok: false,
      reason: `Account mapping unresolved (Cash on hand=${accounts.depositToId ?? "?"}, Cash over/short=${
        accounts.overShortId ?? "?"
      })`,
    };
  }
  const ctx = await getContext(gate.environment!);
  return {
    ok: true,
    value: { gateEnv: gate.environment!, accounts: { depositToId: accounts.depositToId, overShortId: accounts.overShortId }, ctx },
  };
}

type DepositOutcome =
  | { status: "created"; depositId: string }
  | { status: "skipped" }
  | { status: "blocked"; reason: string }
  | { status: "error"; reason: string };

/**
 * Create one QBO Bank Deposit for a row given already-resolved context. Always
 * re-locates and re-verifies the tie-out from scratch (never trusts the cached
 * preview), refuses if the payment is already deposited (double-count guard),
 * posts the deposit linking the Undeposited-Funds payment (+ cash over/short
 * plug), then stamps the QBO id on the row. Records events; does NOT revalidate
 * (the caller does). Shared by the single-row and batch actions.
 */
async function postDepositForRow(
  row: SheetRow,
  dc: DepositContext,
  userEmail: string,
  depositedPaymentIds: Set<string>
): Promise<DepositOutcome> {
  const { postCashDeposit } = await import("@/lib/qbo/deposits");
  const { locateRow, alreadyHasDeposit } = await import("@/lib/cashsheet/cash-deposit-service");
  const { buildMemo } = await import("@/lib/cashsheet/memo");

  if (alreadyHasDeposit(row)) return { status: "skipped" };

  const located = await locateRow(dc.ctx, row, depositedPaymentIds);
  if (!located.found || !located.plan) {
    await prisma.rowEvent.create({
      data: { sheetRowId: row.id, eventType: "cash_deposit_blocked", eventMessage: located.reason },
    });
    return { status: "blocked", reason: located.reason };
  }

  const memo = buildMemo(
    row.tabName,
    {
      rowNumber: row.rowNumberLastSeen,
      date: row.date,
      invNumber: row.invNumber ?? "",
      name: row.name ?? "",
      purpose: row.purpose ?? "",
      rcvByOrPaidTo: row.rcvByOrPaidTo ?? "",
      approvedBy: row.approvedBy ?? "",
    } as Parameters<typeof buildMemo>[1],
    row.rowUuid
  );

  let result;
  try {
    result = await postCashDeposit(dc.ctx, {
      depositToAccountId: dc.accounts.depositToId,
      txnDate: (row.date ?? new Date()).toISOString().slice(0, 10),
      paymentId: located.plan.paymentId,
      paymentAmount: located.plan.paymentCents / 100,
      overShortAmount: located.plan.overShortCents / 100,
      overShortAccountId: dc.accounts.overShortId,
      privateNote: memo,
    });
  } catch (err) {
    const detail = (err as { detail?: unknown })?.detail;
    const detailStr = detail ? ` · ${JSON.stringify(detail)}` : "";
    await prisma.rowEvent.create({
      data: {
        sheetRowId: row.id,
        eventType: "cash_deposit_error",
        eventMessage: `QBO rejected deposit: ${String(err)}${detailStr}`.slice(0, 1800),
      },
    });
    return { status: "error", reason: String(err) };
  }

  await prisma.$transaction([
    prisma.qboTransaction.create({
      data: {
        sheetRowId: row.id,
        qboCompanyId: dc.gateEnv === "live" ? "live-realm" : "sandbox-realm",
        qboEnvironment: dc.gateEnv,
        qboTransactionId: result.qboTransactionId,
        qboTransactionType: "Deposit",
        qboSyncToken: result.qboSyncToken,
        requestJsonRedacted: result.requestRedacted as Prisma.InputJsonValue,
        responseJsonRedacted: result.responseRedacted as Prisma.InputJsonValue,
      },
    }),
    prisma.sheetRow.update({
      where: { id: row.id },
      data: {
        status: RowStatus.DepositCreated,
        statusReason: `Bank Deposit ${result.qboTransactionId} created (payment ${(
          located.plan.paymentCents / 100
        ).toFixed(2)}${
          located.plan.overShortCents ? ` + over/short ${(located.plan.overShortCents / 100).toFixed(2)}` : ""
        })`,
        qboTransactionId: result.qboTransactionId,
        qboTransactionType: "Deposit",
        qboAccountId: dc.accounts.depositToId,
        qboPostedAt: new Date(),
        originalHash: row.currentHash,
        originalSnapshotJson: (row.currentSnapshotJson ?? Prisma.DbNull) as Prisma.InputJsonValue,
      },
    }),
  ]);
  await prisma.rowEvent.create({
    data: {
      sheetRowId: row.id,
      eventType: "cash_deposit_created",
      eventMessage: `Deposit ${result.qboTransactionId} created by ${userEmail} (total ${
        result.totalAmt?.toFixed(2) ?? located.depositedAmount.toFixed(2)
      })`,
      diffJson: { located, result: { id: result.qboTransactionId, totalAmt: result.totalAmt } } as unknown as object,
    },
  });
  return { status: "created", depositId: result.qboTransactionId };
}

/** Deposit-scan a date window and return the payment ids already on a deposit. */
async function depositedIdsForWindow(
  ctx: DepositContext["ctx"],
  dates: Date[],
  padDays: number
): Promise<Set<string>> {
  if (!dates.length) return new Set<string>();
  const { collectDepositedPaymentIds } = await import("@/lib/qbo/deposits");
  const min = new Date(Math.min(...dates.map((d) => d.getTime())));
  const max = new Date(Math.max(...dates.map((d) => d.getTime())));
  min.setUTCDate(min.getUTCDate() - padDays);
  max.setUTCDate(max.getUTCDate() + padDays);
  return collectDepositedPaymentIds(ctx, min.toISOString().slice(0, 10), max.toISOString().slice(0, 10));
}

/**
 * Create the QBO Bank Deposit for one cash-sheet row (owner-only). See
 * postDepositForRow for the safety guarantees.
 */
export async function createCashDepositAction(formData: FormData) {
  const user = await requirePermission("approve_posting");
  const rowId = String(formData.get("rowId") ?? "");
  if (!rowId) throw new Error("Missing rowId");

  try {
    const row = await prisma.sheetRow.findUnique({ where: { id: rowId } });
    if (!row) throw new Error("Row not found");

    const prep = await prepareDepositContext();
    if (!prep.ok) {
      await prisma.rowEvent.create({
        data: { sheetRowId: rowId, eventType: "cash_deposit_blocked", eventMessage: prep.reason },
      });
      revalidatePath("/cash-sheet-sync/deposits");
      return;
    }

    const depositedPaymentIds = await depositedIdsForWindow(prep.value.ctx, row.date ? [row.date] : [], 14);
    await postDepositForRow(row, prep.value, user.email, depositedPaymentIds);

    revalidatePath("/cash-sheet-sync/deposits");
    revalidatePath("/cash-sheet-sync/queue");
  } catch (err) {
    await prisma.rowEvent.create({
      data: { sheetRowId: rowId, eventType: "cash_deposit_error", eventMessage: `Create failed: ${String(err)}` },
    });
    revalidatePath("/cash-sheet-sync/deposits");
  }
}

/**
 * Batch automation (owner-only): create QBO deposits for every row a prior
 * Locate marked "ready". Selection is limited to rows whose latest
 * cash_deposit_plan event is found=true (so we don't re-query the whole backlog
 * or spam blocked events) — but each row is still re-located and re-verified by
 * postDepositForRow before anything posts, and the double-count guard runs from
 * a single fresh deposit scan. This is the "manual batch" rung of the ladder,
 * before any fully-unattended posting.
 */
export async function createAllReadyCashDepositsAction() {
  const user = await requirePermission("approve_posting");
  const { findCashDepositCandidates, alreadyHasDeposit } = await import("@/lib/cashsheet/cash-deposit-service");

  const prep = await prepareDepositContext();
  if (!prep.ok) {
    await prisma.rowEvent.create({
      data: { eventType: "cash_deposit_batch", eventMessage: `Batch blocked: ${prep.reason}` },
    });
    revalidatePath("/cash-sheet-sync/deposits");
    return;
  }

  const candidates = (await findCashDepositCandidates()).filter((r) => !alreadyHasDeposit(r));

  // Only attempt rows a recent Locate found as ready (latest plan event, found).
  const planEvents = candidates.length
    ? await prisma.rowEvent.findMany({
        where: { sheetRowId: { in: candidates.map((r) => r.id) }, eventType: "cash_deposit_plan" },
        orderBy: { createdAt: "desc" },
      })
    : [];
  const readyRowIds = new Set<string>();
  const seen = new Set<string>();
  for (const e of planEvents) {
    if (!e.sheetRowId || seen.has(e.sheetRowId)) continue;
    seen.add(e.sheetRowId);
    if ((e.diffJson as { found?: boolean } | null)?.found) readyRowIds.add(e.sheetRowId);
  }
  const ready = candidates.filter((r) => readyRowIds.has(r.id));

  const depositedPaymentIds = await depositedIdsForWindow(
    prep.value.ctx,
    ready.map((r) => r.date).filter((d): d is Date => !!d),
    14
  );

  let created = 0;
  let blocked = 0;
  let errored = 0;
  for (const row of ready) {
    try {
      const outcome = await postDepositForRow(row, prep.value, user.email, depositedPaymentIds);
      if (outcome.status === "created") created++;
      else if (outcome.status === "blocked") blocked++;
      else if (outcome.status === "error") errored++;
    } catch (err) {
      errored++;
      await prisma.rowEvent.create({
        data: { sheetRowId: row.id, eventType: "cash_deposit_error", eventMessage: `Create failed: ${String(err)}` },
      });
    }
  }

  await prisma.rowEvent.create({
    data: {
      eventType: "cash_deposit_batch",
      eventMessage: `Batch create: ${created} created, ${blocked} blocked, ${errored} errored (of ${ready.length} ready; ${candidates.length} candidates) · env ${prep.value.gateEnv}`,
    },
  });
  revalidatePath("/cash-sheet-sync/deposits");
  revalidatePath("/cash-sheet-sync/queue");
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
