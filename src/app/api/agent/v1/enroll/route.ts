import { and, eq, gt, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { agents, servers, monitoringHeartbeats, vpsAgentEnrollments } from "@/db/schema";
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
    const [server] = await transaction.insert(servers).values({ workspaceId: enrollment.workspaceId, label: "Nouveau serveur" }).returning();
    await transaction.insert(agents).values({
      id: credentials.agentId, serverId: server.id, tokenDigest: credentials.tokenDigest,
      configuration: { endpoint: enrollment.endpoint, enrolledAt: now.toISOString() },
    });
    await transaction.insert(monitoringHeartbeats).values({ workspaceId: enrollment.workspaceId,
      source: 'vps_agent:' + server.id, intervalSeconds: 300, lastSeenAt: now });

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
