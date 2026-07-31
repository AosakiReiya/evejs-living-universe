"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const npcRuntime = require(path.join(__dirname, "../../space/npc/npcRuntime"));
const {
  getCharacterSkillMap,
  grantCharacterSkillLevels,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  findItemById,
  updateShipItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  getDockedLocationID,
  isDockedSession,
} = require(path.join(__dirname, "../structure/structureLocation"));
const {
  boardDockedPreparedShip,
  stagePresetShipForLocation,
} = require(path.join(__dirname, "../ship/devCommandShipRuntime"));
const familyEstateRuntime = require("./familyEstateRuntime");
const { getFamilyEstateProfile } = require("./familyEstateProfile");
const {
  appendHistory,
  readPrologueRecord,
  updatePrologueRecord,
  writePrologueRecord,
} = require("./familyEstatePrologueState");

const SUNESIS_TYPE_ID = 42685;
const GNOSIS_TYPE_ID = 3756;
const ENCOUNTER_SPAWN_DISTANCE_METERS = 32_000;

const FAMILY_ESTATE_SKILL_FLOOR = Object.freeze([
  { typeID: 3327, level: 4 }, // Spaceship Command
  { typeID: 12099, level: 3 }, // Battlecruisers
  { typeID: 3449, level: 4 }, // Navigation
  { typeID: 3450, level: 4 }, // Afterburner
  { typeID: 3455, level: 3 }, // Warp Drive Operation
  { typeID: 3426, level: 4 }, // CPU Management
  { typeID: 3413, level: 4 }, // Power Grid Management
  { typeID: 3392, level: 4 }, // Mechanics
  { typeID: 3394, level: 4 }, // Hull Upgrades
  { typeID: 3416, level: 4 }, // Shield Operation
  { typeID: 3419, level: 4 }, // Shield Management
  { typeID: 3425, level: 4 }, // Shield Upgrades
  { typeID: 3420, level: 4 }, // Tactical Shield Manipulation
  { typeID: 3418, level: 4 }, // Capacitor Management
  { typeID: 3417, level: 4 }, // Capacitor Systems Operation
  { typeID: 3436, level: 5 }, // Drones
  { typeID: 24241, level: 4 }, // Light Drone Operation
  { typeID: 33699, level: 4 }, // Medium Drone Operation
  { typeID: 3437, level: 4 }, // Drone Avionics
  { typeID: 3442, level: 4 }, // Drone Interfacing
  { typeID: 12305, level: 3 }, // Drone Navigation
  { typeID: 23606, level: 3 }, // Drone Sharpshooting
  { typeID: 23618, level: 3 }, // Drone Durability
  { typeID: 3300, level: 4 }, // Gunnery
  { typeID: 3301, level: 4 }, // Small Hybrid Turret
  { typeID: 3304, level: 4 }, // Medium Hybrid Turret
  { typeID: 3310, level: 3 }, // Rapid Firing
  { typeID: 3311, level: 3 }, // Sharpshooter
  { typeID: 3312, level: 3 }, // Motion Prediction
  { typeID: 3318, level: 4 }, // Weapon Upgrades
  { typeID: 11207, level: 3 }, // Advanced Weapon Upgrades
  { typeID: 3319, level: 4 }, // Missile Launcher Operation
  { typeID: 3324, level: 4 }, // Heavy Missiles
  { typeID: 21071, level: 3 }, // Rapid Launch
  { typeID: 20315, level: 3 }, // Warhead Upgrades
  { typeID: 20314, level: 3 }, // Target Navigation Prediction
  { typeID: 20312, level: 3 }, // Guided Missile Precision
  { typeID: 12441, level: 3 }, // Missile Bombardment
  { typeID: 12442, level: 3 }, // Missile Projection
  { typeID: 3412, level: 3 }, // Astrometrics
  { typeID: 13278, level: 3 }, // Archaeology
  { typeID: 21718, level: 3 }, // Hacking
  { typeID: 25863, level: 3 }, // Salvaging
]);

