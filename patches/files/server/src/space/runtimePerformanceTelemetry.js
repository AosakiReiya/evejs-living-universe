"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  PerformanceObserver,
  constants: performanceConstants,
  performance,
} = require("perf_hooks");

const log = require(path.join(__dirname, "../utils/logger"));

const CAPTURE_INTERVAL_MS = 10_000;
const COMMUNITY_BASELINE_MS = 100;
const CAPACITY_WARNING_MS = 120;
const CAPACITY_SOFT_LIMIT_MS = 130;
const CAPACITY_HARD_LIMIT_MS = CAPACITY_SOFT_LIMIT_MS;
const CAPACITY_EMERGENCY_SHED_MS = 500;
const CAPACITY_UNPLAYABLE_MS = 600;
const CAPACITY_MINIMUM_SAMPLES = 20;
const GC_RECENT_SAMPLE_LIMIT = 128;
const CONFIGURED_OUTPUT_DIR = String(
  process.env.EVEJS_RUNTIME_PERFORMANCE_DIR || "",
).trim();
const CONFIGURED_DATA_ROOT = String(process.env.EVEJS_DATA_ROOT || "").trim();
const OUTPUT_DIR = CONFIGURED_OUTPUT_DIR
  ? path.resolve(CONFIGURED_OUTPUT_DIR)
  : CONFIGURED_DATA_ROOT
    ? path.resolve(CONFIGURED_DATA_ROOT, "runtime-performance")
    : path.join(__dirname, "../../../_local/runtime-performance");
const LATEST_PATH = path.join(OUTPUT_DIR, "latest.json");

let lastCaptureAtMs = 0;
let writeInFlight = false;
let lastWriteError = "";
let lastResourceSample = null;
let cumulativeWriteSkips = 0;

