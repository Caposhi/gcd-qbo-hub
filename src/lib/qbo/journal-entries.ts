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
        customerName: String(d.Entity?.EntityRef?.name ?? ""),
        memo,
        date: String(je.TxnDate ?? ""),
      });
    }
  }
  return out;
}
