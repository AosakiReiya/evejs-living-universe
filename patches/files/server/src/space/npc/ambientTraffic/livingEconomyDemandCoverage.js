"use strict";

const path = require("path");

const catalog = require(path.join(__dirname, "./livingEconomyCatalog"));

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function listPendingDemands(economyState) {
  return [
    ...Object.values(economyState.replacementDemands || {}).map((demand) => ({
      demand,
      demandKind: "replacement",
    })),
    ...Object.values(economyState.campaignDemands || {}).map((demand) => ({
      demand,
      demandKind: "campaign_supply",
    })),
  ].filter(({ demand }) => String(demand && demand.status || "") === "pending");
}

function getActivePipeline(activeJobs, typeID) {
  const jobs = (Array.isArray(activeJobs) ? activeJobs : []).filter(
    (job) => Number(job && job.productTypeID) === Number(typeID),
  );
  return {
    jobs: jobs.length,
    outputUnits: jobs.reduce((sum, job) => (
      String(job && job.activity || "manufacturing") === "manufacturing"
        ? sum + toPositiveInt(job.productQuantity, 0)
        : sum
    ), 0),
  };
}

function getDemandDrivenProductionPlanRuns(good, recipe, requiredOutputUnits) {
  const productQuantityPerRun = Math.max(
    1,
    toPositiveInt(recipe && recipe.productQuantityPerRun, 1),
  );
  const requestedRuns = Math.ceil(
    Math.max(1, toPositiveInt(requiredOutputUnits, 1)) /
      productQuantityPerRun,
  );
  const recipeLimit = Math.max(
    1,
    toPositiveInt(recipe && recipe.maxProductionLimit, 1),
  );
  // Replacement and campaign ship demand must release one usable hull at a
  // time. Planning a ten-hull material batch can report the whole line as
  // input-starved even when the modeled region can already afford one hull.
  const incrementalHullLimit = good && good.category === catalog.CATEGORY.SHIP
    ? 1
    : recipeLimit;
  return Math.max(1, Math.min(
    recipeLimit,
    requestedRuns,
    incrementalHullLimit,
  ));
}

function classifyRequirement(details) {
  const {
    good,
    recipe,
    remainingQuantity,
    localQuantity,
    regionalQuantity,
    activeOutputUnits,
    activePipelineJobs,
  } = details;
  const pirateFactionHull = catalog.isPirateFactionHull(good);
  let supplyClass = "unsupported";
  if (pirateFactionHull && recipe) supplyClass = "faction_assembly";
  else if (pirateFactionHull) supplyClass = "faction_import";
  else if (recipe) supplyClass = "manufacturing";
  else if (regionalQuantity > 0) supplyClass = "regional_stock";

  let supplyStatus = "blocked";
  let blockingReason = "NO_SUPPORTED_SUPPLY_PATH";
  if (localQuantity >= remainingQuantity) {
    supplyStatus = "available_local";
    blockingReason = null;
  } else if (regionalQuantity >= remainingQuantity) {
    supplyStatus = "awaiting_freight";
    blockingReason = "AWAITING_HAULER_DELIVERY";
  } else if (activePipelineJobs > 0) {
    supplyStatus = "in_production";
    blockingReason = "AWAITING_INDUSTRY_COMPLETION";
  } else if (supplyClass === "manufacturing" || supplyClass === "faction_assembly") {
    supplyStatus = "awaiting_production";
    blockingReason = "AWAITING_DEMAND_DRIVEN_INDUSTRY";
  } else if (supplyClass === "faction_import") {
    supplyStatus = "awaiting_faction_import";
    blockingReason = "FACTION_IMPORT_STOCK_EXHAUSTED";
  }
  return {
    supplyClass,
    supplyStatus,
    blockingReason,
    recipeAvailable: Boolean(recipe),
    routeEligible: regionalQuantity > localQuantity,
    pirateFactionHull,
  };
}

