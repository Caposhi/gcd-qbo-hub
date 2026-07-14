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
      <div className="card" style={{ width: 440 }}>
        <img src="/assets/gcd-logo-disc.png" width={44} height={44} alt="German Car Depot" />
        <h1>Sign in</h1>
        <p className="card-subtitle">GCD QBO Hub is restricted to German Car Depot staff.</p>
        {sent ? (
          <div className="notice info">
            Check your inbox — we emailed a magic sign-in link to <strong>{email}</strong>. It expires in 15
            minutes.
          </div>
        ) : (
          <form onSubmit={submit}>
            <input
              className="input"
              type="email"
              placeholder="you@germancardepot.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ margin: "12px 0" }}
            />
            {error && <div className="notice danger">{error}</div>}
            <button className="btn primary" type="submit" style={{ width: "100%" }}>
              Email me a sign-in link
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
