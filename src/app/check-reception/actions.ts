"use server";

/**
 * Check Reception — server actions.
 *
 * The ladder mirrors Deposit Reconciliation (propose → create-you-match):
 *   1. ingestCheckPdfAction  — drop a Chase check-image PDF; Claude vision reads
 *      each check; each is classified against the learned payee→category mapping
 *      (ready if a complete mapping matches a confident read, else needs_review).
 *      Read-only: nothing is written to QBO.
 *   2. classifyCheckAction   — owner confirms/corrects the payee, vendor, and
 *      expense category for one check; we resolve them in QBO and TEACH the
 *      mapping so the next check to that payee pre-fills.
 *   3. createCheckAction / createAllReadyChecksAction — owner posts the QBO
 *      Check(s) behind the rollout gate, with a duplicate-check-number guard, so
 *      the Chase bank-feed line auto-matches.
 */
import { createHash } from "node:crypto";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/auth/session";
import {
  normalizePayee,
  findPayeeMapping,
  classifyExtractedCheck,
  type PayeeMappingLike,
} from "@/lib/checks/classify";

const PATH = "/check-reception";

/** Ingest a Chase check-image PDF: read each check and stage it for review. */
export async function ingestCheckPdfAction(formData: FormData) {
  const user = await requirePermission("edit_mappings");
  const { extractChecksFromPdf, isCheckReaderConfigured } = await import("@/lib/checks/extract");

  const file = formData.get("file");
  if (!file || typeof file !== "object" || !("arrayBuffer" in file) || (file as File).size === 0) return;
  const f = file as File;
  if (!isCheckReaderConfigured()) {
    await prisma.chkEvent.create({
      data: { eventType: "ingest_error", message: "Check reader not configured (ANTHROPIC_API_KEY unset)." },
    });
    revalidatePath(PATH);
    return;
  }

  const bytes = Buffer.from(await f.arrayBuffer());
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  // Idempotent: the same PDF re-dropped does nothing.
  if (await prisma.chkBatch.findUnique({ where: { fileHash } })) {
    revalidatePath(PATH);
    return;
  }

  let extraction;
  try {
    extraction = await extractChecksFromPdf(bytes);
  } catch (err) {
    await prisma.chkEvent.create({
      data: { eventType: "ingest_error", message: `Could not read the PDF: ${String(err)}`.slice(0, 1800) },
    });
    revalidatePath(PATH);
    return;
  }

  const mappings = (await prisma.chkPayeeMapping.findMany({ where: { active: true } })) as PayeeMappingLike[];
  const dec = (n: number) => new Prisma.Decimal(n.toFixed(2));

  // Best-effort QBO prefill: fetch the vendor list once and, for each check,
  // suggest the closest vendor (fuzzy) and — when there's no learned mapping —
  // that vendor's usual category from its QBO history, the way QBO auto-fills.
  // If QBO isn't reachable we still ingest; the dropdowns just start blank.
  let vendors: Awaited<ReturnType<typeof import("@/lib/checks/qbo-check").listVendors>> = [];
  let vendorCtx: Awaited<ReturnType<typeof import("@/lib/qbo/client").getContext>> | null = null;
  try {
    const { getQboEnvironment } = await import("@/lib/config-store");
    const { getContext } = await import("@/lib/qbo/client");
    const { listVendors } = await import("@/lib/checks/qbo-check");
    vendorCtx = await getContext(await getQboEnvironment());
    vendors = await listVendors(vendorCtx);
  } catch {
    vendorCtx = null;
  }
  const categoryByVendor = new Map<string, { id: string; name: string } | null>();

  const batch = await prisma.chkBatch.create({
    data: {
      fileHash,
      fileName: f.name || "checks.pdf",
      pageCount: extraction.checks.length,
      checkCount: extraction.checks.length,
      uploadedByEmail: user.email,
    },
  });

  let ready = 0;
  let skipped = 0;
  for (const c of extraction.checks) {
    // A page with neither a check number nor an amount isn't a check (Chase
    // downloads often start with a cover/summary page) — skip it, don't nag.
    if (!c.checkNumber && c.amount === null) {
      await prisma.chkCheck.create({
        data: {
          batchId: batch.id,
          page: c.page,
          checkNumber: c.checkNumber,
          amount: null,
          checkDate: c.date,
          payeeRaw: c.payee,
          memo: c.memo,
          confidence: c.confidence,
          extractionJson: c as unknown as object,
          status: "skipped",
          statusReason: "No check number or amount — likely a cover/summary page.",
        },
      });
      skipped++;
      continue;
    }

    const mapping = findPayeeMapping(mappings, c.payee);
    const cls = classifyExtractedCheck(c, mapping);
    if (cls.status === "ready") ready++;

    // Prefill vendor + category suggestions (mapping wins; else fuzzy vendor +
    // that vendor's historical category).
    let vendorId = cls.qboVendorId;
    let vendorName = cls.qboVendorName;
    let categoryId = cls.categoryAccountId;
    let categoryName = cls.categoryAccountName;
    if (!mapping && vendorCtx) {
      const { bestVendorMatch } = await import("@/lib/checks/match");
      const { suggestCategoryForVendor } = await import("@/lib/checks/qbo-check");
      const vm = bestVendorMatch(c.payee, vendors);
      if (vm) {
        vendorId = vm.id;
        vendorName = vm.name;
        if (!categoryId) {
          if (!categoryByVendor.has(vm.id)) {
            try {
              categoryByVendor.set(vm.id, await suggestCategoryForVendor(vendorCtx, vm.id));
            } catch {
              categoryByVendor.set(vm.id, null);
            }
          }
          const cat = categoryByVendor.get(vm.id);
          if (cat) {
            categoryId = cat.id;
            categoryName = cat.name;
          }
        }
      }
    }

    await prisma.chkCheck.create({
      data: {
        batchId: batch.id,
        page: c.page,
        checkNumber: c.checkNumber,
        amount: c.amount !== null ? dec(c.amount) : null,
        checkDate: c.date,
        payeeRaw: c.payee,
        memo: c.memo,
        confidence: c.confidence,
        extractionJson: c as unknown as object,
        payeeResolved: cls.payeeResolved,
        qboVendorId: vendorId,
        qboVendorName: vendorName,
        categoryAccountId: categoryId,
        categoryAccountName: categoryName,
        status: cls.status,
        statusReason: cls.reason,
      },
    });
  }

  const counted = extraction.checks.length - skipped;
  await prisma.chkEvent.create({
    data: {
      eventType: "ingest",
      message: `Read ${extraction.checks.length} page(s) from ${f.name || "PDF"} — ${counted} check(s) (${ready} ready, ${
        counted - ready
      } need review)${skipped ? `, ${skipped} non-check page(s) skipped` : ""}${
        vendorCtx ? "" : " · QBO not reached, dropdowns unfilled"
      }.`,
      dataJson: { usage: extraction.usage } as unknown as object,
    },
  });
  revalidatePath(PATH);
}

