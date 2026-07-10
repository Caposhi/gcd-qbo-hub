# Deposit Reconciliation — build spec

Status: **planned** (next module after Cash Sheet Sync)
Module id: `deposit-reconciliation` · table prefix: `dep_` · base path: `/deposit-reconciliation`

---

## 0. Why this exists

Matching processor payouts to the bank is the most time-consuming part of the
owner's QBO work — ~2 payouts/day (one **Tekmetric Payments**, one **Chase
Paymentech**), each currently reconciled by hand. This module automates the
build step so the books reconcile themselves and a human just confirms.

## 1. The core insight (what we proved manually)

**We do NOT automate bank-feed "matching."** QBO auto-suggests the match the
instant a Bank Deposit exists in the bank account (Chase Checking 9680) whose
total equals the downloaded payout line. Confirmed live: creating the correct
deposit made QBO find the match instantly — one click.

So the automation's entire job is: **create the correct Bank Deposit.** QBO does
the matching; a human presses Match (or QBO auto-clears later). This keeps a
human as the final gate on the bank feed and means we never need bank-feed write
access (which the QBO API does not cleanly expose anyway).

## 2. How the books actually flow (Back Office / Accounting Link → QBO)

Tekmetric → **Back Office "Accounting Link"** → QBO (company `…99186`,
"ALAN GELFAND INC DBA GERMAN CAR DEPOT"). Enabled mappings: Repair Order →
Customer Invoice; **Customer Payment**; **Payment Fee**. Auto-approve is OFF
(daily batches are approved manually, which posts them to QBO).

Per card sale, QBO ends up with:
- **Customer Payment** in **Undeposited Funds** (gross). Num/Method = card brand.
  Memo = `RO# | GCD | <brand> | MM/DD/YYYY`. Reference = RO#.
- **Payment Fee** journal entry (Tekmetric only) that **debits Credit Card
  Processing Fees and credits Undeposited Funds** (i.e., an individual reduction
  of funds to deposit). Memo = `FEE | Credit Card: <brand> | <NAME> | MM/DD/YY`.
  Because Back Office attaches a customer name, these JEs **appear and are
  selectable in the Bank Deposit screen** (this was the crux we got wrong twice).

## 3. Correct deposit composition (per processor)

### Chase Paymentech (in-store)
- Fees are **billed monthly**, not netted daily. So the payout = **sum of gross
  card payments** for the batch. No fee line.
- A single bank deposit can bundle **multiple batches** settled the same day →
  group by **batch date**, not batch number.
- Verified to the penny against the Paymentech CSV:
  - 7/06 batch 187001 = **$3,482.43** → deposit 7/07 ✓
  - 7/07 batch 188001 = **$7,977.22** → deposit 7/08 ✓
  - 7/08 batches 189001+189002 = **$4,871.34** → deposit 7/09 ✓
- Settlement timing observed: **batch date → deposit next business day (D+1)**.

### Tekmetric Payments (pay-by-link)
- Fees **are netted** from the payout. Deposit = **gross payments + their fee
  JEs**, which nets to the payout.
- Verified live: payout **$1,017.41** = DEVENPO $851.66 + Esquilin $199.15
  (gross $1,050.81) + fee JEs −$27.01 + −$6.39 (−$33.40) = **$1,017.41**.
- **Book the fee once, by including the existing fee JE in the deposit.** Do NOT
  add a separate fee line — that double-counts (see §8).

## 4. Data sources

