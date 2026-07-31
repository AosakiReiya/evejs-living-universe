"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../config"));

const DEFAULT_PER_SYSTEM_LIMIT = 48;
const DEFAULT_GLOBAL_LIMIT = 120;

const reservations = new Map();
const reservedBySystem = new Map();
const reservedByOwnerKind = new Map();

let reservedGlobal = 0;
let limitOverride = null;
let metrics = createEmptyMetrics();

function createEmptyMetrics() {
  return {
    reservationsGranted: 0,
    idempotentReservations: 0,
    releases: 0,
    releaseMisses: 0,
    deniedGlobal: 0,
    deniedSystem: 0,
    deniedInvalid: 0,
    deniedConflict: 0,
  };
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeText(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function getLimits() {
  const configuredPerSystem = limitOverride
    ? limitOverride.perSystem
    : config.livingUniverseMaxMaterializedPerSystem;
  const perSystem = Math.max(
    1,
    toPositiveInt(configuredPerSystem, DEFAULT_PER_SYSTEM_LIMIT),
  );
  const configuredGlobal = limitOverride
    ? limitOverride.global
    : config.livingUniverseMaxMaterializedGlobal;
  const global = Math.max(
    perSystem,
    toPositiveInt(configuredGlobal, DEFAULT_GLOBAL_LIMIT),
  );
  return { global, perSystem };
}

function normalizeRequest(request = {}) {
  return {
    reservationID: normalizeText(request.reservationID),
    ownerKind: normalizeText(request.ownerKind),
    ownerID: normalizeText(request.ownerID),
    systemID: toPositiveInt(request.systemID, 0),
    shipCount: toPositiveInt(request.shipCount, 0),
    priority: Math.trunc(Number(request.priority) || 0),
    metadata: request.metadata && typeof request.metadata === "object"
      ? { ...request.metadata }
      : {},
  };
}

function isValidRequest(request) {
  return Boolean(
    request.reservationID &&
    request.ownerKind &&
    request.ownerID &&
    request.systemID > 0 &&
    request.shipCount > 0,
  );
}

function sameReservation(left, right) {
  return Boolean(
    left &&
    right &&
    left.reservationID === right.reservationID &&
    left.ownerKind === right.ownerKind &&
    left.ownerID === right.ownerID &&
    left.systemID === right.systemID &&
    left.shipCount === right.shipCount,
  );
}

function evaluate(request = {}) {
  const normalized = normalizeRequest(request);
  if (!isValidRequest(normalized)) {
    return {
      success: false,
      reason: "INVALID_REQUEST",
      request: normalized,
    };
  }

  const existing = reservations.get(normalized.reservationID) || null;
  if (existing) {
    return sameReservation(existing, normalized)
      ? {
          success: true,
          reason: "ALREADY_RESERVED",
          request: normalized,
          reservation: { ...existing, metadata: { ...existing.metadata } },
        }
      : {
          success: false,
          reason: "RESERVATION_ID_CONFLICT",
          request: normalized,
          reservation: { ...existing, metadata: { ...existing.metadata } },
        };
  }

  const limits = getLimits();
  const systemReserved = reservedBySystem.get(normalized.systemID) || 0;
  if (reservedGlobal + normalized.shipCount > limits.global) {
    return {
      success: false,
      reason: "GLOBAL_LIMIT",
      request: normalized,
      available: Math.max(0, limits.global - reservedGlobal),
    };
  }
  if (systemReserved + normalized.shipCount > limits.perSystem) {
    return {
      success: false,
      reason: "SYSTEM_LIMIT",
      request: normalized,
      available: Math.max(0, limits.perSystem - systemReserved),
    };
  }
  return {
    success: true,
    reason: "CAPACITY_AVAILABLE",
    request: normalized,
  };
}

function canReserve(request = {}) {
  return evaluate(request).success;
}

function incrementMap(map, key, delta) {
  const next = (map.get(key) || 0) + delta;
  if (next > 0) {
    map.set(key, next);
  } else {
    map.delete(key);
  }
}

function reserve(request = {}) {
  const evaluation = evaluate(request);
  if (!evaluation.success) {
    if (evaluation.reason === "GLOBAL_LIMIT") {
      metrics.deniedGlobal += 1;
    } else if (evaluation.reason === "SYSTEM_LIMIT") {
      metrics.deniedSystem += 1;
    } else if (evaluation.reason === "RESERVATION_ID_CONFLICT") {
      metrics.deniedConflict += 1;
    } else {
      metrics.deniedInvalid += 1;
    }
    return evaluation;
  }
  if (evaluation.reason === "ALREADY_RESERVED") {
    metrics.idempotentReservations += 1;
    return evaluation;
  }

  const reservation = {
    ...evaluation.request,
    reservedAtMs: Date.now(),
  };
  reservations.set(reservation.reservationID, reservation);
  reservedGlobal += reservation.shipCount;
  incrementMap(reservedBySystem, reservation.systemID, reservation.shipCount);
  incrementMap(reservedByOwnerKind, reservation.ownerKind, reservation.shipCount);
  metrics.reservationsGranted += 1;
  return {
    success: true,
    reason: "RESERVED",
    request: evaluation.request,
    reservation: { ...reservation, metadata: { ...reservation.metadata } },
  };
}

function release(reservationID) {
  const normalizedID = normalizeText(reservationID);
  const reservation = reservations.get(normalizedID) || null;
  if (!reservation) {
    metrics.releaseMisses += 1;
    return false;
  }
  reservations.delete(normalizedID);
  reservedGlobal = Math.max(0, reservedGlobal - reservation.shipCount);
  incrementMap(reservedBySystem, reservation.systemID, -reservation.shipCount);
  incrementMap(reservedByOwnerKind, reservation.ownerKind, -reservation.shipCount);
  metrics.releases += 1;
  return true;
}

function releaseOwner(ownerKind, ownerID) {
  const normalizedKind = normalizeText(ownerKind);
  const normalizedOwnerID = ownerID === undefined ? null : normalizeText(ownerID);
  const reservationIDs = [];
  for (const reservation of reservations.values()) {
    if (reservation.ownerKind !== normalizedKind) {
      continue;
    }
    if (normalizedOwnerID !== null && reservation.ownerID !== normalizedOwnerID) {
      continue;
    }
    reservationIDs.push(reservation.reservationID);
  }
  for (const reservationID of reservationIDs) {
    release(reservationID);
  }
  return reservationIDs.length;
}

function getReservation(reservationID) {
  const reservation = reservations.get(normalizeText(reservationID)) || null;
  return reservation
    ? { ...reservation, metadata: { ...reservation.metadata } }
    : null;
}

function getStatus(options = {}) {
  const includeReservations = options.includeReservations === true;
  const limits = getLimits();
  const status = {
    limits,
    reservedShips: reservedGlobal,
    availableShips: Math.max(0, limits.global - reservedGlobal),
    reservationCount: reservations.size,
    reservedBySystem: Object.fromEntries(reservedBySystem),
    reservedByOwnerKind: Object.fromEntries(reservedByOwnerKind),
    metrics: { ...metrics },
  };
  if (includeReservations) {
    status.reservations = Array.from(reservations.values(), (reservation) => ({
      ...reservation,
      metadata: { ...reservation.metadata },
    }));
  }
  return status;
}

function resetForTests(options = {}) {
  reservations.clear();
  reservedBySystem.clear();
  reservedByOwnerKind.clear();
  reservedGlobal = 0;
  metrics = createEmptyMetrics();
  limitOverride = options.limits
    ? {
        global: toPositiveInt(options.limits.global, DEFAULT_GLOBAL_LIMIT),
        perSystem: toPositiveInt(options.limits.perSystem, DEFAULT_PER_SYSTEM_LIMIT),
      }
    : null;
}

module.exports = {
  canReserve,
  reserve,
  release,
  releaseOwner,
  getReservation,
  getLimits,
  getStatus,
  _testing: {
    evaluate,
    normalizeRequest,
    resetForTests,
  },
};


