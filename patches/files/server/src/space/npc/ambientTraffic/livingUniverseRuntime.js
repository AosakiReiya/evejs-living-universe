"use strict";

const path = require("path");
const { performance } = require("perf_hooks");

const config = require(path.join(__dirname, "../../../config"));
const log = require(path.join(__dirname, "../../../utils/logger"));
const PILOT_SOURCE_ID = "ambient_living_universe";
const worldData = require(path.join(__dirname, "../../worldData"));
const nativeNpcStore = require(path.join(__dirname, "../nativeNpcStore"));
const npcData = require(path.join(__dirname, "../npcData"));
const npcPhysicalBudget = require(path.join(__dirname, "../npcPhysicalBudget"));
const {
  ONE_AU_IN_METERS,
  findSafeWarpOriginAnchor,
} = require(path.join(__dirname, "../npcWarpOrigins"));
const livingStateStore = require(path.join(__dirname, "./livingUniverseState"));
const livingEconomyRuntime = require(path.join(__dirname, "./livingEconomyRuntime"));
const livingEconomyCatalog = require(path.join(__dirname, "./livingEconomyCatalog"));
const livingConflictRuntime = require(path.join(__dirname, "./livingConflictRuntime"));
const livingRoamingKernel = require(path.join(__dirname, "./livingRoamingKernel"));
const livingConflictCampaignCatalog = require(path.join(
  __dirname,
  "./livingConflictCampaignCatalog",
));
const marketTopology = require(path.join(__dirname, "../../../services/market/marketTopology"));
const structureState = require(path.join(
  __dirname,
  "../../../services/structure/structureState",
));
const nativeNpcWreckService = require(path.join(__dirname, "../nativeNpcWreckService"));
const { DeadlineQueue } = require(path.join(__dirname, "../../liveEvents/deadlineQueue"));
const livingAffiliations = require(path.join(__dirname, "./livingUniverseAffiliations"));
const beltRatRuntime = require(path.join(__dirname, "../beltRatRuntime"));
const regionalTrafficDoctrines = require(path.join(
  __dirname,
  "../governance/regionalTrafficDoctrineCatalog",
));
const livingPilotDirectory = require(path.join(
  __dirname,
  "./livingUniversePilotDirectory",
));
const factionHostilityRuntime = require(path.join(
  __dirname,
  "../../../services/character/factionHostilityRuntime",
));
const livingKillCreditLedger = require(path.join(
  __dirname,
  "./livingKillCreditLedger",
));
const {
  LIVING_UNIVERSE_GROUPS,
} = require(path.join(__dirname, "./ambientTrafficNpcCatalog"));
const {
  buildFormationSlotPoint,
  buildLandingPoint,
  buildNaturalWarpOrders,
  buildPoweredUndockEnvelope,
} = require(path.join(__dirname, "./ambientTrafficRuntime"))._testing;

const OPERATOR_KIND = "livingUniverse";
const POPULATION_REVISION = 17;
const TICK_INTERVAL_MS = 1_000;
const PERSIST_INTERVAL_MS = 5_000;
const MAX_PERSIST_INTERVAL_MS = 30_000;
const ARRIVAL_INGRESS_MS = 3_500;
const ARRIVAL_DWELL_MS = 8_000;
const GATE_DWELL_MS = 8_000;
const WARP_TIMEOUT_MS = 120_000;
const POWERED_UNDOCK_TARGET_METERS = 1_000_000;
const DESTINY_ALIGN_LOG_DENOMINATOR = Math.log(4);
const WARP_DROPOUT_SPEED_MAX_MS = 100;
const DISTRESS_BEACON_TYPE_ID = 28_356;
const DISTRESS_BEACON_GROUP_ID = 885;
const DISTRESS_BEACON_CATEGORY_ID = 16;
const DISTRESS_BEACON_RADIUS_METERS = 2_000;
const MAX_PENDING_ROAMING_CONTACTS = 32;

const PHASE = Object.freeze({
  DOCKED: "docked",
  VIRTUAL_DEPARTURE: "virtual_departure",
  VIRTUAL_TRANSIT: "virtual_transit",
  VIRTUAL_CROSSING: "virtual_crossing",
  VIRTUAL_STATION_APPROACH: "virtual_station_approach",
  VIRTUAL_DUTY_DEPARTURE: "virtual_duty_departure",
  VIRTUAL_DUTY_RETURN: "virtual_duty_return",
  DUTY: "duty",
  STATION_DEPARTURE: "station_departure",
  ALIGNING: "aligning",
  GATE_ARRIVAL: "gate_arrival",
  WARPING_TO_GATE: "warping_to_gate",
  WARPING_ACROSS_SYSTEM: "warping_across_system",
  WARPING_TO_STATION: "warping_to_station",
  WARPING_TO_DUTY: "warping_to_duty",
  DUTY_LIVE: "duty_live",
  RETURNING_TO_STATION: "returning_to_station",
  GATE_DWELL: "gate_dwell",
  STATION_DWELL: "station_dwell",
});

const PHYSICAL_PHASES = new Set([
  PHASE.STATION_DEPARTURE,
  PHASE.ALIGNING,
  PHASE.GATE_ARRIVAL,
  PHASE.WARPING_TO_GATE,
  PHASE.WARPING_ACROSS_SYSTEM,
  PHASE.WARPING_TO_STATION,
  PHASE.WARPING_TO_DUTY,
  PHASE.DUTY_LIVE,
  PHASE.RETURNING_TO_STATION,
  PHASE.GATE_DWELL,
  PHASE.STATION_DWELL,
]);

const AUTHORED_NETWORK_ROUTE_SPECS = Object.freeze([
  { routeID: "jita_maurasi", systemIDs: [30000142, 30000140], endpointStationIDs: [60003760, 60003763], riskBand: "highsec", routeClass: "feeder" },
  { routeID: "jita_perimeter", systemIDs: [30000142, 30000144], endpointStationIDs: [60003760, 60003754], riskBand: "highsec", routeClass: "trunk" },
  { routeID: "jita_new_caldari", systemIDs: [30000142, 30000145], endpointStationIDs: [60003760, 60000682], riskBand: "highsec", routeClass: "bulk" },
  { routeID: "jita_sobaseki", systemIDs: [30000142, 30001363], endpointStationIDs: [60003760, 60000763], riskBand: "highsec", routeClass: "bulk" },
  { routeID: "jita_muvolailen", systemIDs: [30000142, 30002780], endpointStationIDs: [60003760, 60000004], riskBand: "highsec", routeClass: "regional" },
  { routeID: "jita_niyabainen", systemIDs: [30000142, 30000143], endpointStationIDs: [60003760, 60000454], riskBand: "highsec", routeClass: "bulk" },
  { routeID: "jita_ikuchi", systemIDs: [30000142, 30000138], endpointStationIDs: [60003760, 60000394], riskBand: "highsec", routeClass: "regional" },
  { routeID: "jita_nourvukaiken", systemIDs: [30000142, 30000143, 30001379, 30001376], endpointStationIDs: [60003760, 60000376], riskBand: "highsec", routeClass: "regional" },
  { routeID: "jita_halaima", systemIDs: [30000142, 30001363, 30001362, 30001377, 30002781], endpointStationIDs: [60003760, 60000880], riskBand: "highsec", routeClass: "bulk" },
  { routeID: "jita_tama", systemIDs: [30000142, 30000143, 30001379, 30001376, 30002813], endpointStationIDs: [60003760, 60005203], riskBand: "lowsec", routeClass: "frontier", lowSecurity: true },
  { routeID: "nourvukaiken_tama", systemIDs: [30001376, 30002813], endpointStationIDs: [60000376, 60005203], riskBand: "lowsec", routeClass: "frontier", lowSecurity: true },
]);

function buildRegionalNetworkRouteSpecs() {
  const routes = [];
  for (const hub of livingEconomyCatalog.REGIONAL_HUBS) {
    const candidates = livingEconomyCatalog.STATIONS
      .filter((station) => (
        Number(station.regionID) === Number(hub.regionID) &&
        Number(station.stationID) !== Number(hub.stationID)
      ))
      .sort((left, right) => (
        Object.keys(right.production || {}).length - Object.keys(left.production || {}).length ||
        Number(right.security || 0) - Number(left.security || 0) ||
        Number(left.stationID) - Number(right.stationID)
      ));
    let selected = null;
    let systemIDs = [];
    for (const candidate of candidates.slice(0, 16)) {
      const pathIDs = marketTopology.getShortestPath(hub.systemID, candidate.systemID);
      if (pathIDs.length >= 2) {
        selected = candidate;
        systemIDs = pathIDs;
        break;
      }
    }
    if (!selected) continue;
    const securities = systemIDs.map((systemID) => toFiniteNumber(
      worldData.getSolarSystemByID(systemID)?.security,
      0,
    ));
    const riskBand = securities.some((security) => security <= 0)
      ? "nullsec"
      : securities.some((security) => security < 0.5)
        ? "lowsec"
        : "highsec";
    const jumps = systemIDs.length - 1;
    const routeClass = riskBand !== "highsec"
      ? "frontier"
      : jumps <= 2
        ? "feeder"
        : jumps <= 6
          ? "regional"
          : jumps <= 12
            ? "bulk"
            : "trunk";
    const allowedLogisticsClasses = routeClass === "frontier"
      ? ["secure"]
      : routeClass === "trunk" || routeClass === "bulk"
        ? ["regional", "bulk", "trunk", "secure"]
        : ["feeder", "regional", "bulk", "trunk", "secure"];
    routes.push(Object.freeze({
      routeID: `regional_hub_${hub.regionID}_${hub.systemID}_${selected.systemID}`,
      systemIDs,
      endpointStationIDs: [hub.stationID, selected.stationID],
      riskBand,
      routeClass,
      lowSecurity: riskBand !== "highsec",
      allowedLogisticsClasses,
      generatedRegionalHubRoute: true,
    }));
  }
  return routes.sort((left, right) => left.routeID.localeCompare(right.routeID));
}

const GENERATED_REGIONAL_NETWORK_ROUTE_SPECS = Object.freeze(buildRegionalNetworkRouteSpecs());
const NETWORK_ROUTE_SPECS = Object.freeze([
  ...AUTHORED_NETWORK_ROUTE_SPECS,
  ...GENERATED_REGIONAL_NETWORK_ROUTE_SPECS,
]);

const CAMPAIGN_ROUTE_SPECS = livingConflictCampaignCatalog.ROUTE_SPECS;
const SUPPORTED_PIRATE_FACTION_KEYS = Object.freeze(Object.keys(
  regionalTrafficDoctrines.PIRATE_DEFINITIONS,
));
const PIRATE_ROUTE_SPECS = Object.freeze([
  ...CAMPAIGN_ROUTE_SPECS,
  ...GENERATED_REGIONAL_NETWORK_ROUTE_SPECS.filter((route) => {
    const systemID = Number(route && route.systemIDs && route.systemIDs[0]) || 0;
    return beltRatRuntime.resolvePirateFactionKeyForSystem(systemID) !== "rogue_drones";
  }),
]);
const ALL_NETWORK_ROUTE_SPECS = Object.freeze([
  ...NETWORK_ROUTE_SPECS,
  ...CAMPAIGN_ROUTE_SPECS,
]);

const DUTY_ROUTE_SPECS = Object.freeze([
  { routeID: "mining_maurasi", systemID: 30000140, stationID: 60003454, dutyAnchorID: 40008922, resourceFamily: "ore", riskBand: "highsec" },
  { routeID: "mining_perimeter", systemID: 30000144, stationID: 60000685, dutyAnchorID: 40009232, resourceFamily: "ore", riskBand: "highsec" },
  { routeID: "mining_new_caldari", systemID: 30000145, stationID: 60000682, dutyAnchorID: 40009256, resourceFamily: "ore", riskBand: "highsec" },
  { routeID: "mining_sobaseki", systemID: 30001363, stationID: 60000844, dutyAnchorID: 40086852, resourceFamily: "ore", riskBand: "highsec" },
  { routeID: "mining_muvolailen", systemID: 30002780, stationID: 60000004, dutyAnchorID: 40176371, resourceFamily: "ore", riskBand: "highsec" },
  { routeID: "mining_niyabainen", systemID: 30000143, stationID: 60000457, dutyAnchorID: 40009129, resourceFamily: "ore", riskBand: "highsec" },
  { routeID: "mining_ikuchi", systemID: 30000138, stationID: 60000394, dutyAnchorID: 40008857, resourceFamily: "ore", riskBand: "highsec" },
  { routeID: "mining_tama", systemID: 30002813, stationID: 60005203, dutyAnchorID: 40178440, resourceFamily: "ore", riskBand: "lowsec" },
  { routeID: "ice_halaima", systemID: 30002781, stationID: 60000880, dutyAnchorID: 5_400_027_810_000, resourceFamily: "ice", riskBand: "highsec", generatedResourceSite: true },
]);

function buildRegionalDutyRouteSpecs() {
  const authoredSystems = new Set(DUTY_ROUTE_SPECS.map((route) => Number(route.systemID)));
  const routes = [];
  for (const station of livingEconomyCatalog.STATIONS) {
    const systemID = toPositiveInt(station && station.systemID, 0);
    if (!systemID || authoredSystems.has(systemID)) continue;
    const belts = worldData.getAsteroidBeltsForSystem(systemID);
    if (belts.length <= 0) continue;
    const system = worldData.getSolarSystemByID(systemID);
    const belt = belts[(systemID + belts.length) % belts.length];
    routes.push(Object.freeze({
      routeID: `mining_region_${systemID}`,
      systemID,
      stationID: station.stationID,
      dutyAnchorID: belt.itemID,
      resourceFamily: "ore",
      riskBand: toFiniteNumber(system && system.security, 0) < 0.5 ? "lowsec" : "highsec",
      regional: true,
    }));
  }
  return routes.sort((left, right) => left.systemID - right.systemID);
}

const REGIONAL_DUTY_ROUTE_SPECS = Object.freeze(buildRegionalDutyRouteSpecs());
const ALL_DUTY_ROUTE_SPECS = Object.freeze([
  ...DUTY_ROUTE_SPECS,
  ...REGIONAL_DUTY_ROUTE_SPECS,
]);

let initialized = false;
let disabledCleanupComplete = false;
let runtimeState = null;
let lastTickAtMs = 0;
let lastPersistAtMs = 0;
let dirty = false;
let materializationsThisTick = 0;
const routeDefinitionsByID = new Map();
const flightDeadlineQueue = new DeadlineQueue();
const replacementFreightDeadlineQueue = new DeadlineQueue();
const flightIDsBySystem = new Map();
const indexedSystemByFlightID = new Map();
const dirtyPilotActorIDs = new Set();
let schedulerInitialized = false;
let schedulerRebuildRequested = false;
let replacementSchedulerPriorityCredit = 0;
let replacementSchedulerGeneralCredit = 0;
let nextEconomyWakeAtMs = 0;
let schedulerMetrics = createSchedulerMetrics();
let sessionPopulationTarget = null;
let replacementCoverageCache = {
  actorCount: -1,
  capturedAtMs: 0,
  auditDurationMs: 0,
  value: null,
};
const persistenceDirtyActorIDs = new Set();
const persistenceDirtyFlightIDs = new Set();
const persistenceDirtyEncounterIDs = new Set();
const persistenceRemovedEncounterIDs = new Set();
let persistenceMetaDirty = false;
let persistenceRoamingDirty = false;
let persistenceEncounterReconcileRequired = false;
let persistenceFullRewriteRequired = false;
let persistenceMetrics = {
  checkpoints: 0,
  fullRewrites: 0,
  fallbackFullRewrites: 0,
  lastCheckpointAtMs: 0,
  lastStageDurationMs: 0,
  lastBatch: null,
};

function recordID(value, fieldName) {
  if (value && typeof value === "object") {
    return String(value[fieldName] || "").trim();
  }
  return String(value || "").trim();
}

function markMetaDirty() {
  dirty = true;
  persistenceMetaDirty = true;
}

function markRoamingDirty() {
  dirty = true;
  persistenceRoamingDirty = true;
  persistenceMetaDirty = true;
}

function markActorDirty(actorOrID) {
  const actorID = recordID(actorOrID, "actorID");
  if (!actorID) return;
  dirty = true;
  persistenceDirtyActorIDs.add(actorID);
}

function markActorsForFlightDirty(flight) {
  for (const actorID of Array.isArray(flight && flight.actorIDs)
    ? flight.actorIDs
    : []) {
    markActorDirty(actorID);
  }
}

function markFlightDirty(flightOrID, options = {}) {
  const flightID = recordID(flightOrID, "flightID");
  if (!flightID) return;
  dirty = true;
  persistenceDirtyFlightIDs.add(flightID);
  const flight = flightOrID && typeof flightOrID === "object"
    ? flightOrID
    : runtimeState && runtimeState.flights
      ? runtimeState.flights[flightID]
      : null;
  if (options.actors !== false && flight) {
    markActorsForFlightDirty(flight);
  }
}

function markEncounterDirty(encounterOrID) {
  const encounterID = recordID(encounterOrID, "encounterID");
  if (!encounterID) return;
  dirty = true;
  persistenceDirtyEncounterIDs.add(encounterID);
  persistenceRemovedEncounterIDs.delete(encounterID);
}

function markAllEncountersDirty() {
  dirty = true;
  persistenceEncounterReconcileRequired = true;
  for (const encounter of Object.values(runtimeState && runtimeState.encounters || {})) {
    markEncounterDirty(encounter);
  }
}

function markEncounterRemoved(encounterOrID) {
  const encounterID = recordID(encounterOrID, "encounterID");
  if (!encounterID) return;
  dirty = true;
  persistenceDirtyEncounterIDs.delete(encounterID);
  persistenceRemovedEncounterIDs.add(encounterID);
}

function markFullRewrite() {
  dirty = true;
  persistenceFullRewriteRequired = true;
  persistenceMetaDirty = true;
  persistenceRoamingDirty = true;
  persistenceEncounterReconcileRequired = true;
}

function clearPersistenceDirtyState() {
  persistenceDirtyActorIDs.clear();
  persistenceDirtyFlightIDs.clear();
  persistenceDirtyEncounterIDs.clear();
  persistenceRemovedEncounterIDs.clear();
  persistenceMetaDirty = false;
  persistenceRoamingDirty = false;
  persistenceEncounterReconcileRequired = false;
  persistenceFullRewriteRequired = false;
}

function buildPersistenceBatch() {
  const hasClassifiedEntityMutation =
    persistenceFullRewriteRequired ||
    persistenceRoamingDirty ||
    persistenceEncounterReconcileRequired ||
    persistenceDirtyActorIDs.size > 0 ||
    persistenceDirtyFlightIDs.size > 0 ||
    persistenceDirtyEncounterIDs.size > 0 ||
    persistenceRemovedEncounterIDs.size > 0;
  const fallbackFullRewrite = dirty && !hasClassifiedEntityMutation;
  return {
    fullRewrite: persistenceFullRewriteRequired || fallbackFullRewrite,
    fallbackFullRewrite,
    metaDirty: persistenceMetaDirty || dirty,
    roamingDirty: persistenceRoamingDirty,
    reconcileEncounterRows: persistenceEncounterReconcileRequired,
    dirtyActorIDs: [...persistenceDirtyActorIDs],
    dirtyFlightIDs: [...persistenceDirtyFlightIDs],
    dirtyEncounterIDs: [...persistenceDirtyEncounterIDs],
    removedEncounterIDs: [...persistenceRemovedEncounterIDs],
  };
}

function createSchedulerMetrics() {
  return {
    passes: 0,
    queueRebuilds: 0,
    queueRebuildsByReason: {},
    incrementalFlightReschedules: 0,
    dueFlightsProcessed: 0,
    replacementPriorityDueFlightsProcessed: 0,
    generalDueFlightsProcessed: 0,
    observedFlightsProcessed: 0,
    deferredDuePasses: 0,
    replacementPriorityDeferredDuePasses: 0,
    generalDeferredDuePasses: 0,
    replacementSchedulerContestedSelections: 0,
    replacementSchedulerPrioritySelections: 0,
    replacementSchedulerGeneralSelections: 0,
    replacementSchedulerWorkConservingSelections: 0,
    economyWakeups: 0,
    eventBackpressurePasses: 0,
    fullPilotSyncs: 0,
    incrementalPilotSyncs: 0,
    pilotRecordsSynced: 0,
    pilotSyncDeferredPasses: 0,
    lastPilotRecordsSynced: 0,
    maxDirtyPilotRecords: 0,
    totalPassDurationMs: 0,
    lastPassDurationMs: 0,
    maxPassDurationMs: 0,
    lastEconomyDispatchMs: 0,
    lastFlightWorkMs: 0,
    lastPilotSyncMs: 0,
    lastPersistenceMs: 0,
    lastDueFlightsProcessed: 0,
    lastReplacementPriorityDueFlightsProcessed: 0,
    lastGeneralDueFlightsProcessed: 0,
    lastObservedFlightsProcessed: 0,
    roamingPasses: 0,
    roamingTransitionsProcessed: 0,
    roamingContactsScheduled: 0,
    roamingContactsRejected: 0,
    roamingContactsExpired: 0,
    roamingContactsDeferred: 0,
    lastRoamingDispatchMs: 0,
    maxRoamingDispatchMs: 0,
    recentRoamingDispatchMs: [],
    recentPassDurationsMs: [],
  };
}

function getNpcService() {
  return require(path.join(__dirname, "../npcService"));
}

function getMiningNpcOperations() {
  return require(path.join(__dirname, "../../../services/mining/miningNpcOperations"));
}

function getMiningRuntimeState() {
  return require(path.join(__dirname, "../../../services/mining/miningRuntimeState"));
}

function getMiningResourceSiteService() {
  return require(path.join(__dirname, "../../../services/mining/miningResourceSiteService"));
}

function getItemTypeRegistry() {
  return require(path.join(__dirname, "../../../services/inventory/itemTypeRegistry"));
}

function getChatRuntime() {
  return require(path.join(__dirname, "../../../_secondary/chat/chatRuntime"));
}

function getScanMgrService() {
  return require(path.join(__dirname, "../../../services/exploration/scanMgrService"));
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../runtime"));
}

function getDroneRuntime() {
  return require(path.join(__dirname, "../../../services/drone/droneRuntime"));
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function cloneVector(vector, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(vector && vector.x, fallback.x),
    y: toFiniteNumber(vector && vector.y, fallback.y),
    z: toFiniteNumber(vector && vector.z, fallback.z),
  };
}

function addVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) + toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) + toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) + toFiniteNumber(right && right.z, 0),
  };
}

function scaleVector(vector, scalar) {
  return {
    x: toFiniteNumber(vector && vector.x, 0) * scalar,
    y: toFiniteNumber(vector && vector.y, 0) * scalar,
    z: toFiniteNumber(vector && vector.z, 0) * scalar,
  };
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const resolved = cloneVector(vector, fallback);
  const length = Math.sqrt((resolved.x ** 2) + (resolved.y ** 2) + (resolved.z ** 2));
  if (!Number.isFinite(length) || length <= 0.000001) {
    return cloneVector(fallback);
  }
  return scaleVector(resolved, 1 / length);
}

function distanceBetween(left, right) {
  const dx = toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0);
  const dy = toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0);
  const dz = toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0);
  return Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2));
}

function getPopulationTarget() {
  return Math.max(1, Math.min(
    5_000,
    toPositiveInt(sessionPopulationTarget, toPositiveInt(config.livingUniversePopulationSize, 400)),
  ));
}

function getPersistenceIntervalMs() {
  const actorCount = runtimeState
    ? Object.keys(runtimeState.actors || {}).length
    : getPopulationTarget();
  return Math.min(
    MAX_PERSIST_INTERVAL_MS,
    Math.max(PERSIST_INTERVAL_MS, Math.ceil(actorCount / 1_000) * PERSIST_INTERVAL_MS),
  );
}

function getSchedulerBudgetMs() {
  return Math.max(1, Math.min(50, toFiniteNumber(config.livingUniverseSchedulerBudgetMs, 8)));
}

function getMaxDueFlightsPerTick() {
  return Math.max(1, Math.min(1_000, toPositiveInt(config.livingUniverseMaxDueFlightsPerTick, 64)));
}

function getReplacementSchedulerSharePercent() {
  return Math.max(
    1,
    Math.min(
      99,
      toPositiveInt(config.livingUniverseReplacementSchedulerSharePercent, 75),
    ),
  );
}

function isRoamingConflictEnabled() {
  return (
    config.livingConflictEnabled === true &&
    config.livingConflictRoamingEnabled === true
  );
}

function getRoamingGroupLimit() {
  return Math.max(
    2,
    Math.min(512, toPositiveInt(config.livingConflictRoamingGroupLimit, 96)),
  );
}

function getRoamingTransitionLimit() {
  return Math.max(
    1,
    Math.min(128, toPositiveInt(config.livingConflictRoamingMaxTransitionsPerTick, 16)),
  );
}

function getRoamingPresenceCheckLimit() {
  return Math.max(
    8,
    Math.min(4_096, toPositiveInt(config.livingConflictRoamingMaxPresenceChecksPerTick, 192)),
  );
}

function getRoamingWorkBudgetMs() {
  return Math.max(
    0.25,
    Math.min(10, toFiniteNumber(config.livingConflictRoamingWorkBudgetMs, 1.5)),
  );
}

function getRoamingCampLimit() {
  return Math.max(
    1,
    Math.min(32, toPositiveInt(config.livingConflictGateCampLimit, 6)),
  );
}

function getPilotSyncBatchSize() {
  return Math.max(
    16,
    Math.min(1_000, toPositiveInt(config.livingUniversePilotSyncBatchSize, 128)),
  );
}

function getEconomyHoldWakeAtMs(flight, nowMs) {
  const watchdogJitterMs = Math.floor(
    deterministicUnit(flight && flight.flightID, "economy-hold-watchdog") * 60_000,
  );
  return nowMs + 60_000 + watchdogJitterMs;
}

function getDurationMs(key, fallbackSeconds, minimumSeconds = 1) {
  return Math.max(
    minimumSeconds * 1_000,
    toFiniteNumber(config[key], fallbackSeconds) * 1_000,
  );
}

function getOffGridActivityTimeMultiplier() {
  return Math.max(
    1,
    Math.min(
      100,
      toFiniteNumber(config.livingUniverseOffGridActivityTimeMultiplier, 1),
    ),
  );
}

function scaleOffGridActivityDurationMs(durationMs, minimumMs = 1_000) {
  return Math.max(
    minimumMs,
    Math.round(Math.max(minimumMs, toFiniteNumber(durationMs, minimumMs)) /
      getOffGridActivityTimeMultiplier()),
  );
}

function getDockedDwellMs() {
  return getDurationMs("livingUniverseDockedDwellSeconds", 180, 5);
}

function getVirtualDockedDwellMs() {
  return scaleOffGridActivityDurationMs(getDockedDwellMs());
}

function getDutyDwellMs() {
  return getDurationMs("livingUniverseDutyDwellSeconds", 300, 15);
}

function getVirtualDutyDwellMs() {
  return scaleOffGridActivityDurationMs(getDutyDwellMs());
}

function getTransitMs() {
  return getDurationMs("livingUniverseVirtualTransitSeconds", 18);
}

function getCrossingMs() {
  return getDurationMs("livingUniverseVirtualSystemDwellSeconds", 25);
}

function getActorShipTypeID(actor) {
  const storedTypeID = toPositiveInt(actor && actor.shipTypeID, 0);
  if (storedTypeID > 0) {
    return storedTypeID;
  }
  const profile = npcData.getNpcProfile(actor && actor.profileID);
  return toPositiveInt(profile && profile.shipTypeID, 0);
}

function calculateAlignTimeSeconds(movement) {
  const authored = toFiniteNumber(movement && movement.alignTime, 0);
  if (authored > 0) {
    return authored;
  }
  const mass = toFiniteNumber(movement && movement.mass, 0);
  const inertia = toFiniteNumber(movement && movement.inertia, 0);
  if (mass > 0 && inertia > 0) {
    return (DESTINY_ALIGN_LOG_DENOMINATOR * mass * inertia) / 1_000_000;
  }
  return 20;
}

function getFlightMovementProfiles(flight, state = runtimeState) {
  const profiles = getFlightActors(flight, state).map((actor) => {
    const typeID = getActorShipTypeID(actor);
    const movement = worldData.getMovementAttributesForType(typeID) || {};
    return {
      typeID,
      typeName: String(movement.typeName || `type ${typeID}`),
      maxVelocity: Math.max(1, toFiniteNumber(movement.maxVelocity, 120)),
      alignTimeSeconds: Math.max(0.5, calculateAlignTimeSeconds(movement)),
      warpSpeedAU: Math.max(0.1, toFiniteNumber(movement.warpSpeedMultiplier, 3)),
    };
  });
  return profiles.length > 0
    ? profiles
    : [{
        typeID: 0,
        typeName: "fallback hull",
        maxVelocity: 120,
        alignTimeSeconds: 20,
        warpSpeedAU: 3,
      }];
}

// This is the same acceleration/cruise/deceleration model used by the live
// space runtime's official warp reference profile. Virtual ships therefore
// spend the same modeled time in warp as their materialized hulls.
function estimateWarpDurationMs(distanceMeters, movement) {
  const totalDistance = Math.max(0, toFiniteNumber(distanceMeters, 0));
  const warpSpeedAU = Math.max(0.1, toFiniteNumber(movement && movement.warpSpeedAU, 3));
  const maxVelocity = Math.max(1, toFiniteNumber(movement && movement.maxVelocity, 120));
  const dropoutSpeedMs = Math.max(Math.min(maxVelocity / 2, WARP_DROPOUT_SPEED_MAX_MS), 1);
  const kAccel = warpSpeedAU;
  const kDecel = Math.min(warpSpeedAU / 3, 2);
  let maxWarpSpeedMs = warpSpeedAU * ONE_AU_IN_METERS;
  let accelDistance = maxWarpSpeedMs / kAccel;
  let decelDistance = maxWarpSpeedMs / kDecel;
  const minimumDistance = accelDistance + decelDistance;
  let cruiseTimeSeconds = 0;
  if (minimumDistance > totalDistance) {
    maxWarpSpeedMs = (totalDistance * kAccel * kDecel) /
      Math.max(kAccel + kDecel, 0.001);
    accelDistance = maxWarpSpeedMs / kAccel;
    decelDistance = maxWarpSpeedMs / kDecel;
  } else {
    cruiseTimeSeconds = Math.max(0, totalDistance - accelDistance - decelDistance) /
      maxWarpSpeedMs;
  }
  const accelTimeSeconds = Math.log(Math.max(maxWarpSpeedMs / kAccel, 1)) / kAccel;
  const decelTimeSeconds = Math.log(Math.max(maxWarpSpeedMs / dropoutSpeedMs, 1)) / kDecel;
  return Math.max(1_000, Math.ceil(
    (accelTimeSeconds + cruiseTimeSeconds + decelTimeSeconds) * 1_000,
  ));
}

