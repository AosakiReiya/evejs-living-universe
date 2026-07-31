"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const temporaryDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-estate-prologue-"));
const sourceSqlitePath = process.env.EVEJS_TEST_SOURCE_GAMESTORE_SQLITE || path.resolve(
  __dirname,
  "../../_local/gameStore/gamestore.sqlite",
);
const sourceDataDirectory = path.join(path.dirname(sourceSqlitePath), "data");
if (!fs.existsSync(sourceSqlitePath)) {
  throw new Error(`Family estate prologue verification requires a seeded gameStore: ${sourceSqlitePath}`);
}
fs.copyFileSync(sourceSqlitePath, path.join(temporaryDataDirectory, "gamestore.sqlite"));
for (const tableName of [
  "clientEntityStandings",
  "celestials",
  "explorationAuthority",
  "itemTypes",
  "movementAttributes",
  "npcBehaviorProfiles",
  "npcLoadouts",
  "npcProfiles",
  "npcSpawnGroups",
  "npcSpawnPools",
  "solarSystems",
  "stargates",
  "stargateTypes",
  "stations",
  "stationTypes",
  "shipDogmaAttributes",
  "shipTypes",
  "skillTypes",
  "typeDogma",
]) {
  const source = path.join(sourceDataDirectory, tableName);
  if (fs.existsSync(source)) {
    fs.cpSync(source, path.join(temporaryDataDirectory, "data", tableName), {
      recursive: true,
    });
  }
}

process.env.EVEJS_GAMESTORE_DATA_DIR = path.join(temporaryDataDirectory, "data");
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_LIVE_EVENTS_ENABLED = "false";
process.env.EVEJS_AI_NARRATIVE_ENABLED = "false";

const database = require("../src/gameStore");
const { resolveItemByName } = require("../src/services/inventory/itemTypeRegistry");
const {
  buildSkillRecord,
  getCharacterSkillMap,
  getSkillTypeByID,
} = require("../src/services/skills/skillState");
const prologueRuntime = require("../src/services/estate/familyEstatePrologueRuntime");
const npcRuntime = require("../src/space/npc/npcRuntime");
const {
  stagePresetShipForLocation,
} = require("../src/services/ship/devCommandShipRuntime");
const {
  readPrologueRecord,
  writePrologueRecord,
} = require("../src/services/estate/familyEstatePrologueState");

const characterID = 91_000_001;

function listPresetReferences(preset) {
  return [
    ...(preset.modules || []).map((entry) => entry.name),
    ...(preset.cargo || []).map((entry) => entry.name),
    ...(preset.droneBay || []).map((entry) => entry.name),
    ...(preset.preloadCharges || []).flatMap((entry) => [
      entry.moduleName,
      entry.chargeName,
    ]),
  ];
}

