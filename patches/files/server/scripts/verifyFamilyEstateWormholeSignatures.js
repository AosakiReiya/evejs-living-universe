"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const temporaryDataDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "evejs-estate-wormhole-signatures-"),
);
const sourceSqlitePath =
  process.env.EVEJS_TEST_SOURCE_GAMESTORE_SQLITE ||
  path.resolve(__dirname, "../../_local/gameStore/gamestore.sqlite");
const sourceDataDirectory = path.join(path.dirname(sourceSqlitePath), "data");

if (!fs.existsSync(sourceSqlitePath)) {
  throw new Error(
    `Family estate wormhole signature verification requires a seeded gameStore: ${sourceSqlitePath}`,
  );
}

fs.copyFileSync(
  sourceSqlitePath,
  path.join(temporaryDataDirectory, "gamestore.sqlite"),
);
for (const tableName of ["explorationAuthority"]) {
  const source = path.join(sourceDataDirectory, tableName);
  if (fs.existsSync(source)) {
    fs.cpSync(source, path.join(temporaryDataDirectory, "data", tableName), {
      recursive: true,
    });
  }
}

process.env.EVEJS_GAMESTORE_DATA_DIR = path.join(
  temporaryDataDirectory,
  "data",
);
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_LIVE_EVENTS_ENABLED = "false";
process.env.EVEJS_AI_NARRATIVE_ENABLED = "false";

const database = require("../src/gameStore");
const wormholeRuntimeState = require(
  "../src/services/exploration/wormholes/wormholeRuntimeState",
);
const wormholeSignatureProvider = require(
  "../src/services/exploration/signatures/providers/wormholeSignatureProvider",
);

const NOW_MS = 1_800_000_000_000;
const SOURCE_SYSTEM_ID = 30_000_142;
const ESTATE_SYSTEM_ID = 31_000_002;
const EXPIRED_DESTINATION_SYSTEM_ID = 30_045_339;
const FUTURE_DESTINATION_SYSTEM_ID = 30_045_340;
const COLLAPSED_DESTINATION_SYSTEM_ID = 30_045_341;

function buildEndpoint(endpointID, systemID, code, position) {
  return {
    endpointID,
    systemID,
    typeID: 30_831,
    code,
    discovered: true,
    visibilityState: "visible",
    position,
    direction: { x: 1, y: 0, z: 0 },
  };
}

function buildPair(options) {
  return {
    pairID: options.pairID,
    kind: options.kind,
    managedSlotKey: options.managedSlotKey || null,
    estateConnectionRole: options.estateConnectionRole || null,
    persistent: options.persistent === true,
    unlimitedMass: options.persistent === true,
    unrestrictedShipMass: options.persistent === true,
    state: options.state || "active",
    createdAtMs: NOW_MS - 60_000,
    expiresAtMs: options.expiresAtMs,
    totalMass: 1_000_000_000,
    remainingMass: 1_000_000_000,
    source: buildEndpoint(
      options.sourceEndpointID,
      SOURCE_SYSTEM_ID,
      options.sourceCode,
      options.sourcePosition,
    ),
    destination: buildEndpoint(
      options.destinationEndpointID,
      options.destinationSystemID,
      "K162",
      options.destinationPosition,
    ),
  };
}

