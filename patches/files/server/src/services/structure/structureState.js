const path = require("path");

// Memoized resolver for lazy (circular-dependency-safe) requires that run on the
// structure tick path. require(path.join(__dirname, id)) costs ~1.8us/call even
// when cached (path rebuild + resolver lookup); caching the resolved reference
// drops it to a ~4ns Map lookup. Safe because the targets assign module.exports
// once at load (or mutate it in place), so the cached reference never goes stale.
const _lazyModuleCache = new Map();
function lazyRequire(relativeId) {
  let resolved = _lazyModuleCache.get(relativeId);
  if (resolved === undefined) {
    resolved = require(path.join(__dirname, relativeId));
    _lazyModuleCache.set(relativeId, resolved);
  }
  return resolved;
}

const config = require(path.join(__dirname, "../../config"));
const database = require(path.join(__dirname, "../../gameStore"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { TABLE, readStaticRows } = require(path.join(
  __dirname,
  "../_shared/referenceData",
));
const { resolveItemByTypeID } = require(path.join(
  __dirname,
  "../inventory/itemTypeRegistry",
));
const {
  listContainerItems,
  removeInventoryItem,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const { resolveShipByTypeID } = require(path.join(
  __dirname,
  "../chat/shipTypeRegistry",
));
const { getTypeAttributeValue } = require(path.join(
  __dirname,
  "../fitting/liveFittingState",
));
const { normalizeRoleValue } = require(path.join(
  __dirname,
  "../account/accountRoleProfiles",
));
const structureAssetSafetyState = require(path.join(
  __dirname,
  "./structureAssetSafetyState",
));
const structureDockedRecoveryState = require(path.join(
  __dirname,
  "./structureDockedRecoveryState",
));
const structureDestructionLootState = require(path.join(
  __dirname,
  "./structureDestructionLootState",
));
const structureFlexFuelRuntime = require(path.join(
  __dirname,
  "./structureFlexFuelRuntime",
));
const structureAutoMoonFuelRuntime = require(path.join(
  __dirname,
  "./structureAutoMoonFuelRuntime",
));
const {
  getAllianceOwnerRecord,
  getCharacterIDsInCorporation,
  getCorporationOwnerRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  NOTIFICATION_GROUP,
  NOTIFICATION_TYPE,
} = require(path.join(__dirname, "../notifications/notificationConstants"));
const {
  createNotification,
} = require(path.join(__dirname, "../notifications/notificationState"));
const {
  resolveStructureEffectiveHitpoints,
} = require(path.join(__dirname, "./structureFullPowerDogma"));
const {
  cancelIndustryJobsForStructureLifecycle,
  syncIndustryJobsForServiceStateTransition,
} = require(path.join(__dirname, "./structureIndustryJobs"));
const {
  MANAGED_SERVICE_IDS,
  SERVICE_IDS_BY_MODULE_TYPE_ID,
  isStructureServiceModuleType,
} = require(path.join(__dirname, "./structureServiceAuthority"));
const {
  STRUCTURE_STATE,
  STRUCTURE_STATE_NAME_BY_ID,
  STRUCTURE_STATE_ID_BY_NAME,
  STRUCTURE_DISABLED_STATES,
  STRUCTURE_TETHER_ENABLED_STATES,
  STRUCTURE_VULNERABLE_STATES,
  STRUCTURE_UPKEEP_STATE,
  STRUCTURE_UPKEEP_NAME_BY_ID,
  STRUCTURE_UPKEEP_ID_BY_NAME,
  STRUCTURE_SERVICE_ID,
  STRUCTURE_SERVICE_STATE,
  STRUCTURE_SIZE,
  STRUCTURE_FAMILY,
  STRUCTURE_GROUP_ID,
  STRUCTURE_TIMER_SECONDS,
  STRUCTURE_UNANCHOR_CANCEL_STATES,
  STRUCTURE_REPAIR_SECONDS_BY_STATE,
  DEFAULT_REINFORCE_WEEKDAY,
  DEFAULT_REINFORCE_HOUR,
  DEFAULT_STRUCTURE_RADIUS,
  DEFAULT_STRUCTURE_TETHER_RANGE,
  NEXT_STRUCTURE_ID_START,
  NEXT_ASSET_WRAP_ID_START,
  STRUCTURE_TYPE_PRESETS,
  TATARA_EXCLUDED_DOCK_GROUP_NAMES,
  ONE_WAY_UNDOCK_TYPE_IDS,
  getAllowedServicesForStructureType,
} = require(path.join(__dirname, "./structureConstants"));

const STRUCTURE_TYPES_TABLE = "structureTypes";
const STRUCTURES_TABLE = "structures";
const STRUCTURE_ASSET_SAFETY_TABLE = "structureAssetSafety";
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const TYPE_CORPORATION = 2;
const TYPE_ALLIANCE = 16159;
const ONLINE_BY_DEFAULT = new Set([
  STRUCTURE_SERVICE_ID.DOCKING,
  STRUCTURE_SERVICE_ID.FITTING,
  STRUCTURE_SERVICE_ID.OFFICES,
  STRUCTURE_SERVICE_ID.REPAIR,
  STRUCTURE_SERVICE_ID.INSURANCE,
]);
const STRUCTURE_SERVICE_SLOT_FLAGS = Object.freeze([164, 165, 166, 167, 168, 169, 170, 171]);
const ABANDONING_TIME_MIN_MS = 604800 * 1000;
const ABANDONING_TIME_MAX_MS = 691200 * 1000;
const ABANDONED_ADVANCE_WARNING_MS = 259200 * 1000;
const ABANDONED_WARNING_DAY_MS = 86400 * 1000;
const TYPES_THAT_NEVER_GO_ABANDONED = Object.freeze(new Set([
  47512, // typeCitadelMoreauFortizar
  47513, // typeCitadelDraccousFortizar
  47514, // typeCitadelHorizonFortizar
  47515, // typeCitadelMarginisFortizar
  47516, // typeCitadelPrometheusFortizar
]));
const GM_BYPASS_ROLE_MASK = normalizeRoleValue("1600953932865792", 0n);
const REQUIRED_NON_CATEGORY_STRUCTURE_TYPE_IDS = Object.freeze([
  32226,
  32458,
  46363,
  46364,
  81080,
  84294,
  85230,
  85980,
  87227,
]);
const MANAGED_SERVICE_MODULE_TYPE_IDS_BY_SERVICE_ID = Object.freeze(
  Object.entries(SERVICE_IDS_BY_MODULE_TYPE_ID).reduce((accumulator, [typeID, serviceIDs]) => {
    for (const serviceID of serviceIDs || []) {
      const key = String(serviceID);
      if (!accumulator[key]) {
        accumulator[key] = [];
      }
      accumulator[key].push(toPositiveInt(typeID, 0));
    }
    return accumulator;
  }, {}),
);

let typeCache = null;
let structureCache = null;
let solarCache = null;
const structureChangeListeners = new Set();
const pendingMarketOrderCancellationTasks = new Set();

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFloat(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = toInt(value, fallback);
  return numeric > 0 ? numeric : fallback;
}

function toNullableInt(value, fallback = null) {
  if (value === undefined || value === null) {
    return fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizePosition(value, fallback = { x: 0, y: 0, z: 0 }) {
  if (!value || typeof value !== "object") {
    return { x: fallback.x, y: fallback.y, z: fallback.z };
  }
  return {
    x: toFloat(value.x, fallback.x),
    y: toFloat(value.y, fallback.y),
    z: toFloat(value.z, fallback.z),
  };
}

function normalizeRotation(value) {
  if (!Array.isArray(value) || value.length < 3) {
    return [0, 0, 0];
  }
  return [toFloat(value[0], 0), toFloat(value[1], 0), toFloat(value[2], 0)];
}

function normalizeConditionState(value) {
  const source = value && typeof value === "object" ? value : {};
  const conditionFloat = (raw, fallback) =>
    raw === undefined || raw === null ? fallback : toFloat(raw, fallback);
  const clamp01 = (raw, fallback) => Math.max(0, Math.min(1, conditionFloat(raw, fallback)));
  return {
    damage: clamp01(source.damage, 0),
    charge: clamp01(source.charge, 1),
    armorDamage: clamp01(source.armorDamage, 0),
    shieldCharge: clamp01(source.shieldCharge, 1),
    incapacitated: Boolean(source.incapacitated),
  };
}

function normalizeStructureDescription(entry = {}) {
  const source =
    entry.description !== undefined && entry.description !== null
      ? entry.description
      : entry.structureDescription !== undefined && entry.structureDescription !== null
        ? entry.structureDescription
        : entry.bio;
  return source === undefined || source === null ? "" : String(source).slice(0, 1000);
}

function toFileTimeLongFromMs(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return BigInt(Math.trunc(numeric)) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET;
}

function durationMsToLong(value) {
  const numeric = Math.max(0, Math.trunc(Number(value) || 0));
  return {
    type: "long",
    value: String(BigInt(numeric) * FILETIME_TICKS_PER_MS),
  };
}

function timestampMsToLong(value) {
  const numeric = Math.max(0, Math.trunc(Number(value) || 0));
  return {
    type: "long",
    value: String(BigInt(numeric) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET),
  };
}

function readTable(tableName, fallbackValue) {
  const result = database.read(tableName, "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return cloneValue(fallbackValue);
  }
  return cloneValue(result.data);
}

function writeTable(tableName, payload) {
  const result = database.write(tableName, "/", payload);
  if (!result.success) {
    return {
      success: false,
      errorMsg: result.errorMsg || "WRITE_FAILED",
    };
  }
  if (tableName === STRUCTURE_TYPES_TABLE) {
    typeCache = null;
  }
  if (tableName === STRUCTURES_TABLE) {
    structureCache = null;
  }
  return { success: true };
}

function listTopLevelItemsInStructure(structureID) {
  const targetID = toPositiveInt(structureID, 0);
  if (!targetID) {
    return [];
  }

  const itemsResult = database.read("items", "/");
  if (!itemsResult.success || !itemsResult.data || typeof itemsResult.data !== "object") {
    return [];
  }

  return Object.values(itemsResult.data)
    .filter((entry) => entry && toPositiveInt(entry.locationID, 0) === targetID)
    .map((entry) => cloneValue(entry));
}

function getSolarSystemsByID() {
  if (solarCache) {
    return solarCache;
  }
  solarCache = new Map(
    readStaticRows(TABLE.SOLAR_SYSTEMS)
      .map((entry) => [toPositiveInt(entry && entry.solarSystemID, 0), entry])
      .filter(([solarSystemID]) => solarSystemID > 0),
  );
  return solarCache;
}

function getSolarSystemRecord(solarSystemID) {
  return getSolarSystemsByID().get(toPositiveInt(solarSystemID, 0)) || null;
}

function deriveFamily(groupID, typeID) {
  const preset = STRUCTURE_TYPE_PRESETS[toPositiveInt(typeID, 0)] || null;
  if (preset && preset.family) {
    return preset.family;
  }
  switch (toPositiveInt(groupID, 0)) {
    case STRUCTURE_GROUP_ID.CITADEL:
      return STRUCTURE_FAMILY.CITADEL;
    case STRUCTURE_GROUP_ID.ENGINEERING_COMPLEX:
      return STRUCTURE_FAMILY.ENGINEERING;
    case STRUCTURE_GROUP_ID.REFINERY:
    case STRUCTURE_GROUP_ID.METENOX:
      return STRUCTURE_FAMILY.REFINERY;
    case STRUCTURE_GROUP_ID.CYNO_BEACON:
    case STRUCTURE_GROUP_ID.CYNO_JAMMER:
    case STRUCTURE_GROUP_ID.JUMP_GATE:
      return STRUCTURE_FAMILY.FLEX;
    case STRUCTURE_GROUP_ID.OBSERVATORY:
      return STRUCTURE_FAMILY.OBSERVATORY;
    case STRUCTURE_GROUP_ID.ADMINISTRATION_HUB:
      return STRUCTURE_FAMILY.SOV;
    case STRUCTURE_GROUP_ID.FOB:
    case STRUCTURE_GROUP_ID.PIRATE_STRONGHOLD:
      return STRUCTURE_FAMILY.STRONGHOLD;
    default:
      return STRUCTURE_FAMILY.UNKNOWN;
  }
}

function deriveSize(groupID, typeID) {
  const preset = STRUCTURE_TYPE_PRESETS[toPositiveInt(typeID, 0)] || null;
  if (preset && preset.size) {
    return preset.size;
  }
  if (toPositiveInt(groupID, 0) === STRUCTURE_GROUP_ID.CYNO_BEACON) {
    return STRUCTURE_SIZE.FLEX;
  }
  return STRUCTURE_SIZE.UNDEFINED;
}

function buildDefaultServiceStates(typeID, family) {
  const states = {};
  for (const serviceID of getAllowedServicesForStructureType(typeID, family)) {
    states[String(serviceID)] = ONLINE_BY_DEFAULT.has(serviceID)
      ? STRUCTURE_SERVICE_STATE.ONLINE
      : STRUCTURE_SERVICE_STATE.OFFLINE;
  }
  return states;
}

function normalizeServiceStates(value, typeID, family) {
  const next = buildDefaultServiceStates(typeID, family);
  const source = value && typeof value === "object" ? value : {};
  for (const [serviceID, stateID] of Object.entries(source)) {
    const numericServiceID = toPositiveInt(serviceID, 0);
    if (!numericServiceID) {
      continue;
    }
    next[String(numericServiceID)] =
      toInt(stateID, STRUCTURE_SERVICE_STATE.OFFLINE) === STRUCTURE_SERVICE_STATE.ONLINE
        ? STRUCTURE_SERVICE_STATE.ONLINE
        : STRUCTURE_SERVICE_STATE.OFFLINE;
  }
  return next;
}

function offlineModuleBackedServicesForHullReinforce(structure) {
  const nextServiceStates = {
    ...(structure && structure.serviceStates || {}),
  };
  for (const serviceID of MANAGED_SERVICE_IDS) {
    if (Object.prototype.hasOwnProperty.call(nextServiceStates, String(serviceID))) {
      nextServiceStates[String(serviceID)] = STRUCTURE_SERVICE_STATE.OFFLINE;
    }
  }
  return {
    ...structure,
    serviceStates: nextServiceStates,
    upkeepState: STRUCTURE_UPKEEP_STATE.LOW_POWER,
  };
}

function isStructureServiceSlotFlag(flagID) {
  return STRUCTURE_SERVICE_SLOT_FLAGS.includes(toInt(flagID, 0));
}

function isOnlineStructureServiceModuleItem(item) {
  return Boolean(
    item &&
      isStructureServiceSlotFlag(item.flagID) &&
      isStructureServiceModuleType(item.typeID) &&
      item.moduleState &&
      item.moduleState.online === true,
  );
}

function offlineFittedStructureServiceModulesForHullReinforce(structureID) {
  const numericStructureID = toPositiveInt(structureID, 0);
  if (!numericStructureID) {
    return {
      offlinedModuleIDs: [],
      changes: [],
    };
  }

  const modules = listContainerItems(null, numericStructureID, null)
    .filter(isOnlineStructureServiceModuleItem);
  const offlinedModuleIDs = [];
  const changes = [];
  for (const moduleItem of modules) {
    const updateResult = updateInventoryItem(moduleItem.itemID, (currentItem) => ({
      ...currentItem,
      moduleState: {
        ...(currentItem.moduleState || {}),
        online: false,
        serviceFuelNextCycleAt: null,
      },
    }));
    if (!updateResult || updateResult.success !== true) {
      continue;
    }
    offlinedModuleIDs.push(toPositiveInt(moduleItem.itemID, 0));
    changes.push({
      previousData: updateResult.previousData || moduleItem,
      item: updateResult.data,
    });
  }

  return {
    offlinedModuleIDs,
    changes,
  };
}

function structureAllowsAbandonment(structure) {
  return !TYPES_THAT_NEVER_GO_ABANDONED.has(toPositiveInt(structure && structure.typeID, 0));
}

function resolveStructureAbandonDelayMs() {
  const spreadMs = Math.max(0, ABANDONING_TIME_MAX_MS - ABANDONING_TIME_MIN_MS);
  return ABANDONING_TIME_MIN_MS + Math.floor(Math.random() * (spreadMs + 1));
}

function resolveStructureAbandonAtFromFuelAnchor(anchorMs = Date.now()) {
  return toPositiveInt(anchorMs, Date.now()) + resolveStructureAbandonDelayMs();
}

function readCharacterRecords() {
  const result = database.read("characters", "/");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {};
  }
  return result.data;
}

function isCharacterOwnerID(ownerID, characterRecords = null) {
  const numericOwnerID = toPositiveInt(ownerID, 0);
  if (!numericOwnerID) {
    return false;
  }
  const records = characterRecords || readCharacterRecords();
  return Boolean(records[String(numericOwnerID)]);
}

function countCharactersDockedInStructure(structureID) {
  const targetStructureID = toPositiveInt(structureID, 0);
  if (!targetStructureID) {
    return 0;
  }
  return Object.values(readCharacterRecords())
    .filter((record) => (
      record &&
      toPositiveInt(record.structureID, 0) === targetStructureID
    ))
    .length;
}

function buildImpendingAbandonNotificationData(structure, isCorpOwned, daysUntilAbandon) {
  const structureID = toPositiveInt(structure && structure.structureID, 0);
  const structureTypeID = toPositiveInt(structure && structure.typeID, 0);
  const solarSystemID = toPositiveInt(structure && structure.solarSystemID, 0);
  const structureName = String(
    (structure && (structure.itemName || structure.name)) || `<Structure ${structureID}>`,
  );
  return {
    structureID,
    structureShowInfoData: ["showinfo", structureTypeID, structureID],
    solarsystemID: solarSystemID,
    structureTypeID,
    isCorpOwned: isCorpOwned === true,
    daysUntilAbandon,
    structureLink: `<a href="showinfo:${structureTypeID}//${structureID}">${structureName}</a>`,
  };
}

function collectImpendingAbandonNotificationTargets(structure) {
  const structureID = toPositiveInt(structure && structure.structureID, 0);
  if (!structureID) {
    return [];
  }
  const characterRecords = readCharacterRecords();
  const targets = [];
  const seen = new Set();
  for (const item of listContainerItems(null, structureID, null)) {
    const ownerID = toPositiveInt(item && item.ownerID, 0);
    if (!ownerID) {
      continue;
    }
    if (isCharacterOwnerID(ownerID, characterRecords)) {
      const key = `char:${ownerID}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({
          markerKey: key,
          characterID: ownerID,
          isCorpOwned: false,
        });
      }
      continue;
    }

    for (const characterID of getCharacterIDsInCorporation(ownerID)) {
      const key = `corp:${ownerID}:${characterID}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({
          markerKey: key,
          characterID,
          corporationID: ownerID,
          isCorpOwned: true,
        });
      }
    }
  }
  return targets;
}

function maybeCreateImpendingAbandonNotifications(structure, nowMs) {
  const abandonAt = toPositiveInt(structure && structure.abandonAt, 0);
  if (!abandonAt || abandonAt <= nowMs) {
    return false;
  }
  const remainingMs = abandonAt - nowMs;
  if (remainingMs > ABANDONED_ADVANCE_WARNING_MS) {
    return false;
  }

  const notifiedForCurrentTimer =
    toPositiveInt(structure.abandonmentWarningAbandonAt, 0) === abandonAt;
  const notifiedKeys = notifiedForCurrentTimer && Array.isArray(structure.abandonmentWarningRecipients)
    ? new Set(structure.abandonmentWarningRecipients.map((entry) => String(entry)))
    : new Set();
  const daysUntilAbandon = Math.max(
    1,
    Math.ceil(remainingMs / ABANDONED_WARNING_DAY_MS),
  );
  let changed = !notifiedForCurrentTimer;

  for (const target of collectImpendingAbandonNotificationTargets(structure)) {
    if (notifiedKeys.has(target.markerKey)) {
      continue;
    }
    const result = createNotification(target.characterID, {
      typeID: NOTIFICATION_TYPE.STRUCTURE_IMPENDING_ABANDONMENT_ASSETS_AT_RISK,
      senderID: toPositiveInt(target.corporationID, 0) || toPositiveInt(structure.ownerCorpID, 0),
      groupID: NOTIFICATION_GROUP.STRUCTURES,
      processed: false,
      data: buildImpendingAbandonNotificationData(
        structure,
        target.isCorpOwned,
        daysUntilAbandon,
      ),
      emitLive: false,
    });
    if (result && result.success === true) {
      notifiedKeys.add(target.markerKey);
      changed = true;
    }
  }

  if (changed) {
    structure.abandonmentWarningAbandonAt = abandonAt;
    structure.abandonmentWarningRecipients = [...notifiedKeys].sort();
  }
  return changed;
}

function normalizeAccessProfile(value) {
  const source = value && typeof value === "object" ? value : {};
  const normalizePolicy = (raw, fallback) => {
    const normalized = String(raw || fallback).trim().toLowerCase();
    return ["public", "alliance", "corp", "owner", "none"].includes(normalized)
      ? normalized
      : fallback;
  };
  return {
    docking: normalizePolicy(source.docking, "public"),
    tethering: normalizePolicy(source.tethering, "public"),
  };
}

function normalizeStructureTypeRecord(entry = {}) {
  const typeID = toPositiveInt(entry.typeID, 0);
  const preset = STRUCTURE_TYPE_PRESETS[typeID] || null;
  const itemType = resolveItemByTypeID(typeID) || entry || {};
  const family = entry.structureFamily || deriveFamily(itemType.groupID, typeID);
  const size = entry.structureSize || deriveSize(itemType.groupID, typeID);
  const defaultQuantumCoreTypeID = toPositiveInt(
    entry.defaultQuantumCoreTypeID,
    (preset && preset.defaultQuantumCoreTypeID) || 0,
  ) || null;

  return {
    typeID,
    name: String(itemType.name || entry.name || `Structure ${typeID}`),
    groupID: toPositiveInt(itemType.groupID || entry.groupID, 0),
    categoryID: toPositiveInt(itemType.categoryID || entry.categoryID, 65),
    structureFamily: family,
    structureSize: size,
    radius: Math.max(
      DEFAULT_STRUCTURE_RADIUS,
      toFloat(entry.radius, getTypeAttributeValue(typeID, "radius")) || DEFAULT_STRUCTURE_RADIUS,
    ),
    shieldCapacity: Math.max(0, toFloat(entry.shieldCapacity, getTypeAttributeValue(typeID, "shieldCapacity"))),
    armorHP: Math.max(0, toFloat(entry.armorHP, getTypeAttributeValue(typeID, "armorHP"))),
    hullHP: Math.max(0, toFloat(entry.hullHP, getTypeAttributeValue(typeID, "hp", "structureHP"))),
    capacitorCapacity: Math.max(
      0,
      toFloat(entry.capacitorCapacity, getTypeAttributeValue(typeID, "capacitorCapacity")),
    ),
    maxTargetRange: Math.max(0, toFloat(entry.maxTargetRange, getTypeAttributeValue(typeID, "maxTargetRange"))),
    maxLockedTargets: Math.max(0, toFloat(entry.maxLockedTargets, getTypeAttributeValue(typeID, "maxLockedTargets"))),
    tetheringRange: Math.max(
      DEFAULT_STRUCTURE_TETHER_RANGE,
      toFloat(entry.tetheringRange, getTypeAttributeValue(typeID, "tetheringRange")) || DEFAULT_STRUCTURE_TETHER_RANGE,
    ),
    damageCap: Math.max(0, toFloat(entry.damageCap, getTypeAttributeValue(typeID, "damageCap"))),
    allowedServices: Array.isArray(entry.allowedServices)
      ? entry.allowedServices.map((serviceID) => toPositiveInt(serviceID, 0)).filter(Boolean)
      : Array.isArray(preset && preset.allowedServices)
      ? preset.allowedServices.map((serviceID) => toPositiveInt(serviceID, 0)).filter(Boolean)
      : getAllowedServicesForStructureType(typeID, family),
    dockable:
      typeof (preset && preset.dockable) === "boolean"
        ? preset.dockable
        : ![
          STRUCTURE_FAMILY.FLEX,
          STRUCTURE_FAMILY.OBSERVATORY,
          STRUCTURE_FAMILY.SOV,
        ].includes(family),
    defaultQuantumCoreTypeID,
    excludedDockGroupNames:
      typeID === 35836 ? [...TATARA_EXCLUDED_DOCK_GROUP_NAMES] : [],
    oneWayUndockClasses: [...(ONE_WAY_UNDOCK_TYPE_IDS[typeID] || [])],
    tetherRepairEffectMode:
      entry.tetherRepairEffectMode === undefined ||
      entry.tetherRepairEffectMode === null
        ? null
        : String(entry.tetherRepairEffectMode),
    published: itemType.published !== false,
  };
}

function ensureStructureTypes() {
  if (typeCache) {
    return typeCache;
  }

  database.ensureTable(STRUCTURE_TYPES_TABLE);
  const payload = readTable(STRUCTURE_TYPES_TABLE, {
    _meta: { seedVersion: 1, generatedAt: null },
    structureTypes: [],
  });
  let rows = Array.isArray(payload.structureTypes)
    ? payload.structureTypes.map((entry) => normalizeStructureTypeRecord(entry))
    : [];

  if (rows.length === 0) {
    rows = readStaticRows(TABLE.ITEM_TYPES)
      .filter((entry) => toPositiveInt(entry && entry.categoryID, 0) === 65)
      .map((entry) => normalizeStructureTypeRecord(entry))
      .filter((entry) => entry.typeID > 0)
      .sort((left, right) => left.typeID - right.typeID);

    const writeResult = writeTable(STRUCTURE_TYPES_TABLE, {
      _meta: {
        seedVersion: 1,
        generatedAt: new Date().toISOString(),
      },
      structureTypes: rows,
    });
    if (!writeResult.success) {
      log.warn(
        `[StructureState] Failed to persist structureTypes bootstrap: ${writeResult.errorMsg}`,
      );
    }
  }

  let rowsChanged = false;
  const typeIDs = new Set(rows.map((entry) => entry.typeID));
  for (const typeID of REQUIRED_NON_CATEGORY_STRUCTURE_TYPE_IDS) {
    if (typeIDs.has(typeID)) {
      continue;
    }
    rows.push(normalizeStructureTypeRecord({ typeID }));
    typeIDs.add(typeID);
    rowsChanged = true;
  }
  if (rowsChanged) {
    rows.sort((left, right) => left.typeID - right.typeID);
    const writeResult = writeTable(STRUCTURE_TYPES_TABLE, {
      _meta: {
        seedVersion: 2,
        generatedAt:
          payload &&
          payload._meta &&
          payload._meta.generatedAt
            ? String(payload._meta.generatedAt)
            : new Date().toISOString(),
      },
      structureTypes: rows,
    });
    if (!writeResult.success) {
      log.warn(
        `[StructureState] Failed to persist required sovereignty structure types: ${writeResult.errorMsg}`,
      );
    }
  }

  typeCache = {
    rows,
    byTypeID: new Map(rows.map((entry) => [entry.typeID, entry])),
  };
  return typeCache;
}

function getStructureTypeByID(typeID) {
  return ensureStructureTypes().byTypeID.get(toPositiveInt(typeID, 0)) || null;
}

function getStructureTypes() {
  return [...ensureStructureTypes().rows];
}

function normalizeStructureRecord(entry = {}) {
  const structureID = toPositiveInt(entry.structureID, 0);
  const typeID = toPositiveInt(entry.typeID, 0);
  const typeRecord = getStructureTypeByID(typeID) || normalizeStructureTypeRecord({ typeID });
  const system = getSolarSystemRecord(entry.solarSystemID);
  const reinforceWeekday = toInt(entry.reinforceWeekday, DEFAULT_REINFORCE_WEEKDAY);
  const reinforceHour = toInt(entry.reinforceHour, DEFAULT_REINFORCE_HOUR);
  const nextReinforceApply = toPositiveInt(entry.nextReinforceApply, 0) || null;
  const hasPendingReinforcementTiming = Boolean(nextReinforceApply);

  return {
    structureID,
    typeID,
    name: String(entry.name || typeRecord.name || `Structure ${structureID}`),
    itemName: String(entry.itemName || entry.name || typeRecord.name || `Structure ${structureID}`),
    description: normalizeStructureDescription(entry),
    ownerCorpID: toPositiveInt(entry.ownerCorpID || entry.ownerID, 1),
    ownerID: toPositiveInt(entry.ownerCorpID || entry.ownerID, 1),
    allianceID: toPositiveInt(entry.allianceID, 0) || null,
    solarSystemID: toPositiveInt(entry.solarSystemID, toPositiveInt(system && system.solarSystemID, 30000142)),
    moonID: toPositiveInt(entry.moonID, 0) || null,
    constellationID: toPositiveInt(entry.constellationID, toPositiveInt(system && system.constellationID, 20000020)),
    regionID: toPositiveInt(entry.regionID, toPositiveInt(system && system.regionID, 10000002)),
    position: normalizePosition(entry.position),
    rotation: normalizeRotation(entry.rotation),
    radius: Math.max(DEFAULT_STRUCTURE_RADIUS, toFloat(entry.radius, typeRecord.radius)),
    structureFamily: typeRecord.structureFamily,
    structureSize: typeRecord.structureSize,
    state: STRUCTURE_STATE_NAME_BY_ID[toInt(entry.state, -1)]
      ? toInt(entry.state, STRUCTURE_STATE.UNANCHORED)
      : STRUCTURE_STATE.UNANCHORED,
    stateStartedAt: Number.isFinite(Number(entry.stateStartedAt)) ? toInt(entry.stateStartedAt, 0) : null,
    stateEndsAt: Number.isFinite(Number(entry.stateEndsAt)) ? toInt(entry.stateEndsAt, 0) : null,
    timerPausedAt: Number.isFinite(Number(entry.timerPausedAt)) ? toInt(entry.timerPausedAt, 0) : null,
    upkeepState: STRUCTURE_UPKEEP_NAME_BY_ID[toInt(entry.upkeepState, -1)]
      ? toInt(entry.upkeepState, STRUCTURE_UPKEEP_STATE.FULL_POWER)
      : STRUCTURE_UPKEEP_STATE.FULL_POWER,
    hasQuantumCore: entry.hasQuantumCore === true,
    quantumCoreItemTypeID: toPositiveInt(
      entry.quantumCoreItemTypeID,
      typeRecord.defaultQuantumCoreTypeID || 0,
    ) || null,
    reinforceWeekday,
    reinforceHour,
    nextReinforceWeekday: hasPendingReinforcementTiming
      ? toNullableInt(entry.nextReinforceWeekday, reinforceWeekday)
      : null,
    nextReinforceHour: hasPendingReinforcementTiming
      ? toNullableInt(entry.nextReinforceHour, reinforceHour)
      : null,
    nextReinforceApply,
    profileID: toPositiveInt(entry.profileID, 1),
    serviceStates: normalizeServiceStates(entry.serviceStates, typeID, typeRecord.structureFamily),
    fuelExpiresAt:
      entry.fuelExpiresAt === undefined || entry.fuelExpiresAt === null
        ? null
        : Number.isFinite(Number(entry.fuelExpiresAt))
          ? toInt(entry.fuelExpiresAt, 0)
          : null,
    assetSafetyMode: String(entry.assetSafetyMode || "enabled"),
    destroyedAt: Number.isFinite(Number(entry.destroyedAt)) ? toInt(entry.destroyedAt, 0) : null,
    wars: Array.isArray(entry.wars) ? entry.wars.map((warID) => toPositiveInt(warID, 0)).filter(Boolean) : [],
    unanchoring:
      entry.unanchoring === undefined || entry.unanchoring === null
        ? null
        : toInt(entry.unanchoring, 0),
    abandonAt:
      entry.abandonAt === undefined || entry.abandonAt === null
        ? null
        : toInt(entry.abandonAt, 0),
    abandonmentWarningAbandonAt:
      entry.abandonmentWarningAbandonAt === undefined ||
      entry.abandonmentWarningAbandonAt === null
        ? null
        : toInt(entry.abandonmentWarningAbandonAt, 0),
    abandonmentWarningRecipients: Array.isArray(entry.abandonmentWarningRecipients)
      ? entry.abandonmentWarningRecipients.map((recipient) => String(recipient))
      : [],
    liquidOzoneQty: Math.max(0, toInt(entry.liquidOzoneQty, 0)),
    devFlags: entry.devFlags && typeof entry.devFlags === "object" ? cloneValue(entry.devFlags) : {},
    accessProfile: normalizeAccessProfile(entry.accessProfile),
    conditionState: normalizeConditionState(entry.conditionState),
    shieldCapacity: Math.max(0, toFloat(entry.shieldCapacity, typeRecord.shieldCapacity)),
    armorHP: Math.max(0, toFloat(entry.armorHP, typeRecord.armorHP)),
    hullHP: Math.max(0, toFloat(entry.hullHP, typeRecord.hullHP)),
    capacitorCapacity: Math.max(0, toFloat(entry.capacitorCapacity, typeRecord.capacitorCapacity)),
    maxTargetRange: Math.max(0, toFloat(entry.maxTargetRange, typeRecord.maxTargetRange)),
    maxLockedTargets: Math.max(0, toFloat(entry.maxLockedTargets, typeRecord.maxLockedTargets)),
    tetheringRange: Math.max(DEFAULT_STRUCTURE_TETHER_RANGE, toFloat(entry.tetheringRange, typeRecord.tetheringRange) || DEFAULT_STRUCTURE_TETHER_RANGE),
    tetherRepairEffectMode:
      entry.tetherRepairEffectMode === undefined ||
      entry.tetherRepairEffectMode === null
        ? typeRecord.tetherRepairEffectMode || null
        : String(entry.tetherRepairEffectMode),
    damageCap: Math.max(0, toFloat(entry.damageCap, typeRecord.damageCap)),
    dockable: typeRecord.dockable === true,
    published: typeRecord.published !== false,
  };
}

function ensureStructureCache() {
  if (structureCache) {
    return structureCache;
  }

  const payload = readTable(STRUCTURES_TABLE, {
    _meta: {
      nextStructureID: NEXT_STRUCTURE_ID_START,
      generatedAt: null,
      lastUpdatedAt: null,
    },
    structures: [],
  });
  const rows = Array.isArray(payload.structures)
    ? payload.structures.map((entry) => normalizeStructureRecord(entry))
    : [];

  structureCache = {
    meta: {
      nextStructureID: Math.max(
        NEXT_STRUCTURE_ID_START,
        toPositiveInt(payload._meta && payload._meta.nextStructureID, NEXT_STRUCTURE_ID_START),
      ),
      generatedAt: payload._meta && payload._meta.generatedAt ? String(payload._meta.generatedAt) : null,
      lastUpdatedAt: payload._meta && payload._meta.lastUpdatedAt ? String(payload._meta.lastUpdatedAt) : null,
    },
    rows,
    byStructureID: new Map(rows.map((entry) => [entry.structureID, entry])),
  };
  return structureCache;
}

function persistStructures(rows, metaOverrides = {}, options = {}) {
  const previousRows = ensureStructureCache().rows.map((entry) => cloneValue(entry));
  const normalizedRows = rows.map((entry) => normalizeStructureRecord(entry));
  const nextStructureID = Math.max(
    NEXT_STRUCTURE_ID_START,
    ...normalizedRows.map((entry) => toPositiveInt(entry && entry.structureID, 0) + 1),
    NEXT_STRUCTURE_ID_START,
  );
  const nextMeta = {
    ...(ensureStructureCache().meta || {}),
    nextStructureID,
    lastUpdatedAt: new Date().toISOString(),
    ...metaOverrides,
  };
  const writeResult = writeTable(STRUCTURES_TABLE, {
    _meta: nextMeta,
    structures: normalizedRows,
  });
  if (!writeResult.success) {
    return writeResult;
  }

  const cachedRows = normalizedRows.map((entry) => cloneValue(entry));
  structureCache = {
    meta: {
      ...nextMeta,
    },
    rows: cachedRows,
    byStructureID: new Map(cachedRows.map((entry) => [entry.structureID, entry])),
  };
  if (!options || options.emitLive !== false) {
    notifyStructureChangeListeners(previousRows, cachedRows);
    maybeBroadcastCynoJammerStateChanges(previousRows, cachedRows);
    maybeCreateStructureTransitionNotifications(previousRows, cachedRows);
  }
  return writeResult;
}

function buildStructureChangeSystemIDs(previousRows = [], nextRows = []) {
  const previousByID = new Map(
    (Array.isArray(previousRows) ? previousRows : [])
      .map((entry) => [toPositiveInt(entry && entry.structureID, 0), entry])
      .filter(([structureID]) => structureID > 0),
  );
  const nextByID = new Map(
    (Array.isArray(nextRows) ? nextRows : [])
      .map((entry) => [toPositiveInt(entry && entry.structureID, 0), entry])
      .filter(([structureID]) => structureID > 0),
  );
  const changedSystemIDs = new Set();
  const structureIDs = new Set([
    ...previousByID.keys(),
    ...nextByID.keys(),
  ]);
  for (const structureID of structureIDs) {
    const previous = previousByID.get(structureID) || null;
    const next = nextByID.get(structureID) || null;
    if (JSON.stringify(previous) === JSON.stringify(next)) {
      continue;
    }
    const previousSystemID = toPositiveInt(previous && previous.solarSystemID, 0);
    const nextSystemID = toPositiveInt(next && next.solarSystemID, 0);
    if (previousSystemID > 0) {
      changedSystemIDs.add(previousSystemID);
    }
    if (nextSystemID > 0) {
      changedSystemIDs.add(nextSystemID);
    }
  }
  return [...changedSystemIDs];
}

function notifyStructureChangeListeners(previousRows = [], nextRows = []) {
  if (structureChangeListeners.size <= 0) {
    return;
  }
  const systemIDs = buildStructureChangeSystemIDs(previousRows, nextRows);
  if (systemIDs.length <= 0) {
    return;
  }
  const payload = {
    systemIDs,
    previousRows: previousRows.map((entry) => cloneValue(entry)),
    nextRows: nextRows.map((entry) => cloneValue(entry)),
  };
  for (const listener of structureChangeListeners) {
    try {
      listener(payload);
    } catch (error) {
      log.warn(`[StructureState] Structure change listener failed: ${error.message}`);
    }
  }
}

function registerStructureChangeListener(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }
  structureChangeListeners.add(listener);
  return () => {
    structureChangeListeners.delete(listener);
  };
}

function maybeBroadcastCynoJammerStateChanges(previousRows = [], nextRows = []) {
  const systemIDs = buildStructureChangeSystemIDs(previousRows, nextRows);
  if (systemIDs.length <= 0) {
    return 0;
  }
  try {
    const {
      broadcastCynoJammerChangesForStructureRows,
    } = lazyRequire("../sovereignty/sovSuppressionState");
    if (typeof broadcastCynoJammerChangesForStructureRows !== "function") {
      return 0;
    }
    return broadcastCynoJammerChangesForStructureRows(previousRows, nextRows, {
      systemIDs,
    });
  } catch (error) {
    log.warn(`[StructureState] Cyno jammer notification sync failed: ${error.message}`);
    return 0;
  }
}

function endWarsForLostWarHQLazily(structure, options = {}) {
  try {
    const {
      endWarsForLostWarHQ,
    } = lazyRequire("../corporation/warRuntimeState");
    if (typeof endWarsForLostWarHQ !== "function") {
      return [];
    }
    return endWarsForLostWarHQ(structure, options);
  } catch (error) {
    log.warn(
      `[StructureState] Failed to end War HQ wars for ` +
      `${structure && structure.structureID}: ${error.message}`,
    );
    return [];
  }
}

function buildStructureBaseNotificationData(structure) {
  const structureID = toPositiveInt(structure && structure.structureID, 0);
  const structureTypeID = toPositiveInt(structure && structure.typeID, 0);
  return {
    structureID,
    structureShowInfoData: ["showinfo", structureTypeID, structureID],
    solarsystemID: toPositiveInt(structure && structure.solarSystemID, 0),
    structureTypeID,
  };
}

function collectStructureOwnerNotificationTargets(structure) {
  const ownerCorpID = toPositiveInt(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
  if (!ownerCorpID) {
    return [];
  }
  return [...new Set(getCharacterIDsInCorporation(ownerCorpID))];
}

function getStructureOwnerCorpID(structure) {
  return toPositiveInt(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
}

function collectStructureCorporationNotificationTargets(corporationIDs = []) {
  const targets = new Set();
  for (const corporationID of corporationIDs) {
    const numericCorporationID = toPositiveInt(corporationID, 0);
    if (!numericCorporationID) {
      continue;
    }
    for (const characterID of getCharacterIDsInCorporation(numericCorporationID)) {
      const numericCharacterID = toPositiveInt(characterID, 0);
      if (numericCharacterID) {
        targets.add(numericCharacterID);
      }
    }
  }
  return [...targets];
}

function createStructureOwnerNotifications(structure, typeID, dataOverrides = {}) {
  const notificationTypeID = toPositiveInt(typeID, 0);
  if (!notificationTypeID || !structure) {
    return;
  }
  const senderID = toPositiveInt(structure.ownerCorpID || structure.ownerID, 0);
  const data = {
    ...buildStructureBaseNotificationData(structure),
    ...(dataOverrides && typeof dataOverrides === "object" ? dataOverrides : {}),
  };
  for (const characterID of collectStructureOwnerNotificationTargets(structure)) {
    const result = createNotification(characterID, {
      typeID: notificationTypeID,
      senderID,
      groupID: NOTIFICATION_GROUP.STRUCTURES,
      processed: false,
      data,
      emitLive: false,
    });
    if (!result || result.success !== true) {
      log.warn(
        `[StructureState] Failed to create owner notification ` +
        `type=${notificationTypeID} structure=${data.structureID} ` +
        `character=${characterID}: ${result && result.errorMsg ? result.errorMsg : "UNKNOWN"}`,
      );
    }
  }
}

function resolveCharacterIDFromOwnershipTransferMetadata(source) {
  const keys = [
    "charID",
    "characterID",
    "actorCharacterID",
    "ownerTransferCharacterID",
    "ownershipTransferCharacterID",
    "transferredByCharacterID",
    "transferActorCharacterID",
    "lastOwnerTransferCharacterID",
  ];
  if (!source || typeof source !== "object") {
    return 0;
  }
  for (const key of keys) {
    const characterID = toPositiveInt(source[key], 0);
    if (characterID) {
      return characterID;
    }
  }
  return 0;
}

function ownershipTransferMetadataMatchesCorpID(source, expectedCorpID, keys) {
  if (!source || typeof source !== "object") {
    return false;
  }
  for (const key of keys) {
    if (source[key] === undefined || source[key] === null) {
      continue;
    }
    return toPositiveInt(source[key], 0) === expectedCorpID;
  }
  return false;
}

function ownershipTransferMetadataMatchesOwners(source, oldOwnerCorpID, newOwnerCorpID) {
  return (
    ownershipTransferMetadataMatchesCorpID(
      source,
      oldOwnerCorpID,
      [
        "oldOwnerCorpID",
        "fromOwnerCorpID",
        "previousOwnerCorpID",
        "ownerTransferOldOwnerCorpID",
      ],
    ) &&
    ownershipTransferMetadataMatchesCorpID(
      source,
      newOwnerCorpID,
      [
        "newOwnerCorpID",
        "toOwnerCorpID",
        "nextOwnerCorpID",
        "ownerTransferNewOwnerCorpID",
      ],
    )
  );
}

function resolveStructureOwnershipTransferActorID(next, oldOwnerCorpID, newOwnerCorpID) {
  const devFlags = next && next.devFlags && typeof next.devFlags === "object"
    ? next.devFlags
    : {};
  const sources = [
    devFlags.ownerTransfer,
    devFlags.ownershipTransfer,
    devFlags.structureOwnershipTransfer,
    devFlags,
    next,
  ];
  for (const source of sources) {
    const characterID = resolveCharacterIDFromOwnershipTransferMetadata(source);
    if (
      characterID &&
      ownershipTransferMetadataMatchesOwners(
        source,
        oldOwnerCorpID,
        newOwnerCorpID,
      )
    ) {
      return characterID;
    }
  }
  return 0;
}

function createStructureOwnershipTransferredNotifications(previous, next) {
  const oldOwnerCorpID = getStructureOwnerCorpID(previous);
  const newOwnerCorpID = getStructureOwnerCorpID(next);
  if (!oldOwnerCorpID || !newOwnerCorpID || oldOwnerCorpID === newOwnerCorpID) {
    return;
  }
  const charID = resolveStructureOwnershipTransferActorID(
    next,
    oldOwnerCorpID,
    newOwnerCorpID,
  );
  if (!charID) {
    return;
  }
  const structureID = toPositiveInt(next && next.structureID, 0);
  const structureTypeID = toPositiveInt(next && next.typeID, 0);
  const solarSystemID = toPositiveInt(next && next.solarSystemID, 0);
  if (!structureID || !structureTypeID || !solarSystemID) {
    return;
  }
  const data = {
    structureID,
    structureTypeID,
    solarSystemID,
    newOwnerCorpID,
    oldOwnerCorpID,
    charID,
    structureName: String(
      (next && (next.name || next.itemName)) ||
      (previous && (previous.name || previous.itemName)) ||
      `Structure ${structureID}`,
    ),
  };
  for (const characterID of collectStructureCorporationNotificationTargets([
    oldOwnerCorpID,
    newOwnerCorpID,
  ])) {
    const result = createNotification(characterID, {
      typeID: NOTIFICATION_TYPE.OWNERSHIP_TRANSFERRED,
      senderID: newOwnerCorpID,
      groupID: NOTIFICATION_GROUP.STRUCTURES,
      processed: false,
      data,
      emitLive: false,
    });
    if (!result || result.success !== true) {
      log.warn(
        `[StructureState] Failed to create ownership-transfer notification ` +
        `structure=${structureID} character=${characterID}: ` +
        `${result && result.errorMsg ? result.errorMsg : "UNKNOWN"}`,
      );
    }
  }
}

function createStructurePowerStateNotifications(structure, typeID) {
  createStructureOwnerNotifications(structure, typeID);
}

function resolveStructureOwnerCorpNotificationData(structure, contextLabel) {
  const ownerCorpID = toPositiveInt(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
  if (!ownerCorpID) {
    return null;
  }
  const ownerRecord = getCorporationOwnerRecord(ownerCorpID);
  const ownerCorpName = ownerRecord && ownerRecord.ownerName
    ? String(ownerRecord.ownerName)
    : `Corporation ${ownerCorpID}`;
  return {
    ownerCorpName,
    ownerCorpLinkData: [
      "showinfo",
      toPositiveInt(ownerRecord && ownerRecord.typeID, TYPE_CORPORATION) ||
        TYPE_CORPORATION,
      ownerCorpID,
    ],
  };
}

function createStructureAnchoringNotifications(structure) {
  const ownerData = resolveStructureOwnerCorpNotificationData(
    structure,
    "anchoring",
  );
  if (!ownerData) {
    return;
  }
  const stateStartedAt = toPositiveInt(structure && structure.stateStartedAt, Date.now());
  const stateEndsAt = toPositiveInt(structure && structure.stateEndsAt, stateStartedAt);
  createStructureOwnerNotifications(
    structure,
    NOTIFICATION_TYPE.STRUCTURE_ANCHORING,
    {
      ...ownerData,
      timeLeft: durationMsToLong(Math.max(0, stateEndsAt - stateStartedAt)),
      vulnerableTime: durationMsToLong(
        scaledTimerMs(
          STRUCTURE_REPAIR_SECONDS_BY_STATE[STRUCTURE_STATE.ONLINING_VULNERABLE],
          structure,
        ),
      ),
    },
  );
}

function createStructureUnanchoringNotifications(structure, nowMs = Date.now()) {
  const ownerData = resolveStructureOwnerCorpNotificationData(
    structure,
    "unanchoring",
  );
  if (!ownerData) {
    return;
  }
  const unanchoringAt = toPositiveInt(structure && structure.unanchoring, 0);
  if (!unanchoringAt) {
    return;
  }
  createStructureOwnerNotifications(
    structure,
    NOTIFICATION_TYPE.STRUCTURE_UNANCHORING,
    {
      ...ownerData,
      timeLeft: durationMsToLong(Math.max(0, unanchoringAt - toInt(nowMs, Date.now()))),
    },
  );
}

function createStructureOnlineNotifications(structure, requiresDeedTypeID = null) {
  const deedTypeID = toPositiveInt(requiresDeedTypeID, 0);
  createStructureOwnerNotifications(
    structure,
    NOTIFICATION_TYPE.STRUCTURE_ONLINE,
    deedTypeID ? { requiresDeedTypeID: deedTypeID } : {},
  );
}

function resolveReinforcementVulnerableState(structure) {
  const state = toInt(structure && structure.state, 0);
  if (state === STRUCTURE_STATE.ARMOR_REINFORCE) {
    return STRUCTURE_STATE.ARMOR_VULNERABLE;
  }
  if (state === STRUCTURE_STATE.HULL_REINFORCE) {
    return STRUCTURE_STATE.HULL_VULNERABLE;
  }
  return 0;
}

function createStructureReinforcementLossNotifications(structure, typeID) {
  const stateStartedAt = toPositiveInt(structure && structure.stateStartedAt, 0);
  const stateEndsAt = toPositiveInt(structure && structure.stateEndsAt, 0);
  const vulnerableState = resolveReinforcementVulnerableState(structure);
  if (!stateStartedAt || !stateEndsAt || !vulnerableState) {
    return;
  }
  createStructureOwnerNotifications(
    structure,
    typeID,
    {
      timeLeft: durationMsToLong(Math.max(0, stateEndsAt - stateStartedAt)),
      timestamp: timestampMsToLong(stateEndsAt),
      vulnerableTime: durationMsToLong(
        scaledTimerMs(
          STRUCTURE_REPAIR_SECONDS_BY_STATE[vulnerableState],
          structure,
        ),
      ),
    },
  );
}

function createStructureFuelAlertNotifications(structure, listOfTypesAndQty) {
  const fuelList = (Array.isArray(listOfTypesAndQty) ? listOfTypesAndQty : [])
    .map((entry) => {
      if (!Array.isArray(entry) || entry.length < 2) {
        return null;
      }
      const qty = toPositiveInt(entry[0], 0);
      const typeID = toPositiveInt(entry[1], 0);
      return qty > 0 && typeID > 0 ? [qty, typeID] : null;
    })
    .filter(Boolean);
  if (fuelList.length <= 0) {
    return;
  }
  createStructureOwnerNotifications(
    structure,
    NOTIFICATION_TYPE.STRUCTURE_FUEL_ALERT,
    { listOfTypesAndQty: fuelList },
  );
}

function normalizeStructureAttackContext(options = {}) {
  const source =
    options && typeof options === "object"
      ? options.attacker || options.aggressor || options
      : {};
  const aggressorID = toPositiveInt(
    source && (
      source.aggressorID ||
      source.characterID ||
      source.charid ||
      source.charID ||
      source.pilotCharacterID
    ),
    0,
  );
  const aggressorCorpID = toPositiveInt(
    source && (
      source.aggressorCorpID ||
      source.corporationID ||
      source.corpid ||
      source.corpID ||
      source.ownerID
    ),
    0,
  );
  const aggressorAllianceID = toPositiveInt(
    source && (
      source.aggressorAllianceID ||
      source.allianceID ||
      source.allianceid
    ),
    0,
  ) || null;
  if (!aggressorID || !aggressorCorpID) {
    return null;
  }
  return {
    aggressorID,
    aggressorCorpID,
    aggressorAllianceID,
  };
}

function shouldNotifyStructureUnderAttack(previousStructure, nextStructure, damageResult, nowMs, options = {}) {
  const attackContext = normalizeStructureAttackContext(options);
  if (!attackContext) {
    return null;
  }
  const beforeLayers = damageResult && damageResult.data
    ? damageResult.data.beforeLayers || {}
    : {};
  const afterLayers = damageResult && damageResult.data
    ? damageResult.data.afterLayers || {}
    : {};
  if (!isStructureRepairLayerDamageApplied(previousStructure, beforeLayers, afterLayers)) {
    return null;
  }
  const repairEndsAt = toPositiveInt(nextStructure && nextStructure.stateEndsAt, 0);
  const repairPausedAt = toPositiveInt(nextStructure && nextStructure.timerPausedAt, 0);
  if (repairEndsAt <= nowMs || repairPausedAt !== nowMs) {
    return null;
  }
  const previousNotificationActiveUntil = toPositiveInt(
    previousStructure &&
      previousStructure.devFlags &&
      previousStructure.devFlags.underAttackNotificationActiveUntilMs,
    0,
  );
  if (previousNotificationActiveUntil > nowMs) {
    return null;
  }
  return {
    ...attackContext,
    activeUntilMs: repairEndsAt,
  };
}

function buildStructureUnderAttackNotificationData(structure, attackContext) {
  const aggressorCorpID = toPositiveInt(attackContext && attackContext.aggressorCorpID, 0);
  const aggressorCorpRecord = getCorporationOwnerRecord(aggressorCorpID);
  if (!aggressorCorpRecord || !aggressorCorpRecord.ownerName) {
    return null;
  }
  const condition = normalizeConditionState(structure && structure.conditionState);
  const data = {
    shieldPercentage: 100 * Math.max(0, Math.min(1, condition.shieldCharge)),
    armorPercentage: 100 * Math.max(0, Math.min(1, 1 - condition.armorDamage)),
    hullPercentage: 100 * Math.max(0, Math.min(1, 1 - condition.damage)),
    charID: toPositiveInt(attackContext && attackContext.aggressorID, 0),
    corpName: String(aggressorCorpRecord.ownerName),
    corpLinkData: ["showinfo", TYPE_CORPORATION, aggressorCorpID],
    allianceID: null,
  };
  const aggressorAllianceID = toPositiveInt(
    attackContext && attackContext.aggressorAllianceID,
    0,
  );
  if (aggressorAllianceID) {
    const allianceRecord = getAllianceOwnerRecord(aggressorAllianceID);
    if (allianceRecord && allianceRecord.ownerName) {
      data.allianceID = aggressorAllianceID;
      data.allianceName = String(allianceRecord.ownerName);
      data.allianceLinkData = ["showinfo", TYPE_ALLIANCE, aggressorAllianceID];
    }
  }
  return data;
}

function createStructureUnderAttackNotifications(structure, attackContext) {
  if (!structure || !attackContext) {
    return;
  }
  const data = buildStructureUnderAttackNotificationData(structure, attackContext);
  if (!data) {
    log.warn(
      `[StructureState] Skipping under-attack notification for ` +
      `structure=${structure && structure.structureID} aggressorCorp=${attackContext.aggressorCorpID}: ` +
      `owner record missing`,
    );
    return;
  }
  createStructureOwnerNotifications(
    structure,
    NOTIFICATION_TYPE.STRUCTURE_UNDER_ATTACK,
    data,
  );
}

function createStructureReagentAlertNotifications(structure, typeID) {
  const notificationTypeID = toPositiveInt(typeID, 0);
  if (
    notificationTypeID !== NOTIFICATION_TYPE.STRUCTURE_LOW_REAGENTS_ALERT &&
    notificationTypeID !== NOTIFICATION_TYPE.STRUCTURE_NO_REAGENTS_ALERT
  ) {
    return;
  }
  createStructureOwnerNotifications(structure, notificationTypeID);
}

function resolveAutoMoonReagentAlertType(fuelResult) {
  const requiredMagmaticGas = toPositiveInt(
    fuelResult && fuelResult.requiredMagmaticGas,
    0,
  );
  if (!requiredMagmaticGas) {
    return null;
  }
  const availableMagmaticGas = toInt(
    fuelResult && fuelResult.availableMagmaticGas,
    0,
  );
  if (availableMagmaticGas >= requiredMagmaticGas) {
    return null;
  }
  return availableMagmaticGas <= 0
    ? NOTIFICATION_TYPE.STRUCTURE_NO_REAGENTS_ALERT
    : NOTIFICATION_TYPE.STRUCTURE_LOW_REAGENTS_ALERT;
}

function resolveAutoMoonFuelAlertTypesAndQty(fuelResult) {
  if (
    toPositiveInt(fuelResult && fuelResult.requiredFuelBlocks, 0) <=
    toInt(fuelResult && fuelResult.availableFuelBlocks, 0)
  ) {
    return [];
  }
  const reagentTypeID = toPositiveInt(
    structureAutoMoonFuelRuntime.TYPE_COLONY_REAGENT_LAVA,
    0,
  );
  return (Array.isArray(fuelResult && fuelResult.fuelAlertTypesAndQty)
    ? fuelResult.fuelAlertTypesAndQty
    : [])
    .filter((entry) =>
      Array.isArray(entry) &&
      toPositiveInt(entry[1], 0) !== reagentTypeID,
    );
}

function createStructureDestroyedNotifications(structure) {
  const ownerCorpID = toPositiveInt(
    structure && (structure.ownerCorpID || structure.ownerID),
    0,
  );
  if (!ownerCorpID) {
    return;
  }
  const ownerRecord = getCorporationOwnerRecord(ownerCorpID);
  const ownerCorpName = ownerRecord && ownerRecord.ownerName
    ? String(ownerRecord.ownerName)
    : `Corporation ${ownerCorpID}`;
  createStructureOwnerNotifications(
    structure,
    NOTIFICATION_TYPE.STRUCTURE_DESTROYED,
    {
      ownerCorpName,
      ownerCorpLinkData: [
        "showinfo",
        toPositiveInt(ownerRecord && ownerRecord.typeID, TYPE_CORPORATION) ||
          TYPE_CORPORATION,
        ownerCorpID,
      ],
      isAbandoned:
        toInt(structure && structure.upkeepState, 0) ===
        STRUCTURE_UPKEEP_STATE.ABANDONED,
    },
  );
}

function serviceStateIsOnline(serviceStates, serviceID) {
  return (
    toInt(
      serviceStates && serviceStates[String(serviceID)],
      STRUCTURE_SERVICE_STATE.OFFLINE,
    ) === STRUCTURE_SERVICE_STATE.ONLINE
  );
}

function resolveOfflineServiceModuleTypeIDs(structure, offlineServiceIDs) {
  const serviceIDSet = new Set(
    (Array.isArray(offlineServiceIDs) ? offlineServiceIDs : [])
      .map((serviceID) => toPositiveInt(serviceID, 0))
      .filter(Boolean),
  );
  if (serviceIDSet.size <= 0) {
    return [];
  }
  const structureID = toPositiveInt(structure && structure.structureID, 0);
  const fittedTypeIDs = new Set();
  if (structureID > 0) {
    for (const item of listContainerItems(null, structureID, null)) {
      const typeID = toPositiveInt(item && item.typeID, 0);
      const serviceIDs = SERVICE_IDS_BY_MODULE_TYPE_ID[typeID] || [];
      if (
        isStructureServiceSlotFlag(item && item.flagID) &&
        typeID > 0 &&
        serviceIDs.some((serviceID) => serviceIDSet.has(toPositiveInt(serviceID, 0)))
      ) {
        fittedTypeIDs.add(typeID);
      }
    }
  }
  if (fittedTypeIDs.size > 0) {
    return [...fittedTypeIDs].sort((left, right) => left - right);
  }
  const fallbackTypeIDs = new Set();
  for (const serviceID of serviceIDSet) {
    const mappedTypeIDs = [
      ...new Set(MANAGED_SERVICE_MODULE_TYPE_IDS_BY_SERVICE_ID[String(serviceID)] || []),
    ].filter((typeID) => typeID > 0);
    if (mappedTypeIDs.length === 1) {
      fallbackTypeIDs.add(mappedTypeIDs[0]);
    }
  }
  return [...fallbackTypeIDs].sort((left, right) => left - right);
}

function collectOfflineServiceIDs(previous, next) {
  const offlineServiceIDs = [];
  for (const serviceID of MANAGED_SERVICE_IDS) {
    if (
      serviceStateIsOnline(previous && previous.serviceStates, serviceID) &&
      !serviceStateIsOnline(next && next.serviceStates, serviceID)
    ) {
      offlineServiceIDs.push(serviceID);
    }
  }
  return offlineServiceIDs;
}

function createStructureServicesOfflineNotifications(previous, next) {
  const offlineServiceIDs = collectOfflineServiceIDs(previous, next);
  if (offlineServiceIDs.length <= 0) {
    return;
  }
  const listOfServiceModuleIDs = resolveOfflineServiceModuleTypeIDs(next, offlineServiceIDs);
  if (listOfServiceModuleIDs.length <= 0) {
    return;
  }
  createStructureOwnerNotifications(
    next,
    NOTIFICATION_TYPE.STRUCTURE_SERVICES_OFFLINE,
    { listOfServiceModuleIDs },
  );
}

function cancelStructureMarketOrdersLazily(structure, reason) {
  const structureID = toPositiveInt(structure && structure.structureID, 0);
  if (!structureID) {
    return;
  }

  const task = Promise.resolve()
    .then(async () => {
      const {
        cancelStructureMarketOrdersForServiceLoss,
      } = lazyRequire("../market/marketProxyService");
      if (typeof cancelStructureMarketOrdersForServiceLoss !== "function") {
        return;
      }
      const result = await cancelStructureMarketOrdersForServiceLoss(structure, {
        reason,
        quietDaemonUnavailable: true,
      });
      if (result && result.errorMsg === "MARKET_DAEMON_UNAVAILABLE") {
        log.debug(
          `[StructureState] Deferred market order cancellation for ` +
          `structure=${structureID} reason=${reason || "serviceLoss"}: ` +
          "market daemon unavailable",
        );
        return;
      }
      const cancelledCount = toPositiveInt(
        result && result.cancelledCount,
        0,
      );
      if (cancelledCount > 0) {
        createStructureOwnerNotifications(
          structure,
          NOTIFICATION_TYPE.STRUCTURE_MARKET_ORDERS_CANCELLED,
        );
      }
    })
    .catch((error) => {
      log.warn(
        `[StructureState] Failed to cancel market orders for ` +
        `structure=${structureID} reason=${reason || "serviceLoss"}: ` +
        `${error.message}`,
      );
    });
  pendingMarketOrderCancellationTasks.add(task);
  task.finally(() => pendingMarketOrderCancellationTasks.delete(task));
}

async function awaitPendingMarketOrderCancellationTasksForTests() {
  while (pendingMarketOrderCancellationTasks.size > 0) {
    await Promise.all([...pendingMarketOrderCancellationTasks]);
  }
}

function cancelMarketOrdersForOfflineServices(previous, next) {
  const offlineServiceIDs = collectOfflineServiceIDs(previous, next);
  if (!offlineServiceIDs.includes(STRUCTURE_SERVICE_ID.MARKET)) {
    return;
  }
  cancelStructureMarketOrdersLazily(next, "serviceOffline");
}

function createStructureLifecycleTransitionNotifications(previous, next) {
  const previousState = toInt(previous && previous.state, 0);
  const nextState = toInt(next && next.state, 0);
  if (previousState !== STRUCTURE_STATE.ANCHORING && nextState === STRUCTURE_STATE.ANCHORING) {
    createStructureAnchoringNotifications(next);
  }
  if (
    previousState === STRUCTURE_STATE.ANCHORING &&
    nextState === STRUCTURE_STATE.ONLINING_VULNERABLE &&
    next &&
    next.hasQuantumCore !== true
  ) {
    createStructureOnlineNotifications(next, next.quantumCoreItemTypeID);
  }
  if (
    previousState === STRUCTURE_STATE.ONLINING_VULNERABLE &&
    nextState === STRUCTURE_STATE.SHIELD_VULNERABLE
  ) {
    createStructureOnlineNotifications(next);
  }
}

function maybeCreateStructureTransitionNotifications(previousRows = [], nextRows = []) {
  const previousByID = new Map(
    (Array.isArray(previousRows) ? previousRows : [])
      .map((entry) => [toPositiveInt(entry && entry.structureID, 0), entry])
      .filter(([structureID]) => structureID > 0),
  );
  for (const next of Array.isArray(nextRows) ? nextRows : []) {
    const structureID = toPositiveInt(next && next.structureID, 0);
    const previous = previousByID.get(structureID) || null;
    if (!previous) {
      continue;
    }
    if (toPositiveInt(next && next.destroyedAt, 0) > 0) {
      if (toPositiveInt(previous && previous.destroyedAt, 0) <= 0) {
        cancelStructureMarketOrdersLazily(next, "structureDestroyed");
      }
      continue;
    }
    createStructureOwnershipTransferredNotifications(previous, next);
    const previousUpkeepState = toInt(previous.upkeepState, 0);
    const nextUpkeepState = toInt(next.upkeepState, 0);
    if (previousUpkeepState !== nextUpkeepState) {
      if (
        previousUpkeepState === STRUCTURE_UPKEEP_STATE.FULL_POWER &&
        nextUpkeepState === STRUCTURE_UPKEEP_STATE.LOW_POWER
      ) {
        createStructurePowerStateNotifications(
          next,
          NOTIFICATION_TYPE.STRUCTURE_WENT_LOW_POWER,
        );
      } else if (
        previousUpkeepState !== STRUCTURE_UPKEEP_STATE.FULL_POWER &&
        nextUpkeepState === STRUCTURE_UPKEEP_STATE.FULL_POWER
      ) {
        createStructurePowerStateNotifications(
          next,
          NOTIFICATION_TYPE.STRUCTURE_WENT_HIGH_POWER,
        );
      }
    }
    createStructureLifecycleTransitionNotifications(previous, next);
    createStructureServicesOfflineNotifications(previous, next);
    cancelMarketOrdersForOfflineServices(previous, next);
  }
}

function getStructureByID(structureID, options = {}) {
  if (options.refresh !== false) {
    tickStructures(Date.now());
  }
  return ensureStructureCache().byStructureID.get(toPositiveInt(structureID, 0)) || null;
}

function getStructureByName(name) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return listStructures({
    includeDestroyed: true,
    refresh: false,
  }).find((entry) => String(entry.name || "").trim().toLowerCase() === normalized) || null;
}

function listStructures(options = {}) {
  if (options.refresh !== false) {
    tickStructures(Date.now());
  }
  const includeDestroyed = options.includeDestroyed === true;
  return ensureStructureCache().rows
    .filter((entry) => includeDestroyed || !entry.destroyedAt)
    .map((entry) => cloneValue(entry));
}

function listStructuresForSystem(solarSystemID, options = {}) {
  const numericSystemID = toPositiveInt(solarSystemID, 0);
  if (!numericSystemID) {
    return [];
  }
  return listStructures(options).filter((entry) => entry.solarSystemID === numericSystemID);
}

function listOwnedStructures(ownerCorpID, options = {}) {
  const numericOwnerCorpID = toPositiveInt(ownerCorpID, 0);
  if (!numericOwnerCorpID) {
    return [];
  }
  return listStructures(options).filter((entry) => entry.ownerCorpID === numericOwnerCorpID);
}

function updateStructureRecord(structureID, updater, options = {}) {
  const targetID = toPositiveInt(structureID, 0);
  if (!targetID || typeof updater !== "function") {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const rows = listStructures({
    includeDestroyed: true,
    refresh: false,
  });
  const current = rows.find((entry) => entry.structureID === targetID);
  if (!current) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const next = normalizeStructureRecord(updater(cloneValue(current)) || current);
  if (
    shouldCancelUnanchoringForState(
      next,
      toInt(options.nowMs, Date.now()),
    )
  ) {
    next.unanchoring = null;
  }
  const writeResult = persistStructures(
    rows.map((entry) => (entry.structureID === targetID ? next : entry)),
    {},
    options,
  );
  if (!writeResult.success) {
    return writeResult;
  }

  return {
    success: true,
    data: next,
  };
}

function createStructure(record, options = {}) {
  const cache = ensureStructureCache();
  const structureID = Math.max(NEXT_STRUCTURE_ID_START, cache.meta.nextStructureID || NEXT_STRUCTURE_ID_START);
  const next = normalizeStructureRecord({
    ...record,
    structureID,
  });
  const writeResult = persistStructures([...cache.rows, next], {
    nextStructureID: structureID + 1,
  }, options);
  if (!writeResult.success) {
    return writeResult;
  }

  return {
    success: true,
    data: next,
  };
}

function upsertStructureRecord(record) {
  const next = normalizeStructureRecord(record || {});
  const structureID = toPositiveInt(next && next.structureID, 0);
  if (!structureID) {
    return createStructure(record);
  }

  const cache = ensureStructureCache();
  const rows = cache.rows.map((entry) => cloneValue(entry));
  const index = rows.findIndex((entry) => entry.structureID === structureID);
  if (index >= 0) {
    rows[index] = next;
  } else {
    rows.push(next);
  }

  const writeResult = persistStructures(rows, {
    nextStructureID: Math.max(
      NEXT_STRUCTURE_ID_START,
      cache.meta && cache.meta.nextStructureID ? cache.meta.nextStructureID : NEXT_STRUCTURE_ID_START,
      structureID + 1,
    ),
  });
  if (!writeResult.success) {
    return writeResult;
  }

  return {
    success: true,
    data: next,
  };
}

function setStructureState(structureID, stateNameOrID, options = {}) {
  const numericState =
    typeof stateNameOrID === "string"
      ? (
          Number.isFinite(Number(String(stateNameOrID).trim()))
            ? toInt(stateNameOrID, 0)
            : STRUCTURE_STATE_ID_BY_NAME[String(stateNameOrID).trim().toLowerCase()] || 0
        )
      : toInt(stateNameOrID, 0);
  if (!STRUCTURE_STATE_NAME_BY_ID[numericState]) {
    return {
      success: false,
      errorMsg: "INVALID_STRUCTURE_STATE",
    };
  }
  const nowMs = toInt(options.nowMs, Date.now());
  return updateStructureRecord(structureID, (current) => ({
    ...current,
    state: numericState,
    stateStartedAt: nowMs,
    stateEndsAt:
      options.clearTimer === true
        ? null
        : Number.isFinite(Number(options.stateEndsAt))
        ? toInt(options.stateEndsAt, 0)
        : current.stateEndsAt,
  }), options);
}

function setStructureStateTimerRemaining(structureID, seconds, options = {}) {
  const remainingMs = Math.max(0, Math.round(Math.max(0, toFloat(seconds, 0)) * 1000));
  const nowMs = toInt(options.nowMs, Date.now());
  return updateStructureRecord(structureID, (current) => ({
    ...current,
    stateStartedAt: nowMs,
    stateEndsAt: nowMs + remainingMs,
  }));
}

function setStructureDeployTimerRemaining(structureID, seconds, options = {}) {
  const remainingMs = Math.max(0, Math.round(Math.max(0, toFloat(seconds, 0)) * 1000));
  const nowMs = toInt(options.nowMs, Date.now());
  return updateStructureRecord(structureID, (current) => ({
    ...current,
    state: STRUCTURE_STATE.DEPLOY_VULNERABLE,
    stateStartedAt: nowMs,
    stateEndsAt: nowMs + remainingMs,
  }));
}

function setStructureUnanchoringRemaining(structureID, seconds, options = {}) {
  const current = getStructureByID(structureID, { refresh: false });
  if (!current) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (STRUCTURE_UNANCHOR_CANCEL_STATES.has(toInt(current.state, 0))) {
    return {
      success: false,
      errorMsg: "STRUCTURE_CANNOT_UNANCHOR_IN_STATE",
    };
  }
  const remainingMs = Math.max(0, Math.round(Math.max(0, toFloat(seconds, 0)) * 1000));
  const nowMs = toInt(options.nowMs, Date.now());
  return updateStructureRecord(structureID, (record) => ({
    ...record,
    unanchoring: nowMs + remainingMs,
  }));
}

function setStructureAbandonTimerRemaining(structureID, seconds, options = {}) {
  const current = getStructureByID(structureID, { refresh: false });
  if (!current) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (toInt(current.upkeepState, 0) !== STRUCTURE_UPKEEP_STATE.LOW_POWER) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_LOW_POWER",
    };
  }
  if (!structureAllowsAbandonment(current)) {
    return {
      success: false,
      errorMsg: "STRUCTURE_CANNOT_BE_ABANDONED",
    };
  }
  const remainingMs = Math.max(0, Math.round(Math.max(0, toFloat(seconds, 0)) * 1000));
  const nowMs = toInt(options.nowMs, Date.now());
  return updateStructureRecord(structureID, (record) => ({
    ...record,
    abandonAt: nowMs + remainingMs,
  }));
}

function hasStructureGmBypass(session) {
  if (!session) {
    return false;
  }
  if (config.upwellGmBypassRestrictions === true) {
    return true;
  }
  const role = normalizeRoleValue(session && session.role, 0n);
  return role > 0n && (role & GM_BYPASS_ROLE_MASK) !== 0n;
}

function buildDockAccessPolicy(structure, policyName, session) {
  const profile = structure && structure.accessProfile ? structure.accessProfile : normalizeAccessProfile(null);
  const policy = String(profile[policyName] || "public");
  if (policy === "public") {
    return true;
  }
  if (policy === "none") {
    return false;
  }
  const corpID = toPositiveInt(session && (session.corporationID || session.corpid), 0);
  const allianceID = toPositiveInt(session && (session.allianceID || session.allianceid), 0);
  if (policy === "owner" || policy === "corp") {
    return corpID > 0 && corpID === toPositiveInt(structure && structure.ownerCorpID, 0);
  }
  if (policy === "alliance") {
    const ownerAllianceID = toPositiveInt(structure && structure.allianceID, 0);
    return ownerAllianceID > 0
      ? ownerAllianceID === allianceID
      : corpID > 0 && corpID === toPositiveInt(structure && structure.ownerCorpID, 0);
  }
  return false;
}

function isDockingServiceOnline(structure) {
  if (!structure || !structure.dockable || structure.destroyedAt || structure.unanchoring) {
    return false;
  }
  const state = toInt(structure.state, 0);
  if (
    state !== STRUCTURE_STATE.ONLINING_VULNERABLE &&
    STRUCTURE_DISABLED_STATES.has(state)
  ) {
    return false;
  }
  return toInt(
    structure.serviceStates &&
      structure.serviceStates[String(STRUCTURE_SERVICE_ID.DOCKING)],
    STRUCTURE_SERVICE_STATE.OFFLINE,
  ) === STRUCTURE_SERVICE_STATE.ONLINE;
}

function isStructureTetheringAllowed(structure, session) {
  return Boolean(
    structure &&
      !structure.destroyedAt &&
      structure.hasQuantumCore === true &&
      toInt(structure.upkeepState, 0) !== STRUCTURE_UPKEEP_STATE.ABANDONED &&
      STRUCTURE_TETHER_ENABLED_STATES.has(toInt(structure.state, 0)) &&
      buildDockAccessPolicy(structure, "docking", session),
  );
}

function getShipDockClass(shipTypeID) {
  const metadata =
    resolveShipByTypeID(toPositiveInt(shipTypeID, 0)) ||
    resolveItemByTypeID(toPositiveInt(shipTypeID, 0)) ||
    null;
  const haystack = [
    String(metadata && metadata.groupName || ""),
    String(metadata && metadata.name || ""),
  ].join(" ").toLowerCase();
  if (haystack.includes("titan") || haystack.includes("supercarrier")) {
    return "supercapital";
  }
  if (
    haystack.includes("carrier") ||
    haystack.includes("dreadnought") ||
    haystack.includes("force auxiliary") ||
    haystack.includes("capital industrial")
  ) {
    return "capital";
  }
  return "subcapital";
}

function canShipTypeDockAtStructure(shipTypeID, structure) {
  const typeRecord = getStructureTypeByID(structure && structure.typeID);
  if (!typeRecord || !typeRecord.dockable) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_DOCKABLE",
    };
  }

  const shipClass = getShipDockClass(shipTypeID);
  if (
    typeRecord.structureSize === STRUCTURE_SIZE.MEDIUM &&
    (shipClass === "capital" || shipClass === "supercapital")
  ) {
    return {
      success: false,
      errorMsg: "SHIP_TOO_LARGE_FOR_STRUCTURE",
    };
  }
  if (typeRecord.structureSize === STRUCTURE_SIZE.LARGE && shipClass === "supercapital") {
    return {
      success: false,
      errorMsg: "SHIP_TOO_LARGE_FOR_STRUCTURE",
    };
  }

  if (typeRecord.typeID === 35836) {
    const metadata =
      resolveShipByTypeID(toPositiveInt(shipTypeID, 0)) ||
      resolveItemByTypeID(toPositiveInt(shipTypeID, 0)) ||
      null;
    const groupName = String(metadata && metadata.groupName || "").toLowerCase();
    if (TATARA_EXCLUDED_DOCK_GROUP_NAMES.some((entry) => groupName.includes(entry))) {
      return {
        success: false,
        errorMsg: "SHIP_EXCLUDED_FROM_STRUCTURE",
      };
    }
  }

  return {
    success: true,
    data: {
      shipClass,
      oneWayUndock: (typeRecord.oneWayUndockClasses || []).includes(shipClass),
    },
  };
}

function hasStructureOneWayUndockRestriction(structure, shipTypeID) {
  const typeRecord = getStructureTypeByID(structure && structure.typeID);
  if (!typeRecord) {
    return false;
  }
  return (typeRecord.oneWayUndockClasses || []).includes(getShipDockClass(shipTypeID));
}

function canCharacterDockAtStructure(session, structure, options = {}) {
  if (!structure) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (hasStructureGmBypass(session) || options.ignoreRestrictions === true) {
    return { success: true, data: { bypassed: true } };
  }
  if (!isDockingServiceOnline(structure)) {
    return {
      success: false,
      errorMsg: "STRUCTURE_DOCKING_UNAVAILABLE",
    };
  }
  if (!buildDockAccessPolicy(structure, "docking", session)) {
    return {
      success: false,
      errorMsg: "STRUCTURE_DOCKING_DENIED",
    };
  }
  const shipTypeID = toPositiveInt(options.shipTypeID || (session && session.shipTypeID), 0);
  return shipTypeID > 0 ? canShipTypeDockAtStructure(shipTypeID, structure) : { success: true };
}

function resolveSecurityBand(structure) {
  const system = getSolarSystemRecord(structure && structure.solarSystemID);
  return toFloat(system && system.security, 0) >= 0.45 ? "high" : "low";
}

function getTimerScale(structure) {
  const structureScale = toFloat(structure && structure.devFlags && structure.devFlags.timerScale, 0);
  if (structureScale > 0) {
    return structureScale;
  }
  const configScale = toFloat(config.upwellTimerScale, 0);
  return configScale > 0 ? configScale : 1;
}

function scaledTimerMs(seconds, structure) {
  return Math.max(0, Math.round(Math.max(0, toFloat(seconds, 0)) * getTimerScale(structure) * 1000));
}

function resolveStructureUnanchoringSeconds(structure) {
  const typeID = toPositiveInt(structure && structure.typeID, 0);
  const typeRecord = getStructureTypeByID(typeID);
  const groupID = toPositiveInt(
    typeRecord && typeRecord.groupID,
    toPositiveInt(structure && structure.groupID, 0),
  );
  const family = String(
    (typeRecord && typeRecord.structureFamily) ||
    (structure && structure.structureFamily) ||
    "",
  ).trim().toLowerCase();

  if (groupID === STRUCTURE_GROUP_ID.METENOX || typeID === 81826) {
    return STRUCTURE_TIMER_SECONDS.METENOX_UNANCHORING;
  }
  if (family === STRUCTURE_FAMILY.FLEX) {
    return STRUCTURE_TIMER_SECONDS.FLEX_UNANCHORING;
  }
  return STRUCTURE_TIMER_SECONDS.UNANCHORING;
}

function isStructureUnanchoringCompletionDue(
  structure,
  nowMs = Date.now(),
) {
  const unanchoringAt = Number(structure && structure.unanchoring);
  return Boolean(
    Number.isFinite(unanchoringAt) &&
    unanchoringAt > 0 &&
    toInt(nowMs, Date.now()) >= unanchoringAt,
  );
}

function shouldCancelUnanchoringForState(
  structure,
  nowMs = Date.now(),
) {
  return Boolean(
    structure &&
    structure.unanchoring &&
    !isStructureUnanchoringCompletionDue(structure, nowMs) &&
    STRUCTURE_UNANCHOR_CANCEL_STATES.has(toInt(structure.state, 0)),
  );
}

function repairStructureState(structure, preserveState = false) {
  return {
    ...structure,
    state: preserveState ? structure.state : STRUCTURE_STATE.SHIELD_VULNERABLE,
    stateStartedAt: Date.now(),
    stateEndsAt: preserveState ? structure.stateEndsAt : null,
    timerPausedAt: preserveState ? structure.timerPausedAt : null,
    conditionState: normalizeConditionState({
      damage: 0,
      charge: structure.conditionState && structure.conditionState.charge,
      armorDamage: 0,
      shieldCharge: 1,
    }),
  };
}

function isStructureFullyRepaired(structure) {
  const condition = structure && structure.conditionState
    ? normalizeConditionState(structure.conditionState)
    : normalizeConditionState(null);
  return (
    condition.damage <= 0 &&
    condition.armorDamage <= 0 &&
    condition.shieldCharge >= 1 &&
    Number((structure && structure.stateEndsAt) || 0) <= 0
  );
}

function isStructureRepairLayerDamaged(structure) {
  const state = toInt(structure && structure.state, 0);
  const condition = normalizeConditionState(structure && structure.conditionState);
  if (state === STRUCTURE_STATE.SHIELD_VULNERABLE) {
    return condition.shieldCharge < 1;
  }
  if (state === STRUCTURE_STATE.ARMOR_VULNERABLE) {
    return condition.armorDamage > 0;
  }
  if (
    state === STRUCTURE_STATE.HULL_VULNERABLE ||
    state === STRUCTURE_STATE.ANCHOR_VULNERABLE ||
    state === STRUCTURE_STATE.DEPLOY_VULNERABLE
  ) {
    return condition.damage > 0;
  }
  if (state === STRUCTURE_STATE.ONLINING_VULNERABLE) {
    return (
      structure &&
      structure.hasQuantumCore === true &&
      (
        condition.damage > 0 ||
        condition.armorDamage > 0 ||
        condition.shieldCharge < 1
      )
    );
  }
  return false;
}

function isStructureRepairLayerDamageApplied(structure, beforeLayers = {}, afterLayers = {}) {
  const state = toInt(structure && structure.state, 0);
  if (state === STRUCTURE_STATE.SHIELD_VULNERABLE) {
    return toFloat(afterLayers.shield, 0) < toFloat(beforeLayers.shield, 0);
  }
  if (state === STRUCTURE_STATE.ARMOR_VULNERABLE) {
    return toFloat(afterLayers.armor, 0) < toFloat(beforeLayers.armor, 0);
  }
  if (
    state === STRUCTURE_STATE.HULL_VULNERABLE ||
    state === STRUCTURE_STATE.ANCHOR_VULNERABLE ||
    state === STRUCTURE_STATE.DEPLOY_VULNERABLE ||
    state === STRUCTURE_STATE.ONLINING_VULNERABLE
  ) {
    return toFloat(afterLayers.structure, 0) < toFloat(beforeLayers.structure, 0);
  }
  return false;
}

function resolveStructureRepairingValue(structure) {
  const state = toInt(structure && structure.state, 0);
  if (!STRUCTURE_VULNERABLE_STATES.has(state)) {
    return null;
  }
  const stateEndsAt = Number(structure && structure.stateEndsAt);
  if (!Number.isFinite(stateEndsAt) || stateEndsAt <= 0) {
    return null;
  }
  const pauseAt = Number(structure && structure.timerPausedAt);
  if (state === STRUCTURE_STATE.ANCHOR_VULNERABLE) {
    return Number.isFinite(pauseAt) && pauseAt > 0 ? false : true;
  }
  if (!isStructureRepairLayerDamaged(structure)) {
    return null;
  }
  return Number.isFinite(pauseAt) && pauseAt > 0 ? false : true;
}

function applyStructureRepairTimerForDamage(structure, beforeLayers, afterLayers, nowMs) {
  if (!STRUCTURE_VULNERABLE_STATES.has(toInt(structure && structure.state, 0))) {
    return structure;
  }
  if (!isStructureRepairLayerDamageApplied(structure, beforeLayers, afterLayers)) {
    return structure;
  }
  if (!isStructureRepairLayerDamaged(structure)) {
    return structure;
  }
  const repairSeconds = toFloat(
    STRUCTURE_REPAIR_SECONDS_BY_STATE[toInt(structure && structure.state, 0)],
    0,
  );
  if (repairSeconds <= 0) {
    return structure;
  }
  const currentStateStartedAt = toPositiveInt(structure.stateStartedAt, 0);
  const currentStateEndsAt = toPositiveInt(structure.stateEndsAt, 0);
  if (currentStateStartedAt > 0 && currentStateEndsAt > nowMs) {
    const previousPauseAt = toPositiveInt(structure.timerPausedAt, currentStateStartedAt);
    const elapsedSincePauseMs = Math.max(0, nowMs - previousPauseAt);
    return {
      ...structure,
      stateEndsAt: currentStateEndsAt + elapsedSincePauseMs,
      timerPausedAt: nowMs,
    };
  }
  return {
    ...structure,
    stateStartedAt: nowMs,
    stateEndsAt: nowMs + scaledTimerMs(repairSeconds, structure),
    timerPausedAt: nowMs,
  };
}

function maybeApplyQueuedReinforcementTiming(structure, nowMs = Date.now()) {
  const nextApplyMs = Number(structure && structure.nextReinforceApply);
  if (
    !structure ||
    structure.destroyedAt ||
    !Number.isFinite(nextApplyMs) ||
    nextApplyMs <= 0 ||
    nowMs < nextApplyMs ||
    structure.nextReinforceWeekday === null ||
    structure.nextReinforceWeekday === undefined ||
    structure.nextReinforceHour === null ||
    structure.nextReinforceHour === undefined
  ) {
    return { structure, changed: false };
  }

  if (!isStructureFullyRepaired(structure)) {
    return { structure, changed: false };
  }

  return {
    structure: {
      ...structure,
      reinforceWeekday: toInt(structure.nextReinforceWeekday, structure.reinforceWeekday),
      reinforceHour: toInt(structure.nextReinforceHour, structure.reinforceHour),
      nextReinforceWeekday: null,
      nextReinforceHour: null,
      nextReinforceApply: null,
    },
    changed: true,
  };
}

function buildOnliningVulnerableStructure(structure, nowMs) {
  const hasCore = structure && structure.hasQuantumCore === true;
  return {
    ...structure,
    state: STRUCTURE_STATE.ONLINING_VULNERABLE,
    stateStartedAt: nowMs,
    stateEndsAt: hasCore
      ? nowMs + scaledTimerMs(
        STRUCTURE_REPAIR_SECONDS_BY_STATE[STRUCTURE_STATE.ONLINING_VULNERABLE],
        structure,
      )
      : null,
  };
}

function maybeAdvanceStructureState(structure, nowMs = Date.now()) {
  const stateEndsAt = Number(structure && structure.stateEndsAt);
  if (
    structure &&
    !structure.destroyedAt &&
    structure.state === STRUCTURE_STATE.ANCHORING &&
    (
      structure.stateEndsAt === null ||
      structure.stateEndsAt === undefined ||
      !Number.isFinite(stateEndsAt) ||
      stateEndsAt <= 0
    )
  ) {
    return {
      structure: buildOnliningVulnerableStructure(structure, nowMs),
      changed: true,
    };
  }
  if (
    !structure ||
    structure.destroyedAt ||
    structure.stateEndsAt === null ||
    structure.stateEndsAt === undefined ||
    !Number.isFinite(stateEndsAt) ||
    stateEndsAt <= 0 ||
    nowMs < stateEndsAt
  ) {
    return { structure, changed: false };
  }
  if (structure.state === STRUCTURE_STATE.ANCHOR_VULNERABLE) {
    return {
      structure: {
        ...structure,
        state: STRUCTURE_STATE.ANCHORING,
        stateStartedAt: nowMs,
        stateEndsAt: nowMs + scaledTimerMs(STRUCTURE_TIMER_SECONDS.ANCHORING, structure),
      },
      changed: true,
    };
  }
  if (structure.state === STRUCTURE_STATE.ANCHORING) {
    return {
      structure: buildOnliningVulnerableStructure(structure, nowMs),
      changed: true,
    };
  }
  if (structure.state === STRUCTURE_STATE.ONLINING_VULNERABLE) {
    if (structure.hasQuantumCore !== true) {
      return {
        structure: {
          ...structure,
          stateEndsAt: null,
        },
        changed: structure.stateEndsAt !== null && structure.stateEndsAt !== undefined,
      };
    }
    return {
      structure: {
        ...repairStructureState(structure),
        state: STRUCTURE_STATE.SHIELD_VULNERABLE,
        stateStartedAt: nowMs,
        stateEndsAt: null,
      },
      changed: true,
    };
  }
  if (structure.state === STRUCTURE_STATE.ARMOR_REINFORCE || structure.state === STRUCTURE_STATE.HULL_REINFORCE) {
    const nextState =
      structure.state === STRUCTURE_STATE.ARMOR_REINFORCE
        ? STRUCTURE_STATE.ARMOR_VULNERABLE
        : STRUCTURE_STATE.HULL_VULNERABLE;
    return {
      structure: {
        ...structure,
        state: nextState,
        stateStartedAt: nowMs,
        stateEndsAt: nowMs + scaledTimerMs(
          STRUCTURE_REPAIR_SECONDS_BY_STATE[nextState],
          structure,
        ),
      },
      changed: true,
    };
  }
  if (STRUCTURE_VULNERABLE_STATES.has(structure.state)) {
    return {
      structure: {
        ...repairStructureState(structure),
        stateStartedAt: nowMs,
        stateEndsAt: null,
      },
      changed: true,
    };
  }
  return { structure, changed: false };
}

function tickMoonExtractions(nowMs = Date.now()) {
  try {
    const MoonExtractionsService = lazyRequire("./moonExtractionsService");
    if (typeof MoonExtractionsService.tickExtractions !== "function") {
      return;
    }
    MoonExtractionsService.tickExtractions(nowMs);
  } catch (error) {
    log.warn(`[StructureState] Moon extraction timer tick failed: ${error.message}`);
  }
}

function tickStructures(nowMs = Date.now()) {
  tickMoonExtractions(nowMs);
  const cache = ensureStructureCache();
  const nextRows = [];
  const pendingFuelAlerts = [];
  const pendingReagentAlerts = [];
  const pendingWarHQLossStructures = [];
  let changed = false;
  for (const structure of cache.rows) {
    let current = cloneValue(structure);
    const flexFuelTick = structureFlexFuelRuntime.applyFlexServiceFuelCycle(
      current,
      nowMs,
      { structureProximityCandidates: cache.rows },
    );
    current = flexFuelTick.structure;
    if (
      flexFuelTick &&
      flexFuelTick.fuelResult &&
      flexFuelTick.fuelResult.success !== true
    ) {
      pendingFuelAlerts.push({
        structure: current,
        listOfTypesAndQty: flexFuelTick.fuelResult.fuelAlertTypesAndQty,
      });
    }
    changed = changed || flexFuelTick.changed === true;

    const autoMoonFuelTick = structureAutoMoonFuelRuntime.applyAutoMoonMinerFuelCycle(
      current,
      nowMs,
    );
    current = autoMoonFuelTick.structure;
    if (
      autoMoonFuelTick &&
      autoMoonFuelTick.fuelResult &&
      autoMoonFuelTick.fuelResult.success !== true
    ) {
      const reagentAlertType = resolveAutoMoonReagentAlertType(
        autoMoonFuelTick.fuelResult,
      );
      if (reagentAlertType) {
        pendingReagentAlerts.push({
          structure: current,
          typeID: reagentAlertType,
        });
      }
      const fuelAlertTypesAndQty = resolveAutoMoonFuelAlertTypesAndQty(
        autoMoonFuelTick.fuelResult,
      );
      if (fuelAlertTypesAndQty.length > 0) {
        pendingFuelAlerts.push({
          structure: current,
          listOfTypesAndQty: fuelAlertTypesAndQty,
        });
      }
    }
    changed = changed || autoMoonFuelTick.changed === true;

    if (current.destroyedAt && current.unanchoring) {
      current.unanchoring = null;
      changed = true;
    } else if (shouldCancelUnanchoringForState(current, nowMs)) {
      current.unanchoring = null;
      changed = true;
    }
    const abandonAt = Number(current.abandonAt);
    const hasAbandonTimer = Number.isFinite(abandonAt) && abandonAt > 0;
    const currentUpkeepState = toInt(current.upkeepState, 0);
    if (hasAbandonTimer) {
      if (
        currentUpkeepState !== STRUCTURE_UPKEEP_STATE.LOW_POWER ||
        !structureAllowsAbandonment(current)
      ) {
        current.abandonAt = null;
        current.abandonmentWarningAbandonAt = null;
        current.abandonmentWarningRecipients = [];
        changed = true;
      } else if (nowMs >= abandonAt) {
        current.upkeepState = STRUCTURE_UPKEEP_STATE.ABANDONED;
        current.abandonAt = null;
        current.abandonmentWarningAbandonAt = null;
        current.abandonmentWarningRecipients = [];
        changed = true;
      } else if (maybeCreateImpendingAbandonNotifications(current, nowMs)) {
        changed = true;
      }
    } else if (
      currentUpkeepState === STRUCTURE_UPKEEP_STATE.LOW_POWER &&
      structureAllowsAbandonment(current)
    ) {
      current.abandonAt = resolveStructureAbandonAtFromFuelAnchor(nowMs);
      current.abandonmentWarningAbandonAt = null;
      current.abandonmentWarningRecipients = [];
      changed = true;
    }
    if (
      !current.destroyedAt &&
      current.unanchoring &&
      Number.isFinite(Number(current.unanchoring)) &&
      Number(current.unanchoring) > 0 &&
      nowMs >= Number(current.unanchoring)
    ) {
      const recoveryResult = structureDockedRecoveryState.evacuateDockedCharactersFromStructure(
        current,
        { nowMs: toInt(nowMs, Date.now()) },
      );
      if (!recoveryResult.success) {
        nextRows.push(current);
        log.warn(
          `[StructureState] Failed to finalize unanchoring for ${current.structureID}: ${recoveryResult.errorMsg}`,
        );
        continue;
      }

      const assetHandoffResult = structureAssetSafetyState.handleStructureUnanchored(
        current,
        { nowMs: toInt(nowMs, Date.now()), session: null },
      );
      if (!assetHandoffResult.success) {
        nextRows.push(current);
        log.warn(
          `[StructureState] Failed to hand off assets while finalizing unanchoring for ${current.structureID}: ${assetHandoffResult.errorMsg}`,
        );
        continue;
      }

      const remainingTopLevelItems = listTopLevelItemsInStructure(current.structureID);
      if (remainingTopLevelItems.length > 0) {
        nextRows.push(current);
        log.warn(
          `[StructureState] Delaying unanchoring completion for ${current.structureID}: structure still has ${remainingTopLevelItems.length} top-level item(s)`,
        );
        continue;
      }

      removeJumpClonesForStructureLifecycle(current, "structureUnanchored");
      pendingWarHQLossStructures.push(cloneValue(current));
      changed = true;
      continue;
    }

    const reinforcementTiming = maybeApplyQueuedReinforcementTiming(current, nowMs);
    current = reinforcementTiming.structure;
    changed = changed || reinforcementTiming.changed;

    const next = maybeAdvanceStructureState(current, nowMs);
    nextRows.push(next.structure);
    changed = changed || next.changed;
  }
  if (changed) {
    const writeResult = persistStructures(nextRows);
    if (!writeResult.success) {
      log.warn(`[StructureState] Failed to persist timer tick: ${writeResult.errorMsg}`);
    } else {
      for (const alert of pendingFuelAlerts) {
        createStructureFuelAlertNotifications(
          alert.structure,
          alert.listOfTypesAndQty,
        );
      }
      for (const alert of pendingReagentAlerts) {
        createStructureReagentAlertNotifications(alert.structure, alert.typeID);
      }
      for (const structure of pendingWarHQLossStructures) {
        endWarsForLostWarHQLazily(structure, {
          nowMs,
          reason: "structureUnanchored",
        });
      }
    }
  }
  return listStructures({
    includeDestroyed: true,
    refresh: false,
  });
}

function seedStructureForSession(session, typeToken, options = {}) {
  const typeMap = {
    astrahus: 35832,
    fortizar: 35833,
    keepstar: 35834,
    palatine: 40340,
    raitaru: 35825,
    azbel: 35826,
    sotiyo: 35827,
    athanor: 35835,
    tatara: 35836,
  };
  const typeID = typeMap[String(typeToken || "").trim().toLowerCase()] || toPositiveInt(typeToken, 0);
  const typeRecord = getStructureTypeByID(typeID);
  if (!typeRecord) {
    return {
      success: false,
      errorMsg: "STRUCTURE_TYPE_NOT_FOUND",
    };
  }

  return createStructure({
      typeID,
      name: options.name || typeRecord.name,
      itemName: options.itemName || options.name || typeRecord.name,
      ownerCorpID: toPositiveInt(options.ownerCorpID || (session && (session.corporationID || session.corpid)), 1000009),
      allianceID: toPositiveInt(options.allianceID || (session && (session.allianceID || session.allianceid)), 0) || null,
      solarSystemID: toPositiveInt(options.solarSystemID || (session && (session.solarsystemid2 || session.solarsystemid)), 30000142),
      position: normalizePosition(options.position, { x: 100000, y: 0, z: 100000 }),
      rotation: normalizeRotation(options.rotation),
      state: STRUCTURE_STATE.UNANCHORED,
      upkeepState: STRUCTURE_UPKEEP_STATE.FULL_POWER,
      hasQuantumCore: false,
      quantumCoreItemTypeID: typeRecord.defaultQuantumCoreTypeID,
      profileID: toPositiveInt(options.profileID, 1),
      reinforceWeekday: toInt(options.reinforceWeekday, DEFAULT_REINFORCE_WEEKDAY),
      reinforceHour: toInt(options.reinforceHour, DEFAULT_REINFORCE_HOUR),
      devFlags: {
        seeded: true,
        ...(options.devFlags || {}),
      },
    });
}

function startAnchoring(structureID, nowMs = Date.now(), options = {}) {
  return updateStructureRecord(structureID, (current) => ({
    ...current,
    state: STRUCTURE_STATE.ANCHOR_VULNERABLE,
    stateStartedAt: nowMs,
    stateEndsAt: nowMs + scaledTimerMs(
      STRUCTURE_REPAIR_SECONDS_BY_STATE[STRUCTURE_STATE.ANCHOR_VULNERABLE],
      current,
    ),
    destroyedAt: null,
    conditionState: normalizeConditionState({
      damage: 0,
      armorDamage: 0,
      shieldCharge: 0,
    }),
  }), options);
}

function startStructureUnanchoring(structureID, nowMs = Date.now()) {
  const current = getStructureByID(structureID, { refresh: false });
  if (!current) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (current.destroyedAt) {
    return {
      success: false,
      errorMsg: "STRUCTURE_DESTROYED",
    };
  }
  if (isStructureUnanchoringCompletionDue(current, nowMs)) {
    return {
      success: false,
      errorMsg: "STRUCTURE_UNANCHORING_COMPLETION_PENDING",
    };
  }
  if (STRUCTURE_UNANCHOR_CANCEL_STATES.has(toInt(current.state, 0))) {
    return {
      success: false,
      errorMsg: "STRUCTURE_CANNOT_UNANCHOR_IN_STATE",
    };
  }
  if (
    current.unanchoring &&
    Number.isFinite(Number(current.unanchoring)) &&
    Number(current.unanchoring) > nowMs
  ) {
    return {
      success: true,
      data: current,
    };
  }

  const updateResult = updateStructureRecord(structureID, (record) => ({
    ...record,
    unanchoring: nowMs + scaledTimerMs(
      resolveStructureUnanchoringSeconds(record),
      record,
    ),
  }));
  if (updateResult && updateResult.success === true) {
    createStructureUnanchoringNotifications(updateResult.data, nowMs);
  }
  return updateResult;
}

function cancelStructureUnanchoring(structureID, options = {}) {
  const nowMs = toInt(options.nowMs, Date.now());
  const current = getStructureByID(structureID, { refresh: false });
  if (!current) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (!current.unanchoring) {
    return {
      success: true,
      data: {
        ...current,
        cancelled: false,
      },
    };
  }
  if (isStructureUnanchoringCompletionDue(current, nowMs)) {
    return {
      success: false,
      errorMsg: "STRUCTURE_UNANCHORING_COMPLETION_PENDING",
    };
  }

  const updateResult = updateStructureRecord(structureID, (record) => ({
    ...record,
    unanchoring: null,
  }), options);
  if (!updateResult.success) {
    return updateResult;
  }

  return {
    success: true,
    data: {
      ...updateResult.data,
      cancelled: true,
    },
  };
}

function removeJumpClonesForStructureLifecycle(structure, reason, options = {}) {
  const structureID = toPositiveInt(structure && structure.structureID, 0);
  if (!structureID) {
    return null;
  }
  try {
    const {
      removeJumpClonesAtStructure,
    } = lazyRequire("../station/jumpCloneRuntime");
    const result = removeJumpClonesAtStructure(structureID, {
      reason,
      destroyerID:
        toPositiveInt(options.destroyerID, 0) ||
        toPositiveInt(
          options.session && (
            options.session.characterID ||
            options.session.charid
          ),
          0,
        ) ||
        toPositiveInt(structure.ownerID || structure.ownerCorpID, 0),
    });
    if (result && result.success === false) {
      log.warn(
        `[StructureState] Jump clone cleanup failed structure=${structureID} reason=${reason} error=${result.errorMsg || "UNKNOWN"}`,
      );
    }
    return result;
  } catch (error) {
    log.warn(
      `[StructureState] Jump clone cleanup threw structure=${structureID} reason=${reason} error=${error.message}`,
    );
    return {
      success: false,
      errorMsg: "JUMP_CLONE_CLEANUP_FAILED",
    };
  }
}

function setStructureQuantumCoreInstalled(structureID, installed, nowMs = Date.now()) {
  const hasActiveTimer =
    (current) => (
      current &&
      current.stateEndsAt !== null &&
      current.stateEndsAt !== undefined &&
      Number.isFinite(Number(current.stateEndsAt)) &&
      Number(current.stateEndsAt) > 0
    );
  return updateStructureRecord(structureID, (current) => {
    const shouldStartOnliningRepair =
      installed === true &&
      !hasActiveTimer(current) &&
      (
        current.state === STRUCTURE_STATE.ANCHORING ||
        current.state === STRUCTURE_STATE.ONLINING_VULNERABLE
      );
    return {
      ...current,
      hasQuantumCore: installed === true,
      state: shouldStartOnliningRepair
        ? STRUCTURE_STATE.ONLINING_VULNERABLE
        : current.state,
      stateStartedAt: shouldStartOnliningRepair
        ? nowMs
        : current.stateStartedAt,
      stateEndsAt: shouldStartOnliningRepair
        ? nowMs + scaledTimerMs(
          STRUCTURE_REPAIR_SECONDS_BY_STATE[STRUCTURE_STATE.ONLINING_VULNERABLE],
          current,
        )
        : installed !== true && current.state === STRUCTURE_STATE.ONLINING_VULNERABLE
          ? null
          : current.stateEndsAt,
    };
  });
}

function setStructureUpkeepState(structureID, upkeepState) {
  const numericUpkeepState =
    typeof upkeepState === "string"
      ? STRUCTURE_UPKEEP_ID_BY_NAME[String(upkeepState).trim().toLowerCase()] || 0
      : toInt(upkeepState, 0);
  if (!STRUCTURE_UPKEEP_NAME_BY_ID[numericUpkeepState]) {
    return {
      success: false,
      errorMsg: "INVALID_UPKEEP_STATE",
    };
  }
  return updateStructureRecord(structureID, (current) => ({
    ...current,
    upkeepState: numericUpkeepState,
  }));
}

function setStructureServiceState(structureID, serviceID, serviceState, options = {}) {
  const numericServiceID = toPositiveInt(serviceID, 0);
  if (!numericServiceID) {
    return {
      success: false,
      errorMsg: "INVALID_SERVICE_ID",
    };
  }
  const beforeStructure = getStructureByID(structureID, { refresh: false });
  if (!beforeStructure) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  const autoMoonServiceTransition = structureAutoMoonFuelRuntime
    .prepareAutoMoonMinerServiceStateTransition(
      beforeStructure,
      numericServiceID,
      serviceState,
      options,
    );
  if (!autoMoonServiceTransition || autoMoonServiceTransition.success !== true) {
    return {
      success: false,
      errorMsg: autoMoonServiceTransition && autoMoonServiceTransition.errorMsg
        ? autoMoonServiceTransition.errorMsg
        : "NOT_ENOUGH_FUEL",
      fuelResult: autoMoonServiceTransition && autoMoonServiceTransition.fuelResult
        ? autoMoonServiceTransition.fuelResult
        : null,
    };
  }
  const flexServiceTransition = structureFlexFuelRuntime.prepareFlexServiceStateTransition(
    beforeStructure,
    numericServiceID,
    serviceState,
    {
      ...options,
      structureProximityCandidates: listStructuresForSystem(
        beforeStructure.solarSystemID,
        { includeDestroyed: true, refresh: false },
      ),
    },
  );
  if (!flexServiceTransition || flexServiceTransition.success !== true) {
    return {
      success: false,
      errorMsg: flexServiceTransition && flexServiceTransition.errorMsg
        ? flexServiceTransition.errorMsg
        : "NOT_ENOUGH_FUEL",
      fuelResult: flexServiceTransition && flexServiceTransition.fuelResult
        ? flexServiceTransition.fuelResult
        : null,
      requiredUpgradeTypeID: flexServiceTransition &&
        flexServiceTransition.requiredUpgradeTypeID
        ? flexServiceTransition.requiredUpgradeTypeID
        : null,
    };
  }
  const updateResult = updateStructureRecord(structureID, (current) => ({
    ...current,
    ...(autoMoonServiceTransition.patch || {}),
    ...(flexServiceTransition.patch || {}),
    serviceStates: {
      ...(current.serviceStates || {}),
      [String(numericServiceID)]:
        toInt(serviceState, STRUCTURE_SERVICE_STATE.OFFLINE) === STRUCTURE_SERVICE_STATE.ONLINE
          ? STRUCTURE_SERVICE_STATE.ONLINE
          : STRUCTURE_SERVICE_STATE.OFFLINE,
    },
  }));
  if (!updateResult.success) {
    return updateResult;
  }
  return {
    ...updateResult,
    fuelResult:
      autoMoonServiceTransition.fuelResult ||
      flexServiceTransition.fuelResult ||
      null,
    industryJobSync: syncIndustryJobsForServiceStateTransition(
      structureID,
      beforeStructure && beforeStructure.serviceStates,
      updateResult.data && updateResult.data.serviceStates,
    ),
  };
}

function repairStructure(structureID) {
  return updateStructureRecord(structureID, (current) => repairStructureState({
    ...current,
    stateEndsAt: null,
  }));
}

function fastForwardStructure(structureID, seconds) {
  const deltaMs = Math.max(0, Math.round(Math.max(0, toFloat(seconds, 0)) * 1000));
  return updateStructureRecord(structureID, (current) => ({
    ...current,
    stateStartedAt: Number.isFinite(Number(current.stateStartedAt))
      ? toInt(current.stateStartedAt, 0) - deltaMs
      : current.stateStartedAt,
    stateEndsAt: Number.isFinite(Number(current.stateEndsAt))
      ? toInt(current.stateEndsAt, 0) - deltaMs
      : current.stateEndsAt,
    devFlags: (
      current &&
      current.devFlags &&
      current.devFlags.flexFuelState &&
      Number.isFinite(Number(current.devFlags.flexFuelState.cynoJamActivatesAt))
    )
      ? {
          ...current.devFlags,
          flexFuelState: {
            ...current.devFlags.flexFuelState,
            cynoJamActivatesAt: toInt(
              current.devFlags.flexFuelState.cynoJamActivatesAt,
              0,
            ) - deltaMs,
          },
        }
      : current.devFlags,
  }));
}

function setStructureTimerScale(structureID, timerScale) {
  const normalizedScale = toFloat(timerScale, 0);
  if (!(normalizedScale > 0)) {
    return {
      success: false,
      errorMsg: "INVALID_TIMER_SCALE",
    };
  }

  return updateStructureRecord(structureID, (current) => ({
    ...current,
    devFlags: {
      ...(current.devFlags || {}),
      timerScale: normalizedScale,
    },
  }));
}

function removeStructure(structureID, options = {}) {
  const targetID = toPositiveInt(structureID, 0);
  if (!targetID) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const rows = listStructures({
    includeDestroyed: true,
    refresh: false,
  });
  const existing = rows.find((entry) => entry.structureID === targetID);
  if (!existing) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const recoveryResult = structureDockedRecoveryState.evacuateDockedCharactersFromStructure(
    existing,
    {
      nowMs: toInt(options.nowMs, Date.now()),
    },
  );
  if (!recoveryResult.success) {
    return recoveryResult;
  }

  let remainingTopLevelItems = listTopLevelItemsInStructure(targetID);
  const removedTopLevelItemIDs = [];
  if (remainingTopLevelItems.length > 0 && options.discardContents === true) {
    for (const item of remainingTopLevelItems) {
      const itemID = toPositiveInt(item && item.itemID, 0);
      if (!itemID) {
        continue;
      }
      const removeItemResult = removeInventoryItem(itemID, {
        removeContents: true,
      });
      if (!removeItemResult.success) {
        return removeItemResult;
      }
      removedTopLevelItemIDs.push(itemID);
    }
    remainingTopLevelItems = listTopLevelItemsInStructure(targetID);
  }
  if (remainingTopLevelItems.length > 0) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_EMPTY",
    };
  }

  const writeResult = persistStructures(
    rows.filter((entry) => entry.structureID !== targetID),
  );
  if (!writeResult.success) {
    return writeResult;
  }
  endWarsForLostWarHQLazily(existing, {
    nowMs: toInt(options.nowMs, Date.now()),
    reason: "structureRemoved",
  });

  return {
    success: true,
    data: {
      ...existing,
      removedTopLevelItemIDs,
    },
  };
}

