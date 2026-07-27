-- Manual correction for a single month's Tekmetric top-line KPIs (RO count,
-- car count, ARO, gross profit), for when a live pull is reproducibly wrong
-- (see looksLikePartialMonth) rather than a transient rate-limit blip, so
-- re-running the backfill can't fix it. Owner-gated
-- (override_tekmetric_ops); revenue/margin are always derived from these four
-- fields, never stored. See src/lib/tekmetric/overrides.ts.
CREATE TABLE "tek_month_overrides" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "roCount" INTEGER NOT NULL,
    "carCount" INTEGER NOT NULL,
    "aro" DECIMAL(12,2) NOT NULL,
    "grossProfit" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "overriddenByEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tek_month_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tek_month_overrides_periodStart_key" ON "tek_month_overrides"("periodStart");

-- Append-only audit trail: one row per create/update/clear, so a correction's
-- history is never lost even though the current value (above) is overwritten.
CREATE TABLE "tek_month_override_events" (
    "id" TEXT NOT NULL,
    "overrideId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "previousJson" JSONB,
    "newJson" JSONB,
    "changedByEmail" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tek_month_override_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tek_month_override_events_overrideId_idx" ON "tek_month_override_events"("overrideId");

ALTER TABLE "tek_month_override_events" ADD CONSTRAINT "tek_month_override_events_overrideId_fkey"
    FOREIGN KEY ("overrideId") REFERENCES "tek_month_overrides"("id") ON DELETE CASCADE ON UPDATE CASCADE;
