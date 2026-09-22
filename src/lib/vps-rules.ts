import "server-only";

import { and, asc, desc, eq, gte, inArray, isNull, like, lt, lte } from "drizzle-orm";
import type { Database } from "@/db";
import { findings, maintenanceTaskEvents, maintenanceTasks, vpsMetricSamples } from "@/db/schema";
import { createOrRefreshNotification, resolveNotification } from "@/lib/notifications";
import { runtimeObservationState, runtimeRecoveryProven, vpsReportSchema, type VpsReport, type VpsRuntime } from "@/lib/vps-report";

const RUNTIME_WINDOW_MS = 24 * 60 * 60 * 1000;
const RUNTIME_FINGERPRINT_PREFIX = "vps:runtime:";
const HOST_OOM_FINGERPRINT = `${RUNTIME_FINGERPRINT_PREFIX}oom-host`;
const MEMORY_CEILING_RATIO = 0.85;
const MEMORY_CEILING_RECOVERY_RATIO = 0.8;

type Rule = {
  fingerprint: string;
  active: boolean;
  recoveryProven?: boolean;
  kind: "capacity" | "security" | "backup" | "lifecycle";
  severity: "critical" | "high" | "medium" | "low";
  findingTitle: string;
  description: string;
  taskTitle: string;
  dueInDays: number;
};

async function applyRule(workspaceId: string, rule: Rule, observedAt: Date, serverId: string, db: Database, serverLabel?: string) {
  rule = { ...rule, fingerprint: rule.fingerprint.replace(/^vps:/, 'vps:' + serverId + ':') };
  if (serverLabel && rule.active) rule = { ...rule, findingTitle: `${serverLabel} · ${rule.findingTitle}`, taskTitle: `${serverLabel} · ${rule.taskTitle}` };
  if (!rule.active && !rule.recoveryProven) return;
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
    await resolveNotification(workspaceId, `finding:${rule.fingerprint}`, {
      title: `${rule.findingTitle} · résolu`,
      body: "Le dernier rapport confirme un retour à la normale.",
      targetUrl: "/#vps",
    }, db);
    return;
  }

  const isNewOccurrence = !existing || Boolean(existing.resolvedAt);
  const [finding] = await db
    .insert(findings)
    .values({
      workspaceId,
      serverId,
      kind: rule.kind,
      severity: rule.severity,
      title: rule.findingTitle,
      description: rule.description,
      fingerprint: rule.fingerprint,
      metadata: { source: "vps_agent", serverId },
    })
    .onConflictDoUpdate({
      target: [findings.workspaceId, findings.fingerprint],
      set: {
        kind: rule.kind,
        severity: rule.severity,
        title: rule.findingTitle,
        description: rule.description,
        resolvedAt: null,
        metadata: { source: "vps_agent", serverId },
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
  let taskId = activeTask?.id;
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
      taskId = task.id;
    });
  }

  if (isNewOccurrence && (rule.severity === "critical" || rule.severity === "high")) {
    await createOrRefreshNotification({
      workspaceId,
      title: rule.findingTitle,
      body: rule.description,
      severity: rule.severity,
      targetUrl: taskId ? `/maintenance#maintenance-task-${taskId}` : "/#vps",
      fingerprint: `finding:${rule.fingerprint}`,
    }, db);
  }
}

