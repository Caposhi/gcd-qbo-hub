/**
 * GCD Pal insights endpoint (read-only).
 *
 * GET /api/assistant/insights?module=<id> → { insights: [{tone,text,prompt}] }
 *
 * Returns deterministic, figure-accurate bullets for the given module drawn from
 * the DB and existing cached snapshots only — no writes, no external fetches, no
 * LLM. Gated to users who can use the assistant. An empty list is normal (the
 * Pal then shows its static generic copy); errors never bubble to the client.
 */
import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { can } from "@/lib/auth/roles";
import { buildModuleInsights } from "@/lib/assistant/insights";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const user = await getSessionUser();
  if (!user || !can(user.role, "use_assistant")) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const moduleId = new URL(req.url).searchParams.get("module") ?? "";
  if (!moduleId) return NextResponse.json({ insights: [] });

  try {
    const insights = await buildModuleInsights(moduleId);
    return NextResponse.json({ insights });
  } catch {
    // Never fail the companion — fall back to the client's static copy.
    return NextResponse.json({ insights: [] });
  }
}
