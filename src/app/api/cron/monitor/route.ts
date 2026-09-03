import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { workspaces } from "@/db/schema";
import { runWorkspaceHttpChecks } from "@/lib/http-monitor";
import { evaluateMonitoringSilences, recordMonitoringHeartbeat } from "@/lib/monitoring-heartbeats";

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
  const checkedAt = new Date();
  const configuredInterval = Number(process.env.MONITOR_CRON_INTERVAL_SECONDS ?? 60);
  const intervalSeconds = Number.isFinite(configuredInterval)
    ? Math.max(30, Math.min(Math.round(configuredInterval), 86_400))
    : 60;
  const workspaceRows = await db.select({ id: workspaces.id }).from(workspaces);
  for (const workspace of workspaceRows) {
    await recordMonitoringHeartbeat(workspace.id, "monitor_cron", intervalSeconds, checkedAt);
    await evaluateMonitoringSilences(workspace.id, checkedAt, "monitor_cron");
  }
  return NextResponse.json({
    checkedAt: checkedAt.toISOString(),
    checked: results.length,
    healthy: results.filter((result) => result.status === "healthy").length,
    warning: results.filter((result) => result.status === "warning").length,
    critical: results.filter((result) => result.status === "critical").length,
    incidentsOpened: results.filter((result) => result.incidentOpened).length,
    incidentsResolved: results.filter((result) => result.incidentResolved).length,
  });
}
