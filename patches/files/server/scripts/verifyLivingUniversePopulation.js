"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";

const assert = require("assert/strict");

const spaceRuntime = require("../src/space/runtime");
const npcData = require("../src/space/npc/npcData");
const nativeNpcService = require("../src/space/npc/nativeNpcService");
const nativeNpcStore = require("../src/space/npc/nativeNpcStore");
const npcService = require("../src/space/npc/npcService");
const {
  validateGovernedNpcDefinition,
} = require("../src/space/npc/governance/npcDoctrineGovernance");
const {
  LIVING_UNIVERSE_GROUPS,
} = require("../src/space/npc/ambientTraffic/ambientTrafficNpcCatalog");
const livingUniverseRuntime = require("../src/space/npc/ambientTraffic/livingUniverseRuntime");
const livingUniversePilotDirectory = require("../src/space/npc/ambientTraffic/livingUniversePilotDirectory");
const livingAffiliations = require("../src/space/npc/ambientTraffic/livingUniverseAffiliations");
const livingEconomyCatalog = require("../src/space/npc/ambientTraffic/livingEconomyCatalog");
const droneRuntime = require("../src/services/drone/droneRuntime");
const {
  findItemById,
} = require("../src/services/inventory/itemStore");
const worldData = require("../src/space/worldData");

const SYSTEM_ID = 30000142;
const EXPECTED_ROLES = Object.freeze({
  shuttle: 32,
  hauler: 128,
  escort: 8,
  police: 60,
  miner: 88,
  mining_support: 8,
  highsec_pirate: 76,
});

