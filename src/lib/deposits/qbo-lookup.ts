/**
 * Live QBO lookups for deposit reconciliation (read-only).
 *
 * Locates the Undeposited-Funds customer payments that make up a payout, by
 * amount within a date window. This is the "propose" precondition: before the
 * hub ever creates a deposit, it confirms every gross charge in a payout maps
 * to a real payment in QBO (Back Office posts these). Fee journal-entry linking
 * and the actual Deposit creation come in the posting step (which needs the
 * LinkedTxn spike) — this module never writes.
 */
import { query, type QboContext } from "@/lib/qbo/client";

export interface QboPaymentCandidate {
  id: string;
  amount: number;
  date: string;
}

function escapeQuery(v: string): string {
  return v.replace(/'/g, "\\'");
}

/** Payments with an exact amount in [startDate, endDate] (YYYY-MM-DD). */
export async function findPaymentsByAmount(
  ctx: QboContext,
  amount: number,
  startDate: string,
  endDate: string
): Promise<QboPaymentCandidate[]> {
  const amt = amount.toFixed(2);
  const res = await query<{ QueryResponse?: { Payment?: any[] } }>(
    ctx,
    `select Id, TotalAmt, TxnDate from Payment where TotalAmt = '${escapeQuery(amt)}' ` +
      `and TxnDate >= '${escapeQuery(startDate)}' and TxnDate <= '${escapeQuery(endDate)}'`
  );
  return (res.QueryResponse?.Payment ?? []).map((p) => ({
    id: String(p.Id),
    amount: Number(p.TotalAmt),
    date: String(p.TxnDate),
  }));
}

/**
 * Payments with TotalAmt in [low, high] within [startDate, endDate]. Used for
 * tolerant matching when the processor's charged amount differs from the QBO
 * customer payment by a small terminal-keying discrepancy.
 */
export async function findPaymentsInRange(
  ctx: QboContext,
  low: number,
  high: number,
  startDate: string,
  endDate: string
): Promise<QboPaymentCandidate[]> {
  const res = await query<{ QueryResponse?: { Payment?: any[] } }>(
    ctx,
    `select Id, TotalAmt, TxnDate from Payment where TotalAmt >= '${escapeQuery(low.toFixed(2))}' ` +
      `and TotalAmt <= '${escapeQuery(high.toFixed(2))}' ` +
      `and TxnDate >= '${escapeQuery(startDate)}' and TxnDate <= '${escapeQuery(endDate)}'`
  );
  return (res.QueryResponse?.Payment ?? []).map((p) => ({
    id: String(p.Id),
    amount: Number(p.TotalAmt),
    date: String(p.TxnDate),
  }));
}

/** Fetch TotalAmt for a set of payment ids (for computing a deposit's plug). */
export async function getPaymentAmounts(ctx: QboContext, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const list = ids.map((id) => `'${escapeQuery(id)}'`).join(",");
  const res = await query<{ QueryResponse?: { Payment?: any[] } }>(
    ctx,
    `select Id, TotalAmt from Payment where Id in (${list})`
  );
  for (const p of res.QueryResponse?.Payment ?? []) out.set(String(p.Id), Number(p.TotalAmt));
  return out;
}

/** Shift a YYYY-MM-DD date by N days (negative = earlier). */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
