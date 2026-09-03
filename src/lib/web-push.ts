import "server-only";

import { and, eq } from "drizzle-orm";
import webPush from "web-push";
import { db } from "@/db";
import { pushSubscriptions, workspaceMembers } from "@/db/schema";

export type PushPayload = {
  title: string;
  body: string;
  url: string;
  tag: string;
  renotify?: boolean;
};

export function getWebPushConfiguration() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim() ?? "";
  const subject = process.env.VAPID_SUBJECT?.trim() ?? "";
  return {
    configured: Boolean(publicKey && privateKey && subject),
    publicKey,
    privateKey,
    subject,
  };
}

async function sendStoredSubscription(
  subscription: typeof pushSubscriptions.$inferSelect,
  payload: PushPayload,
) {
  const configuration = getWebPushConfiguration();
  if (!configuration.configured) return { delivered: false, reason: "not_configured" as const };

  try {
    webPush.setVapidDetails(configuration.subject, configuration.publicKey, configuration.privateKey);
    await webPush.sendNotification({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    }, JSON.stringify({ ...payload, icon: "/icon.svg" }), {
      TTL: 60 * 60,
      urgency: "high",
    });
    return { delivered: true };
  } catch (error) {
    if (error instanceof webPush.WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
      return { delivered: false, reason: "expired" as const };
    }
    console.error("Web Push delivery failed", {
      statusCode: error instanceof webPush.WebPushError ? error.statusCode : undefined,
    });
    return { delivered: false, reason: "delivery_failed" as const };
  }
}

export async function sendWebPushToWorkspace(workspaceId: string, payload: PushPayload) {
  const subscriptions = await db
    .select({
      id: pushSubscriptions.id,
      userId: pushSubscriptions.userId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
      userAgent: pushSubscriptions.userAgent,
      createdAt: pushSubscriptions.createdAt,
      updatedAt: pushSubscriptions.updatedAt,
    })
    .from(pushSubscriptions)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, pushSubscriptions.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId));

  const results = await Promise.all(subscriptions.map((subscription) => sendStoredSubscription(subscription, payload)));
  return { delivered: results.filter((result) => result.delivered).length, subscriptions: results.length };
}

export async function sendTestWebPush(userId: string, endpoint: string) {
  const [subscription] = await db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
    .limit(1);
  if (!subscription) return { delivered: false, reason: "not_found" as const };

  return sendStoredSubscription(subscription, {
    title: "Luigi veille",
    body: "Les notifications sont reliées à ce navigateur.",
    url: "/#overview",
    tag: "luigi-push-test",
  });
}
