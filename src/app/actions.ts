"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  applications,
  checks,
  dependencies,
  findings,
  maintenanceTaskEvents,
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
        const [task] = await transaction.insert(maintenanceTasks).values({
          workspaceId,
          applicationId: application.id,
          findingId: finding.id,
          title: `Mettre à jour ${dependency.name} vers ${dependency.latestVersion}`,
          description: `Adapter la contrainte ${dependency.requestedRange}, vérifier le changelog et exécuter les tests.`,
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
  const { session, workspaceId } = await requireWorkspace();
  const changedAt = new Date();

  await db.transaction(async (transaction) => {
    const [task] = await transaction
      .select({ status: maintenanceTasks.status })
      .from(maintenanceTasks)
      .where(and(
        eq(maintenanceTasks.id, parsedId.data),
        eq(maintenanceTasks.workspaceId, workspaceId),
        inArray(maintenanceTasks.status, ["open", "planned", "in_progress"]),
      ))
      .limit(1);
    if (!task || task.status === "done") return;

    await transaction
      .update(maintenanceTasks)
      .set({ status: "done", completedAt: changedAt, updatedAt: changedAt })
      .where(eq(maintenanceTasks.id, parsedId.data));
    await transaction.insert(maintenanceTaskEvents).values({
      workspaceId,
      taskId: parsedId.data,
      actorId: session.user.id,
      action: "completed",
      previousStatus: task.status,
      nextStatus: "done",
      note: "Tâche marquée comme terminée depuis le cockpit.",
    });
  });
  revalidatePath("/");
}

export async function reopenMaintenanceTask(taskId: string) {
  const parsedId = z.string().uuid().safeParse(taskId);
  if (!parsedId.success) return;
  const { session, workspaceId } = await requireWorkspace();
  const changedAt = new Date();

  await db.transaction(async (transaction) => {
    const [task] = await transaction
      .select({ status: maintenanceTasks.status })
      .from(maintenanceTasks)
      .where(and(
        eq(maintenanceTasks.id, parsedId.data),
        eq(maintenanceTasks.workspaceId, workspaceId),
        inArray(maintenanceTasks.status, ["done", "dismissed"]),
      ))
      .limit(1);
    if (!task) return;

    await transaction
      .update(maintenanceTasks)
      .set({ status: "open", completedAt: null, updatedAt: changedAt })
      .where(eq(maintenanceTasks.id, parsedId.data));
    await transaction.insert(maintenanceTaskEvents).values({
      workspaceId,
      taskId: parsedId.data,
      actorId: session.user.id,
      action: "reopened",
      previousStatus: task.status,
      nextStatus: "open",
      note: "Tâche rouverte depuis l’historique.",
    });
  });
  revalidatePath("/");
}

const taskSchema = z.object({
  title: z.string().trim().min(3, "Le titre doit contenir au moins 3 caractères.").max(140),
  category: z.enum(["security", "dependency", "capacity", "backup", "lifecycle"]),
  severity: z.enum(["critical", "high", "medium", "low"]),
  applicationId: z.union([z.string().uuid(), z.literal("infrastructure")]).default("infrastructure"),
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
  const { session, workspaceId } = await requireWorkspace();
  const dueAt = parsed.data.dueDate ? new Date(`${parsed.data.dueDate}T12:00:00`) : undefined;
  const applicationId = parsed.data.applicationId === "infrastructure" ? null : parsed.data.applicationId;

  if (applicationId) {
    const [application] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(and(
        eq(applications.id, applicationId),
        eq(applications.workspaceId, workspaceId),
        isNull(applications.archivedAt),
      ))
      .limit(1);
    if (!application) return { status: "error", message: "Cette application n’est plus disponible." };
  }

  await db.transaction(async (transaction) => {
    const [task] = await transaction.insert(maintenanceTasks).values({
      workspaceId,
      applicationId,
      title: parsed.data.title,
      category: parsed.data.category,
      severity: parsed.data.severity,
      automatic: false,
      dueAt,
    }).returning({ id: maintenanceTasks.id });
    await transaction.insert(maintenanceTaskEvents).values({
      workspaceId,
      taskId: task.id,
      actorId: session.user.id,
      action: "created",
      nextStatus: "open",
      note: applicationId ? "Maintenance applicative créée manuellement." : "Maintenance du VPS créée manuellement.",
    });
  });
  revalidatePath("/");
  return { status: "success", message: "Tâche ajoutée à la liste de maintenance." };
}

export async function archiveApplication(applicationId: string) {
  const parsedId = z.string().uuid().safeParse(applicationId);
  if (!parsedId.success) return;
  const { session, workspaceId } = await requireWorkspace();
  const archivedAt = new Date();

  await db.transaction(async (transaction) => {
    const [application] = await transaction
      .select({ id: applications.id, name: applications.name })
      .from(applications)
      .where(and(
        eq(applications.id, parsedId.data),
        eq(applications.workspaceId, workspaceId),
        isNull(applications.archivedAt),
      ))
      .limit(1);
    if (!application) return;

    const activeTasks = await transaction
      .select({ id: maintenanceTasks.id, status: maintenanceTasks.status })
      .from(maintenanceTasks)
      .where(and(
        eq(maintenanceTasks.workspaceId, workspaceId),
        eq(maintenanceTasks.applicationId, application.id),
        inArray(maintenanceTasks.status, ["open", "planned", "in_progress"]),
      ));

    await transaction
      .update(checks)
      .set({ enabled: false, updatedAt: archivedAt })
      .where(eq(checks.applicationId, application.id));
    await transaction
      .update(applications)
      .set({ archivedAt, status: "unknown", updatedAt: archivedAt })
      .where(eq(applications.id, application.id));

    for (const task of activeTasks) {
      await transaction
        .update(maintenanceTasks)
        .set({ status: "dismissed", completedAt: archivedAt, updatedAt: archivedAt })
        .where(eq(maintenanceTasks.id, task.id));
      await transaction.insert(maintenanceTaskEvents).values({
        workspaceId,
        taskId: task.id,
        actorId: session.user.id,
        action: "application_archived",
        previousStatus: task.status,
        nextStatus: "dismissed",
        note: `Tâche classée lors de la suppression de l’application ${application.name}.`,
      });
    }
  });

  revalidatePath("/");
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
