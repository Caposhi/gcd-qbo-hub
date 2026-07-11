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
  const { findPaymentsByAmount, shiftDate } = await import("@/lib/deposits/qbo-lookup");

  const environment = await getQboEnvironment();
  const ctx = await getContext(environment);

  const payouts = await prisma.depPayout.findMany({
    where: { status: { in: ["proposed", "needs_review", "matched"] } },
    include: { lines: true },
  });

  let payoutsMatched = 0;
  let payoutsReview = 0;

  for (const p of payouts) {
    if (p.lines.length === 0) continue; // unresolved reconstruction — nothing to locate
    // Window: card payments post on/around the charge date, a few days before
    // the payout arrival. Generous both ways to tolerate RO-vs-charge dating.
    const start = shiftDate(p.settlementDate, -16);
    const end = shiftDate(p.settlementDate, 2);
    const usedPaymentIds = new Set<string>();
    const detail: Array<{ amount: number; found: boolean; candidates: number }> = [];
    let foundCount = 0;

    for (const line of p.lines) {
      const amt = Number(line.amount);
      const cands = await findPaymentsByAmount(ctx, amt, start, end);
      const pick = cands.find((c) => !usedPaymentIds.has(c.id));
      detail.push({ amount: amt, found: !!pick, candidates: cands.length });
      if (pick) {
        usedPaymentIds.add(pick.id);
        foundCount++;
        await prisma.depPayoutLine.update({
          where: { id: line.id },
          data: { matchedQboTxnId: pick.id, matchedQboTxnType: "Payment" },
        });
      } else {
        await prisma.depPayoutLine.update({
          where: { id: line.id },
          data: { matchedQboTxnId: null, matchedQboTxnType: null },
        });
      }
    }

    const foundAll = foundCount === p.lines.length;
    if (foundAll) payoutsMatched++;
    else payoutsReview++;

    const missing = detail.filter((d) => !d.found).map((d) => d.amount.toFixed(2));
    await prisma.depPayout.update({
      where: { id: p.id },
      data: { status: foundAll ? "matched" : "needs_review", deltaCents: foundAll ? 0 : null },
    });
    await prisma.depEvent.create({
      data: {
        payoutId: p.id,
        eventType: "locate_payments",
        message: foundAll
          ? `All ${p.lines.length} charge payments located in Undeposited Funds (window ${start}…${end}).`
          : `Located ${foundCount}/${p.lines.length}; missing amounts: ${missing.join(", ") || "-"} (searched ${start}…${end}).`,
        dataJson: { detail, start, end } as unknown as object,
      },
    });
  }

  await prisma.depEvent.create({
    data: {
      eventType: "locate_summary",
      message: `Locate run: ${payouts.length} payout(s) checked — ${payoutsMatched} matched, ${payoutsReview} need review · env ${environment}`,
    },
  });

  revalidatePath("/deposit-reconciliation");
}

/**
 * Create the QBO Bank Deposit for one matched PAYMENTECH payout (owner-only).
 * Paymentech deposits are pure gross card sales (fees billed monthly, not
 * netted), so the deposit just links the matched Undeposited-Funds payments into
 * Chase Checking 9680 — total = the batch amount = what Chase deposited, so the
 * bank-feed line auto-matches. Tekmetric payouts are NOT postable here yet
 * (they need the fee journal-entry links). Guards: rollout stage (never
 * dry-run, valid creds), all lines located, exact-sum checksum, and a fresh
 * double-count scan so a payment already on a deposit is never re-deposited.
 */
