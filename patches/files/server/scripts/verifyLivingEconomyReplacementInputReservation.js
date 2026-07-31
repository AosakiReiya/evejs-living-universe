"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_X_EVE_ENABLED = "false";
// This suite exercises the legacy faction-assembly path, which remains
// supported when faction shipyards are disabled.
process.env.EVEJS_LIVING_ECONOMY_FACTION_SHIPYARD_ENABLED = "false";

const assert = require("assert/strict");

const catalog = require(
  "../src/space/npc/ambientTraffic/livingEconomyCatalog",
);
const industry = require(
  "../src/space/npc/ambientTraffic/livingEconomyIndustry",
);
const stateStore = require(
  "../src/space/npc/ambientTraffic/livingEconomyState",
);

const STATION_ID = 60012568;
const TRITANIUM_TYPE_ID = 34;
const GILA_TYPE_ID = 17715;
const NOW_MS = 1_785_000_000_000;

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

function setStock(stockMap, stationID, typeID, quantity) {
  stockMap.set(stockKey(stationID, typeID), {
    station_id: Number(stationID),
    type_id: Number(typeID),
    quantity: Number(quantity),
    price: catalog.getGood(typeID)?.priceAnchor || 1,
  });
}

function findOrdinaryTritaniumProduct(station) {
  return catalog.GOODS.find((good) => {
    if (
      Number(good.typeID) === GILA_TYPE_ID ||
      catalog.isMineralGood(good) ||
      catalog.getProducerCeiling(station, good) <= 0
    ) {
      return false;
    }
    const recipe = industry.getRecipe(good);
    return Boolean(
      recipe &&
      recipe.materials.some(
        (material) => Number(material.typeID) === TRITANIUM_TYPE_ID,
      ),
    );
  }) || null;
}

function buildFundedStock(station, good, runs = 1) {
  const recipe = industry.getRecipe(good);
  const stockMap = new Map();
  setStock(stockMap, station.stationID, good.typeID, 0);
  for (const material of recipe.materials) {
    setStock(
      stockMap,
      station.stationID,
      material.typeID,
      material.quantityPerRun * Math.max(100, runs),
    );
  }
  return stockMap;
}

function main() {
  const station = catalog.getStation(STATION_ID);
  const gila = catalog.getGood(GILA_TYPE_ID);
  const ordinaryGood = findOrdinaryTritaniumProduct(station);
  assert.ok(station && gila && ordinaryGood);

  const reservations = industry._testing.buildPriorityInputReservations([
    {
      stationID: station.stationID,
      typeID: TRITANIUM_TYPE_ID,
      outputTypeID: ordinaryGood.typeID,
      outputRequirementKind: "fitting",
      demandKind: "production_input",
      demandCreatedAtMs: NOW_MS - 10_000,
      remainingQuantity: 50,
    },
    {
      stationID: station.stationID,
      typeID: TRITANIUM_TYPE_ID,
      outputTypeID: gila.typeID,
      outputRequirementKind: "hull",
      demandKind: "production_input",
      demandCreatedAtMs: NOW_MS,
      remainingQuantity: 75,
    },
  ]);
  const tritaniumReservation = reservations
    .get(station.stationID)
    .get(TRITANIUM_TYPE_ID);
  assert.equal(
    tritaniumReservation.outputTypeID,
    gila.typeID,
    "a fitting plan took ownership of staged replacement-hull minerals",
  );

  const ordinaryState = stateStore.buildDefaultState();
  industry._testing.ensureIndustryState(ordinaryState);
  const ordinaryStock = buildFundedStock(station, ordinaryGood);
  const unreservedCandidate = industry._testing.buildCandidate(
    ordinaryState,
    ordinaryStock,
    getStockRow,
    station,
    ordinaryGood,
    NOW_MS,
  );
  assert.ok(unreservedCandidate, "ordinary industry fixture was not viable");
  const ordinaryTritanium = unreservedCandidate.inputs.find(
    (input) => Number(input.typeID) === TRITANIUM_TYPE_ID,
  );
  setStock(
    ordinaryStock,
    station.stationID,
    TRITANIUM_TYPE_ID,
    ordinaryTritanium.quantity,
  );
  const ordinaryReserve = industry._testing.getPriorityInputReserveByTypeID(
    reservations,
    station.stationID,
    ordinaryGood.typeID,
  );
  assert.equal(ordinaryReserve.get(TRITANIUM_TYPE_ID), 75);
  const blockedOrdinaryCandidate = industry._testing.buildCandidate(
    ordinaryState,
    ordinaryStock,
    getStockRow,
    station,
    ordinaryGood,
    NOW_MS,
    { priorityInputReserveByTypeID: ordinaryReserve },
  );
  assert.equal(
    blockedOrdinaryCandidate,
    null,
    "ordinary industry spent minerals reserved for replacement assembly",
  );

  const gilaState = stateStore.buildDefaultState();
  industry._testing.ensureIndustryState(gilaState);
  const gilaRecipe = industry.getRecipe(gila);
  const gilaStock = buildFundedStock(station, gila);
  for (const material of gilaRecipe.materials) {
    setStock(
      gilaStock,
      station.stationID,
      material.typeID,
      material.quantityPerRun,
    );
  }
  const ownerReserve = industry._testing.getPriorityInputReserveByTypeID(
    reservations,
    station.stationID,
    gila.typeID,
  );
  assert.equal(ownerReserve.has(TRITANIUM_TYPE_ID), false);
  const gilaCandidate = industry._testing.buildCandidate(
    gilaState,
    gilaStock,
    getStockRow,
    station,
    gila,
    NOW_MS,
    {
      priorityDemandUnits: 1,
      priorityRequirementKind: "hull",
      priorityInputReserveByTypeID: ownerReserve,
    },
  );
  assert.ok(gilaCandidate, "the owning replacement hull could not use its inputs");
  assert.equal(gilaCandidate.runs, 1);
  assert.equal(gilaCandidate.outputQuantity, 1);

  console.log(JSON.stringify({
    success: true,
    stationID: station.stationID,
    reservedMaterial: catalog.getGood(TRITANIUM_TYPE_ID).name,
    ownerTypeID: tritaniumReservation.outputTypeID,
    ownerName: gila.name,
    blockedOrdinaryProduct: ordinaryGood.name,
    ownerRuns: gilaCandidate.runs,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
}
