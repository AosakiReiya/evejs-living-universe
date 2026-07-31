"use strict";

const crypto = require("crypto");
const path = require("path");
const { performance } = require("perf_hooks");

const config = require(path.join(__dirname, "../../../config"));
const log = require(path.join(__dirname, "../../../utils/logger"));
const { marketDaemonClient } = require(path.join(
  __dirname,
  "../../../services/market/marketDaemonClient",
));
const stateStore = require(path.join(__dirname, "./livingEconomyState"));
const catalog = require(path.join(__dirname, "./livingEconomyCatalog"));
const telemetry = require(path.join(__dirname, "./livingEconomyTelemetry"));
const routePlanner = require(path.join(__dirname, "./livingEconomyRoutePlanner"));
const procurement = require(path.join(__dirname, "./livingEconomyProcurement"));
const industry = require(path.join(__dirname, "./livingEconomyIndustry"));
const demandCoverage = require(path.join(__dirname, "./livingEconomyDemandCoverage"));
const salvageRecovery = require(path.join(__dirname, "./livingEconomySalvage"));
const mobilization = require(path.join(__dirname, "./livingEconomyMobilization"));
const { createWorkBudget } = require(path.join(__dirname, "./livingEconomyWorkBudget"));
const reprocessing = require(path.join(__dirname, "../../../services/reprocessing"));
const marketTopology = require(path.join(__dirname, "../../../services/market/marketTopology"));

const CATALOG_REVISION = 9;
const LEGACY_MAX_EVENT_ROWS = 250;
const X_EVE_MAX_EVENT_ROWS = 4096;
const X_EVE_RUNTIME_EVENT_ROWS = 512;
const CAMPAIGN_ADJUSTMENT_NAMESPACE_VERSION = 2;
const REPLACEMENT_ADJUSTMENT_NAMESPACE_VERSION = 2;
const FREIGHT_REPOSITION_COOLDOWN_MS = 5 * 60_000;
const FREIGHT_REPOSITION_MAX_JUMPS = 12;
const FREIGHT_REPOSITION_MAX_OPPORTUNITIES = 64;
const FREIGHT_REPOSITION_MAX_PER_SOURCE = 1;
const REPLACEMENT_REPOSITION_MAX_JUMPS = 24;
const REPLACEMENT_REPOSITION_MAX_OPPORTUNITIES = 256;
const REPLACEMENT_REPOSITION_MAX_PER_SOURCE = 3;
const FREIGHT_RECOVERY_MAX_JOBS_PER_PULSE = 32;
const AUTOMATIC_REGIONAL_STOCK_REVISION = 1;
const CATALOG_STOCK_KEYS = Object.freeze(catalog.STATIONS.flatMap((station) => (
  catalog.TRADE_GOODS
    .filter((good) => (
      catalog.getTargetQuantity(station, good) > 0 ||
      catalog.getProducerCeiling(station, good) > 0
    ))
    .map((good) => Object.freeze({
      station_id: station.stationID,
      type_id: good.typeID,
      region_id: Number(station.regionID) || 0,
    }))
)));
const REGIONAL_STOCK_SHARDS = Object.freeze(
  [...CATALOG_STOCK_KEYS.reduce((groups, key) => {
    const regionID = Number(key.region_id) || 0;
    if (!groups.has(regionID)) groups.set(regionID, []);
    groups.get(regionID).push(key);
    return groups;
  }, new Map()).entries()]
    .map(([regionID, keys]) => Object.freeze({
      regionID,
      regionName: String(
        (catalog.STATIONS.find((station) => Number(station.regionID) === regionID) || {}).regionName ||
        `Region ${regionID}`,
      ),
      keys: Object.freeze(keys),
      stations: Object.freeze(
        catalog.STATIONS.filter((station) => Number(station.regionID) === regionID),
      ),
    }))
    .sort((left, right) => (
      (left.regionID === catalog.PILOT_REGION_ID ? -1 : 0) -
        (right.regionID === catalog.PILOT_REGION_ID ? -1 : 0) ||
      left.regionID - right.regionID
    )),
);
const AUTOMATIC_REGIONAL_STOCK_SPECS = Object.freeze(
  catalog.REGIONAL_HUBS.flatMap((station) => (
    catalog.GOODS
      .map((good) => ({
        station,
        good,
        initialQuantity: catalog.getInitialQuantity(station, good),
      }))
      .filter((entry) => entry.initialQuantity > 0)
      .map((entry) => Object.freeze(entry))
  )),
);
const ACTIVE_JOB_STATES = new Set([
  "reserving",
  "in_transit",
  "delivery_pending",
]);
const EXTERNAL_ADJUSTMENT_COUNTER_KEYS = Object.freeze([
  "nextJobNumber",
  "nextIndustryJobNumber",
  "nextIndustryPilotNumber",
  "nextIndustryBlueprintNumber",
  "nextReplacementDemandNumber",
  "nextCampaignDemandNumber",
  "nextSalvageJobNumber",
]);

let initialized = false;
let runtimeState = null;
let pulsePromise = null;
let lastStockSnapshot = new Map();
let lastPulseError = null;
let lastMarkLivingStateDirty = null;
let lastAssignFreightRoute = null;
let lastSalvageRecoveryAdapters = {};
let preparedResetToken = null;
let pulseTiming = createPulseTiming();
let stockCacheRuntime = createStockCacheRuntime();
let routePlanningRuntime = createRoutePlanningRuntime();
let marketBatchRuntime = createMarketBatchRuntime();

function createPulseTiming() {
  return {
    completedPulses: 0,
    totalDurationMs: 0,
    lastDurationMs: 0,
    maxDurationMs: 0,
    lastWorkBudget: null,
    cooperativeYields: 0,
  };
}

function getNpcData() {
  return require(path.join(__dirname, "../npcData"));
}

function createStockCacheRuntime() {
  return {
    ready: false,
    bootstrapStartedAtMs: 0,
    bootstrapCompletedAtMs: 0,
    reconcileRegionIndex: 0,
    reconcileKeyIndex: 0,
    lastReconcileAtMs: 0,
    lastFullReconcileAtMs: 0,
    currentRegionID: null,
    dirtyKeys: new Map(),
    automaticRegionalStock: {
      revision: AUTOMATIC_REGIONAL_STOCK_REVISION,
      candidateRows: AUTOMATIC_REGIONAL_STOCK_SPECS.length,
      missingRows: 0,
      createdRows: 0,
      preservedRows: 0,
      batches: 0,
      attempts: 0,
      failures: 0,
      startedAtMs: 0,
      completedAtMs: 0,
      lastError: null,
    },
    metrics: {
      bootstrapBatches: 0,
      bootstrapRowsRequested: 0,
      bootstrapRowsLoaded: 0,
      reconciliationBatches: 0,
      reconciliationRowsRequested: 0,
      reconciliationRowsLoaded: 0,
      reconciliationCycles: 0,
      dirtyRowsRequested: 0,
      dirtyRowsLoaded: 0,
      knownMutationsApplied: 0,
      cooperativeYields: 0,
    },
  };
}

function createRoutePlanningRuntime() {
  return {
    opportunities: [],
    lastBuiltAtMs: 0,
    lastDurationMs: 0,
    maximumDurationMs: 0,
    builds: 0,
    planningRegionIndex: 0,
    lastPlanningRegionID: null,
    repositionsAssignedLastPulse: 0,
  };
}