/**
 * Confirm/correct one check's classification: set the payee, resolve (or create)
 * the QBO vendor, resolve the expense category by name, save, and TEACH the
 * payee→category mapping. On success the check becomes "ready". Corrected
 * check-number / amount / date are also saved.
 */
export async function classifyCheckAction(formData: FormData) {
  const user = await requirePermission("edit_mappings");
  const checkId = String(formData.get("checkId") ?? "");
  if (!checkId) throw new Error("Missing checkId");

  const payee = String(formData.get("payee") ?? "").trim();
  const vendorName = String(formData.get("vendorName") ?? "").trim() || payee;
  const vendorId = String(formData.get("vendorId") ?? "").trim();
  const categoryName = String(formData.get("categoryName") ?? "").trim();
  const categoryId = String(formData.get("categoryId") ?? "").trim();
  const checkNumber = String(formData.get("checkNumber") ?? "").trim();
  const amountRaw = String(formData.get("amount") ?? "").trim();
  const checkDate = String(formData.get("checkDate") ?? "").trim();
  const remember = formData.get("remember") !== null; // checkbox present = teach mapping

  const fail = async (reason: string) => {
    await prisma.chkCheck.update({ where: { id: checkId }, data: { status: "needs_review", statusReason: reason } });
    await prisma.chkEvent.create({ data: { checkId, eventType: "classify_blocked", message: reason } });
    revalidatePath(PATH);
  };

  if (!payee) return fail("A payee is required.");
  if (!categoryName) return fail("An expense category (QBO account name) is required.");
  const amount = amountRaw ? Number(amountRaw) : NaN;
  if (!checkNumber) return fail("A check number is required.");
  if (!Number.isFinite(amount) || amount <= 0) return fail("A positive amount is required.");

  try {
    const { getQboEnvironment } = await import("@/lib/config-store");
    const { getContext } = await import("@/lib/qbo/client");
    const { resolveAccountByName, resolveOrCreateVendor } = await import("@/lib/checks/qbo-check");
    const ctx = await getContext(await getQboEnvironment());

    // Prefer the id chosen from the dropdown; fall back to resolving the typed
    // name (and, for a vendor, creating it if it's genuinely new).
    const account =
      categoryId
        ? { value: categoryId, name: categoryName }
        : await resolveAccountByName(ctx, categoryName);
    if (!account) return fail(`No active QBO account named "${categoryName}". Pick one from the list.`);
    const vendor =
      vendorId
        ? { value: vendorId, name: vendorName }
        : await resolveOrCreateVendor(ctx, vendorName);
    if (!vendor) return fail(`Could not resolve or create the QBO vendor "${vendorName}".`);

    await prisma.chkCheck.update({
      where: { id: checkId },
      data: {
        checkNumber,
        amount: new Prisma.Decimal(amount.toFixed(2)),
        checkDate: checkDate || null,
        payeeResolved: payee,
        qboVendorId: vendor.value,
        qboVendorName: vendor.name,
        categoryAccountId: account.value,
        categoryAccountName: account.name,
        status: "ready",
        statusReason: `Confirmed by ${user.email}.`,
      },
    });

    if (remember) {
      const key = normalizePayee(payee);
      await prisma.chkPayeeMapping.upsert({
        where: { normalizedPayee: key },
        create: {
          normalizedPayee: key,
          payeeDisplay: payee,
          qboVendorId: vendor.value,
          qboVendorName: vendor.name,
          categoryAccountId: account.value,
          categoryAccountName: account.name,
          timesConfirmed: 1,
        },
        update: {
          payeeDisplay: payee,
          qboVendorId: vendor.value,
          qboVendorName: vendor.name,
          categoryAccountId: account.value,
          categoryAccountName: account.name,
          timesConfirmed: { increment: 1 },
          active: true,
        },
      });
    }

    await prisma.chkEvent.create({
      data: {
        checkId,
        eventType: "classify",
        message: `Classified check ${checkNumber} → ${vendor.name} / ${account.name}${remember ? " (mapping learned)" : ""}.`,
      },
    });
    revalidatePath(PATH);
  } catch (err) {
    return fail(`Classification failed: ${String(err)}`.slice(0, 1800));
  }
}

