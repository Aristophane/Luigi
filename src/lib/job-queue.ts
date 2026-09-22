import "server-only";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, type Database } from "@/db";
import { jobs } from "@/db/schema";

// Global limits, shared by every worker through a transaction advisory lock.
export const jobBudgets = {
  check: { concurrency: 4, timeoutSeconds: 90 },
  scan: { concurrency: 1, timeoutSeconds: 600 },
  report: { concurrency: 2, timeoutSeconds: 90 },
  notification: { concurrency: 4, timeoutSeconds: 20 },
} as const;
export type JobKind = keyof typeof jobBudgets;
export type Job = typeof jobs.$inferSelect;
export type Lease = Pick<Job, "id" | "lockToken">;

export async function enqueueJob(input: {
  workspaceId: string; kind: JobKind; key: string; serialKey?: string;
  payload: Record<string, string>; maxAttempts?: number;
}, database: Database = db) {
  const [job] = await database.insert(jobs).values({ ...input, serialKey: input.serialKey ?? input.key })
    .onConflictDoNothing().returning({ id: jobs.id });
  return job;
}

export async function claimJob(kind: JobKind): Promise<Job | undefined> {
  const budget = jobBudgets[kind];
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`luigi-queue:${kind}`}))`);
    // An exhausted lease is terminal even if the process died before recording its failure.
    const exhausted = await tx.execute(sql`update jobs set status = 'failed', completed_at = now(),
      last_error = 'Lease expired after final attempt', updated_at = now()
      where id in (select id from jobs where kind = ${kind} and status = 'running'
        and locked_until < now() and attempts >= max_attempts for update skip locked)
      returning payload`);
    if (kind === "notification") {
      for (const row of exhausted) {
        const payload = row.payload as Record<string, string>;
        if (payload.deliveryId) await tx.execute(sql`update notification_deliveries set status = 'failed', updated_at = now()
          where id = ${payload.deliveryId} and status <> 'delivered'`);
      }
    }
    const active = await tx.execute(sql`select count(*)::int as count from jobs
      where kind = ${kind} and status = 'running' and locked_until > now()`);
    if (Number(active[0]?.count) >= budget.concurrency) return;
    const candidates = await tx.execute(sql`select j.id from jobs j
      where j.kind = ${kind} and j.attempts < j.max_attempts
        and ((j.status = 'queued' and j.available_at <= now()) or (j.status = 'running' and j.locked_until < now()))
        and not exists (select 1 from jobs older where older.serial_key = j.serial_key
          and older.id <> j.id and older.status in ('queued', 'running')
          and (older.created_at, older.id) < (j.created_at, j.id))
      order by j.available_at, j.created_at, j.id for update skip locked limit 1`);
    if (!candidates[0]) return;
    const [claimed] = await tx.update(jobs).set({
      status: "running", attempts: sql`${jobs.attempts} + 1`, lockToken: randomUUID(),
      lockedUntil: sql`now() + (${budget.timeoutSeconds + 15} * interval '1 second')`, updatedAt: new Date(),
    }).where(eq(jobs.id, String(candidates[0].id))).returning();
    return claimed;
  });
}

// Fencing: a process whose lease expired cannot commit after a replacement worker.
export async function assertLease(tx: Database, lease?: Lease) {
  if (!lease) return;
  const result = await tx.execute(sql`select id from jobs where id = ${lease.id} and lock_token = ${lease.lockToken}
    and status = 'running' and locked_until > clock_timestamp() for update`);
  if (!result.length) throw new Error("JOB_LEASE_LOST");
}

export async function completeJob(tx: Database, lease?: Lease) {
  if (!lease) return;
  await assertLease(tx, lease);
  await tx.update(jobs).set({ status: "succeeded", completedAt: new Date(), lockedUntil: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, lease.id), eq(jobs.lockToken, lease.lockToken!)));
}

export async function failJob(job: Job, reason: string) {
  await db.update(jobs).set({
    status: job.attempts >= job.maxAttempts ? "failed" : "queued",
    lastError: reason.slice(0, 300), lockedUntil: null,
    availableAt: new Date(Date.now() + Math.min(3600, 15 * 2 ** (job.attempts - 1)) * 1000),
    completedAt: job.attempts >= job.maxAttempts ? new Date() : null, updatedAt: new Date(),
  }).where(and(eq(jobs.id, job.id), eq(jobs.lockToken, job.lockToken!), eq(jobs.status, "running")));
}
