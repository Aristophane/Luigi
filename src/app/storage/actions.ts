"use server";

import { and, desc, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { applications, maintenanceTaskEvents, maintenanceTasks, storageResourceMappings, vpsStorageSnapshots } from "@/db/schema";
import { requireWorkspace } from "@/lib/dal";
import { storageSnapshotSchema } from "@/lib/storage-report";

const mappingSchema = z.object({
  resourceKey: z.string().min(1).max(600),
  applicationId: z.union([z.string().uuid(), z.literal("infrastructure")]),
});

export async function assignStorageResource(formData: FormData) {
  const parsed = mappingSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return;
  const { workspaceId } = await requireWorkspace();
  const applicationId = parsed.data.applicationId === "infrastructure" ? null : parsed.data.applicationId;

  if (applicationId) {
    const [application] = await db.select({ id: applications.id }).from(applications).where(and(
      eq(applications.id, applicationId),
      eq(applications.workspaceId, workspaceId),
      isNull(applications.archivedAt),
    )).limit(1);
    if (!application) return;
  }

  await db.insert(storageResourceMappings).values({
    workspaceId,
    resourceKey: parsed.data.resourceKey,
    applicationId,
  }).onConflictDoUpdate({
    target: [storageResourceMappings.workspaceId, storageResourceMappings.resourceKey],
    set: { applicationId, updatedAt: new Date() },
  });
  revalidatePath("/storage");
}

export async function createStorageMaintenance(formData: FormData) {
  const parsedKey = z.string().min(1).max(600).safeParse(formData.get("resourceKey"));
  const parsedApplicationId = z.union([z.string().uuid(), z.literal("")]).safeParse(formData.get("applicationId") ?? "");
  if (!parsedKey.success) return;
  const { session, workspaceId } = await requireWorkspace();
  const [snapshotRow] = await db.select({ payload: vpsStorageSnapshots.payload }).from(vpsStorageSnapshots)
    .where(eq(vpsStorageSnapshots.workspaceId, workspaceId)).orderBy(desc(vpsStorageSnapshots.observedAt)).limit(1);
  const parsedSnapshot = storageSnapshotSchema.safeParse(snapshotRow?.payload);
  if (!parsedSnapshot.success) return;
  const item = parsedSnapshot.data.categories.flatMap((category) => category.items).find((candidate) => candidate.key === parsedKey.data);
  if (!item) return;

  const [mapping] = await db.select({ applicationId: storageResourceMappings.applicationId }).from(storageResourceMappings).where(and(
    eq(storageResourceMappings.workspaceId, workspaceId),
    eq(storageResourceMappings.resourceKey, item.key),
  )).limit(1);
  const requestedApplicationId = parsedApplicationId.success && parsedApplicationId.data ? parsedApplicationId.data : null;
  let applicationId = mapping?.applicationId ?? requestedApplicationId;
  if (applicationId) {
    const [application] = await db.select({ id: applications.id }).from(applications).where(and(
      eq(applications.id, applicationId),
      eq(applications.workspaceId, workspaceId),
      isNull(applications.archivedAt),
    )).limit(1);
    if (!application) applicationId = null;
  }
  await db.transaction(async (transaction) => {
    const [task] = await transaction.insert(maintenanceTasks).values({
      workspaceId,
      applicationId,
      title: `Examiner l’espace occupé par ${item.label}`,
      description: `${item.path} occupe ${formatBytes(item.sizeBytes)} lors du dernier inventaire. Vérifier avant toute suppression manuelle.`,
      remediation: `Identifier ce qui alimente ${item.path}.\nSauvegarder les données utiles avant tout nettoyage manuel.\nNettoyer, archiver ou redimensionner la ressource depuis le VPS ou Coolify.`,
      verification: "Relancer l’inventaire disque et confirmer la baisse attendue.\nVérifier que l’application et ses données restent disponibles.",
      category: "capacity",
      severity: "medium",
      automatic: false,
    }).returning({ id: maintenanceTasks.id });
    await transaction.insert(maintenanceTaskEvents).values({
      workspaceId,
      taskId: task.id,
      actorId: session.user.id,
      action: "created_from_storage",
      nextStatus: "open",
      note: `Tâche créée depuis l’explorateur disque pour ${item.path}.`,
    });
  });
  revalidatePath("/");
  revalidatePath("/storage");
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} ${units[index]}`;
}
