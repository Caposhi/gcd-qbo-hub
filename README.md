# GCD QBO Hub

German Car Depot's **QuickBooks Online hub** — a modular, authenticated dashboard
for QBO automations, reporting, and portals. It is built as a multi-module hub
from day one: the first module is **Cash Sheet Sync**, with **Financial
Projections**, an **AI Report Assistant**, and a **Coworker Portal** ("Ask My
Client") planned to slot in under the same shell later.

Business entity: **Alan Gelfand Inc DBA German Car Depot**.

> ⚠️ This is a real accounting automation and audit system. It defaults to the
> safest possible behavior (dry-run, sandbox) and **never** posts to live
> QuickBooks until an owner deliberately advances every rollout stage. QBO
> transactions are **never** auto-edited or auto-deleted.

---

## Stack

- **Next.js (App Router) + TypeScript** — shared shell, module routes, API routes.
- **Postgres + Prisma** — durable audit store (module tables namespaced `css_`).
- **Render** — one web service + one Cron Job + a managed Postgres (see
  `render.yaml`). No Redis/BullMQ — a daily sync doesn't need a job queue.
- **Google Sheets API** (service account) — sheet ingestion.
- **QBO Accounting API** (OAuth2) — direct expense/deposit/transfer creation.
- **SendGrid** — email alerts (the same proven pattern as `gcd-webhook`, not Gmail).
- **NextAuth / Auth.js** — email magic-link login restricted to `@germancardepot.com`.

## Architecture at a glance

```
src/
├── app/                       # Next.js App Router
│   ├── layout.tsx             # shared shell (nav from the module registry, auth)
│   ├── page.tsx               # hub home — module grid
│   ├── auth/                  # sign-in / verify / error pages
│   ├── api/
│   │   ├── auth/[...nextauth]  # NextAuth
│   │   ├── cron/sync           # protected daily sync (Bearer CRON_SECRET)
│   │   ├── qbo/connect|callback# QBO OAuth2 flow
│   │   └── health
│   ├── console/               # /console/manifest|state|stream (gcd-arcade contract)
│   └── cash-sheet-sync/       # THE first module (overview, queue, row detail, mappings, settings)
├── lib/
│   ├── modules/registry.ts    # module registry (nav + route grouping + table prefixes)
│   ├── auth/                  # NextAuth options, roles, session gating
│   ├── console/contract.ts    # /console/* manifest + state + SSE bus
│   ├── crypto.ts              # AES-256-GCM token encryption at rest
│   ├── db.ts                  # Prisma singleton
│   ├── config-store.ts        # DB config with audited change history
│   ├── google/sheets.ts       # service-account Sheets client (list tabs, read ranges, UUID metadata)
│   ├── qbo/                   # OAuth2 client + Accounting API + posting builders
│   ├── email/sendgrid.ts      # SendGrid sender
│   └── cashsheet/             # PURE domain logic (unit-tested, §20) + the sync engine
└── prisma/schema.prisma       # users, config, qbo_credentials + css_* module tables
```

The **pure domain logic** in `src/lib/cashsheet/*` (parsing, mapping, hashing,
duplicate/change/removal detection, rollout gating, role gating) has no DB or
network dependencies and is fully unit-tested with Vitest. The **engine**
(`engine.ts`) orchestrates a run using those pure rules plus the service clients.

## Why customer invoice cash is audit-only (read this)

`Amt Collected` rows with purpose **INV** are **audit-only by default** — the
automation **never** creates QBO income or a deposit for them. Customer invoice
cash is already recorded through Tekmetric/BackOffice and matched into QBO;
posting it again would **double-count revenue**. Instead the hub tries to find
and link the existing QBO record; if none is found it flags **"QBO Match Not
Found / Audit Only"** for review.

## Source-of-truth philosophy

QuickBooks is the accounting source of truth **once a transaction is posted**.
The Google Sheet is an employee intake worksheet. This dashboard is the control
and audit layer. After a row posts:

- If the sheet row is **edited**, it's flagged **Changed After Posting** (with a
  field-level diff) and a critical email goes to `michaelc@germancardepot.com`.
  QBO is not touched.
