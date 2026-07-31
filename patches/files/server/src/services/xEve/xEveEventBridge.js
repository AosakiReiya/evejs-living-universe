"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../config"));

const EVENT_HANDOFF_BATCH_SIZE = 64;
const EVENT_HANDOFF_RETRY_MS = 250;
const EVENT_JOURNAL_MAX_ROWS = 4096;
const EVENT_JOURNAL_RESERVE_ROWS = 1024;
const MAX_UNCONFIRMED_EVENTS = EVENT_JOURNAL_MAX_ROWS - EVENT_JOURNAL_RESERVE_ROWS;
const SOURCE_DURABILITY_PREREQUISITE = "living-economy-source-journal";

function createCircuitState() {
  return {
    open: false,
    reason: null,
    openedAtMs: 0,
    pendingEventsSinceHandoff: 0,
    lastObservedHandoffAtMs: 0,
    lastObservedHandoffSuccesses: 0,
    nextHandoffAttemptAtMs: 0,
    lastJournalRows: 0,
    lastFailureAtMs: 0,
    lastFailureEventID: null,
    lastFailureSourceEpochMs: 0,
    requiresReconciliation: false,
    unreconciledBufferedEvents: 0,
    sourceGeneration: 0,
    sourceDurableGeneration: 0,
    lastSourceCheckpointAtMs: 0,
    lastSourceCheckpointDurationMs: 0,
    lastAutomaticRecoveryAtMs: 0,
    lastAutomaticRecoveryDurationMs: 0,
    metrics: {
      acceptedEvents: 0,
      replayedEvents: 0,
      rejectedEvents: 0,
      bufferedEventsAtFailure: 0,
      circuitTrips: 0,
      circuitRecoveries: 0,
      handoffAttempts: 0,
      handoffSuccesses: 0,
      handoffBlocked: 0,
      handoffFailures: 0,
      reconciliationRuns: 0,
      reconciliationFailures: 0,
      sourceCheckpointAttempts: 0,
      sourceCheckpointSuccesses: 0,
      sourceCheckpointFailures: 0,
      automaticRecoveryAttempts: 0,
      automaticRecoverySuccesses: 0,
      automaticRecoveryFailures: 0,
    },
  };
}

let circuitState = createCircuitState();
let runtimeModuleOverride = null;
let sourceCheckpointCallback = null;
let sourceBarrierRuntime = null;
let journalProviderOverride = null;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function getRuntimeModule() {
  return runtimeModuleOverride || require("./xEveRuntime");
}

function checkpointSourceJournal(options = {}) {
  if (
    options.force !== true &&
    circuitState.sourceGeneration <= circuitState.sourceDurableGeneration
  ) {
    return { success: true, skipped: true };
  }
  if (typeof options.sourceCheckpoint === "function") {
    sourceCheckpointCallback = options.sourceCheckpoint;
  }
  const targetGeneration = circuitState.sourceGeneration;
  const startedAtMs = Date.now();
  circuitState.metrics.sourceCheckpointAttempts += 1;
  let result;
  try {
    result = sourceCheckpointCallback && sourceCheckpointCallback();
  } catch (error) {
    result = {
      success: false,
      errorMsg: error && (error.code || error.message) || "SOURCE_CHECKPOINT_THROWN",
    };
  }
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  circuitState.lastSourceCheckpointDurationMs = durationMs;
  if (
    !sourceCheckpointCallback ||
    !result ||
    (result && typeof result.then === "function") ||
    (result !== true && result.success !== true)
  ) {
    circuitState.metrics.sourceCheckpointFailures += 1;
    circuitState.requiresReconciliation = true;
    openCircuit("X_EVE_SOURCE_JOURNAL_FLUSH_FAILED", { nowMs: Date.now() });
    return {
      success: false,
      errorMsg: "X_EVE_SOURCE_JOURNAL_FLUSH_FAILED",
      cause: result && result.errorMsg || "SOURCE_CHECKPOINT_REJECTED",
    };
  }
  circuitState.sourceDurableGeneration = targetGeneration;
  circuitState.lastSourceCheckpointAtMs = Date.now();
  circuitState.metrics.sourceCheckpointSuccesses += 1;
  return { success: true, durationMs };
}

function checkpointPendingSourceJournal() {
  return checkpointSourceJournal();
}

