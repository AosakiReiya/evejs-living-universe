"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const TOPOLOGY_REVISION = 1;
const TOPOLOGY_MANIFEST_KEY = "living_economy_station_topology";

function requirePositiveInteger(value, label) {
  const numericValue = Number(value);
  if (!Number.isSafeInteger(numericValue) || numericValue <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return numericValue;
}

function readJson(filePath, label) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${label} at ${filePath}: ${error.message}`);
  }
  return parsed;
}

function loadStationTopology(staticDataDir) {
  const stationsPath = path.join(staticDataDir, "stations", "data.json");
  const systemsPath = path.join(staticDataDir, "solarSystems", "data.json");
  const stationFile = readJson(stationsPath, "station authority");
  const systemFile = readJson(systemsPath, "solar-system authority");
  const rawStations = Array.isArray(stationFile && stationFile.stations)
    ? stationFile.stations
    : [];
  const rawSystems = Array.isArray(systemFile && systemFile.solarSystems)
    ? systemFile.solarSystems
    : [];
  if (rawStations.length <= 0 || rawSystems.length <= 0) {
    throw new Error("station topology authority is empty");
  }

  const regionsByID = new Map();
  const stations = rawStations.map((row, index) => {
    const station = {
      stationID: requirePositiveInteger(row.stationID, `stations[${index}].stationID`),
      solarSystemID: requirePositiveInteger(
        row.solarSystemID,
        `stations[${index}].solarSystemID`,
      ),
      constellationID: requirePositiveInteger(
        row.constellationID,
        `stations[${index}].constellationID`,
      ),
      regionID: requirePositiveInteger(row.regionID, `stations[${index}].regionID`),
      stationName: String(row.stationName || `Station ${row.stationID}`),
      security: Number.isFinite(Number(row.security)) ? Number(row.security) : 0,
    };
    if (!regionsByID.has(station.regionID)) {
      regionsByID.set(station.regionID, {
        regionID: station.regionID,
        regionName: String(row.regionName || `Region ${station.regionID}`),
      });
    }
    return station;
  });
  const requiredSystemIDs = new Set(
    stations.map((station) => station.solarSystemID),
  );
  const systems = rawSystems
    .map((row, index) => ({
      solarSystemID: requirePositiveInteger(
        row.solarSystemID,
        `solarSystems[${index}].solarSystemID`,
      ),
      regionID: requirePositiveInteger(row.regionID, `solarSystems[${index}].regionID`),
      constellationID: requirePositiveInteger(
        row.constellationID,
        `solarSystems[${index}].constellationID`,
      ),
      solarSystemName: String(
        row.solarSystemName || `System ${row.solarSystemID}`,
      ),
      security: Number.isFinite(Number(row.security)) ? Number(row.security) : 0,
    }))
    .filter((system) => requiredSystemIDs.has(system.solarSystemID));
  const availableSystemIDs = new Set(
    systems.map((system) => system.solarSystemID),
  );
  const missingSystem = stations.find(
    (station) => !availableSystemIDs.has(station.solarSystemID),
  );
  if (missingSystem) {
    throw new Error(
      `station ${missingSystem.stationID} references missing system ` +
      `${missingSystem.solarSystemID}`,
    );
  }

  return {
    regions: [...regionsByID.values()].sort((left, right) => (
      left.regionID - right.regionID
    )),
    systems: systems.sort((left, right) => (
      left.solarSystemID - right.solarSystemID
    )),
    stations: stations.sort((left, right) => left.stationID - right.stationID),
  };
}

function assertMarketDatabase(db) {
  const requiredTables = [
    "manifest",
    "regions",
    "solar_systems",
    "stations",
    "seed_stock",
    "market_orders",
  ];
  const tableExists = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  for (const tableName of requiredTables) {
    if (!tableExists.get(tableName)) {
      throw new Error(`market database is missing required table ${tableName}`);
    }
  }
}

function synchronizeMarketTopology({ databasePath, staticDataDir }) {
  const resolvedDatabasePath = path.resolve(databasePath);
  const resolvedStaticDataDir = path.resolve(staticDataDir);
  const topology = loadStationTopology(resolvedStaticDataDir);
  const db = new Database(resolvedDatabasePath, {
    fileMustExist: true,
    timeout: 10_000,
  });
  try {
    assertMarketDatabase(db);
    const insertRegion = db.prepare(
      "INSERT OR IGNORE INTO regions (region_id, region_name) VALUES (?, ?)",
    );
    const insertSystem = db.prepare(
      `INSERT OR IGNORE INTO solar_systems (
         solar_system_id, region_id, constellation_id, solar_system_name, security
       ) VALUES (?, ?, ?, ?, ?)`,
    );
    const insertStation = db.prepare(
      `INSERT OR IGNORE INTO stations (
         station_id, solar_system_id, constellation_id, region_id,
         station_name, security
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const writeRevision = db.prepare(
      "INSERT OR REPLACE INTO manifest (key, value) VALUES (?, ?)",
    );
    const apply = db.transaction(() => {
      let regionsCreated = 0;
      let systemsCreated = 0;
      let stationsCreated = 0;
      for (const region of topology.regions) {
        regionsCreated += insertRegion.run(
          region.regionID,
          region.regionName,
        ).changes;
      }
      for (const system of topology.systems) {
        systemsCreated += insertSystem.run(
          system.solarSystemID,
          system.regionID,
          system.constellationID,
          system.solarSystemName,
          system.security,
        ).changes;
      }
      for (const station of topology.stations) {
        stationsCreated += insertStation.run(
          station.stationID,
          station.solarSystemID,
          station.constellationID,
          station.regionID,
          station.stationName,
          station.security,
        ).changes;
      }
      const synchronizedAt = new Date().toISOString();
      writeRevision.run(TOPOLOGY_MANIFEST_KEY, JSON.stringify({
        revision: TOPOLOGY_REVISION,
        regionCount: topology.regions.length,
        solarSystemCount: topology.systems.length,
        stationCount: topology.stations.length,
        synchronizedAt,
      }));
      return {
        revision: TOPOLOGY_REVISION,
        regions: topology.regions.length,
        systems: topology.systems.length,
        stations: topology.stations.length,
        regionsCreated,
        systemsCreated,
        stationsCreated,
        synchronizedAt,
      };
    });
    return {
      databasePath: resolvedDatabasePath,
      ...apply.immediate(),
    };
  } finally {
    db.close();
  }
}

function parseArguments(argv) {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const result = {
    databasePath: path.join(
      repoRoot,
      "externalservices",
      "market-server",
      "data",
      "generated",
      "market.sqlite",
    ),
    staticDataDir: path.join(repoRoot, "_local", "gameStore", "data"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--database" && argv[index + 1]) {
      result.databasePath = argv[index + 1];
      index += 1;
    } else if (argv[index] === "--static-data" && argv[index + 1]) {
      result.staticDataDir = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown or incomplete argument: ${argv[index]}`);
    }
  }
  return result;
}

if (require.main === module) {
  try {
    const result = synchronizeMarketTopology(parseArguments(process.argv.slice(2)));
    if (
      result.regionsCreated > 0 ||
      result.systemsCreated > 0 ||
      result.stationsCreated > 0
    ) {
      console.log(
        `[LivingEconomy] Added ${result.stationsCreated} missing market ` +
        `station records (${result.systemsCreated} systems, ` +
        `${result.regionsCreated} regions).`,
      );
    }
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  TOPOLOGY_MANIFEST_KEY,
  TOPOLOGY_REVISION,
  loadStationTopology,
  synchronizeMarketTopology,
};
