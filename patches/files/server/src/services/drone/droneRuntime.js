const path = require("path");

// Memoized resolver for lazy (circular-dependency-safe) requires that run on the
// drone tick path. require(path.join(__dirname, id)) costs ~1.8us/call even when
// cached (path rebuild + resolver lookup); caching the resolved reference drops
// it to a ~4ns Map lookup. Safe because the targets assign module.exports once
// at load (or mutate it in place), so the cached reference never goes stale.
const _lazyModuleCache = new Map();
function lazyRequire(relativeId) {
  let resolved = _lazyModuleCache.get(relativeId);
  if (resolved === undefined) {
    resolved = require(path.join(__dirname, relativeId));
    _lazyModuleCache.set(relativeId, resolved);
  }
  return resolved;
}

const log = require(path.join(__dirname, "../../utils/logger"));
const {
  findSessionByCharacterID,
} = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  ITEM_FLAGS,
  findItemById,
  grantItemToCharacterLocation,
  listContainerItems,
  moveItemToLocation,
  updateInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  buildEffectiveItemAttributeMap,
  buildShipResourceState,
  getAttributeIDByNames,
  getTypeAttributeValue,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  getShipFittingSnapshot,
} = require(path.join(__dirname, "../../_secondary/fitting/fittingRuntime"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  DRONE_CATEGORY_ID,
  isDroneItemRecord,
} = require(path.join(__dirname, "../fighter/fighterInventory"));
const {
  beginDogmaTick,
  endDogmaTick,
  resolveDroneOperationalAttributes,
  resolveDroneCombatSnapshot,
  resolveDroneMiningSnapshot,
  resolveDroneSalvageSnapshot,
  resolveDroneRepairSnapshot,
} = require(path.join(__dirname, "./droneDogma"));
const jammerModuleRuntime = require(path.join(
  __dirname,
  "../../space/modules/jammerModuleRuntime",
));
const assistanceModuleRuntime = require(path.join(
  __dirname,
  "../../space/modules/assistanceModuleRuntime",
));
const salvagerRuntime = require(path.join(
  __dirname,
  "../../space/modules/salvagerRuntime",
));
const {
  hasDamageableHealth,
} = require(path.join(__dirname, "../../space/combat/damage"));
const {
  computeMiningResult,
} = require(path.join(__dirname, "../mining/miningMath"));
const {
  MINING_HOLD_FLAGS,
  getPreferredMiningHoldFlagForType,
  getShipHoldCapacityByFlag,
} = require(path.join(__dirname, "../mining/miningInventory"));
const {
  ensureSceneMiningState,
  getMineableState,
  applyMiningDelta,
} = require(path.join(__dirname, "../mining/miningRuntimeState"));
const {
  entityIDsEqual,
  normalizeNonNegativeInt64,
  normalizePersistentEntityID,
  toJSONSafeEntityID,
} = require(path.join(__dirname, "../../space/destiny/identity/entityID"));
const {
  createDroneOperationalMotionCommand,
} = require(path.join(__dirname, "../../space/destiny/commands/drone.js"));

const STATE_IDLE = 0;
const STATE_COMBAT = 1;
const STATE_MINING = 2;
const STATE_APPROACHING = 3;
const STATE_DEPARTING = 4;
const STATE_PURSUIT = 6;
const STATE_SALVAGING = 18;
const ATTRIBUTE_DRONE_BANDWIDTH_USED =
  getAttributeIDByNames("droneBandwidthUsed", "droneBandwidthLoad", "droneBandwidth") ||
  1272;
// Ship-side drone limits. The fitting snapshot keys shipAttributes by numeric
// attribute ID (see normalizeNumericAttributeMap), so these must be read by ID,
// not by name. droneBandwidth (1271) is the hull's available Mbit/sec; each
// drone's droneBandwidthUsed (1272) draws against it, matching the client check
// in shipfitting/droneUtil.GetDroneBandwidth.
const ATTRIBUTE_DRONE_BANDWIDTH =
  getAttributeIDByNames("droneBandwidth") || 1271;
const ATTRIBUTE_MAX_ACTIVE_DRONES =
  getAttributeIDByNames("maxActiveDrones") || 352;

const DRONE_COMMAND_RETURN_BAY = "RETURN_BAY";
const DRONE_COMMAND_RETURN_HOME = "RETURN_HOME";
const DRONE_COMMAND_ENGAGE = "ENGAGE";
const DRONE_COMMAND_MINE = "MINE";
const DRONE_COMMAND_SALVAGE = "SALVAGE";
const ATTRIBUTE_DRONE_IS_AGGRESSIVE =
  getAttributeIDByNames("droneIsAggressive", "droneIsAgressive") || 1275;
const ATTRIBUTE_DRONE_FOCUS_FIRE =
  getAttributeIDByNames("droneFocusFire") || 1297;
const ATTRIBUTE_STRUCTURE_HP = getAttributeIDByNames("hp", "structureHP") || 9;
const ATTRIBUTE_MASS = getAttributeIDByNames("mass") || 4;
const ATTRIBUTE_MAX_VELOCITY = getAttributeIDByNames("maxVelocity") || 37;
const ATTRIBUTE_SHIELD_RECHARGE_RATE =
  getAttributeIDByNames("shieldRechargeRate") || 479;
const ATTRIBUTE_SHIELD_CAPACITY = getAttributeIDByNames("shieldCapacity") || 263;
const ATTRIBUTE_ARMOR_HP = getAttributeIDByNames("armorHP") || 265;
const ATTRIBUTE_AGILITY = getAttributeIDByNames("agility") || 70;
const ATTRIBUTE_ORBIT_RANGE = getAttributeIDByNames("orbitRange") || 157;

const DRONE_BAY_SCOOP_DISTANCE_METERS = 2500;
const DRONE_BAY_RETURN_APPROACH_DISTANCE_METERS = 0;
const DEFAULT_DRONE_LAUNCH_OFFSET_METERS = 75;
const MIN_ORBIT_DISTANCE_METERS = 500;
const MAX_ORBIT_DISTANCE_METERS = 5000;
const ONE_METER = 1;
const DEFAULT_DRONE_IS_AGGRESSIVE = true;
const DEFAULT_DRONE_FOCUS_FIRE = false;
const DRONE_AGGRESSION_THREAT_RETENTION_MS = 30_000;

const PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS = Object.freeze([
  "airNpeOwnerCharacterID",
  "airNpeOperationID",
  "airNpeInstanceID",
]);
const PLAYER_COMPANION_INVALID_SCOPE_SENTINEL =
  "invalid-player-companion-scope";

function buildPlayerCompanionScopeMetadata(controllerEntity = null) {
  if (!controllerEntity || typeof controllerEntity !== "object") {
    return {};
  }

  const metadata = {};
  for (const key of PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS) {
    const rawValue = controllerEntity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (value !== null) {
      metadata[key] = toJSONSafeEntityID(value);
    } else {
      metadata[key] = PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
    }
  }

  // The player ship's accepted dungeon tracker is the sole room/site truth.
  // A launched child receives a presentation scope without manufacturing a
  // second dungeonSiteInstanceID authority on the controller.
  const dungeonSiteInstanceID = normalizePersistentEntityID(
    controllerEntity.dungeonCurrentInstanceID,
  );
  if (dungeonSiteInstanceID !== null) {
    metadata.dungeonSiteInstanceID = toJSONSafeEntityID(
      dungeonSiteInstanceID,
    );
  }
  if (
    getPlayerCompanionSecurityScope(controllerEntity, {
      controller: true,
    }).invalid === true
  ) {
    metadata.dungeonSiteInstanceID =
      PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
  }
  return metadata;
}

function applyPlayerCompanionScopeMetadata(entity, source = null) {
  if (!entity || !source || typeof source !== "object") {
    return entity;
  }
  for (const key of [
    ...PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS,
    "dungeonSiteInstanceID",
  ]) {
    const rawValue = source[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (value !== null) {
      const hasExistingValue = Object.hasOwn(entity, key) &&
        entity[key] !== null &&
        entity[key] !== undefined;
      const existingValue = hasExistingValue
        ? normalizePersistentEntityID(entity[key])
        : null;
      if (
        hasExistingValue &&
        (
          existingValue === null ||
          !entityIDsEqual(existingValue, value)
        )
      ) {
        entity[key] = PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
        entity.playerCompanionScopeInvalid = true;
      } else {
        entity[key] = value;
      }
    } else {
      entity[key] = PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
      entity.playerCompanionScopeInvalid = true;
    }
  }
  return entity;
}

function serializePlayerCompanionScopeMetadata(entity = null) {
  if (!entity || typeof entity !== "object") {
    return {};
  }
  const metadata = {};
  for (const key of [
    ...PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS,
    "dungeonSiteInstanceID",
  ]) {
    const rawValue = entity[key];
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (value !== null) {
      metadata[key] = toJSONSafeEntityID(value);
    } else {
      metadata[key] = PLAYER_COMPANION_INVALID_SCOPE_SENTINEL;
    }
  }
  return metadata;
}

function getPlayerCompanionSecurityScope(entity = null, options = {}) {
  const scope = {
    invalid: Boolean(entity && entity.playerCompanionScopeInvalid === true),
  };
  const isController = options.controller === true;
  const isPlayerShipController = Boolean(
    isController &&
    entity &&
    entity.kind === "ship",
  );
  const rawSiteInstanceID = entity && entity.dungeonSiteInstanceID;
  const rawCurrentInstanceID = entity && entity.dungeonCurrentInstanceID;
  const rawDungeonSiteID = entity && entity.dungeonSiteID;
  const rawCurrentSiteID = entity && entity.dungeonCurrentSiteID;
  const siteInstanceID = normalizePersistentEntityID(rawSiteInstanceID);
  const currentInstanceID = normalizePersistentEntityID(rawCurrentInstanceID);
  const hasDungeonSiteID = Boolean(
    entity &&
    Object.hasOwn(entity, "dungeonSiteID") &&
    rawDungeonSiteID !== undefined &&
    rawDungeonSiteID !== null,
  );
  const hasCurrentSiteID = Boolean(
    entity &&
    Object.hasOwn(entity, "dungeonCurrentSiteID") &&
    rawCurrentSiteID !== undefined &&
    rawCurrentSiteID !== null,
  );
  const dungeonSiteID = normalizePersistentEntityID(rawDungeonSiteID);
  const currentSiteID = normalizePersistentEntityID(rawCurrentSiteID);
  let hasPlayerDungeonTrackingContext = false;
  if (entity && entity.kind === "ship") {
    for (const [key, normalizeIdentity] of [
      ["dungeonCurrentDungeonID", normalizePersistentEntityID],
      ["dungeonCurrentRoomID", normalizeNonNegativeInt64],
      ["dungeonCurrentSiteID", normalizePersistentEntityID],
    ]) {
      const rawValue = entity && entity[key];
      if (
        rawValue === undefined ||
        rawValue === null
      ) {
        continue;
      }
      hasPlayerDungeonTrackingContext = true;
      if (normalizeIdentity(rawValue) === null) {
        scope.invalid = true;
      }
    }
    hasPlayerDungeonTrackingContext = Boolean(
      hasPlayerDungeonTrackingContext ||
      String(entity.dungeonCurrentRoomKey || "").trim() ||
      Array.isArray(entity.dungeonCurrentRoomPosition)
    );
  }
  if (
    (rawSiteInstanceID !== undefined &&
      rawSiteInstanceID !== null &&
      siteInstanceID === null) ||
    (rawCurrentInstanceID !== undefined &&
      rawCurrentInstanceID !== null &&
      currentInstanceID === null) ||
    (siteInstanceID !== null &&
      currentInstanceID !== null &&
      !entityIDsEqual(siteInstanceID, currentInstanceID)) ||
    (isPlayerShipController &&
      siteInstanceID !== null &&
      currentInstanceID === null) ||
    (entity && entity.kind === "ship" &&
      currentInstanceID === null &&
      hasPlayerDungeonTrackingContext)
  ) {
    scope.invalid = true;
  }
  scope.dungeonSiteInstanceID = isPlayerShipController
    ? currentInstanceID
    : siteInstanceID !== null
      ? siteInstanceID
      : entity && entity.kind === "ship"
        ? currentInstanceID
        : null;
  if (
    hasDungeonSiteID &&
    (
      dungeonSiteID === null ||
      scope.dungeonSiteInstanceID === null ||
      (
        isController &&
        entity &&
        entity.kind === "ship" &&
        hasCurrentSiteID &&
        (
          currentSiteID === null ||
          !entityIDsEqual(dungeonSiteID, currentSiteID)
        )
      )
    )
  ) {
    scope.invalid = true;
  }
  for (const key of PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS) {
    const rawValue = entity && entity[key];
    const value = normalizePersistentEntityID(rawValue);
    if (rawValue !== undefined && rawValue !== null && value === null) {
      scope.invalid = true;
    }
    scope[key] = value;
  }
  scope.effectiveInstanceID =
    scope.dungeonSiteInstanceID ?? scope.airNpeInstanceID;
  const hasDungeonScopeMarker = Boolean(
    entity && (
      entity.dungeonMaterializedContainer === true ||
      entity.dungeonMaterializedSiteContent === true ||
      entity.dungeonSiteContentBonus === true ||
      entity.dungeonSiteContentFailureExplodes === true ||
      entity.dungeonSiteContentPersistsAfterResponse === true ||
      [
        "dungeonEncounterKey",
        "dungeonSiteContentKey",
        "dungeonSiteContentRole",
        "dungeonSiteContentAnalyzer",
        "dungeonSiteContentTrigger",
        "dungeonSiteContentLootProfile",
        "dungeonSiteContentHackingDifficulty",
      ].some((key) => String(entity[key] || "").trim()) ||
      Array.isArray(entity.dungeonSiteContentExplicitLoot) ||
      Array.isArray(entity.dungeonSiteContentLootTags)
    )
  );
  const hasAirScopeMarker = Boolean(
    entity && (
      entity.airNpeBoardingShipPresentation === true ||
      entity.airNpeTutorialDebris === true ||
      entity.airNpeHostile === true ||
      String(entity.airNpeHostileWave || "").trim()
    )
  );
  if (
    (hasDungeonScopeMarker && scope.dungeonSiteInstanceID === null) ||
    (
      hasAirScopeMarker &&
      scope.airNpeInstanceID === null &&
      scope.airNpeOwnerCharacterID === null
    ) ||
    (scope.effectiveInstanceID === null &&
    (
      scope.airNpeOwnerCharacterID !== null ||
      scope.airNpeOperationID !== null
    ))
  ) {
    scope.invalid = true;
  }
  return scope;
}

function resolveExactCompanionActorCharacterID(entity = null, session = null) {
  let resolvedCharacterID = null;
  let invalid = false;
  const candidates = [];
  if (session && typeof session === "object") {
    for (const key of ["characterID", "charID", "charid"]) {
      if (Object.hasOwn(session, key)) {
        candidates.push(session[key]);
      }
    }
  }
  if (entity && typeof entity === "object") {
    for (const key of ["characterID", "pilotCharacterID"]) {
      if (Object.hasOwn(entity, key)) {
        candidates.push(entity[key]);
      }
    }
    if (entity.kind === "ship" && Object.hasOwn(entity, "ownerID")) {
      candidates.push(entity.ownerID);
    }
  }
  for (const rawValue of candidates) {
    if (
      rawValue === undefined ||
      rawValue === null ||
      String(rawValue).trim() === ""
    ) {
      continue;
    }
    const value = normalizePersistentEntityID(rawValue);
    if (
      value === null ||
      (resolvedCharacterID !== null &&
        !entityIDsEqual(resolvedCharacterID, value))
    ) {
      invalid = true;
      continue;
    }
    resolvedCharacterID = value;
  }
  return { invalid, value: resolvedCharacterID };
}

function playerCompanionTargetScopeIsCompatible(
  companionScope,
  targetScope,
  controllerEntity,
  targetEntity,
  session,
) {
  if (
    !companionScope ||
    !targetScope ||
    companionScope.invalid === true ||
    targetScope.invalid === true
  ) {
    return false;
  }

  const companionDungeonInstanceID = companionScope.effectiveInstanceID;
  const targetDungeonInstanceID = targetScope.effectiveInstanceID;
  if (
    (companionDungeonInstanceID !== null || targetDungeonInstanceID !== null) &&
    (
      companionDungeonInstanceID === null ||
      targetDungeonInstanceID === null ||
      !entityIDsEqual(companionDungeonInstanceID, targetDungeonInstanceID)
    )
  ) {
    return false;
  }

  for (const key of ["airNpeOperationID", "airNpeInstanceID"]) {
    const companionValue = companionScope[key];
    const targetValue = targetScope[key];
    if (
      companionValue !== null &&
      targetValue !== null &&
      !entityIDsEqual(companionValue, targetValue)
    ) {
      return false;
    }
  }

  const companionOwnerCharacterID = companionScope.airNpeOwnerCharacterID;
  const targetOwnerCharacterID = targetScope.airNpeOwnerCharacterID;
  if (
    companionOwnerCharacterID !== null &&
    targetOwnerCharacterID !== null
  ) {
    return entityIDsEqual(
      companionOwnerCharacterID,
      targetOwnerCharacterID,
    );
  }

  if (companionOwnerCharacterID !== null) {
    const targetActor = resolveExactCompanionActorCharacterID(
      targetEntity,
      targetEntity && targetEntity.session,
    );
    if (targetActor.invalid) {
      return false;
    }
    if (
      targetActor.value !== null &&
      !entityIDsEqual(companionOwnerCharacterID, targetActor.value)
    ) {
      return false;
    }
    if (targetEntity && targetEntity.kind === "ship" && targetActor.value === null) {
      return false;
    }
  }

  if (targetOwnerCharacterID !== null) {
    const controllerActor = resolveExactCompanionActorCharacterID(
      controllerEntity,
      session || (controllerEntity && controllerEntity.session),
    );
    if (
      controllerActor.invalid ||
      controllerActor.value === null ||
      !entityIDsEqual(targetOwnerCharacterID, controllerActor.value)
    ) {
      return false;
    }
  }

  return true;
}

function securityScopesExactlyMatch(leftScope, rightScope) {
  if (
    !leftScope ||
    !rightScope ||
    leftScope.invalid === true ||
    rightScope.invalid === true
  ) {
    return false;
  }
  for (const key of [
    "dungeonSiteInstanceID",
    ...PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS,
  ]) {
    const left = leftScope && leftScope[key];
    const right = rightScope && rightScope[key];
    if (left === null && right === null) {
      continue;
    }
    if (left === null || right === null || !entityIDsEqual(left, right)) {
      return false;
    }
  }
  return true;
}

function hasPlayerCompanionSecurityScope(scope) {
  return Boolean(
    scope && (
      scope.invalid === true ||
      [
        "dungeonSiteInstanceID",
        ...PLAYER_COMPANION_AIR_SCOPE_ID_FIELDS,
      ].some((key) => scope[key] !== null)
    ),
  );
}

function canPlayerCompanionActOnTarget(
  scene,
  session,
  companionEntity,
  controllerEntity,
  targetEntity,
) {
  if (!scene || !companionEntity || !controllerEntity || !targetEntity) {
    return false;
  }

  const companionScope = getPlayerCompanionSecurityScope(companionEntity);
  const controllerScope = getPlayerCompanionSecurityScope(controllerEntity, {
    controller: true,
  });
  const targetScope = getPlayerCompanionSecurityScope(targetEntity);
  if (
    !securityScopesExactlyMatch(companionScope, controllerScope) ||
    !playerCompanionTargetScopeIsCompatible(
      companionScope,
      targetScope,
      controllerEntity,
      targetEntity,
      session,
    )
  ) {
    return false;
  }

  const visibilityGate = scene.canSessionSeeDungeonScopedEntity;
  if (typeof visibilityGate !== "function") {
    return ![
      companionScope,
      controllerScope,
      targetScope,
    ].some(hasPlayerCompanionSecurityScope);
  }

  const isPlayerShipController = Boolean(
    controllerEntity.kind === "ship",
  );
  const controllerSession =
    session || resolveDroneControllerSession(companionEntity, controllerEntity);
  const effectiveSession =
    controllerSession || (!isPlayerShipController && targetEntity.session) || null;
  if (!effectiveSession) {
    return (
      !isPlayerShipController &&
      !controllerScope.invalid
    );
  }
  try {
    return (
      visibilityGate.call(scene, effectiveSession, companionEntity) === true &&
      visibilityGate.call(scene, effectiveSession, targetEntity) === true
    );
  } catch (_error) {
    return false;
  }
}

function getCharacterStateService() {
  return lazyRequire("../character/characterState");
}

function resolveCharacterRecord(characterID) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.getCharacterRecord === "function"
    ? characterState.getCharacterRecord(characterID)
    : null;
}

function resolveActiveShipRecord(characterID) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.getActiveShipRecord === "function"
    ? characterState.getActiveShipRecord(characterID)
    : null;
}

