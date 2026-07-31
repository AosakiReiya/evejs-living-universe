"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_X_EVE_ENABLED = "false";

const assert = require("assert/strict");
const { performance } = require("perf_hooks");

const config = require("../src/config");
const economyStateStore = require(
  "../src/space/npc/ambientTraffic/livingEconomyState",
);
const economyRuntime = require(
  "../src/space/npc/ambientTraffic/livingEconomyRuntime",
);
const universeStateStore = require(
  "../src/space/npc/ambientTraffic/livingUniverseState",
);
const universeRuntime = require(
  "../src/space/npc/ambientTraffic/livingUniverseRuntime",
);

const NOW_MS = 1_785_000_000_000;
const CONFIG_KEYS = [
  "xEveEnabled",
  "livingEconomyEnabled",
  "livingUniverseSchedulerBudgetMs",
  "livingUniverseMaxDueFlightsPerTick",
  "livingUniverseReplacementSchedulerSharePercent",
];
const originalConfig = Object.fromEntries(
  CONFIG_KEYS.map((key) => [key, config[key]]),
);

function configure({ dueLimit = 4, budgetMs = 50 } = {}) {
  config.xEveEnabled = false;
  config.livingEconomyEnabled = true;
  config.livingUniverseSchedulerBudgetMs = budgetMs;
  config.livingUniverseMaxDueFlightsPerTick = dueLimit;
  // Three replacement selections for every ordinary selection while both
  // lanes are due. The persistent lane cursor must preserve this ratio even
  // when the wall-clock budget permits only one transition per pass.
  config.livingUniverseReplacementSchedulerSharePercent = 75;
}

function makeFlight(flightID, dueAtMs, freightJobID = null) {
  return {
    flightID,
    actorIDs: [],
    family: "hauler",
    routeID: `verify_missing_route_${flightID}`,
    phase: "virtual_transit",
    materialized: false,
    currentSystemID: 30_000_142,
    currentNodeIndex: 0,
    direction: 1,
    nextTransitionAtMs: dueAtMs,
    freightJobID,
  };
}

function makeFreightJob(jobID, flightID, replacementPriority) {
  return {
    jobID,
    kind: "station_freight",
    status: "in_transit",
    assignedFlightID: flightID,
    quantity: 100,
    priorityDemandUnits: replacementPriority ? 100 : 0,
    replacementPriorityUnits: replacementPriority ? 100 : 0,
    priorityDemandKinds: replacementPriority ? ["replacement"] : [],
    priorityDemandClasses: replacementPriority ? ["replacement"] : [],
    createdAtMs: NOW_MS - 60_000,
    reservedAtMs: NOW_MS - 60_000,
  };
}

function installScenario(rows) {
  const universeState = universeStateStore.buildDefaultState();
  universeState.actors = {};
  universeState.flights = {};
  universeState.encounters = {};
  const economyState = economyStateStore.buildDefaultState();
  economyState.jobs = {};

  for (const row of rows) {
    const jobID = `VERIFY-JOB-${row.flightID}`;
    const flight = makeFlight(
      row.flightID,
      row.dueAtMs,
      row.freight === false ? null : jobID,
    );
    universeState.flights[flight.flightID] = flight;
    if (row.freight !== false) {
      economyState.jobs[jobID] = makeFreightJob(
        jobID,
        flight.flightID,
        row.replacement === true,
      );
    }
  }

  economyRuntime._testing.setRuntimeStateForTest(economyState);
  universeRuntime._testing.setRuntimeStateForTest(universeState, NOW_MS);
  return { universeState, economyState };
}

function getProcessedIDs(state) {
  return Object.values(state.flights)
    .filter((flight) => flight.lastError === "ROUTE_NOT_FOUND")
    .map((flight) => flight.flightID)
    .sort();
}

function runPass(state, passStartedAtMs = performance.now()) {
  const before = new Set(getProcessedIDs(state));
  const result = universeRuntime._testing.runScheduledFlights(
    { scenes: new Map() },
    NOW_MS,
    passStartedAtMs,
  );
  const newlyProcessed = getProcessedIDs(state)
    .filter((flightID) => !before.has(flightID));
  return { result, newlyProcessed };
}

function countClasses(flightIDs) {
  const counts = { replacement: 0, general: 0 };
  for (const flightID of flightIDs) {
    if (flightID.startsWith("priority-")) counts.replacement += 1;
    else counts.general += 1;
  }
  return counts;
}

function verifyHeavyBacklogLane() {
  configure({ dueLimit: 4, budgetMs: 50 });
  const rows = [];
  // Ordinary work is deliberately much more overdue and sorts ahead of every
  // priority flight in the legacy single deadline heap.
  for (let index = 1; index <= 12; index += 1) {
    rows.push({
      flightID: `general-${String(index).padStart(3, "0")}`,
      dueAtMs: NOW_MS - 600_000 - index,
      replacement: false,
    });
  }
  for (let index = 1; index <= 12; index += 1) {
    rows.push({
      flightID: `priority-${String(index).padStart(3, "0")}`,
      dueAtMs: NOW_MS - 60_000 - index,
      replacement: true,
    });
  }
  const { universeState } = installScenario(rows);

  const passResults = [];
  const allProcessed = [];
  for (let pass = 0; pass < 4; pass += 1) {
    const current = runPass(universeState);
    assert.equal(current.result.dueProcessed, 4);
    assert.ok(
      current.result.dueProcessed <= config.livingUniverseMaxDueFlightsPerTick,
      "priority dispatch exceeded the configured transition bound",
    );
    const classes = countClasses(current.newlyProcessed);
    assert.deepEqual(
      classes,
      { replacement: 3, general: 1 },
      "the bounded priority lane did not preserve its 75/25 progress split",
    );
    passResults.push(classes);
    allProcessed.push(...current.newlyProcessed);
  }
  assert.deepEqual(
    countClasses(allProcessed),
    { replacement: 12, general: 4 },
  );

  return {
    dueBacklog: rows.length,
    passes: passResults,
    totalProcessed: countClasses(allProcessed),
  };
}

