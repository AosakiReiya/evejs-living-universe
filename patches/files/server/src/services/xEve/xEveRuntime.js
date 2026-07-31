"use strict";

const path = require("path");
const { performance } = require("perf_hooks");

const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));
const { DeadlineQueue } = require(path.join(__dirname, "../../space/liveEvents/deadlineQueue"));
const { createLedger, fingerprint } = require("./xEveLedger");
const { getDefaultStateStore } = require("./xEveState");
const { MODE, WORK_CLASS, XEveLoadGovernor } = require("./xEveLoadGovernor");
const {
  applyObservationProjection,
  buildObservationFromReceipts,
  createEmptyObservation,
  getObservationSnapshot,
  projectObservedEvent,
} = require("./xEveObservation");

const WORK_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  COMPLETED: "completed",
  RETRY: "retry",
  FAILED: "failed",
  QUARANTINED: "quarantined",
});
const ACTIVE_WORK_STATUSES = new Set([WORK_STATUS.QUEUED, WORK_STATUS.RETRY]);
const STORED_WORK_STATUSES = new Set([
  WORK_STATUS.QUEUED,
  WORK_STATUS.RUNNING,
  WORK_STATUS.RETRY,
  WORK_STATUS.FAILED,
  WORK_STATUS.QUARANTINED,
]);
const WORK_CLASS_ORDER = Object.freeze([
  WORK_CLASS.SETTLEMENT,
  WORK_CLASS.DEADLINE,
  WORK_CLASS.PLANNING,
  WORK_CLASS.MAINTENANCE,
]);

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeID(value, errorCode) {
  const normalized = normalizeText(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(normalized)) {
    const error = new Error(errorCode);
    error.code = errorCode;
    throw error;
  }
  return normalized;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 1) {
  const numeric = Math.trunc(toFiniteNumber(value, fallback));
  return numeric > 0 ? numeric : fallback;
}

function runtimeError(code, details = {}) {
  return Object.assign(new Error(code), { code, details });
}

