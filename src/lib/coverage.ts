import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";

export async function applicationCoverage(workspaceId: string) {
  const rows = await db.execute(sql`with windows as (
    select c.id, c.application_id, c.interval_seconds,
      greatest(c.created_at, now() - interval '30 days') as start_at, now() as end_at
    from checks c join applications a on a.id = c.application_id
    where a.workspace_id = ${workspaceId} and a.archived_at is null and c.enabled and c.essential
  ), measured as (
    select w.*, o.observed_at, o.status,
      lead(o.observed_at) over (partition by w.id order by o.observed_at, o.id) as next_at
    from windows w join observations o on o.check_id = w.id
    where o.observed_at >= w.start_at - (w.interval_seconds * interval '1 second') and o.observed_at <= w.end_at
  ), spans as (
    select *, greatest(observed_at, start_at) as from_at,
      least(coalesce(next_at, end_at), end_at, observed_at + (interval_seconds * interval '1 second')) as to_at
    from measured where status <> 'unknown'
  ), valid as (
    select *, lag(to_at) over (partition by id order by from_at) as previous_to from spans where to_at > from_at
  ), totals as (
    select w.id, w.application_id, extract(epoch from (w.end_at - w.start_at)) as expected,
      coalesce(sum(extract(epoch from (v.to_at - v.from_at))), 0) as covered,
      coalesce(sum(extract(epoch from (v.to_at - v.from_at))) filter (where v.status in ('healthy', 'warning')), 0) as healthy,
      count(*) filter (where v.from_at > coalesce(v.previous_to, w.start_at))
        + case when coalesce(max(v.to_at), w.start_at) < w.end_at then 1 else 0 end as gaps
    from windows w left join valid v on v.id = w.id group by w.id, w.application_id, w.start_at, w.end_at
  ) select application_id, sum(covered) as covered, sum(healthy) as healthy, sum(expected) as expected, sum(gaps) as gaps
    from totals group by application_id`);
  return rows.map((row) => ({ applicationId: String(row.application_id),
    coverage30d: Number(row.expected) > 0 ? Math.min(100, Number(row.covered) / Number(row.expected) * 100) : 0,
    uptime30d: Number(row.covered) > 0 ? Number(row.healthy) / Number(row.covered) * 100 : null,
    collectionGaps: Number(row.gaps), missingMinutes: Math.round((Number(row.expected) - Number(row.covered)) / 60),
  }));
}
