import Link from "next/link";

export default function AuthErrorPage() {
  return (
    <div className="center">
      <div className="card" style={{ width: 420 }}>
        <h1>Sign-in problem</h1>
        <p className="sub">
          That sign-in link was invalid, expired, or the email address is not permitted (only
          @germancardepot.com addresses may sign in).
        </p>
        <Link className="btn" href="/auth/signin">
          Try again
        </Link>
      </div>
    </div>
  );
}
