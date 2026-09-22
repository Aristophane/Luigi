import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

test("upgrade preserves legacy identity, then a real autonomous worker drives readiness", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const target = new URL(process.env.TEST_DATABASE_URL!);
  assert.match(target.pathname, /_test$/);
  const admin = postgres(target.toString(), { max: 1 });
  const databaseName = `luigi_upgrade_${randomUUID().replaceAll("-", "")}_test`;
  await admin.unsafe(`create database "${databaseName}"`);
  target.pathname = "/" + databaseName;
  const client = postgres(target.toString(), { max: 1 });
  const directory = await mkdtemp(path.join(tmpdir(), "luigi-migration-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < 17);
    await mkdir(path.join(directory, "meta"));
    await writeFile(path.join(directory, "meta", "_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries) await copyFile(path.join("drizzle", entry.tag + ".sql"), path.join(directory, entry.tag + ".sql"));
    const database = drizzle(client);
    await migrate(database, { migrationsFolder: directory });
    const workspaceId = randomUUID(), integrationId = randomUUID(), agentId = randomUUID();
    await client`insert into workspaces (id, name) values (${workspaceId}, 'Upgrade fixture')`;
    await client`insert into integrations (id, workspace_id, kind, label, encrypted_credentials, configuration)
      values (${integrationId}, ${workspaceId}, 'vps_agent', 'Legacy VPS', 'sha256:preserved', ${JSON.stringify({ agentId, hostname: "legacy-host" })}::jsonb)`;
    await client`insert into findings (workspace_id, kind, severity, title, fingerprint)
      values (${workspaceId}, 'capacity', 'high', 'Disk', 'vps:capacity:disk-root')`;
    await client`insert into monitoring_heartbeats (workspace_id, source, interval_seconds, last_seen_at)
      values (${workspaceId}, 'vps_agent', 300, now())`;
    await migrate(database, { migrationsFolder: "drizzle" });
    const [agent] = await client`select * from agents where id = ${agentId}`;
    assert.equal(agent.server_id, integrationId);
    assert.equal(agent.token_digest, "sha256:preserved");
    assert.equal((await client`select * from findings where workspace_id = ${workspaceId}`)[0].fingerprint, `vps:${integrationId}:capacity:disk-root`);
    assert.equal((await client`select * from monitoring_heartbeats where workspace_id = ${workspaceId}`)[0].source, `vps_agent:${integrationId}`);
    process.env.DATABASE_URL = target.toString();
    const { readiness } = await import("@/lib/readiness");
    const { closeDatabase } = await import("@/db");
    assert.equal((await readiness()).ready, false);
    child = spawn(process.execPath, ["--import", "./scripts/register.mjs", "src/worker.ts"], {
      windowsHide: true, stdio: "ignore", env: { ...process.env, DISCORD_WEBHOOK_URL: "", VAPID_PRIVATE_KEY: "", NEXT_PUBLIC_VAPID_PUBLIC_KEY: "" },
    });
    try {
      let ready = false;
      for (let i = 0; i < 40 && !ready; i++) { await delay(250); ready = (await readiness()).ready; }
      assert.equal(ready, true, "worker should become ready without HTTP or cron traffic");
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      child = undefined;
      await client`update worker_heartbeats set last_seen_at = now() - interval '1 minute'`;
      assert.equal((await readiness()).ready, false);
    } finally { await closeDatabase(); }
  } finally {
    child?.kill("SIGKILL");
    await client.end({ timeout: 2 });
    await admin.unsafe(`drop database "${databaseName}" with (force)`);
    await admin.end({ timeout: 2 });
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});
