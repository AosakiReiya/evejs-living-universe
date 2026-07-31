"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const temporaryDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-estate-claim-"));
const sourceSqlitePath = process.env.EVEJS_TEST_SOURCE_GAMESTORE_SQLITE || path.resolve(
  __dirname,
  "../../_local/gameStore/gamestore.sqlite",
);
const sourceDataDirectory = path.join(path.dirname(sourceSqlitePath), "data");
if (!fs.existsSync(sourceSqlitePath)) {
  throw new Error(`Family estate claim verification requires a seeded gameStore: ${sourceSqlitePath}`);
}
fs.copyFileSync(sourceSqlitePath, path.join(temporaryDataDirectory, "gamestore.sqlite"));
const requiredStaticTables = [
  "asteroidBelts",
  "celestials",
  "explorationAuthority",
  "itemTypes",
  "movementAttributes",
  "shipDogmaAttributes",
  "solarSystems",
  "stargates",
  "stargateTypes",
  "stations",
  "stationTypes",
  "typeDogma",
];
for (const tableName of requiredStaticTables) {
  const source = path.join(sourceDataDirectory, tableName);
  if (fs.existsSync(source)) {
    fs.cpSync(source, path.join(temporaryDataDirectory, "data", tableName), {
      recursive: true,
    });
  }
}
process.env.EVEJS_GAMESTORE_DATA_DIR = path.join(temporaryDataDirectory, "data");
process.env.EVEJS_FAMILY_ESTATE_ENABLED = "true";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_LIVE_EVENTS_ENABLED = "false";
process.env.EVEJS_AI_NARRATIVE_ENABLED = "false";

const database = require("../src/gameStore");
const {
  ensureCoreFixtures,
  PLAYER_CEO_CHARACTER_ID,
  PLAYER_MEMBER_CHARACTER_ID,
  PLAYER_CORPORATION_ID,
} = require("../src/services/corporation/coreFixtureSeeder");
const {
  setCharacterAffiliation,
} = require("../src/services/corporation/corporationState");
const familyEstateRuntime = require("../src/services/estate/familyEstateRuntime");
const structureState = require("../src/services/structure/structureState");

