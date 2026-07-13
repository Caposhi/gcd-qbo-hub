/**
 * AI Council tab (Phase 3) — server component.
 *
 * Renders the C-suite's structured output with progressive disclosure: a
 * one-line takeaway → 2–4 insight bullets → an expandable full memo (native
 * <details>, no client JS). The CEO synthesis leads; the six officers follow;
 * the independent layer (Al the auditor + the Board's long-form report) is shown
 * apart, reflecting the firewall. Owners can trigger a full monthly run or a
 * cheap single-officer run on demand.
 */
import Link from "next/link";
import { prisma } from "@/lib/db";
import { can } from "@/lib/auth/roles";
import type { SessionUser } from "@/lib/auth/session";
import { isCouncilConfigured } from "@/lib/ai/client";
import { parseInsight, parseBoardReport, type AgentInsight } from "@/lib/ai/insights";
import { debatingOfficers, ceo, auditor } from "@/lib/ai/personas";
import { runOnDemandAgentAction, runMonthlyCouncilAction } from "./actions";

function ConfidenceBadge({ c }: { c: AgentInsight["confidence"] }) {
  const cls = c === "high" ? "ok" : c === "low" ? "danger" : "warn";
  return <span className={`badge ${cls}`}>{c} confidence</span>;
}

function InsightCard({
  name,
  title,
  insight,
  accent,
}: {
  name: string;
  title: string;
  insight: AgentInsight;
  accent?: boolean;
}) {
  return (
    <div className="card" style={accent ? { borderColor: "var(--accent)" } : undefined}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem" }}>
        <h3 style={{ margin: 0 }}>{name}</h3>
        <span className="muted" style={{ fontSize: "0.75rem" }}>{title}</span>
      </div>
      <p style={{ fontWeight: 600, margin: "0.5rem 0" }}>{insight.takeaway}</p>
      {insight.bullets.length > 0 && (
        <ul style={{ margin: "0.25rem 0 0.5rem", paddingLeft: "1.1rem" }}>
          {insight.bullets.map((b, i) => (
            <li key={i} style={{ marginBottom: "0.2rem" }}>{b}</li>
          ))}
        </ul>
      )}
      <div style={{ margin: "0.5rem 0" }}>
        <ConfidenceBadge c={insight.confidence} />
      </div>
      {insight.memo && (
        <details>
          <summary style={{ cursor: "pointer", color: "var(--accent)", fontSize: "0.85rem" }}>
            Full memo
          </summary>
          <p className="muted" style={{ whiteSpace: "pre-wrap", marginTop: "0.5rem" }}>{insight.memo}</p>
        </details>
      )}
      {insight.references.length > 0 && (
        <div className="muted" style={{ fontSize: "0.72rem", marginTop: "0.5rem" }}>
          {insight.references.map((r, i) => (
            <div key={i}>· {r.report}: {r.note}</div>
          ))}
        </div>
      )}
    </div>
  );
}

