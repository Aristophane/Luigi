import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";
import { decryptSecret } from "@/lib/secret-box";
import { verifyGitHubToken } from "@/lib/github";
import { gitHubTokenFailure, type GitHubTokenHealth } from "@/lib/github-token-health";
import { assertLease, completeJob, type Lease } from "@/lib/job-queue";
import { createOrRefreshNotification, resolveNotification } from "@/lib/notifications";

class GitHubTokenDecryptionError extends Error {
  constructor() { super("GITHUB_TOKEN_DECRYPTION_FAILED"); }
}

async function getGitHubIntegration(workspaceId: string) {
  const [integration] = await db
    .select()
    .from(integrations)
    .where(and(
      eq(integrations.workspaceId, workspaceId),
      eq(integrations.kind, "github"),
      eq(integrations.enabled, true),
    ))
    .limit(1);

  return integration;
}

async function recordHealth(integration: typeof integrations.$inferSelect, status: GitHubTokenHealth["status"], checkedAt: Date) {
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(integrations).where(and(eq(integrations.id, integration.id),
      eq(integrations.enabled, true), eq(integrations.encryptedCredentials, integration.encryptedCredentials!))).for("update");
    // A result for an old token must never override a replacement or a newer check.
    if (!current) return;
    const previous = current.configuration.githubTokenHealth as GitHubTokenHealth | undefined;
    if (previous?.checkedAt && Date.parse(previous.checkedAt) > checkedAt.getTime()) return;
    const health: GitHubTokenHealth = { status, checkedAt: checkedAt.toISOString(),
      lastSuccessfulAt: status === "valid" ? checkedAt.toISOString() : previous?.lastSuccessfulAt };
    await tx.update(integrations).set({ configuration: sql`jsonb_set(${integrations.configuration}, '{githubTokenHealth}', ${JSON.stringify(health)}::jsonb)`,
      ...(status === "valid" ? { lastSyncedAt: checkedAt } : {}) }).where(eq(integrations.id, current.id));
    const fingerprint = `github-token:${integration.id}`;
    if (["invalid", "forbidden", "configuration_error"].includes(status) && previous?.status !== status) {
      await createOrRefreshNotification({ workspaceId: integration.workspaceId, title: status === "invalid" ? "Le jeton GitHub est invalide" : "L’accès GitHub doit être vérifié",
        body: status === "invalid" ? "GitHub refuse le jeton enregistré. Les commits et dépendances ne sont plus actualisés. Remplace le jeton dans les intégrations."
          : "Luigi ne peut plus confirmer l’accès GitHub. Vérifie les intégrations pour reprendre les analyses.",
        severity: "high", targetUrl: "/settings/integrations#github-integration", fingerprint, push: false }, tx);
    } else if (status === "valid") {
      await resolveNotification(integration.workspaceId, fingerprint, undefined, tx);
    }
  });
}

export async function withGitHubToken<T>(workspaceId: string, operation: (token?: string) => Promise<T>) {
  const integration = await getGitHubIntegration(workspaceId);
  if (!integration?.encryptedCredentials) return operation();
  const checkedAt = new Date();
  let token: string;
  try { token = decryptSecret(integration.encryptedCredentials); }
  catch { await recordHealth(integration, "configuration_error", checkedAt); throw new GitHubTokenDecryptionError(); }
  try {
    const result = await operation(token);
    await recordHealth(integration, "valid", checkedAt);
    return result;
  } catch (error) {
    const status = gitHubTokenFailure(error);
    if (status) await recordHealth(integration, status, checkedAt);
    throw error;
  }
}

export async function checkStoredGitHubToken(workspaceId: string, lease?: Lease) {
  // Check before calling GitHub; the health write is independent of repository scans.
  await db.transaction((tx) => assertLease(tx, lease));
  try {
    await withGitHubToken(workspaceId, async (token) => { if (token) await verifyGitHubToken(token); });
  } catch (error) {
    if (!gitHubTokenFailure(error) && !(error instanceof GitHubTokenDecryptionError)) throw error;
  }
  await db.transaction((tx) => completeJob(tx, lease));
}