async function buildProductionPlan(
  good,
  recipe,
  requiredOutputUnits,
  stockMap,
  getStockRow,
  workBudget,
  regionalQuantityByTypeID = null,
) {
  if (!good || !recipe || requiredOutputUnits <= 0) return null;
  const runs = getDemandDrivenProductionPlanRuns(
    good,
    recipe,
    requiredOutputUnits,
  );
  const regionalAvailableByMaterialTypeID = new Map();
  let scanned = 0;
  for (const material of recipe.materials) {
    let regionalAvailable = regionalQuantityByTypeID instanceof Map
      ? toPositiveInt(regionalQuantityByTypeID.get(Number(material.typeID)), 0)
      : 0;
    if (!(regionalQuantityByTypeID instanceof Map)) {
      for (const station of catalog.STATIONS) {
        regionalAvailable += toPositiveInt(
          getStockRow(stockMap, station.stationID, material.typeID).quantity,
          0,
        );
        scanned += 1;
        if (workBudget && scanned % 128 === 0) await workBudget.checkpoint();
      }
    }
    regionalAvailableByMaterialTypeID.set(Number(material.typeID), regionalAvailable);
  }
  const candidates = [];
  for (const station of catalog.STATIONS) {
    const producerCeiling = catalog.getProducerCeiling(station, good);
    if (producerCeiling <= 0) continue;
    const inputs = recipe.materials.map((material) => {
      const required = toPositiveInt(material.quantityPerRun, 0) * runs;
      const available = toPositiveInt(
        getStockRow(stockMap, station.stationID, material.typeID).quantity,
        0,
      );
      const regionalAvailable = toPositiveInt(
        regionalAvailableByMaterialTypeID.get(Number(material.typeID)),
        0,
      );
      return {
        typeID: Number(material.typeID),
        typeName: String(material.typeName || catalog.getGood(material.typeID)?.name || material.typeID),
        requiredQuantity: required,
        availableQuantity: available,
        regionalAvailableQuantity: regionalAvailable,
        routableQuantity: Math.max(0, regionalAvailable - available),
        missingQuantity: Math.max(0, required - available),
      };
    });
    candidates.push({
      stationID: station.stationID,
      systemID: station.systemID,
      stationName: station.name,
      runs,
      plannedOutputUnits: runs * toPositiveInt(recipe.productQuantityPerRun, 1),
      producerCeiling,
      inputs,
      missingInputUnits: inputs.reduce((sum, input) => sum + input.missingQuantity, 0),
      missingInputTypes: inputs.filter((input) => input.missingQuantity > 0).length,
    });
    scanned += 1;
    if (workBudget && scanned % 32 === 0) await workBudget.checkpoint();
  }
  return candidates.sort((left, right) => (
    left.missingInputTypes - right.missingInputTypes ||
    left.missingInputUnits - right.missingInputUnits ||
    right.producerCeiling - left.producerCeiling ||
    Number(left.stationID) - Number(right.stationID)
  ))[0] || null;
}

