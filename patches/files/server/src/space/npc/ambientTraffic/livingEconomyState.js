"use strict";

const fs = require("fs");
const path = require("path");

const config = require(path.join(__dirname, "../../../config"));
const database = require(path.join(__dirname, "../../../gameStore"));
const log = require(path.join(__dirname, "../../../utils/logger"));
const telemetry = require(path.join(__dirname, "./livingEconomyTelemetry"));

const TABLE_NAME = "npcRuntimeState";
const SOURCE_JOURNAL_TABLE_NAME = "livingEconomyEventJournal";
const ROOT_PATH = "/livingEconomy";
const SCHEMA_VERSION = 3;
const LEGACY_MAX_EVENT_ROWS = 250;
const X_EVE_MAX_EVENT_ROWS = 4096;
const X_EVE_RUNTIME_EVENT_ROWS = 512;
const SOURCE_EVENT_ID_PATTERN = /^LEE-(\d{8,})$/;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceJournalError(pathArg, reason) {
  const error = new Error(
    `Living Economy source journal is invalid at ${pathArg}: ${reason}`,
  );
  error.code = "LIVING_ECONOMY_SOURCE_JOURNAL_INVALID";
  error.path = pathArg;
  error.reason = reason;
  return error;
}

function validateSourceJournal(rawState) {
  if (!Array.isArray(rawState.events)) {
    throw sourceJournalError("/events", "journal must be an array");
  }

  const seenEventIDs = new Set();
  let maximumEventNumber = 0;
  let previousEventNumber = 0;
  rawState.events.forEach((event, index) => {
    const eventPath = `/events/${index}`;
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw sourceJournalError(eventPath, "event must be an object");
    }
    const eventID = String(event.eventID == null ? "" : event.eventID);
    const eventIDMatch = SOURCE_EVENT_ID_PATTERN.exec(eventID);
    if (!eventIDMatch) {
      throw sourceJournalError(`${eventPath}/eventID`, "event ID is not canonical");
    }
    const eventNumber = Number(eventIDMatch[1]);
    if (
      !Number.isSafeInteger(eventNumber) ||
      eventNumber <= 0 ||
      eventID !== `LEE-${String(eventNumber).padStart(8, "0")}`
    ) {
      throw sourceJournalError(`${eventPath}/eventID`, "event number is invalid");
    }
    if (seenEventIDs.has(eventID)) {
      throw sourceJournalError(`${eventPath}/eventID`, "event ID is duplicated");
    }
    if (eventNumber <= previousEventNumber) {
      throw sourceJournalError(`${eventPath}/eventID`, "event IDs are out of order");
    }
    if (typeof event.kind !== "string" || event.kind.trim().length === 0) {
      throw sourceJournalError(`${eventPath}/kind`, "event kind is required");
    }
    if (!Number.isSafeInteger(event.occurredAtMs) || event.occurredAtMs < 0) {
      throw sourceJournalError(
        `${eventPath}/occurredAtMs`,
        "event timestamp must be a non-negative safe integer",
      );
    }
    seenEventIDs.add(eventID);
    maximumEventNumber = Math.max(maximumEventNumber, eventNumber);
    previousEventNumber = eventNumber;
  });

  if (
    rawState.events.length > 0 &&
    (!Number.isSafeInteger(rawState.createdAtMs) || rawState.createdAtMs <= 0)
  ) {
    throw sourceJournalError(
      "/createdAtMs",
      "a non-empty journal requires a positive source epoch",
    );
  }
  if (!Number.isSafeInteger(rawState.nextEventNumber) || rawState.nextEventNumber < 1) {
    throw sourceJournalError(
      "/nextEventNumber",
      "next event number must be a positive safe integer",
    );
  }
  if (rawState.nextEventNumber <= maximumEventNumber) {
    throw sourceJournalError(
      "/nextEventNumber",
      "next event number must be greater than every retained event",
    );
  }
}

function buildDefaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    catalogRevision: 1,
    createdAtMs: 0,
    updatedAtMs: 0,
    nextJobNumber: 1,
    nextIndustryJobNumber: 1,
    nextIndustryPilotNumber: 1,
    nextIndustryBlueprintNumber: 1,
    nextReplacementDemandNumber: 1,
    nextCampaignDemandNumber: 1,
    nextSalvageJobNumber: 1,
    nextEventNumber: 1,
    lastPulseAtMs: 0,
    jobs: {},
    miningDeposits: {},
    events: [],
    productionClocks: {},
    industryJobs: {},
    industryPilots: {},
    industryBlueprints: {},
    industryWorkforceSeededAtMs: 0,
    replacementDemands: {},
    campaignDemands: {},
    factionShipyardSeedCounters: {},
    salvageSites: {},
    salvageJobs: {},
    procurement: {
      lastReviewAtMs: 0,
      corporations: {},
      orders: {},
    },
    telemetry: telemetry.buildDefaultTelemetryState(),
    metrics: {
      jobsCreated: 0,
      jobsDelivered: 0,
      jobsLost: 0,
      jobsCancelled: 0,
      unitsReserved: 0,
      unitsDelivered: 0,
      unitsLost: 0,
      cargoVolumeReservedM3: 0,
      cargoVolumeDeliveredM3: 0,
      cargoVolumeLostM3: 0,
      jobsByLogisticsClass: {},
      deliveredByLogisticsClass: {},
      lostByLogisticsClass: {},
      unitsProduced: 0,
      productionRuns: 0,
      industryJobsInstalled: 0,
      industryJobsCompleted: 0,
      industryInputUnitsConsumed: 0,
      industryInputValueISK: 0,
      industryOutputUnitsProduced: 0,
      industryOutputValueISK: 0,
      industryAdjustmentNamespaceMigrations: 0,
      industryAdjustmentConflictsQuarantined: 0,
      industryBlueprintSecondsScheduled: 0,
      industryPilotsCreated: 0,
      industryBlueprintOriginalsAcquired: 0,
      industryBlueprintCopiesCreated: 0,
      industryBlueprintCopyRunsCreated: 0,
      industryBlueprintCopyRunsConsumed: 0,
      industryMaterialResearchJobsCompleted: 0,
      industryTimeResearchJobsCompleted: 0,
      marketAdjustments: 0,
      failedAdjustments: 0,
      reprices: 0,
      miningRuns: 0,
      oreUnitsMined: 0,
      oreVolumeMinedM3: 0,
      mineralUnitsRefined: 0,
      miningDepositsDelivered: 0,
      minerGrossMarketValue: 0,
      traderSpend: 0,
      traderRevenue: 0,
      traderGrossMargin: 0,
      traderCargoLossValue: 0,
      traderJobsValued: 0,
      procurementOrdersPlaced: 0,
      procurementOrdersRepriced: 0,
      procurementOrdersCancelled: 0,
      procurementUnitsBought: 0,
      procurementIskSpent: 0,
      procurementPlayerUnitsBought: 0,
      procurementPlayerIskSpent: 0,
      procurementWarSubsidyISK: 0,
      dynamicRoutesAssigned: 0,
      freightRepositionsAssigned: 0,
      freightRepositionsCompleted: 0,
      freightRepositionsAbandoned: 0,
      freightRepositionJumps: 0,
      replacementFreightJobsAssigned: 0,
      replacementFreightJobsDelivered: 0,
      replacementFreightUnitsAssigned: 0,
      replacementFreightUnitsDelivered: 0,
      replacementDirectFreightUnitsDelivered: 0,
      replacementInputFreightUnitsDelivered: 0,
      generalFreightJobsAssigned: 0,
      generalFreightJobsDelivered: 0,
      replacementFreightRepositionsAssigned: 0,
      replacementFreightRepositionsCompleted: 0,
      replacementFreightRepositionsAbandoned: 0,
      staleFreightJobsDetected: 0,
      freightRouteMismatchesDetected: 0,
      freightRoutesRecovered: 0,
      freightRoutesReplanned: 0,
      freightProgressWakeups: 0,
      freightRecoveryDeferred: 0,
      freightRecoveryUnloads: 0,
      freightRecoveryUnitsUnloaded: 0,
      freightRecoveryFailures: 0,
      replacementDemandsCreated: 0,
      replacementDemandsFulfilled: 0,
      replacementUnitsRequested: 0,
      replacementUnitsFulfilled: 0,
      replacementValueISK: 0,
      replacementValueFulfilledISK: 0,
      replacementHullValueISK: 0,
      replacementFittingValueISK: 0,
      replacementHullLosses: 0,
      replacementHullLossesByType: {},
      replacementDemandValidationFailures: 0,
      replacementRequirementUnitsRejected: 0,
      replacementDemandLinksReconciled: 0,
      replacementAdjustmentNamespaceMigrations: 0,
      replacementAdjustmentCollisionRetries: 0,
      freightJobCapSaturatedPulses: 0,
      industryInstallBudgetSaturatedPulses: 0,
      factionShipyardHullsSeeded: 0,
      factionShipyardSeedFailures: 0,
      factionShipyardSeedCollisionRetries: 0,
      factionSmugglerHullsDelivered: 0,
      campaignDemandsCreated: 0,
      campaignDemandsFulfilled: 0,
      campaignUnitsRequested: 0,
      campaignUnitsConsumed: 0,
      campaignSupplyValueISK: 0,
      campaignAdjustmentNamespaceMigrations: 0,
      campaignAdjustmentConflictsQuarantined: 0,
      salvageSitesCreated: 0,
      salvageJobsCreated: 0,
      salvageJobsCompleted: 0,
      salvageJobsExhausted: 0,
      salvageWrecksRecovered: 0,
      salvageWrecksClaimedByPlayers: 0,
      salvageUnitsRecovered: 0,
      salvageDepositsDelivered: 0,
    },
  };
}

