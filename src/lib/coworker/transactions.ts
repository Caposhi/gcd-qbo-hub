/**
 * Pure normalizer for the QBO "Ask My Client" transaction import (read-only).
 *
 * Turns the raw QBO GeneralLedger report JSON into a flat, typed list of the
 * lines posted to a given account. GeneralLedger (not TransactionList) is the
 * right report: it lists transactions BY account (like QBO's "Account
 * QuickReport"), whereas TransactionList ignores an account filter and returns
 * everything.
 *
 * IO-free and defensive about the report shape:
 *   - maps columns by their titles (not fixed positions);
 *   - is SECTION-AWARE — GL groups rows under an account header, so when an
 *     `accountName` is given we only emit rows under the matching account
 *     section (belt-and-suspenders in case the API-side account filter is loose);
 *   - skips header/total/summary rows.
 *
 * Dedupe key: QBO's report cells don't reliably expose the transaction's own id
 * (the linkable id varies by column), so we derive a STABLE natural key from the
 * transaction's date, type, doc number, amount, and name.
 */

export interface AmcTransaction {
  /** Stable dedupe key (date|type|num|amount|name). */
  key: string;
  /** QBO transaction type, e.g. "Expense", "Deposit", "Journal Entry". */
  type: string;
  /** Transaction date, "YYYY-MM-DD". */
  date: string;
  /** Document number, if any. */
  num: string;
  /** Payee / customer / vendor name, if any. */
  name: string;
  /** Memo / description, if any. */
  memo: string;
  /** Signed amount in dollars. */
  amount: number;
}

interface RawCell {
  value?: string;
  id?: string;
}
interface RawRow {
  Header?: { ColData?: RawCell[] };
  ColData?: RawCell[];
  Rows?: { Row?: RawRow[] };
  Summary?: { ColData?: RawCell[] };
  type?: string;
}
interface RawReport {
  Columns?: { Column?: Array<{ ColTitle?: string }> };
  Rows?: { Row?: RawRow[] };
}

/** Parse a QBO money string ("$1,234.56", "(1,234.56)") to a signed number. */
function parseAmount(s: string): number | null {
  if (!s) return null;
  const negative = /\(.*\)/.test(s);
  const n = Number(s.replace(/[$,()\s]/g, ""));
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

/** Does a GL section header (possibly a fully-qualified "Parent:Child") name this account? */
function sectionMatches(section: string | undefined, target: string): boolean {
  if (!section) return false;
  const s = section.trim().toLowerCase();
  return s === target || s.endsWith(":" + target) || (s.split(":").pop() ?? "") === target;
}

/**
 * Normalize a QBO GeneralLedger report into the lines posted to `accountName`.
 * When `accountName` is given, only rows under the matching account SECTION are
 * emitted — so even if the report contains other accounts, we never leak them.
 * Omit `accountName` to emit every data row (legacy/back-compat).
 */
export function normalizeAccountTransactions(raw: unknown, accountName?: string): AmcTransaction[] {
  const report = (raw ?? {}) as RawReport;
  const titles = (report.Columns?.Column ?? []).map((c) => (c?.ColTitle ?? "").toLowerCase());

  const findCol = (pred: (t: string) => boolean): number => titles.findIndex(pred);
  const dateI = findCol((t) => t.includes("date"));
  const typeI = findCol((t) => t.includes("transaction type") || t === "type");
  const numI = findCol((t) => t.includes("num") || t.includes("no.") || t.includes("doc"));
  const nameI = findCol(
    (t) => t.includes("name") || t.includes("payee") || t.includes("customer") || t.includes("vendor")
  );
  const memoI = findCol((t) => t.includes("memo") || t.includes("description"));
  // "Amount" (the line amount) — NOT "Balance" (the running total), which also
  // ends in a number but doesn't contain "amount".
  const amountI = findCol((t) => t.includes("amount"));

  const target = accountName?.trim().toLowerCase();
  const out: AmcTransaction[] = [];

  // GL groups rows into account sections: a row carries a Header (the account
  // name) plus nested Rows. Track the enclosing section so we can filter to the
  // target account; data rows inherit their section's account.
  const walk = (rows: RawRow[] | undefined, section: string | undefined): void => {
    for (const r of rows ?? []) {
      const sectionName = r?.Header?.ColData?.[0]?.value?.trim() || section;

      if (r?.ColData && r.ColData.length) {
        const cell = (i: number): string => (i >= 0 ? (r.ColData![i]?.value ?? "").trim() : "");
        const date = cell(dateI);
        const type = cell(typeI);
        const amount = parseAmount(cell(amountI));
        // A real transaction line has a date, a type, and a parseable amount.
        // Header/total/summary and blank rows fail this and are skipped.
        const inScope = !target || sectionMatches(sectionName, target);
        if (inScope && date && type && amount !== null) {
          const num = cell(numI);
          const name = cell(nameI);
          const memo = cell(memoI);
          const key = [date, type, num, amount.toFixed(2), name].join("|");
          out.push({ key, type, date, num, name, memo, amount });
        }
      }
      if (r?.Rows?.Row) walk(r.Rows.Row, sectionName);
    }
  };
  walk(report.Rows?.Row, undefined);
  return out;
}
