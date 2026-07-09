/**
 * Header-row detection (§3).
 *
 * Monthly tabs are formatted cash tables whose header row is NOT at a fixed
 * position (title/opening-balance rows sit above it, and users reformat).
 * We scan the first N rows of a tab and pick the row that best matches the
 * expected column names, tolerant of spelling/spacing/case. We then map each
 * expected field to the column index we found it in — never to a hard-coded
 * column letter.
 */

/** Canonical field keys for the columns we care about (§3). */
export type SheetField =
  | "date"
  | "rcvByOrPaidTo"
  | "name"
  | "purpose"
  | "invNumber"
  | "backup"
  | "approvedBy"
  | "amtCollected"
  | "amountPaidOut"
  | "bankDeposit"
  | "cashBalanceEnvelope";

/**
 * Accepted header spellings per field (normalized-compared). The first entry
 * is the canonical label. Kept generous because these headers are typed by
 * employees and drift over time.
 */
const HEADER_ALIASES: Record<SheetField, string[]> = {
  date: ["date"],
  rcvByOrPaidTo: [
    "rcv by or paid to",
    "rcv by/paid to",
    "received by or paid to",
    "rcv by",
    "paid to",
    "rcvd by or paid to",
  ],
  name: ["name"],
  purpose: ["purpose"],
  invNumber: ["inv#", "inv #", "inv", "invoice", "invoice #", "invoice number", "ro", "ro#"],
  backup: ["back up", "backup", "back-up"],
  approvedBy: ["approved by", "approved", "approver"],
  amtCollected: ["amt collected", "amount collected", "collected", "amt collected $"],
  amountPaidOut: ["amount paid out", "amt paid out", "paid out", "amount paid"],
  bankDeposit: ["bank deposit", "deposit", "bank dep"],
  cashBalanceEnvelope: [
    "cash balance in envelope",
    "cash balance",
    "balance in envelope",
    "envelope balance",
    "cash in envelope",
  ],
};

/** Fields whose presence most strongly identifies a real header row. */
const CORE_FIELDS: SheetField[] = ["date", "purpose", "amtCollected", "amountPaidOut", "bankDeposit"];

export function normalizeHeader(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/ /g, " ") // non-breaking spaces
    .replace(/[\s]+/g, " ")
    .trim()
    .replace(/[.:]+$/g, "") // drop trailing punctuation like "Amt Collected:"
    .trim();
}

/** Match a single cell against a field's aliases. */
function cellMatchesField(cell: string, field: SheetField): boolean {
  const norm = normalizeHeader(cell);
  if (norm === "") return false;
  return HEADER_ALIASES[field].some((alias) => normalizeHeader(alias) === norm);
}

export interface HeaderDetection {
  /** 0-based index into the scanned rows array. */
  headerRowIndex: number;
  /** Map from field → 0-based column index within that row. */
  columns: Partial<Record<SheetField, number>>;
  /** How many distinct expected fields matched (for confidence/debugging). */
  matchCount: number;
}

/**
 * Score a candidate row: number of distinct expected fields it contains.
 * A field is counted once even if multiple cells could match it.
 */
function scoreRow(row: unknown[]): { columns: Partial<Record<SheetField, number>>; matchCount: number } {
  const columns: Partial<Record<SheetField, number>> = {};
  for (const field of Object.keys(HEADER_ALIASES) as SheetField[]) {
    for (let c = 0; c < row.length; c++) {
      if (columns[field] !== undefined) break;
      if (cellMatchesField(String(row[c] ?? ""), field)) {
        columns[field] = c;
      }
    }
  }
  return { columns, matchCount: Object.keys(columns).length };
}

/**
 * Find the header row within the first `scanRows` rows of a tab. Returns null
 * if no row matches enough columns to be a plausible header (so the caller can
 * flag the tab rather than misparse it).
 *
 * @param rows  raw 2-D cell values for the tab (row-major).
 */
export function detectHeaderRow(rows: unknown[][], scanRows = 15): HeaderDetection | null {
  let best: HeaderDetection | null = null;
  const limit = Math.min(scanRows, rows.length);

  for (let i = 0; i < limit; i++) {
    const { columns, matchCount } = scoreRow(rows[i] ?? []);
    if (best === null || matchCount > best.matchCount) {
      best = { headerRowIndex: i, columns, matchCount };
    }
  }

  if (!best) return null;

  // Require the date column plus at least one amount column, and a reasonable
  // total match count, so a stray label row can't masquerade as the header.
  const hasDate = best.columns.date !== undefined;
  const hasAnyAmount = CORE_FIELDS.some(
    (f) => f !== "date" && f !== "purpose" && best!.columns[f] !== undefined
  );
  if (!hasDate || !hasAnyAmount || best.matchCount < 4) return null;

  return best;
}
