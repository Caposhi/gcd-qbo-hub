/**
 * Tekmetric Payments payout → expected bank deposit.
 *
 * Tekmetric NETS its fee out of the payout, so the deposit = gross card payments
 * + the (negative) per-transaction fee journal entries, which nets to the
 * payout. We book the fee ONCE by including the existing Back Office fee JEs —
 * never a second fee line (that was the double-count we found).
 *
 * NOTE: the concrete CSV/API column layout is finalized once we have a real
 * Tekmetric payout export (see docs open questions). `buildTekmetricDeposit`
 * below is the stable, tested core; `parseTekmetricCsv` maps a real export onto
 * it and will be completed against the sample.
 */
import type { ExpectedDeposit, PayoutLine } from "./types";
import { toCents } from "./types";

export interface TekmetricPayout {
  /** Payout/settlement date (YYYY-MM-DD). */
  settlementDate: string;
  /** Gross charges in the payout. */
  grossLines: PayoutLine[];
  /** Total fee netted from the payout (positive number). */
  fee: number;
  /** Net deposited to the bank, per the payout summary. */
  net: number;
  /** Payout trace id / statement descriptor for audit. */
  sourceRef?: string;
}

export function buildTekmetricDeposit(p: TekmetricPayout): ExpectedDeposit {
  const grossCents = p.grossLines.reduce((s, l) => s + toCents(l.amount), 0);
  return {
    processor: "tekmetric",
    settlementDate: p.settlementDate,
    gross: grossCents / 100,
    fee: p.fee,
    net: p.net,
    lines: p.grossLines,
    sourceRef: p.sourceRef,
  };
}

/**
 * Sanity check a payout ties out before we trust it: gross - fee == net.
 * Returns null if consistent, or the discrepancy in cents.
 */
export function payoutTiesOut(p: TekmetricPayout): number | null {
  const grossCents = p.grossLines.reduce((s, l) => s + toCents(l.amount), 0);
  const delta = grossCents - toCents(p.fee) - toCents(p.net);
  return delta === 0 ? null : delta;
}

/* TODO(sample): implement parseTekmetricCsv(text) once a real payout export is
 * provided, mapping its columns to TekmetricPayout[] and reusing normalizeDate
 * from ./paymentech and parseCurrency from cash-sheet amount parsing. */