function ensureSourceDurabilityBarrier(runtimeModule, checkpointCallback) {
  if (typeof checkpointCallback === "function") {
    sourceCheckpointCallback = checkpointCallback;
  }
  let runtime;
  try {
    runtime = runtimeModule.getDefaultRuntime();
  } catch (error) {
    openCircuit("X_EVE_SOURCE_BARRIER_REGISTRATION_FAILED", { nowMs: Date.now() });
    return { success: false, errorMsg: circuitState.reason, cause: error.message };
  }
  if (runtime !== sourceBarrierRuntime) {
    try {
      if (
        sourceBarrierRuntime &&
        typeof sourceBarrierRuntime.unregisterDurabilityPrerequisite === "function"
      ) {
        const unregistration = sourceBarrierRuntime.unregisterDurabilityPrerequisite(
          SOURCE_DURABILITY_PREREQUISITE,
        );
        if (unregistration && unregistration.success === false) {
          throw new Error(
            unregistration.errorMsg || "X_EVE_SOURCE_BARRIER_UNREGISTER_FAILED",
          );
        }
      }
      if (!runtime || typeof runtime.registerDurabilityPrerequisite !== "function") {
        openCircuit("X_EVE_SOURCE_BARRIER_UNAVAILABLE", { nowMs: Date.now() });
        return { success: false, errorMsg: circuitState.reason };
      }
      const registration = runtime.registerDurabilityPrerequisite(
        SOURCE_DURABILITY_PREREQUISITE,
        checkpointPendingSourceJournal,
      );
      if (!registration || registration.success !== true) {
        throw new Error(
          registration && registration.errorMsg ||
          "X_EVE_SOURCE_BARRIER_REGISTRATION_FAILED",
        );
      }
      sourceBarrierRuntime = runtime;
    } catch (error) {
      openCircuit("X_EVE_SOURCE_BARRIER_REGISTRATION_FAILED", { nowMs: Date.now() });
      return {
        success: false,
        errorMsg: circuitState.reason,
        cause: error && (error.code || error.message) || "UNKNOWN",
      };
    }
  }
  if (typeof sourceCheckpointCallback !== "function") {
    openCircuit("X_EVE_SOURCE_CHECKPOINT_UNAVAILABLE", { nowMs: Date.now() });
    return { success: false, errorMsg: circuitState.reason };
  }
  return { success: true };
}

function openCircuit(reason, options = {}) {
  const nowMs = Math.max(0, Math.trunc(toFiniteNumber(options.nowMs, Date.now())));
  if (circuitState.open !== true) {
    circuitState.metrics.circuitTrips += 1;
    circuitState.openedAtMs = nowMs;
  }
  circuitState.open = true;
  circuitState.reason = String(reason || "X_EVE_EVENT_DURABILITY_UNHEALTHY");
  circuitState.lastFailureAtMs = nowMs;
  circuitState.lastFailureEventID = options.eventID
    ? String(options.eventID)
    : circuitState.lastFailureEventID;
  circuitState.lastFailureSourceEpochMs = Math.max(
    0,
    Math.trunc(toFiniteNumber(
      options.sourceEpochMs,
      circuitState.lastFailureSourceEpochMs,
    )),
  );
}

function reportLivingEconomyDurabilityFailure(reason, options = {}) {
  circuitState.requiresReconciliation = true;
  circuitState.unreconciledBufferedEvents += Math.max(
    0,
    Math.trunc(toFiniteNumber(options.bufferedEvents, 1)),
  );
  if (options.countRejected !== false) {
    circuitState.metrics.rejectedEvents += 1;
    circuitState.metrics.bufferedEventsAtFailure += 1;
  }
  openCircuit(reason || "X_EVE_EVENT_BRIDGE_EXCEPTION", {
    nowMs: options.nowMs,
    eventID: options.eventID,
    sourceEpochMs: options.sourceEpochMs,
  });
  return {
    success: false,
    pauseProduction: true,
    errorMsg: circuitState.reason,
  };
}

function closeCircuit() {
  if (circuitState.requiresReconciliation === true) return false;
  if (circuitState.open === true) {
    circuitState.metrics.circuitRecoveries += 1;
  }
  circuitState.open = false;
  circuitState.reason = null;
  circuitState.openedAtMs = 0;
  circuitState.lastFailureEventID = null;
  circuitState.lastFailureSourceEpochMs = 0;
  return true;
}

function getSchedulerSnapshot(runtimeModule) {
  try {
    const snapshot = runtimeModule.getSnapshot();
    return snapshot && snapshot.scheduler && typeof snapshot.scheduler === "object"
      ? {
        ...snapshot.scheduler,
        runtimeStarted: snapshot.started === true,
      }
      : null;
  } catch (_error) {
    return null;
  }
}

