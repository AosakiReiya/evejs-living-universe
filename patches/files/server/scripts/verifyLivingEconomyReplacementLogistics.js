"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_X_EVE_ENABLED = "false";

const assert = require("assert/strict");

const config = require("../src/config");
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
const {
  marketDaemonClient,
} = require("../src/services/market/marketDaemonClient");

const SOURCE_STATION_ID = 60_003_760;
const REPLACEMENT_STATION_ID = 60_000_004;
const GENERAL_STATION_ID = 60_000_367;
const GOOD_TYPE_ID = 34;
const NOW_MS = 1_784_995_200_000;

const CONFIG_KEYS = [
  "xEveEnabled",
  "livingEconomyEnabled",
  "livingEconomyRegionalRoutingEnabled",
  "livingEconomyMaxActiveJobs",
  "livingEconomyMaxJobsPerPulse",
  "livingEconomyReplacementFreightSharePercent",
  "livingEconomyMaxActiveRepositions",
  "livingEconomyMaxRepositionsPerPulse",
  "familyEstateLogisticsEnabled",
];
const originalConfig = Object.fromEntries(
  CONFIG_KEYS.map((key) => [key, config[key]]),
);
const originalMarketCall = marketDaemonClient.call;
const originalWriteState = stateStore.writeState;

function stockKey(stationID, typeID) {
  return `${Number(stationID)}:${Number(typeID)}`;
}

function configure(maximumJobs) {
  config.xEveEnabled = false;
  config.livingEconomyEnabled = true;
  config.livingEconomyRegionalRoutingEnabled = true;
  config.livingEconomyMaxActiveJobs = maximumJobs;
  config.livingEconomyMaxJobsPerPulse = maximumJobs;
  config.livingEconomyReplacementFreightSharePercent = 75;
  config.livingEconomyMaxActiveRepositions = 0;
  config.livingEconomyMaxRepositionsPerPulse = 0;
  config.familyEstateLogisticsEnabled = false;
}

function getFixtureCatalog() {
  const sourceStation = catalog.getStation(SOURCE_STATION_ID);
  const replacementStation = catalog.getStation(REPLACEMENT_STATION_ID);
  const generalStation = catalog.getStation(GENERAL_STATION_ID);
  const good = catalog.getGood(GOOD_TYPE_ID);
  assert.ok(sourceStation && replacementStation && generalStation && good);
  const replacementRoute = routePlanner.buildRouteSpec(
    sourceStation,
    replacementStation,
  );
  const generalRoute = routePlanner.buildRouteSpec(
    sourceStation,
    generalStation,
  );
  assert.ok(replacementRoute && generalRoute);
  return {
    sourceStation,
    replacementStation,
    generalStation,
    good,
    replacementRoute,
    generalRoute,
  };
}

function makeStockMap(fixture, quantity = 10_000_000) {
  return new Map([
    [
      stockKey(fixture.sourceStation.stationID, fixture.good.typeID),
      {
        station_id: fixture.sourceStation.stationID,
        type_id: fixture.good.typeID,
        quantity,
        price: fixture.good.priceAnchor,
      },
    ],
    [
      stockKey(fixture.replacementStation.stationID, fixture.good.typeID),
      {
        station_id: fixture.replacementStation.stationID,
        type_id: fixture.good.typeID,
        quantity: 0,
        price: fixture.good.priceAnchor,
      },
    ],
    [
      stockKey(fixture.generalStation.stationID, fixture.good.typeID),
      {
        station_id: fixture.generalStation.stationID,
        type_id: fixture.good.typeID,
        quantity: 0,
        price: fixture.good.priceAnchor,
      },
    ],
  ]);
}

