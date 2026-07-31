"use strict";

const path = require("path");

const database = require(path.join(__dirname, "../../gameStore"));

const TABLE_NAME = "familyEstateProjectState";
const SCHEMA_VERSION = 3;
const LEDGER_LIMIT = 500;
const PROCUREMENT_RESERVATION_LIMIT = 1_000;

const PROJECT_DEFINITIONS = Object.freeze({
  stabilization: Object.freeze({
    key: "stabilization",
    label: "Stabilize the superstructure",
    description: "Repair the inherited Athanor's hull, armor, power trunking, and pressure seals.",
    dependsOn: Object.freeze([]),
    iskCost: 5_000_000,
    durationMs: 2 * 60 * 60 * 1000,
    unlockCapability: null,
    materials: Object.freeze([
      Object.freeze({ typeID: 21947, name: "Structure Construction Parts", quantity: 1 }),
      Object.freeze({ typeID: 34, name: "Tritanium", quantity: 250_000 }),
      Object.freeze({ typeID: 35, name: "Pyerite", quantity: 50_000 }),
      Object.freeze({ typeID: 36, name: "Mexallon", quantity: 10_000 }),
      Object.freeze({ typeID: 28668, name: "Nanite Repair Paste", quantity: 100 }),
    ]),
  }),
  reprocessing: Object.freeze({
    key: "reprocessing",
    label: "Restore the ore-processing plant",
    description: "Rebuild the refinery feed system and recommission a Standup Reprocessing Facility.",
    dependsOn: Object.freeze(["stabilization"]),
    iskCost: 10_000_000,
    durationMs: 4 * 60 * 60 * 1000,
    unlockCapability: "reprocessing",
    materials: Object.freeze([
      Object.freeze({ typeID: 35899, name: "Standup Reprocessing Facility I", quantity: 1 }),
      Object.freeze({ typeID: 21947, name: "Structure Construction Parts", quantity: 1 }),
      Object.freeze({ typeID: 34, name: "Tritanium", quantity: 500_000 }),
      Object.freeze({ typeID: 35, name: "Pyerite", quantity: 100_000 }),
      Object.freeze({ typeID: 36, name: "Mexallon", quantity: 25_000 }),
      Object.freeze({ typeID: 37, name: "Isogen", quantity: 5_000 }),
    ]),
  }),
});

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function toNonNegativeInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function toMoney(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : fallback;
}

function buildStableFingerprint(parts = []) {
  return parts.map((value) => String(
    value === undefined || value === null ? "" : value,
  )).join("|");
}

function normalizeFundingRecord(value = {}) {
  const status = ["none", "pending", "applied"].includes(value.status)
    ? value.status
    : "none";
  return {
    status,
    operationID: String(value.operationID || "").slice(0, 180) || null,
    fingerprint: String(value.fingerprint || "").slice(0, 512) || null,
    requestedAtMs: toNonNegativeInt(value.requestedAtMs, 0) || null,
    appliedAtMs: toNonNegativeInt(value.appliedAtMs, 0) || null,
    amountISK: Math.max(0, toMoney(value.amountISK, 0)),
    requestedByCharacterID: toNonNegativeInt(value.requestedByCharacterID, 0) || null,
    lastError: String(value.lastError || "").slice(0, 240) || null,
  };
}

