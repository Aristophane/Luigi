import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";

test("deployment ingestion authenticates, fences conflicting events and refreshes only provider confirmation", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const target = new URL(process.env.TEST_DATABASE_URL!);
  assert.match(target.pathname, /_test$/, "Use a dedicated test database");
  const admin = postgres(target.toString(), { max: 1 });
  const databaseName = `luigi_deployments_${randomUUID().replaceAll("-", "")}_test`;
  await admin.unsafe(`create database "${databaseName}"`);
  target.pathname = "/" + databaseName;
  const client = postgres(target.toString(), { max: 1 });
  const oldSecret = process.env.DEPLOYMENT_INGEST_SECRET;
  process.env.DATABASE_URL = target.toString();
  process.env.DEPLOYMENT_INGEST_SECRET = "deployment-test-only-secret";
  let closeDatabase: (() => Promise<void>) | undefined;
  try {
    await migrate(drizzle(client), { migrationsFolder: "drizzle" });
    const database = await import("@/db");
    closeDatabase = database.closeDatabase;
    const { db } = database;
    const { applications, deployments, jobs, workspaces } = await import("@/db/schema");
    const { POST } = await import("@/app/api/deployments/route");
    const { ingestDeploymentReport } = await import("@/lib/deployment-ingestion");
    const [workspace] = await db.insert(workspaces).values({ name: "Deployment fixture" }).returning();
    const [application] = await db.insert(applications).values({ workspaceId: workspace.id, name: "Fixture",
      publicUrl: "https://example.com/", githubRepository: "test/test", githubBranch: "main" }).returning();
    const report = { applicationId: application.id, deploymentId: "run-1", commitSha: "abcdef0123456789",
      source: "coolify", deployedAt: "2026-01-01T00:00:00Z", branch: "main", environment: "production" };
    const send = (body: unknown, authorization = "Bearer deployment-test-only-secret") => POST(new Request("http://localhost/api/deployments", {
      method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    assert.equal((await send(report, "Bearer wrong-secret")).status, 401);
    assert.equal((await send({ ...report, environment: "staging" })).status, 422);
    assert.equal((await send({ ...report, branch: "develop" })).status, 422);
    assert.equal((await send(report)).status, 202);
    const [legacy] = await db.select().from(deployments).where(eq(deployments.applicationId, application.id));
    assert.equal(legacy.verifiedAt, null);
    assert.equal((await send({ ...report, commitSha: "123456789abcdef0" })).status, 409);

    const observedAt = new Date();
    assert.equal((await send({ ...report, verification: { provider: "coolify", observedAt: observedAt.toISOString() } })).status, 200);
    const [verified] = await db.select().from(deployments).where(eq(deployments.applicationId, application.id));
    assert.equal(verified.commitSha, report.commitSha);
    assert.equal(verified.deployedAt.toISOString(), new Date(report.deployedAt).toISOString());
    assert.equal(verified.verifiedAt?.toISOString(), observedAt.toISOString());
    assert.equal(verified.verificationSource, "coolify");

    await send({ ...report, verification: { provider: "coolify", observedAt: new Date(observedAt.getTime() - 60_000).toISOString() } });
    await send(report);
    const [retained] = await db.select().from(deployments).where(eq(deployments.applicationId, application.id));
    assert.equal(retained.verifiedAt?.toISOString(), observedAt.toISOString());
    assert.equal((await db.select().from(deployments).where(eq(deployments.applicationId, application.id))).length, 1);

    const race = await Promise.all([send({ ...report, deploymentId: "race", commitSha: "1111111111111111" }),
      send({ ...report, deploymentId: "race", commitSha: "2222222222222222" })]);
    assert.deepEqual(race.map((response) => response.status).sort(), [202, 409]);
    const [expiredJob] = await db.insert(jobs).values({ workspaceId: workspace.id, kind: "scan", key: "deployments:expired",
      serialKey: "deployments:expired", payload: {}, status: "running", lockToken: randomUUID(),
      lockedUntil: new Date(Date.now() - 60_000) }).returning();
    const expiredReport = { ...report, deploymentId: "expired-lease", verification: { provider: "coolify", observedAt: new Date().toISOString() } };
    await assert.rejects(ingestDeploymentReport(expiredReport, expiredJob), /JOB_LEASE_LOST/);
    assert.equal((await db.select().from(deployments).where(eq(deployments.deploymentId, "expired-lease"))).length, 0);
    await assert.rejects(ingestDeploymentReport({ ...report, verification: expiredReport.verification }, expiredJob), /JOB_LEASE_LOST/);
    assert.equal((await db.select().from(deployments).where(eq(deployments.id, retained.id)))[0].verifiedAt?.toISOString(), observedAt.toISOString());
    const { synchronizeDeployments } = await import("@/lib/deployment-sync");
    await assert.rejects(synchronizeDeployments(workspace.id, expiredJob), /JOB_LEASE_LOST/);
    const [otherWorkspace] = await db.insert(workspaces).values({ name: "Other workspace" }).returning();
    await db.insert(applications).values({ workspaceId: otherWorkspace.id, name: "Other fixture",
      publicUrl: "https://example.com/", githubRepository: "test/other" });
    assert.equal((await send({ ...report, applicationId: undefined, applicationUrl: "https://example.com" })).status, 409);
  } finally {
    await closeDatabase?.();
    await client.end({ timeout: 2 });
    await admin.unsafe(`drop database "${databaseName}" with (force)`);
    await admin.end({ timeout: 2 });
    if (oldSecret === undefined) delete process.env.DEPLOYMENT_INGEST_SECRET;
    else process.env.DEPLOYMENT_INGEST_SECRET = oldSecret;
  }
});
