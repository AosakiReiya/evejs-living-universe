"use strict";

const path = require("path");

const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));

const TABLE_NAME = "xEveRuntime";
const SCHEMA_VERSION = 1;
const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

class XEveStateError extends Error {
  constructor(code, message = code, details = null) {
    super(message);
    this.name = "XEveStateError";
    this.code = code;
    this.details = details;
  }
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeRecordID(value, errorCode = "X_EVE_RECORD_ID_INVALID") {
  const normalized = String(value == null ? "" : value).trim();
  if (!SAFE_RECORD_ID.test(normalized)) {
    const error = new Error(errorCode);
    error.code = errorCode;
    throw error;
  }
  return normalized;
}

function normalizeNowMs(value = Date.now()) {
  const numeric = Number(value);
  return Math.max(0, Math.trunc(Number.isFinite(numeric) ? numeric : Date.now()));
}

function buildDefaultMeta(nowMs = Date.now()) {
  const normalizedNowMs = normalizeNowMs(nowMs);
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAtMs: normalizedNowMs,
    updatedAtMs: normalizedNowMs,
  };
}

function createStateStore(options = {}) {
  const repo = options.repo || createTableRepository("service:x-eve", { strict: true });
  const validatedCollections = new Set();
  let persistencePolicyConfigured = false;

  function ensurePersistencePolicy() {
    if (persistencePolicyConfigured) return;
    if (typeof repo.setTableAutoFlush === "function") {
      const result = repo.setTableAutoFlush(TABLE_NAME, false);
      if (result && result.success === false) {
        throw new XEveStateError(
          "X_EVE_PERSISTENCE_POLICY_FAILED",
          "X-Eve could not disable its unordered debounce flush",
          { storeError: result.errorMsg || "UNKNOWN" },
        );
      }
    }
    persistencePolicyConfigured = true;
  }

  function readPath(pathArg, fallback = null) {
    const result = repo.read(TABLE_NAME, pathArg);
    if (result && result.success === true) {
      return result.data == null ? cloneValue(fallback) : cloneValue(result.data);
    }
    if (result && result.errorMsg === "ENTRY_NOT_FOUND") {
      return cloneValue(fallback);
    }
    throw new XEveStateError(
      "X_EVE_STATE_READ_FAILED",
      `X-Eve state read failed at ${pathArg}: ${result && result.errorMsg || "UNKNOWN"}`,
      { path: pathArg, storeError: result && result.errorMsg || "UNKNOWN" },
    );
  }

  function writePath(pathArg, value, writeOptions = {}) {
    ensurePersistencePolicy();
    return repo.write(TABLE_NAME, pathArg, cloneValue(value), writeOptions);
  }

  function ensureInitialized(nowMs = Date.now()) {
    ensurePersistencePolicy();
    repo.ensureTable(TABLE_NAME);
    const existing = readPath("/meta", null);
    if (existing !== null && (typeof existing !== "object" || Array.isArray(existing))) {
      throw new XEveStateError(
        "X_EVE_STATE_SHAPE_INVALID",
        "X-Eve meta row is not an object",
        { path: "/meta" },
      );
    }
    if (existing && typeof existing === "object") {
      const meta = {
        ...buildDefaultMeta(nowMs),
        ...existing,
        schemaVersion: SCHEMA_VERSION,
      };
      return { success: true, data: meta };
    }
    const meta = buildDefaultMeta(nowMs);
    const result = writePath("/meta", meta);
    return result && result.success === true
      ? { success: true, data: meta }
      : result;
  }

  function getMeta() {
    const meta = readPath("/meta", null);
    if (meta !== null && (typeof meta !== "object" || Array.isArray(meta))) {
      throw new XEveStateError(
        "X_EVE_STATE_SHAPE_INVALID",
        "X-Eve meta row is not an object",
        { path: "/meta" },
      );
    }
    return meta;
  }

  function saveMeta(meta) {
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
      throw new XEveStateError(
        "X_EVE_STATE_SHAPE_INVALID",
        "X-Eve meta row must be an object",
        { path: "/meta" },
      );
    }
    return writePath("/meta", {
      ...buildDefaultMeta(meta && meta.createdAtMs),
      ...cloneValue(meta || {}),
      schemaVersion: SCHEMA_VERSION,
      updatedAtMs: normalizeNowMs(meta && meta.updatedAtMs),
    });
  }

  function createCollectionAccessors(group, idField, errorCode) {
    function invalidShape(pathArg, reason) {
      throw new XEveStateError(
        "X_EVE_STATE_SHAPE_INVALID",
        `X-Eve state shape is invalid at ${pathArg}: ${reason}`,
        { path: pathArg, group, reason },
      );
    }

    function validateContainer(container, pathArg = `/${group}`) {
      if (container === null || typeof container !== "object" || Array.isArray(container)) {
        invalidShape(pathArg, "collection must be an object");
      }
      return container;
    }

    function validateRecord(record, recordID, pathArg) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        invalidShape(pathArg, "record must be an object");
      }
      if (String(record[idField] == null ? "" : record[idField]) !== recordID) {
        invalidShape(pathArg, `${idField} does not match its collection key`);
      }
      return record;
    }

    function readContainer() {
      const pathArg = `/${group}`;
      const result = repo.read(TABLE_NAME, pathArg);
      if (result && result.success === true) {
        const container = validateContainer(result.data, pathArg);
        validatedCollections.add(group);
        return container;
      }
      if (result && result.errorMsg === "ENTRY_NOT_FOUND") {
        validatedCollections.add(group);
        return null;
      }
      throw new XEveStateError(
        "X_EVE_STATE_READ_FAILED",
        `X-Eve state read failed at ${pathArg}: ${result && result.errorMsg || "UNKNOWN"}`,
        { path: pathArg, storeError: result && result.errorMsg || "UNKNOWN" },
      );
    }

    function get(recordID) {
      const normalizedID = normalizeRecordID(recordID, errorCode);
      const pathArg = `/${group}/${normalizedID}`;
      const result = repo.read(TABLE_NAME, pathArg);
      if (result && result.success === true) {
        validatedCollections.add(group);
        return cloneValue(validateRecord(result.data, normalizedID, pathArg));
      }
      if (result && result.errorMsg === "ENTRY_NOT_FOUND") {
        // A missing child is valid only when its parent collection is absent or
        // a proper object. This distinguishes ordinary misses from a corrupt
        // scalar parent that the generic repository also reports as missing.
        if (!validatedCollections.has(group)) readContainer();
        return null;
      }
      throw new XEveStateError(
        "X_EVE_STATE_READ_FAILED",
        `X-Eve state read failed at ${pathArg}: ${result && result.errorMsg || "UNKNOWN"}`,
        { path: pathArg, storeError: result && result.errorMsg || "UNKNOWN" },
      );
    }

    function list() {
      const records = readContainer();
      if (records === null) return [];
      return Object.entries(records)
        .map(([recordID, record]) => cloneValue(validateRecord(
          record,
          normalizeRecordID(recordID, errorCode),
          `/${group}/${recordID}`,
        )))
        .sort((left, right) => String(left[idField]).localeCompare(String(right[idField])));
    }

    function save(record, writeOptions = {}) {
      const normalizedID = normalizeRecordID(record && record[idField], errorCode);
      if (!validatedCollections.has(group)) readContainer();
      return writePath(`/${group}/${normalizedID}`, {
        ...cloneValue(record),
        [idField]: normalizedID,
      }, writeOptions);
    }

    function remove(recordID) {
      const normalizedID = normalizeRecordID(recordID, errorCode);
      if (!validatedCollections.has(group)) readContainer();
      return repo.remove(TABLE_NAME, `/${group}/${normalizedID}`);
    }

    return { get, list, save, remove };
  }

  const accounts = createCollectionAccessors(
    "accountsByID",
    "accountID",
    "X_EVE_ACCOUNT_ID_INVALID",
  );
  const transactions = createCollectionAccessors(
    "transactionsByID",
    "transactionID",
    "X_EVE_TRANSACTION_ID_INVALID",
  );
  const inbox = createCollectionAccessors(
    "inboxByID",
    "messageID",
    "X_EVE_MESSAGE_ID_INVALID",
  );
  const outbox = createCollectionAccessors(
    "outboxByID",
    "operationID",
    "X_EVE_OPERATION_ID_INVALID",
  );
  const workOrders = createCollectionAccessors(
    "workOrdersByID",
    "workOrderID",
    "X_EVE_WORK_ORDER_ID_INVALID",
  );
  const receipts = createCollectionAccessors(
    "receiptsByOperationID",
    "operationID",
    "X_EVE_OPERATION_ID_INVALID",
  );
  const sourceEvents = createCollectionAccessors(
    "sourceEventsByID",
    "sourceEventID",
    "X_EVE_SOURCE_EVENT_ID_INVALID",
  );

  function flushDurably() {
    return repo.flushTableSync(TABLE_NAME);
  }

  function requestDurableHandoff() {
    if (typeof repo.flushTableAsync === "function") {
      return repo.flushTableAsync(TABLE_NAME);
    }
    // Injected repositories used by focused tests and migrations may predate
    // the asynchronous handoff API. A synchronous flush preserves the same
    // durability contract for those callers.
    return flushDurably();
  }

  function registerDurabilityPrerequisite(key, callback) {
    if (typeof repo.registerTableFlushPrerequisite !== "function") {
      return { success: false, errorMsg: "X_EVE_DURABILITY_PREREQUISITE_UNSUPPORTED" };
    }
    return repo.registerTableFlushPrerequisite(TABLE_NAME, key, callback);
  }

  function unregisterDurabilityPrerequisite(key) {
    if (typeof repo.unregisterTableFlushPrerequisite !== "function") {
      return { success: true, unsupported: true };
    }
    return repo.unregisterTableFlushPrerequisite(TABLE_NAME, key);
  }

  function suspendPersistence(reason) {
    if (typeof repo.suspendTableFlush !== "function") {
      return { success: true, suspended: false, unsupported: true };
    }
    return repo.suspendTableFlush(TABLE_NAME, reason);
  }

  function resumePersistence() {
    if (typeof repo.resumeTableFlush !== "function") {
      return { success: true, suspended: false, unsupported: true };
    }
    return repo.resumeTableFlush(TABLE_NAME);
  }

  return Object.freeze({
    TABLE_NAME,
    SCHEMA_VERSION,
    ensureInitialized,
    flushDurably,
    requestDurableHandoff,
    registerDurabilityPrerequisite,
    resumePersistence,
    suspendPersistence,
    unregisterDurabilityPrerequisite,
    getAccount: accounts.get,
    getInboxMessage: inbox.get,
    getMeta,
    getOutboxOperation: outbox.get,
    getReceipt: receipts.get,
    getSourceEvent: sourceEvents.get,
    getTransaction: transactions.get,
    getWorkOrder: workOrders.get,
    listAccounts: accounts.list,
    listInboxMessages: inbox.list,
    listOutboxOperations: outbox.list,
    listReceipts: receipts.list,
    listSourceEvents: sourceEvents.list,
    listTransactions: transactions.list,
    listWorkOrders: workOrders.list,
    removeInboxMessage: inbox.remove,
    removeAccount: accounts.remove,
    removeOutboxOperation: outbox.remove,
    removeReceipt: receipts.remove,
    removeTransaction: transactions.remove,
    removeSourceEvent: sourceEvents.remove,
    removeWorkOrder: workOrders.remove,
    saveAccount: accounts.save,
    saveInboxMessage: inbox.save,
    saveMeta,
    saveOutboxOperation: outbox.save,
    saveReceipt: receipts.save,
    saveSourceEvent: sourceEvents.save,
    saveTransaction: transactions.save,
    saveWorkOrder: workOrders.save,
  });
}