export async function createDepositFromPayoutAction(formData: FormData) {
  const user = await requirePermission("edit_mappings");
  const payoutId = String(formData.get("payoutId") ?? "");
  if (!payoutId) throw new Error("Missing payoutId");

  const { canPostRow } = await import("@/lib/cashsheet/rollout");
  const { getQboEnvironment, getRolloutStage } = await import("@/lib/config-store");
  const { hasValidCredentials } = await import("@/lib/qbo/oauth");
  const { getContext } = await import("@/lib/qbo/client");
  const { postLinkedDeposit, buildLinkedDepositBody, linkedDepositTotalCents, collectDepositedPaymentIds } = await import(
    "@/lib/qbo/deposits"
  );
  const { shiftDate } = await import("@/lib/deposits/qbo-lookup");

  const blocked = async (message: string) => {
    await prisma.depEvent.create({ data: { payoutId, eventType: "create_blocked", message } });
    revalidatePath("/deposit-reconciliation");
  };

  try {
    const payout = await prisma.depPayout.findUnique({ where: { id: payoutId }, include: { lines: true } });
    if (!payout) throw new Error("Payout not found");
    if (payout.qboDepositId) return; // already created — idempotent
    if (payout.processor !== "paymentech") {
      return blocked("Tekmetric deposits aren't postable yet — they need fee journal-entry links (coming).");
    }
    if (payout.status !== "matched") return blocked("Not matched — run Locate first so every charge is confirmed.");
    const unlocated = payout.lines.filter((l) => !l.matchedQboTxnId);
    if (unlocated.length) return blocked(`${unlocated.length} line(s) not located — re-run Locate.`);

    const stage = await getRolloutStage();
    const environment = await getQboEnvironment();
    const credsValid = await hasValidCredentials(environment);
    const gate = canPostRow({ stage, credentialsValid: credsValid, mappingRequiresApproval: false, rowApproved: true });
    if (!gate.allowed) return blocked(`Not created: ${gate.reason}`);

    const chase = await prisma.accountMapping.findFirst({ where: { friendlyName: "Chase Checking 9680" } });
    if (!chase?.qboAccountId) return blocked("Chase Checking 9680 account mapping unresolved.");

    const ctx = await getContext(gate.environment!);

    // Double-count guard: refuse if any matched payment is already on a deposit.
    const deposited = await collectDepositedPaymentIds(
      ctx,
      shiftDate(payout.settlementDate, -16),
      shiftDate(payout.settlementDate, 2)
    );
    const already = payout.lines.filter((l) => l.matchedQboTxnId && deposited.has(l.matchedQboTxnId));
    if (already.length) {
      return blocked(`${already.length} payment(s) already on a QBO deposit — re-run Locate; nothing posted.`);
    }

    const payments = payout.lines.map((l) => ({ id: l.matchedQboTxnId as string, amount: Number(l.amount) }));
    const input = {
      depositToAccountId: chase.qboAccountId,
      txnDate: payout.settlementDate,
      privateNote: `GCD Deposit Recon | ${payout.processor} | ${payout.settlementDate} | ${payout.sourceRef ?? ""}`,
      payments,
    };

    // Exact-sum checksum: the deposit MUST equal the payout net or we never post.
    const totalCents = linkedDepositTotalCents(buildLinkedDepositBody(input));
    const netCents = Math.round(Number(payout.netAmount) * 100);
    if (totalCents !== netCents) {
      return blocked(`Checksum mismatch: linked payments ${(totalCents / 100).toFixed(2)} vs net ${(netCents / 100).toFixed(2)} — not posted.`);
    }

    let result;
    try {
      result = await postLinkedDeposit(ctx, input);
    } catch (err) {
      const detail = (err as { detail?: unknown })?.detail;
      await prisma.depEvent.create({
        data: {
          payoutId,
          eventType: "create_error",
          message: `QBO rejected deposit: ${String(err)}${detail ? ` · ${JSON.stringify(detail)}` : ""}`.slice(0, 1800),
        },
      });
      revalidatePath("/deposit-reconciliation");
      return;
    }

    await prisma.depPayout.update({
      where: { id: payoutId },
      data: { status: "created", qboDepositId: result.qboTransactionId, deltaCents: 0 },
    });
    await prisma.depEvent.create({
      data: {
        payoutId,
        eventType: "create_deposit",
        message: `Created Chase Checking deposit ${result.qboTransactionId} for ${(netCents / 100).toFixed(2)} (${payments.length} payments) by ${user.email}.`,
        dataJson: { depositId: result.qboTransactionId, totalAmt: result.totalAmt } as unknown as object,
      },
    });
    revalidatePath("/deposit-reconciliation");
  } catch (err) {
    await prisma.depEvent.create({ data: { payoutId, eventType: "create_error", message: `Create failed: ${String(err)}` } });
    revalidatePath("/deposit-reconciliation");
  }
}
