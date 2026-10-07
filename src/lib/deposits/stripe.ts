/**
 * Tekmetric Payments = Stripe. We reconcile from two Stripe CSV exports:
 *   - Payouts:  po_… rows → each bank deposit's NET amount + arrival date.
 *   - Payments: py_… rows → each charge's GROSS amount + fee.
 *
 * Neither file links a charge to its payout, but Stripe settles each day's
 * charges (UTC) into a later payout — normally the next business day, with
 * weekends/holidays rolling several days into one payout (verified against
 * real data). So we reconstruct membership from whole days of charges whose
 * total ties EXACTLY to the payout net — the same exact-sum guarantee used
 * everywhere in this module. See reconstructTekmetricPayouts for refunds.
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
  /** net = gross - fee - refunded; what this charge contributes overall. */
  net: number;
  /**
   * Amount refunded (0 when none). Stripe deducts a refund from the payout
   * that settles on/after the day the refund is ISSUED — which may be a later
   * payout than the charge's own. The export doesn't carry the refund date.
   */
  refunded: number;
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
      refunded,
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

/** Longest run of consecutive charge days one payout may cover (long weekends). */
const MAX_DAYS_PER_PAYOUT = 7;
/** Most refunds considered at once when deciding which ones a payout deducted. */
const MAX_REFUND_POOL = 12;

interface PendingRefund {
  chargeId: string;
  cents: number;
}

/** Charges grouped by created date, oldest first. */
function groupByDay(charges: StripeCharge[]): StripeCharge[][] {
  const days: StripeCharge[][] = [];
  for (const c of charges) {
    const last = days[days.length - 1];
    if (last && last[0].createdDate === c.createdDate) last.push(c);
    else days.push([c]);
  }
  return days;
}

/**
 * Find which outstanding refunds (if any) a payout deducted. `baseCents` is the
 * payout's charges at gross − fee (refunds NOT subtracted). Tries "exactly the
 * window's own refunds" first (a same-day refund, the common case), then every
 * other combination from fewest refunds up. Returns the chosen refunds, or null.
 */
function pickRefunds(
  baseCents: number,
  targetCents: number,
  ownRefunds: PendingRefund[],
  pool: PendingRefund[]
): PendingRefund[] | null {
  const sum = (rs: PendingRefund[]) => rs.reduce((s, r) => s + r.cents, 0);
  if (baseCents - sum(ownRefunds) === targetCents) return ownRefunds;
  const capped = pool.slice(-MAX_REFUND_POOL);
  const gap = baseCents - targetCents;
  if (gap <= 0) return gap === 0 ? [] : null;
  const masks: number[] = [];
  for (let m = 0; m < 1 << capped.length; m++) masks.push(m);
  const bits = (m: number) => m.toString(2).replace(/0/g, "").length;
  masks.sort((a, b) => bits(a) - bits(b));
  for (const m of masks) {
    const picked = capped.filter((_, k) => m & (1 << k));
    if (sum(picked) === gap) return picked;
  }
  return null;
}

/**
 * Reconstruct each payout's expected deposit from charges. A payout resolves
 * only when a set of charges ties to its net to the cent:
 *
 *  1. Whole days first: a run of 1–7 consecutive unconsumed charge days, all
 *     created before the payout's arrival date (the earliest run that ties
 *     wins). Weekends and holidays roll into one payout this way.
 *  2. Refunds: each charge counts at gross − fee; a refund is deducted from
 *     the payout that actually took it — the same payout when refunded the
 *     same day, or a LATER one when refunded later (a 09-03 charge refunded on
 *     09-16 comes out of the 09-17 payout). Refunds from earlier payouts stay
 *     "outstanding" until a payout ties with them deducted.
 *  3. Fallback for a day split across payouts: the old charge-by-charge walk
 *     from the earliest eligible charge, refunds applied to their own charge.
 *
 * A payout that can't be tied is reported in `unresolved` and consumes
 * nothing, so it never drags later payouts down with it (the old FIFO walk
 * cascaded one miss through the rest of the month).
 *
 * `lines` are the gross charges (what the QBO Undeposited-Funds payments
 * match); fee = gross − net, so any refund deducted shows up downstream as a
 * gross-to-net gap beyond the per-charge fees, which the deposit step closes
 * by sweeping in the matching QBO refund.
 */
