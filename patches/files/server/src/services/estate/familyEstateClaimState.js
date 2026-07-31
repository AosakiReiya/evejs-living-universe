"use strict";

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));

const FAMILY_ESTATE_CLAIM_TABLE = "familyEstateClaimState";
const FAMILY_ESTATE_CLAIM_VERSION = 1;
const FAMILY_ESTATE_HISTORY_LIMIT = 250;

const ESTATE_CAPABILITIES = Object.freeze({
  shelter: Object.freeze({ label: "Shelter systems", dependencies: [] }),
  reprocessing: Object.freeze({ label: "Ore reprocessing", dependencies: ["shelter"] }),
  market: Object.freeze({ label: "Estate market", dependencies: ["shelter"] }),
  clone_bay: Object.freeze({ label: "Clone services", dependencies: ["shelter"] }),
  industry: Object.freeze({ label: "Manufacturing and research", dependencies: ["reprocessing"] }),
  reactions: Object.freeze({ label: "Reaction plant", dependencies: ["industry"] }),
  moon_extraction: Object.freeze({ label: "Moon extraction", dependencies: ["reprocessing"] }),
});

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toPositiveInt(value, fallback = null) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeTimestamp(value, fallback = null) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function buildDefaultCapabilities(source = {}) {
  return Object.fromEntries(Object.keys(ESTATE_CAPABILITIES).map((key) => [
    key,
    key === "shelter" ? source[key] !== false : source[key] === true,
  ]));
}

function normalizeExplicitRoles(value = {}) {
  const roles = {};
  for (const [characterID, role] of Object.entries(value || {})) {
    const numericCharacterID = toPositiveInt(characterID, null);
    const normalizedRole = String(role || "").trim().toLowerCase();
    if (numericCharacterID && (normalizedRole === "founder" || normalizedRole === "steward")) {
      roles[String(numericCharacterID)] = normalizedRole;
    }
  }
  return roles;
}

function normalizeHistory(value = []) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => ({
      atMs: normalizeTimestamp(entry && entry.atMs, Date.now()),
      action: String(entry && entry.action || "unknown").trim().slice(0, 80),
      actorCharacterID: toPositiveInt(entry && entry.actorCharacterID, null),
      corporationID: toPositiveInt(entry && entry.corporationID, null),
      targetCharacterID: toPositiveInt(entry && entry.targetCharacterID, null),
      capability: String(entry && entry.capability || "").trim().toLowerCase() || null,
      reason: String(entry && entry.reason || "").trim().slice(0, 240) || null,
    }))
    .slice(-FAMILY_ESTATE_HISTORY_LIMIT);
}

function normalizeFamilyEstateClaimState(value = {}, context = {}) {
  const ownerCorporationID = toPositiveInt(value.ownerCorporationID, null);
  const claimantCharacterID = toPositiveInt(value.claimantCharacterID, null);
  const status = ownerCorporationID && claimantCharacterID ? "claimed" : "unclaimed";
  const explicitRolesByCharacterID = normalizeExplicitRoles(value.explicitRolesByCharacterID);
  if (claimantCharacterID) {
    explicitRolesByCharacterID[String(claimantCharacterID)] = "founder";
  }
  return {
    version: FAMILY_ESTATE_CLAIM_VERSION,
    status,
    structureID: toPositiveInt(value.structureID, toPositiveInt(context.structureID, null)),
    holdingCorporationID: toPositiveInt(
      value.holdingCorporationID,
      toPositiveInt(context.holdingCorporationID, null),
    ),
    ownerCorporationID,
    claimantCharacterID,
    claimedAtMs: status === "claimed" ? normalizeTimestamp(value.claimedAtMs, Date.now()) : null,
    progressStage: String(value.progressStage || (status === "claimed" ? "claimed" : "damaged"))
      .trim().toLowerCase().slice(0, 80) || "damaged",
    explicitRolesByCharacterID,
    capabilities: buildDefaultCapabilities(value.capabilities),
    history: normalizeHistory(value.history),
    updatedAtMs: normalizeTimestamp(value.updatedAtMs, Date.now()),
  };
}

function readRawFamilyEstateClaimState() {
  database.ensureTable(FAMILY_ESTATE_CLAIM_TABLE);
  const result = database.read(FAMILY_ESTATE_CLAIM_TABLE, "/");
  if (result && result.success === true) {
    if (result.data && typeof result.data === "object" && !Array.isArray(result.data)) {
      return { raw: result.data, missing: false };
    }
    const error = new Error("FAMILY_ESTATE_CLAIM_STATE_INVALID");
    error.code = "FAMILY_ESTATE_CLAIM_STATE_INVALID";
    throw error;
  }
  if (result && ["ENTRY_NOT_FOUND", "TABLE_NOT_FOUND"].includes(result.errorMsg)) {
    return { raw: {}, missing: true };
  }
  const error = new Error(
    result && result.errorMsg || "FAMILY_ESTATE_CLAIM_READ_FAILED",
  );
  error.code = "FAMILY_ESTATE_CLAIM_READ_FAILED";
  error.storeError = result && result.errorMsg || "UNKNOWN";
  throw error;
}

function readFamilyEstateClaimState(context = {}) {
  const { raw } = readRawFamilyEstateClaimState();
  return normalizeFamilyEstateClaimState(raw, context);
}

function ensureFamilyEstateClaimState(context = {}) {
  const { raw, missing } = readRawFamilyEstateClaimState();
  const normalized = normalizeFamilyEstateClaimState(raw, context);
  if (
    !missing &&
    Number(raw.version) === FAMILY_ESTATE_CLAIM_VERSION &&
    toPositiveInt(raw.structureID, null) === normalized.structureID &&
    raw.capabilities && typeof raw.capabilities === "object" &&
    raw.explicitRolesByCharacterID && typeof raw.explicitRolesByCharacterID === "object"
  ) {
    return normalized;
  }
  const writeResult = writeFamilyEstateClaimState(normalized, context);
  if (!writeResult.success) {
    const error = new Error(writeResult.errorMsg || "FAMILY_ESTATE_CLAIM_WRITE_FAILED");
    error.code = writeResult.errorMsg || "FAMILY_ESTATE_CLAIM_WRITE_FAILED";
    throw error;
  }
  return writeResult.data;
}

function writeFamilyEstateClaimState(value, context = {}) {
  const normalized = normalizeFamilyEstateClaimState(value, context);
  normalized.updatedAtMs = Date.now();
  database.ensureTable(FAMILY_ESTATE_CLAIM_TABLE);
  const result = database.write(FAMILY_ESTATE_CLAIM_TABLE, "/", normalized);
  return result && result.success
    ? { success: true, data: cloneValue(normalized) }
    : { success: false, errorMsg: result && result.errorMsg || "FAMILY_ESTATE_CLAIM_WRITE_FAILED" };
}

function updateFamilyEstateClaimState(updater, context = {}) {
  const current = readFamilyEstateClaimState(context);
  const next = typeof updater === "function"
    ? updater(cloneValue(current)) || current
    : current;
  return writeFamilyEstateClaimState(next, context);
}

function appendHistory(state, entry = {}) {
  state.history = normalizeHistory([...(state.history || []), entry]);
  return state;
}

module.exports = {
  ESTATE_CAPABILITIES,
  FAMILY_ESTATE_CLAIM_TABLE,
  FAMILY_ESTATE_CLAIM_VERSION,
  appendHistory,
  cloneValue,
  ensureFamilyEstateClaimState,
  normalizeFamilyEstateClaimState,
  readFamilyEstateClaimState,
  updateFamilyEstateClaimState,
  writeFamilyEstateClaimState,
};
