# Testing checklist — GCD QBO Hub

## Automated (Vitest) — `npm test`

The pure domain rules are unit-tested with no DB/network. Coverage maps to §20:

- [x] Header detection (position-independent, spelling/case tolerant) — `headers.test.ts`
- [x] Blank-row ignoring — `rows.test.ts`
- [x] Amount parsing (`$1,080.00`, `1080`, `1,080`, `(1,080.00)`, negatives) — `amount.test.ts`
- [x] Date parsing (US, ISO, serial) + start-date ignore logic — `dates.test.ts`
- [x] Purpose normalization & mapping (flexible, unknown = no match) — `purpose.test.ts`
- [x] Row hash / fingerprint creation (stable across moves, month-scoped) — `fingerprint.test.ts`
- [x] Hidden row UUID handling (generate/validate/extract) — `uuid.test.ts`
- [x] Duplicate row-ID detection — `duplicates.test.ts`
- [x] Possible-duplicate fingerprint detection — `duplicates.test.ts`
- [x] Changed-after-posting detection + diff — `detection.test.ts`
- [x] Removed-after-posting detection (moved ≠ removed) — `detection.test.ts`
- [x] INV audit-only behavior (never posts revenue) — `classify.test.ts`
- [x] PART / PR paid-out expense behavior — `classify.test.ts`
- [x] Bank Deposit transfer behavior — `classify.test.ts`
- [x] Unknown-purpose error behavior — `classify.test.ts`
- [x] Start-date ignore logic — `dates.test.ts`, `rows.test.ts`
- [x] Dry-run never posts to QBO — `rollout.test.ts` (`dry_run_never_posts`)
- [x] Sandbox/live posting only at the correct stage with valid credentials — `rollout.test.ts`
- [x] Role-gated actions (reviewer cannot approve postings or change mappings/stage) — `roles.test.ts`
- [x] Projection engine: flat/compounding growth, one-offs, horizon clamping, summarize lowest-balance, assumption coercion — `projections.test.ts`
- [x] Coworker role activated (view + answer; not ask) and reviewer prototype-module gating — `roles.test.ts`

Run also: `npm run typecheck` and `npm run build`.

## Prototype modules (manual)

### Financial Projections
- [ ] As owner_admin, create a scenario (opening balance, horizon, in/out, growth) — the monthly table and summary tiles render; negative ending balances show a red badge.
- [ ] As a reviewer, the create form is hidden and a muted note appears; scenarios are still viewable.

### AI Report Assistant
- [ ] Without `ANTHROPIC_API_KEY`, the page loads and shows a "not configured" notice; sending a message returns that error.
- [ ] With the key set, "How did the last sync go?" and "List July parts purchases" return answers grounded in the DB (no fabricated figures); the assistant declines write requests.
- [ ] Conversations persist and reappear in the sidebar.

### Coworker Portal
- [ ] As owner_admin/reviewer, raise a question (optionally assigned to a coworker email).
- [ ] As the assigned coworker, only see assigned + unassigned-pool questions; answer one → status flips to "answered".
- [ ] A coworker cannot open a question assigned to someone else (sees a "not assigned to you" notice).

## Manual (staging) checklist

### Setup
- [ ] `.env.local` filled; `APP_ENCRYPTION_KEY`, `NEXTAUTH_SECRET`, `CRON_SECRET` set.
- [ ] `prisma migrate dev` + `db:seed` run; mappings visible under **Mappings**.
- [ ] Service account shared on the `26 DC` workbook.

### Auth & roles
- [ ] A non-`@germancardepot.com` email cannot request a magic link.
- [ ] First sign-in from `BOOTSTRAP_OWNER_EMAIL` becomes `owner_admin`.
- [ ] A `reviewer` sees dashboards but the Approve / Advance-stage / Save-mapping buttons are disabled.

### Dry-run (§19)
- [ ] **Run dry-run now** populates the queue and creates **no** QBO transactions.
- [ ] The expected first July row (7/7/2026, Eddie, McAdam, INV, 73735, $800) shows as **Audit Only / Awaiting QBO Match** — not income/deposit.
- [ ] A PART paid-out row shows **Ready To Post** (expense) once its account is resolved.
- [ ] A Bank Deposit row shows a **Transfer** plan to Chase Checking 9680.
- [ ] An unknown purpose shows **Unknown Purpose** and is not posted.
- [ ] Rows dated before 2026-07-07 show **Ignored - Before Start Date**.

### QBO connection (§16)
- [ ] Before connecting, overview shows **setup required**; syncs stay dry-run.
- [ ] **Connect QBO** completes OAuth; tokens are stored encrypted (check `qbo_credentials` — values are ciphertext, not plaintext).
- [ ] Account IDs resolvable in **Mappings**.

### Sandbox posting (§12)
- [ ] Advance to `sandbox_manual`. A valid row stays queued until **Approve**d, then posts to the sandbox on the next sync.
- [ ] Advance to `sandbox_auto`. Valid/mapped/non-duplicate rows post automatically; Employee Loan rows still require approval.
- [ ] Re-run the sync: already-posted rows are **skipped**, not double-posted.

### Audit signals (§2, §11)
- [ ] Edit a posted row in the sheet → next sync flags **Changed After Posting** with a diff; critical email to `michaelc@`.
- [ ] Delete a posted row from the sheet → next sync flags **Removed From Sheet After Posting**; critical email. QBO unchanged.
- [ ] Move a posted row to a different position → **not** flagged (still found by UUID).
- [ ] Copy a posted row's hidden UUID onto another row → both flagged **Duplicate Row ID**.

### Scheduling
- [ ] `POST /api/cron/sync` without the Bearer secret returns 401.
- [ ] With the secret, it runs and returns the summary JSON.

### Console contract
- [ ] `/console/manifest`, `/console/state` return JSON; `/console/stream` streams SSE.
- [ ] With `CONSOLE_TOKEN` set, unauthenticated `/console/state` returns 401.

### Go-live (owner, deliberate)
- [ ] Only after all sandbox checks pass: advance `sandbox_auto → live_manual → live_auto`, one step at a time, each recorded in the config change history.
