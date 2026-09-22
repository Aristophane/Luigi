import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, servers, vpsMetricSamples } from "@/db/schema";
import { authenticateAgent } from "@/lib/agent-registry";
import { enqueueJob } from "@/lib/job-queue";
import { recordMonitoringHeartbeat } from "@/lib/monitoring-heartbeats";
import { vpsReportSchema } from "@/lib/vps-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REPORT_BYTES = 64 * 1024;

export async function POST(request: Request) {
  const integration = await authenticateAgent(request);
  if (!integration) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_REPORT_BYTES) {
    return NextResponse.json({ error: "Report too large." }, { status: 413 });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_REPORT_BYTES) {
    return NextResponse.json({ error: "Report too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const parsed = vpsReportSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid report.", issues: parsed.error.issues.map((issue) => issue.path.join(".")) }, { status: 422 });
  }

  const configuredAgentId = integration.id;
  if (typeof configuredAgentId !== "string" || configuredAgentId !== parsed.data.agentId) {
    return NextResponse.json({ error: "Agent identity mismatch." }, { status: 403 });
  }

  const receivedAt = new Date();
  const observedAt = new Date(parsed.data.observedAt);
  if (observedAt.getTime() > receivedAt.getTime() + 60_000 || observedAt.getUTCFullYear() < 2000) {
    return NextResponse.json({ error: "Invalid observation date." }, { status: 422 });
  }
  const inserted = await db.transaction(async (tx) => {
    const [sample] = await tx.insert(vpsMetricSamples).values({
      reportId: parsed.data.reportId, workspaceId: integration.workspaceId,
      serverId: integration.serverId, agentId: integration.id, hostname: parsed.data.hostname,
      cpuPercent: parsed.data.metrics.cpuPercent, memoryPercent: parsed.data.metrics.memoryPercent,
      diskPercent: parsed.data.metrics.diskPercent, swapPercent: parsed.data.metrics.swapPercent,
      payload: parsed.data, observedAt, receivedAt,
    }).onConflictDoNothing({ target: vpsMetricSamples.reportId }).returning();
    if (!sample) return false;
    await enqueueJob({ workspaceId: integration.workspaceId, kind: "report", key: 'report:' + sample.id,
      serialKey: 'agent:' + integration.id, payload: { sampleId: sample.id } }, tx);
    await tx.update(agents).set({ lastSeenAt: receivedAt }).where(eq(agents.id, integration.id));
    await tx.update(servers).set({ hostname: parsed.data.hostname, label: parsed.data.hostname }).where(eq(servers.id, integration.serverId));
    await recordMonitoringHeartbeat(integration.workspaceId, 'vps_agent:' + integration.serverId,
      integration.intervalSeconds, observedAt, tx);
    return true;
  });
  return NextResponse.json({ accepted: true, duplicate: !inserted, processing: "queued", receivedAt: receivedAt.toISOString() }, { status: 202 });
}