export function reconstructTekmetricPayouts(
  payouts: StripePayout[],
  charges: StripeCharge[]
): TekmetricReconstruction {
  const sortedPayouts = [...payouts].sort((a, b) => a.arrivalDate.localeCompare(b.arrivalDate));
  let remaining = [...charges].sort((a, b) => a.createdDate.localeCompare(b.createdDate));
  let outstanding: PendingRefund[] = [];
  const deposits: ExpectedDeposit[] = [];
  const unresolved: TekmetricReconstruction["unresolved"] = [];
  const baseOf = (c: StripeCharge) => toCents(c.gross) - toCents(c.fee);
  const refundOf = (c: StripeCharge): PendingRefund | null =>
    toCents(c.refunded ?? 0) > 0 ? { chargeId: c.id, cents: toCents(c.refunded) } : null;

  for (const payout of sortedPayouts) {
    const targetCents = toCents(payout.amount);
    const days = groupByDay(remaining.filter((c) => c.createdDate < payout.arrivalDate));
    let match: { bucket: StripeCharge[]; applied: PendingRefund[] } | null = null;
    let closestDelta: number | null = null;

    for (let start = 0; start < days.length && !match; start++) {
      for (let len = 1; len <= MAX_DAYS_PER_PAYOUT && start + len <= days.length; len++) {
        const bucket = days.slice(start, start + len).flat();
        const baseCents = bucket.reduce((s, c) => s + baseOf(c), 0);
        const own = bucket.map(refundOf).filter((r): r is PendingRefund => r !== null);
        const applied = pickRefunds(baseCents, targetCents, own, [...outstanding, ...own]);
        if (applied) {
          match = { bucket, applied };
          break;
        }
        const delta = targetCents - (baseCents - own.reduce((s, r) => s + r.cents, 0));
        if (closestDelta === null || Math.abs(delta) < Math.abs(closestDelta)) closestDelta = delta;
      }
    }

    if (!match) {
      // Fallback: charge-by-charge from the earliest eligible charge.
      const eligible = days.flat();
      const bucket: StripeCharge[] = [];
      let sumCents = 0;
      for (const c of eligible) {
        if (sumCents >= targetCents) break;
        bucket.push(c);
        sumCents += toCents(c.net);
      }
      if (sumCents === targetCents && bucket.length > 0) {
        match = { bucket, applied: bucket.map(refundOf).filter((r): r is PendingRefund => r !== null) };
      }
    }

    if (!match) {
      unresolved.push({ payout, deltaCents: closestDelta ?? targetCents });
      continue;
    }

    const used = new Set(match.bucket.map((c) => c.id));
    remaining = remaining.filter((c) => !used.has(c.id));
    const appliedIds = new Set(match.applied.map((r) => r.chargeId));
    const newlyOwed = match.bucket
      .map(refundOf)
      .filter((r): r is PendingRefund => r !== null && !appliedIds.has(r.chargeId));
    outstanding = [...outstanding.filter((r) => !appliedIds.has(r.chargeId)), ...newlyOwed];

    const grossCents = match.bucket.reduce((s, c) => s + toCents(c.gross), 0);
    const lines: PayoutLine[] = match.bucket.map((c) => ({ amount: c.gross, fee: c.fee, brand: "", ref: c.id }));
    deposits.push({
      processor: "tekmetric",
      settlementDate: payout.arrivalDate,
      gross: grossCents / 100,
      fee: (grossCents - targetCents) / 100,
      net: payout.amount,
      lines,
      sourceRef: payout.traceId ?? payout.id,
    });
  }

  return { deposits, unresolved, leftoverCharges: remaining };
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
