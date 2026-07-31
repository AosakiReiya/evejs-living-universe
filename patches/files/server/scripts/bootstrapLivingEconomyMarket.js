"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");

const catalog = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingEconomyCatalog",
));

const REPO_ROOT = path.resolve(__dirname, "../..");
const DEFAULT_DATABASE_PATH = path.join(
  REPO_ROOT,
  "externalservices/market-server/data/generated/market.sqlite",
);
const BACKUP_ROOT = path.join(REPO_ROOT, "_local/living-economy-backups");
const THE_FORGE_REGION_ID = 10000002;

function parseArguments(argv) {
  const result = {
    apply: false,
    databasePath: DEFAULT_DATABASE_PATH,
    skipBackup: false,
    skipRegionRebuild: false,
    totalReset: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (argument === "--apply") {
      result.apply = true;
    } else if (argument === "--skip-backup") {
      result.skipBackup = true;
    } else if (argument === "--skip-region-rebuild") {
      result.skipRegionRebuild = true;
    } else if (argument === "--total-reset") {
      result.totalReset = true;
    } else if (argument === "--database" && argv[index + 1]) {
      result.databasePath = path.resolve(argv[index + 1]);
      index += 1;
    }
  }
  return result;
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function computePrice(good, station, quantity) {
  const target = Math.max(1, catalog.getTargetQuantity(station, good));
  const stockRatio = Math.max(0, Number(quantity || 0) / target);
  const multiplier = Math.max(0.8, Math.min(1.6, 1 + ((1 - stockRatio) * 0.35)));
  return Math.max(0.01, Math.round(good.priceAnchor * multiplier * 100) / 100);
}

function getPilotSystemIDs() {
  return [...new Set(catalog.STATIONS.map((station) => station.systemID))]
    .sort((left, right) => left - right);
}

function buildPlaceholders(values) {
  return values.map(() => "?").join(",");
}

function ensureAdjustmentTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seed_stock_adjustments (
      adjustment_id TEXT PRIMARY KEY,
      station_id INTEGER NOT NULL,
      solar_system_id INTEGER NOT NULL,
      region_id INTEGER NOT NULL,
      type_id INTEGER NOT NULL,
      delta_quantity INTEGER,
      quantity_after INTEGER NOT NULL,
      price_after REAL NOT NULL,
      reason TEXT,
      applied_at TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
}

function rebuildSystemSeedSummaries(db, systemIDs, updatedAt) {
  const deleteRows = db.prepare(
    `DELETE FROM system_seed_summaries WHERE solar_system_id IN (${buildPlaceholders(systemIDs)})`,
  );
  deleteRows.run(...systemIDs);
  const rebuild = db.prepare(`
    INSERT INTO system_seed_summaries (
      solar_system_id, type_id, best_ask_price, total_ask_quantity,
      best_ask_station_id, best_bid_price, total_bid_quantity,
      best_bid_station_id, updated_at
    )
    WITH type_rows AS (
      SELECT type_id FROM seed_stock
      WHERE solar_system_id = @systemID AND quantity > 0
      UNION
      SELECT type_id FROM seed_buy_orders
      WHERE solar_system_id = @systemID AND quantity > 0
    )
    SELECT
      @systemID,
      type_rows.type_id,
      (
        SELECT MIN(price) FROM seed_stock
        WHERE solar_system_id = @systemID AND type_id = type_rows.type_id AND quantity > 0
      ),
      COALESCE((
        SELECT SUM(quantity) FROM seed_stock
        WHERE solar_system_id = @systemID AND type_id = type_rows.type_id AND quantity > 0
      ), 0),
      (
        SELECT station_id FROM seed_stock
        WHERE solar_system_id = @systemID AND type_id = type_rows.type_id AND quantity > 0
        ORDER BY price ASC, station_id ASC LIMIT 1
      ),
      (
        SELECT MAX(price) FROM seed_buy_orders
        WHERE solar_system_id = @systemID AND type_id = type_rows.type_id AND quantity > 0
      ),
      COALESCE((
        SELECT SUM(quantity) FROM seed_buy_orders
        WHERE solar_system_id = @systemID AND type_id = type_rows.type_id AND quantity > 0
      ), 0),
      (
        SELECT station_id FROM seed_buy_orders
        WHERE solar_system_id = @systemID AND type_id = type_rows.type_id AND quantity > 0
        ORDER BY price DESC, station_id ASC LIMIT 1
      ),
      @updatedAt
    FROM type_rows
  `);
  for (const systemID of systemIDs) {
    rebuild.run({ systemID, updatedAt });
  }
}

function updateManifest(db, updatedAt, systemIDs, options = {}) {
  const row = db.prepare("SELECT value FROM manifest WHERE key = 'manifest_json'").get();
  if (!row || !row.value) {
    return;
  }
  const manifest = JSON.parse(row.value);
  if (options.totalReset === true) {
    manifest.generated_at = updatedAt;
    manifest.selection_label = "EveJS living economy base reset";
    manifest.selection_mode = "living_economy_base";
    manifest.seed_row_count = catalog.STATIONS.reduce((total, station) => (
      total + catalog.GOODS.filter((good) => catalog.getTargetQuantity(station, good) > 0).length
    ), 0);
    manifest.seed_buy_orders_enabled = false;
    manifest.history_days_seeded = 0;
  }
  manifest.living_economy_pilot = {
    revision: options.totalReset === true ? 2 : 1,
    applied_at: updatedAt,
    region_id: THE_FORGE_REGION_ID,
    region_ids: catalog.ECONOMY_REGION_IDS,
    system_ids: systemIDs,
    station_ids: catalog.STATIONS.map((station) => station.stationID),
    goods: catalog.GOODS.map((good) => ({
      type_id: good.typeID,
      name: good.name,
      category: good.category,
      price_anchor: good.priceAnchor,
    })),
    policy: {
      reset_scope: options.totalReset === true ? "entire-universe" : "pilot-systems",
      imported_seed_stock: options.totalReset === true
        ? "cleared-universe-wide"
        : "cleared-in-pilot-systems",
      imported_seed_buy_orders: options.totalReset === true
        ? "cleared-universe-wide"
        : "cleared-in-pilot-systems",
      market_orders: options.totalReset === true ? "cleared" : "preserved",
      market_order_events: options.totalReset === true ? "cleared" : "preserved",
      imported_price_history: options.totalReset === true ? "cleared" : "preserved",
      station_supply: "curated T1/basic targets",
      freight_conservation: "source reservation then destination delivery",
    },
  };
  db.prepare("UPDATE manifest SET value = ? WHERE key = 'manifest_json'")
    .run(JSON.stringify(manifest, null, 2));
}

function summarizeTable(db, tableName, whereClause = "", parameters = []) {
  return db.prepare(`
    SELECT COUNT(*) AS rows,
           SUM(CASE WHEN quantity > 0 THEN 1 ELSE 0 END) AS stocked_rows,
           SUM(quantity) AS quantity
    FROM ${tableName} ${whereClause}
  `).get(...parameters);
}

function buildPlan(db, options = {}) {
  const pilotSystemIDs = getPilotSystemIDs();
  const systemIDs = options.totalReset === true
    ? db.prepare("SELECT DISTINCT solar_system_id FROM stations ORDER BY solar_system_id")
      .all().map((row) => Number(row.solar_system_id))
    : pilotSystemIDs;
  const pilotStations = db.prepare(
    `SELECT station_id, solar_system_id, constellation_id, region_id, station_name
     FROM stations WHERE station_id IN (${buildPlaceholders(catalog.STATIONS)})`,
  ).all(...catalog.STATIONS.map((station) => station.stationID));
  const stationsByID = new Map(pilotStations.map((station) => [station.station_id, station]));
  const marketTypes = db.prepare(
    `SELECT type_id, name FROM market_types
     WHERE type_id IN (${buildPlaceholders(catalog.GOODS)})`,
  ).all(...catalog.GOODS.map((good) => good.typeID));
  const typesByID = new Map(marketTypes.map((entry) => [entry.type_id, entry]));

  const missingStations = catalog.STATIONS.filter((station) => !stationsByID.has(station.stationID));
  const missingTypes = catalog.GOODS.filter((good) => !typesByID.has(good.typeID));
  if (missingStations.length > 0 || missingTypes.length > 0) {
    throw new Error(
      `Pilot catalog validation failed: missing stations [${missingStations.map((entry) => entry.stationID).join(", ")}], ` +
      `missing types [${missingTypes.map((entry) => entry.typeID).join(", ")}]`,
    );
  }

  const rows = [];
  for (const station of catalog.STATIONS) {
    const metadata = stationsByID.get(station.stationID);
    for (const good of catalog.GOODS) {
      const targetQuantity = catalog.getTargetQuantity(station, good);
      if (targetQuantity <= 0) {
        continue;
      }
      const initialQuantity = catalog.getInitialQuantity(station, good);
      rows.push({
        station,
        metadata,
        good,
        targetQuantity,
        initialQuantity,
        price: computePrice(good, station, initialQuantity),
      });
    }
  }

  const whereClause = options.totalReset === true
    ? ""
    : `WHERE solar_system_id IN (${buildPlaceholders(systemIDs)})`;
  const parameters = options.totalReset === true ? [] : systemIDs;
  const before = {
    seedStock: summarizeTable(db, "seed_stock", whereClause, parameters),
    seedBuyOrders: summarizeTable(db, "seed_buy_orders", whereClause, parameters),
    marketOrders: db.prepare("SELECT COUNT(*) AS rows FROM market_orders").get(),
    marketOrderEvents: db.prepare("SELECT COUNT(*) AS rows FROM market_order_events").get(),
    priceHistory: db.prepare("SELECT COUNT(*) AS rows FROM price_history").get(),
  };
  return { systemIDs, pilotSystemIDs, rows, before };
}

function applyPlan(db, plan, options = {}) {
  const updatedAt = new Date().toISOString();
  const systemPlaceholders = buildPlaceholders(plan.systemIDs);
  const stationIDs = catalog.STATIONS.map((station) => station.stationID);
  const transaction = db.transaction(() => {
    ensureAdjustmentTable(db);
    if (options.totalReset === true) {
      db.exec(`
        DELETE FROM market_order_events;
        DELETE FROM market_orders;
        DELETE FROM price_history;
        DELETE FROM seed_stock_adjustments;
        DELETE FROM system_seed_summaries;
        DELETE FROM region_summaries;
        DELETE FROM seed_buy_orders;
        DELETE FROM seed_stock;
      `);
    } else {
      db.prepare(
        `UPDATE seed_stock SET quantity = 0, initial_quantity = 0, updated_at = ?
         WHERE solar_system_id IN (${systemPlaceholders})`,
      ).run(updatedAt, ...plan.systemIDs);
      db.prepare(
        `UPDATE seed_buy_orders SET quantity = 0, initial_quantity = 0, updated_at = ?
         WHERE solar_system_id IN (${systemPlaceholders})`,
      ).run(updatedAt, ...plan.systemIDs);
      db.prepare(
        `DELETE FROM seed_stock_adjustments WHERE station_id IN (${buildPlaceholders(stationIDs)})`,
      ).run(...stationIDs);
    }

    const upsert = db.prepare(`
      INSERT INTO seed_stock (
        station_id, solar_system_id, constellation_id, region_id, type_id,
        price, quantity, initial_quantity, price_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(station_id, type_id) DO UPDATE SET
        solar_system_id = excluded.solar_system_id,
        constellation_id = excluded.constellation_id,
        region_id = excluded.region_id,
        price = excluded.price,
        quantity = excluded.quantity,
        initial_quantity = excluded.initial_quantity,
        price_version = seed_stock.price_version + 1,
        updated_at = excluded.updated_at
    `);
    for (const row of plan.rows) {
      upsert.run(
        row.station.stationID,
        row.metadata.solar_system_id,
        row.metadata.constellation_id,
        row.metadata.region_id,
        row.good.typeID,
        row.price,
        row.initialQuantity,
        row.initialQuantity,
        updatedAt,
      );
    }
    rebuildSystemSeedSummaries(db, plan.pilotSystemIDs, updatedAt);
    updateManifest(db, updatedAt, plan.pilotSystemIDs, options);
  });
  transaction();

  const after = {
    seedStock: summarizeTable(db, "seed_stock"),
    seedBuyOrders: summarizeTable(db, "seed_buy_orders"),
    marketOrders: db.prepare("SELECT COUNT(*) AS rows FROM market_orders").get(),
    marketOrderEvents: db.prepare("SELECT COUNT(*) AS rows FROM market_order_events").get(),
    priceHistory: db.prepare("SELECT COUNT(*) AS rows FROM price_history").get(),
  };
  return { updatedAt, after };
}

function rebuildRegionSummaries(totalReset = false) {
  const executable = path.join(
    REPO_ROOT,
    "tools/market-seed/target/release/market-seed.exe",
  );
  const configPath = path.join(
    REPO_ROOT,
    "tools/market-seed/config/market-seed.local.toml",
  );
  if (!fs.existsSync(executable)) {
    return {
      success: false,
      message: "market-seed.exe is not built; rebuild region summaries before starting the market server",
    };
  }
  const argumentsList = ["--config", configPath, "rebuild-summaries"];
  if (totalReset !== true) {
    argumentsList.push("--region-id", String(THE_FORGE_REGION_ID));
  }
  const result = spawnSync(
    executable,
    argumentsList,
    {
      cwd: path.join(REPO_ROOT, "tools/market-seed"),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  return {
    success: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!fs.existsSync(options.databasePath)) {
    throw new Error(`Market database not found: ${options.databasePath}`);
  }
  const db = new Database(options.databasePath);
  db.pragma("busy_timeout = 5000");
  const plan = buildPlan(db, options);

  const report = {
    mode: options.apply ? "apply" : "dry-run",
    scope: options.totalReset === true ? "entire-universe" : "pilot-systems",
    databasePath: options.databasePath,
    resetSystems: plan.systemIDs.length,
    pilotSystems: plan.pilotSystemIDs.length,
    stations: catalog.STATIONS.length,
    goods: catalog.GOODS.length,
    curatedRows: plan.rows.length,
    before: plan.before,
  };

  if (!options.apply) {
    db.close();
    console.log(JSON.stringify(report, null, 2));
    console.log("Dry run only. Re-run with --apply while the game and market servers are stopped.");
    return;
  }

  if (!options.skipBackup) {
    const backupDirectory = path.join(BACKUP_ROOT, timestampForPath());
    fs.mkdirSync(backupDirectory, { recursive: true });
    const backupPath = path.join(backupDirectory, "market.sqlite");
    await db.backup(backupPath);
    report.backupPath = backupPath;
  }

  const applied = applyPlan(db, plan, options);
  db.close();
  report.appliedAt = applied.updatedAt;
  report.after = applied.after;

  // Freight job IDs restart at LEF-000001 after a pilot bootstrap. Remove the
  // matching Node-side ledger while the game server is offline.
  if (path.resolve(options.databasePath) === path.resolve(DEFAULT_DATABASE_PATH)) {
    try {
      const economyState = require(path.join(
        __dirname,
        "../src/space/npc/ambientTraffic/livingEconomyState",
      ));
      report.economyStateReset = Boolean(economyState.removeState().success);
    } catch (error) {
      report.economyStateReset = false;
      report.economyStateResetError = error.message;
    }
  } else {
    report.economyStateReset = "skipped-for-nondefault-database";
  }

  if (!options.skipRegionRebuild) {
    report.regionSummaryRebuild = rebuildRegionSummaries(options.totalReset);
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
