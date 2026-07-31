"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { getDefaultCatalog } = require("../src/space/liveEvents/liveEventCatalog");
const { LiveEventRuntime, PHASE, createNoopHandler } = require(
  "../src/space/liveEvents/liveEventRuntime"
);
const config = require("../src/config");
const tableOwnership = require("../src/gameStore/tableOwnership");

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createMemoryStateStore() {
  const events = new Map();
  const archive = new Map();
  const transactions = new Map();
  let nextSerial = 1;
  return {
    ensureInitialized() {
      return { success: true, data: { schemaVersion: 1, nextEventSerial: nextSerial } };
    },
    allocateEventID() {
      const serial = nextSerial++;
      return {
        success: true,
        data: { eventID: `test-event-${String(serial).padStart(4, "0")}`, serial },
      };
    },
    listEvents() {
      return [...events.values()].map(cloneValue);
    },
    getEvent(eventID) {
      return cloneValue(events.get(String(eventID)) || null);
    },
    saveEvent(event) {
      events.set(String(event.eventID), cloneValue(event));
      return { success: true };
    },
    removeEvent(eventID) {
      return { success: events.delete(String(eventID)) };
    },
    archiveEvent(event, nowMs) {
      const archived = { ...cloneValue(event), archivedAtMs: nowMs };
      archive.set(String(event.eventID), archived);
      events.delete(String(event.eventID));
      return { success: true, data: cloneValue(archived) };
    },
    listArchivedEvents() {
      return [...archive.values()].map(cloneValue);
    },
    getTransaction(transactionID) {
      return cloneValue(transactions.get(String(transactionID)) || null);
    },
    saveTransaction(transaction) {
      transactions.set(String(transaction.transactionID), cloneValue(transaction));
      return { success: true };
    },
  };
}

function verifyCatalog() {
  const catalog = getDefaultCatalog();
  const definitions = catalog.listDefinitions({ includeDisabled: true });
  assert.ok(definitions.length >= 3);
  assert.equal(catalog.getDefinition("kernel.noop").eventType, "noop");
  assert.equal(catalog.getDefinition("industrial.mining.highsec.small").enabled, true);
  assert.equal(catalog.getDefinition("industrial.mining.highsec.small").revision, 2);
  assert.equal(
    catalog.getDefinition("industrial.mining.highsec.small").producer.targetActiveCount,
    1,
  );
  assert.equal(
    catalog.getDefinition("industrial.mining.highsec.small").content.virtualQuantityPerCycle,
    500,
  );
  assert.equal(catalog.getDefinition("battle.aftermath.skirmish.small").limits.dynamicObjects, 48);
  assert.equal(typeof config.liveEventsEnabled, "boolean");
  assert.equal(config.liveEventsSchedulerIntervalMs, 5_000);
  assert.equal(config.liveEventsSchedulerBudgetMs, 2);
  assert.equal(tableOwnership.getTableOwnership("liveEventRuntime").domain, "in-space");
  assert.equal(tableOwnership.getTableOwnership("liveEventDefinitions").tier, "static");
  return definitions.length;
}

function verifyRuntime() {
  const stateStore = createMemoryStateStore();
  let nowMs = 1_700_000_000_000;
  let monotonicMs = 0;
  const runtime = new LiveEventRuntime({
    stateStore,
    catalog: getDefaultCatalog(),
    clock: () => nowMs,
    monotonicClock: () => monotonicMs,
    options: {
      enabled: true,
      schedulerIntervalMs: 5_000,
      schedulerBudgetMs: 2,
      maxJobsPerPass: 3,
      maxActiveGlobal: 10,
      maxActivePerSystem: 10,
      enableProducers: false,
    },
  });
  runtime.registerHandler("noop", createNoopHandler());
  assert.equal(runtime.start({ force: true }).success, true);

  const createdIDs = [];
  for (let index = 0; index < 7; index += 1) {
    const created = runtime.scheduleEvent("kernel.noop", {
      force: true,
      ignoreCaps: true,
      systemID: 30000142 + index,
      nowMs,
    });
    assert.equal(created.success, true);
    createdIDs.push(created.data.eventID);
  }
  assert.equal(runtime.getSnapshot().queueSize, 7);

  const firstPass = runtime.runDueWork(nowMs, { maxJobs: 3, budgetMs: 2 });
  assert.equal(firstPass.data.processedJobs, 3);
  assert.equal(firstPass.data.deferredJobs, 1);
  assert.equal(
    stateStore.listEvents().filter((event) => event.phase === PHASE.DORMANT).length,
    3,
  );

  const secondPass = runtime.runDueWork(nowMs, { maxJobs: 3, budgetMs: 2 });
  assert.equal(secondPass.data.processedJobs, 3);
  const thirdPass = runtime.runDueWork(nowMs, { maxJobs: 3, budgetMs: 2 });
  assert.equal(thirdPass.data.processedJobs, 1);
  assert.ok(stateStore.listEvents().every((event) => event.phase === PHASE.DORMANT));

  for (let transition = 0; transition < 5; transition += 1) {
    nowMs += 1_000;
    for (;;) {
      const result = runtime.runDueWork(nowMs, { maxJobs: 3, budgetMs: 2 });
      if (result.data.deferredJobs === 0) {
        break;
      }
    }
  }
  assert.ok(stateStore.listEvents().every((event) => event.phase === PHASE.COMPLETED));
  assert.equal(runtime.getSnapshot().queueSize, 0);
  assert.equal(runtime.getSnapshot().metrics.completedEvents, 7);

  const operatorEvent = runtime.scheduleEvent("kernel.noop", {
    force: true,
    ignoreCaps: true,
    systemID: 30000142,
    nowMs,
  });
  assert.equal(operatorEvent.success, true);
  assert.equal(runtime.advanceEventNow(operatorEvent.data.eventID, nowMs).data.phase, PHASE.DORMANT);
  assert.equal(runtime.requestCleanup(operatorEvent.data.eventID, {
    nowMs,
    reason: "verification",
  }).data.phase, PHASE.CLEANUP);
  assert.equal(runtime.advanceEventNow(operatorEvent.data.eventID, nowMs).data.phase, PHASE.COMPLETED);
  assert.equal(runtime.getSnapshot().metrics.operatorAdvances, 2);
  assert.equal(runtime.getSnapshot().metrics.operatorCleanupRequests, 1);

  const failingRuntime = new LiveEventRuntime({
    stateStore: createMemoryStateStore(),
    catalog: getDefaultCatalog(),
    clock: () => nowMs,
    monotonicClock: () => monotonicMs,
    options: {
      enabled: true,
      schedulerBudgetMs: 2,
      maxJobsPerPass: 8,
      maxActiveGlobal: 2,
      maxActivePerSystem: 1,
      recoveryBaseDelayMs: 5_000,
      enableProducers: false,
    },
  });
  failingRuntime.registerHandler("noop", {
    advance() {
      throw new Error("verification failure");
    },
  });
  failingRuntime.start({ force: true });
  const failedEvent = failingRuntime.scheduleEvent("kernel.noop", {
    force: true,
    systemID: 30000142,
    nowMs,
  });
  failingRuntime.runDueWork(nowMs);
  const recovered = failingRuntime.stateStore.getEvent(failedEvent.data.eventID);
  assert.equal(recovered.phase, PHASE.RECOVERY_PENDING);
  assert.equal(recovered.retryCount, 1);
  assert.match(recovered.lastError, /verification failure/);

  runtime.stop();
  failingRuntime.stop();
  return createdIDs.length;
}