export async function evaluateVpsReport(workspaceId: string, report: VpsReport, observedAt: Date, serverId: string, db: Database) {
  const recentMemory = await db
    .select({ memoryPercent: vpsMetricSamples.memoryPercent })
    .from(vpsMetricSamples)
    .where(and(eq(vpsMetricSamples.serverId, serverId), lte(vpsMetricSamples.observedAt, observedAt), gte(vpsMetricSamples.observedAt, new Date(observedAt.getTime() - 30 * 60_000))))
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
      recoveryProven: report.metrics.diskPercent < 80,
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
      recoveryProven: report.metrics.memoryPercent < 80,
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
      recoveryProven: report.updates.security === 0,
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
      recoveryProven: !report.updates.rebootRequired,
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
      recoveryProven: report.security.ufwActive === true,
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
      recoveryProven: report.security.sshPasswordAuthentication === false,
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
      recoveryProven: report.security.sshRootLogin === false,
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
      recoveryProven: report.updates.held === 0,
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
      recoveryProven: report.backup?.status === "ok" && Boolean(backupDate) && !backupExpired,
      kind: "backup",
      severity: "high",
      findingTitle: report.backup?.status === "failed" ? "La dernière sauvegarde a échoué" : "La sauvegarde du VPS est trop ancienne",
      description: "Relancer la sauvegarde, vérifier son stockage hors serveur et conserver une preuve de restauration.",
      taskTitle: "Rétablir une sauvegarde récente du VPS",
      dueInDays: 1,
    },
  ];

  for (const rule of rules) await applyRule(workspaceId, rule, observedAt, serverId, db, report.hostname);
  if (report.runtime) await evaluateRuntime(workspaceId, report.runtime, observedAt, serverId, db, report.hostname);
}

type RuntimeEvent = VpsRuntime["events"][number];
type RuntimeUnit = VpsRuntime["units"][number];

function formatBytes(value: number) {
  const mebibytes = value / (1024 * 1024);
  return mebibytes >= 1024
    ? `${(mebibytes / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Go`
    : `${Math.round(mebibytes)} Mo`;
}

