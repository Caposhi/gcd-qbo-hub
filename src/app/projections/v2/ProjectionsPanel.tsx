/**
 * Projections tab (engine v2, Phase 2) — server component.
 *
 * Shows the regression-derived baseline (each coefficient with its confidence
 * signal — R² + sample size), lets the user spin up a scenario from the library
 * and override any default (no black boxes), and renders the forward projection,
 * runway, and a sensitivity/tornado view. The v1 prototype lives on its own tab.
 */
import Link from "next/link";
import { prisma } from "@/lib/db";
import { can } from "@/lib/auth/roles";
import type { SessionUser } from "@/lib/auth/session";
import { loadBaseline } from "@/lib/projections/baseline-service";
import { parseScenarioV2, isScenarioV2 } from "@/lib/projections/scenario";
import {
  projectFinancials,
  summarizeV2,
  tornado,
  type HybridCoefficient,
} from "@/lib/projections/engine-v2";
import { availableTemplates, deferredTemplates } from "@/lib/projections/scenarios";
import type { Confidence } from "@/lib/projections/regression/ols";
import { money, percent } from "../reporting/format";
import { createScenarioV2Action, updateScenarioV2Action } from "../actions";
import { ProjectionChart, TornadoChart } from "./ProjectionCharts";

function confBadge(conf: Confidence): { cls: string; label: string } {
  if (conf === "strong") return { cls: "ok", label: "strong" };
  if (conf === "moderate") return { cls: "warn", label: "moderate" };
  return { cls: "muted", label: "weak" };
}

function confidenceFromCoef(c: HybridCoefficient): Confidence {
  const r2 = c.r2 ?? 0;
  const n = c.n ?? 0;
  if (n < 3) return "weak";
  if (r2 >= 0.7 && n >= 6) return "strong";
  if (r2 >= 0.4 && n >= 4) return "moderate";
  return "weak";
}

