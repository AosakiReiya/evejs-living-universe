"use strict";

const crypto = require("crypto");
const path = require("path");

const salvageRuntime = require(path.join(__dirname, "../../modules/salvagerRuntime"));

const ACTIVE_JOB_STATES = new Set(["outbound", "recovering", "returning", "delivery_pending"]);
const MAX_ACTIVE_JOBS = 48;
const MAX_NEW_JOBS_PER_PULSE = 6;
const BASE_LOCAL_TRAVEL_MS = 120_000;
const PER_JUMP_TRAVEL_MS = 60_000;
const BASE_RECOVERY_MS = 45_000;
const PER_WRECK_RECOVERY_MS = 30_000;
const SITE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function getAdjustmentEpoch(economyState, job) {
  const persistedEpoch = toPositiveInt(job && job.adjustmentEpochMs, 0);
  if (persistedEpoch > 0) return persistedEpoch;
  return toPositiveInt(
    economyState && economyState.createdAtMs,
    toPositiveInt(job && job.createdAtMs, 1),
  );
}

function makeSalvageAdjustmentID(economyState, job, outputTypeID) {
  if (toPositiveInt(job && job.adjustmentEpochMs, 0) <= 0) {
    // An in-flight job written by the legacy implementation must try its old
    // token first. If that token already committed, the daemon can return the
    // original receipt without crediting the output twice.
    return `${String(job && job.jobID || "unknown")}:salvage:` +
      `${toPositiveInt(outputTypeID, 0)}`;
  }
  return `living-salvage:${getAdjustmentEpoch(economyState, job)}:` +
    `${String(job && job.jobID || "unknown")}:` +
    `${toPositiveInt(job && job.destinationStationID, 0)}:` +
    `output:${toPositiveInt(outputTypeID, 0)}`;
}

function promoteLegacyAdjustmentNamespace(economyState, job, result, nowMs) {
  if (toPositiveInt(job && job.adjustmentEpochMs, 0) > 0) return false;
  const message = String(
    result && result.error && result.error.message ||
    result && result.errorMsg ||
    "",
  );
  if (!/seed stock adjustment id was already used (?:for|with) a different/i.test(message)) {
    return false;
  }
  job.adjustmentEpochMs = getAdjustmentEpoch(economyState, job);
  job.adjustmentNamespaceMigratedAtMs = nowMs;
  return true;
}

function ensureState(economyState) {
  if (!economyState.salvageSites || typeof economyState.salvageSites !== "object") {
    economyState.salvageSites = {};
  }
  if (!economyState.salvageJobs || typeof economyState.salvageJobs !== "object") {
    economyState.salvageJobs = {};
  }
  economyState.nextSalvageJobNumber = Math.max(
    1,
    toPositiveInt(economyState.nextSalvageJobNumber, 1),
  );
  const metrics = economyState.metrics || (economyState.metrics = {});
  for (const key of [
    "salvageSitesCreated",
    "salvageJobsCreated",
    "salvageJobsCompleted",
    "salvageJobsExhausted",
    "salvageWrecksRecovered",
    "salvageWrecksClaimedByPlayers",
    "salvageUnitsRecovered",
    "salvageDepositsDelivered",
  ]) {
    metrics[key] = Math.max(0, toFiniteNumber(metrics[key], 0));
  }
  return economyState;
}

function createDeterministicRandom(seed) {
  let counter = 0;
  return () => {
    const digest = crypto
      .createHash("sha256")
      .update(`${String(seed || "salvage")}:${counter++}`)
      .digest();
    return digest.readUInt32BE(0) / 0x1_0000_0000;
  };
}