function createMarketBatchRuntime() {
  return {
    batchesAttempted: 0,
    batchesSucceeded: 0,
    batchFallbacks: 0,
    adjustmentsSubmitted: 0,
    maximumBatchSize: 0,
    lastBatchError: null,
  };
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function roundPrice(value) {
  return Math.max(0.01, Math.round(toFiniteNumber(value, 0.01) * 100) / 100);
}

function roundMoney(value) {
  return Math.round(toFiniteNumber(value, 0) * 100) / 100;
}

function preserveExternalAdjustmentCounters(previousState, nextState) {
  for (const key of EXTERNAL_ADJUSTMENT_COUNTER_KEYS) {
    // Market adjustment receipts survive an economy reset. Keep their
    // monotonic identity sources advancing so a fresh job can never replay an
    // old external adjustment merely because gameplay state was reset.
    nextState[key] = Math.max(1, toPositiveInt(previousState && previousState[key], 1));
  }
  return nextState;
}

function getFlightLogisticsProfile(flight) {
  const authored = flight && flight.logisticsProfile && typeof flight.logisticsProfile === "object"
    ? flight.logisticsProfile
    : {};
  return {
    logisticsClass: String(authored.logisticsClass || "feeder"),
    capacityM3: Math.max(100, toFiniteNumber(authored.capacityM3, 4_500)),
    shipmentMultiplier: Math.max(1, toFiniteNumber(authored.shipmentMultiplier, 1)),
    maximumCargoValueISK: Math.max(
      100_000,
      toFiniteNumber(authored.maximumCargoValueISK, 25_000_000),
    ),
    lowSecurityAccess: authored.lowSecurityAccess === true,
  };
}

function getPriorityDemandClasses(value) {
  const classes = new Set(
    (Array.isArray(value && value.priorityDemandClasses)
      ? value.priorityDemandClasses
      : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  );
  const rootDemandKind = String(value && value.rootDemandKind || "").trim();
  if (rootDemandKind === "replacement") classes.add("replacement");
  if (rootDemandKind === "campaign_supply") classes.add("campaign");
  if (
    classes.size <= 0 &&
    Array.isArray(value && value.priorityDemandKinds) &&
    value.priorityDemandKinds.map(String).includes("replacement")
  ) {
    classes.add("replacement");
  }
  return [...classes].sort();
}

function getReplacementPriorityUnits(value) {
  const explicit = toPositiveInt(value && value.replacementPriorityUnits, 0);
  if (explicit > 0) return explicit;
  if (!getPriorityDemandClasses(value).includes("replacement")) return 0;
  const byClass = value && value.priorityDemandUnitsByClass;
  const replacementDemandUnits = byClass && typeof byClass === "object"
    ? toPositiveInt(byClass.replacement, 0)
    : toPositiveInt(value && value.priorityDemandUnits, 0);
  const quantityLimit =
    value &&
    Object.prototype.hasOwnProperty.call(value, "quantity")
      ? toPositiveInt(value.quantity, 0)
      : replacementDemandUnits;
  return Math.min(
    quantityLimit,
    replacementDemandUnits,
    toPositiveInt(value && value.priorityDemandUnits, 0),
  );
}

function isReplacementPriority(value) {
  return getReplacementPriorityUnits(value) > 0;
}

function recordFreightAssignmentClass(job, nowMs = Date.now()) {
  if (!job || job.freightPriorityAssignmentAccountingAtMs) return false;
  job.freightPriorityAssignmentAccountingAtMs = nowMs;
  const replacementUnits = getReplacementPriorityUnits(job);
  if (replacementUnits > 0) {
    runtimeState.metrics.replacementFreightJobsAssigned =
      toPositiveInt(runtimeState.metrics.replacementFreightJobsAssigned, 0) + 1;
    runtimeState.metrics.replacementFreightUnitsAssigned =
      toPositiveInt(runtimeState.metrics.replacementFreightUnitsAssigned, 0) +
      replacementUnits;
  } else {
    runtimeState.metrics.generalFreightJobsAssigned =
      toPositiveInt(runtimeState.metrics.generalFreightJobsAssigned, 0) + 1;
  }
  return true;
}

function recordFreightDeliveryClass(job, nowMs = Date.now()) {
  if (!job || job.freightPriorityDeliveryAccountingAtMs) return false;
  job.freightPriorityDeliveryAccountingAtMs = nowMs;
  const replacementUnits = getReplacementPriorityUnits(job);
  if (replacementUnits > 0) {
    runtimeState.metrics.replacementFreightJobsDelivered =
      toPositiveInt(runtimeState.metrics.replacementFreightJobsDelivered, 0) + 1;
    runtimeState.metrics.replacementFreightUnitsDelivered =
      toPositiveInt(runtimeState.metrics.replacementFreightUnitsDelivered, 0) +
      replacementUnits;
    // Finished goods bound for the demand station and raw inputs bound for a
    // producer both ride the replacement lane, but only the former count
    // against replacementUnitsRequested. Splitting them keeps delivered-unit
    // telemetry comparable with the demand-side counters. The direct bucket
    // is an upper bound: when one station+type key hosts both a direct row
    // and another demand's production_input row, the whole job counts as
    // direct.
    const priorityDemandKinds = Array.isArray(job.priorityDemandKinds)
      ? job.priorityDemandKinds
      : [];
    if (priorityDemandKinds.includes("replacement")) {
      runtimeState.metrics.replacementDirectFreightUnitsDelivered =
        toPositiveInt(
          runtimeState.metrics.replacementDirectFreightUnitsDelivered,
          0,
        ) + replacementUnits;
    } else {
      runtimeState.metrics.replacementInputFreightUnitsDelivered =
        toPositiveInt(
          runtimeState.metrics.replacementInputFreightUnitsDelivered,
          0,
        ) + replacementUnits;
    }
  } else {
    runtimeState.metrics.generalFreightJobsDelivered =
      toPositiveInt(runtimeState.metrics.generalFreightJobsDelivered, 0) + 1;
  }
  return true;
}

function incrementClassMetric(metricName, logisticsClass, amount = 1) {
  const key = String(logisticsClass || "unknown");
  const current = runtimeState.metrics[metricName];
  const values = current && typeof current === "object" ? current : {};
  values[key] = toFiniteNumber(values[key], 0) + toFiniteNumber(amount, 0);
  runtimeState.metrics[metricName] = values;
}

function recordCargoReservation(job, nowMs = Date.now()) {
  if (!job || job.cargoReservationAccountingAtMs) {
    return false;
  }
  job.cargoReservationAccountingAtMs = nowMs;
  runtimeState.metrics.cargoVolumeReservedM3 =
    toFiniteNumber(runtimeState.metrics.cargoVolumeReservedM3, 0) +
    toFiniteNumber(job.cargoVolume, 0);
  incrementClassMetric("jobsByLogisticsClass", job.logisticsClass, 1);
  return true;
}

function recordCargoDelivery(job, nowMs = Date.now()) {
  if (!job || job.cargoDeliveryAccountingAtMs) {
    return false;
  }
  job.cargoDeliveryAccountingAtMs = nowMs;
  runtimeState.metrics.cargoVolumeDeliveredM3 =
    toFiniteNumber(runtimeState.metrics.cargoVolumeDeliveredM3, 0) +
    toFiniteNumber(job.cargoVolume, 0);
  incrementClassMetric("deliveredByLogisticsClass", job.logisticsClass, 1);
  return true;
}

function recordCargoLoss(job, nowMs = Date.now()) {
  if (!job || job.cargoLossAccountingAtMs) {
    return false;
  }
  job.cargoLossAccountingAtMs = nowMs;
  runtimeState.metrics.cargoVolumeLostM3 =
    toFiniteNumber(runtimeState.metrics.cargoVolumeLostM3, 0) +
    toFiniteNumber(job.cargoVolume, 0);
  incrementClassMetric("lostByLogisticsClass", job.logisticsClass, 1);
  return true;
}

function getPulseIntervalMs() {
  return Math.max(
    5_000,
    toFiniteNumber(config.livingEconomyPulseSeconds, 15) * 1_000,
  );
}

function getFamilyEstateProjectsRuntime() {
  return require(path.join(
    __dirname,
    "../../../services/estate/familyEstateProjectsRuntime",
  ));
}

function closeEstateDeliveryForJob(job, status, reason, nowMs = Date.now()) {
  if (!job || !job.estateDelivery) return { success: true, unchanged: true };
  try {
    const result = getFamilyEstateProjectsRuntime().closeFamilyEstateNpcDelivery(
      job.jobID,
      status,
      reason,
      nowMs,
    );
    if (result && result.success) {
      job.estateCloseConfirmedAtMs = nowMs;
      job.estateDeliveryError = null;
    } else if (
      result &&
      result.errorMsg === "FAMILY_ESTATE_DELIVERY_NOT_FOUND" &&
      !job.estateReservationConfirmedAtMs
    ) {
      job.estateCloseConfirmedAtMs = nowMs;
      job.estateDeliveryError = null;
      return { success: true, unchanged: true };
    } else {
      job.estateDeliveryError = result && result.errorMsg || "ESTATE_DELIVERY_CLOSE_FAILED";
    }
    return result || { success: false, errorMsg: "ESTATE_DELIVERY_CLOSE_FAILED" };
  } catch (error) {
    log.warn(`[LivingEconomy] Estate delivery close failed job=${job.jobID}: ${error.message}`);
    job.estateDeliveryError = error.message;
    return { success: false, errorMsg: error.message, uncertain: true };
  }
}

function getWorkBudgetMs() {
  return Math.max(0.5, Math.min(
    25,
    toFiniteNumber(config.livingEconomyWorkBudgetMs, 4),
  ));
}

function getStockBootstrapBatchSize() {
  return Math.max(100, Math.min(
    4_000,
    toPositiveInt(config.livingEconomyStockBootstrapBatchSize, 1_000),
  ));
}

function getStockReconcileBatchSize() {
  const configured = Math.max(50, Math.min(
    4_000,
    toPositiveInt(config.livingEconomyStockReconcileBatchSize, 320),
  ));
  const fullReconcileMs = Math.max(
    15 * 60_000,
    toFiniteNumber(config.livingEconomyFullStockReconcileSeconds, 14_400) * 1_000,
  );
  const requiredForCadence = Math.ceil(
    (CATALOG_STOCK_KEYS.length * getPulseIntervalMs()) / fullReconcileMs,
  );
  return Math.max(configured, requiredForCadence);
}

// War-economy mobilization (slice W1): freight is the verified #1 replacement
// binder, so its caps interpolate from the configured peacetime base toward a
// surge posture by the mobilization freight ramp. Every surge stays inside the
// pre-existing hard clamps; with mobilization disabled or calm these return
// exactly the configured values.
function getRoutePlanningIntervalMs() {
  const base = Math.max(
    30_000,
    toFiniteNumber(config.livingEconomyRoutePlanningSeconds, 300) * 1_000,
  );
  return mobilization.scaleDown(base, 300 / 90, mobilization.getFreightRamp(), 30_000);
}

function getMaxActiveJobs() {
  const base = Math.max(1, toPositiveInt(config.livingEconomyMaxActiveJobs, 72));
  return mobilization.scaleUp(base, 2, mobilization.getFreightRamp(), 1_000);
}

function getMaxJobsPerPulse() {
  const base = Math.max(1, toPositiveInt(config.livingEconomyMaxJobsPerPulse, 8));
  return mobilization.scaleUp(base, 64 / 24, mobilization.getFreightRamp(), 100);
}

function getReplacementFreightShare() {
  return Math.max(
    0,
    Math.min(
      1,
      toFiniteNumber(config.livingEconomyReplacementFreightSharePercent, 75) /
        100,
    ),
  );
}

function getMaxActiveRepositions() {
  const base = Math.max(
    0,
    Math.trunc(toFiniteNumber(config.livingEconomyMaxActiveRepositions, 16)),
  );
  return mobilization.scaleUp(base, 6, mobilization.getFreightRamp(), 500);
}

function getMaxRepositionsPerPulse() {
  const base = Math.max(
    0,
    Math.trunc(toFiniteNumber(config.livingEconomyMaxRepositionsPerPulse, 2)),
  );
  return mobilization.scaleUp(base, 6, mobilization.getFreightRamp(), 50);
}

// The empty-hauler redeployment trickle is what connects 1,600 idle haulers to
// where replacement cargo actually sits — under mobilization the replacement
// lane fans in wider and haulers turn around faster.
function getReplacementRepositionMaxPerSource() {
  return mobilization.scaleUp(
    REPLACEMENT_REPOSITION_MAX_PER_SOURCE,
    8 / 3,
    mobilization.getFreightRamp(),
    12,
  );
}

function getFreightRepositionCooldownMs() {
  return mobilization.scaleDown(
    FREIGHT_REPOSITION_COOLDOWN_MS,
    2.5,
    mobilization.getFreightRamp(),
    60_000,
  );
}

function getMaxRepricesPerPulse() {
  return Math.max(0, Math.trunc(toFiniteNumber(config.livingEconomyMaxRepricesPerPulse, 8)));
}

function reconcileSourceJournal(nowMs) {
  if (config.xEveEnabled !== true) return { success: true, skipped: true };
  const stored = stateStore.readSourceJournal({ strict: true });
  const sourceEpochMs = toPositiveInt(runtimeState.createdAtMs, 0);
  if (!stored.exists || stored.sourceEpochMs < sourceEpochMs) {
    const replacement = stateStore.replaceSourceJournal(runtimeState, {
      durable: true,
      nowMs,
    });
    if (!replacement || replacement.success !== true) {
      const error = new Error(
        replacement && replacement.errorMsg || "LIVING_ECONOMY_SOURCE_JOURNAL_SEED_FAILED",
      );
      error.code = replacement && replacement.errorMsg ||
        "LIVING_ECONOMY_SOURCE_JOURNAL_SEED_FAILED";
      throw error;
    }
    return { success: true, seeded: true, events: runtimeState.events.length };
  }
  if (stored.sourceEpochMs > sourceEpochMs) {
    const error = new Error("LIVING_ECONOMY_SOURCE_JOURNAL_EPOCH_AHEAD");
    error.code = "LIVING_ECONOMY_SOURCE_JOURNAL_EPOCH_AHEAD";
    throw error;
  }

  const mergedByID = new Map();
  for (const event of [
    ...(Array.isArray(runtimeState.events) ? runtimeState.events : []),
    ...stored.events,
  ]) {
    const prior = mergedByID.get(event.eventID);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) {
      const error = new Error("LIVING_ECONOMY_SOURCE_JOURNAL_EVENT_CONFLICT");
      error.code = "LIVING_ECONOMY_SOURCE_JOURNAL_EVENT_CONFLICT";
      throw error;
    }
    mergedByID.set(event.eventID, JSON.parse(JSON.stringify(event)));
  }
  const mergedSourceEvents = [...mergedByID.values()]
    .sort((left, right) => {
      const leftNumber = Number(String(left.eventID || "").replace(/^LEE-/, "")) || 0;
      const rightNumber = Number(String(right.eventID || "").replace(/^LEE-/, "")) || 0;
      return leftNumber - rightNumber;
    })
    .slice(-X_EVE_MAX_EVENT_ROWS);
  runtimeState.events = mergedSourceEvents.slice(-X_EVE_RUNTIME_EVENT_ROWS);
  runtimeState.nextEventNumber = Math.max(
    toPositiveInt(runtimeState.nextEventNumber, 1),
    toPositiveInt(stored.nextEventNumber, 1),
    mergedSourceEvents.reduce((maximum, event) => {
      const eventNumber = Number(String(event.eventID || "").replace(/^LEE-/, "")) || 0;
      return Math.max(maximum, eventNumber + 1);
    }, 1),
  );
  const storedIDs = stored.events.map((event) => event.eventID).join("|");
  const mergedIDs = mergedSourceEvents.map((event) => event.eventID).join("|");
  if (
    storedIDs !== mergedIDs ||
    stored.nextEventNumber !== runtimeState.nextEventNumber
  ) {
    const replacement = stateStore.replaceSourceJournal({
      ...runtimeState,
      events: mergedSourceEvents,
    }, {
      durable: true,
      nowMs,
    });
    if (!replacement || replacement.success !== true) {
      const error = new Error(
        replacement && replacement.errorMsg || "LIVING_ECONOMY_SOURCE_JOURNAL_REPAIR_FAILED",
      );
      error.code = replacement && replacement.errorMsg ||
        "LIVING_ECONOMY_SOURCE_JOURNAL_REPAIR_FAILED";
      throw error;
    }
  }
  return {
    success: true,
    merged: true,
    events: mergedSourceEvents.length,
    runtimeEvents: runtimeState.events.length,
  };
}

function initialize(nowMs = Date.now()) {
  if (initialized) {
    return runtimeState;
  }
  initialized = true;
  try {
    runtimeState = stateStore.readState({ strict: config.xEveEnabled === true });
  } catch (error) {
    initialized = false;
    runtimeState = null;
    throw error;
  }
  const requiresCatalogMigration = (
    runtimeState.catalogRevision !== CATALOG_REVISION ||
    runtimeState.schemaVersion !== stateStore.SCHEMA_VERSION
  );
  if (requiresCatalogMigration) {
    const preservedEstateJobs = Object.fromEntries(Object.entries(
      runtimeState.jobs && typeof runtimeState.jobs === "object" ? runtimeState.jobs : {},
    ).filter(([, job]) => (
      job && job.estateDelivery &&
      isUnresolvedEstateJob(job)
    )).map(([jobID, job]) => [jobID, JSON.parse(JSON.stringify(job))]));
    const preservedCounters = Object.fromEntries([
      "nextJobNumber",
      "nextIndustryJobNumber",
      "nextIndustryPilotNumber",
      "nextIndustryBlueprintNumber",
      "nextReplacementDemandNumber",
      "nextCampaignDemandNumber",
      "nextSalvageJobNumber",
    ].map((key) => [
      key,
      Math.max(1, toPositiveInt(runtimeState[key], 1)),
    ]));
    // Faction shipyard seed sequences are external adjustment identity, like
    // the numbered counters above: a migration keeps the source epoch when
    // X-Eve is enabled, so resetting these to zero would re-mint tokens the
    // market daemon has already recorded.
    const preservedShipyardSeedCounters =
      runtimeState.factionShipyardSeedCounters &&
      typeof runtimeState.factionShipyardSeedCounters === "object"
        ? JSON.parse(JSON.stringify(runtimeState.factionShipyardSeedCounters))
        : {};
    const replayJournal = Array.isArray(runtimeState.events)
      ? JSON.parse(JSON.stringify(runtimeState.events)).slice(-X_EVE_RUNTIME_EVENT_ROWS)
      : [];
    const sourceEpochMs = toPositiveInt(runtimeState.createdAtMs, 0);
    const nextEventNumber = Math.max(
      toPositiveInt(runtimeState.nextEventNumber, 1),
      replayJournal.reduce((maximum, event) => {
        const match = /^LEE-(\d+)$/.exec(String(event && event.eventID || ""));
        return match ? Math.max(maximum, Number(match[1]) + 1) : maximum;
      }, 1),
    );
    runtimeState = stateStore.buildDefaultState();
    runtimeState.jobs = preservedEstateJobs;
    Object.assign(runtimeState, preservedCounters);
    runtimeState.factionShipyardSeedCounters = preservedShipyardSeedCounters;
    if (config.xEveEnabled === true) {
      runtimeState.events = replayJournal;
      runtimeState.nextEventNumber = nextEventNumber;
      runtimeState.createdAtMs = sourceEpochMs;
    }
  }
  runtimeState.catalogRevision = CATALOG_REVISION;
  if (!runtimeState.createdAtMs) {
    runtimeState.createdAtMs = nowMs;
  }
  try {
    reconcileSourceJournal(nowMs);
  } catch (error) {
    initialized = false;
    runtimeState = null;
    throw error;
  }
  const persisted = persistState(nowMs, { durable: requiresCatalogMigration });
  if (requiresCatalogMigration && !persisted) {
    initialized = false;
    runtimeState = null;
    const error = new Error("LIVING_ECONOMY_MIGRATION_PERSIST_FAILED");
    error.code = "LIVING_ECONOMY_MIGRATION_PERSIST_FAILED";
    throw error;
  }
  return runtimeState;
}

function persistState(nowMs = Date.now(), options = {}) {
  if (!runtimeState) {
    return false;
  }
  runtimeState.updatedAtMs = nowMs;
  try {
    const result = stateStore.writeState(runtimeState, {
      borrowReference: true,
      force: true,
      trustedNormalizedState: true,
    });
    if (!result || result.success !== true) {
      log.warn(
        `[LivingEconomy] State persistence failed: ` +
        `${result && result.errorMsg || "WRITE_FAILED"}`,
      );
      return false;
    }
    if (options.durable === true) {
      const flushResult = stateStore.flushDurably();
      if (!flushResult || flushResult.success !== true) {
        log.warn(
          `[LivingEconomy] Durable state handoff failed: ` +
          `${flushResult && flushResult.errorMsg || "FLUSH_FAILED"}`,
        );
        return false;
      }
    }
    return true;
  } catch (error) {
    log.warn(`[LivingEconomy] State persistence threw: ${error.message}`);
    return false;
  }
}

function checkpointXEveSourceJournal() {
  initialize(Date.now());
  const result = stateStore.flushSourceJournalDurably({ background: true });
  return result && result.success === true
    ? result
    : { success: false, errorMsg: "LIVING_ECONOMY_SOURCE_CHECKPOINT_FAILED" };
}

function markLivingStateDirty(changedFlight = null) {
  if (typeof lastMarkLivingStateDirty === "function") {
    lastMarkLivingStateDirty(changedFlight);
  }
}

function addEvent(kind, job, details = {}, nowMs = Date.now()) {
  initialize(nowMs);
  const eventNumber = Math.max(1, toPositiveInt(runtimeState.nextEventNumber, 1));
  runtimeState.nextEventNumber = eventNumber + 1;
  const event = {
    eventID: `LEE-${String(eventNumber).padStart(8, "0")}`,
    kind: String(kind || "event"),
    jobID: job && job.jobID ? job.jobID : null,
    occurredAtMs: nowMs,
    ...details,
  };
  runtimeState.events.push(event);
  const maximumRuntimeEventRows = config.xEveEnabled === true
    ? X_EVE_RUNTIME_EVENT_ROWS
    : LEGACY_MAX_EVENT_ROWS;
  let removedEventIDs = [];
  if (runtimeState.events.length > maximumRuntimeEventRows) {
    const removedRuntimeEvents = runtimeState.events
      .slice(0, runtimeState.events.length - maximumRuntimeEventRows);
    if (config.xEveEnabled !== true) {
      removedEventIDs = removedRuntimeEvents.map((removedEvent) => removedEvent.eventID);
    }
    runtimeState.events = runtimeState.events.slice(-maximumRuntimeEventRows);
  }
  if (config.xEveEnabled === true && eventNumber > X_EVE_MAX_EVENT_ROWS) {
    removedEventIDs = [
      `LEE-${String(eventNumber - X_EVE_MAX_EVENT_ROWS).padStart(8, "0")}`,
    ];
  }
  if (config.xEveEnabled === true) {
    const eventBridge = require("../../../services/xEve/xEveEventBridge");
    const staged = stateStore.appendSourceEvent(event, {
      sourceEpochMs: runtimeState.createdAtMs,
      nextEventNumber: runtimeState.nextEventNumber,
      removedEventIDs,
      nowMs,
    });
    if (!staged || staged.success !== true) {
      const reason = staged && staged.errorMsg || "LIVING_ECONOMY_SOURCE_JOURNAL_STAGE_FAILED";
      eventBridge.reportLivingEconomyDurabilityFailure(reason, {
        nowMs,
        eventID: event.eventID,
        sourceEpochMs: runtimeState.createdAtMs,
      });
      const error = new Error(reason);
      error.code = reason;
      error.xEveProductionPaused = true;
      throw error;
    }
    let bridgeResult;
    try {
      bridgeResult = eventBridge.publishLivingUniverseEvent(event, {
          nowMs,
          sourceEpochMs: runtimeState.createdAtMs,
          journalRows: runtimeState.events.length,
          sourceCheckpoint: checkpointXEveSourceJournal,
        });
    } catch (error) {
      const sourceResult = stateStore.flushSourceJournalDurably({ background: false });
      const sourceDurable = Boolean(sourceResult && sourceResult.success === true);
      const reason = sourceDurable
        ? error && (error.code || error.message) || "X_EVE_EVENT_BRIDGE_EXCEPTION"
        : "X_EVE_SOURCE_JOURNAL_FLUSH_FAILED";
      try {
        eventBridge.reportLivingEconomyDurabilityFailure(reason, {
          nowMs,
          eventID: event.eventID,
          sourceEpochMs: runtimeState.createdAtMs,
        });
      } catch (reportError) {
        log.warn(
          `[LivingEconomy] Could not report X-Eve bridge failure: ${reportError.message}`,
        );
      }
      const pausedError = new Error(reason);
      pausedError.code = reason;
      pausedError.xEveProductionPaused = true;
      throw pausedError;
    }
    if (!bridgeResult || bridgeResult.success !== true) {
      const sourceResult = stateStore.flushSourceJournalDurably({ background: false });
      const sourceDurable = Boolean(sourceResult && sourceResult.success === true);
      const reason = sourceDurable
        ? bridgeResult && bridgeResult.errorMsg || "X_EVE_EVENT_DURABILITY_CIRCUIT_OPEN"
        : "X_EVE_SOURCE_JOURNAL_FLUSH_FAILED";
      eventBridge.reportLivingEconomyDurabilityFailure(reason, {
        nowMs,
        eventID: event.eventID,
        sourceEpochMs: runtimeState.createdAtMs,
        countRejected: false,
      });
      log.warn(`[LivingEconomy] X-Eve event bridge rejected ${event.eventID}: ${reason}`);
      const error = new Error(reason);
      error.code = reason;
      error.xEveProductionPaused = true;
      throw error;
    }
  }
  return event;
}

function assertEventProductionAvailable(nowMs = Date.now()) {
  if (config.xEveEnabled !== true) return true;
  const bridgeResult = require("../../../services/xEve/xEveEventBridge")
    .checkLivingEconomyProduction({
      nowMs,
      journalRows: Array.isArray(runtimeState && runtimeState.events)
        ? runtimeState.events.length
        : 0,
      sourceCheckpoint: checkpointXEveSourceJournal,
    });
  if (!bridgeResult || bridgeResult.success !== true) {
    const error = new Error(
      bridgeResult && bridgeResult.errorMsg || "X_EVE_EVENT_DURABILITY_CIRCUIT_OPEN",
    );
    error.code = bridgeResult && bridgeResult.errorMsg ||
      "X_EVE_EVENT_DURABILITY_CIRCUIT_OPEN";
    error.xEveProductionPaused = true;
    throw error;
  }
  return true;
}

function isEventProductionPaused(nowMs = Date.now()) {
  if (config.xEveEnabled !== true) return false;
  return require("../../../services/xEve/xEveEventBridge")
    .getStatus({ nowMs }).productionPaused === true;
}

function buildReplacementRequirementPackage(victim) {
  const npcData = getNpcData();
  const requested = new Map();
  const add = (typeID, quantity, kind) => {
    const normalizedTypeID = toPositiveInt(typeID, 0);
    const normalizedQuantity = toPositiveInt(quantity, 0);
    if (normalizedTypeID <= 0 || normalizedQuantity <= 0) return;
    const current = requested.get(normalizedTypeID) || {
      typeID: normalizedTypeID,
      quantity: 0,
      kind: String(kind || "unknown"),
    };
    current.quantity += normalizedQuantity;
    requested.set(normalizedTypeID, current);
  };
  const hullTypeID = toPositiveInt(victim && victim.shipTypeID, 0);
  add(hullTypeID, 1, "hull");
  const profile = npcData.getNpcProfile(victim && victim.profileID) || {};
  const loadout = npcData.getNpcLoadout(profile.loadoutID) || {};
  let largestModuleStack = 1;
  for (const module of Array.isArray(loadout.modules) ? loadout.modules : []) {
    const quantity = Math.max(1, toPositiveInt(module && module.quantity, 1));
    largestModuleStack = Math.max(largestModuleStack, quantity);
    add(module && module.typeID, quantity, "module");
  }
  for (const charge of Array.isArray(loadout.charges) ? loadout.charges : []) {
    add(
      charge && charge.typeID,
      Math.max(1, toPositiveInt(charge && charge.quantityPerModule, 1)) *
        largestModuleStack,
      "charge",
    );
  }
  const drones = victim && Object.prototype.hasOwnProperty.call(victim, "droneBay")
    ? victim.droneBay
    : loadout.droneBay;
  for (const drone of Array.isArray(drones) ? drones : []) {
    add(drone && drone.typeID, drone && drone.quantity, "drone");
  }

  const requirements = [];
  const missing = [];
  for (const item of requested.values()) {
    const good = catalog.getGood(item.typeID);
    if (!good) {
      missing.push({ ...item });
      continue;
    }
    requirements.push({
      typeID: good.typeID,
      typeName: good.name,
      quantity: item.quantity,
      kind: item.kind,
      unitValueISK: toFiniteNumber(good.priceAnchor, 0),
    });
  }
  return {
    complete: missing.length <= 0,
    hullCovered: hullTypeID > 0 && Boolean(catalog.getGood(hullTypeID)),
    hullTypeID,
    requirements: requirements.sort((left, right) => left.typeID - right.typeID),
    missing: missing.sort((left, right) => left.typeID - right.typeID),
  };
}

function buildReplacementRequirements(victim) {
  return buildReplacementRequirementPackage(victim).requirements;
}

function auditReplacementCoverage(actors) {
  const rows = Array.isArray(actors)
    ? actors
    : Object.values(actors && typeof actors === "object" ? actors : {});
  const missingByTypeID = new Map();
  let actorsWithGaps = 0;
  let actorsWithHullGaps = 0;
  for (const actor of rows) {
    const replacementPackage = buildReplacementRequirementPackage(actor);
    if (replacementPackage.complete) continue;
    actorsWithGaps += 1;
    if (!replacementPackage.hullCovered) actorsWithHullGaps += 1;
    for (const item of replacementPackage.missing) {
      const current = missingByTypeID.get(item.typeID) || {
        typeID: item.typeID,
        kind: item.kind,
        actors: 0,
        quantity: 0,
      };
      current.actors += 1;
      current.quantity += item.quantity;
      missingByTypeID.set(item.typeID, current);
    }
  }
  return {
    actors: rows.length,
    actorsFullyCovered: Math.max(0, rows.length - actorsWithGaps),
    actorsWithGaps,
    actorsWithHullGaps,
    coveragePercent: rows.length > 0
      ? roundMoney((rows.length - actorsWithGaps) * 100 / rows.length)
      : 100,
    hullCoveragePercent: rows.length > 0
      ? roundMoney((rows.length - actorsWithHullGaps) * 100 / rows.length)
      : 100,
    missingTypeCount: missingByTypeID.size,
    missing: [...missingByTypeID.values()]
      .sort((left, right) => right.actors - left.actors || left.typeID - right.typeID),
  };
}

function registerReplacementLoss(details = {}) {
  const nowMs = toFiniteNumber(details.nowMs, Date.now());
  initialize(nowMs);
  const demandIDs = [];
  for (const victim of Array.isArray(details.victims) ? details.victims : []) {
    const existing = Object.values(runtimeState.replacementDemands || {}).find((demand) => (
      String(demand.encounterID || "") === String(details.encounterID || "") &&
      String(demand.actorID || "") === String(victim && victim.actorID || "")
    ));
    if (existing) {
      demandIDs.push(existing.demandID);
      continue;
    }
    const station = catalog.getStation(victim && victim.homeStationID) ||
      catalog.getStationForSystem(victim && victim.homeSystemID) ||
      catalog.getStation(60003760);
    const replacementPackage = buildReplacementRequirementPackage(victim);
    const requirements = replacementPackage.requirements;
    if (
      !station ||
      !replacementPackage.complete ||
      !replacementPackage.hullCovered ||
      requirements.length <= 0
    ) {
      runtimeState.metrics.replacementDemandValidationFailures =
        toPositiveInt(
          runtimeState.metrics.replacementDemandValidationFailures,
          0,
        ) + 1;
      runtimeState.metrics.replacementRequirementUnitsRejected =
        toPositiveInt(
          runtimeState.metrics.replacementRequirementUnitsRejected,
          0,
        ) + replacementPackage.missing.reduce(
          (sum, item) => sum + toPositiveInt(item && item.quantity, 0),
          0,
        );
      addEvent("replacement_demand_rejected", null, {
        encounterID: String(details.encounterID || ""),
        actorID: String(victim && victim.actorID || ""),
        flightID: String(victim && victim.flightID || ""),
        shipTypeID: replacementPackage.hullTypeID,
        stationResolved: Boolean(station),
        missing: replacementPackage.missing,
      }, nowMs);
      continue;
    }
    const demandNumber = Math.max(1, toPositiveInt(runtimeState.nextReplacementDemandNumber, 1));
    runtimeState.nextReplacementDemandNumber = demandNumber + 1;
    const demandID = `LER-${String(demandNumber).padStart(8, "0")}`;
    const requestedUnits = requirements.reduce((sum, item) => sum + item.quantity, 0);
    const valueISK = roundMoney(requirements.reduce(
      (sum, item) => sum + (item.quantity * item.unitValueISK),
      0,
    ));
    const shipTypeID = toPositiveInt(victim.shipTypeID, 0);
    const hullValueISK = roundMoney(requirements
      .filter((item) => Number(item.typeID) === shipTypeID)
      .reduce(
        (sum, item) => sum + (item.quantity * item.unitValueISK),
        0,
      ));
    const fittingValueISK = roundMoney(Math.max(0, valueISK - hullValueISK));
    runtimeState.replacementDemands[demandID] = {
      demandID,
      encounterID: String(details.encounterID || ""),
      actorID: String(victim.actorID || ""),
      flightID: String(victim.flightID || ""),
      profileID: String(victim.profileID || ""),
      shipTypeID,
      shipName: String(victim.shipName || `type ${victim.shipTypeID}`),
      corporationID: toPositiveInt(victim.corporationID, 0),
      stationID: station.stationID,
      systemID: station.systemID,
      status: "pending",
      requirements,
      fulfilledQuantities: {},
      requestedUnits,
      valueISK,
      createdAtMs: nowMs,
      fulfilledAtMs: 0,
      lastError: null,
      adjustmentNamespaceVersion: REPLACEMENT_ADJUSTMENT_NAMESPACE_VERSION,
    };
    runtimeState.metrics.replacementDemandsCreated += 1;
    runtimeState.metrics.replacementUnitsRequested += requestedUnits;
    runtimeState.metrics.replacementValueISK = roundMoney(
      toFiniteNumber(runtimeState.metrics.replacementValueISK, 0) + valueISK,
    );
    runtimeState.metrics.replacementHullValueISK = roundMoney(
      toFiniteNumber(runtimeState.metrics.replacementHullValueISK, 0) +
        hullValueISK,
    );
    runtimeState.metrics.replacementFittingValueISK = roundMoney(
      toFiniteNumber(runtimeState.metrics.replacementFittingValueISK, 0) +
        fittingValueISK,
    );
    runtimeState.metrics.replacementHullLosses += 1;
    const hullLossesByType = runtimeState.metrics.replacementHullLossesByType &&
      typeof runtimeState.metrics.replacementHullLossesByType === "object"
      ? runtimeState.metrics.replacementHullLossesByType
      : {};
    const hullKey = String(shipTypeID || "unknown");
    const hullRow = hullLossesByType[hullKey] &&
      typeof hullLossesByType[hullKey] === "object"
      ? hullLossesByType[hullKey]
      : {
          shipTypeID,
          shipName: String(victim.shipName || `type ${shipTypeID || "unknown"}`),
          losses: 0,
          replacementValueISK: 0,
        };
    hullRow.losses = toPositiveInt(hullRow.losses, 0) + 1;
    hullRow.replacementValueISK = roundMoney(
      toFiniteNumber(hullRow.replacementValueISK, 0) + valueISK,
    );
    hullLossesByType[hullKey] = hullRow;
    runtimeState.metrics.replacementHullLossesByType = hullLossesByType;
    addEvent("replacement_demand_created", null, {
      demandID,
      encounterID: String(details.encounterID || ""),
      actorID: String(victim.actorID || ""),
      stationID: station.stationID,
      shipTypeID: toPositiveInt(victim.shipTypeID, 0),
      requestedUnits,
      valueISK,
    }, nowMs);
    demandIDs.push(demandID);
  }
  if (demandIDs.length > 0) {
    notifyExternalFreightDemandMutation();
    persistState(nowMs);
  }
  return demandIDs;
}

function buildCampaignSupplyRequirements(intensity = 1) {
  const scale = Math.max(0.5, Math.min(2, toFiniteNumber(intensity, 1)));
  return [
    { typeID: 210, quantity: Math.ceil(480 * scale) },
    { typeID: 222, quantity: Math.ceil(480 * scale) },
    { typeID: 2464, quantity: Math.ceil(2 * scale) },
    { typeID: 28668, quantity: Math.ceil(40 * scale) },
  ].map((entry) => {
    const good = catalog.getGood(entry.typeID);
    return {
      ...entry,
      typeName: good ? good.name : `type ${entry.typeID}`,
      unitValueISK: good ? toFiniteNumber(good.priceAnchor, 0) : 0,
    };
  });
}

function registerCampaignDemand(details = {}) {
  const nowMs = toFiniteNumber(details.nowMs, Date.now());
  initialize(nowMs);
  if (!details.campaignID || !details.encounterID) return null;
  const existing = Object.values(runtimeState.campaignDemands || {}).find(
    (demand) => String(demand.encounterID || "") === String(details.encounterID),
  );
  if (existing) return existing.demandID;
  const station = catalog.getStation(details.stationID) ||
    catalog.getStationForSystem(details.systemID) ||
    catalog.getStation(60003760);
  if (!station) return null;
  const requirements = buildCampaignSupplyRequirements(details.intensity);
  const demandNumber = Math.max(1, toPositiveInt(runtimeState.nextCampaignDemandNumber, 1));
  runtimeState.nextCampaignDemandNumber = demandNumber + 1;
  const demandID = `LEC-${String(demandNumber).padStart(8, "0")}`;
  const requestedUnits = requirements.reduce((sum, item) => sum + item.quantity, 0);
  const valueISK = roundMoney(requirements.reduce(
    (sum, item) => sum + (item.quantity * item.unitValueISK),
    0,
  ));
  runtimeState.campaignDemands[demandID] = {
    demandID,
    campaignID: String(details.campaignID),
    campaignName: String(details.campaignName || details.campaignID),
    encounterID: String(details.encounterID),
    stationID: station.stationID,
    systemID: station.systemID,
    status: "pending",
    requirements,
    fulfilledQuantities: {},
    requestedUnits,
    valueISK,
    createdAtMs: nowMs,
    fulfilledAtMs: 0,
    lastError: null,
    adjustmentNamespaceVersion: CAMPAIGN_ADJUSTMENT_NAMESPACE_VERSION,
  };
  runtimeState.metrics.campaignDemandsCreated += 1;
  runtimeState.metrics.campaignUnitsRequested += requestedUnits;
  runtimeState.metrics.campaignSupplyValueISK = roundMoney(
    toFiniteNumber(runtimeState.metrics.campaignSupplyValueISK, 0) + valueISK,
  );
  addEvent("campaign_supply_demand_created", null, {
    demandID,
    campaignID: String(details.campaignID),
    encounterID: String(details.encounterID),
    stationID: station.stationID,
    requestedUnits,
    valueISK,
  }, nowMs);
  notifyExternalFreightDemandMutation();
  persistState(nowMs);
  return demandID;
}

function listReplacementRequirements() {
  initialize();
  const rows = [];
  for (const demand of Object.values(runtimeState.replacementDemands || {})) {
    if (String(demand.status || "") !== "pending") continue;
    for (const item of Array.isArray(demand.requirements) ? demand.requirements : []) {
      const fulfilled = toPositiveInt(demand.fulfilledQuantities && demand.fulfilledQuantities[item.typeID], 0);
      const remainingQuantity = Math.max(0, toPositiveInt(item.quantity, 0) - fulfilled);
      if (remainingQuantity <= 0) continue;
      rows.push({
        demandID: demand.demandID,
        stationID: demand.stationID,
        systemID: demand.systemID,
        typeID: item.typeID,
        remainingQuantity,
        demandKind: "replacement",
        demandClass: "replacement",
        requirementKind: String(
          item.kind ||
          (Number(item.typeID) === Number(demand.shipTypeID)
            ? "hull"
            : "fitting"),
        ),
        demandCreatedAtMs: toFiniteNumber(demand.createdAtMs, 0),
        preferredProducerStationID: toPositiveInt(
          item.supply && item.supply.producerStationID,
          0,
        ),
      });
      for (const input of Array.isArray(item.supply && item.supply.inputRequirements)
        ? item.supply.inputRequirements
        : []) {
        const requiredQuantity = toPositiveInt(
          input && input.requiredQuantity,
          0,
        );
        const producerStationID = toPositiveInt(item.supply && item.supply.producerStationID, 0);
        if (!requiredQuantity || !producerStationID) continue;
        const producerStation = catalog.getStation(producerStationID);
        rows.push({
          demandID: `${demand.demandID}:input:${item.typeID}:${input.typeID}`,
          parentDemandID: demand.demandID,
          stationID: producerStationID,
          systemID: producerStation && producerStation.systemID || 0,
          typeID: input.typeID,
          remainingQuantity: requiredQuantity,
          demandKind: "production_input",
          demandClass: "replacement",
          outputTypeID: item.typeID,
          outputRequirementKind: String(
            item.kind ||
            (Number(item.typeID) === Number(demand.shipTypeID)
              ? "hull"
              : "fitting"),
          ),
          demandCreatedAtMs: toFiniteNumber(demand.createdAtMs, 0),
        });
      }
    }
  }
  for (const demand of Object.values(runtimeState.campaignDemands || {})) {
    if (String(demand.status || "") !== "pending") continue;
    for (const item of Array.isArray(demand.requirements) ? demand.requirements : []) {
      const fulfilled = toPositiveInt(
        demand.fulfilledQuantities && demand.fulfilledQuantities[item.typeID],
        0,
      );
      const remainingQuantity = Math.max(0, toPositiveInt(item.quantity, 0) - fulfilled);
      if (remainingQuantity <= 0) continue;
      rows.push({
        demandID: demand.demandID,
        stationID: demand.stationID,
        systemID: demand.systemID,
        typeID: item.typeID,
        remainingQuantity,
        demandKind: "campaign_supply",
        demandClass: "campaign",
        demandCreatedAtMs: toFiniteNumber(demand.createdAtMs, 0),
        preferredProducerStationID: toPositiveInt(
          item.supply && item.supply.producerStationID,
          0,
        ),
      });
      for (const input of Array.isArray(item.supply && item.supply.inputRequirements)
        ? item.supply.inputRequirements
        : []) {
        const requiredQuantity = toPositiveInt(
          input && input.requiredQuantity,
          0,
        );
        const producerStationID = toPositiveInt(item.supply && item.supply.producerStationID, 0);
        if (!requiredQuantity || !producerStationID) continue;
        const producerStation = catalog.getStation(producerStationID);
        rows.push({
          demandID: `${demand.demandID}:input:${item.typeID}:${input.typeID}`,
          parentDemandID: demand.demandID,
          stationID: producerStationID,
          systemID: producerStation && producerStation.systemID || 0,
          typeID: input.typeID,
          remainingQuantity: requiredQuantity,
          demandKind: "production_input",
          demandClass: "campaign",
          outputTypeID: item.typeID,
          demandCreatedAtMs: toFiniteNumber(demand.createdAtMs, 0),
        });
      }
    }
  }
  return rows;
}

async function collectPendingSorted(collection, predicate, timestampSelector, workBudget) {
  const rows = [];
  let scanned = 0;
  for (const key in collection) {
    if (!Object.prototype.hasOwnProperty.call(collection, key)) continue;
    scanned += 1;
    if (workBudget && scanned % 128 === 0) await workBudget.checkpoint();
    const row = collection[key];
    if (predicate(row)) rows.push(row);
  }
  rows.sort((left, right) => (
    toFiniteNumber(timestampSelector(left), 0) - toFiniteNumber(timestampSelector(right), 0)
  ));
  return rows;
}

function makeReplacementAdjustmentID(demand, station, item, fulfilledQuantity) {
  const demandID = String(demand && demand.demandID || "unknown");
  const typeID = toPositiveInt(item && item.typeID, 0);
  if (
    toPositiveInt(demand && demand.adjustmentNamespaceVersion, 1) <
      REPLACEMENT_ADJUSTMENT_NAMESPACE_VERSION
  ) {
    // A demand written by the all-or-nothing implementation must try its
    // original token first. If that exact mutation committed before a crash,
    // the market daemon replays its receipt instead of consuming stock twice;
    // a content mismatch collides and promotes the demand to the v2 namespace.
    return `living-replacement:${demandID}:${typeID}`;
  }
  const fulfilled = Math.max(0, Math.trunc(toFiniteNumber(fulfilledQuantity, 0)));
  const demandCreatedAtMs = toPositiveInt(demand && demand.createdAtMs, 1);
  const stationID = toPositiveInt(
    station && station.stationID,
    toPositiveInt(demand && demand.stationID, 0),
  );
  // The collision epoch salts the token after an identity collision — a
  // committed-but-unpersisted attempt whose delta no longer matches. The
  // salted retry trades a bounded, observable re-consume for what would
  // otherwise be a permanently wedged demand and a stranded flight.
  const collisionEpoch = toPositiveInt(demand && demand.adjustmentCollisionEpoch, 0);
  const epochSuffix = collisionEpoch > 0 ? `:r${collisionEpoch}` : "";
  return `living-replacement:v2:${demandCreatedAtMs}:${demandID}:` +
    `${stationID}:${typeID}:${fulfilled}${epochSuffix}`;
}

function promoteLegacyReplacementAdjustmentNamespace(demand, nowMs) {
  if (
    !demand ||
    toPositiveInt(demand.adjustmentNamespaceVersion, 1) >=
      REPLACEMENT_ADJUSTMENT_NAMESPACE_VERSION
  ) {
    return false;
  }
  demand.adjustmentNamespaceVersion = REPLACEMENT_ADJUSTMENT_NAMESPACE_VERSION;
  demand.adjustmentNamespaceMigratedAtMs = nowMs;
  runtimeState.metrics.replacementAdjustmentNamespaceMigrations =
    toPositiveInt(
      runtimeState.metrics.replacementAdjustmentNamespaceMigrations,
      0,
    ) + 1;
  return true;
}

function bumpReplacementAdjustmentCollisionEpoch(demand, nowMs) {
  if (!demand) return false;
  demand.adjustmentCollisionEpoch =
    toPositiveInt(demand.adjustmentCollisionEpoch, 0) + 1;
  demand.adjustmentCollisionAtMs = nowMs;
  runtimeState.metrics.replacementAdjustmentCollisionRetries =
    toPositiveInt(
      runtimeState.metrics.replacementAdjustmentCollisionRetries,
      0,
    ) + 1;
  return true;
}

function getFactionShipyardHullsPerPulse() {
  const base = Math.max(
    1,
    Math.min(
      48,
      toPositiveInt(config.livingEconomyFactionShipyardHullsPerPulse, 12),
    ),
  );
  // Mobilization sympathy: pirate hull supply keeps step with the surged
  // empire pipeline during loss bursts. Hard clamp 48 preserved.
  return mobilization.scaleUp(base, 4, mobilization.getLevel(), 48);
}

async function replenishFactionShipyards(stockMap, nowMs, workBudget = null) {
  if (config.livingEconomyFactionShipyardEnabled !== true) return;
  // Pirate faction hulls are not manufactured from empire minerals; the
  // owning faction supplies its own shipyards. Seeding is demand-driven:
  // stock only appears while pending replacement demand for the hull type
  // exceeds what already exists in the modeled network plus what freight
  // already has in transit, so the faction never floods the market. Only
  // replacement demands are scanned: campaign supply requirements never
  // include pirate faction hulls (buildCampaignSupplyRequirements is a
  // fixed consumables list) — extend this scan if that ever changes.
  const baseSmugglerAgeMs = Math.max(
    5,
    Math.min(
      1440,
      toPositiveInt(config.livingEconomyFactionSmugglerDeliveryMinutes, 30),
    ),
  ) * 60_000;
  // Mobilization: smugglers deliver sooner while the war economy is surged
  // (30 min -> ~10 min at full level), floored at the config minimum of 5.
  const smugglerAgeMs = mobilization.scaleDown(
    baseSmugglerAgeMs,
    3,
    mobilization.getLevel(),
    5 * 60_000,
  );
  const remainingByTypeID = new Map();
  const smugglerNeedByKey = new Map();
  let scanned = 0;
  for (const demand of Object.values(runtimeState.replacementDemands || {})) {
    scanned += 1;
    if (workBudget && scanned % 128 === 0) await workBudget.checkpoint();
    if (String(demand && demand.status || "") !== "pending") continue;
    const hullTypeID = toPositiveInt(demand.shipTypeID, 0);
    if (!catalog.isPirateFactionHull(hullTypeID)) continue;
    const hullItem = (Array.isArray(demand.requirements) ? demand.requirements : [])
      .find((item) => toPositiveInt(item && item.typeID, 0) === hullTypeID);
    const fulfilled = toPositiveInt(
      demand.fulfilledQuantities && demand.fulfilledQuantities[hullTypeID],
      0,
    );
    const remaining = Math.max(
      0,
      toPositiveInt(hullItem && hullItem.quantity, 0) - fulfilled,
    );
    if (remaining <= 0) continue;
    remainingByTypeID.set(
      hullTypeID,
      toPositiveInt(remainingByTypeID.get(hullTypeID), 0) + remaining,
    );
    // Lowsec and nullsec routes admit only secure convoys, so hull freight
    // from the faction shipyard may never materialize. A demand that has
    // waited past the smuggler window is served off-screen: the hull is
    // delivered directly at the demand's home station.
    if (nowMs - toFiniteNumber(demand.createdAtMs, nowMs) >= smugglerAgeMs) {
      const key = `${toPositiveInt(demand.stationID, 0)}:${hullTypeID}`;
      smugglerNeedByKey.set(
        key,
        toPositiveInt(smugglerNeedByKey.get(key), 0) + remaining,
      );
    }
  }
  if (remainingByTypeID.size <= 0) return;

  const inTransitByTypeID = new Map();
  const inTransitToStationByKey = new Map();
  for (const job of Object.values(runtimeState.jobs || {})) {
    if (!isActiveJob(job)) continue;
    const typeID = toPositiveInt(job.typeID, 0);
    if (!remainingByTypeID.has(typeID)) continue;
    const quantity = toPositiveInt(job.quantity, 0);
    inTransitByTypeID.set(
      typeID,
      toPositiveInt(inTransitByTypeID.get(typeID), 0) + quantity,
    );
    const destinationKey =
      `${toPositiveInt(job.destinationStationID, 0)}:${typeID}`;
    inTransitToStationByKey.set(
      destinationKey,
      toPositiveInt(inTransitToStationByKey.get(destinationKey), 0) + quantity,
    );
  }

  const shortfalls = [];
  for (const [typeID, remaining] of remainingByTypeID.entries()) {
    let networkQuantity = 0;
    for (const station of catalog.STATIONS) {
      networkQuantity += toPositiveInt(
        getStockRow(stockMap, station.stationID, typeID).quantity,
        0,
      );
      scanned += 1;
      if (workBudget && scanned % 256 === 0) await workBudget.checkpoint();
    }
    const shortfall = remaining -
      networkQuantity -
      toPositiveInt(inTransitByTypeID.get(typeID), 0);
    if (shortfall > 0) shortfalls.push({ typeID, shortfall });
  }
  if (shortfalls.length <= 0 && smugglerNeedByKey.size <= 0) return;
  shortfalls.sort((left, right) => right.shortfall - left.shortfall);

  runtimeState.factionShipyardSeedCounters =
    runtimeState.factionShipyardSeedCounters &&
    typeof runtimeState.factionShipyardSeedCounters === "object"
      ? runtimeState.factionShipyardSeedCounters
      : {};
  let budget = getFactionShipyardHullsPerPulse();
  const requests = [];
  const buildSeedEntry = (stationEntry, typeID, good, quantity, kind) => {
    const counterKey = `${stationEntry.stationID}:${typeID}`;
    const sequence = toPositiveInt(
      runtimeState.factionShipyardSeedCounters[counterKey],
      0,
    );
    const row = stockMap.get(stockKey(stationEntry.stationID, typeID));
    const rowExists = Boolean(row) && toFiniteNumber(row.quantity, -1) >= 0;
    // The quantity rides in the token: a crash-replay that recomputes a
    // different quantity mints a fresh token instead of colliding. The worst
    // case is a bounded over-seed, which the shortfall math absorbs on the
    // next pulse. runtimeState.createdAtMs salts the token across economy
    // resets; catalog migrations preserve the counters.
    const adjustmentID =
      `living-faction-import:v1:${toPositiveInt(runtimeState.createdAtMs, 1)}:` +
      `${stationEntry.stationID}:${typeID}:${sequence}:q${quantity}`;
    return {
      counterKey,
      sequence,
      quantity,
      kind,
      typeID,
      stationID: stationEntry.stationID,
      stationName: String(stationEntry.name || stationEntry.stationID),
      request: rowExists
        ? {
            station_id: stationEntry.stationID,
            type_id: typeID,
            delta_quantity: quantity,
            new_price: computePrice(
              good,
              stationEntry,
              toPositiveInt(row && row.quantity, 0) + quantity,
            ),
            reason: "living economy faction shipyard supply",
            adjustment_id: adjustmentID,
          }
        : {
            station_id: stationEntry.stationID,
            type_id: typeID,
            delta_quantity: null,
            new_quantity: quantity,
            new_price: computePrice(good, stationEntry, quantity),
            reason: "living economy faction shipyard supply",
            adjustment_id: adjustmentID,
            allow_create: true,
            create_only: true,
          },
    };
  };

  // Smuggler deliveries take the budget first: they serve demands the
  // freight network has already failed to reach within the delivery window.
  // Need is measured against the demand station's local stock only — remote
  // shipyard stock is exactly what could not be routed.
  const smugglerNeeds = [...smugglerNeedByKey.entries()]
    .map(([key, need]) => {
      const [stationIDText, typeIDText] = String(key).split(":");
      return {
        stationID: toPositiveInt(stationIDText, 0),
        typeID: toPositiveInt(typeIDText, 0),
        need,
      };
    })
    .sort((left, right) => right.need - left.need);
  const usedCounterKeys = new Set();
  const smugglerSeededByTypeID = new Map();
  for (const entry of smugglerNeeds) {
    if (budget <= 0) break;
    const good = catalog.getGood(entry.typeID);
    const stationEntry = catalog.getStation(entry.stationID);
    if (!good || !stationEntry) continue;
    const localQuantity = toPositiveInt(
      getStockRow(stockMap, entry.stationID, entry.typeID).quantity,
      0,
    );
    const inbound = toPositiveInt(
      inTransitToStationByKey.get(`${entry.stationID}:${entry.typeID}`),
      0,
    );
    const need = Math.min(
      Math.max(0, entry.need - localQuantity - inbound),
      budget,
    );
    if (need <= 0) continue;
    const seedEntry = buildSeedEntry(
      stationEntry, entry.typeID, good, need, "smuggler",
    );
    if (usedCounterKeys.has(seedEntry.counterKey)) continue;
    usedCounterKeys.add(seedEntry.counterKey);
    budget -= need;
    smugglerSeededByTypeID.set(
      entry.typeID,
      toPositiveInt(smugglerSeededByTypeID.get(entry.typeID), 0) + need,
    );
    requests.push(seedEntry);
  }

  for (const entry of shortfalls) {
    if (budget <= 0) break;
    const good = catalog.getGood(entry.typeID);
    if (!good) continue;
    const factionID = catalog.getPirateFactionID(entry.typeID);
    const shipyard =
      catalog.getFactionShipyardStations(factionID, good)[0] || null;
    if (!shipyard) continue;
    // Smuggler deliveries this pulse already cover part of the type's
    // shortfall; seeding the remainder at the shipyard on top of them would
    // strand duplicate hulls at a station freight cannot serve.
    const adjustedShortfall = entry.shortfall -
      toPositiveInt(smugglerSeededByTypeID.get(entry.typeID), 0);
    if (adjustedShortfall <= 0) continue;
    const quantity = Math.min(adjustedShortfall, budget);
    const seedEntry = buildSeedEntry(
      shipyard, entry.typeID, good, quantity, "shipyard",
    );
    if (usedCounterKeys.has(seedEntry.counterKey)) continue;
    usedCounterKeys.add(seedEntry.counterKey);
    budget -= quantity;
    requests.push(seedEntry);
  }
  if (requests.length <= 0) return;

  try {
    const call = () => marketDaemonClient.call("AdjustSeedStocks", {
      adjustments: requests.map((entry) => entry.request),
    });
    const responses = workBudget && typeof workBudget.waitFor === "function"
      ? await workBudget.waitFor("market.AdjustSeedStocks.factionShipyard", call)
      : await call();
    if (!Array.isArray(responses) || responses.length !== requests.length) {
      throw new Error(
        "faction shipyard replenishment returned an invalid response count",
      );
    }
    for (let index = 0; index < requests.length; index += 1) {
      const entry = requests[index];
      const response = responses[index];
      updateStockMap(stockMap, response);
      runtimeState.factionShipyardSeedCounters[entry.counterKey] =
        entry.sequence + 1;
      if (response && response.applied === true) {
        if (entry.kind === "smuggler") {
          runtimeState.metrics.factionSmugglerHullsDelivered =
            toPositiveInt(
              runtimeState.metrics.factionSmugglerHullsDelivered,
              0,
            ) + entry.quantity;
        } else {
          runtimeState.metrics.factionShipyardHullsSeeded =
            toPositiveInt(runtimeState.metrics.factionShipyardHullsSeeded, 0) +
            entry.quantity;
        }
        addEvent(
          entry.kind === "smuggler"
            ? "faction_smuggler_hull_delivered"
            : "faction_shipyard_hull_seeded",
          null,
          {
            stationID: entry.stationID,
            stationName: entry.stationName,
            typeID: entry.typeID,
            quantity: entry.quantity,
          },
          nowMs,
        );
      }
    }
  } catch (error) {
    runtimeState.metrics.factionShipyardSeedFailures =
      toPositiveInt(runtimeState.metrics.factionShipyardSeedFailures, 0) + 1;
    if (isStockAdjustmentIdentityCollision(error)) {
      // A committed-but-unpersisted batch replayed with different content.
      // The seed batch is atomic, so one colliding token blocks every
      // faction; bump every batched sequence so the next pulse mints fresh
      // tokens. The cost is a bounded over-seed the shortfall math absorbs.
      for (const entry of requests) {
        runtimeState.factionShipyardSeedCounters[entry.counterKey] =
          entry.sequence + 1;
      }
      runtimeState.metrics.factionShipyardSeedCollisionRetries =
        toPositiveInt(
          runtimeState.metrics.factionShipyardSeedCollisionRetries,
          0,
        ) + 1;
    }
    log.warn(
      "[LivingEconomy] Faction shipyard replenishment failed: " +
      String(error && error.message || error),
    );
  }
}

async function processReplacementDemands(stockMap, nowMs, workBudget = null) {
  // The budget counts SUBMITTED lines, not successes: under a market-daemon
  // outage every submission fails, and a success-only counter would walk the
  // entire pending backlog issuing doomed RPCs each pulse.
  let submitted = 0;
  const maximumAdjustments = 24;
  const pending = await collectPendingSorted(
    runtimeState.replacementDemands || {},
    (entry) => String(entry && entry.status || "") === "pending",
    (entry) => entry && entry.createdAtMs,
    workBudget,
  );
  for (const demand of pending) {
    if (workBudget) await workBudget.checkpoint();
    if (submitted >= maximumAdjustments) break;
    const station = catalog.getStation(demand.stationID);
    if (!station) {
      demand.lastError = "REPLACEMENT_STATION_NOT_FOUND";
      continue;
    }
    demand.fulfilledQuantities = demand.fulfilledQuantities && typeof demand.fulfilledQuantities === "object"
      ? demand.fulfilledQuantities
      : {};
    // Each line stages independently: delivered goods are consumed from the
    // market as soon as they are locally available and are earmarked on the
    // demand through fulfilledQuantities, oldest demand first. This keeps
    // staged fittings out of reach of campaign consumption and outbound
    // freight while the hull line is still in production. The doctrine is
    // released as one unit regardless: the flight respawns only when every
    // line completes (the `complete` check below), so partial staging never
    // fields a partially fitted ship.
    const wasLegacyBatch =
      toPositiveInt(demand.adjustmentNamespaceVersion, 1) <
        REPLACEMENT_ADJUSTMENT_NAMESPACE_VERSION;
    const pendingItems = [];
    for (const item of Array.isArray(demand.requirements) ? demand.requirements : []) {
      if (submitted + pendingItems.length >= maximumAdjustments) break;
      const fulfilled = toPositiveInt(demand.fulfilledQuantities[item.typeID], 0);
      const remaining = Math.max(0, toPositiveInt(item.quantity, 0) - fulfilled);
      if (remaining <= 0) continue;
      const row = getStockRow(stockMap, station.stationID, item.typeID);
      const consumed = Math.min(remaining, toPositiveInt(row.quantity, 0));
      if (consumed <= 0) continue;
      const good = catalog.getGood(item.typeID);
      if (!good) continue;
      pendingItems.push({
        item,
        fulfilled,
        consumed,
        adjustment: {
          adjustmentID: makeReplacementAdjustmentID(
            demand,
            station,
            item,
            fulfilled,
          ),
          station,
          good,
          deltaQuantity: -consumed,
          reason: `living replacement package ${demand.demandID}`,
          stockMap,
        },
      });
    }
    if (pendingItems.length > 0) {
      submitted += pendingItems.length;
      const results = await adjustStocks(
        pendingItems.map((entry) => entry.adjustment),
        workBudget,
      );
      let packageError = null;
      let consumedAnyLine = false;
      let sawCollision = false;
      // Credit every success row before interpreting failures: with the
      // per-row fallback inside adjustStocks, success rows are individually
      // committed market mutations and must never be dropped.
      for (let index = 0; index < pendingItems.length; index += 1) {
        const entry = pendingItems[index];
        const result = results[index];
        if (!result || result.success !== true) {
          if (isStockAdjustmentIdentityCollision(result)) sawCollision = true;
          packageError = getStockAdjustmentErrorMessage(result) ||
            "REPLACEMENT_STOCK_ADJUSTMENT_FAILED";
          continue;
        }
        demand.fulfilledQuantities[entry.item.typeID] =
          entry.fulfilled + entry.consumed;
        // Progress stamp: the mobilization age signal excludes demands that
        // have gone hours without any staging progress (poisoned-row guard).
        demand.lastProgressAtMs = nowMs;
        runtimeState.metrics.replacementUnitsFulfilled += entry.consumed;
        consumedAnyLine = true;
      }
      if (sawCollision) {
        if (wasLegacyBatch) {
          // Every ID in this batch was legacy-form; one promotion covers all
          // collisions, and the retry next pulse runs under unique v2 tokens.
          promoteLegacyReplacementAdjustmentNamespace(demand, nowMs);
        } else {
          // A v2 collision means an earlier attempt committed at the daemon
          // but its response or persist was lost and the recomputed delta no
          // longer matches. Salt the next attempt instead of wedging the
          // demand. The epoch is demand-scoped, so the re-consume is bounded
          // by this demand's committed-but-uncredited lines at bump time
          // (salted siblings forfeit exact receipt replay); the triggering
          // collision is observable via replacementAdjustmentCollisionRetries.
          // Campaign and industry demands keep the quarantine idiom because
          // their deltas are replay-stable; replacement staging deltas are
          // volatile by design, which is why quarantine is wrong here.
          bumpReplacementAdjustmentCollisionEpoch(demand, nowMs);
        }
      }
      // A legacy token can be used at most once per line; after the first
      // successful consumption, later partial top-ups for the same line need
      // the fulfilled-suffixed v2 namespace to stay unique. Promotion waits
      // for a fully clean batch: rotating the namespace while a sibling line
      // failed with unknown outcome would forfeit that line's chance at an
      // exact idempotent replay of a committed-but-lost legacy receipt.
      if (consumedAnyLine && !packageError) {
        promoteLegacyReplacementAdjustmentNamespace(demand, nowMs);
      }
      demand.lastError = packageError;
    } else {
      // Nothing was locally stageable this pulse: any recorded error belongs
      // to a previous attempt and would otherwise inflate pendingWithErrors
      // indefinitely while the demand merely waits for freight.
      demand.lastError = null;
    }
    const complete = (demand.requirements || []).every((item) => (
      toPositiveInt(demand.fulfilledQuantities[item.typeID], 0) >= toPositiveInt(item.quantity, 0)
    ));
    if (complete) {
      demand.status = "fulfilled";
      demand.fulfilledAtMs = nowMs;
      runtimeState.metrics.replacementDemandsFulfilled += 1;
      if (!demand.fulfillmentValueAccountingAtMs) {
        runtimeState.metrics.replacementValueFulfilledISK = roundMoney(
          toFiniteNumber(
            runtimeState.metrics.replacementValueFulfilledISK,
            0,
          ) + Math.max(0, toFiniteNumber(demand.valueISK, 0)),
        );
        demand.fulfillmentValueAccountingAtMs = nowMs;
      }
      addEvent("replacement_demand_fulfilled", null, {
        demandID: demand.demandID,
        encounterID: demand.encounterID,
        actorID: demand.actorID,
        stationID: demand.stationID,
        shipTypeID: demand.shipTypeID,
        requestedUnits: demand.requestedUnits,
      }, nowMs);
    }
  }
}

function makeCampaignAdjustmentID(demand, station, item, fulfilledQuantity) {
  const demandID = String(demand && demand.demandID || "unknown");
  const typeID = toPositiveInt(item && item.typeID, 0);
  const fulfilled = Math.max(0, Math.trunc(toFiniteNumber(fulfilledQuantity, 0)));
  if (
    toPositiveInt(demand && demand.adjustmentNamespaceVersion, 1) <
      CAMPAIGN_ADJUSTMENT_NAMESPACE_VERSION
  ) {
    // A demand written by the legacy implementation must try its original
    // token first. If that exact mutation committed before a crash, the market
    // daemon can safely replay its receipt instead of consuming stock twice.
    return `living-campaign:${demandID}:${typeID}:${fulfilled}`;
  }
  const demandCreatedAtMs = toPositiveInt(demand && demand.createdAtMs, 1);
  const stationID = toPositiveInt(
    station && station.stationID,
    toPositiveInt(demand && demand.stationID, 0),
  );
  return `living-campaign:v2:${demandCreatedAtMs}:${demandID}:` +
    `${stationID}:${typeID}:${fulfilled}`;
}

function getStockAdjustmentErrorMessage(result) {
  return String(
    result && result.error && result.error.message ||
    result && result.errorMsg ||
    result && result.message ||
    result ||
    "",
  );
}

function isStockAdjustmentIdentityCollision(result) {
  return /seed stock adjustment id was already used (?:for|with) a different/i.test(
    getStockAdjustmentErrorMessage(result),
  );
}

function promoteLegacyCampaignAdjustmentNamespace(demand, result, nowMs) {
  if (
    !demand ||
    toPositiveInt(demand.adjustmentNamespaceVersion, 1) >=
      CAMPAIGN_ADJUSTMENT_NAMESPACE_VERSION ||
    !isStockAdjustmentIdentityCollision(result)
  ) {
    return false;
  }
  demand.adjustmentNamespaceVersion = CAMPAIGN_ADJUSTMENT_NAMESPACE_VERSION;
  demand.adjustmentNamespaceMigratedAtMs = nowMs;
  runtimeState.metrics.campaignAdjustmentNamespaceMigrations =
    toPositiveInt(
      runtimeState.metrics.campaignAdjustmentNamespaceMigrations,
      0,
    ) + 1;
  return true;
}

function quarantineCampaignAdjustmentConflict(demand, result, nowMs) {
  if (!demand || !isStockAdjustmentIdentityCollision(result)) return false;
  demand.status = "adjustment_conflict";
  demand.adjustmentConflictAtMs = nowMs;
  demand.lastError = getStockAdjustmentErrorMessage(result) ||
    "campaign-adjustment-identity-conflict";
  runtimeState.metrics.campaignAdjustmentConflictsQuarantined =
    toPositiveInt(
      runtimeState.metrics.campaignAdjustmentConflictsQuarantined,
      0,
    ) + 1;
  return true;
}

async function buildReplacementDirectRemainingByKey(workBudget = null) {
  // Unstaged remainders of pending replacement packages, keyed by the
  // demand's home station and type. The staging budget (24 lines/pulse)
  // means delivered replacement goods can sit unconsumed for many pulses;
  // campaign consumption at the same station must not raid them.
  const remainingByKey = new Map();
  let scanned = 0;
  for (const demand of Object.values(runtimeState.replacementDemands || {})) {
    scanned += 1;
    if (workBudget && scanned % 128 === 0) await workBudget.checkpoint();
    if (String(demand && demand.status || "") !== "pending") continue;
    const stationID = toPositiveInt(demand.stationID, 0);
    if (!stationID) continue;
    const fulfilledQuantities =
      demand.fulfilledQuantities && typeof demand.fulfilledQuantities === "object"
        ? demand.fulfilledQuantities
        : {};
    for (const item of Array.isArray(demand.requirements) ? demand.requirements : []) {
      const remaining = Math.max(
        0,
        toPositiveInt(item.quantity, 0) -
          toPositiveInt(fulfilledQuantities[item.typeID], 0),
      );
      if (remaining <= 0) continue;
      const key = `${stationID}:${toPositiveInt(item.typeID, 0)}`;
      remainingByKey.set(
        key,
        toPositiveInt(remainingByKey.get(key), 0) + remaining,
      );
    }
  }
  return remainingByKey;
}

async function processCampaignDemands(stockMap, nowMs, workBudget = null) {
  let adjustments = 0;
  const replacementRemainingByKey =
    await buildReplacementDirectRemainingByKey(workBudget);
  const pending = await collectPendingSorted(
    runtimeState.campaignDemands || {},
    (entry) => String(entry && entry.status || "") === "pending",
    (entry) => entry && entry.createdAtMs,
    workBudget,
  );
  for (const demand of pending) {
    if (workBudget) await workBudget.checkpoint();
    // A persisted collision is authoritative evidence that this legacy demand
    // ID belongs to an older market receipt namespace. Promote before retrying
    // so restarts do not emit one more known failure on every first pulse.
    promoteLegacyCampaignAdjustmentNamespace(
      demand,
      { errorMsg: demand.lastError },
      nowMs,
    );
    const station = catalog.getStation(demand.stationID);
    if (!station) {
      demand.lastError = "CAMPAIGN_SUPPLY_STATION_NOT_FOUND";
      continue;
    }
    demand.fulfilledQuantities = demand.fulfilledQuantities &&
      typeof demand.fulfilledQuantities === "object"
      ? demand.fulfilledQuantities
      : {};
    for (const item of Array.isArray(demand.requirements) ? demand.requirements : []) {
      if (adjustments >= 24) break;
      const fulfilled = toPositiveInt(demand.fulfilledQuantities[item.typeID], 0);
      const remaining = Math.max(0, toPositiveInt(item.quantity, 0) - fulfilled);
      if (remaining <= 0) continue;
      const row = getStockRow(stockMap, station.stationID, item.typeID);
      const protectedForReplacement = toPositiveInt(
        replacementRemainingByKey.get(
          `${toPositiveInt(station.stationID, 0)}:${toPositiveInt(item.typeID, 0)}`,
        ),
        0,
      );
      const consumable = Math.max(
        0,
        toPositiveInt(row.quantity, 0) - protectedForReplacement,
      );
      // The v2 campaign token embeds {fulfilled} and quarantines on content
      // mismatch, so any delta this line submits must be reproducible on a
      // crash-replay. Protection levels move pulse to pulse; consuming a
      // protection-shaped partial amount would poison the token. Under
      // protection this line therefore consumes exactly `remaining` (the one
      // value derivable from the token itself) or waits.
      const consumed = protectedForReplacement > 0
        ? (consumable >= remaining ? remaining : 0)
        : Math.min(remaining, consumable);
      if (consumed <= 0) continue;
      const good = catalog.getGood(item.typeID);
      if (!good) continue;
      const result = await adjustStock({
        adjustmentID: makeCampaignAdjustmentID(
          demand,
          station,
          item,
          fulfilled,
        ),
        station,
        good,
        deltaQuantity: -consumed,
        reason: `living campaign supply ${demand.campaignID}`,
        stockMap,
        workBudget,
      });
      if (!result.success) {
        const promoted = promoteLegacyCampaignAdjustmentNamespace(
          demand,
          result,
          nowMs,
        );
        if (!promoted) {
          quarantineCampaignAdjustmentConflict(demand, result, nowMs);
        }
        demand.lastError = getStockAdjustmentErrorMessage(result) ||
          "CAMPAIGN_STOCK_ADJUSTMENT_FAILED";
        if (String(demand.status || "") === "adjustment_conflict") break;
        continue;
      }
      demand.fulfilledQuantities[item.typeID] = fulfilled + consumed;
      runtimeState.metrics.campaignUnitsConsumed += consumed;
      adjustments += 1;
      demand.lastError = null;
    }
    const complete = (demand.requirements || []).every((item) => (
      toPositiveInt(demand.fulfilledQuantities[item.typeID], 0) >= toPositiveInt(item.quantity, 0)
    ));
    if (complete) {
      demand.status = "fulfilled";
      demand.fulfilledAtMs = nowMs;
      runtimeState.metrics.campaignDemandsFulfilled += 1;
      addEvent("campaign_supply_demand_fulfilled", null, {
        demandID: demand.demandID,
        campaignID: demand.campaignID,
        encounterID: demand.encounterID,
        stationID: demand.stationID,
        requestedUnits: demand.requestedUnits,
      }, nowMs);
    }
  }
}

function areReplacementDemandsFulfilled(demandIDs) {
  initialize();
  const ids = Array.isArray(demandIDs) ? demandIDs.filter(Boolean) : [];
  return ids.length <= 0 || ids.every((demandID) => {
    const demand = runtimeState.replacementDemands[String(demandID)];
    return !demand || ["fulfilled", "cancelled"].includes(String(demand.status || ""));
  });
}

function shouldHoldReplacementFlight(flight) {
  return config.livingEconomyEnabled === true &&
    Array.isArray(flight && flight.replacementDemandIDs) &&
    flight.replacementDemandIDs.length > 0 &&
    !areReplacementDemandsFulfilled(flight.replacementDemandIDs);
}

function recordTraderPurchase(job, nowMs = Date.now()) {
  if (!job || job.purchaseAccountingAtMs) {
    return false;
  }
  const value = Math.max(0, toFiniteNumber(job.purchaseValue, 0));
  job.purchaseAccountingAtMs = nowMs;
  runtimeState.metrics.traderSpend = roundMoney(
    toFiniteNumber(runtimeState.metrics.traderSpend, 0) + value,
  );
  return true;
}

function recordTraderSale(job, nowMs = Date.now()) {
  if (!job || job.saleAccountingAtMs) {
    return false;
  }
  const revenue = Math.max(0, toFiniteNumber(job.saleValue, 0));
  const margin = toFiniteNumber(job.grossMargin, 0);
  job.saleAccountingAtMs = nowMs;
  runtimeState.metrics.traderRevenue = roundMoney(
    toFiniteNumber(runtimeState.metrics.traderRevenue, 0) + revenue,
  );
  runtimeState.metrics.traderGrossMargin = roundMoney(
    toFiniteNumber(runtimeState.metrics.traderGrossMargin, 0) + margin,
  );
  runtimeState.metrics.traderJobsValued =
    toPositiveInt(runtimeState.metrics.traderJobsValued, 0) + 1;
  return true;
}

function recordTraderCargoLoss(job, nowMs = Date.now()) {
  if (!job || job.lossAccountingAtMs) {
    return false;
  }
  job.lossAccountingAtMs = nowMs;
  runtimeState.metrics.traderCargoLossValue = roundMoney(
    toFiniteNumber(runtimeState.metrics.traderCargoLossValue, 0) +
    Math.max(0, toFiniteNumber(job.purchaseValue, 0)),
  );
  return true;
}

function recordMinerDepositValue(deposit, nowMs = Date.now()) {
  if (!deposit || deposit.accountingRecordedAtMs) {
    return false;
  }
  deposit.accountingRecordedAtMs = nowMs;
  runtimeState.metrics.minerGrossMarketValue = roundMoney(
    toFiniteNumber(runtimeState.metrics.minerGrossMarketValue, 0) +
    Math.max(0, toFiniteNumber(deposit.grossMarketValue, 0)),
  );
  return true;
}

function getFlightJob(flight) {
  initialize();
  const jobID = String(flight && flight.freightJobID || "").trim();
  return jobID ? runtimeState.jobs[jobID] || null : null;
}

function isActiveJob(job) {
  return Boolean(job && ACTIVE_JOB_STATES.has(String(job.status || "")));
}

function isUnresolvedEstateJob(job) {
  return Boolean(
    job &&
    job.estateDelivery &&
    (isActiveJob(job) || !job.estateCloseConfirmedAtMs)
  );
}

function hasFreightWork(flight) {
  const job = getFlightJob(flight);
  return Boolean(job && job.status === "in_transit");
}

function hasReplacementPriorityFreightWork(flight) {
  const jobID = String(flight && flight.freightJobID || "").trim();
  const job = getFlightJob(flight);
  if (jobID) {
    return Boolean(
      job &&
      job.status === "in_transit" &&
      String(job.assignedFlightID || "") === String(flight && flight.flightID || "") &&
      isReplacementPriority(job)
    );
  }
  const reposition = getFreightReposition(flight);
  return Boolean(
    reposition &&
    reposition.replacementPriority === true &&
    getReplacementPriorityUnits(reposition) > 0
  );
}

function shouldHoldFreightFlight(flight) {
  if (config.livingEconomyEnabled !== true) {
    return false;
  }
  const family = String(flight && flight.family || "");
  if (family !== "hauler" && family !== "convoy") {
    return false;
  }
  if (flight && flight.estateReturnPending === true) {
    return false;
  }
  const reposition = getFreightReposition(flight);
  if (reposition) {
    const dockedStationID = getDockedStationID(flight);
    if (
      dockedStationID &&
      Number(dockedStationID) === Number(reposition.targetStationID)
    ) {
      settleFreightRepositionAtStation(flight, dockedStationID, Date.now());
      return true;
    }
    return false;
  }
  return !hasFreightWork(flight);
}

function shouldHoldMiningFlight(flight) {
  if (config.livingEconomyEnabled !== true || String(flight && flight.family || "") !== "miner") {
    return false;
  }
  const manifest = flight && flight.miningManifest;
  if (!manifest || !manifest.depositID) {
    return false;
  }
  const deposit = runtimeState && runtimeState.miningDeposits
    ? runtimeState.miningDeposits[String(manifest.depositID)]
    : null;
  return Boolean(deposit && deposit.status === "pending");
}

function getFlightCargo(flight) {
  const job = getFlightJob(flight);
  if (!job || job.status !== "in_transit") {
    return [];
  }
  return [{
    typeID: toPositiveInt(job.typeID, 0),
    quantity: toPositiveInt(job.quantity, 0),
    singleton: false,
    cargoPurpose: "living_economy_manifest",
    freightJobID: job.jobID,
  }].filter((entry) => entry.typeID > 0 && entry.quantity > 0);
}

function normalizeOreManifest(entries) {
  const byTypeID = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const typeID = toPositiveInt(entry && entry.typeID, 0);
    const quantity = toPositiveInt(entry && entry.quantity, 0);
    if (typeID <= 0 || quantity <= 0) {
      continue;
    }
    const current = byTypeID.get(typeID) || {
      typeID,
      typeName: String(entry && entry.typeName || `type ${typeID}`),
      quantity: 0,
      volume: Math.max(0, toFiniteNumber(entry && entry.volume, 0)),
    };
    current.quantity += quantity;
    if (current.volume <= 0) {
      current.volume = Math.max(0, toFiniteNumber(entry && entry.volume, 0));
    }
    byTypeID.set(typeID, current);
  }
  return [...byTypeID.values()].sort((left, right) => left.typeID - right.typeID);
}

