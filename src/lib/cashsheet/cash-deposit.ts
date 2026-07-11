/**
 * Cash-sheet → QBO Bank Deposit matching (pilot).
 *
 * A handful of cash-sheet rows are customer cash collections (they carry an
 * INV#/RO number) that were physically deposited at the bank. Back Office has
 * already posted the Customer Payment to Undeposited Funds; what stays manual is
 * creating the QBO Bank Deposit that clears Undeposited Funds so the bank-feed
 * line matches. This module holds the pure logic for that step:
 *
 *   - find the Undeposited-Funds Payment that belongs to a row (by RO# carried
 *     in the payment's memo, e.g. "73534 | GCD | Cash | 06/10/2026"), and
 *   - compute the deposit: the linked payment plus a small Cash over/short plug
 *     when the amount actually deposited differs from the payment by rounding.
 *
 * Everything here is cents-safe and pure so it is unit-tested (§20). No QBO I/O.
 */

/** Difference beyond which we refuse to auto-plug (guards a wrong match). */
export const MAX_OVER_SHORT_CENTS = 1000; // $10.00

export interface PaymentLike {
  id: string;
  /** Payment total in dollars (QBO TotalAmt). */
  amount: number;
  /** QBO PrivateNote / memo, e.g. "73534 | GCD | Cash | 06/10/2026". */
  privateNote: string;
  date: string;
  /** Customer display name, when available (for the preview only). */
  customerName?: string;
}

/** Convert a dollar amount to integer cents (round-safe). */
export function cents(n: number): number {
  return Math.round(n * 100);
}

/**
 * The leading RO/invoice token of a Back Office payment memo. The memo format is
 * "<RO#> | GCD | <brand> | MM/DD/YYYY", so the token is everything before the
 * first "|" (trimmed). Returns "" if the memo is empty/oddly shaped.
 */
export function memoRoToken(privateNote: string | null | undefined): string {
  const s = (privateNote ?? "").trim();
  if (!s) return "";
  const first = s.split("|")[0] ?? "";
  return first.trim();
}

/**
 * Normalize an RO/INV value to its comparison key: the leading whitespace-
 * delimited token, upper-cased. The sheet sometimes appends a name to the RO
 * ("73663 GILLIS") while the Back Office memo carries the bare number
 * ("73663 | ..."), so both sides reduce to the first token.
 */
function normRo(v: string): string {
  return (v.trim().split(/\s+/)[0] ?? "").toUpperCase();
}

/**
 * Pick the Undeposited-Funds payment for a row by exact RO# match on the memo's
 * leading token. Among ties (same RO#), prefer the one whose amount is closest
 * to the deposited amount, so an over/short plug stays minimal.
 */
export function matchPaymentByRo(
  candidates: PaymentLike[],
  ro: string,
  depositedAmount: number
): PaymentLike | null {
  const target = normRo(ro);
  if (!target) return null;
  const matches = candidates.filter((c) => normRo(memoRoToken(c.privateNote)) === target);
  if (matches.length === 0) return null;
  const depCents = cents(depositedAmount);
  return matches
    .slice()
    .sort((a, b) => Math.abs(cents(a.amount) - depCents) - Math.abs(cents(b.amount) - depCents))[0];
}

export interface CashDepositPlan {
  /** The customer payment being pulled out of Undeposited Funds. */
  paymentId: string;
  paymentCents: number;
  /** The amount actually deposited at the bank (from the sheet's Bank Deposit). */
  depositedCents: number;
  /** depositedCents − paymentCents; positive = cash over, negative = short. */
  overShortCents: number;
  /** True when |over/short| is within the sanity cap (safe to auto-plug). */
  withinThreshold: boolean;
}

/**
 * Build the deposit plan from a located payment and the deposited amount. The
 * plan always ties by construction (payment + over/short = deposited); the
 * meaningful gate is `withinThreshold` — a large gap means the match is probably
 * wrong and must be reviewed, never plugged.
 */
export function planCashDeposit(paymentAmount: number, depositedAmount: number): CashDepositPlan {
  const paymentCents = cents(paymentAmount);
  const depositedCents = cents(depositedAmount);
  const overShortCents = depositedCents - paymentCents;
  return {
    paymentId: "",
    paymentCents,
    depositedCents,
    overShortCents,
    withinThreshold: Math.abs(overShortCents) <= MAX_OVER_SHORT_CENTS,
  };
}
