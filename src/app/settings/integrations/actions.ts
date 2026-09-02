"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { integrations } from "@/db/schema";
import { requireWorkspace } from "@/lib/dal";
import { GitHubApiError, verifyGitHubToken } from "@/lib/github";
import { encryptSecret } from "@/lib/secret-box";

export type IntegrationActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

const tokenSchema = z.string().trim().min(20, "Le jeton GitHub semble incomplet.").max(512);

export async function connectGitHub(
  _previousState: IntegrationActionState,
  formData: FormData,
): Promise<IntegrationActionState> {
  const { workspaceId } = await requireWorkspace();
  const parsed = tokenSchema.safeParse(formData.get("token"));
  if (!parsed.success) {
    return { status: "error", message: parsed.error.issues[0]?.message ?? "Jeton invalide." };
  }

  try {
    const githubUser = await verifyGitHubToken(parsed.data);
    const encryptedCredentials = encryptSecret(parsed.data);
    await db
      .insert(integrations)
      .values({
        workspaceId,
        kind: "github",
        label: `GitHub · ${githubUser.login}`,
        encryptedCredentials,
        configuration: { login: githubUser.login, authentication: "fine_grained_pat" },
        lastSyncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [integrations.workspaceId, integrations.kind],
        set: {
          label: `GitHub · ${githubUser.login}`,
          encryptedCredentials,
          configuration: { login: githubUser.login, authentication: "fine_grained_pat" },
          enabled: true,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 401 || error.status === 403)) {
      return { status: "error", message: "GitHub a refusé ce jeton. Vérifie sa validité et ses permissions." };
    }

    if (error instanceof Error && error.message.includes("INTEGRATION_ENCRYPTION_KEY")) {
      console.error("[GitHub] La clé de chiffrement des intégrations n'est pas chargée.");
      return {
        status: "error",
        message: "La configuration de chiffrement n’est pas chargée. Redémarre Luigi puis réessaie.",
      };
    }

    if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) {
      console.error("[GitHub] L'API GitHub est momentanément injoignable.");
      return {
        status: "error",
        message: "Impossible de joindre GitHub. Vérifie la connexion réseau puis réessaie.",
      };
    }

    console.error("[GitHub] Échec de connexion de l’intégration", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Erreur inconnue",
    });
    return { status: "error", message: "Impossible de vérifier GitHub pour le moment." };
  }

  revalidatePath("/settings/integrations");
  revalidatePath("/");
  return { status: "success", message: "GitHub est connecté en lecture seule." };
}
