"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const net = require("net");
const path = require("path");
const Database = require("better-sqlite3");

const { marketDaemonClient } = require(path.join(
  __dirname,
  "../src/services/market/marketDaemonClient",
));
const economyStateStore = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingEconomyState",
));

const REPO_ROOT = path.resolve(__dirname, "../..");
const MARKET_DATABASE = path.join(
  REPO_ROOT,
  "externalservices/market-server/data/generated/market.sqlite",
);
const BACKUP_ROOT = path.join(REPO_ROOT, "_local/living-economy-backups");
const SOURCE_EPOCH_MS = 1_784_562_052_760;
const STATION_ID = 60_001_669;

const REPAIR_JOBS = Object.freeze([
  Object.freeze({
    jobID: "LEI-00019912",
    createdAt: "2026-07-24T18:56:47.175Z",
    productTypeID: 10_836,
    productQuantity: 1,
    inputs: Object.freeze([
      Object.freeze({ typeID: 35, quantity: 1_221 }),
      Object.freeze({ typeID: 36, quantity: 443 }),
      Object.freeze({ typeID: 37, quantity: 104 }),
    ]),
  }),
  Object.freeze({
    jobID: "LEI-00020142",
    createdAt: "2026-07-25T10:42:46.755Z",
    productTypeID: 10_836,
    productQuantity: 1,
    inputs: Object.freeze([
      Object.freeze({ typeID: 35, quantity: 1_221 }),
      Object.freeze({ typeID: 36, quantity: 443 }),
      Object.freeze({ typeID: 37, quantity: 104 }),
    ]),
  }),
  Object.freeze({
    jobID: "LEI-00020174",
    createdAt: "2026-07-25T10:45:19.803Z",
    productTypeID: 3_829,
    productQuantity: 2,
    inputs: Object.freeze([
      Object.freeze({ typeID: 34, quantity: 3_478 }),
      Object.freeze({ typeID: 35, quantity: 840 }),
      Object.freeze({ typeID: 36, quantity: 330 }),
      Object.freeze({ typeID: 37, quantity: 12 }),
    ]),
  }),
  Object.freeze({
    jobID: "LEI-00020192",
    createdAt: "2026-07-25T10:47:54.466Z",
    productTypeID: 10_836,
    productQuantity: 1,
    inputs: Object.freeze([
      Object.freeze({ typeID: 35, quantity: 1_221 }),
      Object.freeze({ typeID: 36, quantity: 443 }),
      Object.freeze({ typeID: 37, quantity: 104 }),
    ]),
  }),
  Object.freeze({
    jobID: "LEI-00020194",
    createdAt: "2026-07-25T10:48:37.667Z",
    productTypeID: 10_836,
    productQuantity: 1,
    inputs: Object.freeze([
      Object.freeze({ typeID: 35, quantity: 1_221 }),
      Object.freeze({ typeID: 36, quantity: 443 }),
      Object.freeze({ typeID: 37, quantity: 104 }),
    ]),
  }),
]);

