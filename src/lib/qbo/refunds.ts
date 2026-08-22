/**
 * Undeposited-Funds REFUNDS — the third thing that can sit between a payout's
 * gross charges and what actually landed in the bank.
 *
 * A Tekmetric/Stripe payout is `Σ gross − Σ fees − Σ refunds`. Fees are matched
 * from Back Office's fee journal entries (journal-entries.ts); this module finds
 * the refunds. Without them a payout containing a refunded charge can never tie:
 * observed live on the 2026-08-06 payout, where gross − net was $2,041.04 while
 * the real processor fees were $312.99 — the other $1,728.05 was a refund, so no
 * amount of fee matching could close the gap.
 *
 * A refund can land in Undeposited Funds two ways, and which one depends on how
 * the refund was recorded — so we look for BOTH rather than assuming:
 *   - a **Refund Receipt** deposited to Undeposited Funds, or
 *   - a **journal entry** that DEBITS Undeposited Funds (the mirror of a fee JE,
 *     which credits it).
 *
 * Read-only. The pure matcher (`pickRefundsForGap`) is unit-tested; the query is
 * the only IO here.
 */
import { query, type QboContext } from "./client";

/** Escape a value for a QBO query string literal. */
function escapeQuery(v: string): string {
  return v.replace(/'/g, "\\'");
}

export type RefundKind = "RefundReceipt" | "JournalEntry";

export interface UndepositedRefund {
  /** QBO transaction id. */
  txnId: string;
  kind: RefundKind;
  /** Line id to link against (journal entries need it; refund receipts don't). */
  lineId?: string;
  /** Positive magnitude of the refund. */
  amount: number;
  date: string;
  memo: string;
  customerName: string;
}

/**
 * Refunds sitting in Undeposited Funds in a date window.
 *
 * Deliberately broad on the JE side (any UF *debit*, which is the opposite
 * posting type from a fee) because a refund JE's memo wording isn't something we
 * can rely on — the caller only ever links one whose amount exactly equals the
 * gap it needs to close, and the deposit checksum still governs.
 */
export async function findUndepositedRefunds(
  ctx: QboContext,
  startDate: string,
  endDate: string
): Promise<UndepositedRefund[]> {
  const out: UndepositedRefund[] = [];
  const inRange =
    `where TxnDate >= '${escapeQuery(startDate)}' and TxnDate <= '${escapeQuery(endDate)}' MAXRESULTS 1000`;

  // 1) Refund receipts deposited into Undeposited Funds.
  try {
    const res = await query<{ QueryResponse?: { RefundReceipt?: any[] } }>(
      ctx,
      `select * from RefundReceipt ${inRange}`
    );
    for (const r of res.QueryResponse?.RefundReceipt ?? []) {
      const acct = String(r.DepositToAccountRef?.name ?? "");
      if (acct && !/undeposited funds/i.test(acct)) continue;
      const amount = Number(r.TotalAmt ?? 0);
      if (!(amount > 0)) continue;
      out.push({
        txnId: String(r.Id),
        kind: "RefundReceipt",
        amount,
        date: String(r.TxnDate ?? ""),
        memo: String(r.PrivateNote ?? r.CustomerMemo?.value ?? ""),
        customerName: String(r.CustomerRef?.name ?? ""),
      });
    }
  } catch {
    // Entity unavailable in this company — fall through to journal entries.
  }

  // 2) Journal entries that DEBIT Undeposited Funds (a fee JE credits it).
  try {
    const res = await query<{ QueryResponse?: { JournalEntry?: any[] } }>(
      ctx,
      `select * from JournalEntry ${inRange}`
    );
    for (const je of res.QueryResponse?.JournalEntry ?? []) {
      for (const line of je.Line ?? []) {
        const d = line.JournalEntryLineDetail;
        if (!d) continue;
        if (!/undeposited funds/i.test(String(d.AccountRef?.name ?? ""))) continue;
        if (String(d.PostingType ?? "") !== "Debit") continue;
        const amount = Number(line.Amount ?? 0);
        if (!(amount > 0)) continue;
        out.push({
          txnId: String(je.Id),
          kind: "JournalEntry",
          lineId: String(line.Id),
          amount,
          date: String(je.TxnDate ?? ""),
          memo: String(line.Description ?? je.PrivateNote ?? ""),
          customerName: String(d.Entity?.EntityRef?.name ?? ""),
        });
      }
    }
  } catch {
    /* ignore — no refunds found is a valid answer */
  }
  return out;
}

export interface RefundPick {
  /** The refunds that together close the gap exactly, or empty when none do. */
  refunds: UndepositedRefund[];
  /** True when the gap was closed to the cent. */
  exact: boolean;
}

/**
 * Choose the refund(s) that close a payout's gap EXACTLY.
 *
 * Strict on purpose, in the same spirit as the deposit checksum: a single
 * candidate of exactly the gap wins; otherwise, if every still-unused candidate
 * in the window together sums to exactly the gap, take them all. Anything else
 * returns nothing, so a deposit is never assembled out of a guess.
 *
 * `used` prevents one refund from being claimed by two payouts in a batch — the
 * same guard fee JEs get.
 */
export function pickRefundsForGap(
  candidates: UndepositedRefund[],
  gapCents: number,
  used: Set<string> = new Set()
): RefundPick {
  if (gapCents <= 0) return { refunds: [], exact: gapCents === 0 };
  const cents = (n: number) => Math.round(n * 100);
  const key = (r: UndepositedRefund) => `${r.kind}:${r.txnId}:${r.lineId ?? ""}`;
  const avail = candidates.filter((r) => !used.has(key(r)));

  const single = avail.find((r) => cents(r.amount) === gapCents);
  if (single) return { refunds: [single], exact: true };

  const total = avail.reduce((s, r) => s + cents(r.amount), 0);
  if (avail.length > 0 && total === gapCents) return { refunds: avail, exact: true };

  return { refunds: [], exact: false };
}

/** Stable key for the cross-payout no-reuse guard. */
export function refundKey(r: UndepositedRefund): string {
  return `${r.kind}:${r.txnId}:${r.lineId ?? ""}`;
}
