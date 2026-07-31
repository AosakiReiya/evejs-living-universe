"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const net = require("net");
const path = require("path");
const Database = require("better-sqlite3");

const economyStateStore = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingEconomyState",
));

const REPO_ROOT = path.resolve(__dirname, "../..");
const MARKET_DATABASE = path.join(
  REPO_ROOT,
  "externalservices/market-server/data/generated/market.sqlite",
);
const SOURCE_EPOCH_MS = 1_784_562_052_760;
const STATION_ID = 60_001_669;
const RECOVERY = Object.freeze([
  Object.freeze({
    jobID: "LEI-00020177",
    createdAt: "2026-07-25T10:45:58.108Z",
    productTypeID: 3_829,
    reservedInputTypeIDs: Object.freeze([34]),
    inputs: Object.freeze([
      Object.freeze({ typeID: 34, quantity: 3_478 }),
      Object.freeze({ typeID: 35, quantity: 840 }),
      Object.freeze({ typeID: 36, quantity: 330 }),
      Object.freeze({ typeID: 37, quantity: 12 }),
    ]),
  }),
  Object.freeze({
    jobID: "LEI-00020196",
    createdAt: "2026-07-25T10:51:00.571Z",
    productTypeID: 10_836,
    reservedInputTypeIDs: Object.freeze([]),
    inputs: Object.freeze([
      Object.freeze({ typeID: 35, quantity: 1_221 }),
      Object.freeze({ typeID: 36, quantity: 443 }),
      Object.freeze({ typeID: 37, quantity: 104 }),
    ]),
  }),
]);

function parseArguments(argv) {
  const options = {
    apply: false,
    backupGameStore: "",
    verifyCompleted: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--apply") {
      options.apply = true;
    } else if (argv[index] === "--verify-completed") {
      options.verifyCompleted = true;
    } else if (argv[index] === "--backup-gamestore" && argv[index + 1]) {
      options.backupGameStore = path.resolve(argv[index + 1]);
      index += 1;
    }
  }
  return options;
}

function findBackupEconomy(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const exact = db
      .prepare("SELECT key, json FROM npcRuntimeState WHERE key = ?")
      .get("livingEconomy");
    const rows = exact
      ? [exact]
      : db.prepare("SELECT key, json FROM npcRuntimeState").all();
    for (const row of rows) {
      let parsed = null;
      try {
        parsed = JSON.parse(row.json);
      } catch {
        continue;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        Number(parsed.createdAtMs) === SOURCE_EPOCH_MS &&
        parsed.industryJobs &&
        typeof parsed.industryJobs === "object"
      ) {
        return parsed;
      }
    }
  } finally {
    db.close();
  }
  throw new Error("backup GameStore does not contain a living-economy state row");
}

function normalizedInputs(job) {
  return (Array.isArray(job && job.inputs) ? job.inputs : [])
    .map((input) => ({
      typeID: Number(input.typeID),
      quantity: Number(input.quantity),
    }))
    .sort((left, right) => left.typeID - right.typeID);
}

function validateBackupJob(job, expected) {
  assert.ok(job, `backup is missing ${expected.jobID}`);
  assert.equal(job.jobID, expected.jobID);
  assert.equal(job.status, "reserving");
  assert.equal(Number(job.createdAtMs), Date.parse(expected.createdAt));
  assert.equal(Number(job.stationID), STATION_ID);
  assert.equal(Number(job.productTypeID), expected.productTypeID);
  assert.deepEqual(normalizedInputs(job), normalizedInputs(expected));
  assert.deepEqual(
    [...(job.reservedInputTypeIDs || [])].map(Number).sort((a, b) => a - b),
    [...expected.reservedInputTypeIDs],
  );
}

function activeV2AdjustmentIDs(job, expected) {
  const base = `living-industry-v2:${SOURCE_EPOCH_MS}:${job.createdAtMs}:` +
    `${job.jobID}:${STATION_ID}:${job.productTypeID}`;
  const reserved = new Set(expected.reservedInputTypeIDs);
  return [
    ...expected.inputs
      .filter((input) => !reserved.has(input.typeID))
      .map((input) => `${base}:input:${input.typeID}`),
    `${base}:output:${job.productTypeID}`,
  ];
}

function validateUnusedV2Receipts(jobs) {
  const db = new Database(MARKET_DATABASE, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const read = db.prepare(
      "SELECT adjustment_id FROM seed_stock_adjustments WHERE adjustment_id = ?",
    );
    for (const { job, expected } of jobs) {
      for (const adjustmentID of activeV2AdjustmentIDs(job, expected)) {
        assert.equal(
          read.get(adjustmentID),
          undefined,
          `active recovery token is already present: ${adjustmentID}`,
        );
      }
    }
  } finally {
    db.close();
  }
}

