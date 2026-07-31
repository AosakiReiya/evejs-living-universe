"use strict";

const assert = require("assert");
const { performance } = require("perf_hooks");

process.env.EVEJS_LIVING_ECONOMY_STOCK_RECONCILE_BATCH_SIZE = "50";

const config = require("../src/config");
config.livingUniverseEnabled = false;
config.livingEconomyEnabled = false;
const economyRuntime = require("../src/space/npc/ambientTraffic/livingEconomyRuntime");
const { createWorkBudget } = require("../src/space/npc/ambientTraffic/livingEconomyWorkBudget");
const { marketDaemonClient } = require("../src/services/market/marketDaemonClient");

async function main() {
  const testing = economyRuntime._testing;
  const shards = testing.REGIONAL_STOCK_SHARDS;
  assert.ok(shards.length >= 30, "regional stock shards were not constructed");
  assert.strictEqual(shards[0].regionID, 10000002, "The Forge should bootstrap first");

  const knownKey = shards[0].keys[0];
  const dirtyKey = shards[1].keys[0];
  testing.setStockCacheForTest([{
    station_id: knownKey.station_id,
    type_id: knownKey.type_id,
    quantity: 100,
    price: 10,
  }]);

  assert.strictEqual(economyRuntime.notifyMarketStockMutation({
    station_id: knownKey.station_id,
    type_id: knownKey.type_id,
    quantity: 73,
    price: 11,
  }), true);
  assert.strictEqual(
    testing.getCachedStockRow(knownKey.station_id, knownKey.type_id).quantity,
    73,
    "known market mutations did not update the cache immediately",
  );

  economyRuntime.notifyMarketStockMutation({
    station_id: dirtyKey.station_id,
    type_id: dirtyKey.type_id,
  });
  assert.strictEqual(testing.getStockCacheStatus().dirtyKeys, 1);

  const requests = [];
  const originalCall = marketDaemonClient.call;
  marketDaemonClient.call = async (method, params) => {
    assert.strictEqual(method, "GetSeedStocks");
    requests.push(params.keys);
    return params.keys.map((key) => ({
      ...key,
      quantity: 42,
      price: 12,
    }));
  };

  try {
    const forcedBudget = createWorkBudget({ budgetMs: 25 });
    assert.strictEqual(await testing.refreshDirtyStock(forcedBudget), 1);
    assert.strictEqual(testing.getStockCacheStatus().dirtyKeys, 0);
    assert.strictEqual(
      testing.getCachedStockRow(dirtyKey.station_id, dirtyKey.type_id).quantity,
      42,
    );

    const regionalBudget = createWorkBudget({ budgetMs: 25 });
    const reconciled = await testing.refreshRegionalStockSlice(regionalBudget, Date.now());
    const configuredBatchSize = testing.getStockCacheStatus().reconcileBatchSize;
    assert.ok(reconciled > 0 && reconciled <= configuredBatchSize);
    const regionalRequest = requests.at(-1);
    assert.strictEqual(regionalRequest.length, reconciled);
    const firstRegionKeys = new Set(shards[0].keys.map(
      (key) => `${key.station_id}:${key.type_id}`,
    ));
    assert.ok(regionalRequest.every(
      (key) => firstRegionKeys.has(`${key.station_id}:${key.type_id}`),
    ), "a reconciliation slice crossed region boundaries");
  } finally {
    marketDaemonClient.call = originalCall;
  }

  const yieldBudget = createWorkBudget({ budgetMs: 0.5 });
  const busyUntil = performance.now() + 2;
  while (performance.now() < busyUntil) {
    // Deliberately consume one small slice so the cooperative yield is observable.
  }
  assert.strictEqual(await yieldBudget.checkpoint(), true);
  const yieldReport = yieldBudget.finish();
  assert.ok(yieldReport.yields >= 1);

  const externalWaitBudget = createWorkBudget({ budgetMs: 4 });
  await externalWaitBudget.checkpoint(true);
  await externalWaitBudget.waitFor(
    "test.timer",
    () => new Promise((resolve) => setTimeout(resolve, 30)),
  );
  const externalWaitReport = externalWaitBudget.finish();
  assert.strictEqual(externalWaitReport.externalWaits, 1);
  assert.ok(externalWaitReport.maximumExternalWaitMs >= 20);
  assert.ok(
    externalWaitReport.maximumSliceMs < externalWaitReport.maximumExternalWaitMs,
    "external service latency was incorrectly counted as uninterrupted JavaScript work",
  );

  assert.strictEqual(
    testing.isNonRetryableStockAdjustmentError(
      new Error("seed stock quantity cannot become negative"),
    ),
    true,
  );
  assert.strictEqual(
    testing.isNonRetryableStockAdjustmentError(new Error("market temporarily unavailable")),
    false,
  );
  const rejectedStock = new Map();
  testing.invalidateRejectedStockReservation(
    rejectedStock,
    { stationID: knownKey.station_id },
    { typeID: knownKey.type_id, priceAnchor: 10 },
    { price: 11 },
  );
  assert.ok(
    testing.getStockCacheStatus().dirtyKeys >= 1,
    "an authoritative underflow rejection did not queue an exact stock refresh",
  );
  assert.strictEqual(
    testing.getStockRow(rejectedStock, knownKey.station_id, knownKey.type_id).quantity,
    0,
  );

  const status = testing.getStockCacheStatus();
  console.log(JSON.stringify({
    ok: true,
    regions: shards.length,
    catalogRows: shards.reduce((total, shard) => total + shard.keys.length, 0),
    reconciliationRows: status.metrics.reconciliationRowsLoaded,
    knownMutationsApplied: status.metrics.knownMutationsApplied,
    dirtyRowsLoaded: status.metrics.dirtyRowsLoaded,
    cooperativeYieldCount: yieldReport.yields,
    maximumSynchronousSliceMs: Math.round(yieldReport.maximumSliceMs * 100) / 100,
    measuredExternalWaitMs: Math.round(externalWaitReport.maximumExternalWaitMs * 100) / 100,
    externalWaitMaximumSynchronousSliceMs:
      Math.round(externalWaitReport.maximumSliceMs * 100) / 100,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
