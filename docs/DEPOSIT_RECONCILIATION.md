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

## Tekmetric (Stripe) payout reconstruction

Drop both Tekmetric exports together: the payouts file (`po_…` rows) and the payments file (`py_…` rows, e.g. `unified_payments.csv`). Neither links a charge to its payout, so `reconstructTekmetricPayouts` (`src/lib/deposits/stripe.ts`) rebuilds membership, accepting a payout only when its charges tie to the payout net to the cent:

- Charges are grouped by UTC created date. A payout covers a run of one or more consecutive days created before its arrival date — normally the previous business day; weekends and bank holidays roll several days into one payout.
- Each charge counts at gross − fee. A refund is deducted from the payout that actually took it: the same payout when refunded the same day, or a later payout when refunded later. The export has no refund date, so refunds stay outstanding until a payout ties with them deducted; the deposit step then sweeps the matching QBO refund (90-day lookback).
- A payout that cannot be tied is flagged `needs_review` on its own and consumes no charges, so it never breaks later payouts.
- Re-dropping the same files after a logic fix updates unposted payouts in place; payouts already created in QBO are never changed.

## Safety invariants

- Prototype status is not a safety gate.
- Require an authenticated owner, explicit QBO environment/company, complete account mappings, and an idempotency check before creation.
- Amount totals must reconcile exactly under the module's decimal/rounding rules; unexplained differences remain `Needs review`.
- Do not infer customer identity solely from free text or silently merge payout lines.
- Never post a production-specific sample, payout, customer, bank trace, QBO realm, or accounting correction in Git.
- Accounting cleanup discovered during reconciliation is a separate owner-approved decision; the app must not automatically modify historical QBO entries.

## Validation

Use fictional fixtures and QBO sandbox. Test parsing, duplicate imports, amount/fee composition, missing mappings, ambiguous matches, permission denial, create failure, retry after an uncertain response, persisted QBO ID, and source mutation after creation. A live payout is not a test fixture.
