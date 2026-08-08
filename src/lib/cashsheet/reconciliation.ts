/**
 * Pure comparison logic for the account-register reconciliation assistant
 * (§Phase 5) — automates the exact cross-reference a human did by hand
 * during the July petty-cash reconciliation that prompted this redesign:
 * for a period, take everything QBO's register actually shows for an
 * account and everything the hub knows about, and surface
 *
 *   (a) transactions in the QBO register the hub didn't create ("foreign"
 *       — this is what would have caught the recurring "Jose" QBO template
 *       on day one instead of a month later), and
 *   (b) hub rows that should have posted for the period but haven't yet
 *       ("missing" — e.g. the two approved-but-unposted July rows).
 *
 * No DB/QBO dependency here — pure and unit-tested (§20). The QBO fetch and
 * DB lookups that feed this live in src/lib/qbo/reconciliation.ts and the
 * reconcile page's server action.
 */

export interface RegisterTxnLike {
  id: string;
  /** "in" increases the account balance (a Deposit); "out" decreases it
   *  (a Purchase, or a Transfer moving money OUT of this account). */
  direction: "in" | "out";
  /** Always a positive magnitude — direction carries the sign. */
  amount: number;
}

/** Partition a QBO register into what the hub can account for vs. not, by
 *  the one thing that's unambiguous: does this exact QBO transaction id
 *  appear on a hub-posted row? */
export function matchRegisterToHub<T extends RegisterTxnLike>(
  register: T[],
  knownTxnIds: ReadonlySet<string>
): { matched: T[]; foreign: T[] } {
  const matched: T[] = [];
  const foreign: T[] = [];
  for (const t of register) {
    (knownTxnIds.has(t.id) ? matched : foreign).push(t);
  }
  return { matched, foreign };
}

/** Signed net effect on the account: "in" adds, "out" subtracts. */
export function netAmount(txns: RegisterTxnLike[]): number {
  return txns.reduce((sum, t) => sum + (t.direction === "in" ? t.amount : -t.amount), 0);
}

export interface ReconciliationSummary {
  registerNet: number;
  hubMatchedNet: number;
  foreignNet: number;
  missingNet: number;
  /** ending − (beginning + registerNet). Null when either balance is unknown
   *  — the assistant can still list foreign/missing findings without them,
   *  it just can't say whether they fully explain a gap. */
  residual: number | null;
  /** missingNet − foreignNet: what the findings alone would explain of the
   *  residual (removing the foreign activity, adding the still-missing
   *  activity). Compare to `residual` via fullyExplained(). */
  explainedByFindings: number;
}

/**
 * Roll a matched QBO register + a list of not-yet-posted hub rows into one
 * summary. `beginningBalance`/`endingBalance` are the two numbers a human
 * would type into QBO's own Reconcile screen (there is no way to derive a
 * trustworthy "true" balance from inside the books — it has to come from a
 * physical count or a bank statement), so both are optional; the foreign/
 * missing findings are useful on their own even without them.
 */
export function summarizeReconciliation(
  register: RegisterTxnLike[],
  foreign: RegisterTxnLike[],
  missingRows: RegisterTxnLike[],
  beginningBalance: number | null,
  endingBalance: number | null
): ReconciliationSummary {
  const registerNet = netAmount(register);
  const foreignNet = netAmount(foreign);
  const missingNetVal = netAmount(missingRows);
  const residual =
    beginningBalance !== null && endingBalance !== null ? endingBalance - (beginningBalance + registerNet) : null;
  return {
    registerNet,
    hubMatchedNet: registerNet - foreignNet,
    foreignNet,
    missingNet: missingNetVal,
    residual,
    explainedByFindings: missingNetVal - foreignNet,
  };
}

/** Cent-level rounding tolerance for "close enough to call it explained". */
const CENTS_TOLERANCE = 0.005;

/**
 * Whether the foreign+missing findings, on their own, explain the residual
 * gap between the true (entered) ending balance and QBO's book. Null when
 * there's no residual to explain (no beginning/ending balance given).
 */
export function fullyExplained(summary: ReconciliationSummary): boolean | null {
  if (summary.residual === null) return null;
  return Math.abs(summary.residual - summary.explainedByFindings) < CENTS_TOLERANCE;
}