function destroyStructure(structureID, options = {}) {
  const nowMs = toInt(options.nowMs, Date.now());
  const current = getStructureByID(structureID, { refresh: false });
  if (!current) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  if (
    !current.destroyedAt &&
    isStructureUnanchoringCompletionDue(current, nowMs)
  ) {
    return {
      success: false,
      errorMsg: "STRUCTURE_UNANCHORING_COMPLETION_PENDING",
    };
  }

  let assetSafetyResult = null;
  let recoveryResult = null;
  let lootResult = null;
  let jumpCloneCleanupResult = null;
  let industryJobCancelResult = null;
  if (!current.destroyedAt) {
    recoveryResult = structureDockedRecoveryState.evacuateDockedCharactersFromStructure(
      current,
      {
        nowMs,
      },
    );
    industryJobCancelResult = cancelIndustryJobsForStructureLifecycle(
      current.structureID,
      {
        nowFiletime: options.nowFiletime,
        completedCharacterID: options.completedCharacterID,
        session: options.session,
      },
    );
    if (industryJobCancelResult && industryJobCancelResult.success === false) {
      log.warn(
        `[StructureState] Failed to cancel industry jobs for destroyed structure ${current.structureID}: ${industryJobCancelResult.errorMsg || "UNKNOWN"}`,
      );
      return industryJobCancelResult;
    }
  }

  let assetSafetyDisabled = false;
  if (options.skipAssetSafety !== true && !current.destroyedAt) {
    assetSafetyResult = structureAssetSafetyState.handleStructureDestroyed(
      current,
      {
        nowMs,
        session: options.session,
      },
    );
    if (assetSafetyResult && !assetSafetyResult.success) {
      if (assetSafetyResult.errorMsg === "ASSET_SAFETY_DISABLED") {
        assetSafetyDisabled = true;
      }
      log.warn(
        `[StructureState] Asset safety handoff failed for structure ${current.structureID}: ${assetSafetyResult.errorMsg}`,
      );
    }
  }
  if (!current.destroyedAt) {
    lootResult = structureDestructionLootState.handleStructureDestroyedLoot(
      current,
      {
        nowMs,
        includeStructureContents: assetSafetyDisabled,
        includeQuantumCore: true,
      },
    );
    jumpCloneCleanupResult = removeJumpClonesForStructureLifecycle(
      current,
      "structureDestroyed",
      options,
    );
  }

  const updateResult = updateStructureRecord(structureID, (currentStructure) => ({
    ...currentStructure,
    destroyedAt: nowMs,
    unanchoring: null,
    stateEndsAt: null,
    hasQuantumCore: false,
    serviceStates: Object.fromEntries(
      Object.keys(currentStructure.serviceStates || {}).map((serviceID) => [
        String(serviceID),
        STRUCTURE_SERVICE_STATE.OFFLINE,
      ]),
    ),
  }));
  if (!updateResult.success) {
    return updateResult;
  }
  if (!current.destroyedAt) {
    endWarsForLostWarHQLazily(current, {
      nowMs,
      nowFiletime: options.nowFiletime,
      reason: "structureDestroyed",
    });
    createStructureDestroyedNotifications(current);
  }

  return {
    success: true,
    data: {
      ...updateResult.data,
      assetSafety:
        assetSafetyResult && assetSafetyResult.success && assetSafetyResult.data
          ? assetSafetyResult.data
          : null,
      dockedRecovery:
        recoveryResult && recoveryResult.success && recoveryResult.data
          ? recoveryResult.data
          : null,
      loot:
        lootResult && lootResult.success && lootResult.data
          ? lootResult.data
          : null,
      jumpCloneCleanup:
        jumpCloneCleanupResult && jumpCloneCleanupResult.success !== false
          ? jumpCloneCleanupResult
          : null,
      industryJobCancel:
        industryJobCancelResult && industryJobCancelResult.success !== false
          ? industryJobCancelResult
          : null,
    },
  };
}

