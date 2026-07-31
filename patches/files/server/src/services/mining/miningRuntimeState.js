const path = require("path");

const config = require(path.join(__dirname, "../../config"));
// Phase 0 / 0.C: mining runtime state via an ownership-scoped repository.
const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const repo = createTableRepository("service:mining", { strict: true });
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  resolveItemByName,
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  classifyMiningMaterialType,
} = require("./miningInventory");
const {
  computeAsteroidRadiusFromQuantity,
} = require("./miningMath");
const {
  resolveMiningVisualPresentation,
} = require("./miningVisuals");
const {
  flushMiningStartupSummary,
  mergeMiningPresentationSummary,
} = require("./miningStartupSummary");
const {
  applyMiningYieldRadiusCommand,
} = require(path.join(__dirname, "../../space/destiny/commands/mining.js"));
const {
  createVirtualMiningTransactionService,
} = require("./virtualMiningTransactions");

const MINING_RUNTIME_TABLE = "miningRuntimeState";
const MINING_RUNTIME_VERSION = 1;
const ASTEROID_DEPLETION_DESTRUCTION_EFFECT_ID = 2;
const WORMHOLE_SYSTEM_MIN = 31_000_000;
const WORMHOLE_SYSTEM_MAX = 31_999_999;
const ORE_GRADE_VARIANTS = Object.freeze([
  Object.freeze({
    suffix: "",
    weightMultiplier: 1,
    quantityMultiplier: 1,
  }),
  Object.freeze({
    suffix: " II-Grade",
    weightMultiplier: 0.45,
    quantityMultiplier: 1,
  }),
  Object.freeze({
    suffix: " III-Grade",
    weightMultiplier: 0.3,
    quantityMultiplier: 1,
  }),
  Object.freeze({
    suffix: " IV-Grade",
    weightMultiplier: 0.2,
    quantityMultiplier: 1,
  }),
]);
const DEFAULT_TEMPLATE_BY_FIELD_STYLE = Object.freeze({
  empire_highsec_standard: Object.freeze([
    { oreName: "Veldspar", weight: 5, quantityMultiplier: 1.2 },
    { oreName: "Scordite", weight: 4, quantityMultiplier: 1.15 },
    { oreName: "Pyroxeres", weight: 3, quantityMultiplier: 0.95 },
    { oreName: "Plagioclase", weight: 3, quantityMultiplier: 0.95 },
    { oreName: "Omber", weight: 2, quantityMultiplier: 0.75 },
    { oreName: "Kernite", weight: 1, quantityMultiplier: 0.65 },
  ]),
  empire_lowsec_standard: Object.freeze([
    { oreName: "Kernite", weight: 4, quantityMultiplier: 1.1 },
    { oreName: "Omber", weight: 3, quantityMultiplier: 1.0 },
    { oreName: "Jaspet", weight: 3, quantityMultiplier: 0.9 },
    { oreName: "Hemorphite", weight: 2, quantityMultiplier: 0.8 },
    { oreName: "Hedbergite", weight: 2, quantityMultiplier: 0.8 },
  ]),
  nullsec_standard: Object.freeze([
    { oreName: "Spodumain", weight: 4, quantityMultiplier: 1.0 },
    { oreName: "Gneiss", weight: 3, quantityMultiplier: 0.9 },
    { oreName: "Dark Ochre", weight: 3, quantityMultiplier: 0.85 },
    { oreName: "Crokite", weight: 3, quantityMultiplier: 0.8 },
    { oreName: "Bistot", weight: 2, quantityMultiplier: 0.75 },
    { oreName: "Arkonor", weight: 2, quantityMultiplier: 0.7 },
    { oreName: "Mercoxit", weight: 1, quantityMultiplier: 0.5 },
  ]),
  wormhole_standard: Object.freeze([
    { oreName: "Gneiss", weight: 4, quantityMultiplier: 1.0 },
    { oreName: "Spodumain", weight: 3, quantityMultiplier: 0.95 },
    { oreName: "Dark Ochre", weight: 3, quantityMultiplier: 0.9 },
    { oreName: "Crokite", weight: 2, quantityMultiplier: 0.8 },
    { oreName: "Bistot", weight: 2, quantityMultiplier: 0.75 },
    { oreName: "Arkonor", weight: 2, quantityMultiplier: 0.7 },
  ]),
});

let cachedTemplateEntries = null;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeLowerText(value, fallback = "") {
  return normalizeText(value, fallback).toLowerCase();
}

