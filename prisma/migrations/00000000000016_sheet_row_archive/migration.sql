-- Archive fields for css_sheet_rows (§10 hygiene): hide a never-posted row
-- from the default Queue/Deposits view without deleting it. See status.ts's
-- new "Superseded" status and cashsheet/engine.ts for the auto-archive path,
-- and actions.ts's archiveRowAction for the manual path.

ALTER TABLE "css_sheet_rows"
  ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archivedByEmail" TEXT,
  ADD COLUMN "archivedReason" TEXT;

-- CreateIndex
CREATE INDEX "css_sheet_rows_archived_idx" ON "css_sheet_rows"("archived");
