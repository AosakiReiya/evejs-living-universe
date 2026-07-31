"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const economyRuntime = require(
  "../src/space/npc/ambientTraffic/livingEconomyRuntime",
);
const economyState = require(
  "../src/space/npc/ambientTraffic/livingEconomyState",
);
const universeRuntime = require(
  "../src/space/npc/ambientTraffic/livingUniverseRuntime",
);
const universeState = require(
  "../src/space/npc/ambientTraffic/livingUniverseState",
);

function verifyDestructionAccounting() {
  const state = universeState.buildDefaultState();
  state.actors.actor1 = {
    actorID: "actor1",
    profileID: "test-profile",
    shipTypeID: 24698,
    role: "combat",
    factionID: 500001,
    factionName: "Caldari State",
  };
  universeRuntime._testing.setRuntimeStateForTest(state, 1_700_000_000_000);
  assert.equal(
    universeRuntime._testing.recordShipDestruction(
      state.actors.actor1,
      "conflict",
    ),
    true,
  );
  assert.equal(
    universeRuntime._testing.recordShipDestruction(
      state.actors.actor1,
      "physical",
    ),
    true,
  );
  assert.equal(state.metrics.shipLosses, 2);
  assert.equal(state.metrics.conflictShipLosses, 1);
  assert.equal(state.metrics.physicalShipLosses, 1);
  assert.equal(state.metrics.shipLossesByType["24698"].losses, 2);
  assert.equal(state.metrics.shipLossesByRole.combat, 2);
  assert.equal(state.metrics.shipLossesByFaction["Caldari State"], 2);
}

function verifyReplacementPipelineSummary() {
  const nowMs = 1_700_000_100_000;
  const state = economyState.buildDefaultState();
  assert.equal(state.metrics.replacementValueFulfilledISK, 0);
  assert.equal(state.metrics.replacementHullValueISK, 0);
  assert.equal(state.metrics.replacementFittingValueISK, 0);
  assert.deepEqual(state.metrics.replacementHullLossesByType, {});
  state.replacementDemands = {
    "LER-00000001": {
      demandID: "LER-00000001",
      status: "pending",
      shipTypeID: 24698,
      shipName: "Drake",
      createdAtMs: nowMs - 2_000,
      requirements: [
        { typeID: 24698, quantity: 3, unitValueISK: 100 },
        { typeID: 31360, quantity: 2, unitValueISK: 500 },
      ],
      fulfilledQuantities: { 24698: 1 },
      lastError: null,
    },
    "LER-00000002": {
      demandID: "LER-00000002",
      status: "pending",
      shipTypeID: 16229,
      shipName: "Brutix",
      createdAtMs: nowMs - 5_000,
      requirements: [
        { typeID: 16229, quantity: 1, unitValueISK: 250 },
      ],
      fulfilledQuantities: {},
      lastError: "INPUTS_UNAVAILABLE",
    },
    "LER-00000003": {
      demandID: "LER-00000003",
      status: "fulfilled",
      shipTypeID: 16227,
      shipName: "Ferox",
      createdAtMs: nowMs - 10_000,
      requirements: [],
      fulfilledQuantities: {},
    },
  };
  economyRuntime._testing.setRuntimeStateForTest(state);
  const summary = economyRuntime._testing.summarizeReplacementPipeline(nowMs);
  assert.equal(summary.pending, 2);
  assert.equal(summary.fulfilled, 1);
  assert.equal(summary.pendingUnits, 5);
  assert.equal(summary.pendingValueISK, 1_450);
  assert.equal(summary.partiallyFulfilledPackages, 1);
  assert.equal(summary.untouchedPackages, 1);
  assert.equal(summary.pendingWithErrors, 1);
  assert.equal(summary.oldestPendingAgeMs, 5_000);
  assert.equal(summary.oldestPendingDemandID, "LER-00000002");
  assert.equal(summary.byHull.length, 2);
  assert.equal(summary.byHull[0].shipName, "Drake");
  assert.equal(summary.byHull[0].pendingUnits, 4);
}

function verifyReplacementPackageCoverage() {
  const complete = economyRuntime._testing.buildReplacementRequirementPackage({
    actorID: "covered-actor",
    shipTypeID: 24698,
    shipName: "Drake",
    profileID: "profile-does-not-exist",
  });
  assert.equal(complete.complete, true);
  assert.equal(complete.hullCovered, true);
  assert.equal(
    complete.requirements.some((item) => item.typeID === 24698),
    true,
  );

  const incomplete = economyRuntime._testing.buildReplacementRequirementPackage({
    actorID: "uncovered-actor",
    shipTypeID: 9_999_999,
    shipName: "Unsupported test hull",
    profileID: "profile-does-not-exist",
  });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.hullCovered, false);
  assert.deepEqual(
    incomplete.missing.map((item) => item.typeID),
    [9_999_999],
  );

  const audit = economyRuntime._testing.auditReplacementCoverage([
    {
      actorID: "covered-actor",
      shipTypeID: 24698,
      profileID: "profile-does-not-exist",
    },
    {
      actorID: "uncovered-actor",
      shipTypeID: 9_999_999,
      profileID: "profile-does-not-exist",
    },
  ]);
  assert.equal(audit.actors, 2);
  assert.equal(audit.actorsWithGaps, 1);
  assert.equal(audit.actorsWithHullGaps, 1);
  assert.equal(audit.missingTypeCount, 1);
}

