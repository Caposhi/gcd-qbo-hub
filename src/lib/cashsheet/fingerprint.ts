/**
 * Row hashing and fingerprinting for idempotency & change detection (§10, §11).
 *
 * Two distinct concepts:
 *   - rowUuid      : the PRIMARY stable identity (a hidden GCD_QBO_Row_ID stored
 *                    in the sheet's developer metadata / hidden column). Assigned
 *                    once, survives edits and moves. Managed in uuid.ts.
 *   - fingerprint  : a normalized hash of the transaction's business fields.
 *                    Used to spot possible duplicates (same transaction posted
 *                    twice) and, as `hash`, to detect changes after posting.
 *
 * The fingerprint field order and normalization are FIXED (§10). Changing them
 * would silently break duplicate/change detection, so they are covered by tests.
 */
import { createHash } from "node:crypto";
import type { ParsedRow } from "./rows";
import { formatDate } from "./dates";

function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toUpperCase();
}

function money(n: number | null): string {
  return n === null ? "" : n.toFixed(2);
}

/**
 * The canonical fingerprint tuple (§10). Note it does NOT include row number or
 * tab position — identity must not depend on where the row sits (§3, §22).
 * It DOES include tab name (the month) because the same amounts in different
 * months are genuinely different transactions.
 */
export function fingerprintFields(spreadsheetId: string, tabName: string, r: ParsedRow): string[] {
  return [
    norm(spreadsheetId),
    norm(tabName),
    formatDate(r.date),
    norm(r.rcvByOrPaidTo),
    norm(r.name),
    norm(r.purpose),
    norm(r.invNumber),
    money(r.amtCollected),
    money(r.amountPaidOut),
    money(r.bankDeposit),
    norm(r.approvedBy),
  ];
}

function sha256(parts: string[]): string {
  return createHash("sha256").update(parts.join("")).digest("hex");
}

/** Stable fingerprint for possible-duplicate detection (§10). */
export function computeFingerprint(spreadsheetId: string, tabName: string, r: ParsedRow): string {
  return sha256(fingerprintFields(spreadsheetId, tabName, r));
}

/**
 * Content hash for change-after-posting detection (§11). This is the same
 * tuple as the fingerprint today, but kept as a separate function so the two
 * concerns can diverge later (e.g. hash could include the backup column) without
 * disturbing duplicate detection.
 */
export function computeRowHash(spreadsheetId: string, tabName: string, r: ParsedRow): string {
  return sha256([...fingerprintFields(spreadsheetId, tabName, r), norm(r.backup)]);
}

/** A JSON-serializable snapshot of a row for the durable audit trail (§2, §11). */
export function rowSnapshot(spreadsheetId: string, tabName: string, r: ParsedRow) {
  return {
    spreadsheetId,
    tabName,
    rowNumber: r.rowNumber,
    date: formatDate(r.date),
    rcvByOrPaidTo: r.rcvByOrPaidTo,
    name: r.name,
    purpose: r.purpose,
    invNumber: r.invNumber,
    backup: r.backup,
    approvedBy: r.approvedBy,
    amtCollected: r.amtCollected,
    amountPaidOut: r.amountPaidOut,
    bankDeposit: r.bankDeposit,
    cashBalanceEnvelope: r.cashBalanceEnvelope,
    amountType: r.amountType,
  };
}
