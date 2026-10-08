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
  DetailType?: "DepositLineDetail";
  Description?: string;
  LinkedTxn?: Array<{ TxnId: string; TxnType: string; TxnLineId?: string }>;
  DepositLineDetail?: { AccountRef?: { value: string } };
}

export function buildCashDepositBody(input: CashDepositPost) {
  const lines: DepositLine[] = [
    // Line that pulls an existing Payment out of Undeposited Funds: LinkedTxn +
    // Amount ONLY. QBO rejects a linked line that also carries DetailType /
    // DepositLineDetail (400) — that shape is only for direct account lines.
    {
      Amount: Number(input.paymentAmount.toFixed(2)),
      // TxnLineId "0" links the whole Payment (matches Intuit's canonical
      // Deposit sample for every LinkedTxn line).
      LinkedTxn: [{ TxnId: input.paymentId, TxnType: "Payment", TxnLineId: "0" }],
    },
  ];
  if (Math.round(input.overShortAmount * 100) !== 0) {
    // Direct account line for the rounding plug — this one DOES use
    // DepositLineDetail with the Cash over/short account.
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

export interface LinkedDepositInput {
  depositToAccountId: string;
  txnDate: string; // YYYY-MM-DD
  privateNote: string;
  /** Undeposited-Funds customer payments to sweep (gross). */
  payments: Array<{ id: string; amount: number }>;
  /** Fee journal entries to sweep (amount negative); lineId = the UF line's Id. */
  journalEntries?: Array<{ id: string; lineId: string; amount: number }>;
  /**
   * Refunds sitting in Undeposited Funds that reduced this payout (amount
   * negative). A refunded charge means the bank received less than the gross
   * minus fees, so the refund has to be swept into the same deposit for it to
   * tie — see lib/qbo/refunds.ts.
   */
  refunds?: Array<{ id: string; txnType: "RefundReceipt" | "JournalEntry" | "Payment"; lineId?: string; amount: number }>;
  /** Optional plug line (e.g. card surcharge / over-short) to tie to the bank. */
  plug?: { accountId: string; amount: number; description?: string };
}

/**
 * Build a Bank Deposit that links multiple Undeposited-Funds records — customer
 * Payments and (for Tekmetric) fee JournalEntries — plus an optional account
 * plug line, into one deposit account. Same doc-verified line shapes as the
 * cash deposit: linked lines carry LinkedTxn only (no DetailType); the plug uses
 * DepositLineDetail. Used by deposit reconciliation.
 */
export function buildLinkedDepositBody(input: LinkedDepositInput) {
  const lines: DepositLine[] = [];
  for (const p of input.payments) {
    lines.push({
      Amount: Number(p.amount.toFixed(2)),
      LinkedTxn: [{ TxnId: p.id, TxnType: "Payment", TxnLineId: "0" }],
    });
  }
  for (const je of input.journalEntries ?? []) {
    lines.push({
      Amount: Number(je.amount.toFixed(2)),
      LinkedTxn: [{ TxnId: je.id, TxnType: "JournalEntry", TxnLineId: je.lineId }],
    });
  }
  for (const r of input.refunds ?? []) {
    lines.push({
      Amount: Number(r.amount.toFixed(2)),
      LinkedTxn: [
        {
          TxnId: r.id,
          TxnType: r.txnType,
          // A journal-entry link needs the specific UF line; a refund receipt
          // links as a whole transaction.
          ...(r.lineId !== undefined ? { TxnLineId: r.lineId } : {}),
        },
      ],
    });
  }
  if (input.plug && Math.round(input.plug.amount * 100) !== 0) {
    lines.push({
      Amount: Number(input.plug.amount.toFixed(2)),
      DetailType: "DepositLineDetail",
      Description: input.plug.description ?? "Adjustment",
      DepositLineDetail: { AccountRef: { value: input.plug.accountId } },
    });
  }
  return {
    DepositToAccountRef: { value: input.depositToAccountId },
    TxnDate: input.txnDate,
    PrivateNote: input.privateNote,
    Line: lines,
  };
}

/** Total of a built deposit body, in cents (for the exact-sum checksum). */
export function linkedDepositTotalCents(body: ReturnType<typeof buildLinkedDepositBody>): number {
  return body.Line.reduce((s, l) => s + Math.round(l.Amount * 100), 0);
}

/** Create a multi-line linked Bank Deposit in QBO. */
export async function postLinkedDeposit(
  ctx: QboContext,
  input: LinkedDepositInput
): Promise<DepositPostResult> {
  const body = buildLinkedDepositBody(input);
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

/**
 * Every transaction (or transaction line) already linked into a QBO Bank
 * Deposit, mapped to that deposit's id. Keys come from depositLinkKey: a link
 * that names a line (journal-entry fee/refund lines) is keyed to that line; a
 * link without one covers the whole transaction.
 *
 * Payments were always checked this way, but fee journal entries and refunds
 * were not — so a payout's fee or refund search could pick an entry a
 * neighbouring payout's deposit had already swept, and QBO rejected the new
 * deposit ("Transaction cannot be applied to Deposit … already been applied to
 * another Deposit", seen live on the 2026-09-17 payout). Pure; see
 * collectDepositedLinks for the query.
 */
export function indexDepositLinks(deposits: any[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const dep of deposits) {
    for (const line of dep?.Line ?? []) {
      for (const lt of line?.LinkedTxn ?? []) {
        if (!lt?.TxnType || !lt?.TxnId) continue;
        const key = depositLinkKey(String(lt.TxnType), String(lt.TxnId), lt.TxnLineId != null ? String(lt.TxnLineId) : null);
        if (!map.has(key)) map.set(key, String(dep.Id ?? ""));
      }
    }
  }
  return map;
}

/** Key for indexDepositLinks: "JournalEntry:123:2", or "Payment:45:" for a whole transaction. */
export function depositLinkKey(txnType: string, txnId: string, lineId?: string | null): string {
  // A Payment is linked with TxnLineId "0" meaning the whole payment; journal
  // entry lines can genuinely have Id "0", so only Payments drop it.
  const line = lineId && !(txnType === "Payment" && lineId === "0") ? lineId : "";
  return `${txnType}:${txnId}:${line}`;
}

/** The deposit a transaction (line) is already on, or undefined. */
export function depositHolding(
  links: Map<string, string>,
  txnType: string,
  txnId: string,
  lineId?: string | null
): string | undefined {
  return links.get(depositLinkKey(txnType, txnId, lineId)) ?? links.get(depositLinkKey(txnType, txnId, null));
}

/** All deposit links for deposits dated in [startDate, endDate], paged past QBO's 1000-row cap. */
export async function collectDepositedLinks(ctx: QboContext, startDate: string, endDate: string): Promise<Map<string, string>> {
  const all: any[] = [];
  for (let start = 1; ; start += 1000) {
    const res = await query<{ QueryResponse?: { Deposit?: any[] } }>(
      ctx,
      `select * from Deposit where TxnDate >= '${escapeQuery(startDate)}' and TxnDate <= '${escapeQuery(endDate)}' ` +
        `STARTPOSITION ${start} MAXRESULTS 1000`
    );
    const rows = res.QueryResponse?.Deposit ?? [];
    all.push(...rows);
    if (rows.length < 1000) break;
  }
  return indexDepositLinks(all);
}
