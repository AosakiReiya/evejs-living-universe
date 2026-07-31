"use strict";

const { performance } = require("perf_hooks");
const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { DeadlineQueue } = require("./deadlineQueue");
const { getDefaultCatalog } = require("./liveEventCatalog");
const { getDefaultStateStore } = require("./liveEventState");

const PHASE = Object.freeze({
  SCHEDULED: "scheduled",
  DORMANT: "dormant",
  MATERIALIZING: "materializing",
  ACTIVE: "active",
  RESOLVING: "resolving",
  AFTERMATH: "aftermath",
  CLEANUP: "cleanup",
  RECOVERY_PENDING: "recovery_pending",
  COMPLETED: "completed",
});
const TERMINAL_PHASES = new Set([PHASE.COMPLETED]);
const ALLOWED_TRANSITIONS = Object.freeze({
  [PHASE.SCHEDULED]: new Set([PHASE.DORMANT, PHASE.RECOVERY_PENDING, PHASE.COMPLETED]),
  [PHASE.DORMANT]: new Set([PHASE.MATERIALIZING, PHASE.ACTIVE, PHASE.RESOLVING, PHASE.RECOVERY_PENDING, PHASE.COMPLETED]),
  [PHASE.MATERIALIZING]: new Set([PHASE.ACTIVE, PHASE.DORMANT, PHASE.RECOVERY_PENDING]),
  [PHASE.ACTIVE]: new Set([PHASE.RESOLVING, PHASE.AFTERMATH, PHASE.DORMANT, PHASE.RECOVERY_PENDING]),
  [PHASE.RESOLVING]: new Set([PHASE.AFTERMATH, PHASE.CLEANUP, PHASE.RECOVERY_PENDING]),
  [PHASE.AFTERMATH]: new Set([PHASE.CLEANUP, PHASE.MATERIALIZING, PHASE.RECOVERY_PENDING]),
  [PHASE.CLEANUP]: new Set([PHASE.COMPLETED, PHASE.RECOVERY_PENDING]),
  [PHASE.RECOVERY_PENDING]: new Set([PHASE.DORMANT, PHASE.MATERIALIZING, PHASE.RESOLVING, PHASE.CLEANUP, PHASE.COMPLETED]),
  [PHASE.COMPLETED]: new Set(),
});

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toNonNegativeInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function hashSeed(value) {
  let hash = 2_166_136_261;
  for (const character of String(value || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function canTransition(fromPhase, toPhase) {
  if (fromPhase === toPhase) {
    return true;
  }
  const allowed = ALLOWED_TRANSITIONS[fromPhase];
  return Boolean(allowed && allowed.has(toPhase));
}

function normalizeRuntimeOptions(raw = {}) {
  return {
    enabled: raw.enabled === true,
    schedulerIntervalMs: Math.max(250, toPositiveInt(raw.schedulerIntervalMs, 5_000)),
    schedulerBudgetMs: Math.max(0.1, toFiniteNumber(raw.schedulerBudgetMs, 2)),
    maxJobsPerPass: Math.max(1, toPositiveInt(raw.maxJobsPerPass, 8)),
    maxActiveGlobal: Math.max(1, toPositiveInt(raw.maxActiveGlobal, 2)),
    maxActivePerSystem: Math.max(1, toPositiveInt(raw.maxActivePerSystem, 1)),
    recoveryBaseDelayMs: Math.max(1_000, toPositiveInt(raw.recoveryBaseDelayMs, 5_000)),
    recoveryMaxDelayMs: Math.max(5_000, toPositiveInt(raw.recoveryMaxDelayMs, 300_000)),
    enableProducers: raw.enableProducers !== false,
    producerMaintenanceIntervalMs: Math.max(
      5_000,
      toPositiveInt(raw.producerMaintenanceIntervalMs, 60_000),
    ),
    completedRetentionCount: toNonNegativeInt(raw.completedRetentionCount, 100),
    archiveBatchSize: Math.max(1, toPositiveInt(raw.archiveBatchSize, 4)),
  };
}

function buildDefaultRuntimeOptions() {
  return normalizeRuntimeOptions({
    enabled: config.liveEventsEnabled === true,
    schedulerIntervalMs: config.liveEventsSchedulerIntervalMs,
    schedulerBudgetMs: config.liveEventsSchedulerBudgetMs,
    maxJobsPerPass: config.liveEventsMaxJobsPerPass,
    maxActiveGlobal: config.liveEventsMaxActiveGlobal,
    maxActivePerSystem: config.liveEventsMaxActivePerSystem,
  });
}

class LiveEventRuntime {
  constructor(options = {}) {
    this.stateStore = options.stateStore || getDefaultStateStore();
    this.catalog = options.catalog || getDefaultCatalog();
    this.options = normalizeRuntimeOptions(options.options || buildDefaultRuntimeOptions());
    this.clock = typeof options.clock === "function" ? options.clock : () => Date.now();
    this.monotonicClock = typeof options.monotonicClock === "function"
      ? options.monotonicClock
      : () => performance.now();
    this.queue = new DeadlineQueue();
    this.handlers = new Map();
    this.timer = null;
    this.started = false;
    this.spaceRuntime = null;
    this.nextProducerCheckAtMs = 0;
    this.producerCursorByDefinition = new Map();
    this.metrics = {
      schedulerPasses: 0,
      processedJobs: 0,
      deferredJobs: 0,
      failedJobs: 0,
      createdEvents: 0,
      completedEvents: 0,
      producerPasses: 0,
      producerEventsCreated: 0,
      producerDeferrals: 0,
      archivedEvents: 0,
      lastPassAtMs: 0,
      lastPassDurationMs: 0,
      maxPassDurationMs: 0,
    };
  }

  registerHandler(eventType, handler) {
    const normalizedType = normalizeText(eventType).toLowerCase();
    if (!normalizedType || !handler || typeof handler.advance !== "function") {
      throw new Error("registerHandler requires an event type and advance(context) function");
    }
    this.handlers.set(normalizedType, handler);
    return handler;
  }

  start(options = {}) {
    if (this.started) {
      return { success: true, data: this.getSnapshot() };
    }
    if (options.spaceRuntime) {
      this.spaceRuntime = options.spaceRuntime;
    }
    if (!this.options.enabled && options.force !== true) {
      return { success: true, data: { enabled: false, started: false } };
    }
    const initializeResult = this.stateStore.ensureInitialized(this.clock());
    if (!initializeResult || initializeResult.success !== true) {
      return initializeResult || { success: false, errorMsg: "LIVE_EVENT_STATE_INIT_FAILED" };
    }
    this.rebuildQueue();
    this.timer = setInterval(() => {
      try {
        this.runDueWork(this.clock());
      } catch (error) {
        log.warn(`[LiveEvents] Scheduler pass failed: ${error.message}`);
      }
    }, this.options.schedulerIntervalMs);
    if (this.timer && typeof this.timer.unref === "function") {
      this.timer.unref();
    }
    this.started = true;
    return { success: true, data: this.getSnapshot() };
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = null;
    this.started = false;
    return { success: true };
  }

  rebuildQueue() {
    this.queue.clear();
    for (const event of this.stateStore.listEvents()) {
      if (!event || TERMINAL_PHASES.has(event.phase)) {
        continue;
      }
      this._scheduleRecord(event);
    }
    return this.queue.size;
  }

  scheduleEvent(definitionID, rawOptions = {}) {
    const initializeResult = this.stateStore.ensureInitialized(
      Math.max(0, Math.trunc(toFiniteNumber(rawOptions.nowMs, this.clock()))),
    );
    if (!initializeResult || initializeResult.success !== true) {
      return initializeResult || { success: false, errorMsg: "LIVE_EVENT_STATE_INIT_FAILED" };
    }
    const definition = this.catalog.getDefinition(definitionID);
    if (!definition) {
      return { success: false, errorMsg: "LIVE_EVENT_DEFINITION_NOT_FOUND" };
    }
    if (!definition.enabled && rawOptions.force !== true) {
      return { success: false, errorMsg: "LIVE_EVENT_DEFINITION_DISABLED" };
    }
    const systemID = toPositiveInt(rawOptions.systemID, 0);
    const activeEvents = this.stateStore.listEvents().filter(
      (event) => event && !TERMINAL_PHASES.has(event.phase),
    );
    if (activeEvents.length >= this.options.maxActiveGlobal && rawOptions.ignoreCaps !== true) {
      return { success: false, errorMsg: "LIVE_EVENT_GLOBAL_CAP_REACHED" };
    }
    if (
      systemID > 0 &&
      activeEvents.filter((event) => toPositiveInt(event.systemID, 0) === systemID).length >=
        this.options.maxActivePerSystem &&
      rawOptions.ignoreCaps !== true
    ) {
      return { success: false, errorMsg: "LIVE_EVENT_SYSTEM_CAP_REACHED" };
    }

    const nowMs = Math.max(0, Math.trunc(toFiniteNumber(rawOptions.nowMs, this.clock())));
    const allocation = this.stateStore.allocateEventID(nowMs);
    if (!allocation || allocation.success !== true) {
      return allocation || { success: false, errorMsg: "LIVE_EVENT_ID_ALLOCATION_FAILED" };
    }
    const eventID = allocation.data.eventID;
    const nextTransitionAtMs = Math.max(
      nowMs,
      Math.trunc(toFiniteNumber(rawOptions.nextTransitionAtMs, nowMs)),
    );
    const event = {
      schemaVersion: 1,
      eventID,
      eventType: definition.eventType,
      definitionID: definition.definitionID,
      definitionRevision: definition.revision,
      seed: toPositiveInt(rawOptions.seed, hashSeed(`${eventID}:${definition.definitionID}`)),
      systemID,
      anchor: cloneValue(rawOptions.anchor || null),
      securityBand: normalizeText(rawOptions.securityBand, "unknown"),
      discoveryMode: normalizeText(
        rawOptions.discoveryMode,
        normalizeText(definition.discovery && definition.discovery.mode, "none"),
      ),
      phase: PHASE.SCHEDULED,
      eventPhase: normalizeText(rawOptions.eventPhase, "scheduled"),
      revision: 1,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      nextTransitionAtMs,
      lastTransitionAtMs: 0,
      retryCount: 0,
      lastError: null,
      data: cloneValue(rawOptions.data || {}),
      metrics: {},
    };
    const saveResult = this.stateStore.saveEvent(event);
    if (!saveResult || saveResult.success !== true) {
      return saveResult || { success: false, errorMsg: "LIVE_EVENT_SAVE_FAILED" };
    }
    this._scheduleRecord(event);
    this.metrics.createdEvents += 1;
    return { success: true, data: cloneValue(event) };
  }

  forceDue(eventID, nowMs = this.clock()) {
    const event = this.stateStore.getEvent(eventID);
    if (!event || TERMINAL_PHASES.has(event.phase)) {
      return { success: false, errorMsg: "LIVE_EVENT_NOT_ACTIVE" };
    }
    const nextEvent = {
      ...event,
      revision: toPositiveInt(event.revision, 0) + 1,
      updatedAtMs: Math.max(0, Math.trunc(toFiniteNumber(nowMs, this.clock()))),
      nextTransitionAtMs: Math.max(0, Math.trunc(toFiniteNumber(nowMs, this.clock()))),
    };
    const saveResult = this.stateStore.saveEvent(nextEvent);
    if (!saveResult || saveResult.success !== true) {
      return saveResult;
    }
    this._scheduleRecord(nextEvent);
    return { success: true, data: cloneValue(nextEvent) };
  }

  advanceEventNow(eventID, nowMs = this.clock()) {
    const event = this.stateStore.getEvent(eventID);
    if (!event || TERMINAL_PHASES.has(event.phase)) {
      return { success: false, errorMsg: "LIVE_EVENT_NOT_ACTIVE" };
    }
    const normalizedNowMs = Math.max(0, Math.trunc(toFiniteNumber(nowMs, this.clock())));
    this.queue.remove(event.eventID);
    this._advanceEvent(event, normalizedNowMs);
    this.metrics.operatorAdvances = toPositiveInt(this.metrics.operatorAdvances, 0) + 1;
    const nextEvent = this.stateStore.getEvent(event.eventID);
    return nextEvent
      ? { success: true, data: cloneValue(nextEvent) }
      : { success: false, errorMsg: "LIVE_EVENT_NOT_FOUND_AFTER_ADVANCE" };
  }

  requestCleanup(eventID, rawOptions = {}) {
    const event = this.stateStore.getEvent(eventID);
    if (!event || TERMINAL_PHASES.has(event.phase)) {
      return { success: false, errorMsg: "LIVE_EVENT_NOT_ACTIVE" };
    }
    const nowMs = Math.max(0, Math.trunc(toFiniteNumber(rawOptions.nowMs, this.clock())));
    const nextEvent = {
      ...event,
      phase: PHASE.CLEANUP,
      eventPhase: normalizeText(rawOptions.eventPhase, "operator_cleanup"),
      revision: toPositiveInt(event.revision, 0) + 1,
      updatedAtMs: nowMs,
      nextTransitionAtMs: nowMs,
      lastError: null,
      data: {
        ...(event.data && typeof event.data === "object" ? cloneValue(event.data) : {}),
        operatorCleanup: {
          requestedAtMs: nowMs,
          reason: normalizeText(rawOptions.reason, "operator-requested").slice(0, 200),
        },
      },
    };
    const saveResult = this.stateStore.saveEvent(nextEvent);
    if (!saveResult || saveResult.success !== true) {
      return saveResult || { success: false, errorMsg: "LIVE_EVENT_SAVE_FAILED" };
    }
    this._scheduleRecord(nextEvent);
    this.metrics.operatorCleanupRequests =
      toPositiveInt(this.metrics.operatorCleanupRequests, 0) + 1;
    return { success: true, data: cloneValue(nextEvent) };
  }

  listDefinitions(options = {}) {
    return this.catalog.listDefinitions(options);
  }

  archiveCompletedEvents(nowMs = this.clock()) {
    const completed = this.stateStore.listEvents()
      .filter((event) => event && TERMINAL_PHASES.has(event.phase))
      .sort((left, right) => (
        toFiniteNumber(right.updatedAtMs, right.createdAtMs) -
          toFiniteNumber(left.updatedAtMs, left.createdAtMs) ||
        String(right.eventID).localeCompare(String(left.eventID))
      ));
    const excess = completed
      .slice(this.options.completedRetentionCount)
      .slice(0, this.options.archiveBatchSize);
    let archivedCount = 0;
    for (const event of excess) {
      const result = typeof this.stateStore.archiveEvent === "function"
        ? this.stateStore.archiveEvent(event, nowMs)
        : this.stateStore.removeEvent(event.eventID);
      if (result && result.success === true) {
        archivedCount += 1;
      }
    }
    this.metrics.archivedEvents += archivedCount;
    return archivedCount;
  }

  maintainProducerTargets(nowMs = this.clock()) {
    const normalizedNowMs = Math.max(0, Math.trunc(toFiniteNumber(nowMs, this.clock())));
    if (!this.options.enableProducers || normalizedNowMs < this.nextProducerCheckAtMs) {
      return { checked: false, createdCount: 0, archivedCount: 0 };
    }

    const definitions = this.catalog.listDefinitions()
      .filter((definition) => (
        definition && definition.producer && definition.producer.enabled === true
      ));
    const maintenanceIntervalMs = definitions.reduce((minimum, definition) => Math.min(
      minimum,
      Math.max(
        5_000,
        toPositiveInt(
          definition.producer && definition.producer.checkIntervalSeconds,
          this.options.producerMaintenanceIntervalMs / 1_000,
        ) * 1_000,
      ),
    ), this.options.producerMaintenanceIntervalMs);
    this.nextProducerCheckAtMs = normalizedNowMs + maintenanceIntervalMs;
    this.metrics.producerPasses += 1;
    const archivedCount = this.archiveCompletedEvents(normalizedNowMs);

    let activeEvents = this.stateStore.listEvents()
      .filter((event) => event && !TERMINAL_PHASES.has(event.phase));
    let createdCount = 0;
    for (const definition of definitions) {
      const producer = definition.producer || {};
      const targetCount = Math.max(1, toPositiveInt(producer.targetActiveCount, 1));
      let definitionActive = activeEvents.filter(
        (event) => event.definitionID === definition.definitionID,
      );
      const targetSystemIDs = [...new Set(
        (Array.isArray(producer.targetSystemIDs) ? producer.targetSystemIDs : [])
          .map((systemID) => toPositiveInt(systemID, 0))
          .filter(Boolean),
      )];
      if (targetSystemIDs.length <= 0) {
        this.metrics.producerDeferrals += Math.max(0, targetCount - definitionActive.length);
        continue;
      }

      let cursor = toNonNegativeInt(
        this.producerCursorByDefinition.get(definition.definitionID),
        0,
      ) % targetSystemIDs.length;
      while (definitionActive.length < targetCount) {
        let created = null;
        for (let offset = 0; offset < targetSystemIDs.length; offset += 1) {
          const systemIndex = (cursor + offset) % targetSystemIDs.length;
          const systemID = targetSystemIDs[systemIndex];
          if (definitionActive.some((event) => toPositiveInt(event.systemID, 0) === systemID)) {
            continue;
          }
          const result = this.scheduleEvent(definition.definitionID, {
            systemID,
            nowMs: normalizedNowMs,
            securityBand: Array.isArray(definition.securityBands)
              ? definition.securityBands[0]
              : "unknown",
            data: {
              producer: {
                createdAtMs: normalizedNowMs,
                definitionRevision: definition.revision,
              },
            },
          });
          cursor = (systemIndex + 1) % targetSystemIDs.length;
          if (result && result.success === true) {
            created = result.data;
            break;
          }
          if (
            result &&
            (result.errorMsg === "LIVE_EVENT_GLOBAL_CAP_REACHED" ||
              result.errorMsg === "LIVE_EVENT_SYSTEM_CAP_REACHED")
          ) {
            continue;
          }
        }
        if (!created) {
          this.metrics.producerDeferrals += 1;
          break;
        }
        createdCount += 1;
        definitionActive.push(created);
        activeEvents.push(created);
      }
      this.producerCursorByDefinition.set(definition.definitionID, cursor);
    }
    this.metrics.producerEventsCreated += createdCount;
    return { checked: true, createdCount, archivedCount };
  }

  runDueWork(nowMs = this.clock(), overrides = {}) {
    const passStartedAt = this.monotonicClock();
    const budgetMs = Math.max(
      0.1,
      toFiniteNumber(overrides.budgetMs, this.options.schedulerBudgetMs),
    );
    const maxJobs = Math.max(
      1,
      toPositiveInt(overrides.maxJobs, this.options.maxJobsPerPass),
    );
    const normalizedNowMs = Math.max(0, Math.trunc(toFiniteNumber(nowMs, this.clock())));
    const producerResult = this.maintainProducerTargets(normalizedNowMs);
    let processedJobs = 0;

    while (processedJobs < maxJobs) {
      const elapsedMs = Math.max(0, this.monotonicClock() - passStartedAt);
      if (elapsedMs >= budgetMs) {
        break;
      }
      const dueEntry = this.queue.popDue(normalizedNowMs);
      if (!dueEntry) {
        break;
      }
      const event = this.stateStore.getEvent(dueEntry.key);
      if (!event || TERMINAL_PHASES.has(event.phase)) {
        continue;
      }
      if (
        dueEntry.payload &&
        toPositiveInt(dueEntry.payload.revision, 0) !== toPositiveInt(event.revision, 0)
      ) {
        this._scheduleRecord(event);
        continue;
      }
      this._advanceEvent(event, normalizedNowMs);
      processedJobs += 1;
    }

    const durationMs = Math.max(0, this.monotonicClock() - passStartedAt);
    const nextDue = this.queue.peek();
    // Report whether a due backlog remains without scanning the entire heap.
    // The scheduler's performance contract is O(processed jobs * log n), not
    // O(all events) merely to produce an exact telemetry count.
    const deferredJobs = nextDue && nextDue.dueAtMs <= normalizedNowMs ? 1 : 0;
    this.metrics.schedulerPasses += 1;
    this.metrics.processedJobs += processedJobs;
    this.metrics.deferredJobs += deferredJobs;
    this.metrics.lastPassAtMs = normalizedNowMs;
    this.metrics.lastPassDurationMs = durationMs;
    this.metrics.maxPassDurationMs = Math.max(this.metrics.maxPassDurationMs, durationMs);
    return {
      success: true,
      data: {
        processedJobs,
        deferredJobs,
        durationMs,
        queueSize: this.queue.size,
        nextDueAtMs: nextDue ? nextDue.dueAtMs : 0,
        producerChecked: producerResult.checked,
        producerEventsCreated: producerResult.createdCount,
        archivedEvents: producerResult.archivedCount,
      },
    };
  }

  getSnapshot() {
    const events = this.stateStore.listEvents();
    const countsByPhase = {};
    const countsByType = {};
    for (const event of events) {
      countsByPhase[event.phase] = (countsByPhase[event.phase] || 0) + 1;
      countsByType[event.eventType] = (countsByType[event.eventType] || 0) + 1;
    }
    const nextDue = this.queue.peek();
    return {
      enabled: this.options.enabled,
      started: this.started,
      queueSize: this.queue.size,
      nextDueAtMs: nextDue ? nextDue.dueAtMs : 0,
      nextProducerCheckAtMs: this.nextProducerCheckAtMs,
      eventCount: events.length,
      countsByPhase,
      countsByType,
      metrics: cloneValue(this.metrics),
      events: events.map((event) => ({
        eventID: event.eventID,
        eventType: event.eventType,
        definitionID: event.definitionID,
        systemID: event.systemID,
        phase: event.phase,
        eventPhase: event.eventPhase,
        revision: event.revision,
        nextTransitionAtMs: event.nextTransitionAtMs,
        retryCount: event.retryCount,
        lastError: event.lastError,
      })),
    };
  }

  _scheduleRecord(event) {
    if (!event || TERMINAL_PHASES.has(event.phase)) {
      if (event && event.eventID) {
        this.queue.remove(event.eventID);
      }
      return;
    }
    this.queue.schedule(
      event.eventID,
      Math.max(0, toFiniteNumber(event.nextTransitionAtMs, this.clock())),
      { revision: toPositiveInt(event.revision, 1) },
    );
  }

  _advanceEvent(event, nowMs) {
    const definition = this.catalog.getDefinition(event.definitionID);
    const handler = this.handlers.get(normalizeText(event.eventType).toLowerCase());
    if (!definition) {
      this._saveRecovery(event, nowMs, "LIVE_EVENT_DEFINITION_MISSING");
      return;
    }
    if (!handler) {
      this._saveRecovery(event, nowMs, `LIVE_EVENT_HANDLER_MISSING:${event.eventType}`);
      return;
    }

    try {
      const result = handler.advance({
        event: cloneValue(event),
        definition,
        nowMs,
        spaceRuntime: this.spaceRuntime,
        runtime: this,
      }) || {};
      const targetPhase = normalizeText(result.phase, event.phase);
      if (!Object.values(PHASE).includes(targetPhase)) {
        throw new Error(`invalid phase returned by handler: ${targetPhase}`);
      }
      if (!canTransition(event.phase, targetPhase)) {
        throw new Error(`invalid transition ${event.phase} -> ${targetPhase}`);
      }
      const nextTransitionAtMs = TERMINAL_PHASES.has(targetPhase)
        ? 0
        : Math.max(
            nowMs + 1,
            Math.trunc(toFiniteNumber(result.nextTransitionAtMs, nowMs + this.options.schedulerIntervalMs)),
          );
      const nextEvent = {
        ...event,
        ...(result.patch && typeof result.patch === "object" ? cloneValue(result.patch) : {}),
        phase: targetPhase,
        eventPhase: normalizeText(result.eventPhase, event.eventPhase),
        revision: toPositiveInt(event.revision, 0) + 1,
        updatedAtMs: nowMs,
        lastTransitionAtMs: targetPhase !== event.phase ? nowMs : event.lastTransitionAtMs,
        nextTransitionAtMs,
        retryCount: 0,
        lastError: null,
      };
      const saveResult = this.stateStore.saveEvent(nextEvent);
      if (!saveResult || saveResult.success !== true) {
        throw new Error(saveResult && saveResult.errorMsg || "LIVE_EVENT_SAVE_FAILED");
      }
      if (TERMINAL_PHASES.has(nextEvent.phase)) {
        this.queue.remove(nextEvent.eventID);
        this.metrics.completedEvents += 1;
      } else {
        this._scheduleRecord(nextEvent);
      }
    } catch (error) {
      this._saveRecovery(event, nowMs, error && error.message || "LIVE_EVENT_ADVANCE_FAILED");
    }
  }

  _saveRecovery(event, nowMs, errorMessage) {
    const retryCount = Math.max(0, toPositiveInt(event.retryCount, 0)) + 1;
    const retryDelayMs = Math.min(
      this.options.recoveryMaxDelayMs,
      this.options.recoveryBaseDelayMs * (2 ** Math.min(10, retryCount - 1)),
    );
    const recoveryEvent = {
      ...event,
      phase: PHASE.RECOVERY_PENDING,
      revision: toPositiveInt(event.revision, 0) + 1,
      updatedAtMs: nowMs,
      nextTransitionAtMs: nowMs + retryDelayMs,
      retryCount,
      lastError: normalizeText(errorMessage, "LIVE_EVENT_ADVANCE_FAILED").slice(0, 500),
    };
    const saveResult = this.stateStore.saveEvent(recoveryEvent);
    if (saveResult && saveResult.success === true) {
      this._scheduleRecord(recoveryEvent);
    }
    this.metrics.failedJobs += 1;
  }
}

function createNoopHandler() {
  const transitions = {
    [PHASE.SCHEDULED]: PHASE.DORMANT,
    [PHASE.DORMANT]: PHASE.ACTIVE,
    [PHASE.ACTIVE]: PHASE.RESOLVING,
    [PHASE.RESOLVING]: PHASE.AFTERMATH,
    [PHASE.AFTERMATH]: PHASE.CLEANUP,
    [PHASE.CLEANUP]: PHASE.COMPLETED,
    [PHASE.RECOVERY_PENDING]: PHASE.DORMANT,
  };
  return {
    advance({ event, nowMs }) {
      const phase = transitions[event.phase] || PHASE.COMPLETED;
      return {
        phase,
        eventPhase: phase,
        nextTransitionAtMs: phase === PHASE.COMPLETED ? 0 : nowMs + 1_000,
      };
    },
  };
}

let defaultRuntime = null;
function getDefaultRuntime() {
  if (!defaultRuntime) {
    defaultRuntime = new LiveEventRuntime();
    defaultRuntime.registerHandler("noop", createNoopHandler());
    const { createIndustrialMiningEventHandler } = require("./industrialMiningEventHandler");
    defaultRuntime.registerHandler("industrial_mining", createIndustrialMiningEventHandler());
  }
  return defaultRuntime;
}

function start(options = {}) {
  return getDefaultRuntime().start(options);
}

function stop() {
  return getDefaultRuntime().stop();
}

function scheduleEvent(definitionID, options = {}) {
  return getDefaultRuntime().scheduleEvent(definitionID, options);
}

function advanceEventNow(eventID, nowMs) {
  return getDefaultRuntime().advanceEventNow(eventID, nowMs);
}

function requestCleanup(eventID, options = {}) {
  return getDefaultRuntime().requestCleanup(eventID, options);
}

function getSnapshot() {
  return getDefaultRuntime().getSnapshot();
}

module.exports = {
  PHASE,
  TERMINAL_PHASES,
  LiveEventRuntime,
  buildDefaultRuntimeOptions,
  advanceEventNow,
  canTransition,
  createNoopHandler,
  getDefaultRuntime,
  getSnapshot,
  normalizeRuntimeOptions,
  requestCleanup,
  scheduleEvent,
  start,
  stop,
};


