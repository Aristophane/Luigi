import { z } from "zod";
import { deploymentCommitsMatch } from "@/lib/deployment-health";

const httpUrl = z.string().url().max(2_000).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "URL must use HTTP or HTTPS.");

export const deploymentReportSchema = z.object({
  applicationId: z.string().uuid().optional(),
  applicationUrl: httpUrl.optional(),
  deploymentId: z.string().trim().min(1).max(200),
  commitSha: z.string().trim().regex(/^[a-f0-9]{7,64}$/i).transform((value) => value.toLowerCase()).nullable(),
  source: z.string().trim().min(1).max(60).regex(/^[a-z0-9._-]+$/i).default("ci").transform((value) => value.toLowerCase()),
  sourceUrl: httpUrl.optional(),
  deployedAt: z.iso.datetime({ offset: true }),
  branch: z.string().trim().min(1).max(200).optional(),
  environment: z.enum(["production", "staging", "development"]).optional(),
  verification: z.object({
    provider: z.enum(["coolify", "netlify", "railway"]),
    observedAt: z.iso.datetime({ offset: true }),
  }).optional(),
}).refine((value) => Boolean(value.applicationId || value.applicationUrl), {
  message: "applicationId or applicationUrl is required.",
});

export type DeploymentReport = z.infer<typeof deploymentReportSchema>;

export function normalizeApplicationUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  return url.toString();
}

export function deploymentReportDateError(report: DeploymentReport, now = new Date()): string | undefined {
  const deployedAt = new Date(report.deployedAt);
  if (deployedAt.getTime() > now.getTime() + 5 * 60 * 1000 || deployedAt.getUTCFullYear() < 2000) {
    return "Invalid deployment date.";
  }
  if (report.verification) {
    const observedAt = new Date(report.verification.observedAt);
    if (observedAt.getTime() > now.getTime() + 5 * 60 * 1000 || observedAt < deployedAt) {
      return "Invalid deployment verification date.";
    }
  }
}

export function deploymentReportTargetError(report: DeploymentReport, application: { githubBranch: string; environment: string }) {
  if (report.branch && report.branch !== application.githubBranch) return "Deployment branch does not match the application.";
  if (report.environment && report.environment !== application.environment) return "Deployment environment does not match the application.";
}

export function deploymentReportConflicts(report: DeploymentReport, existing: { commitSha: string | null; branch: string | null; environment: string | null }) {
  return Boolean(report.commitSha && existing.commitSha && !deploymentCommitsMatch(report.commitSha, existing.commitSha))
    || Boolean(report.branch && existing.branch && report.branch !== existing.branch)
    || Boolean(report.environment && existing.environment && report.environment !== existing.environment);
}
