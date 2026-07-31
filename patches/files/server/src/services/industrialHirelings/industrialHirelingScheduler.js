"use strict";

const path = require("path");

function reportSchedulerError(error) {
  const message = `[IndustrialHirelings] scheduler pass failed: ${String(
    error && error.message || error,
  )}`;
  try {
    require(path.join(__dirname, "../../utils/logger")).error(message);
  } catch (_loggingError) {
    process.stderr.write(`${message}\n`);
  }
}

function getDefaultConfig() {
  return require(path.join(__dirname, "../../config"));
}

function getDefaultCargoCustodyService() {
  return require("./industrialHirelingCargoCustody").getDefaultCargoCustodyService();
}

function getDefaultContractService() {
  return require("./industrialHirelingContracts").getDefaultContractService();
}

function getDefaultHirelingRuntime() {
  return require("./industrialHirelingRuntime").getDefaultIndustrialHirelingRuntime();
}

function getDefaultBookmarkLifecycle() {
  return require("./industrialHirelingBookmarkLifecycle");
}

function createIndustrialHirelingScheduler(options = {}) {
  const config = options.config || getDefaultConfig();
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;
  const reportError = typeof options.reportError === "function"
    ? options.reportError
    : reportSchedulerError;
  let cargoCustody = options.cargoCustody || null;
  let contractService = options.contractService || null;
  let hirelingRuntime = options.hirelingRuntime || null;
  let bookmarkLifecycle = options.bookmarkLifecycle || null;
  let timer = null;
  let passRunning = false;

  function isEnabled() {
    return config.livingUniverseEnabled === true &&
      config.industrialHirelingsEnabled === true;
  }

  function runPass() {
    if (!isEnabled() || passRunning) {
      return { success: true, data: { skipped: true } };
    }
    passRunning = true;
    try {
      const nowMs = now();
      const maxJobs = Math.max(
        1,
        Math.trunc(Number(config.industrialHirelingsMaxJobsPerPass) || 4),
      );
      if (!cargoCustody) cargoCustody = getDefaultCargoCustodyService();
      if (!contractService) contractService = getDefaultContractService();
      if (!hirelingRuntime) hirelingRuntime = getDefaultHirelingRuntime();
      const cargoResult = cargoCustody.reconcileDueManifests(nowMs, { maxJobs });
      const expiryResult = contractService.reconcileExpired(nowMs, {
        maxJobs,
        beforeArchive(contract, atMs) {
          const stoodDown = hirelingRuntime.standDown(null, contract, { nowMs: atMs });
          if (stoodDown && stoodDown.success === true) {
            if (!bookmarkLifecycle) bookmarkLifecycle = getDefaultBookmarkLifecycle();
            const bookmarkResult = bookmarkLifecycle.removeContractBookmark(
              contract,
              { config },
            );
            if (!bookmarkResult || bookmarkResult.success !== true) {
              return bookmarkResult || {
                success: false,
                errorMsg: "INDUSTRIAL_HIRELING_BOOKMARK_REMOVE_FAILED",
              };
            }
          }
          return stoodDown;
        },
        afterArchive(contract) {
          if (typeof hirelingRuntime.releaseContractPresence === "function") {
            hirelingRuntime.releaseContractPresence(contract);
          }
        },
      });
      // Navigation advances inside reconcileExpired's shared lifecycle pass.
      // Rebuild pilot presence afterward so Local and the command map observe
      // the crew's newly persisted system in this same scheduler tick.
      const identityResult =
        typeof hirelingRuntime.reconcileIdentityPresence === "function"
          ? hirelingRuntime.reconcileIdentityPresence({ nowMs })
          : { success: true, data: { skipped: true } };
      const failures = [];
      if (!identityResult || identityResult.success !== true) {
        failures.push(
          identityResult && identityResult.errorMsg ||
          "INDUSTRIAL_HIRELING_IDENTITY_RECONCILE_FAILED",
        );
      }
      if (!cargoResult || cargoResult.success !== true) {
        failures.push(
          cargoResult && cargoResult.errorMsg ||
          "INDUSTRIAL_HIRELING_CARGO_RECONCILE_FAILED",
        );
      }
      if (!expiryResult || expiryResult.success !== true) {
        failures.push(
          expiryResult && expiryResult.errorMsg ||
          "INDUSTRIAL_HIRELING_EXPIRY_RECONCILE_FAILED",
        );
      }
      const success = failures.length === 0;
      if (!success) {
        reportError(new Error(failures.join(", ")));
      }
      return {
        success,
        errorMsg: success
          ? null
          : "INDUSTRIAL_HIRELING_SCHEDULER_RECONCILE_FAILED",
        data: {
          identity: identityResult && identityResult.data || null,
          cargo: cargoResult && cargoResult.data || null,
          expiry: expiryResult && expiryResult.data || null,
          failures,
        },
      };
    } catch (error) {
      reportError(error);
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_SCHEDULER_FAILED",
      };
    } finally {
      passRunning = false;
    }
  }

  function start() {
    if (!isEnabled()) {
      return { success: true, data: { enabled: false, started: false } };
    }
    if (timer) {
      return { success: true, data: { enabled: true, started: false, reused: true } };
    }
    const intervalMs = Math.max(
      1_000,
      Math.trunc(Number(config.industrialHirelingsSchedulerIntervalMs) || 5_000),
    );
    timer = setIntervalFn(runPass, intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    runPass();
    return { success: true, data: { enabled: true, started: true, intervalMs } };
  }

  function stop() {
    if (timer) clearIntervalFn(timer);
    timer = null;
    return { success: true };
  }

  return Object.freeze({
    isEnabled,
    isRunning: () => Boolean(timer),
    runPass,
    start,
    stop,
  });
}

let defaultScheduler = null;
function getDefaultIndustrialHirelingScheduler() {
  if (!defaultScheduler) defaultScheduler = createIndustrialHirelingScheduler();
  return defaultScheduler;
}

function startDefaultIndustrialHirelingScheduler() {
  return getDefaultIndustrialHirelingScheduler().start();
}

module.exports = {
  createIndustrialHirelingScheduler,
  getDefaultIndustrialHirelingScheduler,
  startDefaultIndustrialHirelingScheduler,
};