function observeRuntimeDurability(runtimeModule, nowMs = Date.now()) {
  const scheduler = getSchedulerSnapshot(runtimeModule);
  if (!scheduler) {
    circuitState.requiresReconciliation = true;
    openCircuit("X_EVE_EVENT_DURABILITY_STATUS_UNAVAILABLE", { nowMs });
    return { success: false, errorMsg: circuitState.reason };
  }
  if (scheduler.runtimeStarted !== true) {
    circuitState.requiresReconciliation = true;
    openCircuit("X_EVE_RUNTIME_NOT_READY", { nowMs });
    return { success: false, errorMsg: circuitState.reason, scheduler };
  }
  if (scheduler.persistenceHealthy !== true) {
    circuitState.requiresReconciliation = true;
    openCircuit(
      scheduler.persistenceError || "X_EVE_EVENT_PERSISTENCE_UNHEALTHY",
      { nowMs },
    );
    return { success: false, errorMsg: circuitState.reason, scheduler };
  }
  const handoffAtMs = Math.max(
    0,
    Math.trunc(toFiniteNumber(scheduler.lastDurableHandoffAtMs, 0)),
  );
  const handoffSuccesses = Math.max(
    0,
    Math.trunc(toFiniteNumber(
      scheduler.metrics && scheduler.metrics.durabilityHandoffSuccesses,
      0,
    )),
  );
  const observedNewSuccess = (
    handoffSuccesses > circuitState.lastObservedHandoffSuccesses ||
    handoffAtMs > circuitState.lastObservedHandoffAtMs
  );
  if (observedNewSuccess) {
    circuitState.pendingEventsSinceHandoff = 0;
    circuitState.lastObservedHandoffAtMs = handoffAtMs;
    circuitState.lastObservedHandoffSuccesses = handoffSuccesses;
    circuitState.nextHandoffAttemptAtMs = 0;
    if (circuitState.requiresReconciliation !== true) closeCircuit();
  }
  return { success: true, scheduler, observedNewSuccess };
}

function observeHandoffResult(result, nowMs = Date.now(), eventID = null) {
  circuitState.metrics.handoffAttempts += 1;
  if (!result || result.success !== true) {
    circuitState.metrics.handoffFailures += 1;
    if (circuitState.pendingEventsSinceHandoff > 0) {
      circuitState.requiresReconciliation = true;
      circuitState.unreconciledBufferedEvents = Math.max(
        circuitState.unreconciledBufferedEvents,
        circuitState.pendingEventsSinceHandoff,
      );
    }
    openCircuit(
      result && result.errorMsg || "X_EVE_EVENT_BATCH_HANDOFF_FAILED",
      { nowMs, eventID },
    );
    return { success: false, errorMsg: circuitState.reason };
  }
  if (result.blocked === true || result.pendingDirty === true) {
    circuitState.metrics.handoffBlocked += 1;
    circuitState.nextHandoffAttemptAtMs = Math.max(
      circuitState.nextHandoffAttemptAtMs,
      Math.max(0, Math.trunc(toFiniteNumber(nowMs, Date.now()))) + EVENT_HANDOFF_RETRY_MS,
    );
    if (circuitState.pendingEventsSinceHandoff >= MAX_UNCONFIRMED_EVENTS) {
      openCircuit("X_EVE_EVENT_JOURNAL_BACKPRESSURE", { nowMs, eventID });
      return {
        success: false,
        errorMsg: circuitState.reason,
        blocked: true,
      };
    }
    return { success: true, blocked: true };
  }
  circuitState.metrics.handoffSuccesses += 1;
  circuitState.pendingEventsSinceHandoff = 0;
  circuitState.nextHandoffAttemptAtMs = 0;
  const scheduler = getSchedulerSnapshot(getRuntimeModule());
  if (scheduler) {
    circuitState.lastObservedHandoffAtMs = Math.max(
      circuitState.lastObservedHandoffAtMs,
      Math.max(0, Math.trunc(toFiniteNumber(scheduler.lastDurableHandoffAtMs, nowMs))),
    );
    circuitState.lastObservedHandoffSuccesses = Math.max(
      circuitState.lastObservedHandoffSuccesses,
      Math.max(0, Math.trunc(toFiniteNumber(
        scheduler.metrics && scheduler.metrics.durabilityHandoffSuccesses,
        0,
      ))),
    );
  }
  closeCircuit();
  return { success: true, blocked: false };
}

