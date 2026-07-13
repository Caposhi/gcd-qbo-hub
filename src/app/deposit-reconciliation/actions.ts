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

  // Idempotency: the same set of files re-dropped does nothing.
  const combined = named.map((f) => `${f.name}::${f.text}`).sort().join("\n---\n");
  const fileHash = createHash("sha256").update(combined).digest("hex");
  if (await prisma.depImport.findUnique({ where: { fileHash } })) {
    revalidatePath("/deposit-reconciliation");
    return;
  }

  const result = buildProposalsFromFiles(named);
  const processors = new Set<string>();
  if (result.paymentechDeposits.length) processors.add("paymentech");
  if (result.tekmetric) processors.add("tekmetric");

  const imp = await prisma.depImport.create({
    data: {
      processor: [...processors].join("+") || "unknown",
      fileHash,
      rowCount: named.length,
      importedByEmail: user.email,
    },
  });

  const dec = (n: number) => new Prisma.Decimal(n.toFixed(2));

  // Dedupe: a payout is uniquely identified by (processor, sourceRef) — the
  // Stripe trace-id / payout-id, or the Paymentech batch #. Re-dropping the same
  // files in a different file-set (so the combined fileHash differs) must NOT
  // re-create payouts. Seed from what already exists, then also guard within
  // this ingest.
  const existing = await prisma.depPayout.findMany({
    select: { processor: true, sourceRef: true, settlementDate: true, netAmount: true },
  });
  const keyOf = (processor: string, sourceRef: string | null, settlementDate: string, netAmount: number) =>
    sourceRef ? `${processor}|${sourceRef}` : `${processor}|${settlementDate}|${Math.round(netAmount * 100)}`;
  const seen = new Set(existing.map((e) => keyOf(e.processor, e.sourceRef, e.settlementDate, Number(e.netAmount))));
  let skipped = 0;

  const proposed = [
    ...result.paymentechDeposits,
    ...(result.tekmetric?.deposits ?? []),
  ];
  for (const d of proposed) {
    const key = keyOf(d.processor, d.sourceRef ?? null, d.settlementDate, d.net);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    await prisma.depPayout.create({
      data: {
        importId: imp.id,
        processor: d.processor,
        settlementDate: d.settlementDate,
        grossAmount: dec(d.gross),
        feeAmount: dec(d.fee),
        netAmount: dec(d.net),
        status: "proposed",
        deltaCents: 0,
        sourceRef: d.sourceRef ?? null,
        lines: {
          create: d.lines.map((l) => ({
            amount: dec(l.amount),
            feeAmount: l.fee ? dec(l.fee) : null,
            brand: l.brand || null,
            ref: l.ref || null,
          })),
        },
      },
    });
  }

  for (const u of result.tekmetric?.unresolved ?? []) {
    const sourceRef = u.payout.traceId ?? u.payout.id;
    const key = keyOf("tekmetric", sourceRef, u.payout.arrivalDate, u.payout.amount);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    await prisma.depPayout.create({
      data: {
        importId: imp.id,
        processor: "tekmetric",
        settlementDate: u.payout.arrivalDate,
        grossAmount: dec(0),
        feeAmount: dec(0),
        netAmount: dec(u.payout.amount),
        status: "needs_review",
        deltaCents: u.deltaCents,
        sourceRef,
      },
    });
  }

  if (skipped > 0) {
    await prisma.depEvent.create({
      data: { eventType: "ingest_dedupe", message: `Skipped ${skipped} payout(s) already present (same processor + source ref).` },
    });
  }

  if (result.notes.length) {
    await prisma.depEvent.create({
      data: { eventType: "ingest_note", message: result.notes.join(" ") },
    });
  }

  revalidatePath("/deposit-reconciliation");
}

/**
 * Remove duplicate payouts (same processor + source ref), keeping the earliest
 * — and never touching one already posted to QBO. One-time cleanup for payouts
 * created before ingest was made dedupe-aware.
 */
