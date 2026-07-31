/**
 * Diagnose why "Call transcripts" on System Health still shows "nothing
 * cached yet" even after running the AI Council.
 *
 * The council's monthly run already calls refreshTranscriptInsights() (see
 * src/lib/ai/orchestrator.ts) — but wraps it in a try/catch that only logs
 * to the server console on failure, so a misconfigured URL/secret or a
 * live error from the webhook server's transcript endpoints fails silently
 * from the UI's perspective, forever. This calls the same 4 read endpoints
 * directly and prints exactly what each one returns (or throws), plus
 * whether the resulting snapshot write succeeded — no more guessing from a
 * console log you can't see.
 *
 * Read-only against the transcript service except for the final upsert into
 * this app's own tek_snapshot-style cache table (transcript_snapshot),
 * which is the same write the council's background call already makes.
 *
 * Run: `npm run transcripts:diagnose -- 2026-06-01 2026-06-30`
 */
import { isTranscriptsConfigured, fetchStats, fetchKeywords, fetchInsightsStatus, fetchNegativeCalls } from "../src/lib/transcripts/client";
import { refreshTranscriptInsights, readTranscriptSnapshot } from "../src/lib/transcripts/snapshot";

async function main() {
  const [start, end] = process.argv.slice(2);
  if (!start || !end) {
    console.error("Usage: npm run transcripts:diagnose -- <start YYYY-MM-DD> <end YYYY-MM-DD>");
    process.exit(1);
  }

  console.log(`TRANSCRIPTS_BASE_URL set: ${Boolean(process.env.TRANSCRIPTS_BASE_URL)}`);
  console.log(`TRANSCRIPTS_SECRET set: ${Boolean(process.env.TRANSCRIPTS_SECRET)}`);
  if (!isTranscriptsConfigured()) {
    console.error("\nNot configured — set both TRANSCRIPTS_BASE_URL and TRANSCRIPTS_SECRET, then re-run.");
    process.exit(1);
  }

  const range = { from: start, to: end };
  const endpoints: Array<[string, () => Promise<unknown>]> = [
    ["GET /stats", () => fetchStats()],
    ["GET /keywords", () => fetchKeywords(range)],
    ["GET /insights-status", () => fetchInsightsStatus()],
    ["GET /search (negative calls)", () => fetchNegativeCalls(range)],
  ];

  console.log(`\nCalling each endpoint individually for ${start}..${end}:\n`);
  let anyFailed = false;
  for (const [label, fn] of endpoints) {
    try {
      const result = await fn();
      console.log(`  ✓ ${label}`);
      console.log(`    ${JSON.stringify(result).slice(0, 300)}`);
    } catch (err) {
      anyFailed = true;
      console.error(`  ✗ ${label}`);
      console.error(`    ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
  }

  if (anyFailed) {
    console.error(
      "\nAt least one endpoint failed — that's exactly why the council's background refresh has been " +
        "silently no-op'ing (it wraps the whole thing in one try/catch and gives up on the first error). " +
        "Fix whatever's failing above — likely TRANSCRIPTS_BASE_URL pointing at the wrong host, or " +
        "TRANSCRIPTS_SECRET not matching the webhook server's ADMIN_SECRET (a 403 means the secret is wrong; " +
        "a network/DNS error means the URL is wrong) — then re-run this script."
    );
    process.exit(1);
  }

  console.log("\nAll 4 endpoints succeeded. Running the full refresh + cache write…");
  await refreshTranscriptInsights({ start, end });
  const { data, fetchedAt } = await readTranscriptSnapshot({ start, end });
  console.log(`\nCached: ${Boolean(data)}, fetchedAt: ${fetchedAt?.toISOString() ?? "—"}`);
  console.log("System Health's 'Call transcripts' card should now show this as cached.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
