"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";

const assert = require("assert/strict");

const runtime = require("../src/space/npc/ambientTraffic/livingUniverseRuntime");

function main() {
  const testing = runtime._testing;
  const state = testing.buildPopulationPlan(400, 1_700_000_000_000);
  const actorIDs = Object.keys(state.actors);
  assert.equal(actorIDs.length, 400);
  testing.setRuntimeStateForTest(state, 1_700_000_000_000);
  testing.markPilotActorsDirtyForTest(actorIDs);

  const visibleActorID = actorIDs[actorIDs.length - 1];
  const visibleActor = state.actors[visibleActorID];
  const visibleFlight = state.flights[visibleActor.flightID];
  visibleFlight.materialized = true;

  const selected = testing.takeDirtyPilotActorIDs(16);
  assert.equal(selected.length, 16);
  assert.ok(
    selected.includes(visibleActorID),
    "a materialized pilot was left behind the off-grid synchronization backlog",
  );

  const firstPass = testing.syncPilotPresence({ batchSize: 16 });
  assert.equal(firstPass.fullSync, false);
  assert.equal(firstPass.selected, 16);
  assert.ok(firstPass.synced > 0 && firstPass.synced <= 16);
  assert.equal(firstPass.deferred, 384);

  const status = runtime.getSchedulerStatus(1_700_000_000_000);
  assert.equal(status.dirtyPilotRecords, 384);
  assert.equal(status.pilotSyncBatchSize, testing.getPilotSyncBatchSize());
  assert.equal(status.metrics.pilotSyncDeferredPasses, 1);
  assert.equal(status.metrics.maxDirtyPilotRecords, 400);

  console.log(JSON.stringify({
    success: true,
    configuredBatchSize: status.pilotSyncBatchSize,
    selected: firstPass.selected,
    synchronized: firstPass.synced,
    deferred: firstPass.deferred,
    materializedPilotPrioritized: true,
  }, null, 2));
}

main();
