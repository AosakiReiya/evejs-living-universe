"use strict";

const path = require("path");

const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../../services/inventory/itemTypeRegistry"));
const {
  buildShipResourceState,
  getShipBaseAttributeValue,
  getTypeAttributeValue,
  getRequiredSkillRequirements,
  getRequiredSlotFamily,
  getSlotFlagsForFamily,
  isChargeCompatibleWithModule,
  selectAutoFitFlagForType,
  typeHasEffectName,
  validateShipTypeOrGroupRestriction,
} = require(path.join(__dirname, "../../../services/fitting/liveFittingState"));

const EQUIPMENT_BANDS = Object.freeze({
  CIVILIAN: "civilian",
  STANDARD: "standard",
  VETERAN: "veteran",
  ELITE: "elite",
  NAMED: "named",
});

const GENERIC_RANDOM_LOOT_TABLE_ID = "generic_random_any";
const SPECIAL_META_GROUPS = new Map([
  [3, "storyline"],
  [4, "faction"],
  [5, "officer"],
  [6, "deadspace"],
  [14, "faction"],
  [15, "abyssal"],
]);
const SPECIAL_NAME_PATTERNS = Object.freeze([
  ["officer", /\bmodified\b|\bofficer\b/i],
  ["deadspace", /\b(?:a|b|c|x)-type\b|\bdeadspace\b/i],
  ["abyssal", /\bmutated\b|\babyssal\b/i],
]);
const NON_RECOVERABLE_FITTED_GROUP_IDS = new Set([
  588, // Super Weapon / doomsday modules are NPC capabilities, not ordinary salvage.
]);
const NON_RECOVERABLE_FITTED_NAME_PATTERN =
  /\bCONCORD\b|\bdoomsday\b|\bsuper\s*weapon\b|\bphenomena generator\b/i;
const LAW_ENFORCEMENT_RECORD_PATTERN =
  /(^|[_\s-])(concord|police|customs|law[_\s-]?enforcement|evermore)([_\s-]|$)/i;
const CAPITAL_RECORD_PATTERN = /(^|[_\s-])capital([_\s-]|$)/i;
const INDUSTRIAL_RECORD_PATTERN = /ore[_\s-]?mining|diamond[_\s-]?mining/i;
const ADVANCED_HOSTILE_RECORD_PATTERN = /(^|[_\s-])(trig|triglavian|drifter)([_\s-]|$)/i;
const SMALL_HULL_GROUP_IDS = new Set([25, 31, 237, 324, 420, 830, 831, 834, 893, 1527]);
const MEDIUM_HULL_GROUP_IDS = new Set([26, 358, 419, 463, 543, 832, 833, 894, 906, 1201]);
const LARGE_HULL_GROUP_IDS = new Set([27, 381, 898, 900]);
const INDUSTRIAL_HULL_GROUP_IDS = new Set([28, 380, 513, 902, 941, 1202, 1283]);
const HULL_T2_LIMITS = Object.freeze({
  small: 1,
  medium: 2,
  large: 3,
  industrial: 1,
  other: 1,
});
const SKILL_CATEGORY_ID = 16;
const DRONE_CATEGORY_ID = 18;
const DRONES_SKILL_TYPE_ID = 3436;
const MAX_STANDARD_ACTIVE_DRONES = 5;
const DEFENSE_TARGET_SIZE_CLASSES = new Set([
  "frigate",
  "destroyer",
  "cruiser",
  "battlecruiser",
  "battleship",
  "capital",
]);

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function clampProbability(value, fallback = 0) {
  const numeric = toFiniteNumber(value, fallback);
  return Math.max(0, Math.min(1, numeric));
}

function normalizeFittedModuleDropChances(value = {}, fallbackChance = 0) {
  const fallback = clampProbability(fallbackChance, 0);
  const source = value && typeof value === "object" ? value : {};
  return {
    techOne: clampProbability(source.techOne ?? source.t1, fallback),
    techTwo: clampProbability(source.techTwo ?? source.t2, fallback),
    specialGrade: clampProbability(source.specialGrade ?? source.special, 0),
  };
}

