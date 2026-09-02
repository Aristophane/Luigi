import Link from "next/link";
import { ArrowLeft, LockKeyhole } from "lucide-react";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";
import { GitHubIntegrationForm } from "@/components/github-integration-form";
import { requireWorkspace } from "@/lib/dal";

export default async function IntegrationsPage() {
  const { workspaceId } = await requireWorkspace();
  const [githubIntegration] = await db
    .select({ label: integrations.label, lastSyncedAt: integrations.lastSyncedAt })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.kind, "github")))
    .limit(1);

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
        <aside className="security-note">
          <LockKeyhole aria-hidden="true" />
          <div><strong>Secret chiffré au repos</strong><p>Le jeton est protégé par AES-256-GCM avec une clé conservée exclusivement côté serveur.</p></div>
        </aside>
      </div>
    </main>
  );
}
