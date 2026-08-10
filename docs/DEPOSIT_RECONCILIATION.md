# Deposit Reconciliation

**Current source status:** registered as a prototype, with implemented import, normalization, review, event/audit, mapping, and QBO Deposit creation paths. Treat it as a real financial writer whenever connected to live QBO.

## Purpose and flow

The module reconciles processor/bank payout data with QBO activity so an operator can build a deposit whose components and fees explain the bank amount. Imported data is persisted in `DepImport`, `DepPayout`, `DepPayoutLine`, and `DepEvent`; the returned QBO Deposit identifier is retained for idempotency and audit.

1. Import or parse an approved payout source.
2. Normalize payout, gross payment, fee, date, customer/vendor reference, and source identifiers.
3. Match lines to expected QBO Undeposited Funds/fee activity and surface discrepancies.
4. Require the operator to resolve mapping or amount/date ambiguity.
5. Preview the proposed QBO Deposit and target account.
6. An authorized owner creates it once; persist the QBO response and domain event.
7. Reconcile the returned QBO object and bank result. Never auto-edit/delete it when source data changes.

## Safety invariants

- Prototype status is not a safety gate.
- Require an authenticated owner, explicit QBO environment/company, complete account mappings, and an idempotency check before creation.
- Amount totals must reconcile exactly under the module's decimal/rounding rules; unexplained differences remain `Needs review`.
- Do not infer customer identity solely from free text or silently merge payout lines.
- Never post a production-specific sample, payout, customer, bank trace, QBO realm, or accounting correction in Git.
- Accounting cleanup discovered during reconciliation is a separate owner-approved decision; the app must not automatically modify historical QBO entries.

## Validation

Use fictional fixtures and QBO sandbox. Test parsing, duplicate imports, amount/fee composition, missing mappings, ambiguous matches, permission denial, create failure, retry after an uncertain response, persisted QBO ID, and source mutation after creation. A live payout is not a test fixture.
