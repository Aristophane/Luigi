import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { DeploymentIngestionError, ingestDeploymentReport } from "@/lib/deployment-ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REPORT_BYTES = 16 * 1024;

function isAuthorized(request: Request) {
  const expected = process.env.DEPLOYMENT_INGEST_SECRET;
  const authorization = request.headers.get("authorization");
  const received = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!expected || !received) return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
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
  try {
    const result = await ingestDeploymentReport(body);
    return NextResponse.json(result, { status: result.duplicate ? 200 : 202 });
  } catch (error) {
    if (!(error instanceof DeploymentIngestionError)) throw error;
    return NextResponse.json({ error: error.message, ...(error.issues ? { issues: error.issues } : {}) }, { status: error.status });
  }
}