const GC_KIND_NAMES = Object.freeze({
  [performanceConstants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [performanceConstants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [performanceConstants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [performanceConstants.NODE_PERFORMANCE_GC_WEAKCB]: "weakCallback",
});

function createEmptyGcKindSummary() {
  return {
    minor: { count: 0, totalDurationMs: 0, maximumDurationMs: 0 },
    major: { count: 0, totalDurationMs: 0, maximumDurationMs: 0 },
    incremental: { count: 0, totalDurationMs: 0, maximumDurationMs: 0 },
    weakCallback: { count: 0, totalDurationMs: 0, maximumDurationMs: 0 },
    unknown: { count: 0, totalDurationMs: 0, maximumDurationMs: 0 },
  };
}

function getGcKindName(kind) {
  return GC_KIND_NAMES[Math.trunc(toFiniteNumber(kind, -1))] || "unknown";
}

function addGcKindSample(summary, kind, durationMs) {
  const target = summary[getGcKindName(kind)] || summary.unknown;
  target.count += 1;
  target.totalDurationMs += durationMs;
  target.maximumDurationMs = Math.max(target.maximumDurationMs, durationMs);
}

function roundGcKindSummary(summary) {
  return Object.fromEntries(
    Object.entries(summary).map(([kind, values]) => [
      kind,
      {
        count: values.count,
        totalDurationMs: round(values.totalDurationMs),
        maximumDurationMs: round(values.maximumDurationMs),
      },
    ]),
  );
}

function createGcAccumulator(sampleLimit = GC_RECENT_SAMPLE_LIMIT) {
  const limit = Math.max(1, Math.trunc(toFiniteNumber(sampleLimit, GC_RECENT_SAMPLE_LIMIT)));
  const recentDurationsMs = new Float64Array(limit);
  const recentKinds = new Uint8Array(limit);
  const cumulativeKinds = createEmptyGcKindSummary();
  let cumulativeCount = 0;
  let cumulativeDurationMs = 0;
  let cumulativeMaximumDurationMs = 0;
  let recentCount = 0;
  let recentWriteIndex = 0;
  let lastObservedAtMs = 0;

  return {
    record(durationValue, kindValue, observedAtMs = Date.now()) {
      const durationMs = Math.max(0, toFiniteNumber(durationValue, 0));
      const kind = Math.max(0, Math.trunc(toFiniteNumber(kindValue, 0)));
      cumulativeCount += 1;
      cumulativeDurationMs += durationMs;
      cumulativeMaximumDurationMs = Math.max(cumulativeMaximumDurationMs, durationMs);
      addGcKindSample(cumulativeKinds, kind, durationMs);
      recentDurationsMs[recentWriteIndex] = durationMs;
      recentKinds[recentWriteIndex] = kind;
      recentWriteIndex = (recentWriteIndex + 1) % limit;
      recentCount = Math.min(limit, recentCount + 1);
      lastObservedAtMs = Math.max(lastObservedAtMs, Math.trunc(toFiniteNumber(observedAtMs, 0)));
    },
    summarize() {
      const durations = [];
      const recentKindSummary = createEmptyGcKindSummary();
      const oldestIndex = recentCount < limit ? 0 : recentWriteIndex;
      for (let offset = 0; offset < recentCount; offset += 1) {
        const index = (oldestIndex + offset) % limit;
        const durationMs = recentDurationsMs[index];
        durations.push(durationMs);
        addGcKindSample(recentKindSummary, recentKinds[index], durationMs);
      }
      const recent = summarizeValues(durations);
      return {
        retainedSampleLimit: limit,
        lastObservedAtMs,
        cumulative: {
          count: cumulativeCount,
          totalDurationMs: round(cumulativeDurationMs),
          maximumDurationMs: round(cumulativeMaximumDurationMs),
          kinds: roundGcKindSummary(cumulativeKinds),
        },
        recent: {
          count: recent.samples,
          totalDurationMs: round(durations.reduce((sum, value) => sum + value, 0)),
          averageDurationMs: recent.average,
          p95DurationMs: recent.p95,
          maximumDurationMs: recent.maximum,
          kinds: roundGcKindSummary(recentKindSummary),
        },
      };
    },
  };
}

const gcAccumulator = createGcAccumulator();
let gcObserverActive = false;
let gcObserverError = "";
let gcObserver = null;

function initializeGcObserver() {
  try {
    const supportedEntryTypes = Array.isArray(PerformanceObserver.supportedEntryTypes)
      ? PerformanceObserver.supportedEntryTypes
      : [];
    if (!supportedEntryTypes.includes("gc")) {
      gcObserverError = "gc performance entries are not supported by this Node.js runtime";
      return;
    }
    gcObserver = new PerformanceObserver((list) => {
      const observedAtMs = Date.now();
      for (const entry of list.getEntries()) {
        const detailKind = entry && entry.detail && entry.detail.kind;
        const kind = Number.isFinite(detailKind) ? detailKind : entry && entry.kind;
        gcAccumulator.record(entry && entry.duration, kind, observedAtMs);
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
    gcObserverActive = true;
  } catch (error) {
    gcObserverError = error.message;
    gcObserver = null;
  }
}

initializeGcObserver();

function buildGcSummary() {
  return {
    available: gcObserverActive,
    observerActive: gcObserverActive,
    observerError: gcObserverError,
    ...gcAccumulator.summarize(),
  };
}

function buildCaptureSummary(
  buildDurationMs,
  writeInFlightAtCapture = false,
  writeSkipCount = 0,
) {
  const writeSkipped = writeInFlightAtCapture === true;
  return {
    configuredIntervalMs: CAPTURE_INTERVAL_MS,
    buildDurationMs: round(Math.max(0, toFiniteNumber(buildDurationMs, 0))),
    writeInFlightAtCapture: writeSkipped,
    writeSkipped,
    cumulativeWriteSkips: Math.max(0, Math.trunc(toFiniteNumber(writeSkipCount, 0))),
  };
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function round(value, digits = 3) {
  const scale = 10 ** digits;
  return Math.round(toFiniteNumber(value, 0) * scale) / scale;
}

function percentile(values, fraction) {
  const sorted = (Array.isArray(values) ? values : [])
    .map((value) => toFiniteNumber(value, 0))
    .sort((left, right) => left - right);
  if (sorted.length <= 0) return 0;
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1),
  );
  return sorted[index];
}

function summarizeValues(values) {
  const samples = (Array.isArray(values) ? values : [])
    .map((value) => Math.max(0, toFiniteNumber(value, 0)));
  if (samples.length <= 0) {
    return { samples: 0, average: 0, p95: 0, maximum: 0 };
  }
  return {
    samples: samples.length,
    average: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
    p95: round(percentile(samples, 0.95)),
    maximum: round(Math.max(...samples)),
  };
}

function summarizeRuntimeTicks(runtime) {
  const records = Array.isArray(runtime && runtime._recentTickSummaries)
    ? runtime._recentTickSummaries.slice(-120)
    : [];
  const targetMs = records.length > 0
    ? Math.max(1, toFiniteNumber(records[records.length - 1].targetTickIntervalMs, 100))
    : 100;
  const interval = summarizeValues(records.map((record) => record.actualIntervalMs));
  const work = summarizeValues(records.map((record) => record.tickDurationMs));
  return {
    targetMs,
    intervalMs: {
      ...interval,
      averageFromBaseline: round(interval.average - targetMs),
      p95FromBaseline: round(interval.p95 - targetMs),
      maximumFromBaseline: round(interval.maximum - targetMs),
    },
    workMs: work,
    latest: records.length > 0 ? { ...records[records.length - 1] } : null,
  };
}

function summarizeScenes(runtime) {
  return [...(runtime && runtime.scenes instanceof Map ? runtime.scenes.values() : [])]
    .map((scene) => {
      const recentWork = summarizeValues(
        Array.isArray(scene && scene._recentTickWorkMs)
          ? scene._recentTickWorkMs.slice(-120)
          : [],
      );
      return {
        systemID: Math.trunc(toFiniteNumber(scene && scene.systemID, 0)),
        playerSessions: scene && scene.sessions instanceof Map ? scene.sessions.size : 0,
        dynamicEntities: scene && scene.dynamicEntities instanceof Map
          ? scene.dynamicEntities.size
          : 0,
        tickWorkMs: recentWork,
      };
    })
    .sort((left, right) => left.systemID - right.systemID);
}

function aggregateHostCpuTimes(cpus = os.cpus()) {
  return (Array.isArray(cpus) ? cpus : []).reduce((summary, cpu) => {
    const times = cpu && cpu.times || {};
    const idle = Math.max(0, toFiniteNumber(times.idle, 0));
    const total = Object.values(times).reduce(
      (sum, value) => sum + Math.max(0, toFiniteNumber(value, 0)),
      0,
    );
    summary.idleMs += idle;
    summary.totalMs += total;
    return summary;
  }, { idleMs: 0, totalMs: 0 });
}

function sampleResources(nowMs = Date.now()) {
  const logicalProcessors = Math.max(1, (os.cpus() || []).length);
  const processUsage = process.cpuUsage();
  const hostTimes = aggregateHostCpuTimes();
  const eventLoop = typeof performance.eventLoopUtilization === "function"
    ? performance.eventLoopUtilization()
    : null;
  const current = {
    capturedAtMs: nowMs,
    processUsage,
    hostTimes,
    eventLoop,
  };
  const previous = lastResourceSample;
  lastResourceSample = current;

  const cumulativeUserSeconds = round(processUsage.user / 1_000_000, 6);
  const cumulativeSystemSeconds = round(processUsage.system / 1_000_000, 6);
  const base = {
    available: false,
    logicalProcessors,
    sampleWindowMs: 0,
    oneCorePercent: 0,
    machinePercent: 0,
    userPercentOfOneCore: 0,
    systemPercentOfOneCore: 0,
    eventLoopUtilizationPercent: 0,
    cumulativeUserSeconds,
    cumulativeSystemSeconds,
    cumulativeTotalSeconds: round(cumulativeUserSeconds + cumulativeSystemSeconds, 6),
  };
  if (!previous) {
    return {
      processCpu: base,
      hostCpu: {
        available: false,
        logicalProcessors,
        sampleWindowMs: 0,
        utilizationPercent: 0,
      },
    };
  }

  const elapsedMs = Math.max(1, nowMs - previous.capturedAtMs);
  const deltaUserUs = Math.max(0, processUsage.user - previous.processUsage.user);
  const deltaSystemUs = Math.max(0, processUsage.system - previous.processUsage.system);
  const elapsedUs = elapsedMs * 1_000;
  const userPercentOfOneCore = (deltaUserUs / elapsedUs) * 100;
  const systemPercentOfOneCore = (deltaSystemUs / elapsedUs) * 100;
  const oneCorePercent = userPercentOfOneCore + systemPercentOfOneCore;
  const hostTotalDeltaMs = Math.max(0, hostTimes.totalMs - previous.hostTimes.totalMs);
  const hostIdleDeltaMs = Math.max(0, hostTimes.idleMs - previous.hostTimes.idleMs);
  const hostBusyDeltaMs = Math.max(0, hostTotalDeltaMs - hostIdleDeltaMs);
  const eventLoopActiveDelta = eventLoop && previous.eventLoop
    ? Math.max(0, eventLoop.active - previous.eventLoop.active)
    : 0;
  const eventLoopIdleDelta = eventLoop && previous.eventLoop
    ? Math.max(0, eventLoop.idle - previous.eventLoop.idle)
    : 0;
  const eventLoopTotalDelta = eventLoopActiveDelta + eventLoopIdleDelta;

  return {
    processCpu: {
      ...base,
      available: true,
      sampleWindowMs: elapsedMs,
      oneCorePercent: round(oneCorePercent),
      machinePercent: round(oneCorePercent / logicalProcessors),
      userPercentOfOneCore: round(userPercentOfOneCore),
      systemPercentOfOneCore: round(systemPercentOfOneCore),
      eventLoopUtilizationPercent: round(
        eventLoopTotalDelta > 0 ? (eventLoopActiveDelta / eventLoopTotalDelta) * 100 : 0,
      ),
    },
    hostCpu: {
      available: hostTotalDeltaMs > 0,
      logicalProcessors,
      sampleWindowMs: elapsedMs,
      utilizationPercent: round(
        hostTotalDeltaMs > 0 ? (hostBusyDeltaMs / hostTotalDeltaMs) * 100 : 0,
      ),
    },
  };
}

function buildLivingUniverseSummary(nowMs) {
  try {
    const livingUniverseRuntime = require(path.join(
      __dirname,
      "./npc/ambientTraffic/livingUniverseRuntime",
    ));
    const status = livingUniverseRuntime.getStatus(nowMs);
    return {
      enabled: status.enabled,
      actorCount: status.actorCount,
      flightCount: status.flightCount,
      materializedShips: status.materializedShips,
      materializedSystems: status.materializedSystems,
      physicalBudget: status.physicalBudget,
      offGridAcceleration: status.offGridAcceleration,
      replacementHolds: status.replacementHolds,
      replacementCoverage: status.replacementCoverage,
      campaigns: status.campaigns,
      phases: status.phases,
      metrics: status.metrics,
      // Resident track R1: per-player hostility and kill-credit observability for stress
      // sampling and dashboards.
      hostility: status.hostility,
      killCredit: status.killCredit,
      scheduler: status.scheduler,
      persistenceIntervalMs: status.persistenceIntervalMs,
      persistence: status.persistence,
      conflict: status.conflict,
      economy: {
        enabled: status.economy && status.economy.enabled,
        activeJobs: status.economy && status.economy.activeJobs,
        metrics: status.economy && status.economy.metrics,
        mobilization: status.economy && status.economy.mobilization,
        lastPulseError: status.economy && status.economy.lastPulseError,
        pulseTiming: status.economy && status.economy.pulseTiming,
        stockRows: status.economy && status.economy.stockRows,
        stockCache: status.economy && status.economy.stockCache,
        routePlanning: status.economy && status.economy.routePlanning,
        marketBatches: status.economy && status.economy.marketBatches,
        eventBridge: status.economy && status.economy.eventBridge,
        procurement: status.economy && status.economy.procurement,
        industry: status.economy && status.economy.industry,
        replacements: status.economy && status.economy.replacements,
        freight: status.economy && status.economy.freight,
        campaignSupply: status.economy && status.economy.campaignSupply,
        salvage: status.economy && status.economy.salvage,
        demandCoverage: status.economy && status.economy.demandCoverage,
      },
    };
  } catch (error) {
    return { error: error.message };
  }
}

function buildXEveSummary() {
  try {
    return require(path.join(__dirname, "../services/xEve/xEveRuntime")).getSnapshot();
  } catch (error) {
    return { error: error.message };
  }
}

function buildCapacitySummary(runtimeTick) {
  const p95IntervalMs = toFiniteNumber(runtimeTick && runtimeTick.intervalMs && runtimeTick.intervalMs.p95, 0);
  const maximumIntervalMs = toFiniteNumber(
    runtimeTick && runtimeTick.intervalMs && runtimeTick.intervalMs.maximum,
    0,
  );
  const sampleCount = Math.max(
    0,
    Math.trunc(toFiniteNumber(runtimeTick && runtimeTick.intervalMs && runtimeTick.intervalMs.samples, 0)),
  );
  return {
    baselineMs: COMMUNITY_BASELINE_MS,
    warningMs: CAPACITY_WARNING_MS,
    softLimitMs: CAPACITY_SOFT_LIMIT_MS,
    hardLimitMs: CAPACITY_HARD_LIMIT_MS,
    emergencyShedMs: CAPACITY_EMERGENCY_SHED_MS,
    unplayableMs: CAPACITY_UNPLAYABLE_MS,
    minimumSamples: CAPACITY_MINIMUM_SAMPLES,
    sampleCount,
    status: maximumIntervalMs >= CAPACITY_UNPLAYABLE_MS
      ? "unplayable"
      : maximumIntervalMs >= CAPACITY_EMERGENCY_SHED_MS
        ? "emergency_shed"
        : sampleCount < CAPACITY_MINIMUM_SAMPLES
          ? "warming"
          : p95IntervalMs >= CAPACITY_SOFT_LIMIT_MS
            ? "soft_limit"
            : p95IntervalMs >= CAPACITY_WARNING_MS
              ? "warning"
              : "healthy",
    p95IntervalMs,
    maximumIntervalMs,
    p95FromBaselineMs: round(p95IntervalMs - COMMUNITY_BASELINE_MS),
    p95HeadroomToWarningMs: round(CAPACITY_WARNING_MS - p95IntervalMs),
    p95HeadroomToHardLimitMs: round(CAPACITY_HARD_LIMIT_MS - p95IntervalMs),
    p95HeadroomToEmergencyShedMs: round(CAPACITY_EMERGENCY_SHED_MS - p95IntervalMs),
    p95HeadroomToUnplayableMs: round(CAPACITY_UNPLAYABLE_MS - p95IntervalMs),
    maximumHeadroomToEmergencyShedMs: round(
      CAPACITY_EMERGENCY_SHED_MS - maximumIntervalMs,
    ),
    maximumHeadroomToUnplayableMs: round(CAPACITY_UNPLAYABLE_MS - maximumIntervalMs),
  };
}

function buildSnapshot(runtime, nowMs = Date.now()) {
  const memory = process.memoryUsage();
  const resources = sampleResources(nowMs);
  const runtimeTick = summarizeRuntimeTicks(runtime);
  return {
    schemaVersion: 3,
    capturedAtMs: nowMs,
    capturedAt: new Date(nowMs).toISOString(),
    timezoneOffsetMinutes: new Date(nowMs).getTimezoneOffset(),
    process: {
      pid: process.pid,
      uptimeSeconds: round(process.uptime()),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      cpu: resources.processCpu,
      gc: buildGcSummary(),
    },
    host: {
      cpu: resources.hostCpu,
      loadAverage: os.loadavg().map((value) => round(value)),
    },
    runtimeTick,
    capacity: buildCapacitySummary(runtimeTick),
    scenes: summarizeScenes(runtime),
    livingUniverse: buildLivingUniverseSummary(nowMs),
    xEve: buildXEveSummary(),
  };
}

function getLocalDayKey(nowMs) {
  const date = new Date(nowMs);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function queueWrite(snapshot) {
  if (writeInFlight) return;
  writeInFlight = true;
  const historyPath = path.join(
    OUTPUT_DIR,
    `runtime-performance-${getLocalDayKey(snapshot.capturedAtMs)}.jsonl`,
  );
  const pretty = `${JSON.stringify(snapshot, null, 2)}\n`;
  const compact = `${JSON.stringify(snapshot)}\n`;
  fs.promises.mkdir(OUTPUT_DIR, { recursive: true })
    .then(() => Promise.all([
      fs.promises.writeFile(LATEST_PATH, pretty, "utf8"),
      fs.promises.appendFile(historyPath, compact, "utf8"),
    ]))
    .then(() => {
      lastWriteError = "";
    })
    .catch((error) => {
      if (lastWriteError !== error.message) {
        log.warn(`[RuntimePerformance] Snapshot write failed: ${error.message}`);
      }
      lastWriteError = error.message;
    })
    .finally(() => {
      writeInFlight = false;
    });
}

function maybeCapture(runtime, nowMs = Date.now()) {
  const now = Math.max(0, toFiniteNumber(nowMs, Date.now()));
  if (now - lastCaptureAtMs < CAPTURE_INTERVAL_MS) return null;
  lastCaptureAtMs = now;
  const writeInFlightAtCapture = writeInFlight;
  const buildStartedAtMs = performance.now();
  const snapshot = buildSnapshot(runtime, now);
  const buildDurationMs = performance.now() - buildStartedAtMs;
  if (writeInFlightAtCapture) cumulativeWriteSkips += 1;
  snapshot.capture = buildCaptureSummary(
    buildDurationMs,
    writeInFlightAtCapture,
    cumulativeWriteSkips,
  );
  queueWrite(snapshot);
  return snapshot;
}

module.exports = {
  CAPTURE_INTERVAL_MS,
  COMMUNITY_BASELINE_MS,
  CAPACITY_WARNING_MS,
  CAPACITY_SOFT_LIMIT_MS,
  CAPACITY_HARD_LIMIT_MS,
  CAPACITY_EMERGENCY_SHED_MS,
  CAPACITY_UNPLAYABLE_MS,
  CAPACITY_MINIMUM_SAMPLES,
  LATEST_PATH,
  buildSnapshot,
  maybeCapture,
  _testing: {
    aggregateHostCpuTimes,
    buildCapacitySummary,
    buildCaptureSummary,
    buildGcSummary,
    createGcAccumulator,
    getGcKindName,
    percentile,
    sampleResources,
    summarizeValues,
    summarizeRuntimeTicks,
    resetResourceSample() {
      lastResourceSample = null;
    },
  },
};
