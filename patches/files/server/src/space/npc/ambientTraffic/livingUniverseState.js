"use strict";

const path = require("path");
const { isDeepStrictEqual } = require("util");

const database = require(path.join(__dirname, "../../../gameStore"));

const TABLE_NAME = "npcRuntimeState";
const ROOT_PATH = "/livingUniverse";
const SCHEMA_VERSION = 1;
const STORAGE_SCHEMA_VERSION = 2;
const ROW_KEY_SEPARATOR = "\u001f";

const V2_PATHS = Object.freeze({
  manifest: "/livingUniverseStorageV2",
  meta: "/livingUniverseMetaV2",
  roaming: "/livingUniverseRoamingV2",
  actors: "/livingUniverseActorsV2",
  flights: "/livingUniverseFlightsV2",
  encounters: "/livingUniverseEncountersV2",
});

const COLLECTION_SPECS = Object.freeze([
  Object.freeze({
    stateKey: "actors",
    path: V2_PATHS.actors,
    idField: "actorID",
    countField: "actorCount",
    dirtyOption: "dirtyActorIDs",
    removedOption: "removedActorIDs",
  }),
  Object.freeze({
    stateKey: "flights",
    path: V2_PATHS.flights,
    idField: "flightID",
    countField: "flightCount",
    dirtyOption: "dirtyFlightIDs",
    removedOption: "removedFlightIDs",
  }),
  Object.freeze({
    stateKey: "encounters",
    path: V2_PATHS.encounters,
    idField: "encounterID",
    countField: "encounterCount",
    dirtyOption: "dirtyEncounterIDs",
    removedOption: "removedEncounterIDs",
  }),
]);

const UNSAFE_ENTITY_KEYS = new Set(["__proto__", "prototype", "constructor"]);
let nextBatchSequence = 1;
let lastPersistenceStatus = {
  storageSchemaVersion: STORAGE_SCHEMA_VERSION,
  source: "uninitialized",
  lastBatchToken: null,
  lastGeneration: 0,
  lastSnapshotUpdatedAtMs: 0,
  lastWriteStats: null,
  lastError: null,
};

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function buildDefaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    populationRevision: 1,
    populationSize: 0,
    createdAtMs: 0,
    updatedAtMs: 0,
    nextEncounterNumber: 1,
    nextConflictAtMs: 0,
    roamingConflict: null,
    pendingRoamingContacts: [],
    actors: {},
    flights: {},
    encounters: {},
    metrics: {
      materializations: 0,
      virtualTransitions: 0,
      physicalGateJumps: 0,
      completedTrips: 0,
      shipLosses: 0,
      conflictShipLosses: 0,
      physicalShipLosses: 0,
      playerCreditedConflictLosses: 0,
      playerCreditedPhysicalLosses: 0,
      shipLossesByType: {},
      shipLossesByRole: {},
      shipLossesByFaction: {},
      replacements: 0,
      encountersScheduled: 0,
      encountersObserved: 0,
      encountersResolved: 0,
      encountersResolvedOffGrid: 0,
      wreckEvidenceMaterialized: 0,
      distressSignalsActivated: 0,
      responsesDispatched: 0,
      responsesArrived: 0,
      responsesUnavailable: 0,
      roamingContactsScheduled: 0,
      roamingContactsRejected: 0,
      roamingContactsExpired: 0,
      roamingContactsDeferred: 0,
      roamingTransitionsProcessed: 0,
    },
  };
}

function normalizeState(rawState) {
  const defaults = buildDefaultState();
  const raw = isRecord(rawState) ? cloneValue(rawState) : {};
  return {
    ...defaults,
    ...raw,
    schemaVersion: SCHEMA_VERSION,
    roamingConflict: isRecord(raw.roamingConflict)
      ? raw.roamingConflict
      : null,
    pendingRoamingContacts: Array.isArray(raw.pendingRoamingContacts)
      ? raw.pendingRoamingContacts
      : [],
    actors: isRecord(raw.actors) ? raw.actors : {},
    flights: isRecord(raw.flights) ? raw.flights : {},
    encounters: isRecord(raw.encounters) ? raw.encounters : {},
    nextEncounterNumber: Math.max(
      1,
      Math.trunc(Number(raw.nextEncounterNumber) || 1),
    ),
    nextConflictAtMs: Math.max(0, Number(raw.nextConflictAtMs) || 0),
    metrics: {
      ...defaults.metrics,
      ...(isRecord(raw.metrics) ? raw.metrics : {}),
    },
  };
}

