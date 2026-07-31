"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../../config"));
const database = require(path.join(__dirname, "../../../gameStore"));
const worldData = require(path.join(__dirname, "../../worldData"));
const { DeadlineQueue } = require(path.join(__dirname, "../../liveEvents/deadlineQueue"));
const catalog = require(path.join(__dirname, "./livingEconomyCatalog"));
const workforce = require(path.join(__dirname, "./livingEconomyIndustrialWorkforce"));
const mobilization = require(path.join(__dirname, "./livingEconomyMobilization"));

const ACTIVE_STATES = new Set(["reserving", "running", "output_pending"]);
const ACTIVITY = Object.freeze({
  MANUFACTURING: "manufacturing",
  COPYING: "copying",
  RESEARCH_MATERIAL: "research_material",
  RESEARCH_TIME: "research_time",
});
const BLUEPRINT_TARGET_ME = 8;
const BLUEPRINT_TARGET_TE = 16;
const COMPLETION_RETRY_MS = 30_000;
const COMPLETED_JOB_PRUNE_INTERVAL_MS = 10 * 60 * 1_000;
const INDUSTRY_ADJUSTMENT_NAMESPACE_VERSION = 2;
const INDUSTRY_JOB_ID_PATTERN = /^LEI-(\d+)$/;
const recipeCache = new Map();
let blueprintDefinitionsByProductTypeID = null;
const completionDeadlineQueue = new DeadlineQueue();
let indexedIndustryJobs = null;
let nextCompletedJobPruneAtMs = 0;
const industryJobCounterFloors = new WeakMap();
const activeJobIDs = new Set();
const activeJobIDsByProductTypeID = new Map();
const activeBlueprintAssetIDs = new Set();
const reservingJobIDs = new Set();
const completionScheduleMetrics = {
  rebuilds: 0,
  schedules: 0,
  dueJobsProcessed: 0,
  completionFailuresRetried: 0,
  completionBatches: 0,
  maximumCompletionBatchSize: 0,
  pruneRuns: 0,
};

// These products are already part of the living-universe doctrine catalog, but
// their current SDE blueprints either depend on the not-yet-modelled component
// industry or are absent from the bundled blueprint export (two shuttles). Keep
// their losses economically real during the foundation/T1 phase by consuming a
// conservative mineral basket. The full component and invention chain can
// replace these explicit bridge recipes without changing replacement demands.
const FOUNDATION_ASSEMBLY_PRODUCT_TYPE_IDS = new Set([
  588, 596, // Minmatar and Amarr shuttles
  638, 24690, 24692, 24694, // racial battleships
  1319, // Expanded Cargohold II
  12731, 12735, 12745, 12753, // deep-space/blockade transports
  20183, 20185, 20187, 20189, // freighters
  21947, // Structure Construction Parts (PI-chain bridge)
  35899, // Standup Reprocessing Facility I (component-chain bridge)
  // Active mining doctrines already fly these T2/ORE hulls and modules. The
  // foundation economy does not yet model invention, moon materials, or
  // advanced components, so their replacement path consumes an equivalent
  // conservative mineral-value basket until those upstream chains exist.
  482, 2048, 3831, 17912, 22229, 24348, 28576, 42528, 42830,
  22544, 22546, 22548, 28606, 42244,
  // Pirate-faction corporations own their designs, but their current SDE
  // recipes depend on advanced materials outside the foundation economy.
  // Their nullsec assembly plants therefore consume the same conservative
  // mineral-value bridge as other not-yet-modelled component chains.
  ...catalog.PIRATE_FACTION_HULL_TYPE_IDS,
]);

// Nanite paste is the first deliberately non-mineral production bridge. It
// consumes ordinary salvage bought by industrial corporations, giving campaign
// repair demand a real upstream sink without pretending it is mined from rocks.
const FOUNDATION_SPECIAL_RECIPES = new Map([
  [28668, Object.freeze({
    blueprintTypeID: 900_028_668,
    blueprintName: "Nanite Repair Paste Salvage Reclamation Plan",
    productTypeID: 28668,
    productTypeName: "Nanite Repair Paste",
    productQuantityPerRun: 10,
    timePerRunSeconds: 600,
    maxProductionLimit: 100,
    copyingTimeSeconds: 480,
    materialResearchTimeSeconds: 900,
    timeResearchTimeSeconds: 900,
    foundationAssembly: true,
    salvageReclamation: true,
    materials: Object.freeze([
      Object.freeze({ typeID: 25590, typeName: "Contaminated Nanite Compound", quantityPerRun: 3 }),
      Object.freeze({ typeID: 25598, typeName: "Tripped Power Circuit", quantityPerRun: 2 }),
      Object.freeze({ typeID: 34, typeName: "Tritanium", quantityPerRun: 20 }),
    ]),
  })],
]);
const FOUNDATION_MINERAL_VALUE_SHARES = Object.freeze([
  Object.freeze({ typeID: 34, share: 0.40 }),
  Object.freeze({ typeID: 35, share: 0.22 }),
  Object.freeze({ typeID: 36, share: 0.15 }),
  Object.freeze({ typeID: 37, share: 0.10 }),
  Object.freeze({ typeID: 38, share: 0.06 }),
  Object.freeze({ typeID: 39, share: 0.04 }),
  Object.freeze({ typeID: 40, share: 0.03 }),
]);

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function roundMoney(value) {
  return Math.round(toFiniteNumber(value, 0) * 100) / 100;
}

function stockKey(stationID, typeID) {
  return `${Number(stationID)}:${Number(typeID)}`;
}