function buildNpcRecoveryRecordText(record = {}) {
  return [
    record.profileID,
    record.loadoutID,
    record.lootTableID,
    record.entityType,
    record.npcEntityType,
    record.npcRole,
    record.procurementPolicy,
    record.spawnGroupID,
    record.spawnSiteID,
    record.operatorKind,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ");
}

function resolveNativeNpcFittedModuleRecoveryPolicy(record = {}) {
  if (record && record.loadoutGoverned === true) {
    return {
      policyID: String(record.recoverabilityPolicyID || "governed_default"),
      source: "governed",
      protectedReason: null,
      dropChances: normalizeFittedModuleDropChances(
        record.fittedModuleDropChances,
        record.fittedModuleDropChance,
      ),
    };
  }

  const recordText = buildNpcRecoveryRecordText(record);
  const entityType = String(record && (record.npcEntityType || record.entityType) || "")
    .trim()
    .toLowerCase();
  const lawEnforcement = entityType === "concord" || LAW_ENFORCEMENT_RECORD_PATTERN.test(recordText);
  const capital = record && (
    record.capitalNpc === true ||
    String(record.capitalClassID || "").trim() ||
    CAPITAL_RECORD_PATTERN.test(recordText)
  );
  if (lawEnforcement || capital) {
    return {
      policyID: lawEnforcement
        ? "legacy_protected_law_enforcement"
        : "legacy_protected_capital",
      source: "legacy_fallback",
      protectedReason: lawEnforcement ? "law_enforcement" : "capital",
      dropChances: normalizeFittedModuleDropChances({
        techOne: 0,
        techTwo: 0,
        specialGrade: 0,
      }),
    };
  }

  if (INDUSTRIAL_RECORD_PATTERN.test(recordText)) {
    return {
      policyID: "legacy_industrial_conservative",
      source: "legacy_fallback",
      protectedReason: null,
      dropChances: normalizeFittedModuleDropChances({
        techOne: 0.2,
        techTwo: 0.03,
        specialGrade: 0,
      }),
    };
  }

  if (ADVANCED_HOSTILE_RECORD_PATTERN.test(recordText)) {
    return {
      policyID: "legacy_advanced_hostile",
      source: "legacy_fallback",
      protectedReason: null,
      dropChances: normalizeFittedModuleDropChances({
        techOne: 0.2,
        techTwo: 0.05,
        specialGrade: 0,
      }),
    };
  }

  return {
    policyID: "legacy_standard_npc",
    source: "legacy_fallback",
    protectedReason: null,
    dropChances: normalizeFittedModuleDropChances({
      techOne: 0.25,
      techTwo: 0.05,
      specialGrade: 0,
    }),
  };
}

function hashSeed(value) {
  const text = String(value ?? "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function createDeterministicRng(seed) {
  let state = hashSeed(seed) || 0x6d2b79f5;
  return function deterministicRandom() {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function chooseWeighted(entries, rng) {
  const candidates = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && toFiniteNumber(entry.weight, 0) > 0);
  if (candidates.length === 0) {
    return null;
  }
  const totalWeight = candidates.reduce(
    (total, entry) => total + toFiniteNumber(entry.weight, 0),
    0,
  );
  let roll = (typeof rng === "function" ? rng() : Math.random()) * totalWeight;
  for (const entry of candidates) {
    roll -= toFiniteNumber(entry.weight, 0);
    if (roll < 0) {
      return entry;
    }
  }
  return candidates[candidates.length - 1];
}

function resolveHullSizeClass(shipType) {
  const groupID = toPositiveInt(shipType && shipType.groupID, 0);
  if (SMALL_HULL_GROUP_IDS.has(groupID)) {
    return "small";
  }
  if (MEDIUM_HULL_GROUP_IDS.has(groupID)) {
    return "medium";
  }
  if (LARGE_HULL_GROUP_IDS.has(groupID)) {
    return "large";
  }
  if (INDUSTRIAL_HULL_GROUP_IDS.has(groupID)) {
    return "industrial";
  }
  return "other";
}

function classifyModuleType(typeID) {
  const itemType = resolveItemByTypeID(toPositiveInt(typeID, 0));
  if (!itemType) {
    return null;
  }

  const techLevel = Math.max(1, toPositiveInt(getTypeAttributeValue(itemType.typeID, "techLevel"), 1));
  const metaGroupID = toPositiveInt(getTypeAttributeValue(itemType.typeID, "metaGroupID"), 0);
  let specialGrade = SPECIAL_META_GROUPS.get(metaGroupID) || null;
  if (!specialGrade) {
    for (const [grade, pattern] of SPECIAL_NAME_PATTERNS) {
      if (pattern.test(String(itemType.name || ""))) {
        specialGrade = grade;
        break;
      }
    }
  }

  const techTwo = techLevel >= 2 || /\bII\b/.test(String(itemType.name || ""));
  const basePrice = Math.max(0, toFiniteNumber(itemType.basePrice, 0));
  const rarityScore = specialGrade
    ? 25
    : techTwo
      ? 4
      : 1;
  const priceScore = basePrice > 0
    ? Math.max(0, Math.log10(Math.max(1, basePrice)) - 3)
    : 0;

  return {
    itemType,
    typeID: itemType.typeID,
    name: String(itemType.name || ""),
    techLevel,
    metaGroupID,
    specialGrade,
    techTwo,
    rarityScore: rarityScore + priceScore,
    basePrice,
  };
}

function resolveBandPolicy(equipmentBand, hullSizeClass) {
  const normalizedBand = String(equipmentBand || "").trim().toLowerCase();
  const veteranLimit = HULL_T2_LIMITS[hullSizeClass] || HULL_T2_LIMITS.other;
  const policies = {
    [EQUIPMENT_BANDS.CIVILIAN]: {
      maxTechTwoModules: 0,
      allowSpecialGrade: false,
      maxRarityScore: 16,
    },
    [EQUIPMENT_BANDS.STANDARD]: {
      maxTechTwoModules: 0,
      allowSpecialGrade: false,
      maxRarityScore: 40,
    },
    [EQUIPMENT_BANDS.VETERAN]: {
      maxTechTwoModules: veteranLimit,
      allowSpecialGrade: false,
      maxRarityScore: 80,
    },
    [EQUIPMENT_BANDS.ELITE]: {
      maxTechTwoModules: Number.MAX_SAFE_INTEGER,
      allowSpecialGrade: false,
      maxRarityScore: 300,
    },
    [EQUIPMENT_BANDS.NAMED]: {
      maxTechTwoModules: Number.MAX_SAFE_INTEGER,
      allowSpecialGrade: true,
      maxRarityScore: Number.POSITIVE_INFINITY,
    },
  };
  return policies[normalizedBand] || null;
}

function expandAuthoredModules(modules) {
  const expanded = [];
  for (const moduleEntry of Array.isArray(modules) ? modules : []) {
    const explicitFlags = Array.isArray(moduleEntry && moduleEntry.flagIDs)
      ? moduleEntry.flagIDs
          .map((value) => toPositiveInt(value, 0))
          .filter((value) => value > 0)
      : (
        toPositiveInt(moduleEntry && moduleEntry.flagID, 0) > 0
          ? [toPositiveInt(moduleEntry.flagID, 0)]
          : []
      );
    const quantity = Math.max(
      1,
      toPositiveInt(moduleEntry && moduleEntry.quantity, 1),
      explicitFlags.length,
    );
    for (let index = 0; index < quantity; index += 1) {
      expanded.push({
        ...moduleEntry,
        typeID: toPositiveInt(moduleEntry && moduleEntry.typeID, 0),
        explicitFlagID: explicitFlags[index] || 0,
      });
    }
  }
  return expanded;
}

function normalizePilotSkillEntries(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      typeID: toPositiveInt(entry && entry.typeID, 0),
      level: Math.max(0, Math.min(5, Math.trunc(Number(entry && entry.level) || 0))),
      name: String(entry && entry.name || "").trim() || null,
    }))
    .filter((entry) => entry.typeID > 0 && entry.level > 0);
}

