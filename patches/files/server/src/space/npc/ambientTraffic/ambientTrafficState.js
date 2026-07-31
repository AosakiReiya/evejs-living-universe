const path = require("path");

const database = require(path.join(__dirname, "../../../gameStore"));

const TABLE_NAME = "npcRuntimeState";
const ROOT_PATH = "/ambientTraffic";
const SCHEMA_VERSION = 1;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildDefaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    routes: {},
  };
}

function readState() {
  const result = database.read(TABLE_NAME, ROOT_PATH);
  if (!result.success || !result.data || typeof result.data !== "object") {
    return buildDefaultState();
  }
  return {
    ...buildDefaultState(),
    ...cloneValue(result.data),
    routes:
      result.data.routes && typeof result.data.routes === "object"
        ? cloneValue(result.data.routes)
        : {},
  };
}

function writeState(state, options = {}) {
  return database.write(
    TABLE_NAME,
    ROOT_PATH,
    {
      ...buildDefaultState(),
      ...cloneValue(state || {}),
      schemaVersion: SCHEMA_VERSION,
    },
    options,
  );
}

function getRoute(routeID) {
  const normalizedRouteID = String(routeID || "").trim();
  if (!normalizedRouteID) {
    return null;
  }
  const state = readState();
  return state.routes[normalizedRouteID]
    ? cloneValue(state.routes[normalizedRouteID])
    : null;
}

function upsertRoute(routeRecord, options = {}) {
  const routeID = String(routeRecord && routeRecord.routeID || "").trim();
  if (!routeID) {
    return {
      success: false,
      errorMsg: "AMBIENT_TRAFFIC_ROUTE_ID_REQUIRED",
    };
  }
  const state = readState();
  state.routes[routeID] = cloneValue(routeRecord);
  return writeState(state, options);
}

function removeRoute(routeID) {
  const normalizedRouteID = String(routeID || "").trim();
  if (!normalizedRouteID) {
    return {
      success: false,
      errorMsg: "AMBIENT_TRAFFIC_ROUTE_ID_REQUIRED",
    };
  }
  const state = readState();
  delete state.routes[normalizedRouteID];
  return writeState(state);
}

function listRoutes() {
  return Object.values(readState().routes)
    .map((route) => cloneValue(route))
    .sort((left, right) => String(left.routeID || "").localeCompare(String(right.routeID || "")));
}

module.exports = {
  SCHEMA_VERSION,
  getRoute,
  upsertRoute,
  removeRoute,
  listRoutes,
  readState,
  writeState,
};