function notifyMiningArrival(flight, stationID, nowMs = Date.now()) {
  if (
    config.livingEconomyEnabled !== true ||
    String(flight && flight.family || "") !== "miner"
  ) {
    return false;
  }
  initialize(nowMs);
  const manifest = flight && flight.miningManifest;
  const ore = normalizeOreManifest(manifest && manifest.ore);
  if (!manifest || !manifest.cycleID || !manifest.completedAtMs || ore.length <= 0) {
    return false;
  }

  const economyStation = catalog.getStationForSystem(flight.currentSystemID) ||
    catalog.getStation(stationID);
  if (!economyStation) {
    return false;
  }
  const depositID = `LEM-${String(manifest.cycleID)}`;
  if (!runtimeState.miningDeposits[depositID]) {
    const oreUnits = ore.reduce((sum, entry) => sum + entry.quantity, 0);
    const oreVolumeM3 = ore.reduce(
      (sum, entry) => sum + (entry.quantity * Math.max(0, entry.volume)),
      0,
    );
    runtimeState.miningDeposits[depositID] = {
      depositID,
      status: "pending",
      assignedFlightID: flight.flightID,
      cycleID: manifest.cycleID,
      source: String(manifest.source || "unknown"),
      sourceSystemID: toPositiveInt(manifest.systemID, flight.currentSystemID),
      sourceBeltID: toPositiveInt(manifest.beltID, 0),
      arrivalStationID: toPositiveInt(stationID, 0),
      destinationStationID: economyStation.stationID,
      ore,
      oreUnits,
      oreVolumeM3,
      creditedTypeIDs: [],
      // Frozen at delivery: the refine adjustment tokens carry no quantity,
      // so the efficiency a deposit settles at must never change after its
      // first receipt or retries collide at the market daemon.
      refineryEfficiency: getNpcRefineryEfficiency(),
      createdAtMs: nowMs,
      lastUpdatedAtMs: nowMs,
    };
    runtimeState.metrics.miningRuns += 1;
    runtimeState.metrics.oreUnitsMined += oreUnits;
    runtimeState.metrics.oreVolumeMinedM3 += oreVolumeM3;
    addEvent("mining_arrival", null, {
      depositID,
      flightID: flight.flightID,
      stationID: economyStation.stationID,
      oreUnits,
      oreVolumeM3,
    }, nowMs);
  }
  manifest.depositID = depositID;
  manifest.depositStatus = runtimeState.miningDeposits[depositID].status;
  markLivingStateDirty(flight);
  persistState(nowMs);
  return true;
}

function getFlights(livingState) {
  return Object.values(livingState && livingState.flights || {});
}

function getFlightByID(livingState, flightID) {
  return livingState && livingState.flights
    ? livingState.flights[String(flightID || "")] || null
    : null;
}

function getEndpointIndex(routeSpec, stationID) {
  return routeSpec && Array.isArray(routeSpec.endpointStationIDs)
    ? routeSpec.endpointStationIDs.findIndex((value) => Number(value) === Number(stationID))
    : -1;
}

function getDockedStationID(flight) {
  const routeSpec = flight && flight.dynamicRouteSpec || catalog.getRoute(flight && flight.routeID);
  if (!routeSpec || !Array.isArray(routeSpec.endpointStationIDs)) {
    return 0;
  }
  const nodeIndex = toFiniteNumber(flight.currentNodeIndex, -1);
  if (nodeIndex === 0) {
    return routeSpec.endpointStationIDs[0];
  }
  // Every catalogued freight route is endpoint-to-endpoint even when the
  // physical path has intermediate systems.
  if (flight.direction < 0 || nodeIndex > 0) {
    const candidate = routeSpec.endpointStationIDs[1];
    const station = catalog.getStation(candidate);
    if (station && Number(station.systemID) === Number(flight.currentSystemID)) {
      return candidate;
    }
  }
  return 0;
}

function getFreightReposition(flight) {
  const marker = flight && flight.freightReposition;
  return (
    marker &&
    typeof marker === "object" &&
    String(marker.status || "") === "enroute"
  )
    ? marker
    : null;
}

function closeFreightReposition(
  flight,
  status,
  reason,
  nowMs = Date.now(),
) {
  const marker = getFreightReposition(flight);
  if (!marker) {
    if (flight && flight.freightReposition) delete flight.freightReposition;
    return false;
  }
  initialize(nowMs);
  const completed = status === "completed";
  const metricName = completed
    ? "freightRepositionsCompleted"
    : "freightRepositionsAbandoned";
  runtimeState.metrics[metricName] =
    toPositiveInt(runtimeState.metrics[metricName], 0) + 1;
  if (marker.replacementPriority === true && completed) {
    runtimeState.metrics.replacementFreightRepositionsCompleted =
      toPositiveInt(
        runtimeState.metrics.replacementFreightRepositionsCompleted,
        0,
      ) + 1;
  } else if (marker.replacementPriority === true) {
    runtimeState.metrics.replacementFreightRepositionsAbandoned =
      toPositiveInt(
        runtimeState.metrics.replacementFreightRepositionsAbandoned,
        0,
      ) + 1;
  }
  flight.lastFreightReposition = {
    ...marker,
    status: completed ? "completed" : "abandoned",
    reason: String(reason || (completed ? "arrived" : "closed")),
    closedAtMs: nowMs,
  };
  delete flight.freightReposition;
  flight.freightRepositionCooldownUntilMs =
    nowMs + getFreightRepositionCooldownMs();
  markLivingStateDirty(flight);
  return true;
}

function settleFreightRepositionAtStation(
  flight,
  stationID,
  nowMs = Date.now(),
) {
  const marker = getFreightReposition(flight);
  if (
    !marker ||
    Number(marker.targetStationID) !== Number(stationID)
  ) {
    return false;
  }
  return closeFreightReposition(
    flight,
    "completed",
    "arrived-at-freight-source",
    nowMs,
  );
}

function getActiveFreightRepositions(livingState) {
  return getFlights(livingState)
    .map((flight) => ({ flight, marker: getFreightReposition(flight) }))
    .filter((entry) => entry.marker);
}

function startFreightReposition(flight, candidate, nowMs = Date.now()) {
  if (
    !flight ||
    !candidate ||
    !candidate.repositionRouteSpec ||
    typeof lastAssignFreightRoute !== "function"
  ) {
    return false;
  }
  if (
    !lastAssignFreightRoute(
      flight,
      candidate.repositionRouteSpec,
      nowMs,
    )
  ) {
    return false;
  }
  const fromStationID = getDockedStationID(flight) ||
    Number(candidate.repositionRouteSpec.endpointStationIDs[0]) ||
    0;
  flight.freightReposition = {
    status: "enroute",
    fromStationID,
    targetStationID: Number(candidate.sourceStation.stationID),
    hintedTypeID: Number(candidate.good.typeID),
    hintedDestinationStationID: Number(
      candidate.destinationStation.stationID,
    ),
    routeID: String(candidate.repositionRouteSpec.routeID),
    jumps: toPositiveInt(candidate.repositionJumps, 0),
    replacementPriority: isReplacementPriority(candidate),
    priorityDemandKinds: Array.isArray(candidate.priorityDemandKinds)
      ? [...candidate.priorityDemandKinds]
      : [],
    priorityDemandClasses: getPriorityDemandClasses(candidate),
    priorityDemandUnitsByClass:
      candidate.priorityDemandUnitsByClass &&
      typeof candidate.priorityDemandUnitsByClass === "object"
        ? { ...candidate.priorityDemandUnitsByClass }
        : {},
    replacementPriorityUnits: getReplacementPriorityUnits(candidate),
    assignedAtMs: nowMs,
  };
  runtimeState.metrics.freightRepositionsAssigned =
    toPositiveInt(runtimeState.metrics.freightRepositionsAssigned, 0) + 1;
  runtimeState.metrics.freightRepositionJumps =
    toPositiveInt(runtimeState.metrics.freightRepositionJumps, 0) +
    toPositiveInt(candidate.repositionJumps, 0);
  if (flight.freightReposition.replacementPriority) {
    runtimeState.metrics.replacementFreightRepositionsAssigned =
      toPositiveInt(
        runtimeState.metrics.replacementFreightRepositionsAssigned,
        0,
      ) + 1;
  }
  markLivingStateDirty(flight);
  return true;
}

