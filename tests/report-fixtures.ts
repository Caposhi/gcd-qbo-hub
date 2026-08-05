/**
 * Captured-shape sample QBO Report API payloads for the Financial Reporting
 * unit tests. These mirror the real nested QBO envelope (Header / Columns.Column
 * / Rows.Row with Section headers, nested Rows, Summary, and `group` codes) so
 * the pure normalization layer is tested against realistic structure — same
 * discipline as src/lib/cashsheet fixtures.
 */

/** P&L summarised by Month: May 2026, Jun 2026, + a grand-total column. */
export const PNL_MONTHLY = {
  Header: {
    ReportName: "ProfitAndLoss",
    StartPeriod: "2026-05-01",
    EndPeriod: "2026-06-30",
    Currency: "USD",
    Option: [{ Name: "AccountingMethod", Value: "Accrual" }],
  },
  Columns: {
    Column: [
      { ColTitle: "", ColType: "Account" },
      { ColTitle: "May 2026", ColType: "Money" },
      { ColTitle: "Jun 2026", ColType: "Money" },
      { ColTitle: "Total", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "total" }] },
    ],
  },
  Rows: {
    Row: [
      {
        Header: { ColData: [{ value: "Income" }, { value: "" }, { value: "" }, { value: "" }] },
        Rows: {
          Row: [
            { ColData: [{ value: "Labor", id: "79" }, { value: "10000.00" }, { value: "12000.00" }, { value: "22000.00" }], type: "Data" },
            { ColData: [{ value: "Parts", id: "80" }, { value: "8,000.00" }, { value: "9000.00" }, { value: "17000.00" }], type: "Data" },
          ],
        },
        Summary: { ColData: [{ value: "Total Income" }, { value: "18000.00" }, { value: "21000.00" }, { value: "39000.00" }] },
        type: "Section",
        group: "Income",
      },
      {
        Header: { ColData: [{ value: "Cost of Goods Sold" }, { value: "" }, { value: "" }, { value: "" }] },
        Rows: {
          Row: [
            { ColData: [{ value: "Parts Cost", id: "81" }, { value: "4000.00" }, { value: "4500.00" }, { value: "8500.00" }], type: "Data" },
          ],
        },
        Summary: { ColData: [{ value: "Total Cost of Goods Sold" }, { value: "4000.00" }, { value: "4500.00" }, { value: "8500.00" }] },
        type: "Section",
        group: "COGS",
      },
      { ColData: [{ value: "Gross Profit" }, { value: "14000.00" }, { value: "16500.00" }, { value: "30500.00" }], type: "Data", group: "GrossProfit" },
      {
        Header: { ColData: [{ value: "Expenses" }, { value: "" }, { value: "" }, { value: "" }] },
        Rows: {
          Row: [
            { ColData: [{ value: "Rent", id: "90" }, { value: "3000.00" }, { value: "3000.00" }, { value: "6000.00" }], type: "Data" },
            { ColData: [{ value: "Wages", id: "91" }, { value: "6000.00" }, { value: "6500.00" }, { value: "12500.00" }], type: "Data" },
          ],
        },
        Summary: { ColData: [{ value: "Total Expenses" }, { value: "9000.00" }, { value: "9500.00" }, { value: "18500.00" }] },
        type: "Section",
        group: "Expenses",
      },
      { ColData: [{ value: "Net Operating Income" }, { value: "5000.00" }, { value: "7000.00" }, { value: "12000.00" }], type: "Data", group: "NetOperatingIncome" },
      { ColData: [{ value: "Net Income" }, { value: "5000.00" }, { value: "7000.00" }, { value: "12000.00" }], type: "Data", group: "NetIncome" },
    ],
  },
};