function estimateSubwarpTravelMs(distanceMeters, movement) {
  const distance = Math.max(0, toFiniteNumber(distanceMeters, 0));
  const maxVelocity = Math.max(1, toFiniteNumber(movement && movement.maxVelocity, 120));
  const alignTimeSeconds = Math.max(
    0.5,
    toFiniteNumber(movement && movement.alignTimeSeconds, 20),
  );
  const tau = alignTimeSeconds / DESTINY_ALIGN_LOG_DENOMINATOR;
  const traveledAt = (seconds) => maxVelocity * (
    seconds - (tau * (1 - Math.exp(-seconds / tau)))
  );
  let low = 0;
  let high = Math.max(alignTimeSeconds, distance / maxVelocity);
  while (traveledAt(high) < distance && high < 3_600) {
    high *= 2;
  }
  for (let iteration = 0; iteration < 48; iteration += 1) {
    const middle = (low + high) / 2;
    if (traveledAt(middle) >= distance) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return Math.ceil(high * 1_000);
}

function estimatePoweredUndockMs(flight, state = runtimeState) {
  const leadMovement = getFlightMovementProfiles(flight, state)[0];
  const envelope = buildPoweredUndockEnvelope({
    maxVelocity: leadMovement.maxVelocity,
    alignTime: leadMovement.alignTimeSeconds,
  });
  const modeledTravelMs = estimateSubwarpTravelMs(
    envelope.clearanceMeters,
    leadMovement,
  );
  return Math.ceil(Math.min(
    envelope.maximumDurationMs,
    Math.max(envelope.minimumDurationMs, modeledTravelMs),
  ));
}

function estimateInSystemTravel(flight, fromAnchor, toAnchor, options = {}) {
  const state = options.state || runtimeState;
  const profiles = getFlightMovementProfiles(flight, state);
  const distanceMeters = distanceBetween(
    fromAnchor && fromAnchor.position,
    toAnchor && toAnchor.position,
  );
  const alignMs = Math.ceil(
    Math.max(...profiles.map((profile) => profile.alignTimeSeconds * 1_000)) + 500,
  );
  const warpMs = Math.max(
    ...profiles.map((profile) => estimateWarpDurationMs(distanceMeters, profile)),
  );
  const poweredUndockMs = options.poweredUndock === true
    ? estimatePoweredUndockMs(flight, state)
    : 0;
  const ingressMs = options.ingress === true
    ? ARRIVAL_INGRESS_MS + ARRIVAL_DWELL_MS
    : 0;
  const destinationDwellMs = options.destinationKind === "gate"
    ? GATE_DWELL_MS
    : options.destinationKind === "station"
      ? ARRIVAL_DWELL_MS
      : 0;
  const totalMs = Math.ceil(
    poweredUndockMs + ingressMs + alignMs + warpMs + destinationDwellMs,
  );
  return {
    totalMs,
    distanceMeters,
    distanceAU: distanceMeters / ONE_AU_IN_METERS,
    poweredUndockMs,
    ingressMs,
    alignMs,
    warpMs,
    destinationDwellMs,
    hulls: profiles.map((profile) => ({
      typeID: profile.typeID,
      typeName: profile.typeName,
      alignTimeSeconds: profile.alignTimeSeconds,
      warpSpeedAU: profile.warpSpeedAU,
    })),
  };
}

function getReplacementMs() {
  return getDurationMs("livingUniverseReplacementDelaySeconds", 300, 10);
}

function getVirtualReplacementMs() {
  return scaleOffGridActivityDurationMs(getReplacementMs());
}

function getPerSystemPhysicalCap() {
  return npcPhysicalBudget.getLimits().perSystem;
}

function getGlobalPhysicalCap() {
  return npcPhysicalBudget.getLimits().global;
}

function getMaterializationBatchLimit() {
  return Math.max(1, toPositiveInt(config.livingUniverseMaterializationsPerTick, 2));
}

function findGateToSystem(sourceSystemID, destinationSystemID) {
  return worldData.getStargatesForSystem(sourceSystemID).find((gate) => (
    toPositiveInt(gate && gate.destinationSolarSystemID, 0) === toPositiveInt(destinationSystemID, 0)
  )) || null;
}

function resolveRouteEndpointRecord(endpointID, endpointAnchor = null) {
  const station = worldData.getStationByID(endpointID);
  if (station) return station;
  if (endpointAnchor && String(endpointAnchor.kind || "") !== "structure") return null;
  const structure = structureState.getStructureByID(endpointID, { refresh: false });
  return structure && !structure.destroyedAt ? structure : null;
}

function normalizeRouteTravelAnchor(value, itemID) {
  if (!value || !value.position) return null;
  return {
    ...value,
    itemID: toPositiveInt(value.itemID, toPositiveInt(itemID, 0)),
    position: {
      x: toFiniteNumber(value.position.x, 0),
      y: toFiniteNumber(value.position.y, 0),
      z: toFiniteNumber(value.position.z, 0),
    },
    direction: normalizeVector(value.direction, { x: 1, y: 0, z: 0 }),
    radius: Math.max(1, toFiniteNumber(value.radius, 3_000)),
  };
}

function resolveRouteTravelAnchor(route, itemID) {
  const normalizedID = toPositiveInt(itemID, 0);
  if (!normalizedID) return null;
  const gate = worldData.getStargateByID(normalizedID);
  if (gate) return gate;
  for (const edge of route && Array.isArray(route.edges) ? route.edges : []) {
    if (toPositiveInt(edge.sourceGateID, 0) === normalizedID) {
      const anchor = normalizeRouteTravelAnchor(edge.sourceAnchor, normalizedID);
      if (anchor) return anchor;
    }
    if (toPositiveInt(edge.destinationGateID, 0) === normalizedID) {
      const anchor = normalizeRouteTravelAnchor(edge.destinationAnchor, normalizedID);
      if (anchor) return anchor;
    }
  }
  try {
    return require(path.join(
      __dirname,
      "../../../services/exploration/wormholes/wormholeRuntime",
    )).getEndpointEntityByID(normalizedID);
  } catch (_error) {
    return null;
  }
}

function buildRouteDefinitions() {
  routeDefinitionsByID.clear();
  for (const spec of ALL_NETWORK_ROUTE_SPECS) {
    const edges = [];
    let valid = true;
    for (let index = 0; index < spec.systemIDs.length - 1; index += 1) {
      const sourceSystemID = spec.systemIDs[index];
      const destinationSystemID = spec.systemIDs[index + 1];
      const sourceGate = findGateToSystem(sourceSystemID, destinationSystemID);
      const destinationGate = findGateToSystem(destinationSystemID, sourceSystemID);
      if (!sourceGate || !destinationGate) {
        valid = false;
        log.warn(`[LivingUniverse] Invalid route edge ${sourceSystemID} -> ${destinationSystemID}.`);
        break;
      }
      edges.push({
        sourceSystemID,
        destinationSystemID,
        sourceGateID: sourceGate.itemID,
        destinationGateID: destinationGate.itemID,
      });
    }
    const stations = spec.endpointStationIDs.map((stationID) => worldData.getStationByID(stationID));
    if (!valid || stations.some((station) => !station)) {
      continue;
    }
    routeDefinitionsByID.set(spec.routeID, {
      ...spec,
      kind: "network",
      edges,
      systems: spec.systemIDs.map((systemID) => worldData.getSolarSystemByID(systemID)),
      stations,
    });
  }
  for (const spec of ALL_DUTY_ROUTE_SPECS) {
    const system = worldData.getSolarSystemByID(spec.systemID);
    const station = worldData.getStationByID(spec.stationID);
    const dutyAnchor = spec.generatedResourceSite === true
      ? {
          itemID: spec.dutyAnchorID,
          position: {
            x: toFiniteNumber(station && station.position && station.position.x, 0) + 120_000,
            y: toFiniteNumber(station && station.position && station.position.y, 0),
            z: toFiniteNumber(station && station.position && station.position.z, 0),
          },
          direction: { x: 1, y: 0, z: 0 },
          radius: 1,
          kind: "generatedMiningSite",
        }
      : worldData.getAsteroidBeltsForSystem(spec.systemID).find(
          (belt) => toPositiveInt(belt && belt.itemID, 0) === spec.dutyAnchorID,
        );
    if (!system || !station || !dutyAnchor) {
      log.warn(`[LivingUniverse] Invalid duty route ${spec.routeID}.`);
      continue;
    }
    routeDefinitionsByID.set(spec.routeID, {
      ...spec,
      kind: "duty",
      systemIDs: [spec.systemID],
      systems: [system],
      station,
      dutyAnchor,
    });
  }
  return routeDefinitionsByID;
}

function registerDynamicFreightRoute(spec) {
  if (
    !spec ||
    !Array.isArray(spec.systemIDs) ||
    spec.systemIDs.length < 2 ||
    !Array.isArray(spec.endpointStationIDs) ||
    spec.endpointStationIDs.length !== 2
  ) {
    return null;
  }
  const routeID = String(spec.routeID || "").trim();
  if (!routeID) return null;
  const existing = routeDefinitionsByID.get(routeID);
  if (existing) return existing;
  const typedEdges = new Map(
    (Array.isArray(spec.typedEdges) ? spec.typedEdges : []).map((edge) => [
      Math.trunc(Number(edge && edge.index)),
      edge,
    ]),
  );
  const edges = [];
  for (let index = 0; index < spec.systemIDs.length - 1; index += 1) {
    const sourceSystemID = toPositiveInt(spec.systemIDs[index], 0);
    const destinationSystemID = toPositiveInt(spec.systemIDs[index + 1], 0);
    const typedEdge = typedEdges.get(index);
    if (typedEdge && String(typedEdge.kind || "") === "wormhole") {
      const sourceAnchorID = toPositiveInt(typedEdge.sourceAnchorID, 0);
      const destinationAnchorID = toPositiveInt(typedEdge.destinationAnchorID, 0);
      if (
        Number(typedEdge.sourceSystemID) !== sourceSystemID ||
        Number(typedEdge.destinationSystemID) !== destinationSystemID ||
        !sourceAnchorID ||
        !destinationAnchorID
      ) {
        return null;
      }
      edges.push({
        sourceSystemID,
        destinationSystemID,
        sourceGateID: sourceAnchorID,
        destinationGateID: destinationAnchorID,
        sourceAnchor: normalizeRouteTravelAnchor(
          typedEdge.sourceAnchor,
          sourceAnchorID,
        ),
        destinationAnchor: normalizeRouteTravelAnchor(
          typedEdge.destinationAnchor,
          destinationAnchorID,
        ),
        edgeKind: "wormhole",
        pairID: String(typedEdge.pairID || "") || null,
      });
      continue;
    }
    const sourceGate = findGateToSystem(sourceSystemID, destinationSystemID);
    const destinationGate = findGateToSystem(destinationSystemID, sourceSystemID);
    if (!sourceGate || !destinationGate) return null;
    edges.push({
      sourceSystemID,
      destinationSystemID,
      sourceGateID: sourceGate.itemID,
      destinationGateID: destinationGate.itemID,
      edgeKind: "stargate",
    });
  }
  const endpointAnchors = Array.isArray(spec.endpointAnchors) ? spec.endpointAnchors : [];
  const stations = spec.endpointStationIDs.map(
    (stationID, index) => resolveRouteEndpointRecord(stationID, endpointAnchors[index]),
  );
  if (stations.some((station) => !station)) return null;
  const route = {
    ...spec,
    routeID,
    kind: "network",
    dynamic: true,
    edges,
    systems: spec.systemIDs.map((systemID) => worldData.getSolarSystemByID(systemID)),
    stations,
  };
  routeDefinitionsByID.set(routeID, route);
  return route;
}

function assignFreightRoute(flight, spec, nowMs = Date.now(), options = {}) {
  if (!flight) return false;
  const route = registerDynamicFreightRoute(spec);
  if (!route) return false;
  const dynamicRouteSpec = {
    routeID: route.routeID,
    systemIDs: [...route.systemIDs],
    endpointStationIDs: [...route.endpointStationIDs],
    endpointAnchors: Array.isArray(route.endpointAnchors)
      ? route.endpointAnchors.map((entry) => ({ ...entry }))
      : undefined,
    typedEdges: Array.isArray(route.typedEdges)
      ? route.typedEdges.map((entry) => ({ ...entry }))
      : undefined,
    familyEstate: route.familyEstate === true,
    riskBand: route.riskBand,
    routeClass: route.routeClass,
    lowSecurity: route.lowSecurity === true,
    allowedLogisticsClasses: [...(route.allowedLogisticsClasses || [])],
    dynamic: true,
  };

  if (options.preserveProgress === true) {
    const currentSystemIndex = route.systemIDs.findIndex(
      (systemID) => Number(systemID) === Number(flight.currentSystemID),
    );
    if (currentSystemIndex < 0) return false;
    flight.routeID = route.routeID;
    flight.dynamicRouteSpec = dynamicRouteSpec;
    flight.routeClass = route.routeClass;
    flight.riskBand = route.riskBand;
    if (
      !Number.isInteger(Number(flight.currentNodeIndex)) ||
      Number(route.systemIDs[Number(flight.currentNodeIndex)]) !==
        Number(flight.currentSystemID)
    ) {
      flight.currentNodeIndex = currentSystemIndex;
    }
    if (![1, -1].includes(Number(flight.direction))) flight.direction = 1;
    flight.lastTransitionReason = "dynamic-economy-route-recovered";
    for (const actor of getFlightActors(flight)) {
      dirtyPilotActorIDs.add(actor.actorID);
    }
    markFlightDirty(flight);
    rescheduleChangedFlight(flight, nowMs);
    return true;
  }

  if (
    String(flight.phase || "") !== PHASE.DOCKED ||
    flight.materialized ||
    Number(flight.currentSystemID) !== Number(route.systemIDs[0])
  ) {
    return false;
  }
  flight.routeID = route.routeID;
  flight.dynamicRouteSpec = dynamicRouteSpec;
  flight.routeClass = route.routeClass;
  flight.riskBand = route.riskBand;
  flight.currentNodeIndex = 0;
  flight.direction = 1;
  flight.currentSystemID = route.systemIDs[0];
  flight.nextTransitionAtMs = Math.min(
    toFiniteNumber(flight.nextTransitionAtMs, nowMs + 5_000),
    nowMs + 5_000,
  );
  flight.lastTransitionReason = "dynamic-economy-route-assigned";
  for (const actor of getFlightActors(flight)) {
    dirtyPilotActorIDs.add(actor.actorID);
  }
  syncActorSystem(flight);
  markFlightDirty(flight);
  rescheduleChangedFlight(flight, nowMs);
  return true;
}

function expandGroupProfiles(spawnGroupID) {
  const group = npcData.getNpcSpawnGroup(spawnGroupID);
  if (!group || !Array.isArray(group.entries)) {
    throw new Error(`Living-universe spawn group not found: ${spawnGroupID}`);
  }
  const profiles = [];
  for (const entry of group.entries) {
    const count = Math.max(1, toPositiveInt(entry && entry.count, 1));
    for (let index = 0; index < count; index += 1) {
      const profile = npcData.getNpcProfile(entry.profileID);
      const loadout = profile ? npcData.getNpcLoadout(profile.loadoutID) : null;
      if (!profile || !loadout || !loadout.governance) {
        throw new Error(`Living-universe governed profile is incomplete: ${entry.profileID}`);
      }
      profiles.push({ profile, loadout });
    }
  }
  return profiles;
}

function chooseBandGroup(family, index, total) {
  const percentile = total > 0 ? ((index + 0.5) / total) * 100 : 0;
  if (family === "hauler") {
    return percentile <= 55
      ? LIVING_UNIVERSE_GROUPS.haulerCivilian
      : percentile <= 82
        ? LIVING_UNIVERSE_GROUPS.haulerStandard
        : percentile <= 94
          ? LIVING_UNIVERSE_GROUPS.haulerBulk
          : percentile <= 99
            ? LIVING_UNIVERSE_GROUPS.haulerSecure
            : LIVING_UNIVERSE_GROUPS.haulerTrunk;
  }
  if (family === "convoy") {
    return LIVING_UNIVERSE_GROUPS.convoySecure;
  }
  if (family === "miner") {
    return percentile <= 47
      ? LIVING_UNIVERSE_GROUPS.minerStandard
      : percentile <= 67
        ? LIVING_UNIVERSE_GROUPS.minerVeteran
        : percentile <= 80
          ? LIVING_UNIVERSE_GROUPS.minerCorporate
          : percentile <= 87
            ? LIVING_UNIVERSE_GROUPS.minerLowsec
            : percentile <= 94
              ? LIVING_UNIVERSE_GROUPS.minerIce
              : LIVING_UNIVERSE_GROUPS.minerElite;
  }
  if (family === "police") {
    return percentile <= 90
      ? LIVING_UNIVERSE_GROUPS.policeStandard
      : percentile <= 98
        ? LIVING_UNIVERSE_GROUPS.policeElite
        : LIVING_UNIVERSE_GROUPS.policeCommand;
  }
  if (family === "pirate") {
    return percentile <= 62
      ? LIVING_UNIVERSE_GROUPS.pirateStandard
      : percentile <= 87
        ? LIVING_UNIVERSE_GROUPS.pirateVeteran
        : percentile <= 98
          ? LIVING_UNIVERSE_GROUPS.pirateElite
          : LIVING_UNIVERSE_GROUPS.pirateCommand;
  }
  return LIVING_UNIVERSE_GROUPS.shuttle;
}

function deterministicUnit(...parts) {
  const text = parts.map((part) => String(part)).join("|");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

function chooseHomeNodeIndex(route, flightID, nowMs) {
  if (!route || route.kind === "duty") {
    return 0;
  }
  const lastIndex = route.systemIDs.length - 1;
  const jitaIndex = route.endpointStationIDs.findIndex((stationID) => Number(stationID) === 60003760);
  if (jitaIndex >= 0) {
    const remoteIndex = jitaIndex === 0 ? lastIndex : 0;
    return deterministicUnit(nowMs, flightID, "home-station") < 0.2
      ? jitaIndex
      : remoteIndex;
  }
  return deterministicUnit(nowMs, flightID, "home-station") < 0.5 ? 0 : lastIndex;
}

function resolveFlightOrigin(route, family, flightID, nowMs, options = {}) {
  const homeNodeIndex = chooseHomeNodeIndex(route, flightID, nowMs);
  const homeStationID = route.kind === "duty"
    ? route.stationID
    : getEndpointStationID(route, homeNodeIndex);
  const homeStation = worldData.getStationByID(homeStationID);
  const homeSystemID = route.kind === "duty"
    ? route.systemID
    : route.systemIDs[homeNodeIndex];
  const homeSystem = worldData.getSolarSystemByID(homeSystemID);
  const affiliation = livingAffiliations.resolveAffiliation({
    family,
    station: homeStation,
    system: homeSystem,
    seed: `${nowMs}:${flightID}`,
    pirateFactionKey: options.pirateFactionKey,
  });
  return {
    homeNodeIndex,
    homeStationID,
    homeStationName: String(homeStation && homeStation.stationName || `Station ${homeStationID}`),
    homeSystemID,
    homeSystemName: String(homeSystem && homeSystem.solarSystemName || `System ${homeSystemID}`),
    homeStationCorporationID: affiliation.stationCorporationID,
    corporationID: affiliation.corporationID,
    corporationName: affiliation.corporationName,
    factionID: affiliation.factionID,
    factionName: affiliation.factionName,
    raceID: affiliation.raceID,
    profession: affiliation.profession,
  };
}

function getRouteMinimumSecurity(route) {
  const securities = (Array.isArray(route && route.systemIDs) ? route.systemIDs : [])
    .map((systemID) => toFiniteNumber(worldData.getSolarSystemByID(systemID)?.security, 1));
  return securities.length > 0 ? Math.min(...securities) : 1;
}

function getPirateGroupKeyForSecurity(security) {
  const normalized = toFiniteNumber(security, 1);
  if (normalized >= 0.8) return regionalTrafficDoctrines.GROUP_KEYS.pirateStandard;
  if (normalized >= 0.45) return regionalTrafficDoctrines.GROUP_KEYS.pirateVeteran;
  if (normalized >= 0.1) return regionalTrafficDoctrines.GROUP_KEYS.pirateElite;
  return regionalTrafficDoctrines.GROUP_KEYS.pirateCommand;
}

function resolvePirateFactionKey(route, seed) {
  const systemIDs = Array.isArray(route && route.systemIDs) ? route.systemIDs : [];
  for (const systemID of systemIDs) {
    const resolved = beltRatRuntime.resolvePirateFactionKeyForSystem(systemID);
    if (SUPPORTED_PIRATE_FACTION_KEYS.includes(resolved)) return resolved;
  }
  const index = Math.min(
    SUPPORTED_PIRATE_FACTION_KEYS.length - 1,
    Math.floor(deterministicUnit(seed, route && route.routeID, "pirate-faction") * SUPPORTED_PIRATE_FACTION_KEYS.length),
  );
  return SUPPORTED_PIRATE_FACTION_KEYS[Math.max(0, index)] || "guristas";
}

function getRegionalGroupKey(family, legacyGroupID, route) {
  const groups = LIVING_UNIVERSE_GROUPS;
  const keys = regionalTrafficDoctrines.GROUP_KEYS;
  if (family === "shuttle") return keys.shuttle;
  if (family === "convoy") return keys.convoySecure;
  if (family === "hauler") {
    if (legacyGroupID === groups.haulerCivilian) return keys.haulerCivilian;
    if (legacyGroupID === groups.haulerStandard) return keys.haulerStandard;
    if (legacyGroupID === groups.haulerBulk) return keys.haulerBulk;
    if (legacyGroupID === groups.haulerSecure) return keys.haulerSecure;
    return keys.haulerTrunk;
  }
  if (family === "police") {
    if (legacyGroupID === groups.policeStandard) return keys.policeStandard;
    if (legacyGroupID === groups.policeElite) return keys.policeElite;
    return keys.policeCommand;
  }
  if (family === "pirate") {
    return getPirateGroupKeyForSecurity(getRouteMinimumSecurity(route));
  }
  return null;
}

function buildActorCapabilities(role) {
  const normalized = String(role || "traffic");
  const capabilitiesByRole = {
    shuttle: ["shuttle", "courier", "trade"],
    hauler: ["freight", "courier", "trade", "shuttle"],
    escort: ["escort", "patrol", "security_response", "courier"],
    police: ["patrol", "security_response", "escort"],
    miner: ["mining", "resource_survey", "industrial_haul", "shuttle"],
    mining_support: ["mining_support", "industrial_haul", "fleet_boost", "shuttle"],
    highsec_pirate: ["raiding", "combat", "smuggling", "scouting"],
  };
  return [...(capabilitiesByRole[normalized] || [normalized])];
}

function setFlightSystem(state, flight, systemID) {
  flight.currentSystemID = toPositiveInt(systemID, flight.currentSystemID);
  for (const actorID of Array.isArray(flight.actorIDs) ? flight.actorIDs : []) {
    if (state.actors[actorID]) {
      state.actors[actorID].currentSystemID = flight.currentSystemID;
    }
  }
}

function setRandomizedInitialTravel(
  state,
  flight,
  phase,
  estimate,
  nowMs,
  progress,
  reason,
) {
  const durationMs = Math.max(1_000, toFiniteNumber(estimate && estimate.totalMs, 1_000));
  const normalizedProgress = Math.max(0, Math.min(0.9, toFiniteNumber(progress, 0)));
  const elapsedMs = Math.floor(durationMs * normalizedProgress);
  const remainingMs = Math.max(1_000, durationMs - elapsedMs);
  flight.phase = phase;
  flight.nextTransitionAtMs = nowMs + remainingMs;
  flight.virtualTravel = {
    phase,
    startedAtMs: nowMs - elapsedMs,
    arrivesAtMs: flight.nextTransitionAtMs,
    durationMs,
    reason,
    randomizedResetProgress: normalizedProgress,
    ...(estimate || {}),
  };
  flight.lastTransitionReason = reason;
}

function randomizeNetworkFlightStart(state, flight, route, nowMs) {
  const phaseRoll = deterministicUnit(nowMs, flight.flightID, "phase");
  const progress = deterministicUnit(nowMs, flight.flightID, "progress") * 0.9;
  const lastIndex = route.systemIDs.length - 1;
  const originIndex = Number.isInteger(flight.homeNodeIndex) ? flight.homeNodeIndex : 0;
  const destinationIndex = originIndex === 0 ? lastIndex : 0;
  const travelDirection = originIndex === 0 ? 1 : -1;
  flight.currentNodeIndex = originIndex;
  flight.direction = travelDirection;
  setFlightSystem(state, flight, route.systemIDs[originIndex]);

  if (phaseRoll < 0.28) {
    const dwellMs = Math.max(
      5_000,
      Math.floor(getVirtualDockedDwellMs() * deterministicUnit(nowMs, flight.flightID, "dwell")),
    );
    flight.phase = PHASE.DOCKED;
    flight.nextTransitionAtMs = nowMs + dwellMs;
    flight.virtualTravel = null;
    flight.lastTransitionReason = "randomized-reset-docked";
    return;
  }

  if (phaseRoll < 0.54) {
    const station = worldData.getStationByID(getEndpointStationID(route, originIndex));
    const gate = resolveRouteTravelAnchor(route, getOutgoingGateID(route, flight));
    const estimate = station && gate
      ? estimateInSystemTravel(flight, station, gate, {
          poweredUndock: true,
          destinationKind: "gate",
          state,
        })
      : { totalMs: getCrossingMs() };
    setRandomizedInitialTravel(
      state,
      flight,
      PHASE.VIRTUAL_DEPARTURE,
      estimate,
      nowMs,
      progress,
      "randomized-reset-station-departure",
    );
    return;
  }

  if (phaseRoll < 0.73) {
    const edgeIndex = Math.min(
      route.edges.length - 1,
      Math.floor(deterministicUnit(nowMs, flight.flightID, "edge") * route.edges.length),
    );
    const direction = travelDirection;
    const nodeIndex = direction > 0 ? edgeIndex + 1 : edgeIndex;
    flight.currentNodeIndex = nodeIndex;
    flight.direction = direction;
    setFlightSystem(state, flight, route.systemIDs[nodeIndex]);
    setRandomizedInitialTravel(
      state,
      flight,
      PHASE.VIRTUAL_TRANSIT,
      { totalMs: getTransitMs() },
      nowMs,
      progress,
      "randomized-reset-gate-session",
    );
    return;
  }

  if (phaseRoll < 0.88 && route.systemIDs.length > 2) {
    const interiorCount = route.systemIDs.length - 2;
    const nodeIndex = 1 + Math.min(
      interiorCount - 1,
      Math.floor(deterministicUnit(nowMs, flight.flightID, "interior") * interiorCount),
    );
    const direction = travelDirection;
    flight.currentNodeIndex = nodeIndex;
    flight.direction = direction;
    setFlightSystem(state, flight, route.systemIDs[nodeIndex]);
    const incomingGate = resolveRouteTravelAnchor(route, getIncomingGateID(route, flight));
    const outgoingGate = resolveRouteTravelAnchor(route, getOutgoingGateID(route, flight));
    const estimate = incomingGate && outgoingGate
      ? estimateInSystemTravel(flight, incomingGate, outgoingGate, {
          ingress: true,
          destinationKind: "gate",
          state,
        })
      : { totalMs: getCrossingMs() };
    setRandomizedInitialTravel(
      state,
      flight,
      PHASE.VIRTUAL_CROSSING,
      estimate,
      nowMs,
      progress,
      "randomized-reset-system-crossing",
    );
    return;
  }

  flight.currentNodeIndex = destinationIndex;
  flight.direction = travelDirection;
  setFlightSystem(state, flight, route.systemIDs[destinationIndex]);
  const incomingGate = resolveRouteTravelAnchor(route, getIncomingGateID(route, flight));
  const station = worldData.getStationByID(getEndpointStationID(route, destinationIndex));
  const estimate = incomingGate && station
    ? estimateInSystemTravel(flight, incomingGate, station, {
        ingress: true,
        destinationKind: "station",
        state,
      })
    : { totalMs: getCrossingMs() };
  setRandomizedInitialTravel(
    state,
    flight,
    PHASE.VIRTUAL_STATION_APPROACH,
    estimate,
    nowMs,
    progress,
    "randomized-reset-station-approach",
  );
}

function randomizeDutyFlightStart(state, flight, route, nowMs) {
  const phaseRoll = deterministicUnit(nowMs, flight.flightID, "duty-phase");
  const progress = deterministicUnit(nowMs, flight.flightID, "duty-progress") * 0.9;
  flight.currentNodeIndex = 0;
  setFlightSystem(state, flight, route.systemID);

  if (phaseRoll < 0.28) {
    const dwellMs = Math.max(
      5_000,
      Math.floor(getVirtualDockedDwellMs() * deterministicUnit(nowMs, flight.flightID, "duty-dwell")),
    );
    flight.phase = PHASE.DOCKED;
    flight.nextTransitionAtMs = nowMs + dwellMs;
    flight.virtualTravel = null;
    flight.lastTransitionReason = "randomized-reset-miner-docked";
    return;
  }

  if (phaseRoll < 0.56) {
    const estimate = estimateInSystemTravel(flight, route.station, route.dutyAnchor, {
      poweredUndock: true,
      destinationKind: "duty",
      state,
    });
    setRandomizedInitialTravel(
      state,
      flight,
      PHASE.VIRTUAL_DUTY_DEPARTURE,
      estimate,
      nowMs,
      progress,
      "randomized-reset-miner-departure",
    );
    return;
  }

  if (phaseRoll < 0.84) {
    const dutyRemainingMs = Math.max(
      60_000,
      Math.floor(getVirtualDutyDwellMs() * (0.2 + (
        deterministicUnit(nowMs, flight.flightID, "duty-remaining") * 0.8
      ))),
    );
    flight.phase = PHASE.DUTY;
    flight.nextTransitionAtMs = nowMs + dutyRemainingMs;
    flight.virtualTravel = null;
    flight.lastTransitionReason = "randomized-reset-miner-duty";
    return;
  }

  const estimate = estimateInSystemTravel(flight, route.dutyAnchor, route.station, {
    destinationKind: "station",
    state,
  });
  setRandomizedInitialTravel(
    state,
    flight,
    PHASE.VIRTUAL_DUTY_RETURN,
    estimate,
    nowMs,
    progress,
    "randomized-reset-empty-miner-return",
  );
}

function randomizeInitialFlightStart(state, flight, route, nowMs) {
  if (route.kind === "duty") {
    randomizeDutyFlightStart(state, flight, route, nowMs);
    return;
  }
  randomizeNetworkFlightStart(state, flight, route, nowMs);
}

function choosePopulationRouteSpec({
  family,
  familyIndex,
  nowMs,
  profileRows,
}) {
  const governanceRows = profileRows.map((row) => row.loadout.governance || {});
  let routePool;
  if (family === "miner") {
    const miningProfile = governanceRows.find((row) => row.miningProfile) || {};
    const resourceFamily = String(
      miningProfile.miningProfile && miningProfile.miningProfile.resourceFamily || "ore",
    );
    const lowSecurityOperation = String(
      miningProfile.miningProfile && miningProfile.miningProfile.operatingBand || "",
    ) === "lowsec";
    routePool = ALL_DUTY_ROUTE_SPECS.filter((route) => (
      String(route.resourceFamily || "ore") === resourceFamily &&
      (lowSecurityOperation ? route.riskBand !== "highsec" : route.riskBand === "highsec")
    ));
  } else if (family === "pirate") {
    routePool = PIRATE_ROUTE_SPECS;
  } else if (family === "police") {
    // Keep one quarter of patrols in ordinary high-security circulation and
    // place the rest on the active fronts where they can be witnessed.
    routePool = familyIndex % 4 === 0
      ? NETWORK_ROUTE_SPECS.filter((route) => route.lowSecurity !== true)
      : PIRATE_ROUTE_SPECS.filter((route) => route.lowSecurity === true);
  } else {
    const logisticsProfile = governanceRows.find((row) => row.logisticsProfile);
    if (logisticsProfile && logisticsProfile.logisticsProfile.lowSecurityAccess === true) {
      routePool = NETWORK_ROUTE_SPECS.filter((route) => route.lowSecurity === true);
    } else {
      routePool = NETWORK_ROUTE_SPECS.filter((route) => route.lowSecurity !== true);
      const logisticsClass = logisticsProfile
        ? String(logisticsProfile.logisticsProfile.logisticsClass || "feeder")
        : null;
      if (logisticsClass === "feeder") {
        routePool = routePool.filter((route) => (
          route.routeClass === "feeder" || route.routeClass === "regional"
        ));
      } else if (logisticsClass === "regional") {
        routePool = routePool.filter((route) => (
          route.routeClass === "feeder" ||
          route.routeClass === "regional" ||
          route.routeClass === "bulk"
        ));
      } else if (logisticsClass === "trunk") {
        routePool = routePool.filter((route) => (
          route.routeClass === "trunk" || route.routeClass === "bulk"
        ));
      }
    }
  }
  if (!["miner", "pirate", "police"].includes(family)) {
    const logisticsProfile = governanceRows.find((row) => row.logisticsProfile);
    const logisticsClass = logisticsProfile
      ? String(logisticsProfile.logisticsProfile.logisticsClass || "feeder")
      : null;
    if (logisticsClass) {
      routePool = routePool.filter((route) => {
        const economyRoute = livingEconomyCatalog.getRoute(route.routeID) || route;
        return Array.isArray(economyRoute.allowedLogisticsClasses) &&
          economyRoute.allowedLogisticsClasses.includes(logisticsClass);
      });
    }
  }
  if (!Array.isArray(routePool) || routePool.length <= 0) {
    throw new Error(`No living-universe route is available for ${family}.`);
  }
  const offset = Math.floor(
    deterministicUnit(nowMs, family, "route-offset") * routePool.length,
  );
  return routePool[((familyIndex * 997) + offset) % routePool.length];
}

function buildPopulationPlan(targetCount, nowMs = Date.now()) {
  buildRouteDefinitions();
  const target = Math.max(1, toPositiveInt(targetCount, 400));
  // High-security freight relies on the guaranteed law-enforcement response.
  // Only the small frontier convoy pool carries dedicated escorts; the ships
  // released from high-sec escort duty become police, miners and hostile
  // pressure that create useful work and replacement demand.
  const pirateShips = Math.floor((target * 0.19) / 4) * 4;
  const minerShips = Math.floor((target * 0.24) / 4) * 4;
  const policeShips = Math.floor((target * 0.15) / 3) * 3;
  const desiredEscortShips = Math.floor((target * 0.02) / 2) * 2;
  const convoyFlights = Math.floor(desiredEscortShips / 2);
  const convoyShips = convoyFlights * 3;
  const desiredHaulers = Math.floor(target * 0.32);
  const soloHaulers = Math.max(0, desiredHaulers - convoyFlights);
  const minerFlights = Math.floor(minerShips / 4);
  const policeFlights = Math.floor(policeShips / 3);
  const pirateFlights = Math.floor(pirateShips / 4);
  const reserved = soloHaulers + convoyShips + minerShips + policeShips + pirateShips;
  const shuttleFlights = Math.max(0, target - reserved);
  const templates = [
    { family: "shuttle", count: shuttleFlights, size: 1 },
    { family: "hauler", count: soloHaulers, size: 1 },
    { family: "convoy", count: convoyFlights, size: 3 },
    { family: "police", count: policeFlights, size: 3 },
    { family: "miner", count: minerFlights, size: 4 },
    { family: "pirate", count: pirateFlights, size: 4 },
  ];
  const state = livingStateStore.buildDefaultState();
  state.populationRevision = POPULATION_REVISION;
  state.populationSize = target;
  state.createdAtMs = nowMs;
  state.updatedAtMs = nowMs;
  let actorNumber = 0;
  let flightNumber = 0;

  for (const template of templates) {
    for (let familyIndex = 0; familyIndex < template.count; familyIndex += 1) {
      const routingSpawnGroupID = chooseBandGroup(template.family, familyIndex, template.count);
      const routingProfileRows = expandGroupProfiles(routingSpawnGroupID);
      if (routingProfileRows.length !== template.size) {
        throw new Error(
          `Living-universe group ${routingSpawnGroupID} contains ${routingProfileRows.length} ships; expected ${template.size}.`,
        );
      }
      flightNumber += 1;
      const flightID = `living_flight_${String(flightNumber).padStart(4, "0")}`;
      const routeSpec = choosePopulationRouteSpec({
        family: template.family,
        familyIndex,
        nowMs,
        profileRows: routingProfileRows,
      });
      const route = routeDefinitionsByID.get(routeSpec.routeID);
      const pirateFactionKey = template.family === "pirate"
        ? resolvePirateFactionKey(route, flightID)
        : null;
      const origin = resolveFlightOrigin(route, template.family, flightID, nowMs, {
        pirateFactionKey,
      });
      const regionalGroupKey = getRegionalGroupKey(
        template.family,
        routingSpawnGroupID,
        route,
      );
      const spawnGroupID = template.family === "pirate"
        ? regionalTrafficDoctrines.getPirateGroupID(pirateFactionKey, regionalGroupKey)
        : regionalGroupKey
          ? regionalTrafficDoctrines.getEmpireGroupID(origin.raceID, regionalGroupKey, origin.factionID)
          : routingSpawnGroupID;
      const profileRows = expandGroupProfiles(spawnGroupID || routingSpawnGroupID);
      if (profileRows.length !== template.size) {
        throw new Error(
          `Regional living-universe group ${spawnGroupID} contains ${profileRows.length} ships; expected ${template.size}.`,
        );
      }
      const actorIDs = [];
      for (const row of profileRows) {
        actorNumber += 1;
        const actorID = `living_actor_${String(actorNumber).padStart(4, "0")}`;
        actorIDs.push(actorID);
        state.actors[actorID] = {
          actorID,
          flightID,
          profileID: row.profile.profileID,
          shipTypeID: toPositiveInt(row.profile.shipTypeID, 0),
          doctrineID: row.loadout.governance.doctrineID,
          role: row.loadout.governance.role,
          capabilities: buildActorCapabilities(row.loadout.governance.role),
          currentAssignment: template.family,
          equipmentBand: row.loadout.governance.equipmentBand,
          logisticsProfile: row.loadout.governance.logisticsProfile || null,
          miningProfile: row.loadout.governance.miningProfile || null,
          miningSupportProfile: row.loadout.governance.miningSupportProfile || null,
          pilotSkills: Array.isArray(row.loadout.governance.pilotSkills)
            ? row.loadout.governance.pilotSkills
            : [],
          droneBay: Array.isArray(row.loadout.governance.droneBay)
            ? row.loadout.governance.droneBay
            : [],
          survivabilityProfile: row.loadout.governance.survivabilityProfile || null,
          homeStationID: origin.homeStationID,
          homeStationName: origin.homeStationName,
          homeSystemID: origin.homeSystemID,
          homeSystemName: origin.homeSystemName,
          homeStationCorporationID: origin.homeStationCorporationID,
          corporationID: origin.corporationID,
          corporationName: origin.corporationName,
          factionID: origin.factionID,
          factionName: origin.factionName,
          raceID: origin.raceID,
          pirateFactionKey,
          profession: origin.profession,
          currentSystemID: route.systemIDs[familyIndex % route.systemIDs.length],
          state: "virtual",
          liveEntityID: 0,
          tripsCompleted: 0,
          losses: 0,
          replacementCount: 0,
        };
      }
      const initialNodeIndex = 0;
      const initialPhase = PHASE.DOCKED;
      const leadGovernance = profileRows[0].loadout.governance || {};
      const supportGovernance = profileRows
        .map((row) => row.loadout.governance || {})
        .find((governance) => governance.miningSupportProfile) || null;
      const miningGovernance = profileRows
        .map((row) => row.loadout.governance || {})
        .find((governance) => governance.miningProfile) || null;
      state.flights[flightID] = {
        flightID,
        family: template.family,
        spawnGroupID,
        routeID: route.routeID,
        dynamicRouteSpec: route.generatedRegionalHubRoute === true
          ? {
              routeID: route.routeID,
              systemIDs: [...route.systemIDs],
              endpointStationIDs: [...route.endpointStationIDs],
              riskBand: route.riskBand,
              routeClass: route.routeClass,
              lowSecurity: route.lowSecurity === true,
              allowedLogisticsClasses: [...(route.allowedLogisticsClasses || [])],
              generatedRegionalHubRoute: true,
              dynamic: true,
            }
          : null,
        routeClass: route.routeClass || (route.kind === "duty" ? "industrial" : "feeder"),
        riskBand: route.riskBand || "highsec",
        minimumSecurity: getRouteMinimumSecurity(route),
        doctrineFactionKey: pirateFactionKey || regionalTrafficDoctrines.getEmpireKeyForAffiliation(
          origin.factionID,
          origin.raceID,
        ),
        campaignID: route.campaignID || null,
        campaignName: route.campaignName || null,
        campaignIntensity: toFiniteNumber(route.campaignIntensity, 0),
        logisticsProfile: leadGovernance.logisticsProfile || null,
        miningSupportProfile: supportGovernance && supportGovernance.miningSupportProfile || null,
        resourceFamily:
          miningGovernance && miningGovernance.miningProfile
            ? String(miningGovernance.miningProfile.resourceFamily || "ore")
            : null,
        actorIDs,
        homeNodeIndex: origin.homeNodeIndex,
        homeStationID: origin.homeStationID,
        homeStationName: origin.homeStationName,
        homeSystemID: origin.homeSystemID,
        homeSystemName: origin.homeSystemName,
        homeCorporationID: origin.corporationID,
        homeCorporationName: origin.corporationName,
        homeFactionID: origin.factionID,
        homeFactionName: origin.factionName,
        currentNodeIndex: initialNodeIndex,
        currentSystemID: route.systemIDs[initialNodeIndex],
        direction: 1,
        phase: initialPhase,
        nextTransitionAtMs: nowMs + getVirtualDockedDwellMs(),
        materialized: false,
        physicalReservationID: null,
        entityIDs: [],
        leadEntityID: 0,
        poweredUndock: null,
        warpPlan: null,
        miningFleetID: 0,
        miningCycleNumber: 0,
        miningManifest: null,
        freightJobID: null,
        virtualTravel: null,
        lastTransitionReason: "distributed-population-created",
        lastError: null,
      };
      randomizeInitialFlightStart(state, state.flights[flightID], route, nowMs);
    }
  }
  if (actorNumber !== target) {
    throw new Error(`Living-universe population plan created ${actorNumber} actors; expected ${target}.`);
  }
  initializeRoamingConflictState(state, nowMs);
  return state;
}

function getSceneWithPlayers(runtime, systemID) {
  if (!runtime || !(runtime.scenes instanceof Map)) {
    return null;
  }
  const scene = runtime.scenes.get(toPositiveInt(systemID, 0)) || null;
  return scene && scene.sessions instanceof Map && scene.sessions.size > 0 ? scene : null;
}

function getSceneAnchor(scene, itemID) {
  const normalizedID = toPositiveInt(itemID, 0);
  if (!scene || !normalizedID) {
    return null;
  }
  if (typeof scene.getEntityByID === "function") {
    const entity = scene.getEntityByID(normalizedID);
    if (entity) {
      return entity;
    }
  }
  return Array.isArray(scene.staticEntities)
    ? scene.staticEntities.find((entity) => toPositiveInt(entity && entity.itemID, 0) === normalizedID) || null
    : null;
}

function getDutySceneAnchor(scene, route) {
  let anchor = getSceneAnchor(scene, route && route.dutyAnchorID);
  if (
    anchor ||
    !scene ||
    !route ||
    route.generatedResourceSite !== true
  ) {
    return anchor;
  }
  // A player can wake an ice system before its universe-seeded anomaly has
  // finished reconciling. Re-run only the lightweight resource-site materializer
  // when the authored anchor is absent; existing depletion remains in the mining
  // ledger and addStaticEntity prevents duplicates.
  scene._miningResourceSitesInitialized = false;
  getMiningResourceSiteService().handleSceneCreated(scene);
  anchor = getSceneAnchor(scene, route.dutyAnchorID);
  return anchor;
}

function getFlightActors(flight, state = runtimeState) {
  return (Array.isArray(flight && flight.actorIDs) ? flight.actorIDs : [])
    .map((actorID) => state && state.actors[actorID])
    .filter(Boolean);
}

function mergeOreEntries(entries) {
  const byTypeID = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const typeID = toPositiveInt(entry && entry.typeID, 0);
    const quantity = toPositiveInt(entry && entry.quantity, 0);
    if (typeID <= 0 || quantity <= 0) {
      continue;
    }
    const typeRecord = getItemTypeRegistry().resolveItemByTypeID(typeID) || {};
    const current = byTypeID.get(typeID) || {
      typeID,
      typeName: String(entry && (entry.typeName || entry.itemName) || typeRecord.name || `type ${typeID}`),
      quantity: 0,
      volume: Math.max(
        0,
        toFiniteNumber(entry && entry.volume, toFiniteNumber(typeRecord.volume, 0)),
      ),
    };
    current.quantity += quantity;
    byTypeID.set(typeID, current);
  }
  return [...byTypeID.values()].sort((left, right) => left.typeID - right.typeID);
}

function ensureMiningManifest(flight, route, nowMs) {
  if (flight.family !== "miner") {
    return null;
  }
  const current = flight.miningManifest;
  if (
    current &&
    !current.depositedAtMs &&
    !["delivered", "empty", "lost"].includes(String(current.depositStatus || ""))
  ) {
    return current;
  }
  const cycleNumber = Math.max(0, toPositiveInt(flight.miningCycleNumber, 0)) + 1;
  const populationRunID = toPositiveInt(runtimeState && runtimeState.createdAtMs, nowMs);
  flight.miningCycleNumber = cycleNumber;
  const inferredStartAtMs = nowMs;
  flight.miningManifest = {
    cycleID:
      `${flight.flightID}:mining:${populationRunID}:` +
      String(cycleNumber).padStart(6, "0"),
    cycleNumber,
    systemID: route.systemID,
    beltID: route.dutyAnchorID,
    resourceFamily: String(route.resourceFamily || flight.resourceFamily || "ore"),
    startedAtMs: inferredStartAtMs,
    completedAtMs: 0,
    source: "pending",
    ore: [],
    totalVolumeM3: 0,
    depositID: null,
    depositStatus: null,
    depositedAtMs: 0,
    activityTimeMultiplier: getOffGridActivityTimeMultiplier(),
    lastError: null,
  };
  markFlightDirty(flight);
  return flight.miningManifest;
}

function estimateFlightMiningVolume(flight, durationMs) {
  const resourceFamily = String(flight && flight.resourceFamily || "ore");
  const estimates = getFlightActors(flight)
    .filter((actor) => String(actor && actor.role || "") === "miner")
    .map((actor) => {
    const profile = npcData.getNpcProfile(actor.profileID) || {};
    const loadout = npcData.getNpcLoadout(profile.loadoutID) || {};
    return getMiningNpcOperations().estimateNpcMiningVolume({
      shipTypeID: getActorShipTypeID(actor),
      modules: loadout.modules,
      durationMs,
      resourceFamily,
      supportBonus: flight && flight.miningSupportProfile,
    });
  });
  return {
    durationMs,
    estimatedVolumeM3: estimates.reduce(
      (sum, estimate) => sum + toFiniteNumber(estimate.estimatedVolumeM3, 0),
      0,
    ),
    resourceFamily,
    supportProfile: flight && flight.miningSupportProfile || null,
    hulls: estimates,
  };
}

function buildVirtualMiningAllocations(candidates, requestedVolumeM3, maximumTargets = 12) {
  const allocations = [];
  let remainingVolumeM3 = Math.max(0, toFiniteNumber(requestedVolumeM3, 0));
  for (const state of candidates.slice(0, Math.max(1, maximumTargets))) {
    if (remainingVolumeM3 <= 0) {
      break;
    }
    const unitVolume = Math.max(0.000001, toFiniteNumber(state && state.unitVolume, 0));
    const availableQuantity = toPositiveInt(state && state.remainingQuantity, 0);
    const requestedQuantity = Math.min(
      availableQuantity,
      Math.floor(remainingVolumeM3 / unitVolume),
    );
    if (requestedQuantity <= 0) {
      continue;
    }
    allocations.push({
      entityID: toPositiveInt(state.entityID, 0),
      requestedQuantity,
    });
    remainingVolumeM3 -= requestedQuantity * unitVolume;
  }
  return allocations.filter((allocation) => allocation.entityID > 0);
}

function completeVirtualMiningDuty(runtime, route, flight, nowMs) {
  const manifest = ensureMiningManifest(flight, route, nowMs);
  if (!manifest || manifest.completedAtMs > 0) {
    return true;
  }
  const physicalElapsedMs = manifest.physicalCapturedAtMs
    ? Math.max(0, manifest.physicalCapturedAtMs - manifest.startedAtMs)
    : 0;
  const elapsedDutyMs = Math.max(
    0,
    nowMs - toFiniteNumber(manifest.startedAtMs, nowMs),
  );
  const activityTimeMultiplier = Math.max(
    1,
    toFiniteNumber(
      manifest.activityTimeMultiplier,
      getOffGridActivityTimeMultiplier(),
    ),
  );
  const simulatedDurationMs = Math.min(
    getDutyDwellMs(),
    Math.max(0, elapsedDutyMs - physicalElapsedMs) * activityTimeMultiplier,
  );
  const estimate = estimateFlightMiningVolume(flight, simulatedDurationMs);
  manifest.virtualEstimate = estimate;
  if (estimate.estimatedVolumeM3 <= 0) {
    manifest.completedAtMs = nowMs;
    manifest.depositStatus = manifest.ore.length > 0 ? null : "empty";
    manifest.lastError = "NO_MINING_YIELD";
    markFlightDirty(flight);
    return true;
  }

  const miningState = getMiningRuntimeState();
  const resourceFamily = String(route.resourceFamily || manifest.resourceFamily || "ore");
  const candidates = Object.values(
    miningState.readPersistedSystemEntities(route.systemID) || {},
  )
    .filter((state) => (
      state &&
      toPositiveInt(state.beltID, 0) === route.dutyAnchorID &&
      toPositiveInt(state.remainingQuantity, 0) > 0 &&
      String(state.yieldKind || "ore") === resourceFamily
    ))
    .sort((left, right) => toPositiveInt(left.entityID, 0) - toPositiveInt(right.entityID, 0));
  const candidatesByEntityID = new Map(
    candidates.map((state) => [toPositiveInt(state.entityID, 0), state]),
  );
  const allocations = buildVirtualMiningAllocations(
    candidates,
    estimate.estimatedVolumeM3,
  );
  if (allocations.length <= 0) {
    manifest.completedAtMs = nowMs;
    manifest.depositStatus = manifest.ore.length > 0 ? null : "empty";
    manifest.lastError = "NO_PERSISTED_BELT_RESOURCES";
    markFlightDirty(flight);
    return true;
  }

  const transactionID = `${manifest.cycleID}:virtual`;
  const result = miningState.applyPersistedMiningBatch({
    transactionID,
    eventID: flight.flightID,
    systemID: route.systemID,
    beltID: route.dutyAnchorID,
    allocations,
  }, {
    nowMs,
    isSystemSceneLoaded(systemID) {
      const scene = runtime && runtime.scenes instanceof Map
        ? runtime.scenes.get(toPositiveInt(systemID, 0)) || null
        : null;
      return Boolean(scene && scene.sessions instanceof Map && scene.sessions.size > 0);
    },
  });
  if (!result.success) {
    manifest.lastError = result.errorMsg || "VIRTUAL_MINING_FAILED";
    if (["SYSTEM_BUSY", "PERSISTENCE_FAILED", "PERSISTENCE_WRITE_FAILED"].includes(manifest.lastError)) {
      markFlightDirty(flight);
      return false;
    }
    manifest.completedAtMs = nowMs;
    manifest.depositStatus = manifest.ore.length > 0 ? null : "empty";
    markFlightDirty(flight);
    return true;
  }

  const loadedScene = runtime && runtime.scenes instanceof Map
    ? runtime.scenes.get(route.systemID) || null
    : null;
  if (
    loadedScene &&
    (!loadedScene.sessions || loadedScene.sessions.size <= 0) &&
    typeof miningState.syncPersistedMiningBatchToScene === "function"
  ) {
    const syncResult = miningState.syncPersistedMiningBatchToScene(loadedScene, result.data, {
      broadcast: false,
      nowMs,
    });
    if (!syncResult || syncResult.success !== true) {
      manifest.lastError = syncResult && syncResult.errorMsg || "LOADED_SCENE_MINING_SYNC_FAILED";
    }
  }

  const ore = [];
  for (const row of Array.isArray(result.data && result.data.results) ? result.data.results : []) {
    const quantity = toPositiveInt(row && row.acceptedQuantity, 0);
    const state = candidatesByEntityID.get(toPositiveInt(row && row.entityID, 0)) || {};
    const typeID = toPositiveInt(row && row.yieldTypeID, toPositiveInt(state.yieldTypeID, 0));
    if (typeID <= 0 || quantity <= 0) {
      continue;
    }
    const typeRecord = getItemTypeRegistry().resolveItemByTypeID(typeID) || {};
    ore.push({
      typeID,
      typeName: String(typeRecord.name || `type ${typeID}`),
      quantity,
      volume: Math.max(
        0,
        toFiniteNumber(state.unitVolume, toFiniteNumber(typeRecord.volume, 0)),
      ),
    });
  }
  manifest.ore = mergeOreEntries([...(manifest.ore || []), ...ore]);
  manifest.totalVolumeM3 = manifest.ore.reduce(
    (sum, entry) => sum + (entry.quantity * entry.volume),
    0,
  );
  manifest.source = manifest.physicalCapturedAtMs ? "physical+virtual" : "virtual";
  manifest.virtualTransactionID = transactionID;
  manifest.completedAtMs = nowMs;
  manifest.depositStatus = manifest.ore.length > 0 ? null : "empty";
  manifest.lastError = null;
  markFlightDirty(flight);
  return true;
}

function capturePhysicalMiningCargo(runtime, route, flight, nowMs, options = {}) {
  const manifest = ensureMiningManifest(flight, route, nowMs);
  if (!manifest) {
    return null;
  }
  const scene = runtime && runtime.scenes instanceof Map
    ? runtime.scenes.get(toPositiveInt(flight && flight.currentSystemID, 0)) || null
    : null;
  if (toPositiveInt(flight && flight.miningFleetID, 0) > 0) {
    getMiningNpcOperations().finalizeOnGridMiningSupport(
      scene,
      flight.miningFleetID,
      { nowMs },
    );
  }
  const ore = getLiveEntities(runtime, flight).flatMap(
    (entity) => getMiningNpcOperations().getNpcOreCargoItems(entity).map((entry) => ({
      typeID: toPositiveInt(entry && entry.typeID, 0),
      typeName: String(entry && (entry.itemName || entry.typeName) || ""),
      quantity: toPositiveInt(entry && (entry.quantity ?? entry.stacksize), 0),
      volume: Math.max(0, toFiniteNumber(entry && entry.volume, 0)),
    })),
  );
  manifest.ore = mergeOreEntries(ore);
  manifest.totalVolumeM3 = manifest.ore.reduce(
    (sum, entry) => sum + (entry.quantity * entry.volume),
    0,
  );
  manifest.source = "physical";
  manifest.physicalCapturedAtMs = nowMs;
  if (options.complete === true) {
    manifest.completedAtMs = nowMs;
    manifest.depositStatus = manifest.ore.length > 0 ? null : "empty";
  }
  manifest.lastError = null;
  markFlightDirty(flight);
  return manifest;
}

function buildMiningCargoOverrides(flight) {
  const actors = getFlightActors(flight);
  const minerIndexes = actors
    .map((actor, index) => String(actor && actor.role || "") === "miner" ? index : -1)
    .filter((index) => index >= 0);
  const overrides = actors.map(() => undefined);
  const ore = mergeOreEntries(flight && flight.miningManifest && flight.miningManifest.ore);
  if (minerIndexes.length <= 0 || ore.length <= 0) {
    return overrides;
  }
  for (const index of minerIndexes) {
    overrides[index] = [];
  }
  for (const entry of ore) {
    const baseQuantity = Math.floor(entry.quantity / minerIndexes.length);
    const remainder = entry.quantity % minerIndexes.length;
    minerIndexes.forEach((actorIndex, minerIndex) => {
      const quantity = baseQuantity + (minerIndex < remainder ? 1 : 0);
      if (quantity > 0) {
        overrides[actorIndex].push({
          typeID: entry.typeID,
          quantity,
          singleton: false,
          cargoPurpose: "living_mining_manifest",
        });
      }
    });
  }
  return overrides;
}

function syncActorSystem(flight) {
  for (const actor of getFlightActors(flight)) {
    // System, phase and assignment all affect Local presence. A caller may be
    // changing duty without changing systems, so always refresh these few
    // flight members rather than leaving a stale online/offline classification.
    dirtyPilotActorIDs.add(actor.actorID);
    actor.currentSystemID = flight.currentSystemID;
    actor.state = flight.materialized ? "materialized" : "virtual";
    markActorDirty(actor);
  }
}

function resolveFlightAssignment(flight) {
  if (!flight) return "idle";
  if (flight.encounterID) return "combat";
  if (flight.roamingGroupID) {
    if (flight.roamingPhase === livingRoamingKernel.PHASE.CAMPING) return "gate_camp";
    if (String(flight.family || "") === "police") return "counter_roam";
    return "roaming";
  }
  if (flight.campaignID && String(flight.family || "") === "pirate") return "combat";
  if (flight.freightJobID) return "freight";
  if (String(flight.family || "") === "miner") return "mining";
  if (String(flight.family || "") === "police") return "patrol";
  if (String(flight.family || "") === "convoy") return "escort";
  if (String(flight.family || "") === "pirate") return "raiding";
  if (String(flight.family || "") === "shuttle") return "courier";
  return String(flight.family || "idle");
}

function buildPilotPresenceProjectionKey(flight) {
  if (!flight) return "";
  const route = routeDefinitionsByID.get(flight.routeID) || null;
  const docked =
    String(flight.phase || "") === PHASE.DOCKED &&
    flight.materialized !== true;
  const stationID = docked
    ? toPositiveInt(
        route ? getEndpointStationID(route, flight.currentNodeIndex) : 0,
        toPositiveInt(flight.homeStationID, 0),
      )
    : 0;
  return [
    toPositiveInt(flight.currentSystemID, 0),
    stationID,
    docked
      ? "docked_offline"
      : flight.materialized
        ? "in_space_materialized"
        : "in_space_virtual",
    docked ? "available" : resolveFlightAssignment(flight),
  ].join(":");
}

function resolveActorPresence(actor) {
  const flight = actor && runtimeState && runtimeState.flights
    ? runtimeState.flights[actor.flightID] || null
    : null;
  const solarSystemID = toPositiveInt(
    flight && flight.currentSystemID,
    toPositiveInt(actor && actor.currentSystemID, 0),
  );
  if (!flight) {
    return {
      solarSystemID,
      stationID: null,
      state: "offline",
      localVisible: false,
      assignment: "unassigned",
    };
  }
  const route = routeDefinitionsByID.get(flight.routeID) || null;
  const docked = String(flight.phase || "") === PHASE.DOCKED && flight.materialized !== true;
  const stationID = docked
    ? toPositiveInt(
        route ? getEndpointStationID(route, flight.currentNodeIndex) : 0,
        toPositiveInt(flight.homeStationID, toPositiveInt(actor && actor.homeStationID, 0)),
      )
    : 0;
  return {
    solarSystemID,
    stationID: stationID || null,
    state: docked ? "docked_offline" : (flight.materialized ? "in_space_materialized" : "in_space_virtual"),
    // A persistent identity is not automatically an online character. Docked
    // flights waiting for work or their next shift remain real people with a
    // real station location, but do not phantom-populate Local.
    localVisible: !docked,
    assignment: docked ? "available" : resolveFlightAssignment(flight),
  };
}

function takeDirtyPilotActorIDs(limit = getPilotSyncBatchSize()) {
  const maximum = Math.max(1, toPositiveInt(limit, getPilotSyncBatchSize()));
  const selected = [];
  const selectedIDs = new Set();
  const append = (actorID) => {
    if (selected.length >= maximum || selectedIDs.has(actorID)) return;
    selected.push(actorID);
    selectedIDs.add(actorID);
  };

  // Pilots a player can currently see must never sit behind a large backlog
  // of off-grid transitions. The Set's insertion order preserves the
  // observed-flight-first scheduler order within each priority class.
  for (const actorID of dirtyPilotActorIDs) {
    const actor = runtimeState && runtimeState.actors
      ? runtimeState.actors[actorID]
      : null;
    const flight = actor && runtimeState && runtimeState.flights
      ? runtimeState.flights[actor.flightID]
      : null;
    if (flight && flight.materialized === true) append(actorID);
    if (selected.length >= maximum) return selected;
  }
  for (const actorID of dirtyPilotActorIDs) {
    append(actorID);
    if (selected.length >= maximum) break;
  }
  return selected;
}

function syncPilotPresence(options = {}) {
  if (options.clear === true || !runtimeState) {
    livingPilotDirectory.clear({ sourceID: PILOT_SOURCE_ID });
    dirtyPilotActorIDs.clear();
    const chatRuntime = getChatRuntime();
    if (typeof chatRuntime.syncSyntheticLocalMembers === "function") {
      chatRuntime.syncSyntheticLocalMembers([], { sourceID: PILOT_SOURCE_ID });
    }
    schedulerMetrics.lastPilotRecordsSynced = 0;
    return { fullSync: false, selected: 0, synced: 0, deferred: 0 };
  }

  const fullSync = options.full === true || !schedulerInitialized;
  const selectedActorIDs = fullSync
    ? Object.keys(runtimeState.actors || {})
    : takeDirtyPilotActorIDs(options.batchSize);
  const changedActors = selectedActorIDs
      .map((actorID) => runtimeState.actors[actorID])
      .filter(Boolean);
  if (!fullSync && changedActors.length <= 0) {
    for (const actorID of selectedActorIDs) dirtyPilotActorIDs.delete(actorID);
    schedulerMetrics.lastPilotRecordsSynced = 0;
    return {
      fullSync: false,
      selected: selectedActorIDs.length,
      synced: 0,
      deferred: dirtyPilotActorIDs.size,
    };
  }
  const syncOptions = {
    sourceID: PILOT_SOURCE_ID,
    getProfile: (profileID) => npcData.getNpcProfile(profileID),
    resolvePresence: resolveActorPresence,
  };
  const syncResult = fullSync
    ? livingPilotDirectory.syncActors(changedActors, syncOptions)
    : livingPilotDirectory.syncActorChanges(changedActors, syncOptions);
  if (fullSync) {
    dirtyPilotActorIDs.clear();
  } else {
    for (const actorID of selectedActorIDs) dirtyPilotActorIDs.delete(actorID);
  }
  if (syncResult.identitiesChanged) {
    for (const actorID of selectedActorIDs) {
      markActorDirty(actorID);
    }
  }
  const chatRuntime = getChatRuntime();
  if (fullSync && typeof chatRuntime.syncSyntheticLocalMembers === "function") {
    chatRuntime.syncSyntheticLocalMembers(syncResult.pilots, {
      sourceID: PILOT_SOURCE_ID,
    });
  } else if (typeof chatRuntime.upsertSyntheticLocalMembers === "function") {
    chatRuntime.upsertSyntheticLocalMembers(syncResult.pilots, {
      sourceID: PILOT_SOURCE_ID,
    });
  }
  schedulerMetrics.fullPilotSyncs += fullSync ? 1 : 0;
  schedulerMetrics.incrementalPilotSyncs += fullSync ? 0 : 1;
  schedulerMetrics.pilotRecordsSynced += syncResult.pilots.length;
  schedulerMetrics.lastPilotRecordsSynced = syncResult.pilots.length;
  schedulerMetrics.maxDirtyPilotRecords = Math.max(
    schedulerMetrics.maxDirtyPilotRecords,
    selectedActorIDs.length + dirtyPilotActorIDs.size,
  );
  if (!fullSync && dirtyPilotActorIDs.size > 0) {
    schedulerMetrics.pilotSyncDeferredPasses += 1;
  }
  return {
    fullSync,
    selected: selectedActorIDs.length,
    synced: syncResult.pilots.length,
    deferred: dirtyPilotActorIDs.size,
  };
}

function countMaterialized() {
  const perSystem = new Map();
  let global = 0;
  for (const flight of Object.values(runtimeState && runtimeState.flights || {})) {
    if (flight.materialized !== true) {
      continue;
    }
    const count = Array.isArray(flight.entityIDs) ? flight.entityIDs.length : 0;
    global += count;
    perSystem.set(flight.currentSystemID, (perSystem.get(flight.currentSystemID) || 0) + count);
  }
  return { global, perSystem };
}

function canMaterialize(flight, options = {}) {
  if (
    options.ignoreMaterializationBatchLimit !== true &&
    materializationsThisTick >= getMaterializationBatchLimit()
  ) {
    return false;
  }
  const requested = Array.isArray(flight.actorIDs) ? flight.actorIDs.length : 1;
  return npcPhysicalBudget.canReserve({
    reservationID: getPhysicalReservationID(flight),
    ownerKind: OPERATOR_KIND,
    ownerID: flight.flightID,
    systemID: flight.currentSystemID,
    shipCount: requested,
  });
}

function getPhysicalReservationID(flight) {
  return `living-universe:${String(flight && flight.flightID || "unknown")}`;
}

function reservePhysicalFlight(flight, shipCount) {
  const result = npcPhysicalBudget.reserve({
    reservationID: getPhysicalReservationID(flight),
    ownerKind: OPERATOR_KIND,
    ownerID: flight.flightID,
    systemID: flight.currentSystemID,
    shipCount,
    priority: 10,
    metadata: {
      family: String(flight.family || "unknown"),
      routeID: String(flight.routeID || ""),
    },
  });
  if (result.success) {
    flight.physicalReservationID = result.reservation.reservationID;
    markFlightDirty(flight, { actors: false });
  }
  return result;
}

function releasePhysicalFlightBudget(flight) {
  const reservationID = String(
    flight && flight.physicalReservationID || getPhysicalReservationID(flight),
  );
  const released = npcPhysicalBudget.getReservation(reservationID)
    ? npcPhysicalBudget.release(reservationID)
    : false;
  if (flight) {
    flight.physicalReservationID = null;
    markFlightDirty(flight, { actors: false });
  }
  return released;
}

function getLiveEntities(runtime, flight) {
  const scene = runtime && runtime.scenes instanceof Map
    ? runtime.scenes.get(toPositiveInt(flight && flight.currentSystemID, 0)) || null
    : null;
  if (!scene) {
    return [];
  }
  return (Array.isArray(flight && flight.entityIDs) ? flight.entityIDs : [])
    .map((entityID) => scene.getEntityByID(toPositiveInt(entityID, 0)))
    .filter(Boolean);
}

function isConflictLossEligibleActor(actor) {
  return Boolean(
    actor &&
    String(actor.role || "") !== "mining_support" &&
    livingEconomyCatalog.getGood(actor.shipTypeID),
  );
}

function isConflictFlightEligible(flight, state = runtimeState) {
  const actors = getFlightActors(flight, state);
  return actors.some(isConflictLossEligibleActor) &&
    !livingEconomyRuntime.shouldHoldReplacementFlight(flight);
}

function scaleRoamingRange(minMs, maxMs, minimumMs) {
  return {
    minMs: scaleOffGridActivityDurationMs(minMs, minimumMs),
    maxMs: scaleOffGridActivityDurationMs(maxMs, minimumMs),
  };
}

function getRoamingRouteCandidates() {
  const routes = [...routeDefinitionsByID.values()]
    .filter((route) => (
      route &&
      route.kind === "network" &&
      route.dynamic !== true &&
      Array.isArray(route.systemIDs) &&
      route.systemIDs.length >= 2 &&
      Array.isArray(route.edges) &&
      route.edges.length === route.systemIDs.length - 1
    ));
  return routes.sort((left, right) => (
    Number(Boolean(right.campaignID)) - Number(Boolean(left.campaignID)) ||
    Number(String(left.riskBand || "highsec") === "highsec") -
      Number(String(right.riskBand || "highsec") === "highsec") ||
    String(left.routeID).localeCompare(String(right.routeID))
  ));
}

function buildRoamingTaskGroupRows(state) {
  const routes = getRoamingRouteCandidates();
  if (routes.length <= 0) return [];
  const limit = getRoamingGroupLimit();
  const pirateFlights = Object.values(state && state.flights || {})
    .filter((flight) => (
      String(flight && flight.family || "") === "pirate" &&
      isConflictFlightEligible(flight, state)
    ))
    .sort((left, right) => String(left.flightID).localeCompare(String(right.flightID)));
  const policeFlights = Object.values(state && state.flights || {})
    .filter((flight) => (
      String(flight && flight.family || "") === "police" &&
      isConflictFlightEligible(flight, state)
    ))
    .sort((left, right) => String(left.flightID).localeCompare(String(right.flightID)));
  const pirateFlightsByRouteID = new Map();
  const policeFlightsByRouteID = new Map();
  for (const flight of pirateFlights) {
    const routeID = String(flight.routeID || "");
    if (!pirateFlightsByRouteID.has(routeID)) pirateFlightsByRouteID.set(routeID, []);
    pirateFlightsByRouteID.get(routeID).push(flight);
  }
  for (const flight of policeFlights) {
    const routeID = String(flight.routeID || "");
    if (!policeFlightsByRouteID.has(routeID)) policeFlightsByRouteID.set(routeID, []);
    policeFlightsByRouteID.get(routeID).push(flight);
  }
  // Pair groups already authored for the same theater. This preserves pirate
  // regional identity and empire doctrine while still distributing the first
  // slice evenly across all active fronts.
  const routeBuckets = routes
    .map((route) => ({
      route,
      pirates: pirateFlightsByRouteID.get(String(route.routeID)) || [],
      police: policeFlightsByRouteID.get(String(route.routeID)) || [],
    }))
    .filter((bucket) => bucket.pirates.length > 0 && bucket.police.length > 0);
  const pairs = [];
  const maximumPairs = Math.floor(limit / 2);
  for (let layer = 0; pairs.length < maximumPairs; layer += 1) {
    let added = 0;
    for (const bucket of routeBuckets) {
      if (pairs.length >= maximumPairs) break;
      if (!bucket.pirates[layer] || !bucket.police[layer]) continue;
      pairs.push({
        route: bucket.route,
        pirate: bucket.pirates[layer],
        police: bucket.police[layer],
      });
      added += 1;
    }
    if (added <= 0) break;
  }
  const rows = [];
  const transitFallbackMs = scaleOffGridActivityDurationMs(
    getTransitMs() + getCrossingMs(),
    5_000,
  );
  for (let index = 0; index < pairs.length; index += 1) {
    const { route, pirate, police } = pairs[index];
    const pirateGroupID = `roaming_${pirate.flightID}`;
    const policeGroupID = `roaming_${police.flightID}`;
    const gateIDs = route.edges.map((edge) => toPositiveInt(edge.sourceGateID, 0) || "");
    const reverseGateIDs = route.edges.map(
      (edge) => toPositiveInt(edge.destinationGateID, 0) || "",
    );
    const transitMsByEdge = route.edges.map((_edge, edgeIndex) => {
      const variance = 0.85 + (
        deterministicUnit(route.routeID, edgeIndex, "roaming-transit") * 0.3
      );
      const centerMs = Math.max(5_000, Math.round(transitFallbackMs * variance));
      return {
        minMs: Math.max(5_000, Math.round(centerMs * 0.85)),
        maxMs: Math.max(5_000, Math.round(centerMs * 1.15)),
      };
    });
    const edgeWeights = route.edges.map((edge) => {
      const sourceSecurity = toFiniteNumber(
        worldData.getSolarSystemByID(edge.sourceSystemID)?.security,
        1,
      );
      const destinationSecurity = toFiniteNumber(
        worldData.getSolarSystemByID(edge.destinationSystemID)?.security,
        1,
      );
      const security = Math.min(sourceSecurity, destinationSecurity);
      return security <= 0
        ? 2.5
        : security < 0.5
          ? 1.75
          : security < 0.8
            ? 0.75
            : 0.25;
    });
    const sharedRoute = {
      routeID: route.routeID,
      systemIDs: [...route.systemIDs],
      gateIDs,
      reverseGateIDs,
      transitMsByEdge,
    };
    const timing = {
      initialDelay: scaleRoamingRange(5 * 60_000, 90 * 60_000, 15_000),
      dwell: scaleRoamingRange(60_000, 5 * 60_000, 5_000),
      transit: {
        minMs: Math.max(5_000, Math.round(transitFallbackMs * 0.8)),
        maxMs: Math.max(5_000, Math.round(transitFallbackMs * 1.25)),
      },
      camp: scaleRoamingRange(15 * 60_000, 90 * 60_000, 60_000),
      cooldown: scaleRoamingRange(15 * 60_000, 60 * 60_000, 60_000),
    };
    rows.push({
      flight: pirate,
      route,
      spec: {
        groupID: pirateGroupID,
        factionKey: String(pirate.doctrineFactionKey || "pirate"),
        coalitionKey: "pirate",
        campaignID: String(route.campaignID || pirate.campaignID || ""),
        doctrineKey: String(pirate.spawnGroupID || "pirate_roam"),
        engagementRole: "aggressor",
        memberFlightIDs: [pirate.flightID],
        hostileGroupIDs: [policeGroupID],
        directionPolicy: "deterministic",
        combatCapable: true,
        route: sharedRoute,
        timing,
        campPolicy: {
          enabled: true,
          probability: route.lowSecurity === true ? 0.32 : 0.12,
          edgeIndexes: route.edges.map((_edge, edgeIndex) => edgeIndex),
          edgeWeights,
        },
        metadata: {
          family: "pirate",
          pairIndex: index,
          riskBand: String(route.riskBand || "highsec"),
          playerNeutral: true,
        },
      },
    });
    rows.push({
      flight: police,
      route,
      spec: {
        groupID: policeGroupID,
        factionKey: String(police.doctrineFactionKey || "empire"),
        coalitionKey: "empire_security",
        campaignID: String(route.campaignID || police.campaignID || ""),
        doctrineKey: String(police.spawnGroupID || "counter_roam"),
        engagementRole: "defender",
        memberFlightIDs: [police.flightID],
        hostileGroupIDs: [pirateGroupID],
        directionPolicy: "deterministic",
        combatCapable: true,
        route: sharedRoute,
        timing,
        campPolicy: {
          enabled: false,
          probability: 0,
          edgeIndexes: route.edges.map((_edge, edgeIndex) => edgeIndex),
          edgeWeights,
        },
        metadata: {
          family: "police",
          pairIndex: index,
          riskBand: String(route.riskBand || "highsec"),
          playerNeutral: true,
        },
      },
    });
  }
  return rows;
}

function projectRoamingGroupToFlight(state, flight, group, nowMs, reason) {
  if (!flight || !group || flight.encounterID) return false;
  const route = routeDefinitionsByID.get(group.route && group.route.routeID);
  if (!route) return false;
  const routeCursor = Math.max(
    0,
    Math.min(
      route.systemIDs.length - 1,
      Math.trunc(toFiniteNumber(group.routeCursor, 0)),
    ),
  );
  const systemID = toPositiveInt(
    group.currentSystemID,
    toPositiveInt(route.systemIDs[routeCursor], route.systemIDs[0]),
  );
  const phase = group.phase === livingRoamingKernel.PHASE.STAGING
    ? PHASE.DOCKED
    : group.phase === livingRoamingKernel.PHASE.TRANSIT
      ? PHASE.VIRTUAL_TRANSIT
      : PHASE.DUTY;
  const nextTransitionAtMs = Math.max(
    nowMs + 1_000,
    toFiniteNumber(group.nextActionAtMs, nowMs + 1_000),
  );
  const updates = {
    routeID: route.routeID,
    dynamicRouteSpec: null,
    routeClass: route.routeClass || "frontier",
    riskBand: route.riskBand || "highsec",
    minimumSecurity: getRouteMinimumSecurity(route),
    campaignID: route.campaignID || null,
    campaignName: route.campaignName || null,
    campaignIntensity: toFiniteNumber(route.campaignIntensity, 0),
    currentNodeIndex: routeCursor,
    currentSystemID: systemID,
    direction: Number(group.direction) < 0 ? -1 : 1,
    phase,
    nextTransitionAtMs,
    virtualTravel: null,
    roamingGroupID: group.groupID,
    roamingPhase: group.phase,
    roamingGateID: toPositiveInt(group.currentGateID, 0) || null,
  };
  let changed = false;
  for (const [key, value] of Object.entries(updates)) {
    if (Object.is(flight[key], value)) continue;
    flight[key] = value;
    changed = true;
  }
  if (!changed) return false;
  flight.lastTransitionReason = String(reason || "roaming-operation-transition");
  for (const actorID of flight.actorIDs || []) {
    const actor = state.actors && state.actors[actorID];
    if (!actor) continue;
    actor.currentSystemID = systemID;
    actor.state = flight.materialized ? "materialized" : "virtual";
  }
  return true;
}

function initializeRoamingConflictState(state, nowMs) {
  if (!state || typeof state !== "object") return null;
  state.metrics = state.metrics && typeof state.metrics === "object" ? state.metrics : {};
  for (const key of [
    "roamingContactsScheduled",
    "roamingContactsRejected",
    "roamingContactsExpired",
    "roamingContactsDeferred",
    "roamingTransitionsProcessed",
  ]) {
    state.metrics[key] = Math.max(0, toFiniteNumber(state.metrics[key], 0));
  }
  if (!isRoamingConflictEnabled()) {
    state.roamingConflict = null;
    state.pendingRoamingContacts = [];
    for (const flight of Object.values(state.flights || {})) {
      delete flight.roamingGroupID;
      delete flight.roamingPhase;
      delete flight.roamingGateID;
    }
    return null;
  }
  state.pendingRoamingContacts = Array.isArray(state.pendingRoamingContacts)
    ? state.pendingRoamingContacts
      .filter((candidate) => candidate && String(candidate.candidateID || "").trim())
      .slice(0, MAX_PENDING_ROAMING_CONTACTS)
    : [];
  const roamingState = livingRoamingKernel.ensureState(
    state.roamingConflict || livingRoamingKernel.createState({
      seed: `living-roaming:${state.createdAtMs || nowMs}`,
      createdAtMs: state.createdAtMs || nowMs,
    }),
    nowMs,
  );
  state.roamingConflict = roamingState;
  const rows = buildRoamingTaskGroupRows(state);
  const desiredGroupIDs = new Set(rows.map((row) => row.spec.groupID));
  for (const groupID of Object.keys(roamingState.groups || {})) {
    if (!desiredGroupIDs.has(groupID)) {
      livingRoamingKernel.removeTaskGroup(roamingState, groupID, nowMs);
    }
  }
  const desiredFlightIDs = new Set(rows.map((row) => String(row.flight.flightID)));
  for (const flight of Object.values(state.flights || {})) {
    if (flight.roamingGroupID && !desiredFlightIDs.has(String(flight.flightID))) {
      delete flight.roamingGroupID;
      delete flight.roamingPhase;
      delete flight.roamingGateID;
    }
  }
  for (const row of rows) {
    const result = livingRoamingKernel.upsertTaskGroup(roamingState, row.spec, nowMs);
    const group = result.group;
    row.flight.roamingGroupID = group.groupID;
    if (
      !row.flight.encounterID &&
      !(Array.isArray(row.flight.replacementDemandIDs) &&
        row.flight.replacementDemandIDs.length > 0)
    ) {
      projectRoamingGroupToFlight(
        state,
        row.flight,
        group,
        nowMs,
        result.changed ? "roaming-operation-assigned" : "roaming-operation-recovered",
      );
    }
  }
  livingRoamingKernel.rebuildIndexes(roamingState);
  livingRoamingKernel.rebuildDeadlineHeap(roamingState);
  return livingRoamingKernel.getStatus(roamingState, nowMs);
}

function estimateConflictTravelMs(flight, targetSystemID) {
  const sourceSystemID = toPositiveInt(flight && flight.currentSystemID, 0);
  const destinationSystemID = toPositiveInt(targetSystemID, 0);
  if (!sourceSystemID || !destinationSystemID || sourceSystemID === destinationSystemID) {
    return 30_000;
  }
  const systemIDs = marketTopology.getShortestPath(sourceSystemID, destinationSystemID);
  const jumps = Math.max(1, systemIDs.length - 1);
  return Math.max(
    30_000,
    (jumps * getTransitMs()) + ((jumps + 1) * getCrossingMs()),
  );
}

function getConflictAnchor(scene, encounter) {
  if (!scene || !encounter) return null;
  for (const explicitAnchorID of [
    encounter.targetAnchorID,
    encounter.targetGateID,
  ]) {
    const anchor = getSceneAnchor(scene, toPositiveInt(explicitAnchorID, 0));
    if (anchor) return anchor;
  }
  const defender = runtimeState && runtimeState.flights[encounter.defenderFlightID];
  const route = defender ? routeDefinitionsByID.get(defender.routeID) : null;
  if (defender && defender.family === "miner" && route && route.kind === "duty") {
    const dutyAnchor = getDutySceneAnchor(scene, route);
    if (dutyAnchor) return dutyAnchor;
  }
  const systemID = toPositiveInt(encounter.targetSystemID, 0);
  for (const gate of worldData.getStargatesForSystem(systemID)) {
    const anchor = getSceneAnchor(scene, gate.itemID);
    if (anchor) return anchor;
  }
  for (const station of worldData.getStationsForSystem(systemID)) {
    const anchor = getSceneAnchor(scene, station.stationID || station.itemID);
    if (anchor) return anchor;
  }
  for (const belt of worldData.getAsteroidBeltsForSystem(systemID)) {
    const anchor = getSceneAnchor(scene, belt.itemID);
    if (anchor) return anchor;
  }
  return null;
}

function getConflictFlightIDs(encounter) {
  return [...new Set([
    ...(encounter && encounter.attackerFlightIDs || []),
    ...(encounter && encounter.defenderFlightIDs || []),
    String(encounter && encounter.attackerFlightID || ""),
    String(encounter && encounter.defenderFlightID || ""),
    String(encounter && encounter.response && encounter.response.flightID || ""),
  ].map(String).filter(Boolean))];
}

function getConflictSideFlights(encounter, side) {
  const pluralKey = side === "attacker" ? "attackerFlightIDs" : "defenderFlightIDs";
  const singularKey = side === "attacker" ? "attackerFlightID" : "defenderFlightID";
  return [...new Set([
    ...(encounter && encounter[pluralKey] || []),
    encounter && encounter[singularKey],
  ].map(String).filter(Boolean))]
    .map((flightID) => runtimeState && runtimeState.flights[flightID])
    .filter(Boolean);
}

function getLiveEntitiesForFlights(runtime, flights) {
  return (Array.isArray(flights) ? flights : []).flatMap((flight) => getLiveEntities(runtime, flight));
}

function getConflictActorIDs(encounter) {
  return [...new Set([
    ...(encounter && encounter.attackerActorIDs || []),
    ...(encounter && encounter.defenderActorIDs || []),
    ...(encounter && encounter.response && encounter.response.actorIDs || []),
  ].map(String).filter(Boolean))];
}

function snapshotConflictFlight(flight, nowMs) {
  return {
    routeID: String(flight && flight.routeID || ""),
    dynamicRouteSpec: flight && flight.dynamicRouteSpec || null,
    routeClass: String(flight && flight.routeClass || ""),
    riskBand: String(flight && flight.riskBand || ""),
    currentNodeIndex: Number(flight && flight.currentNodeIndex) || 0,
    currentSystemID: toPositiveInt(flight && flight.currentSystemID, 0),
    direction: Number(flight && flight.direction) < 0 ? -1 : 1,
    phase: String(flight && flight.phase || PHASE.DOCKED),
    remainingTransitionMs: Math.max(
      1_000,
      toFiniteNumber(flight && flight.nextTransitionAtMs, nowMs) - nowMs,
    ),
    virtualTravel: flight && flight.virtualTravel || null,
  };
}

function getConflictSpeakerActor(encounter, flightKind = "defender") {
  const actorIDs = flightKind === "response"
    ? encounter && encounter.response && encounter.response.actorIDs || []
    : encounter && encounter.defenderActorIDs || [];
  const actors = actorIDs.map((actorID) => runtimeState.actors[actorID]).filter(Boolean);
  if (flightKind === "response") {
    return actors.find((actor) => String(actor.role || "") === "police") || actors[0] || null;
  }
  return actors.find((actor) => ["hauler", "miner"].includes(String(actor.role || ""))) ||
    actors[0] || null;
}

function broadcastConflictLocalMessage(encounter, actor, message, nowMs) {
  const characterID = toPositiveInt(actor && actor.pilot && actor.pilot.characterID, 0);
  if (!characterID || !message) return false;
  const pilot = livingPilotDirectory.getPilotRecord(characterID) || {
    ...(actor.pilot || {}),
    corporationID: toPositiveInt(actor.corporationID, 0),
    allianceID: 0,
    warFactionID: 0,
  };
  const chatRuntime = getChatRuntime();
  if (typeof chatRuntime.broadcastSyntheticLocalMessage !== "function") return false;
  return Boolean(chatRuntime.broadcastSyntheticLocalMessage({
    ...pilot,
    solarSystemID: toPositiveInt(encounter && encounter.targetSystemID, 0),
  }, message, {
    solarSystemID: toPositiveInt(encounter && encounter.targetSystemID, 0),
    createdAtMs: nowMs,
  }));
}

function getConflictLocationLabel(anchor, encounter) {
  const explicit = String(anchor && (anchor.itemName || anchor.slimName || anchor.name) || "").trim();
  if (explicit) return explicit;
  const system = worldData.getSolarSystemByID(toPositiveInt(encounter && encounter.targetSystemID, 0));
  return system ? `${system.solarSystemName} traffic lane` : "the traffic lane";
}

function notifyConflictAnomalyChanged(systemID, scene) {
  try {
    const service = getScanMgrService();
    if (service && typeof service.notifyAnomalyDeltaForSystem === "function") {
      service.notifyAnomalyDeltaForSystem(systemID, { scene });
    }
  } catch (error) {
    log.warn(`[LivingUniverse] Distress signal tracker refresh failed: ${error.message}`);
  }
}

function activateConflictDistress(runtime, encounter, nowMs) {
  const scene = getSceneWithPlayers(runtime, encounter.targetSystemID);
  const anchor = getConflictAnchor(scene, encounter);
  if (!scene || !anchor) {
    return { success: false, errorMsg: "DISTRESS_SCENE_NOT_FOUND" };
  }
  const existingID = toPositiveInt(encounter.distressBeaconID, 0);
  const existing = existingID > 0 ? scene.getEntityByID(existingID) : null;
  if (existing) {
    return { success: true, beaconID: existing.itemID, position: cloneVector(existing.position) };
  }

  const defender = runtimeState.flights[encounter.defenderFlightID];
  const defenderLead = getLiveEntities(runtime, defender)[0] || null;
  const position = cloneVector(
    defenderLead && defenderLead.position || encounter.distressPosition || anchor.position,
  );
  const allocation = nativeNpcStore.allocateEntityID({ transient: true });
  const beaconID = allocation && allocation.success ? toPositiveInt(allocation.data, 0) : 0;
  if (!beaconID) {
    return { success: false, errorMsg: allocation && allocation.errorMsg || "DISTRESS_ID_FAILED" };
  }
  const typeRecord = getItemTypeRegistry().resolveItemByTypeID(DISTRESS_BEACON_TYPE_ID) || {};
  const label = `Distress Signal ${encounter.encounterID}`;
  const speaker = getConflictSpeakerActor(encounter, "defender");
  const beacon = {
    itemID: beaconID,
    kind: "livingConflictDistressBeacon",
    typeID: DISTRESS_BEACON_TYPE_ID,
    groupID: toPositiveInt(typeRecord.groupID, DISTRESS_BEACON_GROUP_ID),
    categoryID: toPositiveInt(typeRecord.categoryID, DISTRESS_BEACON_CATEGORY_ID),
    graphicID: toPositiveInt(typeRecord.graphicID, 0) || null,
    slimTypeID: DISTRESS_BEACON_TYPE_ID,
    slimGroupID: toPositiveInt(typeRecord.groupID, DISTRESS_BEACON_GROUP_ID),
    slimCategoryID: toPositiveInt(typeRecord.categoryID, DISTRESS_BEACON_CATEGORY_ID),
    itemName: label,
    slimName: label,
    ownerID: toPositiveInt(speaker && speaker.pilot && speaker.pilot.characterID, 1),
    corporationID: toPositiveInt(speaker && speaker.corporationID, 0),
    systemID: toPositiveInt(encounter.targetSystemID, 0),
    radius: Math.max(100, toFiniteNumber(typeRecord.radius, DISTRESS_BEACON_RADIUS_METERS)),
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    targetPoint: position,
    mode: "STOP",
    speedFraction: 0,
    transient: true,
    createdAtMs: nowMs,
    staticVisibilityScope: "bubble",
    signalTrackerAnomalySite: true,
    signalTrackerSiteKind: "anomaly",
    signalTrackerSiteFamily: "distress",
    signalTrackerAnomalySiteFamily: "distress",
    signalTrackerSiteLabel: label,
    signalTrackerSiteDifficulty: 1,
    signalTrackerSiteGroupID: DISTRESS_BEACON_GROUP_ID,
    signalTrackerSiteTypeID: DISTRESS_BEACON_TYPE_ID,
    signalTrackerEntryObjectTypeID: DISTRESS_BEACON_TYPE_ID,
    livingConflictEncounterID: encounter.encounterID,
  };
  const spawnResult = scene.spawnDynamicEntity(beacon, { broadcast: true });
  if (!spawnResult || spawnResult.success !== true) {
    return { success: false, errorMsg: spawnResult && spawnResult.errorMsg || "DISTRESS_SPAWN_FAILED" };
  }
  notifyConflictAnomalyChanged(encounter.targetSystemID, scene);
  // Ensure the simulated pilot joins this system's Local before speaking.
  syncPilotPresence();
  if (!encounter.distressAnnouncedAtMs && speaker) {
    const corporationName = String(speaker.corporationName || "civilian").trim();
    const role = String(speaker.role || "");
    const vessel = role === "miner" ? "mining flight" : "transport";
    broadcastConflictLocalMessage(
      encounter,
      speaker,
      `Mayday - ${corporationName} ${vessel} taking fire near ${getConflictLocationLabel(anchor, encounter)}. Distress signal is live; security requested.`,
      nowMs,
    );
    encounter.distressAnnouncedAtMs = nowMs;
  }
  return { success: true, beaconID, position };
}

function removeConflictDistressBeacon(runtime, encounter, nowMs) {
  const beaconID = toPositiveInt(encounter && encounter.distressBeaconID, 0);
  const scene = runtime && runtime.scenes instanceof Map
    ? runtime.scenes.get(toPositiveInt(encounter && encounter.targetSystemID, 0)) || null
    : null;
  if (scene && beaconID > 0 && scene.getEntityByID(beaconID)) {
    scene.removeDynamicEntity(beaconID, { nowMs });
    notifyConflictAnomalyChanged(encounter.targetSystemID, scene);
  }
  if (encounter) {
    encounter.distressBeaconID = null;
    encounter.distressBeaconActive = false;
  }
}

function cleanupAllConflictDistressBeacons(nowMs = Date.now()) {
  if (!runtimeState) return;
  let runtime = null;
  try {
    runtime = getSpaceRuntime();
  } catch (error) {
    return;
  }
  for (const encounter of Object.values(runtimeState.encounters || {})) {
    if (encounter && (encounter.distressBeaconID || encounter.distressBeaconActive)) {
      removeConflictDistressBeacon(runtime, encounter, nowMs);
    }
  }
}

function dispatchConflictResponse(encounter, nowMs) {
  const system = worldData.getSolarSystemByID(toPositiveInt(encounter.targetSystemID, 0));
  const security = toFiniteNumber(system && system.security, 1);
  const responseKind = security >= 0.5 ? "law_enforcement" : "corporate_security";
  const speaker = getConflictSpeakerActor(encounter, "defender");
  const fallbackProvider = security >= 0.5
    ? "Caldari Navy"
    : `${String(speaker && speaker.corporationName || "Corporate").trim()} Security`;
  const responseChance = security >= 0.5 ? 1 : 0.6;
  const responseRoll = livingConflictRuntime._testing.deterministicUnit(
    encounter.encounterID,
    "security-response",
  );
  if (responseRoll >= responseChance) {
    return {
      success: false,
      status: "unavailable",
      kind: responseKind,
      providerName: fallbackProvider,
      reason: "RESPONSE_NOT_ACCEPTED",
    };
  }

  const candidates = Object.values(runtimeState.flights || {})
    .filter((flight) => (
      flight &&
      String(flight.family || "") === "police" &&
      !flight.encounterID &&
      flight.materialized !== true &&
      isConflictFlightEligible(flight)
    ))
    .map((flight) => ({
      flight,
      travelMs: estimateConflictTravelMs(flight, encounter.targetSystemID),
    }))
    .sort((left, right) => (
      left.travelMs - right.travelMs ||
      String(left.flight.flightID).localeCompare(String(right.flight.flightID))
    ));
  const selected = candidates[0] || null;
  if (!selected) {
    return {
      success: false,
      status: "unavailable",
      kind: responseKind,
      providerName: fallbackProvider,
      reason: "NO_SECURITY_FLIGHT_AVAILABLE",
    };
  }

  const flight = selected.flight;
  const dispatchDelayMs = security >= 0.8
    ? 30_000 + Math.round(livingConflictRuntime._testing.deterministicUnit(encounter.encounterID, "dispatch-delay") * 30_000)
    : security >= 0.5
      ? 60_000 + Math.round(livingConflictRuntime._testing.deterministicUnit(encounter.encounterID, "dispatch-delay") * 60_000)
      : 120_000 + Math.round(livingConflictRuntime._testing.deterministicUnit(encounter.encounterID, "dispatch-delay") * 120_000);
  const arrivesAtMs = nowMs + dispatchDelayMs + selected.travelMs;
  encounter.participantSnapshots = encounter.participantSnapshots || {};
  encounter.participantSnapshots[flight.flightID] = snapshotConflictFlight(flight, nowMs);
  flight.encounterID = encounter.encounterID;
  flight.nextTransitionAtMs = arrivesAtMs;
  flight.lastTransitionReason = "living-conflict-response-enroute";
  const responseActor = getFlightActors(flight).find((actor) => String(actor.role || "") === "police") ||
    getFlightActors(flight)[0] || null;
  const providerName = String(responseActor && responseActor.corporationName || fallbackProvider).trim();
  if (speaker && !encounter.responseDispatchAnnouncedAtMs) {
    const etaSeconds = Math.max(1, Math.ceil((arrivesAtMs - nowMs) / 1_000));
    broadcastConflictLocalMessage(
      encounter,
      speaker,
      `${providerName} acknowledged the distress call. Response ETA approximately ${etaSeconds}s.`,
      nowMs,
    );
    encounter.responseDispatchAnnouncedAtMs = nowMs;
  }
  markFlightDirty(flight);
  markEncounterDirty(encounter);
  markMetaDirty();
  return {
    success: true,
    kind: responseKind,
    flightID: flight.flightID,
    actorIDs: [...(flight.actorIDs || [])],
    sourceSystemID: toPositiveInt(flight.currentSystemID, 0),
    arrivesAtMs,
    providerName,
  };
}

function announceConflictResponseArrival(encounter, nowMs) {
  if (!encounter || !encounter.response || encounter.responseArrivalAnnouncedAtMs) return;
  const actor = getConflictSpeakerActor(encounter, "response");
  if (!actor) return;
  if (broadcastConflictLocalMessage(
    encounter,
    actor,
    "Security response is on grid. Civilian traffic, clear the engagement area.",
    nowMs,
  )) {
    encounter.responseArrivalAnnouncedAtMs = nowMs;
  }
}

function configureConflictCombat(encounter, runtime, nowMs) {
  // Resident track R1: encounter combatants may also engage players, but only those the
  // per-player admission check (isValidCombatTarget) marks hostile to their faction. Their
  // preferred targets remain the opposing NPC side, so the encounter still fights itself.
  const combatTargetClasses = factionHostilityRuntime.isEnabled()
    ? ["npc", "player"]
    : ["npc"];
  const attackerFlights = getConflictSideFlights(encounter, "attacker");
  const defenderFlights = getConflictSideFlights(encounter, "defender");
  const response = encounter.response && encounter.response.status === "arrived"
    ? runtimeState.flights[encounter.response.flightID]
    : null;
  const scene = runtime && runtime.scenes instanceof Map
    ? runtime.scenes.get(toPositiveInt(encounter.targetSystemID, 0)) || null
    : null;
  if (!scene) return false;
  const attackers = getLiveEntitiesForFlights(runtime, attackerFlights);
  const defenders = getLiveEntitiesForFlights(runtime, defenderFlights);
  const responders = getLiveEntities(runtime, response);
  if (attackers.length <= 0 || defenders.length <= 0) return false;
  const actorByEntityID = new Map(
    getConflictActorIDs(encounter)
      .map((actorID) => runtimeState.actors[actorID])
      .filter((actor) => actor && toPositiveInt(actor.liveEntityID, 0) > 0)
      .map((actor) => [toPositiveInt(actor.liveEntityID, 0), actor]),
  );
  const launchActorDrones = (actor, entity, target) => {
    if (!actor || !Array.isArray(actor.droneBay) || actor.droneBay.length <= 0) return;
    const existingDroneIDs = (Array.isArray(actor.liveDroneEntityIDs)
      ? actor.liveDroneEntityIDs
      : []).filter((entityID) => Boolean(scene.getEntityByID(toPositiveInt(entityID, 0))));
    if (existingDroneIDs.length > 0) {
      actor.liveDroneEntityIDs = existingDroneIDs;
      return;
    }
    const droneResult = getDroneRuntime().spawnTransientNpcDroneWing(
      scene,
      entity,
      target,
      actor.droneBay,
      { nowMs },
    );
    actor.liveDroneEntityIDs = Array.isArray(droneResult.droneEntityIDs)
      ? droneResult.droneEntityIDs
      : [];
  };
  for (let index = 0; index < attackers.length; index += 1) {
    const entity = attackers[index];
    const target = defenders[index % defenders.length];
    getNpcService().setBehaviorOverrides(entity.itemID, {
      autoAggro: true,
      autoActivateWeapons: true,
      autoAggroTargetClasses: combatTargetClasses,
      allowFriendlyNpcTargets: true,
      targetPreference: "nearestNpc",
      movementMode: "orbit",
      orbitDistanceMeters: 7_500,
      followRangeMeters: 5_000,
      useChasePropulsion: true,
      chasePropulsionActivateDistanceMeters: 16_000,
      chasePropulsionDeactivateDistanceMeters: 10_000,
      aggressionRangeMeters: 180_000,
      returnToHomeWhenIdle: false,
    });
    const controller = getNpcService().getControllerByEntityID(entity.itemID);
    if (controller) {
      controller.runtimeKind = "nativeCombat";
      controller.preferredTargetID = target.itemID;
      controller.currentTargetID = target.itemID;
      controller.nextThinkAtMs = 0;
    }
    getNpcService().wakeNpcController(entity.itemID, 0);
    launchActorDrones(actorByEntityID.get(entity.itemID), entity, target);
  }
  for (let index = 0; index < defenders.length; index += 1) {
    const entity = defenders[index];
    const target = attackers[index % attackers.length];
    const actor = actorByEntityID.get(entity.itemID) || null;
    const armed = ["escort", "police"].includes(String(actor && actor.role || ""));
    getNpcService().setBehaviorOverrides(entity.itemID, armed ? {
      autoAggro: true,
      autoActivateWeapons: true,
      autoAggroTargetClasses: combatTargetClasses,
      allowFriendlyNpcTargets: true,
      targetPreference: "nearestNpc",
      movementMode: "orbit",
      orbitDistanceMeters: 9_000,
      followRangeMeters: 6_000,
      useChasePropulsion: true,
      chasePropulsionActivateDistanceMeters: 18_000,
      chasePropulsionDeactivateDistanceMeters: 11_000,
      aggressionRangeMeters: 180_000,
      returnToHomeWhenIdle: false,
    } : {
      autoAggro: false,
      autoActivateWeapons: false,
      allowFriendlyNpcTargets: true,
      targetPreference: "none",
      movementMode: "keepRange",
      followRangeMeters: 30_000,
      returnToHomeWhenIdle: false,
    });
    const controller = getNpcService().getControllerByEntityID(entity.itemID);
    if (controller) {
      controller.runtimeKind = "nativeCombat";
      if (armed) {
        controller.preferredTargetID = target.itemID;
        controller.currentTargetID = target.itemID;
      }
      controller.nextThinkAtMs = 0;
    }
    getNpcService().noteNpcIncomingAggression(entity, attackers[0], nowMs);
    getNpcService().wakeNpcController(entity.itemID, 0);
    if (armed) launchActorDrones(actor, entity, target);
  }
  for (let index = 0; index < responders.length; index += 1) {
    const entity = responders[index];
    const target = attackers[index % attackers.length];
    getNpcService().setBehaviorOverrides(entity.itemID, {
      autoAggro: true,
      autoActivateWeapons: true,
      autoAggroTargetClasses: combatTargetClasses,
      allowFriendlyNpcTargets: true,
      targetPreference: "nearestNpc",
      movementMode: "orbit",
      orbitDistanceMeters: 8_000,
      followRangeMeters: 6_000,
      useChasePropulsion: true,
      chasePropulsionActivateDistanceMeters: 18_000,
      chasePropulsionDeactivateDistanceMeters: 11_000,
      aggressionRangeMeters: 220_000,
      returnToHomeWhenIdle: false,
    });
    const controller = getNpcService().getControllerByEntityID(entity.itemID);
    if (controller) {
      controller.runtimeKind = "nativeCombat";
      controller.preferredTargetID = target.itemID;
      controller.currentTargetID = target.itemID;
      controller.nextThinkAtMs = 0;
    }
    getNpcService().noteNpcIncomingAggression(entity, attackers[0], nowMs);
    getNpcService().wakeNpcController(entity.itemID, 0);
    launchActorDrones(actorByEntityID.get(entity.itemID), entity, target);
  }
  return true;
}

function getConflictMaterializationFlights(encounter) {
  const response = encounter.response && encounter.response.status === "arrived"
    ? runtimeState.flights[encounter.response.flightID]
    : null;
  return [...new Map([
    ...getConflictSideFlights(encounter, "attacker"),
    ...getConflictSideFlights(encounter, "defender"),
    response,
  ].filter(Boolean).map((flight) => [flight.flightID, flight])).values()];
}

function reserveConflictMaterialization(flights) {
  if (materializationsThisTick >= getMaterializationBatchLimit()) {
    return { success: false, errorMsg: "CONFLICT_MATERIALIZATION_BATCH_BUSY" };
  }
  const newlyReservedFlights = [];
  for (const flight of flights) {
    const reservationID = getPhysicalReservationID(flight);
    const alreadyReserved = Boolean(npcPhysicalBudget.getReservation(reservationID));
    const result = reservePhysicalFlight(flight, getFlightActors(flight).length);
    if (!result.success) {
      for (const reservedFlight of newlyReservedFlights) {
        releasePhysicalFlightBudget(reservedFlight);
      }
      return {
        success: false,
        errorMsg: `CONFLICT_PHYSICAL_BUDGET_${String(result.reason || "DENIED")}`,
      };
    }
    if (!alreadyReserved) newlyReservedFlights.push(flight);
  }
  return { success: true };
}

function rollbackConflictMaterialization(flights, preservedFlightIDs = new Set()) {
  for (const flight of flights) {
    if (preservedFlightIDs.has(String(flight && flight.flightID || ""))) {
      continue;
    }
    if (flight.materialized) {
      cleanupPhysicalFlight(flight);
    } else if (npcPhysicalBudget.getReservation(getPhysicalReservationID(flight))) {
      releasePhysicalFlightBudget(flight);
    }
  }
}

function materializeConflictEncounter(runtime, encounter, nowMs) {
  const scene = getSceneWithPlayers(runtime, encounter.targetSystemID);
  const anchor = getConflictAnchor(scene, encounter);
  const attackerFlights = getConflictSideFlights(encounter, "attacker");
  const defenderFlights = getConflictSideFlights(encounter, "defender");
  if (!scene || !anchor || attackerFlights.length <= 0 || defenderFlights.length <= 0) {
    return { success: false, errorMsg: "CONFLICT_SCENE_OR_FLIGHT_NOT_FOUND" };
  }
  const materializationFlights = getConflictMaterializationFlights(encounter);
  const preexistingFlightIDs = new Set();
  for (const flight of materializationFlights) {
    if (!flight.materialized) continue;
    const liveCount = getLiveEntities(runtime, flight).length;
    const expectedCount = getFlightActors(flight).length;
    if (liveCount !== expectedCount) {
      return {
        success: false,
        errorMsg: "CONFLICT_PREEXISTING_FLIGHT_INCOMPLETE",
      };
    }
    preexistingFlightIDs.add(String(flight.flightID));
  }
  const reservation = reserveConflictMaterialization(materializationFlights);
  if (!reservation.success) {
    return reservation;
  }
  const spawnedFlights = [];
  const newlySpawnedFlights = [];
  const spawnWing = (flights, baseDistance, errorCode) => {
    for (let index = 0; index < flights.length; index += 1) {
      const flight = flights[index];
      if (preexistingFlightIDs.has(String(flight.flightID))) {
        spawnedFlights.push(flight);
        continue;
      }
      if (!spawnAtAnchor(scene, flight, anchor, {
        distanceFromSurfaceMeters: baseDistance + (index * 4_000),
        transient: false,
        broadcast: false,
        ignoreMaterializationBatchLimit: true,
        playerNeutral: encounter.playerNeutral !== false,
      })) {
        rollbackConflictMaterialization(materializationFlights, preexistingFlightIDs);
        return { success: false, errorMsg: flight.lastError || errorCode };
      }
      spawnedFlights.push(flight);
      newlySpawnedFlights.push(flight);
    }
    return { success: true };
  };
  const defenderSpawn = spawnWing(defenderFlights, 8_000, "CONFLICT_DEFENDER_SPAWN_FAILED");
  if (!defenderSpawn.success) {
    return defenderSpawn;
  }
  const attackerSpawn = spawnWing(attackerFlights, 28_000, "CONFLICT_ATTACKER_SPAWN_FAILED");
  if (!attackerSpawn.success) {
    return attackerSpawn;
  }
  const response = encounter.response && encounter.response.status === "arrived"
    ? runtimeState.flights[encounter.response.flightID]
    : null;
  if (response && !preexistingFlightIDs.has(String(response.flightID))) {
    if (!spawnAtAnchor(scene, response, anchor, {
      distanceFromSurfaceMeters: 34_000,
      transient: false,
      broadcast: false,
      ignoreMaterializationBatchLimit: true,
      playerNeutral: encounter.playerNeutral !== false,
    })) {
      rollbackConflictMaterialization(materializationFlights, preexistingFlightIDs);
      return { success: false, errorMsg: response.lastError || "CONFLICT_RESPONSE_SPAWN_FAILED" };
    }
    newlySpawnedFlights.push(response);
  }
  if (response) spawnedFlights.push(response);
  const spawnedEntities = getLiveEntitiesForFlights(runtime, spawnedFlights);
  const expectedEntityCount = spawnedFlights.reduce(
    (sum, flight) => sum + getFlightActors(flight).length,
    0,
  );
  if (spawnedEntities.length !== expectedEntityCount) {
    rollbackConflictMaterialization(materializationFlights, preexistingFlightIDs);
    return { success: false, errorMsg: "CONFLICT_ATOMIC_SPAWN_INCOMPLETE" };
  }
  // Publish the complete battle in one acquisition. Previously each flight was
  // broadcast independently; with the live one-batch-per-tick cap the first
  // wing appeared, the second failed, and the first was immediately removed.
  // The client saw a new three-ship group blink to a new position every second.
  const newlySpawnedEntities = getLiveEntitiesForFlights(runtime, newlySpawnedFlights);
  if (newlySpawnedEntities.length > 0) {
    scene.broadcastAddBalls(newlySpawnedEntities, null, {
      freshAcquire: true,
      minimumLeadFromCurrentHistory: 2,
    });
  }
  if (!configureConflictCombat(encounter, runtime, nowMs)) {
    rollbackConflictMaterialization(materializationFlights, preexistingFlightIDs);
    return { success: false, errorMsg: "CONFLICT_COMBAT_SETUP_FAILED" };
  }
  if (response) announceConflictResponseArrival(encounter, nowMs);
  encounter.lastMaterializedAtMs = nowMs;
  return { success: true };
}

function arriveConflictResponse(runtime, encounter, nowMs) {
  const response = encounter && encounter.response || null;
  const flight = response ? runtimeState.flights[response.flightID] : null;
  if (!flight) return { success: false, errorMsg: "CONFLICT_RESPONSE_FLIGHT_NOT_FOUND" };
  flight.currentSystemID = toPositiveInt(encounter.targetSystemID, flight.currentSystemID);
  flight.phase = PHASE.DUTY;
  flight.virtualTravel = null;
  flight.nextTransitionAtMs = encounter.endsAtMs;
  flight.lastTransitionReason = "living-conflict-response-arrived";
  syncActorSystem(flight);
  // The patrol's Local presence must precede its on-grid arrival call.
  syncPilotPresence();
  const scene = getSceneWithPlayers(runtime, encounter.targetSystemID);
  if (scene && encounter.materialized) {
    const anchor = getConflictAnchor(scene, encounter);
    if (!anchor || !spawnAtAnchor(scene, flight, anchor, {
      distanceFromSurfaceMeters: 34_000,
      transient: false,
      playerNeutral: encounter.playerNeutral !== false,
    })) {
      return { success: false, errorMsg: flight.lastError || "CONFLICT_RESPONSE_SPAWN_FAILED" };
    }
    encounter.response.status = "arrived";
    if (!configureConflictCombat(encounter, runtime, nowMs)) {
      cleanupPhysicalFlight(flight);
      return { success: false, errorMsg: "CONFLICT_RESPONSE_COMBAT_SETUP_FAILED" };
    }
    announceConflictResponseArrival(encounter, nowMs);
  }
  markFlightDirty(flight);
  markEncounterDirty(encounter);
  return { success: true };
}

function collectConflictLosses(runtime, encounter) {
  const scene = runtime && runtime.scenes instanceof Map
    ? runtime.scenes.get(toPositiveInt(encounter.targetSystemID, 0)) || null
    : null;
  if (!scene) return [];
  const actorIDs = getConflictActorIDs(encounter);
  const losses = actorIDs.filter((actorID) => {
    const actor = runtimeState.actors[actorID];
    return actor && toPositiveInt(actor.liveEntityID, 0) > 0 &&
      !scene.getEntityByID(toPositiveInt(actor.liveEntityID, 0));
  });
  encounter.physicalWreckActorIDs = [...new Set([
    ...(encounter.physicalWreckActorIDs || []),
    ...losses,
  ])];
  return losses;
}

function dematerializeConflictEncounter(runtime, encounter, nowMs = Date.now()) {
  const victimActorIDs = collectConflictLosses(runtime, encounter);
  removeConflictDistressBeacon(runtime, encounter, nowMs);
  for (const flightID of getConflictFlightIDs(encounter)) {
    const flight = runtimeState.flights[flightID];
    if (flight) cleanupPhysicalFlight(flight);
  }
  return { victimActorIDs };
}

function applyPhysicalConflictOutcome(runtime, encounter, actorIDs, nowMs) {
  const scene = runtime && runtime.scenes instanceof Map
    ? runtime.scenes.get(toPositiveInt(encounter.targetSystemID, 0)) || null
    : null;
  const destroyedActorIDs = [];
  if (!scene) return { destroyedActorIDs };
  for (const actorID of Array.isArray(actorIDs) ? actorIDs : []) {
    const actor = runtimeState.actors[actorID];
    const entityID = toPositiveInt(actor && actor.liveEntityID, 0);
    const entity = entityID > 0 ? scene.getEntityByID(entityID) : null;
    if (!entity) {
      destroyedActorIDs.push(actorID);
      continue;
    }
    const result = nativeNpcWreckService.destroyNativeNpcEntityWithWreck(
      encounter.targetSystemID,
      entity,
      { corporationID: toPositiveInt(actor.corporationID, 0), nowMs },
    );
    if (result.success) {
      destroyedActorIDs.push(actorID);
      encounter.physicalWreckIDsByActorID = {
        ...(encounter.physicalWreckIDsByActorID || {}),
        [actorID]: toPositiveInt(
          result.data && result.data.wreck && result.data.wreck.wreckID,
          0,
        ) || null,
      };
      encounter.physicalWreckActorIDs = [...new Set([
        ...(encounter.physicalWreckActorIDs || []),
        actorID,
      ])];
    }
  }
  return { destroyedActorIDs };
}

function buildConflictVictimDescriptor(actor, encounter) {
  const profile = npcData.getNpcProfile(actor && actor.profileID) || {};
  return {
    actorID: String(actor && actor.actorID || ""),
    flightID: String(actor && actor.flightID || ""),
    profileID: String(actor && actor.profileID || ""),
    shipTypeID: toPositiveInt(actor && actor.shipTypeID, 0),
    shipName: String(profile.shipNameTemplate || profile.name || `type ${actor && actor.shipTypeID}`),
    homeStationID: toPositiveInt(actor && actor.homeStationID, 0),
    homeSystemID: toPositiveInt(actor && actor.homeSystemID, 0),
    corporationID: toPositiveInt(actor && actor.corporationID, 0),
    factionID: toPositiveInt(actor && actor.factionID, 0),
    factionName: String(actor && actor.factionName || ""),
    pilotCharacterID: toPositiveInt(actor && actor.pilot && actor.pilot.characterID, 0),
    droneBay: Array.isArray(actor && actor.droneBay)
      ? actor.droneBay.map((drone) => ({
          typeID: toPositiveInt(drone && drone.typeID, 0),
          quantity: toPositiveInt(drone && drone.quantity, 0),
        })).filter((drone) => drone.typeID > 0 && drone.quantity > 0)
      : [],
    systemID: toPositiveInt(encounter && encounter.targetSystemID, 0),
    wreckID: toPositiveInt(
      encounter && encounter.physicalWreckIDsByActorID &&
        encounter.physicalWreckIDsByActorID[actor && actor.actorID],
      0,
    ) || null,
  };
}

function incrementShipLossCounter(metricName, key) {
  const normalizedKey = String(key || "unknown");
  const counters = runtimeState.metrics[metricName] &&
    typeof runtimeState.metrics[metricName] === "object"
    ? runtimeState.metrics[metricName]
    : {};
  counters[normalizedKey] = toPositiveInt(counters[normalizedKey], 0) + 1;
  runtimeState.metrics[metricName] = counters;
}

function recordShipDestruction(actor, source) {
  if (!actor) return false;
  const shipTypeID = toPositiveInt(actor.shipTypeID, 0);
  const profile = npcData.getNpcProfile(actor.profileID) || {};
  const typeKey = String(shipTypeID || "unknown");
  const lossesByType = runtimeState.metrics.shipLossesByType &&
    typeof runtimeState.metrics.shipLossesByType === "object"
    ? runtimeState.metrics.shipLossesByType
    : {};
  const typeRow = lossesByType[typeKey] &&
    typeof lossesByType[typeKey] === "object"
    ? lossesByType[typeKey]
    : {
        shipTypeID,
        shipName: String(
          profile.shipNameTemplate ||
          profile.name ||
          `type ${shipTypeID || "unknown"}`,
        ),
        losses: 0,
      };
  typeRow.losses = toPositiveInt(typeRow.losses, 0) + 1;
  lossesByType[typeKey] = typeRow;
  runtimeState.metrics.shipLossesByType = lossesByType;
  incrementShipLossCounter("shipLossesByRole", actor.role);
  incrementShipLossCounter(
    "shipLossesByFaction",
    actor.factionName || actor.factionID,
  );
  runtimeState.metrics.shipLosses =
    toPositiveInt(runtimeState.metrics.shipLosses, 0) + 1;
  if (source === "conflict") {
    runtimeState.metrics.conflictShipLosses =
      toPositiveInt(runtimeState.metrics.conflictShipLosses, 0) + 1;
  } else {
    runtimeState.metrics.physicalShipLosses =
      toPositiveInt(runtimeState.metrics.physicalShipLosses, 0) + 1;
  }
  return true;
}

function restoreFlightAfterConflict(flight, encounter, hasLosses, nowMs) {
  const snapshot = encounter.participantSnapshots && encounter.participantSnapshots[flight.flightID] || {};
  cleanupPhysicalFlight(flight);
  flight.encounterID = null;
  flight.routeID = snapshot.routeID || flight.routeID;
  flight.dynamicRouteSpec = snapshot.dynamicRouteSpec || flight.dynamicRouteSpec;
  flight.routeClass = snapshot.routeClass || flight.routeClass;
  flight.riskBand = snapshot.riskBand || flight.riskBand;
  const route = routeDefinitionsByID.get(flight.routeID);
  if (hasLosses && route) {
    const homeNodeIndex = route.kind === "duty"
      ? 0
      : Math.max(0, Math.min(route.systemIDs.length - 1, toPositiveInt(flight.homeNodeIndex, 0)));
    flight.currentNodeIndex = homeNodeIndex;
    flight.currentSystemID = route.systemIDs[homeNodeIndex];
    flight.direction = homeNodeIndex === route.systemIDs.length - 1 ? -1 : 1;
    flight.phase = PHASE.DOCKED;
    flight.virtualTravel = null;
    flight.nextTransitionAtMs = nowMs + getVirtualReplacementMs();
    flight.lastTransitionReason = "conflict-loss-replacement-scheduled";
  } else {
    flight.currentNodeIndex = Number(snapshot.currentNodeIndex) || 0;
    flight.currentSystemID = toPositiveInt(snapshot.currentSystemID, flight.currentSystemID);
    flight.direction = Number(snapshot.direction) < 0 ? -1 : 1;
    flight.phase = String(snapshot.phase || PHASE.DOCKED);
    flight.virtualTravel = snapshot.virtualTravel || null;
    flight.nextTransitionAtMs = nowMs + Math.max(1_000, toFiniteNumber(snapshot.remainingTransitionMs, 1_000));
    flight.lastTransitionReason = "conflict-complete-route-resumed";
  }
  syncActorSystem(flight);
  markFlightDirty(flight);
}

function finalizeConflictEncounter(runtime, encounter, victimActorIDs, nowMs) {
  const victims = (Array.isArray(victimActorIDs) ? victimActorIDs : [])
    .map((actorID) => runtimeState.actors[actorID])
    .filter(Boolean);
  const evidence = victims.map((actor) => buildConflictVictimDescriptor(actor, encounter));
  const victimsByFlightID = new Map();
  // Campaign consumables follow actual fighting pressure. The previous model
  // raised a full fleet-sized supply order for every scheduled encounter,
  // including quiet off-grid contacts with no loss, which made production
  // dominate destruction. A witnessed exchange gets a small ammunition/repair
  // allowance; losses add the material pressure that drives larger orders.
  if (encounter.campaignID && (victims.length > 0 || encounter.observed === true)) {
    const supplyFlight = runtimeState.flights[encounter.defenderFlightID] ||
      runtimeState.flights[encounter.attackerFlightID] || null;
    const pressure = Math.min(
      3,
      (victims.length * 0.5) + (encounter.observed === true ? 0.2 : 0),
    );
    livingEconomyRuntime.registerCampaignDemand({
      campaignID: encounter.campaignID,
      campaignName: encounter.campaignName,
      encounterID: encounter.encounterID,
      stationID: supplyFlight && supplyFlight.homeStationID,
      systemID: encounter.targetSystemID,
      intensity: Math.max(0.1, encounter.campaignIntensity * pressure),
      nowMs,
    });
  }
  const playerKillCreditsByActorID = {};
  for (const actor of victims) {
    if (!victimsByFlightID.has(actor.flightID)) victimsByFlightID.set(actor.flightID, []);
    victimsByFlightID.get(actor.flightID).push(actor);
    actor.losses = toPositiveInt(actor.losses, 0) + 1;
    actor.replacementCount = toPositiveInt(actor.replacementCount, 0) + 1;
    markActorDirty(actor);
    recordShipDestruction(actor, "conflict");
    runtimeState.metrics.replacements += 1;
    // Resident track R1: attribute the loss to the player who landed the final blow (killmail
    // tracker staged the credit at destruction time). Splits player kills from cleanup in the
    // metrics and gives R3 rescue verification its participation evidence.
    const killerCharacterID = livingKillCreditLedger.consumeKillCredit(actor.actorID, nowMs);
    if (killerCharacterID > 0) {
      playerKillCreditsByActorID[actor.actorID] = killerCharacterID;
      runtimeState.metrics.playerCreditedConflictLosses =
        toPositiveInt(runtimeState.metrics.playerCreditedConflictLosses, 0) + 1;
    }
  }
  if (Object.keys(playerKillCreditsByActorID).length > 0) {
    encounter.playerKillCredits = {
      ...(encounter.playerKillCredits && typeof encounter.playerKillCredits === "object"
        ? encounter.playerKillCredits
        : {}),
      ...playerKillCreditsByActorID,
    };
  }
  removeConflictDistressBeacon(runtime, encounter, nowMs);
  for (const flightID of getConflictFlightIDs(encounter)) {
    const flight = runtimeState.flights[flightID];
    if (!flight) continue;
    const flightVictims = victimsByFlightID.get(flightID) || [];
    const missingActorIDs = flightVictims.map((actor) => actor.actorID);
    if (flightVictims.some((actor) => String(actor.role || "") === "hauler")) {
      livingEconomyRuntime.notifyFlightLoss(flight, missingActorIDs, nowMs);
    }
    if (
      flight.miningManifest &&
      flightVictims.some((actor) => ["miner", "mining_support"].includes(String(actor.role || "")))
    ) {
      flight.miningManifest.depositStatus = "lost";
      flight.miningManifest.depositedAtMs = nowMs;
      flight.miningManifest.lastError = "MINING_FLIGHT_CONFLICT_LOSS";
    }
    const demandIDs = flightVictims.length > 0
      ? livingEconomyRuntime.registerReplacementLoss({
          encounterID: encounter.encounterID,
          victims: flightVictims.map((actor) => buildConflictVictimDescriptor(actor, encounter)),
          nowMs,
        })
      : [];
    flight.replacementDemandIDs = [...new Set([
      ...(Array.isArray(flight.replacementDemandIDs)
        ? flight.replacementDemandIDs
        : []),
      ...demandIDs,
    ].map(String).filter(Boolean))];
    restoreFlightAfterConflict(flight, encounter, flightVictims.length > 0, nowMs);
    markFlightDirty(flight);
  }
  if (evidence.length > 0) {
    livingEconomyRuntime.registerSalvageOpportunity({
      encounterID: encounter.encounterID,
      systemID: encounter.targetSystemID,
      security: toFiniteNumber(
        (worldData.getSolarSystemByID(encounter.targetSystemID) || {}).security,
        0,
      ),
      victims: evidence,
      nowMs,
    });
  }
  markEncounterDirty(encounter);
  markMetaDirty();
  return {
    evidence,
    evidenceNeedsMaterialization: evidence.some((entry) => (
      !(encounter.physicalWreckActorIDs || []).includes(entry.actorID)
    )),
  };
}

function materializeConflictEvidence(runtime, encounter, nowMs) {
  const scene = getSceneWithPlayers(runtime, encounter.targetSystemID);
  const anchor = getConflictAnchor(scene, encounter);
  if (!scene || !anchor) return { success: false, errorMsg: "EVIDENCE_SCENE_NOT_FOUND" };
  const nativeNpcService = require(path.join(__dirname, "../nativeNpcService"));
  const wreckIDs = [];
  for (const evidence of Array.isArray(encounter.evidence) ? encounter.evidence : []) {
    if (evidence.recoveredByLivingSalvagersAtMs) {
      continue;
    }
    if (toPositiveInt(evidence.wreckID, 0) > 0) {
      wreckIDs.push(evidence.wreckID);
      continue;
    }
    const spawnResult = nativeNpcService.spawnNativeNpcEntityInSystem(
      encounter.targetSystemID,
      {
        profileQuery: evidence.profileID,
        anchorEntity: anchor,
        transient: false,
        runtimeKind: "nativeAmbient",
        operatorKind: OPERATOR_KIND,
        ownerIDOverride: evidence.pilotCharacterID,
        corporationIDOverride: evidence.corporationID,
        warFactionIDOverride: evidence.factionID,
        distanceFromSurfaceMeters: 10_000 + (wreckIDs.length * 2_500),
        spreadMeters: 1_500,
        behaviorOverrides: {
          autoAggro: false,
          autoActivateWeapons: false,
          targetPreference: "none",
        },
        skipInitialBehaviorTick: true,
        broadcast: false,
        loadoutSeed: `${encounter.encounterID}:${evidence.actorID}:evidence`,
      },
    );
    const entity = spawnResult && spawnResult.success && spawnResult.data
      ? spawnResult.data.entity
      : null;
    if (!entity) return { success: false, errorMsg: spawnResult.errorMsg || "EVIDENCE_SPAWN_FAILED" };
    const wreckResult = nativeNpcWreckService.destroyNativeNpcEntityWithWreck(
      encounter.targetSystemID,
      entity,
      { corporationID: evidence.corporationID, nowMs },
    );
    if (!wreckResult.success) return { success: false, errorMsg: wreckResult.errorMsg || "EVIDENCE_WRECK_FAILED" };
    evidence.wreckID = wreckResult.data.wreck.wreckID;
    wreckIDs.push(evidence.wreckID);
  }
  markEncounterDirty(encounter);
  return { success: true, wreckIDs };
}

function syncSalvageSiteWreckIDs(site) {
  const encounter = runtimeState && runtimeState.encounters
    ? runtimeState.encounters[String(site && site.encounterID || "")] || null
    : null;
  const wreckIDsByActorID = {};
  for (const evidence of Array.isArray(encounter && encounter.evidence) ? encounter.evidence : []) {
    const actorID = String(evidence && evidence.actorID || "");
    const wreckID = toPositiveInt(evidence && evidence.wreckID, 0);
    if (actorID && wreckID) wreckIDsByActorID[actorID] = wreckID;
  }
  return { encounter, wreckIDsByActorID };
}

function observeSalvageRecovery(runtime, site, job, nowMs) {
  let synced = syncSalvageSiteWreckIDs(site);
  if (
    synced.encounter &&
    synced.encounter.evidencePending === true &&
    getSceneWithPlayers(runtime, site.systemID)
  ) {
    const materialized = materializeConflictEvidence(runtime, synced.encounter, nowMs);
    if (materialized && materialized.success === true) {
      synced.encounter.evidencePending = false;
      synced.encounter.evidenceMaterializedAtMs = nowMs;
      synced.encounter.wreckIDs = materialized.wreckIDs || [];
      runtimeState.metrics.wreckEvidenceMaterialized += synced.encounter.wreckIDs.length;
      markEncounterDirty(synced.encounter);
      markMetaDirty();
    }
    synced = syncSalvageSiteWreckIDs(site);
  }
  const scene = getSceneWithPlayers(runtime, site.systemID);
  if (!scene) return synced;
  const existingEntityID = toPositiveInt(job && job.liveEntityID, 0);
  if (existingEntityID > 0 && scene.getEntityByID(existingEntityID)) {
    return { ...synced, liveEntityID: existingEntityID };
  }
  const anchor = Object.values(synced.wreckIDsByActorID)
    .map((wreckID) => getSceneAnchor(scene, wreckID))
    .find(Boolean) || null;
  if (!anchor) return synced;
  const nativeNpcService = require(path.join(__dirname, "../nativeNpcService"));
  const spawnResult = nativeNpcService.spawnNativeNpcEntityInSystem(site.systemID, {
    profileQuery: "living_jita_jita_salvager_cormorant_v1",
    anchorEntity: anchor,
    transient: true,
    runtimeKind: "nativeAmbient",
    operatorKind: "livingSalvageRecovery",
    distanceFromSurfaceMeters: 3_500,
    spreadMeters: 750,
    behaviorOverrides: {
      autoAggro: false,
      autoActivateWeapons: false,
      targetPreference: "none",
      movementMode: "orbit",
      orbitDistanceMeters: 3_500,
      followRangeMeters: 2_500,
      idleAnchorOrbit: false,
    },
    skipInitialBehaviorTick: true,
    broadcast: true,
    loadoutSeed: `${site.siteID}:${job.jobID}:recovery-crew`,
  });
  const liveEntityID = toPositiveInt(
    spawnResult && spawnResult.success && spawnResult.data &&
      spawnResult.data.entity && spawnResult.data.entity.itemID,
    0,
  );
  if (liveEntityID > 0) {
    return { ...synced, liveEntityID };
  }
  return synced;
}

function claimSalvageSite(site, job, nowMs) {
  const { encounter, wreckIDsByActorID } = syncSalvageSiteWreckIDs(site);
  const evidenceByActorID = new Map(
    (Array.isArray(encounter && encounter.evidence) ? encounter.evidence : [])
      .map((evidence) => [String(evidence && evidence.actorID || ""), evidence]),
  );
  const recoveredActorIDs = [];
  const claimedByPlayerActorIDs = [];
  for (const wreck of Array.isArray(site && site.wrecks) ? site.wrecks : []) {
    const actorID = String(wreck && wreck.actorID || "");
    if (!actorID) continue;
    const evidence = evidenceByActorID.get(actorID) || null;
    const wreckID = toPositiveInt(
      wreckIDsByActorID[actorID] || wreck.wreckID || (evidence && evidence.wreckID),
      0,
    );
    if (wreckID > 0) {
      if (!nativeNpcStore.getNativeWreck(wreckID)) {
        claimedByPlayerActorIDs.push(actorID);
        if (evidence) evidence.claimedBeforeNpcRecoveryAtMs = nowMs;
        continue;
      }
      const removal = nativeNpcWreckService.destroyNativeWreck(wreckID, {
        systemID: site.systemID,
      });
      if (!removal || removal.success !== true) {
        claimedByPlayerActorIDs.push(actorID);
        continue;
      }
    }
    recoveredActorIDs.push(actorID);
    if (evidence) evidence.recoveredByLivingSalvagersAtMs = nowMs;
  }
  if (encounter) {
    encounter.evidencePending = false;
    encounter.salvageRecoveredAtMs = nowMs;
  }
  if (toPositiveInt(job && job.liveEntityID, 0) > 0) {
    cleanupEntity(job.liveEntityID);
    job.liveEntityID = null;
  }
  if (encounter) markEncounterDirty(encounter);
  return { recoveredActorIDs, claimedByPlayerActorIDs };
}

function getRoamingGroupForFlight(flight) {
  const groupID = String(flight && flight.roamingGroupID || "");
  return groupID && runtimeState && runtimeState.roamingConflict
    ? runtimeState.roamingConflict.groups[groupID] || null
    : null;
}

function syncRoamingGroupFlights(group, nowMs, reason) {
  if (!group) return 0;
  let changedCount = 0;
  for (const flightID of group.memberFlightIDs || []) {
    const flight = runtimeState && runtimeState.flights[String(flightID)];
    if (!flight || flight.encounterID) continue;
    if (livingEconomyRuntime.shouldHoldReplacementFlight(flight)) {
      if (flight.materialized) cleanupPhysicalFlight(flight);
      continue;
    }
    if (
      flight.materialized &&
      group.phase !== livingRoamingKernel.PHASE.CAMPING
    ) {
      cleanupPhysicalFlight(flight);
    }
    if (projectRoamingGroupToFlight(runtimeState, flight, group, nowMs, reason)) {
      syncActorSystem(flight);
      markFlightDirty(flight);
      changedCount += 1;
    }
    rescheduleChangedFlight(flight, nowMs);
  }
  return changedCount;
}

function areRoamingGroupsHostile(left, right) {
  const leftFamily = String(left && left.metadata && left.metadata.family || "");
  const rightFamily = String(right && right.metadata && right.metadata.family || "");
  if (!(
    (leftFamily === "pirate" && rightFamily === "police") ||
    (leftFamily === "police" && rightFamily === "pirate")
  )) {
    return false;
  }
  const hasEligibleFlight = (group) => (group.memberFlightIDs || []).some((flightID) => {
    const flight = runtimeState && runtimeState.flights[String(flightID)];
    return flight && !flight.encounterID && isConflictFlightEligible(flight);
  });
  return hasEligibleFlight(left) && hasEligibleFlight(right);
}

function getMaximumActiveConflicts() {
  return Math.max(
    1,
    Math.min(10, toPositiveInt(config.livingConflictMaxActiveEncounters, 4)),
  );
}

function countActiveConflicts(maximum = Infinity) {
  let activeCount = 0;
  for (const encounter of Object.values(runtimeState && runtimeState.encounters || {})) {
    if (["staging", "active"].includes(String(encounter && encounter.phase || ""))) {
      activeCount += 1;
      if (activeCount >= maximum) break;
    }
  }
  return activeCount;
}

function scheduleRoamingIntersection(candidate, nowMs) {
  const systemID = toPositiveInt(candidate && candidate.location && candidate.location.systemID, 0);
  if (!systemID) return null;
  const maxActive = getMaximumActiveConflicts();
  if (countActiveConflicts(maxActive) >= maxActive) return null;
  const kind = String(candidate.kind || "") === "gate_camp_interception"
    ? "temporary_gate_camp_contact"
    : String(candidate.kind || "") === "route_crossing"
      ? "roaming_route_contact"
      : "roaming_system_contact";
  const battleUnit = deterministicUnit(candidate.candidateID, "battle-class");
  return livingConflictRuntime.scheduleEncounter(runtimeState, nowMs, {
    isFlightEligible: isConflictFlightEligible,
    getSecurity(targetSystemID) {
      const system = worldData.getSolarSystemByID(targetSystemID);
      return toFiniteNumber(system && system.security, 1);
    },
    estimateTravelMs: estimateConflictTravelMs,
  }, {
    attackerFlightIDs: candidate.attackerFlightIDs,
    defenderFlightIDs: candidate.defenderFlightIDs,
    targetSystemID: systemID,
    campaignID: candidate.campaignID,
    kind,
    contactKind: candidate.kind,
    sourceOperationID: candidate.candidateID,
    targetAnchorID: toPositiveInt(candidate.location.anchorID, 0) || undefined,
    targetGateID: toPositiveInt(candidate.location.gateID, 0) || undefined,
    battleClass: battleUnit < 0.08
      ? "major"
      : battleUnit < 0.32
        ? "engagement"
        : "skirmish",
    playerNeutral: true,
    stagingDelayMs: 5_000,
    allowMaterializedFlights: true,
  });
}

function tickRoamingConflict(runtime, nowMs) {
  if (
    !isRoamingConflictEnabled() ||
    !runtimeState ||
    !runtimeState.roamingConflict
  ) {
    return { changed: false, active: false, processed: 0, scheduled: 0 };
  }
  const roamingState = runtimeState.roamingConflict;
  const startedAtMs = performance.now();
  const result = livingRoamingKernel.tick(roamingState, nowMs, {
    isSystemObserved(systemID) {
      return Boolean(getSceneWithPlayers(runtime, systemID));
    },
    areGroupsHostile: areRoamingGroupsHostile,
    onTransition(event) {
      const group = roamingState.groups[String(event && event.group && event.group.groupID || "")];
      if (group) syncRoamingGroupFlights(group, nowMs, `roaming-${event.kind}`);
    },
  }, {
    workBudgetMs: getRoamingWorkBudgetMs(),
    maxTransitions: getRoamingTransitionLimit(),
    maxDeadlinePops: getRoamingTransitionLimit() * 4,
    maxIntersectionCandidates: 8,
    maxIntersectionsPerPresence: 4,
    maxPresenceChecks: getRoamingPresenceCheckLimit(),
    maxActiveCamps: getRoamingCampLimit(),
  });
  let scheduled = 0;
  let rejected = 0;
  let expired = 0;
  let deferred = 0;
  const previousPending = Array.isArray(runtimeState.pendingRoamingContacts)
    ? runtimeState.pendingRoamingContacts.slice(0, MAX_PENDING_ROAMING_CONTACTS)
    : [];
  const previousPendingIDs = new Set(
    previousPending.map((candidate) => String(candidate && candidate.candidateID || "")),
  );
  const candidatesByID = new Map();
  for (const candidate of [
    ...previousPending,
    ...(result.intersections || []),
  ]) {
    const candidateID = String(candidate && candidate.candidateID || "").trim();
    if (!candidateID || candidatesByID.has(candidateID)) continue;
    candidatesByID.set(candidateID, candidate);
  }
  const candidates = [...candidatesByID.values()].sort((left, right) => (
    toFiniteNumber(left && left.overlapEndsAtMs, Number.MAX_SAFE_INTEGER) -
      toFiniteNumber(right && right.overlapEndsAtMs, Number.MAX_SAFE_INTEGER) ||
    String(left && left.candidateID || "").localeCompare(
      String(right && right.candidateID || ""),
    )
  ));
  const nextPending = [];
  const maxActive = getMaximumActiveConflicts();
  let remainingCapacity = Math.max(0, maxActive - countActiveConflicts(maxActive));
  let admissionBudgetExhausted = false;
  let admissionCandidatesExamined = 0;
  for (const candidate of candidates) {
    if (toFiniteNumber(candidate && candidate.overlapEndsAtMs, 0) <= nowMs) {
      expired += 1;
      runtimeState.metrics.roamingContactsExpired =
        toPositiveInt(runtimeState.metrics.roamingContactsExpired, 0) + 1;
      continue;
    }
    if (
      admissionCandidatesExamined > 0 &&
      performance.now() - startedAtMs >= getRoamingWorkBudgetMs()
    ) {
      admissionBudgetExhausted = true;
    }
    admissionCandidatesExamined += 1;
    if (remainingCapacity <= 0 || admissionBudgetExhausted) {
      if (nextPending.length < MAX_PENDING_ROAMING_CONTACTS) {
        nextPending.push(candidate);
        const candidateID = String(candidate && candidate.candidateID || "");
        if (!previousPendingIDs.has(candidateID)) {
          deferred += 1;
          runtimeState.metrics.roamingContactsDeferred =
            toPositiveInt(runtimeState.metrics.roamingContactsDeferred, 0) + 1;
        }
      } else {
        rejected += 1;
        runtimeState.metrics.roamingContactsRejected =
          toPositiveInt(runtimeState.metrics.roamingContactsRejected, 0) + 1;
      }
      continue;
    }
    const encounter = scheduleRoamingIntersection(candidate, nowMs);
    if (encounter) {
      scheduled += 1;
      remainingCapacity -= 1;
      runtimeState.metrics.roamingContactsScheduled =
        toPositiveInt(runtimeState.metrics.roamingContactsScheduled, 0) + 1;
    } else {
      rejected += 1;
      runtimeState.metrics.roamingContactsRejected =
        toPositiveInt(runtimeState.metrics.roamingContactsRejected, 0) + 1;
    }
  }
  const previousPendingKey = previousPending
    .map((candidate) => String(candidate && candidate.candidateID || ""))
    .join("|");
  const nextPendingKey = nextPending
    .map((candidate) => String(candidate && candidate.candidateID || ""))
    .join("|");
  runtimeState.pendingRoamingContacts = nextPending;
  const pendingChanged = previousPendingKey !== nextPendingKey;
  const elapsedMs = Math.max(0, performance.now() - startedAtMs);
  schedulerMetrics.roamingPasses += 1;
  schedulerMetrics.roamingTransitionsProcessed += result.processed;
  schedulerMetrics.roamingContactsScheduled += scheduled;
  schedulerMetrics.roamingContactsRejected += rejected;
  schedulerMetrics.roamingContactsExpired += expired;
  schedulerMetrics.roamingContactsDeferred += deferred;
  schedulerMetrics.lastRoamingDispatchMs = elapsedMs;
  schedulerMetrics.maxRoamingDispatchMs = Math.max(
    schedulerMetrics.maxRoamingDispatchMs,
    elapsedMs,
  );
  schedulerMetrics.recentRoamingDispatchMs.push(elapsedMs);
  if (schedulerMetrics.recentRoamingDispatchMs.length > 120) {
    schedulerMetrics.recentRoamingDispatchMs.shift();
  }
  runtimeState.metrics.roamingTransitionsProcessed =
    toPositiveInt(runtimeState.metrics.roamingTransitionsProcessed, 0) + result.processed;
  if (
    result.changed ||
    pendingChanged ||
    scheduled > 0 ||
    rejected > 0 ||
    expired > 0 ||
    deferred > 0
  ) {
    markRoamingDirty();
  }
  return {
    ...result,
    active: Object.keys(roamingState.groups || {}).length > 0,
    scheduled,
    rejected,
    expired,
    deferred,
    pending: nextPending.length,
    elapsedMs,
    budgetMs: getRoamingWorkBudgetMs(),
    admissionBudgetExhausted,
    workBudgetExhausted:
      result.workBudgetExhausted === true || admissionBudgetExhausted,
    overBudget: elapsedMs > getRoamingWorkBudgetMs(),
  };
}

function tickLivingConflict(runtime, nowMs) {
  const roamingResult = tickRoamingConflict(runtime, nowMs);
  const affectedFlightIDs = collectConflictFlightIDs();
  const result = livingConflictRuntime.tick(runtimeState, nowMs, {
    isFlightEligible: isConflictFlightEligible,
    isLossEligibleActor: isConflictLossEligibleActor,
    getSecurity(systemID) {
      const system = worldData.getSolarSystemByID(systemID);
      return toFiniteNumber(system && system.security, 1);
    },
    estimateTravelMs: estimateConflictTravelMs,
    moveFlightToSystem(flight, systemID) {
      flight.currentSystemID = systemID;
      syncActorSystem(flight);
    },
    isSystemObserved(systemID) {
      return Boolean(getSceneWithPlayers(runtime, systemID));
    },
    materializeEncounter: (encounter, atMs) => materializeConflictEncounter(runtime, encounter, atMs),
    activateDistress: (encounter, atMs) => activateConflictDistress(runtime, encounter, atMs),
    dispatchResponse: (encounter, atMs) => dispatchConflictResponse(encounter, atMs),
    arriveResponse: (encounter, atMs) => arriveConflictResponse(runtime, encounter, atMs),
    collectLiveLosses: (encounter) => collectConflictLosses(runtime, encounter),
    dematerializeEncounter: (encounter, atMs) => dematerializeConflictEncounter(runtime, encounter, atMs),
    applyPhysicalOutcome: (encounter, actorIDs, atMs) => (
      applyPhysicalConflictOutcome(runtime, encounter, actorIDs, atMs)
    ),
    finalizeEncounter: (encounter, actorIDs, atMs) => (
      finalizeConflictEncounter(runtime, encounter, actorIDs, atMs)
    ),
    materializeEvidence: (encounter, atMs) => materializeConflictEvidence(runtime, encounter, atMs),
    // The low-cadence legacy lane is retained for civilian interdiction and
    // cargo/mining loss pressure. Roaming contacts remain operation-driven.
    allowLegacyScheduling: true,
  });
  // The conflict engine mutates nested encounter records through adapters.
  // Conservatively track the small retained encounter set on every conflict
  // pass; this is ~0.4 MB total and avoids a 13.9 MB universe scan while also
  // covering prune-only and lastError-only transitions.
  markAllEncountersDirty();
  collectConflictFlightIDs(affectedFlightIDs);
  for (const flightID of affectedFlightIDs) {
    const flight = runtimeState && runtimeState.flights[flightID];
    if (!flight) continue;
    markFlightDirty(flight);
    if (result.changed || roamingResult.changed) {
      rescheduleChangedFlight(flight, nowMs);
    }
  }
  return { ...result, roaming: roamingResult };
}

function cleanupEntity(entityID) {
  const normalizedID = toPositiveInt(entityID, 0);
  if (!normalizedID) {
    return;
  }
  const controller = getNpcService().getControllerByEntityID(normalizedID);
  if (controller) {
    getNpcService().destroyNpcControllerByEntityID(normalizedID, { removeContents: true });
  } else if (nativeNpcStore.getNativeEntity(normalizedID)) {
    nativeNpcStore.removeNativeEntityCascade(normalizedID);
  }
}

function cleanupPhysicalFlight(flight) {
  if (toPositiveInt(flight && flight.miningFleetID, 0) > 0) {
    getMiningNpcOperations().cleanupMiningFleetSupport(
      null,
      flight.miningFleetID,
      { unregister: true },
    );
  }
  releasePhysicalFlightBudget(flight);
  const spaceRuntime = getSpaceRuntime();
  for (const actor of getFlightActors(flight)) {
    for (const entityID of Array.isArray(actor && actor.liveDroneEntityIDs)
      ? actor.liveDroneEntityIDs
      : []) {
      const systemID = toPositiveInt(actor.currentSystemID, toPositiveInt(flight.currentSystemID, 0));
      const scene = spaceRuntime.scenes instanceof Map
        ? spaceRuntime.scenes.get(systemID) || null
        : null;
      if (scene && scene.getEntityByID(toPositiveInt(entityID, 0))) {
        scene.removeDynamicEntity(toPositiveInt(entityID, 0), {
          broadcast: true,
          persistSpaceState: false,
        });
      }
    }
    actor.liveDroneEntityIDs = [];
  }
  for (const entityID of Array.isArray(flight && flight.entityIDs) ? flight.entityIDs : []) {
    cleanupEntity(entityID);
  }
  for (const actor of getFlightActors(flight)) {
    actor.liveEntityID = 0;
    actor.state = "virtual";
  }
  flight.materialized = false;
  flight.entityIDs = [];
  flight.leadEntityID = 0;
  flight.poweredUndock = null;
  flight.warpPlan = null;
  flight.miningFleetID = 0;
  markFlightDirty(flight);
}

function buildStationDepartureStates(runtime, station, flight) {
  const actors = getFlightActors(flight);
  const leadProfile = actors.length > 0 ? npcData.getNpcProfile(actors[0].profileID) : null;
  const undock = runtime.getStationUndockSpawnState(station, {
    shipTypeID: toPositiveInt(leadProfile && leadProfile.shipTypeID, 0),
    selectionStrategy: "first",
    selectionKey: `${flight.flightID}:lead`,
  });
  if (!undock || !undock.position || !undock.direction) {
    return [];
  }
  const direction = normalizeVector(undock.direction);
  return actors.map((_actor, index) => {
    const position = buildFormationSlotPoint(undock.position, direction, index, {
      spacingMeters: 1_200,
      trailMeters: 700,
    });
    return {
      position,
      velocity: { x: 0, y: 0, z: 0 },
      direction,
      targetPoint: position,
      mode: "STOP",
      speedFraction: 0,
    };
  });
}

function getActorShipDisplayName(actor) {
  const corporationName = String(actor && actor.corporationName || "Independent").trim();
  const role = String(actor && actor.role || "traffic");
  if (role === "police") {
    return `${corporationName} Patrol`;
  }
  if (role === "miner") {
    return `${corporationName} Mining Vessel`;
  }
  if (role === "mining_support") {
    return `${corporationName} Mining Support`;
  }
  if (role === "hauler") {
    return `${corporationName} Freight Vessel`;
  }
  if (role === "escort") {
    return `${corporationName} Escort`;
  }
  if (role === "highsec_pirate") {
    return `${corporationName} Roamer`;
  }
  return `${corporationName} Shuttle`;
}

function adoptSpawnedFlight(scene, flight, spawnResult, options = {}) {
  const spawned = spawnResult && spawnResult.data && Array.isArray(spawnResult.data.spawned)
    ? spawnResult.data.spawned
    : [];
  const actors = getFlightActors(flight);
  if (spawned.length !== actors.length) {
    return false;
  }
  const entities = spawned.map((entry) => entry && entry.entity).filter(Boolean);
  if (entities.length !== actors.length) {
    return false;
  }
  const reservation = reservePhysicalFlight(flight, entities.length);
  if (!reservation.success) {
    flight.lastError = `PHYSICAL_BUDGET_${reservation.reason}`;
    markFlightDirty(flight, { actors: false });
    return false;
  }
  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    const actor = actors[index];
    actor.liveEntityID = entity.itemID;
    actor.state = "materialized";
    entity.livingUniverseActorID = actor.actorID;
    entity.livingUniverseFlightID = flight.flightID;
    // Keep the simulated pilot separate from runtime inventory ownership. Native
    // NPC dogma must continue reading its authored native loadout, while the slim
    // item exposed to the client may still identify the person flying the hull.
    entity.npcPilotCharacterID = toPositiveInt(actor.pilot && actor.pilot.characterID, 0);
    entity.npcRole = actor.role;
    const shipName = `${getActorShipDisplayName(actor)} ${actor.actorID.slice(-4)}`;
    entity.itemName = shipName;
    entity.slimName = shipName;
    // Resident track R1: publish the shoot-on-sight standing floor on living combat NPCs so the
    // vanilla client colors them against the viewing resident's own faction standing.
    if (
      factionHostilityRuntime.isEnabled() &&
      toPositiveInt(entity.warFactionID, 0) > 0 &&
      (
        flight.family === "pirate" ||
        ["escort", "police"].includes(String(actor.role || ""))
      )
    ) {
      entity.hostileResponseThreshold = factionHostilityRuntime.getStandingFloor();
    }
  }
  flight.entityIDs = entities.map((entity) => entity.itemID);
  flight.leadEntityID = flight.entityIDs[0] || 0;
  flight.materialized = true;
  flight.virtualTravel = null;
  runtimeState.metrics.materializations += 1;
  materializationsThisTick += 1;
  markFlightDirty(flight);
  markMetaDirty();
  if (options.broadcast !== false) {
    scene.broadcastAddBalls(entities, null, {
      freshAcquire: true,
      minimumLeadFromCurrentHistory: 2,
    });
  }
  if (flight.family === "pirate") {
    // Resident track R1: while hostility is enabled, even "player-neutral" pirate flights keep
    // their weapons live against players — the per-player admission check in the combat engine
    // (isValidCombatTarget) ensures they only ever engage residents who are timer-hostile or
    // below the standing floor. Everyone else remains untouched, so encounter combatants stay
    // effectively neutral to bystanders. With hostility disabled this reverts to the legacy
    // fully-passive neutral posture.
    const neutralOverrides = factionHostilityRuntime.isEnabled()
      ? {
          autoAggro: true,
          autoActivateWeapons: true,
          autoAggroTargetClasses: ["player"],
          targetPreference: "nearestPlayer",
          movementMode: "orbit",
          orbitDistanceMeters: 8_000,
          followRangeMeters: 5_000,
          aggressionRangeMeters: 150_000,
          returnToHomeWhenIdle: false,
        }
      : {
          autoAggro: false,
          autoActivateWeapons: false,
          autoAggroTargetClasses: ["npc"],
          targetPreference: "none",
          movementMode: "orbit",
          orbitDistanceMeters: 8_000,
          followRangeMeters: 5_000,
          returnToHomeWhenIdle: false,
        };
    for (const entity of entities) {
      getNpcService().setBehaviorOverrides(
        entity.itemID,
        options.playerNeutral === true
          ? neutralOverrides
          : {
              autoAggro: true,
              autoActivateWeapons: true,
              autoAggroTargetClasses: ["player"],
              targetPreference: "nearestPlayer",
              movementMode: "orbit",
              orbitDistanceMeters: 4_000,
              followRangeMeters: 3_000,
              aggressionRangeMeters: 150_000,
              returnToHomeWhenIdle: true,
            },
      );
      getNpcService().wakeNpcController(entity.itemID, 0);
    }
  }
  return true;
}