export async function AiCouncilPanel({
  user,
  selectedRunId,
}: {
  user: SessionUser;
  selectedRunId?: string;
}) {
  const canRun = can(user.role, "run_ai_council");
  const configured = isCouncilConfigured();

  const runs = await prisma.aiAgentRun.findMany({
    orderBy: { startedAt: "desc" },
    take: 12,
  });
  const selected =
    runs.find((r) => r.id === selectedRunId) ??
    runs.find((r) => r.status === "complete") ??
    runs[0] ??
    null;

  const [reports, boardRow] = selected
    ? await Promise.all([
        prisma.aiAgentReport.findMany({ where: { runId: selected.id } }),
        prisma.aiBoardReport.findUnique({ where: { runId: selected.id } }),
      ])
    : [[], null];

  const byPersona = new Map(reports.map((r) => [r.personaId, r]));
  const ceoP = ceo();
  const alP = auditor();
  const ceoReport = byPersona.get(ceoP.id);
  const alReport = byPersona.get(alP.id);

  return (
    <>
      <p className="sub">
        A team of AI officers debate the month, an independent auditor and board review their work, and
        each brings its specialty in plain language beside the numbers. Read-only over QuickBooks; a full
        monthly run is capped at $15 of model spend and runs automatically on the 1st.
      </p>

      {!configured && (
        <div className="notice warn">
          The AI council isn’t configured yet (no <code>ANTHROPIC_API_KEY</code>). Runs will record but
          produce no analysis until an owner sets the key.
        </div>
      )}

      {/* Controls */}
      {canRun ? (
        <div className="card">
          <div className="row-actions" style={{ margin: 0, flexWrap: "wrap", alignItems: "center" }}>
            <form action={runMonthlyCouncilAction}>
              <button className="btn" type="submit">▶ Run full monthly council</button>
            </form>
            <span className="muted" style={{ fontSize: "0.8rem" }}>or ask one officer:</span>
            {debatingOfficers().map((p) => (
              <form key={p.id} action={runOnDemandAgentAction}>
                <input type="hidden" name="personaId" value={p.id} />
                <button className="btn secondary" type="submit">{p.name}</button>
              </form>
            ))}
          </div>
        </div>
      ) : (
        <p className="muted">You can read council output; only an owner_admin can run it.</p>
      )}

      {/* Run history */}
      {runs.length > 0 && (
        <div className="row-actions" style={{ flexWrap: "wrap" }}>
          {runs.map((r) => (
            <Link
              key={r.id}
              className={`btn ${selected && r.id === selected.id ? "" : "secondary"}`}
              href={`/projections?tab=council&run=${r.id}`}
              title={`${r.kind} · ${r.status} · $${r.spentUsd.toFixed(2)}`}
            >
              {r.monthLabel} {r.status !== "complete" ? `· ${r.status}` : ""}
            </Link>
          ))}
        </div>
      )}

      {!selected ? (
        <div className="notice">No council runs yet. {canRun ? "Run one above." : ""}</div>
      ) : (
        <>
          {selected.status !== "complete" && (
            <div className={`notice ${selected.status === "failed" ? "danger" : "warn"}`}>
              This run is <strong>{selected.status}</strong>
              {selected.error ? `: ${selected.error}` : "."}
            </div>
          )}

          <p className="muted" style={{ fontSize: "0.8rem" }}>
            {selected.monthLabel} · {selected.kind} · {selected.method} · model {selected.model} · spend $
            {selected.spentUsd.toFixed(2)} / $15
          </p>

          {ceoReport && (
            <>
              <h2 style={{ marginTop: "1rem" }}>CEO synthesis</h2>
              <InsightCard
                name={ceoP.name}
                title={ceoP.title}
                insight={parseInsight(ceoReport.insightJson)}
                accent
              />
            </>
          )}

          {/* Officers */}
          {(() => {
            const officerCards = debatingOfficers()
              .map((p) => ({ p, rep: byPersona.get(p.id) }))
              .filter((x) => x.rep);
            if (officerCards.length === 0) return null;
            return (
              <>
                <h2 style={{ marginTop: "1.5rem" }}>Officers</h2>
                <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
                  {officerCards.map(({ p, rep }) => (
                    <InsightCard key={p.id} name={p.name} title={p.title} insight={parseInsight(rep!.insightJson)} />
                  ))}
                </div>
              </>
            );
          })()}

          {/* Independent layer */}
          {(alReport || boardRow) && (
            <>
              <h2 style={{ marginTop: "1.5rem" }}>Independent review</h2>
              <p className="muted" style={{ fontSize: "0.78rem", marginTop: "-0.5rem" }}>
                Firewalled from the officer debate. Al audits from raw data only; the Board reviews the
                finished reports.
              </p>
              <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))" }}>
                {alReport && (
                  <InsightCard name={alP.name} title={alP.title} insight={parseInsight(alReport.insightJson)} />
                )}
              </div>
              {boardRow && (() => {
                const br = parseBoardReport(boardRow.reportJson);
                return (
                  <div className="card">
                    <h3 style={{ marginTop: 0 }}>Board of Directors</h3>
                    <p style={{ fontWeight: 600 }}>{br.takeaway}</p>
                    {br.endorsements.length > 0 && (
                      <p className="muted" style={{ fontSize: "0.85rem" }}>
                        <strong>Endorses:</strong> {br.endorsements.join(" · ")}
                      </p>
                    )}
                    {br.concerns.length > 0 && (
                      <p style={{ fontSize: "0.85rem" }}>
                        <strong>Concerns:</strong> {br.concerns.join(" · ")}
                      </p>
                    )}
                    {br.sections.map((s, i) => (
                      <div key={i} style={{ marginTop: "0.5rem" }}>
                        <strong>{s.heading}</strong>
                        <p className="muted" style={{ whiteSpace: "pre-wrap", margin: "0.2rem 0" }}>{s.body}</p>
                      </div>
                    ))}
                    {br.longForm && (
                      <details style={{ marginTop: "0.5rem" }}>
                        <summary style={{ cursor: "pointer", color: "var(--accent)", fontSize: "0.85rem" }}>
                          Full board report
                        </summary>
                        <p className="muted" style={{ whiteSpace: "pre-wrap", marginTop: "0.5rem" }}>{br.longForm}</p>
                      </details>
                    )}
                  </div>
                );
              })()}
            </>
          )}
        </>
      )}
    </>
  );
}
