"use client";

import { ArrowDown, ArrowUp, Clock3, Database, HardDrive, ListPlus, Server, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { assignStorageResource, createStorageMaintenance } from "@/app/storage/actions";

type StorageRow = {
  key: string;
  label: string;
  path: string;
  kind: "directory" | "file" | "aggregate";
  sizeBytes: number;
  shared: boolean;
  categoryId: string;
  categoryLabel: string;
  applicationId: string | null;
  attribution: "manual" | "automatic" | "none";
  growthBytes: number | null;
};

type Props = {
  snapshot: { hostname: string; observedAt: string; scanDurationMs: number; totalBytes: number; usedBytes: number; freeBytes: number } | null;
  items: StorageRow[];
  applications: { id: string; name: string }[];
};

const categoryColors: Record<string, string> = {
  coolify: "var(--storage-coolify)", docker: "var(--storage-docker)", databases: "var(--storage-database)",
  logs: "var(--storage-logs)", backups: "var(--storage-backups)", applications: "var(--storage-apps)",
  homes: "var(--storage-homes)", system: "var(--storage-system)",
};

function formatBytes(bytes: number) {
  if (Math.abs(bytes) < 1024) return `${bytes.toLocaleString("fr-FR")} o`;
  const units = ["Ko", "Mo", "Go", "To", "Po"];
  let value = Math.abs(bytes) / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${bytes < 0 ? "−" : ""}${value.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} ${units[index]}`;
}

function ageLabel(iso: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `il y a ${minutes || 1} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `il y a ${hours} h` : `il y a ${Math.round(hours / 24)} j`;
}

export function StorageExplorer({ snapshot, items, applications }: Props) {
  const [sort, setSort] = useState<"size" | "name" | "growth">("size");
  const [category, setCategory] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem("luigi-theme");
    document.documentElement.dataset.theme = stored === "dark" || (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  }, []);

  const categories = useMemo(() => Array.from(new Map(items.map((item) => [item.categoryId, item.categoryLabel]))), [items]);
  const visible = useMemo(() => items.filter((item) => category === "all" || item.categoryId === category).sort((a, b) => {
    if (sort === "name") return a.label.localeCompare(b.label, "fr");
    if (sort === "growth") return (b.growthBytes ?? -Infinity) - (a.growthBytes ?? -Infinity);
    return b.sizeBytes - a.sizeBytes;
  }), [items, category, sort]);
  const chartItems = visible.filter((item) => item.sizeBytes > 0).slice(0, 36);
  const chartTotal = chartItems.reduce((sum, item) => sum + item.sizeBytes, 0);
  const attributed = applications.map((application) => ({
    ...application,
    sizeBytes: items.filter((item) => item.applicationId === application.id && !item.shared).reduce((sum, item) => sum + item.sizeBytes, 0),
  })).filter((application) => application.sizeBytes > 0).sort((a, b) => b.sizeBytes - a.sizeBytes);
  const percent = snapshot?.totalBytes ? Math.round(snapshot.usedBytes / snapshot.totalBytes * 100) : 0;

  if (!snapshot) return (
    <section className="storage-empty">
      <HardDrive aria-hidden="true" />
      <p className="eyebrow">Inventaire disque</p>
      <h1>Le premier scan se prépare.</h1>
      <p>Réinstalle l’agent depuis les paramètres VPS pour ajouter le collecteur. La santé continue d’être relevée toutes les 5 minutes ; l’espace disque est analysé toutes les 6 heures.</p>
    </section>
  );

  return <>
    <header className="storage-heading">
      <div><p className="eyebrow">{snapshot.hostname} · volume racine</p><h1>Où part l’espace disque ?</h1><p>Une vue lisible des zones qui grandissent, sans suppression à distance.</p></div>
      <div className="storage-freshness"><Clock3 aria-hidden="true" /><span><strong>Actualisé {ageLabel(snapshot.observedAt)}</strong><small>Toutes les 6 h · scan en {Math.max(1, Math.round(snapshot.scanDurationMs / 1000))} s</small></span></div>
    </header>

    <section className="storage-summary" aria-label="Résumé du volume">
      <div><HardDrive aria-hidden="true" /><span><small>Occupé</small><strong>{formatBytes(snapshot.usedBytes)}</strong></span></div>
      <div><Database aria-hidden="true" /><span><small>Disponible</small><strong>{formatBytes(snapshot.freeBytes)}</strong></span></div>
      <div><Server aria-hidden="true" /><span><small>Capacité</small><strong>{formatBytes(snapshot.totalBytes)}</strong></span></div>
      <div className="storage-summary__meter"><span style={{ width: `${Math.min(100, percent)}%` }} /><small>{percent}% utilisé</small></div>
    </section>

    <section className="storage-panel" aria-labelledby="map-title">
      <div className="storage-panel__heading"><div><p className="eyebrow">Carte du disque</p><h2 id="map-title">Répartition</h2></div><select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Filtrer par catégorie"><option value="all">Toutes les zones</option>{categories.map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></div>
      <div className="storage-treemap" aria-label="Carte proportionnelle des occupations disque">
        {chartItems.map((item) => <button
          key={item.key}
          type="button"
          className={`storage-tile${selected === item.key ? " storage-tile--selected" : ""}`}
          style={{ flexGrow: Math.max(1, item.sizeBytes / Math.max(1, chartTotal) * 1000), background: categoryColors[item.categoryId] ?? "var(--storage-system)" }}
          onClick={() => { setSelected(item.key); document.getElementById(`storage-row-${item.key}`)?.scrollIntoView({ behavior: "smooth", block: "center" }); }}
          title={`${item.path} · ${formatBytes(item.sizeBytes)}`}
        ><strong>{item.label}</strong><small>{formatBytes(item.sizeBytes)}</small></button>)}
      </div>
      <p className="storage-caption">Surface proportionnelle parmi les {chartItems.length} principaux éléments visibles. Les couches Docker partagées restent séparées des applications.</p>
    </section>

    <section className="storage-panel" aria-labelledby="apps-storage-title">
      <div className="storage-panel__heading"><div><p className="eyebrow">Attribution</p><h2 id="apps-storage-title">Poids des applications</h2></div><span className="storage-muted"><Sparkles aria-hidden="true" /> rapprochement automatique, ajustable</span></div>
      {attributed.length ? <div className="storage-app-list">{attributed.map((application) => <div key={application.id}><span><strong>{application.name}</strong><small>Volumes et répertoires attribués</small></span><b>{formatBytes(application.sizeBytes)}</b></div>)}</div> : <p className="storage-muted">Aucun répertoire n’est encore attribué. Utilise la table ci-dessous pour relier les ressources.</p>}
    </section>

    <section className="storage-panel" aria-labelledby="details-title">
      <div className="storage-panel__heading"><div><p className="eyebrow">Détails accessibles</p><h2 id="details-title">Éléments mesurés</h2></div><div className="storage-sort"><button className={sort === "size" ? "is-active" : ""} onClick={() => setSort("size")}>Taille</button><button className={sort === "growth" ? "is-active" : ""} onClick={() => setSort("growth")}>Évolution</button><button className={sort === "name" ? "is-active" : ""} onClick={() => setSort("name")}>Nom</button></div></div>
      <div className="storage-table-wrap"><table className="storage-table"><thead><tr><th>Élément</th><th>Zone</th><th>Taille</th><th>Évolution</th><th>Application</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{visible.map((item) => <tr key={item.key} id={`storage-row-${item.key}`} className={selected === item.key ? "is-selected" : ""}><td><strong>{item.label}</strong><small>{item.path}</small>{item.shared && <em>partagé</em>}</td><td>{item.categoryLabel}</td><td>{formatBytes(item.sizeBytes)}</td><td>{item.growthBytes === null ? "—" : <span className={item.growthBytes > 0 ? "storage-growth--up" : "storage-growth--down"}>{item.growthBytes > 0 ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}{formatBytes(Math.abs(item.growthBytes))}</span>}</td><td><form action={assignStorageResource}><input type="hidden" name="resourceKey" value={item.key} /><select name="applicationId" defaultValue={item.applicationId ?? "infrastructure"} aria-label={`Application liée à ${item.label}`}><option value="infrastructure">Infrastructure</option>{applications.map((application) => <option key={application.id} value={application.id}>{application.name}</option>)}</select><button type="submit">Enregistrer</button></form>{item.attribution === "automatic" && <small>détectée automatiquement</small>}</td><td><form action={createStorageMaintenance}><input type="hidden" name="resourceKey" value={item.key} /><input type="hidden" name="applicationId" value={item.applicationId ?? ""} /><button className="storage-task-button" type="submit" title="Créer une tâche de maintenance"><ListPlus aria-hidden="true" /><span className="sr-only">Créer une tâche pour {item.label}</span></button></form></td></tr>)}</tbody></table></div>
    </section>
  </>;
}
