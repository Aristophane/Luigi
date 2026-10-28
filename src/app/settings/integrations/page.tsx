import Link from "next/link";
import { ArrowLeft, Check, GitCommitHorizontal, LockKeyhole } from "lucide-react";
import { eq, and, desc } from "drizzle-orm";
import { db } from "@/db";
import { integrations, jobs } from "@/db/schema";
import { LocalDateTime } from "@/components/local-date-time";
import { DiscordIntegration } from "@/components/discord-integration";
import { DeliveryLog } from "@/components/delivery-log";
import { GitHubIntegrationForm } from "@/components/github-integration-form";
import { requireWorkspace } from "@/lib/dal";
import { isDiscordConfigured } from "@/lib/discord";
import { readGitHubTokenHealth } from "@/lib/github-token-health";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const { workspaceId } = await requireWorkspace();
  const [githubIntegration] = await db
    .select({ label: integrations.label, configuration: integrations.configuration })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.kind, "github"), eq(integrations.enabled, true)))
    .limit(1);
  const deploymentIngestionConfigured = Boolean(process.env.DEPLOYMENT_INGEST_SECRET);
  const [lastDeploymentSync] = await db.select({ status: jobs.status, updatedAt: jobs.updatedAt, lastError: jobs.lastError })
    .from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.key, `deployment-sync:${workspaceId}`)))
    .orderBy(desc(jobs.createdAt)).limit(1);
  const syncLabels: Record<string, string> = { queued: "En attente", running: "En cours", succeeded: "Vérification terminée", failed: "Vérification en échec" };

  return (
    <main className="settings-shell">
      <div className="settings-container">
        <Link className="text-link settings-back" href="/"><ArrowLeft aria-hidden="true" /> Retour au cockpit</Link>
        <header className="settings-heading">
          <p className="eyebrow">Sources de données</p>
          <h1>Intégrations</h1>
          <p>Connecte uniquement les services que Luigi doit lire. Aucun jeton n’est renvoyé au navigateur après enregistrement.</p>
        </header>
        <GitHubIntegrationForm connectedLabel={githubIntegration?.label}
          health={githubIntegration ? readGitHubTokenHealth(githubIntegration.configuration) : undefined} />
        <section className="integration-form" aria-labelledby="deployment-integration-title">
          <div className="integration-form__status">
            <span className="integration-icon"><GitCommitHorizontal aria-hidden="true" /></span>
            <div>
              <h2 id="deployment-integration-title">Déploiements</h2>
              <p>Chaque version indique sa source et la dernière confirmation de l’hébergeur.</p>
            </div>
            {deploymentIngestionConfigured && <span className="connection-state"><Check aria-hidden="true" /> Réception API activée</span>}
          </div>
          <div className="integration-form__body deployment-integration__body">
            <p>{lastDeploymentSync
              ? <>Synchronisation automatique : {syncLabels[lastDeploymentSync.status] ?? lastDeploymentSync.status} · <LocalDateTime value={lastDeploymentSync.updatedAt.toISOString()} />.</>
              : "Aucune vérification automatique d’hébergeur enregistrée."}</p>
            {lastDeploymentSync?.lastError && lastDeploymentSync.status !== "succeeded"
              && <p className="collection-warning">{lastDeploymentSync.lastError}</p>}
            <p>{deploymentIngestionConfigured
              ? "Les signaux CI sont acceptés après une livraison réussie. La réception activée ne garantit pas qu’un émetteur soit relié."
              : "Ajoute DEPLOYMENT_INGEST_SECRET au serveur Luigi avant de relier ton pipeline."}</p>
            <code>POST /api/deployments</code>
            <small>Champs requis : applicationUrl, deploymentId, commitSha et deployedAt.</small>
          </div>
        </section>
        <DiscordIntegration configured={isDiscordConfigured()} />
        <DeliveryLog workspaceId={workspaceId} />
        <aside className="security-note">
          <LockKeyhole aria-hidden="true" />
          <div><strong>Secret chiffré au repos</strong><p>Le jeton est protégé par AES-256-GCM avec une clé conservée exclusivement côté serveur.</p></div>
        </aside>
      </div>
    </main>
  );
}
