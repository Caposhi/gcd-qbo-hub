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
 * primary sourceRef-based key map, and a settlement-date + net-amount
 * fallback map. Both cover EVERY existing row, posted or not.
 *
 * Posted rows deliberately ARE valid fallback targets — this is what closes
 * the duplicate-row bug for good. A payout that was posted under an earlier
 * export's sourceRef format (e.g. a bank trace id) still needs to be
 * recognized when a later export of the SAME real payout arrives under a
 * different sourceRef (e.g. the raw processor id, because that export has no
 * Trace ID column). Without posted rows in the fallback pool, that lookup
 * misses, the caller treats it as a brand-new payout, and creates a
 * duplicate "needs review" row sitting right next to the real posted one —
 * exactly the bug this fallback was built to prevent, just for posted
 * payouts instead of pending ones. Matching to a posted row here is safe:
 * the caller (reconcileParsedPayouts) never overwrites a posted row's
 * amounts/status once matched — it only skips it (optionally self-healing
 * the sourceRef) — so a false-positive fallback match here can't corrupt
 * posted history, only (rarely, on a genuine date+amount coincidence) miss
 * creating a distinct new payout, the same accepted tradeoff the fallback
 * already makes for not-yet-posted rows.
 */
export function buildPayoutIndexes<T extends MatchCandidate>(existing: T[]): PayoutIndexes<T> {
  const byKey = new Map<string, T>();
  for (const p of existing) byKey.set(payoutKey(p.processor, p.sourceRef, p.settlementDate, p.netAmount), p);

  const fallbackCounts = new Map<string, number>();
  const byFallback = new Map<string, T>();
  for (const p of existing) {
    const fk = fallbackKey(p.processor, p.settlementDate, p.netAmount);
    fallbackCounts.set(fk, (fallbackCounts.get(fk) ?? 0) + 1);
    byFallback.set(fk, p);
  }
  return { byKey, byFallback, fallbackCounts };
}

/**
 * Resolve which existing payout (if any) a freshly-parsed payout should
 * upsert against. Tries the sourceRef-based key first; if that misses, falls
 * back to settlement date + net amount — but only when exactly one existing
 * row (posted or not) shares that fallback key (a collision between two
 * different real payouts on the same date+amount is left unmatched rather
 * than guessed at, same as if there were no fallback), and only once per
 * fallback key per run (`claimedFallbacks`) so two freshly-parsed payouts
 * can't both claim the same existing row.
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

export interface DedupeRow extends MatchCandidate {
  id: string;
}

/**
 * Which rows, among a full set ordered oldest-first, are duplicates of an
 * earlier row and should be removed. Same identity rules as resolveMatch
 * (sourceRef key, then date+amount fallback), applied incrementally: a row
 * already "seen" under either its exact key or its fallback key is a
 * duplicate of whichever row claimed that key first. A posted row is never
 * itself removed (it always wins the keys it touches, first-come or not),
 * but IS eligible to be what a later, not-yet-posted duplicate collides
 * with — this is what actually cleans up a duplicate already sitting in the
 * DB from before the sourceRef-format bug was fixed at ingest time.
 */
export function findDuplicateIds<T extends DedupeRow>(rowsOldestFirst: T[]): string[] {
  const seen = new Set<string>();
  const seenByFallback = new Map<string, string>();
  const dupeIds: string[] = [];
  for (const p of rowsOldestFirst) {
    const key = payoutKey(p.processor, p.sourceRef, p.settlementDate, p.netAmount);
    const fk = fallbackKey(p.processor, p.settlementDate, p.netAmount);
    if (p.qboDepositId) {
      seen.add(key);
      seenByFallback.set(fk, p.id);
      continue; // posted — always kept, never counted as a duplicate
    }
    if (seen.has(key) || seenByFallback.has(fk)) {
      dupeIds.push(p.id);
      continue;
    }
    seen.add(key);
    seenByFallback.set(fk, p.id);
  }
  return dupeIds;
}
