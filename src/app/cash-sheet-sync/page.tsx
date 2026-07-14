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

  return (
    <>
      <div className="accent-bar" />
      <h1>Cash Sheet Sync</h1>
      <p className="page-desc">
        Posts the employee cash sheet (workbook <code>26 DC</code>) to QuickBooks Online with a full audit trail.
        Customer invoice (INV) cash is audit-only — never double-counted.
      </p>

      <div className="card pad-sm" style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "center", marginBottom: 18 }}>
        <span>
          <span className="kpi-label">Environment</span>{" "}
          <span className={`badge ${environment === "live" ? "danger" : "ok"}`}>{environment}</span>
        </span>
        <span>
          <span className="kpi-label">Rollout stage</span> <span className="badge warn">{stage}</span>
        </span>
        <span>
          <span className="kpi-label">QBO</span>{" "}
          {credsValid ? <span className="badge ok">connected</span> : <span className="badge danger">setup required</span>}
        </span>
        <span style={{ marginLeft: "auto" }}>
          <Link href="/cash-sheet-sync/settings">Settings &amp; rollout →</Link>
        </span>
      </div>

      {!credsValid && stage !== "dry_run" && (
        <div className="notice danger" style={{ marginBottom: 18 }}>
          QBO credentials are missing or invalid — syncs run in validation/dry-run only until QBO is connected
          (§16). Connect it in <Link href="/cash-sheet-sync/settings">Settings</Link>.
        </div>
      )}

      <h2 style={{ fontSize: 18, margin: "8px 0 12px" }}>Last sync</h2>
      <div className="card" style={{ marginBottom: 22 }}>
        {lastRun ? (
          <p className="card-subtitle" style={{ margin: 0 }}>
            {lastRun.startedAt.toISOString()} · mode <strong>{lastRun.mode}</strong> · stage{" "}
            <strong>{lastRun.rolloutStage}</strong> · {lastRun.status}
            <br />
            Tabs scanned:{" "}
            <strong>{lastRun.tabsScanned.length ? lastRun.tabsScanned.join(", ") : "(none)"}</strong>
          </p>
        ) : (
          <p className="card-subtitle" style={{ margin: 0 }}>No sync has run yet. Start with a dry-run below.</p>
        )}
        <div className="kpi-grid" style={{ marginTop: 16 }}>
          <StatCard label="Scanned" n={lastRun?.rowsScanned ?? 0} />
          <StatCard label="Posted" n={lastRun?.rowsPosted ?? 0} />
          <StatCard label="Skipped" n={lastRun?.rowsSkipped ?? 0} />
          <StatCard label="Errors" n={lastRun?.rowsError ?? 0} sev="danger" />
        </div>
      </div>

      <h2 style={{ fontSize: 18, margin: "8px 0 12px" }}>Attention</h2>
      <div className="kpi-grid">
        <StatCard label="Possible dupes" n={counts[RowStatus.PossibleDuplicate] ?? 0} sev="warn" />
        <StatCard label="Duplicate row IDs" n={counts[RowStatus.DuplicateRowId] ?? 0} sev="warn" />
        <StatCard label="Unknown purpose" n={counts[RowStatus.UnknownPurpose] ?? 0} sev="warn" />
        <StatCard label="Missing account map" n={counts[RowStatus.MissingAccountMapping] ?? 0} sev="warn" />
        <StatCard label="Changed after posting" n={counts[RowStatus.ChangedAfterPosting] ?? 0} sev="danger" />
        <StatCard label="Removed after posting" n={counts[RowStatus.RemovedFromSheetAfterPosting] ?? 0} sev="danger" />
        <StatCard label="Audit-only (INV)" n={counts[RowStatus.AuditOnly] ?? 0} />
        <StatCard label="Awaiting QBO match" n={counts[RowStatus.AwaitingQboMatch] ?? 0} />
      </div>

      <h2 style={{ fontSize: 18, margin: "24px 0 12px" }}>Manual actions</h2>
      <div className="row-actions">
        <form action={runDryRunAction}>
          <button className="btn ghost" type="submit" disabled={!can(user.role, "run_dry_run")}>
            Run dry-run now
          </button>
        </form>
        <form action={runSandboxSyncAction}>
          <button className="btn primary" type="submit" disabled={!can(user.role, "run_sandbox_sync")}>
            Run sync now
          </button>
        </form>
        <form action={runBackfillAction}>
          <button
            className="btn ghost"
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
        <Link className="btn secondary" href="/cash-sheet-sync/deposits">
          Cash deposits →
        </Link>
      </div>
      {!can(user.role, "run_sandbox_sync") && (
        <p className="card-subtitle" style={{ marginTop: 12 }}>
          You are a {user.role}: you can run dry-runs and review, but not post or change config.
        </p>
      )}
    </>
  );
}

/** Stat tile: count + a severity badge only when the count is non-zero (calm at 0). */
function StatCard({ label, n, sev }: { label: string; n: number; sev?: "warn" | "danger" }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{n}</div>
      {sev && n > 0 && (
        <div className="kpi-foot">
          <span className={`badge ${sev}`}>needs attention</span>
        </div>
      )}
    </div>
  );
}
