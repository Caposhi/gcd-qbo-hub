/**
 * System Health (owner-only, read-only).
 *
 * One operator view of "is everything working right now?" — QBO connection, the
 * last Cash Sheet sync, Tekmetric backfill completeness/integrity, transcript
 * freshness, the month's AI-council spend, and email-alert delivery. Every value
 * is a plain DB read via the health service; nothing here calls an external API.
 */
import Link from "next/link";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { RequireAuth } from "../components/RequireAuth";
import { loadSystemHealth, type HealthStatus } from "@/lib/health/service";

export const dynamic = "force-dynamic";

const BADGE: Record<HealthStatus, { cls: string; label: string }> = {
  ok: { cls: "ok", label: "OK" },
  warn: { cls: "warn", label: "Attention" },
  error: { cls: "danger", label: "Action needed" },
  idle: { cls: "muted", label: "Not configured" },
};

/** "2026-07-15 14:26 UTC" from an ISO string. */
function fmt(iso: string): string {
  return iso.slice(0, 16).replace("T", " ") + " UTC";
}

export default async function SystemHealthPage() {
  const user = await getSessionUser();
  if (!user) return <RequireAuth />;

  if (!can(user.role, "manage_users")) {
    return (
      <div className="center">
        <div className="card" style={{ width: 420 }}>
          <h1>Owners only</h1>
          <p className="card-subtitle">System Health is available to owner-admins.</p>
          <div className="row-actions">
            <Link className="btn secondary" href="/">Back to home</Link>
          </div>
        </div>
      </div>
    );
  }

  const health = await loadSystemHealth(new Date());
  const counts = health.checks.reduce(
    (a, c) => ({ ...a, [c.status]: (a[c.status] ?? 0) + 1 }),
    {} as Record<HealthStatus, number>
  );
  const needsAction = (counts.error ?? 0) + (counts.warn ?? 0);

  return (
    <>
      <div className="accent-bar" />
      <h1>System Health</h1>
      <p className="page-desc">
        A read-only, at-a-glance status of every moving part of the hub. Nothing here calls an external
        service — it reflects what the app last recorded. Checked {fmt(health.generatedAt)}.
      </p>

      <div className={`notice ${needsAction === 0 ? "info" : "warn"}`} style={{ marginBottom: 16 }}>
        {needsAction === 0 ? (
          <>All systems nominal — {counts.ok ?? 0} healthy, {counts.idle ?? 0} not configured.</>
        ) : (
          <>
            {needsAction} {needsAction === 1 ? "item needs" : "items need"} a look
            {counts.error ? ` (${counts.error} action needed)` : ""}. Details below.
          </>
        )}
      </div>

      <div className="kpi-grid">
        {health.checks.map((c) => {
          const b = BADGE[c.status];
          const inner = (
            <>
              <div className="kpi-label">{c.label}</div>
              <div style={{ margin: "8px 0", color: "var(--text-strong)", fontWeight: 600, overflowWrap: "anywhere" }}>
                {c.headline}
              </div>
              {c.detail && (
                <div className="card-subtitle" style={{ overflowWrap: "anywhere" }}>{c.detail}</div>
              )}
              <div className="kpi-foot" style={{ marginTop: 10 }}>
                <span className={`badge ${b.cls}`}>{b.label}</span>
                {c.href && <span className="card-subtitle">open →</span>}
              </div>
            </>
          );
          return c.href ? (
            <Link key={c.key} href={c.href} className="kpi-card" style={{ textDecoration: "none", color: "inherit" }}>
              {inner}
            </Link>
          ) : (
            <div key={c.key} className="kpi-card">{inner}</div>
          );
        })}
      </div>
    </>
  );
}
