/**
 * "Ask My Client" import service (read-only over QBO).
 *
 * Pulls the transactions parked in the configured QBO account and mirrors them
 * into the Coworker Portal as questions so coworkers can explain each one. The
 * hub NEVER writes to QBO — once an owner reclassifies a transaction in QBO and
 * it leaves the account, the next import auto-closes its question.
 *
 * Idempotent: questions dedupe on the transaction's stable natural key, so
 * re-running only adds genuinely new transactions and refreshes snapshots.
 * Degrades (never throws to the caller) when QBO is unconfigured, disconnected,
 * or its token was rejected — mirroring the reporting pages.
 */
import { prisma } from "@/lib/db";
import { getContext, QboNotConnectedError, QboApiError } from "@/lib/qbo/client";
import { QboAuthError } from "@/lib/qbo/oauth";
import { getQboEnvironment } from "@/lib/config-store";
import { askMyClientAccountName, resolveAmcAccountId, fetchAmcTransactions } from "./qbo";
import type { AmcTransaction } from "./transactions";

export type ImportReason =
  | "not_connected" // no credential at all
  | "reconnect_required" // the token was rejected (a real reconnect case)
  | "qbo_error" // the connection is live but QBO rejected the request (see diagnostics)
  | "account_not_found"
  | "error";

/**
 * Classify a QBO failure precisely so we don't tell the user to "reconnect" when
 * the token is fine and it's actually an API/request error. Re-throws genuine
 * (non-QBO) errors so real bugs still surface.
 */
function classify(err: unknown): ImportReason {
  if (err instanceof QboNotConnectedError) return "not_connected";
  if (err instanceof QboAuthError) return "reconnect_required";
  if (err instanceof QboApiError) return "qbo_error";
  throw err;
}

export interface ImportResult {
  ok: boolean;
  reason?: ImportReason;
  accountName: string;
  found: number;
  created: number;
  updated: number;
  closed: number;
}

const money = (n: number): string =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function subjectFor(t: AmcTransaction): string {
  return `${t.type} · ${money(t.amount)}${t.name ? ` · ${t.name}` : ""}`;
}

function bodyFor(t: AmcTransaction, accountName: string): string {
  return [
    `Parked in the "${accountName}" account in QuickBooks — needs categorizing.`,
    "",
    `Date:    ${t.date}`,
    `Type:    ${t.type}`,
    t.num ? `Doc #:   ${t.num}` : "",
    t.name ? `Name:    ${t.name}` : "",
    `Amount:  ${money(t.amount)}`,
    t.memo ? `Memo:    ${t.memo}` : "",
    "",
    `Answer with the correct category/classification. An owner will re-code it in QuickBooks and remove it from "${accountName}"; once it leaves the account this question closes automatically on the next import.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Import parked transactions as questions. `importerEmail` is recorded as the
 * asker. `now` bounds the lookback window (default 3 years back → today).
 */
export async function importAskMyClient(importerEmail: string, now: Date): Promise<ImportResult> {
  const accountName = askMyClientAccountName();
  const base: ImportResult = { ok: false, accountName, found: 0, created: 0, updated: 0, closed: 0 };

  let ctx;
  try {
    ctx = await getContext(await getQboEnvironment());
  } catch (err) {
    return { ...base, reason: classify(err) };
  }

  let accountId: string | null;
  let txns: AmcTransaction[];
  try {
    accountId = await resolveAmcAccountId(ctx);
    if (!accountId) return { ...base, reason: "account_not_found" };
    const start = isoDate(new Date(Date.UTC(now.getUTCFullYear() - 3, now.getUTCMonth(), 1)));
    txns = await fetchAmcTransactions(ctx, accountId, { start, end: isoDate(now) });
  } catch (err) {
    return { ...base, reason: classify(err) };
  }

  // Existing imported questions, to split create vs. update and to detect ones
  // whose transaction has since left the account (→ close them).
  const existing = await prisma.cwpQuestion.findMany({
    where: { source: "ask_my_client" },
    select: { id: true, qboTxnId: true, status: true },
  });
  const existingKeys = new Set(existing.map((q) => q.qboTxnId ?? ""));
  const seen = new Set<string>();

  // Two distinct transactions can share the same natural key (same day, payee,
  // amount, and no doc number). Disambiguate identical keys within the batch with
  // an occurrence ordinal so each physical transaction gets its own stable id and
  // the (qboTxnType, qboTxnId) unique index never collides. QBO returns the rows
  // in a stable order, so the ordinals are stable across re-imports (idempotent).
  const occurrence = new Map<string, number>();

  let created = 0;
  let updated = 0;
  for (const t of txns) {
    const n = (occurrence.get(t.key) ?? 0) + 1;
    occurrence.set(t.key, n);
    const uniqueKey = n === 1 ? t.key : `${t.key}#${n}`;
    seen.add(uniqueKey);
    const isNew = !existingKeys.has(uniqueKey);

    // upsert (not create/update) so a row that already exists in the DB is
    // updated atomically rather than racing a duplicate create.
    await prisma.cwpQuestion.upsert({
      where: { qboTxnType_qboTxnId: { qboTxnType: t.type, qboTxnId: uniqueKey } },
      create: {
        source: "ask_my_client",
        qboTxnType: t.type,
        qboTxnId: uniqueKey,
        qboTxnDate: t.date,
        qboTxnAmount: t.amount,
        qboTxnName: t.name || null,
        qboReference: `${t.type} ${t.num}`.trim(),
        subject: subjectFor(t),
        body: bodyFor(t, accountName),
        askedByEmail: importerEmail,
        assignedEmail: null,
        status: "open",
      },
      update: {
        qboTxnDate: t.date,
        qboTxnAmount: t.amount,
        qboTxnName: t.name || null,
        qboReference: `${t.type} ${t.num}`.trim(),
        subject: subjectFor(t),
        body: bodyFor(t, accountName),
      },
    });
    if (isNew) created++;
    else updated++;
  }

  // Auto-close imported questions whose transaction is no longer in the account
  // (it was reclassified in QBO). We never delete — the Q&A history is preserved.
  const toClose = existing.filter((q) => q.status !== "closed" && !seen.has(q.qboTxnId ?? ""));
  if (toClose.length) {
    await prisma.cwpQuestion.updateMany({
      where: { id: { in: toClose.map((q) => q.id) } },
      data: { status: "closed" },
    });
  }

  return { ok: true, accountName, found: txns.length, created, updated, closed: toClose.length };
}