function buildMarshalDict(entries = []) {
  return {
    type: "dict",
    entries,
  };
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function clamp(value, minimum, maximum) {
  return Math.min(
    Math.max(toFiniteNumber(value, minimum), minimum),
    maximum,
  );
}

function isWormholeSystemID(systemID) {
  const normalizedSystemID = toInt(systemID, 0);
  return (
    normalizedSystemID >= WORMHOLE_SYSTEM_MIN &&
    normalizedSystemID <= WORMHOLE_SYSTEM_MAX
  );
}

function normalizeStateRecord(record = {}) {
  return {
    version: MINING_RUNTIME_VERSION,
    revision: Math.max(0, toInt(record.revision, 0)),
    entityID: toInt(record.entityID, 0),
    visualTypeID: toInt(record.visualTypeID, 0),
    beltID: toInt(record.beltID, 0),
    fieldStyleID: String(record.fieldStyleID || "").trim() || null,
    yieldTypeID: toInt(record.yieldTypeID, 0),
    yieldKind: String(record.yieldKind || "").trim().toLowerCase() || null,
    unitVolume: Math.max(0.000001, toFiniteNumber(record.unitVolume, 1)),
    originalQuantity: Math.max(0, toInt(record.originalQuantity, 0)),
    remainingQuantity: Math.max(0, toInt(record.remainingQuantity, 0)),
    originalRadius: Math.max(1, toFiniteNumber(record.originalRadius, 1)),
    updatedAtMs: Math.max(0, toInt(record.updatedAtMs, Date.now())),
  };
}

function isPersistedStateStillValid(scene, entity, persistedState, estimatedOriginalQuantity) {
  if (!persistedState || !entity) {
    return false;
  }

  if (toInt(persistedState.entityID, 0) !== toInt(entity.itemID, 0)) {
    return false;
  }
  if (
    toInt(entity.beltID, 0) > 0 &&
    toInt(persistedState.beltID, 0) > 0 &&
    toInt(persistedState.beltID, 0) !== toInt(entity.beltID, 0)
  ) {
    return false;
  }

  const persistedFieldStyleID = String(persistedState.fieldStyleID || "").trim();
  const entityFieldStyleID = String(entity.fieldStyleID || "").trim();
  if (persistedFieldStyleID && entityFieldStyleID && persistedFieldStyleID !== entityFieldStyleID) {
    return false;
  }
  if (toInt(persistedState.visualTypeID, 0) <= 0) {
    return false;
  }

  const entityRadius = Math.max(0, toFiniteNumber(entity.radius, 0));
  if (entityRadius > 50 && toFiniteNumber(persistedState.originalRadius, 0) <= 1) {
    return false;
  }
  if (
    estimatedOriginalQuantity >= 100 &&
    Math.max(0, toInt(persistedState.originalQuantity, 0)) <= 1
  ) {
    return false;
  }

  return true;
}

function buildTemplateEntries() {
  const entriesByFieldStyle = new Map();
  for (const [fieldStyleID, definitions] of Object.entries(DEFAULT_TEMPLATE_BY_FIELD_STYLE)) {
    const entries = definitions
      .flatMap((definition) => buildTemplateEntriesForOreDefinition(definition))
      .filter(Boolean);
    entriesByFieldStyle.set(fieldStyleID, entries);
  }
  return entriesByFieldStyle;
}

function buildTemplateEntriesForOreDefinition(definition) {
  const baseOreName = String(definition && definition.oreName || "").trim();
  if (!baseOreName) {
    return [];
  }

  const baseWeight = Math.max(0.000001, toFiniteNumber(definition && definition.weight, 1));
  const baseQuantityMultiplier = Math.max(
    0.1,
    toFiniteNumber(definition && definition.quantityMultiplier, 1),
  );
  const entries = [];
  const seenTypeIDs = new Set();
  for (const gradeVariant of ORE_GRADE_VARIANTS) {
    const oreName = `${baseOreName}${gradeVariant.suffix}`;
    const lookup = resolveItemByName(oreName);
    if (!lookup.success || !lookup.match) {
      continue;
    }

    const classification = classifyMiningMaterialType(lookup.match);
    if (!classification || classification.kind !== "ore") {
      continue;
    }

    const typeID = toInt(lookup.match.typeID, 0);
    if (typeID <= 0 || seenTypeIDs.has(typeID)) {
      continue;
    }
    seenTypeIDs.add(typeID);

    entries.push({
      typeID,
      typeRecord: lookup.match,
      baseOreName,
      oreName,
      gradeSuffix: gradeVariant.suffix || null,
      weight: Math.max(0.000001, baseWeight * gradeVariant.weightMultiplier),
      quantityMultiplier: Math.max(
        0.1,
        baseQuantityMultiplier * gradeVariant.quantityMultiplier,
      ),
    });
  }

  return entries;
}

function getTemplateEntries() {
  if (!cachedTemplateEntries) {
    cachedTemplateEntries = buildTemplateEntries();
  }
  return cachedTemplateEntries;
}

function getTemplateEntriesForFieldStyle(fieldStyleID) {
  return getTemplateEntries().get(String(fieldStyleID || "").trim()) || [];
}

function hashInteger(value) {
  let hash = toInt(value, 0) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function pickWeightedTemplateEntry(entity, entries) {
  const normalizedEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (normalizedEntries.length <= 0) {
    return null;
  }

  const totalWeight = normalizedEntries.reduce(
    (sum, entry) => sum + Math.max(0, toFiniteNumber(entry.weight, 0)),
    0,
  );
  if (totalWeight <= 0) {
    return normalizedEntries[0] || null;
  }

  const seed =
    hashInteger(toInt(entity && entity.itemID, 0)) ^
    hashInteger(toInt(entity && entity.beltID, 0)) ^
    hashInteger(String(entity && entity.fieldStyleID || "").length * 8191);
  let cursor = (seed / 0xffffffff) * totalWeight;
  for (const entry of normalizedEntries) {
    cursor -= Math.max(0, toFiniteNumber(entry.weight, 0));
    if (cursor <= 0) {
      return entry;
    }
  }
  return normalizedEntries[normalizedEntries.length - 1] || null;
}

function isDecorativeAsteroidType(typeRecord) {
  const groupName = String(typeRecord && typeRecord.groupName || "").toLowerCase();
  const typeName = String(typeRecord && typeRecord.name || "").toLowerCase();
  return (
    groupName.includes("decorative asteroid") ||
    groupName.includes("phased asteroid") ||
    typeName.startsWith("cosmetic asteroid") ||
    typeName.startsWith("phased ")
  );
}

function resolveDirectYieldType(entity) {
  const candidateTypeIDs = [
    toInt(entity && entity.miningYieldTypeID, 0),
    toInt(entity && entity.slimTypeID, 0),
    toInt(entity && entity.typeID, 0),
  ].filter((value, index, array) => value > 0 && array.indexOf(value) === index);

  for (const candidateTypeID of candidateTypeIDs) {
    const typeRecord = resolveItemByTypeID(candidateTypeID) || null;
    if (!typeRecord) {
      continue;
    }
    if (!isDecorativeAsteroidType(typeRecord)) {
      const classification = classifyMiningMaterialType(typeRecord);
      if (classification) {
        return classification.typeRecord;
      }
    }

    const phasedMatch = /^phased\s+(.+)$/i.exec(String(typeRecord.name || "").trim());
    if (phasedMatch) {
      const lookup = resolveItemByName(phasedMatch[1]);
      if (lookup.success && lookup.match) {
        const classification = classifyMiningMaterialType(lookup.match);
        if (classification) {
          return classification.typeRecord;
        }
      }
    }
  }

  return null;
}

function resolveTemplateSetForEntity(scene, entity) {
  const fieldStyleID = String(entity && entity.fieldStyleID || "").trim();
  if (fieldStyleID) {
    const entries = getTemplateEntriesForFieldStyle(fieldStyleID);
    if (entries.length > 0) {
      return entries;
    }
  }

  const systemRecord = worldData.getSolarSystemByID(scene && scene.systemID);
  const securityStatus = toFiniteNumber(
    systemRecord && (systemRecord.securityStatus ?? systemRecord.security),
    0,
  );
  if (isWormholeSystemID(scene && scene.systemID)) {
    return getTemplateEntriesForFieldStyle("wormhole_standard");
  }
  if (securityStatus >= 0.45) {
    return getTemplateEntriesForFieldStyle("empire_highsec_standard");
  }
  if (securityStatus >= 0) {
    return getTemplateEntriesForFieldStyle("empire_lowsec_standard");
  }
  return getTemplateEntriesForFieldStyle("nullsec_standard");
}

function resolveYieldTypeForEntity(scene, entity) {
  const directType = resolveDirectYieldType(entity);
  if (directType) {
    return directType;
  }

  const templateEntry = pickWeightedTemplateEntry(
    entity,
    resolveTemplateSetForEntity(scene, entity),
  );
  return templateEntry ? templateEntry.typeRecord : null;
}

function estimateOriginalQuantity(scene, entity, yieldType, templateEntry = null) {
  const explicitQuantity = Math.max(
    0,
    toInt(
      entity &&
        (
          entity.resourceQuantity ??
          entity.mineableQuantity ??
          entity.originalQuantity
        ),
      0,
    ),
  );
  if (explicitQuantity > 0) {
    return explicitQuantity;
  }

  const unitVolume = Math.max(0.000001, toFiniteNumber(yieldType && yieldType.volume, 1));
  const quantityScale = Math.max(
    0.000001,
    toFiniteNumber(config.miningBeltQuantityScale, 0.08),
  );
  const quantityMultiplier = Math.max(
    0.1,
    toFiniteNumber(templateEntry && templateEntry.quantityMultiplier, 1),
  );
  const minimumVolume = Math.max(
    1,
    toFiniteNumber(config.miningBeltMinimumAsteroidVolumeM3, 15_000),
  );
  const maximumVolume = Math.max(
    minimumVolume,
    toFiniteNumber(config.miningBeltMaximumAsteroidVolumeM3, 3_000_000),
  );
  const estimatedVolume = clamp(
    (toFiniteNumber(entity && entity.radius, 0) ** 2) * quantityScale * quantityMultiplier,
    minimumVolume,
    maximumVolume,
  );
  return Math.max(1, Math.round(estimatedVolume / unitVolume));
}

function createMiningPresentationSummary(systemID) {
  return {
    systemID: toInt(systemID, 0),
    updatedCount: 0,
    oreCount: 0,
    iceCount: 0,
    gasCount: 0,
    otherCount: 0,
    oreRemainingQuantity: 0,
    iceRemainingQuantity: 0,
    gasRemainingQuantity: 0,
    otherRemainingQuantity: 0,
    withGraphicCount: 0,
  };
}

function recordMiningPresentationSummary(summary, entity, state) {
  if (!summary || !state) {
    return;
  }

  summary.updatedCount += 1;
  const remainingQuantity = Math.max(0, toInt(state.remainingQuantity, 0));
  const yieldKind = String(state.yieldKind || "").trim().toLowerCase();

  if (yieldKind === "ice") {
    summary.iceCount += 1;
    summary.iceRemainingQuantity += remainingQuantity;
  } else if (yieldKind === "gas") {
    summary.gasCount += 1;
    summary.gasRemainingQuantity += remainingQuantity;
  } else if (yieldKind === "ore") {
    summary.oreCount += 1;
    summary.oreRemainingQuantity += remainingQuantity;
  } else {
    summary.otherCount += 1;
    summary.otherRemainingQuantity += remainingQuantity;
  }

  if (
    toInt(entity && entity.graphicID, 0) > 0 ||
    toInt(entity && entity.slimGraphicID, 0) > 0
  ) {
    summary.withGraphicCount += 1;
  }
}

function logMiningPresentationSummary(scene, summary) {
  if (!scene || !summary) {
    return;
  }

  mergeMiningPresentationSummary(scene, summary);
  flushMiningStartupSummary(scene);
}

function applyYieldPresentationToEntity(entity, state, summary = null) {
  if (!entity || !state) {
    return;
  }

  const yieldTypeRecord = resolveItemByTypeID(toInt(state.yieldTypeID, 0)) || null;
  const resolvedPresentation =
    typeof resolveMiningVisualPresentation === "function" && yieldTypeRecord
      ? (() => {
          try {
            return resolveMiningVisualPresentation(yieldTypeRecord, {
              entityID: toInt(entity && entity.itemID, 0),
              radius: state.originalRadius || entity.radius,
            });
          } catch (_error) {
            return null;
          }
        })()
      : null;

  const preferredVisualTypeID = toInt(
    state.visualTypeID ||
      (resolvedPresentation && resolvedPresentation.visualTypeID) ||
      entity.visualTypeID ||
      entity.typeID,
    0,
  );
  const spaceTypeRecord = resolveItemByTypeID(preferredVisualTypeID) || null;
  if (preferredVisualTypeID > 0) {
    entity.visualTypeID = preferredVisualTypeID;
  }
  if (spaceTypeRecord) {
    entity.typeID = spaceTypeRecord.typeID;
    entity.groupID = spaceTypeRecord.groupID;
    entity.categoryID = spaceTypeRecord.categoryID;
  }

  if (yieldTypeRecord) {
    entity.miningYieldTypeID = yieldTypeRecord.typeID;
    entity.miningYieldKind = state.yieldKind || null;
    entity.slimTypeID = yieldTypeRecord.typeID;
    entity.slimGroupID = yieldTypeRecord.groupID;
    entity.slimCategoryID = yieldTypeRecord.categoryID;
    if (entity.suppressSlimName !== true) {
      entity.itemName = yieldTypeRecord.name;
      entity.slimName = yieldTypeRecord.name;
    }
  } else if (spaceTypeRecord) {
    entity.slimTypeID = spaceTypeRecord.typeID;
    entity.slimGroupID = spaceTypeRecord.groupID;
    entity.slimCategoryID = spaceTypeRecord.categoryID;
    if (entity.suppressSlimName !== true) {
      entity.itemName = spaceTypeRecord.name;
      entity.slimName = spaceTypeRecord.name;
    }
  }

  const resolvedGraphicID = toInt(
    (resolvedPresentation && resolvedPresentation.graphicID) ||
      entity.graphicID ||
      entity.slimGraphicID,
    0,
  );
  if (resolvedGraphicID > 0) {
    entity.graphicID = resolvedGraphicID;
    entity.slimGraphicID = resolvedGraphicID;
  }

  if (state.remainingQuantity > 0) {
    const minimumRadiusRatio = Math.max(
      0.01,
      toFiniteNumber(config.miningDepletedAsteroidRadiusRatio, 0.25),
    );
    const minimumRuntimeRadius = Math.max(1, state.originalRadius * minimumRadiusRatio);
    const computedRadius = computeAsteroidRadiusFromQuantity(
      state.yieldTypeID,
      state.remainingQuantity,
      {
        unitVolume: state.unitVolume,
        fallbackScale: Math.max(
          0.000001,
          toFiniteNumber(config.miningBeltQuantityScale, 0.08),
        ),
        fallbackMinRadius: Math.max(250, state.originalRadius * 0.2),
        fallbackMaxRadius: Math.max(state.originalRadius, entity.radius),
      },
    );
    applyMiningYieldRadiusCommand(
      entity,
      clamp(
        computedRadius,
        minimumRuntimeRadius,
        Math.max(minimumRuntimeRadius, state.originalRadius),
      ),
    );
  }
  recordMiningPresentationSummary(summary, entity, state);
}

function resolveDepletionDestructionEffectID(entity, state) {
  const kind = String(entity && entity.kind || "").trim().toLowerCase();
  const yieldKind = String(state && state.yieldKind || "").trim().toLowerCase();
  if (kind === "asteroid" || yieldKind === "ore") {
    return ASTEROID_DEPLETION_DESTRUCTION_EFFECT_ID;
  }
  return 0;
}

function shouldPersistMineableState(entity) {
  if (!entity) {
    return false;
  }
  return !(
    entity.dungeonMaterializedSiteContent === true ||
    entity.dungeonSiteContentMissionObjectiveTarget === true ||
    toInt(entity.dungeonSiteInstanceID, 0) > 0
  );
}

function isGeneratedIceMineableEntity(entity) {
  return Boolean(
    entity &&
      entity.generatedMiningSite === true &&
      entity.generatedMiningSiteAnchor !== true &&
      normalizeLowerText(entity.generatedMiningSiteKind, "") === "ice" &&
      toInt(entity.itemID, 0) > 0
  );
}

function buildSceneCache(scene, persistedByEntityID = {}) {
  return {
    version: MINING_RUNTIME_VERSION,
    persistedByEntityID,
    byEntityID: new Map(),
  };
}

function readPersistedSystemState(systemID) {
  const result = repo.read(
    MINING_RUNTIME_TABLE,
    `/systems/${String(toInt(systemID, 0))}/entities`,
  );
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {};
  }
  return result.data;
}

function areMiningStatesEquivalent(left, right) {
  if (!left || !right) {
    return false;
  }
  return (
    toInt(left.entityID, 0) === toInt(right.entityID, 0) &&
    toInt(left.visualTypeID, 0) === toInt(right.visualTypeID, 0) &&
    toInt(left.beltID, 0) === toInt(right.beltID, 0) &&
    String(left.fieldStyleID || "").trim() === String(right.fieldStyleID || "").trim() &&
    toInt(left.yieldTypeID, 0) === toInt(right.yieldTypeID, 0) &&
    String(left.yieldKind || "").trim().toLowerCase() === String(right.yieldKind || "").trim().toLowerCase() &&
    Math.abs(toFiniteNumber(left.unitVolume, 0) - toFiniteNumber(right.unitVolume, 0)) < 0.000001 &&
    toInt(left.originalQuantity, 0) === toInt(right.originalQuantity, 0) &&
    toInt(left.remainingQuantity, 0) === toInt(right.remainingQuantity, 0) &&
    toInt(left.revision, 0) === toInt(right.revision, 0) &&
    Math.abs(toFiniteNumber(left.originalRadius, 0) - toFiniteNumber(right.originalRadius, 0)) < 0.000001
  );
}

function writePersistedState(scene, state, options = {}) {
  const existingPersistedState = options && options.existingPersistedState
    ? normalizeStateRecord(options.existingPersistedState)
    : null;
  const shouldPersistBaseline = options && options.persistBaseline === true;
  if (
    !shouldPersistBaseline &&
    !existingPersistedState &&
    toInt(state && state.remainingQuantity, 0) === toInt(state && state.originalQuantity, 0)
  ) {
    return false;
  }
  if (existingPersistedState && areMiningStatesEquivalent(existingPersistedState, state)) {
    return false;
  }

  repo.write(
    MINING_RUNTIME_TABLE,
    `/systems/${String(toInt(scene && scene.systemID, 0))}/entities/${String(toInt(state && state.entityID, 0))}`,
    cloneValue(state),
  );
  const persistedByEntityID =
    (options && options.persistedByEntityID && typeof options.persistedByEntityID === "object")
      ? options.persistedByEntityID
      : (
          scene &&
          scene._miningRuntimeState &&
          scene._miningRuntimeState.persistedByEntityID &&
          typeof scene._miningRuntimeState.persistedByEntityID === "object"
            ? scene._miningRuntimeState.persistedByEntityID
            : null
        );
  if (persistedByEntityID) {
    persistedByEntityID[String(toInt(state && state.entityID, 0))] = cloneValue(state);
  }
  return true;
}

function removePersistedState(scene, entityID) {
  const systemID = toInt(scene && scene.systemID, 0);
  const normalizedEntityID = toInt(entityID, 0);
  if (systemID <= 0 || normalizedEntityID <= 0) {
    return false;
  }

  const removeResult = repo.remove(
    MINING_RUNTIME_TABLE,
    `/systems/${String(systemID)}/entities/${String(normalizedEntityID)}`,
  );
  const persistedByEntityID =
    scene &&
    scene._miningRuntimeState &&
    scene._miningRuntimeState.persistedByEntityID &&
    typeof scene._miningRuntimeState.persistedByEntityID === "object"
      ? scene._miningRuntimeState.persistedByEntityID
      : null;
  if (persistedByEntityID) {
    delete persistedByEntityID[String(normalizedEntityID)];
  }
  return Boolean(removeResult && (
    removeResult.success === true ||
    removeResult.errorMsg === "ENTRY_NOT_FOUND"
  ));
}

// ── Generated-system-entity owner API (Phase 0 / 0.C) ────────────────
// Lets another domain (e.g. dungeon-universe site seeding) reconcile the
// generated mining entities it spawns WITHOUT writing miningRuntimeState
// directly. The table I/O stays inside its owning module; callers pass plain
// systemID/entityID and receive plain data/booleans.
function readPersistedSystemEntities(systemID) {
  const normalizedSystemID = toInt(systemID, 0);
  if (normalizedSystemID <= 0) {
    return {};
  }
  const readResult = repo.read(
    MINING_RUNTIME_TABLE,
    `/systems/${String(normalizedSystemID)}/entities`,
  );
  return (
    readResult &&
    readResult.success &&
    readResult.data &&
    typeof readResult.data === "object"
  )
    ? readResult.data
    : {};
}

function writePersistedSystemEntity(systemID, entityID, state) {
  const normalizedSystemID = toInt(systemID, 0);
  const normalizedEntityID = toInt(entityID, 0);
  if (normalizedSystemID <= 0 || normalizedEntityID <= 0) {
    return false;
  }
  const writeResult = repo.write(
    MINING_RUNTIME_TABLE,
    `/systems/${String(normalizedSystemID)}/entities/${String(normalizedEntityID)}`,
    cloneValue(state),
  );
  return Boolean(writeResult && writeResult.success === true);
}

function removePersistedSystemEntity(systemID, entityID) {
  const normalizedSystemID = toInt(systemID, 0);
  const normalizedEntityID = toInt(entityID, 0);
  if (normalizedSystemID <= 0 || normalizedEntityID <= 0) {
    return false;
  }
  const removeResult = repo.remove(
    MINING_RUNTIME_TABLE,
    `/systems/${String(normalizedSystemID)}/entities/${String(normalizedEntityID)}`,
  );
  return Boolean(removeResult && removeResult.success === true);
}

function buildMineableState(scene, entity, persistedState = null) {
  const rawPersistedState = persistedState
    ? normalizeStateRecord(persistedState)
    : null;
  const templateEntry = pickWeightedTemplateEntry(
    entity,
    resolveTemplateSetForEntity(scene, entity),
  );
  const yieldType =
    resolveItemByTypeID(
      toInt(rawPersistedState && rawPersistedState.yieldTypeID, 0),
    ) ||
    resolveYieldTypeForEntity(scene, entity);
  const classification = classifyMiningMaterialType(yieldType);
  if (!yieldType || !classification) {
    return null;
  }
  const estimatedOriginalQuantity = estimateOriginalQuantity(
    scene,
    entity,
    yieldType,
    templateEntry,
  );
  const normalizedPersistedState = isPersistedStateStillValid(
    scene,
    entity,
    rawPersistedState,
    estimatedOriginalQuantity,
  )
    ? rawPersistedState
    : null;

  const originalRadius = Math.max(
    1,
    toFiniteNumber(
      normalizedPersistedState
        ? normalizedPersistedState.originalRadius
        : undefined,
      entity && entity.radius,
    ),
  );
  const originalQuantity = Math.max(
    1,
    toInt(
      normalizedPersistedState
        ? normalizedPersistedState.originalQuantity
        : undefined,
      estimatedOriginalQuantity,
    ),
  );
  const remainingQuantity = clamp(
    toInt(
      normalizedPersistedState
        ? normalizedPersistedState.remainingQuantity
        : undefined,
      originalQuantity,
    ),
    0,
    originalQuantity,
  );

  return normalizeStateRecord({
    entityID: entity.itemID,
    visualTypeID: toInt(
      normalizedPersistedState
        ? normalizedPersistedState.visualTypeID
        : undefined,
      entity.visualTypeID || entity.typeID,
    ),
    beltID: entity.beltID,
    fieldStyleID: entity.fieldStyleID || null,
    yieldTypeID: yieldType.typeID,
    yieldKind: classification.kind,
    unitVolume: Math.max(0.000001, toFiniteNumber(yieldType.volume, 1)),
    originalQuantity,
    remainingQuantity,
    originalRadius,
    updatedAtMs: normalizedPersistedState
      ? toInt(normalizedPersistedState.updatedAtMs, Date.now())
      : Date.now(),
  });
}

function isMineableStaticEntity(entity) {
  if (!entity || toInt(entity.itemID, 0) <= 0) {
    return false;
  }
  if (entity.generatedMiningSiteAnchor === true) {
    return false;
  }
  if (String(entity.kind || "").toLowerCase() === "asteroid") {
    return true;
  }

  const typeRecord = resolveItemByTypeID(toInt(entity.typeID, 0)) || null;
  return Boolean(typeRecord && (classifyMiningMaterialType(typeRecord) || isDecorativeAsteroidType(typeRecord)));
}

function ensureSceneMiningState(scene) {
  if (!scene) {
    return null;
  }
  if (scene._miningRuntimeState) {
    return scene._miningRuntimeState;
  }

  const persistedByEntityID = readPersistedSystemState(scene.systemID);
  const cache = buildSceneCache(scene, persistedByEntityID);
  const presentationSummary = createMiningPresentationSummary(scene.systemID);

  for (const entity of [...(scene.staticEntities || [])]) {
    if (!isMineableStaticEntity(entity)) {
      continue;
    }

    entity.systemID = toInt(scene && scene.systemID, 0);
    const persistState = shouldPersistMineableState(entity);
    const persistedState = persistState
      ? persistedByEntityID[String(toInt(entity.itemID, 0))] || null
      : null;
    const state = buildMineableState(scene, entity, persistedState);
    if (!state) {
      continue;
    }

    if (state.remainingQuantity <= 0) {
      scene.removeStaticEntity(entity.itemID, {
        broadcast: false,
      });
      cache.byEntityID.set(state.entityID, state);
      if (persistState) {
        writePersistedState(scene, state, {
          existingPersistedState: persistedState,
          persistedByEntityID,
          persistBaseline: true,
        });
      }
      continue;
    }

    applyYieldPresentationToEntity(entity, state, presentationSummary);
    cache.byEntityID.set(state.entityID, state);
    if (persistState) {
      writePersistedState(scene, state, {
        existingPersistedState: persistedState,
        persistedByEntityID,
        persistBaseline: false,
      });
    }
  }

  scene._miningRuntimeState = cache;
  logMiningPresentationSummary(scene, presentationSummary);
  return cache;
}

function getMineableState(scene, entityID) {
  const cache = ensureSceneMiningState(scene);
  if (!cache) {
    return null;
  }
  return cache.byEntityID.get(toInt(entityID, 0)) || null;
}

function updateMineableState(scene, entity, nextState, options = {}) {
  const cache = ensureSceneMiningState(scene);
  if (!cache || !entity || !nextState) {
    return {
      success: false,
      errorMsg: "MINEABLE_NOT_FOUND",
    };
  }

  const normalizedState = normalizeStateRecord(nextState);
  if (shouldPersistMineableState(entity)) {
    writePersistedState(scene, normalizedState, {
      existingPersistedState:
        cache.persistedByEntityID[String(normalizedState.entityID)] || null,
      persistBaseline: true,
    });
  }
  cache.byEntityID.set(normalizedState.entityID, normalizedState);

  if (normalizedState.remainingQuantity <= 0) {
    if (typeof scene.clearAllTargetingForEntity === "function") {
      scene.clearAllTargetingForEntity(entity, {
        reason: "Exploding",
        nowMs: options.nowMs,
        miningDepletionSourceEntityID: toInt(
          options.sourceEntity && options.sourceEntity.itemID,
          0,
        ),
        miningDepletionModuleID: toInt(
          options.moduleItem && options.moduleItem.itemID,
          0,
        ),
      });
    }
    try {
      const droneRuntime = require(path.join(__dirname, "../drone/droneRuntime"));
      if (droneRuntime && typeof droneRuntime.idleMiningDronesTargeting === "function") {
        droneRuntime.idleMiningDronesTargeting(scene, normalizedState.entityID, {
          excludeDroneID: options.sourceDroneID,
        });
      }
    } catch (_) {
      // Drone runtime may be unavailable during isolated mining-state tests.
    }
    if (
      typeof scene.removeStaticEntity === "function" &&
      scene.getEntityByID &&
      scene.getEntityByID(normalizedState.entityID)
    ) {
      scene.removeStaticEntity(normalizedState.entityID, {
        broadcast: options.broadcast !== false,
        nowMs: options.nowMs,
        terminalDestructionEffectID: resolveDepletionDestructionEffectID(
          entity,
          normalizedState,
        ),
      });
    }
  } else {
    applyYieldPresentationToEntity(entity, normalizedState);
  }

  return {
    success: true,
    data: {
      state: normalizedState,
    },
  };
}

function resolveOreMinedSession(options = {}) {
  const candidate =
    options.session ||
    (options.sourceEntity && options.sourceEntity.session) ||
    null;
  return candidate && typeof candidate.sendNotification === "function"
    ? candidate
    : null;
}

function resolveOreMinedCharacterID(sourceEntity, session) {
  return toInt(
    sourceEntity && (
      sourceEntity.characterID ||
      sourceEntity.pilotCharacterID
    ),
    toInt(
      session && (
        session.characterID ||
        session.charID ||
        session.charid ||
        session.characterId
      ),
      toInt(sourceEntity && sourceEntity.ownerID, 0),
    ),
  );
}

function resolveOreMinedSystemID(scene, sourceEntity, session) {
  return toInt(
    scene && (scene.systemID || scene.solarSystemID),
    toInt(
      sourceEntity && sourceEntity.systemID,
      toInt(
        session && (
          session.solarsystemid2 ||
          session.solarsystemid ||
          (session._space && session._space.systemID)
        ),
        0,
      ),
    ),
  );
}

function notifyOreMined(scene, entity, previousState, deltaData, options = {}) {
  if (options.notifyOreMined === false) {
    return false;
  }
  if (!options.sourceEntity && !options.moduleItem) {
    return false;
  }

  const session = resolveOreMinedSession(options);
  if (!session) {
    return false;
  }

  const sourceEntity = options.sourceEntity || {};
  const moduleItem = options.moduleItem || {};
  const yieldTypeID = toInt(previousState && previousState.yieldTypeID, 0);
  const yieldTypeRecord = resolveItemByTypeID(yieldTypeID) || {};
  const moduleTypeID = toInt(
    options.moduleTypeID,
    toInt(moduleItem && moduleItem.typeID, 0),
  );
  const moduleTypeRecord = resolveItemByTypeID(moduleTypeID) || {};
  const shipTypeID = toInt(
    options.shipTypeID,
    toInt(sourceEntity && sourceEntity.typeID, 0),
  );
  const shipTypeRecord = resolveItemByTypeID(shipTypeID) || {};
  const quantityAdded = Math.max(0, toInt(options.quantityAdded, 0));
  const amountWasted = Math.max(
    0,
    toInt(options.amountWasted, toInt(options.wastedQuantity, 0)),
  );
  const quantityRemoved = Math.max(
    0,
    toInt(
      options.quantityRemoved,
      toInt(deltaData && deltaData.depletedQuantity, 0),
    ),
  );
  if (quantityAdded <= 0 && quantityRemoved <= 0 && amountWasted <= 0) {
    return false;
  }

  const systemID = resolveOreMinedSystemID(scene, sourceEntity, session);
  const systemRecord = worldData.getSolarSystemByID(systemID) || {};
  const payload = buildMarshalDict([
    [
      "itemID",
      toInt(entity && entity.itemID, toInt(previousState && previousState.entityID, 0)),
    ],
    ["quantity_added", quantityAdded],
    [
      "shipGroupID",
      toInt(
        options.shipGroupID,
        toInt(sourceEntity && sourceEntity.groupID, toInt(shipTypeRecord.groupID, 0)),
      ),
    ],
    ["amountCritBonus", Math.max(0, toInt(options.amountCritBonus, 0))],
    ["hasRewards", options.hasRewards === true],
    ["oreType", yieldTypeID],
    ["oreGroupID", toInt(options.oreGroupID, toInt(yieldTypeRecord.groupID, 0))],
    ["quantity_removed", quantityRemoved],
    [
      "moduleItemID",
      toInt(options.moduleItemID, toInt(moduleItem && moduleItem.itemID, 0)),
    ],
    [
      "solarSystemFactionID",
      toInt(options.solarSystemFactionID, toInt(systemRecord.factionID, 0)),
    ],
    ["amountWasted", amountWasted],
    ["shipTypeID", shipTypeID],
    ["moduleTypeID", moduleTypeID],
    ["solarsystemID", systemID],
    ["shipID", toInt(options.shipID, toInt(sourceEntity && sourceEntity.itemID, 0))],
    ["charID", resolveOreMinedCharacterID(sourceEntity, session)],
    [
      "moduleGroupID",
      toInt(
        options.moduleGroupID,
        toInt(moduleItem && moduleItem.groupID, toInt(moduleTypeRecord.groupID, 0)),
      ),
    ],
  ]);

  session.sendNotification("OnOreMined", "charid", [payload]);
  return true;
}

function getDungeonRuntimeModule() {
  return require(path.join(__dirname, "../dungeon/dungeonRuntime"));
}

function getIceSystemAuthorityModule() {
  return require(path.join(__dirname, "./iceSystemAuthority"));
}

function getScanMgrServiceModule() {
  return require(path.join(__dirname, "../exploration/scanMgrService"));
}

function resolveGeneratedMiningInstance(scene, entity) {
  if (!isGeneratedIceMineableEntity(entity)) {
    return null;
  }
  const systemID = toInt(scene && scene.systemID, 0);
  if (systemID <= 0) {
    return null;
  }

  const dungeonRuntime = getDungeonRuntimeModule();
  const instanceID = toInt(entity.generatedMiningSiteInstanceID, 0);
  if (instanceID > 0 && dungeonRuntime && typeof dungeonRuntime.getInstance === "function") {
    const instance = dungeonRuntime.getInstance(instanceID);
    if (
      instance &&
      toInt(instance.solarSystemID, 0) === systemID &&
      normalizeLowerText(instance.siteOrigin, "") === "generatedmining" &&
      normalizeLowerText(instance.siteFamily, "ice") === "ice"
    ) {
      return instance;
    }
  }

  if (!dungeonRuntime || typeof dungeonRuntime.listActiveInstancesBySystem !== "function") {
    return null;
  }

  const siteID = toInt(entity.generatedMiningSiteID, 0);
  const rawSiteIndex = toInt(entity.generatedMiningSiteIndex, -1);
  return dungeonRuntime.listActiveInstancesBySystem(systemID, { full: true })
    .find((instance) => {
      const metadata = instance && instance.metadata && typeof instance.metadata === "object"
        ? instance.metadata
        : {};
      const spawnState = instance && instance.spawnState && typeof instance.spawnState === "object"
        ? instance.spawnState
        : {};
      const instanceSiteID = toInt(metadata.siteID, toInt(spawnState.siteID, 0));
      const instanceRawSiteIndex = toInt(
        metadata.rawSiteIndex,
        toInt(spawnState.rawSiteIndex, -2),
      );
      return (
        instance &&
        normalizeLowerText(instance.siteOrigin, "") === "generatedmining" &&
        normalizeLowerText(instance.siteFamily, "ice") === "ice" &&
        instance.runtimeFlags &&
        instance.runtimeFlags.universeSeeded === true &&
        (
          (siteID > 0 && instanceSiteID === siteID) ||
          (rawSiteIndex >= 0 && instanceRawSiteIndex === rawSiteIndex)
        )
      );
    }) || null;
}

function getGeneratedIceSiteEntities(scene, entity) {
  if (!scene || !isGeneratedIceMineableEntity(entity)) {
    return [];
  }
  const rawSiteIndex = toInt(entity.generatedMiningSiteIndex, -1);
  const siteID = toInt(entity.generatedMiningSiteID, 0);
  const instanceID = toInt(entity.generatedMiningSiteInstanceID, 0);
  return (Array.isArray(scene.staticEntities) ? scene.staticEntities : [])
    .filter((candidate) => {
      if (
        !candidate ||
        candidate.generatedMiningSite !== true ||
        normalizeLowerText(candidate.generatedMiningSiteKind, "") !== "ice"
      ) {
        return false;
      }
      if (rawSiteIndex >= 0 && toInt(candidate.generatedMiningSiteIndex, -2) === rawSiteIndex) {
        return true;
      }
      if (siteID > 0 && toInt(candidate.generatedMiningSiteID, 0) === siteID) {
        return true;
      }
      return instanceID > 0 && toInt(candidate.generatedMiningSiteInstanceID, 0) === instanceID;
    });
}

function idleDronesTargetingMineable(scene, entityID, options = {}) {
  try {
    const droneRuntime = require(path.join(__dirname, "../drone/droneRuntime"));
    if (droneRuntime && typeof droneRuntime.idleMiningDronesTargeting === "function") {
      droneRuntime.idleMiningDronesTargeting(scene, entityID, {
        excludeDroneID: options.sourceDroneID,
      });
    }
  } catch (_) {
    // Drone runtime may be unavailable during isolated mining-state tests.
  }
}

function removeGeneratedIceSiteEntities(scene, entity, options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const removedEntityIDs = [];
  for (const siteEntity of getGeneratedIceSiteEntities(scene, entity)) {
    const entityID = toInt(siteEntity && siteEntity.itemID, 0);
    if (entityID <= 0) {
      continue;
    }
    if (typeof scene.clearAllTargetingForEntity === "function") {
      scene.clearAllTargetingForEntity(siteEntity, {
        reason: "Exploding",
        nowMs,
      });
    }
    idleDronesTargetingMineable(scene, entityID, options);
    if (
      typeof scene.removeStaticEntity === "function" &&
      scene.getEntityByID &&
      scene.getEntityByID(entityID)
    ) {
      const removeResult = scene.removeStaticEntity(entityID, {
        broadcast: options.broadcast !== false,
        nowMs,
        terminalDestructionEffectID:
          siteEntity.generatedMiningSiteAnchor === true
            ? 0
            : resolveDepletionDestructionEffectID(siteEntity, getMineableState(scene, entityID)),
      });
      if (removeResult && removeResult.success === true) {
        removedEntityIDs.push(entityID);
      }
    }
  }
  return removedEntityIDs;
}

function notifyGeneratedMiningAnomalyDelta(scene) {
  const systemID = toInt(scene && scene.systemID, 0);
  if (systemID <= 0) {
    return false;
  }
  try {
    const scanMgrService = getScanMgrServiceModule();
    if (scanMgrService && typeof scanMgrService.notifyAnomalyDeltaForSystem === "function") {
      scanMgrService.notifyAnomalyDeltaForSystem(systemID, {
        scene,
      });
      return true;
    }
  } catch (_) {
    // Scan manager is not required in isolated mining-state tests.
  }
  return false;
}

function completeGeneratedIceSite(scene, entity, instance, members, options = {}) {
  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const systemID = toInt(scene && scene.systemID, toInt(instance && instance.solarSystemID, 0));
  const dungeonRuntime = getDungeonRuntimeModule();
  const iceSystemAuthority = getIceSystemAuthorityModule();
  const respawnDelayMs = Math.max(
    1,
    toInt(
      iceSystemAuthority && typeof iceSystemAuthority.getRespawnDelayMsForSystem === "function"
        ? iceSystemAuthority.getRespawnDelayMsForSystem(systemID)
        : 0,
      6 * 60 * 60 * 1000,
    ),
  );
  const respawnAtMs = nowMs + respawnDelayMs;
  const removedEntityIDs = removeGeneratedIceSiteEntities(scene, entity, options);
  const cache = ensureSceneMiningState(scene);
  for (const member of Array.isArray(members) ? members : []) {
    const entityID = toInt(member && member.entityID, 0);
    if (entityID <= 0) {
      continue;
    }
    removePersistedState(scene, entityID);
    if (cache && cache.byEntityID) {
      cache.byEntityID.delete(entityID);
    }
  }

  const updatedInstance = dungeonRuntime.setLifecycleState(instance.instanceID, "completed", {
    nowMs,
    completedAtMs: nowMs,
    lifecycleReason: "depleted",
    expiresAtMs: respawnAtMs,
  });
  notifyGeneratedMiningAnomalyDelta(scene);

  return {
    instanceID: toInt(instance && instance.instanceID, 0),
    completed: true,
    lifecycleState: updatedInstance && updatedInstance.lifecycleState || "completed",
    lifecycleReason: updatedInstance && updatedInstance.lifecycleReason || "depleted",
    activeMemberCount: 0,
    totalRemainingQuantity: 0,
    respawnAtMs,
    removedEntityIDs,
  };
}

function syncGeneratedMiningInstanceAfterDelta(scene, entity, nextState, options = {}) {
  if (!isGeneratedIceMineableEntity(entity)) {
    return null;
  }
  const instance = resolveGeneratedMiningInstance(scene, entity);
  if (!instance) {
    return null;
  }

  const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
  const cache = ensureSceneMiningState(scene);
  const sourceMembers = Array.isArray(instance.spawnState && instance.spawnState.members)
    ? instance.spawnState.members
    : [];
  const members = sourceMembers.map((member) => {
    const entityID = toInt(member && member.entityID, 0);
    const cachedState = cache && cache.byEntityID
      ? cache.byEntityID.get(entityID)
      : null;
    const remainingQuantity =
      entityID === toInt(nextState && nextState.entityID, 0)
        ? toInt(nextState && nextState.remainingQuantity, 0)
        : toInt(cachedState && cachedState.remainingQuantity, toInt(member && member.remainingQuantity, 0));
    return {
      ...cloneValue(member),
      remainingQuantity: Math.max(0, remainingQuantity),
      updatedAtMs: nowMs,
    };
  });
  const activeMemberCount = members.filter((member) => toInt(member && member.remainingQuantity, 0) > 0).length;
  const totalRemainingQuantity = members.reduce(
    (sum, member) => sum + Math.max(0, toInt(member && member.remainingQuantity, 0)),
    0,
  );

  const dungeonRuntime = getDungeonRuntimeModule();
  dungeonRuntime.mergeSpawnState(instance.instanceID, {
    members,
    activeMemberCount,
    totalRemainingQuantity,
    lastMinedEntityID: toInt(entity && entity.itemID, 0),
    lastUpdatedAtMs: nowMs,
  }, { nowMs });

  if (activeMemberCount > 0) {
    return {
      instanceID: toInt(instance && instance.instanceID, 0),
      completed: false,
      activeMemberCount,
      totalRemainingQuantity,
      respawnAtMs: 0,
      removedEntityIDs: [],
    };
  }

  return completeGeneratedIceSite(scene, entity, instance, members, options);
}

function applyMiningDelta(scene, entity, minedQuantity, wastedQuantity, options = {}) {
  const currentState = getMineableState(scene, entity && entity.itemID);
  if (!currentState) {
    return {
      success: false,
      errorMsg: "MINEABLE_NOT_FOUND",
    };
  }

  const depletedQuantity = Math.max(
    0,
    toInt(minedQuantity, 0) + toInt(wastedQuantity, 0),
  );
  const nextState = normalizeStateRecord({
    ...currentState,
    remainingQuantity: Math.max(0, currentState.remainingQuantity - depletedQuantity),
    revision: Math.max(0, toInt(currentState.revision, 0)) + 1,
    updatedAtMs: options.nowMs ?? Date.now(),
  });

  const updateResult = updateMineableState(scene, entity, nextState, options);
  if (!updateResult.success) {
    return updateResult;
  }

  const deltaData = {
    previousState: currentState,
    state: nextState,
    depleted: nextState.remainingQuantity <= 0,
    depletedQuantity,
  };
  const generatedMiningSite = syncGeneratedMiningInstanceAfterDelta(
    scene,
    entity,
    nextState,
    options,
  );
  if (generatedMiningSite) {
    deltaData.generatedMiningSite = generatedMiningSite;
  }
  notifyOreMined(scene, entity, currentState, deltaData, {
    ...options,
    wastedQuantity,
  });

  return {
    success: true,
    data: deltaData,
  };
}

function buildPersistedAsteroidBaselines(
  systemID,
  entities,
  existingEntities = {},
  nowMs = Date.now(),
) {
  const normalizedSystemID = toInt(systemID, 0);
  const normalizedExisting =
    existingEntities && typeof existingEntities === "object"
      ? cloneValue(existingEntities)
      : {};
  const logicalScene = {
    systemID: normalizedSystemID,
  };
  let generatedCount = 0;
  let seededCount = 0;

  for (const entity of Array.isArray(entities) ? entities : []) {
    if (!isMineableStaticEntity(entity) || !shouldPersistMineableState(entity)) {
      continue;
    }
    generatedCount += 1;
    const entityID = toInt(entity && entity.itemID, 0);
    if (entityID <= 0 || normalizedExisting[String(entityID)]) {
      continue;
    }
    const baseline = buildMineableState(logicalScene, entity, null);
    if (!baseline) {
      continue;
    }
    baseline.updatedAtMs = Math.max(0, toInt(nowMs, Date.now()));
    normalizedExisting[String(entityID)] = baseline;
    seededCount += 1;
  }

  return {
    entities: normalizedExisting,
    generatedCount,
    seededCount,
  };
}

// Establish deterministic, full-quantity baseline rows for authored asteroid
// belts. Existing (including partially depleted) rows always win. This gives
// off-grid miners a real resource ledger while keeping the solar-system scene
// unloaded and therefore costs no physics or visibility budget.
function ensurePersistedAsteroidBaselines(systemID, options = {}) {
  const normalizedSystemID = toInt(systemID, 0);
  if (normalizedSystemID <= 0) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }

  const asteroidService = require(path.join(__dirname, "../../space/asteroids"));
  const buildResult = asteroidService.buildSystemAsteroidEntities(
    normalizedSystemID,
    {
      beltIDs: options.beltIDs,
      maximumBelts: options.maximumBelts,
    },
  );
  if (!buildResult || buildResult.success !== true) {
    return (
      buildResult || {
        success: false,
        errorMsg: "ASTEROID_BASELINE_BUILD_FAILED",
      }
    );
  }

  const existingEntities = readPersistedSystemEntities(normalizedSystemID);
  const baseline = buildPersistedAsteroidBaselines(
    normalizedSystemID,
    buildResult.data && buildResult.data.entities,
    existingEntities,
    options.nowMs,
  );
  if (baseline.seededCount > 0) {
    const writeResult = repo.write(
      MINING_RUNTIME_TABLE,
      `/systems/${String(normalizedSystemID)}/entities`,
      baseline.entities,
    );
    if (!writeResult || writeResult.success !== true) {
      return (
        writeResult || {
          success: false,
          errorMsg: "ASTEROID_BASELINE_WRITE_FAILED",
        }
      );
    }
    if (options.flush !== false && typeof repo.flushTableSync === "function") {
      const flushResult = repo.flushTableSync(MINING_RUNTIME_TABLE);
      if (!flushResult || flushResult.success !== true) {
        return (
          flushResult || {
            success: false,
            errorMsg: "ASTEROID_BASELINE_FLUSH_FAILED",
          }
        );
      }
    }
  }

  return {
    success: true,
    data: {
      systemID: normalizedSystemID,
      beltIDs: Array.isArray(buildResult.data && buildResult.data.beltIDs)
        ? [...buildResult.data.beltIDs]
        : [],
      generatedCount: baseline.generatedCount,
      seededCount: baseline.seededCount,
      persistedCount: Object.keys(baseline.entities).length,
    },
  };
}

