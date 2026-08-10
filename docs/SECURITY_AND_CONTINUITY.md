# Security and continuity

## Secrets and sensitive data

Keep database URLs, NextAuth/encryption keys, OAuth client secrets/tokens, service-account JSON, API keys, cron/bridge/console/transcript secrets, magic links, customer/payee data, raw transcripts, financial exports, and database dumps out of Git, documentation, fixtures, screenshots, and issue trackers.

QBO tokens are AES-256-GCM encrypted in PostgreSQL using `APP_ENCRYPTION_KEY`. The key must be backed up in the approved private secret store; never place it in the continuity document. Base64-encoded Google JSON is still secret plaintext. Query-string console keys can be captured by logs and should be replaced by the header form.

Removing a secret from the current tree does not remove it from Git history. If a real credential is ever found, revoke/rotate it at the provider, assess access logs, then make a separate coordinated decision about history cleanup. Do not rewrite history during routine documentation work.

## Authentication and authorization

Human access uses SendGrid-delivered NextAuth magic links, allowed-domain checks, and database roles. Owner-only operations include live/write controls, mappings, QBO connect, user management, AI council runs, refreshes, and overrides. Review server-side permissions whenever adding a route or action; hiding UI is insufficient.

Machine endpoints use shared bearer secrets and therefore collapse attribution to a service identity. Cron and Arcade secrets must be distinct. Console state/stream fail open when `CONSOLE_TOKEN` is empty; treat a nonempty token as mandatory. The public manifest and home page disclose limited system metadata by design.

## Personal and financial data

Cash-sheet rows, checks, payouts, coworker questions, auth emails, AI prompts, and external IDs can identify customers, staff, or vendors. Minimize values in logs and error messages. Use fictional fixtures and redact screenshots. The repository does not define a complete retention or subject-deletion policy; obtain accounting/privacy requirements before removing audit data.

The public legal pages read `LEGAL_CONTACT_EMAIL`; configure an owned role address in production. They deliberately fall back to generic business-contact instructions rather than a person's address.

Active classification/posting code and seed mappings still contain business-specific QBO account labels and the legal business identity. Those values are executable matching behavior, not documentation examples or credentials. Externalizing them requires an owner-approved configuration/data migration with regression tests; do not redact them mechanically and break transaction classification.

## Private continuity register

Maintain an access-controlled register outside Git containing only locations/owners, never secret values:

- legal/business and technical owners, accounting approver, incident contacts;
- Render team, services, domains, deploy controls, database owner, backup retention and last restore test;
- secret-manager locations, rotation dates, and recovery owners for every environment variable class;
- Intuit app/company/environment/scopes/redirects and revoke/reconnect procedure;
- Google sheet/file owner and service-account owner;
- SendGrid, Anthropic billing, Tekmetric, transcript service, and Arcade counterpart ownership;
- domain/DNS ownership, vendor support paths, and access-review evidence.

## Takeover and recovery

1. Establish authorized access to source, Render, database backups, domain/DNS, Intuit, Google, SendGrid, Anthropic, Tekmetric, transcript service, and Arcade.
2. Inventory current owners and remove departed access only with business authorization.
3. Confirm service identity, environment, database, QBO realm, rollout stage, cron status, and bridge counterparts before rotating anything.
4. Rotate one boundary at a time, update both ends, validate a safe path, and record completion privately.
5. Reconnect QBO through the application if token/key recovery is impossible; do not copy tokens between environments.
6. Restore into isolation before production recovery and reconcile all external side effects after the backup timestamp.

## Required decisions

Assign named owners and recovery contacts; verify Render backup retention and conduct a restore drill; decide a data-retention policy; decide whether console query-key authentication should be removed and the manifest restricted; establish AI spend alerts; and verify all provider/dashboard settings against the private register.