export async function cleanupDuplicatePayoutsAction() {
  await requirePermission("edit_mappings");
  const all = await prisma.depPayout.findMany({ orderBy: { createdAt: "asc" } });
  const seen = new Set<string>();
  const dupeIds: string[] = [];
  for (const p of all) {
    const key = p.sourceRef
      ? `${p.processor}|${p.sourceRef}`
      : `${p.processor}|${p.settlementDate}|${Math.round(Number(p.netAmount) * 100)}`;
    if (p.qboDepositId) { seen.add(key); continue; } // posted — always keep
    if (seen.has(key)) dupeIds.push(p.id);
    else seen.add(key);
  }
  if (dupeIds.length) {
    await prisma.depPayout.deleteMany({ where: { id: { in: dupeIds } } }); // lines/events cascade
  }
  await prisma.depEvent.create({
    data: { eventType: "dedupe", message: `Removed ${dupeIds.length} duplicate payout(s).` },
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
  const { collectDepositedPaymentIds } = await import("@/lib/qbo/deposits");
  const { findFeeJournalEntries, matchFeesByCustomer } = await import("@/lib/qbo/journal-entries");

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
  let feeJEs: Awaited<ReturnType<typeof findFeeJournalEntries>> = [];
  const settleDates = payouts.map((p) => p.settlementDate).filter(Boolean).sort();
  if (settleDates.length) {
    const spanStart = shiftDate(settleDates[0], -8);
    const spanEnd = shiftDate(settleDates[settleDates.length - 1], 4);
    depositedIds = await collectDepositedPaymentIds(ctx, spanStart, spanEnd);
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
    // Tight, processor-specific window: Paymentech posts on the batch date;
    // Tekmetric charges settle the next day. Narrow windows + the global
    // no-reuse guard keep same-amount transactions on different days apart.
    const start = shiftDate(p.settlementDate, p.processor === "tekmetric" ? -6 : -3);
    const end = shiftDate(p.settlementDate, 2);
    const detail: Array<{ amount: number; found: boolean; alreadyDeposited?: boolean; matchedAmount?: number; delta?: number; candidates: number }> = [];
    const matchedPaymentIds: string[] = [];
    let foundCount = 0;
    let depositedCount = 0;

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

      if (pick) {
        globalUsed.add(pick.id);
        matchedPaymentIds.push(pick.id);
        foundCount++;
        detail.push({ amount: amt, found: true, matchedAmount: pick.amount, delta: Number((amt - pick.amount).toFixed(2)), candidates: pool.length });
        await prisma.depPayoutLine.update({
          where: { id: line.id },
          data: { matchedQboTxnId: pick.id, matchedQboTxnType: "Payment" },
        });
      } else if (pool.some((c) => depositedIds.has(c.id))) {
        // A payment of this amount exists but is already on a deposit → this
        // charge was reconciled previously.
        depositedCount++;
        detail.push({ amount: amt, found: false, alreadyDeposited: true, candidates: pool.length });
        await prisma.depPayoutLine.update({
          where: { id: line.id },
          data: { matchedQboTxnId: null, matchedQboTxnType: null },
        });
      } else {
        detail.push({ amount: amt, found: false, candidates: pool.length });
        await prisma.depPayoutLine.update({
          where: { id: line.id },
          data: { matchedQboTxnId: null, matchedQboTxnType: null },
        });
      }
    }

    const foundAll = foundCount === p.lines.length;
    const allDeposited = depositedCount === p.lines.length && p.lines.length > 0;

    // Tekmetric: also confirm each charge's fee journal entry exists (by fee
    // amount) so "matched" means the full deposit (payments + fees) can be built.
    let feesNeeded = 0;
    let feesFound = 0;
    if (p.processor === "tekmetric" && foundAll) {
      // Confirm each charge's fee JE exists, matched by the payment's customer.
      const payDetails = await getPaymentDetails(ctx, matchedPaymentIds);
      const customers = matchedPaymentIds.map((id) => payDetails.get(id)?.customerName ?? "");
      feesNeeded = customers.length;
      const { linked } = matchFeesByCustomer(feeJEs, customers, p.settlementDate, feeUsedGlobal, daysApart);
      feesFound = linked.length;
    }
    const feesOk = p.processor !== "tekmetric" || feesFound === feesNeeded;

    const status = foundAll && feesOk ? "matched" : allDeposited ? "already_deposited" : "needs_review";
    if (status === "matched") payoutsMatched++;
    else if (status === "already_deposited") payoutsAlreadyDeposited++;
    else payoutsReview++;

    const missing = detail.filter((d) => !d.found && !d.alreadyDeposited).map((d) => d.amount.toFixed(2));
    const overShortCents = detail.reduce((s, d) => s + Math.round((d.delta ?? 0) * 100), 0);
    await prisma.depPayout.update({
      where: { id: p.id },
      data: { status, deltaCents: status === "matched" ? overShortCents : null },
    });
    const osNote = overShortCents !== 0 ? ` Over/short from keying: ${(overShortCents / 100).toFixed(2)} (booked to Cash over/short on deposit).` : "";
    const feeNote = p.processor === "tekmetric" && feesNeeded ? ` ${feesFound}/${feesNeeded} fee JEs located.` : "";
    const message =
      foundAll && feesOk
        ? `All ${p.lines.length} charge payments located in Undeposited Funds (window ${start}…${end}).${feeNote}${osNote}`
        : foundAll && !feesOk
          ? `Payments located, but only ${feesFound}/${feesNeeded} fee journal entries found — re-run once Back Office has posted them.`
          : allDeposited
            ? `Already reconciled — all ${p.lines.length} payments are on an existing QBO deposit. Nothing to do.`
            : `Located ${foundCount}/${p.lines.length}${depositedCount ? `, ${depositedCount} already deposited` : ""}; missing amounts: ${missing.join(", ") || "-"} (searched ${start}…${end}).`;
    await prisma.depEvent.create({
      data: {
        payoutId: p.id,
        eventType: "locate_payments",
        message,
        dataJson: { detail, start, end, overShortCents } as unknown as object,
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
 * (must equal payout net or nothing posts). `feeUsed` is shared across a batch
 * so a fee JE backs only one deposit.
 */
async function createOneDeposit(
  payout: Prisma.DepPayoutGetPayload<{ include: { lines: true } }>,
  dc: DepCreateContext,
  userEmail: string,
  feeUsed: Set<string>
): Promise<DepCreateOutcome> {
  const { postLinkedDeposit, buildLinkedDepositBody, linkedDepositTotalCents, collectDepositedPaymentIds } = await import(
    "@/lib/qbo/deposits"
  );
  const { shiftDate, getPaymentDetails } = await import("@/lib/deposits/qbo-lookup");
  const { findFeeJournalEntries, matchFeesByCustomer } = await import("@/lib/qbo/journal-entries");

  const blockedP = async (message: string): Promise<DepCreateOutcome> => {
    await prisma.depEvent.create({ data: { payoutId: payout.id, eventType: "create_blocked", message } });
    return { status: "blocked", message };
  };

  if (payout.qboDepositId) return { status: "skipped" };
  if (payout.status !== "matched") return blockedP("Not matched — run Locate first so every charge is confirmed.");
  const unlocated = payout.lines.filter((l) => !l.matchedQboTxnId);
  if (unlocated.length) return blockedP(`${unlocated.length} line(s) not located — re-run Locate.`);

  // Double-count guard: refuse if any matched payment is already on a deposit.
  const deposited = await collectDepositedPaymentIds(
    dc.ctx,
    shiftDate(payout.settlementDate, -16),
    shiftDate(payout.settlementDate, 2)
  );
  const already = payout.lines.filter((l) => l.matchedQboTxnId && deposited.has(l.matchedQboTxnId));
  if (already.length) return blockedP(`${already.length} payment(s) already on a QBO deposit — re-run Locate; nothing posted.`);

  const ids = payout.lines.map((l) => l.matchedQboTxnId as string);
  const details = await getPaymentDetails(dc.ctx, ids);
  if (ids.some((id) => !details.has(id))) return blockedP("Could not read some matched payment amounts from QBO — re-run Locate.");
  const payments = ids.map((id) => ({ id, amount: details.get(id)!.amount }));
  const sumPayCents = payments.reduce((s, p) => s + Math.round(p.amount * 100), 0);
  const netCents = Math.round(Number(payout.netAmount) * 100);

  const feeStart = shiftDate(payout.settlementDate, payout.processor === "tekmetric" ? -6 : -3);
  const feeEnd = shiftDate(payout.settlementDate, 2);

  let journalEntries: Array<{ id: string; lineId: string; amount: number }> | undefined;
  let plug: { accountId: string; amount: number; description: string } | undefined;

  if (payout.processor === "tekmetric") {
    const feeJEs = await findFeeJournalEntries(dc.ctx, feeStart, feeEnd);
    const customers = ids.map((id) => details.get(id)!.customerName);
    const { linked, missing } = matchFeesByCustomer(feeJEs, customers, payout.settlementDate, feeUsed, daysApart);
    if (missing.length) return blockedP(`Fee journal entry not found for: ${missing.join(", ")} (searched ${feeStart}…${feeEnd}) — re-run Locate.`);
    journalEntries = linked.map((je) => ({ id: je.jeId, lineId: je.ufLineId, amount: -je.amount }));
    const sumFeeCents = linked.reduce((s, je) => s + Math.round(je.amount * 100), 0);
    const totalCents = sumPayCents - sumFeeCents;
    if (totalCents !== netCents) {
      return blockedP(
        `Checksum mismatch (tekmetric): payments ${(sumPayCents / 100).toFixed(2)} − fees ${(sumFeeCents / 100).toFixed(
          2
        )} = ${(totalCents / 100).toFixed(2)} vs net ${(netCents / 100).toFixed(2)} — not posted.`
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
    await createOneDeposit(payout, prep.value, user.email, new Set());
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
  let created = 0;
  let blocked = 0;
  let errored = 0;
  for (const payout of matched) {
    try {
      const outcome = await createOneDeposit(payout, prep.value, user.email, feeUsed);
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
