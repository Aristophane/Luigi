import { Dashboard } from "@/components/dashboard";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  applications as applicationsTable,
  checks,
  dependencies as dependenciesTable,
  deployments,
  integrations,
  agents,
  servers,
  maintenanceTasks as maintenanceTasksTable,
  notifications as notificationsTable,
  observations,
  technologies as technologiesTable,
  vpsMetricSamples,
} from "@/db/schema";
import { requireWorkspace } from "@/lib/dal";
import { compareDependencyGroups, groupDependencies, technologyDependency } from "@/lib/dependency-groups";
import type { ActivityEvent, DashboardNotification, HealthStatus, MaintenanceTask, MonitoredApplication, ServerMetric, VpsOverview } from "@/lib/domain";
import { runtimeObservationState, vpsReportSchema } from "@/lib/vps-report";

import { aggregateHealth, isFresh } from "@/lib/monitoring-state";
import { applicationCoverage } from "@/lib/coverage";
import { readiness } from "@/lib/readiness";

export const dynamic = "force-dynamic";

function deploymentSourceLabel(source: string) {
  return { ci: "CI", coolify: "Coolify", "github-actions": "GitHub Actions" }[source] ?? source;
}

export default async function Home() {
  const { session, workspaceId } = await requireWorkspace();
  const renderedAt = new Date();
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
  const uptimeMetrics = await applicationCoverage(workspaceId);
  const latestObservations = applicationIds.length > 0
    ? await db
      .selectDistinctOn([checks.id], {
        checkId: checks.id,
        applicationId: checks.applicationId,
        latencyMs: observations.latencyMs,
        status: observations.status,
        detail: observations.detail,
        observedAt: observations.observedAt,
      })
      .from(observations)
      .innerJoin(checks, eq(checks.id, observations.checkId))
      .where(inArray(checks.applicationId, applicationIds))
      .orderBy(checks.id, desc(observations.observedAt))
    : [];
  const httpChecks = applicationIds.length > 0
    ? await db
      .select({
        id: checks.id,
        applicationId: checks.applicationId,
        status: checks.status,
        lastCheckedAt: checks.lastCheckedAt,
        intervalSeconds: checks.intervalSeconds,
        enabled: checks.enabled,
        essential: checks.essential,
        kind: checks.kind,
        renderingUrl: checks.renderingUrl,
        expectedText: checks.expectedText,
        assetProbe: checks.assetProbe,
        assetUrl: checks.assetUrl,
      })
      .from(checks)
      .where(and(
        inArray(checks.applicationId, applicationIds),
        eq(checks.enabled, true),
      ))
    : [];
  const [githubIntegration] = await db
    .select({ label: integrations.label })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.kind, "github")))
    .limit(1);
  const registeredAgents = await db.select({ id: agents.id, serverId: servers.id, label: servers.label,
    lastSyncedAt: agents.lastSeenAt, configuration: agents.configuration, intervalSeconds: agents.intervalSeconds })
    .from(agents).innerJoin(servers, eq(servers.id, agents.serverId))
    .where(and(eq(servers.workspaceId, workspaceId), eq(agents.enabled, true))).orderBy(servers.createdAt);
  const latestVpsSamples = await db.selectDistinctOn([vpsMetricSamples.serverId]).from(vpsMetricSamples)
    .where(eq(vpsMetricSamples.workspaceId, workspaceId)).orderBy(vpsMetricSamples.serverId, desc(vpsMetricSamples.observedAt));
  const monitoringReady = await readiness();
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
    const applicationChecks = httpChecks.filter((check) => check.applicationId === application.id);
    const httpCheck = applicationChecks.find((check) => check.kind === "http");
    const latest = latestObservations.find((observation) => observation.checkId === httpCheck?.id);
    const status = aggregateHealth(applicationChecks);
    const fresh = Boolean(httpCheck && isFresh(httpCheck.lastCheckedAt, httpCheck.intervalSeconds));
    const productionDeployment = latestDeployments.find((deployment) => deployment.applicationId === application.id);
    const applicationDependencies = persistedDependencies.filter((dependency) => dependency.applicationId === application.id);
    return {
      id: application.id,
      name: application.name,
      environment: application.environment,
      status,
      coverage30d: uptime?.coverage30d ?? 0,
      collectionGaps: uptime?.collectionGaps ?? 0,
      missingMinutes: uptime?.missingMinutes ?? 0,
      staleChecks: applicationChecks.filter((check) => check.essential && !isFresh(check.lastCheckedAt, check.intervalSeconds)).length,
      url: application.publicUrl,
      githubRepository: application.githubRepository,
      githubBranch: application.githubBranch,
      repositoryCommit: application.repositoryCommit ?? undefined,
      repositoryCommitMessage: application.repositoryCommitMessage ?? undefined,
      uptime30d: uptime?.uptime30d ?? null,
      latencyMs: fresh ? latest?.latencyMs ?? null : null,
      lastCheckedAt: latest?.observedAt?.toISOString(),
      lastCheckStatus: fresh ? latest?.status ?? "unknown" : "unknown",
      lastCheckDetail: latest?.detail ?? undefined,
      lastRepositoryScannedAt: application.lastRepositoryScannedAt?.toISOString(),
      renderingCheck: httpCheck ? {
        renderingUrl: httpCheck.renderingUrl ?? undefined,
        expectedText: httpCheck.expectedText ?? undefined,
        assetProbe: httpCheck.assetProbe,
        assetUrl: httpCheck.assetUrl ?? undefined,
      } : undefined,
      productionDeployment: productionDeployment ? {
        commitSha: productionDeployment.commitSha,
        shortCommit: productionDeployment.commitSha.slice(0, 7),
        deployedAt: productionDeployment.deployedAt.toISOString(),
        source: productionDeployment.source,
        sourceUrl: productionDeployment.sourceUrl ?? undefined,
        matchesRepositoryHead: application.repositoryCommit
          ? application.repositoryCommit.startsWith(productionDeployment.commitSha)
            || productionDeployment.commitSha.startsWith(application.repositoryCommit)
          : null,
      } : undefined,
      technologies: persistedTechnologies
        .filter((technology) => technology.applicationId === application.id)
        .map((technology) => {
          const dependency = technologyDependency(technology, applicationDependencies);
          return {
            name: technology.name,
            version: dependency?.currentVersion ?? technology.version ?? undefined,
            latestVersion: dependency?.status === "outdated" ? dependency.latestVersion ?? undefined : undefined,
            source: technology.source as "detected" | "declared" | "confirmed" | "ignored",
            evidence: technology.evidence ?? undefined,
          };
        })
        .sort((left, right) => Number(Boolean(right.latestVersion)) - Number(Boolean(left.latestVersion))),
      dependencies: groupDependencies(applicationDependencies)
        .sort(compareDependencyGroups)
        .map((group) => ({
          name: group.label,
          packages: group.members.map((member) => member.name),
          ecosystem: group.lead.ecosystem,
          manifestPath: group.manifestPath,
          currentVersion: group.currentVersion,
          requestedRange: group.lead.requestedRange,
          latestVersion: group.latestVersion,
          status: group.status,
          updateKind: group.updateKind,
          development: group.development,
          evidence: group.lead.evidence,
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
    dueAt: task.dueAt?.toISOString(),
    source: task.automatic ? "Analyse automatique" : "Tâche manuelle",
    applicationName: task.applicationId ? applicationNames.get(task.applicationId) ?? "Application archivée" : "VPS · Infrastructure",
    status: task.status,
    completedAt: task.completedAt?.toISOString(),
    createdAt: task.createdAt.toISOString(),
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
    createdAt: notification.lastOccurredAt.toISOString(),
  }));
  const activity: ActivityEvent[] = [
    ...recentObservations.map((observation) => ({
      id: observation.id,
      title: `Contrôle de ${observation.applicationName}`,
      detail: observation.detail ?? (observation.statusCode ? `HTTP ${observation.statusCode}` : "Contrôle terminé"),
      status: observation.status,
      occurredAt: observation.observedAt,
    })),
    ...recentDeployments.map((deployment) => ({
      id: deployment.id,
      title: `${deployment.applicationName} déployée`,
      detail: `${deployment.commitSha.slice(0, 7)} · ${deploymentSourceLabel(deployment.source)}`,
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
      occurredAt: event.occurredAt.toISOString(),
      status: event.status,
    }));
  function buildVpsOverview(vpsAgent?: typeof registeredAgents[number]): VpsOverview {
  const latestVpsSample = latestVpsSamples.find((sample) => sample.serverId === vpsAgent?.serverId);
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
  const configuredRefreshSeconds = vpsAgent?.intervalSeconds ?? 300;
  const refreshIntervalSeconds = Math.max(60, Math.min(configuredRefreshSeconds, 86_400));
  const reportAgeSeconds = latestVpsSample
    ? Math.max(0, Math.round((renderedAt.getTime() - latestVpsSample.observedAt.getTime()) / 1000))
    : null;
  const freshnessStatus: VpsOverview["freshnessStatus"] = reportAgeSeconds === null
    ? "unknown"
    : reportAgeSeconds <= refreshIntervalSeconds + 60
      ? "fresh"
      : reportAgeSeconds <= refreshIntervalSeconds * 2 + 60
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
  const runtimeState = runtimeObservationState(runtime, new Date());
  const stale = freshnessStatus === "silent" || freshnessStatus === "unknown";
  const vpsOverview: VpsOverview = {
    serverId: vpsAgent?.serverId,
    configured: Boolean(vpsAgent),
    connected: freshnessStatus === "fresh",
    status: stale ? "unknown" : freshnessStatus === "late" || runtimeState !== "complete" ? "warning" : vpsMetricStatus,
    hostname: latestVpsSample?.hostname,
    lastSeenAt: latestVpsSample?.observedAt.toISOString(),
    refreshIntervalLabel: `Toutes les ${durationLabel(refreshIntervalSeconds)}`,
    dataAgeLabel: reportAgeSeconds === null ? "Aucune donnée" : `Il y a ${durationLabel(reportAgeSeconds)}`,
    nextReportAt: nextReportAt && reportAgeSeconds !== null && reportAgeSeconds <= refreshIntervalSeconds
      ? nextReportAt.toISOString() : undefined,
    nextReportLabel: nextReportAt
      ? `Attendu depuis ${durationLabel(Math.max(0, (reportAgeSeconds ?? refreshIntervalSeconds) - refreshIntervalSeconds))}`
      : "Après le premier rapport",
    freshnessStatus,
    metrics: vpsMetrics.map((metric) => ({ ...metric, status: stale ? "unknown" : metric.status })),
    availableUpdates: vpsPayload?.updates.available ?? 0,
    securityUpdates: vpsPayload?.updates.security ?? 0,
    rebootRequired: vpsPayload?.updates.rebootRequired ?? false,
    ufwActive: vpsPayload?.security.ufwActive ?? null,
    backupStatus: vpsPayload?.backup?.status ?? "unknown",
    runtime: {
      collector: runtimeState === "absent" ? "missing" : runtimeState === "stale" ? "silent" : "fresh",
      completeness: runtimeState,
      omittedUnits: runtime?.completeness?.omittedUnits ?? 0,
      omittedEvents: runtime?.completeness?.omittedEvents ?? 0,
      trackedUnits: runtime?.units.length ?? 0,
      oomKills24h: recentRuntimeEvents.filter((event) => event.type === "oom_kill").length,
      restarts24h: recentRuntimeEvents
        .filter((event) => event.type === "restart")
        .reduce((total, event) => total + (event.count ?? 1), 0),
    },
  };

  return vpsOverview;
  }
  const vpsOverviews = registeredAgents.map(buildVpsOverview);

  return (
    <Dashboard
      applications={applications}
      maintenanceTasks={maintenanceTasks}
      maintenanceHistory={maintenanceHistory}
      notifications={dashboardNotifications}
      unreadNotificationCount={unreadNotificationCount}
      activity={activity}
      vps={vpsOverviews[0] ?? buildVpsOverview()}
      vpsServers={vpsOverviews}
      monitoringReady={monitoringReady.ready}
      renderedAt={renderedAt.toISOString()}
      userName={session.user.name}
      githubIntegrationLabel={githubIntegration?.label}
    />
  );
}
