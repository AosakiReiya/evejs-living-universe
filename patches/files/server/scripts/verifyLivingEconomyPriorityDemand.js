"use strict";

const assert = require("assert/strict");

const catalog = require("../src/space/npc/ambientTraffic/livingEconomyCatalog");
const routePlanner = require("../src/space/npc/ambientTraffic/livingEconomyRoutePlanner");
const { createWorkBudget } = require("../src/space/npc/ambientTraffic/livingEconomyWorkBudget");

function stockKey(stationID, typeID) {
  return `${Number(stationID)}:${Number(typeID)}`;
}

async function main() {
  const source = catalog.getStation(60003760);
  const destination = catalog.getStation(60003754);
  const good = catalog.getGood(210);
  const hull = catalog.getGood(16238);
  assert.ok(source && destination && good && hull);
  const stockMap = new Map([
    [stockKey(source.stationID, good.typeID), {
      station_id: source.stationID,
      type_id: good.typeID,
      // Below the ordinary 70% producer reserve, but above the protected
      // emergency reserve used only while real replacement demand is pending.
      quantity: 20_000,
      price: good.priceAnchor,
    }],
    [stockKey(source.stationID, hull.typeID), {
      station_id: source.stationID,
      type_id: hull.typeID,
      // A single completed hull used to be trapped behind a reserve of one.
      quantity: 1,
      price: hull.priceAnchor,
    }],
  ]);
  const getStockRow = (rows, stationID, typeID) => rows.get(stockKey(stationID, typeID)) || {
    station_id: Number(stationID),
    type_id: Number(typeID),
    quantity: 0,
    price: catalog.getGood(typeID)?.priceAnchor || 1,
  };
  const yieldedSlices = [];
  const workBudget = createWorkBudget({
    budgetMs: 4,
    onYield: (sample) => yieldedSlices.push(sample),
  });
  const opportunities = await routePlanner.buildRegionalOpportunities(
    stockMap,
    getStockRow,
    [],
    [{
      demandID: "VERIFY-DEMAND",
      stationID: destination.stationID,
      typeID: good.typeID,
      remainingQuantity: 400,
      demandKind: "replacement",
    }, {
      demandID: "VERIFY-HULL-DEMAND",
      stationID: destination.stationID,
      typeID: hull.typeID,
      remainingQuantity: 1,
      demandKind: "replacement",
    }],
    { workBudget },
  );
  const report = workBudget.finish();
  const priority = opportunities.find((opportunity) => (
    opportunity.sourceStation.stationID === source.stationID &&
    opportunity.destinationStation.stationID === destination.stationID &&
    opportunity.good.typeID === good.typeID
  ));
  assert.ok(priority, "pending replacement stock did not create a freight opportunity");
  assert.equal(priority.priorityDemandUnits, 400);
  assert.ok(priority.sourceAvailable > 0);
  const priorityHull = opportunities.find((opportunity) => (
    opportunity.sourceStation.stationID === source.stationID &&
    opportunity.destinationStation.stationID === destination.stationID &&
    opportunity.good.typeID === hull.typeID
  ));
  assert.ok(priorityHull, "one-at-a-time replacement hull remained trapped at its factory");
  assert.equal(priorityHull.priorityDemandUnits, 1);
  assert.equal(priorityHull.sourceAvailable, 1);
  assert.ok(opportunities[0].priorityDemandUnits > 0, "ordinary shortages outranked a real loss");

  console.log(JSON.stringify({
    success: true,
    sourceStation: source.name,
    destinationStation: destination.name,
    typeName: good.name,
    priorityDemandUnits: priority.priorityDemandUnits,
    sourceAvailable: priority.sourceAvailable,
    hullPriority: {
      typeName: hull.name,
      sourceAvailable: priorityHull.sourceAvailable,
      priorityDemandUnits: priorityHull.priorityDemandUnits,
    },
    routeJumps: priority.jumps,
    cooperativeYields: report.yields,
    maximumSynchronousSliceMs: Math.round(report.maximumSliceMs * 100) / 100,
    slowestYieldCheckpoint: yieldedSlices
      .sort((left, right) => right.sliceMs - left.sliceMs)[0] || null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
