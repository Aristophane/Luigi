import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  applications,
  dependencies,
  findings,
  maintenanceTaskEvents,
  maintenanceTasks,
  notifications,
  technologies,
} from "@/db/schema";
import { inspectNpmDependencies, type DependencyFreshness } from "@/lib/dependency-freshness";
import { getGitHubToken } from "@/lib/github-integration";
import { createOrRefreshNotification, resolveNotification } from "@/lib/notifications";
import { scanGitHubTechnologies } from "@/lib/technology-scanner";

function dependencyCopy(dependency: DependencyFreshness) {
  const location = dependency.manifestPath === "package.json" ? "" : ` dans ${dependency.manifestPath}`;
  const title = dependency.currentVersion
    ? `${dependency.name} ${dependency.currentVersion} n’est plus à jour${location}`
    : `${dependency.name} ne permet pas la dernière version${location}`;
  const description = dependency.currentVersion
    ? `Le dépôt verrouille la version ${dependency.currentVersion}. La version ${dependency.latestVersion} est disponible.`
    : `La contrainte ${dependency.requestedRange} n’accepte pas la version ${dependency.latestVersion}.`;
  return { title, description };
}

function dependencyKey(dependency: { ecosystem: string; manifestPath: string; name: string }) {
  return `${dependency.ecosystem}:${dependency.manifestPath}:${dependency.name}`;
}

function dependencyFindingFingerprint(applicationId: string, manifestPath: string, name: string) {
  const location = manifestPath === "package.json" ? "" : `:${encodeURIComponent(manifestPath)}`;
  return `application:${applicationId}:dependency:npm${location}:${name}:outdated`;
}

function dependencyNotificationFingerprint(applicationId: string, manifestPath: string, name: string) {
  const location = manifestPath === "package.json" ? "" : `:${encodeURIComponent(manifestPath)}`;
  return `dependency-update:${applicationId}:npm${location}:${name}`;
}

type DependencyNotification = {
  kind: "update" | "resolved";
  dependencyName: string;
  manifestPath: string;
  currentVersion?: string;
  latestVersion?: string;
  updateKind?: "major" | "compatible";
  fingerprint: string;
};