// Establish off-grid baseline rows for deterministic generated ice/gas sites.
// Existing rows always win so a server restart cannot replenish depletion.
function ensurePersistedGeneratedResourceBaselines(
  systemID,
  definitions,
  options = {},
) {
  const normalizedSystemID = toInt(systemID, 0);
  if (normalizedSystemID <= 0) {
    return { success: false, errorMsg: "SOLAR_SYSTEM_NOT_FOUND" };
  }
  const existingEntities = readPersistedSystemEntities(normalizedSystemID);
  const nextEntities = cloneValue(existingEntities);
  let generatedCount = 0;
  let seededCount = 0;
  for (const definition of Array.isArray(definitions) ? definitions : []) {
    if (
      toInt(definition && definition.solarSystemID, 0) !== normalizedSystemID
    ) {
      continue;
    }
    const yieldKind = String(definition && definition.family || "")
      .trim()
      .toLowerCase();
    const beltID = toInt(definition && definition.siteID, 0);
    if (!yieldKind || beltID <= 0) {
      continue;
    }
    for (const member of Array.isArray(definition.members)
      ? definition.members
      : []) {
      const entityID = toInt(member && member.entityID, 0);
      const originalQuantity = Math.max(
        1,
        toInt(member && member.originalQuantity, 1),
      );
      if (entityID <= 0) {
        continue;
      }
      generatedCount += 1;
      if (nextEntities[String(entityID)]) {
        continue;
      }
      nextEntities[String(entityID)] = normalizeStateRecord({
        entityID,
        visualTypeID: toInt(member && member.visualTypeID, 0),
        beltID,
        fieldStyleID: null,
        yieldTypeID: toInt(member && member.yieldTypeID, 0),
        yieldKind,
        unitVolume: Math.max(
          0.000001,
          toFiniteNumber(member && member.unitVolume, 1),
        ),
        originalQuantity,
        remainingQuantity: Math.max(
          0,
          Math.min(
            originalQuantity,
            toInt(member && member.remainingQuantity, originalQuantity),
          ),
        ),
        originalRadius: Math.max(
          1,
          toFiniteNumber(member && member.originalRadius, 1),
        ),
        updatedAtMs: Math.max(0, toInt(options.nowMs, Date.now())),
      });
      seededCount += 1;
    }
  }
  if (seededCount > 0) {
    const writeResult = repo.write(
      MINING_RUNTIME_TABLE,
      `/systems/${String(normalizedSystemID)}/entities`,
      nextEntities,
    );
    if (!writeResult || writeResult.success !== true) {
      return (
        writeResult || {
          success: false,
          errorMsg: "RESOURCE_BASELINE_WRITE_FAILED",
        }
      );
    }
    if (options.flush !== false && typeof repo.flushTableSync === "function") {
      const flushResult = repo.flushTableSync(MINING_RUNTIME_TABLE);
      if (!flushResult || flushResult.success !== true) {
        return (
          flushResult || {
            success: false,
            errorMsg: "RESOURCE_BASELINE_FLUSH_FAILED",
          }
        );
      }
    }
  }
  return {
    success: true,
    data: {
      systemID: normalizedSystemID,
      generatedCount,
      seededCount,
      persistedCount: Object.keys(nextEntities).length,
    },
  };
}

