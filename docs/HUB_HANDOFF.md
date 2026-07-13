# GCD QBO Hub — Handoff & Projections Build Plan

> Drop this in `docs/HUB_HANDOFF.md`. It is the map a fresh Claude Code session
> reads first, so it starts with an accurate picture of the hub instead of a
> compacted chat history. Keep it updated as the build progresses.

---

## 1. What the hub is

German Car Depot's authenticated, multi-module dashboard for QuickBooks Online
automation, reporting, and portals. Business entity: **Alan Gelfand Inc DBA
German Car Depot**. It is a real accounting/audit system: it defaults to the
safest behavior (dry-run, sandbox) and never posts to live QuickBooks until an
owner deliberately advances every rollout stage. QBO transactions are never
auto-edited or auto-deleted.

## 2. Stack

- **Next.js 14 (App Router) + TypeScript** — shared shell, module routes, API routes.
- **Postgres + Prisma** — durable store. Module tables are namespaced by prefix
  (`css_`, `proj_`, `ai_`, `cwp_`, `dep_`, `chk_`) so modules never collide.
- **Render** — one web service + one Cron Job + managed Postgres (`render.yaml`).
  No Redis/queue.
- **QBO Accounting API (OAuth2)** — token auto-refresh, AES-256-GCM encryption at rest.
- **Anthropic SDK** — `claude-opus-4-8`, adaptive thinking. Existing assistant is read-only.
- **NextAuth** — email magic-link, restricted to `@germancardepot.com`.
- **Google Sheets API**, **SendGrid** — sheet ingestion and email alerts.
- **Vitest** — pure domain logic is unit-tested.

## 3. Conventions (follow these exactly — the whole codebase does)

- **Pure domain logic** lives in `src/lib/<module>/` with **no Prisma, Next, or
  network imports**, so business rules are unit-tested in isolation. An
  `engine.ts` orchestrates the pure rules plus the service clients.
- **Server actions** (`"use server"`) perform mutations and are **gated by role
  permission** via `requirePermission(...)` — never trust the client.
- **Roles/permissions** live in `src/lib/auth/roles.ts`. Add new permissions
  there; don't invent ad-hoc checks.
- **Module registry** (`src/lib/modules/registry.ts`) drives nav + route grouping
  + table prefixes. Register new modules here.
- **All stored JSON is validated/coerced** on read (see `parseAssumptions`) so a
  bad row can never crash a page.
- **QBO payloads are redacted** before persisting (never log tokens).

## 4. Where things live

```
src/app/
  page.tsx                 hub home (module grid)
  cash-sheet-sync/         live module — the bulk of the repo
  deposit-reconciliation/  build QBO deposits for Tekmetric/Paymentech payouts (prototype, live-tested)
  check-reception/         read Chase check PDFs → create QBO Checks (prototype)
  projections/             prototype we are expanding (page.tsx, actions.ts)
  assistant/               read-only AI report assistant (prototype)
  coworker-portal/         "Ask My Client" (prototype)
  api/
    cron/sync/             daily sync (Bearer CRON_SECRET) — model for new crons
    qbo/connect|callback/  QBO OAuth2 flow
    assistant/chat/        assistant endpoint
src/lib/
  qbo/                     OAuth client + Accounting API (create/query). NO Reports API yet.
  anthropic/assistant.ts   read-only tool pattern to mirror for the C-suite
  deposits/                pure payout reconstruction + QBO lookups (deposit recon)
  checks/                  pure check classify/match + Claude-vision read + QBO Check I/O
  projections/engine.ts    pure cash-flow engine (simple, manual assumptions)
  auth/                    NextAuth options, roles, session gating
  modules/registry.ts      module registry
prisma/schema.prisma       users, config, qbo creds + css_/proj_/ai_/cwp_/dep_/chk_ tables
```

## 5. Module status

