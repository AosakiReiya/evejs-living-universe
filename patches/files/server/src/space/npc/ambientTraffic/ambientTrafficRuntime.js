const path = require("path");

const config = require(path.join(__dirname, "../../../config"));
const log = require(path.join(__dirname, "../../../utils/logger"));
const worldData = require(path.join(__dirname, "../../worldData"));
const nativeNpcStore = require(path.join(__dirname, "../nativeNpcStore"));
const {
  ONE_AU_IN_METERS,
  findSafeWarpOriginAnchor,
} = require(path.join(__dirname, "../npcWarpOrigins"));
const trafficState = require(path.join(__dirname, "./ambientTrafficState"));
const {
  AMBIENT_TRAFFIC_SPAWN_GROUP_ID,
  AMBIENT_TRAFFIC_HAULER_TYPE_ID,
} = require(path.join(__dirname, "./ambientTrafficNpcCatalog"));

const ROUTE_SCHEMA_VERSION = 1;
const TRAFFIC_TICK_INTERVAL_MS = 1_000;
const LIVE_WARP_TIMEOUT_MS = 120_000;
const LIVE_ARRIVAL_DWELL_MS = 10_000;
const LIVE_GATE_DWELL_MS = 8_000;
const ARRIVAL_INGRESS_DURATION_MS = 3_500;
const POWERED_UNDOCK_TARGET_DISTANCE_METERS = 1_000_000;
const CONVOY_FORMATION_SPACING_METERS = 1_200;
const CONVOY_FORMATION_TRAIL_METERS = 700;
const ROUTE_OPERATOR_KIND = "ambientTraffic";
const DEFAULT_ROUTE_ID = "jita_tama_state_logistics";

const PHASE = Object.freeze({
  DOCKED: "docked",
  STATION_DEPARTURE: "station_departure",
  ALIGNING_TO_WARP: "aligning_to_warp",
  WARPING_TO_GATE: "warping_to_gate",
  GATE_DEPARTURE_DWELL: "gate_departure_dwell",
  VIRTUAL_TRANSIT: "virtual_transit",
  VIRTUAL_SYSTEM_DWELL: "virtual_system_dwell",
  GATE_ARRIVAL: "gate_arrival",
  WARPING_ACROSS_SYSTEM: "warping_across_system",
  WARPING_TO_STATION: "warping_to_station",
  STATION_ARRIVAL_DWELL: "station_arrival_dwell",
});

let initialized = false;
let lastTickAtMs = 0;
let disabledCleanupComplete = false;
let cachedRouteDefinition = null;
const routesByID = new Map();

function getNpcService() {
  return require(path.join(__dirname, "../npcService"));
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

function subtractVectors(left, right) {
  return {
    x: toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0),
    y: toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0),
    z: toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0),
  };
}

