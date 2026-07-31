"use strict";

const assert = require("assert/strict");

const config = require("../src/config");
config.livingEconomyEnabled = true;
config.livingEconomyRegionalRoutingEnabled = true;
config.livingEconomyMaxActiveJobs = 320;
config.livingEconomyMaxJobsPerPulse = 24;
config.livingEconomyMaxActiveRepositions = 16;
config.livingEconomyMaxRepositionsPerPulse = 2;

const stateStore = require(
  "../src/space/npc/ambientTraffic/livingEconomyState",
);
const catalog = require(
  "../src/space/npc/ambientTraffic/livingEconomyCatalog",
);
const routePlanner = require(
  "../src/space/npc/ambientTraffic/livingEconomyRoutePlanner",
);
const economyRuntime = require(
  "../src/space/npc/ambientTraffic/livingEconomyRuntime",
);

const CURRENT_STATION_ID = 60_000_004;
const SOURCE_STATION_IDS = [60_000_286, 60_000_292];
const DESTINATION_STATION_ID = 60_000_367;

function makeOpportunity(sourceStationID, score) {
  const sourceStation = catalog.getStation(sourceStationID);
  const destinationStation = catalog.getStation(DESTINATION_STATION_ID);
  const good = catalog.TRADE_GOODS[0];
  const routeSpec = routePlanner.buildRouteSpec(
    sourceStation,
    destinationStation,
  );
  assert.ok(sourceStation && destinationStation && good && routeSpec);
  return {
    good,
    sourceStation,
    destinationStation,
    sourceAvailable: 100_000,
    destinationNeeded: 100_000,
    sourceUnitPrice: Math.max(1, Number(good.priceAnchor)),
    destinationUnitPrice: Math.max(2, Number(good.priceAnchor) * 1.1),
    routeSpec,
    jumps: routeSpec.systemIDs.length - 1,
    travelMinutes: routePlanner.getEstimatedTravelMinutes(
      routeSpec.systemIDs.length - 1,
    ),
    score,
  };
}

function makeProfile() {
  return {
    logisticsClass: "secure",
    capacityM3: 100_000,
    shipmentMultiplier: 1,
    maximumCargoValueISK: 1_000_000_000,
    lowSecurityAccess: true,
  };
}

function makeFlight(number) {
  const currentStation = catalog.getStation(CURRENT_STATION_ID);
  const sourceStation = catalog.getStation(SOURCE_STATION_IDS[0]);
  const routeSpec = routePlanner.buildRouteSpec(
    currentStation,
    sourceStation,
  );
  assert.ok(routeSpec);
  return {
    flightID: `VERIFY-HAULER-${String(number).padStart(3, "0")}`,
    family: "hauler",
    phase: "docked",
    materialized: false,
    freightJobID: null,
    routeID: routeSpec.routeID,
    dynamicRouteSpec: routeSpec,
    currentNodeIndex: 0,
    currentSystemID: routeSpec.systemIDs[0],
    direction: 1,
    logisticsProfile: makeProfile(),
    nextTransitionAtMs: 0,
  };
}

function makeLivingState(count) {
  const flights = {};
  for (let index = 1; index <= count; index += 1) {
    const flight = makeFlight(index);
    flights[flight.flightID] = flight;
  }
  return { flights };
}

function installRuntime(state, opportunities, assignmentLog) {
  const testing = economyRuntime._testing;
  testing.setRuntimeStateForTest(state);
  testing.setRoutePlanningOpportunitiesForTest(opportunities, Date.now());
  testing.setFreightAdaptersForTest({
    assignFreightRoute(flight, spec, nowMs) {
      assignmentLog.push({
        flightID: flight.flightID,
        routeID: spec.routeID,
        assignedAtMs: nowMs,
      });
      flight.routeID = spec.routeID;
      flight.dynamicRouteSpec = spec;
      flight.currentNodeIndex = 0;
      flight.currentSystemID = spec.systemIDs[0];
      flight.direction = 1;
      flight.nextTransitionAtMs = nowMs + 5_000;
      return true;
    },
    markLivingStateDirty() {},
  });
}

async function verifySingleSourceAntiSwarm(opportunity, nowMs) {
  const state = stateStore.buildDefaultState(nowMs);
  const livingState = makeLivingState(25);
  const assignments = [];
  installRuntime(state, [opportunity], assignments);
  const stockMap = new Map();

  await economyRuntime._testing.createJobs(
    livingState,
    stockMap,
    nowMs,
    null,
  );

  assert.equal(assignments.length, 1, "one source attracted a hauler swarm");
  assert.equal(Object.keys(state.jobs).length, 0, "empty movement created a freight job");
  assert.equal(stockMap.size, 0, "empty movement changed cached market stock");
  assert.equal(state.metrics.freightRepositionsAssigned, 1);
  assert.equal(state.metrics.jobsCreated, 0);
  assert.equal(state.metrics.unitsReserved, 0);
  const active = economyRuntime._testing.getActiveFreightRepositions(
    livingState,
  );
  assert.equal(active.length, 1);
  const { flight, marker } = active[0];
  assert.equal(marker.targetStationID, SOURCE_STATION_IDS[0]);
  assert.equal(Object.hasOwn(marker, "quantity"), false);
  assert.equal(Object.hasOwn(marker, "price"), false);
  assert.equal(
    economyRuntime.shouldHoldFreightFlight(flight),
    false,
    "an empty reposition was pinned at its departure station",
  );
  assert.equal(
    economyRuntime._testing.settleFreightRepositionAtStation(
      flight,
      CURRENT_STATION_ID,
      nowMs + 1_000,
    ),
    false,
    "a wrong-station arrival completed the reposition",
  );
  assert.equal(
    economyRuntime._testing.settleFreightRepositionAtStation(
      flight,
      SOURCE_STATION_IDS[0],
      nowMs + 2_000,
    ),
    true,
  );
  assert.equal(economyRuntime._testing.getFreightReposition(flight), null);
  assert.equal(state.metrics.freightRepositionsCompleted, 1);
  assert.ok(flight.freightRepositionCooldownUntilMs > nowMs);
  assert.equal(
    economyRuntime.shouldHoldFreightFlight(flight),
    true,
    "an arrived empty hauler departed before cargo was revalidated",
  );
  return { assignments: assignments.length, completed: 1 };
}

