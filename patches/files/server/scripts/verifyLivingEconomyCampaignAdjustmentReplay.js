"use strict";

process.env.EVEJS_X_EVE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_SKIP_NPC_STARTUP = "1";

const assert = require("assert/strict");
const path = require("path");

const config = require(path.join(__dirname, "../src/config"));
const catalog = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingEconomyCatalog",
));
const livingEconomy = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingEconomyRuntime",
));
const { marketDaemonClient } = require(path.join(
  __dirname,
  "../src/services/market/marketDaemonClient",
));

const STATION_ID = 60_003_760;
const OTHER_STATION_ID = 60_008_494;
const MISSILE_TYPE_ID = 210;
const CHARGE_TYPE_ID = 222;
const SOURCE_EPOCH_MS = 1_785_000_000_000;

config.xEveEnabled = false;
config.livingEconomyEnabled = false;

function stockKey(stationID, typeID) {
  return `${Number(stationID)}:${Number(typeID)}`;
}

function buildMetrics() {
  return {
    marketAdjustments: 0,
    failedAdjustments: 0,
    campaignUnitsConsumed: 0,
    campaignDemandsFulfilled: 0,
    campaignAdjustmentNamespaceMigrations: 0,
    campaignAdjustmentConflictsQuarantined: 0,
  };
}

function buildDemand(overrides = {}) {
  const requirements = overrides.requirements || [{
    typeID: MISSILE_TYPE_ID,
    quantity: 10,
  }];
  return {
    demandID: "LEC-00000081",
    campaignID: "campaign-replay-verifier",
    campaignName: "Campaign replay verifier",
    encounterID: "encounter-replay-verifier",
    stationID: STATION_ID,
    systemID: 30_000_142,
    status: "pending",
    requirements,
    fulfilledQuantities: {},
    requestedUnits: requirements.reduce(
      (total, item) => total + Number(item.quantity || 0),
      0,
    ),
    valueISK: 0,
    createdAtMs: SOURCE_EPOCH_MS,
    fulfilledAtMs: 0,
    lastError: null,
    adjustmentNamespaceVersion: 2,
    ...overrides,
  };
}

function buildState(demand) {
  return {
    createdAtMs: SOURCE_EPOCH_MS - 10_000,
    nextEventNumber: 1,
    events: [],
    campaignDemands: {
      [demand.demandID]: demand,
    },
    metrics: buildMetrics(),
  };
}

function buildStockMap(rows) {
  return new Map(rows.map((row) => [
    stockKey(row.stationID, row.typeID),
    {
      station_id: row.stationID,
      type_id: row.typeID,
      quantity: row.quantity,
      price: row.price || 1,
      initial_quantity: row.quantity,
    },
  ]));
}

function adjustmentFingerprint(request) {
  return JSON.stringify({
    stationID: Number(request.station_id),
    typeID: Number(request.type_id),
    deltaQuantity: request.delta_quantity === null
      ? null
      : Number(request.delta_quantity),
    newQuantity: request.new_quantity === null
      ? null
      : Number(request.new_quantity),
    reason: String(request.reason || ""),
  });
}

class StrictMarketLedger {
  constructor(rows = []) {
    this.quantities = new Map(rows.map((row) => [
      stockKey(row.stationID, row.typeID),
      Number(row.quantity),
    ]));
    this.appliedDeltas = new Map();
    this.receipts = new Map();
    this.calls = [];
    this.loseResponseFor = new Set();
    this.lostResponses = new Set();
  }

  setQuantity(stationID, typeID, quantity) {
    this.quantities.set(stockKey(stationID, typeID), Number(quantity));
  }

  loseNextResponse(adjustmentID) {
    this.loseResponseFor.add(String(adjustmentID));
  }

  seedConflict(adjustmentID) {
    this.receipts.set(String(adjustmentID), {
      fingerprint: "receipt-owned-by-a-different-logical-row",
      response: null,
    });
  }

  callCount(adjustmentID) {
    return this.calls.filter(
      (entry) => entry.adjustmentID === String(adjustmentID),
    ).length;
  }

  externalDelta(stationID, typeID) {
    return this.appliedDeltas.get(stockKey(stationID, typeID)) || 0;
  }