function normalizePositiveIntSelector(value, pluralKey, singularKey) {
  const source =
    value && Array.isArray(value[pluralKey])
      ? value[pluralKey]
      : (
        value && value[singularKey] !== undefined && value[singularKey] !== null
          ? [value[singularKey]]
          : []
      );
  return source
    .map((entry) => toPositiveInt(entry, 0))
    .filter((entry) => entry > 0);
}

function collectRequiredSkillClosure(typeIDs) {
  const requirements = new Map();
  const queue = (Array.isArray(typeIDs) ? typeIDs : [])
    .map((typeID) => toPositiveInt(typeID, 0))
    .filter((typeID) => typeID > 0);
  const inspectedTypeIDs = new Set();

  while (queue.length > 0) {
    const typeID = queue.shift();
    if (inspectedTypeIDs.has(typeID)) {
      continue;
    }
    inspectedTypeIDs.add(typeID);
    for (const requirement of getRequiredSkillRequirements(typeID)) {
      const skillTypeID = toPositiveInt(requirement && requirement.skillTypeID, 0);
      const level = Math.max(1, Math.min(5, toPositiveInt(requirement && requirement.level, 1)));
      if (skillTypeID <= 0) {
        continue;
      }
      requirements.set(
        skillTypeID,
        Math.max(level, requirements.get(skillTypeID) || 0),
      );
      queue.push(skillTypeID);
    }
  }

  return requirements;
}

function buildValidationFailure(errorMsg, data = {}) {
  return {
    success: false,
    errorMsg,
    data,
  };
}

