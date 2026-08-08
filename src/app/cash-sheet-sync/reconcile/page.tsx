import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../../components/RequireAuth";
import { DateRangeFilter } from "../../components/DateRangeFilter";
import { resolveDateRange, describeDateRange } from "@/lib/cashsheet/date-range";
import { fullyExplained, type ReconciliationSummary } from "@/lib/cashsheet/reconciliation";
import { runReconciliationCheckAction } from "../actions";

export const dynamic = "force-dynamic";

function money(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "";
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

interface RegisterTxnJson {
  id: string;
  type: string;
  date: string;
  amount: number;
  direction: "in" | "out";
  privateNote: string;
  docNumber: string | null;
  payee: string | null;
}

interface MissingRowJson {
  id: string;
  tabName: string;
  rowNumberLastSeen: number;
  date: string | null;
  name: string | null;
  purpose: string | null;
  direction: "in" | "out";
  amount: number;
}

interface BlockedRowJson {
  id: string;
  tabName: string;
  rowNumberLastSeen: number;
  date: string | null;
  name: string | null;
  purpose: string | null;
  status: string;
  statusReason: string | null;
}

interface CheckResult {
  range: string;
  startStr: string;
  endStr: string;
  beginningBalance: number | null;
  endingBalance: number | null;
  register: RegisterTxnJson[];
  foreign: RegisterTxnJson[];
  missingRows: MissingRowJson[];
  blockedRows: BlockedRowJson[];
  summary: ReconciliationSummary;
  explained: boolean | null;
}

export default async function ReconcilePage({
  searchParams,
}: {
  searchParams: { range?: string; from?: string; to?: string };
}) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;
  const canRun = can(user.role, "recheck_qbo_match");

  const activeRange = searchParams.range ?? "this_month";
  const customFrom = searchParams.from ?? "";
  const customTo = searchParams.to ?? "";
  const resolvedRange = resolveDateRange(activeRange, { customFrom, customTo });

  const [lastCheck, lastError] = await Promise.all([
    prisma.rowEvent.findFirst({ where: { eventType: "reconciliation_check" }, orderBy: { createdAt: "desc" } }),
    prisma.rowEvent.findFirst({ where: { eventType: "reconciliation_error" }, orderBy: { createdAt: "desc" } }),
  ]);
  const result = (lastCheck?.diffJson as unknown as CheckResult | undefined) ?? null;
  // Only show the stale-error notice if it's newer than the last successful check.
  const showError = lastError && (!lastCheck || lastError.createdAt > lastCheck.createdAt);

  return (
    <>
      <div className="accent-bar" />
      <h1>Reconciliation assistant</h1>
      <p className="page-desc">
        Pulls the live QBO Cash-on-hand register for a period and cross-references it against every transaction the
        hub has ever posted, by transaction id. A register transaction that doesn&apos;t match anything the hub
        created is <strong>foreign</strong> — this is what would have caught July&apos;s recurring &quot;Jose&quot;
        QBO template on day one instead of a month later. A validated, ready-to-post hub row dated in the period that
        hasn&apos;t posted yet is <strong>missing</strong>. Read-only — this page never posts, edits, or deletes
        anything in QBO.
      </p>
      <div className="notice warn">
        <strong>Known gap:</strong> only Purchases and Deposits are checked against the register — QBO Transfers
        aren&apos;t fetched yet (there was no existing, tested example of that query anywhere in this codebase to
        build on safely). If the sheet starts posting real Bank Deposit (transfer) rows, this needs extending before
        it can be trusted for those.
      </div>

      {/* DateRangeFilter renders its own <form> for a custom range, so it must
          stay outside the reconciliation form below — forms cannot nest. Its
          pills are plain links; the state they set (activeRange/customFrom/
          customTo) is carried into the action form via hidden fields. */}
      <DateRangeFilter
        activePreset={activeRange}
        customFrom={customFrom}
        customTo={customTo}
        hrefFor={(preset) => {
          const p = new URLSearchParams();
          if (preset !== "all") p.set("range", preset);
          const s = p.toString();
          return `/cash-sheet-sync/reconcile${s ? `?${s}` : ""}`;
        }}
      />
      <p className="card-subtitle" style={{ margin: "6px 0 12px" }}>
        Period: <strong>{describeDateRange(activeRange, resolvedRange)}</strong>
        {activeRange === "all" && " — pick a bounded period below; \"All time\" can't be checked in one QBO call."}
      </p>

      <form action={runReconciliationCheckAction} style={{ marginTop: 16 }}>
        {activeRange !== "custom" && <input type="hidden" name="range" value={activeRange} />}
        {activeRange === "custom" && (
          <>
            <input type="hidden" name="range" value="custom" />
            <input type="hidden" name="from" value={customFrom} />
            <input type="hidden" name="to" value={customTo} />
          </>
        )}
        <div className="row-actions" style={{ marginBottom: 8 }}>
          <label className="card-subtitle" style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
            Statement beginning balance (optional)
            <input className="input" type="number" step="0.01" name="beginningBalance" style={{ width: 120 }} defaultValue={result?.beginningBalance ?? ""} />
          </label>
          <label className="card-subtitle" style={{ display: "flex", alignItems: "center", gap: 6, margin: 0 }}>
            Statement ending balance (optional)
            <input className="input" type="number" step="0.01" name="endingBalance" style={{ width: 120 }} defaultValue={result?.endingBalance ?? ""} />
          </label>
        </div>
        <p className="card-subtitle" style={{ marginTop: 0 }}>
          Give both to also see whether the foreign + missing findings fully explain the gap between the real
          (physical/bank) balance and QBO&apos;s book — exactly the number QBO&apos;s own Reconcile screen shows, but
          attributed to specific transactions instead of one unexplained difference.
        </p>
        <button className="btn primary" type="submit" disabled={!canRun}>
          Run reconciliation check
        </button>
      </form>

      {showError && (
        <div className="notice danger" style={{ marginTop: 16 }}>
          {lastError!.eventMessage} · {lastError!.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC
        </div>
      )}

      {result && (
        <>
          <h2 style={{ fontSize: 18, margin: "24px 0 10px" }}>
            Last check: {result.startStr} → {result.endStr}
          </h2>
          <p className="card-subtitle" style={{ marginTop: 0 }}>
            {lastCheck!.createdAt.toISOString().replace("T", " ").slice(0, 19)} UTC · {result.register.length}{" "}
            register transactions
          </p>

          <div className="kpi-grid" style={{ marginBottom: 20 }}>
            <div className="kpi-card">
              <div className="kpi-label">Register net</div>
              <div className="kpi-value">{money(result.summary.registerNet)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Hub-matched net</div>
              <div className="kpi-value">{money(result.summary.hubMatchedNet)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Foreign net ({result.foreign.length})</div>
              <div className="kpi-value">{money(result.summary.foreignNet)}</div>
              {result.foreign.length > 0 && (
                <div className="kpi-foot"><span className="badge danger">needs attention</span></div>
              )}
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Missing net ({result.missingRows.length})</div>
              <div className="kpi-value">{money(result.summary.missingNet)}</div>
              {result.missingRows.length > 0 && (
                <div className="kpi-foot"><span className="badge warn">needs attention</span></div>
              )}
            </div>
            {result.summary.residual !== null && (
              <div className="kpi-card">
                <div className="kpi-label">Residual (true − book)</div>
                <div className="kpi-value">{money(result.summary.residual)}</div>
                <div className="kpi-foot">
                  <span className={`badge ${result.explained ? "ok" : "danger"}`}>
                    {result.explained ? "fully explained by findings" : "NOT fully explained — something else is off"}
                  </span>
                </div>
              </div>
            )}
          </div>

          <h3 style={{ fontSize: 16, margin: "20px 0 8px" }}>Foreign transactions ({result.foreign.length})</h3>
          {result.foreign.length === 0 ? (
            <p className="card-subtitle">
              Every register transaction in this period matches a hub-posted row. Nothing unexplained.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="gcd">
                <thead>
                  <tr><th>Date</th><th>Type</th><th>Payee</th><th className="num">Amount</th><th>Memo</th><th>QBO Txn</th></tr>
                </thead>
                <tbody>
                  {result.foreign.map((t) => (
                    <tr key={t.id}>
                      <td>{t.date}</td>
                      <td>{t.type}</td>
                      <td>{t.payee ?? ""}</td>
                      <td className="num">{t.direction === "out" ? "-" : ""}{money(t.amount)}</td>
                      <td style={{ fontSize: "0.8rem" }} className="muted">{t.privateNote || "(no memo)"}</td>
                      <td>{t.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 style={{ fontSize: 16, margin: "24px 0 8px" }}>Missing hub postings ({result.missingRows.length})</h3>
          {result.missingRows.length === 0 ? (
            <p className="card-subtitle">Every valid, ready-to-post row in this period has posted.</p>
          ) : (
            <div className="table-wrap">
              <table className="gcd">
                <thead>
                  <tr><th>Tab</th><th>Row</th><th>Date</th><th>Name</th><th>Purpose</th><th className="num">Would-be amount</th><th></th></tr>
                </thead>
                <tbody>
                  {result.missingRows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.tabName}</td>
                      <td><Link href={`/cash-sheet-sync/rows/${r.id}`}>{r.rowNumberLastSeen}</Link></td>
                      <td>{r.date ? r.date.slice(0, 10) : ""}</td>
                      <td>{r.name}</td>
                      <td>{r.purpose}</td>
                      <td className="num">{r.direction === "out" ? "-" : ""}{money(r.amount)}</td>
                      <td><Link href={`/cash-sheet-sync/rows/${r.id}`}>Review →</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result.blockedRows.length > 0 && (
            <>
              <h3 style={{ fontSize: 16, margin: "24px 0 8px" }}>
                Blocked rows in this period ({result.blockedRows.length})
              </h3>
              <p className="card-subtitle" style={{ marginTop: 0 }}>
                Errored, unknown-purpose, or unmapped rows dated in this period — not counted in "Missing net" above
                since their amount/direction can't be trusted until fixed.
              </p>
              <div className="table-wrap">
                <table className="gcd">
                  <thead>
                    <tr><th>Tab</th><th>Row</th><th>Date</th><th>Name</th><th>Status</th><th>Reason</th></tr>
                  </thead>
                  <tbody>
                    {result.blockedRows.map((r) => (
                      <tr key={r.id}>
                        <td>{r.tabName}</td>
                        <td><Link href={`/cash-sheet-sync/rows/${r.id}`}>{r.rowNumberLastSeen}</Link></td>
                        <td>{r.date ? r.date.slice(0, 10) : ""}</td>
                        <td>{r.name}</td>
                        <td><span className="badge danger">{r.status}</span></td>
                        <td className="muted" style={{ fontSize: "0.8rem" }}>{r.statusReason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {!result && !showError && (
        <p className="card-subtitle" style={{ marginTop: 20 }}>
          No check has been run yet. Pick a period above and click "Run reconciliation check".
        </p>
      )}
    </>
  );
}
