import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { integrations } from "@/db/schema";
import { VpsAgentSetup } from "@/components/vps-agent-setup";
import { requireWorkspace } from "@/lib/dal";

export const dynamic = "force-dynamic";

export default async function VpsSettingsPage() {
  const { workspaceId } = await requireWorkspace();
  const [agent] = await db
    .select({
      label: integrations.label,
      configuration: integrations.configuration,
      lastSyncedAt: integrations.lastSyncedAt,
      fresh: sql<boolean>`${integrations.lastSyncedAt} >= now() - interval '15 minutes'`,
    })
    .from(integrations)
    .where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.kind, "vps_agent")))
    .limit(1);
  const endpoint = typeof agent?.configuration.endpoint === "string"
    ? agent.configuration.endpoint
    : new URL("/api/agent/v1/report", process.env.BETTER_AUTH_URL ?? "http://localhost:3011").toString();
  const enrolledAt = typeof agent?.configuration.enrolledAt === "string" ? agent.configuration.enrolledAt : undefined;
  const system = agent?.configuration.system;
  const systemLabel = system && typeof system === "object" && "distributionLabel" in system && typeof system.distributionLabel === "string"
    ? system.distributionLabel
    : undefined;
  const reportIntervalSeconds = typeof agent?.configuration.reportIntervalSeconds === "number"
    ? agent.configuration.reportIntervalSeconds
    : 300;
  const reportIntervalLabel = reportIntervalSeconds < 3600
    ? `${Math.round(reportIntervalSeconds / 60)} minutes`
    : `${Math.round(reportIntervalSeconds / 3600)} heures`;
  const connected = Boolean(agent?.fresh);

  return (
    <main className="settings-shell">
      <div className="settings-container settings-container--wide">
        <Link className="text-link settings-back" href="/"><ArrowLeft aria-hidden="true" /> Retour au cockpit</Link>
        <header className="settings-heading settings-heading--split">
          <div>
            <p className="eyebrow">Ubuntu · Debian</p>
            <h1>Relier le VPS.</h1>
            <p>L’agent observe localement le système et initie uniquement des connexions HTTPS sortantes vers Luigi.</p>
          </div>
          <span className="settings-guard"><ShieldCheck aria-hidden="true" /> Aucune commande distante</span>
        </header>
        <VpsAgentSetup
          configured={Boolean(agent)}
          connected={connected}
          label={agent?.label}
          lastSyncedAt={agent?.lastSyncedAt?.toISOString()}
          lastSyncedLabel={agent?.lastSyncedAt?.toLocaleString("fr-FR")}
          enrolledAt={enrolledAt}
          systemLabel={systemLabel}
          reportIntervalLabel={reportIntervalLabel}
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
