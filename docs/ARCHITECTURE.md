# Architecture

Verified against the repository on 2026-08-10.

## Runtime ownership

The repository root is one Next.js 14 App Router application. `src/app` owns pages, route handlers, and server actions; `src/lib` owns domain and integration logic; `prisma/schema.prisma` and `prisma/migrations` define PostgreSQL state. Render declares one web process and two HTTP-triggering cron processes. There is no worker runtime or durable job queue.

The module registry in `src/lib/modules/registry.ts` is the authority for navigation and lifecycle labels. Cash Sheet Sync is `live`; Financial Projections, AI Report Assistant, Coworker Portal, Deposit Reconciliation, Check Reception, and Tekmetric Operations are `prototype`. Financial-report snapshot/capability code exists without a registered route and is incomplete as a user-facing module.

## Lifecycle and component flow

1. The Next.js process handles human sessions, server-rendered pages, server actions, API routes, cron calls, and Arcade bridge calls.
2. NextAuth stores users, linked accounts, sessions, and verification tokens in PostgreSQL.
3. Domain services read/write PostgreSQL with Prisma and call external APIs directly during a request or server action.
4. Cron services make authenticated HTTP POSTs to the web service; they do not execute sync logic locally.
5. Console events are held in an in-memory 1,000-event ring buffer. They are not durable or replica-consistent.

## Principal data flows

### Cash Sheet Sync

Google Sheets → parse/normalize → `SheetRow` and `RowEvent` audit state → QBO matching and mappings → operator review/approval → QBO create call → `QboTransaction` and updated row state → SendGrid alerts/summaries. Posted transactions are not automatically edited or deleted; subsequent source mutations become alerts and reconciliation work.

### Reporting, projections, and AI

QBO report APIs, cached `FinReportSnapshot` data, Tekmetric monthly snapshots, transcript aggregates, and user scenarios feed projections. Assistant and AI-council flows send scoped context to Anthropic, enforce permissions and a per-run budget in code, and persist conversations, runs, reports, and board reports.

### Coworker Portal

A configured QBO chart-of-accounts source is read into questions. Authenticated staff/coworkers persist questions and answers in PostgreSQL; notification email is an outbound side effect.

### Deposit Reconciliation and Check Reception

Imported payout/check data is normalized, reviewed, mapped, and persisted with domain events. Authorized actions can create QBO Deposit or Check objects and store returned IDs. Prototype status is a UI lifecycle label, not a write-safety boundary.

### Tekmetric and transcripts

Tekmetric API reads are cached by month, can be backfilled, and support audited owner overrides. The transcript service returns aggregated monthly insights; raw utterances are not expected to be stored by this app.

## Trust boundaries

- Human trust: NextAuth magic links plus role/permission checks.
- QBO trust: OAuth callback/state, encrypted refresh/access tokens, rollout stage, mappings, approvals, and idempotency records.
- Machine trust: distinct bearer secrets for Render cron and Arcade. Arcade uses one synthetic identity rather than end-user delegation.
- Console trust: manifest is public; state/stream are conditionally protected and fail open when their token is empty.
- Data trust: Google, QBO, Tekmetric, transcript, and AI responses are external input and must be parsed/validated before persistence or display.

## Invariants

- Do not auto-edit or auto-delete a previously created QBO transaction.
- A QBO write must have a server-side permission check, identified environment, and domain-specific idempotency/audit record.
- `APP_ENCRYPTION_KEY` must remain stable while encrypted QBO credentials exist; losing it makes stored tokens unreadable.
- Prisma migrations are the authoritative database evolution history.
- Shared secrets and service-account JSON never enter browser bundles, documentation, fixtures, or logs.
- Historical documents are context only and cannot override current source or runbooks.