function installMarketMock(stockMap) {
  const calls = [];
  const appliedByID = new Map();
  marketDaemonClient.call = async (method, request) => {
    assert.equal(method, "AdjustSeedStock");
    const adjustmentID = String(request.adjustment_id || "");
    calls.push({ method, request: { ...request } });
    if (appliedByID.has(adjustmentID)) {
      return {
        ...appliedByID.get(adjustmentID),
        applied: false,
      };
    }
    const key = stockKey(request.station_id, request.type_id);
    const current = stockMap.get(key) || {
      station_id: Number(request.station_id),
      type_id: Number(request.type_id),
      quantity: 0,
      price: Number(request.new_price) || 1,
    };
    const nextQuantity = request.new_quantity == null
      ? Number(current.quantity) + Number(request.delta_quantity || 0)
      : Number(request.new_quantity);
    if (nextQuantity < 0) {
      throw new Error("seed stock quantity cannot become negative");
    }
    const response = {
      station_id: Number(request.station_id),
      type_id: Number(request.type_id),
      quantity: nextQuantity,
      price: Number(request.new_price) || Number(current.price) || 1,
      applied: true,
    };
    stockMap.set(key, { ...response });
    appliedByID.set(adjustmentID, { ...response });
    return response;
  };
  return calls;
}

function makeOpportunity(
  fixture,
  {
    destination = "general",
    replacement = false,
    priorityDemandKinds = [],
    priorityDemandUnits = 0,
    score = 1,
  } = {},
) {
  const isReplacementDestination = destination === "replacement";
  const destinationStation = isReplacementDestination
    ? fixture.replacementStation
    : fixture.generalStation;
  const routeSpec = isReplacementDestination
    ? fixture.replacementRoute
    : fixture.generalRoute;
  return {
    good: fixture.good,
    sourceStation: fixture.sourceStation,
    destinationStation,
    sourceAvailable: 8_000_000,
    destinationNeeded: 2_000_000,
    sourceUnitPrice: fixture.good.priceAnchor,
    destinationUnitPrice: fixture.good.priceAnchor * 1.25,
    priorityDemandClasses: replacement ? ["replacement"] : [],
    priorityDemandKinds: [...priorityDemandKinds],
    priorityDemandUnits,
    routeSpec,
    jumps: routeSpec.systemIDs.length - 1,
    travelMinutes: routePlanner.getEstimatedTravelMinutes(
      routeSpec.systemIDs.length - 1,
    ),
    score,
  };
}

function makeFlight(fixture, number) {
  return {
    flightID: `VERIFY-REPLACEMENT-HAULER-${String(number).padStart(3, "0")}`,
    family: "hauler",
    phase: "docked",
    materialized: false,
    freightJobID: null,
    routeID: fixture.generalRoute.routeID,
    dynamicRouteSpec: fixture.generalRoute,
    currentNodeIndex: 0,
    currentSystemID: fixture.sourceStation.systemID,
    direction: 1,
    logisticsProfile: {
      logisticsClass: "secure",
      capacityM3: 2_000_000,
      shipmentMultiplier: 1,
      maximumCargoValueISK: 10_000_000_000,
      lowSecurityAccess: true,
    },
    nextTransitionAtMs: NOW_MS + 60_000,
  };
}

function makeLivingState(fixture, count) {
  const flights = {};
  for (let number = 1; number <= count; number += 1) {
    const flight = makeFlight(fixture, number);
    flights[flight.flightID] = flight;
  }
  return { actors: {}, flights };
}

function installRuntime(state, opportunities, assignments) {
  economyRuntime._testing.setRuntimeStateForTest(state);
  economyRuntime._testing.setRoutePlanningOpportunitiesForTest(
    opportunities,
    NOW_MS,
  );
  economyRuntime._testing.setFreightAdaptersForTest({
    assignFreightRoute(flight, routeSpec, nowMs, options = {}) {
      assignments.push({
        flightID: flight.flightID,
        routeID: routeSpec.routeID,
        nowMs,
        options: { ...options },
      });
      flight.routeID = routeSpec.routeID;
      flight.dynamicRouteSpec = routeSpec;
      if (options.preserveProgress !== true) {
        flight.currentNodeIndex = 0;
        flight.currentSystemID = routeSpec.systemIDs[0];
        flight.direction = 1;
      }
      return true;
    },
    markLivingStateDirty() {},
  });
}