async function verifyPerPulseAndGlobalCaps(opportunities, nowMs) {
  const perPulseState = stateStore.buildDefaultState(nowMs);
  const perPulseLivingState = makeLivingState(25);
  const perPulseAssignments = [];
  installRuntime(perPulseState, opportunities, perPulseAssignments);
  await economyRuntime._testing.createJobs(
    perPulseLivingState,
    new Map(),
    nowMs,
    null,
  );
  assert.equal(
    perPulseAssignments.length,
    2,
    "the two-per-pulse reposition cap was not honored",
  );
  assert.deepEqual(
    new Set(
      economyRuntime._testing.getActiveFreightRepositions(perPulseLivingState)
        .map(({ marker }) => marker.targetStationID),
    ),
    new Set(SOURCE_STATION_IDS),
    "the per-source cap did not distribute relocations",
  );

  const globalState = stateStore.buildDefaultState(nowMs);
  globalState.metrics.freightRepositionsAssigned = 16;
  const globalLivingState = makeLivingState(17);
  for (const flight of Object.values(globalLivingState.flights).slice(0, 16)) {
    flight.freightReposition = {
      status: "enroute",
      fromStationID: CURRENT_STATION_ID,
      targetStationID: SOURCE_STATION_IDS[0],
      hintedTypeID: opportunities[0].good.typeID,
      hintedDestinationStationID: DESTINATION_STATION_ID,
      routeID: flight.routeID,
      jumps: 3,
      assignedAtMs: nowMs,
    };
  }
  const globalAssignments = [];
  installRuntime(globalState, opportunities, globalAssignments);
  await economyRuntime._testing.createJobs(
    globalLivingState,
    new Map(),
    nowMs,
    null,
  );
  assert.equal(
    globalAssignments.length,
    0,
    "the global active reposition cap was exceeded",
  );
  return {
    perPulseAssignments: perPulseAssignments.length,
    globalCap: 16,
  };
}

function verifyRouteEligibility(opportunities) {
  const flight = makeFlight(999);
  const profile = makeProfile();
  const selected = routePlanner.chooseRepositionForFlight(
    flight,
    CURRENT_STATION_ID,
    opportunities,
    profile,
    {
      sourceCounts: new Map(),
      maximumAtSource: 1,
      maximumJumps: 12,
      maximumOpportunities: 64,
    },
  );
  assert.ok(selected);
  assert.equal(selected.sourceStation.stationID, SOURCE_STATION_IDS[0]);
  assert.deepEqual(
    selected.repositionRouteSpec.endpointStationIDs,
    [CURRENT_STATION_ID, SOURCE_STATION_IDS[0]],
  );

  const distributed = routePlanner.chooseRepositionForFlight(
    flight,
    CURRENT_STATION_ID,
    opportunities,
    profile,
    {
      sourceCounts: new Map([[SOURCE_STATION_IDS[0], 1]]),
      maximumAtSource: 1,
      maximumJumps: 12,
      maximumOpportunities: 64,
    },
  );
  assert.ok(distributed);
  assert.equal(distributed.sourceStation.stationID, SOURCE_STATION_IDS[1]);

  assert.equal(
    routePlanner.chooseRepositionForFlight(
      flight,
      CURRENT_STATION_ID,
      opportunities,
      profile,
      {
        sourceCounts: new Map(),
        maximumAtSource: 1,
        maximumJumps: 2,
        maximumOpportunities: 64,
      },
    ),
    null,
    "a deadhead route exceeded its jump cap",
  );
  assert.equal(
    routePlanner.chooseRepositionForFlight(
      flight,
      CURRENT_STATION_ID,
      [{ ...opportunities[0], estateDelivery: { projectKey: "VERIFY" } }],
      profile,
      {
        sourceCounts: new Map(),
        maximumAtSource: 1,
        maximumJumps: 12,
        maximumOpportunities: 64,
      },
    ),
    null,
    "estate cargo entered the generic empty-reposition pass",
  );
  return {
    selectedSource: selected.sourceStation.name,
    alternateSource: distributed.sourceStation.name,
    deadheadJumps: selected.repositionJumps,
  };
}

async function main() {
  const nowMs = Date.now();
  const opportunities = [
    makeOpportunity(SOURCE_STATION_IDS[0], 2_000_000),
    makeOpportunity(SOURCE_STATION_IDS[1], 1_000_000),
  ];
  const eligibility = verifyRouteEligibility(opportunities);
  const antiSwarm = await verifySingleSourceAntiSwarm(
    opportunities[0],
    nowMs,
  );
  const caps = await verifyPerPulseAndGlobalCaps(opportunities, nowMs + 10_000);
  economyRuntime._testing.setFreightAdaptersForTest();

  console.log(JSON.stringify({
    success: true,
    cargoReservedBeforeArrival: false,
    marketStockChangedBeforeArrival: false,
    eligibility,
    antiSwarm,
    caps,
    cooldownMs: 5 * 60_000,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