async function audit(economyState, stockMap, dependencies, nowMs = Date.now()) {
  const getStockRow = dependencies.getStockRow;
  const getRecipe = dependencies.getRecipe;
  const activeJobs = dependencies.activeJobs || [];
  const workBudget = dependencies.workBudget;
  // 1 preserves the legacy behavior of not planning the next line's inputs
  // while any job for the type is active; ship types may pipeline up to this
  // many concurrent one-hull lines.
  const maxParallelHullLines = Math.max(
    1,
    Math.min(8, toPositiveInt(dependencies.maxParallelHullLines, 1)),
  );
  const pendingDemands = listPendingDemands(economyState);
  const demandedTypeIDs = [...new Set(pendingDemands.flatMap(({ demand }) => (
    (Array.isArray(demand.requirements) ? demand.requirements : [])
      .filter((item) => {
        const fulfilled = toPositiveInt(
          demand.fulfilledQuantities && demand.fulfilledQuantities[item.typeID],
          0,
        );
        return fulfilled < toPositiveInt(item.quantity, 0);
      })
      .map((item) => Number(item.typeID))
  )))];
  const recipesByTypeID = new Map();
  const trackedTypeIDs = new Set(demandedTypeIDs);
  for (const typeID of demandedTypeIDs) {
    const good = catalog.getGood(typeID);
    const recipe = good && getRecipe(good);
    if (!recipe) continue;
    recipesByTypeID.set(typeID, recipe);
    for (const material of Array.isArray(recipe.materials) ? recipe.materials : []) {
      const materialTypeID = Number(material && material.typeID) || 0;
      if (materialTypeID > 0) trackedTypeIDs.add(materialTypeID);
    }
  }
  const regionalQuantityByTypeID = new Map(
    [...trackedTypeIDs].map((typeID) => [typeID, 0]),
  );
  const remainingByTypeID = new Map();
  for (const { demand } of pendingDemands) {
    for (const item of Array.isArray(demand.requirements) ? demand.requirements : []) {
      const fulfilled = toPositiveInt(
        demand.fulfilledQuantities && demand.fulfilledQuantities[item.typeID],
        0,
      );
      const remaining = Math.max(0, toPositiveInt(item.quantity, 0) - fulfilled);
      if (remaining <= 0) continue;
      remainingByTypeID.set(
        Number(item.typeID),
        toPositiveInt(remainingByTypeID.get(Number(item.typeID)), 0) + remaining,
      );
    }
  }
  let scannedStockRows = 0;
  for (const station of catalog.STATIONS) {
    for (const typeID of trackedTypeIDs) {
      regionalQuantityByTypeID.set(
        typeID,
        toPositiveInt(regionalQuantityByTypeID.get(typeID), 0) +
          toPositiveInt(getStockRow(stockMap, station.stationID, typeID).quantity, 0),
      );
      scannedStockRows += 1;
      if (workBudget && scannedStockRows % 128 === 0) await workBudget.checkpoint();
    }
  }
  const productionPlansByTypeID = new Map();
  for (const typeID of demandedTypeIDs) {
    const good = catalog.getGood(typeID);
    if (!good) continue;
    const recipe = recipesByTypeID.get(typeID);
    if (!recipe) continue;
    const activePipeline = getActivePipeline(activeJobs, typeID);
    // Hull demand may keep planning the next one-hull line's inputs while up
    // to maxParallelHullLines jobs run; other types wait for their active
    // batch as before. Output already being manufactured is netted out so a
    // running line is never re-planned.
    const parallelLimit = good.category === catalog.CATEGORY.SHIP
      ? maxParallelHullLines
      : 1;
    if (activePipeline.jobs >= parallelLimit) continue;
    const requiredOutputUnits = Math.max(
      0,
      toPositiveInt(remainingByTypeID.get(typeID), 0) -
        toPositiveInt(regionalQuantityByTypeID.get(typeID), 0) -
        toPositiveInt(activePipeline.outputUnits, 0),
    );
    if (requiredOutputUnits <= 0) continue;
    const plan = await buildProductionPlan(
      good,
      recipe,
      requiredOutputUnits,
      stockMap,
      getStockRow,
      workBudget,
      regionalQuantityByTypeID,
    );
    if (plan) productionPlansByTypeID.set(typeID, plan);
  }
  let audited = 0;
  let changed = 0;
  const assignedInputPlanTypeIDs = new Set();
  for (const { demand, demandKind } of pendingDemands) {
    demand.fulfilledQuantities = demand.fulfilledQuantities || {};
    for (const item of Array.isArray(demand.requirements) ? demand.requirements : []) {
      const fulfilled = toPositiveInt(demand.fulfilledQuantities[item.typeID], 0);
      const remainingQuantity = Math.max(0, toPositiveInt(item.quantity, 0) - fulfilled);
      if (remainingQuantity <= 0) continue;
      const good = catalog.getGood(item.typeID);
      const localQuantity = toPositiveInt(
        getStockRow(stockMap, demand.stationID, item.typeID).quantity,
        0,
      );
      const regionalQuantity = toPositiveInt(
        regionalQuantityByTypeID.get(Number(item.typeID)),
        0,
      );
      const recipe = good && getRecipe(good);
      const activePipeline = getActivePipeline(activeJobs, item.typeID);
      const classification = classifyRequirement({
        good,
        recipe,
        remainingQuantity,
        localQuantity,
        regionalQuantity,
        activeOutputUnits: activePipeline.outputUnits,
        activePipelineJobs: activePipeline.jobs,
      });
      const productionPlan = productionPlansByTypeID.get(Number(item.typeID)) || null;
      const ownsInputPlan = Boolean(
        productionPlan && !assignedInputPlanTypeIDs.has(Number(item.typeID)),
      );
      if (ownsInputPlan) assignedInputPlanTypeIDs.add(Number(item.typeID));
      if (
        classification.supplyStatus === "awaiting_production" &&
        productionPlan &&
        productionPlan.missingInputTypes > 0
      ) {
        const allInputsRoutable = productionPlan.inputs.every((input) => (
          input.missingQuantity <= input.routableQuantity
        ));
        classification.supplyStatus = allInputsRoutable
          ? "awaiting_inputs"
          : "blocked_inputs";
        classification.blockingReason = allInputsRoutable
          ? "AWAITING_PRODUCTION_INPUT_FREIGHT"
          : "PRODUCTION_INPUT_STOCK_EXHAUSTED";
      }
      if (
        classification.supplyStatus === "awaiting_production" &&
        ["manufacturing", "faction_assembly"].includes(classification.supplyClass) &&
        !productionPlan
      ) {
        classification.supplyStatus = "blocked";
        classification.blockingReason = "NO_ELIGIBLE_PRODUCER";
      }
      const nextSupply = {
        demandKind,
        ...classification,
        remainingQuantity,
        localQuantity,
        regionalQuantity,
        activeOutputUnits: activePipeline.outputUnits,
        activePipelineJobs: activePipeline.jobs,
        producerStationID: productionPlan && productionPlan.stationID || 0,
        producerSystemID: productionPlan && productionPlan.systemID || 0,
        producerStationName: productionPlan && productionPlan.stationName || null,
        plannedRuns: productionPlan && productionPlan.runs || 0,
        plannedOutputUnits: productionPlan && productionPlan.plannedOutputUnits || 0,
        inputRequirements: ownsInputPlan
          ? productionPlan.inputs
          : [],
        sharedProductionPlan: Boolean(productionPlan && !ownsInputPlan),
        lastAuditedAtMs: nowMs,
      };
      if (JSON.stringify({ ...item.supply, lastAuditedAtMs: 0 }) !==
          JSON.stringify({ ...nextSupply, lastAuditedAtMs: 0 })) changed += 1;
      item.supply = nextSupply;
      audited += 1;
      if (workBudget && audited % 32 === 0) await workBudget.checkpoint();
    }
  }
  return { audited, changed };
}

