import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { integrations, vpsMetricSamples } from "@/db/schema";
import { hashAgentToken } from "@/lib/agent-auth";
import { vpsReportSchema } from "@/lib/vps-report";
import { evaluateVpsReport } from "@/lib/vps-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REPORT_BYTES = 64 * 1024;

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token.startsWith("luigi_vps_") || token.length > 256) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const [integration] = await db
    .select({
      id: integrations.id,
      workspaceId: integrations.workspaceId,
      configuration: integrations.configuration,
    })
    .from(integrations)
    .where(and(
      eq(integrations.kind, "vps_agent"),
      eq(integrations.enabled, true),
      eq(integrations.encryptedCredentials, hashAgentToken(token)),
    ))
    .limit(1);
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

  const configuredAgentId = integration.configuration.agentId;
  if (typeof configuredAgentId !== "string" || configuredAgentId !== parsed.data.agentId) {
    return NextResponse.json({ error: "Agent identity mismatch." }, { status: 403 });
  }

  const receivedAt = new Date();
  const [inserted] = await db
    .insert(vpsMetricSamples)
    .values({
      reportId: parsed.data.reportId,
      workspaceId: integration.workspaceId,
      hostname: parsed.data.hostname,
      cpuPercent: parsed.data.metrics.cpuPercent,
      memoryPercent: parsed.data.metrics.memoryPercent,
      diskPercent: parsed.data.metrics.diskPercent,
      swapPercent: parsed.data.metrics.swapPercent,
      payload: parsed.data,
      observedAt: receivedAt,
    })
    .onConflictDoNothing({ target: vpsMetricSamples.reportId })
    .returning({ id: vpsMetricSamples.id });

  if (!inserted) {
    return NextResponse.json({ accepted: true, duplicate: true });
  }

  await db
    .update(integrations)
    .set({
      label: `Agent VPS · ${parsed.data.hostname}`,
      configuration: {
        ...integration.configuration,
        hostname: parsed.data.hostname,
        schemaVersion: parsed.data.schemaVersion,
        sourceObservedAt: parsed.data.observedAt,
      },
      lastSyncedAt: receivedAt,
      updatedAt: receivedAt,
    })
    .where(eq(integrations.id, integration.id));
  await evaluateVpsReport(integration.workspaceId, parsed.data, receivedAt);

  return NextResponse.json({ accepted: true, duplicate: false, receivedAt: receivedAt.toISOString() }, { status: 202 });
}
