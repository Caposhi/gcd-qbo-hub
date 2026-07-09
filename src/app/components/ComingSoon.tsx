import Link from "next/link";
import { getModule } from "@/lib/modules/registry";

export function ComingSoon({ id }: { id: string }) {
  const m = getModule(id);
  return (
    <div className="center">
      <div className="card" style={{ width: 480 }}>
        <h1>
          {m?.icon} {m?.name ?? "Module"}
        </h1>
        <p className="sub">{m?.tagline}</p>
        <p className="muted">
          This module is planned. The hub is architected so it slots in under the same shell, auth, and DB with its
          own <code>{m?.tablePrefix}</code> table namespace — no rearchitecting required.
        </p>
        <Link className="btn secondary" href="/">
          ← Back to hub
        </Link>
      </div>
    </div>
  );
}
