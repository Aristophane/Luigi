import { and, eq, isNull } from "drizzle-orm";
import { db, type Database } from "@/db";
import { applications, deployments } from "@/db/schema";
import { assertLease, type Lease } from "@/lib/job-queue";
import { deploymentReportConflicts, deploymentReportDateError, deploymentReportSchema, deploymentReportTargetError,
  normalizeApplicationUrl, type DeploymentReport } from "@/lib/deployment-report";

export class DeploymentIngestionError extends Error {
  constructor(message: string, public readonly status: number, public readonly issues?: string[]) {
    super(message);
    this.name = "DeploymentIngestionError";
  }
}

export type DeploymentIngestionResult = { accepted: true; duplicate: boolean; applicationId: string };
type DeploymentApplication = Pick<typeof applications.$inferSelect, "id" | "workspaceId" | "githubBranch" | "environment">;

export async function recordDeployment(application: DeploymentApplication, report: DeploymentReport,
  lease?: Lease, database: Database = db): Promise<DeploymentIngestionResult> {
  const dateError = deploymentReportDateError(report);
  if (dateError) throw new DeploymentIngestionError(dateError, 422);
  const targetError = deploymentReportTargetError(report, application);
  if (targetError) throw new DeploymentIngestionError(targetError, 422);

  const result = await database.transaction(async (transaction) => {
    await assertLease(transaction, lease);
    const verifiedAt = report.verification ? new Date(report.verification.observedAt) : null;
    const [inserted] = await transaction.insert(deployments).values({
      workspaceId: application.workspaceId, applicationId: application.id,
      deploymentId: report.deploymentId, commitSha: report.commitSha, source: report.source,
      sourceUrl: report.sourceUrl, deployedAt: new Date(report.deployedAt),
      branch: report.branch, environment: report.environment,
      verifiedAt, verificationSource: report.verification?.provider,
    }).onConflictDoNothing({
      target: [deployments.applicationId, deployments.source, deployments.deploymentId],
    }).returning({ id: deployments.id });
    if (inserted) {
      await assertLease(transaction, lease);
      return { duplicate: false, conflict: false };
    }

    const [existing] = await transaction.select().from(deployments).where(and(
      eq(deployments.applicationId, application.id), eq(deployments.source, report.source),
      eq(deployments.deploymentId, report.deploymentId),
    )).for("update");
    if (!existing || deploymentReportConflicts(report, existing)) return { duplicate: true, conflict: true };

    // An unchanged release renews confirmation, never its release date. Older or
    // legacy retries cannot erase a more recent provider observation.
    const newerVerification = verifiedAt && (!existing.verifiedAt || verifiedAt > existing.verifiedAt);
    await transaction.update(deployments).set({
      // Missing provider metadata can be enriched later, but never erase a known commit.
      commitSha: report.commitSha && (!existing.commitSha || report.commitSha.length > existing.commitSha.length)
        ? report.commitSha : existing.commitSha,
      branch: existing.branch ?? report.branch,
      environment: existing.environment ?? report.environment,
      sourceUrl: report.sourceUrl ?? existing.sourceUrl,
      ...(newerVerification ? { verifiedAt, verificationSource: report.verification!.provider } : {}),
    }).where(eq(deployments.id, existing.id));
    await assertLease(transaction, lease);
    return { duplicate: true, conflict: false };
  });
  if (result.conflict) {
    throw new DeploymentIngestionError("Deployment identifier already belongs to another commit or target.", 409);
  }
  return { accepted: true, duplicate: result.duplicate, applicationId: application.id };
}

// Shared by authenticated HTTP reports and the worker's provider collectors.
export async function ingestDeploymentReport(input: unknown, lease?: Lease, database: Database = db): Promise<DeploymentIngestionResult> {
  const parsed = deploymentReportSchema.safeParse(input);
  if (!parsed.success) throw new DeploymentIngestionError("Invalid deployment report.", 422,
    parsed.error.issues.map((issue) => issue.path.join(".")));
  const report = parsed.data;
  const candidates = await database.select({ id: applications.id, workspaceId: applications.workspaceId,
    githubBranch: applications.githubBranch, environment: applications.environment }).from(applications).where(and(
    isNull(applications.archivedAt),
    ...(report.applicationId ? [eq(applications.id, report.applicationId)] : []),
    ...(report.applicationUrl ? [eq(applications.publicUrl, normalizeApplicationUrl(report.applicationUrl))] : []),
  )).limit(2);
  if (candidates.length > 1) throw new DeploymentIngestionError("Application URL is ambiguous. Use applicationId.", 409);
  const [application] = candidates;
  if (!application) throw new DeploymentIngestionError("Application not found.", 404);
  return recordDeployment(application, report, lease, database);
}
