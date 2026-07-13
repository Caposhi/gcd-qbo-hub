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

export interface FeeMatch {
  linked: FeeJournalEntry[];
  /** Customers for which no fee JE was found. */
  missing: string[];
}

/**
 * Match one fee journal entry per payment by customer name (the JE description
 * carries the customer), nearest date, de-duped via `used`. This is how a
 * Tekmetric payout's fees are located — independent of any stored per-charge
 * fee, so it works on data ingested before fees were captured.
 */
export function matchFeesByCustomer(
  feeJEs: FeeJournalEntry[],
  customers: string[],
  settlementDate: string,
  used: Set<string>,
  daysApart: (a: string, b: string) => number,
  maxDays = 12
): FeeMatch {
  const linked: FeeJournalEntry[] = [];
  const missing: string[] = [];
  for (const cust of customers) {
    const key = normCustomer(cust);
    if (!key) { missing.push(cust); continue; }
    const je = feeJEs
      .filter((j) => !used.has(j.jeId) && normCustomer(j.customerName) === key && daysApart(j.date, settlementDate) <= maxDays)
      .sort((a, b) => daysApart(a.date, settlementDate) - daysApart(b.date, settlementDate))[0];
    if (je) {
      used.add(je.jeId);
      linked.push(je);
    } else {
      missing.push(cust);
    }
  }
  return { linked, missing };
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
