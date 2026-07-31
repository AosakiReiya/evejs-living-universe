"use strict";

const assert = require("assert/strict");
const path = require("path");

const industry = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingEconomyIndustry",
));

const SOURCE_EPOCH_MS = 1_784_562_052_760;
const STATION_ID = 60_001_669;
const SYSTEM_ID = 30_000_142;

function buildMetrics() {
  return {
    industryJobsInstalled: 0,
    industryJobsCompleted: 0,
    industryInputUnitsConsumed: 0,
    industryInputValueISK: 0,
    industryOutputUnitsProduced: 0,
    industryOutputValueISK: 0,
    industryBlueprintSecondsScheduled: 0,
    industryBlueprintCopyRunsConsumed: 0,
    industryAdjustmentNamespaceMigrations: 0,
    industryAdjustmentConflictsQuarantined: 0,
    unitsProduced: 0,
    productionRuns: 0,
  };
}

function buildState(overrides = {}) {
  return {
    createdAtMs: SOURCE_EPOCH_MS,
    nextIndustryJobNumber: 1,
    nextIndustryPilotNumber: 1,
    nextIndustryBlueprintNumber: 1,
    industryJobs: {},
    industryPilots: {},
    industryBlueprints: {},
    productionClocks: {},
    metrics: buildMetrics(),
    ...overrides,
  };
}

function buildJob(overrides = {}) {
  const createdAtMs = 1_785_000_000_000;
  return {
    jobID: "LEI-00030001",
    status: "reserving",
    activity: "manufacturing",
    activityGroup: "manufacturing",
    corporationID: 1_000_035,
    stationID: STATION_ID,
    systemID: SYSTEM_ID,
    blueprintTypeID: 3_830,
    blueprintName: "Medium Shield Extender I Blueprint",
    productTypeID: 3_829,
    productTypeName: "Medium Shield Extender I",
    productQuantity: 2,
    productQuantityPerRun: 1,
    runs: 2,
    timePerRunSeconds: 60,
    durationSeconds: 120,
    inputs: [
      {
        typeID: 34,
        typeName: "Tritanium",
        quantity: 100,
        unitValue: 4,
        valueISK: 400,
      },
      {
        typeID: 35,
        typeName: "Pyerite",
        quantity: 200,
        unitValue: 8,
        valueISK: 1_600,
      },
    ],
    reservedInputTypeIDs: [],
    inputValueISK: 2_000,
    outputValueISK: 170_000,
    adjustmentNamespaceVersion: 2,
    createdAtMs,
    updatedAtMs: createdAtMs,
    ...overrides,
  };
}

function adjustmentFingerprint(adjustment) {
  return JSON.stringify({
    stationID: Number(adjustment.station && adjustment.station.stationID),
    typeID: Number(adjustment.good && adjustment.good.typeID),
    deltaQuantity: Number(adjustment.deltaQuantity),
    reason: String(adjustment.reason || ""),
  });
}

class StrictMarketLedger {
  constructor(options = {}) {
    this.receipts = new Map();
    this.calls = [];
    this.appliedByStockKey = new Map();
    this.loseOnce = options.loseOnce || (() => false);
    this.lostTokens = new Set();
  }

  seed(adjustmentID, fingerprint) {
    this.receipts.set(String(adjustmentID), String(fingerprint));
  }

  appliedDelta(stationID, typeID) {
    return this.appliedByStockKey.get(`${stationID}:${typeID}`) || 0;
  }

  callCount(adjustmentID) {
    return this.calls.filter((call) => call.adjustmentID === adjustmentID).length;
  }

  async adjustStocks(adjustments) {
    return Promise.all(adjustments.map((adjustment) => this.adjust(adjustment)));
  }

  async adjust(adjustment) {
    const adjustmentID = String(adjustment.adjustmentID);
    const fingerprint = adjustmentFingerprint(adjustment);
    this.calls.push({ adjustmentID, fingerprint });
    const prior = this.receipts.get(adjustmentID);
    if (prior !== undefined) {
      if (prior !== fingerprint) {
        return {
          success: false,
          retryable: true,
          error: new Error(
            "seed stock adjustment id was already used with a different delta",
          ),
        };
      }
      return { success: true, replayed: true };
    }

    this.receipts.set(adjustmentID, fingerprint);
    const stockKey = `${Number(adjustment.station.stationID)}:` +
      `${Number(adjustment.good.typeID)}`;
    this.appliedByStockKey.set(
      stockKey,
      this.appliedDelta(
        Number(adjustment.station.stationID),
        Number(adjustment.good.typeID),
      ) + Number(adjustment.deltaQuantity),
    );
    if (this.loseOnce(adjustment) && !this.lostTokens.has(adjustmentID)) {
      this.lostTokens.add(adjustmentID);
      return {
        success: false,
        retryable: true,
        error: new Error("simulated committed adjustment with lost response"),
      };
    }
    return { success: true, replayed: false };
  }
}

