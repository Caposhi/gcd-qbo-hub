/**
 * Reconciliation engine (pure).
 *
 * Given an ExpectedDeposit (from a processor file) and the pool of QBO
 * Undeposited-Funds records for that settlement window, select the records that
 * make up the deposit and verify they sum EXACTLY to the payout net. Nothing is
 * ever posted on an inexact sum — that is the core safety rail (see the spec).
 *
 * Matching is by amount (to the cent), with brand and date used only as
 * tiebreakers — the processor's brand labels don't always equal QBO's payment
 * method (e.g. a CSV "Other" can be a QBO "Debit Card"), so amount is the key
 * and the exact-sum checksum is the real guarantee.
 */
import type { ExpectedDeposit, QboUndepositedRecord } from "./types";
import { toCents, centsEqual } from "./types";

export type ReconcileStatus = "matched" | "needs_review";

export interface ReconcileResult {
  status: ReconcileStatus;
  /** Records to link into the QBO deposit (payments + fee JEs). */
  selected: QboUndepositedRecord[];
  /** Payment records matched to each gross line. */
  matchedPayments: QboUndepositedRecord[];
  /** Fee journal entries included (negative amounts), Tekmetric only. */
  feeRecords: QboUndepositedRecord[];
  /** Gross lines that found no matching Undeposited-Funds payment. */
  unmatchedLineAmounts: number[];
  expectedNet: number;
  selectedTotal: number;
  /** expectedNet - selectedTotal, in cents (0 when it ties out). */
  deltaCents: number;
}

export function sumCents(records: QboUndepositedRecord[]): number {
  return records.reduce((s, r) => s + toCents(r.amount), 0);
}

export function reconcileDeposit(
  expected: ExpectedDeposit,
  candidates: QboUndepositedRecord[]
): ReconcileResult {
  const payments = candidates.filter((c) => c.type === "Payment");
  const feeRecords = candidates.filter((c) => c.type === "JournalEntry");

  const used = new Set<string>();
  const matchedPayments: QboUndepositedRecord[] = [];
  const unmatchedLineAmounts: number[] = [];

  for (const line of expected.lines) {
    const wantCents = toCents(line.amount);
    // Candidates with the exact amount, not yet used.
    const sameAmount = payments.filter(
      (p) => !used.has(p.id) && toCents(p.amount) === wantCents
    );
    if (sameAmount.length === 0) {
      unmatchedLineAmounts.push(line.amount);
      continue;
    }
    // Tiebreak: prefer same brand, then closest date, else first.
    const brand = line.brand.toUpperCase();
    const chosen =
      sameAmount.find((p) => p.brand.toUpperCase() === brand) ??
      [...sameAmount].sort((a, b) => a.date.localeCompare(b.date))[0];
    used.add(chosen.id);
    matchedPayments.push(chosen);
  }

  const selected = [...matchedPayments, ...feeRecords];
  const selectedCents = sumCents(selected);
  const netCents = toCents(expected.net);
  const deltaCents = netCents - selectedCents;

  const ok = unmatchedLineAmounts.length === 0 && centsEqual(selectedCents / 100, expected.net);

  return {
    status: ok ? "matched" : "needs_review",
    selected,
    matchedPayments,
    feeRecords,
    unmatchedLineAmounts,
    expectedNet: expected.net,
    selectedTotal: selectedCents / 100,
    deltaCents,
  };
}
