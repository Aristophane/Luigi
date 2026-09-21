import { z } from "zod";

const percentage = z.number().finite().min(0).max(100);
const bytes = z.number().int().nonnegative();
const timestamp = z.iso.datetime({ offset: true });

const runtimeUnitSchema = z.object({
  key: z.string().trim().min(1).max(160),
  kind: z.enum(["container", "service"]),
  label: z.string().trim().min(1).max(160),
  running: z.boolean(),
  memoryCurrentBytes: bytes.nullable(),
  memoryMaxBytes: bytes.nullable(),
  memoryPeakBytes: bytes.nullable(),
  oomKills: z.number().int().nonnegative().nullable(),
  restartCount: z.number().int().nonnegative().nullable(),
  startedAt: timestamp.nullable(),
});

const runtimeEventSchema = z.object({
  type: z.enum(["oom_kill", "restart"]),
  unitKey: z.string().trim().min(1).max(160),
  unitLabel: z.string().trim().min(1).max(160),
  occurredAt: timestamp,
  count: z.number().int().positive().max(100_000).optional(),
  task: z.string().trim().max(64).optional(),
  scope: z.enum(["cgroup", "host"]).optional(),
  anonRssBytes: bytes.optional(),
});

const runtimeSchema = z.object({
  oomKillsSinceBoot: z.number().int().nonnegative().nullable(),
  bootId: z.string().trim().max(64).nullable(),
  collectedAt: timestamp.nullable(),
  units: z.array(runtimeUnitSchema).max(60).default([]),
  events: z.array(runtimeEventSchema).max(100).default([]),
});

export const vpsReportSchema = z.object({
  schemaVersion: z.literal(1),
  reportId: z.string().uuid(),
  agentId: z.string().uuid(),
  hostname: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/),
  observedAt: z.iso.datetime({ offset: true }),
  system: z.object({
    distribution: z.enum(["ubuntu", "debian", "unknown"]),
    distributionVersion: z.string().trim().min(1).max(40),
    distributionLabel: z.string().trim().min(1).max(120),
    architecture: z.string().trim().min(1).max(40),
    agentVersion: z.string().trim().min(1).max(40),
  }).optional(),
  metrics: z.object({
    cpuPercent: percentage,
    memoryPercent: percentage,
    diskPercent: percentage,
    swapPercent: percentage,
    load1: z.number().finite().min(0).max(100_000),
    uptimeSeconds: z.number().int().nonnegative(),
  }),
  updates: z.object({
    available: z.number().int().nonnegative().max(100_000),
    security: z.number().int().nonnegative().max(100_000),
    held: z.number().int().nonnegative().max(100_000),
    rebootRequired: z.boolean(),
  }),
  security: z.object({
    ufwActive: z.boolean().nullable(),
    sshPasswordAuthentication: z.boolean().nullable(),
    sshRootLogin: z.boolean().nullable(),
  }),
  backup: z.object({
    status: z.enum(["ok", "failed", "unknown"]),
    lastSuccessAt: z.iso.datetime({ offset: true }).nullable(),
  }).optional(),
  services: z.array(z.object({
    name: z.string().trim().min(1).max(120),
    active: z.boolean(),
  })).max(50).default([]),
  // Une section d’exécution illisible ne doit jamais faire rejeter le rapport de santé.
  runtime: runtimeSchema.optional().catch(undefined),
});

export type VpsReport = z.infer<typeof vpsReportSchema>;
export type VpsRuntime = z.infer<typeof runtimeSchema>;
