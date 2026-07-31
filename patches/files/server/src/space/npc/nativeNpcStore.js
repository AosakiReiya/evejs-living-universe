const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));
const {
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(__dirname, "../destiny/identity/entityID"));

const TABLE = Object.freeze({
  ENTITIES: "npcEntities",
  MODULES: "npcModules",
  CARGO: "npcCargo",
  CONTROLLERS: "npcRuntimeControllers",
  WRECKS: "npcWrecks",
  WRECK_ITEMS: "npcWreckItems",
});

const ROOT = Object.freeze({
  [TABLE.ENTITIES]: {
    nextEntityID: 980000000000,
    entities: {},
  },
  [TABLE.MODULES]: {
    nextModuleID: 980100000000,
    modules: {},
  },
  [TABLE.CARGO]: {
    nextCargoID: 980200000000,
    cargo: {},
  },
  [TABLE.CONTROLLERS]: {
    controllers: {},
  },
  [TABLE.WRECKS]: {
    nextWreckID: 980300000000,
    wrecks: {},
  },
  [TABLE.WRECK_ITEMS]: {
    nextWreckItemID: 980400000000,
    items: {},
  },
});

const transientCounters = {
  [TABLE.ENTITIES]: null,
  [TABLE.MODULES]: null,
  [TABLE.CARGO]: null,
  [TABLE.WRECKS]: null,
  [TABLE.WRECK_ITEMS]: null,
};

