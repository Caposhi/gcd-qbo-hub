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

  const mappings = (await prisma.chkPayeeMapping.findMany({ where: { active: true } })) as PayeeMappingLike[];
  const dec = (n: number) => new Prisma.Decimal(n.toFixed(2));

  // Best-effort QBO prefill: fetch the vendor list once and, for each check,
  // suggest the closest vendor (fuzzy) and — when there's no learned mapping —
  // that vendor's usual category from its QBO history, the way QBO auto-fills.
  // If QBO isn't reachable we still ingest; the dropdowns just start blank.
  // Fetched BEFORE the vision read so the known vendor names can also be
  // handed to extractChecksFromPdf as a read-time hint: a payee whose
  // handwriting is ambiguous between two similar names (e.g. "Nitrix" vs. an
  // actual vendor "Witrix") should be biased toward the name that's real.
  let vendors: Awaited<ReturnType<typeof import("@/lib/checks/qbo-check").listVendors>> = [];
  let vendorCategory = new Map<string, { id: string; name: string }>();
  // Check numbers already recorded in QBO on Chase 9680 (with their amount) → so
  // a check we've already posted is flagged "already in QBO" on read, and a check
  // number that exists at a DIFFERENT amount is surfaced as a discrepancy rather
  // than a false "already in QBO".
  let existingChecks = new Map<string, { id: string; total: number; payee: string }>();
  let qboReached = false;
  try {
    const { getQboEnvironment } = await import("@/lib/config-store");
    const { getContext } = await import("@/lib/qbo/client");
    const { listVendors, buildVendorCategoryMap, listExistingCheckDocNumbers } = await import("@/lib/checks/qbo-check");
    const ctx = await getContext(await getQboEnvironment());
    const chase = await prisma.accountMapping.findFirst({ where: { friendlyName: "Chase Checking 9680" } });
    const [v, vc, existing] = await Promise.all([
      listVendors(ctx),
      buildVendorCategoryMap(ctx),
      chase?.qboAccountId
        ? listExistingCheckDocNumbers(ctx, chase.qboAccountId)
        : Promise.resolve(new Map<string, { id: string; total: number; payee: string }>()),
    ]);
    vendors = v;
    vendorCategory = vc;
    existingChecks = existing;
    qboReached = true;
  } catch {
    qboReached = false;
  }

  let extraction;
  try {
    extraction = await extractChecksFromPdf(bytes, { knownVendorNames: vendors.map((v) => v.name) });
  } catch (err) {
    await prisma.chkEvent.create({
      data: { eventType: "ingest_error", message: `Could not read the PDF: ${String(err)}`.slice(0, 1800) },
    });
    revalidatePath(PATH);
    return;
  }

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
  let alreadyInQbo = 0;
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

    // Already recorded in QBO (same check number on Chase 9680)? If the amount
    // ALSO matches, it's a benign "already in QBO". If a check with that number
    // exists at a DIFFERENT amount, that existing entry is wrong (or a different
    // check) — QBO can't match the bank line to a wrong-amount entry — so surface
    // it as a discrepancy to fix rather than a silent "done".
    const existing = c.checkNumber ? existingChecks.get(c.checkNumber.trim()) : undefined;
    if (existing) {
      const amtMatches = c.amount !== null && Math.abs(Math.round(existing.total * 100) - Math.round(c.amount * 100)) <= 1;
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
          status: amtMatches ? "already_in_qbo" : "needs_review",
          statusReason: amtMatches
            ? `Already in QBO (Purchase ${existing.id}) — check #${c.checkNumber} is already recorded on Chase 9680; nothing to post.`
            : `⚠️ Check # collision: QBO already has check #${c.checkNumber} (Purchase ${existing.id}) for $${existing.total.toFixed(
                2
              )}${existing.payee ? ` to ${existing.payee}` : ""}, but this check is $${(c.amount ?? 0).toFixed(2)}${
                c.payee ? ` to ${c.payee}` : ""
              }. Different amount/payee — likely a number reused by an electronic draft. Re-number or fix Purchase ${existing.id} in QBO, then re-read.`,
        },
      });
      if (amtMatches) alreadyInQbo++;
      continue;
    }

    const mapping = findPayeeMapping(mappings, c.payee);
    const cls = classifyExtractedCheck(c, mapping);
    if (cls.status === "ready") ready++;

    // Prefill vendor + category suggestions (learned mapping wins; else fuzzy
    // match to an EXISTING QBO vendor + that vendor's usual category).
    let vendorId = cls.qboVendorId;
    let vendorName = cls.qboVendorName;
    let categoryId = cls.categoryAccountId;
    let categoryName = cls.categoryAccountName;
    if (!mapping && qboReached) {
      const { bestVendorMatch } = await import("@/lib/checks/match");
      const vm = bestVendorMatch(c.payee, vendors);
      if (vm) {
        vendorId = vm.id;
        vendorName = vm.name;
        const cat = vendorCategory.get(vm.id);
        if (cat && !categoryId) {
          categoryId = cat.id;
          categoryName = cat.name;
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
  const needReview = counted - ready - alreadyInQbo;
  await prisma.chkEvent.create({
    data: {
      eventType: "ingest",
      message: `Read ${extraction.checks.length} page(s) from ${f.name || "PDF"} — ${counted} check(s) (${ready} ready, ${needReview} need review${
        alreadyInQbo ? `, ${alreadyInQbo} already in QBO` : ""
      })${skipped ? `, ${skipped} non-check page(s) skipped` : ""}${
        qboReached ? "" : " · QBO not reached, dropdowns unfilled"
      }.`,
      dataJson: { usage: extraction.usage } as unknown as object,
    },
  });
  revalidatePath(PATH);
}

/**
 * Confirm/correct one check's classification: resolve the QBO vendor and expense
 * category, save, and TEACH the mapping. On success the check becomes "ready".
 *
 * Two behaviors the owner asked for:
 *  - Never create a near-duplicate vendor. If the vendor field wasn't picked from
 *    the dropdown (no id) and the typed name closely matches an existing QBO
 *    vendor ("Interstate Batteries" ≈ "Interstate Battery"), we USE the existing
 *    one instead of creating a new vendor.
 *  - Learn the handwriting. The "payee as read" is optional — when it's a misread
 *    Claude couldn't place (or blank), the vendor is enough. If the raw read
 *    differs from the confirmed payee, we store it as an alias so the same
 *    handwriting pre-fills next time.
 */
export async function classifyCheckAction(formData: FormData) {
  const user = await requirePermission("edit_mappings");
  const checkId = String(formData.get("checkId") ?? "");
  if (!checkId) throw new Error("Missing checkId");

  const payeeInput = String(formData.get("payee") ?? "").trim();
  const vendorName = String(formData.get("vendorName") ?? "").trim();
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

  // Payee (as read) is optional — the confirmed vendor is what matters. Use the
  // vendor name as the display/key when no payee was read.
  const payee = payeeInput || vendorName;
  if (!vendorName && !vendorId) return fail("A QBO vendor is required.");
  if (!categoryName && !categoryId) return fail("An expense category is required.");
  const amount = amountRaw ? Number(amountRaw) : NaN;
  if (!checkNumber) return fail("A check number is required.");
  if (!Number.isFinite(amount) || amount <= 0) return fail("A positive amount is required.");

  try {
    const { getQboEnvironment } = await import("@/lib/config-store");
    const { getContext } = await import("@/lib/qbo/client");
    const { resolveAccountByName, resolveOrCreateVendor, listVendors } = await import("@/lib/checks/qbo-check");
    const { bestVendorMatch } = await import("@/lib/checks/match");
    const ctx = await getContext(await getQboEnvironment());

    const check = await prisma.chkCheck.findUnique({ where: { id: checkId } });

    // Prefer the id chosen from the dropdown; fall back to resolving the typed
    // name.
    const account = categoryId
      ? { value: categoryId, name: categoryName }
      : await resolveAccountByName(ctx, categoryName);
    if (!account) return fail(`No active QBO account named "${categoryName}". Pick one from the list.`);

    let vendor: { value: string; name: string } | null;
    let vendorNote = "";
    if (vendorId) {
      vendor = { value: vendorId, name: vendorName || payee };
    } else {
      // No dropdown pick: before creating anything, look hard for an existing
      // vendor whose name closely matches (plural/spelling drift, partial name).
      const vendors = await listVendors(ctx);
      const near = bestVendorMatch(vendorName, vendors, 0.82);
      const exact = vendors.find((v) => v.name.toLowerCase() === vendorName.toLowerCase());
      if (exact) {
        vendor = { value: exact.id, name: exact.name };
      } else if (near) {
        vendor = { value: near.id, name: near.name };
        vendorNote = ` Matched existing vendor "${near.name}" (you typed "${vendorName}") instead of creating a duplicate.`;
      } else {
        vendor = await resolveOrCreateVendor(ctx, vendorName);
        if (vendor) vendorNote = ` Created new vendor "${vendor.name}".`;
      }
    }
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
        statusReason: `Confirmed by ${user.email}.${vendorNote}`,
      },
    });

    if (remember) {
      const key = normalizePayee(payee);
      // Learn the raw read as an alias when it differs from the confirmed payee
      // (a misread Claude couldn't place) — so the same handwriting resolves next
      // time. Skip if it equals the key or is blank.
      const rawKey = normalizePayee(check?.payeeRaw);
      const aliasToAdd = rawKey && rawKey !== key ? rawKey : null;
      const existing = await prisma.chkPayeeMapping.findUnique({ where: { normalizedPayee: key } });
      const aliases = new Set(existing?.rawAliases ?? []);
      if (aliasToAdd) aliases.add(aliasToAdd);
      await prisma.chkPayeeMapping.upsert({
        where: { normalizedPayee: key },
        create: {
          normalizedPayee: key,
          payeeDisplay: payee,
          qboVendorId: vendor.value,
          qboVendorName: vendor.name,
          categoryAccountId: account.value,
          categoryAccountName: account.name,
          rawAliases: aliasToAdd ? [aliasToAdd] : [],
          timesConfirmed: 1,
        },
        update: {
          payeeDisplay: payee,
          qboVendorId: vendor.value,
          qboVendorName: vendor.name,
          categoryAccountId: account.value,
          categoryAccountName: account.name,
          rawAliases: [...aliases],
          timesConfirmed: { increment: 1 },
          active: true,
        },
      });
    }

    await prisma.chkEvent.create({
      data: {
        checkId,
        eventType: "classify",
        message: `Classified check ${checkNumber} → ${vendor.name} / ${account.name}${remember ? " (mapping learned)" : ""}.${vendorNote}`,
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

type ChkCreateOutcome = { status: "created" | "skipped" | "blocked" | "error" | "already_in_qbo"; message?: string };

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

  // Duplicate guard: same check number already on this bank account. Only a true
  // duplicate when the AMOUNT matches too — then mark "already in QBO". If a
  // check with that number exists at a different amount, block with a discrepancy
  // message (the existing entry is wrong / a different check); never post a
  // second check with the same number.
  const existing = await findChecksByDocNumber(cc.ctx, check.checkNumber, cc.bankId);
  if (existing.length) {
    const amtMatch = existing.find((e) => Math.abs(Math.round(e.total * 100) - Math.round(amount * 100)) <= 1);
    if (amtMatch) {
      const message = `Already in QBO (Purchase ${amtMatch.id}) — check #${check.checkNumber} ($${amount.toFixed(
        2
      )}) is already recorded on Chase 9680; not posting a duplicate.`;
      await prisma.chkCheck.update({ where: { id: check.id }, data: { status: "already_in_qbo", statusReason: message } });
      await prisma.chkEvent.create({ data: { checkId: check.id, eventType: "already_in_qbo", message } });
      return { status: "already_in_qbo", message };
    }
    const e = existing[0];
    return blocked(
      `⚠️ Check # collision: QBO already has check #${check.checkNumber} (Purchase ${e.id}) for $${e.total.toFixed(2)}${
        e.payee ? ` to ${e.payee}` : ""
      }, but this check is $${amount.toFixed(2)}${
        check.qboVendorName ? ` to ${check.qboVendorName}` : ""
      }. Not posting a duplicate — re-number or fix Purchase ${e.id} in QBO first.`
    );
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
  let already = 0;
  for (const check of ready) {
    try {
      const outcome = await createOneCheck(check, prep.value, user.email);
      if (outcome.status === "created") created++;
      else if (outcome.status === "already_in_qbo") already++;
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
      message: `Batch create: ${created} created${already ? `, ${already} already in QBO (safe duplicate blocks)` : ""}${
        blocked ? `, ${blocked} blocked` : ""
      }${errored ? `, ${errored} errored` : ""} (of ${ready.length} ready) · env ${prep.value.gateEnv}`,
    },
  });
  revalidatePath(PATH);
}

/**
 * Re-check every not-yet-created check against live QBO (READ-ONLY) — the
 * on-demand "verify" the owner needs when re-uploading the PDF does nothing
 * (idempotent). Re-scans check numbers on Chase 9680 (with amount + payee) and
 * re-classifies each open check:
 *   - exists at the same amount → already in QBO (true duplicate)
 *   - exists at a DIFFERENT amount → needs review (check-# collision)
 *   - no longer in QBO (e.g. you re-numbered the colliding entry) → freed back to
 *     ready (if vendor + category are set) or needs review, so it can be created.
 * Never writes to QBO; only updates hub status.
 */
export async function recheckChecksAction() {
  await requirePermission("edit_mappings");
  const { getQboEnvironment } = await import("@/lib/config-store");
  const { getContext } = await import("@/lib/qbo/client");
  const { listExistingCheckDocNumbers } = await import("@/lib/checks/qbo-check");

  const chase = await prisma.accountMapping.findFirst({ where: { friendlyName: "Chase Checking 9680" } });
  if (!chase?.qboAccountId) {
    await prisma.chkEvent.create({ data: { eventType: "recheck", message: "Chase Checking 9680 mapping unresolved — can't verify against QBO." } });
    revalidatePath(PATH);
    return;
  }

  let existing: Awaited<ReturnType<typeof listExistingCheckDocNumbers>>;
  try {
    const ctx = await getContext(await getQboEnvironment());
    existing = await listExistingCheckDocNumbers(ctx, chase.qboAccountId);
  } catch (err) {
    await prisma.chkEvent.create({ data: { eventType: "recheck", message: `Couldn't reach QBO to verify: ${String(err)}`.slice(0, 500) } });
    revalidatePath(PATH);
    return;
  }

  const checks = await prisma.chkCheck.findMany({
    where: { status: { in: ["ready", "needs_review", "already_in_qbo"] }, qboPurchaseId: null },
  });

  let nowDuplicate = 0;
  let nowCollision = 0;
  let freed = 0;
  for (const c of checks) {
    if (!c.checkNumber) continue;
    const amt = c.amount != null ? Number(c.amount) : null;
    const e = existing.get(c.checkNumber.trim());
    if (e) {
      const amtMatch = amt != null && Math.abs(Math.round(e.total * 100) - Math.round(amt * 100)) <= 1;
      if (amtMatch) {
        if (c.status !== "already_in_qbo") nowDuplicate++;
        await prisma.chkCheck.update({
          where: { id: c.id },
          data: {
            status: "already_in_qbo",
            statusReason: `Already in QBO (Purchase ${e.id}) — check #${c.checkNumber} ($${(amt ?? 0).toFixed(2)})${
              e.payee ? ` to ${e.payee}` : ""
            } is already recorded on Chase 9680; nothing to post.`,
          },
        });
      } else {
        if (c.status !== "needs_review") nowCollision++;
        await prisma.chkCheck.update({
          where: { id: c.id },
          data: {
            status: "needs_review",
            statusReason: `⚠️ Check # collision: QBO already has check #${c.checkNumber} (Purchase ${e.id}) for $${e.total.toFixed(
              2
            )}${e.payee ? ` to ${e.payee}` : ""}, but this check is $${(amt ?? 0).toFixed(
              2
            )}. Re-number or fix Purchase ${e.id} in QBO, then re-check.`,
          },
        });
      }
    } else if (c.status === "already_in_qbo") {
      // The QBO entry that was blocking this check is gone (renumbered/voided) —
      // free it so it can be created.
      const readyToPost = !!(c.qboVendorId && c.categoryAccountId);
      freed++;
      await prisma.chkCheck.update({
        where: { id: c.id },
        data: {
          status: readyToPost ? "ready" : "needs_review",
          statusReason: readyToPost
            ? "No longer in QBO — ready to create."
            : "No longer in QBO — confirm the vendor & category to create.",
        },
      });
    }
  }

  await prisma.chkEvent.create({
    data: {
      eventType: "recheck",
      message: `QBO re-check: ${checks.length} open check(s) verified — ${nowDuplicate} newly already-in-QBO, ${nowCollision} collision(s), ${freed} freed to create.`,
    },
  });
  revalidatePath(PATH);
}
