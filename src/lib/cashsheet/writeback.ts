/**
 * Sheet write-back planning (§4).
 *
 * The system manages a small block of columns to the RIGHT of the visible cash
 * table:
 *   - a HIDDEN stable row UUID (GCD_QBO_Row_ID) — the primary identity (§4),
 *     which an admin should hide + protect once populated;
 *   - human-facing confirmation columns: status, QBO transaction id, posted-at,
 *     and error message, so employees get in-sheet confirmation without opening
 *     the hub (mirrors the legend the workbook already documents).
 *
 * This module is PURE: given a detected header row and the mapped data columns,
 * it decides which sheet column each managed field lives in — reusing a managed
 * column that already exists (matched by exact header text) and appending any
 * that don't, in a fixed order, just past all existing content so it can never
 * land on a data column or an existing header. Reading/writing cells is the
 * Google Sheets service's job (see sheets.ts writeCells).
 */
import { CONTROL_KEYS } from "./uuid";
import type { SheetField } from "./headers";

export type ManagedKey = "rowId" | "status" | "txnId" | "postedAt" | "error";

/** Header text for each managed column. `rowId` is the hidden identity (§4). */
export const MANAGED_HEADERS: Record<ManagedKey, string> = {
  rowId: CONTROL_KEYS.rowId, // GCD_QBO_Row_ID — hide + protect once written
  status: "GCD_QBO_Status",
  txnId: "GCD_QBO_Txn_ID",
  postedAt: "GCD_QBO_Posted_At",
  error: "GCD_QBO_Error",
};

/** Fixed left-to-right order in which missing managed columns are appended. */
export const MANAGED_ORDER: ManagedKey[] = ["rowId", "status", "txnId", "postedAt", "error"];

export interface WritebackLayout {
  /** 0-based sheet column index for each managed field. */
  colByKey: Record<ManagedKey, number>;
  /** Header cells that must be written (managed columns that did not exist). */
  headerCellsToWrite: Array<{ col: number; value: string }>;
}

function normalize(s: unknown): string {
  return String(s ?? "").trim();
}

/**
 * Plan managed-column placement for one tab.
 *
 * @param headerRow    the raw header row cells (row-major)
 * @param dataColumns  detected data field → column index, so a managed column
 *                     is never placed on top of a data column
 */
export function planWritebackColumns(
  headerRow: unknown[] | undefined,
  dataColumns: Partial<Record<SheetField, number>>
): WritebackLayout {
  const row = headerRow ?? [];
  const colByKey = {} as Record<ManagedKey, number>;
  const headerCellsToWrite: Array<{ col: number; value: string }> = [];

  // 1. Reuse any managed column that already exists (matched by exact header).
  const taken = new Set<number>();
  const missing: ManagedKey[] = [];
  for (const key of MANAGED_ORDER) {
    const header = MANAGED_HEADERS[key];
    let found = -1;
    for (let c = 0; c < row.length; c++) {
      if (normalize(row[c]) === header) {
        found = c;
        break;
      }
    }
    if (found >= 0) {
      colByKey[key] = found;
      taken.add(found);
    } else {
      missing.push(key);
    }
  }

  // 2. Append the rest just past ALL existing content — never over a data
  //    column or an existing header cell (including an unrelated legend far to
  //    the right, since row.length reflects the last non-empty header cell).
  const dataCols = Object.values(dataColumns).filter((v): v is number => v !== undefined);
  const lastDataCol = dataCols.length ? Math.max(...dataCols) : -1;
  const lastHeaderCol = row.length - 1;
  let cursor = Math.max(lastDataCol, lastHeaderCol) + 1;
  for (const key of missing) {
    while (taken.has(cursor)) cursor++;
    colByKey[key] = cursor;
    headerCellsToWrite.push({ col: cursor, value: MANAGED_HEADERS[key] });
    taken.add(cursor);
    cursor++;
  }

  return { colByKey, headerCellsToWrite };
}
