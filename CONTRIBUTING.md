# Contributing

## Normal workflow

1. Read `AGENTS.md`, the root README, `docs/STATUS.md`, and the runbook for the subsystem being changed.
2. Inspect `git status` and preserve unrelated changes.
3. Trace the behavior through source, tests, Prisma schema/migrations, environment reads, Render configuration, and callers before editing.
4. Keep live financial writes behind existing permissions, rollout gates, and idempotency controls. Use QBO sandbox and non-production fixtures for development.
5. Update code, tests, documentation, diagrams, environment references, and external prerequisites together.
6. Run relevant validation and review the complete diff before requesting review.

## Database changes

Edit `prisma/schema.prisma`, create a named migration with Prisma, inspect the generated SQL, and test both deployment and application compatibility against a disposable database. Back up production before deployment. There is no automatic down migration; document forward repair and restore implications.

## Integration changes

Document the account owner, credential location (never the value), scopes, identifiers, dashboard callbacks/webhooks, cost or rate limits, failure boundary, test mode, and rotation/recovery procedure in `docs/INTEGRATIONS.md` and `docs/SECURITY_AND_CONTINUITY.md`.

## Definition of done

- Behavior is covered by tests at the appropriate level.
- `npm test`, `npm run typecheck`, `npm run lint`, and `npm run build` pass, or each limitation is reported.
- Schema and migration state are consistent; no command targeted an unidentified database.
- Every active environment read is documented and represented safely in `.env.example` where appropriate.
- Relative Markdown links resolve, edited documents were reread in full, and stale instructions were removed or archived.
- Credential/PII findings were manually triaged without echoing sensitive values.
- `git diff --check` and complete diff review pass.
- The binding documentation rule in `AGENTS.md` has been satisfied.

Do not use live operational scripts merely to prove a change works. A production sync, backfill, QBO write, email, migration, or AI run requires explicit scope and an identified environment.
