import Link from "next/link";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/db";
import { applications, servers, storageResourceMappings, vpsStorageSnapshots } from "@/db/schema";
import { requireWorkspace } from "@/lib/dal";
import { storageSnapshotSchema } from "@/lib/storage-report";
import { StorageExplorer } from "@/components/storage-explorer";

export const dynamic = "force-dynamic";

function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export default async function StoragePage({ searchParams }: { searchParams: Promise<{ server?: string }> }) {
  const { workspaceId } = await requireWorkspace();
  const requested = (await searchParams).server;
  const serverRows = await db.select().from(servers).where(eq(servers.workspaceId, workspaceId));
  const selectedServer = serverRows.find((server) => server.id === requested) ?? serverRows[0];
  const [snapshotRows, applicationRows, mappingRows] = await Promise.all([
    db.select().from(vpsStorageSnapshots).where(and(eq(vpsStorageSnapshots.workspaceId, workspaceId), selectedServer ? eq(vpsStorageSnapshots.serverId, selectedServer.id) : isNull(vpsStorageSnapshots.serverId))).orderBy(desc(vpsStorageSnapshots.observedAt)).limit(2),
    db.select({ id: applications.id, name: applications.name, repository: applications.githubRepository }).from(applications)
      .where(and(eq(applications.workspaceId, workspaceId), isNull(applications.archivedAt))),
    db.select({ resourceKey: storageResourceMappings.resourceKey, applicationId: storageResourceMappings.applicationId })
      .from(storageResourceMappings).where(eq(storageResourceMappings.workspaceId, workspaceId)),
  ]);
  const latest = storageSnapshotSchema.safeParse(snapshotRows[0]?.payload);
  const previous = storageSnapshotSchema.safeParse(snapshotRows[1]?.payload);
  const manual = new Map(mappingRows.map((mapping) => [mapping.resourceKey, mapping.applicationId]));
  const previousSizes = new Map(previous.success
    ? previous.data.categories.flatMap((category) => category.items.map((item) => [item.key, item.sizeBytes] as const))
    : []);

  const items = latest.success ? latest.data.categories.flatMap((category) => category.items.map((item) => {
    const resourceKey = selectedServer ? `${selectedServer.id}:${item.key}` : item.key;
    const haystack = normalized(`${item.label} ${item.path} ${item.hint ?? ""}`);
    const automatic = item.shared ? null : applicationRows.find((application) => {
      const repositoryName = application.repository.split("/").at(-1) ?? "";
      return [application.name, repositoryName].some((candidate) => normalized(candidate).length >= 3 && haystack.includes(normalized(candidate)));
    })?.id ?? null;
    const applicationId = manual.has(resourceKey) ? manual.get(resourceKey) ?? null : automatic;
    const previousSize = previousSizes.get(item.key);
    return {
      ...item,
      key: resourceKey,
      categoryId: category.id,
      categoryLabel: category.label,
      applicationId,
      attribution: manual.has(resourceKey) ? "manual" as const : automatic ? "automatic" as const : "none" as const,
      growthBytes: previousSize === undefined ? null : item.sizeBytes - previousSize,
    };
  })) : [];

  return (
    <main className="storage-shell">
      <div className="storage-container">
        <Link className="text-link storage-back" href="/"><ArrowLeft aria-hidden="true" /> Retour au cockpit</Link>
        <nav className="server-tabs" aria-label="Serveur">{serverRows.map((server) => <Link key={server.id} href={"/storage?server=" + server.id} aria-current={server.id === selectedServer?.id ? "page" : undefined}>{server.label}</Link>)}</nav>
        <StorageExplorer
          snapshot={latest.success ? {
            hostname: latest.data.hostname,
            observedAt: latest.data.observedAt,
            scanDurationMs: latest.data.scanDurationMs,
            totalBytes: latest.data.filesystem.totalBytes,
            usedBytes: latest.data.filesystem.usedBytes,
            freeBytes: latest.data.filesystem.freeBytes,
          } : null}
          items={items}
          applications={applicationRows.map(({ id, name }) => ({ id, name }))}
        />
      </div>
    </main>
  );
}
