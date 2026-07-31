"use strict";

const assert = require("assert");
const { performance } = require("perf_hooks");

const universe = require("../src/space/npc/ambientTraffic/livingUniverseRuntime");
const roamingKernel = require("../src/space/npc/ambientTraffic/livingRoamingKernel");

function percentile(values, fraction) {
  const sorted = values.slice().sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] || 0;
}

function main() {
  const nowMs = 1_800_000_000_000;
  const state = universe._testing.buildPopulationPlan(4_000, nowMs);
  assert(state.roamingConflict, "Population plan did not create roaming state.");
  let status = roamingKernel.getStatus(state.roamingConflict, nowMs);
  assert.strictEqual(status.groups, 96, "Expected the configured 96 bounded task groups.");
  const initialDeadlines = new Set(
    Object.values(state.roamingConflict.groups).map((group) => group.nextActionAtMs),
  );
  assert(
    initialDeadlines.size >= 72,
    `Initial operation jitter is too clustered (${initialDeadlines.size} unique deadlines).`,
  );
  const serializedBytes = Buffer.byteLength(JSON.stringify(state.roamingConflict));
  const restored = JSON.parse(JSON.stringify(state.roamingConflict));
  roamingKernel.ensureState(restored, nowMs);
  roamingKernel.rebuildIndexes(restored);
  roamingKernel.rebuildDeadlineHeap(restored);
  assert.strictEqual(
    roamingKernel.getStatus(restored, nowMs).groups,
    status.groups,
    "Roaming groups did not survive persistence.",
  );

  universe._testing.setRuntimeStateForTest(state, nowMs);
  const runtime = { scenes: new Map() };
  const dispatchDurationsMs = [];
  let processed = 0;
  let maximumProcessed = 0;
  let maximumCamps = 0;
  let scheduled = 0;
  let rejected = 0;
  let expired = 0;
  let deferred = 0;
  const simulatedHours = 4;
  for (let second = 0; second <= simulatedHours * 60 * 60; second += 1) {
    const atMs = nowMs + (second * 1_000);
    const startedAtMs = performance.now();
    const result = universe._testing.tickRoamingConflict(runtime, atMs);
    dispatchDurationsMs.push(performance.now() - startedAtMs);
    processed += result.processed;
    maximumProcessed = Math.max(maximumProcessed, result.processed);
    scheduled += result.scheduled;
    rejected += result.rejected;
    expired += result.expired || 0;
    deferred += result.deferredContacts || result.deferred || 0;
    status = roamingKernel.getStatus(state.roamingConflict, atMs);
    maximumCamps = Math.max(maximumCamps, status.activeCamps);
    assert(status.activeCamps <= 6, "The global six-camp hard limit was exceeded.");
  }

  assert(maximumProcessed <= 16, "The per-pass transition cap was exceeded.");
  assert(processed > 0, "No roaming operation made progress.");
  assert(scheduled > 0, "No emergent route contact became an encounter.");
  const operationEncounters = Object.values(state.encounters || {}).filter(
    (encounter) => encounter && encounter.sourceOperationID,
  );
  assert(operationEncounters.length > 0, "Operation encounters were not retained.");
  assert(
    operationEncounters.every((encounter) => (
      encounter.playerNeutral === true &&
      encounter.attackerFlightIDs.length === 1 &&
      encounter.defenderFlightIDs.length === 1
    )),
    "An operation encounter lost explicit participants or player neutrality.",
  );
  const p95DispatchMs = percentile(dispatchDurationsMs, 0.95);
  assert(
    p95DispatchMs < 10,
    `Roaming integration p95 ${p95DispatchMs.toFixed(2)}ms is unexpectedly high.`,
  );

  const staleState = universe._testing.buildPopulationPlan(400, nowMs);
  universe._testing.setRuntimeStateForTest(staleState, nowMs);
  const staleRuntime = { scenes: new Map() };
  const staleCatchUpAtMs = nowMs + (24 * 60 * 60_000);
  let staleProcessed = 0;
  let staleExpired = 0;
  let staleScheduled = 0;
  let stalePasses = 0;
  for (; stalePasses < 256 && staleExpired <= 0; stalePasses += 1) {
    const result = universe._testing.tickRoamingConflict(staleRuntime, staleCatchUpAtMs);
    staleProcessed += result.processed;
    staleExpired += result.expired || 0;
    staleScheduled += result.scheduled || 0;
    assert.equal(
      result.scheduled || 0,
      0,
      "A historical catch-up contact was scheduled as a current battle.",
    );
  }
  assert(staleProcessed > 0, "The stale catch-up probe processed no historical work.");
  assert(staleExpired > 0, "The stale catch-up probe produced no expired contact.");
  assert.equal(staleScheduled, 0);
  assert.equal(
    Object.values(staleState.encounters || {}).filter(
      (encounter) => encounter && encounter.sourceOperationID,
    ).length,
    0,
    "An expired catch-up contact was retained as an operation encounter.",
  );

  process.stdout.write(`${JSON.stringify({
    success: true,
    populationActors: Object.keys(state.actors).length,
    populationFlights: Object.keys(state.flights).length,
    roamingGroups: status.groups,
    serializedRoamingStateKiB: Number((serializedBytes / 1024).toFixed(1)),
    uniqueInitialDeadlines: initialDeadlines.size,
    simulatedHours,
    transitionsProcessed: processed,
    maximumTransitionsInOnePass: maximumProcessed,
    maximumSimultaneousCamps: maximumCamps,
    encountersScheduled: scheduled,
    contactsRejectedWhileEncounterCapBusy: rejected,
    contactsExpiredDuringRealtimeCadence: expired,
    contactsDeferredDuringRealtimeCadence: deferred,
    operationEncountersRetained: operationEncounters.length,
    staleCatchUp: {
      hoursLate: 24,
      passes: stalePasses,
      transitionsProcessed: staleProcessed,
      expiredContacts: staleExpired,
      encountersScheduled: staleScheduled,
    },
    dispatchTimingMs: {
      average: Number((
        dispatchDurationsMs.reduce((sum, value) => sum + value, 0) /
        dispatchDurationsMs.length
      ).toFixed(3)),
      p95: Number(p95DispatchMs.toFixed(3)),
      maximum: Number(Math.max(...dispatchDurationsMs).toFixed(3)),
      configuredBudget: 1.5,
    },
  }, null, 2)}\n`);
  process.exit(0);
}

main();
