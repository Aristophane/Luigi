import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

test("HTTP monitoring fences changed settings, reserves their test and measures response bodies", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const target = new URL(process.env.TEST_DATABASE_URL!);
  assert.match(target.pathname, /_test$/u, "Use a dedicated database whose name ends in _test");
  const admin = postgres(target.toString(), { max: 1 });
  const databaseName = `luigi_http_${randomUUID().replaceAll("-", "")}_test`;
  await admin.unsafe(`create database "${databaseName}"`);
  target.pathname = "/" + databaseName;
  const migrationClient = postgres(target.toString(), { max: 1 });
  await migrate(drizzle(migrationClient), { migrationsFolder: "drizzle" });
  await migrationClient.end();
  process.env.DATABASE_URL = target.toString();
  const { db, closeDatabase } = await import("@/db");
  const { applications, checks, jobs, observations, workspaces } = await import("@/db/schema");
  const { enqueueJob, claimJob } = await import("@/lib/job-queue");
  const { runHttpCheck } = await import("@/lib/http-monitor");
  const fetchOriginal = globalThis.fetch;
  try {
    const [workspace] = await db.insert(workspaces).values({ name: "HTTP fixture" }).returning();
    const [application] = await db.insert(applications).values({ workspaceId: workspace.id, name: "HTTP fixture",
      publicUrl: "http://8.8.8.8/", githubRepository: "fixture/test" }).returning();
    const [check] = await db.insert(checks).values({ applicationId: application.id, target: "http://8.8.8.8/" }).returning();
    await enqueueJob({ workspaceId: workspace.id, kind: "check", key: `check:${check.id}`, payload: { checkId: check.id } });
    const first = await claimJob("check");
    assert.ok(first);
    let release!: (response: Response) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    // A public literal avoids DNS requests; every fetch is replaced, so this test has no network traffic.
    globalThis.fetch = async () => { signalStarted(); return new Promise<Response>((resolve) => { release = resolve; }); };
    const running = runHttpCheck(check.id, first);
    await started;
    await db.update(checks).set({ expectedText: "Catalog", status: "unknown", lastCheckedAt: null,
      updatedAt: new Date(Math.max(Date.now(), check.updatedAt.getTime() + 1)) }).where(eq(checks.id, check.id));
    release(new Response("Old page", { headers: { "content-type": "text/html" } }));
    await running;
    assert.equal((await db.select().from(observations).where(eq(observations.checkId, check.id))).length, 0);
    assert.equal((await db.select().from(jobs).where(eq(jobs.id, first.id)))[0].status, "succeeded");
    assert.equal((await db.select().from(checks).where(eq(checks.id, check.id)))[0].status, "unknown");
    const second = await claimJob("check");
    assert.ok(second, "The changed configuration gets a new job after the old reservation completes");
    assert.notEqual(first.id, second.id);
    globalThis.fetch = async () => new Response("<h1>Catalog</h1>", { headers: { "content-type": "text/html" } });
    await runHttpCheck(check.id, second);
    assert.equal((await db.select().from(checks).where(eq(checks.id, check.id)))[0].status, "healthy");

    await db.update(checks).set({ expectedText: null, assetProbe: true, assetUrl: "/slow.png", latencyWarningMs: 20,
      updatedAt: new Date(Date.now() + 1) }).where(eq(checks.id, check.id));
    await enqueueJob({ workspaceId: workspace.id, kind: "check", key: `check:${check.id}`, payload: { checkId: check.id } });
    const third = await claimJob("check");
    assert.ok(third);
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("slow.png")) return new Response(new ReadableStream({
        async start(controller) {
          await new Promise<void>((resolve) => setTimeout(resolve, 60));
          controller.enqueue(new Uint8Array(16)); controller.close();
        },
      }), { headers: { "content-type": "image/png" } });
      return new Response("<h1>Catalog</h1>");
    };
    const slow = await runHttpCheck(check.id, third);
    assert.equal(slow.status, "warning");
    assert.match(slow.detail, /image lente/);
  } finally {
    globalThis.fetch = fetchOriginal;
    await closeDatabase();
    await admin.unsafe(`drop database "${databaseName}" with (force)`);
    await admin.end();
  }
});