try {
  database.write("familyEstatePrologueState", "/", {});
  const initial = readPrologueRecord(characterID);
  assert.equal(initial.status, "not_started");
  assert.equal(initial.currentMission, 0);

  for (const itemName of new Set([
    ...listPresetReferences(prologueRuntime.SUNESIS_PRESET),
    ...listPresetReferences(prologueRuntime.GNOSIS_PRESET),
  ])) {
    const resolution = resolveItemByName(itemName);
    assert.equal(
      resolution.success,
      true,
      `${itemName}: ${resolution.errorMsg || "not resolved"}`,
    );
  }
  for (const skill of prologueRuntime.FAMILY_ESTATE_SKILL_FLOOR) {
    assert.ok(getSkillTypeByID(skill.typeID), `Missing skill ${skill.typeID}`);
    assert.ok(skill.level >= 1 && skill.level <= 5, `Invalid level for ${skill.typeID}`);
  }

  database.write("characters", `/${characterID}`, {
    characterID,
    characterName: "Estate Prologue Verification",
    skillPoints: 0,
  });
  database.write("skills", `/${characterID}`, {
    "3327": buildSkillRecord(characterID, getSkillTypeByID(3327), 5),
  });
  prologueRuntime.applySkillFloor(characterID);
  const appliedSkillMap = getCharacterSkillMap(characterID, {
    includeExpertSystems: false,
  });
  assert.equal(appliedSkillMap.get(3327).trainedSkillLevel, 5, "Skill floor lowered level V");
  assert.equal(appliedSkillMap.get(12099).trainedSkillLevel, 3, "Battlecruisers floor missing");

  const rewardSession = { characterID };
  const sunesisStage = stagePresetShipForLocation(
    rewardSession,
    prologueRuntime.SUNESIS_PRESET,
    60003760,
    { syncToSession: false },
  );
  assert.equal(sunesisStage.success, true, sunesisStage.errorMsg);
  assert.equal(sunesisStage.data.shipItem.typeID, 42685);
  const gnosisStage = stagePresetShipForLocation(
    rewardSession,
    prologueRuntime.GNOSIS_PRESET,
    60003760,
    { syncToSession: false },
  );
  assert.equal(gnosisStage.success, true, gnosisStage.errorMsg);
  assert.equal(gnosisStage.data.shipItem.typeID, 3756);

  const nativeEncounterEntries = [];
  for (const wing of prologueRuntime.ENCOUNTER_COMPOSITION) {
    const spawnResult = npcRuntime.spawnBatchInSystem(31000355, {
      entityType: "npc",
      runtimeKind: "nativeCombat",
      profileQuery: wing.profileID,
      fallbackProfileID: wing.profileID,
      preferPools: false,
      amount: wing.amount,
      transient: true,
      broadcast: false,
      anchorDescriptor: {
        kind: "coordinates",
        position: { x: 0, y: 0, z: 0 },
        name: "Family estate verification anchor",
      },
    });
    assert.equal(spawnResult.success, true, spawnResult.errorMsg);
    nativeEncounterEntries.push(...spawnResult.data.spawned);
  }
  const nativeEncounterEntities = nativeEncounterEntries.map((entry) => entry.entity);
  assert.equal(nativeEncounterEntities.length, 4);
  assert.deepEqual(
    nativeEncounterEntries.map((entry) => entry.controller.profileID),
    [
      "parity_guristas_missile_frigate",
      "parity_guristas_missile_frigate",
      "parity_guristas_missile_frigate",
      "parity_guristas_missile_destroyer",
    ],
  );
  for (const entity of nativeEncounterEntities) {
    npcRuntime.despawn(entity.itemID, { reason: "estate-prologue-verification" });
  }

  const mockEntities = [101, 102, 103, 104].map((itemID) => ({ itemID }));
  const taggedIDs = prologueRuntime._testing.tagEncounterEntities(
    mockEntities.map((entity) => ({ entity })),
    characterID,
  );
  assert.deepEqual(taggedIDs, [101, 102, 103, 104]);

  const seeded = writePrologueRecord(characterID, {
    characterID,
    status: "active",
    currentMission: 2,
    startedAtMs: 1_800_000_000_000,
    enteredEstateAtMs: 1_800_000_000_100,
    encounterSpawnedAtMs: 1_800_000_000_200,
    encounterEntityIDs: taggedIDs,
  });
  assert.equal(seeded.success, true, seeded.errorMsg);

  for (let index = 0; index < mockEntities.length; index += 1) {
    const result = prologueRuntime.handleCombatEntityDestroyed(
      { systemID: 31000355 },
      mockEntities[index],
      { nowMs: 1_800_000_001_000 + index },
    );
    assert.equal(result.success, true, result.errorMsg);
    assert.equal(result.data.destroyedEncounterEntityIDs.length, index + 1);
    assert.equal(result.data.currentMission, index === 3 ? 3 : 2);
  }

  const duplicateKill = prologueRuntime.handleCombatEntityDestroyed(
    { systemID: 31000355 },
    mockEntities[3],
    { nowMs: 1_800_000_002_000 },
  );
  assert.equal(duplicateKill.success, true);
  assert.equal(duplicateKill.data.destroyedEncounterEntityIDs.length, 4);
  assert.equal(duplicateKill.data.currentMission, 3);

  const finalRecord = readPrologueRecord(characterID);
  assert.equal(finalRecord.status, "active");
  assert.equal(finalRecord.currentMission, 3);
  assert.ok(finalRecord.estateGridClearedAtMs > 0);
  assert.match(prologueRuntime.describePrologue(finalRecord), /Mission 3\/3/);

  database.flushAllSync();
  console.log(
    `Family estate prologue verification passed: ` +
    `${prologueRuntime.FAMILY_ESTATE_SKILL_FLOOR.length} skill floors, ` +
    `${taggedIDs.length} encounter ships, state advanced to mission ${finalRecord.currentMission}.`,
  );
} finally {
  database.flushAllSync();
  database._shutdownPersistenceWorkerForTests();
  database._closeSqliteForTests();
  fs.rmSync(temporaryDataDirectory, { recursive: true, force: true });
}
