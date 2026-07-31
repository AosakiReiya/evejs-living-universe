"use strict";

const OBSERVATION_SCHEMA_VERSION = 3;

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toNonNegativeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function toNonNegativeInt(value) {
  return Math.max(0, Math.trunc(toNonNegativeNumber(value)));
}

function roundMoney(value) {
  return Math.round((toNonNegativeNumber(value) + Number.EPSILON) * 100) / 100;
}

function createActivityCounts() {
  return {
    manufacturing: 0,
    copying: 0,
    research_material: 0,
    research_time: 0,
    other: 0,
  };
}

function createEmptyObservation() {
  return {
    schemaVersion: OBSERVATION_SCHEMA_VERSION,
    observedEvents: 0,
    firstObservedAtMs: 0,
    lastObservedAtMs: 0,
    firstOccurredAtMs: 0,
    lastOccurredAtMs: 0,
    byEventType: {},
    mining: {
      arrivals: 0,
      oreUnitsArrived: 0,
      depositsDelivered: 0,
      mineralUnitsDelivered: 0,
    },
    freight: {
      jobsCreated: 0,
      reservations: 0,
      unitsReserved: 0,
      deliveries: 0,
      unitsDelivered: 0,
      closures: 0,
      unitsLost: 0,
    },
    industry: {
      jobsStarted: 0,
      jobsCompleted: 0,
      startedByActivity: createActivityCounts(),
      completedByActivity: createActivityCounts(),
      manufacturingUnitsScheduled: 0,
      manufacturingUnitsProduced: 0,
      manufacturingStartsMissingQuantity: 0,
      manufacturingCompletionsMissingQuantity: 0,
      inputValueISK: 0,
      outputValueISK: 0,
    },
    procurement: {
      ordersPlaced: 0,
      unitsRequested: 0,
      requestedValueISK: 0,
      fills: 0,
      unitsBought: 0,
      spentISK: 0,
    },
    replacement: {
      demandsCreated: 0,
      demandsFulfilled: 0,
      unitsRequested: 0,
      unitsFulfilled: 0,
      requestedValueISK: 0,
    },
    campaign: {
      demandsCreated: 0,
      demandsFulfilled: 0,
      unitsRequested: 0,
      unitsConsumed: 0,
      requestedValueISK: 0,
    },
    salvage: {
      sitesCreated: 0,
      crewsDispatched: 0,
      recoveriesStarted: 0,
      returnTrips: 0,
      depositsDelivered: 0,
      wrecksRecovered: 0,
      wrecksClaimedByPlayers: 0,
      unitsDelivered: 0,
    },
  };
}

function normalizeActivity(value) {
  const activity = String(value == null ? "" : value).trim().toLowerCase();
  return ["manufacturing", "copying", "research_material", "research_time"]
    .includes(activity) ? activity : "other";
}

function addCounter(target, key, value = 1) {
  target[key] = toNonNegativeNumber(target[key]) + toNonNegativeNumber(value);
}