const SUNESIS_PRESET = Object.freeze({
  commandName: "/estateprologue",
  shipName: "Sunesis",
  modules: Object.freeze([
    { name: "125mm Prototype Gauss Gun", quantity: 3, forceFit: true },
    { name: "Core Probe Launcher I", quantity: 1, forceFit: true },
    { name: "1MN Monopropellant Enduring Afterburner", quantity: 1, forceFit: true },
    { name: "Medium Shield Extender II", quantity: 1, forceFit: true },
    { name: "Medium Shield Booster II", quantity: 1, forceFit: true },
    { name: "Multispectrum Shield Hardener II", quantity: 1, forceFit: true },
    { name: "Damage Control II", quantity: 1, forceFit: true },
    { name: "Drone Damage Amplifier II", quantity: 1, forceFit: true },
    { name: "Magnetic Field Stabilizer II", quantity: 1, forceFit: true },
    { name: "Nanofiber Internal Structure II", quantity: 1, forceFit: true },
  ]),
  cargo: Object.freeze([
    { name: "Antimatter Charge S", quantity: 1_500 },
    { name: "Core Scanner Probe I", quantity: 16 },
  ]),
  droneBay: Object.freeze([
    { name: "Hobgoblin I", quantity: 8 },
  ]),
  preloadCharges: Object.freeze([
    { moduleName: "125mm Prototype Gauss Gun", chargeName: "Antimatter Charge S", fullClip: true },
    { moduleName: "Core Probe Launcher I", chargeName: "Core Scanner Probe I", fullClip: true },
  ]),
});

const GNOSIS_PRESET = Object.freeze({
  commandName: "/estateprologue",
  shipName: "Gnosis",
  modules: Object.freeze([
    { name: "250mm Prototype Gauss Gun", quantity: 5, forceFit: true },
    { name: "Drone Link Augmentor I", quantity: 1, forceFit: true },
    { name: "10MN Y-S8 Compact Afterburner", quantity: 1, forceFit: true },
    { name: "Large Shield Extender II", quantity: 2, forceFit: true },
    { name: "Medium Shield Booster II", quantity: 1, forceFit: true },
    { name: "Multispectrum Shield Hardener II", quantity: 1, forceFit: true },
    { name: "Omnidirectional Tracking Link I", quantity: 1, forceFit: true },
    { name: "Damage Control II", quantity: 1, forceFit: true },
    { name: "Drone Damage Amplifier II", quantity: 2, forceFit: true },
    { name: "Magnetic Field Stabilizer II", quantity: 2, forceFit: true },
    { name: "Nanofiber Internal Structure II", quantity: 1, forceFit: true },
  ]),
  cargo: Object.freeze([
    { name: "Antimatter Charge M", quantity: 4_000 },
    { name: "Heavy Missile Launcher I", quantity: 5 },
    { name: "Scourge Heavy Missile", quantity: 3_000 },
    { name: "Ballistic Control System II", quantity: 2 },
    { name: "Expanded Probe Launcher I", quantity: 1 },
    { name: "Core Scanner Probe I", quantity: 32 },
    { name: "Combat Scanner Probe I", quantity: 16 },
    { name: "Relic Analyzer I", quantity: 1 },
    { name: "Data Analyzer I", quantity: 1 },
    { name: "Salvager I", quantity: 1 },
    { name: "Small Tractor Beam I", quantity: 1 },
    { name: "Mobile Tractor Unit", quantity: 1 },
  ]),
  droneBay: Object.freeze([
    { name: "Hammerhead I", quantity: 10 },
    { name: "Hobgoblin I", quantity: 10 },
  ]),
  preloadCharges: Object.freeze([
    { moduleName: "250mm Prototype Gauss Gun", chargeName: "Antimatter Charge M", fullClip: true },
  ]),
});

const ENCOUNTER_COMPOSITION = Object.freeze([
  Object.freeze({ profileID: "parity_guristas_missile_frigate", amount: 3 }),
  Object.freeze({ profileID: "parity_guristas_missile_destroyer", amount: 1 }),
]);

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function getSessionCharacterID(session) {
  return toPositiveInt(session && (session.characterID || session.charid), 0);
}

function isOwnedRewardItem(item, characterID, typeID) {
  return Boolean(
    item &&
    toPositiveInt(item.ownerID, 0) === toPositiveInt(characterID, 0) &&
    toPositiveInt(item.typeID, 0) === toPositiveInt(typeID, 0)
  );
}

function markRewardShip(shipItem, rewardKey, characterID) {
  if (!shipItem || !shipItem.itemID) {
    return;
  }
  updateShipItem(shipItem.itemID, (next) => ({
    ...next,
    customInfo: JSON.stringify({
      familyEstatePrologueReward: rewardKey,
      familyEstatePrologueCharacterID: characterID,
    }),
  }));
}

