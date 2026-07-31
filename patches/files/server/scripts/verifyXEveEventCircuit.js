"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_X_EVE_ENABLED = "false";

const assert = require("assert");

const config = require("../src/config");
const bridge = require("../src/services/xEve/xEveEventBridge");

function createFakeRuntime(options = {}) {
  let nowMs = 1_000;
  let handoffMode = options.handoffMode || "success";
  let ingestMode = options.ingestMode || "success";
  let recoveryCalls = 0;
  const accepted = [];
  const prerequisites = new Map();
  const scheduler = {
    persistenceHealthy: true,
    persistenceError: null,
    lastDurableHandoffAtMs: nowMs,
    metrics: {
      durabilityHandoffSuccesses: 1,
    },
  };
  const completeHandoff = () => {
    nowMs += 1;
    scheduler.lastDurableHandoffAtMs = nowMs;
    scheduler.metrics.durabilityHandoffSuccesses += 1;
    return { success: true, blocked: false, pendingDirty: false };
  };
  const runPrerequisites = () => {
    for (const prerequisite of prerequisites.values()) {
      const result = prerequisite();
      if (!result || result.success !== true) return result;
    }
    return { success: true };
  };
  const maintainPersistence = () => {
    const prerequisite = runPrerequisites();
    if (!prerequisite.success) return prerequisite;
    if (handoffMode === "failure") {
      scheduler.persistenceHealthy = false;
      scheduler.persistenceError = "TEST_HANDOFF_FAILED";
      return { success: false, errorMsg: "TEST_HANDOFF_FAILED" };
    }
    if (handoffMode === "blocked") {
      return { success: true, blocked: true, pendingDirty: true };
    }
    return completeHandoff();
  };
  const runtime = {
    maintainPersistence,
    registerDurabilityPrerequisite(key, callback) {
      if (options.registrationMode === "throw") {
        throw Object.assign(new Error("TEST_REGISTRATION_THROWN"), {
          code: "TEST_REGISTRATION_THROWN",
        });
      }
      if (options.registrationMode === "failure") {
        return { success: false, errorMsg: "TEST_REGISTRATION_FAILED" };
      }
      prerequisites.set(key, callback);
      return { success: true };
    },
    unregisterDurabilityPrerequisite(key) {
      prerequisites.delete(key);
      return { success: true };
    },
  };
  return {
    accepted,
    scheduler,
    getDefaultRuntime() {
      return runtime;
    },
    getSnapshot() {
      return {
        started: true,
        scheduler: JSON.parse(JSON.stringify(scheduler)),
      };
    },
    ingestEvent(event) {
      if (ingestMode === "throw") {
        throw Object.assign(new Error("TEST_INGEST_THROWN"), { code: "TEST_INGEST_THROWN" });
      }
      if (ingestMode === "failure") {
        return { success: false, errorMsg: "TEST_INGEST_FAILED" };
      }
      accepted.push(event);
      return { success: true, replayed: false, data: event };
    },
    flushDurably() {
      const prerequisite = runPrerequisites();
      if (!prerequisite.success) return prerequisite;
      if (handoffMode === "failure") {
        return { success: false, errorMsg: "TEST_FLUSH_FAILED" };
      }
      return completeHandoff();
    },
    recoverPersistence() {
      recoveryCalls += 1;
      scheduler.persistenceHealthy = true;
      scheduler.persistenceError = null;
      return completeHandoff();
    },
    setHandoffMode(value) {
      handoffMode = value;
    },
    setIngestMode(value) {
      ingestMode = value;
    },
    setPersistenceHealth(healthy, errorMsg = null) {
      scheduler.persistenceHealthy = healthy === true;
      scheduler.persistenceError = scheduler.persistenceHealthy ? null : errorMsg;
    },
    getRecoveryCalls() {
      return recoveryCalls;
    },
  };
}

function verifyThrownIngestCircuit() {
  const fakeRuntime = createFakeRuntime({ ingestMode: "throw" });
  resetWith(fakeRuntime);
  const failed = publish(buildEvent(1), 19_000);
  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.pauseProduction, true);
  const status = bridge.getStatus({ force: true, refresh: false });
  assert.strictEqual(status.state, "open");
  assert.strictEqual(status.reason, "TEST_INGEST_THROWN");
  assert.strictEqual(status.requiresReconciliation, true);
  return status;
}

