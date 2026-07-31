"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";

const assert = require("assert/strict");

const spaceRuntime = require("../src/space/runtime");
const miningNpcOperations = require("../src/services/mining/miningNpcOperations");
const livingUniverseRuntime = require("../src/space/npc/ambientTraffic/livingUniverseRuntime");
const npcEquipment = require("../src/space/npc/npcEquipment");

function addVectors(left, right) {
  return {
    x: Number(left.x || 0) + Number(right.x || 0),
    y: Number(left.y || 0) + Number(right.y || 0),
    z: Number(left.z || 0) + Number(right.z || 0),
  };
}

function scaleVector(vector, scalar) {
  return {
    x: Number(vector.x || 0) * scalar,
    y: Number(vector.y || 0) * scalar,
    z: Number(vector.z || 0) * scalar,
  };
}

function attachObserver(scene, key) {
  scene.sessions.set(key, {
    characterID: 0,
    _space: {
      systemID: scene.systemID,
      shipID: 0,
    },
  });
}

function cloneMovementState(entity) {
  return {
    position: { ...entity.position },
    targetPoint: { ...entity.targetPoint },
    mode: String(entity.mode || ""),
    targetEntityID: Number(entity.targetEntityID || 0),
    followRange: Number(entity.followRange || 0),
    orbitDistance: Number(entity.orbitDistance || 0),
  };
}