| Source | Content | Access (TBD) |
|---|---|---|
| Chase Paymentech report (CSV) | per-transaction card settlements w/ **Batch #**, **Batch date**, amount, brand, merchant # | manual export / portal — sample in hand |
| Tekmetric Payments payout | per-payout charges, **fee**, **net**, statement descriptor "Tekmetric Payments", payout trace id | **need one export sample** — API or CSV TBD |
| QBO (hub's own direct client) | Undeposited Funds Payments + fee JEs to link; account ids | live OAuth (see §7) |

Bank-feed line routing key: `ORIG CO NAME` cleanly separates processors —
`PAYMENTECH` vs `Tekmetric Paymen`.

## 5. Matching engine

1. Ingest the processor file(s) → normalize to **expected deposits**:
   `{ processor, settlementDate, netAmount, lines:[{amount, brand, ref?}] }`.
   - Chase: group by batch date; net = gross sum; no fee.
   - Tekmetric: one per payout; net = payout; fee = stated fee.
2. For each expected deposit, locate the QBO **Undeposited Funds** records:
   - Payments by `amount + brand + date` (memo RO# as tiebreaker).
   - Tekmetric fee JEs by `amount + brand + date` (memo `FEE | …`).
3. **Checksum gate:** the located records must sum **exactly** to the payout
   net. If not, do **not** create anything — flag `NEEDS_REVIEW` with the delta.
4. On exact match, POST a **Deposit** into Chase 9680 linking those records.
5. Record the created deposit id + the payout it satisfies in `dep_` tables.

Ambiguity (two same-amount payments in one batch) is harmless — they all belong
to the same deposit; the batch sum is the real key.

## 6. QBO write — the Deposit call (SPIKE REQUIRED before relying on it)

Use the hub's **direct QBO Accounting client** (`src/lib/qbo/client.ts`), not the
interactive MCP connector. Create a `Deposit`:
- `DepositToAccountRef` = Chase Checking 9680.
- One `Line` per included record via `LinkedTxn` (`TxnType: "Payment"` for the
  customer payments; the fee JEs are JournalEntry lines that credit Undeposited
  Funds and must be pulled in as well).
- Total must equal the payout net; add **no** category fee line.

**Spike to confirm before building on it:** exact `LinkedTxn` shape for pulling
an existing Payment *and* a specific fee **JournalEntry line** into a Deposit
(TxnType/TxnLineId). High confidence it's supported; must be verified against the
live API on a sandbox/one real payout.

## 7. Dependencies / go-live

- **Production QBO connection.** Everything to date is sandbox. This module needs
  the hub's direct QBO client pointed at the **live** company, with real account
  ids resolved: **Chase Checking 9680**, **Undeposited Funds**, **Bank Charges &
  Fees:Credit Card Processing Fees**. (Auto-resolve from the connected company.)
- **Ingestion decision:** Tekmetric/Chase **API**, **CSV drop**, or
  **auto-forwarded statement email**. CSV drop is the simplest MVP.
- **One Tekmetric payout export** to finalize Tekmetric parsing.

## 8. Bookkeeping guardrails (learned during discovery)

- The prior manual habit double-booked the Tekmetric fee: once via the Back
  Office "Payment Fee" JE and again via a manual "SPARKPLUG STUDIOS / resolve
  difference" expense. Correct method = **include the existing fee JE in the
  deposit; never add a second fee line.** The automation enforces this by
  construction.
- Consequence in the current books (for the accountant, not the hub to fix):
  duplicate fee expense of **~$2,073.10** on reconciled batches (a correcting
  JE `DR Undeposited Funds / CR Credit Card Processing Fees` in an open period),
  plus the stranded fee JEs that inflated Undeposited Funds (~$30k). See the
  accountant memo.
- The hub **never edits or deletes** existing QBO transactions and never touches
  reconciled periods — it only **creates** deposits, which are reversible.

## 9. Rollout ladder (mirrors Cash Sheet Sync §12)

1. `propose` — show the deposit it *would* create (records + total). Creates nothing.
2. `create_manual` — POST the deposit; human presses **Match** in QBO.
3. `create_auto` — post deposits unattended; rely on QBO auto-clear. Owner-only,
   last rung, one step at a time, audited.
Every deposit gated by the exact-sum checksum. Nothing is created on a mismatch.

## 10. Data model (sketch, `dep_` prefix)

- `dep_payouts` — one row per expected deposit: processor, settlementDate,
  netAmount, feeAmount, source file id, status (`matched|needs_review|created`),
  qboDepositId, checksum delta.
- `dep_payout_lines` — the transactions composing a payout (amount, brand, ref,
  matched QBO txn id + type).
- `dep_imports` — ingested source files (hash, processor, row count) for
  idempotency/audit.
- `dep_events` — audit trail (proposed / created / review / error), like
  `css_row_events`.

## 11. Testing (mirror §20 discipline)

- Chase: batch-date grouping incl. multi-batch-per-deposit; sum checksum;
  D+1 timing; brand/"Other" handling.
- Tekmetric: gross + fee JE nets to payout; fee booked once; checksum refuses on
  mismatch.
- Processor routing by `ORIG CO NAME`.
- Idempotency: re-ingesting the same file creates no duplicate deposits.
- Never creates on inexact sum; never edits/deletes existing txns.

## 12. Open questions

1. Tekmetric payout data access — API vs CSV vs email?
2. Chase Paymentech export — manual only, or schedulable?
3. Confirm D+1 settlement holds across weekends/holidays (amount-match covers it
   regardless).
4. Amex/"Other" card brands: always settled by Chase in the same batches? (CSV
   says yes so far.)
5. Verify the Deposit `LinkedTxn` API shape (the §6 spike).
