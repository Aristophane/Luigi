import { Check, TriangleAlert } from "lucide-react";
import { LocalDateTime } from "@/components/local-date-time";
import { githubTokenHealthCopy, type GitHubTokenHealth } from "@/lib/github-token-health";

export function GitHubTokenStatus({ health }: { health: GitHubTokenHealth }) {
  const copy = githubTokenHealthCopy(health);
  return (
    <div className={`github-token-status github-token-status--${health.status}`} role="status">
      <strong>{health.status === "valid" ? <Check aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}{copy.label}</strong>
      <p>{copy.message}</p>
      <small>Dernière vérification · <LocalDateTime value={health.checkedAt} fallback="Jamais vérifié" /></small>
      {health.status !== "valid" && health.lastSuccessfulAt && <small>Dernier accès réussi · <LocalDateTime value={health.lastSuccessfulAt} /></small>}
    </div>
  );
}
