import type { HealthStatus } from "@/lib/domain";

export type CheckState = { enabled: boolean; essential: boolean; status: HealthStatus;
  intervalSeconds: number; lastCheckedAt: Date | null };

export function isFresh(at: Date | null, intervalSeconds: number, now = new Date()) {
  const age = at ? now.getTime() - at.getTime() : Infinity;
  return age >= -60_000 && age <= (intervalSeconds * 2 + 60) * 1000;
}

export function aggregateHealth(checks: CheckState[], now = new Date()): HealthStatus {
  const states = checks.filter((check) => check.enabled && check.essential)
    .map((check) => isFresh(check.lastCheckedAt, check.intervalSeconds, now) ? check.status : "unknown");
  if (states.includes("critical")) return "critical";
  if (!states.length || states.includes("unknown")) return "unknown";
  return states.includes("warning") ? "warning" : "healthy";
}

export type TimedMeasurement = { observedAt: Date; status: HealthStatus };
// A measurement covers at most one scheduled interval. Gaps never extend a healthy result.
export function measureCoverage(samples: TimedMeasurement[], intervalSeconds: number, start: Date, end: Date) {
  const ordered = [...samples].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  let coveredMs = 0;
  let healthyMs = 0;
  let gaps = 0;
  let cursor = start.getTime();
  for (let i = 0; i < ordered.length; i++) {
    const sample = ordered[i];
    const from = Math.max(start.getTime(), sample.observedAt.getTime());
    const to = Math.min(end.getTime(), sample.observedAt.getTime() + intervalSeconds * 1000,
      ordered[i + 1]?.observedAt.getTime() ?? Infinity);
    if (to <= from || sample.status === "unknown") continue;
    if (from > cursor) gaps++;
    const duration = Math.max(0, to - Math.max(cursor, from));
    coveredMs += duration;
    if (sample.status === "healthy" || sample.status === "warning") healthyMs += duration;
    cursor = Math.max(cursor, to);
  }
  if (cursor < end.getTime()) gaps++;
  const totalMs = Math.max(0, end.getTime() - start.getTime());
  return { coveredMs, healthyMs, totalMs, gaps };
}
