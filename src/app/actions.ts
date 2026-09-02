"use server";

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  applications,
  checks,
  dependencies,
  findings,
  maintenanceTasks,
  technologies,
} from "@/db/schema";
import { requireWorkspace } from "@/lib/dal";
import { inspectNpmDependencies } from "@/lib/dependency-freshness";
import { scanStoredApplication } from "@/lib/application-scanner";
import { GitHubApiError } from "@/lib/github";
import { getGitHubToken } from "@/lib/github-integration";
import { runWorkspaceHttpChecks } from "@/lib/http-monitor";
import { scanGitHubTechnologies } from "@/lib/technology-scanner";

export type CreateApplicationState = {
  status: "idle" | "success" | "error";
  message: string;
};

export type CreateTaskState = CreateApplicationState;

export async function runMonitoringNow() {
  const { workspaceId } = await requireWorkspace();
  const results = await runWorkspaceHttpChecks(workspaceId);
  revalidatePath("/");
  return {
    checked: results.length,
    healthy: results.filter((result) => result.status === "healthy").length,
    warning: results.filter((result) => result.status === "warning").length,
    critical: results.filter((result) => result.status === "critical").length,
  };
}

const applicationSchema = z.object({
  name: z.string().trim().min(2, "Le nom doit contenir au moins 2 caractères.").max(80),
  url: z.string().trim().url("L’URL publique n’est pas valide.").refine(
    (value) => value.startsWith("https://") || value.startsWith("http://"),
    "L’URL doit commencer par http:// ou https://.",
  ),
  repository: z.string().trim().regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "Utilise le format organisation/depot.",
  ),
  branch: z.string().trim().min(1).max(100).default("main"),
  environment: z.enum(["production", "staging", "development"]),
});

export async function createApplication(
  _previousState: CreateApplicationState,
  formData: FormData,
): Promise<CreateApplicationState> {
  const { workspaceId } = await requireWorkspace();
  const parsed = applicationSchema.safeParse(Object.fromEntries(formData.entries()));

  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Formulaire incomplet." };
  }

  const normalizedUrl = new URL(parsed.data.url);
  normalizedUrl.hash = "";
  normalizedUrl.search = "";
  normalizedUrl.pathname = normalizedUrl.pathname.replace(/\/$/, "") || "/";
  const repository = parsed.data.repository.replace(/\.git$/i, "");

  const token = await getGitHubToken(workspaceId);
  let scan: Awaited<ReturnType<typeof scanGitHubTechnologies>>;
  try {
    scan = await scanGitHubTechnologies(repository, parsed.data.branch, token);
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return {
        status: "error",
        message: token
          ? "GitHub est connecté, mais ce jeton ne voit pas ce dépôt ou cette branche. Ajoute le dépôt à l’accès du jeton, puis vérifie le nom de la branche."
          : "Dépôt ou branche introuvable. Pour un dépôt privé, connecte d’abord GitHub dans les paramètres.",
      };
    }
    if (error instanceof GitHubApiError && (error.status === 401 || error.status === 403)) {
      return { status: "error", message: "GitHub refuse l’accès à ce dépôt avec les permissions actuelles." };
    }
    return { status: "error", message: "L’analyse GitHub n’a pas pu aboutir. Réessaie dans quelques instants." };
  }
  const dependencyFreshness = await inspectNpmDependencies(scan.dependencies);

  try {
    await db.transaction(async (transaction) => {
      const [application] = await transaction
        .insert(applications)
        .values({
          workspaceId,
          name: parsed.data.name,
          environment: parsed.data.environment,
          publicUrl: normalizedUrl.toString(),
          githubRepository: repository,
          githubBranch: parsed.data.branch,
          repositoryCommit: scan.commitSha,
          lastRepositoryScannedAt: new Date(),
        })
        .returning({ id: applications.id });

      await transaction.insert(checks).values({
        applicationId: application.id,
        kind: "http",
        target: normalizedUrl.toString(),
      });

      if (scan.technologies.length > 0) {
        await transaction.insert(technologies).values(scan.technologies.map((technology) => ({
          applicationId: application.id,
          name: technology.name,
          version: technology.version,
          source: "detected",
          evidence: technology.evidence,
        })));
      }

      if (dependencyFreshness.length > 0) {
        await transaction.insert(dependencies).values(dependencyFreshness.map((dependency) => ({
          applicationId: application.id,
          ecosystem: dependency.ecosystem,
          name: dependency.name,
          currentVersion: dependency.currentVersion,
          requestedRange: dependency.requestedRange,
          latestVersion: dependency.latestVersion,
          status: dependency.status,
          development: dependency.development,
          evidence: dependency.evidence,
          lastCheckedAt: dependency.status === "unsupported" ? undefined : new Date(),
        })));
      }

      for (const dependency of dependencyFreshness.filter((item) => item.status === "outdated")) {
        const severity = dependency.updateKind === "major" ? "medium" : "low";
        const [finding] = await transaction.insert(findings).values({
          workspaceId,
          applicationId: application.id,
          kind: "dependency",
          severity,
          title: `${dependency.name} ne permet pas la dernière version`,
          description: `La contrainte ${dependency.requestedRange} n’accepte pas la version ${dependency.latestVersion}.`,
          fingerprint: `application:${application.id}:dependency:npm:${dependency.name}:outdated`,
          metadata: {
            ecosystem: dependency.ecosystem,
            package: dependency.name,
            requestedRange: dependency.requestedRange,
            latestVersion: dependency.latestVersion,
            updateKind: dependency.updateKind,
          },
        }).returning({ id: findings.id });

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
    });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505") {
      return { status: "error", message: "Cette URL est déjà surveillée dans ton espace." };
    }
    return { status: "error", message: "L’application n’a pas pu être enregistrée." };
  }

  revalidatePath("/");
  return {
    status: "success",
    message: scan.technologies.length > 0
      ? `${scan.technologies.length} technologie${scan.technologies.length > 1 ? "s" : ""} et ${dependencyFreshness.length} dépendance${dependencyFreshness.length > 1 ? "s" : ""} analysées dans ${repository}.`
      : `Application enregistrée. Aucun manifeste reconnu à la racine de ${repository}.`,
  };
}

