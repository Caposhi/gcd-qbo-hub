/**
 * Thin QBO Accounting API client (§16).
 *
 * Wraps fetch with the correct base URL per environment, bearer auth (via the
 * OAuth module's auto-refresh), JSON handling, and REDACTED request/response
 * capture for the qbo_transactions audit table (§16, §18 — never log tokens).
 *
 * This is the direct Accounting API client the automation needs (create
 * expense/deposit/transfer, query accounts) — deliberately NOT this session's
 * interactive QBO connector, which is scoped to invoicing/payroll/reporting and
 * tied to an interactive session (§1, §16, §22).
 */
import { getValidAccessToken, type ActiveCredential } from "./oauth";
import type { QboEnvironment } from "@/lib/cashsheet/rollout";

const BASE_URL: Record<QboEnvironment, string> = {
  sandbox: "https://sandbox-quickbooks.api.intuit.com",
  live: "https://quickbooks.api.intuit.com",
};

const MINOR_VERSION = "70";

export class QboNotConnectedError extends Error {
  constructor(public environment: QboEnvironment) {
    super(`QBO is not connected for the ${environment} environment (setup required).`);
    this.name = "QboNotConnectedError";
  }
}

export interface QboContext {
  cred: ActiveCredential;
}

export async function getContext(environment: QboEnvironment): Promise<QboContext> {
  const cred = await getValidAccessToken(environment);
  if (!cred) throw new QboNotConnectedError(environment);
  return { cred };
}

/** Redact obviously-sensitive keys from an object before persisting it. */
export function redactPayload(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj;
  const SENSITIVE = /token|secret|authorization|password/i;
  if (Array.isArray(obj)) return obj.map(redactPayload);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? "[REDACTED]" : redactPayload(v);
  }
  return out;
}

async function request<T>(
  ctx: QboContext,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  const base = BASE_URL[ctx.cred.environment];
  const url = new URL(`${base}/v3/company/${ctx.cred.realmId}/${path}`);
  url.searchParams.set("minorversion", MINOR_VERSION);

  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${ctx.cred.accessToken}`,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new QboApiError(res.status, path, safeJson(text));
  }
  return safeJson(text) as T;
}

export class QboApiError extends Error {
  constructor(
    public status: number,
    public path: string,
    public detail: unknown
  ) {
    super(`QBO API ${status} on ${path}`);
    this.name = "QboApiError";
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Run a SQL-ish QBO query (used for account/transaction lookups). */
export async function query<T = unknown>(ctx: QboContext, statement: string): Promise<T> {
  const path = `query?query=${encodeURIComponent(statement)}`;
  return request<T>(ctx, "GET", path);
}

export async function post<T = unknown>(ctx: QboContext, entity: string, body: unknown): Promise<T> {
  return request<T>(ctx, "POST", entity, body);
}

/** List active accounts (for the Account Mapping resolution UI, §14). */
export async function listAccounts(ctx: QboContext): Promise<Array<{ Id: string; Name: string; FullyQualifiedName: string; AccountType: string; AccountSubType?: string }>> {
  const res = await query<{ QueryResponse?: { Account?: any[] } }>(
    ctx,
    "select Id, Name, FullyQualifiedName, AccountType, AccountSubType from Account where Active = true MAXRESULTS 1000"
  );
  return res.QueryResponse?.Account ?? [];
}
