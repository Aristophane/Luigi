import test from "node:test";
import assert from "node:assert/strict";
import { deploymentSyncTargets, readProviderDeployment, targetMatchesApplication } from "@/lib/deployment-providers";

const now = new Date("2026-10-28T12:00:00Z");
const application = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", publicUrl: "https://app.example.com/", githubRepository: "acme/app",
  githubBranch: "main", environment: "production" as const };
const sha = "a".repeat(40), oldSha = "b".repeat(40);
const env = { NODE_ENV: "test" as const, COOLIFY_API_URL: "https://coolify.example.com", COOLIFY_DEPLOYMENT_READ_TOKEN: "test-secret", NETLIFY_DEPLOYMENT_TOKEN: "test-secret",
  RAILWAY_PROJECT_TOKEN: "test-secret" };
const coolifyTarget = { provider: "coolify" as const, applicationId: application.id, resourceId: "resource" };
const netlifyTarget = { provider: "netlify" as const, applicationId: application.id, siteId: "site" };

test("deployment target configuration rejects malformed and duplicate targets and keeps path identity", () => {
  assert.deepEqual(deploymentSyncTargets(""), []);
  assert.throws(() => deploymentSyncTargets("secret-not-json"), /valid JSON/);
  assert.throws(() => deploymentSyncTargets('[{"provider":"coolify","resourceId":"resource"}]'), /Invalid/);
  assert.throws(() => deploymentSyncTargets(JSON.stringify([coolifyTarget, coolifyTarget])), /Duplicate/);
  assert.equal(targetMatchesApplication({ ...coolifyTarget, applicationUrl: "https://app.example.com/admin" }, application), false);
  assert.equal(targetMatchesApplication({ ...coolifyTarget, applicationUrl: "https://app.example.com/?query=1" }, application), true);
});

test("Coolify confirms a matching running repository using successful non-preview deployments", async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input); requests.push(url);
    if (url.endsWith("/applications/resource")) return Response.json({ uuid: "resource", git_repository: "https://github.com/acme/app.git", git_branch: "main", status: "running:healthy" });
    return Response.json({ count: 5, deployments: [
      { status: "failed", commit: oldSha },
      { status: "finished", deployment_uuid: "preview", commit: oldSha, pull_request_id: 3, finished_at: "2026-10-28T11:00:00Z" },
      { status: "finished", deployment_uuid: "restart", commit: oldSha, restart_only: true, finished_at: "2026-10-28T10:00:00Z" },
      { status: "finished", deployment_uuid: "new", commit: sha, finished_at: "2026-10-27T12:00:00Z", deployment_url: "/deployment/new" },
      { status: "finished", deployment_uuid: "old", commit: oldSha, finished_at: "2026-10-25T12:00:00Z", deployment_url: "/deployment/old" },
    ] });
  };
  const result = await readProviderDeployment(coolifyTarget, application, { env, now, fetch: fetcher });
  assert.equal(result.commitSha, sha);
  assert.equal(result.deploymentId, "new");
  assert.equal(result.verification.observedAt, now.toISOString());
  assert.equal(result.deployedAt, "2026-10-27T12:00:00.000Z");
  assert.equal(result.sourceUrl, "https://coolify.example.com/deployment/new");
  assert.equal(requests.length, 2);
});

test("Coolify rejects another repository, branch, stopped resource and unsafe API origins", async () => {
  for (const overrides of [{ git_repository: "acme/other" }, { git_branch: "staging" }, { git_branch: null }, { status: "exited:unhealthy" }]) {
    await assert.rejects(readProviderDeployment(coolifyTarget, application, { env, now, fetch: async () => Response.json({ uuid: "resource", git_repository: "acme/app", git_branch: "main", status: "running:healthy", ...overrides }) }));
  }
  await assert.rejects(readProviderDeployment(coolifyTarget, application, { env: { ...env, COOLIFY_API_URL: "http://example.com" }, now }), /HTTPS origin/);
});

test("Netlify uses published production deployment, including an old version republished now", async () => {
  const site = { id: "site", name: "my-site", custom_domain: "app.example.com", build_settings: { repo_url: "https://github.com/acme/app" },
    published_deploy: { id: "published", site_id: "site", state: "ready", context: "production", commit_ref: oldSha, branch: "main", published_at: "2026-10-28T11:00:00Z" } };
  const result = await readProviderDeployment(netlifyTarget, application, { env, now, fetch: async () => Response.json(site) });
  assert.equal(result.commitSha, oldSha);
  assert.equal(result.deployedAt, "2026-10-28T11:00:00.000Z");
  for (const modified of [{ ...site, custom_domain: "other.example.com" }, { ...site, published_deploy: { ...site.published_deploy, context: "deploy-preview" } },
    { ...site, published_deploy: { ...site.published_deploy, branch: "staging" } },
    { ...site, published_deploy: { ...site.published_deploy, branch: null } }, { ...site, build_settings: {} }]) {
    await assert.rejects(readProviderDeployment(netlifyTarget, application, { env, now, fetch: async () => Response.json(modified) }));
  }
});

test("Railway validates project/environment/service, active state and repository", async () => {
  const target = { provider: "railway" as const, applicationId: application.id, projectId: "project", environmentId: "environment", serviceId: "service", tokenVariable: "RAILWAY_PROJECT_TOKEN" };
  const deployed = { id: "deployment", status: "SUCCESS", deploymentStopped: false, projectId: "project", environmentId: "environment", serviceId: "service",
    createdAt: "2026-10-27T10:00:00Z", statusUpdatedAt: "2026-10-27T10:02:00Z", meta: { repo: "acme/app", branch: "main", commitHash: sha } };
  const resultFor = (node: unknown) => readProviderDeployment(target, application, { env, now,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.variables.input.environmentId, "environment");
      return Response.json({ data: { deployments: { edges: [{ node }] } } });
    } });
  assert.equal((await resultFor(deployed)).commitSha, sha);
  await assert.rejects(resultFor({ ...deployed, deploymentStopped: true }), /No active/);
  await assert.rejects(resultFor({ ...deployed, environmentId: "preview" }), /scope/);
  await assert.rejects(resultFor({ ...deployed, meta: { repo: "acme/other", commitHash: sha } }), /repository/);
  await assert.rejects(resultFor({ ...deployed, meta: { repo: "acme/app", commitHash: sha } }), /branch is missing/);
  await assert.rejects(readProviderDeployment(target, application, { env, now, fetch: async () => Response.json({ errors: [{ message: "private details" }] }) }), /GraphQL request failed/);
  await assert.rejects(readProviderDeployment(target, application, { env, now, fetch: async () => Response.json({ errors: [{ message: "Not Authorized" }] }) }), /access denied: check project token/);
});

test("provider errors expose status without response bodies or tokens", async () => {
  await assert.rejects(readProviderDeployment(netlifyTarget, application, { env, now,
    fetch: async () => new Response("secret-token-in-body", { status: 401 }) }), (error: unknown) => {
    assert.equal((error as Error).message, "Netlify HTTP 401");
    return true;
  });
  await assert.rejects(readProviderDeployment(netlifyTarget, application, { env, now,
    fetch: async () => new Response("secret-token-in-invalid-json", { status: 200 }) }), (error: unknown) => {
    assert.equal((error as Error).message, "Netlify returned invalid JSON");
    return true;
  });
});
