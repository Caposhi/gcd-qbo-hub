# GCD Hub — Build Progress

Running log of what shipped, phase by phase. See `docs/HUB_HANDOFF.md` for the
overall map and locked decisions.

---

## Phase 1 — QBO Reports data layer + interactive Reporting page ✅

**Status:** complete. `npm run typecheck` and `npm run test` pass (175 tests,
37 new); `npm run build` compiles.

### What shipped

An interactive, read-only **Reporting** tab on `/projections` that reads live
QuickBooks Online actuals and presents them the way the bookkeeper's monthly PDF
did, but interactive: each KPI shows its period-over-period **% and $ delta**
beside the figure, coloured good/bad, and every number recomputes from the
active filters. The original manual-assumption cash-flow prototype is preserved
under a **Scenarios** sub-tab (`/projections?tab=scenarios`) — nothing regressed.

Filters (URL search params, QBO-style): date-range presets (This Month, Last
Month, This Quarter, YTD, Trailing 12, Custom), comparison toggle (prior period /
prior year), accounting method (accrual / cash), and trend granularity
(month / quarter / year).

KPI tiles: Total Revenue, Gross Profit, Gross Margin %, Net Income, Net Margin %,
Operating Expenses, A/R total, A/P total, Cash position.

Charts (interactive Recharts client islands, drill-down on click):
- Revenue & Net Income trend (one dollar axis — no dual-axis).
- Revenue by Service/Product (ItemSales) — click a bar for its share.
- Revenue by Customer, top N (CustomerSales) — click a bar for its share.
- Operating-expense breakdown (P&L expense accounts).
- A/R and A/P aging by bucket — click a bucket to drill into which
  customers/vendors sit in it.

### Key files

| Path | Role |
|---|---|
| `src/lib/qbo/reports.ts` | **Read-only** QBO Reports client (P&L, BalanceSheet, AgedReceivables, AgedPayables, CustomerSales, ItemSales). Reuses the existing OAuth/auto-refresh, base-URL-per-env, minorversion 70, and `QboNotConnectedError`. Never posts/edits/deletes. |
| `src/lib/qbo/client.ts` | Added a `get()` helper (mirrors `post()`) for report GETs. |
| `src/lib/projections/reports/qbo.ts` | **Pure** parser: QBO's nested report envelope → flat, typed, position-addressable rows. |
| `src/lib/projections/reports/ranges.ts` | **Pure** date-range presets + comparison-period math (`now` passed in). |
| `src/lib/projections/reports/normalize.ts` | **Pure** per-report normalizers → typed metric series. |
| `src/lib/projections/reports/metrics.ts` | **Pure** deltas (with good/bad polarity) + KPI derivation. |
| `src/lib/projections/reports/rollup.ts` | **Pure** month → quarter → year roll-up. |
| `src/lib/projections/reports/snapshot.ts` | **Pure** stored-JSON validation (mirrors `parseAssumptions`). |
| `src/lib/projections/report-service.ts` | IO seam: fetch-through-cache over `proj_report_snapshot`, and `loadReporting()` which assembles the whole page from the filters. |
| `src/app/projections/page.tsx` | Tab router (Reporting default + Scenarios). |
| `src/app/projections/reporting/*` | `ReportingPanel` (server), `FilterBar` + `Charts` (client islands), `format.ts`. |
| `src/app/projections/ScenariosPanel.tsx` | The preserved prototype. |
| `src/app/projections/actions.ts` | Added `refreshReportSnapshotsAction` (gated by `view_projections`). |
| `prisma/schema.prisma` + `prisma/migrations/00000000000007_proj_report_snapshot/` | `ProjReportSnapshot` model + table. |
| `tests/reports.test.ts`, `tests/report-fixtures.ts` | Vitest coverage against captured-shape QBO payloads. |

### Architecture notes

- **Read-only, always.** `reports.ts` only issues `GET /reports/*`. The reporting
  layer never touches Cash Sheet Sync's posting logic or the live-env gating.
- **Pure engines stay pure.** All parsing/delta/KPI/rollup/validation math is
  IO-free and unit-tested; Prisma and `fetch` live only in `report-service.ts`.
- **Snapshots** cache the *normalized* series (never raw QBO), keyed by
  `reportType + periodStart + periodEnd + method`. P&L is always fetched
  `summarize_column_by=Month`, so a single snapshot powers both the trend chart
  and (by summing periods) the KPI totals — no key collision.
- **Validate on read:** `parseReportPayload` coerces every stored blob, so a
  malformed snapshot can't crash the page.
- **Config chosen for Phase 1:** live QBO (read-only), on-demand cache refresh
  (6h TTL + gated manual refresh; no cron changes), ops cuts (make/tech/advisor)
  deferred to Tekmetric, PDF used as reference (KPI tiles + charts led first).

### How to refresh snapshots

- **Automatic:** first page load for a (range, method) with no snapshot — or one
  older than `SNAPSHOT_TTL_MS` (6h) — fetches live from QBO and caches.
- **Manual:** the "↻ Refresh from QuickBooks" button on the Reporting tab
  (server action `refreshReportSnapshotsAction`, gated by `view_projections`)
  force-refetches the active filters.
- **Stale-on-error:** if QBO is briefly unreachable, a cached snapshot is served
  rather than erroring; only a total miss (no cache) surfaces the not-connected
  notice.

### Open questions carried into Phase 2

