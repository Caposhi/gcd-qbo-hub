/**
 * Consolidated-charge matching for Chase Paymentech deposit reconciliation
 * (pure, unit-tested — no I/O).
 *
 * Paymentech can bundle several card charges into ONE settlement line when they
 * are on the SAME CARD within a short window (e.g. a customer who pays two repair
 * orders on the same card minutes apart shows up in QBO as two Undeposited-Funds
 * payments, but as a single settlement charge). The 1:1 amount matcher then can't
 * find a single payment for that charge.
 *
 * This finds the group of payments that make up such a charge, with strict
 * guards so it never guesses wrong:
 *   - same card ⇒ same customer, so every payment in a group must share the
 *     customer (the strongest real-world constraint);
 *   - the group must sum to the charge to the exact cent;
 *   - the group must be UNIQUE — if two different groupings both sum to the
 *     charge, it's ambiguous and we decline (surface for manual review), never
 *     auto-pick.
 * It is a FALLBACK: callers only invoke it after a single-payment match fails,
 * over the pool of still-available (unclaimed, not-yet-deposited) payments.
 */

export interface PaymentCandidate {
  id: string;
  amount: number;
  customer: string;
}

export interface SubsetMatch {
  ids: string[];
  amounts: number[];
  customer: string;
}

export interface ConsolidationResult {
  /** The unique same-customer group that sums to the charge, or null. */
  match: SubsetMatch | null;
  /** When >1 distinct grouping sums to the charge — ambiguous, not auto-matched. */
  ambiguous: SubsetMatch[];
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function cents(n: number): number {
  return Math.round(n * 100);
}

/** A group is identified by its sorted set of payment ids (dedupe key). */
function idKey(ids: string[]): string {
  return [...ids].sort().join("|");
}

/**
 * Find the unique same-customer group of ≥2 available payments that sums to
 * `targetAmount`. Returns `{match}` when exactly one such group exists across all
 * customers; `{match: null, ambiguous}` when none or more than one.
 *
 * `maxGroupEnumerate` caps how many of a single customer's payments we enumerate
 * subsets over (2^n), so a customer with a huge number of same-window payments
 * can't blow up the search; such a group is skipped rather than mis-matched.
 */
export function findConsolidatedMatch(
  targetAmount: number,
  candidates: PaymentCandidate[],
  opts: { maxGroupEnumerate?: number } = {}
): ConsolidationResult {
  const target = cents(targetAmount);
  if (target <= 0) return { match: null, ambiguous: [] };
  const cap = opts.maxGroupEnumerate ?? 12;

  // Group available payments by customer — a consolidation is always one card,
  // hence one customer.
  const byCustomer = new Map<string, PaymentCandidate[]>();
  for (const c of candidates) {
    const k = norm(c.customer);
    if (!k) continue; // a payment with no customer can't be safely grouped
    const g = byCustomer.get(k);
    if (g) g.push(c);
    else byCustomer.set(k, [c]);
  }

  const groups: SubsetMatch[] = [];
  for (const group of byCustomer.values()) {
    if (group.length < 2 || group.length > cap) continue; // need a real group; skip un-enumerable ones
    const n = group.length;
    for (let mask = 1; mask < 1 << n; mask++) {
      // Count set bits; need at least 2 (a single payment would have matched 1:1).
      let bits = 0;
      for (let m = mask; m; m &= m - 1) bits++;
      if (bits < 2) continue;
      let sum = 0;
      const ids: string[] = [];
      const amounts: number[] = [];
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) {
          sum += cents(group[i].amount);
          ids.push(group[i].id);
          amounts.push(group[i].amount);
        }
      }
      if (sum === target) groups.push({ ids, amounts, customer: group[0].customer });
    }
  }

  // Distinct groupings (by id-set). Exactly one → confident match.
  const distinct = new Map<string, SubsetMatch>();
  for (const g of groups) distinct.set(idKey(g.ids), g);
  const list = [...distinct.values()];
  if (list.length === 1) return { match: list[0], ambiguous: [] };
  return { match: null, ambiguous: list };
}