function buildMetaV2(state) {
  const meta = {
    ...buildDefaultState(),
    ...(isRecord(state) ? state : {}),
    schemaVersion: SCHEMA_VERSION,
  };
  delete meta.roamingConflict;
  delete meta.pendingRoamingContacts;
  delete meta.actors;
  delete meta.flights;
  delete meta.encounters;
  return cloneValue(meta);
}

function buildRoamingV2(state) {
  const source = isRecord(state) ? state : {};
  return {
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    roamingConflict: isRecord(source.roamingConflict)
      ? cloneValue(source.roamingConflict)
      : null,
    pendingRoamingContacts: Array.isArray(source.pendingRoamingContacts)
      ? cloneValue(source.pendingRoamingContacts)
      : [],
  };
}

function readPath(pathArg) {
  const result = database.read(TABLE_NAME, pathArg);
  return {
    exists: Boolean(result && result.success === true),
    errorMsg: result && result.errorMsg || null,
    data: result && result.success === true ? result.data : null,
  };
}

function readLegacySnapshot() {
  const result = readPath(ROOT_PATH);
  const exists = result.exists && isRecord(result.data);
  return {
    exists,
    raw: exists ? result.data : null,
    updatedAtMs: exists ? Math.max(0, Number(result.data.updatedAtMs) || 0) : 0,
  };
}

function readV2Components() {
  const manifest = readPath(V2_PATHS.manifest);
  const meta = readPath(V2_PATHS.meta);
  const roaming = readPath(V2_PATHS.roaming);
  const components = {
    manifest: manifest.exists && isRecord(manifest.data) ? manifest.data : null,
    meta: meta.exists && isRecord(meta.data) ? meta.data : null,
    roaming: roaming.exists && isRecord(roaming.data) ? roaming.data : null,
    groups: {},
    readErrors: [],
  };
  for (const [label, result] of [
    ["manifest", manifest],
    ["meta", meta],
    ["roaming", roaming],
  ]) {
    if (
      !result.exists &&
      result.errorMsg &&
      !["ENTRY_NOT_FOUND", "TABLE_NOT_FOUND"].includes(result.errorMsg)
    ) {
      components.readErrors.push({ path: label, errorMsg: result.errorMsg });
    }
  }
  for (const spec of COLLECTION_SPECS) {
    const result = readPath(spec.path);
    components.groups[spec.stateKey] = result.exists && isRecord(result.data)
      ? result.data
      : {};
    if (result.exists && !isRecord(result.data)) {
      components.readErrors.push({
        path: spec.stateKey,
        errorMsg: "INVALID_ROW_SHAPE",
      });
    }
    if (
      !result.exists &&
      result.errorMsg &&
      !["ENTRY_NOT_FOUND", "TABLE_NOT_FOUND"].includes(result.errorMsg)
    ) {
      components.readErrors.push({
        path: spec.stateKey,
        errorMsg: result.errorMsg,
      });
    }
  }
  return components;
}

function validateEntityKey(entityKey) {
  const normalized = String(entityKey == null ? "" : entityKey);
  if (
    normalized.length === 0 ||
    normalized.includes("/") ||
    normalized.includes(ROW_KEY_SEPARATOR) ||
    UNSAFE_ENTITY_KEYS.has(normalized)
  ) {
    const error = new Error(
      `Living Universe persistence entity key is unsafe: ${JSON.stringify(normalized)}`,
    );
    error.code = "LIVING_UNIVERSE_STORAGE_ENTITY_KEY_INVALID";
    error.entityKey = normalized;
    throw error;
  }
  return normalized;
}

