"use strict";

// War-economy mobilization (slice W1) verifier: controller level math
// (ramp/decay/hysteresis/slew/throttle), pressure terms, scaling helper
// bounds, industry accessor response, and the disabled-flag identity.

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-mobilization-"));
const dataDirectory = path.join(temporaryRoot, "data");
fs.mkdirSync(dataDirectory, { recursive: true });
process.env.EVEJS_GAMESTORE_DATA_DIR = dataDirectory;
process.env.EVEJS_PERSISTENCE_WORKER = "0";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_MINING_NPC_STARTUP_ENABLED = "false";

const config = require("../src/config");
const mobilization = require(
  "../src/space/npc/ambientTraffic/livingEconomyMobilization",
);
const industry = require("../src/space/npc/ambientTraffic/livingEconomyIndustry");

const T0 = 1_800_000_000_000;
const MINUTE = 60_000;

const summary = {};

function calmInputs() {
  return {
    pendingPackages: 0,
    oldestPendingAgeMs: 0,
    demandsCreatedTotal: 0,
    demandsFulfilledTotal: 0,
  };
}

function warInputs(overrides = {}) {
  return {
    pendingPackages: 500,
    oldestPendingAgeMs: 0,
    demandsCreatedTotal: 0,
    demandsFulfilledTotal: 0,
    ...overrides,
  };
}

// --- 1. Ramp: sustained backlog pressure mobilizes at the configured slew ----

mobilization._reset();
assert.equal(config.livingEconomyMobilizationEnabled, true, "mobilization defaults enabled");
assert.equal(mobilization.getLevel(), 0, "starts at level 0");

mobilization.update(warInputs(), T0);
assert.equal(mobilization.getLevel(), 0, "first sample establishes the clock, no jump");
mobilization.update(warInputs(), T0 + 1 * MINUTE);
assert.ok(
  Math.abs(mobilization.getLevel() - 0.1) < 1e-9,
  `ramps at ~0.1/min (got ${mobilization.getLevel()})`,
);
mobilization.update(warInputs(), T0 + 5 * MINUTE);
assert.ok(
  Math.abs(mobilization.getLevel() - 0.5) < 1e-9,
  "half mobilized after 5 sustained minutes",
);
mobilization.update(warInputs(), T0 + 10 * MINUTE);
assert.equal(mobilization.getLevel(), 1, "fully mobilized after ~10 sustained minutes");
mobilization.update(warInputs(), T0 + 11 * MINUTE);
assert.equal(mobilization.getLevel(), 1, "holds at full under sustained pressure");
summary.ramp = "pass";

// --- 2. Stand-down: slower decay = hysteresis ---------------------------------

mobilization.update(calmInputs(), T0 + 12 * MINUTE);
const afterOneCalmMinute = mobilization.getLevel();
assert.ok(
  afterOneCalmMinute < 1 && afterOneCalmMinute > 0.9,
  `stands down slowly (~0.033/min, got ${1 - afterOneCalmMinute} in 1 min)`,
);
// Step minute-by-minute like the real pulse cadence — a single controller step
// deliberately clamps its elapsed time to 10 minutes.
for (let minute = 13; minute <= 45; minute += 1) {
  mobilization.update(calmInputs(), T0 + minute * MINUTE);
}
assert.ok(
  mobilization.getLevel() < 0.05,
  "fully stood down after ~30 calm minutes",
);
summary.standDown = "pass";

// --- 3. Age term: a small but OLD backlog still mobilizes ---------------------

mobilization._reset();
const agedInputs = warInputs({ pendingPackages: 5, oldestPendingAgeMs: 60 * MINUTE });
mobilization.update(agedInputs, T0);
mobilization.update(agedInputs, T0 + 10 * MINUTE);
assert.equal(
  mobilization.getLevel(),
  1,
  "hour-old pending demand drives full mobilization even with a tiny backlog",
);
summary.ageTerm = "pass";

// --- 4. Rate term: creation outrunning fulfillment mobilizes ------------------

mobilization._reset();
const target = config.livingEconomyMobilizationTargetBacklogPackages;
let created = 0;
let fulfilled = 0;
for (let minute = 0; minute <= 12; minute += 1) {
  created += 8;    // 480/hour
  fulfilled += 2;  // 120/hour -> ratio 4 = rate-term ceiling
  mobilization.update({
    pendingPackages: target + 1, // backlog term ~0, age term 0
    oldestPendingAgeMs: 0,
    demandsCreatedTotal: created,
    demandsFulfilledTotal: fulfilled,
  }, T0 + minute * MINUTE);
}
assert.equal(
  mobilization.getLevel(),
  1,
  "a 4:1 creation:fulfillment ratio drives full mobilization",
);
const rateStatus = mobilization.getStatus();
assert.ok(rateStatus.terms.rate >= 0.99, "rate term saturates at ratio >= 4");
assert.ok(
  rateStatus.inputs.createdPerHour > rateStatus.inputs.fulfilledPerHour,
  "window rates computed",
);
summary.rateTerm = "pass";

// --- 5. MaxLevel throttle -----------------------------------------------------

mobilization._reset();
const priorMaxLevel = config.livingEconomyMobilizationMaxLevel;
config.livingEconomyMobilizationMaxLevel = 0.5;
try {
  mobilization.update(warInputs(), T0);
  mobilization.update(warInputs(), T0 + 20 * MINUTE);
  assert.equal(mobilization.getLevel(), 0.5, "MaxLevel caps the surge amplitude");
  assert.equal(
    mobilization.getFreightRamp(),
    0.5,
    "MaxLevel throttles the freight ramp too — half the throttle is half of EVERY surge delta",
  );
} finally {
  config.livingEconomyMobilizationMaxLevel = priorMaxLevel;
}
summary.maxLevelThrottle = "pass";

