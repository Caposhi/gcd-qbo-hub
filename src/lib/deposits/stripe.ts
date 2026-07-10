/**
 * Tekmetric Payments = Stripe. We reconcile from two Stripe CSV exports:
 *   - Payouts:  po_… rows → each bank deposit's NET amount + arrival date.
 *   - Payments: py_… rows → each charge's GROSS amount + fee.
 *
 * Neither file links a charge to its payout, but Stripe settles a day's charges
 * into the next payout (arrival = charge date + 1, verified against real data).
 * So we reconstruct membership by accumulating charges in created-date order
 * into each payout until they sum EXACTLY to the payout net — the same
 * exact-sum guarantee used everywhere in this module.
 */
import { parseCsv } from "./csv";
import { parseCurrency } from "@/lib/cashsheet/amount";
import { normalizeDate } from "./paymentech";
import type { ExpectedDeposit, PayoutLine } from "./types";
import { toCents } from "./types";

export interface StripePayout {
  id: string;
  /** Net amount deposited to the bank. */
  amount: number;
  /** Bank arrival date (YYYY-MM-DD) = the bank-feed deposit date. */
  arrivalDate: string;
  traceId?: string;
}

export interface StripeCharge {
  id: string;
  createdDate: string; // YYYY-MM-DD
  gross: number;
  fee: number;
  /** net = gross - fee; what this charge contributes to a payout. */
  net: number;
}

function pick(row: Record<string, string>, ...names: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const wanted = names.map(norm);
  for (const key of Object.keys(row)) if (wanted.includes(norm(key))) return row[key];
  return "";
}

/** Take the date part of a "2026-07-03 00:17" or ISO timestamp. */
function datePart(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (s === "") return null;
  return normalizeDate(s.split(/[ T]/)[0]);
}

export function parseStripePayouts(text: string): StripePayout[] {
  const out: StripePayout[] = [];
  for (const row of parseCsv(text)) {
    const amount = parseCurrency(pick(row, "Amount"));
    const arrival = datePart(pick(row, "Arrival Date (UTC)", "Arrival Date"));
    const status = pick(row, "Status").toLowerCase();
    if (amount === null || !arrival) continue;
    if (status && status !== "paid") continue; // ignore failed/pending payouts
    out.push({
      id: pick(row, "id"),
      amount,
      arrivalDate: arrival,
      traceId: pick(row, "Trace ID") || undefined,
    });
  }
  out.sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));
  return out;
}

export function parseStripeCharges(text: string): StripeCharge[] {
  const out: StripeCharge[] = [];
  for (const row of parseCsv(text)) {
    const gross = parseCurrency(pick(row, "Amount"));
    const fee = parseCurrency(pick(row, "Fee")) ?? 0;
    const created = datePart(pick(row, "Created date (UTC)", "Created (UTC)", "Created date"));
    const status = pick(row, "Status").toLowerCase();
    if (gross === null || !created) continue;
    if (status && !["paid", "succeeded", "captured"].includes(status)) continue;
    out.push({
      id: pick(row, "id"),
      createdDate: created,
      gross,
      fee,
      net: (toCents(gross) - toCents(fee)) / 100,
    });
  }
  out.sort((a, b) => a.createdDate.localeCompare(b.createdDate));
  return out;
}

export interface TekmetricReconstruction {
  deposits: ExpectedDeposit[];
  /** Payouts we could not reconstruct exactly (kept for review, never posted). */
  unresolved: Array<{ payout: StripePayout; deltaCents: number }>;
  /** Charges not assigned to any payout (e.g. today's, settling next payout). */
  leftoverCharges: StripeCharge[];
}

/**
 * Reconstruct each payout's expected deposit from charges. Charges are consumed
 * FIFO by created-date; a payout only resolves when its charges sum to the net
 * exactly. `lines` are the gross charges (what the QBO Undeposited-Funds
 * payments match); fee = gross - net (matched later to the fee JEs).
 */
export function reconstructTekmetricPayouts(
  payouts: StripePayout[],
  charges: StripeCharge[]
): TekmetricReconstruction {
  const sortedPayouts = [...payouts].sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));
  const queue = [...charges].sort((a, b) => a.createdDate.localeCompare(b.createdDate));
  let i = 0; // pointer into queue
  const deposits: ExpectedDeposit[] = [];
  const unresolved: TekmetricReconstruction["unresolved"] = [];

  for (const payout of sortedPayouts) {
    const targetCents = toCents(payout.amount);
    const bucket: StripeCharge[] = [];
    let sumCents = 0;
    // Only charges created strictly before arrival (D+1 settlement) are eligible.
    while (i < queue.length && queue[i].createdDate < payout.arrivalDate && sumCents < targetCents) {
      bucket.push(queue[i]);
      sumCents += toCents(queue[i].net);
      i++;
    }
    if (sumCents === targetCents && bucket.length > 0) {
      const grossCents = bucket.reduce((s, c) => s + toCents(c.gross), 0);
      const lines: PayoutLine[] = bucket.map((c) => ({ amount: c.gross, brand: "", ref: c.id }));
      deposits.push({
        processor: "tekmetric",
        settlementDate: payout.arrivalDate,
        gross: grossCents / 100,
        fee: (grossCents - targetCents) / 100,
        net: payout.amount,
        lines,
        sourceRef: payout.traceId ?? payout.id,
      });
    } else {
      // Couldn't reconstruct — put the bucket back and flag for review.
      i -= bucket.length;
      unresolved.push({ payout, deltaCents: targetCents - sumCents });
    }
  }

  return { deposits, unresolved, leftoverCharges: queue.slice(i) };
}
