-- Coworker Portal "Ask My Client" import (read-only over QBO).
-- Adds the QBO-transaction linkage + snapshot fields to cwp_questions so parked
-- transactions can be imported as questions and deduped on re-import.
ALTER TABLE "cwp_questions"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "qboTxnId" TEXT,
  ADD COLUMN "qboTxnType" TEXT,
  ADD COLUMN "qboTxnDate" TEXT,
  ADD COLUMN "qboTxnAmount" DECIMAL(12,2),
  ADD COLUMN "qboTxnName" TEXT;

-- Dedupe re-imports. Postgres treats NULLs as distinct, so the many manually
-- created questions (both columns NULL) remain unconstrained.
CREATE UNIQUE INDEX "cwp_questions_qboTxnType_qboTxnId_key" ON "cwp_questions"("qboTxnType", "qboTxnId");
CREATE INDEX "cwp_questions_source_idx" ON "cwp_questions"("source");