function grantPreparedRewardShip(session, record, rewardKey, preset, typeID, locationID, options = {}) {
  const fieldName = rewardKey === "sunesis" ? "sunesisShipID" : "gnosisShipID";
  const existing = findItemById(record[fieldName]);
  if (isOwnedRewardItem(existing, session.characterID, typeID)) {
    return { success: true, unchanged: true, shipItem: existing };
  }
  const stageResult = stagePresetShipForLocation(session, preset, locationID, {
    syncToSession: true,
  });
  if (!stageResult.success || !stageResult.data || !stageResult.data.shipItem) {
    return {
      success: false,
      errorMsg: stageResult.errorMsg || "FAMILY_ESTATE_PROLOGUE_REWARD_FAILED",
    };
  }
  const shipItem = stageResult.data.shipItem;
  markRewardShip(shipItem, rewardKey, session.characterID);
  if (options.board !== false) {
    const boardResult = boardDockedPreparedShip(session, shipItem);
    if (!boardResult.success) {
      return { success: false, errorMsg: boardResult.errorMsg || "FAMILY_ESTATE_PROLOGUE_BOARD_FAILED" };
    }
  }
  return { success: true, unchanged: false, shipItem };
}

function applySkillFloor(characterID) {
  const existingSkillMap = getCharacterSkillMap(characterID, {
    includeExpertSystems: false,
  });
  const requiredRaises = FAMILY_ESTATE_SKILL_FLOOR.filter((entry) => {
    const current = existingSkillMap.get(entry.typeID);
    const currentLevel = Math.max(
      0,
      Math.trunc(Number(current && (current.trainedSkillLevel ?? current.skillLevel)) || 0),
    );
    return currentLevel < entry.level;
  });
  return requiredRaises.length > 0
    ? grantCharacterSkillLevels(characterID, requiredRaises)
    : [];
}

function startPrologue(session, options = {}) {
  const characterID = getSessionCharacterID(session);
  if (!characterID) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROLOGUE_CHARACTER_REQUIRED" };
  }
  if (!isDockedSession(session)) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROLOGUE_START_DOCKED_REQUIRED" };
  }
  const current = readPrologueRecord(characterID);
  if (current.status !== "not_started") {
    return { success: true, unchanged: true, data: current };
  }
  const estateResult = familyEstateRuntime.ensureFamilyEstate({
    nowMs: options.nowMs || Date.now(),
  });
  if (!estateResult.success) {
    return estateResult;
  }
  const locationID = toPositiveInt(getDockedLocationID(session), 0);
  if (!locationID) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROLOGUE_START_DOCKED_REQUIRED" };
  }
  applySkillFloor(characterID);
  const rewardResult = grantPreparedRewardShip(
    session,
    current,
    "sunesis",
    SUNESIS_PRESET,
    SUNESIS_TYPE_ID,
    locationID,
    { board: true },
  );
  if (!rewardResult.success) {
    return rewardResult;
  }
  const nowMs = toPositiveInt(options.nowMs, Date.now());
  const next = {
    ...current,
    status: "active",
    currentMission: 1,
    startedAtMs: nowMs,
    skillFloorApplied: true,
    sunesisShipID: rewardResult.shipItem.itemID,
  };
  appendHistory(next, "prologue-started", "Sunesis and veteran generalist skill floor issued.", nowMs);
  const writeResult = writePrologueRecord(characterID, next);
  return writeResult.success
    ? { success: true, unchanged: false, data: writeResult.data }
    : writeResult;
}

function tagEncounterEntities(spawned, characterID) {
  const ids = [];
  for (const entry of Array.isArray(spawned) ? spawned : []) {
    const entity = entry && entry.entity;
    const entityID = toPositiveInt(entity && entity.itemID, 0);
    if (!entity || !entityID) {
      continue;
    }
    entity.familyEstatePrologue = true;
    entity.familyEstatePrologueCharacterID = characterID;
    entity.familyEstatePrologueEncounterID = `family-estate:${characterID}`;
    ids.push(entityID);
  }
  return ids;
}

