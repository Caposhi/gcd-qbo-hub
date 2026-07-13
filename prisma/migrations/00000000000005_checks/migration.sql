-- Check Reception module — chk_ prefixed (prototype)

-- CreateTable
CREATE TABLE "chk_batches" (
    "id" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "fileName" TEXT,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "checkCount" INTEGER NOT NULL DEFAULT 0,
    "uploadedByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chk_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chk_checks" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "page" INTEGER NOT NULL,
    "checkNumber" TEXT,
    "amount" DECIMAL(12,2),
    "checkDate" TEXT,
    "payeeRaw" TEXT,
    "memo" TEXT,
    "confidence" TEXT,
    "extractionJson" JSONB,
    "payeeResolved" TEXT,
    "qboVendorId" TEXT,
    "qboVendorName" TEXT,
    "categoryAccountId" TEXT,
    "categoryAccountName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'needs_review',
    "statusReason" TEXT,
    "qboPurchaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chk_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chk_payee_mappings" (
    "id" TEXT NOT NULL,
    "normalizedPayee" TEXT NOT NULL,
    "payeeDisplay" TEXT NOT NULL,
    "qboVendorId" TEXT,
    "qboVendorName" TEXT,
    "categoryAccountId" TEXT,
    "categoryAccountName" TEXT,
    "timesConfirmed" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chk_payee_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chk_events" (
    "id" TEXT NOT NULL,
    "checkId" TEXT,
    "eventType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "dataJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chk_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chk_batches_fileHash_key" ON "chk_batches"("fileHash");

-- CreateIndex
CREATE UNIQUE INDEX "chk_checks_qboPurchaseId_key" ON "chk_checks"("qboPurchaseId");

-- CreateIndex
CREATE INDEX "chk_checks_batchId_idx" ON "chk_checks"("batchId");

-- CreateIndex
CREATE INDEX "chk_checks_status_idx" ON "chk_checks"("status");

-- CreateIndex
CREATE UNIQUE INDEX "chk_payee_mappings_normalizedPayee_key" ON "chk_payee_mappings"("normalizedPayee");

-- CreateIndex
CREATE INDEX "chk_events_checkId_idx" ON "chk_events"("checkId");

-- AddForeignKey
ALTER TABLE "chk_checks" ADD CONSTRAINT "chk_checks_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "chk_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chk_events" ADD CONSTRAINT "chk_events_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "chk_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
