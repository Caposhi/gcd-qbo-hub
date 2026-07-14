import Link from "next/link";

/** Rendered in place of a dashboard when the visitor is not signed in (§18). */
export function RequireAuth() {
  return (
    <div className="center">
      <div className="card" style={{ width: 420, textAlign: "center" }}>
        <img src="/assets/gcd-logo-disc.png" width={44} height={44} alt="German Car Depot" style={{ margin: "0 auto 12px" }} />
        <h1>Sign in required</h1>
        <p className="card-subtitle" style={{ marginBottom: 16 }}>This dashboard is restricted to German Car Depot staff.</p>
        <Link className="btn primary" href="/auth/signin" style={{ width: "100%" }}>
          Sign in
        </Link>
      </div>
    </div>
  );
}