function applyStructureDamageTransition(structure, damageResult, nowMs = Date.now()) {
  if (!structure || !damageResult || !damageResult.success || !damageResult.data) {
    return { structure, preventDestroy: false, destroy: false, changed: false };
  }

  const next = normalizeStructureRecord({
    ...structure,
    conditionState: damageResult.data.afterConditionState,
  });
  const before = damageResult.data.beforeLayers || {};
  const after = damageResult.data.afterLayers || {};
  const shieldBroke = Number(before.shield || 0) > 0 && Number(after.shield || 0) <= 1e-9;
  const armorBroke = Number(before.armor || 0) > 0 && Number(after.armor || 0) <= 1e-9;
  const destroyed = damageResult.data.destroyed === true;

  if (next.upkeepState === STRUCTURE_UPKEEP_STATE.ABANDONED) {
    return { structure: next, preventDestroy: false, destroy: destroyed, changed: true };
  }

  if (next.state === STRUCTURE_STATE.SHIELD_VULNERABLE && shieldBroke) {
    const reinforceState =
      next.structureSize === STRUCTURE_SIZE.MEDIUM ||
      next.upkeepState === STRUCTURE_UPKEEP_STATE.FULL_POWER
        ? STRUCTURE_STATE.ARMOR_REINFORCE
        : STRUCTURE_STATE.HULL_REINFORCE;
    const reinforcedStructure = {
      ...next,
      state: reinforceState,
      stateStartedAt: nowMs,
      stateEndsAt: nowMs + scaledTimerMs(
        reinforceState === STRUCTURE_STATE.ARMOR_REINFORCE
          ? resolveSecurityBand(next) === "high"
            ? STRUCTURE_TIMER_SECONDS.ARMOR_REINFORCE_HIGH
            : next.structureSize === STRUCTURE_SIZE.MEDIUM
            ? STRUCTURE_TIMER_SECONDS.ARMOR_REINFORCE_NULL_LOW
            : STRUCTURE_TIMER_SECONDS.ARMOR_REINFORCE_DEFAULT
          : resolveSecurityBand(next) === "high"
          ? STRUCTURE_TIMER_SECONDS.HULL_REINFORCE_HIGH
          : STRUCTURE_TIMER_SECONDS.HULL_REINFORCE_NULL_LOW,
        next,
      ),
      conditionState: normalizeConditionState(
        reinforceState === STRUCTURE_STATE.ARMOR_REINFORCE
          ? { damage: 0, armorDamage: 0, shieldCharge: 0 }
          : { damage: 0, armorDamage: 1, shieldCharge: 0 },
      ),
    };
    return {
      structure:
        reinforceState === STRUCTURE_STATE.HULL_REINFORCE
          ? offlineModuleBackedServicesForHullReinforce(reinforcedStructure)
          : reinforcedStructure,
      preventDestroy: true,
      destroy: false,
      changed: true,
    };
  }

  if (next.state === STRUCTURE_STATE.ARMOR_VULNERABLE && armorBroke) {
    if (
      (next.structureSize === STRUCTURE_SIZE.LARGE || next.structureSize === STRUCTURE_SIZE.EXTRA_LARGE) &&
      next.upkeepState === STRUCTURE_UPKEEP_STATE.FULL_POWER
    ) {
      const reinforcedStructure = {
        ...next,
        state: STRUCTURE_STATE.HULL_REINFORCE,
        stateStartedAt: nowMs,
        stateEndsAt: nowMs + scaledTimerMs(
          resolveSecurityBand(next) === "high"
            ? STRUCTURE_TIMER_SECONDS.HULL_REINFORCE_HIGH
            : STRUCTURE_TIMER_SECONDS.HULL_REINFORCE_NULL_LOW,
          next,
        ),
        conditionState: normalizeConditionState({ damage: 0, armorDamage: 1, shieldCharge: 0 }),
      };
      return {
        structure: offlineModuleBackedServicesForHullReinforce(reinforcedStructure),
        preventDestroy: true,
        destroy: false,
        changed: true,
      };
    }

    return {
      structure: {
        ...next,
        state: STRUCTURE_STATE.HULL_VULNERABLE,
        stateStartedAt: nowMs,
        stateEndsAt: nowMs + scaledTimerMs(
          STRUCTURE_REPAIR_SECONDS_BY_STATE[STRUCTURE_STATE.HULL_VULNERABLE],
          next,
        ),
      },
      preventDestroy: false,
      destroy: destroyed,
      changed: true,
    };
  }

  const repairTimedStructure = applyStructureRepairTimerForDamage(
    next,
    before,
    after,
    nowMs,
  );
  return {
    structure: repairTimedStructure,
    preventDestroy: false,
    destroy: destroyed,
    changed: true,
  };
}