function validateDoctrine(doctrine, options = {}) {
  if (!doctrine || typeof doctrine !== "object") {
    return buildValidationFailure("NPC_DOCTRINE_REQUIRED");
  }

  const doctrineID = String(doctrine.doctrineID || "").trim();
  const role = String(doctrine.role || "").trim().toLowerCase();
  const equipmentBand = String(doctrine.equipmentBand || doctrine.wealthBand || "")
    .trim()
    .toLowerCase();
  const shipTypeID = toPositiveInt(doctrine.shipTypeID, 0);
  if (!doctrineID) {
    return buildValidationFailure("NPC_DOCTRINE_ID_REQUIRED");
  }
  if (!role) {
    return buildValidationFailure("NPC_DOCTRINE_ROLE_REQUIRED", { doctrineID });
  }
  if (!shipTypeID) {
    return buildValidationFailure("NPC_DOCTRINE_SHIP_TYPE_REQUIRED", { doctrineID });
  }

  const shipType = resolveItemByTypeID(shipTypeID);
  if (!shipType) {
    return buildValidationFailure("NPC_DOCTRINE_SHIP_TYPE_NOT_FOUND", { doctrineID, shipTypeID });
  }
  const hullSizeClass = resolveHullSizeClass(shipType);
  const defaultBandPolicy = resolveBandPolicy(equipmentBand, hullSizeClass);
  if (!defaultBandPolicy) {
    return buildValidationFailure("NPC_DOCTRINE_EQUIPMENT_BAND_INVALID", {
      doctrineID,
      equipmentBand,
    });
  }
  const bandPolicy = {
    ...defaultBandPolicy,
    ...(options.bandPolicy && typeof options.bandPolicy === "object" ? options.bandPolicy : {}),
  };

  const modules = expandAuthoredModules(doctrine.modules);
  const classifications = [];
  const fittedItems = [];
  let techTwoModuleCount = 0;
  let specialGradeModuleCount = 0;
  let rarityScore = 0;
  let turretCount = 0;
  let launcherCount = 0;

  const shipItem = {
    itemID: -1,
    typeID: shipType.typeID,
    groupID: shipType.groupID,
    categoryID: shipType.categoryID,
    itemName: shipType.name,
  };

  for (let index = 0; index < modules.length; index += 1) {
    const moduleEntry = modules[index];
    const classification = classifyModuleType(moduleEntry.typeID);
    if (!classification) {
      return buildValidationFailure("NPC_DOCTRINE_MODULE_TYPE_NOT_FOUND", {
        doctrineID,
        typeID: moduleEntry.typeID,
      });
    }
    if (toPositiveInt(classification.itemType.categoryID, 0) !== 7) {
      return buildValidationFailure("NPC_DOCTRINE_NON_MODULE_IN_FIT", {
        doctrineID,
        typeID: classification.typeID,
        name: classification.name,
      });
    }

    if (classification.techTwo) {
      techTwoModuleCount += 1;
    }
    if (classification.specialGrade) {
      specialGradeModuleCount += 1;
    }
    rarityScore += classification.rarityScore;
    classifications.push(classification);

    if (classification.specialGrade && bandPolicy.allowSpecialGrade !== true) {
      return buildValidationFailure("NPC_DOCTRINE_SPECIAL_GRADE_FORBIDDEN", {
        doctrineID,
        equipmentBand,
        typeID: classification.typeID,
        name: classification.name,
        specialGrade: classification.specialGrade,
      });
    }

    const restrictionResult = validateShipTypeOrGroupRestriction(
      classification.typeID,
      shipItem,
    );
    if (!restrictionResult.success) {
      return buildValidationFailure("NPC_DOCTRINE_SHIP_RESTRICTION_FAILED", {
        doctrineID,
        typeID: classification.typeID,
        reason: restrictionResult.errorMsg,
      });
    }

    const explicitFlagID = toPositiveInt(moduleEntry && moduleEntry.explicitFlagID, 0);
    let flagID = explicitFlagID;
    if (explicitFlagID > 0) {
      const slotFamily = getRequiredSlotFamily(classification.typeID);
      const allowedFlags = slotFamily
        ? getSlotFlagsForFamily(slotFamily, shipTypeID)
        : [];
      if (!allowedFlags.includes(explicitFlagID)) {
        return buildValidationFailure("NPC_DOCTRINE_EXPLICIT_SLOT_INVALID", {
          doctrineID,
          typeID: classification.typeID,
          name: classification.name,
          flagID: explicitFlagID,
          slotFamily,
        });
      }
      if (fittedItems.some((item) => toPositiveInt(item && item.flagID, 0) === explicitFlagID)) {
        return buildValidationFailure("NPC_DOCTRINE_EXPLICIT_SLOT_OCCUPIED", {
          doctrineID,
          typeID: classification.typeID,
          name: classification.name,
          flagID: explicitFlagID,
        });
      }
    } else {
      flagID = selectAutoFitFlagForType(shipItem, fittedItems, classification.typeID);
    }
    if (!flagID) {
      return buildValidationFailure("NPC_DOCTRINE_NO_FREE_SLOT", {
        doctrineID,
        typeID: classification.typeID,
        name: classification.name,
      });
    }
    const fittedItem = {
      itemID: -1000 - index,
      ownerID: 0,
      locationID: -1,
      typeID: classification.typeID,
      groupID: classification.itemType.groupID,
      categoryID: classification.itemType.categoryID,
      itemName: classification.name,
      flagID,
      singleton: 1,
      stacksize: 1,
      quantity: -1,
      moduleState: {
        online: true,
        damage: 0,
        charge: 0,
        armorDamage: 0,
        shieldCharge: 0,
        incapacitated: false,
      },
    };
    fittedItems.push(fittedItem);

    if (typeHasEffectName(classification.typeID, "turretFitted")) {
      turretCount += 1;
    }
    if (typeHasEffectName(classification.typeID, "launcherFitted")) {
      launcherCount += 1;
    }
  }

  if (techTwoModuleCount > bandPolicy.maxTechTwoModules) {
    return buildValidationFailure("NPC_DOCTRINE_T2_LIMIT_EXCEEDED", {
      doctrineID,
      equipmentBand,
      hullSizeClass,
      techTwoModuleCount,
      maximum: bandPolicy.maxTechTwoModules,
    });
  }
  if (rarityScore > bandPolicy.maxRarityScore) {
    return buildValidationFailure("NPC_DOCTRINE_RARITY_BUDGET_EXCEEDED", {
      doctrineID,
      equipmentBand,
      rarityScore,
      maximum: bandPolicy.maxRarityScore,
    });
  }

  const turretHardpoints = Math.max(
    0,
    toPositiveInt(getShipBaseAttributeValue(shipTypeID, "turretSlotsLeft"), 0),
  );
  const launcherHardpoints = Math.max(
    0,
    toPositiveInt(getShipBaseAttributeValue(shipTypeID, "launcherSlotsLeft"), 0),
  );
  if (turretCount > turretHardpoints) {
    return buildValidationFailure("NPC_DOCTRINE_TURRET_LIMIT_EXCEEDED", {
      doctrineID,
      turretCount,
      turretHardpoints,
    });
  }
  if (launcherCount > launcherHardpoints) {
    return buildValidationFailure("NPC_DOCTRINE_LAUNCHER_LIMIT_EXCEEDED", {
      doctrineID,
      launcherCount,
      launcherHardpoints,
    });
  }

  const chargeBindings = [];
  const occupiedChargeFlags = new Set();
  const charges = Array.isArray(doctrine.charges) ? doctrine.charges : [];
  for (const chargeEntry of charges) {
    const chargeTypeID = toPositiveInt(chargeEntry && chargeEntry.typeID, 0);
    const chargeType = resolveItemByTypeID(chargeTypeID);
    if (!chargeType) {
      return buildValidationFailure("NPC_DOCTRINE_CHARGE_TYPE_NOT_FOUND", {
        doctrineID,
        typeID: chargeTypeID,
      });
    }

    const selectedFlagIDs = normalizePositiveIntSelector(
      chargeEntry,
      "moduleFlagIDs",
      "moduleFlagID",
    );
    const selectedTypeIDs = normalizePositiveIntSelector(
      chargeEntry,
      "moduleTypeIDs",
      "moduleTypeID",
    );
    const hasExplicitSelector =
      selectedFlagIDs.length > 0 ||
      selectedTypeIDs.length > 0;
    if (
      options.requireChargeSelectors === true &&
      !hasExplicitSelector
    ) {
      return buildValidationFailure("NPC_DOCTRINE_CHARGE_SELECTOR_REQUIRED", {
        doctrineID,
        typeID: chargeTypeID,
        name: chargeType.name,
      });
    }

    const selectedModules = fittedItems.filter((moduleItem) => (
      hasExplicitSelector
        ? (
            (selectedFlagIDs.length <= 0 ||
              selectedFlagIDs.includes(toPositiveInt(moduleItem.flagID, 0))) &&
            (selectedTypeIDs.length <= 0 ||
              selectedTypeIDs.includes(toPositiveInt(moduleItem.typeID, 0)))
          )
        : isChargeCompatibleWithModule(moduleItem.typeID, chargeTypeID)
    ));
    if (selectedModules.length <= 0) {
      return buildValidationFailure("NPC_DOCTRINE_CHARGE_SELECTOR_UNMATCHED", {
        doctrineID,
        typeID: chargeTypeID,
        name: chargeType.name,
        moduleFlagIDs: selectedFlagIDs,
        moduleTypeIDs: selectedTypeIDs,
      });
    }
    const incompatibleModule = hasExplicitSelector
      ? selectedModules.find((moduleItem) => (
          !isChargeCompatibleWithModule(moduleItem.typeID, chargeTypeID)
        ))
      : null;
    if (incompatibleModule) {
      return buildValidationFailure("NPC_DOCTRINE_CHARGE_INCOMPATIBLE", {
        doctrineID,
        typeID: chargeTypeID,
        name: chargeType.name,
        moduleTypeID: incompatibleModule.typeID,
        moduleFlagID: incompatibleModule.flagID,
      });
    }
    for (const moduleItem of selectedModules) {
      if (occupiedChargeFlags.has(moduleItem.flagID)) {
        return buildValidationFailure("NPC_DOCTRINE_MULTIPLE_CHARGES_PER_MODULE", {
          doctrineID,
          typeID: chargeTypeID,
          name: chargeType.name,
          moduleTypeID: moduleItem.typeID,
          moduleFlagID: moduleItem.flagID,
        });
      }
      occupiedChargeFlags.add(moduleItem.flagID);
      chargeBindings.push({
        chargeTypeID,
        moduleTypeID: moduleItem.typeID,
        moduleFlagID: moduleItem.flagID,
        quantityPerModule: Math.max(
          1,
          toPositiveInt(chargeEntry && chargeEntry.quantityPerModule, 1),
        ),
      });
    }
  }

  const droneBay = [];
  let droneBayVolumeM3 = 0;
  const droneQuantityByTypeID = new Map();
  for (const droneEntry of Array.isArray(doctrine.droneBay) ? doctrine.droneBay : []) {
    const droneTypeID = toPositiveInt(droneEntry && droneEntry.typeID, 0);
    const quantity = Math.max(1, toPositiveInt(droneEntry && droneEntry.quantity, 1));
    const droneType = resolveItemByTypeID(droneTypeID);
    if (!droneType) {
      return buildValidationFailure("NPC_DOCTRINE_DRONE_TYPE_NOT_FOUND", {
        doctrineID,
        typeID: droneTypeID,
      });
    }
    if (toPositiveInt(droneType.categoryID, 0) !== DRONE_CATEGORY_ID) {
      return buildValidationFailure("NPC_DOCTRINE_NON_DRONE_IN_BAY", {
        doctrineID,
        typeID: droneTypeID,
        name: droneType.name,
        categoryID: droneType.categoryID,
      });
    }
    const volumeM3 = Math.max(0, toFiniteNumber(droneType.volume, 0)) * quantity;
    const bandwidthPerDrone = Math.max(
      0,
      toFiniteNumber(
        getTypeAttributeValue(droneTypeID, "droneBandwidthUsed") ??
          getTypeAttributeValue(droneTypeID, "droneBandwidthLoad"),
        0,
      ),
    );
    droneBayVolumeM3 += volumeM3;
    droneQuantityByTypeID.set(
      droneTypeID,
      (droneQuantityByTypeID.get(droneTypeID) || 0) + quantity,
    );
    droneBay.push({
      ...droneEntry,
      typeID: droneTypeID,
      quantity,
      name: String(droneEntry && droneEntry.name || droneType.name || "").trim(),
      categoryID: droneType.categoryID,
      volumeM3,
      bandwidthPerDrone,
    });
  }

  const droneCapacityM3 = Math.max(
    0,
    toFiniteNumber(getShipBaseAttributeValue(shipTypeID, "droneCapacity"), 0),
  );
  const droneBandwidth = Math.max(
    0,
    toFiniteNumber(getShipBaseAttributeValue(shipTypeID, "droneBandwidth"), 0),
  );
  if (droneBayVolumeM3 > droneCapacityM3 + 1e-6) {
    return buildValidationFailure("NPC_DOCTRINE_DRONE_BAY_CAPACITY_EXCEEDED", {
      doctrineID,
      droneBayVolumeM3,
      droneCapacityM3,
    });
  }

  const defenseFlights = [];
  const authoredDefenseFlights = Array.isArray(doctrine.defenseFlights)
    ? doctrine.defenseFlights
    : [];
  if (
    options.requireDefenseFlightMetadata === true &&
    droneBay.length > 0 &&
    authoredDefenseFlights.length <= 0
  ) {
    return buildValidationFailure("NPC_DOCTRINE_DEFENSE_FLIGHT_REQUIRED", {
      doctrineID,
    });
  }
  for (const flightEntry of authoredDefenseFlights) {
    const flightID = String(flightEntry && flightEntry.flightID || "").trim();
    const droneTypeID = toPositiveInt(
      flightEntry && (flightEntry.droneTypeID || flightEntry.typeID),
      0,
    );
    const launchCount = Math.max(
      1,
      toPositiveInt(flightEntry && flightEntry.launchCount, 1),
    );
    if (!flightID) {
      return buildValidationFailure("NPC_DOCTRINE_DEFENSE_FLIGHT_ID_REQUIRED", {
        doctrineID,
      });
    }
    const bayEntry = droneBay.find((entry) => entry.typeID === droneTypeID) || null;
    if (!bayEntry || launchCount > (droneQuantityByTypeID.get(droneTypeID) || 0)) {
      return buildValidationFailure("NPC_DOCTRINE_DEFENSE_FLIGHT_INVENTORY_INVALID", {
        doctrineID,
        flightID,
        droneTypeID,
        launchCount,
        available: droneQuantityByTypeID.get(droneTypeID) || 0,
      });
    }
    if (launchCount > MAX_STANDARD_ACTIVE_DRONES) {
      return buildValidationFailure("NPC_DOCTRINE_DEFENSE_FLIGHT_COUNT_EXCEEDED", {
        doctrineID,
        flightID,
        launchCount,
        maximum: MAX_STANDARD_ACTIVE_DRONES,
      });
    }
    const flightBandwidth = bayEntry.bandwidthPerDrone * launchCount;
    if (flightBandwidth > droneBandwidth + 1e-6) {
      return buildValidationFailure("NPC_DOCTRINE_DRONE_BANDWIDTH_EXCEEDED", {
        doctrineID,
        flightID,
        flightBandwidth,
        droneBandwidth,
      });
    }
    const targetSizeClasses = (
      Array.isArray(flightEntry && flightEntry.targetSizeClasses)
        ? flightEntry.targetSizeClasses
        : []
    ).map((value) => String(value || "").trim().toLowerCase()).filter(Boolean);
    const invalidTargetSizeClass = targetSizeClasses.find(
      (value) => !DEFENSE_TARGET_SIZE_CLASSES.has(value),
    );
    if (invalidTargetSizeClass) {
      return buildValidationFailure("NPC_DOCTRINE_DEFENSE_TARGET_CLASS_INVALID", {
        doctrineID,
        flightID,
        targetSizeClass: invalidTargetSizeClass,
      });
    }
    defenseFlights.push({
      ...flightEntry,
      flightID,
      droneTypeID,
      launchCount,
      targetSizeClasses,
      flightBandwidth,
    });
  }

  const pilotSkills = normalizePilotSkillEntries(doctrine.pilotSkills);
  const pilotSkillLevels = new Map();
  for (const pilotSkill of pilotSkills) {
    const skillType = resolveItemByTypeID(pilotSkill.typeID);
    if (!skillType || toPositiveInt(skillType.categoryID, 0) !== SKILL_CATEGORY_ID) {
      return buildValidationFailure("NPC_DOCTRINE_PILOT_SKILL_TYPE_INVALID", {
        doctrineID,
        typeID: pilotSkill.typeID,
        name: pilotSkill.name,
      });
    }
    if (
      options.requirePilotSkillNameParity === true &&
      pilotSkill.name &&
      pilotSkill.name !== String(skillType.name || "").trim()
    ) {
      return buildValidationFailure("NPC_DOCTRINE_PILOT_SKILL_NAME_MISMATCH", {
        doctrineID,
        typeID: pilotSkill.typeID,
        authoredName: pilotSkill.name,
        expectedName: skillType.name,
      });
    }
    pilotSkillLevels.set(
      pilotSkill.typeID,
      Math.max(pilotSkill.level, pilotSkillLevels.get(pilotSkill.typeID) || 0),
    );
  }

  const requiredSkillLevels = collectRequiredSkillClosure([
    shipTypeID,
    ...fittedItems.map((item) => item.typeID),
    ...charges.map((entry) => toPositiveInt(entry && entry.typeID, 0)),
    ...droneBay.map((entry) => entry.typeID),
  ]);
  if (options.requirePilotSkills === true) {
    for (const [skillTypeID, requiredLevel] of requiredSkillLevels.entries()) {
      const trainedLevel = pilotSkillLevels.get(skillTypeID) || 0;
      if (trainedLevel < requiredLevel) {
        const skillType = resolveItemByTypeID(skillTypeID);
        return buildValidationFailure("NPC_DOCTRINE_PILOT_SKILL_INSUFFICIENT", {
          doctrineID,
          skillTypeID,
          skillName: skillType && skillType.name || null,
          requiredLevel,
          trainedLevel,
        });
      }
    }
    const maximumLaunchCount = defenseFlights.reduce(
      (maximum, flight) => Math.max(maximum, flight.launchCount),
      0,
    );
    const dronesSkillLevel = pilotSkillLevels.get(DRONES_SKILL_TYPE_ID) || 0;
    if (maximumLaunchCount > dronesSkillLevel) {
      return buildValidationFailure("NPC_DOCTRINE_DRONE_CONTROL_SKILL_INSUFFICIENT", {
        doctrineID,
        requiredLevel: maximumLaunchCount,
        trainedLevel: dronesSkillLevel,
      });
    }
  }

  const pilotSkillMap = new Map(pilotSkills.map((entry) => [
    entry.typeID,
    {
      typeID: entry.typeID,
      skillLevel: entry.level,
      trainedSkillLevel: entry.level,
      effectiveSkillLevel: entry.level,
    },
  ]));
  const resourceState = buildShipResourceState(0, shipItem, {
    fittedItems,
    skillMap: pilotSkillMap,
  });
  const cpuOutput = toFiniteNumber(resourceState && resourceState.cpuOutput, 0);
  const cpuLoad = toFiniteNumber(resourceState && resourceState.cpuLoad, 0);
  const powerOutput = toFiniteNumber(resourceState && resourceState.powerOutput, 0);
  const powerLoad = toFiniteNumber(resourceState && resourceState.powerLoad, 0);
  const upgradeCapacity = toFiniteNumber(resourceState && resourceState.upgradeCapacity, 0);
  const upgradeLoad = toFiniteNumber(resourceState && resourceState.upgradeLoad, 0);
  if (cpuOutput > 0 && cpuLoad > cpuOutput + 1e-6) {
    return buildValidationFailure("NPC_DOCTRINE_CPU_EXCEEDED", {
      doctrineID,
      cpuLoad,
      cpuOutput,
    });
  }
  if (powerOutput > 0 && powerLoad > powerOutput + 1e-6) {
    return buildValidationFailure("NPC_DOCTRINE_POWER_EXCEEDED", {
      doctrineID,
      powerLoad,
      powerOutput,
    });
  }
  if (upgradeCapacity > 0 && upgradeLoad > upgradeCapacity + 1e-6) {
    return buildValidationFailure("NPC_DOCTRINE_CALIBRATION_EXCEEDED", {
      doctrineID,
      upgradeLoad,
      upgradeCapacity,
    });
  }

  return {
    success: true,
    data: {
      doctrineID,
      role,
      equipmentBand,
      shipType,
      hullSizeClass,
      fittedItems,
      moduleClassifications: classifications,
      moduleCount: modules.length,
      techTwoModuleCount,
      specialGradeModuleCount,
      rarityScore,
      chargeBindings,
      droneBay,
      defenseFlights,
      droneBayVolumeM3,
      droneCapacityM3,
      droneBandwidth,
      pilotSkills,
      requiredPilotSkills: [...requiredSkillLevels.entries()].map(
        ([typeID, level]) => ({ typeID, level }),
      ),
      resourceState: {
        cpuLoad,
        cpuOutput,
        powerLoad,
        powerOutput,
        upgradeLoad,
        upgradeCapacity,
      },
    },
  };
}