function successfulSourceCheckpoint() {
  return { success: true };
}

function buildEvent(number) {
  return {
    eventID: `TEST-${String(number).padStart(5, "0")}`,
    kind: "test_event",
    occurredAtMs: 10_000 + number,
    quantity: number,
  };
}

function publish(event, nowMs = event.occurredAtMs, sourceCheckpoint = successfulSourceCheckpoint) {
  return bridge.publishLivingUniverseEvent(event, {
    force: true,
    nowMs,
    sourceEpochMs: 5_000,
    sourceCheckpoint,
  });
}

function resetWith(fakeRuntime) {
  bridge._testing.resetCircuit();
  bridge._testing.setRuntimeModule(fakeRuntime);
}

function verifyBatchHandoff() {
  const fakeRuntime = createFakeRuntime();
  resetWith(fakeRuntime);
  for (let index = 1; index <= bridge.EVENT_HANDOFF_BATCH_SIZE; index += 1) {
    assert.strictEqual(publish(buildEvent(index)).success, true);
  }
  const status = bridge.getStatus({ force: true });
  assert.strictEqual(status.state, "closed");
  assert.strictEqual(status.pendingEventsSinceHandoff, 0);
  assert.strictEqual(status.metrics.handoffSuccesses, 1);
  assert.strictEqual(status.metrics.sourceCheckpointSuccesses, 1);
  assert.strictEqual(status.pendingSourceGenerations, 0);
  assert.strictEqual(fakeRuntime.accepted.length, bridge.EVENT_HANDOFF_BATCH_SIZE);
  return status;
}

function verifySourceCheckpointFailure() {
  const fakeRuntime = createFakeRuntime();
  resetWith(fakeRuntime);
  let failed = null;
  for (let index = 1; index <= bridge.EVENT_HANDOFF_BATCH_SIZE; index += 1) {
    failed = publish(
      buildEvent(index),
      50_000 + index,
      () => ({ success: false, errorMsg: "TEST_SOURCE_FLUSH_FAILED" }),
    );
  }
  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.pauseProduction, true);
  const status = bridge.getStatus({ force: true, refresh: false });
  assert.strictEqual(status.state, "open");
  assert.strictEqual(status.reason, "X_EVE_SOURCE_JOURNAL_FLUSH_FAILED");
  assert.strictEqual(status.metrics.handoffSuccesses, 0);
  assert.strictEqual(status.metrics.sourceCheckpointFailures, 1);
  assert.strictEqual(status.pendingSourceGenerations, bridge.EVENT_HANDOFF_BATCH_SIZE);
  return status;
}

function verifyRegistrationFailureCircuit() {
  const fakeRuntime = createFakeRuntime({ registrationMode: "throw" });
  resetWith(fakeRuntime);
  const failed = publish(buildEvent(1), 55_000);
  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.pauseProduction, true);
  const status = bridge.getStatus({ force: true, refresh: false });
  assert.strictEqual(status.state, "open");
  assert.strictEqual(status.reason, "X_EVE_SOURCE_BARRIER_REGISTRATION_FAILED");
  assert.strictEqual(status.requiresReconciliation, true);
  return status;
}

function verifyImmediateFailureCircuit() {
  const fakeRuntime = createFakeRuntime({ ingestMode: "failure" });
  resetWith(fakeRuntime);
  const failed = publish(buildEvent(1));
  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.pauseProduction, true);
  assert.strictEqual(bridge.getStatus({ force: true }).state, "open");

  fakeRuntime.setIngestMode("success");
  const rejected = publish(buildEvent(2));
  assert.strictEqual(rejected.success, false);
  assert.strictEqual(rejected.pauseProduction, true);
  assert.strictEqual(fakeRuntime.accepted.length, 0);
  fakeRuntime.recoverPersistence();
  const stillPaused = bridge.checkLivingEconomyProduction({ force: true, nowMs: 15_000 });
  assert.strictEqual(stillPaused.success, false);
  assert.strictEqual(bridge.getStatus({ force: true }).requiresReconciliation, true);
  return bridge.getStatus({ force: true });
}

