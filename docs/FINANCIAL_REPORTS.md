# Financial Reports — build scope & phases

Status: **scoped, not started**
Proposed module id: `financial-reports` · table prefix: `fin_` · base path: `/financial-reports`

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

## 2. Report catalog (what to build, by audience)

### Tier 1 — the statements (must-have)
| Report | QBO entity | Why it matters here |
|---|---|---|
| **Profit & Loss** | `ProfitAndLoss` | Monthly performance; needs **% of revenue** column + prior-period/prior-year compare. |
| **Balance Sheet** | `BalanceSheet` | Cash, A/R, A/P, loans, equity at a point in time. |
| **Statement of Cash Flows** | `CashFlow` | The one owners actually feel — operating vs investing vs financing. **Not currently pulled at all.** |
| **P&L Detail** | `ProfitAndLossDetail` | The drill-down target: every transaction behind a P&L line. |
| **A/R & A/P Aging** | `AgedReceivables` / `AgedPayables` | Already pulled — surface here as first-class reports. |

### Tier 2 — the operating lens (high value for GCD specifically)
| Report | Source | Why |
|---|---|---|
| **P&L by month (trend)** | `ProfitAndLoss` + `summarize_column_by=Month` | 12-month strip: spot creep in any expense line. |
| **Expense by vendor** | `VendorExpenses` | Who we actually pay — pairs with Check Reception. |
| **Sales by customer / item** | `CustomerSales` / `ItemSales` | Already pulled (revenue mix). |
| **Gross-margin bridge** | derived: P&L + Tekmetric labor cost | Reconciles QBO gross margin (72.3%) to Tekmetric's labor-loaded margin (60.9%) — **the two pages currently disagree by design and nothing explains it.** |
| **Owner scorecard** | derived | ARO, car count, effective labor rate, GP/RO, revenue per bay, breakeven revenue, **cash days on hand**. |

### Tier 3 — accountant/close support
| Report | Source | Why |
|---|---|---|
| **Trial Balance** | `TrialBalance` | Hand-off to the CPA; ties the books. |
| **General Ledger** | `GeneralLedger` | Full audit trail for a period. |
| **Budget vs Actual** | `BudgetVsActuals` | Only if budgets exist in QBO — needs confirmation. |
| **Month-end close pack** | composite | One click → P&L + BS + Cash Flow + agings for the closed month. |

### Tier 4 — forward-looking (owner favorite)
- **13-week rolling cash outlook** — opening cash + A/R due + known A/P due +
  recurring fixed costs + payroll cadence. Bridges this module to Projections.

## 3. What already exists vs. what's new

**Reuse (don't rebuild):**
- `src/lib/qbo/reports.ts` — report fetcher + param builder (add entities).
- `src/lib/projections/reports/qbo.ts` — raw QBO report → flat typed rows.
- `normalize.ts` — P&L / BS / aging / sales normalizers, `pickMoneyColumnIndex`.
- `getReportSnapshot` — fetch-through cache; `ranges.ts` — presets + comparison
  (now calendar-month-correct).
- Recharts client-island pattern, `KpiTiles`, `FilterBar`.

**New:**
- `CashFlow`, `TrialBalance`, `GeneralLedger`, `ProfitAndLossDetail`,
  `VendorExpenses` entities + normalizers.
- A **statement renderer** — hierarchical, collapsible, subtotal-aware rows with
  a compare column and % of revenue. This is the main new UI primitive.
- Drill-down: statement line → transactions.
- Export (CSV per statement; PDF for the close pack).
- GCD Pal tools over the cached statements.

## 4. Phases (ship one at a time, each independently useful)

### Phase 1 — Statement data layer *(foundation, no UI)*
Extend the QBO report client with `CashFlow`, `ProfitAndLossDetail`,
`TrialBalance`, `GeneralLedger`, `VendorExpenses`. Write pure normalizers that
turn each into a common `Statement` shape:
```
Statement = { title, period, comparison?, method, lines: StatementLine[] }
StatementLine = { label, depth, kind: 'section'|'detail'|'subtotal'|'total',
                  accountIds?, value, priorValue?, pctOfRevenue? }
```
Cache via `getReportSnapshot`. **Exit criteria:** unit tests prove subtotals equal
the sum of their children and that each statement's total matches QBO's own total
row (the same discipline as the deposit checksum).

### Phase 2 — Financial Reports page *(the deliverable)*
Report catalog/landing (cards by tier) → statement viewer with: period presets +
custom range, compare (prior period / prior year / none), accrual↔cash toggle,
collapse/expand, **% of revenue**, variance highlighting, CSV export. Register the
module in `registry.ts` under **Finance**, gated `view_projections` (or a new
`view_financial_reports`). **Exit criteria:** P&L, Balance Sheet, and Cash Flow
render and tie to QBO to the penny for a chosen month.

### Phase 3 — Owner insight layer
Owner scorecard tiles, the **gross-margin bridge** (QBO vs Tekmetric-labor-loaded
— resolves the 72.3% vs 60.9% confusion), variance callouts ("Building Rent
+$1,200 vs prior"), month-end close pack, drill-down to transactions.
**Exit criteria:** every scorecard number is click-through traceable.

### Phase 4 — GCD Pal integration
New read-only tools over the **cached** statements, so the assistant answers from
the same snapshot the page shows:
- `get_financial_statement(type, period, method, compare)` — P&L / BS / Cash Flow.
- `get_statement_line_detail(type, period, accountOrLabel)` — the drill-down.
- `list_available_reports()` — so it can say what it can pull.
- `get_owner_scorecard(period)`.
Extend the system prompt with statement-reading rules: quote only from tool
results, always state period + accounting method, name the account, and say
"as of <snapshot time>". Also feed the statements into the AI council's monthly
context (it currently gets KPIs + charts, not the actual statements).
**Exit criteria:** ask GCD Pal "why did net income move last month" and it cites
real P&L lines with figures matching the page.

### Phase 5 — Distribution *(optional)*
Saved views, scheduled monthly email/PDF pack (reuse the Render cron + SendGrid
pattern), and role-scoped sharing for a manager who should see ops but not equity.

## 5. Open decisions (need your call before Phase 2)

1. **Audience gating** — should a *manager* see the full Balance Sheet and equity,
   or a restricted set (P&L + agings + ops)? This drives whether we add a new
   permission or reuse `view_projections`.
2. **Cash vs accrual default** — which basis do you think in day-to-day?
3. **Classes/departments** — does GCD use QBO classes (e.g. by service type)? If
   so, a class P&L is high value; if not, skip it.
4. **Budgets** — are there budgets in QBO to support Budget vs Actual?
5. **Placement** — its own `financial-reports` module (recommended: statements are
   a distinct job from projections), or a new tab inside Financial Projections?

## 6. Explicitly out of scope

- Any QBO **write** (no journal entries, no adjustments, no reclassing).
- Replacing the CPA's close process — this reports, it doesn't book.
- Tax provision / filing forms.