/** Balance Sheet as of 2026-06-30 (single Total column). */
export const BALANCE_SHEET = {
  Header: { ReportName: "BalanceSheet", StartPeriod: "2026-01-01", EndPeriod: "2026-06-30", Currency: "USD" },
  Columns: {
    Column: [
      { ColTitle: "", ColType: "Account" },
      { ColTitle: "Total", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "total" }] },
    ],
  },
  Rows: {
    Row: [
      {
        Header: { ColData: [{ value: "ASSETS" }, { value: "" }] },
        Rows: {
          Row: [
            {
              Header: { ColData: [{ value: "Bank Accounts" }, { value: "" }] },
              Rows: {
                Row: [
                  { ColData: [{ value: "Operating Checking", id: "35" }, { value: "50000.00" }], type: "Data" },
                  { ColData: [{ value: "Savings", id: "36" }, { value: "25000.00" }], type: "Data" },
                ],
              },
              Summary: { ColData: [{ value: "Total Bank Accounts" }, { value: "75000.00" }] },
              type: "Section",
              group: "BankAccounts",
            },
            {
              Header: { ColData: [{ value: "Accounts Receivable" }, { value: "" }] },
              Rows: { Row: [{ ColData: [{ value: "Accounts Receivable", id: "84" }, { value: "12000.00" }], type: "Data" }] },
              Summary: { ColData: [{ value: "Total Accounts Receivable" }, { value: "12000.00" }] },
              type: "Section",
              group: "AR",
            },
          ],
        },
        Summary: { ColData: [{ value: "Total Assets" }, { value: "87000.00" }] },
        type: "Section",
      },
      {
        Header: { ColData: [{ value: "LIABILITIES AND EQUITY" }, { value: "" }] },
        Rows: {
          Row: [
            {
              Header: { ColData: [{ value: "Liabilities" }, { value: "" }] },
              Rows: { Row: [{ ColData: [{ value: "Accounts Payable", id: "33" }, { value: "8000.00" }], type: "Data" }] },
              Summary: { ColData: [{ value: "Total Liabilities" }, { value: "8000.00" }] },
              type: "Section",
            },
            {
              Header: { ColData: [{ value: "Equity" }, { value: "" }] },
              Rows: { Row: [{ ColData: [{ value: "Retained Earnings", id: "2" }, { value: "79000.00" }], type: "Data" }] },
              Summary: { ColData: [{ value: "Total Equity" }, { value: "79000.00" }] },
              type: "Section",
            },
          ],
        },
        type: "Section",
      },
    ],
  },
};

/** Aged Receivables summary as of 2026-06-30. */
export const AR_AGING = {
  Header: { ReportName: "AgedReceivables", EndPeriod: "2026-06-30", Currency: "USD" },
  Columns: {
    Column: [
      { ColTitle: "", ColType: "Customer" },
      { ColTitle: "Current", ColType: "Money" },
      { ColTitle: "1 - 30", ColType: "Money" },
      { ColTitle: "31 - 60", ColType: "Money" },
      { ColTitle: "61 - 90", ColType: "Money" },
      { ColTitle: "91 and over", ColType: "Money" },
      { ColTitle: "Total", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "total" }] },
    ],
  },
  Rows: {
    Row: [
      { ColData: [{ value: "Acme Autobody", id: "12" }, { value: "1000.00" }, { value: "500.00" }, { value: "" }, { value: "" }, { value: "" }, { value: "1500.00" }], type: "Data" },
      { ColData: [{ value: "Bavarian Motors", id: "13" }, { value: "" }, { value: "" }, { value: "2000.00" }, { value: "" }, { value: "500.00" }, { value: "2500.00" }], type: "Data" },
      { ColData: [{ value: "TOTAL" }, { value: "1000.00" }, { value: "500.00" }, { value: "2000.00" }, { value: "" }, { value: "500.00" }, { value: "4000.00" }], type: "Data" },
    ],
  },
};

/** Sales by Customer for the range. */
export const CUSTOMER_SALES = {
  Header: { ReportName: "CustomerSales", StartPeriod: "2026-05-01", EndPeriod: "2026-06-30", Currency: "USD" },
  Columns: {
    Column: [
      { ColTitle: "", ColType: "Customer" },
      { ColTitle: "Total", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "total" }] },
    ],
  },
  Rows: {
    Row: [
      { ColData: [{ value: "Bavarian Motors", id: "13" }, { value: "19000.00" }], type: "Data" },
      { ColData: [{ value: "Acme Autobody", id: "12" }, { value: "20000.00" }], type: "Data" },
      { ColData: [{ value: "TOTAL" }, { value: "39000.00" }], type: "Data" },
    ],
  },
};

/**
 * A "real world" P&L that reproduces the three production bugs seen on the live
 * German Car Depot file:
 *   1. NO COGS section (parts booked to income) → QBO omits the Gross Profit row.
 *   2. The Expenses section NESTS a sub-section ("Job Expenses"), whose sub-total
 *      shares the inherited "Expenses" group code and is flattened BEFORE the
 *      outer "Total Expenses".
 *   3. Net Income arrives as a SUMMARY-ONLY row (group + Summary, no Header/Rows
 *      and no top-level ColData).
 * Summarised by month → one period column ("Jul 2026") + a grand-total column.
 */