const virtualMiningTransactionService = createVirtualMiningTransactionService({
  repository: repo,
  tableName: MINING_RUNTIME_TABLE,
  normalizeStateRecord,
});

function applyPersistedMiningBatch(request, options = {}) {
  return virtualMiningTransactionService.applyPersistedMiningBatch(
    request,
    options,
  );
}

function syncPersistedMiningBatchToScene(scene, transaction, options = {}) {
  if (!scene || !transaction || !Array.isArray(transaction.results)) {
    return {
      success: false,
      errorMsg: "MINING_SCENE_SYNC_INPUT_INVALID",
    };
  }
  const cache = ensureSceneMiningState(scene);
  if (!cache) {
    return {
      success: false,
      errorMsg: "MINING_SCENE_STATE_NOT_FOUND",
    };
  }
  const persisted = readPersistedSystemEntities(scene.systemID);
  let syncedCount = 0;
  for (const row of transaction.results) {
    const entityID = toInt(row && row.entityID, 0);
    if (entityID <= 0 || toInt(row && row.acceptedQuantity, 0) <= 0) {
      continue;
    }
    const state = persisted[String(entityID)];
    if (!state) {
      continue;
    }
    const entity =
      typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : Array.isArray(scene.staticEntities)
          ? scene.staticEntities.find(
              (candidate) =>
                toInt(candidate && candidate.itemID, 0) === entityID,
            )
          : null;
    if (!entity) {
      cache.byEntityID.set(entityID, normalizeStateRecord(state));
      cache.persistedByEntityID[String(entityID)] = cloneValue(state);
      syncedCount += 1;
      continue;
    }
    const updateResult = updateMineableState(scene, entity, state, {
      broadcast: options.broadcast === true,
      nowMs: options.nowMs,
    });
    if (updateResult && updateResult.success === true) {
      syncedCount += 1;
    }
  }
  return {
    success: true,
    data: {
      systemID: toInt(scene.systemID, 0),
      syncedCount,
    },
  };
}

