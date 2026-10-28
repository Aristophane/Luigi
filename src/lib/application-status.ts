import type { HealthStatus } from "@/lib/domain";

export const availabilityLabels: Record<HealthStatus, string> = {
  healthy: "HTTP : répond",
  warning: "HTTP : dégradé",
  critical: "HTTP : incident",
  unknown: "HTTP : inconnu",
};

export type DependencyCategory = "runtime" | "development" | "tooling";

const toolingPackages = new Set([
  "@vendure/cli", "@vendure/migrate", "@prisma/migrate", "prisma", "drizzle-kit",
  "db-migrate", "node-pg-migrate", "migrate-mongo", "sequelize-cli", "typeorm-cli",
  "webpack", "webpack-cli", "vite", "rollup", "tsup", "typescript",
  "alembic", "pip", "setuptools", "wheel", "poetry", "uv",
]);

export function dependencyCategory(dependency: { name: string; development: boolean; manifestPath?: string }): DependencyCategory {
  const directories = dependency.manifestPath?.replaceAll("\\", "/").split("/").slice(0, -1) ?? [];
  if (toolingPackages.has(dependency.name.toLowerCase())
    || directories.some((directory) => /^(?:migrations?|tools?|scripts?)$/i.test(directory))) return "tooling";
  return dependency.development || dependency.name.startsWith("@types/")
    || directories.some((directory) => /^(?:dev|development|tests?|e2e|fixtures?)$/i.test(directory)) ? "development" : "runtime";
}

export type RepositoryScanState = {
  status: "never" | "fresh" | "stale" | "queued" | "running" | "retrying" | "failed";
  evidenceFresh: boolean;
  attemptedAt?: string;
  error?: string;
};

function scanFailureLabel(error: string | null) {
  if (!error) return undefined;
  if (/bad credentials|\b401\b/i.test(error)) return "Accès GitHub refusé. Vérifie le jeton dans les intégrations.";
  if (/\b403\b|forbidden/i.test(error)) return "Permissions GitHub insuffisantes ou limite de requêtes atteinte.";
  if (/lease expired|timeout|abort/i.test(error)) return "L’analyse a dépassé son délai ou a été interrompue.";
  return "L’analyse n’a pas abouti. Relance-la et consulte le suivi des intégrations.";
}

export function repositoryScanState(
  lastSucceededAt: Date | null,
  latestJob: { status: string; attempts: number; createdAt: Date; completedAt?: Date | null; lastError: string | null } | undefined,
  intervalHours: number,
  now = new Date(),
): RepositoryScanState {
  const age = lastSucceededAt ? now.getTime() - lastSucceededAt.getTime() : Infinity;
  const evidenceFresh = age >= -60_000 && age <= (intervalHours + 1) * 3600_000;
  const attemptedAt = latestJob?.createdAt.toISOString();
  const failedAfterSuccess = latestJob?.status === "failed"
    && (!lastSucceededAt || (latestJob.completedAt ?? latestJob.createdAt).getTime() > lastSucceededAt.getTime());
  if (failedAfterSuccess) return { status: "failed", evidenceFresh: false, attemptedAt, error: scanFailureLabel(latestJob.lastError) };
  if (latestJob?.status === "running") return { status: "running", evidenceFresh, attemptedAt };
  if (latestJob?.status === "queued") return {
    status: latestJob.attempts > 0 ? "retrying" : "queued", evidenceFresh, attemptedAt,
    error: scanFailureLabel(latestJob.lastError),
  };
  return { status: lastSucceededAt ? evidenceFresh ? "fresh" : "stale" : "never", evidenceFresh, attemptedAt };
}

export const repositoryScanLabels: Record<RepositoryScanState["status"], string> = {
  never: "Analyse jamais réalisée", fresh: "Analyse récente", stale: "Analyse périmée",
  queued: "Analyse en file", running: "Analyse en cours", retrying: "Analyse en nouvelle tentative", failed: "Analyse en échec",
};

export type HttpCheckConfiguration = {
  target: string;
  timeoutSeconds: number;
  failureThreshold: number;
  latencyWarningMs: number;
  renderingUrl: string | null;
  expectedText: string | null;
  assetProbe: boolean;
  assetUrl: string | null;
  updatedAt: Date;
};

export function sameHttpCheckConfiguration(left: HttpCheckConfiguration, right: HttpCheckConfiguration) {
  return left.updatedAt.getTime() === right.updatedAt.getTime()
    && left.target === right.target && left.timeoutSeconds === right.timeoutSeconds
    && left.failureThreshold === right.failureThreshold && left.latencyWarningMs === right.latencyWarningMs
    && left.renderingUrl === right.renderingUrl && left.expectedText === right.expectedText
    && left.assetProbe === right.assetProbe && left.assetUrl === right.assetUrl;
}
