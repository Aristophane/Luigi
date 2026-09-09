import { timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { applications, deployments } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REPORT_BYTES = 16 * 1024;
const httpUrl = z.string().url().max(2_000).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "URL must use HTTP or HTTPS.");

const deploymentSchema = z.object({
  applicationId: z.string().uuid().optional(),
  applicationUrl: httpUrl.optional(),
  deploymentId: z.string().trim().min(1).max(200),
  commitSha: z.string().trim().regex(/^[a-f0-9]{7,64}$/i),
  source: z.string().trim().min(1).max(60).regex(/^[a-z0-9._-]+$/i).default("ci"),
  sourceUrl: httpUrl.optional(),
  deployedAt: z.iso.datetime({ offset: true }),
}).refine((value) => Boolean(value.applicationId || value.applicationUrl), {
  message: "applicationId or applicationUrl is required.",
});

function isAuthorized(request: Request) {
  const expected = process.env.DEPLOYMENT_INGEST_SECRET;
  const authorization = request.headers.get("authorization");
  const received = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!expected || !received) return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

function normalizeApplicationUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/$/, "") || "/";
  return url.toString();
}

export async function POST(request: Request) {
  if (!process.env.DEPLOYMENT_INGEST_SECRET) {
    return NextResponse.json({ error: "Deployment ingestion is not configured." }, { status: 503 });
  }
  if (!isAuthorized(request)) {
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
  const parsed = deploymentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({
      error: "Invalid deployment report.",
      issues: parsed.error.issues.map((issue) => issue.path.join(".")),
    }, { status: 422 });
  }

  const deployedAt = new Date(parsed.data.deployedAt);
  const now = new Date();
  if (deployedAt.getTime() > now.getTime() + 5 * 60 * 1000 || deployedAt.getUTCFullYear() < 2000) {
    return NextResponse.json({ error: "Invalid deployment date." }, { status: 422 });
  }
  const applicationConditions = [
    isNull(applications.archivedAt),
    ...(parsed.data.applicationId ? [eq(applications.id, parsed.data.applicationId)] : []),
    ...(parsed.data.applicationUrl
      ? [eq(applications.publicUrl, normalizeApplicationUrl(parsed.data.applicationUrl))]
      : []),
  ];
  const [application] = await db
    .select({ id: applications.id, workspaceId: applications.workspaceId })
    .from(applications)
    .where(and(...applicationConditions))
    .limit(1);
  if (!application) {
    return NextResponse.json({ error: "Application not found." }, { status: 404 });
  }

  const [inserted] = await db
    .insert(deployments)
    .values({
      workspaceId: application.workspaceId,
      applicationId: application.id,
      deploymentId: parsed.data.deploymentId,
      commitSha: parsed.data.commitSha.toLowerCase(),
      source: parsed.data.source.toLowerCase(),
      sourceUrl: parsed.data.sourceUrl,
      deployedAt,
    })
    .onConflictDoNothing({
      target: [deployments.applicationId, deployments.source, deployments.deploymentId],
    })
    .returning({ id: deployments.id });

  return NextResponse.json({
    accepted: true,
    duplicate: !inserted,
    applicationId: application.id,
  }, { status: inserted ? 202 : 200 });
}
