-- Internal purpose override for css_sheet_rows (§7/§14, dashboard-only
-- correction). Used as a fallback when the sheet's own Purpose cell is
-- blank (see purpose.ts's effectivePurpose and actions.ts's
-- setPurposeOverrideAction) — never written back to the sheet, never
-- overwrites the raw `purpose` column.

ALTER TABLE "css_sheet_rows"
  ADD COLUMN "purposeOverride" TEXT,
  ADD COLUMN "purposeOverrideAt" TIMESTAMP(3),
  ADD COLUMN "purposeOverrideByEmail" TEXT;