export async function completeMaintenanceTask(taskId: string) {
  const parsedId = z.string().uuid().safeParse(taskId);
  if (!parsedId.success) return;
  const { workspaceId } = await requireWorkspace();

  await db
    .update(maintenanceTasks)
    .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
    .where(and(
      eq(maintenanceTasks.id, parsedId.data),
      eq(maintenanceTasks.workspaceId, workspaceId),
    ));
  revalidatePath("/");
}

const taskSchema = z.object({
  title: z.string().trim().min(3, "Le titre doit contenir au moins 3 caractères.").max(140),
  category: z.enum(["security", "dependency", "capacity", "backup", "lifecycle"]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  dueDate: z.string().optional(),
});

export async function createMaintenanceTask(
  _previousState: CreateTaskState,
  formData: FormData,
): Promise<CreateTaskState> {
  const parsed = taskSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Formulaire incomplet." };
  }
  const { workspaceId } = await requireWorkspace();
  const dueAt = parsed.data.dueDate ? new Date(`${parsed.data.dueDate}T12:00:00`) : undefined;

  await db.insert(maintenanceTasks).values({
    workspaceId,
    title: parsed.data.title,
    category: parsed.data.category,
    severity: parsed.data.severity,
    automatic: false,
    dueAt,
  });
  revalidatePath("/");
  return { status: "success", message: "Tâche ajoutée à la liste de maintenance." };
}

export async function scanApplication(applicationId: string) {
  const parsedId = z.string().uuid().safeParse(applicationId);
  if (!parsedId.success) return { status: "error" as const, message: "Application invalide." };
  const { workspaceId } = await requireWorkspace();

  try {
    const result = await scanStoredApplication(workspaceId, parsedId.data);
    revalidatePath("/");
    return {
      status: "success" as const,
      message: `${result.technologies} technologies, ${result.dependencies} dépendances, ${result.outdated} action à prévoir.`,
    };
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      return { status: "error" as const, message: "Dépôt inaccessible. Vérifie la branche ou la connexion GitHub." };
    }
    return { status: "error" as const, message: "L’analyse GitHub a échoué." };
  }
}