function assertRuntimeState(condition, code, details = {}) {
  if (!condition) throw runtimeError(code, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isFingerprint(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function normalizeSource(value) {
  const source = normalizeText(value, "living-universe")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!source) throw runtimeError("X_EVE_EVENT_SOURCE_INVALID");
  return source;
}

function buildEventRequest(raw = {}) {
  return {
    source: normalizeSource(raw.source),
    sourceEventID: normalizeID(raw.sourceEventID, "X_EVE_SOURCE_EVENT_ID_INVALID"),
    eventType: normalizeText(raw.eventType, "event").toLowerCase(),
    version: Math.max(1, toPositiveInt(raw.version, 1)),
    occurredAtMs: Math.max(0, Math.trunc(toFiniteNumber(raw.occurredAtMs, 0))),
    payload: cloneValue(raw.payload || {}),
  };
}

function buildWorkRequest(raw = {}) {
  return {
    workOrderID: raw.workOrderID,
    workClass: raw.workClass,
    handlerType: raw.handlerType,
    dueAtMs: raw.requestedDueAtMs == null ? raw.dueAtMs : raw.requestedDueAtMs,
    retryForever: raw.retryForever === true,
    maxAttempts: raw.maxAttempts == null ? null : raw.maxAttempts,
    payload: cloneValue(raw.payload || {}),
  };
}

function clampNumber(value, minimum, maximum, fallback) {
  return Math.min(maximum, Math.max(minimum, toFiniteNumber(value, fallback)));
}

function clampInteger(value, minimum, maximum, fallback) {
  return Math.trunc(clampNumber(value, minimum, maximum, fallback));
}

function normalizeRuntimeOptions(raw = {}) {
  const tickWarningMs = clampNumber(raw.tickWarningMs, 101, 499, 120);
  const tickOverloadMs = clampNumber(
    raw.tickOverloadMs,
    Math.max(102, tickWarningMs),
    499,
    130,
  );
  const emergencyShedMs = clampNumber(
    raw.emergencyShedMs,
    Math.max(130, tickOverloadMs),
    599,
    500,
  );
  const unplayableMs = clampNumber(
    raw.unplayableMs,
    Math.max(500, emergencyShedMs),
    600,
    600,
  );
  return {
    enabled: raw.enabled === true,
    schedulerIntervalMs: clampInteger(raw.schedulerIntervalMs, 250, 60_000, 1_000),
    schedulerBudgetMs: clampNumber(raw.schedulerBudgetMs, 0.1, 10, 2),
    durabilityIntervalMs: clampInteger(raw.durabilityIntervalMs, 500, 60_000, 2_000),
    maxJobsPerPass: clampInteger(raw.maxJobsPerPass, 1, 100, 32),
    tickSampleCount: clampInteger(raw.tickSampleCount, 2, 120, 20),
    tickWarningMs,
    tickOverloadMs,
    emergencyShedMs,
    unplayableMs,
    recoveryThresholdMs: clampNumber(
      raw.recoveryThresholdMs,
      100,
      Math.min(119, tickWarningMs - 1),
      115,
    ),
    recoveryMs: clampNumber(raw.recoveryMs, 0, 60_000, 5_000),
    retryBaseDelayMs: clampInteger(raw.retryBaseDelayMs, 1_000, 300_000, 5_000),
    maxRetryAttempts: clampInteger(raw.maxRetryAttempts, 1, 100, 8),
    slowHandlerMs: clampNumber(raw.slowHandlerMs, 0.25, 2, 2),
    maximumEventPayloadBytes: clampInteger(
      raw.maximumEventPayloadBytes,
      1_024,
      1_048_576,
      65_536,
    ),
  };
}

function buildDefaultRuntimeOptions() {
  return normalizeRuntimeOptions({
    enabled: config.xEveEnabled === true,
    schedulerIntervalMs: config.xEveSchedulerIntervalMs,
    schedulerBudgetMs: config.xEveSchedulerBudgetMs,
    durabilityIntervalMs: config.xEveDurabilityIntervalMs,
    maxJobsPerPass: config.xEveMaxJobsPerPass,
    tickSampleCount: config.xEveTickSampleCount,
    tickWarningMs: config.xEveTickWarningMs,
    tickOverloadMs: config.xEveTickOverloadMs,
    emergencyShedMs: config.xEveEmergencyShedMs,
    unplayableMs: config.xEveUnplayableMs,
    recoveryThresholdMs: config.xEveRecoveryThresholdMs,
    recoveryMs: config.xEveRecoverySeconds * 1_000,
    maxRetryAttempts: config.xEveMaxRetryAttempts,
  });
}

class XEveRuntime {
  constructor(raw = {}) {
    this.options = normalizeRuntimeOptions(raw.options || buildDefaultRuntimeOptions());
    this.stateStore = raw.stateStore || null;
    this.ledger = raw.ledger || null;
    this.schedulerLedger = null;
    this.clock = typeof raw.clock === "function" ? raw.clock : () => Date.now();
    this.monotonicClock = typeof raw.monotonicClock === "function"
      ? raw.monotonicClock
      : () => performance.now();
    this.governor = raw.governor || new XEveLoadGovernor({
      warningMs: this.options.tickWarningMs,
      overloadMs: this.options.tickOverloadMs,
      emergencyShedMs: this.options.emergencyShedMs,
      unplayableMs: this.options.unplayableMs,
      sampleCount: this.options.tickSampleCount,
      minimumSamples: this.options.tickSampleCount,
      recoveryThresholdMs: this.options.recoveryThresholdMs,
      recoveryMs: this.options.recoveryMs,
      healthyBudgetMs: this.options.schedulerBudgetMs,
      healthyMaxJobs: this.options.maxJobsPerPass,
    });
    this.queues = new Map(WORK_CLASS_ORDER.map((workClass) => [workClass, new DeadlineQueue()]));
    this.handlers = new Map();
    this.handlerContracts = new Map();
    this.quarantinedHandlers = new Map();
    this.spaceRuntime = null;
    this.timer = null;
    this.started = false;
    this.passRunning = false;
    this.queueCursor = 0;
    this.handlerBackoffUntilMs = new Map();
    this.eventIdentityMessageIDs = new Map();
    this.observation = createEmptyObservation();
    this.observationReceiptRows = 0;
    this.observationRebuildDurationMs = 0;
    this.knownWorkOrderCount = 0;
    this.persistenceHealthy = true;
    this.persistenceError = null;
    this.lastDurableHandoffAtMs = 0;
    this.nextDurableHandoffAtMs = 0;
    this.metrics = {
      schedulerPasses: 0,
      visitedJobs: 0,
      processedJobs: 0,
      completedJobs: 0,
      retriedJobs: 0,
      failedJobs: 0,
      deadLetterJobs: 0,
      deferredJobs: 0,
      shedPasses: 0,
      slowHandlers: 0,
      handlerBudgetOverruns: 0,
      recoveredSoftQuarantines: 0,
      recoveredQuarantineJobs: 0,
      quarantinedHandlers: 0,
      quarantinedJobs: 0,
      uncertainJobs: 0,
      unplayableHandlerTrips: 0,
      receivedEvents: 0,
      duplicateEvents: 0,
      eventConflicts: 0,
      durabilityHandoffAttempts: 0,
      durabilityHandoffSuccesses: 0,
      durabilityHandoffFailures: 0,
      durabilityHandoffBlocked: 0,
      lastDurabilityHandoffDurationMs: 0,
      maximumDurabilityHandoffDurationMs: 0,
      lastPassAtMs: 0,
      lastPassDurationMs: 0,
      maximumPassDurationMs: 0,
      maximumHandlerDurationMs: 0,
    };
    this.registerHandler("observe_event", ({ workOrder, nowMs }) => {
      const messageID = normalizeID(
        workOrder && workOrder.payload && workOrder.payload.messageID,
        "X_EVE_MESSAGE_ID_INVALID",
      );
      const message = this._getStateStore().getInboxMessage(messageID);
      if (!message) {
        throw Object.assign(new Error("X_EVE_INBOX_MESSAGE_MISSING"), {
          code: "X_EVE_INBOX_MESSAGE_MISSING",
        });
      }
      const observationProjection = projectObservedEvent(message, nowMs);
      this._mustStateResult(this._getStateStore().saveReceipt({
        schemaVersion: 1,
        operationID: this._eventReceiptID(messageID),
        receiptType: "inbox_event",
        status: "observed",
        messageID,
        requestFingerprint: message.requestFingerprint,
        request: cloneValue(message.request),
        source: message.source,
        sourceEventID: message.sourceEventID,
        eventType: message.eventType,
        version: message.version,
        occurredAtMs: message.occurredAtMs,
        recordedAtMs: nowMs,
        observationProjection,
      }), "X_EVE_INBOX_RECEIPT_WRITE_FAILED");
      applyObservationProjection(this.observation, observationProjection);
      this._mustStateResult(
        this._getStateStore().removeInboxMessage(messageID),
        "X_EVE_INBOX_REMOVE_FAILED",
      );
      return { success: true };
    }, { continuation: true, sliceBudgetMs: this.options.slowHandlerMs });
  }

  _getStateStore() {
    if (!this.stateStore) this.stateStore = getDefaultStateStore();
    return this.stateStore;
  }

  _getLedger() {
    if (!this.ledger) this.ledger = createLedger({ stateStore: this._getStateStore(), clock: this.clock });
    return this.ledger;
  }

  _getSchedulerLedger() {
    if (this.schedulerLedger) return this.schedulerLedger;
    const ledger = this._getLedger();
    const deferred = (method) => (raw = {}, options = {}) => ledger[method](raw, {
      ...options,
      durable: false,
    });
    this.schedulerLedger = Object.freeze({
      commit: deferred("commit"),
      getAccount: (...args) => ledger.getAccount(...args),
      getStatus: (...args) => ledger.getStatus(...args),
      getTransaction: (...args) => ledger.getTransaction(...args),
      issue: deferred("issue"),
      openBalance: deferred("openBalance"),
      retire: deferred("retire"),
      transfer: deferred("transfer"),
    });
    return this.schedulerLedger;
  }

  _createHandlerLedgerScope(effectID, effectiveAtMs) {
    const schedulerLedger = this._getSchedulerLedger();
    let active = true;
    let monetaryMutationAttempted = false;
    let monetaryMutationCommitted = false;
    const monetaryMethods = new Set([
      "commit",
      "issue",
      "openBalance",
      "retire",
      "transfer",
    ]);
    const scoped = {};
    for (const methodName of Object.keys(schedulerLedger)) {
      scoped[methodName] = (...args) => {
        if (!active) throw runtimeError("X_EVE_HANDLER_SCOPE_CLOSED");
        if (monetaryMethods.has(methodName)) {
          if (monetaryMutationAttempted) {
            throw runtimeError("X_EVE_HANDLER_MULTIPLE_LEDGER_EFFECTS", { effectID });
          }
          const raw = isPlainObject(args[0]) ? cloneValue(args[0]) : {};
          if (raw.transactionID != null && raw.transactionID !== effectID) {
            throw runtimeError("X_EVE_HANDLER_EFFECT_ID_MISMATCH", { effectID });
          }
          if (raw.sourceEventID != null && raw.sourceEventID !== effectID) {
            throw runtimeError("X_EVE_HANDLER_EFFECT_ID_MISMATCH", { effectID });
          }
          if (raw.effectiveAtMs != null) {
            const suppliedEffectiveAtMs = Number(raw.effectiveAtMs);
            if (
              !Number.isFinite(suppliedEffectiveAtMs) ||
              Math.max(0, Math.trunc(suppliedEffectiveAtMs)) !== effectiveAtMs
            ) {
              throw runtimeError("X_EVE_HANDLER_EFFECT_TIME_MISMATCH", { effectID });
            }
          }
          monetaryMutationAttempted = true;
          args[0] = {
            ...raw,
            transactionID: effectID,
            sourceEventID: effectID,
            effectiveAtMs,
          };
        }
        const result = schedulerLedger[methodName](...args);
        if (
          monetaryMethods.has(methodName) &&
          result &&
          result.success === true
        ) {
          monetaryMutationCommitted = true;
        }
        return result;
      };
    }
    return {
      ledger: Object.freeze(scoped),
      monetaryMutationAttempted() {
        return monetaryMutationAttempted;
      },
      monetaryMutationCommitted() {
        return monetaryMutationCommitted;
      },
      close() {
        active = false;
      },
    };
  }

  registerDurabilityPrerequisite(key, callback) {
    const stateStore = this._getStateStore();
    if (typeof stateStore.registerDurabilityPrerequisite !== "function") {
      return {
        success: false,
        errorMsg: "X_EVE_DURABILITY_PREREQUISITE_UNSUPPORTED",
      };
    }
    return stateStore.registerDurabilityPrerequisite(key, callback);
  }

  unregisterDurabilityPrerequisite(key) {
    const stateStore = this._getStateStore();
    if (typeof stateStore.unregisterDurabilityPrerequisite !== "function") {
      return { success: true, unsupported: true };
    }
    return stateStore.unregisterDurabilityPrerequisite(key);
  }

  _receiptID(prefix, recordID) {
    const candidate = `${prefix}:${recordID}`;
    if (candidate.length <= 160) return candidate;
    return `${prefix}:${fingerprint(recordID).slice(0, 48)}`;
  }

  _eventReceiptID(messageID) {
    return this._receiptID("event", messageID);
  }

  _workReceiptID(workOrderID) {
    return this._receiptID("work", workOrderID);
  }

  _handlerQuarantineReceiptID(handlerType) {
    return this._receiptID("handler-quarantine", handlerType);
  }

  _persistHandlerQuarantine(handlerType, reason, nowMs, durationMs) {
    const request = { handlerType };
    const receipt = {
      schemaVersion: 1,
      operationID: this._handlerQuarantineReceiptID(handlerType),
      receiptType: "handler_quarantine",
      status: "quarantined",
      handlerType,
      reason,
      request,
      requestFingerprint: fingerprint(request),
      quarantinedAtMs: nowMs,
      durationMs: Math.max(0, toFiniteNumber(durationMs, 0)),
    };
    this._mustStateResult(
      this._getStateStore().saveReceipt(receipt),
      "X_EVE_HANDLER_QUARANTINE_WRITE_FAILED",
    );
    return receipt;
  }

  _getObservedEventReceipt(workOrder) {
    if (!workOrder || workOrder.handlerType !== "observe_event") return null;
    const messageID = workOrder.payload && workOrder.payload.messageID;
    if (!messageID) return null;
    const receipt = this._getStateStore().getReceipt(this._eventReceiptID(messageID));
    if (!receipt) return null;
    this._validateReceipt(receipt);
    assertRuntimeState(receipt.messageID === messageID, "X_EVE_EVENT_RECEIPT_CONFLICT", {
      messageID,
      operationID: receipt.operationID,
    });
    const message = this._getStateStore().getInboxMessage(messageID);
    if (message) {
      this._validateInboxMessage(message);
      this._assertEventReceiptMatchesMessage(receipt, message);
    }
    return receipt;
  }

  _cleanupObservedEventWork(workOrder) {
    const messageID = normalizeID(
      workOrder && workOrder.payload && workOrder.payload.messageID,
      "X_EVE_MESSAGE_ID_INVALID",
    );
    if (this._getStateStore().getInboxMessage(messageID)) {
      this._mustStateResult(
        this._getStateStore().removeInboxMessage(messageID),
        "X_EVE_STALE_INBOX_REMOVE_FAILED",
      );
    }
    this._mustStateResult(
      this._getStateStore().removeWorkOrder(workOrder.workOrderID),
      "X_EVE_STALE_WORK_ORDER_REMOVE_FAILED",
    );
  }

  _recoverSoftDurationQuarantines(nowMs = this.clock()) {
    const normalizedNowMs = Math.max(0, Math.trunc(toFiniteNumber(nowMs, this.clock())));
    const recoverableReason = "X_EVE_HANDLER_SLICE_BUDGET_EXCEEDED";
    const receipts = this._getStateStore().listReceipts();
    const workOrders = this._getStateStore().listWorkOrders();
    let recoveredHandlers = 0;
    let recoveredJobs = 0;
    let cleanedJobs = 0;

    for (const receipt of receipts) {
      if (
        !receipt ||
        receipt.receiptType !== "handler_quarantine" ||
        receipt.reason !== recoverableReason
      ) {
        continue;
      }
      this._validateReceipt(receipt);
      const handlerType = receipt.handlerType;
      const uncertainWorkExists = workOrders.some((workOrder) => (
        workOrder &&
        workOrder.handlerType === handlerType &&
        workOrder.status === WORK_STATUS.QUARANTINED
      ));
      if (uncertainWorkExists) continue;

      for (const workOrder of workOrders) {
        if (
          !workOrder ||
          workOrder.handlerType !== handlerType ||
          workOrder.handlerType !== "observe_event" ||
          workOrder.status !== WORK_STATUS.FAILED ||
          workOrder.lastError !== "X_EVE_HANDLER_QUARANTINED"
        ) {
          continue;
        }
        const messageID = normalizeID(
          workOrder.payload && workOrder.payload.messageID,
          "X_EVE_MESSAGE_ID_INVALID",
        );
        const inboxMessage = this._getStateStore().getInboxMessage(messageID);
        const eventReceipt = this._getStateStore().getReceipt(this._eventReceiptID(messageID));
        if (eventReceipt) {
          this._validateReceipt(eventReceipt);
          if (inboxMessage) {
            this._validateInboxMessage(inboxMessage);
            this._assertEventReceiptMatchesMessage(eventReceipt, inboxMessage);
            this._mustStateResult(
              this._getStateStore().removeInboxMessage(messageID),
              "X_EVE_STALE_INBOX_REMOVE_FAILED",
            );
          }
          this._mustStateResult(
            this._getStateStore().removeWorkOrder(workOrder.workOrderID),
            "X_EVE_STALE_WORK_ORDER_REMOVE_FAILED",
          );
          cleanedJobs += 1;
          continue;
        }
        if (!inboxMessage) continue;
        this._validateInboxMessage(inboxMessage);
        const recovered = {
          ...workOrder,
          status: WORK_STATUS.QUEUED,
          dueAtMs: normalizedNowMs,
          updatedAtMs: normalizedNowMs,
          lastError: null,
        };
        delete recovered.failedAtMs;
        delete recovered.quarantinedAtMs;
        delete recovered.uncertainOutcome;
        delete recovered.startedAtMs;
        this._mustStateResult(
          this._getStateStore().saveWorkOrder(recovered),
          "X_EVE_QUARANTINE_RECOVERY_WRITE_FAILED",
        );
        recoveredJobs += 1;
      }

      if (typeof this._getStateStore().removeReceipt !== "function") {
        throw runtimeError("X_EVE_QUARANTINE_RECOVERY_UNSUPPORTED");
      }
      this._mustStateResult(
        this._getStateStore().removeReceipt(receipt.operationID),
        "X_EVE_QUARANTINE_RECEIPT_REMOVE_FAILED",
      );
      this.quarantinedHandlers.delete(handlerType);
      recoveredHandlers += 1;
    }

    this.metrics.recoveredSoftQuarantines += recoveredHandlers;
    this.metrics.recoveredQuarantineJobs += recoveredJobs + cleanedJobs;
    return {
      success: true,
      data: { recoveredHandlers, recoveredJobs, cleanedJobs },
    };
  }

  _markPersistenceFailure(code) {
    this.persistenceHealthy = false;
    this.persistenceError = normalizeText(code, "X_EVE_PERSISTENCE_FAILED");
  }

  _mustStateResult(result, code) {
    if (!result || result.success !== true) {
      const errorCode = result && result.errorMsg || code;
      this._markPersistenceFailure(errorCode);
      throw Object.assign(new Error(errorCode), { code: errorCode });
    }
    return result;
  }

  registerHandler(handlerType, handler, contract = {}) {
    if (this.started) {
      throw runtimeError("X_EVE_HANDLER_REGISTRATION_CLOSED");
    }
    const normalizedType = normalizeText(handlerType).toLowerCase();
    if (!normalizedType || typeof handler !== "function") {
      throw new Error("registerHandler requires a type and synchronous handler function");
    }
    if (handler.constructor && handler.constructor.name === "AsyncFunction") {
      throw new Error(`X-Eve handler ${normalizedType} must be a synchronous continuation`);
    }
    const sliceBudgetMs = toFiniteNumber(contract.sliceBudgetMs, 0);
    if (contract.continuation !== true || sliceBudgetMs <= 0) {
      throw new Error(
        `X-Eve handler ${normalizedType} must declare a synchronous continuation slice budget`,
      );
    }
    if (sliceBudgetMs > this.options.slowHandlerMs) {
      throw new Error(
        `X-Eve handler ${normalizedType} slice budget exceeds ${this.options.slowHandlerMs} ms`,
      );
    }
    this.handlers.set(normalizedType, handler);
    this.handlerContracts.set(normalizedType, Object.freeze({
      continuation: true,
      sliceBudgetMs,
    }));
    this.quarantinedHandlers.delete(normalizedType);
    return handler;
  }

  _validateInboxMessage(message) {
    assertRuntimeState(isPlainObject(message), "X_EVE_INBOX_SCHEMA_INVALID");
    assertRuntimeState(message.schemaVersion === 1, "X_EVE_INBOX_SCHEMA_INVALID");
    const messageID = normalizeID(message.messageID, "X_EVE_MESSAGE_ID_INVALID");
    assertRuntimeState(messageID === message.messageID, "X_EVE_INBOX_SCHEMA_INVALID", { messageID });
    assertRuntimeState(message.status === "received", "X_EVE_INBOX_STATUS_INVALID", { messageID });
    assertRuntimeState(normalizeSource(message.source) === message.source, "X_EVE_INBOX_SCHEMA_INVALID", {
      messageID,
    });
    normalizeID(message.sourceEventID, "X_EVE_SOURCE_EVENT_ID_INVALID");
    assertRuntimeState(
      normalizeText(message.eventType).length > 0 &&
      normalizeText(message.eventType).toLowerCase() === message.eventType,
      "X_EVE_INBOX_SCHEMA_INVALID",
      { messageID },
    );
    assertRuntimeState(isPositiveInteger(message.version), "X_EVE_INBOX_SCHEMA_INVALID", { messageID });
    assertRuntimeState(
      isNonNegativeInteger(message.occurredAtMs) &&
      isNonNegativeInteger(message.receivedAtMs) &&
      isNonNegativeInteger(message.observedAtMs),
      "X_EVE_INBOX_SCHEMA_INVALID",
      { messageID },
    );
    assertRuntimeState(isPlainObject(message.payload), "X_EVE_INBOX_SCHEMA_INVALID", { messageID });
    assertRuntimeState(
      Buffer.byteLength(JSON.stringify(message.payload), "utf8") <= this.options.maximumEventPayloadBytes,
      "X_EVE_EVENT_PAYLOAD_TOO_LARGE",
      { messageID },
    );
    assertRuntimeState(isPlainObject(message.request), "X_EVE_INBOX_REQUEST_MISSING", { messageID });
    assertRuntimeState(isFingerprint(message.requestFingerprint), "X_EVE_INBOX_FINGERPRINT_INVALID", {
      messageID,
    });
    const expectedRequest = buildEventRequest(message);
    assertRuntimeState(
      fingerprint(expectedRequest) === message.requestFingerprint &&
      fingerprint(message.request) === message.requestFingerprint,
      "X_EVE_INBOX_FINGERPRINT_MISMATCH",
      { messageID },
    );
    return message;
  }

  _validateWorkOrder(workOrder) {
    assertRuntimeState(isPlainObject(workOrder), "X_EVE_WORK_ORDER_SCHEMA_INVALID");
    assertRuntimeState(workOrder.schemaVersion === 1, "X_EVE_WORK_ORDER_SCHEMA_INVALID");
    const workOrderID = normalizeID(workOrder.workOrderID, "X_EVE_WORK_ORDER_ID_INVALID");
    assertRuntimeState(workOrderID === workOrder.workOrderID, "X_EVE_WORK_ORDER_SCHEMA_INVALID", {
      workOrderID,
    });
    assertRuntimeState(this.queues.has(workOrder.workClass), "X_EVE_WORK_CLASS_INVALID", {
      workOrderID,
      workClass: workOrder.workClass,
    });
    assertRuntimeState(
      normalizeText(workOrder.handlerType).length > 0 &&
      normalizeText(workOrder.handlerType).toLowerCase() === workOrder.handlerType,
      "X_EVE_HANDLER_TYPE_INVALID",
      { workOrderID },
    );
    assertRuntimeState(STORED_WORK_STATUSES.has(workOrder.status), "X_EVE_WORK_STATUS_INVALID", {
      workOrderID,
      status: workOrder.status,
    });
    assertRuntimeState(
      isNonNegativeInteger(workOrder.requestedDueAtMs) &&
      isNonNegativeInteger(workOrder.dueAtMs) &&
      isNonNegativeInteger(workOrder.retryCount) &&
      isNonNegativeInteger(workOrder.createdAtMs) &&
      isNonNegativeInteger(workOrder.updatedAtMs),
      "X_EVE_WORK_ORDER_SCHEMA_INVALID",
      { workOrderID },
    );
    assertRuntimeState(typeof workOrder.retryForever === "boolean", "X_EVE_WORK_ORDER_SCHEMA_INVALID", {
      workOrderID,
    });
    assertRuntimeState(
      !workOrder.retryForever || [WORK_CLASS.SETTLEMENT, WORK_CLASS.DEADLINE].includes(
        workOrder.workClass,
      ),
      "X_EVE_WORK_ORDER_SCHEMA_INVALID",
      { workOrderID },
    );
    assertRuntimeState(
      workOrder.retryForever
        ? workOrder.maxAttempts === null
        : isPositiveInteger(workOrder.maxAttempts),
      "X_EVE_WORK_ORDER_SCHEMA_INVALID",
      { workOrderID },
    );
    assertRuntimeState(isPlainObject(workOrder.payload), "X_EVE_WORK_ORDER_SCHEMA_INVALID", {
      workOrderID,
    });
    assertRuntimeState(
      Buffer.byteLength(JSON.stringify(workOrder.payload), "utf8") <=
      this.options.maximumEventPayloadBytes,
      "X_EVE_WORK_PAYLOAD_TOO_LARGE",
      { workOrderID },
    );
    if ([WORK_STATUS.QUEUED, WORK_STATUS.RETRY, WORK_STATUS.RUNNING].includes(workOrder.status)) {
      assertRuntimeState(this.handlers.has(workOrder.handlerType), "X_EVE_HANDLER_NOT_REGISTERED", {
        workOrderID,
      });
    }
    if (workOrder.status === WORK_STATUS.RETRY) {
      assertRuntimeState(
        workOrder.retryCount >= 1 && normalizeText(workOrder.lastError).length > 0,
        "X_EVE_WORK_ORDER_SCHEMA_INVALID",
        { workOrderID },
      );
    }
    if (workOrder.status === WORK_STATUS.QUARANTINED) {
      assertRuntimeState(
        workOrder.uncertainOutcome === true && isNonNegativeInteger(workOrder.quarantinedAtMs),
        "X_EVE_WORK_ORDER_SCHEMA_INVALID",
        { workOrderID },
      );
    }
    assertRuntimeState(isPlainObject(workOrder.request), "X_EVE_WORK_REQUEST_MISSING", {
      workOrderID,
    });
    assertRuntimeState(isFingerprint(workOrder.requestFingerprint), "X_EVE_WORK_FINGERPRINT_INVALID", {
      workOrderID,
    });
    const expectedRequest = buildWorkRequest(workOrder);
    assertRuntimeState(
      fingerprint(expectedRequest) === workOrder.requestFingerprint &&
      fingerprint(workOrder.request) === workOrder.requestFingerprint,
      "X_EVE_WORK_FINGERPRINT_MISMATCH",
      { workOrderID },
    );
    if (workOrder.handlerType === "observe_event") {
      const messageID = normalizeID(
        workOrder.payload && workOrder.payload.messageID,
        "X_EVE_MESSAGE_ID_INVALID",
      );
      assertRuntimeState(
        workOrder.workClass === WORK_CLASS.MAINTENANCE &&
        workOrder.workOrderID === this._receiptID("inbox", messageID),
        "X_EVE_INBOX_WORK_RELATION_INVALID",
        { workOrderID, messageID },
      );
    }
    return workOrder;
  }

  _validateReceipt(receipt) {
    assertRuntimeState(isPlainObject(receipt), "X_EVE_RECEIPT_SCHEMA_INVALID");
    assertRuntimeState(receipt.schemaVersion === 1, "X_EVE_RECEIPT_SCHEMA_INVALID");
    const operationID = normalizeID(receipt.operationID, "X_EVE_OPERATION_ID_INVALID");
    assertRuntimeState(operationID === receipt.operationID, "X_EVE_RECEIPT_SCHEMA_INVALID", {
      operationID,
    });
    assertRuntimeState(isFingerprint(receipt.requestFingerprint), "X_EVE_RECEIPT_FINGERPRINT_INVALID", {
      operationID,
    });
    assertRuntimeState(isPlainObject(receipt.request), "X_EVE_RECEIPT_REQUEST_MISSING", {
      operationID,
    });
    assertRuntimeState(
      fingerprint(receipt.request) === receipt.requestFingerprint,
      "X_EVE_RECEIPT_FINGERPRINT_MISMATCH",
      { operationID },
    );
    if (receipt.receiptType === "inbox_event") {
      const messageID = normalizeID(receipt.messageID, "X_EVE_MESSAGE_ID_INVALID");
      assertRuntimeState(receipt.status === "observed", "X_EVE_RECEIPT_STATUS_INVALID", {
        operationID,
      });
      assertRuntimeState(
        operationID === this._eventReceiptID(messageID),
        "X_EVE_EVENT_RECEIPT_RELATION_INVALID",
        { operationID, messageID },
      );
      const expectedRequest = buildEventRequest(receipt.request);
      assertRuntimeState(
        fingerprint(expectedRequest) === receipt.requestFingerprint &&
        isPlainObject(receipt.request.payload) &&
        Buffer.byteLength(JSON.stringify(receipt.request.payload), "utf8") <=
          this.options.maximumEventPayloadBytes &&
        receipt.source === receipt.request.source &&
        receipt.sourceEventID === receipt.request.sourceEventID &&
        receipt.eventType === receipt.request.eventType &&
        receipt.version === receipt.request.version &&
        receipt.occurredAtMs === receipt.request.occurredAtMs,
        "X_EVE_EVENT_RECEIPT_RELATION_INVALID",
        { operationID, messageID },
      );
      assertRuntimeState(
        isNonNegativeInteger(receipt.recordedAtMs),
        "X_EVE_RECEIPT_SCHEMA_INVALID",
        { operationID },
      );
      return receipt;
    }
    if (receipt.receiptType === "work_order") {
      const workOrderID = normalizeID(receipt.workOrderID, "X_EVE_WORK_ORDER_ID_INVALID");
      assertRuntimeState(receipt.status === "completed", "X_EVE_RECEIPT_STATUS_INVALID", {
        operationID,
      });
      assertRuntimeState(
        operationID === this._workReceiptID(workOrderID),
        "X_EVE_WORK_RECEIPT_RELATION_INVALID",
        { operationID, workOrderID },
      );
      const expectedRequest = buildWorkRequest(receipt.request);
      assertRuntimeState(
        fingerprint(expectedRequest) === receipt.requestFingerprint &&
        isPlainObject(receipt.request.payload) &&
        isNonNegativeInteger(receipt.request.dueAtMs) &&
        typeof receipt.request.retryForever === "boolean" &&
        (receipt.request.retryForever
          ? receipt.request.maxAttempts === null &&
            [WORK_CLASS.SETTLEMENT, WORK_CLASS.DEADLINE].includes(receipt.request.workClass)
          : isPositiveInteger(receipt.request.maxAttempts)) &&
        receipt.request.workOrderID === workOrderID &&
        receipt.workClass === receipt.request.workClass &&
        receipt.handlerType === receipt.request.handlerType,
        "X_EVE_WORK_RECEIPT_RELATION_INVALID",
        { operationID, workOrderID },
      );
      assertRuntimeState(
        this.queues.has(receipt.workClass) &&
        normalizeText(receipt.handlerType).length > 0 &&
        normalizeText(receipt.handlerType).toLowerCase() === receipt.handlerType &&
        isNonNegativeInteger(receipt.completedAtMs),
        "X_EVE_RECEIPT_SCHEMA_INVALID",
        { operationID },
      );
      return receipt;
    }
    if (receipt.receiptType === "handler_quarantine") {
      const handlerType = normalizeText(receipt.handlerType).toLowerCase();
      assertRuntimeState(
        handlerType.length > 0 && handlerType === receipt.handlerType,
        "X_EVE_RECEIPT_SCHEMA_INVALID",
        { operationID },
      );
      assertRuntimeState(
        receipt.status === "quarantined" &&
        operationID === this._handlerQuarantineReceiptID(handlerType) &&
        receipt.request.handlerType === handlerType &&
        fingerprint({ handlerType }) === receipt.requestFingerprint &&
        normalizeText(receipt.reason).length > 0 &&
        isNonNegativeInteger(receipt.quarantinedAtMs) &&
        Number.isFinite(receipt.durationMs) && receipt.durationMs >= 0,
        "X_EVE_HANDLER_QUARANTINE_RECEIPT_INVALID",
        { operationID, handlerType },
      );
      return receipt;
    }
    throw runtimeError("X_EVE_RECEIPT_TYPE_INVALID", { operationID });
  }

  _assertEventReceiptMatchesMessage(receipt, message) {
    assertRuntimeState(
      receipt.messageID === message.messageID &&
      receipt.requestFingerprint === message.requestFingerprint &&
      fingerprint(receipt.request) === fingerprint(message.request) &&
      receipt.source === message.source &&
      receipt.sourceEventID === message.sourceEventID &&
      receipt.eventType === message.eventType &&
      receipt.version === message.version &&
      receipt.occurredAtMs === message.occurredAtMs,
      "X_EVE_EVENT_RECEIPT_CONFLICT",
      { messageID: message.messageID, operationID: receipt.operationID },
    );
  }

  auditRuntimeState() {
    try {
      const inboxRows = this._getStateStore().listInboxMessages();
      const workRows = this._getStateStore().listWorkOrders();
      const receiptRows = this._getStateStore().listReceipts();
      const inboxByID = new Map();
      const workByID = new Map();
      const receiptByID = new Map();
      const eventIdentityToMessageID = new Map();
      const persistedQuarantinedHandlers = new Map();

      const rememberEventIdentity = (source, sourceEventID, messageID) => {
        const identity = `${source}:${sourceEventID}`;
        const priorMessageID = eventIdentityToMessageID.get(identity);
        assertRuntimeState(
          !priorMessageID || priorMessageID === messageID,
          "X_EVE_EVENT_IDENTITY_CONFLICT",
          { identity, priorMessageID, messageID },
        );
        eventIdentityToMessageID.set(identity, messageID);
      };

      for (const message of inboxRows) {
        this._validateInboxMessage(message);
        inboxByID.set(message.messageID, message);
        rememberEventIdentity(message.source, message.sourceEventID, message.messageID);
      }
      for (const workOrder of workRows) {
        this._validateWorkOrder(workOrder);
        assertRuntimeState(
          !workOrder.workOrderID.startsWith("inbox:") || workOrder.handlerType === "observe_event",
          "X_EVE_INTERNAL_ID_NAMESPACE_RESERVED",
          { workOrderID: workOrder.workOrderID },
        );
        workByID.set(workOrder.workOrderID, workOrder);
        if (workOrder.status === WORK_STATUS.QUARANTINED) {
          persistedQuarantinedHandlers.set(
            workOrder.handlerType,
            normalizeText(workOrder.lastError, "X_EVE_HANDLER_QUARANTINED"),
          );
        }
      }
      for (const receipt of receiptRows) {
        this._validateReceipt(receipt);
        receiptByID.set(receipt.operationID, receipt);
        if (receipt.receiptType === "inbox_event") {
          rememberEventIdentity(receipt.source, receipt.sourceEventID, receipt.messageID);
        } else if (receipt.receiptType === "handler_quarantine") {
          persistedQuarantinedHandlers.set(receipt.handlerType, receipt.reason);
        }
      }

      for (const message of inboxRows) {
        const eventReceipt = receiptByID.get(this._eventReceiptID(message.messageID));
        if (eventReceipt) this._assertEventReceiptMatchesMessage(eventReceipt, message);
        const inboxWorkID = this._receiptID("inbox", message.messageID);
        const inboxWork = workByID.get(inboxWorkID);
        if (inboxWork) {
          assertRuntimeState(
            inboxWork.handlerType === "observe_event" &&
            inboxWork.payload.messageID === message.messageID &&
            inboxWork.requestedDueAtMs === message.receivedAtMs,
            "X_EVE_INBOX_WORK_RELATION_INVALID",
            { messageID: message.messageID, workOrderID: inboxWorkID },
          );
        }
      }

      for (const workOrder of workRows) {
        if (workOrder.handlerType === "observe_event") {
          const messageID = workOrder.payload.messageID;
          const message = inboxByID.get(messageID);
          const receipt = receiptByID.get(this._eventReceiptID(messageID));
          assertRuntimeState(
            Boolean(message || receipt),
            "X_EVE_ORPHAN_INBOX_WORK",
            { workOrderID: workOrder.workOrderID, messageID },
          );
          if (message && receipt) this._assertEventReceiptMatchesMessage(receipt, message);
        }
        const completionReceipt = receiptByID.get(this._workReceiptID(workOrder.workOrderID));
        if (completionReceipt) {
          assertRuntimeState(
            completionReceipt.requestFingerprint === workOrder.requestFingerprint &&
            fingerprint(completionReceipt.request) === fingerprint(workOrder.request),
            "X_EVE_WORK_RECEIPT_CONFLICT",
            { workOrderID: workOrder.workOrderID },
          );
        }
      }

      this.eventIdentityMessageIDs = new Map(eventIdentityToMessageID);
      this.quarantinedHandlers = new Map(persistedQuarantinedHandlers);

      return {
        success: true,
        data: {
          inboxCount: inboxRows.length,
          workOrderCount: workRows.length,
          receiptCount: receiptRows.length,
        },
      };
    } catch (error) {
      const errorMsg = error && (error.code || error.message) || "X_EVE_RUNTIME_AUDIT_FAILED";
      this._markPersistenceFailure(errorMsg);
      try {
        this._getStateStore().suspendPersistence(errorMsg);
      } catch (_suspendError) {
        // The original audit failure remains authoritative.
      }
      return { success: false, errorMsg, details: error && error.details || {} };
    }
  }

  start(startOptions = {}) {
    if (this.started) return { success: true, data: this.getSnapshot() };
    if (!this.options.enabled && startOptions.force !== true) {
      return { success: true, data: this.getSnapshot() };
    }
    if (startOptions.spaceRuntime) this.spaceRuntime = startOptions.spaceRuntime;
    const initializeResult = this._getStateStore().ensureInitialized(this.clock());
    if (!initializeResult || initializeResult.success !== true) {
      return initializeResult || { success: false, errorMsg: "X_EVE_STATE_INIT_FAILED" };
    }
    const preRecoveryAudit = this.auditRuntimeState();
    if (!preRecoveryAudit || preRecoveryAudit.success !== true) {
      return preRecoveryAudit || { success: false, errorMsg: "X_EVE_RUNTIME_STATE_AUDIT_FAILED" };
    }
    const observationReceipts = this._getStateStore().listReceipts();
    const observationRebuildStartedAt = this.monotonicClock();
    this.observation = buildObservationFromReceipts(observationReceipts);
    this.observationReceiptRows = observationReceipts.length;
    this.observationRebuildDurationMs = Math.max(
      0,
      this.monotonicClock() - observationRebuildStartedAt,
    );
    let softQuarantineRecovery;
    try {
      softQuarantineRecovery = this._recoverSoftDurationQuarantines(this.clock());
    } catch (error) {
      const errorMsg = error && (error.code || error.message) ||
        "X_EVE_QUARANTINE_RECOVERY_FAILED";
      this._markPersistenceFailure(errorMsg);
      return { success: false, errorMsg, details: error && error.details || {} };
    }
    if (
      softQuarantineRecovery &&
      softQuarantineRecovery.data &&
      softQuarantineRecovery.data.recoveredHandlers > 0
    ) {
      const recoveryAudit = this.auditRuntimeState();
      if (!recoveryAudit || recoveryAudit.success !== true) {
        return recoveryAudit || { success: false, errorMsg: "X_EVE_RUNTIME_STATE_AUDIT_FAILED" };
      }
    }
    const ledgerResult = this._getLedger().ensureInitialized(this.clock(), { durable: false });
    if (!ledgerResult || ledgerResult.success !== true) return ledgerResult;
    const ledgerRecovery = this._getLedger().recover();
    if (!ledgerRecovery || ledgerRecovery.success !== true) {
      this._markPersistenceFailure(
        ledgerRecovery && ledgerRecovery.errorMsg || "X_EVE_LEDGER_RECOVERY_FAILED",
      );
      return ledgerRecovery || { success: false, errorMsg: "X_EVE_LEDGER_RECOVERY_FAILED" };
    }
    try {
      this.rebuildQueues(this.clock());
    } catch (error) {
      const errorMsg = error && (error.code || error.message) || "X_EVE_QUEUE_RECOVERY_FAILED";
      this._markPersistenceFailure(errorMsg);
      return { success: false, errorMsg, details: error && error.details || {} };
    }
    const inboxRecovery = this.reconcileInbox(this.clock());
    if (!inboxRecovery || inboxRecovery.success !== true) {
      this._markPersistenceFailure(
        inboxRecovery && inboxRecovery.errorMsg || "X_EVE_INBOX_RECONCILE_FAILED",
      );
      return inboxRecovery || { success: false, errorMsg: "X_EVE_INBOX_RECONCILE_FAILED" };
    }
    const postRecoveryAudit = this.auditRuntimeState();
    if (!postRecoveryAudit || postRecoveryAudit.success !== true) {
      return postRecoveryAudit || { success: false, errorMsg: "X_EVE_RUNTIME_STATE_AUDIT_FAILED" };
    }
    const recoveryFlush = this._getStateStore().flushDurably();
    if (!recoveryFlush || recoveryFlush.success !== true) {
      return recoveryFlush || { success: false, errorMsg: "X_EVE_RECOVERY_FLUSH_FAILED" };
    }
    this.persistenceHealthy = true;
    this.persistenceError = null;
    this.lastDurableHandoffAtMs = this.clock();
    this.nextDurableHandoffAtMs = this.lastDurableHandoffAtMs + this.options.durabilityIntervalMs;
    this.started = true;
    this._armTimer();
    return { success: true, data: this.getSnapshot() };
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started) {
      return { success: true, data: { success: true, flushed: false } };
    }
    let flushResult;
    try {
      flushResult = this.flushDurably();
    } catch (error) {
      this._markPersistenceFailure(error && (error.code || error.message));
      flushResult = {
        success: false,
        errorMsg: error && (error.code || error.message) || "X_EVE_STOP_FLUSH_THROWN",
      };
    }
    if (!flushResult || flushResult.success !== true) {
      // Keep the runtime logically started so another stop or recovery attempt
      // can retry the source-before-sink durability boundary.
      this._armTimer();
      return flushResult || { success: false, errorMsg: "X_EVE_STOP_FLUSH_FAILED" };
    }
    this.started = false;
    return { success: true, data: flushResult };
  }

  _armTimer() {
    if (!this.started || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const nowMs = this.clock();
      try {
        this.runDueWork(nowMs);
      } catch (error) {
        log.warn(`[X-Eve] Scheduler pass failed: ${error.message}`);
      } finally {
        const handoff = this.maintainPersistence(nowMs);
        if (handoff && handoff.success === false) {
          log.warn(`[X-Eve] Durable state handoff failed: ${handoff.errorMsg}`);
        }
        this._armTimer();
      }
    }, this.options.schedulerIntervalMs);
    if (this.timer && typeof this.timer.unref === "function") this.timer.unref();
  }

  maintainPersistence(nowMs = this.clock(), handoffOptions = {}) {
    const normalizedNowMs = Math.max(0, Math.trunc(toFiniteNumber(nowMs, this.clock())));
    if (!this.started && handoffOptions.force !== true) {
      return { success: true, skipped: true, reason: "X_EVE_NOT_STARTED" };
    }
    if (
      handoffOptions.force !== true &&
      normalizedNowMs < this.nextDurableHandoffAtMs
    ) {
      return {
        success: true,
        skipped: true,
        nextDurableHandoffAtMs: this.nextDurableHandoffAtMs,
      };
    }

    this.nextDurableHandoffAtMs = normalizedNowMs + this.options.durabilityIntervalMs;
    this.metrics.durabilityHandoffAttempts += 1;
    const handoffStartedAt = this.monotonicClock();
    try {
      const result = this._getStateStore().requestDurableHandoff();
      if (!result || result.success !== true) {
        this.metrics.durabilityHandoffFailures += 1;
        this._markPersistenceFailure(result && result.errorMsg || "X_EVE_DURABLE_HANDOFF_FAILED");
        return result || { success: false, errorMsg: "X_EVE_DURABLE_HANDOFF_FAILED" };
      }
      if (result.blocked === true || result.pendingDirty === true) {
        this.metrics.durabilityHandoffBlocked += 1;
        this.nextDurableHandoffAtMs = normalizedNowMs + Math.min(
          this.options.schedulerIntervalMs,
          this.options.durabilityIntervalMs,
        );
        const stalledForMs = this.lastDurableHandoffAtMs > 0
          ? Math.max(0, normalizedNowMs - this.lastDurableHandoffAtMs)
          : 0;
        if (stalledForMs >= this.options.durabilityIntervalMs * 2) {
          this.metrics.durabilityHandoffFailures += 1;
          this._markPersistenceFailure("X_EVE_DURABLE_HANDOFF_STALLED");
          return {
            success: false,
            errorMsg: "X_EVE_DURABLE_HANDOFF_STALLED",
            stalledForMs,
          };
        }
        return {
          ...result,
          success: true,
          skipped: true,
          stalledForMs,
          lastDurableHandoffAtMs: this.lastDurableHandoffAtMs,
          nextDurableHandoffAtMs: this.nextDurableHandoffAtMs,
        };
      }
      this.metrics.durabilityHandoffSuccesses += 1;
      this.lastDurableHandoffAtMs = normalizedNowMs;
      return {
        ...result,
        success: true,
        lastDurableHandoffAtMs: this.lastDurableHandoffAtMs,
        nextDurableHandoffAtMs: this.nextDurableHandoffAtMs,
      };
    } catch (error) {
      this.metrics.durabilityHandoffFailures += 1;
      this._markPersistenceFailure(error && (error.code || error.message));
      return {
        success: false,
        errorMsg: error && (error.code || error.message) || "X_EVE_DURABLE_HANDOFF_FAILED",
      };
    } finally {
      const durationMs = Math.max(0, this.monotonicClock() - handoffStartedAt);
      this.metrics.lastDurabilityHandoffDurationMs = durationMs;
      this.metrics.maximumDurabilityHandoffDurationMs = Math.max(
        this.metrics.maximumDurabilityHandoffDurationMs,
        durationMs,
      );
    }
  }

  rebuildQueues(nowMs = this.clock()) {
    for (const queue of this.queues.values()) queue.clear();
    const orders = this._getStateStore().listWorkOrders();
    this.knownWorkOrderCount = orders.length;
    for (const persisted of orders) {
      if (!persisted) continue;
      let workOrder = persisted;
      if (this._getObservedEventReceipt(workOrder)) {
        this._cleanupObservedEventWork(workOrder);
        continue;
      }
      const completionReceipt = this._getStateStore().getReceipt(
        this._workReceiptID(workOrder.workOrderID),
      );
      if (completionReceipt) {
        if (completionReceipt.requestFingerprint !== workOrder.requestFingerprint) {
          this._markPersistenceFailure("X_EVE_WORK_RECEIPT_CONFLICT");
          throw Object.assign(new Error("X_EVE_WORK_RECEIPT_CONFLICT"), {
            code: "X_EVE_WORK_RECEIPT_CONFLICT",
          });
        }
        this._mustStateResult(
          this._getStateStore().removeWorkOrder(workOrder.workOrderID),
          "X_EVE_STALE_WORK_ORDER_REMOVE_FAILED",
        );
        continue;
      }
      if (workOrder.status === WORK_STATUS.RUNNING) {
        const retryCount = Math.max(0, Math.trunc(Number(workOrder.retryCount) || 0)) + 1;
        if (
          workOrder.retryForever !== true &&
          retryCount >= Math.max(1, toPositiveInt(
            workOrder.maxAttempts,
            this.options.maxRetryAttempts,
          ))
        ) {
          this._failWorkOrder(
            { ...workOrder, retryCount },
            nowMs,
            "X_EVE_INTERRUPTED_WORK_ATTEMPTS_EXHAUSTED",
          );
          continue;
        }
        workOrder = {
          ...workOrder,
          status: WORK_STATUS.RETRY,
          retryCount,
          dueAtMs: Math.max(0, Math.trunc(toFiniteNumber(nowMs, this.clock()))),
          updatedAtMs: Math.max(0, Math.trunc(toFiniteNumber(nowMs, this.clock()))),
          lastError: "X_EVE_INTERRUPTED_WORK_RECOVERED",
        };
        this._mustStateResult(
          this._getStateStore().saveWorkOrder(workOrder),
          "X_EVE_WORK_ORDER_RECOVERY_WRITE_FAILED",
        );
      }
      if (!ACTIVE_WORK_STATUSES.has(workOrder.status)) continue;
      const queue = this.queues.get(workOrder.workClass);
      if (queue) queue.schedule(workOrder.workOrderID, workOrder.dueAtMs, null);
    }
    return this.getBacklogByClass();
  }

  reconcileInbox(nowMs = this.clock()) {
    let scheduled = 0;
    const failures = [];
    for (const message of this._getStateStore().listInboxMessages()) {
      if (!message || message.status !== "received") continue;
      const eventReceipt = this._getStateStore().getReceipt(this._eventReceiptID(message.messageID));
      if (eventReceipt) {
        try {
          this._validateReceipt(eventReceipt);
          this._assertEventReceiptMatchesMessage(eventReceipt, message);
          this._mustStateResult(
            this._getStateStore().removeInboxMessage(message.messageID),
            "X_EVE_STALE_INBOX_REMOVE_FAILED",
          );
        } catch (error) {
          failures.push({
            messageID: message.messageID,
            errorMsg: error && (error.code || error.message) || "X_EVE_STALE_INBOX_REMOVE_FAILED",
          });
        }
        continue;
      }
      const result = this._ensureInboxWork(message, nowMs);
      if (!result || result.success !== true) {
        failures.push({
          messageID: message.messageID,
          errorMsg: result && result.errorMsg || "X_EVE_INBOX_WORK_FAILED",
        });
      } else if (result.replayed !== true) {
        scheduled += 1;
      }
    }
    return failures.length > 0
      ? { success: false, errorMsg: "X_EVE_INBOX_RECONCILE_FAILED", scheduled, failures }
      : { success: true, scheduled, failures: [] };
  }

  scheduleWork(raw = {}, scheduleOptions = {}) {
    try {
      const nowMs = Math.max(0, Math.trunc(toFiniteNumber(scheduleOptions.nowMs, this.clock())));
      const workOrderID = normalizeID(raw.workOrderID, "X_EVE_WORK_ORDER_ID_INVALID");
      const workClass = normalizeText(raw.workClass, WORK_CLASS.PLANNING).toLowerCase();
      if (!this.queues.has(workClass)) {
        return { success: false, errorMsg: "X_EVE_WORK_CLASS_INVALID" };
      }
      const handlerType = normalizeText(raw.handlerType).toLowerCase();
      if (!this.handlers.has(handlerType)) {
        return { success: false, errorMsg: "X_EVE_HANDLER_NOT_REGISTERED" };
      }
      if (this.quarantinedHandlers.has(handlerType)) {
        return {
          success: false,
          errorMsg: "X_EVE_HANDLER_QUARANTINED",
          details: { reason: this.quarantinedHandlers.get(handlerType) },
        };
      }
      if (handlerType === "observe_event" && scheduleOptions.internalInbox !== true) {
        return { success: false, errorMsg: "X_EVE_INTERNAL_HANDLER_RESERVED" };
      }
      const payload = cloneValue(raw.payload || {});
      if (!isPlainObject(payload)) {
        return { success: false, errorMsg: "X_EVE_WORK_PAYLOAD_INVALID" };
      }
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > this.options.maximumEventPayloadBytes) {
        return { success: false, errorMsg: "X_EVE_WORK_PAYLOAD_TOO_LARGE" };
      }
      const dueAtMs = Math.max(0, Math.trunc(toFiniteNumber(raw.dueAtMs, nowMs)));
      const retryForever = raw.retryForever === true && [
        WORK_CLASS.SETTLEMENT,
        WORK_CLASS.DEADLINE,
      ].includes(workClass);
      const maxAttempts = retryForever
        ? null
        : Math.max(1, toPositiveInt(raw.maxAttempts, this.options.maxRetryAttempts));
      const request = {
        workOrderID,
        workClass,
        handlerType,
        dueAtMs,
        retryForever,
        maxAttempts,
        payload,
      };
      const requestFingerprint = fingerprint(request);
      if (workOrderID.startsWith("inbox:") && handlerType !== "observe_event") {
        return { success: false, errorMsg: "X_EVE_INTERNAL_ID_NAMESPACE_RESERVED" };
      }
      const completedReceipt = this._getStateStore().getReceipt(
        this._workReceiptID(workOrderID),
      );
      if (completedReceipt) {
        if (completedReceipt.requestFingerprint !== requestFingerprint) {
          return { success: false, errorMsg: "X_EVE_WORK_ORDER_CONFLICT" };
        }
        if (scheduleOptions.durable === true) {
          const flushResult = this._getStateStore().flushDurably();
          if (!flushResult || flushResult.success !== true) {
            this._markPersistenceFailure(flushResult && flushResult.errorMsg);
            return { success: false, uncertain: true, errorMsg: "X_EVE_DURABLE_REPLAY_FAILED" };
          }
        }
        return { success: true, replayed: true, data: cloneValue(completedReceipt) };
      }
      const existing = this._getStateStore().getWorkOrder(workOrderID);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          return { success: false, errorMsg: "X_EVE_WORK_ORDER_CONFLICT" };
        }
        if (scheduleOptions.durable === true) {
          const flushResult = this._getStateStore().flushDurably();
          if (!flushResult || flushResult.success !== true) {
            this._markPersistenceFailure(flushResult && flushResult.errorMsg);
            return { success: false, uncertain: true, errorMsg: "X_EVE_DURABLE_REPLAY_FAILED" };
          }
        }
        return { success: true, replayed: true, data: cloneValue(existing) };
      }
      const workOrder = {
        schemaVersion: 1,
        workOrderID,
        workClass,
        handlerType,
        request: cloneValue(request),
        requestFingerprint,
        status: WORK_STATUS.QUEUED,
        requestedDueAtMs: dueAtMs,
        dueAtMs,
        payload,
        retryForever,
        maxAttempts,
        retryCount: 0,
        lastError: null,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
        completedAtMs: 0,
      };
      this._mustStateResult(
        this._getStateStore().saveWorkOrder(workOrder),
        "X_EVE_WORK_ORDER_WRITE_FAILED",
      );
      this.queues.get(workClass).schedule(workOrderID, dueAtMs, null);
      this.knownWorkOrderCount += 1;
      if (scheduleOptions.durable === true) {
        const flushResult = this._getStateStore().flushDurably();
        if (!flushResult || flushResult.success !== true) {
          this._markPersistenceFailure(flushResult && flushResult.errorMsg);
          return {
            success: false,
            uncertain: true,
            errorMsg: flushResult && flushResult.errorMsg || "X_EVE_WORK_ORDER_FLUSH_FAILED",
            data: cloneValue(workOrder),
          };
        }
      }
      return { success: true, replayed: false, data: cloneValue(workOrder) };
    } catch (error) {
      if (error && error.code === "X_EVE_STATE_READ_FAILED") {
        this._markPersistenceFailure(error.code);
      }
      return { success: false, errorMsg: error.code || "X_EVE_WORK_ORDER_INVALID" };
    }
  }

  ingestEvent(raw = {}, ingestOptions = {}) {
    if (!this.started && ingestOptions.force !== true) {
      return { success: false, errorMsg: "X_EVE_RUNTIME_NOT_READY" };
    }
    if (!this.persistenceHealthy) {
      return {
        success: false,
        errorMsg: "X_EVE_PERSISTENCE_UNHEALTHY",
        details: { persistenceError: this.persistenceError },
      };
    }
    try {
      const source = normalizeSource(raw.source);
      const sourceEventID = normalizeID(raw.sourceEventID, "X_EVE_SOURCE_EVENT_ID_INVALID");
      const messageID = normalizeID(
        raw.messageID || `${source}:${sourceEventID}`,
        "X_EVE_MESSAGE_ID_INVALID",
      );
      const eventIdentity = `${source}:${sourceEventID}`;
      const existingIdentityMessageID = this.eventIdentityMessageIDs.get(eventIdentity);
      if (existingIdentityMessageID && existingIdentityMessageID !== messageID) {
        this.metrics.eventConflicts += 1;
        return { success: false, errorMsg: "X_EVE_EVENT_IDENTITY_CONFLICT" };
      }
      const occurredAtMs = Math.max(0, Math.trunc(toFiniteNumber(raw.occurredAtMs, this.clock())));
      const payload = cloneValue(raw.payload || {});
      if (!isPlainObject(payload)) {
        return { success: false, errorMsg: "X_EVE_EVENT_PAYLOAD_INVALID" };
      }
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > this.options.maximumEventPayloadBytes) {
        return { success: false, errorMsg: "X_EVE_EVENT_PAYLOAD_TOO_LARGE" };
      }
      const request = {
        source,
        sourceEventID,
        eventType: normalizeText(raw.eventType, "event").toLowerCase(),
        version: Math.max(1, toPositiveInt(raw.version, 1)),
        occurredAtMs,
        payload,
      };
      const requestFingerprint = fingerprint(request);
      const observedReceipt = this._getStateStore().getReceipt(this._eventReceiptID(messageID));
      if (observedReceipt) {
        if (observedReceipt.requestFingerprint !== requestFingerprint) {
          this.metrics.eventConflicts += 1;
          return { success: false, errorMsg: "X_EVE_EVENT_CONFLICT" };
        }
        if (ingestOptions.durable === true) {
          const flushResult = this._getStateStore().flushDurably();
          if (!flushResult || flushResult.success !== true) {
            this._markPersistenceFailure(flushResult && flushResult.errorMsg);
            return { success: false, uncertain: true, errorMsg: "X_EVE_DURABLE_REPLAY_FAILED" };
          }
        }
        this.metrics.duplicateEvents += 1;
        return { success: true, replayed: true, data: cloneValue(observedReceipt) };
      }
      const existing = this._getStateStore().getInboxMessage(messageID);
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint) {
          this.metrics.eventConflicts += 1;
          return { success: false, errorMsg: "X_EVE_EVENT_CONFLICT" };
        }
        const workResult = this._ensureInboxWork(existing, ingestOptions.nowMs);
        if (!workResult || workResult.success !== true) return workResult;
        if (ingestOptions.durable === true) {
          const flushResult = this._getStateStore().flushDurably();
          if (!flushResult || flushResult.success !== true) {
            this._markPersistenceFailure(flushResult && flushResult.errorMsg);
            return { success: false, uncertain: true, errorMsg: "X_EVE_DURABLE_REPLAY_FAILED" };
          }
        }
        this.metrics.duplicateEvents += 1;
        return { success: true, replayed: true, data: cloneValue(existing) };
      }
      const nowMs = Math.max(0, Math.trunc(toFiniteNumber(ingestOptions.nowMs, this.clock())));
      const message = {
        schemaVersion: 1,
        messageID,
        source,
        sourceEventID,
        eventType: normalizeText(raw.eventType, "event").toLowerCase(),
        version: Math.max(1, toPositiveInt(raw.version, 1)),
        request: cloneValue(request),
        requestFingerprint,
        status: "received",
        occurredAtMs,
        receivedAtMs: nowMs,
        observedAtMs: 0,
        payload,
      };
      this._mustStateResult(
        this._getStateStore().saveInboxMessage(message),
        "X_EVE_INBOX_WRITE_FAILED",
      );
      this.eventIdentityMessageIDs.set(eventIdentity, messageID);
      const workResult = this._ensureInboxWork(message, nowMs);
      if (!workResult || workResult.success !== true) return workResult;
      if (ingestOptions.durable === true) {
        const flushResult = this._getStateStore().flushDurably();
        if (!flushResult || flushResult.success !== true) {
          this._markPersistenceFailure(flushResult && flushResult.errorMsg);
          return {
            success: false,
            uncertain: true,
            errorMsg: flushResult && flushResult.errorMsg || "X_EVE_EVENT_FLUSH_FAILED",
            data: cloneValue(message),
          };
        }
      }
      this.metrics.receivedEvents += 1;
      return { success: true, replayed: false, data: cloneValue(message) };
    } catch (error) {
      if (error && error.code === "X_EVE_STATE_READ_FAILED") {
        this._markPersistenceFailure(error.code);
      }
      return { success: false, errorMsg: error.code || "X_EVE_EVENT_INVALID" };
    }
  }

  _ensureInboxWork(message, nowMs = this.clock()) {
    const messageID = normalizeID(message && message.messageID, "X_EVE_MESSAGE_ID_INVALID");
    const stableDueAtMs = Math.max(
      0,
      Math.trunc(toFiniteNumber(message && message.receivedAtMs, nowMs)),
    );
    return this.scheduleWork({
      workOrderID: this._receiptID("inbox", messageID),
      workClass: WORK_CLASS.MAINTENANCE,
      handlerType: "observe_event",
      dueAtMs: stableDueAtMs,
      payload: { messageID },
    }, { nowMs, durable: false, internalInbox: true });
  }

  _getTickSummaries(override) {
    if (Array.isArray(override)) return override;
    if (
      this.spaceRuntime &&
      typeof this.spaceRuntime.getRecentRuntimeTickSummaries === "function"
    ) {
      return this.spaceRuntime.getRecentRuntimeTickSummaries(this.options.tickSampleCount);
    }
    return [];
  }

  _nextDueClass(nowMs, allowedClasses) {
    for (let offset = 0; offset < WORK_CLASS_ORDER.length; offset += 1) {
      const index = (this.queueCursor + offset) % WORK_CLASS_ORDER.length;
      const workClass = WORK_CLASS_ORDER[index];
      if (!allowedClasses.has(workClass)) continue;
      const queue = this.queues.get(workClass);
      const head = queue && queue.peek();
      if (head && head.dueAtMs <= nowMs) {
        this.queueCursor = (index + 1) % WORK_CLASS_ORDER.length;
        return workClass;
      }
    }
    return null;
  }

  runDueWork(nowMs = this.clock(), runOptions = {}) {
    const normalizedNowMs = Math.max(0, Math.trunc(toFiniteNumber(nowMs, this.clock())));
    if (this.passRunning) {
      return { success: false, errorMsg: "X_EVE_SCHEDULER_BUSY", data: this.getSnapshot() };
    }
    if (!this.persistenceHealthy) {
      return {
        success: false,
        errorMsg: "X_EVE_PERSISTENCE_UNHEALTHY",
        details: { persistenceError: this.persistenceError },
        data: this.getSnapshot(),
      };
    }
    const policy = runOptions.policy || this.governor.evaluate(
      this._getTickSummaries(runOptions.tickSummaries),
      normalizedNowMs,
    );
    const allowedClasses = new Set(policy.allowedWorkClasses || []);
    const maxJobs = Math.max(
      0,
      Math.min(
        this.options.maxJobsPerPass,
        Math.trunc(toFiniteNumber(runOptions.maxJobs, policy.maxJobs)),
      ),
    );
    const budgetMs = Math.max(
      0,
      Math.min(this.options.schedulerBudgetMs, toFiniteNumber(runOptions.budgetMs, policy.budgetMs)),
    );
    const startedAt = this.monotonicClock();
    let visitedJobs = 0;
    let processedJobs = 0;
    let completedJobs = 0;
    let retriedJobs = 0;
    let failedJobs = 0;
    let passError = null;
    this.passRunning = true;
    try {
      while (visitedJobs < maxJobs) {
        if (this.monotonicClock() - startedAt >= budgetMs) break;
        const workClass = this._nextDueClass(normalizedNowMs, allowedClasses);
        if (!workClass) break;
        const queue = this.queues.get(workClass);
        const due = queue.popDue(normalizedNowMs);
        if (!due) break;
        visitedJobs += 1;
        this.metrics.visitedJobs += 1;
        let workOrder = null;
        try {
          workOrder = this._getStateStore().getWorkOrder(due.key);
        } catch (error) {
          this._markPersistenceFailure(error && error.code);
          queue.schedule(due.key, due.dueAtMs, null);
          passError = error;
          break;
        }
        if (!workOrder || !ACTIVE_WORK_STATUSES.has(workOrder.status)) continue;
        try {
          if (this._getObservedEventReceipt(workOrder)) {
            this._cleanupObservedEventWork(workOrder);
            continue;
          }
          const completionReceipt = this._getStateStore().getReceipt(
            this._workReceiptID(workOrder.workOrderID),
          );
          if (completionReceipt) {
            if (completionReceipt.requestFingerprint !== workOrder.requestFingerprint) {
              throw Object.assign(new Error("X_EVE_WORK_RECEIPT_CONFLICT"), {
                code: "X_EVE_WORK_RECEIPT_CONFLICT",
              });
            }
            this._mustStateResult(
              this._getStateStore().removeWorkOrder(workOrder.workOrderID),
              "X_EVE_STALE_WORK_ORDER_REMOVE_FAILED",
            );
            continue;
          }
        } catch (error) {
          this._markPersistenceFailure(error && (error.code || error.message));
          queue.schedule(workOrder.workOrderID, workOrder.dueAtMs, null);
          passError = error;
          break;
        }
        const quarantineReason = this.quarantinedHandlers.get(workOrder.handlerType);
        if (quarantineReason) {
          try {
            this._failWorkOrder(workOrder, normalizedNowMs, "X_EVE_HANDLER_QUARANTINED");
            this.metrics.failedJobs += 1;
            this.metrics.deadLetterJobs += 1;
            failedJobs += 1;
          } catch (error) {
            queue.schedule(workOrder.workOrderID, workOrder.dueAtMs, null);
            passError = error;
            break;
          }
          processedJobs += 1;
          this.metrics.processedJobs += 1;
          continue;
        }
        const handlerBackoffUntilMs = Math.max(
          0,
          Math.trunc(toFiniteNumber(this.handlerBackoffUntilMs.get(workOrder.handlerType), 0)),
        );
        if (handlerBackoffUntilMs > normalizedNowMs) {
          const deferred = {
            ...workOrder,
            dueAtMs: handlerBackoffUntilMs,
            updatedAtMs: normalizedNowMs,
            lastError: "X_EVE_SLOW_HANDLER_BACKOFF",
          };
          try {
            this._mustStateResult(
              this._getStateStore().saveWorkOrder(deferred),
              "X_EVE_WORK_ORDER_BACKOFF_WRITE_FAILED",
            );
          } catch (error) {
            queue.schedule(workOrder.workOrderID, workOrder.dueAtMs, null);
            passError = error;
            break;
          }
          queue.schedule(deferred.workOrderID, deferred.dueAtMs, null);
          continue;
        }
        const handler = this.handlers.get(workOrder.handlerType);
        if (!handler) {
          try {
            this._failWorkOrder(workOrder, normalizedNowMs, "X_EVE_HANDLER_NOT_REGISTERED");
            this.metrics.failedJobs += 1;
            this.metrics.deadLetterJobs += 1;
            failedJobs += 1;
          } catch (error) {
            queue.schedule(workOrder.workOrderID, workOrder.dueAtMs, null);
            passError = error;
            break;
          }
          processedJobs += 1;
          this.metrics.processedJobs += 1;
          continue;
        }
        const running = {
          ...workOrder,
          status: WORK_STATUS.RUNNING,
          startedAtMs: normalizedNowMs,
          updatedAtMs: normalizedNowMs,
        };
        try {
          this._mustStateResult(
            this._getStateStore().saveWorkOrder(running),
            "X_EVE_WORK_ORDER_RUNNING_WRITE_FAILED",
          );
        } catch (error) {
          queue.schedule(workOrder.workOrderID, workOrder.dueAtMs, null);
          passError = error;
          break;
        }
        const handlerStartedAt = this.monotonicClock();
        let handlerEffectCommitted = false;
        try {
          const effectID = this._workReceiptID(workOrder.workOrderID);
          const handlerScope = this._createHandlerLedgerScope(
            effectID,
            workOrder.requestedDueAtMs,
          );
          let result;
          try {
            result = handler({
              ledger: handlerScope.ledger,
              effectID,
              workOrder: cloneValue(running),
              nowMs: normalizedNowMs,
              policy: cloneValue(policy),
            });
          } finally {
            handlerEffectCommitted = handlerScope.monetaryMutationCommitted();
            handlerScope.close();
          }
          let thenMethod = null;
          try {
            thenMethod = result == null ? null : result.then;
          } catch (error) {
            throw Object.assign(runtimeError("X_EVE_ASYNC_HANDLER_UNCERTAIN"), {
              noRetry: true,
              cause: error,
            });
          }
          if (typeof thenMethod === "function") {
            try {
              Promise.resolve(result).catch(() => {});
            } catch (_error) {
              // The work is already treated as uncertain and is never retried.
            }
            throw Object.assign(runtimeError("X_EVE_ASYNC_HANDLER_UNCERTAIN"), {
              noRetry: true,
            });
          }
          if (result && result.success === false) {
            throw Object.assign(
              new Error(result.errorMsg || "X_EVE_HANDLER_REJECTED"),
              { code: result.errorMsg || "X_EVE_HANDLER_REJECTED" },
            );
          }
          if (result && Number.isFinite(Number(result.rescheduleAtMs))) {
            if (handlerScope.monetaryMutationCommitted()) {
              throw Object.assign(
                runtimeError("X_EVE_HANDLER_EFFECT_WITH_RESCHEDULE", { effectID }),
                { noRetry: true },
              );
            }
            const nextDueAtMs = Math.max(normalizedNowMs + 1, Math.trunc(Number(result.rescheduleAtMs)));
            const queued = {
              ...running,
              status: WORK_STATUS.QUEUED,
              dueAtMs: nextDueAtMs,
              updatedAtMs: normalizedNowMs,
              lastError: null,
            };
            this._mustStateResult(
              this._getStateStore().saveWorkOrder(queued),
              "X_EVE_WORK_ORDER_RESCHEDULE_WRITE_FAILED",
            );
            queue.schedule(queued.workOrderID, queued.dueAtMs, null);
          } else {
            this._completeWorkOrder(running, normalizedNowMs, result && result.data || null);
            completedJobs += 1;
            this.metrics.completedJobs += 1;
          }
        } catch (error) {
          if (error && error.noRetry === true) {
            const errorCode = error.code || "X_EVE_HANDLER_OUTCOME_UNCERTAIN";
            try {
              this._quarantineWorkOrder(running, normalizedNowMs, errorCode);
              if (!this.quarantinedHandlers.has(workOrder.handlerType)) {
                this.metrics.quarantinedHandlers += 1;
              }
              this.quarantinedHandlers.set(workOrder.handlerType, errorCode);
              this.metrics.quarantinedJobs += 1;
              this.metrics.uncertainJobs += 1;
              this.metrics.failedJobs += 1;
              failedJobs += 1;
              const quarantineFlush = this.flushDurably();
              if (!quarantineFlush || quarantineFlush.success !== true) {
                passError = runtimeError("X_EVE_QUARANTINE_FLUSH_FAILED");
              }
            } catch (writeError) {
              this._markPersistenceFailure(writeError && (writeError.code || writeError.message));
              passError = writeError;
            }
          } else if (!this.persistenceHealthy) {
            queue.schedule(workOrder.workOrderID, workOrder.dueAtMs, null);
            passError = error;
          } else {
            const retryCount = Math.max(0, Math.trunc(Number(workOrder.retryCount) || 0)) + 1;
            const maximumAttempts = workOrder.retryForever === true
              ? Number.POSITIVE_INFINITY
              : Math.max(1, toPositiveInt(workOrder.maxAttempts, this.options.maxRetryAttempts));
            if (retryCount >= maximumAttempts) {
              try {
                if (handlerEffectCommitted) {
                  const errorCode = "X_EVE_HANDLER_POST_EFFECT_TERMINAL_FAILURE";
                  this._quarantineWorkOrder(
                    { ...running, retryCount },
                    normalizedNowMs,
                    errorCode,
                  );
                  if (!this.quarantinedHandlers.has(workOrder.handlerType)) {
                    this.metrics.quarantinedHandlers += 1;
                  }
                  this.quarantinedHandlers.set(workOrder.handlerType, errorCode);
                  this.metrics.quarantinedJobs += 1;
                  this.metrics.uncertainJobs += 1;
                  const quarantineFlush = this.flushDurably();
                  if (!quarantineFlush || quarantineFlush.success !== true) {
                    passError = runtimeError("X_EVE_QUARANTINE_FLUSH_FAILED");
                  }
                } else {
                  this._failWorkOrder(
                    { ...running, retryCount },
                    normalizedNowMs,
                    error && (error.code || error.message) || "X_EVE_HANDLER_FAILED",
                  );
                  this.metrics.deadLetterJobs += 1;
                }
                failedJobs += 1;
                this.metrics.failedJobs += 1;
              } catch (writeError) {
                queue.schedule(workOrder.workOrderID, workOrder.dueAtMs, null);
                passError = writeError;
              }
            } else {
              const delayMs = Math.min(
                300_000,
                this.options.retryBaseDelayMs * (2 ** Math.min(6, retryCount - 1)),
              );
              const retry = {
                ...running,
                status: WORK_STATUS.RETRY,
                retryCount,
                dueAtMs: normalizedNowMs + delayMs,
                updatedAtMs: normalizedNowMs,
                lastError: error && (error.code || error.message) || "X_EVE_HANDLER_FAILED",
              };
              try {
                this._mustStateResult(
                  this._getStateStore().saveWorkOrder(retry),
                  "X_EVE_WORK_ORDER_RETRY_WRITE_FAILED",
                );
                queue.schedule(retry.workOrderID, retry.dueAtMs, null);
                retriedJobs += 1;
                this.metrics.retriedJobs += 1;
              } catch (writeError) {
                queue.schedule(workOrder.workOrderID, workOrder.dueAtMs, null);
                passError = writeError;
              }
            }
          }
        }
        const handlerDurationMs = Math.max(0, this.monotonicClock() - handlerStartedAt);
        this.metrics.maximumHandlerDurationMs = Math.max(
          this.metrics.maximumHandlerDurationMs,
          handlerDurationMs,
        );
        const handlerContract = this.handlerContracts.get(workOrder.handlerType);
        const handlerBudgetExceeded = Boolean(
          handlerContract && handlerDurationMs > handlerContract.sliceBudgetMs,
        );
        if (handlerBudgetExceeded) {
          this.metrics.handlerBudgetOverruns += 1;
        }
        if (handlerDurationMs > this.options.slowHandlerMs) {
          this.metrics.slowHandlers += 1;
          this.handlerBackoffUntilMs.set(
            workOrder.handlerType,
            normalizedNowMs + Math.min(
              this.options.retryBaseDelayMs,
              this.options.schedulerIntervalMs,
            ),
          );
        }
        let durationQuarantineReason = null;
        if (handlerDurationMs >= this.options.unplayableMs) {
          this.metrics.unplayableHandlerTrips += 1;
          durationQuarantineReason = "X_EVE_HANDLER_UNPLAYABLE_DURATION";
        }
        if (
          durationQuarantineReason &&
          !this.quarantinedHandlers.has(workOrder.handlerType)
        ) {
          try {
            this._persistHandlerQuarantine(
              workOrder.handlerType,
              durationQuarantineReason,
              normalizedNowMs,
              handlerDurationMs,
            );
            this.quarantinedHandlers.set(workOrder.handlerType, durationQuarantineReason);
            this.metrics.quarantinedHandlers += 1;
            const quarantineFlush = this.flushDurably();
            if (!quarantineFlush || quarantineFlush.success !== true) {
              passError = runtimeError("X_EVE_QUARANTINE_FLUSH_FAILED");
            }
          } catch (error) {
            this._markPersistenceFailure(error && (error.code || error.message));
            passError = error;
          }
        }
        processedJobs += 1;
        this.metrics.processedJobs += 1;
        if (passError) break;
      }
    } finally {
      this.passRunning = false;
      const durationMs = Math.max(0, this.monotonicClock() - startedAt);
      this.metrics.schedulerPasses += 1;
      this.metrics.lastPassAtMs = normalizedNowMs;
      this.metrics.lastPassDurationMs = durationMs;
      this.metrics.maximumPassDurationMs = Math.max(this.metrics.maximumPassDurationMs, durationMs);
      if (maxJobs === 0 || budgetMs === 0) this.metrics.shedPasses += 1;
      const dueButBlocked = this._countDueButBlocked(normalizedNowMs, allowedClasses);
      this.metrics.deferredJobs += dueButBlocked;
    }
    if (passError) {
      return {
        success: false,
        errorMsg: passError.code || "X_EVE_SCHEDULER_PASS_FAILED",
        details: { persistenceError: this.persistenceError },
        data: {
          mode: policy.mode,
          visitedJobs,
          processedJobs,
          completedJobs,
          retriedJobs,
          failedJobs,
          durationMs: this.metrics.lastPassDurationMs,
          backlogByClass: this.getBacklogByClass(),
        },
      };
    }
    return {
      success: true,
      data: {
        mode: policy.mode,
        visitedJobs,
        processedJobs,
        completedJobs,
        retriedJobs,
        failedJobs,
        deferredJobs: this._countDueButBlocked(normalizedNowMs, allowedClasses),
        durationMs: this.metrics.lastPassDurationMs,
        backlogByClass: this.getBacklogByClass(),
      },
    };
  }

  _completeWorkOrder(workOrder, nowMs, result) {
    if (workOrder.handlerType === "observe_event") {
      if (!this._getObservedEventReceipt(workOrder)) {
        throw Object.assign(new Error("X_EVE_EVENT_RECEIPT_MISSING"), {
          code: "X_EVE_EVENT_RECEIPT_MISSING",
        });
      }
      this._mustStateResult(
        this._getStateStore().removeWorkOrder(workOrder.workOrderID),
        "X_EVE_WORK_ORDER_REMOVE_FAILED",
      );
      return;
    }
    this._mustStateResult(this._getStateStore().saveReceipt({
      schemaVersion: 1,
      operationID: this._workReceiptID(workOrder.workOrderID),
      receiptType: "work_order",
      status: "completed",
      workOrderID: workOrder.workOrderID,
      workClass: workOrder.workClass,
      handlerType: workOrder.handlerType,
      request: cloneValue(workOrder.request),
      requestFingerprint: workOrder.requestFingerprint,
      effectID: this._workReceiptID(workOrder.workOrderID),
      completedAtMs: nowMs,
      result: cloneValue(result),
    }), "X_EVE_WORK_RECEIPT_WRITE_FAILED");
    this._mustStateResult(
      this._getStateStore().removeWorkOrder(workOrder.workOrderID),
      "X_EVE_WORK_ORDER_REMOVE_FAILED",
    );
  }

  _failWorkOrder(workOrder, nowMs, errorCode) {
    this._mustStateResult(this._getStateStore().saveWorkOrder({
      ...workOrder,
      status: WORK_STATUS.FAILED,
      updatedAtMs: nowMs,
      failedAtMs: nowMs,
      lastError: errorCode,
    }), "X_EVE_WORK_ORDER_FAILURE_WRITE_FAILED");
  }

  _quarantineWorkOrder(workOrder, nowMs, errorCode) {
    this._mustStateResult(this._getStateStore().saveWorkOrder({
      ...workOrder,
      status: WORK_STATUS.QUARANTINED,
      uncertainOutcome: true,
      quarantinedAtMs: nowMs,
      updatedAtMs: nowMs,
      lastError: errorCode,
    }), "X_EVE_WORK_ORDER_QUARANTINE_WRITE_FAILED");
  }

  _countDueButBlocked(nowMs, allowedClasses) {
    let count = 0;
    for (const [workClass, queue] of this.queues) {
      if (allowedClasses.has(workClass)) continue;
      const head = queue.peek();
      if (head && head.dueAtMs <= nowMs) count += 1;
    }
    return count;
  }

  getBacklogByClass() {
    return Object.fromEntries(WORK_CLASS_ORDER.map((workClass) => [
      workClass,
      this.queues.get(workClass).size,
    ]));
  }

  getBacklogTiming(nowMs = this.clock()) {
    const now = Math.max(0, Math.trunc(toFiniteNumber(nowMs, this.clock())));
    const heads = [...this.queues.values()]
      .map((queue) => queue.peek())
      .filter(Boolean);
    const oldestDueAtMs = heads.length > 0
      ? Math.min(...heads.map((head) => head.dueAtMs))
      : 0;
    return {
      oldestDueAtMs,
      oldestOverdueMs: oldestDueAtMs > 0 ? Math.max(0, now - oldestDueAtMs) : 0,
    };
  }

  flushDurably() {
    const result = this._getStateStore().flushDurably();
    if (!result || result.success !== true) {
      this._markPersistenceFailure(result && result.errorMsg);
      return result || { success: false, errorMsg: "X_EVE_FLUSH_FAILED" };
    }
    const nowMs = Math.max(0, Math.trunc(toFiniteNumber(this.clock(), Date.now())));
    this.lastDurableHandoffAtMs = nowMs;
    this.nextDurableHandoffAtMs = nowMs + this.options.durabilityIntervalMs;
    return result;
  }

  recoverPersistence() {
    if (!this.started) {
      return { success: false, errorMsg: "X_EVE_RUNTIME_NOT_READY" };
    }
    try {
      const ledgerRecovery = this._getLedger().recover();
      if (!ledgerRecovery || ledgerRecovery.success !== true) {
        this._markPersistenceFailure(
          ledgerRecovery && ledgerRecovery.errorMsg || "X_EVE_LEDGER_RECOVERY_FAILED",
        );
        return ledgerRecovery || { success: false, errorMsg: "X_EVE_LEDGER_RECOVERY_FAILED" };
      }
      const stateAudit = this.auditRuntimeState();
      if (!stateAudit || stateAudit.success !== true) return stateAudit;
      this.rebuildQueues(this.clock());
      const inboxRecovery = this.reconcileInbox(this.clock());
      if (!inboxRecovery || inboxRecovery.success !== true) {
        this._markPersistenceFailure(
          inboxRecovery && inboxRecovery.errorMsg || "X_EVE_INBOX_RECONCILE_FAILED",
        );
        return inboxRecovery || { success: false, errorMsg: "X_EVE_INBOX_RECONCILE_FAILED" };
      }
      const postRecoveryAudit = this.auditRuntimeState();
      if (!postRecoveryAudit || postRecoveryAudit.success !== true) return postRecoveryAudit;
      const flushResult = this._getStateStore().flushDurably();
      if (!flushResult || flushResult.success !== true) {
        this._markPersistenceFailure(
          flushResult && flushResult.errorMsg || "X_EVE_RECOVERY_FLUSH_FAILED",
        );
        return flushResult || { success: false, errorMsg: "X_EVE_RECOVERY_FLUSH_FAILED" };
      }
      this.persistenceHealthy = true;
      this.persistenceError = null;
      const nowMs = Math.max(0, Math.trunc(toFiniteNumber(this.clock(), Date.now())));
      this.lastDurableHandoffAtMs = nowMs;
      this.nextDurableHandoffAtMs = nowMs + this.options.durabilityIntervalMs;
      return { success: true, data: this.getSnapshot() };
    } catch (error) {
      const errorMsg = error && (error.code || error.message) || "X_EVE_PERSISTENCE_RECOVERY_FAILED";
      this._markPersistenceFailure(errorMsg);
      return { success: false, errorMsg, details: error && error.details || {} };
    }
  }

  getSnapshot() {
    const backlogByClass = this.getBacklogByClass();
    const backlogTotal = Object.values(backlogByClass).reduce((sum, value) => sum + value, 0);
    const backlogTiming = this.getBacklogTiming();
    const observation = getObservationSnapshot(this.observation);
    observation.rebuild = {
      receiptRows: this.observationReceiptRows,
      durationMs: this.observationRebuildDurationMs,
    };
    return {
      enabled: this.options.enabled,
      started: this.started,
      scheduler: {
        intervalMs: this.options.schedulerIntervalMs,
        durabilityIntervalMs: this.options.durabilityIntervalMs,
        lastDurableHandoffAtMs: this.lastDurableHandoffAtMs,
        nextDurableHandoffAtMs: this.nextDurableHandoffAtMs,
        configuredBudgetMs: this.options.schedulerBudgetMs,
        configuredMaxJobsPerPass: this.options.maxJobsPerPass,
        passRunning: this.passRunning,
        mode: this.governor.mode,
        persistenceHealthy: this.persistenceHealthy,
        persistenceError: this.persistenceError,
        quarantinedHandlerTypes: [...this.quarantinedHandlers.keys()].sort(),
        backlogTotal,
        backlogByClass,
        ...backlogTiming,
        acceptedWorkOrdersSinceStart: this.knownWorkOrderCount,
        metrics: { ...this.metrics },
        governor: this.governor.getStatus(),
      },
      ledger: this.ledger ? this.ledger.getStatus() : null,
      observation,
    };
  }
}

let defaultRuntime = null;
function getDefaultRuntime() {
  if (!defaultRuntime) defaultRuntime = new XEveRuntime();
  return defaultRuntime;
}

module.exports = {
  MODE,
  WORK_CLASS,
  WORK_STATUS,
  XEveRuntime,
  buildDefaultRuntimeOptions,
  getDefaultRuntime,
  ingestEvent: (...args) => getDefaultRuntime().ingestEvent(...args),
  getSnapshot: (...args) => getDefaultRuntime().getSnapshot(...args),
  flushDurably: (...args) => getDefaultRuntime().flushDurably(...args),
  recoverPersistence: (...args) => getDefaultRuntime().recoverPersistence(...args),
  runDueWork: (...args) => getDefaultRuntime().runDueWork(...args),
  start: (...args) => getDefaultRuntime().start(...args),
  stop: (...args) => getDefaultRuntime().stop(...args),
};
