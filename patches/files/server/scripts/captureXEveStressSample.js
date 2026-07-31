"use strict";

const fs = require("fs");
const path = require("path");

const telemetryPath =
  process.argv[2] ||
  path.join(__dirname, "../../_local/runtime-performance/latest.json");
const snapshot = JSON.parse(fs.readFileSync(telemetryPath, "utf8"));
const nowMs = Date.now();

function valueAt(path, fallback = null) {
  let value = snapshot;
  for (const key of path) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) {
      return fallback;
    }
    value = value[key];
  }
  return value;
}

function hasAt(path) {
  let value = snapshot;
  for (const key of path) {
    if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) {
      return false;
    }
    value = value[key];
  }
  return value !== undefined && value !== null;
}

function numberAt(path, fallback = 0) {
  const value = Number(valueAt(path, fallback));
  return Number.isFinite(value) ? value : fallback;
}

function objectAt(path) {
  const value = valueAt(path, {});
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function percentage(numerator, denominator) {
  const bottom = Number(denominator);
  if (!Number.isFinite(bottom) || bottom <= 0) return 0;
  return Number(((Number(numerator) || 0) * 100 / bottom).toFixed(3));
}

function bytesToMiB(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? Number((numeric / 1024 / 1024).toFixed(2))
    : null;
}

const p95Ms = numberAt(["runtimeTick", "intervalMs", "p95"]);
const maximumMs = numberAt(["runtimeTick", "intervalMs", "maximum"]);
const cpuOneCorePercent = numberAt(["process", "cpu", "oneCorePercent"]);
const cpuMachinePercent = numberAt(["process", "cpu", "machinePercent"]);
const rssMiB = bytesToMiB(valueAt(["process", "rssBytes"]));
const backlogTotal = numberAt(["xEve", "scheduler", "backlogTotal"]);
const oldestOverdueMs = numberAt(["xEve", "scheduler", "oldestOverdueMs"]);
const failedJobs = numberAt(["xEve", "scheduler", "metrics", "failedJobs"]);
const deadLetterJobs = numberAt(["xEve", "scheduler", "metrics", "deadLetterJobs"]);
const quarantinedJobs = numberAt(["xEve", "scheduler", "metrics", "quarantinedJobs"]);
const uncertainJobs = numberAt(["xEve", "scheduler", "metrics", "uncertainJobs"]);
const persistenceHealthy = valueAt(["xEve", "scheduler", "persistenceHealthy"], false);
const eventCircuitState = String(
  valueAt(["livingUniverse", "economy", "eventBridge", "state"], "unknown"),
);
const productionPaused = valueAt(
  ["livingUniverse", "economy", "eventBridge", "productionPaused"],
  true,
);
const failedAdjustments = numberAt([
  "livingUniverse",
  "economy",
  "metrics",
  "failedAdjustments",
]);
const marketBatchesAttempted = numberAt([
  "livingUniverse",
  "economy",
  "marketBatches",
  "batchesAttempted",
]);
const marketBatchesSucceeded = numberAt([
  "livingUniverse",
  "economy",
  "marketBatches",
  "batchesSucceeded",
]);
const marketBatchFallbacks = numberAt([
  "livingUniverse",
  "economy",
  "marketBatches",
  "batchFallbacks",
]);
const marketAdjustmentsSubmitted = numberAt([
  "livingUniverse",
  "economy",
  "marketBatches",
  "adjustmentsSubmitted",
]);
const marketLastBatchError = valueAt([
  "livingUniverse",
  "economy",
  "marketBatches",
  "lastBatchError",
], "");
const freshnessSeconds = Number.isFinite(Number(snapshot.capturedAtMs))
  ? Number(((nowMs - Number(snapshot.capturedAtMs)) / 1_000).toFixed(3))
  : null;
const replacementUnitsRequested = numberAt([
  "livingUniverse",
  "economy",
  "metrics",
  "replacementUnitsRequested",
]);
const replacementUnitsFulfilled = numberAt([
  "livingUniverse",
  "economy",
  "metrics",
  "replacementUnitsFulfilled",
]);
const replacementDemandsCreated = numberAt([
  "livingUniverse",
  "economy",
  "metrics",
  "replacementDemandsCreated",
]);
const replacementDemandsFulfilled = numberAt([
  "livingUniverse",
  "economy",
  "metrics",
  "replacementDemandsFulfilled",
]);
const capabilityChecks = {
  replacementHolds: hasAt([
    "livingUniverse",
    "replacementHolds",
    "activeFlights",
  ]),
  replacementCoverage: hasAt([
    "livingUniverse",
    "replacementCoverage",
    "actorsWithGaps",
  ]),
  conflictLossSource: hasAt([
    "livingUniverse",
    "metrics",
    "conflictShipLosses",
  ]),
  physicalLossSource: hasAt([
    "livingUniverse",
    "metrics",
    "physicalShipLosses",
  ]),
  shipLossTypeMap: hasAt([
    "livingUniverse",
    "metrics",
    "shipLossesByType",
  ]),
  replacementPendingUnits: hasAt([
    "livingUniverse",
    "economy",
    "replacements",
    "pendingUnits",
  ]),
  replacementPendingValue: hasAt([
    "livingUniverse",
    "economy",
    "replacements",
    "pendingValueISK",
  ]),
  replacementOldestAge: hasAt([
    "livingUniverse",
    "economy",
    "replacements",
    "oldestPendingAgeMs",
  ]),
  replacementHullLossMap: hasAt([
    "livingUniverse",
    "economy",
    "metrics",
    "replacementHullLossesByType",
  ]),
  replacementValueFulfilled: hasAt([
    "livingUniverse",
    "economy",
    "metrics",
    "replacementValueFulfilledISK",
  ]),
  replacementValidationFailures: hasAt([
    "livingUniverse",
    "economy",
    "metrics",
    "replacementDemandValidationFailures",
  ]),
  replacementLinksReconciled: hasAt([
    "livingUniverse",
    "economy",
    "metrics",
    "replacementDemandLinksReconciled",
  ]),
  replacementDemandCoverageByKind: hasAt([
    "livingUniverse",
    "economy",
    "demandCoverage",
    "byKind",
  ]),
  freightReplacementPriority: hasAt([
    "livingUniverse",
    "economy",
    "freight",
    "replacementPriority",
    "jobsAssigned",
  ]),
  freightRecovery: hasAt([
    "livingUniverse",
    "economy",
    "freight",
    "recovery",
    "detected",
  ]),
  replacementFreightRepositionsAssigned: hasAt([
    "livingUniverse",
    "economy",
    "metrics",
    "replacementFreightRepositionsAssigned",
  ]),
  replacementFreightRepositionsCompleted: hasAt([
    "livingUniverse",
    "economy",
    "metrics",
    "replacementFreightRepositionsCompleted",
  ]),
  replacementSchedulerLane: hasAt([
    "livingUniverse",
    "scheduler",
    "replacementPriorityQueueSize",
  ]) && hasAt([
    "livingUniverse",
    "scheduler",
    "metrics",
    "replacementPriorityDueFlightsProcessed",
  ]),
};
const missingCapabilities = Object.entries(capabilityChecks)
  .filter(([, available]) => available !== true)
  .map(([name]) => name);

const warnings = [];
const critical = [];
if (freshnessSeconds == null || freshnessSeconds > 30) {
  critical.push(`telemetry stale ${freshnessSeconds == null ? "unknown" : freshnessSeconds}s`);
}
if (p95Ms >= 250) critical.push(`tick p95 ${p95Ms}ms`);
else if (p95Ms >= 130) warnings.push(`tick p95 ${p95Ms}ms`);
if (maximumMs >= 5_000) critical.push(`tick maximum ${maximumMs}ms`);
else if (maximumMs >= 3_000) warnings.push(`tick maximum ${maximumMs}ms`);
if (cpuOneCorePercent >= 95) critical.push(`CPU ${cpuOneCorePercent}% of one core`);
else if (cpuOneCorePercent >= 85) warnings.push(`CPU ${cpuOneCorePercent}% of one core`);
if (cpuMachinePercent >= 85) critical.push(`machine CPU ${cpuMachinePercent}%`);
else if (cpuMachinePercent >= 70) warnings.push(`machine CPU ${cpuMachinePercent}%`);
if (rssMiB != null && rssMiB >= 6_144) critical.push(`RSS ${rssMiB}MiB`);
// A stalled economy pulse silences staging/freight/industry while event-driven
// counters keep moving — surfaced here so a run can never again look healthy
// through two hours of dead pulses (market-daemon outage class, 2026-07-27).
const consecutivePulseFailures = numberAt([
  "livingUniverse", "economy", "pulseTiming", "consecutivePulseFailures",
]);
if (consecutivePulseFailures >= 4) {
  critical.push(`economy pulses failing ${consecutivePulseFailures}x consecutively`);
} else if (consecutivePulseFailures >= 2) {
  warnings.push(`economy pulses failing ${consecutivePulseFailures}x consecutively`);
}
if (backlogTotal >= 10_000) critical.push(`X-Eve backlog ${backlogTotal}`);
else if (backlogTotal >= 5_000) warnings.push(`X-Eve backlog ${backlogTotal}`);
if (oldestOverdueMs >= 3 * 60 * 60 * 1_000) {
  critical.push(`oldest X-Eve work ${Math.round(oldestOverdueMs / 60_000)}m`);
} else if (oldestOverdueMs >= 60 * 60 * 1_000) {
  warnings.push(`oldest X-Eve work ${Math.round(oldestOverdueMs / 60_000)}m`);
}
if (failedJobs + deadLetterJobs + quarantinedJobs + uncertainJobs > 0) {
  critical.push(
    `X-Eve failures failed=${failedJobs} dead=${deadLetterJobs} ` +
      `quarantined=${quarantinedJobs} uncertain=${uncertainJobs}`,
  );
}
if (persistenceHealthy !== true) critical.push("X-Eve persistence unhealthy");
if (eventCircuitState !== "closed") critical.push(`event circuit ${eventCircuitState}`);
if (productionPaused === true) critical.push("economy production paused");
if (numberAt(["livingUniverse", "materializedShips"]) > 0) {
  warnings.push("materialized NPC ships detected during unattended stress run");
}
if (missingCapabilities.length > 0) {
  critical.push(
    `telemetry capabilities missing: ${missingCapabilities.join(", ")}`,
  );
}
if (
  numberAt(["livingUniverse", "replacementCoverage", "actorsWithGaps"]) > 0
) {
  critical.push(
    "active NPC replacement packages have uncatalogued requirements",
  );
}
if (
  numberAt([
    "livingUniverse",
    "economy",
    "metrics",
    "replacementDemandValidationFailures",
  ]) > 0
) {
  warnings.push("historical replacement demand validation failures recorded");
}

const severity = critical.length > 0
  ? "critical"
  : warnings.length > 0
    ? "warning"
    : "healthy";

const report = {
  schemaVersion: 3,
  sampledAt: new Date(nowMs).toISOString(),
  capturedAt: snapshot.capturedAt || null,
  capturedAtMs: numberAt(["capturedAtMs"]),
  freshnessSeconds,
  severity,
  warnings,
  critical,
  capabilities: {
    complete: missingCapabilities.length <= 0,
    checks: capabilityChecks,
    missing: missingCapabilities,
  },
  process: {
    pid: valueAt(["process", "pid"]),
    uptimeSeconds: numberAt(["process", "uptimeSeconds"]),
    cpuOneCorePercent,
    cpuMachinePercent,
    eventLoopUtilizationPercent: numberAt([
      "process",
      "cpu",
      "eventLoopUtilizationPercent",
    ]),
    rssMiB,
    heapUsedMiB: bytesToMiB(valueAt(["process", "heapUsedBytes"])),
  },
  tick: {
    averageMs: numberAt(["runtimeTick", "intervalMs", "average"]),
    p95Ms,
    maximumMs,
    p95FromBaselineMs: Number((p95Ms - 100).toFixed(3)),
    p95HeadroomTo130Ms: Number((130 - p95Ms).toFixed(3)),
    workAverageMs: numberAt(["runtimeTick", "workMs", "average"]),
    workP95Ms: numberAt(["runtimeTick", "workMs", "p95"]),
    workMaximumMs: numberAt(["runtimeTick", "workMs", "maximum"]),
  },
  livingUniverse: {
    actors: numberAt(["livingUniverse", "actorCount"]),
    flights: numberAt(["livingUniverse", "flightCount"]),
    materializedShips: numberAt(["livingUniverse", "materializedShips"]),
    completedTrips: numberAt(["livingUniverse", "metrics", "completedTrips"]),
    shipLosses: numberAt(["livingUniverse", "metrics", "shipLosses"]),
    encountersResolved: numberAt([
      "livingUniverse",
      "metrics",
      "encountersResolved",
    ]),
    destruction: {
      shipLosses: numberAt(["livingUniverse", "metrics", "shipLosses"]),
      conflictShipLosses: numberAt([
        "livingUniverse",
        "metrics",
        "conflictShipLosses",
      ]),
      physicalShipLosses: numberAt([
        "livingUniverse",
        "metrics",
        "physicalShipLosses",
      ]),
      replacementsScheduled: numberAt([
        "livingUniverse",
        "metrics",
        "replacements",
      ]),
      byType: objectAt(["livingUniverse", "metrics", "shipLossesByType"]),
      byRole: objectAt(["livingUniverse", "metrics", "shipLossesByRole"]),
      byFaction: objectAt(["livingUniverse", "metrics", "shipLossesByFaction"]),
    },
    replacementHoldsActiveFlights: numberAt([
      "livingUniverse",
      "replacementHolds",
      "activeFlights",
    ]),
    replacementCoverage: valueAt([
      "livingUniverse",
      "replacementCoverage",
    ], {}),
    encounters: {
      scheduled: numberAt([
        "livingUniverse",
        "metrics",
        "encountersScheduled",
      ]),
      observed: numberAt([
        "livingUniverse",
        "metrics",
        "encountersObserved",
      ]),
      resolved: numberAt([
        "livingUniverse",
        "metrics",
        "encountersResolved",
      ]),
      resolvedOffGrid: numberAt([
        "livingUniverse",
        "metrics",
        "encountersResolvedOffGrid",
      ]),
    },
    campaigns: valueAt(["livingUniverse", "campaigns"], []),
    conflict: {
      active: numberAt(["livingUniverse", "conflict", "active"]),
      pendingEvidence: numberAt([
        "livingUniverse",
        "conflict",
        "pendingEvidence",
      ]),
      campaigns: valueAt(["livingUniverse", "conflict", "campaigns"], []),
      roaming: {
        groups: numberAt([
          "livingUniverse",
          "conflict",
          "roaming",
          "groups",
        ]),
        activeCamps: numberAt([
          "livingUniverse",
          "conflict",
          "roaming",
          "activeCamps",
        ]),
        pendingContacts: numberAt([
          "livingUniverse",
          "conflict",
          "roaming",
          "pendingContacts",
        ]),
        metrics: objectAt([
          "livingUniverse",
          "conflict",
          "roaming",
          "metrics",
        ]),
        contactsScheduled: numberAt([
          "livingUniverse",
          "metrics",
          "roamingContactsScheduled",
        ]),
        contactsRejected: numberAt([
          "livingUniverse",
          "metrics",
          "roamingContactsRejected",
        ]),
        contactsExpired: numberAt([
          "livingUniverse",
          "metrics",
          "roamingContactsExpired",
        ]),
        contactsDeferred: numberAt([
          "livingUniverse",
          "metrics",
          "roamingContactsDeferred",
        ]),
      },
    },
    acceleration: valueAt(["livingUniverse", "offGridAcceleration"], {}),
    scheduler: {
      queueSize: numberAt(["livingUniverse", "scheduler", "queueSize"]),
      generalQueueSize: numberAt([
        "livingUniverse",
        "scheduler",
        "generalQueueSize",
      ]),
      replacementPriorityQueueSize: numberAt([
        "livingUniverse",
        "scheduler",
        "replacementPriorityQueueSize",
      ]),
      nextFlightDueInMs: numberAt([
        "livingUniverse",
        "scheduler",
        "nextFlightDueInMs",
      ]),
      oldestDueFlightOverdueMs: numberAt([
        "livingUniverse",
        "scheduler",
        "oldestDueFlightOverdueMs",
      ]),
      generalOldestOverdueMs: numberAt([
        "livingUniverse",
        "scheduler",
        "generalOldestOverdueMs",
      ]),
      replacementPriorityOldestOverdueMs: numberAt([
        "livingUniverse",
        "scheduler",
        "replacementPriorityOldestOverdueMs",
      ]),
      replacementPrioritySharePercent: numberAt([
        "livingUniverse",
        "scheduler",
        "replacementPrioritySharePercent",
      ]),
      deferredDuePasses: numberAt([
        "livingUniverse",
        "scheduler",
        "metrics",
        "deferredDuePasses",
      ]),
      dueFlightsProcessed: numberAt([
        "livingUniverse",
        "scheduler",
        "metrics",
        "dueFlightsProcessed",
      ]),
      replacementPriorityDueFlightsProcessed: numberAt([
        "livingUniverse",
        "scheduler",
        "metrics",
        "replacementPriorityDueFlightsProcessed",
      ]),
      generalDueFlightsProcessed: numberAt([
        "livingUniverse",
        "scheduler",
        "metrics",
        "generalDueFlightsProcessed",
      ]),
      replacementPriorityDeferredDuePasses: numberAt([
        "livingUniverse",
        "scheduler",
        "metrics",
        "replacementPriorityDeferredDuePasses",
      ]),
      generalDeferredDuePasses: numberAt([
        "livingUniverse",
        "scheduler",
        "metrics",
        "generalDeferredDuePasses",
      ]),
      contestedSelections: numberAt([
        "livingUniverse",
        "scheduler",
        "metrics",
        "replacementSchedulerContestedSelections",
      ]),
      prioritySelections: numberAt([
        "livingUniverse",
        "scheduler",
        "metrics",
        "replacementSchedulerPrioritySelections",
      ]),
      generalSelections: numberAt([
        "livingUniverse",
        "scheduler",
        "metrics",
        "replacementSchedulerGeneralSelections",
      ]),
      workConservingSelections: numberAt([
        "livingUniverse",
        "scheduler",
        "metrics",
        "replacementSchedulerWorkConservingSelections",
      ]),
      recentAverageMs: numberAt([
        "livingUniverse",
        "scheduler",
        "metrics",
        "recentAveragePassDurationMs",
      ]),
      recentP95Ms: numberAt([
        "livingUniverse",
        "scheduler",
        "metrics",
        "recentP95PassDurationMs",
      ]),
      recentMaximumMs: numberAt([
        "livingUniverse",
        "scheduler",
        "metrics",
        "recentMaxPassDurationMs",
      ]),
    },
  },
  economy: {
    activeFreightJobs: numberAt(["livingUniverse", "economy", "activeJobs"]),
    freightDelivered: numberAt([
      "livingUniverse",
      "economy",
      "metrics",
      "jobsDelivered",
    ]),
    freightLost: numberAt(["livingUniverse", "economy", "metrics", "jobsLost"]),
    freight: {
      active: numberAt(["livingUniverse", "economy", "activeJobs"]),
      created: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "jobsCreated",
      ]),
      delivered: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "jobsDelivered",
      ]),
      lost: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "jobsLost",
      ]),
      cancelled: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "jobsCancelled",
      ]),
      unitsReserved: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "unitsReserved",
      ]),
      unitsDelivered: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "unitsDelivered",
      ]),
      unitsLost: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "unitsLost",
      ]),
      replacementPriority: {
        activeJobs: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "replacementPriority",
          "activeJobs",
        ]),
        activeUnits: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "replacementPriority",
          "activeUnits",
        ]),
        oldestActiveAgeMs: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "replacementPriority",
          "oldestActiveAgeMs",
        ]),
        jobsAssigned: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "replacementPriority",
          "jobsAssigned",
        ]),
        jobsDelivered: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "replacementPriority",
          "jobsDelivered",
        ]),
        unitsAssigned: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "replacementPriority",
          "unitsAssigned",
        ]),
        unitsDelivered: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "replacementPriority",
          "unitsDelivered",
        ]),
        unitsDeliveredDirect: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "replacementPriority",
          "unitsDeliveredDirect",
        ]),
        unitsDeliveredProductionInput: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "replacementPriority",
          "unitsDeliveredProductionInput",
        ]),
        activeRepositions: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "replacementPriority",
          "activeRepositions",
        ]),
        repositionsAssigned: numberAt([
          "livingUniverse",
          "economy",
          "metrics",
          "replacementFreightRepositionsAssigned",
        ]),
        repositionsCompleted: numberAt([
          "livingUniverse",
          "economy",
          "metrics",
          "replacementFreightRepositionsCompleted",
        ]),
      },
      recovery: {
        activeIssues: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "recovery",
          "activeIssues",
        ]),
        detected: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "recovery",
          "detected",
        ]),
        routeMismatches: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "recovery",
          "routeMismatches",
        ]),
        routesRecovered: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "recovery",
          "routesRecovered",
        ]),
        routesReplanned: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "recovery",
          "routesReplanned",
        ]),
        schedulerWakeups: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "recovery",
          "schedulerWakeups",
        ]),
        deferred: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "recovery",
          "deferred",
        ]),
        unloads: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "recovery",
          "unloads",
        ]),
        unitsUnloaded: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "recovery",
          "unitsUnloaded",
        ]),
        failures: numberAt([
          "livingUniverse",
          "economy",
          "freight",
          "recovery",
          "failures",
        ]),
      },
    },
    freightRepositions: {
      active: numberAt([
        "livingUniverse",
        "economy",
        "routePlanning",
        "freightRepositions",
        "active",
      ]),
      assigned: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "freightRepositionsAssigned",
      ]),
      completed: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "freightRepositionsCompleted",
      ]),
      abandoned: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "freightRepositionsAbandoned",
      ]),
      jumps: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "freightRepositionJumps",
      ]),
    },
    demandCoverage: {
      requirements: numberAt([
        "livingUniverse",
        "economy",
        "demandCoverage",
        "requirements",
      ]),
      byClass: objectAt([
        "livingUniverse",
        "economy",
        "demandCoverage",
        "byClass",
      ]),
      byStatus: objectAt([
        "livingUniverse",
        "economy",
        "demandCoverage",
        "byStatus",
      ]),
      blockers: objectAt([
        "livingUniverse",
        "economy",
        "demandCoverage",
        "blockers",
      ]),
      byKind: objectAt([
        "livingUniverse",
        "economy",
        "demandCoverage",
        "byKind",
      ]),
      availableLocal: numberAt([
        "livingUniverse",
        "economy",
        "demandCoverage",
        "byStatus",
        "available_local",
      ]),
      awaitingFreight: numberAt([
        "livingUniverse",
        "economy",
        "demandCoverage",
        "byStatus",
        "awaiting_freight",
      ]),
      blockedInputs: numberAt([
        "livingUniverse",
        "economy",
        "demandCoverage",
        "byStatus",
        "blocked_inputs",
      ]),
      awaitingInputs: numberAt([
        "livingUniverse",
        "economy",
        "demandCoverage",
        "byStatus",
        "awaiting_inputs",
      ]),
    },
    replacement: {
      demandsCreated: replacementDemandsCreated,
      demandsFulfilled: replacementDemandsFulfilled,
      hullLosses: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "replacementHullLosses",
      ]),
      unitsRequested: replacementUnitsRequested,
      unitsFulfilled: replacementUnitsFulfilled,
      unitsOutstanding: Math.max(
        0,
        replacementUnitsRequested - replacementUnitsFulfilled,
      ),
      adjustmentNamespaceMigrations: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "replacementAdjustmentNamespaceMigrations",
      ]),
      adjustmentCollisionRetries: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "replacementAdjustmentCollisionRetries",
      ]),
      factionShipyardHullsSeeded: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "factionShipyardHullsSeeded",
      ]),
      factionShipyardSeedFailures: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "factionShipyardSeedFailures",
      ]),
      factionSmugglerHullsDelivered: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "factionSmugglerHullsDelivered",
      ]),
      procurementWarSubsidyISK: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "procurementWarSubsidyISK",
      ]),
      valueRequestedISK: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "replacementValueISK",
      ]),
      valueFulfilledISK: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "replacementValueFulfilledISK",
      ]),
      hullValueISK: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "replacementHullValueISK",
      ]),
      fittingValueISK: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "replacementFittingValueISK",
      ]),
      pending: numberAt([
        "livingUniverse",
        "economy",
        "replacements",
        "pending",
      ]),
      fulfilled: numberAt([
        "livingUniverse",
        "economy",
        "replacements",
        "fulfilled",
      ]),
      pendingUnits: numberAt([
        "livingUniverse",
        "economy",
        "replacements",
        "pendingUnits",
      ]),
      pendingValueISK: numberAt([
        "livingUniverse",
        "economy",
        "replacements",
        "pendingValueISK",
      ]),
      partiallyFulfilledPackages: numberAt([
        "livingUniverse",
        "economy",
        "replacements",
        "partiallyFulfilledPackages",
      ]),
      untouchedPackages: numberAt([
        "livingUniverse",
        "economy",
        "replacements",
        "untouchedPackages",
      ]),
      pendingWithErrors: numberAt([
        "livingUniverse",
        "economy",
        "replacements",
        "pendingWithErrors",
      ]),
      oldestPendingAgeMs: numberAt([
        "livingUniverse",
        "economy",
        "replacements",
        "oldestPendingAgeMs",
      ]),
      oldestPendingDemandID: valueAt([
        "livingUniverse",
        "economy",
        "replacements",
        "oldestPendingDemandID",
      ]),
      demandCompletionPercent: percentage(
        replacementDemandsFulfilled,
        replacementDemandsCreated,
      ),
      unitFulfillmentPercent: percentage(
        replacementUnitsFulfilled,
        replacementUnitsRequested,
      ),
      pendingByHull: valueAt([
        "livingUniverse",
        "economy",
        "replacements",
        "byHull",
      ], []),
      hullLossesByType: objectAt([
        "livingUniverse",
        "economy",
        "metrics",
        "replacementHullLossesByType",
      ]),
      validationFailures: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "replacementDemandValidationFailures",
      ]),
      requirementUnitsRejected: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "replacementRequirementUnitsRejected",
      ]),
      demandLinksReconciled: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "replacementDemandLinksReconciled",
      ]),
    },
    campaignSupply: {
      pending: numberAt([
        "livingUniverse",
        "economy",
        "campaignSupply",
        "pending",
      ]),
      fulfilled: numberAt([
        "livingUniverse",
        "economy",
        "campaignSupply",
        "fulfilled",
      ]),
      demandsCreated: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "campaignDemandsCreated",
      ]),
      demandsFulfilled: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "campaignDemandsFulfilled",
      ]),
      unitsRequested: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "campaignUnitsRequested",
      ]),
      unitsConsumed: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "campaignUnitsConsumed",
      ]),
      valueISK: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "campaignSupplyValueISK",
      ]),
      adjustmentNamespaceMigrations: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "campaignAdjustmentNamespaceMigrations",
      ]),
      adjustmentConflictsQuarantined: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "campaignAdjustmentConflictsQuarantined",
      ]),
    },
    miningRuns: numberAt(["livingUniverse", "economy", "metrics", "miningRuns"]),
    oreUnitsMined: numberAt([
      "livingUniverse",
      "economy",
      "metrics",
      "oreUnitsMined",
    ]),
    industryCompleted: numberAt([
      "livingUniverse",
      "economy",
      "industry",
      "jobsCompleted",
    ]),
    industryActive: numberAt([
      "livingUniverse",
      "economy",
      "industry",
      "activeJobs",
    ]),
    industry: {
      active: numberAt([
        "livingUniverse",
        "economy",
        "industry",
        "activeJobs",
      ]),
      installed: numberAt([
        "livingUniverse",
        "economy",
        "industry",
        "jobsInstalled",
      ]),
      completed: numberAt([
        "livingUniverse",
        "economy",
        "industry",
        "jobsCompleted",
      ]),
      inputUnitsConsumed: numberAt([
        "livingUniverse",
        "economy",
        "industry",
        "inputUnitsConsumed",
      ]),
      outputUnitsProduced: numberAt([
        "livingUniverse",
        "economy",
        "industry",
        "outputUnitsProduced",
      ]),
      outputValueISK: numberAt([
        "livingUniverse",
        "economy",
        "industry",
        "outputValueISK",
      ]),
      statuses: objectAt([
        "livingUniverse",
        "economy",
        "industry",
        "statuses",
      ]),
      completionFailuresRetried: numberAt([
        "livingUniverse",
        "economy",
        "industry",
        "completionSchedule",
        "completionFailuresRetried",
      ]),
    },
    salvage: {
      status: valueAt(["livingUniverse", "economy", "salvage"], {}),
      sitesCreated: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "salvageSitesCreated",
      ]),
      jobsCompleted: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "salvageJobsCompleted",
      ]),
      wrecksRecovered: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "salvageWrecksRecovered",
      ]),
      unitsRecovered: numberAt([
        "livingUniverse",
        "economy",
        "metrics",
        "salvageUnitsRecovered",
      ]),
    },
    procurementOpen: numberAt([
      "livingUniverse",
      "economy",
      "procurement",
      "openOrders",
    ]),
    traderSpend: numberAt(["livingUniverse", "economy", "metrics", "traderSpend"]),
    traderRevenue: numberAt([
      "livingUniverse",
      "economy",
      "metrics",
      "traderRevenue",
    ]),
    traderMargin: numberAt([
      "livingUniverse",
      "economy",
      "metrics",
      "traderGrossMargin",
    ]),
    failedAdjustments,
    marketBatches: {
      attempted: marketBatchesAttempted,
      succeeded: marketBatchesSucceeded,
      fallbacks: marketBatchFallbacks,
      adjustmentsSubmitted: marketAdjustmentsSubmitted,
      lastError: marketLastBatchError == null
        ? ""
        : String(marketLastBatchError),
    },
  },
  xEve: {
    mode: valueAt(["xEve", "scheduler", "mode"]),
    persistenceHealthy,
    eventCircuitState,
    productionPaused,
    backlogTotal,
    oldestOverdueMs,
    receivedEvents: numberAt([
      "xEve",
      "scheduler",
      "metrics",
      "receivedEvents",
    ]),
    processedJobs: numberAt([
      "xEve",
      "scheduler",
      "metrics",
      "processedJobs",
    ]),
    failedJobs,
    deadLetterJobs,
    quarantinedJobs,
    uncertainJobs,
  },
};

process.stdout.write(`${JSON.stringify(report)}\n`);
if (severity === "critical") process.exitCode = 3;
else if (severity === "warning") process.exitCode = 2;
