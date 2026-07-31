const path = require("path");
const { isDeepStrictEqual } = require("util");

const database = require(path.join(__dirname, "../../../gameStore"));
const targetIdRuntime = require(path.join(
  __dirname,
  "../signatures/targetIdRuntime",
));

const WORMHOLE_RUNTIME_TABLE = "wormholeRuntimeState";
const WORMHOLE_RUNTIME_VERSION = 5;

function normalizeVisibilityState(value, discovered = false) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "visible" || normalized === "hidden" || normalized === "invisible") {
    return normalized;
  }
  return discovered === true ? "visible" : "hidden";
}

let cache = null;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneEndpoint(endpoint = {}) {
  return {
    ...endpoint,
    position: endpoint && endpoint.position && typeof endpoint.position === "object"
      ? { ...endpoint.position }
      : endpoint.position,
    direction: endpoint && endpoint.direction && typeof endpoint.direction === "object"
      ? { ...endpoint.direction }
      : endpoint.direction,
  };
}

function cloneRuntimeState(state = {}) {
  const pairsByID = {};
  for (const [pairKey, pair] of Object.entries(state.pairsByID || {})) {
    pairsByID[pairKey] = {
      ...pair,
      source: cloneEndpoint(pair && pair.source ? pair.source : {}),
      destination: cloneEndpoint(pair && pair.destination ? pair.destination : {}),
    };
  }

  const staticSlotsByKey = {};
  for (const [slotKey, slotState] of Object.entries(state.staticSlotsByKey || {})) {
    staticSlotsByKey[slotKey] = {
      ...slotState,
    };
  }

  const polarizationByCharacter = {};
  for (const [characterKey, endpoints] of Object.entries(state.polarizationByCharacter || {})) {
    const clonedEndpoints = {};
    for (const [endpointKey, record] of Object.entries(endpoints || {})) {
      clonedEndpoints[endpointKey] = {
        ...record,
      };
    }
    polarizationByCharacter[characterKey] = clonedEndpoints;
  }

  return {
    ...state,
    pairsByID,
    staticSlotsByKey,
    polarizationByCharacter,
  };
}

function normalizeEndpoint(endpoint = {}) {
  const discovered = endpoint.discovered === true;
  const visibilityState = normalizeVisibilityState(endpoint.visibilityState, discovered);
  const endpointID = toInt(endpoint.endpointID, 0);
  const systemID = toInt(endpoint.systemID, 0);
  const targetID = String(endpoint.targetID || "").trim().toUpperCase() || (
    endpointID > 0 && systemID > 0
      ? targetIdRuntime.encodeTargetID("wormhole", systemID, endpointID)
      : null
  );
  return {
    endpointID,
    systemID,
    typeID: toInt(endpoint.typeID, 0),
    targetID,
    code: String(endpoint.code || "").trim().toUpperCase() || null,
    discovered: visibilityState === "visible",
    visibilityState,
    wormholeClassID: toInt(endpoint.wormholeClassID, 0),
    nebulaID: toInt(endpoint.nebulaID, 0),
    typeName: String(endpoint.typeName || "").trim() || null,
    position: endpoint.position && typeof endpoint.position === "object"
      ? {
          x: Number(endpoint.position.x) || 0,
          y: Number(endpoint.position.y) || 0,
          z: Number(endpoint.position.z) || 0,
        }
      : { x: 0, y: 0, z: 0 },
    direction: endpoint.direction && typeof endpoint.direction === "object"
      ? {
          x: Number(endpoint.direction.x) || 1,
          y: Number(endpoint.direction.y) || 0,
          z: Number(endpoint.direction.z) || 0,
        }
      : { x: 1, y: 0, z: 0 },
    radius: Number(endpoint.radius) || 3000,
    graphicID: toInt(endpoint.graphicID, 0),
    slotKey: String(endpoint.slotKey || "").trim() || null,
  };
}

