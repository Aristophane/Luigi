import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, checks, observations, vpsMetricSamples } from "@/db/schema";
import { assertLease, completeJob, type Job } from "@/lib/job-queue";
import { isFresh } from "@/lib/monitoring-state";
import { evaluateVpsReport } from "@/lib/vps-rules";
import { vpsReportSchema } from "@/lib/vps-report";

export async function processAgentReport(job: Job) {
  await db.transaction(async (tx) => {
    await assertLease(tx, job);
    const [sample] = await tx.select().from(vpsMetricSamples).where(eq(vpsMetricSamples.id, job.payload.sampleId)).for("update");
    if (!sample?.agentId || !sample.serverId) throw new Error("REPORT_NOT_FOUND");
    const [agent] = await tx.select().from(agents).where(eq(agents.id, sample.agentId)).for("update");
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    if (!sample.processedAt) {
      const fresh = isFresh(sample.observedAt, agent.intervalSeconds);
      const ordered = !agent.lastProcessedAt || sample.observedAt > agent.lastProcessedAt;
      if (fresh && ordered) {
        const report = vpsReportSchema.parse(sample.payload);
        await evaluateVpsReport(sample.workspaceId, report, sample.observedAt, sample.serverId, tx);
        // Only explicitly selected essential units participate in application health.
        const serviceChecks = await tx.select().from(checks).where(and(eq(checks.serverId, sample.serverId), eq(checks.enabled, true)));
        for (const check of serviceChecks.filter((check) => check.kind === "heartbeat")) {
          const unit = report.runtime?.units.find((unit) => unit.key === check.serviceKey);
          const measured = report.runtime?.collectedAt ? new Date(report.runtime.collectedAt) : null;
          const status = unit && isFresh(measured, agent.intervalSeconds) ? unit.running ? "healthy" : "critical" : "unknown";
          await tx.update(checks).set({ status, lastCheckedAt: measured, intervalSeconds: agent.intervalSeconds }).where(eq(checks.id, check.id));
          await tx.insert(observations).values({ checkId: check.id, status, observedAt: sample.observedAt,
            detail: unit ? `${unit.label} · ${unit.running ? "en service" : "arrêté"}` : "Service absent de la collecte : état inconnu" });
        }
        await tx.update(agents).set({ lastProcessedAt: sample.observedAt }).where(eq(agents.id, agent.id));
      }
      await tx.update(vpsMetricSamples).set({ processedAt: new Date(), processingStatus: fresh && ordered ? "processed" : "stale" })
        .where(eq(vpsMetricSamples.id, sample.id));
    }
    await completeJob(tx, job);
  });
}