const controllerCache = {
  all: null,
  bySystem: new Map(),
  byEntityID: new Map(),
};

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function invalidateControllerCache() {
  controllerCache.all = null;
  controllerCache.bySystem.clear();
  controllerCache.byEntityID.clear();
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

const INVALID_PERSISTENT_IDENTITY = "invalid-persistent-identity";
const NATIVE_SCOPE_ID_FIELDS = Object.freeze([
  "airNpeOwnerCharacterID",
  "airNpeOperationID",
  "airNpeInstanceID",
  "dungeonSiteID",
  "dungeonSiteInstanceID",
]);
const NATIVE_SCOPE_BOOLEAN_FIELDS = Object.freeze([
  "airNpeBoardingShipPresentation",
  "airNpeTutorialDebris",
  "airNpeHostile",
  "dungeonMaterializedContainer",
  "dungeonMaterializedSiteContent",
  "dungeonSiteContentBonus",
  "dungeonSiteContentFailureExplodes",
  "dungeonSiteContentPersistsAfterResponse",
]);
const NATIVE_SCOPE_TEXT_FIELDS = Object.freeze([
  "airNpeHostileWave",
  "dungeonEncounterKey",
  "dungeonSiteContentKey",
  "dungeonSiteContentRole",
  "dungeonSiteContentAnalyzer",
  "dungeonSiteContentTrigger",
  "dungeonSiteContentLootProfile",
  "dungeonSiteContentHackingDifficulty",
]);
const NATIVE_SCOPE_ARRAY_FIELDS = Object.freeze([
  "dungeonSiteContentExplicitLoot",
  "dungeonSiteContentLootTags",
]);
const NATIVE_DUNGEON_BOOLEAN_MARKERS = new Set([
  "dungeonMaterializedContainer",
  "dungeonMaterializedSiteContent",
  "dungeonSiteContentBonus",
  "dungeonSiteContentFailureExplodes",
  "dungeonSiteContentPersistsAfterResponse",
]);
const NATIVE_DUNGEON_TEXT_MARKERS = new Set([
  "dungeonEncounterKey",
  "dungeonSiteContentKey",
  "dungeonSiteContentRole",
  "dungeonSiteContentAnalyzer",
  "dungeonSiteContentTrigger",
  "dungeonSiteContentLootProfile",
  "dungeonSiteContentHackingDifficulty",
]);
const NATIVE_AIR_BOOLEAN_MARKERS = new Set([
  "airNpeBoardingShipPresentation",
  "airNpeTutorialDebris",
  "airNpeHostile",
]);

function hasPresentScopeIdentity(source, key) {
  return Boolean(
    source &&
    Object.hasOwn(source, key) &&
    source[key] !== null &&
    source[key] !== undefined,
  );
}

function resolveStoredEntityScopeMetadata(sources = [], options = {}) {
  const sourceList = Array.isArray(sources) ? sources : [sources];
  const metadata = {};
  const invalidIdentityFields = new Set();
  const conflictingIdentityFields = new Set();
  const firstIdentityByField = new Map();

  for (const source of sourceList) {
    if (!source || typeof source !== "object") {
      continue;
    }
    for (const key of NATIVE_SCOPE_ID_FIELDS) {
      if (!hasPresentScopeIdentity(source, key)) {
        continue;
      }
      const normalized = normalizePersistentEntityID(source[key]);
      if (normalized === null) {
        invalidIdentityFields.add(key);
        metadata[key] = INVALID_PERSISTENT_IDENTITY;
        continue;
      }
      if (
        firstIdentityByField.has(key) &&
        String(firstIdentityByField.get(key)) !== String(normalized)
      ) {
        conflictingIdentityFields.add(key);
        metadata[key] = INVALID_PERSISTENT_IDENTITY;
        continue;
      }
      firstIdentityByField.set(key, normalized);
      if (!invalidIdentityFields.has(key) && !conflictingIdentityFields.has(key)) {
        metadata[key] = toJSONSafeEntityID(normalized);
      }
    }
    for (const key of NATIVE_SCOPE_BOOLEAN_FIELDS) {
      if (source[key] === true) {
        metadata[key] = true;
      }
    }
    for (const key of NATIVE_SCOPE_TEXT_FIELDS) {
      const normalized = String(source[key] == null ? "" : source[key]).trim();
      if (normalized) {
        metadata[key] = normalized;
      }
    }
    for (const key of NATIVE_SCOPE_ARRAY_FIELDS) {
      if (Array.isArray(source[key])) {
        metadata[key] = cloneValue(source[key]);
      }
    }
  }

  if (
    options.projectAirInstanceToDungeonSite === true &&
    normalizePersistentEntityID(metadata.airNpeInstanceID) !== null &&
    !invalidIdentityFields.has("dungeonSiteInstanceID") &&
    !conflictingIdentityFields.has("dungeonSiteInstanceID")
  ) {
    metadata.dungeonSiteInstanceID = metadata.airNpeInstanceID;
  }

  const hasDungeonSiteContentOrID = Boolean(
    normalizePersistentEntityID(metadata.dungeonSiteID) !== null ||
    [...NATIVE_DUNGEON_BOOLEAN_MARKERS].some(
      (key) => metadata[key] === true,
    ) ||
    [...NATIVE_DUNGEON_TEXT_MARKERS].some(
      (key) => String(metadata[key] == null ? "" : metadata[key]).trim(),
    ) ||
    NATIVE_SCOPE_ARRAY_FIELDS.some((key) => Array.isArray(metadata[key]))
  );
  const hasAirOwnerOperationOrPresentation = Boolean(
    normalizePersistentEntityID(metadata.airNpeOwnerCharacterID) !== null ||
    normalizePersistentEntityID(metadata.airNpeOperationID) !== null ||
    [...NATIVE_AIR_BOOLEAN_MARKERS].some((key) => metadata[key] === true) ||
    String(metadata.airNpeHostileWave == null ? "" : metadata.airNpeHostileWave).trim()
  );
  const missingRequiredIdentityFields = [];
  if (
    hasDungeonSiteContentOrID &&
    normalizePersistentEntityID(metadata.dungeonSiteInstanceID) === null
  ) {
    missingRequiredIdentityFields.push("dungeonSiteInstanceID");
  }
  if (
    hasAirOwnerOperationOrPresentation &&
    normalizePersistentEntityID(metadata.airNpeInstanceID) === null
  ) {
    missingRequiredIdentityFields.push("airNpeInstanceID");
  }

  const success =
    invalidIdentityFields.size === 0 &&
    conflictingIdentityFields.size === 0 &&
    missingRequiredIdentityFields.length === 0;
  return {
    success,
    errorMsg: success ? null : "NPC_PRIVATE_SCOPE_INVALID",
    data: {
      metadata,
      invalidIdentityFields: [...invalidIdentityFields],
      conflictingIdentityFields: [...conflictingIdentityFields],
      missingRequiredIdentityFields,
    },
  };
}

function validateStoredEntityScopeMetadata(value = {}, options = {}) {
  return resolveStoredEntityScopeMetadata([value], options);
}

function buildStoredEntityScopeMetadata(value = {}, options = {}) {
  return validateStoredEntityScopeMetadata(value, options).data.metadata;
}

function readRoot(tableName) {
  const result = database.read(tableName, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return cloneValue(ROOT[tableName]);
  }
  const root = {
    ...cloneValue(ROOT[tableName]),
    ...cloneValue(result.data),
  };
  return root;
}

function ensureRootShape(tableName) {
  const currentRoot = readRoot(tableName);
  const result = database.read(tableName, "/");
  const existingRoot = result.success && result.data && typeof result.data === "object"
    ? result.data
    : null;
  const normalizedRoot = cloneValue(currentRoot);
  if (!existingRoot || JSON.stringify(existingRoot) !== JSON.stringify(normalizedRoot)) {
    database.write(tableName, "/", normalizedRoot);
  }
  return normalizedRoot;
}

function writeRoot(tableName, root, options = {}) {
  return database.write(tableName, "/", root, options);
}

function readCollection(tableName, key) {
  const root = ensureRootShape(tableName);
  const collection = root && typeof root === "object" && root[key] && typeof root[key] === "object"
    ? root[key]
    : {};
  return cloneValue(collection);
}

function writeCollectionRow(tableName, collectionKey, rowID, value, options = {}) {
  ensureRootShape(tableName);
  return database.write(
    tableName,
    `/${collectionKey}/${String(rowID)}`,
    cloneValue(value),
    options,
  );
}

function removeCollectionRow(tableName, collectionKey, rowID) {
  ensureRootShape(tableName);
  return database.remove(tableName, `/${collectionKey}/${String(rowID)}`);
}

function allocateID(tableName, counterKey, options = {}) {
  if (options.transient === true) {
    if (!Number.isInteger(transientCounters[tableName])) {
      const root = ensureRootShape(tableName);
      transientCounters[tableName] = Math.max(
        toPositiveInt(root && root[counterKey], 0),
        toPositiveInt(ROOT[tableName] && ROOT[tableName][counterKey], 0),
      );
    }
    const nextID = transientCounters[tableName];
    transientCounters[tableName] += 1;
    return {
      success: true,
      data: nextID,
    };
  }

  const root = ensureRootShape(tableName);
  const nextID = Math.max(
    toPositiveInt(root && root[counterKey], 0),
    toPositiveInt(ROOT[tableName] && ROOT[tableName][counterKey], 0),
  );
  const updatedRoot = {
    ...root,
    [counterKey]: nextID + 1,
  };
  // ID counters are authoritative store metadata, not transient runtime rows.
  // Persisting them avoids collisions without ever transient-marking the whole
  // table snapshot.
  const writeResult = writeRoot(tableName, updatedRoot);
  if (!writeResult.success) {
    return {
      success: false,
      errorMsg: writeResult.errorMsg || "NPC_NATIVE_ID_ALLOCATE_FAILED",
    };
  }
  return {
    success: true,
    data: nextID,
  };
}

function allocateEntityID(options = {}) {
  return allocateID(TABLE.ENTITIES, "nextEntityID", options);
}

function allocateModuleID(options = {}) {
  return allocateID(TABLE.MODULES, "nextModuleID", options);
}

function allocateCargoID(options = {}) {
  return allocateID(TABLE.CARGO, "nextCargoID", options);
}

function allocateWreckID(options = {}) {
  return allocateID(TABLE.WRECKS, "nextWreckID", options);
}

function allocateWreckItemID(options = {}) {
  return allocateID(TABLE.WRECK_ITEMS, "nextWreckItemID", options);
}

function listNativeEntities() {
  return Object.values(readCollection(TABLE.ENTITIES, "entities"))
    .sort((left, right) => Number(left.entityID || 0) - Number(right.entityID || 0));
}

function getNativeEntity(entityID) {
  const collection = readCollection(TABLE.ENTITIES, "entities");
  return collection[String(entityID)] || null;
}

function upsertNativeEntity(entityRecord, options = {}) {
  const entityID = toPositiveInt(entityRecord && entityRecord.entityID, 0);
  if (!entityID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_ENTITY_ID_REQUIRED",
    };
  }
  const scopeResolution = validateStoredEntityScopeMetadata(entityRecord);
  if (!scopeResolution.success) {
    return {
      success: false,
      errorMsg: scopeResolution.errorMsg,
    };
  }
  return writeCollectionRow(
    TABLE.ENTITIES,
    "entities",
    entityID,
    {
      ...entityRecord,
      ...scopeResolution.data.metadata,
    },
    options,
  );
}

