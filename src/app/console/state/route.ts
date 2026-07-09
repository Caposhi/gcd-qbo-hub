import { NextResponse } from "next/server";
import { buildConsoleState, consoleAuthorized, corsHeaders } from "@/lib/console/contract";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!consoleAuthorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: corsHeaders() });
  }
  try {
    const state = await buildConsoleState();
    return NextResponse.json(state, { headers: corsHeaders() });
  } catch (err) {
    // Fail soft — never 500 the hub aggregator.
    return NextResponse.json(
      { id: "gcd-qbo-hub", modules: {}, recentEvents: [], error: String(err) },
      { headers: corsHeaders() }
    );
  }
}
