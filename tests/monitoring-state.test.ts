import test from "node:test";
import assert from "node:assert/strict";
import { aggregateHealth, measureCoverage } from "@/lib/monitoring-state";
import { runtimeObservationState, runtimeRecoveryProven, type VpsRuntime } from "@/lib/vps-report";

const now = new Date("2026-09-22T12:00:00Z");
const check = { enabled: true, essential: true, status: "healthy" as const, intervalSeconds: 60, lastCheckedAt: now };
test("an essential stale/missing check cannot be hidden by a healthy sibling", () => {
  assert.equal(aggregateHealth([check, { ...check, lastCheckedAt: new Date(now.getTime() - 181000) }], now), "unknown");
  assert.equal(aggregateHealth([check, { ...check, status: "critical" }], now), "critical");
  assert.equal(aggregateHealth([check, { ...check, status: "critical", essential: false }], now), "healthy");
  assert.equal(aggregateHealth([], now), "unknown");
});
test("a successful sample covers one interval, not an entire silent day", () => {
  const end = new Date(now.getTime() + 86400000);
  const result = measureCoverage([{ observedAt: now, status: "healthy" }], 60, now, end);
  assert.equal(result.coveredMs, 60000);
  assert.equal(result.healthyMs, 60000);
  assert.equal(result.totalMs, 86400000);
  assert.equal(result.gaps, 1);
});
test("overlapping/manual samples never inflate coverage; unknown truncates healthy time", () => {
  const result = measureCoverage([
    { observedAt: now, status: "healthy" },
    { observedAt: new Date(now.getTime() + 30000), status: "healthy" },
    { observedAt: new Date(now.getTime() + 45000), status: "unknown" },
  ], 60, now, new Date(now.getTime() + 120000));
  assert.equal(result.coveredMs, 45000);
});

function runtime(): VpsRuntime {
  return { bootId: "boot", oomKillsSinceBoot: 0, collectedAt: now.toISOString(), events: [], units: [{
    key: "container:shop", label: "shop", kind: "container", running: true, memoryCurrentBytes: 40,
    memoryMaxBytes: 100, memoryPeakBytes: null, oomKills: 0, restartCount: 0, startedAt: now.toISOString(),
  }], completeness: { units: "complete", events: "complete", omittedUnits: 0, omittedEvents: 0, errors: [],
    eventsSince: new Date(now.getTime() - 86400000).toISOString(), selection: "all" } };
}
test("runtime distinguishes absent, stale, legacy partial and complete", () => {
  assert.equal(runtimeObservationState(undefined, now), "absent");
  assert.equal(runtimeObservationState({ ...runtime(), collectedAt: "2026-09-21T12:00:00Z" }, now), "stale");
  assert.equal(runtimeObservationState({ ...runtime(), completeness: undefined }, now), "partial");
  assert.equal(runtimeObservationState(runtime(), now), "complete");
});
test("recovery requires positive unit evidence and a complete crash window", () => {
  const report = runtime();
  assert.equal(runtimeRecoveryProven(report, "crash", "container:shop", now), true);
  assert.equal(runtimeRecoveryProven({ ...report, units: [] }, "crash", "container:shop", now), false);
  assert.equal(runtimeRecoveryProven({ ...report, units: [] }, "memory", "container:shop", now), false);
  report.completeness!.events = "partial";
  report.completeness!.omittedEvents = 5;
  assert.equal(runtimeRecoveryProven(report, "crash", "container:shop", now), false);
  assert.equal(runtimeRecoveryProven(report, "memory", "container:shop", now), true);
  report.units[0].memoryCurrentBytes = null;
  assert.equal(runtimeRecoveryProven(report, "memory", "container:shop", now), false);
});
