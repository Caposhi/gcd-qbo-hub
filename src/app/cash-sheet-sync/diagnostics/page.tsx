/**
 * QBO diagnostics (owner-only, read-only).
 *
 * Turns "it just says reconnect required" into concrete facts: which environment
 * the data path uses, what credential rows exist (no tokens), and the EXACT
 * result of a live read (CompanyInfo → accounts). Use it when a QBO-backed page
 * fails despite a "connected" status. Makes live GET calls only — never writes.
 */
import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../../components/RequireAuth";
import { currentEnvironment, QboAuthError } from "@/lib/qbo/oauth";
import { getQboEnvironment } from "@/lib/config-store";
import { getContext, query, listAccounts, QboApiError, QboNotConnectedError } from "@/lib/qbo/client";
import { askMyClientAccountName } from "@/lib/coworker/qbo";

export const dynamic = "force-dynamic";

interface Described {
  kind: string;
  detail: string;
}

function qboFault(detail: unknown): string {
  const d = detail as { Fault?: { Error?: Array<{ Message?: string; Detail?: string; code?: string }> } } | undefined;
  const e = d?.Fault?.Error?.[0];
  if (!e) return "";
  return [e.code ? `code ${e.code}` : "", e.Message, e.Detail].filter(Boolean).join(" — ");
}

function describe(err: unknown): Described {
  if (err instanceof QboNotConnectedError)
    return { kind: "QboNotConnectedError", detail: "No credential stored for this environment." };
  if (err instanceof QboAuthError)
    return {
      kind: "QboAuthError",
      detail: `Token request failed: HTTP ${err.status}. The stored refresh token was rejected — this is a real reconnect case.`,
    };
  if (err instanceof QboApiError)
    return {
      kind: "QboApiError",
      detail: `QBO API HTTP ${err.status} on "${err.path}". ${qboFault(err.detail)} — the connection is live but the request was rejected (NOT a token problem).`,
    };
  return { kind: "Error", detail: err instanceof Error ? err.message : String(err) };
}

interface ProbeResult {
  step: string;
  ok: boolean;
  realm?: string;
  error?: Described;
  accountCount?: number;
  amcName?: string;
  amcMatched?: boolean;
  amcId?: string | null;
  sampleNames?: string[];
}

async function probe(): Promise<ProbeResult> {
  const env = currentEnvironment();
  let ctx;
  try {
    ctx = await getContext(env);
  } catch (err) {
    return { step: "open connection (getContext)", ok: false, error: describe(err) };
  }
  try {
    await query(ctx, "select * from CompanyInfo");
  } catch (err) {
    return { step: "read CompanyInfo", ok: false, realm: ctx.cred.realmId, error: describe(err) };
  }
  try {
    const accts = await listAccounts(ctx);
    const name = askMyClientAccountName();
    const target = name.trim().toLowerCase();
    const match = accts.find(
      (a) => (a.Name ?? "").trim().toLowerCase() === target || (a.FullyQualifiedName ?? "").trim().toLowerCase() === target
    );
    return {
      step: "list accounts",
      ok: true,
      realm: ctx.cred.realmId,
      accountCount: accts.length,
      amcName: name,
      amcMatched: !!match,
      amcId: match?.Id ?? null,
      sampleNames: accts.map((a) => a.FullyQualifiedName || a.Name).sort().slice(0, 40),
    };
  } catch (err) {
    return { step: "list accounts", ok: false, realm: ctx.cred.realmId, error: describe(err) };
  }
}

