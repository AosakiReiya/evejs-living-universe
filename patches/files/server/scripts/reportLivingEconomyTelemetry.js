"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

function parseArgs(argv) {
  const options = { format: "text", limit: 144, output: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || "");
    if (value === "--json") {
      options.format = "json";
    } else if (value === "--csv") {
      options.format = "csv";
    } else if (value === "--limit" && argv[index + 1]) {
      options.limit = Math.max(1, Number(argv[++index]) || options.limit);
    } else if (value.startsWith("--limit=")) {
      options.limit = Math.max(1, Number(value.slice(8)) || options.limit);
    } else if (value === "--output" && argv[index + 1]) {
      options.output = path.resolve(argv[++index]);
    } else if (value.startsWith("--output=")) {
      options.output = path.resolve(value.slice(9));
    }
  }
  return options;
}

function readEconomyState() {
  const databasePath = path.resolve(
    __dirname,
    "../../_local/gameStore/gamestore.sqlite",
  );
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const row = database.prepare(
      "SELECT json FROM npcRuntimeState WHERE key = ?",
    ).get("livingEconomy");
    if (!row || !row.json) {
      throw new Error("The living economy state has not been created yet.");
    }
    return JSON.parse(row.json);
  } finally {
    database.close();
  }
}

function money(value) {
  return `${Number(value || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ISK`;
}

function number(value, maximumFractionDigits = 0) {
  return Number(value || 0).toLocaleString("en-US", { maximumFractionDigits });
}

