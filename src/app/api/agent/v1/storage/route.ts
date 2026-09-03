import { and, eq, lt } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { integrations, vpsStorageSnapshots } from "@/db/schema";
import { hashAgentToken } from "@/lib/agent-auth";
import { storageSnapshotSchema } from "@/lib/storage-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REPORT_BYTES = 512 * 1024;
const RETENTION_DAYS = 90;

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token.startsWith("luigi_vps_") || token.length > 256) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const [integration] = await db
    .select({ workspaceId: integrations.workspaceId, configuration: integrations.configuration })
    .from(integrations)
    .where(and(
      eq(integrations.kind, "vps_agent"),
      eq(integrations.enabled, true),
      eq(integrations.encryptedCredentials, hashAgentToken(token)),
    ))
    .limit(1);
  if (!integration) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_REPORT_BYTES) return NextResponse.json({ error: "Report too large." }, { status: 413 });
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
  const parsed = storageSnapshotSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid storage report." }, { status: 422 });
  }
  if (integration.configuration.agentId !== parsed.data.agentId) {
    return NextResponse.json({ error: "Agent identity mismatch." }, { status: 403 });
  }

  const [inserted] = await db.insert(vpsStorageSnapshots).values({
    snapshotId: parsed.data.snapshotId,
    workspaceId: integration.workspaceId,
    hostname: parsed.data.hostname,
    totalBytes: parsed.data.filesystem.totalBytes,
    usedBytes: parsed.data.filesystem.usedBytes,
    freeBytes: parsed.data.filesystem.freeBytes,
    scanDurationMs: parsed.data.scanDurationMs,
    payload: parsed.data,
    observedAt: new Date(parsed.data.observedAt),
  }).onConflictDoNothing({ target: vpsStorageSnapshots.snapshotId }).returning({ id: vpsStorageSnapshots.id });

  if (!inserted) return NextResponse.json({ accepted: true, duplicate: true });

  const retentionCutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await db.delete(vpsStorageSnapshots).where(and(
    eq(vpsStorageSnapshots.workspaceId, integration.workspaceId),
    lt(vpsStorageSnapshots.observedAt, retentionCutoff),
  ));

  return NextResponse.json({ accepted: true, duplicate: false }, { status: 202 });
}
