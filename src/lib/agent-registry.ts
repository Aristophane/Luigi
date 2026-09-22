import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, servers } from "@/db/schema";
import { hashAgentToken } from "@/lib/agent-auth";

export async function authenticateAgent(request: Request) {
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith("luigi_vps_") || token.length > 256) return null;
  const [agent] = await db.select({ id: agents.id, serverId: servers.id, workspaceId: servers.workspaceId,
    configuration: agents.configuration, intervalSeconds: agents.intervalSeconds })
    .from(agents).innerJoin(servers, eq(servers.id, agents.serverId))
    .where(and(eq(agents.enabled, true), eq(agents.tokenDigest, hashAgentToken(token)))).limit(1);
  return agent ?? null;
}
