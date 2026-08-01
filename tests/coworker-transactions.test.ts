import { describe, it, expect } from "vitest";
import { normalizeAccountTransactions } from "@/lib/coworker/transactions";

// A representative QBO GeneralLedger report: rows grouped into account SECTIONS
// (each Section has a Header naming the account + nested data rows + a Summary).
// The target account "Ask My Client" holds two lines; a second account section
// ("Automobile") must be excluded when we filter by account name. Column order
// is deliberately non-obvious to prove the normalizer maps by title.
const GL = {
  Columns: {
    Column: [
      { ColTitle: "Date" },
      { ColTitle: "Transaction Type" },
      { ColTitle: "Num" },
      { ColTitle: "Name" },
      { ColTitle: "Memo/Description" },
      { ColTitle: "Split" },
      { ColTitle: "Amount" },
      { ColTitle: "Balance" },
    ],
  },
  Rows: {
    Row: [
      {
        type: "Section",
        Header: { ColData: [{ value: "Ask My Client" }] },
        Rows: {
          Row: [
            {
              type: "Data",
              ColData: [
                { value: "2026-06-08" },
                { value: "Expense" },
                { value: "" },
                { value: "ForgeMedia LLC" },
                { value: "FORGEMEDIA" },
                { value: "Checking" },
                { value: "59.95" },
                { value: "59.95" },
              ],
            },
            {
              type: "Data",
              ColData: [
                { value: "2026-07-10" },
                { value: "Journal Entry" },
                { value: "" },
                { value: "" },
                { value: "" },
                { value: "-Split-" },
                { value: "2,565.00" },
                { value: "2,624.95" },
              ],
            },
          ],
        },
        Summary: { ColData: [{ value: "Total for Ask My Client" }, {}, {}, {}, {}, {}, { value: "2,624.95" }] },
      },
      {
        // A DIFFERENT account section — must NOT be imported when filtering.
        type: "Section",
        Header: { ColData: [{ value: "Automobile" }] },
        Rows: {
          Row: [
            {
              type: "Data",
              ColData: [
                { value: "2026-06-01" },
                { value: "Expense" },
                { value: "9001" },
                { value: "Napa" },
                { value: "parts" },
                { value: "Checking" },
                { value: "500.00" },
                { value: "500.00" },
              ],
            },
          ],
        },
      },
    ],
  },
};

describe("normalizeAccountTransactions (GeneralLedger)", () => {
  it("returns ONLY the rows under the matching account section", () => {
    const txns = normalizeAccountTransactions(GL, "Ask My Client");
    expect(txns).toHaveLength(2); // the Automobile row is excluded
    expect(txns.map((t) => t.type)).toEqual(["Expense", "Journal Entry"]);
    expect(txns.map((t) => t.name)).not.toContain("Napa");
  });

  it("maps columns by title and parses amounts", () => {
    const [exp, je] = normalizeAccountTransactions(GL, "Ask My Client");
    expect(exp.date).toBe("2026-06-08");
    expect(exp.name).toBe("ForgeMedia LLC");
    expect(exp.amount).toBeCloseTo(59.95, 2);
    expect(je.amount).toBeCloseTo(2565, 2);
  });

  it("matches a fully-qualified section header (Parent:Child)", () => {
    const nested = {
      ...GL,
      Rows: { Row: [{ ...GL.Rows.Row[0], Header: { ColData: [{ value: "Other Expenses:Ask My Client" }] } }] },
    };
    expect(normalizeAccountTransactions(nested, "Ask My Client")).toHaveLength(2);
  });

  it("derives a stable dedupe key and never throws on garbage", () => {
    expect(normalizeAccountTransactions(GL, "Ask My Client")[0].key).toBe(
      "2026-06-08|Expense||59.95|ForgeMedia LLC"
    );
    expect(normalizeAccountTransactions(null, "Ask My Client")).toEqual([]);
    expect(normalizeAccountTransactions("nonsense")).toEqual([]);
  });

  it("without an account name, emits every data row (back-compat)", () => {
    expect(normalizeAccountTransactions(GL)).toHaveLength(3); // both sections
  });
});