function distanceBetween(left, right) {
  const delta = subtractVectors(left, right);
  return Math.sqrt((delta.x ** 2) + (delta.y ** 2) + (delta.z ** 2));
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

function crossVectors(left, right) {
  return {
    x: (toFiniteNumber(left && left.y, 0) * toFiniteNumber(right && right.z, 0)) -
      (toFiniteNumber(left && left.z, 0) * toFiniteNumber(right && right.y, 0)),
    y: (toFiniteNumber(left && left.z, 0) * toFiniteNumber(right && right.x, 0)) -
      (toFiniteNumber(left && left.x, 0) * toFiniteNumber(right && right.z, 0)),
    z: (toFiniteNumber(left && left.x, 0) * toFiniteNumber(right && right.y, 0)) -
      (toFiniteNumber(left && left.y, 0) * toFiniteNumber(right && right.x, 0)),
  };
}

function buildFormationSlotPoint(origin, forward, index, options = {}) {
  const slotIndex = Math.max(0, Math.trunc(toFiniteNumber(index, 0)));
  if (slotIndex <= 0) {
    return cloneVector(origin);
  }
  const normalizedForward = normalizeVector(forward);
  const referenceUp = Math.abs(normalizedForward.y) < 0.9
    ? { x: 0, y: 1, z: 0 }
    : { x: 0, y: 0, z: 1 };
  const right = normalizeVector(
    crossVectors(normalizedForward, referenceUp),
    { x: 0, y: 0, z: 1 },
  );
  const pairIndex = Math.ceil(slotIndex / 2);
  const side = slotIndex % 2 === 1 ? 1 : -1;
  const spacingMeters = Math.max(
    100,
    toFiniteNumber(options.spacingMeters, CONVOY_FORMATION_SPACING_METERS),
  );
  const trailMeters = Math.max(
    0,
    toFiniteNumber(options.trailMeters, CONVOY_FORMATION_TRAIL_METERS),
  );
  return addVectors(
    addVectors(
      cloneVector(origin),
      scaleVector(right, side * pairIndex * spacingMeters),
    ),
    scaleVector(normalizedForward, -pairIndex * trailMeters),
  );
}

function parseSystemIDs(value) {
  return [...new Set(String(value || "")
    .split(/[\s,;]+/)
    .map((entry) => toPositiveInt(entry, 0))
    .filter((entry) => entry > 0))];
}

function getDurationMs(configKey, fallbackSeconds) {
  return Math.max(
    1_000,
    toFiniteNumber(config[configKey], fallbackSeconds) * 1_000,
  );
}

function getInitialDepartureDelayMs() {
  return getDurationMs("ambientTrafficInitialDepartureDelaySeconds", 30);
}

function getDockedDwellMs() {
  return getDurationMs("ambientTrafficDockedDwellSeconds", 180);
}

function getPoweredUndockMinimumMs() {
  return getDurationMs("ambientTrafficPoweredUndockMinimumSeconds", 15);
}

function getPoweredUndockMaximumMs() {
  return Math.max(
    getPoweredUndockMinimumMs(),
    getDurationMs("ambientTrafficPoweredUndockMaximumSeconds", 45),
  );
}

function getPoweredUndockClearanceMeters() {
  return Math.max(
    1_000,
    toFiniteNumber(config.ambientTrafficPoweredUndockClearanceMeters, 5_000),
  );
}

function buildPoweredUndockEnvelope(leadEntity) {
  const minimumDurationMs = getPoweredUndockMinimumMs();
  const maxVelocity = Math.max(0, toFiniteNumber(leadEntity && leadEntity.maxVelocity, 0));
  const alignTimeSeconds = Math.max(0, toFiniteNumber(leadEntity && leadEntity.alignTime, 0));
  // A ship already at speed can keep travelling roughly maxVelocity * alignTime
  // while its velocity vector turns. Add that worst-case arc to the ordinary
  // undock clearance so a slow-turning industrial cannot curve back through
  // the station model on a gate that lies behind the undock vector.
  const turnArcAllowanceMeters = maxVelocity * alignTimeSeconds * 1.25;
  const clearanceMeters = getPoweredUndockClearanceMeters() + turnArcAllowanceMeters;
  const nominalTravelMs = maxVelocity > 0
    ? (clearanceMeters / maxVelocity) * 1_000
    : getPoweredUndockMaximumMs();
  const maximumDurationMs = Math.max(
    getPoweredUndockMaximumMs(),
    minimumDurationMs,
    nominalTravelMs * 1.75,
  );
  return {
    minimumDurationMs,
    maximumDurationMs,
    clearanceMeters,
    baseClearanceMeters: getPoweredUndockClearanceMeters(),
    turnArcAllowanceMeters,
    maxVelocity,
    alignTimeSeconds,
  };
}

function getVirtualTransitMs() {
  return getDurationMs("ambientTrafficVirtualTransitSeconds", 15);
}

function getVirtualSystemDwellMs() {
  return getDurationMs("ambientTrafficVirtualSystemDwellSeconds", 20);
}

function findGateToSystem(sourceSystemID, destinationSystemID) {
  return worldData.getStargatesForSystem(sourceSystemID).find((gate) => (
    toPositiveInt(gate && gate.destinationSolarSystemID, 0) === destinationSystemID
  )) || null;
}

function resolveConfiguredRouteDefinition() {
  const systemIDs = parseSystemIDs(config.ambientTrafficRouteSystemIDs);
  if (systemIDs.length < 2) {
    return {
      success: false,
      errorMsg: "AMBIENT_TRAFFIC_ROUTE_REQUIRES_TWO_SYSTEMS",
    };
  }

  const systems = [];
  for (const systemID of systemIDs) {
    const system = worldData.getSolarSystemByID(systemID);
    if (!system) {
      return {
        success: false,
        errorMsg: `AMBIENT_TRAFFIC_SYSTEM_NOT_FOUND:${systemID}`,
      };
    }
    systems.push(system);
  }

  const edges = [];
  for (let index = 0; index < systemIDs.length - 1; index += 1) {
    const sourceSystemID = systemIDs[index];
    const destinationSystemID = systemIDs[index + 1];
    const sourceGate = findGateToSystem(sourceSystemID, destinationSystemID);
    const destinationGate = findGateToSystem(destinationSystemID, sourceSystemID);
    if (!sourceGate || !destinationGate) {
      return {
        success: false,
        errorMsg: `AMBIENT_TRAFFIC_ROUTE_NOT_ADJACENT:${sourceSystemID}:${destinationSystemID}`,
      };
    }
    edges.push({
      sourceSystemID,
      destinationSystemID,
      sourceGateID: sourceGate.itemID,
      destinationGateID: destinationGate.itemID,
    });
  }

  const originStationID = toPositiveInt(config.ambientTrafficOriginStationID, 0);
  const destinationStationID = toPositiveInt(config.ambientTrafficDestinationStationID, 0);
  const originStation = worldData.getStationByID(originStationID);
  const destinationStation = worldData.getStationByID(destinationStationID);
  if (!originStation || toPositiveInt(originStation.solarSystemID, 0) !== systemIDs[0]) {
    return {
      success: false,
      errorMsg: "AMBIENT_TRAFFIC_ORIGIN_STATION_INVALID",
    };
  }
  if (
    !destinationStation ||
    toPositiveInt(destinationStation.solarSystemID, 0) !== systemIDs[systemIDs.length - 1]
  ) {
    return {
      success: false,
      errorMsg: "AMBIENT_TRAFFIC_DESTINATION_STATION_INVALID",
    };
  }

  const signature = JSON.stringify({
    systemIDs,
    originStationID,
    destinationStationID,
    spawnGroupID: AMBIENT_TRAFFIC_SPAWN_GROUP_ID,
  });
  return {
    success: true,
    data: {
      routeID: DEFAULT_ROUTE_ID,
      signature,
      systemIDs,
      systems,
      edges,
      endpointStationIDs: [originStationID, destinationStationID],
      originStation,
      destinationStation,
      spawnGroupID: AMBIENT_TRAFFIC_SPAWN_GROUP_ID,
    },
  };
}

function getConfiguredRouteDefinition() {
  if (cachedRouteDefinition) {
    return cachedRouteDefinition;
  }
  cachedRouteDefinition = resolveConfiguredRouteDefinition();
  return cachedRouteDefinition;
}

function buildMetrics(existing = {}) {
  return {
    materializations: Math.max(0, toPositiveInt(existing.materializations, 0)),
    virtualHops: Math.max(0, toPositiveInt(existing.virtualHops, 0)),
    completedOneWayTrips: Math.max(0, toPositiveInt(existing.completedOneWayTrips, 0)),
    convoyLosses: Math.max(0, toPositiveInt(existing.convoyLosses, 0)),
  };
}

function buildInitialRouteRecord(definition, routeIndex, nowMs) {
  const routeID = routeIndex <= 0
    ? definition.routeID
    : `${definition.routeID}_${routeIndex + 1}`;
  return {
    schemaVersion: ROUTE_SCHEMA_VERSION,
    routeID,
    routeIndex,
    configSignature: definition.signature,
    phase: PHASE.DOCKED,
    currentNodeIndex: 0,
    direction: 1,
    currentSystemID: definition.systemIDs[0],
    entityIDs: [],
    leadEntityID: 0,
    materialized: false,
    poweredUndock: null,
    warpPlan: null,
    nextTransitionAtMs: nowMs + getInitialDepartureDelayMs() + (routeIndex * 20_000),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    lastTransitionAtMs: nowMs,
    lastTransitionReason: "route-initialized",
    lastError: null,
    metrics: buildMetrics(),
  };
}

function cleanupEntityID(entityID) {
  const normalizedEntityID = toPositiveInt(entityID, 0);
  if (!normalizedEntityID) {
    return;
  }
  const controller = getNpcService().getControllerByEntityID(normalizedEntityID);
  if (controller) {
    getNpcService().destroyNpcControllerByEntityID(normalizedEntityID, {
      removeContents: true,
    });
    return;
  }
  if (nativeNpcStore.getNativeEntity(normalizedEntityID)) {
    nativeNpcStore.removeNativeEntityCascade(normalizedEntityID);
  }
}

function cleanupLiveGroup(route) {
  for (const entityID of Array.isArray(route && route.entityIDs) ? route.entityIDs : []) {
    cleanupEntityID(entityID);
  }
  route.entityIDs = [];
  route.leadEntityID = 0;
  route.materialized = false;
  route.poweredUndock = null;
  route.warpPlan = null;
}

function persistRoute(route, nowMs, reason = "state-updated") {
  route.updatedAtMs = nowMs;
  route.lastTransitionAtMs = nowMs;
  route.lastTransitionReason = reason;
  route.metrics = buildMetrics(route.metrics);
  const result = trafficState.upsertRoute(route);
  if (!result.success) {
    log.warn(
      `[AmbientTraffic] Failed to persist route=${route.routeID}: ${result.errorMsg || "WRITE_FAILED"}`,
    );
  }
  return result;
}

function initializeRoutes(nowMs) {
  if (initialized) {
    return;
  }
  initialized = true;
  routesByID.clear();

  const definitionResult = getConfiguredRouteDefinition();
  if (!definitionResult.success || !definitionResult.data) {
    log.warn(
      `[AmbientTraffic] Route disabled: ${definitionResult.errorMsg || "ROUTE_INVALID"}`,
    );
    return;
  }
  const definition = definitionResult.data;
  const convoyCount = Math.max(1, toPositiveInt(config.ambientTrafficConvoyCount, 1));
  const persistedByID = new Map(
    trafficState.listRoutes().map((route) => [String(route.routeID || ""), route]),
  );

  for (let routeIndex = 0; routeIndex < convoyCount; routeIndex += 1) {
    const routeID = routeIndex <= 0
      ? definition.routeID
      : `${definition.routeID}_${routeIndex + 1}`;
    const existing = persistedByID.get(routeID) || null;
    let route = existing && existing.configSignature === definition.signature
      ? {
          ...existing,
          routeID,
          routeIndex,
          metrics: buildMetrics(existing.metrics),
        }
      : buildInitialRouteRecord(definition, routeIndex, nowMs);

    if (Array.isArray(route.entityIDs) && route.entityIDs.length > 0) {
      cleanupLiveGroup(route);
      const nodeIndex = Math.max(
        0,
        Math.min(definition.systemIDs.length - 1, toPositiveInt(route.currentNodeIndex + 1, 1) - 1),
      );
      route.currentNodeIndex = nodeIndex;
      route.currentSystemID = definition.systemIDs[nodeIndex];
      route.phase = nodeIndex === 0 || nodeIndex === definition.systemIDs.length - 1
        ? PHASE.DOCKED
        : PHASE.VIRTUAL_SYSTEM_DWELL;
      route.nextTransitionAtMs = nowMs + 5_000;
      route.lastTransitionReason = "restart-recovered-live-convoy";
    }
    routesByID.set(routeID, route);
    persistRoute(route, nowMs, route.lastTransitionReason || "route-loaded");
  }

  log.info(
    `[AmbientTraffic] Enabled ${routesByID.size} convoy route(s): ` +
      definition.systems.map((system) => system.solarSystemName).join(" -> "),
  );
}

function getLoadedActiveScene(runtime, systemID) {
  if (!runtime || !(runtime.scenes instanceof Map)) {
    return null;
  }
  const scene = runtime.scenes.get(toPositiveInt(systemID, 0)) || null;
  if (!scene || !(scene.sessions instanceof Map) || scene.sessions.size <= 0) {
    return null;
  }
  return scene;
}

function getSceneAnchor(scene, itemID) {
  const normalizedItemID = toPositiveInt(itemID, 0);
  if (!scene || !normalizedItemID) {
    return null;
  }
  if (typeof scene.getEntityByID === "function") {
    const entity = scene.getEntityByID(normalizedItemID);
    if (entity) {
      return entity;
    }
  }
  return Array.isArray(scene.staticEntities)
    ? scene.staticEntities.find((entity) => toPositiveInt(entity && entity.itemID, 0) === normalizedItemID) || null
    : null;
}

function getEndpointStationID(definition, nodeIndex) {
  if (nodeIndex === 0) {
    return definition.endpointStationIDs[0];
  }
  if (nodeIndex === definition.systemIDs.length - 1) {
    return definition.endpointStationIDs[1];
  }
  return 0;
}

function getOutgoingEdge(definition, route) {
  const nodeIndex = route.currentNodeIndex;
  return route.direction > 0
    ? definition.edges[nodeIndex] || null
    : definition.edges[nodeIndex - 1] || null;
}

function getIncomingEdge(definition, route) {
  const nodeIndex = route.currentNodeIndex;
  return route.direction > 0
    ? definition.edges[nodeIndex - 1] || null
    : definition.edges[nodeIndex] || null;
}

function getOutgoingGateID(definition, route) {
  const edge = getOutgoingEdge(definition, route);
  if (!edge) {
    return 0;
  }
  return route.direction > 0 ? edge.sourceGateID : edge.destinationGateID;
}

function getIncomingGateID(definition, route) {
  const edge = getIncomingEdge(definition, route);
  if (!edge) {
    return 0;
  }
  return route.direction > 0 ? edge.destinationGateID : edge.sourceGateID;
}

function buildLandingPoint(anchor, index, total, distanceFromSurfaceMeters = 28_000) {
  const radialDistance = Math.max(
    2_000,
    toFiniteNumber(anchor && anchor.radius, 0) + distanceFromSurfaceMeters,
  );
  const forward = normalizeVector(anchor && anchor.direction);
  const leadPoint = addVectors(
    anchor && anchor.position,
    scaleVector(forward, radialDistance),
  );
  return buildFormationSlotPoint(leadPoint, forward, index);
}

function buildStationDepartureSpawnStates(runtime, station, routeID) {
  if (!runtime || typeof runtime.getStationUndockSpawnState !== "function" || !station) {
    return [];
  }
  // Match a real player undock: use the station locator selected for the lead
  // hauler hull, then arrange the escorts in tight slots behind that locator.
  const undockState = runtime.getStationUndockSpawnState(station, {
    shipTypeID: AMBIENT_TRAFFIC_HAULER_TYPE_ID,
    selectionStrategy: "first",
    selectionKey: `${routeID || DEFAULT_ROUTE_ID}:lead`,
  });
  if (!undockState || !undockState.position || !undockState.direction) {
    return [];
  }
  const direction = normalizeVector(undockState.direction);
  return [0, 1, 2].map((index) => {
    const position = buildFormationSlotPoint(undockState.position, direction, index);
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

function getLiveEntities(runtime, route) {
  const scene = runtime && runtime.scenes instanceof Map
    ? runtime.scenes.get(toPositiveInt(route.currentSystemID, 0)) || null
    : null;
  if (!scene) {
    return [];
  }
  return (Array.isArray(route.entityIDs) ? route.entityIDs : [])
    .map((entityID) => scene.getEntityByID(toPositiveInt(entityID, 0)))
    .filter(Boolean);
}

function hasLiveLead(runtime, route) {
  const leadEntityID = toPositiveInt(route.leadEntityID, 0);
  if (!leadEntityID) {
    return false;
  }
  return getLiveEntities(runtime, route).some(
    (entity) => toPositiveInt(entity && entity.itemID, 0) === leadEntityID,
  );
}

function areLiveEntitiesLanded(runtime, route) {
  const entities = getLiveEntities(runtime, route);
  if (entities.length <= 0) {
    return false;
  }
  return entities.every((entity) => (
    String(entity.mode || "").toUpperCase() !== "WARP" &&
    !entity.pendingWarp &&
    !entity.warpState &&
    !entity.sessionlessWarpIngress
  ));
}

function spawnConvoyAtAnchor(scene, anchor, options = {}) {
  if (!scene || !anchor || !anchor.position) {
    return {
      success: false,
      errorMsg: "AMBIENT_TRAFFIC_ANCHOR_NOT_FOUND",
    };
  }
  return getNpcService().spawnNpcGroupInSystem(scene.systemID, {
    spawnGroupQuery: AMBIENT_TRAFFIC_SPAWN_GROUP_ID,
    entityType: "npc",
    transient: true,
    runtimeKind: "nativeAmbient",
    anchorEntity: anchor,
    operatorKind: ROUTE_OPERATOR_KIND,
    behaviorOverrides: {
      autoAggro: false,
      targetPreference: "none",
      autoActivateWeapons: false,
      returnToHomeWhenIdle: false,
      idleAnchorOrbit: false,
    },
    distanceFromSurfaceMeters: Math.max(
      1_000,
      toFiniteNumber(options.distanceFromSurfaceMeters, 12_000),
    ),
    spreadMeters: 1_200,
    formationSpacingMeters: 1_500,
    spawnStateOverrides: Array.isArray(options.spawnStateOverrides)
      ? options.spawnStateOverrides
      : undefined,
    broadcast: options.broadcast !== false,
    skipInitialBehaviorTick: true,
  });
}

function adoptSpawnedGroup(route, spawnResult) {
  const spawned = spawnResult && spawnResult.data && Array.isArray(spawnResult.data.spawned)
    ? spawnResult.data.spawned
    : [];
  const entityIDs = spawned
    .map((entry) => toPositiveInt(entry && entry.entity && entry.entity.itemID, 0))
    .filter((entityID) => entityID > 0);
  if (entityIDs.length <= 0) {
    return false;
  }
  route.entityIDs = entityIDs;
  route.leadEntityID = entityIDs[0];
  route.materialized = true;
  route.metrics = buildMetrics(route.metrics);
  route.metrics.materializations += 1;
  return true;
}

function beginPoweredStationDeparture(runtime, route, nowMs) {
  const entities = getLiveEntities(runtime, route);
  const leadEntity = entities.find(
    (entity) => toPositiveInt(entity && entity.itemID, 0) === toPositiveInt(route.leadEntityID, 0),
  ) || entities[0];
  if (
    !leadEntity ||
    typeof runtime.gotoDynamicEntityPoint !== "function" ||
    entities.length <= 0
  ) {
    route.lastError = "AMBIENT_TRAFFIC_POWERED_UNDOCK_UNAVAILABLE";
    return false;
  }

  let commandedCount = 0;
  for (const entity of entities) {
    const direction = normalizeVector(entity && entity.direction, leadEntity.direction);
    const targetPoint = addVectors(
      entity && entity.position,
      scaleVector(direction, POWERED_UNDOCK_TARGET_DISTANCE_METERS),
    );
    if (
      runtime.gotoDynamicEntityPoint(
        route.currentSystemID,
        entity.itemID,
        targetPoint,
        { commandSource: "ambientTrafficPoweredUndock" },
      )
    ) {
      commandedCount += 1;
    }
  }
  if (commandedCount !== entities.length) {
    route.lastError = "AMBIENT_TRAFFIC_POWERED_UNDOCK_COMMAND_FAILED";
    return false;
  }

  const poweredEnvelope = buildPoweredUndockEnvelope(leadEntity);
  route.phase = PHASE.STATION_DEPARTURE;
  route.poweredUndock = {
    startedAtMs: nowMs,
    origin: cloneVector(leadEntity.position),
    direction: normalizeVector(leadEntity.direction),
    ...poweredEnvelope,
  };
  route.warpPlan = null;
  route.nextTransitionAtMs = nowMs + route.poweredUndock.minimumDurationMs;
  route.lastError = null;
  persistRoute(route, nowMs, "powered-station-undock-started");
  log.info(
    `[AmbientTraffic] Powered undock route=${route.routeID} lead=${leadEntity.itemID} ` +
      `maxVelocity=${Math.round(toFiniteNumber(leadEntity.maxVelocity, 0))}m/s ` +
      `alignTime=${toFiniteNumber(leadEntity.alignTime, 0).toFixed(2)}s ` +
      `warpSpeed=${toFiniteNumber(leadEntity.warpSpeedAU, 0).toFixed(2)}AU/s ` +
      `safeClearance=${Math.round(poweredEnvelope.clearanceMeters)}m ` +
      `timeout=${Math.ceil(poweredEnvelope.maximumDurationMs / 1000)}s`,
  );
  return true;
}

function hasPoweredUndockCleared(runtime, route, nowMs) {
  const state = route && route.poweredUndock;
  const leadEntity = getLiveEntities(runtime, route).find(
    (entity) => toPositiveInt(entity && entity.itemID, 0) === toPositiveInt(route.leadEntityID, 0),
  );
  if (!state || !leadEntity || !state.origin) {
    return true;
  }
  const elapsedMs = Math.max(0, nowMs - toFiniteNumber(state.startedAtMs, nowMs));
  if (elapsedMs < toFiniteNumber(state.minimumDurationMs, getPoweredUndockMinimumMs())) {
    return false;
  }
  return distanceBetween(leadEntity.position, state.origin) >=
    toFiniteNumber(state.clearanceMeters, getPoweredUndockClearanceMeters());
}

function hasPoweredUndockTimedOut(route, nowMs) {
  const state = route && route.poweredUndock;
  if (!state) {
    return false;
  }
  return Math.max(0, nowMs - toFiniteNumber(state.startedAtMs, nowMs)) >=
    toFiniteNumber(state.maximumDurationMs, getPoweredUndockMaximumMs());
}

function spawnStationDeparture(runtime, definition, route, nowMs) {
  const scene = getLoadedActiveScene(runtime, route.currentSystemID);
  const stationID = getEndpointStationID(definition, route.currentNodeIndex);
  const station = getSceneAnchor(scene, stationID);
  if (!scene || !station) {
    return false;
  }
  const spawnResult = spawnConvoyAtAnchor(scene, station, {
    distanceFromSurfaceMeters: 14_000,
    spawnStateOverrides: buildStationDepartureSpawnStates(
      runtime,
      getEndpointStationID(definition, route.currentNodeIndex) === definition.endpointStationIDs[0]
        ? definition.originStation
        : definition.destinationStation,
      route.routeID,
    ),
    broadcast: true,
  });
  if (!spawnResult.success || !adoptSpawnedGroup(route, spawnResult)) {
    route.lastError = spawnResult.errorMsg || "AMBIENT_TRAFFIC_SPAWN_FAILED";
    log.warn(
      `[AmbientTraffic] Station departure spawn failed route=${route.routeID} ` +
        `system=${route.currentSystemID}: ${route.lastError}`,
    );
    return false;
  }
  if (!beginPoweredStationDeparture(runtime, route, nowMs)) {
    log.warn(
      `[AmbientTraffic] Powered undock failed route=${route.routeID} ` +
        `system=${route.currentSystemID}: ${route.lastError}`,
    );
    cleanupLiveGroup(route);
    return false;
  }
  return true;
}

function spawnGateArrival(runtime, definition, route, nowMs) {
  const scene = getLoadedActiveScene(runtime, route.currentSystemID);
  const gateID = getIncomingGateID(definition, route);
  const gate = getSceneAnchor(scene, gateID);
  if (!scene || !gate) {
    return false;
  }
  const safeOrigin = findSafeWarpOriginAnchor(scene, gate, {
    clearanceMeters: ONE_AU_IN_METERS,
    minDistanceMeters: ONE_AU_IN_METERS * 2,
    maxDistanceMeters: ONE_AU_IN_METERS * 3,
  });
  const originAnchor = {
    kind: "coordinates",
    itemID: 0,
    itemName: `${gate.itemName || "Stargate"} traffic ingress`,
    position: safeOrigin.position,
    direction: safeOrigin.direction,
    radius: 0,
  };
  const spawnResult = spawnConvoyAtAnchor(scene, originAnchor, {
    distanceFromSurfaceMeters: 2_000,
    broadcast: false,
  });
  if (!spawnResult.success || !adoptSpawnedGroup(route, spawnResult)) {
    route.lastError = spawnResult.errorMsg || "AMBIENT_TRAFFIC_SPAWN_FAILED";
    log.warn(
      `[AmbientTraffic] Gate arrival spawn failed route=${route.routeID} ` +
        `system=${route.currentSystemID}: ${route.lastError}`,
    );
    return false;
  }

  const entities = getLiveEntities(runtime, route);
  let ingressFailed = false;
  for (let index = 0; index < entities.length; index += 1) {
    const entity = entities[index];
    const ingressResult = runtime.startSessionlessWarpIngress(
      route.currentSystemID,
      entity.itemID,
      buildLandingPoint(gate, index, entities.length, 24_000),
      {
        targetEntityID: gate.itemID,
        ignoreWarpDisruptionField: true,
        visibilitySuppressMs: 250,
        ingressDurationMs: ARRIVAL_INGRESS_DURATION_MS,
      },
    );
    if (!ingressResult.success) {
      ingressFailed = true;
      route.lastError = ingressResult.errorMsg || "AMBIENT_TRAFFIC_INGRESS_FAILED";
      break;
    }
  }
  if (ingressFailed) {
    cleanupLiveGroup(route);
    return false;
  }

  route.phase = PHASE.GATE_ARRIVAL;
  route.nextTransitionAtMs = nowMs + ARRIVAL_INGRESS_DURATION_MS + LIVE_ARRIVAL_DWELL_MS;
  route.lastError = null;
  persistRoute(route, nowMs, "materialized-gate-arrival");
  return true;
}

function buildNaturalWarpOrders(entities, anchor, nowMs) {
  const alignDurationsMs = entities.map((entity) => Math.max(
    500,
    toFiniteNumber(entity && entity.alignTime, 1) * 1_000,
  ));
  const longestAlignMs = Math.max(...alignDurationsMs);
  const plannedWarpStartAtMs = nowMs + longestAlignMs + 500;
  return {
    plannedWarpStartAtMs,
    orders: entities.map((entity, index) => ({
      entityID: entity.itemID,
      destinationPoint: buildLandingPoint(anchor, index, entities.length, 26_000),
      issueAtMs: plannedWarpStartAtMs - alignDurationsMs[index],
      issuedAtMs: 0,
      alignDurationMs: alignDurationsMs[index],
    })),
  };
}

function buildNaturalWarpPlan(runtime, route, anchor, finalPhase, nowMs) {
  const entities = getLiveEntities(runtime, route);
  if (!anchor || entities.length <= 0) {
    return false;
  }
  const orderPlan = buildNaturalWarpOrders(entities, anchor, nowMs);
  route.poweredUndock = null;
  route.phase = PHASE.ALIGNING_TO_WARP;
  route.warpPlan = {
    createdAtMs: nowMs,
    plannedWarpStartAtMs: orderPlan.plannedWarpStartAtMs,
    targetEntityID: toPositiveInt(anchor && anchor.itemID, 0),
    finalPhase,
    orders: orderPlan.orders,
  };
  route.nextTransitionAtMs = orderPlan.plannedWarpStartAtMs + LIVE_WARP_TIMEOUT_MS;
  route.lastError = null;
  persistRoute(route, nowMs, `natural-warp-alignment-planned:${finalPhase}`);
  return true;
}

function tickNaturalWarpPlan(runtime, route, nowMs) {
  const plan = route && route.warpPlan;
  if (!plan || !Array.isArray(plan.orders) || plan.orders.length <= 0) {
    route.lastError = "AMBIENT_TRAFFIC_WARP_PLAN_MISSING";
    return false;
  }
  let changed = false;
  for (const order of plan.orders) {
    if (toFiniteNumber(order.issuedAtMs, 0) > 0 || nowMs < toFiniteNumber(order.issueAtMs, nowMs)) {
      continue;
    }
    const warpResult = runtime.warpDynamicEntityToPoint(
      route.currentSystemID,
      order.entityID,
      order.destinationPoint,
      {
        targetEntityID: plan.targetEntityID,
        ignoreWarpDisruptionField: true,
        // The normal pending-warp path turns and accelerates the hull using its
        // own max velocity, agility/align time, and authored warp speed.
        forceImmediateStart: false,
      },
    );
    if (!warpResult.success) {
      route.lastError = warpResult.errorMsg || "AMBIENT_TRAFFIC_WARP_FAILED";
      log.warn(
        `[AmbientTraffic] Natural warp failed route=${route.routeID} ` +
          `entity=${order.entityID} target=${plan.targetEntityID}: ${route.lastError}`,
      );
      continue;
    }
    order.issuedAtMs = nowMs;
    changed = true;
  }

  if (plan.orders.every((order) => toFiniteNumber(order.issuedAtMs, 0) > 0)) {
    route.phase = plan.finalPhase;
    route.warpPlan = null;
    route.nextTransitionAtMs = nowMs + LIVE_WARP_TIMEOUT_MS;
    route.lastError = null;
    persistRoute(route, nowMs, `natural-warp-issued:${route.phase}`);
    return true;
  }
  if (changed) {
    persistRoute(route, nowMs, "natural-warp-order-issued");
  }
  return true;
}

function advanceToVirtualTransit(definition, route, nowMs, reason) {
  const nextNodeIndex = route.currentNodeIndex + route.direction;
  if (nextNodeIndex < 0 || nextNodeIndex >= definition.systemIDs.length) {
    route.direction *= -1;
    route.phase = PHASE.DOCKED;
    route.nextTransitionAtMs = nowMs + getDockedDwellMs();
    persistRoute(route, nowMs, `${reason}:endpoint-reversed`);
    return;
  }
  route.currentNodeIndex = nextNodeIndex;
  route.currentSystemID = definition.systemIDs[nextNodeIndex];
  route.phase = PHASE.VIRTUAL_TRANSIT;
  route.nextTransitionAtMs = nowMs + getVirtualTransitMs();
  route.metrics = buildMetrics(route.metrics);
  route.metrics.virtualHops += 1;
  persistRoute(route, nowMs, reason);
}

function settleAtEndpoint(definition, route, nowMs, reason) {
  route.metrics = buildMetrics(route.metrics);
  route.metrics.completedOneWayTrips += 1;
  route.direction *= -1;
  route.phase = PHASE.DOCKED;
  route.nextTransitionAtMs = nowMs + getDockedDwellMs();
  persistRoute(route, nowMs, reason);
}

function advanceVirtualPhase(runtime, definition, route, nowMs) {
  if (route.phase === PHASE.DOCKED) {
    if (spawnStationDeparture(runtime, definition, route, nowMs)) {
      return;
    }
    advanceToVirtualTransit(definition, route, nowMs, "virtual-station-departure");
    return;
  }

  if (route.phase === PHASE.VIRTUAL_TRANSIT) {
    if (spawnGateArrival(runtime, definition, route, nowMs)) {
      return;
    }
    const atEndpoint =
      route.currentNodeIndex === 0 ||
      route.currentNodeIndex === definition.systemIDs.length - 1;
    if (atEndpoint) {
      settleAtEndpoint(definition, route, nowMs, "virtual-endpoint-arrival");
    } else {
      route.phase = PHASE.VIRTUAL_SYSTEM_DWELL;
      route.nextTransitionAtMs = nowMs + getVirtualSystemDwellMs();
      persistRoute(route, nowMs, "virtual-intermediate-arrival");
    }
    return;
  }

  if (route.phase === PHASE.VIRTUAL_SYSTEM_DWELL) {
    advanceToVirtualTransit(definition, route, nowMs, "virtual-intermediate-departure");
  }
}

function handleConvoyLoss(definition, route, nowMs) {
  cleanupLiveGroup(route);
  route.metrics = buildMetrics(route.metrics);
  route.metrics.convoyLosses += 1;
  route.currentNodeIndex = 0;
  route.currentSystemID = definition.systemIDs[0];
  route.direction = 1;
  route.phase = PHASE.DOCKED;
  route.nextTransitionAtMs = nowMs + getDockedDwellMs();
  route.lastError = "CONVOY_LEAD_DESTROYED";
  persistRoute(route, nowMs, "convoy-loss-recovery");
  log.info(
    `[AmbientTraffic] Convoy loss route=${route.routeID}; replacement scheduled from Jita.`,
  );
}

function dematerializeForEmptyScene(definition, route, nowMs) {
  const previousPhase = route.phase;
  cleanupLiveGroup(route);
  if (
    previousPhase === PHASE.STATION_ARRIVAL_DWELL ||
    previousPhase === PHASE.WARPING_TO_STATION
  ) {
    settleAtEndpoint(definition, route, nowMs, "dematerialized-endpoint-arrival");
    return;
  }
  if (
    previousPhase === PHASE.STATION_DEPARTURE ||
    previousPhase === PHASE.ALIGNING_TO_WARP ||
    previousPhase === PHASE.WARPING_TO_GATE ||
    previousPhase === PHASE.GATE_DEPARTURE_DWELL ||
    previousPhase === PHASE.GATE_ARRIVAL ||
    previousPhase === PHASE.WARPING_ACROSS_SYSTEM
  ) {
    advanceToVirtualTransit(definition, route, nowMs, "dematerialized-empty-scene");
    return;
  }
  route.phase = PHASE.VIRTUAL_SYSTEM_DWELL;
  route.nextTransitionAtMs = nowMs + getVirtualSystemDwellMs();
  persistRoute(route, nowMs, "dematerialized-fallback");
}

function tickMaterializedRoute(runtime, definition, route, nowMs) {
  const activeScene = getLoadedActiveScene(runtime, route.currentSystemID);
  if (!activeScene) {
    dematerializeForEmptyScene(definition, route, nowMs);
    return;
  }
  if (!hasLiveLead(runtime, route)) {
    handleConvoyLoss(definition, route, nowMs);
    return;
  }

  if (route.phase === PHASE.STATION_DEPARTURE && nowMs >= route.nextTransitionAtMs) {
    if (!hasPoweredUndockCleared(runtime, route, nowMs)) {
      if (hasPoweredUndockTimedOut(route, nowMs)) {
        route.lastError = "AMBIENT_TRAFFIC_POWERED_UNDOCK_CLEARANCE_TIMEOUT";
        log.warn(
          `[AmbientTraffic] Powered undock timed out route=${route.routeID}; ` +
            "continuing virtually instead of turning through station geometry.",
        );
        dematerializeForEmptyScene(definition, route, nowMs);
      }
      return;
    }
    const gate = getSceneAnchor(activeScene, getOutgoingGateID(definition, route));
    if (!buildNaturalWarpPlan(runtime, route, gate, PHASE.WARPING_TO_GATE, nowMs)) {
      dematerializeForEmptyScene(definition, route, nowMs);
    }
    return;
  }

  if (route.phase === PHASE.ALIGNING_TO_WARP) {
    if (
      nowMs >= route.nextTransitionAtMs ||
      !tickNaturalWarpPlan(runtime, route, nowMs)
    ) {
      dematerializeForEmptyScene(definition, route, nowMs);
    }
    return;
  }

  if (route.phase === PHASE.GATE_ARRIVAL && nowMs >= route.nextTransitionAtMs) {
    const stationID = getEndpointStationID(definition, route.currentNodeIndex);
    const destinationAnchor = stationID > 0
      ? getSceneAnchor(activeScene, stationID)
      : getSceneAnchor(activeScene, getOutgoingGateID(definition, route));
    const nextPhase = stationID > 0
      ? PHASE.WARPING_TO_STATION
      : PHASE.WARPING_ACROSS_SYSTEM;
    if (!buildNaturalWarpPlan(runtime, route, destinationAnchor, nextPhase, nowMs)) {
      dematerializeForEmptyScene(definition, route, nowMs);
    }
    return;
  }

  if (route.phase === PHASE.WARPING_TO_GATE) {
    if (areLiveEntitiesLanded(runtime, route)) {
      route.phase = PHASE.GATE_DEPARTURE_DWELL;
      route.nextTransitionAtMs = nowMs + LIVE_GATE_DWELL_MS;
      persistRoute(route, nowMs, "arrived-at-departure-gate");
    } else if (nowMs >= route.nextTransitionAtMs) {
      dematerializeForEmptyScene(definition, route, nowMs);
    }
    return;
  }

  if (route.phase === PHASE.WARPING_ACROSS_SYSTEM) {
    if (areLiveEntitiesLanded(runtime, route)) {
      route.phase = PHASE.GATE_DEPARTURE_DWELL;
      route.nextTransitionAtMs = nowMs + LIVE_GATE_DWELL_MS;
      persistRoute(route, nowMs, "arrived-at-through-gate");
    } else if (nowMs >= route.nextTransitionAtMs) {
      dematerializeForEmptyScene(definition, route, nowMs);
    }
    return;
  }

  if (route.phase === PHASE.WARPING_TO_STATION) {
    if (areLiveEntitiesLanded(runtime, route)) {
      route.phase = PHASE.STATION_ARRIVAL_DWELL;
      route.nextTransitionAtMs = nowMs + LIVE_GATE_DWELL_MS;
      persistRoute(route, nowMs, "arrived-at-endpoint-station");
    } else if (nowMs >= route.nextTransitionAtMs) {
      dematerializeForEmptyScene(definition, route, nowMs);
    }
    return;
  }

  if (route.phase === PHASE.GATE_DEPARTURE_DWELL && nowMs >= route.nextTransitionAtMs) {
    cleanupLiveGroup(route);
    advanceToVirtualTransit(definition, route, nowMs, "physical-gate-jump");
    return;
  }

  if (route.phase === PHASE.STATION_ARRIVAL_DWELL && nowMs >= route.nextTransitionAtMs) {
    cleanupLiveGroup(route);
    settleAtEndpoint(definition, route, nowMs, "physical-station-dock");
  }
}

function cleanupDisabledRoutes(nowMs) {
  if (disabledCleanupComplete) {
    return;
  }
  disabledCleanupComplete = true;
  for (const route of trafficState.listRoutes()) {
    cleanupLiveGroup(route);
    route.phase = PHASE.DOCKED;
    route.materialized = false;
    route.nextTransitionAtMs = nowMs + getInitialDepartureDelayMs();
    persistRoute(route, nowMs, "traffic-disabled-cleanup");
  }
}

function tick(runtime, nowMs = Date.now()) {
  const now = toFiniteNumber(nowMs, Date.now());
  if (config.ambientTrafficEnabled !== true) {
    cleanupDisabledRoutes(now);
    return;
  }
  disabledCleanupComplete = false;
  if (now - lastTickAtMs < TRAFFIC_TICK_INTERVAL_MS) {
    return;
  }
  lastTickAtMs = now;
  initializeRoutes(now);

  const definitionResult = getConfiguredRouteDefinition();
  if (!definitionResult.success || !definitionResult.data) {
    return;
  }
  const definition = definitionResult.data;
  for (const route of routesByID.values()) {
    try {
      if (route.materialized === true || (Array.isArray(route.entityIDs) && route.entityIDs.length > 0)) {
        tickMaterializedRoute(runtime, definition, route, now);
      } else if (now >= toFiniteNumber(route.nextTransitionAtMs, 0)) {
        advanceVirtualPhase(runtime, definition, route, now);
      }
    } catch (error) {
      route.lastError = error.message;
      route.nextTransitionAtMs = now + 10_000;
      persistRoute(route, now, "tick-error");
      log.warn(`[AmbientTraffic] Tick failed route=${route.routeID}: ${error.message}`);
    }
  }
}

function buildRouteStatus(route, definition, nowMs) {
  const nodeIndex = Math.max(
    0,
    Math.min(definition.systems.length - 1, Number(route.currentNodeIndex) || 0),
  );
  return {
    routeID: route.routeID,
    phase: route.phase,
    direction: route.direction > 0 ? "outbound" : "return",
    currentSystemID: definition.systemIDs[nodeIndex],
    currentSystemName: definition.systems[nodeIndex].solarSystemName,
    materialized: route.materialized === true,
    liveShipCount: Array.isArray(route.entityIDs) ? route.entityIDs.length : 0,
    nextTransitionInSeconds: Math.max(
      0,
      Math.ceil((toFiniteNumber(route.nextTransitionAtMs, nowMs) - nowMs) / 1000),
    ),
    lastTransitionReason: route.lastTransitionReason || null,
    lastError: route.lastError || null,
    metrics: buildMetrics(route.metrics),
  };
}

function getStatus(nowMs = Date.now()) {
  const definitionResult = getConfiguredRouteDefinition();
  if (!definitionResult.success || !definitionResult.data) {
    return {
      enabled: config.ambientTrafficEnabled === true,
      valid: false,
      errorMsg: definitionResult.errorMsg || "ROUTE_INVALID",
      routes: [],
    };
  }
  const definition = definitionResult.data;
  const sourceRoutes = routesByID.size > 0
    ? [...routesByID.values()]
    : trafficState.listRoutes();
  return {
    enabled: config.ambientTrafficEnabled === true,
    valid: true,
    routePath: definition.systems.map((system) => ({
      systemID: system.solarSystemID,
      name: system.solarSystemName,
      security: system.security,
    })),
    routes: sourceRoutes.map((route) => buildRouteStatus(route, definition, nowMs)),
  };
}

function formatStatus(nowMs = Date.now()) {
  const status = getStatus(nowMs);
  if (!status.valid) {
    return `Ambient traffic ${status.enabled ? "enabled" : "disabled"}, route invalid: ${status.errorMsg}.`;
  }
  const pathLabel = status.routePath.map((system) => system.name).join(" -> ");
  const routeLines = status.routes.map((route) => (
    `${route.routeID}: ${route.phase} in ${route.currentSystemName}, ${route.direction}, ` +
      `${route.materialized ? `${route.liveShipCount} live ships` : "virtual"}, ` +
      `next ${route.nextTransitionInSeconds}s, losses ${route.metrics.convoyLosses}.` +
      (route.lastError ? ` Last error: ${route.lastError}.` : "")
  ));
  return [
    `Ambient traffic is ${status.enabled ? "enabled" : "disabled"}.`,
    `Pilot route: ${pathLabel}.`,
    ...(routeLines.length > 0 ? routeLines : ["No route state has been initialized yet."]),
  ].join(" ");
}

function departNow(nowMs = Date.now()) {
  const now = toFiniteNumber(nowMs, Date.now());
  initializeRoutes(now);
  for (const route of routesByID.values()) {
    if (route.materialized) {
      continue;
    }
    route.nextTransitionAtMs = now;
    persistRoute(route, now, "departure-forced-by-command");
  }
  return getStatus(now);
}

function reset(nowMs = Date.now()) {
  const now = toFiniteNumber(nowMs, Date.now());
  for (const route of routesByID.values()) {
    cleanupLiveGroup(route);
    trafficState.removeRoute(route.routeID);
  }
  initialized = false;
  lastTickAtMs = 0;
  routesByID.clear();
  initializeRoutes(now);
  return getStatus(now);
}

module.exports = {
  PHASE,
  ROUTE_OPERATOR_KIND,
  tick,
  getStatus,
  formatStatus,
  departNow,
  reset,
  _testing: {
    parseSystemIDs,
    resolveConfiguredRouteDefinition,
    buildInitialRouteRecord,
    getOutgoingGateID,
    getIncomingGateID,
    buildLandingPoint,
    buildFormationSlotPoint,
    buildStationDepartureSpawnStates,
    buildPoweredUndockEnvelope,
    hasPoweredUndockCleared,
    hasPoweredUndockTimedOut,
    buildNaturalWarpOrders,
  },
};
