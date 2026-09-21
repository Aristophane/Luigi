import { Dashboard } from "@/components/dashboard";
import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  applications as applicationsTable,
  checks,
  dependencies as dependenciesTable,
  deployments,
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

function deploymentSourceLabel(source: string) {
  return { ci: "CI", coolify: "Coolify", "github-actions": "GitHub Actions" }[source] ?? source;
}

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
  const persistedDependencies = applicationIds.length > 0
    ? await db.select().from(dependenciesTable).where(inArray(dependenciesTable.applicationId, applicationIds))
    : [];
  const latestDeployments = applicationIds.length > 0
    ? await db
      .selectDistinctOn([deployments.applicationId], {
        applicationId: deployments.applicationId,
        commitSha: deployments.commitSha,
        source: deployments.source,
        sourceUrl: deployments.sourceUrl,
        deployedAt: deployments.deployedAt,
      })
      .from(deployments)
      .where(inArray(deployments.applicationId, applicationIds))
      .orderBy(deployments.applicationId, desc(deployments.deployedAt))
    : [];
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
        status: observations.status,
        detail: observations.detail,
        observedAt: observations.observedAt,
      })
      .from(observations)
      .innerJoin(checks, eq(checks.id, observations.checkId))
      .where(inArray(checks.applicationId, applicationIds))
      .orderBy(checks.applicationId, desc(observations.observedAt))
    : [];
  const httpChecks = applicationIds.length > 0
    ? await db
      .select({
        applicationId: checks.applicationId,
        expectedText: checks.expectedText,
        assetProbe: checks.assetProbe,
        assetUrl: checks.assetUrl,
      })
      .from(checks)
      .where(and(
        inArray(checks.applicationId, applicationIds),
        eq(checks.kind, "http"),
        eq(checks.enabled, true),
      ))
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
      inArray(notificationsTable.status, ["unread", "read"]),
    ))
    .orderBy(desc(notificationsTable.lastOccurredAt))
    .limit(20);
  const [{ unreadNotificationCount }] = await db
    .select({ unreadNotificationCount: count() })
    .from(notificationsTable)
    .where(and(
      eq(notificationsTable.workspaceId, workspaceId),
      eq(notificationsTable.status, "unread"),
    ));
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
  const recentDeployments = applicationIds.length > 0
    ? await db
      .select({
        id: deployments.id,
        applicationName: applicationsTable.name,
        commitSha: deployments.commitSha,
        source: deployments.source,
        deployedAt: deployments.deployedAt,
      })
      .from(deployments)
      .innerJoin(applicationsTable, eq(applicationsTable.id, deployments.applicationId))
      .where(eq(applicationsTable.workspaceId, workspaceId))
      .orderBy(desc(deployments.deployedAt))
      .limit(6)
    : [];

  const applications: MonitoredApplication[] = persistedApplications.map((application) => {
    const uptime = uptimeMetrics.find((metric) => metric.applicationId === application.id);
    const latest = latestObservations.find((observation) => observation.applicationId === application.id);
    const httpCheck = httpChecks.find((check) => check.applicationId === application.id);
    const productionDeployment = latestDeployments.find((deployment) => deployment.applicationId === application.id);
    return {
      id: application.id,
      name: application.name,
      environment: application.environment,
      status: application.status,
      url: application.publicUrl,
      githubRepository: application.githubRepository,
      githubBranch: application.githubBranch,
      repositoryCommit: application.repositoryCommit ?? undefined,
      uptime30d: uptime?.uptime30d ?? null,
      latencyMs: latest?.latencyMs ?? null,
      lastCheckLabel: latest?.observedAt
        ? latest.observedAt.toLocaleString("fr-FR")
        : "En attente",
      lastCheckStatus: latest?.status ?? "unknown",
      lastCheckDetail: latest?.detail ?? undefined,
      lastRepositoryScanLabel: application.lastRepositoryScannedAt
        ? application.lastRepositoryScannedAt.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })
        : "Jamais analysé",
      renderingCheck: httpCheck ? {
        expectedText: httpCheck.expectedText ?? undefined,
        assetProbe: httpCheck.assetProbe,
        assetUrl: httpCheck.assetUrl ?? undefined,
      } : undefined,
      productionDeployment: productionDeployment ? {
        commitSha: productionDeployment.commitSha,
        shortCommit: productionDeployment.commitSha.slice(0, 7),
        deployedAtLabel: productionDeployment.deployedAt.toLocaleString("fr-FR", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
        }),
        source: productionDeployment.source,
        sourceUrl: productionDeployment.sourceUrl ?? undefined,
        matchesRepositoryHead: application.repositoryCommit
          ? application.repositoryCommit.startsWith(productionDeployment.commitSha)
            || productionDeployment.commitSha.startsWith(application.repositoryCommit)
          : null,
      } : undefined,
      technologies: persistedTechnologies
        .filter((technology) => technology.applicationId === application.id)
        .map((technology) => ({
          name: technology.name,
          version: technology.version ?? undefined,
          source: technology.source as "detected" | "declared" | "confirmed" | "ignored",
          evidence: technology.evidence ?? undefined,
        })),
      dependencies: persistedDependencies
        .filter((dependency) => dependency.applicationId === application.id)
        .sort((left, right) => Number(right.status === "outdated") - Number(left.status === "outdated")
          || left.manifestPath.localeCompare(right.manifestPath)
          || left.name.localeCompare(right.name))
        .map((dependency) => ({
          name: dependency.name,
          ecosystem: dependency.ecosystem,
          manifestPath: dependency.manifestPath,
          currentVersion: dependency.currentVersion ?? undefined,
          requestedRange: dependency.requestedRange,
          latestVersion: dependency.latestVersion ?? undefined,
          status: dependency.status,
          development: dependency.development,
          evidence: dependency.evidence,
        })),
    };
  });
  const applicationNames = new Map(allPersistedApplications.map((application) => [application.id, application.name]));
  const mapMaintenanceTask = (task: typeof maintenanceTasksTable.$inferSelect): MaintenanceTask => ({
    id: task.id,
    applicationId: task.applicationId,
    title: task.title,
    description: task.description ?? undefined,
    remediation: task.remediation ?? undefined,
    verification: task.verification ?? undefined,
    category: task.category,
    severity: task.severity,
    dueLabel: task.dueAt
      ? `Échéance ${task.dueAt.toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}`
      : "À planifier",
    source: task.automatic ? "Analyse automatique" : "Tâche manuelle",
    applicationName: task.applicationId ? applicationNames.get(task.applicationId) ?? "Application archivée" : "VPS · Infrastructure",
    status: task.status,
    completedLabel: task.completedAt?.toLocaleString("fr-FR"),
    createdLabel: task.createdAt.toLocaleString("fr-FR"),
  });
  const maintenanceTasks = persistedTasks.map(mapMaintenanceTask);
  const maintenanceHistory = persistedTaskHistory.map(mapMaintenanceTask);
  const dashboardNotifications: DashboardNotification[] = persistedNotifications.map((notification) => ({
    id: notification.id,
    title: notification.title,
    body: notification.body,
    severity: notification.severity,
    status: notification.status as "unread" | "read",
    occurrenceCount: notification.occurrenceCount,
    targetUrl: notification.targetUrl ?? "/#overview",
    createdLabel: notification.lastOccurredAt.toLocaleString("fr-FR"),
  }));
  const activity: ActivityEvent[] = [
    ...recentObservations.map((observation) => ({
      id: observation.id,
      title: `Contrôle de ${observation.applicationName}`,
      detail: observation.detail ?? (observation.statusCode ? `HTTP ${observation.statusCode}` : "Contrôle terminé"),
      timeLabel: observation.observedAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
      status: observation.status,
      occurredAt: observation.observedAt,
    })),
    ...recentDeployments.map((deployment) => ({
      id: deployment.id,
      title: `${deployment.applicationName} déployée`,
      detail: `${deployment.commitSha.slice(0, 7)} · ${deploymentSourceLabel(deployment.source)}`,
      timeLabel: deployment.deployedAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
      status: "healthy" as const,
      occurredAt: deployment.deployedAt,
    })),
  ]
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())
    .slice(0, 6)
    .map((event): ActivityEvent => ({
      id: event.id,
      title: event.title,
      detail: event.detail,
      timeLabel: event.timeLabel,
      status: event.status,
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
  const runtime = vpsPayload?.runtime;
  const runtimeWindowStart = (latestVpsSample?.observedAt.getTime() ?? 0) - 24 * 60 * 60 * 1000;
  const recentRuntimeEvents = runtime?.collectedAt
    ? runtime.events.filter((event) => Date.parse(event.occurredAt) >= runtimeWindowStart)
    : [];
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
    runtime: {
      collector: !runtime ? "missing" : runtime.collectedAt ? "fresh" : "silent",
      trackedUnits: runtime?.units.length ?? 0,
      oomKills24h: recentRuntimeEvents.filter((event) => event.type === "oom_kill").length,
      restarts24h: recentRuntimeEvents
        .filter((event) => event.type === "restart")
        .reduce((total, event) => total + (event.count ?? 1), 0),
    },
  };

  return (
    <Dashboard
      applications={applications}
      maintenanceTasks={maintenanceTasks}
      maintenanceHistory={maintenanceHistory}
      notifications={dashboardNotifications}
      unreadNotificationCount={unreadNotificationCount}
      activity={activity}
      vps={vpsOverview}
      userName={session.user.name}
      githubIntegrationLabel={githubIntegration?.label}
    />
  );
}