export const PNL_REALWORLD = {
  Header: {
    ReportName: "ProfitAndLoss",
    StartPeriod: "2026-07-01",
    EndPeriod: "2026-07-31",
    Currency: "USD",
    Option: [{ Name: "AccountingMethod", Value: "Accrual" }],
  },
  Columns: {
    Column: [
      { ColTitle: "", ColType: "Account" },
      { ColTitle: "Jul 2026", ColType: "Money" },
      { ColTitle: "Total", ColType: "Money", MetaData: [{ Name: "ColKey", Value: "total" }] },
    ],
  },
  Rows: {
    Row: [
      {
        Header: { ColData: [{ value: "Income" }, { value: "" }, { value: "" }] },
        Rows: {
          Row: [
            { ColData: [{ value: "TEK Sales-Parts Sales", id: "80" }, { value: "45000.00" }, { value: "45000.00" }], type: "Data" },
            { ColData: [{ value: "TEK Sales-Labor Sales", id: "79" }, { value: "30000.00" }, { value: "30000.00" }], type: "Data" },
          ],
        },
        Summary: { ColData: [{ value: "Total Income" }, { value: "75000.00" }, { value: "75000.00" }] },
        type: "Section",
        group: "Income",
      },
      // No COGS section, and hence no Gross Profit row.
      {
        Header: { ColData: [{ value: "Expenses" }, { value: "" }, { value: "" }] },
        Rows: {
          Row: [
            // Nested sub-section — inherits the "Expenses" group code; its summary
            // is emitted BEFORE the outer Total Expenses.
            {
              Header: { ColData: [{ value: "Job Expenses" }, { value: "" }, { value: "" }] },
              Rows: {
                Row: [
                  { ColData: [{ value: "Contractors", id: "95" }, { value: "81.03" }, { value: "81.03" }], type: "Data" },
                ],
              },
              Summary: { ColData: [{ value: "Total Job Expenses" }, { value: "81.03" }, { value: "81.03" }] },
              type: "Section",
            },
            { ColData: [{ value: "Building Rent", id: "90" }, { value: "3000.00" }, { value: "3000.00" }], type: "Data" },
            { ColData: [{ value: "STAFF wages", id: "91" }, { value: "6000.00" }, { value: "6000.00" }], type: "Data" },
          ],
        },
        Summary: { ColData: [{ value: "Total Expenses" }, { value: "9081.03" }, { value: "9081.03" }] },
        type: "Section",
        group: "Expenses",
      },
      // Net Income as a SUMMARY-ONLY row (no Header/Rows, no top-level ColData).
      {
        Summary: { ColData: [{ value: "Net Income" }, { value: "65918.97" }, { value: "65918.97" }] },
        type: "Section",
        group: "NetIncome",
      },
    ],
  },
};

/**
 * Sales by Item where the only money columns are "Sales" and "Avg Price" (no
 * "Amount"/"Total" title and no grand-total column). The pre-fix picker fell to
 * the LAST money column ("Avg Price") and charted per-unit prices instead of
 * sales dollars — the live "Revenue by Service/Product" bug.
 */
export const ITEM_SALES_AVG_PRICE_TRAP = {
  Header: { ReportName: "ItemSales", StartPeriod: "2026-07-01", EndPeriod: "2026-07-31", Currency: "USD" },
  Columns: {
    Column: [
      { ColTitle: "", ColType: "Account" },
      { ColTitle: "Qty", ColType: "Numeric" },
      { ColTitle: "Sales", ColType: "Money" },
      { ColTitle: "Avg Price", ColType: "Money" },
    ],
  },
  Rows: {
    Row: [
      { ColData: [{ value: "TEK Sales-Parts Sales", id: "80" }, { value: "300" }, { value: "45000.00" }, { value: "150.00" }], type: "Data" },
      { ColData: [{ value: "TEK Sales-Labor Sales", id: "79" }, { value: "200" }, { value: "30000.00" }, { value: "150.00" }], type: "Data" },
    ],
  },
};

/**
 * The live "Revenue by Service/Product" shape that defeated the title-based
 * picker: the real sales-dollar column carries NO usable title, while a
 * per-invoice average column IS titled. Title heuristics skip the untitled
 * column and land on the average, charting ~$1.5K bars against $234K of revenue.
 *
 * Only the dollar column reconciles with the report's own Total row
 * (45,000 + 30,000 = 75,000), which is how the normalizer now identifies it —
 * the averages sum to 1,650, nowhere near their stated 1,483.79.
 */
