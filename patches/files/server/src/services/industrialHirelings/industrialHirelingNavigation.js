"use strict";

const NAVIGATION_SCHEMA_VERSION = 1;
const MAX_RECENT_COMMANDS = 16;

const NAVIGATION_PHASE = Object.freeze({
  DOCKED: "docked",
  IN_TRANSIT: "in_transit",
  ARRIVED: "arrived",
  BLOCKED: "blocked",
});

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toNonNegativeInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizeSystemIDs(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => toPositiveInt(value, 0))
    .filter(Boolean);
}

function normalizeCommandID(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized)
    ? normalized
    : null;
}

function normalizeCommandFingerprint(value) {
  return String(value || "").trim().slice(0, 192);
}

function normalizeRecentCommands(navigationArg = {}) {
  const navigation =
    navigationArg && typeof navigationArg === "object" ? navigationArg : {};
  const byCommandID = new Map();
  for (const entry of Array.isArray(navigation.recentCommands)
    ? navigation.recentCommands
    : []) {
    const commandID = normalizeCommandID(entry && entry.commandID);
    const fingerprint = normalizeCommandFingerprint(entry && entry.fingerprint);
    if (!commandID || !fingerprint) continue;
    byCommandID.delete(commandID);
    byCommandID.set(commandID, { commandID, fingerprint });
  }
  const legacyCommandID = normalizeCommandID(navigation.lastCommandID);
  const legacyFingerprint = normalizeCommandFingerprint(
    navigation.lastCommandFingerprint,
  );
  if (legacyCommandID && legacyFingerprint) {
    byCommandID.delete(legacyCommandID);
    byCommandID.set(legacyCommandID, {
      commandID: legacyCommandID,
      fingerprint: legacyFingerprint,
    });
  }
  return [...byCommandID.values()].slice(-MAX_RECENT_COMMANDS);
}

function appendRecentCommand(navigation, commandID, fingerprint) {
  const recentCommands = normalizeRecentCommands(navigation);
  if (!commandID || !fingerprint) return recentCommands;
  const withoutCommand = recentCommands.filter(
    (entry) => entry.commandID !== commandID,
  );
  withoutCommand.push({ commandID, fingerprint });
  return withoutCommand.slice(-MAX_RECENT_COMMANDS);
}

function isNavigationInTransit(contractOrNavigation) {
  const navigation = contractOrNavigation &&
    contractOrNavigation.navigation &&
    typeof contractOrNavigation.navigation === "object"
    ? contractOrNavigation.navigation
    : contractOrNavigation;
  return String(navigation && navigation.phase || "") === NAVIGATION_PHASE.IN_TRANSIT;
}

function getStationSystemID(topology, stationID) {
  if (!topology || typeof topology.getStationSolarSystemID !== "function") {
    return 0;
  }
  return toPositiveInt(topology.getStationSolarSystemID(stationID), 0);
}

function resolveCurrentSystemID(contract, topology) {
  return toPositiveInt(
    contract && contract.navigation && contract.navigation.currentSystemID,
    toPositiveInt(
      contract && contract.currentSystemID,
      toPositiveInt(
        contract && contract.assignedSystemID,
        getStationSystemID(topology, contract && contract.homeStationID),
      ),
    ),
  );
}

function buildStationaryNavigation(input = {}) {
  const nowMs = Math.max(0, Math.trunc(Number(input.nowMs) || 0));
  const currentSystemID = toPositiveInt(input.currentSystemID, 0);
  const stationID = toPositiveInt(input.stationID, 0);
  return {
    schemaVersion: NAVIGATION_SCHEMA_VERSION,
    currentSystemID,
    destinationSystemID: currentSystemID,
    destinationStationID: stationID,
    routeSystemIDs: currentSystemID > 0 ? [currentSystemID] : [],
    legIndex: 0,
    phase: String(input.phase || NAVIGATION_PHASE.DOCKED),
    routeStartedAtMs: nowMs,
    departureAtMs: nowMs,
    arrivalAtMs: nowMs,
    completedAtMs: nowMs,
    legDurationMs: Math.max(1, toPositiveInt(input.legDurationMs, 1)),
    revision: Math.max(1, toPositiveInt(input.revision, 1)),
    lastCommandID: "",
    lastCommandFingerprint: "",
    recentCommands: [],
  };
}