  async call(method, request) {
    assert.equal(method, "AdjustSeedStock");
    const adjustmentID = String(request.adjustment_id || "");
    const fingerprint = adjustmentFingerprint(request);
    this.calls.push({ adjustmentID, fingerprint });

    const prior = this.receipts.get(adjustmentID);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new Error(
          "seed stock adjustment id was already used with a different station or type",
        );
      }
      return {
        ...prior.response,
        applied: false,
      };
    }

    const key = stockKey(request.station_id, request.type_id);
    const current = this.quantities.get(key) || 0;
    const delta = request.new_quantity === null
      ? Number(request.delta_quantity || 0)
      : Number(request.new_quantity) - current;
    const quantity = request.new_quantity === null
      ? Math.max(0, current + delta)
      : Math.max(0, Number(request.new_quantity));
    const response = {
      station_id: Number(request.station_id),
      type_id: Number(request.type_id),
      quantity,
      price: Number(request.new_price || 1),
      applied: true,
    };
    this.quantities.set(key, quantity);
    this.appliedDeltas.set(key, this.externalDelta(
      request.station_id,
      request.type_id,
    ) + delta);
    this.receipts.set(adjustmentID, { fingerprint, response });

    if (
      this.loseResponseFor.has(adjustmentID) &&
      !this.lostResponses.has(adjustmentID)
    ) {
      this.lostResponses.add(adjustmentID);
      throw new Error("simulated committed adjustment with lost response");
    }
    return response;
  }
}

async function withLedger(ledger, callback) {
  const originalCall = marketDaemonClient.call;
  marketDaemonClient.call = ledger.call.bind(ledger);
  try {
    return await callback();
  } finally {
    marketDaemonClient.call = originalCall;
  }
}

function verifyV2IdentityStabilityAndDistinctness() {
  const demand = buildDemand();
  const station = { stationID: STATION_ID };
  const otherStation = { stationID: OTHER_STATION_ID };
  const missile = { typeID: MISSILE_TYPE_ID };
  const charge = { typeID: CHARGE_TYPE_ID };
  const makeID = livingEconomy._testing.makeCampaignAdjustmentID;

  const first = makeID(demand, station, missile, 0);
  const retry = makeID(structuredClone(demand), station, missile, 0);
  const otherStationID = makeID(demand, otherStation, missile, 0);
  const otherTypeID = makeID(demand, station, charge, 0);
  const nextChunkID = makeID(demand, station, missile, 4);

  assert.equal(
    first,
    `living-campaign:v2:${SOURCE_EPOCH_MS}:${demand.demandID}:` +
      `${STATION_ID}:${MISSILE_TYPE_ID}:0`,
  );
  assert.equal(retry, first, "a retry must reproduce the exact v2 token");
  assert.notEqual(otherStationID, first, "station identity must scope the token");
  assert.notEqual(otherTypeID, first, "type identity must scope the token");
  assert.notEqual(nextChunkID, first, "fulfillment progress must scope each chunk");

  const legacyDemand = buildDemand();
  delete legacyDemand.adjustmentNamespaceVersion;
  assert.equal(
    makeID(legacyDemand, station, missile, 0),
    `living-campaign:${legacyDemand.demandID}:${MISSILE_TYPE_ID}:0`,
    "a legacy demand must first replay its original token",
  );

  return {
    first,
    otherStationID,
    otherTypeID,
    nextChunkID,
  };
}

