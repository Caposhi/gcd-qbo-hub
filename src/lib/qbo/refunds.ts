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
 * A refund can land in Undeposited Funds three ways, so we look for all of them
 * rather than assuming (Back Office uses the second):
 *   - a **Refund Receipt** deposited to Undeposited Funds,
 *   - a **journal entry** that CREDITS Undeposited Funds with a non-fee memo, or
 *   - a **negative customer payment**.
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
 * Refunds in a date window, across all three representations.
 *
 * The caller only ever links one whose amount exactly equals the gap it needs to
 * close, and the deposit checksum still governs, so breadth here is safe.
 *
 * A refund booked somewhere OTHER than Undeposited Funds is returned as a near
 * miss rather than dropped: "a refund of this amount exists but was deposited to
 * Chase Checking" is the single most useful thing we can tell an owner whose
 * deposit won't tie.
 */
/** QBO caps a query at 1000 rows; page until a short page comes back. */
const PAGE = 1000;

async function queryAllPages<T>(
  ctx: QboContext,
  entity: string,
  where: string,
  read: (res: any) => T[] | undefined
): Promise<T[]> {
  const out: T[] = [];
  for (let start = 1; ; start += PAGE) {
    const res = await query<any>(ctx, `select * from ${entity} ${where} STARTPOSITION ${start} MAXRESULTS ${PAGE}`);
    const rows = read(res) ?? [];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function findUndepositedRefunds(
  ctx: QboContext,
  startDate: string,
  endDate: string
): Promise<RefundSearch> {
  const refunds: UndepositedRefund[] = [];
  const nearMisses: RefundNearMiss[] = [];
  // Paginated, NOT a single capped page. The refund window is deliberately wide
  // (a refund can be dated well before the payout), and this company posts a fee
  // journal entry per card charge — roughly 8 a day — so a 90-day window holds
  // well over a thousand journal entries. A single MAXRESULTS 1000 page would
  // silently truncate and could drop the very refund we're looking for.
  const inRange =
    `where TxnDate >= '${escapeQuery(startDate)}' and TxnDate <= '${escapeQuery(endDate)}'`;

  // 1) Refund receipts. Sweepable only when deposited to Undeposited Funds.
  try {
    const rows = await queryAllPages<any>(ctx, "RefundReceipt", inRange, (r) => r.QueryResponse?.RefundReceipt);
    for (const r of rows) {
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
    const jes = await queryAllPages<any>(ctx, "JournalEntry", inRange, (r) => r.QueryResponse?.JournalEntry);
    for (const je of jes) {
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
    const pays = await queryAllPages<any>(
      ctx,
      "Payment",
      `${inRange} and TotalAmt < '0'`,
      (r) => r.QueryResponse?.Payment
    );
    for (const p of pays) {
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
  /**
   * How many candidates matched the gap exactly on their own. >1 means the amount
   * was ambiguous and we broke the tie by date — recorded so the choice is
   * auditable rather than invisible.
   */
  exactCandidates: number;
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
  used: Set<string> = new Set(),
  /** Settlement date, used to break a same-amount tie by date proximity. */
  settlementDate?: string
): RefundPick {
  if (gapCents <= 0) return { refunds: [], exact: gapCents === 0, exactCandidates: 0 };
  const cents = (n: number) => Math.round(n * 100);
  const avail = candidates.filter((r) => !used.has(refundKey(r)));

  // Amount alone is NOT unique: a wide window can hold another refund for the
  // same figure (live example — a second $1,728.05 existed in the window, already
  // deposited on a different day). Linking the first one found would tie the
  // deposit while sweeping the WRONG transaction, so prefer the candidate closest
  // to the settlement date: the refund that reduced THIS payout is the one that
  // happened next to it.
  const exactMatches = avail.filter((r) => cents(r.amount) === gapCents);
  if (exactMatches.length > 0) {
    const ranked = settlementDate
      ? [...exactMatches].sort((a, b) => dayGap(a.date, settlementDate) - dayGap(b.date, settlementDate))
      : exactMatches;
    return { refunds: [ranked[0]], exact: true, exactCandidates: exactMatches.length };
  }

  const total = avail.reduce((s, r) => s + cents(r.amount), 0);
  if (avail.length > 0 && total === gapCents) {
    return { refunds: avail, exact: true, exactCandidates: 0 };
  }

  return { refunds: [], exact: false, exactCandidates: 0 };
}

/** Whole days between two ISO dates (0 when either is unparseable). */
function dayGap(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.MAX_SAFE_INTEGER;
  return Math.abs(Math.round((ta - tb) / 86400000));
}

/** Stable key for the cross-payout no-reuse guard. */
export function refundKey(r: UndepositedRefund): string {
  return `${r.kind}:${r.txnId}:${r.lineId ?? ""}`;
}