function buildDogmaPrimeEntry(item, options = {}) {
  const characterState = getCharacterStateService();
  return characterState &&
    typeof characterState.buildInventoryDogmaPrimeEntry === "function"
    ? characterState.buildInventoryDogmaPrimeEntry(item, options)
    : characterState &&
      typeof characterState.buildChargeDogmaPrimeEntry === "function"
      ? characterState.buildChargeDogmaPrimeEntry(item, options)
    : null;
}

function syncInventoryItemForCharacterSession(session, item, previousData, options = {}) {
  const characterState = getCharacterStateService();
  if (!characterState || typeof characterState.syncInventoryItemForSession !== "function") {
    return false;
  }
  return characterState.syncInventoryItemForSession(
    session,
    item,
    previousData,
    options,
  );
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toInt(value, fallback = 0) {
  return Math.trunc(toNumber(value, fallback));
}

function buildCreatedInventoryInsertPreviousState(item) {
  return {
    locationID: 0,
    flagID: toInt(item && item.flagID, 0),
    quantity: 0,
    stacksize: 0,
    singleton: 0,
  };
}

function buildDroneLaunchPreviousState(entity, item, shipRecord) {
  const shipID = toInt(shipRecord && shipRecord.itemID, 0);
  const systemID = toInt(entity && entity.systemID, 0);
  if (
    shipID <= 0 ||
    systemID <= 0 ||
    !item ||
    !isDroneItemRecord(item) ||
    toInt(item.locationID, 0) !== systemID ||
    toInt(item.flagID, 0) !== 0
  ) {
    return null;
  }

  // CCP client godma treats launched drones specially only when the item
  // change says they moved from the controlling ship's drone bay into the
  // solar system. Without this old location/flag pair, split-created drones
  // look like generic brand-new space items and one can fall out of the
  // active-drone UI even though the ball exists.
  return {
    locationID: shipID,
    flagID: ITEM_FLAGS.DRONE_BAY,
  };
}

function buildDroneBayClientItem(item, shipRecord) {
  const shipID = toInt(shipRecord && shipRecord.itemID, 0);
  if (!item || shipID <= 0) {
    return null;
  }

  return {
    ...item,
    locationID: shipID,
    flagID: ITEM_FLAGS.DRONE_BAY,
    quantity: null,
    stacksize: 1,
    singleton: 1,
    launcherID: shipID,
  };
}

function primeDroneBayDogmaForLaunch(item, shipRecord, sessions = null) {
  const targetSessions = normalizeDroneSessions(sessions);
  if (targetSessions.length <= 0) {
    return false;
  }

  const bayItem = buildDroneBayClientItem(item, shipRecord);
  const shipID = toInt(shipRecord && shipRecord.itemID, 0);
  if (!bayItem || shipID <= 0) {
    return false;
  }

  const primeEntry = buildDogmaPrimeEntry(bayItem, {
    description: "drone",
    includeTypeAttributes: true,
  });
  if (!primeEntry) {
    return false;
  }

  for (const session of targetSessions) {
    if (!session || typeof session.sendNotification !== "function") {
      continue;
    }
    session.sendNotification("OnGodmaPrimeItem", "clientID", [shipID, primeEntry]);
  }
  return true;
}

function syncInventoryItemToSessions(
  sessions,
  item,
  previousData,
  options = {},
) {
  for (const session of normalizeDroneSessions(sessions)) {
    if (!session) {
      continue;
    }
    syncInventoryItemForCharacterSession(
      session,
      item,
      previousData,
      options,
    );
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(toNumber(value, min), min), max);
}

function normalizeDroneSessions(sessions) {
  const normalizedSessions = [];
  const seenSessions = new Set();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || seenSessions.has(session)) {
      continue;
    }
    seenSessions.add(session);
    normalizedSessions.push(session);
  }
  return normalizedSessions;
}

function getDroneIdentityPrimeSessionKey(session) {
  return toInt(
    session &&
      (session.clientID ||
        session.characterID ||
        session.charid),
    0,
  );
}

function getDroneIdentityPrimeCache(entity) {
  if (!entity || typeof entity !== "object") {
    return null;
  }

  if (!(entity.clientIdentityPrimedSessionKeys instanceof Set)) {
    entity.clientIdentityPrimedSessionKeys = new Set();
  }
  return entity.clientIdentityPrimedSessionKeys;
}

function cloneVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toNumber(source && source.x, fallback.x),
    y: toNumber(source && source.y, fallback.y),
    z: toNumber(source && source.z, fallback.z),
  };
}

function addVectors(left, right) {
  return {
    x: toNumber(left && left.x, 0) + toNumber(right && right.x, 0),
    y: toNumber(left && left.y, 0) + toNumber(right && right.y, 0),
    z: toNumber(left && left.z, 0) + toNumber(right && right.z, 0),
  };
}

function subtractVectors(left, right) {
  return {
    x: toNumber(left && left.x, 0) - toNumber(right && right.x, 0),
    y: toNumber(left && left.y, 0) - toNumber(right && right.y, 0),
    z: toNumber(left && left.z, 0) - toNumber(right && right.z, 0),
  };
}

function scaleVector(vector, scalar) {
  return {
    x: toNumber(vector && vector.x, 0) * toNumber(scalar, 0),
    y: toNumber(vector && vector.y, 0) * toNumber(scalar, 0),
    z: toNumber(vector && vector.z, 0) * toNumber(scalar, 0),
  };
}

function magnitude(vector) {
  const resolved = cloneVector(vector);
  return Math.sqrt(
    (resolved.x * resolved.x) +
    (resolved.y * resolved.y) +
    (resolved.z * resolved.z),
  );
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const resolved = cloneVector(vector, fallback);
  const length = magnitude(resolved);
  if (length <= 0) {
    return cloneVector(fallback);
  }
  return scaleVector(resolved, 1 / length);
}

function distance(left, right) {
  return magnitude(subtractVectors(left, right));
}

function buildPerpendicular(vector) {
  const normalized = normalizeVector(vector, { x: 1, y: 0, z: 0 });
  if (Math.abs(normalized.x) < 0.5 && Math.abs(normalized.y) < 0.5) {
    return normalizeVector({ x: 0, y: 1, z: 0 });
  }
  return normalizeVector({ x: -normalized.y, y: normalized.x, z: 0 });
}

function serializeDroneSpaceState(entity) {
  return {
    systemID: toInt(entity && entity.systemID, 0),
    position: cloneVector(entity && entity.position),
    velocity: cloneVector(entity && entity.velocity),
    direction: cloneVector(entity && entity.direction, { x: 1, y: 0, z: 0 }),
    targetPoint: cloneVector(entity && entity.targetPoint, entity && entity.position),
    speedFraction: clamp(entity && entity.speedFraction, 0, 1),
    mode: String(entity && entity.mode || "STOP"),
    targetEntityID: toInt(entity && entity.targetEntityID, 0) || null,
    followRange: Math.max(0, toNumber(entity && entity.followRange, 0)),
    orbitDistance: Math.max(0, toNumber(entity && entity.orbitDistance, 0)),
    orbitNormal: cloneVector(entity && entity.orbitNormal, buildPerpendicular(entity && entity.direction)),
    orbitSign: toNumber(entity && entity.orbitSign, 1) < 0 ? -1 : 1,
    pendingWarp: null,
    warpState: null,
    ...serializePlayerCompanionScopeMetadata(entity),
  };
}

function buildDroneErrorTuple(message) {
  return [
    "CustomNotify",
    buildMarshalDict([["notify", String(message || "")]]),
  ];
}

function buildMarshalDict(entries = []) {
  return {
    type: "dict",
    entries: Array.isArray(entries) ? entries : [],
  };
}

function buildMarshalList(items = []) {
  return {
    type: "list",
    items: Array.isArray(items) ? items : [],
  };
}

function buildNotifyErrorResult(message) {
  return buildMarshalDict([
    [
      "CustomNotify",
      buildMarshalDict([["notify", String(message || "")]]),
    ],
  ]);
}

function buildMultiDroneResult(droneIDs = []) {
  return buildMarshalDict();
}

function ensureLaunchResponseEntry(result, itemID) {
  const numericItemID = toInt(itemID, 0);
  if (
    !result ||
    result.type !== "dict" ||
    !Array.isArray(result.entries) ||
    numericItemID <= 0
  ) {
    return null;
  }

  let existingEntry = result.entries.find(
    (entry) => Array.isArray(entry) && toInt(entry[0], 0) === numericItemID,
  );
  if (!existingEntry) {
    existingEntry = [numericItemID, buildMarshalList()];
    result.entries.push(existingEntry);
  }

  if (
    !existingEntry[1] ||
    existingEntry[1].type !== "list" ||
    !Array.isArray(existingEntry[1].items)
  ) {
    existingEntry[1] = buildMarshalList();
  }

  return existingEntry[1];
}

function appendLaunchEntry(result, itemID, value) {
  const launchEntries = ensureLaunchResponseEntry(result, itemID);
  if (!launchEntries) {
    return result;
  }
  launchEntries.items.push(value);
  return result;
}

function appendLaunchError(result, itemID, message) {
  return appendLaunchEntry(result, itemID, buildDroneErrorTuple(message));
}

function appendDroneError(result, droneID, message) {
  const numericDroneID = toInt(droneID, 0);
  if (
    !result ||
    result.type !== "dict" ||
    !Array.isArray(result.entries) ||
    numericDroneID <= 0
  ) {
    return result;
  }

  const existingEntry = result.entries.find(
    (entry) => Array.isArray(entry) && toInt(entry[0], 0) === numericDroneID,
  );
  if (existingEntry) {
    existingEntry[1] = buildDroneErrorTuple(message);
    return result;
  }

  result.entries.push([numericDroneID, buildDroneErrorTuple(message)]);
  return result;
}

function listifyRawValue(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue;
  }
  if (rawValue && rawValue.type === "list" && Array.isArray(rawValue.items)) {
    return rawValue.items;
  }
  return rawValue === null || rawValue === undefined ? [] : [rawValue];
}

function isIterableCollection(rawValue) {
  return Boolean(
    rawValue &&
      typeof rawValue !== "string" &&
      typeof rawValue[Symbol.iterator] === "function",
  );
}

function flattenDroneCommandValues(rawValue, result = [], depth = 0) {
  if (rawValue === null || rawValue === undefined || depth > 8) {
    return result;
  }

  if (Array.isArray(rawValue)) {
    for (const entry of rawValue) {
      flattenDroneCommandValues(entry, result, depth + 1);
    }
    return result;
  }

  if (rawValue && rawValue.type === "list" && Array.isArray(rawValue.items)) {
    for (const entry of rawValue.items) {
      flattenDroneCommandValues(entry, result, depth + 1);
    }
    return result;
  }

  if (rawValue instanceof Map) {
    for (const key of rawValue.keys()) {
      flattenDroneCommandValues(key, result, depth + 1);
    }
    return result;
  }

  if (rawValue instanceof Set) {
    for (const entry of rawValue) {
      flattenDroneCommandValues(entry, result, depth + 1);
    }
    return result;
  }

  if (rawValue && rawValue.type === "dict" && Array.isArray(rawValue.entries)) {
    for (const entry of rawValue.entries) {
      if (Array.isArray(entry) && entry.length > 0) {
        flattenDroneCommandValues(entry[0], result, depth + 1);
      }
    }
    return result;
  }

  if (rawValue && typeof rawValue.keys === "function") {
    try {
      const keysView = rawValue.keys();
      if (isIterableCollection(keysView)) {
        for (const key of keysView) {
          flattenDroneCommandValues(key, result, depth + 1);
        }
        return result;
      }
    } catch (error) {
      void error;
    }
  }

  if (isIterableCollection(rawValue)) {
    for (const entry of rawValue) {
      flattenDroneCommandValues(entry, result, depth + 1);
    }
    return result;
  }

  if (rawValue && typeof rawValue === "object") {
    const objectKeys = Object.keys(rawValue);
    if (objectKeys.length > 0) {
      const numericKeys = objectKeys
        .map((key) => ({
          key,
          numeric: Number(key),
        }))
        .filter((entry) => Number.isInteger(entry.numeric) && entry.numeric >= 0);
      if (numericKeys.length === objectKeys.length) {
        const sortedNumericKeys = numericKeys
          .map((entry) => entry.numeric)
          .sort((left, right) => left - right);
        const looksArrayLike = sortedNumericKeys.every((value, index) => value === index);
        if (looksArrayLike) {
          for (const entry of objectKeys) {
            flattenDroneCommandValues(rawValue[entry], result, depth + 1);
          }
          return result;
        }
        for (const entry of objectKeys) {
          flattenDroneCommandValues(entry, result, depth + 1);
        }
        return result;
      }
    }
  }

  result.push(rawValue);
  return result;
}

function normalizeDroneIDList(rawValue) {
  return [...new Set(
    flattenDroneCommandValues(rawValue)
      .map((value) => toInt(value, 0))
      .filter((value) => value > 0),
  )];
}

function normalizeLaunchRequests(rawValue) {
  const normalized = [];
  for (const entry of listifyRawValue(rawValue)) {
    const tuple = listifyRawValue(entry);
    const itemID = toInt(tuple[0], 0);
    const quantity = Math.max(1, toInt(tuple[1], 1));
    if (itemID > 0) {
      normalized.push({ itemID, quantity });
    }
  }
  return normalized;
}

function isDroneEntity(entity) {
  return Boolean(entity && entity.kind === "drone");
}

function resolveDroneControllerOwnerCharacterID(controllerEntity = null, droneEntity = null) {
  return toInt(
    controllerEntity &&
      (
        controllerEntity.session &&
        controllerEntity.session.characterID
      ) ||
      controllerEntity &&
      (
        controllerEntity.pilotCharacterID ??
        controllerEntity.characterID ??
        controllerEntity.ownerID
      ) ||
      droneEntity &&
      (
        droneEntity.controllerOwnerID ??
        droneEntity.ownerID
      ),
    0,
  );
}

function getRuntime() {
  return lazyRequire("../../space/runtime");
}

function getInterestedDroneSessions(entity) {
  const sessions = new Set();
  const controllerOwnerID = toInt(entity && entity.controllerOwnerID, 0);
  const ownerID = toInt(entity && entity.ownerID, 0);
  const controllerEntity =
    entity && entity.systemID
      ? getRuntime().getEntity(entity.systemID, entity.controllerID)
      : null;

  if (controllerEntity && controllerEntity.session) {
    sessions.add(controllerEntity.session);
  }
  if (controllerOwnerID > 0) {
    const controllerOwnerSession = findSessionByCharacterID(controllerOwnerID);
    if (controllerOwnerSession) {
      sessions.add(controllerOwnerSession);
    }
  }
  if (ownerID > 0) {
    const ownerSession = findSessionByCharacterID(ownerID);
    if (ownerSession) {
      sessions.add(ownerSession);
    }
  }
  return [...sessions];
}

function ensureDroneClientIdentityState(
  entity,
  shipRecord = null,
  sessions = null,
  options = {},
) {
  if (!entity) {
    return false;
  }

  const targetSessions = normalizeDroneSessions(
    Array.isArray(sessions)
      ? sessions
      : getInterestedDroneSessions(entity),
  );
  if (targetSessions.length <= 0) {
    return false;
  }

  const primeCache = getDroneIdentityPrimeCache(entity);
  const forceInsert = options.forceInsert === true;
  const forceRefresh = options.forceRefresh === true;
  const skipInventorySync = options.skipInventorySync === true;
  const skipDogmaPrime = options.skipDogmaPrime === true;
  const sessionsNeedingIdentity = forceInsert || forceRefresh
    ? targetSessions
    : targetSessions.filter((session) => {
        const sessionKey = getDroneIdentityPrimeSessionKey(session);
        return sessionKey <= 0 || !primeCache || !primeCache.has(sessionKey);
      });
  if (sessionsNeedingIdentity.length <= 0) {
    return false;
  }

  const currentItem = findItemById(toInt(entity.itemID, 0));
  if (currentItem && !skipInventorySync) {
    const launchPreviousState = buildDroneLaunchPreviousState(
      entity,
      currentItem,
      shipRecord,
    );
    const previousInventoryState = launchPreviousState ||
      (forceInsert !== true
        ? {
            locationID: currentItem.locationID,
            flagID: currentItem.flagID,
            quantity: currentItem.quantity,
            stacksize: currentItem.stacksize,
            singleton: currentItem.singleton,
          }
        : buildCreatedInventoryInsertPreviousState(currentItem));
    syncInventoryItemToSessions(
      sessionsNeedingIdentity,
      currentItem,
      previousInventoryState,
      {
        emitCfgLocation: false,
      },
    );
  }

  if (shipRecord && !skipDogmaPrime) {
    emitDroneDogmaPrime(entity, shipRecord, sessionsNeedingIdentity, currentItem);
  }

  if (primeCache) {
    for (const session of sessionsNeedingIdentity) {
      const sessionKey = getDroneIdentityPrimeSessionKey(session);
      if (sessionKey > 0) {
        primeCache.add(sessionKey);
      }
    }
  }

  return Boolean(currentItem || shipRecord);
}

function buildDroneStateNotificationTuple(entity, overrides = {}) {
  const hasOverride = (key) =>
    Object.prototype.hasOwnProperty.call(overrides || {}, key);
  const intField = (key, fallback) => (
    hasOverride(key) && overrides[key] === null
      ? null
      : toInt(hasOverride(key) ? overrides[key] : fallback, 0)
  );
  const targetField = (key, fallback) => {
    if (hasOverride(key)) {
      return overrides[key] === null ? null : toInt(overrides[key], 0) || null;
    }
    return toInt(fallback, 0) || null;
  };
  return [
    toInt(overrides.droneID ?? (entity && entity.itemID), 0),
    intField("ownerID", entity && entity.ownerID),
    intField("controllerID", entity && entity.controllerID),
    intField("activityState", entity && entity.activityState),
    intField("typeID", entity && entity.typeID),
    intField("controllerOwnerID", entity && entity.controllerOwnerID),
    targetField("targetID", entity && entity.targetID),
  ];
}

function emitDroneStateChange(entity, overrides = {}, sessions = null) {
  const targetSessions = normalizeDroneSessions(
    Array.isArray(sessions)
      ? sessions
      : getInterestedDroneSessions(entity),
  );
  const payload = buildDroneStateNotificationTuple(entity, overrides);
  for (const session of targetSessions) {
    if (!session || typeof session.sendNotification !== "function") {
      continue;
    }
    session.sendNotification("OnDroneStateChange", "charid", payload);
  }
}

function emitDroneActivityChange(entity, activityID = null, activity = null, sessions = null) {
  const targetSessions = normalizeDroneSessions(
    Array.isArray(sessions)
      ? sessions
      : getInterestedDroneSessions(entity),
  );
  const payload = [
    toInt(entity && entity.itemID, 0),
    toInt(activityID, 0) || null,
    activity === null || activity === undefined ? null : String(activity),
  ];
  for (const session of targetSessions) {
    if (!session || typeof session.sendNotification !== "function") {
      continue;
    }
    session.sendNotification("OnDroneActivityChange", "charid", payload);
  }
}