function reconcileIndustryJobCounter(economyState) {
  const persistedNext = Math.max(
    1,
    toPositiveInt(economyState.nextIndustryJobNumber, 1),
  );
  const cachedFloor = industryJobCounterFloors.get(economyState);
  if (cachedFloor) {
    const next = Math.max(persistedNext, cachedFloor);
    economyState.nextIndustryJobNumber = next;
    industryJobCounterFloors.set(economyState, next);
    return next;
  }
  let next = persistedNext;
  for (const jobID of Object.keys(economyState.industryJobs || {})) {
    const match = INDUSTRY_JOB_ID_PATTERN.exec(jobID);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  economyState.nextIndustryJobNumber = next;
  industryJobCounterFloors.set(economyState, next);
  return next;
}

function ensureIndustryState(economyState) {
  if (!economyState.industryJobs || typeof economyState.industryJobs !== "object") {
    economyState.industryJobs = {};
  }
  if (!economyState.metrics || typeof economyState.metrics !== "object") {
    economyState.metrics = {};
  }
  reconcileIndustryJobCounter(economyState);
  if (!economyState.productionClocks || typeof economyState.productionClocks !== "object") {
    economyState.productionClocks = {};
  }
  if (!economyState.industryBlueprints || typeof economyState.industryBlueprints !== "object") {
    economyState.industryBlueprints = {};
  }
  economyState.nextIndustryBlueprintNumber = Math.max(
    1,
    toPositiveInt(economyState.nextIndustryBlueprintNumber, 1),
  );
  workforce.ensureState(economyState);
  return economyState.industryJobs;
}

function getMaxActiveJobs() {
  return Math.max(
    1,
    Math.min(1_000, toPositiveInt(config.livingEconomyMaxActiveIndustryJobs, 320)),
  );
}

function getMaxInstallsPerPulse() {
  const base = Math.max(
    1,
    Math.min(100, toPositiveInt(config.livingEconomyMaxProductionRunsPerPulse, 4)),
  );
  return mobilization.scaleUp(base, 2.5, mobilization.getIndustryRamp(), 100);
}

function getInstallIntervalMs() {
  const base = Math.max(
    30_000,
    toFiniteNumber(config.livingEconomyProductionIntervalSeconds, 120) * 1_000,
  );
  return mobilization.scaleDown(base, 4, mobilization.getIndustryRamp(), 30_000);
}

function getMaximumJobSeconds() {
  return Math.max(
    300,
    toFiniteNumber(config.livingEconomyIndustryMaximumJobSeconds, 7_200),
  );
}

function getMaxParallelHullLines() {
  // The fallback of 1 (legacy serialization) applies only when the config
  // entry is absent entirely; scripts loading the real config run at the
  // configured value. The limit is a ceiling, not a target: science jobs and
  // blueprint-copy turns still serialize within it. Under war-economy
  // mobilization the ceiling interpolates toward the hard clamp of 8.
  const base = Math.max(
    1,
    Math.min(8, toPositiveInt(config.livingEconomyMaxParallelHullLines, 1)),
  );
  return mobilization.scaleUp(base, 8 / 3, mobilization.getIndustryRamp(), 8);
}

function getTimeScale() {
  return Math.max(
    0.01,
    Math.min(100, toFiniteNumber(config.livingEconomyIndustryTimeScale, 1)),
  );
}

function getStationCorporationID(station) {
  const authored = toPositiveInt(station && station.corporationID, 0);
  if (authored > 0) return authored;
  const row = worldData.getStationByID(station && station.stationID);
  return toPositiveInt(row && (row.corporationID || row.ownerID), 0);
}

function getBlueprintDefinitionByProductTypeID(productTypeID) {
  if (!blueprintDefinitionsByProductTypeID) {
    blueprintDefinitionsByProductTypeID = new Map();
    const result = database.read("industryBlueprints", "/");
    const definitions = result.success && result.data &&
      Array.isArray(result.data.blueprintDefinitions)
      ? result.data.blueprintDefinitions
      : [];
    for (const definition of definitions) {
      const typeID = toPositiveInt(definition && definition.productTypeID, 0);
      if (typeID > 0) blueprintDefinitionsByProductTypeID.set(typeID, definition);
    }
  }
  return blueprintDefinitionsByProductTypeID.get(toPositiveInt(productTypeID, 0)) || null;
}

function getFoundationAssemblyTimeSeconds(good, definition) {
  const authored = toFiniteNumber(
    definition && definition.activities && definition.activities.manufacturing &&
      definition.activities.manufacturing.time,
    0,
  );
  if (authored > 0) return authored;
  if (Number(good && good.typeID) === 1319) return 2_340;
  const valueISK = toFiniteNumber(good && good.priceAnchor, 0);
  if (valueISK <= 50_000) return 500;
  if (valueISK >= 1_000_000_000) return 1_500_000;
  if (valueISK >= 100_000_000) return 240_000;
  return 18_000;
}

function buildFoundationAssemblyRecipe(good, definition) {
  const typeID = toPositiveInt(good && good.typeID, 0);
  if (!FOUNDATION_ASSEMBLY_PRODUCT_TYPE_IDS.has(typeID)) return null;
  const factionAssembly = catalog.isPirateFactionHull(typeID);
  const materialBudgetISK = Math.max(1, toFiniteNumber(good.priceAnchor, 1) * 0.82);
  const timePerRunSeconds = getFoundationAssemblyTimeSeconds(good, definition);
  const sourceBlueprintTypeID = toPositiveInt(definition && definition.blueprintTypeID, 0);
  return Object.freeze({
    blueprintTypeID: sourceBlueprintTypeID || (900_000_000 + typeID),
    blueprintName: factionAssembly
      ? `${good.name} Faction Assembly Plan`
      : `${good.name} Foundation Assembly Plan`,
    sourceBlueprintTypeID,
    foundationAssembly: true,
    factionAssembly,
    productTypeID: typeID,
    productTypeName: String(good.name),
    productQuantityPerRun: 1,
    timePerRunSeconds,
    maxProductionLimit: Math.max(1, toPositiveInt(definition && definition.maxProductionLimit, 1)),
    copyingTimeSeconds: Math.max(1, Math.round(timePerRunSeconds * 0.8)),
    materialResearchTimeSeconds: Math.max(1, Math.round(timePerRunSeconds * 1.5)),
    timeResearchTimeSeconds: Math.max(1, Math.round(timePerRunSeconds * 1.5)),
    materials: Object.freeze(FOUNDATION_MINERAL_VALUE_SHARES.map((entry) => {
      const mineral = catalog.getGood(entry.typeID);
      const unitValue = Math.max(0.01, toFiniteNumber(mineral && mineral.priceAnchor, 0.01));
      return Object.freeze({
        typeID: entry.typeID,
        typeName: mineral && mineral.name,
        quantityPerRun: Math.max(1, Math.round((materialBudgetISK * entry.share) / unitValue)),
      });
    })),
  });
}

function getRecipe(good) {
  const typeID = toPositiveInt(good && good.typeID, 0);
  if (!typeID) return null;
  // With faction shipyards enabled, pirate faction hulls are supplied by
  // their owning faction's shipyard stock instead of being assembled from
  // empire minerals: no recipe means demand coverage classifies them as
  // faction_import and industry never plans a mineral-consuming line.
  if (
    config.livingEconomyFactionShipyardEnabled === true &&
    catalog.isPirateFactionHull(typeID)
  ) {
    return null;
  }
  if (recipeCache.has(typeID)) return recipeCache.get(typeID);
  if (FOUNDATION_SPECIAL_RECIPES.has(typeID)) {
    const specialRecipe = FOUNDATION_SPECIAL_RECIPES.get(typeID);
    recipeCache.set(typeID, specialRecipe);
    return specialRecipe;
  }
  const definition = getBlueprintDefinitionByProductTypeID(typeID);
  const activity = definition && definition.activities && definition.activities.manufacturing;
  const product = Array.isArray(activity && activity.products)
    ? activity.products.find((entry) => toPositiveInt(entry && entry.typeID, 0) === typeID)
    : null;
  const materials = Array.isArray(activity && activity.materials)
    ? activity.materials.map((entry) => {
        const materialGood = catalog.getGood(entry && entry.typeID);
        return {
          typeID: toPositiveInt(entry && entry.typeID, 0),
          typeName: materialGood && materialGood.name,
          quantity: toPositiveInt(entry && entry.quantity, 0),
          good: materialGood,
        };
      })
    : [];
  const staticRecipe = definition && activity && product && materials.length > 0 &&
    materials.every((entry) => entry.typeID > 0 && entry.quantity > 0 && catalog.isMineralGood(entry.good))
    ? Object.freeze({
        blueprintTypeID: toPositiveInt(definition.blueprintTypeID, 0),
        blueprintName: String(definition.blueprintName || `${good.name} Blueprint`),
        productTypeID: typeID,
        productTypeName: String(good.name),
        productQuantityPerRun: toPositiveInt(product.quantity, 1),
        timePerRunSeconds: Math.max(1, toFiniteNumber(activity.time, 1)),
        maxProductionLimit: Math.max(1, toPositiveInt(definition.maxProductionLimit, 1)),
        copyingTimeSeconds: Math.max(
          1,
          toFiniteNumber(definition.activities && definition.activities.copying &&
            definition.activities.copying.time, activity.time),
        ),
        materialResearchTimeSeconds: Math.max(
          1,
          toFiniteNumber(definition.activities && definition.activities.research_material &&
            definition.activities.research_material.time, activity.time),
        ),
        timeResearchTimeSeconds: Math.max(
          1,
          toFiniteNumber(definition.activities && definition.activities.research_time &&
            definition.activities.research_time.time, activity.time),
        ),
        materials: Object.freeze(materials.map((entry) => Object.freeze({
          typeID: entry.typeID,
          typeName: entry.typeName,
          quantityPerRun: entry.quantity,
        }))),
      })
    : null;
  const recipe = staticRecipe || buildFoundationAssemblyRecipe(good, definition);
  recipeCache.set(typeID, recipe);
  return recipe;
}

function isActiveJob(job) {
  return Boolean(job && ACTIVE_STATES.has(String(job.status || "")));
}

function listActiveJobs(economyState) {
  ensureCompletionSchedule(economyState);
  const jobs = economyState.industryJobs;
  return [...activeJobIDs]
    .map((jobID) => jobs[jobID])
    .filter(isActiveJob);
}

function activeProductKey(productTypeID) {
  return toPositiveInt(productTypeID, 0);
}

function indexActiveJob(job) {
  if (!isActiveJob(job) || !job.jobID) return;
  activeJobIDs.add(job.jobID);
  const productTypeID = activeProductKey(job.productTypeID);
  if (productTypeID) {
    let jobIDs = activeJobIDsByProductTypeID.get(productTypeID);
    if (!jobIDs) {
      jobIDs = new Set();
      activeJobIDsByProductTypeID.set(productTypeID, jobIDs);
    }
    jobIDs.add(job.jobID);
  }
  const blueprintAssetID = String(job.blueprintAssetID || "").trim();
  if (blueprintAssetID) activeBlueprintAssetIDs.add(blueprintAssetID);
  if (String(job.status || "") === "reserving") reservingJobIDs.add(job.jobID);
}

function unindexActiveJob(job) {
  if (!job || !job.jobID) return;
  activeJobIDs.delete(job.jobID);
  reservingJobIDs.delete(job.jobID);
  const productTypeID = activeProductKey(job.productTypeID);
  const productJobIDs = activeJobIDsByProductTypeID.get(productTypeID);
  if (productJobIDs) {
    productJobIDs.delete(job.jobID);
    if (productJobIDs.size <= 0) activeJobIDsByProductTypeID.delete(productTypeID);
  }
  const blueprintAssetID = String(job.blueprintAssetID || "").trim();
  if (blueprintAssetID) {
    const stillActive = [...activeJobIDs].some((jobID) => (
      String(indexedIndustryJobs && indexedIndustryJobs[jobID] &&
        indexedIndustryJobs[jobID].blueprintAssetID || "").trim() === blueprintAssetID
    ));
    if (!stillActive) activeBlueprintAssetIDs.delete(blueprintAssetID);
  }
}

function getActiveProductJobs(economyState, productTypeID) {
  ensureCompletionSchedule(economyState);
  const jobIDs = activeJobIDsByProductTypeID.get(activeProductKey(productTypeID));
  if (!jobIDs) return [];
  return [...jobIDs]
    .map((jobID) => economyState.industryJobs[jobID])
    .filter(isActiveJob);
}

function getCompletionDueAtMs(job, nowMs = Date.now()) {
  const status = String(job && job.status || "");
  if (status === "running") {
    return Math.max(0, toFiniteNumber(job.endsAtMs, 0));
  }
  if (status === "output_pending") {
    return Math.max(
      toFiniteNumber(job.endsAtMs, 0),
      toFiniteNumber(job.nextCompletionAttemptAtMs, nowMs),
    );
  }
  return 0;
}

function scheduleCompletion(job, nowMs = Date.now()) {
  const dueAtMs = getCompletionDueAtMs(job, nowMs);
  if (!job || !job.jobID || dueAtMs <= 0) {
    if (job && job.jobID) completionDeadlineQueue.remove(job.jobID);
    return false;
  }
  completionDeadlineQueue.schedule(job.jobID, dueAtMs, null);
  completionScheduleMetrics.schedules += 1;
  return true;
}

function rebuildCompletionSchedule(economyState, nowMs = Date.now()) {
  const jobs = ensureIndustryState(economyState);
  completionDeadlineQueue.clear();
  activeJobIDs.clear();
  activeJobIDsByProductTypeID.clear();
  activeBlueprintAssetIDs.clear();
  reservingJobIDs.clear();
  for (const job of Object.values(jobs)) {
    scheduleCompletion(job, nowMs);
    indexActiveJob(job);
  }
  indexedIndustryJobs = jobs;
  nextCompletedJobPruneAtMs = 0;
  completionScheduleMetrics.rebuilds += 1;
}

function ensureCompletionSchedule(economyState, nowMs = Date.now()) {
  const jobs = ensureIndustryState(economyState);
  if (indexedIndustryJobs !== jobs) rebuildCompletionSchedule(economyState, nowMs);
  return completionDeadlineQueue;
}

function getProductionCandidateRuns(details = {}) {
  const recipe = details.recipe || {};
  const productQuantityPerRun = Math.max(
    1,
    toPositiveInt(recipe.productQuantityPerRun, 1),
  );
  const shortage = Math.max(1, toPositiveInt(details.shortage, 1));
  const preferredOutput = Math.max(
    productQuantityPerRun,
    toPositiveInt(details.preferredOutput, productQuantityPerRun),
  );
  const maximumRunsByDuration = Math.max(
    1,
    toPositiveInt(details.maximumRunsByDuration, 1),
  );
  // A military loss needs the first replacement hull, not a warehouse batch.
  // Normal stock-driven ship production and all non-ship production retain
  // their existing batch calculation.
  const incrementalHullLimit = (
    details.demandDriven === true &&
    details.good &&
    details.good.category === catalog.CATEGORY.SHIP
  )
    ? 1
    : Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.min(
    Math.ceil(shortage / productQuantityPerRun),
    Math.ceil(preferredOutput / productQuantityPerRun),
    maximumRunsByDuration,
    incrementalHullLimit,
  ));
}