function listNativeEntitiesForSystem(systemID) {
  const normalizedSystemID = toPositiveInt(systemID, 0);
  return listNativeEntities().filter(
    (entity) => toPositiveInt(entity && entity.systemID, 0) === normalizedSystemID,
  );
}

function removeNativeEntity(entityID) {
  return removeCollectionRow(TABLE.ENTITIES, "entities", entityID);
}

function listNativeModules() {
  return Object.values(readCollection(TABLE.MODULES, "modules"))
    .sort((left, right) => Number(left.moduleID || 0) - Number(right.moduleID || 0));
}

function listNativeModulesForEntity(entityID) {
  const normalizedEntityID = toPositiveInt(entityID, 0);
  return listNativeModules().filter(
    (moduleRecord) => toPositiveInt(moduleRecord && moduleRecord.entityID, 0) === normalizedEntityID,
  );
}

function upsertNativeModule(moduleRecord, options = {}) {
  const moduleID = toPositiveInt(moduleRecord && moduleRecord.moduleID, 0);
  if (!moduleID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_MODULE_ID_REQUIRED",
    };
  }
  return writeCollectionRow(
    TABLE.MODULES,
    "modules",
    moduleID,
    moduleRecord,
    options,
  );
}

function removeNativeModule(moduleID) {
  return removeCollectionRow(TABLE.MODULES, "modules", moduleID);
}