function spawnAtAnchor(scene, flight, anchor, options = {}) {
  if (
    !scene ||
    !anchor ||
    !anchor.position ||
    !canMaterialize(flight, {
      ignoreMaterializationBatchLimit: options.ignoreMaterializationBatchLimit === true,
    })
  ) {
    return false;
  }
  const behaviorOverrides = flight.family === "pirate" && options.playerNeutral !== true
    ? {
        autoAggro: true,
        autoActivateWeapons: true,
        autoAggroTargetClasses: ["player"],
        targetPreference: "nearestPlayer",
        returnToHomeWhenIdle: true,
      }
    : {
        autoAggro: false,
        autoActivateWeapons: false,
        targetPreference: "none",
        returnToHomeWhenIdle: false,
        idleAnchorOrbit: false,
  };
  const freightCargo = livingEconomyRuntime.getFlightCargo(flight);
  const miningCargoOverrides = buildMiningCargoOverrides(flight);
  const cargoOverrides = getFlightActors(flight).map((actor, index) => (
    String(actor && actor.role || "") === "hauler"
      ? freightCargo
      : miningCargoOverrides[index]
  ));
  const result = getNpcService().spawnNpcGroupInSystem(scene.systemID, {
    spawnGroupQuery: flight.spawnGroupID,
    entityType: "npc",
    transient: options.transient !== false,
    runtimeKind: "nativeAmbient",
    anchorEntity: anchor,
    operatorKind: OPERATOR_KIND,
    behaviorOverrides,
    distanceFromSurfaceMeters: Math.max(1_000, toFiniteNumber(options.distanceFromSurfaceMeters, 8_000)),
    spreadMeters: 1_200,
    formationSpacingMeters: 1_500,
    spawnStateOverrides: Array.isArray(options.spawnStateOverrides)
      ? options.spawnStateOverrides
      : undefined,
    ownerIDOverrides: getFlightActors(flight).map((actor) => (
      toPositiveInt(actor && actor.pilot && actor.pilot.characterID, 0)
    )),
    corporationIDOverrides: getFlightActors(flight).map((actor) => (
      toPositiveInt(
        actor && actor.pilot && actor.pilot.corporationID,
        toPositiveInt(actor && actor.corporationID, 0),
      )
    )),
    warFactionIDOverrides: getFlightActors(flight).map((actor) => (
      toPositiveInt(
        actor && actor.pilot && actor.pilot.factionID,
        toPositiveInt(actor && actor.factionID, 0),
      )
    )),
    cargoOverrides,
    broadcast: false,
    skipInitialBehaviorTick: true,
    loadoutSeed: flight.flightID,
  });
  if (!result.success || !adoptSpawnedFlight(scene, flight, result, {
    broadcast: options.broadcast !== false,
    playerNeutral: options.playerNeutral === true,
  })) {
    const spawned = result && result.data && Array.isArray(result.data.spawned)
      ? result.data.spawned
      : [];
    for (const entry of spawned) {
      cleanupEntity(entry && entry.entity && entry.entity.itemID);
    }
    flight.lastError = result.errorMsg || "LIVING_UNIVERSE_SPAWN_FAILED";
    markFlightDirty(flight);
    return false;
  }
  flight.lastError = null;
  markFlightDirty(flight);
  return true;
}