function getJobs(state) {
  return Object.values(state.jobs || {});
}

function isReplacementJob(job) {
  return (
    Array.isArray(job && job.priorityDemandClasses) &&
    job.priorityDemandClasses.includes("replacement") &&
    Number(job.replacementPriorityUnits || job.priorityDemandUnits || 0) > 0
  );
}

async function runAssignmentScenario({
  fixture,
  flightCount,
  opportunities,
  maximumJobs,
}) {
  configure(maximumJobs);
  const state = stateStore.buildDefaultState();
  const livingState = makeLivingState(fixture, flightCount);
  const stockMap = makeStockMap(fixture);
  const assignments = [];
  installRuntime(state, opportunities, assignments);
  const marketCalls = installMarketMock(stockMap);
  await economyRuntime._testing.createJobs(
    livingState,
    stockMap,
    NOW_MS,
    null,
  );
  return {
    state,
    livingState,
    stockMap,
    assignments,
    marketCalls,
    jobs: getJobs(state),
    summary: economyRuntime._testing.summarizeFreightPipeline(NOW_MS),
  };
}

async function verifyOneSlotReplacementPriority(fixture) {
  const ordinary = makeOpportunity(fixture, {
    destination: "general",
    replacement: false,
    score: 9_000_000_000,
  });
  const replacement = makeOpportunity(fixture, {
    destination: "replacement",
    replacement: true,
    priorityDemandKinds: ["replacement"],
    priorityDemandUnits: 500_000,
    score: 1,
  });
  const result = await runAssignmentScenario({
    fixture,
    flightCount: 1,
    // The ordinary job is intentionally first and has the higher raw score.
    opportunities: [ordinary, replacement],
    maximumJobs: 1,
  });
  assert.equal(result.jobs.length, 1);
  assert.equal(
    result.jobs[0].destinationStationID,
    fixture.replacementStation.stationID,
    "ordinary stock consumed the sole replacement freight slot",
  );
  assert.equal(isReplacementJob(result.jobs[0]), true);
  assert.deepEqual(result.jobs[0].priorityDemandKinds, ["replacement"]);
  assert.equal(result.marketCalls.length, 1);
  assert.equal(
    result.state.metrics.replacementFreightJobsAssigned,
    1,
  );
  assert.equal(result.state.metrics.generalFreightJobsAssigned, 0);
  assert.equal(result.summary.replacementPriority.activeJobs, 1);
  assert.equal(result.summary.general.activeJobs, 0);
  return {
    selectedDestination: result.jobs[0].destinationName,
    replacementUnits: result.jobs[0].replacementPriorityUnits,
  };
}

async function verifyReplacementProductionInputPriority(fixture) {
  const ordinary = makeOpportunity(fixture, {
    destination: "general",
    score: 9_000_000_000,
  });
  const productionInput = makeOpportunity(fixture, {
    destination: "replacement",
    replacement: true,
    priorityDemandKinds: ["production_input"],
    priorityDemandUnits: 250_000,
    score: 1,
  });
  const result = await runAssignmentScenario({
    fixture,
    flightCount: 1,
    opportunities: [ordinary, productionInput],
    maximumJobs: 1,
  });
  assert.equal(result.jobs.length, 1);
  assert.equal(isReplacementJob(result.jobs[0]), true);
  assert.deepEqual(
    result.jobs[0].priorityDemandKinds,
    ["production_input"],
  );
  assert.deepEqual(
    result.jobs[0].priorityDemandClasses,
    ["replacement"],
    "replacement production-input ancestry was lost at reservation",
  );
  assert.ok(Number(result.jobs[0].replacementPriorityUnits) > 0);
  assert.equal(result.state.metrics.replacementFreightJobsAssigned, 1);
  assert.equal(result.state.metrics.generalFreightJobsAssigned, 0);
  return {
    priorityClass: result.jobs[0].priorityDemandClasses[0],
    demandKind: result.jobs[0].priorityDemandKinds[0],
  };
}