function applyRuntimeStructureDamage(structureID, damageResult, nowMs = Date.now(), options = {}) {
  const structure = getStructureByID(structureID, { refresh: false });
  if (!structure) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }
  const lifecycleNowMs = toInt(
    options.lifecycleNowMs,
    Date.now(),
  );
  const transition = applyStructureDamageTransition(structure, damageResult, nowMs);
  const underAttackNotification = shouldNotifyStructureUnderAttack(
    structure,
    transition && transition.structure,
    damageResult,
    nowMs,
    options,
  );
  if (underAttackNotification && transition && transition.structure) {
    transition.structure = {
      ...transition.structure,
      devFlags: {
        ...(transition.structure.devFlags || {}),
        underAttackNotificationActiveUntilMs: underAttackNotification.activeUntilMs,
      },
    };
  }
  const enteringHullReinforce =
    transition &&
    transition.changed === true &&
    structure.state !== STRUCTURE_STATE.HULL_REINFORCE &&
    transition.structure &&
    transition.structure.state === STRUCTURE_STATE.HULL_REINFORCE;
  const updateResult = updateStructureRecord(
    structureID,
    () => transition.structure,
    {
      ...options,
      nowMs: lifecycleNowMs,
    },
  );
  if (!updateResult.success) {
    return updateResult;
  }
  const previousState = toInt(structure && structure.state, 0);
  const nextState = toInt(updateResult.data && updateResult.data.state, 0);
  if (underAttackNotification) {
    createStructureUnderAttackNotifications(updateResult.data, underAttackNotification);
  }
  if (
    previousState === STRUCTURE_STATE.SHIELD_VULNERABLE &&
    (nextState === STRUCTURE_STATE.ARMOR_REINFORCE ||
      nextState === STRUCTURE_STATE.HULL_REINFORCE)
  ) {
    createStructureReinforcementLossNotifications(
      updateResult.data,
      NOTIFICATION_TYPE.STRUCTURE_LOST_SHIELDS,
    );
  } else if (
    previousState === STRUCTURE_STATE.ARMOR_VULNERABLE &&
    nextState === STRUCTURE_STATE.HULL_REINFORCE
  ) {
    createStructureReinforcementLossNotifications(
      updateResult.data,
      NOTIFICATION_TYPE.STRUCTURE_LOST_ARMOR,
    );
  }
  const offlinedModules = enteringHullReinforce
    ? offlineFittedStructureServiceModulesForHullReinforce(structureID)
    : { offlinedModuleIDs: [], changes: [] };
  const industryJobSync = syncIndustryJobsForServiceStateTransition(
    structureID,
    structure.serviceStates,
    updateResult.data && updateResult.data.serviceStates,
  );
  return {
    success: true,
    data: {
      structure: updateResult.data,
      preventDestroy: transition.preventDestroy === true,
      destroy: transition.destroy === true,
      changed: transition.changed === true,
      offlinedModuleIDs: offlinedModules.offlinedModuleIDs || [],
      moduleChanges: offlinedModules.changes || [],
      industryJobSync,
    },
  };
}

