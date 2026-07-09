import Link from "next/link";

/** Rendered in place of a dashboard when the visitor is not signed in (§18). */
export function RequireAuth() {
  return (
    <div className="center">
      <div className="card" style={{ width: 420 }}>
        <h1>Sign in required</h1>
        <p className="sub">This dashboard is restricted to German Car Depot staff.</p>
        <Link className="btn" href="/auth/signin">
          Sign in
        </Link>
      </div>
    </div>
  );
}
