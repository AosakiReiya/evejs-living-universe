"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("../node_modules/better-sqlite3");
const {
  TOPOLOGY_MANIFEST_KEY,
  TOPOLOGY_REVISION,
  synchronizeMarketTopology,
} = require("./syncLivingEconomyMarketTopology");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value), "utf8");
}

function main() {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-market-topology-"));
  const databasePath = path.join(testRoot, "market.sqlite");
  const staticDataDir = path.join(testRoot, "static");
  try {
    writeJson(path.join(staticDataDir, "stations", "data.json"), {
      stations: [
        {
          stationID: 60_000_001,
          solarSystemID: 30_000_001,
          constellationID: 20_000_001,
          regionID: 10_000_001,
          regionName: "Existing Region",
          stationName: "Authority Existing Station",
          security: 0.9,
        },
        {
          stationID: 60_000_002,
          solarSystemID: 30_000_002,
          constellationID: 20_000_002,
          regionID: 10_000_002,
          regionName: "Regional Authority",
          stationName: "Regional Hub",
          security: 0.5,
        },
      ],
    });
    writeJson(path.join(staticDataDir, "solarSystems", "data.json"), {
      solarSystems: [
        {
          solarSystemID: 30_000_001,
          constellationID: 20_000_001,
          regionID: 10_000_001,
          solarSystemName: "Existing System",
          security: 0.9,
        },
        {
          solarSystemID: 30_000_002,
          constellationID: 20_000_002,
          regionID: 10_000_002,
          solarSystemName: "Regional System",
          security: 0.5,
        },
      ],
    });

    const db = new Database(databasePath);
    db.exec(`
      CREATE TABLE manifest (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE regions (region_id INTEGER PRIMARY KEY, region_name TEXT NOT NULL);
      CREATE TABLE solar_systems (
        solar_system_id INTEGER PRIMARY KEY,
        region_id INTEGER NOT NULL,
        constellation_id INTEGER NOT NULL,
        solar_system_name TEXT NOT NULL,
        security REAL NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE stations (
        station_id INTEGER PRIMARY KEY,
        solar_system_id INTEGER NOT NULL,
        constellation_id INTEGER NOT NULL,
        region_id INTEGER NOT NULL,
        station_name TEXT NOT NULL,
        security REAL NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE seed_stock (
        station_id INTEGER NOT NULL,
        type_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        PRIMARY KEY (station_id, type_id)
      ) WITHOUT ROWID;
      CREATE TABLE market_orders (order_id INTEGER PRIMARY KEY, marker TEXT NOT NULL);
      CREATE TABLE price_history (history_id INTEGER PRIMARY KEY, marker TEXT NOT NULL);
      INSERT INTO regions VALUES (10000001, 'Preserved Region');
      INSERT INTO solar_systems VALUES (
        30000001, 10000001, 20000001, 'Preserved System', 0.7
      );
      INSERT INTO stations VALUES (
        60000001, 30000001, 20000001, 10000001, 'Preserved Station', 0.7
      );
      INSERT INTO seed_stock VALUES (60000001, 34, 0);
      INSERT INTO market_orders VALUES (42, 'player-order-preserved');
      INSERT INTO price_history VALUES (7, 'history-preserved');
    `);
    db.close();

    const first = synchronizeMarketTopology({ databasePath, staticDataDir });
    assert.deepStrictEqual({
      regionsCreated: first.regionsCreated,
      systemsCreated: first.systemsCreated,
      stationsCreated: first.stationsCreated,
    }, {
      regionsCreated: 1,
      systemsCreated: 1,
      stationsCreated: 1,
    });

    const verified = new Database(databasePath, { readonly: true });
    const existingStation = verified.prepare(
      "SELECT station_name, security FROM stations WHERE station_id = ?",
    ).get(60_000_001);
    const regionalStation = verified.prepare(
      "SELECT station_name FROM stations WHERE station_id = ?",
    ).get(60_000_002);
    const depleted = verified.prepare(
      "SELECT quantity FROM seed_stock WHERE station_id = ? AND type_id = ?",
    ).get(60_000_001, 34);
    const playerOrder = verified.prepare(
      "SELECT marker FROM market_orders WHERE order_id = ?",
    ).get(42);
    const history = verified.prepare(
      "SELECT marker FROM price_history WHERE history_id = ?",
    ).get(7);
    const revision = JSON.parse(verified.prepare(
      "SELECT value FROM manifest WHERE key = ?",
    ).get(TOPOLOGY_MANIFEST_KEY).value);
    verified.close();

    assert.deepStrictEqual(existingStation, {
      station_name: "Preserved Station",
      security: 0.7,
    });
    assert.deepStrictEqual(regionalStation, {
      station_name: "Regional Hub",
    });
    assert.strictEqual(depleted.quantity, 0);
    assert.strictEqual(playerOrder.marker, "player-order-preserved");
    assert.strictEqual(history.marker, "history-preserved");
    assert.strictEqual(revision.revision, TOPOLOGY_REVISION);
    assert.strictEqual(revision.stationCount, 2);

    const second = synchronizeMarketTopology({ databasePath, staticDataDir });
    assert.strictEqual(second.regionsCreated, 0);
    assert.strictEqual(second.systemsCreated, 0);
    assert.strictEqual(second.stationsCreated, 0);

    console.log(JSON.stringify({
      ok: true,
      missingTopologyAdded: true,
      existingTopologyPreserved: true,
      depletedStockPreserved: true,
      playerOrdersPreserved: true,
      marketHistoryPreserved: true,
      idempotent: true,
    }, null, 2));
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
