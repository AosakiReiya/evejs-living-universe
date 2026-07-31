"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";

const assert = require("node:assert/strict");

const spaceRuntime = require("../src/space/runtime");
const npcService = require("../src/space/npc/npcService");
const npcPhysicalBudget = require("../src/space/npc/npcPhysicalBudget");
const conflictRuntime = require("../src/space/npc/ambientTraffic/livingConflictRuntime");
const universeRuntime = require("../src/space/npc/ambientTraffic/livingUniverseRuntime");

const SYSTEM_ID = 30_001_376;

function runVerification() {
  if (spaceRuntime._tickHandle) clearInterval(spaceRuntime._tickHandle);
  const nowMs = Date.now();
  const state = universeRuntime._testing.buildPopulationPlan(4_000, nowMs);
  const encounter = conflictRuntime.forceEncounter(state, nowMs, SYSTEM_ID, {
    isFlightEligible: () => true,
    estimateTravelMs: () => 30_000,
  }, {
    forceMajor: true,
    combatDefendersOnly: true,
    wingFlightCount: 3,
    stagingDelayMs: 1_000,
  });
  assert.ok(encounter, "major conflict must be schedulable");
  assert.equal(encounter.plannedShipCount, 21);

  const activeAtMs = encounter.startsAtMs + 1;
  conflictRuntime.tick(state, activeAtMs, {
    isFlightEligible: () => true,
    isSystemObserved: () => false,
    moveFlightToSystem(flight, systemID) {
      flight.currentSystemID = systemID;
      for (const actorID of flight.actorIDs || []) {
        if (state.actors[actorID]) state.actors[actorID].currentSystemID = systemID;
      }
    },
  });
  assert.equal(encounter.phase, conflictRuntime.PHASE.ACTIVE);

  npcPhysicalBudget._testing.resetForTests({ limits: { global: 180, perSystem: 64 } });
  universeRuntime._testing.setRuntimeStateForTest(state, activeAtMs);
  const scene = spaceRuntime.ensureScene(SYSTEM_ID);
  const observerKey = "living-conflict-materialization-observer";
  scene.sessions.set(observerKey, {
    characterID: 0,
    _space: { systemID: SYSTEM_ID, shipID: 0 },
  });

  const acquisitionBatches = [];
  const removedEntityIDs = [];
  const originalBroadcastAddBalls = scene.broadcastAddBalls.bind(scene);
  const originalRemoveDynamicEntity = scene.removeDynamicEntity.bind(scene);
  scene.broadcastAddBalls = (entities, ...args) => {
    acquisitionBatches.push((entities || []).map((entity) => entity.itemID));
    return originalBroadcastAddBalls(entities, ...args);
  };
  scene.removeDynamicEntity = (entityID, options = {}) => {
    if (options.broadcast === true) removedEntityIDs.push(Number(entityID));
    return originalRemoveDynamicEntity(entityID, options);
  };

  try {
    const result = universeRuntime._testing.materializeConflictEncounter(
      spaceRuntime,
      encounter,
      nowMs + 2_000,
    );
    assert.equal(result.success, true, result.errorMsg || "materialization failed");
    const participantFlightIDs = [
      ...encounter.attackerFlightIDs,
      ...encounter.defenderFlightIDs,
    ];
    const participantFlights = participantFlightIDs.map((flightID) => state.flights[flightID]);
    const parentEntityIDs = participantFlights.flatMap((flight) => flight.entityIDs || []);
    assert.equal(parentEntityIDs.length, 21);
    assert.equal(acquisitionBatches[0].length, 21);
    assert.deepEqual(
      [...acquisitionBatches[0]].sort((left, right) => left - right),
      [...parentEntityIDs].sort((left, right) => left - right),
      "the first client acquisition must contain the complete battle",
    );
    assert.equal(removedEntityIDs.length, 0, "no battle ship may be removed during acquisition");
    assert.ok(participantFlights.every((flight) => flight.materialized === true));
    assert.ok(parentEntityIDs.every((entityID) => (
      npcService.getControllerByEntityID(entityID).runtimeKind === "nativeCombat"
    )), "every battle controller must be promoted from ambient to combat runtime");

    let movingShips = [];
    for (let index = 0; index < 30 && movingShips.length <= 0; index += 1) {
      npcService.tickScene(scene, nowMs + 2_250 + (index * 100));
      movingShips = parentEntityIDs
        .map((entityID) => scene.getEntityByID(entityID))
        .filter((entity) => entity && ["FOLLOW", "ORBIT"].includes(String(entity.mode).toUpperCase()));
    }
    assert.ok(
      movingShips.length > 0,
      `combat AI must issue real subwarp movement commands: ${JSON.stringify(
        parentEntityIDs.slice(0, 4).map((entityID) => {
          const entity = scene.getEntityByID(entityID);
          const controller = npcService.getControllerByEntityID(entityID);
          return {
            entityID,
            mode: entity && entity.mode,
            bubbleID: entity && entity.bubbleID,
            targetEntityID: entity && entity.targetEntityID,
            controllerTargetID: controller && controller.currentTargetID,
            preferredTargetID: controller && controller.preferredTargetID,
            runtimeKind: controller && controller.runtimeKind,
            nextThinkAtMs: controller && controller.nextThinkAtMs,
          };
        }),
      )}`,
    );

    return {
      success: true,
      battleShips: parentEntityIDs.length,
      participantFlights: participantFlights.length,
      firstAcquireShips: acquisitionBatches[0].length,
      acquireBatchesIncludingDrones: acquisitionBatches.length,
      removalsDuringAcquire: removedEntityIDs.length,
      combatControllers: parentEntityIDs.length,
      movingAfterFirstThink: movingShips.length,
      physicalBudget: npcPhysicalBudget.getStatus(),
    };
  } finally {
    universeRuntime._testing.dematerializeConflictEncounter(
      spaceRuntime,
      encounter,
      nowMs + 3_000,
    );
    scene.broadcastAddBalls = originalBroadcastAddBalls;
    scene.removeDynamicEntity = originalRemoveDynamicEntity;
    scene.sessions.delete(observerKey);
    npcPhysicalBudget._testing.resetForTests();
  }
}

if (require.main === module) {
  console.log(JSON.stringify(runVerification(), null, 2));
}

module.exports = { runVerification };
