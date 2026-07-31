"use strict";

const assert = require("assert/strict");

const config = require("../src/config");
config.livingUniverseEnabled = false;
config.livingEconomyEnabled = false;
config.xEveEnabled = false;

const economyRuntime = require(
  "../src/space/npc/ambientTraffic/livingEconomyRuntime",
);
const {
  marketDaemonClient,
} = require("../src/services/market/marketDaemonClient");

const NOW_MS = 1_785_000_000_000;
const SOURCE_STATION_ID = 60_003_760;
const DESTINATION_STATION_ID = 60_000_376;
const RECOVERY_STATION_ID = 60_012_109;
const TYPE_ID = 1_957;

const SAVED_ROUTE = Object.freeze({
  routeID: `living_dynamic_${SOURCE_STATION_ID}_${DESTINATION_STATION_ID}`,
  systemIDs: [30_000_142, 30_000_138, 30_001_379, 30_001_376],
  endpointStationIDs: [SOURCE_STATION_ID, DESTINATION_STATION_ID],
  riskBand: "highsec",
  routeClass: "regional",
  lowSecurity: false,
  allowedLogisticsClasses: ["regional", "bulk", "trunk", "secure"],
  dynamic: true,
});

const WRONG_ROUTE = Object.freeze({
  routeID: "regional_hub_10000068_30005302_30005315",
  systemIDs: [30_005_302, 30_005_304, 30_005_305, 30_005_315],
  endpointStationIDs: [60_005_212, RECOVERY_STATION_ID],
  riskBand: "highsec",
  routeClass: "regional",
  lowSecurity: false,
  allowedLogisticsClasses: ["feeder", "regional", "bulk", "trunk", "secure"],
  dynamic: true,
});

function buildMetrics() {
  return {
    jobsCancelled: 0,
    marketAdjustments: 0,
    failedAdjustments: 0,
    staleFreightJobsDetected: 0,
    freightRouteMismatchesDetected: 0,
    freightRoutesRecovered: 0,
    freightRoutesReplanned: 0,
    freightProgressWakeups: 0,
    freightRecoveryDeferred: 0,
    freightRecoveryUnloads: 0,
    freightRecoveryUnitsUnloaded: 0,
    freightRecoveryFailures: 0,
  };
}

function buildJob(jobID, flightID, overrides = {}) {
  return {
    jobID,
    kind: "station_freight",
    status: "in_transit",
    routeID: SAVED_ROUTE.routeID,
    routeSpec: JSON.parse(JSON.stringify(SAVED_ROUTE)),
    assignedFlightID: flightID,
    sourceStationID: SOURCE_STATION_ID,
    destinationStationID: DESTINATION_STATION_ID,
    typeID: TYPE_ID,
    typeName: "Multispectral ECM I",
    quantity: 4,
    cargoVolume: 20,
    logisticsClass: "regional",
    cargoCapacityM3: 12_000,
    maximumCargoValueISK: 100_000_000,
    estimatedTravelMinutes: 5.15,
    purchaseUnitPrice: 117_905.56,
    purchaseValue: 471_622.24,
    sourceReservationStatus: "applied",
    createdAtMs: NOW_MS - (72 * 60 * 60_000),
    reservedAtMs: NOW_MS - (72 * 60 * 60_000),
    lastUpdatedAtMs: NOW_MS - (72 * 60 * 60_000),
    cargoReservationAccountingAtMs: NOW_MS - (72 * 60 * 60_000),
    purchaseAccountingAtMs: NOW_MS - (72 * 60 * 60_000),
    ...overrides,
  };
}

function buildFlight(flightID, overrides = {}) {
  return {
    flightID,
    family: "hauler",
    routeID: WRONG_ROUTE.routeID,
    dynamicRouteSpec: JSON.parse(JSON.stringify(WRONG_ROUTE)),
    currentSystemID: WRONG_ROUTE.systemIDs[0],
    currentNodeIndex: 0,
    direction: 1,
    phase: "virtual_crossing",
    nextTransitionAtMs: NOW_MS + 30_000,
    materialized: false,
    freightJobID: null,
    logisticsProfile: {
      logisticsClass: "regional",
      capacityM3: 12_000,
      shipmentMultiplier: 3,
      maximumCargoValueISK: 100_000_000,
      lowSecurityAccess: false,
    },
    ...overrides,
  };
}