| Module | Status | Notes |
|---|---|---|
| Cash Sheet Sync | live | Do not disturb its posting logic or live QBO env. |
| Deposit Reconciliation | prototype (live-tested) | `dep_`. Ingests Tekmetric/Chase Paymentech exports and builds the matching QBO Bank Deposit (single + month-end batch) so the bank feed auto-matches. Guardrails: exact-sum checksum, no double-post, over/short plug. |
| Check Reception | prototype | `chk_`. Drop a Chase check-image PDF → Claude vision reads each check → propose vendor + category (QBO-backed typeahead + learned payee→category mapping) → owner creates the QBO Check so the bank feed matches. Review-first; in live review with the owner. |
| Financial Projections | prototype → **expanding** | Today: a manual-assumption cash-flow engine + scenario form. This build turns it into the reporting + projections + AI C-suite hub below. |
| AI Report Assistant | prototype | Read-only tool pattern to reuse. |
| Coworker Portal | prototype | — |

## 6. The Projections build — locked decisions

- **Reporting data source:** live **QBO Reports API** (extend the existing OAuth
  client to Reports endpoints — P&L, Balance Sheet, A/R & A/P Aging, Sales by
  Customer/Product). ~7 years of history available.
- **Charts:** **Recharts** (client-island components under the RSC pages).
- **Projections method:** **hybrid** — baseline coefficients are *derived from
  history via auditable regression*, surfaced as *editable defaults* with a
  confidence signal (R², sample size), and the user can override any of them.
  Every scenario stores both derived defaults and overrides — no black boxes.
- **AI C-suite (structured JSON → progressive-disclosure UI):**
  - **Six officers** debate: CMO, CFO working session (**Pacman** CFO/CPA +
    **Cam** Controller/CMA), COO, Chief Data Analyst, CRO, and a **CEO** who
    synthesizes last.
  - **Independent layer:** **Al** (Chief Auditor) + **Board of Directors** are
    firewalled from the officer debate, see only the *finished* officer reports,
    and **confer with each other** before reporting straight to the user.
  - Personas for Pacman/Cam/Al come from the existing `gcd-cfo-team` definitions
    (embedded in the build prompt) so the hub and Cowork never disagree.
- **Cadence:** on-demand (single agent vs. cached baseline, pennies) + a
  **monthly Render cron on the 1st** that runs the full multi-round meeting and
  produces an end-of-month board report for the prior month.
- **Cost control:** prompt caching on the shared monthly data context + Batch API
  for parallel turns. **$15 hard cap per monthly run**, enforced as a token
  budget that stops adding debate rounds and forces CEO synthesis if approached.
  Expected spend $3–8/run.
- **Access:** portal is full-view users only — gate behind existing
  `view_projections` / owner_admin; no partial-view tier needed.

## 7. Build phases (ship one at a time — do not build all at once)

1. **QBO Reports data layer + Reporting page** — extend the QBO client to the
   Reports API; pure normalization layer; reporting page with "figure + up/down
   % + $ delta" KPI tiles, date-range + comparison-period filters (QBO-style),
   and interactive Recharts.
2. **Projections engine v2 (hybrid)** — regression-derived coefficients (pure,
   tested) + editable overrides; scenario library (see prompt for the full list).
3. **AI C-suite** — persona configs; orchestration engine (officer debate → CEO
   → Board+Al conference); monthly cron; token-budget circuit breaker;
   persistence tables; on-demand path; progressive-disclosure UI.
4. **Integrations (their "Phase 2")** — Tekmetric API + call-transcript service.
   Contracts stubbed earlier; wired here.

## 8. Do NOT

- Touch Cash Sheet Sync's posting logic or flip the live QBO environment.
- Give the reporting/projections/AI layer any QBO **write** access — it is
  **read-only** over Reports + the hub DB.
- Put business logic with IO in `engine.ts` files — keep them pure and tested.
- Skip role gating on any new server action.

## 9. Open item

The call-transcript service (separate Render web service, same owner) will feed
the CRO agent in Build Phase 4. Decision still needed before that phase: does it
already emit **structured** insights (sentiment, upsell flags, booking outcomes)
or only **raw transcripts + freeform analysis**? That determines whether Phase 4
builds a thin read endpoint or a small aggregation layer on the transcript side.
Connection pattern is settled: read-only versioned endpoint over Render private
networking with a bearer secret; the hub only ever sees aggregated insights.
