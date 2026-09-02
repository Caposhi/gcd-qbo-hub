"use server";

/**
 * Deposit Reconciliation — server actions (file reception center).
 *
 * Owner-admins drop processor CSVs; we parse them into proposed deposits and
 * persist them (dep_ tables). No QBO posting happens here — this is the
 * "propose" rung: it shows exactly what each deposit should contain, gated by
 * the exact-sum checksum in the reconstruction (unresolved payouts are flagged
 * needs_review, never proposed).
 */
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth/session";
import { buildProposalsFromFiles, type NamedFile } from "@/lib/deposits/ingest";
import { buildPayoutIndexes, resolveMatch, findDuplicateIds } from "@/lib/deposits/reconcile-match";

const dec = (n: number) => new Prisma.Decimal(n.toFixed(2));

/** One payout as freshly parsed from the dropped files, normalized to the
 *  shape reconcileParsedPayouts needs regardless of which list it came from
 *  (a resolved deposit vs. a still-unresolved Tekmetric payout). */
interface ParsedPayout {
  processor: string;
  sourceRef: string | null;
  settlementDate: string;
  gross: number;
  fee: number;
  net: number;
  status: "proposed" | "needs_review";
  deltaCents: number;
  lines: Array<{ amount: number; fee?: number; brand: string; ref?: string }>;
}

export interface ReconcileOutcome {
  created: number;
  updated: number;
  unchanged: number;
  skippedPosted: number;
}

/** Shape reconcileParsedPayouts actually reads off an existing DepPayout —
 *  spelled out explicitly rather than inferred through Prisma's generic
 *  `include` typing, which stays stable regardless of the environment's
 *  Prisma client generation state. */
interface ExistingPayout {
  id: string;
  processor: string;
  sourceRef: string | null;
  settlementDate: string;
  status: string;
  deltaCents: number | null;
  qboDepositId: string | null;
  grossAmount: number | string;
  feeAmount: number | string;
  netAmount: number | string;
  lines: Array<{ amount: number | string }>;
}

/**
 * Upsert freshly-parsed payouts against whatever's already in the DB, by
 * payoutKey — this is what makes re-dropping the same files (or the same
 * files after a bug fix in the parsing logic) safe and useful to do anytime,
 * instead of the old all-or-nothing "already imported, does nothing":
 *
 *   - Already posted to QBO (qboDepositId set) → NEVER touched, no matter
 *     what the fresh parse says. Posted history is immutable (§10, §22).
 *   - Exists, not posted, values differ → updated in place (status, gross/
 *     fee/net, lines replaced). A row that was `needs_review` can become
 *     `proposed` this way once the underlying bug is fixed, and vice versa
 *     if a regression ever made things worse — the truth is always "what
 *     the current files + current logic say right now".
 *   - Exists, not posted, values identical → left alone, counted separately
 *     so the summary can say "12 unchanged" instead of implying 12 updates.
 *   - New key → created.
 *
 * Never touches QBO — this only maintains the hub's own proposed-deposit
 * records.
 */
export async function reconcileParsedPayouts(parsed: ParsedPayout[], importId: string | null): Promise<ReconcileOutcome> {
  const existing = (await prisma.depPayout.findMany({
    where: {},
    include: { lines: true },
  })) as unknown as ExistingPayout[];
  const indexed = existing.map((p) => ({ ...p, netAmount: Number(p.netAmount) }));
  const indexes = buildPayoutIndexes(indexed);
  const claimedFallbacks = new Set<string>();

  const outcome: ReconcileOutcome = { created: 0, updated: 0, unchanged: 0, skippedPosted: 0 };

  for (const d of parsed) {
    const match = resolveMatch(d, indexes, claimedFallbacks);

    if (!match) {
      await prisma.depPayout.create({
        data: {
          importId,
          processor: d.processor,
          settlementDate: d.settlementDate,
          grossAmount: dec(d.gross),
          feeAmount: dec(d.fee),
          netAmount: dec(d.net),
          status: d.status,
          deltaCents: d.status === "proposed" ? 0 : d.deltaCents,
          sourceRef: d.sourceRef,
          lines: { create: d.lines.map((l) => ({ amount: dec(l.amount), feeAmount: l.fee ? dec(l.fee) : null, brand: l.brand || null, ref: l.ref || null })) },
        },
      });
      outcome.created++;
      continue;
    }

    if (match.qboDepositId) {
      // Matched to an already-posted payout — its amounts/status/lines are
      // immutable, never touched. But if it was found via the fallback (its
      // stored sourceRef differs from this fresh parse's), self-heal just the
      // sourceRef so a future ingest hits the primary key directly instead of
      // needing the fallback — and, more importantly, so it never again
      // reads as "no match" and creates a duplicate row for this same real
      // payout under yet another sourceRef format.
      if (match.sourceRef !== d.sourceRef) {
        await prisma.depPayout.update({ where: { id: match.id }, data: { sourceRef: d.sourceRef } });
      }
      outcome.skippedPosted++;
      continue;
    }

    // Compare in cents — floats derived from Decimal storage vs. fresh
    // reconstruction arithmetic can differ by fractions of a cent even when
    // nothing actually changed, which would otherwise churn "unchanged" into
    // a false "updated" on every single reprocess.
    const centsEq = (a: number, b: number) => Math.round(a * 100) === Math.round(b * 100);
    const sameTotals =
      match.status === d.status &&
      match.sourceRef === d.sourceRef &&
      (match.deltaCents ?? 0) === d.deltaCents &&
      centsEq(Number(match.grossAmount), d.gross) &&
      centsEq(Number(match.feeAmount), d.fee) &&
      centsEq(Number(match.netAmount), d.net) &&
      match.lines.length === d.lines.length &&
      match.lines.every((l, i) => centsEq(Number(l.amount), d.lines[i]?.amount ?? NaN));
    if (sameTotals) {
      outcome.unchanged++;
      continue;
    }

    const sourceRefChanged = match.sourceRef !== d.sourceRef;
    await prisma.depPayout.update({
      where: { id: match.id },
      data: {
        grossAmount: dec(d.gross),
        feeAmount: dec(d.fee),
        netAmount: dec(d.net),
        status: d.status,
        deltaCents: d.status === "proposed" ? 0 : d.deltaCents,
        // Self-heal to the freshest sourceRef so the NEXT ingest's primary
        // key-based lookup hits directly instead of needing the fallback again.
        sourceRef: d.sourceRef,
        // Old match state (from a prior Locate run) no longer applies once the
        // reconstruction itself changed — re-running Locate is cheap and safe.
        lines: { deleteMany: {}, create: d.lines.map((l) => ({ amount: dec(l.amount), feeAmount: l.fee ? dec(l.fee) : null, brand: l.brand || null, ref: l.ref || null })) },
      },
    });
    await prisma.depEvent.create({
      data: {
        payoutId: match.id,
        eventType: "reprocessed",
        message:
          `Updated by reprocess: ${match.status} → ${d.status}${d.status === "needs_review" ? ` (Δ ${(d.deltaCents / 100).toFixed(2)})` : ""}.` +
          (sourceRefChanged ? ` Source ref changed ${match.sourceRef ?? "(none)"} → ${d.sourceRef ?? "(none)"} (matched by settlement date + net amount).` : ""),
      },
    });
    outcome.updated++;
  }

  return outcome;
}

