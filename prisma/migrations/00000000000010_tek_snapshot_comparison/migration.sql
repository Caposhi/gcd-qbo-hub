-- Tekmetric snapshot: add the comparison mode to the cache key.
-- KPI deltas in payloadJson are computed against the chosen comparison
-- (prior_period / prior_year / none), so a period must be keyed by comparison
-- too — otherwise refreshing a period under one comparison overwrites (and the
-- page misreads) the same period under another.
ALTER TABLE "tek_snapshot" ADD COLUMN "comparison" TEXT NOT NULL DEFAULT 'prior_period';

DROP INDEX "tek_snapshot_entity_periodStart_periodEnd_key";

CREATE UNIQUE INDEX "tek_snapshot_entity_periodStart_periodEnd_comparison_key" ON "tek_snapshot"("entity", "periodStart", "periodEnd", "comparison");
