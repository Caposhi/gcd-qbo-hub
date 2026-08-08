/**
 * QBO I/O for the account-register reconciliation assistant (§Phase 5).
 * Pure comparison logic lives in src/lib/cashsheet/reconciliation.ts; this
 * file only fetches. Read-only — never posts, edits, or deletes anything.
 *
 * KNOWN GAP: only Purchase and Deposit are fetched. There's no existing,
 * proven example anywhere in this codebase of querying a QBO Transfer
 * entity (buildTransfer in posting.ts only ever writes one), and guessing
 * at unverified query syntax for a new entity type is worse than clearly
 * omitting it — if the sheet ever posts a real Bank Deposit (transfer) row,
 * add and test a Transfer fetch here before trusting this for that account
 * activity.
 */
import { query, type QboContext } from "./client";

function escapeQuery(v: string): string {
  return v.replace(/'/g, "\\'");
}

export interface RegisterTxn {
  id: string;
  type: "Purchase" | "Deposit";
  date: string; // YYYY-MM-DD
  amount: number; // absolute value; direction carries the sign
  direction: "in" | "out";
  privateNote: string;
  docNumber: string | null;
  payee: string | null;
}

/**
 * Every Purchase/Deposit touching `accountId` within [startDate, endDate]
 * (inclusive, YYYY-MM-DD). Fetched by date only — the same proven query
 * shape already used elsewhere in this codebase (qbo-check.ts, deposits.ts)
 * — then filtered to the target account client-side, since there's no
 * existing precedent here for filtering Purchase/Deposit by AccountRef
 * server-side and this avoids guessing at unverified query syntax.
 */
export async function fetchAccountRegister(
  ctx: QboContext,
  accountId: string,
  startDate: string,
  endDate: string
): Promise<RegisterTxn[]> {
  const dateClause = `TxnDate >= '${escapeQuery(startDate)}' and TxnDate <= '${escapeQuery(endDate)}'`;
  const [purchaseRes, depositRes] = await Promise.all([
    query<{ QueryResponse?: { Purchase?: any[] } }>(ctx, `select * from Purchase where ${dateClause} MAXRESULTS 1000`),
    query<{ QueryResponse?: { Deposit?: any[] } }>(ctx, `select * from Deposit where ${dateClause} MAXRESULTS 1000`),
  ]);

  const out: RegisterTxn[] = [];

  for (const p of purchaseRes.QueryResponse?.Purchase ?? []) {
    // A Purchase's top-level AccountRef is the account it was PAID FROM
    // (confirmed by the existing Check Reception module's own Purchase
    // queries, and matches exactly what buildPurchase() in posting.ts sets).
    if (String(p.AccountRef?.value ?? "") !== accountId) continue;
    out.push({
      id: String(p.Id),
      type: "Purchase",
      date: String(p.TxnDate ?? ""),
      amount: Math.abs(Number(p.TotalAmt ?? 0)),
      direction: "out",
      privateNote: String(p.PrivateNote ?? ""),
      docNumber: p.DocNumber ?? null,
      payee: p.EntityRef?.name ?? null,
    });
  }

  for (const d of depositRes.QueryResponse?.Deposit ?? []) {
    if (String(d.DepositToAccountRef?.value ?? "") !== accountId) continue;
    out.push({
      id: String(d.Id),
      type: "Deposit",
      date: String(d.TxnDate ?? ""),
      amount: Math.abs(Number(d.TotalAmt ?? 0)),
      direction: "in",
      privateNote: String(d.PrivateNote ?? ""),
      docNumber: d.DocNumber ?? null,
      payee: d.Line?.[0]?.DepositLineDetail?.Entity?.name ?? d.Line?.[0]?.Description ?? null,
    });
  }

  return out.sort((a, b) => a.date.localeCompare(b.date));
}
