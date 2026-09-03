import { GitHubApiError, listGitHubRepositories } from "@/lib/github";
import { getGitHubToken } from "@/lib/github-integration";
import { requireWorkspace } from "@/lib/dal";

const noStoreHeaders = { "Cache-Control": "private, no-store" };

export async function GET() {
  const { workspaceId } = await requireWorkspace();

  try {
    const token = await getGitHubToken(workspaceId);
    if (!token) {
      return Response.json(
        { message: "Connecte GitHub pour détecter les dépôts accessibles." },
        { status: 409, headers: noStoreHeaders },
      );
    }

    const repositories = await listGitHubRepositories(token);
    return Response.json({ repositories }, { headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof GitHubApiError && (error.status === 401 || error.status === 403)) {
      return Response.json(
        { message: "GitHub refuse l’accès à la liste des dépôts. Vérifie le jeton et ses permissions." },
        { status: 502, headers: noStoreHeaders },
      );
    }

    console.error("[GitHub] Impossible de charger les dépôts accessibles", {
      name: error instanceof Error ? error.name : "UnknownError",
      message: error instanceof Error ? error.message : "Erreur inconnue",
    });
    return Response.json(
      { message: "La liste des dépôts est momentanément indisponible. La saisie manuelle reste possible." },
      { status: 502, headers: noStoreHeaders },
    );
  }
}