function emitDroneDogmaPrime(entity, shipRecord, sessions = null, itemOverride = null) {
  if (!entity || !shipRecord) {
    return;
  }

  const targetSessions = normalizeDroneSessions(
    Array.isArray(sessions)
      ? sessions
      : getInterestedDroneSessions(entity),
  );
  if (targetSessions.length === 0) {
    return;
  }

  const currentItem =
    itemOverride && typeof itemOverride === "object"
      ? itemOverride
      : findItemById(toInt(entity.itemID, 0)) || null;
  // Prime launched/returning drones as their real live in-space items. If we
  // advertise them as flag=DRONE_BAY under the controlling ship here, the
  // client synthesizes phantom bay rows and the drone UI/damage tracker churn.
  const dogmaPrimeItem = {
    itemID: toInt(entity.itemID, 0),
    typeID: toInt(
      currentItem && currentItem.typeID,
      toInt(entity.typeID, 0),
    ),
    ownerID: toInt(
      currentItem && currentItem.ownerID,
      toInt(entity.ownerID, 0),
    ),
    locationID: toInt(
      currentItem && currentItem.locationID,
      toInt(entity.systemID, 0),
    ),
    flagID: toInt(currentItem && currentItem.flagID, 0),
    quantity:
      currentItem && currentItem.quantity !== undefined
        ? currentItem.quantity
        : null,
    stacksize: Math.max(
      1,
      toInt(
        currentItem && (currentItem.stacksize ?? currentItem.quantity),
        1,
      ),
    ),
    singleton: toInt(currentItem && currentItem.singleton, 1),
    groupID: toInt(
      currentItem && currentItem.groupID,
      toInt(entity.groupID, 0),
    ),
    categoryID: toInt(
      currentItem && currentItem.categoryID,
      DRONE_CATEGORY_ID,
    ),
    customInfo:
      currentItem && currentItem.customInfo !== undefined && currentItem.customInfo !== null
        ? String(currentItem.customInfo)
        : "",
    moduleState: null,
    conditionState: null,
    launcherID: toInt(shipRecord.itemID, 0),
    volume: toNumber(
      currentItem && currentItem.volume,
      toNumber(entity.volume, null),
    ),
  };
  const primeEntry = buildDogmaPrimeEntry(dogmaPrimeItem, {
    description: "drone",
    includeTypeAttributes: true,
  });
  if (!primeEntry) {
    return;
  }

  const primeLocationID = toInt(
    dogmaPrimeItem.locationID,
    toInt(entity.systemID, 0),
  );
  for (const session of targetSessions) {
    if (!session || typeof session.sendNotification !== "function") {
      continue;
    }
    session.sendNotification("OnGodmaPrimeItem", "clientID", [primeLocationID, primeEntry]);
  }
}

function handleDroneDestroyed(scene, droneEntity) {
  if (!scene || !isDroneEntity(droneEntity)) {
    return false;
  }

  const interestedSessions = getInterestedDroneSessions(droneEntity);
  if (interestedSessions.length <= 0) {
    return false;
  }

  emitDroneStateChange(droneEntity, {
    ownerID: 0,
    controllerID: 0,
    activityState: STATE_IDLE,
    controllerOwnerID: 0,
    targetID: 0,
  }, interestedSessions);
  emitDroneActivityChange(droneEntity, null, null, interestedSessions);
  markSceneControlledCombatDroneIndexDirty(scene);
  return true;
}

function markSceneControlledCombatDroneIndexDirty(scene) {
  if (!scene) {
    return;
  }
  scene.droneControlledCombatIndexDirty = true;
}

function pruneSceneDroneAggressionThreats(scene, now) {
  if (!scene || !(scene.droneAggressionThreatsByController instanceof Map)) {
    return;
  }
  const threshold = toNumber(now, Date.now()) - DRONE_AGGRESSION_THREAT_RETENTION_MS;
  for (const [controllerID, threatMap] of scene.droneAggressionThreatsByController.entries()) {
    if (!(threatMap instanceof Map)) {
      scene.droneAggressionThreatsByController.delete(controllerID);
      continue;
    }
    for (const [targetID, lastAggressedAtMs] of threatMap.entries()) {
      if (toNumber(lastAggressedAtMs, 0) < threshold) {
        threatMap.delete(targetID);
      }
    }
    if (threatMap.size <= 0) {
      scene.droneAggressionThreatsByController.delete(controllerID);
    }
  }
}

function getSceneDroneAggressionThreats(scene) {
  if (!scene) {
    return new Map();
  }
  if (!(scene.droneAggressionThreatsByController instanceof Map)) {
    scene.droneAggressionThreatsByController = new Map();
  }
  return scene.droneAggressionThreatsByController;
}

function isDroneCombatCapable(droneEntity, controllerEntity = null) {
  if (!isDroneEntity(droneEntity)) {
    return false;
  }
  if (typeof droneEntity.droneCombatCapable === "boolean") {
    return droneEntity.droneCombatCapable;
  }
  droneEntity.droneCombatCapable = Boolean(
    resolveDroneCombatSnapshot(droneEntity, controllerEntity) || null,
  );
  return droneEntity.droneCombatCapable;
}

function normalizeDroneBehaviorSettings(rawSettings = null) {
  const source =
    rawSettings && typeof rawSettings === "object"
      ? rawSettings
      : {};
  return {
    aggressive: Object.prototype.hasOwnProperty.call(
      source,
      ATTRIBUTE_DRONE_IS_AGGRESSIVE,
    )
      ? Boolean(source[ATTRIBUTE_DRONE_IS_AGGRESSIVE])
      : DEFAULT_DRONE_IS_AGGRESSIVE,
    focusFire: Object.prototype.hasOwnProperty.call(
      source,
      ATTRIBUTE_DRONE_FOCUS_FIRE,
    )
      ? Boolean(source[ATTRIBUTE_DRONE_FOCUS_FIRE])
      : DEFAULT_DRONE_FOCUS_FIRE,
  };
}

function getControllerDroneBehaviorSettings(controllerEntity = null) {
  const characterID = resolveDroneControllerOwnerCharacterID(controllerEntity);
  const controllerSession =
    controllerEntity &&
    controllerEntity.session &&
    typeof controllerEntity.session === "object"
      ? controllerEntity.session
      : characterID > 0
        ? findSessionByCharacterID(characterID)
        : null;
  const cachedSettings =
    controllerSession &&
    controllerSession.droneSettings &&
    typeof controllerSession.droneSettings === "object"
      ? controllerSession.droneSettings
      : null;
  if (cachedSettings) {
    return normalizeDroneBehaviorSettings(cachedSettings);
  }

  const characterRecord = characterID > 0 ? resolveCharacterRecord(characterID) || null : null;
  const persistedSettings =
    characterRecord &&
    characterRecord.droneSettings &&
    typeof characterRecord.droneSettings === "object"
      ? characterRecord.droneSettings
      : {};
  const normalizedSettings = normalizeDroneBehaviorSettings(persistedSettings);
  if (controllerSession) {
    controllerSession.droneSettings = {
      ...persistedSettings,
      [ATTRIBUTE_DRONE_IS_AGGRESSIVE]: normalizedSettings.aggressive,
      [ATTRIBUTE_DRONE_FOCUS_FIRE]: normalizedSettings.focusFire,
    };
  }
  return normalizedSettings;
}

function isCreatedInventoryChange(change) {
  if (!change || !change.item || !change.previousData) {
    return false;
  }
  const previousLocationID = toInt(change.previousData.locationID, 0);
  const previousQuantity = Number(change.previousData.quantity);
  const previousStacksize = Number(change.previousData.stacksize);
  return previousLocationID === 0 && (
    previousQuantity === 0 ||
    previousStacksize === 0
  );
}

function emitRelevantInventoryChanges(session, shipID, changes = [], options = {}) {
  const numericShipID = toInt(shipID, 0);
  if (!session || numericShipID <= 0) {
    return;
  }
  const includeCreatedItems = options.includeCreatedItems === true;
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    const currentLocationID = toInt(change.item.locationID, 0);
    const previousLocationID = toInt(change.previousData && change.previousData.locationID, 0);
    if (
      currentLocationID !== numericShipID &&
      previousLocationID !== numericShipID &&
      !(includeCreatedItems && isCreatedInventoryChange(change))
    ) {
      continue;
    }
    syncInventoryItemForCharacterSession(session, change.item, change.previousData || {}, {
      emitCfgLocation: true,
    });
  }
}

function resolveShipStorageSnapshotForDrone(controllerEntity) {
  if (!controllerEntity) {
    return null;
  }

  const characterID = toInt(
    controllerEntity &&
      (
        controllerEntity.session &&
        controllerEntity.session.characterID
      ) ||
      controllerEntity &&
      (
        controllerEntity.pilotCharacterID ??
        controllerEntity.characterID ??
        controllerEntity.ownerID
      ),
    0,
  );
  const shipID = toInt(controllerEntity && controllerEntity.itemID, 0);
  if (characterID <= 0 || shipID <= 0) {
    return null;
  }

  const shipItem = findItemById(shipID) || null;
  if (!shipItem) {
    return null;
  }

  // The ship's resource state (cargo/hold CAPACITIES) is invariant between ore
  // deliveries — it only changes on a refit/skill/implant change, which the
  // controller dogma fingerprint already tracks. Cache it on that fingerprint so a
  // tick where every drone delivers at once rebuilds buildShipResourceState ONCE
  // (it was the dominant ore-delivery spike: ~530ms/call live before the dogma
  // clone fixes, still ~74ms after) instead of once per drone, and it then holds
  // across deliveries until an actual refit. usedByFlag (volume currently stored)
  // DOES change per delivery, so it is always recomputed fresh from the item index
  // (cheap). When no fingerprint is available (flag off / no dogma context yet) we
  // rebuild every call, exactly as before.
  const resourceFingerprint =
    (controllerEntity.droneDogmaCache &&
      controllerEntity.droneDogmaCache.fingerprint) ||
    null;
  let resourceState;
  if (
    resourceFingerprint &&
    controllerEntity.droneResourceStateCache &&
    controllerEntity.droneResourceStateCache.fingerprint === resourceFingerprint
  ) {
    resourceState = controllerEntity.droneResourceStateCache.resourceState;
  } else {
    resourceState = buildShipResourceState(characterID, shipItem, {
      skillMap: controllerEntity.skillMap,
      fittedItems: controllerEntity.fittedItems,
    });
    if (resourceFingerprint) {
      controllerEntity.droneResourceStateCache = {
        fingerprint: resourceFingerprint,
        resourceState,
      };
    }
  }

  const usedByFlag = new Map();
  for (const item of listContainerItems(characterID, shipID, null)) {
    const flagID = toInt(item && item.flagID, 0);
    const units = Math.max(
      0,
      toInt(item && (item.stacksize ?? item.quantity), 1) || 1,
    );
    const itemVolume = Math.max(
      0,
      toNumber(item && item.volume, 0),
    );
    usedByFlag.set(
      flagID,
      Number(
        (
          toNumber(usedByFlag.get(flagID), 0) +
          (itemVolume * units)
        ).toFixed(6)
      ),
    );
  }

  return {
    characterID,
    shipID,
    resourceState,
    usedByFlag,
  };
}

function getAvailableDroneStorageVolume(storageSnapshot, flagID) {
  if (!storageSnapshot || !storageSnapshot.resourceState) {
    return 0;
  }

  const normalizedFlagID = toInt(flagID, 0);
  const capacity =
    normalizedFlagID === ITEM_FLAGS.CARGO_HOLD
      ? toNumber(storageSnapshot.resourceState.cargoCapacity, 0)
      : getShipHoldCapacityByFlag(
        storageSnapshot.resourceState,
        normalizedFlagID,
      );
  const used = toNumber(storageSnapshot.usedByFlag.get(normalizedFlagID), 0);
  return Math.max(0, Number((capacity - used).toFixed(6)));
}

function classifyDroneMiningYieldKind(droneEntity) {
  const typeRecord = resolveItemByTypeID(toInt(droneEntity && droneEntity.typeID, 0)) || null;
  const droneName = String(
    typeRecord && typeRecord.name ||
    droneEntity && droneEntity.itemName ||
    "",
  ).trim().toLowerCase();
  if (!droneName) {
    return null;
  }
  if (droneName.includes("ice harvesting")) {
    return "ice";
  }
  if (droneName.includes("excavator") || droneName.includes("mining")) {
    return "ore";
  }
  return null;
}

function isDroneMiningCompatibleWithTarget(droneEntity, mineableState) {
  if (!droneEntity || !mineableState) {
    return false;
  }
  const family = classifyDroneMiningYieldKind(droneEntity);
  if (!family) {
    return false;
  }
  return family === String(mineableState.yieldKind || "").trim().toLowerCase();
}

function resolveDroneMiningDestination(controllerEntity, yieldTypeID, yieldKind = "") {
  const storageSnapshot = resolveShipStorageSnapshotForDrone(controllerEntity);
  if (!storageSnapshot) {
    return null;
  }

  const preferredFlag = getPreferredMiningHoldFlagForType(
    storageSnapshot.resourceState,
    yieldTypeID,
  );
  const normalizedYieldKind = String(yieldKind || "").trim().toLowerCase();
  const orderedFlags = [
    preferredFlag,
    normalizedYieldKind === "ore" ? MINING_HOLD_FLAGS.SPECIALIZED_ASTEROID_HOLD : null,
    normalizedYieldKind === "gas" ? MINING_HOLD_FLAGS.SPECIALIZED_GAS_HOLD : null,
    normalizedYieldKind === "ice" ? MINING_HOLD_FLAGS.SPECIALIZED_ICE_HOLD : null,
    MINING_HOLD_FLAGS.GENERAL_MINING_HOLD,
    ITEM_FLAGS.CARGO_HOLD,
  ].filter((value, index, array) => value && array.indexOf(value) === index);
  for (const flagID of orderedFlags) {
    const availableVolume = getAvailableDroneStorageVolume(
      storageSnapshot,
      flagID,
    );
    if (availableVolume > 0) {
      return {
        storageSnapshot,
        flagID,
        availableVolume,
      };
    }
  }

  return {
    storageSnapshot,
    flagID: preferredFlag || ITEM_FLAGS.CARGO_HOLD,
    availableVolume: 0,
  };
}

function getDroneMiningCycleDurationMs(snapshot) {
  return Math.max(1, toNumber(snapshot && snapshot.durationMs, 1000));
}

function beginDroneMiningCycle(miningState, snapshot, now) {
  if (!miningState || typeof miningState !== "object") {
    return false;
  }

  const cycleStartedAtMs = Math.max(0, toNumber(now, Date.now()));
  miningState.cycleStartedAtMs = cycleStartedAtMs;
  miningState.nextCycleAtMs =
    cycleStartedAtMs + getDroneMiningCycleDurationMs(snapshot);
  miningState.fxCycleKey = null;
  return true;
}

function clearDroneMiningCycle(miningState) {
  if (!miningState || typeof miningState !== "object") {
    return false;
  }
  miningState.cycleStartedAtMs = null;
  miningState.nextCycleAtMs = null;
  miningState.fxCycleKey = null;
  return true;
}

function resolveDroneMiningFxTargetID(targetEntityOrID) {
  return toInt(
    targetEntityOrID && typeof targetEntityOrID === "object"
      ? targetEntityOrID.itemID
      : targetEntityOrID,
    0,
  );
}

function emitDroneMiningCycleFx(
  scene,
  droneEntity,
  targetEntityOrID,
  snapshot,
  miningState,
  now,
  options = {},
) {
  if (!scene || !droneEntity || !snapshot || !snapshot.effectGUID) {
    return false;
  }

  const targetID = resolveDroneMiningFxTargetID(targetEntityOrID);
  if (targetID <= 0) {
    return false;
  }

  const active = options.active !== false;
  const durationMs = getDroneMiningCycleDurationMs(snapshot);
  const cycleStartedAtMs = toNumber(
    miningState && miningState.cycleStartedAtMs,
    toNumber(now, Date.now()),
  );
  const fxCycleKey = `${targetID}:${Math.trunc(cycleStartedAtMs)}:${durationMs}`;
  if (active && miningState && miningState.fxCycleKey === fxCycleKey) {
    return false;
  }

  scene.broadcastSpecialFx(
    droneEntity.itemID,
    snapshot.effectGUID,
    {
      moduleID: droneEntity.itemID,
      moduleTypeID: droneEntity.typeID,
      targetID,
      isOffensive: false,
      start: active,
      active: true,
      duration: durationMs,
      repeat: 1,
      useCurrentVisibleStamp: true,
    },
    droneEntity,
  );

  if (miningState) {
    miningState.fxCycleKey = active ? fxCycleKey : null;
  }
  return true;
}

function stopDroneMiningCycleFx(scene, droneEntity) {
  const miningState =
    droneEntity &&
    droneEntity.droneMining &&
    typeof droneEntity.droneMining === "object"
      ? droneEntity.droneMining
      : null;
  if (!miningState || !miningState.fxCycleKey) {
    return false;
  }
  return emitDroneMiningCycleFx(
    scene,
    droneEntity,
    miningState.targetID,
    miningState.snapshot,
    miningState,
    Date.now(),
    { active: false },
  );
}

function syncDroneInventoryChangesToSession(session, changes = []) {
  if (!session || typeof session.sendNotification !== "function") {
    return;
  }
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }
    syncInventoryItemForCharacterSession(
      session,
      change.item,
      change.previousData || change.previousState || {},
      {
        emitCfgLocation: true,
      },
    );
  }
}

function clearDroneTaskState(droneEntity) {
  if (!droneEntity) {
    return;
  }
  droneEntity.droneCommand = null;
  droneEntity.droneCombat = null;
  droneEntity.droneMining = null;
  droneEntity.droneSalvage = null;
  droneEntity.droneRepair = null;
  droneEntity.activityID = null;
  droneEntity.activity = null;
}

function copyControllerIdentity(droneEntity, controllerEntity = null, controllerOwnerID = 0) {
  if (!droneEntity) {
    return;
  }

  const fallbackControllerOwnerID = toInt(
    (
      controllerEntity &&
      controllerEntity.session &&
      controllerEntity.session.characterID
    ) ||
      (
        controllerEntity &&
        (
          controllerEntity.pilotCharacterID ??
          controllerEntity.characterID ??
          droneEntity.ownerID
        )
      ),
    0,
  );
  const resolvedControllerOwnerID =
    toInt(controllerOwnerID, 0) > 0
      ? toInt(controllerOwnerID, 0)
      : fallbackControllerOwnerID;
  droneEntity.controllerOwnerID = resolvedControllerOwnerID;
  droneEntity.characterID = toInt(droneEntity.ownerID, resolvedControllerOwnerID);
  droneEntity.pilotCharacterID = resolvedControllerOwnerID;
  if (controllerEntity) {
    droneEntity.corporationID = toInt(
      controllerEntity.corporationID,
      toInt(droneEntity.corporationID, 0),
    );
    droneEntity.allianceID = toInt(
      controllerEntity.allianceID,
      toInt(droneEntity.allianceID, 0),
    );
    droneEntity.warFactionID = toInt(
      controllerEntity.warFactionID,
      toInt(droneEntity.warFactionID, 0),
    );
    applyDroneOperationalEntityAttributes(droneEntity, controllerEntity);
  }
}

function applyDroneOperationalEntityAttributes(droneEntity, controllerEntity = null) {
  if (!isDroneEntity(droneEntity) || !controllerEntity) {
    return false;
  }
  const attributes = resolveDroneOperationalAttributes(droneEntity, controllerEntity);
  if (!attributes || Object.keys(attributes).length <= 0) {
    return false;
  }

  const mass = Math.max(
    1,
    toNumber(attributes[ATTRIBUTE_MASS], droneEntity.mass || 1),
  );
  const inertia = Math.max(
    0.05,
    toNumber(attributes[ATTRIBUTE_AGILITY], droneEntity.inertia || 0.1),
  );
  const motionCommand = createDroneOperationalMotionCommand({
    droneEntity,
    mass,
    inertia,
  });
  motionCommand.applyMassAndInertia();
  const maxVelocity = Math.max(
    1,
    toNumber(attributes[ATTRIBUTE_MAX_VELOCITY], droneEntity.maxVelocity || 1),
  );
  motionCommand.applyVelocityAndAgility({
    maxVelocity,
    resolveAlignTime: () => inertia * Math.log(4),
    maxAccelerationTime: inertia,
    resolveAgilitySeconds: () => Math.max((mass * inertia) / 1000000, 0.05),
  });
  droneEntity.shieldCapacity = Math.max(
    0,
    toNumber(attributes[ATTRIBUTE_SHIELD_CAPACITY], droneEntity.shieldCapacity || 0),
  );
  droneEntity.shieldRechargeRate = Math.max(
    0,
    toNumber(
      attributes[ATTRIBUTE_SHIELD_RECHARGE_RATE],
      droneEntity.shieldRechargeRate || 0,
    ),
  );
  droneEntity.armorHP = Math.max(
    0,
    toNumber(attributes[ATTRIBUTE_ARMOR_HP], droneEntity.armorHP || 0),
  );
  droneEntity.structureHP = Math.max(
    0,
    toNumber(attributes[ATTRIBUTE_STRUCTURE_HP], droneEntity.structureHP || 0),
  );
  droneEntity.passiveDerivedState = {
    ...(droneEntity.passiveDerivedState || {}),
    attributes: { ...attributes },
  };
  return true;
}

