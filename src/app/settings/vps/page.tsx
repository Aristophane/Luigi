import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { integrations, vpsMetricSamples } from "@/db/schema";
import { VpsAgentSetup } from "@/components/vps-agent-setup";
import { requireWorkspace } from "@/lib/dal";

export const dynamic = "force-dynamic";

export default async function VpsSettingsPage() {
  const { workspaceId } = await requireWorkspace();
  const [agent] = await db
    .select({ label: integrations.label, configuration: integrations.configuration, lastSyncedAt: integrations.lastSyncedAt })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.kind, "vps_agent")))
    .limit(1);
  const [latestSample] = await db
    .select({ observedAt: vpsMetricSamples.observedAt })
    .from(vpsMetricSamples)
    .where(eq(vpsMetricSamples.workspaceId, workspaceId))
    .orderBy(desc(vpsMetricSamples.observedAt))
    .limit(1);
  const endpoint = typeof agent?.configuration.endpoint === "string"
    ? agent.configuration.endpoint
    : new URL("/api/agent/v1/report", process.env.BETTER_AUTH_URL ?? "http://localhost:3011").toString();

  return (
    <main className="settings-shell">
      <div className="settings-container settings-container--wide">
        <Link className="text-link settings-back" href="/"><ArrowLeft aria-hidden="true" /> Retour au cockpit</Link>
        <header className="settings-heading settings-heading--split">
          <div>
            <p className="eyebrow">Ubuntu 24.04</p>
            <h1>Relier le VPS.</h1>
            <p>L’agent observe localement le système et initie uniquement des connexions HTTPS sortantes vers Luigi.</p>
          </div>
          <span className="settings-guard"><ShieldCheck aria-hidden="true" /> Aucune commande distante</span>
        </header>
        <VpsAgentSetup
          configured={Boolean(agent)}
          label={agent?.label}
          lastSyncedLabel={(latestSample?.observedAt ?? agent?.lastSyncedAt)?.toLocaleString("fr-FR")}
          endpoint={endpoint}
        />
        <aside className="security-note">
          <ShieldCheck aria-hidden="true" />
          <div><strong>Privilèges contenus</strong><p>Le service utilise un compte système dédié, un système de fichiers protégé et un jeton conservé dans un fichier lisible uniquement par root et le groupe de l’agent.</p></div>
        </aside>
      </div>
    </main>
  );
}
