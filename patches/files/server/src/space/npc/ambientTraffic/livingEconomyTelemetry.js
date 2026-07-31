"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../../config"));
const catalog = require(path.join(__dirname, "./livingEconomyCatalog"));

const DEFAULT_INTERVAL_SECONDS = 600;
const DEFAULT_RETENTION_SNAPSHOTS = 1_008;
const MAX_MARKET_STATION_DETAILS = 96;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function roundMoney(value) {
  return Math.round(toFiniteNumber(value, 0) * 100) / 100;
}

function roundVolume(value) {
  return Math.round(toFiniteNumber(value, 0) * 1_000) / 1_000;
}

function getIntervalMs() {
  return Math.max(
    60_000,
    toFiniteNumber(
      config.livingEconomyTelemetryIntervalSeconds,
      DEFAULT_INTERVAL_SECONDS,
    ) * 1_000,
  );
}

function getRetentionSnapshots() {
  return Math.max(
    6,
    Math.min(
      10_080,
      toPositiveInt(
        config.livingEconomyTelemetryRetentionSnapshots,
        DEFAULT_RETENTION_SNAPSHOTS,
      ),
    ),
  );
}

function buildDefaultTelemetryState() {
  return {
    schemaVersion: 1,
    intervalMs: getIntervalMs(),
    retentionSnapshots: getRetentionSnapshots(),
    nextSequence: 1,
    lastSnapshotAtMs: 0,
    metricBaseline: {},
    snapshots: [],
  };
}

function compareStationPriority(left, right) {
  return (
    toFiniteNumber(left && left.targetFillPercent, 0) -
      toFiniteNumber(right && right.targetFillPercent, 0) ||
    toFiniteNumber(right && right.stockValue, 0) -
      toFiniteNumber(left && left.stockValue, 0) ||
    toFiniteNumber(left && left.stationID, 0) -
      toFiniteNumber(right && right.stationID, 0)
  );
}

function compactStationSummaries(stations) {
  const rows = Array.isArray(stations) ? stations : [];
  if (rows.length <= MAX_MARKET_STATION_DETAILS) return rows;
  const selected = new Map();
  for (const row of rows) {
    if (String(row && row.hubTier || "") === "regional") {
      selected.set(Number(row.stationID), row);
    }
  }
  for (const row of [...rows].sort(compareStationPriority)) {
    if (selected.size >= MAX_MARKET_STATION_DETAILS) break;
    selected.set(Number(row.stationID), row);
  }
  return [...selected.values()].slice(0, MAX_MARKET_STATION_DETAILS);
}

function retainLowFillCandidate(candidates, row) {
  if (candidates.length < MAX_MARKET_STATION_DETAILS) {
    candidates.push(row);
    return;
  }
  let lowestPriorityIndex = 0;
  for (let index = 1; index < candidates.length; index += 1) {
    if (compareStationPriority(candidates[lowestPriorityIndex], candidates[index]) < 0) {
      lowestPriorityIndex = index;
    }
  }
  if (compareStationPriority(row, candidates[lowestPriorityIndex]) < 0) {
    candidates[lowestPriorityIndex] = row;
  }
}

function compactTelemetrySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const market = snapshot.market && typeof snapshot.market === "object"
    ? snapshot.market
    : null;
  if (!market || !Array.isArray(market.stations)) return snapshot;
  if (
    market.stations.length <= MAX_MARKET_STATION_DETAILS &&
    toPositiveInt(market.stationCount, 0) >= market.stations.length
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    market: {
      ...market,
      stationCount: Math.max(toPositiveInt(market.stationCount, 0), market.stations.length),
      stations: compactStationSummaries(market.stations),
    },
  };
}

function normalizeTelemetryState(rawState) {
  const defaults = buildDefaultTelemetryState();
  const raw = rawState && typeof rawState === "object" ? rawState : {};
  return {
    ...defaults,
    ...raw,
    schemaVersion: 1,
    intervalMs: getIntervalMs(),
    retentionSnapshots: getRetentionSnapshots(),
    nextSequence: Math.max(1, toPositiveInt(raw.nextSequence, 1)),
    lastSnapshotAtMs: Math.max(0, toFiniteNumber(raw.lastSnapshotAtMs, 0)),
    metricBaseline:
      raw.metricBaseline && typeof raw.metricBaseline === "object"
        ? { ...raw.metricBaseline }
        : {},
    snapshots: Array.isArray(raw.snapshots)
      ? raw.snapshots.slice(-getRetentionSnapshots()).map(compactTelemetrySnapshot)
      : [],
  };
}