function verifyJournalBackpressure() {
  const fakeRuntime = createFakeRuntime({ handoffMode: "blocked" });
  resetWith(fakeRuntime);
  let lastResult = null;
  for (let index = 1; index <= bridge.MAX_UNCONFIRMED_EVENTS; index += 1) {
    lastResult = publish(buildEvent(index), 20_000 + index);
  }
  assert.strictEqual(lastResult.success, false);
  assert.strictEqual(lastResult.pauseProduction, true);
  const status = bridge.getStatus({ force: true });
  assert.strictEqual(status.state, "open");
  assert.strictEqual(status.reason, "X_EVE_EVENT_JOURNAL_BACKPRESSURE");
  assert.strictEqual(
    status.pendingEventsSinceHandoff,
    bridge.MAX_UNCONFIRMED_EVENTS,
  );
  assert.strictEqual(status.journalReserveRows, 1_024);
  assert.strictEqual(fakeRuntime.accepted.length, bridge.MAX_UNCONFIRMED_EVENTS);
  assert.ok(
    status.metrics.handoffAttempts <= 16,
    `blocked handoff retry loop was not bounded: ${status.metrics.handoffAttempts}`,
  );

  fakeRuntime.setHandoffMode("success");
  fakeRuntime.recoverPersistence();
  const recovered = bridge.checkLivingEconomyProduction({ force: true, nowMs: 31_000 });
  assert.strictEqual(recovered.success, true);
  assert.strictEqual(bridge.getStatus({ force: true }).state, "closed");
  assert.strictEqual(bridge.getStatus({ force: true }).pendingEventsSinceHandoff, 0);
  return status;
}

function verifyReconciliationRecovery() {
  const fakeRuntime = createFakeRuntime({ ingestMode: "failure" });
  resetWith(fakeRuntime);
  assert.strictEqual(publish(buildEvent(1)).success, false);
  fakeRuntime.setIngestMode("success");
  const events = [buildEvent(1), buildEvent(2), buildEvent(3)];
  const result = bridge.reconcileRecentLivingEconomyEvents({
    force: true,
    nowMs: 40_000,
    sourceAlreadyDurable: true,
    journalProvider: {
      getEventJournal() {
        return { sourceEpochMs: 5_000, maximumRows: 4_096, events };
      },
    },
  });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.data.accepted, 3);
  const status = bridge.getStatus({ force: true });
  assert.strictEqual(status.state, "closed");
  assert.strictEqual(status.pendingEventsSinceHandoff, 0);
  return status;
}

function verifyAutomaticRecoveryWithoutRestart() {
  const fakeRuntime = createFakeRuntime({ ingestMode: "failure" });
  resetWith(fakeRuntime);
  const first = buildEvent(1);
  assert.strictEqual(publish(first, 60_000).success, false);
  fakeRuntime.setIngestMode("success");
  bridge._testing.setJournalProvider({
    getEventJournal() {
      return {
        sourceEpochMs: 5_000,
        maximumRows: 4_096,
        events: [first, buildEvent(2)],
      };
    },
  });
  const priorEnabled = config.xEveEnabled;
  config.xEveEnabled = true;
  let sourceCheckpointCalls = 0;
  try {
    const recovered = bridge.checkLivingEconomyProduction({
      nowMs: 61_000,
      sourceCheckpoint() {
        sourceCheckpointCalls += 1;
        return { success: true };
      },
    });
    assert.strictEqual(recovered.success, true);
    assert.strictEqual(recovered.recovered, true);
    const status = bridge.getStatus({ refresh: false });
    assert.strictEqual(status.state, "closed");
    assert.strictEqual(status.requiresReconciliation, false);
    assert.strictEqual(status.metrics.automaticRecoverySuccesses, 1);
    assert.ok(sourceCheckpointCalls >= 1);
    status.testSourceCheckpointCalls = sourceCheckpointCalls;
    return status;
  } finally {
    config.xEveEnabled = priorEnabled;
  }
}