function attemptAutomaticReconciliation(runtimeModule, nowMs, options = {}) {
  if (
    config.xEveEnabled !== true ||
    circuitState.open !== true ||
    circuitState.requiresReconciliation !== true ||
    nowMs < circuitState.nextHandoffAttemptAtMs
  ) {
    return null;
  }
  circuitState.nextHandoffAttemptAtMs = nowMs + 1_000;
  circuitState.metrics.automaticRecoveryAttempts += 1;
  const startedAtMs = Date.now();
  try {
    const barrier = ensureSourceDurabilityBarrier(
      runtimeModule,
      options.sourceCheckpoint,
    );
    if (!barrier || barrier.success !== true) {
      throw new Error(
        barrier && barrier.errorMsg || "X_EVE_SOURCE_BARRIER_REGISTRATION_FAILED",
      );
    }
    const scheduler = getSchedulerSnapshot(runtimeModule);
    if (!scheduler || scheduler.persistenceHealthy !== true) {
      if (typeof runtimeModule.recoverPersistence !== "function") {
        throw new Error("X_EVE_PERSISTENCE_RECOVERY_UNAVAILABLE");
      }
      const recovery = runtimeModule.recoverPersistence();
      if (!recovery || recovery.success !== true) {
        throw new Error(
          recovery && recovery.errorMsg || "X_EVE_PERSISTENCE_RECOVERY_FAILED",
        );
      }
    }
    const result = reconcileRecentLivingEconomyEvents({
      nowMs,
      sourceCheckpoint: options.sourceCheckpoint,
      journalProvider: options.journalProvider,
    });
    if (!result || result.success !== true) {
      throw new Error(result && result.errorMsg || "X_EVE_SOURCE_RECONCILE_FAILED");
    }
    circuitState.metrics.automaticRecoverySuccesses += 1;
    circuitState.lastAutomaticRecoveryAtMs = nowMs;
    return result;
  } catch (error) {
    circuitState.metrics.automaticRecoveryFailures += 1;
    openCircuit(
      error && (error.code || error.message) || "X_EVE_AUTOMATIC_RECOVERY_FAILED",
      { nowMs },
    );
    return {
      success: false,
      errorMsg: circuitState.reason,
    };
  } finally {
    circuitState.lastAutomaticRecoveryDurationMs = Math.max(
      0,
      Date.now() - startedAtMs,
    );
  }
}

function checkLivingEconomyProduction(options = {}) {
  if (config.xEveEnabled !== true && options.force !== true) {
    return { success: true, skipped: true, reason: "X_EVE_DISABLED" };
  }
  circuitState.lastJournalRows = Math.max(
    0,
    Math.trunc(toFiniteNumber(options.journalRows, circuitState.lastJournalRows)),
  );
  const nowMs = Math.max(0, Math.trunc(toFiniteNumber(options.nowMs, Date.now())));
  const runtimeModule = getRuntimeModule();
  const health = observeRuntimeDurability(runtimeModule, nowMs);
  if (!health.success || circuitState.open === true) {
    const recovery = attemptAutomaticReconciliation(runtimeModule, nowMs, {
      sourceCheckpoint: options.sourceCheckpoint,
      journalProvider: options.journalProvider,
    });
    if (recovery && recovery.success === true) {
      return { success: true, recovered: true, data: getStatus({ refresh: false }) };
    }
    return {
      success: false,
      pauseProduction: true,
      errorMsg: circuitState.reason || "X_EVE_EVENT_DURABILITY_CIRCUIT_OPEN",
      data: getStatus({ refresh: false, force: options.force }),
    };
  }
  if (circuitState.pendingEventsSinceHandoff < MAX_UNCONFIRMED_EVENTS) {
    return { success: true, data: getStatus({ refresh: false, force: options.force }) };
  }
  const handoff = runtimeModule.getDefaultRuntime().maintainPersistence(nowMs, {
    force: true,
  });
  const observed = observeHandoffResult(handoff, nowMs);
  return observed.success
    ? { success: true, data: getStatus({ refresh: false, force: options.force }) }
    : {
      success: false,
      pauseProduction: true,
      errorMsg: observed.errorMsg,
      data: getStatus({ refresh: false, force: options.force }),
    };
}

