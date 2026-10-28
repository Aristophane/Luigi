import { z } from "zod";

const identity = { applicationId: z.string().uuid().optional(), applicationUrl: z.string().url().optional() };
const targetSchema = z.discriminatedUnion("provider", [
  z.object({ ...identity, provider: z.literal("coolify"), resourceId: z.string().min(1).max(100) }),
  z.object({ ...identity, provider: z.literal("netlify"), siteId: z.string().min(1).max(200) }),
  z.object({ ...identity, provider: z.literal("railway"), projectId: z.string().uuid(), environmentId: z.string().uuid(),
    serviceId: z.string().uuid(), tokenVariable: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default("RAILWAY_PROJECT_TOKEN") }),
]).refine((target) => Boolean(target.applicationId || target.applicationUrl), "Application identity is required");

export type DeploymentSyncTarget = z.infer<typeof targetSchema>;
export type DeploymentApplication = { id: string; publicUrl: string; githubRepository: string; githubBranch: string;
  environment: "production" | "staging" | "development" };
export type ProviderDeployment = { deploymentId: string; commitSha: string; source: "coolify" | "netlify" | "railway";
  sourceUrl: string; deployedAt: string; branch?: string;
  verification: { provider: "coolify" | "netlify" | "railway"; observedAt: string } };
type JsonObject = Record<string, unknown>;
type ProviderOptions = { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: Date };

export function deploymentSyncTargets(raw = process.env.DEPLOYMENT_SYNC_TARGETS): DeploymentSyncTarget[] {
  if (!raw?.trim()) return [];
  let input: unknown;
  try { input = JSON.parse(raw); } catch { throw new Error("DEPLOYMENT_SYNC_TARGETS must contain valid JSON"); }
  const parsed = z.array(targetSchema).max(100).safeParse(input);
  if (!parsed.success) throw new Error("Invalid DEPLOYMENT_SYNC_TARGETS configuration");
  const seen = new Set<string>();
  for (const target of parsed.data) {
    const key = target.applicationId ?? normalizeDeploymentUrl(target.applicationUrl!);
    if (seen.has(key)) throw new Error("Duplicate application in DEPLOYMENT_SYNC_TARGETS");
    seen.add(key);
  }
  return parsed.data;
}

export function normalizeDeploymentUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString();
}

export function targetMatchesApplication(target: DeploymentSyncTarget, application: DeploymentApplication) {
  return (!target.applicationId || target.applicationId === application.id)
    && (!target.applicationUrl || normalizeDeploymentUrl(target.applicationUrl) === normalizeDeploymentUrl(application.publicUrl));
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid provider response");
  return value as JsonObject;
}

function repository(value: unknown) {
  return String(value ?? "").trim().replace(/^https?:\/\/github.com\//i, "").replace(/^git@github.com:/i, "")
    .replace(/\.git$/i, "").replace(/\/$/, "").toLowerCase();
}

function timestamp(value: unknown, now: Date) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < Date.UTC(2000, 0, 1) || parsed > now.getTime() + 300_000) {
    throw new Error("Invalid provider deployment date");
  }
  return new Date(parsed).toISOString();
}

function commit(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/i.test(value)) throw new Error("Unverified provider Git commit");
  return value.toLowerCase();
}

function verifyBranch(value: unknown, application: DeploymentApplication) {
  if (typeof value !== "string" || !value) throw new Error("Provider deployment branch is missing");
  if (value !== application.githubBranch) throw new Error("Provider branch does not match monitored branch");
  return value;
}

function requiredSecret(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function requestJson(url: string, init: RequestInit, fetcher: typeof fetch, provider: string) {
  const response = await fetcher(url, { ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000) });
  // Never include response bodies, which can contain tokens or provider configuration.
  if (!response.ok) throw new Error(`${provider} HTTP ${response.status}`);
  try { return await response.json() as unknown; }
  catch { throw new Error(`${provider} returned invalid JSON`); }
}