function normalizePair(pair = {}) {
  return {
    pairID: toInt(pair.pairID, 0),
    kind: String(pair.kind || "static").trim().toLowerCase() || "static",
    randomProfileKey: String(pair.randomProfileKey || "").trim() || null,
    managedSlotKey: String(pair.managedSlotKey || "").trim() || null,
    estateConnectionRole:
      String(pair.estateConnectionRole || "").trim().toLowerCase() || null,
    persistent: pair.persistent === true,
    unlimitedMass: pair.unlimitedMass === true,
    unrestrictedShipMass: pair.unrestrictedShipMass === true,
    state: String(pair.state || "active").trim().toLowerCase() || "active",
    createdAtMs: Math.max(0, toInt(pair.createdAtMs, 0)),
    expiresAtMs: Math.max(0, toInt(pair.expiresAtMs, 0)),
    collapseAtMs: Math.max(0, toInt(pair.collapseAtMs, 0)),
    collapseReason: String(pair.collapseReason || "").trim() || null,
    totalMass: Math.max(0, toInt(pair.totalMass, 0)),
    remainingMass: Math.max(0, toInt(pair.remainingMass, 0)),
    massRegeneration: Math.max(0, toInt(pair.massRegeneration, 0)),
    maxJumpMass: Math.max(0, toInt(pair.maxJumpMass, 0)),
    lifetimeMinutes: Math.max(0, toInt(pair.lifetimeMinutes, 0)),
    lastMassStateAtMs: Math.max(
      0,
      toInt(pair.lastMassStateAtMs, pair.createdAtMs),
    ),
    massRegenRemainder: Math.max(0, Number(pair.massRegenRemainder) || 0),
    lastPassiveRevealCheckAtMs: Math.max(0, toInt(pair.lastPassiveRevealCheckAtMs, 0)),
    staticSlotKey: String(pair.staticSlotKey || "").trim() || null,
    source: normalizeEndpoint(pair.source || {}),
    destination: normalizeEndpoint(pair.destination || {}),
  };
}

function normalizeState(table = {}) {
  const nextPairSequence = Math.max(1, toInt(table.nextPairSequence, 1));
  const nextEndpointSequence = Math.max(1, toInt(table.nextEndpointSequence, 1));
  const universeSeededAtMs = Math.max(0, toInt(table.universeSeededAtMs, 0));
  const pairsByID = {};
  for (const [pairKey, pair] of Object.entries(table.pairsByID || {})) {
    const normalized = normalizePair(pair);
    if (normalized.pairID > 0) {
      pairsByID[String(normalized.pairID)] = normalized;
    } else if (toInt(pairKey, 0) > 0) {
      normalized.pairID = toInt(pairKey, 0);
      pairsByID[String(normalized.pairID)] = normalized;
    }
  }

  const staticSlotsByKey = {};
  for (const [slotKey, slotState] of Object.entries(table.staticSlotsByKey || {})) {
    const normalizedKey = String(slotKey || "").trim();
    if (!normalizedKey) {
      continue;
    }
    staticSlotsByKey[normalizedKey] = {
      slotKey: normalizedKey,
      systemID: toInt(slotState.systemID, 0),
      generation: Math.max(0, toInt(slotState.generation, 0)),
      activePairID: Math.max(0, toInt(slotState.activePairID, 0)),
      nextRespawnAtMs: Math.max(0, toInt(slotState.nextRespawnAtMs, 0)),
    };
  }

  const polarizationByCharacter = {};
  for (const [characterKey, endpoints] of Object.entries(table.polarizationByCharacter || {})) {
    const normalizedCharacterID = Math.max(0, toInt(characterKey, 0));
    if (!normalizedCharacterID) {
      continue;
    }
    const normalizedEndpoints = {};
    for (const [endpointKey, polarization] of Object.entries(endpoints || {})) {
      const endpointID = Math.max(0, toInt(endpointKey, 0));
      if (!endpointID) {
        continue;
      }
      const endAtMs = Math.max(0, toInt(polarization && polarization.endAtMs, 0));
      const durationSeconds = Math.max(
        0,
        toInt(polarization && polarization.durationSeconds, 0),
      );
      if (endAtMs > 0 && durationSeconds > 0) {
        normalizedEndpoints[String(endpointID)] = {
          endAtMs,
          durationSeconds,
        };
      }
    }
    polarizationByCharacter[String(normalizedCharacterID)] = normalizedEndpoints;
  }

  return {
    version: WORMHOLE_RUNTIME_VERSION,
    nextPairSequence,
    nextEndpointSequence,
    universeSeededAtMs,
    pairsByID,
    staticSlotsByKey,
    polarizationByCharacter,
  };
}