function captureDroneClientState(entity) {
  return {
    ownerID: toInt(entity && entity.ownerID, 0),
    controllerID: toInt(entity && entity.controllerID, 0),
    activityState: toInt(entity && entity.activityState, STATE_IDLE),
    typeID: toInt(entity && entity.typeID, 0),
    controllerOwnerID: toInt(entity && entity.controllerOwnerID, 0),
    targetID: toInt(entity && entity.targetID, 0) || null,
  };
}

function didDroneClientStateChange(before, entity) {
  if (!before || !entity) {
    return true;
  }
  return (
    before.ownerID !== toInt(entity.ownerID, 0) ||
    before.controllerID !== toInt(entity.controllerID, 0) ||
    before.activityState !== toInt(entity.activityState, STATE_IDLE) ||
    before.typeID !== toInt(entity.typeID, 0) ||
    before.controllerOwnerID !== toInt(entity.controllerOwnerID, 0) ||
    before.targetID !== (toInt(entity.targetID, 0) || null)
  );
}

function persistAndNotifyDroneState(droneEntity, beforeState = null, sessions = null) {
  persistDroneEntityState(droneEntity);
  if (!beforeState || didDroneClientStateChange(beforeState, droneEntity)) {
    emitDroneStateChange(droneEntity, {}, sessions);
  }
}

function buildDronePseudoModuleItem(droneEntity) {
  return {
    itemID: toInt(droneEntity && droneEntity.itemID, 0),
    typeID: toInt(droneEntity && droneEntity.typeID, 0),
    groupID: toInt(droneEntity && droneEntity.groupID, 0),
    flagID: 0,
    locationID: toInt(droneEntity && droneEntity.itemID, 0),
    singleton: 1,
    quantity: 1,
    stacksize: 1,
    itemName: String(droneEntity && droneEntity.itemName || "Drone"),
    moduleState: {
      isOnline: true,
      isActive: true,
    },
  };
}

function resolveDroneControllerSession(droneEntity, controllerEntity = null) {
  if (
    controllerEntity &&
    controllerEntity.session &&
    typeof controllerEntity.session.sendNotification === "function"
  ) {
    return controllerEntity.session;
  }

  const controllerCharacterID = resolveDroneControllerOwnerCharacterID(
    controllerEntity,
    droneEntity,
  );
  if (controllerCharacterID <= 0) {
    return null;
  }
  return findSessionByCharacterID(controllerCharacterID) || null;
}

function buildDroneCombatSourceEntity(droneEntity, controllerEntity = null) {
  if (!droneEntity) {
    return null;
  }

  const controllerSession = resolveDroneControllerSession(
    droneEntity,
    controllerEntity,
  );
  const controllerCharacterID = resolveDroneControllerOwnerCharacterID(
    controllerEntity,
    droneEntity,
  );
  return {
    ...droneEntity,
    session: controllerSession,
    characterID: controllerCharacterID || toInt(droneEntity.characterID, 0) || null,
    pilotCharacterID:
      controllerCharacterID || toInt(droneEntity.pilotCharacterID, 0) || null,
  };
}

function getEntitySurfaceDistance(left, right) {
  return Math.max(
    0,
    distance(left && left.position, right && right.position) -
      Math.max(0, toNumber(left && left.radius, 0)) -
      Math.max(0, toNumber(right && right.radius, 0)),
  );
}

function syncDroneOrbitBehavior(scene, droneEntity, targetEntity, orbitDistanceMeters) {
  if (!scene || !droneEntity || !targetEntity) {
    return false;
  }
  return scene.orbitShipEntity(
    droneEntity,
    targetEntity.itemID,
    Math.max(0, toNumber(orbitDistanceMeters, 0)),
    {
      broadcast: true,
    },
  );
}

function syncDronePursuitBehavior(scene, droneEntity, targetEntity, followRangeMeters) {
  if (!scene || !droneEntity || !targetEntity) {
    return false;
  }
  return scene.followShipEntity(
    droneEntity,
    targetEntity.itemID,
    Math.max(0, toNumber(followRangeMeters, 0)),
    {
      broadcast: true,
    },
  );
}

function resolveDroneEngagementRanges(snapshot, fallbackRangeMeters = MIN_ORBIT_DISTANCE_METERS) {
  const orbitDistance = Math.max(
    MIN_ORBIT_DISTANCE_METERS,
    toNumber(
      snapshot && snapshot.orbitDistanceMeters,
      fallbackRangeMeters,
    ),
  );
  const attackRange = Math.max(
    0,
    toNumber(snapshot && snapshot.attackRangeMeters, 0),
  );
  const engagementRange = attackRange > 0 ? attackRange : orbitDistance;
  return {
    orbitDistance,
    engagementRange,
    movementRange: Math.min(orbitDistance, engagementRange),
    chaseRange: Math.max(
      engagementRange,
      toNumber(
        snapshot && snapshot.chaseRangeMeters,
        engagementRange,
      ),
    ),
  };
}

function shouldDroneOrbitTarget(targetEntity) {
  return magnitude(targetEntity && targetEntity.velocity) <= 50;
}

function persistDroneEntityState(entity) {
  if (!isDroneEntity(entity)) {
    return false;
  }
  if (entity.transientNpcDrone === true) {
    return true;
  }
  const result = updateInventoryItem(entity.itemID, (currentItem) => ({
    ...currentItem,
    locationID: toInt(entity.systemID, toInt(currentItem.locationID, 0)),
    flagID: 0,
    singleton: 1,
    quantity: null,
    stacksize: 1,
    launcherID: toInt(entity.launcherID ?? entity.controllerID, 0) || null,
    spaceState: serializeDroneSpaceState(entity),
  }));
  return result.success;
}

function getDroneBandwidthLoad(droneItemOrTypeID) {
  const sourceRecord =
    droneItemOrTypeID && typeof droneItemOrTypeID === "object"
      ? droneItemOrTypeID
      : { typeID: droneItemOrTypeID };
  const itemRecord =
    sourceRecord &&
    !sourceRecord.customInfo &&
    toInt(sourceRecord.itemID, 0) > 0
      ? findItemById(sourceRecord.itemID) || sourceRecord
      : sourceRecord;
  const typeID = toInt(itemRecord && itemRecord.typeID, 0);
  const attributes = buildEffectiveItemAttributeMap(itemRecord);
  return Math.max(
    0,
    toNumber(
      attributes[ATTRIBUTE_DRONE_BANDWIDTH_USED],
      getTypeAttributeValue(typeID, "droneBandwidthUsed", "droneBandwidthLoad", "droneBandwidth"),
      0,
    ),
  );
}

function resolveDroneRuntimeItemRecord(droneItemOrEntity) {
  const sourceRecord =
    droneItemOrEntity && typeof droneItemOrEntity === "object"
      ? droneItemOrEntity
      : { typeID: droneItemOrEntity };
  return sourceRecord &&
    !sourceRecord.customInfo &&
    toInt(sourceRecord.itemID, 0) > 0
      ? findItemById(sourceRecord.itemID) || sourceRecord
      : sourceRecord;
}

function resolveDroneOrbitDistance(entity) {
  const itemRecord = resolveDroneRuntimeItemRecord(entity);
  const typeID = toInt(itemRecord && itemRecord.typeID, toInt(entity && entity.typeID, 0));
  const attributes = buildEffectiveItemAttributeMap(itemRecord || typeID);
  const authoredOrbitDistance = toNumber(
    attributes[ATTRIBUTE_ORBIT_RANGE] ?? getTypeAttributeValue(typeID, "orbitRange"),
    0,
  );
  if (authoredOrbitDistance > 0) {
    return clamp(
      authoredOrbitDistance,
      MIN_ORBIT_DISTANCE_METERS,
      MAX_ORBIT_DISTANCE_METERS,
    );
  }
  return MIN_ORBIT_DISTANCE_METERS;
}

function buildDroneLaunchSpaceState(shipEntity, launchIndex = 0) {
  const shipDirection = normalizeVector(shipEntity && shipEntity.direction, { x: 1, y: 0, z: 0 });
  const lateralDirection = buildPerpendicular(shipDirection);
  const launchDistance =
    Math.max(
      toNumber(shipEntity && shipEntity.radius, 0),
      ONE_METER,
    ) +
    DEFAULT_DRONE_LAUNCH_OFFSET_METERS;
  const lateralOffset = (launchIndex % 5) * 30;
  const signedSide = launchIndex % 2 === 0 ? 1 : -1;
  const position = addVectors(
    addVectors(
      cloneVector(shipEntity && shipEntity.position),
      scaleVector(shipDirection, launchDistance),
    ),
    scaleVector(lateralDirection, lateralOffset * signedSide),
  );
  return {
    systemID: toInt(shipEntity && shipEntity.systemID, 0),
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: shipDirection,
    targetPoint: cloneVector(position),
    speedFraction: 0,
    mode: "STOP",
    targetEntityID: null,
    followRange: 0,
    orbitDistance: 0,
    orbitNormal: buildPerpendicular(shipDirection),
    orbitSign: 1,
    pendingWarp: null,
    warpState: null,
    ...buildPlayerCompanionScopeMetadata(shipEntity),
  };
}

function hydrateDroneEntityFromItem(entity, itemRecord = null) {
  if (!isDroneEntity(entity)) {
    return entity;
  }

  const item = itemRecord || findItemById(entity.itemID) || null;
  const typeID = toInt(item && item.typeID, toInt(entity.typeID, 0));
  const attributes = buildEffectiveItemAttributeMap(item || entity);
  const mass = Math.max(
    1,
    toNumber(
      attributes[ATTRIBUTE_MASS] ?? getTypeAttributeValue(typeID, "mass"),
      entity.mass || 1,
    ),
  );
  const inertia = Math.max(
    0.05,
    toNumber(
      attributes[ATTRIBUTE_AGILITY] ?? getTypeAttributeValue(typeID, "agility"),
      entity.inertia || 0.1,
    ),
  );
  const maxVelocity = Math.max(
    1,
    toNumber(
      attributes[ATTRIBUTE_MAX_VELOCITY] ?? getTypeAttributeValue(typeID, "maxVelocity"),
      entity.maxVelocity || 1,
    ),
  );

  entity.kind = "drone";
  applyPlayerCompanionScopeMetadata(entity, item);
  applyPlayerCompanionScopeMetadata(entity, item && item.spaceState);
  entity.typeID = typeID;
  entity.groupID = toInt(item && item.groupID, toInt(entity.groupID, 0));
  entity.categoryID = DRONE_CATEGORY_ID;
  entity.ownerID = toInt(item && item.ownerID, toInt(entity.ownerID, 0));
  entity.itemName = String(item && item.itemName || entity.itemName || "Drone");
  entity.customInfo =
    item && item.customInfo !== undefined && item.customInfo !== null
      ? String(item.customInfo)
      : String(entity.customInfo || "");
  entity.mass = mass;
  entity.inertia = inertia;
  entity.maxVelocity = maxVelocity;
  entity.alignTime = inertia * Math.log(4);
  entity.maxAccelerationTime = inertia;
  entity.agilitySeconds = Math.max((mass * inertia) / 1000000, 0.05);
  entity.launcherID = toInt(item && item.launcherID, toInt(entity.launcherID, 0)) || null;
  entity.controllerID = toInt(entity.controllerID, entity.launcherID || 0) || null;
  entity.controllerOwnerID = toInt(entity.controllerOwnerID, entity.ownerID);
  entity.activityState = toInt(entity.activityState, STATE_IDLE);
  entity.targetID = toInt(entity.targetID, 0) || null;
  entity.droneStateVisible = entity.controllerID > 0;
  entity.persistSpaceState = true;
  if (!(entity.lockedTargets instanceof Map)) {
    entity.lockedTargets = new Map();
  }
  if (!(entity.pendingTargetLocks instanceof Map)) {
    entity.pendingTargetLocks = new Map();
  }
  if (!(entity.targetedBy instanceof Set)) {
    entity.targetedBy = new Set();
  }
  if (!(entity.activeModuleEffects instanceof Map)) {
    entity.activeModuleEffects = new Map();
  }
  if (!(entity.moduleReactivationLocks instanceof Map)) {
    entity.moduleReactivationLocks = new Map();
  }
  if (!entity.mode) {
    entity.mode = "STOP";
  }
  if (!entity.direction) {
    entity.direction = { x: 1, y: 0, z: 0 };
  }
  if (!entity.position) {
    entity.position = { x: 0, y: 0, z: 0 };
  }
  if (!entity.velocity) {
    entity.velocity = { x: 0, y: 0, z: 0 };
  }
  if (!entity.targetPoint) {
    entity.targetPoint = cloneVector(entity.position);
  }
  return entity;
}

function buildDroneStateRows(entities = []) {
  return entities
    .filter(isDroneEntity)
    .filter((entity) => toInt(entity.controllerID, 0) > 0)
    .map((entity) => [
      toInt(entity.itemID, 0),
      toInt(entity.ownerID, 0),
      toInt(entity.controllerID, 0),
      toInt(entity.activityState, STATE_IDLE),
      toInt(entity.typeID, 0),
      toInt(entity.controllerOwnerID, 0),
      toInt(entity.targetID, 0) || null,
    ]);
}

function getShipStateForSession(session) {
  const characterID = toInt(session && (session.characterID || session.charid), 0);
  if (characterID <= 0) {
    return null;
  }

  const shipRecord = resolveActiveShipRecord(characterID);
  const runtime = getRuntime();
  const scene =
    shipRecord && session && session._space
      ? runtime.ensureScene(toInt(session._space.systemID, 0))
      : null;
  const shipEntity = scene && shipRecord
    ? scene.getEntityByID(shipRecord.itemID)
    : null;

  if (!shipRecord || !scene || !shipEntity) {
    return null;
  }

  return {
    characterID,
    shipRecord,
    shipEntity,
    scene,
  };
}

function getSceneDroneEntities(scene) {
  if (!scene || !(scene.dynamicEntities instanceof Map) || scene.dynamicEntities.size === 0) {
    return [];
  }

  if (scene.droneEntityIDs instanceof Set && scene.droneEntityIDs.size > 0) {
    return [...scene.droneEntityIDs]
      .map((entityID) => scene.dynamicEntities.get(entityID) || null)
      .filter(Boolean);
  }

  const drones = [];
  for (const entity of scene.dynamicEntities.values()) {
    if (isDroneEntity(entity)) {
      drones.push(entity);
    }
  }
  return drones;
}

function listControlledDroneEntities(scene, shipID) {
  const numericShipID = toInt(shipID, 0);
  return getSceneDroneEntities(scene)
    .filter((entity) => toInt(entity.controllerID, 0) === numericShipID);
}

function getSceneControlledCombatDroneIndex(scene) {
  if (!scene) {
    return new Map();
  }

  const expectedCount =
    scene.droneEntityIDs instanceof Set
      ? scene.droneEntityIDs.size
      : 0;
  if (
    scene.droneControlledCombatIndex instanceof Map &&
    scene.droneControlledCombatIndexDirty !== true &&
    toInt(scene.droneControlledCombatIndexCount, -1) === expectedCount
  ) {
    return scene.droneControlledCombatIndex;
  }

  const byControllerID = new Map();
  const controllerCache = new Map();
  for (const droneEntity of getSceneDroneEntities(scene)) {
    const controllerID = toInt(droneEntity && droneEntity.controllerID, 0);
    if (controllerID <= 0) {
      continue;
    }

    const controllerEntity = controllerCache.has(controllerID)
      ? controllerCache.get(controllerID)
      : scene.getEntityByID(controllerID) || null;
    controllerCache.set(controllerID, controllerEntity);
    if (!isDroneCombatCapable(droneEntity, controllerEntity)) {
      continue;
    }

    let entry = byControllerID.get(controllerID);
    if (!entry) {
      entry = {
        combatDroneIDs: [],
        idleCombatDroneIDs: [],
      };
      byControllerID.set(controllerID, entry);
    }
    entry.combatDroneIDs.push(droneEntity.itemID);
    if (!droneEntity.droneCommand) {
      entry.idleCombatDroneIDs.push(droneEntity.itemID);
    }
  }

  scene.droneControlledCombatIndex = byControllerID;
  scene.droneControlledCombatIndexDirty = false;
  scene.droneControlledCombatIndexCount = expectedCount;
  return byControllerID;
}

function selectAggressiveTargetIDs(scene, controllerEntity, preferredTargetID, options = {}) {
  const controllerID = toInt(controllerEntity && controllerEntity.itemID, 0);
  const primaryTargetID = toInt(preferredTargetID, 0);
  const now = toNumber(options.nowMs, Date.now());
  const focusFire = options.focusFire === true;
  const desiredCount = Math.max(0, toInt(options.desiredCount, 0));
  if (!scene || controllerID <= 0 || primaryTargetID <= 0 || desiredCount <= 0) {
    return [];
  }

  const threatsByController = getSceneDroneAggressionThreats(scene);
  const controllerThreats = threatsByController.get(controllerID) || new Map();
  controllerThreats.set(primaryTargetID, now);
  threatsByController.set(controllerID, controllerThreats);
  pruneSceneDroneAggressionThreats(scene, now);

  const recentTargets = [...controllerThreats.entries()]
    .filter(([targetID, lastAggressedAtMs]) => (
      toNumber(lastAggressedAtMs, 0) >= now - DRONE_AGGRESSION_THREAT_RETENTION_MS &&
      Boolean(scene.getEntityByID(toInt(targetID, 0)))
    ))
    .sort((left, right) => (
      toNumber(right[1], 0) - toNumber(left[1], 0) ||
      toInt(left[0], 0) - toInt(right[0], 0)
    ))
    .map(([targetID]) => toInt(targetID, 0))
    .filter((targetID) => targetID > 0);
  if (recentTargets.length <= 0) {
    return [];
  }
  if (focusFire) {
    return Array.from({ length: desiredCount }, () => recentTargets[0]);
  }
  return recentTargets.slice(0, Math.min(desiredCount, recentTargets.length));
}

function isGovernedTransientNpcCombatAssignment(
  droneEntity,
  controllerEntity,
  targetEntity,
) {
  return Boolean(
    droneEntity &&
    droneEntity.transientNpcDrone === true &&
    controllerEntity &&
    controllerEntity.nativeNpc === true &&
    targetEntity &&
    targetEntity.nativeNpc === true,
  );
}

