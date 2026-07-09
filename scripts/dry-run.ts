/**
 * Dry-run tool (§19, §21). Reads the sheet, detects tabs/headers, parses,
 * classifies, and reports EXACTLY what would be posted — without ever creating
 * a QBO transaction. Run: `npm run sync:dry-run`.
 */
import { runSync } from "../src/lib/cashsheet/engine";

async function main() {
  console.log("Running Cash Sheet Sync in DRY-RUN mode (no QBO writes)…\n");
  const summary = await runSync({ forceDryRun: true, triggeredBy: "cli:dry-run" });
  console.log(JSON.stringify(summary, null, 2));
  console.log("\nDry-run complete. Review the dashboard queue for per-row detail.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