function getEndpointStationID(route, nodeIndex) {
  if (route.kind === "duty") {
    return route.stationID;
  }
  if (nodeIndex === 0) {
    return route.endpointStationIDs[0];
  }
  if (nodeIndex === route.systemIDs.length - 1) {
    return route.endpointStationIDs[1];
  }
  return 0;
}

function getEndpointRecord(route, nodeIndex) {
  const endpointID = getEndpointStationID(route, nodeIndex);
  if (!endpointID) return null;
  const endpointIndex = nodeIndex === 0
    ? 0
    : nodeIndex === route.systemIDs.length - 1
      ? 1
      : -1;
  const endpointAnchor = endpointIndex >= 0 && Array.isArray(route.endpointAnchors)
    ? route.endpointAnchors[endpointIndex]
    : null;
  return resolveRouteEndpointRecord(endpointID, endpointAnchor);
}

function getOutgoingEdge(route, flight) {
  return flight.direction > 0
    ? route.edges[flight.currentNodeIndex] || null
    : route.edges[flight.currentNodeIndex - 1] || null;
}

function getIncomingEdge(route, flight) {
  return flight.direction > 0
    ? route.edges[flight.currentNodeIndex - 1] || null
    : route.edges[flight.currentNodeIndex] || null;
}

function getOutgoingGateID(route, flight) {
  const edge = getOutgoingEdge(route, flight);
  return edge ? (flight.direction > 0 ? edge.sourceGateID : edge.destinationGateID) : 0;
}