- If the posted row **disappears** from the sheet, it's flagged **Removed From
  Sheet After Posting** (a distinct signal — deleting instead of editing is a
  plausible way to hide a discrepancy) and the same alert fires. QBO is not
  touched.
- The DB preserves the original posted snapshot, current snapshot, diff,
  timestamps, QBO transaction id, and full event history — even after the row is
  edited or removed.

---

## Setup

### 1. Prerequisites

- Node 20+ and a Postgres database.
- A Google Cloud **service account** with the Sheets API enabled.
- The real **QuickBooks developer app** for this business (sandbox keys first).
- A **SendGrid** API key and a verified sender.

### 2. Install & configure

```bash
npm install
cp .env.example .env.local     # fill in the values (see .env.example comments)
npx prisma migrate dev         # create the schema
npm run db:seed                # seed purpose/account mappings + safe defaults
npm run dev                    # http://localhost:3000
```

Generate the required secrets:

```bash
openssl rand -hex 32   # APP_ENCRYPTION_KEY (encrypts QBO tokens at rest)
openssl rand -hex 32   # NEXTAUTH_SECRET
openssl rand -hex 32   # CRON_SECRET
```

### 3. Connect Google Sheets

1. Create a service account, download its JSON key.
2. Put the key in `GOOGLE_SERVICE_ACCOUNT_JSON` (single-line) or
   `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` (`base64 -w0 key.json`).
3. **Share the workbook** (`26 DC`) with the service account's email
   (`client_email`) — at least Viewer.
4. `GOOGLE_SHEET_ID` is already set to the GCD workbook
   (`1NGz6sOiJtKOOBZYpM5_0ODZxgHkSQRWYZQqufpotTWA`).

The ingestion service auto-detects each monthly tab's header row by matching the
expected column names (`Date`, `Rcv by or paid to`, `Name`, `Purpose`, `INV#`,
`Back up`, `Approved By`, `Amt Collected`, `Amount Paid Out`, `Bank Deposit`,
`Cash Balance In Envelope`) — it never assumes a fixed row number.

### 4. Set up the QBO app & OAuth redirect URI (sequence matters)

Because the redirect URI must be an **exact match** on a stable HTTPS URL:

1. **Deploy the hub first** (even as a skeleton) so you have a stable URL, e.g.
   `https://gcd-qbo-hub.onrender.com`.
2. In the **Intuit developer dashboard**, add the redirect URI
   `https://gcd-qbo-hub.onrender.com/api/qbo/callback` for the **sandbox** keys
   (and later the same path for production keys).
3. Set `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_REDIRECT_URI`, `QBO_ENV=sandbox`.
4. Sign in as the owner, go to **Cash Sheet Sync → Settings → Connect QBO**, and
   complete consent. Tokens are stored **encrypted** in `qbo_credentials`;
   refresh happens automatically before expiry.

If QBO isn't connected, the dashboard shows **"setup required"** and every sync
runs in validation/dry-run only — it never silently attempts to post.

### 5. Resolve account mappings

After connecting QBO, open **Mappings** and paste the real QBO **account IDs**
for each slot (Cash on hand, Chase Checking 9680, the COGS/expense/income
accounts, Employee Loans Receivable, …). Until an account is resolved, rows that
need it are flagged **Missing Account Mapping** rather than posted on a guessed
name.

---

## Running syncs & the rollout ladder

The system **never** defaults to unattended live posting. Advance one stage at a
time from **Settings** (owner_admin only; each change is audited):

1. **`dry_run`** — never touches QBO; shows exactly what would happen.
2. **`sandbox_manual`** — valid rows queue; an admin approves each before it
   posts to the QBO **sandbox**.
3. **`sandbox_auto`** — valid/mapped/non-duplicate rows post automatically to
   sandbox on each sync.
4. **`live_manual`** — same as stage 2 but against **live** QuickBooks.
5. **`live_auto`** — fully unattended live posting. Last rung, owner-only.

Per-purpose override: any mapping can set **requires manual approval** (e.g.
Employee Loans stay manual even after Bank Deposits auto-post).

The stage lives in the DB `config` table with a change history — flips are
auditable, not silent prod env edits. The code enforces one-step-at-a-time
advancement, so "jump straight to live_auto" is impossible.

