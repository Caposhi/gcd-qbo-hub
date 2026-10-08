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
- Each charge counts at gross − fee. A refund is deducted from the payout that actually took it: the same payout when refunded the same day, or a later payout when refunded later. The export has no refund date, so refunds stay outstanding until a payout ties with them deducted; the deposit step then sweeps the matching QBO refund(s) (90-day lookback): one refund of exactly the gap, else the smallest combination (up to four) that sums to it exactly — ties broken by the date closest to the payout and noted on the event — else every open refund in the window if together they tie.
- A payout that cannot be tied is flagged `needs_review` on its own and consumes no charges, so it never breaks later payouts.
- Re-dropping the same files after a logic fix updates unposted payouts in place; payouts already created in QBO are never changed.
- A card charge (Tekmetric/Stripe or Paymentech) is matched only to a QBO payment whose method could be a card. Methods naming a lender (Financing/Bosch, Snap, Koalifi), Zelle, cash, check, PAC Warranty or bad debt are skipped, and a card-brand method beats "Other". Before this, a $1,500 Stripe charge took a same-day $1,500 Bosch "Financing" payment (live, 09/10), leaving the Bosch bank line with nothing to match. The Paymentech same-card consolidation fallback does not check methods yet.
- Nothing is linked twice. Before choosing fee entries or refunds, Locate and Create read every QBO deposit from the start of the search window (Create: 90 days before the payout) through **today** and skip any payment, fee journal-entry line or refund already on one — e.g. a fee or refund a neighbouring payout's deposit (or a deposit entered by hand) already swept. A skipped refund is listed as a near miss naming the deposit that holds it; a payment already on a deposit blocks Create with that deposit's number. Without this, QBO rejects the deposit with error 6000 ("Transaction cannot be applied to Deposit … already been applied to another Deposit"); if that error still appears, the event log says to re-run Locate and Create again.

## Customer-financing payouts and Zelle (Snap, Bosch/CFNA, Koalafi, Zelle)

Tekmetric records a financed repair as one customer payment for the full amount in Undeposited Funds, with no fee entry. The lender later pays the shop by ACH, minus its fee, under its own name — so without this step the payment stays in Undeposited Funds and QBO suggests booking the bank line as new income (double-counting revenue). Drop the Chase **account activity** CSV for Main working Acct …9680 (Chase → Download account activity → Spreadsheet CSV, any date range). The hub keeps only lender and Zelle deposits and ignores every other line. Zelle has the same problem: Tekmetric records the payment (type "Zelle") in Undeposited Funds, and the bank line otherwise looks like new income. (Affirm and Klarna are not here — they're paid through Tekmetric/Stripe and reconcile with the Tekmetric payouts.)

| Lender | Bank line `ORIG CO NAME` | Fee rule (`src/lib/deposits/financing.ts`) | Paid |
|---|---|---|---|
| Bosch card (CFNA) | `BRIDGESTONE/FIRE` (`EPOSPYMNTS`) | exactly 1.99% of the payment (±1¢) | ~2 business days after the payment |
| Snap Finance | `QB/SNAP LOAN` | 0–1.5% (observed ~0.36%) | ~2 business days |
| Koalafi | `KOALAFI` (`LEASE FUND`) | normally none; up to 6% allowed | ~3 business days; customer named in `IND NAME` |
| Zelle | description `Zelle payment from <SENDER> <ref>` | none — exact amount | same day; Tekmetric may record it up to 3 business days either side |

**Locate** pairs each deposit with the open Undeposited-Funds payment(s) in its window whose fee fits the rule. A payment whose QBO method names something else (a card brand, cash, Affirm/Klarna, PAC Warranty, another lender) is never a candidate. When QBO's method names the source ("Snap Finance", "Financing … (Bosch CNFCA)", "Koalifi", "Zelle"), only those payments are considered. Snap *requires* that label (its fee band is loose enough for card payments to fit by chance — a dry run on real data showed exactly that). Koalafi requires the bank line's customer name to match the QBO customer; Zelle requires the sender's name to match **or** the "Zelle" method (a company can pay for a customer) — always combined with the exact amount and date, never on the name alone. Two payments in one ACH are tried only when no single payment fits, and only among payments labelled for that source. Anything with more than one plausible match goes to `needs_review` with the candidates listed. That includes identical unlabelled payments: Tekmetric records a corrected payment as the original plus a negative entry of the same amount, so one of two identical "Other" payments may be cancelled. A line is reported as already deposited only when a payment that fits is on a QBO deposit that **is** that bank line: a single deposit totalling the bank amount to the cent. The gross and lender fee are then taken from that payment (e.g. a $1,470.15 Bosch line shows $1,500.00 gross and a $29.85 fee). Without the total check, a Bosch/CFNA line (no customer name on it) could be "covered" by any same-amount payment deposited elsewhere, such as in a card payout. That happened live on 09/14; the review note now names such a payment and its deposit. A verified deposit takes priority, even when an open payment also fits, so a line is never deposited twice. Each Locate run re-checks already-deposited lender and Zelle rows. A row that still verifies only has its figures refreshed. A row that no longer verifies is matched again like any open payout.

A Zelle that isn't a repair-order payment (personal transfers, test amounts) or is still *Unapproved* in Tekmetric's Accounting Link goes to review with that hint.

**Create** links the payment(s) and adds one negative line for the lender fee to **Credit Card Processing Fees** (none for Zelle or a fee-free Koalafi payout) (account mapping of that name, else the QBO account with that exact name). The fee is re-checked against the lender's rule and the deposit total against the bank amount, to the cent, before posting. Lender rules and rates are business facts verified against real payouts in Aug–Sep 2026; if a lender changes its pricing, update `LENDERS` and its tests.

## Safety invariants

- Prototype status is not a safety gate.
- Require an authenticated owner, explicit QBO environment/company, complete account mappings, and an idempotency check before creation.
- Amount totals must reconcile exactly under the module's decimal/rounding rules; unexplained differences remain `Needs review`.
- Do not infer customer identity solely from free text or silently merge payout lines.
- Never post a production-specific sample, payout, customer, bank trace, QBO realm, or accounting correction in Git.
- Accounting cleanup discovered during reconciliation is a separate owner-approved decision; the app must not automatically modify historical QBO entries.

## Validation

Use fictional fixtures and QBO sandbox. Test parsing, duplicate imports, amount/fee composition, missing mappings, ambiguous matches, permission denial, create failure, retry after an uncertain response, persisted QBO ID, and source mutation after creation. A live payout is not a test fixture.
