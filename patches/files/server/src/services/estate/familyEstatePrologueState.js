"use strict";

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));

const FAMILY_ESTATE_PROLOGUE_TABLE = "familyEstatePrologueState";
const FAMILY_ESTATE_PROLOGUE_VERSION = 1;
const FAMILY_ESTATE_PROLOGUE_HISTORY_LIMIT = 100;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toPositiveInt(value, fallback = null) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeTimestamp(value, fallback = null) {
  return toPositiveInt(value, fallback);
}

function normalizeEntityIDs(value = []) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((entry) => toPositiveInt(entry, null))
    .filter(Boolean))];
}

function normalizeHistory(value = []) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => ({
      atMs: normalizeTimestamp(entry && entry.atMs, Date.now()),
      action: String(entry && entry.action || "unknown").trim().slice(0, 80),
      detail: String(entry && entry.detail || "").trim().slice(0, 240) || null,
    }))
    .slice(-FAMILY_ESTATE_PROLOGUE_HISTORY_LIMIT);
}

function normalizePrologueRecord(value = {}, characterID = null) {
  const numericCharacterID = toPositiveInt(characterID ?? value.characterID, null);
  const rawStatus = String(value.status || "not_started").trim().toLowerCase();
  const status = ["not_started", "active", "complete"].includes(rawStatus)
    ? rawStatus
    : "not_started";
  const currentMission = status === "complete"
    ? 3
    : Math.max(0, Math.min(3, Math.trunc(Number(value.currentMission) || 0)));
  const encounterEntityIDs = normalizeEntityIDs(value.encounterEntityIDs);
  const destroyedEncounterEntityIDs = normalizeEntityIDs(value.destroyedEncounterEntityIDs)
    .filter((entityID) => encounterEntityIDs.includes(entityID));
  return {
    version: FAMILY_ESTATE_PROLOGUE_VERSION,
    characterID: numericCharacterID,
    status,
    currentMission,
    startedAtMs: normalizeTimestamp(value.startedAtMs, null),
    completedAtMs: status === "complete" ? normalizeTimestamp(value.completedAtMs, Date.now()) : null,
    updatedAtMs: normalizeTimestamp(value.updatedAtMs, Date.now()),
    skillFloorApplied: value.skillFloorApplied === true,
    sunesisShipID: toPositiveInt(value.sunesisShipID, null),
    gnosisShipID: toPositiveInt(value.gnosisShipID, null),
    enteredEstateAtMs: normalizeTimestamp(value.enteredEstateAtMs, null),
    encounterSpawnedAtMs: normalizeTimestamp(value.encounterSpawnedAtMs, null),
    encounterEntityIDs,
    destroyedEncounterEntityIDs,
    estateGridClearedAtMs: normalizeTimestamp(value.estateGridClearedAtMs, null),
    estateDockedAtMs: normalizeTimestamp(value.estateDockedAtMs, null),
    estateClaimedAtMs: normalizeTimestamp(value.estateClaimedAtMs, null),
    history: normalizeHistory(value.history),
  };
}

function readTable() {
  database.ensureTable(FAMILY_ESTATE_PROLOGUE_TABLE);
  const result = database.read(FAMILY_ESTATE_PROLOGUE_TABLE, "/");
  return result.success && result.data && typeof result.data === "object"
    ? result.data
    : {};
}

function readPrologueRecord(characterID) {
  const numericCharacterID = toPositiveInt(characterID, null);
  const table = readTable();
  return normalizePrologueRecord(
    numericCharacterID ? table[String(numericCharacterID)] : {},
    numericCharacterID,
  );
}

function writePrologueRecord(characterID, value) {
  const numericCharacterID = toPositiveInt(characterID, null);
  if (!numericCharacterID) {
    return { success: false, errorMsg: "FAMILY_ESTATE_PROLOGUE_CHARACTER_REQUIRED" };
  }
  const normalized = normalizePrologueRecord(value, numericCharacterID);
  normalized.updatedAtMs = Date.now();
  database.ensureTable(FAMILY_ESTATE_PROLOGUE_TABLE);
  const result = database.write(
    FAMILY_ESTATE_PROLOGUE_TABLE,
    `/${String(numericCharacterID)}`,
    normalized,
  );
  return result && result.success
    ? { success: true, data: cloneValue(normalized) }
    : { success: false, errorMsg: result && result.errorMsg || "FAMILY_ESTATE_PROLOGUE_WRITE_FAILED" };
}

function updatePrologueRecord(characterID, updater) {
  const current = readPrologueRecord(characterID);
  const next = typeof updater === "function"
    ? updater(cloneValue(current)) || current
    : current;
  return writePrologueRecord(characterID, next);
}

function appendHistory(record, action, detail = null, atMs = Date.now()) {
  record.history = normalizeHistory([
    ...(record.history || []),
    { atMs, action, detail },
  ]);
  return record;
}

module.exports = {
  FAMILY_ESTATE_PROLOGUE_TABLE,
  FAMILY_ESTATE_PROLOGUE_VERSION,
  appendHistory,
  cloneValue,
  normalizePrologueRecord,
  readPrologueRecord,
  updatePrologueRecord,
  writePrologueRecord,
};
