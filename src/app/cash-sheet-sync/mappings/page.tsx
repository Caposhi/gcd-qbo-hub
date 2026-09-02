import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../../components/RequireAuth";
import {
  createMappingAction,
  updateMappingAction,
  updateAccountMappingAction,
  seedDefaultMappingsAction,
  autoResolveAccountsFromQboAction,
} from "../actions";
import { getQboEnvironment } from "@/lib/config-store";
import { getContext, listAccounts, QboNotConnectedError } from "@/lib/qbo/client";

export const dynamic = "force-dynamic";

/** On-demand fetch of the connected company's chart of accounts (§14, §16). */
async function loadQboAccounts(): Promise<
  | { ok: true; accounts: Awaited<ReturnType<typeof listAccounts>> }
  | { ok: false; error: string; notConnected: boolean }
> {
  try {
    const environment = await getQboEnvironment();
    const ctx = await getContext(environment);
    const accounts = await listAccounts(ctx);
    accounts.sort((a, b) =>
      (a.FullyQualifiedName ?? a.Name).localeCompare(b.FullyQualifiedName ?? b.Name)
    );
    return { ok: true, accounts };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      notConnected: err instanceof QboNotConnectedError,
    };
  }
}

const inputStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--border-default)",
  background: "#fff",
  color: "var(--text-strong)",
  fontSize: 13,
  width: 140,
};