function installState(job, flight) {
  economyRuntime._testing.setRuntimeStateForTest({
    schemaVersion: 3,
    catalogRevision: economyRuntime.CATALOG_REVISION,
    createdAtMs: NOW_MS - (10 * 24 * 60 * 60_000),
    updatedAtMs: NOW_MS,
    nextEventNumber: 1,
    jobs: { [job.jobID]: job },
    replacementDemands: {},
    campaignDemands: {},
    miningDeposits: {},
    events: [],
    metrics: buildMetrics(),
  });
  return {
    actors: {},
    flights: { [flight.flightID]: flight },
  };
}

async function verifyCompatiblePreserveProgress() {
  const job = buildJob("LEF-RECOVERY-COMPATIBLE", "flight-compatible");
  const flight = buildFlight("flight-compatible", {
    currentSystemID: SAVED_ROUTE.systemIDs[2],
    currentNodeIndex: 2,
    freightJobID: job.jobID,
  });
  const livingState = installState(job, flight);
  const stockMap = new Map();
  const manifestBefore = {
    quantity: job.quantity,
    sourceReservationStatus: job.sourceReservationStatus,
    cargoReservationAccountingAtMs: job.cargoReservationAccountingAtMs,
    purchaseAccountingAtMs: job.purchaseAccountingAtMs,
  };
  const assignments = [];
  economyRuntime._testing.setFreightAdaptersForTest({
    assignFreightRoute(candidateFlight, routeSpec, nowMs, options) {
      assignments.push({
        flightID: candidateFlight.flightID,
        routeID: routeSpec.routeID,
        nowMs,
        preserveProgress: options && options.preserveProgress,
      });
      candidateFlight.routeID = routeSpec.routeID;
      candidateFlight.dynamicRouteSpec = JSON.parse(JSON.stringify(routeSpec));
      return true;
    },
    markLivingStateDirty() {},
  });

  const originalCall = marketDaemonClient.call;
  marketDaemonClient.call = async () => {
    throw new Error("compatible route recovery touched market stock");
  };
  try {
    const handled = await economyRuntime._testing.recoverStaleFreightJobs(
      livingState,
      stockMap,
      NOW_MS,
    );
    assert.equal(handled, 1);
  } finally {
    marketDaemonClient.call = originalCall;
  }

  assert.deepEqual(assignments, [{
    flightID: flight.flightID,
    routeID: SAVED_ROUTE.routeID,
    nowMs: NOW_MS,
    preserveProgress: true,
  }]);
  assert.equal(job.status, "in_transit");
  assert.equal(job.routeID, SAVED_ROUTE.routeID);
  assert.equal(flight.routeID, SAVED_ROUTE.routeID);
  assert.deepEqual({
    quantity: job.quantity,
    sourceReservationStatus: job.sourceReservationStatus,
    cargoReservationAccountingAtMs: job.cargoReservationAccountingAtMs,
    purchaseAccountingAtMs: job.purchaseAccountingAtMs,
  }, manifestBefore);
  assert.equal(job.routeRecoveryAttempts, 1);
  assert.equal(job.routeRecoveryError, null);
  assert.equal(
    economyRuntime._testing.summarizeFreightPipeline(NOW_MS)
      .recovery.routesRecovered,
    1,
  );
}

async function verifyMovingOffRouteDefers() {
  const job = buildJob("LEF-RECOVERY-DEFER", "flight-defer");
  const flight = buildFlight("flight-defer", {
    freightJobID: job.jobID,
    phase: "virtual_transit",
  });
  const livingState = installState(job, flight);
  let assignmentCalls = 0;
  economyRuntime._testing.setFreightAdaptersForTest({
    assignFreightRoute() {
      assignmentCalls += 1;
      return true;
    },
    markLivingStateDirty() {},
  });

  const originalCall = marketDaemonClient.call;
  marketDaemonClient.call = async () => {
    throw new Error("moving deferred recovery touched market stock");
  };
  try {
    const handled = await economyRuntime._testing.recoverStaleFreightJobs(
      livingState,
      new Map(),
      NOW_MS,
    );
    assert.equal(handled, 1);
  } finally {
    marketDaemonClient.call = originalCall;
  }

  assert.equal(assignmentCalls, 0);
  assert.equal(job.status, "in_transit");
  assert.equal(job.sourceReservationStatus, "applied");
  assert.equal(
    job.routeRecoveryError,
    "FREIGHT_ROUTE_RECOVERY_WAITING_FOR_DOCK",
  );
  assert.equal(job.routeRecoveryDeferredAtMs, NOW_MS);
  assert.equal(flight.freightJobID, job.jobID);
  assert.equal(
    economyRuntime._testing.summarizeFreightPipeline(NOW_MS)
      .recovery.deferred,
    1,
  );
}

