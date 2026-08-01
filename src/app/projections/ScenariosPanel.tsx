/**
 * Scenarios tab (prototype) — the original manual-assumption cash-flow engine,
 * preserved verbatim so nothing regresses while the Reporting tab is built out.
 * Reachable via the sub-tab on /projections?tab=scenarios (§ Phase 1 scope).
 */
import Link from "next/link";
import { prisma } from "@/lib/db";
import { can } from "@/lib/auth/roles";
import type { SessionUser } from "@/lib/auth/session";
import { projectCashFlow, parseAssumptions, summarize } from "@/lib/projections/engine";
import { createScenarioAction } from "./actions";

function money(v: number): string {
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export async function ScenariosPanel({
  user,
  selectedScenarioId,
}: {
  user: SessionUser;
  selectedScenarioId?: string;
}) {
  const editable = can(user.role, "edit_projections");
  const scenarios = await prisma.projScenario.findMany({
    where: { active: true },
    orderBy: { updatedAt: "desc" },
  });

  const selected =
    scenarios.find((s) => s.id === selectedScenarioId) ?? scenarios[0] ?? null;

  const rows = selected ? projectCashFlow(parseAssumptions(selected.assumptionsJson)) : [];
  const summary = selected ? summarize(rows) : null;

  return (
    <>
      <p className="page-desc">
        Project cash-flow forward from a set of assumptions. Prototype module — scenarios are
        stored per assumption set and recomputed on the fly by a pure, unit-tested engine.
      </p>

      {scenarios.length === 0 ? (
        <div className="notice info">
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
                href={`/projections?tab=scenarios&scenario=${s.id}`}
              >
                {s.name}
              </Link>
            ))}
          </div>

          {selected && summary && (
            <>
              <h2 style={{ marginTop: "1.5rem" }}>{selected.name}</h2>
              {selected.description && <p className="muted">{selected.description}</p>}

              <div className="kpi-grid">
                <div className="kpi-card">
                  <div className="kpi-label">Ending balance</div>
                  <div className="kpi-value">{money(summary.endingBalance)}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Lowest balance ({summary.lowestMonthLabel})</div>
                  <div className="kpi-value">{money(summary.lowestBalance)}</div>
                  {summary.lowestBalance < 0 && (
                    <div className="kpi-foot"><span className="delta down">negative</span></div>
                  )}
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Total net</div>
                  <div className="kpi-value">{money(summary.totalNet)}</div>
                </div>
              </div>

              <div className="table-wrap" style={{ marginTop: 16 }}>
                <table className="gcd">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th className="num">Inflow</th>
                      <th className="num">Outflow</th>
                      <th className="num">Net</th>
                      <th className="num">Ending balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.monthIndex}>
                        <td>{r.label}</td>
                        <td className="num">{money(r.inflow)}</td>
                        <td className="num">{money(r.outflow)}</td>
                        <td className="num">{money(r.net)}</td>
                        <td className="num">
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
            <div className="field">
              <label>Name</label>
              <input className="input" name="name" placeholder="e.g. Base case" required />
            </div>
            <div className="field">
              <label>Description</label>
              <input className="input" name="description" placeholder="Optional notes" />
            </div>
            <div className="field">
              <label>Opening balance</label>
              <input className="input" name="openingBalance" type="number" step="0.01" defaultValue={0} />
            </div>
            <div className="field">
              <label>Horizon (months, 1–60)</label>
              <input className="input" name="horizonMonths" type="number" min={1} max={60} defaultValue={12} />
            </div>
            <div className="field">
              <label>Monthly inflow</label>
              <input className="input" name="monthlyInflow" type="number" step="0.01" defaultValue={0} />
            </div>
            <div className="field">
              <label>Monthly outflow</label>
              <input className="input" name="monthlyOutflow" type="number" step="0.01" defaultValue={0} />
            </div>
            <div className="field">
              <label>Monthly growth %</label>
              <input className="input" name="monthlyGrowthPct" type="number" step="0.01" defaultValue={0} />
            </div>
            <div className="field">
              <label>Start label (e.g. Jul 2026)</label>
              <input className="input" name="startLabel" placeholder="Jul 2026" />
            </div>
          </div>
          <div className="row-actions" style={{ marginTop: "1rem" }}>
            <button className="btn primary" type="submit">
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