function createMemoryRepository(seed = {}) {
  const state = cloneValue(seed) || {};
  const flushPrerequisites = new Map();
  const split = (pathArg) => String(pathArg || "")
    .split("/")
    .filter(Boolean);

  return {
    read(table, pathArg) {
      if (table !== TABLE_NAME) return { success: false, errorMsg: "TABLE_NOT_FOUND", data: null };
      let current = state;
      for (const segment of split(pathArg)) {
        if (!current || typeof current !== "object" || !(segment in current)) {
          return { success: false, errorMsg: "ENTRY_NOT_FOUND", data: null };
        }
        current = current[segment];
      }
      return { success: true, data: cloneValue(current) };
    },
    write(table, pathArg, value) {
      if (table !== TABLE_NAME) return { success: false, errorMsg: "TABLE_NOT_FOUND" };
      const segments = split(pathArg);
      let current = state;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        if (!current[segment] || typeof current[segment] !== "object") current[segment] = {};
        current = current[segment];
      }
      if (segments.length === 0) {
        Object.keys(state).forEach((key) => delete state[key]);
        Object.assign(state, cloneValue(value));
      } else {
        current[segments[segments.length - 1]] = cloneValue(value);
      }
      return { success: true };
    },
    remove(table, pathArg) {
      if (table !== TABLE_NAME) return { success: false, errorMsg: "TABLE_NOT_FOUND" };
      const segments = split(pathArg);
      let current = state;
      for (let index = 0; index < segments.length - 1; index += 1) {
        current = current && current[segments[index]];
      }
      const key = segments[segments.length - 1];
      if (!current || !Object.prototype.hasOwnProperty.call(current, key)) {
        return { success: false, errorMsg: "ENTRY_NOT_FOUND" };
      }
      delete current[key];
      return { success: true };
    },
    ensureTable() {
      return true;
    },
    flushTableSync() {
      for (const callback of flushPrerequisites.values()) {
        const result = callback();
        if (result && typeof result.then === "function") {
          return { success: false, errorMsg: "FLUSH_PREREQUISITE_ASYNC_UNSUPPORTED" };
        }
        if (result === false || (result && result.success === false)) return result;
      }
      return { success: true, flushed: true };
    },
    flushTableAsync() {
      for (const callback of flushPrerequisites.values()) {
        const result = callback();
        if (result && typeof result.then === "function") {
          return { success: false, errorMsg: "FLUSH_PREREQUISITE_ASYNC_UNSUPPORTED" };
        }
        if (result === false || (result && result.success === false)) return result;
      }
      return { success: true, flushed: true, handedOff: true };
    },
    registerTableFlushPrerequisite(_table, key, callback) {
      flushPrerequisites.set(String(key), callback);
      return { success: true, registered: true };
    },
    unregisterTableFlushPrerequisite(_table, key) {
      return { success: true, removed: flushPrerequisites.delete(String(key)) };
    },
    setTableAutoFlush() {
      return { success: true, autoFlush: false };
    },
    suspendTableFlush() {
      return { success: true, suspended: true };
    },
    resumeTableFlush() {
      return { success: true, suspended: false };
    },
    snapshot() {
      return cloneValue(state);
    },
  };
}

let defaultStore = null;
function getDefaultStateStore() {
  if (!defaultStore) {
    defaultStore = createStateStore();
  }
  return defaultStore;
}

module.exports = {
  TABLE_NAME,
  SCHEMA_VERSION,
  SAFE_RECORD_ID,
  XEveStateError,
  buildDefaultMeta,
  createMemoryRepository,
  createStateStore,
  getDefaultStateStore,
  normalizeRecordID,
};