function verifyRuntimeHealthAutomaticRecovery() {
  const fakeRuntime = createFakeRuntime();
  resetWith(fakeRuntime);
  fakeRuntime.setPersistenceHealth(false, "TEST_PERIODIC_HANDOFF_FAILED");
  bridge._testing.setJournalProvider({
    checkpointXEveSourceJournal: successfulSourceCheckpoint,
    getEventJournal() {
      return { sourceEpochMs: 5_000, maximumRows: 4_096, events: [] };
    },
  });
  const priorEnabled = config.xEveEnabled;
  config.xEveEnabled = true;
  try {
    const recovered = bridge.checkLivingEconomyProduction({
      nowMs: 70_000,
      sourceCheckpoint: successfulSourceCheckpoint,
    });
    assert.strictEqual(recovered.success, true);
    assert.strictEqual(recovered.recovered, true);
    assert.strictEqual(fakeRuntime.getRecoveryCalls(), 1);
    const status = bridge.getStatus({ refresh: false });
    assert.strictEqual(status.state, "closed");
    assert.strictEqual(status.metrics.automaticRecoveryAttempts, 1);
    return status;
  } finally {
    config.xEveEnabled = priorEnabled;
  }
}

function verifySourceResetDrain() {
  const fakeRuntime = createFakeRuntime();
  resetWith(fakeRuntime);
  assert.strictEqual(publish(buildEvent(1), 80_000).success, true);
  const drained = bridge.drainBeforeSourceReset({
    force: true,
    nowMs: 80_001,
    journalRows: 1,
    sourceCheckpoint: successfulSourceCheckpoint,
  });
  assert.strictEqual(drained.success, true);
  const status = bridge.getStatus({ force: true, refresh: false });
  assert.strictEqual(status.pendingSourceGenerations, 0);
  assert.strictEqual(status.pendingEventsSinceHandoff, 0);
  return status;
}

function run() {
  const batch = verifyBatchHandoff();
  const failure = verifyImmediateFailureCircuit();
  const thrownIngest = verifyThrownIngestCircuit();
  const sourceFailure = verifySourceCheckpointFailure();
  const registrationFailure = verifyRegistrationFailureCircuit();
  const backpressure = verifyJournalBackpressure();
  const reconciliation = verifyReconciliationRecovery();
  const automaticRecovery = verifyAutomaticRecoveryWithoutRestart();
  const runtimeHealthRecovery = verifyRuntimeHealthAutomaticRecovery();
  const sourceResetDrain = verifySourceResetDrain();
  bridge._testing.setRuntimeModule(null);
  bridge._testing.resetCircuit();
  console.log(JSON.stringify({
    success: true,
    batch: {
      acceptedEvents: batch.metrics.acceptedEvents,
      handoffSuccesses: batch.metrics.handoffSuccesses,
    },
    immediateFailure: {
      state: failure.state,
      reason: failure.reason,
    },
    sourceFailure: {
      state: sourceFailure.state,
      reason: sourceFailure.reason,
      pendingSourceGenerations: sourceFailure.pendingSourceGenerations,
    },
    registrationFailure: {
      state: registrationFailure.state,
      reason: registrationFailure.reason,
    },
    thrownIngest: {
      state: thrownIngest.state,
      reason: thrownIngest.reason,
    },
    backpressure: {
      state: backpressure.state,
      pendingEvents: backpressure.pendingEventsSinceHandoff,
      reserveRows: backpressure.journalReserveRows,
      boundedHandoffAttempts: backpressure.metrics.handoffAttempts,
    },
    reconciliation: {
      state: reconciliation.state,
      reconciliationRuns: reconciliation.metrics.reconciliationRuns,
    },
    automaticRecovery: {
      state: automaticRecovery.state,
      attempts: automaticRecovery.metrics.automaticRecoveryAttempts,
      successes: automaticRecovery.metrics.automaticRecoverySuccesses,
      durationMs: automaticRecovery.lastAutomaticRecoveryDurationMs,
      sourceCheckpointCalls: automaticRecovery.testSourceCheckpointCalls,
    },
    runtimeHealthRecovery: {
      state: runtimeHealthRecovery.state,
      attempts: runtimeHealthRecovery.metrics.automaticRecoveryAttempts,
    },
    sourceResetDrain: {
      state: sourceResetDrain.state,
      pendingSourceGenerations: sourceResetDrain.pendingSourceGenerations,
      pendingEvents: sourceResetDrain.pendingEventsSinceHandoff,
    },
  }, null, 2));
}

try {
  run();
} catch (error) {
  bridge._testing.setRuntimeModule(null);
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