function hasActiveProductJob(economyState, stationID, productTypeID) {
  return getActiveProductJobs(economyState, productTypeID).some((job) => (
    Number(job.stationID) === Number(stationID) &&
    Number(job.productTypeID) === Number(productTypeID)
  ));
}

function buildPriorityInputReservations(priorityRequirements = []) {
  const reservationsByStation = new Map();
  const comparePriority = (left, right) => (
    Number(String(right.outputRequirementKind || "") === "hull") -
      Number(String(left.outputRequirementKind || "") === "hull") ||
    (
      toPositiveInt(left.demandCreatedAtMs, Number.MAX_SAFE_INTEGER) -
      toPositiveInt(right.demandCreatedAtMs, Number.MAX_SAFE_INTEGER)
    ) ||
    toPositiveInt(left.outputTypeID, 0) - toPositiveInt(right.outputTypeID, 0)
  );
  for (const requirement of Array.isArray(priorityRequirements)
    ? priorityRequirements
    : []) {
    if (String(requirement && requirement.demandKind || "") !== "production_input") {
      continue;
    }
    const stationID = toPositiveInt(requirement && requirement.stationID, 0);
    const materialTypeID = toPositiveInt(requirement && requirement.typeID, 0);
    const outputTypeID = toPositiveInt(requirement && requirement.outputTypeID, 0);
    const remainingQuantity = toPositiveInt(
      requirement && requirement.remainingQuantity,
      0,
    );
    if (!stationID || !materialTypeID || !outputTypeID || !remainingQuantity) {
      continue;
    }
    if (!reservationsByStation.has(stationID)) {
      reservationsByStation.set(stationID, new Map());
    }
    const stationReservations = reservationsByStation.get(stationID);
    const next = {
      materialTypeID,
      outputTypeID,
      outputRequirementKind: String(
        requirement.outputRequirementKind || "",
      ),
      demandCreatedAtMs: toPositiveInt(
        requirement.demandCreatedAtMs,
        Number.MAX_SAFE_INTEGER,
      ),
      remainingQuantity,
    };
    const current = stationReservations.get(materialTypeID);
    if (!current || comparePriority(next, current) < 0) {
      stationReservations.set(materialTypeID, next);
    } else if (current.outputTypeID === outputTypeID) {
      current.remainingQuantity = Math.max(
        current.remainingQuantity,
        remainingQuantity,
      );
    }
  }
  return reservationsByStation;
}

function getPriorityInputReserveByTypeID(
  reservationsByStation,
  stationID,
  candidateOutputTypeID,
) {
  const result = new Map();
  const stationReservations = reservationsByStation instanceof Map
    ? reservationsByStation.get(Number(stationID))
    : null;
  if (!(stationReservations instanceof Map)) return result;
  for (const [materialTypeID, reservation] of stationReservations.entries()) {
    if (Number(reservation.outputTypeID) === Number(candidateOutputTypeID)) {
      continue;
    }
    result.set(
      Number(materialTypeID),
      toPositiveInt(reservation.remainingQuantity, 0),
    );
  }
  return result;
}

function buildCandidate(economyState, stockMap, getStockRow, station, good, nowMs, options = {}) {
  const recipe = getRecipe(good);
  if (!recipe) return null;
  const activeStationJobs = getActiveProductJobs(economyState, good.typeID)
    .filter((job) => Number(job.stationID) === Number(station.stationID));
  if (activeStationJobs.length > 0) {
    // Demand-driven hull replacement may run several one-hull lines side by
    // side at the same producer; everything else keeps the legacy rule of
    // one active job per station and product.
    const parallelHullEligible =
      toPositiveInt(options.priorityDemandUnits, 0) > 0 &&
      good.category === catalog.CATEGORY.SHIP &&
      activeStationJobs.every(
        (job) =>
          String(job.activity || ACTIVITY.MANUFACTURING) ===
            ACTIVITY.MANUFACTURING,
      ) &&
      activeStationJobs.length < getMaxParallelHullLines();
    if (!parallelHullEligible) return null;
  }
  const producerCeiling = catalog.getProducerCeiling(station, good);
  if (producerCeiling <= 0) return null;
  const productRow = getStockRow(stockMap, station.stationID, good.typeID);
  const currentQuantity = toPositiveInt(productRow && productRow.quantity, 0);
  const normalShortage = Math.max(0, producerCeiling - currentQuantity);
  const priorityDemandUnits = toPositiveInt(options.priorityDemandUnits, 0);
  const demandDriven = priorityDemandUnits > 0;
  if (catalog.isPirateFactionHull(good) && !demandDriven) return null;
  if (
    !demandDriven &&
    (normalShortage <= 0 || currentQuantity >= Math.round(producerCeiling * 0.7))
  ) return null;
  const shortage = demandDriven ? priorityDemandUnits : normalShortage;
  const clockKey = stockKey(station.stationID, good.typeID);
  if (nowMs - toFiniteNumber(economyState.productionClocks[clockKey], 0) < getInstallIntervalMs()) {
    return null;
  }
  const productionMultiplier = catalog.getProductionMultiplier(station, good.category);
  const preferredOutput = Math.max(
    recipe.productQuantityPerRun,
    Math.round(toPositiveInt(good.productionBatch, 1) * productionMultiplier),
  );
  const maximumRunsByDuration = Math.max(
    1,
    Math.floor(getMaximumJobSeconds() / recipe.timePerRunSeconds),
  );
  const runs = getProductionCandidateRuns({
    demandDriven,
    good,
    recipe,
    shortage,
    preferredOutput,
    maximumRunsByDuration,
  });
  const inputs = recipe.materials.map((material) => {
    const quantity = material.quantityPerRun * runs;
    const row = getStockRow(stockMap, station.stationID, material.typeID);
    const materialGood = catalog.getGood(material.typeID);
    const available = toPositiveInt(row && row.quantity, 0);
    const reservedForPriorityDemand = Math.min(
      available,
      toPositiveInt(
        options.priorityInputReserveByTypeID instanceof Map
          ? options.priorityInputReserveByTypeID.get(Number(material.typeID))
          : 0,
        0,
      ),
    );
    const unitValue = Math.max(
      0.01,
      toFiniteNumber(row && row.price, materialGood && materialGood.priceAnchor || 0.01),
    );
    return {
      typeID: material.typeID,
      typeName: material.typeName,
      quantity,
      unitValue,
      valueISK: roundMoney(quantity * unitValue),
      available,
      reservedForPriorityDemand,
      availableForCandidate: Math.max(0, available - reservedForPriorityDemand),
    };
  });
  if (inputs.some((entry) => entry.availableForCandidate < entry.quantity)) return null;
  const outputQuantity = recipe.productQuantityPerRun * runs;
  const durationSeconds = Math.max(
    1,
    Math.round(recipe.timePerRunSeconds * runs * getTimeScale()),
  );
  return {
    station,
    good,
    recipe,
    runs,
    inputs,
    outputQuantity,
    durationSeconds,
    shortage,
    normalShortage,
    priorityDemandUnits,
    demandDriven,
    producerCeiling,
    score:
      (demandDriven ? 1_000_000_000 : 0) +
      (
        demandDriven && String(options.priorityRequirementKind || "") === "hull"
          ? 50_000_000
          : 0
      ) +
      ((shortage / Math.max(1, producerCeiling)) * 100) +
      (productionMultiplier * 10) +
      (String(station.hubTier || "") === "regional" ? 12 : 0),
  };
}

