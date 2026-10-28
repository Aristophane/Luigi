import test from "node:test";
import assert from "node:assert/strict";
import { dependencyCategory, deploymentReleasePresentation, repositoryScanState, sameHttpCheckConfiguration, shortDeploymentCommit } from "@/lib/application-status";

const now = new Date("2026-10-28T12:00:00Z");

test("a confirmed deployment with no commit keeps its provider proof without claiming a Git comparison", () => {
  const deployment = { commitSha: null, confirmationState: "confirmed" as const, matchesRepositoryHead: null };
  assert.equal(shortDeploymentCommit(null), "Non communiqué");
  assert.equal(shortDeploymentCommit("abcdef123456789"), "abcdef1");
  assert.deepEqual(deploymentReleasePresentation(deployment, "Production"), {
    state: "unknown", label: "Déploiement confirmé · commit non communiqué",
  });
  assert.equal(deploymentReleasePresentation({ ...deployment, matchesRepositoryHead: true }, "Production").state, "unknown");
  assert.equal(deploymentReleasePresentation({ ...deployment, confirmationState: "stale" }, "Production").label, "Confirmation du déploiement périmée");
  assert.equal(deploymentReleasePresentation({ ...deployment, commitSha: "abcdef123456789", matchesRepositoryHead: true }, "Production").state, "synced");
});

test("runtime libraries remain distinct from development and migration tooling", () => {
  assert.equal(dependencyCategory({ name: "@vendure/core", development: false }), "runtime");
  assert.equal(dependencyCategory({ name: "@vendure/migrate", development: false }), "tooling");
  assert.equal(dependencyCategory({ name: "typescript", development: true }), "tooling");
  assert.equal(dependencyCategory({ name: "vitest", development: true }), "development");
  assert.equal(dependencyCategory({ name: "@types/node", development: false }), "development");
  assert.equal(dependencyCategory({ name: "typeorm", development: false }), "runtime");
  assert.equal(dependencyCategory({ name: "express", development: false, manifestPath: "Migration/DataRetrieval/package.json" }), "tooling");
  assert.equal(dependencyCategory({ name: "react", development: false, manifestPath: "tools/importer/package.json" }), "tooling");
  assert.equal(dependencyCategory({ name: "react", development: false, manifestPath: "tests/fixture/package.json" }), "development");
  assert.equal(dependencyCategory({ name: "react", development: false, manifestPath: "apps/storefront/package.json" }), "runtime");
});

test("a failed or stale scan cannot present its historical results as current", () => {
  const old = new Date(now.getTime() - 26 * 3600_000);
  assert.deepEqual(repositoryScanState(null, undefined, 24, now), { status: "never", evidenceFresh: false, attemptedAt: undefined });
  assert.equal(repositoryScanState(old, undefined, 24, now).status, "stale");
  assert.equal(repositoryScanState(now, undefined, 24, now).status, "fresh");
  const failed = { status: "failed", attempts: 5, createdAt: now, lastError: "Lease expired after final attempt" };
  assert.equal(repositoryScanState(new Date(now.getTime() - 60_000), failed, 24, now).evidenceFresh, false);
  const recoveredAt = new Date(now.getTime() + 1000);
  assert.equal(repositoryScanState(recoveredAt, failed, 24, recoveredAt).status, "fresh");
  assert.equal(repositoryScanState(old, { ...failed, status: "queued" }, 24, now).status, "retrying");
  assert.equal(repositoryScanState(old, { ...failed, status: "running" }, 24, now).evidenceFresh, false);
  assert.equal(repositoryScanState(null, { ...failed, lastError: "secret-or-untrusted-response" }, 24, now).error?.includes("secret-or-untrusted-response"), false);
});

test("an old HTTP response cannot attest changed rendering settings", () => {
  const configuration = { target: "https://example.com/", timeoutSeconds: 10, failureThreshold: 3, latencyWarningMs: 1500,
    renderingUrl: null, expectedText: null, assetProbe: false, assetUrl: null, updatedAt: now };
  assert.equal(sameHttpCheckConfiguration(configuration, { ...configuration }), true);
  assert.equal(sameHttpCheckConfiguration(configuration, { ...configuration, assetProbe: true }), false);
  assert.equal(sameHttpCheckConfiguration(configuration, { ...configuration, expectedText: "Catalog" }), false);
  assert.equal(sameHttpCheckConfiguration(configuration, { ...configuration, updatedAt: new Date(now.getTime() + 1) }), false);
});