function assignDroneCombatTask(scene, droneEntity, controllerEntity, targetEntity, options = {}) {
  const governedTransientNpcAssignment =
    isGovernedTransientNpcCombatAssignment(
      droneEntity,
      controllerEntity,
      targetEntity,
    );
  if (
    !scene ||
    !isDroneEntity(droneEntity) ||
    !controllerEntity ||
    !targetEntity ||
    !hasDamageableHealth(targetEntity) ||
    (
      !governedTransientNpcAssignment &&
      !canPlayerCompanionActOnTarget(
        scene,
        options.session || null,
        droneEntity,
        controllerEntity,
        targetEntity,
      )
    )
  ) {
    return {
      success: false,
      errorMsg: "DRONE_INVALID_COMBAT_ASSIGNMENT",
    };
  }

  const snapshot = resolveDroneCombatSnapshot(droneEntity, controllerEntity);
  if (!snapshot) {
    return {
      success: false,
      errorMsg: "DRONE_NO_COMBAT_PROFILE",
    };
  }

  const now = Math.max(
    0,
    toNumber(
      options.nowMs,
      scene && typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : Date.now(),
    ),
  );
  const beforeState = captureDroneClientState(droneEntity);
  const controllerCharacterID = resolveDroneControllerOwnerCharacterID(
    controllerEntity,
    droneEntity,
  );
  copyControllerIdentity(droneEntity, controllerEntity, controllerCharacterID);
  droneEntity.launcherID = toInt(controllerEntity.itemID, 0);
  droneEntity.controllerID = toInt(controllerEntity.itemID, 0);
  droneEntity.droneCommand = DRONE_COMMAND_ENGAGE;
  droneEntity.droneCombat = {
    targetID: toInt(targetEntity.itemID, 0),
    nextCycleAtMs: now,
    snapshot,
    autoAssigned: options.autoAssigned === true,
  };
  droneEntity.droneMining = null;
  droneEntity.droneRepair = null;
  droneEntity.targetID = toInt(targetEntity.itemID, 0);

  const distanceToTarget = getEntitySurfaceDistance(droneEntity, targetEntity);
  const ranges = resolveDroneEngagementRanges(snapshot);
  if (distanceToTarget > ranges.movementRange + 1) {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState =
      distanceToTarget > ranges.engagementRange + 1
        ? STATE_APPROACHING
        : STATE_COMBAT;
  } else if (shouldDroneOrbitTarget(targetEntity)) {
    syncDroneOrbitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState = STATE_COMBAT;
  } else {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState = STATE_COMBAT;
  }

  persistAndNotifyDroneState(droneEntity, beforeState);
  if (options.emitActivity !== false) {
    emitDroneActivityChange(droneEntity, null, null);
  }
  markSceneControlledCombatDroneIndexDirty(scene);
  return {
    success: true,
    data: {
      snapshot,
    },
  };
}

function getRepairAffinityIDs(entity = null) {
  if (!entity || typeof entity !== "object") {
    return {
      characterID: 0,
      ownerID: 0,
      corporationID: 0,
      allianceID: 0,
    };
  }
  return {
    characterID: toInt(entity.pilotCharacterID ?? entity.characterID, 0),
    ownerID: toInt(entity.ownerID, 0),
    corporationID: toInt(entity.corporationID, 0),
    allianceID: toInt(entity.allianceID, 0),
  };
}

function isFriendlyRepairTarget(controllerEntity, targetEntity) {
  const controller = getRepairAffinityIDs(controllerEntity);
  const target = getRepairAffinityIDs(targetEntity);
  if (
    controller.characterID > 0 &&
    (
      target.characterID === controller.characterID ||
      target.ownerID === controller.characterID
    )
  ) {
    return true;
  }
  if (controller.ownerID > 0 && target.ownerID === controller.ownerID) {
    return true;
  }
  if (controller.corporationID > 0 && target.corporationID === controller.corporationID) {
    return true;
  }
  return controller.allianceID > 0 && target.allianceID === controller.allianceID;
}

function assignDroneRepairTask(scene, droneEntity, controllerEntity, targetEntity, options = {}) {
  if (
    !scene ||
    !isDroneEntity(droneEntity) ||
    !controllerEntity ||
    !targetEntity ||
    targetEntity.kind !== "ship" ||
    !hasDamageableHealth(targetEntity) ||
    !isFriendlyRepairTarget(controllerEntity, targetEntity) ||
    !canPlayerCompanionActOnTarget(
      scene,
      options.session || null,
      droneEntity,
      controllerEntity,
      targetEntity,
    )
  ) {
    return {
      success: false,
      errorMsg: "DRONE_INVALID_REPAIR_ASSIGNMENT",
    };
  }

  const snapshot = resolveDroneRepairSnapshot(droneEntity, controllerEntity);
  if (!snapshot) {
    return {
      success: false,
      errorMsg: "DRONE_NO_REPAIR_PROFILE",
    };
  }

  const now = Math.max(
    0,
    toNumber(
      options.nowMs,
      scene && typeof scene.getCurrentSimTimeMs === "function"
        ? scene.getCurrentSimTimeMs()
        : Date.now(),
    ),
  );
  const beforeState = captureDroneClientState(droneEntity);
  const controllerCharacterID = resolveDroneControllerOwnerCharacterID(
    controllerEntity,
    droneEntity,
  );
  copyControllerIdentity(droneEntity, controllerEntity, controllerCharacterID);
  droneEntity.launcherID = toInt(controllerEntity.itemID, 0);
  droneEntity.controllerID = toInt(controllerEntity.itemID, 0);
  droneEntity.droneCommand = DRONE_COMMAND_ENGAGE;
  droneEntity.droneRepair = {
    targetID: toInt(targetEntity.itemID, 0),
    nextCycleAtMs: now,
    snapshot,
  };
  droneEntity.droneCombat = null;
  droneEntity.droneMining = null;
  droneEntity.droneSalvage = null;
  droneEntity.targetID = toInt(targetEntity.itemID, 0);

  const distanceToTarget = getEntitySurfaceDistance(droneEntity, targetEntity);
  const ranges = resolveDroneEngagementRanges(snapshot);
  if (distanceToTarget > ranges.movementRange + 1) {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState =
      distanceToTarget > ranges.engagementRange + 1
        ? STATE_APPROACHING
        : STATE_COMBAT;
  } else if (shouldDroneOrbitTarget(targetEntity)) {
    syncDroneOrbitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState = STATE_COMBAT;
  } else {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState = STATE_COMBAT;
  }

  persistAndNotifyDroneState(droneEntity, beforeState);
  if (options.emitActivity !== false) {
    emitDroneActivityChange(droneEntity, null, null);
  }
  markSceneControlledCombatDroneIndexDirty(scene);
  return {
    success: true,
    data: {
      snapshot,
    },
  };
}

function extractLaunchedDroneItem(moveResult, systemID) {
  const changes = moveResult && moveResult.data && Array.isArray(moveResult.data.changes)
    ? moveResult.data.changes
    : [];
  return changes
    .map((change) => change && change.item)
    .find((item) =>
      item &&
      toInt(item.locationID, 0) === toInt(systemID, 0) &&
      toInt(item.flagID, 0) === 0,
    ) || null;
}

function clearRecalledDroneEntityState(droneEntity) {
  if (!droneEntity) {
    return;
  }
  droneEntity.launcherID = null;
  droneEntity.controllerID = null;
  droneEntity.controllerOwnerID = 0;
  droneEntity.targetID = null;
  droneEntity.activityState = STATE_IDLE;
  droneEntity.droneCommand = null;
  droneEntity.droneStateVisible = false;
  droneEntity.activityID = null;
  droneEntity.activity = null;
}

function spawnTransientNpcDroneWing(
  scene,
  controllerEntity,
  targetEntity,
  entries = [],
  options = {},
) {
  if (!scene || !controllerEntity || !targetEntity) {
    return {
      success: false,
      errorMsg: "NPC_DRONE_INVALID_CONTEXT",
      droneEntityIDs: [],
    };
  }

  const authored = (Array.isArray(entries) ? entries : [])
    .flatMap((entry) =>
      Array.from(
        {
          length: Math.max(
            0,
            Math.min(5, toInt(entry && entry.quantity, 0)),
          ),
        },
        () => toInt(entry && entry.typeID, 0),
      ),
    )
    .filter((typeID) => typeID > 0)
    .slice(0, 5);
  const spawnedIDs = [];
  const errors = [];

  for (let index = 0; index < authored.length; index += 1) {
    const typeID = authored[index];
    const typeRecord = resolveItemByTypeID(typeID);
    if (
      !typeRecord ||
      toInt(typeRecord.categoryID, 0) !== DRONE_CATEGORY_ID
    ) {
      errors.push(`INVALID_DRONE_TYPE:${typeID}`);
      continue;
    }

    const spaceState = buildDroneLaunchSpaceState(controllerEntity, index);
    const spawnResult = getRuntime().spawnDynamicShip(
      scene.systemID,
      {
        itemID: 0,
        typeID,
        groupID: toInt(typeRecord.groupID, 0),
        categoryID: DRONE_CATEGORY_ID,
        itemName: String(typeRecord.name || "Escort Drone"),
        ownerID: toInt(controllerEntity.ownerID, 0),
        characterID: 0,
        pilotCharacterID: toInt(
          controllerEntity.npcPilotCharacterID ??
            controllerEntity.pilotCharacterID,
          0,
        ),
        corporationID: toInt(controllerEntity.corporationID, 0),
        allianceID: toInt(controllerEntity.allianceID, 0),
        warFactionID: toInt(controllerEntity.warFactionID, 0),
        radius: Math.max(1, toNumber(typeRecord.radius, 15)),
        spaceState,
        conditionState: {
          shieldCharge: 1,
          armorDamage: 0,
          damage: 0,
          charge: 1,
        },
        skillMap:
          controllerEntity.skillMap instanceof Map
            ? controllerEntity.skillMap
            : undefined,
      },
      {
        broadcast: false,
        persistSpaceState: false,
      },
    );
    const droneEntity =
      spawnResult && spawnResult.success && spawnResult.data
        ? spawnResult.data.entity
        : null;
    if (!droneEntity) {
      errors.push(
        (spawnResult && spawnResult.errorMsg) ||
          `DRONE_SPAWN_FAILED:${typeID}`,
      );
      continue;
    }

    droneEntity.kind = "drone";
    droneEntity.categoryID = DRONE_CATEGORY_ID;
    hydrateDroneEntityFromItem(droneEntity, {
      itemID: droneEntity.itemID,
      typeID,
      groupID: toInt(typeRecord.groupID, 0),
      categoryID: DRONE_CATEGORY_ID,
      itemName: String(typeRecord.name || "Escort Drone"),
      ownerID: toInt(controllerEntity.ownerID, 0),
      launcherID: toInt(controllerEntity.itemID, 0),
      customInfo: "transientNpcEscortDrone",
    });
    droneEntity.transientNpcDrone = true;
    droneEntity.persistSpaceState = false;
    droneEntity.launcherID = toInt(controllerEntity.itemID, 0);
    droneEntity.controllerID = toInt(controllerEntity.itemID, 0);
    copyControllerIdentity(droneEntity, controllerEntity);
    droneEntity.droneStateVisible = true;
    if (scene.droneEntityIDs instanceof Set) {
      scene.droneEntityIDs.add(droneEntity.itemID);
    }
    scene.broadcastAddBalls([droneEntity], null, {
      freshAcquire: true,
      minimumLeadFromCurrentHistory: 2,
    });

    const assignment = assignDroneCombatTask(
      scene,
      droneEntity,
      controllerEntity,
      targetEntity,
      {
        nowMs: options.nowMs,
        autoAssigned: true,
      },
    );
    if (!assignment.success) {
      errors.push(
        assignment.errorMsg || `DRONE_ASSIGNMENT_FAILED:${typeID}`,
      );
      scene.removeDynamicEntity(droneEntity.itemID, {
        broadcast: true,
        persistSpaceState: false,
      });
      continue;
    }
    spawnedIDs.push(droneEntity.itemID);
  }

  return {
    success: spawnedIDs.length > 0 || authored.length === 0,
    droneEntityIDs: spawnedIDs,
    ...(errors.length > 0
      ? {
          errorMsg: errors.join(","),
          errors,
        }
      : {}),
  };
}

function recallDronesToBay(scene, shipRecord, droneEntities) {
  const shipID = toInt(shipRecord && shipRecord.itemID, 0);
  const shipOwnerID = toInt(shipRecord && shipRecord.ownerID, 0);
  const ownerSession = findSessionByCharacterID(toInt(shipRecord && shipRecord.ownerID, 0));
  const candidates = (Array.isArray(droneEntities) ? droneEntities : [droneEntities])
    .filter((droneEntity) =>
      isDroneEntity(droneEntity) &&
      scene.getEntityByID(toInt(droneEntity && droneEntity.itemID, 0)),
    );
  if (candidates.length <= 0) {
    return {
      success: false,
      errorMsg: "DRONE_REMOVE_FAILED",
    };
  }

  const recalled = [];
  for (const droneEntity of candidates) {
    const bayUpdateResult = updateInventoryItem(droneEntity.itemID, (currentItem) => ({
      ...currentItem,
      ownerID: shipOwnerID || toInt(currentItem && currentItem.ownerID, 0),
      locationID: shipID,
      flagID: ITEM_FLAGS.DRONE_BAY,
      customInfo: currentItem && currentItem.customInfo ? currentItem.customInfo : "",
      singleton: 1,
      quantity: 1,
      stacksize: 1,
      launcherID: null,
      spaceState: null,
    }));
    if (!bayUpdateResult.success) {
      return bayUpdateResult;
    }

    const changes = [{
      item: bayUpdateResult.data,
      previousData: bayUpdateResult.previousData || {},
    }];
    emitRelevantInventoryChanges(ownerSession, shipID, changes);
    recalled.push({
      droneEntity,
      interestedSessions: getInterestedDroneSessions(droneEntity),
      changes,
    });
  }

  for (const entry of recalled) {
    emitDroneStateChange(entry.droneEntity, {
      ownerID: null,
      controllerID: null,
      activityState: null,
      typeID: null,
      controllerOwnerID: null,
      targetID: null,
    }, entry.interestedSessions);
  }

  for (const entry of recalled) {
    const removeResult = scene.removeDynamicEntity(entry.droneEntity.itemID, {
      broadcast: true,
      persistSpaceState: false,
    });
    if (!removeResult || removeResult.success !== true) {
      return removeResult || {
        success: false,
        errorMsg: "DRONE_REMOVE_FAILED",
      };
    }
    clearRecalledDroneEntityState(entry.droneEntity);
  }

  markSceneControlledCombatDroneIndexDirty(scene);
  return {
    success: true,
    data: {
      droneID: toInt(recalled[0] && recalled[0].droneEntity && recalled[0].droneEntity.itemID, 0),
      droneIDs: recalled.map((entry) => toInt(entry && entry.droneEntity && entry.droneEntity.itemID, 0)),
      shipID,
      changes: recalled.flatMap((entry) => entry.changes),
    },
  };
}

function recallDroneToBay(scene, shipRecord, droneEntity) {
  return recallDronesToBay(scene, shipRecord, [droneEntity]);
}

function launchDronesForSession(session, rawLaunchRequests) {
  const shipState = getShipStateForSession(session);
  const requests = normalizeLaunchRequests(rawLaunchRequests);
  const response = buildMarshalDict();
  if (!shipState) {
    return {
      success: false,
      errorMsg: "Unable to launch drones without an active in-space ship.",
      response,
    };
  }

  const { characterID, shipRecord, shipEntity, scene } = shipState;
  if (
    getPlayerCompanionSecurityScope(shipEntity, {
      controller: true,
    }).invalid === true
  ) {
    for (const request of requests) {
      ensureLaunchResponseEntry(response, request.itemID);
      appendLaunchError(
        response,
        request.itemID,
        "Unable to launch a drone while the ship's private-site scope is invalid.",
      );
    }
    return {
      success: true,
      response,
    };
  }
  const ownerSession = findSessionByCharacterID(toInt(shipRecord && shipRecord.ownerID, 0));
  const launchIdentitySessions = normalizeDroneSessions([session, ownerSession]);
  const fittingSnapshot = getShipFittingSnapshot(characterID, shipRecord.itemID, {
    shipItem: shipRecord,
    reason: "drone.launch",
  });
  const shipAttributes = fittingSnapshot && fittingSnapshot.shipAttributes
    ? fittingSnapshot.shipAttributes
    : {};
  const maxActiveDrones = Math.max(
    0,
    toInt(shipAttributes[ATTRIBUTE_MAX_ACTIVE_DRONES], 5),
  );
  const droneBandwidth = Math.max(
    0,
    toNumber(shipAttributes[ATTRIBUTE_DRONE_BANDWIDTH], 0),
  );
  let activeDroneEntities = listControlledDroneEntities(scene, shipRecord.itemID);
  let activeDroneCount = activeDroneEntities.length;
  const launchedDroneEntities = [];
  let usedBandwidth = activeDroneEntities.reduce(
    (sum, entity) => sum + getDroneBandwidthLoad(entity),
    0,
  );
  let launchIndex = 0;

  for (const request of requests) {
    ensureLaunchResponseEntry(response, request.itemID);
    const sourceItem = findItemById(request.itemID);
    if (
      !sourceItem ||
      !isDroneItemRecord(sourceItem) ||
      toInt(sourceItem.locationID, 0) !== toInt(shipRecord.itemID, 0) ||
      toInt(sourceItem.flagID, 0) !== ITEM_FLAGS.DRONE_BAY
    ) {
      appendLaunchError(response, request.itemID, "That drone is not available in the active ship drone bay.");
      continue;
    }

    for (let count = 0; count < request.quantity; count += 1) {
      const refreshedSource = findItemById(request.itemID);
      if (!refreshedSource || !isDroneItemRecord(refreshedSource)) {
        appendLaunchError(response, request.itemID, "The requested drone stack is no longer available.");
        break;
      }
      if (maxActiveDrones <= 0 || activeDroneCount >= maxActiveDrones) {
        appendLaunchError(response, request.itemID, "Maximum active drones already in space.");
        break;
      }

      const launchBandwidth = getDroneBandwidthLoad(refreshedSource);
      if ((launchBandwidth > 0 && droneBandwidth <= 0) || usedBandwidth + launchBandwidth > droneBandwidth) {
        appendLaunchError(response, request.itemID, "Not enough drone bandwidth to launch that drone.");
        break;
      }

      const moveResult = moveItemToLocation(
        refreshedSource.itemID,
        scene.systemID,
        0,
        1,
      );
      if (!moveResult.success) {
        appendLaunchError(response, request.itemID, "Unable to launch that drone.");
        break;
      }

      const launchedItem = extractLaunchedDroneItem(moveResult, scene.systemID);
      if (!launchedItem) {
        appendLaunchError(response, request.itemID, "Drone launch created no in-space item.");
        break;
      }

      const inventoryChanges = Array.isArray(moveResult.data && moveResult.data.changes)
        ? moveResult.data.changes.filter(
            (change) =>
              toInt(change && change.item && change.item.itemID, 0) !==
              toInt(launchedItem.itemID, 0),
          )
        : [];
      emitRelevantInventoryChanges(
        session,
        shipRecord.itemID,
        inventoryChanges,
      );

      const spaceState = buildDroneLaunchSpaceState(shipEntity, launchIndex);
      const updateResult = updateInventoryItem(launchedItem.itemID, (currentItem) => ({
        ...currentItem,
        singleton: 1,
        quantity: null,
        stacksize: 1,
        launcherID: shipRecord.itemID,
        spaceState,
      }));
      if (!updateResult.success) {
        appendLaunchError(response, request.itemID, "Unable to finalize drone launch.");
        break;
      }

      primeDroneBayDogmaForLaunch(
        updateResult.data,
        shipRecord,
        launchIdentitySessions,
      );

      const spawnResult = getRuntime().spawnDynamicInventoryEntity(scene.systemID, launchedItem.itemID, {
        broadcast: true,
        excludedSession: null,
      });
      if (!spawnResult.success || !spawnResult.data || !spawnResult.data.entity) {
        appendLaunchError(response, request.itemID, "Unable to materialize drone in space.");
        break;
      }

      const droneEntity = hydrateDroneEntityFromItem(spawnResult.data.entity, updateResult.data);
      droneEntity.launcherID = shipRecord.itemID;
      droneEntity.controllerID = shipRecord.itemID;
      copyControllerIdentity(droneEntity, shipEntity, characterID);
      droneEntity.activityState = STATE_IDLE;
      droneEntity.targetID = null;
      clearDroneTaskState(droneEntity);
      droneEntity.droneHomeOrbitDistance = resolveDroneOrbitDistance(droneEntity);
      syncDroneOrbitBehavior(
        scene,
        droneEntity,
        shipEntity,
        droneEntity.droneHomeOrbitDistance,
      );
      droneEntity.droneStateVisible = true;
      persistDroneEntityState(droneEntity);
      const splitCreatedLaunch =
        toInt(droneEntity.itemID, 0) !== toInt(refreshedSource.itemID, 0);
      // Keep the first launch-side identity row on the finalized singleton
      // drone state instead of the transient split-stack row. That gives the
      // client a real inv/dogma item before OnDroneStateChange2 runs.
      ensureDroneClientIdentityState(
        droneEntity,
        shipRecord,
        launchIdentitySessions,
        {
          forceInsert: splitCreatedLaunch,
          skipDogmaPrime: true,
        },
      );
      emitDroneStateChange(droneEntity);
      markSceneControlledCombatDroneIndexDirty(scene);
      appendLaunchEntry(response, request.itemID, toInt(droneEntity.itemID, 0));
      activeDroneEntities.push(droneEntity);
      launchedDroneEntities.push(droneEntity);
      activeDroneCount += 1;
      usedBandwidth += launchBandwidth;
      launchIndex += 1;
    }
  }

  // The drone window reloads from both invCache and Michelle when it receives
  // OnItemChange. Reassert every launched row only after Michelle has all of
  // the matching OnDroneStateChange entries for this launch transaction.
  for (const droneEntity of launchedDroneEntities) {
    ensureDroneClientIdentityState(
      droneEntity,
      shipRecord,
      launchIdentitySessions,
      {
        forceRefresh: true,
        skipDogmaPrime: true,
      },
    );
  }

  return {
    success: true,
    response,
  };
}

