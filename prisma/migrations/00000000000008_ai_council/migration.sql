-- AI C-suite (Phase 3): council runs, per-agent reports, and board reports.
CREATE TABLE "ai_agent_run" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "monthLabel" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT 'claude-opus-4-8',
    "spentUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ceoTakeaway" TEXT,
    "error" TEXT,
    "createdByEmail" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ai_agent_run_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_agent_run_kind_startedAt_idx" ON "ai_agent_run"("kind", "startedAt");

CREATE TABLE "ai_agent_report" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "personaName" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "takeaway" TEXT NOT NULL,
    "insightJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_report_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_agent_report_runId_idx" ON "ai_agent_report"("runId");

CREATE TABLE "ai_board_report" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "takeaway" TEXT NOT NULL,
    "reportJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_board_report_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_board_report_runId_key" ON "ai_board_report"("runId");

ALTER TABLE "ai_agent_report" ADD CONSTRAINT "ai_agent_report_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ai_agent_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_board_report" ADD CONSTRAINT "ai_board_report_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ai_agent_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
