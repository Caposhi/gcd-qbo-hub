/**
 * Read Back Office "Payment Fee" journal entries from QBO for Tekmetric deposit
 * reconciliation.
 *
 * Each card charge's processing fee is posted by Accounting Link as a
 * JournalEntry: DR Bank Charges & Fees:Credit Card Processing Fees / CR
 * Undeposited Funds, with a line description like
 *   "FEE | Credit Card: Visa | PAKNIS, ASHLEY | 07/10/26".
 * To include a fee in a Bank Deposit we link that JournalEntry by the specific
 * Undeposited-Funds line (its Id is the TxnLineId), as a negative deposit line —
 * it reduces the deposit so the net ties to the payout. This finds those fee JEs
 * (their UF credit line) in a date window so the reconstructor can match each
 * charge's fee by amount.
 */
import { query, type QboContext } from "./client";

export interface FeeJournalEntry {
  jeId: string;
  /** Id of the Undeposited-Funds line within the JE — the LinkedTxn TxnLineId. */
  ufLineId: string;
  /** Positive fee amount on the UF line. */
  amount: number;
  /** Customer name on the line (disambiguates same-amount fees). */
  customerName: string;
  /** Line description / memo, e.g. "FEE | Credit Card: Visa | NAME | date". */
  memo: string;
  date: string;
}

function escapeQuery(v: string): string {
  return v.replace(/'/g, "\\'");
}

/** Customer segment of a Back Office fee memo: "FEE | Credit Card: <brand> | <NAME> | <date>". */
export function customerFromFeeMemo(memo: string): string {
  const parts = (memo ?? "").split("|").map((s) => s.trim());
  return parts[2] ?? "";
}

/** Normalize a customer name for matching (upper, alphanumerics only). */
export function normCustomer(s: string): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Order-insensitive customer key: the name's word tokens, uppercased and sorted,
 * so "Castillo, Junior" and "Junior Castillo" collapse to the same key. Tekmetric
 * stores the customer as "Last, First" on the payment but sometimes "First Last"
 * in the fee-JE description; matching the sorted token set pairs them without
 * loosening into different people (same tokens = same customer). Still guarded by
 * date proximity, de-dup, and the deposit's exact-sum checksum.
 */
export function customerMatchKey(s: string): string {
  return (s ?? "")
    .toUpperCase()
    .replace(/'/g, "") // O'BRIEN -> OBRIEN (apostrophes are within-word, not separators)
    .split(/[\s,]+/) // split on the real separators between name parts (space, comma)
    .map((t) => t.replace(/[^A-Z0-9]/g, "")) // strip any remaining punctuation within a token
    .filter(Boolean)
    .sort()
    .join("|");
}

export interface FeeMatch {
  linked: FeeJournalEntry[];
  /** Charges (by customer label) for which no fee JE was found. */
  missing: string[];
  /** How many were matched by fee amount because the name didn't line up. */
  amountMatched: number;
}

/** One Tekmetric charge to find a fee JE for: the payment's customer + its known fee. */
export interface FeeCharge {
  customer: string;
  /** Per-charge processor fee from the export, if captured (immune to name drift). */
  feeAmount?: number | null;
}

/**
 * Match one fee journal entry per charge, de-duped via `used`, nearest date.
 * Primary key is the customer name (order-insensitive); when that misses AND the
 * charge's exact fee amount is known (from the Tekmetric export), fall back to
 * matching an unused fee JE of that amount — so a customer-name discrepancy in
 * QBO (e.g. "Castillo, Junior" booked as "Junior Castillo Jr") can't strand a
 * deposit. The deposit's exact-sum checksum still governs, so a fallback match
 * can never make the total wrong.
 */
export function matchFees(
  feeJEs: FeeJournalEntry[],
  charges: FeeCharge[],
  settlementDate: string,
  used: Set<string>,
  daysApart: (a: string, b: string) => number,
  maxDays = 12
): FeeMatch {
  const linked: FeeJournalEntry[] = [];
  const missing: string[] = [];
  let amountMatched = 0;
  const inWindow = (j: FeeJournalEntry) => !used.has(j.jeId) && daysApart(j.date, settlementDate) <= maxDays;
  const nearest = (a: FeeJournalEntry, b: FeeJournalEntry) =>
    daysApart(a.date, settlementDate) - daysApart(b.date, settlementDate);

  for (const ch of charges) {
    const key = customerMatchKey(ch.customer);
    // 1) by customer name (order-insensitive)
    let je = key ? feeJEs.filter((j) => inWindow(j) && customerMatchKey(j.customerName) === key).sort(nearest)[0] : undefined;
    // 2) fall back to the exact known fee amount
    if (!je && ch.feeAmount != null) {
      const cents = Math.round(ch.feeAmount * 100);
      const byAmt = feeJEs.filter((j) => inWindow(j) && Math.round(j.amount * 100) === cents).sort(nearest)[0];
      if (byAmt) {
        je = byAmt;
        amountMatched++;
      }
    }
    if (je) {
      used.add(je.jeId);
      linked.push(je);
    } else {
      missing.push(ch.customer || (ch.feeAmount != null ? `$${ch.feeAmount.toFixed(2)} fee` : "unknown"));
    }
  }
  return { linked, missing, amountMatched };
}

/**
 * Back-compat wrapper: match by customer name only (no per-charge fee amounts).
 * Prefer `matchFees` with charges so the amount fallback is available.
 */
export function matchFeesByCustomer(
  feeJEs: FeeJournalEntry[],
  customers: string[],
  settlementDate: string,
  used: Set<string>,
  daysApart: (a: string, b: string) => number,
  maxDays = 12
): FeeMatch {
  return matchFees(feeJEs, customers.map((customer) => ({ customer })), settlementDate, used, daysApart, maxDays);
}

/**
 * Fee journal entries (their Undeposited-Funds credit line) with TxnDate in
 * [startDate, endDate]. Only entries whose UF line looks like a Back Office card
 * fee ("Credit Card" in the description) are returned.
 */
export async function findFeeJournalEntries(
  ctx: QboContext,
  startDate: string,
  endDate: string
): Promise<FeeJournalEntry[]> {
  const res = await query<{ QueryResponse?: { JournalEntry?: any[] } }>(
    ctx,
    `select * from JournalEntry where TxnDate >= '${escapeQuery(startDate)}' ` +
      `and TxnDate <= '${escapeQuery(endDate)}' MAXRESULTS 1000`
  );
  const out: FeeJournalEntry[] = [];
  for (const je of res.QueryResponse?.JournalEntry ?? []) {
    for (const line of je.Line ?? []) {
      const d = line.JournalEntryLineDetail;
      if (!d) continue;
      const acctName = String(d.AccountRef?.name ?? "");
      const isUf = /undeposited funds/i.test(acctName);
      const isCredit = String(d.PostingType ?? "") === "Credit";
      const memo = String(line.Description ?? je.PrivateNote ?? "");
      if (!isUf || !isCredit) continue;
      // Restrict to Back Office card-fee entries (skip unrelated UF-credit JEs
      // like fee-correction adjustments).
      if (!/credit card/i.test(memo)) continue;
      out.push({
        jeId: String(je.Id),
        ufLineId: String(line.Id),
        amount: Number(line.Amount ?? 0),
        // Prefer the line's Entity; fall back to the customer segment of the
        // memo "FEE | Credit Card: <brand> | <NAME> | <date>".
        customerName: String(d.Entity?.EntityRef?.name ?? "") || customerFromFeeMemo(memo),
        memo,
        date: String(je.TxnDate ?? ""),
      });
    }
  }
  return out;
}
