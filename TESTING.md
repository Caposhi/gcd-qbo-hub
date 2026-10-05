# Testing

Run tests and builds with non-production configuration. Tests must never require a live Google sheet, QBO company, SendGrid account, Anthropic key, Tekmetric shop, transcript service, or Render database.

## Automated checks

```bash
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm audit --omit=dev
git diff --check
```

`npm test` uses Vitest over the TypeScript test inventory. The suite covers parsing, identity/idempotency, change detection, mapping, roles, rollout/config logic, QBO/report transforms, projections, AI budget/context, deposit/check behavior, Tekmetric transforms, and related server logic. Confirm the current file list rather than relying on a fixed count.

The production build runs `prisma generate` before `next build`. It does not prove migrations, provider credentials, OAuth callback registration, cron delivery, email delivery, or live APIs work.

## Safe integration validation

Use a disposable PostgreSQL database, fictional user/customer/payee fixtures, a non-production Google sheet, QBO sandbox, and approved sandbox/test provider accounts. Confirm:

- disallowed domains cannot request login and owner/reviewer/coworker permissions are enforced server-side;
- `MAGIC_LINK_DEBUG=false` does not emit sign-in links;
- cron and Arcade endpoints fail closed when their secrets are absent or wrong;
- console state/stream require a token in any shared environment;
- rollout defaults prevent live writes and sandbox posting is idempotent;
- customer invoice cash remains match/audit-only where the domain rule requires it;
- a second import/sync does not create duplicate external transactions;
- source changes after posting create audit events/alerts rather than editing/deleting QBO;
- Deposit and Check creation require owner authorization, complete mappings, an explicit target environment, and stable idempotency keys;
- AI budget limits stop further calls and failures do not present partial reports as complete;
- external payloads are parsed defensively and secrets/PII are absent from logs.

Do not use a production sync, QBO creation, email, AI run, backfill, seed, or migration merely as a smoke test. Such an operation needs explicit authorization, a named environment, rollback/reconciliation planning, and an operator observing the result.

## Phone and tablet layout

The shell is responsive (`src/app/globals.css` §11): at ≤960px the sidebar becomes a slide-out menu opened from the top bar, and at ≤600px pages switch to phone density (2-up KPI tiles, stacked filters, compact module cards). After any UI change, check the touched pages against a disposable local database with a phone-sized browser (e.g. 390×844 and 320×640, plus 844×390 landscape) and a desktop width:

- the page never scrolls sideways — wide tables scroll inside their own card instead;
- the menu opens, closes on backdrop/Esc/link tap, and navigation works from it;
- search, the GCD Pal sheet, and forms are usable, and focusing a field does not zoom the page on iOS (controls stay ≥16px);
- desktop (≥961px) still shows the permanent sidebar and full top bar.

## Repository documentation checks

Validate all relative Markdown links, compare active `process.env` reads plus framework-consumed variables against `.env.example` and `docs/ENVIRONMENT.md`, scan current files/history for credentials and personal data without echoing findings, reread modified documents in full, and review the complete diff.
