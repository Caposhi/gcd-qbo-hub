/**
 * Server-side session helpers for role gating in App Router (§14, §18).
 */
import { getServerSession } from "next-auth";
import { authOptions } from "./options";
import type { Role, Permission } from "./roles";
import { can } from "./roles";

export interface SessionUser {
  id: string;
  email: string;
  name?: string | null;
  role: Role;
  active: boolean;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await getServerSession(authOptions);
  const u = session?.user as (SessionUser & { email?: string }) | undefined;
  if (!u?.email) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: (u.role as Role) ?? "reviewer",
    active: u.active ?? true,
  };
}

export async function requirePermission(permission: Permission): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user || !user.active || !can(user.role, permission)) {
    throw new Error(`Forbidden: requires ${permission}`);
  }
  return user;
}