function normalizeProcurementReservation(value = {}) {
  const status = [
    "reserved",
    "delivery_pending",
    "delivered",
    "lost",
    "cancelled",
  ].includes(value.status)
    ? value.status
    : "reserved";
  return {
    reservationID: String(value.reservationID || value.jobID || "").slice(0, 180),
    jobID: String(value.jobID || value.reservationID || "").slice(0, 180),
    status,
    typeID: toNonNegativeInt(value.typeID, 0) || null,
    typeName: String(value.typeName || "").slice(0, 120) || null,
    quantity: toNonNegativeInt(value.quantity, 0),
    acceptedQuantity: toNonNegativeInt(value.acceptedQuantity, 0),
    sourceStationID: toNonNegativeInt(value.sourceStationID, 0) || null,
    destinationStructureID: toNonNegativeInt(value.destinationStructureID, 0) || null,
    assignedFlightID: String(value.assignedFlightID || "").slice(0, 180) || null,
    corporationID: toNonNegativeInt(value.corporationID, 0) || null,
    accountKey: toNonNegativeInt(value.accountKey, 0) || null,
    goodsISK: Math.max(0, toMoney(value.goodsISK, 0)),
    freightFeeISK: Math.max(0, toMoney(value.freightFeeISK, 0)),
    totalISK: Math.max(0, toMoney(value.totalISK, 0)),
    escrowStatus: ["pending", "escrowed", "paid", "refunded"].includes(
      value.escrowStatus,
    ) ? value.escrowStatus : "pending",
    escrowOperationID: String(value.escrowOperationID || value.walletOperationID || "")
      .slice(0, 180) || null,
    escrowFingerprint: String(value.escrowFingerprint || value.walletFingerprint || "")
      .slice(0, 512) || null,
    refundOperationID: String(value.refundOperationID || "").slice(0, 180) || null,
    refundFingerprint: String(value.refundFingerprint || "").slice(0, 512) || null,
    walletOperationID: String(value.walletOperationID || "").slice(0, 180) || null,
    walletFingerprint: String(value.walletFingerprint || "").slice(0, 512) || null,
    reservedAtMs: toNonNegativeInt(value.reservedAtMs, 0) || null,
    escrowedAtMs: toNonNegativeInt(value.escrowedAtMs, 0) || null,
    arrivedAtMs: toNonNegativeInt(value.arrivedAtMs, 0) || null,
    settledAtMs: toNonNegativeInt(value.settledAtMs, 0) || null,
    refundedAtMs: toNonNegativeInt(value.refundedAtMs, 0) || null,
    quarantinedAtMs: toNonNegativeInt(value.quarantinedAtMs, 0) || null,
    quarantineReason: String(value.quarantineReason || "").slice(0, 240) || null,
    closedAtMs: toNonNegativeInt(value.closedAtMs, 0) || null,
    lastError: String(value.lastError || "").slice(0, 240) || null,
  };
}

function normalizeProcurementRecord(value = {}, projectKey = "") {
  const status = ["inactive", "commissioned", "fulfilled", "cancelled"].includes(
    value.status,
  )
    ? value.status
    : "inactive";
  const corporationID = toNonNegativeInt(value.corporationID, 0) || null;
  const normalizedReservations = Object.entries(
    value.reservations && typeof value.reservations === "object"
      ? value.reservations
      : {},
  ).map(([key, reservation]) => {
    const normalized = normalizeProcurementReservation({
      ...(reservation && typeof reservation === "object" ? reservation : {}),
      reservationID: reservation && reservation.reservationID || key,
    });
    normalized.corporationID = normalized.corporationID || corporationID;
    if (
      normalized.reservationID &&
      normalized.corporationID &&
      normalized.destinationStructureID &&
      normalized.totalISK > 0
    ) {
      normalized.escrowOperationID = normalized.escrowOperationID ||
        `estate-delivery:${normalized.corporationID}:` +
        `${normalized.reservationID}:escrow`;
      normalized.escrowFingerprint = normalized.escrowFingerprint ||
        buildStableFingerprint([
          "family-estate-delivery-escrow-v1",
          normalized.corporationID,
          normalized.destinationStructureID,
          projectKey,
          normalized.reservationID,
          normalized.typeID,
          normalized.quantity,
          normalized.totalISK,
        ]);
      normalized.refundOperationID = normalized.refundOperationID ||
        `estate-delivery:${normalized.corporationID}:` +
        `${normalized.reservationID}:refund`;
      normalized.refundFingerprint = normalized.refundFingerprint ||
        buildStableFingerprint([
          "family-estate-delivery-refund-v1",
          normalized.corporationID,
          normalized.destinationStructureID,
          projectKey,
          normalized.reservationID,
          normalized.totalISK,
        ]);
      normalized.walletOperationID = normalized.walletOperationID ||
        normalized.escrowOperationID;
      normalized.walletFingerprint = normalized.walletFingerprint ||
        normalized.escrowFingerprint;
    }
    return [normalized.reservationID || String(key), normalized];
  }).filter(([key]) => key);
  const active = normalizedReservations.filter(([, reservation]) => (
    ["reserved", "delivery_pending"].includes(reservation.status)
  ));
  const closed = normalizedReservations.filter(([, reservation]) => (
    !["reserved", "delivery_pending"].includes(reservation.status)
  )).sort((left, right) => (
    toNonNegativeInt(left[1].closedAtMs || left[1].settledAtMs, 0) -
    toNonNegativeInt(right[1].closedAtMs || right[1].settledAtMs, 0)
  ));
  const keepClosed = Math.max(0, PROCUREMENT_RESERVATION_LIMIT - active.length);
  return {
    status,
    autoStart: value.autoStart !== false,
    commissionedAtMs: toNonNegativeInt(value.commissionedAtMs, 0) || null,
    commissionedByCharacterID:
      toNonNegativeInt(value.commissionedByCharacterID, 0) || null,
    corporationID,
    deliveries: toNonNegativeInt(value.deliveries, 0),
    unitsDelivered: toNonNegativeInt(value.unitsDelivered, 0),
    goodsSpentISK: Math.max(0, toMoney(value.goodsSpentISK, 0)),
    freightSpentISK: Math.max(0, toMoney(value.freightSpentISK, 0)),
    lastRequiredISK: Math.max(0, toMoney(value.lastRequiredISK, 0)),
    lastBalanceISK: Math.max(0, toMoney(value.lastBalanceISK, 0)),
    reservations: Object.fromEntries([
      ...active,
      ...closed.slice(-keepClosed),
    ]),
    lastError: String(value.lastError || "").slice(0, 240) || null,
  };
}

