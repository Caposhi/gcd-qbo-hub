/**
 * Row parsing, candidate detection, and validation (§5).
 *
 * Given a header-column map (from headers.ts) and a raw row, produce a
 * structured ParsedRow. Then decide whether the row is a transaction candidate
 * and whether it is valid enough to consider posting. All rules here are pure
 * and unit-tested (§20).
 */
import type { SheetField } from "./headers";
import { parseCurrency, parsePositiveAmount } from "./amount";
import { parseSheetDate, isOnOrAfterStartDate } from "./dates";

export type AmountType = "amt_collected" | "amount_paid_out" | "bank_deposit";

export interface ParsedRow {
  rowNumber: number; // 1-based sheet row number at scan time
  date: Date | null;
  rcvByOrPaidTo: string;
  name: string;
  purpose: string;
  invNumber: string;
  backup: string;
  approvedBy: string;
  amtCollected: number | null;
  amountPaidOut: number | null;
  bankDeposit: number | null;
  cashBalanceEnvelope: number | null;
  /** Which single amount column is populated (null if zero or ambiguous). */
  amountType: AmountType | null;
  /** The positive transaction amount for the populated column, if valid. */
  amount: number | null;
}

function cell(row: unknown[], columns: Partial<Record<SheetField, number>>, field: SheetField): unknown {
  const idx = columns[field];
  if (idx === undefined) return undefined;
  return row[idx];
}

function str(v: unknown): string {
  return String(v ?? "").trim();
}

/** Determine which amount columns hold a value (any parseable number ≠ null). */
function populatedAmountColumns(
  amtCollected: number | null,
  amountPaidOut: number | null,
  bankDeposit: number | null
): AmountType[] {
  const out: AmountType[] = [];
  if (amtCollected !== null) out.push("amt_collected");
  if (amountPaidOut !== null) out.push("amount_paid_out");
  if (bankDeposit !== null) out.push("bank_deposit");
  return out;
}

export function parseRow(
  row: unknown[],
  columns: Partial<Record<SheetField, number>>,
  rowNumber: number
): ParsedRow {
  const amtCollected = parseCurrency(cell(row, columns, "amtCollected"));
  const amountPaidOut = parseCurrency(cell(row, columns, "amountPaidOut"));
  const bankDeposit = parseCurrency(cell(row, columns, "bankDeposit"));

  const populated = populatedAmountColumns(amtCollected, amountPaidOut, bankDeposit);
  const amountType: AmountType | null = populated.length === 1 ? populated[0] : null;

  let amount: number | null = null;
  if (amountType === "amt_collected") amount = parsePositiveAmount(cell(row, columns, "amtCollected"));
  else if (amountType === "amount_paid_out") amount = parsePositiveAmount(cell(row, columns, "amountPaidOut"));
  else if (amountType === "bank_deposit") amount = parsePositiveAmount(cell(row, columns, "bankDeposit"));

  return {
    rowNumber,
    date: parseSheetDate(cell(row, columns, "date")),
    rcvByOrPaidTo: str(cell(row, columns, "rcvByOrPaidTo")),
    name: str(cell(row, columns, "name")),
    purpose: str(cell(row, columns, "purpose")),
    invNumber: str(cell(row, columns, "invNumber")),
    backup: str(cell(row, columns, "backup")),
    approvedBy: str(cell(row, columns, "approvedBy")),
    amtCollected,
    amountPaidOut,
    bankDeposit,
    cashBalanceEnvelope: parseCurrency(cell(row, columns, "cashBalanceEnvelope")),
    amountType,
    amount,
  };
}

/**
 * A row is a transaction candidate if at least one of the three amount columns
 * has a value. Rows with no date and no amount are ignored completely (§5).
 */
export function isTransactionCandidate(r: ParsedRow): boolean {
  const anyAmount =
    r.amtCollected !== null || r.amountPaidOut !== null || r.bankDeposit !== null;
  if (anyAmount) return true;
  // No amount at all → only a candidate if it somehow has a date AND purpose,
  // but per §5 "ignore rows with no date and no amount". No amount → not a
  // candidate.
  return false;
}

/**
 * True when a row is a totals / summary line rather than a transaction (§5):
 * it carries amount(s) but none of the identifying fields a real transaction
 * always has (date, purpose, name, invoice #, received-by/paid-to). These are
 * the column-sum rows at the bottom of each month tab — ignore them rather
 * than flagging a spurious "more than one amount column" error.
 */
export function isSummaryRow(r: ParsedRow): boolean {
  const hasIdentity =
    r.date !== null ||
    r.purpose !== "" ||
    r.name !== "" ||
    r.invNumber !== "" ||
    r.rcvByOrPaidTo !== "";
  const hasAmount =
    r.amtCollected !== null || r.amountPaidOut !== null || r.bankDeposit !== null;
  return !hasIdentity && hasAmount;
}

/** True when the entire row is blank (no meaningful cell). Ignored (§5). */
export function isBlankRow(r: ParsedRow): boolean {
  return (
    r.date === null &&
    r.rcvByOrPaidTo === "" &&
    r.name === "" &&
    r.purpose === "" &&
    r.invNumber === "" &&
    r.approvedBy === "" &&
    r.amtCollected === null &&
    r.amountPaidOut === null &&
    r.bankDeposit === null
  );
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a candidate row (§5). Does NOT check purpose mapping (that is a
 * separate concern in classify/engine) — only structural validity.
 *
 * @param allowFuture  future-dated valid rows are processed (§5); we never
 *                     reject a row for being in the future.
 */
export function validateRow(r: ParsedRow, startDate?: Date): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!r.date) errors.push("Missing or unparseable date");
  if (r.purpose === "") errors.push("Missing purpose");

  const populated = populatedAmountColumns(r.amtCollected, r.amountPaidOut, r.bankDeposit);
  if (populated.length === 0) {
    errors.push("No transaction amount populated");
  } else if (populated.length > 1) {
    errors.push(`More than one amount column populated (${populated.join(", ")})`);
  } else if (r.amount === null) {
    errors.push("Amount is not a positive number");
  }

  if (r.date && startDate && !isOnOrAfterStartDate(r.date, startDate)) {
    // Not an error per se — the engine ignores it in normal mode — but callers
    // that validate directly get a clear signal.
    warnings.push("Date is before the automation start date");
  }

  return { valid: errors.length === 0, errors, warnings };
}