function loadState() {
  if (cache) {
    return cache;
  }

  const result = database.read(WORMHOLE_RUNTIME_TABLE, "/");
  cache = normalizeState(result && result.success ? result.data : {});
  return cache;
}

function getStateView() {
  return loadState();
}

// pairsByID / staticSlotsByKey / polarizationByCharacter are wrapper groups
// (one stored row per entity); everything else is a flat scalar row.
const WORMHOLE_GROUP_KEYS = ["pairsByID", "staticSlotsByKey", "polarizationByCharacter"];

// Persist a state by diffing it against the live persisted table and writing
// ONLY the rows that changed (per group entity + per scalar) instead of a
// whole-table root write, so the gameStore dirty-row flush re-serializes only
// the changed rows. The on-disk/cache result is identical to the old root write.
function applyPersistedDiff(nextState) {
  const currentResult = database.read(WORMHOLE_RUNTIME_TABLE, "/");
  const current =
    currentResult && currentResult.success && currentResult.data && typeof currentResult.data === "object"
      ? currentResult.data
      : {};

  const writes = [];
  const removes = [];
  const groupKeys = new Set(WORMHOLE_GROUP_KEYS);

  for (const group of WORMHOLE_GROUP_KEYS) {
    const prevGroup = current[group] && typeof current[group] === "object" ? current[group] : {};
    const nextGroup = nextState[group] && typeof nextState[group] === "object" ? nextState[group] : {};
    for (const entityID of Object.keys(nextGroup)) {
      if (!isDeepStrictEqual(prevGroup[entityID], nextGroup[entityID])) {
        writes.push([`/${group}/${entityID}`, nextGroup[entityID]]);
      }
    }
    for (const entityID of Object.keys(prevGroup)) {
      if (!Object.prototype.hasOwnProperty.call(nextGroup, entityID)) {
        removes.push(`/${group}/${entityID}`);
      }
    }
    // Ensure the group container exists even when empty, so the skeleton row
    // matches what a whole-table write would have produced.
    if (
      Object.prototype.hasOwnProperty.call(nextState, group) &&
      !(current[group] && typeof current[group] === "object") &&
      writes.every(([suffix]) => !suffix.startsWith(`/${group}/`))
    ) {
      writes.push([`/${group}`, {}]);
    }
  }

  for (const key of Object.keys(nextState)) {
    if (groupKeys.has(key)) {
      continue;
    }
    if (!isDeepStrictEqual(current[key], nextState[key])) {
      writes.push([`/${key}`, nextState[key]]);
    }
  }
  for (const key of Object.keys(current)) {
    if (groupKeys.has(key)) {
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(nextState, key)) {
      removes.push(`/${key}`);
    }
  }

  let success = true;
  for (const [pathSuffix, value] of writes) {
    const result = database.write(WORMHOLE_RUNTIME_TABLE, pathSuffix, value);
    if (!result || result.success !== true) {
      success = false;
    }
  }
  for (const pathSuffix of removes) {
    const result = database.remove(WORMHOLE_RUNTIME_TABLE, pathSuffix);
    if (!(result && (result.success === true || result.errorMsg === "ENTRY_NOT_FOUND"))) {
      success = false;
    }
  }
  return { changed: writes.length + removes.length, success };
}

function writeState(state, options = {}) {
  const normalized = options.normalize === false
    ? state
    : normalizeState(state);
  // force is now moot — an unchanged diff simply writes nothing (the persisted
  // result is identical either way); kept in the signature for callers.
  const result = applyPersistedDiff(normalized);
  if (!result.success) {
    return false;
  }
  cache = normalized;
  return true;
}

function mutateState(mutator) {
  const current = cloneRuntimeState(loadState());
  const next = mutator(current) || current;
  const success = writeState(next, {
    force: true,
    normalize: false,
  });
  return {
    success,
    data: success ? cache : loadState(),
  };
}

function getStateSnapshot() {
  return cloneRuntimeState(loadState());
}

function clearRuntimeCache() {
  cache = null;
}

module.exports = {
  WORMHOLE_RUNTIME_TABLE,
  clearRuntimeCache,
  getStateSnapshot,
  getStateView,
  loadState,
  mutateState,
  writeState,
};
