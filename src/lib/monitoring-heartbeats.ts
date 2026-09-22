import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Database } from "@/db";
import { monitoringHeartbeats, notifications } from "@/db/schema";
import { createOrRefreshNotification, resolveNotification } from "@/lib/notifications";

const sourceLabels: Record<string, string> = {
  monitor_cron: "Planificateur de contrôles",
  vps_agent: "Agent VPS",
};

function sourceLabel(source: string) {
  return source.startsWith("vps_agent:") ? `Agent VPS · ${source.slice(10, 18)}` : sourceLabels[source] ?? source;
}

function silenceFingerprint(source: string) {
  return `monitoring-source:${source}:silent`;
}

export async function recordMonitoringHeartbeat(
  workspaceId: string,
  source: string,
  intervalSeconds: number,
  observedAt: Date, database: Database = db,
) {
  await database
    .insert(monitoringHeartbeats)
    .values({ workspaceId, source, intervalSeconds, lastSeenAt: observedAt })
    .onConflictDoUpdate({
      target: [monitoringHeartbeats.workspaceId, monitoringHeartbeats.source],
      set: { intervalSeconds, lastSeenAt: sql`greatest(${monitoringHeartbeats.lastSeenAt}, ${observedAt.toISOString()}::timestamptz)`, updatedAt: new Date() },
    });

  if (Date.now() - observedAt.getTime() > (intervalSeconds * 2 + 60) * 1000) return;
  await resolveNotification(workspaceId, silenceFingerprint(source), {
    title: `${sourceLabel(source)} à nouveau actif`,
    body: "Les signaux arrivent de nouveau au rythme attendu.",
    targetUrl: source.startsWith("vps_agent:") ? "/#vps" : "/#overview",
  }, database);
}

export async function evaluateMonitoringSilences(
  workspaceId: string,
  observedAt: Date,
  currentSource?: string,
) {
  const heartbeats = await db
    .select()
    .from(monitoringHeartbeats)
    .where(eq(monitoringHeartbeats.workspaceId, workspaceId));

  for (const heartbeat of heartbeats) {
    if (heartbeat.source === currentSource) continue;
    const ageSeconds = Math.max(0, (observedAt.getTime() - heartbeat.lastSeenAt.getTime()) / 1000);
    const silenceThreshold = heartbeat.intervalSeconds * 2 + 60;
    if (ageSeconds <= silenceThreshold) continue;
    const [alreadyReported] = await db.select({ id: notifications.id }).from(notifications)
      .where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.fingerprint, silenceFingerprint(heartbeat.source)), isNull(notifications.resolvedAt))).limit(1);
    if (alreadyReported) continue;

    const minutes = Math.max(1, Math.round(ageSeconds / 60));
    await createOrRefreshNotification({
      workspaceId,
      title: `${sourceLabel(heartbeat.source)} silencieux`,
      body: `Aucun signal reçu depuis environ ${minutes} minute${minutes > 1 ? "s" : ""}. Vérifie le service et sa planification.`,
      severity: "high",
      targetUrl: heartbeat.source.startsWith("vps_agent:") ? "/settings/vps" : "/#overview",
      fingerprint: silenceFingerprint(heartbeat.source),
    });
  }
}