function commandReturnDrones(session, rawDroneIDs, commandName) {
  const shipState = getShipStateForSession(session);
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const response = buildMultiDroneResult(droneIDs);
  if (!shipState) {
    return response;
  }

  const { shipRecord, scene } = shipState;
  const ownerSession = findSessionByCharacterID(toInt(shipRecord && shipRecord.ownerID, 0));
  const interestedSessions = normalizeDroneSessions([session, ownerSession]);
  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity) || toInt(droneEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      appendDroneError(response, droneID, "That drone is not currently under this ship's control.");
      continue;
    }

    const followDistance =
      commandName === DRONE_COMMAND_RETURN_BAY
        ? DRONE_BAY_RETURN_APPROACH_DISTANCE_METERS
        : resolveDroneOrbitDistance(droneEntity);
    scene.followShipEntity(droneEntity, shipRecord.itemID, followDistance, {
      broadcast: commandName !== DRONE_COMMAND_RETURN_BAY,
    });
    droneEntity.launcherID = shipRecord.itemID;
    droneEntity.controllerID = shipRecord.itemID;
    droneEntity.controllerOwnerID = toInt(shipRecord.ownerID, 0);
    droneEntity.targetID = shipRecord.itemID;
    droneEntity.activityState = STATE_DEPARTING;
    droneEntity.droneCommand = commandName;
    droneEntity.droneHomeOrbitDistance = resolveDroneOrbitDistance(droneEntity);
    droneEntity.droneCombat = null;
    droneEntity.droneRepair = null;
    stopDroneMiningCycleFx(scene, droneEntity);
    droneEntity.droneMining = null;
    droneEntity.droneSalvage = null;
    droneEntity.activityID = null;
    droneEntity.activity = null;
    persistDroneEntityState(droneEntity);
    // CCP client parity: returning drones must already have a dogma item by
    // the time OnDroneStateChange2 hits the RETURNING state. The client checks
    // both invCache and dogma first; if either side is missing it falls back
    // to a short synthesized DBRow and logs "sequence is too short".
    ensureDroneClientIdentityState(
      droneEntity,
      shipRecord,
      interestedSessions,
      {
        forceRefresh: true,
        skipInventorySync: true,
      },
    );
    emitDroneStateChange(droneEntity, {}, interestedSessions);
    if (commandName !== DRONE_COMMAND_RETURN_BAY) {
      emitDroneActivityChange(droneEntity, null, null, interestedSessions);
    }
    markSceneControlledCombatDroneIndexDirty(scene);
  }

  return response;
}

function commandReturnHome(session, rawDroneIDs) {
  return commandReturnDrones(session, rawDroneIDs, DRONE_COMMAND_RETURN_HOME);
}

function commandReturnBay(session, rawDroneIDs) {
  return commandReturnDrones(session, rawDroneIDs, DRONE_COMMAND_RETURN_BAY);
}

function commandEngage(session, rawDroneIDs, rawTargetID) {
  const shipState = getShipStateForSession(session);
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const response = buildMultiDroneResult(droneIDs);
  if (!shipState) {
    return response;
  }

  const targetID = toInt(rawTargetID, 0);
  const { shipRecord, shipEntity, scene } = shipState;
  const targetEntity = scene.getEntityByID(targetID);
  if (!targetEntity || !hasDamageableHealth(targetEntity)) {
    for (const droneID of droneIDs) {
      appendDroneError(response, droneID, "That target cannot be engaged by drones.");
    }
    return response;
  }

  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity) || toInt(droneEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      appendDroneError(response, droneID, "That drone is not currently under this ship's control.");
      continue;
    }
    if (
      !canPlayerCompanionActOnTarget(
        scene,
        session,
        droneEntity,
        shipEntity,
        targetEntity,
      )
    ) {
      appendDroneError(response, droneID, "That target is not visible to this drone.");
      continue;
    }

    stopDroneMiningCycleFx(scene, droneEntity);
    const assignOptions = {
      session,
      nowMs: scene.getCurrentSimTimeMs && scene.getCurrentSimTimeMs(),
      emitActivity: true,
    };
    const repairResult = assignDroneRepairTask(
      scene,
      droneEntity,
      shipEntity,
      targetEntity,
      assignOptions,
    );
    const assignResult = repairResult && repairResult.success === true
      ? repairResult
      : assignDroneCombatTask(
          scene,
          droneEntity,
          shipEntity,
          targetEntity,
          assignOptions,
        );
    if (!assignResult || assignResult.success !== true) {
      appendDroneError(response, droneID, "That drone has no supported engage profile.");
      continue;
    }
  }

  return response;
}

function assignDroneSalvageTask({
  scene,
  session,
  droneEntity,
  shipEntity,
  shipRecord,
  characterID,
  targetEntity,
} = {}) {
  if (!scene || !isDroneEntity(droneEntity) || !shipEntity || !targetEntity) {
    return {
      success: false,
      errorMsg: "That drone cannot salvage the selected target.",
    };
  }
  if (!salvagerRuntime.isSalvageableTarget(targetEntity)) {
    return {
      success: false,
      errorMsg: "That target cannot be salvaged by drones.",
    };
  }
  if (
    !canPlayerCompanionActOnTarget(
      scene,
      session || null,
      droneEntity,
      shipEntity,
      targetEntity,
    )
  ) {
    return {
      success: false,
      errorMsg: "That target is not visible to this drone.",
    };
  }

  const snapshot = resolveDroneSalvageSnapshot(droneEntity, shipEntity);
  if (!snapshot) {
    return {
      success: false,
      errorMsg: "That drone has no supported salvaging profile.",
    };
  }

  const targetID = toInt(targetEntity.itemID, 0);
  const chanceSnapshot = salvagerRuntime.buildSalvageChanceSnapshot(
    targetEntity,
    snapshot.accessBonusPercent,
  );
  const beforeState = captureDroneClientState(droneEntity);
  stopDroneMiningCycleFx(scene, droneEntity);
  copyControllerIdentity(droneEntity, shipEntity, characterID);
  droneEntity.launcherID = toInt(shipRecord && shipRecord.itemID, toInt(shipEntity.itemID, 0));
  droneEntity.controllerID = toInt(shipRecord && shipRecord.itemID, toInt(shipEntity.itemID, 0));
  droneEntity.targetID = targetID;
  droneEntity.droneCommand = DRONE_COMMAND_SALVAGE;
  droneEntity.droneSalvage = {
    targetID,
    nextCycleAtMs:
      Math.max(
        toNumber(scene.getCurrentSimTimeMs && scene.getCurrentSimTimeMs(), Date.now()),
        Date.now(),
      ) + Math.max(1, toNumber(snapshot.durationMs, 1000)),
    snapshot,
    chanceSnapshot,
  };
  droneEntity.droneMining = null;
  droneEntity.droneCombat = null;
  droneEntity.droneRepair = null;

  const distanceToTarget = getEntitySurfaceDistance(droneEntity, targetEntity);
  const orbitDistance = Math.max(
    MIN_ORBIT_DISTANCE_METERS,
    toNumber(snapshot.orbitDistanceMeters, MIN_ORBIT_DISTANCE_METERS),
  );
  const maxRange = Math.max(
    orbitDistance,
    toNumber(snapshot.maxRangeMeters, orbitDistance),
  );
  if (distanceToTarget > maxRange + 1) {
    syncDronePursuitBehavior(scene, droneEntity, targetEntity, orbitDistance);
    droneEntity.activityState = STATE_APPROACHING;
  } else {
    syncDroneOrbitBehavior(scene, droneEntity, targetEntity, orbitDistance);
    droneEntity.activityState = STATE_SALVAGING;
  }

  persistAndNotifyDroneState(droneEntity, beforeState);
  return { success: true };
}

function isOwnedSalvageCandidate(targetEntity, characterID) {
  return Boolean(
    targetEntity &&
      salvagerRuntime.isSalvageableTarget(targetEntity) &&
      toInt(targetEntity.ownerID, 0) === toInt(characterID, 0)
  );
}

function resolveAutomaticSalvageTarget(
  scene,
  droneEntity,
  shipEntity,
  characterID,
  assignedTargetIDs = null,
  session = null,
) {
  const entities =
    scene && typeof scene.getAllVisibleEntities === "function"
      ? scene.getAllVisibleEntities()
      : [
          ...(Array.isArray(scene && scene.staticEntities) ? scene.staticEntities : []),
          ...(scene && scene.dynamicEntities instanceof Map
            ? [...scene.dynamicEntities.values()]
            : []),
        ];
  let bestTarget = null;
  let bestDistance = Infinity;
  for (const targetEntity of entities) {
    const targetID = toInt(targetEntity && targetEntity.itemID, 0);
    if (
      targetID <= 0 ||
      (assignedTargetIDs instanceof Set && assignedTargetIDs.has(targetID)) ||
      !isOwnedSalvageCandidate(targetEntity, characterID) ||
      !canPlayerCompanionActOnTarget(
        scene,
        session,
        droneEntity,
        shipEntity,
        targetEntity,
      )
    ) {
      continue;
    }

    const distanceToShip = getEntitySurfaceDistance(shipEntity, targetEntity);
    const distanceToDrone = getEntitySurfaceDistance(droneEntity, targetEntity);
    const candidateDistance = Math.min(distanceToShip, distanceToDrone);
    if (candidateDistance < bestDistance) {
      bestDistance = candidateDistance;
      bestTarget = targetEntity;
    }
  }
  return bestTarget;
}

function commandMineRepeatedly(session, rawDroneIDs, rawTargetID) {
  const shipState = getShipStateForSession(session);
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const response = buildMultiDroneResult(droneIDs);
  if (!shipState) {
    return response;
  }

  const targetID = toInt(rawTargetID, 0);
  const { characterID, shipRecord, shipEntity, scene } = shipState;
  ensureSceneMiningState(scene);
  const targetEntity = scene.getEntityByID(targetID);
  const mineableState = getMineableState(scene, targetID);
  const targetIsMineable = Boolean(
    targetEntity &&
      mineableState &&
      toInt(mineableState.remainingQuantity, 0) > 0,
  );
  const targetIsSalvageable = Boolean(
    targetEntity &&
      salvagerRuntime.isSalvageableTarget(targetEntity),
  );
  if (
    !targetIsMineable &&
    !targetIsSalvageable
  ) {
    for (const droneID of droneIDs) {
      appendDroneError(response, droneID, "That target cannot be mined or salvaged by drones.");
    }
    return response;
  }

  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity) || toInt(droneEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      appendDroneError(response, droneID, "That drone is not currently under this ship's control.");
      continue;
    }
    if (
      !canPlayerCompanionActOnTarget(
        scene,
        session,
        droneEntity,
        shipEntity,
        targetEntity,
      )
    ) {
      appendDroneError(response, droneID, "That target is not visible to this drone.");
      continue;
    }

    if (targetIsMineable) {
      const snapshot = resolveDroneMiningSnapshot(droneEntity, shipEntity);
      if (!snapshot) {
        appendDroneError(response, droneID, "That drone has no supported mining profile.");
        continue;
      }
      if (!isDroneMiningCompatibleWithTarget(droneEntity, mineableState)) {
        appendDroneError(response, droneID, "That drone cannot mine the selected resource.");
        continue;
      }

      const beforeState = captureDroneClientState(droneEntity);
      const nowMs = Math.max(
        toNumber(scene.getCurrentSimTimeMs && scene.getCurrentSimTimeMs(), Date.now()),
        Date.now(),
      );
      stopDroneMiningCycleFx(scene, droneEntity);
      copyControllerIdentity(droneEntity, shipEntity, characterID);
      droneEntity.launcherID = shipRecord.itemID;
      droneEntity.controllerID = shipRecord.itemID;
      droneEntity.targetID = targetID;
      droneEntity.droneCommand = DRONE_COMMAND_MINE;
      droneEntity.droneMining = {
        targetID,
        cycleStartedAtMs: null,
        nextCycleAtMs: null,
        fxCycleKey: null,
        snapshot,
      };
      droneEntity.droneSalvage = null;
      droneEntity.droneCombat = null;
      droneEntity.droneRepair = null;

      const distanceToTarget = getEntitySurfaceDistance(droneEntity, targetEntity);
      const orbitDistance = Math.max(
        MIN_ORBIT_DISTANCE_METERS,
        toNumber(snapshot.orbitDistanceMeters, MIN_ORBIT_DISTANCE_METERS),
      );
      const maxRange = Math.max(
        orbitDistance,
        toNumber(snapshot.maxRangeMeters, orbitDistance),
      );
      if (distanceToTarget > maxRange + 1) {
        syncDronePursuitBehavior(scene, droneEntity, targetEntity, orbitDistance);
        droneEntity.activityState = STATE_APPROACHING;
      } else {
        syncDroneOrbitBehavior(scene, droneEntity, targetEntity, orbitDistance);
        droneEntity.activityState = STATE_MINING;
        beginDroneMiningCycle(droneEntity.droneMining, snapshot, nowMs);
      }

      persistAndNotifyDroneState(droneEntity, beforeState);
      if (droneEntity.activityState === STATE_MINING) {
        emitDroneMiningCycleFx(
          scene,
          droneEntity,
          targetEntity,
          snapshot,
          droneEntity.droneMining,
          nowMs,
        );
      }
    } else {
      const assignResult = assignDroneSalvageTask({
        scene,
        session,
        droneEntity,
        shipEntity,
        shipRecord,
        characterID,
        targetEntity,
      });
      if (!assignResult || assignResult.success !== true) {
        appendDroneError(
          response,
          droneID,
          assignResult && assignResult.errorMsg
            ? assignResult.errorMsg
            : "That drone has no supported salvaging profile.",
        );
        continue;
      }
    }

    emitDroneActivityChange(droneEntity, null, null);
    markSceneControlledCombatDroneIndexDirty(scene);
  }

  return response;
}

function commandSalvage(session, rawDroneIDs, rawTargetID) {
  const shipState = getShipStateForSession(session);
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const response = buildMultiDroneResult(droneIDs);
  if (!shipState) {
    return response;
  }

  const targetID = toInt(rawTargetID, 0);
  const { characterID, shipRecord, shipEntity, scene } = shipState;
  const explicitTargetEntity = targetID > 0 ? scene.getEntityByID(targetID) : null;
  if (targetID > 0 && !salvagerRuntime.isSalvageableTarget(explicitTargetEntity)) {
    for (const droneID of droneIDs) {
      appendDroneError(response, droneID, "That target cannot be salvaged by drones.");
    }
    return response;
  }

  const assignedTargetIDs = new Set();
  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity) || toInt(droneEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      appendDroneError(response, droneID, "That drone is not currently under this ship's control.");
      continue;
    }

    const targetEntity =
      explicitTargetEntity ||
      resolveAutomaticSalvageTarget(
        scene,
        droneEntity,
        shipEntity,
        characterID,
        assignedTargetIDs,
        session,
      );
    if (!targetEntity) {
      appendDroneError(response, droneID, "No owned salvageable wreck is available.");
      continue;
    }

    const assignResult = assignDroneSalvageTask({
      scene,
      session,
      droneEntity,
      shipEntity,
      shipRecord,
      characterID,
      targetEntity,
    });
    if (!assignResult || assignResult.success !== true) {
      appendDroneError(
        response,
        droneID,
        assignResult && assignResult.errorMsg
          ? assignResult.errorMsg
          : "That drone has no supported salvaging profile.",
      );
      continue;
    }

    assignedTargetIDs.add(toInt(targetEntity.itemID, 0));
    emitDroneActivityChange(droneEntity, null, null);
    markSceneControlledCombatDroneIndexDirty(scene);
  }

  return response;
}

function commandAbandonDrone(session, rawDroneIDs) {
  const shipState = getShipStateForSession(session);
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const response = buildMultiDroneResult(droneIDs);
  if (!shipState) {
    return response;
  }

  const { scene, shipRecord } = shipState;
  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity) || toInt(droneEntity.controllerID, 0) !== toInt(shipRecord.itemID, 0)) {
      appendDroneError(response, droneID, "That drone is not currently under this ship's control.");
      continue;
    }
    abandonDroneInSpace(scene, droneEntity, {
      stopMovement: true,
    });
  }

  return response;
}

function abandonDroneInSpace(scene, droneEntity, options = {}) {
  if (!scene || !isDroneEntity(droneEntity)) {
    return false;
  }

  if (options.stopMovement !== false && typeof scene.stopShipEntity === "function") {
    scene.stopShipEntity(droneEntity, {
      allowSessionOwned: true,
      broadcast: options.broadcastMovement !== false,
    });
  }

  droneEntity.launcherID = null;
  droneEntity.controllerID = null;
  droneEntity.controllerOwnerID = 0;
  droneEntity.targetID = null;
  droneEntity.activityState = STATE_IDLE;
  stopDroneMiningCycleFx(scene, droneEntity);
  clearDroneTaskState(droneEntity);
  droneEntity.droneStateVisible = false;
  droneEntity.activityID = null;
  droneEntity.activity = null;
  updateInventoryItem(droneEntity.itemID, (currentItem) => ({
    ...currentItem,
    launcherID: null,
    spaceState: serializeDroneSpaceState(droneEntity),
  }));
  emitDroneStateChange(droneEntity, {
    ownerID: 0,
    controllerID: 0,
    activityState: STATE_IDLE,
    controllerOwnerID: 0,
    targetID: 0,
  });
  emitDroneActivityChange(droneEntity, null, null);
  markSceneControlledCombatDroneIndexDirty(scene);
  return true;
}

function handleControllerLost(scene, controllerEntity, options = {}) {
  if (!scene || !controllerEntity) {
    return {
      success: false,
      releasedCount: 0,
      recoveredCount: 0,
    };
  }

  const controllerID = toInt(controllerEntity.itemID, 0);
  if (controllerID <= 0) {
    return {
      success: false,
      releasedCount: 0,
      recoveredCount: 0,
    };
  }

  const shipRecord =
    options.shipRecord ||
    findItemById(controllerID) ||
    null;
  const shouldAttemptBayRecovery =
    options.attemptBayRecovery === true ||
    ["disconnect", "logoff"].includes(String(options.lifecycleReason || "").trim().toLowerCase());
  let releasedCount = 0;
  let recoveredCount = 0;

  for (const droneEntity of listControlledDroneEntities(scene, controllerID)) {
    if (
      shouldAttemptBayRecovery &&
      shipRecord &&
      getEntitySurfaceDistance(droneEntity, controllerEntity) <= DRONE_BAY_SCOOP_DISTANCE_METERS
    ) {
      const recallResult = recallDroneToBay(scene, shipRecord, droneEntity);
      if (recallResult && recallResult.success === true) {
        releasedCount += 1;
        recoveredCount += 1;
        continue;
      }
    }

    if (abandonDroneInSpace(scene, droneEntity, options)) {
      releasedCount += 1;
    }
  }

  return {
    success: true,
    releasedCount,
    recoveredCount,
  };
}

