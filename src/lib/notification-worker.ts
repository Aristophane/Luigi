import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deliveryAttempts, notificationDeliveries, notifications, pushSubscriptions } from "@/db/schema";
import { sendDiscordAlert } from "@/lib/discord";
import { assertLease, completeJob, type Job } from "@/lib/job-queue";
import { sendStoredSubscription } from "@/lib/web-push";

export async function deliverNotification(job: Job) {
  const [entry] = await db.select({ delivery: notificationDeliveries, notification: notifications })
    .from(notificationDeliveries).innerJoin(notifications, eq(notifications.id, notificationDeliveries.notificationId))
    .where(eq(notificationDeliveries.id, job.payload.deliveryId));
  if (!entry) throw new Error("DELIVERY_NOT_FOUND");
  const { delivery, notification } = entry;
  // A start without a result records the uncertain outcome after a crash.
  const [attempt] = await db.transaction(async (tx) => {
    await assertLease(tx, job);
    await tx.update(notificationDeliveries).set({ status: "sending" }).where(eq(notificationDeliveries.id, delivery.id));
    return tx.insert(deliveryAttempts).values({ deliveryId: delivery.id, attempt: job.attempts, outcome: "started" }).returning();
  });
  let result: { delivered: boolean; reason?: string; status?: number };
  if (notification.resolvedAt) {
    result = { delivered: false, reason: "resolved" };
  } else if (delivery.channel === "discord") {
    result = await sendDiscordAlert({ ...notification, targetUrl: notification.targetUrl ?? "/" });
  } else {
    const [subscription] = delivery.recipient === "none" ? []
      : await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.id, delivery.recipient));
    result = subscription ? await sendStoredSubscription(subscription, {
      title: notification.title, body: notification.body, url: notification.targetUrl ?? "/",
      tag: `notification:${notification.id}`,
    }) : { delivered: false, reason: "no_recipient" };
  }
  const skipped = ["not_configured", "no_recipient", "expired", "resolved"].includes(result.reason ?? "");
  const permanent = result.status !== undefined && result.status >= 400 && result.status < 500
    && ![408, 429].includes(result.status);
  const terminal = result.delivered || skipped || permanent || job.attempts >= job.maxAttempts;
  await db.transaction(async (tx) => {
    await assertLease(tx, job);
    await tx.update(deliveryAttempts).set({ outcome: result.delivered ? "delivered" : skipped ? "skipped" : "failed",
      detail: `${result.reason ?? "accepted"}${result.status ? ` (${result.status})` : ""}` }).where(eq(deliveryAttempts.id, attempt.id));
    await tx.update(notificationDeliveries).set({
      status: result.delivered ? "delivered" : skipped ? "skipped" : terminal ? "failed" : "retrying",
      deliveredAt: result.delivered ? new Date() : null, updatedAt: new Date(),
    }).where(eq(notificationDeliveries.id, delivery.id));
    if (terminal) await completeJob(tx, job);
  });
  if (!terminal) throw new Error("DELIVERY_RETRY");
}
