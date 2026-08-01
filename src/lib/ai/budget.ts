/**
 * Token-budget accounting & circuit breaker (AI C-suite, Phase 3) — pure.
 *
 * The monthly council run has a HARD $15 cap (locked decision), enforced in
 * code: the orchestrator tracks spend across every turn, and when the debate
 * approaches the cap it stops adding rounds and forces the CEO synthesis. This
 * module is the pure math behind that — cost from token usage at Opus 4.8
 * pricing (with prompt-cache and Batch-API discounts), and the stop decision.
 *
 * IO-free and unit-tested (§20).
 */

/** Per-1M-token USD pricing for claude-opus-4-8 (see claude-api skill). */
export const PRICING = {
  inputPerM: 5.0,
  outputPerM: 25.0,
  /** Cache read ≈ 0.1× input. */
  cacheReadPerM: 0.5,
  /** Cache write (5-minute TTL) ≈ 1.25× input. */
  cacheWritePerM: 6.25,
} as const;

/** Hard cap for a full monthly council run. */
export const MONTHLY_CAP_USD = 15;

/** Token usage from one API turn (uncached input is `inputTokens`). */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

const n = (v: number | undefined): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** USD cost of a single turn. Batch API turns are billed at 50%. */
export function costOf(usage: Usage, opts: { batch?: boolean } = {}): number {
  const gross =
    (n(usage.inputTokens) * PRICING.inputPerM +
      n(usage.outputTokens) * PRICING.outputPerM +
      n(usage.cacheReadTokens) * PRICING.cacheReadPerM +
      n(usage.cacheWriteTokens) * PRICING.cacheWritePerM) /
    1_000_000;
  const cost = opts.batch ? gross * 0.5 : gross;
  return round4(cost);
}

/** A running budget accumulator for one council run. */
export class BudgetTracker {
  private turns: Array<{ label: string; usd: number; usage: Usage }> = [];

  constructor(public readonly capUsd: number = MONTHLY_CAP_USD) {}

  /** Record a turn's usage and return its cost. */
  record(label: string, usage: Usage, opts: { batch?: boolean } = {}): number {
    const usd = costOf(usage, opts);
    this.turns.push({ label, usd, usage });
    return usd;
  }

  spentUsd(): number {
    return round4(this.turns.reduce((s, t) => s + t.usd, 0));
  }
  remainingUsd(): number {
    return round4(Math.max(0, this.capUsd - this.spentUsd()));
  }
  turnCount(): number {
    return this.turns.length;
  }
  breakdown(): Array<{ label: string; usd: number }> {
    return this.turns.map((t) => ({ label: t.label, usd: t.usd }));
  }

  /**
   * Whether the debate should stop adding rounds and force CEO synthesis.
   * Stops if we've already exceeded the cap, or if the estimated cost of another
   * round plus the reserved CEO-synthesis cost wouldn't fit under the cap.
   */
  shouldStopRounds(estRoundUsd: number, reserveForSynthesisUsd: number): boolean {
    if (this.spentUsd() >= this.capUsd) return true;
    return this.spentUsd() + estRoundUsd + reserveForSynthesisUsd > this.capUsd;
  }

  /** Hard guard: true when even the reserved synthesis no longer fits. */
  exhausted(reserveUsd = 0): boolean {
    return this.remainingUsd() <= reserveUsd;
  }
}

function round4(v: number): number {
  const r = Math.round((v + Number.EPSILON) * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}
