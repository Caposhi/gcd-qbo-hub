-- A Paymentech settlement charge can consolidate several same-card payments;
-- link the whole group into the deposit.
ALTER TABLE "dep_payout_lines" ADD COLUMN "matchedQboTxnIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
