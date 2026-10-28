import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { applications } from "@/db/schema";
import { ingestDeploymentReport } from "@/lib/deployment-ingestion";
import { deploymentSyncTargets, readProviderDeployment, targetMatchesApplication } from "@/lib/deployment-providers";
import { assertLease, completeJob, type Lease } from "@/lib/job-queue";

export async function synchronizeDeployments(workspaceId: string, lease?: Lease) {
  await db.transaction((tx) => assertLease(tx, lease));
  const targets = deploymentSyncTargets();
  const monitored = await db.select().from(applications).where(and(eq(applications.workspaceId, workspaceId), isNull(applications.archivedAt)));
  const failures: string[] = [];
  for (const application of monitored) {
    const matches = targets.filter((target) => targetMatchesApplication(target, application));
    if (!matches.length) continue;
    if (matches.length !== 1) { failures.push(`${application.name}: ambiguous deployment target`); continue; }
    try {
      const report = await readProviderDeployment(matches[0], application);
      // Lease fencing is repeated in the ingestion transaction after the network calls.
      await ingestDeploymentReport({ ...report, applicationId: application.id, applicationUrl: application.publicUrl,
        environment: application.environment }, lease);
    } catch (error) {
      if (error instanceof Error && error.message === "JOB_LEASE_LOST") throw error;
      failures.push(`${application.name}: ${error instanceof Error ? error.message : "provider unavailable"}`);
    }
  }
  if (failures.length) throw new Error(failures.join("; ").slice(0, 280));
  await db.transaction(async (tx) => { await assertLease(tx, lease); await completeJob(tx, lease); });
}