function buildVictimSalvage(victim, encounterID) {
  const actorID = String(victim && victim.actorID || "unknown");
  const random = createDeterministicRandom(`${encounterID}:${actorID}`);
  const entries = salvageRuntime.buildSalvageRewardEntries({
    kind: "wreck",
    itemID: 0,
    typeID: toPositiveInt(victim && victim.shipTypeID, 0),
    itemName: `${String(victim && victim.shipName || "Ship")} Wreck`,
    sourceNpcName: String(victim && victim.shipName || ""),
    sourceFactionName: String(victim && victim.factionName || ""),
  }, {
    callbacks: { random },
  });
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({
      typeID: toPositiveInt(entry && entry.itemType, 0),
      quantity: toPositiveInt(entry && entry.quantity, 0),
    }))
    .filter((entry) => entry.typeID > 0 && entry.quantity > 0);
}

function registerOpportunity(economyState, details = {}, nowMs = Date.now()) {
  ensureState(economyState);
  const encounterID = String(details.encounterID || "").trim();
  const victims = Array.isArray(details.victims) ? details.victims.filter(Boolean) : [];
  const stationID = toPositiveInt(details.destinationStationID, 0);
  const systemID = toPositiveInt(details.systemID, 0);
  if (!encounterID || victims.length <= 0 || !stationID || !systemID) return null;

  const siteID = `LES-${encounterID}`;
  if (economyState.salvageSites[siteID]) return economyState.salvageSites[siteID];
  const wrecks = victims.map((victim) => ({
    actorID: String(victim.actorID || ""),
    shipTypeID: toPositiveInt(victim.shipTypeID, 0),
    shipName: String(victim.shipName || `type ${toPositiveInt(victim.shipTypeID, 0)}`),
    factionName: String(victim.factionName || ""),
    wreckID: toPositiveInt(victim.wreckID, 0) || null,
    status: "available",
    salvage: buildVictimSalvage(victim, encounterID),
  }));
  const jumpCount = Math.max(0, Math.trunc(toFiniteNumber(details.jumpCount, 0)));
  const travelMs = Math.max(
    BASE_LOCAL_TRAVEL_MS,
    BASE_LOCAL_TRAVEL_MS + (jumpCount * PER_JUMP_TRAVEL_MS),
  );
  const site = {
    siteID,
    encounterID,
    status: "available",
    systemID,
    security: toFiniteNumber(details.security, 0),
    destinationStationID: stationID,
    destinationSystemID: toPositiveInt(details.destinationSystemID, systemID),
    jumpCount,
    travelMs,
    recoveryMs: BASE_RECOVERY_MS + (wrecks.length * PER_WRECK_RECOVERY_MS),
    wrecks,
    assignedJobID: null,
    createdAtMs: nowMs,
    lastUpdatedAtMs: nowMs,
  };
  economyState.salvageSites[siteID] = site;
  economyState.metrics.salvageSitesCreated += 1;
  return site;
}

function listActiveJobs(economyState) {
  ensureState(economyState);
  return Object.values(economyState.salvageJobs).filter(
    (job) => job && ACTIVE_JOB_STATES.has(String(job.status || "")),
  );
}

function aggregateRecoveredSalvage(site, recoveredActorIDs) {
  const recovered = new Set((Array.isArray(recoveredActorIDs) ? recoveredActorIDs : [])
    .map(String));
  const byTypeID = new Map();
  for (const wreck of Array.isArray(site && site.wrecks) ? site.wrecks : []) {
    if (!recovered.has(String(wreck.actorID || ""))) continue;
    for (const entry of Array.isArray(wreck.salvage) ? wreck.salvage : []) {
      const typeID = toPositiveInt(entry && entry.typeID, 0);
      const quantity = toPositiveInt(entry && entry.quantity, 0);
      if (!typeID || !quantity) continue;
      byTypeID.set(typeID, (byTypeID.get(typeID) || 0) + quantity);
    }
  }
  return [...byTypeID.entries()]
    .map(([typeID, quantity]) => ({ typeID, quantity }))
    .sort((left, right) => left.typeID - right.typeID);
}

