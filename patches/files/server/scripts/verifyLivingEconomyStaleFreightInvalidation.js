"use strict";

const assert = require("assert/strict");

const config = require("../src/config");
config.livingUniverseEnabled = false;
config.livingEconomyEnabled = false;

const economyRuntime = require(
  "../src/space/npc/ambientTraffic/livingEconomyRuntime",
);
const {
  marketDaemonClient,
} = require("../src/services/market/marketDaemonClient");

async function main() {
  const testing = economyRuntime._testing;
  const station = { stationID: 60_003_760, name: "Stale Source" };
  const otherStation = { stationID: 60_003_754, name: "Healthy Source" };
  const good = { typeID: 34, name: "Tritanium", priceAnchor: 5 };
  const otherGood = { typeID: 35, name: "Pyerite", priceAnchor: 8 };
  const stockMap = new Map([
    [`${station.stationID}:${good.typeID}`, {
      station_id: station.stationID,
      type_id: good.typeID,
      quantity: 100,
      price: 5.25,
    }],
  ]);
  const staleOpportunities = Array.from({ length: 4 }, (_, index) => ({
    opportunityID: `stale-${index + 1}`,
    sourceStation: station,
    destinationStation: { stationID: 61_000_000 + index },
    good,
    quantity: 250,
    sourceAvailable: 1_000,
  }));
  const healthyOpportunity = {
    opportunityID: "healthy",
    sourceStation: otherStation,
    destinationStation: station,
    good: otherGood,
    quantity: 50,
    sourceAvailable: 500,
  };
  const samePulseReference = [...staleOpportunities, healthyOpportunity];

  testing.setRuntimeStateForTest({
    createdAtMs: 1_784_556_205_276,
    metrics: {
      marketAdjustments: 0,
      failedAdjustments: 0,
    },
  });
  testing.setRoutePlanningOpportunitiesForTest(
    samePulseReference,
    Date.now(),
  );

  const originalCall = marketDaemonClient.call;
  marketDaemonClient.call = async () => {
    throw new Error("seed stock quantity cannot become negative");
  };
  let result;
  try {
    result = await testing.adjustStock({
      adjustmentID: "LEF-stale-regression:reserve",
      station,
      good,
      deltaQuantity: -250,
      reason: "stale freight regression",
      stockMap,
    });
  } finally {
    marketDaemonClient.call = originalCall;
  }

  assert.equal(result.success, false);
  assert.equal(result.retryable, false);
  assert.equal(
    testing.getStockRow(stockMap, station.stationID, good.typeID).quantity,
    0,
    "authoritative underflow must suppress the stale stock row",
  );
  assert.equal(
    testing.getStockCacheStatus().dirtyKeys,
    1,
    "suppressed stock row must be queued for an exact refresh",
  );

  // This is the array createJobs() would still be iterating during the same
  // pulse. All four stale choices must disappear immediately, while unrelated
  // freight remains usable.
  assert.deepEqual(
    samePulseReference.map((entry) => entry.opportunityID),
    ["healthy"],
  );
  const planning = testing.getRoutePlanningForTest();
  assert.equal(planning.opportunities, samePulseReference);
  assert.equal(planning.lastBuiltAtMs, 0);

  console.log(JSON.stringify({
    success: true,
    retryable: result.retryable,
    staleOpportunitiesRemoved: 4,
    samePulseRemaining: samePulseReference.length,
    dirtyKeys: testing.getStockCacheStatus().dirtyKeys,
    routeRebuildForced: planning.lastBuiltAtMs === 0,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
