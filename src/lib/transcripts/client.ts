/**
 * Read-only client for the GCD webhook server's transcript service
 * (`/api/admin/transcripts/*`), Build Phase 4.
 *
 * The transcript data (calls, utterances, AI summaries/sentiment, keyword tags,
 * structured call insights) lives in the sibling gcd-webhook-server. The hub
 * reads AGGREGATED insights from it over a bearer secret (handoff §9), and only
 * ever issues GETs — it never triggers the service's sync/analyze mutations.
 *
 * Auth: the service guards every route with ADMIN_SECRET (query `?secret=` or
 * `x-admin-secret` header). We send the header so the secret never lands in a
 * URL/log. Config: TRANSCRIPTS_BASE_URL (the webhook server origin) and
 * TRANSCRIPTS_SECRET. Degrades to "not configured" when either is unset.
 */
import type { RawStats, RawKeywords, RawInsightsStatus, RawSearch } from "./aggregate";

const API_PREFIX = "/api/admin/transcripts";

export function isTranscriptsConfigured(): boolean {
  return Boolean(process.env.TRANSCRIPTS_BASE_URL && process.env.TRANSCRIPTS_SECRET);
}

export class TranscriptsNotConfiguredError extends Error {
  constructor() {
    super("Transcript service is not configured (TRANSCRIPTS_BASE_URL / TRANSCRIPTS_SECRET missing).");
    this.name = "TranscriptsNotConfiguredError";
  }
}

export class TranscriptsApiError extends Error {
  constructor(public status: number, public path: string) {
    super(`Transcript service ${status} on ${path}`);
    this.name = "TranscriptsApiError";
  }
}

function baseUrl(): string {
  return (process.env.TRANSCRIPTS_BASE_URL || "").replace(/\/+$/, "");
}

async function get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
  const secret = process.env.TRANSCRIPTS_SECRET;
  if (!baseUrl() || !secret) throw new TranscriptsNotConfiguredError();
  const url = new URL(`${baseUrl()}${API_PREFIX}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json", "x-admin-secret": secret },
  });
  if (!res.ok) throw new TranscriptsApiError(res.status, path);
  return (await res.json()) as T;
}

export interface TranscriptDateRange {
  from: string; // YYYY-MM-DD
  to: string;
}

export function fetchStats(): Promise<RawStats> {
  return get<RawStats>("/stats");
}
export function fetchKeywords(range: TranscriptDateRange, limit = 12): Promise<RawKeywords> {
  return get<RawKeywords>("/keywords", { from: range.from, to: range.to, limit });
}
export function fetchInsightsStatus(): Promise<RawInsightsStatus> {
  return get<RawInsightsStatus>("/insights-status");
}
/** A sample of negative-sentiment calls in the range (their AI summaries). */
export function fetchNegativeCalls(range: TranscriptDateRange, pageSize = 8): Promise<RawSearch> {
  return get<RawSearch>("/search", {
    from: range.from,
    to: range.to,
    sentiment: "NEGATIVE",
    pageSize,
    page: 1,
  });
}
