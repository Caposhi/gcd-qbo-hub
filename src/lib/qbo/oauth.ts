/**
 * QuickBooks Online OAuth2 (authorization-code flow) with automatic refresh
 * and encrypted-at-rest token storage (§16).
 *
 * Flow:
 *   1. buildAuthorizeUrl() → owner_admin connects the real QBO app.
 *   2. /api/qbo/callback exchanges the code (exchangeCode) and persists tokens
 *      ENCRYPTED in the qbo_credentials table (per environment + realm).
 *   3. getValidAccessToken() returns a fresh access token, refreshing (and
 *      re-persisting) automatically shortly before expiry.
 *
 * Env vars are only the bootstrap seed; once connected, the encrypted DB copy
 * is the source of truth (§16). If credentials are missing/invalid, callers
 * must fall back to validation/dry-run only — never silent posting (§16, §22).
 */
import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import type { QboEnvironment } from "@/lib/cashsheet/rollout";

const AUTH_BASE = "https://appcenter.intuit.com/connect/oauth2";
const TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const SCOPE = "com.intuit.quickbooks.accounting";

/**
 * QBO rejected the stored token when we tried to use/refresh it (e.g. a 400 on
 * the refresh grant because the refresh token expired or was revoked). A typed
 * error so callers can degrade to "reconnect required" instead of crashing, and
 * can tell it apart from a genuine bug. Never carries the response body (which
 * may echo secrets) — status only.
 */
export class QboAuthError extends Error {
  constructor(public status: number, statusText: string) {
    super(`QBO token request failed: ${status} ${statusText}`);
    this.name = "QboAuthError";
  }
}

// Refresh this many ms BEFORE the access token actually expires.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export function currentEnvironment(): QboEnvironment {
  return process.env.QBO_ENV === "live" ? "live" : "sandbox";
}

export function buildAuthorizeUrl(state: string): string {
  const clientId = requireEnv("QBO_CLIENT_ID");
  const redirectUri = requireEnv("QBO_REDIRECT_URI");
  const url = new URL(AUTH_BASE);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPE);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  x_refresh_token_expires_in?: number;
  token_type: string;
}

function basicAuthHeader(): string {
  const id = requireEnv("QBO_CLIENT_ID");
  const secret = requireEnv("QBO_CLIENT_SECRET");
  return "Basic " + Buffer.from(`${id}:${secret}`).toString("base64");
}

async function tokenRequest(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!res.ok) {
    // Never log the body verbatim (it may echo secrets) — status only.
    throw new QboAuthError(res.status, res.statusText);
  }
  return (await res.json()) as TokenResponse;
}

/** Exchange an authorization code for tokens and persist them (encrypted). */
export async function exchangeCode(code: string, realmId: string, connectedByEmail?: string) {
  const redirectUri = requireEnv("QBO_REDIRECT_URI");
  const tokens = await tokenRequest(
    new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri })
  );
  return persistTokens(currentEnvironment(), realmId, tokens, connectedByEmail);
}

async function persistTokens(
  environment: QboEnvironment,
  realmId: string,
  tokens: TokenResponse,
  connectedByEmail?: string
) {
  const now = Date.now();
  const accessExpires = new Date(now + tokens.expires_in * 1000);
  const refreshExpires = tokens.x_refresh_token_expires_in
    ? new Date(now + tokens.x_refresh_token_expires_in * 1000)
    : null;

  return prisma.qboCredential.upsert({
    where: { environment_realmId: { environment, realmId } },
    create: {
      environment,
      realmId,
      accessTokenEnc: encrypt(tokens.access_token),
      refreshTokenEnc: encrypt(tokens.refresh_token),
      accessTokenExpires: accessExpires,
      refreshTokenExpires: refreshExpires,
      scope: SCOPE,
      connectedByEmail,
    },
    update: {
      accessTokenEnc: encrypt(tokens.access_token),
      refreshTokenEnc: encrypt(tokens.refresh_token),
      accessTokenExpires: accessExpires,
      refreshTokenExpires: refreshExpires,
      connectedByEmail,
    },
  });
}

export interface ActiveCredential {
  accessToken: string;
  realmId: string;
  environment: QboEnvironment;
}

/**
 * Return a valid access token for the given environment, refreshing if needed.
 * Returns null when there is no stored credential (→ dry-run/validation only).
 */
export async function getValidAccessToken(
  environment: QboEnvironment = currentEnvironment()
): Promise<ActiveCredential | null> {
  const cred = await prisma.qboCredential.findFirst({ where: { environment } });
  if (!cred) return null;

  const expiresAt = cred.accessTokenExpires.getTime();
  if (Date.now() < expiresAt - REFRESH_SKEW_MS) {
    return { accessToken: decrypt(cred.accessTokenEnc), realmId: cred.realmId, environment };
  }

  // Refresh.
  const refreshToken = decrypt(cred.refreshTokenEnc);
  const tokens = await tokenRequest(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken })
  );
  await persistTokens(environment, cred.realmId, tokens, cred.connectedByEmail ?? undefined);
  return { accessToken: tokens.access_token, realmId: cred.realmId, environment };
}

/** Cheap check for the dashboard "setup required" state (§16). */
export async function hasValidCredentials(
  environment: QboEnvironment = currentEnvironment()
): Promise<boolean> {
  try {
    return (await getValidAccessToken(environment)) !== null;
  } catch {
    return false;
  }
}

/**
 * A **network-free** credential check for chrome that renders on every route
 * (e.g. the top-bar environment pill). Unlike {@link hasValidCredentials} this
 * NEVER performs a token refresh — doing so on the shared layout would fire a
 * refresh on every page load and can race the page's own refresh (Intuit
 * rotates refresh tokens on use, so the loser gets a 400). Here we only read the
 * stored row and its expiry: a credential exists and its refresh token has not
 * lapsed. The authoritative "is the token actually good" answer stays with the
 * data path, which refreshes exactly once and degrades gracefully on failure.
 */
export async function hasStoredCredential(
  environment: QboEnvironment = currentEnvironment()
): Promise<boolean> {
  const cred = await prisma.qboCredential
    .findFirst({ where: { environment }, select: { refreshTokenExpires: true } })
    .catch(() => null);
  if (!cred) return false;
  return !cred.refreshTokenExpires || cred.refreshTokenExpires.getTime() > Date.now();
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var ${key} (§16).`);
  return v;
}
