import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";
import { decryptSecret } from "@/lib/secret-box";

export async function getGitHubToken(workspaceId: string) {
  const [integration] = await db
    .select({ encryptedCredentials: integrations.encryptedCredentials })
    .from(integrations)
    .where(and(
      eq(integrations.workspaceId, workspaceId),
      eq(integrations.kind, "github"),
      eq(integrations.enabled, true),
    ))
    .limit(1);

  return integration?.encryptedCredentials
    ? decryptSecret(integration.encryptedCredentials)
    : undefined;
}
