/**
 * One-click hide + protect for the sheet write-back managed columns (§4).
 *
 * Once write-back has stamped GCD_QBO_Row_ID etc. into a tab, those columns
 * must be hidden and protected — otherwise a normal whole-row edit (a typo
 * fix, a date correction) can clear the hidden UUID and silently break row
 * identity. That's exactly what happened in production: a name correction on
 * a posted row ("WITYY" -> "WITTY") reset its identity, and the resulting
 * "new" row attempted to sweep an already-deposited QBO payment a second time
 * (see duplicates.ts's findInvNumberSibling, added to guard against exactly
 * that). This orchestrates the lockdown across every scanned month tab using
 * the SAME service account the sync already writes with, so it doesn't
 * require a manual per-tab pass through the Sheets UI.
 *
 * Deliberately does NOT touch the Template tab: the engine never scans or
 * writes to Template (§3), so it never has real managed columns to protect —
 * an admin sets that up by hand, once, so future months created by
 * duplicating it inherit the protection from day one.
 */
import { listTabs, readTabValues, lockdownManagedColumns } from "@/lib/google/sheets";
import { detectHeaderRow } from "./headers";
import { planWritebackColumns, MANAGED_ORDER } from "./writeback";
import { canonicalMonthTab } from "./config";

export interface LockdownResult {
  tab: string;
  outcome: "locked" | "skipped_no_columns" | "skipped_no_header" | "error";
  detail: string;
}

export async function lockdownAllWritebackColumns(spreadsheetId: string): Promise<LockdownResult[]> {
  const tabs = await listTabs(spreadsheetId);
  const targets = tabs.filter((t) => canonicalMonthTab(t.title) !== null);

  const results: LockdownResult[] = [];
  for (const tab of targets) {
    try {
      const values = await readTabValues(spreadsheetId, tab.title);
      const det = detectHeaderRow(values);
      if (!det) {
        results.push({ tab: tab.title, outcome: "skipped_no_header", detail: "No header row detected" });
        continue;
      }
      const headerRow = values[det.headerRowIndex];
      const layout = planWritebackColumns(headerRow, det.columns);
      if (layout.headerCellsToWrite.length > 0) {
        // Not every managed column exists here yet (write-back hasn't run, or
        // hasn't succeeded, on this tab) — nothing populated yet to protect.
        results.push({
          tab: tab.title,
          outcome: "skipped_no_columns",
          detail: `Managed columns not fully written yet (missing: ${layout.headerCellsToWrite
            .map((h) => h.value)
            .join(", ")})`,
        });
        continue;
      }
      const cols = MANAGED_ORDER.map((k) => layout.colByKey[k]);
      const startCol = Math.min(...cols);
      const endCol = Math.max(...cols) + 1;
      await lockdownManagedColumns(spreadsheetId, tab.sheetId, startCol, endCol);
      results.push({
        tab: tab.title,
        outcome: "locked",
        detail: `Columns ${startCol}-${endCol - 1} hidden + protected (service account only)`,
      });
    } catch (err) {
      results.push({ tab: tab.title, outcome: "error", detail: String(err) });
    }
  }
  return results;
}
