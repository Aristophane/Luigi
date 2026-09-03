"use server";

import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { vpsAgentEnrollments } from "@/db/schema";
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