function resetReplacementAdjustmentConflicts(demands) {
  // Replacement collisions heal via namespace promotion and epoch salting;
  // unlike campaign and industry, "adjustment_conflict" is not a valid
  // terminal status for a replacement demand (it would strand the held
  // flight forever). Any persisted conflict row returns to pending.
  for (const demand of Object.values(demands)) {
    if (String(demand && demand.status || "") !== "adjustment_conflict") {
      continue;
    }
    demand.status = "pending";
    demand.lastError = null;
  }
  return demands;
}

function normalizeState(rawState) {
  const defaults = buildDefaultState();
  const raw = rawState && typeof rawState === "object" ? rawState : {};
  return {
    ...defaults,
    ...cloneValue(raw),
    nextJobNumber: Math.max(1, Math.trunc(Number(raw.nextJobNumber) || 1)),
    nextIndustryJobNumber: Math.max(
      1,
      Math.trunc(Number(raw.nextIndustryJobNumber) || 1),
    ),
    nextIndustryPilotNumber: Math.max(
      1,
      Math.trunc(Number(raw.nextIndustryPilotNumber) || 1),
    ),
    nextIndustryBlueprintNumber: Math.max(
      1,
      Math.trunc(Number(raw.nextIndustryBlueprintNumber) || 1),
    ),
    nextReplacementDemandNumber: Math.max(
      1,
      Math.trunc(Number(raw.nextReplacementDemandNumber) || 1),
    ),
    nextCampaignDemandNumber: Math.max(
      1,
      Math.trunc(Number(raw.nextCampaignDemandNumber) || 1),
    ),
    nextSalvageJobNumber: Math.max(
      1,
      Math.trunc(Number(raw.nextSalvageJobNumber) || 1),
    ),
    nextEventNumber: Math.max(1, Math.trunc(Number(raw.nextEventNumber) || 1)),
    jobs: raw.jobs && typeof raw.jobs === "object" ? cloneValue(raw.jobs) : {},
    miningDeposits:
      raw.miningDeposits && typeof raw.miningDeposits === "object"
        ? cloneValue(raw.miningDeposits)
        : {},
    events: Array.isArray(raw.events)
      ? cloneValue(raw.events).slice(-(
        config.xEveEnabled === true
          ? X_EVE_RUNTIME_EVENT_ROWS
          : LEGACY_MAX_EVENT_ROWS
      ))
      : [],
    productionClocks:
      raw.productionClocks && typeof raw.productionClocks === "object"
        ? cloneValue(raw.productionClocks)
        : {},
    industryJobs:
      raw.industryJobs && typeof raw.industryJobs === "object"
        ? cloneValue(raw.industryJobs)
        : {},
    industryPilots:
      raw.industryPilots && typeof raw.industryPilots === "object"
        ? cloneValue(raw.industryPilots)
        : {},
    industryBlueprints:
      raw.industryBlueprints && typeof raw.industryBlueprints === "object"
        ? cloneValue(raw.industryBlueprints)
        : {},
    industryWorkforceSeededAtMs: Math.max(
      0,
      Number(raw.industryWorkforceSeededAtMs) || 0,
    ),
    replacementDemands: resetReplacementAdjustmentConflicts(
      raw.replacementDemands && typeof raw.replacementDemands === "object"
        ? cloneValue(raw.replacementDemands)
        : {},
    ),
    campaignDemands:
      raw.campaignDemands && typeof raw.campaignDemands === "object"
        ? cloneValue(raw.campaignDemands)
        : {},
    factionShipyardSeedCounters:
      raw.factionShipyardSeedCounters &&
      typeof raw.factionShipyardSeedCounters === "object"
        ? cloneValue(raw.factionShipyardSeedCounters)
        : {},
    salvageSites:
      raw.salvageSites && typeof raw.salvageSites === "object"
        ? cloneValue(raw.salvageSites)
        : {},
    salvageJobs:
      raw.salvageJobs && typeof raw.salvageJobs === "object"
        ? cloneValue(raw.salvageJobs)
        : {},
    procurement: {
      ...defaults.procurement,
      ...(raw.procurement && typeof raw.procurement === "object"
        ? cloneValue(raw.procurement)
        : {}),
      corporations:
        raw.procurement && raw.procurement.corporations &&
        typeof raw.procurement.corporations === "object"
          ? cloneValue(raw.procurement.corporations)
          : {},
      orders:
        raw.procurement && raw.procurement.orders &&
        typeof raw.procurement.orders === "object"
          ? cloneValue(raw.procurement.orders)
          : {},
    },
    telemetry: telemetry.normalizeTelemetryState(raw.telemetry),
    metrics: {
      ...defaults.metrics,
      ...(raw.metrics && typeof raw.metrics === "object" ? cloneValue(raw.metrics) : {}),
    },
  };
}