function readPersistedMiningTransaction(systemID, transactionID) {
  return virtualMiningTransactionService.readTransaction(
    systemID,
    transactionID,
  );
}

function clearPersistedSystemState(systemID) {
  const normalizedSystemID = toInt(systemID, 0);
  if (normalizedSystemID <= 0) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }

  const removeResult = repo.remove(
    MINING_RUNTIME_TABLE,
    `/systems/${String(normalizedSystemID)}`,
  );
  if (
    !removeResult.success &&
    removeResult.errorMsg !== "ENTRY_NOT_FOUND"
  ) {
    return removeResult;
  }

  return {
    success: true,
    data: {
      systemID: normalizedSystemID,
    },
  };
}

// Belt asteroid fields are regenerated deterministically from the belt's
// fieldSeed every time a scene is created, so the ONLY thing keeping a mined
// belt empty is its persisted depletion state: ensureSceneMiningState removes
// any freshly spawned rock whose stored remainingQuantity is 0. Dropping those
// rows at startup restores every belt to pristine, which matches Tranquility —
// belts repopulate on downtime, not on a timer.
//
// Scoped to belt rocks (beltID > 0) on purpose. The same table also holds
// generated ice-site mineables, which already respawn through the dungeon
// lifecycle (completeGeneratedIceSite sets an expiry and drops their rows);
// clearing those here would resurrect members of a completed instance.
//
// Startup-only by contract: this rewrites persisted rows without touching any
// scene's in-memory cache, so it must run before the first scene is built.
function resetPersistedBeltAsteroidState() {
  const result = repo.read(MINING_RUNTIME_TABLE, "/systems");
  if (!result.success || !result.data || typeof result.data !== "object") {
    return {
      systemsCleared: 0,
      systemsTouched: 0,
      entitiesCleared: 0,
    };
  }

  let systemsCleared = 0;
  let systemsTouched = 0;
  let entitiesCleared = 0;

  for (const [systemKey, systemNode] of Object.entries(result.data)) {
    const entities = systemNode && systemNode.entities;
    if (!entities || typeof entities !== "object") {
      continue;
    }

    const retained = {};
    let clearedForSystem = 0;
    for (const [entityKey, state] of Object.entries(entities)) {
      if (toInt(state && state.beltID, 0) > 0) {
        clearedForSystem += 1;
        continue;
      }
      retained[entityKey] = state;
    }

    if (clearedForSystem === 0) {
      continue;
    }

    entitiesCleared += clearedForSystem;
    systemsTouched += 1;

    if (Object.keys(retained).length === 0 && Object.keys(systemNode).length === 1) {
      const removeResult = repo.remove(
        MINING_RUNTIME_TABLE,
        `/systems/${systemKey}`,
      );
      if (removeResult.success || removeResult.errorMsg === "ENTRY_NOT_FOUND") {
        systemsCleared += 1;
        continue;
      }
    }

    repo.write(
      MINING_RUNTIME_TABLE,
      `/systems/${systemKey}/entities`,
      retained,
    );
  }

  return {
    systemsCleared,
    systemsTouched,
    entitiesCleared,
  };
}