1. **Statement of Cash Flows & Top-10-Vendors-by-Spend** — two sections from the
   bookkeeper PDF that fall outside the six locked report endpoints. Add a
   `CashFlow` report + a Purchases-by-Vendor report to the client, or leave them
   to the AI layer?
2. **Snapshot retention/versioning** — the table keeps one row per
   (type,range,method). Phase 3's monthly AI baseline may want immutable,
   dated snapshots (keep history) rather than upsert-in-place.
3. **KPI polarity edge cases:** A/R is currently "lower is better." If the owner
   reads a growing receivables balance as growth, we may want it configurable.

---

## Phase 2 — Projections engine v2 (hybrid) + scenario library ✅

**Status:** complete. `npm run typecheck` and `npm run test` pass (192 tests,
17 new); `npm run build` compiles.

### What shipped

A new **Projections** tab on `/projections` (third tab, between Reporting and
the preserved v1 Scenarios prototype) implementing the locked **hybrid** method:
baseline coefficients are **derived from our own QBO history by auditable OLS
regression**, shown as **editable defaults with a confidence signal (R² + sample
size)**, and the user can **override any of them** — every scenario persists both
the derived values and the overrides (no black boxes).

- **Derived baseline** card: revenue growth/mo, COGS % of revenue, fixed OpEx/mo,
  variable OpEx %, each with a strong/moderate/weak confidence badge, its R² and
  n, and a plain-language basis. Plus gross/net margin and the parts-vs-labor
  revenue split (from Item Sales).
- **Scenario library**: QBO-derivable templates ship now — cash-flow **runway**,
  revenue **growth**, **margin mix**, **expansion/capacity**, **hiring/firing**,
  **succession buy-in**. Tekmetric-gated cuts (per-technician, per-bay,
  per-advisor, per-make, utilization, warranty comeback) are declared and shown
  as "coming in Phase 4" rather than silently missing.
- **Forward projection**: revenue → COGS → gross profit → OpEx → net income →
  cash, month by month, with levers for a capex one-off, a recurring OpEx change
  (hiring/firing), and a recurring revenue uplift (expansion). Summary tiles for
  ending cash, lowest cash, **cash-out month (runway)**, and total net income.
- **Sensitivity / tornado**: ranks which single driver swings ending cash the
  most (±10% each), so the owner sees what to watch.
- Charts: projection (Net Income bars + Ending Cash line, zero reference) and the
  tornado, as Recharts client islands on the same validated palette.

### Key files

| Path | Role |
|---|---|
| `src/lib/projections/regression/ols.ts` | **Pure** OLS linear regression (slope/intercept/R²/n) + confidence band. |
| `src/lib/projections/regression/baseline.ts` | **Pure** derivation of coefficients from monthly history, each with evidence + basis. |
| `src/lib/projections/engine-v2.ts` | **Pure** hybrid engine: `{derived, override}` coefficients, `projectFinancials`, `summarizeV2` (runway), `tornado`. |
| `src/lib/projections/scenario.ts` | **Pure** stored-scenario validation (`parseScenarioV2`, v1/v2 discriminator) + `inputsFromBaseline`. |
| `src/lib/projections/scenarios.ts` | Scenario library registry (available vs. `needs_tekmetric`). |
| `src/lib/projections/baseline-service.ts` | IO seam: trailing-N-month QBO history → pure derivation; parts/labor split. |
| `src/app/projections/v2/*` | `ProjectionsPanel` (server) + `ProjectionCharts` (client islands). |
| `src/app/projections/actions.ts` | `createScenarioV2Action` / `updateScenarioV2Action` (gated by `edit_projections`). |
| `tests/projections-v2.test.ts` | 17 cases: regression, derivation, engine, runway, tornado, scenario validation, library. |

### Architecture notes

- **Auditable, not a black box.** Every derived default carries the fit behind it
  (R², n, basis text). Regression degrades safely (n<2 or zero variance → flat
  mean, never NaN), so a default is always finite and usable.
- **Pure core.** All regression / derivation / projection / sensitivity math is
  IO-free and unit-tested; QBO fetch lives only in `baseline-service.ts`, reusing
  the Phase 1 read-only reports cache. Nothing writes to QBO.
- **Backward compatible.** v2 scenarios are tagged `version: 2`; the v1 prototype
  blobs and the v1 engine/tab are untouched. `parseScenarioV2` preserves a
  literal `override: 0` (not treated as "unset").
- **QBO-only for now.** Coefficients come from P&L history; the parts/labor split
  uses an Item-Sales name heuristic (labor if name matches labor/service/repair…).
  Per-tech/bay/advisor/make stay deferred to Tekmetric (Phase 4).

### Open questions for Phase 3 (AI C-suite)

1. **Baseline reuse.** The monthly AI job should read the same derived baseline +
   report snapshots as its shared context — confirm the cache is the single
   source (and settle the snapshot-versioning question above so the AI reads a
   stable, dated baseline).
2. **Parts/labor classification.** The name heuristic is a stopgap; a mapping
   table (like Cash Sheet Sync's payee→category learning) would be more accurate
   before the CFO/Controller agents lean on the margin-mix numbers.
3. **Which scenarios the C-suite runs.** Should the monthly board report include
   a standard runway + tornado on the derived baseline, or only scenarios the
   owner has saved?
4. **Cash-flow fidelity.** The engine approximates operating cash flow as net
   income (no working-capital timing). If the AI is going to reason about the
   build-out cash crunch, decide whether Phase 3 needs A/R & A/P timing folded in.