function listNativeCargo() {
  return Object.values(readCollection(TABLE.CARGO, "cargo"))
    .sort((left, right) => Number(left.cargoID || 0) - Number(right.cargoID || 0));
}

function listNativeCargoForEntity(entityID) {
  const normalizedEntityID = toPositiveInt(entityID, 0);
  return listNativeCargo().filter(
    (cargoRecord) => toPositiveInt(cargoRecord && cargoRecord.entityID, 0) === normalizedEntityID,
  );
}

function upsertNativeCargo(cargoRecord, options = {}) {
  const cargoID = toPositiveInt(cargoRecord && cargoRecord.cargoID, 0);
  if (!cargoID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_CARGO_ID_REQUIRED",
    };
  }
  return writeCollectionRow(
    TABLE.CARGO,
    "cargo",
    cargoID,
    cargoRecord,
    options,
  );
}

function removeNativeCargo(cargoID) {
  return removeCollectionRow(TABLE.CARGO, "cargo", cargoID);
}

function listNativeControllers() {
  if (Array.isArray(controllerCache.all)) {
    return controllerCache.all;
  }

  const allControllers = Object.values(readCollection(TABLE.CONTROLLERS, "controllers"))
    .sort((left, right) => Number(left.entityID || 0) - Number(right.entityID || 0));
  controllerCache.all = allControllers;
  controllerCache.byEntityID = new Map(
    allControllers.map((controller) => [String(toPositiveInt(controller && controller.entityID, 0)), controller]),
  );
  return allControllers;
}

