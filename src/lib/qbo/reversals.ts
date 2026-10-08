/**
 * Tekmetric corrections ("reversals") sitting in Undeposited Funds.
 *
 * When a payment is changed or deleted in Tekmetric, Back Office does not edit
 * the QBO payment. It leaves the original Payment in Undeposited Funds and
 * posts a journal entry that credits Undeposited Funds for the same amount,
 * memo "Applied to: 70001 | DOE, JANE on 03/10/26 for $-1000.00",
 * DocNumber = the payment method. The pair nets to zero: no money moved.
 *
 * A real refund has exactly the same shape. The difference is what happened to
 * the money: a refund's payment went into a deposit (or goes into the same
 * payout as its refund), a correction's payment never will. So a pair is
 * "cancelled" only while BOTH halves are still open in Undeposited Funds, and
 * callers decide what that means for them (see deposit-reconciliation/actions).
 *
 * Seen live (Aug 2026): a Koalafi deposit took a customer's reversed "Other"
 * payment because a cancelled payment looked like any other open payment of
 * the right amount and name.
 */
import { query, type QboContext } from "./client";
import { findUndepositedRefunds } from "./refunds";
import { depositHolding } from "./deposits";

function escapeQuery(v: string): string {
  return v.replace(/'/g, "\\'");
}

const toCents = (n: number) => Math.round(n * 100);
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export interface OpenPayment {
  id: string;
  amount: number;
  date: string; // YYYY-MM-DD
  customerName: string;
  /** Payment-method name, e.g. "Other", "Visa", "Koalifi". */
  method: string;
  /** PaymentRefNum — Tekmetric repeats the method here. */
  refNum: string;
  /** PrivateNote — Tekmetric's "70001 | GCD | Other | 03/10/2026". */
  note: string;
}

export interface OpenReversal {
  jeId: string;
  lineId: string;
  amount: number;
  date: string;
  customerName: string;
  memo: string;
  /** The journal entry's DocNumber (the payment method), "" when unset. */
  ref: string;
}

export interface ReversalPair {
  paymentId: string;
  jeId: string;
  lineId: string;
  amount: number;
  date: string;
  customerName: string;
  /** Repair order number shared by both halves. */
  ro: string;
  method: string;
}

/** Parse "Applied to: 70001 | DOE, JANE on 03/10/26 for $-1000.00". */
export function parseReversalMemo(memo: string): { ro: string; name: string; date: string; amount: number } | null {
  const m = /^\s*Applied to:\s*([^|\s]+)\s*\|\s*(.+?)\s+on\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+for\s+\$\s*-?\s*([\d,]+(?:\.\d+)?)/i.exec(memo);
  if (!m) return null;
  const year = m[5].length === 2 ? `20${m[5]}` : m[5];
  return {
    ro: m[1],
    name: m[2].trim(),
    date: `${year}-${m[3].padStart(2, "0")}-${m[4].padStart(2, "0")}`,
    amount: Number(m[6].replace(/,/g, "")),
  };
}

/** The repair order a Tekmetric payment belongs to: its memo's first field. */
export function paymentRo(note: string): string {
  return note.split("|")[0]?.trim() ?? "";
}

/**
 * Pair each open reversal with ONE open payment it cancels: same repair order,
 * same amount to the cent, same customer, and — when the reversal names a
 * method — the same method. A payment of the same date is preferred. Each
 * payment pairs at most once, so of two identical payments with one reversal,
 * one stays a normal open payment. Pure.
 */
export function pairReversals(payments: OpenPayment[], reversals: OpenReversal[]): ReversalPair[] {
  const used = new Set<string>();
  const pairs: ReversalPair[] = [];
  const ordered = [...reversals].sort((a, b) => a.date.localeCompare(b.date) || a.jeId.localeCompare(b.jeId));
  for (const r of ordered) {
    const parsed = parseReversalMemo(r.memo);
    if (!parsed || toCents(parsed.amount) !== toCents(r.amount)) continue;
    const ref = norm(r.ref);
    const candidates = payments
      .filter(
        (p) =>
          !used.has(p.id) &&
          paymentRo(p.note) === parsed.ro &&
          toCents(p.amount) === toCents(r.amount) &&
          norm(p.customerName) === norm(r.customerName || parsed.name) &&
          (!ref || norm(p.method) === ref || norm(p.refNum) === ref)
      )
      .sort((a, b) => Number(b.date === parsed.date) - Number(a.date === parsed.date) || a.id.localeCompare(b.id));
    const p = candidates[0];
    if (!p) continue;
    used.add(p.id);
    pairs.push({
      paymentId: p.id,
      jeId: r.jeId,
      lineId: r.lineId,
      amount: p.amount,
      date: p.date,
      customerName: p.customerName,
      ro: parsed.ro,
      method: p.method || r.ref,
    });
  }
  return pairs;
}

/**
 * Open payments in [startDate, endDate] that sit in Undeposited Funds and are
 * on no deposit yet, with their method names. Read-only.
 */
async function findOpenPayments(
  ctx: QboContext,
  startDate: string,
  endDate: string,
  links: Map<string, string>
): Promise<OpenPayment[]> {
  const methodRes = await query<{ QueryResponse?: { PaymentMethod?: any[] } }>(ctx, "select Id, Name from PaymentMethod MAXRESULTS 1000");
  const methods = new Map<string, string>();
  for (const m of methodRes.QueryResponse?.PaymentMethod ?? []) methods.set(String(m.Id), String(m.Name ?? ""));
  const out: OpenPayment[] = [];
  for (let start = 1; ; start += 1000) {
    const res = await query<{ QueryResponse?: { Payment?: any[] } }>(
      ctx,
      `select * from Payment where TxnDate >= '${escapeQuery(startDate)}' and TxnDate <= '${escapeQuery(endDate)}' ` +
        `STARTPOSITION ${start} MAXRESULTS 1000`
    );
    const rows = res.QueryResponse?.Payment ?? [];
    for (const p of rows) {
      const amount = Number(p.TotalAmt ?? 0);
      if (!(amount > 0)) continue;
      const acct = String(p.DepositToAccountRef?.name ?? "");
      if (acct && !/undeposited funds/i.test(acct)) continue;
      const id = String(p.Id);
      if (depositHolding(links, "Payment", id)) continue;
      const methodId = p.PaymentMethodRef?.value ? String(p.PaymentMethodRef.value) : "";
      out.push({
        id,
        amount,
        date: String(p.TxnDate ?? ""),
        customerName: String(p.CustomerRef?.name ?? ""),
        method: String(p.PaymentMethodRef?.name ?? methods.get(methodId) ?? ""),
        refNum: String(p.PaymentRefNum ?? ""),
        note: String(p.PrivateNote ?? ""),
      });
    }
    if (rows.length < 1000) break;
  }
  return out;
}

/**
 * Cancelled pairs whose payment AND reversal are both still open in
 * Undeposited Funds, for transactions dated in [startDate, endDate]. `links`
 * is the deposit index (collectDepositIndex) covering at least that span
 * through today. Read-only.
 */
export async function findReversalPairs(
  ctx: QboContext,
  startDate: string,
  endDate: string,
  links: Map<string, string>
): Promise<ReversalPair[]> {
  const [found, payments] = await Promise.all([
    findUndepositedRefunds(ctx, startDate, endDate),
    findOpenPayments(ctx, startDate, endDate, links),
  ]);
  const reversals: OpenReversal[] = found.refunds
    .filter((r) => r.kind === "JournalEntry" && r.lineId !== undefined)
    .filter((r) => !depositHolding(links, "JournalEntry", r.txnId, r.lineId))
    .map((r) => ({
      jeId: r.txnId,
      lineId: r.lineId!,
      amount: r.amount,
      date: r.date,
      customerName: r.customerName,
      memo: r.memo,
      ref: r.ref ?? "",
    }));
  return pairReversals(payments, reversals);
}

/** Stable key for a pair (used by the cleanup form). */
export function reversalPairKey(p: Pick<ReversalPair, "paymentId" | "jeId" | "lineId">): string {
  return `${p.paymentId}~${p.jeId}~${p.lineId}`;
}