async function verifyLostResponseReplay() {
  const requirements = [
    { typeID: MISSILE_TYPE_ID, quantity: 10 },
    { typeID: CHARGE_TYPE_ID, quantity: 20 },
  ];
  const demand = buildDemand({
    demandID: "LEC-00000082",
    requirements,
    requestedUnits: 30,
  });
  const state = buildState(demand);
  const rows = [
    { stationID: STATION_ID, typeID: MISSILE_TYPE_ID, quantity: 10 },
    { stationID: STATION_ID, typeID: CHARGE_TYPE_ID, quantity: 20 },
  ];
  const stockMap = buildStockMap(rows);
  const ledger = new StrictMarketLedger(rows);
  const station = catalog.getStation(STATION_ID);
  const lostID = livingEconomy._testing.makeCampaignAdjustmentID(
    demand,
    station,
    requirements[0],
    0,
  );
  const otherTypeID = livingEconomy._testing.makeCampaignAdjustmentID(
    demand,
    station,
    requirements[1],
    0,
  );
  ledger.loseNextResponse(lostID);
  livingEconomy._testing.setRuntimeStateForTest(state);

  await withLedger(ledger, async () => {
    await livingEconomy._testing.processCampaignDemands(
      stockMap,
      SOURCE_EPOCH_MS + 1_000,
    );
    assert.equal(demand.status, "pending");
    assert.equal(demand.fulfilledQuantities[MISSILE_TYPE_ID] || 0, 0);
    assert.equal(demand.fulfilledQuantities[CHARGE_TYPE_ID], 20);
    assert.equal(state.metrics.campaignUnitsConsumed, 20);

    await livingEconomy._testing.processCampaignDemands(
      stockMap,
      SOURCE_EPOCH_MS + 2_000,
    );
  });

  assert.equal(demand.status, "fulfilled");
  assert.equal(demand.fulfilledQuantities[MISSILE_TYPE_ID], 10);
  assert.equal(demand.fulfilledQuantities[CHARGE_TYPE_ID], 20);
  assert.equal(state.metrics.campaignUnitsConsumed, 30);
  assert.equal(state.metrics.campaignDemandsFulfilled, 1);
  assert.equal(ledger.callCount(lostID), 2);
  assert.equal(ledger.callCount(otherTypeID), 1);
  assert.notEqual(lostID, otherTypeID);
  assert.equal(ledger.externalDelta(STATION_ID, MISSILE_TYPE_ID), -10);
  assert.equal(ledger.externalDelta(STATION_ID, CHARGE_TYPE_ID), -20);
  assert.equal(
    new Set(
      ledger.calls
        .filter((entry) => entry.adjustmentID === lostID)
        .map((entry) => entry.fingerprint),
    ).size,
    1,
    "the lost-response retry must retain the exact request fingerprint",
  );
}

async function verifyPartialFulfillmentRetry() {
  const demand = buildDemand({
    demandID: "LEC-00000083",
    requirements: [{ typeID: MISSILE_TYPE_ID, quantity: 10 }],
    requestedUnits: 10,
  });
  const state = buildState(demand);
  const rows = [{
    stationID: STATION_ID,
    typeID: MISSILE_TYPE_ID,
    quantity: 4,
  }];
  const stockMap = buildStockMap(rows);
  const ledger = new StrictMarketLedger(rows);
  const station = catalog.getStation(STATION_ID);
  const firstChunkID = livingEconomy._testing.makeCampaignAdjustmentID(
    demand,
    station,
    demand.requirements[0],
    0,
  );
  const secondChunkID = livingEconomy._testing.makeCampaignAdjustmentID(
    demand,
    station,
    demand.requirements[0],
    4,
  );
  livingEconomy._testing.setRuntimeStateForTest(state);

  await withLedger(ledger, async () => {
    await livingEconomy._testing.processCampaignDemands(
      stockMap,
      SOURCE_EPOCH_MS + 1_000,
    );
    assert.equal(demand.fulfilledQuantities[MISSILE_TYPE_ID], 4);
    assert.equal(state.metrics.campaignUnitsConsumed, 4);

    stockMap.get(stockKey(STATION_ID, MISSILE_TYPE_ID)).quantity = 6;
    ledger.setQuantity(STATION_ID, MISSILE_TYPE_ID, 6);
    ledger.loseNextResponse(secondChunkID);
    await livingEconomy._testing.processCampaignDemands(
      stockMap,
      SOURCE_EPOCH_MS + 2_000,
    );
    assert.equal(demand.fulfilledQuantities[MISSILE_TYPE_ID], 4);
    assert.equal(state.metrics.campaignUnitsConsumed, 4);

    await livingEconomy._testing.processCampaignDemands(
      stockMap,
      SOURCE_EPOCH_MS + 3_000,
    );
  });

  assert.equal(demand.status, "fulfilled");
  assert.equal(demand.fulfilledQuantities[MISSILE_TYPE_ID], 10);
  assert.equal(state.metrics.campaignUnitsConsumed, 10);
  assert.equal(ledger.callCount(firstChunkID), 1);
  assert.equal(ledger.callCount(secondChunkID), 2);
  assert.deepEqual(
    ledger.calls.map((entry) => entry.adjustmentID),
    [firstChunkID, secondChunkID, secondChunkID],
  );
  assert.equal(
    ledger.externalDelta(STATION_ID, MISSILE_TYPE_ID),
    -10,
    "partial fulfillment plus retry must consume 10 units, not 16",
  );
}