export default async function QboDiagnosticsPage() {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;
  if (!can(user.role, "connect_qbo")) {
    return (
      <div className="center">
        <div className="card" style={{ width: 420 }}>
          <h1>QBO diagnostics</h1>
          <p className="card-subtitle">This diagnostic is owner-only.</p>
        </div>
      </div>
    );
  }

  const dataEnv = currentEnvironment();
  const stageEnv = await getQboEnvironment().catch(() => null);
  const creds = await prisma.qboCredential
    .findMany({ orderBy: [{ environment: "asc" }, { updatedAt: "desc" }] })
    .catch(() => []);
  const result = await probe();
  const now = Date.now();

  return (
    <>
      <div className="accent-bar" />
      <h1>QBO diagnostics</h1>
      <p className="page-desc">
        A live, read-only probe of the QuickBooks connection the data pages actually use. No tokens are shown and
        nothing is written to QuickBooks.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="card-title" style={{ marginTop: 0 }}>Environment</h3>
        <dl className="kv" style={{ marginTop: 10 }}>
          <dt>Data path reads (QBO_ENV)</dt>
          <dd><code>{dataEnv}</code></dd>
          <dt>Rollout-derived (display)</dt>
          <dd><code>{stageEnv ?? "—"}</code></dd>
        </dl>
        {stageEnv && stageEnv !== dataEnv && (
          <div className="notice warn" style={{ marginTop: 12 }}>
            Mismatch: the reconnect and all QBO reads use <strong>{dataEnv}</strong> (QBO_ENV), but the dashboard
            shows <strong>{stageEnv}</strong> (from the rollout stage). Set <code>QBO_ENV</code> to{" "}
            <strong>{stageEnv}</strong> in Render so they agree, then reconnect.
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="card-title" style={{ marginTop: 0 }}>Stored credentials</h3>
        <p className="card-subtitle">The data path uses the most-recently-updated row for the <code>{dataEnv}</code> environment.</p>
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="gcd">
            <thead>
              <tr>
                <th>Environment</th><th>Realm (company)</th><th>Connected by</th>
                <th>Updated</th><th>Access token</th><th>Refresh token</th>
              </tr>
            </thead>
            <tbody>
              {creds.map((c) => {
                const accessOk = c.accessTokenExpires.getTime() > now;
                const refreshOk = !c.refreshTokenExpires || c.refreshTokenExpires.getTime() > now;
                return (
                  <tr key={c.id}>
                    <td><span className={`badge ${c.environment === "live" ? "danger" : "info"}`}>{c.environment}</span></td>
                    <td>{c.realmId}</td>
                    <td>{c.connectedByEmail ?? "—"}</td>
                    <td>{c.updatedAt.toISOString().slice(0, 16).replace("T", " ")}</td>
                    <td><span className={`badge ${accessOk ? "ok" : "muted"}`}>{accessOk ? "valid" : "expired"}</span></td>
                    <td><span className={`badge ${refreshOk ? "ok" : "danger"}`}>{refreshOk ? "valid" : "expired"}</span></td>
                  </tr>
                );
              })}
              {creds.length === 0 && (
                <tr><td colSpan={6} className="card-subtitle">No QBO credentials stored yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3 className="card-title" style={{ marginTop: 0 }}>Live read probe ({dataEnv})</h3>
        {result.ok ? (
          <>
            <div className="notice info" style={{ marginTop: 12 }}>
              ✓ Connection works. Read {result.accountCount} accounts from company <code>{result.realm}</code>.
            </div>
            <div className="notice" style={{ marginTop: 12 }} >
              {result.amcMatched ? (
                <>Found the &ldquo;{result.amcName}&rdquo; account (id <code>{result.amcId}</code>) — the import should work.</>
              ) : (
                <>
                  <strong>No account named &ldquo;{result.amcName}&rdquo;.</strong> Set{" "}
                  <code>COWORKER_QBO_ACCOUNT_NAME</code> to one of the names below (exact match). A few accounts:{" "}
                  {(result.sampleNames ?? []).join(" · ")}
                </>
              )}
            </div>
          </>
        ) : (
          <div className="notice danger" style={{ marginTop: 12 }}>
            ✗ Failed at step: <strong>{result.step}</strong>
            {result.realm ? <> (company <code>{result.realm}</code>)</> : null}
            <br />
            <strong>{result.error?.kind}:</strong> {result.error?.detail}
          </div>
        )}
        <p className="card-subtitle" style={{ marginTop: 14 }}>
          <Link href="/cash-sheet-sync/settings">← Back to Settings &amp; rollout</Link>
        </p>
      </div>
    </>
  );
}