function applyAdminStructureDamage(structureID, layerToken, amount = null, options = {}) {
  const structure = getStructureByID(structureID, { refresh: false });
  if (!structure) {
    return {
      success: false,
      errorMsg: "STRUCTURE_NOT_FOUND",
    };
  }

  const normalizedLayer = String(layerToken || "").trim().toLowerCase();
  if (!["shield", "armor", "hull", "kill", "all"].includes(normalizedLayer)) {
    return {
      success: false,
      errorMsg: "INVALID_DAMAGE_LAYER",
    };
  }

  const effectiveHitpoints = resolveStructureEffectiveHitpoints(structure);
  const maxShield = Math.max(0, effectiveHitpoints.effectiveShieldCapacity);
  const maxArmor = Math.max(0, effectiveHitpoints.effectiveArmorHP);
  const maxHull = Math.max(0, effectiveHitpoints.effectiveStructureHP);
  const beforeLayers = {
    shield: Math.max(0, maxShield * toFloat(structure.conditionState && structure.conditionState.shieldCharge, 1)),
    armor: Math.max(0, maxArmor * (1 - toFloat(structure.conditionState && structure.conditionState.armorDamage, 0))),
    structure: Math.max(0, maxHull * (1 - toFloat(structure.conditionState && structure.conditionState.damage, 0))),
  };
  const afterLayers = { ...beforeLayers };
  const normalizedAmount = Number(amount);
  const toAbsoluteDamage = (currentValue, maxValue) => {
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
      return currentValue;
    }
    if (normalizedAmount <= 1 && maxValue > 0) {
      return Math.min(currentValue, normalizedAmount * maxValue);
    }
    return Math.min(currentValue, normalizedAmount);
  };

  if (normalizedLayer === "kill" || normalizedLayer === "all") {
    afterLayers.shield = 0;
    afterLayers.armor = 0;
    afterLayers.structure = 0;
  } else if (normalizedLayer === "shield") {
    afterLayers.shield = Math.max(0, beforeLayers.shield - toAbsoluteDamage(beforeLayers.shield, maxShield));
  } else if (normalizedLayer === "armor") {
    afterLayers.shield = 0;
    afterLayers.armor = Math.max(0, beforeLayers.armor - toAbsoluteDamage(beforeLayers.armor, maxArmor));
  } else if (normalizedLayer === "hull") {
    afterLayers.shield = 0;
    afterLayers.armor = 0;
    afterLayers.structure = Math.max(0, beforeLayers.structure - toAbsoluteDamage(beforeLayers.structure, maxHull));
  }

  const damageResult = {
    success: true,
    data: {
      beforeLayers,
      afterLayers,
      afterConditionState: normalizeConditionState({
        shieldCharge: maxShield > 0 ? afterLayers.shield / maxShield : 0,
        armorDamage: maxArmor > 0 ? 1 - afterLayers.armor / maxArmor : 1,
        damage: maxHull > 0 ? 1 - afterLayers.structure / maxHull : 1,
        charge: structure.conditionState && structure.conditionState.charge,
      }),
      destroyed: afterLayers.structure <= 1e-9,
    },
  };

  const result = applyRuntimeStructureDamage(
    structureID,
    damageResult,
    toInt(options.nowMs, Date.now()),
    options,
  );
  if (!result.success) {
    return result;
  }

  if (
    result.data &&
    result.data.destroy === true &&
    result.data.preventDestroy !== true
  ) {
    const destroyResult = destroyStructure(structureID, {
      nowMs: options.nowMs,
      session: options.session,
    });
    if (!destroyResult.success) {
      return destroyResult;
    }
    return {
      success: true,
      data: {
        structure: destroyResult.data,
        destroy: true,
        changed: true,
      },
    };
  }

  return result;
}

