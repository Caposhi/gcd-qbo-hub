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