/** Mark a check as skipped (won't post; e.g. a void or a duplicate scan). */
export async function skipCheckAction(formData: FormData) {
  await requirePermission("edit_mappings");
  const checkId = String(formData.get("checkId") ?? "");
  if (!checkId) throw new Error("Missing checkId");
  await prisma.chkCheck.update({ where: { id: checkId }, data: { status: "skipped", statusReason: "Skipped by owner." } });
  await prisma.chkEvent.create({ data: { checkId, eventType: "skip", message: "Skipped." } });
  revalidatePath(PATH);
}

// --- create (post to QBO) --------------------------------------------------

interface ChkCreateContext {
  gateEnv: "sandbox" | "live";
  ctx: Awaited<ReturnType<typeof import("@/lib/qbo/client").getContext>>;
  bankId: string;
}

/** Rollout gate (never dry-run, valid creds) + resolve Chase Checking 9680. */
async function prepareCheckCreateContext(): Promise<{ ok: true; value: ChkCreateContext } | { ok: false; reason: string }> {
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
  const ctx = await getContext(gate.environment!);
  return { ok: true, value: { gateEnv: gate.environment!, ctx, bankId: chase.qboAccountId } };
}

type ChkCreateOutcome = { status: "created" | "skipped" | "blocked" | "error"; message?: string };

/**
 * Post ONE ready check to QBO as a Check (Purchase). Guards: must be ready and
 * fully resolved (vendor + category + number + amount); a fresh duplicate scan
 * refuses to post if a check with the same number already exists on Chase 9680.
 * Records events; does NOT revalidate.
 */
