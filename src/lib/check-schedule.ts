type ScheduledCheck = { id: string; intervalSeconds: number };
type CheckSlot = { intervalMs: number; offsetMs: number };

/** Stable, evenly spaced slots across all active checks with the same cadence. */
export function checkSlots(checks: ScheduledCheck[]): Map<string, CheckSlot> {
  const groups = new Map<number, ScheduledCheck[]>();
  for (const check of checks) {
    const intervalMs = Math.max(1, check.intervalSeconds) * 1000;
    const group = groups.get(intervalMs) ?? [];
    group.push(check);
    groups.set(intervalMs, group);
  }
  const slots = new Map<string, CheckSlot>();
  for (const [intervalMs, group] of groups) {
    group.sort((a, b) => a.id.localeCompare(b.id));
    group.forEach((check, index) => slots.set(check.id, {
      intervalMs, offsetMs: Math.floor(index * intervalMs / group.length),
    }));
  }
  return slots;
}

/** Next future slot, skipping missed periods rather than replaying a backlog. */
export function nextCheckSlot(slot: CheckSlot, now: Date): Date {
  const periods = Math.floor((now.getTime() - slot.offsetMs) / slot.intervalMs) + 1;
  return new Date(periods * slot.intervalMs + slot.offsetMs);
}
