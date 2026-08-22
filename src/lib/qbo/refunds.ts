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

/**
 * How a refund can be represented in Undeposited Funds.
 *
 * `JournalEntry` is what Tekmetric's Back Office actually produces, confirmed
 * against the live 2026-08-06 payout: Back Office DISPLAYS the refund as a
 * negative "Customer Payment", but because QBO payments can't be negative it
 * EXPORTS a journal entry — debit A/R, credit Undeposited Funds, memo
 * "Applied to: 73962 | OSORIO, STEVEN on 08/05/26 for $-1728.05".
 *
 * `RefundReceipt` and `Payment` are kept because other configurations record
 * refunds those ways (a refund receipt deposited to UF, or a negative payment),
 * and detecting them costs one query each.
 */
export type RefundKind = "RefundReceipt" | "JournalEntry" | "Payment";

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
 * A refund we found but CAN'T sweep into a deposit, kept so the diagnostic can
 * say "it exists but…" instead of the far less useful "not found".
 */
export interface RefundNearMiss {
  txnId: string;
  kind: RefundKind;
  amount: number;
  date: string;
  /** Why it isn't sweepable, e.g. the account it was deposited to instead. */
  reason: string;
}

export interface RefundSearch {
  /** Sweepable: sitting in Undeposited Funds. */
  refunds: UndepositedRefund[];
  /** Found, but not in Undeposited Funds — actionable information, not noise. */
  nearMisses: RefundNearMiss[];
}

/**
 * Refunds in a date window.
 *
 * Deliberately broad on the JE side (any UF *debit*, the opposite posting type
 * from a fee) because a refund JE's memo wording isn't something we can rely on
 * — the caller only ever links one whose amount exactly equals the gap it needs
 * to close, and the deposit checksum still governs.
 *
 * A refund receipt booked somewhere OTHER than Undeposited Funds is returned as a
 * near miss rather than dropped: "a refund of this amount exists but was
 * deposited to Chase Checking" is the single most useful thing we can tell an
 * owner whose deposit won't tie.
 */
export async function findUndepositedRefunds(
  ctx: QboContext,
  startDate: string,
  endDate: string
): Promise<RefundSearch> {
  const refunds: UndepositedRefund[] = [];
  const nearMisses: RefundNearMiss[] = [];
  const inRange =
    `where TxnDate >= '${escapeQuery(startDate)}' and TxnDate <= '${escapeQuery(endDate)}' MAXRESULTS 1000`;

  // 1) Refund receipts. Sweepable only when deposited to Undeposited Funds.
  try {
    const res = await query<{ QueryResponse?: { RefundReceipt?: any[] } }>(
      ctx,
      `select * from RefundReceipt ${inRange}`
    );
    for (const r of res.QueryResponse?.RefundReceipt ?? []) {
      const amount = Number(r.TotalAmt ?? 0);
      if (!(amount > 0)) continue;
      const acct = String(r.DepositToAccountRef?.name ?? "");
      const base = { txnId: String(r.Id), kind: "RefundReceipt" as const, amount, date: String(r.TxnDate ?? "") };
      if (acct && !/undeposited funds/i.test(acct)) {
        nearMisses.push({ ...base, reason: `deposited to “${acct}” instead of Undeposited Funds` });
        continue;
      }
      refunds.push({
        ...base,
        memo: String(r.PrivateNote ?? r.CustomerMemo?.value ?? ""),
        customerName: String(r.CustomerRef?.name ?? ""),
      });
    }
  } catch {
    // Entity unavailable in this company — fall through to the other shapes.
  }

  // 2) Journal entries that CREDIT Undeposited Funds and are NOT card fees.
  //
  //    This is the shape Back Office actually produces. A refund reduces an
  //    asset, so it CREDITS Undeposited Funds — the same direction as a fee JE,
  //    which is why direction alone can't separate them. The memo does:
  //      fee    → "FEE | Credit Card: Visa | NAME | date"
  //      refund → "Applied to: 73962 | OSORIO, STEVEN on 08/05/26 for $-1728.05"
  //    findFeeJournalEntries claims only the /credit card/ ones, so taking the
  //    complement here means a refund JE is never double-counted as a fee.
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
        if (String(d.PostingType ?? "") !== "Credit") continue;
        const memo = String(line.Description ?? je.PrivateNote ?? "");
        if (/credit card/i.test(memo)) continue; // that's a processor fee, not a refund
        const amount = Number(line.Amount ?? 0);
        if (!(amount > 0)) continue;
        refunds.push({
          txnId: String(je.Id),
          kind: "JournalEntry",
          lineId: String(line.Id),
          amount,
          date: String(je.TxnDate ?? ""),
          memo,
          customerName: String(d.Entity?.EntityRef?.name ?? ""),
        });
      }
    }
  } catch {
    /* ignore — no refunds found is a valid answer */
  }

  // 3) NEGATIVE customer payments — how Back Office actually exports a refund.
  //    A payment with no DepositToAccountRef defaults to Undeposited Funds in
  //    QBO, so treat "absent" as UF; anything explicitly elsewhere is a near
  //    miss (it can't be swept into this deposit).
  try {
    const res = await query<{ QueryResponse?: { Payment?: any[] } }>(
      ctx,
      `select Id, TotalAmt, TxnDate, CustomerRef, DepositToAccountRef, PrivateNote from Payment ` +
        `where TotalAmt < '0' and TxnDate >= '${escapeQuery(startDate)}' ` +
        `and TxnDate <= '${escapeQuery(endDate)}' MAXRESULTS 1000`
    );
    for (const p of res.QueryResponse?.Payment ?? []) {
      const total = Number(p.TotalAmt ?? 0);
      if (!(total < 0)) continue;
      const amount = Math.abs(total);
      const acct = String(p.DepositToAccountRef?.name ?? "");
      const base = { txnId: String(p.Id), kind: "Payment" as const, amount, date: String(p.TxnDate ?? "") };
      if (acct && !/undeposited funds/i.test(acct)) {
        nearMisses.push({ ...base, reason: `deposited to “${acct}” instead of Undeposited Funds` });
        continue;
      }
      refunds.push({
        ...base,
        memo: String(p.PrivateNote ?? ""),
        customerName: String(p.CustomerRef?.name ?? ""),
      });
    }
  } catch {
    /* ignore — the other shapes may still have found it */
  }

  return { refunds, nearMisses };
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
