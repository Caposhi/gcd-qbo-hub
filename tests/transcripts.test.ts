import { describe, it, expect } from "vitest";
import { buildTranscriptInsights, parseTranscriptInsights } from "@/lib/transcripts/aggregate";
import { can } from "@/lib/auth/roles";

const PERIOD = { start: "2026-06-01", end: "2026-06-30" };

describe("buildTranscriptInsights", () => {
  const insights = buildTranscriptInsights(PERIOD, {
    stats: {
      total_calls: 4960,
      calls_with_transcript: 4009,
      sync_state: { last_synced_at: "2026-07-13T03:00:00Z" },
    },
    keywords: {
      keywords: [
        { keyword: "warranty", total_mentions: 120, call_count: 88 },
        { keyword: "cancel", total_mentions: 40, call_count: 35 },
        { keyword: "", total_mentions: 9, call_count: 9 }, // dropped
      ],
    },
    insightsStatus: { total_transcripts: 4009, analyzed: 3794, last_analyzed_at: "2026-07-07T00:00:00Z", pct: 95 },
    negativeSearch: {
      results: [
        { ai_summary: "Oil leak recurred after service; wants a callback.", ai_sentiment: "NEGATIVE", start_time: "2026-06-11T14:27:00Z" },
        { ai_summary: "", ai_sentiment: "NEGATIVE", start_time: "2026-06-10T00:00:00Z" }, // dropped (empty)
      ],
    },
  });

  it("aggregates totals, coverage, keywords and negative samples", () => {
    expect(insights.totalInbound).toBe(4960);
    expect(insights.transcripts).toBe(4009);
    expect(insights.analyzedPct).toBe(95);
    expect(insights.lastSyncedAt).toBe("2026-07-13T03:00:00Z");
    expect(insights.lastAnalyzedAt).toBe("2026-07-07T00:00:00Z");
    expect(insights.topKeywords.map((k) => k.keyword)).toEqual(["warranty", "cancel"]);
    expect(insights.negativeSamples).toHaveLength(1);
    expect(insights.negativeSamples[0].summary).toContain("Oil leak");
  });

  it("round-trips through parseTranscriptInsights and coerces garbage safely", () => {
    const round = parseTranscriptInsights(JSON.parse(JSON.stringify(insights)), PERIOD);
    expect(round.totalInbound).toBe(4960);
    expect(round.topKeywords[0].keyword).toBe("warranty");

    const empty = parseTranscriptInsights("nonsense", PERIOD);
    expect(empty.totalInbound).toBe(0);
    expect(empty.topKeywords).toEqual([]);
    expect(empty.negativeSamples).toEqual([]);
  });
});

describe("transcript permissions", () => {
  it("owner can view + refresh; reviewer can only view; coworker neither", () => {
    expect(can("owner_admin", "refresh_transcripts")).toBe(true);
    expect(can("owner_admin", "view_transcripts")).toBe(true);
    expect(can("reviewer", "view_transcripts")).toBe(true);
    expect(can("reviewer", "refresh_transcripts")).toBe(false);
    expect(can("coworker", "view_transcripts")).toBe(false);
  });
});
