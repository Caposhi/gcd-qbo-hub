/**
 * Build & post QBO Accounting transactions from a PostingPlan (§6, §9, §10, §16).
 *
 * One function per category:
 *   - expense  → Purchase (PaymentType Cash) paid from Cash on hand (§6A)
 *   - deposit  → Deposit into Cash on hand (§6B: SCRAP, LOAN TO COMP, OVER/SHORT)
 *   - transfer → Transfer Cash on hand → Chase Checking 9680 (§6C)
 *   - audit_only → NEVER posts; attempts to find an existing QBO record (§6B/INV)
 *
 * Every posted transaction carries the GCD row UUID in its memo/private note and
 * a deterministic DocNumber where supported (§9). We store request/response
 * REDACTED and the SyncToken — but never use the SyncToken to auto-edit (§10, §22).
 */
import type { PostingPlan } from "@/lib/cashsheet/classify";
import type { ParsedRow } from "@/lib/cashsheet/rows";
import { buildMemo, buildDocNumber } from "@/lib/cashsheet/memo";
import { getContext, post, query, redactPayload, type QboContext } from "./client";
import type { QboEnvironment } from "@/lib/cashsheet/rollout";

export interface PostResult {
  qboTransactionId: string;
  qboTransactionType: string;
  qboSyncToken: string | null;
  qboDocNumber: string | null;
  requestRedacted: unknown;
  responseRedacted: unknown;
}

function accountRef(id: string | null | undefined, name?: string | null) {
  return { value: id ?? "", name: name ?? undefined };
}

/** Post the plan to QBO. Throws if the plan is not postable (audit_only/none). */
export async function postPlan(
  plan: PostingPlan,
  row: ParsedRow,
  tabName: string,
  rowUuid: string,
  environment: QboEnvironment
): Promise<PostResult> {
  if (plan.action === "audit_only" || plan.action === "none") {
    throw new Error(`postPlan called for non-postable action "${plan.action}"`);
  }
  if (plan.amount === null) throw new Error("postPlan called with null amount");

  const ctx = await getContext(environment);
  const memo = buildMemo(tabName, row, rowUuid);
  const docNumber = buildDocNumber(rowUuid);

  switch (plan.action) {
    case "expense":
      return doPost(ctx, "purchase", buildPurchase(plan, memo, docNumber), "Purchase");
    case "deposit":
      return doPost(ctx, "deposit", buildDeposit(plan, memo, docNumber), "Deposit");
    case "transfer":
      return doPost(ctx, "transfer", buildTransfer(plan, memo), "Transfer");
    default:
      throw new Error(`Unsupported action ${plan.action}`);
  }
}

function buildPurchase(plan: PostingPlan, memo: string, docNumber: string) {
  return {
    PaymentType: "Cash",
    AccountRef: accountRef(plan.cashAccountId, plan.cashAccount),
    DocNumber: docNumber,
    PrivateNote: memo,
    Line: [
      {
        Amount: plan.amount,
        DetailType: "AccountBasedExpenseLineDetail",
        Description: memo,
        AccountBasedExpenseLineDetail: {
          AccountRef: accountRef(plan.categoryAccountId, plan.categoryAccount),
        },
      },
    ],
  };
}

function buildDeposit(plan: PostingPlan, memo: string, docNumber: string) {
  return {
    DepositToAccountRef: accountRef(plan.cashAccountId, plan.cashAccount),
    DocNumber: docNumber,
    PrivateNote: memo,
    Line: [
      {
        Amount: plan.amount,
        DetailType: "DepositLineDetail",
        Description: memo,
        DepositLineDetail: {
          AccountRef: accountRef(plan.categoryAccountId, plan.categoryAccount),
        },
      },
    ],
  };
}

function buildTransfer(plan: PostingPlan, memo: string) {
  // QBO Transfer has no DocNumber field; the memo carries the row UUID.
  return {
    FromAccountRef: accountRef(plan.cashAccountId, plan.cashAccount),
    ToAccountRef: accountRef(plan.destinationAccountId, plan.destinationAccount),
    Amount: plan.amount,
    PrivateNote: memo,
  };
}

async function doPost(
  ctx: QboContext,
  entity: string,
  body: unknown,
  typeName: string
): Promise<PostResult> {
  const res = await post<Record<string, any>>(ctx, entity, body);
  const created = res[typeName] ?? {};
  return {
    qboTransactionId: String(created.Id ?? ""),
    qboTransactionType: typeName,
    qboSyncToken: created.SyncToken != null ? String(created.SyncToken) : null,
    qboDocNumber: created.DocNumber ?? null,
    requestRedacted: redactPayload(body),
    responseRedacted: redactPayload(res),
  };
}

// ---------------------------------------------------------------------------
// Audit-only invoice matching (§6B, §19) — NEVER creates a transaction.
// ---------------------------------------------------------------------------

export interface QboMatch {
  found: boolean;
  candidates: Array<{ id: string; type: string; docNumber?: string; total?: number; date?: string }>;
}

/**
 * Attempt to find an existing QBO transaction matching an INV cash collection
 * by invoice/doc number, then by amount+date. Returns candidates for the
 * dashboard to link; if none, the caller flags "QBO Match Not Found".
 */
export async function findInvoiceMatch(
  row: ParsedRow,
  environment: QboEnvironment
): Promise<QboMatch> {
  const ctx = await getContext(environment);
  const candidates: QboMatch["candidates"] = [];

  const inv = row.invNumber.trim();
  if (inv) {
    const byDoc = await query<{ QueryResponse?: { Invoice?: any[] } }>(
      ctx,
      `select Id, DocNumber, TotalAmt, TxnDate from Invoice where DocNumber = '${escapeQuery(inv)}'`
    );
    for (const i of byDoc.QueryResponse?.Invoice ?? []) {
      candidates.push({ id: String(i.Id), type: "Invoice", docNumber: i.DocNumber, total: i.TotalAmt, date: i.TxnDate });
    }
  }

  // Fall back to amount match on Payments (cash received) if no doc match.
  if (candidates.length === 0 && row.amount) {
    const byAmt = await query<{ QueryResponse?: { Payment?: any[] } }>(
      ctx,
      `select Id, TotalAmt, TxnDate from Payment where TotalAmt = '${row.amount}'`
    );
    for (const p of byAmt.QueryResponse?.Payment ?? []) {
      candidates.push({ id: String(p.Id), type: "Payment", total: p.TotalAmt, date: p.TxnDate });
    }
  }

  return { found: candidates.length > 0, candidates };
}

/**
 * Optional pre-post duplicate search in QBO (§10): look for a transaction that
 * already carries our deterministic DocNumber. If found, the caller flags
 * "Possible Duplicate" instead of blindly posting.
 */
export async function findByDocNumber(
  docNumber: string,
  environment: QboEnvironment
): Promise<string[]> {
  const ctx = await getContext(environment);
  const hits: string[] = [];
  for (const entity of ["Purchase", "Deposit"]) {
    const res = await query<{ QueryResponse?: Record<string, any[]> }>(
      ctx,
      `select Id from ${entity} where DocNumber = '${escapeQuery(docNumber)}'`
    );
    for (const t of res.QueryResponse?.[entity] ?? []) hits.push(`${entity}:${t.Id}`);
  }
  return hits;
}

function escapeQuery(v: string): string {
  return v.replace(/'/g, "\\'");
}