try {
  ensureCoreFixtures();
  setCharacterAffiliation(
    PLAYER_MEMBER_CHARACTER_ID,
    PLAYER_CORPORATION_ID,
    null,
  );

  const ensureResult = familyEstateRuntime.ensureFamilyEstate({ emitLive: false });
  assert.equal(ensureResult.success, true, ensureResult.errorMsg);
  const structureID = ensureResult.data.structure.structureID;
  const resetStructureResult = structureState.updateStructureRecord(
    structureID,
    (structure) => {
      structure.ownerCorpID = ensureResult.data.profile.ownerCorporationID;
      structure.ownerID = ensureResult.data.profile.ownerCorporationID;
      structure.accessProfile = { docking: "public", tethering: "public" };
      structure.devFlags = {
        ...(structure.devFlags || {}),
        missionClaimable: true,
        estateState: "damaged",
        estateOwnerCorporationID: null,
        estateClaimantCharacterID: null,
        estateClaimedAtMs: null,
      };
      return structure;
    },
    { emitLive: false },
  );
  assert.equal(resetStructureResult.success, true, resetStructureResult.errorMsg);
  database.write("familyEstateClaimState", "/", {});
  const ceoSession = {
    characterID: PLAYER_CEO_CHARACTER_ID,
    corporationID: PLAYER_CORPORATION_ID,
    structureID,
  };

  const offsiteClaim = familyEstateRuntime.claimFamilyEstate(
    { ...ceoSession, structureID: null },
    { emitLive: false, nowMs: 1_799_999_999_998 },
  );
  assert.equal(offsiteClaim.success, false);
  assert.equal(offsiteClaim.errorMsg, "FAMILY_ESTATE_DOCKING_REQUIRED");

  const nonLeaderClaim = familyEstateRuntime.claimFamilyEstate({
    characterID: PLAYER_MEMBER_CHARACTER_ID,
    corporationID: PLAYER_CORPORATION_ID,
    structureID,
  }, {
    emitLive: false,
    nowMs: 1_799_999_999_999,
  });
  assert.equal(nonLeaderClaim.success, false);
  assert.equal(
    nonLeaderClaim.errorMsg,
    "FAMILY_ESTATE_CORPORATION_LEADERSHIP_REQUIRED",
  );

  const claimResult = familyEstateRuntime.claimFamilyEstate(ceoSession, {
    emitLive: false,
    nowMs: 1_800_000_000_000,
  });
  assert.equal(claimResult.success, true, claimResult.errorMsg);
  assert.equal(claimResult.unchanged, false);
  assert.equal(claimResult.data.structure.ownerCorpID, PLAYER_CORPORATION_ID);
  assert.deepEqual(claimResult.data.structure.accessProfile, {
    docking: "corp",
    tethering: "corp",
  });
  assert.equal(claimResult.data.claimState.status, "claimed");
  assert.equal(claimResult.data.claimState.claimantCharacterID, PLAYER_CEO_CHARACTER_ID);
  assert.equal(
    familyEstateRuntime.resolveFamilyEstateMemberRole(
      PLAYER_CEO_CHARACTER_ID,
      PLAYER_CORPORATION_ID,
      claimResult.data.claimState,
    ),
    "founder",
  );

  const idempotentClaim = familyEstateRuntime.claimFamilyEstate(ceoSession, {
    emitLive: false,
    nowMs: 1_800_000_000_001,
  });
  assert.equal(idempotentClaim.success, true);
  assert.equal(idempotentClaim.unchanged, true);

  const roleResult = familyEstateRuntime.setFamilyEstateMemberRole(
    ceoSession,
    PLAYER_MEMBER_CHARACTER_ID,
    "steward",
    { nowMs: 1_800_000_000_002 },
  );
  assert.equal(roleResult.success, true, roleResult.errorMsg);
  assert.equal(
    familyEstateRuntime.resolveFamilyEstateMemberRole(
      PLAYER_MEMBER_CHARACTER_ID,
      PLAYER_CORPORATION_ID,
      roleResult.data,
    ),
    "steward",
  );

  const reprocessingUnlock = familyEstateRuntime.unlockFamilyEstateCapability("reprocessing", {
    system: true,
    actorCharacterID: PLAYER_CEO_CHARACTER_ID,
    nowMs: 1_800_000_000_003,
  });
  assert.equal(reprocessingUnlock.success, true, reprocessingUnlock.errorMsg);
  assert.equal(reprocessingUnlock.data.capabilities.reprocessing, true);

  const prematureReactionUnlock = familyEstateRuntime.unlockFamilyEstateCapability("reactions", {
    system: true,
    actorCharacterID: PLAYER_CEO_CHARACTER_ID,
    nowMs: 1_800_000_000_004,
  });
  assert.equal(prematureReactionUnlock.success, false);
  assert.equal(
    prematureReactionUnlock.errorMsg,
    "FAMILY_ESTATE_CAPABILITY_DEPENDENCY_REQUIRED",
  );
  assert.equal(prematureReactionUnlock.dependency, "industry");

  const status = familyEstateRuntime.getFamilyEstateStatus();
  assert.equal(status.ownerCorporation.corporationID, PLAYER_CORPORATION_ID);
  assert.equal(status.residents.length, 2);
  assert.equal(status.residents.find(
    (entry) => entry.characterID === PLAYER_MEMBER_CHARACTER_ID,
  ).role, "steward");

  database.flushAllSync();
  console.log(
    `Family estate claim verification passed: structure ${structureID}, ` +
    `${status.residents.length} residents, corporation ${PLAYER_CORPORATION_ID}.`,
  );
} finally {
  database.flushAllSync();
  database._shutdownPersistenceWorkerForTests();
  database._closeSqliteForTests();
  fs.rmSync(temporaryDataDirectory, { recursive: true, force: true });
}