function summarizeSceneMiningState(scene) {
  const cache = ensureSceneMiningState(scene);
  if (!cache) {
    return null;
  }

  const activeStaticEntityIDs = new Set(
    [...(scene && scene.staticEntities ? scene.staticEntities : [])]
      .map((entity) => toInt(entity && entity.itemID, 0))
      .filter((entityID) => entityID > 0),
  );
  const summary = {
    systemID: toInt(scene && scene.systemID, 0),
    trackedCount: 0,
    activeCount: 0,
    depletedCount: 0,
    oreCount: 0,
    iceCount: 0,
    gasCount: 0,
    activeAsteroidEntityCount: [...(scene && scene.staticEntities ? scene.staticEntities : [])]
      .filter((entity) => String(entity && entity.kind || "").toLowerCase() === "asteroid")
      .length,
  };

  for (const state of cache.byEntityID.values()) {
    if (!state) {
      continue;
    }
    summary.trackedCount += 1;
    if (state.remainingQuantity > 0 && activeStaticEntityIDs.has(toInt(state.entityID, 0))) {
      summary.activeCount += 1;
    } else {
      summary.depletedCount += 1;
    }

    if (state.yieldKind === "ice") {
      summary.iceCount += 1;
    } else if (state.yieldKind === "gas") {
      summary.gasCount += 1;
    } else {
      summary.oreCount += 1;
    }
  }

  return summary;
}