function reconcileAssignments(livingState, nowMs = Date.now()) {
  initialize(nowMs);
  let changed = false;
  const changedFlights = new Set();
  const flightsByID = new Map(
    getFlights(livingState).map((flight) => [String(flight.flightID), flight]),
  );

  for (const demand of Object.values(runtimeState.replacementDemands || {})) {
    if (String(demand && demand.status || "") !== "pending") continue;
    const flightID = String(demand && demand.flightID || "");
    const flight = flightsByID.get(flightID);
    if (!flight) continue;
    const actorID = String(demand && demand.actorID || "");
    const actor = livingState && livingState.actors && livingState.actors[actorID];
    if (
      actorID &&
      (!actor || String(actor.flightID || "") !== flightID)
    ) {
      continue;
    }
    const currentDemandIDs = new Set(
      (Array.isArray(flight.replacementDemandIDs)
        ? flight.replacementDemandIDs
        : [])
        .map(String)
        .filter(Boolean),
    );
    if (currentDemandIDs.has(String(demand.demandID))) continue;
    currentDemandIDs.add(String(demand.demandID));
    flight.replacementDemandIDs = [...currentDemandIDs];
    runtimeState.metrics.replacementDemandLinksReconciled =
      toPositiveInt(
        runtimeState.metrics.replacementDemandLinksReconciled,
        0,
      ) + 1;
    changed = true;
    changedFlights.add(flight);
  }

  for (const flight of flightsByID.values()) {
    const jobID = String(flight.freightJobID || "").trim();
    const reposition = getFreightReposition(flight);
    if (flight.freightReposition && !reposition) {
      delete flight.freightReposition;
      changed = true;
      changedFlights.add(flight);
    } else if (reposition && jobID) {
      if (closeFreightReposition(
        flight,
        "abandoned",
        "superseded-by-freight-job",
        nowMs,
      )) {
        changed = true;
        changedFlights.add(flight);
      }
    } else if (reposition) {
      const dockedStationID = String(flight.phase || "") === "docked"
        ? getDockedStationID(flight)
        : 0;
      if (
        dockedStationID &&
        Number(dockedStationID) === Number(reposition.targetStationID)
      ) {
        if (settleFreightRepositionAtStation(flight, dockedStationID, nowMs)) {
          changed = true;
          changedFlights.add(flight);
        }
      } else {
        const routeSpec = flight.dynamicRouteSpec;
        const routeTargetIsValid = Boolean(
          routeSpec &&
          String(routeSpec.routeID || "") === String(reposition.routeID || "") &&
          Array.isArray(routeSpec.endpointStationIDs) &&
          routeSpec.endpointStationIDs.some(
            (stationID) =>
              Number(stationID) === Number(reposition.targetStationID),
          ),
        );
        if (!routeTargetIsValid) {
          if (closeFreightReposition(
            flight,
            "abandoned",
            "reposition-route-invalid",
            nowMs,
          )) {
            changed = true;
            changedFlights.add(flight);
          }
        }
      }
    }
    if (!jobID) {
      continue;
    }
    const job = runtimeState.jobs[jobID];
    if (!isActiveJob(job) || String(job.assignedFlightID || "") !== String(flight.flightID)) {
      flight.freightJobID = null;
      changed = true;
      changedFlights.add(flight);
    }
  }

  for (const job of Object.values(runtimeState.jobs)) {
    if (!isActiveJob(job)) {
      continue;
    }
    const flight = flightsByID.get(String(job.assignedFlightID || ""));
    if (!flight) {
      if (String(job.status || "") === "reserving") {
        continue;
      }
      job.status = "lost";
      job.failureReason = "assigned-flight-missing";
      job.completedAtMs = nowMs;
      runtimeState.metrics.jobsLost += 1;
      runtimeState.metrics.unitsLost += toPositiveInt(job.quantity, 0);
      recordCargoLoss(job, nowMs);
      recordTraderCargoLoss(job, nowMs);
      closeEstateDeliveryForJob(job, "lost", job.failureReason, nowMs);
      addEvent("job_lost", job, { reason: job.failureReason }, nowMs);
      changed = true;
      continue;
    }
    if (
      job.estateDelivery &&
      job.routeSpec &&
      (
        String(flight.routeID || "") !== String(job.routeSpec.routeID || "") ||
        !flight.dynamicRouteSpec
      )
    ) {
      const routeRestored = typeof lastAssignFreightRoute === "function" &&
        lastAssignFreightRoute(flight, job.routeSpec, nowMs, {
          preserveProgress: true,
        });
      if (!routeRestored) {
        job.routeRecoveryError = "ESTATE_ROUTE_RECOVERY_DEFERRED";
        continue;
      }
      job.routeRecoveryError = null;
      changed = true;
      changedFlights.add(flight);
    }
    if (String(flight.freightJobID || "") !== job.jobID) {
      flight.freightJobID = job.jobID;
      changed = true;
      changedFlights.add(flight);
    }
  }

  if (changed) {
    if (changedFlights.size > 0) markLivingStateDirty(changedFlights);
    persistState(nowMs);
  }
  return changed;
}

function getFreightProgressFingerprint(flight) {
  if (!flight) return "missing";
  return [
    String(flight.routeID || ""),
    toPositiveInt(flight.currentSystemID, 0),
    Math.trunc(toFiniteNumber(flight.currentNodeIndex, -1)),
    String(flight.phase || ""),
    Math.trunc(toFiniteNumber(flight.direction, 0)),
    String(flight.phase || "") === "docked" ? getDockedStationID(flight) : 0,
  ].join("|");
}

function inspectFreightJobProgress(job, flight, nowMs = Date.now()) {
  const fingerprint = getFreightProgressFingerprint(flight);
  const progressed =
    String(job && job.lastFreightProgressFingerprint || "") !== fingerprint;
  const lastProgressAtMs = progressed
    ? nowMs
    : toFiniteNumber(
        job && job.lastFreightProgressAtMs,
        toFiniteNumber(job && (job.reservedAtMs || job.createdAtMs), nowMs),
      );
  const routeSpec = job && job.routeSpec;
  const expectedRouteID = String(
    routeSpec && routeSpec.routeID || job && job.routeID || "",
  );
  const routeMismatch = Boolean(
    expectedRouteID &&
    (
      String(flight && flight.routeID || "") !== expectedRouteID ||
      (routeSpec && !flight.dynamicRouteSpec)
    ),
  );
  const staleThresholdMs = Math.max(
    30 * 60_000,
    (
      Math.max(0, toFiniteNumber(job && job.estimatedTravelMinutes, 0)) *
        2 *
        60_000
    ) + (10 * 60_000),
  );
  const noProgressAgeMs = Math.max(0, nowMs - lastProgressAtMs);
  const transitionOverdueMs = Math.max(
    0,
    nowMs - toFiniteNumber(flight && flight.nextTransitionAtMs, nowMs),
  );
  return {
    fingerprint,
    progressed,
    lastProgressAtMs,
    expectedRouteID,
    routeMismatch,
    noProgressAgeMs,
    staleThresholdMs,
    transitionOverdueMs,
    staleNoProgress:
      !routeMismatch &&
      noProgressAgeMs >= staleThresholdMs &&
      transitionOverdueMs >= 60_000,
  };
}

function markFreightRecoveryIssue(job, signature, nowMs) {
  if (String(job.freightRecoveryIssueSignature || "") === signature) {
    return false;
  }
  job.freightRecoveryIssueSignature = signature;
  job.freightRecoveryIssueDetectedAtMs = nowMs;
  runtimeState.metrics.staleFreightJobsDetected =
    toPositiveInt(runtimeState.metrics.staleFreightJobsDetected, 0) + 1;
  return true;
}

function deferFreightRecovery(job, signature, reason, nowMs) {
  const deferralSignature = `${signature}:${reason}`;
  if (
    String(job.freightRecoveryDeferralSignature || "") !== deferralSignature
  ) {
    runtimeState.metrics.freightRecoveryDeferred =
      toPositiveInt(runtimeState.metrics.freightRecoveryDeferred, 0) + 1;
    job.freightRecoveryDeferralSignature = deferralSignature;
  }
  job.routeRecoveryError = reason;
  job.routeRecoveryDeferredAtMs = nowMs;
}

function finishFreightRouteRecovery(job, flight, nowMs, details = {}) {
  job.lastFreightRecoveryIssueSignature =
    job.freightRecoveryIssueSignature || null;
  job.freightRecoveryIssueSignature = null;
  job.routeRecoveryError = null;
  job.routeRecoveryDeferredAtMs = 0;
  job.freightRecoveryDeferralSignature = null;
  job.freightRecoveryResolvedAtMs = nowMs;
  job.lastFreightProgressAtMs = nowMs;
  job.lastFreightProgressFingerprint = getFreightProgressFingerprint(flight);
  job.routeRecoveryAttempts =
    toPositiveInt(job.routeRecoveryAttempts, 0) + 1;
  addEvent("freight_route_recovered", job, details, nowMs);
  markLivingStateDirty(flight);
}

async function recoverStaleFreightJobs(
  livingState,
  stockMap,
  nowMs = Date.now(),
  workBudget = null,
) {
  let handled = 0;
  const jobs = Object.values(runtimeState.jobs || {})
    .filter((job) => String(job && job.status || "") === "in_transit")
    .sort((left, right) => (
      toFiniteNumber(
        left.lastFreightProgressAtMs,
        toFiniteNumber(left.reservedAtMs || left.createdAtMs, 0),
      ) -
      toFiniteNumber(
        right.lastFreightProgressAtMs,
        toFiniteNumber(right.reservedAtMs || right.createdAtMs, 0),
      )
    ));
  for (const job of jobs) {
    if (handled >= FREIGHT_RECOVERY_MAX_JOBS_PER_PULSE) break;
    if (workBudget && typeof workBudget.checkpoint === "function") {
      await workBudget.checkpoint();
    }
    const flight = getFlightByID(livingState, job.assignedFlightID);
    if (!flight) continue;
    const progress = inspectFreightJobProgress(job, flight, nowMs);
    if (progress.progressed) {
      job.lastFreightProgressFingerprint = progress.fingerprint;
      job.lastFreightProgressAtMs = nowMs;
    }
    if (!progress.routeMismatch && !progress.staleNoProgress) continue;
    handled += 1;
    const issueSignature = progress.routeMismatch
      ? `route:${progress.expectedRouteID}:${String(flight.routeID || "")}`
      : `progress:${progress.fingerprint}`;
    markFreightRecoveryIssue(job, issueSignature, nowMs);
    if (progress.routeMismatch) {
      runtimeState.metrics.freightRouteMismatchesDetected =
        String(job.lastRouteMismatchMetricSignature || "") === issueSignature
          ? toPositiveInt(
              runtimeState.metrics.freightRouteMismatchesDetected,
              0,
            )
          : toPositiveInt(
              runtimeState.metrics.freightRouteMismatchesDetected,
              0,
            ) + 1;
      job.lastRouteMismatchMetricSignature = issueSignature;
    }

    const logisticsProfile = getFlightLogisticsProfile(flight);
    const savedRoute = job.routeSpec;
    const currentSystemOnSavedRoute = Boolean(
      savedRoute &&
      Array.isArray(savedRoute.systemIDs) &&
      savedRoute.systemIDs.some(
        (systemID) =>
          Number(systemID) === Number(flight.currentSystemID),
      ),
    );
    if (
      savedRoute &&
      currentSystemOnSavedRoute &&
      routePlanner.routeSupportsProfile(savedRoute, logisticsProfile) &&
      typeof lastAssignFreightRoute === "function" &&
      lastAssignFreightRoute(flight, savedRoute, nowMs, {
        preserveProgress: true,
      })
    ) {
      if (progress.routeMismatch) {
        runtimeState.metrics.freightRoutesRecovered =
          toPositiveInt(runtimeState.metrics.freightRoutesRecovered, 0) + 1;
      } else {
        runtimeState.metrics.freightProgressWakeups =
          toPositiveInt(runtimeState.metrics.freightProgressWakeups, 0) + 1;
      }
      finishFreightRouteRecovery(job, flight, nowMs, {
        mode: progress.routeMismatch
          ? "preserve-progress"
          : "scheduler-wakeup",
        routeID: savedRoute.routeID,
      });
      continue;
    }

    if (String(flight.phase || "") !== "docked") {
      deferFreightRecovery(
        job,
        issueSignature,
        "FREIGHT_ROUTE_RECOVERY_WAITING_FOR_DOCK",
        nowMs,
      );
      continue;
    }

    const currentStationID = getDockedStationID(flight);
    const currentStation = catalog.getStation(currentStationID);
    const destinationStation = catalog.getStation(job.destinationStationID);
    if (!currentStation || !destinationStation) {
      deferFreightRecovery(
        job,
        issueSignature,
        "FREIGHT_ROUTE_RECOVERY_STATION_UNRESOLVED",
        nowMs,
      );
      continue;
    }
    if (Number(currentStationID) === Number(job.destinationStationID)) {
      job.status = "delivery_pending";
      job.arrivedAtMs = nowMs;
      job.lastUpdatedAtMs = nowMs;
      finishFreightRouteRecovery(job, flight, nowMs, {
        mode: "arrival-reconciled",
        stationID: currentStationID,
      });
      continue;
    }

    const replannedRoute = routePlanner.buildRouteSpec(
      currentStation,
      destinationStation,
    );
    if (
      replannedRoute &&
      routePlanner.routeSupportsProfile(replannedRoute, logisticsProfile) &&
      typeof lastAssignFreightRoute === "function" &&
      lastAssignFreightRoute(flight, replannedRoute, nowMs)
    ) {
      if (!job.originalRouteID) {
        job.originalRouteID = String(
          job.routeSpec && job.routeSpec.routeID || job.routeID || "",
        );
      }
      job.routeSpec = JSON.parse(JSON.stringify(replannedRoute));
      job.routeID = replannedRoute.routeID;
      job.dynamicRoute = true;
      job.jumps = Math.max(0, replannedRoute.systemIDs.length - 1);
      job.estimatedTravelMinutes =
        routePlanner.getEstimatedTravelMinutes(job.jumps);
      job.routeClass = replannedRoute.routeClass;
      job.riskBand = replannedRoute.riskBand;
      job.routeReplannedFromStationID = currentStationID;
      runtimeState.metrics.freightRoutesReplanned =
        toPositiveInt(runtimeState.metrics.freightRoutesReplanned, 0) + 1;
      finishFreightRouteRecovery(job, flight, nowMs, {
        mode: "replanned-from-current-dock",
        stationID: currentStationID,
        routeID: replannedRoute.routeID,
      });
      continue;
    }

    if (
      !replannedRoute ||
      !routePlanner.routeSupportsProfile(replannedRoute, logisticsProfile)
    ) {
      const good = catalog.getGood(job.typeID);
      if (!good) {
        deferFreightRecovery(
          job,
          issueSignature,
          "FREIGHT_ROUTE_RECOVERY_GOOD_UNRESOLVED",
          nowMs,
        );
        continue;
      }
      const unload = await adjustStock({
        adjustmentID:
          `${job.jobID}:stale-recovery-unload:${currentStationID}`,
        station: currentStation,
        good,
        deltaQuantity: toPositiveInt(job.quantity, 0),
        reason:
          `living freight recovery unload ${job.jobID} for compatible replan`,
        stockMap,
        workBudget,
      });
      if (!unload.success) {
        runtimeState.metrics.freightRecoveryFailures =
          toPositiveInt(runtimeState.metrics.freightRecoveryFailures, 0) + 1;
        job.routeRecoveryError =
          "FREIGHT_ROUTE_RECOVERY_UNLOAD_FAILED";
        continue;
      }
      job.staleRecoveryUnloadedAtStationID = currentStationID;
      job.staleRecoveryUnloadedAtMs = nowMs;
      completeJob(job, flight, "cancelled", nowMs, {
        reason: "cargo-unloaded-for-compatible-hauler-replan",
        stationID: currentStationID,
      });
      runtimeState.metrics.jobsCancelled =
        toPositiveInt(runtimeState.metrics.jobsCancelled, 0) + 1;
      runtimeState.metrics.freightRecoveryUnloads =
        toPositiveInt(runtimeState.metrics.freightRecoveryUnloads, 0) + 1;
      runtimeState.metrics.freightRecoveryUnitsUnloaded =
        toPositiveInt(
          runtimeState.metrics.freightRecoveryUnitsUnloaded,
          0,
        ) + toPositiveInt(job.quantity, 0);
      notifyExternalFreightDemandMutation();
      markLivingStateDirty(flight);
      continue;
    }

    deferFreightRecovery(
      job,
      issueSignature,
      "FREIGHT_ROUTE_RECOVERY_PATH_UNAVAILABLE",
      nowMs,
    );
  }
  return handled;
}

function notifyStationArrival(flight, stationID, nowMs = Date.now()) {
  if (config.livingEconomyEnabled !== true) {
    return false;
  }
  if (settleFreightRepositionAtStation(flight, stationID, nowMs)) {
    persistState(nowMs);
    return true;
  }
  const job = getFlightJob(flight);
  if (!job || job.status !== "in_transit") {
    return false;
  }
  if (Number(job.destinationStationID) !== Number(stationID)) {
    return false;
  }
  job.status = "delivery_pending";
  job.arrivedAtMs = nowMs;
  job.lastUpdatedAtMs = nowMs;
  addEvent("arrival", job, { stationID: Number(stationID) }, nowMs);
  persistState(nowMs);
  return true;
}

function notifyFlightLoss(flight, missingActorIDs = [], nowMs = Date.now()) {
  if (config.livingEconomyEnabled !== true) {
    return false;
  }
  const job = getFlightJob(flight);
  if (!isActiveJob(job)) {
    if (closeFreightReposition(
      flight,
      "abandoned",
      "flight-loss-during-reposition",
      nowMs,
    )) {
      persistState(nowMs);
      return true;
    }
    return false;
  }
  // Once station arrival has been accepted, delivery settlement owns the
  // manifest. A late ship-loss notification must not turn arrived cargo into
  // a refund or strand an escrowed estate reservation.
  if (job.status === "delivery_pending") {
    job.lastUpdatedAtMs = nowMs;
    job.lossIgnoredAfterArrivalAtMs = nowMs;
    persistState(nowMs);
    return false;
  }
  job.status = "lost";
  job.completedAtMs = nowMs;
  job.lastUpdatedAtMs = nowMs;
  job.failureReason = "convoy-loss";
  job.missingActorIDs = [...missingActorIDs];
  runtimeState.metrics.jobsLost += 1;
  runtimeState.metrics.unitsLost += toPositiveInt(job.quantity, 0);
  recordCargoLoss(job, nowMs);
  recordTraderCargoLoss(job, nowMs);
  const estateClose = closeEstateDeliveryForJob(
    job,
    "lost",
    job.failureReason,
    nowMs,
  );
  flight.freightJobID = null;
  addEvent(
    "job_lost",
    job,
    { reason: job.failureReason, missingActorIDs: [...missingActorIDs] },
    nowMs,
  );
  markLivingStateDirty(flight);
  const persisted = persistState(nowMs, {
    durable: Boolean(job.estateDelivery && estateClose && estateClose.success),
  });
  if (!persisted && job.estateDelivery) {
    job.estateDeliveryError = "ESTATE_LOSS_JOB_PERSIST_FAILED";
  }
  return true;
}

function registerSalvageOpportunity(details = {}) {
  const nowMs = toFiniteNumber(details.nowMs, Date.now());
  if (config.livingEconomyEnabled !== true) return null;
  initialize(nowMs);
  const victims = Array.isArray(details.victims) ? details.victims.filter(Boolean) : [];
  if (victims.length <= 0) return null;
  const targetSystemID = toPositiveInt(details.systemID, 0);
  const preferredStation = catalog.getStation(
    toPositiveInt(details.destinationStationID, 0),
  ) || catalog.getStation(
    toPositiveInt(victims[0] && victims[0].homeStationID, 0),
  ) || catalog.getStationForSystem(targetSystemID) || catalog.REGIONAL_HUBS[0] || null;
  if (!preferredStation || !targetSystemID) return null;
  const jumpCount = Math.max(
    0,
    marketTopology.getJumpCount(preferredStation.systemID, targetSystemID),
  );
  const site = salvageRecovery.registerOpportunity(runtimeState, {
    ...details,
    victims,
    systemID: targetSystemID,
    destinationStationID: preferredStation.stationID,
    destinationSystemID: preferredStation.systemID,
    jumpCount: Number.isFinite(jumpCount) ? jumpCount : 0,
  }, nowMs);
  if (!site) return null;
  if (!site.registeredEventID) {
    site.registeredEventID = addEvent("salvage_site_created", null, {
      siteID: site.siteID,
      encounterID: site.encounterID,
      systemID: site.systemID,
      destinationStationID: site.destinationStationID,
      wrecks: site.wrecks.length,
      jumpCount: site.jumpCount,
      travelMs: site.travelMs,
      recoveryMs: site.recoveryMs,
    }, nowMs).eventID;
  }
  persistState(nowMs);
  return JSON.parse(JSON.stringify(site));
}

function stockKey(stationID, typeID) {
  return `${Number(stationID)}:${Number(typeID)}`;
}

function getStockRow(stockMap, stationID, typeID) {
  return stockMap.get(stockKey(stationID, typeID)) || {
    station_id: Number(stationID),
    type_id: Number(typeID),
    quantity: 0,
    price: 0,
    initial_quantity: 0,
  };
}

function updateStockMap(stockMap, response) {
  if (!response) {
    return;
  }
  const stationID = Number(response.station_id || response.stationID || 0);
  const typeID = Number(response.type_id || response.typeID || 0);
  if (!stationID || !typeID) {
    return;
  }
  const key = stockKey(stationID, typeID);
  stockMap.set(key, {
    ...getStockRow(stockMap, stationID, typeID),
    ...response,
    station_id: stationID,
    type_id: typeID,
    quantity: Math.max(0, toPositiveInt(response.quantity, 0)),
    price: roundPrice(response.price || getStockRow(stockMap, stationID, typeID).price || 0.01),
  });
}

function rpcStockKey(key) {
  return {
    station_id: Number(key && key.station_id) || 0,
    type_id: Number(key && key.type_id) || 0,
  };
}

async function readStockKeyBatch(keys, metricPrefix, workBudget) {
  const requested = Array.isArray(keys)
    ? keys.map(rpcStockKey).filter((key) => key.station_id > 0 && key.type_id > 0)
    : [];
  if (requested.length <= 0) return [];
  const call = () => marketDaemonClient.call("GetSeedStocks", { keys: requested });
  const rows = workBudget && typeof workBudget.waitFor === "function"
    ? await workBudget.waitFor("market.GetSeedStocks", call)
    : await call();
  const loaded = Array.isArray(rows) ? rows : [];
  for (const row of loaded) updateStockMap(lastStockSnapshot, row);
  stockCacheRuntime.metrics[`${metricPrefix}RowsRequested`] += requested.length;
  stockCacheRuntime.metrics[`${metricPrefix}RowsLoaded`] += loaded.length;
  if (metricPrefix !== "dirty") {
    stockCacheRuntime.metrics[`${metricPrefix}Batches`] += 1;
  }
  if (workBudget && typeof workBudget.checkpoint === "function") {
    const yielded = await workBudget.checkpoint(true);
    if (yielded) stockCacheRuntime.metrics.cooperativeYields += 1;
  }
  return loaded;
}

async function initializeMissingRegionalStock(
  stockMap,
  workBudget = null,
  nowMs = Date.now(),
) {
  const status = stockCacheRuntime.automaticRegionalStock;
  status.attempts += 1;
  status.startedAtMs = status.startedAtMs || nowMs;
  status.completedAtMs = 0;
  status.lastError = null;
  const missing = AUTOMATIC_REGIONAL_STOCK_SPECS.filter((entry) => (
    !stockMap.has(stockKey(entry.station.stationID, entry.good.typeID))
  ));
  status.missingRows = missing.length;
  status.createdRows = 0;
  status.preservedRows = 0;
  status.batches = 0;
  if (missing.length <= 0) {
    status.completedAtMs = Date.now();
    return { ...status };
  }

  try {
    const regionalBatches = [...missing.reduce((batches, entry) => {
      const regionID = Number(entry.station.regionID) || 0;
      if (!batches.has(regionID)) batches.set(regionID, []);
      batches.get(regionID).push(entry);
      return batches;
    }, new Map()).values()];
    for (const batch of regionalBatches) {
      const requests = batch.map((entry) => ({
        station_id: entry.station.stationID,
        type_id: entry.good.typeID,
        delta_quantity: null,
        new_quantity: entry.initialQuantity,
        new_price: computePrice(
          entry.good,
          entry.station,
          entry.initialQuantity,
        ),
        reason: `living economy automatic regional stock v${AUTOMATIC_REGIONAL_STOCK_REVISION}`,
        adjustment_id:
          `living-economy:auto-regional-stock:v${AUTOMATIC_REGIONAL_STOCK_REVISION}:` +
          `${entry.station.stationID}:${entry.good.typeID}`,
        allow_create: true,
        create_only: true,
      }));
      const call = () => marketDaemonClient.call("AdjustSeedStocks", {
        adjustments: requests,
      });
      const responses = workBudget && typeof workBudget.waitFor === "function"
        ? await workBudget.waitFor("market.AdjustSeedStocks.initializeRegionalStock", call)
        : await call();
      if (!Array.isArray(responses) || responses.length !== batch.length) {
        throw new Error(
          "automatic regional stock initialization returned an invalid response count",
        );
      }
      for (const response of responses) {
        updateStockMap(stockMap, response);
        if (response && response.applied === true) {
          status.createdRows += 1;
        } else {
          status.preservedRows += 1;
        }
      }
      status.batches += 1;
      if (workBudget && typeof workBudget.checkpoint === "function") {
        const yielded = await workBudget.checkpoint(true);
        if (yielded) stockCacheRuntime.metrics.cooperativeYields += 1;
      }
    }
  } catch (error) {
    status.failures += 1;
    status.lastError = error && error.message || String(error);
    throw error;
  }

  status.completedAtMs = Date.now();
  if (status.createdRows > 0) {
    log.info(
      `[LivingEconomy] Initialized ${status.createdRows} missing regional-hub ` +
      `stock rows across ${catalog.REGIONAL_HUBS.length} regions.`,
    );
  }
  return { ...status };
}

async function bootstrapStockCache(workBudget, nowMs) {
  if (stockCacheRuntime.ready) return lastStockSnapshot;
  stockCacheRuntime.bootstrapStartedAtMs = stockCacheRuntime.bootstrapStartedAtMs || nowMs;
  lastStockSnapshot = new Map();
  const batchSize = getStockBootstrapBatchSize();
  for (const shard of REGIONAL_STOCK_SHARDS) {
    stockCacheRuntime.currentRegionID = shard.regionID;
    for (let index = 0; index < shard.keys.length; index += batchSize) {
      await readStockKeyBatch(
        shard.keys.slice(index, index + batchSize),
        "bootstrap",
        workBudget,
      );
    }
  }
  await initializeMissingRegionalStock(lastStockSnapshot, workBudget, nowMs);
  stockCacheRuntime.ready = true;
  stockCacheRuntime.bootstrapCompletedAtMs = Date.now();
  stockCacheRuntime.lastFullReconcileAtMs = stockCacheRuntime.bootstrapCompletedAtMs;
  stockCacheRuntime.reconcileRegionIndex = 0;
  stockCacheRuntime.reconcileKeyIndex = 0;
  stockCacheRuntime.currentRegionID = REGIONAL_STOCK_SHARDS[0]
    ? REGIONAL_STOCK_SHARDS[0].regionID
    : null;
  return lastStockSnapshot;
}

async function refreshDirtyStock(workBudget) {
  if (stockCacheRuntime.dirtyKeys.size <= 0) return 0;
  const batchSize = getStockReconcileBatchSize();
  const entries = [...stockCacheRuntime.dirtyKeys.entries()].slice(0, batchSize);
  for (const [key] of entries) stockCacheRuntime.dirtyKeys.delete(key);
  try {
    await readStockKeyBatch(entries.map(([, key]) => key), "dirty", workBudget);
    return entries.length;
  } catch (error) {
    for (const [key, value] of entries) stockCacheRuntime.dirtyKeys.set(key, value);
    throw error;
  }
}

async function refreshRegionalStockSlice(workBudget, nowMs) {
  if (!stockCacheRuntime.ready || REGIONAL_STOCK_SHARDS.length <= 0) return 0;
  const shard = REGIONAL_STOCK_SHARDS[
    stockCacheRuntime.reconcileRegionIndex % REGIONAL_STOCK_SHARDS.length
  ];
  const batchSize = getStockReconcileBatchSize();
  const start = stockCacheRuntime.reconcileKeyIndex;
  const keys = shard.keys.slice(start, start + batchSize);
  stockCacheRuntime.currentRegionID = shard.regionID;
  await readStockKeyBatch(keys, "reconciliation", workBudget);
  stockCacheRuntime.lastReconcileAtMs = nowMs;
  stockCacheRuntime.reconcileKeyIndex += keys.length;
  if (stockCacheRuntime.reconcileKeyIndex >= shard.keys.length) {
    stockCacheRuntime.reconcileKeyIndex = 0;
    stockCacheRuntime.reconcileRegionIndex += 1;
    if (stockCacheRuntime.reconcileRegionIndex >= REGIONAL_STOCK_SHARDS.length) {
      stockCacheRuntime.reconcileRegionIndex = 0;
      stockCacheRuntime.lastFullReconcileAtMs = nowMs;
      stockCacheRuntime.metrics.reconciliationCycles += 1;
    }
  }
  return keys.length;
}

async function readPilotStock(workBudget, nowMs = Date.now()) {
  if (!stockCacheRuntime.ready) {
    return bootstrapStockCache(workBudget, nowMs);
  }
  await refreshDirtyStock(workBudget);
  await refreshRegionalStockSlice(workBudget, nowMs);
  return lastStockSnapshot;
}

function notifyMarketStockMutation(details = {}) {
  const stationID = Number(details.station_id || details.stationID) || 0;
  const typeID = Number(details.type_id || details.typeID) || 0;
  if (!stationID || !typeID) return false;
  const key = stockKey(stationID, typeID);
  const quantity = Number(
    details.quantity !== undefined ? details.quantity : details.vol_remaining,
  );
  if (stockCacheRuntime.ready && Number.isFinite(quantity) && quantity >= 0) {
    updateStockMap(lastStockSnapshot, {
      ...details,
      station_id: stationID,
      type_id: typeID,
      quantity,
    });
    stockCacheRuntime.metrics.knownMutationsApplied += 1;
    stockCacheRuntime.dirtyKeys.delete(key);
    return true;
  }
  stockCacheRuntime.dirtyKeys.set(key, {
    station_id: stationID,
    type_id: typeID,
  });
  return true;
}

