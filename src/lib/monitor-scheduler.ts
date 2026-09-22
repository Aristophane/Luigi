import "server-only";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { applications, checks, jobs, workerHeartbeats, workspaces } from "@/db/schema";
import { enqueueJob } from "@/lib/job-queue";
import { evaluateMonitoringSilences } from "@/lib/monitoring-heartbeats";

export async function enqueueChecks(workspaceId?: string, force = false) {
  return db.transaction(async (tx) => {
    const rows = await tx.select({ check: checks, workspaceId: applications.workspaceId })
      .from(checks).innerJoin(applications, eq(applications.id, checks.applicationId))
      .where(and(eq(checks.enabled, true), eq(checks.kind, "http"), isNull(applications.archivedAt),
        workspaceId ? eq(applications.workspaceId, workspaceId) : undefined,
        force ? undefined : sql`${checks.nextCheckAt} <= now()`))
      .orderBy(checks.nextCheckAt).limit(500).for("update", { of: checks, skipLocked: true });
    let queued = 0;
    for (const row of rows) {
      const job = await enqueueJob({ workspaceId: row.workspaceId, kind: "check", key: `check:${row.check.id}`,
        payload: { checkId: row.check.id } }, tx);
      if (job) queued++;
      await tx.update(checks).set({ nextCheckAt: new Date(Date.now() + row.check.intervalSeconds * 1000) }).where(eq(checks.id, row.check.id));
    }
    return queued;
  });
}

export async function scheduleMonitoring() {
  const queuedChecks = await enqueueChecks();
  const interval = Math.max(1, Math.min(168, Number(process.env.DEPENDENCY_SCAN_INTERVAL_HOURS) || 24));
  const batch = Math.max(1, Math.min(20, Number(process.env.DEPENDENCY_SCAN_BATCH_SIZE) || 3));
  const cutoff = new Date(Date.now() - interval * 3600_000).toISOString();
  const candidates = await db.select().from(applications).where(and(isNull(applications.archivedAt),
    sql`(${applications.lastRepositoryScannedAt} is null or ${applications.lastRepositoryScannedAt} <= ${cutoff})`,
    sql`not exists (select 1 from ${jobs} where ${jobs.key} = 'scan:' || ${applications.id}::text
      and (${jobs.status} in ('queued', 'running') or ${jobs.createdAt} > ${cutoff}))`))
    .orderBy(sql`${applications.lastRepositoryScannedAt} asc nulls first`).limit(batch);
  let queuedScans = 0;
  for (const app of candidates) {
    if (await enqueueJob({ workspaceId: app.workspaceId, kind: "scan", key: `scan:${app.id}`,
      payload: { applicationId: app.id } })) queuedScans++;
  }
  return { queuedChecks, queuedScans };
}

export async function schedulerTick() {
  await scheduleMonitoring();
  const now = new Date();
  // Cached states become unknown even when no producer is sending data.
  await db.execute(sql`update checks set status = 'unknown' where enabled and status <> 'unknown'
    and (last_checked_at is null or last_checked_at < now() - ((interval_seconds * 2 + 60) * interval '1 second'))`);
  for (const workspace of await db.select({ id: workspaces.id }).from(workspaces)) {
    await evaluateMonitoringSilences(workspace.id, now);
  }
  await pulseWorker("scheduler");
}

export async function pulseWorker(name: string) {
  await db.insert(workerHeartbeats).values({ name, lastSeenAt: new Date() })
    .onConflictDoUpdate({ target: workerHeartbeats.name, set: { lastSeenAt: new Date() } });
}
