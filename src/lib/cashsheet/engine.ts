/**
 * Cash Sheet Sync engine (§13, §19).
 *
 * Orchestrates one sync run end to end:
 *   read tabs → detect headers → parse rows → assign/read stable UUIDs →
 *   fingerprint/hash → persist sheet_rows → detect duplicates / changed /
 *   removed → classify → gate by rollout stage → post (or audit-match) →
 *   record events + qbo_transactions → summarize → email alerts.
 *
 * Invariants enforced here:
 *   - dry-run NEVER touches QBO (the rollout gate returns dry_run_never_posts).
 *   - one row error never aborts the run (§13, §17) — every row is in try/catch.
 *   - a row already carrying a QBO transaction id is never re-posted (§10).
 *   - QBO transactions are never edited or deleted (§2, §22) — we only READ them
 *     for match/duplicate checks and detect drift.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { listTabs, readTabValues, writeCells } from "@/lib/google/sheets";
import { detectHeaderRow } from "./headers";
import { parseRow, isBlankRow, isSummaryRow, isTransactionCandidate, validateRow, type ParsedRow } from "./rows";
import { computeFingerprint, computeRowHash, rowSnapshot } from "./fingerprint";
import { extractRowUuid, generateRowUuid, CONTROL_KEYS, isValidRowUuid } from "./uuid";
import { buildPostingPlan, type AccountMappingLike } from "./classify";
import type { MappingLike } from "./purpose";
import { findDuplicateRowIds, findPossibleDuplicate, isAlreadyPosted, type PostedRowRef } from "./duplicates";
import { isChangedAfterPosting, diffSnapshots, findRemovedAfterPosting } from "./detection";
import { canPostRow, modeForStage, environmentForStage, type RolloutStage, type SyncMode } from "./rollout";
import { RowStatus } from "./status";
import { canonicalMonthTab, TEMPLATE_TAB } from "./config";
import { planWritebackColumns, type WritebackLayout } from "./writeback";
import { AUTOMATION_START_DATE, isOnOrAfterStartDate, formatDate } from "./dates";
import { getRolloutStage, getSpreadsheetId, getSheetWritebackEnabled } from "@/lib/config-store";
import { hasValidCredentials } from "@/lib/qbo/oauth";
import { postPlan, findInvoiceMatch } from "@/lib/qbo/posting";
import { sendEmail, ALERT_RECIPIENTS } from "@/lib/email/sendgrid";

export interface RunOptions {
  /** Force dry-run regardless of config (Manual Actions → "run dry-run"). */
  forceDryRun?: boolean;
  /** Backfill mode processes rows BEFORE the start date too (§3). Never live. */
  backfill?: boolean;
  triggeredBy?: string;
}

export interface RunSummary {
  syncRunId: string;
  mode: SyncMode;
  rolloutStage: RolloutStage;
  environment: string;
  setupRequired: boolean;
  rowsScanned: number;
  rowsPosted: number;
  rowsSkipped: number;
  rowsError: number;
  rowsWarning: number;
  auditOnly: number;
  awaitingQboMatch: number;
  unknownPurpose: number;
  possibleDuplicates: number;
  duplicateRowIds: number;
  changedAfterPosting: number;
  removedAfterPosting: number;
  /** Rows whose cell values differ from the previous daily sync (§11). */
  rowsChangedSinceLastSync: number;
  tabsScanned: string[];
}

interface Scanned {
  tabName: string;
  sheetGid: string;
  rowUuid: string;
  synthetic: boolean;
  row: ParsedRow;
  fingerprint: string;
  hash: string;
  snapshot: Record<string, unknown>;
}

