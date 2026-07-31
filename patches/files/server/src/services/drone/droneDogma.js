const path = require("path");

const {
  getAttributeIDByNames,
  getEffectTypeRecord,
  getLoadedChargeByFlag,
  getFittedModuleItems,
  getTypeEffectRecords,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  getCachedCharacterSkillMap,
  getSkillMutationVersion,
} = require(path.join(__dirname, "../skills/skillState"));
const {
  getExpertSystemMutationVersion,
} = require(path.join(__dirname, "../skills/expertSystems/expertSystemState"));
const {
  getDogmaInvalidationVersion,
} = require(path.join(__dirname, "../character/dogmaInvalidationVersion"));
const {
  findItemById,
  findShipItemById,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  buildLocationModifiedAttributeMap,
  collectShipModifierAttributes,
} = require(path.join(__dirname, "../../space/combat/weaponDogma"));
const {
  getLocationModifierSourcesForSystem,
} = require(path.join(
  __dirname,
  "../exploration/wormholes/wormholeEnvironmentRuntime",
));
const {
  getActiveImplants,
  getActiveBoosters,
  getActiveImplantLocationModifierSources,
  getActiveImplantSourceStates,
  getActiveImplantShipModifierEntries,
} = require(path.join(__dirname, "../dogma/implants/activeImplantModifiers"));

const ATTRIBUTE_SPEED = getAttributeIDByNames("speed") || 51;
const ATTRIBUTE_DURATION = getAttributeIDByNames("duration") || 73;
const ATTRIBUTE_MAX_RANGE = getAttributeIDByNames("maxRange") || 54;
const ATTRIBUTE_FALLOFF = getAttributeIDByNames("falloff") || 158;
const ATTRIBUTE_TRACKING_SPEED = getAttributeIDByNames("trackingSpeed") || 160;
const ATTRIBUTE_OPTIMAL_SIG_RADIUS = getAttributeIDByNames("optimalSigRadius") || 620;
const ATTRIBUTE_SIGNATURE_RADIUS = getAttributeIDByNames("signatureRadius") || 552;
const ATTRIBUTE_ECM_JAM_DURATION = getAttributeIDByNames("ecmJamDuration") || 2822;
const ATTRIBUTE_SCAN_GRAVIMETRIC_STRENGTH_BONUS =
  getAttributeIDByNames("scanGravimetricStrengthBonus") || 238;
const ATTRIBUTE_SCAN_LADAR_STRENGTH_BONUS =
  getAttributeIDByNames("scanLadarStrengthBonus") || 239;
const ATTRIBUTE_SCAN_MAGNETOMETRIC_STRENGTH_BONUS =
  getAttributeIDByNames("scanMagnetometricStrengthBonus") || 240;
const ATTRIBUTE_SCAN_RADAR_STRENGTH_BONUS =
  getAttributeIDByNames("scanRadarStrengthBonus") || 241;
const ATTRIBUTE_DAMAGE_MULTIPLIER = getAttributeIDByNames("damageMultiplier") || 64;
const ATTRIBUTE_EM_DAMAGE = getAttributeIDByNames("emDamage") || 114;
const ATTRIBUTE_EXPLOSIVE_DAMAGE = getAttributeIDByNames("explosiveDamage") || 116;
const ATTRIBUTE_KINETIC_DAMAGE = getAttributeIDByNames("kineticDamage") || 117;
const ATTRIBUTE_THERMAL_DAMAGE = getAttributeIDByNames("thermalDamage") || 118;
const ATTRIBUTE_ENTITY_FLY_RANGE = getAttributeIDByNames("entityFlyRange") || 416;
const ATTRIBUTE_ENTITY_ATTACK_RANGE = getAttributeIDByNames("entityAttackRange") || 72;
const ATTRIBUTE_ENTITY_CHASE_MAX_DISTANCE =
  getAttributeIDByNames("entityChaseMaxDistance") || 613;
const ATTRIBUTE_ORBIT_RANGE = getAttributeIDByNames("orbitRange") || 4161;
const ATTRIBUTE_MINING_AMOUNT = getAttributeIDByNames("miningAmount") || 77;
const ATTRIBUTE_ACCESS_DIFFICULTY_BONUS =
  getAttributeIDByNames("accessDifficultyBonus") || 902;
const ATTRIBUTE_SHIELD_BONUS = getAttributeIDByNames("shieldBonus") || 68;
const ATTRIBUTE_ARMOR_DAMAGE_AMOUNT =
  getAttributeIDByNames("armorDamageAmount") || 84;
const ATTRIBUTE_STRUCTURE_DAMAGE_AMOUNT =
  getAttributeIDByNames("structureDamageAmount") || 83;