function createJob(economyState, site, nowMs, addEvent) {
  const jobNumber = economyState.nextSalvageJobNumber++;
  const jobID = `LEZ-${String(jobNumber).padStart(8, "0")}`;
  const job = {
    jobID,
    siteID: site.siteID,
    encounterID: site.encounterID,
    status: "outbound",
    systemID: site.systemID,
    destinationStationID: site.destinationStationID,
    jumpCount: site.jumpCount,
    travelMs: site.travelMs,
    recoveryMs: site.recoveryMs,
    outboundAtMs: nowMs,
    arrivesAtMs: nowMs + site.travelMs,
    recoveryCompletesAtMs: null,
    returnsAtMs: null,
    recoveredActorIDs: [],
    claimedByPlayerActorIDs: [],
    outputs: [],
    creditedTypeIDs: [],
    adjustmentEpochMs: toPositiveInt(economyState.createdAtMs, nowMs),
    createdAtMs: nowMs,
    lastUpdatedAtMs: nowMs,
  };
  economyState.salvageJobs[jobID] = job;
  site.status = "assigned";
  site.assignedJobID = jobID;
  site.lastUpdatedAtMs = nowMs;
  economyState.metrics.salvageJobsCreated += 1;
  if (typeof addEvent === "function") {
    addEvent("salvage_recovery_dispatched", null, {
      jobID,
      siteID: site.siteID,
      encounterID: site.encounterID,
      systemID: site.systemID,
      destinationStationID: site.destinationStationID,
      jumpCount: site.jumpCount,
      arrivesAtMs: job.arrivesAtMs,
    }, nowMs);
  }
  return job;
}

