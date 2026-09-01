/**
 * Pure payout-identity matching for Deposit Reconciliation's reconcile-on-
 * ingest upsert (see src/app/deposit-reconciliation/actions.ts →
 * reconcileParsedPayouts). Split out from that IO-heavy action so the
 * matching decision itself — which existing DB row a freshly-parsed payout
 * should update, if any — is verifiable without a live database (§20).
 */

/** A payout's identity: the processor's own reference when we have one
 *  (Stripe trace-id/payout-id, Paymentech batch #), else a fingerprint of
 *  date + net amount. Stable across re-ingests so re-dropping the same
 *  files — even after a parsing bug fix changes the numbers — updates the
 *  same row instead of creating a duplicate. */
export function payoutKey(processor: string, sourceRef: string | null, settlementDate: string, netAmount: number): string {
  return sourceRef
    ? `${processor}|${sourceRef}`
    : `${processor}|${settlementDate}|${Math.round(netAmount * 100)}`;
}

/** Identity that doesn't depend on sourceRef at all — used as a fallback when
 *  the same real-world payout's sourceRef format changes between exports
 *  (e.g. Stripe's payouts.csv sometimes includes a "Trace ID" column and
 *  sometimes doesn't, so parseStripePayouts() falls back from the trace id to
 *  the raw `po_…` id, a different string than what was stored last time). */
export function fallbackKey(processor: string, settlementDate: string, netAmount: number): string {
  return `${processor}|${settlementDate}|${Math.round(netAmount * 100)}`;
}

export interface MatchCandidate {
  processor: string;
  sourceRef: string | null;
  settlementDate: string;
  netAmount: number;
  qboDepositId: string | null;
}

export interface ParsedPayoutIdentity {
  processor: string;
  sourceRef: string | null;
  settlementDate: string;
  net: number;
}

export interface PayoutIndexes<T> {
  byKey: Map<string, T>;
  byFallback: Map<string, T>;
  fallbackCounts: Map<string, number>;
}

/**
 * Build the lookup indexes reconcileParsedPayouts needs once per run: a
 * primary sourceRef-based key map (covers every existing row, posted or
 * not — a posted row must still be found by its exact key so it's correctly
 * skipped rather than treated as new), and a settlement-date + net-amount
 * fallback map restricted to NOT-YET-POSTED rows (posted history never needs
 * the fallback — it's found by other means, and mustn't be a fallback target
 * since it's immutable).
 */
export function buildPayoutIndexes<T extends MatchCandidate>(existing: T[]): PayoutIndexes<T> {
  const byKey = new Map<string, T>();
  for (const p of existing) byKey.set(payoutKey(p.processor, p.sourceRef, p.settlementDate, p.netAmount), p);

  const fallbackCounts = new Map<string, number>();
  const byFallback = new Map<string, T>();
  for (const p of existing) {
    if (p.qboDepositId) continue;
    const fk = fallbackKey(p.processor, p.settlementDate, p.netAmount);
    fallbackCounts.set(fk, (fallbackCounts.get(fk) ?? 0) + 1);
    byFallback.set(fk, p);
  }
  return { byKey, byFallback, fallbackCounts };
}

/**
 * Resolve which existing payout (if any) a freshly-parsed payout should
 * upsert against. Tries the sourceRef-based key first; if that misses, falls
 * back to settlement date + net amount — but only when exactly one
 * not-yet-posted existing row shares that fallback key (a collision between
 * two different real payouts on the same date+amount is left unmatched
 * rather than guessed at, same as if there were no fallback), and only once
 * per fallback key per run (`claimedFallbacks`) so two freshly-parsed
 * payouts can't both claim the same existing row.
 */
export function resolveMatch<T extends MatchCandidate>(
  d: ParsedPayoutIdentity,
  indexes: PayoutIndexes<T>,
  claimedFallbacks: Set<string>
): T | undefined {
  const key = payoutKey(d.processor, d.sourceRef, d.settlementDate, d.net);
  const direct = indexes.byKey.get(key);
  if (direct) return direct;

  const fk = fallbackKey(d.processor, d.settlementDate, d.net);
  if (indexes.fallbackCounts.get(fk) === 1 && !claimedFallbacks.has(fk)) {
    claimedFallbacks.add(fk);
    return indexes.byFallback.get(fk);
  }
  return undefined;
}
