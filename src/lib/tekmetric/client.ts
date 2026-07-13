/**
 * Read-only Tekmetric API client (Build Phase 4 groundwork).
 *
 * Tekmetric's public API is READ-ONLY for our purposes: this client only ever
 * issues GET requests. It never calls a Tekmetric write endpoint.
 *
 * Auth: we reuse the same env vars a sibling GCD project already runs with — a
 * pre-provisioned, long-lived bearer token (`TEKMETRIC_TOKEN`) sent directly as
 * `Authorization: Bearer …` (per the Tekmetric docs, the access token "will
 * continue to be valid until it is revoked"). No client-credentials exchange is
 * performed here; the token is read from env and never persisted or logged
 * (mirroring the QBO client's secret discipline, §16).
 *
 * Config:
 *   - TEKMETRIC_BASE_URL  e.g. https://shop.tekmetric.com (prod) or
 *                         https://sandbox.tekmetric.com (test)
 *   - TEKMETRIC_TOKEN     bearer access token
 *   - TEKMETRIC_SHOP_ID   the shop to pull
 *
 * Rate limits (per docs): 600 req/min production, 300 sandbox. On a 429 (empty
 * body) or 5xx we retry with exponential backoff + jitter, capped at 60s.
 * Pagination is Spring-style (`page` 0-based, `size` ≤ 100) with a `content[]`
 * envelope; `fetchAll` walks every page.
 *
 * This module performs network IO and must NOT be imported by the pure
 * normalizer. Money in Tekmetric responses is in integer cents — conversion to
 * dollars happens in normalize.ts, not here.
 */
import type {
  TekRawAppointment,
  TekRawEmployee,
  TekRawPage,
  TekRawRepairOrder,
  TekRawShop,
  TekRawVehicle,
} from "./raw";

const API_PREFIX = "/api/v1";
const DEFAULT_BASE_URL = "https://shop.tekmetric.com";
const MAX_PAGE_SIZE = 100;

// Rate-limit backoff (docs recommend exponential backoff with jitter, max 60s).
const MAX_RETRIES = 6;
const MAX_BACKOFF_MS = 60_000;

/** Base URL without a trailing slash (defaults to production). */
function baseUrl(): string {
  return (process.env.TEKMETRIC_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/** True only when the token + shop id are present; the page degrades to a
 * "not configured" notice otherwise (mirrors the AI assistant's env gate). */
export function isTekmetricConfigured(): boolean {
  return Boolean(process.env.TEKMETRIC_TOKEN && process.env.TEKMETRIC_SHOP_ID);
}

export class TekmetricNotConfiguredError extends Error {
  constructor() {
    super("Tekmetric is not configured (TEKMETRIC_TOKEN / TEKMETRIC_SHOP_ID missing).");
    this.name = "TekmetricNotConfiguredError";
  }
}

export class TekmetricApiError extends Error {
  constructor(
    public status: number,
    public path: string,
    public detail: unknown
  ) {
    super(`Tekmetric API ${status} on ${path}`);
    this.name = "TekmetricApiError";
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new TekmetricNotConfiguredError();
  return v;
}

function safeJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff for retry n (1-based): min(2^n * 1000 + jitter<=1s, 60s). */
function backoffMs(n: number): number {
  const jitter = Math.floor(Math.random() * 1000);
  return Math.min(Math.pow(2, n) * 1000 + jitter, MAX_BACKOFF_MS);
}

// ---- Core GET with 429 / 5xx backoff --------------------------------------

async function tekGet<T>(path: string, query: Record<string, string | number | undefined>): Promise<T> {
  const token = requireEnv("TEKMETRIC_TOKEN");
  const url = new URL(`${baseUrl()}${API_PREFIX}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  let attempt = 0;
  // Retry only on 429 / 5xx; other statuses throw immediately.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    if (res.ok) {
      return safeJson(await res.text()) as T;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      attempt += 1;
      await sleep(backoffMs(attempt));
      continue;
    }

    throw new TekmetricApiError(res.status, path, safeJson(await res.text()));
  }
}

/** Walk every page of a Spring-paginated endpoint, returning all `content`. */
async function fetchAll<T>(
  path: string,
  query: Record<string, string | number | undefined>
): Promise<T[]> {
  const out: T[] = [];
  let page = 0;
  // Hard stop well beyond any realistic shop/period to avoid an infinite loop
  // if the API ever misreports `last`.
  const MAX_PAGES = 100_000;
  while (page < MAX_PAGES) {
    const res = await tekGet<TekRawPage<T>>(path, { ...query, page, size: MAX_PAGE_SIZE });
    out.push(...(res.content ?? []));
    if (res.last || (res.content?.length ?? 0) < MAX_PAGE_SIZE) break;
    page += 1;
  }
  return out;
}

// ---- Shop resolution -------------------------------------------------------

/** List the shops the token is scoped to. */
export async function listShops(): Promise<TekRawShop[]> {
  return tekGet<TekRawShop[]>("/shops", {});
}

/**
 * The shop IDs to pull. We run against a single configured shop
 * (`TEKMETRIC_SHOP_ID`), but the return type stays an array so the snapshot
 * layer can iterate uniformly if this ever grows to multiple shops.
 */
export async function resolveShopIds(): Promise<string[]> {
  return [requireEnv("TEKMETRIC_SHOP_ID")];
}

// ---- Entity fetchers (read-only) ------------------------------------------
//
// `start`/`end` are ISO dates the Tekmetric endpoints accept as filters. Jobs
// arrive embedded in each repair order, so no separate /jobs sweep is needed.

export interface TekDateRange {
  /** ISO-8601 start (inclusive). */
  start: string;
  /** ISO-8601 end (inclusive). */
  end: string;
}

/** Repair orders POSTED within the range (revenue-recognition window). */
export async function fetchRepairOrders(shopId: string, range: TekDateRange): Promise<TekRawRepairOrder[]> {
  return fetchAll<TekRawRepairOrder>("/repair-orders", {
    shop: shopId,
    postedDateStart: range.start,
    postedDateEnd: range.end,
  });
}

export async function fetchVehicles(shopId: string): Promise<TekRawVehicle[]> {
  return fetchAll<TekRawVehicle>("/vehicles", { shop: shopId });
}

export async function fetchAppointments(shopId: string, range: TekDateRange): Promise<TekRawAppointment[]> {
  return fetchAll<TekRawAppointment>("/appointments", {
    shop: shopId,
    start: range.start,
    end: range.end,
  });
}

export async function fetchEmployees(shopId: string): Promise<TekRawEmployee[]> {
  return fetchAll<TekRawEmployee>("/employees", { shop: shopId });
}
