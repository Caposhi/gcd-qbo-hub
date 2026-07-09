/**
 * NextAuth (Auth.js) configuration (§1, §18).
 *
 * Real login is REQUIRED for this hub — it holds QBO tokens and financial data.
 * Method: passwordless email magic-link, restricted to @germancardepot.com
 * (ALLOWED_EMAIL_DOMAINS), delivered via SendGrid (the same email path as
 * everything else — not Gmail). Sessions are DB-backed via the Prisma adapter.
 *
 * The first sign-in from BOOTSTRAP_OWNER_EMAIL is provisioned as owner_admin;
 * everyone else defaults to `reviewer` (an owner can promote later). The
 * `coworker` role is reserved for the future portal and is never auto-assigned.
 */
import type { NextAuthOptions } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import EmailProvider from "next-auth/providers/email";
import { prisma } from "@/lib/db";
import { sendEmail } from "@/lib/email/sendgrid";
import type { Role } from "./roles";

function allowedDomains(): string[] {
  return (process.env.ALLOWED_EMAIL_DOMAINS || "germancardepot.com")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedEmail(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();
  return !!domain && allowedDomains().includes(domain);
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma) as NextAuthOptions["adapter"],
  session: { strategy: "database" },
  pages: { signIn: "/auth/signin", verifyRequest: "/auth/verify", error: "/auth/error" },
  providers: [
    EmailProvider({
      maxAge: 15 * 60, // magic links expire in 15 minutes
      // Custom delivery via SendGrid instead of SMTP.
      async sendVerificationRequest({ identifier, url }) {
        if (!isAllowedEmail(identifier)) {
          // Don't send a link to a disallowed address; signIn() also blocks it.
          throw new Error("Email domain not allowed");
        }
        await sendEmail({
          to: identifier,
          subject: "Sign in to GCD QBO Hub",
          text: `Sign in to GCD QBO Hub:\n\n${url}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
        });
      },
    }),
  ],
  callbacks: {
    async signIn({ user }) {
      const email = user.email?.toLowerCase();
      if (!email || !isAllowedEmail(email)) return false;
      return true;
    },
    async session({ session, user }) {
      // Attach role + active flag to the session for gating.
      const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
      if (session.user) {
        (session.user as { id?: string }).id = user.id;
        (session.user as { role?: Role }).role = (dbUser?.role as Role) ?? "reviewer";
        (session.user as { active?: boolean }).active = dbUser?.active ?? true;
      }
      return session;
    },
  },
  events: {
    async createUser({ user }) {
      // Provision the bootstrap owner as owner_admin on first creation.
      const bootstrap = (process.env.BOOTSTRAP_OWNER_EMAIL || "").toLowerCase();
      if (user.email && user.email.toLowerCase() === bootstrap) {
        await prisma.user.update({ where: { id: user.id }, data: { role: "owner_admin" } });
      }
    },
    async signIn({ user }) {
      if (user.id) {
        await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } }).catch(() => {});
      }
    },
  },
};
