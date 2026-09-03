const GITHUB_API = "https://api.github.com";
const GITHUB_API_VERSION = "2026-03-10";

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

type GitHubUser = { login: string };
type GitHubRepository = {
  name: string;
  default_branch: string;
  full_name: string;
  private: boolean;
  archived: boolean;
  html_url: string;
};
type GitHubBranch = { commit: { sha: string } };
type GitHubContentEntry = {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  size: number;
};

async function githubRequest<T>(path: string, token?: string, accept = "application/vnd.github+json") {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Accept: accept,
      "User-Agent": "Luigi-Monitoring",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    let apiMessage = "";
    try {
      const body = await response.json() as { message?: string };
      apiMessage = body.message ?? "";
    } catch {
      // La réponse GitHub peut être vide ; le statut reste la source fiable.
    }
    throw new GitHubApiError(apiMessage || `GitHub a répondu ${response.status}.`, response.status);
  }

  if (accept.includes("raw")) return await response.text() as T;
  return await response.json() as T;
}

function repositoryPath(repository: string) {
  const [owner, name] = repository.split("/");
  if (!owner || !name) throw new Error("Le dépôt GitHub doit utiliser le format organisation/depot.");
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name.replace(/\.git$/i, ""))}`;
}

export async function verifyGitHubToken(token: string) {
  return githubRequest<GitHubUser>("/user", token);
}

export async function listGitHubRepositories(token: string) {
  const repositories: GitHubRepository[] = [];
  const perPage = 100;

  for (let page = 1; page <= 10; page += 1) {
    const parameters = new URLSearchParams({
      visibility: "all",
      affiliation: "owner,collaborator,organization_member",
      sort: "pushed",
      direction: "desc",
      per_page: String(perPage),
      page: String(page),
    });
    const result = await githubRequest<GitHubRepository[]>(`/user/repos?${parameters}`, token);
    repositories.push(...result);

    if (result.length < perPage) break;
  }

  return repositories.map((repository) => ({
    name: repository.name,
    fullName: repository.full_name,
    defaultBranch: repository.default_branch,
    private: repository.private,
    archived: repository.archived,
  }));
}

export async function getGitHubRepository(repository: string, token?: string) {
  return githubRequest<GitHubRepository>(`/repos/${repositoryPath(repository)}`, token);
}

export async function inspectGitHubRepository(repository: string, branch: string, token?: string) {
  const path = repositoryPath(repository);
  const [metadata, branchDetails, rootContents] = await Promise.all([
    githubRequest<GitHubRepository>(`/repos/${path}`, token),
    githubRequest<GitHubBranch>(`/repos/${path}/branches/${encodeURIComponent(branch)}`, token),
    githubRequest<GitHubContentEntry[]>(`/repos/${path}/contents?ref=${encodeURIComponent(branch)}`, token),
  ]);

  return {
    metadata,
    commitSha: branchDetails.commit.sha,
    rootContents: rootContents.filter((entry) => entry.type === "file" && entry.size <= 1_000_000),
  };
}

export async function getGitHubFile(repository: string, path: string, branch: string, token?: string) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return githubRequest<string>(
    `/repos/${repositoryPath(repository)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
    token,
    "application/vnd.github.raw+json",
  );
}