export const ITEM_SALES_UNTITLED_AMOUNT = {
  Header: { ReportName: "ItemSales", StartPeriod: "2026-07-01", EndPeriod: "2026-07-31", Currency: "USD" },
  Columns: {
    Column: [
      { ColTitle: "", ColType: "Account" },
      { ColTitle: "", ColType: "Money" },
      { ColTitle: "Avg Price", ColType: "Money" },
    ],
  },
  Rows: {
    Row: [
      { ColData: [{ value: "TEK Sales-Parts Sales", id: "80" }, { value: "45000.00" }, { value: "900.00" }], type: "Data" },
      { ColData: [{ value: "TEK Sales-Labor Sales", id: "79" }, { value: "30000.00" }, { value: "750.00" }], type: "Data" },
      {
        Summary: { ColData: [{ value: "Total" }, { value: "75000.00" }, { value: "1483.79" }] },
        type: "Section",
      },
    ],
  },
};

/**
 * The REAL GCD ItemSales shape for Jul 2026, verified against QuickBooks — the
 * live "Revenue by Service/Product" bug.
 *
 * Both Qty and Amount are additive (each sums to its own Total), so additivity
 * alone can't tell them apart, and Qty comes FIRST. The chart showed parts at
 * "1,483.79" — the quantity — instead of $98,938.69, which also made parts
 * out-rank labor even though labor sold $33K more.
 *
 * The "% of Sales" column settles it: parts is 42.3% of sales, which matches
 * 98,938.69 / 233,913.96 but not 1,483.79 / 2,197.92 (67.5%).
 */
export const ITEM_SALES_QTY_TRAP = {
  Header: { ReportName: "ItemSales", StartPeriod: "2026-07-01", EndPeriod: "2026-07-31", Currency: "USD" },
  Columns: {
    Column: [
      { ColTitle: "", ColType: "Account" },
      { ColTitle: "", ColType: "Money" }, // Qty — untitled, so name-matching can't skip it
      { ColTitle: "", ColType: "Money" }, // Amount
      { ColTitle: "% of Sales", ColType: "Percent" },
      { ColTitle: "Avg Price", ColType: "Money" },
    ],
  },
  Rows: {
    Row: [
      { ColData: [{ value: "TEK Discounts" }, { value: "66" }, { value: "-4934.80" }, { value: "-2.11" }, { value: "-74.77" }], type: "Data" },
      { ColData: [{ value: "TEK Sales-Labor Sales" }, { value: "590.13" }, { value: "132117.46" }, { value: "56.48" }, { value: "223.88" }], type: "Data" },
      { ColData: [{ value: "TEK Sales-Other Sales" }, { value: "40" }, { value: "1126.61" }, { value: "0.48" }, { value: "28.17" }], type: "Data" },
      { ColData: [{ value: "TEK Sales-Parts Sales" }, { value: "1483.79" }, { value: "98938.69" }, { value: "42.30" }, { value: "66.68" }], type: "Data" },
      { ColData: [{ value: "TEK Sales-Sublet Sales" }, { value: "12" }, { value: "6653.00" }, { value: "2.84" }, { value: "554.42" }], type: "Data" },
      { ColData: [{ value: "TEK Taxes & Licenses-Battery/Tire Tax Expense" }, { value: "6" }, { value: "13.00" }, { value: "0.01" }, { value: "2.17" }], type: "Data" },
      {
        Summary: {
          ColData: [
            { value: "TOTAL" },
            { value: "2197.92" },
            { value: "233913.96" },
            { value: "100.00" },
            { value: "106.42" },
          ],
        },
        type: "Section",
      },
    ],
  },
};

/** Sales by Item (no grand-total column; an "Amount" money column). */
export const ITEM_SALES = {
  Header: { ReportName: "ItemSales", StartPeriod: "2026-05-01", EndPeriod: "2026-06-30", Currency: "USD" },
  Columns: {
    Column: [
      { ColTitle: "", ColType: "Account" },
      { ColTitle: "Qty", ColType: "Numeric" },
      { ColTitle: "Amount", ColType: "Money" },
      { ColTitle: "Avg Price", ColType: "Money" },
    ],
  },
  Rows: {
    Row: [
      { ColData: [{ value: "Parts", id: "80" }, { value: "100" }, { value: "17000.00" }, { value: "170.00" }], type: "Data" },
      { ColData: [{ value: "Labor", id: "79" }, { value: "40" }, { value: "22000.00" }, { value: "550.00" }], type: "Data" },
    ],
  },
};
