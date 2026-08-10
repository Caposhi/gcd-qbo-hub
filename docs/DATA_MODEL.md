# Data model

`prisma/schema.prisma` is authoritative. PostgreSQL is the only durable store; the console event ring is memory only. There were 38 Prisma models and 17 migration directories at the 2026-08-10 audit.

## Domains

| Domain | Models / prefix | Purpose and sensitivity |
|---|---|---|
| Authentication | `User`, `Account`, `Session`, `VerificationToken` | Emails, roles, sessions, one-time tokens; highly sensitive |
| Configuration/audit | `Config`, `ConfigChange` | Rollout, environment, mutable operational settings and history |
| QBO credentials | `QboCredential` | Encrypted OAuth tokens, realm/environment metadata; critical secret material |
| Cash Sheet Sync | `SyncRun`, `SheetRow`, `RowEvent`, `QboTransaction`, mapping models, `Alert` | Financial source rows, identities, posting audit, QBO IDs, notification state; confidential/PII possible |
| Projections/reporting | `ProjScenario`, `ProjReportSnapshot`, `FinReportSnapshot`, `FinCapability` | Financial statements, scenarios, cached capabilities; confidential |
| AI | `AiConversation`, `AiMessage`, `AiAgentRun`, `AiAgentReport`, `AiBoardReport` | Prompts, financial context, outputs, costs; confidential and potentially identifying |
| Coworker portal | `CwpQuestion`, `CwpAnswer` | Staff questions/answers and QBO references; confidential/PII possible |
| Deposits | `DepImport`, `DepPayout`, `DepPayoutLine`, `DepEvent` | Payout lines, reconciliation, QBO deposit IDs, audit history; financial/PII possible |
| Checks | `ChkBatch`, `ChkCheck`, `ChkPayeeMapping`, `ChkEvent` | Extracted check data, payees, QBO check IDs, audit history; financial/PII possible |
| Tekmetric | `TekSnapshot`, `TekMonthOverride`, `TekMonthOverrideEvent` | Shop KPIs and audited overrides; confidential business data |
| Transcripts | `TranscriptSnapshot` | Aggregated monthly insight snapshots; source should exclude raw utterances |

Enums `Role`, `SyncMode`, and `RolloutStage` constrain permissions and write lifecycle.

## Relationships and invariants

Users own sessions and may be attributed on configuration changes, connections, approvals, questions, or AI activity. Sync rows link their event history and created QBO transaction record. Deposit/check imports group normalized line items and immutable domain events. External object IDs are reconciliation keys, not proof that the external object still exists unchanged.

Do not hard-delete financial audit history as routine cleanup. Retain provider IDs, timestamps, actor attribution, before/after metadata, and failure details while minimizing PII. Database rollback cannot reverse a QBO transaction or email already sent.

## Schema procedure

1. Change `prisma/schema.prisma` and create a named migration against a disposable development database.
2. Review generated SQL for locks, destructive operations, nullability, indexes, and data transforms.
3. Add compatibility tests and update this document, environment/runbooks, and root handoff.
4. Back up the identified production database before `prisma migrate deploy`.
5. Verify migration status, application reads/writes, and domain counts after deploy.

There is no automatic down path. Write a forward repair or use a verified restore with an external-side-effect reconciliation plan.

## Retention and export

No comprehensive retention/deletion policy was found in source. Define retention with accounting, privacy, and incident needs before deleting auth, AI, alert, transcript, or financial audit data. Exports and database dumps are confidential operational artifacts; store them access-controlled outside Git and define deletion dates.