function listNativeControllersForSystem(systemID) {
  const normalizedSystemID = toPositiveInt(systemID, 0);
  if (!normalizedSystemID) {
    return [];
  }
  if (controllerCache.bySystem.has(normalizedSystemID)) {
    return controllerCache.bySystem.get(normalizedSystemID);
  }

  const systemControllers = listNativeControllers().filter(
    (controller) => toPositiveInt(controller && controller.systemID, 0) === normalizedSystemID,
  );
  controllerCache.bySystem.set(normalizedSystemID, systemControllers);
  return systemControllers;
}

function getNativeController(entityID) {
  const normalizedEntityID = String(toPositiveInt(entityID, 0));
  if (!normalizedEntityID || normalizedEntityID === "0") {
    return null;
  }
  listNativeControllers();
  return controllerCache.byEntityID.get(normalizedEntityID) || null;
}

function upsertNativeController(controllerRecord, options = {}) {
  const entityID = toPositiveInt(controllerRecord && controllerRecord.entityID, 0);
  if (!entityID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_CONTROLLER_ID_REQUIRED",
    };
  }
  const writeResult = writeCollectionRow(
    TABLE.CONTROLLERS,
    "controllers",
    entityID,
    controllerRecord,
    options,
  );
  if (writeResult && writeResult.success) {
    invalidateControllerCache();
  }
  return writeResult;
}

function removeNativeController(entityID) {
  const removeResult = removeCollectionRow(TABLE.CONTROLLERS, "controllers", entityID);
  if (removeResult && removeResult.success) {
    invalidateControllerCache();
  }
  return removeResult;
}

function removeNativeEntityCascade(entityID) {
  const normalizedEntityID = toPositiveInt(entityID, 0);
  if (!normalizedEntityID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_ENTITY_ID_REQUIRED",
    };
  }

  for (const moduleRecord of listNativeModulesForEntity(normalizedEntityID)) {
    removeNativeModule(moduleRecord.moduleID);
  }
  for (const cargoRecord of listNativeCargoForEntity(normalizedEntityID)) {
    removeNativeCargo(cargoRecord.cargoID);
  }
  removeNativeController(normalizedEntityID);
  removeNativeEntity(normalizedEntityID);

  return {
    success: true,
    data: {
      entityID: normalizedEntityID,
    },
  };
}

function removeNativeEntitiesCascade(entityIDs) {
  const normalizedEntityIDs = Array.from(new Set(
    (Array.isArray(entityIDs) ? entityIDs : [])
      .map((entityID) => toPositiveInt(entityID, 0))
      .filter(Boolean),
  ));
  if (normalizedEntityIDs.length === 0) {
    return {
      success: true,
      data: {
        entityIDs: [],
        removedEntities: 0,
        removedControllers: 0,
        removedModules: 0,
        removedCargo: 0,
      },
    };
  }

  const entityIDSet = new Set(normalizedEntityIDs.map(String));
  const entityRoot = ensureRootShape(TABLE.ENTITIES);
  const controllerRoot = ensureRootShape(TABLE.CONTROLLERS);
  const moduleRoot = ensureRootShape(TABLE.MODULES);
  const cargoRoot = ensureRootShape(TABLE.CARGO);
  let removedEntities = 0;
  let removedControllers = 0;
  let removedModules = 0;
  let removedCargo = 0;

  for (const entityID of normalizedEntityIDs) {
    const key = String(entityID);
    if (entityRoot.entities && entityRoot.entities[key]) {
      delete entityRoot.entities[key];
      removedEntities += 1;
    }
    if (controllerRoot.controllers && controllerRoot.controllers[key]) {
      delete controllerRoot.controllers[key];
      removedControllers += 1;
    }
  }
  for (const [moduleID, moduleRecord] of Object.entries(moduleRoot.modules || {})) {
    if (entityIDSet.has(String(toPositiveInt(moduleRecord && moduleRecord.entityID, 0)))) {
      delete moduleRoot.modules[moduleID];
      removedModules += 1;
    }
  }
  for (const [cargoID, cargoRecord] of Object.entries(cargoRoot.cargo || {})) {
    if (entityIDSet.has(String(toPositiveInt(cargoRecord && cargoRecord.entityID, 0)))) {
      delete cargoRoot.cargo[cargoID];
      removedCargo += 1;
    }
  }

  for (const [tableName, root] of [
    [TABLE.MODULES, moduleRoot],
    [TABLE.CARGO, cargoRoot],
    [TABLE.CONTROLLERS, controllerRoot],
    [TABLE.ENTITIES, entityRoot],
  ]) {
    const writeResult = writeRoot(tableName, root);
    if (!writeResult.success) {
      invalidateControllerCache();
      return {
        success: false,
        errorMsg: writeResult.errorMsg || "NPC_NATIVE_BULK_REMOVE_FAILED",
        data: {
          tableName,
        },
      };
    }
  }
  invalidateControllerCache();
  return {
    success: true,
    data: {
      entityIDs: normalizedEntityIDs,
      removedEntities,
      removedControllers,
      removedModules,
      removedCargo,
    },
  };
}