function buildDependencies(ledger) {
  return {
    getStockRow() {
      return { quantity: 1_000_000 };
    },
    adjustStocks(adjustments) {
      return ledger.adjustStocks(adjustments);
    },
    adjustStock(adjustment) {
      return ledger.adjust(adjustment);
    },
    addEvent() {},
  };
}

async function verifyCounterRecovery() {
  const retainedState = buildState({
    nextIndustryJobNumber: 177,
    industryJobs: {
      "LEI-00020177": { jobID: "LEI-00020177", status: "completed" },
      "LEI-00020196": { jobID: "LEI-00020196", status: "completed" },
    },
  });
  assert.equal(
    industry._testing.makeIndustryJobID(retainedState),
    "LEI-00020197",
    "allocator must recover above every retained LEI number",
  );
  assert.ok(retainedState.industryJobs["LEI-00020177"]);
  assert.ok(retainedState.industryJobs["LEI-00020196"]);

  retainedState.nextIndustryJobNumber = 1;
  assert.equal(
    industry._testing.makeIndustryJobID(retainedState),
    "LEI-00020198",
    "an in-process counter regression must not reuse an allocated ID",
  );

  const nowMs = 1_785_000_500_000;
  const completedJobs = {};
  for (let number = 20_401; number <= 21_000; number += 1) {
    const jobID = `LEI-${String(number).padStart(8, "0")}`;
    completedJobs[jobID] = {
      jobID,
      status: "completed",
      completedAtMs: nowMs - (31 * 24 * 60 * 60 * 1_000),
    };
  }
  const prunedState = buildState({
    nextIndustryJobNumber: 21_001,
    industryJobs: completedJobs,
  });
  industry._testing.pruneJobs(prunedState, nowMs);
  assert.equal(Object.keys(prunedState.industryJobs).length, 0);
  const firstRestart = structuredClone(prunedState);
  assert.equal(
    industry._testing.makeIndustryJobID(firstRestart),
    "LEI-00021001",
    "persisted high-water counter must survive after every old job is pruned",
  );
  const secondRestart = structuredClone(firstRestart);
  assert.equal(
    industry._testing.makeIndustryJobID(secondRestart),
    "LEI-00021002",
    "successive restart allocations must remain monotonic",
  );
}

async function verifyPartialInputReplay() {
  const job = buildJob();
  const state = buildState({
    nextIndustryJobNumber: 30_002,
    industryJobs: { [job.jobID]: job },
  });
  const ledger = new StrictMarketLedger({
    loseOnce: (adjustment) => String(adjustment.adjustmentID).endsWith(":input:35"),
  });
  const dependencies = buildDependencies(ledger);
  const first = await industry._testing.reserveInputs(
    state,
    job,
    new Map(),
    dependencies,
    job.createdAtMs + 1_000,
  );
  assert.equal(first, false);
  assert.deepEqual(
    job.reservedInputTypeIDs,
    [34],
    JSON.stringify({ lastError: job.lastError, calls: ledger.calls }),
  );

  const tritaniumID = industry._testing.makeIndustryAdjustmentID(
    state,
    job,
    "input",
    34,
  );
  const pyeriteID = industry._testing.makeIndustryAdjustmentID(
    state,
    job,
    "input",
    35,
  );
  const restartedState = structuredClone(state);
  const restartedJob = restartedState.industryJobs[job.jobID];
  assert.equal(
    industry._testing.makeIndustryAdjustmentID(
      restartedState,
      restartedJob,
      "input",
      35,
    ),
    pyeriteID,
    "a lost-response retry must retain the exact v2 token after restart",
  );
  const second = await industry._testing.reserveInputs(
    restartedState,
    restartedJob,
    new Map(),
    dependencies,
    job.createdAtMs + 2_000,
  );
  assert.equal(second, true);
  assert.equal(restartedJob.status, "running");
  assert.deepEqual(
    [...restartedJob.reservedInputTypeIDs].sort((left, right) => left - right),
    [34, 35],
  );
  assert.equal(ledger.callCount(tritaniumID), 1);
  assert.equal(ledger.callCount(pyeriteID), 2);
  assert.equal(ledger.appliedDelta(STATION_ID, 34), -100);
  assert.equal(ledger.appliedDelta(STATION_ID, 35), -200);
  assert.equal(restartedState.metrics.industryInputUnitsConsumed, 300);
}

