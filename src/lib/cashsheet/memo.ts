/**
 * QBO memo / private-note formatting (§9).
 *
 * A consistent, greppable memo that ties every QBO transaction back to the
 * exact sheet row and the stable GCD row UUID. Format (§9):
 *
 *   Cash Sheet | <Tab> | Row <n> | <YYYY-MM-DD> | Rcv/Paid By: <..> | Name: <..>
 *     | Purpose: <..> | INV#: <..> | Approved By: <..> | GCD Row ID: <uuid>
 *
 * Backup links are omitted unless later configured (the Back up column is
 * usually blank).
 */
import type { ParsedRow } from "./rows";
import { formatDate } from "./dates";

export function buildMemo(tabName: string, row: ParsedRow, rowUuid: string): string {
  const parts = [
    "Cash Sheet",
    tabName,
    `Row ${row.rowNumber}`,
    formatDate(row.date),
    `Rcv/Paid By: ${row.rcvByOrPaidTo || "-"}`,
    `Name: ${row.name || "-"}`,
    `Purpose: ${row.purpose || "-"}`,
    `INV#: ${row.invNumber || "-"}`,
    `Approved By: ${row.approvedBy || "-"}`,
    `GCD Row ID: ${rowUuid}`,
  ];
  return parts.join(" | ");
}

/**
 * Doc number for QBO where supported. Kept short and stable: a slice of the
 * UUID is deterministic and unique enough for a document number, and including
 * it lets a QBO duplicate search key off it (§10, §16).
 */
export function buildDocNumber(rowUuid: string): string {
  const tail = rowUuid.replace(/^gcdqbo-/, "").replace(/-/g, "");
  return `GCD-${tail.slice(0, 12).toUpperCase()}`;
}
