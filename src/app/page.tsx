import Link from "next/link";
import {
  Home as HomeIcon,
  Wallet,
  TrendingUp,
  Bot,
  Landmark,
  ReceiptText,
  Wrench,
  Users,
  ArrowRight,
  type LucideIcon,
} from "lucide-react";
import { MODULES } from "@/lib/modules/registry";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const ICONS: Record<string, LucideIcon> = {
  Home: HomeIcon,
  Wallet,
  TrendingUp,
  Bot,
  Landmark,
  ReceiptText,
  Wrench,
  Users,
};

function StatusBadge({ status }: { status: string }) {
  if (status === "live") return <span className="badge ok">Live</span>;
  if (status === "prototype") return <span className="badge info">Beta</span>;
  return <span className="badge warn">Planned</span>;
}

export default async function HomePage() {
  const user = await getSessionUser();
  return (
    <>
      <div className="accent-bar" />
      <h1>GCD QBO Hub</h1>
      <p className="page-desc" style={{ maxWidth: 720 }}>
        QuickBooks Online automations, reporting &amp; portals for German Car Depot (Alan Gelfand Inc DBA German
        Car Depot). A modular hub — each dashboard lives under this shared, authenticated shell.
      </p>

      {!user && (
        <div className="notice info" style={{ marginBottom: 22 }}>
          You are not signed in. <Link href="/auth/signin">Sign in</Link> with your @germancardepot.com email to
          access the dashboards.
        </div>
      )}

      <div className="kpi-grid">
        {MODULES.map((m) => {
          const Icon = ICONS[m.lucide] ?? HomeIcon;
          const planned = m.status === "planned";
          const card = (
            <div className="card hoverable" style={{ height: "100%", display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                <span
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 12,
                    background: "var(--powder-blue-100)",
                    color: "var(--royal-blue)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Icon size={22} />
                </span>
                <StatusBadge status={m.status} />
              </div>
              <div style={{ flex: 1 }}>
                <h3 className="card-title" style={{ fontSize: 16 }}>{m.name}</h3>
                <p className="card-subtitle" style={{ marginTop: 6 }}>{m.tagline}</p>
              </div>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 12.5,
                  fontWeight: 700,
                  color: planned ? "var(--text-muted)" : "var(--royal-blue)",
                }}
              >
                {planned ? "Coming soon" : "Open"} {!planned && <ArrowRight size={14} />}
              </span>
            </div>
          );
          return planned ? (
            <div key={m.id} style={{ opacity: 0.6 }}>{card}</div>
          ) : (
            <Link key={m.id} href={m.basePath} style={{ textDecoration: "none" }}>
              {card}
            </Link>
          );
        })}
      </div>
    </>
  );
}
