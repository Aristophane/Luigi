import test from "node:test";
import assert from "node:assert/strict";
import { GitHubApiError } from "@/lib/github";
import { gitHubTokenFailure, readGitHubTokenHealth, repositoryDeploymentMatch } from "@/lib/github-token-health";

const now = new Date("2026-10-12T12:00:00Z");

test("expired/revoked tokens are distinguished from permissions, rate limits and network failures", () => {
  assert.equal(gitHubTokenFailure(new GitHubApiError("Bad credentials", 401)), "invalid");
  assert.equal(gitHubTokenFailure(new GitHubApiError("Resource not accessible", 403)), "forbidden");
  assert.equal(gitHubTokenFailure(new GitHubApiError("API rate limit exceeded", 403)), "unavailable");
  assert.equal(gitHubTokenFailure(new GitHubApiError("Unavailable", 503)), "unavailable");
  assert.equal(gitHubTokenFailure(new DOMException("Timeout", "TimeoutError")), "unavailable");
  assert.equal(gitHubTokenFailure(new TypeError("fetch failed")), "unavailable");
  assert.equal(gitHubTokenFailure(new GitHubApiError("Repository not found", 404)), undefined);
  assert.equal(gitHubTokenFailure(new Error("TOO_MANY_MANIFESTS")), undefined);
});

test("legacy and stale token checks never claim a verified connection", () => {
  assert.deepEqual(readGitHubTokenHealth({ login: "test" }, now), { status: "unknown" });
  assert.equal(readGitHubTokenHealth({ githubTokenHealth: { status: "valid", checkedAt: "2026-10-12T11:00:00Z" } }, now).status, "valid");
  assert.equal(readGitHubTokenHealth({ githubTokenHealth: { status: "valid", checkedAt: "2026-10-10T11:00:00Z" } }, now).status, "unknown");
  assert.equal(readGitHubTokenHealth({ githubTokenHealth: { status: "valid", checkedAt: "not-a-date" } }, now).status, "unknown");
  assert.equal(readGitHubTokenHealth({ githubTokenHealth: { status: "invalid", checkedAt: "2026-10-03T11:00:00Z" } }, now).status, "invalid");
});

test("old repository snapshots cannot claim that a newer deployment is behind", () => {
  const deployedAt = new Date("2026-10-12T11:20:00Z");
  assert.equal(repositoryDeploymentMatch("38630ac", new Date("2026-10-03T00:38:00Z"), "1b9a14a", deployedAt, undefined, now), null);
  assert.equal(repositoryDeploymentMatch("1b9a14abcdef", now, "1B9A14A", deployedAt, { status: "valid" }, now), true);
  assert.equal(repositoryDeploymentMatch("38630ac", now, "1b9a14a", deployedAt, { status: "invalid" }, now), null);
  assert.equal(repositoryDeploymentMatch("38630ac", now, "1b9a14a", deployedAt, { status: "valid" }, now), false);
  assert.equal(repositoryDeploymentMatch("38630ac", new Date("2026-10-10T11:20:00Z"), "1b9a14a", new Date("2026-10-09T11:20:00Z"), undefined, now), null);
});