// A rebuild-from-defaults wipes the replacement backlog, releases every held
// flight, and silently invalidates any in-progress observation — it has struck
// three times (2026-07-27) on stress-boot/abort cycles. It must never again be
// silent: log at ERROR with an unmistakable marker, and preserve whatever
// document was rejected so the root cause can be diagnosed after the fact.
function reportDefaultStateRebuild(reason, rejectedData) {
  try {
    log.error(
      "[LivingEconomyState] REBUILDING FROM DEFAULTS — the persisted living-economy " +
      `state was unusable (${reason}). The replacement backlog and economy metrics ` +
      "reset; universe state, accounts, and market stock are unaffected.",
    );
  } catch (error) {
    /* logging must never block the fallback */
  }
  if (rejectedData === undefined || rejectedData === null) return;
  try {
    const diagnosticsDir = process.env.EVEJS_GAMESTORE_DATA_DIR
      ? path.resolve(process.env.EVEJS_GAMESTORE_DATA_DIR, "..", "diagnostics")
      : path.join(__dirname, "../../../../..", "_local", "diagnostics");
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rejectedPath = path.join(
      diagnosticsDir,
      `living-economy-rejected-state-${stamp}.json`,
    );
    fs.writeFileSync(rejectedPath, JSON.stringify(rejectedData, null, 2), "utf8");
    log.error(`[LivingEconomyState] Rejected state document preserved at ${rejectedPath}`);
  } catch (error) {
    try {
      log.error(
        `[LivingEconomyState] Failed to preserve the rejected state document: ${error.message}`,
      );
    } catch (ignored) {
      /* best-effort */
    }
  }
}

