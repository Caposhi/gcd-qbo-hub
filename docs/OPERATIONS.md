# Operations

## Health and monitoring

- `GET /api/health` proves only that the web process can return a response.
- `/system-health` is owner-only and reads persisted state for QBO credential expiry, latest sync, Tekmetric cache, transcript freshness, AI spend, and alert backlog. It intentionally makes no upstream network calls.
- `/console/state` and `/console/stream` expose operational telemetry for Arcade. Protect them with `CONSOLE_TOKEN`; the event stream is process-local and resets on restart.
- Inspect Render web and cron logs, PostgreSQL availability, recent `SyncRun` rows, unresolved `Alert` rows, and domain event tables during an incident. Never enable magic-link logging as routine observability.

## Scheduled and manual jobs

| Job | Cadence/source | Gate | Side effects |
|---|---|---|---|
| Daily cash sync | Render `0 23 * * *` → `POST /api/cron/sync` | `CRON_SECRET`; DB rollout stage/mode | Reads Sheet/QBO; may create QBO transactions and alerts depending on stage |
| Monthly AI council | Render `0 6 1 * *` → `POST /api/cron/ai-council` | `CRON_SECRET`, permissions/config, AI budget | External reads, Anthropic spend, persisted reports |
| Prisma deployment | Web build `npm run prisma:migrate` | Database URL | Applies irreversible-forward schema migrations |
| Backfills/diagnostics | `scripts/` via package scripts | Operator/environment specific | May call external APIs and write cache/audit data; inspect each script first |

The daily schedule is 19:00 Eastern during daylight time and 18:00 during standard time, including weekends. No queue prevents overlapping manual and cron work; inspect current/recent runs before triggering another.

## Deployment

1. Confirm the target branch, Render services, environment variables, QBO environment, and database identity.
2. Review migrations and take a verified PostgreSQL backup.
3. Run tests, typecheck, lint, build, dependency audit, documentation validation, and diff review.
4. Deploy the application and observe build/migration output.
5. Verify `/api/health`, owner `/system-health`, login delivery, database reads, and only safe read-only/sandbox integration probes.
6. Observe the next cron executions; do not force a live sync solely as a smoke test.

The blueprint's `npm install && npm run build && npm run prisma:migrate` order builds before applying migrations. Confirm new code is backward-compatible with the pre-migration schema during build and startup.

## Incident response

1. Identify scope: web availability, login, database, a specific upstream, cron, QBO writes, or data correctness.
2. Stop only the affected trigger. For write risk, disable/suspend the relevant Render cron or move rollout to a non-writing stage through an authorized control; record who changed it and why.
3. Preserve logs and database/audit records. Do not delete duplicates or mutate QBO to “clean up” before reconciliation.
4. Correlate `SyncRun`, row/domain events, persisted QBO IDs, upstream request IDs, and provider dashboards.
5. Correct forward with an idempotent repair. Escalate accounting decisions to the business owner.
6. Document timeline, affected records without PII, remediation, and follow-ups.

## Backup, restore, and rollback

No repository-owned backup automation or restore drill was found. Verify Render PostgreSQL backup retention and owner access in the private continuity register. Before schema or high-risk financial changes, create an on-demand provider backup or a restricted `pg_dump` using approved operational tooling; never commit the dump.

Restore must be rehearsed into a separate database: provision isolated PostgreSQL, restore, validate Prisma migration state and critical counts, point a non-production app at it, and run read-only checks. Production restoration requires explicit authorization and a reconciliation plan for external QBO writes after the backup timestamp.

Application rollback may select a prior Render release/commit. Prisma has no automatic down migrations; prefer forward-compatible releases and forward repairs. If restoration is required, account for external side effects that a database rewind cannot undo.

## Routine maintenance

- Review failed/pending alerts, QBO credential expiry, sync freshness, AI budget, and cache freshness at least weekly.
- Review owner/admin and external-dashboard access quarterly and after personnel changes.
- Rotate shared secrets on owner change or suspected exposure, coordinating both sides of each bridge.
- Apply dependency and Node/Next/Prisma updates with tests and migration review.
- Exercise a backup restore and incident contact path at least quarterly; record date/results in `docs/STATUS.md` without secrets.
