import { z } from "zod";

const percentage = z.number().finite().min(0).max(100);

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
});

export type VpsReport = z.infer<typeof vpsReportSchema>;