function normalizeGovernance(governance = {}) {
  const fittedModuleDropChance = clampProbability(governance.fittedModuleDropChance, 0);
  const cargoSurvivalChance = clampProbability(governance.cargoSurvivalChance, 0.5);
  return {
    enabled: governance.enabled === true,
    doctrineID: String(governance.doctrineID || "").trim(),
    doctrineRevision: Math.max(1, toPositiveInt(governance.doctrineRevision, 1)),
    role: String(governance.role || "").trim().toLowerCase(),
    equipmentBand: String(governance.equipmentBand || governance.wealthBand || "")
      .trim()
      .toLowerCase(),
    procurementPolicy: String(governance.procurementPolicy || "corporation_issued").trim(),
    recoverabilityPolicyID: String(
      governance.recoverabilityPolicyID || "governed_default",
    ).trim(),
    validationProfile: String(governance.validationProfile || "").trim() || null,
    strictFitValidation: governance.strictFitValidation === true,
    fittedModuleDropChance,
    fittedModuleDropChances: normalizeFittedModuleDropChances(
      governance.fittedModuleDropChances,
      fittedModuleDropChance,
    ),
    cargoSurvivalChance,
    pilotSkills: normalizePilotSkillEntries(governance.pilotSkills),
  };
}

function validateGovernedNpcDefinition(definition) {
  const loadout = definition && definition.loadout && typeof definition.loadout === "object"
    ? definition.loadout
    : {};
  const governance = normalizeGovernance(loadout.governance || {});
  if (governance.enabled !== true) {
    return {
      success: true,
      data: {
        governed: false,
        governance,
      },
    };
  }

  const profile = definition && definition.profile && typeof definition.profile === "object"
    ? definition.profile
    : {};
  if (String(profile.lootTableID || "").trim() === GENERIC_RANDOM_LOOT_TABLE_ID) {
    return buildValidationFailure("NPC_GOVERNED_GENERIC_LOOT_FORBIDDEN", {
      profileID: profile.profileID || null,
      doctrineID: governance.doctrineID || null,
    });
  }

  const validation = validateDoctrine({
    doctrineID: governance.doctrineID,
    role: governance.role,
    equipmentBand: governance.equipmentBand,
    shipTypeID: toPositiveInt(profile.shipTypeID || profile.presentationTypeID, 0),
    modules: loadout.modules,
    charges: loadout.charges,
    droneBay: loadout.droneBay,
    defenseFlights: loadout.defenseFlights,
    pilotSkills: governance.pilotSkills,
  }, governance.strictFitValidation === true
    ? {
        requireChargeSelectors: true,
        requireDefenseFlightMetadata: true,
        requirePilotSkills: true,
        requirePilotSkillNameParity: true,
      }
    : {});
  if (!validation.success) {
    return validation;
  }
  return {
    success: true,
    data: {
      governed: true,
      governance,
      validation: validation.data,
    },
  };
}