function formatEventTime(value: string) {
  return new Date(value).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function latestEvent(events: RuntimeEvent[]) {
  return events.reduce((latest, event) => Date.parse(event.occurredAt) > Date.parse(latest.occurredAt) ? event : latest);
}

function unitNoun(unitKey: string) {
  return unitKey.startsWith("container:") ? "le conteneur" : unitKey.startsWith("service:") ? "le service" : "son groupe de processus";
}

/**
 * Un arrêt mémoire du noyau ou un redémarrage automatique reste signalé 24 h :
 * une fuite relance souvent le même cycle quelques heures plus tard.
 */
function crashRule(unitKey: string, events: RuntimeEvent[]): Rule {
  const label = latestEvent(events).unitLabel;
  const oomKills = events.filter((event) => event.type === "oom_kill");
  const restarts = events
    .filter((event) => event.type === "restart")
    .reduce((total, event) => total + (event.count ?? 1), 0);
  const fingerprint = `${RUNTIME_FINGERPRINT_PREFIX}crash:${unitKey}`;

  if (oomKills.length > 0) {
    const lastKill = latestEvent(oomKills);
    const cause = lastKill.scope === "host"
      ? "car le VPS manquait de mémoire"
      : `car ${unitNoun(unitKey)} a atteint sa limite mémoire`;
    const residentMemory = lastKill.anonRssBytes ? `, ${formatBytes(lastKill.anonRssBytes)} en mémoire` : "";
    const followingRestarts = restarts > 0
      ? ` ${restarts} redémarrage${restarts > 1 ? "s" : ""} automatique${restarts > 1 ? "s ont" : " a"} suivi.`
      : "";
    return {
      fingerprint,
      active: true,
      kind: "capacity",
      severity: "critical",
      findingTitle: `${label} : ${oomKills.length} arrêt${oomKills.length > 1 ? "s" : ""} par manque de mémoire en 24 h`,
      description: `Le noyau a arrêté ${lastKill.task || "un processus"} ${cause} (dernier arrêt le ${formatEventTime(lastKill.occurredAt)}${residentMemory}).${followingRestarts} Rechercher une fuite mémoire, vérifier la taille du heap Node (--max-old-space-size) et la limite mémoire définie dans Coolify.`,
      taskTitle: `Corriger la saturation mémoire de ${label}`,
      dueInDays: 1,
    };
  }

  const repeated = restarts >= 3;
  return {
    fingerprint,
    active: true,
    kind: "capacity",
    severity: repeated ? "critical" : "high",
    findingTitle: `${label} a redémarré ${restarts} fois sans intervention en 24 h`,
    description: `Dernier redémarrage le ${formatEventTime(latestEvent(events).occurredAt)}. Consulter les journaux juste avant cette heure : un dépassement du heap V8 (« Reached heap limit ») arrête Node sans passer par le noyau et n’apparaît que sous forme de redémarrage.`,
    taskTitle: `Diagnostiquer les redémarrages de ${label}`,
    dueInDays: repeated ? 1 : 2,
  };
}

function memoryRatio(unit: RuntimeUnit | undefined) {
  if (!unit?.running || !unit.memoryMaxBytes || unit.memoryCurrentBytes === null) return null;
  return unit.memoryCurrentBytes / unit.memoryMaxBytes;
}

async function unexplainedOomKills(serverId: string, runtime: VpsRuntime, observedAt: Date, attributed: number, db: Database) {
  if (runtime.oomKillsSinceBoot === null) return { count: null, fullWindow: false };
  const [baseline] = await db
    .select({ payload: vpsMetricSamples.payload, observedAt: vpsMetricSamples.observedAt })
    .from(vpsMetricSamples)
    .where(and(
      eq(vpsMetricSamples.serverId, serverId),
      gte(vpsMetricSamples.observedAt, new Date(observedAt.getTime() - RUNTIME_WINDOW_MS - 15 * 60_000)),
      lt(vpsMetricSamples.observedAt, observedAt),
    ))
    .orderBy(asc(vpsMetricSamples.observedAt))
    .limit(1);
  const baselineRuntime = baseline ? vpsReportSchema.safeParse(baseline.payload).data?.runtime : undefined;
  if (!baselineRuntime || baselineRuntime.oomKillsSinceBoot === null) return { count: null, fullWindow: false };
  // Après un redémarrage du VPS dans la fenêtre, tout le compteur courant appartient aux dernières 24 h.
  const increase = baselineRuntime.bootId === runtime.bootId
    ? runtime.oomKillsSinceBoot - baselineRuntime.oomKillsSinceBoot
    : runtime.oomKillsSinceBoot;
  return { count: Math.max(0, increase - attributed), fullWindow: baseline.observedAt.getTime() <= observedAt.getTime() - RUNTIME_WINDOW_MS };
}

async function evaluateRuntime(workspaceId: string, runtime: VpsRuntime, observedAt: Date, serverId: string, db: Database, serverLabel: string) {
  const state = runtimeObservationState(runtime, observedAt);
  const collectorFresh = state === "complete" || state === "partial";
  const windowStart = observedAt.getTime() - RUNTIME_WINDOW_MS;
  const recentEvents = collectorFresh
    ? runtime.events.filter((event) => Date.parse(event.occurredAt) >= windowStart)
    : [];
  const storedRuntimeFindings = await db
    .select({ fingerprint: findings.fingerprint, title: findings.title })
    .from(findings)
    .where(and(
      eq(findings.workspaceId, workspaceId),
      isNull(findings.resolvedAt),
      eq(findings.serverId, serverId),
      like(findings.fingerprint, `vps:${serverId}:runtime:%`),
    ));
  const openRuntimeFindings = storedRuntimeFindings.map((finding) => ({ ...finding, fingerprint: finding.fingerprint.replace(`vps:${serverId}:`, "vps:") }));
  const openFingerprints = new Set(openRuntimeFindings.map((finding) => finding.fingerprint));
  const rules: Rule[] = [];

  const eventsByUnit = new Map<string, RuntimeEvent[]>();
  for (const event of recentEvents) {
    eventsByUnit.set(event.unitKey, [...eventsByUnit.get(event.unitKey) ?? [], event]);
  }
  for (const [unitKey, events] of eventsByUnit) rules.push(crashRule(unitKey, events));

  const previousSamples = await db
    .select({ payload: vpsMetricSamples.payload, observedAt: vpsMetricSamples.observedAt })
    .from(vpsMetricSamples)
    .where(and(eq(vpsMetricSamples.serverId, serverId), lt(vpsMetricSamples.observedAt, observedAt),
      gte(vpsMetricSamples.observedAt, new Date(observedAt.getTime() - 30 * 60_000))))
    .orderBy(desc(vpsMetricSamples.observedAt))
    .limit(12);
  // Batches can rotate: compare with the latest actual observation of this unit.
  const previousUnits = new Map<string, RuntimeUnit>();
  for (const sample of previousSamples) {
    const previousRuntime = vpsReportSchema.safeParse(sample.payload).data?.runtime;
    const previousState = runtimeObservationState(previousRuntime, sample.observedAt);
    if (!previousRuntime || previousState === "absent" || previousState === "stale") continue;
    for (const unit of previousRuntime.units) if (!previousUnits.has(unit.key)) previousUnits.set(unit.key, unit);
  }
  for (const unit of collectorFresh ? runtime.units : []) {
    const ratio = memoryRatio(unit);
    if (ratio === null || unit.memoryCurrentBytes === null || !unit.memoryMaxBytes) continue;
    const fingerprint = `${RUNTIME_FINGERPRINT_PREFIX}memory-ceiling:${unit.key}`;
    const previousRatio = memoryRatio(previousUnits.get(unit.key)) ?? 0;
    const sustained = ratio >= MEMORY_CEILING_RATIO && previousRatio >= MEMORY_CEILING_RATIO;
    const stillHigh = openFingerprints.has(fingerprint) && ratio >= MEMORY_CEILING_RECOVERY_RATIO;
    if (!sustained && !stillHigh) continue;
    const subject = unit.kind === "container" ? "Le conteneur" : "Le service";
    rules.push({
      fingerprint,
      active: true,
      kind: "capacity",
      severity: "high",
      findingTitle: `${unit.label} utilise ${Math.round(ratio * 100)} % de sa limite mémoire`,
      description: `${subject} occupe ${formatBytes(unit.memoryCurrentBytes)} sur ${formatBytes(unit.memoryMaxBytes)} depuis au moins deux collectes. Au-delà de la limite, le noyau arrête le processus. Rechercher une fuite mémoire ou ajuster la limite dans Coolify.`,
      taskTitle: `Examiner la consommation mémoire de ${unit.label}`,
      dueInDays: 2,
    });
  }

  const attributedOomKills = recentEvents.filter((event) => event.type === "oom_kill").length;
  const hostOom = await unexplainedOomKills(serverId, runtime, observedAt, attributedOomKills, db);
  const unexplained = hostOom.count;
  rules.push({
    fingerprint: HOST_OOM_FINGERPRINT,
    active: unexplained !== null && unexplained > 0,
    recoveryProven: state === "complete" && unexplained === 0 && hostOom.fullWindow
      && Boolean(runtime.completeness?.eventsSince && Date.parse(runtime.completeness.eventsSince) <= windowStart),
    kind: "capacity",
    severity: "critical",
    findingTitle: `${unexplained} processus arrêté${(unexplained ?? 0) > 1 ? "s" : ""} par manque de mémoire sur le VPS en 24 h`,
    description: collectorFresh
      ? "Le noyau a arrêté des processus faute de mémoire sans que le collecteur d’exécution puisse les rattacher à un conteneur ou un service. Consulter « journalctl -k | grep -i oom » sur le VPS."
      : "Le noyau a arrêté des processus faute de mémoire. Le collecteur d’exécution ne répond pas : réinstalle l’agent depuis Paramètres → VPS pour identifier le conteneur concerné.",
    taskTitle: "Identifier le processus arrêté par manque de mémoire",
    dueInDays: 1,
  });

  // Une omission ne prouve rien : seule une mesure de récupération explicite clôt un constat.
  if (collectorFresh) {
    const activeFingerprints = new Set(rules.map((rule) => rule.fingerprint));
    for (const finding of openRuntimeFindings) {
      if (activeFingerprints.has(finding.fingerprint)) continue;
      const kind = finding.fingerprint.includes(":memory-ceiling:") ? "memory" : "crash";
      const key = finding.fingerprint.split(kind === "memory" ? ":memory-ceiling:" : ":crash:")[1];
      if (!key || !runtimeRecoveryProven(runtime, kind, key, observedAt)) continue;
      rules.push({
        fingerprint: finding.fingerprint,
        active: false,
        recoveryProven: true,
        kind: "capacity",
        severity: "low",
        findingTitle: finding.title,
        description: "",
        taskTitle: "",
        dueInDays: 0,
      });
    }
  }

  for (const rule of rules) await applyRule(workspaceId, rule, observedAt, serverId, db, serverLabel);
}