function iso(value) {
  return Number(value || 0) > 0 ? new Date(Number(value)).toISOString() : "never";
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(snapshots) {
  const fields = [
    "sequence",
    "capturedAt",
    "periodSeconds",
    "minerDeposits",
    "oreVolumeM3",
    "mineralUnits",
    "minerGrossValueISK",
    "traderPurchases",
    "traderDeliveries",
    "traderSpendISK",
    "traderRevenueISK",
    "traderGrossMarginISK",
    "traderMarginPercent",
    "cargoLossValueISK",
    "industryJobsInstalled",
    "industryJobsCompleted",
    "industryInputUnits",
    "industryInputValueISK",
    "industryOutputUnits",
    "industryOutputValueISK",
    "marketTargetFillPercent",
    "marketStockValueISK",
    "activeFreightFlights",
    "materializedFlights",
    "failedAdjustments",
    "commodities",
  ];
  const rows = snapshots.map((snapshot) => [
    snapshot.sequence,
    iso(snapshot.capturedAtMs),
    snapshot.periodSeconds,
    snapshot.miners?.deposits || 0,
    snapshot.miners?.oreVolumeM3 || 0,
    snapshot.miners?.mineralUnits || 0,
    snapshot.miners?.grossValue || 0,
    snapshot.traders?.jobsPurchased || 0,
    snapshot.traders?.jobsDelivered || 0,
    snapshot.traders?.spend || 0,
    snapshot.traders?.revenue || 0,
    snapshot.traders?.grossMargin || 0,
    snapshot.traders?.marginPercent || 0,
    snapshot.traders?.cargoLossValue || 0,
    snapshot.industry?.jobsInstalled || 0,
    snapshot.industry?.jobsCompleted || 0,
    snapshot.industry?.inputUnitsConsumed || 0,
    snapshot.industry?.inputValueISK || 0,
    snapshot.industry?.outputUnitsProduced || 0,
    snapshot.industry?.outputValueISK || 0,
    snapshot.market?.targetFillPercent || 0,
    snapshot.market?.stockValue || 0,
    snapshot.population?.assignedFreightFlights || 0,
    snapshot.population?.materializedFlights || 0,
    snapshot.metricDeltas?.failedAdjustments || 0,
    JSON.stringify(snapshot.traders?.byCommodity || []),
  ]);
  return [fields, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\n") + "\n";
}

function toText(telemetry, snapshots, economy) {
  const metrics = economy && economy.metrics || {};
  const lines = [
    "Living Economy Timeline",
    `Snapshots: ${telemetry.snapshots.length} retained; showing ${snapshots.length}`,
    `Interval: ${number(Number(telemetry.intervalMs || 0) / 60_000, 1)} minutes`,
    `Latest sample: ${snapshots.length ? iso(snapshots[snapshots.length - 1].capturedAtMs) : "none"}`,
    `Current shadow books: miners ${money(metrics.minerGrossMarketValue)} gross value; traders spent ${money(metrics.traderSpend)}, received ${money(metrics.traderRevenue)}, gross margin ${money(metrics.traderGrossMargin)}, cargo losses ${money(metrics.traderCargoLossValue)}`,
    "",
  ];
  if (snapshots.length <= 0) {
    lines.push("No snapshots yet. The first economy pulse creates a baseline; the first interval closes ten minutes later.");
    return lines.join("\n") + "\n";
  }
  for (const snapshot of snapshots) {
    lines.push(
      `#${snapshot.sequence} ${iso(snapshot.capturedAtMs)}${snapshot.baseline ? " (baseline)" : ""}`,
      `  Miners: ${number(snapshot.miners?.deposits)} returns, ${number(snapshot.miners?.oreVolumeM3, 3)} m3 ore, ${number(snapshot.miners?.mineralUnits)} minerals, ${money(snapshot.miners?.grossValue)}`,
      `  Traders: bought ${number(snapshot.traders?.unitsPurchased)} units for ${money(snapshot.traders?.spend)}; sold ${number(snapshot.traders?.unitsSold)} for ${money(snapshot.traders?.revenue)}; gross margin ${money(snapshot.traders?.grossMargin)} (${number(snapshot.traders?.marginPercent, 2)}%)`,
      `  Industry: installed ${number(snapshot.industry?.jobsInstalled)} job(s), completed ${number(snapshot.industry?.jobsCompleted)}; consumed ${number(snapshot.industry?.inputUnitsConsumed)} mineral units worth ${money(snapshot.industry?.inputValueISK)}; produced ${number(snapshot.industry?.outputUnitsProduced)} units worth ${money(snapshot.industry?.outputValueISK)}`,
      `  Market: ${number(snapshot.market?.targetFillPercent, 2)}% target fill, ${money(snapshot.market?.stockValue)} stock value; ${number(snapshot.population?.assignedFreightFlights)} freight flights assigned`,
    );
    const commodities = (snapshot.traders?.byCommodity || []).slice(0, 8);
    if (commodities.length > 0) {
      lines.push(`  Trade: ${commodities.map((entry) => (
        `${entry.typeName} buy ${number(entry.quantityPurchased)}/${money(entry.spend)}, ` +
        `sell ${number(entry.quantitySold)}/${money(entry.revenue)}, margin ${money(entry.grossMargin)}`
      )).join("; ")}`);
    }
    const minerals = (snapshot.miners?.byMineral || []).slice(0, 8);
    if (minerals.length > 0) {
      lines.push(`  Refined: ${minerals.map((entry) => (
        `${entry.typeName} ${number(entry.quantity)} (${money(entry.grossValue)})`
      )).join("; ")}`);
    }
  }
  return lines.join("\n") + "\n";
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const economy = readEconomyState();
  const telemetry = economy.telemetry && typeof economy.telemetry === "object"
    ? economy.telemetry
    : { intervalMs: 600_000, snapshots: [] };
  const snapshots = (Array.isArray(telemetry.snapshots) ? telemetry.snapshots : [])
    .slice(-options.limit);
  let output;
  if (options.format === "json") {
    output = `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      accountingModel: "funded procurement plus station-valued freight, mining, and industry ledgers",
      intervalMs: telemetry.intervalMs,
      retainedSnapshots: telemetry.snapshots?.length || 0,
      currentMetrics: economy.metrics || {},
      currentJobs: Object.values(economy.jobs || {}),
      currentIndustryJobs: Object.values(economy.industryJobs || {}),
      currentMiningDeposits: Object.values(economy.miningDeposits || {}),
      snapshots,
    }, null, 2)}\n`;
  } else if (options.format === "csv") {
    output = toCsv(snapshots);
  } else {
    output = toText(telemetry, snapshots, economy);
  }
  if (options.output) {
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, output, "utf8");
    console.log(`Wrote ${options.format} economy timeline to ${options.output}`);
    return;
  }
  process.stdout.write(output);
}

main();
