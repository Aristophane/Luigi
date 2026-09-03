import { z } from "zod";

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const storageItemSchema = z.object({
  key: z.string().min(1).max(600),
  label: z.string().min(1).max(160),
  path: z.string().min(1).max(500),
  kind: z.enum(["directory", "file", "aggregate"]),
  sizeBytes: bytes,
  shared: z.boolean().default(false),
  hint: z.string().max(160).optional(),
});

export const storageCategorySchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/).max(40),
  label: z.string().min(1).max(80),
  sizeBytes: bytes,
  items: z.array(storageItemSchema).max(300),
});

export const storageSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().uuid(),
  agentId: z.string().uuid(),
  hostname: z.string().min(1).max(255),
  observedAt: z.string().datetime({ offset: true }),
  scanDurationMs: z.number().int().nonnegative().max(3_600_000),
  filesystem: z.object({
    mount: z.literal("/"),
    totalBytes: bytes,
    usedBytes: bytes,
    freeBytes: bytes,
  }),
  categories: z.array(storageCategorySchema).max(20),
});

export type StorageSnapshot = z.infer<typeof storageSnapshotSchema>;
export type StorageItem = z.infer<typeof storageItemSchema>;
