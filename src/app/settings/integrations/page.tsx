import Link from "next/link";
import { ArrowLeft, Check, GitCommitHorizontal, LockKeyhole } from "lucide-react";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";
import { GitHubIntegrationForm } from "@/components/github-integration-form";
import { requireWorkspace } from "@/lib/dal";

export const dynamic = "force-dynamic";

export default async function IntegrationsPage() {
  const { workspaceId } = await requireWorkspace();
  const [githubIntegration] = await db
    .select({ label: integrations.label, lastSyncedAt: integrations.lastSyncedAt })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.kind, "github")))
    .limit(1);
  const deploymentIngestionConfigured = Boolean(process.env.DEPLOYMENT_INGEST_SECRET);

  return (
    <main className="settings-shell">
      <div className="settings-container">
        <Link className="text-link settings-back" href="/"><ArrowLeft aria-hidden="true" /> Retour au cockpit</Link>
        <header className="settings-heading">
          <p className="eyebrow">Sources de données</p>
          <h1>Intégrations</h1>
          <p>Connecte uniquement les services que Luigi doit lire. Aucun jeton n’est renvoyé au navigateur après enregistrement.</p>
        </header>
        <GitHubIntegrationForm connectedLabel={githubIntegration?.label} />
        <section className="integration-form" aria-labelledby="deployment-integration-title">
          <div className="integration-form__status">
            <span className="integration-icon"><GitCommitHorizontal aria-hidden="true" /></span>
            <div>
              <h2 id="deployment-integration-title">Déploiements</h2>
              <p>La CI ou Coolify confirme le commit réellement livré.</p>
            </div>
            {deploymentIngestionConfigured && <span className="connection-state"><Check aria-hidden="true" /> Prêt</span>}
          </div>
          <div className="integration-form__body deployment-integration__body">
            <p>{deploymentIngestionConfigured
              ? "Envoie le signal après la réussite du déploiement. Luigi identifiera l’application par son URL publique."
              : "Ajoute DEPLOYMENT_INGEST_SECRET au serveur Luigi avant de relier ton pipeline."}</p>
            <code>POST /api/deployments</code>
            <small>Champs requis : applicationUrl, deploymentId, commitSha et deployedAt.</small>
          </div>
        </section>
        <aside className="security-note">
          <LockKeyhole aria-hidden="true" />
          <div><strong>Secret chiffré au repos</strong><p>Le jeton est protégé par AES-256-GCM avec une clé conservée exclusivement côté serveur.</p></div>
        </aside>
      </div>
    </main>
  );
}
