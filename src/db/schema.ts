import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "@/db/auth-schema";

export * from "@/db/auth-schema";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const memberRole = pgEnum("member_role", ["owner", "member"]);
export const environment = pgEnum("environment", ["production", "staging", "development"]);
export const healthStatus = pgEnum("health_status", ["healthy", "warning", "critical", "unknown"]);
export const integrationKind = pgEnum("integration_kind", ["github", "uptime_robot", "vps_agent"]);
export const checkKind = pgEnum("check_kind", ["http", "tcp", "ssl", "heartbeat"]);
export const taskSeverity = pgEnum("task_severity", ["critical", "high", "medium", "low"]);
export const taskStatus = pgEnum("task_status", ["open", "planned", "in_progress", "done", "dismissed"]);
export const findingKind = pgEnum("finding_kind", ["dependency", "security", "capacity", "backup", "lifecycle"]);
export const incidentStatus = pgEnum("incident_status", ["open", "acknowledged", "resolved"]);
export const notificationStatus = pgEnum("notification_status", ["unread", "read", "archived"]);
export const dependencyStatus = pgEnum("dependency_status", ["current", "outdated", "unknown", "unsupported"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  ...timestamps,
});

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: memberRole("role").default("owner").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("workspace_member_unique").on(table.workspaceId, table.userId),
    index("workspace_members_user_idx").on(table.userId),
  ],
);

export const applications = pgTable(
  "applications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    environment: environment("environment").default("production").notNull(),
    publicUrl: text("public_url").notNull(),
    githubRepository: text("github_repository").notNull(),
    githubBranch: text("github_branch").default("main").notNull(),
    repositoryCommit: text("repository_commit"),
    status: healthStatus("status").default("unknown").notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastRepositoryScannedAt: timestamp("last_repository_scanned_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("applications_workspace_url_unique").on(table.workspaceId, table.publicUrl),
    index("applications_workspace_idx").on(table.workspaceId),
  ],
);

export const dependencies = pgTable(
  "dependencies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    ecosystem: text("ecosystem").notNull(),
    name: text("name").notNull(),
    currentVersion: text("current_version"),
    requestedRange: text("requested_range").notNull(),
    latestVersion: text("latest_version"),
    status: dependencyStatus("status").default("unknown").notNull(),
    direct: boolean("direct").default(true).notNull(),
    development: boolean("development").default(false).notNull(),
    evidence: text("evidence").notNull(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("dependencies_application_ecosystem_name_unique").on(table.applicationId, table.ecosystem, table.name),
    index("dependencies_application_idx").on(table.applicationId),
  ],
);

export const technologies = pgTable(
  "technologies",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: text("version"),
    source: text("source").default("detected").notNull(),
    evidence: text("evidence"),
    confirmed: boolean("confirmed").default(false).notNull(),
    ...timestamps,
  },
  (table) => [uniqueIndex("technologies_application_name_unique").on(table.applicationId, table.name)],
);

export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: integrationKind("kind").notNull(),
    label: text("label").notNull(),
    encryptedCredentials: text("encrypted_credentials"),
    configuration: jsonb("configuration").$type<Record<string, unknown>>().default({}).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("integrations_workspace_kind_unique").on(table.workspaceId, table.kind),
    index("integrations_workspace_idx").on(table.workspaceId),
  ],
);

export const checks = pgTable(
  "checks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    kind: checkKind("kind").default("http").notNull(),
    target: text("target").notNull(),
    intervalSeconds: integer("interval_seconds").default(60).notNull(),
    timeoutSeconds: integer("timeout_seconds").default(10).notNull(),
    failureThreshold: integer("failure_threshold").default(3).notNull(),
    latencyWarningMs: integer("latency_warning_ms").default(1500).notNull(),
    enabled: boolean("enabled").default(true).notNull(),
    ...timestamps,
  },
  (table) => [index("checks_application_idx").on(table.applicationId)],
);

export const observations = pgTable(
  "observations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    checkId: uuid("check_id")
      .notNull()
      .references(() => checks.id, { onDelete: "cascade" }),
    status: healthStatus("status").notNull(),
    statusCode: integer("status_code"),
    latencyMs: integer("latency_ms"),
    detail: text("detail"),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("observations_check_time_idx").on(table.checkId, table.observedAt)],
);

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    applicationId: uuid("application_id").references(() => applications.id, { onDelete: "cascade" }),
    kind: findingKind("kind").notNull(),
    severity: taskSeverity("severity").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    fingerprint: text("fingerprint").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("findings_workspace_fingerprint_unique").on(table.workspaceId, table.fingerprint),
    index("findings_workspace_idx").on(table.workspaceId),
  ],
);

export const incidents = pgTable(
  "incidents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => applications.id, { onDelete: "cascade" }),
    checkId: uuid("check_id").references(() => checks.id, { onDelete: "cascade" }),
    status: incidentStatus("status").default("open").notNull(),
    title: text("title").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    index("incidents_application_idx").on(table.applicationId),
    index("incidents_check_idx").on(table.checkId),
  ],
);

export const maintenanceTasks = pgTable(
  "maintenance_tasks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    findingId: uuid("finding_id").references(() => findings.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description"),
    category: findingKind("category").notNull(),
    severity: taskSeverity("severity").default("medium").notNull(),
    status: taskStatus("status").default("open").notNull(),
    automatic: boolean("automatic").default(false).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [index("maintenance_tasks_workspace_idx").on(table.workspaceId)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: notificationStatus("status").default("unread").notNull(),
    severity: taskSeverity("severity").default("medium").notNull(),
    targetUrl: text("target_url"),
    ...timestamps,
  },
  (table) => [index("notifications_workspace_idx").on(table.workspaceId)],
);

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    ...timestamps,
  },
  (table) => [uniqueIndex("push_subscriptions_endpoint_unique").on(table.endpoint)],
);

export const vpsMetricSamples = pgTable(
  "vps_metric_samples",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reportId: uuid("report_id").notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    cpuPercent: real("cpu_percent"),
    memoryPercent: real("memory_percent"),
    diskPercent: real("disk_percent"),
    swapPercent: real("swap_percent"),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("vps_metric_samples_report_unique").on(table.reportId),
    index("vps_metric_samples_workspace_time_idx").on(table.workspaceId, table.observedAt),
  ],
);
