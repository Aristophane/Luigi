import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { findings, maintenanceTaskEvents, maintenanceTasks, notifications, vpsMetricSamples } from "@/db/schema";
import type { VpsReport } from "@/lib/vps-report";

type Rule = {
  fingerprint: string;
  active: boolean;
  kind: "capacity" | "security" | "backup" | "lifecycle";
  severity: "critical" | "high" | "medium" | "low";
  findingTitle: string;
  description: string;
  taskTitle: string;
  dueInDays: number;
};

async function applyRule(workspaceId: string, rule: Rule, observedAt: Date) {
  const [existing] = await db
    .select({ id: findings.id, resolvedAt: findings.resolvedAt })
    .from(findings)
    .where(and(eq(findings.workspaceId, workspaceId), eq(findings.fingerprint, rule.fingerprint)))
    .limit(1);

  if (!rule.active) {
    if (!existing || existing.resolvedAt) return;
    await db.transaction(async (transaction) => {
      const tasksToResolve = await transaction
        .select({ id: maintenanceTasks.id, status: maintenanceTasks.status })
        .from(maintenanceTasks)
        .where(and(
          eq(maintenanceTasks.findingId, existing.id),
          inArray(maintenanceTasks.status, ["open", "planned", "in_progress"]),
        ));
      await transaction
        .update(findings)
        .set({ resolvedAt: observedAt, updatedAt: observedAt })
        .where(eq(findings.id, existing.id));
      await transaction
        .update(maintenanceTasks)
        .set({ status: "done", completedAt: observedAt, updatedAt: observedAt })
        .where(and(
          eq(maintenanceTasks.findingId, existing.id),
          inArray(maintenanceTasks.status, ["open", "planned", "in_progress"]),
        ));
      if (tasksToResolve.length > 0) {
        await transaction.insert(maintenanceTaskEvents).values(tasksToResolve.map((task) => ({
          workspaceId,
          taskId: task.id,
          action: "auto_resolved",
          previousStatus: task.status,
          nextStatus: "done" as const,
          note: "Le signal VPS à l’origine de la tâche est revenu à la normale.",
          createdAt: observedAt,
        })));
      }
    });
    return;
  }

  const isNewOccurrence = !existing || Boolean(existing.resolvedAt);
  const [finding] = await db
    .insert(findings)
    .values({
      workspaceId,
      kind: rule.kind,
      severity: rule.severity,
      title: rule.findingTitle,
      description: rule.description,
      fingerprint: rule.fingerprint,
      metadata: { source: "vps_agent" },
    })
    .onConflictDoUpdate({
      target: [findings.workspaceId, findings.fingerprint],
      set: {
        kind: rule.kind,
        severity: rule.severity,
        title: rule.findingTitle,
        description: rule.description,
        resolvedAt: null,
        metadata: { source: "vps_agent" },
        updatedAt: observedAt,
      },
    })
    .returning({ id: findings.id });

  const [activeTask] = await db
    .select({ id: maintenanceTasks.id })
    .from(maintenanceTasks)
    .where(and(
      eq(maintenanceTasks.findingId, finding.id),
      inArray(maintenanceTasks.status, ["open", "planned", "in_progress"]),
    ))
    .limit(1);
  if (!activeTask) {
    const dueAt = new Date(observedAt);
    dueAt.setDate(dueAt.getDate() + rule.dueInDays);
    await db.transaction(async (transaction) => {
      const [task] = await transaction.insert(maintenanceTasks).values({
        workspaceId,
        findingId: finding.id,
        title: rule.taskTitle,
        description: rule.description,
        category: rule.kind,
        severity: rule.severity,
        automatic: true,
        dueAt,
      }).returning({ id: maintenanceTasks.id });
      await transaction.insert(maintenanceTaskEvents).values({
        workspaceId,
        taskId: task.id,
        action: "created",
        nextStatus: "open",
        note: "Tâche créée automatiquement à partir d’un rapport VPS.",
        createdAt: observedAt,
      });
    });
  }

  if (isNewOccurrence && (rule.severity === "critical" || rule.severity === "high")) {
    await db.insert(notifications).values({
      workspaceId,
      title: rule.findingTitle,
      body: rule.description,
      severity: rule.severity,
      targetUrl: "/#vps",
    });
  }
}