function notifyExternalFreightDemandMutation() {
  routePlanningRuntime.opportunities = [];
  routePlanningRuntime.lastBuiltAtMs = 0;
  if (runtimeState) runtimeState.lastPulseAtMs = 0;
  return true;
}

function computePrice(good, station, quantity) {
  const target = Math.max(1, catalog.getTargetQuantity(station, good));
  const stockRatio = Math.max(0, toFiniteNumber(quantity, 0) / target);
  const multiplier = Math.max(0.8, Math.min(1.6, 1 + ((1 - stockRatio) * 0.35)));
  return roundPrice(good.priceAnchor * multiplier);
}

function isNonRetryableStockAdjustmentError(error) {
  return /seed stock quantity cannot become negative/i.test(String(error && error.message || error || ""));
}

function invalidateFreightOpportunitiesForStockRow(stationID, typeID) {
  const normalizedStationID = toPositiveInt(stationID, 0);
  const normalizedTypeID = toPositiveInt(typeID, 0);
  if (!normalizedStationID || !normalizedTypeID) return 0;
  const opportunities = routePlanningRuntime.opportunities;
  let removed = 0;
  for (let index = opportunities.length - 1; index >= 0; index -= 1) {
    const opportunity = opportunities[index];
    if (
      toPositiveInt(
        opportunity && opportunity.sourceStation && opportunity.sourceStation.stationID,
        0,
      ) === normalizedStationID &&
      toPositiveInt(opportunity && opportunity.good && opportunity.good.typeID, 0) ===
        normalizedTypeID
    ) {
      // Splice the cached array in place: createJobs() retains this same array
      // for the rest of the current pulse. Replacing the property would leave
      // that local reference alive long enough to create several more doomed
      // jobs from the stale source row.
      opportunities.splice(index, 1);
      removed += 1;
    }
  }
  if (removed > 0) routePlanningRuntime.lastBuiltAtMs = 0;
  return removed;
}

function invalidateRejectedStockReservation(stockMap, station, good, current) {
  if (!stockMap || !station || !good) return;
  updateStockMap(stockMap, {
    station_id: station.stationID,
    type_id: good.typeID,
    quantity: 0,
    price: toFiniteNumber(current && current.price, good.priceAnchor),
  });
  stockCacheRuntime.dirtyKeys.set(stockKey(station.stationID, good.typeID), {
    station_id: station.stationID,
    type_id: good.typeID,
  });
  invalidateFreightOpportunitiesForStockRow(station.stationID, good.typeID);
}

async function adjustStock({
  adjustmentID,
  station,
  good,
  deltaQuantity,
  newQuantity,
  reason,
  stockMap,
  workBudget = null,
}) {
  const current = getStockRow(stockMap, station.stationID, good.typeID);
  const projectedQuantity = newQuantity !== undefined
    ? Math.max(0, toPositiveInt(newQuantity, 0))
    : Math.max(0, toFiniteNumber(current.quantity, 0) + toFiniteNumber(deltaQuantity, 0));
  try {
    const call = () => marketDaemonClient.call("AdjustSeedStock", {
      station_id: station.stationID,
      type_id: good.typeID,
      delta_quantity: newQuantity === undefined ? Math.trunc(deltaQuantity || 0) : null,
      new_quantity: newQuantity === undefined ? null : Math.trunc(newQuantity),
      new_price: computePrice(good, station, projectedQuantity),
      reason: String(reason || "living-economy"),
      adjustment_id: String(adjustmentID || ""),
      allow_create: true,
    });
    const response = workBudget && typeof workBudget.waitFor === "function"
      ? await workBudget.waitFor("market.AdjustSeedStock", call)
      : await call();
    updateStockMap(stockMap, response);
    runtimeState.metrics.marketAdjustments += 1;
    return { success: true, response };
  } catch (error) {
    runtimeState.metrics.failedAdjustments += 1;
    lastPulseError = error.message;
    const retryable = !isNonRetryableStockAdjustmentError(error);
    if (!retryable && toFiniteNumber(deltaQuantity, 0) < 0) {
      // The cache can legitimately lag a player purchase or another economy
      // worker. A daemon underflow rejection is authoritative: suppress this
      // candidate for the rest of the pulse and refresh the exact row on the
      // next pulse instead of creating dozens of doomed reservation jobs.
      invalidateRejectedStockReservation(stockMap, station, good, current);
    }
    log.warn(`[LivingEconomy] Market adjustment failed (${adjustmentID}): ${error.message}`);
    return { success: false, error, retryable };
  }
}

async function adjustStocks(adjustments, workBudget = null) {
  const entries = (Array.isArray(adjustments) ? adjustments : [])
    .map((details, index) => ({ details, index }))
    .filter((entry) => entry.details && entry.details.station && entry.details.good);
  if (entries.length <= 0) return [];
  marketBatchRuntime.batchesAttempted += 1;
  marketBatchRuntime.adjustmentsSubmitted += entries.length;
  marketBatchRuntime.maximumBatchSize = Math.max(
    marketBatchRuntime.maximumBatchSize,
    entries.length,
  );
  const projectedQuantities = new Map();
  const requests = [];
  for (const entry of entries) {
    const key = stockKey(entry.details.station.stationID, entry.details.good.typeID);
    const current = getStockRow(
      entry.details.stockMap,
      entry.details.station.stationID,
      entry.details.good.typeID,
    );
    const startingQuantity = projectedQuantities.has(key)
      ? projectedQuantities.get(key)
      : toFiniteNumber(current.quantity, 0);
    const projectedQuantity = entry.details.newQuantity !== undefined
      ? Math.max(0, toPositiveInt(entry.details.newQuantity, 0))
      : Math.max(
        0,
        startingQuantity + toFiniteNumber(entry.details.deltaQuantity, 0),
      );
    projectedQuantities.set(key, projectedQuantity);
    requests.push({
      station_id: entry.details.station.stationID,
      type_id: entry.details.good.typeID,
      delta_quantity: entry.details.newQuantity === undefined
        ? Math.trunc(entry.details.deltaQuantity || 0)
        : null,
      new_quantity: entry.details.newQuantity === undefined
        ? null
        : Math.trunc(entry.details.newQuantity),
      new_price: computePrice(
        entry.details.good,
        entry.details.station,
        projectedQuantity,
      ),
      reason: String(entry.details.reason || "living-economy"),
      adjustment_id: String(entry.details.adjustmentID || ""),
      allow_create: true,
    });
  }
  const results = new Array(adjustments.length);
  const call = () => marketDaemonClient.call("AdjustSeedStocks", {
    adjustments: requests,
  });
  try {
    const responses = workBudget && typeof workBudget.waitFor === "function"
      ? await workBudget.waitFor("market.AdjustSeedStocks", call)
      : await call();
    if (!Array.isArray(responses) || responses.length !== entries.length) {
      throw new Error("market adjustment batch returned an invalid response count");
    }
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const response = responses[index];
      updateStockMap(entry.details.stockMap, response);
      runtimeState.metrics.marketAdjustments += 1;
      results[entry.index] = { success: true, response };
    }
    marketBatchRuntime.batchesSucceeded += 1;
    marketBatchRuntime.lastBatchError = null;
    return results;
  } catch (batchError) {
    // Batch updates are atomic in the daemon. If one row is stale or an older
    // daemon does not support the method yet, retry individually so successful
    // reservations still make progress and the precise failing row is marked.
    marketBatchRuntime.batchFallbacks += 1;
    marketBatchRuntime.lastBatchError = batchError && batchError.message || String(batchError);
    for (const entry of entries) {
      results[entry.index] = await adjustStock({
        ...entry.details,
        workBudget,
      });
    }
    return results;
  }
}

async function settleProcurementFill(details = {}) {
  const nowMs = toFiniteNumber(details.nowMs, Date.now());
  initialize(nowMs);
  try {
    assertEventProductionAvailable(nowMs);
  } catch (error) {
    return { success: false, errorMsg: error.code || error.message, error };
  }
  const preview = procurement.previewFill(runtimeState, details);
  if (!preview.success) {
    return preview;
  }
  const order = preview.order;
  const good = catalog.getGood(order.typeID) || {
    typeID: order.typeID,
    name: order.typeName || `type ${order.typeID}`,
    priceAnchor: order.price,
  };
  // Attempt-unique token: a failed settle must not leave a consumed token
  // that would silently swallow the stock credit of a later identical fill.
  order.fillSequence = toPositiveInt(order.fillSequence, 0) + 1;
  const fillToken = `${order.orderID}:s${order.fillSequence}:q${preview.quantity}`;
  // Guards procurement reconciliation from interleaving with this
  // settlement's await windows and double-counting the fill. The stamp is
  // settlement-scoped so a concurrent settle on the same order is not
  // unmasked by this one's cleanup.
  const settlementStamp = nowMs + Math.random();
  order.settlementInFlightAtMs = settlementStamp;
  let response = null;
  try {
    response = await marketDaemonClient.call("AdjustSeedStock", {
      station_id: order.stationID,
      type_id: order.typeID,
      delta_quantity: preview.quantity,
      new_quantity: null,
      // Delivered war-procurement stock lists at what the NPC paid for it: a
      // buy-back must cost at least the premium, or selling into the bid and
      // repurchasing the same units becomes a riskless ISK loop.
      new_price: preview.price,
      reason: `living procurement receipt ${order.orderID}`,
      adjustment_id: `living-procurement-fill:${fillToken}`,
      allow_create: true,
    });
    updateStockMap(lastStockSnapshot, response);
    runtimeState.metrics.marketAdjustments += 1;
    if (!(response && response.applied === true)) {
      // The daemon deduped this token — a crash-replayed stale sequence. Do
      // not book a settlement that no stock credit backs; escape the
      // collision for future fills and let order reconciliation absorb the
      // money side of the already-recorded daemon fill.
      order.fillSequence = toPositiveInt(order.fillSequence, 0) + 1;
      persistState(nowMs);
      return { success: false, errorMsg: "PROCUREMENT_FILL_TOKEN_REPLAYED" };
    }
    const settlement = procurement.settleFill(runtimeState, details, nowMs);
    if (!settlement.success) {
      await marketDaemonClient.call("AdjustSeedStock", {
        station_id: order.stationID,
        type_id: order.typeID,
        delta_quantity: -preview.quantity,
        new_quantity: null,
        new_price: null,
        reason: `living procurement rollback ${order.orderID}`,
        adjustment_id: `living-procurement-rollback:${fillToken}`,
        allow_create: true,
      });
      return settlement;
    }
    addEvent("procurement_fill", null, {
      orderID: order.orderID,
      corporationID: order.corporationID,
      stationID: order.stationID,
      typeID: good.typeID,
      quantity: settlement.quantity,
      price: toFiniteNumber(details.price, order.price),
      sellerKind: String(details.sellerKind || "player"),
    }, nowMs);
    persistState(nowMs);
    return { ...settlement, response };
  } catch (error) {
    if (error && error.xEveProductionPaused === true) {
      // The order state, stock receipt, and source event are already applied,
      // and addEvent durably preserved that source before opening the circuit.
      // Report success so the market path still credits the player; automatic
      // or startup reconciliation will replay the deferred X-Eve observation.
      return {
        ...preview,
        success: true,
        response,
        eventDeferred: true,
        deferredEventError: error.code || error.message,
      };
    }
    runtimeState.metrics.failedAdjustments += 1;
    lastPulseError = error.message;
    persistState(nowMs);
    return { success: false, errorMsg: error.message, preview };
  } finally {
    if (order.settlementInFlightAtMs === settlementStamp) {
      order.settlementInFlightAtMs = 0;
    }
  }
}

function validateProcurementFill(details = {}) {
  const nowMs = toFiniteNumber(details.nowMs, Date.now());
  initialize(nowMs);
  try {
    assertEventProductionAvailable(nowMs);
  } catch (error) {
    return { success: false, errorMsg: error.code || error.message };
  }
  const preview = procurement.previewFill(runtimeState, details);
  if (preview.success) {
    // The fill is about to run its daemon leg: shield the order from
    // reconciliation interleaves from this moment, not just from settlement.
    // Every abandoned path either calls endProcurementFill or ages out via
    // the 120s in-flight window.
    preview.order.settlementInFlightAtMs = nowMs;
  }
  return preview;
}

function endProcurementFill(details = {}) {
  if (!runtimeState || !runtimeState.procurement || !runtimeState.procurement.orders) {
    return false;
  }
  const order = runtimeState.procurement.orders[String(details.orderID || "")];
  if (order) order.settlementInFlightAtMs = 0;
  return Boolean(order);
}

function getNpcRefineryEfficiency() {
  const base = Math.max(
    0.3,
    Math.min(
      0.9,
      toPositiveInt(config.livingEconomyNpcRefineryEfficiencyPercent, 72) / 100,
    ),
  );
  // Mobilization: war-footing refineries run hotter (72% -> ~88% at full
  // level, never past the 90% clamp). Efficiency is frozen per deposit at
  // delivery, so this is replay-safe by construction — only NEW deposits see
  // the surged value.
  if (mobilization.getLevel() <= 0) return base;
  const surged = base + (0.88 - base) * mobilization.getIndustryRamp();
  return Math.max(base, Math.min(0.9, surged));
}

function buildNpcRefineryOutputs(oreEntries, efficiency = getNpcRefineryEfficiency()) {
  const outputByTypeID = new Map();
  const normalizedEfficiency = Math.max(0, Math.min(1, toFiniteNumber(efficiency, 0.5)));
  for (const ore of normalizeOreManifest(oreEntries)) {
    const profile = reprocessing.getReprocessingProfile(ore.typeID);
    if (!profile) {
      continue;
    }
    const portionSize = Math.max(1, toPositiveInt(profile.portionSize, 1));
    const portions = Math.floor(ore.quantity / portionSize);
    if (portions <= 0) {
      continue;
    }
    for (const material of reprocessing.getTypeMaterials(ore.typeID)) {
      const typeID = toPositiveInt(material && material.materialTypeID, 0);
      const quantity = Math.max(
        0,
        Math.floor(
          toPositiveInt(material && material.quantity, 0) *
          portions *
          normalizedEfficiency,
        ),
      );
      if (typeID > 0 && quantity > 0 && catalog.getGood(typeID)) {
        outputByTypeID.set(typeID, (outputByTypeID.get(typeID) || 0) + quantity);
      }
    }
  }
  return [...outputByTypeID.entries()]
    .map(([typeID, quantity]) => ({
      typeID,
      typeName: catalog.getGood(typeID).name,
      quantity,
    }))
    .sort((left, right) => left.typeID - right.typeID);
}

async function processPendingMiningDeposits(livingState, stockMap, nowMs, workBudget = null) {
  const pending = await collectPendingSorted(
    runtimeState.miningDeposits,
    (deposit) => String(deposit && deposit.status || "") === "pending",
    (deposit) => deposit && deposit.createdAtMs,
    workBudget,
  );
  const preparedDeposits = [];
  const pendingAdjustments = [];
  for (const deposit of pending) {
    if (workBudget) await workBudget.checkpoint();
    const station = catalog.getStation(deposit.destinationStationID);
    if (!station) {
      deposit.lastError = "destination-station-missing";
      deposit.lastUpdatedAtMs = nowMs;
      continue;
    }
    // Settle at the efficiency frozen when the deposit was delivered; legacy
    // deposits without the field predate the configurable rate and must
    // replay their receipts at the historical 0.5 or the quantity-less
    // refine tokens collide.
    const outputs = buildNpcRefineryOutputs(
      deposit.ore,
      toFiniteNumber(deposit.refineryEfficiency, 0.5),
    );
    const creditedTypeIDs = new Set(
      (Array.isArray(deposit.creditedTypeIDs) ? deposit.creditedTypeIDs : [])
        .map((value) => toPositiveInt(value, 0))
        .filter(Boolean),
    );
    const outputValuationsByTypeID = new Map(
      (Array.isArray(deposit.outputValuations) ? deposit.outputValuations : [])
        .map((entry) => [toPositiveInt(entry && entry.typeID, 0), entry])
        .filter(([typeID]) => typeID > 0),
    );
    const prepared = {
      deposit,
      station,
      outputs,
      creditedTypeIDs,
      outputValuationsByTypeID,
      failed: false,
    };
    preparedDeposits.push(prepared);
    for (const output of outputs) {
      if (creditedTypeIDs.has(output.typeID)) {
        continue;
      }
      const good = catalog.getGood(output.typeID);
      const priceBeforeCredit = roundPrice(
        getStockRow(stockMap, station.stationID, output.typeID).price || good.priceAnchor,
      );
      pendingAdjustments.push({
        prepared,
        output,
        priceBeforeCredit,
        adjustment: {
          adjustmentID: `${deposit.depositID}:refine:${output.typeID}`,
          station,
          good,
          deltaQuantity: output.quantity,
          reason: `NPC refinery receipt ${deposit.depositID}`,
          stockMap,
        },
      });
    }
  }

  const adjustmentResults = pendingAdjustments.length > 0
    ? await adjustStocks(
      pendingAdjustments.map((entry) => entry.adjustment),
      workBudget,
    )
    : [];
  for (let index = 0; index < pendingAdjustments.length; index += 1) {
    const entry = pendingAdjustments[index];
    const result = adjustmentResults[index];
    const { prepared, output, priceBeforeCredit } = entry;
    const { creditedTypeIDs, outputValuationsByTypeID } = prepared;
    if (!result || !result.success) {
      prepared.failed = true;
      continue;
    }
    creditedTypeIDs.add(output.typeID);
    outputValuationsByTypeID.set(output.typeID, {
      typeID: output.typeID,
      typeName: output.typeName,
      quantity: output.quantity,
      unitPrice: priceBeforeCredit,
      grossValue: roundMoney(priceBeforeCredit * output.quantity),
    });
    runtimeState.metrics.mineralUnitsRefined += output.quantity;
  }

  for (const prepared of preparedDeposits) {
    if (workBudget) await workBudget.checkpoint();
    const {
      deposit,
      station,
      outputs,
      creditedTypeIDs,
      outputValuationsByTypeID,
      failed,
    } = prepared;
    deposit.creditedTypeIDs = [...creditedTypeIDs].sort((left, right) => left - right);
    deposit.outputs = outputs;
    deposit.outputValuations = [...outputValuationsByTypeID.values()]
      .sort((left, right) => left.typeID - right.typeID);
    deposit.lastUpdatedAtMs = nowMs;
    if (failed || outputs.some((output) => !creditedTypeIDs.has(output.typeID))) {
      deposit.lastError = "market-credit-deferred";
      continue;
    }

    deposit.status = "delivered";
    deposit.deliveredAtMs = nowMs;
    deposit.lastError = null;
    deposit.grossMarketValue = roundMoney(
      deposit.outputValuations.reduce(
        (sum, output) => sum + toFiniteNumber(output.grossValue, 0),
        0,
      ),
    );
    recordMinerDepositValue(deposit, nowMs);
    runtimeState.metrics.miningDepositsDelivered += 1;
    const flight = getFlightByID(livingState, deposit.assignedFlightID);
    if (
      flight &&
      flight.miningManifest &&
      String(flight.miningManifest.depositID || "") === deposit.depositID
    ) {
      flight.miningManifest.depositStatus = "delivered";
      flight.miningManifest.depositedAtMs = nowMs;
      flight.miningManifest.refinedOutputs = outputs;
      if (
        String(flight.phase || "") === "docked" &&
        String(flight.lastTransitionReason || "") === "waiting-for-mining-deposit-credit"
      ) {
        flight.nextTransitionAtMs = Math.min(
          toFiniteNumber(flight.nextTransitionAtMs, nowMs + 1_000),
          nowMs + 1_000,
        );
      }
      markLivingStateDirty(flight);
    }
    addEvent("mining_deposit_delivered", null, {
      depositID: deposit.depositID,
      flightID: deposit.assignedFlightID,
      stationID: station.stationID,
      mineralUnits: outputs.reduce((sum, output) => sum + output.quantity, 0),
    }, nowMs);
  }
}

function completeJob(job, flight, status, nowMs, details = {}) {
  job.status = status;
  job.completedAtMs = nowMs;
  job.lastUpdatedAtMs = nowMs;
  if (flight && String(flight.freightJobID || "") === job.jobID) {
    flight.freightJobID = null;
    markLivingStateDirty(flight);
  }
  addEvent(status === "delivered" ? "job_delivered" : "job_closed", job, details, nowMs);
}

function reverseRecoveredEstateLoss(job, nowMs) {
  if (!job || job.status !== "lost" || job.lossAccountingReversedAtMs) return false;
  runtimeState.metrics.jobsLost = Math.max(
    0,
    toPositiveInt(runtimeState.metrics.jobsLost, 0) - 1,
  );
  runtimeState.metrics.unitsLost = Math.max(
    0,
    toPositiveInt(runtimeState.metrics.unitsLost, 0) - toPositiveInt(job.quantity, 0),
  );
  if (job.cargoLossAccountingAtMs) {
    runtimeState.metrics.cargoVolumeLostM3 = Math.max(
      0,
      toFiniteNumber(runtimeState.metrics.cargoVolumeLostM3, 0) -
        toFiniteNumber(job.cargoVolume, 0),
    );
    incrementClassMetric("lostByLogisticsClass", job.logisticsClass, -1);
  }
  if (job.lossAccountingAtMs) {
    runtimeState.metrics.traderCargoLossValue = roundMoney(Math.max(
      0,
      toFiniteNumber(runtimeState.metrics.traderCargoLossValue, 0) -
        Math.max(0, toFiniteNumber(job.purchaseValue, 0)),
    ));
  }
  job.lossAccountingReversedAtMs = nowMs;
  return true;
}

function finalizeEstateDeliveryJob(job, livingState, settlement, nowMs) {
  if (!job || !settlement || settlement.success !== true) return false;
  const delivered = settlement.data && settlement.data.reservation;
  const previousStatus = String(job.status || "");
  if (previousStatus === "lost") reverseRecoveredEstateLoss(job, nowMs);
  job.saleUnitPrice = roundPrice(
    toFiniteNumber(delivered && delivered.totalISK, job.purchaseValue) /
      Math.max(1, toPositiveInt(job.quantity, 1)),
  );
  job.saleValue = roundMoney(
    toFiniteNumber(delivered && delivered.totalISK, job.purchaseValue),
  );
  job.grossMargin = roundMoney(
    job.saleValue - Math.max(0, toFiniteNumber(job.purchaseValue, job.estimatedValue)),
  );
  job.marginPercent = toFiniteNumber(job.purchaseValue, 0) > 0
    ? Math.round((job.grossMargin / job.purchaseValue) * 10_000) / 100
    : 0;
  const flight = getFlightByID(livingState, job.assignedFlightID);
  const flightOwnedJob = Boolean(
    flight && String(flight.freightJobID || "") === job.jobID,
  );
  if (previousStatus !== "delivered") {
    completeJob(job, flight, "delivered", nowMs, {
      stationID: job.destinationStationID,
      structureID: job.destinationStationID,
      quantity: job.quantity,
      typeID: job.typeID,
      projectKey: job.estateDelivery && job.estateDelivery.projectKey,
      recovered: previousStatus !== "delivery_pending",
    });
  } else if (flight && String(flight.freightJobID || "") === job.jobID) {
    flight.freightJobID = null;
    markLivingStateDirty(flight);
  }
  job.failureReason = null;
  job.estateDeliveryError = null;
  job.estateSettlementConfirmedAtMs = nowMs;
  job.estateCloseConfirmedAtMs = nowMs;
  if (flightOwnedJob) {
    flight.estateReturnPending = true;
    flight.lastTransitionReason = "estate-delivery-turnaround";
    markLivingStateDirty(flight);
  }
  if (!job.deliveryMetricAccountingAtMs) {
    job.deliveryMetricAccountingAtMs = nowMs;
    runtimeState.metrics.jobsDelivered += 1;
    runtimeState.metrics.unitsDelivered += toPositiveInt(job.quantity, 0);
  }
  recordCargoDelivery(job, nowMs);
  recordTraderSale(job, nowMs);
  return true;
}

function finalizeEstateTerminalJob(
  job,
  livingState,
  status,
  reason,
  nowMs,
) {
  if (!job) return false;
  const normalizedStatus = status === "lost" ? "lost" : "cancelled";
  const flight = getFlightByID(livingState, job.assignedFlightID);
  if (isActiveJob(job) || String(job.status || "") !== normalizedStatus) {
    completeJob(job, flight, normalizedStatus, nowMs, {
      reason: reason || "estate-terminal-receipt-reconciled",
      projectKey: job.estateDelivery && job.estateDelivery.projectKey,
      recovered: true,
    });
  } else if (flight && String(flight.freightJobID || "") === job.jobID) {
    flight.freightJobID = null;
    markLivingStateDirty(flight);
  }
  if (normalizedStatus === "lost" && !job.cargoLossAccountingAtMs) {
    runtimeState.metrics.jobsLost += 1;
    runtimeState.metrics.unitsLost += toPositiveInt(job.quantity, 0);
    recordCargoLoss(job, nowMs);
    recordTraderCargoLoss(job, nowMs);
  }
  job.failureReason = reason || job.failureReason || normalizedStatus;
  job.estateDeliveryError = null;
  job.estateCloseConfirmedAtMs = nowMs;
  return true;
}

async function processPendingDeliveries(livingState, stockMap, nowMs, workBudget = null) {
  const pending = await collectPendingSorted(
    runtimeState.jobs,
    (job) => String(job && job.status || "") === "delivery_pending",
    (job) => job && job.arrivedAtMs,
    workBudget,
  );
  for (const job of pending) {
    if (workBudget) await workBudget.checkpoint();
    if (job.estateDelivery) {
      job.deliveryAttempts = toPositiveInt(job.deliveryAttempts, 0) + 1;
      let settlement = null;
      try {
        const estateRuntime = getFamilyEstateProjectsRuntime();
        const arrived = estateRuntime.markFamilyEstateNpcDeliveryArrived(job.jobID, nowMs);
        if (!arrived.success) {
          throw new Error(arrived.errorMsg || "Estate arrival receipt failed");
        }
        settlement = estateRuntime.settleFamilyEstateNpcDelivery(job.jobID, nowMs);
      } catch (error) {
        settlement = { success: false, errorMsg: error.message };
      }
      if (!settlement || settlement.success !== true) {
        job.lastUpdatedAtMs = nowMs;
        job.estateDeliveryError = settlement && settlement.errorMsg || "ESTATE_DELIVERY_FAILED";
        continue;
      }
      finalizeEstateDeliveryJob(job, livingState, settlement, nowMs);
      continue;
    }
    const station = catalog.getStation(job.destinationStationID);
    const good = catalog.getGood(job.typeID);
    if (!station || !good) {
      job.status = "lost";
      job.failureReason = "catalog-entry-missing-at-delivery";
      runtimeState.metrics.jobsLost += 1;
      runtimeState.metrics.unitsLost += toPositiveInt(job.quantity, 0);
      recordCargoLoss(job, nowMs);
      recordTraderCargoLoss(job, nowMs);
      continue;
    }
    const destinationRow = getStockRow(stockMap, station.stationID, good.typeID);
    let saleUnitPrice = roundPrice(destinationRow.price || good.priceAnchor);
    let procurementQuantity = 0;
    if (job.procurementOrderID) {
      try {
        const getOrder = () => marketDaemonClient.call("GetOrder", {
          order_id: String(job.procurementOrderID),
        });
        const remoteOrder = workBudget && typeof workBudget.waitFor === "function"
          ? await workBudget.waitFor("market.GetOrder", getOrder)
          : await getOrder();
        const remaining = toPositiveInt(
          remoteOrder && remoteOrder.row && remoteOrder.row.vol_remaining,
          0,
        );
        procurementQuantity = Math.min(toPositiveInt(job.quantity, 0), remaining);
        if (procurementQuantity > 0 && String(remoteOrder && remoteOrder.state || "open") === "open") {
          const fillOrder = () => marketDaemonClient.call("FillOrder", {
            order_id: String(job.procurementOrderID),
            fill_quantity: procurementQuantity,
          });
          const fill = workBudget && typeof workBudget.waitFor === "function"
            ? await workBudget.waitFor("market.FillOrder", fillOrder)
            : await fillOrder();
          saleUnitPrice = roundPrice(fill && fill.price || job.procurementUnitPrice || saleUnitPrice);
          const settled = procurement.settleFill(runtimeState, {
            orderID: job.procurementOrderID,
            quantity: procurementQuantity,
            price: saleUnitPrice,
            sellerKind: "npc",
          }, nowMs);
          if (!settled.success) {
            throw new Error(settled.errorMsg || "NPC procurement settlement failed");
          }
        }
      } catch (error) {
        job.procurementError = error.message;
        procurementQuantity = 0;
      }
    }
    const result = await adjustStock({
      adjustmentID: `${job.jobID}:delivery`,
      station,
      good,
      deltaQuantity: toPositiveInt(job.quantity, 0),
      reason: `living freight delivery ${job.jobID}`,
      stockMap,
      workBudget,
    });
    job.deliveryAttempts = toPositiveInt(job.deliveryAttempts, 0) + 1;
    if (!result.success) {
      job.lastUpdatedAtMs = nowMs;
      continue;
    }
    job.saleUnitPrice = saleUnitPrice;
    job.procurementQuantity = procurementQuantity;
    job.saleValue = roundMoney(saleUnitPrice * toPositiveInt(job.quantity, 0));
    job.grossMargin = roundMoney(
      job.saleValue - Math.max(0, toFiniteNumber(job.purchaseValue, job.estimatedValue)),
    );
    job.marginPercent = toFiniteNumber(job.purchaseValue, 0) > 0
      ? Math.round((job.grossMargin / job.purchaseValue) * 10_000) / 100
      : 0;
    const flight = getFlightByID(livingState, job.assignedFlightID);
    completeJob(job, flight, "delivered", nowMs, {
      stationID: station.stationID,
      quantity: job.quantity,
      typeID: job.typeID,
    });
    runtimeState.metrics.jobsDelivered += 1;
    runtimeState.metrics.unitsDelivered += toPositiveInt(job.quantity, 0);
    recordFreightDeliveryClass(job, nowMs);
    recordCargoDelivery(job, nowMs);
    recordTraderSale(job, nowMs);
  }
}

function getActiveJobCount() {
  return Object.values(runtimeState.jobs).filter(isActiveJob).length;
}

function buildPriorityProtectedStockByKey() {
  // Stock parked at a station that still owes units to a priority demand —
  // finished goods at the demand's home station or inputs at its chosen
  // producer — must not leave on authored-route fallback freight. The route
  // planner already protects these quantities (protectedDirectQuantity /
  // protectedProductionInputQuantity); this map gives findFreightCandidate
  // the same view.
  const protectedByKey = new Map();
  for (const row of listReplacementRequirements()) {
    const stationID = toPositiveInt(row && row.stationID, 0);
    const typeID = toPositiveInt(row && row.typeID, 0);
    const remaining = toPositiveInt(row && row.remainingQuantity, 0);
    if (!stationID || !typeID || remaining <= 0) continue;
    const key = `${stationID}:${typeID}`;
    protectedByKey.set(
      key,
      toPositiveInt(protectedByKey.get(key), 0) + remaining,
    );
  }
  return protectedByKey;
}

