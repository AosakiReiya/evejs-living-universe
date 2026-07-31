"use strict";

const path = require("path");
const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));

const TABLE_NAME = "liveEventRuntime";
const SCHEMA_VERSION = 1;

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function buildDefaultMeta(nowMs = Date.now()) {
  return {
    schemaVersion: SCHEMA_VERSION,
    nextEventSerial: 1,
    createdAtMs: Math.max(0, Math.trunc(Number(nowMs) || 0)),
    updatedAtMs: Math.max(0, Math.trunc(Number(nowMs) || 0)),
  };
}

function createStateStore(options = {}) {
  const repo = options.repo || createTableRepository("in-space", { strict: true });

  function readPath(pathArg, fallback = null) {
    const result = repo.read(TABLE_NAME, pathArg);
    if (!result || result.success !== true || result.data == null) {
      return cloneValue(fallback);
    }
    return cloneValue(result.data);
  }

  function writePath(pathArg, value, writeOptions = {}) {
    return repo.write(TABLE_NAME, pathArg, cloneValue(value), writeOptions);
  }

  function ensureInitialized(nowMs = Date.now()) {
    const existing = readPath("/meta", null);
    if (existing && typeof existing === "object") {
      return {
        success: true,
        data: {
          ...buildDefaultMeta(nowMs),
          ...existing,
          schemaVersion: SCHEMA_VERSION,
        },
      };
    }
    const meta = buildDefaultMeta(nowMs);
    const result = writePath("/meta", meta);
    return result && result.success === true
      ? { success: true, data: meta }
      : result;
  }

  function allocateEventID(nowMs = Date.now()) {
    const initialized = ensureInitialized(nowMs);
    if (!initialized || initialized.success !== true) {
      return initialized || { success: false, errorMsg: "LIVE_EVENT_STATE_INIT_FAILED" };
    }
    const meta = {
      ...initialized.data,
      nextEventSerial: toPositiveInt(initialized.data.nextEventSerial, 1),
    };
    const serial = meta.nextEventSerial;
    meta.nextEventSerial = serial + 1;
    meta.updatedAtMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    const result = writePath("/meta", meta);
    if (!result || result.success !== true) {
      return result || { success: false, errorMsg: "LIVE_EVENT_ID_WRITE_FAILED" };
    }
    return {
      success: true,
      data: {
        eventID: `live-event-${String(serial).padStart(8, "0")}`,
        serial,
      },
    };
  }

  function listEvents() {
    const events = readPath("/events", {});
    return Object.values(events && typeof events === "object" ? events : {})
      .filter((event) => event && typeof event === "object")
      .sort((left, right) => String(left.eventID).localeCompare(String(right.eventID)));
  }

  function getEvent(eventID) {
    const normalizedEventID = String(eventID || "").trim();
    return normalizedEventID
      ? readPath(`/events/${normalizedEventID}`, null)
      : null;
  }

  function saveEvent(event, writeOptions = {}) {
    const eventID = String(event && event.eventID || "").trim();
    if (!eventID) {
      return { success: false, errorMsg: "LIVE_EVENT_ID_REQUIRED" };
    }
    return writePath(`/events/${eventID}`, event, writeOptions);
  }

  function removeEvent(eventID) {
    const normalizedEventID = String(eventID || "").trim();
    if (!normalizedEventID) {
      return { success: false, errorMsg: "LIVE_EVENT_ID_REQUIRED" };
    }
    return repo.remove(TABLE_NAME, `/events/${normalizedEventID}`);
  }

  function archiveEvent(event, nowMs = Date.now()) {
    const eventID = String(event && event.eventID || "").trim();
    if (!eventID) {
      return { success: false, errorMsg: "LIVE_EVENT_ID_REQUIRED" };
    }
    const archivedRecord = {
      ...cloneValue(event),
      archivedAtMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
    };
    const archiveResult = writePath(`/archive/${eventID}`, archivedRecord);
    if (!archiveResult || archiveResult.success !== true) {
      return archiveResult || { success: false, errorMsg: "LIVE_EVENT_ARCHIVE_WRITE_FAILED" };
    }
    const removeResult = removeEvent(eventID);
    if (!removeResult || removeResult.success !== true) {
      return removeResult || { success: false, errorMsg: "LIVE_EVENT_ARCHIVE_REMOVE_FAILED" };
    }
    return { success: true, data: archivedRecord };
  }

  function listArchivedEvents() {
    const events = readPath("/archive", {});
    return Object.values(events && typeof events === "object" ? events : {})
      .filter((event) => event && typeof event === "object")
      .sort((left, right) => String(left.eventID).localeCompare(String(right.eventID)));
  }

  function getTransaction(transactionID) {
    const normalizedID = String(transactionID || "").trim();
    return normalizedID
      ? readPath(`/transactions/${normalizedID}`, null)
      : null;
  }

  function saveTransaction(transaction, writeOptions = {}) {
    const transactionID = String(transaction && transaction.transactionID || "").trim();
    if (!transactionID) {
      return { success: false, errorMsg: "LIVE_EVENT_TRANSACTION_ID_REQUIRED" };
    }
    return writePath(`/transactions/${transactionID}`, transaction, writeOptions);
  }

  return Object.freeze({
    TABLE_NAME,
    SCHEMA_VERSION,
    allocateEventID,
    archiveEvent,
    ensureInitialized,
    getEvent,
    getTransaction,
    listArchivedEvents,
    listEvents,
    removeEvent,
    saveEvent,
    saveTransaction,
  });
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
  buildDefaultMeta,
  createStateStore,
  getDefaultStateStore,
};


