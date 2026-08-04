-- Financial Reports module — fin_ prefixed (read-only QBO statement cache).

-- CreateTable
CREATE TABLE "fin_report_snapshot" (
    "id" TEXT NOT NULL,
    "reportKey" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "basis" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fin_report_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fin_capabilities" (
    "id" TEXT NOT NULL,
    "singleton" TEXT NOT NULL DEFAULT 'company',
    "payloadJson" JSONB NOT NULL,
    "probedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fin_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fin_report_snapshot_reportKey_periodStart_periodEnd_basis_key" ON "fin_report_snapshot"("reportKey", "periodStart", "periodEnd", "basis");

-- CreateIndex
CREATE INDEX "fin_report_snapshot_reportKey_idx" ON "fin_report_snapshot"("reportKey");

-- CreateIndex
CREATE UNIQUE INDEX "fin_capabilities_singleton_key" ON "fin_capabilities"("singleton");