function initializeContractNavigation(contract, options = {}) {
  const topology = options.topology || null;
  const nowMs = Math.max(
    0,
    Math.trunc(Number(options.nowMs) || Number(contract && contract.createdAtMs) || Date.now()),
  );
  const currentSystemID = resolveCurrentSystemID(contract, topology);
  const existing =
    contract && contract.navigation && typeof contract.navigation === "object"
      ? contract.navigation
      : null;
  if (existing) {
    const normalizedCurrentSystemID = toPositiveInt(
      existing.currentSystemID,
      currentSystemID,
    );
    const normalizedRouteSystemIDs = normalizeSystemIDs(existing.routeSystemIDs);
    return {
      ...buildStationaryNavigation({
        currentSystemID,
        stationID: existing.destinationStationID,
        nowMs,
        legDurationMs: options.legDurationMs,
      }),
      ...existing,
      schemaVersion: NAVIGATION_SCHEMA_VERSION,
      currentSystemID: normalizedCurrentSystemID,
      destinationSystemID: toPositiveInt(
        existing.destinationSystemID,
        normalizedCurrentSystemID,
      ),
      routeSystemIDs: normalizedRouteSystemIDs.length > 0
        ? normalizedRouteSystemIDs
        : normalizedCurrentSystemID > 0
          ? [normalizedCurrentSystemID]
          : [],
      legIndex: toNonNegativeInt(existing.legIndex, 0),
      revision: Math.max(1, toPositiveInt(existing.revision, 1)),
      lastCommandID: normalizeCommandID(existing.lastCommandID) || "",
      lastCommandFingerprint: String(existing.lastCommandFingerprint || ""),
      recentCommands: normalizeRecentCommands(existing),
    };
  }
  return buildStationaryNavigation({
    currentSystemID,
    stationID: toPositiveInt(contract && contract.homeStationID, 0),
    nowMs,
    legDurationMs: options.legDurationMs,
  });
}

function planNavigation(contract, input = {}, options = {}) {
  const topology = options.topology || null;
  const nowMs = Math.max(0, Math.trunc(Number(options.nowMs) || Date.now()));
  const legDurationMs = Math.max(1, toPositiveInt(options.legDurationMs, 30_000));
  const destinationStationID = toPositiveInt(input.destinationStationID, 0);
  const explicitDestinationSystemID = toPositiveInt(input.destinationSystemID, 0);
  const destinationSystemID = explicitDestinationSystemID ||
    getStationSystemID(topology, destinationStationID);
  if (!destinationSystemID) {
    return {
      success: false,
      errorMsg: destinationStationID
        ? "INDUSTRIAL_HIRELING_DESTINATION_STATION_NOT_FOUND"
        : "INDUSTRIAL_HIRELING_DESTINATION_SYSTEM_NOT_FOUND",
    };
  }

  const sourceSystemID = resolveCurrentSystemID(contract, topology);
  if (!sourceSystemID) {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_HIRELING_CURRENT_SYSTEM_UNKNOWN",
    };
  }
  if (!topology || typeof topology.getShortestPath !== "function") {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_HIRELING_NAVIGATION_TOPOLOGY_UNAVAILABLE",
    };
  }

  const routeSystemIDs = normalizeSystemIDs(
    topology.getShortestPath(sourceSystemID, destinationSystemID),
  );
  if (
    routeSystemIDs.length === 0 ||
    routeSystemIDs[0] !== sourceSystemID ||
    routeSystemIDs[routeSystemIDs.length - 1] !== destinationSystemID
  ) {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_HIRELING_ROUTE_NOT_FOUND",
      data: { sourceSystemID, destinationSystemID },
    };
  }

  const previousNavigation = initializeContractNavigation(contract, {
    topology,
    nowMs,
    legDurationMs,
  });
  const commandID = normalizeCommandID(input.commandID);
  if (commandID === null) {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_HIRELING_NAVIGATION_COMMAND_ID_INVALID",
    };
  }
  const commandFingerprint = normalizeCommandFingerprint(
    input.commandFingerprint ||
      (
        destinationStationID > 0
          ? `station:${destinationStationID}`
          : `system:${destinationSystemID}`
      ),
  );
  const inTransit = routeSystemIDs.length > 1;
  const recentCommands = appendRecentCommand(
    previousNavigation,
    commandID,
    commandFingerprint,
  );
  const navigation = {
    schemaVersion: NAVIGATION_SCHEMA_VERSION,
    currentSystemID: sourceSystemID,
    destinationSystemID,
    destinationStationID,
    routeSystemIDs,
    legIndex: 0,
    phase: inTransit ? NAVIGATION_PHASE.IN_TRANSIT : NAVIGATION_PHASE.ARRIVED,
    routeStartedAtMs: nowMs,
    departureAtMs: nowMs,
    arrivalAtMs: inTransit ? nowMs + legDurationMs : nowMs,
    completedAtMs: inTransit ? 0 : nowMs,
    legDurationMs,
    revision: Math.max(1, toPositiveInt(previousNavigation.revision, 1) + 1),
    lastCommandID: commandID || previousNavigation.lastCommandID || "",
    lastCommandFingerprint: commandID
      ? commandFingerprint
      : previousNavigation.lastCommandFingerprint || "",
    recentCommands,
  };
  return {
    success: true,
    data: {
      navigation,
      currentSystemID: sourceSystemID,
      sourceSystemID,
      destinationSystemID,
      destinationStationID,
      routeSystemIDs,
      jumpCount: Math.max(0, routeSystemIDs.length - 1),
    },
  };
}

