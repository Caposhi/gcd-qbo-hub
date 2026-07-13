# Tekmetric Integration — Progress (Build Phase 4 groundwork, Session B)

Read-only Tekmetric shop-management integration for the GCD QBO Hub. This is
**Phase T1**: the data layer + a standalone Operations page. Wiring into the
projections engine and the AI C-suite is a **later, coordinated step** (after
Phase 3 lands) — deliberately not done here (parallel-work safety protocol,
HUB_HANDOFF §10).

## Status: T1 complete (tested)

- `npm run typecheck` — clean.
- `npm run test` — 159 passing (21 new Tekmetric tests).
- `npx next build` — compiles; `/tekmetric` builds as a dynamic route.

## What shipped

1. **Interface contract** — `src/lib/tekmetric/types.ts`. The normalized shapes
   the rest of the hub consumes (`TekRepairOrder`, `TekJob`, `TekTechnician`,
   `TekServiceAdvisor`, `TekVehicle`, `TekAppointment`, the derived
   `TekTechUtilization` / `TekRevenueByMake` / `TekAdvisorPerformance`, plus
   `TekKpiSummary` and the `TekOperationsData` container). Committed first so the
   Phase 3 session can code its COO/CRO/CDA agents against it.
2. **Read-only API client** — `src/lib/tekmetric/client.ts`. Client-credentials
   token exchange (HTTP Basic → bearer, cached in memory, never persisted or
   logged), Spring-style pagination (`fetchAll`), 429/5xx exponential backoff
   with jitter (cap 60s), sandbox/production base-URL toggle. Only ever issues
   GETs (+ the one token POST). Raw response types live in
   `src/lib/tekmetric/raw.ts` and never leak past normalize.
3. **Pure normalization + metrics** — `src/lib/tekmetric/normalize.ts` (no IO,
   Vitest-tested). Maps raw cents → dollar shapes and computes gross profit per
   RO/job, technician utilization (billed vs. available hours, effective vs.
   posted labor rate with proportional discount allocation), revenue by make,
   advisor performance, and the KPI summary with prior-period deltas.
4. **Pure period helpers** — `src/lib/tekmetric/periods.ts` (tested). Date
   presets + prior-period / prior-year comparison ranges.
5. **Fetch-through cache** — `src/lib/tekmetric/snapshot.ts` + `tek_snapshot`
   Prisma model (`tek_` prefix). Stores **normalized** `TekOperationsData` keyed
   by `(entity, periodStart, periodEnd)`. Reads are validated/coerced by
   `parseOperationsData` (mirrors `parseAssumptions`) so a corrupt row degrades
   to safe empties, never a crash. The page reads the cache (no network); the
   refresh path is the only mutation.
6. **Standalone Operations page** — `/tekmetric` (`src/app/tekmetric/`).
   House-format KPI tiles (figure + up/down % and $/unit delta) for car count,
   RO count, ARO, gross profit, and gross margin %; interactive Recharts client
   island (`charts.tsx`) for tech utilization, revenue by make, advisor
   performance; a QBO-style filter bar (date preset + comparison mode); an
   advisor table; and a permission-gated Refresh button. Registered in the
   module registry.

## Key files

| Area | File |
|---|---|
| Types (contract) | `src/lib/tekmetric/types.ts` |
| Raw wire types | `src/lib/tekmetric/raw.ts` |
| API client | `src/lib/tekmetric/client.ts` |
| Normalize + metrics | `src/lib/tekmetric/normalize.ts` |
| Period helpers | `src/lib/tekmetric/periods.ts` |
| Cache + refresh | `src/lib/tekmetric/snapshot.ts` |
| Page / charts / action | `src/app/tekmetric/{page,charts,actions}.tsx` |
| Tests | `tests/tekmetric-normalize.test.ts`, `tests/tekmetric-periods.test.ts` |
| Schema + migration | `prisma/schema.prisma`, `prisma/migrations/00000000000009_tek_snapshot/` |

Shared files touched (append-only, per protocol): `src/lib/auth/roles.ts`
(`view_tekmetric`, `refresh_tekmetric`), `src/lib/modules/registry.ts` (module
entry), `prisma/schema.prisma` (new `TekSnapshot` model), `.env.example`.

## Env vars

Reuses the exact var names the sibling GCD Tekmetric project already runs with,
so the values that work there work here.