async function verifyQuotaAndWorkConservation(fixture) {
  const makeMixedOpportunities = () => [
    makeOpportunity(fixture, {
      destination: "general",
      score: 9_000_000_000,
    }),
    makeOpportunity(fixture, {
      destination: "replacement",
      replacement: true,
      priorityDemandKinds: ["replacement"],
      priorityDemandUnits: 2_000_000,
      score: 1,
    }),
  ];
  const mixed = await runAssignmentScenario({
    fixture,
    flightCount: 4,
    opportunities: makeMixedOpportunities(),
    maximumJobs: 4,
  });
  assert.equal(mixed.jobs.length, 4);
  assert.equal(
    mixed.jobs.filter(isReplacementJob).length,
    3,
    "75% replacement reservation did not produce three of four jobs",
  );
  assert.equal(
    mixed.jobs.filter((job) => !isReplacementJob(job)).length,
    1,
    "replacement freight starved all ordinary economy work",
  );
  assert.equal(mixed.state.metrics.replacementFreightJobsAssigned, 3);
  assert.equal(mixed.state.metrics.generalFreightJobsAssigned, 1);

  const generalOnly = await runAssignmentScenario({
    fixture,
    flightCount: 4,
    opportunities: [
      makeOpportunity(fixture, {
        destination: "general",
        score: 1,
      }),
    ],
    maximumJobs: 4,
  });
  assert.equal(generalOnly.jobs.length, 4);
  assert.equal(generalOnly.jobs.filter(isReplacementJob).length, 0);

  const replacementOnly = await runAssignmentScenario({
    fixture,
    flightCount: 4,
    opportunities: [
      makeOpportunity(fixture, {
        destination: "replacement",
        replacement: true,
        priorityDemandKinds: ["replacement"],
        priorityDemandUnits: 2_000_000,
        score: 1,
      }),
    ],
    maximumJobs: 4,
  });
  assert.equal(replacementOnly.jobs.length, 4);
  assert.equal(replacementOnly.jobs.filter(isReplacementJob).length, 4);

  return {
    configuredReplacementSharePercent: 75,
    mixed: {
      replacement: mixed.jobs.filter(isReplacementJob).length,
      general: mixed.jobs.filter((job) => !isReplacementJob(job)).length,
    },
    generalOnly: generalOnly.jobs.length,
    replacementOnly: replacementOnly.jobs.length,
  };
}

