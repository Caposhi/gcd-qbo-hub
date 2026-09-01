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
    // Tekmetric's per-payout "transfers" export is a balance-transaction listing:
    // it carries a `Type` column and may include Payout/Transfer/Refund rows
    // alongside the charges. Only charges fund a payout's gross, so skip the
    // rest. (A refund row here would make the set not tie to the payout net,
    // which is the honest outcome rather than something to paper over.)
    const type = pick(row, "Type").toLowerCase().trim();
    if (type && type !== "charge") continue;

    const gross = parseCurrency(pick(row, "Amount"));
    // "Fee" in the Payments export; "Fees" in the per-payout transfers export.
    const fee = parseCurrency(pick(row, "Fee", "Fees")) ?? 0;
    // A (partially) refunded charge settles into the bank for less than its
    // gross amount — the export still shows the original gross, but only
    // gross - fee - refund actually lands in a payout. Missing this doesn't
    // just mis-total one payout: because reconstruction below is a strict
    // FIFO exact-sum walk with no error recovery, one overstated charge
    // breaks that payout AND cascades to break every payout after it for
    // the rest of the file (see stripe.test.ts's "August cascade" case).
    const refunded = parseCurrency(pick(row, "Amount Refunded")) ?? 0;
    const created = datePart(
      pick(row, "Created date (UTC)", "Created (UTC)", "Created date", "Created")
    );
    const status = pick(row, "Status").toLowerCase();
    if (gross === null || !created) continue;
    // "refunded" (full refund) and "partially_refunded" still represent a real
    // charge that landed in a payout net — the refund is already subtracted
    // above via `refunded`. Excluding them here doesn't zero them out, it
    // drops the row entirely, which understates every payout that included
    // the charge and — same cascade as the missing-refund bug above — breaks
    // every payout after it too (see stripe.test.ts's "refunded charge" case).
    if (status && !["paid", "succeeded", "captured", "refunded", "partially_refunded"].includes(status)) continue;
    out.push({
      id: pick(row, "id", "ID"),
      createdDate: created,
      gross,
      fee,
      net: (toCents(gross) - toCents(fee) - toCents(refunded)) / 100,
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
      const lines: PayoutLine[] = bucket.map((c) => ({ amount: c.gross, fee: c.fee, brand: "", ref: c.id }));
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

// ---------------------------------------------------------------------------
// Charges-only back-fill: attach a per-payout export to a payout we already have
// ---------------------------------------------------------------------------

export interface ChargeSetTotals {
  count: number;
  gross: number;
  /** Processor fees on the set. */
  fee: number;
  /** What actually lands in the bank: Σ(gross − fee − refunded). */
  net: number;
}

/** Totals for a charge set, using the same net definition as reconstruction. */
export function chargeSetTotals(charges: StripeCharge[]): ChargeSetTotals {
  let grossCents = 0;
  let feeCents = 0;
  let netCents = 0;
  for (const c of charges) {
    grossCents += toCents(c.gross);
    feeCents += toCents(c.fee);
    netCents += toCents(c.net);
  }
  return { count: charges.length, gross: grossCents / 100, fee: feeCents / 100, net: netCents / 100 };
}

/** A payout already on file that has no charges attached yet. */
export interface BackfillCandidate {
  id: string;
  sourceRef: string | null;
  settlementDate: string;
  netAmount: number;
}

export interface ChargeSetBackfill {
  /** Ready to feed through the normal reconcile path, or null when no unique match. */
  deposit: ExpectedDeposit | null;
  totals: ChargeSetTotals;
  /** How many candidates the set ties to — >1 is ambiguous, so we decline. */
  matchCount: number;
  /** The matched candidate's id, for messaging. */
  payoutId: string | null;
}

/**
 * Reconstruct ONE already-known payout from a charges-only export.
 *
 * The workflow this serves: a payout couldn't be reconstructed because its
 * charges fell outside the exported window — e.g. a Monday payout funded by the
 * previous Thursday's charges — so the owner opens that payout in Tekmetric,
 * exports just its transactions, and drops that single file. If those charges net
 * to a known payout's net to the cent, they ARE that payout's charges.
 *
 * Deliberately strict, and for the same reason the deposit itself is
 * checksum-gated: the WHOLE set must tie exactly, and exactly one candidate may
 * match. Two payouts with an identical net is ambiguous, so we decline and report
 * instead of guessing. The returned deposit carries the candidate's own
 * settlementDate/sourceRef so it reconciles onto the existing row (an update)
 * rather than creating a duplicate.
 */
export function backfillPayoutFromCharges(
  charges: StripeCharge[],
  candidates: BackfillCandidate[]
): ChargeSetBackfill {
  const totals = chargeSetTotals(charges);
  if (charges.length === 0) return { deposit: null, totals, matchCount: 0, payoutId: null };

  const netCents = toCents(totals.net);
  const hits = candidates.filter((c) => toCents(c.netAmount) === netCents);
  if (hits.length !== 1) {
    return { deposit: null, totals, matchCount: hits.length, payoutId: null };
  }

  const target = hits[0];
  const grossCents = charges.reduce((s, c) => s + toCents(c.gross), 0);
  const lines: PayoutLine[] = charges.map((c) => ({
    amount: c.gross,
    fee: c.fee,
    brand: "",
    ref: c.id,
  }));
  return {
    deposit: {
      processor: "tekmetric",
      settlementDate: target.settlementDate,
      gross: grossCents / 100,
      // Same convention as reconstruction: fee is the gross-to-net difference,
      // so gross − fee always equals the payout that actually hit the bank.
      fee: (grossCents - netCents) / 100,
      net: target.netAmount,
      lines,
      sourceRef: target.sourceRef ?? undefined,
    },
    totals,
    matchCount: 1,
    payoutId: target.id,
  };
}
