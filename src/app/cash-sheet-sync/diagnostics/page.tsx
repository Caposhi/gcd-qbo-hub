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
import { fetchReport } from "@/lib/qbo/reports";
import { parseQboReport, normalizeSales } from "@/lib/projections/reports";

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
  const env = await getQboEnvironment();
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

interface ItemSalesProbe {
  ok: boolean;
  error?: string;
  reportName?: string;
  /** Every value column QBO returned, so a mis-picked column is obvious. */
  columns?: Array<{ index: number; title: string; type: string; colKey?: string }>;
  totalColumnIndex?: number;
  /** What the normalizer chose, and whether the rows tie out to the total. */
  chosenTotal?: number;
  rowsSum?: number;
  topRows?: Array<{ name: string; amount: number }>;
}

/**
 * Read last month's ItemSales report and report its COLUMN LAYOUT plus what the
 * normalizer made of it. This is the ground truth for the "Revenue by
 * Service/Product" figures: if the charted rows don't sum to the report's own
 * total, the wrong dollar column was picked and these columns say why.
 */
async function probeItemSales(): Promise<ItemSalesProbe> {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  try {
    const raw = await fetchReport("item_sales", {
      startDate: iso(start),
      endDate: iso(end),
      method: "accrual",
    });
    const parsed = parseQboReport(raw);
    const norm = normalizeSales(parsed);
    return {
      ok: true,
      reportName: parsed.reportName,
      columns: parsed.columns.map((c, i) => ({ index: i, title: c.title, type: c.type, colKey: c.colKey })),
      totalColumnIndex: parsed.totalColumnIndex,
      chosenTotal: norm.total,
      rowsSum: norm.rows.reduce((a, r) => a + r.amount, 0),
      topRows: norm.rows.slice(0, 5).map((r) => ({ name: r.name, amount: r.amount })),
    };
  } catch (err) {
    const d = describe(err);
    return { ok: false, error: `${d.kind}: ${d.detail}` };
  }
}