async function process(economyState, stockMap, adapters = {}, nowMs = Date.now()) {
  ensureState(economyState);
  const workBudget = adapters.workBudget || null;
  const addEvent = adapters.addEvent;
  let activeJobs = listActiveJobs(economyState);
  let capacity = Math.max(0, MAX_ACTIVE_JOBS - activeJobs.length);
  let created = 0;
  const availableSites = Object.values(economyState.salvageSites)
    .filter((site) => site && String(site.status || "") === "available")
    .sort((left, right) => toFiniteNumber(left.createdAtMs, 0) - toFiniteNumber(right.createdAtMs, 0));
  for (const site of availableSites) {
    if (capacity <= 0 || created >= MAX_NEW_JOBS_PER_PULSE) break;
    if (workBudget) await workBudget.checkpoint();
    createJob(economyState, site, nowMs, addEvent);
    capacity -= 1;
    created += 1;
  }

  activeJobs = listActiveJobs(economyState)
    .sort((left, right) => toFiniteNumber(left.createdAtMs, 0) - toFiniteNumber(right.createdAtMs, 0));
  for (const job of activeJobs) {
    if (workBudget) await workBudget.checkpoint();
    const site = economyState.salvageSites[job.siteID];
    if (!site) {
      job.status = "failed";
      job.lastError = "SALVAGE_SITE_MISSING";
      job.completedAtMs = nowMs;
      continue;
    }

    if (job.status === "outbound" && nowMs >= toFiniteNumber(job.arrivesAtMs, Infinity)) {
      job.status = "recovering";
      job.recoveryStartedAtMs = job.arrivesAtMs;
      job.recoveryCompletesAtMs = job.arrivesAtMs + site.recoveryMs;
      job.lastUpdatedAtMs = nowMs;
      site.status = "recovering";
      site.lastUpdatedAtMs = nowMs;
      if (typeof addEvent === "function") {
        addEvent("salvage_recovery_started", null, {
          jobID: job.jobID,
          siteID: site.siteID,
          systemID: site.systemID,
          recoveryCompletesAtMs: job.recoveryCompletesAtMs,
        }, nowMs);
      }
    }

    if (job.status === "recovering" && typeof adapters.observeRecovery === "function") {
      const observation = adapters.observeRecovery(site, job, nowMs) || {};
      if (observation.liveEntityID) job.liveEntityID = observation.liveEntityID;
      if (observation.wreckIDsByActorID) {
        for (const wreck of site.wrecks) {
          const wreckID = toPositiveInt(observation.wreckIDsByActorID[wreck.actorID], 0);
          if (wreckID) wreck.wreckID = wreckID;
        }
      }
    }

    if (
      job.status === "recovering" &&
      nowMs >= toFiniteNumber(job.recoveryCompletesAtMs, Infinity)
    ) {
      const allActorIDs = site.wrecks.map((wreck) => String(wreck.actorID || "")).filter(Boolean);
      const claim = typeof adapters.claimSite === "function"
        ? adapters.claimSite(site, job, nowMs) || {}
        : { recoveredActorIDs: allActorIDs, claimedByPlayerActorIDs: [] };
      const recoveredActorIDs = Array.isArray(claim.recoveredActorIDs)
        ? claim.recoveredActorIDs.map(String)
        : allActorIDs;
      const recoveredSet = new Set(recoveredActorIDs);
      const claimedByPlayerActorIDs = Array.isArray(claim.claimedByPlayerActorIDs)
        ? claim.claimedByPlayerActorIDs.map(String)
        : allActorIDs.filter((actorID) => !recoveredSet.has(actorID));
      job.recoveredActorIDs = recoveredActorIDs;
      job.claimedByPlayerActorIDs = claimedByPlayerActorIDs;
      job.outputs = aggregateRecoveredSalvage(site, recoveredActorIDs);
      job.status = "returning";
      job.recoveryClaimedAtMs = nowMs;
      job.returnsAtMs = nowMs + site.travelMs;
      job.lastUpdatedAtMs = nowMs;
      site.status = "returning";
      site.lastUpdatedAtMs = nowMs;
      for (const wreck of site.wrecks) {
        wreck.status = recoveredSet.has(String(wreck.actorID || ""))
          ? "recovered"
          : "claimed_by_player";
      }
      economyState.metrics.salvageWrecksRecovered += recoveredActorIDs.length;
      economyState.metrics.salvageWrecksClaimedByPlayers += claimedByPlayerActorIDs.length;
      if (typeof addEvent === "function") {
        addEvent("salvage_recovery_returning", null, {
          jobID: job.jobID,
          siteID: site.siteID,
          recoveredWrecks: recoveredActorIDs.length,
          playerClaimedWrecks: claimedByPlayerActorIDs.length,
          outputUnits: job.outputs.reduce((sum, entry) => sum + entry.quantity, 0),
          returnsAtMs: job.returnsAtMs,
        }, nowMs);
      }
    }

    if (job.status === "returning" && nowMs >= toFiniteNumber(job.returnsAtMs, Infinity)) {
      job.status = "delivery_pending";
      job.arrivedAtMs = job.returnsAtMs;
      job.lastUpdatedAtMs = nowMs;
    }

    if (job.status !== "delivery_pending") continue;
    const station = typeof adapters.getStation === "function"
      ? adapters.getStation(job.destinationStationID)
      : null;
    if (!station) {
      job.lastError = "SALVAGE_DESTINATION_STATION_MISSING";
      continue;
    }
    const credited = new Set((job.creditedTypeIDs || []).map((value) => toPositiveInt(value, 0)));
    const pendingCredits = [];
    for (const output of job.outputs) {
      if (credited.has(output.typeID)) continue;
      const good = typeof adapters.getGood === "function" ? adapters.getGood(output.typeID) : null;
      if (!good) {
        job.ignoredTypeIDs = [...new Set([...(job.ignoredTypeIDs || []), output.typeID])];
        continue;
      }
      pendingCredits.push({
        output,
        adjustment: {
          adjustmentID: makeSalvageAdjustmentID(economyState, job, output.typeID),
          station,
          good,
          deltaQuantity: output.quantity,
          reason: `NPC salvage recovery ${job.jobID}`,
          stockMap,
        },
      });
    }
    let creditResults = [];
    if (pendingCredits.length > 0 && typeof adapters.adjustStocks === "function") {
      creditResults = await adapters.adjustStocks(
        pendingCredits.map((entry) => entry.adjustment),
      );
    } else {
      for (const entry of pendingCredits) {
        creditResults.push(await adapters.adjustStock(entry.adjustment));
      }
    }
    let failed = false;
    for (let index = 0; index < pendingCredits.length; index += 1) {
      const result = creditResults[index];
      if (!result || result.success !== true) {
        promoteLegacyAdjustmentNamespace(economyState, job, result, nowMs);
        failed = true;
        continue;
      }
      credited.add(pendingCredits[index].output.typeID);
    }
    job.creditedTypeIDs = [...credited].sort((left, right) => left - right);
    if (failed) {
      job.lastError = "SALVAGE_MARKET_CREDIT_DEFERRED";
      continue;
    }
    const deliveredUnits = job.outputs
      .filter((entry) => credited.has(entry.typeID))
      .reduce((sum, entry) => sum + entry.quantity, 0);
    job.status = deliveredUnits > 0 ? "delivered" : "exhausted";
    job.deliveredAtMs = nowMs;
    job.completedAtMs = nowMs;
    job.lastUpdatedAtMs = nowMs;
    job.lastError = null;
    site.status = job.status;
    site.completedAtMs = nowMs;
    site.lastUpdatedAtMs = nowMs;
    if (deliveredUnits > 0) {
      economyState.metrics.salvageJobsCompleted += 1;
      economyState.metrics.salvageUnitsRecovered += deliveredUnits;
      economyState.metrics.salvageDepositsDelivered += 1;
    } else {
      economyState.metrics.salvageJobsExhausted += 1;
    }
    if (typeof addEvent === "function") {
      addEvent("salvage_recovery_delivered", null, {
        jobID: job.jobID,
        siteID: site.siteID,
        stationID: station.stationID,
        status: job.status,
        units: deliveredUnits,
        outputs: cloneValue(job.outputs),
      }, nowMs);
    }
  }

  for (const [siteID, site] of Object.entries(economyState.salvageSites)) {
    if (
      ["delivered", "exhausted", "failed"].includes(String(site && site.status || "")) &&
      toFiniteNumber(site && site.completedAtMs, nowMs) < nowMs - SITE_RETENTION_MS
    ) {
      delete economyState.salvageSites[siteID];
    }
  }
  for (const [jobID, job] of Object.entries(economyState.salvageJobs)) {
    if (
      !ACTIVE_JOB_STATES.has(String(job && job.status || "")) &&
      toFiniteNumber(job && job.completedAtMs, nowMs) < nowMs - SITE_RETENTION_MS
    ) {
      delete economyState.salvageJobs[jobID];
    }
  }
  return { created, active: listActiveJobs(economyState).length };
}

