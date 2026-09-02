import "server-only";

import { count, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { account, workspaceMembers, workspaces } from "@/db/schema";
import { auth } from "@/lib/auth";

export async function hasConfiguredAdmin() {
  const [{ total }] = await db.select({ total: count() }).from(account);
  return total > 0;
}

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

export async function requireSession() {
  const configured = await hasConfiguredAdmin();
  if (!configured) redirect("/setup");

  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

export async function requireWorkspace() {
  const session = await requireSession();
  let [membership] = await db
    .select()
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, session.user.id))
    .limit(1);

  if (!membership) {
    membership = await db.transaction(async (transaction) => {
      const [workspace] = await transaction
        .insert(workspaces)
        .values({ name: "Infrastructure" })
        .returning({ id: workspaces.id });
      const [createdMembership] = await transaction
        .insert(workspaceMembers)
        .values({ workspaceId: workspace.id, userId: session.user.id, role: "owner" })
        .returning();
      return createdMembership;
    });
  }

  return { session, workspaceId: membership.workspaceId };
}