async function verifyIncompatibleDockUnloadIsIdempotent() {
  const job = buildJob("LEF-RECOVERY-UNLOAD", "flight-unload");
  const flight = buildFlight("flight-unload", {
    currentSystemID: WRONG_ROUTE.systemIDs[WRONG_ROUTE.systemIDs.length - 1],
    currentNodeIndex: WRONG_ROUTE.systemIDs.length - 1,
    direction: -1,
    phase: "docked",
    freightJobID: job.jobID,
  });
  const livingState = installState(job, flight);
  const stockKey = `${RECOVERY_STATION_ID}:${TYPE_ID}`;
  const stockMap = new Map([[
    stockKey,
    {
      station_id: RECOVERY_STATION_ID,
      type_id: TYPE_ID,
      quantity: 2,
      price: 117_905.56,
    },
  ]]);
  let assignmentCalls = 0;
  const marketCalls = [];
  economyRuntime._testing.setFreightAdaptersForTest({
    assignFreightRoute() {
      assignmentCalls += 1;
      return true;
    },
    markLivingStateDirty() {},
  });

  const originalCall = marketDaemonClient.call;
  marketDaemonClient.call = async (method, request) => {
    assert.equal(method, "AdjustSeedStock");
    marketCalls.push({ method, request: { ...request } });
    assert.equal(request.station_id, RECOVERY_STATION_ID);
    assert.equal(request.type_id, TYPE_ID);
    assert.equal(request.delta_quantity, job.quantity);
    assert.equal(
      request.adjustment_id,
      `${job.jobID}:stale-recovery-unload:${RECOVERY_STATION_ID}`,
    );
    return {
      station_id: RECOVERY_STATION_ID,
      type_id: TYPE_ID,
      quantity: 2 + job.quantity,
      price: request.new_price,
    };
  };
  try {
    const firstHandled =
      await economyRuntime._testing.recoverStaleFreightJobs(
        livingState,
        stockMap,
        NOW_MS,
      );
    const secondHandled =
      await economyRuntime._testing.recoverStaleFreightJobs(
        livingState,
        stockMap,
        NOW_MS + 60_000,
      );
    assert.equal(firstHandled, 1);
    assert.equal(secondHandled, 0);
  } finally {
    marketDaemonClient.call = originalCall;
  }

  assert.equal(assignmentCalls, 0);
  assert.equal(marketCalls.length, 1);
  assert.equal(job.status, "cancelled");
  assert.equal(job.sourceReservationStatus, "applied");
  assert.equal(job.staleRecoveryUnloadedAtStationID, RECOVERY_STATION_ID);
  assert.equal(job.quantity, 4);
  assert.equal(flight.freightJobID, null);
  assert.equal(
    economyRuntime._testing.getStockRow(
      stockMap,
      RECOVERY_STATION_ID,
      TYPE_ID,
    ).quantity,
    6,
  );
  const freight = economyRuntime._testing.summarizeFreightPipeline(
    NOW_MS + 60_000,
  );
  assert.equal(freight.activeJobs, 0);
  assert.equal(freight.recovery.unloads, 1);
  assert.equal(freight.recovery.unitsUnloaded, 4);
  assert.equal(freight.recovery.failures, 0);
}

async function main() {
  await verifyCompatiblePreserveProgress();
  await verifyMovingOffRouteDefers();
  await verifyIncompatibleDockUnloadIsIdempotent();
  console.log(JSON.stringify({
    success: true,
    compatiblePreserveProgress: true,
    movingOffRouteDeferred: true,
    incompatibleDockUnloadIdempotent: true,
    sourceRefundUsed: false,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