const usd = (n: number) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

  const dataEnv = await getQboEnvironment().catch(() => "sandbox" as const);
  const legacyQboEnv = currentEnvironment();
  const creds = await prisma.qboCredential
    .findMany({ orderBy: [{ environment: "asc" }, { updatedAt: "desc" }] })
    .catch(() => []);
  const result = await probe();
  const itemSales = result.ok ? await probeItemSales() : null;
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
          <dt>QBO environment (rollout-derived)</dt>
          <dd><code>{dataEnv}</code> — connect + all QBO reads use this now</dd>
          <dt>QBO_ENV var (legacy)</dt>
          <dd><code>{legacyQboEnv}</code> — no longer used for the data path</dd>
        </dl>
        {legacyQboEnv !== dataEnv && (
          <div className="notice info" style={{ marginTop: 12 }}>
            Heads up: the legacy <code>QBO_ENV</code> var (<strong>{legacyQboEnv}</strong>) disagrees with the
            rollout-derived environment (<strong>{dataEnv}</strong>). That&apos;s now harmless — the connect and
            reads follow the rollout stage (§12) — but you can set <code>QBO_ENV={dataEnv}</code> in Render (or
            remove it) to avoid confusion.
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

      {itemSales && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 className="card-title" style={{ marginTop: 0 }}>
            Revenue by Service / Product — column check (last month)
          </h3>
          <p className="card-subtitle">
            Ground truth for that chart. The charted rows must sum to the report&apos;s own total; if they
            don&apos;t, the wrong dollar column was picked and the column list below shows why.
          </p>
          {!itemSales.ok ? (
            <div className="notice danger" style={{ marginTop: 12 }}>✗ {itemSales.error}</div>
          ) : (
            <>
              {(() => {
                const total = itemSales.chosenTotal ?? 0;
                const sum = itemSales.rowsSum ?? 0;
                const ties = Math.abs(sum - total) <= Math.max(1, Math.abs(total) * 0.01);
                return (
                  <div className={`notice ${ties ? "info" : "danger"}`} style={{ marginTop: 12 }}>
                    {ties ? "✓" : "✗"} Rows sum to {usd(sum)} vs report total {usd(total)}
                    {ties ? " — ties out." : " — MISMATCH, the charted column is wrong."}
                  </div>
                );
              })()}
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table className="gcd">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>Column title</th>
                      <th>ColType</th>
                      <th>ColKey</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(itemSales.columns ?? []).map((c) => (
                      <tr key={c.index}>
                        <td className="num">{c.index}</td>
                        <td>{c.title || <span className="muted">(untitled)</span>}</td>
                        <td>{c.type || <span className="muted">—</span>}</td>
                        <td>{c.colKey ? <code>{c.colKey}</code> : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="card-subtitle" style={{ marginTop: 10 }}>
                Grand-total column index: <code>{itemSales.totalColumnIndex}</code> (−1 = none).
                {" "}Top rows as charted: {(itemSales.topRows ?? []).map((r) => `${r.name} ${usd(r.amount)}`).join(" · ") || "none"}
              </p>
            </>
          )}
        </div>
      )}
      <SheetSyncRunsCard />
    </>
  );
}

/**
 * Recent sync runs and their tab-level events (§4, §13). Sheet write-back
 * failures (a tab whose managed columns never got stamped — e.g. a protected
 * range blocking the service account, or the tab's grid being too small for
 * the managed columns) are logged as `writeback_error` events with
 * `sheetRowId: null`, so they never show up on any row's own event list and
 * were otherwise invisible anywhere in the hub. This surfaces them.
 */
async function SheetSyncRunsCard() {
  const recentRuns = await prisma.syncRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 10,
  });
  const runIds = recentRuns.map((r) => r.id);
  const syncEvents = runIds.length
    ? await prisma.rowEvent.findMany({
        where: {
          syncRunId: { in: runIds },
          sheetRowId: null,
          eventType: { in: ["tabs_discovered", "tab_error", "writeback_error"] },
        },
        orderBy: { createdAt: "asc" },
      })
    : [];
  const eventsByRun = new Map<string, typeof syncEvents>();
  for (const e of syncEvents) {
    if (!e.syncRunId) continue;
    const list = eventsByRun.get(e.syncRunId) ?? [];
    list.push(e);
    eventsByRun.set(e.syncRunId, list);
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3 className="card-title" style={{ marginTop: 0 }}>Recent sync runs</h3>
      <p className="card-subtitle">
        Tab-level events per run — which tabs were scanned, and any tab read or sheet write-back failure. A tab
        missing its <code>GCD_QBO_Row_ID</code> columns in the workbook will show a <code>writeback_error</code>{" "}
        here with the exact reason (e.g. a protected range blocking the service account, or the tab's grid being
        too small — auto-grown as of §4's ensureGridSize, but shown here regardless if it ever recurs).
      </p>
      <div style={{ display: "grid", gap: 14, marginTop: 12 }}>
        {recentRuns.map((run) => {
          const events = eventsByRun.get(run.id) ?? [];
          const hasError = events.some((e) => e.eventType === "tab_error" || e.eventType === "writeback_error");
          return (
            <div
              key={run.id}
              style={{ borderLeft: `3px solid ${hasError ? "var(--danger, #c0392b)" : "var(--border-subtle)"}`, paddingLeft: 12 }}
            >
              <p className="card-subtitle" style={{ margin: "0 0 4px" }}>
                {run.startedAt.toISOString().slice(0, 16).replace("T", " ")} · <strong>{run.mode}</strong> ·{" "}
                {run.rolloutStage} · {run.status} · scanned {run.rowsScanned}, posted {run.rowsPosted}, errors{" "}
                {run.rowsError}
              </p>
              {events.length === 0 ? (
                <p className="card-subtitle" style={{ margin: 0 }}>No tab-level events recorded.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {events.map((e) => (
                    <li
                      key={e.id}
                      style={{ fontSize: 13, color: e.eventType === "tabs_discovered" ? "inherit" : "var(--danger, #c0392b)" }}
                    >
                      <strong>{e.eventType}</strong>: {e.eventMessage}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
        {recentRuns.length === 0 && <p className="card-subtitle">No sync runs yet.</p>}
      </div>
    </div>
  );
}
