import { Dashboard } from "@/components/dashboard";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  applications as applicationsTable,
  checks,
  integrations,
  maintenanceTasks as maintenanceTasksTable,
  notifications as notificationsTable,
  observations,
  technologies as technologiesTable,
  vpsMetricSamples,
} from "@/db/schema";
import { requireWorkspace } from "@/lib/dal";
import type { ActivityEvent, DashboardNotification, HealthStatus, MaintenanceTask, MonitoredApplication, ServerMetric, VpsOverview } from "@/lib/domain";
import { vpsReportSchema } from "@/lib/vps-report";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { session, workspaceId } = await requireWorkspace();
  const allPersistedApplications = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.workspaceId, workspaceId))
    .orderBy(asc(applicationsTable.createdAt));
  const persistedApplications = allPersistedApplications.filter((application) => !application.archivedAt);

  const persistedTechnologies = persistedApplications.length > 0
    ? await db.select().from(technologiesTable).where(
      inArray(technologiesTable.applicationId, persistedApplications.map((application) => application.id)),
    )
    : [];
  const applicationIds = persistedApplications.map((application) => application.id);
  const uptimeMetrics = applicationIds.length > 0
    ? await db
      .select({
        applicationId: checks.applicationId,
        uptime30d: sql<number>`round(
          100.0 * count(*) filter (where ${observations.status} in ('healthy', 'warning'))
          / nullif(count(*), 0),
          2
        )`.mapWith(Number),
      })
      .from(observations)
      .innerJoin(checks, eq(checks.id, observations.checkId))
      .where(and(
        inArray(checks.applicationId, applicationIds),
        sql`${observations.observedAt} >= now() - interval '30 days'`,
      ))
      .groupBy(checks.applicationId)
    : [];
  const latestObservations = applicationIds.length > 0
    ? await db
      .selectDistinctOn([checks.applicationId], {
        applicationId: checks.applicationId,
        latencyMs: observations.latencyMs,
        observedAt: observations.observedAt,
      })
      .from(observations)
      .innerJoin(checks, eq(checks.id, observations.checkId))
      .where(inArray(checks.applicationId, applicationIds))
      .orderBy(checks.applicationId, desc(observations.observedAt))
    : [];
  const [githubIntegration] = await db
    .select({ label: integrations.label })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.kind, "github")))
    .limit(1);
  const [vpsAgent] = await db
    .select({
      label: integrations.label,
      lastSyncedAt: integrations.lastSyncedAt,
      configuration: integrations.configuration,
    })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.kind, "vps_agent")))
    .limit(1);
  const [latestVpsSample] = await db
    .select({
      hostname: vpsMetricSamples.hostname,
      cpuPercent: vpsMetricSamples.cpuPercent,
      memoryPercent: vpsMetricSamples.memoryPercent,
      diskPercent: vpsMetricSamples.diskPercent,
      swapPercent: vpsMetricSamples.swapPercent,
      payload: vpsMetricSamples.payload,
      observedAt: vpsMetricSamples.observedAt,
      ageSeconds: sql<number>`greatest(0, extract(epoch from (now() - ${vpsMetricSamples.observedAt})))`.mapWith(Number),
    })
    .from(vpsMetricSamples)
    .where(eq(vpsMetricSamples.workspaceId, workspaceId))
    .orderBy(desc(vpsMetricSamples.observedAt))
    .limit(1);
  const persistedTasks = await db
    .select()
    .from(maintenanceTasksTable)
    .where(and(
      eq(maintenanceTasksTable.workspaceId, workspaceId),
      inArray(maintenanceTasksTable.status, ["open", "planned", "in_progress"]),
    ))
    .orderBy(asc(maintenanceTasksTable.dueAt));
  const persistedTaskHistory = await db
    .select()
    .from(maintenanceTasksTable)
    .where(and(
      eq(maintenanceTasksTable.workspaceId, workspaceId),
      inArray(maintenanceTasksTable.status, ["done", "dismissed"]),
    ))
    .orderBy(desc(maintenanceTasksTable.completedAt), desc(maintenanceTasksTable.updatedAt))
    .limit(20);
  const persistedNotifications = await db
    .select()
    .from(notificationsTable)
    .where(and(
      eq(notificationsTable.workspaceId, workspaceId),
      eq(notificationsTable.status, "unread"),
    ))
    .orderBy(desc(notificationsTable.createdAt))
    .limit(5);
  const recentObservations = applicationIds.length > 0
    ? await db
      .select({
        id: observations.id,
        applicationName: applicationsTable.name,
        status: observations.status,
        statusCode: observations.statusCode,
        latencyMs: observations.latencyMs,
        detail: observations.detail,
        observedAt: observations.observedAt,
      })
      .from(observations)
      .innerJoin(checks, eq(checks.id, observations.checkId))
      .innerJoin(applicationsTable, eq(applicationsTable.id, checks.applicationId))
      .where(eq(applicationsTable.workspaceId, workspaceId))
      .orderBy(desc(observations.observedAt))
      .limit(6)
    : [];

  const applications: MonitoredApplication[] = persistedApplications.map((application) => {
    const uptime = uptimeMetrics.find((metric) => metric.applicationId === application.id);
    const latest = latestObservations.find((observation) => observation.applicationId === application.id);
    return {
      id: application.id,
      name: application.name,
      environment: application.environment,
      status: application.status,
      url: application.publicUrl,
      uptime30d: uptime?.uptime30d ?? null,
      latencyMs: latest?.latencyMs ?? null,
      lastCheckLabel: latest?.observedAt
        ? latest.observedAt.toLocaleString("fr-FR")
        : "En attente",
      lastDeployLabel: "Non connecté",
      technologies: persistedTechnologies
        .filter((technology) => technology.applicationId === application.id)
        .map((technology) => ({
          name: technology.name,
          version: technology.version ?? undefined,
          source: technology.source as "detected" | "declared" | "confirmed" | "ignored",
          evidence: technology.evidence ?? undefined,
        })),
    };
  });
  const applicationNames = new Map(allPersistedApplications.map((application) => [application.id, application.name]));
  const mapMaintenanceTask = (task: typeof maintenanceTasksTable.$inferSelect): MaintenanceTask => ({
    id: task.id,
    title: task.title,
    category: task.category,
    severity: task.severity,
    dueLabel: task.dueAt
      ? `Échéance ${task.dueAt.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}`
      : "À planifier",
    source: task.automatic ? "Analyse automatique" : "Tâche manuelle",
    applicationName: task.applicationId ? applicationNames.get(task.applicationId) ?? "Application archivée" : "VPS · Infrastructure",
    status: task.status,
    completedLabel: task.completedAt?.toLocaleString("fr-FR"),
  });
  const maintenanceTasks = persistedTasks.map(mapMaintenanceTask);
  const maintenanceHistory = persistedTaskHistory.map(mapMaintenanceTask);
  const dashboardNotifications: DashboardNotification[] = persistedNotifications.map((notification) => ({
    id: notification.id,
    title: notification.title,
    body: notification.body,
    severity: notification.severity,
    targetUrl: notification.targetUrl ?? "/#overview",
    createdLabel: notification.createdAt.toLocaleString("fr-FR"),
  }));
  const activity: ActivityEvent[] = recentObservations.map((observation) => ({
    id: observation.id,
    title: `Contrôle de ${observation.applicationName}`,
    detail: observation.detail ?? (observation.statusCode ? `HTTP ${observation.statusCode}` : "Contrôle terminé"),
    timeLabel: observation.observedAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
    status: observation.status,
  }));
  const parsedVpsReport = latestVpsSample ? vpsReportSchema.safeParse(latestVpsSample.payload) : null;
  const vpsPayload = parsedVpsReport?.success ? parsedVpsReport.data : null;
  const metricStatus = (value: number, warning: number, critical: number): HealthStatus => value >= critical
    ? "critical"
    : value >= warning
      ? "warning"
      : "healthy";
  const vpsMetrics: ServerMetric[] = latestVpsSample ? [
    {
      id: "cpu",
      label: "CPU",
      value: latestVpsSample.cpuPercent ?? 0,
      displayValue: `${Math.round(latestVpsSample.cpuPercent ?? 0)} %`,
      detail: vpsPayload ? `Charge ${vpsPayload.metrics.load1.toLocaleString("fr-FR")}` : "Dernière collecte",
      status: metricStatus(latestVpsSample.cpuPercent ?? 0, 85, 95),
    },
    {
      id: "memory",
      label: "Mémoire",
      value: latestVpsSample.memoryPercent ?? 0,
      displayValue: `${Math.round(latestVpsSample.memoryPercent ?? 0)} %`,
      detail: "Alerte après trois collectes à plus de 90 %",
      status: metricStatus(latestVpsSample.memoryPercent ?? 0, 80, 95),
    },
    {
      id: "disk",
      label: "Disque",
      value: latestVpsSample.diskPercent ?? 0,
      displayValue: `${Math.round(latestVpsSample.diskPercent ?? 0)} %`,
      detail: "Système de fichiers racine",
      status: metricStatus(latestVpsSample.diskPercent ?? 0, 80, 90),
    },
    {
      id: "swap",
      label: "Swap",
      value: latestVpsSample.swapPercent ?? 0,
      displayValue: `${Math.round(latestVpsSample.swapPercent ?? 0)} %`,
      detail: vpsPayload ? `Uptime ${Math.floor(vpsPayload.metrics.uptimeSeconds / 86400)} j` : "Dernière collecte",
      status: metricStatus(latestVpsSample.swapPercent ?? 0, 50, 80),
    },
  ] : [];
  const vpsMetricStatus: HealthStatus = vpsMetrics.some((metric) => metric.status === "critical")
    ? "critical"
    : vpsMetrics.some((metric) => metric.status === "warning")
      ? "warning"
      : vpsMetrics.length > 0
        ? "healthy"
        : "unknown";
  const configuredRefreshSeconds = typeof vpsAgent?.configuration.reportIntervalSeconds === "number"
    ? vpsAgent.configuration.reportIntervalSeconds
    : 300;
  const refreshIntervalSeconds = Math.max(60, Math.min(configuredRefreshSeconds, 86_400));
  const reportAgeSeconds = latestVpsSample
    ? Math.round(latestVpsSample.ageSeconds)
    : null;
  const freshnessStatus: VpsOverview["freshnessStatus"] = reportAgeSeconds === null
    ? "unknown"
    : reportAgeSeconds <= refreshIntervalSeconds + 60
      ? "fresh"
      : reportAgeSeconds <= refreshIntervalSeconds * 3
        ? "late"
        : "silent";
  const durationLabel = (seconds: number) => seconds < 90
    ? `${seconds} s`
    : seconds < 3600
      ? `${Math.round(seconds / 60)} min`
      : `${Math.round(seconds / 3600)} h`;
  const nextReportAt = latestVpsSample
    ? new Date(latestVpsSample.observedAt.getTime() + refreshIntervalSeconds * 1000)
    : null;
  const vpsOverview: VpsOverview = {
    configured: Boolean(vpsAgent),
    connected: freshnessStatus === "fresh",
    status: freshnessStatus === "late" || freshnessStatus === "silent" ? "warning" : vpsMetricStatus,
    hostname: latestVpsSample?.hostname,
    lastSeenLabel: latestVpsSample?.observedAt.toLocaleString("fr-FR") ?? "Aucun rapport reçu",
    refreshIntervalLabel: `Toutes les ${durationLabel(refreshIntervalSeconds)}`,
    dataAgeLabel: reportAgeSeconds === null ? "Aucune donnée" : `Il y a ${durationLabel(reportAgeSeconds)}`,
    nextReportLabel: nextReportAt
      ? reportAgeSeconds !== null && reportAgeSeconds <= refreshIntervalSeconds
        ? `Vers ${nextReportAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`
        : `Attendu depuis ${durationLabel(Math.max(0, (reportAgeSeconds ?? refreshIntervalSeconds) - refreshIntervalSeconds))}`
      : "Après le premier rapport",
    freshnessStatus,
    metrics: vpsMetrics,
    availableUpdates: vpsPayload?.updates.available ?? 0,
    securityUpdates: vpsPayload?.updates.security ?? 0,
    rebootRequired: vpsPayload?.updates.rebootRequired ?? false,
    ufwActive: vpsPayload?.security.ufwActive ?? null,
    backupStatus: vpsPayload?.backup?.status ?? "unknown",
  };

  return (
    <Dashboard
      applications={applications}
      maintenanceTasks={maintenanceTasks}
      maintenanceHistory={maintenanceHistory}
      notifications={dashboardNotifications}
      activity={activity}
      vps={vpsOverview}
      userName={session.user.name}
      githubIntegrationLabel={githubIntegration?.label}
    />
  );
}
