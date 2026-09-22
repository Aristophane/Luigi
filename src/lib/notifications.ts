import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Database } from "@/db";
import { notifications, notificationDeliveries, pushSubscriptions, workspaceMembers } from "@/db/schema";
import { enqueueJob } from "@/lib/job-queue";

type NotificationSeverity = "critical" | "high" | "medium" | "low";

type NotificationInput = {
  workspaceId: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  targetUrl: string;
  fingerprint?: string;
  push?: boolean;
};

export async function createOrRefreshNotification(input: NotificationInput, database: Database = db) {
  return database.transaction(async (db) => {
  const occurredAt = new Date();
  const values = {
    workspaceId: input.workspaceId,
    title: input.title,
    body: input.body,
    severity: input.severity,
    targetUrl: input.targetUrl,
    fingerprint: input.fingerprint,
    lastOccurredAt: occurredAt,
  };
  const [notification] = input.fingerprint
    ? await db
      .insert(notifications)
      .values(values)
      .onConflictDoUpdate({
        target: [notifications.workspaceId, notifications.fingerprint],
        targetWhere: sql`${notifications.resolvedAt} is null`,
        set: {
          title: input.title,
          body: input.body,
          severity: input.severity,
          targetUrl: input.targetUrl,
          status: "unread",
          occurrenceCount: sql`${notifications.occurrenceCount} + 1`,
          lastOccurredAt: occurredAt,
          updatedAt: occurredAt,
        },
      })
      .returning({ id: notifications.id, occurrenceCount: notifications.occurrenceCount })
    : await db
      .insert(notifications)
      .values(values)
      .returning({ id: notifications.id, occurrenceCount: notifications.occurrenceCount });

  const shouldPush = input.push ?? (input.severity === "critical" || input.severity === "high");
  const created = notification.occurrenceCount === 1;
  if (shouldPush) {
    const subscriptions = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
      .innerJoin(workspaceMembers, eq(workspaceMembers.userId, pushSubscriptions.userId))
      .where(eq(workspaceMembers.workspaceId, input.workspaceId));
    const recipients = [{ channel: "discord", recipient: "webhook" },
      ...(subscriptions.length ? subscriptions.map(({ id }) => ({ channel: "web_push", recipient: id }))
        : [{ channel: "web_push", recipient: "none" }])];
    for (const recipient of recipients) {
      const [delivery] = await db.insert(notificationDeliveries).values({ notificationId: notification.id, ...recipient })
        .onConflictDoNothing().returning();
      if (delivery) await enqueueJob({ workspaceId: input.workspaceId, kind: "notification",
        key: 'delivery:' + delivery.id, payload: { deliveryId: delivery.id } }, db);
    }
  }
  return { id: notification.id, created };
  });
}

export async function resolveNotification(
  workspaceId: string,
  fingerprint: string,
  // Sans message de retour à la normale, la notification est simplement close (ex. remplacée par une autre).
  recovery?: { title: string; body: string; targetUrl: string }, database: Database = db,
) {
  return database.transaction(async (db) => {
  const [active] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(
      eq(notifications.workspaceId, workspaceId),
      eq(notifications.fingerprint, fingerprint),
      isNull(notifications.resolvedAt),
    ))
    .limit(1).for("update");
  if (!active) return { resolved: false };

  const resolvedAt = new Date();
  await db
    .update(notifications)
    .set({ resolvedAt, updatedAt: resolvedAt })
    .where(eq(notifications.id, active.id));
  if (!recovery) return { resolved: true };
  await createOrRefreshNotification({
    workspaceId,
    ...recovery,
    severity: "low",
    fingerprint: `${fingerprint}:recovered:${active.id}`,
    push: true,
  }, db);
  return { resolved: true };
  });
}