/**
 * Parse dropped files into the flat ParsedPayout shape reconcileParsedPayouts
 * upserts against. Pure translation — buildProposalsFromFiles does the real
 * parsing/reconstruction work.
 */
function toParsedPayouts(result: ReturnType<typeof buildProposalsFromFiles>): ParsedPayout[] {
  const resolved: ParsedPayout[] = [...result.paymentechDeposits, ...(result.tekmetric?.deposits ?? [])].map((d) => ({
    processor: d.processor,
    sourceRef: d.sourceRef ?? null,
    settlementDate: d.settlementDate,
    gross: d.gross,
    fee: d.fee,
    net: d.net,
    status: "proposed",
    deltaCents: 0,
    lines: d.lines,
  }));
  const unresolved: ParsedPayout[] = (result.tekmetric?.unresolved ?? []).map((u) => ({
    processor: "tekmetric",
    sourceRef: u.payout.traceId ?? u.payout.id,
    settlementDate: u.payout.arrivalDate,
    gross: 0,
    fee: 0,
    net: u.payout.amount,
    status: "needs_review",
    deltaCents: u.deltaCents,
    lines: [],
  }));
  return [...resolved, ...unresolved];
}

/**
 * Drop CSVs → proposed deposits. Safe to run on the same files anytime —
 * first time or the fiftieth, before or after a parsing bug fix — since it
 * always re-parses and reconciles against what's actually in the DB right
 * now (reconcileParsedPayouts) rather than silently no-op'ing on a
 * previously-seen file hash. The fileHash is still recorded (one DepImport
 * row per distinct file set, for audit/provenance), but it no longer gates
 * whether payouts get refreshed.
 */
export async function ingestDepositFilesAction(formData: FormData) {
  const user = await requirePermission("edit_mappings");

  const entries = formData.getAll("files");
  const named: NamedFile[] = [];
  for (const e of entries) {
    if (e && typeof e === "object" && "text" in e && typeof e.text === "function" && e.size > 0) {
      named.push({ name: e.name || "upload.csv", text: await e.text() });
    }
  }
  if (named.length === 0) return;

  const combined = named.map((f) => `${f.name}::${f.text}`).sort().join("\n---\n");
  const fileHash = createHash("sha256").update(combined).digest("hex");
  const result = buildProposalsFromFiles(named);
  const processors = new Set<string>();
  if (result.paymentechDeposits.length) processors.add("paymentech");
  if (result.tekmetric) processors.add("tekmetric");

  let imp = await prisma.depImport.findUnique({ where: { fileHash } });
  const isReprocess = !!imp;
  if (!imp) {
    imp = await prisma.depImport.create({
      data: {
        processor: [...processors].join("+") || "unknown",
        fileHash,
        rowCount: named.length,
        importedByEmail: user.email,
      },
    });
  }

  // A charges-only drop (one payout's transactions, exported to fix a payout the
  // main files couldn't reconstruct) completes an existing row rather than
  // creating one: match the whole set to an unresolved payout by exact net, then
  // send it through the SAME reconcile path so it lands as an update.
  const parsed = toParsedPayouts(result);
  if (result.chargesOnly && result.chargesOnly.length > 0) {
    const { backfillPayoutFromCharges } = await import("@/lib/deposits/stripe");
    const candidates = (await prisma.depPayout.findMany({
      where: { processor: "tekmetric", qboDepositId: null },
      include: { lines: true },
    })) as unknown as Array<{
      id: string;
      sourceRef: string | null;
      settlementDate: string;
      netAmount: number | string;
      lines: unknown[];
    }>;
    // Only payouts with nothing attached yet — never re-open one that already
    // reconstructed cleanly.
    const openOnes = candidates
      .filter((c) => c.lines.length === 0)
      .map((c) => ({
        id: c.id,
        sourceRef: c.sourceRef,
        settlementDate: c.settlementDate,
        netAmount: Number(c.netAmount),
      }));
    const back = backfillPayoutFromCharges(result.chargesOnly, openOnes);
    const t = back.totals;
    if (back.deposit) {
      parsed.push({
        processor: "tekmetric",
        settlementDate: back.deposit.settlementDate,
        sourceRef: back.deposit.sourceRef ?? null,
        gross: back.deposit.gross,
        fee: back.deposit.fee,
        net: back.deposit.net,
        status: "proposed",
        deltaCents: 0,
        lines: back.deposit.lines.map((l) => ({ amount: l.amount, fee: l.fee, brand: l.brand, ref: l.ref })),
      });
      result.notes.push(
        `Matched ${t.count} charge(s) (gross ${t.gross.toFixed(2)} − fees ${t.fee.toFixed(2)} = ${t.net.toFixed(
          2
        )}) to the ${back.deposit.settlementDate} payout and filled in its charges.`
      );
    } else if (back.matchCount > 1) {
      result.notes.push(
        `Those ${t.count} charge(s) net to ${t.net.toFixed(2)}, which matches ${back.matchCount} payouts awaiting charges — ambiguous, so nothing was changed. Re-drop with the payouts file to disambiguate.`
      );
    } else {
      result.notes.push(
        `Those ${t.count} charge(s) net to ${t.net.toFixed(2)} (gross ${t.gross.toFixed(2)} − fees ${t.fee.toFixed(
          2
        )}), which doesn't equal any payout still awaiting charges${
          openOnes.length ? ` (${openOnes.map((o) => `${o.settlementDate}: ${o.netAmount.toFixed(2)}`).join(", ")})` : " — there are none"
        }. Nothing was changed.`
      );
    }
  }

  const outcome = await reconcileParsedPayouts(parsed, imp.id);
  // Belt-and-suspenders: reconcileParsedPayouts' own fallback matching stops
  // most duplicates from being CREATED, but a row already sitting in the DB
  // from before that fix (or from any other path that slipped past it) still
  // needs a sweep to actually merge away — run it on every ingest so that
  // never needs a separate manual "Clean up duplicates" click.
  const duplicatesRemoved = await dedupePayouts();

  await prisma.depEvent.create({
    data: {
      eventType: "ingest_reconcile",
      message:
        `${isReprocess ? "Reprocessed" : "Ingested"} ${named.map((f) => f.name).join(", ")}: ` +
        `${outcome.created} created, ${outcome.updated} updated, ${outcome.unchanged} unchanged` +
        (outcome.skippedPosted ? `, ${outcome.skippedPosted} skipped (already posted to QBO)` : "") +
        (duplicatesRemoved ? `, ${duplicatesRemoved} duplicate(s) removed` : "") +
        ` · by ${user.email}.`,
    },
  });

  if (result.notes.length) {
    await prisma.depEvent.create({
      data: { eventType: "ingest_note", message: result.notes.join(" ") },
    });
  }

  revalidatePath("/deposit-reconciliation");
}

