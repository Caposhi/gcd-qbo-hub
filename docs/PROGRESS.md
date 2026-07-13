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

### Open questions for Phase 2

1. **Statement of Cash Flows & Top-10-Vendors-by-Spend** — two sections from the
   bookkeeper PDF that fall outside the six locked report endpoints. Add a
   `CashFlow` report + a Purchases-by-Vendor report to the client, or leave them
   to the AI layer?
2. **Snapshot retention/versioning** — the table keeps one row per
   (type,range,method). Phase 3's monthly AI baseline may want immutable,
   dated snapshots (keep history) rather than upsert-in-place. Decide before the
   cron lands.
3. **Regression coefficients (Phase 2 core):** which driver→metric relationships
   to derive first (e.g. revenue→COGS, revenue→labor) and the minimum sample
   size / R² threshold below which we hide a derived default.
4. **Sandbox vs live for the cron:** the monthly AI job will read live; confirm
   the read-only reporting env stays `QBO_ENV=live` in production.
5. **KPI polarity edge cases:** A/R is currently "lower is better." If the owner
   reads a growing receivables balance as growth (not a collections problem),
   we may want it neutral or configurable.