function readState(options = {}) {
  const result = database.read(TABLE_NAME, ROOT_PATH);
  if (!result || result.success !== true) {
    if (result && ["ENTRY_NOT_FOUND", "TABLE_NOT_FOUND"].includes(result.errorMsg)) {
      return buildDefaultState();
    }
    if (options.strict === true) {
      const error = new Error(
        result && result.errorMsg || "LIVING_ECONOMY_STATE_READ_FAILED",
      );
      error.code = "LIVING_ECONOMY_STATE_READ_FAILED";
      error.storeError = result && result.errorMsg || "UNKNOWN";
      throw error;
    }
    reportDefaultStateRebuild(
      `store read failed: ${result && result.errorMsg || "UNKNOWN"}`,
      result && result.data,
    );
    return buildDefaultState();
  }
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    if (options.strict === true) {
      const error = new Error("LIVING_ECONOMY_STATE_INVALID");
      error.code = "LIVING_ECONOMY_STATE_INVALID";
      throw error;
    }
    reportDefaultStateRebuild(
      `document shape invalid: ${Array.isArray(result.data) ? "array" : typeof result.data}`,
      result.data,
    );
    return buildDefaultState();
  }
  if (options.strict === true) {
    validateSourceJournal(result.data);
  }
  return normalizeState(result.data);
}

function writeState(state, options = {}) {
  const nextState = options.borrowReference === true && state && typeof state === "object"
    ? state
    : options.trustedNormalizedState === true
    ? cloneValue(state)
    : normalizeState(state);
  nextState.schemaVersion = SCHEMA_VERSION;
  return database.write(
    TABLE_NAME,
    ROOT_PATH,
    nextState,
    options.borrowReference === true ? { ...options, force: true } : options,
  );
}

function readSourceJournal(options = {}) {
  const metaResult = database.read(SOURCE_JOURNAL_TABLE_NAME, "/meta");
  const eventsResult = database.read(SOURCE_JOURNAL_TABLE_NAME, "/eventsByID");
  const missing = (result) => result && ["ENTRY_NOT_FOUND", "TABLE_NOT_FOUND"].includes(
    result.errorMsg,
  );
  if (missing(metaResult) && missing(eventsResult)) {
    return { exists: false, sourceEpochMs: 0, nextEventNumber: 1, events: [] };
  }
  if (!metaResult || metaResult.success !== true || !eventsResult || eventsResult.success !== true) {
    const error = sourceJournalError(
      "/",
      metaResult && metaResult.errorMsg || eventsResult && eventsResult.errorMsg ||
        "journal rows are incomplete",
    );
    if (options.strict === true) throw error;
    return { exists: false, sourceEpochMs: 0, nextEventNumber: 1, events: [] };
  }
  const meta = metaResult.data;
  const eventsByID = eventsResult.data;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw sourceJournalError("/meta", "metadata must be an object");
  }
  if (!eventsByID || typeof eventsByID !== "object" || Array.isArray(eventsByID)) {
    throw sourceJournalError("/eventsByID", "event rows must be an object");
  }
  const events = Object.entries(eventsByID)
    .map(([eventID, event]) => {
      if (!event || typeof event !== "object" || event.eventID !== eventID) {
        throw sourceJournalError(`/eventsByID/${eventID}`, "event key does not match eventID");
      }
      return cloneValue(event);
    })
    .sort((left, right) => {
      const leftMatch = SOURCE_EVENT_ID_PATTERN.exec(String(left.eventID || ""));
      const rightMatch = SOURCE_EVENT_ID_PATTERN.exec(String(right.eventID || ""));
      return Number(leftMatch && leftMatch[1] || 0) - Number(rightMatch && rightMatch[1] || 0);
    });
  const snapshot = {
    createdAtMs: Number(meta.sourceEpochMs),
    nextEventNumber: Number(meta.nextEventNumber),
    events,
  };
  validateSourceJournal(snapshot);
  return {
    exists: true,
    sourceEpochMs: snapshot.createdAtMs,
    nextEventNumber: snapshot.nextEventNumber,
    events,
  };
}