function getIncomingGateID(route, flight) {
  const edge = getIncomingEdge(route, flight);
  return edge ? (flight.direction > 0 ? edge.destinationGateID : edge.sourceGateID) : 0;
}

function setVirtualTravelPhase(flight, phase, estimate, nowMs, reason, runtime = null) {
  const fallbackMs = Math.max(60_000, getCrossingMs());
  const estimatedMs = Number(estimate && estimate.totalMs);
  const baseDurationMs = Math.max(
    1_000,
    Number.isFinite(estimatedMs) && estimatedMs > 0 ? estimatedMs : fallbackMs,
  );
  const observed = Boolean(runtime && getSceneWithPlayers(runtime, flight.currentSystemID));
  const configuredMultiplier = Math.max(
    1,
    Math.min(100, toFiniteNumber(config.livingUniverseOffGridTravelTimeMultiplier, 1)),
  );
  const appliedTimeMultiplier = !flight.materialized && runtime && !observed
    ? configuredMultiplier
    : 1;
  const durationMs = Math.max(1_000, Math.round(baseDurationMs / appliedTimeMultiplier));
  flight.phase = phase;
  flight.nextTransitionAtMs = nowMs + durationMs;
  flight.virtualTravel = {
    phase,
    startedAtMs: nowMs,
    arrivesAtMs: flight.nextTransitionAtMs,
    durationMs,
    baseDurationMs,
    appliedTimeMultiplier,
    reason,
    ...(estimate || {}),
  };
  flight.lastTransitionReason = reason;
  markFlightDirty(flight);
  return flight.virtualTravel;
}

