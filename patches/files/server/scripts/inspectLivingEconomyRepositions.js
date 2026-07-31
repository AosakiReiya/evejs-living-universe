"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const databasePath = path.resolve(
  process.argv[2] ||
    path.join(__dirname, "../../_local/gameStore/gamestore.sqlite"),
);
const db = new Database(databasePath, {
  readonly: true,
  fileMustExist: true,
});

try {
  const rows = db.prepare(
    "SELECT key, json FROM npcRuntimeState WHERE json LIKE ?",
  ).all("%freightReposition%");
  const flights = [];
  const recentlyClosed = [];
  for (const row of rows) {
    let flight = null;
    try {
      flight = JSON.parse(row.json);
    } catch {
      continue;
    }
    if (!flight) continue;
    const summary = {
      key: row.key,
      flightID: flight.flightID,
      phase: flight.phase,
      freightJobID: flight.freightJobID || null,
      currentSystemID: flight.currentSystemID,
      currentNodeIndex: flight.currentNodeIndex,
      direction: flight.direction,
      nextTransitionAtMs: flight.nextTransitionAtMs,
    };
    if (flight.freightReposition) {
      flights.push({
        ...summary,
        reposition: flight.freightReposition,
      });
    }
    if (flight.lastFreightReposition) {
      recentlyClosed.push({
        ...summary,
        reposition: flight.lastFreightReposition,
        cooldownUntilMs: flight.freightRepositionCooldownUntilMs || 0,
      });
    }
  }
  flights.sort(
    (left, right) =>
      Number(left.reposition.assignedAtMs) -
        Number(right.reposition.assignedAtMs) ||
      String(left.flightID).localeCompare(String(right.flightID)),
  );
  recentlyClosed.sort(
    (left, right) =>
      Number(right.reposition.closedAtMs) -
        Number(left.reposition.closedAtMs) ||
      String(left.flightID).localeCompare(String(right.flightID)),
  );
  console.log(JSON.stringify({
    success: true,
    databasePath,
    inspectedAtMs: Date.now(),
    count: flights.length,
    flights,
    recentlyClosed: recentlyClosed.slice(0, 32),
  }, null, 2));
} finally {
  db.close();
}
