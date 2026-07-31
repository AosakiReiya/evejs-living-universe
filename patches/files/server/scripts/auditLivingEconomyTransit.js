"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";

const path = require("path");

const economyStateStore = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingEconomyState",
));
const universeStateStore = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingUniverseState",
));
const livingUniverseRuntime = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingUniverseRuntime",
));

function seconds(milliseconds) {
  return Math.round(Number(milliseconds || 0) / 100) / 10;
}

function main() {
  const economy = economyStateStore.readState();
  const universe = universeStateStore.readState();
  livingUniverseRuntime._testing.setRuntimeStateForTest(universe);

  const rows = [];
  const skipped = [];
  for (const job of Object.values(economy.jobs || {}).filter(
    (candidate) => candidate.status === "delivered",
  )) {
    const route = livingUniverseRuntime._testing.getRouteDefinition(job.routeID);
    const flight = universe.flights && universe.flights[job.assignedFlightID];
    if (!route || !flight || !job.arrivedAtMs || !job.createdAtMs) {
      skipped.push(job.jobID);
      continue;
    }
    const direction = Number(job.sourceStationID) === Number(route.endpointStationIDs[0])
      ? 1
      : -1;
    const estimate = livingUniverseRuntime._testing.estimateNetworkTrip(
      route,
      { ...flight, direction },
    );
    const travelMs = Number(job.arrivedAtMs) - Number(job.createdAtMs);
    const commitMs = Number(job.completedAtMs || job.arrivedAtMs) - Number(job.arrivedAtMs);
    rows.push({
      jobID: job.jobID,
      routeID: job.routeID,
      travelSeconds: seconds(travelMs),
      modeledSeconds: seconds(estimate.totalMs),
      schedulerSlackSeconds: seconds(travelMs - estimate.totalMs),
      deliveryCommitSeconds: seconds(commitMs),
      notEarly: travelMs + 2 >= estimate.totalMs,
    });
  }

  const violations = rows.filter((row) => !row.notEarly);
  console.log(JSON.stringify({
    auditedAt: new Date().toISOString(),
    deliveredJobsChecked: rows.length,
    skippedJobs: skipped,
    earlyArrivalViolations: violations.length,
    minimumSchedulerSlackSeconds: rows.length
      ? Math.min(...rows.map((row) => row.schedulerSlackSeconds))
      : null,
    maximumSchedulerSlackSeconds: rows.length
      ? Math.max(...rows.map((row) => row.schedulerSlackSeconds))
      : null,
    routes: [...new Set(rows.map((row) => row.routeID))].sort(),
    sample: rows.slice(0, 20),
  }, null, 2));

  if (violations.length > 0 || skipped.length > 0) {
    process.exitCode = 1;
  }
}

main();
