"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!/@germancardepot\.com$/i.test(email.trim())) {
      setError("Use your @germancardepot.com email address.");
      return;
    }
    const res = await signIn("email", { email: email.trim(), redirect: false, callbackUrl: "/" });
    if (res?.error) setError("Could not send the sign-in link. Check the address and try again.");
    else setSent(true);
  }

  return (
    <div className="center">
      <div className="card" style={{ width: 380 }}>
        <h1>Sign in</h1>
        <p className="sub">GCD QBO Hub is restricted to German Car Depot staff.</p>
        {sent ? (
          <div className="notice ok">
            Check your inbox — we emailed a magic sign-in link to <strong>{email}</strong>. It expires in 15
            minutes.
          </div>
        ) : (
          <form onSubmit={submit}>
            <input
              type="email"
              placeholder="you@germancardepot.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ width: "100%", padding: "0.5rem", margin: "0.5rem 0", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel-2)", color: "var(--text)" }}
            />
            {error && <div className="notice danger">{error}</div>}
            <button className="btn" type="submit" style={{ width: "100%" }}>
              Email me a sign-in link
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
