"use strict";

const path = require("path");
const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));

const TABLE_NAME = "industrialHirelingContracts";
const SCHEMA_VERSION = 2;
const ESCROW_LOCATION_BASE = 8_800_000_000_000_000;

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function buildDefaultMeta(nowMs = Date.now()) {
  const normalizedNowMs = Math.max(0, Math.trunc(Number(nowMs) || 0));
  return {
    schemaVersion: SCHEMA_VERSION,
    nextContractSerial: 1,
    nextManifestSerial: 1,
    createdAtMs: normalizedNowMs,
    updatedAtMs: normalizedNowMs,
  };
}

function createStateStore(options = {}) {
  const repo = options.repo || createTableRepository("service:industrialHirelings", {
    strict: true,
  });

  function readPath(pathArg, fallback = null) {
    const result = repo.read(TABLE_NAME, pathArg);
    if (!result || result.success !== true || result.data == null) {
      return cloneValue(fallback);
    }
    return cloneValue(result.data);
  }

  function writePath(pathArg, value, writeOptions = {}) {
    return repo.write(TABLE_NAME, pathArg, cloneValue(value), writeOptions);
  }

  function ensureInitialized(nowMs = Date.now()) {
    const existing = readPath("/meta", null);
    if (existing && typeof existing === "object") {
      return {
        success: true,
        data: {
          ...buildDefaultMeta(nowMs),
          ...existing,
          schemaVersion: SCHEMA_VERSION,
          nextContractSerial: toPositiveInt(existing.nextContractSerial, 1),
          nextManifestSerial: toPositiveInt(existing.nextManifestSerial, 1),
        },
      };
    }
    const meta = buildDefaultMeta(nowMs);
    const result = writePath("/meta", meta);
    return result && result.success === true
      ? { success: true, data: meta }
      : result;
  }

  function allocateManifestID(nowMs = Date.now()) {
    const initialized = ensureInitialized(nowMs);
    if (!initialized || initialized.success !== true) {
      return initialized || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_STATE_INIT_FAILED",
      };
    }
    const meta = {
      ...initialized.data,
      nextManifestSerial: toPositiveInt(initialized.data.nextManifestSerial, 1),
    };
    const serial = meta.nextManifestSerial;
    const escrowLocationID = ESCROW_LOCATION_BASE + serial;
    if (!Number.isSafeInteger(escrowLocationID)) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_ESCROW_ID_EXHAUSTED" };
    }
    meta.nextManifestSerial = serial + 1;
    meta.updatedAtMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    const result = writePath("/meta", meta);
    if (!result || result.success !== true) {
      return result || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_MANIFEST_ID_WRITE_FAILED",
      };
    }
    return {
      success: true,
      data: {
        manifestID: `industrial-haul-${String(serial).padStart(8, "0")}`,
        serial,
        escrowLocationID,
      },
    };
  }

  function allocateContractID(nowMs = Date.now()) {
    const initialized = ensureInitialized(nowMs);
    if (!initialized || initialized.success !== true) {
      return initialized || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_STATE_INIT_FAILED",
      };
    }
    const meta = {
      ...initialized.data,
      nextContractSerial: toPositiveInt(initialized.data.nextContractSerial, 1),
    };
    const serial = meta.nextContractSerial;
    meta.nextContractSerial = serial + 1;
    meta.updatedAtMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    const result = writePath("/meta", meta);
    if (!result || result.success !== true) {
      return result || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_ID_WRITE_FAILED",
      };
    }
    return {
      success: true,
      data: {
        contractID: `industrial-hireling-${String(serial).padStart(8, "0")}`,
        serial,
      },
    };
  }

  function getContract(contractID) {
    const normalizedID = String(contractID || "").trim();
    return normalizedID
      ? readPath(`/contracts/${normalizedID}`, null)
      : null;
  }

  function saveContract(contract, writeOptions = {}) {
    const contractID = String(contract && contract.contractID || "").trim();
    if (!contractID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_ID_REQUIRED" };
    }
    return writePath(`/contracts/${contractID}`, contract, writeOptions);
  }

  function getManifest(manifestID) {
    const normalizedID = String(manifestID || "").trim();
    if (!normalizedID) return null;
    return readPath(`/manifests/${normalizedID}`, null) ||
      readPath(`/manifestArchive/${normalizedID}`, null);
  }

  function saveManifest(manifest, writeOptions = {}) {
    const manifestID = String(manifest && manifest.manifestID || "").trim();
    if (!manifestID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_MANIFEST_ID_REQUIRED" };
    }
    return writePath(`/manifests/${manifestID}`, manifest, writeOptions);
  }

  function listManifests(optionsArg = {}) {
    const manifests = readPath("/manifests", {});
    const ownerCharacterID = toPositiveInt(optionsArg.ownerCharacterID, 0);
    const contractID = String(optionsArg.contractID || "").trim();
    const statuses = Array.isArray(optionsArg.statuses)
      ? new Set(optionsArg.statuses.map((value) => String(value || "").trim()).filter(Boolean))
      : null;
    return Object.values(manifests && typeof manifests === "object" ? manifests : {})
      .filter((manifest) => manifest && typeof manifest === "object")
      .filter((manifest) => (
        !ownerCharacterID ||
        toPositiveInt(manifest.ownerCharacterID, 0) === ownerCharacterID
      ))
      .filter((manifest) => !contractID || String(manifest.contractID || "") === contractID)
      .filter((manifest) => !statuses || statuses.has(String(manifest.status || "")))
      .sort((left, right) => String(left.manifestID).localeCompare(String(right.manifestID)));
  }

  function archiveManifest(manifest, reason = "completed", nowMs = Date.now()) {
    const manifestID = String(manifest && manifest.manifestID || "").trim();
    if (!manifestID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_MANIFEST_ID_REQUIRED" };
    }
    const archivedRecord = {
      ...cloneValue(manifest),
      archiveReason: String(reason || "completed"),
      archivedAtMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
    };
    const archiveResult = writePath(`/manifestArchive/${manifestID}`, archivedRecord);
    if (!archiveResult || archiveResult.success !== true) {
      return archiveResult || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_MANIFEST_ARCHIVE_WRITE_FAILED",
      };
    }
    const removeResult = repo.remove(TABLE_NAME, `/manifests/${manifestID}`);
    if (!removeResult || removeResult.success !== true) {
      return removeResult || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_MANIFEST_ARCHIVE_REMOVE_FAILED",
      };
    }
    return { success: true, data: archivedRecord };
  }

  function listContracts(optionsArg = {}) {
    const contracts = readPath("/contracts", {});
    const ownerCharacterID = toPositiveInt(optionsArg.ownerCharacterID, 0);
    const states = Array.isArray(optionsArg.states)
      ? new Set(optionsArg.states.map((value) => String(value || "").trim()).filter(Boolean))
      : null;
    return Object.values(contracts && typeof contracts === "object" ? contracts : {})
      .filter((contract) => contract && typeof contract === "object")
      .filter((contract) => (
        !ownerCharacterID ||
        toPositiveInt(contract.ownerCharacterID, 0) === ownerCharacterID
      ))
      .filter((contract) => !states || states.has(String(contract.state || "")))
      .sort((left, right) => String(left.contractID).localeCompare(String(right.contractID)));
  }

  function archiveContract(contract, reason = "archived", nowMs = Date.now()) {
    const contractID = String(contract && contract.contractID || "").trim();
    if (!contractID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_ID_REQUIRED" };
    }
    const archivedRecord = {
      ...cloneValue(contract),
      archiveReason: String(reason || "archived"),
      archivedAtMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
    };
    const archiveResult = writePath(`/archive/${contractID}`, archivedRecord);
    if (!archiveResult || archiveResult.success !== true) {
      return archiveResult || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_ARCHIVE_WRITE_FAILED",
      };
    }
    const removeResult = repo.remove(TABLE_NAME, `/contracts/${contractID}`);
    if (!removeResult || removeResult.success !== true) {
      return removeResult || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_ARCHIVE_REMOVE_FAILED",
      };
    }
    return { success: true, data: archivedRecord };
  }

  function listArchivedContracts(optionsArg = {}) {
    const archive = readPath("/archive", {});
    const ownerCharacterID = toPositiveInt(optionsArg.ownerCharacterID, 0);
    return Object.values(archive && typeof archive === "object" ? archive : {})
      .filter((contract) => contract && typeof contract === "object")
      .filter((contract) => (
        !ownerCharacterID ||
        toPositiveInt(contract.ownerCharacterID, 0) === ownerCharacterID
      ))
      .sort((left, right) => String(left.contractID).localeCompare(String(right.contractID)));
  }

  return Object.freeze({
    TABLE_NAME,
    SCHEMA_VERSION,
    ESCROW_LOCATION_BASE,
    allocateContractID,
    allocateManifestID,
    archiveManifest,
    archiveContract,
    ensureInitialized,
    getContract,
    getManifest,
    listArchivedContracts,
    listContracts,
    listManifests,
    saveContract,
    saveManifest,
  });
}

let defaultStore = null;
function getDefaultStateStore() {
  if (!defaultStore) {
    defaultStore = createStateStore();
  }
  return defaultStore;
}

module.exports = {
  TABLE_NAME,
  SCHEMA_VERSION,
  ESCROW_LOCATION_BASE,
  buildDefaultMeta,
  createStateStore,
  getDefaultStateStore,
};
