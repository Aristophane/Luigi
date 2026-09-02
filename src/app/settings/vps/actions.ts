"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { integrations } from "@/db/schema";
import { issueAgentCredentials } from "@/lib/agent-auth";
import { requireWorkspace } from "@/lib/dal";

export type VpsAgentActionState = {
  status: "idle" | "success" | "error";
  message: string;
  token?: string;
  agentId?: string;
  endpoint?: string;
};

const endpointSchema = z.string().trim().url().max(500);

export async function issueVpsAgentToken(
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
  const credentials = issueAgentCredentials();
  const issuedAt = new Date();
  const endpoint = endpointUrl.toString();

  await db
    .insert(integrations)
    .values({
      workspaceId,
      kind: "vps_agent",
      label: "Agent VPS · en attente",
      encryptedCredentials: credentials.tokenDigest,
      configuration: {
        agentId: credentials.agentId,
        endpoint,
        issuedAt: issuedAt.toISOString(),
        authentication: "sha256_bearer",
      },
    })
    .onConflictDoUpdate({
      target: [integrations.workspaceId, integrations.kind],
      set: {
        label: "Agent VPS · en attente",
        encryptedCredentials: credentials.tokenDigest,
        configuration: {
          agentId: credentials.agentId,
          endpoint,
          issuedAt: issuedAt.toISOString(),
          authentication: "sha256_bearer",
        },
        enabled: true,
        lastSyncedAt: null,
        updatedAt: issuedAt,
      },
    });

  revalidatePath("/settings/vps");
  revalidatePath("/");
  return {
    status: "success",
    message: "Jeton créé. Il ne sera plus affiché après avoir quitté cette page.",
    token: credentials.token,
    agentId: credentials.agentId,
    endpoint,
  };
}
