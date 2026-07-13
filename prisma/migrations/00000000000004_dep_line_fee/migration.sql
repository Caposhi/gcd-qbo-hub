-- Per-charge processor fee (Tekmetric/Stripe), matched to the QBO fee journal entry at deposit time.
ALTER TABLE "dep_payout_lines" ADD COLUMN "feeAmount" DECIMAL(12,2);
