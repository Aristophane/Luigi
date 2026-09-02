import type {
  ActivityEvent,
  MaintenanceTask,
  MonitoredApplication,
  ServerMetric,
} from "@/lib/domain";

export const applications: MonitoredApplication[] = [
  {
    id: "thermidor",
    name: "Thermidor Agency",
    environment: "production",
    status: "healthy",
    url: "thermidor.agency",
    uptime30d: 99.98,
    latencyMs: 184,
    lastCheckLabel: "il y a 38 secondes",
    lastDeployLabel: "hier à 18:42",
    technologies: [
      { name: "Next.js", version: "16", source: "confirmed" },
      { name: "Node.js", version: "24", source: "detected", evidence: ".nvmrc" },
    ],
  },
  {
    id: "atelier",
    name: "Atelier Nord",
    environment: "production",
    status: "healthy",
    url: "atelier-nord.fr",
    uptime30d: 100,
    latencyMs: 126,
    lastCheckLabel: "il y a 42 secondes",
    lastDeployLabel: "25 août à 11:16",
    technologies: [
      { name: "Astro", version: "5", source: "detected", evidence: "package.json" },
    ],
  },
  {
    id: "lumen",
    name: "Lumen Studio",
    environment: "staging",
    status: "warning",
    url: "staging.lumen.studio",
    uptime30d: 99.72,
    latencyMs: 842,
    lastCheckLabel: "il y a 51 secondes",
    lastDeployLabel: "aujourd’hui à 09:14",
    technologies: [
      { name: "Nuxt", version: "4", source: "confirmed" },
      { name: "PostgreSQL", version: "16", source: "declared" },
    ],
  },
];

export const serverMetrics: ServerMetric[] = [
  {
    id: "cpu",
    label: "CPU",
    value: 24,
    displayValue: "24 %",
    detail: "Charge 0,62 · 4 vCPU",
    status: "healthy",
  },
  {
    id: "memory",
    label: "Mémoire",
    value: 61,
    displayValue: "4,9 / 8 Go",
    detail: "Stable depuis 6 heures",
    status: "healthy",
  },
  {
    id: "disk",
    label: "Disque",
    value: 73,
    displayValue: "58 / 80 Go",
    detail: "+4,2 Go sur 30 jours",
    status: "warning",
  },
  {
    id: "swap",
    label: "Swap",
    value: 8,
    displayValue: "164 Mo",
    detail: "Aucune pression mémoire",
    status: "healthy",
  },
];

export const maintenanceTasks: MaintenanceTask[] = [
  {
    id: "task-disk",
    title: "Examiner la croissance du disque",
    category: "capacity",
    severity: "medium",
    dueLabel: "avant le 8 septembre",
    source: "VPS production",
    status: "open",
  },
  {
    id: "task-nuxt",
    title: "Valider la mise à jour Nuxt 4.2",
    category: "dependency",
    severity: "low",
    dueLabel: "cette semaine",
    source: "Lumen Studio · Renovate",
    status: "planned",
  },
  {
    id: "task-backup",
    title: "Planifier le test de restauration",
    category: "backup",
    severity: "medium",
    dueLabel: "dans 12 jours",
    source: "Récurrence trimestrielle",
    status: "open",
  },
];

export const activity: ActivityEvent[] = [
  {
    id: "evt-check",
    title: "Collecte terminée",
    detail: "3 applications et le VPS ont répondu.",
    timeLabel: "10:42",
    status: "healthy",
  },
  {
    id: "evt-lumen",
    title: "Latence élevée sur Lumen Studio",
    detail: "842 ms pendant trois contrôles consécutifs.",
    timeLabel: "10:39",
    status: "warning",
  },
  {
    id: "evt-renovate",
    title: "Analyse des dépendances reçue",
    detail: "Une mise à jour nécessite une validation.",
    timeLabel: "09:16",
    status: "healthy",
  },
];