function resolveCargoDestruction(cargoItems, options = {}) {
  const survivalChance = clampProbability(options.survivalChance, 1);
  const rng = typeof options.rng === "function"
    ? options.rng
    : createDeterministicRng(options.seed || "npc-cargo-destruction");
  const survivors = [];
  const destroyed = [];

  for (const sourceItem of Array.isArray(cargoItems) ? cargoItems : []) {
    if (!sourceItem) {
      continue;
    }
    const item = {
      ...sourceItem,
      quantity: Math.max(1, toPositiveInt(sourceItem.quantity, 1)),
    };
    if (rng() < survivalChance) {
      survivors.push(item);
    } else {
      destroyed.push(item);
    }
  }

  return {
    survivalChance,
    survivors,
    destroyed,
  };
}

function resolveFittedModuleDestruction(fittedItems, options = {}) {
  const dropChances = normalizeFittedModuleDropChances(
    options.dropChances,
    options.dropChance,
  );
  const rng = typeof options.rng === "function"
    ? options.rng
    : createDeterministicRng(options.seed || "npc-fitted-module-destruction");
  const dropped = [];
  const destroyed = [];

  for (const sourceItem of Array.isArray(fittedItems) ? fittedItems : []) {
    if (!sourceItem) {
      continue;
    }
    const classification = classifyModuleType(sourceItem.typeID);
    if (!classification) {
      destroyed.push({
        ...sourceItem,
        recoveryGrade: "unknown",
        dropChance: 0,
      });
      continue;
    }
    const itemName = String(classification.name || sourceItem.itemName || "");
    const groupID = toPositiveInt(
      classification.itemType && classification.itemType.groupID,
      toPositiveInt(sourceItem.groupID, 0),
    );
    const nonRecoverableReason = classification.specialGrade
      ? "special_grade"
      : NON_RECOVERABLE_FITTED_GROUP_IDS.has(groupID)
        ? "protected_group"
        : NON_RECOVERABLE_FITTED_NAME_PATTERN.test(itemName)
          ? "protected_type"
          : null;
    const recoveryGrade = classification.specialGrade
      ? "specialGrade"
      : classification.techTwo
        ? "techTwo"
        : "techOne";
    const dropChance = nonRecoverableReason ? 0 : dropChances[recoveryGrade];
    const resolvedItem = {
      ...sourceItem,
      recoveryGrade,
      dropChance,
      recoverable: nonRecoverableReason === null,
      nonRecoverableReason,
    };
    if (rng() < dropChance) {
      dropped.push(resolvedItem);
    } else {
      destroyed.push(resolvedItem);
    }
  }

  return {
    dropChances,
    dropped,
    destroyed,
  };
}

module.exports = {
  EQUIPMENT_BANDS,
  GENERIC_RANDOM_LOOT_TABLE_ID,
  classifyModuleType,
  chooseWeighted,
  collectRequiredSkillClosure,
  createDeterministicRng,
  hashSeed,
  normalizeFittedModuleDropChances,
  normalizeGovernance,
  resolveNativeNpcFittedModuleRecoveryPolicy,
  resolveBandPolicy,
  resolveCargoDestruction,
  resolveFittedModuleDestruction,
  resolveHullSizeClass,
  validateDoctrine,
  validateGovernedNpcDefinition,
};
