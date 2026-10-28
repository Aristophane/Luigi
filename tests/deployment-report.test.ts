import test from "node:test";
import assert from "node:assert/strict";
import { deploymentConfirmationState } from "@/lib/deployment-health";
import { deploymentReportConflicts, deploymentReportDateError, deploymentReportSchema,
  deploymentReportTargetError, normalizeApplicationUrl } from "@/lib/deployment-report";

const now = new Date("2026-10-28T14:00:00Z");
const legacy = { applicationUrl: "https://example.com/", deploymentId: "run-1", commitSha: "ABCDEF0123456789",
  deployedAt: "2026-10-01T12:00:00Z" };

test("legacy reports remain accepted without fabricating a provider confirmation", () => {
  const report = deploymentReportSchema.parse(legacy);
  assert.equal(report.commitSha, "abcdef0123456789");
  assert.equal(report.source, "ci");
  assert.equal(report.verification, undefined);
  assert.equal(deploymentReportDateError(report, now), undefined);
  assert.equal(deploymentConfirmationState(null, now), "unverified");
  assert.equal(normalizeApplicationUrl("https://example.com/admin/?tab=1#hash"), "https://example.com/admin");
});

test("confirmation ages independently of deployment age, with bounded clock skew", () => {
  assert.equal(deploymentConfirmationState(new Date("2026-10-28T12:00:00Z"), now), "confirmed");
  assert.equal(deploymentConfirmationState(new Date("2026-10-28T11:59:59Z"), now), "stale");
  assert.equal(deploymentConfirmationState(new Date("2026-10-28T14:05:01Z"), now), "stale");
  const verified = deploymentReportSchema.parse({ ...legacy, verification: { provider: "coolify", observedAt: now.toISOString() } });
  assert.equal(deploymentReportDateError(verified, now), undefined);
  assert.equal(deploymentReportDateError({ ...verified, verification: { provider: "coolify", observedAt: "2026-09-30T12:00:00Z" } }, now),
    "Invalid deployment verification date.");
  assert.equal(deploymentReportDateError({ ...verified, verification: { provider: "coolify", observedAt: "2026-10-28T14:05:01Z" } }, now),
    "Invalid deployment verification date.");
});

test("reported targets must match the monitored application and an event cannot change commit", () => {
  const report = deploymentReportSchema.parse({ ...legacy, branch: "main", environment: "production" });
  assert.equal(deploymentReportTargetError(report, { githubBranch: "main", environment: "production" }), undefined);
  assert.equal(deploymentReportTargetError(report, { githubBranch: "develop", environment: "production" }),
    "Deployment branch does not match the application.");
  assert.equal(deploymentReportTargetError(report, { githubBranch: "main", environment: "staging" }),
    "Deployment environment does not match the application.");
  assert.equal(deploymentReportConflicts(report, { commitSha: "abcdef0", branch: null, environment: null }), false);
  assert.equal(deploymentReportConflicts(report, { commitSha: "abcdef1", branch: null, environment: null }), true);
  assert.equal(deploymentReportConflicts(report, { commitSha: report.commitSha, branch: "develop", environment: null }), true);
});