function getStructureServices(structure) {
  return Object.fromEntries(
    Object.entries(structure && structure.serviceStates || {})
      .map(([serviceID, stateID]) => [toPositiveInt(serviceID, 0), toInt(stateID, STRUCTURE_SERVICE_STATE.OFFLINE)])
      .filter(([serviceID]) => serviceID > 0),
  );
}

function buildStructureDirectoryInfo(structure) {
  const next = normalizeStructureRecord(structure);
  const typeRecord = getStructureTypeByID(next.typeID);
  return {
    itemID: next.structureID,
    structureID: next.structureID,
    itemName: next.itemName,
    solarSystemID: next.solarSystemID,
    locationID: next.solarSystemID,
    ownerID: next.ownerCorpID,
    allianceID: next.allianceID,
    typeID: next.typeID,
    groupID: toPositiveInt(typeRecord && typeRecord.groupID, 0),
    categoryID: 65,
    x: next.position.x,
    y: next.position.y,
    z: next.position.z,
    inSpace: !next.destroyedAt,
    profileID: next.profileID,
    services: getStructureServices(next),
    fuelExpires: next.fuelExpiresAt ? toFileTimeLongFromMs(next.fuelExpiresAt) : null,
    upkeepState: next.upkeepState,
    state: next.state,
    timerEnd: next.stateEndsAt ? toFileTimeLongFromMs(next.stateEndsAt) : null,
    reinforce_weekday: next.reinforceWeekday,
    reinforce_hour: next.reinforceHour,
    next_reinforce_weekday: next.nextReinforceApply ? next.nextReinforceWeekday : null,
    next_reinforce_hour: next.nextReinforceApply ? next.nextReinforceHour : null,
    next_reinforce_apply: next.nextReinforceApply
      ? toFileTimeLongFromMs(next.nextReinforceApply)
      : null,
    unanchoring: next.unanchoring ? toFileTimeLongFromMs(next.unanchoring) : null,
    liquidOzoneQty: next.liquidOzoneQty,
    wars: [...next.wars],
  };
}

