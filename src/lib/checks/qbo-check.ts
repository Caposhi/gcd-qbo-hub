/**
 * QBO Check I/O for the Check Reception module.
 *
 * A "check" in QBO is a Purchase with PaymentType "Check": paid FROM a bank
 * account (top-level AccountRef = Chase Checking 9680), to a vendor (top-level
 * EntityRef), with the check number as DocNumber, and a single expense line
 * (AccountBasedExpenseLineDetail → the category account). Creating it makes QBO
 * offer to Match the downloaded Chase bank-feed line to it — the same
 * create-you-match flow the deposit module uses.
 *
 * Everything here is scoped to that one operation plus the read-only lookups the
 * create needs: resolve/create the vendor, resolve the category account by name,
 * and a duplicate guard that refuses to post a second check with the same number.
 */
import { query, post, redactPayload, type QboContext } from "@/lib/qbo/client";

function escapeQuery(v: string): string {
  return v.replace(/'/g, "\\'");
}

export interface VendorRef {
  value: string;
  name: string;
}

/**
 * Resolve a payee name to a QBO Vendor, creating it if absent — mirrors how the
 * Cash Sheet Sync poster handles payees and how Accounting Link creates vendors
 * on first use. Returns null only when the name is blank or QBO rejects both the
 * lookup and the create.
 */
export async function resolveOrCreateVendor(ctx: QboContext, name: string): Promise<VendorRef | null> {
  const n = (name ?? "").trim();
  if (!n) return null;
  const q = await query<{ QueryResponse?: { Vendor?: any[] } }>(
    ctx,
    `select Id, DisplayName from Vendor where DisplayName = '${escapeQuery(n)}'`
  );
  const found = q.QueryResponse?.Vendor?.[0];
  if (found?.Id) return { value: String(found.Id), name: String(found.DisplayName ?? n) };
  const created = await post<Record<string, any>>(ctx, "vendor", { DisplayName: n });
  const v = created.Vendor ?? {};
  if (v.Id) return { value: String(v.Id), name: String(v.DisplayName ?? n) };
  return null;
}

export interface AccountRef {
  value: string;
  name: string;
}

/** Resolve an expense category account by exact name. Returns null if absent. */
export async function resolveAccountByName(ctx: QboContext, name: string): Promise<AccountRef | null> {
  const n = (name ?? "").trim();
  if (!n) return null;
  const q = await query<{ QueryResponse?: { Account?: any[] } }>(
    ctx,
    `select Id, Name, FullyQualifiedName from Account where Name = '${escapeQuery(n)}' and Active = true`
  );
  const a = q.QueryResponse?.Account?.[0];
  if (a?.Id) return { value: String(a.Id), name: String(a.FullyQualifiedName ?? a.Name ?? n) };
  return null;
}

/**
 * Existing Purchases that already carry this check's DocNumber, drawn on the
 * given bank account. The double-post guard: if a check with this number is
 * already recorded, we refuse to create another. Read-only.
 */
export async function findChecksByDocNumber(
  ctx: QboContext,
  docNumber: string,
  bankAccountId: string
): Promise<Array<{ id: string; total: number }>> {
  const doc = (docNumber ?? "").trim();
  if (!doc) return [];
  const q = await query<{ QueryResponse?: { Purchase?: any[] } }>(
    ctx,
    `select Id, TotalAmt, AccountRef, DocNumber from Purchase where DocNumber = '${escapeQuery(doc)}'`
  );
  const out: Array<{ id: string; total: number }> = [];
  for (const p of q.QueryResponse?.Purchase ?? []) {
    // Same check number on the same bank account = the same physical check.
    if (String(p.AccountRef?.value ?? "") === bankAccountId) {
      out.push({ id: String(p.Id), total: Number(p.TotalAmt ?? 0) });
    }
  }
  return out;
}

export interface CheckPost {
  bankAccountId: string; // paid-from (Chase Checking 9680)
  vendor: VendorRef;
  categoryAccountId: string;
  categoryAccountName?: string;
  docNumber: string; // check number
  amount: number;
  txnDate: string; // YYYY-MM-DD
  privateNote: string;
  memo?: string;
}

/**
 * Build the Purchase body for a check. PaymentType "Check" + top-level
 * AccountRef (bank) + EntityRef (vendor) + DocNumber (check #) + a single
 * expense line categorized to the chosen account.
 */
export function buildCheckBody(input: CheckPost) {
  return {
    PaymentType: "Check",
    AccountRef: { value: input.bankAccountId },
    EntityRef: { value: input.vendor.value, name: input.vendor.name, type: "Vendor" },
    DocNumber: input.docNumber,
    TxnDate: input.txnDate,
    PrivateNote: input.privateNote,
    Line: [
      {
        Amount: Number(input.amount.toFixed(2)),
        DetailType: "AccountBasedExpenseLineDetail",
        Description: input.memo || undefined,
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: input.categoryAccountId, name: input.categoryAccountName || undefined },
        },
      },
    ],
  };
}

export interface CheckPostResult {
  qboTransactionId: string;
  qboSyncToken: string | null;
  docNumber: string | null;
  totalAmt: number | null;
  requestRedacted: unknown;
  responseRedacted: unknown;
}

/** Create the Check (Purchase) in QBO. Throws QboApiError on a rejected payload. */
export async function postCheck(ctx: QboContext, input: CheckPost): Promise<CheckPostResult> {
  const body = buildCheckBody(input);
  const res = await post<Record<string, any>>(ctx, "purchase", body);
  const created = res.Purchase ?? {};
  return {
    qboTransactionId: String(created.Id ?? ""),
    qboSyncToken: created.SyncToken != null ? String(created.SyncToken) : null,
    docNumber: created.DocNumber ?? null,
    totalAmt: created.TotalAmt != null ? Number(created.TotalAmt) : null,
    requestRedacted: redactPayload(body),
    responseRedacted: redactPayload(res),
  };
}