async function verifyOnRouteMismatchRecovery(fixture) {
  configure(4);
  const jobID = "LEF-VERIFY-STALE-ROUTE";
  const job = {
    jobID,
    kind: "station_freight",
    status: "in_transit",
    routeID: fixture.replacementRoute.routeID,
    routeSpec: JSON.parse(JSON.stringify(fixture.replacementRoute)),
    dynamicRoute: true,
    assignedFlightID: "VERIFY-STALE-HAULER",
    sourceStationID: fixture.sourceStation.stationID,
    destinationStationID: fixture.replacementStation.stationID,
    typeID: fixture.good.typeID,
    typeName: fixture.good.name,
    quantity: 100_000,
    cargoVolume: 1_000,
    logisticsClass: "secure",
    sourceReservationStatus: "applied",
    purchaseValue: 425_000,
    createdAtMs: NOW_MS - (4 * 60 * 60_000),
    reservedAtMs: NOW_MS - (4 * 60 * 60_000),
    lastUpdatedAtMs: NOW_MS - (4 * 60 * 60_000),
    lastFreightProgressAtMs: NOW_MS - (4 * 60 * 60_000),
    lastFreightProgressFingerprint: "prior-progress",
    estimatedTravelMinutes: 5,
    priorityDemandClasses: ["replacement"],
    priorityDemandKinds: ["replacement"],
    priorityDemandUnits: 100_000,
    replacementPriorityUnits: 100_000,
  };
  const mismatchedRoute = {
    ...fixture.replacementRoute,
    routeID: "verify_mismatched_but_on_saved_route",
  };
  const flight = {
    flightID: job.assignedFlightID,
    family: "hauler",
    phase: "virtual_crossing",
    materialized: false,
    freightJobID: jobID,
    routeID: mismatchedRoute.routeID,
    dynamicRouteSpec: mismatchedRoute,
    currentNodeIndex: 0,
    currentSystemID: fixture.replacementRoute.systemIDs[0],
    direction: 1,
    logisticsProfile: {
      logisticsClass: "secure",
      capacityM3: 2_000_000,
      shipmentMultiplier: 1,
      maximumCargoValueISK: 10_000_000_000,
      lowSecurityAccess: true,
    },
    nextTransitionAtMs: NOW_MS - (2 * 60_000),
  };
  const state = stateStore.buildDefaultState();
  state.jobs[jobID] = job;
  const livingState = {
    actors: {},
    flights: { [flight.flightID]: flight },
  };
  const stockMap = makeStockMap(fixture, 9_900_000);
  const assignments = [];
  installRuntime(state, [], assignments);
  const marketCalls = installMarketMock(stockMap);
  const before = {
    status: job.status,
    jobID: job.jobID,
    quantity: job.quantity,
    purchaseValue: job.purchaseValue,
    sourceReservationStatus: job.sourceReservationStatus,
    sourceQuantity: stockMap.get(
      stockKey(fixture.sourceStation.stationID, fixture.good.typeID),
    ).quantity,
  };

  const handled = await economyRuntime._testing.recoverStaleFreightJobs(
    livingState,
    stockMap,
    NOW_MS,
    null,
  );
  assert.ok(Number(handled) >= 1);
  assert.equal(assignments.length, 1);
  assert.equal(assignments[0].routeID, fixture.replacementRoute.routeID);
  assert.equal(assignments[0].options.preserveProgress, true);
  assert.equal(marketCalls.length, 0, "route repair changed conserved market stock");
  assert.equal(job.status, before.status);
  assert.equal(job.jobID, before.jobID);
  assert.equal(job.quantity, before.quantity);
  assert.equal(job.purchaseValue, before.purchaseValue);
  assert.equal(job.sourceReservationStatus, before.sourceReservationStatus);
  assert.equal(flight.freightJobID, jobID);
  assert.equal(
    stockMap.get(
      stockKey(fixture.sourceStation.stationID, fixture.good.typeID),
    ).quantity,
    before.sourceQuantity,
  );
  assert.equal(state.metrics.freightRouteMismatchesDetected, 1);
  assert.equal(state.metrics.freightRoutesRecovered, 1);
  const summary = economyRuntime._testing.summarizeFreightPipeline(NOW_MS);
  assert.equal(summary.recovery.routesRecovered, 1);
  assert.equal(summary.recovery.activeIssues, 0);
  assert.equal(summary.replacementPriority.activeJobs, 1);

  return {
    handled,
    preserveProgress: assignments[0].options.preserveProgress,
    stockAdjustments: marketCalls.length,
    routesRecovered: summary.recovery.routesRecovered,
  };
}

async function main() {
  stateStore.writeState = () => ({ success: true });
  const fixture = getFixtureCatalog();
  try {
    const oneSlot = await verifyOneSlotReplacementPriority(fixture);
    const productionInput =
      await verifyReplacementProductionInputPriority(fixture);
    const quota = await verifyQuotaAndWorkConservation(fixture);
    const recovery = await verifyOnRouteMismatchRecovery(fixture);
    console.log(JSON.stringify({
      success: true,
      oneSlot,
      productionInput,
      quota,
      recovery,
    }, null, 2));
  } finally {
    economyRuntime._testing.setFreightAdaptersForTest();
    marketDaemonClient.call = originalMarketCall;
    stateStore.writeState = originalWriteState;
    for (const [key, value] of Object.entries(originalConfig)) {
      config[key] = value;
    }
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
