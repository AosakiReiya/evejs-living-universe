"use strict";

// This suite verifies the legacy faction-assembly path (Gila built from a
// governed mineral recipe), which remains supported when faction shipyards
// are disabled.
process.env.EVEJS_LIVING_ECONOMY_FACTION_SHIPYARD_ENABLED = "false";

const assert = require("assert/strict");

const catalog = require("../src/space/npc/ambientTraffic/livingEconomyCatalog");
const demandCoverage = require(
  "../src/space/npc/ambientTraffic/livingEconomyDemandCoverage",
);
const industry = require("../src/space/npc/ambientTraffic/livingEconomyIndustry");
const stateStore = require("../src/space/npc/ambientTraffic/livingEconomyState");

function stockKey(stationID, typeID) {
  return `${Number(stationID)}:${Number(typeID)}`;
}

function getStockRow(stockMap, stationID, typeID) {
  return stockMap.get(stockKey(stationID, typeID)) || {
    station_id: Number(stationID),
    type_id: Number(typeID),
    quantity: 0,
    price: catalog.getGood(typeID)?.priceAnchor || 1,
  };
}

function buildFundedStock(station, good, recipe, runs) {
  const stockMap = new Map();
  stockMap.set(stockKey(station.stationID, good.typeID), {
    station_id: station.stationID,
    type_id: good.typeID,
    quantity: 0,
    price: good.priceAnchor,
  });
  for (const material of recipe.materials) {
    const materialGood = catalog.getGood(material.typeID);
    stockMap.set(stockKey(station.stationID, material.typeID), {
      station_id: station.stationID,
      type_id: material.typeID,
      quantity: material.quantityPerRun * runs,
      price: materialGood?.priceAnchor || 1,
    });
  }
  return stockMap;
}

function findProducer(good) {
  return [...catalog.STATIONS]
    .filter((station) => catalog.getProducerCeiling(station, good) > 0)
    .sort((left, right) => (
      catalog.getProducerCeiling(right, good) -
        catalog.getProducerCeiling(left, good) ||
      Number(left.stationID) - Number(right.stationID)
    ))[0] || null;
}

