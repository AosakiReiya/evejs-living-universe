"use strict";

// War economy mobilization (slice W1): the one place in the living economy that
// reads replacement-backlog pressure and RAISES throughput caps in response.
//
// Every prior demand-responsive mechanism (war-premium bids, the 75/25 freight
// lane, demand-capped shipyard seeding, age-triggered smugglers) re-prioritizes
// within static caps; none of them changes a cap. The result at 1x is a
// destruction rate (~190 replacement packages/hour with the full fleet flying)
// that structurally outruns supply (~10-20/hour), so the universe self-throttles
// by grounding flights. This controller closes that gap from the supply side —
// conflict pacing is deliberately never touched.
//
// Model: a mobilization LEVEL in [0, 1] chases a PRESSURE signal with
// asymmetric slew (fast ramp-up, slow stand-down = hysteresis without a state
// machine). Pressure is the max of three normalized terms: backlog size,
// oldest-pending age, and the demand creation:fulfillment rate ratio over a
// sliding window. Consumers interpolate their caps between the configured
// peacetime base and a surge value by the level (freight — the #1 verified
// binder — uses a doubled ramp so it surges first), always inside the existing
// hard clamps so no downstream invariant moves.
//
// The level is deliberately NOT persisted: the backlog that drives it is
// persistent, so after a restart the level re-derives within minutes; storing
// it would only add migration surface.

const path = require("path");

const config = require(path.join(__dirname, "../../../config"));

// Sliding window for the creation/fulfillment rate term. Neither rate branch
// is trusted until the window spans at least the minimum — a 15-second window
// after boot or a pulse stall would otherwise read one empty gap as pressure.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MINIMUM_SPAN_MS = 2 * 60 * 1000;
const RATE_SAMPLE_MIN_SPACING_MS = 5 * 1000;
const RATE_MAX_SAMPLES = 200;

// Pressure-term shape constants (signal values that map to term = 0 and = 1).
const AGE_TERM_FLOOR_MS = 15 * 60 * 1000;
const AGE_TERM_CEILING_MS = 60 * 60 * 1000;
const RATE_TERM_FLOOR_RATIO = 1.2;
const RATE_TERM_CEILING_RATIO = 4;
// Below this many observed fulfillments in the window the rate term is not
// trusted (warmup / tiny denominators) and contributes 0.
const RATE_TERM_MINIMUM_FULFILLED = 2;

let state = null;

function buildDefaultState() {
  return {
    level: 0,
    pressure: 0,
    terms: { backlog: 0, age: 0, rate: 0 },
    lastUpdateAtMs: 0,
    fullSinceMs: 0,
    samples: [],
    inputs: {
      pendingPackages: 0,
      oldestPendingAgeMs: 0,
      createdPerHour: 0,
      fulfilledPerHour: 0,
    },
    metrics: {
      activations: 0,
      standDowns: 0,
      msAtFullLevel: 0,
    },
  };
}

