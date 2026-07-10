/**
 * Build the QBO Deposit payload that groups the reconciled Undeposited-Funds
 * records so QBO auto-matches the bank-feed line (see the spec).
 *
 * SPIKE (verify against the live API before relying on posting): the exact
 * LinkedTxn shape for pulling in an existing Payment vs. a specific
 * JournalEntry line. The structure below is the documented form; a one-payout
 * dry run will confirm TxnType/TxnLineId handling for the fee JEs.
 */
import type { QboUndepositedRecord } from "./types";
import { toCents } from "./types";

export interface QboDepositPayload {
  DepositToAccountRef: { value: string };
  TxnDate: string;
  Line: Array<{
    Amount: number;
    DetailType: "DepositLineDetail";
    LinkedTxn: Array<{ TxnId: string; TxnType: string; TxnLineId?: string }>;
  }>;
}

export function buildDepositPayload(
  depositToAccountId: string,
  txnDate: string,
  records: QboUndepositedRecord[]
): QboDepositPayload {
  return {
    DepositToAccountRef: { value: depositToAccountId },
    TxnDate: txnDate,
    Line: records.map((r) => ({
      Amount: r.amount,
      DetailType: "DepositLineDetail" as const,
      LinkedTxn: [
        {
          TxnId: r.id,
          TxnType: r.type,
          ...(r.lineId ? { TxnLineId: r.lineId } : {}),
        },
      ],
    })),
  };
}

/** The deposit total (should equal the payout net). Cents-safe. */
export function depositTotalCents(payload: QboDepositPayload): number {
  return payload.Line.reduce((s, l) => s + toCents(l.Amount), 0);
}