export async function scanStoredApplication(workspaceId: string, applicationId: string) {
  const [application] = await db
    .select()
    .from(applications)
    .where(and(
      eq(applications.id, applicationId),
      eq(applications.workspaceId, workspaceId),
      isNull(applications.archivedAt),
    ))
    .limit(1);
  if (!application) throw new Error("APPLICATION_NOT_FOUND");

  const token = await getGitHubToken(workspaceId);
  const scan = await scanGitHubTechnologies(application.githubRepository, application.githubBranch, token);
  const freshness = await inspectNpmDependencies(scan.dependencies);
  const checkedAt = new Date();
  const existingDependencies = await db
    .select({
      id: dependencies.id,
      ecosystem: dependencies.ecosystem,
      name: dependencies.name,
      manifestPath: dependencies.manifestPath,
    })
    .from(dependencies)
    .where(and(eq(dependencies.applicationId, application.id), eq(dependencies.ecosystem, "npm")));
  const existingFindings = await db
    .select({
      id: findings.id,
      fingerprint: findings.fingerprint,
      resolvedAt: findings.resolvedAt,
      metadata: findings.metadata,
    })
    .from(findings)
    .where(and(
      eq(findings.workspaceId, workspaceId),
      eq(findings.applicationId, application.id),
      eq(findings.kind, "dependency"),
    ));
  const existingNotifications = await db
    .select({ fingerprint: notifications.fingerprint })
    .from(notifications)
    .where(and(eq(notifications.workspaceId, workspaceId), isNull(notifications.resolvedAt)));
  const findingsByFingerprint = new Map(existingFindings.map((finding) => [finding.fingerprint, finding]));
  const notificationFingerprints = new Set(existingNotifications.flatMap((notification) => notification.fingerprint ? [notification.fingerprint] : []));
  const manifestDependencyKeys = new Set(scan.dependencies.map(dependencyKey));
  const notificationEvents: DependencyNotification[] = [];

  await db.transaction(async (transaction) => {
    const resolveTrackedFinding = async (
      trackedFinding: (typeof existingFindings)[number],
      dependencyName: string,
      note: string,
    ) => {
      if (trackedFinding.resolvedAt) return;
      await transaction
        .update(findings)
        .set({ resolvedAt: checkedAt, updatedAt: checkedAt })
        .where(eq(findings.id, trackedFinding.id));
      const activeTasks = await transaction
        .select({ id: maintenanceTasks.id, status: maintenanceTasks.status })
        .from(maintenanceTasks)
        .where(and(
          eq(maintenanceTasks.findingId, trackedFinding.id),
          inArray(maintenanceTasks.status, ["open", "planned", "in_progress"]),
        ));
      for (const task of activeTasks) {
        await transaction
          .update(maintenanceTasks)
          .set({ status: "done", completedAt: checkedAt, updatedAt: checkedAt })
          .where(eq(maintenanceTasks.id, task.id));
        await transaction.insert(maintenanceTaskEvents).values({
          workspaceId,
          taskId: task.id,
          action: "auto_resolved",
          previousStatus: task.status,
          nextStatus: "done",
          note,
        });
      }
      notificationEvents.push({
        kind: "resolved",
        dependencyName,
        manifestPath: trackedFinding.metadata.manifestPath === "string"
          ? trackedFinding.metadata.manifestPath
          : "package.json",
        fingerprint: dependencyNotificationFingerprint(
          application.id,
          trackedFinding.metadata.manifestPath === "string" ? trackedFinding.metadata.manifestPath : "package.json",
          dependencyName,
        ),
      });
    };

    await transaction
      .update(applications)
      .set({
        repositoryCommit: scan.commitSha,
        lastRepositoryScannedAt: checkedAt,
        updatedAt: checkedAt,
      })
      .where(eq(applications.id, application.id));

    for (const technology of scan.technologies) {
      await transaction
        .insert(technologies)
        .values({
          applicationId: application.id,
          name: technology.name,
          version: technology.version,
          source: "detected",
          evidence: technology.evidence,
        })
        .onConflictDoUpdate({
          target: [technologies.applicationId, technologies.name],
          set: {
            version: technology.version,
            evidence: technology.evidence,
            updatedAt: checkedAt,
          },
        });
    }

    for (const dependency of freshness) {
      await transaction
        .insert(dependencies)
        .values({
          applicationId: application.id,
          ecosystem: dependency.ecosystem,
          name: dependency.name,
          manifestPath: dependency.manifestPath,
          currentVersion: dependency.currentVersion,
          requestedRange: dependency.requestedRange,
          latestVersion: dependency.latestVersion,
          status: dependency.status,
          development: dependency.development,
          evidence: dependency.evidence,
          lastCheckedAt: dependency.status === "unsupported" ? undefined : checkedAt,
        })
        .onConflictDoUpdate({
          target: [dependencies.applicationId, dependencies.ecosystem, dependencies.manifestPath, dependencies.name],
          set: {
            currentVersion: dependency.currentVersion,
            requestedRange: dependency.requestedRange,
            latestVersion: dependency.latestVersion,
            status: dependency.status,
            development: dependency.development,
            evidence: dependency.evidence,
            lastCheckedAt: dependency.status === "unsupported" ? undefined : checkedAt,
            updatedAt: checkedAt,
          },
        });

      const fingerprint = dependencyFindingFingerprint(application.id, dependency.manifestPath, dependency.name);
      const previousFinding = findingsByFingerprint.get(fingerprint);
      if (dependency.status !== "outdated") {
        if (dependency.status !== "unknown" && previousFinding) {
          await resolveTrackedFinding(
            previousFinding,
            dependency.name,
            `Tâche terminée automatiquement : ${dependency.name} est à jour lors de l’analyse du dépôt.`,
          );
        }
        continue;
      }

      const severity = dependency.updateKind === "major" ? "medium" : "low";
      const copy = dependencyCopy(dependency);
      const [finding] = await transaction
        .insert(findings)
        .values({
          workspaceId,
          applicationId: application.id,
          kind: "dependency",
          severity,
          title: copy.title,
          description: copy.description,
          fingerprint,
          metadata: {
            ecosystem: dependency.ecosystem,
            package: dependency.name,
            manifestPath: dependency.manifestPath,
            currentVersion: dependency.currentVersion,
            requestedRange: dependency.requestedRange,
            latestVersion: dependency.latestVersion,
            updateKind: dependency.updateKind,
          },
        })
        .onConflictDoUpdate({
          target: [findings.workspaceId, findings.fingerprint],
          set: {
            severity,
            title: copy.title,
            description: copy.description,
            resolvedAt: null,
            metadata: {
              ecosystem: dependency.ecosystem,
              package: dependency.name,
              manifestPath: dependency.manifestPath,
              currentVersion: dependency.currentVersion,
              requestedRange: dependency.requestedRange,
              latestVersion: dependency.latestVersion,
              updateKind: dependency.updateKind,
            },
            updatedAt: checkedAt,
          },
        })
        .returning({ id: findings.id });

      const [existingTask] = await transaction
        .select({ id: maintenanceTasks.id })
        .from(maintenanceTasks)
        .where(and(
          eq(maintenanceTasks.findingId, finding.id),
          inArray(maintenanceTasks.status, ["open", "planned", "in_progress"]),
        ))
        .limit(1);
      const taskDescription = dependency.currentVersion
        ? `Mettre à jour la version verrouillée ${dependency.currentVersion}, vérifier le changelog et exécuter les tests.`
        : `Adapter la contrainte ${dependency.requestedRange}, vérifier le changelog et exécuter les tests.`;
      const taskLocation = dependency.manifestPath === "package.json" ? "" : ` · ${dependency.manifestPath}`;
      if (existingTask) {
        await transaction
          .update(maintenanceTasks)
          .set({
            title: `Mettre à jour ${dependency.name} vers ${dependency.latestVersion}${taskLocation}`,
            description: taskDescription,
            severity,
            updatedAt: checkedAt,
          })
          .where(eq(maintenanceTasks.id, existingTask.id));
      } else {
        const dueAt = new Date(checkedAt);
        dueAt.setDate(dueAt.getDate() + (dependency.updateKind === "major" ? 14 : 30));
        const [task] = await transaction.insert(maintenanceTasks).values({
          workspaceId,
          applicationId: application.id,
          findingId: finding.id,
          title: `Mettre à jour ${dependency.name} vers ${dependency.latestVersion}${taskLocation}`,
          description: taskDescription,
          category: "dependency",
          severity,
          automatic: true,
          dueAt,
        }).returning({ id: maintenanceTasks.id });
        await transaction.insert(maintenanceTaskEvents).values({
          workspaceId,
          taskId: task.id,
          action: "created",
          nextStatus: "open",
          note: "Tâche créée automatiquement par l’analyse des dépendances.",
        });
      }

      const previousLatest = typeof previousFinding?.metadata.latestVersion === "string"
        ? previousFinding.metadata.latestVersion
        : undefined;
      const notificationFingerprint = dependencyNotificationFingerprint(application.id, dependency.manifestPath, dependency.name);
      if (!previousFinding || previousFinding.resolvedAt || previousLatest !== dependency.latestVersion || !notificationFingerprints.has(notificationFingerprint)) {
        notificationEvents.push({
          kind: "update",
          dependencyName: dependency.name,
          manifestPath: dependency.manifestPath,
          currentVersion: dependency.currentVersion,
          latestVersion: dependency.latestVersion,
          updateKind: dependency.updateKind,
          fingerprint: notificationFingerprint,
        });
      }
    }

    for (const storedDependency of existingDependencies) {
      if (manifestDependencyKeys.has(dependencyKey(storedDependency))) continue;
      await transaction.delete(dependencies).where(eq(dependencies.id, storedDependency.id));
      const fingerprint = dependencyFindingFingerprint(application.id, storedDependency.manifestPath, storedDependency.name);
      const previousFinding = findingsByFingerprint.get(fingerprint);
      if (previousFinding) {
        await resolveTrackedFinding(
          previousFinding,
          storedDependency.name,
          `Tâche terminée automatiquement : ${storedDependency.name} n’est plus déclaré dans le dépôt.`,
        );
      }
    }
  });

  await Promise.allSettled(notificationEvents.map((event) => event.kind === "update"
    ? createOrRefreshNotification({
      workspaceId,
      title: `Nouvelle version de ${event.dependencyName}`,
      body: event.currentVersion
        ? `${application.name}${event.manifestPath === "package.json" ? "" : ` · ${event.manifestPath}`} utilise ${event.currentVersion} ; ${event.latestVersion} est disponible.`
        : `${application.name}${event.manifestPath === "package.json" ? "" : ` · ${event.manifestPath}`} peut être mis à jour vers ${event.latestVersion}.`,
      severity: event.updateKind === "major" ? "medium" : "low",
      targetUrl: "/maintenance?category=dependency",
      fingerprint: event.fingerprint,
      push: event.updateKind === "major",
    })
    : resolveNotification(workspaceId, event.fingerprint, {
      title: `${event.dependencyName} est à jour`,
      body: `${application.name}${event.manifestPath === "package.json" ? "" : ` · ${event.manifestPath}`} ne nécessite plus cette mise à jour.`,
      targetUrl: `/#application-${application.id}`,
    })));

  return {
    technologies: scan.technologies.length,
    dependencies: freshness.length,
    outdated: freshness.filter((dependency) => dependency.status === "outdated").length,
  };
}
