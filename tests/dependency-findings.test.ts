import test from "node:test";
import assert from "node:assert/strict";
import { findings, maintenanceTasks } from "@/db/schema";
import type { DependencyFreshness } from "@/lib/dependency-freshness";

// Import the service without credentials or a live database. Every transaction
// below is an in-memory recorder; postgres never receives a query.
const previousDatabaseUrl = process.env.DATABASE_URL;
process.env.DATABASE_URL = "postgresql://fixture:fixture@127.0.0.1:1/unused_test";
const { syncDependencyFindings } = await import("@/lib/application-scanner");
if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
else process.env.DATABASE_URL = previousDatabaseUrl;

type Transaction = Parameters<typeof syncDependencyFindings>[0];

function recordedTransaction() {
  const writes: Array<{ operation: string; table: unknown; values: Record<string, unknown> }> = [];
  const transaction = {
    insert(table: unknown) {
      return { values(values: Record<string, unknown>) {
        writes.push({ operation: "insert", table, values });
        const query = { onConflictDoUpdate: () => query, returning: async () => [{ id: "fixture-id" }] };
        return query;
      } };
    },
    update(table: unknown) {
      return { set(values: Record<string, unknown>) {
        writes.push({ operation: "update", table, values });
        return { where: async () => [] };
      } };
    },
    select() {
      const query = { from: () => query, where: () => query, limit: async () => [],
        then: (resolve: (value: unknown[]) => unknown) => resolve([]) };
      return query;
    },
  } as unknown as Transaction;
  return { transaction, writes };
}

const now = new Date("2026-10-28T12:00:00Z");
function dependency(ecosystem: "npm" | "pypi", status: DependencyFreshness["status"] = "outdated"): DependencyFreshness {
  return { ecosystem, name: "demo", manifestPath: ecosystem === "npm" ? "package.json" : "requirements.txt",
    requestedRange: ecosystem === "npm" ? "1.0.0" : "==1.0.0", currentVersion: "1.0.0", latestVersion: "1.1.0",
    status, development: false, evidence: "fixture" };
}

test("PyPI findings and notifications have an independent ecosystem identity", async () => {
  const { transaction, writes } = recordedTransaction();
  const result = await syncDependencyFindings(transaction, { workspaceId: "workspace", applicationId: "app",
    freshness: [dependency("pypi")], declaredDependencies: [dependency("pypi")], existingFindings: [],
    openNotificationFingerprints: new Set(), checkedAt: now });
  const finding = writes.find((write) => write.table === findings)!;
  assert.equal(finding.values.fingerprint, "application:app:dependency:pypi:requirements.txt:demo:outdated");
  assert.equal((finding.values.metadata as Record<string, unknown>).ecosystem, "pypi");
  assert.equal(result.notificationEvents[0].fingerprint, "dependency-update:app:pypi:requirements.txt:demo");
  assert.ok(writes.some((write) => write.table === maintenanceTasks));
});

test("Legacy npm identities are retained without duplicating their notification", async () => {
  const { transaction, writes } = recordedTransaction();
  const result = await syncDependencyFindings(transaction, { workspaceId: "workspace", applicationId: "app",
    freshness: [dependency("npm")], declaredDependencies: [dependency("npm")],
    existingFindings: [{ id: "previous", fingerprint: "application:app:dependency:npm:demo:outdated", resolvedAt: null,
      metadata: { package: "demo", latestVersion: "1.1.0" } }],
    openNotificationFingerprints: new Set(["dependency-update:app:npm:demo"]), checkedAt: now });
  assert.equal(writes.find((write) => write.table === findings)?.values.fingerprint, "application:app:dependency:npm:demo:outdated");
  assert.deepEqual(result.notificationEvents, []);
  assert.equal(writes.some((write) => write.operation === "update" && write.table === findings), false);
});

test("Unsupported or unknown Python checks cannot close a previously observed update", async () => {
  for (const status of ["unsupported", "unknown"] as const) {
    const { transaction, writes } = recordedTransaction();
    const result = await syncDependencyFindings(transaction, { workspaceId: "workspace", applicationId: "app",
      freshness: [dependency("pypi", status)], declaredDependencies: [dependency("pypi", status)],
      existingFindings: [{ id: "previous", fingerprint: "application:app:dependency:pypi:requirements.txt:demo:outdated", resolvedAt: null,
        metadata: { ecosystem: "pypi", package: "demo", manifestPath: "requirements.txt" } }],
      openNotificationFingerprints: new Set(), checkedAt: now });
    assert.deepEqual(writes, [], status);
    assert.deepEqual(result.notificationEvents, [], status);
  }
});

test("A proven current Python pin resolves its own finding and notification", async () => {
  const { transaction, writes } = recordedTransaction();
  const result = await syncDependencyFindings(transaction, { workspaceId: "workspace", applicationId: "app",
    freshness: [dependency("pypi", "current")], declaredDependencies: [dependency("pypi", "current")],
    existingFindings: [{ id: "previous", fingerprint: "application:app:dependency:pypi:requirements.txt:demo:outdated", resolvedAt: null,
      metadata: { ecosystem: "pypi", package: "demo", manifestPath: "requirements.txt" } }],
    openNotificationFingerprints: new Set(), checkedAt: now });
  assert.ok(writes.some((write) => write.operation === "update" && write.table === findings && write.values.resolvedAt === now));
  assert.equal(result.notificationEvents[0].kind, "resolved");
  assert.equal(result.notificationEvents[0].fingerprint, "dependency-update:app:pypi:requirements.txt:demo");
});
