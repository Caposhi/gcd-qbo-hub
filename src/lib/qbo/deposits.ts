/**
 * QBO Bank Deposit I/O for the cash-sheet deposit-matching pilot.
 *
 * Two operations:
 *   - findPaymentsInWindow: read Undeposited-Funds customer payments in a date
 *     window (so the pure matcher can pick the one for a row by RO#). Read-only.
 *   - postCashDeposit: create a Bank Deposit that links a single UF Payment and,
 *     when the deposited amount differs by rounding, adds a Cash over/short line
 *     so the deposit total equals the amount actually deposited. QBO then
 *     auto-matches the bank-feed line.
 *
 * Linking an existing Payment uses a DepositLineDetail line with a LinkedTxn of
 * TxnType "Payment" — this pulls the payment out of Undeposited Funds. The
 * over/short line is an ordinary account-based DepositLineDetail line.
 */
import { query, post, redactPayload, type QboContext } from "./client";
import type { PaymentLike } from "@/lib/cashsheet/cash-deposit";

function escapeQuery(v: string): string {
  return v.replace(/'/g, "\\'");
}

/**
 * Undeposited-Funds customer payments with a TxnDate in [startDate, endDate]
 * (YYYY-MM-DD). Returns the memo (PrivateNote) and customer name so the pure
 * matcher can pick by RO# and the preview can show who it belongs to.
 */
export async function findPaymentsInWindow(
  ctx: QboContext,
  startDate: string,
  endDate: string
): Promise<PaymentLike[]> {
  const res = await query<{ QueryResponse?: { Payment?: any[] } }>(
    ctx,
    `select * from Payment where TxnDate >= '${escapeQuery(startDate)}' ` +
      `and TxnDate <= '${escapeQuery(endDate)}' MAXRESULTS 500`
  );
  return (res.QueryResponse?.Payment ?? []).map((p) => ({
    id: String(p.Id),
    amount: Number(p.TotalAmt ?? 0),
    privateNote: String(p.PrivateNote ?? ""),
    date: String(p.TxnDate ?? ""),
    customerName: p.CustomerRef?.name ? String(p.CustomerRef.name) : undefined,
  }));
}

export interface CashDepositPost {
  depositToAccountId: string;
  txnDate: string; // YYYY-MM-DD
  paymentId: string;
  paymentAmount: number;
  /** Cash over/short plug in dollars (may be negative); omitted when zero. */
  overShortAmount: number;
  overShortAccountId: string;
  /** Row UUID etc. — carried in the deposit's private note for the audit trail. */
  privateNote: string;
}

interface DepositLine {
  Amount: number;
  DetailType: "DepositLineDetail";
  Description?: string;
  LinkedTxn?: Array<{ TxnId: string; TxnType: string }>;
  DepositLineDetail?: { AccountRef?: { value: string } };
}

export function buildCashDepositBody(input: CashDepositPost) {
  const lines: DepositLine[] = [
    {
      Amount: Number(input.paymentAmount.toFixed(2)),
      DetailType: "DepositLineDetail",
      LinkedTxn: [{ TxnId: input.paymentId, TxnType: "Payment" }],
    },
  ];
  if (Math.round(input.overShortAmount * 100) !== 0) {
    lines.push({
      Amount: Number(input.overShortAmount.toFixed(2)),
      DetailType: "DepositLineDetail",
      Description: "Cash over/short",
      DepositLineDetail: { AccountRef: { value: input.overShortAccountId } },
    });
  }
  return {
    DepositToAccountRef: { value: input.depositToAccountId },
    TxnDate: input.txnDate,
    PrivateNote: input.privateNote,
    Line: lines,
  };
}

export interface DepositPostResult {
  qboTransactionId: string;
  qboSyncToken: string | null;
  totalAmt: number | null;
  requestRedacted: unknown;
  responseRedacted: unknown;
}

/** Create the Bank Deposit in QBO. Throws QboApiError on a rejected payload. */
export async function postCashDeposit(
  ctx: QboContext,
  input: CashDepositPost
): Promise<DepositPostResult> {
  const body = buildCashDepositBody(input);
  const res = await post<Record<string, any>>(ctx, "deposit", body);
  const created = res.Deposit ?? {};
  return {
    qboTransactionId: String(created.Id ?? ""),
    qboSyncToken: created.SyncToken != null ? String(created.SyncToken) : null,
    totalAmt: created.TotalAmt != null ? Number(created.TotalAmt) : null,
    requestRedacted: redactPayload(body),
    responseRedacted: redactPayload(res),
  };
}

/**
 * Payment IDs that are ALREADY part of a QBO Bank Deposit in [startDate,
 * endDate]. A customer payment sits in Undeposited Funds until a deposit sweeps
 * it; once swept, the deposit's line carries a LinkedTxn of TxnType "Payment".
 * We collect those ids so the matcher never offers to deposit a payment that is
 * already deposited (which would double-count). Read-only.
 */
export async function collectDepositedPaymentIds(
  ctx: QboContext,
  startDate: string,
  endDate: string
): Promise<Set<string>> {
  const res = await query<{ QueryResponse?: { Deposit?: any[] } }>(
    ctx,
    `select * from Deposit where TxnDate >= '${escapeQuery(startDate)}' ` +
      `and TxnDate <= '${escapeQuery(endDate)}' MAXRESULTS 1000`
  );
  const ids = new Set<string>();
  for (const dep of res.QueryResponse?.Deposit ?? []) {
    for (const line of dep.Line ?? []) {
      for (const lt of line.LinkedTxn ?? []) {
        if (lt?.TxnType === "Payment" && lt?.TxnId) ids.add(String(lt.TxnId));
      }
    }
  }
  return ids;
}
