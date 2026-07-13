/**
 * Call-transcript integration — normalized contract (Build Phase 4).
 *
 * The hub reads AGGREGATED insights only (never raw transcript utterances) from
 * the GCD webhook server's transcript service (`/api/admin/transcripts/*`), per
 * the handoff §9 connection pattern. These are the shapes the rest of the hub —
 * the CRO agent especially — consumes. Money/counts are plain numbers.
 */

export interface TranscriptKeyword {
  keyword: string;
  mentions: number;
  calls: number;
}

/** A one-line AI call summary sample (already-aggregated; not raw utterances). */
export interface TranscriptCallSample {
  summary: string;
  sentiment: string; // POSITIVE | NEGATIVE | NEUTRAL
  at: string; // ISO
}

/** Aggregated monthly call intelligence for a period. */
export interface TranscriptInsights {
  period: { start: string; end: string };
  /** Inbound calls in the period. */
  totalInbound: number;
  /** Calls with a transcript. */
  transcripts: number;
  /** Share of the analysis corpus that has been AI-analyzed (0–100). */
  analyzedPct: number;
  /** Freshness of the transcript sync (ISO) and of the AI analysis (ISO). */
  lastSyncedAt: string | null;
  lastAnalyzedAt: string | null;
  /** Top keyword tags for the period (warranty / cancel / complaint / …). */
  topKeywords: TranscriptKeyword[];
  /** A sample of negative-sentiment calls (their AI summaries) — a SAMPLE, not a full count. */
  negativeSamples: TranscriptCallSample[];
}

/** Entities persisted as `transcript_snapshot` rows. */
export type TranscriptSnapshotEntity = "monthly_insights";