async function buildCandidates(economyState, stockMap, getStockRow, nowMs, options = {}) {
  const candidates = [];
  const stations = Array.isArray(options.stations) && options.stations.length > 0
    ? options.stations
    : catalog.STATIONS;
  const workBudget = options.workBudget;
  const requestedByTypeID = new Map();
  const preferredProducerByTypeID = new Map();
  const priorityRequirementKindByTypeID = new Map();
  const priorityInputReservations = buildPriorityInputReservations(
    options.priorityRequirements,
  );
  for (const requirement of Array.isArray(options.priorityRequirements)
    ? options.priorityRequirements
    : []) {
    const typeID = toPositiveInt(requirement && requirement.typeID, 0);
    const remaining = toPositiveInt(requirement && requirement.remainingQuantity, 0);
    const good = catalog.getGood(typeID);
    if (
      !typeID ||
      !remaining ||
      !good ||
      catalog.isMineralGood(good) ||
      (
        String(requirement && requirement.demandKind || "") === "production_input" &&
        !getRecipe(good)
      )
    ) continue;
    requestedByTypeID.set(typeID, toPositiveInt(requestedByTypeID.get(typeID), 0) + remaining);
    const requirementKind = String(
      requirement.requirementKind || requirement.outputRequirementKind || "",
    );
    if (
      requirementKind === "hull" ||
      !priorityRequirementKindByTypeID.has(typeID)
    ) {
      priorityRequirementKindByTypeID.set(typeID, requirementKind);
    }
    const preferredProducerStationID = toPositiveInt(
      requirement && requirement.preferredProducerStationID,
      0,
    );
    if (preferredProducerStationID && !preferredProducerByTypeID.has(typeID)) {
      preferredProducerByTypeID.set(typeID, preferredProducerStationID);
    }
  }
  const priorityDeficitByTypeID = new Map();
  for (const [typeID, requested] of requestedByTypeID.entries()) {
    const activeProductJobs = getActiveProductJobs(economyState, typeID);
    // A science job is already preparing this product's blueprint chain. Do
    // not start the same emergency line at several factories on later pulses.
    if (activeProductJobs.some((job) => String(job.activity) !== ACTIVITY.MANUFACTURING)) {
      continue;
    }
    let available = 0;
    for (const station of catalog.STATIONS) {
      available += toPositiveInt(getStockRow(stockMap, station.stationID, typeID).quantity, 0);
    }
    for (const job of activeProductJobs) {
      if (Number(job.productTypeID) === typeID && String(job.activity) === ACTIVITY.MANUFACTURING) {
        available += toPositiveInt(job.productQuantity, 0);
      }
    }
    const deficit = Math.max(0, requested - available);
    if (deficit > 0) priorityDeficitByTypeID.set(typeID, deficit);
  }
  let scannedRows = 0;
  for (const station of stations) {
    for (const good of catalog.GOODS) {
      if (catalog.isMineralGood(good) || toPositiveInt(good.productionBatch, 0) <= 0) continue;
      const candidate = buildCandidate(
        economyState,
        stockMap,
        getStockRow,
        station,
        good,
        nowMs,
        {
          priorityDemandUnits: priorityDeficitByTypeID.get(good.typeID) || 0,
          priorityRequirementKind:
            priorityRequirementKindByTypeID.get(good.typeID) || "",
          priorityInputReserveByTypeID: getPriorityInputReserveByTypeID(
            priorityInputReservations,
            station.stationID,
            good.typeID,
          ),
        },
      );
      if (candidate) candidates.push(candidate);
      scannedRows += 1;
      if (
        workBudget &&
        typeof workBudget.checkpoint === "function" &&
        scannedRows % 128 === 0
      ) {
        await workBudget.checkpoint();
      }
    }
  }
  // Normal stock planning is region-sharded, but an explicit military or
  // campaign shortage must not wait for every region to take a turn. Find one
  // viable producer anywhere in the modeled network for each uncovered type;
  // the ordinary bounded install limit still controls how many lines start.
  for (const [typeID, priorityDemandUnits] of priorityDeficitByTypeID.entries()) {
    if (candidates.some((candidate) => (
      candidate.demandDriven && Number(candidate.good.typeID) === typeID
    ))) continue;
    const good = catalog.getGood(typeID);
    if (!good || !getRecipe(good)) continue;
    const priorityStations = [...catalog.STATIONS].sort((left, right) => (
      Number(Number(left.stationID) === preferredProducerByTypeID.get(typeID)) * -1 -
        Number(Number(right.stationID) === preferredProducerByTypeID.get(typeID)) * -1 ||
      catalog.getProducerCeiling(right, good) - catalog.getProducerCeiling(left, good) ||
      Number(left.stationID) - Number(right.stationID)
    ));
    for (const station of priorityStations) {
      scannedRows += 1;
      if (workBudget && scannedRows % 64 === 0) await workBudget.checkpoint();
      const candidate = buildCandidate(
        economyState,
        stockMap,
        getStockRow,
        station,
        good,
        nowMs,
        {
          priorityDemandUnits,
          priorityRequirementKind:
            priorityRequirementKindByTypeID.get(good.typeID) || "",
          priorityInputReserveByTypeID: getPriorityInputReserveByTypeID(
            priorityInputReservations,
            station.stationID,
            good.typeID,
          ),
        },
      );
      if (!candidate) continue;
      candidates.push(candidate);
      break;
    }
  }
  return candidates.sort((left, right) => (
    right.score - left.score ||
    Number(left.station.stationID) - Number(right.station.stationID) ||
    Number(left.good.typeID) - Number(right.good.typeID)
  ));
}

function listBlueprints(economyState, stationID, blueprintTypeID) {
  ensureIndustryState(economyState);
  return Object.values(economyState.industryBlueprints).filter((blueprint) => (
    Number(blueprint.stationID) === Number(stationID) &&
    Number(blueprint.blueprintTypeID) === Number(blueprintTypeID)
  ));
}