async function verifyLegacyCollisionPromotion() {
  const demand = buildDemand({
    demandID: "LEC-00000084",
    requirements: [{ typeID: MISSILE_TYPE_ID, quantity: 7 }],
    requestedUnits: 7,
  });
  delete demand.adjustmentNamespaceVersion;
  const state = buildState(demand);
  const rows = [{
    stationID: STATION_ID,
    typeID: MISSILE_TYPE_ID,
    quantity: 7,
  }];
  const stockMap = buildStockMap(rows);
  const ledger = new StrictMarketLedger(rows);
  const station = catalog.getStation(STATION_ID);
  const legacyID = livingEconomy._testing.makeCampaignAdjustmentID(
    demand,
    station,
    demand.requirements[0],
    0,
  );
  ledger.seedConflict(legacyID);
  livingEconomy._testing.setRuntimeStateForTest(state);

  await withLedger(ledger, async () => {
    await livingEconomy._testing.processCampaignDemands(
      stockMap,
      SOURCE_EPOCH_MS + 1_000,
    );
    assert.equal(demand.status, "pending");
    assert.equal(demand.adjustmentNamespaceVersion, 2);
    assert.equal(state.metrics.campaignAdjustmentNamespaceMigrations, 1);
    assert.equal(state.metrics.campaignAdjustmentConflictsQuarantined, 0);

    const promotedID = livingEconomy._testing.makeCampaignAdjustmentID(
      demand,
      station,
      demand.requirements[0],
      0,
    );
    assert.notEqual(promotedID, legacyID);
    const restartedDemand = structuredClone(demand);
    assert.equal(
      livingEconomy._testing.makeCampaignAdjustmentID(
        restartedDemand,
        station,
        restartedDemand.requirements[0],
        0,
      ),
      promotedID,
      "the promoted namespace must persist deterministically across restart",
    );

    await livingEconomy._testing.processCampaignDemands(
      stockMap,
      SOURCE_EPOCH_MS + 2_000,
    );
    assert.equal(ledger.callCount(promotedID), 1);
  });

  assert.equal(demand.status, "fulfilled");
  assert.equal(state.metrics.campaignUnitsConsumed, 7);
  assert.equal(ledger.callCount(legacyID), 1);
  assert.equal(ledger.externalDelta(STATION_ID, MISSILE_TYPE_ID), -7);
}

async function verifyV2ConflictQuarantine() {
  const demand = buildDemand({
    demandID: "LEC-00000085",
    requirements: [{ typeID: MISSILE_TYPE_ID, quantity: 9 }],
    requestedUnits: 9,
  });
  const state = buildState(demand);
  const rows = [{
    stationID: STATION_ID,
    typeID: MISSILE_TYPE_ID,
    quantity: 9,
  }];
  const stockMap = buildStockMap(rows);
  const ledger = new StrictMarketLedger(rows);
  const adjustmentID = livingEconomy._testing.makeCampaignAdjustmentID(
    demand,
    catalog.getStation(STATION_ID),
    demand.requirements[0],
    0,
  );
  ledger.seedConflict(adjustmentID);
  livingEconomy._testing.setRuntimeStateForTest(state);

  await withLedger(ledger, async () => {
    await livingEconomy._testing.processCampaignDemands(
      stockMap,
      SOURCE_EPOCH_MS + 1_000,
    );
    assert.equal(demand.status, "adjustment_conflict");
    assert.equal(state.metrics.campaignAdjustmentNamespaceMigrations, 0);
    assert.equal(state.metrics.campaignAdjustmentConflictsQuarantined, 1);
    assert.match(demand.lastError, /different station or type/i);

    await livingEconomy._testing.processCampaignDemands(
      stockMap,
      SOURCE_EPOCH_MS + 2_000,
    );
  });

  assert.equal(ledger.callCount(adjustmentID), 1);
  assert.equal(ledger.externalDelta(STATION_ID, MISSILE_TYPE_ID), 0);
  assert.equal(state.metrics.campaignUnitsConsumed, 0);
  assert.equal(state.metrics.campaignDemandsFulfilled, 0);
  assert.equal(
    state.metrics.campaignAdjustmentConflictsQuarantined,
    1,
    "a quarantined demand must not be retried and recounted",
  );
}

async function main() {
  const identities = verifyV2IdentityStabilityAndDistinctness();
  await verifyLostResponseReplay();
  await verifyPartialFulfillmentRetry();
  await verifyLegacyCollisionPromotion();
  await verifyV2ConflictQuarantine();

  console.log(JSON.stringify({
    success: true,
    v2IdentityStable: true,
    stationTypeAndChunkDistinct: true,
    lostResponseAppliedOnce: true,
    partialFulfillmentAppliedOnce: true,
    legacyCollisionPromoted: true,
    v2CollisionQuarantined: true,
    identities,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
