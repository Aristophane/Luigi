import Link from "next/link";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, applications, checks, servers, vpsMetricSamples } from "@/db/schema";
import { VpsAgentSetup } from "@/components/vps-agent-setup";
import { requireWorkspace } from "@/lib/dal";

import { EssentialServiceForm } from "@/components/essential-service-form";
import { isFresh } from "@/lib/monitoring-state";
import { vpsReportSchema } from "@/lib/vps-report";

export const dynamic = "force-dynamic";

export default async function VpsSettingsPage() {
  const { workspaceId } = await requireWorkspace();
  const serverAgents = await db.select({ serverId: servers.id, label: servers.label,
    configuration: agents.configuration, lastSyncedAt: agents.lastSeenAt, intervalSeconds: agents.intervalSeconds })
    .from(agents).innerJoin(servers, eq(servers.id, agents.serverId))
    .where(and(eq(servers.workspaceId, workspaceId), eq(agents.enabled, true))).orderBy(desc(agents.createdAt));
  const agent = serverAgents[0];
  const samples = await db.selectDistinctOn([vpsMetricSamples.serverId]).from(vpsMetricSamples)
    .where(eq(vpsMetricSamples.workspaceId, workspaceId)).orderBy(vpsMetricSamples.serverId, desc(vpsMetricSamples.observedAt));
  const apps = await db.select({ id: applications.id, name: applications.name }).from(applications)
    .where(and(eq(applications.workspaceId, workspaceId), isNull(applications.archivedAt)));
  const serviceLinks = await db.select({ check: checks }).from(checks).innerJoin(applications, eq(applications.id, checks.applicationId))
    .where(and(eq(applications.workspaceId, workspaceId), eq(checks.kind, "heartbeat"), eq(checks.enabled, true)));
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
  const connected = Boolean(agent && isFresh(agent.lastSyncedAt, agent.intervalSeconds));

  return (
    <main className="settings-shell">
      <div className="settings-container settings-container--wide">
        <Link className="text-link settings-back" href="/"><ArrowLeft aria-hidden="true" /> Retour au cockpit</Link>
        <header className="settings-heading settings-heading--split">
          <div>
            <p className="eyebrow">Ubuntu · Debian</p>
            <h1>Serveurs et agents</h1>
            <p>L’agent observe localement le système et initie uniquement des connexions HTTPS sortantes vers Luigi.</p>
          </div>
          <span className="settings-guard"><ShieldCheck aria-hidden="true" /> Aucune commande distante</span>
        </header>
        <section className="server-registry" aria-label="Serveurs enregistrés">
          {serverAgents.map((server) => {
            const sample = samples.find((sample) => sample.serverId === server.serverId);
            const report = vpsReportSchema.safeParse(sample?.payload);
            return <details key={server.serverId} className="server-registry__item">
              <summary><strong>{server.label}</strong><span>{isFresh(sample?.observedAt ?? null, server.intervalSeconds) ? "Mesures récentes" : "État inconnu · mesures absentes ou périmées"}</span></summary>
              <p>Agent indépendant · {server.serverId.slice(0, 8)} · <Link href={'/storage?server=' + server.serverId}>Stockage de ce serveur</Link></p>
              <p>Les services essentiels participent au statut de leur application. Un service absent du rapport reste inconnu.</p>
              {report.success && report.data.runtime?.units.map((unit) => <EssentialServiceForm key={unit.key}
                serverId={server.serverId} serviceKey={unit.key} label={unit.label} applications={apps}
                applicationId={serviceLinks.find(({ check }) => check.serverId === server.serverId && check.serviceKey === unit.key)?.check.applicationId} />)}
            </details>;
          })}
        </section>
        <h2>Enrôler un nouveau serveur</h2>
        <p>Chaque enrôlement crée une identité indépendante. Les agents déjà reliés conservent leur accès.</p>
        <VpsAgentSetup
          configured={Boolean(agent)}
          connected={connected}
          label={agent?.label}
          lastSyncedAt={agent?.lastSyncedAt?.toISOString()}
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