function findFreightCandidate(flight, stockMap, priorityProtectedByKey = null) {
  const route = catalog.getRoute(flight.routeID);
  if (!route) {
    return null;
  }
  const logisticsProfile = getFlightLogisticsProfile(flight);
  const allowedClasses = Array.isArray(route.allowedLogisticsClasses)
    ? route.allowedLogisticsClasses
    : [];
  if (
    (allowedClasses.length > 0 && !allowedClasses.includes(logisticsProfile.logisticsClass)) ||
    (String(route.riskBand || "highsec") === "lowsec" && !logisticsProfile.lowSecurityAccess)
  ) {
    return null;
  }
  const sourceStationID = getDockedStationID(flight);
  const sourceIndex = getEndpointIndex(route, sourceStationID);
  if (sourceIndex < 0) {
    return null;
  }
  const destinationStationID = route.endpointStationIDs[sourceIndex === 0 ? 1 : 0];
  const sourceStation = catalog.getStation(sourceStationID);
  const destinationStation = catalog.getStation(destinationStationID);
  if (!sourceStation || !destinationStation) {
    return null;
  }

  const candidates = [];
  for (const good of catalog.GOODS) {
    const destinationTarget = catalog.getTargetQuantity(destinationStation, good);
    if (destinationTarget <= 0) {
      continue;
    }
    const sourceTarget = catalog.getTargetQuantity(sourceStation, good);
    const sourceProducerCeiling = catalog.getProducerCeiling(sourceStation, good);
    const sourceQuantity = toPositiveInt(
      getStockRow(stockMap, sourceStationID, good.typeID).quantity,
      0,
    );
    const destinationQuantity = toPositiveInt(
      getStockRow(stockMap, destinationStationID, good.typeID).quantity,
      0,
    );
    const reorderPoint = Math.max(1, Math.round(destinationTarget * 0.65));
    if (destinationQuantity >= reorderPoint) {
      continue;
    }
    const sourceReserve = sourceProducerCeiling > 0
      ? Math.round(Math.max(sourceTarget, good.shipmentQuantity) * 0.75)
      : Math.round(sourceTarget * (sourceStation.archetype === "regional_hub" ? 0.35 : 0.5));
    const protectedPriorityQuantity = priorityProtectedByKey
      ? toPositiveInt(
          priorityProtectedByKey.get(`${sourceStationID}:${good.typeID}`),
          0,
        )
      : 0;
    const available = Math.max(
      0,
      sourceQuantity - sourceReserve - protectedPriorityQuantity,
    );
    const needed = Math.max(0, destinationTarget - destinationQuantity);
    const sourceRow = getStockRow(stockMap, sourceStationID, good.typeID);
    const sourceUnitPrice = roundPrice(sourceRow.price || good.priceAnchor);
    const requestedShipment = Math.max(
      1,
      Math.floor(good.shipmentQuantity * logisticsProfile.shipmentMultiplier),
    );
    const maximumByVolume = Math.max(
      0,
      Math.floor((logisticsProfile.capacityM3 * 0.9) / Math.max(0.000001, good.volume)),
    );
    const maximumByValue = Math.max(
      0,
      Math.floor(logisticsProfile.maximumCargoValueISK / Math.max(0.01, sourceUnitPrice)),
    );
    const quantity = Math.max(
      0,
      Math.min(requestedShipment, available, needed, maximumByVolume, maximumByValue),
    );
    if (quantity <= 0) {
      continue;
    }
    const cargoVolume = quantity * toFiniteNumber(good.volume, 1);
    if (cargoVolume > logisticsProfile.capacityM3) {
      continue;
    }
    const shortageRatio = needed / Math.max(1, destinationTarget);
    const surplusRatio = available / Math.max(1, good.shipmentQuantity);
    candidates.push({
      good,
      sourceStation,
      destinationStation,
      quantity,
      cargoVolume,
      logisticsProfile,
      routeClass: String(route.routeClass || "feeder"),
      riskBand: String(route.riskBand || "highsec"),
      sourceHubTier: String(sourceStation.hubTier || "local"),
      destinationHubTier: String(destinationStation.hubTier || "local"),
      capacityUtilization: cargoVolume / logisticsProfile.capacityM3,
      score:
        (shortageRatio * 100) +
        Math.min(25, surplusRatio) +
        Math.min(20, (cargoVolume / logisticsProfile.capacityM3) * 20),
    });
  }
  return candidates.sort((left, right) => right.score - left.score)[0] || null;
}

function allocateJobID() {
  const number = Math.max(1, toPositiveInt(runtimeState.nextJobNumber, 1));
  runtimeState.nextJobNumber = number + 1;
  return `LEF-${String(number).padStart(6, "0")}-${crypto.randomUUID().slice(0, 8)}`;
}

async function reserveJob(livingState, flight, candidate, stockMap, nowMs, workBudget = null) {
  const jobID = allocateJobID();
  const sourceRow = getStockRow(
    stockMap,
    candidate.sourceStation.stationID,
    candidate.good.typeID,
  );
  const purchaseUnitPrice = roundPrice(sourceRow.price || candidate.good.priceAnchor);
  const job = {
    jobID,
    kind: candidate.estateDelivery ? "estate_delivery" : "station_freight",
    status: "reserving",
    routeID: flight.routeID,
    assignedFlightID: flight.flightID,
    sourceStationID: candidate.sourceStation.stationID,
    destinationStationID: candidate.destinationStation.stationID,
    typeID: candidate.good.typeID,
    typeName: candidate.good.name,
    quantity: candidate.quantity,
    cargoVolume: candidate.cargoVolume,
    logisticsClass: candidate.logisticsProfile.logisticsClass,
    cargoCapacityM3: candidate.logisticsProfile.capacityM3,
    capacityUtilization: candidate.capacityUtilization,
    maximumCargoValueISK: candidate.logisticsProfile.maximumCargoValueISK,
    routeClass: candidate.routeClass,
    riskBand: candidate.riskBand,
    jumps: toPositiveInt(candidate.jumps, 0),
    estimatedTravelMinutes: toFiniteNumber(candidate.travelMinutes, 0),
    dynamicRoute: Boolean(candidate.routeSpec && candidate.routeSpec.dynamic),
    routeSpec: candidate.routeSpec
      ? JSON.parse(JSON.stringify(candidate.routeSpec))
      : null,
    destinationName: String(candidate.destinationStation.name || ""),
    estateDelivery: candidate.estateDelivery
      ? {
          ...candidate.estateDelivery,
          reservationID: jobID,
        }
      : null,
    procurementOrderID: candidate.procurementOrder
      ? String(candidate.procurementOrder.orderID || "")
      : null,
    procurementUnitPrice: candidate.procurementOrder
      ? roundPrice(candidate.procurementOrder.price)
      : 0,
    priorityDemandUnits: toPositiveInt(candidate.priorityDemandUnits, 0),
    priorityDemandKinds: Array.isArray(candidate.priorityDemandKinds)
      ? [...candidate.priorityDemandKinds]
      : [],
    priorityDemandClasses: getPriorityDemandClasses(candidate),
    priorityDemandUnitsByClass:
      candidate.priorityDemandUnitsByClass &&
      typeof candidate.priorityDemandUnitsByClass === "object"
        ? { ...candidate.priorityDemandUnitsByClass }
        : {},
    replacementPriorityUnits: getReplacementPriorityUnits(candidate),
    priorityItemKinds: Array.isArray(candidate.priorityItemKinds)
      ? [...candidate.priorityItemKinds]
      : [],
    oldestPriorityDemandAtMs: toPositiveInt(
      candidate.oldestPriorityDemandAtMs,
      0,
    ),
    sourceHubTier: candidate.sourceHubTier,
    destinationHubTier: candidate.destinationHubTier,
    unitPriceAnchor: candidate.good.priceAnchor,
    estimatedValue: roundPrice(candidate.good.priceAnchor * candidate.quantity),
    purchaseUnitPrice,
    purchaseValue: roundMoney(purchaseUnitPrice * candidate.quantity),
    sourceQuantityBefore: toPositiveInt(sourceRow.quantity, 0),
    createdAtMs: nowMs,
    lastUpdatedAtMs: nowMs,
    reservationAttempts: 0,
    sourceReservationStatus: "pending",
    deliveryAttempts: 0,
  };
  runtimeState.jobs[jobID] = job;
  flight.freightJobID = jobID;
  markLivingStateDirty(flight);
  addEvent("job_created", job, {
    sourceStationID: job.sourceStationID,
    destinationStationID: job.destinationStationID,
  }, nowMs);
  if (!persistState(nowMs, { durable: Boolean(job.estateDelivery) })) {
    completeJob(job, flight, "cancelled", nowMs, { reason: "job-persistence-failed" });
    runtimeState.metrics.jobsCancelled += 1;
    return false;
  }

  if (job.estateDelivery) {
    const reservation = getFamilyEstateProjectsRuntime().reserveFamilyEstateNpcDelivery({
      reservationID: job.jobID,
      jobID: job.jobID,
      projectKey: job.estateDelivery.projectKey,
      typeID: job.typeID,
      quantity: job.quantity,
      sourceStationID: job.sourceStationID,
      destinationStructureID: job.destinationStationID,
      assignedFlightID: job.assignedFlightID,
      goodsISK: job.purchaseValue,
    }, nowMs);
    if (!reservation.success) {
      job.estateDeliveryError = reservation.errorMsg || "ESTATE_RESERVATION_FAILED";
      if (reservation.uncertain === true) {
        persistState(nowMs, { durable: true });
        return false;
      }
      completeJob(job, flight, "cancelled", nowMs, {
        reason: "estate-reservation-failed",
      });
      closeEstateDeliveryForJob(job, "cancelled", "estate-reservation-failed", nowMs);
      runtimeState.metrics.jobsCancelled += 1;
      persistState(nowMs, { durable: true });
      return false;
    }
    job.estateReservationConfirmedAtMs = nowMs;
  }

  const result = await adjustStock({
    adjustmentID: `${job.jobID}:reserve`,
    station: candidate.sourceStation,
    good: candidate.good,
    deltaQuantity: -candidate.quantity,
    reason: `living freight reservation ${job.jobID}`,
    stockMap,
    workBudget,
  });
  job.reservationAttempts += 1;
  if (!result.success) {
    if (result.retryable === false) {
      completeJob(job, flight, "cancelled", nowMs, { reason: "reservation-failed" });
      closeEstateDeliveryForJob(job, "cancelled", "source-stock-reservation-failed", nowMs);
      runtimeState.metrics.jobsCancelled += 1;
    }
    persistState(nowMs);
    return false;
  }

  job.sourceReservationStatus = "applied";
  job.status = "in_transit";
  job.reservedAtMs = nowMs;
  job.lastUpdatedAtMs = nowMs;
  flight.nextTransitionAtMs = Math.min(
    toFiniteNumber(flight.nextTransitionAtMs, nowMs + 5_000),
    nowMs + 5_000,
  );
  runtimeState.metrics.jobsCreated += 1;
  runtimeState.metrics.unitsReserved += candidate.quantity;
  recordFreightAssignmentClass(job, nowMs);
  recordCargoReservation(job, nowMs);
  recordTraderPurchase(job, nowMs);
  addEvent("cargo_reserved", job, {
    quantity: job.quantity,
    typeID: job.typeID,
  }, nowMs);
  markLivingStateDirty(flight);
  persistState(nowMs);
  return true;
}

async function recoverReservingJobs(livingState, stockMap, nowMs, workBudget = null) {
  const jobs = Object.values(runtimeState.jobs).filter((job) => job.status === "reserving");
  for (const job of jobs) {
    if (workBudget && typeof workBudget.checkpoint === "function") {
      await workBudget.checkpoint();
    }
    const flight = getFlightByID(livingState, job.assignedFlightID);
    const station = catalog.getStation(job.sourceStationID);
    const good = catalog.getGood(job.typeID);
    if (!station || !good) {
      job.reservationRecoveryError = "SOURCE_CATALOG_ENTRY_MISSING";
      continue;
    }
    const sourceRow = getStockRow(stockMap, station.stationID, good.typeID);
    if (toFiniteNumber(job.purchaseValue, 0) <= 0) {
      job.purchaseUnitPrice = roundPrice(sourceRow.price || good.priceAnchor);
      job.purchaseValue = roundMoney(
        job.purchaseUnitPrice * toPositiveInt(job.quantity, 0),
      );
      job.sourceQuantityBefore = toPositiveInt(sourceRow.quantity, 0);
    }
    if (job.estateDelivery) {
      const reservation = getFamilyEstateProjectsRuntime().reserveFamilyEstateNpcDelivery({
        reservationID: job.jobID,
        jobID: job.jobID,
        projectKey: job.estateDelivery.projectKey,
        typeID: job.typeID,
        quantity: job.quantity,
        sourceStationID: job.sourceStationID,
        destinationStructureID: job.destinationStationID,
        assignedFlightID: job.assignedFlightID,
        goodsISK: job.purchaseValue,
      }, nowMs);
      if (!reservation.success) {
        job.estateDeliveryError = reservation.errorMsg ||
          "ESTATE_RESERVATION_RECOVERY_FAILED";
        if (reservation.uncertain !== true) {
          completeJob(job, flight, "cancelled", nowMs, {
            reason: "estate-reservation-recovery-failed",
          });
          closeEstateDeliveryForJob(
            job,
            "cancelled",
            "estate-reservation-recovery-failed",
            nowMs,
          );
          runtimeState.metrics.jobsCancelled += 1;
        }
        continue;
      }
      job.estateReservationConfirmedAtMs = nowMs;
    }
    if (!flight) {
      const ensuredReserve = await adjustStock({
        adjustmentID: `${job.jobID}:reserve`,
        station,
        good,
        deltaQuantity: -toPositiveInt(job.quantity, 0),
        reason: `living freight orphan reserve reconciliation ${job.jobID}`,
        stockMap,
        workBudget,
      });
      if (!ensuredReserve.success) {
        job.reservationRecoveryError = "ORPHAN_RESERVE_RECONCILIATION_FAILED";
        if (ensuredReserve.retryable === false) {
          job.sourceReservationStatus = "not_applied";
          const close = closeEstateDeliveryForJob(
            job,
            "cancelled",
            "orphan-source-stock-unavailable",
            nowMs,
          );
          if (close.success) {
            completeJob(job, null, "cancelled", nowMs, {
              reason: "orphan-source-stock-unavailable",
            });
            runtimeState.metrics.jobsCancelled += 1;
          }
        }
        continue;
      }
      job.sourceReservationStatus = "applied";
      const refunded = await adjustStock({
        adjustmentID: `${job.jobID}:reservation-refund`,
        station,
        good,
        deltaQuantity: toPositiveInt(job.quantity, 0),
        reason: `living freight orphan refund ${job.jobID}`,
        stockMap,
        workBudget,
      });
      if (!refunded.success) {
        job.sourceReservationStatus = "refund_pending";
        job.reservationRecoveryError = "ORPHAN_REFUND_FAILED";
        continue;
      }
      job.sourceReservationStatus = "refunded";
      const close = closeEstateDeliveryForJob(
        job,
        "cancelled",
        "orphan-reservation",
        nowMs,
      );
      if (!close.success) continue;
      completeJob(job, null, "cancelled", nowMs, { reason: "orphan-reservation" });
      runtimeState.metrics.jobsCancelled += 1;
      continue;
    }
    if (
      job.routeSpec &&
      (
        String(flight.routeID || "") !== String(job.routeSpec.routeID || "") ||
        !flight.dynamicRouteSpec
      )
    ) {
      const assigned = typeof lastAssignFreightRoute === "function" &&
        lastAssignFreightRoute(flight, job.routeSpec, nowMs, {
          preserveProgress: true,
        });
      if (!assigned) {
        job.routeRecoveryError = "ESTATE_ROUTE_RECOVERY_DEFERRED";
        continue;
      }
      job.routeRecoveryError = null;
    }
    flight.freightJobID = job.jobID;
    const result = await adjustStock({
      adjustmentID: `${job.jobID}:reserve`,
      station,
      good,
      deltaQuantity: -toPositiveInt(job.quantity, 0),
      reason: `living freight reservation recovery ${job.jobID}`,
      stockMap,
      workBudget,
    });
    job.reservationAttempts = toPositiveInt(job.reservationAttempts, 0) + 1;
    if (result.success) {
      job.sourceReservationStatus = "applied";
      job.status = "in_transit";
      job.reservedAtMs = nowMs;
      job.lastUpdatedAtMs = nowMs;
      runtimeState.metrics.jobsCreated += 1;
      runtimeState.metrics.unitsReserved += toPositiveInt(job.quantity, 0);
      recordFreightAssignmentClass(job, nowMs);
      recordCargoReservation(job, nowMs);
      recordTraderPurchase(job, nowMs);
      flight.nextTransitionAtMs = Math.min(
        toFiniteNumber(flight.nextTransitionAtMs, nowMs + 5_000),
        nowMs + 5_000,
      );
      markLivingStateDirty(flight);
    } else if (result.retryable === false) {
      completeJob(job, flight, "cancelled", nowMs, { reason: "reservation-recovery-failed" });
      closeEstateDeliveryForJob(
        job,
        "cancelled",
        "source-stock-reservation-recovery-failed",
        nowMs,
      );
      runtimeState.metrics.jobsCancelled += 1;
    }
  }
}

async function getRegionalOpportunities(stockMap, nowMs, workBudget) {
  if (config.livingEconomyRegionalRoutingEnabled !== true) return [];
  if (
    routePlanningRuntime.opportunities.length > 0 &&
    nowMs - routePlanningRuntime.lastBuiltAtMs < getRoutePlanningIntervalMs()
  ) {
    return routePlanningRuntime.opportunities;
  }
  const startedAtMs = performance.now();
  const regionalOpportunities = await routePlanner.buildRegionalOpportunities(
    stockMap,
    getStockRow,
    procurement.listOpenOrders(runtimeState),
    listReplacementRequirements(),
    { workBudget },
  );
  let estateOpportunities = [];
  if (config.familyEstateLogisticsEnabled === true) {
    try {
      estateOpportunities = await getFamilyEstateProjectsRuntime()
        .buildFamilyEstateFreightOpportunities(
          stockMap,
          getStockRow,
          nowMs,
          { workBudget },
        );
    } catch (error) {
      log.warn(`[LivingEconomy] Estate freight planning failed: ${error.message}`);
    }
  }
  routePlanningRuntime.opportunities = [
    ...estateOpportunities,
    ...regionalOpportunities,
  ].sort((left, right) => toFiniteNumber(right.score, 0) - toFiniteNumber(left.score, 0));
  routePlanningRuntime.lastBuiltAtMs = nowMs;
  routePlanningRuntime.lastDurationMs = Math.max(0, performance.now() - startedAtMs);
  routePlanningRuntime.maximumDurationMs = Math.max(
    routePlanningRuntime.maximumDurationMs,
    routePlanningRuntime.lastDurationMs,
  );
  routePlanningRuntime.builds += 1;
  return routePlanningRuntime.opportunities;
}

async function createJobs(livingState, stockMap, nowMs, workBudget) {
  const maximumActiveJobs = getMaxActiveJobs();
  let remainingCapacity = Math.max(0, maximumActiveJobs - getActiveJobCount());
  let jobsThisPulse = 0;
  routePlanningRuntime.repositionsAssignedLastPulse = 0;
  if (remainingCapacity <= 0) {
    return;
  }
  const idleFlights = getFlights(livingState)
    .filter((flight) => {
      const family = String(flight.family || "");
      return (
        (family === "hauler" || family === "convoy") &&
        String(flight.phase || "") === "docked" &&
        !String(flight.freightJobID || "").trim() &&
        (flight.dynamicRouteSpec || catalog.getRoute(flight.routeID))
      );
    })
    .sort((left, right) => String(left.flightID).localeCompare(String(right.flightID)));

  const regionalOpportunities = await getRegionalOpportunities(
    stockMap,
    nowMs,
    workBudget,
  );
  const opportunitiesBySource = new Map();
  for (const opportunity of regionalOpportunities) {
    const sourceStationID = toPositiveInt(
      opportunity && opportunity.sourceStation &&
        opportunity.sourceStation.stationID,
      0,
    );
    if (!sourceStationID) continue;
    if (!opportunitiesBySource.has(sourceStationID)) {
      opportunitiesBySource.set(sourceStationID, []);
    }
    opportunitiesBySource.get(sourceStationID).push(opportunity);
  }

  const availableFlights = [];
  for (const flight of idleFlights) {
    if (workBudget && typeof workBudget.checkpoint === "function") {
      await workBudget.checkpoint();
    }
    const sourceStationID = getDockedStationID(flight);
    const reposition = getFreightReposition(flight);
    if (reposition) {
      if (
        Number(reposition.targetStationID) === Number(sourceStationID)
      ) {
        settleFreightRepositionAtStation(flight, sourceStationID, nowMs);
      } else {
        // The existing flight scheduler owns this empty trip. Do not replace
        // its route or reserve cargo while it is still at the departure dock.
        continue;
      }
    }
    availableFlights.push(flight);
  }

  const replacementOpportunities = regionalOpportunities.filter(
    (opportunity) => isReplacementPriority(opportunity),
  );
  const replacementDemandWaiting = replacementOpportunities.length > 0;
  let priorityProtectedByKey = null;
  const getPriorityProtectedByKey = () => {
    if (!priorityProtectedByKey) {
      priorityProtectedByKey = buildPriorityProtectedStockByKey();
    }
    return priorityProtectedByKey;
  };
  const replacementShare = getReplacementFreightShare();
  const activeJobs = Object.values(runtimeState.jobs || {}).filter(isActiveJob);
  let activeReplacementJobs = activeJobs.filter(isReplacementPriority).length;
  let activeGeneralJobs = activeJobs.length - activeReplacementJobs;
  const maximumGeneralActiveJobs = replacementDemandWaiting
    ? Math.max(0, maximumActiveJobs - Math.ceil(maximumActiveJobs * replacementShare))
    : maximumActiveJobs;
  const assignedFlightIDs = new Set();

  const applyReservedQuantity = async (candidate) => {
    const replacementUnits = getReplacementPriorityUnits(candidate);
    if (candidate.sourceAvailable !== undefined) {
      candidate.sourceAvailable = Math.max(
        0,
        candidate.sourceAvailable - candidate.quantity,
      );
    }
    if (candidate.destinationNeeded !== undefined) {
      candidate.destinationNeeded = Math.max(
        0,
        candidate.destinationNeeded - candidate.quantity,
      );
    }
    for (const opportunity of regionalOpportunities) {
      const sameType =
        Number(opportunity.good.typeID) === Number(candidate.good.typeID);
      if (
        sameType &&
        Number(opportunity.sourceStation.stationID) ===
          Number(candidate.sourceStation.stationID)
      ) {
        opportunity.sourceAvailable = Math.max(
          0,
          opportunity.sourceAvailable - candidate.quantity,
        );
      }
      if (
        sameType &&
        Number(opportunity.destinationStation.stationID) ===
          Number(candidate.destinationStation.stationID)
      ) {
        opportunity.destinationNeeded = Math.max(
          0,
          opportunity.destinationNeeded - candidate.quantity,
        );
        if (replacementUnits > 0) {
          opportunity.priorityDemandUnits = Math.max(
            0,
            toPositiveInt(opportunity.priorityDemandUnits, 0) -
              replacementUnits,
          );
          if (
            opportunity.priorityDemandUnitsByClass &&
            typeof opportunity.priorityDemandUnitsByClass === "object"
          ) {
            opportunity.priorityDemandUnitsByClass.replacement = Math.max(
              0,
              toPositiveInt(
                opportunity.priorityDemandUnitsByClass.replacement,
                0,
              ) - replacementUnits,
            );
          }
        }
      }
      if (workBudget && typeof workBudget.checkpoint === "function") {
        await workBudget.checkpoint();
      }
    }
  };

  const tryReserveForFlight = async (
    flight,
    replacementOnly,
    allowAuthoredFallback,
  ) => {
    const sourceStationID = getDockedStationID(flight);
    const sourceOpportunities =
      opportunitiesBySource.get(Number(sourceStationID)) || [];
    const filteredOpportunities = sourceOpportunities.filter(
      (opportunity) =>
        isReplacementPriority(opportunity) === replacementOnly,
    );
    let candidate = routePlanner.chooseForFlight(
      flight,
      sourceStationID,
      filteredOpportunities,
      getFlightLogisticsProfile(flight),
    );
    if (candidate && typeof lastAssignFreightRoute === "function") {
      const assigned = lastAssignFreightRoute(
        flight,
        candidate.routeSpec,
        nowMs,
      );
      if (!assigned) {
        candidate = null;
      } else {
        runtimeState.metrics.dynamicRoutesAssigned += 1;
      }
    } else if (candidate) {
      candidate = null;
    }
    if (!candidate && allowAuthoredFallback) {
      candidate = findFreightCandidate(
        flight,
        stockMap,
        getPriorityProtectedByKey(),
      );
    }
    if (!candidate) return false;
    if (
      replacementOnly !== isReplacementPriority(candidate) ||
      !await reserveJob(
        livingState,
        flight,
        candidate,
        stockMap,
        nowMs,
        workBudget,
      )
    ) {
      return false;
    }
    await applyReservedQuantity(candidate);
    assignedFlightIDs.add(String(flight.flightID));
    remainingCapacity -= 1;
    jobsThisPulse += 1;
    if (replacementOnly) {
      activeReplacementJobs += 1;
    } else {
      activeGeneralJobs += 1;
    }
    return true;
  };

  const runFreightPass = async (replacementOnly, targetAssignments) => {
    let assigned = 0;
    if (targetAssignments <= 0) return assigned;
    for (const flight of availableFlights) {
      if (
        assigned >= targetAssignments ||
        remainingCapacity <= 0 ||
        jobsThisPulse >= getMaxJobsPerPulse()
      ) {
        break;
      }
      if (assignedFlightIDs.has(String(flight.flightID))) continue;
      if (
        !replacementOnly &&
        replacementDemandWaiting &&
        activeGeneralJobs >= maximumGeneralActiveJobs
      ) {
        break;
      }
      if (workBudget && typeof workBudget.checkpoint === "function") {
        await workBudget.checkpoint();
      }
      if (await tryReserveForFlight(
        flight,
        replacementOnly,
        !replacementOnly,
      )) {
        assigned += 1;
      }
    }
    return assigned;
  };

  const maximumNewJobs = Math.min(
    remainingCapacity,
    getMaxJobsPerPulse(),
    availableFlights.length,
  );
  const replacementTarget = replacementDemandWaiting
    ? Math.min(
        maximumNewJobs,
        Math.ceil(maximumNewJobs * replacementShare),
      )
    : 0;
  const generalTarget = maximumNewJobs - replacementTarget;
  await runFreightPass(true, replacementTarget);
  await runFreightPass(false, generalTarget);
  await runFreightPass(true, maximumNewJobs - jobsThisPulse);
  await runFreightPass(false, maximumNewJobs - jobsThisPulse);

  // Cap-saturation observability (W1): record pulses where the per-pulse
  // freight reservation budget was exhausted — the signal that tells the next
  // tuning round WHICH cap binds instead of guessing.
  if (jobsThisPulse >= getMaxJobsPerPulse()) {
    runtimeState.metrics.freightJobCapSaturatedPulses =
      toPositiveInt(runtimeState.metrics.freightJobCapSaturatedPulses, 0) + 1;
  }

  const unassignedFlights = availableFlights.filter(
    (flight) => !assignedFlightIDs.has(String(flight.flightID)),
  );

  // Repositioning has its own pulse allowance. A busy freight-reservation
  // pulse must not suppress empty haulers that are needed at replacement
  // factories or stock sources.
  if (
    remainingCapacity <= 0 ||
    getMaxActiveRepositions() <= 0 ||
    getMaxRepositionsPerPulse() <= 0
  ) {
    return;
  }

  // Empty relocation is a second pass: all docked haulers first get a chance
  // to carry cargo where they already are. A relocation creates no freight
  // job and touches no market stock; the source is revalidated after arrival.
  const activeRepositions = getActiveFreightRepositions(livingState);
  const softCapacity = Math.max(
    0,
    getMaxActiveJobs() - getActiveJobCount() - activeRepositions.length,
  );
  const maximumRepositionSlots = Math.min(
    getMaxRepositionsPerPulse(),
    Math.max(0, getMaxActiveRepositions() - activeRepositions.length),
    softCapacity,
  );
  if (maximumRepositionSlots <= 0) return;
  const sourceCounts = new Map();
  for (const { marker } of activeRepositions) {
    const targetStationID = toPositiveInt(marker.targetStationID, 0);
    if (!targetStationID) continue;
    sourceCounts.set(
      targetStationID,
      toPositiveInt(sourceCounts.get(targetStationID), 0) + 1,
    );
  }

  let activeReplacementRepositions = activeRepositions.filter(
    ({ marker }) => marker.replacementPriority === true,
  ).length;
  let activeGeneralRepositions =
    activeRepositions.length - activeReplacementRepositions;
  const maximumGeneralActiveRepositions = replacementDemandWaiting
    ? Math.max(
        0,
        getMaxActiveRepositions() -
          Math.ceil(getMaxActiveRepositions() * replacementShare),
      )
    : getMaxActiveRepositions();
  const repositionedFlightIDs = new Set();
  let repositionsThisPulse = 0;

  const runRepositionPass = async (replacementOnly, targetAssignments) => {
    let assigned = 0;
    const opportunities = regionalOpportunities.filter(
      (opportunity) =>
        isReplacementPriority(opportunity) === replacementOnly,
    );
    if (targetAssignments <= 0 || opportunities.length <= 0) return assigned;
    for (const flight of unassignedFlights) {
      if (
        assigned >= targetAssignments ||
        repositionsThisPulse >= maximumRepositionSlots
      ) {
        break;
      }
      if (
        assignedFlightIDs.has(String(flight.flightID)) ||
        repositionedFlightIDs.has(String(flight.flightID)) ||
        toFiniteNumber(flight.freightRepositionCooldownUntilMs, 0) > nowMs
      ) {
        continue;
      }
      if (
        !replacementOnly &&
        replacementDemandWaiting &&
        activeGeneralRepositions >= maximumGeneralActiveRepositions
      ) {
        break;
      }
      if (workBudget && typeof workBudget.checkpoint === "function") {
        await workBudget.checkpoint();
      }
      const sourceStationID = getDockedStationID(flight);
      const candidate = routePlanner.chooseRepositionForFlight(
        flight,
        sourceStationID,
        opportunities,
        getFlightLogisticsProfile(flight),
        {
          sourceCounts,
          maximumAtSource: replacementOnly
            ? getReplacementRepositionMaxPerSource()
            : FREIGHT_REPOSITION_MAX_PER_SOURCE,
          maximumJumps: replacementOnly
            ? REPLACEMENT_REPOSITION_MAX_JUMPS
            : FREIGHT_REPOSITION_MAX_JUMPS,
          maximumOpportunities: replacementOnly
            ? REPLACEMENT_REPOSITION_MAX_OPPORTUNITIES
            : FREIGHT_REPOSITION_MAX_OPPORTUNITIES,
        },
      );
      if (!candidate || !startFreightReposition(flight, candidate, nowMs)) {
        continue;
      }
      const targetStationID = Number(candidate.sourceStation.stationID);
      sourceCounts.set(
        targetStationID,
        toPositiveInt(sourceCounts.get(targetStationID), 0) + 1,
      );
      routePlanningRuntime.repositionsAssignedLastPulse += 1;
      repositionsThisPulse += 1;
      assigned += 1;
      repositionedFlightIDs.add(String(flight.flightID));
      if (replacementOnly) {
        activeReplacementRepositions += 1;
      } else {
        activeGeneralRepositions += 1;
      }
    }
    return assigned;
  };

  const replacementRepositionTarget = replacementDemandWaiting
    ? Math.min(
        maximumRepositionSlots,
        Math.ceil(maximumRepositionSlots * replacementShare),
      )
    : 0;
  const generalRepositionTarget =
    maximumRepositionSlots - replacementRepositionTarget;
  await runRepositionPass(true, replacementRepositionTarget);
  await runRepositionPass(false, generalRepositionTarget);
  await runRepositionPass(
    true,
    maximumRepositionSlots - repositionsThisPulse,
  );
  await runRepositionPass(
    false,
    maximumRepositionSlots - repositionsThisPulse,
  );
}