function publishLivingUniverseEvent(event, options = {}) {
  if (config.xEveEnabled !== true && options.force !== true) {
    return { success: true, skipped: true, reason: "X_EVE_DISABLED" };
  }
  if (!event || !event.eventID) {
    return { success: false, errorMsg: "X_EVE_SOURCE_EVENT_ID_REQUIRED" };
  }
  const nowMs = Math.max(0, Math.trunc(toFiniteNumber(options.nowMs, Date.now())));
  const runtimeModule = getRuntimeModule();
  if (options.reconciling !== true) {
    const admission = checkLivingEconomyProduction({
      force: options.force,
      nowMs,
      journalRows: options.journalRows,
      sourceCheckpoint: options.sourceCheckpoint,
      journalProvider: options.journalProvider,
    });
    if (!admission.success) {
      circuitState.metrics.rejectedEvents += 1;
      circuitState.metrics.bufferedEventsAtFailure += 1;
      circuitState.lastFailureEventID = String(event.eventID);
      circuitState.lastFailureSourceEpochMs = Math.max(
        0,
        Math.trunc(toFiniteNumber(options.sourceEpochMs, 0)),
      );
      circuitState.requiresReconciliation = true;
      circuitState.unreconciledBufferedEvents += 1;
      return admission;
    }
  }
  let stagedSourceGeneration = 0;
  if (options.sourceAlreadyDurable !== true && options.reconciling !== true) {
    const barrier = ensureSourceDurabilityBarrier(
      runtimeModule,
      options.sourceCheckpoint,
    );
    if (!barrier.success) {
      circuitState.metrics.rejectedEvents += 1;
      circuitState.metrics.bufferedEventsAtFailure += 1;
      circuitState.lastFailureEventID = String(event.eventID);
      circuitState.lastFailureSourceEpochMs = Math.max(
        0,
        Math.trunc(toFiniteNumber(options.sourceEpochMs, 0)),
      );
      circuitState.requiresReconciliation = true;
      circuitState.unreconciledBufferedEvents += 1;
      return {
        success: false,
        pauseProduction: true,
        errorMsg: barrier.errorMsg,
      };
    }
    circuitState.sourceGeneration += 1;
    stagedSourceGeneration = circuitState.sourceGeneration;
  }
  const sourceEpochMs = Math.max(
    0,
    Math.trunc(Number(options.sourceEpochMs) || 0),
  );
  const sourceEventID = sourceEpochMs > 0
    ? `epoch:${sourceEpochMs}:${event.eventID}`
    : event.eventID;
  let result;
  try {
    result = runtimeModule.ingestEvent({
      source: "living-economy",
      sourceEventID,
      eventType: event.kind || "event",
      version: 1,
      occurredAtMs: event.occurredAtMs,
      payload: {
        ...event,
        eventID: undefined,
        kind: undefined,
        occurredAtMs: undefined,
        livingEconomyEventID: event.eventID,
        livingEconomyEpochMs: sourceEpochMs,
      },
    }, {
      nowMs,
      durable: options.durable === true,
    });
  } catch (error) {
    result = {
      success: false,
      errorMsg: error && (error.code || error.message) || "X_EVE_EVENT_INGEST_THROWN",
    };
  }
  if (!result || result.success !== true) {
    circuitState.metrics.rejectedEvents += 1;
    circuitState.metrics.bufferedEventsAtFailure += 1;
    circuitState.requiresReconciliation = true;
    circuitState.unreconciledBufferedEvents += 1;
    openCircuit(
      result && result.errorMsg || "X_EVE_EVENT_INGEST_FAILED",
      {
        nowMs,
        eventID: event.eventID,
        sourceEpochMs,
      },
    );
    return {
      ...(result || {}),
      success: false,
      pauseProduction: options.reconciling !== true,
      errorMsg: result && result.errorMsg || "X_EVE_EVENT_INGEST_FAILED",
    };
  }
  if (result.replayed === true) {
    circuitState.metrics.replayedEvents += 1;
    if (
      stagedSourceGeneration > circuitState.sourceDurableGeneration &&
      circuitState.sourceGeneration === stagedSourceGeneration
    ) {
      // No new sink state was created, so this duplicate needs no ordering
      // barrier of its own. A normal Living Economy save can persist it.
      circuitState.sourceGeneration -= 1;
    }
  } else {
    circuitState.metrics.acceptedEvents += 1;
    circuitState.pendingEventsSinceHandoff += 1;
  }
  if (options.durable === true) {
    const observed = observeHandoffResult({ success: true }, nowMs, event.eventID);
    return observed.success ? result : {
      success: false,
      pauseProduction: true,
      errorMsg: observed.errorMsg,
      data: result.data,
    };
  }
  if (
    options.batchHandoff !== false &&
    circuitState.pendingEventsSinceHandoff >= EVENT_HANDOFF_BATCH_SIZE &&
    (
      nowMs >= circuitState.nextHandoffAttemptAtMs ||
      circuitState.pendingEventsSinceHandoff >= MAX_UNCONFIRMED_EVENTS
    )
  ) {
    const handoff = runtimeModule.getDefaultRuntime().maintainPersistence(nowMs, {
      force: true,
    });
    const observed = observeHandoffResult(handoff, nowMs, event.eventID);
    if (!observed.success) {
      return {
        success: false,
        uncertain: true,
        pauseProduction: true,
        errorMsg: observed.errorMsg,
        data: result.data,
      };
    }
  }
  return result;
}