function runVerification() {
  if (spaceRuntime._tickHandle) {
    clearInterval(spaceRuntime._tickHandle);
  }
  const now = Date.now();
  const state = livingUniverseRuntime._testing.buildPopulationPlan(400, now);
  for (const flight of Object.values(state.flights)) {
    flight.nextTransitionAtMs = now + 3_600_000;
  }
  livingUniverseRuntime._testing.setRuntimeStateForTest(state);
  const touchedFlights = [];
  const touchedScenes = [];
  const results = {
    stationDeparture: false,
    naturalAlignment: false,
    gateArrival: false,
    observedVirtualCrossing: false,
    miningEffectBinding: false,
    npcEntityEffectBinding: false,
    miningDuty: false,
    miningSupportJetcan: false,
  };

  const nativeNpcPresentation = {
    itemID: 980000000001,
    typeID: 21983,
    kind: "ship",
    nativeNpc: true,
  };
  const combatBinding = spaceRuntime._testing.resolveSpecialFxOptionsForEntityForTesting(
    nativeNpcPresentation.itemID,
    {
      moduleID: 980100000001,
      moduleTypeID: 10678,
      weaponFamily: "hybridTurret",
    },
    nativeNpcPresentation,
    "effects.HybridFired",
  );
  const miningBinding = spaceRuntime._testing.resolveSpecialFxOptionsForEntityForTesting(
    nativeNpcPresentation.itemID,
    {
      moduleID: 980100000001,
      moduleTypeID: 483,
      useFittedModuleSpecialFxBinding: true,
    },
    nativeNpcPresentation,
    "effects.Mining",
  );
  const boosterBinding = spaceRuntime._testing.resolveSpecialFxOptionsForEntityForTesting(
    nativeNpcPresentation.itemID,
    {
      moduleID: 980100000002,
      moduleTypeID: 10836,
    },
    nativeNpcPresentation,
    "effects.ShieldBoosting",
  );
  const assistanceBinding =
    spaceRuntime._testing.resolveSpecialFxOptionsForEntityForTesting(
      nativeNpcPresentation.itemID,
      {
        moduleID: 980100000003,
        moduleTypeID: 3586,
      },
      nativeNpcPresentation,
      "effects.ShieldTransfer",
    );
  const syntheticWarpScrambleEffect =
    spaceRuntime._testing.resolveGenericModuleActivationEffectForTesting(
      {
        itemID: 980000000001000,
        typeID: nativeNpcPresentation.typeID,
        npcSyntheticHullModule: true,
      },
      {
        typeID: nativeNpcPresentation.typeID,
      },
      "warpScrambleForEntity",
    );
  assert.equal(combatBinding.moduleID, nativeNpcPresentation.itemID);
  assert.equal(combatBinding.moduleTypeID, nativeNpcPresentation.typeID);
  assert.equal(combatBinding.graphicInfo, 10678);
  assert.equal(miningBinding.moduleID, 980100000001);
  assert.equal(miningBinding.moduleTypeID, 483);
  assert.equal(miningBinding.graphicInfo, undefined);
  assert.equal(boosterBinding.moduleID, nativeNpcPresentation.itemID);
  assert.equal(boosterBinding.moduleTypeID, nativeNpcPresentation.typeID);
  assert.equal(boosterBinding.graphicInfo, 395);
  assert.equal(assistanceBinding.moduleID, nativeNpcPresentation.itemID);
  assert.equal(assistanceBinding.moduleTypeID, nativeNpcPresentation.typeID);
  assert.equal(assistanceBinding.graphicInfo, 3586);
  results.miningEffectBinding = true;
  assert.equal(syntheticWarpScrambleEffect.name, "warpScrambleForEntity");
  assert.equal(syntheticWarpScrambleEffect.guid, "effects.WarpScramble");
  const entityEwarModules = npcEquipment.getNpcHostileModules({
    itemID: 980000000002,
    typeID: 94177,
    groupID: 446,
    categoryID: 11,
    kind: "ship",
    nativeNpc: true,
    fittedItems: [],
  });
  assert.ok(entityEwarModules.length >= 2);
  const entityEwarModuleIDs = entityEwarModules.map((entry) => entry.moduleItem.itemID);
  assert.equal(entityEwarModuleIDs.every(Number.isSafeInteger), true);
  assert.equal(new Set(entityEwarModuleIDs).size, entityEwarModuleIDs.length);
  for (const entry of entityEwarModules) {
    const resolvedEffect =
      spaceRuntime._testing.resolveGenericModuleActivationEffectForTesting(
        entry.moduleItem,
        entry.moduleItem,
        entry.effectName,
      );
    assert.ok(resolvedEffect);
    assert.notEqual(resolvedEffect.guid, "effects.Laser");
  }
  results.npcEntityEffectBinding = true;

  try {
    const departureFlight = Object.values(state.flights).find((flight) => (
      flight.family === "shuttle"
    ));
    assert.ok(departureFlight, "Jita shuttle departure flight must exist");
    departureFlight.routeID = "jita_maurasi";
    const departureRoute = livingUniverseRuntime._testing.getRouteDefinition(departureFlight.routeID);
    const jitaScene = spaceRuntime.ensureScene(30000142);
    assert.ok(jitaScene);
    attachObserver(jitaScene, "living-universe-departure-observer");
    touchedScenes.push([jitaScene, "living-universe-departure-observer"]);
    touchedFlights.push(departureFlight);
    // The distributed-origin population may have reached Jita from Maurasi.
    // This fixture specifically exercises a new outbound Jita departure.
    departureFlight.currentNodeIndex = 0;
    departureFlight.currentSystemID = 30000142;
    departureFlight.direction = 1;
    departureFlight.phase = livingUniverseRuntime.PHASE.DOCKED;
    departureFlight.nextTransitionAtMs = now;
    livingUniverseRuntime._testing.tickVirtual(
      spaceRuntime,
      departureRoute,
      departureFlight,
      now,
    );
    assert.equal(departureFlight.materialized, true);
    assert.equal(departureFlight.phase, livingUniverseRuntime.PHASE.STATION_DEPARTURE);
    assert.equal(departureFlight.entityIDs.length, 1);
    const departureEntity = jitaScene.getEntityByID(departureFlight.leadEntityID);
    assert.ok(departureEntity);
    const departureActor = state.actors[departureFlight.actorIDs[0]];
    assert.equal(departureEntity.livingUniverseActorID, departureActor.actorID);
    assert.equal(departureEntity.corporationID, departureActor.corporationID);
    assert.equal(departureEntity.warFactionID, departureActor.factionID);
    assert.match(departureEntity.itemName, new RegExp(departureActor.corporationName));
    assert.equal(String(departureEntity.mode).toUpperCase(), "GOTO");
    results.stationDeparture = true;

    departureEntity.position = addVectors(
      departureFlight.poweredUndock.origin,
      scaleVector(departureEntity.direction, departureFlight.poweredUndock.clearanceMeters + 1_000),
    );
    departureFlight.nextTransitionAtMs = now;
    livingUniverseRuntime._testing.tickPhysical(
      spaceRuntime,
      departureRoute,
      departureFlight,
      now + 1_000,
    );
    assert.equal(departureFlight.phase, livingUniverseRuntime.PHASE.ALIGNING);
    assert.ok(departureFlight.warpPlan);
    for (const order of departureFlight.warpPlan.orders) {
      order.issueAtMs = now;
    }
    departureFlight.nextTransitionAtMs = now + 120_000;
    livingUniverseRuntime._testing.tickPhysical(
      spaceRuntime,
      departureRoute,
      departureFlight,
      now + 2_000,
    );
    assert.equal(departureFlight.phase, livingUniverseRuntime.PHASE.WARPING_TO_GATE);
    assert.ok(departureEntity.pendingWarp || departureEntity.mode === "WARP");
    results.naturalAlignment = true;
    livingUniverseRuntime._testing.cleanupPhysicalFlight(departureFlight);
    // The production scheduler resets this counter once per server tick. This
    // verifier invokes two independent visibility slices synchronously, so
    // reset the test runtime between them when the live cap is one spawn batch.
    livingUniverseRuntime._testing.setRuntimeStateForTest(state);

    departureFlight.currentNodeIndex = 1;
    departureFlight.currentSystemID = 30000140;
    departureFlight.direction = 1;
    departureFlight.phase = livingUniverseRuntime.PHASE.VIRTUAL_TRANSIT;
    departureFlight.nextTransitionAtMs = now;
    const maurasiScene = spaceRuntime.ensureScene(30000140);
    attachObserver(maurasiScene, "living-universe-arrival-observer");
    touchedScenes.push([maurasiScene, "living-universe-arrival-observer"]);
    livingUniverseRuntime._testing.tickVirtual(
      spaceRuntime,
      departureRoute,
      departureFlight,
      now + 3_000,
    );
    assert.equal(
      departureFlight.materialized,
      true,
      `gate arrival failed: ${JSON.stringify({
        phase: departureFlight.phase,
        lastError: departureFlight.lastError,
        systemID: departureFlight.currentSystemID,
        canMaterialize: livingUniverseRuntime._testing.canMaterialize(departureFlight),
        physicalBudget: livingUniverseRuntime.getStatus().physicalBudget,
      })}`,
    );
    assert.equal(departureFlight.phase, livingUniverseRuntime.PHASE.GATE_ARRIVAL);
    const arrivalEntity = maurasiScene.getEntityByID(departureFlight.leadEntityID);
    assert.ok(arrivalEntity && arrivalEntity.sessionlessWarpIngress);
    results.gateArrival = true;
    livingUniverseRuntime._testing.cleanupPhysicalFlight(departureFlight);

    const crossingFlight = Object.values(state.flights).find((flight) => (
      flight.family === "hauler" &&
      String(flight.logisticsProfile && flight.logisticsProfile.logisticsClass || "") === "secure"
    ));
    assert.ok(crossingFlight, "Jita-Tama crossing flight must exist");
    crossingFlight.routeID = "jita_tama";
    livingUniverseRuntime._testing.setRuntimeStateForTest(state);
    const crossingRoute = livingUniverseRuntime._testing.getRouteDefinition(crossingFlight.routeID);
    const niyabainenScene = spaceRuntime.ensureScene(30000143);
    attachObserver(niyabainenScene, "living-universe-crossing-observer");
    touchedScenes.push([niyabainenScene, "living-universe-crossing-observer"]);
    touchedFlights.push(crossingFlight);
    crossingFlight.currentNodeIndex = 1;
    crossingFlight.currentSystemID = 30000143;
    crossingFlight.direction = 1;
    crossingFlight.phase = livingUniverseRuntime.PHASE.VIRTUAL_CROSSING;
    crossingFlight.nextTransitionAtMs = now + 120_000;
    livingUniverseRuntime._testing.tickVirtual(
      spaceRuntime,
      crossingRoute,
      crossingFlight,
      now + 4_000,
    );
    assert.equal(crossingFlight.materialized, true);
    assert.equal(crossingFlight.phase, livingUniverseRuntime.PHASE.GATE_ARRIVAL);
    assert.ok(niyabainenScene.getEntityByID(crossingFlight.leadEntityID));
    results.observedVirtualCrossing = true;
    livingUniverseRuntime._testing.cleanupPhysicalFlight(crossingFlight);

    const minerFlight = Object.values(state.flights).find((flight) => (
      flight.family === "miner" &&
      flight.miningSupportProfile &&
      flight.resourceFamily === "ore" &&
      flight.riskBand === "highsec"
    ));
    assert.ok(minerFlight, "a supported high-security mining flight must exist");
    // Production resets the materialization budget every one-second scheduler
    // tick. This isolated verifier advances three separate lifecycle moments
    // synchronously, so start a fresh scheduler budget for mining duty.
    livingUniverseRuntime._testing.setRuntimeStateForTest(state);
    const minerRoute = livingUniverseRuntime._testing.getRouteDefinition(minerFlight.routeID);
    const miningScene = spaceRuntime.ensureScene(minerRoute.systemID);
    attachObserver(miningScene, "living-universe-mining-observer");
    touchedScenes.push([miningScene, "living-universe-mining-observer"]);
    const originalMiningBroadcastAddBalls = miningScene.broadcastAddBalls.bind(miningScene);
    const broadcastMiningMovementByEntityID = new Map();
    miningScene.broadcastAddBalls = (entities, ...args) => {
      for (const entity of Array.isArray(entities) ? entities : []) {
        broadcastMiningMovementByEntityID.set(entity.itemID, cloneMovementState(entity));
      }
      return originalMiningBroadcastAddBalls(entities, ...args);
    };
    touchedFlights.push(minerFlight);
    minerFlight.phase = livingUniverseRuntime.PHASE.DUTY;
    minerFlight.currentNodeIndex = 0;
    minerFlight.currentSystemID = minerRoute.systemID;
    minerFlight.nextTransitionAtMs = now + 300_000;
    livingUniverseRuntime._testing.tickVirtual(
      spaceRuntime,
      minerRoute,
      minerFlight,
      now + 4_000,
    );
    assert.equal(minerFlight.materialized, true);
    assert.equal(minerFlight.phase, livingUniverseRuntime.PHASE.DUTY_LIVE);
    assert.equal(minerFlight.entityIDs.length, 4);
    for (const entityID of minerFlight.entityIDs) {
      const entity = miningScene.getEntityByID(entityID);
      assert.ok(entity, `materialized mining entity ${entityID} must exist`);
      assert.deepEqual(
        broadcastMiningMovementByEntityID.get(entityID),
        cloneMovementState(entity),
        "mining ships must not change authoritative movement state after AddBalls",
      );
      assert.equal(String(entity.mode).toUpperCase(), "ORBIT");
      assert.equal(Number(entity.targetEntityID), Number(minerRoute.dutyAnchorID));
    }
    miningScene.broadcastAddBalls = originalMiningBroadcastAddBalls;
    const registeredFleet = miningNpcOperations.getMiningFleetsForSystem(minerRoute.systemID).find(
      (fleet) => fleet.fleetID === minerFlight.miningFleetID,
    );
    assert.ok(registeredFleet, "materialized miner wing must register with the real mining runtime");
    const expectedMinerEntityIDs = minerFlight.actorIDs
      .map((actorID) => state.actors[actorID])
      .filter((actor) => actor.role === "miner")
      .map((actor) => actor.liveEntityID);
    assert.deepEqual(registeredFleet.minerEntityIDs, expectedMinerEntityIDs);
    assert.equal(expectedMinerEntityIDs.length, 3);
    assert.equal(registeredFleet.onGridSupport, true);
    assert.equal(registeredFleet.haulerEntityIDs.length, 1);
    assert.ok(expectedMinerEntityIDs.every((entityID) => {
      const entity = miningScene.getEntityByID(entityID);
      return entity && entity.npcMiningSupportBonus &&
        entity.npcMiningSupportBonus.sourceEntityID > 0;
    }), "materialized miners must receive their authored command-ship support bonus");
    const supportEntity = miningScene.getEntityByID(registeredFleet.haulerEntityIDs[0]);
    assert.ok(supportEntity, "supported mining flight must materialize its command ship");
    assert.ok(
      supportEntity.fittedItems.some((moduleItem) => Number(moduleItem.typeID) === 24348),
      "mining command ship must fit a Small Tractor Beam I",
    );
    const cargoMiner = miningScene.getEntityByID(expectedMinerEntityIDs[0]);
    const cargoQuantity = Math.ceil(
      miningNpcOperations.getNpcCargoCapacityM3ForTypeID(cargoMiner.typeID, 5_000) /
      0.1,
    );
    miningNpcOperations.appendNpcMiningCargo(cargoMiner, 1230, cargoQuantity);
    const supportHooks = {
      buildNpcPseudoSession(entity) {
        return {
          characterID: Number(entity.pilotCharacterID || entity.characterID || 0),
          corporationID: Number(entity.corporationID || 0),
          allianceID: Number(entity.allianceID || 0),
          _space: {
            systemID: Number(entity.systemID || 0),
            shipID: Number(entity.itemID || 0),
          },
        };
      },
    };
    miningNpcOperations._testing.processOnGridMiningSupport(
      miningScene,
      registeredFleet,
      now + 6_000,
      supportHooks,
    );
    assert.equal(registeredFleet.jetcansCreated, 1);
    assert.equal(miningNpcOperations.getNpcOreCargoSummary(cargoMiner).quantity, 0);
    const jetcanRecord = Object.values(registeredFleet.jetcanRecordsByID)[0];
    assert.ok(jetcanRecord && jetcanRecord.containerID > 0);
    const jetcanEntity = miningScene.getEntityByID(jetcanRecord.containerID);
    assert.ok(jetcanEntity && jetcanEntity.kind === "container");
    jetcanEntity.position = { ...supportEntity.position };
    miningNpcOperations._testing.processOnGridMiningSupport(
      miningScene,
      registeredFleet,
      now + 7_000,
      supportHooks,
    );
    miningNpcOperations._testing.processOnGridMiningSupport(
      miningScene,
      registeredFleet,
      now + 16_000,
      supportHooks,
    );
    assert.equal(registeredFleet.jetcansCollected, 1);
    assert.equal(Object.keys(registeredFleet.jetcanRecordsByID).length, 0);
    assert.equal(
      miningNpcOperations.getNpcOreCargoSummary(supportEntity).quantity,
      cargoQuantity,
    );
    results.miningSupportJetcan = true;
    results.miningDuty = true;
    livingUniverseRuntime._testing.cleanupPhysicalFlight(minerFlight);

    const iceFlight = Object.values(state.flights).find((flight) => (
      flight.family === "miner" && flight.resourceFamily === "ice"
    ));
    assert.ok(iceFlight, "the Halaima ice flight must exist");
    livingUniverseRuntime._testing.setRuntimeStateForTest(state);
    const iceRoute = livingUniverseRuntime._testing.getRouteDefinition(iceFlight.routeID);
    const iceScene = spaceRuntime.ensureScene(iceRoute.systemID);
    attachObserver(iceScene, "living-universe-ice-observer");
    touchedScenes.push([iceScene, "living-universe-ice-observer"]);
    const iceSiteReconcile = spaceRuntime.reconcileUniverseSitesForAwakeScene(iceScene, {
      synchronousUniverseSiteReconcile: true,
      force: true,
      nowMs: now + 5_000,
    });
    assert.equal(iceSiteReconcile.success, true);
    touchedFlights.push(iceFlight);
    iceFlight.phase = livingUniverseRuntime.PHASE.DUTY;
    iceFlight.currentNodeIndex = 0;
    iceFlight.currentSystemID = iceRoute.systemID;
    iceFlight.nextTransitionAtMs = now + 300_000;
    livingUniverseRuntime._testing.tickVirtual(
      spaceRuntime,
      iceRoute,
      iceFlight,
      now + 5_000,
    );
    assert.equal(
      iceFlight.materialized,
      true,
      `ice flight did not materialize: ${iceFlight.lastError || "unknown"}; anchor=${Boolean(iceScene.getEntityByID(iceRoute.dutyAnchorID))}`,
    );
    assert.equal(iceFlight.phase, livingUniverseRuntime.PHASE.DUTY_LIVE);
    assert.ok(iceScene.getEntityByID(iceRoute.dutyAnchorID), "generated ice-site anchor is missing");
    assert.ok(
      iceScene.staticEntities.filter((entity) => entity.miningYieldKind === "ice").length >= 12,
      "Halaima must materialize its deterministic White Glaze field",
    );
    const iceFleet = miningNpcOperations.getMiningFleetsForSystem(iceRoute.systemID).find(
      (fleet) => fleet.fleetID === iceFlight.miningFleetID,
    );
    assert.ok(iceFleet, "materialized ice wing must register with the real mining runtime");
    assert.equal(iceFleet.minerEntityIDs.length, 3);
    assert.ok(iceFleet.minerEntityIDs.every((entityID) => (
      iceScene.getEntityByID(entityID).npcMiningSupportBonus.supportClass === "orca"
    )));
    results.iceDuty = true;
    livingUniverseRuntime._testing.cleanupPhysicalFlight(iceFlight);

    return {
      success: true,
      ...results,
      departureEntityCount: departureFlight.actorIDs.length,
      miningEntityCount: minerFlight.actorIDs.length,
      iceEntityCount: iceFlight.actorIDs.length,
    };
  } finally {
    for (const flight of touchedFlights) {
      if (flight.materialized) {
        livingUniverseRuntime._testing.cleanupPhysicalFlight(flight);
      }
    }
    for (const [scene, key] of touchedScenes) {
      scene.sessions.delete(key);
    }
  }
}

if (require.main === module) {
  console.log(JSON.stringify(runVerification(), null, 2));
}

module.exports = {
  runVerification,
};