function resetSceneMiningState(scene, options = {}) {
  if (!scene) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  const clearResult = clearPersistedSystemState(scene.systemID);
  if (!clearResult.success) {
    return clearResult;
  }

  let asteroidResetResult = null;
  if (options.rebuildAsteroids !== false) {
    const asteroidService = require(path.join(__dirname, "../../space/asteroids"));
    if (
      asteroidService &&
      typeof asteroidService.resetSceneAsteroidFields === "function"
    ) {
      asteroidResetResult = asteroidService.resetSceneAsteroidFields(scene, {
        broadcast: options.broadcast === true,
        nowMs: options.nowMs,
      });
      if (!asteroidResetResult.success) {
        return asteroidResetResult;
      }
    }
  }

  let generatedResourceSiteResetResult = null;
  if (options.rebuildResourceSites !== false) {
    const miningResourceSiteService = require("./miningResourceSiteService");
    if (
      miningResourceSiteService &&
      typeof miningResourceSiteService.resetSceneGeneratedResourceSites === "function"
    ) {
      generatedResourceSiteResetResult =
        miningResourceSiteService.resetSceneGeneratedResourceSites(scene, {
          broadcast: options.broadcast === true,
          nowMs: options.nowMs,
        });
      if (!generatedResourceSiteResetResult.success) {
        return generatedResourceSiteResetResult;
      }
    }
  }

  scene._miningRuntimeState = null;
  const cache = ensureSceneMiningState(scene);
  return {
    success: true,
    data: {
      systemID: toInt(scene.systemID, 0),
      mineableCount: cache ? cache.byEntityID.size : 0,
      asteroidResetResult:
        asteroidResetResult && asteroidResetResult.data
          ? asteroidResetResult.data
          : null,
      generatedResourceSiteResetResult:
        generatedResourceSiteResetResult && generatedResourceSiteResetResult.data
          ? generatedResourceSiteResetResult.data
          : null,
      summary: summarizeSceneMiningState(scene),
    },
  };
}

module.exports = {
  MINING_RUNTIME_TABLE,
  ensureSceneMiningState,
  getMineableState,
  updateMineableState,
  applyMiningDelta,
  applyPersistedMiningBatch,
  syncPersistedMiningBatchToScene,
  ensurePersistedAsteroidBaselines,
  ensurePersistedGeneratedResourceBaselines,
  readPersistedMiningTransaction,
  isMineableStaticEntity,
  shouldPersistMineableState,
  clearPersistedSystemState,
  resetPersistedBeltAsteroidState,
  summarizeSceneMiningState,
  resetSceneMiningState,
  readPersistedSystemEntities,
  writePersistedSystemEntity,
  removePersistedSystemEntity,
  _testing: {
    getTemplateEntriesForFieldStyle,
    buildTemplateEntriesForOreDefinition,
    ORE_GRADE_VARIANTS,
    normalizeStateRecord,
    buildPersistedAsteroidBaselines,
    virtualMiningTransactionService,
  },
};
