import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { getRolloutStage, getQboEnvironment } from "@/lib/config-store";
import { hasValidCredentials } from "@/lib/qbo/oauth";
import { RowStatus } from "@/lib/cashsheet/status";
import { runDryRunAction, runSandboxSyncAction, runBackfillAction } from "./actions";
import { RequireAuth } from "../components/RequireAuth";

export const dynamic = "force-dynamic";

async function statusCounts(): Promise<Record<string, number>> {
  const grouped = await prisma.sheetRow.groupBy({ by: ["status"], _count: { _all: true } });
  const out: Record<string, number> = {};
  for (const g of grouped) out[g.status] = g._count._all;
  return out;
}

export default async function OverviewPage() {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  const [lastRun, counts, stage, environment] = await Promise.all([
    prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
    statusCounts(),
    getRolloutStage(),
    getQboEnvironment(),
  ]);
  const credsValid = await hasValidCredentials(environment).catch(() => false);

  const tile = (label: string, n: number, cls = "") => (
    <div className={`tile ${cls}`} key={label}>
      <div className="n">{n}</div>
      <div className="l">{label}</div>
    </div>
  );

  return (
    <>
      <h1>💵 Cash Sheet Sync</h1>
      <p className="sub">
        Posts the employee cash sheet (workbook <code>26 DC</code>) to QuickBooks Online with a full audit trail.
        Customer invoice (INV) cash is audit-only — never double-counted.
      </p>

      <div className="notice" style={{ display: "flex", gap: "1rem", flexWrap: "wrap", alignItems: "center" }}>
        <span>
          Environment: <span className={`badge ${environment === "live" ? "danger" : "ok"}`}>{environment}</span>
        </span>
        <span>
          Rollout stage: <span className="badge warn">{stage}</span>
        </span>
        <span>
          QBO: {credsValid ? <span className="badge ok">connected</span> : <span className="badge danger">setup required</span>}
        </span>
        <span style={{ marginLeft: "auto" }}>
          <Link href="/cash-sheet-sync/settings">Settings & rollout →</Link>
        </span>
      </div>

      {!credsValid && stage !== "dry_run" && (
        <div className="notice danger">
          QBO credentials are missing or invalid — syncs run in validation/dry-run only until QBO is connected
          (§16). Connect it in <Link href="/cash-sheet-sync/settings">Settings</Link>.
        </div>
      )}

      <h2>Last sync</h2>
      {lastRun ? (
        <p className="muted">
          {lastRun.startedAt.toISOString()} · mode <strong>{lastRun.mode}</strong> · stage{" "}
          <strong>{lastRun.rolloutStage}</strong> · {lastRun.status}
          <br />
          Tabs scanned:{" "}
          <strong>{lastRun.tabsScanned.length ? lastRun.tabsScanned.join(", ") : "(none)"}</strong>
        </p>
      ) : (
        <p className="muted">No sync has run yet. Start with a dry-run below.</p>
      )}

      <div className="tiles">
        {tile("Scanned", lastRun?.rowsScanned ?? 0)}
        {tile("Posted", lastRun?.rowsPosted ?? 0)}
        {tile("Skipped", lastRun?.rowsSkipped ?? 0)}
        {tile("Errors", lastRun?.rowsError ?? 0, (lastRun?.rowsError ?? 0) > 0 ? "danger" : "")}
      </div>

      <h2>Attention</h2>
      <div className="tiles">
        {tile("Possible dupes", counts[RowStatus.PossibleDuplicate] ?? 0, "warn")}
        {tile("Duplicate row IDs", counts[RowStatus.DuplicateRowId] ?? 0, "warn")}
        {tile("Unknown purpose", counts[RowStatus.UnknownPurpose] ?? 0, "warn")}
        {tile("Missing account map", counts[RowStatus.MissingAccountMapping] ?? 0, "warn")}
        {tile("Changed after posting", counts[RowStatus.ChangedAfterPosting] ?? 0, "danger")}
        {tile("Removed after posting", counts[RowStatus.RemovedFromSheetAfterPosting] ?? 0, "danger")}
        {tile("Audit-only (INV)", counts[RowStatus.AuditOnly] ?? 0)}
        {tile("Awaiting QBO match", counts[RowStatus.AwaitingQboMatch] ?? 0)}
      </div>

      <h2>Manual actions</h2>
      <div className="row-actions">
        <form action={runDryRunAction}>
          <button className="btn secondary" type="submit" disabled={!can(user.role, "run_dry_run")}>
            Run dry-run now
          </button>
        </form>
        <form action={runSandboxSyncAction}>
          <button className="btn" type="submit" disabled={!can(user.role, "run_sandbox_sync")}>
            Run sync now
          </button>
        </form>
        <form action={runBackfillAction}>
          <button
            className="btn secondary"
            type="submit"
            disabled={!can(user.role, "run_sandbox_sync") || environment === "live"}
            title="Ignores the 2026-07-07 go-live cutoff so older rows already in the sheet become eligible. Sandbox/dry-run only."
          >
            Run backfill (ignore start date)
          </button>
        </form>
        <Link className="btn secondary" href="/cash-sheet-sync/queue">
          View queue →
        </Link>
        <Link className="btn secondary" href="/cash-sheet-sync/mappings">
          Mappings →
        </Link>
      </div>
      {!can(user.role, "run_sandbox_sync") && (
        <p className="muted">You are a {user.role}: you can run dry-runs and review, but not post or change config.</p>
      )}
    </>
  );
}