function takeNextPlanningShard() {
  if (REGIONAL_STOCK_SHARDS.length <= 0) {
    return {
      regionID: null,
      regionName: "All regions",
      stations: catalog.STATIONS,
    };
  }
  const index = routePlanningRuntime.planningRegionIndex % REGIONAL_STOCK_SHARDS.length;
  const shard = REGIONAL_STOCK_SHARDS[index];
  routePlanningRuntime.planningRegionIndex = (index + 1) % REGIONAL_STOCK_SHARDS.length;
  routePlanningRuntime.lastPlanningRegionID = shard.regionID;
  return shard;
}

async function runProduction(stockMap, nowMs, planningShard, workBudget) {
  return industry.process(runtimeState, stockMap, {
    getStockRow,
    adjustStock: (details) => adjustStock({ ...details, workBudget }),
    adjustStocks: (details) => adjustStocks(details, workBudget),
    addEvent,
    stations: planningShard && planningShard.stations,
    priorityRequirements: listReplacementRequirements(),
    workBudget,
  }, nowMs);
}

async function repriceShortages(stockMap, nowMs, planningShard, workBudget) {
  let reprices = 0;
  if (getMaxRepricesPerPulse() <= 0) {
    return;
  }
  const candidates = [];
  const stations = planningShard && Array.isArray(planningShard.stations)
    ? planningShard.stations
    : catalog.STATIONS;
  let scannedRows = 0;
  for (const station of stations) {
    for (const good of catalog.GOODS) {
      scannedRows += 1;
      if (
        workBudget &&
        typeof workBudget.checkpoint === "function" &&
        scannedRows % 128 === 0
      ) {
        await workBudget.checkpoint();
      }
      const target = catalog.getTargetQuantity(station, good);
      if (target <= 0) {
        continue;
      }
      const row = getStockRow(stockMap, station.stationID, good.typeID);
      const desiredPrice = computePrice(good, station, row.quantity);
      const currentPrice = toFiniteNumber(row.price, 0);
      const changeRatio = currentPrice > 0
        ? Math.abs(desiredPrice - currentPrice) / currentPrice
        : 1;
      if (changeRatio < 0.03) {
        continue;
      }
      candidates.push({ station, good, row, desiredPrice, changeRatio });
    }
  }
  candidates.sort((left, right) => right.changeRatio - left.changeRatio);
  for (const candidate of candidates) {
    if (reprices >= getMaxRepricesPerPulse()) {
      break;
    }
    if (workBudget && typeof workBudget.checkpoint === "function") {
      await workBudget.checkpoint();
    }
    const quantity = toPositiveInt(candidate.row.quantity, 0);
    const result = await adjustStock({
      adjustmentID:
        `living-reprice:${toPositiveInt(runtimeState.createdAtMs, 0)}:` +
        `${candidate.station.stationID}:${candidate.good.typeID}:${quantity}:${candidate.desiredPrice}`,
      station: candidate.station,
      good: candidate.good,
      deltaQuantity: 0,
      reason: "living economy stock-sensitive reprice",
      stockMap,
      workBudget,
    });
    if (result.success) {
      runtimeState.metrics.reprices += 1;
      reprices += 1;
    }
  }
}

async function pruneCollection(collection, shouldDelete, workBudget) {
  let scanned = 0;
  for (const key in collection) {
    if (!Object.prototype.hasOwnProperty.call(collection, key)) continue;
    scanned += 1;
    if (workBudget && scanned % 128 === 0) await workBudget.checkpoint();
    if (shouldDelete(collection[key])) delete collection[key];
  }
}

async function reconcileEstateDeliveryReceipts(
  livingState,
  stockMap,
  nowMs,
  workBudget = null,
) {
  if (config.familyEstateLogisticsEnabled !== true) return;
  const estateRuntime = getFamilyEstateProjectsRuntime();
  const permanentSettlementErrors = new Set([
    "FAMILY_ESTATE_DELIVERY_DESTINATION_UNAVAILABLE",
    "FAMILY_ESTATE_DELIVERY_IDENTITY_MISMATCH",
    "FAMILY_ESTATE_DELIVERY_RESERVATION_INVARIANT",
  ]);

  for (const job of Object.values(runtimeState.jobs)) {
    if (workBudget) await workBudget.checkpoint();
    if (!job || !job.estateDelivery) continue;
    let receipt = null;
    try {
      receipt = estateRuntime.getFamilyEstateNpcDelivery(job.jobID, nowMs);
    } catch (error) {
      job.estateDeliveryError = error.message;
      continue;
    }
    if (receipt && receipt.status === "delivered") {
      if (
        String(job.status || "") === "delivered" &&
        job.estateCloseConfirmedAtMs
      ) {
        continue;
      }
      const settlement = estateRuntime.settleFamilyEstateNpcDelivery(
        job.jobID,
        nowMs,
      );
      if (settlement && settlement.success) {
        finalizeEstateDeliveryJob(job, livingState, settlement, nowMs);
        job.recoveredSettlementAtMs = job.recoveredSettlementAtMs || nowMs;
      }
      continue;
    }
    if (receipt && ["lost", "cancelled"].includes(receipt.status)) {
      finalizeEstateTerminalJob(
        job,
        livingState,
        receipt.status,
        receipt.lastError || "estate-terminal-receipt-reconciled",
        nowMs,
      );
      continue;
    }
    if (receipt && isActiveJob(job)) {
      const destination = estateRuntime.validateFamilyEstateNpcDeliveryDestination(
        job.jobID,
        nowMs,
      );
      if (!destination.success && permanentSettlementErrors.has(destination.errorMsg)) {
        const quarantine = estateRuntime.quarantineFamilyEstateNpcDelivery(
          job.jobID,
          destination.errorMsg,
          nowMs,
        );
        if (quarantine && quarantine.success) {
          finalizeEstateTerminalJob(
            job,
            livingState,
            "cancelled",
            `quarantined:${destination.errorMsg}`,
            nowMs,
          );
        }
        continue;
      }
    }
    if (
      receipt &&
      isActiveJob(job) &&
      (!catalog.getStation(job.sourceStationID) || !catalog.getGood(job.typeID))
    ) {
      const quarantine = estateRuntime.quarantineFamilyEstateNpcDelivery(
        job.jobID,
        "source-catalog-entry-missing",
        nowMs,
      );
      if (quarantine && quarantine.success) {
        finalizeEstateTerminalJob(
          job,
          livingState,
          "cancelled",
          "source-catalog-entry-missing",
          nowMs,
        );
      }
      continue;
    }
    if (
      receipt &&
      ACTIVE_JOB_STATES.has(String(job.status || "")) &&
      receipt.escrowStatus !== "escrowed"
    ) {
      const escrow = estateRuntime.ensureFamilyEstateDeliveryEscrow(
        receipt.projectKey,
        receipt.reservationID,
        nowMs,
      );
      if (!escrow || escrow.success !== true) {
        job.estateDeliveryError = escrow && escrow.errorMsg ||
          "ESTATE_ESCROW_RECOVERY_FAILED";
        continue;
      }
      receipt = estateRuntime.getFamilyEstateNpcDelivery(job.jobID, nowMs);
      job.estateReservationConfirmedAtMs = job.estateReservationConfirmedAtMs || nowMs;
    }
    if (
      !job.estateCloseConfirmedAtMs &&
      ["lost", "cancelled"].includes(String(job.status || ""))
    ) {
      closeEstateDeliveryForJob(
        job,
        job.status,
        job.failureReason || "terminal-job-reconciliation",
        nowMs,
      );
    }
  }

  let activeReservations = [];
  try {
    activeReservations = estateRuntime.listActiveFamilyEstateNpcDeliveries(nowMs);
  } catch (error) {
    log.warn(`[LivingEconomy] Estate reservation reconciliation failed: ${error.message}`);
    return;
  }
  for (const reservation of activeReservations) {
    if (workBudget) await workBudget.checkpoint();
    const matchingJob = runtimeState.jobs[
      reservation.jobID || reservation.reservationID
    ] || null;
    const destination = estateRuntime.validateFamilyEstateNpcDeliveryDestination(
      reservation.reservationID,
      nowMs,
    );
    if (!destination.success && permanentSettlementErrors.has(destination.errorMsg)) {
      const quarantine = estateRuntime.quarantineFamilyEstateNpcDelivery(
        reservation.reservationID,
        destination.errorMsg,
        nowMs,
      );
      if (quarantine && quarantine.success && matchingJob) {
        finalizeEstateTerminalJob(
          matchingJob,
          livingState,
          "cancelled",
          `quarantined:${destination.errorMsg}`,
          nowMs,
        );
      }
      continue;
    }
    if (reservation.escrowStatus !== "escrowed") {
      const escrow = estateRuntime.ensureFamilyEstateDeliveryEscrow(
        reservation.projectKey,
        reservation.reservationID,
        nowMs,
      );
      if (!escrow || escrow.success !== true) {
        if (matchingJob) {
          matchingJob.estateDeliveryError = escrow && escrow.errorMsg ||
            "ESTATE_ESCROW_RECOVERY_FAILED";
        }
        continue;
      }
    }
    if (reservation.status === "delivery_pending") {
      const settlement = estateRuntime.settleFamilyEstateNpcDelivery(
        reservation.reservationID,
        nowMs,
      );
      if (settlement && settlement.success) {
        if (matchingJob) {
          finalizeEstateDeliveryJob(matchingJob, livingState, settlement, nowMs);
          matchingJob.recoveredSettlementAtMs = matchingJob.recoveredSettlementAtMs || nowMs;
        }
      } else if (
        settlement &&
        permanentSettlementErrors.has(settlement.errorMsg)
      ) {
        const quarantine = estateRuntime.quarantineFamilyEstateNpcDelivery(
          reservation.reservationID,
          settlement.errorMsg,
          nowMs,
        );
        if (quarantine && quarantine.success && matchingJob) {
          finalizeEstateTerminalJob(
            matchingJob,
            livingState,
            "cancelled",
            `quarantined:${settlement.errorMsg}`,
            nowMs,
          );
        }
      }
      continue;
    }
    if (matchingJob) continue;
    const station = catalog.getStation(reservation.sourceStationID);
    const good = catalog.getGood(reservation.typeID);
    if (!station || !good) {
      estateRuntime.quarantineFamilyEstateNpcDelivery(
        reservation.reservationID,
        "source-catalog-entry-missing",
        nowMs,
      );
      continue;
    }
    const ensuredReserve = await adjustStock({
      adjustmentID: `${reservation.reservationID}:reserve`,
      station,
      good,
      deltaQuantity: -toPositiveInt(reservation.quantity, 0),
      reason: `orphan estate freight reserve reconciliation ${reservation.reservationID}`,
      stockMap,
      workBudget,
    });
    if (!ensuredReserve.success) {
      if (ensuredReserve.retryable === false) {
        estateRuntime.quarantineFamilyEstateNpcDelivery(
          reservation.reservationID,
          "orphan-source-stock-unavailable",
          nowMs,
        );
      }
      continue;
    }
    const refunded = await adjustStock({
      adjustmentID: `${reservation.reservationID}:reservation-refund`,
      station,
      good,
      deltaQuantity: toPositiveInt(reservation.quantity, 0),
      reason: `orphan estate freight refund ${reservation.reservationID}`,
      stockMap,
      workBudget,
    });
    if (!refunded.success) continue;
    estateRuntime.closeFamilyEstateNpcDelivery(
      reservation.reservationID,
      "cancelled",
      "orphan-estate-reservation-reconciled",
      nowMs,
    );
  }
}

async function pruneOldState(nowMs, workBudget = null) {
  const dayMs = 24 * 60 * 60 * 1_000;
  const deliveredMiningRetentionMs = config.xEveEnabled === true
    ? 2 * 60 * 60 * 1_000
    : dayMs;
  await pruneCollection(runtimeState.jobs, (job) => (
    !isActiveJob(job) &&
    !isUnresolvedEstateJob(job) &&
    toFiniteNumber(job && job.completedAtMs, nowMs) < nowMs - (7 * dayMs)
  ), workBudget);
  await pruneCollection(runtimeState.miningDeposits, (deposit) => (
    String(deposit && deposit.status || "") === "delivered" &&
    toFiniteNumber(deposit && deposit.deliveredAtMs, nowMs) <
      nowMs - deliveredMiningRetentionMs
  ), workBudget);
  await pruneCollection(runtimeState.industryJobs, (job) => (
    String(job && job.status || "") === "completed" &&
    toFiniteNumber(job && job.completedAtMs, nowMs) < nowMs - (7 * dayMs)
  ), workBudget);
  await pruneCollection(runtimeState.replacementDemands, (demand) => (
    String(demand && demand.status || "") === "fulfilled" &&
    toFiniteNumber(demand && demand.fulfilledAtMs, nowMs) < nowMs - (7 * dayMs)
  ), workBudget);
  await pruneCollection(runtimeState.campaignDemands, (demand) => (
    String(demand && demand.status || "") === "fulfilled" &&
    toFiniteNumber(demand && demand.fulfilledAtMs, nowMs) < nowMs - (7 * dayMs)
  ), workBudget);
}

async function runPulse(livingState, nowMs) {
  assertEventProductionAvailable(nowMs);
  const workBudget = createWorkBudget({ budgetMs: getWorkBudgetMs() });
  const stage = (name, operation) => workBudget.runStage(name, async () => {
    const result = await operation();
    await workBudget.checkpoint();
    return result;
  });
  try {
    await workBudget.checkpoint(true);
    await stage("assignmentReconcile", () => reconcileAssignments(livingState, nowMs));
    const stockMap = await stage("stockRefresh", () => readPilotStock(workBudget, nowMs));
    await stage("freightRouteRecovery", () => recoverStaleFreightJobs(
      livingState, stockMap, nowMs, workBudget,
    ));
    await stage("estateReceiptReconcile", () => reconcileEstateDeliveryReceipts(
      livingState, stockMap, nowMs, workBudget,
    ));
    const planningShard = takeNextPlanningShard();
    await stage("retention", () => pruneOldState(nowMs, workBudget));
    await stage("telemetryCapture", () => telemetry.maybeCaptureCooperative(
      runtimeState, livingState, stockMap, nowMs, workBudget,
    ));
    // War-economy mobilization runs before the supply stages so a level change
    // is reflected by every cap consumed later in this same pulse.
    await stage("mobilization", async () => {
      // Poisoned-row guard: a pending demand that has gone this long without
      // ANY staging progress (station orphaned by a cross-version catalog
      // change, good removed, etc.) must not pin the age signal at full
      // pressure forever — it still counts toward the backlog term (bounded)
      // but stops driving the unbounded age term. Live starvation keeps
      // pressure through the backlog and rate terms regardless.
      const AGE_SIGNAL_STALE_HORIZON_MS = 4 * 60 * 60 * 1000;
      let pendingPackages = 0;
      let oldestPendingAgeMs = 0;
      let scanned = 0;
      for (const demand of Object.values(runtimeState.replacementDemands || {})) {
        scanned += 1;
        if (scanned % 256 === 0) await workBudget.checkpoint();
        if (!demand || demand.status !== "pending") continue;
        pendingPackages += 1;
        const createdAtMs = toFiniteNumber(demand.createdAtMs, nowMs);
        const lastActivityMs = Math.max(
          createdAtMs,
          toFiniteNumber(demand.lastProgressAtMs, 0),
        );
        if (nowMs - lastActivityMs > AGE_SIGNAL_STALE_HORIZON_MS) continue;
        const ageMs = nowMs - createdAtMs;
        if (ageMs > oldestPendingAgeMs) oldestPendingAgeMs = ageMs;
      }
      mobilization.update({
        pendingPackages,
        oldestPendingAgeMs,
        demandsCreatedTotal: toFiniteNumber(
          runtimeState.metrics && runtimeState.metrics.replacementDemandsCreated,
          0,
        ),
        demandsFulfilledTotal: toFiniteNumber(
          runtimeState.metrics && runtimeState.metrics.replacementDemandsFulfilled,
          0,
        ),
      }, nowMs);
    });
    await stage("miningSettlement", () => processPendingMiningDeposits(
      livingState, stockMap, nowMs, workBudget,
    ));
    await stage("salvageRecovery", () => salvageRecovery.process(
      runtimeState,
      stockMap,
      {
        ...lastSalvageRecoveryAdapters,
        getStation: catalog.getStation,
        getGood: catalog.getGood,
        addEvent,
        adjustStock: (details) => adjustStock({ ...details, workBudget }),
        adjustStocks: (details) => adjustStocks(details, workBudget),
        workBudget,
      },
      nowMs,
    ));
    await stage("freightSettlement", () => processPendingDeliveries(
      livingState, stockMap, nowMs, workBudget,
    ));
    await stage("factionShipyard", () => replenishFactionShipyards(
      stockMap, nowMs, workBudget,
    ));
    await stage("replacementDemand", () => processReplacementDemands(
      stockMap, nowMs, workBudget,
    ));
    await stage("campaignDemand", () => processCampaignDemands(stockMap, nowMs, workBudget));
    await stage("demandCoverage", () => demandCoverage.audit(runtimeState, stockMap, {
      getStockRow,
      getRecipe: industry.getRecipe,
      activeJobs: industry.listActiveJobs(runtimeState),
      workBudget,
      // Mobilization-scaled: coverage must pre-plan inputs for as many lines
      // as industry may actually run, or the surge starves at the planner.
      maxParallelHullLines: industry.getMaxParallelHullLines(),
    }, nowMs));
    await stage("reservationRecovery", () => recoverReservingJobs(
      livingState, stockMap, nowMs, workBudget,
    ));
    await stage("industry", () => runProduction(stockMap, nowMs, planningShard, workBudget));
    await stage("procurement", () => procurement.review(
      runtimeState,
      stockMap,
      getStockRow,
      addEvent,
      nowMs,
      {
        regionID: planningShard.regionID,
        stations: planningShard.stations,
        priorityRequirements: listReplacementRequirements(),
        workBudget,
        forceReview: true,
      },
    ));
    await stage("freightPlanning", () => createJobs(livingState, stockMap, nowMs, workBudget));
    await stage("marketReprice", () => repriceShortages(
      stockMap, nowMs, planningShard, workBudget,
    ));
    runtimeState.lastPulseAtMs = nowMs;
    lastStockSnapshot = stockMap;
    lastPulseError = null;
    pulseTiming.consecutivePulseFailures = 0;
    await stage("statePersist", () => persistState(nowMs));
  } finally {
    const report = workBudget.finish();
    pulseTiming.lastWorkBudget = report;
    pulseTiming.cooperativeYields += report.yields;
  }
}

function tick(livingState, nowMs = Date.now(), options = {}) {
  if (config.livingEconomyEnabled !== true) {
    return;
  }
  initialize(nowMs);
  if (typeof options.markLivingStateDirty === "function") {
    lastMarkLivingStateDirty = options.markLivingStateDirty;
  }
  if (typeof options.assignFreightRoute === "function") {
    lastAssignFreightRoute = options.assignFreightRoute;
  }
  if (options.salvageRecoveryAdapters && typeof options.salvageRecoveryAdapters === "object") {
    lastSalvageRecoveryAdapters = options.salvageRecoveryAdapters;
  }
  if (pulsePromise || nowMs - toFiniteNumber(runtimeState.lastPulseAtMs, 0) < getPulseIntervalMs()) {
    return;
  }
  const pulseStartedAtMs = performance.now();
  pulsePromise = runPulse(livingState, nowMs)
    .catch((error) => {
      lastPulseError = error.message;
      // A dying pulse silences the whole supply side (staging, freight
      // settlement/planning, industry, mobilization) while event-driven
      // counters keep moving — make the failure impossible to miss: counted,
      // streaked (the stress sampler tripwires on the streak), and escalated
      // to ERROR once it is clearly not a one-off.
      pulseTiming.pulseFailures = (pulseTiming.pulseFailures || 0) + 1;
      pulseTiming.consecutivePulseFailures =
        (pulseTiming.consecutivePulseFailures || 0) + 1;
      runtimeState.lastPulseAtMs = nowMs;
      persistState(nowMs);
      if (pulseTiming.consecutivePulseFailures >= 4) {
        log.error(
          `[LivingEconomy] Pulse failed ${pulseTiming.consecutivePulseFailures}x ` +
          `in a row — the living economy is STALLED: ${error.stack || error.message}`,
        );
      } else {
        log.warn(`[LivingEconomy] Pulse failed: ${error.stack || error.message}`);
      }
    })
    .finally(() => {
      const durationMs = Math.max(0, performance.now() - pulseStartedAtMs);
      pulseTiming.completedPulses += 1;
      pulseTiming.totalDurationMs += durationMs;
      pulseTiming.lastDurationMs = durationMs;
      pulseTiming.maxDurationMs = Math.max(pulseTiming.maxDurationMs, durationMs);
      pulsePromise = null;
    });
}

function getNextWakeAtMs(nowMs = Date.now()) {
  if (config.livingEconomyEnabled !== true) {
    return Number.POSITIVE_INFINITY;
  }
  initialize(nowMs);
  if (pulsePromise) {
    return nowMs + 1_000;
  }
  const lastPulseAtMs = toFiniteNumber(runtimeState.lastPulseAtMs, 0);
  return lastPulseAtMs > 0
    ? Math.max(nowMs, lastPulseAtMs + getPulseIntervalMs())
    : nowMs;
}

function forcePulse(livingState, nowMs = Date.now(), options = {}) {
  initialize(nowMs);
  runtimeState.lastPulseAtMs = 0;
  tick(livingState, nowMs, options);
  return getStatus();
}

function summarizeReplacementPipeline(nowMs = Date.now()) {
  const replacements = {
    pending: 0,
    fulfilled: 0,
    pendingUnits: 0,
    pendingValueISK: 0,
    partiallyFulfilledPackages: 0,
    untouchedPackages: 0,
    pendingWithErrors: 0,
    oldestPendingAgeMs: 0,
    oldestPendingDemandID: null,
    byHull: [],
  };
  const pendingByHull = new Map();
  for (const demandID in runtimeState && runtimeState.replacementDemands || {}) {
    const demand = runtimeState.replacementDemands[demandID];
    const status = String(demand && demand.status || "");
    if (status === "fulfilled") {
      replacements.fulfilled += 1;
      continue;
    }
    if (status !== "pending") continue;
    replacements.pending += 1;
    if (String(demand.lastError || "").trim()) {
      replacements.pendingWithErrors += 1;
    }
    let fulfilledUnits = 0;
    let pendingUnits = 0;
    let pendingValueISK = 0;
    for (const item of Array.isArray(demand.requirements)
      ? demand.requirements
      : []) {
      const requested = toPositiveInt(item && item.quantity, 0);
      const fulfilled = Math.min(
        requested,
        toPositiveInt(
          demand.fulfilledQuantities &&
            demand.fulfilledQuantities[item.typeID],
          0,
        ),
      );
      const remaining = Math.max(0, requested - fulfilled);
      fulfilledUnits += fulfilled;
      pendingUnits += remaining;
      pendingValueISK += remaining * Math.max(
        0,
        toFiniteNumber(item && item.unitValueISK, 0),
      );
    }
    const ageMs = Math.max(
      0,
      nowMs - toFiniteNumber(demand.createdAtMs, nowMs),
    );
    replacements.pendingUnits += pendingUnits;
    replacements.pendingValueISK += pendingValueISK;
    if (fulfilledUnits > 0) {
      replacements.partiallyFulfilledPackages += 1;
    } else {
      replacements.untouchedPackages += 1;
    }
    if (ageMs > replacements.oldestPendingAgeMs) {
      replacements.oldestPendingAgeMs = ageMs;
      replacements.oldestPendingDemandID = demand.demandID || demandID;
    }
    const hullKey = String(toPositiveInt(demand.shipTypeID, 0) || "unknown");
    const hull = pendingByHull.get(hullKey) || {
      shipTypeID: toPositiveInt(demand.shipTypeID, 0),
      shipName: String(
        demand.shipName || `type ${demand.shipTypeID || "unknown"}`,
      ),
      pendingPackages: 0,
      pendingUnits: 0,
      pendingValueISK: 0,
      oldestPendingAgeMs: 0,
    };
    hull.pendingPackages += 1;
    hull.pendingUnits += pendingUnits;
    hull.pendingValueISK += pendingValueISK;
    hull.oldestPendingAgeMs = Math.max(hull.oldestPendingAgeMs, ageMs);
    pendingByHull.set(hullKey, hull);
  }
  replacements.pendingValueISK = roundMoney(replacements.pendingValueISK);
  replacements.byHull = [...pendingByHull.values()]
    .map((hull) => ({
      ...hull,
      pendingValueISK: roundMoney(hull.pendingValueISK),
    }))
    .sort((left, right) => (
      right.pendingPackages - left.pendingPackages ||
      right.pendingValueISK - left.pendingValueISK ||
      left.shipTypeID - right.shipTypeID
    ))
    .slice(0, 12);
  return replacements;
}

function summarizeFreightPipeline(nowMs = Date.now()) {
  const summary = {
    activeJobs: 0,
    activeUnits: 0,
    oldestActiveAgeMs: 0,
    statuses: {},
    replacementPriority: {
      activeJobs: 0,
      activeUnits: 0,
      oldestActiveAgeMs: 0,
      jobsAssigned:
        toPositiveInt(runtimeState.metrics.replacementFreightJobsAssigned, 0),
      jobsDelivered:
        toPositiveInt(runtimeState.metrics.replacementFreightJobsDelivered, 0),
      unitsAssigned:
        toPositiveInt(runtimeState.metrics.replacementFreightUnitsAssigned, 0),
      unitsDelivered:
        toPositiveInt(runtimeState.metrics.replacementFreightUnitsDelivered, 0),
      unitsDeliveredDirect:
        toPositiveInt(
          runtimeState.metrics.replacementDirectFreightUnitsDelivered,
          0,
        ),
      unitsDeliveredProductionInput:
        toPositiveInt(
          runtimeState.metrics.replacementInputFreightUnitsDelivered,
          0,
        ),
      activeRepositions: Math.max(
        0,
        toPositiveInt(
          runtimeState.metrics.replacementFreightRepositionsAssigned,
          0,
        ) -
          toPositiveInt(
            runtimeState.metrics.replacementFreightRepositionsCompleted,
            0,
          ) -
          toPositiveInt(
            runtimeState.metrics.replacementFreightRepositionsAbandoned,
            0,
          ),
      ),
    },
    general: {
      activeJobs: 0,
      activeUnits: 0,
      oldestActiveAgeMs: 0,
      jobsAssigned:
        toPositiveInt(runtimeState.metrics.generalFreightJobsAssigned, 0),
      jobsDelivered:
        toPositiveInt(runtimeState.metrics.generalFreightJobsDelivered, 0),
    },
    recovery: {
      activeIssues: 0,
      detected:
        toPositiveInt(runtimeState.metrics.staleFreightJobsDetected, 0),
      routeMismatches:
        toPositiveInt(runtimeState.metrics.freightRouteMismatchesDetected, 0),
      routesRecovered:
        toPositiveInt(runtimeState.metrics.freightRoutesRecovered, 0),
      routesReplanned:
        toPositiveInt(runtimeState.metrics.freightRoutesReplanned, 0),
      schedulerWakeups:
        toPositiveInt(runtimeState.metrics.freightProgressWakeups, 0),
      deferred:
        toPositiveInt(runtimeState.metrics.freightRecoveryDeferred, 0),
      unloads:
        toPositiveInt(runtimeState.metrics.freightRecoveryUnloads, 0),
      unitsUnloaded:
        toPositiveInt(runtimeState.metrics.freightRecoveryUnitsUnloaded, 0),
      failures:
        toPositiveInt(runtimeState.metrics.freightRecoveryFailures, 0),
    },
  };
  for (const job of Object.values(runtimeState.jobs || {})) {
    if (!isActiveJob(job)) continue;
    const quantity = toPositiveInt(job.quantity, 0);
    const ageMs = Math.max(
      0,
      nowMs - toFiniteNumber(job.reservedAtMs || job.createdAtMs, nowMs),
    );
    const status = String(job.status || "unknown");
    summary.activeJobs += 1;
    summary.activeUnits += quantity;
    summary.oldestActiveAgeMs = Math.max(
      summary.oldestActiveAgeMs,
      ageMs,
    );
    summary.statuses[status] =
      toPositiveInt(summary.statuses[status], 0) + 1;
    const bucket = isReplacementPriority(job)
      ? summary.replacementPriority
      : summary.general;
    bucket.activeJobs += 1;
    bucket.activeUnits += quantity;
    bucket.oldestActiveAgeMs = Math.max(bucket.oldestActiveAgeMs, ageMs);
    if (
      String(job.routeRecoveryError || "").trim() ||
      String(job.freightRecoveryIssueSignature || "").trim()
    ) {
      summary.recovery.activeIssues += 1;
    }
  }
  return summary;
}

function summarizeRuntimeCollections(nowMs = Date.now()) {
  const jobStatuses = {};
  let activeJobs = 0;
  for (const jobID in runtimeState && runtimeState.jobs || {}) {
    const job = runtimeState.jobs[jobID];
    const status = String(job && job.status || "unknown");
    jobStatuses[status] = (jobStatuses[status] || 0) + 1;
    if (isActiveJob(job)) activeJobs += 1;
  }
  let pendingMiningDeposits = 0;
  for (const depositID in runtimeState && runtimeState.miningDeposits || {}) {
    if (String(runtimeState.miningDeposits[depositID] &&
      runtimeState.miningDeposits[depositID].status || "") === "pending") {
      pendingMiningDeposits += 1;
    }
  }
  const replacements = summarizeReplacementPipeline(nowMs);
  const freight = summarizeFreightPipeline(nowMs);
  const campaignSupply = { pending: 0, fulfilled: 0 };
  for (const demandID in runtimeState && runtimeState.campaignDemands || {}) {
    const status = String(runtimeState.campaignDemands[demandID] &&
      runtimeState.campaignDemands[demandID].status || "");
    if (status === "pending" || status === "fulfilled") campaignSupply[status] += 1;
  }
  return {
    activeJobs,
    jobStatuses,
    pendingMiningDeposits,
    replacements,
    freight,
    campaignSupply,
  };
}

function getStockCacheStatus(nowMs = Date.now()) {
  const shard = REGIONAL_STOCK_SHARDS[
    stockCacheRuntime.reconcileRegionIndex % Math.max(1, REGIONAL_STOCK_SHARDS.length)
  ] || null;
  const currentRegion = REGIONAL_STOCK_SHARDS.find(
    (entry) => Number(entry.regionID) === Number(stockCacheRuntime.currentRegionID),
  ) || shard;
  return {
    ready: stockCacheRuntime.ready,
    rows: lastStockSnapshot.size,
    catalogKeys: CATALOG_STOCK_KEYS.length,
    regions: REGIONAL_STOCK_SHARDS.length,
    dirtyKeys: stockCacheRuntime.dirtyKeys.size,
    currentRegionID: currentRegion ? currentRegion.regionID : null,
    currentRegionName: currentRegion ? currentRegion.regionName : null,
    reconcileRegionIndex: stockCacheRuntime.reconcileRegionIndex,
    reconcileKeyIndex: stockCacheRuntime.reconcileKeyIndex,
    reconcileBatchSize: getStockReconcileBatchSize(),
    bootstrapBatchSize: getStockBootstrapBatchSize(),
    bootstrapStartedAtMs: stockCacheRuntime.bootstrapStartedAtMs,
    bootstrapCompletedAtMs: stockCacheRuntime.bootstrapCompletedAtMs,
    lastReconcileAtMs: stockCacheRuntime.lastReconcileAtMs,
    lastFullReconcileAtMs: stockCacheRuntime.lastFullReconcileAtMs,
    fullReconcileAgeMs: stockCacheRuntime.lastFullReconcileAtMs > 0
      ? Math.max(0, nowMs - stockCacheRuntime.lastFullReconcileAtMs)
      : null,
    targetFullReconcileMs: Math.max(
      15 * 60_000,
      toFiniteNumber(config.livingEconomyFullStockReconcileSeconds, 14_400) * 1_000,
    ),
    automaticRegionalStock: {
      ...stockCacheRuntime.automaticRegionalStock,
    },
    metrics: { ...stockCacheRuntime.metrics },
  };
}

