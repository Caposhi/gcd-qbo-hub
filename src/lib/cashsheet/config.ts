/**
 * Cash Sheet Sync global config keys & defaults (§12, §15).
 *
 * The live rollout stage and QBO environment are stored in the DB `config`
 * table (with change history), NOT as raw env flags — flipping them is an
 * audited, admin-only action (§12, §22). These constants define the keys and
 * their safe defaults; the DB accessor lives in src/lib/config-store.ts.
 */
import type { RolloutStage } from "./rollout";

export const CONFIG_KEYS = {
  rolloutStage: "css.rollout_stage",
  qboEnvironment: "css.qbo_environment",
  spreadsheetId: "css.spreadsheet_id",
  sheetWriteback: "css.sheet_writeback",
} as const;

/** The safest possible starting point: dry-run, sandbox (§12, §19, §22). */
export const DEFAULT_ROLLOUT_STAGE: RolloutStage = "dry_run";
export const DEFAULT_QBO_ENVIRONMENT = "sandbox";

/** The GCD cash-sheet workbook (§3). */
export const DEFAULT_SPREADSHEET_ID = "1NGz6sOiJtKOOBZYpM5_0ODZxgHkSQRWYZQqufpotTWA";

/** Monthly tabs by name only (§3). Template is skipped for posting. */
export const MONTH_TABS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export const TEMPLATE_TAB = "Template";

/**
 * Map a workbook tab title to its canonical month tab, tolerantly (§3).
 *
 * Employees name month tabs inconsistently — "May", "June", "JULY", "Jul 26",
 * "Sept '26" — so exact-matching against MONTH_TABS misses real data tabs. We
 * match on the first three letters (case-insensitive), which uniquely
 * identifies every month, and ignore any trailing year/space/punctuation.
 * Returns the canonical short name (e.g. "Jul") or null if it isn't a month.
 */
const MONTH_PREFIX: Record<string, string> = {
  jan: "Jan", feb: "Feb", mar: "Mar", apr: "Apr", may: "May", jun: "Jun",
  jul: "Jul", aug: "Aug", sep: "Sep", oct: "Oct", nov: "Nov", dec: "Dec",
};

export function canonicalMonthTab(title: string): string | null {
  const key = title.trim().toLowerCase().slice(0, 3);
  return MONTH_PREFIX[key] ?? null;
}

/** Business entity, for memos/reports (§0). */
export const BUSINESS_ENTITY = "Alan Gelfand Inc DBA German Car Depot";
