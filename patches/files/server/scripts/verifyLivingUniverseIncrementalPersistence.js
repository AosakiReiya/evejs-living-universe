"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");
const { spawnSync } = require("child_process");

const RELOAD_MODE = process.argv[2] === "--reload";
const suppliedRoot = RELOAD_MODE ? path.resolve(process.argv[3] || "") : null;
const temporaryRoot = suppliedRoot ||
  fs.mkdtempSync(path.join(os.tmpdir(), "evejs-living-universe-v2-"));
const dataDirectory = path.join(temporaryRoot, "data");

fs.mkdirSync(dataDirectory, { recursive: true });
process.env.EVEJS_GAMESTORE_DATA_DIR = dataDirectory;
process.env.EVEJS_PERSISTENCE_WORKER = "0";

const database = require("../src/gameStore");
const sqliteStore = require("../src/gameStore/sqliteStore");
const stateStore = require(
  "../src/space/npc/ambientTraffic/livingUniverseState",
);

const CLEANUP_HOOKS_SYMBOL = Symbol.for("evejs.testStore.cleanupHooksInstalled");
const CLEANUP_IN_PROGRESS_SYMBOL = Symbol.for("evejs.testStore.cleanupInProgress");

function buildFixture() {
  const state = stateStore.buildDefaultState();
  state.populationRevision = 17;
  state.populationSize = 5_000;
  state.createdAtMs = 1_700_000_000_000;
  state.updatedAtMs = 1_700_000_001_000;
  state.nextEncounterNumber = 105;
  state.nextConflictAtMs = 1_700_000_100_000;
  state.roamingConflict = {
    schemaVersion: 1,
    groups: {},
    padding: "r".repeat(460_000),
  };
  state.pendingRoamingContacts = [];
  for (let index = 0; index < 5_000; index += 1) {
    const actorID = `LUA-${String(index).padStart(5, "0")}`;
    state.actors[actorID] = {
      actorID,
      flightID: `LUF-${String(index % 2_789).padStart(5, "0")}`,
      role: index % 3 === 0 ? "miner" : "hauler",
      currentSystemID: 30_000_142 + (index % 20),
      state: "virtual",
      pilot: {
        characterID: 2_100_000_000 + index,
        name: `Pilot ${index}`,
      },
      loadout: "a".repeat(1_150),
    };
  }
  for (let index = 0; index < 2_789; index += 1) {
    const flightID = `LUF-${String(index).padStart(5, "0")}`;
    state.flights[flightID] = {
      flightID,
      actorIDs: [],
      family: index % 4 === 0 ? "miner" : "hauler",
      phase: "virtual_transit",
      currentSystemID: 30_000_142 + (index % 20),
      nextTransitionAtMs: state.updatedAtMs + (index * 1_000),
      routeState: "f".repeat(850),
    };
  }
  for (const actor of Object.values(state.actors)) {
    state.flights[actor.flightID].actorIDs.push(actor.actorID);
  }
  for (let index = 0; index < 104; index += 1) {
    const encounterID = `LUC-${String(index).padStart(5, "0")}`;
    state.encounters[encounterID] = {
      encounterID,
      phase: index % 2 === 0 ? "resolved" : "active",
      targetSystemID: 30_000_142 + (index % 20),
      detail: "e".repeat(2_500),
    };
  }
  return state;
}

function closeStore() {
  process[CLEANUP_HOOKS_SYMBOL] = true;
  process[CLEANUP_IN_PROGRESS_SYMBOL] = true;
  try {
    database.flushAllSync();
  } catch (_error) {
    // Assertions report the meaningful failure; cleanup remains best effort.
  }
  database._closeSqliteForTests();
}

function runReloadVerification() {
  const state = stateStore.readState();
  assert.equal(Object.keys(state.actors).length, 5_000);
  assert.equal(Object.keys(state.flights).length, 2_789);
  assert.equal(Object.keys(state.encounters).length, 103);
  assert.equal(state.actors["LUA-00000"].state, "materialized");
  assert.equal(state.flights["LUF-00000"].phase, "docked");
  assert.equal(state.encounters["LUC-00001"].phase, "resolved");
  assert.equal(state.encounters["LUC-00000"], undefined);
  const inspection = stateStore._testing.inspectV2Snapshot();
  assert.equal(inspection.valid, true, inspection.reason);
  closeStore();
  process.stdout.write(JSON.stringify({ ok: true, generation: inspection.manifest.generation }));
}

