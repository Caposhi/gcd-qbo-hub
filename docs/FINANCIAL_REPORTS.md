# Financial Reports

## Current implementation boundary

Source contains QBO report clients/transforms, `src/lib/finreports/` library code, and `FinReportSnapshot` / `FinCapability` persistence. Financial Projections already presents interactive reporting. However, there is no Financial Reports entry in `src/lib/modules/registry.ts` and no `/financial-reports` page. Therefore a standalone Financial Reports module is incomplete and this document is a boundary/roadmap, not a claim that a dedicated page is deployed.

Financial Projections' Reporting tab offers range presets This Week / Last Week (Monday–Sunday), This Month, Last Month, This Quarter, Year to Date, Trailing 12 and Custom (`src/lib/projections/reports/ranges.ts`). "Prior period" compares a week to the week before and a whole month to the prior calendar month. Custom dates must be real calendar dates between 1990 and 2100; anything else falls back to the current month. The date boxes reload only once a complete date is entered. Before this, a half-typed year ("0002-…") crashed the page on an invalid date (2026-10-10).

## Intended product boundary

Financial reporting should remain read-only over QBO. It may cache normalized report snapshots and capabilities in PostgreSQL, but must never create/edit/delete QBO objects. Period, accounting basis, report type, QBO environment/company, fetch time, and source identifiers must accompany every cached result so comparisons do not mix unlike data.

Potential views include performance overview, profit and loss, balance sheet, cash flow, receivables/payables, sales/customer concentration, parts/purchasing, and labor/payroll. Each metric must be traceable to a named QBO report/row or explicitly identified supplemental source.

## Invariants

- Never compare cash-basis and accrual-basis values as though they reconcile.
- Normalize QBO's nested row/column structures without losing source row identity.
- Label partial periods, stale caches, unavailable capabilities, and manual adjustments.
- Drill-down links must preserve period, basis, company/environment, and filters.
- AI narrative is commentary, not an accounting record; show source periods and generation time.
- Use fictional values in tests/docs; production financial amounts and customer/vendor rankings stay out of Git.

## Completion criteria

Before registering a standalone module, define navigation/permissions, decide overlap with Financial Projections, add route/page tests, document cache refresh/failure behavior, validate report ties across supported bases/periods in QBO sandbox, and update the root architecture/status. If the dedicated module is abandoned, remove unreachable capability/schema code through a reviewed migration rather than leaving ambiguous scaffolding.
