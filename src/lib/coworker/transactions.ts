/**
 * Pure normalizer for the QBO "Ask My Client" transaction import (read-only).
 *
 * Turns the raw QBO TransactionList report JSON (transactions posted to the
 * configured account) into a flat, typed list. IO-free and defensive about the
 * report shape — it maps columns by their titles (not fixed positions) and walks
 * nested/section rows, skipping totals — so it tolerates QBO returning a
 * different column set or grouping. Unit-tested against a representative fixture.
 *
 * Dedupe key: QBO's report cells don't reliably expose the transaction's own id
 * (the linkable id varies by column), so we derive a STABLE natural key from the
 * transaction's date, type, doc number, amount, and name. That dedupes
 * re-imports without depending on QBO's id placement.
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
  ColData?: RawCell[];
  Rows?: { Row?: RawRow[] };
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

export function normalizeTransactionList(raw: unknown): AmcTransaction[] {
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
  const amountI = findCol((t) => t.includes("amount"));

  const out: AmcTransaction[] = [];

  const walk = (rows?: RawRow[]): void => {
    for (const r of rows ?? []) {
      if (r?.ColData && r.ColData.length) {
        const cell = (i: number): string => (i >= 0 ? (r.ColData![i]?.value ?? "").trim() : "");
        const date = cell(dateI);
        const type = cell(typeI);
        const amount = parseAmount(cell(amountI));
        // A real transaction row has a date, a type, and a parseable amount.
        // Section/total rows (and blank rows) fail this and are skipped.
        if (date && type && amount !== null) {
          const num = cell(numI);
          const name = cell(nameI);
          const memo = cell(memoI);
          const key = [date, type, num, amount.toFixed(2), name].join("|");
          out.push({ key, type, date, num, name, memo, amount });
        }
      }
      if (r?.Rows?.Row) walk(r.Rows.Row);
    }
  };
  walk(report.Rows?.Row);
  return out;
}