function rebaseAcceleratedVirtualTravelForObservation(flight, nowMs) {
  const travel = flight && flight.virtualTravel;
  const multiplier = toFiniteNumber(travel && travel.appliedTimeMultiplier, 1);
  if (!travel || multiplier <= 1 || flight.materialized === true) return false;
  const acceleratedDurationMs = Math.max(1_000, toFiniteNumber(travel.durationMs, 1_000));
  const baseDurationMs = Math.max(
    acceleratedDurationMs,
    toFiniteNumber(travel.baseDurationMs, acceleratedDurationMs * multiplier),
  );
  const progress = Math.max(0, Math.min(
    0.999,
    (nowMs - toFiniteNumber(travel.startedAtMs, nowMs)) / acceleratedDurationMs,
  ));
  const remainingMs = Math.max(1_000, Math.round(baseDurationMs * (1 - progress)));
  flight.nextTransitionAtMs = nowMs + remainingMs;
  flight.virtualTravel = {
    ...travel,
    startedAtMs: nowMs - Math.round(baseDurationMs * progress),
    arrivesAtMs: flight.nextTransitionAtMs,
    durationMs: baseDurationMs,
    baseDurationMs,
    appliedTimeMultiplier: 1,
    rebasedAtMs: nowMs,
    rebasedFromMultiplier: multiplier,
    rebasedProgress: progress,
  };
  flight.lastTransitionReason = `${travel.reason || flight.phase}:player-observed-rebase`;
  markFlightDirty(flight);
  return true;
}

function scheduleVirtualDeparture(
  route,
  flight,
  nowMs,
  reason = "virtual-station-departure",
  runtime = null,
) {
  const stationID = getEndpointStationID(route, flight.currentNodeIndex);
  const station = getEndpointRecord(route, flight.currentNodeIndex);
  const gate = resolveRouteTravelAnchor(route, getOutgoingGateID(route, flight));
  const estimate = station && gate
    ? estimateInSystemTravel(flight, station, gate, {
        poweredUndock: true,
        destinationKind: "gate",
      })
    : null;
  return setVirtualTravelPhase(
    flight,
    PHASE.VIRTUAL_DEPARTURE,
    estimate,
    nowMs,
    reason,
    runtime,
  );
}

function scheduleVirtualCrossing(
  route,
  flight,
  nowMs,
  reason = "virtual-system-crossing",
  runtime = null,
) {
  const incomingGate = resolveRouteTravelAnchor(route, getIncomingGateID(route, flight));
  const outgoingGate = resolveRouteTravelAnchor(route, getOutgoingGateID(route, flight));
  const estimate = incomingGate && outgoingGate
    ? estimateInSystemTravel(flight, incomingGate, outgoingGate, {
        ingress: true,
        destinationKind: "gate",
      })
    : null;
  return setVirtualTravelPhase(
    flight,
    PHASE.VIRTUAL_CROSSING,
    estimate,
    nowMs,
    reason,
    runtime,
  );
}

function scheduleVirtualStationApproach(
  route,
  flight,
  nowMs,
  reason = "virtual-station-approach",
  runtime = null,
) {
  const incomingGate = resolveRouteTravelAnchor(route, getIncomingGateID(route, flight));
  const stationID = getEndpointStationID(route, flight.currentNodeIndex);
  const station = getEndpointRecord(route, flight.currentNodeIndex);
  const estimate = incomingGate && station
    ? estimateInSystemTravel(flight, incomingGate, station, {
        ingress: true,
        destinationKind: "station",
      })
    : null;
  return setVirtualTravelPhase(
    flight,
    PHASE.VIRTUAL_STATION_APPROACH,
    estimate,
    nowMs,
    reason,
    runtime,
  );
}

function scheduleVirtualDutyDeparture(
  route,
  flight,
  nowMs,
  reason = "virtual-duty-departure",
  runtime = null,
) {
  const estimate = route.station && route.dutyAnchor
    ? estimateInSystemTravel(flight, route.station, route.dutyAnchor, {
        poweredUndock: true,
        destinationKind: "duty",
      })
    : null;
  return setVirtualTravelPhase(
    flight,
    PHASE.VIRTUAL_DUTY_DEPARTURE,
    estimate,
    nowMs,
    reason,
    runtime,
  );
}

function scheduleVirtualDutyReturn(
  route,
  flight,
  nowMs,
  reason = "virtual-duty-return",
  runtime = null,
) {
  const estimate = route.station && route.dutyAnchor
    ? estimateInSystemTravel(flight, route.dutyAnchor, route.station, {
        destinationKind: "station",
      })
    : null;
  return setVirtualTravelPhase(
    flight,
    PHASE.VIRTUAL_DUTY_RETURN,
    estimate,
    nowMs,
    reason,
    runtime,
  );
}

function estimateNetworkTrip(route, flight) {
  if (!route || route.kind !== "network" || !flight) {
    return null;
  }
  const cursor = {
    ...flight,
    currentNodeIndex: flight.direction > 0 ? 0 : route.systemIDs.length - 1,
    currentSystemID: flight.direction > 0
      ? route.systemIDs[0]
      : route.systemIDs[route.systemIDs.length - 1],
  };
  const legs = [];
  const originStation = getEndpointRecord(route, cursor.currentNodeIndex);
  const originGate = resolveRouteTravelAnchor(route, getOutgoingGateID(route, cursor));
  if (originStation && originGate) {
    legs.push({
      kind: "station_departure",
      ...estimateInSystemTravel(cursor, originStation, originGate, {
        poweredUndock: true,
        destinationKind: "gate",
      }),
    });
  }
  while (true) {
    const nextNodeIndex = cursor.currentNodeIndex + cursor.direction;
    if (nextNodeIndex < 0 || nextNodeIndex >= route.systemIDs.length) {
      break;
    }
    cursor.currentNodeIndex = nextNodeIndex;
    cursor.currentSystemID = route.systemIDs[nextNodeIndex];
    legs.push({ kind: "gate_transit", totalMs: getTransitMs() });
    const endpoint = nextNodeIndex === 0 || nextNodeIndex === route.systemIDs.length - 1;
    const incomingGate = resolveRouteTravelAnchor(route, getIncomingGateID(route, cursor));
    if (endpoint) {
      const station = getEndpointRecord(route, nextNodeIndex);
      if (incomingGate && station) {
        legs.push({
          kind: "station_approach",
          ...estimateInSystemTravel(cursor, incomingGate, station, {
            ingress: true,
            destinationKind: "station",
          }),
        });
      }
      break;
    }
    const outgoingGate = resolveRouteTravelAnchor(route, getOutgoingGateID(route, cursor));
    if (incomingGate && outgoingGate) {
      legs.push({
        kind: "system_crossing",
        ...estimateInSystemTravel(cursor, incomingGate, outgoingGate, {
          ingress: true,
          destinationKind: "gate",
        }),
      });
    }
  }
  return {
    routeID: route.routeID,
    direction: cursor.direction,
    totalMs: legs.reduce((sum, leg) => sum + toFiniteNumber(leg.totalMs, 0), 0),
    legs,
  };
}

function beginPoweredUndock(runtime, flight, nowMs) {
  const entities = getLiveEntities(runtime, flight);
  const lead = entities.find((entity) => entity.itemID === flight.leadEntityID) || entities[0];
  if (!lead || entities.length <= 0) {
    return false;
  }
  for (const entity of entities) {
    const direction = normalizeVector(entity.direction, lead.direction);
    const targetPoint = addVectors(entity.position, scaleVector(direction, POWERED_UNDOCK_TARGET_METERS));
    if (!runtime.gotoDynamicEntityPoint(flight.currentSystemID, entity.itemID, targetPoint, {
      commandSource: "livingUniversePoweredUndock",
    })) {
      return false;
    }
  }
  const envelope = buildPoweredUndockEnvelope(lead);
  flight.phase = PHASE.STATION_DEPARTURE;
  flight.poweredUndock = {
    startedAtMs: nowMs,
    origin: cloneVector(lead.position),
    ...envelope,
  };
  flight.nextTransitionAtMs = nowMs + envelope.minimumDurationMs;
  flight.lastTransitionReason = "physical-player-style-undock";
  markFlightDirty(flight);
  return true;
}

function spawnStationDeparture(runtime, route, flight, nowMs) {
  const scene = getSceneWithPlayers(runtime, flight.currentSystemID);
  const stationID = getEndpointStationID(route, flight.currentNodeIndex);
  const stationAnchor = getSceneAnchor(scene, stationID);
  const stationRecord = getEndpointRecord(route, flight.currentNodeIndex);
  if (!scene || !stationAnchor || !stationRecord) {
    return false;
  }
  const states = buildStationDepartureStates(runtime, stationRecord, flight);
  if (states.length !== flight.actorIDs.length) {
    return false;
  }
  if (!spawnAtAnchor(scene, flight, stationAnchor, { spawnStateOverrides: states })) {
    return false;
  }
  if (!beginPoweredUndock(runtime, flight, nowMs)) {
    cleanupPhysicalFlight(flight);
    return false;
  }
  return true;
}

function spawnGateArrival(runtime, route, flight, nowMs) {
  const scene = getSceneWithPlayers(runtime, flight.currentSystemID);
  const gate = getSceneAnchor(scene, getIncomingGateID(route, flight));
  if (!scene || !gate || !canMaterialize(flight)) {
    return false;
  }
  const safeOrigin = findSafeWarpOriginAnchor(scene, gate, {
    clearanceMeters: ONE_AU_IN_METERS,
    minDistanceMeters: ONE_AU_IN_METERS * 2,
    maxDistanceMeters: ONE_AU_IN_METERS * 3,
  });
  const origin = {
    kind: "coordinates",
    itemID: 0,
    itemName: `${gate.itemName || "Stargate"} living traffic ingress`,
    position: safeOrigin.position,
    direction: safeOrigin.direction,
    radius: 0,
  };
  if (!spawnAtAnchor(scene, flight, origin, { distanceFromSurfaceMeters: 2_000 })) {
    return false;
  }
  const entities = getLiveEntities(runtime, flight);
  for (let index = 0; index < entities.length; index += 1) {
    const result = runtime.startSessionlessWarpIngress(
      flight.currentSystemID,
      entities[index].itemID,
      buildLandingPoint(gate, index, entities.length, 24_000),
      {
        targetEntityID: gate.itemID,
        ignoreWarpDisruptionField: true,
        visibilitySuppressMs: 250,
        ingressDurationMs: ARRIVAL_INGRESS_MS,
      },
    );
    if (!result.success) {
      cleanupPhysicalFlight(flight);
      return false;
    }
  }
  flight.phase = PHASE.GATE_ARRIVAL;
  flight.nextTransitionAtMs = nowMs + ARRIVAL_INGRESS_MS + ARRIVAL_DWELL_MS;
  flight.lastTransitionReason = "physical-gate-arrival";
  markFlightDirty(flight);
  return true;
}

function buildWarpPlan(runtime, flight, anchor, finalPhase, nowMs) {
  const entities = getLiveEntities(runtime, flight);
  if (!anchor || entities.length <= 0) {
    return false;
  }
  const orderPlan = buildNaturalWarpOrders(entities, anchor, nowMs);
  flight.phase = PHASE.ALIGNING;
  flight.poweredUndock = null;
  flight.warpPlan = {
    targetEntityID: toPositiveInt(anchor.itemID, 0),
    finalPhase,
    orders: orderPlan.orders,
  };
  flight.nextTransitionAtMs = orderPlan.plannedWarpStartAtMs + WARP_TIMEOUT_MS;
  flight.lastTransitionReason = `aligning:${finalPhase}`;
  markFlightDirty(flight);
  return true;
}

function tickWarpPlan(runtime, flight, nowMs) {
  const plan = flight.warpPlan;
  if (!plan || !Array.isArray(plan.orders)) {
    return false;
  }
  for (const order of plan.orders) {
    if (toFiniteNumber(order.issuedAtMs, 0) > 0 || nowMs < order.issueAtMs) {
      continue;
    }
    const result = runtime.warpDynamicEntityToPoint(
      flight.currentSystemID,
      order.entityID,
      order.destinationPoint,
      {
        targetEntityID: plan.targetEntityID,
        ignoreWarpDisruptionField: true,
        forceImmediateStart: false,
      },
    );
    if (!result.success) {
      flight.lastError = result.errorMsg || "LIVING_UNIVERSE_WARP_FAILED";
      continue;
    }
    order.issuedAtMs = nowMs;
    markFlightDirty(flight);
  }
  if (plan.orders.every((order) => toFiniteNumber(order.issuedAtMs, 0) > 0)) {
    flight.phase = plan.finalPhase;
    flight.warpPlan = null;
    flight.nextTransitionAtMs = nowMs + WARP_TIMEOUT_MS;
    flight.lastError = null;
    markFlightDirty(flight);
  }
  return true;
}

function areEntitiesLanded(runtime, flight) {
  const entities = getLiveEntities(runtime, flight);
  return entities.length > 0 && entities.every((entity) => (
    String(entity.mode || "").toUpperCase() !== "WARP" &&
    !entity.pendingWarp &&
    !entity.warpState &&
    !entity.sessionlessWarpIngress
  ));
}

function advanceNetwork(route, flight, nowMs, reason, runtime = null) {
  let nextNode = flight.currentNodeIndex + flight.direction;
  if (nextNode < 0 || nextNode >= route.systemIDs.length) {
    flight.direction *= -1;
    nextNode = flight.currentNodeIndex + flight.direction;
  }
  flight.currentNodeIndex = nextNode;
  flight.currentSystemID = route.systemIDs[nextNode];
  setVirtualTravelPhase(
    flight,
    PHASE.VIRTUAL_TRANSIT,
    {
      totalMs: getTransitMs(),
      gateTransitMs: getTransitMs(),
      fromSystemID: route.systemIDs[nextNode - flight.direction],
      toSystemID: route.systemIDs[nextNode],
    },
    nowMs,
    reason,
    runtime,
  );
  runtimeState.metrics.virtualTransitions += 1;
  syncActorSystem(flight);
  markFlightDirty(flight);
  markMetaDirty();
}

function settleAtStation(route, flight, nowMs, reason) {
  if (route.kind === "network") {
    const stationID = getEndpointStationID(route, flight.currentNodeIndex);
    livingEconomyRuntime.notifyStationArrival(flight, stationID, nowMs);
    if (
      flight.estateReturnPending === true &&
      Number(stationID) === Number(route.endpointStationIDs[0])
    ) {
      flight.estateReturnPending = false;
    }
    flight.direction *= -1;
    runtimeState.metrics.completedTrips += 1;
    for (const actor of getFlightActors(flight)) {
      actor.tripsCompleted += 1;
    }
  } else if (route.kind === "duty") {
    const accepted = livingEconomyRuntime.notifyMiningArrival(
      flight,
      route.stationID,
      nowMs,
    );
    if (
      !accepted &&
      flight.miningManifest &&
      flight.miningManifest.completedAtMs > 0 &&
      (!Array.isArray(flight.miningManifest.ore) || flight.miningManifest.ore.length <= 0)
    ) {
      flight.miningManifest.depositStatus = "empty";
      flight.miningManifest.depositedAtMs = nowMs;
    }
    runtimeState.metrics.completedTrips += 1;
    for (const actor of getFlightActors(flight)) {
      actor.tripsCompleted += 1;
    }
  }
  flight.phase = PHASE.DOCKED;
  flight.virtualTravel = null;
  flight.nextTransitionAtMs = nowMs + getVirtualDockedDwellMs();
  flight.lastTransitionReason = reason;
  markFlightDirty(flight);
}

function startDuty(route, flight, nowMs, reason) {
  ensureMiningManifest(flight, route, nowMs);
  flight.phase = PHASE.DUTY;
  flight.virtualTravel = null;
  flight.nextTransitionAtMs = nowMs + getVirtualDutyDwellMs();
  flight.lastTransitionReason = reason;
  markFlightDirty(flight);
}

function registerMiningFlight(runtime, flight, route, nowMs) {
  if (flight.family !== "miner") {
    return;
  }
  const actors = getFlightActors(flight);
  const minerEntityIDs = actors
    .filter((actor) => String(actor && actor.role || "") === "miner")
    .map((actor) => toPositiveInt(actor.liveEntityID, 0))
    .filter(Boolean);
  const supportActors = actors.filter((actor) => (
    String(actor && actor.role || "") === "mining_support" &&
    toPositiveInt(actor.liveEntityID, 0) > 0
  ));
  const supportEntityIDs = supportActors
    .map((actor) => toPositiveInt(actor.liveEntityID, 0))
    .filter(Boolean);
  const supportProfile = flight.miningSupportProfile || null;
  const supportActor = supportActors[0] || null;
  if (supportProfile && supportActor) {
    const supportEntityID = toPositiveInt(supportActor.liveEntityID, 0);
    const liveEntitiesByID = new Map(
      getLiveEntities(runtime, flight)
        .map((entity) => [toPositiveInt(entity && entity.itemID, 0), entity]),
    );
    for (const minerEntityID of minerEntityIDs) {
      const minerEntity = liveEntitiesByID.get(minerEntityID);
      if (minerEntity) {
        minerEntity.npcMiningSupportBonus = {
          sourceEntityID: supportEntityID,
          supportClass: String(supportProfile.supportClass || "industrial_command"),
          cycleTimeMultiplier: toFiniteNumber(supportProfile.cycleTimeMultiplier, 1),
          rangeMultiplier: toFiniteNumber(supportProfile.rangeMultiplier, 1),
        };
      }
    }
  }
  const result = getMiningNpcOperations().registerAmbientMiningFleet({
    source: "livingUniverse",
    systemID: flight.currentSystemID,
    minerEntityIDs,
    haulerEntityIDs: supportEntityIDs,
    onGridSupport: supportEntityIDs.length > 0,
    originAnchor: {
      position: cloneVector(route.station && route.station.position),
      direction: cloneVector(route.station && route.station.direction, { x: 1, y: 0, z: 0 }),
    },
    activeAsteroidID: route.dutyAnchorID,
    createdAtMs: nowMs,
  });
  if (result && result.success && result.data) {
    flight.miningFleetID = result.data.fleetID;
  }
}

function buildMiningDutySpawnStates(dutyAnchor, actorCount) {
  const count = Math.max(0, toPositiveInt(actorCount, 0));
  const direction = normalizeVector(
    dutyAnchor && dutyAnchor.direction,
    { x: 1, y: 0, z: 0 },
  );
  return Array.from({ length: count }, (_unused, index) => {
    const position = buildLandingPoint(dutyAnchor, index, count, 8_000);
    return {
      position,
      velocity: { x: 0, y: 0, z: 0 },
      direction,
      targetPoint: cloneVector(dutyAnchor && dutyAnchor.position, position),
      mode: "ORBIT",
      speedFraction: 0,
      targetEntityID: toPositiveInt(dutyAnchor && dutyAnchor.itemID, 0),
      followRange: 1_200,
      orbitDistance: 1_200,
    };
  });
}

function materializeDuty(runtime, route, flight, nowMs) {
  ensureMiningManifest(flight, route, nowMs);
  const scene = getSceneWithPlayers(runtime, flight.currentSystemID);
  const dutyAnchor = getDutySceneAnchor(scene, route);
  const spawnStateOverrides = buildMiningDutySpawnStates(
    dutyAnchor,
    getFlightActors(flight).length,
  );
  if (
    !scene ||
    !dutyAnchor ||
    spawnStateOverrides.length <= 0 ||
    !spawnAtAnchor(scene, flight, dutyAnchor, { spawnStateOverrides })
  ) {
    return false;
  }
  const entities = getLiveEntities(runtime, flight);
  for (let index = 0; index < entities.length; index += 1) {
    getNpcService().setBehaviorOverrides(entities[index].itemID, {
      autoAggro: false,
      autoActivateWeapons: false,
      targetPreference: "none",
      movementMode: "orbit",
      orbitDistanceMeters: 1_200,
      followRangeMeters: 800,
      idleAnchorOrbit: false,
    });
  }
  registerMiningFlight(runtime, flight, route, nowMs);
  flight.phase = PHASE.DUTY_LIVE;
  flight.lastTransitionReason = "physical-mining-duty-materialized";
  markFlightDirty(flight);
  return true;
}

function materializeDutyReturn(runtime, route, flight, nowMs) {
  const scene = getSceneWithPlayers(runtime, flight.currentSystemID);
  const dutyAnchor = getDutySceneAnchor(scene, route);
  const station = getSceneAnchor(scene, route.stationID);
  if (
    !scene ||
    !dutyAnchor ||
    !station ||
    !spawnAtAnchor(scene, flight, dutyAnchor, { distanceFromSurfaceMeters: 8_000 })
  ) {
    return false;
  }
  if (!buildWarpPlan(runtime, flight, station, PHASE.RETURNING_TO_STATION, nowMs)) {
    cleanupPhysicalFlight(flight);
    return false;
  }
  flight.lastTransitionReason = "physical-duty-return-materialized";
  markFlightDirty(flight);
  return true;
}

function handleLoss(route, flight, runtime, nowMs) {
  const expected = new Set(flight.entityIDs || []);
  const live = new Set(getLiveEntities(runtime, flight).map((entity) => entity.itemID));
  const missing = [...expected].filter((entityID) => !live.has(entityID));
  if (missing.length <= 0) {
    return false;
  }
  const missingActorIDs = getFlightActors(flight)
    .filter((actor) => missing.includes(actor.liveEntityID))
    .map((actor) => actor.actorID);
  const missingActors = getFlightActors(flight).filter((actor) => missingActorIDs.includes(actor.actorID));
  if (missingActors.some((actor) => String(actor.role || "") === "hauler")) {
    livingEconomyRuntime.notifyFlightLoss(flight, missingActorIDs, nowMs);
  }
  if (flight.miningManifest) {
    flight.miningManifest.depositStatus = "lost";
    flight.miningManifest.depositedAtMs = nowMs;
    flight.miningManifest.lastError = "MINING_FLIGHT_LOSS";
  }
  for (const actor of getFlightActors(flight)) {
    if (missing.includes(actor.liveEntityID)) {
      actor.losses = toPositiveInt(actor.losses, 0) + 1;
      actor.replacementCount = toPositiveInt(actor.replacementCount, 0) + 1;
      recordShipDestruction(actor, "physical");
      markActorDirty(actor);
      // Resident track R1: split player kills from cleanup in the physical-loss path too.
      if (livingKillCreditLedger.consumeKillCredit(actor.actorID, nowMs) > 0) {
        runtimeState.metrics.playerCreditedPhysicalLosses =
          toPositiveInt(runtimeState.metrics.playerCreditedPhysicalLosses, 0) + 1;
      }
    }
  }
  runtimeState.metrics.replacements += missingActorIDs.length;
  flight.replacementDemandIDs = [...new Set([
    ...(Array.isArray(flight.replacementDemandIDs)
      ? flight.replacementDemandIDs
      : []),
    ...livingEconomyRuntime.registerReplacementLoss({
      encounterID: `flight-loss:${flight.flightID}:${nowMs}`,
      victims: missingActors.map((actor) => buildConflictVictimDescriptor(actor, {
        targetSystemID: flight.currentSystemID,
      })),
      nowMs,
    }),
  ].map(String).filter(Boolean))];
  cleanupPhysicalFlight(flight);
  flight.currentNodeIndex = 0;
  flight.currentSystemID = route.systemIDs[0];
  flight.direction = 1;
  flight.phase = PHASE.DOCKED;
  flight.nextTransitionAtMs = nowMs + getVirtualReplacementMs();
  flight.lastTransitionReason = "loss-replacement-scheduled";
  flight.lastError = `SHIP_LOSS:${missing.length}`;
  syncActorSystem(flight);
  markFlightDirty(flight);
  return true;
}

function fallbackToVirtual(route, flight, nowMs, reason, runtime = null) {
  const previousPhase = flight.phase;
  const plannedFinalPhase = flight.warpPlan && flight.warpPlan.finalPhase;
  const remainingMs = Math.max(1_000, toFiniteNumber(flight.nextTransitionAtMs, nowMs) - nowMs);
  if (route.kind === "duty" && previousPhase === PHASE.DUTY_LIVE) {
    capturePhysicalMiningCargo(runtime, route, flight, nowMs);
  }
  cleanupPhysicalFlight(flight);
  if (route.kind === "duty") {
    if (previousPhase === PHASE.STATION_DWELL) {
      settleAtStation(route, flight, nowMs, reason);
    } else if (
      previousPhase === PHASE.RETURNING_TO_STATION ||
      plannedFinalPhase === PHASE.RETURNING_TO_STATION
    ) {
      scheduleVirtualDutyReturn(route, flight, nowMs, reason, runtime);
    } else if (previousPhase === PHASE.DUTY_LIVE) {
      flight.phase = PHASE.DUTY;
      flight.virtualTravel = null;
      flight.nextTransitionAtMs = nowMs + remainingMs;
      flight.lastTransitionReason = reason;
      markFlightDirty(flight);
    } else {
      scheduleVirtualDutyDeparture(route, flight, nowMs, reason, runtime);
    }
    return;
  }
  if (previousPhase === PHASE.STATION_DWELL) {
    settleAtStation(route, flight, nowMs, reason);
  } else if (previousPhase === PHASE.GATE_DWELL) {
    advanceNetwork(route, flight, nowMs, reason, runtime);
  } else if (
    previousPhase === PHASE.WARPING_TO_STATION ||
    plannedFinalPhase === PHASE.WARPING_TO_STATION
  ) {
    scheduleVirtualStationApproach(route, flight, nowMs, reason, runtime);
  } else if (
    previousPhase === PHASE.GATE_ARRIVAL ||
    previousPhase === PHASE.WARPING_ACROSS_SYSTEM ||
    plannedFinalPhase === PHASE.WARPING_ACROSS_SYSTEM
  ) {
    const endpoint = flight.currentNodeIndex === 0 ||
      flight.currentNodeIndex === route.systemIDs.length - 1;
    if (endpoint) {
      scheduleVirtualStationApproach(route, flight, nowMs, reason, runtime);
    } else {
      scheduleVirtualCrossing(route, flight, nowMs, reason, runtime);
    }
  } else {
    scheduleVirtualDeparture(route, flight, nowMs, reason, runtime);
  }
}

function tickPhysical(runtime, route, flight, nowMs) {
  const scene = getSceneWithPlayers(runtime, flight.currentSystemID);
  if (!scene) {
    fallbackToVirtual(route, flight, nowMs, "virtualized-empty-scene", runtime);
    return;
  }
  if (handleLoss(route, flight, runtime, nowMs)) {
    return;
  }
  if (flight.phase === PHASE.STATION_DEPARTURE && nowMs >= flight.nextTransitionAtMs) {
    const lead = getLiveEntities(runtime, flight).find((entity) => entity.itemID === flight.leadEntityID);
    const elapsed = nowMs - toFiniteNumber(flight.poweredUndock && flight.poweredUndock.startedAtMs, nowMs);
    const cleared = lead && distanceBetween(lead.position, flight.poweredUndock.origin) >= flight.poweredUndock.clearanceMeters;
    if (!cleared) {
      if (elapsed < flight.poweredUndock.maximumDurationMs) {
        return;
      }
      fallbackToVirtual(route, flight, nowMs, "powered-undock-clearance-timeout", runtime);
      return;
    }
    const target = route.kind === "duty"
      ? getSceneAnchor(scene, route.dutyAnchorID)
      : getSceneAnchor(scene, getOutgoingGateID(route, flight));
    const finalPhase = route.kind === "duty" ? PHASE.WARPING_TO_DUTY : PHASE.WARPING_TO_GATE;
    if (!buildWarpPlan(runtime, flight, target, finalPhase, nowMs)) {
      fallbackToVirtual(route, flight, nowMs, "undock-warp-plan-failed", runtime);
    }
    return;
  }
  if (flight.phase === PHASE.ALIGNING) {
    if (nowMs >= flight.nextTransitionAtMs || !tickWarpPlan(runtime, flight, nowMs)) {
      fallbackToVirtual(route, flight, nowMs, "warp-alignment-timeout", runtime);
    }
    return;
  }
  if (flight.phase === PHASE.GATE_ARRIVAL && nowMs >= flight.nextTransitionAtMs) {
    const stationID = getEndpointStationID(route, flight.currentNodeIndex);
    const target = stationID > 0
      ? getSceneAnchor(scene, stationID)
      : getSceneAnchor(scene, getOutgoingGateID(route, flight));
    const finalPhase = stationID > 0 ? PHASE.WARPING_TO_STATION : PHASE.WARPING_ACROSS_SYSTEM;
    if (!buildWarpPlan(runtime, flight, target, finalPhase, nowMs)) {
      fallbackToVirtual(route, flight, nowMs, "arrival-warp-plan-failed", runtime);
    }
    return;
  }
  if (
    flight.phase === PHASE.WARPING_TO_GATE ||
    flight.phase === PHASE.WARPING_ACROSS_SYSTEM
  ) {
    if (areEntitiesLanded(runtime, flight)) {
      flight.phase = PHASE.GATE_DWELL;
      flight.nextTransitionAtMs = nowMs + GATE_DWELL_MS;
      markFlightDirty(flight);
    } else if (nowMs >= flight.nextTransitionAtMs) {
      fallbackToVirtual(route, flight, nowMs, "gate-warp-timeout", runtime);
    }
    return;
  }
  if (flight.phase === PHASE.WARPING_TO_STATION || flight.phase === PHASE.RETURNING_TO_STATION) {
    if (areEntitiesLanded(runtime, flight)) {
      flight.phase = PHASE.STATION_DWELL;
      flight.nextTransitionAtMs = nowMs + ARRIVAL_DWELL_MS;
      markFlightDirty(flight);
    } else if (nowMs >= flight.nextTransitionAtMs) {
      fallbackToVirtual(route, flight, nowMs, "station-warp-timeout", runtime);
    }
    return;
  }
  if (flight.phase === PHASE.WARPING_TO_DUTY) {
    if (areEntitiesLanded(runtime, flight)) {
      registerMiningFlight(runtime, flight, route, nowMs);
      flight.phase = PHASE.DUTY_LIVE;
      flight.nextTransitionAtMs = nowMs + getDutyDwellMs();
      markFlightDirty(flight);
    } else if (nowMs >= flight.nextTransitionAtMs) {
      fallbackToVirtual(route, flight, nowMs, "duty-warp-timeout", runtime);
    }
    return;
  }
  if (flight.phase === PHASE.GATE_DWELL && nowMs >= flight.nextTransitionAtMs) {
    cleanupPhysicalFlight(flight);
    runtimeState.metrics.physicalGateJumps += 1;
    advanceNetwork(route, flight, nowMs, "physical-gate-jump", runtime);
    return;
  }
  if (flight.phase === PHASE.STATION_DWELL && nowMs >= flight.nextTransitionAtMs) {
    cleanupPhysicalFlight(flight);
    settleAtStation(route, flight, nowMs, "physical-station-dock");
    return;
  }
  if (flight.phase === PHASE.DUTY_LIVE && nowMs >= flight.nextTransitionAtMs) {
    capturePhysicalMiningCargo(runtime, route, flight, nowMs, { complete: true });
    const station = getSceneAnchor(scene, route.stationID);
    if (!buildWarpPlan(runtime, flight, station, PHASE.RETURNING_TO_STATION, nowMs)) {
      fallbackToVirtual(route, flight, nowMs, "duty-return-plan-failed", runtime);
    }
  }
}

