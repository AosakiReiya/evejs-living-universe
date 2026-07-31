"use strict";

const crypto = require("crypto");

const TRANSACTION_VERSION = 1;
const MAX_ALLOCATIONS_PER_TRANSACTION = 512;
const MAX_TRANSACTIONS_PER_SYSTEM = 1_024;
const MAX_QUANTITY = 2_147_483_647;

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeText(value, maximumLength = 160) {
  return String(value === undefined || value === null ? "" : value)
    .trim()
    .slice(0, maximumLength);
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }
  return Math.min(MAX_QUANTITY, numeric);
}

function toPositiveSafeInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    return fallback;
  }
  return numeric;
}

function normalizeAllocations(allocations) {
  const quantitiesByEntityID = new Map();
  for (const allocation of Array.isArray(allocations) ? allocations : []) {
    const entityID = toPositiveSafeInt(allocation && allocation.entityID, 0);
    const requestedQuantity = toPositiveInt(
      allocation && (allocation.requestedQuantity ?? allocation.quantity),
      0,
    );
    if (entityID <= 0 || requestedQuantity <= 0) {
      continue;
    }
    quantitiesByEntityID.set(
      entityID,
      Math.min(
        MAX_QUANTITY,
        (quantitiesByEntityID.get(entityID) || 0) + requestedQuantity,
      ),
    );
  }
  return Array.from(quantitiesByEntityID, ([entityID, requestedQuantity]) => ({
    entityID,
    requestedQuantity,
  })).sort((left, right) => left.entityID - right.entityID);
}

function normalizeRequest(request = {}) {
  return {
    transactionID: normalizeText(request.transactionID),
    eventID: normalizeText(request.eventID),
    systemID: toPositiveInt(request.systemID, 0),
    beltID: toPositiveInt(request.beltID, 0),
    allocations: normalizeAllocations(request.allocations),
  };
}

function fingerprintRequest(request) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      transactionID: request.transactionID,
      eventID: request.eventID,
      systemID: request.systemID,
      beltID: request.beltID,
      allocations: request.allocations,
    }))
    .digest("hex");
}

function validateRequest(request) {
  if (!request.transactionID || !request.eventID) {
    return "TRANSACTION_IDENTITY_REQUIRED";
  }
  if (request.systemID <= 0 || request.beltID <= 0) {
    return "MINING_LOCATION_REQUIRED";
  }
  if (request.allocations.length <= 0) {
    return "ALLOCATIONS_REQUIRED";
  }
  if (request.allocations.length > MAX_ALLOCATIONS_PER_TRANSACTION) {
    return "TOO_MANY_ALLOCATIONS";
  }
  return null;
}

function pruneTransactions(transactions, currentTransactionID) {
  const transactionIDs = Object.keys(transactions);
  if (transactionIDs.length <= MAX_TRANSACTIONS_PER_SYSTEM) {
    return;
  }
  transactionIDs
    .filter((transactionID) => transactionID !== currentTransactionID)
    .sort((leftID, rightID) => {
      const left = transactions[leftID] || {};
      const right = transactions[rightID] || {};
      const timeDifference = Number(left.completedAtMs || 0) - Number(right.completedAtMs || 0);
      return timeDifference || leftID.localeCompare(rightID);
    })
    .slice(0, transactionIDs.length - MAX_TRANSACTIONS_PER_SYSTEM)
    .forEach((transactionID) => {
      delete transactions[transactionID];
    });
}

