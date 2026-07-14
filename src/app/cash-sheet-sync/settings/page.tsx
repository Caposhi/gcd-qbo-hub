import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../../components/RequireAuth";
import { prisma } from "@/lib/db";
import { getRolloutStage, getQboEnvironment, getSheetWritebackEnabled } from "@/lib/config-store";
import { hasValidCredentials } from "@/lib/qbo/oauth";
import { ROLLOUT_STAGES, type RolloutStage } from "@/lib/cashsheet/rollout";
import { advanceStageAction, setSheetWritebackAction, resetSandboxPostingsAction } from "../actions";

export const dynamic = "force-dynamic";

const STAGE_HELP: Record<RolloutStage, string> = {
  dry_run: "Never touches QBO. Shows exactly what would happen.",
  sandbox_manual: "Valid rows queue for review; a reviewer/admin approves before posting to the QBO sandbox.",
  sandbox_auto: "Valid, mapped, non-duplicate rows post automatically to the sandbox on each sync.",
  live_manual: "Same as sandbox-manual but against LIVE QuickBooks.",
  live_auto: "Fully unattended posting to LIVE QuickBooks. Owner-only, last stage.",
};

export default async function SettingsPage({ searchParams }: { searchParams: { qbo?: string } }) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  const [stage, environment, writebackEnabled] = await Promise.all([
    getRolloutStage(),
    getQboEnvironment(),
    getSheetWritebackEnabled(),
  ]);
  const credsValid = await hasValidCredentials(environment).catch(() => false);
  // Show the actual stored credential for the ACTIVE environment so it's obvious
  // whether the sandbox or the real company is connected (they have different
  // realm ids). A live stage with only a sandbox credential = not connected live.
  const activeCred = await prisma.qboCredential
    .findFirst({ where: { environment }, select: { realmId: true, connectedByEmail: true, accessTokenExpires: true } })
    .catch(() => null);
  const idx = ROLLOUT_STAGES.indexOf(stage);
  const prev = idx > 0 ? ROLLOUT_STAGES[idx - 1] : null;
  const next = idx < ROLLOUT_STAGES.length - 1 ? ROLLOUT_STAGES[idx + 1] : null;
  const canChange = can(user.role, "change_rollout_stage");

  return (
    <>
      <div className="accent-bar" />
      <h1>Settings &amp; rollout</h1>
      <p className="page-desc">
        The rollout ladder must be advanced one deliberate step at a time (§12). Live auto-posting is never a
        default — it is the last rung and owner-only.
      </p>

      {searchParams.qbo === "connected" && <div className="notice info">QBO connected successfully.</div>}
      {searchParams.qbo && searchParams.qbo !== "connected" && (
        <div className="notice danger">QBO connect issue: {searchParams.qbo}.</div>
      )}

      <h2 style={{ fontSize: 18, margin: "18px 0 10px" }}>QuickBooks Online connection</h2>
      <p>
        Environment: <span className={`badge ${environment === "live" ? "danger" : "ok"}`}>{environment}</span>{" "}
        · Status:{" "}
        {credsValid ? <span className="badge ok">connected</span> : <span className="badge danger">setup required</span>}
      </p>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Connected company (realm) for <strong>{environment}</strong>:{" "}
        <code>{activeCred?.realmId ?? "— none —"}</code>
        {activeCred?.connectedByEmail ? ` · by ${activeCred.connectedByEmail}` : ""}
        {environment === "live" && !activeCred ? " — no live credential yet; connect against your real company." : ""}
      </p>
      {can(user.role, "connect_qbo") ? (
        <a className="btn primary" href="/api/qbo/connect">
          {credsValid ? "Reconnect QBO" : "Connect QBO"}
        </a>
      ) : (
        <p className="muted">Connecting QBO requires owner_admin.</p>
      )}
      <p className="muted" style={{ marginTop: "0.5rem" }}>
        The QBO redirect URI must be set to <code>{process.env.QBO_REDIRECT_URI ?? "(unset)"}</code> in the Intuit
        developer dashboard — deploy the hub to its stable HTTPS URL first, then register this URI (§16).
      </p>

      <h2 style={{ fontSize: 18, margin: "24px 0 10px" }}>Rollout stage</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {ROLLOUT_STAGES.map((s, i) => {
          const current = s === stage;
          const done = i < idx;
          return (
            <div
              key={s}
              className="card pad-sm"
              style={{
                flex: "1 1 180px",
                minWidth: 180,
                borderColor: current ? "var(--royal-blue)" : "var(--border-subtle)",
                boxShadow: current ? "0 0 0 3px var(--powder-blue-200)" : "var(--shadow-sm)",
                opacity: done ? 0.65 : 1,
              }}
            >
              <div className="kpi-label" style={current ? { color: "var(--royal-blue)" } : undefined}>
                {current ? "Current" : done ? "Done" : `Stage ${i + 1}`}
              </div>
              <div style={{ fontFamily: "var(--font-heading)", fontWeight: 700, color: "var(--navy-blue)", margin: "5px 0" }}>
                {s}
              </div>
              <div className="card-subtitle">{STAGE_HELP[s]}</div>
            </div>
          );
        })}
      </div>

      <div className="row-actions" style={{ marginTop: 16 }}>
        {prev && (
          <form action={advanceStageAction.bind(null, prev)}>
            <button className="btn secondary" disabled={!canChange}>← Step back to {prev}</button>
          </form>
        )}
        {next && (
          <form action={advanceStageAction.bind(null, next)}>
            <button className={`btn ${next.startsWith("live") ? "danger" : "primary"}`} disabled={!canChange}>
              Advance to {next} →
            </button>
          </form>
        )}
      </div>
      {next && next.startsWith("live") && (
        <div className="notice danger" style={{ marginTop: 12 }}>
          Advancing to <strong>{next}</strong> posts against the LIVE QuickBooks company. Owner-only, and only after
          a clean sandbox run.
        </div>
      )}
      {!canChange && <p className="muted">Changing the rollout stage requires owner_admin (§14).</p>}
      <p className="muted">
        Every stage change is recorded with who/when/old→new in the config change history — flips are auditable,
        not silent env edits (§12).
      </p>

      <h2 style={{ fontSize: 18, margin: "24px 0 10px" }}>Sheet write-back</h2>
      <p>
        Status:{" "}
        {writebackEnabled ? (
          <span className="badge ok">on</span>
        ) : (
          <span className="badge muted">off</span>
        )}
      </p>
      <p className="muted">
        When on, each sync stamps a <strong>hidden stable row ID</strong> (<code>GCD_QBO_Row_ID</code>) plus{" "}
        <code>Status</code>, <code>Txn ID</code>, <code>Posted At</code>, and <code>Error</code> columns back into the
        workbook, to the right of your data. The hidden ID is what lets edits, moves, and deletions be detected safely
        (§4) — the row number is never used. Requires the Google service account to have <strong>Editor</strong> access
        to the workbook; without it the sync still runs read-only and logs a write-back error. Once the ID column is
        populated, an admin should hide &amp; protect it.
      </p>
      <div className="row-actions">
        <form action={setSheetWritebackAction.bind(null, !writebackEnabled)}>
          <button className={`btn ${writebackEnabled ? "secondary" : "primary"}`} disabled={!canChange}>
            {writebackEnabled ? "Turn write-back off" : "Turn write-back on"}
          </button>
        </form>
      </div>
      {!canChange && <p className="muted">Changing write-back requires owner_admin (§14).</p>}

      <h2>Go-live reset</h2>
      <p className="muted">
        Sandbox test posts leave a QBO transaction id on the sheet row, so once live the engine treats those rows as
        already posted and skips them — even though your live company never received them. This one-time reset clears
        the posting state on rows whose only posting was in the <strong>sandbox</strong> (it never touches a row that
        has a real live posting) and deletes the sandbox transaction records, so live starts clean. Rows will require
        fresh approval before posting live. Irreversible, but only removes throwaway sandbox test data.
      </p>
      <div className="row-actions">
        <form action={resetSandboxPostingsAction}>
          <button className="btn danger" disabled={!can(user.role, "toggle_live_mode")}>
            Reset sandbox test postings
          </button>
        </form>
      </div>
      {!can(user.role, "toggle_live_mode") && (
        <p className="muted">The go-live reset requires owner_admin (§14).</p>
      )}
    </>
  );
}