export async function runSync(options: RunOptions = {}): Promise<RunSummary> {
  const spreadsheetId = await getSpreadsheetId();
  const configuredStage = await getRolloutStage();
  const stage: RolloutStage = options.forceDryRun ? "dry_run" : configuredStage;
  const mode = modeForStage(stage);
  const environment = environmentForStage(stage);

  // Credentials gate (§16): if a posting stage has no valid creds, we downgrade
  // to validation/dry-run behavior and flag setup required — never silently
  // attempt to post.
  const credsValid = mode === "dry_run" ? false : await safe(() => hasValidCredentials(environment), false);
  const setupRequired = mode !== "dry_run" && !credsValid;

  const startDate = options.backfill ? new Date(Date.UTC(2000, 0, 1)) : AUTOMATION_START_DATE;

  const run = await prisma.syncRun.create({
    data: { mode, rolloutStage: stage, spreadsheetId, tabsScanned: [], status: "running" },
  });

  const summary: RunSummary = {
    syncRunId: run.id,
    mode,
    rolloutStage: stage,
    environment,
    setupRequired,
    rowsScanned: 0,
    rowsPosted: 0,
    rowsSkipped: 0,
    rowsError: 0,
    rowsWarning: 0,
    auditOnly: 0,
    awaitingQboMatch: 0,
    unknownPurpose: 0,
    possibleDuplicates: 0,
    duplicateRowIds: 0,
    changedAfterPosting: 0,
    removedAfterPosting: 0,
    rowsChangedSinceLastSync: 0,
    tabsScanned: [],
  };

  const [mappings, accounts] = await Promise.all([loadMappings(), loadAccounts()]);

  // Sheet write-back (§4): when enabled we stamp a hidden stable UUID + status
  // columns back into the workbook. Per-tab layout + queued cell writes; a
  // synthetic→real UUID migration list (see below).
  const writebackEnabled = await getSheetWritebackEnabled();
  const layoutByTab = new Map<string, WritebackLayout>();
  const cellsByTab = new Map<string, Array<{ row: number; col: number; value: string }>>();
  const uuidMigrations: Array<{ syn: string; real: string }> = [];

  // ---- 1. Scan every month tab -------------------------------------------
  const scanned: Scanned[] = [];
  const seenUuidsByTab = new Map<string, Set<string>>();

  let tabs: Array<{ title: string; sheetId: number }> = [];
  try {
    tabs = (await listTabs(spreadsheetId)).map((t) => ({ title: t.title, sheetId: t.sheetId }));
  } catch (err) {
    await failRun(run.id, `Could not list tabs: ${String(err)}`);
    throw err;
  }

  const monthTabs = tabs.filter((t) => t.title !== TEMPLATE_TAB && canonicalMonthTab(t.title) !== null);
  // Diagnostic: record every tab found in the workbook and which we selected as
  // month tabs, so an operator can see immediately if a data tab was skipped
  // for being named unexpectedly (§3).
  await recordEvent(
    run.id,
    null,
    "tabs_discovered",
    `Workbook tabs: ${tabs.map((t) => t.title).join(", ") || "(none)"} · scanning: ${
      monthTabs.map((t) => t.title).join(", ") || "(none)"
    }`
  );

  for (const tab of monthTabs) {
    try {
      const values = await readTabValues(spreadsheetId, tab.title);
      const det = detectHeaderRow(values);
      if (!det) continue; // no header → skip; dashboard can flag separately
      summary.tabsScanned.push(tab.title);

      const headerRow = values[det.headerRowIndex];
      // With write-back on, the managed layout owns the UUID column (reusing an
      // existing GCD_QBO_Row_ID or appending a fresh block); otherwise fall back
      // to read-only control-column detection.
      let controlCol: number | null;
      if (writebackEnabled) {
        const layout = planWritebackColumns(headerRow, det.columns);
        layoutByTab.set(tab.title, layout);
        const cells = cellsByTab.get(tab.title) ?? [];
        cellsByTab.set(tab.title, cells);
        for (const h of layout.headerCellsToWrite) {
          cells.push({ row: det.headerRowIndex + 1, col: h.col, value: h.value });
        }
        controlCol = layout.colByKey.rowId;
      } else {
        controlCol = findControlColumn(headerRow);
      }
      const seen = new Set<string>();
      seenUuidsByTab.set(tab.title, seen);

      for (let i = det.headerRowIndex + 1; i < values.length; i++) {
        const rowNumber = i + 1; // 1-based sheet row
        const raw = values[i] ?? [];
        const parsed = parseRow(raw, det.columns, rowNumber);
        if (isBlankRow(parsed)) continue;
        if (isSummaryRow(parsed)) continue; // column-totals line, not a transaction
        if (!isTransactionCandidate(parsed)) continue;

        summary.rowsScanned++;

        const fingerprint = computeFingerprint(spreadsheetId, tab.title, parsed);
        const hash = computeRowHash(spreadsheetId, tab.title, parsed);
        const snapshot = rowSnapshot(spreadsheetId, tab.title, parsed);

        // Stable identity (§4): a real hidden UUID read from the sheet wins;
        // otherwise a synthetic content key keeps the DB idempotent before the
        // UUID column is populated.
        const realUuid =
          controlCol !== null ? extractRowUuid({ [CONTROL_KEYS.rowId]: raw[controlCol] }) : null;
        const syntheticId = `syn-${fingerprint.slice(0, 24)}`;
        let rowUuid: string;
        let synthetic: boolean;
        if (isValidRowUuid(realUuid)) {
          // A real UUID is present — it only got there because a prior write
          // succeeded, so it is safe to adopt as identity. Migrate any existing
          // synthetic DB row to it (below) so a posted row isn't seen as new.
          rowUuid = realUuid!;
          synthetic = false;
          if (writebackEnabled) uuidMigrations.push({ syn: syntheticId, real: realUuid! });
        } else {
          // No real UUID yet. Keep synthetic identity THIS run; if write-back is
          // on, queue a fresh UUID so it becomes the stable identity next run
          // (only after the write is confirmed by reading it back).
          rowUuid = syntheticId;
          synthetic = true;
          if (writebackEnabled && controlCol !== null) {
            cellsByTab
              .get(tab.title)!
              .push({ row: rowNumber, col: controlCol, value: generateRowUuid() });
          }
        }

        seen.add(rowUuid);
        scanned.push({
          tabName: tab.title,
          sheetGid: String(tab.sheetId),
          rowUuid,
          synthetic,
          row: parsed,
          fingerprint,
          hash,
          snapshot,
        });
      }
    } catch (err) {
      summary.rowsError++;
      await recordEvent(run.id, null, "tab_error", `Tab ${tab.title}: ${String(err)}`);
    }
  }

  // ---- 1b. Migrate synthetic identities to their now-persisted UUID (§4) --
  // A row we previously tracked under a synthetic content key gets migrated to
  // the real UUID the moment that UUID is read back from the sheet — so a
  // posted row is recognized as the same row (never a false removed/new pair).
  for (const m of uuidMigrations) {
    if (m.syn === m.real) continue;
    const already = await prisma.sheetRow.findUnique({
      where: { spreadsheetId_rowUuid: { spreadsheetId, rowUuid: m.real } },
    });
    if (already) continue; // real UUID already tracked — nothing to migrate
    await prisma.sheetRow.updateMany({
      where: { spreadsheetId, rowUuid: m.syn },
      data: { rowUuid: m.real },
    });
  }

  // ---- 2. Duplicate row-id detection across everything scanned (§10) ------
  const dupRowIds = findDuplicateRowIds(
    scanned
      .filter((s) => !s.synthetic)
      .map((s) => ({ rowUuid: s.rowUuid, rowNumber: s.row.rowNumber, tabName: s.tabName, fingerprint: s.fingerprint }))
  );

  // Previously-posted rows (for possible-duplicate + change/removal checks).
  const postedRows = await prisma.sheetRow.findMany({
    where: { spreadsheetId, qboTransactionId: { not: null } },
    select: { rowUuid: true, tabName: true, normalizedFingerprint: true, originalHash: true, qboTransactionId: true, originalSnapshotJson: true },
  });
  const postedRefs: PostedRowRef[] = postedRows.map((p) => ({
    rowUuid: p.rowUuid,
    fingerprint: p.normalizedFingerprint,
    qboTransactionId: p.qboTransactionId ?? "",
  }));

  // ---- 3. Per-row upsert + classify + gate + post ------------------------
  for (const s of scanned) {
    try {
      await processRow(s, {
        run,
        stage,
        mode,
        environment,
        credsValid,
        startDate,
        backfill: !!options.backfill,
        mappings,
        accounts,
        dupRowIds,
        postedRefs,
        summary,
      });
    } catch (err) {
      summary.rowsError++;
      await recordEvent(run.id, null, "row_error", `Row ${s.tabName}#${s.row.rowNumber}: ${String(err)}`);
    }
  }

  // ---- 4. Removed-after-posting detection (§11) --------------------------
  // Group posted UUIDs by tab; a posted UUID not seen in its tab's full scan
  // has truly disappeared (a moved row is still seen).
  const postedByTab = new Map<string, string[]>();
  for (const p of postedRows) {
    if (!isValidRowUuid(p.rowUuid)) continue; // synthetic rows never posted
    const list = postedByTab.get(p.tabName) ?? [];
    list.push(p.rowUuid);
    postedByTab.set(p.tabName, list);
  }
  for (const [tabName, uuids] of postedByTab) {
    const seen = seenUuidsByTab.get(tabName);
    if (!seen) continue; // tab wasn't scanned this run → don't false-flag
    const removed = findRemovedAfterPosting(uuids, seen);
    for (const uuid of removed) {
      await handleRemoved(spreadsheetId, uuid, run.id, summary);
    }
  }

  // ---- 4b. Sheet write-back (§4): stamp UUID + status columns ------------
  // Best-effort: a failure here (e.g. the service account only has Viewer)
  // is logged and never fails the run — reads and posts already happened.
  if (writebackEnabled && cellsByTab.size > 0) {
    const uuids = scanned.map((s) => s.rowUuid);
    const dbRows = uuids.length
      ? await prisma.sheetRow.findMany({
          where: { spreadsheetId, rowUuid: { in: uuids } },
          select: { rowUuid: true, status: true, qboTransactionId: true, qboPostedAt: true, statusReason: true },
        })
      : [];
    const byUuid = new Map(dbRows.map((r) => [r.rowUuid, r]));
    for (const s of scanned) {
      const layout = layoutByTab.get(s.tabName);
      const cells = cellsByTab.get(s.tabName);
      const dbRow = byUuid.get(s.rowUuid);
      if (!layout || !cells || !dbRow) continue;
      const rn = s.row.rowNumber;
      cells.push({ row: rn, col: layout.colByKey.status, value: dbRow.status });
      cells.push({ row: rn, col: layout.colByKey.txnId, value: dbRow.qboTransactionId ?? "" });
      cells.push({ row: rn, col: layout.colByKey.postedAt, value: dbRow.qboPostedAt ? dbRow.qboPostedAt.toISOString() : "" });
      cells.push({
        row: rn,
        col: layout.colByKey.error,
        value: dbRow.status === RowStatus.Error ? dbRow.statusReason ?? "" : "",
      });
    }
    for (const [tabTitle, cells] of cellsByTab) {
      try {
        await writeCells(spreadsheetId, tabTitle, cells);
      } catch (err) {
        await recordEvent(run.id, null, "writeback_error", `Sheet write-back failed for ${tabTitle}: ${String(err)}`);
      }
    }
  }

  // ---- 5. Finalize + alerts ----------------------------------------------
  await prisma.syncRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      status: summary.rowsError > 0 ? "error" : "success",
      tabsScanned: summary.tabsScanned,
      rowsScanned: summary.rowsScanned,
      rowsPosted: summary.rowsPosted,
      rowsSkipped: summary.rowsSkipped,
      rowsError: summary.rowsError,
      rowsWarning: summary.rowsWarning,
      summaryJson: summary as unknown as Prisma.InputJsonValue,
    },
  });

  await sendDailySummary(summary);
  return summary;
}

