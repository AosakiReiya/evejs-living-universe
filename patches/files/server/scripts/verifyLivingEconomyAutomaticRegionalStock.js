"use strict";

const assert = require("assert");

const config = require("../src/config");
config.livingUniverseEnabled = false;
config.livingEconomyEnabled = false;

const economyRuntime = require(
  "../src/space/npc/ambientTraffic/livingEconomyRuntime",
);
const { createWorkBudget } = require(
  "../src/space/npc/ambientTraffic/livingEconomyWorkBudget",
);
const { marketDaemonClient } = require(
  "../src/services/market/marketDaemonClient",
);

function stockKey(row) {
  return `${Number(row.station.stationID)}:${Number(row.good.typeID)}`;
}

function responseFor(request, applied = true, quantity = request.new_quantity) {
  return {
    station_id: request.station_id,
    solar_system_id: 30_000_000,
    constellation_id: 20_000_000,
    region_id: 10_000_000,
    type_id: request.type_id,
    quantity,
    initial_quantity: quantity,
    price: request.new_price,
    price_version: 1,
    updated_at: new Date().toISOString(),
    applied,
  };
}

async function main() {
  const testing = economyRuntime._testing;
  const specs = testing.AUTOMATIC_REGIONAL_STOCK_SPECS;
  assert.strictEqual(specs.length, 259);
  assert.ok(specs.every((entry) => entry.initialQuantity > 0));

  const depleted = specs[0];
  const existing = specs[1];
  const racePreserved = specs[2];
  testing.setStockCacheForTest([
    {
      station_id: depleted.station.stationID,
      type_id: depleted.good.typeID,
      quantity: 0,
      price: depleted.good.priceAnchor,
    },
    {
      station_id: existing.station.stationID,
      type_id: existing.good.typeID,
      quantity: 123,
      price: existing.good.priceAnchor,
    },
  ]);

  const calls = [];
  const originalCall = marketDaemonClient.call;
  marketDaemonClient.call = async (method, params) => {
    assert.strictEqual(method, "AdjustSeedStocks");
    calls.push(params.adjustments);
    assert.ok(params.adjustments.length <= 512);
    return params.adjustments.map((request) => {
      assert.strictEqual(request.allow_create, true);
      assert.strictEqual(request.create_only, true);
      assert.strictEqual(request.delta_quantity, null);
      assert.ok(request.new_quantity > 0);
      assert.match(
        request.adjustment_id,
        /^living-economy:auto-regional-stock:v1:\d+:\d+$/,
      );
      if (
        request.station_id === racePreserved.station.stationID &&
        request.type_id === racePreserved.good.typeID
      ) {
        return responseFor(request, false, 0);
      }
      return responseFor(request);
    });
  };

  try {
    const budget = createWorkBudget({ budgetMs: 1 });
    const first = await testing.initializeMissingRegionalStock(
      new Map([
        [
          stockKey(depleted),
          {
            station_id: depleted.station.stationID,
            type_id: depleted.good.typeID,
            quantity: 0,
            price: depleted.good.priceAnchor,
          },
        ],
        [
          stockKey(existing),
          {
            station_id: existing.station.stationID,
            type_id: existing.good.typeID,
            quantity: 123,
            price: existing.good.priceAnchor,
          },
        ],
      ]),
      budget,
      Date.now(),
    );
    assert.strictEqual(first.missingRows, specs.length - 2);
    assert.strictEqual(first.createdRows, specs.length - 3);
    assert.strictEqual(first.preservedRows, 1);
    assert.strictEqual(
      calls.length,
      new Set(specs.slice(2).map((entry) => entry.station.regionID)).size,
    );
    assert.ok(calls.every((batch) => batch.length <= 7));
    const submitted = new Set(calls.flat().map(
      (request) => `${request.station_id}:${request.type_id}`,
    ));
    assert.ok(!submitted.has(stockKey(depleted)));
    assert.ok(!submitted.has(stockKey(existing)));
    assert.ok(submitted.has(stockKey(racePreserved)));

    const completeRows = [
      {
        station_id: depleted.station.stationID,
        type_id: depleted.good.typeID,
        quantity: 0,
        price: depleted.good.priceAnchor,
      },
      {
        station_id: existing.station.stationID,
        type_id: existing.good.typeID,
        quantity: 123,
        price: existing.good.priceAnchor,
      },
      ...calls.flat().map((request) => (
        request.station_id === racePreserved.station.stationID &&
        request.type_id === racePreserved.good.typeID
          ? responseFor(request, false, 0)
          : responseFor(request)
      )),
    ];
    testing.setStockCacheForTest(completeRows);
    let unexpectedCalls = 0;
    marketDaemonClient.call = async () => {
      unexpectedCalls += 1;
      throw new Error("a complete cache must not be initialized twice");
    };
    const second = await testing.initializeMissingRegionalStock(
      new Map(completeRows.map((row) => [
        `${row.station_id}:${row.type_id}`,
        row,
      ])),
      createWorkBudget({ budgetMs: 1 }),
      Date.now(),
    );
    assert.strictEqual(second.missingRows, 0);
    assert.strictEqual(second.createdRows, 0);
    assert.strictEqual(unexpectedCalls, 0);

    testing.setStockCacheForTest([], { ready: false });
    const committedRows = new Map();
    let adjustmentBatchCount = 0;
    let retryStarted = false;
    const retrySubmitted = [];
    marketDaemonClient.call = async (method, params) => {
      if (method === "GetSeedStocks") {
        return params.keys
          .map((key) => committedRows.get(`${key.station_id}:${key.type_id}`))
          .filter(Boolean);
      }
      assert.strictEqual(method, "AdjustSeedStocks");
      adjustmentBatchCount += 1;
      if (adjustmentBatchCount === 2) {
        throw new Error("temporary initialization failure");
      }
      if (retryStarted) {
        retrySubmitted.push(...params.adjustments.map(
          (request) => request.adjustment_id,
        ));
      }
      return params.adjustments.map((request) => {
        const response = responseFor(request);
        committedRows.set(
          `${request.station_id}:${request.type_id}`,
          response,
        );
        return response;
      });
    };
    await assert.rejects(
      testing.bootstrapStockCache(createWorkBudget({ budgetMs: 1 }), Date.now()),
      /temporary initialization failure/,
    );
    const committedBeforeRetry = committedRows.size;
    assert.ok(
      committedBeforeRetry > 0 && committedBeforeRetry < specs.length,
      "the retry test must fail after a partial commit",
    );
    const firstCommitIDs = new Set(
      [...committedRows.values()].map(
        (row) =>
          `living-economy:auto-regional-stock:v1:${row.station_id}:${row.type_id}`,
      ),
    );
    assert.strictEqual(testing.getStockCacheStatus().ready, false);
    assert.strictEqual(
      testing.getStockCacheStatus().automaticRegionalStock.failures,
      1,
    );
    retryStarted = true;
    await testing.bootstrapStockCache(
      createWorkBudget({ budgetMs: 1 }),
      Date.now(),
    );
    const retryStatus = testing.getStockCacheStatus();
    assert.strictEqual(retryStatus.ready, true);
    assert.strictEqual(
      retryStatus.automaticRegionalStock.createdRows,
      specs.length - committedBeforeRetry,
    );
    assert.ok(
      retrySubmitted.every((adjustmentID) => !firstCommitIDs.has(adjustmentID)),
      "already committed regional rows must be loaded instead of resubmitted",
    );
  } finally {
    marketDaemonClient.call = originalCall;
  }

  console.log(JSON.stringify({
    ok: true,
    regionalHubs: new Set(specs.map((entry) => entry.station.stationID)).size,
    candidateRows: specs.length,
    existingPositivePreserved: true,
    existingDepletedPreserved: true,
    racePreserved: true,
    retryAfterPartialCommit: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