function spawnEstateEncounter(session, options = {}) {
  const characterID = getSessionCharacterID(session);
  const profile = getFamilyEstateProfile();
  const structure = familyEstateRuntime.findFamilyEstateStructure({ includeDestroyed: false });
  if (!characterID || !structure) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROLOGUE_ENCOUNTER_ANCHOR_MISSING" };
  }
  const preferredTargetID = toPositiveInt(session && session._space && session._space.shipID, 0);
  const spawnedEntries = [];
  for (const wing of ENCOUNTER_COMPOSITION) {
    const spawnResult = npcRuntime.spawnBatchInSystem(profile.homeSystemID, {
      entityType: "npc",
      runtimeKind: "nativeCombat",
      profileQuery: wing.profileID,
      fallbackProfileID: wing.profileID,
      preferPools: false,
      amount: wing.amount,
      preferredTargetID,
      transient: true,
      broadcast: true,
      spawnDistanceMeters: ENCOUNTER_SPAWN_DISTANCE_METERS,
      spreadMeters: 9_000,
      anchorDescriptor: {
        kind: "coordinates",
        position: structure.position,
        radius: structure.radius,
        name: structure.itemName || "The Family Holding",
      },
      behaviorOverrides: {
        autoAggro: true,
        autoActivateWeapons: true,
        allowPodKill: false,
        leashRangeMeters: 200_000,
      },
    });
    if (!spawnResult.success || !spawnResult.data) {
      for (const entry of spawnedEntries) {
        npcRuntime.despawn(entry.entity.itemID, { reason: "estate-prologue-spawn-rollback" });
      }
      return { success: false, errorMsg: spawnResult.errorMsg || "FAMILY_ESTATE_PROLOGUE_ENCOUNTER_SPAWN_FAILED" };
    }
    spawnedEntries.push(...(spawnResult.data.spawned || []));
  }
  const entityIDs = tagEncounterEntities(spawnedEntries, characterID);
  if (entityIDs.length !== 4) {
    for (const entityID of entityIDs) {
      npcRuntime.despawn(entityID, { reason: "estate-prologue-incomplete-spawn" });
    }
    return { success: false, errorMsg: "FAMILY_ESTATE_PROLOGUE_ENCOUNTER_INCOMPLETE" };
  }
  if (preferredTargetID) {
    for (const entityID of entityIDs) {
      npcRuntime.issueAttackOrder(entityID, preferredTargetID, {
        keepLock: true,
        allowWeapons: true,
        allowPodKill: false,
      });
    }
  }
  const nowMs = toPositiveInt(options.nowMs, Date.now());
  const updateResult = updatePrologueRecord(characterID, (record) => {
    record.currentMission = 2;
    record.enteredEstateAtMs = record.enteredEstateAtMs || nowMs;
    record.encounterSpawnedAtMs = nowMs;
    record.encounterEntityIDs = entityIDs;
    record.destroyedEncounterEntityIDs = [];
    record.estateGridClearedAtMs = null;
    appendHistory(record, "estate-encounter-spawned", `Guristas force: ${entityIDs.join(", ")}.`, nowMs);
    return record;
  });
  return updateResult.success
    ? { success: true, data: { record: updateResult.data, entityIDs } }
    : updateResult;
}

function handleWormholeJump(session, jumpData = {}, options = {}) {
  const characterID = getSessionCharacterID(session);
  const record = readPrologueRecord(characterID);
  const profile = getFamilyEstateProfile();
  const destinationSystemID = toPositiveInt(jumpData.destinationSystemID, 0);
  if (
    record.status !== "active" ||
    record.currentMission !== 1 ||
    destinationSystemID !== profile.homeSystemID
  ) {
    return { success: true, unchanged: true, data: record };
  }
  const nowMs = toPositiveInt(options.nowMs, Date.now());
  const marked = updatePrologueRecord(characterID, (next) => {
    next.currentMission = 2;
    next.enteredEstateAtMs = nowMs;
    appendHistory(next, "estate-entered", "Entered the permanent family conduit.", nowMs);
    return next;
  });
  if (!marked.success) {
    return marked;
  }
  return spawnEstateEncounter(session, { nowMs });
}

function handleCombatEntityDestroyed(scene, entity, options = {}) {
  if (!entity || entity.familyEstatePrologue !== true) {
    return { success: true, unchanged: true };
  }
  const characterID = toPositiveInt(entity.familyEstatePrologueCharacterID, 0);
  const entityID = toPositiveInt(entity.itemID, 0);
  if (!characterID || !entityID) {
    return { success: true, unchanged: true };
  }
  const nowMs = toPositiveInt(options.nowMs, Date.now());
  return updatePrologueRecord(characterID, (record) => {
    if (record.status !== "active" || record.currentMission !== 2) {
      return record;
    }
    if (!record.encounterEntityIDs.includes(entityID)) {
      return record;
    }
    record.destroyedEncounterEntityIDs = [
      ...new Set([...(record.destroyedEncounterEntityIDs || []), entityID]),
    ];
    appendHistory(record, "estate-hostile-destroyed", `Entity ${entityID}.`, nowMs);
    if (
      record.encounterEntityIDs.length > 0 &&
      record.encounterEntityIDs.every((id) => record.destroyedEncounterEntityIDs.includes(id))
    ) {
      record.currentMission = 3;
      record.estateGridClearedAtMs = nowMs;
      appendHistory(record, "estate-grid-cleared", "The Family Holding grid is secure.", nowMs);
    }
    return record;
  });
}