function normalizeProjectRecord(key, value = {}) {
  const definition = PROJECT_DEFINITIONS[key];
  const status = ["available", "in_progress", "completed"].includes(value.status)
    ? value.status
    : "available";
  const contributed = {};
  for (const requirement of definition.materials) {
    contributed[String(requirement.typeID)] = Math.min(
      requirement.quantity,
      toNonNegativeInt(value.contributed && value.contributed[String(requirement.typeID)], 0),
    );
  }
  return {
    key,
    status,
    contributed,
    iskCommitted: Math.min(definition.iskCost, Math.max(0, toMoney(value.iskCommitted, 0))),
    startedAtMs: toNonNegativeInt(value.startedAtMs, 0) || null,
    completesAtMs: toNonNegativeInt(value.completesAtMs, 0) || null,
    completedAtMs: toNonNegativeInt(value.completedAtMs, 0) || null,
    startedByCharacterID: toNonNegativeInt(value.startedByCharacterID, 0) || null,
    completedBy: String(value.completedBy || "").slice(0, 80) || null,
    funding: normalizeFundingRecord(value.funding),
    procurement: normalizeProcurementRecord(value.procurement, key),
  };
}

function normalizeLedger(value = []) {
  return (Array.isArray(value) ? value : []).map((entry) => ({
    id: String(entry && entry.id || "").slice(0, 120),
    atMs: toNonNegativeInt(entry && entry.atMs, Date.now()),
    kind: String(entry && entry.kind || "unknown").slice(0, 80),
    projectKey: String(entry && entry.projectKey || "").slice(0, 80) || null,
    characterID: toNonNegativeInt(entry && entry.characterID, 0) || null,
    corporationID: toNonNegativeInt(entry && entry.corporationID, 0) || null,
    typeID: toNonNegativeInt(entry && entry.typeID, 0) || null,
    quantity: toNonNegativeInt(entry && entry.quantity, 0),
    grossISK: toMoney(entry && entry.grossISK, 0),
    expenseISK: toMoney(entry && entry.expenseISK, 0),
    netISK: toMoney(entry && entry.netISK, 0),
    note: String(entry && entry.note || "").slice(0, 240) || null,
  })).filter((entry) => entry.id).slice(-LEDGER_LIMIT);
}

function buildDefaultState(nowMs = Date.now()) {
  return {
    version: SCHEMA_VERSION,
    projects: Object.fromEntries(
      Object.keys(PROJECT_DEFINITIONS).map((key) => [key, normalizeProjectRecord(key)]),
    ),
    commercial: {
      lastSettledAtMs: toNonNegativeInt(nowMs, Date.now()),
      totalGrossISK: 0,
      totalExpenseISK: 0,
      totalNetISK: 0,
      settlements: 0,
    },
    ledger: [],
    updatedAtMs: toNonNegativeInt(nowMs, Date.now()),
  };
}

