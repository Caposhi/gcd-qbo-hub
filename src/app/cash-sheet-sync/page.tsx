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

/**
 * Unreviewed count for a set of statuses (§10). A "Possible Duplicate" row is
 * often a correct, permanent signal rather than something with a further
 * action to take — e.g. a name/date correction whose original already has a
 * real QBO deposit (see duplicates.ts's findInvNumberSibling): there's
 * nothing to DO, just something to acknowledge. Once a reviewer marks it
 * reviewed, it should stop nagging on the Overview's "needs attention" tiles
 * even though the row (correctly) keeps its status and stays out of the
 * posting path forever.
 */
async function unreviewedCounts(statuses: string[]): Promise<Record<string, number>> {
  const grouped = await prisma.sheetRow.groupBy({
    by: ["status"],
    where: { status: { in: statuses }, reviewedAt: null },
    _count: { _all: true },
  });
  const out: Record<string, number> = {};
  for (const g of grouped) out[g.status] = g._count._all;
  return out;
}

export default async function OverviewPage() {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  const [lastRun, counts, stage, environment, recentChanges, dupCounts, approvedNotPosted] = await Promise.all([
    prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
    statusCounts(),
    getRolloutStage(),
    getQboEnvironment(),
    // Latest cell edits detected across daily syncs (§11), newest first, with a
    // link back to each row's full change history.
    prisma.rowEvent.findMany({
      where: { eventType: "row_changed" },
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { sheetRow: { select: { id: true, tabName: true, rowNumberLastSeen: true } } },
    }),
    unreviewedCounts([RowStatus.PossibleDuplicate, RowStatus.DuplicateRowId]),
    // Rows an owner_admin already approved but that haven't posted yet — the
    // "dry-run trap": approval only takes effect on the next REAL sync, and
    // it's easy to run a dry-run afterward and assume nothing happened.
    prisma.sheetRow.count({ where: { approvedAt: { not: null }, qboTransactionId: null } }),
  ]);
  const credsValid = await hasValidCredentials(environment).catch(() => false);
  const changedSinceLastSync =
    Number((lastRun?.summaryJson as { rowsChangedSinceLastSync?: number } | null)?.rowsChangedSinceLastSync ?? 0);
  const awaitingApproval = counts[RowStatus.ReadyToPost] ?? 0;

  /** Build a Queue link pre-filtered to one or more statuses. */
  const queueHref = (...rowStatuses: string[]) =>
    `/cash-sheet-sync/queue?status=${encodeURIComponent(rowStatuses.join(","))}`;

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
          <StatCard label="Edited since last sync" n={changedSinceLastSync} sev="warn" />
        </div>
      </div>

      <h2 style={{ fontSize: 18, margin: "8px 0 12px" }}>Attention</h2>
      <p className="page-desc" style={{ marginTop: 0 }}>Click any tile to see exactly which rows it counts.</p>
      <div className="kpi-grid">
        <StatCard
          label="Awaiting approval"
          n={awaitingApproval}
          sev={awaitingApproval > 0 ? "warn" : undefined}
          href={queueHref(RowStatus.ReadyToPost)}
        />
        <StatCard
          label="Possible dupes"
          n={dupCounts[RowStatus.PossibleDuplicate] ?? 0}
          sev="warn"
          href={queueHref(RowStatus.PossibleDuplicate)}
        />
        <StatCard
          label="Duplicate row IDs"
          n={dupCounts[RowStatus.DuplicateRowId] ?? 0}
          sev="warn"
          href={queueHref(RowStatus.DuplicateRowId)}
        />
        <StatCard
          label="Unknown purpose"
          n={counts[RowStatus.UnknownPurpose] ?? 0}
          sev="warn"
          href={queueHref(RowStatus.UnknownPurpose)}
        />
        <StatCard
          label="Missing account map"
          n={counts[RowStatus.MissingAccountMapping] ?? 0}
          sev="warn"
          href={queueHref(RowStatus.MissingAccountMapping)}
        />
        <StatCard
          label="Changed after posting"
          n={counts[RowStatus.ChangedAfterPosting] ?? 0}
          sev="danger"
          href={queueHref(RowStatus.ChangedAfterPosting)}
        />
        <StatCard
          label="Removed after posting"
          n={counts[RowStatus.RemovedFromSheetAfterPosting] ?? 0}
          sev="danger"
          href={queueHref(RowStatus.RemovedFromSheetAfterPosting)}
        />
        <StatCard
          label="Audit-only (INV)"
          n={counts[RowStatus.AuditOnly] ?? 0}
          href={queueHref(RowStatus.AuditOnly)}
        />
        <StatCard
          label="Awaiting QBO match"
          n={counts[RowStatus.AwaitingQboMatch] ?? 0}
          href={queueHref(RowStatus.AwaitingQboMatch)}
        />
        <StatCard
          label="Rows in error"
          n={counts[RowStatus.Error] ?? 0}
          sev={(counts[RowStatus.Error] ?? 0) > 0 ? "danger" : undefined}
          href={queueHref(RowStatus.Error)}
        />
      </div>

      <h2 style={{ fontSize: 18, margin: "24px 0 12px" }}>Recent sheet edits</h2>
      <p className="page-desc" style={{ marginTop: 0 }}>
        Cell changes detected between daily syncs. Click a row to see its full change history (was → now).
      </p>
      <div className="table-wrap" style={{ marginBottom: 8 }}>
        <table className="gcd">
          <thead>
            <tr><th>When</th><th>Row</th><th>Fields changed</th></tr>
          </thead>
          <tbody>
            {recentChanges.map((e) => (
              <tr key={e.id}>
                <td>{e.createdAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                <td>
                  {e.sheetRow ? (
                    <Link href={`/cash-sheet-sync/rows/${e.sheetRow.id}`}>
                      {e.sheetRow.tabName} · row {e.sheetRow.rowNumberLastSeen}
                    </Link>
                  ) : (
                    "(row removed)"
                  )}
                </td>
                <td className="card-subtitle" style={{ margin: 0 }}>
                  {changedFields(e.diffJson) || e.eventMessage}
                </td>
              </tr>
            ))}
            {recentChanges.length === 0 && (
              <tr>
                <td colSpan={3} className="card-subtitle">
                  No cell edits detected yet. When someone changes a tracked row in the workbook, the next daily
                  sync flags it here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 style={{ fontSize: 18, margin: "24px 0 12px" }}>Manual actions</h2>
      {approvedNotPosted > 0 && (
        <div className="notice warn" style={{ marginBottom: 12 }}>
          <strong>{approvedNotPosted}</strong> row{approvedNotPosted === 1 ? " is" : "s are"} approved and waiting to
          post. Approval only takes effect on a real sync — <strong>"Run dry-run now" will not post{" "}
          {approvedNotPosted === 1 ? "it" : "them"}</strong>, on purpose. Use "Run sync now" (or wait for tonight's
          cron) to actually post {approvedNotPosted === 1 ? "it" : "them"}.
        </div>
      )}
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

/** Summarize a row_changed diffJson (array of {field}) into a field-name list. */
function changedFields(diffJson: unknown): string {
  if (!Array.isArray(diffJson)) return "";
  return diffJson
    .map((d) => (d && typeof d === "object" && "field" in d ? String((d as { field: unknown }).field) : ""))
    .filter(Boolean)
    .join(", ");
}

/**
 * Stat tile: count + a severity badge only when the count is non-zero (calm at
 * 0). When `href` is given the whole tile is a link into the Queue,
 * pre-filtered to exactly the rows this number counts — so every number on
 * the dashboard is one click from the rows behind it.
 */
function StatCard({
  label,
  n,
  sev,
  href,
}: {
  label: string;
  n: number;
  sev?: "warn" | "danger";
  href?: string;
}) {
  const body = (
    <>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{n}</div>
      {sev && n > 0 && (
        <div className="kpi-foot">
          <span className={`badge ${sev}`}>needs attention</span>
        </div>
      )}
    </>
  );
  if (href) {
    return (
      <Link href={href} className="kpi-card kpi-card-link" style={{ display: "block", textDecoration: "none", color: "inherit" }}>
        {body}
      </Link>
    );
  }
  return <div className="kpi-card">{body}</div>;
}
