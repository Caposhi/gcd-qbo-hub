import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../../components/RequireAuth";
import { prisma } from "@/lib/db";
import { getRolloutStage, getQboEnvironment, getSheetWritebackEnabled } from "@/lib/config-store";
import { hasValidCredentials } from "@/lib/qbo/oauth";
import { ROLLOUT_STAGES, type RolloutStage } from "@/lib/cashsheet/rollout";
import { advanceStageAction, setSheetWritebackAction } from "../actions";

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
      <h1>Settings & Rollout</h1>
      <p className="sub">
        The rollout ladder must be advanced one deliberate step at a time (§12). Live auto-posting is never a
        default — it is the last rung and owner-only.
      </p>

      {searchParams.qbo === "connected" && <div className="notice ok">QBO connected successfully.</div>}
      {searchParams.qbo && searchParams.qbo !== "connected" && (
        <div className="notice danger">QBO connect issue: {searchParams.qbo}.</div>
      )}

      <h2>QuickBooks Online connection</h2>
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
        <a className="btn" href="/api/qbo/connect">
          {credsValid ? "Reconnect QBO" : "Connect QBO"}
        </a>
      ) : (
        <p className="muted">Connecting QBO requires owner_admin.</p>
      )}
      <p className="muted" style={{ marginTop: "0.5rem" }}>
        The QBO redirect URI must be set to <code>{process.env.QBO_REDIRECT_URI ?? "(unset)"}</code> in the Intuit
        developer dashboard — deploy the hub to its stable HTTPS URL first, then register this URI (§16).
      </p>

      <h2>Rollout stage</h2>
      <div className="tiles">
        {ROLLOUT_STAGES.map((s) => (
          <div key={s} className={`tile ${s === stage ? "warn" : ""}`}>
            <div className="l">{s === stage ? "current" : ""}</div>
            <div style={{ fontWeight: 700 }}>{s}</div>
            <div className="muted" style={{ fontSize: "0.78rem" }}>{STAGE_HELP[s]}</div>
          </div>
        ))}
      </div>

      <div className="row-actions">
        {prev && (
          <form action={advanceStageAction.bind(null, prev)}>
            <button className="btn secondary" disabled={!canChange}>← Step back to {prev}</button>
          </form>
        )}
        {next && (
          <form action={advanceStageAction.bind(null, next)}>
            <button className={`btn ${next.startsWith("live") ? "danger" : ""}`} disabled={!canChange}>
              Advance to {next} →
            </button>
          </form>
        )}
      </div>
      {!canChange && <p className="muted">Changing the rollout stage requires owner_admin (§14).</p>}
      <p className="muted">
        Every stage change is recorded with who/when/old→new in the config change history — flips are auditable,
        not silent env edits (§12).
      </p>

      <h2>Sheet write-back</h2>
      <p>
        Status:{" "}
        {writebackEnabled ? (
          <span className="badge ok">on</span>
        ) : (
          <span className="badge">off</span>
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
          <button className={`btn ${writebackEnabled ? "secondary" : ""}`} disabled={!canChange}>
            {writebackEnabled ? "Turn write-back off" : "Turn write-back on"}
          </button>
        </form>
      </div>
      {!canChange && <p className="muted">Changing write-back requires owner_admin (§14).</p>}
    </>
  );
}