function verifyStressSampleSchema() {
  const nowMs = Date.now();
  const fixture = {
    capturedAt: new Date(nowMs).toISOString(),
    capturedAtMs: nowMs,
    process: {
      pid: 100,
      uptimeSeconds: 90,
      rssBytes: 512 * 1024 * 1024,
      heapUsedBytes: 256 * 1024 * 1024,
      cpu: {
        oneCorePercent: 50,
        machinePercent: 5,
        eventLoopUtilizationPercent: 20,
      },
    },
    runtimeTick: {
      intervalMs: { average: 100, p95: 110, maximum: 120 },
      workMs: { average: 5, p95: 8, maximum: 15 },
    },
    livingUniverse: {
      actorCount: 5_000,
      flightCount: 2_800,
      materializedShips: 0,
      replacementHolds: { activeFlights: 12 },
      replacementCoverage: {
        actors: 5_000,
        actorsFullyCovered: 5_000,
        actorsWithGaps: 0,
        actorsWithHullGaps: 0,
        coveragePercent: 100,
        hullCoveragePercent: 100,
        missingTypeCount: 0,
        missing: [],
      },
      offGridAcceleration: {
        travelTimeMultiplier: 72,
        activityTimeMultiplier: 72,
      },
      metrics: {
        completedTrips: 1_000,
        shipLosses: 205,
        conflictShipLosses: 8,
        physicalShipLosses: 2,
        replacements: 205,
        shipLossesByType: {
          24698: { shipTypeID: 24698, shipName: "Drake", losses: 5 },
        },
        shipLossesByRole: { combat: 10 },
        shipLossesByFaction: { "Caldari State": 10 },
        encountersScheduled: 100,
        encountersObserved: 10,
        encountersResolved: 90,
        encountersResolvedOffGrid: 80,
      },
      scheduler: {
        queueSize: 2_800,
        generalQueueSize: 2_200,
        replacementPriorityQueueSize: 600,
        nextFlightDueInMs: 1,
        oldestDueFlightOverdueMs: 30_000,
        generalOldestOverdueMs: 30_000,
        replacementPriorityOldestOverdueMs: 10_000,
        replacementPrioritySharePercent: 75,
        metrics: {
          dueFlightsProcessed: 1_000,
          replacementPriorityDueFlightsProcessed: 750,
          generalDueFlightsProcessed: 250,
          deferredDuePasses: 100,
          replacementPriorityDeferredDuePasses: 80,
          generalDeferredDuePasses: 90,
          replacementSchedulerContestedSelections: 800,
          replacementSchedulerPrioritySelections: 600,
          replacementSchedulerGeneralSelections: 200,
          replacementSchedulerWorkConservingSelections: 200,
        },
      },
      conflict: {
        active: 2,
        pendingEvidence: 1,
        campaigns: [],
        roaming: { groups: 10, activeCamps: 2, pendingContacts: 3, metrics: {} },
      },
      economy: {
        activeJobs: 20,
        metrics: {
          jobsDelivered: 10,
          jobsLost: 1,
          replacementDemandsCreated: 211,
          replacementDemandsFulfilled: 2,
          replacementHullLosses: 211,
          replacementUnitsRequested: 50_832,
          replacementUnitsFulfilled: 5_000,
          replacementValueISK: 43_000_000_000,
          replacementValueFulfilledISK: 500_000_000,
          replacementHullValueISK: 30_000_000_000,
          replacementFittingValueISK: 13_000_000_000,
          replacementHullLossesByType: {
            24698: {
              shipTypeID: 24698,
              shipName: "Drake",
              losses: 5,
              replacementValueISK: 500_000_000,
            },
          },
          replacementDemandValidationFailures: 0,
          replacementRequirementUnitsRejected: 0,
          replacementDemandLinksReconciled: 103,
          replacementFreightRepositionsAssigned: 7,
          replacementFreightRepositionsCompleted: 5,
        },
        freight: {
          activeJobs: 20,
          activeUnits: 2_000,
          oldestActiveAgeMs: 900_000,
          statuses: { in_transit: 20 },
          replacementPriority: {
            activeJobs: 12,
            activeUnits: 1_200,
            oldestActiveAgeMs: 900_000,
            jobsAssigned: 30,
            jobsDelivered: 18,
            unitsAssigned: 3_000,
            unitsDelivered: 1_800,
            activeRepositions: 2,
          },
          general: {
            activeJobs: 8,
            activeUnits: 800,
            oldestActiveAgeMs: 600_000,
            jobsAssigned: 20,
            jobsDelivered: 12,
          },
          recovery: {
            activeIssues: 0,
            detected: 3,
            routeMismatches: 2,
            routesRecovered: 1,
            routesReplanned: 1,
            schedulerWakeups: 3,
            deferred: 1,
            unloads: 0,
            unitsUnloaded: 0,
            failures: 0,
          },
        },
        replacements: {
          pending: 209,
          fulfilled: 2,
          pendingUnits: 45_832,
          pendingValueISK: 42_500_000_000,
          partiallyFulfilledPackages: 20,
          untouchedPackages: 189,
          pendingWithErrors: 0,
          oldestPendingAgeMs: 3_600_000,
          oldestPendingDemandID: "LER-00000001",
          byHull: [],
        },
        demandCoverage: {
          requirements: 1_670,
          byClass: { replacement: 1_670 },
          byStatus: { awaiting_freight: 968 },
          blockers: { awaiting_freight: 968 },
          byKind: {
            replacement: {
              requirements: 968,
              byClass: { regional_stock: 968 },
              byStatus: { awaiting_freight: 968 },
              blockers: { awaiting_freight: 968 },
            },
          },
        },
        eventBridge: { state: "closed", productionPaused: false },
        marketBatches: {
          batchesAttempted: 1,
          batchesSucceeded: 1,
          batchFallbacks: 0,
          adjustmentsSubmitted: 1,
          lastBatchError: null,
        },
      },
    },
    xEve: {
      scheduler: {
        mode: "stress",
        persistenceHealthy: true,
        backlogTotal: 0,
        oldestOverdueMs: 0,
        metrics: {
          failedJobs: 0,
          deadLetterJobs: 0,
          quarantinedJobs: 0,
          uncertainJobs: 0,
        },
      },
    },
  };
  const fixturePath = path.join(
    os.tmpdir(),
    `x-eve-destruction-replacement-${process.pid}.json`,
  );
  const samplesPath = path.join(
    os.tmpdir(),
    `x-eve-destruction-replacement-${process.pid}.jsonl`,
  );
  const reportPath = path.join(
    os.tmpdir(),
    `x-eve-destruction-replacement-${process.pid}.md`,
  );
  const summaryPath = path.join(
    os.tmpdir(),
    `x-eve-destruction-replacement-${process.pid}-summary.json`,
  );
  fs.writeFileSync(fixturePath, JSON.stringify(fixture));
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, "captureXEveStressSample.js"), fixturePath],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const sample = JSON.parse(result.stdout);
    assert.equal(sample.schemaVersion, 3);
    assert.equal(sample.livingUniverse.destruction.shipLosses, 205);
    assert.equal(sample.livingUniverse.destruction.conflictShipLosses, 8);
    assert.equal(sample.livingUniverse.replacementHoldsActiveFlights, 12);
    assert.equal(sample.capabilities.complete, true);
    assert.equal(
      sample.livingUniverse.replacementCoverage.actorsWithGaps,
      0,
    );
    assert.equal(sample.economy.replacement.demandsCreated, 211);
    assert.equal(sample.economy.replacement.pendingUnits, 45_832);
    assert.equal(sample.economy.replacement.unitFulfillmentPercent, 9.836);
    assert.equal(
      sample.economy.replacement.hullLossesByType["24698"].losses,
      5,
    );
    assert.equal(sample.economy.demandCoverage.blockers.awaiting_freight, 968);
    assert.equal(
      sample.economy.demandCoverage.byKind.replacement.requirements,
      968,
    );
    assert.equal(
      sample.economy.freight.replacementPriority.jobsAssigned,
      30,
    );
    assert.equal(
      sample.economy.freight.replacementPriority.jobsDelivered,
      18,
    );
    assert.equal(
      sample.economy.freight.replacementPriority.activeRepositions,
      2,
    );
    assert.equal(
      sample.economy.freight.replacementPriority.repositionsAssigned,
      7,
    );
    assert.equal(
      sample.economy.freight.replacementPriority.repositionsCompleted,
      5,
    );
    assert.equal(sample.economy.freight.recovery.routeMismatches, 2);
    assert.equal(sample.economy.freight.recovery.routesRecovered, 1);
    assert.equal(
      sample.livingUniverse.scheduler.replacementPriorityQueueSize,
      600,
    );
    assert.equal(
      sample.livingUniverse.scheduler.replacementPriorityDueFlightsProcessed,
      750,
    );

    const finalSample = JSON.parse(JSON.stringify(sample));
    finalSample.capturedAtMs += 60_000;
    finalSample.capturedAt = new Date(finalSample.capturedAtMs).toISOString();
    finalSample.sampledAt = finalSample.capturedAt;
    finalSample.process.uptimeSeconds += 60;
    finalSample.economy.freight.delivered += 4;
    finalSample.economy.freight.unitsDelivered += 400;
    Object.assign(finalSample.economy.freight.replacementPriority, {
      activeJobs: 14,
      activeUnits: 1_400,
      oldestActiveAgeMs: 960_000,
      jobsAssigned: 36,
      jobsDelivered: 22,
      unitsAssigned: 3_600,
      unitsDelivered: 2_200,
      activeRepositions: 4,
      repositionsAssigned: 10,
      repositionsCompleted: 6,
    });
    Object.assign(finalSample.economy.freight.recovery, {
      activeIssues: 1,
      detected: 5,
      routeMismatches: 4,
      routesRecovered: 2,
      routesReplanned: 2,
      schedulerWakeups: 5,
      deferred: 2,
      unloads: 1,
      unitsUnloaded: 50,
      failures: 1,
    });
    Object.assign(finalSample.livingUniverse.scheduler, {
      generalQueueSize: 2_300,
      replacementPriorityQueueSize: 500,
      generalOldestOverdueMs: 45_000,
      replacementPriorityOldestOverdueMs: 4_000,
      dueFlightsProcessed: 1_200,
      replacementPriorityDueFlightsProcessed: 900,
      generalDueFlightsProcessed: 300,
      deferredDuePasses: 120,
      replacementPriorityDeferredDuePasses: 90,
      generalDeferredDuePasses: 110,
      contestedSelections: 1_000,
      prioritySelections: 750,
      generalSelections: 250,
      workConservingSelections: 250,
    });
    fs.writeFileSync(
      samplesPath,
      `${JSON.stringify(sample)}\n${JSON.stringify(finalSample)}\n`,
    );
    const analysis = spawnSync(
      process.execPath,
      [
        path.join(__dirname, "analyzeDestructionReplacementStress.js"),
        samplesPath,
        reportPath,
        summaryPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(analysis.status, 0, analysis.stderr || analysis.stdout);
    const analysisSummary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    const priority = analysisSummary.economy.freight.replacementPriority;
    assert.equal(priority.jobsAssigned, 6);
    assert.equal(priority.jobsDelivered, 4);
    assert.equal(priority.unitsAssigned, 600);
    assert.equal(priority.unitsDelivered, 400);
    assert.equal(priority.repositionsAssigned, 3);
    assert.equal(priority.repositionsCompleted, 1);
    assert.equal(priority.activeRepositionsEnd, 4);
    const recovery = analysisSummary.economy.freight.recovery;
    assert.equal(recovery.detected, 2);
    assert.equal(recovery.routeMismatches, 2);
    assert.equal(recovery.routesRecovered, 1);
    assert.equal(recovery.routesReplanned, 1);
    assert.equal(recovery.schedulerWakeups, 2);
    assert.equal(recovery.unloads, 1);
    assert.equal(recovery.unitsUnloaded, 50);
    assert.equal(recovery.failures, 1);
    assert.equal(recovery.activeIssuesEnd, 1);
    const replacementScheduler = analysisSummary.performance.replacementScheduler;
    assert.equal(replacementScheduler.replacementTransitions, 150);
    assert.equal(replacementScheduler.generalTransitions, 50);
    assert.equal(replacementScheduler.prioritySelections, 150);
    assert.equal(replacementScheduler.generalSelections, 50);
    assert.equal(replacementScheduler.replacementQueueEnd, 500);
    assert.match(
      fs.readFileSync(reportPath, "utf8"),
      /Replacement-priority logistics/,
    );
    assert.match(
      fs.readFileSync(reportPath, "utf8"),
      /Replacement scheduler lane/,
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
    fs.rmSync(samplesPath, { force: true });
    fs.rmSync(reportPath, { force: true });
    fs.rmSync(summaryPath, { force: true });
  }
}

function runVerification() {
  verifyDestructionAccounting();
  verifyReplacementPipelineSummary();
  verifyReplacementPackageCoverage();
  verifyStressSampleSchema();
  return {
    success: true,
    verified: [
      "loss source and hull attribution",
      "replacement backlog units, value, age, and errors",
      "complete replacement-package coverage and missing-hull rejection",
      "stress sampler schema 3 replacement freight and recovery coverage",
      "stress analyzer replacement freight and recovery deltas",
    ],
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(runVerification(), null, 2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}

module.exports = { runVerification };
