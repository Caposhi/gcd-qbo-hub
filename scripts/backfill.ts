/**
 * Backfill / prior-date dry-run tool (§3, §21).
 *
 * Processes rows dated BEFORE the automation start date (2026-07-07) too, which
 * normal mode ignores. Runs as a DRY-RUN by default — it NEVER posts older rows
 * unless you explicitly wire a posting stage, per §3 ("never post older rows
 * unless explicitly run in backfill mode"). This tool intentionally keeps
 * forceDryRun so backfill is preview-only; posting historical rows is a
 * deliberate, separate decision.
 *
 * Run: `npm run sync:backfill`.
 */
import { runSync } from "../src/lib/cashsheet/engine";

async function main() {
  console.log("Running Cash Sheet Sync BACKFILL (prior dates included, DRY-RUN preview)…\n");
  const summary = await runSync({ backfill: true, forceDryRun: true, triggeredBy: "cli:backfill" });
  console.log(JSON.stringify(summary, null, 2));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
