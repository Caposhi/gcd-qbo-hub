-- Duplicate-flag dismissal for css_sheet_rows (§10 hygiene). Once a human
-- confirms a Possible Duplicate flag is a false positive, the sync engine
-- skips both duplicate checks for that row's identity going forward — see
-- dismissDuplicateAction and engine.ts's processRow.

ALTER TABLE "css_sheet_rows"
  ADD COLUMN "duplicateDismissedAt" TIMESTAMP(3),
  ADD COLUMN "duplicateDismissedByEmail" TEXT;
