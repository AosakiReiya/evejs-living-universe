"use strict";

const path = require("path");

const MANIFEST_STATUS = Object.freeze({
  RESERVED: "reserved",
  COLLECTING: "collecting",
  IN_TRANSIT: "in_transit",
  DELIVERED: "delivered",
  CANCELLED: "cancelled",
  RECOVERY_REQUIRED: "recovery_required",
});

const OPEN_MANIFEST_STATUSES = Object.freeze([
  MANIFEST_STATUS.RESERVED,
  MANIFEST_STATUS.COLLECTING,
  MANIFEST_STATUS.IN_TRANSIT,
  MANIFEST_STATUS.RECOVERY_REQUIRED,
]);

function getDefaultConfig() {
  return require(path.join(__dirname, "../../config"));
}

function getDefaultStateStore() {
  return require("./industrialHirelingState").getDefaultStateStore();
}

function getDefaultContractService() {
  return require("./industrialHirelingContracts").getDefaultContractService();
}

function getDefaultItemStore() {
  return require(path.join(__dirname, "../inventory/itemStore"));
}

function getDefaultItemTypeRegistry() {
  return require(path.join(__dirname, "../inventory/itemTypeRegistry"));
}

function getDefaultWorldData() {
  return require(path.join(__dirname, "../../space/worldData"));
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getStackQuantity(item) {
  return Math.max(0, toPositiveInt(item && (item.quantity ?? item.stacksize), 0));
}

function getDistanceMeters(left, right) {
  const dx = toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0);
  const dy = toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0);
  const dz = toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0);
  return Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2));
}

