/**
 * Google Sheets ingestion via a service account (§1, §3, §4).
 *
 * Auth plumbing mirrors gcd-webhook-server's getGoogleSheetsClient() (a service
 * account, same env-driven JSON key), but extended well beyond append-only:
 * here we list tabs, read arbitrary ranges/whole tabs, and read/write the
 * hidden control columns + developer metadata that carry the stable row UUID
 * (§4). The service account's email must be granted access to the sheet.
 *
 * This module is intentionally the ONLY place that talks to the Sheets API, so
 * the rest of the system works on plain parsed rows.
 */
import { google, type sheets_v4 } from "googleapis";
import { JWT } from "google-auth-library";
import { CONTROL_KEYS } from "@/lib/cashsheet/uuid";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

function loadServiceAccount(): { client_email: string; private_key: string } {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let json: string | undefined;
  if (b64) json = Buffer.from(b64, "base64").toString("utf8");
  else if (raw) json = raw;
  if (!json) {
    throw new Error(
      "Google service account not configured (set GOOGLE_SERVICE_ACCOUNT_JSON or _BASE64) (§16)."
    );
  }
  const parsed = JSON.parse(json);
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

let cachedClient: sheets_v4.Sheets | null = null;

/** Same shape/spirit as gcd-webhook's getGoogleSheetsClient(); auth only. */
export function getGoogleSheetsClient(): sheets_v4.Sheets {
  if (cachedClient) return cachedClient;
  const { client_email, private_key } = loadServiceAccount();
  const auth = new JWT({ email: client_email, key: private_key, scopes: SCOPES });
  cachedClient = google.sheets({ version: "v4", auth });
  return cachedClient;
}

export interface TabInfo {
  title: string;
  sheetId: number; // gid
  hidden: boolean;
}

/** List every tab (title + gid) in the workbook. */
export async function listTabs(spreadsheetId: string): Promise<TabInfo[]> {
  const sheets = getGoogleSheetsClient();
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title,hidden))",
  });
  return (res.data.sheets ?? []).map((s) => ({
    title: s.properties?.title ?? "",
    sheetId: s.properties?.sheetId ?? 0,
    hidden: !!s.properties?.hidden,
  }));
}

/**
 * Read a whole tab's grid values (row-major). We over-read columns (A:AZ) so
 * far-right hidden control columns (§4) are included, then trim empties.
 */
export async function readTabValues(spreadsheetId: string, tabTitle: string): Promise<unknown[][]> {
  const sheets = getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${quoteTab(tabTitle)}!A1:AZ`,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
  });
  return (res.data.values ?? []) as unknown[][];
}

/** Read an arbitrary A1 range (used by tools / re-checks). */
export async function readRange(spreadsheetId: string, a1Range: string): Promise<unknown[][]> {
  const sheets = getGoogleSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: a1Range,
    valueRenderOption: "UNFORMATTED_VALUE",
    dateTimeRenderOption: "SERIAL_NUMBER",
  });
  return (res.data.values ?? []) as unknown[][];
}

/**
 * Read developer metadata attached to a spreadsheet (row-scoped UUIDs live
 * here when we use metadata rather than a hidden column, §4). Returns a map
 * from metadataKey → value. Best-effort: returns {} if none.
 */
export async function readDeveloperMetadata(spreadsheetId: string): Promise<Record<string, string>> {
  const sheets = getGoogleSheetsClient();
  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "developerMetadata(metadataKey,metadataValue)",
    });
    const out: Record<string, string> = {};
    for (const m of res.data.developerMetadata ?? []) {
      if (m.metadataKey) out[m.metadataKey] = m.metadataValue ?? "";
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Write a stable row UUID into the hidden control column for a given row (§4).
 * The control columns are appended far to the right and should be hidden +
 * protected by an admin (we never write visible error messages, §4).
 *
 * @param controlColumnIndex 0-based column index of GCD_QBO_Row_ID.
 * @param rowNumber          1-based sheet row number.
 */
export async function writeRowUuid(
  spreadsheetId: string,
  tabTitle: string,
  controlColumnIndex: number,
  rowNumber: number,
  uuid: string
): Promise<void> {
  const sheets = getGoogleSheetsClient();
  const colA1 = columnIndexToA1(controlColumnIndex);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${quoteTab(tabTitle)}!${colA1}${rowNumber}`,
    valueInputOption: "RAW",
    requestBody: { values: [[uuid]] },
  });
}

export const CONTROL_COLUMN_HEADERS = [
  CONTROL_KEYS.rowId,
  CONTROL_KEYS.firstSeenAt,
  CONTROL_KEYS.lastSeenAt,
  CONTROL_KEYS.originalHash,
  CONTROL_KEYS.lastKnownHash,
];

function quoteTab(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** 0 → A, 25 → Z, 26 → AA … */
export function columnIndexToA1(index: number): string {
  let s = "";
  let n = index;
  while (n >= 0) {
    s = String.fromCharCode((n % 26) + 65) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}