function projectObservedEvent(message, observedAtMs = Date.now()) {
  const request = message && message.request && typeof message.request === "object"
    ? message.request
    : message || {};
  const eventType = String(request.eventType || message && message.eventType || "event")
    .trim().toLowerCase() || "event";
  const payload = request.payload && typeof request.payload === "object"
    ? request.payload
    : message && message.payload && typeof message.payload === "object"
      ? message.payload
      : {};
  const occurredAtMs = toNonNegativeInt(request.occurredAtMs || message && message.occurredAtMs);
  const projection = createEmptyObservation();
  projection.observedEvents = 1;
  projection.firstObservedAtMs = toNonNegativeInt(observedAtMs);
  projection.lastObservedAtMs = projection.firstObservedAtMs;
  projection.firstOccurredAtMs = occurredAtMs;
  projection.lastOccurredAtMs = occurredAtMs;
  projection.byEventType[eventType] = 1;

  switch (eventType) {
    case "mining_arrival":
      projection.mining.arrivals = 1;
      projection.mining.oreUnitsArrived = toNonNegativeInt(payload.oreUnits);
      break;
    case "mining_deposit_delivered":
      projection.mining.depositsDelivered = 1;
      projection.mining.mineralUnitsDelivered = toNonNegativeInt(payload.mineralUnits);
      break;
    case "job_created":
      projection.freight.jobsCreated = 1;
      break;
    case "cargo_reserved":
      projection.freight.reservations = 1;
      projection.freight.unitsReserved = toNonNegativeInt(payload.quantity);
      break;
    case "job_delivered":
      projection.freight.deliveries = 1;
      projection.freight.unitsDelivered = toNonNegativeInt(payload.quantity);
      break;
    case "job_closed":
      projection.freight.closures = 1;
      if (["lost", "destroyed"].includes(String(payload.status || "").toLowerCase())) {
        projection.freight.unitsLost = toNonNegativeInt(payload.quantity);
      }
      break;
    case "industry_job_started": {
      const activity = normalizeActivity(payload.activity);
      projection.industry.jobsStarted = 1;
      projection.industry.startedByActivity[activity] = 1;
      if (activity === "manufacturing") {
        const quantity = toNonNegativeInt(
          payload.quantity || payload.productQuantity,
        );
        projection.industry.manufacturingUnitsScheduled = quantity;
        projection.industry.manufacturingStartsMissingQuantity = quantity > 0 ? 0 : 1;
        projection.industry.inputValueISK = roundMoney(payload.inputValueISK);
      }
      break;
    }
    case "industry_job_completed": {
      const activity = normalizeActivity(payload.activity);
      projection.industry.jobsCompleted = 1;
      projection.industry.completedByActivity[activity] = 1;
      if (activity === "manufacturing") {
        const quantity = toNonNegativeInt(
          payload.quantity || payload.productQuantity,
        );
        projection.industry.manufacturingUnitsProduced = quantity;
        projection.industry.manufacturingCompletionsMissingQuantity = quantity > 0 ? 0 : 1;
        projection.industry.outputValueISK = roundMoney(payload.outputValueISK);
      }
      break;
    }
    case "procurement_order_placed":
      projection.procurement.ordersPlaced = 1;
      projection.procurement.unitsRequested = toNonNegativeInt(payload.quantity);
      projection.procurement.requestedValueISK = roundMoney(
        toNonNegativeNumber(payload.quantity) * toNonNegativeNumber(payload.price),
      );
      break;
    case "procurement_fill":
      projection.procurement.fills = 1;
      projection.procurement.unitsBought = toNonNegativeInt(payload.quantity);
      projection.procurement.spentISK = roundMoney(
        toNonNegativeNumber(payload.quantity) * toNonNegativeNumber(payload.price),
      );
      break;
    case "replacement_demand_created":
      projection.replacement.demandsCreated = 1;
      projection.replacement.unitsRequested = toNonNegativeInt(payload.requestedUnits);
      projection.replacement.requestedValueISK = roundMoney(payload.valueISK);
      break;
    case "replacement_demand_fulfilled":
      projection.replacement.demandsFulfilled = 1;
      projection.replacement.unitsFulfilled = toNonNegativeInt(payload.requestedUnits);
      break;
    case "campaign_supply_demand_created":
      projection.campaign.demandsCreated = 1;
      projection.campaign.unitsRequested = toNonNegativeInt(payload.requestedUnits);
      projection.campaign.requestedValueISK = roundMoney(payload.valueISK);
      break;
    case "campaign_supply_demand_fulfilled":
      projection.campaign.demandsFulfilled = 1;
      projection.campaign.unitsConsumed = toNonNegativeInt(payload.requestedUnits);
      break;
    case "salvage_site_created":
      projection.salvage.sitesCreated = 1;
      break;
    case "salvage_recovery_dispatched":
      projection.salvage.crewsDispatched = 1;
      break;
    case "salvage_recovery_started":
      projection.salvage.recoveriesStarted = 1;
      break;
    case "salvage_recovery_returning":
      projection.salvage.returnTrips = 1;
      projection.salvage.wrecksRecovered = toNonNegativeInt(payload.recoveredWrecks);
      projection.salvage.wrecksClaimedByPlayers = toNonNegativeInt(payload.playerClaimedWrecks);
      break;
    case "salvage_recovery_delivered":
      projection.salvage.depositsDelivered = 1;
      projection.salvage.unitsDelivered = toNonNegativeInt(payload.units);
      break;
    default:
      break;
  }
  return projection;
}

function mergeEarliest(current, incoming) {
  const left = toNonNegativeInt(current);
  const right = toNonNegativeInt(incoming);
  if (!left) return right;
  if (!right) return left;
  return Math.min(left, right);
}

function mergeLatest(current, incoming) {
  return Math.max(toNonNegativeInt(current), toNonNegativeInt(incoming));
}

