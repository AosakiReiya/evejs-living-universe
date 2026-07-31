"use strict";

const fs = require("fs");
const path = require("path");

const samplesPath = process.argv[2];
const reportPath = process.argv[3];
const summaryPath = process.argv[4];

if (!samplesPath || !reportPath) {
  throw new Error(
    "Usage: node analyzeDestructionReplacementStress.js " +
      "<samples.jsonl> <report.md> [summary.json]",
  );
}

function readSamples(filePath) {
  const rows = fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((sample) => Number(sample.schemaVersion) >= 3);
  const unique = new Map();
  for (const sample of rows) {
    unique.set(Number(sample.capturedAtMs), sample);
  }
  return [...unique.values()]
    .sort((left, right) => Number(left.capturedAtMs) - Number(right.capturedAtMs));
}

function number(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function delta(first, last, selector) {
  return number(selector(last)) - number(selector(first));
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(number(value) * scale) / scale;
}

function formatNumber(value, digits = 0) {
  return number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatISK(value) {
  const amount = number(value);
  const absolute = Math.abs(amount);
  if (absolute >= 1_000_000_000) return `${round(amount / 1_000_000_000, 2)}b ISK`;
  if (absolute >= 1_000_000) return `${round(amount / 1_000_000, 2)}m ISK`;
  if (absolute >= 1_000) return `${round(amount / 1_000, 2)}k ISK`;
  return `${round(amount, 2)} ISK`;
}

function percentage(numerator, denominator) {
  const bottom = number(denominator);
  return bottom > 0 ? round(number(numerator) * 100 / bottom, 2) : 0;
}

function average(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + number(value), 0) / values.length
    : 0;
}

function mapCounterDelta(firstMap, lastMap, valueField = null) {
  const firstRows = firstMap && typeof firstMap === "object" ? firstMap : {};
  const lastRows = lastMap && typeof lastMap === "object" ? lastMap : {};
  const keys = new Set([...Object.keys(firstRows), ...Object.keys(lastRows)]);
  const results = [];
  for (const key of keys) {
    const firstValue = valueField
      ? number(firstRows[key] && firstRows[key][valueField])
      : number(firstRows[key]);
    const lastValue = valueField
      ? number(lastRows[key] && lastRows[key][valueField])
      : number(lastRows[key]);
    const change = lastValue - firstValue;
    if (change <= 0) continue;
    const row = lastRows[key] && typeof lastRows[key] === "object"
      ? lastRows[key]
      : {};
    results.push({
      key,
      name: row.shipName || key,
      shipTypeID: row.shipTypeID || null,
      delta: change,
    });
  }
  return results.sort((left, right) => right.delta - left.delta);
}

function formatBlockers(blockers) {
  const rows = Object.entries(
    blockers && typeof blockers === "object" ? blockers : {},
  )
    .map(([name, count]) => ({ name, count: number(count) }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count)
    .slice(0, 6);
  return rows.length > 0
    ? rows.map((entry) => `${entry.name} ${formatNumber(entry.count)}`).join(", ")
    : "none reported";
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function replacementPriorityFreight(sample) {
  const economy = object(object(sample).economy);
  const freight = object(economy.freight);
  return object(freight.replacementPriority);
}

function freightRecovery(sample) {
  const economy = object(object(sample).economy);
  const freight = object(economy.freight);
  return object(freight.recovery);
}

const allSamples = readSamples(samplesPath);
const settledSamples = allSamples.filter(
  (sample) => number(sample.process.uptimeSeconds) >= 60,
);
if (allSamples.length < 2) {
  throw new Error(
    `Need at least two schema-3 samples; found ${allSamples.length}.`,
  );
}
if (settledSamples.length < 2) {
  throw new Error(
    `Need at least two settled schema-3 samples; found ${settledSamples.length}.`,
  );
}

// Economy and destruction counters are valid from process start. Performance
// statistics exclude startup hydration and module-loading samples.
const first = allSamples[0];
const last = allSamples[allSamples.length - 1];
const wallSeconds = Math.max(
  1,
  (number(last.capturedAtMs) - number(first.capturedAtMs)) / 1_000,
);
const multiplier = Math.max(
  1,
  number(first.livingUniverse.acceleration.activityTimeMultiplier),
);
const acceleratedDays = wallSeconds * multiplier / 86_400;

const lossDelta = delta(
  first,
  last,
  (sample) => sample.livingUniverse.destruction.shipLosses,
);
const conflictLossDelta = delta(
  first,
  last,
  (sample) => sample.livingUniverse.destruction.conflictShipLosses,
);
const physicalLossDelta = delta(
  first,
  last,
  (sample) => sample.livingUniverse.destruction.physicalShipLosses,
);
const scheduledReplacementDelta = delta(
  first,
  last,
  (sample) => sample.livingUniverse.destruction.replacementsScheduled,
);
const replacementHullLossDelta = delta(
  first,
  last,
  (sample) => sample.economy.replacement.hullLosses,
);
const replacementDemandDelta = delta(
  first,
  last,
  (sample) => sample.economy.replacement.demandsCreated,
);
const replacementDemandFulfilledDelta = delta(
  first,
  last,
  (sample) => sample.economy.replacement.demandsFulfilled,
);
const replacementUnitsRequestedDelta = delta(
  first,
  last,
  (sample) => sample.economy.replacement.unitsRequested,
);
const replacementUnitsFulfilledDelta = delta(
  first,
  last,
  (sample) => sample.economy.replacement.unitsFulfilled,
);
const replacementValueRequestedDelta = delta(
  first,
  last,
  (sample) => sample.economy.replacement.valueRequestedISK,
);
const replacementValueFulfilledDelta = delta(
  first,
  last,
  (sample) => sample.economy.replacement.valueFulfilledISK,
);
const replacementValidationFailureDelta = delta(
  first,
  last,
  (sample) => sample.economy.replacement.validationFailures,
);
const replacementRequirementUnitsRejectedDelta = delta(
  first,
  last,
  (sample) => sample.economy.replacement.requirementUnitsRejected,
);
const replacementDemandLinksReconciledDelta = delta(
  first,
  last,
  (sample) => sample.economy.replacement.demandLinksReconciled,
);
const pendingUnitsDelta = delta(
  first,
  last,
  (sample) => sample.economy.replacement.pendingUnits,
);
const replacementFreightJobsAssignedDelta = delta(
  first,
  last,
  (sample) => replacementPriorityFreight(sample).jobsAssigned,
);
const replacementFreightJobsDeliveredDelta = delta(
  first,
  last,
  (sample) => replacementPriorityFreight(sample).jobsDelivered,
);
const replacementFreightUnitsAssignedDelta = delta(
  first,
  last,
  (sample) => replacementPriorityFreight(sample).unitsAssigned,
);
const replacementFreightUnitsDeliveredDelta = delta(
  first,
  last,
  (sample) => replacementPriorityFreight(sample).unitsDelivered,
);
const replacementFreightRepositionsAssignedDelta = delta(
  first,
  last,
  (sample) => replacementPriorityFreight(sample).repositionsAssigned,
);
const replacementFreightRepositionsCompletedDelta = delta(
  first,
  last,
  (sample) => replacementPriorityFreight(sample).repositionsCompleted,
);
const resolvedEncounterDelta = delta(
  first,
  last,
  (sample) => sample.livingUniverse.encounters.resolved,
);
const roamingOperationsDelta = delta(
  first,
  last,
  (sample) => sample.livingUniverse.conflict.roaming.metrics.operationsStarted,
);
const roamingCampsDelta = delta(
  first,
  last,
  (sample) => sample.livingUniverse.conflict.roaming.metrics.campsStarted,
);
const roamingIntersectionsDelta = delta(
  first,
  last,
  (sample) => (
    sample.livingUniverse.conflict.roaming.metrics.intersectionCandidates
  ),
);
const roamingContactsScheduledDelta = delta(
  first,
  last,
  (sample) => sample.livingUniverse.conflict.roaming.contactsScheduled,
);
const pipelineDeltas = [
  lossDelta,
  scheduledReplacementDelta,
  replacementHullLossDelta,
  replacementDemandDelta,
  conflictLossDelta + physicalLossDelta,
];
const pipelineIntegrity = new Set(pipelineDeltas).size === 1;
const topHullLosses = mapCounterDelta(
  first.livingUniverse.destruction.byType,
  last.livingUniverse.destruction.byType,
  "losses",
).slice(0, 10);
const topRoleLosses = mapCounterDelta(
  first.livingUniverse.destruction.byRole,
  last.livingUniverse.destruction.byRole,
).slice(0, 8);
const topFactionLosses = mapCounterDelta(
  first.livingUniverse.destruction.byFaction,
  last.livingUniverse.destruction.byFaction,
).slice(0, 8);

const tickP95Values = settledSamples.map((sample) => sample.tick.p95Ms);
const tickMaximumValues = settledSamples.map((sample) => sample.tick.maximumMs);
const cpuValues = settledSamples.map(
  (sample) => sample.process.cpuOneCorePercent,
);
const rssValues = settledSamples.map((sample) => sample.process.rssMiB);
const queueValues = settledSamples.map(
  (sample) => sample.livingUniverse.scheduler.queueSize,
);
const replacementSchedulerQueueValues = settledSamples.map(
  (sample) => number(
    sample.livingUniverse.scheduler.replacementPriorityQueueSize,
  ),
);
const generalSchedulerQueueValues = settledSamples.map(
  (sample) => number(sample.livingUniverse.scheduler.generalQueueSize),
);
const replacementSchedulerOverdueValues = settledSamples.map(
  (sample) => number(
    sample.livingUniverse.scheduler.replacementPriorityOldestOverdueMs,
  ),
);
const generalSchedulerOverdueValues = settledSamples.map(
  (sample) => number(sample.livingUniverse.scheduler.generalOldestOverdueMs),
);
const replacementHoldValues = allSamples.map(
  (sample) => sample.livingUniverse.replacementHoldsActiveFlights,
);
const replacementFreightActiveJobValues = allSamples.map(
  (sample) => number(replacementPriorityFreight(sample).activeJobs),
);
const replacementFreightActiveRepositionValues = allSamples.map(
  (sample) => number(replacementPriorityFreight(sample).activeRepositions),
);
const freightRecoveryActiveIssueValues = allSamples.map(
  (sample) => number(freightRecovery(sample).activeIssues),
);
const xEveBacklogValues = settledSamples.map(
  (sample) => number(sample.xEve.backlogTotal),
);
const xEveOldestOverdueValues = settledSamples.map(
  (sample) => number(sample.xEve.oldestOverdueMs),
);

const summary = {
  generatedAt: new Date().toISOString(),
  sampleCount: allSamples.length,
  settledSampleCount: settledSamples.length,
  firstCapturedAt: first.capturedAt,
  lastCapturedAt: last.capturedAt,
  wallSeconds: round(wallSeconds, 3),
  accelerationMultiplier: multiplier,
  acceleratedDays: round(acceleratedDays, 4),
  destruction: {
    losses: lossDelta,
    conflictLosses: conflictLossDelta,
    physicalLosses: physicalLossDelta,
    lossesPerAcceleratedDay: round(lossDelta / acceleratedDays, 2),
    resolvedEncounters: resolvedEncounterDelta,
    lossesPerResolvedEncounter: round(
      resolvedEncounterDelta > 0 ? lossDelta / resolvedEncounterDelta : 0,
      4,
    ),
    topHulls: topHullLosses,
    topRoles: topRoleLosses,
    topFactions: topFactionLosses,
    roaming: {
      operationsStarted: roamingOperationsDelta,
      campsStarted: roamingCampsDelta,
      intersectionCandidates: roamingIntersectionsDelta,
      contactsScheduled: roamingContactsScheduledDelta,
      contactConversionPercent: percentage(
        roamingContactsScheduledDelta,
        roamingIntersectionsDelta,
      ),
    },
  },
  replacement: {
    pipelineIntegrity,
    scheduled: scheduledReplacementDelta,
    hullLosses: replacementHullLossDelta,
    demandsCreated: replacementDemandDelta,
    demandsFulfilled: replacementDemandFulfilledDelta,
    unitsRequested: replacementUnitsRequestedDelta,
    unitsFulfilled: replacementUnitsFulfilledDelta,
    netPendingUnitsChange: pendingUnitsDelta,
    valueRequestedISK: replacementValueRequestedDelta,
    valueFulfilledISK: replacementValueFulfilledDelta,
    validationFailures: replacementValidationFailureDelta,
    requirementUnitsRejected: replacementRequirementUnitsRejectedDelta,
    demandLinksReconciled: replacementDemandLinksReconciledDelta,
    packageFulfillmentPercent: percentage(
      replacementDemandFulfilledDelta,
      replacementDemandDelta,
    ),
    unitFulfillmentPercent: percentage(
      replacementUnitsFulfilledDelta,
      replacementUnitsRequestedDelta,
    ),
    pendingStart: number(first.economy.replacement.pending),
    pendingEnd: number(last.economy.replacement.pending),
    pendingUnitsStart: number(first.economy.replacement.pendingUnits),
    pendingUnitsEnd: number(last.economy.replacement.pendingUnits),
    pendingValueEndISK: number(last.economy.replacement.pendingValueISK),
    oldestPendingAgeEndMs: number(last.economy.replacement.oldestPendingAgeMs),
    holdFlightsMaximum: Math.max(...replacementHoldValues),
    coverageStart: first.livingUniverse.replacementCoverage || {},
    coverageEnd: last.livingUniverse.replacementCoverage || {},
  },
  economy: {
    freightDeliveries: delta(
      first,
      last,
      (sample) => sample.economy.freight.delivered,
    ),
    freightUnitsDelivered: delta(
      first,
      last,
      (sample) => sample.economy.freight.unitsDelivered,
    ),
    freight: {
      replacementPriority: {
        jobsAssigned: replacementFreightJobsAssignedDelta,
        jobsDelivered: replacementFreightJobsDeliveredDelta,
        unitsAssigned: replacementFreightUnitsAssignedDelta,
        unitsDelivered: replacementFreightUnitsDeliveredDelta,
        jobDeliveryPercent: percentage(
          replacementFreightJobsDeliveredDelta,
          replacementFreightJobsAssignedDelta,
        ),
        unitDeliveryPercent: percentage(
          replacementFreightUnitsDeliveredDelta,
          replacementFreightUnitsAssignedDelta,
        ),
        activeJobsStart: number(
          replacementPriorityFreight(first).activeJobs,
        ),
        activeJobsEnd: number(
          replacementPriorityFreight(last).activeJobs,
        ),
        activeJobsMaximum: Math.max(...replacementFreightActiveJobValues),
        activeUnitsStart: number(
          replacementPriorityFreight(first).activeUnits,
        ),
        activeUnitsEnd: number(
          replacementPriorityFreight(last).activeUnits,
        ),
        oldestActiveAgeEndMs: number(
          replacementPriorityFreight(last).oldestActiveAgeMs,
        ),
        repositionsAssigned:
          replacementFreightRepositionsAssignedDelta,
        repositionsCompleted:
          replacementFreightRepositionsCompletedDelta,
        activeRepositionsStart: number(
          replacementPriorityFreight(first).activeRepositions,
        ),
        activeRepositionsEnd: number(
          replacementPriorityFreight(last).activeRepositions,
        ),
        activeRepositionsMaximum: Math.max(
          ...replacementFreightActiveRepositionValues,
        ),
      },
      recovery: {
        detected: delta(
          first,
          last,
          (sample) => freightRecovery(sample).detected,
        ),
        routeMismatches: delta(
          first,
          last,
          (sample) => freightRecovery(sample).routeMismatches,
        ),
        routesRecovered: delta(
          first,
          last,
          (sample) => freightRecovery(sample).routesRecovered,
        ),
        routesReplanned: delta(
          first,
          last,
          (sample) => freightRecovery(sample).routesReplanned,
        ),
        schedulerWakeups: delta(
          first,
          last,
          (sample) => freightRecovery(sample).schedulerWakeups,
        ),
        deferred: delta(
          first,
          last,
          (sample) => freightRecovery(sample).deferred,
        ),
        unloads: delta(
          first,
          last,
          (sample) => freightRecovery(sample).unloads,
        ),
        unitsUnloaded: delta(
          first,
          last,
          (sample) => freightRecovery(sample).unitsUnloaded,
        ),
        failures: delta(
          first,
          last,
          (sample) => freightRecovery(sample).failures,
        ),
        activeIssuesStart: number(freightRecovery(first).activeIssues),
        activeIssuesEnd: number(freightRecovery(last).activeIssues),
        activeIssuesMaximum: Math.max(...freightRecoveryActiveIssueValues),
      },
    },
    industryJobsCompleted: delta(
      first,
      last,
      (sample) => sample.economy.industry.completed,
    ),
    industryUnitsProduced: delta(
      first,
      last,
      (sample) => sample.economy.industry.outputUnitsProduced,
    ),
    salvageWrecksRecovered: delta(
      first,
      last,
      (sample) => sample.economy.salvage.wrecksRecovered,
    ),
    campaignSupply: {
      pendingStart: number(first.economy.campaignSupply.pending),
      pendingEnd: number(last.economy.campaignSupply.pending),
      demandsFulfilled: delta(
        first,
        last,
        (sample) => sample.economy.campaignSupply.demandsFulfilled,
      ),
      unitsConsumed: delta(
        first,
        last,
        (sample) => sample.economy.campaignSupply.unitsConsumed,
      ),
      adjustmentNamespaceMigrations: delta(
        first,
        last,
        (sample) => (
          sample.economy.campaignSupply.adjustmentNamespaceMigrations
        ),
      ),
      adjustmentNamespaceMigrationsStart: number(
        first.economy.campaignSupply.adjustmentNamespaceMigrations,
      ),
      adjustmentNamespaceMigrationsEnd: number(
        last.economy.campaignSupply.adjustmentNamespaceMigrations,
      ),
      adjustmentConflictsQuarantined: delta(
        first,
        last,
        (sample) => (
          sample.economy.campaignSupply.adjustmentConflictsQuarantined
        ),
      ),
      adjustmentConflictsQuarantinedStart: number(
        first.economy.campaignSupply.adjustmentConflictsQuarantined,
      ),
      adjustmentConflictsQuarantinedEnd: number(
        last.economy.campaignSupply.adjustmentConflictsQuarantined,
      ),
    },
    blockersStart: first.economy.demandCoverage.blockers,
    blockersEnd: last.economy.demandCoverage.blockers,
    replacementBlockersStart:
      first.economy.demandCoverage.byKind &&
      first.economy.demandCoverage.byKind.replacement &&
      first.economy.demandCoverage.byKind.replacement.blockers || {},
    replacementBlockersEnd:
      last.economy.demandCoverage.byKind &&
      last.economy.demandCoverage.byKind.replacement &&
      last.economy.demandCoverage.byKind.replacement.blockers || {},
  },
  performance: {
    tickP95AverageMs: round(average(tickP95Values), 3),
    tickP95MaximumMs: round(Math.max(...tickP95Values), 3),
    tickRollingMaximumMs: round(Math.max(...tickMaximumValues), 3),
    cpuOneCoreAveragePercent: round(average(cpuValues), 2),
    cpuOneCoreMaximumPercent: round(Math.max(...cpuValues), 2),
    rssStartMiB: round(rssValues[0], 2),
    rssEndMiB: round(rssValues[rssValues.length - 1], 2),
    rssMaximumMiB: round(Math.max(...rssValues), 2),
    schedulerQueueMaximum: Math.max(...queueValues),
    xEve: {
      backlogStart: xEveBacklogValues[0],
      backlogEnd: xEveBacklogValues[xEveBacklogValues.length - 1],
      backlogMaximum: Math.max(...xEveBacklogValues),
      oldestOverdueStartMs: xEveOldestOverdueValues[0],
      oldestOverdueEndMs:
        xEveOldestOverdueValues[xEveOldestOverdueValues.length - 1],
      oldestOverdueMaximumMs: Math.max(...xEveOldestOverdueValues),
      receivedEvents: delta(
        first,
        last,
        (sample) => sample.xEve.receivedEvents,
      ),
      processedJobs: delta(
        first,
        last,
        (sample) => sample.xEve.processedJobs,
      ),
    },
    replacementScheduler: {
      configuredSharePercent: number(
        last.livingUniverse.scheduler.replacementPrioritySharePercent,
      ),
      replacementQueueStart: replacementSchedulerQueueValues[0],
      replacementQueueEnd:
        replacementSchedulerQueueValues[replacementSchedulerQueueValues.length - 1],
      replacementQueueMaximum: Math.max(...replacementSchedulerQueueValues),
      generalQueueStart: generalSchedulerQueueValues[0],
      generalQueueEnd:
        generalSchedulerQueueValues[generalSchedulerQueueValues.length - 1],
      replacementOldestOverdueStartMs: replacementSchedulerOverdueValues[0],
      replacementOldestOverdueEndMs:
        replacementSchedulerOverdueValues[
          replacementSchedulerOverdueValues.length - 1
        ],
      replacementOldestOverdueMaximumMs:
        Math.max(...replacementSchedulerOverdueValues),
      generalOldestOverdueStartMs: generalSchedulerOverdueValues[0],
      generalOldestOverdueEndMs:
        generalSchedulerOverdueValues[generalSchedulerOverdueValues.length - 1],
      generalOldestOverdueMaximumMs: Math.max(...generalSchedulerOverdueValues),
      replacementTransitions: delta(
        first,
        last,
        (sample) => (
          sample.livingUniverse.scheduler.replacementPriorityDueFlightsProcessed
        ),
      ),
      generalTransitions: delta(
        first,
        last,
        (sample) => sample.livingUniverse.scheduler.generalDueFlightsProcessed,
      ),
      contestedSelections: delta(
        first,
        last,
        (sample) => sample.livingUniverse.scheduler.contestedSelections,
      ),
      prioritySelections: delta(
        first,
        last,
        (sample) => sample.livingUniverse.scheduler.prioritySelections,
      ),
      generalSelections: delta(
        first,
        last,
        (sample) => sample.livingUniverse.scheduler.generalSelections,
      ),
      workConservingSelections: delta(
        first,
        last,
        (sample) => sample.livingUniverse.scheduler.workConservingSelections,
      ),
      replacementDeferredPasses: delta(
        first,
        last,
        (sample) => (
          sample.livingUniverse.scheduler.replacementPriorityDeferredDuePasses
        ),
      ),
      generalDeferredPasses: delta(
        first,
        last,
        (sample) => sample.livingUniverse.scheduler.generalDeferredDuePasses,
      ),
    },
    marketFallbackDelta: delta(
      first,
      last,
      (sample) => sample.economy.marketBatches.fallbacks,
    ),
    failedAdjustmentDelta: delta(
      first,
      last,
      (sample) => sample.economy.failedAdjustments,
    ),
    xEveFailureDelta: delta(
      first,
      last,
      (sample) => (
        number(sample.xEve.failedJobs) +
        number(sample.xEve.deadLetterJobs) +
        number(sample.xEve.quarantinedJobs) +
        number(sample.xEve.uncertainJobs)
      ),
    ),
  },
};

const hullRows = topHullLosses.length > 0
  ? topHullLosses
      .map((row) => `| ${row.name} | ${row.shipTypeID || "unknown"} | ${row.delta} |`)
      .join("\n")
  : "| No losses recorded | — | 0 |";
const roleText = topRoleLosses.length > 0
  ? topRoleLosses.map((row) => `${row.name} ${row.delta}`).join(", ")
  : "none";
const factionText = topFactionLosses.length > 0
  ? topFactionLosses.map((row) => `${row.name} ${row.delta}`).join(", ")
  : "none";

const markdown = `# X-Eve 72x destruction and replacement stress report

Generated ${summary.generatedAt}. Economy and destruction deltas use all ${allSamples.length} unique samples; performance uses ${settledSamples.length} post-startup samples. The run covers ${formatNumber(wallSeconds, 1)} wall seconds, equivalent to ${formatNumber(acceleratedDays, 3)} accelerated days at ${multiplier}x.

## Result

- Loss-to-replacement integrity: **${pipelineIntegrity ? "PASS" : "FAIL"}**.
- Destroyed ships: **${formatNumber(lossDelta)}** (${formatNumber(conflictLossDelta)} conflict, ${formatNumber(physicalLossDelta)} physical), or ${formatNumber(summary.destruction.lossesPerAcceleratedDay, 2)} per accelerated day.
- Resolved encounters: ${formatNumber(resolvedEncounterDelta)}; losses per resolved encounter: ${formatNumber(summary.destruction.lossesPerResolvedEncounter, 4)}.
- Replacement handoff: ${formatNumber(scheduledReplacementDelta)} scheduled, ${formatNumber(replacementHullLossDelta)} hull losses registered, ${formatNumber(replacementDemandDelta)} economic demands created.
- Roaming conversion: ${formatNumber(roamingOperationsDelta)} operations, ${formatNumber(roamingCampsDelta)} camps, ${formatNumber(roamingIntersectionsDelta)} candidate intersections, and ${formatNumber(roamingContactsScheduledDelta)} contacts scheduled.

## Economic replacement

| Measure | During run |
|---|---:|
| Replacement packages created | ${formatNumber(replacementDemandDelta)} |
| Replacement packages fulfilled | ${formatNumber(replacementDemandFulfilledDelta)} |
| Replacement units requested | ${formatNumber(replacementUnitsRequestedDelta)} |
| Replacement units fulfilled | ${formatNumber(replacementUnitsFulfilledDelta)} |
| Net pending-unit change | ${formatNumber(pendingUnitsDelta)} |
| Replacement value requested | ${formatISK(replacementValueRequestedDelta)} |
| Replacement value fulfilled | ${formatISK(replacementValueFulfilledDelta)} |
| Rejected replacement demands | ${formatNumber(replacementValidationFailureDelta)} |
| Rejected replacement units | ${formatNumber(replacementRequirementUnitsRejectedDelta)} |
| Legacy demand links reconciled | ${formatNumber(replacementDemandLinksReconciledDelta)} |
| Package fulfillment vs new demands | ${formatNumber(summary.replacement.packageFulfillmentPercent, 2)}% |
| Unit fulfillment vs new requirements | ${formatNumber(summary.replacement.unitFulfillmentPercent, 2)}% |
| Pending packages, start → end | ${formatNumber(summary.replacement.pendingStart)} → ${formatNumber(summary.replacement.pendingEnd)} |
| Pending units, start → end | ${formatNumber(summary.replacement.pendingUnitsStart)} → ${formatNumber(summary.replacement.pendingUnitsEnd)} |
| Pending replacement value at end | ${formatISK(summary.replacement.pendingValueEndISK)} |
| Oldest pending package at end | ${formatNumber(summary.replacement.oldestPendingAgeEndMs / 3_600_000, 2)} hours |
| Maximum flights held for replacement | ${formatNumber(summary.replacement.holdFlightsMaximum)} |

Start blockers: ${formatBlockers(summary.economy.blockersStart)}.

End blockers: ${formatBlockers(summary.economy.blockersEnd)}.

Replacement-only start blockers: ${formatBlockers(summary.economy.replacementBlockersStart)}.

Replacement-only end blockers: ${formatBlockers(summary.economy.replacementBlockersEnd)}.

Replacement doctrine coverage ended at ${formatNumber(number(summary.replacement.coverageEnd.coveragePercent), 2)}%, with ${formatNumber(number(summary.replacement.coverageEnd.actorsWithGaps))} actor packages containing gaps.

## Replacement-priority logistics

| Measure | During run |
|---|---:|
| Priority freight jobs assigned | ${formatNumber(summary.economy.freight.replacementPriority.jobsAssigned)} |
| Priority freight jobs delivered | ${formatNumber(summary.economy.freight.replacementPriority.jobsDelivered)} |
| Priority freight units assigned | ${formatNumber(summary.economy.freight.replacementPriority.unitsAssigned)} |
| Priority freight units delivered | ${formatNumber(summary.economy.freight.replacementPriority.unitsDelivered)} |
| Priority job delivery vs assignments | ${formatNumber(summary.economy.freight.replacementPriority.jobDeliveryPercent, 2)}% |
| Active priority jobs, start to end | ${formatNumber(summary.economy.freight.replacementPriority.activeJobsStart)} to ${formatNumber(summary.economy.freight.replacementPriority.activeJobsEnd)} |
| Oldest active priority job at end | ${formatNumber(summary.economy.freight.replacementPriority.oldestActiveAgeEndMs / 3_600_000, 2)} hours |
| Replacement repositions assigned | ${formatNumber(summary.economy.freight.replacementPriority.repositionsAssigned)} |
| Replacement repositions completed | ${formatNumber(summary.economy.freight.replacementPriority.repositionsCompleted)} |
| Active replacement repositions, start to end | ${formatNumber(summary.economy.freight.replacementPriority.activeRepositionsStart)} to ${formatNumber(summary.economy.freight.replacementPriority.activeRepositionsEnd)} |
| Stale freight jobs detected | ${formatNumber(summary.economy.freight.recovery.detected)} |
| Route mismatches detected | ${formatNumber(summary.economy.freight.recovery.routeMismatches)} |
| Freight routes recovered | ${formatNumber(summary.economy.freight.recovery.routesRecovered)} |
| Freight routes replanned | ${formatNumber(summary.economy.freight.recovery.routesReplanned)} |
| Recovery scheduler wakeups | ${formatNumber(summary.economy.freight.recovery.schedulerWakeups)} |
| Recovery unloads / units | ${formatNumber(summary.economy.freight.recovery.unloads)} / ${formatNumber(summary.economy.freight.recovery.unitsUnloaded)} |
| Recovery failures | ${formatNumber(summary.economy.freight.recovery.failures)} |
| Active recovery issues, start to end | ${formatNumber(summary.economy.freight.recovery.activeIssuesStart)} to ${formatNumber(summary.economy.freight.recovery.activeIssuesEnd)} |

## Hull losses

| Hull | Type ID | Losses |
|---|---:|---:|
${hullRows}

Roles: ${roleText}.

Factions: ${factionText}.

## Supporting economy

- Freight: ${formatNumber(summary.economy.freightDeliveries)} deliveries and ${formatNumber(summary.economy.freightUnitsDelivered)} units delivered.
- Industry: ${formatNumber(summary.economy.industryJobsCompleted)} jobs completed and ${formatNumber(summary.economy.industryUnitsProduced)} output units produced.
- Salvage: ${formatNumber(summary.economy.salvageWrecksRecovered)} wrecks recovered.
- Campaign supply: ${formatNumber(summary.economy.campaignSupply.demandsFulfilled)} demand(s) fulfilled and ${formatNumber(summary.economy.campaignSupply.unitsConsumed)} units consumed; pending ${formatNumber(summary.economy.campaignSupply.pendingStart)} to ${formatNumber(summary.economy.campaignSupply.pendingEnd)}.
- Campaign adjustment repair: migration counter ${formatNumber(summary.economy.campaignSupply.adjustmentNamespaceMigrationsStart)} to ${formatNumber(summary.economy.campaignSupply.adjustmentNamespaceMigrationsEnd)} (${formatNumber(summary.economy.campaignSupply.adjustmentNamespaceMigrations)} after the first captured sample); quarantined conflicts ${formatNumber(summary.economy.campaignSupply.adjustmentConflictsQuarantinedStart)} to ${formatNumber(summary.economy.campaignSupply.adjustmentConflictsQuarantinedEnd)}.

## Replacement scheduler lane

| Measure | Result |
|---|---:|
| Configured contested share | ${formatNumber(summary.performance.replacementScheduler.configuredSharePercent)}% replacement |
| Replacement/general transitions | ${formatNumber(summary.performance.replacementScheduler.replacementTransitions)} / ${formatNumber(summary.performance.replacementScheduler.generalTransitions)} |
| Replacement share of due transitions | ${formatNumber(percentage(summary.performance.replacementScheduler.replacementTransitions, summary.performance.replacementScheduler.replacementTransitions + summary.performance.replacementScheduler.generalTransitions), 2)}% |
| Contested priority/general selections | ${formatNumber(summary.performance.replacementScheduler.prioritySelections)} / ${formatNumber(summary.performance.replacementScheduler.generalSelections)} |
| Work-conserving selections | ${formatNumber(summary.performance.replacementScheduler.workConservingSelections)} |
| Replacement queue, start to end | ${formatNumber(summary.performance.replacementScheduler.replacementQueueStart)} to ${formatNumber(summary.performance.replacementScheduler.replacementQueueEnd)} |
| General queue, start to end | ${formatNumber(summary.performance.replacementScheduler.generalQueueStart)} to ${formatNumber(summary.performance.replacementScheduler.generalQueueEnd)} |
| Replacement oldest overdue, start to end | ${formatNumber(summary.performance.replacementScheduler.replacementOldestOverdueStartMs / 1_000, 1)}s to ${formatNumber(summary.performance.replacementScheduler.replacementOldestOverdueEndMs / 1_000, 1)}s |
| General oldest overdue, start to end | ${formatNumber(summary.performance.replacementScheduler.generalOldestOverdueStartMs / 1_000, 1)}s to ${formatNumber(summary.performance.replacementScheduler.generalOldestOverdueEndMs / 1_000, 1)}s |
| Deferred replacement/general passes | ${formatNumber(summary.performance.replacementScheduler.replacementDeferredPasses)} / ${formatNumber(summary.performance.replacementScheduler.generalDeferredPasses)} |

## Performance and safety

| Measure | Result |
|---|---:|
| Tick p95 average | ${formatNumber(summary.performance.tickP95AverageMs, 3)} ms |
| Highest sampled tick p95 | ${formatNumber(summary.performance.tickP95MaximumMs, 3)} ms |
| Rolling tick maximum | ${formatNumber(summary.performance.tickRollingMaximumMs, 3)} ms |
| CPU average, one-core equivalent | ${formatNumber(summary.performance.cpuOneCoreAveragePercent, 2)}% |
| CPU maximum, one-core equivalent | ${formatNumber(summary.performance.cpuOneCoreMaximumPercent, 2)}% |
| RSS start → end | ${formatNumber(summary.performance.rssStartMiB, 2)} → ${formatNumber(summary.performance.rssEndMiB, 2)} MiB |
| RSS maximum | ${formatNumber(summary.performance.rssMaximumMiB, 2)} MiB |
| Scheduler queue maximum | ${formatNumber(summary.performance.schedulerQueueMaximum)} |
| X-Eve backlog, start → end (maximum) | ${formatNumber(summary.performance.xEve.backlogStart)} → ${formatNumber(summary.performance.xEve.backlogEnd)} (${formatNumber(summary.performance.xEve.backlogMaximum)}) |
| X-Eve oldest overdue, start → end (maximum) | ${formatNumber(summary.performance.xEve.oldestOverdueStartMs / 1_000, 1)}s → ${formatNumber(summary.performance.xEve.oldestOverdueEndMs / 1_000, 1)}s (${formatNumber(summary.performance.xEve.oldestOverdueMaximumMs / 1_000, 1)}s) |
| X-Eve received / processed during run | ${formatNumber(summary.performance.xEve.receivedEvents)} / ${formatNumber(summary.performance.xEve.processedJobs)} |
| New market fallbacks | ${formatNumber(summary.performance.marketFallbackDelta)} |
| New failed adjustments | ${formatNumber(summary.performance.failedAdjustmentDelta)} |
| New X-Eve failures | ${formatNumber(summary.performance.xEveFailureDelta)} |
`;

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, markdown);
if (summaryPath) {
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
