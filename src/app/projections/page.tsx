import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../components/RequireAuth";
import {
  projectCashFlow,
  parseAssumptions,
  summarize,
} from "@/lib/projections/engine";
import { createScenarioAction } from "./actions";

export const dynamic = "force-dynamic";

const inputStyle: React.CSSProperties = {
  padding: "0.3rem",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--panel-2)",
  color: "var(--text)",
  width: "100%",
};

/** Format money as $#,##0.00. */
function money(v: number): string {
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default async function ProjectionsPage({
  searchParams,
}: {
  searchParams: { scenario?: string };
}) {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  const editable = can(user.role, "edit_projections");
  const scenarios = await prisma.projScenario.findMany({
    where: { active: true },
    orderBy: { updatedAt: "desc" },
  });

  const selected =
    scenarios.find((s) => s.id === searchParams.scenario) ?? scenarios[0] ?? null;

  const rows = selected ? projectCashFlow(parseAssumptions(selected.assumptionsJson)) : [];
  const summary = selected ? summarize(rows) : null;

  return (
    <>
      <h1>📈 Financial Projections</h1>
      <p className="sub">
        Project cash-flow forward from a set of assumptions. Prototype module — scenarios are
        stored per assumption set and recomputed on the fly by a pure, unit-tested engine.
      </p>

      {scenarios.length === 0 ? (
        <div className="notice">
          No projection scenarios yet.{" "}
          {editable
            ? "Create your first one with the form below."
            : "An owner_admin needs to create one before projections can be viewed."}
        </div>
      ) : (
        <>
          <h2>Scenarios</h2>
          <div className="row-actions" style={{ flexWrap: "wrap" }}>
            {scenarios.map((s) => (
              <Link
                key={s.id}
                className={`btn ${selected && s.id === selected.id ? "" : "secondary"}`}
                href={`/projections?scenario=${s.id}`}
              >
                {s.name}
              </Link>
            ))}
          </div>

          {selected && summary && (
            <>
              <h2 style={{ marginTop: "1.5rem" }}>{selected.name}</h2>
              {selected.description && <p className="muted">{selected.description}</p>}

              <div className="tiles">
                <div className="tile">
                  <div className="n">{money(summary.endingBalance)}</div>
                  <div className="l">Ending balance</div>
                </div>
                <div className={`tile ${summary.lowestBalance < 0 ? "danger" : ""}`}>
                  <div className="n">{money(summary.lowestBalance)}</div>
                  <div className="l">Lowest balance ({summary.lowestMonthLabel})</div>
                </div>
                <div className="tile">
                  <div className="n">{money(summary.totalNet)}</div>
                  <div className="l">Total net</div>
                </div>
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th>Inflow</th>
                      <th>Outflow</th>
                      <th>Net</th>
                      <th>Ending balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.monthIndex}>
                        <td>{r.label}</td>
                        <td>{money(r.inflow)}</td>
                        <td>{money(r.outflow)}</td>
                        <td>{money(r.net)}</td>
                        <td>
                          {r.endingBalance < 0 ? (
                            <span className="badge danger">{money(r.endingBalance)}</span>
                          ) : (
                            money(r.endingBalance)
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      <h2 style={{ marginTop: "1.5rem" }}>New scenario</h2>
      {editable ? (
        <form action={createScenarioAction} className="card">
          <div className="grid">
            <label className="kv">
              <span>Name</span>
              <input name="name" placeholder="e.g. Base case" style={inputStyle} required />
            </label>
            <label className="kv">
              <span>Description</span>
              <input name="description" placeholder="Optional notes" style={inputStyle} />
            </label>
            <label className="kv">
              <span>Opening balance</span>
              <input name="openingBalance" type="number" step="0.01" defaultValue={0} style={inputStyle} />
            </label>
            <label className="kv">
              <span>Horizon (months, 1–60)</span>
              <input name="horizonMonths" type="number" min={1} max={60} defaultValue={12} style={inputStyle} />
            </label>
            <label className="kv">
              <span>Monthly inflow</span>
              <input name="monthlyInflow" type="number" step="0.01" defaultValue={0} style={inputStyle} />
            </label>
            <label className="kv">
              <span>Monthly outflow</span>
              <input name="monthlyOutflow" type="number" step="0.01" defaultValue={0} style={inputStyle} />
            </label>
            <label className="kv">
              <span>Monthly growth %</span>
              <input name="monthlyGrowthPct" type="number" step="0.01" defaultValue={0} style={inputStyle} />
            </label>
            <label className="kv">
              <span>Start label (e.g. Jul 2026)</span>
              <input name="startLabel" placeholder="Jul 2026" style={inputStyle} />
            </label>
          </div>
          <div className="row-actions" style={{ marginTop: "1rem" }}>
            <button className="btn" type="submit">
              Create scenario
            </button>
          </div>
        </form>
      ) : (
        <p className="muted">
          You are a {user.role}: you can view projections, but only an owner_admin can create or
          edit scenarios.
        </p>
      )}
    </>
  );
}
