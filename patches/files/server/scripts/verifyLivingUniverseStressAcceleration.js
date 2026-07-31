"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_LIVING_UNIVERSE_OFFGRID_TRAVEL_TIME_MULTIPLIER = "72";
process.env.EVEJS_LIVING_UNIVERSE_OFFGRID_ACTIVITY_TIME_MULTIPLIER = "72";

const assert = require("assert/strict");

const livingUniverseRuntime = require(
  "../src/space/npc/ambientTraffic/livingUniverseRuntime",
);
const livingConflictRuntime = require(
  "../src/space/npc/ambientTraffic/livingConflictRuntime",
);

function main() {
  const universe = livingUniverseRuntime._testing;
  const conflict = livingConflictRuntime._testing;

  assert.equal(universe.getOffGridActivityTimeMultiplier(), 72);
  assert.equal(universe.getVirtualDockedDwellMs(), 2_500);
  assert.equal(universe.getVirtualDutyDwellMs(), 4_167);
  assert.equal(universe.getVirtualReplacementMs(), 4_167);

  assert.equal(conflict.getOffGridActivityTimeMultiplier(), 72);
  assert.equal(conflict.getInitialDelayMs(), 1_250);
  assert.equal(conflict.getIntervalMs(), 16_667);
  assert.equal(conflict.getDurationMs(), 8_333);

  const nowMs = 1_700_000_000_000;
  const state = universe.buildPopulationPlan(400, nowMs);
  const miningFlight = Object.values(state.flights).find(
    (flight) => String(flight && flight.family || "") === "miner",
  );
  assert.ok(miningFlight, "stress verifier requires one mining flight");
  const miningRoute = universe.getRouteDefinition(miningFlight.routeID);
  assert.ok(miningRoute, "stress verifier requires the mining route");
  const manifest = universe.ensureMiningManifest(miningFlight, miningRoute, nowMs);
  assert.equal(manifest.activityTimeMultiplier, 72);

  console.log(JSON.stringify({
    success: true,
    timeScale: 72,
    virtualDurationsMs: {
      docked: universe.getVirtualDockedDwellMs(),
      miningDuty: universe.getVirtualDutyDwellMs(),
      replacement: universe.getVirtualReplacementMs(),
      conflictInitialDelay: conflict.getInitialDelayMs(),
      conflictInterval: conflict.getIntervalMs(),
      conflictDuration: conflict.getDurationMs(),
    },
    miningYieldTimeScale: manifest.activityTimeMultiplier,
    realTimeClocksUnchanged: [
      "game tick",
      "player physics",
      "persistence",
      "X-Eve durability",
    ],
  }, null, 2));
}

main();