function runMainVerification() {
  const fixture = buildFixture();
  const persistenceOperations = [];
  const originalEnqueuePersistenceOperation =
    sqliteStore.enqueuePersistenceOperation;
  sqliteStore.enqueuePersistenceOperation = (table, upserts, deletes) => {
    persistenceOperations.push({
      table,
      upserts: upserts.map(([key, json]) => [key, json]),
      deletes: [...deletes],
    });
    return originalEnqueuePersistenceOperation(table, upserts, deletes);
  };
  assert.equal(
    database.write("npcRuntimeState", "/livingUniverse", fixture).success,
    true,
  );
  assert.equal(database.flushTableSync("npcRuntimeState").success, true);

  const sqlitePath = path.join(temporaryRoot, "gamestore.sqlite");
  const legacyBefore = sqliteStore.loadRows("npcRuntimeState")
    .find((row) => row.key === "livingUniverse").json;
  assert.deepEqual(stateStore.readState(), fixture);

  const legacyBytes = Buffer.byteLength(legacyBefore, "utf8");
  const migrationStartedAt = performance.now();
  const migration = stateStore.writeState(fixture, {
    fullRewrite: true,
    metaDirty: true,
    roamingDirty: true,
    reconcileEncounterRows: true,
  });
  const migrationStageMs = performance.now() - migrationStartedAt;
  assert.equal(migration.success, true, migration.errorMsg);
  assert.equal(migration.migration, true);
  assert.equal(stateStore.flushDurably().success, true);
  const migrationOperation = persistenceOperations.at(-1);
  assert.equal(migrationOperation.table, "npcRuntimeState");

  const migrated = stateStore._testing.inspectV2Snapshot();
  assert.equal(migrated.valid, true, migrated.reason);
  assert.deepEqual(migrated.state, fixture);
  const legacyAfterMigration = sqliteStore.loadRows("npcRuntimeState")
    .find((row) => row.key === "livingUniverse").json;
  assert.equal(legacyAfterMigration, legacyBefore);

  const nextState = JSON.parse(JSON.stringify(fixture));
  nextState.updatedAtMs += 1_000;
  nextState.actors["LUA-00000"].state = "materialized";
  nextState.flights["LUF-00000"].phase = "docked";
  nextState.encounters["LUC-00001"].phase = "resolved";
  const partialBefore = database._flushStatsForTests.partial;
  const fullBefore = database._flushStatsForTests.full;
  const deltaStartedAt = performance.now();
  const delta = stateStore.writeState(nextState, {
    dirtyActorIDs: ["LUA-00000"],
    dirtyFlightIDs: ["LUF-00000"],
    dirtyEncounterIDs: ["LUC-00001"],
    removedEncounterIDs: [],
    metaDirty: true,
    roamingDirty: false,
    reconcileEncounterRows: true,
  });
  const deltaStageMs = performance.now() - deltaStartedAt;
  assert.equal(delta.success, true, delta.errorMsg);
  assert.equal(delta.fullRewrite, false);
  assert.equal(delta.stats.collections.actors.upserts, 1);
  assert.equal(delta.stats.collections.flights.upserts, 1);
  assert.equal(delta.stats.collections.encounters.upserts, 1);
  assert.equal(delta.stats.roamingWrites, 0);
  assert.equal(stateStore.flushDurably().success, true);
  const deltaOperation = persistenceOperations.at(-1);
  const deltaKeys = deltaOperation.upserts.map(([key]) => key);
  assert.ok(deltaKeys.includes("livingUniverseStorageV2"));
  assert.ok(deltaKeys.includes("livingUniverseMetaV2"));
  assert.ok(deltaKeys.includes("livingUniverseActorsV2\u001fLUA-00000"));
  assert.ok(deltaKeys.includes("livingUniverseFlightsV2\u001fLUF-00000"));
  assert.ok(deltaKeys.includes("livingUniverseEncountersV2\u001fLUC-00001"));
  assert.ok(!deltaKeys.includes("livingUniverse"));
  const deltaPayloadBytes = Buffer.byteLength(
    JSON.stringify({
      upserts: deltaOperation.upserts,
      deletes: deltaOperation.deletes,
    }),
    "utf8",
  );
  const legacyPayloadBytes = Buffer.byteLength(
    JSON.stringify({
      upserts: [["livingUniverse", legacyBefore]],
      deletes: [],
    }),
    "utf8",
  );
  assert.ok(
    deltaPayloadBytes < legacyPayloadBytes * 0.1,
    `delta payload ${deltaPayloadBytes} was not at least 90% smaller than ${legacyPayloadBytes}`,
  );
  assert.ok(database._flushStatsForTests.partial > partialBefore);
  assert.equal(database._flushStatsForTests.full, fullBefore);

  delete nextState.encounters["LUC-00000"];
  nextState.updatedAtMs += 1_000;
  const deletion = stateStore.writeState(nextState, {
    dirtyActorIDs: [],
    dirtyFlightIDs: [],
    dirtyEncounterIDs: [],
    removedEncounterIDs: [],
    metaDirty: true,
    roamingDirty: false,
    reconcileEncounterRows: true,
  });
  assert.equal(deletion.success, true, deletion.errorMsg);
  assert.equal(deletion.stats.collections.encounters.removals, 1);
  assert.equal(stateStore.flushDurably().success, true);

  const rows = sqliteStore.loadRows("npcRuntimeState");
  const rowKeys = rows.map((row) => row.key);
  assert.ok(rowKeys.includes("livingUniverse"));
  assert.ok(rowKeys.includes("livingUniverseStorageV2"));
  assert.ok(rowKeys.some((key) => key.startsWith("livingUniverseActorsV2\u001f")));
  assert.ok(rowKeys.some((key) => key.startsWith("livingUniverseFlightsV2\u001f")));
  assert.ok(rowKeys.some((key) => key.startsWith("livingUniverseEncountersV2\u001f")));
  assert.equal(
    rows.find((row) => row.key === "livingUniverse").json,
    legacyBefore,
  );

  closeStore();
  const reload = spawnSync(
    process.execPath,
    [__filename, "--reload", temporaryRoot],
    { encoding: "utf8", timeout: 30_000 },
  );
  assert.equal(reload.status, 0, reload.stderr || reload.stdout);
  const reloadResult = JSON.parse(reload.stdout.trim().split(/\r?\n/).pop());
  assert.equal(reloadResult.ok, true);

  const summary = {
    ok: true,
    sqlitePath,
    legacyBytes,
    actorCount: 5_000,
    flightCount: 2_789,
    encounterCountAfterDeletion: 103,
    migrationStageMs: Math.round(migrationStageMs * 1_000) / 1_000,
    deltaStageMs: Math.round(deltaStageMs * 1_000) / 1_000,
    legacyPayloadBytes,
    deltaPayloadBytes,
    payloadReductionPercent: Math.round(
      (1 - (deltaPayloadBytes / legacyPayloadBytes)) * 100_000,
    ) / 1_000,
    deltaWrites: delta.stats.totalWrites,
    deltaRemovals: delta.stats.totalRemovals,
    legacyPreserved: true,
    partialFlushesAdded: database._flushStatsForTests.partial - partialBefore,
    fullFlushesAdded: database._flushStatsForTests.full - fullBefore,
    reloadGeneration: reloadResult.generation,
  };
  sqliteStore.enqueuePersistenceOperation = originalEnqueuePersistenceOperation;
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
  console.log(JSON.stringify(summary, null, 2));
}

if (RELOAD_MODE) {
  runReloadVerification();
} else {
  try {
    runMainVerification();
  } catch (error) {
    closeStore();
    try {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    } catch (_cleanupError) {
      // Preserve the original assertion.
    }
    throw error;
  }
}