function completePrologue(session, options = {}) {
  const characterID = getSessionCharacterID(session);
  const current = readPrologueRecord(characterID);
  if (current.status === "complete") {
    return { success: true, unchanged: true, data: current };
  }
  if (current.status !== "active" || current.currentMission !== 3) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROLOGUE_NOT_READY" };
  }
  const structure = familyEstateRuntime.findFamilyEstateStructure({ includeDestroyed: false });
  const dockedLocationID = toPositiveInt(getDockedLocationID(session), 0);
  if (!structure || dockedLocationID !== toPositiveInt(structure.structureID, 0)) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROLOGUE_ESTATE_DOCKING_REQUIRED" };
  }
  const rewardResult = grantPreparedRewardShip(
    session,
    current,
    "gnosis",
    GNOSIS_PRESET,
    GNOSIS_TYPE_ID,
    dockedLocationID,
    { board: true },
  );
  if (!rewardResult.success) {
    return rewardResult;
  }
  const nowMs = toPositiveInt(options.nowMs, Date.now());
  const writeResult = updatePrologueRecord(characterID, (record) => {
    record.status = "complete";
    record.currentMission = 3;
    record.completedAtMs = nowMs;
    record.estateClaimedAtMs = nowMs;
    record.gnosisShipID = rewardResult.shipItem.itemID;
    appendHistory(record, "prologue-complete", "The family Gnosis was recovered and boarded.", nowMs);
    return record;
  });
  return writeResult.success
    ? { success: true, unchanged: false, data: writeResult.data }
    : writeResult;
}

function handleSessionDocked(session, dockable, options = {}) {
  const characterID = getSessionCharacterID(session);
  const record = readPrologueRecord(characterID);
  const structure = familyEstateRuntime.findFamilyEstateStructure({ includeDestroyed: false });
  if (
    record.status !== "active" ||
    !structure ||
    toPositiveInt(dockable && dockable.locationID, 0) !== toPositiveInt(structure.structureID, 0)
  ) {
    return { success: true, unchanged: true, data: record };
  }
  const nowMs = toPositiveInt(options.nowMs, Date.now());
  const updateResult = updatePrologueRecord(characterID, (next) => {
    next.estateDockedAtMs = next.estateDockedAtMs || nowMs;
    appendHistory(next, "estate-docked", "Docked in The Family Holding.", nowMs);
    return next;
  });
  if (!updateResult.success || updateResult.data.currentMission !== 3) {
    return updateResult;
  }
  const estateStatus = familyEstateRuntime.getFamilyEstateStatus();
  const sessionCorporationID = toPositiveInt(
    session && (session.corporationID || session.corpid || session.corpID),
    0,
  );
  if (
    estateStatus.claimState.status === "claimed" &&
    estateStatus.claimState.ownerCorporationID === sessionCorporationID
  ) {
    return completePrologue(session, { nowMs });
  }
  return updateResult;
}

function handleEstateClaimed(session, claimResult, options = {}) {
  const characterID = getSessionCharacterID(session);
  const record = readPrologueRecord(characterID);
  if (record.status !== "active" || record.currentMission !== 3) {
    return { success: true, unchanged: true, data: record };
  }
  if (!claimResult || claimResult.success !== true) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROLOGUE_CLAIM_REQUIRED" };
  }
  return completePrologue(session, { nowMs: options.nowMs || Date.now() });
}