function buildStructureLocationRecord(structure) {
  const next = normalizeStructureRecord(structure);
  return {
    locationID: next.structureID,
    locationName: next.itemName,
    solarSystemID: next.solarSystemID,
    x: next.position.x,
    y: next.position.y,
    z: next.position.z,
    locationNameID: next.itemName,
  };
}

function buildStructureMapEntry(structure) {
  const next = normalizeStructureRecord(structure);
  const typeRecord = getStructureTypeByID(next.typeID);
  return [
    toPositiveInt(typeRecord && typeRecord.groupID, 0),
    next.typeID,
    next.structureID,
    next.itemName,
    next.solarSystemID,
    next.ownerID,
    false,
    next.position.x,
    next.position.y,
    next.position.z,
    null,
    null,
  ];
}

function listDockableStructuresForCharacter(session, options = {}) {
  const solarSystemID =
    options.solarSystemID === undefined || options.solarSystemID === null
      ? null
      : toPositiveInt(options.solarSystemID, 0);
  return listStructures({
    includeDestroyed: false,
    refresh: options.refresh !== false,
  }).filter((structure) => {
    if (solarSystemID && structure.solarSystemID !== solarSystemID) {
      return false;
    }
    return canCharacterDockAtStructure(session, structure, {
      ignoreRestrictions: options.ignoreRestrictions === true,
      shipTypeID: options.shipTypeID,
    }).success;
  });
}