function getStatus(economyState) {
  ensureState(economyState);
  const sites = Object.values(economyState.salvageSites);
  const jobs = Object.values(economyState.salvageJobs);
  const siteStatuses = {};
  const jobStatuses = {};
  for (const site of sites) {
    const key = String(site && site.status || "unknown");
    siteStatuses[key] = (siteStatuses[key] || 0) + 1;
  }
  for (const job of jobs) {
    const key = String(job && job.status || "unknown");
    jobStatuses[key] = (jobStatuses[key] || 0) + 1;
  }
  return {
    sites: sites.length,
    jobs: jobs.length,
    activeJobs: listActiveJobs(economyState).length,
    siteStatuses,
    jobStatuses,
  };
}

module.exports = {
  ACTIVE_JOB_STATES,
  aggregateRecoveredSalvage,
  buildVictimSalvage,
  ensureState,
  getStatus,
  listActiveJobs,
  process,
  registerOpportunity,
  _testing: {
    BASE_LOCAL_TRAVEL_MS,
    PER_JUMP_TRAVEL_MS,
    BASE_RECOVERY_MS,
    PER_WRECK_RECOVERY_MS,
    createDeterministicRandom,
    getAdjustmentEpoch,
    makeSalvageAdjustmentID,
    promoteLegacyAdjustmentNamespace,
  },
};