/**
 * Find and remove duplicate payouts: same processor + source ref, OR same
 * processor + settlement date + net amount under a DIFFERENT sourceRef (see
 * reconcile-match.ts's buildPayoutIndexes comment for why a real payout's
 * sourceRef can change between exports of the same processor file) — keeping
 * the earliest, and never touching one already posted to QBO. Shared core
 * for both the manual "Clean up duplicates" button and the automatic pass
 * ingestDepositFilesAction runs after every ingest: reconcileParsedPayouts'
 * own fallback matching prevents most NEW duplicates going forward, but it
 * only ever looks at the fresh parse against what's already in the DB — it
 * can't retroactively merge two rows for the same real payout that were
 * already created before a sourceRef-format change was noticed. Running this
 * after every ingest means that never requires a separate manual step.
 */
async function dedupePayouts(): Promise<number> {
  const all = await prisma.depPayout.findMany({ orderBy: { createdAt: "asc" } });
  const dupeIds = findDuplicateIds(all.map((p) => ({ ...p, netAmount: Number(p.netAmount) })));
  if (dupeIds.length) {
    await prisma.depPayout.deleteMany({ where: { id: { in: dupeIds } } }); // lines/events cascade
  }
  return dupeIds.length;
}

/** Manual "Clean up duplicates" button — one-time sweep for payouts created
 *  before ingest was made dedupe-aware, or in case anything ever slips past
 *  the automatic post-ingest pass. */
export async function cleanupDuplicatePayoutsAction() {
  await requirePermission("edit_mappings");
  const removed = await dedupePayouts();
  await prisma.depEvent.create({
    data: { eventType: "dedupe", message: `Removed ${removed} duplicate payout(s).` },
  });
  revalidatePath("/deposit-reconciliation");
}

/**
 * Read-only "propose" step: for every proposed payout, confirm each gross charge
 * maps to a real Undeposited-Funds payment in QBO (by amount, within a window
 * around the settlement date). Records a DIAGNOSTIC event per payout — which
 * amounts were found (and how many candidates) vs. missing — so a "needs review"
 * result is explainable, not a black box. Marks the matched payment id on each
 * line; flips the payout to `matched` (all found) or `needs_review`. Never
 * writes to QBO.
 */