function reconcileRecentLivingEconomyEvents(options = {}) {
  if (config.xEveEnabled !== true && options.force !== true) {
    return { success: true, skipped: true, reason: "X_EVE_DISABLED" };
  }
  circuitState.metrics.reconciliationRuns += 1;
  const livingEconomyRuntime = options.journalProvider || journalProviderOverride || require(path.join(
    __dirname,
    "../../space/npc/ambientTraffic/livingEconomyRuntime",
  ));
  if (options.sourceAlreadyDurable !== true) {
    const sourceCheckpoint = options.sourceCheckpoint ||
      livingEconomyRuntime.checkpointXEveSourceJournal;
    const barrier = ensureSourceDurabilityBarrier(getRuntimeModule(), sourceCheckpoint);
    if (!barrier || barrier.success !== true) {
      circuitState.metrics.reconciliationFailures += 1;
      circuitState.requiresReconciliation = true;
      return {
        success: false,
        errorMsg: barrier && barrier.errorMsg ||
          "X_EVE_SOURCE_BARRIER_REGISTRATION_FAILED",
      };
    }
    const checkpoint = checkpointSourceJournal({
      force: true,
      sourceCheckpoint,
    });
    if (!checkpoint || checkpoint.success !== true) {
      circuitState.metrics.reconciliationFailures += 1;
      circuitState.requiresReconciliation = true;
      return {
        success: false,
        errorMsg: checkpoint && checkpoint.errorMsg ||
          "X_EVE_SOURCE_JOURNAL_FLUSH_FAILED",
      };
    }
  }
  let journal;
  try {
    journal = livingEconomyRuntime.getEventJournal(options.limit || EVENT_JOURNAL_MAX_ROWS);
  } catch (error) {
    circuitState.metrics.reconciliationFailures += 1;
    openCircuit(
      error && (error.code || error.message) || "X_EVE_SOURCE_JOURNAL_READ_FAILED",
      { nowMs: options.nowMs },
    );
    return {
      success: false,
      errorMsg: circuitState.reason,
      data: { accepted: 0, replayed: 0, failures: [] },
    };
  }
  if (!journal || !Array.isArray(journal.events)) {
    circuitState.metrics.reconciliationFailures += 1;
    openCircuit("X_EVE_SOURCE_JOURNAL_INVALID", { nowMs: options.nowMs });
    return {
      success: false,
      errorMsg: circuitState.reason,
      data: { accepted: 0, replayed: 0, failures: [] },
    };
  }
  circuitState.lastJournalRows = journal.events.length;
  const expectedFailureEventID = circuitState.requiresReconciliation === true
    ? String(circuitState.lastFailureEventID || "")
    : "";
  const expectedSourceEpochMs = Math.max(
    0,
    Math.trunc(toFiniteNumber(circuitState.lastFailureSourceEpochMs, 0)),
  );
  const journalSourceEpochMs = Math.max(
    0,
    Math.trunc(toFiniteNumber(journal.sourceEpochMs, 0)),
  );
  const hasExpectedFailureEvent = (
    !expectedFailureEventID ||
    journal.events.some((event) => (
      String(event && event.eventID || "") === expectedFailureEventID
    ))
  );
  const hasExpectedSourceEpoch = (
    expectedSourceEpochMs <= 0 ||
    journalSourceEpochMs === expectedSourceEpochMs
  );
  if (!hasExpectedFailureEvent || !hasExpectedSourceEpoch) {
    circuitState.metrics.reconciliationFailures += 1;
    openCircuit("X_EVE_SOURCE_RECONCILE_INCOMPLETE", { nowMs: options.nowMs });
    return {
      success: false,
      errorMsg: circuitState.reason,
      data: {
        sourceEpochMs: journalSourceEpochMs,
        sourceRows: journal.events.length,
        accepted: 0,
        replayed: 0,
        failures: [{
          eventID: expectedFailureEventID || null,
          errorMsg: !hasExpectedSourceEpoch
            ? "X_EVE_SOURCE_EPOCH_MISMATCH"
            : "X_EVE_FAILED_SOURCE_EVENT_NOT_DURABLE",
        }],
      },
    };
  }
  let accepted = 0;
  let replayed = 0;
  const failures = [];
  for (const event of journal.events) {
    const result = publishLivingUniverseEvent(event, {
      force: true,
      reconciling: true,
      nowMs: options.nowMs,
      sourceEpochMs: journal.sourceEpochMs,
      durable: false,
      batchHandoff: false,
      sourceAlreadyDurable: true,
    });
    if (!result || result.success !== true) {
      failures.push({
        eventID: event && event.eventID,
        errorMsg: result && result.errorMsg || "UNKNOWN",
      });
    } else if (result.replayed === true) {
      replayed += 1;
    } else {
      accepted += 1;
    }
  }
  const runtimeModule = getRuntimeModule();
  let flushResult;
  try {
    flushResult = runtimeModule.flushDurably();
  } catch (error) {
    flushResult = {
      success: false,
      errorMsg: error && (error.code || error.message) || "X_EVE_RECONCILE_FLUSH_THROWN",
    };
  }
  if (!flushResult || flushResult.success !== true) {
    circuitState.metrics.reconciliationFailures += 1;
    openCircuit(
      flushResult && flushResult.errorMsg || "X_EVE_RECONCILE_FLUSH_FAILED",
      { nowMs: options.nowMs },
    );
    return {
      success: false,
      uncertain: true,
      errorMsg: circuitState.reason,
      data: { accepted, replayed, failures },
    };
  }
  if (failures.length > 0) {
    circuitState.metrics.reconciliationFailures += 1;
    openCircuit("X_EVE_SOURCE_RECONCILE_INCOMPLETE", { nowMs: options.nowMs });
    return {
      success: false,
      errorMsg: circuitState.reason,
      data: {
        sourceEpochMs: journal.sourceEpochMs,
        sourceRows: journal.events.length,
        accepted,
        replayed,
        failures,
      },
    };
  }
  circuitState.pendingEventsSinceHandoff = 0;
  circuitState.nextHandoffAttemptAtMs = 0;
  circuitState.requiresReconciliation = false;
  circuitState.unreconciledBufferedEvents = 0;
  closeCircuit();
  return {
    success: true,
    errorMsg: null,
    data: {
      sourceEpochMs: journal.sourceEpochMs,
      sourceRows: journal.events.length,
      accepted,
      replayed,
      failures: [],
    },
  };
}