function listNativeWrecks() {
  return Object.values(readCollection(TABLE.WRECKS, "wrecks"))
    .sort((left, right) => Number(left.wreckID || 0) - Number(right.wreckID || 0));
}

function getNativeWreck(wreckID) {
  const collection = readCollection(TABLE.WRECKS, "wrecks");
  return collection[String(wreckID)] || null;
}

function upsertNativeWreck(wreckRecord, options = {}) {
  const wreckID = toPositiveInt(wreckRecord && wreckRecord.wreckID, 0);
  if (!wreckID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_WRECK_ID_REQUIRED",
    };
  }
  const scopeResolution = validateStoredEntityScopeMetadata(wreckRecord, {
    projectAirInstanceToDungeonSite: true,
  });
  if (!scopeResolution.success) {
    return {
      success: false,
      errorMsg: scopeResolution.errorMsg,
    };
  }
  return writeCollectionRow(
    TABLE.WRECKS,
    "wrecks",
    wreckID,
    {
      ...wreckRecord,
      ...scopeResolution.data.metadata,
    },
    options,
  );
}

function removeNativeWreck(wreckID) {
  return removeCollectionRow(TABLE.WRECKS, "wrecks", wreckID);
}

function listNativeWreckItems() {
  return Object.values(readCollection(TABLE.WRECK_ITEMS, "items"))
    .sort((left, right) => Number(left.wreckItemID || 0) - Number(right.wreckItemID || 0));
}

function getNativeWreckItem(wreckItemID) {
  const collection = readCollection(TABLE.WRECK_ITEMS, "items");
  return collection[String(wreckItemID)] || null;
}

function listNativeWreckItemsForWreck(wreckID) {
  const normalizedWreckID = toPositiveInt(wreckID, 0);
  return listNativeWreckItems().filter(
    (itemRecord) => toPositiveInt(itemRecord && itemRecord.wreckID, 0) === normalizedWreckID,
  );
}

function upsertNativeWreckItem(wreckItemRecord, options = {}) {
  const wreckItemID = toPositiveInt(wreckItemRecord && wreckItemRecord.wreckItemID, 0);
  if (!wreckItemID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_WRECK_ITEM_ID_REQUIRED",
    };
  }
  return writeCollectionRow(
    TABLE.WRECK_ITEMS,
    "items",
    wreckItemID,
    wreckItemRecord,
    options,
  );
}

function removeNativeWreckItem(wreckItemID) {
  return removeCollectionRow(TABLE.WRECK_ITEMS, "items", wreckItemID);
}

function removeNativeWreckCascade(wreckID) {
  const normalizedWreckID = toPositiveInt(wreckID, 0);
  if (!normalizedWreckID) {
    return {
      success: false,
      errorMsg: "NPC_NATIVE_WRECK_ID_REQUIRED",
    };
  }

  for (const itemRecord of listNativeWreckItemsForWreck(normalizedWreckID)) {
    removeNativeWreckItem(itemRecord.wreckItemID);
  }
  removeNativeWreck(normalizedWreckID);
  return {
    success: true,
    data: {
      wreckID: normalizedWreckID,
    },
  };
}

