/**
 * Pure aggregation for the call-transcript integration (Build Phase 4).
 *
 * Turns the webhook transcript service's raw endpoint payloads (/stats,
 * /keywords, /insights-status, /search) into the aggregated `TranscriptInsights`
 * the hub consumes. IO-free and unit-tested — the fetch lives in client.ts.
 * Also validates/coerces a stored snapshot on read (mirrors `parseAssumptions`)
 * so a corrupt row degrades to safe empties.
 */
import type { TranscriptInsights, TranscriptKeyword, TranscriptCallSample } from "./types";

// Raw shapes returned by the transcript service (see gcd-webhook-server).
export interface RawStats {
  total_calls?: number; // inbound
  calls_with_transcript?: number;
  sync_state?: { last_synced_at?: string | null } | null;
}
export interface RawKeywords {
  keywords?: Array<{ keyword?: string; total_mentions?: number; call_count?: number }>;
}
export interface RawInsightsStatus {
  total_transcripts?: number;
  analyzed?: number;
  last_analyzed_at?: string | null;
  pct?: number;
}
export interface RawSearchResult {
  ai_summary?: string | null;
  ai_sentiment?: string | null;
  start_time?: string | null;
}
export interface RawSearch {
  results?: RawSearchResult[];
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const optStr = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Build the aggregated monthly insights from the raw endpoint payloads. */
export function buildTranscriptInsights(
  period: { start: string; end: string },
  raw: {
    stats: RawStats;
    keywords: RawKeywords;
    insightsStatus: RawInsightsStatus;
    negativeSearch: RawSearch;
  },
  opts: { topKeywords?: number; maxSamples?: number } = {}
): TranscriptInsights {
  const topN = opts.topKeywords ?? 12;
  const maxSamples = opts.maxSamples ?? 8;

  const topKeywords: TranscriptKeyword[] = (raw.keywords.keywords ?? [])
    .map((k) => ({ keyword: str(k.keyword), mentions: num(k.total_mentions), calls: num(k.call_count) }))
    .filter((k) => k.keyword !== "")
    .slice(0, topN);

  const negativeSamples: TranscriptCallSample[] = (raw.negativeSearch.results ?? [])
    .map((r) => ({ summary: str(r.ai_summary), sentiment: str(r.ai_sentiment) || "NEGATIVE", at: str(r.start_time) }))
    .filter((s) => s.summary !== "")
    .slice(0, maxSamples);

  return {
    period,
    totalInbound: num(raw.stats.total_calls),
    transcripts: num(raw.stats.calls_with_transcript),
    analyzedPct: num(raw.insightsStatus.pct),
    lastSyncedAt: optStr(raw.stats.sync_state?.last_synced_at),
    lastAnalyzedAt: optStr(raw.insightsStatus.last_analyzed_at),
    topKeywords,
    negativeSamples,
  };
}

/** Validate/coerce a stored snapshot payload on read. Never throws. */
export function parseTranscriptInsights(
  json: unknown,
  period: { start: string; end: string }
): TranscriptInsights {
  const o = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const kw = Array.isArray(o.topKeywords) ? o.topKeywords : [];
  const neg = Array.isArray(o.negativeSamples) ? o.negativeSamples : [];
  return {
    period,
    totalInbound: num(o.totalInbound),
    transcripts: num(o.transcripts),
    analyzedPct: num(o.analyzedPct),
    lastSyncedAt: optStr(o.lastSyncedAt),
    lastAnalyzedAt: optStr(o.lastAnalyzedAt),
    topKeywords: kw
      .map((k) => {
        const ko = k && typeof k === "object" ? (k as Record<string, unknown>) : {};
        return { keyword: str(ko.keyword), mentions: num(ko.mentions), calls: num(ko.calls) };
      })
      .filter((k) => k.keyword !== ""),
    negativeSamples: neg
      .map((s) => {
        const so = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
        return { summary: str(so.summary), sentiment: str(so.sentiment), at: str(so.at) };
      })
      .filter((s) => s.summary !== ""),
  };
}
