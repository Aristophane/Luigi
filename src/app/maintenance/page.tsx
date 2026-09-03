import Link from "next/link";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { applications, maintenanceTaskEvents, maintenanceTasks } from "@/db/schema";
import { requireWorkspace } from "@/lib/dal";
import type { MaintenanceTask } from "@/lib/domain";
import { MaintenanceCenter } from "@/components/maintenance-center";

export const dynamic = "force-dynamic";

export default async function MaintenancePage({ searchParams }: { searchParams: Promise<{ category?: string }> }) {
  const { workspaceId } = await requireWorkspace();
  const params = await searchParams;
  const [taskRows, applicationRows] = await Promise.all([
    db.select().from(maintenanceTasks).where(eq(maintenanceTasks.workspaceId, workspaceId))
      .orderBy(asc(maintenanceTasks.dueAt), desc(maintenanceTasks.createdAt)).limit(250),
    db.select({ id: applications.id, name: applications.name, archivedAt: applications.archivedAt }).from(applications)
      .where(eq(applications.workspaceId, workspaceId)).orderBy(asc(applications.name)),
  ]);
  const taskIds = taskRows.map((task) => task.id);
  const eventRows = taskIds.length ? await db.select({
    id: maintenanceTaskEvents.id,
    taskId: maintenanceTaskEvents.taskId,
    action: maintenanceTaskEvents.action,
    note: maintenanceTaskEvents.note,
    createdAt: maintenanceTaskEvents.createdAt,
  }).from(maintenanceTaskEvents).where(and(
    eq(maintenanceTaskEvents.workspaceId, workspaceId),
    inArray(maintenanceTaskEvents.taskId, taskIds),
  )).orderBy(desc(maintenanceTaskEvents.createdAt)).limit(1000) : [];
  const names = new Map(applicationRows.map((application) => [application.id, application.name]));
  const tasks: MaintenanceTask[] = taskRows.map((task) => ({
    id: task.id,
    applicationId: task.applicationId,
    title: task.title,
    description: task.description ?? undefined,
    remediation: task.remediation ?? undefined,
    verification: task.verification ?? undefined,
    category: task.category,
    severity: task.severity,
    dueLabel: task.dueAt ? `Échéance ${task.dueAt.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}` : "À planifier",
    source: task.automatic ? "Analyse automatique" : "Tâche manuelle",
    applicationName: task.applicationId ? names.get(task.applicationId) ?? "Application archivée" : "VPS · Infrastructure",
    status: task.status,
    completedLabel: task.completedAt?.toLocaleString("fr-FR"),
    createdLabel: task.createdAt.toLocaleString("fr-FR"),
  }));
  const events = eventRows.map((event) => ({ ...event, createdLabel: event.createdAt.toLocaleString("fr-FR") }));
  const initialCategory = ["security", "dependency", "capacity", "backup", "lifecycle"].includes(params.category ?? "") ? params.category! : "all";

  return <main className="maintenance-shell">
    <div className="maintenance-container">
      <Link className="text-link maintenance-back" href="/"><ArrowLeft aria-hidden="true" /> Retour au cockpit</Link>
      <MaintenanceCenter
        tasks={tasks}
        events={events}
        applications={applicationRows.filter((application) => !application.archivedAt).map(({ id, name }) => ({ id, name }))}
        initialCategory={initialCategory}
      />
    </div>
  </main>;
}
