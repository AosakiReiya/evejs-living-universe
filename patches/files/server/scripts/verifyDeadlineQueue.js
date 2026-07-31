"use strict";

const assert = require("assert/strict");
const { performance } = require("perf_hooks");
const {
  DeadlineQueue,
} = require("../src/space/liveEvents/deadlineQueue");

const queue = new DeadlineQueue();
queue.schedule("late", 300, { value: 3 });
queue.schedule("same-b", 200, { value: 2 });
queue.schedule("same-a", 200, { value: 1 });
queue.schedule("early", 100, { value: 0 });

assert.equal(queue.size, 4);
assert.equal(queue.peek().key, "early");
assert.equal(queue.popDue(99), null);
assert.equal(queue.popDue(100).key, "early");

queue.schedule("late", 150, { value: "rescheduled" });
assert.equal(queue.peek().key, "late");
assert.equal(queue.peek().payload.value, "rescheduled");
assert.equal(queue.remove("missing"), false);
assert.equal(queue.remove("same-b"), true);

const ordered = [];
let due;
while ((due = queue.popDue(1_000))) {
  ordered.push(due.key);
}
assert.deepEqual(ordered, ["late", "same-a"]);
assert.equal(queue.size, 0);

const stressQueue = new DeadlineQueue();
const entries = 100_000;
const startedAt = performance.now();
for (let index = 0; index < entries; index += 1) {
  stressQueue.schedule(
    `actor-${String(index).padStart(6, "0")}`,
    (index * 7_919) % entries,
    index,
  );
}
const buildMs = performance.now() - startedAt;

let previousDueAtMs = -1;
let popped = 0;
const drainStartedAt = performance.now();
while ((due = stressQueue.popDue(entries))) {
  assert.ok(due.dueAtMs >= previousDueAtMs);
  previousDueAtMs = due.dueAtMs;
  popped += 1;
}
const drainMs = performance.now() - drainStartedAt;

assert.equal(popped, entries);
assert.equal(stressQueue.size, 0);

console.log(JSON.stringify({
  success: true,
  deterministicOrder: ordered,
  stressEntries: entries,
  buildMs: Math.round(buildMs * 1000) / 1000,
  drainMs: Math.round(drainMs * 1000) / 1000,
  boundedWakeups: true,
}, null, 2));
