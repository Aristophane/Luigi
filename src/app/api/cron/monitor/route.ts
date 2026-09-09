import { timingSafeEqual } from "node:crypto";
import { and, isNull, lte, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { applications, workspaces } from "@/db/schema";
import { scanStoredApplication } from "@/lib/application-scanner";
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

  const configuredDependencyInterval = Number(process.env.DEPENDENCY_SCAN_INTERVAL_HOURS ?? 24);
  const dependencyIntervalHours = Number.isFinite(configuredDependencyInterval)
    ? Math.max(1, Math.min(Math.round(configuredDependencyInterval), 168))
    : 24;
  const configuredBatchSize = Number(process.env.DEPENDENCY_SCAN_BATCH_SIZE ?? 3);
  const dependencyBatchSize = Number.isFinite(configuredBatchSize)
    ? Math.max(1, Math.min(Math.round(configuredBatchSize), 20))
    : 3;
  const dependencyCutoff = new Date(checkedAt.getTime() - dependencyIntervalHours * 60 * 60 * 1000);
  const applicationsToScan = await db
    .select({ id: applications.id, workspaceId: applications.workspaceId })
    .from(applications)
    .where(and(
      isNull(applications.archivedAt),
      or(
        isNull(applications.lastRepositoryScannedAt),
        lte(applications.lastRepositoryScannedAt, dependencyCutoff),
      ),
    ))
    .orderBy(sql`${applications.lastRepositoryScannedAt} asc nulls first`)
    .limit(dependencyBatchSize);
  const dependencyScans = [];
  for (const application of applicationsToScan) {
    try {
      const result = await scanStoredApplication(application.workspaceId, application.id);
      dependencyScans.push({ applicationId: application.id, status: "success" as const, ...result });
    } catch {
      dependencyScans.push({ applicationId: application.id, status: "error" as const });
    }
  }

  return NextResponse.json({
    checkedAt: checkedAt.toISOString(),
    checked: results.length,
    healthy: results.filter((result) => result.status === "healthy").length,
    warning: results.filter((result) => result.status === "warning").length,
    critical: results.filter((result) => result.status === "critical").length,
    incidentsOpened: results.filter((result) => result.incidentOpened).length,
    incidentsResolved: results.filter((result) => result.incidentResolved).length,
    dependencyScans: {
      attempted: dependencyScans.length,
      succeeded: dependencyScans.filter((scan) => scan.status === "success").length,
      failed: dependencyScans.filter((scan) => scan.status === "error").length,
      updatesFound: dependencyScans.reduce((total, scan) => total + ("outdated" in scan ? scan.outdated : 0), 0),
      intervalHours: dependencyIntervalHours,
    },
  });
}