function createBlueprintAsset(economyState, details, nowMs) {
  ensureIndustryState(economyState);
  const number = economyState.nextIndustryBlueprintNumber++;
  const blueprintAssetID = `LEB-${String(number).padStart(9, "0")}`;
  const blueprint = {
    blueprintAssetID,
    corporationID: toPositiveInt(details.corporationID, 0),
    stationID: toPositiveInt(details.stationID, 0),
    systemID: toPositiveInt(details.systemID, 0),
    blueprintTypeID: toPositiveInt(details.blueprintTypeID, 0),
    blueprintName: String(details.blueprintName || "Blueprint"),
    productTypeID: toPositiveInt(details.productTypeID, 0),
    productTypeName: String(details.productTypeName || "Product"),
    original: details.original === true,
    materialEfficiency: Math.max(0, Math.min(10, Math.trunc(Number(details.materialEfficiency) || 0))),
    timeEfficiency: Math.max(0, Math.min(20, Math.trunc(Number(details.timeEfficiency) || 0))),
    runsRemaining: details.original === true
      ? null
      : Math.max(1, toPositiveInt(details.runsRemaining, 1)),
    inUseByJobID: null,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  economyState.industryBlueprints[blueprintAssetID] = blueprint;
  return blueprint;
}

function ensureBlueprintOriginal(economyState, candidate, nowMs) {
  const existing = listBlueprints(
    economyState,
    candidate.station.stationID,
    candidate.recipe.blueprintTypeID,
  ).find((blueprint) => blueprint.original === true);
  if (existing) return existing;
  const original = createBlueprintAsset(economyState, {
    corporationID: getStationCorporationID(candidate.station),
    stationID: candidate.station.stationID,
    systemID: candidate.station.systemID,
    blueprintTypeID: candidate.recipe.blueprintTypeID,
    blueprintName: candidate.recipe.blueprintName,
    productTypeID: candidate.good.typeID,
    productTypeName: candidate.good.name,
    original: true,
    // Established NPC corporations begin with a serviceable library, then their
    // researchers finish the long grind instead of conjuring perfect blueprints.
    materialEfficiency: 6,
    timeEfficiency: 10,
  }, nowMs);
  economyState.metrics.industryBlueprintOriginalsAcquired =
    toFiniteNumber(economyState.metrics.industryBlueprintOriginalsAcquired, 0) + 1;
  return original;
}

function findUsableCopy(economyState, candidate) {
  return listBlueprints(
    economyState,
    candidate.station.stationID,
    candidate.recipe.blueprintTypeID,
  ).filter((blueprint) => (
    blueprint.original !== true &&
    !String(blueprint.inUseByJobID || "").trim() &&
    toPositiveInt(blueprint.runsRemaining, 0) >= candidate.runs
  )).sort((left, right) => (
    toPositiveInt(left.runsRemaining, 0) - toPositiveInt(right.runsRemaining, 0) ||
    String(left.blueprintAssetID).localeCompare(String(right.blueprintAssetID))
  ))[0] || null;
}

function hasActiveBlueprintJob(economyState, blueprintAssetID) {
  ensureCompletionSchedule(economyState);
  return activeBlueprintAssetIDs.has(String(blueprintAssetID || "").trim());
}

function materialQuantityForBlueprint(material, runs, materialEfficiency) {
  return Math.max(
    runs,
    Math.ceil(material.quantityPerRun * runs * (1 - (Math.max(0, materialEfficiency) / 100))),
  );
}

function buildManufacturingInputs(candidate, blueprint, stockMap, getStockRow) {
  return candidate.recipe.materials.map((material) => {
    const quantity = materialQuantityForBlueprint(
      material,
      candidate.runs,
      toFiniteNumber(blueprint.materialEfficiency, 0),
    );
    const row = getStockRow(stockMap, candidate.station.stationID, material.typeID);
    const materialGood = catalog.getGood(material.typeID);
    const available = toPositiveInt(row && row.quantity, 0);
    const plannedInput = Array.isArray(candidate.inputs)
      ? candidate.inputs.find(
          (entry) => Number(entry.typeID) === Number(material.typeID),
        )
      : null;
    const reservedForPriorityDemand = Math.min(
      available,
      toPositiveInt(
        plannedInput && plannedInput.reservedForPriorityDemand,
        0,
      ),
    );
    const unitValue = Math.max(
      0.01,
      toFiniteNumber(row && row.price, materialGood && materialGood.priceAnchor || 0.01),
    );
    return {
      typeID: material.typeID,
      typeName: material.typeName,
      quantity,
      unitValue,
      valueISK: roundMoney(quantity * unitValue),
      available,
      reservedForPriorityDemand,
      availableForCandidate: Math.max(0, available - reservedForPriorityDemand),
    };
  });
}

function makeIndustryJobID(economyState) {
  ensureIndustryState(economyState);
  let number = reconcileIndustryJobCounter(economyState);
  let jobID = `LEI-${String(number).padStart(8, "0")}`;
  while (Object.prototype.hasOwnProperty.call(economyState.industryJobs, jobID)) {
    number += 1;
    jobID = `LEI-${String(number).padStart(8, "0")}`;
  }
  economyState.nextIndustryJobNumber = number + 1;
  industryJobCounterFloors.set(economyState, number + 1);
  return jobID;
}

function makeIndustryAdjustmentID(economyState, job, phase, typeID) {
  const sourceEpochMs = toPositiveInt(economyState && economyState.createdAtMs, 0);
  if (
    toPositiveInt(job && job.adjustmentNamespaceVersion, 1) <
      INDUSTRY_ADJUSTMENT_NAMESPACE_VERSION
  ) {
    return `living-industry:${sourceEpochMs}:` +
      `${job.jobID}:${job.stationID}:${phase}:${typeID}`;
  }
  const jobCreatedAtMs = toPositiveInt(
    job && job.createdAtMs,
    Math.max(1, sourceEpochMs),
  );
  return `living-industry-v2:${sourceEpochMs}:${jobCreatedAtMs}:` +
    `${job.jobID}:${job.stationID}:${job.productTypeID}:${phase}:${typeID}`;
}

function getAdjustmentCollisionMessage(result) {
  return String(
    result && result.error && result.error.message ||
    result && result.errorMsg ||
    "",
  );
}

function isAdjustmentIdentityCollision(result) {
  return /seed stock adjustment id was already used (?:for|with) a different/i.test(
    getAdjustmentCollisionMessage(result),
  );
}

function promoteLegacyAdjustmentNamespace(economyState, job, result, nowMs) {
  if (
    toPositiveInt(job && job.adjustmentNamespaceVersion, 1) >=
      INDUSTRY_ADJUSTMENT_NAMESPACE_VERSION ||
    !isAdjustmentIdentityCollision(result)
  ) {
    return false;
  }
  job.adjustmentNamespaceVersion = INDUSTRY_ADJUSTMENT_NAMESPACE_VERSION;
  job.adjustmentNamespaceMigratedAtMs = nowMs;
  economyState.metrics.industryAdjustmentNamespaceMigrations =
    toFiniteNumber(economyState.metrics.industryAdjustmentNamespaceMigrations, 0) + 1;
  return true;
}

function quarantineAdjustmentConflict(economyState, job, result, nowMs) {
  if (!isAdjustmentIdentityCollision(result)) return false;
  if (String(job && job.status) === "adjustment_conflict") return true;
  unindexActiveJob(job);
  reservingJobIDs.delete(job.jobID);
  job.status = "adjustment_conflict";
  job.lastError = getAdjustmentCollisionMessage(result) ||
    "industry-adjustment-identity-conflict";
  job.adjustmentConflictAtMs = nowMs;
  job.updatedAtMs = nowMs;
  delete job.nextCompletionAttemptAtMs;
  releaseBlueprint(economyState, job, nowMs);
  economyState.metrics.industryAdjustmentConflictsQuarantined =
    toFiniteNumber(economyState.metrics.industryAdjustmentConflictsQuarantined, 0) + 1;
  return true;
}

function handleAdjustmentIdentityCollision(
  economyState,
  job,
  result,
  nowMs,
  attemptedAdjustmentID = "",
) {
  if (!isAdjustmentIdentityCollision(result)) return null;
  const attemptedV2 = String(attemptedAdjustmentID).startsWith(
    "living-industry-v2:",
  );
  if (!attemptedV2) {
    promoteLegacyAdjustmentNamespace(economyState, job, result, nowMs);
    return "promoted";
  }
  quarantineAdjustmentConflict(economyState, job, result, nowMs);
  return "quarantined";
}

function createBlueprintJob(economyState, candidate, original, activity, pilot, nowMs) {
  ensureCompletionSchedule(economyState, nowMs);
  const jobID = makeIndustryJobID(economyState);
  const recipe = candidate.recipe;
  let durationSeconds = 1;
  let targetLevel = 0;
  let copyRuns = 0;
  if (activity === ACTIVITY.RESEARCH_MATERIAL) {
    targetLevel = BLUEPRINT_TARGET_ME;
    const levels = Math.max(1, targetLevel - toFiniteNumber(original.materialEfficiency, 0));
    durationSeconds = recipe.materialResearchTimeSeconds * levels;
  } else if (activity === ACTIVITY.RESEARCH_TIME) {
    targetLevel = BLUEPRINT_TARGET_TE;
    const steps = Math.max(1, Math.ceil((targetLevel - toFiniteNumber(original.timeEfficiency, 0)) / 2));
    durationSeconds = recipe.timeResearchTimeSeconds * steps;
  } else {
    copyRuns = Math.max(1, Math.min(recipe.maxProductionLimit, candidate.runs));
    durationSeconds = recipe.copyingTimeSeconds * (copyRuns / recipe.maxProductionLimit);
  }
  // War-economy mobilization: science for demand-driven (replacement/campaign)
  // products runs on the war clock — foundation-bridge research/copy times
  // otherwise serialize hull lines for days. Normal blueprint upkeep keeps
  // peacetime pacing.
  const scienceWarScale = candidate.demandDriven === true
    ? mobilization.getWarTimeScale()
    : 1;
  durationSeconds = Math.max(1, Math.round(
    durationSeconds * workforce.scienceTimeMultiplier(pilot, activity) *
    getTimeScale() * scienceWarScale,
  ));
  const job = {
    jobID,
    status: "running",
    activity,
    activityGroup: "science",
    pilotID: pilot.pilotID,
    pilotName: pilot.name,
    corporationID: getStationCorporationID(candidate.station),
    stationID: candidate.station.stationID,
    systemID: candidate.station.systemID,
    blueprintAssetID: original.blueprintAssetID,
    blueprintTypeID: recipe.blueprintTypeID,
    blueprintName: recipe.blueprintName,
    productTypeID: candidate.good.typeID,
    productTypeName: candidate.good.name,
    targetLevel,
    copyRuns,
    runs: copyRuns,
    durationSeconds,
    adjustmentNamespaceVersion: INDUSTRY_ADJUSTMENT_NAMESPACE_VERSION,
    createdAtMs: nowMs,
    startedAtMs: nowMs,
    endsAtMs: nowMs + (durationSeconds * 1_000),
    updatedAtMs: nowMs,
  };
  economyState.industryJobs[jobID] = job;
  indexActiveJob(job);
  scheduleCompletion(job, nowMs);
  original.inUseByJobID = jobID;
  original.updatedAtMs = nowMs;
  pilot.lastAssignedAtMs = nowMs;
  economyState.metrics.industryJobsInstalled += 1;
  economyState.metrics.industryBlueprintSecondsScheduled += durationSeconds;
  return job;
}

function createManufacturingJob(economyState, candidate, blueprint, pilot, stockMap, getStockRow, nowMs) {
  ensureCompletionSchedule(economyState, nowMs);
  const inputs = buildManufacturingInputs(candidate, blueprint, stockMap, getStockRow);
  if (inputs.some((entry) => entry.availableForCandidate < entry.quantity)) return null;
  const jobID = makeIndustryJobID(economyState);
  const timeEfficiencyMultiplier = 1 - (Math.max(0, toFiniteNumber(blueprint.timeEfficiency, 0)) / 100);
  // War-economy mobilization: demand-driven jobs (replacement/campaign
  // production) run on the war clock; normal stock-driven production keeps
  // peacetime pacing so surging war output cannot flood civilian markets.
  const manufacturingWarScale = candidate.demandDriven === true
    ? mobilization.getWarTimeScale()
    : 1;
  const durationSeconds = Math.max(1, Math.round(
    candidate.recipe.timePerRunSeconds * candidate.runs * timeEfficiencyMultiplier *
    workforce.manufacturingTimeMultiplier(pilot) * getTimeScale() * manufacturingWarScale,
  ));
  const job = {
    jobID,
    status: "reserving",
    activity: ACTIVITY.MANUFACTURING,
    activityGroup: "manufacturing",
    pilotID: pilot.pilotID,
    pilotName: pilot.name,
    corporationID: getStationCorporationID(candidate.station),
    stationID: candidate.station.stationID,
    systemID: candidate.station.systemID,
    blueprintAssetID: blueprint.blueprintAssetID,
    blueprintTypeID: candidate.recipe.blueprintTypeID,
    blueprintName: candidate.recipe.blueprintName,
    blueprintMaterialEfficiency: blueprint.materialEfficiency,
    blueprintTimeEfficiency: blueprint.timeEfficiency,
    productTypeID: candidate.good.typeID,
    productTypeName: candidate.good.name,
    productQuantity: candidate.outputQuantity,
    productQuantityPerRun: candidate.recipe.productQuantityPerRun,
    runs: candidate.runs,
    timePerRunSeconds: candidate.recipe.timePerRunSeconds,
    durationSeconds,
    inputs: inputs.map((entry) => ({
      typeID: entry.typeID,
      typeName: entry.typeName,
      quantity: entry.quantity,
      unitValue: entry.unitValue,
      valueISK: entry.valueISK,
    })),
    reservedInputTypeIDs: [],
    inputValueISK: roundMoney(inputs.reduce((sum, entry) => sum + entry.valueISK, 0)),
    outputValueISK: roundMoney(candidate.outputQuantity * candidate.good.priceAnchor),
    adjustmentNamespaceVersion: INDUSTRY_ADJUSTMENT_NAMESPACE_VERSION,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  economyState.industryJobs[jobID] = job;
  indexActiveJob(job);
  economyState.productionClocks[stockKey(job.stationID, job.productTypeID)] = nowMs;
  blueprint.inUseByJobID = jobID;
  blueprint.updatedAtMs = nowMs;
  pilot.lastAssignedAtMs = nowMs;
  return job;
}

function createJob(economyState, candidate, nowMs) {
  ensureIndustryState(economyState);
  ensureCompletionSchedule(economyState, nowMs);
  const jobID = makeIndustryJobID(economyState);
  const corporationID = getStationCorporationID(candidate.station);
  const job = {
    jobID,
    status: "reserving",
    corporationID,
    stationID: candidate.station.stationID,
    systemID: candidate.station.systemID,
    blueprintTypeID: candidate.recipe.blueprintTypeID,
    blueprintName: candidate.recipe.blueprintName,
    productTypeID: candidate.good.typeID,
    productTypeName: candidate.good.name,
    productQuantity: candidate.outputQuantity,
    productQuantityPerRun: candidate.recipe.productQuantityPerRun,
    runs: candidate.runs,
    timePerRunSeconds: candidate.recipe.timePerRunSeconds,
    durationSeconds: candidate.durationSeconds,
    inputs: candidate.inputs.map((entry) => ({
      typeID: entry.typeID,
      typeName: entry.typeName,
      quantity: entry.quantity,
      unitValue: entry.unitValue,
      valueISK: entry.valueISK,
    })),
    reservedInputTypeIDs: [],
    inputValueISK: roundMoney(candidate.inputs.reduce((sum, entry) => sum + entry.valueISK, 0)),
    outputValueISK: roundMoney(candidate.outputQuantity * candidate.good.priceAnchor),
    adjustmentNamespaceVersion: INDUSTRY_ADJUSTMENT_NAMESPACE_VERSION,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  economyState.industryJobs[jobID] = job;
  indexActiveJob(job);
  economyState.productionClocks[stockKey(job.stationID, job.productTypeID)] = nowMs;
  return job;
}

async function reserveInputs(economyState, job, stockMap, dependencies, nowMs) {
  ensureCompletionSchedule(economyState, nowMs);
  reservingJobIDs.add(job.jobID);
  const station = catalog.getStation(job.stationID);
  const reserved = new Set(
    (Array.isArray(job.reservedInputTypeIDs) ? job.reservedInputTypeIDs : [])
      .map((value) => toPositiveInt(value, 0))
      .filter(Boolean),
  );
  const pendingInputs = [];
  for (const input of job.inputs) {
    if (reserved.has(input.typeID)) continue;
    const good = catalog.getGood(input.typeID);
    const row = dependencies.getStockRow(stockMap, job.stationID, input.typeID);
    if (!station || !good || toPositiveInt(row && row.quantity, 0) < input.quantity) {
      job.status = "reserving";
      job.lastError = `waiting-for-${input.typeID}`;
      job.updatedAtMs = nowMs;
      return false;
    }
    pendingInputs.push({
      input,
      adjustment: {
        adjustmentID: makeIndustryAdjustmentID(
          economyState,
          job,
          "input",
          input.typeID,
        ),
        station,
        good,
        deltaQuantity: -input.quantity,
        reason: `NPC industry input reservation ${job.jobID}`,
        stockMap,
      },
    });
  }
  if (pendingInputs.length > 0) {
    const results = typeof dependencies.adjustStocks === "function"
      ? await dependencies.adjustStocks(pendingInputs.map((entry) => entry.adjustment))
      : await Promise.all(
        pendingInputs.map((entry) => dependencies.adjustStock(entry.adjustment)),
      );
    let firstFailure = null;
    for (let index = 0; index < pendingInputs.length; index += 1) {
      const { input } = pendingInputs[index];
      const result = results[index];
      if (!result || !result.success) {
        handleAdjustmentIdentityCollision(
          economyState,
          job,
          result,
          nowMs,
          pendingInputs[index].adjustment.adjustmentID,
        );
        firstFailure = firstFailure || result || {
          error: new Error("input-adjustment-failed"),
        };
        continue;
      }
      reserved.add(input.typeID);
      economyState.metrics.industryInputUnitsConsumed += input.quantity;
      economyState.metrics.industryInputValueISK = roundMoney(
        economyState.metrics.industryInputValueISK + input.valueISK,
      );
    }
    job.reservedInputTypeIDs = [...reserved];
    if (firstFailure) {
      if (String(job.status) !== "adjustment_conflict") {
        job.status = "reserving";
      }
      job.lastError = firstFailure.error && firstFailure.error.message ||
        "input-adjustment-failed";
      job.updatedAtMs = nowMs;
      return false;
    }
  }
  if (job.blueprintAssetID && job.blueprintRunsCommitted !== true) {
    const blueprint = economyState.industryBlueprints[job.blueprintAssetID];
    if (
      !blueprint || blueprint.original === true ||
      toPositiveInt(blueprint.runsRemaining, 0) < toPositiveInt(job.runs, 0)
    ) {
      job.status = "reserving";
      job.lastError = "finite-blueprint-copy-runs-unavailable";
      job.updatedAtMs = nowMs;
      return false;
    }
    blueprint.runsRemaining -= job.runs;
    blueprint.updatedAtMs = nowMs;
    job.blueprintRunsCommitted = true;
    economyState.metrics.industryBlueprintCopyRunsConsumed =
      toFiniteNumber(economyState.metrics.industryBlueprintCopyRunsConsumed, 0) + job.runs;
  }
  job.status = "running";
  reservingJobIDs.delete(job.jobID);
  job.startedAtMs = nowMs;
  job.endsAtMs = nowMs + (job.durationSeconds * 1_000);
  job.updatedAtMs = nowMs;
  job.lastError = null;
  delete job.nextCompletionAttemptAtMs;
  scheduleCompletion(job, nowMs);
  economyState.metrics.industryJobsInstalled += 1;
  economyState.metrics.industryBlueprintSecondsScheduled += job.durationSeconds;
  if (typeof dependencies.addEvent === "function") {
    dependencies.addEvent("industry_job_started", null, {
      industryJobID: job.jobID,
      corporationID: job.corporationID,
      stationID: job.stationID,
      blueprintTypeID: job.blueprintTypeID,
      blueprintAssetID: job.blueprintAssetID || null,
      pilotID: job.pilotID || null,
      pilotName: job.pilotName || null,
      activity: job.activity || ACTIVITY.MANUFACTURING,
      productTypeID: job.productTypeID,
      quantity: job.productQuantity,
      runs: job.runs,
      endsAtMs: job.endsAtMs,
      inputValueISK: job.inputValueISK,
      outputValueISK: job.outputValueISK,
    }, nowMs);
  }
  return true;
}

function releaseBlueprint(economyState, job, nowMs) {
  const blueprint = economyState.industryBlueprints &&
    economyState.industryBlueprints[job.blueprintAssetID];
  if (!blueprint) return;
  if (String(blueprint.inUseByJobID || "") === String(job.jobID)) {
    blueprint.inUseByJobID = null;
    blueprint.updatedAtMs = nowMs;
  }
  if (blueprint.original !== true && toPositiveInt(blueprint.runsRemaining, 0) <= 0) {
    delete economyState.industryBlueprints[blueprint.blueprintAssetID];
  }
}

function completeBlueprintJob(economyState, job, dependencies, nowMs) {
  if (nowMs < toFiniteNumber(job.endsAtMs, 0)) return false;
  const original = economyState.industryBlueprints &&
    economyState.industryBlueprints[job.blueprintAssetID];
  if (!original || original.original !== true) {
    unindexActiveJob(job);
    job.status = "failed";
    job.lastError = "blueprint-original-missing";
    job.completedAtMs = nowMs;
    job.updatedAtMs = nowMs;
    return false;
  }
  if (job.activity === ACTIVITY.RESEARCH_MATERIAL) {
    original.materialEfficiency = Math.max(
      toFiniteNumber(original.materialEfficiency, 0),
      Math.min(10, toPositiveInt(job.targetLevel, BLUEPRINT_TARGET_ME)),
    );
    economyState.metrics.industryMaterialResearchJobsCompleted =
      toFiniteNumber(economyState.metrics.industryMaterialResearchJobsCompleted, 0) + 1;
  } else if (job.activity === ACTIVITY.RESEARCH_TIME) {
    original.timeEfficiency = Math.max(
      toFiniteNumber(original.timeEfficiency, 0),
      Math.min(20, toPositiveInt(job.targetLevel, BLUEPRINT_TARGET_TE)),
    );
    economyState.metrics.industryTimeResearchJobsCompleted =
      toFiniteNumber(economyState.metrics.industryTimeResearchJobsCompleted, 0) + 1;
  } else if (job.activity === ACTIVITY.COPYING) {
    createBlueprintAsset(economyState, {
      corporationID: original.corporationID,
      stationID: original.stationID,
      systemID: original.systemID,
      blueprintTypeID: original.blueprintTypeID,
      blueprintName: original.blueprintName,
      productTypeID: original.productTypeID,
      productTypeName: original.productTypeName,
      original: false,
      materialEfficiency: original.materialEfficiency,
      timeEfficiency: original.timeEfficiency,
      runsRemaining: Math.max(1, toPositiveInt(job.copyRuns, 1)),
    }, nowMs);
    economyState.metrics.industryBlueprintCopiesCreated =
      toFiniteNumber(economyState.metrics.industryBlueprintCopiesCreated, 0) + 1;
    economyState.metrics.industryBlueprintCopyRunsCreated =
      toFiniteNumber(economyState.metrics.industryBlueprintCopyRunsCreated, 0) +
      Math.max(1, toPositiveInt(job.copyRuns, 1));
  }
  releaseBlueprint(economyState, job, nowMs);
  unindexActiveJob(job);
  job.status = "completed";
  job.completedAtMs = nowMs;
  job.updatedAtMs = nowMs;
  job.lastError = null;
  delete job.nextCompletionAttemptAtMs;
  economyState.metrics.industryJobsCompleted += 1;
  if (typeof dependencies.addEvent === "function") {
    dependencies.addEvent("industry_job_completed", null, {
      industryJobID: job.jobID,
      activity: job.activity,
      pilotID: job.pilotID,
      pilotName: job.pilotName,
      corporationID: job.corporationID,
      stationID: job.stationID,
      blueprintTypeID: job.blueprintTypeID,
      blueprintAssetID: job.blueprintAssetID,
      productTypeID: job.productTypeID,
      copyRuns: job.copyRuns || 0,
      targetLevel: job.targetLevel || 0,
    }, nowMs);
  }
  return true;
}

function isBlueprintJob(job) {
  return Boolean(
    job && job.activity &&
    [ACTIVITY.COPYING, ACTIVITY.RESEARCH_MATERIAL, ACTIVITY.RESEARCH_TIME]
      .includes(String(job.activity)),
  );
}

function prepareManufacturingCompletion(economyState, job, stockMap, nowMs) {
  job.status = "output_pending";
  const station = catalog.getStation(job.stationID);
  const good = catalog.getGood(job.productTypeID);
  if (!station || !good) {
    job.lastError = "industry-output-definition-missing";
    job.updatedAtMs = nowMs;
    return null;
  }
  return {
    job,
    adjustment: {
      adjustmentID: makeIndustryAdjustmentID(
        economyState,
        job,
        "output",
        job.productTypeID,
      ),
      station,
      good,
      deltaQuantity: job.productQuantity,
      reason: `NPC industry completion ${job.jobID}`,
      stockMap,
    },
  };
}

function finishManufacturingCompletion(economyState, job, dependencies, nowMs) {
  unindexActiveJob(job);
  job.status = "completed";
  job.completedAtMs = nowMs;
  job.updatedAtMs = nowMs;
  job.lastError = null;
  delete job.nextCompletionAttemptAtMs;
  releaseBlueprint(economyState, job, nowMs);
  economyState.metrics.industryJobsCompleted += 1;
  economyState.metrics.industryOutputUnitsProduced += job.productQuantity;
  economyState.metrics.industryOutputValueISK = roundMoney(
    economyState.metrics.industryOutputValueISK + job.outputValueISK,
  );
  economyState.metrics.unitsProduced += job.productQuantity;
  economyState.metrics.productionRuns += job.runs;
  if (typeof dependencies.addEvent === "function") {
    dependencies.addEvent("industry_job_completed", null, {
      industryJobID: job.jobID,
      corporationID: job.corporationID,
      stationID: job.stationID,
      productTypeID: job.productTypeID,
      blueprintAssetID: job.blueprintAssetID || null,
      pilotID: job.pilotID || null,
      pilotName: job.pilotName || null,
      activity: job.activity || ACTIVITY.MANUFACTURING,
      quantity: job.productQuantity,
      outputValueISK: job.outputValueISK,
    }, nowMs);
  }
  return true;
}

async function completeJob(economyState, job, stockMap, dependencies, nowMs) {
  if (
    !["running", "output_pending"].includes(String(job.status)) ||
    nowMs < toFiniteNumber(job.endsAtMs, 0)
  ) {
    return false;
  }
  if (isBlueprintJob(job)) {
    return completeBlueprintJob(economyState, job, dependencies, nowMs);
  }
  const prepared = prepareManufacturingCompletion(economyState, job, stockMap, nowMs);
  if (!prepared) return false;
  const result = await dependencies.adjustStock(prepared.adjustment);
  if (!result.success) {
    handleAdjustmentIdentityCollision(
      economyState,
      job,
      result,
      nowMs,
      prepared.adjustment.adjustmentID,
    );
    job.lastError = result.error && result.error.message || "output-adjustment-failed";
    job.updatedAtMs = nowMs;
    return false;
  }
  return finishManufacturingCompletion(economyState, job, dependencies, nowMs);
}

function pruneJobs(economyState, nowMs) {
  const completed = Object.values(ensureIndustryState(economyState))
    .filter((job) => String(job && job.status) === "completed")
    .sort((left, right) => toFiniteNumber(right.completedAtMs, 0) - toFiniteNumber(left.completedAtMs, 0));
  for (const job of completed.slice(500)) {
    delete economyState.industryJobs[job.jobID];
  }
  for (const job of completed) {
    if (nowMs - toFiniteNumber(job.completedAtMs, nowMs) > 30 * 24 * 60 * 60 * 1_000) {
      delete economyState.industryJobs[job.jobID];
    }
  }
}

async function processDueCompletions(
  economyState,
  stockMap,
  dependencies,
  nowMs = Date.now(),
) {
  ensureIndustryState(economyState);
  ensureCompletionSchedule(economyState, nowMs);
  const workBudget = dependencies && dependencies.workBudget;
  const dueJobs = [];
  let dueEntryCount = 0;
  let completionEntry = completionDeadlineQueue.popDue(nowMs);
  while (completionEntry) {
    dueEntryCount += 1;
    const job = economyState.industryJobs[completionEntry.key];
    if (job) dueJobs.push(job);
    completionEntry = completionDeadlineQueue.popDue(nowMs);
  }
  completionScheduleMetrics.dueJobsProcessed += dueEntryCount;
  let completed = 0;
  const manufacturing = [];
  for (const job of dueJobs) {
    if (
      !["running", "output_pending"].includes(String(job.status)) ||
      nowMs < toFiniteNumber(job.endsAtMs, 0)
    ) {
      if (isActiveJob(job)) scheduleCompletion(job, nowMs);
      continue;
    }
    if (!isBlueprintJob(job)) {
      const prepared = prepareManufacturingCompletion(economyState, job, stockMap, nowMs);
      if (prepared) manufacturing.push(prepared);
      continue;
    }
    if (await completeJob(economyState, job, stockMap, dependencies, nowMs)) {
      completed += 1;
    }
    if (workBudget && typeof workBudget.checkpoint === "function") {
      await workBudget.checkpoint();
    }
  }
  if (manufacturing.length > 0) {
    completionScheduleMetrics.completionBatches += 1;
    completionScheduleMetrics.maximumCompletionBatchSize = Math.max(
      completionScheduleMetrics.maximumCompletionBatchSize,
      manufacturing.length,
    );
    let results = [];
    if (typeof dependencies.adjustStocks === "function") {
      results = await dependencies.adjustStocks(
        manufacturing.map((entry) => entry.adjustment),
      );
    } else {
      results = await Promise.all(
        manufacturing.map((entry) => dependencies.adjustStock(entry.adjustment)),
      );
    }
    for (let index = 0; index < manufacturing.length; index += 1) {
      const { job } = manufacturing[index];
      const result = results[index];
      if (result && result.success) {
        finishManufacturingCompletion(economyState, job, dependencies, nowMs);
        completed += 1;
      } else {
        handleAdjustmentIdentityCollision(
          economyState,
          job,
          result,
          nowMs,
          manufacturing[index].adjustment.adjustmentID,
        );
        job.lastError = result && result.error && result.error.message ||
          "output-adjustment-failed";
        job.updatedAtMs = nowMs;
      }
    }
  }
  for (const job of dueJobs) {
    if (String(job.status || "") === "output_pending") {
      job.nextCompletionAttemptAtMs = nowMs + COMPLETION_RETRY_MS;
      scheduleCompletion(job, nowMs);
      completionScheduleMetrics.completionFailuresRetried += 1;
    } else if (isActiveJob(job) && getCompletionDueAtMs(job, nowMs) > nowMs) {
      scheduleCompletion(job, nowMs);
    }
  }
  if (workBudget && typeof workBudget.checkpoint === "function") {
    await workBudget.checkpoint();
  }
  return completed;
}

async function process(economyState, stockMap, dependencies, nowMs = Date.now()) {
  ensureIndustryState(economyState);
  const workBudget = dependencies && dependencies.workBudget;
  const candidateStations = dependencies && dependencies.stations;
  const workforceSeed = workforce.seed(economyState, nowMs);
  const completed = await processDueCompletions(
    economyState,
    stockMap,
    dependencies,
    nowMs,
  );
  for (const jobID of [...reservingJobIDs]) {
    const job = economyState.industryJobs[jobID];
    if (!job || String(job.status) !== "reserving") {
      reservingJobIDs.delete(jobID);
      continue;
    }
    await reserveInputs(economyState, job, stockMap, dependencies, nowMs);
    if (workBudget && typeof workBudget.checkpoint === "function") await workBudget.checkpoint();
  }
  let installed = 0;
  let attempted = 0;
  let availableSlots = Math.max(0, getMaxActiveJobs() - activeJobIDs.size);
  if (availableSlots > 0) {
    const candidates = await buildCandidates(
      economyState,
      stockMap,
      dependencies.getStockRow,
      nowMs,
      {
        stations: candidateStations,
        workBudget,
        priorityRequirements: dependencies && dependencies.priorityRequirements,
      },
    );
    const priorityOutputScheduledByTypeID = new Map();
    for (const candidate of candidates) {
      if (attempted >= getMaxInstallsPerPulse() || availableSlots <= 0) break;
      if (candidate.demandDriven) {
        const alreadyScheduled = toPositiveInt(
          priorityOutputScheduledByTypeID.get(candidate.good.typeID),
          0,
        );
        if (alreadyScheduled >= candidate.priorityDemandUnits) continue;
      }
      attempted += 1;
      if (workBudget && typeof workBudget.checkpoint === "function") {
        await workBudget.checkpoint();
      }
      const copy = findUsableCopy(economyState, candidate);
      if (copy) {
        const pilot = workforce.choosePilot(
          economyState,
          candidate.station.stationID,
          "manufacturing",
        );
        if (!pilot) continue;
        const job = createManufacturingJob(
          economyState,
          candidate,
          copy,
          pilot,
          stockMap,
          dependencies.getStockRow,
          nowMs,
        );
        if (!job) continue;
        if (candidate.demandDriven) {
          priorityOutputScheduledByTypeID.set(
            candidate.good.typeID,
            toPositiveInt(priorityOutputScheduledByTypeID.get(candidate.good.typeID), 0) +
              toPositiveInt(candidate.outputQuantity, 0),
          );
        }
        availableSlots -= 1;
        if (await reserveInputs(economyState, job, stockMap, dependencies, nowMs)) {
          installed += 1;
        }
        continue;
      }
      const original = ensureBlueprintOriginal(economyState, candidate, nowMs);
      if (String(original.inUseByJobID || "").trim() ||
          hasActiveBlueprintJob(economyState, original.blueprintAssetID)) continue;
      const pilot = workforce.choosePilot(
        economyState,
        candidate.station.stationID,
        "science",
      );
      if (!pilot) continue;
      const activity = toFiniteNumber(original.materialEfficiency, 0) < BLUEPRINT_TARGET_ME
        ? ACTIVITY.RESEARCH_MATERIAL
        : toFiniteNumber(original.timeEfficiency, 0) < BLUEPRINT_TARGET_TE
          ? ACTIVITY.RESEARCH_TIME
          : ACTIVITY.COPYING;
      const job = createBlueprintJob(
        economyState,
        candidate,
        original,
        activity,
        pilot,
        nowMs,
      );
      if (candidate.demandDriven) {
        priorityOutputScheduledByTypeID.set(
          candidate.good.typeID,
          toPositiveInt(priorityOutputScheduledByTypeID.get(candidate.good.typeID), 0) +
            toPositiveInt(candidate.outputQuantity, 0),
        );
      }
      availableSlots -= 1;
      installed += 1;
      if (typeof dependencies.addEvent === "function") {
        dependencies.addEvent("industry_job_started", null, {
          industryJobID: job.jobID,
          activity: job.activity,
          pilotID: job.pilotID,
          pilotName: job.pilotName,
          corporationID: job.corporationID,
          stationID: job.stationID,
          blueprintTypeID: job.blueprintTypeID,
          blueprintAssetID: job.blueprintAssetID,
          productTypeID: job.productTypeID,
          copyRuns: job.copyRuns || 0,
          targetLevel: job.targetLevel || 0,
          endsAtMs: job.endsAtMs,
        }, nowMs);
      }
    }
  }
  // Cap-saturation observability (W1): the install budget counts ATTEMPTS
  // (doomed candidates included), so a saturated pulse means the budget — not
  // candidate supply — bounded this pulse's industry starts.
  if (attempted >= getMaxInstallsPerPulse() && economyState.metrics) {
    economyState.metrics.industryInstallBudgetSaturatedPulses =
      Math.max(0, Math.trunc(Number(
        economyState.metrics.industryInstallBudgetSaturatedPulses,
      ) || 0)) + 1;
  }
  if (nowMs >= nextCompletedJobPruneAtMs) {
    pruneJobs(economyState, nowMs);
    nextCompletedJobPruneAtMs = nowMs + COMPLETED_JOB_PRUNE_INTERVAL_MS;
    completionScheduleMetrics.pruneRuns += 1;
  }
  return {
    installed,
    completed,
    activeJobs: activeJobIDs.size,
    workforceCreated: workforceSeed.created,
  };
}

function getNextWakeAtMs(economyState, nowMs = Date.now()) {
  const queue = ensureCompletionSchedule(economyState, nowMs);
  const next = queue.peek();
  return next ? Math.max(nowMs, next.dueAtMs) : Number.POSITIVE_INFINITY;
}

function getStatus(economyState, nowMs = Date.now()) {
  ensureCompletionSchedule(economyState, nowMs);
  const statuses = {};
  const activities = {};
  let nextCompletionAtMs = 0;
  for (const jobID in ensureIndustryState(economyState)) {
    const job = economyState.industryJobs[jobID];
    const key = String(job && job.status || "unknown");
    statuses[key] = (statuses[key] || 0) + 1;
    if (isActiveJob(job)) {
      const activity = String(job.activity || ACTIVITY.MANUFACTURING);
      activities[activity] = (activities[activity] || 0) + 1;
    }
    if (key === "running") {
      const endsAtMs = toFiniteNumber(job.endsAtMs, 0);
      if (!nextCompletionAtMs || endsAtMs < nextCompletionAtMs) {
        nextCompletionAtMs = endsAtMs;
      }
    }
  }
  let blueprintOriginals = 0;
  let blueprintCopies = 0;
  let copyRunsAvailable = 0;
  for (const blueprintID in economyState.industryBlueprints || {}) {
    const blueprint = economyState.industryBlueprints[blueprintID];
    if (blueprint && blueprint.original === true) {
      blueprintOriginals += 1;
    } else {
      blueprintCopies += 1;
      copyRunsAvailable += toPositiveInt(blueprint && blueprint.runsRemaining, 0);
    }
  }
  return {
    activeJobs: activeJobIDs.size,
    activeIndex: {
      products: activeJobIDsByProductTypeID.size,
      blueprintAssets: activeBlueprintAssetIDs.size,
      reserving: reservingJobIDs.size,
    },
    completionSchedule: {
      queued: completionDeadlineQueue.size,
      nextDueInMs: (() => {
        const next = completionDeadlineQueue.peek();
        return next ? Math.max(0, next.dueAtMs - nowMs) : null;
      })(),
      ...completionScheduleMetrics,
    },
    statuses,
    activities,
    nextCompletionAtMs,
    workforce: workforce.getStatus(economyState),
    blueprints: {
      originals: blueprintOriginals,
      copies: blueprintCopies,
      copyRunsAvailable,
    },
    jobsInstalled: toFiniteNumber(economyState.metrics.industryJobsInstalled, 0),
    jobsCompleted: toFiniteNumber(economyState.metrics.industryJobsCompleted, 0),
    inputUnitsConsumed: toFiniteNumber(economyState.metrics.industryInputUnitsConsumed, 0),
    inputValueISK: roundMoney(economyState.metrics.industryInputValueISK),
    outputUnitsProduced: toFiniteNumber(economyState.metrics.industryOutputUnitsProduced, 0),
    outputValueISK: roundMoney(economyState.metrics.industryOutputValueISK),
    adjustmentNamespaceMigrations: toFiniteNumber(
      economyState.metrics.industryAdjustmentNamespaceMigrations,
      0,
    ),
    adjustmentConflictsQuarantined: toFiniteNumber(
      economyState.metrics.industryAdjustmentConflictsQuarantined,
      0,
    ),
    blueprintCopiesCreated: toFiniteNumber(
      economyState.metrics.industryBlueprintCopiesCreated,
      0,
    ),
    blueprintCopyRunsConsumed: toFiniteNumber(
      economyState.metrics.industryBlueprintCopyRunsConsumed,
      0,
    ),
    materialResearchCompleted: toFiniteNumber(
      economyState.metrics.industryMaterialResearchJobsCompleted,
      0,
    ),
    timeResearchCompleted: toFiniteNumber(
      economyState.metrics.industryTimeResearchJobsCompleted,
      0,
    ),
  };
}

function format(economyState, limit = 12, nowMs = Date.now()) {
  const status = getStatus(economyState);
  const jobs = Object.values(ensureIndustryState(economyState))
    .filter(isActiveJob)
    .sort((left, right) => toFiniteNumber(left.endsAtMs, Number.MAX_SAFE_INTEGER) - toFiniteNumber(right.endsAtMs, Number.MAX_SAFE_INTEGER))
    .slice(0, Math.max(1, toPositiveInt(limit, 12)));
  const summary =
    `NPC industry has ${status.workforce.total} persistent industrialist(s) ` +
    `(${status.workforce.highsec} high-sec, ${status.workforce.lowsec} low-sec, ` +
    `${status.workforce.nullsec} null-sec; ` +
    `${status.workforce.busy} busy), ${status.activeJobs} active job(s), ` +
    `${status.jobsCompleted} completed, ${status.blueprints.originals} BPO(s) and ` +
    `${status.blueprints.copies} finite BPC(s): ` +
    `${Number(status.inputUnitsConsumed).toLocaleString("en-US")} mineral units consumed ` +
    `(${Number(status.inputValueISK).toLocaleString("en-US")} ISK), ` +
    `${Number(status.outputUnitsProduced).toLocaleString("en-US")} finished units produced.`;
  if (jobs.length <= 0) return summary;
  return `${summary} ` + jobs.map((job) => {
    const minutes = Math.max(0, Math.ceil((toFiniteNumber(job.endsAtMs, nowMs) - nowMs) / 60_000));
    const activity = String(job.activity || ACTIVITY.MANUFACTURING).replaceAll("_", " ");
    return `${job.jobID} ${job.status} ${activity}: ${job.runs || job.targetLevel || 1}x ` +
      `${job.productTypeName} by ${job.pilotName || "legacy corporation installer"} ` +
      `at ${catalog.getStation(job.stationID)?.name || job.stationID}, ~${minutes} min`;
  }).join("; ");
}

module.exports = {
  ACTIVITY,
  process,
  getRecipe,
  getNextWakeAtMs,
  getStatus,
  format,
  listActiveJobs,
  getMaxParallelHullLines,
  _testing: {
    buildCandidate,
    buildCandidates,
    buildPriorityInputReservations,
    buildManufacturingInputs,
    completeJob,
    createBlueprintAsset,
    createBlueprintJob,
    createJob,
    createManufacturingJob,
    ensureIndustryState,
    ensureBlueprintOriginal,
    findUsableCopy,
    getMaximumJobSeconds,
    getPriorityInputReserveByTypeID,
    getProductionCandidateRuns,
    getTimeScale,
    handleAdjustmentIdentityCollision,
    isAdjustmentIdentityCollision,
    makeIndustryAdjustmentID,
    makeIndustryJobID,
    processDueCompletions,
    promoteLegacyAdjustmentNamespace,
    pruneJobs,
    quarantineAdjustmentConflict,
    reconcileIndustryJobCounter,
    reserveInputs,
  },
};