export async function ProjectionsPanel({
  user,
  selectedScenarioId,
}: {
  user: SessionUser;
  selectedScenarioId?: string;
}) {
  const editable = can(user.role, "edit_projections");
  const baselineRes = await loadBaseline(new Date(), { months: 24 });

  const allScenarios = await prisma.projScenario.findMany({
    where: { active: true },
    orderBy: { updatedAt: "desc" },
  });
  const scenarios = allScenarios.filter((s) => isScenarioV2(s.assumptionsJson));
  const selected = scenarios.find((s) => s.id === selectedScenarioId) ?? null;

  return (
    <>
      <p className="page-desc">
        Forward scenario modeling. Baseline coefficients are derived from your own QuickBooks
        history by auditable regression, shown as editable defaults with a confidence signal — override
        any of them. Read-only over QBO; nothing is written back.
      </p>

      {/* Derived baseline */}
      {baselineRes.connected ? (
        <div className="card">
          <h3 className="card-title" style={{ marginTop: 0 }}>Derived baseline</h3>
          <p className="card-subtitle">
            {baselineRes.baseline.months} months ({baselineRes.range.start} → {baselineRes.range.end},{" "}
            {baselineRes.method})
          </p>
          <div className="table-wrap" style={{ marginTop: 12 }}>
            <table className="gcd">
              <thead>
                <tr>
                  <th>Coefficient</th>
                  <th className="num">Derived value</th>
                  <th>Confidence</th>
                  <th>Basis</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ["Revenue growth / mo", percent(baselineRes.baseline.revenueGrowthMonthlyPct.value), baselineRes.baseline.revenueGrowthMonthlyPct],
                    ["COGS % of revenue", percent(baselineRes.baseline.cogsPctOfRevenue.value), baselineRes.baseline.cogsPctOfRevenue],
                    ["Fixed OpEx / mo", money(baselineRes.baseline.opexFixedMonthly.value), baselineRes.baseline.opexFixedMonthly],
                    ["Variable OpEx %", percent(baselineRes.baseline.opexVarPctOfRevenue.value), baselineRes.baseline.opexVarPctOfRevenue],
                  ] as const
                ).map(([label, valueStr, coef]) => {
                  const b = confBadge(coef.confidence);
                  return (
                    <tr key={label}>
                      <td>{label}</td>
                      <td className="num">{valueStr}</td>
                      <td>
                        <span className={`badge ${b.cls}`}>{b.label}</span>{" "}
                        <span className="card-subtitle" style={{ display: "inline" }}>
                          R² {coef.r2.toFixed(2)} · n={coef.n}
                        </span>
                      </td>
                      <td className="card-subtitle">{coef.basis}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="card-subtitle" style={{ marginTop: 12, marginBottom: 0 }}>
            Latest monthly revenue {money(baselineRes.baseline.latestMonthlyRevenue, { compact: true })} · gross
            margin {percent(baselineRes.baseline.grossMarginPct)} · net margin{" "}
            {percent(baselineRes.baseline.netMarginPct)}
            {baselineRes.baseline.partsPctOfRevenue !== null && (
              <>
                {" "}
                · mix {percent(baselineRes.baseline.partsPctOfRevenue)} parts /{" "}
                {percent(baselineRes.baseline.laborPctOfRevenue ?? 0)} labor
              </>
            )}
          </p>
        </div>
      ) : baselineRes.reason === "reconnect_required" ? (
        <div className="notice danger">
          QuickBooks rejected the saved connection (its token expired or was revoked) and there’s no
          cached history, so a baseline can’t be derived yet. An owner needs to reconnect QuickBooks in{" "}
          <Link href="/cash-sheet-sync/settings">Settings &amp; rollout</Link>. You can still open the
          Scenarios tab for the manual prototype. Nothing was changed in QuickBooks.
        </div>
      ) : (
        <div className="notice danger">
          QuickBooks isn’t connected (and no cached history exists), so a baseline can’t be derived
          yet. An owner needs to connect QBO in{" "}
          <Link href="/cash-sheet-sync/settings">Settings &amp; rollout</Link>. You can still open the
          Scenarios tab for the manual prototype.
        </div>
      )}

      {/* Scenario library */}
      <h2 style={{ marginTop: "1.5rem" }}>Scenario library</h2>
      {editable && baselineRes.connected ? (
        <div className="row-actions" style={{ flexWrap: "wrap" }}>
          {availableTemplates().map((t) => (
            <form key={t.id} action={createScenarioV2Action}>
              <input type="hidden" name="templateId" value={t.id} />
              <button className="btn secondary" type="submit" title={t.description}>
                + {t.name}
              </button>
            </form>
          ))}
        </div>
      ) : (
        <p className="muted">
          {baselineRes.connected
            ? "You can view scenarios, but only an owner_admin can create or edit them."
            : "Connect QBO to create scenarios."}
        </p>
      )}
      <p className="muted" style={{ fontSize: "0.78rem" }}>
        Coming with Tekmetric (Phase 4):{" "}
        {deferredTemplates().map((t) => t.name).join(" · ")}.
      </p>

      {/* Saved scenarios */}
      {scenarios.length > 0 && (
        <div className="row-actions" style={{ flexWrap: "wrap" }}>
          {scenarios.map((s) => (
            <Link
              key={s.id}
              className={`btn ${selected && s.id === selected.id ? "" : "secondary"}`}
              href={`/projections?tab=projections&scenario=${s.id}`}
            >
              {s.name}
            </Link>
          ))}
        </div>
      )}

      {selected && <ScenarioDetail scenario={selected} editable={editable} />}
    </>
  );
}

function ScenarioDetail({
  scenario,
  editable,
}: {
  scenario: { id: string; name: string; assumptionsJson: unknown };
  editable: boolean;
}) {
  const inputs = parseScenarioV2(scenario.assumptionsJson);
  const rows = projectFinancials(inputs);
  const summary = summarizeV2(rows);
  const bars = tornado(inputs, "endingCash", 0.1);
  const c = inputs.coefficients;

  const chartRows = rows.map((r) => ({ label: r.label, netIncome: r.netIncome, endingCash: r.endingCash }));
  const tornadoData = bars.map((b) => ({ label: b.label, swing: b.swing, low: b.low, high: b.high, base: b.base }));

  const overrideRow = (
    label: string,
    coef: HybridCoefficient,
    name: string,
    kind: "pct" | "money",
    step: string
  ) => {
    const conf = confBadge(confidenceFromCoef(coef));
    const derivedStr = kind === "pct" ? percent(coef.derived) : money(coef.derived);
    return (
      <div className="field" key={name}>
        <label>
          {label}{" "}
          <span className="card-subtitle" style={{ display: "inline" }}>
            derived {derivedStr} · <span className={`badge ${conf.cls}`}>{conf.label}</span>
          </span>
        </label>
        <input
          className="input"
          name={name}
          type="number"
          step={step}
          defaultValue={coef.override ?? ""}
          placeholder={`derived ${coef.derived}`}
          disabled={!editable}
        />
      </div>
    );
  };

  return (
    <>
      <h2 style={{ marginTop: "1.5rem" }}>{scenario.name}</h2>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Ending cash</div>
          <div className="kpi-value">{money(summary.endingCash, { compact: true })}</div>
          {summary.endingCash < 0 && (
            <div className="kpi-foot"><span className="delta down">Negative</span></div>
          )}
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Lowest ({summary.lowestMonthLabel})</div>
          <div className="kpi-value">{money(summary.lowestCash, { compact: true })}</div>
          {summary.lowestCash < 0 && (
            <div className="kpi-foot"><span className="delta down">Below zero</span></div>
          )}
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Cash-out month</div>
          <div className="kpi-value">{summary.runwayMonths !== null ? `${summary.runwayMonths} mo` : "—"}</div>
          {summary.runwayMonths !== null && (
            <div className="kpi-foot"><span className="delta down">Runs out</span></div>
          )}
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Total net income</div>
          <div className="kpi-value">{money(summary.totalNetIncome, { compact: true })}</div>
          {summary.totalNetIncome < 0 && (
            <div className="kpi-foot"><span className="delta down">Negative</span></div>
          )}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))" }}>
        <div className="card" style={{ minWidth: 0 }}>
          <h3 className="card-title" style={{ marginTop: 0 }}>Projection</h3>
          <ProjectionChart data={chartRows} />
        </div>
        <div className="card" style={{ minWidth: 0 }}>
          <h3 className="card-title" style={{ marginTop: 0 }}>Sensitivity — what moves ending cash most</h3>
          <TornadoChart data={tornadoData} metricLabel="Ending cash" />
        </div>
      </div>

      {/* Overrides + levers */}
      <form action={updateScenarioV2Action} className="card">
        <input type="hidden" name="id" value={scenario.id} />
        <h3 className="card-title" style={{ marginTop: 0 }}>Assumptions {editable ? "(override the derived defaults)" : "(read-only)"}</h3>
        <div className="grid" style={{ marginTop: 12 }}>
          <div className="field">
            <label>Name</label>
            <input className="input" name="name" defaultValue={scenario.name} disabled={!editable} />
          </div>
          <div className="field">
            <label>Opening cash</label>
            <input className="input" name="openingCash" type="number" step="0.01" defaultValue={inputs.openingCash} disabled={!editable} />
          </div>
          <div className="field">
            <label>Start monthly revenue</label>
            <input className="input" name="startMonthlyRevenue" type="number" step="0.01" defaultValue={inputs.startMonthlyRevenue} disabled={!editable} />
          </div>
          <div className="field">
            <label>Horizon (months, 1–120)</label>
            <input className="input" name="horizonMonths" type="number" min={1} max={120} defaultValue={inputs.horizonMonths} disabled={!editable} />
          </div>
          {overrideRow("Revenue growth / mo (e.g. 0.02)", c.revenueGrowthMonthlyPct, "override_growth", "pct", "0.001")}
          {overrideRow("COGS % of revenue (e.g. 0.4)", c.cogsPctOfRevenue, "override_cogs", "pct", "0.001")}
          {overrideRow("Fixed OpEx / mo", c.opexFixedMonthly, "override_opexFixed", "money", "0.01")}
          {overrideRow("Variable OpEx % (e.g. 0.1)", c.opexVarPctOfRevenue, "override_opexVar", "pct", "0.001")}
        </div>

        <h3 className="card-title" style={{ marginTop: 20 }}>Levers</h3>
        <div className="grid" style={{ marginTop: 12 }}>
          <div className="field">
            <label>Capex / one-off ($, +in / −out)</label>
            <input className="input" name="capex_amount" type="number" step="0.01" defaultValue={inputs.oneOffs?.[0]?.amount ?? ""} disabled={!editable} />
          </div>
          <div className="field">
            <label>…in month #</label>
            <input className="input" name="capex_month" type="number" min={0} defaultValue={inputs.oneOffs?.[0]?.monthIndex ?? 0} disabled={!editable} />
          </div>
          <div className="field">
            <label>Monthly OpEx change ($, hiring +/ firing −)</label>
            <input className="input" name="opexadj_amount" type="number" step="0.01" defaultValue={inputs.opexAdjustments?.[0]?.amount ?? ""} disabled={!editable} />
          </div>
          <div className="field">
            <label>…from month #</label>
            <input className="input" name="opexadj_month" type="number" min={0} defaultValue={inputs.opexAdjustments?.[0]?.monthIndex ?? 0} disabled={!editable} />
          </div>
          <div className="field">
            <label>Revenue uplift (fraction, e.g. 0.2)</label>
            <input className="input" name="uplift_pct" type="number" step="0.01" defaultValue={inputs.revenueUpliftPct?.[0]?.amount ?? ""} disabled={!editable} />
          </div>
          <div className="field">
            <label>…from month #</label>
            <input className="input" name="uplift_month" type="number" min={0} defaultValue={inputs.revenueUpliftPct?.[0]?.monthIndex ?? 0} disabled={!editable} />
          </div>
        </div>

        {editable && (
          <div className="row-actions" style={{ marginTop: "1rem" }}>
            <button className="btn primary" type="submit">Save &amp; recompute</button>
          </div>
        )}
      </form>

      <div className="table-wrap">
        <table className="gcd">
          <thead>
            <tr>
              <th>Month</th>
              <th className="num">Revenue</th>
              <th className="num">Gross profit</th>
              <th className="num">OpEx</th>
              <th className="num">Net income</th>
              <th className="num">Ending cash</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.monthIndex}>
                <td>{r.label}</td>
                <td className="num">{money(r.revenue)}</td>
                <td className="num">{money(r.grossProfit)}</td>
                <td className="num">{money(r.opex)}</td>
                <td className="num">{money(r.netIncome)}</td>
                <td className="num">
                  {r.endingCash < 0 ? <span className="badge danger">{money(r.endingCash)}</span> : money(r.endingCash)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