function validateRecoveryProgress(economy, jobs) {
  const db = new Database(MARKET_DATABASE, {
    readonly: true,
    fileMustExist: true,
  });
  let receiptCount = 0;
  const statuses = {};
  try {
    const read = db.prepare(`
      SELECT adjustment_id, station_id, type_id, delta_quantity, reason
      FROM seed_stock_adjustments
      WHERE adjustment_id = ?
    `);
    for (const { job, expected } of jobs) {
      const currentJob = economy.industryJobs && economy.industryJobs[expected.jobID];
      assert.ok(currentJob, `recovered job is missing: ${expected.jobID}`);
      assert.ok(
        ["running", "completed"].includes(String(currentJob.status)),
        `${expected.jobID} did not leave reservation: ${currentJob.status}`,
      );
      assert.equal(Number(currentJob.adjustmentNamespaceVersion), 2);
      statuses[expected.jobID] = {
        status: currentJob.status,
        endsAt: currentJob.endsAtMs
          ? new Date(currentJob.endsAtMs).toISOString()
          : null,
      };
      const expectedByID = new Map();
      for (const input of expected.inputs) {
        if (expected.reservedInputTypeIDs.includes(input.typeID)) continue;
        const id = activeV2AdjustmentIDs(job, expected)
          .find((value) => value.endsWith(`:input:${input.typeID}`));
        expectedByID.set(id, {
          typeID: input.typeID,
          delta: -input.quantity,
          reason: `NPC industry input reservation ${expected.jobID}`,
        });
      }
      if (String(currentJob.status) === "completed") {
        const outputID = activeV2AdjustmentIDs(job, expected)
          .find((value) => value.includes(":output:"));
        expectedByID.set(outputID, {
          typeID: expected.productTypeID,
          delta: Number(job.productQuantity),
          reason: `NPC industry completion ${expected.jobID}`,
        });
      }
      for (const [id, expectedReceipt] of expectedByID.entries()) {
        const receipt = read.get(id);
        assert.ok(receipt, `recovery receipt is missing: ${id}`);
        assert.equal(Number(receipt.station_id), STATION_ID);
        assert.equal(Number(receipt.type_id), expectedReceipt.typeID);
        assert.equal(Number(receipt.delta_quantity), expectedReceipt.delta);
        assert.equal(String(receipt.reason), expectedReceipt.reason);
        receiptCount += 1;
      }
    }
  } finally {
    db.close();
  }
  assert.equal(Number(economy.metrics.industryAdjustmentConflictsQuarantined || 0), 0);
  assert.ok(Number(economy.metrics.industryAdjustmentBatchRecoveryJobs || 0) >= 2);
  return { receiptCount, statuses };
}

function assignRecoveryBlueprint(economy, job, nowMs) {
  if (!job.blueprintAssetID) {
    return { mode: "not-required", blueprintAssetID: null };
  }
  const originalAssetID = job.blueprintAssetID;
  const original = economy.industryBlueprints[originalAssetID];
  if (
    original &&
    original.original !== true &&
    (!original.inUseByJobID || original.inUseByJobID === job.jobID) &&
    Number(original.runsRemaining || 0) >= Number(job.runs || 0)
  ) {
    original.inUseByJobID = job.jobID;
    original.updatedAtMs = nowMs;
    return { mode: "original-copy", blueprintAssetID: originalAssetID };
  }
  const replacement = Object.values(economy.industryBlueprints || {})
    .filter((blueprint) => (
      blueprint &&
      blueprint.original !== true &&
      Number(blueprint.blueprintTypeID) === Number(job.blueprintTypeID) &&
      !blueprint.inUseByJobID &&
      Number(blueprint.runsRemaining || 0) >= Number(job.runs || 0)
    ))
    .sort((left, right) => (
      Number(left.runsRemaining || 0) - Number(right.runsRemaining || 0) ||
      String(left.blueprintAssetID).localeCompare(String(right.blueprintAssetID))
    ))[0];
  job.recoveryOriginalBlueprintAssetID = originalAssetID;
  if (replacement) {
    job.blueprintAssetID = replacement.blueprintAssetID;
    replacement.inUseByJobID = job.jobID;
    replacement.updatedAtMs = nowMs;
    return {
      mode: "reassigned-copy",
      blueprintAssetID: replacement.blueprintAssetID,
      originalAssetID,
    };
  }
  delete job.blueprintAssetID;
  job.blueprintRecoveryBypass = true;
  job.blueprintRecoveryBypassReason =
    "original copy was reassigned after erroneous batch quarantine";
  return {
    mode: "one-time-bypass",
    blueprintAssetID: null,
    originalAssetID,
  };
}

function isPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  assert.ok(options.backupGameStore, "--backup-gamestore is required");
  assert.ok(
    fs.existsSync(options.backupGameStore),
    `backup GameStore is missing: ${options.backupGameStore}`,
  );
  const backup = findBackupEconomy(options.backupGameStore);
  assert.equal(Number(backup.createdAtMs), SOURCE_EPOCH_MS);
  const recoveries = RECOVERY.map((expected) => {
    const job = backup.industryJobs && backup.industryJobs[expected.jobID];
    validateBackupJob(job, expected);
    return { expected, job: structuredClone(job) };
  });

  const current = economyStateStore.readState({ strict: true });
  assert.equal(Number(current.createdAtMs), SOURCE_EPOCH_MS);
  if (options.verifyCompleted) {
    const progress = validateRecoveryProgress(current, recoveries);
    console.log(JSON.stringify({
      success: true,
      mode: "verified-progress",
      jobs: recoveries.map(({ expected }) => expected.jobID),
      statuses: progress.statuses,
      v2ReceiptsValidated: progress.receiptCount,
      adjustmentConflicts: 0,
    }, null, 2));
    return;
  }
  validateUnusedV2Receipts(recoveries);
  const alreadyPresent = recoveries.filter(
    ({ expected }) => current.industryJobs && current.industryJobs[expected.jobID],
  );
  assert.ok(
    alreadyPresent.length === 0 || alreadyPresent.length === recoveries.length,
    "partial active-job recovery detected; manual audit required",
  );

  if (!options.apply) {
    console.log(JSON.stringify({
      success: true,
      mode: "dry-run",
      backupValidated: true,
      v2TokensUnused: true,
      alreadyPresent: alreadyPresent.map(({ expected }) => expected.jobID),
      jobsToRecover: recoveries.map(({ expected }) => expected.jobID),
    }, null, 2));
    return;
  }

  assert.equal(
    await isPortOpen(26000),
    false,
    "game server is still listening on 26000; stop it before recovering jobs",
  );
  if (alreadyPresent.length === recoveries.length) {
    console.log(JSON.stringify({
      success: true,
      mode: "already-recovered",
      jobs: alreadyPresent.map(({ expected }) => expected.jobID),
    }, null, 2));
    return;
  }

  const nowMs = Date.now();
  const blueprintRecovery = {};
  for (const { expected, job } of recoveries) {
    job.status = "reserving";
    job.adjustmentNamespaceVersion = 2;
    job.adjustmentNamespaceMigratedAtMs = nowMs;
    job.updatedAtMs = nowMs;
    job.lastError = null;
    delete job.adjustmentConflictAtMs;
    delete job.nextCompletionAttemptAtMs;
    blueprintRecovery[expected.jobID] = assignRecoveryBlueprint(
      current,
      job,
      nowMs,
    );
    current.industryJobs[expected.jobID] = job;
  }
  current.metrics.industryAdjustmentConflictsQuarantined = 0;
  current.metrics.industryAdjustmentBatchRecoveryJobs =
    Number(current.metrics.industryAdjustmentBatchRecoveryJobs || 0) + recoveries.length;
  current.updatedAtMs = nowMs;
  const write = economyStateStore.writeState(current);
  assert.equal(write && write.success, true, write && write.errorMsg || "state write failed");
  const durable = economyStateStore.flushDurably();
  assert.equal(
    durable && durable.success,
    true,
    durable && durable.errorMsg || "durable state flush failed",
  );
  const verified = economyStateStore.readState({ strict: true });
  for (const { expected } of recoveries) {
    const restored = verified.industryJobs[expected.jobID];
    assert.ok(restored);
    assert.equal(restored.status, "reserving");
    assert.equal(restored.adjustmentNamespaceVersion, 2);
    assert.deepEqual(
      [...restored.reservedInputTypeIDs].map(Number).sort((a, b) => a - b),
      [...expected.reservedInputTypeIDs],
    );
  }
  console.log(JSON.stringify({
    success: true,
    mode: "applied",
    jobsRecovered: recoveries.map(({ expected }) => expected.jobID),
    preservedReservedInputs: Object.fromEntries(
      recoveries.map(({ expected }) => [
        expected.jobID,
        expected.reservedInputTypeIDs,
      ]),
    ),
    adjustmentNamespaceVersion: 2,
    blueprintRecovery,
    durable: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