function replaceSourceJournal(state, options = {}) {
  const snapshot = {
    createdAtMs: Number(state && state.createdAtMs),
    nextEventNumber: Number(state && state.nextEventNumber),
    events: cloneValue(state && state.events || []),
  };
  validateSourceJournal(snapshot);
  const eventsByID = Object.fromEntries(snapshot.events.map((event) => [event.eventID, event]));
  const metaResult = database.write(SOURCE_JOURNAL_TABLE_NAME, "/meta", {
    schemaVersion: 1,
    sourceEpochMs: snapshot.createdAtMs,
    nextEventNumber: snapshot.nextEventNumber,
    updatedAtMs: Math.max(0, Math.trunc(Number(options.nowMs) || Date.now())),
  });
  if (!metaResult || metaResult.success !== true) return metaResult;
  const eventsResult = database.write(
    SOURCE_JOURNAL_TABLE_NAME,
    "/eventsByID",
    eventsByID,
  );
  if (!eventsResult || eventsResult.success !== true) return eventsResult;
  if (options.durable === true) {
    return database.flushTableSync(SOURCE_JOURNAL_TABLE_NAME);
  }
  return { success: true, events: snapshot.events.length };
}

function appendSourceEvent(event, options = {}) {
  const snapshot = {
    createdAtMs: Number(options.sourceEpochMs),
    nextEventNumber: Number(options.nextEventNumber),
    events: [cloneValue(event)],
  };
  validateSourceJournal(snapshot);
  const writeResult = database.write(
    SOURCE_JOURNAL_TABLE_NAME,
    `/eventsByID/${event.eventID}`,
    event,
  );
  if (!writeResult || writeResult.success !== true) return writeResult;
  for (const eventID of Array.isArray(options.removedEventIDs) ? options.removedEventIDs : []) {
    if (!SOURCE_EVENT_ID_PATTERN.test(String(eventID || ""))) {
      return { success: false, errorMsg: "LIVING_ECONOMY_SOURCE_EVENT_ID_INVALID" };
    }
    const removeResult = database.remove(
      SOURCE_JOURNAL_TABLE_NAME,
      `/eventsByID/${eventID}`,
    );
    if (
      !removeResult ||
      (removeResult.success !== true && removeResult.errorMsg !== "ENTRY_NOT_FOUND")
    ) {
      return removeResult;
    }
  }
  return database.write(SOURCE_JOURNAL_TABLE_NAME, "/meta", {
    schemaVersion: 1,
    sourceEpochMs: snapshot.createdAtMs,
    nextEventNumber: snapshot.nextEventNumber,
    updatedAtMs: Math.max(0, Math.trunc(Number(options.nowMs) || Date.now())),
  });
}

function flushSourceJournalDurably(options = {}) {
  let result = options.background === false
    ? database.flushTableSync(SOURCE_JOURNAL_TABLE_NAME)
    : database.flushTableAsync(SOURCE_JOURNAL_TABLE_NAME);
  if (
    options.background !== false &&
    result &&
    (result.blocked === true || result.pendingDirty === true)
  ) {
    result = database.flushTableSync(SOURCE_JOURNAL_TABLE_NAME);
  }
  return result;
}

function flushDurably() {
  // This is the emergency source-journal backup used only after the X-Eve
  // circuit rejects an event. It must be on disk before production pauses.
  return database.flushTableSync(TABLE_NAME);
}

function suspendPersistence(reason) {
  return database.suspendTableFlush(TABLE_NAME, reason);
}

function removeState() {
  return database.remove(TABLE_NAME, ROOT_PATH);
}

module.exports = {
  SCHEMA_VERSION,
  SOURCE_JOURNAL_TABLE_NAME,
  appendSourceEvent,
  buildDefaultState,
  flushSourceJournalDurably,
  flushDurably,
  readSourceJournal,
  readState,
  replaceSourceJournal,
  removeState,
  suspendPersistence,
  writeState,
};