| Var | Purpose |
|---|---|
| `TEKMETRIC_BASE_URL` | `https://shop.tekmetric.com` (production) or `https://sandbox.tekmetric.com` (test). |
| `TEKMETRIC_TOKEN` | Pre-provisioned, long-lived bearer access token. Read from env, sent as `Authorization: Bearer …`, never persisted or logged. |
| `TEKMETRIC_SHOP_ID` | The shop to pull (e.g. `3933`). |

Auth model: the token is already provisioned (Tekmetric docs: an access token
"will continue to be valid until it is revoked"), so no client-credentials
exchange happens in-app — the bearer token is used directly. Rate limits:
600 req/min production, 300 sandbox; the client backs off on 429/5xx.

**No other env vars are required by this module.** It also reads `DATABASE_URL`
(already set) for the `tek_snapshot` cache. It does NOT use `ANTHROPIC_API_KEY`
— that belongs to the assistant / Phase 3 AI work, not the Tekmetric data layer.

## How to refresh

The Operations page reads only the cache. To populate/update it:

1. Sign in as `owner_admin` (holds `refresh_tekmetric`).
2. Go to `/tekmetric`, pick a **Period** and **Compare** mode, click **Apply**.
3. Click **↻ Refresh from Tekmetric**. The gated server action
   (`refreshTekmetricAction`) pulls live data across all in-scope shops, builds
   the normalized dataset, and upserts the `tek_snapshot` row for that period.

Reviewers can view whatever was last refreshed but cannot trigger a refresh.

## Metric definitions (so the AI officers read them identically)

- **Revenue** = pre-tax, post-discount (`totalSales − taxes`).
- **Gross profit** = revenue − parts cost − sublet cost. Labor carries no COGS
  in the API (tech wages aren't exposed), so labor is treated as full margin.
  RO GP = `(totalSales − taxes) − partsCost − subletCost`; Job GP =
  `subtotal − jobPartsCost`.
- **ARO** = revenue ÷ RO count. **Gross margin %** = GP ÷ revenue.
- **Car count** = distinct vehicles on counted ROs.
- **Tech utilization** = billed hours ÷ available hours
  (business days × `dailyCapacityHours`, default 8).
- **Effective labor rate** = realized labor $ (after proportional RO-discount
  allocation) ÷ billed hours; **posted labor rate** = hours-weighted ticket
  rate from job labor lines.
- ROs are pulled by **posted date**; deleted/void ROs are excluded everywhere.

## Assumptions taken (confirm / override any time)

The API docs answered auth, environments, rate limits, and pagination. Two
choices weren't explicitly picked, so I used the recommended defaults:

1. **Backfill window: trailing ~24 months.** Not yet wired into an automatic
   backfill job — refresh is per-period on demand for now. Say the word to add a
   backfill script (e.g. month-by-month snapshots) and I'll set the window.
2. **Scope: standalone `/tekmetric` only; projections/AI wiring deferred.**
   Matches the locked decision and the parallel-work protocol.

## Open questions / next steps

- **Migration (rebased onto merged Phases 1-3):** this branch was restarted from
  the latest `main` after Phases 1-3 and the `types.ts` contract (PR #36) merged.
  Phase 1 added `00000000000007_proj_report_snapshot` and Phase 3 added
  `00000000000008_ai_council`, so the Tekmetric migration was renumbered to
  `00000000000009_tek_snapshot` — no number collision remains. No DB was reachable
  here, so the migration SQL is hand-authored to match the repo's numbered
  convention and `prisma generate` was run offline; run `prisma migrate deploy`
  (or `migrate dev`) once against the shared DB to apply it.
- **Backfill job:** decide the final window (24/36 months / ~7yr) and whether to
  snapshot per-month so trend charts have history.
- **Cron refresh:** a daily/periodic refresh could keep the cache warm — but the
  monthly cron route is owned by the Phase 3 session, so this must be
  coordinated, not added here.
- **Vehicle mileage:** the Vehicle endpoint carries no odometer; RO
  `milesOut` holds it. `TekVehicle.mileage` is currently null — populate from the
  latest RO per vehicle if mileage-based metrics are wanted.
- **Appointment cycle time:** Tekmetric exposes only an `arrived` boolean (no
  arrival timestamp) and no RO link on appointments, so `arrivedAt`/`roId` are
  null. Cycle time, if needed, should be derived from RO `createdDate → postedDate`.
