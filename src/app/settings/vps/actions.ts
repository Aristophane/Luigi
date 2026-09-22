"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { applications, checks, servers, vpsAgentEnrollments } from "@/db/schema";
import { issueAgentEnrollmentCode } from "@/lib/agent-auth";
import { requireWorkspace } from "@/lib/dal";

export type VpsAgentActionState = {
  status: "idle" | "success" | "error";
  message: string;
  installCommand?: string;
  fallbackCommand?: string;
  installUrl?: string;
  issuedAt?: string;
  expiresAt?: string;
  endpoint?: string;
};

const endpointSchema = z.string().trim().url().max(500);

export async function saveEssentialService(_state: { message: string }, formData: FormData) {
  const { workspaceId } = await requireWorkspace();
  const parsed = z.object({ serverId: z.uuid(), serviceKey: z.string().min(1).max(160),
    applicationId: z.union([z.uuid(), z.literal("")]) }).safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { message: "Sélection invalide." };
  const input = parsed.data;
  await db.transaction(async (tx) => {
    const [server] = await tx.select().from(servers).where(and(eq(servers.id, input.serverId), eq(servers.workspaceId, workspaceId))).for("update");
    if (!server) throw new Error("SERVER_NOT_FOUND");
    if (input.applicationId) {
      const [app] = await tx.select().from(applications).where(and(eq(applications.id, input.applicationId), eq(applications.workspaceId, workspaceId), isNull(applications.archivedAt)));
      if (!app) throw new Error("APPLICATION_NOT_FOUND");
    }
    const existing = await tx.update(checks).set({ enabled: false }).where(and(eq(checks.serverId, server.id), eq(checks.serviceKey, input.serviceKey))).returning();
    if (input.applicationId) {
      const check = existing.find((check) => check.applicationId === input.applicationId);
      if (check) await tx.update(checks).set({ enabled: true, essential: true }).where(eq(checks.id, check.id));
      else await tx.insert(checks).values({ applicationId: input.applicationId, serverId: server.id, serviceKey: input.serviceKey,
        target: input.serviceKey, kind: "heartbeat", intervalSeconds: 300, essential: true });
    }
  });
  revalidatePath("/settings/vps");
  revalidatePath("/");
  return { message: "Lien enregistré. L’état sera confirmé au prochain rapport." };
}

export async function issueVpsAgentEnrollment(
  _previousState: VpsAgentActionState,
  formData: FormData,
): Promise<VpsAgentActionState> {
  void _previousState;
  const { workspaceId } = await requireWorkspace();
  const parsedEndpoint = endpointSchema.safeParse(formData.get("endpoint"));
  if (!parsedEndpoint.success) {
    return { status: "error", message: "Indique une URL HTTP(S) complète et accessible depuis le VPS." };
  }
  const endpointUrl = new URL(parsedEndpoint.data);
  if (!(["http:", "https:"] as string[]).includes(endpointUrl.protocol) || endpointUrl.username || endpointUrl.password) {
    return { status: "error", message: "L’endpoint doit utiliser HTTP(S) et ne contenir aucun identifiant." };
  }
  endpointUrl.pathname = "/api/agent/v1/report";
  endpointUrl.search = "";
  endpointUrl.hash = "";
  const endpoint = endpointUrl.toString();
  const baseUrl = endpointUrl.origin;
  const installUrl = new URL("/install/vps", baseUrl).toString();
  const insecureFlag = endpointUrl.protocol === "http:" ? " --allow-insecure-http" : "";
  const enrollment = issueAgentEnrollmentCode();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 10 * 60 * 1000);

  await db
    .update(vpsAgentEnrollments)
    .set({ usedAt: issuedAt, updatedAt: issuedAt })
    .where(and(
      eq(vpsAgentEnrollments.workspaceId, workspaceId),
      isNull(vpsAgentEnrollments.usedAt),
    ));
  await db.insert(vpsAgentEnrollments).values({
    workspaceId,
    codeDigest: enrollment.codeDigest,
    endpoint,
    expiresAt,
  });

  revalidatePath("/settings/vps");
  return {
    status: "success",
    message: "Commande prête. Le code est valable dix minutes et ne fonctionne qu’une fois.",
    installCommand: `curl -fsSL ${JSON.stringify(installUrl)} | sudo bash -s -- --server ${JSON.stringify(baseUrl)} --code ${JSON.stringify(enrollment.code)}${insecureFlag}`,
    fallbackCommand: `wget -qO- ${JSON.stringify(installUrl)} | sudo bash -s -- --server ${JSON.stringify(baseUrl)} --code ${JSON.stringify(enrollment.code)}${insecureFlag}`,
    installUrl,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    endpoint,
  };
}
