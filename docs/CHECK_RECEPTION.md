# Check Reception — build spec

Status: **prototype** (first rung shipped)
Module id: `check-reception` · table prefix: `chk_` · base path: `/check-reception`

---

## 0. Why this exists

Cleared checks land in the Chase bank feed with only an image attached. Today
the owner opens each one, reads the handwriting, picks the vendor, and picks the
expense category — by hand, one at a time. This module automates the read and
the classification so a human just confirms and clicks.

## 1. The core insight (same as Deposit Reconciliation)

We do **not** automate the bank-feed "Match." QBO offers the match the instant a
matching transaction exists in Chase Checking 9680. A **Check** is a `Purchase`
with `PaymentType: "Check"`, `AccountRef` = the bank, `DocNumber` = the check
number. Create that and the downloaded bank-feed line matches itself — one click.

So the hub's job is: read the check → propose vendor + category → (on approval)
create the QBO Check. The owner presses **Match** in the bank feed.

## 2. The ladder (review-first)

1. **Read** — drop the Chase check-image PDF (one check per page). Claude vision
   (`claude-opus-4-8`) transcribes each check into `{check #, amount, date,
   payee, memo, confidence}`. Read-only; nothing is written to QBO.
   Idempotent by file hash.
2. **Confirm** — each check is classified against the learned payee→category
   mapping. A confident read with a complete mapping is **ready**; anything else
   is **needs review**, where the owner confirms/corrects the payee, QBO vendor,
   and expense category. Confirming **teaches** the mapping (`chk_payee_mappings`),
   so the next check to that payee pre-fills.
3. **Create-you-match** — the owner posts each ready check (single or "Create all
   ready"). Guards: rollout gate (never dry-run, valid creds), fully-resolved
   vendor + category + number + amount, and a **duplicate guard** — a check whose
   number already exists in QBO on Chase 9680 is never posted twice.
4. **Auto** (future) — once trusted, high-confidence reads with an established
   mapping could post automatically behind the rollout ladder.

## 3. QBO shape (doc-verified)

`Purchase`:
- `PaymentType: "Check"`
- `AccountRef` → Chase Checking 9680 (paid-from bank)
- `EntityRef` → `{ value, name, type: "Vendor" }`
- `DocNumber` → the check number
- `TxnDate` → the check date
- `Line[0]` → `AccountBasedExpenseLineDetail.AccountRef` = the expense category
- `Amount` → the check amount

Vendors are resolved by `DisplayName`, created if absent (mirrors the Cash Sheet
Sync poster and Accounting Link). Categories are resolved by exact active account
name.

## 4. Data model (`chk_`)

- `chk_batches` — one ingested PDF (fileHash idempotency, page/check counts).
- `chk_checks` — one check per page: extracted fields + confidence + the raw
  extraction JSON, the resolved vendor/category, status, `qboPurchaseId` (unique
  → posts at most once).
- `chk_payee_mappings` — learned payee (normalized) → vendor + category.
- `chk_events` — append-only audit (ingest, classify, create, blocks, errors).

## 5. Guardrails

- **Read-first**: handwriting is imperfect, so nothing posts on a shaky read —
  low-confidence or incomplete reads are held for review.
- **Owner-only**: reading, confirming, and creating all require `edit_mappings`.
- **No duplicate checks**: a fresh QBO scan by check number blocks a second post.
- **Rollout-gated**: posting obeys the same stage/credential gate as every other
  QBO write in the hub.