function tickVirtual(runtime, route, flight, nowMs) {
  if (
    getSceneWithPlayers(runtime, flight.currentSystemID) &&
    flight.virtualTravel &&
    toFiniteNumber(flight.virtualTravel.appliedTimeMultiplier, 1) > 1
  ) {
    rebaseAcceleratedVirtualTravelForObservation(flight, nowMs);
  }
  if (flight.phase === PHASE.DUTY && nowMs < flight.nextTransitionAtMs) {
    materializeDuty(runtime, route, flight, nowMs);
    return;
  }
  if (nowMs < flight.nextTransitionAtMs) {
    if (
      flight.phase === PHASE.VIRTUAL_DEPARTURE ||
      flight.phase === PHASE.VIRTUAL_DUTY_DEPARTURE
    ) {
      spawnStationDeparture(runtime, route, flight, nowMs);
    } else if (
      flight.phase === PHASE.VIRTUAL_TRANSIT ||
      flight.phase === PHASE.VIRTUAL_CROSSING ||
      flight.phase === PHASE.VIRTUAL_STATION_APPROACH
    ) {
      spawnGateArrival(runtime, route, flight, nowMs);
    } else if (flight.phase === PHASE.VIRTUAL_DUTY_RETURN) {
      materializeDutyReturn(runtime, route, flight, nowMs);
    }
    return;
  }
  if (flight.phase === PHASE.DOCKED) {
    if (livingEconomyRuntime.shouldHoldReplacementFlight(flight)) {
      flight.nextTransitionAtMs = getEconomyHoldWakeAtMs(flight, nowMs);
      flight.lastTransitionReason = "waiting-for-replacement-hulls-and-fittings";
      markFlightDirty(flight);
      return;
    }
    if (livingEconomyRuntime.shouldHoldFreightFlight(flight)) {
      flight.nextTransitionAtMs = getEconomyHoldWakeAtMs(flight, nowMs);
      flight.lastTransitionReason = "waiting-for-living-economy-job";
      markFlightDirty(flight);
      return;
    }
    if (livingEconomyRuntime.shouldHoldMiningFlight(flight)) {
      flight.nextTransitionAtMs = getEconomyHoldWakeAtMs(flight, nowMs);
      flight.lastTransitionReason = "waiting-for-mining-deposit-credit";
      markFlightDirty(flight);
      return;
    }
    if (spawnStationDeparture(runtime, route, flight, nowMs)) {
      return;
    }
    if (route.kind === "duty") {
      scheduleVirtualDutyDeparture(route, flight, nowMs, "virtual-station-to-duty", runtime);
    } else {
      scheduleVirtualDeparture(route, flight, nowMs, "virtual-station-departure", runtime);
    }
    return;
  }
  if (flight.phase === PHASE.VIRTUAL_DEPARTURE) {
    advanceNetwork(
      route,
      flight,
      nowMs,
      "virtual-gate-jump-after-real-time-departure",
      runtime,
    );
    return;
  }
  if (flight.phase === PHASE.VIRTUAL_TRANSIT) {
    if (spawnGateArrival(runtime, route, flight, nowMs)) {
      return;
    }
    const endpoint = flight.currentNodeIndex === 0 || flight.currentNodeIndex === route.systemIDs.length - 1;
    if (endpoint) {
      scheduleVirtualStationApproach(
        route,
        flight,
        nowMs,
        "virtual-station-approach",
        runtime,
      );
    } else {
      scheduleVirtualCrossing(route, flight, nowMs, "virtual-system-crossing", runtime);
    }
    return;
  }
  if (flight.phase === PHASE.VIRTUAL_CROSSING) {
    advanceNetwork(route, flight, nowMs, "virtual-gate-jump", runtime);
    return;
  }
  if (flight.phase === PHASE.VIRTUAL_STATION_APPROACH) {
    settleAtStation(route, flight, nowMs, "virtual-station-arrival");
    return;
  }
  if (flight.phase === PHASE.VIRTUAL_DUTY_DEPARTURE) {
    startDuty(route, flight, nowMs, "virtual-duty-arrival");
    return;
  }
  if (flight.phase === PHASE.DUTY) {
    if (!completeVirtualMiningDuty(runtime, route, flight, nowMs)) {
      flight.nextTransitionAtMs = nowMs + 15_000;
      flight.lastTransitionReason = "virtual-mining-transaction-retry";
      markFlightDirty(flight);
      return;
    }
    scheduleVirtualDutyReturn(route, flight, nowMs, "virtual-duty-completed", runtime);
    return;
  }
  if (flight.phase === PHASE.VIRTUAL_DUTY_RETURN) {
    settleAtStation(route, flight, nowMs, "virtual-duty-station-arrival");
  }
}

function cleanupStaleOperatorControllers() {
  const entityIDs = nativeNpcStore.listNativeControllers()
    .filter((controller) => String(controller && controller.operatorKind || "") === OPERATOR_KIND)
    .map((controller) => toPositiveInt(controller && controller.entityID, 0))
    .filter((entityID) => entityID > 0);
  for (const entityID of entityIDs) {
    cleanupEntity(entityID);
  }
  return entityIDs.length;
}

function recoverLoadedState(state, nowMs) {
  for (const flight of Object.values(state.flights || {})) {
    const previousPhase = flight.phase;
    const plannedFinalPhase = flight.warpPlan && flight.warpPlan.finalPhase;
    flight.entityIDs = [];
    flight.leadEntityID = 0;
    flight.materialized = false;
    releasePhysicalFlightBudget(flight);
    flight.poweredUndock = null;
    flight.warpPlan = null;
    flight.miningFleetID = 0;
    if (PHYSICAL_PHASES.has(previousPhase)) {
      const route = routeDefinitionsByID.get(flight.routeID);
      if (!route) {
        flight.phase = PHASE.DOCKED;
        flight.virtualTravel = null;
        flight.nextTransitionAtMs = nowMs + 60_000;
        flight.lastTransitionReason = "restart-route-missing";
      } else if (route.kind === "duty") {
        if (previousPhase === PHASE.STATION_DWELL) {
          settleAtStation(route, flight, nowMs, "restart-recovered-station-dwell");
        } else if (
          previousPhase === PHASE.RETURNING_TO_STATION ||
          plannedFinalPhase === PHASE.RETURNING_TO_STATION
        ) {
          scheduleVirtualDutyReturn(route, flight, nowMs, "restart-recovered-duty-return");
        } else if (previousPhase === PHASE.DUTY_LIVE) {
          startDuty(route, flight, nowMs, "restart-recovered-duty");
        } else {
          scheduleVirtualDutyDeparture(route, flight, nowMs, "restart-recovered-duty-departure");
        }
      } else if (previousPhase === PHASE.STATION_DWELL) {
        settleAtStation(route, flight, nowMs, "restart-recovered-station-dwell");
      } else if (previousPhase === PHASE.GATE_DWELL) {
        advanceNetwork(route, flight, nowMs, "restart-recovered-gate-dwell");
      } else if (
        previousPhase === PHASE.WARPING_TO_STATION ||
        plannedFinalPhase === PHASE.WARPING_TO_STATION
      ) {
        scheduleVirtualStationApproach(route, flight, nowMs, "restart-recovered-station-approach");
      } else if (
        previousPhase === PHASE.GATE_ARRIVAL ||
        previousPhase === PHASE.WARPING_ACROSS_SYSTEM ||
        plannedFinalPhase === PHASE.WARPING_ACROSS_SYSTEM
      ) {
        const endpoint = flight.currentNodeIndex === 0 ||
          flight.currentNodeIndex === route.systemIDs.length - 1;
        if (endpoint) {
          scheduleVirtualStationApproach(route, flight, nowMs, "restart-recovered-endpoint-approach");
        } else {
          scheduleVirtualCrossing(route, flight, nowMs, "restart-recovered-system-crossing");
        }
      } else {
        scheduleVirtualDeparture(route, flight, nowMs, "restart-recovered-departure");
      }
    }
    for (const actorID of flight.actorIDs || []) {
      const actor = state.actors[actorID];
      if (actor) {
        actor.liveEntityID = 0;
        actor.state = "virtual";
        actor.currentSystemID = flight.currentSystemID;
      }
    }
  }
  for (const encounter of Object.values(state.encounters || {})) {
    if (!encounter || encounter.phase === livingConflictRuntime.PHASE.RESOLVED) continue;
    encounter.materialized = false;
    encounter.distressBeaconActive = false;
    encounter.distressBeaconID = null;
  }
  state.updatedAtMs = nowMs;
  return state;
}

function initialize(nowMs = Date.now()) {
  if (initialized) {
    return;
  }
  initialized = true;
  buildRouteDefinitions();
  let seededMiningBaselines = 0;
  let trackedMiningResources = 0;
  npcPhysicalBudget.releaseOwner(OPERATOR_KIND);
  const removedStale = cleanupStaleOperatorControllers();
  const target = getPopulationTarget();
  const persisted = livingStateStore.readState();
  const validPersisted = (
    persisted.populationRevision === POPULATION_REVISION &&
    persisted.populationSize === target &&
    Object.keys(persisted.actors || {}).length === target &&
    Object.keys(persisted.flights || {}).length > 0
  );
  if (validPersisted) {
    runtimeState = persisted;
    for (const flight of Object.values(runtimeState.flights || {})) {
      if (flight && flight.dynamicRouteSpec) {
        registerDynamicFreightRoute(flight.dynamicRouteSpec);
      }
    }
    recoverLoadedState(runtimeState, nowMs);
  } else {
    runtimeState = buildPopulationPlan(target, nowMs);
  }
  // Older persisted populations predate the roaming layer. Reconcile only at
  // startup/reset; the hot path thereafter is entirely deadline-driven.
  initializeRoamingConflictState(runtimeState, nowMs);
  const activeMiningRouteIDs = new Set(
    Object.values(runtimeState.flights || {})
      .filter((flight) => String(flight && flight.family || "") === "miner")
      .map((flight) => String(flight.routeID || ""))
      .filter(Boolean),
  );
  for (const routeID of activeMiningRouteIDs) {
    const route = routeDefinitionsByID.get(routeID);
    if (!route || route.kind !== "duty") continue;
    const seedResult = route.generatedResourceSite === true
      ? getMiningRuntimeState().ensurePersistedGeneratedResourceBaselines(
          route.systemID,
          [getMiningResourceSiteService().buildGeneratedResourceSiteDefinition(
            route.systemID,
            route.resourceFamily,
            0,
          )].filter(Boolean),
          { nowMs },
        )
      : getMiningRuntimeState().ensurePersistedAsteroidBaselines(route.systemID, {
          beltIDs: [route.dutyAnchorID],
          nowMs,
        });
    if (!seedResult || seedResult.success !== true) {
      log.warn(
        `[LivingUniverse] Could not initialize mining ledger for system=${route.systemID} ` +
          `belt=${route.dutyAnchorID}: ${seedResult && seedResult.errorMsg || "UNKNOWN_ERROR"}`,
      );
      continue;
    }
    seededMiningBaselines += toPositiveInt(seedResult.data && seedResult.data.seededCount, 0);
    trackedMiningResources += toPositiveInt(seedResult.data && seedResult.data.generatedCount, 0);
  }
  markFullRewrite();
  rebuildFlightSchedule(nowMs, "startup");
  syncPilotPresence({ full: true });
  persistState(nowMs, true);
  log.info(
    `[LivingUniverse] ${validPersisted ? "Recovered" : "Created"} ${target} persistent actors in ` +
      `${Object.keys(runtimeState.flights).length} flights across ${routeDefinitionsByID.size} routes` +
      (removedStale > 0 ? `; removed ${removedStale} stale physical controllers.` : "."),
  );
  log.info(
    `[LivingUniverse] Mining ledgers ready: ${trackedMiningResources} deterministic mineable ` +
      `resources across ${activeMiningRouteIDs.size} active duty sites ` +
      `(${ALL_DUTY_ROUTE_SPECS.length} regional candidates)` +
      (seededMiningBaselines > 0 ? `; initialized ${seededMiningBaselines} new baselines.` : "."),
  );
}

function persistState(nowMs, force = false) {
  if (!runtimeState || !dirty) {
    return;
  }
  if (!force && nowMs - lastPersistAtMs < getPersistenceIntervalMs()) {
    return;
  }
  runtimeState.updatedAtMs = nowMs;
  const batch = buildPersistenceBatch();
  batch.metaDirty = true;
  const persistenceStartedAtMs = performance.now();
  let result = livingStateStore.writeState(runtimeState, batch);
  if (result && result.success === true && result.migration === true) {
    const migrationFlush = livingStateStore.flushDurably();
    if (!migrationFlush || migrationFlush.success !== true) {
      result = {
        ...result,
        success: false,
        errorMsg: migrationFlush && migrationFlush.errorMsg ||
          "LIVING_UNIVERSE_MIGRATION_FLUSH_FAILED",
        migrationFlush,
      };
    }
  }
  const stageDurationMs = Math.max(0, performance.now() - persistenceStartedAtMs);
  if (result.success) {
    dirty = false;
    clearPersistenceDirtyState();
    lastPersistAtMs = nowMs;
    persistenceMetrics.checkpoints += 1;
    persistenceMetrics.fullRewrites += batch.fullRewrite ? 1 : 0;
    persistenceMetrics.fallbackFullRewrites += batch.fallbackFullRewrite ? 1 : 0;
    persistenceMetrics.lastCheckpointAtMs = nowMs;
    persistenceMetrics.lastStageDurationMs = stageDurationMs;
    persistenceMetrics.lastBatch = {
      fullRewrite: batch.fullRewrite,
      fallbackFullRewrite: batch.fallbackFullRewrite,
      actorRows: batch.dirtyActorIDs.length,
      flightRows: batch.dirtyFlightIDs.length,
      encounterRows: batch.dirtyEncounterIDs.length,
      encounterDeletes: batch.removedEncounterIDs.length,
      metaDirty: batch.metaDirty,
      roamingDirty: batch.roamingDirty,
      ...(result.stats && typeof result.stats === "object" ? result.stats : {}),
    };
  } else {
    log.warn(`[LivingUniverse] State persistence failed: ${result.errorMsg || "WRITE_FAILED"}`);
  }
}

function indexFlightSystem(flight) {
  const flightID = String(flight && flight.flightID || "");
  if (!flightID) {
    return;
  }
  const nextSystemID = toPositiveInt(flight.currentSystemID, 0);
  const previousSystemID = indexedSystemByFlightID.get(flightID) || 0;
  if (previousSystemID === nextSystemID) {
    return;
  }
  if (previousSystemID > 0) {
    const previousFlights = flightIDsBySystem.get(previousSystemID);
    if (previousFlights) {
      previousFlights.delete(flightID);
      if (previousFlights.size <= 0) {
        flightIDsBySystem.delete(previousSystemID);
      }
    }
  }
  if (nextSystemID > 0) {
    if (!flightIDsBySystem.has(nextSystemID)) {
      flightIDsBySystem.set(nextSystemID, new Set());
    }
    flightIDsBySystem.get(nextSystemID).add(flightID);
    indexedSystemByFlightID.set(flightID, nextSystemID);
  } else {
    indexedSystemByFlightID.delete(flightID);
  }
}

function isReplacementPriorityScheduledFlight(flight) {
  return Boolean(
    livingEconomyRuntime &&
    typeof livingEconomyRuntime.hasReplacementPriorityFreightWork === "function" &&
    livingEconomyRuntime.hasReplacementPriorityFreightWork(flight)
  );
}

function removeFlightFromSchedule(flightID) {
  flightDeadlineQueue.remove(flightID);
  replacementFreightDeadlineQueue.remove(flightID);
}

function scheduleFlightDeadline(flight, wakeAtMs) {
  const flightID = String(flight && flight.flightID || "").trim();
  if (!flightID) return;
  if (isReplacementPriorityScheduledFlight(flight)) {
    flightDeadlineQueue.remove(flightID);
    replacementFreightDeadlineQueue.schedule(flightID, wakeAtMs, null);
    return;
  }
  replacementFreightDeadlineQueue.remove(flightID);
  flightDeadlineQueue.schedule(flightID, wakeAtMs, null);
}

function isDeadlineQueueDue(queue, nowMs) {
  const next = queue.peek();
  return Boolean(next && next.dueAtMs <= nowMs);
}

function getNextFlightDeadlineEntry() {
  const general = flightDeadlineQueue.peek();
  const replacement = replacementFreightDeadlineQueue.peek();
  if (!general) return replacement;
  if (!replacement) return general;
  if (replacement.dueAtMs !== general.dueAtMs) {
    return replacement.dueAtMs < general.dueAtMs ? replacement : general;
  }
  return replacement.key.localeCompare(general.key) < 0 ? replacement : general;
}

function resetReplacementSchedulerFairness() {
  replacementSchedulerPriorityCredit = 0;
  replacementSchedulerGeneralCredit = 0;
}

function selectDueFlightQueue(nowMs) {
  const replacementDue = isDeadlineQueueDue(
    replacementFreightDeadlineQueue,
    nowMs,
  );
  const generalDue = isDeadlineQueueDue(flightDeadlineQueue, nowMs);
  if (!replacementDue && !generalDue) return null;
  if (!replacementDue || !generalDue) {
    schedulerMetrics.replacementSchedulerWorkConservingSelections += 1;
    return replacementDue
      ? { lane: "replacement", queue: replacementFreightDeadlineQueue }
      : { lane: "general", queue: flightDeadlineQueue };
  }

  const replacementWeight = getReplacementSchedulerSharePercent();
  const generalWeight = 100 - replacementWeight;
  replacementSchedulerPriorityCredit += replacementWeight;
  replacementSchedulerGeneralCredit += generalWeight;
  schedulerMetrics.replacementSchedulerContestedSelections += 1;
  if (
    replacementSchedulerPriorityCredit >= replacementSchedulerGeneralCredit
  ) {
    replacementSchedulerPriorityCredit -= 100;
    schedulerMetrics.replacementSchedulerPrioritySelections += 1;
    return { lane: "replacement", queue: replacementFreightDeadlineQueue };
  }
  replacementSchedulerGeneralCredit -= 100;
  schedulerMetrics.replacementSchedulerGeneralSelections += 1;
  return { lane: "general", queue: flightDeadlineQueue };
}

function getFlightWakeAtMs(flight, nowMs) {
  const transitionAtMs = Math.max(0, toFiniteNumber(flight && flight.nextTransitionAtMs, nowMs));
  if (flight && (flight.materialized === true || PHYSICAL_PHASES.has(flight.phase))) {
    return Math.min(transitionAtMs || nowMs + TICK_INTERVAL_MS, nowMs + TICK_INTERVAL_MS);
  }
  return transitionAtMs;
}

function scheduleFlight(flight, nowMs) {
  if (!flight || !flight.flightID) {
    return;
  }
  let wakeAtMs = getFlightWakeAtMs(flight, nowMs);
  if (wakeAtMs <= nowMs) {
    wakeAtMs = nowMs + TICK_INTERVAL_MS;
  }
  scheduleFlightDeadline(flight, wakeAtMs);
  indexFlightSystem(flight);
}

function rescheduleChangedFlight(flight, nowMs = Date.now()) {
  scheduleFlight(flight, nowMs);
  schedulerMetrics.incrementalFlightReschedules += 1;
}

function collectConflictFlightIDs(target = new Set()) {
  for (const encounter of Object.values(runtimeState && runtimeState.encounters || {})) {
    if (
      !["staging", "active"].includes(String(encounter && encounter.phase || "")) &&
      encounter && encounter.evidencePending !== true
    ) {
      continue;
    }
    for (const flightID of [
      ...(Array.isArray(encounter && encounter.attackerFlightIDs)
        ? encounter.attackerFlightIDs
        : [encounter && encounter.attackerFlightID]),
      ...(Array.isArray(encounter && encounter.defenderFlightIDs)
        ? encounter.defenderFlightIDs
        : [encounter && encounter.defenderFlightID]),
      encounter && encounter.response && encounter.response.flightID,
    ]) {
      const normalizedID = String(flightID || "").trim();
      if (normalizedID) target.add(normalizedID);
    }
  }
  return target;
}

function rebuildFlightSchedule(nowMs = Date.now(), reason = "unspecified") {
  flightDeadlineQueue.clear();
  replacementFreightDeadlineQueue.clear();
  flightIDsBySystem.clear();
  indexedSystemByFlightID.clear();
  for (const flight of Object.values(runtimeState && runtimeState.flights || {})) {
    scheduleFlightDeadline(flight, getFlightWakeAtMs(flight, nowMs));
    indexFlightSystem(flight);
  }
  schedulerInitialized = true;
  schedulerRebuildRequested = false;
  schedulerMetrics.queueRebuilds += 1;
  const normalizedReason = String(reason || "unspecified").trim() || "unspecified";
  schedulerMetrics.queueRebuildsByReason[normalizedReason] =
    (schedulerMetrics.queueRebuildsByReason[normalizedReason] || 0) + 1;
}

function listObservedFlightIDs(runtime) {
  const observed = new Set();
  if (!runtime || !(runtime.scenes instanceof Map)) {
    return observed;
  }
  for (const [systemID, scene] of runtime.scenes) {
    if (!(scene && scene.sessions instanceof Map && scene.sessions.size > 0)) {
      continue;
    }
    for (const flightID of flightIDsBySystem.get(toPositiveInt(systemID, 0)) || []) {
      observed.add(flightID);
    }
  }
  return observed;
}

function processRoamingFlight(runtime, flight, nowMs) {
  if (!flight || !flight.roamingGroupID) return false;
  const group = getRoamingGroupForFlight(flight);
  if (!group) {
    delete flight.roamingGroupID;
    delete flight.roamingPhase;
    delete flight.roamingGateID;
    markFlightDirty(flight);
    return false;
  }
  if (livingEconomyRuntime.shouldHoldReplacementFlight(flight)) {
    if (flight.materialized) cleanupPhysicalFlight(flight);
    const holdWakeAtMs = getEconomyHoldWakeAtMs(flight, nowMs);
    if (toFiniteNumber(flight.nextTransitionAtMs, 0) < holdWakeAtMs) {
      flight.nextTransitionAtMs = holdWakeAtMs;
      flight.lastTransitionReason = "roaming-replacement-supply-hold";
      markFlightDirty(flight);
    }
    scheduleFlight(flight, nowMs);
    return true;
  }
  if (projectRoamingGroupToFlight(
    runtimeState,
    flight,
    group,
    nowMs,
    "roaming-deadline-projection",
  )) {
    syncActorSystem(flight);
    markFlightDirty(flight);
  }
  const isCamp = group.phase === livingRoamingKernel.PHASE.CAMPING;
  const scene = isCamp ? getSceneWithPlayers(runtime, group.currentSystemID) : null;
  if (isCamp && scene) {
    const route = routeDefinitionsByID.get(flight.routeID);
    if (flight.materialized && route && handleLoss(route, flight, runtime, nowMs)) {
      scheduleFlight(flight, nowMs);
      return true;
    }
    const anchor = getSceneAnchor(scene, toPositiveInt(group.currentGateID, 0));
    if (anchor && !flight.materialized) {
      if (spawnAtAnchor(scene, flight, anchor, {
        distanceFromSurfaceMeters: 8_000,
        transient: false,
        playerNeutral: true,
      })) {
        flight.lastTransitionReason = "roaming-gate-camp-observed";
        syncActorSystem(flight);
      }
    } else if (flight.materialized && getLiveEntities(runtime, flight).length <= 0) {
      cleanupPhysicalFlight(flight);
    }
  } else if (flight.materialized && !flight.encounterID) {
    cleanupPhysicalFlight(flight);
  }
  scheduleFlight(flight, nowMs);
  return true;
}

function processScheduledFlight(runtime, flight, nowMs) {
  if (flight.encounterID) {
    scheduleFlight(flight, nowMs);
    return;
  }
  if (processRoamingFlight(runtime, flight, nowMs)) {
    markFlightDirty(flight);
    return;
  }
  const route = routeDefinitionsByID.get(flight.routeID);
  if (!route) {
    flight.lastError = "ROUTE_NOT_FOUND";
    flight.nextTransitionAtMs = nowMs + 10_000;
    markFlightDirty(flight);
    scheduleFlight(flight, nowMs);
    return;
  }
  const previousPresenceKey = buildPilotPresenceProjectionKey(flight);
  try {
    if (flight.materialized || PHYSICAL_PHASES.has(flight.phase)) {
      tickPhysical(runtime, route, flight, nowMs);
    } else {
      tickVirtual(runtime, route, flight, nowMs);
    }
  } catch (error) {
    flight.lastError = error.message;
    flight.nextTransitionAtMs = nowMs + 10_000;
    markFlightDirty(flight);
    log.warn(`[LivingUniverse] Flight ${flight.flightID} tick failed: ${error.message}`);
  }
  const nextPresenceKey = buildPilotPresenceProjectionKey(flight);
  if (nextPresenceKey !== previousPresenceKey) {
    for (const actor of getFlightActors(flight)) {
      dirtyPilotActorIDs.add(actor.actorID);
    }
  }
  scheduleFlight(flight, nowMs);
}

function runScheduledFlights(runtime, nowMs, passStartedAtMs) {
  if (!schedulerInitialized || schedulerRebuildRequested) {
    rebuildFlightSchedule(nowMs, schedulerInitialized ? "requested" : "initialize");
  }
  const processedFlightIDs = new Set();
  let observedProcessed = 0;
  let dueProcessed = 0;

  for (const flightID of listObservedFlightIDs(runtime)) {
    const flight = runtimeState && runtimeState.flights[flightID];
    if (!flight) {
      removeFlightFromSchedule(flightID);
      continue;
    }
    processScheduledFlight(runtime, flight, nowMs);
    processedFlightIDs.add(flightID);
    observedProcessed += 1;
  }

  const dueLimit = getMaxDueFlightsPerTick();
  const budgetMs = getSchedulerBudgetMs();
  let replacementPriorityProcessed = 0;
  let generalProcessed = 0;
  let schedulePops = 0;
  const maximumSchedulePops = Math.max(dueLimit, dueLimit * 4);
  while (dueProcessed < dueLimit && schedulePops < maximumSchedulePops) {
    if (dueProcessed > 0 && performance.now() - passStartedAtMs >= budgetMs) {
      break;
    }
    const selection = selectDueFlightQueue(nowMs);
    if (!selection) {
      break;
    }
    const entry = selection.queue.popDue(nowMs);
    if (!entry) {
      break;
    }
    schedulePops += 1;
    if (processedFlightIDs.has(entry.key)) {
      continue;
    }
    const flight = runtimeState && runtimeState.flights[entry.key];
    if (!flight) {
      removeFlightFromSchedule(entry.key);
      continue;
    }
    const currentLane = isReplacementPriorityScheduledFlight(flight)
      ? "replacement"
      : "general";
    if (currentLane !== selection.lane) {
      scheduleFlightDeadline(flight, entry.dueAtMs);
      continue;
    }
    processScheduledFlight(runtime, flight, nowMs);
    processedFlightIDs.add(entry.key);
    dueProcessed += 1;
    if (selection.lane === "replacement") {
      replacementPriorityProcessed += 1;
    } else {
      generalProcessed += 1;
    }
  }

  const replacementDeferred = isDeadlineQueueDue(
    replacementFreightDeadlineQueue,
    nowMs,
  );
  const generalDeferred = isDeadlineQueueDue(flightDeadlineQueue, nowMs);
  if (replacementDeferred || generalDeferred) {
    schedulerMetrics.deferredDuePasses += 1;
  }
  if (replacementDeferred) {
    schedulerMetrics.replacementPriorityDeferredDuePasses += 1;
  }
  if (generalDeferred) {
    schedulerMetrics.generalDeferredDuePasses += 1;
  }
  schedulerMetrics.dueFlightsProcessed += dueProcessed;
  schedulerMetrics.replacementPriorityDueFlightsProcessed +=
    replacementPriorityProcessed;
  schedulerMetrics.generalDueFlightsProcessed += generalProcessed;
  schedulerMetrics.observedFlightsProcessed += observedProcessed;
  schedulerMetrics.lastDueFlightsProcessed = dueProcessed;
  schedulerMetrics.lastReplacementPriorityDueFlightsProcessed =
    replacementPriorityProcessed;
  schedulerMetrics.lastGeneralDueFlightsProcessed = generalProcessed;
  schedulerMetrics.lastObservedFlightsProcessed = observedProcessed;
  return {
    dueProcessed,
    replacementPriorityProcessed,
    generalProcessed,
    observedProcessed,
  };
}

function getSchedulerStatus(nowMs = Date.now()) {
  const next = getNextFlightDeadlineEntry();
  const nextGeneral = flightDeadlineQueue.peek();
  const nextReplacement = replacementFreightDeadlineQueue.peek();
  const recentPassDurationsMs = schedulerMetrics.recentPassDurationsMs.slice();
  const sortedRecentDurationsMs = recentPassDurationsMs.slice().sort((left, right) => left - right);
  const recentRoamingDispatchMs = schedulerMetrics.recentRoamingDispatchMs.slice();
  const sortedRecentRoamingDispatchMs = recentRoamingDispatchMs
    .slice()
    .sort((left, right) => left - right);
  const recentAveragePassDurationMs = recentPassDurationsMs.length > 0
    ? recentPassDurationsMs.reduce((sum, durationMs) => sum + durationMs, 0) /
      recentPassDurationsMs.length
    : 0;
  const recentP95Index = Math.max(
    0,
    Math.ceil(sortedRecentDurationsMs.length * 0.95) - 1,
  );
  const {
    recentPassDurationsMs: _recentPassDurationsMs,
    recentRoamingDispatchMs: _recentRoamingDispatchMs,
    ...publicMetrics
  } = schedulerMetrics;
  return {
    queueSize: flightDeadlineQueue.size + replacementFreightDeadlineQueue.size,
    generalQueueSize: flightDeadlineQueue.size,
    replacementPriorityQueueSize: replacementFreightDeadlineQueue.size,
    indexedFlights: indexedSystemByFlightID.size,
    indexedSystems: flightIDsBySystem.size,
    dirtyPilotRecords: dirtyPilotActorIDs.size,
    nextFlightDueInMs: next ? Math.max(0, next.dueAtMs - nowMs) : null,
    oldestDueFlightOverdueMs: next
      ? Math.max(0, nowMs - next.dueAtMs)
      : 0,
    nextGeneralFlightDueInMs: nextGeneral
      ? Math.max(0, nextGeneral.dueAtMs - nowMs)
      : null,
    generalOldestOverdueMs: nextGeneral
      ? Math.max(0, nowMs - nextGeneral.dueAtMs)
      : 0,
    nextReplacementPriorityDueInMs: nextReplacement
      ? Math.max(0, nextReplacement.dueAtMs - nowMs)
      : null,
    replacementPriorityOldestOverdueMs: nextReplacement
      ? Math.max(0, nowMs - nextReplacement.dueAtMs)
      : 0,
    nextEconomyWakeInMs: Number.isFinite(nextEconomyWakeAtMs)
      ? Math.max(0, nextEconomyWakeAtMs - nowMs)
      : null,
    budgetMs: getSchedulerBudgetMs(),
    maxDueFlightsPerTick: getMaxDueFlightsPerTick(),
    replacementPrioritySharePercent: getReplacementSchedulerSharePercent(),
    pilotSyncBatchSize: getPilotSyncBatchSize(),
    metrics: {
      ...publicMetrics,
      averagePassDurationMs: schedulerMetrics.passes > 0
        ? schedulerMetrics.totalPassDurationMs / schedulerMetrics.passes
        : 0,
      recentSampleCount: recentPassDurationsMs.length,
      recentAveragePassDurationMs,
      recentP95PassDurationMs: sortedRecentDurationsMs[recentP95Index] || 0,
      recentMaxPassDurationMs: sortedRecentDurationsMs.length > 0
        ? sortedRecentDurationsMs[sortedRecentDurationsMs.length - 1]
        : 0,
      roamingBudgetMs: getRoamingWorkBudgetMs(),
      roamingRecentSampleCount: recentRoamingDispatchMs.length,
      roamingRecentAverageDispatchMs: recentRoamingDispatchMs.length > 0
        ? recentRoamingDispatchMs.reduce((sum, durationMs) => sum + durationMs, 0) /
          recentRoamingDispatchMs.length
        : 0,
      roamingRecentP95DispatchMs: sortedRecentRoamingDispatchMs[
        Math.max(0, Math.ceil(sortedRecentRoamingDispatchMs.length * 0.95) - 1)
      ] || 0,
      roamingRecentMaxDispatchMs: sortedRecentRoamingDispatchMs.length > 0
        ? sortedRecentRoamingDispatchMs[sortedRecentRoamingDispatchMs.length - 1]
        : 0,
    },
  };
}

// Resident track R1: living-flight controllers spawn dormant (nativeAmbient), which every
// behavior tick path skips outright — so shoot-on-sight needs an explicit promotion when a
// hostile player is actually present, and a demotion back to zero-cost dormancy when none
// remains. This sync runs throttled off the living tick and complements the immediate
// retaliation promotion in npcService.noteNpcIncomingAggression: proactive engagement (a
// below-floor or timer-hostile resident warping onto a camp) comes from here; return fire
// comes from the aggression hook. Conflict-encounter flights are excluded — their combat
// wiring belongs to configureConflictCombat.
const HOSTILITY_POSTURE_SYNC_INTERVAL_MS = 5_000;
let nextHostilityPostureSyncAtMs = 0;

// Escort/police actors are a non-pirate flight's stated defense: they are advertised to the
// client as shoot-on-sight (hostileResponseThreshold), so they must actually be armed when the
// hostility machinery promotes them. Their spawn overrides are fully passive (weapons disabled),
// which promotion alone cannot fix — runtimeKind only makes the controller THINK; the armed
// overrides make it fire. Mirror set lives in npcService.promoteLivingFlightRetaliation.
const LIVING_ARMED_RESPONDER_ROLES = new Set(["escort", "police"]);

const LIVING_ARMED_RESPONDER_OVERRIDES = Object.freeze({
  autoAggro: true,
  autoActivateWeapons: true,
  autoAggroTargetClasses: ["player"],
  targetPreference: "nearestPlayer",
  movementMode: "orbit",
  orbitDistanceMeters: 9_000,
  followRangeMeters: 6_000,
  aggressionRangeMeters: 150_000,
  returnToHomeWhenIdle: false,
});

// Matches the passive non-pirate spawn posture in spawnAtAnchor, restored on demotion.
const LIVING_PASSIVE_RESPONDER_OVERRIDES = Object.freeze({
  autoAggro: false,
  autoActivateWeapons: false,
  targetPreference: "none",
  returnToHomeWhenIdle: false,
  idleAnchorOrbit: false,
});

function isLivingArmedResponderEntity(entity) {
  return Boolean(entity && LIVING_ARMED_RESPONDER_ROLES.has(String(entity.npcRole || "")));
}

// NPC weapon effects are cycled by the scene effect loop, not by controller thinks, and the only
// code that deactivates them lives inside the behavior tick — which skips nativeAmbient
// controllers outright. Demoting a controller whose entity still has hot combat state would
// leave weapons firing forever with nobody to turn them off, so demotion defers until the
// still-ticking nativeCombat controller has wound its combat down (target loss triggers
// clearNpcCombatState within a think or two once the admission check rejects the ex-hostile).
function entityHasHotCombatState(scene, entity) {
  if (!entity) {
    return false;
  }
  if (entity.activeModuleEffects instanceof Map && entity.activeModuleEffects.size > 0) {
    return true;
  }
  if (entity.lockedTargets instanceof Map && entity.lockedTargets.size > 0) {
    return true;
  }
  if (scene && typeof scene.getSortedPendingTargetLocks === "function") {
    try {
      if (scene.getSortedPendingTargetLocks(entity).length > 0) {
        return true;
      }
    } catch (error) {
      /* pending-lock introspection is best-effort */
    }
  }
  return false;
}

