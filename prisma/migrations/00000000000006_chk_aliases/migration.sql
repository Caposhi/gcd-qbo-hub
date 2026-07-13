-- Learned raw-read aliases: consistent handwriting misreads that resolve to a
-- known payee mapping after correction.
ALTER TABLE "chk_payee_mappings" ADD COLUMN "rawAliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