function stockKey(stationID, typeID) {
  return `${Number(stationID)}:${Number(typeID)}`;
}

function getStockRow(stockMap, stationID, typeID) {
  return stockMap instanceof Map
    ? stockMap.get(stockKey(stationID, typeID)) || null
    : null;
}

function countBy(rows, selector) {
  const counts = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(selector(row) || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function numericMetricSnapshot(metrics) {
  return Object.fromEntries(
    Object.entries(metrics && typeof metrics === "object" ? metrics : {})
      .filter(([, value]) => Number.isFinite(Number(value)))
      .map(([key, value]) => [key, toFiniteNumber(value, 0)]),
  );
}

function subtractMetrics(current, baseline) {
  const result = {};
  for (const [key, value] of Object.entries(numericMetricSnapshot(current))) {
    result[key] = toFiniteNumber(value, 0) - toFiniteNumber(baseline && baseline[key], 0);
  }
  return result;
}

function inPeriod(timestamp, startAtMs, endAtMs) {
  const value = toFiniteNumber(timestamp, 0);
  return value > startAtMs && value <= endAtMs;
}

function buildMinerPeriod(economyState, startAtMs, endAtMs) {
  const deposits = Object.values(economyState && economyState.miningDeposits || {})
    .filter((deposit) => (
      String(deposit && deposit.status || "") === "delivered" &&
      inPeriod(deposit && deposit.deliveredAtMs, startAtMs, endAtMs)
    ));
  const byMineral = new Map();
  let oreUnits = 0;
  let oreVolumeM3 = 0;
  let mineralUnits = 0;
  let grossValue = 0;
  for (const deposit of deposits) {
    oreUnits += toPositiveInt(deposit.oreUnits, 0);
    oreVolumeM3 += toFiniteNumber(deposit.oreVolumeM3, 0);
    grossValue += toFiniteNumber(deposit.grossMarketValue, 0);
    for (const output of Array.isArray(deposit.outputValuations)
      ? deposit.outputValuations
      : []) {
      const typeID = toPositiveInt(output && output.typeID, 0);
      if (typeID <= 0) {
        continue;
      }
      const current = byMineral.get(typeID) || {
        typeID,
        typeName: String(output.typeName || `type ${typeID}`),
        quantity: 0,
        grossValue: 0,
      };
      current.quantity += toPositiveInt(output.quantity, 0);
      current.grossValue += toFiniteNumber(output.grossValue, 0);
      mineralUnits += toPositiveInt(output.quantity, 0);
      byMineral.set(typeID, current);
    }
  }
  return {
    deposits: deposits.length,
    oreUnits,
    oreVolumeM3: roundVolume(oreVolumeM3),
    mineralUnits,
    grossValue: roundMoney(grossValue),
    byMineral: [...byMineral.values()]
      .map((entry) => ({ ...entry, grossValue: roundMoney(entry.grossValue) }))
      .sort((left, right) => right.grossValue - left.grossValue),
  };
}

function buildTraderPeriod(economyState, startAtMs, endAtMs) {
  const jobs = Object.values(economyState && economyState.jobs || {});
  const purchased = jobs.filter((job) => (
    toFiniteNumber(job && job.purchaseValue, 0) > 0 &&
    inPeriod(job && job.reservedAtMs, startAtMs, endAtMs)
  ));
  const delivered = jobs.filter((job) => (
    String(job && job.status || "") === "delivered" &&
    toFiniteNumber(job && job.saleValue, 0) > 0 &&
    inPeriod(job && job.completedAtMs, startAtMs, endAtMs)
  ));
  const lost = jobs.filter((job) => (
    String(job && job.status || "") === "lost" &&
    inPeriod(job && job.completedAtMs, startAtMs, endAtMs)
  ));
  const byCommodity = new Map();
  const byLogisticsClass = new Map();
  const getCommodity = (job) => {
    const typeID = toPositiveInt(job && job.typeID, 0);
    const current = byCommodity.get(typeID) || {
      typeID,
      typeName: String(job && job.typeName || `type ${typeID}`),
      quantityPurchased: 0,
      spend: 0,
      quantitySold: 0,
      revenue: 0,
      grossMargin: 0,
    };
    byCommodity.set(typeID, current);
    return current;
  };
  for (const job of purchased) {
    const current = getCommodity(job);
    current.quantityPurchased += toPositiveInt(job.quantity, 0);
    current.spend += toFiniteNumber(job.purchaseValue, 0);
    const logisticsClass = String(job.logisticsClass || "legacy");
    const logistics = byLogisticsClass.get(logisticsClass) || {
      logisticsClass,
      jobsPurchased: 0,
      jobsDelivered: 0,
      jobsLost: 0,
      cargoVolumePurchasedM3: 0,
      cargoVolumeDeliveredM3: 0,
      cargoVolumeLostM3: 0,
      spend: 0,
      revenue: 0,
      grossMargin: 0,
    };
    logistics.jobsPurchased += 1;
    logistics.cargoVolumePurchasedM3 += toFiniteNumber(job.cargoVolume, 0);
    logistics.spend += toFiniteNumber(job.purchaseValue, 0);
    byLogisticsClass.set(logisticsClass, logistics);
  }
  for (const job of delivered) {
    const current = getCommodity(job);
    current.quantitySold += toPositiveInt(job.quantity, 0);
    current.revenue += toFiniteNumber(job.saleValue, 0);
    current.grossMargin += toFiniteNumber(job.grossMargin, 0);
    const logisticsClass = String(job.logisticsClass || "legacy");
    const logistics = byLogisticsClass.get(logisticsClass) || {
      logisticsClass,
      jobsPurchased: 0,
      jobsDelivered: 0,
      jobsLost: 0,
      cargoVolumePurchasedM3: 0,
      cargoVolumeDeliveredM3: 0,
      cargoVolumeLostM3: 0,
      spend: 0,
      revenue: 0,
      grossMargin: 0,
    };
    logistics.jobsDelivered += 1;
    logistics.cargoVolumeDeliveredM3 += toFiniteNumber(job.cargoVolume, 0);
    logistics.revenue += toFiniteNumber(job.saleValue, 0);
    logistics.grossMargin += toFiniteNumber(job.grossMargin, 0);
    byLogisticsClass.set(logisticsClass, logistics);
  }
  for (const job of lost) {
    const logisticsClass = String(job.logisticsClass || "legacy");
    const logistics = byLogisticsClass.get(logisticsClass) || {
      logisticsClass,
      jobsPurchased: 0,
      jobsDelivered: 0,
      jobsLost: 0,
      cargoVolumePurchasedM3: 0,
      cargoVolumeDeliveredM3: 0,
      cargoVolumeLostM3: 0,
      spend: 0,
      revenue: 0,
      grossMargin: 0,
    };
    logistics.jobsLost += 1;
    logistics.cargoVolumeLostM3 += toFiniteNumber(job.cargoVolume, 0);
    byLogisticsClass.set(logisticsClass, logistics);
  }
  const spend = purchased.reduce(
    (sum, job) => sum + toFiniteNumber(job.purchaseValue, 0),
    0,
  );
  const revenue = delivered.reduce(
    (sum, job) => sum + toFiniteNumber(job.saleValue, 0),
    0,
  );
  const grossMargin = delivered.reduce(
    (sum, job) => sum + toFiniteNumber(job.grossMargin, 0),
    0,
  );
  return {
    jobsPurchased: purchased.length,
    jobsDelivered: delivered.length,
    jobsLost: lost.length,
    unitsPurchased: purchased.reduce(
      (sum, job) => sum + toPositiveInt(job.quantity, 0),
      0,
    ),
    unitsSold: delivered.reduce(
      (sum, job) => sum + toPositiveInt(job.quantity, 0),
      0,
    ),
    spend: roundMoney(spend),
    revenue: roundMoney(revenue),
    grossMargin: roundMoney(grossMargin),
    marginPercent: spend > 0 ? Math.round((grossMargin / spend) * 10_000) / 100 : 0,
    cargoLossValue: roundMoney(lost.reduce(
      (sum, job) => sum + toFiniteNumber(job.purchaseValue, 0),
      0,
    )),
    byCommodity: [...byCommodity.values()]
      .map((entry) => ({
        ...entry,
        spend: roundMoney(entry.spend),
        revenue: roundMoney(entry.revenue),
        grossMargin: roundMoney(entry.grossMargin),
      }))
      .sort((left, right) => right.revenue - left.revenue || right.spend - left.spend),
    byLogisticsClass: [...byLogisticsClass.values()]
      .map((entry) => ({
        ...entry,
        cargoVolumePurchasedM3: roundVolume(entry.cargoVolumePurchasedM3),
        cargoVolumeDeliveredM3: roundVolume(entry.cargoVolumeDeliveredM3),
        cargoVolumeLostM3: roundVolume(entry.cargoVolumeLostM3),
        spend: roundMoney(entry.spend),
        revenue: roundMoney(entry.revenue),
        grossMargin: roundMoney(entry.grossMargin),
      }))
      .sort((left, right) => right.cargoVolumeDeliveredM3 - left.cargoVolumeDeliveredM3),
  };
}

function buildIndustryPeriod(economyState, startAtMs, endAtMs) {
  const jobs = Object.values(economyState && economyState.industryJobs || {});
  const installed = jobs.filter((job) => inPeriod(job && job.startedAtMs, startAtMs, endAtMs));
  const completed = jobs.filter((job) => (
    String(job && job.status || "") === "completed" &&
    inPeriod(job && job.completedAtMs, startAtMs, endAtMs)
  ));
  const manufacturingInstalled = installed.filter((job) => (
    String(job && job.activity || "manufacturing") === "manufacturing"
  ));
  const manufacturingCompleted = completed.filter((job) => (
    String(job && job.activity || "manufacturing") === "manufacturing"
  ));
  const activitiesInstalled = countBy(installed, (job) => job && job.activity || "manufacturing");
  const activitiesCompleted = countBy(completed, (job) => job && job.activity || "manufacturing");
  const byProduct = new Map();
  for (const job of manufacturingCompleted) {
    const typeID = toPositiveInt(job && job.productTypeID, 0);
    const current = byProduct.get(typeID) || {
      typeID,
      typeName: String(job && job.productTypeName || `type ${typeID}`),
      jobs: 0,
      blueprintRuns: 0,
      quantity: 0,
      inputValueISK: 0,
      outputValueISK: 0,
    };
    current.jobs += 1;
    current.blueprintRuns += toPositiveInt(job && job.runs, 0);
    current.quantity += toPositiveInt(job && job.productQuantity, 0);
    current.inputValueISK += toFiniteNumber(job && job.inputValueISK, 0);
    current.outputValueISK += toFiniteNumber(job && job.outputValueISK, 0);
    byProduct.set(typeID, current);
  }
  const pilots = Object.values(economyState && economyState.industryPilots || {});
  const activePilotIDs = new Set(Object.values(economyState && economyState.industryJobs || {})
    .filter((job) => ["reserving", "running", "output_pending"].includes(String(job && job.status || "")))
    .map((job) => toPositiveInt(job && job.pilotID, 0))
    .filter(Boolean));
  const blueprints = Object.values(economyState && economyState.industryBlueprints || {});
  return {
    jobsInstalled: installed.length,
    jobsCompleted: completed.length,
    activitiesInstalled,
    activitiesCompleted,
    workforce: {
      pilots: pilots.length,
      highsec: pilots.filter((pilot) => String(pilot && pilot.securityBand) === "highsec").length,
      lowsec: pilots.filter((pilot) => String(pilot && pilot.securityBand) === "lowsec").length,
      nullsec: pilots.filter((pilot) => String(pilot && pilot.securityBand) === "nullsec").length,
      busy: activePilotIDs.size,
    },
    blueprints: {
      originals: blueprints.filter((blueprint) => blueprint && blueprint.original === true).length,
      copies: blueprints.filter((blueprint) => blueprint && blueprint.original !== true).length,
      copyRunsAvailable: blueprints.filter((blueprint) => blueprint && blueprint.original !== true)
        .reduce((sum, blueprint) => sum + toPositiveInt(blueprint && blueprint.runsRemaining, 0), 0),
    },
    blueprintRunsInstalled: manufacturingInstalled.reduce(
      (sum, job) => sum + toPositiveInt(job && job.runs, 0),
      0,
    ),
    inputUnitsConsumed: manufacturingInstalled.reduce(
      (sum, job) => sum + (Array.isArray(job && job.inputs)
        ? job.inputs.reduce((inputSum, input) => inputSum + toPositiveInt(input && input.quantity, 0), 0)
        : 0),
      0,
    ),
    inputValueISK: roundMoney(manufacturingInstalled.reduce(
      (sum, job) => sum + toFiniteNumber(job && job.inputValueISK, 0),
      0,
    )),
    outputUnitsProduced: manufacturingCompleted.reduce(
      (sum, job) => sum + toPositiveInt(job && job.productQuantity, 0),
      0,
    ),
    outputValueISK: roundMoney(manufacturingCompleted.reduce(
      (sum, job) => sum + toFiniteNumber(job && job.outputValueISK, 0),
      0,
    )),
    byProduct: [...byProduct.values()]
      .map((entry) => ({
        ...entry,
        inputValueISK: roundMoney(entry.inputValueISK),
        outputValueISK: roundMoney(entry.outputValueISK),
      }))
      .sort((left, right) => right.outputValueISK - left.outputValueISK),
  };
}

function buildMarketSummary(stockMap) {
  let targetUnits = 0;
  let filledTargetUnits = 0;
  let stockUnits = 0;
  let stockValue = 0;
  const stations = [];
  for (const station of catalog.STATIONS) {
    let stationTargetUnits = 0;
    let stationFilledTargetUnits = 0;
    let stationStockUnits = 0;
    let stationStockValue = 0;
    let stockedTypes = 0;
    for (const good of catalog.GOODS) {
      const row = getStockRow(stockMap, station.stationID, good.typeID);
      const quantity = Math.max(0, toFiniteNumber(row && row.quantity, 0));
      const price = Math.max(0, toFiniteNumber(row && row.price, good.priceAnchor));
      const target = Math.max(0, catalog.getTargetQuantity(station, good));
      stationStockUnits += quantity;
      stationStockValue += quantity * price;
      stationTargetUnits += target;
      stationFilledTargetUnits += Math.min(target, quantity);
      if (quantity > 0) {
        stockedTypes += 1;
      }
    }
    targetUnits += stationTargetUnits;
    filledTargetUnits += stationFilledTargetUnits;
    stockUnits += stationStockUnits;
    stockValue += stationStockValue;
    stations.push({
      stationID: station.stationID,
      stationName: station.name,
      hubTier: String(station.hubTier || "local"),
      stockedTypes,
      targetFillPercent: stationTargetUnits > 0
        ? Math.round((stationFilledTargetUnits / stationTargetUnits) * 10_000) / 100
        : 0,
      stockUnits: Math.round(stationStockUnits),
      stockValue: roundMoney(stationStockValue),
    });
  }
  return {
    targetFillPercent: targetUnits > 0
      ? Math.round((filledTargetUnits / targetUnits) * 10_000) / 100
      : 0,
    stockUnits: Math.round(stockUnits),
    stockValue: roundMoney(stockValue),
    stationCount: stations.length,
    stations: compactStationSummaries(stations),
  };
}

function buildSalvagePeriod(economyState, startAtMs, endAtMs) {
  const jobs = Object.values(economyState && economyState.salvageJobs || {})
    .filter((job) => (
      ["delivered", "exhausted"].includes(String(job && job.status || "")) &&
      inPeriod(job && job.completedAtMs, startAtMs, endAtMs)
    ));
  const byMaterial = new Map();
  let recoveredWrecks = 0;
  let playerClaimedWrecks = 0;
  let units = 0;
  for (const job of jobs) {
    recoveredWrecks += Array.isArray(job.recoveredActorIDs) ? job.recoveredActorIDs.length : 0;
    playerClaimedWrecks += Array.isArray(job.claimedByPlayerActorIDs)
      ? job.claimedByPlayerActorIDs.length
      : 0;
    for (const output of Array.isArray(job.outputs) ? job.outputs : []) {
      const typeID = toPositiveInt(output && output.typeID, 0);
      const quantity = toPositiveInt(output && output.quantity, 0);
      if (!typeID || !quantity) continue;
      const good = catalog.getGood(typeID);
      const current = byMaterial.get(typeID) || {
        typeID,
        typeName: String(good && good.name || `type ${typeID}`),
        quantity: 0,
      };
      current.quantity += quantity;
      units += quantity;
      byMaterial.set(typeID, current);
    }
  }
  return {
    jobs: jobs.length,
    recoveredWrecks,
    playerClaimedWrecks,
    units,
    byMaterial: [...byMaterial.values()]
      .sort((left, right) => right.quantity - left.quantity || left.typeID - right.typeID),
  };
}

async function buildMinerPeriodCooperative(
  economyState,
  startAtMs,
  endAtMs,
  workBudget,
) {
  if (!workBudget || typeof workBudget.checkpoint !== "function") {
    return buildMinerPeriod(economyState, startAtMs, endAtMs);
  }
  const deposits = economyState && economyState.miningDeposits || {};
  const byMineral = new Map();
  let deliveredDeposits = 0;
  let oreUnits = 0;
  let oreVolumeM3 = 0;
  let mineralUnits = 0;
  let grossValue = 0;
  let scanned = 0;
  for (const depositID in deposits) {
    if (!Object.prototype.hasOwnProperty.call(deposits, depositID)) continue;
    scanned += 1;
    if (scanned % 128 === 0) await workBudget.checkpoint();
    const deposit = deposits[depositID];
    if (
      String(deposit && deposit.status || "") !== "delivered" ||
      !inPeriod(deposit && deposit.deliveredAtMs, startAtMs, endAtMs)
    ) {
      continue;
    }
    deliveredDeposits += 1;
    oreUnits += toPositiveInt(deposit.oreUnits, 0);
    oreVolumeM3 += toFiniteNumber(deposit.oreVolumeM3, 0);
    grossValue += toFiniteNumber(deposit.grossMarketValue, 0);
    for (const output of Array.isArray(deposit.outputValuations)
      ? deposit.outputValuations
      : []) {
      const typeID = toPositiveInt(output && output.typeID, 0);
      if (typeID <= 0) continue;
      const current = byMineral.get(typeID) || {
        typeID,
        typeName: String(output.typeName || `type ${typeID}`),
        quantity: 0,
        grossValue: 0,
      };
      current.quantity += toPositiveInt(output.quantity, 0);
      current.grossValue += toFiniteNumber(output.grossValue, 0);
      mineralUnits += toPositiveInt(output.quantity, 0);
      byMineral.set(typeID, current);
    }
  }
  return {
    deposits: deliveredDeposits,
    oreUnits,
    oreVolumeM3: roundVolume(oreVolumeM3),
    mineralUnits,
    grossValue: roundMoney(grossValue),
    byMineral: [...byMineral.values()]
      .map((entry) => ({ ...entry, grossValue: roundMoney(entry.grossValue) }))
      .sort((left, right) => right.grossValue - left.grossValue),
  };
}

async function buildMarketSummaryCooperative(stockMap, workBudget) {
  if (!workBudget || typeof workBudget.checkpoint !== "function") {
    return buildMarketSummary(stockMap);
  }
  let targetUnits = 0;
  let filledTargetUnits = 0;
  let stockUnits = 0;
  let stockValue = 0;
  const regionalStations = [];
  const lowFillCandidates = [];
  let stationCount = 0;
  let scannedRows = 0;
  for (const station of catalog.STATIONS) {
    let stationTargetUnits = 0;
    let stationFilledTargetUnits = 0;
    let stationStockUnits = 0;
    let stationStockValue = 0;
    let stockedTypes = 0;
    for (const good of catalog.GOODS) {
      scannedRows += 1;
      if (scannedRows % 32 === 0) await workBudget.checkpoint();
      const row = getStockRow(stockMap, station.stationID, good.typeID);
      const quantity = Math.max(0, toFiniteNumber(row && row.quantity, 0));
      const price = Math.max(0, toFiniteNumber(row && row.price, good.priceAnchor));
      const target = Math.max(0, catalog.getTargetQuantity(station, good));
      stationStockUnits += quantity;
      stationStockValue += quantity * price;
      stationTargetUnits += target;
      stationFilledTargetUnits += Math.min(target, quantity);
      if (quantity > 0) stockedTypes += 1;
    }
    targetUnits += stationTargetUnits;
    filledTargetUnits += stationFilledTargetUnits;
    stockUnits += stationStockUnits;
    stockValue += stationStockValue;
    const stationSummary = {
      stationID: station.stationID,
      stationName: station.name,
      hubTier: String(station.hubTier || "local"),
      stockedTypes,
      targetFillPercent: stationTargetUnits > 0
        ? Math.round((stationFilledTargetUnits / stationTargetUnits) * 10_000) / 100
        : 0,
      stockUnits: Math.round(stationStockUnits),
      stockValue: roundMoney(stationStockValue),
    };
    stationCount += 1;
    if (String(station.hubTier || "") === "regional") regionalStations.push(stationSummary);
    retainLowFillCandidate(lowFillCandidates, stationSummary);
    await workBudget.checkpoint();
  }
  return {
    targetFillPercent: targetUnits > 0
      ? Math.round((filledTargetUnits / targetUnits) * 10_000) / 100
      : 0,
    stockUnits: Math.round(stockUnits),
    stockValue: roundMoney(stockValue),
    stationCount,
    stations: compactStationSummaries([...regionalStations, ...lowFillCandidates]),
  };
}

function buildPopulationSummary(livingState) {
  const actors = Object.values(livingState && livingState.actors || {});
  const flights = Object.values(livingState && livingState.flights || {});
  return {
    actors: actors.length,
    flights: flights.length,
    actorRoles: countBy(actors, (actor) => actor && actor.role),
    actorFactions: countBy(actors, (actor) => actor && actor.factionName),
    actorCorporations: countBy(actors, (actor) => actor && actor.corporationName),
    homeStations: countBy(actors, (actor) => actor && actor.homeStationID),
    flightPhases: countBy(flights, (flight) => flight && flight.phase),
    materializedFlights: flights.filter((flight) => flight && flight.materialized).length,
    assignedFreightFlights: flights.filter((flight) => flight && flight.freightJobID).length,
  };
}

function buildSnapshot({
  economyState,
  livingState,
  stockMap,
  startAtMs,
  endAtMs,
  sequence,
  metricBaseline,
  baseline = false,
}) {
  const metrics = numericMetricSnapshot(economyState && economyState.metrics);
  return {
    sequence: Math.max(1, toPositiveInt(sequence, 1)),
    baseline: baseline === true,
    capturedAtMs: endAtMs,
    periodStartAtMs: startAtMs,
    periodSeconds: Math.max(0, Math.round((endAtMs - startAtMs) / 1_000)),
    miners: buildMinerPeriod(economyState, startAtMs, endAtMs),
    traders: buildTraderPeriod(economyState, startAtMs, endAtMs),
    industry: buildIndustryPeriod(economyState, startAtMs, endAtMs),
    salvage: buildSalvagePeriod(economyState, startAtMs, endAtMs),
    market: buildMarketSummary(stockMap),
    population: buildPopulationSummary(livingState),
    metricDeltas: baseline ? {} : subtractMetrics(metrics, metricBaseline),
    cumulativeMetrics: metrics,
  };
}

async function buildSnapshotCooperative({
  economyState,
  livingState,
  stockMap,
  startAtMs,
  endAtMs,
  sequence,
  metricBaseline,
  baseline = false,
  workBudget,
}) {
  const metrics = numericMetricSnapshot(economyState && economyState.metrics);
  const miners = await buildMinerPeriodCooperative(
    economyState,
    startAtMs,
    endAtMs,
    workBudget,
  );
  await workBudget.checkpoint();
  const traders = buildTraderPeriod(economyState, startAtMs, endAtMs);
  await workBudget.checkpoint();
  const industry = buildIndustryPeriod(economyState, startAtMs, endAtMs);
  await workBudget.checkpoint();
  const salvage = buildSalvagePeriod(economyState, startAtMs, endAtMs);
  await workBudget.checkpoint();
  const market = await buildMarketSummaryCooperative(stockMap, workBudget);
  const population = buildPopulationSummary(livingState);
  await workBudget.checkpoint();
  return {
    sequence: Math.max(1, toPositiveInt(sequence, 1)),
    baseline: baseline === true,
    capturedAtMs: endAtMs,
    periodStartAtMs: startAtMs,
    periodSeconds: Math.max(0, Math.round((endAtMs - startAtMs) / 1_000)),
    miners,
    traders,
    industry,
    salvage,
    market,
    population,
    metricDeltas: baseline ? {} : subtractMetrics(metrics, metricBaseline),
    cumulativeMetrics: metrics,
  };
}

function maybeCapture(economyState, livingState, stockMap, nowMs = Date.now()) {
  if (!economyState || typeof economyState !== "object") {
    return null;
  }
  const telemetry = normalizeTelemetryState(economyState.telemetry);
  economyState.telemetry = telemetry;
  const isBaseline = telemetry.lastSnapshotAtMs <= 0;
  if (!isBaseline && nowMs - telemetry.lastSnapshotAtMs < telemetry.intervalMs) {
    return null;
  }
  const startAtMs = isBaseline ? nowMs : telemetry.lastSnapshotAtMs;
  const snapshot = buildSnapshot({
    economyState,
    livingState,
    stockMap,
    startAtMs,
    endAtMs: nowMs,
    sequence: telemetry.nextSequence,
    metricBaseline: telemetry.metricBaseline,
    baseline: isBaseline,
  });
  telemetry.nextSequence += 1;
  telemetry.lastSnapshotAtMs = nowMs;
  telemetry.metricBaseline = numericMetricSnapshot(economyState.metrics);
  telemetry.snapshots.push(snapshot);
  if (telemetry.snapshots.length > telemetry.retentionSnapshots) {
    telemetry.snapshots = telemetry.snapshots.slice(-telemetry.retentionSnapshots);
  }
  return snapshot;
}

async function maybeCaptureCooperative(
  economyState,
  livingState,
  stockMap,
  nowMs = Date.now(),
  workBudget,
) {
  if (!workBudget || typeof workBudget.checkpoint !== "function") {
    return maybeCapture(economyState, livingState, stockMap, nowMs);
  }
  if (!economyState || typeof economyState !== "object") return null;
  const existing = economyState.telemetry && typeof economyState.telemetry === "object"
    ? economyState.telemetry
    : null;
  const existingLastSnapshotAtMs = Math.max(
    0,
    toFiniteNumber(existing && existing.lastSnapshotAtMs, 0),
  );
  if (
    existingLastSnapshotAtMs > 0 &&
    nowMs - existingLastSnapshotAtMs < getIntervalMs()
  ) {
    return null;
  }
  const telemetry = normalizeTelemetryState(economyState.telemetry);
  economyState.telemetry = telemetry;
  const isBaseline = telemetry.lastSnapshotAtMs <= 0;
  if (!isBaseline && nowMs - telemetry.lastSnapshotAtMs < telemetry.intervalMs) return null;
  const startAtMs = isBaseline ? nowMs : telemetry.lastSnapshotAtMs;
  const snapshot = await buildSnapshotCooperative({
    economyState,
    livingState,
    stockMap,
    startAtMs,
    endAtMs: nowMs,
    sequence: telemetry.nextSequence,
    metricBaseline: telemetry.metricBaseline,
    baseline: isBaseline,
    workBudget,
  });
  telemetry.nextSequence += 1;
  telemetry.lastSnapshotAtMs = nowMs;
  telemetry.metricBaseline = numericMetricSnapshot(economyState.metrics);
  telemetry.snapshots.push(snapshot);
  if (telemetry.snapshots.length > telemetry.retentionSnapshots) {
    telemetry.snapshots = telemetry.snapshots.slice(-telemetry.retentionSnapshots);
  }
  return snapshot;
}

module.exports = {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_RETENTION_SNAPSHOTS,
  buildDefaultTelemetryState,
  normalizeTelemetryState,
  buildMinerPeriod,
  buildMinerPeriodCooperative,
  buildTraderPeriod,
  buildIndustryPeriod,
  buildSalvagePeriod,
  buildMarketSummary,
  buildMarketSummaryCooperative,
  buildPopulationSummary,
  buildSnapshot,
  buildSnapshotCooperative,
  maybeCapture,
  maybeCaptureCooperative,
};