// --- 5b. Rate term needs a minimum observation span ---------------------------

mobilization._reset();
mobilization.update({
  pendingPackages: config.livingEconomyMobilizationTargetBacklogPackages + 5,
  oldestPendingAgeMs: 0,
  demandsCreatedTotal: 100,
  demandsFulfilledTotal: 50,
}, T0);
mobilization.update({
  pendingPackages: config.livingEconomyMobilizationTargetBacklogPackages + 5,
  oldestPendingAgeMs: 0,
  demandsCreatedTotal: 104,
  demandsFulfilledTotal: 50,
}, T0 + 15_000);
assert.equal(
  mobilization.getStatus().terms.rate,
  0,
  "a 15-second window is too short to assert rate pressure (boot/stall guard)",
);
mobilization._reset();
summary.rateMinimumSpan = "pass";

// --- 6. Scaling helpers: bounds and identity ----------------------------------

assert.equal(mobilization.scaleUp(320, 2, 0, 1_000), 320, "ramp 0 = identity");
assert.equal(mobilization.scaleUp(320, 2, 1, 1_000), 640, "full ramp doubles");
assert.equal(mobilization.scaleUp(320, 2, 0.5, 1_000), 480, "half ramp interpolates");
assert.equal(mobilization.scaleUp(900, 2, 1, 1_000), 1_000, "hard max clamps");
assert.equal(mobilization.scaleDown(300_000, 300 / 90, 1, 30_000), 90_000, "full ramp divides");
assert.equal(mobilization.scaleDown(300_000, 300 / 90, 0, 30_000), 300_000, "ramp 0 = identity");
assert.equal(mobilization.scaleDown(40_000, 4, 1, 30_000), 30_000, "hard min clamps");
summary.scalingHelpers = "pass";

// --- 7. Consumer response: industry accessors follow the level ----------------

mobilization._reset();
const baseLines = industry.getMaxParallelHullLines();
mobilization._setLevelForTest(1);
assert.equal(industry.getMaxParallelHullLines(), 8, "parallel hull lines surge to the clamp of 8");
assert.ok(
  Math.abs(mobilization.getWarTimeScale() - config.livingEconomyMobilizationWarTimeScaleFactor) < 1e-9,
  "war time scale reaches the configured floor at full mobilization",
);
mobilization._setLevelForTest(0);
assert.equal(industry.getMaxParallelHullLines(), baseLines, "level 0 restores the base value");
assert.equal(mobilization.getWarTimeScale(), 1, "war time scale is 1 at level 0");
assert.ok(
  Math.abs(mobilization.getFreightRamp() - Math.min(1, mobilization.getLevel() * 2)) < 1e-9,
  "freight ramp doubles the level (freight surges first)",
);
mobilization._setLevelForTest(0.5);
assert.equal(mobilization.getFreightRamp(), 1, "freight fully surged at level 0.5");
assert.equal(mobilization.getIndustryRamp(), 0.5, "industry at half ramp at level 0.5");
mobilization._reset();
summary.consumerResponse = "pass";

// --- 8. Disabled flag = exact identity ----------------------------------------

const priorEnabled = config.livingEconomyMobilizationEnabled;
config.livingEconomyMobilizationEnabled = false;
try {
  mobilization._setLevelForTest(1);
  assert.equal(mobilization.getLevel(), 0, "disabled: level reads 0 regardless of state");
  assert.equal(mobilization.getWarTimeScale(), 1, "disabled: war time scale is identity");
  assert.equal(industry.getMaxParallelHullLines(), baseLines, "disabled: accessors at base");
  mobilization.update(warInputs(), T0);
  mobilization.update(warInputs(), T0 + 30 * MINUTE);
  assert.equal(mobilization.getLevel(), 0, "disabled: pressure never mobilizes");
} finally {
  config.livingEconomyMobilizationEnabled = priorEnabled;
}
mobilization._reset();
summary.disabledIdentity = "pass";

// --- 9. Counter-reset tolerance (restart mid-window) --------------------------

mobilization._reset();
created = 1_000;
fulfilled = 900;
mobilization.update({
  pendingPackages: target + 1,
  oldestPendingAgeMs: 0,
  demandsCreatedTotal: created,
  demandsFulfilledTotal: fulfilled,
}, T0);
// Counters reset (fresh state doc) — deltas go negative; window must not panic
// or read as pressure.
mobilization.update({
  pendingPackages: target + 1,
  oldestPendingAgeMs: 0,
  demandsCreatedTotal: 4,
  demandsFulfilledTotal: 1,
}, T0 + 1 * MINUTE);
const resetStatus = mobilization.getStatus();
assert.equal(resetStatus.terms.rate, 0, "negative counter deltas are treated as unknown, not pressure");
mobilization._reset();
summary.counterResetTolerance = "pass";

console.log(JSON.stringify({
  verifier: "livingEconomyMobilization",
  config: {
    enabled: config.livingEconomyMobilizationEnabled,
    targetBacklogPackages: config.livingEconomyMobilizationTargetBacklogPackages,
    fullBacklogPackages: config.livingEconomyMobilizationFullBacklogPackages,
    slewPerMinute: config.livingEconomyMobilizationSlewPerMinute,
    standDownSlewPerMinute: config.livingEconomyMobilizationStandDownSlewPerMinute,
    warTimeScaleFactor: config.livingEconomyMobilizationWarTimeScaleFactor,
  },
  results: summary,
}, null, 2));
