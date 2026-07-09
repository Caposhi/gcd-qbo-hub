import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../../components/RequireAuth";
import { updateMappingAction, updateAccountMappingAction, seedDefaultMappingsAction } from "../actions";

export const dynamic = "force-dynamic";

const inputStyle: React.CSSProperties = {
  padding: "0.3rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  color: "var(--text)",
  width: 140,
};

export default async function MappingsPage() {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;
  const editable = can(user.role, "edit_mappings");

  const [purposes, accounts] = await Promise.all([
    prisma.purposeMapping.findMany({ orderBy: { normalizedPurpose: "asc" } }),
    prisma.accountMapping.findMany({ orderBy: { friendlyName: "asc" } }),
  ]);

  return (
    <>
      <h1>Purpose & Account Mapping</h1>
      <p className="sub">
        Admin-editable rules. Resolve each account slot to a real QBO account ID (never rely on names once IDs are
        known). {editable ? "" : "Read-only for your role."}
      </p>

      {purposes.length === 0 && accounts.length === 0 ? (
        <div className="notice">
          No mappings loaded yet.{" "}
          {editable
            ? "Click “Load default mappings” to seed the German Car Depot purpose & account rules."
            : "An owner_admin needs to load the default mappings first."}
        </div>
      ) : null}

      {editable && (
        <form action={seedDefaultMappingsAction} className="row-actions">
          <button className="btn" type="submit">
            {purposes.length === 0 && accounts.length === 0 ? "Load default mappings" : "Restore default mappings"}
          </button>
          <span className="muted" style={{ alignSelf: "center", fontSize: "0.85rem" }}>
            Idempotent — never overwrites a resolved QBO account ID.
          </span>
        </form>
      )}

      <h2>Account mappings</h2>
      <div className="table-wrap">
        <table>
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
      <div className="table-wrap">
        <table>
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
