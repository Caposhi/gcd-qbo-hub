import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import { Sidebar } from "./components/Sidebar";
import { TopBar, type EnvInfo } from "./components/TopBar";
import { AiPal } from "./components/AiPal";
import { getSessionUser } from "@/lib/auth/session";
import { getQboEnvironment } from "@/lib/config-store";
import { hasStoredCredential } from "@/lib/qbo/oauth";

export const metadata: Metadata = {
  title: "GCD QBO Hub",
  description: "German Car Depot — QuickBooks Online automations, reporting & portals.",
};

/**
 * Resolve the env-pill facts for the TopBar without ever throwing on the layout
 * and WITHOUT touching the network. The pill is chrome on every route, so it must
 * not trigger a QBO token refresh here — that would refresh on every page load
 * and race the data page's own refresh (rotated refresh tokens → 400). We only
 * read whether a usable credential is on file; the data path owns the live check.
 */
async function resolveEnv(): Promise<EnvInfo> {
  try {
    const environment = await getQboEnvironment();
    const configured = await hasStoredCredential(environment);
    return { environment, configured };
  } catch {
    return { environment: "sandbox", configured: false };
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [user, env] = await Promise.all([getSessionUser(), resolveEnv()]);

  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="app-shell">
            <Sidebar user={user} />
            <div className="main">
              <TopBar env={env} />
              <div className="content">
                <div className="content-inner">{children}</div>
              </div>
            </div>
            <AiPal />
          </div>
        </Providers>
      </body>
    </html>
  );
}