function commandReconnectToDrones(session, rawDroneIDs) {
  const shipState = getShipStateForSession(session);
  if (!shipState) {
    return buildMarshalDict();
  }

  const { characterID, shipRecord, scene } = shipState;
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const fittingSnapshot = getShipFittingSnapshot(characterID, shipRecord.itemID, {
    shipItem: shipRecord,
    reason: "drone.reconnect",
  });
  const shipAttributes = fittingSnapshot && fittingSnapshot.shipAttributes
    ? fittingSnapshot.shipAttributes
    : {};
  const maxActiveDrones = Math.max(
    0,
    toInt(shipAttributes[ATTRIBUTE_MAX_ACTIVE_DRONES], 5),
  );
  const droneBandwidth = Math.max(
    0,
    toNumber(shipAttributes[ATTRIBUTE_DRONE_BANDWIDTH], 0),
  );
  const controlledDroneEntities = listControlledDroneEntities(scene, shipRecord.itemID);
  let activeDroneCount = controlledDroneEntities.length;
  let usedBandwidth = controlledDroneEntities.reduce(
    (sum, entity) => sum + getDroneBandwidthLoad(entity),
    0,
  );

  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity)) {
      continue;
    }
    if (toInt(droneEntity.ownerID, 0) !== characterID || toInt(droneEntity.controllerID, 0) > 0) {
      continue;
    }
    if (maxActiveDrones <= 0 || activeDroneCount >= maxActiveDrones) {
      return buildNotifyErrorResult("Maximum active drones already in space.");
    }
    const droneBandwidthLoad = getDroneBandwidthLoad(droneEntity);
    if (
      (droneBandwidthLoad > 0 && droneBandwidth <= 0) ||
      usedBandwidth + droneBandwidthLoad > droneBandwidth
    ) {
      return buildNotifyErrorResult(
        "Not enough drone bandwidth to reconnect to those drones.",
      );
    }

    droneEntity.controllerID = shipRecord.itemID;
    copyControllerIdentity(droneEntity, scene.getEntityByID(shipRecord.itemID), characterID);
    droneEntity.activityState = STATE_IDLE;
    droneEntity.targetID = null;
    clearDroneTaskState(droneEntity);
    droneEntity.droneStateVisible = true;
    droneEntity.launcherID = shipRecord.itemID;
    persistDroneEntityState(droneEntity);
    emitDroneStateChange(droneEntity);
    emitDroneActivityChange(droneEntity, null, null);
    markSceneControlledCombatDroneIndexDirty(scene);
    activeDroneCount += 1;
    usedBandwidth += droneBandwidthLoad;
  }

  return buildMarshalDict();
}

function scoopDrone(session, rawDroneIDs) {
  const shipState = getShipStateForSession(session);
  const droneIDs = normalizeDroneIDList(rawDroneIDs);
  const response = buildMultiDroneResult(droneIDs);
  if (!shipState) {
    return response;
  }

  const { characterID, shipRecord, shipEntity, scene } = shipState;
  for (const droneID of droneIDs) {
    const droneEntity = scene.getEntityByID(droneID);
    if (!isDroneEntity(droneEntity)) {
      appendDroneError(response, droneID, "That drone is not in local space.");
      continue;
    }
    if (toInt(droneEntity.controllerID, 0) > 0) {
      appendDroneError(response, droneID, "That drone cannot currently be scooped into the drone bay.");
      continue;
    }
    if (getEntitySurfaceDistance(droneEntity, shipEntity) > DRONE_BAY_SCOOP_DISTANCE_METERS) {
      appendDroneError(response, droneID, "Drone is too far away to scoop into the bay.");
      continue;
    }

    const recallResult = recallDroneToBay(scene, shipRecord, droneEntity);
    if (!recallResult || recallResult.success !== true) {
      appendDroneError(response, droneID, "Unable to scoop that drone.");
    }
  }

  return response;
}

function resetDroneToIdle(droneEntity, controllerEntity = null, options = {}) {
  if (!droneEntity) {
    return false;
  }

  const beforeState = captureDroneClientState(droneEntity);
  const keepController = options.keepController !== false;
  if (!keepController) {
    droneEntity.controllerID = null;
    droneEntity.controllerOwnerID = 0;
  } else if (controllerEntity) {
    droneEntity.controllerID = toInt(controllerEntity.itemID, 0) || droneEntity.controllerID;
    copyControllerIdentity(
      droneEntity,
      controllerEntity,
      toInt(
        controllerEntity &&
          (
            controllerEntity.session && controllerEntity.session.characterID
          ) ||
          controllerEntity &&
          (
            controllerEntity.pilotCharacterID ??
            controllerEntity.characterID ??
            droneEntity.controllerOwnerID
          ),
        0,
      ),
    );
  }
  stopDroneMiningCycleFx(options.scene || null, droneEntity);
  clearDroneTaskState(droneEntity);
  droneEntity.activityState = STATE_IDLE;
  droneEntity.targetID = null;
  if (options.stopMovement === true && controllerEntity) {
    const orbitDistance = Math.max(
      MIN_ORBIT_DISTANCE_METERS,
      resolveDroneOrbitDistance(droneEntity),
    );
    syncDroneOrbitBehavior(
      options.scene,
      droneEntity,
      controllerEntity,
      orbitDistance,
    );
  }
  persistAndNotifyDroneState(droneEntity, beforeState, options.sessions || null);
  emitDroneActivityChange(droneEntity, null, null, options.sessions || null);
  markSceneControlledCombatDroneIndexDirty(options.scene || null);
  return true;
}

function idleMiningDronesTargeting(scene, rawTargetID, options = {}) {
  if (!scene) {
    return 0;
  }

  const targetID = toInt(rawTargetID, 0);
  const excludeDroneID = toInt(options.excludeDroneID, 0);
  if (targetID <= 0) {
    return 0;
  }

  let idledCount = 0;
  for (const droneEntity of getSceneDroneEntities(scene)) {
    const droneID = toInt(droneEntity && droneEntity.itemID, 0);
    if (droneID <= 0 || droneID === excludeDroneID) {
      continue;
    }

    const miningState =
      droneEntity &&
      droneEntity.droneMining &&
      typeof droneEntity.droneMining === "object"
        ? droneEntity.droneMining
        : null;
    const miningTargetID = toInt(
      miningState && miningState.targetID,
      toInt(droneEntity && droneEntity.targetID, 0),
    );
    if (miningTargetID !== targetID) {
      continue;
    }
    if (droneEntity.droneCommand !== DRONE_COMMAND_MINE && !miningState) {
      continue;
    }

    const controllerID = toInt(droneEntity.controllerID, 0);
    const controllerEntity = controllerID > 0 ? scene.getEntityByID(controllerID) : null;
    if (resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
      sessions: options.sessions || null,
    })) {
      idledCount += 1;
    }
  }

  return idledCount;
}

function noteIncomingAggression(attackerEntity, targetEntity, whenMs = Date.now()) {
  const targetSystemID = toInt(targetEntity && targetEntity.systemID, 0);
  if (
    !attackerEntity ||
    !targetEntity ||
    targetSystemID <= 0 ||
    toInt(attackerEntity.itemID, 0) <= 0 ||
    toInt(targetEntity.itemID, 0) <= 0 ||
    toInt(attackerEntity.itemID, 0) === toInt(targetEntity.itemID, 0) ||
    String(targetEntity.kind || "") !== "ship" ||
    !hasDamageableHealth(attackerEntity)
  ) {
    return 0;
  }

  const runtime = getRuntime();
  const scene =
    runtime && typeof runtime.ensureScene === "function"
      ? runtime.ensureScene(targetSystemID)
      : null;
  if (!scene) {
    return 0;
  }

  const controllerEntity = scene.getEntityByID(toInt(targetEntity.itemID, 0)) || null;
  const hostileEntity = scene.getEntityByID(toInt(attackerEntity.itemID, 0)) || null;
  if (!controllerEntity || !hostileEntity) {
    return 0;
  }

  const behaviorSettings = getControllerDroneBehaviorSettings(controllerEntity);
  if (behaviorSettings.aggressive !== true) {
    return 0;
  }

  const controlledCombatIndex = getSceneControlledCombatDroneIndex(scene);
  const controllerEntry =
    controlledCombatIndex.get(toInt(controllerEntity.itemID, 0)) || null;
  const idleCombatDroneIDs =
    controllerEntry && Array.isArray(controllerEntry.idleCombatDroneIDs)
      ? controllerEntry.idleCombatDroneIDs
      : [];
  if (idleCombatDroneIDs.length <= 0) {
    return 0;
  }

  const targetIDs = selectAggressiveTargetIDs(
    scene,
    controllerEntity,
    hostileEntity.itemID,
    {
      focusFire: behaviorSettings.focusFire,
      desiredCount: idleCombatDroneIDs.length,
      nowMs: whenMs,
    },
  );
  if (targetIDs.length <= 0) {
    return 0;
  }

  let engagedCount = 0;
  const assignmentCount =
    behaviorSettings.focusFire === true
      ? idleCombatDroneIDs.length
      : Math.min(idleCombatDroneIDs.length, targetIDs.length);
  for (let index = 0; index < assignmentCount; index += 1) {
    const droneEntity = scene.getEntityByID(toInt(idleCombatDroneIDs[index], 0));
    const targetID = toInt(targetIDs[Math.min(index, targetIDs.length - 1)], 0);
    const assignedTarget = targetID > 0 ? scene.getEntityByID(targetID) : null;
    if (!droneEntity || !assignedTarget || !hasDamageableHealth(assignedTarget)) {
      continue;
    }

    const assignResult = assignDroneCombatTask(
      scene,
      droneEntity,
      controllerEntity,
      assignedTarget,
      {
        nowMs: whenMs,
        autoAssigned: true,
        emitActivity: true,
      },
    );
    if (assignResult && assignResult.success === true) {
      engagedCount += 1;
    }
  }
  return engagedCount;
}

function tickDroneCombat(scene, droneEntity, controllerEntity, now) {
  const combatState =
    droneEntity &&
    droneEntity.droneCombat &&
    typeof droneEntity.droneCombat === "object"
      ? droneEntity.droneCombat
      : null;
  const targetID = toInt(
    combatState && combatState.targetID,
    toInt(droneEntity && droneEntity.targetID, 0),
  );
  const targetEntity = targetID > 0 ? scene.getEntityByID(targetID) : null;
  const governedTransientNpcAssignment =
    isGovernedTransientNpcCombatAssignment(
      droneEntity,
      controllerEntity,
      targetEntity,
    );
  if (
    !combatState ||
    !controllerEntity ||
    !targetEntity ||
    !hasDamageableHealth(targetEntity) ||
    (
      !governedTransientNpcAssignment &&
      !canPlayerCompanionActOnTarget(
        scene,
        null,
        droneEntity,
        controllerEntity,
        targetEntity,
      )
    )
  ) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }

  const snapshot =
    resolveDroneCombatSnapshot(droneEntity, controllerEntity) ||
    combatState.snapshot ||
    null;
  if (!snapshot) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }
  combatState.snapshot = snapshot;

  const ranges = resolveDroneEngagementRanges(snapshot);
  const surfaceDistance = getEntitySurfaceDistance(droneEntity, targetEntity);
  const beforeState = captureDroneClientState(droneEntity);
  copyControllerIdentity(droneEntity, controllerEntity);
  droneEntity.targetID = targetEntity.itemID;
  if (surfaceDistance > ranges.engagementRange + 1) {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState =
      surfaceDistance > ranges.chaseRange + 1
        ? STATE_PURSUIT
        : STATE_APPROACHING;
    persistAndNotifyDroneState(droneEntity, beforeState);
    return;
  }

  if (
    surfaceDistance > ranges.movementRange + 1 ||
    !shouldDroneOrbitTarget(targetEntity)
  ) {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
  } else {
    syncDroneOrbitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
  }
  droneEntity.activityState = STATE_COMBAT;
  persistAndNotifyDroneState(droneEntity, beforeState);

  if (toNumber(combatState.nextCycleAtMs, 0) > now) {
    return;
  }

  if (String(snapshot && snapshot.effectKind || "") === "jammer") {
    const runtime = getRuntime();
    if (snapshot.effectGUID) {
      scene.broadcastSpecialFx(
        droneEntity.itemID,
        snapshot.effectGUID,
        {
          moduleID: toInt(droneEntity && droneEntity.itemID, 0),
          moduleTypeID: toInt(droneEntity && droneEntity.typeID, 0),
          targetID: targetEntity.itemID,
          isOffensive: true,
          start: true,
          active: false,
          duration: Math.max(1, toNumber(snapshot.durationMs, 20_000)),
          repeat: 1,
          useCurrentVisibleStamp: true,
          avoidCurrentHistoryInsertion: true,
        },
        droneEntity,
      );
    }
    const effectState = {
      moduleID: toInt(droneEntity && droneEntity.itemID, 0),
      targetID: targetEntity.itemID,
      hostileJammingType: jammerModuleRuntime.ECM_JAMMING_TYPE,
      jammerModuleEffect: true,
      jammerStrengthBySensorType: snapshot.jammerStrengthBySensorType || {},
      jammerMaxRangeMeters: Math.max(0, toNumber(snapshot.optimalRange, 0)),
      jammerFalloffMeters: Math.max(0, toNumber(snapshot.falloff, 0)),
      durationMs: Math.max(1, toNumber(snapshot.durationMs, 20_000)),
      jamDurationMs: Math.max(1, toNumber(snapshot.jamDurationMs, 5_000)),
      nextCycleAtMs: now + Math.max(1, toNumber(snapshot.durationMs, 20_000)),
    };
    const cycleResult = jammerModuleRuntime.executeJammerModuleCycle({
      scene,
      entity: droneEntity,
      effectState,
      nowMs: now,
      callbacks: {
        getEntityByID(entityID) {
          return scene && typeof scene.getEntityByID === "function"
            ? scene.getEntityByID(entityID)
            : null;
        },
        isEntityLockedTarget() {
          return true;
        },
        getEntitySurfaceDistance(sourceEntity, externalTargetEntity) {
          return getEntitySurfaceDistance(sourceEntity, externalTargetEntity);
        },
        clearOutgoingTargetLocksExcept(externalTargetEntity, allowedTargetIDs, options = {}) {
          return scene && typeof scene.clearOutgoingTargetLocksExcept === "function"
            ? scene.clearOutgoingTargetLocksExcept(externalTargetEntity, allowedTargetIDs, options)
            : {
              clearedTargetIDs: [],
              cancelledPendingIDs: [],
            };
        },
        random() {
          return scene && typeof scene.__jammerRandom === "function"
            ? Number(scene.__jammerRandom()) || 0
            : Math.random();
        },
      },
    });
    if (
      cycleResult.success &&
      runtime &&
      typeof runtime.applyJammerCyclePresentation === "function"
    ) {
      runtime.applyJammerCyclePresentation(
        scene,
        droneEntity,
        effectState,
        now,
        cycleResult,
      );
    }
    combatState.nextCycleAtMs = now + Math.max(1, toNumber(snapshot.durationMs, 20_000));
    persistDroneEntityState(droneEntity);
    return;
  }

  const runtime = getRuntime();
  const droneInterop =
    runtime && runtime.droneInterop && typeof runtime.droneInterop === "object"
      ? runtime.droneInterop
      : null;
  if (!droneInterop || typeof droneInterop.resolveTurretShot !== "function") {
    return;
  }

  const pseudoModuleItem = buildDronePseudoModuleItem(droneEntity);
  const combatSourceEntity = buildDroneCombatSourceEntity(
    droneEntity,
    controllerEntity,
  ) || droneEntity;
  const shotResult = droneInterop.resolveTurretShot({
    attackerEntity: droneEntity,
    targetEntity,
    weaponSnapshot: snapshot,
  });
  if (snapshot.effectGUID) {
    scene.broadcastSpecialFx(
      droneEntity.itemID,
      snapshot.effectGUID,
      {
        moduleID: pseudoModuleItem.itemID,
        moduleTypeID: pseudoModuleItem.typeID,
        targetID: targetEntity.itemID,
        isOffensive: true,
        start: true,
        active: false,
        duration: snapshot.durationMs,
        repeat: 1,
        useCurrentVisibleStamp: true,
        avoidCurrentHistoryInsertion: true,
      },
      droneEntity,
    );
  }

  let damageResult = null;
  let destroyResult = null;
  if (
    shotResult &&
    shotResult.hit === true &&
    typeof droneInterop.applyWeaponDamageToTarget === "function"
  ) {
    const weaponDamageResult = droneInterop.applyWeaponDamageToTarget(
      scene,
      droneEntity,
      targetEntity,
      shotResult.shotDamage,
      now,
    );
    damageResult = weaponDamageResult && weaponDamageResult.damageResult
      ? weaponDamageResult.damageResult
      : null;
    destroyResult = weaponDamageResult && weaponDamageResult.destroyResult
      ? weaponDamageResult.destroyResult
      : null;
    const appliedDamageAmount =
      typeof droneInterop.getAppliedDamageAmount === "function"
        ? droneInterop.getAppliedDamageAmount(damageResult)
        : 0;
    if (
      appliedDamageAmount > 0 &&
      typeof droneInterop.noteKillmailDamage === "function"
    ) {
      droneInterop.noteKillmailDamage(
        combatSourceEntity,
        targetEntity,
        appliedDamageAmount,
        {
          whenMs: now,
          weaponSnapshot: {
            ...snapshot,
            moduleTypeID: pseudoModuleItem.typeID,
          },
          moduleItem: pseudoModuleItem,
          chargeItem: null,
        },
      );
    }
    if (
      destroyResult &&
      destroyResult.success === true &&
      typeof droneInterop.recordKillmailFromDestruction === "function"
    ) {
      droneInterop.recordKillmailFromDestruction(targetEntity, destroyResult, {
        attackerEntity: combatSourceEntity,
        victimSession: weaponDamageResult && weaponDamageResult.victimSession,
        whenMs: now,
        weaponSnapshot: {
          ...snapshot,
          moduleTypeID: pseudoModuleItem.typeID,
        },
        moduleItem: pseudoModuleItem,
        chargeItem: null,
      });
    }
  }

  if (typeof droneInterop.notifyWeaponDamageMessages === "function") {
    droneInterop.notifyWeaponDamageMessages(
      combatSourceEntity,
      targetEntity,
      pseudoModuleItem,
      shotResult && shotResult.shotDamage,
      typeof droneInterop.getAppliedDamageAmount === "function"
        ? droneInterop.getAppliedDamageAmount(damageResult)
        : 0,
      typeof droneInterop.getCombatMessageHitQuality === "function"
        ? droneInterop.getCombatMessageHitQuality(shotResult)
        : 0,
    );
  }

  combatState.nextCycleAtMs = now + Math.max(1, toNumber(snapshot.durationMs, 1000));
  if (destroyResult && destroyResult.success === true) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
  } else {
    persistDroneEntityState(droneEntity);
  }
}

