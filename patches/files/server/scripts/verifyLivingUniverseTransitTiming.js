"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";

const assert = require("assert/strict");

const livingUniverseRuntime = require(
  "../src/space/npc/ambientTraffic/livingUniverseRuntime",
);

function seconds(milliseconds) {
  return Math.round(Number(milliseconds || 0) / 100) / 10;
}

function summarizeEstimate(estimate) {
  return {
    routeID: estimate.routeID,
    totalSeconds: seconds(estimate.totalMs),
    legs: estimate.legs.map((leg) => ({
      kind: leg.kind,
      seconds: seconds(leg.totalMs),
      distanceAU: leg.distanceAU === undefined
        ? undefined
        : Math.round(leg.distanceAU * 100) / 100,
      undockSeconds: leg.poweredUndockMs === undefined
        ? undefined
        : seconds(leg.poweredUndockMs),
      alignSeconds: leg.alignMs === undefined ? undefined : seconds(leg.alignMs),
      warpSeconds: leg.warpMs === undefined ? undefined : seconds(leg.warpMs),
    })),
  };
}

function findFreighter(state, excludedFlightID = null) {
  return Object.values(state.flights).find((flight) => (
    (flight.family === "hauler" || flight.family === "convoy") &&
    flight.flightID !== excludedFlightID
  ));
}

function main() {
  const now = 1_700_000_000_000;
  const state = livingUniverseRuntime._testing.buildPopulationPlan(400, now);
  livingUniverseRuntime._testing.setRuntimeStateForTest(state);

  const perimeterFlight = findFreighter(state);
  const tamaFlight = findFreighter(state, perimeterFlight && perimeterFlight.flightID);
  assert.ok(perimeterFlight, "Jita-Perimeter freighter is missing");
  assert.ok(tamaFlight, "Jita-Tama freighter is missing");
  perimeterFlight.routeID = "jita_perimeter";
  tamaFlight.routeID = "jita_tama";
  perimeterFlight.direction = 1;
  tamaFlight.direction = 1;

  const perimeterRoute = livingUniverseRuntime._testing.getRouteDefinition("jita_perimeter");
  const tamaRoute = livingUniverseRuntime._testing.getRouteDefinition("jita_tama");
  const perimeterEstimate = livingUniverseRuntime._testing.estimateNetworkTrip(
    perimeterRoute,
    perimeterFlight,
  );
  const tamaEstimate = livingUniverseRuntime._testing.estimateNetworkTrip(
    tamaRoute,
    tamaFlight,
  );
  assert.ok(perimeterEstimate.totalMs >= 180_000, "one-jump freight is still compressed");
  assert.ok(tamaEstimate.totalMs >= 420_000, "Jita-Tama freight is still compressed");
  assert.ok(tamaEstimate.totalMs > perimeterEstimate.totalMs * 2);

  perimeterFlight.currentNodeIndex = 0;
  perimeterFlight.currentSystemID = perimeterRoute.systemIDs[0];
  perimeterFlight.direction = 1;
  const perimeterActors = perimeterFlight.actorIDs.map((actorID) => state.actors[actorID]);
  for (const actor of perimeterActors) {
    actor.currentSystemID = perimeterRoute.systemIDs[0];
  }
  const departure = livingUniverseRuntime._testing.scheduleVirtualDeparture(
    perimeterRoute,
    perimeterFlight,
    now,
    "transit-verifier-departure",
  );
  assert.equal(perimeterFlight.phase, livingUniverseRuntime.PHASE.VIRTUAL_DEPARTURE);
  assert.ok(departure.poweredUndockMs > 45_000);
  assert.ok(perimeterActors.every(
    (actor) => actor.currentSystemID === perimeterRoute.systemIDs[0],
  ), "pilots should remain in source Local during undock, align, and warp-to-gate");

  const runtimeWithoutObservers = { scenes: new Map() };
  livingUniverseRuntime._testing.tickVirtual(
    runtimeWithoutObservers,
    perimeterRoute,
    perimeterFlight,
    perimeterFlight.nextTransitionAtMs,
  );
  assert.equal(perimeterFlight.phase, livingUniverseRuntime.PHASE.VIRTUAL_TRANSIT);
  assert.ok(perimeterActors.every(
    (actor) => actor.currentSystemID === perimeterRoute.systemIDs[1],
  ), "pilots should move to destination Local at the stargate system transition");
  const gateTransit = perimeterFlight.virtualTravel.durationMs;
  livingUniverseRuntime._testing.tickVirtual(
    runtimeWithoutObservers,
    perimeterRoute,
    perimeterFlight,
    perimeterFlight.nextTransitionAtMs,
  );
  assert.equal(perimeterFlight.phase, livingUniverseRuntime.PHASE.VIRTUAL_STATION_APPROACH);
  const stationApproach = perimeterFlight.virtualTravel.durationMs;
  assert.ok(Math.abs(
    (departure.durationMs + gateTransit + stationApproach) - perimeterEstimate.totalMs,
  ) <= 2);
  livingUniverseRuntime._testing.tickVirtual(
    runtimeWithoutObservers,
    perimeterRoute,
    perimeterFlight,
    perimeterFlight.nextTransitionAtMs,
  );
  assert.equal(perimeterFlight.phase, livingUniverseRuntime.PHASE.DOCKED);

  console.log(JSON.stringify({
    success: true,
    model: "hull align + powered undock + AU warp profile + gate/arrival dwell",
    perimeter: summarizeEstimate(perimeterEstimate),
    tama: summarizeEstimate(tamaEstimate),
    virtualPhaseParity: {
      departureSeconds: seconds(departure.durationMs),
      gateTransitSeconds: seconds(gateTransit),
      stationApproachSeconds: seconds(stationApproach),
      deliveredOnlyAfterAllPhases: true,
      localMovesAtGateTransition: true,
    },
  }, null, 2));
}

main();
