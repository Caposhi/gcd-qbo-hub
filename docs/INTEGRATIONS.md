# Integrations

External state was not accessed during the 2026-08-10 repository audit. “Configured” below means code/config support exists, not that the production account was verified.

| System | Direction and responsibility | Credentials/identifiers | Failure boundary | Owner |
|---|---|---|---|---|
| PostgreSQL / Render | Durable app, auth, audit, cache, and token store | `DATABASE_URL`; Render database binding | Most authenticated pages/actions fail; console buffer remains non-durable | Assign in private register |
| Render | Hosts web and two cron services | Dashboard access, service/DB names, `CRON_SECRET` | Deploy/schedule/log/backup failure | Assign in private register |
| Intuit QuickBooks Online | OAuth reads and transaction creates | Client ID/secret, redirect URI; encrypted DB tokens and realm | Reporting/sync/modules degrade; partial external writes require reconciliation | Accounting + technical owner |
| Google Sheets | Read source for cash sheet | Sheet ID and service-account JSON/base64 | Sync cannot ingest; sharing is manual dashboard state | Business data owner |
| SendGrid | Magic links and operational email | API key, sender, recipients | Users may be unable to sign in; alerts accumulate/fail | Messaging owner |
| Anthropic | Assistant and monthly AI council | API key; model/cost logic in source | Assistant/report generation fails or incurs cost | Budget owner |
| Tekmetric | Read-only shop KPIs | Base URL, bearer token, shop ID | Cache becomes stale; projections lose operations data | Shop-system owner |
| Transcript service | Read-only monthly aggregates | Base URL and shared secret | Transcript insight becomes stale/unavailable | Related-repo owner |
| gcd-arcade | Server-to-server module bridge | Matching `ARCADE_BRIDGE_SECRET`; Arcade stores counterpart | Shared identity can read/trigger supported operations; no per-user delegation | Both repo owners |

## QuickBooks boundaries

The connect/callback flow stores encrypted OAuth credentials in `QboCredential`. The environment is derived from rollout/config logic; `QBO_ENV` remains compatibility/diagnostic input and must not override verified rollout intent. Register the exact callback URI from `QBO_REDIRECT_URI` in Intuit. Modules read reports/entities and can create Expenses/Transfers, Deposits, and Checks. They must not automatically edit or delete existing QBO transactions.

## Google and SendGrid setup

Share the intended sheet with the configured service-account principal at the minimum read level. Keep key material only in the secret manager/dashboard. Verify SendGrid sender identity and deliverability; magic-link debug logging is an emergency escape hatch, not a mail substitute.

## Arcade handoff

Arcade's server must send `Authorization: Bearer` with its counterpart secret to `/api/external/reporting`, `/api/external/cash-sheet-sync`, `/api/external/coworker-portal`, and `/api/external/assistant`. Reporting POST refreshes QBO data; assistant POST can incur cost and persist a shared conversation. Rotate both repositories atomically. Do not expose the bridge secret to browser code.

## Manual settings to record privately

Record, without secret values: provider account/tenant, billing owner, recovery contacts, Render team/services/custom domains/deploy hooks, database retention, Intuit app/environment/redirects/scopes, Google file owner/sharing, SendGrid sender verification, Anthropic spend alerts, Tekmetric token issuer/shop, transcript endpoint owner, Arcade counterpart setting, last rotation, and emergency revoke path.
