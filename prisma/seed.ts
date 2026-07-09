/**
 * Seed the initial German Car Depot cash-sheet mappings (§7, §14) and the
 * safe default config (dry-run / sandbox). Idempotent: safe to re-run.
 */
import { PrismaClient } from "@prisma/client";
import { buildSeedPurposeMappings, SEED_ACCOUNT_MAPPINGS } from "../src/lib/cashsheet/seed-mappings";
import { CONFIG_KEYS, DEFAULT_ROLLOUT_STAGE, DEFAULT_QBO_ENVIRONMENT, DEFAULT_SPREADSHEET_ID } from "../src/lib/cashsheet/config";

const prisma = new PrismaClient();

async function main() {
  // Purpose mappings.
  for (const m of buildSeedPurposeMappings()) {
    await prisma.purposeMapping.upsert({
      where: { normalizedPurpose: m.normalizedPurpose },
      create: m,
      update: {
        purposePattern: m.purposePattern,
        amountType: m.amountType,
        qboAction: m.qboAction,
        qboAccountName: m.qboAccountName,
        postToQbo: m.postToQbo,
        auditOnly: m.auditOnly,
        requiresPayee: m.requiresPayee,
        requiresManualApproval: m.requiresManualApproval,
        invoiceMatching: m.invoiceMatching,
        // Do NOT overwrite a resolved qboAccountId or the active flag on re-seed.
      },
    });
  }
  console.log(`Seeded ${buildSeedPurposeMappings().length} purpose mappings.`);

  // Account mappings (IDs resolved later from the connected QBO company).
  for (const a of SEED_ACCOUNT_MAPPINGS) {
    await prisma.accountMapping.upsert({
      where: { friendlyName: a.friendlyName },
      create: a,
      update: { qboAccountName: a.qboAccountName, qboAccountType: a.qboAccountType },
    });
  }
  console.log(`Seeded ${SEED_ACCOUNT_MAPPINGS.length} account mappings.`);

  // Safe default config (dry-run / sandbox) with an initial change record.
  const defaults: Array<[string, string]> = [
    [CONFIG_KEYS.rolloutStage, DEFAULT_ROLLOUT_STAGE],
    [CONFIG_KEYS.qboEnvironment, DEFAULT_QBO_ENVIRONMENT],
    [CONFIG_KEYS.spreadsheetId, process.env.GOOGLE_SHEET_ID || DEFAULT_SPREADSHEET_ID],
  ];
  for (const [key, value] of defaults) {
    const existing = await prisma.config.findUnique({ where: { key } });
    if (!existing) {
      const cfg = await prisma.config.create({ data: { key, value } });
      await prisma.configChange.create({
        data: { configId: cfg.id, key, oldValue: null, newValue: value, reason: "seed default" },
      });
    }
  }
  console.log("Seeded default config (dry-run / sandbox).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
