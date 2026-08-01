/**
 * Transcript-insights fetch-through cache (`transcript_snapshot`), Build Phase 4.
 *
 * The AI context and any UI read AGGREGATED monthly call insights from this
 * cache (no network). A permission-gated refresh pulls the four read endpoints
 * from the webhook transcript service, aggregates them (pure), and upserts the
 * normalized `TranscriptInsights`. Everything read back is validated/coerced by
 * `parseTranscriptInsights` so a corrupt row degrades to safe empties.
 *
 * Performs IO (Prisma + the transcript client); must not be imported by the
 * pure aggregator.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import {
  fetchStats,
  fetchKeywords,
  fetchInsightsStatus,
  fetchNegativeCalls,
} from "./client";
import { buildTranscriptInsights, parseTranscriptInsights } from "./aggregate";
import type { TranscriptInsights } from "./types";

const ENTITY = "monthly_insights";

export interface TranscriptSnapshotResult {
  data: TranscriptInsights | null;
  fetchedAt: Date | null;
}

/** Read the cached monthly transcript insights for a period (no network). */
export async function readTranscriptSnapshot(period: {
  start: string;
  end: string;
}): Promise<TranscriptSnapshotResult> {
  const row = await prisma.transcriptSnapshot.findUnique({
    where: {
      entity_periodStart_periodEnd: {
        entity: ENTITY,
        periodStart: new Date(period.start),
        periodEnd: new Date(period.end),
      },
    },
  });
  if (!row) return { data: null, fetchedAt: null };
  return { data: parseTranscriptInsights(row.payloadJson, period), fetchedAt: row.fetchedAt };
}

/**
 * Pull the transcript service's read endpoints for the period, aggregate, and
 * upsert. Read-only over the service (GETs only); the caller MUST gate this with
 * `requirePermission`. Returns the freshly built insights.
 */
export async function refreshTranscriptInsights(period: {
  start: string;
  end: string;
}): Promise<TranscriptInsights> {
  const range = { from: period.start, to: period.end };
  const [stats, keywords, insightsStatus, negativeSearch] = await Promise.all([
    fetchStats(),
    fetchKeywords(range),
    fetchInsightsStatus(),
    fetchNegativeCalls(range),
  ]);

  const data = buildTranscriptInsights(period, { stats, keywords, insightsStatus, negativeSearch });

  await prisma.transcriptSnapshot.upsert({
    where: {
      entity_periodStart_periodEnd: {
        entity: ENTITY,
        periodStart: new Date(period.start),
        periodEnd: new Date(period.end),
      },
    },
    create: {
      entity: ENTITY,
      periodStart: new Date(period.start),
      periodEnd: new Date(period.end),
      payloadJson: data as unknown as Prisma.InputJsonValue,
    },
    update: { payloadJson: data as unknown as Prisma.InputJsonValue, fetchedAt: new Date() },
  });

  return data;
}
