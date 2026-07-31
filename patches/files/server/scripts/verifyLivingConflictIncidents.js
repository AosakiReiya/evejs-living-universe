"use strict";

const assert = require("assert");
const path = require("path");

const conflictRuntime = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingConflictRuntime",
));

const nowMs = 1_800_000_000_000;
let observed = true;
let materializations = 0;
let distressActivations = 0;
let dispatches = 0;
let arrivals = 0;
let dematerializations = 0;

const state = {
  createdAtMs: nowMs - 60_000,
  nextEncounterNumber: 2,
  nextConflictAtMs: nowMs + 86_400_000,
  actors: {},
  flights: {
    pirate: { flightID: "pirate", encounterID: "LUC-TEST", materialized: false },
    hauler: { flightID: "hauler", encounterID: "LUC-TEST", materialized: false },
    police: { flightID: "police", encounterID: "LUC-TEST", materialized: false },
  },
  encounters: {
    "LUC-TEST": {
      encounterID: "LUC-TEST",
      phase: conflictRuntime.PHASE.ACTIVE,
      targetSystemID: 30_000_142,
      attackerFlightID: "pirate",
      defenderFlightID: "hauler",
      attackerActorIDs: ["pirate_actor"],
      defenderActorIDs: ["hauler_actor"],
      participantSnapshots: {},
      scheduledAtMs: nowMs - 60_000,
      startsAtMs: nowMs - 30_000,
      endsAtMs: nowMs + 600_000,
      observed: false,
      materialized: false,
      victimActorIDs: [],
      evidence: [],
      evidencePending: false,
    },
  },
  metrics: {},
};

const adapters = {
  isSystemObserved() {
    return observed;
  },
  materializeEncounter() {
    materializations += 1;
    return { success: true };
  },
  activateDistress() {
    distressActivations += 1;
    return {
      success: true,
      beaconID: 980_000_000_001,
      position: { x: 1, y: 2, z: 3 },
    };
  },
  dispatchResponse() {
    dispatches += 1;
    return {
      success: true,
      kind: "law_enforcement",
      flightID: "police",
      actorIDs: ["police_actor"],
      sourceSystemID: 30_000_144,
      arrivesAtMs: nowMs + 2_000,
      providerName: "Caldari Navy",
    };
  },
  arriveResponse() {
    arrivals += 1;
    return { success: true };
  },
  collectLiveLosses() {
    return [];
  },
  dematerializeEncounter() {
    dematerializations += 1;
    return { victimActorIDs: [] };
  },
};

conflictRuntime.tick(state, nowMs, adapters);
const encounter = state.encounters["LUC-TEST"];
assert.equal(encounter.observed, true);
assert.equal(encounter.materialized, true);
assert.equal(encounter.distressBeaconActive, true);
assert.equal(encounter.distressBeaconID, 980_000_000_001);
assert.equal(encounter.response.status, "enroute");
assert.equal(encounter.response.flightID, "police");
assert.equal(state.metrics.distressSignalsActivated, 1);
assert.equal(state.metrics.responsesDispatched, 1);

conflictRuntime.tick(state, nowMs + 2_001, adapters);
assert.equal(encounter.response.status, "arrived");
assert.equal(state.metrics.responsesArrived, 1);

observed = false;
conflictRuntime.tick(state, nowMs + 3_000, adapters);
assert.equal(encounter.materialized, false);
assert.equal(encounter.distressBeaconActive, false);

observed = true;
conflictRuntime.tick(state, nowMs + 4_000, adapters);
assert.equal(encounter.materialized, true);
assert.equal(encounter.distressBeaconActive, true);
assert.equal(materializations, 2);
assert.equal(distressActivations, 2);
assert.equal(dispatches, 1);
assert.equal(arrivals, 1);
assert.equal(dematerializations, 1);

console.log(JSON.stringify({
  success: true,
  materializations,
  distressActivations,
  dispatches,
  arrivals,
  dematerializations,
  response: encounter.response,
  metrics: state.metrics,
}, null, 2));
