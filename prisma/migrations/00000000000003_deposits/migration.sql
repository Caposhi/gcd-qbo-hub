-- CreateTable
CREATE TABLE "dep_imports" (
    "id" TEXT NOT NULL,
    "processor" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "importedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dep_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dep_payouts" (
    "id" TEXT NOT NULL,
    "importId" TEXT,
    "processor" TEXT NOT NULL,
    "settlementDate" TEXT NOT NULL,
    "grossAmount" DECIMAL(12,2) NOT NULL,
    "feeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'needs_review',
    "deltaCents" INTEGER,
    "qboDepositId" TEXT,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dep_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dep_payout_lines" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "brand" TEXT,
    "ref" TEXT,
    "matchedQboTxnId" TEXT,
    "matchedQboTxnType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dep_payout_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dep_events" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "dataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dep_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "dep_imports_fileHash_key" ON "dep_imports"("fileHash");

-- CreateIndex
CREATE INDEX "dep_payouts_processor_settlementDate_idx" ON "dep_payouts"("processor", "settlementDate");

-- CreateIndex
CREATE INDEX "dep_payouts_status_idx" ON "dep_payouts"("status");

-- CreateIndex
CREATE INDEX "dep_payout_lines_payoutId_idx" ON "dep_payout_lines"("payoutId");

-- CreateIndex
CREATE INDEX "dep_events_payoutId_idx" ON "dep_events"("payoutId");

-- AddForeignKey
ALTER TABLE "dep_payouts" ADD CONSTRAINT "dep_payouts_importId_fkey" FOREIGN KEY ("importId") REFERENCES "dep_imports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dep_payout_lines" ADD CONSTRAINT "dep_payout_lines_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "dep_payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dep_events" ADD CONSTRAINT "dep_events_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "dep_payouts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