async function createOneCheck(
  check: Prisma.ChkCheckGetPayload<object>,
  cc: ChkCreateContext,
  userEmail: string
): Promise<ChkCreateOutcome> {
  const { findChecksByDocNumber, postCheck } = await import("@/lib/checks/qbo-check");

  const blocked = async (message: string): Promise<ChkCreateOutcome> => {
    await prisma.chkCheck.update({ where: { id: check.id }, data: { statusReason: message } });
    await prisma.chkEvent.create({ data: { checkId: check.id, eventType: "create_blocked", message } });
    return { status: "blocked", message };
  };

  if (check.qboPurchaseId) return { status: "skipped" };
  if (check.status !== "ready") return blocked("Not ready — confirm the vendor & category first.");
  if (!check.checkNumber) return blocked("No check number.");
  if (!check.qboVendorId || !check.categoryAccountId) return blocked("Vendor or category not resolved — re-confirm.");
  const amount = check.amount !== null ? Number(check.amount) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) return blocked("No positive amount.");

  // Duplicate guard: same check number already on this bank account.
  const existing = await findChecksByDocNumber(cc.ctx, check.checkNumber, cc.bankId);
  if (existing.length) {
    return blocked(`Check #${check.checkNumber} already exists in QBO (Purchase ${existing[0].id}) — not posting a duplicate.`);
  }

  let result;
  try {
    result = await postCheck(cc.ctx, {
      bankAccountId: cc.bankId,
      vendor: { value: check.qboVendorId, name: check.qboVendorName ?? check.payeeResolved ?? "Vendor" },
      categoryAccountId: check.categoryAccountId,
      categoryAccountName: check.categoryAccountName ?? undefined,
      docNumber: check.checkNumber,
      amount,
      txnDate: check.checkDate || new Date().toISOString().slice(0, 10),
      privateNote: `GCD Check Reception | #${check.checkNumber} | ${check.payeeResolved ?? ""}`,
      memo: check.memo ?? undefined,
    });
  } catch (err) {
    const detail = (err as { detail?: unknown })?.detail;
    const message = `QBO rejected check: ${String(err)}${detail ? ` · ${JSON.stringify(detail)}` : ""}`.slice(0, 1800);
    await prisma.chkEvent.create({ data: { checkId: check.id, eventType: "create_error", message } });
    return { status: "error", message: String(err) };
  }

  await prisma.chkCheck.update({
    where: { id: check.id },
    data: { status: "created", qboPurchaseId: result.qboTransactionId, statusReason: `Posted by ${userEmail}.` },
  });
  await prisma.chkEvent.create({
    data: {
      checkId: check.id,
      eventType: "create_check",
      message: `Created Chase check ${result.qboTransactionId} (#${check.checkNumber}, ${amount.toFixed(2)} to ${
        check.qboVendorName ?? check.payeeResolved
      }) by ${userEmail}.`,
      dataJson: { purchaseId: result.qboTransactionId, totalAmt: result.totalAmt } as unknown as object,
    },
  });
  return { status: "created" };
}

/** Create the QBO Check for one ready check (owner-only). */
export async function createCheckAction(formData: FormData) {
  const user = await requirePermission("edit_mappings");
  const checkId = String(formData.get("checkId") ?? "");
  if (!checkId) throw new Error("Missing checkId");
  try {
    const check = await prisma.chkCheck.findUnique({ where: { id: checkId } });
    if (!check) throw new Error("Check not found");
    const prep = await prepareCheckCreateContext();
    if (!prep.ok) {
      await prisma.chkEvent.create({ data: { checkId, eventType: "create_blocked", message: prep.reason } });
      await prisma.chkCheck.update({ where: { id: checkId }, data: { statusReason: prep.reason } });
      revalidatePath(PATH);
      return;
    }
    await createOneCheck(check, prep.value, user.email);
    revalidatePath(PATH);
  } catch (err) {
    await prisma.chkEvent.create({ data: { checkId, eventType: "create_error", message: `Create failed: ${String(err)}` } });
    revalidatePath(PATH);
  }
}

/**
 * Batch (owner-only): create every ready, not-yet-created check in one click.
 * Each posts through the same guarded core (duplicate scan per check); failures
 * are isolated and a batch summary is recorded.
 */
export async function createAllReadyChecksAction() {
  const user = await requirePermission("edit_mappings");
  const prep = await prepareCheckCreateContext();
  if (!prep.ok) {
    await prisma.chkEvent.create({ data: { eventType: "create_batch", message: `Batch blocked: ${prep.reason}` } });
    revalidatePath(PATH);
    return;
  }

  const ready = await prisma.chkCheck.findMany({
    where: { status: "ready", qboPurchaseId: null },
    orderBy: [{ createdAt: "asc" }],
  });

  let created = 0;
  let blocked = 0;
  let errored = 0;
  for (const check of ready) {
    try {
      const outcome = await createOneCheck(check, prep.value, user.email);
      if (outcome.status === "created") created++;
      else if (outcome.status === "blocked") blocked++;
      else if (outcome.status === "error") errored++;
    } catch (err) {
      errored++;
      await prisma.chkEvent.create({ data: { checkId: check.id, eventType: "create_error", message: `Create failed: ${String(err)}` } });
    }
  }

  await prisma.chkEvent.create({
    data: {
      eventType: "create_batch",
      message: `Batch create: ${created} created, ${blocked} blocked, ${errored} errored (of ${ready.length} ready) · env ${prep.value.gateEnv}`,
    },
  });
  revalidatePath(PATH);
}
