import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

test("PostgreSQL reliability: atomic outbox, lease fencing, report replay, isolation and scheduler", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const target = new URL(process.env.TEST_DATABASE_URL!);
  assert.match(target.pathname, /_test$/u, "Use a dedicated database whose name ends in _test");
  const admin = postgres(target.toString(), { max: 1 });
  const databaseName = `luigi_reliability_${randomUUID().replaceAll("-", "")}_test`;
  await admin.unsafe(`create database "${databaseName}"`);
  target.pathname = "/" + databaseName;
  const migrationClient = postgres(target.toString(), { max: 1 });
  await migrate(drizzle(migrationClient), { migrationsFolder: "drizzle" });
  await migrationClient.end();
  process.env.DATABASE_URL = target.toString();
  const { db, closeDatabase } = await import("@/db");
  const schema = await import("@/db/schema");
  const { workspaces, jobs, notificationDeliveries, deliveryAttempts, notifications, servers, agents,
    vpsMetricSamples, findings, maintenanceTasks, applications, checks, observations, monitoringHeartbeats, workerHeartbeats } = schema;
  const queue = await import("@/lib/job-queue");
  const { createOrRefreshNotification } = await import("@/lib/notifications");
  const { deliverNotification } = await import("@/lib/notification-worker");
  const { processAgentReport } = await import("@/lib/report-processing");
  const { enqueueChecks, schedulerTick, pulseWorker } = await import("@/lib/monitor-scheduler");
  const { readiness } = await import("@/lib/readiness");
  const { applicationCoverage } = await import("@/lib/coverage");
  const [workspace] = await db.insert(workspaces).values({ name: "Reliability test" }).returning();
  const workspaceId = workspace.id;
  const fetchOriginal = globalThis.fetch;
  const oldWebhook = process.env.DISCORD_WEBHOOK_URL;
  try {
    await t.test("existing synchronized checks spread out; manual checks preserve the schedule", async () => {
      const [fixture] = await db.insert(workspaces).values({ name: "Schedule fixture" }).returning();
      try {
        const [app] = await db.insert(applications).values({ workspaceId: fixture.id, name: "Scheduled",
          publicUrl: "https://example.com/", githubRepository: "test/test", lastRepositoryScannedAt: new Date() }).returning();
        const active = await db.insert(checks).values(Array.from({ length: 6 }, () => ({
          applicationId: app.id, target: "https://example.com/", intervalSeconds: 60, nextCheckAt: new Date(0),
        }))).returning();
        await db.insert(checks).values({ applicationId: app.id, target: "https://example.com/disabled", enabled: false });
        const counts = await Promise.all([enqueueChecks(fixture.id), enqueueChecks(fixture.id)]);
        assert.equal(counts.reduce((a, b) => a + b), 6);
        const scheduled = await db.select().from(checks).where(and(eq(checks.applicationId, app.id), eq(checks.enabled, true)));
        assert.deepEqual(scheduled.map((check) => check.nextCheckAt.getTime() % 60_000).sort((a, b) => a - b),
          [0, 10_000, 20_000, 30_000, 40_000, 50_000]);
        assert.equal((await db.select().from(jobs).where(eq(jobs.workspaceId, fixture.id))).length, 6);
        // Complete the initial reservations to simulate a manual request between scheduled runs.
        await db.delete(jobs).where(eq(jobs.workspaceId, fixture.id));
        await db.update(checks).set({ nextCheckAt: new Date(Date.now() + 60_000) }).where(eq(checks.applicationId, app.id));
        const before = await db.select().from(checks).where(eq(checks.applicationId, app.id)).orderBy(checks.id);
        const requestedAt = new Date();
        assert.equal(await enqueueChecks(fixture.id, true), 6);
        const after = await db.select().from(checks).where(eq(checks.applicationId, app.id)).orderBy(checks.id);
        assert.deepEqual(after.map((check) => check.nextCheckAt), before.map((check) => check.nextCheckAt));
        const manual = await db.select().from(jobs).where(eq(jobs.workspaceId, fixture.id));
        assert.equal(manual.length, active.length);
        assert.ok(manual.every((job) => job.status === "queued" && job.availableAt >= requestedAt && job.availableAt <= new Date()));
      } finally { await db.delete(workspaces).where(eq(workspaces.id, fixture.id)); }
    });
    await t.test("notification and delivery tasks roll back together", async () => {
      await assert.rejects(db.transaction(async (tx) => {
        await createOrRefreshNotification({ workspaceId, title: "Rollback", body: "Test", severity: "high", targetUrl: "/", fingerprint: "rollback" }, tx);
        throw new Error("simulated crash");
      }));
      assert.equal((await db.select().from(notifications).where(eq(notifications.workspaceId, workspaceId))).length, 0);
      assert.equal((await db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId))).length, 0);
    });
    await t.test("failed Discord retries persist; refreshed occurrence neither loses nor duplicates delivery", async () => {
      process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/test/mock";
      let calls = 0;
      globalThis.fetch = async () => new Response(null, { status: ++calls === 1 ? 503 : 204 });
      const input = { workspaceId, title: "Incident", body: "Test", severity: "high" as const, targetUrl: "/", fingerprint: "incident" };
      const notification = await createOrRefreshNotification(input);
      await createOrRefreshNotification(input);
      const deliveries = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.notificationId, notification.id));
      assert.equal(deliveries.length, 2);
      const discord = deliveries.find((d) => d.channel === "discord")!;
      // Park the unrelated recipient to isolate this channel's retry.
      await db.update(jobs).set({ availableAt: new Date(Date.now() + 3600000) })
        .where(and(eq(jobs.workspaceId, workspaceId), sql`${jobs.payload}->>'deliveryId' <> ${discord.id}`));
      const job = await queue.claimJob("notification");
      assert.ok(job);
      await assert.rejects(deliverNotification(job), /DELIVERY_RETRY/);
      await queue.failJob(job, "Test HTTP 503");
      await db.update(jobs).set({ availableAt: new Date(0) }).where(eq(jobs.id, job.id));
      const retried = await queue.claimJob("notification");
      assert.ok(retried);
      assert.equal(retried.id, job.id);
      await deliverNotification(retried);
      assert.equal(calls, 2);
      assert.equal((await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, discord.id)))[0].status, "delivered");
      assert.deepEqual((await db.select().from(deliveryAttempts).where(eq(deliveryAttempts.deliveryId, discord.id))
        .orderBy(deliveryAttempts.createdAt)).map((a) => a.outcome), ["failed", "delivered"]);
    });
    await t.test("concurrent schedulers reserve once, expired jobs resume, old lease cannot commit", async () => {
      await Promise.all(Array.from({ length: 8 }, () => queue.enqueueJob({ workspaceId, kind: "scan", key: "test:scan", payload: {} })));
      assert.equal((await db.select().from(jobs).where(eq(jobs.key, "test:scan"))).length, 1);
      const claims = await Promise.all([queue.claimJob("scan"), queue.claimJob("scan")]);
      assert.equal(claims.filter(Boolean).length, 1);
      const first = claims.find(Boolean)!;
      await db.update(jobs).set({ lockedUntil: new Date(0) }).where(eq(jobs.id, first.id));
      const replacement = await queue.claimJob("scan");
      assert.ok(replacement);
      assert.equal(first.id, replacement.id);
      assert.notEqual(first.lockToken, replacement.lockToken);
      await assert.rejects(db.transaction((tx) => queue.assertLease(tx, first)), /JOB_LEASE_LOST/);
      await db.transaction(async (tx) => { await queue.assertLease(tx, replacement); await queue.completeJob(tx, replacement); });
    });
    const [serverA, serverB] = await db.insert(servers).values([{ workspaceId, label: "A" }, { workspaceId, label: "B" }]).returning();
    await t.test("retries stop at the persisted attempt budget", async () => {
      await queue.enqueueJob({ workspaceId, kind: "scan", key: "bounded", payload: {}, maxAttempts: 2 });
      const first = await queue.claimJob("scan");
      assert.ok(first);
      await queue.failJob(first, "temporary failure");
      await db.update(jobs).set({ availableAt: new Date(0) }).where(eq(jobs.id, first.id));
      const last = await queue.claimJob("scan");
      assert.ok(last);
      await queue.failJob(last, "still failing");
      assert.equal((await db.select().from(jobs).where(eq(jobs.id, first.id)))[0].status, "failed");
      assert.equal(await queue.claimJob("scan"), undefined);
    });
    const [agent] = await db.insert(agents).values({ serverId: serverA.id, tokenDigest: "test:" + randomUUID() }).returning();
    const now = new Date();
    const payload = { schemaVersion: 1, reportId: randomUUID(), agentId: agent.id, hostname: "server-a", observedAt: now.toISOString(),
      metrics: { cpuPercent: 5, memoryPercent: 5, diskPercent: 91, swapPercent: 0, load1: 0.1, uptimeSeconds: 500 },
      updates: { available: 0, security: 0, held: 0, rebootRequired: false },
      security: { ufwActive: true, sshPasswordAuthentication: false, sshRootLogin: false }, services: [] };
    let sampleId = "";
    await t.test("receipt + job are atomic, crash in rule processing rolls everything back, retry is idempotent", async () => {
      await db.transaction(async (tx) => {
        const [sample] = await tx.insert(vpsMetricSamples).values({ workspaceId, serverId: serverA.id, agentId: agent.id,
          reportId: payload.reportId, hostname: payload.hostname, payload, observedAt: now }).returning();
        sampleId = sample.id;
        await queue.enqueueJob({ workspaceId, kind: "report", key: "report:" + sample.id, serialKey: "agent:" + agent.id, payload: { sampleId } }, tx);
      });
      await db.execute(sql`create function test_fail_task() returns trigger language plpgsql as $$ begin raise exception 'simulated crash'; end $$`);
      await db.execute(sql`create trigger test_fail_task before insert on maintenance_tasks for each row execute function test_fail_task()`);
      const job = await queue.claimJob("report");
      assert.ok(job);
      try { await assert.rejects(processAgentReport(job)); }
      finally {
        await db.execute(sql`drop trigger test_fail_task on maintenance_tasks`);
        await db.execute(sql`drop function test_fail_task()`);
      }
      assert.equal((await db.select().from(findings).where(eq(findings.workspaceId, workspaceId))).length, 0);
      assert.equal((await db.select().from(vpsMetricSamples).where(eq(vpsMetricSamples.id, sampleId)))[0].processedAt, null);
      await processAgentReport(job);
      assert.equal((await db.select().from(findings).where(eq(findings.serverId, serverA.id))).length, 1);
      assert.equal((await db.select().from(maintenanceTasks).where(eq(maintenanceTasks.workspaceId, workspaceId))).length, 1);
      assert.equal((await db.select().from(vpsMetricSamples).where(eq(vpsMetricSamples.id, sampleId)))[0].processingStatus, "processed");
      await assert.rejects(processAgentReport(job), /JOB_LEASE_LOST/);
      assert.equal((await db.select().from(maintenanceTasks).where(eq(maintenanceTasks.workspaceId, workspaceId))).length, 1);
    });
    await t.test("a healthy second server cannot resolve the first server's finding", async () => {
      const { evaluateVpsReport } = await import("@/lib/vps-rules");
      const { vpsReportSchema } = await import("@/lib/vps-report");
      await db.transaction((tx) => evaluateVpsReport(workspaceId, vpsReportSchema.parse({ ...payload,
        metrics: { ...payload.metrics, diskPercent: 5 } }), now, serverB.id, tx));
      assert.equal((await db.select().from(findings).where(eq(findings.serverId, serverA.id)))[0].resolvedAt, null);
    });
    await t.test("an omitted runtime unit stays open; a measured recovery closes it", async () => {
      const { evaluateVpsReport } = await import("@/lib/vps-rules");
      const { vpsReportSchema } = await import("@/lib/vps-report");
      const [finding] = await db.insert(findings).values({ workspaceId, serverId: serverA.id, kind: "capacity", severity: "high",
        title: "Memory", fingerprint: `vps:${serverA.id}:runtime:memory-ceiling:container:shop` }).returning();
      const runtime = { bootId: "boot", oomKillsSinceBoot: 0, collectedAt: now.toISOString(), units: [], events: [],
        completeness: { units: "partial", events: "partial", omittedUnits: 1, omittedEvents: 3, errors: [], eventsSince: now.toISOString() } };
      await db.transaction((tx) => evaluateVpsReport(workspaceId, vpsReportSchema.parse({ ...payload, runtime }), now, serverA.id, tx));
      assert.equal((await db.select().from(findings).where(eq(findings.id, finding.id)))[0].resolvedAt, null);
      const recovered = { ...runtime, units: [{ key: "container:shop", kind: "container", label: "shop", running: true,
        memoryCurrentBytes: 40, memoryMaxBytes: 100, memoryPeakBytes: null, oomKills: 0, restartCount: 0, startedAt: now.toISOString() }] };
      await db.transaction((tx) => evaluateVpsReport(workspaceId, vpsReportSchema.parse({ ...payload, runtime: recovered }), now, serverA.id, tx));
      assert.ok((await db.select().from(findings).where(eq(findings.id, finding.id)))[0].resolvedAt);
    });
    await t.test("checks are scheduled independently and gaps are not healthy time", async () => {
      const [app] = await db.insert(applications).values({ workspaceId, name: "test", publicUrl: "https://example.com/", githubRepository: "test/test", lastRepositoryScannedAt: new Date() }).returning();
      const [due, notDue] = await db.insert(checks).values([
        { applicationId: app.id, target: "https://example.com/", intervalSeconds: 60, createdAt: new Date(Date.now() - 3600000), nextCheckAt: new Date(0) },
        { applicationId: app.id, target: "https://example.com/status", nextCheckAt: new Date(Date.now() + 3600000) },
      ]).returning();
      const counts = await Promise.all([enqueueChecks(workspaceId), enqueueChecks(workspaceId)]);
      assert.equal(counts.reduce((a, b) => a + b), 1);
      const reserved = await db.select().from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.kind, "check")));
      assert.equal(reserved.length, 1);
      assert.equal(reserved[0].payload.checkId, due.id);
      await db.update(checks).set({ enabled: false }).where(eq(checks.id, notDue.id));
      await db.insert(observations).values({ checkId: due.id, status: "healthy", observedAt: new Date(Date.now() - 300000) });
      const metrics = (await applicationCoverage(workspaceId)).find((m) => m.applicationId === app.id)!;
      assert.ok(metrics.coverage30d < 2);
      assert.equal(metrics.uptime30d, 100);
      assert.ok(metrics.collectionGaps >= 2);
      // Exercise the actual isolated process, with a rejected local target so no network request is made.
      await db.update(checks).set({ target: "http://127.0.0.1/" }).where(eq(checks.id, due.id));
      const job = await queue.claimJob("check");
      assert.ok(job);
      await promisify(execFile)(process.execPath, ["build/worker/worker.mjs", job.id, job.lockToken!], {
        timeout: 15000, windowsHide: true, env: { ...process.env, DISCORD_WEBHOOK_URL: "" },
      });
      assert.equal((await db.select().from(jobs).where(eq(jobs.id, job.id)))[0].status, "succeeded");
      assert.equal((await db.select().from(checks).where(eq(checks.id, due.id)))[0].status, "warning");
    });
    await t.test("autonomous silence detection runs without cron or reports; readiness rejects missing lanes", async () => {
      await db.insert(monitoringHeartbeats).values({ workspaceId, source: "vps_agent:" + serverA.id, intervalSeconds: 60, lastSeenAt: new Date(0) });
      await schedulerTick();
      assert.ok((await db.select().from(notifications).where(and(eq(notifications.workspaceId, workspaceId), eq(notifications.fingerprint, "monitoring-source:vps_agent:" + serverA.id + ":silent")))).length);
      await db.delete(workerHeartbeats).where(eq(workerHeartbeats.name, "worker:scan"));
      assert.equal((await readiness()).ready, false);
      for (const kind of Object.keys(queue.jobBudgets)) await pulseWorker("worker:" + kind);
      assert.equal((await readiness()).ready, true);
      await db.update(workerHeartbeats).set({ lastSeenAt: new Date(0) }).where(eq(workerHeartbeats.name, "scheduler"));
      assert.equal((await readiness()).ready, false);
    });
    await t.test("two enrollments retain independent credentials; duplicate reports create one durable task", async () => {
      const { issueAgentEnrollmentCode } = await import("@/lib/agent-auth");
      const { POST: enroll } = await import("@/app/api/agent/v1/enroll/route");
      const { POST: receive } = await import("@/app/api/agent/v1/report/route");
      const credentials: { agentId: string; token: string }[] = [];
      for (let i = 0; i < 2; i++) {
        const code = issueAgentEnrollmentCode();
        await db.insert(schema.vpsAgentEnrollments).values({ workspaceId, codeDigest: code.codeDigest,
          endpoint: "http://localhost/api/agent/v1/report", expiresAt: new Date(Date.now() + 600000) });
        const response = await enroll(new Request("http://localhost/api/agent/v1/enroll", { method: "POST", headers: { authorization: "Bearer " + code.code } }));
        assert.equal(response.status, 201);
        credentials.push(await response.json());
      }
      assert.notEqual(credentials[0].agentId, credentials[1].agentId);
      const reportId = randomUUID();
      const request = (agent: typeof credentials[number], id: string) => new Request("http://localhost/api/agent/v1/report", {
        method: "POST", headers: { authorization: "Bearer " + agent.token },
        body: JSON.stringify({ ...payload, reportId: id, agentId: agent.agentId, observedAt: new Date().toISOString() }),
      });
      const responses = await Promise.all([receive(request(credentials[0], reportId)), receive(request(credentials[0], reportId))]);
      assert.deepEqual((await Promise.all(responses.map((r) => r.json()))).map((r) => r.duplicate).sort(), [false, true]);
      const [sample] = await db.select().from(vpsMetricSamples).where(eq(vpsMetricSamples.reportId, reportId));
      assert.equal((await db.select().from(jobs).where(eq(jobs.key, "report:" + sample.id))).length, 1);
      assert.equal((await receive(request(credentials[1], randomUUID()))).status, 202);
      assert.equal((await receive(request(credentials[0], randomUUID()))).status, 202);
    });
  } finally {
    globalThis.fetch = fetchOriginal;
    if (oldWebhook) process.env.DISCORD_WEBHOOK_URL = oldWebhook; else delete process.env.DISCORD_WEBHOOK_URL;
    await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
    await closeDatabase();
    await admin.unsafe(`drop database "${databaseName}" with (force)`);
    await admin.end({ timeout: 2 });
  }
});
