/**
 * Deposit Reconciliation — shared domain types.
 *
 * See docs/DEPOSIT_RECONCILIATION.md. The module's job is to build the correct
 * QBO Bank Deposit for each processor payout; QBO then auto-matches the
 * downloaded bank-feed line. Everything here is pure data — no QBO/DB access.
 */

export type Processor = "paymentech" | "tekmetric";

/** One card transaction that belongs to a payout (from a processor file). */
export interface PayoutLine {
  /** Positive gross charge amount. */
  amount: number;
  /** Card brand as the processor reports it (Visa/Mastercard/Other/…). */
  brand: string;
  /** Processor reference (batch sequence, charge id) — audit aid, not a key. */
  ref?: string;
}

/**
 * An expected bank deposit derived from a processor settlement file: the net
 * amount that hit (or will hit) the bank, plus the gross lines and any fee that
 * was netted out. For Chase this is one batch-date's card sales (fee = 0, billed
 * monthly). For Tekmetric it's one payout (fee > 0, netted).
 */
export interface ExpectedDeposit {
  processor: Processor;
  /** Settlement/batch date (YYYY-MM-DD) the lines belong to. */
  settlementDate: string;
  /** Gross total of the lines. */
  gross: number;
  /** Fee netted out of this payout (0 for Chase daily). */
  fee: number;
  /** Net amount that hits the bank = gross - fee. This is the deposit total. */
  net: number;
  lines: PayoutLine[];
  /** Free-form source id (batch #s, payout trace) for audit. */
  sourceRef?: string;
}

/** A record sitting in QBO Undeposited Funds that a deposit can pull in. */
export interface QboUndepositedRecord {
  /** QBO transaction id. */
  id: string;
  /** Payment (customer payment, positive) or JournalEntry (fee, negative). */
  type: "Payment" | "JournalEntry";
  /** Signed amount: payments positive, fee JEs negative. */
  amount: number;
  brand: string;
  /** Transaction date (YYYY-MM-DD). */
  date: string;
  /** For a JournalEntry, the specific line id to link into the deposit. */
  lineId?: string;
}

export const CENTS = 100;
/** Round to cents to avoid float drift when summing money. */
export function toCents(n: number): number {
  return Math.round(n * CENTS);
}
export function centsEqual(a: number, b: number): boolean {
  return toCents(a) === toCents(b);
}