function recoverPrologue(session, options = {}) {
  const characterID = getSessionCharacterID(session);
  const record = readPrologueRecord(characterID);
  if (record.status === "not_started") {
    return startPrologue(session, options);
  }
  if (record.status === "complete") {
    return { success: true, unchanged: true, data: record };
  }
  if (record.currentMission === 1) {
    if (!isDockedSession(session)) {
      return { success: false, errorMsg: "FAMILY_ESTATE_PROLOGUE_RECOVERY_DOCKED_REQUIRED" };
    }
    const locationID = toPositiveInt(getDockedLocationID(session), 0);
    const rewardResult = grantPreparedRewardShip(
      session,
      record,
      "sunesis",
      SUNESIS_PRESET,
      SUNESIS_TYPE_ID,
      locationID,
      { board: false },
    );
    if (!rewardResult.success) {
      return rewardResult;
    }
    if (rewardResult.shipItem.itemID !== record.sunesisShipID) {
      return updatePrologueRecord(characterID, (next) => {
        next.sunesisShipID = rewardResult.shipItem.itemID;
        appendHistory(next, "sunesis-recovered", `Replacement ship ${rewardResult.shipItem.itemID}.`);
        return next;
      });
    }
    return { success: true, unchanged: true, data: record };
  }
  if (record.currentMission === 2) {
    const profile = getFamilyEstateProfile();
    const currentSystemID = toPositiveInt(
      session && session._space && session._space.systemID,
      toPositiveInt(session && (session.solarsystemid2 || session.solarsystemid), 0),
    );
    if (currentSystemID !== profile.homeSystemID || !session._space) {
      return { success: false, errorMsg: "FAMILY_ESTATE_PROLOGUE_RECOVERY_ESTATE_SPACE_REQUIRED" };
    }
    for (const entityID of record.encounterEntityIDs || []) {
      npcRuntime.despawn(entityID, { reason: "estate-prologue-recovery" });
    }
    return spawnEstateEncounter(session, { nowMs: options.nowMs || Date.now() });
  }
  if (record.currentMission === 3) {
    const structure = familyEstateRuntime.findFamilyEstateStructure({ includeDestroyed: false });
    if (
      structure &&
      toPositiveInt(getDockedLocationID(session), 0) === toPositiveInt(structure.structureID, 0)
    ) {
      const estateStatus = familyEstateRuntime.getFamilyEstateStatus();
      const corporationID = toPositiveInt(session && (session.corporationID || session.corpid || session.corpID), 0);
      if (
        estateStatus.claimState.status === "claimed" &&
        estateStatus.claimState.ownerCorporationID === corporationID
      ) {
        return completePrologue(session, options);
      }
    }
    return { success: true, unchanged: true, data: record };
  }
  return { success: false, errorMsg: "FAMILY_ESTATE_PROLOGUE_STATE_INVALID" };
}

function getPrologueStatus(characterID) {
  return readPrologueRecord(characterID);
}

function describePrologue(record) {
  if (!record || record.status === "not_started") {
    return [
      "Family Estate Prologue: not started",
      "Dock at any station and use /estateprologue start.",
      "Reward path: fitted Sunesis -> estate combat -> fitted generalist Gnosis.",
    ].join("\n");
  }
  if (record.status === "complete") {
    return [
      "Family Estate Prologue: complete",
      `Sunesis ${record.sunesisShipID || "-"} | Gnosis ${record.gnosisShipID || "-"}`,
      "The Family Holding is your corporation's shared foothold in J164417.",
    ].join("\n");
  }
  if (record.currentMission === 1) {
    return [
      "Mission 1/3 - A Letter From Home",
      `Fitted Sunesis: ${record.sunesisShipID || "pending"}`,
      "Travel to Uitra and enter the permanent conduit to J164417.",
    ].join("\n");
  }
  if (record.currentMission === 2) {
    return [
      "Mission 2/3 - Squatters at the Gate",
      `Guristas destroyed: ${record.destroyedEncounterEntityIDs.length}/${record.encounterEntityIDs.length || 4}`,
      "Warp to The Family Holding, destroy the Guristas force, then dock.",
      "If the encounter was lost after a restart, use /estateprologue recover while in estate space.",
    ].join("\n");
  }
  return [
    "Mission 3/3 - The Family Holding",
    record.estateDockedAtMs ? "Docking objective complete." : "Dock in The Family Holding.",
    "The CEO or a director of your capsuleer corporation must use /estate claim.",
    "If your corporation already owns the estate, docking completes the chain automatically.",
  ].join("\n");
}

function logHookFailure(hookName, error) {
  log.warn(`[FamilyEstatePrologue] ${hookName} failed: ${error.message}`);
}

module.exports = {
  ENCOUNTER_COMPOSITION,
  FAMILY_ESTATE_SKILL_FLOOR,
  GNOSIS_PRESET,
  SUNESIS_PRESET,
  applySkillFloor,
  completePrologue,
  describePrologue,
  getPrologueStatus,
  handleCombatEntityDestroyed,
  handleEstateClaimed,
  handleSessionDocked,
  handleWormholeJump,
  logHookFailure,
  recoverPrologue,
  spawnEstateEncounter,
  startPrologue,
  _testing: {
    isOwnedRewardItem,
    tagEncounterEntities,
  },
};
