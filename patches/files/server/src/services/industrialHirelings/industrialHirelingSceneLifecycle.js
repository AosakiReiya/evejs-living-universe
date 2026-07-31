"use strict";

const path = require("path");
const log = require(path.join(__dirname, "../../utils/logger"));

const pendingObservedSystems = new Map();
const pendingUnobservedSystems = new Map();

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function hasObservers(scene) {
  return Boolean(scene && scene.sessions instanceof Map && scene.sessions.size > 0);
}

function getHirelingRuntime(options = {}) {
  if (options.hirelingRuntime) return options.hirelingRuntime;
  return require("./industrialHirelingRuntime").getDefaultIndustrialHirelingRuntime();
}

function getScheduler(options = {}) {
  return typeof options.schedule === "function" ? options.schedule : setImmediate;
}

function scheduleBatches(scene, observerSession, mode, options = {}) {
  const systemID = toPositiveInt(scene && scene.systemID, 0);
  if (!systemID) {
    return { success: false, errorMsg: "INDUSTRIAL_HIRELING_SYSTEM_REQUIRED" };
  }
  const pendingMap = mode === "observed" ? pendingObservedSystems : pendingUnobservedSystems;
  const oppositeMap = mode === "observed" ? pendingUnobservedSystems : pendingObservedSystems;
  oppositeMap.delete(systemID);
  if (pendingMap.has(systemID)) {
    return {
      success: true,
      data: { systemID, mode, scheduled: true, alreadyScheduled: true },
    };
  }

  const token = {};
  pendingMap.set(systemID, token);
  const schedule = getScheduler(options);
  const maxContracts = Math.max(
    1,
    Math.min(16, toPositiveInt(options.maxContracts, 1)),
  );
  let hirelingRuntime = null;
  let offset = 0;
  const processedContractIDs = new Set();

  function finish() {
    if (pendingMap.get(systemID) === token) pendingMap.delete(systemID);
  }

  function runBatch() {
    if (pendingMap.get(systemID) !== token) return;
    const stillObserved = hasObservers(scene);
    if ((mode === "observed" && !stillObserved) || (mode === "unobserved" && stillObserved)) {
      finish();
      return;
    }
    try {
      if (!hirelingRuntime) hirelingRuntime = getHirelingRuntime(options);
      const method = mode === "observed"
        ? hirelingRuntime.reconcileForObservedScene
        : hirelingRuntime.virtualizeForUnobservedScene;
      if (typeof method !== "function") {
        finish();
        log.warn(`[IndustrialHirelings] ${mode} scene lifecycle is unavailable for system=${systemID}`);
        return;
      }
      const result = method.call(hirelingRuntime, scene, {
        observerSession,
        offset,
        processedContractIDs: [...processedContractIDs],
        maxContracts,
        nowMs: options.nowMs,
      });
      const data = result && result.data || {};
      if (result && result.success === false) {
        log.warn(
          `[IndustrialHirelings] ${mode} scene reconcile reported failures for ` +
          `system=${systemID}: ${result.errorMsg || "UNKNOWN_ERROR"}`,
        );
      }
      if (data.hasMore === true) {
        const reportedContractIDs = (Array.isArray(data.processedContractIDs)
          ? data.processedContractIDs
          : [])
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        if (reportedContractIDs.length > 0) {
          let madeProgress = false;
          for (const contractID of reportedContractIDs) {
            if (processedContractIDs.has(contractID)) continue;
            processedContractIDs.add(contractID);
            madeProgress = true;
          }
          if (!madeProgress) {
            finish();
            log.warn(
              `[IndustrialHirelings] ${mode} scene lifecycle stopped after a no-progress batch for ` +
              `system=${systemID}`,
            );
            return;
          }
          // Re-query from the head after excluding stable IDs. This avoids
          // skipping the next contract when an earlier one leaves eligibility.
          offset = 0;
        } else {
          // Compatibility path for alternate runtimes that still expose only a
          // numeric cursor.
          offset = Math.max(offset + 1, Math.trunc(Number(data.nextOffset) || 0));
        }
        schedule(runBatch);
        return;
      }
      finish();
    } catch (error) {
      finish();
      log.warn(
        `[IndustrialHirelings] ${mode} scene lifecycle failed for ` +
        `system=${systemID}: ${error.message}`,
      );
    }
  }

  schedule(runBatch);
  return {
    success: true,
    data: { systemID, mode, scheduled: true, alreadyScheduled: false },
  };
}

function handleSceneObserved(scene, observerSession, options = {}) {
  if (!hasObservers(scene)) {
    return {
      success: true,
      data: {
        systemID: toPositiveInt(scene && scene.systemID, 0),
        mode: "observed",
        scheduled: false,
        skippedReason: "scene_unobserved",
      },
    };
  }
  return scheduleBatches(scene, observerSession, "observed", options);
}

function handleSceneUnobserved(scene, options = {}) {
  if (hasObservers(scene)) {
    return {
      success: true,
      data: {
        systemID: toPositiveInt(scene && scene.systemID, 0),
        mode: "unobserved",
        scheduled: false,
        skippedReason: "scene_observed",
      },
    };
  }
  return scheduleBatches(scene, null, "unobserved", options);
}

module.exports = {
  handleSceneObserved,
  handleSceneUnobserved,
  _testing: {
    pendingObservedSystems,
    pendingUnobservedSystems,
    reset() {
      pendingObservedSystems.clear();
      pendingUnobservedSystems.clear();
    },
  },
};
