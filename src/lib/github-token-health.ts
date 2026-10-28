import { GitHubApiError } from "@/lib/github";
import { deploymentCommitsMatch, deploymentConfirmationState } from "@/lib/deployment-health";

export type GitHubTokenHealth = {
  status: "valid" | "invalid" | "forbidden" | "unavailable" | "configuration_error" | "unknown";
  checkedAt?: string;
  lastSuccessfulAt?: string;
};

export const githubTokenCheckIntervalMs = 60 * 60 * 1000;

export function readGitHubTokenHealth(configuration: Record<string, unknown>, now = new Date()): GitHubTokenHealth {
  const value = configuration.githubTokenHealth as Partial<GitHubTokenHealth> | undefined;
  const statuses = ["valid", "invalid", "forbidden", "unavailable", "configuration_error", "unknown"];
  if (!value || !statuses.includes(value.status ?? "")) return { status: "unknown" };
  const checkedAt = typeof value.checkedAt === "string" && Number.isFinite(Date.parse(value.checkedAt)) ? value.checkedAt : undefined;
  const lastSuccessfulAt = typeof value.lastSuccessfulAt === "string" && Number.isFinite(Date.parse(value.lastSuccessfulAt))
    ? value.lastSuccessfulAt : undefined;
  const stale = !checkedAt || now.getTime() - Date.parse(checkedAt) > githubTokenCheckIntervalMs * 2;
  return { status: value.status === "valid" && stale ? "unknown" : value.status!, checkedAt, lastSuccessfulAt };
}

export function gitHubTokenFailure(error: unknown): GitHubTokenHealth["status"] | undefined {
  if (error instanceof GitHubApiError) {
    if (error.status === 401) return "invalid";
    if (error.status === 429 || (error.status === 403 && /rate limit/i.test(error.message))) return "unavailable";
    if (error.status === 403) return "forbidden";
    if (error.status >= 500) return "unavailable";
  }
  if (error instanceof TypeError || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name))) return "unavailable";
  return undefined;
}

export function githubTokenHealthCopy(health: GitHubTokenHealth) {
  switch (health.status) {
    case "valid": return { label: "Jeton valide", message: "GitHub a accepté le jeton lors du dernier contrôle." };
    case "invalid": return { label: "Jeton invalide", message: "GitHub refuse le jeton : il peut être expiré ou révoqué. Remplace-le pour reprendre les analyses des dépôts." };
    case "forbidden": return { label: "Accès refusé", message: "GitHub refuse cet accès. Vérifie les permissions du jeton et les dépôts autorisés." };
    case "configuration_error": return { label: "Configuration à vérifier", message: "Luigi ne peut pas lire le jeton enregistré. Vérifie la clé de chiffrement du web et du worker." };
    case "unavailable": return { label: "Vérification indisponible", message: "GitHub est temporairement inaccessible ou limite les requêtes. La validité du jeton n’est pas confirmée." };
    default: return { label: "Jeton à vérifier", message: "La validité du jeton n’a pas été confirmée récemment. Une vérification automatique est prévue toutes les heures." };
  }
}

export function repositoryDeploymentMatch(repositoryCommit: string | null, scannedAt: Date | null, deployedCommit: string | null,
  deployedAt: Date, health?: GitHubTokenHealth, now = new Date(), verifiedAt?: Date | null): boolean | null {
  if (!repositoryCommit || !deployedCommit || !scannedAt || (health && health.status !== "valid")) return null;
  if (deploymentConfirmationState(verifiedAt, now) !== "confirmed") return null;
  if (scannedAt < deployedAt || now.getTime() - scannedAt.getTime() > 25 * 60 * 60 * 1000) return null;
  return deploymentCommitsMatch(repositoryCommit, deployedCommit);
}