function clearStructureCaches() {
  typeCache = null;
  structureCache = null;
  solarCache = null;
}

function listAssetSafetyWraps() {
  const payload = readTable(STRUCTURE_ASSET_SAFETY_TABLE, {
    _meta: {
      nextWrapID: NEXT_ASSET_WRAP_ID_START,
      generatedAt: null,
      lastUpdatedAt: null,
    },
    wraps: [],
  });
  return Array.isArray(payload.wraps) ? payload.wraps.map((entry) => cloneValue(entry)) : [];
}

Object.assign(module.exports, {
  STRUCTURE_TYPES_TABLE,
  STRUCTURES_TABLE,
  STRUCTURE_ASSET_SAFETY_TABLE,
  ensureStructureTypes,
  getStructureTypes,
  getStructureTypeByID,
  getStructureByID,
  getStructureByName,
  listStructures,
  listStructuresForSystem,
  listOwnedStructures,
  listDockableStructuresForCharacter,
  countCharactersDockedInStructure,
  clearStructureCaches,
  createStructure,
  upsertStructureRecord,
  updateStructureRecord,
  seedStructureForSession,
  startAnchoring,
  startStructureUnanchoring,
  setStructureState,
  setStructureStateTimerRemaining,
  setStructureDeployTimerRemaining,
  setStructureUnanchoringRemaining,
  setStructureAbandonTimerRemaining,
  setStructureQuantumCoreInstalled,
  setStructureUpkeepState,
  setStructureServiceState,
  createStructureFuelAlertNotifications,
  resolveStructureAbandonAtFromFuelAnchor,
  repairStructure,
  fastForwardStructure,
  setStructureTimerScale,
  cancelStructureUnanchoring,
  removeStructure,
  destroyStructure,
  hasStructureGmBypass,
  isDockingServiceOnline,
  isStructureTetheringAllowed,
  canCharacterDockAtStructure,
  canShipTypeDockAtStructure,
  hasStructureOneWayUndockRestriction,
  applyAdminStructureDamage,
  applyRuntimeStructureDamage,
  resolveStructureRepairingValue,
  tickStructures,
  getStructureServices,
  resolveStructureEffectiveHitpoints,
    buildStructureDirectoryInfo,
    buildStructureLocationRecord,
    buildStructureMapEntry,
    registerStructureChangeListener,
    listAssetSafetyWraps,
  toFileTimeLongFromMs,
  _testing: {
    normalizeStructureTypeRecord,
    normalizeStructureRecord,
    applyStructureDamageTransition,
    maybeAdvanceStructureState,
    isStructureRepairLayerDamaged,
    resolveStructureRepairingValue,
    getShipDockClass,
    resolveStructureUnanchoringSeconds,
    awaitPendingMarketOrderCancellationTasksForTests,
  },
});
