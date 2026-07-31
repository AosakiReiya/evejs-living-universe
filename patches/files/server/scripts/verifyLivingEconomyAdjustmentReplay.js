"use strict";

const assert = require("assert/strict");
const path = require("path");

const salvage = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingEconomySalvage",
));
const livingEconomy = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingEconomyRuntime",
));

function buildDeliveryState(epochMs, stationID, typeID, options = {}) {
  const jobID = "LEZ-00000065";
  const siteID = "LES-replay-test";
  return {
    createdAtMs: epochMs,
    nextSalvageJobNumber: 66,
    metrics: {},
    salvageSites: {
      [siteID]: {
        siteID,
        status: "returning",
        completedAtMs: 0,
        lastUpdatedAtMs: epochMs,
      },
    },
    salvageJobs: {
      [jobID]: {
        jobID,
        siteID,
        status: "delivery_pending",
        destinationStationID: stationID,
        outputs: [{ typeID, quantity: 7 }],
        creditedTypeIDs: [],
        adjustmentEpochMs: options.legacy === true ? undefined : epochMs,
        createdAtMs: epochMs + 1,
        completedAtMs: 0,
        lastUpdatedAtMs: epochMs + 1,
      },
    },
  };
}

async function captureDeliveryAdjustment(state, typeID, options = {}) {
  let captured = null;
  await salvage.process(state, new Map(), {
    getStation(stationID) {
      return { stationID, name: `Station ${stationID}` };
    },
    getGood(requestedTypeID) {
      return requestedTypeID === typeID
        ? { typeID, name: `Type ${typeID}`, priceAnchor: 5 }
        : null;
    },
    async adjustStocks(adjustments) {
      captured = adjustments[0];
      return adjustments.map(() => ({
        success: false,
        retryable: true,
        error: new Error(options.errorMessage || "simulated lost response"),
      }));
    },
  }, state.createdAtMs + 10_000);
  assert.ok(captured, "delivery must submit a stock adjustment");
  return {
    adjustmentID: captured.adjustmentID,
    state,
  };
}

async function main() {
  const epochA = 1_784_556_205_276;
  const stateBeforeCommit = buildDeliveryState(epochA, 60_013_933, 25_589);
  const first = await captureDeliveryAdjustment(
    structuredClone(stateBeforeCommit),
    25_589,
  );
  const firstID = first.adjustmentID;

  // A daemon success followed by a lost response leaves the caller's durable
  // state unchanged. A restarted caller must submit the exact same token.
  const restart = await captureDeliveryAdjustment(
    structuredClone(stateBeforeCommit),
    25_589,
  );
  const restartID = restart.adjustmentID;
  assert.equal(restartID, firstID, "restart retry token must be stable");

  // A total economy reset may rewind a legacy salvage counter. The epoch and
  // station/type scope must prevent that recycled LEZ number from colliding
  // with the old daemon receipt.
  const epochB = epochA + 1;
  const reset = await captureDeliveryAdjustment(
    buildDeliveryState(epochB, 60_000_001, 25_599),
    25_599,
  );
  const resetID = reset.adjustmentID;
  assert.notEqual(resetID, firstID, "reset epoch must isolate a recycled counter");
  assert.match(firstID, new RegExp(`^living-salvage:${epochA}:`));
  assert.match(resetID, new RegExp(`^living-salvage:${epochB}:`));

  // Upgrade compatibility: first try the legacy token so an already-committed
  // receipt cannot be duplicated. Only a proven token collision promotes the
  // in-flight job to the epoch-scoped namespace for its next pulse.
  const legacyState = buildDeliveryState(
    epochB,
    60_000_001,
    25_601,
    { legacy: true },
  );
  const legacyAttempt = await captureDeliveryAdjustment(
    legacyState,
    25_601,
    {
      errorMessage:
        "seed stock adjustment id was already used for a different station or type",
    },
  );
  assert.equal(
    legacyAttempt.adjustmentID,
    "LEZ-00000065:salvage:25601",
    "legacy job must first replay its original token",
  );
  assert.equal(
    legacyState.salvageJobs["LEZ-00000065"].adjustmentEpochMs,
    epochB,
    "proven collision must promote the legacy job namespace",
  );
  const migratedAttempt = await captureDeliveryAdjustment(
    legacyState,
    25_601,
  );
  assert.match(
    migratedAttempt.adjustmentID,
    new RegExp(`^living-salvage:${epochB}:`),
  );
  assert.notEqual(migratedAttempt.adjustmentID, legacyAttempt.adjustmentID);

  const previousCounters = {
    nextJobNumber: 19,
    nextIndustryJobNumber: 20_011,
    nextIndustryPilotNumber: 2_001,
    nextIndustryBlueprintNumber: 801,
    nextReplacementDemandNumber: 71,
    nextCampaignDemandNumber: 81,
    nextSalvageJobNumber: 66,
  };
  const resetState = {};
  livingEconomy._testing.preserveExternalAdjustmentCounters(
    previousCounters,
    resetState,
  );
  for (const key of livingEconomy._testing.EXTERNAL_ADJUSTMENT_COUNTER_KEYS) {
    assert.equal(
      resetState[key],
      previousCounters[key],
      `${key} must survive a total economy reset`,
    );
  }

  console.log(JSON.stringify({
    success: true,
    restartReplayStable: true,
    resetCounterCollisionIsolated: true,
    legacyReceiptMigrationSafe: true,
    counterKeysPreserved:
      livingEconomy._testing.EXTERNAL_ADJUSTMENT_COUNTER_KEYS.length,
    firstID,
    restartID,
    resetID,
    legacyID: legacyAttempt.adjustmentID,
    migratedID: migratedAttempt.adjustmentID,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
