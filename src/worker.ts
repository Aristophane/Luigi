import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, closeDatabase } from "@/db";
import { jobs } from "@/db/schema";
import { claimJob, failJob, jobBudgets, type JobKind } from "@/lib/job-queue";
import { runHttpCheck } from "@/lib/http-monitor";
import { scanStoredApplication } from "@/lib/application-scanner";
import { deliverNotification } from "@/lib/notification-worker";
import { processAgentReport } from "@/lib/report-processing";
import { pulseWorker, schedulerTick } from "@/lib/monitor-scheduler";

const childId = process.argv[2];
if (childId) {
  try {
    const [job] = await db.select().from(jobs).where(eq(jobs.id, childId));
    if (!job || job.status !== "running" || job.lockToken !== process.argv[3]) throw new Error("JOB_LEASE_LOST");
    try {
      if (job.kind === "check") await runHttpCheck(job.payload.checkId, job);
      else if (job.kind === "scan") await scanStoredApplication(job.workspaceId, job.payload.applicationId, job);
      else if (job.kind === "report") await processAgentReport(job);
      else if (job.kind === "notification") await deliverNotification(job);
    } catch (error) {
      await failJob(job, error instanceof Error ? error.name + ": " + error.message.slice(0, 100) : "Job failed");
      process.exitCode = 1;
    }
  } finally { await closeDatabase(); }
} else {
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
          // Process isolation bounds CPU, networking and execution time. Lease expiry resumes killed jobs.
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
