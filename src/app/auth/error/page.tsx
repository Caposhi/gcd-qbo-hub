import Link from "next/link";

export default function AuthErrorPage() {
  return (
    <div className="center">
      <div className="card" style={{ width: 440 }}>
        <img src="/assets/gcd-logo-disc.png" width={44} height={44} alt="German Car Depot" />
        <h1>Sign-in problem</h1>
        <p className="card-subtitle">
          That sign-in link was invalid, expired, or the email address is not permitted (only
          @germancardepot.com addresses may sign in).
        </p>
        <Link className="btn primary" href="/auth/signin" style={{ width: "100%" }}>
          Try again
        </Link>
      </div>
    </div>
  );
}