function createCargoCustodyService(options = {}) {
  const config = options.config || getDefaultConfig();
  let stateStore = options.stateStore || null;
  let contractService = options.contractService || null;
  let itemStore = options.itemStore || null;
  let itemTypeRegistry = options.itemTypeRegistry || null;
  let worldData = options.worldData || null;

  function getState() {
    if (!stateStore) stateStore = getDefaultStateStore();
    return stateStore;
  }

  function getContracts() {
    if (!contractService) contractService = getDefaultContractService();
    return contractService;
  }

  function getItems() {
    if (!itemStore) itemStore = getDefaultItemStore();
    return itemStore;
  }

  function getTypes() {
    if (!itemTypeRegistry) itemTypeRegistry = getDefaultItemTypeRegistry();
    return itemTypeRegistry;
  }

  function getWorld() {
    if (!worldData) worldData = getDefaultWorldData();
    return worldData;
  }

  function isEnabled() {
    return config.livingUniverseEnabled === true &&
      config.industrialHirelingsEnabled === true &&
      config.industrialHirelingsHaulingEnabled === true;
  }

  function disabledResult() {
    return { success: false, errorMsg: "INDUSTRIAL_HIRELINGS_DISABLED" };
  }

  function getItemVolumeM3(item) {
    const typeRecord = getTypes().resolveItemByTypeID(toPositiveInt(item && item.typeID, 0)) || {};
    return getStackQuantity(item) * Math.max(
      0,
      toFiniteNumber(item && item.volume, toFiniteNumber(typeRecord.volume, 0)),
    );
  }

  function isCargoContainer(item) {
    const typeRecord = getTypes().resolveItemByTypeID(toPositiveInt(item && item.typeID, 0)) || {};
    const groupName = String(typeRecord.groupName || item && item.groupName || "")
      .trim()
      .toLowerCase();
    return groupName.includes("container") || groupName === "spawn container";
  }

  function isValidDestination(destinationID) {
    const normalizedID = toPositiveInt(destinationID, 0);
    if (!normalizedID) return false;
    const world = getWorld();
    return Boolean(
      (typeof world.getStationByID === "function" && world.getStationByID(normalizedID)) ||
      (typeof world.getStructureByID === "function" && world.getStructureByID(normalizedID)),
    );
  }

  function listOpenManifests(contractID = "") {
    return getState().listManifests({
      contractID,
      statuses: OPEN_MANIFEST_STATUSES,
    });
  }

  function getOpenManifestForContract(contractID) {
    return listOpenManifests(String(contractID || "").trim())
      .sort((left, right) => (
        toFiniteNumber(right.updatedAtMs, 0) - toFiniteNumber(left.updatedAtMs, 0)
      ))[0] || null;
  }

  function saveManifest(manifest) {
    const result = getState().saveManifest(manifest);
    return result && result.success === true
      ? { success: true, data: cloneValue(manifest) }
      : result;
  }

  function markContractCargo(manifest, cargoStatus, nowMs) {
    return getContracts().setCargoManifest({
      ownerCharacterID: manifest.ownerCharacterID,
      contractID: manifest.contractID,
      manifestID: cargoStatus === MANIFEST_STATUS.DELIVERED ||
        cargoStatus === MANIFEST_STATUS.CANCELLED
        ? null
        : manifest.manifestID,
      cargoStatus,
    }, nowMs);
  }

  function buildItemSnapshots(contents) {
    return contents.map((item) => ({
      itemID: toPositiveInt(item.itemID, 0),
      typeID: toPositiveInt(item.typeID, 0),
      quantity: getStackQuantity(item),
      volumeM3: getItemVolumeM3(item),
    }));
  }

  function reserveNearestContainer(input = {}, nowMs = Date.now()) {
    if (!isEnabled()) return disabledResult();
    const contract = input.contract || {};
    const ownerCharacterID = toPositiveInt(contract.ownerCharacterID, 0);
    const destinationStationID = toPositiveInt(contract.destinationStationID, 0);
    const scene = input.scene || null;
    const referenceEntity = input.referenceEntity || null;
    if (!scene || !ownerCharacterID || !referenceEntity || !referenceEntity.position) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_EMPLOYER_SHIP_NOT_FOUND" };
    }
    if (!isValidDestination(destinationStationID)) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_DESTINATION_INVALID" };
    }

    const existing = getOpenManifestForContract(contract.contractID);
    if (existing) {
      return { success: true, data: { manifest: existing, reused: true } };
    }

    const reservedContainerIDs = new Set(
      listOpenManifests().map((manifest) => toPositiveInt(manifest.sourceContainerID, 0)),
    );
    const maxDistanceMeters = Math.max(
      2_500,
      toFiniteNumber(config.industrialHirelingsHaulerMaxPickupDistanceMeters, 250_000),
    );
    const dynamicEntities = scene.dynamicEntities instanceof Map
      ? [...scene.dynamicEntities.values()]
      : [];
    const candidates = [];
    for (const entity of dynamicEntities) {
      const containerID = toPositiveInt(entity && entity.itemID, 0);
      if (!containerID || reservedContainerIDs.has(containerID)) continue;
      const containerItem = getItems().findItemById(containerID);
      if (
        !containerItem ||
        toPositiveInt(containerItem.ownerID, 0) !== ownerCharacterID ||
        toPositiveInt(containerItem.locationID, 0) !== toPositiveInt(scene.systemID, 0) ||
        toFiniteNumber(containerItem.flagID, -1) !== 0 ||
        !isCargoContainer(containerItem)
      ) {
        continue;
      }
      const contents = getItems().listContainerItems(ownerCharacterID, containerID, null)
        .filter((item) => getStackQuantity(item) > 0);
      if (contents.length <= 0) continue;
      const distanceMeters = getDistanceMeters(referenceEntity.position, entity.position);
      if (distanceMeters > maxDistanceMeters) continue;
      candidates.push({ containerID, containerItem, entity, contents, distanceMeters });
    }
    candidates.sort((left, right) => (
      left.distanceMeters - right.distanceMeters || left.containerID - right.containerID
    ));
    const selected = candidates[0] || null;
    if (!selected) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_NO_OWNED_JETCAN" };
    }

    const allocated = getState().allocateManifestID(nowMs);
    if (!allocated || allocated.success !== true) return allocated;
    const normalizedNowMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    const itemSnapshots = buildItemSnapshots(selected.contents);
    const manifest = {
      schemaVersion: 1,
      manifestID: allocated.data.manifestID,
      serial: allocated.data.serial,
      contractID: String(contract.contractID || ""),
      ownerCharacterID,
      sourceSystemID: toPositiveInt(scene.systemID, 0),
      sourceContainerID: selected.containerID,
      destinationStationID,
      escrowLocationID: allocated.data.escrowLocationID,
      status: MANIFEST_STATUS.RESERVED,
      itemIDs: itemSnapshots.map((item) => item.itemID),
      itemSnapshots,
      totalVolumeM3: itemSnapshots.reduce((sum, item) => sum + item.volumeM3, 0),
      createdAtMs: normalizedNowMs,
      updatedAtMs: normalizedNowMs,
      collectedAtMs: 0,
      readyAtMs: 0,
      deliveredAtMs: 0,
      nextAttemptAtMs: 0,
      lastError: null,
      revision: 1,
    };
    const saved = saveManifest(manifest);
    if (!saved || saved.success !== true) return saved;
    const marked = markContractCargo(manifest, MANIFEST_STATUS.RESERVED, normalizedNowMs);
    if (!marked || marked.success !== true) {
      return marked;
    }
    return {
      success: true,
      data: {
        manifest,
        reused: false,
        sourceEntity: selected.entity,
        distanceMeters: selected.distanceMeters,
      },
    };
  }

  function saveRecovery(manifest, errorMsg, nowMs) {
    const normalizedNowMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    const next = {
      ...manifest,
      status: MANIFEST_STATUS.RECOVERY_REQUIRED,
      lastError: String(errorMsg || "INDUSTRIAL_HIRELING_CARGO_RECOVERY_REQUIRED"),
      nextAttemptAtMs: normalizedNowMs + 60_000,
      updatedAtMs: normalizedNowMs,
      revision: toPositiveInt(manifest.revision, 1) + 1,
    };
    const saved = saveManifest(next);
    if (saved && saved.success === true) {
      markContractCargo(next, MANIFEST_STATUS.RECOVERY_REQUIRED, normalizedNowMs);
    }
    return { success: false, errorMsg: next.lastError, data: next };
  }

  function collectReservedManifest(manifestID, nowMs = Date.now()) {
    if (!isEnabled()) return disabledResult();
    const manifest = getState().getManifest(manifestID);
    if (!manifest || !OPEN_MANIFEST_STATUSES.includes(String(manifest.status || ""))) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_MANIFEST_NOT_FOUND" };
    }
    if (manifest.status === MANIFEST_STATUS.IN_TRANSIT) {
      return { success: true, data: { manifest, reused: true } };
    }
    const normalizedNowMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    let collecting = {
      ...manifest,
      status: MANIFEST_STATUS.COLLECTING,
      lastError: null,
      nextAttemptAtMs: 0,
      updatedAtMs: normalizedNowMs,
      revision: toPositiveInt(manifest.revision, 1) + 1,
    };
    const collectingSaved = saveManifest(collecting);
    if (!collectingSaved || collectingSaved.success !== true) return collectingSaved;
    markContractCargo(collecting, MANIFEST_STATUS.COLLECTING, normalizedNowMs);

    for (const itemID of collecting.itemIDs || []) {
      const item = getItems().findItemById(itemID);
      if (!item || toPositiveInt(item.ownerID, 0) !== collecting.ownerCharacterID) {
        return saveRecovery(collecting, "INDUSTRIAL_HIRELING_CARGO_ITEM_MISSING", normalizedNowMs);
      }
      const locationID = toPositiveInt(item.locationID, 0);
      if (
        locationID === collecting.escrowLocationID ||
        locationID === collecting.destinationStationID
      ) {
        continue;
      }
      if (locationID !== collecting.sourceContainerID) {
        return saveRecovery(collecting, "INDUSTRIAL_HIRELING_CARGO_LOCATION_MISMATCH", normalizedNowMs);
      }
      if (typeof getItems().setInventoryItemTransient === "function") {
        const persistenceResult = getItems().setInventoryItemTransient(itemID, false);
        if (!persistenceResult || persistenceResult.success !== true) {
          return saveRecovery(
            collecting,
            persistenceResult && persistenceResult.errorMsg ||
              "INDUSTRIAL_HIRELING_CARGO_PERSISTENCE_FAILED",
            normalizedNowMs,
          );
        }
      }
      const moveResult = getItems().moveItemToLocation(
        itemID,
        collecting.escrowLocationID,
        getItems().ITEM_FLAGS.HANGAR,
        null,
      );
      if (!moveResult || moveResult.success !== true) {
        return saveRecovery(
          collecting,
          moveResult && moveResult.errorMsg || "INDUSTRIAL_HIRELING_CARGO_ESCROW_MOVE_FAILED",
          normalizedNowMs,
        );
      }
    }

    const transitMs = Math.max(
      5_000,
      toFiniteNumber(config.industrialHirelingsHaulerTransitSeconds, 30) * 1_000,
    );
    collecting = {
      ...collecting,
      status: MANIFEST_STATUS.IN_TRANSIT,
      collectedAtMs: collecting.collectedAtMs || normalizedNowMs,
      readyAtMs: collecting.readyAtMs || normalizedNowMs + transitMs,
      updatedAtMs: normalizedNowMs,
      revision: toPositiveInt(collecting.revision, 1) + 1,
    };
    const saved = saveManifest(collecting);
    if (!saved || saved.success !== true) return saved;
    const marked = markContractCargo(collecting, MANIFEST_STATUS.IN_TRANSIT, normalizedNowMs);
    if (!marked || marked.success !== true) return marked;
    return { success: true, data: { manifest: collecting, reused: false } };
  }

  function deliverManifest(manifestID, nowMs = Date.now()) {
    if (!isEnabled()) return disabledResult();
    let manifest = getState().getManifest(manifestID);
    if (!manifest) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_MANIFEST_NOT_FOUND" };
    }
    if (manifest.status === MANIFEST_STATUS.DELIVERED) {
      return { success: true, data: { manifest, reused: true } };
    }
    const normalizedNowMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    if (
      toFiniteNumber(manifest.readyAtMs, 0) > normalizedNowMs &&
      manifest.status === MANIFEST_STATUS.IN_TRANSIT
    ) {
      return { success: true, data: { manifest, waiting: true } };
    }

    const locations = (manifest.itemIDs || []).map((itemID) => {
      const item = getItems().findItemById(itemID);
      return item ? toPositiveInt(item.locationID, 0) : 0;
    });
    const hasSourceCargo = locations.some((locationID) => locationID === manifest.sourceContainerID);
    const hasEscrowCargo = locations.some((locationID) => locationID === manifest.escrowLocationID);
    if (hasSourceCargo && (hasEscrowCargo || manifest.status !== MANIFEST_STATUS.RESERVED)) {
      const recovered = collectReservedManifest(manifest.manifestID, normalizedNowMs);
      if (!recovered || recovered.success !== true) return recovered;
      manifest = recovered.data.manifest;
      if (manifest.readyAtMs > normalizedNowMs) {
        return { success: true, data: { manifest, waiting: true, recovered: true } };
      }
    } else if (hasSourceCargo) {
      return { success: true, data: { manifest, waitingForPickup: true } };
    }

    for (const itemID of manifest.itemIDs || []) {
      const item = getItems().findItemById(itemID);
      if (!item || toPositiveInt(item.ownerID, 0) !== manifest.ownerCharacterID) {
        return saveRecovery(manifest, "INDUSTRIAL_HIRELING_CARGO_ITEM_MISSING", normalizedNowMs);
      }
      const locationID = toPositiveInt(item.locationID, 0);
      if (locationID === manifest.destinationStationID) continue;
      if (locationID !== manifest.escrowLocationID) {
        return saveRecovery(manifest, "INDUSTRIAL_HIRELING_CARGO_LOCATION_MISMATCH", normalizedNowMs);
      }
      const moveResult = getItems().moveItemToLocation(
        itemID,
        manifest.destinationStationID,
        getItems().ITEM_FLAGS.HANGAR,
        null,
      );
      if (!moveResult || moveResult.success !== true) {
        return saveRecovery(
          manifest,
          moveResult && moveResult.errorMsg || "INDUSTRIAL_HIRELING_CARGO_DELIVERY_FAILED",
          normalizedNowMs,
        );
      }
    }

    const delivered = {
      ...manifest,
      status: MANIFEST_STATUS.DELIVERED,
      deliveredAtMs: normalizedNowMs,
      updatedAtMs: normalizedNowMs,
      nextAttemptAtMs: 0,
      lastError: null,
      revision: toPositiveInt(manifest.revision, 1) + 1,
    };
    const saved = saveManifest(delivered);
    if (!saved || saved.success !== true) return saved;
    getContracts().recordHaulDelivery({
      ownerCharacterID: delivered.ownerCharacterID,
      contractID: delivered.contractID,
      destinationStationID: delivered.destinationStationID,
      deliveredVolumeM3: delivered.totalVolumeM3,
      manifestID: delivered.manifestID,
    }, normalizedNowMs);
    if (typeof getState().archiveManifest === "function") {
      getState().archiveManifest(delivered, "delivered", normalizedNowMs);
    }
    return { success: true, data: { manifest: delivered, delivered: true } };
  }

  function cancelReservation(manifestID, nowMs = Date.now()) {
    if (!isEnabled()) return disabledResult();
    const manifest = getState().getManifest(manifestID);
    if (!manifest) {
      return { success: true, data: { cancelled: false } };
    }
    if (manifest.status !== MANIFEST_STATUS.RESERVED) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CARGO_IN_TRANSIT" };
    }
    const hasEscrowCargo = (manifest.itemIDs || []).some((itemID) => {
      const item = getItems().findItemById(itemID);
      return item && toPositiveInt(item.locationID, 0) === manifest.escrowLocationID;
    });
    if (hasEscrowCargo) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CARGO_IN_TRANSIT" };
    }
    const normalizedNowMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    const cancelled = {
      ...manifest,
      status: MANIFEST_STATUS.CANCELLED,
      updatedAtMs: normalizedNowMs,
      revision: toPositiveInt(manifest.revision, 1) + 1,
    };
    const saved = saveManifest(cancelled);
    if (!saved || saved.success !== true) return saved;
    markContractCargo(cancelled, MANIFEST_STATUS.CANCELLED, normalizedNowMs);
    if (typeof getState().archiveManifest === "function") {
      getState().archiveManifest(cancelled, "cancelled", normalizedNowMs);
    }
    return { success: true, data: { manifest: cancelled, cancelled: true } };
  }

  function reconcileDueManifests(nowMs = Date.now(), optionsArg = {}) {
    if (!isEnabled()) {
      return { success: true, data: { enabled: false, inspected: 0, delivered: 0 } };
    }
    const normalizedNowMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    const maxJobs = Math.max(
      1,
      toPositiveInt(
        optionsArg.maxJobs,
        toPositiveInt(config.industrialHirelingsMaxJobsPerPass, 4),
      ),
    );
    const due = listOpenManifests()
      .filter((manifest) => toFiniteNumber(manifest.nextAttemptAtMs, 0) <= normalizedNowMs)
      .slice(0, maxJobs);
    let delivered = 0;
    let recovered = 0;
    for (const manifest of due) {
      const result = deliverManifest(manifest.manifestID, normalizedNowMs);
      if (result && result.success === true && result.data && result.data.delivered) delivered += 1;
      if (result && result.success === true && result.data && result.data.recovered) recovered += 1;
    }
    return {
      success: true,
      data: { enabled: true, inspected: due.length, delivered, recovered },
    };
  }

  return Object.freeze({
    MANIFEST_STATUS,
    OPEN_MANIFEST_STATUSES,
    cancelReservation,
    collectReservedManifest,
    deliverManifest,
    getOpenManifestForContract,
    isEnabled,
    reconcileDueManifests,
    reserveNearestContainer,
  });
}

let defaultService = null;
function getDefaultCargoCustodyService() {
  if (!defaultService) defaultService = createCargoCustodyService();
  return defaultService;
}

module.exports = {
  MANIFEST_STATUS,
  OPEN_MANIFEST_STATUSES,
  createCargoCustodyService,
  getDefaultCargoCustodyService,
};
