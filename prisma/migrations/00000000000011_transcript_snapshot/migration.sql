-- Call-transcript integration (Build Phase 4): cache of AGGREGATED monthly call
-- insights read from the sibling gcd-webhook-server transcript service. Never
-- stores raw transcript utterances — only normalized rollups (handoff §9).
CREATE TABLE "transcript_snapshot" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_snapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "transcript_snapshot_entity_periodStart_periodEnd_key" ON "transcript_snapshot"("entity", "periodStart", "periodEnd");
