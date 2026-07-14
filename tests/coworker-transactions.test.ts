import { describe, it, expect } from "vitest";
import { normalizeTransactionList } from "@/lib/coworker/transactions";

// A representative QBO TransactionList report: a header/section wrapper, real
// rows, and a total row that must be skipped. Column order is deliberately
// non-obvious to prove the normalizer maps by title, not position.
const REPORT = {
  Columns: {
    Column: [
      { ColTitle: "Date" },
      { ColTitle: "Transaction Type" },
      { ColTitle: "Num" },
      { ColTitle: "Name" },
      { ColTitle: "Memo/Description" },
      { ColTitle: "Account" },
      { ColTitle: "Amount" },
    ],
  },
  Rows: {
    Row: [
      {
        // A section wrapper with nested data rows (QBO groups like this).
        Rows: {
          Row: [
            {
              type: "Data",
              ColData: [
                { value: "2026-07-02" },
                { value: "Expense", id: "145" },
                { value: "1021" },
                { value: "Napa Auto Parts", id: "57" },
                { value: "uncoded card charge" },
                { value: "Ask My Client", id: "91" },
                { value: "$123.45" },
              ],
            },
            {
              type: "Data",
              ColData: [
                { value: "2026-07-05" },
                { value: "Deposit" },
                { value: "" },
                { value: "" },
                { value: "" },
                { value: "Ask My Client", id: "91" },
                { value: "($40.00)" }, // parenthesized negative
              ],
            },
          ],
        },
      },
      {
        // A total/summary row — no date/type — must be skipped.
        type: "Section",
        ColData: [
          { value: "" },
          { value: "" },
          { value: "" },
          { value: "" },
          { value: "" },
          { value: "Total" },
          { value: "$83.45" },
        ],
      },
    ],
  },
};

describe("normalizeTransactionList", () => {
  const txns = normalizeTransactionList(REPORT);

  it("extracts real transactions and skips totals", () => {
    expect(txns).toHaveLength(2);
    expect(txns.map((t) => t.type)).toEqual(["Expense", "Deposit"]);
  });

  it("maps columns by title and parses amounts (incl. parenthesized negatives)", () => {
    const [exp, dep] = txns;
    expect(exp.date).toBe("2026-07-02");
    expect(exp.num).toBe("1021");
    expect(exp.name).toBe("Napa Auto Parts");
    expect(exp.memo).toBe("uncoded card charge");
    expect(exp.amount).toBeCloseTo(123.45, 2);
    expect(dep.amount).toBeCloseTo(-40, 2);
  });

  it("derives a stable dedupe key that changes with the transaction's fields", () => {
    expect(txns[0].key).toBe("2026-07-02|Expense|1021|123.45|Napa Auto Parts");
    // Re-normalizing the same report yields identical keys (idempotent import).
    expect(normalizeTransactionList(REPORT)[0].key).toBe(txns[0].key);
  });

  it("never throws on garbage / empty input", () => {
    expect(normalizeTransactionList(null)).toEqual([]);
    expect(normalizeTransactionList("nonsense")).toEqual([]);
    expect(normalizeTransactionList({ Rows: { Row: [] } })).toEqual([]);
  });
});
