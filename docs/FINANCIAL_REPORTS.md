# Financial Reports — build scope & phases

Status: **scoped & decided — ready to build Phase 1**
Module id: `financial-reports` · table prefix: `fin_` · base path: `/financial-reports`

Decisions locked (owner, this session): its own module with **departmental tabs**;
**cash** default for P&L-type reports and **accrual** for Balance-Sheet-type, always
toggleable; classes/budgets/inventory **auto-detected** rather than assumed.

---

## 0. Why this exists

Today the owner reads real financials in QuickBooks and gets *derived* views in the
hub (Projections → Reporting has KPI tiles + 6 charts). What's missing is the
**statements themselves** — P&L, Balance Sheet, Statement of Cash Flows — in one
place, readable from an owner/director/manager seat, with the numbers the AI
council and GCD Pal quote being *the same numbers on the screen*.

Goal: **one page where any of those three roles can answer their own question in
under a minute**, and GCD Pal can answer it in one sentence with a citation.

## 1. Principles (inherited from the hub)

- **Read-only.** This layer never writes to QBO. Same rule as Projections (§8 of
  the handoff).
- **One normalization layer, two consumers.** The page and GCD Pal read the *same*
  normalized snapshot, so the assistant can never quote a figure the page doesn't
  show. This is the single most important design constraint.
- **Pure core.** Statement shaping/subtotal math lives in `src/lib/finreports/`
  with no Prisma/Next/network imports, unit-tested like `lib/projections/reports`.
- **Cached, not live-hammered.** Reuse the `getReportSnapshot` fetch-through cache
  pattern; a page load must not fan out 8 uncached QBO report calls.
- **Every figure is traceable.** Each statement line shows its QBO account(s) and
  can drill to the transactions behind it — the "why is rent up $1,200" path.

## 2. Shape: one module, departmental tabs

One module at `/financial-reports`, with a tab per **business function** — so each
role opens the hub, clicks their own tab, and sees only reports written for their
job. Every report lives in exactly one tab (no duplicates), and each tab states
who it's for.

| Tab | Audience | What it answers |
|---|---|---|
| **Accounting** | Bookkeeper, CPA, owner | Are the books right and closeable? |
| **Executive** | Owner, director | Are we making money, and is it improving? |
| **Operations** | Service manager | Are the bays and techs producing? |
| **Sales & Customers** | Owner, service manager | Where is revenue coming from, and is it repeat? |
| **Parts & Purchasing** | Parts manager | Are we buying well and holding margin? |
| **Labor & Payroll** | Owner, service manager | Is labor earning its cost? |
| **Cash & Banking** | Owner, bookkeeper | What's in the bank, what's owed, what's coming? |
| **Tax & Compliance** | Owner, CPA | What do we owe and to whom? |