function verifyProducerAndRetention() {
  const stateStore = createMemoryStateStore();
  const nowMs = 1_700_100_000_000;
  for (let index = 0; index < 103; index += 1) {
    stateStore.saveEvent({
      eventID: `completed-${String(index).padStart(4, "0")}`,
      eventType: "noop",
      definitionID: "kernel.noop",
      phase: PHASE.COMPLETED,
      createdAtMs: nowMs - index,
      updatedAtMs: nowMs - index,
    });
  }
  const runtime = new LiveEventRuntime({
    stateStore,
    catalog: getDefaultCatalog(),
    clock: () => nowMs,
    monotonicClock: () => 0,
    options: {
      enabled: true,
      enableProducers: true,
      producerMaintenanceIntervalMs: 60_000,
      completedRetentionCount: 100,
      archiveBatchSize: 4,
      maxActiveGlobal: 2,
      maxActivePerSystem: 1,
    },
  });
  const first = runtime.maintainProducerTargets(nowMs);
  assert.equal(first.checked, true);
  assert.equal(first.createdCount, 1);
  assert.equal(first.archivedCount, 3);
  const active = stateStore.listEvents().filter((event) => event.phase !== PHASE.COMPLETED);
  assert.equal(active.length, 1);
  assert.equal(active[0].definitionID, "industrial.mining.highsec.small");
  assert.equal(active[0].systemID, 30000140);
  assert.equal(stateStore.listEvents().filter((event) => event.phase === PHASE.COMPLETED).length, 100);
  assert.equal(stateStore.listArchivedEvents().length, 3);
  const second = runtime.maintainProducerTargets(nowMs + 1);
  assert.equal(second.checked, false);
  assert.equal(second.createdCount, 0);
  assert.equal(runtime.getSnapshot().metrics.producerEventsCreated, 1);
  assert.equal(runtime.getSnapshot().metrics.archivedEvents, 3);
  return { created: first.createdCount, archived: first.archivedCount };
}

function verifyPersistence() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-live-events-"));
  const dataDir = path.join(tempRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.EVEJS_GAMESTORE_DATA_DIR = dataDir;
  try {
    const { createStateStore } = require("../src/space/liveEvents/liveEventState");
    const gameStore = require("../src/gameStore");
    const sqliteStore = require("../src/gameStore/sqliteStore");
    const store = createStateStore();
    assert.equal(store.ensureInitialized(1_000).success, true);
    const allocation = store.allocateEventID(1_000);
    assert.equal(allocation.success, true);
    assert.equal(
      store.saveEvent({
        eventID: allocation.data.eventID,
        eventType: "noop",
        definitionID: "kernel.noop",
        phase: PHASE.SCHEDULED,
        revision: 1,
        nextTransitionAtMs: 1_000,
      }).success,
      true,
    );
    assert.equal(store.getEvent(allocation.data.eventID).eventID, allocation.data.eventID);
    assert.equal(store.archiveEvent(store.getEvent(allocation.data.eventID), 2_000).success, true);
    assert.equal(store.getEvent(allocation.data.eventID), null);
    assert.equal(store.listArchivedEvents()[0].archivedAtMs, 2_000);
    gameStore.flushTableSync("liveEventRuntime");
    assert.ok(sqliteStore.rowCount("liveEventRuntime") >= 2);
    gameStore._closeSqliteForTests();
    return allocation.data.eventID;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runVerification() {
  return {
    success: true,
    definitions: verifyCatalog(),
    completedEvents: verifyRuntime(),
    producer: verifyProducerAndRetention(),
    persistedEventID: verifyPersistence(),
  };
}

if (require.main === module) {
  console.log(JSON.stringify(runVerification(), null, 2));
}

module.exports = {
  createMemoryStateStore,
  runVerification,
};