async function main() {
  const syntheticRecipe = {
    productQuantityPerRun: 1,
    maxProductionLimit: 10,
  };
  assert.equal(
    demandCoverage._testing.getDemandDrivenProductionPlanRuns(
      { category: catalog.CATEGORY.SHIP },
      syntheticRecipe,
      145,
    ),
    1,
    "a demand-driven ship plan still requested a warehouse batch",
  );
  assert.equal(
    demandCoverage._testing.getDemandDrivenProductionPlanRuns(
      { category: catalog.CATEGORY.AMMO },
      syntheticRecipe,
      145,
    ),
    10,
    "non-ship demand planning lost its existing batch size",
  );

  const candidateInputs = {
    recipe: syntheticRecipe,
    shortage: 145,
    preferredOutput: 10,
    maximumRunsByDuration: 10,
  };
  assert.equal(
    industry._testing.getProductionCandidateRuns({
      ...candidateInputs,
      demandDriven: true,
      good: { category: catalog.CATEGORY.SHIP },
    }),
    1,
    "industry still batched a demand-driven replacement hull",
  );
  assert.equal(
    industry._testing.getProductionCandidateRuns({
      ...candidateInputs,
      demandDriven: false,
      good: { category: catalog.CATEGORY.SHIP },
    }),
    10,
    "normal stock-driven ship batches were changed",
  );
  assert.equal(
    industry._testing.getProductionCandidateRuns({
      ...candidateInputs,
      demandDriven: true,
      good: { category: catalog.CATEGORY.AMMO },
    }),
    10,
    "demand-driven non-ship batches were changed",
  );

  const hull = catalog.getGood(17715);
  const hullRecipe = industry.getRecipe(hull);
  const hullProducer = findProducer(hull);
  assert.ok(hull && hullRecipe && hullProducer, "Gila production fixture is unavailable");
  const hullStock = buildFundedStock(hullProducer, hull, hullRecipe, 10);
  const regionalQuantityByTypeID = new Map(
    hullRecipe.materials.map((material) => [
      Number(material.typeID),
      material.quantityPerRun * 10,
    ]),
  );
  const productionPlan = await demandCoverage.buildProductionPlan(
    hull,
    hullRecipe,
    145,
    hullStock,
    getStockRow,
    null,
    regionalQuantityByTypeID,
  );
  assert.ok(productionPlan, "Gila demand plan was not created");
  assert.equal(productionPlan.runs, 1);
  assert.equal(productionPlan.plannedOutputUnits, hullRecipe.productQuantityPerRun);
  for (const input of productionPlan.inputs) {
    const material = hullRecipe.materials.find(
      (entry) => Number(entry.typeID) === Number(input.typeID),
    );
    assert.equal(
      input.requiredQuantity,
      material.quantityPerRun,
      `${input.typeName} was still planned for more than one hull`,
    );
  }

  const coverageState = stateStore.buildDefaultState();
  coverageState.replacementDemands.TEST_STAGED_GILA = {
    demandID: "TEST_STAGED_GILA",
    shipTypeID: hull.typeID,
    shipName: hull.name,
    stationID: hullProducer.stationID,
    systemID: hullProducer.systemID,
    status: "pending",
    requirements: [{
      typeID: hull.typeID,
      typeName: hull.name,
      kind: "hull",
      quantity: 1,
      unitValueISK: hull.priceAnchor,
    }],
    fulfilledQuantities: {},
    createdAtMs: Date.now() - 60_000,
  };
  await demandCoverage.audit(
    coverageState,
    hullStock,
    {
      getStockRow,
      getRecipe: industry.getRecipe,
      activeJobs: [],
    },
    Date.now(),
  );
  const stagedSupply =
    coverageState.replacementDemands.TEST_STAGED_GILA
      .requirements[0].supply;
  assert.equal(stagedSupply.supplyStatus, "awaiting_production");
  assert.equal(
    stagedSupply.inputRequirements.length,
    hullRecipe.materials.length,
    "fully staged hull inputs disappeared before industry consumed them",
  );
  assert.ok(
    stagedSupply.inputRequirements.every(
      (input) =>
        input.requiredQuantity > 0 &&
        input.availableQuantity >= input.requiredQuantity &&
        input.missingQuantity === 0,
    ),
    "the staged-input reservation did not retain the complete funded recipe",
  );

  const hullState = stateStore.buildDefaultState();
  industry._testing.ensureIndustryState(hullState);
  const hullCandidate = industry._testing.buildCandidate(
    hullState,
    hullStock,
    getStockRow,
    hullProducer,
    hull,
    Date.now(),
    { priorityDemandUnits: 145 },
  );
  assert.ok(hullCandidate, "funded demand-driven Gila candidate was not created");
  assert.equal(hullCandidate.demandDriven, true);
  assert.equal(hullCandidate.runs, 1);
  assert.equal(hullCandidate.outputQuantity, hullRecipe.productQuantityPerRun);

  const ammo = catalog.getGood(210);
  const ammoRecipe = industry.getRecipe(ammo);
  const ammoProducer = findProducer(ammo);
  assert.ok(ammo && ammoRecipe && ammoProducer, "ammo production fixture is unavailable");
  const ammoStock = buildFundedStock(ammoProducer, ammo, ammoRecipe, 600);
  const ammoState = stateStore.buildDefaultState();
  industry._testing.ensureIndustryState(ammoState);
  const ammoCandidate = industry._testing.buildCandidate(
    ammoState,
    ammoStock,
    getStockRow,
    ammoProducer,
    ammo,
    Date.now(),
    { priorityDemandUnits: 120_000 },
  );
  assert.ok(ammoCandidate, "funded demand-driven ammo candidate was not created");
  assert.ok(ammoCandidate.runs > 1, "unrelated ammo production was reduced to one run");

  console.log(JSON.stringify({
    success: true,
    hull: {
      typeID: hull.typeID,
      name: hull.name,
      producerStationID: hullProducer.stationID,
      requestedUnits: 145,
      plannedRuns: productionPlan.runs,
      industryRuns: hullCandidate.runs,
      outputUnits: hullCandidate.outputQuantity,
      stagedInputReservations:
        stagedSupply.inputRequirements.length,
    },
    unaffectedBatch: {
      typeID: ammo.typeID,
      name: ammo.name,
      industryRuns: ammoCandidate.runs,
      outputUnits: ammoCandidate.outputQuantity,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
