import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { sendWebPushToWorkspace } from "@/lib/web-push";

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

export async function createOrRefreshNotification(input: NotificationInput) {
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
  if (created && shouldPush) {
    await sendWebPushToWorkspace(input.workspaceId, {
      title: input.title,
      body: input.body,
      url: input.targetUrl,
      tag: input.fingerprint ?? `notification:${notification.id}`,
    });
  }

  return { id: notification.id, created };
}

export async function resolveNotification(
  workspaceId: string,
  fingerprint: string,
  recovery: { title: string; body: string; targetUrl: string },
) {
  const [active] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(and(
      eq(notifications.workspaceId, workspaceId),
      eq(notifications.fingerprint, fingerprint),
      isNull(notifications.resolvedAt),
    ))
    .limit(1);
  if (!active) return { resolved: false };

  const resolvedAt = new Date();
  await db
    .update(notifications)
    .set({ resolvedAt, updatedAt: resolvedAt })
    .where(eq(notifications.id, active.id));
  await createOrRefreshNotification({
    workspaceId,
    ...recovery,
    severity: "low",
    fingerprint: `${fingerprint}:recovered:${active.id}`,
    push: true,
  });
  return { resolved: true };
}