function validateCollection(collection, spec) {
  if (!isRecord(collection)) {
    return {
      valid: false,
      reason: `${spec.stateKey} is not an object`,
    };
  }
  for (const [entityKey, record] of Object.entries(collection)) {
    try {
      validateEntityKey(entityKey);
    } catch (error) {
      return { valid: false, reason: error.code, error };
    }
    if (
      !isRecord(record) ||
      String(record[spec.idField] == null ? "" : record[spec.idField]) !== entityKey
    ) {
      return {
        valid: false,
        reason: `${spec.stateKey}.${entityKey} does not match ${spec.idField}`,
      };
    }
  }
  return { valid: true };
}

function validateV2Components(components, options = {}) {
  if (!components || !isRecord(components)) {
    return { valid: false, reason: "components missing" };
  }
  if (components.readErrors && components.readErrors.length > 0) {
    return { valid: false, reason: "component read failed" };
  }
  const manifest = components.manifest;
  if (
    !isRecord(manifest) ||
    manifest.storageSchemaVersion !== STORAGE_SCHEMA_VERSION ||
    manifest.status !== "complete"
  ) {
    return { valid: false, reason: "manifest incomplete" };
  }
  if (!isRecord(components.meta) || !isRecord(components.roaming)) {
    return { valid: false, reason: "metadata rows missing" };
  }
  if (
    !Number.isSafeInteger(manifest.snapshotUpdatedAtMs) ||
    manifest.snapshotUpdatedAtMs < 0 ||
    Math.max(0, Number(components.meta.updatedAtMs) || 0) !==
      manifest.snapshotUpdatedAtMs
  ) {
    return { valid: false, reason: "snapshot timestamp mismatch" };
  }
  for (const spec of COLLECTION_SPECS) {
    const collection = components.groups && components.groups[spec.stateKey];
    const expectedCount = manifest[spec.countField];
    if (
      !Number.isSafeInteger(expectedCount) ||
      expectedCount < 0 ||
      !isRecord(collection) ||
      Object.keys(collection).length !== expectedCount
    ) {
      return {
        valid: false,
        reason: `${spec.stateKey} count mismatch`,
      };
    }
    if (options.validateRecords !== false) {
      const collectionValidation = validateCollection(collection, spec);
      if (!collectionValidation.valid) return collectionValidation;
    }
  }
  return { valid: true };
}

function assembleV2State(components) {
  return normalizeState({
    ...components.meta,
    roamingConflict: components.roaming.roamingConflict,
    pendingRoamingContacts: components.roaming.pendingRoamingContacts,
    actors: components.groups.actors,
    flights: components.groups.flights,
    encounters: components.groups.encounters,
  });
}

function inspectV2Snapshot(options = {}) {
  const components = readV2Components();
  const validation = validateV2Components(components, {
    validateRecords: options.validateRecords,
  });
  return {
    ...validation,
    components,
    manifest: components.manifest,
    state:
      validation.valid && options.includeState !== false
        ? assembleV2State(components)
        : null,
  };
}

