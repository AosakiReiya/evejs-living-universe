"use strict";

const assert = require("assert/strict");

const catalog = require("../src/space/npc/ambientTraffic/livingEconomyCatalog");
const telemetry = require("../src/space/npc/ambientTraffic/livingEconomyTelemetry");
const economyRuntime = require("../src/space/npc/ambientTraffic/livingEconomyRuntime");
const economyStateStore = require("../src/space/npc/ambientTraffic/livingEconomyState");
const { createWorkBudget } = require("../src/space/npc/ambientTraffic/livingEconomyWorkBudget");

function stockKey(stationID, typeID) {
  return `${Number(stationID)}:${Number(typeID)}`;
}

function buildStockMap() {
  const rows = new Map();
  for (const station of catalog.STATIONS) {
    for (const good of catalog.GOODS) {
      rows.set(stockKey(station.stationID, good.typeID), {
        station_id: station.stationID,
        type_id: good.typeID,
        quantity: catalog.getTargetQuantity(station, good),
        price: good.priceAnchor,
      });
    }
  }
  return rows;
}

async function runVerification() {
  const startedAtMs = 1_700_000_000_000;
  const economy = {
    createdAtMs: startedAtMs,
    jobs: {},
    miningDeposits: {},
    metrics: {
      jobsCreated: 0,
      jobsDelivered: 0,
      miningDepositsDelivered: 0,
      minerGrossMarketValue: 0,
      traderSpend: 0,
      traderRevenue: 0,
      traderGrossMargin: 0,
      failedAdjustments: 0,
    },
    telemetry: telemetry.buildDefaultTelemetryState(),
  };
  const living = {
    actors: {
      actor1: { role: "miner" },
      actor2: { role: "hauler" },
    },
    flights: {
      flight1: { phase: "docked", materialized: false, freightJobID: null },
      flight2: { phase: "virtual_departure", materialized: false, freightJobID: "job1" },
    },
  };
  const stockMap = buildStockMap();
  const baseline = telemetry.maybeCapture(economy, living, stockMap, startedAtMs);
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.periodSeconds, 0);

  economy.miningDeposits.deposit1 = {
    status: "delivered",
    deliveredAtMs: startedAtMs + 120_000,
    oreUnits: 10_000,
    oreVolumeM3: 1_000,
    grossMarketValue: 500_000,
    outputValuations: [
      { typeID: 34, typeName: "Tritanium", quantity: 20_000, grossValue: 500_000 },
    ],
  };
  economy.jobs.job1 = {
    status: "delivered",
    typeID: 215,
    typeName: "Iron Charge S",
    quantity: 5_000,
    reservedAtMs: startedAtMs + 90_000,
    completedAtMs: startedAtMs + 420_000,
    purchaseValue: 50_000,
    saleValue: 65_000,
    grossMargin: 15_000,
    logisticsClass: "bulk",
    cargoVolume: 2_500,
  };
  Object.assign(economy.metrics, {
    jobsCreated: 1,
    jobsDelivered: 1,
    miningDepositsDelivered: 1,
    minerGrossMarketValue: 500_000,
    traderSpend: 50_000,
    traderRevenue: 65_000,
    traderGrossMargin: 15_000,
  });
  assert.equal(
    telemetry.maybeCapture(economy, living, stockMap, startedAtMs + 300_000),
    null,
    "five minutes must not close a ten-minute interval",
  );
  const sample = telemetry.maybeCapture(
    economy,
    living,
    stockMap,
    startedAtMs + 600_000,
  );
  assert.equal(sample.baseline, false);
  assert.equal(sample.periodSeconds, 600);
  assert.equal(sample.miners.deposits, 1);
  assert.equal(sample.miners.grossValue, 500_000);
  assert.equal(sample.traders.jobsPurchased, 1);
  assert.equal(sample.traders.jobsDelivered, 1);
  assert.equal(sample.traders.spend, 50_000);
  assert.equal(sample.traders.revenue, 65_000);
  assert.equal(sample.traders.grossMargin, 15_000);
  assert.equal(sample.traders.marginPercent, 30);
  assert.deepEqual(sample.traders.byLogisticsClass, [{
    logisticsClass: "bulk",
    jobsPurchased: 1,
    jobsDelivered: 1,
    jobsLost: 0,
    cargoVolumePurchasedM3: 2_500,
    cargoVolumeDeliveredM3: 2_500,
    cargoVolumeLostM3: 0,
    spend: 50_000,
    revenue: 65_000,
    grossMargin: 15_000,
  }]);
  assert.equal(sample.market.targetFillPercent, 100);
  assert.equal(sample.market.stationCount, catalog.STATIONS.length);
  assert.ok(sample.market.stations.length <= 96);
  assert.equal(
    sample.market.stations.find((station) => station.stationID === 60003760).hubTier,
    "regional",
  );
  assert.equal(sample.population.actors, 2);
  assert.equal(economy.telemetry.snapshots.length, 2);

  const cooperativeBudget = createWorkBudget({ budgetMs: 0.5 });
  const cooperative = await telemetry.buildSnapshotCooperative({
    economyState: economy,
    livingState: living,
    stockMap,
    startAtMs: startedAtMs,
    endAtMs: startedAtMs + 600_000,
    sequence: 99,
    metricBaseline: {},
    workBudget: cooperativeBudget,
  });
  const cooperativeReport = cooperativeBudget.finish();
  const synchronous = telemetry.buildSnapshot({
    economyState: economy,
    livingState: living,
    stockMap,
    startAtMs: startedAtMs,
    endAtMs: startedAtMs + 600_000,
    sequence: 99,
    metricBaseline: {},
  });
  assert.deepEqual(cooperative, synchronous, "cooperative telemetry changed snapshot values");
  assert.ok(cooperativeReport.yields > 0, "market telemetry did not yield cooperatively");

  const accountingState = economyStateStore.buildDefaultState();
  economyRuntime._testing.setRuntimeStateForTest(accountingState);
  const trade = {
    purchaseValue: 50_000,
    saleValue: 65_000,
    grossMargin: 15_000,
  };
  assert.equal(economyRuntime._testing.recordTraderPurchase(trade, startedAtMs), true);
  assert.equal(economyRuntime._testing.recordTraderPurchase(trade, startedAtMs), false);
  assert.equal(economyRuntime._testing.recordTraderSale(trade, startedAtMs), true);
  assert.equal(economyRuntime._testing.recordTraderSale(trade, startedAtMs), false);
  const lostTrade = { purchaseValue: 12_500 };
  assert.equal(economyRuntime._testing.recordTraderCargoLoss(lostTrade, startedAtMs), true);
  assert.equal(economyRuntime._testing.recordTraderCargoLoss(lostTrade, startedAtMs), false);
  const minerDeposit = { grossMarketValue: 500_000 };
  assert.equal(economyRuntime._testing.recordMinerDepositValue(minerDeposit, startedAtMs), true);
  assert.equal(economyRuntime._testing.recordMinerDepositValue(minerDeposit, startedAtMs), false);
  assert.equal(accountingState.metrics.traderSpend, 50_000);
  assert.equal(accountingState.metrics.traderRevenue, 65_000);
  assert.equal(accountingState.metrics.traderGrossMargin, 15_000);
  assert.equal(accountingState.metrics.traderCargoLossValue, 12_500);
  assert.equal(accountingState.metrics.traderJobsValued, 1);
  assert.equal(accountingState.metrics.minerGrossMarketValue, 500_000);
  const pruneAtMs = startedAtMs + (10 * 24 * 60 * 60 * 1_000);
  accountingState.miningDeposits = {
    oldDelivered: { status: "delivered", deliveredAtMs: pruneAtMs - (25 * 60 * 60 * 1_000) },
    recentDelivered: { status: "delivered", deliveredAtMs: pruneAtMs - 1_000 },
    oldPending: { status: "pending", deliveredAtMs: pruneAtMs - (25 * 60 * 60 * 1_000) },
  };
  await economyRuntime._testing.pruneOldState(pruneAtMs, createWorkBudget({ budgetMs: 4 }));
  assert.equal(accountingState.miningDeposits.oldDelivered, undefined);
  assert.ok(accountingState.miningDeposits.recentDelivered);
  assert.ok(accountingState.miningDeposits.oldPending);
  return {
    success: true,
    intervalSeconds: sample.periodSeconds,
    minerGrossValue: sample.miners.grossValue,
    traderSpend: sample.traders.spend,
    traderRevenue: sample.traders.revenue,
    traderGrossMargin: sample.traders.grossMargin,
    retainedSnapshots: economy.telemetry.snapshots.length,
    cooperativeYields: cooperativeReport.yields,
    maximumSynchronousSliceMs: Math.round(cooperativeReport.maximumSliceMs * 100) / 100,
  };
}

if (require.main === module) {
  runVerification()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = { runVerification };