function drainBeforeSourceReset(options = {}) {
  if (config.xEveEnabled !== true && options.force !== true) {
    return { success: true, skipped: true, reason: "X_EVE_DISABLED" };
  }
  const nowMs = Math.max(0, Math.trunc(toFiniteNumber(options.nowMs, Date.now())));
  const runtimeModule = getRuntimeModule();
  const admission = checkLivingEconomyProduction({
    force: options.force,
    nowMs,
    journalRows: options.journalRows,
    sourceCheckpoint: options.sourceCheckpoint,
    journalProvider: options.journalProvider,
  });
  if (!admission || admission.success !== true) return admission;

  const barrier = ensureSourceDurabilityBarrier(
    runtimeModule,
    options.sourceCheckpoint,
  );
  if (!barrier || barrier.success !== true) {
    return reportLivingEconomyDurabilityFailure(
      barrier && barrier.errorMsg || "X_EVE_SOURCE_BARRIER_REGISTRATION_FAILED",
      { nowMs, bufferedEvents: 0, countRejected: false },
    );
  }
  const checkpoint = checkpointSourceJournal({
    force: true,
    sourceCheckpoint: options.sourceCheckpoint,
  });
  if (!checkpoint || checkpoint.success !== true) {
    return reportLivingEconomyDurabilityFailure(
      checkpoint && checkpoint.errorMsg || "X_EVE_SOURCE_JOURNAL_FLUSH_FAILED",
      { nowMs, bufferedEvents: 0, countRejected: false },
    );
  }

  let flushResult;
  try {
    flushResult = runtimeModule.flushDurably();
  } catch (error) {
    flushResult = {
      success: false,
      errorMsg: error && (error.code || error.message) || "X_EVE_SOURCE_RESET_DRAIN_THROWN",
    };
  }
  const observed = observeHandoffResult(flushResult, nowMs);
  if (!observed || observed.success !== true) {
    return {
      success: false,
      pauseProduction: true,
      errorMsg: observed && observed.errorMsg || "X_EVE_SOURCE_RESET_DRAIN_FAILED",
    };
  }
  const scheduler = getSchedulerSnapshot(runtimeModule);
  const pendingSourceGenerations = Math.max(
    0,
    circuitState.sourceGeneration - circuitState.sourceDurableGeneration,
  );
  if (
    !scheduler ||
    scheduler.persistenceHealthy !== true ||
    pendingSourceGenerations !== 0 ||
    circuitState.pendingEventsSinceHandoff !== 0
  ) {
    return reportLivingEconomyDurabilityFailure(
      "X_EVE_SOURCE_RESET_DRAIN_INCOMPLETE",
      { nowMs, bufferedEvents: 0, countRejected: false },
    );
  }
  return {
    success: true,
    data: {
      sourceGeneration: circuitState.sourceGeneration,
      sourceDurableGeneration: circuitState.sourceDurableGeneration,
      pendingSourceGenerations,
      pendingEventsSinceHandoff: circuitState.pendingEventsSinceHandoff,
    },
  };
}

