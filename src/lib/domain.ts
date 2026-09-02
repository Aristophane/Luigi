export type HealthStatus = "healthy" | "warning" | "critical" | "unknown";

export type TechnologySource = "detected" | "declared" | "confirmed" | "ignored";

export interface Technology {
  name: string;
  version?: string;
  source: TechnologySource;
  evidence?: string;
}

export interface MonitoredApplication {
  id: string;
  name: string;
  environment: "production" | "staging" | "development";
  status: HealthStatus;
  url: string;
  uptime30d: number | null;
  latencyMs: number | null;
  lastCheckLabel: string;
  lastDeployLabel: string;
  technologies: Technology[];
}

export interface ServerMetric {
  id: "cpu" | "memory" | "disk" | "swap";
  label: string;
  value: number;
  displayValue: string;
  detail: string;
  status: HealthStatus;
}

export interface VpsOverview {
  configured: boolean;
  connected: boolean;
  status: HealthStatus;
  hostname?: string;
  lastSeenLabel: string;
  metrics: ServerMetric[];
  availableUpdates: number;
  securityUpdates: number;
  rebootRequired: boolean;
  ufwActive: boolean | null;
  backupStatus: "ok" | "failed" | "unknown";
}

export interface MaintenanceTask {
  id: string;
  title: string;
  category: "security" | "dependency" | "capacity" | "backup" | "lifecycle";
  severity: "critical" | "high" | "medium" | "low";
  dueLabel: string;
  source: string;
  status: "open" | "planned" | "in_progress";
}

export interface ActivityEvent {
  id: string;
  title: string;
  detail: string;
  timeLabel: string;
  status: HealthStatus;
}

export interface DashboardNotification {
  id: string;
  title: string;
  body: string;
  severity: "critical" | "high" | "medium" | "low";
  targetUrl: string;
  createdLabel: string;
}