export async function evaluateVpsReport(workspaceId: string, report: VpsReport, observedAt: Date) {
  const recentMemory = await db
    .select({ memoryPercent: vpsMetricSamples.memoryPercent })
    .from(vpsMetricSamples)
    .where(eq(vpsMetricSamples.workspaceId, workspaceId))
    .orderBy(desc(vpsMetricSamples.observedAt))
    .limit(3);
  const sustainedMemoryPressure = recentMemory.length >= 3
    && recentMemory.every((sample) => (sample.memoryPercent ?? 0) >= 90);
  const diskSeverity = report.metrics.diskPercent >= 90 ? "critical" : "high";
  const backupDate = report.backup?.lastSuccessAt ? new Date(report.backup.lastSuccessAt) : null;
  const backupExpired = report.backup?.status === "failed"
    || Boolean(backupDate && observedAt.getTime() - backupDate.getTime() > 24 * 60 * 60 * 1000);

  const rules: Rule[] = [
    {
      fingerprint: "vps:capacity:disk-root",
      active: report.metrics.diskPercent >= 80,
      kind: "capacity",
      severity: diskSeverity,
      findingTitle: `Disque racine utilisé à ${Math.round(report.metrics.diskPercent)} %`,
      description: "Identifier la croissance, nettoyer les données temporaires et confirmer la marge nécessaire avant saturation.",
      taskTitle: "Libérer de l’espace sur le VPS",
      dueInDays: report.metrics.diskPercent >= 90 ? 1 : 7,
    },
    {
      fingerprint: "vps:capacity:memory-pressure",
      active: sustainedMemoryPressure,
      kind: "capacity",
      severity: "high",
      findingTitle: "Pression mémoire persistante sur le VPS",
      description: "La mémoire dépasse 90 % sur trois collectes consécutives. Examiner les services et l’usage du swap.",
      taskTitle: "Diagnostiquer la pression mémoire du VPS",
      dueInDays: 2,
    },
    {
      fingerprint: "vps:security:updates",
      active: report.updates.security > 0,
      kind: "security",
      severity: "high",
      findingTitle: `${report.updates.security} correctif${report.updates.security > 1 ? "s" : ""} de sécurité disponible${report.updates.security > 1 ? "s" : ""}`,
      description: "Installer les correctifs Ubuntu autorisés puis vérifier les services et la disponibilité des applications.",
      taskTitle: "Appliquer les correctifs de sécurité Ubuntu",
      dueInDays: 1,
    },
    {
      fingerprint: "vps:lifecycle:reboot-required",
      active: report.updates.rebootRequired,
      kind: "lifecycle",
      severity: "medium",
      findingTitle: "Un redémarrage du VPS est requis",
      description: "Planifier une fenêtre, vérifier les sauvegardes, redémarrer puis exécuter les contrôles post-maintenance.",
      taskTitle: "Planifier le redémarrage du VPS",
      dueInDays: 7,
    },
    {
      fingerprint: "vps:security:ufw-disabled",
      active: report.security.ufwActive === false,
      kind: "security",
      severity: "high",
      findingTitle: "Le pare-feu UFW n’est pas actif",
      description: "Vérifier les ports nécessaires et réactiver une politique entrante restrictive sans interrompre l’accès SSH.",
      taskTitle: "Réactiver et vérifier UFW",
      dueInDays: 1,
    },
    {
      fingerprint: "vps:security:ssh-password",
      active: report.security.sshPasswordAuthentication === true,
      kind: "security",
      severity: "high",
      findingTitle: "L’authentification SSH par mot de passe est active",
      description: "Confirmer un accès de secours par clé avant de désactiver PasswordAuthentication dans la configuration SSH.",
      taskTitle: "Désactiver l’authentification SSH par mot de passe",
      dueInDays: 3,
    },
    {
      fingerprint: "vps:security:ssh-root-login",
      active: report.security.sshRootLogin === true,
      kind: "security",
      severity: "high",
      findingTitle: "La connexion SSH directe de root est autorisée",
      description: "Valider un compte administrateur avec sudo et un accès de secours avant de désactiver PermitRootLogin.",
      taskTitle: "Désactiver la connexion SSH directe de root",
      dueInDays: 3,
    },
    {
      fingerprint: "vps:lifecycle:held-packages",
      active: report.updates.held > 0,
      kind: "lifecycle",
      severity: "medium",
      findingTitle: `${report.updates.held} paquet${report.updates.held > 1 ? "s" : ""} Ubuntu retenu${report.updates.held > 1 ? "s" : ""}`,
      description: "Identifier la raison du blocage, vérifier la compatibilité applicative et planifier la mise à jour manuellement.",
      taskTitle: "Examiner les paquets Ubuntu retenus",
      dueInDays: 7,
    },
    {
      fingerprint: "vps:backup:stale",
      active: backupExpired,
      kind: "backup",
      severity: "high",
      findingTitle: report.backup?.status === "failed" ? "La dernière sauvegarde a échoué" : "La sauvegarde du VPS est trop ancienne",
      description: "Relancer la sauvegarde, vérifier son stockage hors serveur et conserver une preuve de restauration.",
      taskTitle: "Rétablir une sauvegarde récente du VPS",
      dueInDays: 1,
    },
  ];

  for (const rule of rules) await applyRule(workspaceId, rule, observedAt);
}