function ensureState() {
  if (!state) state = buildDefaultState();
  return state;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function isEnabled() {
  return config.livingEconomyMobilizationEnabled !== false;
}

function getTargetBacklogPackages() {
  return clamp(toFiniteNumber(config.livingEconomyMobilizationTargetBacklogPackages, 30), 5, 500);
}

function getFullBacklogPackages() {
  // Always strictly above the target so the backlog term has a real ramp.
  return Math.max(
    getTargetBacklogPackages() + 5,
    clamp(toFiniteNumber(config.livingEconomyMobilizationFullBacklogPackages, 120), 10, 2_000),
  );
}

function getMobilizeSlewPerMinute() {
  return clamp(toFiniteNumber(config.livingEconomyMobilizationSlewPerMinute, 0.1), 0.01, 1);
}

function getStandDownSlewPerMinute() {
  return clamp(
    toFiniteNumber(config.livingEconomyMobilizationStandDownSlewPerMinute, 0.033),
    0.005,
    1,
  );
}

function getMaxLevel() {
  return clamp(toFiniteNumber(config.livingEconomyMobilizationMaxLevel, 1), 0, 1);
}

function getWarTimeScaleFloor() {
  return clamp(toFiniteNumber(config.livingEconomyMobilizationWarTimeScaleFactor, 0.1), 0.02, 1);
}

// Normalize a signal onto [0,1] between floor (term 0) and ceiling (term 1).
function normalizeTerm(value, floor, ceiling) {
  if (!(ceiling > floor)) return 0;
  return clamp((toFiniteNumber(value, 0) - floor) / (ceiling - floor), 0, 1);
}

function pruneSamples(samples, nowMs) {
  while (samples.length > 0 && nowMs - samples[0].atMs > RATE_WINDOW_MS) {
    samples.shift();
  }
  while (samples.length > RATE_MAX_SAMPLES) {
    samples.shift();
  }
}

// One controller step. Inputs come from the economy pulse (cheap aggregates):
//   pendingPackages     — count of pending replacement demands
//   oldestPendingAgeMs  — age of the oldest pending demand
//   demandsCreatedTotal — cumulative metrics counter
//   demandsFulfilledTotal — cumulative metrics counter
function update(inputs, nowMs = Date.now()) {
  const current = ensureState();
  if (!isEnabled()) {
    current.level = 0;
    current.pressure = 0;
    current.terms = { backlog: 0, age: 0, rate: 0 };
    current.lastUpdateAtMs = nowMs;
    current.fullSinceMs = 0;
    return getStatus();
  }

  const pendingPackages = Math.max(0, toFiniteNumber(inputs && inputs.pendingPackages, 0));
  const oldestPendingAgeMs = Math.max(0, toFiniteNumber(inputs && inputs.oldestPendingAgeMs, 0));
  const createdTotal = Math.max(0, toFiniteNumber(inputs && inputs.demandsCreatedTotal, 0));
  const fulfilledTotal = Math.max(0, toFiniteNumber(inputs && inputs.demandsFulfilledTotal, 0));

  // Rate window bookkeeping.
  const samples = current.samples;
  const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;
  if (!lastSample || nowMs - lastSample.atMs >= RATE_SAMPLE_MIN_SPACING_MS) {
    samples.push({ atMs: nowMs, created: createdTotal, fulfilled: fulfilledTotal });
  }
  pruneSamples(samples, nowMs);

  let createdPerHour = 0;
  let fulfilledPerHour = 0;
  let rateTerm = 0;
  if (
    samples.length >= 2 &&
    samples[samples.length - 1].atMs - samples[0].atMs >= RATE_MINIMUM_SPAN_MS
  ) {
    const first = samples[0];
    const last = samples[samples.length - 1];
    const spanMs = Math.max(1, last.atMs - first.atMs);
    // Counters are cumulative; a restart resets them, which shows up as a
    // negative delta — treat that window as unknown rather than as pressure.
    const createdDelta = last.created - first.created;
    const fulfilledDelta = last.fulfilled - first.fulfilled;
    if (createdDelta >= 0 && fulfilledDelta >= 0) {
      createdPerHour = (createdDelta * 3_600_000) / spanMs;
      fulfilledPerHour = (fulfilledDelta * 3_600_000) / spanMs;
      if (fulfilledDelta >= RATE_TERM_MINIMUM_FULFILLED && fulfilledPerHour > 0) {
        rateTerm = normalizeTerm(
          createdPerHour / fulfilledPerHour,
          RATE_TERM_FLOOR_RATIO,
          RATE_TERM_CEILING_RATIO,
        );
      } else if (createdPerHour > 0 && pendingPackages > getTargetBacklogPackages()) {
        // Demand flowing, nothing fulfilling, backlog above target: that IS
        // maximal rate pressure even though the ratio is undefined.
        rateTerm = 1;
      }
    }
  }

  const backlogTerm = normalizeTerm(
    pendingPackages,
    getTargetBacklogPackages(),
    getFullBacklogPackages(),
  );
  const ageTerm = normalizeTerm(oldestPendingAgeMs, AGE_TERM_FLOOR_MS, AGE_TERM_CEILING_MS);
  const pressure = Math.min(getMaxLevel(), Math.max(backlogTerm, ageTerm, rateTerm));

  // Asymmetric slew toward the pressure target.
  const elapsedMinutes = current.lastUpdateAtMs > 0
    ? clamp((nowMs - current.lastUpdateAtMs) / 60_000, 0, 10)
    : 0;
  const previousLevel = current.level;
  let level = previousLevel;
  if (pressure > level) {
    level = Math.min(pressure, level + getMobilizeSlewPerMinute() * elapsedMinutes);
  } else if (pressure < level) {
    level = Math.max(pressure, level - getStandDownSlewPerMinute() * elapsedMinutes);
  }
  level = clamp(level, 0, getMaxLevel());

  if (previousLevel < 0.5 && level >= 0.5) current.metrics.activations += 1;
  if (previousLevel >= 0.5 && level < 0.5) current.metrics.standDowns += 1;
  if (level >= 0.999) {
    if (!current.fullSinceMs) current.fullSinceMs = nowMs;
    if (current.lastUpdateAtMs > 0) {
      current.metrics.msAtFullLevel += Math.max(0, nowMs - current.lastUpdateAtMs);
    }
  } else {
    current.fullSinceMs = 0;
  }

  current.level = level;
  current.pressure = pressure;
  current.terms = { backlog: backlogTerm, age: ageTerm, rate: rateTerm };
  current.inputs = { pendingPackages, oldestPendingAgeMs, createdPerHour, fulfilledPerHour };
  current.lastUpdateAtMs = nowMs;
  return getStatus();
}

function getLevel() {
  return isEnabled() ? clamp(ensureState().level, 0, 1) : 0;
}

// Freight is the verified #1 binder: it surges at double the ramp so freight
// capacity leads the mobilization and industry follows into a fed pipeline.
// The MaxLevel operator throttle caps this ramp too — "0.5 permits half of
// every surge delta" must hold for the freight levers, not just industry.
function getFreightRamp() {
  return clamp(Math.min(getMaxLevel(), getLevel() * 2), 0, 1);
}

function getIndustryRamp() {
  return getLevel();
}

// Interpolate a cap upward from its configured base toward base*fullMultiplier,
// clamped to the subsystem's hard maximum. Never returns below base.
function scaleUp(base, fullMultiplier, ramp, hardMaximum) {
  const normalizedBase = Math.max(0, toFiniteNumber(base, 0));
  const target = normalizedBase * Math.max(1, toFiniteNumber(fullMultiplier, 1));
  const scaled = Math.round(normalizedBase + (target - normalizedBase) * clamp(ramp, 0, 1));
  const bounded = Number.isFinite(hardMaximum) ? Math.min(hardMaximum, scaled) : scaled;
  return Math.max(normalizedBase, bounded);
}

// Interpolate an interval/duration downward from base toward base/fullDivisor,
// clamped to the subsystem's hard minimum. Never returns above base.
function scaleDown(base, fullDivisor, ramp, hardMinimum) {
  const normalizedBase = Math.max(0, toFiniteNumber(base, 0));
  const divisor = Math.max(1, toFiniteNumber(fullDivisor, 1));
  const target = normalizedBase / divisor;
  const scaled = Math.round(normalizedBase - (normalizedBase - target) * clamp(ramp, 0, 1));
  const bounded = Number.isFinite(hardMinimum) ? Math.max(hardMinimum, scaled) : scaled;
  return Math.min(normalizedBase, bounded);
}

// Multiplier applied to DEMAND-DRIVEN industry job durations only (normal
// stock-driven production keeps peacetime pacing — no market flooding). At
// full mobilization this is what lets 2.8-day foundation battleship bridges
// track a war.
function getWarTimeScale() {
  const floor = getWarTimeScaleFloor();
  return 1 - (1 - floor) * getIndustryRamp();
}

function getStatus() {
  const current = ensureState();
  return {
    enabled: isEnabled(),
    level: Number(getLevel().toFixed(4)),
    pressure: Number(clamp(current.pressure, 0, 1).toFixed(4)),
    terms: {
      backlog: Number(clamp(current.terms.backlog, 0, 1).toFixed(4)),
      age: Number(clamp(current.terms.age, 0, 1).toFixed(4)),
      rate: Number(clamp(current.terms.rate, 0, 1).toFixed(4)),
    },
    inputs: { ...current.inputs },
    freightRamp: Number(getFreightRamp().toFixed(4)),
    industryRamp: Number(getIndustryRamp().toFixed(4)),
    warTimeScale: Number(getWarTimeScale().toFixed(4)),
    fullSinceMs: current.fullSinceMs || null,
    metrics: { ...current.metrics },
    config: {
      targetBacklogPackages: getTargetBacklogPackages(),
      fullBacklogPackages: getFullBacklogPackages(),
      maxLevel: getMaxLevel(),
      warTimeScaleFloor: getWarTimeScaleFloor(),
    },
  };
}

// Test/maintenance hooks.
function _reset() {
  state = buildDefaultState();
}

function _setLevelForTest(level) {
  ensureState().level = clamp(toFiniteNumber(level, 0), 0, 1);
}

module.exports = {
  isEnabled,
  update,
  getLevel,
  getFreightRamp,
  getIndustryRamp,
  getWarTimeScale,
  scaleUp,
  scaleDown,
  getStatus,
  _reset,
  _setLevelForTest,
};
