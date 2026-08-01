-- Financial Reporting (Phase 1): cached, normalized QBO report snapshots.
-- Keyed by report type + inclusive period + accounting method so pages render
-- fast and the later monthly AI job can read a stable baseline. payloadJson is
-- the NORMALIZED metric series (never raw QBO). Read-only over QBO.
CREATE TABLE "proj_report_snapshot" (
    "id" TEXT NOT NULL,
    "reportType" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proj_report_snapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "proj_report_snapshot_reportType_periodStart_periodEnd_method_key" ON "proj_report_snapshot"("reportType", "periodStart", "periodEnd", "method");
