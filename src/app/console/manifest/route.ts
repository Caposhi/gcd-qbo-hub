import { NextResponse } from "next/server";
import { CONSOLE_MANIFEST, corsHeaders } from "@/lib/console/contract";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(CONSOLE_MANIFEST, { headers: corsHeaders() });
}
