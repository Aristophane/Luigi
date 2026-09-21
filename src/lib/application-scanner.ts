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
import { groupDependencies, type DependencyGroup } from "@/lib/dependency-groups";
import { getGitHubToken } from "@/lib/github-integration";
import { createOrRefreshNotification, resolveNotification } from "@/lib/notifications";
import { scanGitHubTechnologies } from "@/lib/technology-scanner";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DependencyUpdate = DependencyGroup<DependencyFreshness>;

type TrackedFinding = {
  id: string;
  fingerprint: string;
  resolvedAt: Date | null;
  metadata: Record<string, unknown>;
};

function packageList(update: DependencyUpdate) {
  return update.members.map((member) => member.name).join(", ");
}

function dependencyCopy(update: DependencyUpdate) {
  const location = update.manifestPath === "package.json" ? "" : ` dans ${update.manifestPath}`;
  const grouped = update.members.length > 1;
  const lockedVersions = [...new Set(update.members.flatMap((member) => member.currentVersion ? [member.currentVersion] : []))];
  const title = update.currentVersion
    ? `${update.label} ${update.currentVersion} n’est plus à jour${location}`
    : `${update.label} ne permet pas la dernière version${location}`;
  const description = update.currentVersion
    ? `Le dépôt verrouille ${grouped ? `${packageList(update)} en` : "la version"} ${lockedVersions.join(", ")}. La version ${update.latestVersion} est disponible.`
    : `La contrainte ${update.lead.requestedRange}${grouped ? ` de ${packageList(update)}` : ""} n’accepte pas la version ${update.latestVersion}.`;
  return { title, description };
}

function taskCopy(update: DependencyUpdate) {
  const location = update.manifestPath === "package.json" ? "" : ` · ${update.manifestPath}`;
  const grouped = update.members.length > 1;
  return {
    title: `Mettre à jour ${update.label}${grouped ? ` (${update.members.length} paquets)` : ""} vers ${update.latestVersion}${location}`,
    description: update.currentVersion
      ? `Mettre à jour la version verrouillée ${update.currentVersion}${grouped ? ` de ${packageList(update)}` : ""}, vérifier le changelog et exécuter les tests.`
      : `Adapter la contrainte ${update.lead.requestedRange}${grouped ? ` de ${packageList(update)}` : ""}, vérifier le changelog et exécuter les tests.`,
  };
}

function findingMetadata(update: DependencyUpdate) {
  return {
    ecosystem: update.lead.ecosystem,
    package: update.lead.name,
    packages: update.members.map((member) => member.name),
    label: update.label,
    manifestPath: update.manifestPath,
    currentVersion: update.currentVersion,
    requestedRange: update.lead.requestedRange,
    latestVersion: update.latestVersion,
    updateKind: update.updateKind,
  };
}

// Les constats antérieurs au regroupement ne portent qu'un seul paquet.
function trackedPackages(metadata: Record<string, unknown>) {
  if (Array.isArray(metadata.packages)) return metadata.packages.filter((name): name is string => typeof name === "string");
  return typeof metadata.package === "string" ? [metadata.package] : [];
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
  // "superseded" : le constat est remplacé par un autre regroupement, sans retour à la normale à annoncer.
  kind: "update" | "resolved" | "superseded";
  label: string;
  manifestPath: string;
  currentVersion?: string;
  latestVersion?: string;
  updateKind?: "major" | "compatible";
  packageCount: number;
  fingerprint: string;
};