function createVirtualMiningTransactionService(options = {}) {
  const repository = options.repository;
  const tableName = normalizeText(options.tableName, 80);
  const normalizeStateRecord = typeof options.normalizeStateRecord === "function"
    ? options.normalizeStateRecord
    : (record) => cloneValue(record || {});
  if (!repository || typeof repository.read !== "function" || typeof repository.write !== "function") {
    throw new Error("A mining table repository is required.");
  }
  if (!tableName) {
    throw new Error("A mining runtime table name is required.");
  }

  const activeSystems = new Set();

  function readSystemRecord(systemID) {
    const result = repository.read(tableName, `/systems/${String(systemID)}`);
    if (!result || !result.success || !result.data || typeof result.data !== "object") {
      return null;
    }
    return cloneValue(result.data);
  }

  function flushDurably() {
    if (typeof repository.flushTableSync !== "function") {
      return { success: false, errorMsg: "DURABLE_FLUSH_UNAVAILABLE" };
    }
    const result = repository.flushTableSync(tableName);
    return result && result.success
      ? { success: true }
      : { success: false, errorMsg: String(result && result.errorMsg || "FLUSH_FAILED") };
  }

  function resolveExistingTransaction(systemRecord, request, requestFingerprint) {
    const transactions = systemRecord.virtualMiningTransactions;
    const transaction = transactions && typeof transactions === "object"
      ? transactions[request.transactionID]
      : null;
    if (!transaction) {
      return null;
    }
    if (String(transaction.requestFingerprint || "") !== requestFingerprint) {
      return {
        success: false,
        errorMsg: "TRANSACTION_CONFLICT",
      };
    }
    const flushResult = flushDurably();
    if (!flushResult.success) {
      return {
        success: false,
        errorMsg: "PERSISTENCE_FAILED",
        data: cloneValue(transaction),
      };
    }
    return {
      success: true,
      idempotent: true,
      data: cloneValue(transaction),
    };
  }

  function applyPersistedMiningBatch(rawRequest = {}, executionOptions = {}) {
    const request = normalizeRequest(rawRequest);
    const validationError = validateRequest(request);
    if (validationError) {
      return { success: false, errorMsg: validationError };
    }
    if (activeSystems.has(request.systemID)) {
      return { success: false, errorMsg: "SYSTEM_BUSY" };
    }

    activeSystems.add(request.systemID);
    try {
      const systemRecord = readSystemRecord(request.systemID);
      if (!systemRecord || !systemRecord.entities || typeof systemRecord.entities !== "object") {
        return { success: false, errorMsg: "PERSISTED_SYSTEM_NOT_FOUND" };
      }

      const requestFingerprint = fingerprintRequest(request);
      const existingResult = resolveExistingTransaction(
        systemRecord,
        request,
        requestFingerprint,
      );
      if (existingResult) {
        return existingResult;
      }

      if (typeof executionOptions.isSystemSceneLoaded !== "function") {
        return { success: false, errorMsg: "SCENE_GUARD_REQUIRED" };
      }
      let sceneLoaded = true;
      try {
        sceneLoaded = executionOptions.isSystemSceneLoaded(request.systemID) === true;
      } catch (_error) {
        return { success: false, errorMsg: "SCENE_GUARD_FAILED" };
      }
      if (sceneLoaded) {
        return { success: false, errorMsg: "SCENE_ACTIVE" };
      }

      const nowMs = Math.max(0, Math.trunc(Number(executionOptions.nowMs ?? Date.now()) || 0));
      const results = [];
      let totalRequestedQuantity = 0;
      let totalAcceptedQuantity = 0;

      for (const allocation of request.allocations) {
        totalRequestedQuantity += allocation.requestedQuantity;
        const entityKey = String(allocation.entityID);
        const rawState = systemRecord.entities[entityKey];
        if (!rawState || typeof rawState !== "object") {
          results.push({ ...allocation, acceptedQuantity: 0, reason: "ENTITY_NOT_FOUND" });
          continue;
        }

        const currentState = normalizeStateRecord(rawState);
        if (toPositiveInt(currentState.beltID, 0) !== request.beltID) {
          results.push({ ...allocation, acceptedQuantity: 0, reason: "BELT_MISMATCH" });
          continue;
        }
        const remainingBefore = Math.max(0, Math.trunc(Number(currentState.remainingQuantity) || 0));
        if (remainingBefore <= 0) {
          results.push({ ...allocation, acceptedQuantity: 0, reason: "DEPLETED" });
          continue;
        }

        const acceptedQuantity = Math.min(allocation.requestedQuantity, remainingBefore);
        const revisionBefore = Math.max(0, Math.trunc(Number(currentState.revision) || 0));
        const remainingAfter = remainingBefore - acceptedQuantity;
        systemRecord.entities[entityKey] = normalizeStateRecord({
          ...currentState,
          remainingQuantity: remainingAfter,
          revision: revisionBefore + 1,
          updatedAtMs: nowMs,
        });
        totalAcceptedQuantity += acceptedQuantity;
        results.push({
          entityID: allocation.entityID,
          requestedQuantity: allocation.requestedQuantity,
          acceptedQuantity,
          remainingBefore,
          remainingAfter,
          revisionBefore,
          revisionAfter: revisionBefore + 1,
          yieldTypeID: toPositiveInt(currentState.yieldTypeID, 0),
          yieldKind: normalizeText(currentState.yieldKind, 40).toLowerCase() || null,
          reason: "ACCEPTED",
        });
      }

      if (totalAcceptedQuantity <= 0) {
        return {
          success: false,
          errorMsg: "NO_ELIGIBLE_RESOURCES",
          data: {
            transactionID: request.transactionID,
            eventID: request.eventID,
            systemID: request.systemID,
            beltID: request.beltID,
            results,
          },
        };
      }

      const transaction = {
        version: TRANSACTION_VERSION,
        status: "COMMITTED",
        transactionID: request.transactionID,
        eventID: request.eventID,
        requestFingerprint,
        systemID: request.systemID,
        beltID: request.beltID,
        totalRequestedQuantity,
        totalAcceptedQuantity,
        results,
        completedAtMs: nowMs,
      };
      const transactions = systemRecord.virtualMiningTransactions &&
        typeof systemRecord.virtualMiningTransactions === "object"
        ? systemRecord.virtualMiningTransactions
        : {};
      transactions[request.transactionID] = transaction;
      pruneTransactions(transactions, request.transactionID);
      systemRecord.virtualMiningTransactions = transactions;

      const writeResult = repository.write(
        tableName,
        `/systems/${String(request.systemID)}`,
        systemRecord,
      );
      if (!writeResult || writeResult.success !== true) {
        return { success: false, errorMsg: "PERSISTENCE_WRITE_FAILED" };
      }
      const flushResult = flushDurably();
      if (!flushResult.success) {
        return {
          success: false,
          errorMsg: "PERSISTENCE_FAILED",
          data: cloneValue(transaction),
        };
      }
      return {
        success: true,
        idempotent: false,
        data: cloneValue(transaction),
      };
    } finally {
      activeSystems.delete(request.systemID);
    }
  }

  function readTransaction(systemID, transactionID) {
    const normalizedSystemID = toPositiveInt(systemID, 0);
    const normalizedTransactionID = normalizeText(transactionID);
    if (normalizedSystemID <= 0 || !normalizedTransactionID) {
      return null;
    }
    const systemRecord = readSystemRecord(normalizedSystemID);
    const transaction = systemRecord && systemRecord.virtualMiningTransactions &&
      systemRecord.virtualMiningTransactions[normalizedTransactionID];
    return transaction ? cloneValue(transaction) : null;
  }

  return {
    applyPersistedMiningBatch,
    readTransaction,
    _testing: {
      activeSystems,
    },
  };
}

module.exports = {
  TRANSACTION_VERSION,
  MAX_ALLOCATIONS_PER_TRANSACTION,
  MAX_TRANSACTIONS_PER_SYSTEM,
  createVirtualMiningTransactionService,
  _testing: {
    fingerprintRequest,
    normalizeAllocations,
    normalizeRequest,
    pruneTransactions,
  },
};

