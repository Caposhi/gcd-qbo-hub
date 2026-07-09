import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Providers } from "./providers";
import { MODULES } from "@/lib/modules/registry";
import { getSessionUser } from "@/lib/auth/session";

export const metadata: Metadata = {
  title: "GCD QBO Hub",
  description: "German Car Depot — QuickBooks Online automations, reporting & portals.",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  return (
    <html lang="en">
      <body>
        <Providers>
          <header className="shell-header">
            <div className="brand">
              📒 GCD QBO Hub <small>· German Car Depot</small>
            </div>
            <nav className="nav">
              <Link href="/">Home</Link>
              {MODULES.map((m) => (
                <Link key={m.id} href={m.basePath} className={m.status === "planned" ? "planned" : ""}>
                  {m.icon} {m.name}
                  {m.status === "planned" ? " ·soon" : m.status === "prototype" ? " ·beta" : ""}
                </Link>
              ))}
              <span className="who">
                {user ? (
                  <>
                    {user.email} · <span className="badge muted">{user.role}</span>
                  </>
                ) : (
                  <Link href="/auth/signin">Sign in</Link>
                )}
              </span>
            </nav>
          </header>
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