function getFlightHostileFactionID(flight) {
  const actor = getFlightActors(flight)[0];
  return toPositiveInt(
    actor && actor.pilot && actor.pilot.factionID,
    toPositiveInt(actor && actor.factionID, 0),
  );
}

function isAnySessionHostileToFaction(scene, factionID, nowMs) {
  const sessions = scene && scene.sessions instanceof Map ? scene.sessions : null;
  if (!sessions || sessions.size <= 0 || !factionID) {
    return false;
  }
  for (const session of sessions.values()) {
    const characterID = toPositiveInt(session && session.characterID, 0);
    if (characterID && factionHostilityRuntime.isHostile(characterID, factionID, nowMs)) {
      return true;
    }
  }
  return false;
}

function syncHostilityPostures(runtime, nowMs) {
  if (!factionHostilityRuntime.isEnabled()) return;
  if (nowMs < nextHostilityPostureSyncAtMs) return;
  nextHostilityPostureSyncAtMs = nowMs + HOSTILITY_POSTURE_SYNC_INTERVAL_MS;
  if (!runtimeState || !runtime || !(runtime.scenes instanceof Map)) return;
  for (const flight of Object.values(runtimeState.flights || {})) {
    if (!flight || flight.materialized !== true || flight.encounterID) continue;
    const scene = runtime.scenes.get(toPositiveInt(flight.currentSystemID, 0)) || null;
    const isPirate = flight.family === "pirate";
    const anyHostile = isAnySessionHostileToFaction(
      scene,
      getFlightHostileFactionID(flight),
      nowMs,
    );
    for (const entityID of flight.entityIDs || []) {
      const normalizedEntityID = toPositiveInt(entityID, 0);
      const controller = getNpcService().getControllerByEntityID(normalizedEntityID);
      if (!controller) continue;
      const entity = scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(normalizedEntityID)
        : null;
      const armedResponder = !isPirate && isLivingArmedResponderEntity(entity);
      const runtimeKind = String(controller.runtimeKind || "").trim();
      if (anyHostile && (isPirate || armedResponder) && runtimeKind === "nativeAmbient") {
        // Proactive shoot-on-sight: a hostile resident is in the scene — wake the camp (whole
        // pirate flights) or the flight's armed escorts/police. The livingHostilityPromoted
        // flag records that WE promoted this controller, so only our promotions are ever
        // demoted. Non-pirate armed responders also need their weapons enabled: their spawn
        // posture is fully passive.
        if (armedResponder) {
          getNpcService().setBehaviorOverrides(
            normalizedEntityID,
            { ...LIVING_ARMED_RESPONDER_OVERRIDES },
          );
        }
        controller.runtimeKind = "nativeCombat";
        controller.livingHostilityPromoted = true;
        controller.nextThinkAtMs = 0;
      } else if (
        !anyHostile &&
        controller.livingHostilityPromoted === true &&
        runtimeKind === "nativeCombat"
      ) {
        if (controller.manualOrder) {
          // A GM manual order took over this controller: explicit operator control always
          // supersedes the hostility machinery. Drop our claim so it is never demoted.
          controller.livingHostilityPromoted = false;
          continue;
        }
        if (entityHasHotCombatState(scene, entity)) {
          // Weapons/locks still hot: keep it nativeCombat so the behavior tick can wind the
          // combat down (nativeAmbient controllers are never ticked and would fire forever).
          continue;
        }
        // No hostile player remains (left the scene or the timer expired): return to the
        // zero-cost dormant posture and drop any leftover player target.
        if (armedResponder) {
          getNpcService().setBehaviorOverrides(
            normalizedEntityID,
            { ...LIVING_PASSIVE_RESPONDER_OVERRIDES },
          );
        }
        controller.runtimeKind = "nativeAmbient";
        controller.livingHostilityPromoted = false;
        controller.preferredTargetID = 0;
        controller.currentTargetID = 0;
      }
    }
  }
}

function cleanupDisabled(nowMs) {
  if (disabledCleanupComplete) {
    return;
  }
  disabledCleanupComplete = true;
  if (runtimeState) {
    cleanupAllConflictDistressBeacons(nowMs);
    for (const flight of Object.values(runtimeState.flights || {})) {
      if (flight.materialized) {
        cleanupPhysicalFlight(flight);
      }
    }
    persistState(nowMs, true);
  }
  syncPilotPresence({ clear: true });
  flightDeadlineQueue.clear();
  replacementFreightDeadlineQueue.clear();
  flightIDsBySystem.clear();
  indexedSystemByFlightID.clear();
  schedulerInitialized = false;
  schedulerRebuildRequested = false;
  resetReplacementSchedulerFairness();
  nextEconomyWakeAtMs = 0;
  cleanupStaleOperatorControllers();
  npcPhysicalBudget.releaseOwner(OPERATOR_KIND);
}

function tick(runtime, nowMs = Date.now()) {
  const now = toFiniteNumber(nowMs, Date.now());
  if (config.livingUniverseEnabled !== true) {
    cleanupDisabled(now);
    return;
  }
  disabledCleanupComplete = false;
  if (now - lastTickAtMs < TICK_INTERVAL_MS) {
    return;
  }
  lastTickAtMs = now;
  const passStartedAtMs = performance.now();
  materializationsThisTick = 0;
  initialize(now);
  const economyStartedAtMs = performance.now();
  if (now >= nextEconomyWakeAtMs) {
    livingEconomyRuntime.tick(runtimeState, now, {
      markLivingStateDirty(changedFlight = null) {
        const changedFlights = changedFlight && typeof changedFlight[Symbol.iterator] === "function" &&
          typeof changedFlight !== "string"
          ? [...changedFlight]
          : [changedFlight];
        let classified = false;
        for (const flight of changedFlights.filter(Boolean)) {
          markFlightDirty(flight);
          rescheduleChangedFlight(flight, now);
          classified = true;
        }
        if (!classified) {
          // A no-ID callback is safe but deliberately expensive: the next
          // checkpoint performs a complete V2 replacement instead of risking
          // a missed nested flight mutation.
          markFullRewrite();
        }
      },
      assignFreightRoute,
      salvageRecoveryAdapters: {
        observeRecovery: (site, job, atMs) => observeSalvageRecovery(runtime, site, job, atMs),
        claimSite: (site, job, atMs) => claimSalvageSite(site, job, atMs),
      },
    });
    nextEconomyWakeAtMs = livingEconomyRuntime.getNextWakeAtMs(now);
    schedulerMetrics.economyWakeups += 1;
  }
  schedulerMetrics.lastEconomyDispatchMs = Math.max(
    0,
    performance.now() - economyStartedAtMs,
  );
  const eventProductionPaused = livingEconomyRuntime.isEventProductionPaused(now);
  if (!eventProductionPaused) tickLivingConflict(runtime, now);
  const flightWorkStartedAtMs = performance.now();
  if (!eventProductionPaused) {
    runScheduledFlights(runtime, now, passStartedAtMs);
  } else {
    schedulerMetrics.eventBackpressurePasses += 1;
  }
  schedulerMetrics.lastFlightWorkMs = Math.max(
    0,
    performance.now() - flightWorkStartedAtMs,
  );
  syncHostilityPostures(runtime, now);
  const pilotSyncStartedAtMs = performance.now();
  syncPilotPresence();
  schedulerMetrics.lastPilotSyncMs = Math.max(
    0,
    performance.now() - pilotSyncStartedAtMs,
  );
  const persistenceStartedAtMs = performance.now();
  persistState(now);
  schedulerMetrics.lastPersistenceMs = Math.max(
    0,
    performance.now() - persistenceStartedAtMs,
  );
  const passDurationMs = Math.max(0, performance.now() - passStartedAtMs);
  schedulerMetrics.passes += 1;
  schedulerMetrics.totalPassDurationMs += passDurationMs;
  schedulerMetrics.lastPassDurationMs = passDurationMs;
  schedulerMetrics.maxPassDurationMs = Math.max(
    schedulerMetrics.maxPassDurationMs,
    passDurationMs,
  );
  schedulerMetrics.recentPassDurationsMs.push(passDurationMs);
  if (schedulerMetrics.recentPassDurationsMs.length > 120) {
    schedulerMetrics.recentPassDurationsMs.shift();
  }
}

function getReplacementCoverageStatus(nowMs = Date.now()) {
  const actors = runtimeState && runtimeState.actors || {};
  const actorCount = Object.keys(actors).length;
  if (
    !replacementCoverageCache.value ||
    replacementCoverageCache.actorCount !== actorCount ||
    nowMs - replacementCoverageCache.capturedAtMs >= 60_000
  ) {
    const startedAtMs = performance.now();
    replacementCoverageCache = {
      actorCount,
      capturedAtMs: nowMs,
      auditDurationMs: Math.max(0, performance.now() - startedAtMs),
      value: livingEconomyRuntime.auditReplacementCoverage(actors),
    };
    replacementCoverageCache.auditDurationMs = Math.max(
      0,
      performance.now() - startedAtMs,
    );
  }
  return {
    ...replacementCoverageCache.value,
    capturedAtMs: replacementCoverageCache.capturedAtMs,
    ageMs: Math.max(0, nowMs - replacementCoverageCache.capturedAtMs),
    auditDurationMs: replacementCoverageCache.auditDurationMs,
  };
}

function getStatus(nowMs = Date.now()) {
  if (!runtimeState) {
    const persisted = livingStateStore.readState();
    runtimeState = persisted.populationSize > 0 ? persisted : null;
  }
  const physical = countMaterialized();
  const physicalBudget = npcPhysicalBudget.getStatus();
  let actorCount = 0;
  const roles = {};
  const factions = {};
  const corporations = {};
  const homeStations = {};
  const systems = {};
  const pilotPresence = {};
  const capableWorkforce = {};
  for (const actorID in runtimeState && runtimeState.actors || {}) {
    const actor = runtimeState.actors[actorID];
    actorCount += 1;
    const role = String(actor && actor.role || "unknown");
    const faction = String(actor && actor.factionName || "unknown");
    const corporation = String(actor && actor.corporationName || "unknown");
    const homeStation = String(actor && actor.homeStationID || "unknown");
    const system = String(actor && actor.currentSystemID || "unknown");
    roles[role] = (roles[role] || 0) + 1;
    factions[faction] = (factions[faction] || 0) + 1;
    corporations[corporation] = (corporations[corporation] || 0) + 1;
    homeStations[homeStation] = (homeStations[homeStation] || 0) + 1;
    systems[system] = (systems[system] || 0) + 1;
    const presence = resolveActorPresence(actor);
    pilotPresence[presence.state] = (pilotPresence[presence.state] || 0) + 1;
    for (const capability of Array.isArray(actor && actor.capabilities)
      ? actor.capabilities
      : buildActorCapabilities(actor && actor.role)) {
      capableWorkforce[capability] = (capableWorkforce[capability] || 0) + 1;
    }
  }
  let flightCount = 0;
  let replacementHoldFlights = 0;
  let nextTransitionAtMs = Number.POSITIVE_INFINITY;
  const phases = {};
  const campaignCounts = new Map();
  for (const flightID in runtimeState && runtimeState.flights || {}) {
    const flight = runtimeState.flights[flightID];
    flightCount += 1;
    const phase = String(flight && flight.phase || "unknown");
    phases[phase] = (phases[phase] || 0) + 1;
    if (livingEconomyRuntime.shouldHoldReplacementFlight(flight)) {
      replacementHoldFlights += 1;
    }
    nextTransitionAtMs = Math.min(
      nextTransitionAtMs,
      toFiniteNumber(flight && flight.nextTransitionAtMs, nowMs),
    );
    if (flight && flight.campaignID) {
      const campaignID = String(flight.campaignID);
      const counts = campaignCounts.get(campaignID) || { flights: 0, actors: 0 };
      counts.flights += 1;
      counts.actors += Array.isArray(flight.actorIDs) ? flight.actorIDs.length : 0;
      campaignCounts.set(campaignID, counts);
    }
  }
  const conflictStatus = livingConflictRuntime.getStatus(runtimeState, nowMs);
  conflictStatus.roaming = runtimeState && runtimeState.roamingConflict
    ? {
        ...livingRoamingKernel.getStatus(runtimeState.roamingConflict, nowMs),
        enabled: isRoamingConflictEnabled(),
        groupLimit: getRoamingGroupLimit(),
        campLimit: getRoamingCampLimit(),
        workBudgetMs: getRoamingWorkBudgetMs(),
        pendingContacts: Array.isArray(runtimeState.pendingRoamingContacts)
          ? runtimeState.pendingRoamingContacts.length
          : 0,
      }
    : {
        enabled: false,
        groups: 0,
        activeCamps: 0,
        nextDeadlineInMs: 0,
        workBudgetMs: getRoamingWorkBudgetMs(),
        pendingContacts: 0,
      };
  return {
    enabled: config.livingUniverseEnabled === true,
    populationTarget: getPopulationTarget(),
    actorCount,
    flightCount,
    materializedShips: physical.global,
    materializedSystems: Object.fromEntries(physical.perSystem),
    physicalBudget,
    roles,
    factions,
    corporations,
    homeStations,
    phases,
    systems,
    pilotPresence,
    localPilotCount: (pilotPresence.in_space_materialized || 0) +
      (pilotPresence.in_space_virtual || 0),
    availablePilots: pilotPresence.docked_offline || 0,
    capableWorkforce,
    replacementHolds: {
      activeFlights: replacementHoldFlights,
    },
    replacementCoverage: getReplacementCoverageStatus(nowMs),
    campaigns: livingConflictCampaignCatalog.CAMPAIGNS.map((campaign) => {
      const counts = campaignCounts.get(campaign.campaignID) || { flights: 0, actors: 0 };
      return {
        campaignID: campaign.campaignID,
        name: campaign.name,
        theater: campaign.theater,
        intensity: campaign.intensity,
        flightCount: counts.flights,
        actorCount: counts.actors,
      };
    }),
    metrics: runtimeState ? { ...runtimeState.metrics } : {},
    hostility: {
      enabled: factionHostilityRuntime.isEnabled(),
      windowMinutes: factionHostilityRuntime.getHostilityWindowMs() / 60_000,
      standingFloor: factionHostilityRuntime.getStandingFloor(),
      ...factionHostilityRuntime.getMetrics(),
    },
    killCredit: livingKillCreditLedger.getMetrics(),
    offGridAcceleration: {
      travelTimeMultiplier: Math.max(
        1,
        Math.min(100, toFiniteNumber(config.livingUniverseOffGridTravelTimeMultiplier, 1)),
      ),
      activityTimeMultiplier: getOffGridActivityTimeMultiplier(),
    },
    scheduler: getSchedulerStatus(nowMs),
    persistenceIntervalMs: getPersistenceIntervalMs(),
    persistence: {
      ...persistenceMetrics,
      pending: {
        actorRows: persistenceDirtyActorIDs.size,
        flightRows: persistenceDirtyFlightIDs.size,
        encounterRows: persistenceDirtyEncounterIDs.size,
        encounterDeletes: persistenceRemovedEncounterIDs.size,
        metaDirty: persistenceMetaDirty,
        roamingDirty: persistenceRoamingDirty,
        encounterReconcileRequired: persistenceEncounterReconcileRequired,
        fullRewriteRequired: persistenceFullRewriteRequired,
      },
      store: typeof livingStateStore.getPersistenceStatus === "function"
        ? livingStateStore.getPersistenceStatus()
        : null,
    },
    nextTransitionInSeconds: flightCount > 0
      ? Math.max(0, Math.ceil((nextTransitionAtMs - nowMs) / 1_000))
      : 0,
    economy: livingEconomyRuntime.getStatus(),
    conflict: conflictStatus,
  };
}

function formatStatus(nowMs = Date.now()) {
  const status = getStatus(nowMs);
  const roles = Object.entries(status.roles)
    .sort((left, right) => right[1] - left[1])
    .map(([role, count]) => `${role} ${count}`)
    .join(", ");
  const activeSystems = Object.entries(status.materializedSystems)
    .map(([systemID, count]) => {
      const system = worldData.getSolarSystemByID(Number(systemID));
      return `${system ? system.solarSystemName : systemID} ${count}`;
    })
    .join(", ");
  const affiliations = Object.entries(status.factions)
    .sort((left, right) => right[1] - left[1])
    .map(([faction, count]) => `${faction} ${count}`)
    .join(", ");
  return [
    `Living universe is ${status.enabled ? "enabled" : "disabled"}: ${status.actorCount}/${status.populationTarget} persistent actors in ${status.flightCount} flights.`,
    `Roles: ${roles || "none"}.`,
    `Origins: ${Object.keys(status.homeStations).length} home stations; affiliations ${affiliations || "none"}.`,
    `Living-universe physical now: ${status.materializedShips} ships${activeSystems ? ` (${activeSystems})` : ""}; shared NPC budget ${status.physicalBudget.reservedShips}/${status.physicalBudget.limits.global}.`,
    `Deadline scheduler ${status.scheduler.queueSize} queued flights, last pass ${status.scheduler.metrics.lastPassDurationMs.toFixed(2)} ms, average ${status.scheduler.metrics.averagePassDurationMs.toFixed(2)} ms.`,
    `Trips ${status.metrics.completedTrips || 0}, physical jumps ${status.metrics.physicalGateJumps || 0}, losses ${status.metrics.shipLosses || 0}, materializations ${status.metrics.materializations || 0}.`,
    `Conflicts ${status.conflict.active} active, ${status.conflict.metrics.encountersResolved || 0} resolved (${status.conflict.metrics.encountersObserved || 0} witnessed), ${status.conflict.pendingEvidence} unresolved wreck-evidence site(s); roaming ${status.conflict.roaming.groups || 0} groups with ${status.conflict.roaming.activeCamps || 0} active camps.`,
    `Economy jobs ${status.economy.activeJobs || 0}, delivered ${status.economy.metrics.jobsDelivered || 0}, freight units moved ${(status.economy.metrics.unitsDelivered || 0).toLocaleString("en-US")}.`,
  ].join(" ");
}

function formatConflicts(nowMs = Date.now()) {
  const status = getStatus(nowMs).conflict;
  const active = status.activeEncounters.map((encounter) => {
    const system = worldData.getSolarSystemByID(encounter.targetSystemID);
    const response = encounter.response
      ? `, ${encounter.response.providerName || "security"} ${encounter.response.status}`
      : "";
    const distress = encounter.distressBeaconActive ? ", distress signal warpable" : "";
    const battleClass = String(encounter.battleClass || "skirmish");
    const shipCount = toPositiveInt(encounter.plannedShipCount, getConflictActorIDs(encounter).length);
    return `${encounter.encounterID} ${encounter.phase} in ${system ? system.solarSystemName : encounter.targetSystemID}, ${battleClass} ${shipCount}-ship ${encounter.kind}, ends in ${Math.max(0, Math.ceil((encounter.endsAtMs - nowMs) / 1_000))}s${encounter.observed ? ", witnessed" : ""}${distress}${response}`;
  });
  return [
    `Living conflict is ${status.enabled ? "enabled" : "disabled"}: ${status.active} active encounter(s), ${status.metrics.encountersResolved || 0} resolved, ${status.metrics.encountersObserved || 0} witnessed, ${status.metrics.encountersResolvedOffGrid || 0} resolved off-grid.`,
    `Roaming operations ${status.roaming.groups || 0}, temporary camps ${status.roaming.activeCamps || 0}, next operation deadline in about ${Math.ceil((status.roaming.nextDeadlineInMs || 0) / 1_000)}s; recent scheduler p95 ${(getSchedulerStatus(nowMs).metrics.roamingRecentP95DispatchMs || 0).toFixed(2)} ms against a ${status.roaming.workBudgetMs || getRoamingWorkBudgetMs()} ms budget.`,
    `Distress signals ${status.metrics.distressSignalsActivated || 0}; responses ${status.metrics.responsesDispatched || 0} dispatched, ${status.metrics.responsesArrived || 0} arrived, ${status.metrics.responsesUnavailable || 0} unavailable.`,
    `${status.metrics.wreckEvidenceMaterialized || 0} delayed wreck(s) materialized; ${status.pendingEvidence} evidence site(s) still waiting for a visitor.`,
    active.length > 0
      ? active.join("; ")
      : status.roaming.enabled
        ? "No route contact is active at this instant."
        : `Next encounter scheduling window in about ${status.nextEncounterInSeconds}s.`,
  ].join(" ");
}

function warpToActiveDistress(session, nowMs = Date.now()) {
  const systemID = toPositiveInt(
    session && (session.solarsystemid2 || session.solarsystemid),
    0,
  );
  if (!systemID || !runtimeState) {
    return { success: false, errorMsg: "NOT_IN_SPACE" };
  }
  const encounters = Object.values(runtimeState.encounters || {})
    .filter((encounter) => (
      encounter &&
      encounter.phase === livingConflictRuntime.PHASE.ACTIVE &&
      toPositiveInt(encounter.targetSystemID, 0) === systemID &&
      encounter.distressActivatedAtMs
    ))
    .sort((left, right) => (
      Number(right.materialized === true) - Number(left.materialized === true) ||
      toFiniteNumber(right.distressActivatedAtMs, 0) - toFiniteNumber(left.distressActivatedAtMs, 0)
    ));
  const encounter = encounters[0] || null;
  if (!encounter) {
    return { success: false, errorMsg: "NO_ACTIVE_DISTRESS_SIGNAL" };
  }
  const spaceRuntime = getSpaceRuntime();
  const scene = spaceRuntime.getSceneForSession(session);
  if (!scene) return { success: false, errorMsg: "NOT_IN_SPACE" };
  const beaconID = toPositiveInt(encounter.distressBeaconID, 0);
  const beacon = beaconID > 0 ? scene.getEntityByID(beaconID) : null;
  const result = beacon
    ? spaceRuntime.warpToEntity(session, beaconID, { minimumRange: 5_000 })
    : encounter.distressPosition
      ? spaceRuntime.warpToPoint(session, encounter.distressPosition, { minimumRange: 5_000 })
      : { success: false, errorMsg: "DISTRESS_POSITION_NOT_FOUND" };
  if (!result || result.success !== true) {
    return {
      success: false,
      errorMsg: result && result.errorMsg || "DISTRESS_WARP_FAILED",
      encounterID: encounter.encounterID,
    };
  }
  return {
    success: true,
    encounterID: encounter.encounterID,
    beaconID: beaconID || null,
    systemID,
    requestedAtMs: nowMs,
  };
}

function startBattleForSession(session, nowMs = Date.now()) {
  const now = toFiniteNumber(nowMs, Date.now());
  initialize(now);
  const systemID = toPositiveInt(
    session && (
      session.solarsystemid2 ||
      session.solarsystemid ||
      session._space && session._space.systemID
    ),
    0,
  );
  if (!systemID) return { success: false, errorMsg: "NOT_IN_SPACE" };
  const existing = Object.values(runtimeState.encounters || {}).find((encounter) => (
    encounter &&
    encounter.phase !== livingConflictRuntime.PHASE.RESOLVED &&
    toPositiveInt(encounter.targetSystemID, 0) === systemID
  ));
  if (existing) {
    return {
      success: true,
      alreadyActive: true,
      encounterID: existing.encounterID,
      systemID,
      battleClass: existing.battleClass || "skirmish",
      plannedShipCount: toPositiveInt(existing.plannedShipCount, getConflictActorIDs(existing).length),
      startsInSeconds: Math.max(0, Math.ceil((existing.startsAtMs - now) / 1_000)),
    };
  }
  const encounter = livingConflictRuntime.forceEncounter(runtimeState, now, systemID, {
    isFlightEligible: isConflictFlightEligible,
    getSecurity(targetSystemID) {
      const system = worldData.getSolarSystemByID(targetSystemID);
      return toFiniteNumber(system && system.security, 1);
    },
    estimateTravelMs: estimateConflictTravelMs,
  }, {
    forceMajor: true,
    combatDefendersOnly: true,
    wingFlightCount: 3,
    stagingDelayMs: 15_000,
  });
  if (!encounter) return { success: false, errorMsg: "NO_BATTLE_FLEETS_AVAILABLE" };
  markEncounterDirty(encounter);
  markMetaDirty();
  for (const flightID of collectConflictFlightIDs()) {
    const flight = runtimeState.flights[flightID];
    if (flight) markFlightDirty(flight);
  }
  schedulerRebuildRequested = true;
  rebuildFlightSchedule(now, "operator_battle");
  syncPilotPresence();
  persistState(now, true);
  return {
    success: true,
    alreadyActive: false,
    encounterID: encounter.encounterID,
    systemID,
    battleClass: encounter.battleClass,
    plannedShipCount: encounter.plannedShipCount,
    attackerShipCount: encounter.attackerActorIDs.length,
    defenderShipCount: encounter.defenderActorIDs.length,
    startsInSeconds: Math.max(0, Math.ceil((encounter.startsAtMs - now) / 1_000)),
  };
}

function departNow(nowMs = Date.now()) {
  const now = toFiniteNumber(nowMs, Date.now());
  initialize(now);
  for (const flight of Object.values(runtimeState.flights || {})) {
    if (!flight.materialized && flight.phase === PHASE.DOCKED) {
      flight.nextTransitionAtMs = now;
      markFlightDirty(flight);
    }
  }
  rebuildFlightSchedule(now, "depart_now");
  persistState(now, true);
  return getStatus(now);
}

function reset(nowMs = Date.now()) {
  const now = toFiniteNumber(nowMs, Date.now());
  initialize(now);
  // The economy owns the source journal for X-Eve. Drain and checkpoint it
  // before changing any universe state so a failed durability boundary leaves
  // both domains untouched and the reset can be retried safely.
  const economyReset = livingEconomyRuntime.prepareReset(now);
  const previousUniverseState = JSON.parse(JSON.stringify(runtimeState));
  const previousRuntimeState = runtimeState;
  const nextUniverseState = buildPopulationPlan(getPopulationTarget(), now);
  const economyStage = livingEconomyRuntime.stagePreparedReset(economyReset.token);
  let universeStage = null;
  let flushResult = economyStage;
  if (economyStage && economyStage.success === true) {
    try {
      universeStage = livingStateStore.writeState(nextUniverseState, {
        fullRewrite: true,
        metaDirty: true,
        roamingDirty: true,
        reconcileEncounterRows: true,
      });
      flushResult = universeStage && universeStage.success === true
        ? livingStateStore.flushDurably()
        : {
          success: false,
          errorMsg: universeStage && universeStage.errorMsg ||
            "LIVING_UNIVERSE_RESET_STAGE_FAILED",
        };
    } catch (error) {
      flushResult = {
        success: false,
        errorMsg: error && (error.code || error.message) ||
          "LIVING_UNIVERSE_RESET_PERSIST_THROWN",
      };
    }
  }
  if (!flushResult || flushResult.success !== true) {
    const economyRollback = livingEconomyRuntime.rollbackPreparedReset(
      economyReset.token,
      { finalize: false },
    );
    let universeRollback = null;
    let rollbackFlush = null;
    try {
      universeRollback = livingStateStore.writeState(previousUniverseState, {
        fullRewrite: true,
        metaDirty: true,
        roamingDirty: true,
        reconcileEncounterRows: true,
      });
      rollbackFlush = (
        economyRollback && economyRollback.success === true &&
        universeRollback && universeRollback.success === true
      )
        ? livingStateStore.flushDurably()
        : { success: false, errorMsg: "LIVING_UNIVERSE_RESET_ROLLBACK_STAGE_FAILED" };
    } catch (error) {
      rollbackFlush = {
        success: false,
        errorMsg: error && (error.code || error.message) ||
        "LIVING_UNIVERSE_RESET_ROLLBACK_THROWN",
      };
    }
    if (rollbackFlush && rollbackFlush.success === true) {
      const rollbackFinalize = livingEconomyRuntime.finalizePreparedResetRollback(
        economyReset.token,
      );
      if (!rollbackFinalize || rollbackFinalize.success !== true) {
        rollbackFlush = rollbackFinalize || {
          success: false,
          errorMsg: "LIVING_ECONOMY_RESET_ROLLBACK_FINALIZE_FAILED",
        };
      }
    }
    if (!rollbackFlush || rollbackFlush.success !== true) {
      livingStateStore.suspendPersistence(
        rollbackFlush && rollbackFlush.errorMsg ||
          "LIVING_UNIVERSE_RESET_ROLLBACK_FAILED",
      );
      log.warn(
        `[LivingUniverse] Reset rollback failed: ` +
        `${rollbackFlush && rollbackFlush.errorMsg || "UNKNOWN"}`,
      );
    }
    const reason = flushResult && flushResult.errorMsg ||
      "LIVING_UNIVERSE_RESET_PERSIST_FAILED";
    if (config.xEveEnabled === true) {
      require("../../../services/xEve/xEveEventBridge")
        .reportLivingEconomyDurabilityFailure(reason, {
          nowMs: now,
          bufferedEvents: 0,
          countRejected: false,
        });
    }
    const error = new Error(reason);
    error.code = reason;
    throw error;
  }

  const economyCommit = livingEconomyRuntime.commitPreparedReset(economyReset.token);
  if (!economyCommit || economyCommit.success !== true) {
    const error = new Error(
      economyCommit && economyCommit.errorMsg || "LIVING_ECONOMY_RESET_COMMIT_FAILED",
    );
    error.code = economyCommit && economyCommit.errorMsg ||
      "LIVING_ECONOMY_RESET_COMMIT_FAILED";
    throw error;
  }

  // Persistence now contains both new roots in one table transaction. Physical
  // cleanup is best-effort and cannot roll the durable reset back.
  try {
    if (previousRuntimeState) {
      cleanupAllConflictDistressBeacons(now);
      for (const flight of Object.values(previousRuntimeState.flights || {})) {
        cleanupPhysicalFlight(flight);
      }
    }
    cleanupStaleOperatorControllers();
    npcPhysicalBudget.releaseOwner(OPERATOR_KIND);
  } catch (error) {
    log.warn(`[LivingUniverse] Post-reset physical cleanup failed: ${error.message}`);
  }
  runtimeState = nextUniverseState;
  initialized = true;
  dirty = false;
  clearPersistenceDirtyState();
  lastPersistAtMs = now;
  schedulerMetrics = createSchedulerMetrics();
  resetReplacementSchedulerFairness();
  nextEconomyWakeAtMs = 0;
  try {
    rebuildFlightSchedule(now, "reset");
    syncPilotPresence({ full: true });
  } catch (error) {
    log.warn(`[LivingUniverse] Post-reset runtime indexing failed: ${error.message}`);
  }
  return getStatus(now);
}

function resizePopulation(targetCount, nowMs = Date.now()) {
  const now = toFiniteNumber(nowMs, Date.now());
  sessionPopulationTarget = Math.max(1, Math.min(5_000, toPositiveInt(targetCount, 400)));
  if (runtimeState) {
    cleanupAllConflictDistressBeacons(now);
    for (const flight of Object.values(runtimeState.flights || {})) {
      cleanupPhysicalFlight(flight);
    }
  }
  cleanupStaleOperatorControllers();
  npcPhysicalBudget.releaseOwner(OPERATOR_KIND);
  runtimeState = buildPopulationPlan(sessionPopulationTarget, now);
  initialized = true;
  markFullRewrite();
  schedulerMetrics = createSchedulerMetrics();
  resetReplacementSchedulerFairness();
  nextEconomyWakeAtMs = 0;
  rebuildFlightSchedule(now, "resize");
  syncPilotPresence({ full: true });
  persistState(now, true);
  return getStatus(now);
}

function setRuntimeStateForTest(state, nowMs = Date.now()) {
  npcPhysicalBudget.releaseOwner(OPERATOR_KIND);
  runtimeState = state;
  initialized = true;
  lastTickAtMs = 0;
  lastPersistAtMs = 0;
  dirty = false;
  clearPersistenceDirtyState();
  persistenceMetrics = {
    checkpoints: 0,
    fullRewrites: 0,
    fallbackFullRewrites: 0,
    lastCheckpointAtMs: 0,
    lastStageDurationMs: 0,
    lastBatch: null,
  };
  materializationsThisTick = 0;
  schedulerMetrics = createSchedulerMetrics();
  resetReplacementSchedulerFairness();
  replacementCoverageCache = {
    actorCount: -1,
    capturedAtMs: 0,
    auditDurationMs: 0,
    value: null,
  };
  schedulerInitialized = false;
  schedulerRebuildRequested = false;
  nextEconomyWakeAtMs = 0;
  dirtyPilotActorIDs.clear();
  buildRouteDefinitions();
  for (const flight of Object.values(runtimeState && runtimeState.flights || {})) {
    if (flight && flight.dynamicRouteSpec) {
      registerDynamicFreightRoute(flight.dynamicRouteSpec);
    }
  }
  if (runtimeState && runtimeState.roamingConflict) {
    livingRoamingKernel.ensureState(runtimeState.roamingConflict, nowMs);
    livingRoamingKernel.rebuildIndexes(runtimeState.roamingConflict);
    livingRoamingKernel.rebuildDeadlineHeap(runtimeState.roamingConflict);
  }
  rebuildFlightSchedule(nowMs, "test_state");
}

module.exports = {
  OPERATOR_KIND,
  PHASE,
  tick,
  getStatus,
  getSchedulerStatus,
  formatStatus,
  formatConflicts,
  warpToActiveDistress,
  startBattleForSession,
  departNow,
  reset,
  resizePopulation,
  _testing: {
    NETWORK_ROUTE_SPECS,
    CAMPAIGN_ROUTE_SPECS,
    PIRATE_ROUTE_SPECS,
    ALL_NETWORK_ROUTE_SPECS,
    DUTY_ROUTE_SPECS,
    REGIONAL_DUTY_ROUTE_SPECS,
    ALL_DUTY_ROUTE_SPECS,
    buildPopulationPlan,
    buildActorCapabilities,
    resolveActorPresence,
    resolveFlightAssignment,
    getPilotSyncBatchSize,
    takeDirtyPilotActorIDs,
    syncPilotPresence,
    markPilotActorsDirtyForTest(actorIDs = []) {
      for (const actorID of actorIDs) dirtyPilotActorIDs.add(String(actorID));
      return dirtyPilotActorIDs.size;
    },
    chooseHomeNodeIndex,
    resolveFlightOrigin,
    getRouteMinimumSecurity,
    getPirateGroupKeyForSecurity,
    resolvePirateFactionKey,
    getRegionalGroupKey,
    getOffGridActivityTimeMultiplier,
    getVirtualDockedDwellMs,
    getVirtualDutyDwellMs,
    getVirtualReplacementMs,
    isRoamingConflictEnabled,
    buildRoamingTaskGroupRows,
    initializeRoamingConflictState,
    projectRoamingGroupToFlight,
    processRoamingFlight,
    scheduleRoamingIntersection,
    tickRoamingConflict,
    recordShipDestruction,
    getActorShipDisplayName,
    buildRouteDefinitions,
    registerDynamicFreightRoute,
    assignFreightRoute,
    ensureMiningManifest,
    estimateFlightMiningVolume,
    buildVirtualMiningAllocations,
    completeVirtualMiningDuty,
    capturePhysicalMiningCargo,
    buildMiningCargoOverrides,
    buildMiningDutySpawnStates,
    countMaterialized,
    canMaterialize,
    getPhysicalReservationID,
    reservePhysicalFlight,
    releasePhysicalFlightBudget,
    recoverLoadedState,
    setRuntimeStateForTest,
    calculateAlignTimeSeconds,
    estimateWarpDurationMs,
    estimatePoweredUndockMs,
    estimateInSystemTravel,
    estimateNetworkTrip,
    resolveRouteTravelAnchor,
    setVirtualTravelPhase,
    rebaseAcceleratedVirtualTravelForObservation,
    scheduleVirtualDeparture,
    scheduleVirtualCrossing,
    scheduleVirtualStationApproach,
    tickVirtual,
    tickPhysical,
    materializeConflictEncounter,
    dematerializeConflictEncounter,
    rebuildFlightSchedule,
    rescheduleChangedFlight,
    collectConflictFlightIDs,
    runScheduledFlights,
    cleanupPhysicalFlight,
    markMetaDirty,
    markRoamingDirty,
    markActorDirty,
    markFlightDirty,
    markEncounterDirty,
    markEncounterRemoved,
    markAllEncountersDirty,
    markFullRewrite,
    buildPersistenceBatch,
    clearPersistenceDirtyState,
    getRouteDefinition(routeID) {
      return routeDefinitionsByID.get(routeID) || null;
    },
  },
};