function normalizeState(value = {}, nowMs = Date.now()) {
  for (const [projectKey, project] of Object.entries(
    value.projects && typeof value.projects === "object" ? value.projects : {},
  )) {
    if (PROJECT_DEFINITIONS[projectKey]) continue;
    const reservations = Object.values(
      project && project.procurement && project.procurement.reservations || {},
    );
    const financiallyActive = reservations.some((reservation) => (
      ["reserved", "delivery_pending"].includes(String(reservation && reservation.status || "")) ||
      ["pending", "escrowed"].includes(String(reservation && reservation.escrowStatus || ""))
    ));
    if (financiallyActive) {
      const error = new Error("FAMILY_ESTATE_PROJECT_MIGRATION_REQUIRED");
      error.code = "FAMILY_ESTATE_PROJECT_MIGRATION_REQUIRED";
      error.projectKey = projectKey;
      throw error;
    }
  }
  const defaults = buildDefaultState(nowMs);
  const commercial = value.commercial && typeof value.commercial === "object"
    ? value.commercial
    : {};
  return {
    version: SCHEMA_VERSION,
    projects: Object.fromEntries(Object.keys(PROJECT_DEFINITIONS).map((key) => [
      key,
      normalizeProjectRecord(key, value.projects && value.projects[key]),
    ])),
    commercial: {
      lastSettledAtMs: toNonNegativeInt(
        commercial.lastSettledAtMs,
        defaults.commercial.lastSettledAtMs,
      ),
      totalGrossISK: Math.max(0, toMoney(commercial.totalGrossISK, 0)),
      totalExpenseISK: Math.max(0, toMoney(commercial.totalExpenseISK, 0)),
      totalNetISK: toMoney(commercial.totalNetISK, 0),
      settlements: toNonNegativeInt(commercial.settlements, 0),
    },
    ledger: normalizeLedger(value.ledger),
    updatedAtMs: toNonNegativeInt(value.updatedAtMs, defaults.updatedAtMs),
  };
}

function readState(nowMs = Date.now()) {
  database.ensureTable(TABLE_NAME);
  const result = database.read(TABLE_NAME, "/");
  if (result && result.success === true) {
    return normalizeState(result.data || {}, nowMs);
  }
  if (result && result.errorMsg === "ENTRY_NOT_FOUND") {
    return buildDefaultState(nowMs);
  }
  const reason = result && result.errorMsg || "FAMILY_ESTATE_PROJECT_READ_FAILED";
  const error = new Error(reason);
  error.code = reason;
  throw error;
}

function writeState(value, nowMs = Date.now(), options = {}) {
  const normalized = normalizeState(value, nowMs);
  normalized.updatedAtMs = toNonNegativeInt(nowMs, Date.now());
  database.ensureTable(TABLE_NAME);
  const result = database.write(TABLE_NAME, "/", normalized);
  if (!result || !result.success) {
    return {
      success: false,
      errorMsg: result && result.errorMsg || "FAMILY_ESTATE_PROJECT_WRITE_FAILED",
    };
  }
  if (options.durable === true) {
    const flush = database.flushTableSync(TABLE_NAME);
    if (!flush || flush.success !== true) {
      return {
        success: false,
        errorMsg: flush && flush.errorMsg || "FAMILY_ESTATE_PROJECT_FLUSH_FAILED",
        uncertain: true,
      };
    }
  }
  return { success: true, data: cloneValue(normalized) };
}

function ensureState(nowMs = Date.now()) {
  const current = readState(nowMs);
  const result = writeState(current, nowMs);
  return result.success ? result.data : current;
}

function updateState(updater, nowMs = Date.now(), options = {}) {
  const current = readState(nowMs);
  const next = typeof updater === "function" ? updater(cloneValue(current)) || current : current;
  return writeState(next, nowMs, options);
}

function appendLedger(state, entry) {
  state.ledger = normalizeLedger([...(state.ledger || []), entry]);
  return state;
}

module.exports = {
  LEDGER_LIMIT,
  PROCUREMENT_RESERVATION_LIMIT,
  PROJECT_DEFINITIONS,
  SCHEMA_VERSION,
  TABLE_NAME,
  appendLedger,
  cloneValue,
  ensureState,
  normalizeState,
  readState,
  updateState,
  writeState,
};
