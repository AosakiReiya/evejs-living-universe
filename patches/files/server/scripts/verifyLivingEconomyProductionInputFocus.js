"use strict";

// This suite exercises the legacy faction-assembly path, which remains
// supported when faction shipyards are disabled.
process.env.EVEJS_LIVING_ECONOMY_FACTION_SHIPYARD_ENABLED = "false";

const assert = require("assert/strict");

const catalog = require(
  "../src/space/npc/ambientTraffic/livingEconomyCatalog",
);
const routePlanner = require(
  "../src/space/npc/ambientTraffic/livingEconomyRoutePlanner",
);

function stockKey(stationID, typeID) {
  return `${Number(stationID)}:${Number(typeID)}`;
}

async function main() {
  const requirements = [
    {
      demandKind: "production_input",
      stationID: 60012568,
      typeID: 34,
      outputTypeID: 17715,
      outputRequirementKind: "hull",
      demandCreatedAtMs: 1_700_000_000_000,
      remainingQuantity: 4_000_000,
    },
    {
      demandKind: "production_input",
      stationID: 60012568,
      typeID: 39,
      outputTypeID: 17715,
      outputRequirementKind: "hull",
      demandCreatedAtMs: 1_700_000_000_000,
      remainingQuantity: 2_000,
    },
    {
      demandKind: "production_input",
      stationID: 60012202,
      typeID: 34,
      outputTypeID: 17720,
      outputRequirementKind: "hull",
      demandCreatedAtMs: 1_700_000_100_000,
      remainingQuantity: 2_000_000,
    },
    {
      demandKind: "production_input",
      stationID: 60014155,
      typeID: 34,
      outputTypeID: 12274,
      outputRequirementKind: "module",
      demandCreatedAtMs: 1_699_000_000_000,
      remainingQuantity: 100_000,
    },
  ];
  const ranks = routePlanner._testing.buildProductionInputPlanRanks(
    requirements,
  );
  assert.equal(ranks.get("60012568:17715"), 0);
  assert.equal(
    ranks.get("60012202:17720"),
    1,
    "a newer hull plan displaced the oldest hull assembly",
  );
  assert.equal(
    ranks.get("60014155:12274"),
    2,
    "a module input plan displaced replacement hull assembly",
  );
  assert.ok(
    routePlanner._testing.getProductionInputPlanPriorityBonus(0) >
      routePlanner._testing.getProductionInputPlanPriorityBonus(1),
  );
  assert.ok(
    routePlanner._testing.getProductionInputPlanPriorityBonus(1) >
      routePlanner._testing.getProductionInputPlanPriorityBonus(2),
  );
  assert.equal(
    routePlanner._testing.getProductionInputPlanPriorityBonus(-1),
    0,
  );

  const source = catalog.getStation(60003760);
  const megacyte = catalog.getGood(40);
  const stockMap = new Map([[
    stockKey(source.stationID, megacyte.typeID),
    {
      station_id: source.stationID,
      type_id: megacyte.typeID,
      quantity: 10_001,
      price: megacyte.priceAnchor,
    },
  ]]);
  const getStockRow = (rows, stationID, typeID) => (
    rows.get(stockKey(stationID, typeID)) || {
      station_id: Number(stationID),
      type_id: Number(typeID),
      quantity: 0,
      price: catalog.getGood(typeID)?.priceAnchor || 1,
    }
  );
  const focusedRequirements = [
    {
      demandKind: "replacement",
      demandClass: "replacement",
      stationID: source.stationID,
      typeID: megacyte.typeID,
      requirementKind: "fitting",
      demandCreatedAtMs: 1_700_000_199_000,
      remainingQuantity: 1,
    },
    {
      demandKind: "production_input",
      demandClass: "replacement",
      stationID: 60012568,
      typeID: megacyte.typeID,
      outputTypeID: 17715,
      outputRequirementKind: "hull",
      demandCreatedAtMs: 1_700_000_000_000,
      remainingQuantity: 12,
    },
    ...[
      [60012202, 17720, 500],
      [60014155, 17718, 450],
      [60014942, 17922, 400],
      [60012145, 17930, 350],
    ].map(([stationID, outputTypeID, remainingQuantity], index) => ({
      demandKind: "production_input",
      demandClass: "replacement",
      stationID,
      typeID: megacyte.typeID,
      outputTypeID,
      outputRequirementKind: "hull",
      demandCreatedAtMs: 1_700_000_100_000 + index,
      remainingQuantity,
    })),
    {
      demandKind: "production_input",
      demandClass: "replacement",
      stationID: source.stationID,
      typeID: megacyte.typeID,
      outputTypeID: 17722,
      outputRequirementKind: "hull",
      demandCreatedAtMs: 1_700_000_200_000,
      remainingQuantity: 10_000,
    },
  ];
  const opportunities = await routePlanner.buildRegionalOpportunities(
    stockMap,
    getStockRow,
    [],
    focusedRequirements,
  );
  const focusedOpportunity = opportunities.find((opportunity) => (
    Number(opportunity.good.typeID) === megacyte.typeID &&
    Number(opportunity.sourceStation.stationID) === source.stationID &&
    Number(opportunity.destinationStation.stationID) === 60012568
  ));
  assert.ok(
    focusedOpportunity,
    "the nearly complete top plan was truncated behind four larger shortages",
  );
  assert.equal(focusedOpportunity.priorityProductionPlanRank, 0);
  assert.equal(
    focusedOpportunity.borrowedPriorityInputUnits,
    10_000,
    "the oldest hull plan could not borrow inputs protected by a newer plan",
  );
  assert.equal(focusedOpportunity.sourceAvailable, 10_000);

  console.log(JSON.stringify({
    success: true,
    oldestHullPlanRank: ranks.get("60012568:17715"),
    newerHullPlanRank: ranks.get("60012202:17720"),
    modulePlanRank: ranks.get("60014155:12274"),
    topPlanBonus:
      routePlanner._testing.getProductionInputPlanPriorityBonus(0),
    focusedDestination: focusedOpportunity.destinationStation.name,
    focusedRemainingUnits: focusedOpportunity.priorityDemandUnits,
    borrowedFromNewerPlan:
      focusedOpportunity.borrowedPriorityInputUnits,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