function countBy(records, field) {
  const counts = {};
  for (const record of records) {
    const key = String(record && record[field] || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function verifyPlan() {
  const nowMs = 1_700_000_000_000;
  const state = livingUniverseRuntime._testing.buildPopulationPlan(400, nowMs);
  const actors = Object.values(state.actors);
  const flights = Object.values(state.flights);
  assert.equal(actors.length, 400);
  assert.equal(flights.length, 223);
  assert.deepEqual(countBy(actors, "role"), EXPECTED_ROLES);
  assert.deepEqual(countBy(flights, "family"), {
    shuttle: 32,
    hauler: 124,
    convoy: 4,
    police: 20,
    miner: 24,
    pirate: 19,
  });
  assert.ok(
    flights.filter((flight) => Boolean(flight.campaignID)).length >= 1,
    "authored campaigns must retain a combat presence alongside regional pirate routes",
  );
  assert.ok(
    new Set(flights.map((flight) => flight.routeID)).size >= 25,
    "regional mining must expand the active population beyond the original route set",
  );
  assert.ok(
    flights.every((flight) => flight.actorIDs.length > 0),
    "every flight must own at least one stable actor",
  );
  assert.equal(
    new Set(flights.flatMap((flight) => flight.actorIDs)).size,
    400,
    "actors must belong to exactly one flight",
  );
  assert.ok(
    flights.filter((flight) => ["hauler", "convoy"].includes(flight.family))
      .every((flight) => {
        const route = livingEconomyCatalog.getRoute(flight.routeID) || flight.dynamicRouteSpec;
        const logisticsClass = flight.logisticsProfile && flight.logisticsProfile.logisticsClass;
        return route && route.allowedLogisticsClasses.includes(logisticsClass);
      }),
    "every economic transport must start on a route authorized for its logistics class",
  );
  const homeStationCounts = countBy(actors, "homeStationID");
  const factionCounts = countBy(actors, "factionName");
  assert.ok(
    Object.keys(homeStationCounts).length >= 10,
    "the population must be based from at least ten different stations",
  );
  assert.ok(
    Number(homeStationCounts[60003760] || 0) < actors.length * 0.3,
    "Jita IV-4 still owns too much of the starting population",
  );
  assert.ok(
    Object.keys(factionCounts).length >= 3,
    "home locations and hostile roles must produce multiple factions",
  );
  assert.ok(
    actors.every((actor) => (
      actor.homeStationID > 0 && actor.homeSystemID > 0 &&
      actor.corporationID > 0 && actor.factionID > 0 && actor.raceID > 0
    )),
    "every actor must have a complete home and affiliation",
  );
  assert.ok(
    flights.every((flight) => flight.actorIDs.every((actorID) => {
      const actor = state.actors[actorID];
      return actor.homeStationID === flight.homeStationID &&
        actor.homeSystemID === flight.homeSystemID &&
        actor.corporationID === flight.homeCorporationID &&
        actor.factionID === flight.homeFactionID;
    })),
    "every member of a flight must share its origin and affiliation",
  );
  assert.ok(
    actors.filter((actor) => ["miner", "mining_support"].includes(actor.role)).every((actor) => (
      livingAffiliations.INDUSTRIAL_CORPORATION_IDS.includes(actor.corporationID) ||
      actor.corporationID === actor.homeStationCorporationID
    )),
    "miners and support hulls must work for an industrial or local station corporation",
  );
  const pirateActors = actors.filter((actor) => actor.role === "highsec_pirate");
  const pirateFactionIDs = new Set([500010, 500011, 500012, 500019, 500020]);
  assert.ok(
    pirateActors.every((actor) => (
      pirateFactionIDs.has(actor.factionID) &&
      livingAffiliations.PIRATE_CORPORATION_BY_KEY[actor.pirateFactionKey] === actor.corporationID
    )),
    "regional pirates must use their geographically correct pirate faction and corporation",
  );
  assert.equal(
    new Set(pirateActors.map((actor) => actor.pirateFactionKey)).size,
    5,
    "all five major pirate factions must be represented at the 400-pilot baseline",
  );
  assert.ok(
    actors.every((actor) => {
      const station = worldData.getStationByID(actor.homeStationID);
      return station && Number(station.solarSystemID) === Number(actor.homeSystemID);
    }),
    "every home station must belong to the actor's home system",
  );
  const minmatarActors = actors.filter((actor) => actor.factionID === 500002);
  assert.ok(minmatarActors.length > 0, "Republic space must seed Minmatar pilots");
  assert.ok(
    new Set(minmatarActors.map((actor) => actor.homeSystemID)).size >= 2,
    "Minmatar pilots must be distributed across more than one home system",
  );
  const sampleMiner = actors.find((actor) => actor.role === "miner");
  const sampleMinerProfile = npcData.getNpcProfile(sampleMiner.profileID);
  const sampleIdentity = livingUniversePilotDirectory._testing.buildStablePilotIdentity(
    sampleMiner,
    1,
    sampleMinerProfile,
  );
  assert.equal(sampleIdentity.corporationID, sampleMiner.corporationID);
  assert.equal(sampleIdentity.factionID, sampleMiner.factionID);
  assert.equal(sampleIdentity.raceID, sampleMiner.raceID);
  const phaseCounts = countBy(flights, "phase");
  assert.ok(
    Object.keys(phaseCounts).length >= 5,
    "a reset must distribute flights across at least five lifecycle phases",
  );
  assert.ok(
    new Set(flights.map((flight) => flight.nextTransitionAtMs)).size >= 100,
    "randomized reset transition clocks are still bunched",
  );
  assert.ok(
    flights.every((flight) => Number(flight.nextTransitionAtMs) > nowMs),
    "every randomized reset phase must have a future transition",
  );
  assert.ok(
    flights.every((flight) => flight.actorIDs.every((actorID) => (
      state.actors[actorID].currentSystemID === flight.currentSystemID
    ))),
    "flight members must begin in the same randomized system as their flight",
  );
  const minerPhases = new Set(
    flights.filter((flight) => flight.family === "miner").map((flight) => flight.phase),
  );
  assert.ok(minerPhases.size >= 3, "miners are still bunched into one reset phase");
  const secureFlights = flights.filter((flight) => (
    flight.family === "hauler" && flight.logisticsProfile &&
    flight.logisticsProfile.logisticsClass === "secure"
  ));
  const convoyFlights = flights.filter((flight) => flight.family === "convoy");
  assert.ok(
    secureFlights.length >= 4,
    "the 400-pilot population must include a meaningful solo frontier transport pool",
  );
  assert.ok(
    secureFlights.every((flight) => flight.riskBand !== "highsec"),
    "secure transports must own frontier contracts",
  );
  assert.equal(
    convoyFlights.length,
    4,
    "only four frontier routes should consume dedicated escort pairs",
  );
  assert.ok(
    convoyFlights.every((flight) => flight.riskBand !== "highsec"),
    "dedicated escorts must be reserved for frontier freight",
  );
  assert.ok(
    convoyFlights.every((flight) => {
        const members = flight.actorIDs.map((actorID) => state.actors[actorID]);
        const profileRaces = members.map((actor) => Number(npcData.getNpcProfile(actor.profileID).raceID));
        return members[0].role === "hauler" &&
          members.slice(1).every((actor) => actor.role === "escort") &&
          members[0].pilotSkills.some((skill) => skill.typeID === 19719 && skill.level === 5) &&
          new Set(profileRaces).size === 1;
      }),
    "frontier convoys must use a skilled racial transport with same-race cruiser escorts",
  );
  assert.equal(
    flights.filter((flight) => [
      LIVING_UNIVERSE_GROUPS.convoyStandard,
      LIVING_UNIVERSE_GROUPS.convoyVeteran,
    ].includes(flight.spawnGroupID)).length,
    0,
    "high-security freight must rely on police rather than dedicated escorts",
  );
  assert.equal(
    flights.filter((flight) => (
      flight.logisticsProfile && flight.logisticsProfile.logisticsClass === "trunk"
    )).length,
    1,
    "the 400-pilot population must include one regional trunk freighter",
  );
  assert.ok(
    flights.filter((flight) => flight.spawnGroupID === LIVING_UNIVERSE_GROUPS.minerIce).length >= 1,
    "the population must include supported ice operations",
  );
  assert.equal(
    flights.find((flight) => flight.spawnGroupID === LIVING_UNIVERSE_GROUPS.minerIce).resourceFamily,
    "ice",
  );
  assert.equal(
    flights.filter((flight) => flight.spawnGroupID === LIVING_UNIVERSE_GROUPS.minerLowsec).length,
    2,
    "the population must include two supported frontier mining operations",
  );
  assert.ok(
    flights.filter((flight) => flight.spawnGroupID === LIVING_UNIVERSE_GROUPS.minerLowsec)
      .every((flight) => flight.riskBand !== "highsec"),
    "frontier miners must operate outside high security space",
  );
  const repeat = livingUniverseRuntime._testing.buildPopulationPlan(400, nowMs);
  assert.deepEqual(
    Object.values(repeat.flights).map((flight) => [
      flight.routeID,
      flight.homeStationID,
      flight.homeFactionID,
      flight.currentSystemID,
      flight.phase,
      flight.nextTransitionAtMs,
    ]),
    flights.map((flight) => [
      flight.routeID,
      flight.homeStationID,
      flight.homeFactionID,
      flight.currentSystemID,
      flight.phase,
      flight.nextTransitionAtMs,
    ]),
    "the same reset seed must reproduce the same distribution",
  );
  const nextReset = livingUniverseRuntime._testing.buildPopulationPlan(400, nowMs + 1);
  assert.notDeepEqual(
    Object.values(nextReset.flights).map((flight) => [flight.routeID, flight.homeStationID, flight.phase]),
    flights.map((flight) => [flight.routeID, flight.homeStationID, flight.phase]),
    "a new reset seed must produce a different distribution",
  );
  return state;
}

function verifyRouteGraph() {
  const routes = livingUniverseRuntime._testing.buildRouteDefinitions();
  assert.ok(routes.size >= 90, "the route graph must include the regional mining duty network");
  for (const route of routes.values()) {
    if (route.kind === "network") {
      assert.equal(route.edges.length, route.systemIDs.length - 1);
      for (const edge of route.edges) {
        assert.ok(edge.sourceGateID > 0);
        assert.ok(edge.destinationGateID > 0);
      }
    } else {
      assert.ok(route.station);
      assert.ok(route.dutyAnchor);
    }
  }
  return routes;
}

function verifyDeadlineScheduler(sourceState) {
  const nowMs = 1_700_000_500_000;
  const state = JSON.parse(JSON.stringify(sourceState));
  const flights = Object.values(state.flights);
  for (const flight of flights) {
    flight.materialized = false;
    flight.entityIDs = [];
    flight.phase = livingUniverseRuntime.PHASE.DOCKED;
    flight.nextTransitionAtMs = nowMs + 60_000;
  }
  const target = flights.find((flight) => flight.family === "shuttle");
  target.nextTransitionAtMs = nowMs;
  livingUniverseRuntime._testing.setRuntimeStateForTest(state, nowMs);
  const initialScheduler = livingUniverseRuntime.getSchedulerStatus(nowMs);
  assert.equal(
    initialScheduler.queueSize,
    flights.length,
    "every virtual flight must have exactly one deadline entry",
  );
  assert.equal(initialScheduler.metrics.queueRebuilds, 1);
  assert.equal(initialScheduler.metrics.queueRebuildsByReason.test_state, 1);
  target.nextTransitionAtMs = nowMs + 30_000;
  livingUniverseRuntime._testing.rescheduleChangedFlight(target, nowMs);
  const incrementalScheduler = livingUniverseRuntime.getSchedulerStatus(nowMs);
  assert.equal(incrementalScheduler.queueSize, flights.length);
  assert.equal(
    incrementalScheduler.metrics.queueRebuilds,
    initialScheduler.metrics.queueRebuilds,
    "one changed flight must not rebuild the complete deadline queue",
  );
  assert.equal(incrementalScheduler.metrics.incrementalFlightReschedules, 1);
  assert.equal(
    livingUniverseRuntime._testing.runScheduledFlights(
      { scenes: new Map() },
      nowMs,
      0,
    ).dueProcessed,
    0,
    "an incrementally delayed flight must keep its new deadline",
  );
  target.nextTransitionAtMs = nowMs;
  livingUniverseRuntime._testing.rescheduleChangedFlight(target, nowMs - 1_000);
  const beforeDue = livingUniverseRuntime._testing.runScheduledFlights(
    { scenes: new Map() },
    nowMs - 1,
    0,
  );
  assert.equal(beforeDue.dueProcessed, 0, "a flight must sleep until its deadline");
  const atDue = livingUniverseRuntime._testing.runScheduledFlights(
    { scenes: new Map() },
    nowMs,
    0,
  );
  assert.equal(atDue.dueProcessed, 1, "only the due flight should advance");
  assert.notEqual(target.phase, livingUniverseRuntime.PHASE.DOCKED);
  assert.equal(livingUniverseRuntime.getSchedulerStatus(nowMs).queueSize, flights.length);

  const observedState = JSON.parse(JSON.stringify(sourceState));
  const observedFlights = Object.values(observedState.flights);
  for (const flight of observedFlights) {
    flight.materialized = false;
    flight.entityIDs = [];
    flight.phase = livingUniverseRuntime.PHASE.DOCKED;
    flight.nextTransitionAtMs = nowMs + 60_000;
  }
  const observedSystemID = observedFlights[0].currentSystemID;
  const expectedObserved = observedFlights.filter(
    (flight) => flight.currentSystemID === observedSystemID,
  ).length;
  livingUniverseRuntime._testing.setRuntimeStateForTest(observedState, nowMs);
  const observed = livingUniverseRuntime._testing.runScheduledFlights(
    {
      scenes: new Map([[
        observedSystemID,
        { sessions: new Map([[1, {}]]) },
      ]]),
    },
    nowMs,
    0,
  );
  assert.equal(
    observed.observedProcessed,
    expectedObserved,
    "all flights in a player-occupied system must receive a visibility check",
  );
  assert.equal(observed.dueProcessed, 0);
  return {
    queued: flights.length,
    dueProcessed: atDue.dueProcessed,
    observedProcessed: observed.observedProcessed,
    fullRebuilds: incrementalScheduler.metrics.queueRebuilds,
    incrementalReschedules: incrementalScheduler.metrics.incrementalFlightReschedules,
  };
}

function verifyCatalogAndNativeCreation() {
  const scene = spaceRuntime.ensureScene(SYSTEM_ID);
  assert.ok(scene, "Jita scene must load");
  for (const controller of nativeNpcStore.listNativeControllersForSystem(SYSTEM_ID)) {
    if (String(controller && controller.operatorKind || "") === "livingUniverseVerifier") {
      nativeNpcStore.removeNativeEntityCascade(controller.entityID);
    }
  }
  const profileIDs = new Set();
  for (const spawnGroupID of Object.values(LIVING_UNIVERSE_GROUPS)) {
    const group = npcData.getNpcSpawnGroup(spawnGroupID);
    assert.ok(group, `${spawnGroupID} must resolve`);
    for (const entry of group.entries) {
      profileIDs.add(entry.profileID);
    }
  }
  const created = [];
  const createdByDoctrine = new Map();
  let index = 0;
  for (const profileID of profileIDs) {
    const definition = npcData.buildNpcDefinition(profileID);
    assert.ok(definition, `${profileID} definition must resolve`);
    const governance = validateGovernedNpcDefinition(definition);
    assert.equal(
      governance.success,
      true,
      `${profileID} governance failed: ${governance.errorMsg || "unknown"}`,
    );
    assert.equal(governance.data.governed, true);
    const position = { x: 1_000_000 + (index * 20_000), y: 0, z: 0 };
    const expectedOwnerID = 2_120_061_000 + index;
    const expectedAllianceID = 99_000_061;
    const expectedWarFactionID =
      index % 2 === 0 ? 0 : 500002;
    const result = nativeNpcService.spawnNativeNpcEntityInContext(
      {
        systemID: SYSTEM_ID,
        scene,
        anchorKind: "coordinates",
        anchorLabel: "Living universe verifier",
        anchorEntity: {
          kind: "coordinates",
          itemID: 0,
          itemName: "Living universe verifier",
          position,
          direction: { x: 1, y: 0, z: 0 },
          radius: 0,
        },
      },
      definition,
      {
        transient: true,
        materializeRuntime: true,
        broadcast: false,
        skipInitialBehaviorTick: true,
        runtimeKind: "nativeAmbient",
        operatorKind: "livingUniverseVerifier",
        ownerIDOverride: expectedOwnerID,
        corporationIDOverride: 1000061,
        allianceIDOverride: expectedAllianceID,
        warFactionIDOverride: expectedWarFactionID,
        loadoutSeed: `living-verifier:${profileID}`,
        spawnStateOverride: {
          position,
          velocity: { x: 0, y: 0, z: 0 },
          direction: { x: 1, y: 0, z: 0 },
          targetPoint: position,
          mode: "STOP",
          speedFraction: 0,
        },
      },
    );
    assert.equal(
      result.success,
      true,
      `${profileID} native creation failed: ${result.errorMsg || "unknown"}`,
    );
    assert.ok(result.data.entity);
    assert.equal(result.data.entityRecord.ownerID, expectedOwnerID);
    assert.equal(result.data.entityRecord.corporationID, 1000061);
    assert.equal(
      result.data.entityRecord.allianceID,
      expectedAllianceID,
    );
    assert.equal(
      result.data.entityRecord.warFactionID,
      expectedWarFactionID,
      "an explicit zero war-faction override must clear the authored faction",
    );
    assert.equal(result.data.entity.ownerID, expectedOwnerID);
    assert.equal(result.data.entity.corporationID, 1000061);
    assert.equal(
      result.data.entity.allianceID,
      expectedAllianceID,
    );
    assert.equal(
      result.data.entity.warFactionID,
      expectedWarFactionID,
    );
    assert.equal(result.data.entity.characterID, 0);
    assert.equal(result.data.entity.pilotCharacterID, 0);
    assert.equal(result.data.entity.nativeNpc, true);
    assert.equal(result.data.entity.nativeNpcOccupied, true);
    created.push(result.data.entity.itemID);
    createdByDoctrine.set(definition.loadout.governance.doctrineID, {
      definition,
      entity: result.data.entity,
      entityRecord: result.data.entityRecord,
    });
    assert.equal(result.data.entityRecord.loadoutGoverned, true);
    index += 1;
  }
  const bustard = createdByDoctrine.get("jita_hauler_secure_bustard_v3");
  assert.ok(bustard, "the frontier Bustard doctrine must materialize");
  assert.equal(bustard.entity.skillMap.get(19719).effectiveSkillLevel, 5);
  assert.equal(bustard.entity.skillMap.get(3419).effectiveSkillLevel, 5);
  assert.ok(bustard.entity.shieldCapacity > 0, "the skilled Bustard must have a live shield tank");

  const droneEscort = createdByDoctrine.get("jita_escort_frontier_moa_drone_v3");
  const droneTarget = createdByDoctrine.get("jita_pirate_standard_cormorant_v1");
  assert.ok(droneEscort && droneTarget, "the drone escort and a combat target must materialize");
  const droneLaunch = droneRuntime.spawnTransientNpcDroneWing(
    scene,
    droneEscort.entity,
    droneTarget.entity,
    droneEscort.definition.loadout.governance.droneBay,
    { nowMs: Date.now() },
  );
  assert.equal(
    droneLaunch.success,
    true,
    `frontier escort drone launch failed: ${droneLaunch.errorMsg || JSON.stringify(droneLaunch)}`,
  );
  assert.equal(droneLaunch.droneEntityIDs.length, 3);
  const persistenceProbe = scene.getEntityByID(droneLaunch.droneEntityIDs[0]);
  assert.ok(persistenceProbe, "the transient persistence probe drone must exist");
  assert.equal(
    findItemById(persistenceProbe.itemID),
    null,
    "transient NPC drones must not have durable inventory records",
  );
  assert.equal(
    droneRuntime._testing.persistDroneEntityState(persistenceProbe),
    true,
    "transient NPC drone persistence must be an intentional no-op",
  );
  assert.equal(
    findItemById(persistenceProbe.itemID),
    null,
    "the persistence no-op must not create a durable inventory record",
  );
  assert.equal(
    droneRuntime._testing.persistDroneEntityState({
      ...persistenceProbe,
      itemID: -1,
      transientNpcDrone: false,
    }),
    false,
    "ordinary drones must continue through the durable persistence path",
  );
  const droneCombatTickAtMs = Date.now();
  droneRuntime.tickScene(scene, droneCombatTickAtMs);
  for (const droneID of droneLaunch.droneEntityIDs) {
    const drone = scene.getEntityByID(droneID);
    assert.ok(drone && drone.kind === "drone");
    assert.equal(drone.controllerID, droneEscort.entity.itemID);
    assert.equal(drone.droneCommand, droneRuntime.DRONE_COMMAND_ENGAGE);
    assert.equal(
      drone.targetID,
      droneTarget.entity.itemID,
      "governed transient NPC drones must remain engaged after a combat tick",
    );
    assert.equal(
      findItemById(droneID),
      null,
      "combat ticks must not persist transient NPC drones",
    );
    scene.removeDynamicEntity(droneID, { broadcast: false, persistSpaceState: false });
  }
  for (const entityID of created) {
    const result = npcService.destroyNpcControllerByEntityID(entityID, {
      removeContents: true,
    });
    assert.equal(result.success, true, `failed to clean native verifier entity ${entityID}`);
  }
  const residue = nativeNpcStore.listNativeControllersForSystem(SYSTEM_ID).filter(
    (controller) => String(controller && controller.operatorKind || "") === "livingUniverseVerifier",
  );
  assert.equal(residue.length, 0, "living-universe verifier must leave no native controllers");
  return profileIDs.size;
}

function runVerification() {
  const state = verifyPlan();
  const routes = verifyRouteGraph();
  const scheduler = verifyDeadlineScheduler(state);
  const nativeProfiles = verifyCatalogAndNativeCreation();
  return {
    success: true,
    actors: Object.keys(state.actors).length,
    flights: Object.keys(state.flights).length,
    roles: countBy(Object.values(state.actors), "role"),
    resetPhases: countBy(Object.values(state.flights), "phase"),
    homeStations: countBy(Object.values(state.actors), "homeStationName"),
    factions: countBy(Object.values(state.actors), "factionName"),
    corporations: countBy(Object.values(state.actors), "corporationName"),
    routes: routes.size,
    scheduler,
    nativeProfiles,
  };
}

if (require.main === module) {
  console.log(JSON.stringify(runVerification(), null, 2));
}

module.exports = {
  runVerification,
};