function tickDroneMining(scene, droneEntity, controllerEntity, now) {
  const miningState =
    droneEntity &&
    droneEntity.droneMining &&
    typeof droneEntity.droneMining === "object"
      ? droneEntity.droneMining
      : null;
  const targetID = toInt(
    miningState && miningState.targetID,
    toInt(droneEntity && droneEntity.targetID, 0),
  );
  ensureSceneMiningState(scene);
  const targetEntity = targetID > 0 ? scene.getEntityByID(targetID) : null;
  const mineableState = getMineableState(scene, targetID);
  if (
    !miningState ||
    !controllerEntity ||
    !targetEntity ||
    !mineableState ||
    toInt(mineableState.remainingQuantity, 0) <= 0 ||
    !canPlayerCompanionActOnTarget(
      scene,
      null,
      droneEntity,
      controllerEntity,
      targetEntity,
    )
  ) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }

  const snapshot =
    resolveDroneMiningSnapshot(droneEntity, controllerEntity) ||
    miningState.snapshot ||
    null;
  if (!snapshot || !isDroneMiningCompatibleWithTarget(droneEntity, mineableState)) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }
  miningState.snapshot = snapshot;

  const orbitDistance = Math.max(
    MIN_ORBIT_DISTANCE_METERS,
    toNumber(snapshot.orbitDistanceMeters, MIN_ORBIT_DISTANCE_METERS),
  );
  const maxRange = Math.max(
    orbitDistance,
    toNumber(snapshot.maxRangeMeters, orbitDistance),
  );
  const surfaceDistance = getEntitySurfaceDistance(droneEntity, targetEntity);
  const beforeState = captureDroneClientState(droneEntity);

  copyControllerIdentity(droneEntity, controllerEntity);
  droneEntity.targetID = targetEntity.itemID;
  if (surfaceDistance > maxRange + 1) {
    syncDronePursuitBehavior(scene, droneEntity, targetEntity, orbitDistance);
    droneEntity.activityState = STATE_APPROACHING;
    clearDroneMiningCycle(miningState);
    persistAndNotifyDroneState(droneEntity, beforeState);
    return;
  }

  syncDroneOrbitBehavior(scene, droneEntity, targetEntity, orbitDistance);
  droneEntity.activityState = STATE_MINING;
  if (
    toNumber(miningState.cycleStartedAtMs, 0) <= 0 ||
    toNumber(miningState.nextCycleAtMs, 0) <= 0
  ) {
    beginDroneMiningCycle(miningState, snapshot, now);
  }
  persistAndNotifyDroneState(droneEntity, beforeState);
  emitDroneMiningCycleFx(
    scene,
    droneEntity,
    targetEntity,
    snapshot,
    miningState,
    now,
  );

  if (toNumber(miningState.nextCycleAtMs, 0) > now) {
    return;
  }

  const destination = resolveDroneMiningDestination(
    controllerEntity,
    mineableState.yieldTypeID,
    mineableState.yieldKind,
  );
  const miningAmountM3 = Math.max(0, toNumber(snapshot.miningAmountM3, 0));
  const unitVolume = Math.max(0.000001, toNumber(mineableState.unitVolume, 1));
  // A mining drone can only deliver whole units of ore, so the destination hold
  // is "full" the moment it cannot accept even one unit. Mirror the ship-side
  // mining laser (services/mining/miningRuntime): EVE cancels a cycle's progress
  // when "the ship has no more room for the ore by the time they return", and
  // the drone must idle here rather than keep mining. Testing only
  // availableVolume <= 0 missed the common near-full case: when a sub-unit
  // sliver of space was left, each cycle's fractional yield rounded back down to
  // zero and the drone restarted the cycle forever instead of stopping.
  const maximumTransferredQuantity = destination
    ? Math.max(0, Math.floor(destination.availableVolume / unitVolume))
    : 0;
  if (!destination || maximumTransferredQuantity <= 0 || miningAmountM3 <= 0) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
    return;
  }

  const quantityVolumeAvailable =
    Math.max(0, toInt(mineableState.remainingQuantity, 0)) * unitVolume;
  const availableTransferVolume = maximumTransferredQuantity * unitVolume;
  const clampFactor = Math.min(
    1,
    quantityVolumeAvailable / miningAmountM3,
    availableTransferVolume / miningAmountM3,
  );
  if (clampFactor <= 0) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
    return;
  }

  const miningResult = computeMiningResult({
    clampFactor,
    volume: miningAmountM3,
    unitVolume,
    asteroidQuantity: mineableState.remainingQuantity,
    wasteVolumeMultiplier: 0,
    wasteProbability: 0,
    critQuantityMultiplier: 0,
    critProbability: 0,
    efficiency: 1,
  });
  // Never deliver past the room actually left in the hold; whole-unit rounding
  // can otherwise overshoot a near-full bay by a unit.
  miningResult.normalQuantity = Math.min(
    miningResult.normalQuantity,
    maximumTransferredQuantity,
  );
  const transferredQuantity = miningResult.getTotalTransferredQuantity();
  const yieldTypeRecord = resolveItemByTypeID(toInt(mineableState.yieldTypeID, 0)) || null;
  if (!yieldTypeRecord || transferredQuantity <= 0) {
    beginDroneMiningCycle(miningState, snapshot, now);
    return;
  }

  const grantResult = grantItemToCharacterLocation(
    destination.storageSnapshot.characterID,
    destination.storageSnapshot.shipID,
    destination.flagID,
    yieldTypeRecord,
    transferredQuantity,
  );
  if (!grantResult || grantResult.success !== true) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
    return;
  }
  syncDroneInventoryChangesToSession(
    resolveDroneControllerSession(droneEntity, controllerEntity),
    grantResult.data && grantResult.data.changes,
  );

  const pseudoModuleItem = buildDronePseudoModuleItem(droneEntity);
  const deltaResult = applyMiningDelta(
    scene,
    targetEntity,
    miningResult.normalQuantity,
    miningResult.wastedQuantity,
    {
      broadcast: true,
      nowMs: now,
      sourceDroneID: droneEntity.itemID,
      sourceEntity: controllerEntity,
      moduleItem: pseudoModuleItem,
      quantityAdded: transferredQuantity,
      amountWasted: miningResult.wastedQuantity,
      moduleItemID: droneEntity.itemID,
      moduleTypeID: droneEntity.typeID,
      moduleGroupID: droneEntity.groupID,
    },
  );
  if (!deltaResult || deltaResult.success !== true) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
    return;
  }

  if (
    deltaResult.data &&
    deltaResult.data.depleted === true
  ) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
    return;
  }

  beginDroneMiningCycle(miningState, snapshot, now);
  emitDroneMiningCycleFx(
    scene,
    droneEntity,
    targetEntity,
    snapshot,
    miningState,
    now,
  );
  persistDroneEntityState(droneEntity);
}

function tickDroneSalvage(scene, droneEntity, controllerEntity, now) {
  const salvageState =
    droneEntity &&
    droneEntity.droneSalvage &&
    typeof droneEntity.droneSalvage === "object"
      ? droneEntity.droneSalvage
      : null;
  const targetID = toInt(
    salvageState && salvageState.targetID,
    toInt(droneEntity && droneEntity.targetID, 0),
  );
  const targetEntity = targetID > 0 ? scene.getEntityByID(targetID) : null;
  if (
    !salvageState ||
    !controllerEntity ||
    !targetEntity ||
    !salvagerRuntime.isSalvageableTarget(targetEntity) ||
    !canPlayerCompanionActOnTarget(
      scene,
      null,
      droneEntity,
      controllerEntity,
      targetEntity,
    )
  ) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }

  const snapshot =
    resolveDroneSalvageSnapshot(droneEntity, controllerEntity) ||
    salvageState.snapshot ||
    null;
  if (!snapshot) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }
  salvageState.snapshot = snapshot;
  salvageState.chanceSnapshot = salvagerRuntime.buildSalvageChanceSnapshot(
    targetEntity,
    snapshot.accessBonusPercent,
  );

  const orbitDistance = Math.max(
    MIN_ORBIT_DISTANCE_METERS,
    toNumber(snapshot.orbitDistanceMeters, MIN_ORBIT_DISTANCE_METERS),
  );
  const maxRange = Math.max(
    orbitDistance,
    toNumber(snapshot.maxRangeMeters, orbitDistance),
  );
  const surfaceDistance = getEntitySurfaceDistance(droneEntity, targetEntity);
  const beforeState = captureDroneClientState(droneEntity);

  copyControllerIdentity(droneEntity, controllerEntity);
  droneEntity.targetID = targetEntity.itemID;
  if (surfaceDistance > maxRange + 1) {
    syncDronePursuitBehavior(scene, droneEntity, targetEntity, orbitDistance);
    droneEntity.activityState = STATE_APPROACHING;
    persistAndNotifyDroneState(droneEntity, beforeState);
    return;
  }

  syncDroneOrbitBehavior(scene, droneEntity, targetEntity, orbitDistance);
  droneEntity.activityState = STATE_SALVAGING;
  persistAndNotifyDroneState(droneEntity, beforeState);

  if (toNumber(salvageState.nextCycleAtMs, 0) > now) {
    return;
  }

  const controllerSession = resolveDroneControllerSession(droneEntity, controllerEntity);
  const controllerCharacterID = toInt(
    (
      controllerSession &&
      (controllerSession.characterID || controllerSession.charid)
    ) ||
      controllerEntity.pilotCharacterID ||
      controllerEntity.characterID ||
      controllerEntity.ownerID,
    0,
  );
  const controllerShipItem =
    findItemById(toInt(controllerEntity && controllerEntity.itemID, 0)) || {
      itemID: toInt(controllerEntity && controllerEntity.itemID, 0),
      typeID: toInt(controllerEntity && controllerEntity.typeID, 0),
      ownerID: controllerCharacterID,
    };
  const cycleResult = salvagerRuntime.executeSalvagerCycle({
    scene,
    entity: droneEntity,
    effectState: {
      moduleID: toInt(droneEntity && droneEntity.itemID, 0),
      moduleFlagID: 0,
      typeID: toInt(droneEntity && droneEntity.typeID, 0),
      targetID,
      salvagerRangeMeters: snapshot.maxRangeMeters,
      salvageChancePercent: salvageState.chanceSnapshot.chancePercent,
    },
    nowMs: now,
    callbacks: {
      isEntityLockedTarget: () => true,
      getEntitySurfaceDistance,
      resolveCharacterID: () => controllerCharacterID,
      getEntityRuntimeShipItem: () => controllerShipItem,
      getEntityRuntimeFittedItems: () => controllerEntity.fittedItems || [],
      getEntityRuntimeSkillMap: () => controllerEntity.skillMap || new Map(),
      resolveSession: () => controllerSession,
      syncInventoryChangesToSession: syncDroneInventoryChangesToSession,
      random() {
        return scene && typeof scene.__salvageRandom === "function"
          ? scene.__salvageRandom()
          : Math.random();
      },
    },
  });

  if (snapshot.effectGUID) {
    scene.broadcastSpecialFx(
      droneEntity.itemID,
      snapshot.effectGUID,
      {
        moduleID: droneEntity.itemID,
        moduleTypeID: droneEntity.typeID,
        targetID: targetEntity.itemID,
        isOffensive: false,
        start: true,
        active: false,
        duration: snapshot.durationMs,
        repeat: 1,
        useCurrentVisibleStamp: true,
      },
      droneEntity,
    );
  }

  if (!cycleResult.success) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
    return;
  }

  salvageState.nextCycleAtMs = now + Math.max(1, toNumber(snapshot.durationMs, 1000));
  persistDroneEntityState(droneEntity);
}

function tickDroneRepair(scene, droneEntity, controllerEntity, now) {
  const repairState =
    droneEntity &&
    droneEntity.droneRepair &&
    typeof droneEntity.droneRepair === "object"
      ? droneEntity.droneRepair
      : null;
  const targetID = toInt(
    repairState && repairState.targetID,
    toInt(droneEntity && droneEntity.targetID, 0),
  );
  const targetEntity = targetID > 0 ? scene.getEntityByID(targetID) : null;
  if (
    !repairState ||
    !controllerEntity ||
    !targetEntity ||
    targetEntity.kind !== "ship" ||
    !hasDamageableHealth(targetEntity) ||
    !isFriendlyRepairTarget(controllerEntity, targetEntity) ||
    !canPlayerCompanionActOnTarget(
      scene,
      null,
      droneEntity,
      controllerEntity,
      targetEntity,
    )
  ) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }

  const snapshot =
    resolveDroneRepairSnapshot(droneEntity, controllerEntity) ||
    repairState.snapshot ||
    null;
  if (!snapshot) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: Boolean(controllerEntity),
    });
    return;
  }
  repairState.snapshot = snapshot;

  const ranges = resolveDroneEngagementRanges(snapshot);
  const surfaceDistance = getEntitySurfaceDistance(droneEntity, targetEntity);
  const beforeState = captureDroneClientState(droneEntity);
  copyControllerIdentity(droneEntity, controllerEntity);
  droneEntity.targetID = targetEntity.itemID;
  if (surfaceDistance > ranges.engagementRange + 1) {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
    droneEntity.activityState =
      surfaceDistance > ranges.chaseRange + 1
        ? STATE_PURSUIT
        : STATE_APPROACHING;
    persistAndNotifyDroneState(droneEntity, beforeState);
    return;
  }

  if (
    surfaceDistance > ranges.movementRange + 1 ||
    !shouldDroneOrbitTarget(targetEntity)
  ) {
    syncDronePursuitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
  } else {
    syncDroneOrbitBehavior(
      scene,
      droneEntity,
      targetEntity,
      ranges.movementRange,
    );
  }
  droneEntity.activityState = STATE_COMBAT;
  persistAndNotifyDroneState(droneEntity, beforeState);

  if (toNumber(repairState.nextCycleAtMs, 0) > now) {
    return;
  }

  if (snapshot.effectGUID) {
    scene.broadcastSpecialFx(
      droneEntity.itemID,
      snapshot.effectGUID,
      {
        moduleID: toInt(droneEntity && droneEntity.itemID, 0),
        moduleTypeID: toInt(droneEntity && droneEntity.typeID, 0),
        targetID: targetEntity.itemID,
        isOffensive: false,
        start: true,
        active: false,
        duration: Math.max(1, toNumber(snapshot.durationMs, 1000)),
        repeat: 1,
        useCurrentVisibleStamp: true,
        avoidCurrentHistoryInsertion: true,
      },
      droneEntity,
    );
  }

  const runtime = getRuntime();
  const droneInterop =
    runtime && runtime.droneInterop && typeof runtime.droneInterop === "object"
      ? runtime.droneInterop
      : {};
  const effectState = {
    moduleID: toInt(droneEntity && droneEntity.itemID, 0),
    targetID: targetEntity.itemID,
    assistanceModuleEffect: true,
    assistanceFamily: snapshot.repairFamily,
    assistanceJammingType: snapshot.repairFamily,
    assistanceMaxRangeMeters: Math.max(0, toNumber(snapshot.maxRangeMeters, 0)),
    assistanceFalloffMeters: 0,
    assistanceShieldBonusAmount: Math.max(0, toNumber(snapshot.shieldBonusAmount, 0)),
    assistanceArmorRepairAmount: Math.max(0, toNumber(snapshot.armorRepairAmount, 0)),
    assistanceHullRepairAmount: Math.max(0, toNumber(snapshot.hullRepairAmount, 0)),
  };
  const cycleResult = assistanceModuleRuntime.executeAssistanceModuleCycle({
    scene,
    session: resolveDroneControllerSession(droneEntity, controllerEntity),
    entity: droneEntity,
    effectState,
    nowMs: now,
    callbacks: {
      isEntityLockedTarget: () => true,
      getEntitySurfaceDistance(sourceEntity, externalTargetEntity) {
        return getEntitySurfaceDistance(sourceEntity, externalTargetEntity);
      },
      normalizeShipConditionState: droneInterop.normalizeShipConditionState,
      buildShipHealthTransitionResult: droneInterop.buildShipHealthTransitionResult,
      notifyShipHealthAttributesToSession: droneInterop.notifyShipHealthAttributesToSession,
      broadcastDamageStateChange: droneInterop.broadcastDamageStateChange,
      persistDynamicEntity: droneInterop.persistDynamicEntity,
    },
  });

  if (!cycleResult || cycleResult.success !== true) {
    resetDroneToIdle(droneEntity, controllerEntity, {
      scene,
      stopMovement: true,
    });
    return;
  }

  repairState.nextCycleAtMs = now + Math.max(1, toNumber(snapshot.durationMs, 1000));
  persistDroneEntityState(droneEntity);
}

function tickScene(scene, now) {
  void now;
  const droneEntities = getSceneDroneEntities(scene);
  if (droneEntities.length === 0) {
    return;
  }

  const returnBayReadyByShipID = new Map();
  beginDogmaTick();
  try {
  for (const droneEntity of droneEntities) {
    const controllerID = toInt(droneEntity.controllerID, 0);
    const controllerEntity = controllerID > 0 ? scene.getEntityByID(controllerID) : null;
    if (!controllerEntity && controllerID > 0) {
      abandonDroneInSpace(scene, droneEntity, {
        stopMovement: true,
      });
      continue;
    }

    if (
      droneEntity.droneCommand === DRONE_COMMAND_ENGAGE &&
      controllerEntity &&
      droneEntity.droneRepair
    ) {
      tickDroneRepair(scene, droneEntity, controllerEntity, toNumber(now, Date.now()));
      continue;
    }

    if (droneEntity.droneCommand === DRONE_COMMAND_ENGAGE && controllerEntity) {
      tickDroneCombat(scene, droneEntity, controllerEntity, toNumber(now, Date.now()));
      continue;
    }

    if (droneEntity.droneCommand === DRONE_COMMAND_MINE && controllerEntity) {
      tickDroneMining(scene, droneEntity, controllerEntity, toNumber(now, Date.now()));
      continue;
    }

    if (droneEntity.droneCommand === DRONE_COMMAND_SALVAGE && controllerEntity) {
      tickDroneSalvage(scene, droneEntity, controllerEntity, toNumber(now, Date.now()));
      continue;
    }

    if (droneEntity.droneCommand === DRONE_COMMAND_RETURN_HOME && controllerEntity) {
      const orbitDistance = Math.max(
        resolveDroneOrbitDistance(droneEntity),
        toNumber(droneEntity.droneHomeOrbitDistance, 0),
      );
      if (distance(droneEntity.position, controllerEntity.position) <= orbitDistance + controllerEntity.radius + droneEntity.radius) {
        scene.orbitShipEntity(droneEntity, controllerEntity.itemID, orbitDistance, {
          broadcast: true,
        });
        droneEntity.activityState = STATE_IDLE;
        droneEntity.targetID = null;
        droneEntity.droneCommand = null;
        droneEntity.activityID = null;
        droneEntity.activity = null;
        persistDroneEntityState(droneEntity);
        emitDroneStateChange(droneEntity);
        emitDroneActivityChange(droneEntity, null, null);
        markSceneControlledCombatDroneIndexDirty(scene);
      }
      continue;
    }

    if (droneEntity.droneCommand === DRONE_COMMAND_RETURN_BAY && controllerEntity) {
      if (getEntitySurfaceDistance(droneEntity, controllerEntity) <= DRONE_BAY_SCOOP_DISTANCE_METERS) {
        const shipRecord = findItemById(controllerEntity.itemID);
        if (shipRecord) {
          const shipID = toInt(shipRecord.itemID, 0);
          let readyGroup = returnBayReadyByShipID.get(shipID);
          if (!readyGroup) {
            readyGroup = {
              shipRecord,
              drones: [],
            };
            returnBayReadyByShipID.set(shipID, readyGroup);
          }
          readyGroup.drones.push(droneEntity);
        }
      }
    }
  }
  for (const readyGroup of returnBayReadyByShipID.values()) {
    recallDronesToBay(scene, readyGroup.shipRecord, readyGroup.drones);
  }
  } finally {
    endDogmaTick();
  }
}

module.exports = {
  DRONE_CATEGORY_ID,
  DRONE_COMMAND_RETURN_BAY,
  DRONE_COMMAND_RETURN_HOME,
  DRONE_COMMAND_ENGAGE,
  DRONE_COMMAND_MINE,
  DRONE_COMMAND_SALVAGE,
  STATE_IDLE,
  STATE_COMBAT,
  STATE_MINING,
  STATE_APPROACHING,
  STATE_DEPARTING,
  STATE_PURSUIT,
  STATE_SALVAGING,
  isDroneEntity,
  getDroneBandwidthLoad,
  resolveDroneOrbitDistance,
  hydrateDroneEntityFromItem,
  buildDroneStateRows,
  buildDroneStateNotificationTuple,
  emitDroneActivityChange,
  handleDroneDestroyed,
  noteIncomingAggression,
  normalizeDroneIDList,
  normalizeLaunchRequests,
  launchDronesForSession,
  commandEngage,
  commandMineRepeatedly,
  commandSalvage,
  commandReturnHome,
  commandReturnBay,
  commandAbandonDrone,
  commandReconnectToDrones,
  handleControllerLost,
  scoopDrone,
  idleMiningDronesTargeting,
  spawnTransientNpcDroneWing,
  tickScene,
  _testing: {
    canPlayerCompanionActOnTarget,
    persistDroneEntityState,
    serializePlayerCompanionScopeMetadata,
  },
};