function parseArguments(argv) {
  return {
    apply: argv.includes("--apply"),
    skipBackup: argv.includes("--skip-backup"),
  };
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function adjustmentID(job, phase, typeID) {
  const createdAtMs = Date.parse(job.createdAt);
  return `living-industry-v2:${SOURCE_EPOCH_MS}:${createdAtMs}:` +
    `${job.jobID}:${STATION_ID}:${job.productTypeID}:${phase}:${typeID}`;
}

function buildRepairAdjustments() {
  return REPAIR_JOBS.flatMap((job) => [
    ...job.inputs.map((input) => ({
      station_id: STATION_ID,
      type_id: input.typeID,
      delta_quantity: -input.quantity,
      new_quantity: null,
      new_price: null,
      reason: `NPC industry input reservation ${job.jobID}`,
      adjustment_id: adjustmentID(job, "input", input.typeID),
      allow_create: false,
    })),
    {
      station_id: STATION_ID,
      type_id: job.productTypeID,
      delta_quantity: job.productQuantity,
      new_quantity: null,
      new_price: null,
      reason: `NPC industry completion ${job.jobID}`,
      adjustment_id: adjustmentID(job, "output", job.productTypeID),
      allow_create: false,
    },
  ]);
}

function normalizeInputs(job) {
  return (Array.isArray(job && job.inputs) ? job.inputs : [])
    .map((input) => ({
      typeID: Number(input.typeID),
      quantity: Number(input.quantity),
    }))
    .sort((left, right) => left.typeID - right.typeID);
}

function validateGameState(economy) {
  assert.equal(
    Number(economy.createdAtMs),
    SOURCE_EPOCH_MS,
    "living-economy source epoch changed; refusing a repair built for another epoch",
  );
  for (const expected of REPAIR_JOBS) {
    const actual = economy.industryJobs && economy.industryJobs[expected.jobID];
    assert.ok(actual, `current GameStore is missing ${expected.jobID}`);
    assert.equal(actual.status, "completed", `${expected.jobID} is no longer completed`);
    assert.equal(Number(actual.createdAtMs), Date.parse(expected.createdAt));
    assert.equal(Number(actual.stationID), STATION_ID);
    assert.equal(Number(actual.productTypeID), expected.productTypeID);
    assert.equal(Number(actual.productQuantity), expected.productQuantity);
    assert.deepEqual(normalizeInputs(actual), normalizeInputs(expected));
  }
}

function loadReceipt(db, adjustmentIDValue) {
  return db.prepare(`
    SELECT adjustment_id, station_id, type_id, delta_quantity, quantity_after,
           reason, applied_at
    FROM seed_stock_adjustments
    WHERE adjustment_id = ?
  `).get(adjustmentIDValue);
}

function validateLegacyReceipts(db) {
  for (const job of REPAIR_JOBS) {
    const createdAtMs = Date.parse(job.createdAt);
    const expected = [
      ...job.inputs.map((input) => ({
        phase: "input",
        typeID: input.typeID,
        delta: -input.quantity,
        reason: `NPC industry input reservation ${job.jobID}`,
      })),
      {
        phase: "output",
        typeID: job.productTypeID,
        delta: job.productQuantity,
        reason: `NPC industry completion ${job.jobID}`,
      },
    ];
    for (const entry of expected) {
      const legacyID = `living-industry:${SOURCE_EPOCH_MS}:` +
        `${job.jobID}:${STATION_ID}:${entry.phase}:${entry.typeID}`;
      const receipt = loadReceipt(db, legacyID);
      assert.ok(receipt, `legacy receipt is missing: ${legacyID}`);
      assert.equal(Number(receipt.station_id), STATION_ID);
      assert.equal(Number(receipt.type_id), entry.typeID);
      assert.equal(Number(receipt.delta_quantity), entry.delta);
      assert.equal(String(receipt.reason), entry.reason);
      assert.ok(
        Date.parse(receipt.applied_at) < createdAtMs,
        `legacy receipt did not predate the current job: ${legacyID}`,
      );
    }
  }
}

function validateV2Receipts(db, adjustments) {
  const present = [];
  for (const adjustment of adjustments) {
    const receipt = loadReceipt(db, adjustment.adjustment_id);
    if (!receipt) continue;
    assert.equal(Number(receipt.station_id), adjustment.station_id);
    assert.equal(Number(receipt.type_id), adjustment.type_id);
    assert.equal(Number(receipt.delta_quantity), adjustment.delta_quantity);
    assert.equal(String(receipt.reason), adjustment.reason);
    present.push(receipt);
  }
  assert.ok(
    present.length === 0 || present.length === adjustments.length,
    `partial v2 repair detected (${present.length}/${adjustments.length}); manual audit required`,
  );
  return present;
}

function readStocks(db, typeIDs) {
  const read = db.prepare(`
    SELECT station_id, type_id, quantity, price
    FROM seed_stock
    WHERE station_id = ? AND type_id = ?
  `);
  return Object.fromEntries(typeIDs.map((typeID) => {
    const row = read.get(STATION_ID, typeID);
    assert.ok(row, `market stock row is missing for station ${STATION_ID}, type ${typeID}`);
    return [String(typeID), {
      quantity: Number(row.quantity),
      price: Number(row.price),
    }];
  }));
}

function aggregateDeltas(adjustments) {
  const totals = {};
  for (const adjustment of adjustments) {
    const key = String(adjustment.type_id);
    totals[key] = (totals[key] || 0) + Number(adjustment.delta_quantity);
  }
  return totals;
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
  assert.ok(fs.existsSync(MARKET_DATABASE), `market database missing: ${MARKET_DATABASE}`);
  const adjustments = buildRepairAdjustments();
  assert.equal(adjustments.length, 21);
  assert.equal(
    new Set(adjustments.map((entry) => entry.adjustment_id)).size,
    adjustments.length,
    "repair adjustment IDs must be unique",
  );

  const economy = economyStateStore.readState({ strict: true });
  validateGameState(economy);
  const db = new Database(MARKET_DATABASE, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    validateLegacyReceipts(db);
    const existingV2 = validateV2Receipts(db, adjustments);
    const typeIDs = [...new Set(adjustments.map((entry) => entry.type_id))]
      .sort((left, right) => left - right);
    const before = readStocks(db, typeIDs);
    const deltas = aggregateDeltas(adjustments);

    if (!options.apply) {
      console.log(JSON.stringify({
        success: true,
        mode: "dry-run",
        gameStateValidated: true,
        legacyReceiptsValidated: adjustments.length,
        v2ReceiptsAlreadyPresent: existingV2.length,
        adjustments: adjustments.length,
        aggregateDeltas: deltas,
        stockBefore: before,
      }, null, 2));
      return;
    }

    assert.equal(
      await isPortOpen(26000),
      false,
      "game server is still listening on 26000; stop it before applying the repair",
    );
    const health = await marketDaemonClient.call("Health", {});
    assert.equal(health && health.status, "ok", "market daemon RPC is not healthy");
    let backupPath = null;
    if (!options.skipBackup && existingV2.length === 0) {
      fs.mkdirSync(BACKUP_ROOT, { recursive: true });
      backupPath = path.join(
        BACKUP_ROOT,
        `market-before-industry-replay-repair-${timestampForPath()}.sqlite`,
      );
      await db.backup(backupPath);
    }

    let responses = [];
    if (existingV2.length === 0) {
      responses = await marketDaemonClient.call("AdjustSeedStocks", {
        adjustments,
      });
      assert.ok(Array.isArray(responses));
      assert.equal(responses.length, adjustments.length);
    }

    const appliedReceipts = validateV2Receipts(db, adjustments);
    assert.equal(appliedReceipts.length, adjustments.length);
    const after = readStocks(db, typeIDs);
    if (existingV2.length === 0) {
      for (const typeID of typeIDs) {
        assert.equal(
          after[typeID].quantity,
          before[typeID].quantity + Number(deltas[typeID] || 0),
          `unexpected repaired stock quantity for type ${typeID}`,
        );
      }
    }
    console.log(JSON.stringify({
      success: true,
      mode: existingV2.length > 0 ? "already-applied" : "applied",
      gameStateValidated: true,
      legacyReceiptsValidated: adjustments.length,
      v2ReceiptsValidated: appliedReceipts.length,
      adjustments: adjustments.length,
      aggregateDeltas: deltas,
      backupPath,
      stockBefore: before,
      stockAfter: after,
      daemonResponses: responses.length,
    }, null, 2));
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
