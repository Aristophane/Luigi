import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  applications,
  dependencies,
  findings,
  maintenanceTasks,
  technologies,
} from "@/db/schema";
import { inspectNpmDependencies } from "@/lib/dependency-freshness";
import { getGitHubToken } from "@/lib/github-integration";
import { scanGitHubTechnologies } from "@/lib/technology-scanner";

export async function scanStoredApplication(workspaceId: string, applicationId: string) {
  const [application] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.id, applicationId), eq(applications.workspaceId, workspaceId)))
    .limit(1);
  if (!application) throw new Error("APPLICATION_NOT_FOUND");

  const token = await getGitHubToken(workspaceId);
  const scan = await scanGitHubTechnologies(application.githubRepository, application.githubBranch, token);
  const freshness = await inspectNpmDependencies(scan.dependencies);
  const checkedAt = new Date();

  await db.transaction(async (transaction) => {
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
          currentVersion: dependency.currentVersion,
          requestedRange: dependency.requestedRange,
          latestVersion: dependency.latestVersion,
          status: dependency.status,
          development: dependency.development,
          evidence: dependency.evidence,
          lastCheckedAt: dependency.status === "unsupported" ? undefined : checkedAt,
        })
        .onConflictDoUpdate({
          target: [dependencies.applicationId, dependencies.ecosystem, dependencies.name],
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

      const fingerprint = `application:${application.id}:dependency:npm:${dependency.name}:outdated`;
      if (dependency.status !== "outdated") {
        await transaction
          .update(findings)
          .set({ resolvedAt: checkedAt, updatedAt: checkedAt })
          .where(and(eq(findings.workspaceId, workspaceId), eq(findings.fingerprint, fingerprint)));
        continue;
      }

      const severity = dependency.updateKind === "major" ? "medium" : "low";
      const [finding] = await transaction
        .insert(findings)
        .values({
          workspaceId,
          applicationId: application.id,
          kind: "dependency",
          severity,
          title: `${dependency.name} ne permet pas la dernière version`,
          description: `La contrainte ${dependency.requestedRange} n’accepte pas la version ${dependency.latestVersion}.`,
          fingerprint,
          metadata: {
            ecosystem: dependency.ecosystem,
            package: dependency.name,
            requestedRange: dependency.requestedRange,
            latestVersion: dependency.latestVersion,
            updateKind: dependency.updateKind,
          },
        })
        .onConflictDoUpdate({
          target: [findings.workspaceId, findings.fingerprint],
          set: {
            severity,
            title: `${dependency.name} ne permet pas la dernière version`,
            description: `La contrainte ${dependency.requestedRange} n’accepte pas la version ${dependency.latestVersion}.`,
            resolvedAt: null,
            metadata: {
              ecosystem: dependency.ecosystem,
              package: dependency.name,
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
      if (!existingTask) {
        const dueAt = new Date();
        dueAt.setDate(dueAt.getDate() + (dependency.updateKind === "major" ? 14 : 30));
        await transaction.insert(maintenanceTasks).values({
          workspaceId,
          findingId: finding.id,
          title: `Mettre à jour ${dependency.name} vers ${dependency.latestVersion}`,
          description: `Adapter la contrainte ${dependency.requestedRange}, vérifier le changelog et exécuter les tests.`,
          category: "dependency",
          severity,
          automatic: true,
          dueAt,
        });
      }
    }
  });

  return {
    technologies: scan.technologies.length,
    dependencies: freshness.length,
    outdated: freshness.filter((dependency) => dependency.status === "outdated").length,
  };
}