function buildNativeSlimModuleTuples(entityID) {
  return listNativeModulesForEntity(entityID)
    .map((moduleRecord) => ([
      toPositiveInt(moduleRecord && moduleRecord.moduleID, 0),
      toPositiveInt(moduleRecord && moduleRecord.typeID, 0),
      toPositiveInt(moduleRecord && moduleRecord.flagID, 0),
    ]))
    .filter((tuple) => tuple.every((value) => value > 0))
    .sort((left, right) => left[2] - right[2] || left[0] - right[0]);
}

function buildNativeFittedItems(entityID) {
  return listNativeModulesForEntity(entityID).map((moduleRecord) => ({
    itemID: toPositiveInt(moduleRecord && moduleRecord.moduleID, 0),
    ownerID: toPositiveInt(moduleRecord && moduleRecord.ownerID, 0),
    locationID: toPositiveInt(moduleRecord && moduleRecord.entityID, 0),
    flagID: toPositiveInt(moduleRecord && moduleRecord.flagID, 0),
    typeID: toPositiveInt(moduleRecord && moduleRecord.typeID, 0),
    groupID: toPositiveInt(moduleRecord && moduleRecord.groupID, 0),
    categoryID: toPositiveInt(moduleRecord && moduleRecord.categoryID, 0),
    itemName: String(moduleRecord && moduleRecord.itemName || ""),
    singleton: moduleRecord && moduleRecord.singleton === true,
    npcCapabilityTypeID: toPositiveInt(moduleRecord && moduleRecord.npcCapabilityTypeID, 0),
    moduleState: cloneValue(moduleRecord && moduleRecord.moduleState || {}),
  }));
}

function buildNativeCargoItems(entityID) {
  return listNativeCargoForEntity(entityID).map((cargoRecord) => ({
    itemID: toPositiveInt(cargoRecord && cargoRecord.cargoID, 0),
    ownerID: toPositiveInt(cargoRecord && cargoRecord.ownerID, 0),
    locationID: toPositiveInt(cargoRecord && cargoRecord.entityID, 0),
    moduleID: toPositiveInt(cargoRecord && cargoRecord.moduleID, 0),
    typeID: toPositiveInt(cargoRecord && cargoRecord.typeID, 0),
    groupID: toPositiveInt(cargoRecord && cargoRecord.groupID, 0),
    categoryID: toPositiveInt(cargoRecord && cargoRecord.categoryID, 0),
    itemName: String(cargoRecord && cargoRecord.itemName || ""),
    quantity: toPositiveInt(cargoRecord && cargoRecord.quantity, 0),
    singleton: cargoRecord && cargoRecord.singleton === true,
    flagID: toPositiveInt(cargoRecord && cargoRecord.flagID, 5),
    stacksize: cargoRecord && cargoRecord.singleton === true
      ? 1
      : toPositiveInt(cargoRecord && cargoRecord.quantity, 0),
    moduleState: cloneValue(cargoRecord && cargoRecord.moduleState || null),
  }));
}

