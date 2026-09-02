import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runWorkspaceHttpChecks } from "@/lib/http-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: Request) {
  const expected = process.env.MONITOR_CRON_SECRET;
  const authorization = request.headers.get("authorization");
  const received = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!expected || !received) return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length
    && timingSafeEqual(expectedBuffer, receivedBuffer);
}

export async function POST(request: Request) {
  if (!process.env.MONITOR_CRON_SECRET) {
    return NextResponse.json({ error: "Monitoring scheduler is not configured." }, { status: 503 });
  }
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const results = await runWorkspaceHttpChecks(undefined, true);
  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    checked: results.length,
    healthy: results.filter((result) => result.status === "healthy").length,
    warning: results.filter((result) => result.status === "warning").length,
    critical: results.filter((result) => result.status === "critical").length,
    incidentsOpened: results.filter((result) => result.incidentOpened).length,
    incidentsResolved: results.filter((result) => result.incidentResolved).length,
  });
}
