import test from "node:test";
import assert from "node:assert/strict";
import { checkSlots, nextCheckSlot } from "@/lib/check-schedule";

test("six minute checks occupy ten-second slots regardless of query order", () => {
  const checks = Array.from({ length: 6 }, (_, i) => ({ id: String(i), intervalSeconds: 60 }));
  const slots = checkSlots(checks.toReversed());
  const now = new Date("2026-09-22T12:00:01Z");
  const dates = checks.map((check) => nextCheckSlot(slots.get(check.id)!, now).getTime()).sort((a, b) => a - b);
  assert.equal(dates[0], Date.parse("2026-09-22T12:00:10Z"));
  assert.equal(dates[5], Date.parse("2026-09-22T12:01:00Z"));
  for (let i = 1; i < dates.length; i++) assert.equal(dates[i] - dates[i - 1], 10_000);
});

test("late scheduler ticks skip missed slots without changing the cadence", () => {
  const slot = checkSlots([{ id: "check", intervalSeconds: 60 }]).get("check")!;
  const due = new Date("2026-09-22T12:00:00Z");
  assert.equal(nextCheckSlot(slot, due).getTime() - due.getTime(), 60_000);
  assert.equal(nextCheckSlot(slot, new Date(due.getTime() + 8_000)).getTime() - due.getTime(), 60_000);
  assert.equal(nextCheckSlot(slot, new Date(due.getTime() + 5 * 60_000 + 8_000)).getTime() - due.getTime(), 6 * 60_000);
});

test("different intervals are spaced separately and keep their own frequency", () => {
  const slots = checkSlots([
    { id: "a", intervalSeconds: 60 }, { id: "b", intervalSeconds: 60 },
    { id: "c", intervalSeconds: 300 }, { id: "d", intervalSeconds: 300 },
  ]);
  assert.equal(slots.get("b")!.offsetMs, 30_000);
  assert.equal(slots.get("d")!.offsetMs, 150_000);
  for (const slot of slots.values()) {
    const due = nextCheckSlot(slot, new Date("2026-09-22T12:00:03Z"));
    assert.equal(nextCheckSlot(slot, due).getTime() - due.getTime(), slot.intervalMs);
  }
  assert.equal(checkSlots([]).size, 0);
});
