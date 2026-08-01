import Link from "next/link";
import { getModule } from "@/lib/modules/registry";

export function ComingSoon({ id }: { id: string }) {
  const m = getModule(id);
  return (
    <div className="center">
      <div className="card" style={{ width: 480 }}>
        <h1>{m?.name ?? "Module"}</h1>
        <p className="card-subtitle" style={{ marginTop: 6 }}>{m?.tagline}</p>
        <p className="card-subtitle" style={{ marginTop: 10 }}>
          This module is planned. The hub is architected so it slots in under the same shell, auth, and DB with its
          own <code>{m?.tablePrefix}</code> table namespace — no rearchitecting required.
        </p>
        <Link className="btn secondary" href="/" style={{ marginTop: 14 }}>
          ← Back to hub
        </Link>
      </div>
    </div>
  );
}