function getStatus() {
  initialize();
  const telemetryState = telemetry.normalizeTelemetryState(runtimeState.telemetry);
  const procurementStatus = procurement.getStatus(runtimeState);
  const industryStatus = industry.getStatus(runtimeState);
  const collections = summarizeRuntimeCollections(Date.now());
  return {
    enabled: config.livingEconomyEnabled === true,
    catalogRevision: CATALOG_REVISION,
    stations: catalog.STATIONS.length,
    goods: catalog.GOODS.length,
    routes: catalog.FREIGHT_ROUTES.length,
    activeJobs: collections.activeJobs,
    jobStatuses: collections.jobStatuses,
    pendingMiningDeposits: collections.pendingMiningDeposits,
    freight: collections.freight,
    metrics: { ...runtimeState.metrics },
    mobilization: mobilization.getStatus(),
    lastPulseAtMs: runtimeState.lastPulseAtMs,
    lastPulseError,
    pulseTiming: {
      ...pulseTiming,
      averageDurationMs: pulseTiming.completedPulses > 0
        ? pulseTiming.totalDurationMs / pulseTiming.completedPulses
        : 0,
    },
    stockRows: lastStockSnapshot.size,
    stockCache: getStockCacheStatus(),
    routePlanning: {
      cachedOpportunities: routePlanningRuntime.opportunities.length,
      lastBuiltAtMs: routePlanningRuntime.lastBuiltAtMs,
      lastDurationMs: routePlanningRuntime.lastDurationMs,
      maximumDurationMs: routePlanningRuntime.maximumDurationMs,
      builds: routePlanningRuntime.builds,
      intervalMs: getRoutePlanningIntervalMs(),
      lastPlanningRegionID: routePlanningRuntime.lastPlanningRegionID,
      freightRepositions: {
        active: Math.max(
          0,
          toPositiveInt(runtimeState.metrics.freightRepositionsAssigned, 0) -
            toPositiveInt(runtimeState.metrics.freightRepositionsCompleted, 0) -
            toPositiveInt(runtimeState.metrics.freightRepositionsAbandoned, 0),
        ),
        maximumActive: getMaxActiveRepositions(),
        maximumPerPulse: getMaxRepositionsPerPulse(),
        maximumPerSource: FREIGHT_REPOSITION_MAX_PER_SOURCE,
        maximumJumps: FREIGHT_REPOSITION_MAX_JUMPS,
        assignedLastPulse:
          routePlanningRuntime.repositionsAssignedLastPulse,
        replacementSharePercent: getReplacementFreightShare() * 100,
        replacementMaximumPerSource:
          getReplacementRepositionMaxPerSource(),
        replacementMaximumJumps: REPLACEMENT_REPOSITION_MAX_JUMPS,
        cooldownMs: getFreightRepositionCooldownMs(),
      },
    },
    marketBatches: { ...marketBatchRuntime },
    telemetry: {
      intervalMs: telemetryState.intervalMs,
      snapshots: telemetryState.snapshots.length,
      lastSnapshotAtMs: telemetryState.lastSnapshotAtMs,
    },
    eventBridge: config.xEveEnabled === true
      ? require("../../../services/xEve/xEveEventBridge").getStatus({
        nowMs: Date.now(),
        journalRows: Array.isArray(runtimeState.events) ? runtimeState.events.length : 0,
      })
      : {
        enabled: false,
        state: "disabled",
        productionPaused: false,
      },
    procurement: procurementStatus,
    salvage: salvageRecovery.getStatus(runtimeState),
    industry: industryStatus,
    replacements: collections.replacements,
    campaignSupply: collections.campaignSupply,
    demandCoverage: demandCoverage.getStatus(runtimeState),
  };
}

function getEventJournal(limit = X_EVE_MAX_EVENT_ROWS) {
  initialize();
  const maximumRows = config.xEveEnabled === true
    ? X_EVE_MAX_EVENT_ROWS
    : LEGACY_MAX_EVENT_ROWS;
  const boundedLimit = Math.max(1, Math.min(
    maximumRows,
    toPositiveInt(limit, maximumRows),
  ));
  if (config.xEveEnabled === true) {
    const stored = stateStore.readSourceJournal({ strict: true });
    if (
      stored.exists &&
      stored.sourceEpochMs === toPositiveInt(runtimeState.createdAtMs, 0)
    ) {
      return {
        sourceEpochMs: stored.sourceEpochMs,
        maximumRows,
        events: stored.events.slice(-boundedLimit),
      };
    }
  }
  return {
    sourceEpochMs: toPositiveInt(runtimeState.createdAtMs, 0),
    maximumRows,
    events: JSON.parse(JSON.stringify(
      (Array.isArray(runtimeState.events) ? runtimeState.events : []).slice(-boundedLimit),
    )),
  };
}

function formatStatus() {
  const status = getStatus();
  const statuses = Object.entries(status.jobStatuses)
    .sort((left, right) => right[1] - left[1])
    .map(([name, count]) => `${name} ${count}`)
    .join(", ");
  return [
    `Living economy is ${status.enabled ? "enabled" : "disabled"}: ${status.stations} regional stations, ${status.goods} basic goods, ${status.routes} authored fallback routes plus dynamic pathfinding.`,
    `Jobs active ${status.activeJobs}/${getMaxActiveJobs()}${statuses ? ` (${statuses})` : ""}.`,
    `Delivered ${status.metrics.jobsDelivered || 0}, lost ${status.metrics.jobsLost || 0}, produced ${(status.metrics.unitsProduced || 0).toLocaleString("en-US")} manufactured units, refined ${(status.metrics.mineralUnitsRefined || 0).toLocaleString("en-US")} mineral/ice-product units from ${status.metrics.miningDepositsDelivered || 0} miner return(s), moved ${Number(status.metrics.cargoVolumeDeliveredM3 || 0).toLocaleString("en-US", { maximumFractionDigits: 1 })} m3 in ${(status.metrics.unitsDelivered || 0).toLocaleString("en-US")} freight units.`,
    `Shadow accounting: miners ${Number(status.metrics.minerGrossMarketValue || 0).toLocaleString("en-US")} ISK gross value; traders spent ${Number(status.metrics.traderSpend || 0).toLocaleString("en-US")} ISK, received ${Number(status.metrics.traderRevenue || 0).toLocaleString("en-US")} ISK, gross margin ${Number(status.metrics.traderGrossMargin || 0).toLocaleString("en-US")} ISK. Telemetry has ${status.telemetry.snapshots} snapshot(s) at ${Math.round(status.telemetry.intervalMs / 60_000)}-minute intervals.`,
    `Procurement: ${status.procurement.openOrders} funded corporation buy orders, ${Number(status.procurement.cashISK || 0).toLocaleString("en-US")} ISK cash, ${Number(status.procurement.escrowISK || 0).toLocaleString("en-US")} ISK in escrow, ${Number(status.procurement.spentISK || 0).toLocaleString("en-US")} ISK spent.`,
    `Salvage recovery: ${status.salvage.activeJobs} active crew(s), ${status.metrics.salvageWrecksRecovered || 0} wreck(s) recovered, ${status.metrics.salvageWrecksClaimedByPlayers || 0} claimed first by players, and ${Number(status.metrics.salvageUnitsRecovered || 0).toLocaleString("en-US")} material units returned to regional stock.`,
    `Industry: ${status.industry.activeJobs} active blueprint job(s), ${status.industry.jobsCompleted} completed, ${Number(status.industry.inputUnitsConsumed || 0).toLocaleString("en-US")} mineral units consumed, ${Number(status.industry.outputUnitsProduced || 0).toLocaleString("en-US")} finished units produced.`,
    `Replacement demand: ${status.replacements.pending} pending, ${status.replacements.fulfilled} fulfilled; ${status.metrics.replacementHullLosses || 0} hull losses have requested ${(status.metrics.replacementUnitsRequested || 0).toLocaleString("en-US")} hull/module/ammunition units worth ${Number(status.metrics.replacementValueISK || 0).toLocaleString("en-US")} ISK.`,
    `Replacement freight: ${status.freight.replacementPriority.activeJobs} active job(s), ${status.freight.replacementPriority.jobsAssigned} assigned and ${status.freight.replacementPriority.jobsDelivered} delivered; route recovery has repaired ${status.freight.recovery.routesRecovered}, replanned ${status.freight.recovery.routesReplanned}, safely unloaded ${status.freight.recovery.unloads}, and has ${status.freight.recovery.activeIssues} active issue(s).`,
    `Demand coverage: ${status.demandCoverage.requirements} open requirement line(s); ${status.demandCoverage.byStatus.awaiting_inputs || 0} awaiting factory-input freight, ${status.demandCoverage.byStatus.blocked_inputs || 0} blocked by exhausted inputs, ${status.demandCoverage.byStatus.awaiting_production || 0} ready for production, ${status.demandCoverage.byStatus.in_production || 0} in production, ${status.demandCoverage.byStatus.awaiting_freight || 0} awaiting output freight, and ${status.demandCoverage.byStatus.awaiting_faction_import || 0} awaiting scarce faction imports.`,
    `Pulse timing: last ${status.pulseTiming.lastDurationMs.toFixed(2)} ms, average ${status.pulseTiming.averageDurationMs.toFixed(2)} ms, max ${status.pulseTiming.maxDurationMs.toFixed(2)} ms.`,
    `Regional stock cache: ${status.stockCache.ready ? "ready" : "warming"}, ${status.stockCache.rows.toLocaleString("en-US")}/${status.stockCache.catalogKeys.toLocaleString("en-US")} rows represented, ${status.stockCache.dirtyKeys} dirty key(s), reconciling ${status.stockCache.currentRegionName || "unassigned"} in ${status.stockCache.reconcileBatchSize}-key slices.`,
    status.lastPulseError ? `Last pulse error: ${status.lastPulseError}.` : "Market link is healthy.",
  ].join(" ");
}

function formatJobs(limit = 8) {
  initialize();
  const active = Object.values(runtimeState.jobs)
    .filter(isActiveJob)
    .sort((left, right) => toFiniteNumber(left.createdAtMs, 0) - toFiniteNumber(right.createdAtMs, 0))
    .slice(0, Math.max(1, toPositiveInt(limit, 8)));
  if (active.length <= 0) {
    return "No active living-economy freight jobs. The next market pulse will create work when a station has a shortage and a carrier is docked at a valid source.";
  }
  return active.map((job) => {
    const source = catalog.getStation(job.sourceStationID);
    const destination = catalog.getStation(job.destinationStationID);
    return `${job.jobID} ${job.status}: ${Number(job.quantity).toLocaleString("en-US")} ${job.typeName} | ${source ? source.name : job.sourceStationID} -> ${destination ? destination.name : job.destinationStationID} | ${job.logisticsClass || "legacy"} ${Math.round(toFiniteNumber(job.capacityUtilization, 0) * 100)}% load, ${job.riskBand || "highsec"}${job.dynamicRoute ? `, ${job.jumps || 0} jumps / ~${Math.round(toFiniteNumber(job.estimatedTravelMinutes, 0))} min` : ""}${job.procurementOrderID ? `, fulfilling buy order ${job.procurementOrderID}` : ""} | ${job.assignedFlightID}`;
  }).join("; ");
}

function formatProcurement(limit = 12) {
  initialize();
  const status = procurement.getStatus(runtimeState);
  const orders = procurement.listOpenOrders(runtimeState)
    .sort((left, right) => (
      toFiniteNumber(right.escrowISK, 0) - toFiniteNumber(left.escrowISK, 0)
    ))
    .slice(0, Math.max(1, toPositiveInt(limit, 12)));
  const summary =
    `NPC procurement has ${status.openOrders} funded buy orders across ${status.corporations} corporation(s): ` +
    `${Number(status.cashISK || 0).toLocaleString("en-US")} ISK cash, ` +
    `${Number(status.escrowISK || 0).toLocaleString("en-US")} ISK escrow, ` +
    `${Number(status.spentISK || 0).toLocaleString("en-US")} ISK spent.`;
  if (orders.length <= 0) return summary;
  return `${summary} ` + orders.map((order) => {
    const station = catalog.getStation(order.stationID);
    return `${order.orderID}: ${Number(order.remainingQuantity).toLocaleString("en-US")} ${order.typeName} @ ${Number(order.price).toLocaleString("en-US")} ISK, ${station ? station.name : order.stationID}`;
  }).join("; ");
}

function formatIndustry(limit = 12) {
  initialize();
  return industry.format(runtimeState, limit);
}

function formatLosses(limit = 12) {
  initialize();
  const demands = Object.values(runtimeState.replacementDemands || {})
    .sort((left, right) => toFiniteNumber(right.createdAtMs, 0) - toFiniteNumber(left.createdAtMs, 0));
  const pending = demands.filter((demand) => String(demand.status || "") === "pending").length;
  const fulfilled = demands.filter((demand) => String(demand.status || "") === "fulfilled").length;
  const summary = `Living losses: ${demands.length} replacement demand(s), ${pending} pending and ${fulfilled} fulfilled; ${Number(runtimeState.metrics.replacementValueISK || 0).toLocaleString("en-US")} ISK of governed hulls/fittings requested.`;
  if (demands.length <= 0) return `${summary} No encounter losses have reached the economy yet.`;
  return `${summary} ` + demands.slice(0, Math.max(1, toPositiveInt(limit, 12))).map((demand) => {
    const station = catalog.getStation(demand.stationID);
    const fulfilledUnits = Object.values(demand.fulfilledQuantities || {}).reduce(
      (sum, quantity) => sum + toPositiveInt(quantity, 0),
      0,
    );
    return `${demand.demandID} ${demand.status}: ${demand.shipName}, ${fulfilledUnits}/${demand.requestedUnits} replacement units at ${station ? station.name : demand.stationID} (${demand.encounterID})`;
  }).join("; ");
}

function formatStations() {
  initialize();
  if (lastStockSnapshot.size <= 0) {
    return "No station stock snapshot is loaded yet. Wait for the first living-economy pulse.";
  }
  return catalog.STATIONS.map((station) => {
    let targetUnits = 0;
    let stockUnits = 0;
    let stockedTypes = 0;
    let targetTypes = 0;
    for (const good of catalog.GOODS) {
      const target = catalog.getTargetQuantity(station, good);
      if (target <= 0) {
        continue;
      }
      targetTypes += 1;
      targetUnits += target;
      const quantity = toPositiveInt(getStockRow(lastStockSnapshot, station.stationID, good.typeID).quantity, 0);
      stockUnits += Math.min(target, quantity);
      if (quantity > 0) {
        stockedTypes += 1;
      }
    }
    const fillPercent = targetUnits > 0 ? Math.round((stockUnits / targetUnits) * 100) : 0;
    return `${station.name} [${station.hubTier || "local"}]: ${stockedTypes}/${targetTypes} types, ${fillPercent}% target fill`;
  }).join("; ");
}

function prepareReset(nowMs = Date.now()) {
  if (pulsePromise) {
    const error = new Error("LIVING_ECONOMY_RESET_PULSE_ACTIVE");
    error.code = "LIVING_ECONOMY_RESET_PULSE_ACTIVE";
    throw error;
  }
  initialize(nowMs);
  const unresolvedEstateJobs = Object.values(runtimeState.jobs).filter(
    isUnresolvedEstateJob,
  );
  let activeEstateReservations = [];
  if (config.familyEstateLogisticsEnabled === true) {
    activeEstateReservations = getFamilyEstateProjectsRuntime()
      .listActiveFamilyEstateNpcDeliveries(nowMs);
  }
  if (unresolvedEstateJobs.length > 0 || activeEstateReservations.length > 0) {
    const error = new Error("LIVING_ECONOMY_ESTATE_DELIVERIES_ACTIVE");
    error.code = "LIVING_ECONOMY_ESTATE_DELIVERIES_ACTIVE";
    error.activeEstateJobs = unresolvedEstateJobs.length;
    error.activeEstateReservations = activeEstateReservations.length;
    throw error;
  }
  if (config.xEveEnabled === true) {
    const bridgeResult = require("../../../services/xEve/xEveEventBridge")
      .drainBeforeSourceReset({
        nowMs,
        journalRows: Array.isArray(runtimeState.events) ? runtimeState.events.length : 0,
        sourceCheckpoint: checkpointXEveSourceJournal,
      });
    if (!bridgeResult || bridgeResult.success !== true) {
      const error = new Error(
        bridgeResult && bridgeResult.errorMsg || "X_EVE_SOURCE_RESET_DRAIN_FAILED",
      );
      error.code = bridgeResult && bridgeResult.errorMsg ||
        "X_EVE_SOURCE_RESET_DRAIN_FAILED";
      error.xEveProductionPaused = true;
      throw error;
    }
  }
  const previousSourceEpochMs = Math.max(
    0,
    Math.trunc(Number(runtimeState.createdAtMs) || 0),
  );
  if (!Number.isSafeInteger(previousSourceEpochMs) || previousSourceEpochMs >= Number.MAX_SAFE_INTEGER) {
    const error = new Error("LIVING_ECONOMY_SOURCE_EPOCH_EXHAUSTED");
    error.code = "LIVING_ECONOMY_SOURCE_EPOCH_EXHAUSTED";
    throw error;
  }
  const requestedSourceEpochMs = Math.trunc(Number(nowMs));
  const safeRequestedSourceEpochMs = (
    Number.isSafeInteger(requestedSourceEpochMs) && requestedSourceEpochMs > 0
  ) ? requestedSourceEpochMs : Math.trunc(Date.now());
  const nextSourceEpochMs = Math.max(
    previousSourceEpochMs + 1,
    safeRequestedSourceEpochMs,
  );
  const nextState = stateStore.buildDefaultState();
  preserveExternalAdjustmentCounters(runtimeState, nextState);
  nextState.catalogRevision = CATALOG_REVISION;
  nextState.createdAtMs = nextSourceEpochMs;
  nextState.updatedAtMs = nextSourceEpochMs;
  preparedResetToken = {
    sourceEpochMs: previousSourceEpochMs,
    nextEventNumber: Math.max(1, toPositiveInt(runtimeState.nextEventNumber, 1)),
    previousState: JSON.parse(JSON.stringify(runtimeState)),
    nextState,
    staged: false,
    rollbackStaged: false,
  };
  return { success: true, token: preparedResetToken };
}

function formatSalvage(limit = 12) {
  initialize();
  const status = salvageRecovery.getStatus(runtimeState);
  const nowMs = Date.now();
  const active = salvageRecovery.listActiveJobs(runtimeState)
    .sort((left, right) => toFiniteNumber(left.createdAtMs, 0) - toFiniteNumber(right.createdAtMs, 0))
    .slice(0, Math.max(1, toPositiveInt(limit, 12)));
  const summary =
    `Living salvage: ${status.activeJobs} active recovery job(s) across ${status.sites} retained site(s); ` +
    `${runtimeState.metrics.salvageWrecksRecovered || 0} wreck(s) recovered, ` +
    `${runtimeState.metrics.salvageWrecksClaimedByPlayers || 0} already claimed by players, and ` +
    `${Number(runtimeState.metrics.salvageUnitsRecovered || 0).toLocaleString("en-US")} material units delivered.`;
  if (active.length <= 0) return `${summary} No recovery crew is currently underway.`;
  return `${summary} ` + active.map((job) => {
    const site = runtimeState.salvageSites[job.siteID] || {};
    const station = catalog.getStation(job.destinationStationID);
    const dueAtMs = job.status === "outbound"
      ? job.arrivesAtMs
      : job.status === "recovering"
        ? job.recoveryCompletesAtMs
        : job.status === "returning"
          ? job.returnsAtMs
          : nowMs;
    const dueSeconds = Math.max(0, Math.ceil((toFiniteNumber(dueAtMs, nowMs) - nowMs) / 1_000));
    return `${job.jobID} ${job.status}: ${site.wrecks ? site.wrecks.length : 0} wreck(s) in system ${job.systemID}, ${job.jumpCount || 0} jump(s) from ${station ? station.name : job.destinationStationID}, next event in ~${dueSeconds}s`;
  }).join("; ");
}

function isCurrentResetToken(resetToken) {
  return resetToken === preparedResetToken &&
    Boolean(resetToken) &&
    resetToken.sourceEpochMs === Math.max(0, Number(runtimeState.createdAtMs) || 0) &&
    resetToken.nextEventNumber === Math.max(1, toPositiveInt(runtimeState.nextEventNumber, 1));
}

function stagePreparedReset(resetToken) {
  if (pulsePromise) {
    return { success: false, errorMsg: "LIVING_ECONOMY_RESET_PULSE_ACTIVE" };
  }
  if (!isCurrentResetToken(resetToken)) {
    return { success: false, errorMsg: "LIVING_ECONOMY_RESET_TOKEN_STALE" };
  }
  let writeResult;
  try {
    writeResult = stateStore.writeState(resetToken.nextState, {
      trustedNormalizedState: true,
    });
  } catch (error) {
    writeResult = {
      success: false,
      errorMsg: error && (error.code || error.message) || "RESET_STAGE_THROWN",
    };
  }
  if (!writeResult || writeResult.success !== true) {
    return {
      success: false,
      errorMsg: writeResult && writeResult.errorMsg || "LIVING_ECONOMY_RESET_STAGE_FAILED",
    };
  }
  resetToken.staged = true;
  resetToken.rollbackStaged = false;
  return { success: true };
}

function rollbackPreparedReset(resetToken, options = {}) {
  if (resetToken !== preparedResetToken || !resetToken) {
    return { success: false, errorMsg: "LIVING_ECONOMY_RESET_TOKEN_STALE" };
  }
  let restoreResult;
  try {
    restoreResult = stateStore.writeState(resetToken.previousState, {
      trustedNormalizedState: true,
    });
    if (
      restoreResult &&
      restoreResult.success === true &&
      options.durable === true
    ) {
      restoreResult = stateStore.flushDurably();
      if (
        restoreResult &&
        restoreResult.success === true &&
        config.xEveEnabled === true
      ) {
        restoreResult = stateStore.replaceSourceJournal(resetToken.previousState, {
          durable: true,
          nowMs: resetToken.previousState.updatedAtMs,
        });
      }
    }
  } catch (error) {
    restoreResult = {
      success: false,
      errorMsg: error && (error.code || error.message) || "RESET_ROLLBACK_THROWN",
    };
  }
  if (!restoreResult || restoreResult.success !== true) {
    stateStore.suspendPersistence(
      restoreResult && restoreResult.errorMsg || "LIVING_ECONOMY_RESET_ROLLBACK_FAILED",
    );
    return restoreResult || {
      success: false,
      errorMsg: "LIVING_ECONOMY_RESET_ROLLBACK_FAILED",
    };
  }
  resetToken.staged = false;
  resetToken.rollbackStaged = true;
  if (options.finalize !== false) preparedResetToken = null;
  return { success: true };
}

function finalizePreparedResetRollback(resetToken) {
  if (
    resetToken !== preparedResetToken ||
    !resetToken ||
    resetToken.rollbackStaged !== true
  ) {
    return { success: false, errorMsg: "LIVING_ECONOMY_RESET_TOKEN_STALE" };
  }
  preparedResetToken = null;
  return { success: true };
}

function commitPreparedReset(resetToken) {
  if (
    !isCurrentResetToken(resetToken) ||
    resetToken.staged !== true ||
    resetToken.rollbackStaged === true
  ) {
    return { success: false, errorMsg: "LIVING_ECONOMY_RESET_TOKEN_STALE" };
  }
  runtimeState = resetToken.nextState;
  preparedResetToken = null;
  initialized = true;
  lastStockSnapshot = new Map();
  lastPulseError = null;
  pulseTiming = createPulseTiming();
  stockCacheRuntime = createStockCacheRuntime();
  routePlanningRuntime = createRoutePlanningRuntime();
  marketBatchRuntime = createMarketBatchRuntime();
  lastAssignFreightRoute = null;
  lastSalvageRecoveryAdapters = {};
  return { success: true, data: getStatus() };
}

function reset(nowMs = Date.now(), options = {}) {
  initialize(nowMs);
  let resetToken = options.resetToken;
  if (!isCurrentResetToken(resetToken)) resetToken = prepareReset(nowMs).token;
  const staged = stagePreparedReset(resetToken);
  let flushResult = staged;
  if (staged && staged.success === true) {
    try {
      flushResult = stateStore.flushDurably();
    } catch (error) {
      flushResult = {
        success: false,
        errorMsg: error && (error.code || error.message) || "RESET_PERSIST_THROWN",
      };
    }
  }
  if (
    flushResult &&
    flushResult.success === true &&
    config.xEveEnabled === true
  ) {
    try {
      flushResult = stateStore.replaceSourceJournal(resetToken.nextState, {
        durable: true,
        nowMs,
      });
    } catch (error) {
      flushResult = {
        success: false,
        errorMsg: error && (error.code || error.message) ||
          "LIVING_ECONOMY_SOURCE_JOURNAL_RESET_FAILED",
      };
    }
  }
  if (!flushResult || flushResult.success !== true) {
    const rollback = rollbackPreparedReset(resetToken, { durable: true });
    if (!rollback || rollback.success !== true) {
      stateStore.suspendPersistence(
        rollback && rollback.errorMsg || "LIVING_ECONOMY_RESET_ROLLBACK_FAILED",
      );
      log.warn(
        `[LivingEconomy] Failed to restore state after reset error: ` +
        `${rollback && rollback.errorMsg || "UNKNOWN"}`,
      );
    }
    const reason = flushResult && flushResult.errorMsg ||
      "LIVING_ECONOMY_RESET_PERSIST_FAILED";
    if (config.xEveEnabled === true) {
      require("../../../services/xEve/xEveEventBridge")
        .reportLivingEconomyDurabilityFailure(reason, {
          nowMs,
          bufferedEvents: 0,
          countRejected: false,
        });
    }
    const error = new Error(reason);
    error.code = reason;
    error.xEveProductionPaused = config.xEveEnabled === true;
    throw error;
  }
  const committed = commitPreparedReset(resetToken);
  if (!committed || committed.success !== true) {
    const error = new Error(
      committed && committed.errorMsg || "LIVING_ECONOMY_RESET_COMMIT_FAILED",
    );
    error.code = committed && committed.errorMsg || "LIVING_ECONOMY_RESET_COMMIT_FAILED";
    throw error;
  }
  return committed.data;
}

module.exports = {
  CATALOG_REVISION,
  tick,
  forcePulse,
  getNextWakeAtMs,
  getStatus,
  getEventJournal,
  formatStatus,
  formatJobs,
  formatProcurement,
  formatIndustry,
  formatSalvage,
  formatLosses,
  formatStations,
  getFlightCargo,
  hasFreightWork,
  hasReplacementPriorityFreightWork,
  shouldHoldFreightFlight,
  shouldHoldMiningFlight,
  shouldHoldReplacementFlight,
  registerReplacementLoss,
  auditReplacementCoverage,
  registerCampaignDemand,
  registerSalvageOpportunity,
  areReplacementDemandsFulfilled,
  notifyStationArrival,
  notifyMiningArrival,
  notifyFlightLoss,
  settleProcurementFill,
  validateProcurementFill,
  endProcurementFill,
  assertEventProductionAvailable,
  checkpointXEveSourceJournal,
  notifyMarketStockMutation,
  notifyExternalFreightDemandMutation,
  reconcileAssignments,
  isEventProductionPaused,
  commitPreparedReset,
  finalizePreparedResetRollback,
  prepareReset,
  rollbackPreparedReset,
  reset,
  stagePreparedReset,
  _testing: {
    computePrice,
    makeCampaignAdjustmentID,
    promoteLegacyCampaignAdjustmentNamespace,
    quarantineCampaignAdjustmentConflict,
    isStockAdjustmentIdentityCollision,
    adjustStock,
    isNonRetryableStockAdjustmentError,
    invalidateFreightOpportunitiesForStockRow,
    invalidateRejectedStockReservation,
    buildNpcRefineryOutputs,
    findFreightCandidate,
    getDockedStationID,
    getFreightReposition,
    getActiveFreightRepositions,
    startFreightReposition,
    closeFreightReposition,
    settleFreightRepositionAtStation,
    createJobs,
    getFreightProgressFingerprint,
    inspectFreightJobProgress,
    recoverStaleFreightJobs,
    getStockRow,
    recordMinerDepositValue,
    recordTraderPurchase,
    recordTraderSale,
    recordTraderCargoLoss,
    buildReplacementRequirements,
    buildReplacementRequirementPackage,
    auditReplacementCoverage,
    summarizeReplacementPipeline,
    summarizeFreightPipeline,
    buildCampaignSupplyRequirements,
    listReplacementRequirements,
    processReplacementDemands,
    processCampaignDemands,
    processPendingDeliveries,
    salvageRecovery,
    reconcileEstateDeliveryReceipts,
    finalizeEstateDeliveryJob,
    isUnresolvedEstateJob,
    assertEventProductionAvailable,
    pruneOldState,
    getStockCacheStatus,
    readStockKeyBatch,
    initializeMissingRegionalStock,
    bootstrapStockCache,
    refreshRegionalStockSlice,
    refreshDirtyStock,
    notifyMarketStockMutation,
    preserveExternalAdjustmentCounters,
    takeNextPlanningShard,
    getRegionalOpportunities,
    getCachedStockRow(stationID, typeID) {
      return getStockRow(lastStockSnapshot, stationID, typeID);
    },
    setStockCacheForTest(rows = [], options = {}) {
      lastStockSnapshot = new Map();
      for (const row of Array.isArray(rows) ? rows : []) updateStockMap(lastStockSnapshot, row);
      stockCacheRuntime = createStockCacheRuntime();
      stockCacheRuntime.ready = options.ready !== false;
      stockCacheRuntime.bootstrapCompletedAtMs = stockCacheRuntime.ready ? Date.now() : 0;
      return getStockCacheStatus();
    },
    getRoutePlanningForTest() {
      return {
        ...routePlanningRuntime,
        opportunities: routePlanningRuntime.opportunities,
      };
    },
    setRoutePlanningOpportunitiesForTest(opportunities = [], lastBuiltAtMs = Date.now()) {
      routePlanningRuntime.opportunities = Array.isArray(opportunities) ? opportunities : [];
      routePlanningRuntime.lastBuiltAtMs = toFiniteNumber(lastBuiltAtMs, Date.now());
      return routePlanningRuntime.opportunities;
    },
    REGIONAL_STOCK_SHARDS,
    AUTOMATIC_REGIONAL_STOCK_SPECS,
    EXTERNAL_ADJUSTMENT_COUNTER_KEYS,
    setRuntimeStateForTest(state) {
      runtimeState = state;
      initialized = true;
      pulsePromise = null;
      lastStockSnapshot = new Map();
      lastPulseError = null;
      pulseTiming = createPulseTiming();
      stockCacheRuntime = createStockCacheRuntime();
      routePlanningRuntime = createRoutePlanningRuntime();
      marketBatchRuntime = createMarketBatchRuntime();
    },
    setPulseActiveForTest(active) {
      pulsePromise = active === true ? Promise.resolve() : null;
    },
    setFreightAdaptersForTest(options = {}) {
      lastAssignFreightRoute =
        typeof options.assignFreightRoute === "function"
          ? options.assignFreightRoute
          : null;
      lastMarkLivingStateDirty =
        typeof options.markLivingStateDirty === "function"
          ? options.markLivingStateDirty
          : null;
    },
  },
};
