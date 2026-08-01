-- Tekmetric integration module (Build Phase 4 groundwork).
-- Fetch-through cache of NORMALIZED Tekmetric data, keyed by entity + date
-- range. Additive, tek_ prefixed, read-only integration (see
-- src/lib/tekmetric/* and docs/PROGRESS_tekmetric.md).
CREATE TABLE "tek_snapshot" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tek_snapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tek_snapshot_entity_periodStart_periodEnd_key" ON "tek_snapshot"("entity", "periodStart", "periodEnd");
