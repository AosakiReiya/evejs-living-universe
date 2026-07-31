"use strict";

const path = require("path");

const { marketDaemonClient } = require(path.join(
  __dirname,
  "../src/services/market/marketDaemonClient",
));
const catalog = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingEconomyCatalog",
));
const economyStateStore = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingEconomyState",
));
const universeStateStore = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingUniverseState",
));

function countBy(rows, selector) {
  const counts = {};
  for (const row of rows) {
    const key = String(selector(row) || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function stockKey(stationID, typeID) {
  return `${Number(stationID)}:${Number(typeID)}`;
}

async function main() {
  const economy = economyStateStore.readState();
  const universe = universeStateStore.readState();
  const jobs = Object.values(economy.jobs || {});
  const flights = Object.values(universe.flights || {});
  const flightsByID = new Map(flights.map((flight) => [flight.flightID, flight]));
  const actors = Object.values(universe.actors || {});
  const stockKeys = catalog.STATIONS.flatMap((station) =>
    catalog.GOODS.map((good) => ({
      station_id: station.stationID,
      type_id: good.typeID,
    })),
  );
  const stockRows = [];
  for (let index = 0; index < stockKeys.length; index += 4_000) {
    const rows = await marketDaemonClient.call("GetSeedStocks", {
      keys: stockKeys.slice(index, index + 4_000),
    });
    if (Array.isArray(rows)) stockRows.push(...rows);
  }
  const stocks = new Map(
    stockRows.map((row) => [stockKey(row.station_id, row.type_id), row]),
  );
  const stations = catalog.STATIONS.map((station) => {
    let targetTypes = 0;
    let stockedTypes = 0;
    let targetUnits = 0;
    let filledTargetUnits = 0;
    let actualUnits = 0;
    for (const good of catalog.GOODS) {
      const target = catalog.getTargetQuantity(station, good);
      if (target <= 0) {
        continue;
      }
      const quantity = Math.max(
        0,
        Number(stocks.get(stockKey(station.stationID, good.typeID))?.quantity || 0),
      );
      targetTypes += 1;
      targetUnits += target;
      actualUnits += quantity;
      filledTargetUnits += Math.min(target, quantity);
      if (quantity > 0) {
        stockedTypes += 1;
      }
    }
    return {
      stationID: station.stationID,
      station: station.name,
      archetype: station.archetype,
      stockedTypes,
      targetTypes,
      targetFillPercent: targetUnits > 0
        ? Math.round((filledTargetUnits / targetUnits) * 1_000) / 10
        : 0,
      actualUnits,
    };
  });
  const activeJobs = jobs
    .filter((job) => ["reserving", "in_transit", "delivery_pending"].includes(job.status))
    .sort((left, right) => Number(left.createdAtMs || 0) - Number(right.createdAtMs || 0));
  const telemetry = economy.telemetry && typeof economy.telemetry === "object"
    ? economy.telemetry
    : { intervalMs: 600_000, snapshots: [] };
  const latestTelemetry = Array.isArray(telemetry.snapshots) && telemetry.snapshots.length > 0
    ? telemetry.snapshots[telemetry.snapshots.length - 1]
    : null;

  console.log(JSON.stringify({
    inspectedAt: new Date().toISOString(),
    economy: {
      createdAt: economy.createdAtMs ? new Date(economy.createdAtMs).toISOString() : null,
      lastPulseAt: economy.lastPulseAtMs
        ? new Date(economy.lastPulseAtMs).toISOString()
        : null,
      jobsTotal: jobs.length,
      activeJobs: activeJobs.length,
      jobStatuses: countBy(jobs, (job) => job.status),
      metrics: economy.metrics,
      telemetry: {
        intervalMinutes: Number(telemetry.intervalMs || 0) / 60_000,
        retainedSnapshots: Array.isArray(telemetry.snapshots) ? telemetry.snapshots.length : 0,
        latest: latestTelemetry,
      },
      recentEvents: (economy.events || []).slice(-20),
    },
    population: {
      actors: actors.length,
      flights: flights.length,
      actorRoles: countBy(actors, (actor) => actor.role),
      flightPhases: countBy(flights, (flight) => flight.phase),
      assignedFreightFlights: flights.filter((flight) => flight.freightJobID).length,
      materializedFlights: flights.filter((flight) => flight.materialized).length,
    },
    activeFreight: activeJobs.slice(0, 20).map((job) => {
      const flight = flightsByID.get(job.assignedFlightID) || null;
      const phaseArrivesAtMs = Number(flight && flight.nextTransitionAtMs || 0);
      return {
        jobID: job.jobID,
        status: job.status,
        item: job.typeName,
        quantity: job.quantity,
        purchaseUnitPrice: job.purchaseUnitPrice || null,
        purchaseValue: job.purchaseValue || null,
        saleUnitPrice: job.saleUnitPrice || null,
        saleValue: job.saleValue || null,
        grossMargin: job.grossMargin || null,
        sourceStationID: job.sourceStationID,
        destinationStationID: job.destinationStationID,
        flightID: job.assignedFlightID,
        currentSystemID: flight ? flight.currentSystemID : null,
        flightPhase: flight ? flight.phase : null,
        phaseArrivesAt: phaseArrivesAtMs
          ? new Date(phaseArrivesAtMs).toISOString()
          : null,
        phaseRemainingSeconds: phaseArrivesAtMs
          ? Math.max(0, Math.round((phaseArrivesAtMs - Date.now()) / 100) / 10)
          : null,
        virtualTravel: flight ? flight.virtualTravel || null : null,
      };
    }),
    stations,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    if (marketDaemonClient._socket) {
      marketDaemonClient._backgroundReconnectEnabled = false;
      marketDaemonClient._socket.destroy();
    }
  });