### Accounting
P&L · Balance Sheet · Statement of Cash Flows · P&L Detail (drill-down) ·
Trial Balance · General Ledger · **Month-end close pack** (one click → the closed
month's statements + agings) · journal/audit trail.

### Executive
Owner scorecard (revenue, GP, net margin, ARO, car count, cash days on hand,
breakeven revenue) · 12-month P&L trend · period-over-period variance callouts
("Building Rent +$1,200 vs prior") · **gross-margin bridge** — reconciles QBO's
gross margin to Tekmetric's labor-loaded margin, which today read 72.3% vs 60.9%
on two different pages with nothing explaining the gap.

### Operations
ARO · car count / RO count · technician productivity · advisor performance ·
revenue by make · repeat visits · effective vs posted labor rate · bay//day
throughput. Sourced from the existing Tekmetric snapshot — **linked, not
duplicated** (the Tekmetric Operations module stays the system of record; this tab
is the financial framing of it).

### Sales & Customers
Revenue by customer · customer concentration (top-10 share) · new vs returning ·
revenue by service/item · discounts given (and as % of sales) · average ticket
trend · warranty/comeback revenue if identifiable.

### Parts & Purchasing
Parts sales vs parts cost → **parts margin** · top vendors by spend
(`VendorExpenses`) · sublet spend · purchase mix by vendor · inventory valuation
*(only if inventory is tracked in QBO)*.

### Labor & Payroll
Labor sales vs real labor cost (QBO payroll ledger) → **labor margin** · effective
labor rate · billed hours vs paid hours · payroll as % of revenue · overtime
exposure. This tab is where the labor-cost figure the Tekmetric page subtracts
(~$23.4K in July) becomes visible and auditable.

### Cash & Banking
Cash position by account · A/R aging · A/P aging · deposits in flight (ties to
Deposit Reconciliation) · checks written (ties to Check Reception) ·
**13-week rolling cash outlook** (opening cash + A/R due + A/P due + fixed costs +
payroll cadence).

### Tax & Compliance
Sales tax collected vs owed · battery/tire tax (a real TEK line item) · 1099
vendor totals · licenses & fees. GCD already has a dedicated Chase Sales Tax
account, so this reconciles collected-vs-remitted.

## 3. Accounting basis — per-report defaults, always toggleable

Default per report to how that report is normally read, with a visible toggle and
the active basis **always labeled on screen and in every export**:

| Report | Default | Why |
|---|---|---|
| P&L, P&L Detail, P&L trend | **Cash** | How the owner reads performance (and how a shop typically files). |
| Sales by customer / item | **Cash** | Must tie to the P&L revenue shown beside it. |
| Statement of Cash Flows | **Cash** | Cash movement by nature. |
| Balance Sheet, Trial Balance, General Ledger | **Accrual** | The books; A/R and A/P only exist on accrual. |
| A/R & A/P aging | n/a | Point-in-time; QBO takes no basis for these. |

⚠️ **Cross-page consistency to flag on screen:** Projections → Reporting defaults
to **accrual** (July revenue $233,900.96). A cash-basis P&L for the same month will
show a *different* number, and that is correct, not a bug. Both pages must state
their basis prominently, and the Executive tab should note which basis its
scorecard uses.

## 4. QBO Classes — what they are, and how we'll answer it

A **class** in QuickBooks is an optional tag you can put on each transaction line
to split one company's books into segments — e.g. tagging every RO line as
`Service`, `Parts`, or `Towing` — so QBO can produce a P&L *per segment* ("P&L by
Class") without needing separate companies. It's how a shop would answer "is my
sublet/towing line actually profitable?"

You don't need to know whether GCD uses them: **Phase 1 includes a capability
probe** that asks QBO directly (query the `Class` entity; likewise `Budget` for
Budget-vs-Actual, and `Item` types for inventory). The result is cached, and the
module then shows the class/budget/inventory reports **only if the data exists** —
so no empty tabs and no question you have to research.

## 5. Phases

Each phase ends with something usable. **GCD Pal access is architectural, not a
phase:** every report registers itself in one shared catalog that drives the page
tabs *and* the assistant's tools, so each report added becomes AI-answerable for
free, reading the same cached snapshot the page renders.

### Phase 1 — Data layer + capability probe *(no UI)*
Add QBO entities: `CashFlow`, `ProfitAndLossDetail`, `TrialBalance`,
`GeneralLedger`, `VendorExpenses` (+ `ClassSales`, `BudgetVsActuals`,
`InventoryValuationSummary` behind the probe). Pure normalizers → one common shape:
```
Statement     = { key, title, period, comparison?, basis, lines, totals, fetchedAt }
StatementLine = { label, depth, kind: 'section'|'detail'|'subtotal'|'total',
                  accountIds?, value, priorValue?, pctOfRevenue? }
```
Cache through `getReportSnapshot`. Capability probe for classes/budgets/inventory.
**Exit:** tests prove every subtotal equals the sum of its children and each
statement total matches QBO's own total row (deposit-checksum discipline).

### Phase 2 — Module shell + report registry + **Accounting** tab
Register the module (`financial-reports`, `fin_`, group **Finance**, permission
`view_financial_reports`). Build the tab framework, the shared filter bar (period,
compare, basis toggle), and the **hierarchical statement renderer** (collapsible,
subtotal-aware, compare column, % of revenue, CSV export). Ship P&L, Balance
Sheet, Cash Flow, P&L Detail, Trial Balance. **The report registry is live here, so
GCD Pal can answer statement questions from day one.**
**Exit:** all three statements tie to QBO to the penny for a chosen month, and GCD
Pal answers "what was net income last month" citing the P&L.

### Phase 3 — **Executive** + **Cash & Banking** tabs
Owner scorecard, 12-month trend, variance callouts, the gross-margin bridge; cash
position, agings, deposits/checks in flight, 13-week cash outlook.
**Exit:** every scorecard number is click-through traceable to a statement line.

### Phase 4 — **Operations**, **Sales & Customers**, **Parts & Purchasing**, **Labor & Payroll** tabs
Mostly composition over existing data (Tekmetric snapshot + sales/vendor reports +
payroll labor cost). Labor tab makes the subtracted labor cost auditable.
**Exit:** parts margin and labor margin reconcile to the P&L's COGS section.

### Phase 5 — **Tax & Compliance**, exports, distribution
Sales-tax reconciliation, 1099 totals; PDF close pack; scheduled monthly email
(reuse Render cron + SendGrid); saved views. Feed statements into the AI council's
monthly context (it currently gets KPIs and charts, not the statements).

## 6. Access control

New permission **`view_financial_reports`**. Proposed grants:
- `owner_admin` — every tab.
- `reviewer` — Accounting, Executive, Operations, Sales, Parts, Labor, Cash,
  Tax (read-only; same as owner minus any future admin action).
- `coworker` — no access.

If a manager should ever be excluded from equity/Balance-Sheet detail, that's a
second permission (`view_balance_sheet`) gating just the Accounting tab's
balance-sheet/TB/GL reports — deferred until you say a manager needs a login.

## 7. Explicitly out of scope

- Any QBO **write** (no journal entries, adjustments, or reclassing).
- Replacing the CPA's close process — this reports, it doesn't book.
- Tax provision / filing forms.
