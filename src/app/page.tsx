import Link from "next/link";
import { MODULES } from "@/lib/modules/registry";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getSessionUser();
  return (
    <>
      <h1>GCD QBO Hub</h1>
      <p className="sub">
        QuickBooks Online automations, reporting & portals for German Car Depot (Alan Gelfand Inc DBA German Car
        Depot). A modular hub — each dashboard lives under this shared, authenticated shell.
      </p>

      {!user && (
        <div className="notice">
          You are not signed in. <Link href="/auth/signin">Sign in</Link> with your @germancardepot.com email to
          access the dashboards.
        </div>
      )}

      <div className="grid">
        {MODULES.map((m) => (
          <div key={m.id} className={`card ${m.status === "planned" ? "planned" : ""}`}>
            <h3>
              {m.icon} {m.name}{" "}
              {m.status === "live" ? (
                <span className="badge ok">live</span>
              ) : (
                <span className="badge muted">planned</span>
              )}
            </h3>
            <p className="muted">{m.tagline}</p>
            {m.status === "live" ? (
              <Link className="btn secondary" href={m.basePath}>
                Open
              </Link>
            ) : (
              <span className="btn secondary" style={{ opacity: 0.5 }}>
                Coming soon
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
