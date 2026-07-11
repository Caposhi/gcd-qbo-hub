/**
 * Orchestration for the cash-sheet deposit-matching pilot (server-only).
 *
 * Ties the pure matcher/planner (cash-deposit.ts) to live QBO reads and the
 * account-mapping table. Used by both the read-only "Locate" action and the
 * "Create deposit" action so they share one code path — the create step
 * re-locates and re-verifies rather than trusting anything cached.
 */
import { prisma } from "@/lib/db";
import type { QboContext } from "@/lib/qbo/client";
import { findPaymentsInWindow } from "@/lib/qbo/deposits";
import { matchPaymentByRo, planCashDeposit, type CashDepositPlan, type PaymentLike } from "./cash-deposit";
import { RowStatus } from "./status";

export const CHASE_ACCOUNT = "Chase Checking 9680";
export const OVER_SHORT_ACCOUNT = "Cash over/short";

/**
 * Rows that are customer invoice cash collections (an INV#/RO plus a Collected
 * amount) not yet turned into a QBO deposit. On the 26 DC sheet these INV rows
 * record the cash in the "Amt Collected" column — that collected cash is what
 * gets physically deposited, and its Customer Payment already sits in
 * Undeposited Funds (posted by Back Office). Ordered oldest first.
 */
export async function findCashDepositCandidates() {
  return prisma.sheetRow.findMany({
    where: {
      invNumber: { not: null },
      amtCollected: { not: null },
      NOT: { qboTransactionType: "Deposit" },
    },
    orderBy: [{ date: "asc" }, { rowNumberLastSeen: "asc" }],
  });
}

export interface ResolvedAccounts {
  chaseId: string | null;
  overShortId: string | null;
}

export async function resolveDepositAccounts(): Promise<ResolvedAccounts> {
  const maps = await prisma.accountMapping.findMany({
    where: { friendlyName: { in: [CHASE_ACCOUNT, OVER_SHORT_ACCOUNT] } },
  });
  const byName = new Map(maps.map((m) => [m.friendlyName, m.qboAccountId]));
  return {
    chaseId: byName.get(CHASE_ACCOUNT) ?? null,
    overShortId: byName.get(OVER_SHORT_ACCOUNT) ?? null,
  };
}

export interface LocatedPlan {
  found: boolean;
  reason: string;
  ro: string;
  depositedAmount: number;
  payment: PaymentLike | null;
  plan: CashDepositPlan | null;
}

/** Shift a Date by N days, returning YYYY-MM-DD (UTC). */
function isoShift(date: Date, days: number): string {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Locate the Undeposited-Funds payment for a candidate row and build its plan.
 * Read-only. Widens the search window around the row date because a deposit is
 * often dated a day or two after the customer paid.
 */
export async function locateRow(
  ctx: QboContext,
  row: { date: Date | null; invNumber: string | null; amtCollected: unknown },
): Promise<LocatedPlan> {
  const ro = (row.invNumber ?? "").trim();
  const depositedAmount = Number(row.amtCollected ?? 0);
  const base: LocatedPlan = { found: false, reason: "", ro, depositedAmount, payment: null, plan: null };

  if (!ro) return { ...base, reason: "Row has no INV#/RO number" };
  if (!row.date) return { ...base, reason: "Row has no date to search around" };
  if (!(depositedAmount > 0)) return { ...base, reason: "Row has no collected amount" };

  const start = isoShift(row.date, -14);
  const end = isoShift(row.date, 7);
  const candidates = await findPaymentsInWindow(ctx, start, end);
  const payment = matchPaymentByRo(candidates, ro, depositedAmount);
  if (!payment) {
    return { ...base, reason: `No Undeposited-Funds payment with RO# ${ro} found between ${start} and ${end}` };
  }

  const plan = planCashDeposit(payment.amount, depositedAmount);
  plan.paymentId = payment.id;
  if (!plan.withinThreshold) {
    return {
      ...base,
      found: false,
      payment,
      plan,
      reason: `Payment ${payment.amount.toFixed(2)} vs deposit ${depositedAmount.toFixed(
        2
      )} differ by more than the $10 cash over/short cap — review before creating`,
    };
  }
  return { ...base, found: true, reason: "ok", payment, plan };
}

/** Statuses treated as "already has a QBO deposit" for idempotency. */
export function alreadyHasDeposit(row: { qboTransactionType: string | null; status: string }): boolean {
  return row.qboTransactionType === "Deposit" || row.status === RowStatus.DepositCreated;
}