try {
  const permanentPair = buildPair({
    pairID: 9_200_001,
    kind: "estate",
    managedSlotKey: "family-estate:highsec",
    estateConnectionRole: "highsec",
    persistent: true,
    expiresAtMs: 0,
    sourceEndpointID: 9_210_001,
    destinationEndpointID: 9_210_002,
    destinationSystemID: ESTATE_SYSTEM_ID,
    sourceCode: "H296",
    sourcePosition: { x: 10_000, y: 20_000, z: 30_000 },
    destinationPosition: { x: -10_000, y: -20_000, z: -30_000 },
  });
  const expiredPair = buildPair({
    pairID: 9_200_002,
    kind: "random",
    persistent: false,
    expiresAtMs: NOW_MS - 1,
    sourceEndpointID: 9_210_003,
    destinationEndpointID: 9_210_004,
    destinationSystemID: EXPIRED_DESTINATION_SYSTEM_ID,
    sourceCode: "B274",
    sourcePosition: { x: 40_000, y: 50_000, z: 60_000 },
    destinationPosition: { x: -40_000, y: -50_000, z: -60_000 },
  });
  const futurePair = buildPair({
    pairID: 9_200_003,
    kind: "random",
    persistent: false,
    expiresAtMs: NOW_MS + 60_000,
    sourceEndpointID: 9_210_005,
    destinationEndpointID: 9_210_006,
    destinationSystemID: FUTURE_DESTINATION_SYSTEM_ID,
    sourceCode: "D382",
    sourcePosition: { x: 70_000, y: 80_000, z: 90_000 },
    destinationPosition: { x: -70_000, y: -80_000, z: -90_000 },
  });
  const collapsedPersistentPair = buildPair({
    pairID: 9_200_004,
    kind: "estate",
    persistent: true,
    state: "collapsed",
    expiresAtMs: 0,
    sourceEndpointID: 9_210_007,
    destinationEndpointID: 9_210_008,
    destinationSystemID: COLLAPSED_DESTINATION_SYSTEM_ID,
    sourceCode: "H296",
    sourcePosition: { x: 100_000, y: 110_000, z: 120_000 },
    destinationPosition: { x: -100_000, y: -110_000, z: -120_000 },
  });

  assert.equal(
    wormholeRuntimeState.writeState({
      version: wormholeRuntimeState.WORMHOLE_RUNTIME_VERSION,
      nextPairSequence: 9_200_005,
      nextEndpointSequence: 9_210_009,
      universeSeededAtMs: NOW_MS,
      pairsByID: {
        [permanentPair.pairID]: permanentPair,
        [expiredPair.pairID]: expiredPair,
        [futurePair.pairID]: futurePair,
        [collapsedPersistentPair.pairID]: collapsedPersistentPair,
      },
      staticSlotsByKey: {},
      polarizationByCharacter: {},
    }),
    true,
    "The isolated wormhole state fixture must persist",
  );
  wormholeRuntimeState.clearRuntimeCache();

  const sourceCandidates =
    wormholeSignatureProvider.listWormholeSignatureCandidates(
      SOURCE_SYSTEM_ID,
      { nowMs: NOW_MS },
    );
  assert.deepEqual(
    sourceCandidates.map((candidate) => candidate.pairID).sort((a, b) => a - b),
    [permanentPair.pairID, futurePair.pairID],
    "The source system must expose the permanent estate pair and live ordinary pair only",
  );

  const estateCandidates =
    wormholeSignatureProvider.listWormholeSignatureCandidates(
      ESTATE_SYSTEM_ID,
      { nowMs: NOW_MS },
    );
  assert.equal(estateCandidates.length, 1);
  assert.equal(estateCandidates[0].pairID, permanentPair.pairID);
  assert.equal(estateCandidates[0].endpointID, 9_210_002);
  assert.equal(estateCandidates[0].pairKind, "estate");

  assert.deepEqual(
    wormholeSignatureProvider.listWormholeSignatureCandidates(
      EXPIRED_DESTINATION_SYSTEM_ID,
      { nowMs: NOW_MS },
    ),
    [],
    "An expired nonpersistent pair must remain hidden",
  );
  assert.deepEqual(
    wormholeSignatureProvider.listWormholeSignatureCandidates(
      COLLAPSED_DESTINATION_SYSTEM_ID,
      { nowMs: NOW_MS },
    ),
    [],
    "A collapsed persistent pair must remain hidden",
  );

  const sourceEstateSite =
    wormholeSignatureProvider.listSignatureSites(
      SOURCE_SYSTEM_ID,
      { nowMs: NOW_MS },
    ).find((site) => site.pairID === permanentPair.pairID);
  const destinationEstateSite =
    wormholeSignatureProvider.listSignatureSites(
      ESTATE_SYSTEM_ID,
      { nowMs: NOW_MS },
    ).find((site) => site.pairID === permanentPair.pairID);

  assert.ok(sourceEstateSite, "The permanent source endpoint must become a signature site");
  assert.ok(destinationEstateSite, "The permanent destination endpoint must become a signature site");
  assert.equal(sourceEstateSite.targetID.length, 7);
  assert.equal(destinationEstateSite.targetID.length, 7);
  assert.equal(sourceEstateSite.wormholeCode, "H296");
  assert.equal(destinationEstateSite.wormholeCode, "K162");

  database.flushAllSync();
  console.log(
    "Family estate wormhole signature verification passed: " +
    "both permanent endpoints visible; expired and collapsed controls hidden.",
  );
} finally {
  database.flushAllSync();
  database._shutdownPersistenceWorkerForTests();
  database._closeSqliteForTests();
  fs.rmSync(temporaryDataDirectory, { recursive: true, force: true });
}