### Manual actions

- **Run dry-run now** / **Run sync now** (overview).
- **Approve** a queued row (owner_admin) — it posts on the next gated sync.
- **Mark reviewed** (reviewer or owner_admin).
- **Recheck QBO match** for audit-only invoice rows.
- CLI: `npm run sync:dry-run` and `npm run sync:backfill` (prior-date preview).

### Scheduling

A Render **Cron Job** calls `POST /api/cron/sync` daily at end of business day
(default 19:00 America/New_York; the blueprint schedules `0 23 * * *` UTC) with
`Authorization: Bearer $CRON_SECRET`. The route reads mode/stage from config, so
the cron command never needs to know the stage. It runs every day including
weekends and keeps processing rows even if one errors.

---

## Auth & roles

Login is **required** (email magic-link, `@germancardepot.com` only). Roles:

| Role | Can |
|---|---|
| `owner_admin` | everything — approve postings, edit mappings, advance stage, toggle live, connect QBO, manage users |
| `reviewer` | view dashboards, run dry-runs, mark warnings reviewed. **Cannot** approve postings or change mappings/stage |
| `coworker` | reserved stub for the future "Ask My Client" portal — no cash-sheet powers yet |

The first sign-in from `BOOTSTRAP_OWNER_EMAIL` is provisioned as `owner_admin`;
everyone else defaults to `reviewer`.

## Duplicate / change / removal detection (how it works)

- **Row identity** is a hidden stable UUID (`GCD_QBO_Row_ID`) in the sheet's
  hidden control column / developer metadata — never the visible row number, so
  moving a row doesn't change its identity. Before a hidden UUID exists, rows are
  keyed by a content fingerprint so the DB stays idempotent.
- **Duplicate row ID** — the same hidden UUID on two+ rows flags all of them.
- **Possible duplicate** — a new row whose fingerprint matches an already-posted
  row (e.g. copied without the hidden id) is flagged, not posted.
- **Already posted** — a row that already carries a QBO transaction id is skipped
  (also enforced by a DB unique constraint).
- **Changed after posting** — the stored original hash vs the current hash.
- **Removed after posting** — a posted UUID absent from a full tab scan (a moved
  row is still found and is *not* flagged).

## Email alerts

- **Daily summary** → `bills@germancardepot.com` (rows scanned/posted/skipped,
  errors, possible duplicates, changed/removed-after-posting, audit-only, QBO
  match failures, dashboard link).
- **Changed/Removed after posting** critical alerts → `michaelc@germancardepot.com`.

## The `/console/*` contract (gcd-arcade)

The hub exposes `GET /console/manifest`, `GET /console/state`, and
`GET /console/stream` (SSE) at the root, advertising one hub tile with per-module
sub-items. It uses the same optional shared-secret gate (`CONSOLE_TOKEN`) as
`gcd-webhook`. gcd-arcade's BFF reads these and renders a grouping tile. See
`gcd-arcade/integrations/gcd-qbo-hub/` for the mirror + wiring notes.

```bash
curl -s $PUBLIC_APP_URL/console/manifest | jq .
curl -s $PUBLIC_APP_URL/console/state    | jq .   # add -H "x-console-token: <t>" if gated
```

## Testing

```bash
npm test        # Vitest — the §20 domain-rule suite (68 tests)
npm run typecheck
npm run build   # Prisma generate + Next.js build
```

See [`TESTING.md`](./TESTING.md) for the full manual checklist.

## Deploy (Render)

`render.yaml` is a Blueprint defining the web service, the daily Cron Job, and a
managed Postgres. **New → Blueprint → connect `caposhi/gcd-qbo-hub`**, then set
the `sync: false` secrets in the dashboard. The build runs `prisma migrate deploy`
automatically; run `npm run db:seed` once against the database to load mappings.

## Critical warnings

- Never double-count revenue — INV `Amt Collected` rows are audit-only.
- Never edit or delete QBO transactions after posting, automatically, ever.
- Never rely on row number alone for identity.
- Never fabricate editor identity beyond what Google's API provides.
- Never post live until sandbox testing is complete and each stage is advanced.
- Never substitute an interactive QBO/Gmail/Drive connector for these unattended
  production integrations.