function verifyBudgetConstrainedFairness() {
  configure({ dueLimit: 64, budgetMs: 1 });
  const rows = [];
  for (let index = 1; index <= 8; index += 1) {
    rows.push({
      flightID: `general-budget-${String(index).padStart(3, "0")}`,
      dueAtMs: NOW_MS - 600_000 - index,
      replacement: false,
    });
    rows.push({
      flightID: `priority-budget-${String(index).padStart(3, "0")}`,
      dueAtMs: NOW_MS - 60_000 - index,
      replacement: true,
    });
  }
  const { universeState } = installScenario(rows);
  const processed = [];
  const perPass = [];
  for (let pass = 0; pass < 4; pass += 1) {
    // runScheduledFlights intentionally permits one transition before checking
    // its wall budget. An already-expired budget therefore gives a completely
    // deterministic one-item pass without mocking the monotonic clock.
    const current = runPass(universeState, performance.now() - 1_000);
    assert.equal(
      current.result.dueProcessed,
      1,
      "an expired scheduler budget admitted more than one transition",
    );
    assert.equal(current.newlyProcessed.length, 1);
    processed.push(...current.newlyProcessed);
    perPass.push(current.newlyProcessed[0]);
  }
  assert.deepEqual(
    countClasses(processed),
    { replacement: 3, general: 1 },
    "the lane cursor reset between budget-limited passes and starved a class",
  );
  const status = universeRuntime.getSchedulerStatus(NOW_MS);
  assert.equal(status.metrics.lastDueFlightsProcessed, 1);

  return {
    passes: perPass,
    totalProcessed: countClasses(processed),
    lastPassTransitions: status.metrics.lastDueFlightsProcessed,
  };
}

function verifyNormalOrderUnchanged() {
  configure({ dueLimit: 3, budgetMs: 50 });
  const rows = [
    {
      flightID: "normal-late",
      dueAtMs: NOW_MS - 1_000,
      replacement: false,
      freight: false,
    },
    {
      flightID: "normal-same-b",
      dueAtMs: NOW_MS - 2_000,
      replacement: false,
      freight: false,
    },
    {
      flightID: "normal-early",
      dueAtMs: NOW_MS - 3_000,
      replacement: false,
      freight: false,
    },
    {
      flightID: "normal-same-a",
      dueAtMs: NOW_MS - 2_000,
      replacement: false,
      freight: false,
    },
  ];
  const { universeState } = installScenario(rows);
  const pass = runPass(universeState);
  assert.equal(pass.result.dueProcessed, 3);
  // getProcessedIDs sorts for set comparisons, so recover the scheduler order
  // from the deterministic expected due/key prefix and assert membership.
  assert.deepEqual(
    new Set(pass.newlyProcessed),
    new Set(["normal-early", "normal-same-a", "normal-same-b"]),
    "the non-priority deadline prefix changed",
  );
  assert.equal(
    universeState.flights["normal-late"].lastError,
    undefined,
    "a later ordinary deadline jumped the normal queue",
  );

  return {
    processedDeadlinePrefix: [
      "normal-early",
      "normal-same-a",
      "normal-same-b",
    ],
    deferred: "normal-late",
  };
}

function verifyReplacementRepositionUsesPriorityLane() {
  configure({ dueLimit: 1, budgetMs: 50 });
  const rows = [
    {
      flightID: "general-reposition-check",
      dueAtMs: NOW_MS - 600_000,
      replacement: false,
      freight: false,
    },
    {
      flightID: "priority-reposition",
      dueAtMs: NOW_MS - 60_000,
      replacement: false,
      freight: false,
    },
  ];
  const { universeState } = installScenario(rows);
  universeState.flights["priority-reposition"].freightReposition = {
    status: "enroute",
    replacementPriority: true,
    replacementPriorityUnits: 100,
    assignedAtMs: NOW_MS - 60_000,
  };
  universeRuntime._testing.rebuildFlightSchedule(NOW_MS, "verify-reposition");
  const pass = runPass(universeState);
  assert.deepEqual(
    pass.newlyProcessed,
    ["priority-reposition"],
    "an active replacement-priority reposition did not use the priority lane",
  );
  return {
    processed: pass.newlyProcessed[0],
    generalStillDue: (
      universeState.flights["general-reposition-check"].lastError === undefined
    ),
  };
}

function main() {
  try {
    const heavyBacklog = verifyHeavyBacklogLane();
    const constrainedBudget = verifyBudgetConstrainedFairness();
    const normalOrder = verifyNormalOrderUnchanged();
    const replacementReposition = verifyReplacementRepositionUsesPriorityLane();
    console.log(JSON.stringify({
      success: true,
      configuredReplacementSharePercent: 75,
      heavyBacklog,
      constrainedBudget,
      normalOrder,
      replacementReposition,
    }, null, 2));
  } finally {
    for (const [key, value] of Object.entries(originalConfig)) {
      config[key] = value;
    }
  }
}

try {
  main();
} catch (error) {
  console.error(error && error.stack || error);
  process.exitCode = 1;
}
