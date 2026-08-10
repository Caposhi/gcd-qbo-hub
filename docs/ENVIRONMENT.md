# Environment

`.env.example` is the safe local template. Production values belong in Render or the relevant secret manager. NextAuth also consumes `NEXTAUTH_SECRET` implicitly; `NODE_ENV` is supplied by the runtime.

## Core and authentication

| Variable | Required / behavior | Safety notes |
|---|---|---|
| `DATABASE_URL` | Required for durable/authenticated behavior | Identify database before migration/seed/backfill |
| `PUBLIC_APP_URL` | Public base used by callers/links | Must match deployed HTTPS origin |
| `NEXTAUTH_URL` | NextAuth canonical origin | Must match deployed origin |
| `NEXTAUTH_SECRET` | Required in production | Generate randomly; rotation invalidates sessions |
| `APP_ENCRYPTION_KEY` | Required to read/store QBO tokens | 32-byte hex/base64; loss or rotation without re-encryption breaks credentials |
| `ALLOWED_EMAIL_DOMAINS` | Comma-separated login domains | Default exists in code; set explicitly |
| `BOOTSTRAP_OWNER_EMAIL` | Exact first owner identity | Set deliberately; review after bootstrap |
| `LEGAL_CONTACT_EMAIL` | Public privacy/terms contact | Use an owned role address, not a personal fallback |
| `MAGIC_LINK_DEBUG` | Default false | True logs a one-time login credential |

## Machine boundaries and scheduling

| Variable | Required / behavior | Safety notes |
|---|---|---|
| `CRON_SECRET` | Required by both cron routes; unset fails closed | Match cron services; rotate together |
| `ARCADE_BRIDGE_SECRET` | Required by `/api/external/*`; unset fails closed | Match Arcade server only; never browser-side |
| `CONSOLE_TOKEN` | Optional in code | **Unset makes state/stream public**; set in every shared environment |
| `SYNC_TZ` | Timestamp/business-time setting | Schedule itself remains UTC in `render.yaml` |

## Google Sheets and QBO

| Variable | Required / behavior | Safety notes |
|---|---|---|
| `GOOGLE_SHEET_ID` | Cash-sheet source identifier | Confidential operational identifier |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Raw JSON credential alternative | Prefer one credential form only |
| `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` | Base64 JSON alternative | Base64 is encoding, not encryption |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` | OAuth application | Secret stays server-side |
| `QBO_REDIRECT_URI` | Exact registered callback | Must match Intuit dashboard |
| `QBO_ENV` | Legacy compatibility/diagnostics | Rollout/config logic is authoritative; keep sandbox for local use |

The obsolete bootstrap-token variables `QBO_REALM_ID`, `QBO_REFRESH_TOKEN`, `QBO_ACCESS_TOKEN`, and `QBO_TOKEN_EXPIRES_AT` are not active code inputs; encrypted database credentials are authoritative.

## AI, operations data, transcripts, and email

| Variable | Required / behavior | Safety notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | Enables assistant/council calls | Cost and data egress; unset disables calls |
| `TEKMETRIC_BASE_URL` | API origin | Use approved sandbox/non-production origin locally |
| `TEKMETRIC_TOKEN` / `TEKMETRIC_SHOP_ID` | Read integration | Token is secret; shop ID is confidential identifier |
| `COWORKER_QBO_ACCOUNT_NAME` | Exact QBO account to import | Validate in target company before import |
| `TRANSCRIPTS_BASE_URL` / `TRANSCRIPTS_SECRET` | Aggregated transcript service | Secret shared with related repository |
| `SENDGRID_API_KEY` | Magic-link and alerts | Missing key disrupts login/email |
| `ALERT_FROM_EMAIL` | Verified sender | Must be approved by SendGrid |
| `ALERT_SUMMARY_RECIPIENT` | Operational summary destination | Avoid personal defaults in examples |
| `ALERT_CRITICAL_RECIPIENT` | Critical mutation alert destination | Use owned monitored group |

`SYNC_HOUR` and the QBO bootstrap-token variables were removed from the example because active code does not read them. `render.yaml` remains a deployment declaration, not proof that dashboard values are set.
