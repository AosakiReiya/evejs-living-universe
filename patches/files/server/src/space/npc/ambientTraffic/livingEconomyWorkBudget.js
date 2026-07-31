"use strict";

const { performance } = require("perf_hooks");

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createWorkBudget(options = {}) {
  const budgetMs = Math.max(0.5, toFiniteNumber(options.budgetMs, 4));
  const onYield = typeof options.onYield === "function" ? options.onYield : null;
  const startedAtMs = performance.now();
  let sliceStartedAtMs = startedAtMs;
  let checkpoints = 0;
  let yields = 0;
  let maximumSliceMs = 0;
  let externalWaits = 0;
  let totalExternalWaitMs = 0;
  let maximumExternalWaitMs = 0;
  const externalWaitsByLabel = {};
  const stages = {};

  function closeActiveSlice(nowMs = performance.now()) {
    const sliceMs = Math.max(0, nowMs - sliceStartedAtMs);
    maximumSliceMs = Math.max(maximumSliceMs, sliceMs);
    return sliceMs;
  }

  async function checkpoint(force = false) {
    checkpoints += 1;
    const nowMs = performance.now();
    const sliceMs = Math.max(0, nowMs - sliceStartedAtMs);
    if (!force && sliceMs < budgetMs) {
      return false;
    }
    closeActiveSlice(nowMs);
    yields += 1;
    if (onYield) {
      onYield({ sliceMs, yields, checkpoints });
    }
    await yieldToEventLoop();
    sliceStartedAtMs = performance.now();
    return true;
  }

  async function waitFor(label, operation) {
    const waitLabel = String(label || "external");
    closeActiveSlice();
    const waitStartedAtMs = performance.now();
    try {
      return await (typeof operation === "function" ? operation() : operation);
    } finally {
      const resumedAtMs = performance.now();
      const waitMs = Math.max(0, resumedAtMs - waitStartedAtMs);
      externalWaits += 1;
      totalExternalWaitMs += waitMs;
      maximumExternalWaitMs = Math.max(maximumExternalWaitMs, waitMs);
      const existing = externalWaitsByLabel[waitLabel] || {
        waits: 0,
        totalWaitMs: 0,
        maximumWaitMs: 0,
      };
      existing.waits += 1;
      existing.totalWaitMs += waitMs;
      existing.maximumWaitMs = Math.max(existing.maximumWaitMs, waitMs);
      externalWaitsByLabel[waitLabel] = existing;
      // Time spent awaiting another service is wall latency, not an
      // uninterrupted JavaScript slice. Start a fresh CPU slice on resume.
      sliceStartedAtMs = resumedAtMs;
    }
  }

  async function runStage(name, operation) {
    const stageName = String(name || "unnamed");
    const stageStartedAtMs = performance.now();
    const yieldsBefore = yields;
    const waitsBefore = externalWaits;
    const waitMsBefore = totalExternalWaitMs;
    try {
      return await operation();
    } finally {
      const wallDurationMs = Math.max(0, performance.now() - stageStartedAtMs);
      const existing = stages[stageName] || {
        calls: 0,
        totalWallDurationMs: 0,
        maximumWallDurationMs: 0,
        cooperativeYields: 0,
        externalWaits: 0,
        externalWaitMs: 0,
      };
      existing.calls += 1;
      existing.totalWallDurationMs += wallDurationMs;
      existing.maximumWallDurationMs = Math.max(existing.maximumWallDurationMs, wallDurationMs);
      existing.cooperativeYields += yields - yieldsBefore;
      existing.externalWaits += externalWaits - waitsBefore;
      existing.externalWaitMs += totalExternalWaitMs - waitMsBefore;
      stages[stageName] = existing;
    }
  }

  function finish() {
    const nowMs = performance.now();
    closeActiveSlice(nowMs);
    return {
      budgetMs,
      checkpoints,
      yields,
      maximumSliceMs,
      externalWaits,
      totalExternalWaitMs,
      maximumExternalWaitMs,
      externalWaitsByLabel,
      stages,
      wallDurationMs: Math.max(0, nowMs - startedAtMs),
    };
  }

  return {
    budgetMs,
    checkpoint,
    waitFor,
    runStage,
    finish,
  };
}

module.exports = {
  createWorkBudget,
  yieldToEventLoop,
};