function buildNativeWreckInventoryItem(wreckID) {
  const wreckRecord = getNativeWreck(wreckID);
  if (!wreckRecord) {
    return null;
  }

  const position = cloneValue(wreckRecord.position || { x: 0, y: 0, z: 0 });
  const velocity = cloneValue(wreckRecord.velocity || { x: 0, y: 0, z: 0 });
  const direction = cloneValue(wreckRecord.direction || { x: 1, y: 0, z: 0 });
  const targetPoint = cloneValue(wreckRecord.targetPoint || position);
  const entityScopeMetadata = buildStoredEntityScopeMetadata(wreckRecord, {
    projectAirInstanceToDungeonSite: true,
  });

  return {
    itemID: toPositiveInt(wreckRecord.wreckID, 0),
    typeID: toPositiveInt(wreckRecord.typeID, 0),
    ownerID: toPositiveInt(wreckRecord.ownerID, 0),
    locationID: toPositiveInt(wreckRecord.systemID, 0),
    flagID: 0,
    quantity: -1,
    stacksize: 1,
    singleton: 1,
    groupID: toPositiveInt(wreckRecord.groupID, 0),
    categoryID: toPositiveInt(wreckRecord.categoryID, 0),
    itemName: String(wreckRecord.itemName || "Wreck"),
    customInfo: "",
    radius: Number(wreckRecord.radius || 0),
    spaceRadius: Number(wreckRecord.radius || 0),
    capacity: Number(wreckRecord.capacity || 0),
    spaceState: {
      position,
      velocity,
      direction,
      targetPoint,
      mode: String(wreckRecord.mode || "STOP"),
      speedFraction: Number(wreckRecord.speedFraction || 0),
      ...entityScopeMetadata,
    },
    ...entityScopeMetadata,
    conditionState: cloneValue(wreckRecord.conditionState || null),
    createdAtMs: Number(wreckRecord.createdAtMs || 0) || null,
    expiresAtMs: Number(wreckRecord.expiresAtMs || 0) || null,
    launcherID: toPositiveInt(wreckRecord.launcherID, 0) || null,
    dunRotation: Array.isArray(wreckRecord.dunRotation)
      ? cloneValue(wreckRecord.dunRotation)
      : null,
    transient: wreckRecord.transient === true,
  };
}

function buildNativeWreckContents(wreckID) {
  const normalizedWreckID = toPositiveInt(wreckID, 0);
  return listNativeWreckItemsForWreck(normalizedWreckID).map((itemRecord) => ({
    itemID: toPositiveInt(itemRecord && itemRecord.wreckItemID, 0),
    typeID: toPositiveInt(itemRecord && itemRecord.typeID, 0),
    ownerID: toPositiveInt(itemRecord && itemRecord.ownerID, 0),
    locationID: normalizedWreckID,
    flagID: toPositiveInt(itemRecord && itemRecord.flagID, 5),
    quantity:
      itemRecord && itemRecord.singleton === true
        ? -1
        : toPositiveInt(itemRecord && itemRecord.quantity, 0),
    stacksize:
      itemRecord && itemRecord.singleton === true
        ? 1
        : toPositiveInt(itemRecord && itemRecord.quantity, 0),
    singleton: itemRecord && itemRecord.singleton === true ? 1 : 0,
    groupID: toPositiveInt(itemRecord && itemRecord.groupID, 0),
    categoryID: toPositiveInt(itemRecord && itemRecord.categoryID, 0),
    itemName: String(itemRecord && itemRecord.itemName || ""),
    customInfo: String(itemRecord && itemRecord.customInfo || ""),
    volume: Number(itemRecord && itemRecord.volume || 0),
    moduleState: cloneValue(itemRecord && itemRecord.moduleState || null),
  }));
}

module.exports = {
  TABLE,
  INVALID_PERSISTENT_IDENTITY,
  buildStoredEntityScopeMetadata,
  resolveStoredEntityScopeMetadata,
  validateStoredEntityScopeMetadata,
  allocateEntityID,
  allocateModuleID,
  allocateCargoID,
  allocateWreckID,
  allocateWreckItemID,
  listNativeEntities,
  listNativeEntitiesForSystem,
  getNativeEntity,
  upsertNativeEntity,
  removeNativeEntity,
  listNativeModulesForEntity,
  upsertNativeModule,
  removeNativeModule,
  listNativeCargoForEntity,
  upsertNativeCargo,
  removeNativeCargo,
  listNativeControllers,
  listNativeControllersForSystem,
  getNativeController,
  upsertNativeController,
  removeNativeController,
  removeNativeEntityCascade,
  removeNativeEntitiesCascade,
  listNativeWrecks,
  getNativeWreck,
  upsertNativeWreck,
  removeNativeWreck,
  listNativeWreckItems,
  getNativeWreckItem,
  listNativeWreckItemsForWreck,
  upsertNativeWreckItem,
  removeNativeWreckItem,
  removeNativeWreckCascade,
  buildNativeSlimModuleTuples,
  buildNativeFittedItems,
  buildNativeCargoItems,
  buildNativeWreckInventoryItem,
  buildNativeWreckContents,
};