function applyObservationProjection(observation, projection) {
  const target = observation || createEmptyObservation();
  const delta = projection || createEmptyObservation();
  target.salvage = {
    ...createEmptyObservation().salvage,
    ...(target.salvage && typeof target.salvage === "object" ? target.salvage : {}),
  };
  addCounter(target, "observedEvents", delta.observedEvents);
  target.firstObservedAtMs = mergeEarliest(target.firstObservedAtMs, delta.firstObservedAtMs);
  target.lastObservedAtMs = mergeLatest(target.lastObservedAtMs, delta.lastObservedAtMs);
  target.firstOccurredAtMs = mergeEarliest(target.firstOccurredAtMs, delta.firstOccurredAtMs);
  target.lastOccurredAtMs = mergeLatest(target.lastOccurredAtMs, delta.lastOccurredAtMs);
  for (const [eventType, count] of Object.entries(delta.byEventType || {})) {
    addCounter(target.byEventType, eventType, count);
  }
  for (const group of ["mining", "freight", "procurement", "replacement", "campaign", "salvage"]) {
    for (const [key, value] of Object.entries(delta[group] || {})) {
      addCounter(target[group], key, value);
    }
  }
  for (const key of [
    "jobsStarted",
    "jobsCompleted",
    "manufacturingUnitsScheduled",
    "manufacturingUnitsProduced",
    "manufacturingStartsMissingQuantity",
    "manufacturingCompletionsMissingQuantity",
    "inputValueISK",
    "outputValueISK",
  ]) {
    addCounter(target.industry, key, delta.industry && delta.industry[key]);
  }
  for (const group of ["startedByActivity", "completedByActivity"]) {
    for (const [activity, count] of Object.entries(delta.industry && delta.industry[group] || {})) {
      addCounter(target.industry[group], activity, count);
    }
  }
  for (const [group, keys] of Object.entries({
    industry: ["inputValueISK", "outputValueISK"],
    procurement: ["requestedValueISK", "spentISK"],
    replacement: ["requestedValueISK"],
    campaign: ["requestedValueISK"],
  })) {
    for (const key of keys) target[group][key] = roundMoney(target[group][key]);
  }
  return target;
}

function buildObservationFromReceipts(receipts = []) {
  const observation = createEmptyObservation();
  for (const receipt of receipts) {
    if (!receipt || receipt.receiptType !== "inbox_event" || receipt.status !== "observed") {
      continue;
    }
    applyObservationProjection(
      observation,
      receipt.observationProjection &&
        receipt.observationProjection.schemaVersion === OBSERVATION_SCHEMA_VERSION
        ? receipt.observationProjection
        : projectObservedEvent(receipt, receipt.recordedAtMs),
    );
  }
  return observation;
}

function getObservationSnapshot(observation) {
  const snapshot = {
    ...createEmptyObservation(),
    ...cloneValue(observation || {}),
  };
  snapshot.salvage = {
    ...createEmptyObservation().salvage,
    ...(snapshot.salvage && typeof snapshot.salvage === "object" ? snapshot.salvage : {}),
  };
  const manufacturingJobBalanceReliable = (
    snapshot.industry.startedByActivity.manufacturing >=
    snapshot.industry.completedByActivity.manufacturing
  );
  const manufacturingUnitBalanceReliable = (
    snapshot.industry.manufacturingStartsMissingQuantity === 0 &&
    snapshot.industry.manufacturingCompletionsMissingQuantity === 0 &&
    snapshot.industry.manufacturingUnitsScheduled >=
      snapshot.industry.manufacturingUnitsProduced
  );
  const warnings = [];
  if (!manufacturingJobBalanceReliable) {
    warnings.push("manufacturing_completion_predates_observed_start");
  }
  if (snapshot.industry.manufacturingStartsMissingQuantity > 0) {
    warnings.push("historical_manufacturing_starts_lack_quantity");
  }
  if (snapshot.industry.manufacturingCompletionsMissingQuantity > 0) {
    warnings.push("historical_manufacturing_completions_lack_quantity");
  }
  if (!manufacturingUnitBalanceReliable && warnings.length === 0) {
    warnings.push("manufacturing_output_predates_observed_input");
  }
  snapshot.coverage = {
    manufacturingJobBalanceReliable,
    manufacturingUnitBalanceReliable,
    warnings,
  };
  snapshot.pipeline = {
    freightUnitsInTransit: Math.max(
      0,
      snapshot.freight.unitsReserved - snapshot.freight.unitsDelivered - snapshot.freight.unitsLost,
    ),
    manufacturingJobsRunning: manufacturingJobBalanceReliable
      ? snapshot.industry.startedByActivity.manufacturing -
        snapshot.industry.completedByActivity.manufacturing
      : null,
    manufacturingUnitsOutstanding: manufacturingUnitBalanceReliable
      ? snapshot.industry.manufacturingUnitsScheduled -
        snapshot.industry.manufacturingUnitsProduced
      : null,
    procurementUnitsUnfilled: Math.max(
      0,
      snapshot.procurement.unitsRequested - snapshot.procurement.unitsBought,
    ),
    replacementUnitsOutstanding: Math.max(
      0,
      snapshot.replacement.unitsRequested - snapshot.replacement.unitsFulfilled,
    ),
    campaignUnitsOutstanding: Math.max(
      0,
      snapshot.campaign.unitsRequested - snapshot.campaign.unitsConsumed,
    ),
    salvageCrewsActive: Math.max(
      0,
      snapshot.salvage.crewsDispatched - snapshot.salvage.depositsDelivered,
    ),
  };
  return snapshot;
}

module.exports = {
  applyObservationProjection,
  buildObservationFromReceipts,
  createEmptyObservation,
  getObservationSnapshot,
  projectObservedEvent,
};
