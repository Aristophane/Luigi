import { and, eq, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { integrations, vpsAgentEnrollments } from "@/db/schema";
import { hashAgentEnrollmentCode, issueAgentCredentials } from "@/lib/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authorization = request.headers.get("authorization");
  const code = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!code.startsWith("luigi_enroll_") || code.length > 256) {
    return NextResponse.json({ error: "Code d’enrôlement invalide ou expiré." }, { status: 401 });
  }

  const now = new Date();
  const result = await db.transaction(async (transaction) => {
    const [enrollment] = await transaction
      .update(vpsAgentEnrollments)
      .set({ usedAt: now, updatedAt: now })
      .where(and(
        eq(vpsAgentEnrollments.codeDigest, hashAgentEnrollmentCode(code)),
        isNull(vpsAgentEnrollments.usedAt),
        gt(vpsAgentEnrollments.expiresAt, now),
      ))
      .returning({
        workspaceId: vpsAgentEnrollments.workspaceId,
        endpoint: vpsAgentEnrollments.endpoint,
      });
    if (!enrollment) return null;

    const credentials = issueAgentCredentials();
    await transaction
      .insert(integrations)
      .values({
        workspaceId: enrollment.workspaceId,
        kind: "vps_agent",
        label: "Agent VPS · authentifié",
        encryptedCredentials: credentials.tokenDigest,
        configuration: {
          agentId: credentials.agentId,
          endpoint: enrollment.endpoint,
          enrolledAt: now.toISOString(),
          authentication: "sha256_bearer",
        },
      })
      .onConflictDoUpdate({
        target: [integrations.workspaceId, integrations.kind],
        set: {
          label: "Agent VPS · authentifié",
          encryptedCredentials: credentials.tokenDigest,
          configuration: {
            agentId: credentials.agentId,
            endpoint: enrollment.endpoint,
            enrolledAt: now.toISOString(),
            authentication: "sha256_bearer",
          },
          enabled: true,
          lastSyncedAt: null,
          updatedAt: now,
        },
      });

    return {
      agentId: credentials.agentId,
      token: credentials.token,
      endpoint: enrollment.endpoint,
    };
  });

  if (!result) {
    return NextResponse.json({ error: "Code d’enrôlement invalide ou expiré." }, { status: 401 });
  }

  return NextResponse.json(result, {
    status: 201,
    headers: { "Cache-Control": "no-store" },
  });
}
