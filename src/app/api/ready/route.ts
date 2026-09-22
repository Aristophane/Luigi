import { NextResponse } from "next/server";
import { readiness } from "@/lib/readiness";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const state = await readiness();
  return NextResponse.json({ status: state.ready ? "ready" : "unavailable", ...state, checkedAt: new Date().toISOString() },
    { status: state.ready ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