export async function readProviderDeployment(target: DeploymentSyncTarget, application: DeploymentApplication,
  options: ProviderOptions = {}): Promise<ProviderDeployment> {
  const env = options.env ?? process.env, fetcher = options.fetch ?? fetch, now = options.now ?? new Date();
  if (!targetMatchesApplication(target, application)) throw new Error("Deployment target identity mismatch");
  // Timestamp the completed provider observation, not the start of network I/O.
  const verification = () => ({ provider: target.provider, observedAt: (options.now ?? new Date()).toISOString() });

  if (target.provider === "coolify") {
    const base = new URL(requiredSecret(env, "COOLIFY_API_URL"));
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
      throw new Error("COOLIFY_API_URL must be an HTTPS origin");
    }
    const headers = { Authorization: `Bearer ${requiredSecret(env, "COOLIFY_DEPLOYMENT_READ_TOKEN")}` };
    const get = (path: string) => requestJson(`${base.origin}/api/v1${path}`, { headers }, fetcher, "Coolify");
    const resource = object(await get(`/applications/${encodeURIComponent(target.resourceId)}`));
    if (resource.uuid !== target.resourceId || repository(resource.git_repository) !== repository(application.githubRepository)) {
      throw new Error("Coolify resource does not match monitored repository");
    }
    const branch = verifyBranch(resource.git_branch, application);
    if (typeof resource.status !== "string" || !resource.status.startsWith("running:")) throw new Error("Coolify application is not running");
    let latest: JsonObject | undefined;
    let complete = false;
    for (let skip = 0; skip < 1_000; skip += 100) {
      const page = object(await get(`/deployments/applications/${encodeURIComponent(target.resourceId)}?take=100&skip=${skip}`));
      if (!Array.isArray(page.deployments)) throw new Error("Invalid Coolify deployment list");
      for (const item of page.deployments) {
        const row = object(item);
        if (row.status !== "finished" || Number(row.pull_request_id ?? 0) !== 0 || row.restart_only) continue;
        const at = timestamp(row.finished_at, now);
        if (!latest || at > timestamp(latest.finished_at, now)) latest = row;
      }
      if (page.deployments.length < 100 || (typeof page.count === "number" && skip + page.deployments.length >= page.count)) {
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error("Coolify deployment history exceeds verification limit");
    if (!latest) throw new Error("No successful Coolify production deployment");
    if (typeof latest.deployment_uuid !== "string") throw new Error("Missing Coolify deployment identity");
    const sourceUrl = new URL(String(latest.deployment_url ?? "/"), base);
    if (sourceUrl.origin !== base.origin) throw new Error("Unexpected Coolify deployment URL");
    return { deploymentId: latest.deployment_uuid, commitSha: commit(latest.commit), source: "coolify", sourceUrl: sourceUrl.href,
      deployedAt: timestamp(latest.finished_at, now), branch, verification: verification() };
  }

  if (target.provider === "netlify") {
    if (application.environment !== "production") throw new Error("Netlify published deployments require a production application");
    const site = object(await requestJson(`https://api.netlify.com/api/v1/sites/${encodeURIComponent(target.siteId)}`,
      { headers: { Authorization: `Bearer ${requiredSecret(env, "NETLIFY_DEPLOYMENT_TOKEN")}` } }, fetcher, "Netlify"));
    const host = new URL(application.publicUrl).hostname.toLowerCase();
    const hosts = [site.custom_domain, ...(Array.isArray(site.domain_aliases) ? site.domain_aliases : [])]
      .filter((value): value is string => typeof value === "string").map((value) => value.toLowerCase());
    if (typeof site.ssl_url === "string") hosts.push(new URL(site.ssl_url).hostname.toLowerCase());
    if (!hosts.includes(host)) throw new Error("Netlify site does not match monitored domain");
    const deployed = object(site.published_deploy);
    if (typeof site.id !== "string" || !site.id || deployed.state !== "ready" || deployed.context !== "production" || deployed.site_id !== site.id) {
      throw new Error("Netlify deployment is not the published production deployment");
    }
    const settings = site.build_settings ? object(site.build_settings) : {};
    const repo = settings.repo_url ?? settings.repo_path;
    if (repository(repo) !== repository(application.githubRepository)) throw new Error("Netlify repository mismatch");
    if (typeof deployed.id !== "string" || typeof site.name !== "string") throw new Error("Missing Netlify deployment identity");
    const publishedAt = timestamp(deployed.published_at, now);
    // Re-publishing a previous deploy is a new production activation, with the same native ID.
    return { deploymentId: `${deployed.id}:${publishedAt}`, commitSha: commit(deployed.commit_ref), source: "netlify",
      sourceUrl: `https://app.netlify.com/projects/${encodeURIComponent(site.name)}/deploys/${encodeURIComponent(deployed.id)}`,
      deployedAt: publishedAt, branch: verifyBranch(deployed.branch, application), verification: verification() };
  }

  if (application.environment !== "production") throw new Error("Railway target must identify a production application");
  const query = `query LuigiDeployments($input: DeploymentListInput!) {
    deployments(first: 5, input: $input) { edges { node {
      id status statusUpdatedAt createdAt projectId environmentId serviceId deploymentStopped meta
    } } }
  }`;
  const result = object(await requestJson("https://backboard.railway.com/graphql/v2", {
    method: "POST", headers: { "Content-Type": "application/json", "Project-Access-Token": requiredSecret(env, target.tokenVariable) },
    body: JSON.stringify({ query, variables: { input: { projectId: target.projectId, environmentId: target.environmentId,
      serviceId: target.serviceId, status: { in: ["SUCCESS"] } } } }),
  }, fetcher, "Railway"));
  if (Array.isArray(result.errors) && result.errors.length) {
    const accessDenied = result.errors.some((error) => error && typeof error === "object"
      && /not authorized|unauthorized|unauthenticated|forbidden|project token not found/i.test(String((error as JsonObject).message ?? "")));
    throw new Error(accessDenied ? "Railway access denied: check project token and target scope" : "Railway GraphQL request failed");
  }
  const edges = object(object(result.data).deployments).edges;
  if (!Array.isArray(edges)) throw new Error("Invalid Railway deployment list");
  const active = edges.map((edge) => object(object(edge).node)).filter((row) => row.status === "SUCCESS" && row.deploymentStopped === false);
  // During deployment overlap more than one SUCCESS may remain. The API sorts newest first.
  const deployed = active[0];
  if (!deployed) throw new Error("No active successful Railway deployment");
  if (deployed.projectId !== target.projectId || deployed.environmentId !== target.environmentId || deployed.serviceId !== target.serviceId) {
    throw new Error("Railway deployment scope mismatch");
  }
  const meta = object(deployed.meta);
  if (repository(meta.repo) !== repository(application.githubRepository)) throw new Error("Railway repository mismatch");
  if (typeof deployed.id !== "string") throw new Error("Missing Railway deployment identity");
  const at = timestamp(deployed.statusUpdatedAt, now);
  if (at < timestamp(deployed.createdAt, now)) throw new Error("Invalid Railway deployment chronology");
  return { deploymentId: deployed.id, commitSha: commit(meta.commitHash), source: "railway",
    sourceUrl: `https://railway.com/project/${target.projectId}/service/${target.serviceId}?environmentId=${target.environmentId}&id=${encodeURIComponent(deployed.id)}`,
    deployedAt: at, branch: verifyBranch(meta.branch, application), verification: verification() };
}