const COMBAT_EFFECT_NAMES = new Set(["targetattack"]);
const ECM_EFFECT_NAMES = new Set(["entityecmfalloff"]);
const MINING_EFFECT_NAMES = new Set(["mining", "miningclouds"]);
const SALVAGE_EFFECT_NAMES = new Set(["salvagedroneeffect"]);
const REPAIR_EFFECT_DEFINITIONS = Object.freeze({
  npcentityremoteshieldbooster: Object.freeze({
    family: "remoteShield",
    amountAttributeID: ATTRIBUTE_SHIELD_BONUS,
  }),
  npcentityremotearmorrepairer: Object.freeze({
    family: "remoteArmor",
    amountAttributeID: ATTRIBUTE_ARMOR_DAMAGE_AMOUNT,
  }),
  npcentityremotehullrepairer: Object.freeze({
    family: "remoteHull",
    amountAttributeID: ATTRIBUTE_STRUCTURE_DAMAGE_AMOUNT,
  }),
  targetarmorrepair: Object.freeze({
    family: "remoteArmor",
    amountAttributeID: ATTRIBUTE_ARMOR_DAMAGE_AMOUNT,
  }),
});

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function firstPositiveInt(...values) {
  for (const value of values) {
    const numeric = toInt(value, 0);
    if (numeric > 0) {
      return numeric;
    }
  }
  return 0;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round6(value) {
  return Number(toFiniteNumber(value, 0).toFixed(6));
}

function buildDamageVector(attributes = {}) {
  return {
    em: Math.max(0, round6(toFiniteNumber(attributes[ATTRIBUTE_EM_DAMAGE], 0))),
    thermal: Math.max(0, round6(toFiniteNumber(attributes[ATTRIBUTE_THERMAL_DAMAGE], 0))),
    kinetic: Math.max(0, round6(toFiniteNumber(attributes[ATTRIBUTE_KINETIC_DAMAGE], 0))),
    explosive: Math.max(0, round6(toFiniteNumber(attributes[ATTRIBUTE_EXPLOSIVE_DAMAGE], 0))),
  };
}

function fingerprintText(value) {
  const text = String(value || "");
  if (!text) {
    return "";
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length}:${hash.toString(36)}`;
}

function resolveDroneDogmaItem(droneEntity) {
  if (!droneEntity) {
    return null;
  }

  const itemID = firstPositiveInt(droneEntity.itemID);
  const storedItem = itemID > 0 ? findItemById(itemID) : null;
  const typeID = firstPositiveInt(
    droneEntity.typeID,
    storedItem && storedItem.typeID,
  );
  if (typeID <= 0) {
    return null;
  }

  const customInfo =
    droneEntity.customInfo !== undefined &&
    droneEntity.customInfo !== null &&
    String(droneEntity.customInfo || "") !== ""
      ? String(droneEntity.customInfo || "")
      : String((storedItem && storedItem.customInfo) || "");

  return {
    ...(storedItem || {}),
    itemID,
    typeID,
    groupID: firstPositiveInt(
      droneEntity.groupID,
      storedItem && storedItem.groupID,
    ),
    categoryID: firstPositiveInt(
      droneEntity.categoryID,
      storedItem && storedItem.categoryID,
    ),
    ownerID: firstPositiveInt(
      droneEntity.ownerID,
      storedItem && storedItem.ownerID,
    ),
    locationID: firstPositiveInt(
      droneEntity.locationID,
      storedItem && storedItem.locationID,
      droneEntity.systemID,
    ),
    flagID:
      droneEntity.flagID !== undefined && droneEntity.flagID !== null
        ? toInt(droneEntity.flagID, 0)
        : toInt(storedItem && storedItem.flagID, 0),
    singleton:
      droneEntity.singleton !== undefined && droneEntity.singleton !== null
        ? toInt(droneEntity.singleton, 1)
        : toInt(storedItem && storedItem.singleton, 1),
    quantity:
      droneEntity.quantity !== undefined && droneEntity.quantity !== null
        ? droneEntity.quantity
        : storedItem && storedItem.quantity !== undefined
          ? storedItem.quantity
          : 1,
    stacksize:
      droneEntity.stacksize !== undefined && droneEntity.stacksize !== null
        ? droneEntity.stacksize
        : storedItem && storedItem.stacksize !== undefined
          ? storedItem.stacksize
          : 1,
    customInfo,
  };
}

function buildDroneSnapshotCacheKey(droneEntity, droneItem = null) {
  const resolvedItem = droneItem || resolveDroneDogmaItem(droneEntity);
  const typeID = firstPositiveInt(
    resolvedItem && resolvedItem.typeID,
    droneEntity && droneEntity.typeID,
  );
  const itemID = firstPositiveInt(
    resolvedItem && resolvedItem.itemID,
    droneEntity && droneEntity.itemID,
  );
  const customInfo = String(
    (resolvedItem && resolvedItem.customInfo) ||
      (droneEntity && droneEntity.customInfo) ||
      "",
  );
  if (itemID > 0) {
    // Do NOT embed the global itemMutationVersion: the enclosing controller
    // context (and its miningByTypeID/operationalByTypeID) is invalidated by the
    // cross-tick dogma fingerprint on any real dogma change, and customInfo
    // captures in-place drone (mutaplasmid) mutation. The global counter is bumped
    // EVERY tick by routine drone-state persistence, which would thrash this
    // per-drone snapshot cache.
    return `item:${itemID}:${typeID}:${fingerprintText(customInfo)}`;
  }
  return `type:${typeID}:${fingerprintText(customInfo)}`;
}

function sumDamageVector(vector = {}) {
  return round6(
    Math.max(0, toFiniteNumber(vector.em, 0)) +
      Math.max(0, toFiniteNumber(vector.thermal, 0)) +
      Math.max(0, toFiniteNumber(vector.kinetic, 0)) +
      Math.max(0, toFiniteNumber(vector.explosive, 0)),
  );
}

// Lazy require: a top-level require of characterState introduces a load-order
// cycle (characterState -> ... -> droneDogma) that leaves sibling modules with
// partial exports. Resolve it on first use and memoize the reference.
let cachedPeekCharacterRecord = null;
function peekCharacterRecord(charId) {
  if (!cachedPeekCharacterRecord) {
    cachedPeekCharacterRecord = require(path.join(
      __dirname,
      "../character/characterState",
    )).peekCharacterRecord;
  }
  return cachedPeekCharacterRecord(charId);
}

function buildControllerDogmaFingerprint(controllerEntity, fittedItems = []) {
  const shipID = toInt(controllerEntity && controllerEntity.itemID, 0);
  const controllerOwnerID = toInt(
    controllerEntity &&
      (
        controllerEntity.session && controllerEntity.session.characterID
      ) ||
      controllerEntity &&
      (
        controllerEntity.pilotCharacterID ??
        controllerEntity.characterID ??
        controllerEntity.ownerID
      ),
    0,
  );
  const systemID = toInt(controllerEntity && controllerEntity.systemID, 0);
  // Read-only raw record reference (no clone). Handed as an OBJECT,
  // getActiveImplants/getActiveBoosters skip the getCharacterRecord clone+
  // serialize that otherwise ran twice per controller per tick just to build this
  // identity key — the record's array-shaped implants/boosters yield the same IDs.
  const controllerCharacterRecord =
    controllerOwnerID > 0 ? peekCharacterRecord(controllerOwnerID) : null;
  const activeEffectFingerprint =
    controllerEntity && controllerEntity.activeModuleEffects instanceof Map
      ? [...controllerEntity.activeModuleEffects.values()]
        .filter(Boolean)
        .map((effectState) => (
          `${toInt(effectState && effectState.moduleID, 0)}:` +
          `${toInt(effectState && effectState.effectID, 0)}:` +
          `${toInt(effectState && effectState.chargeTypeID, 0)}`
        ))
        .sort()
        .join("|")
      : "";
  const activeImplantFingerprint =
    controllerOwnerID > 0
      // Identity only (slot:typeID) — use getActiveImplants, NOT
      // getActiveImplantSourceStates, which deep-clones attribute maps and runs
      // an O(n^2) implant dogma resolution just to build this cache key (~15ms).
      ? getActiveImplants(controllerCharacterRecord)
        .map((implant) => `${toInt(implant && implant.slot, 0)}:${toInt(implant && implant.typeID, 0)}`)
        .join(",")
      : "";
  // CROSS-TICK fingerprint: key on dogma-scoped + skill/expert version counters
  // (stable across ticks; bumped only on a real refit/skill/implant/booster
  // change) instead of the global itemMutationVersion that routine item writes
  // (drone state persistence!) would thrash. Fitted-item IDENTITIES catch
  // fit/unfit; activeEffects catch online/charge; implants and boosters are
  // captured by identity. Known gap: in-place mutaplasmid mutation of a fitted
  // module (rare).
  const fittedIdentityFingerprint = fittedItems
    .map((item) => `${toInt(item && item.itemID, 0)}:${toInt(item && item.flagID, 0)}:${toInt(item && item.typeID, 0)}`)
    .join("|");
  // Booster identity (typeID:slot). getActiveBoosters filters wall-clock-expired
  // boosters, so this changes both on inject AND when a booster expires — closing
  // the booster gap without a discrete expiry hook.
  const activeBoosterFingerprint =
    controllerOwnerID > 0
      ? getActiveBoosters(controllerCharacterRecord)
        .map((booster) => `${toInt(booster && booster.typeID, 0)}:${toInt(booster && booster.slot, 0)}`)
        .join(",")
      : "";
  return [
    "v2",
    getDogmaInvalidationVersion(),
    getSkillMutationVersion(),
    getExpertSystemMutationVersion(),
    systemID,
    fittedIdentityFingerprint,
    activeEffectFingerprint,
    activeImplantFingerprint,
    activeBoosterFingerprint,
  ].join("#");
}

function buildActiveModuleContexts(controllerEntity, fittedItems = [], characterID = 0) {
  if (!controllerEntity || !(controllerEntity.activeModuleEffects instanceof Map)) {
    return [];
  }

  return [...controllerEntity.activeModuleEffects.values()]
    .filter(Boolean)
    .map((effectState) => {
      const moduleItem = fittedItems.find((item) => (
        toInt(item && item.itemID, 0) === toInt(effectState && effectState.moduleID, 0) ||
        (
          toInt(effectState && effectState.moduleFlagID, 0) > 0 &&
          toInt(item && item.flagID, 0) === toInt(effectState && effectState.moduleFlagID, 0)
        )
      )) || null;
      if (!moduleItem) {
        return null;
      }

      return {
        effectState,
        effectRecord: getEffectTypeRecord(toInt(effectState && effectState.effectID, 0)),
        moduleItem,
        chargeItem:
          characterID > 0 && toInt(moduleItem && moduleItem.flagID, 0) > 0
            ? getLoadedChargeByFlag(
              characterID,
              toInt(controllerEntity && controllerEntity.itemID, 0),
              toInt(moduleItem && moduleItem.flagID, 0),
            )
            : null,
      };
    })
    .filter((entry) => entry && entry.effectRecord && entry.moduleItem);
}

// Monotonic per-tick stamp + an "inside the drone tick" flag.
let dogmaTickEpoch = 0;
let dogmaTickActive = false;

// During a drone tickScene the controller's fitting/skills are invariant, but
// item writes (drone state persistence) bump the GLOBAL itemMutationVersion that
// the dogma fingerprint embeds — so the cross-tick context cache misses on every
// drone, forcing a full ship-dogma rebuild (incl. a ~12ms skill-map deep clone)
// per drone per tick. beginDogmaTick/endDogmaTick bracket the synchronous tick so
// getControllerDogmaContext can memo the context for the whole tick, and fall
// back to the normal fingerprint cache between ticks. The epoch is MONOTONIC (a
// fresh value each tick) so the memo only matches within the tick it was stamped
// in — the context is still recomputed/re-validated once per tick, catching
// refits and skill changes; it just dedupes the ~15 redundant resolves per tick.
function beginDogmaTick() {
  dogmaTickEpoch += 1;
  dogmaTickActive = true;
}

function endDogmaTick() {
  dogmaTickActive = false;
}

function getControllerDogmaContext(controllerEntity) {
  const controllerShipID = toInt(controllerEntity && controllerEntity.itemID, 0);
  if (controllerShipID <= 0) {
    return null;
  }

  if (
    dogmaTickActive &&
    controllerEntity &&
    controllerEntity.droneDogmaCache &&
    controllerEntity.droneDogmaCache.dogmaTickEpoch === dogmaTickEpoch
  ) {
    return controllerEntity.droneDogmaCache;
  }

  const controllerOwnerID = toInt(
    controllerEntity &&
      (
        controllerEntity.session && controllerEntity.session.characterID
      ) ||
      controllerEntity &&
      (
        controllerEntity.pilotCharacterID ??
        controllerEntity.characterID ??
        controllerEntity.ownerID
      ),
    0,
  );
  const nativeNpcController = Boolean(
    controllerEntity && controllerEntity.nativeNpc === true,
  );
  const storedShipItem =
    findShipItemById(controllerShipID) ||
    findItemById(controllerShipID) ||
    null;
  const shipItem =
    storedShipItem ||
    (nativeNpcController
      ? {
          itemID: controllerShipID,
          typeID: toInt(controllerEntity.typeID, 0),
          groupID: toInt(controllerEntity.groupID, 0),
          categoryID: toInt(controllerEntity.categoryID, 6),
          itemName: String(
            controllerEntity.itemName || "NPC drone controller",
          ),
          ownerID: controllerOwnerID,
        }
      : null);
  if (!shipItem) {
    return null;
  }

  const fittedItems =
    nativeNpcController && Array.isArray(controllerEntity.fittedItems)
      ? controllerEntity.fittedItems
      : controllerOwnerID > 0
      ? getFittedModuleItems(controllerOwnerID, controllerShipID)
      : [];
  const fingerprint = buildControllerDogmaFingerprint(controllerEntity, fittedItems);
  const cached =
    controllerEntity &&
    controllerEntity.droneDogmaCache &&
    controllerEntity.droneDogmaCache.fingerprint === fingerprint
      ? controllerEntity.droneDogmaCache
      : null;
  if (cached) {
    cached.dogmaTickEpoch = dogmaTickEpoch;
    return cached;
  }

  const skillMap =
    nativeNpcController && controllerEntity.skillMap instanceof Map
      ? controllerEntity.skillMap
      : controllerOwnerID > 0
      ? getCachedCharacterSkillMap(controllerOwnerID)
      : new Map();
  const activeModuleContexts = buildActiveModuleContexts(
    controllerEntity,
    fittedItems,
    controllerOwnerID,
  );
  const implantShipModifierEntries =
    controllerOwnerID > 0 ? getActiveImplantShipModifierEntries(controllerOwnerID) : [];
  const shipModifierAttributes = collectShipModifierAttributes(
    shipItem,
    skillMap,
    activeModuleContexts,
    {
      additionalDirectModifierEntries: implantShipModifierEntries,
    },
  );
  const additionalLocationModifierSources = [
    ...(controllerOwnerID > 0
      ? getActiveImplantLocationModifierSources(controllerOwnerID)
      : []),
    ...getLocationModifierSourcesForSystem(
      controllerEntity && controllerEntity.systemID,
    ),
  ];
  const nextCache = {
    fingerprint,
    shipItem,
    skillMap,
    fittedItems,
    activeModuleContexts,
    shipModifierAttributes,
    additionalLocationModifierSources,
    combatByTypeID: new Map(),
    miningByTypeID: new Map(),
    salvageByTypeID: new Map(),
    repairByTypeID: new Map(),
    operationalByTypeID: new Map(),
  };
  nextCache.dogmaTickEpoch = dogmaTickEpoch;
  controllerEntity.droneDogmaCache = nextCache;
  return nextCache;
}

function resolveDroneEffectRecord(typeID, acceptedNames = new Set()) {
  for (const effectRecord of getTypeEffectRecords(typeID)) {
    const normalizedName = String(effectRecord && effectRecord.name || "").trim().toLowerCase();
    if (acceptedNames.has(normalizedName)) {
      return effectRecord;
    }
  }
  return null;
}

function resolveDroneRepairEffectRecord(typeID) {
  for (const effectRecord of getTypeEffectRecords(typeID)) {
    const normalizedName = String(effectRecord && effectRecord.name || "").trim().toLowerCase();
    if (REPAIR_EFFECT_DEFINITIONS[normalizedName]) {
      return {
        effectRecord,
        definition: REPAIR_EFFECT_DEFINITIONS[normalizedName],
      };
    }
  }
  return null;
}

function buildDroneOperationalAttributes(droneEntity, controllerEntity) {
  const context = getControllerDogmaContext(controllerEntity);
  if (!context || !droneEntity) {
    return null;
  }

  const droneItem = resolveDroneDogmaItem(droneEntity);
  if (!droneItem) {
    return null;
  }

  // Per-drone operational-attribute cache. The mining/combat/salvage snapshot
  // caches cover the YIELD path, but copyControllerIdentity ->
  // applyDroneOperationalEntityAttributes resolves the full drone attribute map
  // (mass/inertia/velocity) every tick on a path the snapshot caches never
  // touched — buildLocationModifiedAttributeMap was rebuilt per drone per tick.
  // Memoize it in the controller context (same lifetime/invalidation as the
  // snapshot caches): holds cross-tick when the context holds, deduped within a
  // tick otherwise. Keyed on the shared per-drone snapshot key so a refit/
  // mutaplasmid change still rebuilds.
  const cacheKey = buildDroneSnapshotCacheKey(droneEntity, droneItem);
  if (context.operationalByTypeID.has(cacheKey)) {
    return context.operationalByTypeID.get(cacheKey);
  }

  const attributes = buildLocationModifiedAttributeMap(
    droneItem,
    context.shipItem,
    context.skillMap,
    context.shipModifierAttributes,
    context.fittedItems,
    context.activeModuleContexts,
    {
      additionalLocationModifierSources: context.additionalLocationModifierSources,
    },
  );
  if (!attributes || Object.keys(attributes).length === 0) {
    context.operationalByTypeID.set(cacheKey, null);
    return null;
  }
  const result = { context, attributes };
  context.operationalByTypeID.set(cacheKey, result);
  return result;
}

function resolveDroneOperationalAttributes(droneEntity, controllerEntity) {
  const operational = buildDroneOperationalAttributes(droneEntity, controllerEntity);
  return operational ? operational.attributes : null;
}

function resolveDroneCombatSnapshot(droneEntity, controllerEntity) {
  const context = getControllerDogmaContext(controllerEntity);
  const droneItem = resolveDroneDogmaItem(droneEntity);
  const typeID = toInt(droneItem && droneItem.typeID, 0);
  if (!context || typeID <= 0) {
    return null;
  }

  const cacheKey = buildDroneSnapshotCacheKey(droneEntity, droneItem);
  if (context.combatByTypeID.has(cacheKey)) {
    return context.combatByTypeID.get(cacheKey);
  }

  const effectRecord = resolveDroneEffectRecord(typeID, COMBAT_EFFECT_NAMES);
  const jammerEffectRecord = effectRecord
    ? null
    : resolveDroneEffectRecord(typeID, ECM_EFFECT_NAMES);
  if (!effectRecord && !jammerEffectRecord) {
    context.combatByTypeID.set(cacheKey, null);
    return null;
  }

  const operational = buildDroneOperationalAttributes(droneItem, controllerEntity);
  if (!operational) {
    context.combatByTypeID.set(cacheKey, null);
    return null;
  }

  const attributes = operational.attributes;
  const baseDamage = buildDamageVector(attributes);
  const damageMultiplier = Math.max(
    0,
    round6(toFiniteNumber(attributes[ATTRIBUTE_DAMAGE_MULTIPLIER], 1)),
  );
  const rawShotDamage = {
    em: round6(baseDamage.em * damageMultiplier),
    thermal: round6(baseDamage.thermal * damageMultiplier),
    kinetic: round6(baseDamage.kinetic * damageMultiplier),
    explosive: round6(baseDamage.explosive * damageMultiplier),
  };
  if (!jammerEffectRecord && sumDamageVector(rawShotDamage) <= 0) {
    context.combatByTypeID.set(cacheKey, null);
    return null;
  }

  if (jammerEffectRecord) {
    const durationMs = Math.max(
      1,
      round6(toFiniteNumber(attributes[jammerEffectRecord.durationAttributeID], 20_000)),
    );
    const optimalRange = Math.max(
      0,
      round6(toFiniteNumber(attributes[jammerEffectRecord.rangeAttributeID], 0)),
    );
    const falloff = Math.max(
      0,
      round6(
        toFiniteNumber(
          attributes[jammerEffectRecord.falloffAttributeID],
          0,
        ),
      ),
    );
    const orbitDistanceMeters = Math.max(
      500,
      round6(
        toFiniteNumber(
          attributes[ATTRIBUTE_ENTITY_FLY_RANGE],
          toFiniteNumber(attributes[ATTRIBUTE_ORBIT_RANGE], 500),
        ),
      ),
    );
    const attackRangeMeters = Math.max(
      optimalRange,
      round6(optimalRange + falloff),
    );
    const chaseRangeMeters = Math.max(
      attackRangeMeters,
      round6(
        Math.max(
          attackRangeMeters,
          toFiniteNumber(attributes[ATTRIBUTE_ENTITY_ATTACK_RANGE], 0),
        ),
      ),
    );
    const snapshot = {
      effectID: toInt(jammerEffectRecord.effectID, 0),
      effectName: String(jammerEffectRecord.name || ""),
      effectGUID: String(jammerEffectRecord.guid || ""),
      effectKind: "jammer",
      durationMs,
      jamDurationMs: Math.max(
        1,
        round6(toFiniteNumber(attributes[ATTRIBUTE_ECM_JAM_DURATION], 5_000)),
      ),
      optimalRange,
      falloff,
      orbitDistanceMeters,
      attackRangeMeters,
      chaseRangeMeters,
      jammerStrengthBySensorType: Object.freeze({
        gravimetric: Math.max(
          0,
          round6(toFiniteNumber(attributes[ATTRIBUTE_SCAN_GRAVIMETRIC_STRENGTH_BONUS], 0)),
        ),
        ladar: Math.max(
          0,
          round6(toFiniteNumber(attributes[ATTRIBUTE_SCAN_LADAR_STRENGTH_BONUS], 0)),
        ),
        magnetometric: Math.max(
          0,
          round6(toFiniteNumber(attributes[ATTRIBUTE_SCAN_MAGNETOMETRIC_STRENGTH_BONUS], 0)),
        ),
        radar: Math.max(
          0,
          round6(toFiniteNumber(attributes[ATTRIBUTE_SCAN_RADAR_STRENGTH_BONUS], 0)),
        ),
      }),
    };
    context.combatByTypeID.set(cacheKey, snapshot);
    return snapshot;
  }

  const durationMs = Math.max(
    1,
    round6(
      toFiniteNumber(
        attributes[ATTRIBUTE_SPEED],
        toFiniteNumber(attributes[ATTRIBUTE_DURATION], 1000),
      ),
    ),
  );
  const optimalRange = Math.max(
    0,
    round6(toFiniteNumber(attributes[ATTRIBUTE_MAX_RANGE], 0)),
  );
  const falloff = Math.max(
    0,
    round6(toFiniteNumber(attributes[ATTRIBUTE_FALLOFF], 0)),
  );
  const trackingSpeed = Math.max(
    0,
    round6(toFiniteNumber(attributes[ATTRIBUTE_TRACKING_SPEED], 0)),
  );
  const optimalSigRadius = Math.max(
    1,
    round6(
      toFiniteNumber(
        attributes[ATTRIBUTE_OPTIMAL_SIG_RADIUS],
        toFiniteNumber(attributes[ATTRIBUTE_SIGNATURE_RADIUS], 25),
      ),
    ),
  );
  const orbitDistanceMeters = Math.max(
    0,
    round6(
      toFiniteNumber(
        attributes[ATTRIBUTE_ENTITY_FLY_RANGE],
        toFiniteNumber(attributes[ATTRIBUTE_ORBIT_RANGE], 500),
      ),
    ),
  );
  const attackRangeMeters = Math.max(
    0,
    round6(
      Math.max(
        toFiniteNumber(attributes[ATTRIBUTE_ENTITY_ATTACK_RANGE], 0),
        optimalRange,
      ),
    ),
  );
  const chaseRangeMeters = Math.max(
    attackRangeMeters,
    round6(
      Math.max(
        attackRangeMeters + falloff,
        toFiniteNumber(attributes[ATTRIBUTE_ENTITY_CHASE_MAX_DISTANCE], 0),
      ),
    ),
  );

  const snapshot = {
    effectID: toInt(effectRecord.effectID, 0),
    effectName: String(effectRecord.name || ""),
    effectGUID: String(effectRecord.guid || ""),
    durationMs,
    optimalRange,
    falloff,
    trackingSpeed,
    optimalSigRadius,
    damageMultiplier,
    rawShotDamage,
    orbitDistanceMeters,
    attackRangeMeters,
    chaseRangeMeters,
  };
  context.combatByTypeID.set(cacheKey, snapshot);
  return snapshot;
}

function resolveDroneMiningSnapshot(droneEntity, controllerEntity) {
  const context = getControllerDogmaContext(controllerEntity);
  const droneItem = resolveDroneDogmaItem(droneEntity);
  const typeID = toInt(droneItem && droneItem.typeID, 0);
  if (!context || typeID <= 0) {
    return null;
  }

  const cacheKey = buildDroneSnapshotCacheKey(droneEntity, droneItem);
  if (context.miningByTypeID.has(cacheKey)) {
    return context.miningByTypeID.get(cacheKey);
  }

  const effectRecord = resolveDroneEffectRecord(typeID, MINING_EFFECT_NAMES);
  if (!effectRecord) {
    context.miningByTypeID.set(cacheKey, null);
    return null;
  }

  const operational = buildDroneOperationalAttributes(droneItem, controllerEntity);
  if (!operational) {
    context.miningByTypeID.set(cacheKey, null);
    return null;
  }

  const attributes = operational.attributes;
  const miningAmountM3 = Math.max(
    0,
    round6(toFiniteNumber(attributes[ATTRIBUTE_MINING_AMOUNT], 0)),
  );
  if (miningAmountM3 <= 0) {
    context.miningByTypeID.set(cacheKey, null);
    return null;
  }

  const durationMs = Math.max(
    1,
    round6(
      toFiniteNumber(
        attributes[ATTRIBUTE_DURATION],
        toFiniteNumber(attributes[ATTRIBUTE_SPEED], 1000),
      ),
    ),
  );
  const snapshot = {
    effectID: toInt(effectRecord.effectID, 0),
    effectName: String(effectRecord.name || ""),
    effectGUID: String(effectRecord.guid || ""),
    durationMs,
    miningAmountM3,
    maxRangeMeters: Math.max(
      0,
      round6(toFiniteNumber(attributes[ATTRIBUTE_MAX_RANGE], 0)),
    ),
    orbitDistanceMeters: Math.max(
      0,
      round6(
        toFiniteNumber(
          attributes[ATTRIBUTE_ORBIT_RANGE],
          toFiniteNumber(attributes[ATTRIBUTE_ENTITY_FLY_RANGE], 200),
        ),
      ),
    ),
  };
  context.miningByTypeID.set(cacheKey, snapshot);
  return snapshot;
}

function resolveDroneSalvageSnapshot(droneEntity, controllerEntity) {
  const context = getControllerDogmaContext(controllerEntity);
  const droneItem = resolveDroneDogmaItem(droneEntity);
  const typeID = toInt(droneItem && droneItem.typeID, 0);
  if (!context || typeID <= 0) {
    return null;
  }

  const cacheKey = buildDroneSnapshotCacheKey(droneEntity, droneItem);
  if (context.salvageByTypeID.has(cacheKey)) {
    return context.salvageByTypeID.get(cacheKey);
  }

  const effectRecord = resolveDroneEffectRecord(typeID, SALVAGE_EFFECT_NAMES);
  if (!effectRecord) {
    context.salvageByTypeID.set(cacheKey, null);
    return null;
  }

  const operational = buildDroneOperationalAttributes(droneItem, controllerEntity);
  if (!operational) {
    context.salvageByTypeID.set(cacheKey, null);
    return null;
  }

  const attributes = operational.attributes;
  const accessBonusPercent = Math.max(
    0,
    round6(toFiniteNumber(attributes[ATTRIBUTE_ACCESS_DIFFICULTY_BONUS], 0)),
  );
  if (accessBonusPercent <= 0) {
    context.salvageByTypeID.set(cacheKey, null);
    return null;
  }

  const durationMs = Math.max(
    1,
    round6(
      toFiniteNumber(
        attributes[ATTRIBUTE_DURATION],
        toFiniteNumber(attributes[ATTRIBUTE_SPEED], 1000),
      ),
    ),
  );
  const snapshot = {
    effectID: toInt(effectRecord.effectID, 0),
    effectName: String(effectRecord.name || ""),
    effectGUID: String(effectRecord.guid || ""),
    durationMs,
    accessBonusPercent,
    maxRangeMeters: Math.max(
      0,
      round6(toFiniteNumber(attributes[ATTRIBUTE_MAX_RANGE], 0)),
    ),
    orbitDistanceMeters: Math.max(
      0,
      round6(
        toFiniteNumber(
          attributes[ATTRIBUTE_ORBIT_RANGE],
          toFiniteNumber(attributes[ATTRIBUTE_ENTITY_FLY_RANGE], 500),
        ),
      ),
    ),
  };
  context.salvageByTypeID.set(cacheKey, snapshot);
  return snapshot;
}

function resolveDroneRepairSnapshot(droneEntity, controllerEntity) {
  const context = getControllerDogmaContext(controllerEntity);
  const droneItem = resolveDroneDogmaItem(droneEntity);
  const typeID = toInt(droneItem && droneItem.typeID, 0);
  if (!context || typeID <= 0) {
    return null;
  }

  const cacheKey = buildDroneSnapshotCacheKey(droneEntity, droneItem);
  if (context.repairByTypeID.has(cacheKey)) {
    return context.repairByTypeID.get(cacheKey);
  }

  const repairEffect = resolveDroneRepairEffectRecord(typeID);
  if (!repairEffect) {
    context.repairByTypeID.set(cacheKey, null);
    return null;
  }

  const operational = buildDroneOperationalAttributes(droneItem, controllerEntity);
  if (!operational) {
    context.repairByTypeID.set(cacheKey, null);
    return null;
  }

  const { effectRecord, definition } = repairEffect;
  const attributes = operational.attributes;
  const repairAmount = Math.max(
    0,
    round6(toFiniteNumber(attributes[definition.amountAttributeID], 0)),
  );
  if (repairAmount <= 0) {
    context.repairByTypeID.set(cacheKey, null);
    return null;
  }

  const durationMs = Math.max(
    1,
    round6(
      toFiniteNumber(
        attributes[effectRecord && effectRecord.durationAttributeID],
        toFiniteNumber(
          attributes[ATTRIBUTE_DURATION],
          toFiniteNumber(attributes[ATTRIBUTE_SPEED], 1000),
        ),
      ),
    ),
  );
  const maxRangeMeters = Math.max(
    0,
    round6(
      toFiniteNumber(
        attributes[effectRecord && effectRecord.rangeAttributeID],
        toFiniteNumber(attributes[ATTRIBUTE_MAX_RANGE], 0),
      ),
    ),
  );
  const orbitDistanceMeters = Math.max(
    0,
    round6(
      toFiniteNumber(
        attributes[ATTRIBUTE_ORBIT_RANGE],
        toFiniteNumber(attributes[ATTRIBUTE_ENTITY_FLY_RANGE], 500),
      ),
    ),
  );
  const attackRangeMeters = Math.max(
    orbitDistanceMeters,
    maxRangeMeters,
    round6(toFiniteNumber(attributes[ATTRIBUTE_ENTITY_ATTACK_RANGE], 0)),
  );
  const chaseRangeMeters = Math.max(
    attackRangeMeters,
    round6(toFiniteNumber(attributes[ATTRIBUTE_ENTITY_CHASE_MAX_DISTANCE], attackRangeMeters)),
  );
  const snapshot = {
    effectID: toInt(effectRecord.effectID, 0),
    effectName: String(effectRecord.name || ""),
    effectGUID: String(effectRecord.guid || ""),
    effectKind: "repair",
    repairFamily: definition.family,
    durationMs,
    maxRangeMeters,
    orbitDistanceMeters,
    attackRangeMeters,
    chaseRangeMeters,
    shieldBonusAmount:
      definition.family === "remoteShield" ? repairAmount : 0,
    armorRepairAmount:
      definition.family === "remoteArmor" ? repairAmount : 0,
    hullRepairAmount:
      definition.family === "remoteHull" ? repairAmount : 0,
  };
  context.repairByTypeID.set(cacheKey, snapshot);
  return snapshot;
}

module.exports = {
  beginDogmaTick,
  endDogmaTick,
  resolveDroneOperationalAttributes,
  resolveDroneCombatSnapshot,
  resolveDroneMiningSnapshot,
  resolveDroneSalvageSnapshot,
  resolveDroneRepairSnapshot,
  _testing: {
    getControllerDogmaContext,
    buildDamageVector,
    buildDroneSnapshotCacheKey,
    resolveDroneDogmaItem,
    sumDamageVector,
    buildControllerDogmaFingerprint,
  },
};