export async function locateProposedPaymentsAction() {
  await requirePermission("edit_mappings");
  const { getQboEnvironment } = await import("@/lib/config-store");
  const { getContext } = await import("@/lib/qbo/client");
  const { findPaymentsByAmount, findPaymentsInRange, shiftDate, getPaymentDetails } = await import("@/lib/deposits/qbo-lookup");
  const { collectDepositedPaymentMap, findPaymentsInWindow } = await import("@/lib/qbo/deposits");
  const { findFeeJournalEntries, matchFees } = await import("@/lib/qbo/journal-entries");
  const { findConsolidatedMatch } = await import("@/lib/deposits/consolidation");

  // Terminal-keying discrepancy tolerance: the amount charged at the Chase
  // terminal can differ from the RO/QBO payment by a small typo. Match within
  // this band and book the difference to Cash over/short at deposit time.
  const KEYING_TOLERANCE = 5.0;

  const environment = await getQboEnvironment();
  const ctx = await getContext(environment);

  const payoutsRaw = await prisma.depPayout.findMany({
    where: { status: { in: ["proposed", "needs_review", "matched"] } },
    include: { lines: true },
  });
  // Deterministic order (oldest settlement first) so the global no-reuse guard
  // assigns each shared-amount payment stably.
  const payouts = payoutsRaw.sort(
    (a, b) => a.settlementDate.localeCompare(b.settlementDate) || a.id.localeCompare(b.id)
  );

  // A payment can back only ONE payout — across the whole run AND across
  // deposits already created — so two batches never claim the same
  // Undeposited-Funds payment (the collision a wide amount search could cause).
  // Seed from payments already on created deposits.
  const globalUsed = new Set<string>();
  const createdLines = await prisma.depPayoutLine.findMany({
    where: { matchedQboTxnId: { not: null }, payout: { status: "created" } },
    select: { matchedQboTxnId: true },
  });
  for (const l of createdLines) if (l.matchedQboTxnId) globalUsed.add(l.matchedQboTxnId);

  // Payments ALREADY on a QBO deposit (from any source, incl. prior manual
  // reconciliation) over the full candidate span — a batch whose payments are
  // all here is already reconciled, so we surface "already deposited" instead of
  // a false "matched" that would only get blocked at create time.
  let depositedIds = new Set<string>();
  let depositedMap = new Map<string, string>(); // paymentId → the Deposit it's on
  let feeJEs: Awaited<ReturnType<typeof findFeeJournalEntries>> = [];
  const settleDates = payouts.map((p) => p.settlementDate).filter(Boolean).sort();
  if (settleDates.length) {
    const spanStart = shiftDate(settleDates[0], -8);
    const spanEnd = shiftDate(settleDates[settleDates.length - 1], 4);
    depositedMap = await collectDepositedPaymentMap(ctx, spanStart, spanEnd);
    depositedIds = new Set(depositedMap.keys());
    feeJEs = await findFeeJournalEntries(ctx, spanStart, spanEnd);
  }
  // Fee JEs claimed this run (a JE backs only one payout).
  const feeUsedGlobal = new Set<string>();

  const daysApart = (a: string, b: string) =>
    Math.abs((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000);

  let payoutsMatched = 0;
  let payoutsReview = 0;
  let payoutsAlreadyDeposited = 0;

  for (const p of payouts) {
    if (p.lines.length === 0) continue; // unresolved reconstruction — nothing to locate
    // Processor-specific look-back: a card sale is PAID in QBO on the sale date
    // but Paymentech settles it into a batch several days later (e.g. a 07/17
    // sale in the 07/21 batch, over a weekend), so the payment can predate the
    // batch by up to ~6 days. Tekmetric charges settle the next day. The global
    // no-reuse guard + nearest-date preference keep same-amount payments apart.
    const start = shiftDate(p.settlementDate, -6);
    const end = shiftDate(p.settlementDate, 2);
    const detail: Array<{ amount: number; found: boolean; alreadyDeposited?: boolean; depositId?: string; group?: number; matchedAmount?: number; delta?: number; candidates: number }> = [];
    const matchedPaymentIds: string[] = [];
    let foundCount = 0;
    let depositedCount = 0;
    let consolidatedCount = 0;
    const ambiguousCharges: string[] = [];

    // Paymentech can consolidate several same-card charges into one settlement
    // line; fetch the whole window's payments once so a charge with no single
    // match can fall back to the same-customer group that sums to it.
    const windowPool =
      p.processor !== "tekmetric" ? await findPaymentsInWindow(ctx, start, end) : [];

    for (const line of p.lines) {
      const amt = Number(line.amount);
      // Candidate pool: exact amount first; widen to the keying band only if no
      // available exact match. "Available" = not claimed this run AND not already
      // on a QBO deposit.
      const exact = await findPaymentsByAmount(ctx, amt, start, end);
      let pool = exact;
      const availExact = exact
        .filter((c) => !globalUsed.has(c.id) && !depositedIds.has(c.id))
        .sort((a, b) => daysApart(a.date, p.settlementDate) - daysApart(b.date, p.settlementDate));
      let pick = availExact[0];
      if (!pick) {
        const near = await findPaymentsInRange(ctx, amt - KEYING_TOLERANCE, amt + KEYING_TOLERANCE, start, end);
        pool = exact.concat(near);
        pick = near
          .filter((c) => !globalUsed.has(c.id) && !depositedIds.has(c.id))
          .sort(
            (a, b) =>
              Math.abs(a.amount - amt) - Math.abs(b.amount - amt) ||
              daysApart(a.date, p.settlementDate) - daysApart(b.date, p.settlementDate)
          )[0];
      }

      // Paymentech only: if no single payment matched, try the same-card
      // consolidation group that sums to this charge (available payments only).
      let consolidated: ReturnType<typeof findConsolidatedMatch>["match"] = null;
      let consolidatedAmbiguous = false;
      if (!pick && p.processor !== "tekmetric") {
        const available = windowPool
          .filter((c) => !globalUsed.has(c.id) && !depositedIds.has(c.id))
          .map((c) => ({ id: c.id, amount: c.amount, customer: c.customerName ?? "" }));
        const res = findConsolidatedMatch(amt, available);
        consolidated = res.match;
        consolidatedAmbiguous = !res.match && res.ambiguous.length > 0;
      }

      if (pick) {
        globalUsed.add(pick.id);
        matchedPaymentIds.push(pick.id);
        foundCount++;
        detail.push({ amount: amt, found: true, matchedAmount: pick.amount, delta: Number((amt - pick.amount).toFixed(2)), candidates: pool.length });
        await prisma.depPayoutLine.update({
          where: { id: line.id },
          data: { matchedQboTxnId: pick.id, matchedQboTxnIds: [pick.id], matchedQboTxnType: "Payment" },
        });
      } else if (consolidated) {
        // A single charge made of several same-customer payments — link them all.
        for (const id of consolidated.ids) globalUsed.add(id);
        matchedPaymentIds.push(...consolidated.ids);
        foundCount++;
        consolidatedCount++;
        detail.push({ amount: amt, found: true, group: consolidated.ids.length, candidates: consolidated.ids.length });
        await prisma.depPayoutLine.update({
          where: { id: line.id },
          data: { matchedQboTxnId: consolidated.ids[0], matchedQboTxnIds: consolidated.ids, matchedQboTxnType: "Payment" },
        });
      } else if (pool.some((c) => depositedIds.has(c.id))) {
        // A payment of this amount exists but is already on a deposit → this
        // charge was reconciled previously. Capture which deposit swept it.
        depositedCount++;
        const depId = pool.map((c) => depositedMap.get(c.id)).find(Boolean);
        detail.push({ amount: amt, found: false, alreadyDeposited: true, depositId: depId, candidates: pool.length });
        await prisma.depPayoutLine.update({
          where: { id: line.id },
          data: { matchedQboTxnId: null, matchedQboTxnIds: [], matchedQboTxnType: null },
        });
      } else {
        if (consolidatedAmbiguous) ambiguousCharges.push(amt.toFixed(2));
        detail.push({ amount: amt, found: false, candidates: pool.length });
        await prisma.depPayoutLine.update({
          where: { id: line.id },
          data: { matchedQboTxnId: null, matchedQboTxnIds: [], matchedQboTxnType: null },
        });
      }
    }

    const foundAll = foundCount === p.lines.length;
    const allDeposited = depositedCount === p.lines.length && p.lines.length > 0;

    // Tekmetric: also confirm each charge's fee journal entry exists (by fee
    // amount) so "matched" means the full deposit (payments + fees) can be built.
    let feesNeeded = 0;
    let feesFound = 0;
    let feesAmountMatched = 0;
    let missingFeeCustomers: string[] = [];
    if (p.processor === "tekmetric" && foundAll) {
      // Confirm each charge's fee JE exists: by the payment's customer, falling
      // back to the charge's known fee amount when the name doesn't line up.
      const payDetails = await getPaymentDetails(ctx, matchedPaymentIds);
      const charges = p.lines.map((line, i) => ({
        customer: payDetails.get(matchedPaymentIds[i])?.customerName ?? "",
        feeAmount: line.feeAmount != null ? Number(line.feeAmount) : null,
      }));
      feesNeeded = charges.length;
      const { linked, missing, amountMatched } = matchFees(feeJEs, charges, p.settlementDate, feeUsedGlobal, daysApart);
      feesFound = linked.length;
      feesAmountMatched = amountMatched;
      missingFeeCustomers = missing.filter(Boolean);
    }
    const feesOk = p.processor !== "tekmetric" || feesFound === feesNeeded;

    const status = foundAll && feesOk ? "matched" : allDeposited ? "already_deposited" : "needs_review";
    if (status === "matched") payoutsMatched++;
    else if (status === "already_deposited") payoutsAlreadyDeposited++;
    else payoutsReview++;

    const missing = detail.filter((d) => !d.found && !d.alreadyDeposited).map((d) => d.amount.toFixed(2));
    const depositedAmounts = detail
      .filter((d) => d.alreadyDeposited)
      .map((d) => `${d.amount.toFixed(2)}${d.depositId ? ` on Deposit ${d.depositId}` : ""}`);
    const overShortCents = detail.reduce((s, d) => s + Math.round((d.delta ?? 0) * 100), 0);
    await prisma.depPayout.update({
      where: { id: p.id },
      data: { status, deltaCents: status === "matched" ? overShortCents : null },
    });
    const osNote = overShortCents !== 0 ? ` Over/short from keying: ${(overShortCents / 100).toFixed(2)} (booked to Cash over/short on deposit).` : "";
    const consolidatedNote = consolidatedCount ? ` ${consolidatedCount} charge(s) matched a same-card consolidation group.` : "";
    const ambiguousNote = ambiguousCharges.length
      ? ` Ambiguous consolidation for ${ambiguousCharges.join(", ")} — more than one same-customer group sums to it; resolve in QBO.`
      : "";
    const feeNote =
      p.processor === "tekmetric" && feesNeeded
        ? ` ${feesFound}/${feesNeeded} fee JEs located${feesAmountMatched ? ` (${feesAmountMatched} matched by fee amount — name differed in QBO)` : ""}.`
        : "";
    const message =
      foundAll && feesOk
        ? `All ${p.lines.length} charge payments located in Undeposited Funds (window ${start}…${end}).${consolidatedNote}${feeNote}${osNote}`
        : foundAll && !feesOk
          ? `Payments located, but only ${feesFound}/${feesNeeded} fee journal entries found${
              missingFeeCustomers.length ? ` — missing the fee JE for: ${missingFeeCustomers.join(", ")}` : ""
            }. Re-run once Back Office has posted them (or check that customer's fee JE name matches).`
          : allDeposited
            ? `Already reconciled — all ${p.lines.length} payments are on an existing QBO deposit. Nothing to do.`
            : `Located ${foundCount}/${p.lines.length}${
                depositedCount ? `, ${depositedCount} already deposited (${depositedAmounts.join(", ")})` : ""
              }; missing amounts: ${missing.join(", ") || "-"} (searched ${start}…${end}).${consolidatedNote}${ambiguousNote}`;
    await prisma.depEvent.create({
      data: {
        payoutId: p.id,
        eventType: "locate_payments",
        message,
        dataJson: { detail, start, end, overShortCents, missingFeeCustomers } as unknown as object,
      },
    });
  }

  await prisma.depEvent.create({
    data: {
      eventType: "locate_summary",
      message: `Locate run: ${payouts.length} payout(s) checked — ${payoutsMatched} matched, ${payoutsAlreadyDeposited} already deposited, ${payoutsReview} need review · env ${environment}`,
    },
  });

  revalidatePath("/deposit-reconciliation");
}

const daysApart = (a: string, b: string) =>
  Math.abs((new Date(`${a}T00:00:00Z`).getTime() - new Date(`${b}T00:00:00Z`).getTime()) / 86400000);

interface DepCreateContext {
  gateEnv: "sandbox" | "live";
  ctx: Awaited<ReturnType<typeof import("@/lib/qbo/client").getContext>>;
  chaseId: string;
  overShortId: string | null;
}

/** Resolve the shared context for creating deposits: rollout gate (never
 * dry-run, valid creds) + the Chase Checking / Cash over/short accounts + a live
 * QBO context. Returns a reason instead of throwing so single + batch surface it
 * the same way. */
async function prepareDepCreateContext(): Promise<{ ok: true; value: DepCreateContext } | { ok: false; reason: string }> {
  const { canPostRow } = await import("@/lib/cashsheet/rollout");
  const { getQboEnvironment, getRolloutStage } = await import("@/lib/config-store");
  const { hasValidCredentials } = await import("@/lib/qbo/oauth");
  const { getContext } = await import("@/lib/qbo/client");

  const stage = await getRolloutStage();
  const environment = await getQboEnvironment();
  const credsValid = await hasValidCredentials(environment);
  const gate = canPostRow({ stage, credentialsValid: credsValid, mappingRequiresApproval: false, rowApproved: true });
  if (!gate.allowed) return { ok: false, reason: `Not created: ${gate.reason}` };

  const chase = await prisma.accountMapping.findFirst({ where: { friendlyName: "Chase Checking 9680" } });
  if (!chase?.qboAccountId) return { ok: false, reason: "Chase Checking 9680 account mapping unresolved." };
  const os = await prisma.accountMapping.findFirst({ where: { friendlyName: "Cash over/short" } });
  const ctx = await getContext(gate.environment!);
  return { ok: true, value: { gateEnv: gate.environment!, ctx, chaseId: chase.qboAccountId, overShortId: os?.qboAccountId ?? null } };
}

type DepCreateOutcome = { status: "created" | "skipped" | "blocked" | "error"; message?: string };

/**
 * Create the QBO Bank Deposit for ONE matched payout into Chase Checking 9680,
 * so the bank-feed line auto-matches. Records events; does NOT revalidate.
 *   - Paymentech: link gross Undeposited-Funds payments; plug small terminal-
 *     keying over/short to Cash over/short. Total = batch amount.
 *   - Tekmetric: link gross payments AND each charge's fee journal entry
 *     (negative, matched by the payment's customer). Total = Σpay − Σfees = net.
 * Guards: matched + all located, fresh double-count scan, exact-sum checksum
 * (must equal payout net or nothing posts). `feeUsed`/`refundUsed` are shared
 * across a batch so a fee JE or refund backs only one deposit.
 */
async function createOneDeposit(
  payout: Prisma.DepPayoutGetPayload<{ include: { lines: true } }>,
  dc: DepCreateContext,
  userEmail: string,
  feeUsed: Set<string>,
  refundUsed: Set<string> = new Set()
): Promise<DepCreateOutcome> {
  const { postLinkedDeposit, buildLinkedDepositBody, linkedDepositTotalCents, collectDepositedPaymentIds } = await import(
    "@/lib/qbo/deposits"
  );
  const { shiftDate, getPaymentDetails } = await import("@/lib/deposits/qbo-lookup");
  const { findFeeJournalEntries, matchFees } = await import("@/lib/qbo/journal-entries");

  const blockedP = async (message: string): Promise<DepCreateOutcome> => {
    await prisma.depEvent.create({ data: { payoutId: payout.id, eventType: "create_blocked", message } });
    return { status: "blocked", message };
  };

  // A charge line links one payment normally, or a whole same-card group when
  // Paymentech consolidated several charges into it.
  const lineIds = (l: (typeof payout.lines)[number]): string[] =>
    l.matchedQboTxnIds?.length ? l.matchedQboTxnIds : l.matchedQboTxnId ? [l.matchedQboTxnId] : [];

  if (payout.qboDepositId) return { status: "skipped" };
  if (payout.status !== "matched") return blockedP("Not matched — run Locate first so every charge is confirmed.");
  const unlocated = payout.lines.filter((l) => lineIds(l).length === 0);
  if (unlocated.length) return blockedP(`${unlocated.length} line(s) not located — re-run Locate.`);

  // Double-count guard: refuse if any matched payment is already on a deposit.
  const deposited = await collectDepositedPaymentIds(
    dc.ctx,
    shiftDate(payout.settlementDate, -16),
    shiftDate(payout.settlementDate, 2)
  );
  const already = payout.lines.filter((l) => lineIds(l).some((id) => deposited.has(id)));
  if (already.length) return blockedP(`${already.length} payment(s) already on a QBO deposit — re-run Locate; nothing posted.`);

  const ids = payout.lines.flatMap(lineIds);
  const details = await getPaymentDetails(dc.ctx, ids);
  if (ids.some((id) => !details.has(id))) return blockedP("Could not read some matched payment amounts from QBO — re-run Locate.");
  const payments = ids.map((id) => ({ id, amount: details.get(id)!.amount }));
  const sumPayCents = payments.reduce((s, p) => s + Math.round(p.amount * 100), 0);
  const netCents = Math.round(Number(payout.netAmount) * 100);

  const feeStart = shiftDate(payout.settlementDate, payout.processor === "tekmetric" ? -6 : -3);
  const feeEnd = shiftDate(payout.settlementDate, 2);

  let journalEntries: Array<{ id: string; lineId: string; amount: number }> | undefined;
  let refunds:
    | Array<{ id: string; txnType: "RefundReceipt" | "JournalEntry" | "Payment"; lineId?: string; amount: number }>
    | undefined;
  let plug: { accountId: string; amount: number; description: string } | undefined;

  if (payout.processor === "tekmetric") {
    const feeJEs = await findFeeJournalEntries(dc.ctx, feeStart, feeEnd);
    // Charge = the matched payment's customer + that line's known fee (from the
    // Tekmetric export), so a name discrepancy can fall back to the fee amount.
    const charges = payout.lines.map((l) => ({
      customer: details.get(lineIds(l)[0])?.customerName ?? "",
      feeAmount: l.feeAmount != null ? Number(l.feeAmount) : null,
    }));
    const { linked, missing } = matchFees(feeJEs, charges, payout.settlementDate, feeUsed, daysApart);
    if (missing.length) return blockedP(`Fee journal entry not found for: ${missing.join(", ")} (searched ${feeStart}…${feeEnd}) — re-run Locate.`);
    journalEntries = linked.map((je) => ({ id: je.jeId, lineId: je.ufLineId, amount: -je.amount }));
    const sumFeeCents = linked.reduce((s, je) => s + Math.round(je.amount * 100), 0);

    // A refunded charge means the bank got less than gross − fees, so the refund
    // has to be swept into this same deposit. Only ever linked when it closes the
    // remaining gap EXACTLY (see pickRefundsForGap).
    let sumRefundCents = 0;
    let refundNote = "";
    // Refunds need a MUCH wider window than fees. A fee JE posts within days of
    // settlement, but a refund can be dated either when it was issued or
    // backdated to the original sale — and the sale can be weeks earlier (the
    // charge refunded out of the 08-06 payout was originally taken on 07-22).
    const refundStart = shiftDate(payout.settlementDate, -90);
    const refundEnd = shiftDate(payout.settlementDate, 7);
    const gapCents = sumPayCents - sumFeeCents - netCents;
    if (gapCents > 0) {
      const { findUndepositedRefunds, pickRefundsForGap, refundKey } = await import("@/lib/qbo/refunds");
      const found = await findUndepositedRefunds(dc.ctx, refundStart, refundEnd);
      const pick = pickRefundsForGap(found.refunds, gapCents, refundUsed, payout.settlementDate);
      if (pick.exact && pick.refunds.length > 0) {
        for (const r of pick.refunds) refundUsed.add(refundKey(r));
        refunds = pick.refunds.map((r) => ({
          id: r.txnId,
          txnType: r.kind,
          lineId: r.lineId,
          amount: -r.amount,
        }));
        sumRefundCents = pick.refunds.reduce((s, r) => s + Math.round(r.amount * 100), 0);
        await prisma.depEvent.create({
          data: {
            payoutId: payout.id,
            eventType: "refund_linked",
            message:
              `Swept ${pick.refunds.length} refund(s) totalling ${(sumRefundCents / 100).toFixed(2)} into this deposit: ` +
              pick.refunds.map((r) => `${r.kind} ${r.txnId}${r.lineId ? `/${r.lineId}` : ""} ${r.date} ${r.amount.toFixed(2)}${r.customerName ? ` (${r.customerName})` : ""}`).join("; ") +
              (pick.exactCandidates > 1
                ? ` · NOTE ${pick.exactCandidates} refunds in the window shared this amount; picked the one closest to ${payout.settlementDate}.`
                : ""),
          },
        });
      } else {
        // Nothing sweepable. Say what we DID find, which is the difference
        // between "record the refund" and "move the refund you already made".
        const gapDollars = (gapCents / 100).toFixed(2);
        const sameAmount = found.nearMisses.filter((n) => Math.round(n.amount * 100) === gapCents);
        if (sameAmount.length > 0) {
          refundNote =
            ` A refund of ${gapDollars} DOES exist (${sameAmount
              .map((n) => `${n.kind} ${n.txnId} on ${n.date}, ${n.reason}`)
              .join("; ")}) — re-point it at Undeposited Funds so it can be swept into this deposit.`;
        } else {
          const others = [...found.refunds, ...found.nearMisses]
            .map((r) => (r.amount ?? 0).toFixed(2))
            .slice(0, 6);
          refundNote =
            ` No refund of ${gapDollars} was found between ${refundStart} and ${refundEnd}` +
            (others.length ? ` (refunds seen in that window: ${others.join(", ")})` : " (no refunds at all in that window)") +
            `.`;
        }
      }
    }

    const totalCents = sumPayCents - sumFeeCents - sumRefundCents;
    if (totalCents !== netCents) {
      // Diagnose WHY rather than just reporting the gap. The export gives each
      // charge's real processor fee, so we can separate the two very different
      // causes:
      //   - a REFUND: the payout's gross-to-net difference exceeds the actual
      //     fees, because a refunded charge reduced the payout. Refunds aren't
      //     fee JEs, so no amount of fee matching will ever close this gap.
      //   - a FEE-JE mismatch: the located JEs don't sum to the fees the export
      //     says were charged, so the wrong JEs were paired.
      const expectedFeeCents = payout.lines.reduce(
        (s, l) => s + (l.feeAmount != null ? Math.round(Number(l.feeAmount) * 100) : 0),
        0
      );
      const grossToNetCents = Math.round(Number(payout.grossAmount) * 100) - netCents;
      const refundCents = grossToNetCents - expectedFeeCents;
      const f = (c: number) => (c / 100).toFixed(2);
      let why: string;
      if (refundCents > 1) {
        why =
          ` The export's own per-charge fees total ${f(expectedFeeCents)}, but this payout is ${f(
            grossToNetCents
          )} below its gross — the extra ${f(refundCents)} is a REFUND, not a processor fee.${refundNote}` +
          ` Until that refund sits in Undeposited Funds there's nothing to sweep into the deposit — and note the books` +
          ` currently overstate income by ${f(refundCents)} regardless of this deposit.`;
      } else if (sumFeeCents !== expectedFeeCents) {
        why = ` The fee journal entries located sum to ${f(sumFeeCents)}, but the export says these charges were charged ${f(
          expectedFeeCents
        )} in fees — ${f(Math.abs(sumFeeCents - expectedFeeCents))} ${
          sumFeeCents > expectedFeeCents ? "too much" : "too little"
        }, so at least one JE belongs to a different payout. Re-run Locate.`;
      } else {
        why = " Fees match the export, so the payment set itself doesn't reconstruct this payout — re-run Locate.";
      }
      return blockedP(
        `Checksum mismatch (tekmetric): payments ${f(sumPayCents)} − fees ${f(sumFeeCents)} = ${f(
          totalCents
        )} vs net ${f(netCents)} — not posted.${why}`
      );
    }
  } else {
    const plugCents = netCents - sumPayCents;
    if (Math.abs(plugCents) > 1000) {
      return blockedP(`Over/short ${(plugCents / 100).toFixed(2)} exceeds the $10 keying tolerance — investigate before posting.`);
    }
    if (plugCents !== 0) {
      if (!dc.overShortId) return blockedP("Cash over/short account mapping unresolved.");
      plug = { accountId: dc.overShortId, amount: plugCents / 100, description: "Card terminal keying over/short" };
    }
  }

  const input = {
    depositToAccountId: dc.chaseId,
    txnDate: payout.settlementDate,
    privateNote: `GCD Deposit Recon | ${payout.processor} | ${payout.settlementDate} | ${payout.sourceRef ?? ""}`,
    payments,
    journalEntries,
    refunds,
    plug,
  };
  const totalCents = linkedDepositTotalCents(buildLinkedDepositBody(input));
  if (totalCents !== netCents) {
    return blockedP(`Checksum mismatch: deposit ${(totalCents / 100).toFixed(2)} vs net ${(netCents / 100).toFixed(2)} — not posted.`);
  }

  let result;
  try {
    result = await postLinkedDeposit(dc.ctx, input);
  } catch (err) {
    const detail = (err as { detail?: unknown })?.detail;
    await prisma.depEvent.create({
      data: {
        payoutId: payout.id,
        eventType: "create_error",
        message: `QBO rejected deposit: ${String(err)}${detail ? ` · ${JSON.stringify(detail)}` : ""}`.slice(0, 1800),
      },
    });
    return { status: "error", message: String(err) };
  }

  await prisma.depPayout.update({
    where: { id: payout.id },
    data: { status: "created", qboDepositId: result.qboTransactionId, deltaCents: 0 },
  });
  await prisma.depEvent.create({
    data: {
      payoutId: payout.id,
      eventType: "create_deposit",
      message: `Created Chase Checking deposit ${result.qboTransactionId} for ${(netCents / 100).toFixed(2)} (${payments.length} payments${
        journalEntries?.length ? ` − ${journalEntries.length} fee JEs` : ""
      }) by ${userEmail}.`,
      dataJson: { depositId: result.qboTransactionId, totalAmt: result.totalAmt } as unknown as object,
    },
  });
  return { status: "created" };
}

/** Create the deposit for one matched payout (owner-only). */
export async function createDepositFromPayoutAction(formData: FormData) {
  const user = await requirePermission("edit_mappings");
  const payoutId = String(formData.get("payoutId") ?? "");
  if (!payoutId) throw new Error("Missing payoutId");
  try {
    const payout = await prisma.depPayout.findUnique({ where: { id: payoutId }, include: { lines: true } });
    if (!payout) throw new Error("Payout not found");
    const prep = await prepareDepCreateContext();
    if (!prep.ok) {
      await prisma.depEvent.create({ data: { payoutId, eventType: "create_blocked", message: prep.reason } });
      revalidatePath("/deposit-reconciliation");
      return;
    }
    await createOneDeposit(payout, prep.value, user.email, new Set(), new Set());
    revalidatePath("/deposit-reconciliation");
  } catch (err) {
    await prisma.depEvent.create({ data: { payoutId, eventType: "create_error", message: `Create failed: ${String(err)}` } });
    revalidatePath("/deposit-reconciliation");
  }
}

/**
 * Batch (owner-only): create deposits for EVERY matched, not-yet-created payout
 * in one click — the month-end action. Each payout is created by the same
 * guarded core (double-count scan, fee matching, exact-sum checksum); per-payout
 * failures are isolated and a batch summary is recorded. Fee JEs are de-duped
 * across the batch so one JE never backs two deposits.
 */
export async function createAllMatchedDepositsAction() {
  const user = await requirePermission("edit_mappings");
  const prep = await prepareDepCreateContext();
  if (!prep.ok) {
    await prisma.depEvent.create({ data: { eventType: "create_batch", message: `Batch blocked: ${prep.reason}` } });
    revalidatePath("/deposit-reconciliation");
    return;
  }

  const matched = await prisma.depPayout.findMany({
    where: { status: "matched", qboDepositId: null },
    include: { lines: true },
    orderBy: [{ settlementDate: "asc" }, { createdAt: "asc" }],
  });

  const feeUsed = new Set<string>();
  const refundUsed = new Set<string>();
  let created = 0;
  let blocked = 0;
  let errored = 0;
  for (const payout of matched) {
    try {
      const outcome = await createOneDeposit(payout, prep.value, user.email, feeUsed, refundUsed);
      if (outcome.status === "created") created++;
      else if (outcome.status === "blocked") blocked++;
      else if (outcome.status === "error") errored++;
    } catch (err) {
      errored++;
      await prisma.depEvent.create({ data: { payoutId: payout.id, eventType: "create_error", message: `Create failed: ${String(err)}` } });
    }
  }

  await prisma.depEvent.create({
    data: {
      eventType: "create_batch",
      message: `Batch create: ${created} created, ${blocked} blocked, ${errored} errored (of ${matched.length} matched) · env ${prep.value.gateEnv}`,
    },
  });
  revalidatePath("/deposit-reconciliation");
}
