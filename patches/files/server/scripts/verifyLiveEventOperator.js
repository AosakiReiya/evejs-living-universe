"use strict";

const assert = require("assert/strict");
const path = require("path");

const {
  buildOperatorSnapshot,
  executeOperatorCommand,
} = require(path.join(__dirname, "../src/space/liveEvents/liveEventOperator"));

function run() {
  const calls = [];
  const runtime = {
    getSnapshot() {
      return {
        enabled: true,
        started: true,
        queueSize: 1,
        nextDueAtMs: 2000,
        eventCount: 1,
        countsByPhase: { active: 1 },
        countsByType: { noop: 1 },
        metrics: {
          lastPassDurationMs: 0.25,
          maxPassDurationMs: 0.75,
          failedJobs: 0,
        },
        events: [{
          eventID: "live-event-00000001",
          definitionID: "kernel.noop",
          systemID: 30000142,
          phase: "active",
          eventPhase: "active",
          nextTransitionAtMs: 2000,
        }],
      };
    },
    listDefinitions() {
      return [{ definitionID: "kernel.noop", enabled: false }];
    },
    scheduleEvent(definitionID, options) {
      calls.push(["spawn", definitionID, options]);
      return {
        success: true,
        data: {
          eventID: "live-event-00000002",
          definitionID,
          phase: "scheduled",
        },
      };
    },
    advanceEventNow(eventID) {
      calls.push(["advance", eventID]);
      return {
        success: true,
        data: { eventID, phase: "completed", eventPhase: "completed" },
      };
    },
    requestCleanup(eventID, options) {
      calls.push(["cleanup", eventID, options]);
      return { success: true, data: { eventID, phase: "cleanup" } };
    },
  };
  const physicalBudget = {
    getStatus() {
      return {
        limits: { global: 120, perSystem: 48 },
        reservedShips: 12,
        reservationCount: 3,
      };
    },
  };
  const spaceRuntime = {
    getLastRuntimeTickSummary() {
      return {
        targetTickIntervalMs: 100,
        actualIntervalMs: 110,
        tickDurationMs: 4.5,
        sceneCount: 2,
        tickedSceneCount: 2,
      };
    },
  };
  const options = {
    runtime,
    physicalBudget,
    spaceRuntime,
    session: { _space: { systemID: 30000142 } },
    nowMs: 1000,
  };

  const snapshot = buildOperatorSnapshot(options);
  assert.equal(snapshot.activeEventCount, 1);
  assert.equal(snapshot.physicalBudget.reservedShips, 12);
  assert.equal(snapshot.serverTick.actualIntervalMs, 110);

  assert.match(executeOperatorCommand("status", options).message, /1 active/);
  assert.match(executeOperatorCommand("list", options).message, /live-event-00000001/);
  assert.match(executeOperatorCommand("definitions", options).message, /\[disabled\]/);

  const spawn = executeOperatorCommand("spawn kernel.noop force", options);
  assert.equal(spawn.success, true);
  assert.deepEqual(calls[0], [
    "spawn",
    "kernel.noop",
    {
      systemID: 30000142,
      force: true,
      ignoreCaps: false,
      nowMs: 1000,
    },
  ]);

  assert.equal(
    executeOperatorCommand("advance live-event-00000001", options).success,
    true,
  );
  assert.equal(
    executeOperatorCommand("despawn live-event-00000001", options).success,
    true,
  );
  assert.deepEqual(calls.slice(1).map((call) => call[0]), ["advance", "cleanup", "advance"]);

  process.stdout.write(`${JSON.stringify({
    success: true,
    activeEvents: snapshot.activeEventCount,
    sharedPhysicalShips: snapshot.physicalBudget.reservedShips,
    tickIntervalMs: snapshot.serverTick.actualIntervalMs,
    operatorCalls: calls.length,
  }, null, 2)}\n`);
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