interface RowCtx {
  run: { id: string };
  stage: RolloutStage;
  mode: SyncMode;
  environment: "sandbox" | "live";
  credsValid: boolean;
  startDate: Date;
  backfill: boolean;
  mappings: MappingLike[];
  accounts: AccountMappingLike[];
  dupRowIds: Map<string, unknown>;
  postedRefs: PostedRowRef[];
  summary: RunSummary;
}

async function processRow(s: Scanned, ctx: RowCtx): Promise<void> {
  const { row, tabName } = s;

  // Persist / update the sheet row (idempotent by spreadsheet+uuid).
  const existing = await prisma.sheetRow.findUnique({
    where: { spreadsheetId_rowUuid: { spreadsheetId: s.snapshot.spreadsheetId as string, rowUuid: s.rowUuid } },
  });

  // Change-after-posting (§11): a posted row whose hash drifted.
  let status: string = existing?.status ?? RowStatus.New;
  const wasPosted = existing ? isAlreadyPosted(existing.qboTransactionId) : false;

  // Universal per-sync change tracking (§11). Independent of posting state:
  // compare this row's cells against the snapshot captured on the LAST sync and,
  // if any cell differs, record a durable `row_changed` event with the full
  // before/after snapshot and per-field diff. This is edge-triggered — it fires
  // once per actual edit (next sync's baseline is the new value), so a row that
  // is edited and then left alone is logged exactly once. It gives every tracked
  // row an auditable change history in the hub, whether or not it has been posted
  // to QBO. (Posted rows additionally raise the higher-severity, emailed
  // changed_after_posting alert below, which compares against the frozen posted
  // snapshot rather than the previous sync.)
  if (existing?.currentSnapshotJson) {
    const changeDiffs = diffSnapshots(
      existing.currentSnapshotJson as Record<string, unknown>,
      s.snapshot
    );
    if (changeDiffs.length > 0) {
      await recordRowChange(
        ctx.run.id,
        existing.id,
        `Row edited since last sync — ${changeDiffs.map((d) => d.field).join(", ")}`,
        existing.currentSnapshotJson,
        s.snapshot,
        changeDiffs
      );
      ctx.summary.rowsChangedSinceLastSync++;
    }
  }

  const baseData = {
    spreadsheetId: s.snapshot.spreadsheetId as string,
    sheetGid: s.sheetGid,
    tabName,
    rowNumberLastSeen: row.rowNumber,
    rowUuid: s.rowUuid,
    lastSeenAt: new Date(),
    date: row.date,
    rcvByOrPaidTo: row.rcvByOrPaidTo || null,
    name: row.name || null,
    purpose: row.purpose || null,
    invNumber: row.invNumber || null,
    backup: row.backup || null,
    approvedBy: row.approvedBy || null,
    amtCollected: dec(row.amtCollected),
    amountPaidOut: dec(row.amountPaidOut),
    bankDeposit: dec(row.bankDeposit),
    cashBalanceEnvelope: dec(row.cashBalanceEnvelope),
    amountType: row.amountType,
    normalizedFingerprint: s.fingerprint,
    currentHash: s.hash,
    currentSnapshotJson: s.snapshot as Prisma.InputJsonValue,
  };

  if (wasPosted && existing) {
    if (isChangedAfterPosting(existing.originalHash, s.hash)) {
      const diffs = diffSnapshots(
        (existing.originalSnapshotJson as Record<string, unknown>) ?? null,
        s.snapshot
      );
      await prisma.sheetRow.update({
        where: { id: existing.id },
        data: { ...baseData, status: RowStatus.ChangedAfterPosting, statusReason: "Row edited after posting" },
      });
      await recordEvent(ctx.run.id, existing.id, "changed_after_posting", "Hash drift after posting", {
        diff: diffs,
      });
      await sendCritical(
        "changed_after_posting",
        `⚠️ Cash Sheet row CHANGED after posting — ${tabName} row ${row.rowNumber}`,
        changedBody(tabName, row, existing.qboTransactionId, diffs),
        existing.id,
        ctx.run.id
      );
      ctx.summary.changedAfterPosting++;
    } else {
      // Unchanged posted row: just refresh last-seen + row number (a move).
      await prisma.sheetRow.update({ where: { id: existing.id }, data: baseData });
    }
    ctx.summary.rowsSkipped++;
    return; // never re-post or edit QBO for an already-posted row (§10, §22)
  }

  // Not yet posted — classify & decide.
  // Start-date ignore (normal mode only, §3).
  if (!ctx.backfill && !isOnOrAfterStartDate(row.date, ctx.startDate)) {
    await upsertRow(existing?.id, baseData, RowStatus.IgnoredBeforeStartDate, "Dated before automation start");
    ctx.summary.rowsSkipped++;
    return;
  }

  const validation = validateRow(row, ctx.startDate);
  if (!validation.valid) {
    await upsertRow(existing?.id, baseData, RowStatus.Error, validation.errors.join("; "));
    ctx.summary.rowsError++;
    return;
  }

  // Duplicate row id (§10).
  if (!s.synthetic && ctx.dupRowIds.has(s.rowUuid)) {
    await upsertRow(existing?.id, baseData, RowStatus.DuplicateRowId, "Hidden row id appears on multiple rows");
    await recordEvent(ctx.run.id, existing?.id ?? null, "duplicate_row_id", `Row UUID ${s.rowUuid} duplicated`);
    ctx.summary.rowsWarning++;
    return;
  }

  // Possible duplicate vs already-posted rows (§10).
  const dup = findPossibleDuplicate(s.synthetic ? null : s.rowUuid, s.fingerprint, ctx.postedRefs);
  if (dup) {
    await upsertRow(existing?.id, baseData, RowStatus.PossibleDuplicate, `Matches posted QBO txn ${dup.qboTransactionId}`);
    ctx.summary.possibleDuplicates++;
    return;
  }

  const plan = buildPostingPlan(row, ctx.mappings, ctx.accounts);

  // Save the classified status first.
  const saved = await upsertRow(existing?.id, baseData, plan.status, plan.warnings.join("; ") || null);

  if (plan.warnings.length > 0) ctx.summary.rowsWarning++;

  // Audit-only INV rows: attempt a QBO match, never create revenue (§6B, §19).
  if (plan.action === "audit_only") {
    ctx.summary.auditOnly++;
    if (plan.invoiceMatching && ctx.credsValid) {
      const match = await safe(() => findInvoiceMatch(row, ctx.environment), { found: false, candidates: [] });
      if (match.found) {
        await prisma.sheetRow.update({
          where: { id: saved.id },
          data: { status: RowStatus.AuditOnly, statusReason: `Matched QBO ${match.candidates[0]?.type} ${match.candidates[0]?.id}`, qboTransactionId: null },
        });
        await recordEvent(ctx.run.id, saved.id, "qbo_match_found", `Matched ${match.candidates.length} candidate(s)`, match);
      } else {
        await prisma.sheetRow.update({
          where: { id: saved.id },
          data: { status: RowStatus.AwaitingQboMatch, statusReason: "QBO Match Not Found — audit only" },
        });
        ctx.summary.awaitingQboMatch++;
      }
    } else {
      ctx.summary.awaitingQboMatch++;
    }
    return;
  }

  if (plan.status === RowStatus.UnknownPurpose) {
    ctx.summary.unknownPurpose++;
    return;
  }
  if (plan.blockers.length > 0) {
    // Missing account/payee mapping etc. — already reflected in plan.status.
    return;
  }

  // ---- Rollout gate (§12) ----
  const gate = canPostRow({
    stage: ctx.stage,
    credentialsValid: ctx.credsValid,
    mappingRequiresApproval: plan.requiresManualApproval,
    // Approvals are applied via the dashboard (owner_admin) and persisted on the
    // row; the gate honors them here at the next sync.
    rowApproved: !!existing?.approvedAt,
  });

  if (!gate.allowed) {
    // Dry-run / awaiting approval / no creds → leave as Ready/queued for review.
    await prisma.sheetRow.update({
      where: { id: saved.id },
      data: { status: RowStatus.ReadyToPost, statusReason: `Not posted: ${gate.reason}` },
    });
    ctx.summary.rowsSkipped++;
    return;
  }

  // ---- Post to QBO ----
  const result = await postPlan(plan, row, tabName, s.rowUuid, gate.environment!);
  await prisma.$transaction([
    prisma.qboTransaction.create({
      data: {
        sheetRowId: saved.id,
        syncRunId: ctx.run.id,
        qboCompanyId: gate.environment === "live" ? "live-realm" : "sandbox-realm",
        qboEnvironment: gate.environment!,
        qboTransactionId: result.qboTransactionId,
        qboTransactionType: result.qboTransactionType,
        qboSyncToken: result.qboSyncToken,
        qboDocNumber: result.qboDocNumber,
        requestJsonRedacted: result.requestRedacted as Prisma.InputJsonValue,
        responseJsonRedacted: result.responseRedacted as Prisma.InputJsonValue,
      },
    }),
    prisma.sheetRow.update({
      where: { id: saved.id },
      data: {
        status: plan.warnings.length > 0 ? RowStatus.PostedWithWarning : RowStatus.Posted,
        statusReason: plan.warnings.join("; ") || null,
        qboTransactionId: result.qboTransactionId,
        qboTransactionType: result.qboTransactionType,
        qboAccountId: plan.categoryAccountId ?? plan.cashAccountId ?? null,
        qboPostedAt: new Date(),
        // Freeze the ORIGINAL snapshot/hash at posting time (§11).
        originalHash: s.hash,
        originalSnapshotJson: s.snapshot as Prisma.InputJsonValue,
      },
    }),
  ]);
  await recordEvent(ctx.run.id, saved.id, "posted", `${result.qboTransactionType} ${result.qboTransactionId}`);
  ctx.summary.rowsPosted++;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

async function upsertRow(
  id: string | undefined,
  baseData: Record<string, unknown>,
  status: string,
  statusReason: string | null
) {
  if (id) {
    return prisma.sheetRow.update({ where: { id }, data: { ...baseData, status, statusReason } as any });
  }
  return prisma.sheetRow.create({
    data: { ...baseData, status, statusReason, firstSeenAt: new Date() } as any,
  });
}

async function handleRemoved(spreadsheetId: string, rowUuid: string, runId: string, summary: RunSummary) {
  const row = await prisma.sheetRow.findUnique({ where: { spreadsheetId_rowUuid: { spreadsheetId, rowUuid } } });
  if (!row || row.status === RowStatus.RemovedFromSheetAfterPosting) return;
  await prisma.sheetRow.update({
    where: { id: row.id },
    data: { status: RowStatus.RemovedFromSheetAfterPosting, removedFromSheetAt: new Date(), statusReason: "Posted row disappeared from sheet" },
  });
  await recordEvent(runId, row.id, "removed_after_posting", `Posted row ${rowUuid} vanished from ${row.tabName}`);
  await sendCritical(
    "removed_after_posting",
    `⚠️ Cash Sheet row REMOVED after posting — ${row.tabName}`,
    `A row previously posted to QBO (txn ${row.qboTransactionId}) has disappeared from the sheet.\nTab: ${row.tabName}\nGCD Row ID: ${rowUuid}\nQBO is unchanged (never auto-edited/deleted). Please investigate.`,
    row.id,
    runId
  );
  summary.removedAfterPosting++;
}

async function loadMappings(): Promise<MappingLike[]> {
  const rows = await prisma.purposeMapping.findMany({ where: { active: true } });
  return rows.map((m) => ({
    normalizedPurpose: m.normalizedPurpose,
    amountType: m.amountType,
    qboAction: m.qboAction,
    qboAccountName: m.qboAccountName,
    qboAccountId: m.qboAccountId,
    postToQbo: m.postToQbo,
    auditOnly: m.auditOnly,
    requiresPayee: m.requiresPayee,
    requiresManualApproval: m.requiresManualApproval,
    invoiceMatching: m.invoiceMatching,
    active: m.active,
  }));
}

async function loadAccounts(): Promise<AccountMappingLike[]> {
  const rows = await prisma.accountMapping.findMany({ where: { active: true } });
  return rows.map((a) => ({
    friendlyName: a.friendlyName,
    qboAccountId: a.qboAccountId,
    qboAccountName: a.qboAccountName,
    active: a.active,
  }));
}

function dec(n: number | null): Prisma.Decimal | null {
  return n === null ? null : new Prisma.Decimal(n);
}

function findControlColumn(headerRow: unknown[] | undefined): number | null {
  if (!headerRow) return null;
  for (let c = 0; c < headerRow.length; c++) {
    if (String(headerRow[c] ?? "").trim() === CONTROL_KEYS.rowId) return c;
  }
  return null;
}

async function recordEvent(
  syncRunId: string | null,
  sheetRowId: string | null,
  eventType: string,
  message: string,
  data?: unknown
) {
  await prisma.rowEvent.create({
    data: {
      syncRunId,
      sheetRowId,
      eventType,
      eventMessage: message,
      diffJson: data ? (data as Prisma.InputJsonValue) : undefined,
    },
  });
}

/**
 * Append a `row_changed` audit event for a cell edit detected between two daily
 * syncs (§11). Unlike recordEvent it fills the RowEvent before/after columns so
 * the hub can render a full "was → now" per-field diff for the row's history.
 * Append-only; never updated or deleted.
 */
async function recordRowChange(
  syncRunId: string,
  sheetRowId: string,
  message: string,
  before: unknown,
  after: unknown,
  diff: unknown
) {
  await prisma.rowEvent.create({
    data: {
      syncRunId,
      sheetRowId,
      eventType: "row_changed",
      eventMessage: message,
      beforeJson: (before ?? undefined) as Prisma.InputJsonValue | undefined,
      afterJson: (after ?? undefined) as Prisma.InputJsonValue | undefined,
      diffJson: (diff ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

async function failRun(runId: string, message: string) {
  await prisma.syncRun.update({
    where: { id: runId },
    data: { finishedAt: new Date(), status: "error", summaryJson: { error: message } },
  });
}

async function sendCritical(
  alertType: string,
  subject: string,
  body: string,
  sheetRowId: string,
  syncRunId: string
) {
  const recipient = ALERT_RECIPIENTS.critical();
  const outcome = await sendEmail({ to: recipient, subject, text: body });
  await prisma.alert.create({
    data: {
      alertType,
      severity: "critical",
      recipient,
      subject,
      body,
      status: outcome.ok ? "sent" : "failed",
      sentAt: outcome.ok ? new Date() : null,
      relatedSheetRowId: sheetRowId,
      relatedSyncRunId: syncRunId,
    },
  });
}

async function sendDailySummary(summary: RunSummary) {
  const recipient = ALERT_RECIPIENTS.errorSummary();
  const appUrl = process.env.PUBLIC_APP_URL ?? "";
  const body = [
    `GCD QBO Cash Sheet Sync — run ${summary.syncRunId}`,
    `Mode: ${summary.mode} · Stage: ${summary.rolloutStage} · Env: ${summary.environment}`,
    summary.setupRequired ? "⚠️ SETUP REQUIRED: QBO credentials missing/invalid — ran validation only." : "",
    "",
    `Rows scanned:      ${summary.rowsScanned}`,
    `Posted:            ${summary.rowsPosted}`,
    `Skipped:           ${summary.rowsSkipped}`,
    `Errors:            ${summary.rowsError}`,
    `Warnings:          ${summary.rowsWarning}`,
    `Audit-only (INV):  ${summary.auditOnly}`,
    `Awaiting QBO match:${summary.awaitingQboMatch}`,
    `Unknown purpose:   ${summary.unknownPurpose}`,
    `Possible dupes:    ${summary.possibleDuplicates}`,
    `Duplicate row ids: ${summary.duplicateRowIds}`,
    `Changed after post:${summary.changedAfterPosting}`,
    `Removed after post:${summary.removedAfterPosting}`,
    `Edited since last sync:${summary.rowsChangedSinceLastSync}`,
    "",
    appUrl ? `Dashboard: ${appUrl}/cash-sheet-sync` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const outcome = await sendEmail({ to: recipient, subject: "GCD QBO Cash Sheet Sync — daily summary", text: body });
  await prisma.alert.create({
    data: {
      alertType: "daily_summary",
      severity: "info",
      recipient,
      subject: "GCD QBO Cash Sheet Sync — daily summary",
      body,
      status: outcome.ok ? "sent" : "failed",
      sentAt: outcome.ok ? new Date() : null,
      relatedSyncRunId: summary.syncRunId,
    },
  });
}

function changedBody(tabName: string, row: ParsedRow, qboTxnId: string | null, diffs: unknown[]): string {
  return [
    `A Cash Sheet row was CHANGED after it had been posted to QBO.`,
    `Tab: ${tabName} · Row ${row.rowNumber} · Date ${formatDate(row.date)}`,
    `QBO transaction: ${qboTxnId ?? "(unknown)"} — NOT modified (QBO is never auto-edited).`,
    ``,
    `Field changes:`,
    JSON.stringify(diffs, null, 2),
  ].join("\n");
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
