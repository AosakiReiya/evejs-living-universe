"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const temporaryDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-estate-projects-"));
const sourceSqlitePath = process.env.EVEJS_TEST_SOURCE_GAMESTORE_SQLITE || path.resolve(
  __dirname,
  "../../_local/gameStore/gamestore.sqlite",
);
const sourceDataDirectory = path.join(path.dirname(sourceSqlitePath), "data");
if (!fs.existsSync(sourceSqlitePath)) {
  throw new Error(`Family estate project verification requires a seeded gameStore: ${sourceSqlitePath}`);
}
fs.copyFileSync(sourceSqlitePath, path.join(temporaryDataDirectory, "gamestore.sqlite"));
for (const tableName of [
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
]) {
  const source = path.join(sourceDataDirectory, tableName);
  if (fs.existsSync(source)) {
    fs.cpSync(source, path.join(temporaryDataDirectory, "data", tableName), { recursive: true });
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
  PLAYER_CORPORATION_ID,
} = require("../src/services/corporation/coreFixtureSeeder");
const {
  setCorporationWalletDivisionBalance,
  getCorporationWalletBalance,
} = require("../src/services/corporation/corpWalletState");
const {
  ITEM_FLAGS,
  grantItemsToOwnerLocation,
  listContainerItems,
} = require("../src/services/inventory/itemStore");
const familyEstateRuntime = require("../src/services/estate/familyEstateRuntime");
const projectState = require("../src/services/estate/familyEstateProjectState");
const projectsRuntime = require("../src/services/estate/familyEstateProjectsRuntime");

try {
  ensureCoreFixtures();
  const ensured = familyEstateRuntime.ensureFamilyEstate({ emitLive: false });
  assert.equal(ensured.success, true, ensured.errorMsg);
  const structureID = ensured.data.structure.structureID;
  database.write("familyEstateClaimState", "/", {});
  database.write(projectState.TABLE_NAME, "/", {});
  const nowMs = Date.now();
  const session = {
    characterID: PLAYER_CEO_CHARACTER_ID,
    corporationID: PLAYER_CORPORATION_ID,
    structureID,
  };
  const claim = familyEstateRuntime.claimFamilyEstate(session, {
    emitLive: false,
    nowMs,
    bypassAuthority: true,
  });
  assert.equal(claim.success, true, claim.errorMsg);

  const requirements = new Map();
  for (const definition of Object.values(projectState.PROJECT_DEFINITIONS)) {
    for (const material of definition.materials) {
      requirements.set(
        material.typeID,
        {
          ...material,
          quantity: (requirements.get(material.typeID) && requirements.get(material.typeID).quantity || 0) +
            material.quantity,
        },
      );
    }
  }
  const grant = grantItemsToOwnerLocation(
    PLAYER_CEO_CHARACTER_ID,
    structureID,
    ITEM_FLAGS.HANGAR,
    [...requirements.values()].map((material) => ({
      itemType: material,
      quantity: material.quantity,
    })),
  );
  assert.equal(grant.success, true, grant.errorMsg);
  setCorporationWalletDivisionBalance(PLAYER_CORPORATION_ID, 1000, 30_000_000, {
    description: "Estate project verification seed",
  });

  const stabilizationContribution = projectsRuntime.contributeToProject(
    session,
    "stabilization",
    { nowMs: nowMs + 1 },
  );
  assert.equal(stabilizationContribution.success, true, stabilizationContribution.errorMsg);
  const stabilizationStart = projectsRuntime.startProject(session, "stabilization", {
    nowMs: nowMs + 2,
  });
  assert.equal(stabilizationStart.success, true, stabilizationStart.errorMsg);
  assert.equal(stabilizationStart.data.project.status, "in_progress");
  assert.equal(
    getCorporationWalletBalance(PLAYER_CORPORATION_ID, 1000),
    25_000_000,
  );
  const stabilizationComplete = projectsRuntime.forceCompleteProject("stabilization", {
    nowMs: nowMs + 3,
  });
  assert.equal(stabilizationComplete.success, true, stabilizationComplete.errorMsg);
  const repaired = familyEstateRuntime.findFamilyEstateStructure({ includeDestroyed: true });
  assert.equal(repaired.conditionState.damage, 0);
  assert.equal(repaired.conditionState.armorDamage, 0);
  assert.equal(repaired.conditionState.shieldCharge, 1);

  const reprocessingContribution = projectsRuntime.contributeToProject(
    session,
    "reprocessing",
    { nowMs: nowMs + 4 },
  );
  assert.equal(reprocessingContribution.success, true, reprocessingContribution.errorMsg);
  const reprocessingStart = projectsRuntime.startProject(session, "reprocessing", {
    nowMs: nowMs + 5,
  });
  assert.equal(reprocessingStart.success, true, reprocessingStart.errorMsg);
  assert.equal(
    getCorporationWalletBalance(PLAYER_CORPORATION_ID, 1000),
    15_000_000,
  );
  const reprocessingComplete = projectsRuntime.forceCompleteProject("reprocessing", {
    nowMs: nowMs + 6,
  });
  assert.equal(reprocessingComplete.success, true, reprocessingComplete.errorMsg);
  const claimState = familyEstateRuntime.getFamilyEstateClaimState();
  assert.equal(claimState.capabilities.reprocessing, true);
  assert.ok(
    listContainerItems(null, structureID, null).some((item) => item.typeID === 35899),
    "Restored reprocessing service module was not fitted",
  );

  projectState.updateState((state) => {
    state.commercial.lastSettledAtMs = nowMs;
    return state;
  }, nowMs + 7);
  const beforeIncome = getCorporationWalletBalance(PLAYER_CORPORATION_ID, 1000);
  const gated = projectsRuntime.reconcileEstateProjects(
    nowMs + 2 * projectsRuntime.SETTLEMENT_INTERVAL_MS,
  );
  assert.equal(
    getCorporationWalletBalance(PLAYER_CORPORATION_ID, 1000),
    beforeIncome,
    "X-Eve-enabled play must suppress prototype synthetic estate income",
  );
  assert.equal(gated.commercial.settlements, 0);
  const settled = projectsRuntime.reconcileEstateProjects(
    nowMs + 2 * projectsRuntime.SETTLEMENT_INTERVAL_MS,
    { allowSyntheticIncome: true },
  );
  const afterIncome = getCorporationWalletBalance(PLAYER_CORPORATION_ID, 1000);
  assert.ok(afterIncome > beforeIncome, "The estate did not generate commercial net income");
  assert.equal(settled.commercial.settlements, 2);
  projectsRuntime.reconcileEstateProjects(
    nowMs + 2 * projectsRuntime.SETTLEMENT_INTERVAL_MS,
  );
  assert.equal(
    getCorporationWalletBalance(PLAYER_CORPORATION_ID, 1000),
    afterIncome,
    "Repeated reconciliation duplicated estate income",
  );

  database.flushAllSync();
  console.log(
    `Family estate project verification passed: two projects completed, ` +
    `${Math.round(afterIncome - beforeIncome).toLocaleString("en-US")} ISK commercial net income.`,
  );
} finally {
  projectsRuntime.stopFamilyEstateProjectSchedulerForTests();
  database.flushAllSync();
  database._shutdownPersistenceWorkerForTests();
  database._closeSqliteForTests();
  fs.rmSync(temporaryDataDirectory, { recursive: true, force: true });
}