function inspectCommandReplay(contract, input = {}) {
  const commandID = normalizeCommandID(input.commandID);
  if (commandID === null) {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_HIRELING_NAVIGATION_COMMAND_ID_INVALID",
    };
  }
  if (!commandID) return { success: true, replayed: false };

  const navigation =
    contract && contract.navigation && typeof contract.navigation === "object"
      ? contract.navigation
      : {};
  const matchingCommand = normalizeRecentCommands(navigation)
    .find((entry) => entry.commandID === commandID);
  if (!matchingCommand) {
    return { success: true, replayed: false };
  }
  const destinationStationID = toPositiveInt(input.destinationStationID, 0);
  const destinationSystemID = toPositiveInt(input.destinationSystemID, 0);
  const fingerprint = normalizeCommandFingerprint(
    input.commandFingerprint ||
      (
        destinationStationID > 0
          ? `station:${destinationStationID}`
          : `system:${destinationSystemID}`
      ),
  );
  if (matchingCommand.fingerprint !== fingerprint) {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_HIRELING_NAVIGATION_COMMAND_CONFLICT",
    };
  }
  return { success: true, replayed: true };
}

function advanceNavigation(contract, nowArg = Date.now()) {
  const navigation =
    contract && contract.navigation && typeof contract.navigation === "object"
      ? contract.navigation
      : null;
  if (!navigation || !isNavigationInTransit(navigation)) {
    return {
      success: true,
      changed: false,
      data: { navigation, advancedLegs: 0, arrived: false },
    };
  }

  const nowMs = Math.max(0, Math.trunc(Number(nowArg) || Date.now()));
  let arrivalAtMs = Math.max(0, Math.trunc(Number(navigation.arrivalAtMs) || 0));
  if (arrivalAtMs > nowMs) {
    return {
      success: true,
      changed: false,
      data: { navigation, advancedLegs: 0, arrived: false },
    };
  }

  const routeSystemIDs = normalizeSystemIDs(navigation.routeSystemIDs);
  let legIndex = toNonNegativeInt(navigation.legIndex, 0);
  const legDurationMs = Math.max(1, toPositiveInt(navigation.legDurationMs, 30_000));
  if (
    routeSystemIDs.length < 2 ||
    legIndex >= routeSystemIDs.length - 1 ||
    routeSystemIDs[legIndex] !== toPositiveInt(navigation.currentSystemID, 0)
  ) {
    const blocked = {
      ...navigation,
      phase: NAVIGATION_PHASE.BLOCKED,
      arrivalAtMs: 0,
      completedAtMs: 0,
      revision: Math.max(1, toPositiveInt(navigation.revision, 1) + 1),
    };
    return {
      success: true,
      changed: true,
      data: { navigation: blocked, advancedLegs: 0, arrived: false, blocked: true },
    };
  }

  let advancedLegs = 0;
  let departureAtMs = Math.max(
    0,
    Math.trunc(Number(navigation.departureAtMs) || Number(navigation.routeStartedAtMs) || 0),
  );
  while (arrivalAtMs <= nowMs && legIndex < routeSystemIDs.length - 1) {
    legIndex += 1;
    advancedLegs += 1;
    if (legIndex >= routeSystemIDs.length - 1) break;
    departureAtMs = arrivalAtMs;
    arrivalAtMs += legDurationMs;
  }

  const arrived = legIndex >= routeSystemIDs.length - 1;
  const nextNavigation = {
    ...navigation,
    currentSystemID: routeSystemIDs[legIndex],
    legIndex,
    phase: arrived ? NAVIGATION_PHASE.ARRIVED : NAVIGATION_PHASE.IN_TRANSIT,
    departureAtMs,
    arrivalAtMs,
    completedAtMs: arrived ? arrivalAtMs : 0,
    revision: Math.max(
      1,
      toPositiveInt(navigation.revision, 1) + Math.max(1, advancedLegs),
    ),
  };
  return {
    success: true,
    changed: true,
    data: {
      navigation: nextNavigation,
      advancedLegs,
      arrived,
      currentSystemID: nextNavigation.currentSystemID,
    },
  };
}

module.exports = {
  MAX_RECENT_COMMANDS,
  NAVIGATION_PHASE,
  NAVIGATION_SCHEMA_VERSION,
  advanceNavigation,
  buildStationaryNavigation,
  initializeContractNavigation,
  inspectCommandReplay,
  isNavigationInTransit,
  normalizeCommandID,
  normalizeRecentCommands,
  planNavigation,
  resolveCurrentSystemID,
};