function getStatus(options = {}) {
  const enabled = config.xEveEnabled === true || options.force === true;
  circuitState.lastJournalRows = Math.max(
    0,
    Math.trunc(toFiniteNumber(options.journalRows, circuitState.lastJournalRows)),
  );
  if (enabled && options.refresh !== false) {
    observeRuntimeDurability(getRuntimeModule(), options.nowMs);
  }
  return {
    enabled,
    state: circuitState.open ? "open" : "closed",
    productionPaused: enabled && circuitState.open === true,
    reason: circuitState.reason,
    openedAtMs: circuitState.openedAtMs,
    lastFailureAtMs: circuitState.lastFailureAtMs,
    lastFailureEventID: circuitState.lastFailureEventID,
    lastFailureSourceEpochMs: circuitState.lastFailureSourceEpochMs,
    requiresReconciliation: circuitState.requiresReconciliation,
    unreconciledBufferedEvents: circuitState.unreconciledBufferedEvents,
    sourceGeneration: circuitState.sourceGeneration,
    sourceDurableGeneration: circuitState.sourceDurableGeneration,
    pendingSourceGenerations: Math.max(
      0,
      circuitState.sourceGeneration - circuitState.sourceDurableGeneration,
    ),
    lastSourceCheckpointAtMs: circuitState.lastSourceCheckpointAtMs,
    lastSourceCheckpointDurationMs: circuitState.lastSourceCheckpointDurationMs,
    lastAutomaticRecoveryAtMs: circuitState.lastAutomaticRecoveryAtMs,
    lastAutomaticRecoveryDurationMs: circuitState.lastAutomaticRecoveryDurationMs,
    pendingEventsSinceHandoff: circuitState.pendingEventsSinceHandoff,
    maximumUnconfirmedEvents: MAX_UNCONFIRMED_EVENTS,
    journalMaximumRows: EVENT_JOURNAL_MAX_ROWS,
    journalReserveRows: EVENT_JOURNAL_RESERVE_ROWS,
    journalRows: circuitState.lastJournalRows,
    lastObservedHandoffAtMs: circuitState.lastObservedHandoffAtMs,
    nextHandoffAttemptAtMs: circuitState.nextHandoffAttemptAtMs,
    metrics: { ...circuitState.metrics },
  };
}

module.exports = {
  EVENT_HANDOFF_BATCH_SIZE,
  EVENT_HANDOFF_RETRY_MS,
  EVENT_JOURNAL_MAX_ROWS,
  EVENT_JOURNAL_RESERVE_ROWS,
  MAX_UNCONFIRMED_EVENTS,
  checkLivingEconomyProduction,
  drainBeforeSourceReset,
  getStatus,
  publishLivingUniverseEvent,
  reportLivingEconomyDurabilityFailure,
  reconcileRecentLivingEconomyEvents,
  _testing: {
    resetCircuit() {
      if (
        sourceBarrierRuntime &&
        typeof sourceBarrierRuntime.unregisterDurabilityPrerequisite === "function"
      ) {
        sourceBarrierRuntime.unregisterDurabilityPrerequisite(
          SOURCE_DURABILITY_PREREQUISITE,
        );
      }
      circuitState = createCircuitState();
      sourceCheckpointCallback = null;
      sourceBarrierRuntime = null;
      journalProviderOverride = null;
    },
    setRuntimeModule(runtimeModule) {
      runtimeModuleOverride = runtimeModule || null;
    },
    setJournalProvider(journalProvider) {
      journalProviderOverride = journalProvider || null;
    },
  },
};
