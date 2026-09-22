import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, closeDatabase } from "@/db";
import { jobs } from "@/db/schema";
import { claimJob, failJob, jobBudgets, type JobKind } from "@/lib/job-queue";

const childId = process.argv[2];
if (childId) {
  try {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, childId));
    if (!job || job.status !== "running" || job.lockToken !== process.argv[3]) throw new Error("JOB_LEASE_LOST");
    try {
      if (job.kind === "check") {
        const { runHttpCheck } = await import("@/lib/http-monitor");
        await runHttpCheck(job.payload.checkId, job);
      } else if (job.kind === "scan") {
        const { scanStoredApplication } = await import("@/lib/application-scanner");
        await scanStoredApplication(job.workspaceId, job.payload.applicationId, job);
      } else if (job.kind === "report") {
        const { processAgentReport } = await import("@/lib/report-processing");
        await processAgentReport(job);
      } else if (job.kind === "notification") {
        const { deliverNotification } = await import("@/lib/notification-worker");
        await deliverNotification(job);
      }
    } catch (error) {
      await failJob(job, error instanceof Error ? error.name + ": " + error.message.slice(0, 100) : "Job failed");
      process.exitCode = 1;
    }
  } finally { await closeDatabase(); }
} else {
  const { pulseWorker, schedulerTick } = await import("@/lib/monitor-scheduler");
  let stopping = false;
  const children = new Set<ReturnType<typeof spawn>>();
  const stop = () => { stopping = true; for (const child of children) child.kill("SIGKILL"); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  async function lane(kind: JobKind) {
    while (!stopping) {
      try {
        const job = await claimJob(kind);
        await pulseWorker(`worker:${kind}`);
        if (job) {
          const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), job.id, job.lockToken!],
            { stdio: "inherit", windowsHide: true });
          children.add(child);
          const timer = setTimeout(() => child.kill("SIGKILL"), jobBudgets[kind].timeoutSeconds * 1000);
          // Isolation enforces the execution deadline. Queue budgets bound concurrency;
          // this is not a CPU quota. Lease expiry resumes killed jobs.
          child.once("exit", () => { clearTimeout(timer); children.delete(child); });
          child.once("error", () => { clearTimeout(timer); children.delete(child); });
        }
      } catch (error) { console.error(`Worker ${kind}:`, error instanceof Error ? error.name : "unavailable"); }
      await delay(2000);
    }
  }
  async function scheduler() {
    while (!stopping) {
      try { await schedulerTick(); }
      catch (error) { console.error("Scheduler:", error instanceof Error ? error.name : "unavailable"); }
      await delay(10_000);
    }
  }
  await Promise.all([scheduler(), ...Object.keys(jobBudgets).map((kind) => lane(kind as JobKind))]);
  await closeDatabase();
}
