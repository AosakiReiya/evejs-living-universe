const assert = require("assert/strict");

const config = require("../src/config");
const npcData = require("../src/space/npc/npcData");
const {
  validateNpcHardwareDefinition,
} = require("../src/space/npc/npcHardwareCatalog");
const trafficRuntime = require("../src/space/npc/ambientTraffic/ambientTrafficRuntime");
const spaceRuntime = require("../src/space/runtime");

const routeResult = trafficRuntime._testing.resolveConfiguredRouteDefinition();
assert.equal(routeResult.success, true, routeResult.errorMsg || "route must validate");
assert.ok(routeResult.data.systemIDs.length >= 2, "route must contain at least two systems");
assert.equal(
  routeResult.data.edges.length,
  routeResult.data.systemIDs.length - 1,
  "every route hop must have a reciprocal stargate edge",
);
assert.equal(
  routeResult.data.originStation.solarSystemID,
  routeResult.data.systemIDs[0],
  "origin station must be in the first system",
);
assert.equal(
  routeResult.data.destinationStation.solarSystemID,
  routeResult.data.systemIDs[routeResult.data.systemIDs.length - 1],
  "destination station must be in the final system",
);

for (const profileID of [
  "ambient_caldari_state_hauler",
  "ambient_caldari_convoy_escort",
]) {
  const definition = npcData.buildNpcDefinition(profileID);
  assert.ok(definition, `${profileID} must resolve to a complete NPC definition`);
  assert.equal(definition.profile.entityType, "npc");
  assert.equal(definition.behaviorProfile.autoAggro, false);
  assert.equal(definition.behaviorProfile.autoActivateWeapons, false);
  const hardwareValidation = validateNpcHardwareDefinition(definition);
  assert.equal(
    hardwareValidation.success,
    true,
    `${profileID} hardware must validate: ${hardwareValidation.errorMsg || "unknown"}`,
  );
}

const group = npcData.getNpcSpawnGroup("ambient_caldari_logistics_convoy");
assert.ok(group, "ambient convoy spawn group must resolve");
assert.equal(
  group.entries.reduce((total, entry) => total + Number(entry.count || 0), 0),
  3,
  "pilot convoy must contain one hauler and two escorts",
);
assert.equal(
  config.npcDefaultConcordGateAutoAggroNpcsEnabled,
  false,
  "generic CONCORD NPC auto-aggression must remain disabled for civilian traffic safety",
);

const playerUndockPoint = { x: 10_000, y: 20_000, z: 30_000 };
const playerUndockDirection = { x: 1, y: 0, z: 0 };
const stationDepartureStates = trafficRuntime._testing.buildStationDepartureSpawnStates(
  {
    getStationUndockSpawnState(station, options) {
      assert.equal(station.stationID, routeResult.data.originStation.stationID);
      assert.equal(options.shipTypeID, 10826, "lead must use the hauler's player-undock locator");
      assert.equal(options.selectionStrategy, "first", "NPC traffic must match station player-undock selection");
      return {
        position: playerUndockPoint,
        direction: playerUndockDirection,
      };
    },
  },
  routeResult.data.originStation,
  routeResult.data.routeID,
);
assert.equal(stationDepartureStates.length, 3, "undock formation must define all three ships");
assert.deepEqual(
  stationDepartureStates[0].position,
  playerUndockPoint,
  "hauler must occupy the real player-undock point",
);
for (const state of stationDepartureStates) {
  assert.deepEqual(state.direction, playerUndockDirection, "convoy must face down the undock vector");
  assert.equal(state.mode, "STOP");
}
const escortSeparation = Math.hypot(
  stationDepartureStates[1].position.x - stationDepartureStates[2].position.x,
  stationDepartureStates[1].position.y - stationDepartureStates[2].position.y,
  stationDepartureStates[1].position.z - stationDepartureStates[2].position.z,
);
assert.ok(
  escortSeparation >= 2_000 && escortSeparation <= 3_000,
  `escort spacing must remain a tight visible formation, got ${escortSeparation}m`,
);

assert.equal(
  typeof spaceRuntime.gotoDynamicEntityPoint,
  "function",
  "space runtime must expose player-parity subwarp coordinate movement for NPC ships",
);
assert.equal(config.ambientTrafficPoweredUndockMinimumSeconds, 15);
assert.equal(config.ambientTrafficPoweredUndockClearanceMeters, 5000);
assert.equal(config.ambientTrafficPoweredUndockMaximumSeconds, 45);

const slowHaulerEnvelope = trafficRuntime._testing.buildPoweredUndockEnvelope({
  maxVelocity: 200,
  alignTime: 141.4,
});
assert.ok(
  slowHaulerEnvelope.clearanceMeters >= 40_000,
  `slow hauler must receive turn-arc station clearance, got ${slowHaulerEnvelope.clearanceMeters}m`,
);
assert.ok(
  slowHaulerEnvelope.maximumDurationMs > 300_000,
  "powered-undock timeout must expand far beyond the 45-second base for a 141-second-align hauler",
);

const movementScene = {
  getEntityByID(entityID) {
    return entityID === 101
      ? { itemID: 101, position: { x: 6_000, y: 0, z: 0 } }
      : null;
  },
};
const poweredRoute = {
  currentSystemID: 30000142,
  entityIDs: [101],
  leadEntityID: 101,
  poweredUndock: {
    startedAtMs: 1_000,
    origin: { x: 0, y: 0, z: 0 },
    minimumDurationMs: 15_000,
    maximumDurationMs: 45_000,
    clearanceMeters: 5_000,
  },
};
assert.equal(
  trafficRuntime._testing.hasPoweredUndockCleared(
    { scenes: new Map([[30000142, movementScene]]) },
    poweredRoute,
    16_000,
  ),
  true,
  "hauler must clear the configured distance under engine power before alignment",
);
assert.equal(
  trafficRuntime._testing.hasPoweredUndockTimedOut(poweredRoute, 46_000),
  true,
  "an obstructed powered departure must time out instead of being forced into an unsafe turn",
);

const naturalWarpOrders = trafficRuntime._testing.buildNaturalWarpOrders(
  [
    { itemID: 101, alignTime: 10 },
    { itemID: 102, alignTime: 3 },
    { itemID: 103, alignTime: 3 },
  ],
  {
    itemID: 50013921,
    position: { x: 1_000_000, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    radius: 3_500,
  },
  20_000,
);
assert.equal(naturalWarpOrders.orders.length, 3);
assert.ok(
  naturalWarpOrders.orders[0].issueAtMs < naturalWarpOrders.orders[1].issueAtMs,
  "slower hauler must receive its natural align command before faster escorts",
);
assert.equal(
  naturalWarpOrders.orders[0].issueAtMs + naturalWarpOrders.orders[0].alignDurationMs,
  naturalWarpOrders.orders[1].issueAtMs + naturalWarpOrders.orders[1].alignDurationMs,
  "align-time staging must target the same fleet warp release",
);

console.log(
  `Ambient traffic pilot verified: ${routeResult.data.systems
    .map((system) => system.solarSystemName)
    .join(" -> ")} (${group.entries.length} ship roles, 3 ships per convoy).`,
);