export default async function MappingsPage({
  searchParams,
}: {
  searchParams: { accounts?: string };
}) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;
  const editable = can(user.role, "edit_mappings");

  const [purposes, accounts] = await Promise.all([
    prisma.purposeMapping.findMany({ orderBy: { normalizedPurpose: "asc" } }),
    prisma.accountMapping.findMany({ orderBy: { friendlyName: "asc" } }),
  ]);

  // Only hit QBO when the admin explicitly asks (?accounts=1) — avoids a network
  // call (and token refresh) on every page load.
  const showQboAccounts = editable && searchParams.accounts === "1";
  const qboAccounts = showQboAccounts ? await loadQboAccounts() : null;

  return (
    <>
      <div className="accent-bar" />
      <h1>Purpose &amp; account mapping</h1>
      <p className="page-desc">
        Admin-editable rules. Resolve each account slot to a real QBO account ID (never rely on names once IDs are
        known). {editable ? "" : "Read-only for your role."}
      </p>

      {purposes.length === 0 && accounts.length === 0 ? (
        <div className="notice info">
          No mappings loaded yet.{" "}
          {editable
            ? "Click “Load default mappings” to seed the German Car Depot purpose & account rules."
            : "An owner_admin needs to load the default mappings first."}
        </div>
      ) : null}

      {editable && (
        <div className="row-actions" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
          <form action={seedDefaultMappingsAction} className="inline">
            <button className="btn primary" type="submit">
              {purposes.length === 0 && accounts.length === 0 ? "Load default mappings" : "Restore default mappings"}
            </button>
          </form>
          <form action={autoResolveAccountsFromQboAction} className="inline">
            <button className="btn secondary" type="submit">Auto-resolve IDs from QBO</button>
          </form>
          <a className="btn secondary" href="?accounts=1">Fetch QBO accounts</a>
          <span className="muted" style={{ alignSelf: "center", fontSize: "0.85rem" }}>
            Auto-resolve matches each slot by name; anything left <em>unresolved</em> you map by hand from the fetched list.
          </span>
        </div>
      )}

      {qboAccounts && (
        <section style={{ marginTop: "1rem" }}>
          <h2>QBO accounts (connected company)</h2>
          {qboAccounts.ok ? (
            <>
              <p className="sub">
                {qboAccounts.accounts.length} active accounts. Copy the <strong>Id</strong> into the matching slot
                below, then press Save. <a href="?">Hide</a>
              </p>
              <div className="table-wrap">
                <table className="gcd">
                  <thead>
                    <tr><th>Id</th><th>Name</th><th>Fully-qualified name</th><th>Type</th><th>Subtype</th></tr>
                  </thead>
                  <tbody>
                    {qboAccounts.accounts.map((a) => (
                      <tr key={a.Id}>
                        <td><span className="badge ok">{a.Id}</span></td>
                        <td>{a.Name}</td>
                        <td className="muted">{a.FullyQualifiedName}</td>
                        <td className="muted">{a.AccountType}</td>
                        <td className="muted">{a.AccountSubType ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="notice">
              {qboAccounts.notConnected
                ? "QBO isn’t connected yet — connect it under Settings, then try again."
                : `Couldn’t fetch accounts: ${qboAccounts.error}`}
            </div>
          )}
        </section>
      )}

      <h2>Account mappings</h2>
      <div className="table-wrap">
        <table className="gcd">
          <thead>
            <tr><th>Friendly name</th><th>QBO account name</th><th>QBO account ID</th><th></th></tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id}>
                <td>{a.friendlyName}</td>
                <td className="muted">{a.qboAccountName}</td>
                <td>
                  {a.qboAccountId ? (
                    <span className="badge ok">{a.qboAccountId}</span>
                  ) : (
                    <span className="badge warn">unresolved</span>
                  )}
                </td>
                <td>
                  {editable && (
                    <form action={updateAccountMappingAction} className="inline">
                      <input type="hidden" name="id" value={a.id} />
                      <input name="qboAccountId" placeholder="QBO Id" defaultValue={a.qboAccountId ?? ""} style={inputStyle} />
                      <button className="btn secondary" type="submit">Save</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Purpose mappings</h2>

      {editable && (
        <div className="card" style={{ marginBottom: "1rem" }}>
          <h3 className="card-title" style={{ marginBottom: 6 }}>Add a new purpose mapping</h3>
          <p className="card-subtitle" style={{ marginTop: 0, marginBottom: 12 }}>
            Teach a purpose word the hub doesn't know yet — e.g. a payee name used as a stand-in Purpose (like "JR
            SRVCS") on rows the sheet leaves blank, resolved via an internal override (row detail page). Matching is
            exact (case/whitespace-insensitive) against this text. Leave the QBO account ID blank and fill it in
            after — via "Auto-resolve IDs from QBO" (if the account name matches exactly) or by pasting the ID from
            "Fetch QBO accounts" below.
          </p>
          <form action={createMappingAction} className="row-actions" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
            <input className="input" name="purposePattern" placeholder='Purpose text, e.g. "JR SRVCS"' required style={{ minWidth: 160 }} />
            <select name="amountType" defaultValue="amount_paid_out" style={inputStyle}>
              <option value="">Any amount column</option>
              <option value="amt_collected">Amt Collected</option>
              <option value="amount_paid_out">Amount Paid Out</option>
              <option value="bank_deposit">Bank Deposit</option>
            </select>
            <select name="qboAction" defaultValue="expense" style={inputStyle}>
              <option value="expense">Expense (money leaves Cash on hand)</option>
              <option value="deposit">Deposit (money enters Cash on hand)</option>
              <option value="transfer">Transfer (Bank Deposit → Chase)</option>
              <option value="audit_only">Audit only (customer invoice cash)</option>
            </select>
            <input className="input" name="qboAccountName" placeholder="QBO category account name (optional for now)" style={{ minWidth: 220 }} />
            <input className="input" name="qboAccountId" placeholder="QBO account ID (optional for now)" style={{ minWidth: 140 }} />
            <label className="muted" style={{ fontSize: "0.85rem" }}>
              <input type="checkbox" name="requiresPayee" /> requires payee
            </label>
            <label className="muted" style={{ fontSize: "0.85rem" }}>
              <input type="checkbox" name="requiresManualApproval" /> requires manual approval
            </label>
            <button className="btn primary" type="submit">Add mapping</button>
          </form>
        </div>
      )}

      <div className="table-wrap">
        <table className="gcd">
          <thead>
            <tr>
              <th>Pattern</th><th>Amount type</th><th>Action</th><th>Category account</th>
              <th>Account ID</th><th>Audit only</th><th>Manual approval</th><th>Active</th><th></th>
            </tr>
          </thead>
          <tbody>
            {purposes.map((p) => (
              <tr key={p.id}>
                <td><code>{p.purposePattern}</code></td>
                <td className="muted">{p.amountType ?? "any"}</td>
                <td>{p.qboAction}</td>
                <td className="muted">{p.qboAccountName ?? "—"}</td>
                <td>
                  {editable && !p.auditOnly ? (
                    <span />
                  ) : p.qboAccountId ? (
                    <span className="badge ok">{p.qboAccountId}</span>
                  ) : p.auditOnly ? (
                    <span className="badge muted">n/a</span>
                  ) : (
                    <span className="badge warn">unresolved</span>
                  )}
                  {editable && !p.auditOnly && (
                    <form action={updateMappingAction} className="inline">
                      <input type="hidden" name="id" value={p.id} />
                      <input name="qboAccountId" placeholder="QBO Id" defaultValue={p.qboAccountId ?? ""} style={{ ...inputStyle, width: 90 }} />
                      <label className="muted" style={{ fontSize: "0.75rem" }}>
                        <input type="checkbox" name="requiresManualApproval" defaultChecked={p.requiresManualApproval} /> appr
                      </label>
                      <label className="muted" style={{ fontSize: "0.75rem" }}>
                        <input type="checkbox" name="active" defaultChecked={p.active} /> active
                      </label>
                      <button className="btn secondary" type="submit">Save</button>
                    </form>
                  )}
                </td>
                <td>{p.auditOnly ? "✓" : ""}</td>
                <td>{p.requiresManualApproval ? "✓" : ""}</td>
                <td>{p.active ? "✓" : ""}</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
