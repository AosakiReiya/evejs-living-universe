"use strict";

const assert = require("assert");
const path = require("path");

const config = require(path.join(__dirname, "../src/config"));
const { marketDaemonClient } = require(path.join(
  __dirname,
  "../src/services/market/marketDaemonClient",
));
const catalog = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingEconomyCatalog",
));
const livingUniverseRuntime = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingUniverseRuntime",
));
const livingEconomyRuntime = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingEconomyRuntime",
));

async function main() {
  assert.strictEqual(config.livingEconomyEnabled, true, "living economy config must be enabled");
  // This verifier temporarily swaps the in-process economy state to test the
  // cargo lifecycle. Disable background pulses in this short-lived process so
  // that synthetic state can never be persisted over a running installation.
  config.livingEconomyEnabled = false;
  assert.ok(catalog.STATIONS.length >= 1_600, "universal station catalog did not cover reachable NPC-station space");
  assert.strictEqual(catalog.GOODS.length, 175, "unexpected living-economy goods count");
  assert.strictEqual(catalog.PROCUREMENT_GOODS.length, 40, "unexpected procurement input count");
  assert.strictEqual(catalog.PROCUREMENT_INPUT_GOODS.length, 47, "unexpected industrial procurement input count");
  assert.strictEqual(catalog.FREIGHT_ROUTES.length, 10, "unexpected freight route count");

  const population = livingUniverseRuntime._testing.buildPopulationPlan(400, Date.now());
  const roles = {};
  for (const actor of Object.values(population.actors)) {
    roles[actor.role] = (roles[actor.role] || 0) + 1;
  }
  assert.strictEqual(Object.keys(population.actors).length, 400);
  assert.strictEqual(roles.hauler, 128);
  assert.strictEqual(roles.escort, 8);
  assert.strictEqual(roles.miner, 88);
  assert.strictEqual(roles.mining_support, 8);

  const tamaStock = new Map([
    ["60003760:210", { station_id: 60003760, type_id: 210, quantity: 100_000, price: 14.5 }],
    ["60005203:210", { station_id: 60005203, type_id: 210, quantity: 0, price: 14.5 }],
  ]);
  const secureCandidate = livingEconomyRuntime._testing.findFreightCandidate({
    routeID: "jita_tama",
    currentNodeIndex: 0,
    currentSystemID: 30000142,
    direction: 1,
    logisticsProfile: {
      logisticsClass: "secure",
      capacityM3: 18_000,
      shipmentMultiplier: 4,
      maximumCargoValueISK: 500_000_000,
      lowSecurityAccess: true,
    },
  }, tamaStock);
  assert.ok(secureCandidate, "a governed secure transport must accept Tama work");
  assert.strictEqual(secureCandidate.riskBand, "lowsec");
  assert.strictEqual(secureCandidate.logisticsProfile.logisticsClass, "secure");
  assert.strictEqual(livingEconomyRuntime._testing.findFreightCandidate({
    routeID: "jita_tama",
    currentNodeIndex: 0,
    currentSystemID: 30000142,
    direction: 1,
    logisticsProfile: {
      logisticsClass: "regional",
      capacityM3: 12_000,
      shipmentMultiplier: 3,
      maximumCargoValueISK: 100_000_000,
      lowSecurityAccess: false,
    },
  }, tamaStock), null, "an ordinary regional transport must reject Tama work");

  const iceStock = new Map([
    ["60000880:16272", { station_id: 60000880, type_id: 16272, quantity: 100_000, price: 95 }],
    ["60003760:16272", { station_id: 60003760, type_id: 16272, quantity: 0, price: 95 }],
  ]);
  const iceCandidate = livingEconomyRuntime._testing.findFreightCandidate({
    routeID: "jita_halaima",
    currentNodeIndex: 4,
    currentSystemID: 30002781,
    direction: -1,
    logisticsProfile: {
      logisticsClass: "trunk",
      capacityM3: 650_000,
      shipmentMultiplier: 50,
      maximumCargoValueISK: 2_500_000_000,
      lowSecurityAccess: false,
    },
  }, iceStock);
  assert.ok(iceCandidate, "Halaima ice products must produce Jita-bound trunk work");
  assert.strictEqual(iceCandidate.good.typeID, 16272);
  assert.ok(iceCandidate.cargoVolume <= iceCandidate.logisticsProfile.capacityM3);

  const cargoTestFlight = {
    family: "hauler",
    freightJobID: "LEF-VERIFY",
  };
  const cargoTestJob = {
    jobID: "LEF-VERIFY",
    status: "reserving",
    typeID: 222,
    quantity: 12_000,
  };
  livingEconomyRuntime._testing.setRuntimeStateForTest({
    ...require(path.join(
      __dirname,
      "../src/space/npc/ambientTraffic/livingEconomyState",
    )).buildDefaultState(),
    jobs: { "LEF-VERIFY": cargoTestJob },
  });
  config.livingEconomyEnabled = true;
  assert.strictEqual(
    livingEconomyRuntime.shouldHoldFreightFlight(cargoTestFlight),
    true,
    "freighter departed before its reservation was committed",
  );
  assert.deepStrictEqual(livingEconomyRuntime.getFlightCargo(cargoTestFlight), []);
  cargoTestJob.status = "in_transit";
  assert.strictEqual(livingEconomyRuntime.shouldHoldFreightFlight(cargoTestFlight), false);
  assert.deepStrictEqual(livingEconomyRuntime.getFlightCargo(cargoTestFlight), [{
    typeID: 222,
    quantity: 12_000,
    singleton: false,
    cargoPurpose: "living_economy_manifest",
    freightJobID: "LEF-VERIFY",
  }]);
  cargoTestJob.status = "delivery_pending";
  assert.strictEqual(
    livingEconomyRuntime.shouldHoldFreightFlight(cargoTestFlight),
    true,
    "freighter departed before destination stock was committed",
  );
  assert.deepStrictEqual(livingEconomyRuntime.getFlightCargo(cargoTestFlight), []);
  config.livingEconomyEnabled = false;

  const key = { station_id: 60003760, type_id: 34 };
  const beforeRows = await marketDaemonClient.call("GetSeedStocks", { keys: [key] });
  assert.strictEqual(beforeRows.length, 1, "Jita Tritanium seed row is missing");
  const before = beforeRows[0];
  assert.ok(Number(before.quantity) >= 1, "Jita Tritanium stock is empty");

  const token = `living-economy-verify:${Date.now()}`;
  const reserveRequest = {
    ...key,
    delta_quantity: -1,
    new_quantity: null,
    new_price: Number(before.price),
    reason: "living economy verification reservation",
    adjustment_id: `${token}:reserve`,
    allow_create: false,
  };
  const first = await marketDaemonClient.call("AdjustSeedStock", reserveRequest);
  const duplicate = await marketDaemonClient.call("AdjustSeedStock", reserveRequest);
  assert.strictEqual(Number(first.quantity), Number(before.quantity) - 1);
  assert.strictEqual(Number(duplicate.quantity), Number(first.quantity));
  assert.strictEqual(first.applied, true);
  assert.strictEqual(duplicate.applied, false);

  const refund = await marketDaemonClient.call("AdjustSeedStock", {
    ...key,
    delta_quantity: 1,
    new_quantity: null,
    new_price: Number(before.price),
    reason: "living economy verification refund",
    adjustment_id: `${token}:refund`,
    allow_create: false,
  });
  assert.strictEqual(Number(refund.quantity), Number(before.quantity));

  console.log(JSON.stringify({
    ok: true,
    catalog: {
      stations: catalog.STATIONS.length,
      goods: catalog.GOODS.length,
      routes: catalog.FREIGHT_ROUTES.length,
    },
    population: {
      actors: Object.keys(population.actors).length,
      flights: Object.keys(population.flights).length,
      roles,
    },
    freightCargoLifecycle: {
      waitsForReservation: true,
      exactManifestWhileInTransit: true,
      waitsForDeliveryCommit: true,
    },
    market: {
      stationID: key.station_id,
      typeID: key.type_id,
      startingQuantity: Number(before.quantity),
      reservedQuantity: Number(first.quantity),
      duplicateApplied: duplicate.applied,
      restoredQuantity: Number(refund.quantity),
    },
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (marketDaemonClient._socket) {
      marketDaemonClient._backgroundReconnectEnabled = false;
      marketDaemonClient._socket.destroy();
    }
  });