function readState() {
  const legacy = readLegacySnapshot();
  const v2 = inspectV2Snapshot({ includeState: false });
  if (
    v2.valid &&
    (!legacy.exists || legacy.updatedAtMs <= v2.manifest.snapshotUpdatedAtMs)
  ) {
    lastPersistenceStatus = {
      ...lastPersistenceStatus,
      source: "v2",
      lastBatchToken: v2.manifest.batchToken || null,
      lastGeneration: Math.max(0, Number(v2.manifest.generation) || 0),
      lastSnapshotUpdatedAtMs: v2.manifest.snapshotUpdatedAtMs,
      lastError: null,
    };
    return assembleV2State(v2.components);
  }
  lastPersistenceStatus = {
    ...lastPersistenceStatus,
    source: legacy.exists ? "legacy" : "default",
    lastSnapshotUpdatedAtMs: legacy.updatedAtMs,
    lastError: v2.valid ? null : v2.reason,
  };
  return legacy.exists ? normalizeState(legacy.raw) : buildDefaultState();
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeIDIterable(value, optionName) {
  if (value === undefined || value === null) return new Set();
  let values;
  if (typeof value === "string" || typeof value === "number") {
    values = [value];
  } else if (typeof value[Symbol.iterator] === "function") {
    values = [...value];
  } else {
    const error = new Error(`${optionName} must be an iterable of entity IDs`);
    error.code = "LIVING_UNIVERSE_STORAGE_DIRTY_IDS_INVALID";
    throw error;
  }
  return new Set(values.map(validateEntityKey));
}

function makeWriteStats(fullRewrite) {
  const collections = {};
  for (const spec of COLLECTION_SPECS) {
    collections[spec.stateKey] = {
      upserts: 0,
      removals: 0,
      unchanged: 0,
    };
  }
  return {
    fullRewrite,
    manifestWrites: 0,
    metaWrites: 0,
    roamingWrites: 0,
    collections,
    totalWrites: 0,
    totalRemovals: 0,
  };
}

function requireSuccessfulWrite(result, pathArg) {
  if (!result || result.success !== true) {
    const error = new Error(
      `Living Universe persistence write failed at ${pathArg}: ` +
        `${result && result.errorMsg || "WRITE_FAILED"}`,
    );
    error.code = result && result.errorMsg || "LIVING_UNIVERSE_STORAGE_WRITE_FAILED";
    error.path = pathArg;
    throw error;
  }
  return result;
}

function writeValueIfChanged(pathArg, currentValue, nextValue, statsKey, stats) {
  if (isDeepStrictEqual(currentValue, nextValue)) return false;
  requireSuccessfulWrite(
    database.write(TABLE_NAME, pathArg, cloneValue(nextValue)),
    pathArg,
  );
  stats[statsKey] += 1;
  stats.totalWrites += 1;
  return true;
}

function removeEntityIfPresent(spec, collection, entityID, stats) {
  if (!Object.prototype.hasOwnProperty.call(collection, entityID)) return false;
  const entityPath = `${spec.path}/${entityID}`;
  const result = database.remove(TABLE_NAME, entityPath);
  if (
    !result ||
    (result.success !== true && result.errorMsg !== "ENTRY_NOT_FOUND")
  ) {
    requireSuccessfulWrite(result, entityPath);
  }
  stats.collections[spec.stateKey].removals += 1;
  stats.totalRemovals += 1;
  return true;
}

function upsertEntityIfChanged(spec, collection, entityID, record, stats) {
  if (
    Object.prototype.hasOwnProperty.call(collection, entityID) &&
    isDeepStrictEqual(collection[entityID], record)
  ) {
    stats.collections[spec.stateKey].unchanged += 1;
    return false;
  }
  const entityPath = `${spec.path}/${entityID}`;
  requireSuccessfulWrite(
    database.write(TABLE_NAME, entityPath, cloneValue(record)),
    entityPath,
  );
  stats.collections[spec.stateKey].upserts += 1;
  stats.totalWrites += 1;
  return true;
}

function prevalidateWrite(source, writePlan) {
  for (const spec of COLLECTION_SPECS) {
    const sourceCollection = source[spec.stateKey];
    if (!isRecord(sourceCollection)) {
      const error = new Error(
        `Living Universe ${spec.stateKey} collection must be an object`,
      );
      error.code = "LIVING_UNIVERSE_STORAGE_COLLECTION_INVALID";
      error.collection = spec.stateKey;
      throw error;
    }
    const ids = writePlan.fullRewrite
      ? Object.keys(sourceCollection)
      : [...writePlan.dirty[spec.stateKey]];
    for (const entityID of ids) {
      const normalizedID = validateEntityKey(entityID);
      if (!Object.prototype.hasOwnProperty.call(sourceCollection, normalizedID)) {
        continue;
      }
      const record = sourceCollection[normalizedID];
      if (
        !isRecord(record) ||
        String(record[spec.idField] == null ? "" : record[spec.idField]) !==
          normalizedID
      ) {
        const error = new Error(
          `Living Universe ${spec.stateKey}.${normalizedID} does not match ` +
            spec.idField,
        );
        error.code = "LIVING_UNIVERSE_STORAGE_RECORD_ID_MISMATCH";
        error.collection = spec.stateKey;
        error.entityID = normalizedID;
        throw error;
      }
    }
    for (const entityID of writePlan.removed[spec.stateKey]) {
      validateEntityKey(entityID);
    }
  }
}

function buildWritePlan(state, options, currentV2, legacy) {
  const deltaOptionNames = COLLECTION_SPECS.flatMap((spec) => [
    spec.dirtyOption,
    spec.removedOption,
  ]);
  const deltaOptionsPresent =
    hasOwn(options, "fullRewrite") ||
    deltaOptionNames.some((optionName) => hasOwn(options, optionName));
  const legacyIsNewer = Boolean(
    currentV2.valid &&
    legacy.exists &&
    legacy.updatedAtMs > currentV2.manifest.snapshotUpdatedAtMs,
  );
  const fullRewrite =
    options.fullRewrite === true ||
    !deltaOptionsPresent ||
    !currentV2.valid ||
    legacyIsNewer;
  const dirty = {};
  const removed = {};
  for (const spec of COLLECTION_SPECS) {
    dirty[spec.stateKey] = normalizeIDIterable(
      options[spec.dirtyOption],
      spec.dirtyOption,
    );
    removed[spec.stateKey] = normalizeIDIterable(
      options[spec.removedOption],
      spec.removedOption,
    );
  }
  if (options.reconcileEncounterRows === true) {
    const sourceEncounters = isRecord(state && state.encounters)
      ? state.encounters
      : {};
    const currentEncounters = currentV2.components &&
      currentV2.components.groups &&
      isRecord(currentV2.components.groups.encounters)
      ? currentV2.components.groups.encounters
      : {};
    for (const encounterID of Object.keys(currentEncounters)) {
      if (!Object.prototype.hasOwnProperty.call(sourceEncounters, encounterID)) {
        removed.encounters.add(validateEntityKey(encounterID));
      }
    }
  }
  const plan = {
    source: isRecord(state) ? state : buildDefaultState(),
    fullRewrite,
    dirty,
    removed,
    metaDirty: fullRewrite || options.metaDirty !== false,
    roamingDirty: fullRewrite || options.roamingDirty !== false,
    migration: !currentV2.valid || legacyIsNewer,
  };
  prevalidateWrite(plan.source, plan);
  return plan;
}

function writeState(state, options = {}) {
  const legacy = readLegacySnapshot();
  const currentV2 = inspectV2Snapshot({
    includeState: false,
    validateRecords: false,
  });
  let plan;
  try {
    plan = buildWritePlan(state, options, currentV2, legacy);
  } catch (error) {
    return {
      success: false,
      errorMsg: error.code || "LIVING_UNIVERSE_STORAGE_PLAN_FAILED",
      error,
    };
  }

  const stats = makeWriteStats(plan.fullRewrite);
  const previousManifest = currentV2.components.manifest;
  const generation = Math.max(
    0,
    Math.trunc(Number(previousManifest && previousManifest.generation) || 0),
  ) + 1;
  const snapshotUpdatedAtMs = Math.max(
    0,
    Math.trunc(Number(plan.source.updatedAtMs) || 0),
  );
  const batchToken =
    `LUV2-${snapshotUpdatedAtMs}-${generation}-${nextBatchSequence++}`;
  const buildingManifest = {
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    stateSchemaVersion: SCHEMA_VERSION,
    status: "building",
    generation,
    batchToken,
    snapshotUpdatedAtMs,
    actorCount: 0,
    flightCount: 0,
    encounterCount: 0,
    writtenAtMs: Date.now(),
  };

  try {
    requireSuccessfulWrite(
      database.write(
        TABLE_NAME,
        V2_PATHS.manifest,
        buildingManifest,
        { force: true },
      ),
      V2_PATHS.manifest,
    );
    stats.manifestWrites += 1;
    stats.totalWrites += 1;

    for (const spec of COLLECTION_SPECS) {
      const sourceCollection = plan.source[spec.stateKey];
      const currentCollection =
        currentV2.components.groups[spec.stateKey] || {};
      const removedIDs = plan.removed[spec.stateKey];
      const dirtyIDs = plan.fullRewrite
        ? new Set(Object.keys(sourceCollection))
        : plan.dirty[spec.stateKey];

      if (plan.fullRewrite) {
        for (const entityID of Object.keys(currentCollection)) {
          if (!Object.prototype.hasOwnProperty.call(sourceCollection, entityID)) {
            removeEntityIfPresent(
              spec,
              currentCollection,
              entityID,
              stats,
            );
          }
        }
      }

      for (const entityID of dirtyIDs) {
        if (removedIDs.has(entityID)) continue;
        if (!Object.prototype.hasOwnProperty.call(sourceCollection, entityID)) {
          removeEntityIfPresent(
            spec,
            currentCollection,
            entityID,
            stats,
          );
          continue;
        }
        upsertEntityIfChanged(
          spec,
          currentCollection,
          entityID,
          sourceCollection[entityID],
          stats,
        );
      }

      for (const entityID of removedIDs) {
        removeEntityIfPresent(
          spec,
          currentCollection,
          entityID,
          stats,
        );
      }
    }

    const nextMeta = plan.metaDirty
      ? buildMetaV2(plan.source)
      : currentV2.components.meta || buildMetaV2(plan.source);
    const nextRoaming = plan.roamingDirty
      ? buildRoamingV2(plan.source)
      : currentV2.components.roaming || buildRoamingV2(plan.source);
    writeValueIfChanged(
      V2_PATHS.meta,
      currentV2.components.meta,
      nextMeta,
      "metaWrites",
      stats,
    );
    writeValueIfChanged(
      V2_PATHS.roaming,
      currentV2.components.roaming,
      nextRoaming,
      "roamingWrites",
      stats,
    );

    const staged = readV2Components();
    if (plan.fullRewrite || plan.migration) {
      for (const spec of COLLECTION_SPECS) {
        const validation = validateCollection(
          staged.groups[spec.stateKey],
          spec,
        );
        if (!validation.valid) {
          const error = new Error(validation.reason);
          error.code = "LIVING_UNIVERSE_STORAGE_STAGED_COLLECTION_INVALID";
          throw error;
        }
      }
    }
    const stagedUpdatedAtMs = Math.max(
      0,
      Math.trunc(Number(staged.meta && staged.meta.updatedAtMs) || 0),
    );
    const completeManifest = {
      ...buildingManifest,
      status: "complete",
      snapshotUpdatedAtMs: stagedUpdatedAtMs,
      actorCount: Object.keys(staged.groups.actors).length,
      flightCount: Object.keys(staged.groups.flights).length,
      encounterCount: Object.keys(staged.groups.encounters).length,
      completedAtMs: Date.now(),
    };
    requireSuccessfulWrite(
      database.write(
        TABLE_NAME,
        V2_PATHS.manifest,
        completeManifest,
        { force: true },
      ),
      V2_PATHS.manifest,
    );
    stats.manifestWrites += 1;
    stats.totalWrites += 1;

    const completed = inspectV2Snapshot({
      includeState: false,
      validateRecords: false,
    });
    if (!completed.valid) {
      const error = new Error(
        `Living Universe V2 snapshot failed validation: ${completed.reason}`,
      );
      error.code = "LIVING_UNIVERSE_STORAGE_SNAPSHOT_INVALID";
      throw error;
    }

    lastPersistenceStatus = {
      ...lastPersistenceStatus,
      source: plan.migration ? "v2-migration-staged" : "v2-delta-staged",
      lastBatchToken: batchToken,
      lastGeneration: generation,
      lastSnapshotUpdatedAtMs: completeManifest.snapshotUpdatedAtMs,
      lastWriteStats: cloneValue(stats),
      lastError: null,
    };
    return {
      success: true,
      errorMsg: null,
      storage: "v2",
      migration: plan.migration,
      fullRewrite: plan.fullRewrite,
      batchToken,
      generation,
      snapshotUpdatedAtMs: completeManifest.snapshotUpdatedAtMs,
      stats,
    };
  } catch (error) {
    lastPersistenceStatus = {
      ...lastPersistenceStatus,
      source: "v2-write-failed",
      lastBatchToken: batchToken,
      lastGeneration: generation,
      lastSnapshotUpdatedAtMs: snapshotUpdatedAtMs,
      lastWriteStats: cloneValue(stats),
      lastError: error.code || error.message || "LIVING_UNIVERSE_STORAGE_WRITE_FAILED",
    };
    return {
      success: false,
      errorMsg: error.code || "LIVING_UNIVERSE_STORAGE_WRITE_FAILED",
      error,
      storage: "v2",
      migration: plan.migration,
      fullRewrite: plan.fullRewrite,
      batchToken,
      generation,
      stats,
    };
  }
}

function getPersistenceStatus() {
  return cloneValue(lastPersistenceStatus);
}

function flushDurably() {
  const result = database.flushTableSync(TABLE_NAME);
  if (result && result.success === true) {
    lastPersistenceStatus = {
      ...lastPersistenceStatus,
      source: String(lastPersistenceStatus.source || "").replace("-staged", "-durable"),
      lastError: null,
    };
  } else {
    lastPersistenceStatus = {
      ...lastPersistenceStatus,
      lastError: result && result.errorMsg || "LIVING_UNIVERSE_STORAGE_FLUSH_FAILED",
    };
  }
  return result;
}

function suspendPersistence(reason) {
  return database.suspendTableFlush(TABLE_NAME, reason);
}

function removeState() {
  const components = readV2Components();
  const stats = {
    removedRows: 0,
    missingRows: 0,
  };
  const removePath = (pathArg) => {
    const result = database.remove(TABLE_NAME, pathArg);
    if (result && result.success === true) {
      stats.removedRows += 1;
      return;
    }
    if (result && ["ENTRY_NOT_FOUND", "TABLE_NOT_FOUND"].includes(result.errorMsg)) {
      stats.missingRows += 1;
      return;
    }
    requireSuccessfulWrite(result, pathArg);
  };
  try {
    // Invalidate V2 first so an interrupted explicit removal can only fall back
    // to the untouched legacy image.
    removePath(V2_PATHS.manifest);
    for (const spec of COLLECTION_SPECS) {
      for (const entityID of Object.keys(components.groups[spec.stateKey] || {})) {
        removePath(`${spec.path}/${validateEntityKey(entityID)}`);
      }
    }
    removePath(V2_PATHS.meta);
    removePath(V2_PATHS.roaming);
    removePath(ROOT_PATH);
    return { success: true, errorMsg: null, stats };
  } catch (error) {
    return {
      success: false,
      errorMsg: error.code || "LIVING_UNIVERSE_STORAGE_REMOVE_FAILED",
      error,
      stats,
    };
  }
}

module.exports = {
  SCHEMA_VERSION,
  STORAGE_SCHEMA_VERSION,
  buildDefaultState,
  flushDurably,
  getPersistenceStatus,
  readState,
  removeState,
  suspendPersistence,
  writeState,
  _testing: {
    COLLECTION_SPECS,
    V2_PATHS,
    assembleV2State,
    buildMetaV2,
    buildRoamingV2,
    buildWritePlan,
    inspectV2Snapshot,
    normalizeIDIterable,
    normalizeState,
    readLegacySnapshot,
    readV2Components,
    validateCollection,
    validateEntityKey,
    validateV2Components,
  },
};
