import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export async function readiness() {
  try {
    const result = await db.execute(sql`select
      (select count(*)::int from worker_heartbeats where name in ('scheduler', 'worker:check', 'worker:scan', 'worker:report', 'worker:notification')
        and last_seen_at > now() - interval '45 seconds') as live,
      exists(select 1 from jobs where (status = 'queued' and available_at < now() - interval '10 minutes')
        or (status = 'running' and locked_until < now() - interval '1 minute')) as stalled`);
    const scheduler = Number(result[0]?.live) === 5;
    const backlog = !result[0]?.stalled;
    return { ready: scheduler && backlog, database: true, scheduler, backlog };
  } catch {
    return { ready: false, database: false, scheduler: false, backlog: false };
  }
}