async function resolveTrackedFinding(
  transaction: Transaction,
  workspaceId: string,
  findingId: string,
  resolvedAt: Date,
  note: string,
) {
  await transaction
    .update(findings)
    .set({ resolvedAt, updatedAt: resolvedAt })
    .where(eq(findings.id, findingId));
  const activeTasks = await transaction
    .select({ id: maintenanceTasks.id, status: maintenanceTasks.status })
    .from(maintenanceTasks)
    .where(and(
      eq(maintenanceTasks.findingId, findingId),
      inArray(maintenanceTasks.status, ["open", "planned", "in_progress"]),
    ));
  for (const task of activeTasks) {
    await transaction
      .update(maintenanceTasks)
      .set({ status: "done", completedAt: resolvedAt, updatedAt: resolvedAt })
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
}

// Crée ou actualise un constat et une tâche par mise à jour (un paquet ou une famille publiée ensemble),
// puis clôt les constats devenus sans objet.
export async function syncDependencyFindings(
  transaction: Transaction,
  input: {
    workspaceId: string;
    applicationId: string;
    freshness: DependencyFreshness[];
    declaredDependencies: Array<{ ecosystem: string; manifestPath: string; name: string }>;
    existingFindings: TrackedFinding[];
    openNotificationFingerprints: Set<string>;
    checkedAt: Date;
  },
) {
  const { workspaceId, applicationId, checkedAt } = input;
  const updates = groupDependencies(input.freshness).filter((update) => update.status === "outdated");
  const declaredKeys = new Set(input.declaredDependencies.map(dependencyKey));
  const freshnessByKey = new Map(input.freshness.map((dependency) => [dependencyKey(dependency), dependency]));
  const updatesByPackage = new Map(updates.flatMap((update) => update.members.map((member) => [dependencyKey(member), update] as const)));
  const findingsByFingerprint = new Map(input.existingFindings.map((finding) => [finding.fingerprint, finding]));
  const expectedFingerprints = new Set<string>();
  const notificationEvents: DependencyNotification[] = [];

  for (const update of updates) {
    const fingerprint = dependencyFindingFingerprint(applicationId, update.manifestPath, update.lead.name);
    expectedFingerprints.add(fingerprint);
    const previousFinding = findingsByFingerprint.get(fingerprint);
    const severity = update.updateKind === "major" ? "medium" : "low";
    const copy = dependencyCopy(update);
    const metadata = findingMetadata(update);
    const [finding] = await transaction
      .insert(findings)
      .values({
        workspaceId,
        applicationId,
        kind: "dependency",
        severity,
        title: copy.title,
        description: copy.description,
        fingerprint,
        metadata,
      })
      .onConflictDoUpdate({
        target: [findings.workspaceId, findings.fingerprint],
        set: {
          severity,
          title: copy.title,
          description: copy.description,
          resolvedAt: null,
          metadata,
          updatedAt: checkedAt,
        },
      })
      .returning({ id: findings.id });

    const task = taskCopy(update);
    const [existingTask] = await transaction
      .select({ id: maintenanceTasks.id })
      .from(maintenanceTasks)
      .where(and(
        eq(maintenanceTasks.findingId, finding.id),
        inArray(maintenanceTasks.status, ["open", "planned", "in_progress"]),
      ))
      .limit(1);
    if (existingTask) {
      await transaction
        .update(maintenanceTasks)
        .set({
          title: task.title,
          description: task.description,
          severity,
          updatedAt: checkedAt,
        })
        .where(eq(maintenanceTasks.id, existingTask.id));
    } else {
      const dueAt = new Date(checkedAt);
      dueAt.setDate(dueAt.getDate() + (update.updateKind === "major" ? 14 : 30));
      const [createdTask] = await transaction.insert(maintenanceTasks).values({
        workspaceId,
        applicationId,
        findingId: finding.id,
        title: task.title,
        description: task.description,
        category: "dependency",
        severity,
        automatic: true,
        dueAt,
      }).returning({ id: maintenanceTasks.id });
      await transaction.insert(maintenanceTaskEvents).values({
        workspaceId,
        taskId: createdTask.id,
        action: "created",
        nextStatus: "open",
        note: "Tâche créée automatiquement par l’analyse des dépendances.",
      });
    }

    const previousLatest = typeof previousFinding?.metadata.latestVersion === "string"
      ? previousFinding.metadata.latestVersion
      : undefined;
    // Un constat créé avant le regroupement ne suivait qu'un paquet : on le signale une fois sous son nouveau nom.
    const regroupedLegacyFinding = previousFinding !== undefined
      && !Array.isArray(previousFinding.metadata.packages)
      && update.members.length > 1;
    const notificationFingerprint = dependencyNotificationFingerprint(applicationId, update.manifestPath, update.lead.name);
    if (
      !previousFinding
      || previousFinding.resolvedAt
      || previousLatest !== update.latestVersion
      || regroupedLegacyFinding
      || !input.openNotificationFingerprints.has(notificationFingerprint)
    ) {
      notificationEvents.push({
        kind: "update",
        label: update.label,
        manifestPath: update.manifestPath,
        currentVersion: update.currentVersion,
        latestVersion: update.latestVersion,
        updateKind: update.updateKind,
        packageCount: update.members.length,
        fingerprint: notificationFingerprint,
      });
    }
  }

  for (const finding of input.existingFindings) {
    if (finding.resolvedAt || expectedFingerprints.has(finding.fingerprint)) continue;
    const packages = trackedPackages(finding.metadata);
    if (packages.length === 0) continue;
    const manifestPath = typeof finding.metadata.manifestPath === "string" ? finding.metadata.manifestPath : "package.json";
    const keys = packages.map((name) => dependencyKey({ ecosystem: "npm", manifestPath, name }));
    // Une version inconnue, ou non vérifiée au-delà de la limite d'analyse, ne permet pas de conclure.
    if (keys.some((key) => declaredKeys.has(key) && (freshnessByKey.get(key)?.status ?? "unknown") === "unknown")) continue;

    const label = typeof finding.metadata.label === "string" ? finding.metadata.label : packages[0];
    const replacements = [...new Set(keys.flatMap((key) => updatesByPackage.get(key)?.label ?? []))];
    const removed = keys.every((key) => !declaredKeys.has(key));
    await resolveTrackedFinding(
      transaction,
      workspaceId,
      finding.id,
      checkedAt,
      replacements.length > 0
        ? `Tâche remplacée par la mise à jour de ${replacements.join(", ")}.`
        : removed
          ? `Tâche terminée automatiquement : ${label} n’est plus déclaré dans le dépôt.`
          : `Tâche terminée automatiquement : ${label} est à jour lors de l’analyse du dépôt.`,
    );
    notificationEvents.push({
      kind: replacements.length > 0 ? "superseded" : "resolved",
      label,
      manifestPath,
      packageCount: packages.length,
      fingerprint: dependencyNotificationFingerprint(
        applicationId,
        manifestPath,
        typeof finding.metadata.package === "string" ? finding.metadata.package : packages[0],
      ),
    });
  }

  return { updates, notificationEvents };
}

async function sendDependencyNotifications(
  workspaceId: string,
  application: { id: string; name: string },
  events: DependencyNotification[],
) {
  await Promise.allSettled(events.map((event) => {
    const location = event.manifestPath === "package.json" ? "" : ` · ${event.manifestPath}`;
    const packages = event.packageCount > 1 ? ` pour ${event.packageCount} paquets` : "";
    if (event.kind === "update") {
      return createOrRefreshNotification({
        workspaceId,
        title: `Nouvelle version de ${event.label}`,
        body: event.currentVersion
          ? `${application.name}${location} utilise ${event.currentVersion} ; ${event.latestVersion} est disponible${packages}.`
          : `${application.name}${location} peut être mis à jour vers ${event.latestVersion}${packages}.`,
        severity: event.updateKind === "major" ? "medium" : "low",
        targetUrl: "/maintenance?category=dependency",
        fingerprint: event.fingerprint,
        push: event.updateKind === "major",
      });
    }
    if (event.kind === "superseded") return resolveNotification(workspaceId, event.fingerprint);
    return resolveNotification(workspaceId, event.fingerprint, {
      title: `${event.label} est à jour`,
      body: `${application.name}${location} ne nécessite plus cette mise à jour.`,
      targetUrl: `/#application-${application.id}`,
    });
  }));
}

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
  const openNotificationFingerprints = new Set(existingNotifications.flatMap((notification) => notification.fingerprint ? [notification.fingerprint] : []));
  const manifestDependencyKeys = new Set(scan.dependencies.map(dependencyKey));

  const sync = await db.transaction(async (transaction) => {
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
    }

    for (const storedDependency of existingDependencies) {
      if (manifestDependencyKeys.has(dependencyKey(storedDependency))) continue;
      await transaction.delete(dependencies).where(eq(dependencies.id, storedDependency.id));
    }

    return syncDependencyFindings(transaction, {
      workspaceId,
      applicationId: application.id,
      freshness,
      declaredDependencies: scan.dependencies,
      existingFindings,
      openNotificationFingerprints,
      checkedAt,
    });
  });

  await sendDependencyNotifications(workspaceId, application, sync.notificationEvents);

  return {
    technologies: scan.technologies.length,
    dependencies: freshness.length,
    outdated: sync.updates.length,
  };
}