async function verifyOutputReplay() {
  const nowMs = 1_785_001_000_000;
  const job = buildJob({
    jobID: "LEI-00030002",
    status: "running",
    inputs: [],
    reservedInputTypeIDs: [],
    startedAtMs: nowMs - 120_000,
    endsAtMs: nowMs - 1,
    createdAtMs: nowMs - 180_000,
  });
  const state = buildState({
    nextIndustryJobNumber: 30_003,
    industryJobs: { [job.jobID]: job },
  });
  const ledger = new StrictMarketLedger({
    loseOnce: (adjustment) => String(adjustment.adjustmentID).includes(":output:"),
  });
  const dependencies = buildDependencies(ledger);
  assert.equal(
    await industry._testing.processDueCompletions(
      state,
      new Map(),
      dependencies,
      nowMs,
    ),
    0,
  );
  assert.equal(job.status, "output_pending");
  const outputID = industry._testing.makeIndustryAdjustmentID(
    state,
    job,
    "output",
    job.productTypeID,
  );

  const restartedState = structuredClone(state);
  const restartedJob = restartedState.industryJobs[job.jobID];
  assert.equal(
    industry._testing.makeIndustryAdjustmentID(
      restartedState,
      restartedJob,
      "output",
      restartedJob.productTypeID,
    ),
    outputID,
  );
  assert.equal(
    await industry._testing.processDueCompletions(
      restartedState,
      new Map(),
      dependencies,
      nowMs + 31_000,
    ),
    1,
  );
  assert.equal(restartedJob.status, "completed");
  assert.equal(ledger.callCount(outputID), 2);
  assert.equal(ledger.appliedDelta(STATION_ID, 3_829), 2);
  assert.equal(restartedState.metrics.industryJobsCompleted, 1);
  assert.equal(restartedState.metrics.industryOutputUnitsProduced, 2);
  assert.equal(restartedState.metrics.unitsProduced, 2);
}

async function verifyLegacyCollisionPromotion() {
  const job = buildJob({
    jobID: "LEI-00020177",
    productTypeID: 3_829,
    inputs: [
      {
        typeID: 35,
        typeName: "Pyerite",
        quantity: 840,
        unitValue: 8,
        valueISK: 6_720,
      },
      {
        typeID: 36,
        typeName: "Mexallon",
        quantity: 330,
        unitValue: 60,
        valueISK: 19_800,
      },
      {
        typeID: 37,
        typeName: "Isogen",
        quantity: 12,
        unitValue: 250,
        valueISK: 3_000,
      },
    ],
    inputValueISK: 29_520,
  });
  delete job.adjustmentNamespaceVersion;
  const state = buildState({
    nextIndustryJobNumber: 20_220,
    industryJobs: { [job.jobID]: job },
  });
  const legacyID = industry._testing.makeIndustryAdjustmentID(
    state,
    job,
    "input",
    35,
  );
  const ledger = new StrictMarketLedger();
  for (const input of job.inputs) {
    const inputLegacyID = industry._testing.makeIndustryAdjustmentID(
      state,
      job,
      "input",
      input.typeID,
    );
    ledger.seed(inputLegacyID, JSON.stringify({
      stationID: STATION_ID,
      typeID: input.typeID,
      deltaQuantity: -Math.max(1, Math.floor(input.quantity / 2)),
      reason: `NPC industry input reservation ${job.jobID}`,
    }));
  }
  const dependencies = buildDependencies(ledger);
  assert.equal(
    await industry._testing.reserveInputs(
      state,
      job,
      new Map(),
      dependencies,
      job.createdAtMs + 1_000,
    ),
    false,
  );
  assert.equal(job.adjustmentNamespaceVersion, 2);
  assert.equal(state.metrics.industryAdjustmentNamespaceMigrations, 1);
  assert.equal(state.metrics.industryAdjustmentConflictsQuarantined, 0);
  assert.equal(job.status, "reserving");
  const promotedID = industry._testing.makeIndustryAdjustmentID(
    state,
    job,
    "input",
    35,
  );
  assert.notEqual(promotedID, legacyID);
  const restartedState = structuredClone(state);
  const restartedJob = restartedState.industryJobs[job.jobID];
  assert.equal(
    industry._testing.makeIndustryAdjustmentID(
      restartedState,
      restartedJob,
      "input",
      35,
    ),
    promotedID,
    "the promoted namespace must be deterministic across restart",
  );
  assert.equal(
    await industry._testing.reserveInputs(
      restartedState,
      restartedJob,
      new Map(),
      dependencies,
      job.createdAtMs + 2_000,
    ),
    true,
  );
  assert.equal(restartedJob.status, "running");
  assert.equal(ledger.appliedDelta(STATION_ID, 35), -840);
  assert.equal(ledger.appliedDelta(STATION_ID, 36), -330);
  assert.equal(ledger.appliedDelta(STATION_ID, 37), -12);
}