function getStatus(economyState) {
  const byClass = {};
  const byStatus = {};
  const blockers = {};
  const byKind = {};
  let requirements = 0;
  for (const { demand, demandKind } of listPendingDemands(economyState)) {
    const kind = String(demandKind || "unknown");
    const kindStatus = byKind[kind] || {
      requirements: 0,
      byClass: {},
      byStatus: {},
      blockers: {},
    };
    for (const item of Array.isArray(demand.requirements) ? demand.requirements : []) {
      const fulfilled = toPositiveInt(demand.fulfilledQuantities && demand.fulfilledQuantities[item.typeID], 0);
      if (fulfilled >= toPositiveInt(item.quantity, 0)) continue;
      const supply = item.supply || {};
      const supplyClass = String(supply.supplyClass || "not_audited");
      const supplyStatus = String(supply.supplyStatus || "not_audited");
      byClass[supplyClass] = (byClass[supplyClass] || 0) + 1;
      byStatus[supplyStatus] = (byStatus[supplyStatus] || 0) + 1;
      kindStatus.byClass[supplyClass] =
        (kindStatus.byClass[supplyClass] || 0) + 1;
      kindStatus.byStatus[supplyStatus] =
        (kindStatus.byStatus[supplyStatus] || 0) + 1;
      if (supply.blockingReason) {
        blockers[supply.blockingReason] = (blockers[supply.blockingReason] || 0) + 1;
        kindStatus.blockers[supply.blockingReason] =
          (kindStatus.blockers[supply.blockingReason] || 0) + 1;
      }
      requirements += 1;
      kindStatus.requirements += 1;
    }
    byKind[kind] = kindStatus;
  }
  return { requirements, byClass, byStatus, blockers, byKind };
}

module.exports = {
  audit,
  buildProductionPlan,
  classifyRequirement,
  getStatus,
  listPendingDemands,
  _testing: {
    getDemandDrivenProductionPlanRuns,
  },
};