async function verifyV2CollisionQuarantine() {
  const job = buildJob({
    jobID: "LEI-00030003",
    inputs: [{
      typeID: 35,
      typeName: "Pyerite",
      quantity: 840,
      unitValue: 8,
      valueISK: 6_720,
    }],
  });
  const state = buildState({
    nextIndustryJobNumber: 30_004,
    industryJobs: { [job.jobID]: job },
  });
  const adjustmentID = industry._testing.makeIndustryAdjustmentID(
    state,
    job,
    "input",
    35,
  );
  const ledger = new StrictMarketLedger();
  ledger.seed(adjustmentID, JSON.stringify({
    stationID: STATION_ID,
    typeID: 35,
    deltaQuantity: -443,
    reason: `NPC industry input reservation ${job.jobID}`,
  }));
  assert.equal(
    await industry._testing.reserveInputs(
      state,
      job,
      new Map(),
      buildDependencies(ledger),
      job.createdAtMs + 1_000,
    ),
    false,
  );
  assert.equal(job.status, "adjustment_conflict");
  assert.equal(state.metrics.industryAdjustmentConflictsQuarantined, 1);
  assert.equal(ledger.callCount(adjustmentID), 1);
  industry._testing.pruneJobs(
    state,
    job.createdAtMs + (365 * 24 * 60 * 60 * 1_000),
  );
  assert.equal(
    state.industryJobs[job.jobID],
    job,
    "quarantined evidence must survive completed-job pruning",
  );
}

async function verifyNewJobsUseV2() {
  const state = buildState({ nextIndustryJobNumber: 31_000 });
  const nowMs = 1_785_002_000_000;
  const job = industry._testing.createJob(state, {
    station: {
      stationID: STATION_ID,
      systemID: SYSTEM_ID,
    },
    recipe: {
      blueprintTypeID: 3_830,
      blueprintName: "Medium Shield Extender I Blueprint",
    },
    good: {
      typeID: 3_829,
      name: "Medium Shield Extender I",
      priceAnchor: 85_000,
    },
    outputQuantity: 2,
    runs: 2,
    timePerRunSeconds: 60,
    durationSeconds: 120,
    inputs: [{
      typeID: 35,
      typeName: "Pyerite",
      quantity: 840,
      unitValue: 8,
      valueISK: 6_720,
    }],
  }, nowMs);
  assert.equal(job.adjustmentNamespaceVersion, 2);
  assert.match(
    industry._testing.makeIndustryAdjustmentID(state, job, "input", 35),
    new RegExp(`^living-industry-v2:${SOURCE_EPOCH_MS}:${nowMs}:`),
  );
}

async function main() {
  await verifyCounterRecovery();
  await verifyPartialInputReplay();
  await verifyOutputReplay();
  await verifyLegacyCollisionPromotion();
  await verifyV2CollisionQuarantine();
  await verifyNewJobsUseV2();
  console.log(JSON.stringify({
    success: true,
    counterFloorRecovered: true,
    postPruneRestartIDs: ["LEI-00021001", "LEI-00021002"],
    inputAppliedOnce: true,
    outputAppliedOnce: true,
    partialBatchSafe: true,
    legacyCollisionPromoted: true,
    v2CollisionQuarantined: true,
    quarantinedEvidenceRetained: true,
    stableFingerprints: true,
    newJobsUseV2: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
