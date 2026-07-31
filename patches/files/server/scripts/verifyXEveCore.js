"use strict";

// Exercise the fail-closed source gate independently of the installed play
// profile. Individual runtime tests below opt in explicitly.
process.env.EVEJS_X_EVE_ENABLED = "false";

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");

const config = require("../src/config");
const tableOwnership = require("../src/gameStore/tableOwnership");
const {
  createLedger,
  fingerprint,
  SYSTEM_ACCOUNTS,
} = require("../src/services/xEve/xEveLedger");
const {
  createMemoryRepository,
  createStateStore,
} = require("../src/services/xEve/xEveState");
const {
  MODE,
  WORK_CLASS,
  XEveLoadGovernor,
} = require("../src/services/xEve/xEveLoadGovernor");
const { WORK_STATUS, XEveRuntime } = require("../src/services/xEve/xEveRuntime");

const TEST_HANDLER_CONTRACT = Object.freeze({ continuation: true, sliceBudgetMs: 2 });

function createPersistedWorkRow(raw = {}) {
  const request = {
    workOrderID: raw.workOrderID,
    workClass: raw.workClass,
    handlerType: raw.handlerType,
    dueAtMs: raw.requestedDueAtMs == null ? raw.dueAtMs : raw.requestedDueAtMs,
    retryForever: raw.retryForever === true,
    maxAttempts: raw.retryForever === true ? null : (raw.maxAttempts || 8),
    payload: raw.payload || {},
  };
  return {
    schemaVersion: 1,
    ...request,
    request,
    requestFingerprint: fingerprint(request),
    requestedDueAtMs: request.dueAtMs,
    status: raw.status || "queued",
    dueAtMs: raw.dueAtMs,
    retryCount: raw.retryCount || 0,
    lastError: raw.lastError || null,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
    completedAtMs: 0,
  };
}

function createPersistedInboxRow(raw = {}) {
  const request = {
    source: raw.source || "audit-source",
    sourceEventID: raw.sourceEventID || "audit-event:0001",
    eventType: raw.eventType || "audit_event",
    version: raw.version || 1,
    occurredAtMs: raw.occurredAtMs,
    payload: raw.payload || {},
  };
  return {
    schemaVersion: 1,
    messageID: raw.messageID || `${request.source}:${request.sourceEventID}`,
    ...request,
    request,
    requestFingerprint: fingerprint(request),
    status: "received",
    receivedAtMs: raw.receivedAtMs,
    observedAtMs: 0,
  };
}

function ticks(intervalMs, count = 20) {
  return Array.from({ length: count }, () => ({
    actualIntervalMs: intervalMs,
    tickDurationMs: Math.max(0, intervalMs - 100),
    targetTickIntervalMs: 100,
  }));
}

function createMemoryStateStore(seed = {}) {
  return createStateStore({ repo: createMemoryRepository(seed) });
}

function verifyConfiguration() {
  assert.equal(config.xEveEnabled, false);
  assert.equal(config.xEveSchedulerIntervalMs, 1_000);
  assert.equal(config.xEveSchedulerBudgetMs, 2);
  assert.equal(config.xEveDurabilityIntervalMs, 2_000);
  assert.equal(config.xEveMaxJobsPerPass, 32);
  assert.equal(config.xEveMaxRetryAttempts, 8);
  assert.equal(config.xEveTickWarningMs, 120);
  assert.equal(config.xEveTickOverloadMs, 130);
  assert.equal(config.xEveEmergencyShedMs, 500);
  assert.equal(config.xEveUnplayableMs, 600);
  assert.equal(tableOwnership.getTableOwnership("xEveRuntime").domain, "service:x-eve");
  const guardedRuntime = new XEveRuntime({
    stateStore: createMemoryStateStore(),
    options: {
      enabled: true,
      schedulerIntervalMs: 1,
      schedulerBudgetMs: 1_000,
      durabilityIntervalMs: 1_000_000,
      maxJobsPerPass: 100_000,
      tickSampleCount: 10_000,
      tickWarningMs: 550,
      tickOverloadMs: 1,
      emergencyShedMs: 1,
      unplayableMs: 10_000,
      recoveryThresholdMs: 10_000,
      recoveryMs: 1_000_000,
      maxRetryAttempts: 10_000,
    },
  });
  assert.equal(guardedRuntime.options.schedulerIntervalMs, 250);
  assert.equal(guardedRuntime.options.schedulerBudgetMs, 10);
  assert.equal(guardedRuntime.options.durabilityIntervalMs, 60_000);
  assert.equal(guardedRuntime.options.maxJobsPerPass, 100);
  assert.equal(guardedRuntime.options.tickSampleCount, 120);
  assert.equal(guardedRuntime.options.tickWarningMs, 499);
  assert.equal(guardedRuntime.options.tickOverloadMs, 499);
  assert.equal(guardedRuntime.options.emergencyShedMs, 499);
  assert.equal(guardedRuntime.options.unplayableMs, 600);
  assert.equal(guardedRuntime.options.recoveryThresholdMs, 119);
  assert.equal(guardedRuntime.options.recoveryMs, 60_000);
  assert.equal(guardedRuntime.options.maxRetryAttempts, 100);
  return {
    enabledByDefault: config.xEveEnabled,
    budgetMs: config.xEveSchedulerBudgetMs,
    thresholdsMs: {
      baseline: 100,
      warning: config.xEveTickWarningMs,
      softLimit: config.xEveTickOverloadMs,
      emergencyShed: config.xEveEmergencyShedMs,
      unplayable: config.xEveUnplayableMs,
    },
    runtimeClamp: {
      budgetMs: guardedRuntime.options.schedulerBudgetMs,
      maxJobsPerPass: guardedRuntime.options.maxJobsPerPass,
      unplayableMs: guardedRuntime.options.unplayableMs,
    },
  };
}

function verifyLedger() {
  let nowMs = 1_700_000_000_000;
  const stateStore = createMemoryStateStore();
  const ledger = createLedger({ stateStore, clock: () => nowMs });
  assert.equal(ledger.ensureInitialized(nowMs).success, true);
  assert.equal(ledger.getStatus().accountCount, 3);
  const reservedAccount = ledger.createAccount({
    accountID: SYSTEM_ACCOUNTS.EXTERNAL_ISSUANCE,
    ownerType: "firm",
    ownerID: "impostor",
  }, { nowMs, durable: false });
  assert.equal(reservedAccount.success, false);
  assert.equal(reservedAccount.errorMsg, "X_EVE_SYSTEM_ACCOUNT_RESERVED");

  assert.equal(ledger.createAccount({
    accountID: "firm:caldari-industrial",
    name: "Caldari Industrial Cooperative",
    ownerType: "firm",
    ownerID: "caldari-industrial",
    category: "cash",
  }, { nowMs, durable: false }).success, true);
  assert.equal(ledger.createAccount({
    accountID: "firm:forge-haulage",
    name: "Forge Haulage Pool",
    ownerType: "firm",
    ownerID: "forge-haulage",
    category: "cash",
  }, { nowMs, durable: false }).success, true);

  const opening = ledger.openBalance({
    transactionID: "opening:caldari-industrial",
    accountID: "firm:caldari-industrial",
    amountCents: "100000",
    metadata: { reason: "explicit test opening balance" },
  }, { nowMs, durable: false });
  assert.equal(opening.success, true);

  nowMs += 1;
  const transferRequest = {
    transactionID: "freight:0001",
    fromAccountID: "firm:caldari-industrial",
    toAccountID: "firm:forge-haulage",
    amountCents: "25000",
    metadata: { route: "Jita-Perimeter" },
  };
  const transfer = ledger.transfer(transferRequest, { nowMs, durable: false });
  assert.equal(transfer.success, true);
  const replay = ledger.transfer(transferRequest, { nowMs: nowMs + 50_000, durable: false });
  assert.equal(replay.success, true);
  assert.equal(replay.replayed, true);
  assert.equal(ledger.getStatus().transactionCount, 2);

  const conflict = ledger.transfer({ ...transferRequest, amountCents: "25001" }, {
    nowMs,
    durable: false,
  });
  assert.equal(conflict.success, false);
  assert.equal(conflict.errorMsg, "X_EVE_TRANSACTION_CONFLICT");

  const beforeRejected = {
    source: ledger.getAccount("firm:caldari-industrial").balanceCents,
    destination: ledger.getAccount("firm:forge-haulage").balanceCents,
  };
  const insufficient = ledger.transfer({
    transactionID: "freight:insufficient",
    fromAccountID: "firm:forge-haulage",
    toAccountID: "firm:caldari-industrial",
    amountCents: "25001",
  }, { nowMs, durable: false });
  assert.equal(insufficient.success, false);
  assert.equal(insufficient.errorMsg, "X_EVE_INSUFFICIENT_FUNDS");
  assert.deepEqual({
    source: ledger.getAccount("firm:caldari-industrial").balanceCents,
    destination: ledger.getAccount("firm:forge-haulage").balanceCents,
  }, beforeRejected);

  const unbalanced = ledger.commit({
    transactionID: "invalid:unbalanced",
    postings: [
      { accountID: "firm:caldari-industrial", amountCents: "-100" },
      { accountID: "firm:forge-haulage", amountCents: "99" },
    ],
  }, { nowMs, durable: false });
  assert.equal(unbalanced.success, false);
  assert.equal(unbalanced.errorMsg, "X_EVE_UNBALANCED_TRANSACTION");
  const boundaryMisuse = ledger.commit({
    transactionID: "invalid:boundary-misuse",
    kind: "transfer",
    postings: [
      { accountID: SYSTEM_ACCOUNTS.EXTERNAL_ISSUANCE, amountCents: "-100" },
      { accountID: "firm:caldari-industrial", amountCents: "100" },
    ],
  }, { nowMs, durable: false });
  assert.equal(boundaryMisuse.success, false);
  assert.equal(boundaryMisuse.errorMsg, "X_EVE_BOUNDARY_KIND_FORBIDDEN");

  nowMs += 1;
  assert.equal(ledger.issue({
    transactionID: "issuance:mission-reward:0001",
    toAccountID: "firm:caldari-industrial",
    amountCents: "10000",
    metadata: { source: "named mission reward faucet" },
  }, { nowMs, durable: false }).success, true);
  nowMs += 1;
  assert.equal(ledger.retire({
    transactionID: "retirement:broker-fee:0001",
    fromAccountID: "firm:caldari-industrial",
    amountCents: "5000",
    metadata: { sink: "named broker fee" },
  }, { nowMs, durable: false }).success, true);

  assert.equal(ledger.getAccount("firm:caldari-industrial").balanceCents, "80000");
  assert.equal(ledger.getAccount("firm:forge-haulage").balanceCents, "25000");
  assert.equal(ledger.getAccount(SYSTEM_ACCOUNTS.OPENING_EQUITY).balanceCents, "-100000");
  assert.equal(ledger.getAccount(SYSTEM_ACCOUNTS.EXTERNAL_ISSUANCE).balanceCents, "-10000");
  assert.equal(ledger.getAccount(SYSTEM_ACCOUNTS.EXTERNAL_RETIREMENT).balanceCents, "5000");
  const audit = ledger.audit();
  assert.equal(audit.success, true);
  assert.equal(audit.data.ledgerImbalanceCents, "0");
  assert.equal(audit.data.moneySupplyCents, "105000");
  assert.equal(audit.data.committedTransactionCount, 4);
  return audit.data;
}

function verifyFailClosedReads() {
  const memoryRepo = createMemoryRepository();
  let failedPath = null;
  const faultRepo = {
    ...memoryRepo,
    read(table, pathArg) {
      if (failedPath && String(pathArg) === failedPath) {
        return { success: false, errorMsg: "READ_ERROR", data: null };
      }
      return memoryRepo.read(table, pathArg);
    },
  };
  const stateStore = createStateStore({ repo: faultRepo });
  const ledger = createLedger({ stateStore, clock: () => 10_000 });
  assert.equal(ledger.ensureInitialized(10_000).success, true);
  assert.equal(ledger.createAccount({
    accountID: "fail-closed:source",
    ownerType: "test",
    ownerID: "source",
  }, { nowMs: 10_000, durable: false }).success, true);
  assert.equal(ledger.createAccount({
    accountID: "fail-closed:destination",
    ownerType: "test",
    ownerID: "destination",
  }, { nowMs: 10_000, durable: false }).success, true);
  assert.equal(ledger.openBalance({
    transactionID: "fail-closed:opening",
    accountID: "fail-closed:source",
    amountCents: "1000",
  }, { nowMs: 10_000, durable: false }).success, true);
  failedPath = "/transactionsByID/fail-closed:transfer";
  const rejected = ledger.transfer({
    transactionID: "fail-closed:transfer",
    fromAccountID: "fail-closed:source",
    toAccountID: "fail-closed:destination",
    amountCents: "100",
  }, { nowMs: 10_000, durable: false });
  assert.equal(rejected.success, false);
  assert.equal(rejected.errorMsg, "X_EVE_STATE_READ_FAILED");
  assert.equal(ledger.getAccount("fail-closed:source").balanceCents, "1000");
  assert.equal(ledger.getAccount("fail-closed:destination").balanceCents, "0");
  const blocked = ledger.transfer({
    transactionID: "fail-closed:blocked",
    fromAccountID: "fail-closed:source",
    toAccountID: "fail-closed:destination",
    amountCents: "100",
  }, { nowMs: 10_000, durable: false });
  assert.equal(blocked.success, false);
  assert.equal(blocked.errorMsg, "X_EVE_LEDGER_UNHEALTHY");
  failedPath = null;
  assert.equal(ledger.recover().success, true);
  assert.equal(ledger.getStatus().healthy, true);
  return {
    readFailure: rejected.errorMsg,
    blockedUntilAudit: blocked.errorMsg,
    recovered: true,
  };
}

function verifyAuditIntegrity() {
  const stateStore = createMemoryStateStore();
  const ledger = createLedger({ stateStore, clock: () => 20_000 });
  assert.equal(ledger.ensureInitialized(20_000).success, true);
  for (const accountID of ["audit:left", "audit:right"]) {
    assert.equal(ledger.createAccount({
      accountID,
      ownerType: "audit",
      ownerID: accountID,
    }, { nowMs: 20_000, durable: false }).success, true);
  }
  assert.equal(stateStore.saveTransaction({
    transactionID: "audit:corrupt-a",
    status: "committed",
    postings: [
      { accountID: "audit:left", amountCents: "100" },
      { accountID: "audit:right", amountCents: "-99" },
    ],
  }).success, true);
  assert.equal(stateStore.saveTransaction({
    transactionID: "audit:corrupt-b",
    status: "committed",
    postings: [
      { accountID: "audit:left", amountCents: "-100" },
      { accountID: "audit:right", amountCents: "99" },
    ],
  }).success, true);
  assert.equal(stateStore.saveTransaction({
    transactionID: "audit:interrupted",
    status: "prepared",
    postings: [
      { accountID: "audit:left", amountCents: "-1" },
      { accountID: "audit:right", amountCents: "1" },
    ],
  }).success, true);
  const audit = ledger.audit();
  assert.equal(audit.success, false);
  assert.equal(audit.data.ledgerImbalanceCents, "0");
  assert.deepEqual(audit.data.invalidTransactionIDs, [
    "audit:corrupt-a",
    "audit:corrupt-b",
  ]);
  assert.deepEqual(audit.data.interruptedTransactionIDs, ["audit:interrupted"]);
  assert.ok(audit.data.metadataMismatches.length > 0);
  assert.equal(ledger.recover().success, false);
  assert.equal(ledger.getStatus().healthy, false);
  const restartRuntime = new XEveRuntime({
    stateStore,
    clock: () => 20_001,
    options: { enabled: true, schedulerIntervalMs: 60_000 },
  });
  const rejectedStartup = restartRuntime.start({ force: true });
  assert.equal(rejectedStartup.success, false);
  assert.equal(rejectedStartup.errorMsg, "X_EVE_RECOVERY_AUDIT_FAILED");
  assert.equal(restartRuntime.getSnapshot().started, false);
  return {
    malformedTransactionsRejected: audit.data.invalidTransactionIDs.length,
    interruptedTransactionsRejected: audit.data.interruptedTransactionIDs.length,
    metadataMismatches: audit.data.metadataMismatches.length,
    corruptStartupRejected: rejectedStartup.errorMsg,
  };
}

function verifyLedgerGuards() {
  const stateStore = createMemoryStateStore();
  const ledger = createLedger({ stateStore, clock: () => 30_000 });
  assert.equal(ledger.ensureInitialized(30_000).success, true);
  for (const account of [
    { accountID: "guard:cash", countsTowardMoneySupply: true },
    { accountID: "guard:counterparty", countsTowardMoneySupply: true },
    {
      accountID: "guard:offbook",
      allowNegative: true,
      countsTowardMoneySupply: false,
    },
  ]) {
    assert.equal(ledger.createAccount({
      ...account,
      ownerType: "guard",
      ownerID: account.accountID,
    }, { nowMs: 30_000, durable: false }).success, true);
  }
  assert.equal(ledger.openBalance({
    transactionID: "guard:opening",
    accountID: "guard:cash",
    amountCents: "1000",
  }, { nowMs: 30_000, durable: false }).success, true);
  assert.equal(ledger.transfer({
    transactionID: "guard:source-a",
    sourceEventID: "authoritative:event:0001",
    fromAccountID: "guard:cash",
    toAccountID: "guard:counterparty",
    amountCents: "100",
  }, { nowMs: 30_001, durable: false }).success, true);
  const duplicateSource = ledger.transfer({
    transactionID: "guard:source-b",
    sourceEventID: "authoritative:event:0001",
    fromAccountID: "guard:cash",
    toAccountID: "guard:counterparty",
    amountCents: "100",
  }, { nowMs: 30_002, durable: false });
  assert.equal(duplicateSource.success, false);
  assert.equal(duplicateSource.errorMsg, "X_EVE_SOURCE_EVENT_CONFLICT");
  const unnamedIssuance = ledger.transfer({
    transactionID: "guard:unnamed-issuance",
    fromAccountID: "guard:offbook",
    toAccountID: "guard:cash",
    amountCents: "100",
  }, { nowMs: 30_003, durable: false });
  assert.equal(unnamedIssuance.success, false);
  assert.equal(unnamedIssuance.errorMsg, "X_EVE_UNNAMED_MONEY_SUPPLY_CHANGE");
  const audit = ledger.audit();
  assert.equal(audit.success, true);
  assert.equal(stateStore.listSourceEvents().length, 1);
  return {
    duplicateSourceRejected: duplicateSource.errorMsg,
    unnamedIssuanceRejected: unnamedIssuance.errorMsg,
    indexedSourceEvents: stateStore.listSourceEvents().length,
  };
}

function verifyStateShapes() {
  const scalarCollection = createStateStore({
    repo: createMemoryRepository({ inboxByID: "corrupt" }),
  });
  const isShapeError = (error) => error && error.code === "X_EVE_STATE_SHAPE_INVALID";
  assert.throws(() => scalarCollection.listInboxMessages(), isShapeError);
  assert.throws(() => scalarCollection.getInboxMessage("missing"), isShapeError);
  assert.throws(() => scalarCollection.saveInboxMessage({
    messageID: "shape:test",
  }), isShapeError);

  const mismatchedRecord = createStateStore({
    repo: createMemoryRepository({
      workOrdersByID: {
        "shape:key": { workOrderID: "shape:different" },
      },
    }),
  });
  assert.throws(() => mismatchedRecord.listWorkOrders(), isShapeError);

  const scalarMeta = createStateStore({ repo: createMemoryRepository({ meta: "corrupt" }) });
  assert.throws(() => scalarMeta.ensureInitialized(40_000), isShapeError);
  return {
    scalarCollectionRejected: true,
    mismatchedRecordRejected: true,
    scalarMetaRejected: true,
  };
}

function verifyGovernor() {
  const isolatedSpike = new XEveLoadGovernor({ recoveryMs: 5_000 });
  assert.equal(isolatedSpike.evaluate([
    ...ticks(105, 19),
    ...ticks(131, 1),
  ], 1_000).mode, MODE.HEALTHY);

  const governor = new XEveLoadGovernor({ recoveryMs: 5_000 });
  assert.equal(governor.evaluate(ticks(105), 1_000).mode, MODE.HEALTHY);
  assert.equal(governor.evaluate(ticks(125), 2_000).mode, MODE.CONSTRAINED);
  assert.deepEqual(
    governor.lastPolicy.allowedWorkClasses,
    [WORK_CLASS.SETTLEMENT, WORK_CLASS.DEADLINE],
  );
  assert.equal(governor.evaluate(ticks(135), 3_000).mode, MODE.OVERLOADED);
  assert.equal(governor.evaluate([...ticks(105, 19), ...ticks(500, 1)], 4_000).mode, MODE.SHED);
  assert.equal(governor.lastPolicy.maxJobs, 0);
  assert.equal(governor.evaluate([...ticks(105, 19), ...ticks(600, 1)], 5_000).mode, MODE.UNPLAYABLE);
  assert.equal(new XEveLoadGovernor().evaluate([
    ...ticks(600, 1),
    ...ticks(105, 19),
  ], 5_000).mode, MODE.HEALTHY);
  assert.equal(governor.evaluate(ticks(110), 6_000).mode, MODE.HEALTHY);

  const sustainedRecovery = new XEveLoadGovernor({ recoveryMs: 5_000 });
  assert.equal(sustainedRecovery.evaluate(ticks(125), 6_000).mode, MODE.CONSTRAINED);
  assert.equal(sustainedRecovery.evaluate(ticks(110), 7_000).mode, MODE.RECOVERING);
  assert.equal(sustainedRecovery.evaluate(ticks(110), 11_999).mode, MODE.RECOVERING);
  assert.equal(sustainedRecovery.evaluate(ticks(110), 12_000).mode, MODE.HEALTHY);
  assert.equal(sustainedRecovery.lastPolicy.maxJobs, 32);
  assert.equal(new XEveLoadGovernor().evaluate(ticks(105, 5), 1_000).mode, MODE.WARMING);
  assert.equal(new XEveLoadGovernor().evaluate(ticks(1_200, 1), 1_000).mode, MODE.UNPLAYABLE);
  return governor.getStatus();
}

function verifyRuntime() {
  let nowMs = 1_700_100_000_000;
  let monotonicMs = 0;
  const stateStore = createMemoryStateStore();
  const runtime = new XEveRuntime({
    stateStore,
    clock: () => nowMs,
    monotonicClock: () => monotonicMs,
    options: {
      enabled: true,
      schedulerIntervalMs: 60_000,
      schedulerBudgetMs: 2,
      maxJobsPerPass: 3,
      tickSampleCount: 20,
      recoveryMs: 0,
    },
  });
  let planningRuns = 0;
  let settlementRuns = 0;
  let deadlineRuns = 0;
  runtime.registerHandler("planning_test", (context) => {
    assert.equal(Object.prototype.hasOwnProperty.call(context, "runtime"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(context, "stateStore"), false);
    assert.equal(typeof context.ledger.audit, "undefined");
    assert.equal(typeof context.ledger.flushDurably, "undefined");
    planningRuns += 1;
    monotonicMs += 0.1;
    return { success: true };
  }, TEST_HANDLER_CONTRACT);
  runtime.registerHandler("settlement_test", () => {
    settlementRuns += 1;
    monotonicMs += 0.1;
    return { success: true };
  }, TEST_HANDLER_CONTRACT);
  runtime.registerHandler("deadline_test", () => {
    deadlineRuns += 1;
    monotonicMs += 0.1;
    return { success: true };
  }, TEST_HANDLER_CONTRACT);
  assert.throws(
    () => runtime.registerHandler(
      "async_test",
      async () => ({ success: true }),
      TEST_HANDLER_CONTRACT,
    ),
    /synchronous continuation/,
  );
  assert.throws(
    () => runtime.registerHandler("uncontracted_test", () => ({ success: true })),
    /declare a synchronous continuation slice budget/,
  );
  assert.throws(
    () => runtime.registerHandler(
      "oversized_contract_test",
      () => ({ success: true }),
      { continuation: true, sliceBudgetMs: 3 },
    ),
    /slice budget exceeds 2 ms/,
  );
  assert.equal(runtime.start({ force: true }).success, true);
  const timer = runtime.timer;
  assert.ok(timer);
  assert.throws(
    () => runtime.registerHandler("late_handler", () => ({ success: true }), TEST_HANDLER_CONTRACT),
    /X_EVE_HANDLER_REGISTRATION_CLOSED/,
  );
  assert.equal(runtime.start({ force: true }).success, true);
  assert.equal(runtime.timer, timer);
  nowMs += 2_000;
  const durableHandoff = runtime.maintainPersistence(nowMs);
  assert.equal(durableHandoff.success, true);
  assert.equal(runtime.getSnapshot().scheduler.metrics.durabilityHandoffSuccesses, 1);

  for (let index = 0; index < 5; index += 1) {
    assert.equal(runtime.scheduleWork({
      workOrderID: `planning:${index}`,
      workClass: WORK_CLASS.PLANNING,
      handlerType: "planning_test",
      dueAtMs: nowMs,
      payload: { index },
    }, { nowMs }).success, true);
  }
  const bounded = runtime.runDueWork(nowMs, { tickSummaries: ticks(105) });
  assert.equal(bounded.success, true);
  assert.equal(bounded.data.processedJobs, 3);
  assert.equal(planningRuns, 3);
  assert.equal(bounded.data.backlogByClass.planning, 2);

  assert.equal(runtime.scheduleWork({
    workOrderID: "settlement:pressure",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "settlement_test",
    dueAtMs: nowMs,
  }, { nowMs }).success, true);
  const constrained = runtime.runDueWork(nowMs, { tickSummaries: ticks(125) });
  assert.equal(constrained.data.mode, MODE.CONSTRAINED);
  assert.equal(constrained.data.processedJobs, 1);
  assert.equal(settlementRuns, 1);
  assert.equal(constrained.data.backlogByClass.planning, 2);

  assert.equal(runtime.scheduleWork({
    workOrderID: "deadline:overload",
    workClass: WORK_CLASS.DEADLINE,
    handlerType: "deadline_test",
    dueAtMs: nowMs,
  }, { nowMs }).success, true);
  const overloaded = runtime.runDueWork(nowMs, { tickSummaries: ticks(135) });
  assert.equal(overloaded.data.mode, MODE.OVERLOADED);
  assert.equal(overloaded.data.processedJobs, 1);
  assert.equal(deadlineRuns, 1);

  assert.equal(runtime.scheduleWork({
    workOrderID: "settlement:shed",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "settlement_test",
    dueAtMs: nowMs,
  }, { nowMs }).success, true);
  const beforeShed = runtime.getSnapshot().scheduler.backlogTotal;
  const shed = runtime.runDueWork(nowMs, {
    tickSummaries: [...ticks(105, 19), ...ticks(500, 1)],
  });
  assert.equal(shed.data.mode, MODE.SHED);
  assert.equal(shed.data.processedJobs, 0);
  assert.equal(runtime.getSnapshot().scheduler.backlogTotal, beforeShed);

  const event = {
    source: "living-economy",
    sourceEventID: "LEE-00000001",
    eventType: "mining_arrival",
    occurredAtMs: nowMs,
    payload: { stationID: 60003760, oreUnits: 100 },
  };
  const firstEvent = runtime.ingestEvent(event, { nowMs });
  assert.equal(firstEvent.success, true);
  assert.equal(firstEvent.replayed, false);
  const duplicateEvent = runtime.ingestEvent(event, { nowMs: nowMs + 100 });
  assert.equal(duplicateEvent.success, true);
  assert.equal(duplicateEvent.replayed, true);
  const conflictingEvent = runtime.ingestEvent({
    ...event,
    payload: { stationID: 60003760, oreUnits: 101 },
  }, { nowMs });
  assert.equal(conflictingEvent.success, false);
  assert.equal(conflictingEvent.errorMsg, "X_EVE_EVENT_CONFLICT");
  const conflictingIdentity = runtime.ingestEvent({
    ...event,
    messageID: "living-economy:alternate-message-id",
  }, { nowMs });
  assert.equal(conflictingIdentity.success, false);
  assert.equal(conflictingIdentity.errorMsg, "X_EVE_EVENT_IDENTITY_CONFLICT");
  const longMessageID = `m${"x".repeat(159)}`;
  const longMessageEvent = runtime.ingestEvent({
    ...event,
    messageID: longMessageID,
    sourceEventID: "LEE-00000002",
  }, { nowMs });
  assert.equal(longMessageEvent.success, true);
  const longMessageWork = stateStore.listWorkOrders().find(
    (workOrder) => workOrder.payload && workOrder.payload.messageID === longMessageID,
  );
  assert.ok(longMessageWork);
  assert.ok(longMessageWork.workOrderID.length <= 160);
  assert.equal(stateStore.listInboxMessages().length, 2);
  let recovered = null;
  for (
    let pass = 0;
    pass < 4 && stateStore.getInboxMessage(firstEvent.data.messageID);
    pass += 1
  ) {
    recovered = runtime.runDueWork(nowMs + 1 + pass, { tickSummaries: ticks(105) });
  }
  assert.ok(recovered);
  assert.equal(recovered.data.mode, MODE.HEALTHY);
  assert.equal(stateStore.getInboxMessage(firstEvent.data.messageID), null);
  assert.equal(
    stateStore.getReceipt(`event:${firstEvent.data.messageID}`).status,
    "observed",
  );
  const completedReplay = runtime.ingestEvent(event, { nowMs: nowMs + 2 });
  assert.equal(completedReplay.success, true);
  assert.equal(completedReplay.replayed, true);

  runtime.stop();
  assert.equal(runtime.timer, null);
  assert.equal(runtime.stop().success, true);

  const disabled = new XEveRuntime({
    stateStore: createMemoryStateStore(),
    options: { enabled: false },
  });
  const disabledStart = disabled.start();
  assert.equal(disabledStart.success, true);
  assert.equal(disabledStart.data.started, false);
  assert.equal(disabled.timer, null);

  return runtime.getSnapshot();
}

function verifyObservationBurstCapacity() {
  const nowMs = 1_700_150_000_000;
  const stateStore = createMemoryStateStore();
  const runtime = new XEveRuntime({
    stateStore,
    clock: () => nowMs,
    monotonicClock: () => 0,
    options: {
      enabled: true,
      schedulerIntervalMs: 60_000,
      schedulerBudgetMs: 2,
      tickSampleCount: 20,
      recoveryMs: 0,
    },
  });
  assert.equal(runtime.options.maxJobsPerPass, 32);
  assert.equal(runtime.start({ force: true }).success, true);

  const burstSize = 24;
  for (let index = 0; index < burstSize; index += 1) {
    const event = runtime.ingestEvent({
      source: "living-economy",
      sourceEventID: `LEE-BURST-${String(index).padStart(5, "0")}`,
      eventType: "mining_arrival",
      occurredAtMs: nowMs,
      payload: {
        stationID: 60_003_760,
        oreUnits: index + 1,
      },
    }, { nowMs });
    assert.equal(event.success, true);
  }

  assert.equal(runtime.getSnapshot().scheduler.backlogTotal, burstSize);
  const drained = runtime.runDueWork(nowMs, { tickSummaries: ticks(105) });
  assert.equal(drained.success, true);
  assert.equal(drained.data.processedJobs, burstSize);
  assert.equal(drained.data.backlogByClass.maintenance, 0);
  assert.equal(stateStore.listInboxMessages().length, 0);
  assert.equal(runtime.stop().success, true);

  return {
    configuredMaxJobsPerPass: runtime.options.maxJobsPerPass,
    burstSize,
    processedJobs: drained.data.processedJobs,
    remainingMaintenanceBacklog: drained.data.backlogByClass.maintenance,
  };
}

function verifySchedulerBudgetAndRecovery() {
  let nowMs = 1_700_200_000_000;
  let monotonicMs = 0;
  const budgetStore = createMemoryStateStore();
  const budgetRuntime = new XEveRuntime({
    stateStore: budgetStore,
    clock: () => nowMs,
    monotonicClock: () => monotonicMs,
    options: {
      enabled: true,
      schedulerIntervalMs: 60_000,
      schedulerBudgetMs: 1,
      maxJobsPerPass: 10,
      tickSampleCount: 20,
      recoveryMs: 0,
    },
  });
  let recursiveResult = null;
  budgetRuntime.registerHandler("budget_test", () => {
    if (!recursiveResult) recursiveResult = budgetRuntime.runDueWork(nowMs, {
      tickSummaries: ticks(105),
    });
    monotonicMs += 0.6;
    return { success: true };
  }, TEST_HANDLER_CONTRACT);
  assert.equal(budgetRuntime.start({ force: true }).success, true);
  for (let index = 0; index < 5; index += 1) {
    assert.equal(budgetRuntime.scheduleWork({
      workOrderID: `budget:${index}`,
      workClass: WORK_CLASS.SETTLEMENT,
      handlerType: "budget_test",
      dueAtMs: nowMs,
    }, { nowMs }).success, true);
  }
  const budgeted = budgetRuntime.runDueWork(nowMs, { tickSummaries: ticks(105) });
  assert.equal(budgeted.data.processedJobs, 2);
  assert.equal(budgeted.data.backlogByClass.settlement, 3);
  assert.equal(recursiveResult.success, false);
  assert.equal(recursiveResult.errorMsg, "X_EVE_SCHEDULER_BUSY");
  budgetRuntime.handlerBackoffUntilMs.set("budget_test", nowMs + 10_000);
  const backedOff = budgetRuntime.runDueWork(nowMs, {
    tickSummaries: ticks(105),
    maxJobs: 1,
  });
  assert.equal(backedOff.data.visitedJobs, 1);
  assert.equal(backedOff.data.processedJobs, 0);
  budgetRuntime.stop();

  const recoveryStore = createMemoryStateStore();
  recoveryStore.ensureInitialized(nowMs);
  const interruptedWork = createPersistedWorkRow({
    workOrderID: "interrupted:0001",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "recovery_test",
    status: "running",
    dueAtMs: nowMs - 1_000,
    payload: {},
    retryCount: 0,
    createdAtMs: nowMs - 2_000,
    updatedAtMs: nowMs - 1_000,
  });
  recoveryStore.saveWorkOrder(interruptedWork);
  const staleCompletedWork = createPersistedWorkRow({
    workOrderID: "stale-completed:0001",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "recovery_test",
    status: "running",
    dueAtMs: nowMs - 1_000,
    payload: {},
    retryCount: 0,
    createdAtMs: nowMs - 2_000,
    updatedAtMs: nowMs - 1_000,
  });
  recoveryStore.saveWorkOrder(staleCompletedWork);
  recoveryStore.saveReceipt({
    schemaVersion: 1,
    operationID: "work:stale-completed:0001",
    receiptType: "work_order",
    status: "completed",
    workOrderID: "stale-completed:0001",
    workClass: staleCompletedWork.workClass,
    handlerType: staleCompletedWork.handlerType,
    request: staleCompletedWork.request,
    requestFingerprint: staleCompletedWork.requestFingerprint,
    completedAtMs: nowMs - 500,
  });
  const recoveryRuntime = new XEveRuntime({
    stateStore: recoveryStore,
    clock: () => nowMs,
    options: {
      enabled: true,
      schedulerIntervalMs: 60_000,
      schedulerBudgetMs: 2,
      maxJobsPerPass: 8,
      tickSampleCount: 20,
      recoveryMs: 0,
    },
  });
  let recoveryRuns = 0;
  recoveryRuntime.registerHandler("recovery_test", () => {
    recoveryRuns += 1;
    return { success: true };
  }, TEST_HANDLER_CONTRACT);
  recoveryRuntime.registerHandler("rejected_test", () => ({
    success: false,
    errorMsg: "EXPECTED_HANDLER_REJECTION",
  }), TEST_HANDLER_CONTRACT);
  recoveryRuntime.registerHandler("dead_letter_test", () => ({
    success: false,
    errorMsg: "EXPECTED_DEAD_LETTER",
  }), TEST_HANDLER_CONTRACT);
  assert.equal(recoveryRuntime.start({ force: true }).success, true);
  assert.equal(recoveryStore.getWorkOrder("stale-completed:0001"), null);
  assert.equal(recoveryStore.getWorkOrder("interrupted:0001").status, "retry");
  assert.equal(
    recoveryStore.getWorkOrder("interrupted:0001").lastError,
    "X_EVE_INTERRUPTED_WORK_RECOVERED",
  );
  assert.equal(recoveryRuntime.runDueWork(nowMs, { tickSummaries: ticks(105) }).data.processedJobs, 1);
  assert.equal(recoveryRuns, 1);
  assert.equal(recoveryRuntime.scheduleWork({
    workOrderID: "rejected:0001",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "rejected_test",
    dueAtMs: nowMs,
  }, { nowMs }).success, true);
  assert.equal(
    recoveryRuntime.runDueWork(nowMs, { tickSummaries: ticks(105) }).data.retriedJobs,
    1,
  );
  assert.equal(recoveryStore.getWorkOrder("rejected:0001").status, "retry");
  assert.equal(recoveryStore.getWorkOrder("rejected:0001").lastError, "EXPECTED_HANDLER_REJECTION");
  assert.equal(recoveryRuntime.scheduleWork({
    workOrderID: "dead-letter:0001",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "dead_letter_test",
    dueAtMs: nowMs,
    maxAttempts: 1,
  }, { nowMs }).success, true);
  assert.equal(
    recoveryRuntime.runDueWork(nowMs, { tickSummaries: ticks(105) }).data.failedJobs,
    1,
  );
  assert.equal(recoveryStore.getWorkOrder("dead-letter:0001").status, "failed");
  recoveryRuntime.stop();

  let blockedNowMs = nowMs;
  const blockedBaseStore = createMemoryStateStore();
  const blockedStore = {
    ...blockedBaseStore,
    requestDurableHandoff() {
      return { success: true, blocked: true, pendingDirty: true, handedOff: true };
    },
  };
  const blockedRuntime = new XEveRuntime({
    stateStore: blockedStore,
    clock: () => blockedNowMs,
    options: {
      enabled: true,
      schedulerIntervalMs: 1_000,
      durabilityIntervalMs: 500,
      tickSampleCount: 20,
      recoveryMs: 0,
    },
  });
  assert.equal(blockedRuntime.start({ force: true }).success, true);
  blockedNowMs += 500;
  assert.equal(blockedRuntime.maintainPersistence(blockedNowMs).success, true);
  blockedNowMs += 500;
  const stalledHandoff = blockedRuntime.maintainPersistence(blockedNowMs);
  assert.equal(stalledHandoff.success, false);
  assert.equal(stalledHandoff.errorMsg, "X_EVE_DURABLE_HANDOFF_STALLED");
  assert.equal(blockedRuntime.getSnapshot().scheduler.persistenceHealthy, false);
  blockedRuntime.stop();

  const transientBaseStore = createMemoryStateStore();
  let transientFlushFailure = false;
  const transientStore = {
    ...transientBaseStore,
    flushDurably() {
      return transientFlushFailure
        ? { success: false, errorMsg: "TEST_TRANSIENT_FLUSH_FAILURE" }
        : transientBaseStore.flushDurably();
    },
  };
  const transientRuntime = new XEveRuntime({
    stateStore: transientStore,
    clock: () => nowMs,
    options: { enabled: true, schedulerIntervalMs: 60_000 },
  });
  assert.equal(transientRuntime.start({ force: true }).success, true);
  transientFlushFailure = true;
  assert.equal(transientRuntime.flushDurably().success, false);
  assert.equal(transientRuntime.getSnapshot().scheduler.persistenceHealthy, false);
  transientFlushFailure = false;
  assert.equal(transientRuntime.recoverPersistence().success, true);
  assert.equal(transientRuntime.getSnapshot().scheduler.persistenceHealthy, true);
  transientFlushFailure = true;
  assert.equal(transientRuntime.stop().success, false);
  assert.equal(transientRuntime.getSnapshot().started, true);
  assert.ok(transientRuntime.timer);
  transientFlushFailure = false;
  assert.equal(transientRuntime.stop().success, true);
  assert.equal(transientRuntime.getSnapshot().started, false);

  return {
    budgetProcessedJobs: budgeted.data.processedJobs,
    budgetRemainingJobs: budgeted.data.backlogByClass.settlement,
    backedOffVisits: backedOff.data.visitedJobs,
    reentrantPassRejected: recursiveResult.errorMsg,
    interruptedWorkRecovered: recoveryRuns,
    explicitHandlerFailureRetried: recoveryStore.getWorkOrder("rejected:0001").retryCount,
    deterministicFailureDeadLettered: recoveryStore.getWorkOrder("dead-letter:0001").status,
    staleCompletionSuppressed: recoveryStore.getWorkOrder("stale-completed:0001") === null,
    stalledDurabilityDetected: stalledHandoff.errorMsg,
    transientPersistenceRecoveredWithoutRestart: true,
    failedStopRemainedRetryable: true,
  };
}

function verifyHandlerQuarantine() {
  const nowMs = 1_700_300_000_000;
  const baseStore = createMemoryStateStore();
  let durableFlushes = 0;
  const stateStore = {
    ...baseStore,
    flushDurably() {
      durableFlushes += 1;
      return baseStore.flushDurably();
    },
  };
  const runtime = new XEveRuntime({
    stateStore,
    clock: () => nowMs,
    options: {
      enabled: true,
      schedulerIntervalMs: 60_000,
      schedulerBudgetMs: 2,
      maxJobsPerPass: 8,
      tickSampleCount: 20,
      recoveryMs: 0,
    },
  });
  let thenableRuns = 0;
  let capturedLedger = null;
  runtime.registerHandler("thenable_test", (context) => {
    thenableRuns += 1;
    capturedLedger = context.ledger;
    return Promise.resolve().then(() => context.ledger.getStatus());
  }, TEST_HANDLER_CONTRACT);
  let plainRuns = 0;
  runtime.registerHandler("plain_then_property", () => {
    plainRuns += 1;
    return { success: true, then: false };
  }, TEST_HANDLER_CONTRACT);
  assert.equal(runtime.start({ force: true }).success, true);
  const flushesBeforeQuarantine = durableFlushes;
  assert.equal(runtime.scheduleWork({
    workOrderID: "thenable:0001",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "thenable_test",
    dueAtMs: nowMs,
    retryForever: true,
  }, { nowMs }).success, true);
  const uncertain = runtime.runDueWork(nowMs, { tickSummaries: ticks(105) });
  assert.equal(uncertain.success, true);
  assert.equal(uncertain.data.failedJobs, 1);
  assert.equal(uncertain.data.retriedJobs, 0);
  assert.equal(thenableRuns, 1);
  assert.equal(baseStore.getWorkOrder("thenable:0001").status, WORK_STATUS.QUARANTINED);
  assert.equal(baseStore.getWorkOrder("thenable:0001").uncertainOutcome, true);
  assert.ok(durableFlushes > flushesBeforeQuarantine);
  const quarantineFlushes = durableFlushes - flushesBeforeQuarantine;
  assert.throws(() => capturedLedger.getStatus(), /X_EVE_HANDLER_SCOPE_CLOSED/);
  assert.equal(
    runtime.runDueWork(nowMs + 1, { tickSummaries: ticks(105) }).data.processedJobs,
    0,
  );
  assert.equal(thenableRuns, 1);

  assert.equal(runtime.scheduleWork({
    workOrderID: "plain-then:0001",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "plain_then_property",
    dueAtMs: nowMs,
  }, { nowMs }).success, true);
  assert.equal(
    runtime.runDueWork(nowMs + 1, { tickSummaries: ticks(105) }).data.completedJobs,
    1,
  );
  assert.equal(plainRuns, 1);
  runtime.stop();

  const restarted = new XEveRuntime({
    stateStore,
    clock: () => nowMs + 2,
    options: {
      enabled: true,
      schedulerIntervalMs: 60_000,
      schedulerBudgetMs: 2,
      tickSampleCount: 20,
      recoveryMs: 0,
    },
  });
  restarted.registerHandler("thenable_test", () => {
    thenableRuns += 1;
    return Promise.resolve({ success: true });
  }, TEST_HANDLER_CONTRACT);
  assert.equal(restarted.start({ force: true }).success, true);
  const quarantinedSchedule = restarted.scheduleWork({
    workOrderID: "thenable:0002",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "thenable_test",
    dueAtMs: nowMs + 2,
  }, { nowMs: nowMs + 2 });
  assert.equal(quarantinedSchedule.success, false);
  assert.equal(quarantinedSchedule.errorMsg, "X_EVE_HANDLER_QUARANTINED");
  assert.equal(
    restarted.runDueWork(nowMs + 2, { tickSummaries: ticks(105) }).data.processedJobs,
    0,
  );
  assert.equal(thenableRuns, 1);
  restarted.stop();

  let unplayableMonotonicMs = 0;
  const unplayableStore = createMemoryStateStore();
  const unplayableRuntime = new XEveRuntime({
    stateStore: unplayableStore,
    clock: () => nowMs,
    monotonicClock: () => unplayableMonotonicMs,
    options: {
      enabled: true,
      schedulerIntervalMs: 60_000,
      schedulerBudgetMs: 2,
      tickSampleCount: 20,
      unplayableMs: 600,
    },
  });
  unplayableRuntime.registerHandler("unplayable_handler_test", () => {
    unplayableMonotonicMs += 601;
    return { success: true };
  }, TEST_HANDLER_CONTRACT);
  assert.equal(unplayableRuntime.start({ force: true }).success, true);
  assert.equal(unplayableRuntime.scheduleWork({
    workOrderID: "unplayable-handler:0001",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "unplayable_handler_test",
    dueAtMs: nowMs,
  }, { nowMs }).success, true);
  assert.equal(
    unplayableRuntime.runDueWork(nowMs, { tickSummaries: ticks(105) }).data.completedJobs,
    1,
  );
  assert.equal(unplayableRuntime.getSnapshot().scheduler.metrics.unplayableHandlerTrips, 1);
  assert.equal(unplayableRuntime.scheduleWork({
    workOrderID: "unplayable-handler:0002",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "unplayable_handler_test",
    dueAtMs: nowMs,
  }, { nowMs }).errorMsg, "X_EVE_HANDLER_QUARANTINED");
  unplayableRuntime.stop();

  const restartedUnplayable = new XEveRuntime({
    stateStore: unplayableStore,
    clock: () => nowMs + 2,
    options: {
      enabled: true,
      schedulerIntervalMs: 60_000,
      schedulerBudgetMs: 2,
      tickSampleCount: 20,
      unplayableMs: 600,
    },
  });
  restartedUnplayable.registerHandler(
    "unplayable_handler_test",
    () => ({ success: true }),
    TEST_HANDLER_CONTRACT,
  );
  assert.equal(restartedUnplayable.start({ force: true }).success, true);
  assert.equal(restartedUnplayable.scheduleWork({
    workOrderID: "unplayable-handler:after-restart",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "unplayable_handler_test",
    dueAtMs: nowMs + 2,
  }, { nowMs: nowMs + 2 }).errorMsg, "X_EVE_HANDLER_QUARANTINED");
  restartedUnplayable.stop();

  return {
    thenableRuns,
    storedStatus: baseStore.getWorkOrder("thenable:0001").status,
    retryCount: baseStore.getWorkOrder("thenable:0001").retryCount,
    durableQuarantineFlushes: quarantineFlushes,
    closedLedgerCapability: true,
    plainThenPropertyCompleted: plainRuns === 1,
    unplayableHandlerTrips: 1,
    unplayableQuarantineSurvivedRestart: true,
  };
}

function verifyHandlerEffectIdempotency() {
  let nowMs = 1_700_350_000_000;
  const stateStore = createMemoryStateStore();
  const ledger = createLedger({ stateStore, clock: () => nowMs });
  assert.equal(ledger.ensureInitialized(nowMs, { durable: false }).success, true);
  assert.equal(ledger.createAccount({
    accountID: "pilot:retry-safe",
    name: "Retry Safe Pilot",
    ownerType: "pilot",
    ownerID: "retry-safe",
    category: "cash",
  }, { nowMs, durable: false }).success, true);
  assert.equal(ledger.createAccount({
    accountID: "pilot:reschedule-guard",
    name: "Reschedule Guard Pilot",
    ownerType: "pilot",
    ownerID: "reschedule-guard",
    category: "cash",
  }, { nowMs, durable: false }).success, true);
  assert.equal(ledger.createAccount({
    accountID: "pilot:terminal-effect-guard",
    name: "Terminal Effect Guard Pilot",
    ownerType: "pilot",
    ownerID: "terminal-effect-guard",
    category: "cash",
  }, { nowMs, durable: false }).success, true);

  const runtime = new XEveRuntime({
    stateStore,
    ledger,
    clock: () => nowMs,
    options: {
      enabled: true,
      schedulerIntervalMs: 60_000,
      schedulerBudgetMs: 2,
      maxJobsPerPass: 8,
      tickSampleCount: 20,
      recoveryMs: 0,
      retryBaseDelayMs: 1_000,
    },
  });
  let attempts = 0;
  let replayedOnRetry = false;
  runtime.registerHandler("retry_safe_issue", (context) => {
    attempts += 1;
    const result = context.ledger.issue({
      toAccountID: "pilot:retry-safe",
      amountCents: "100",
      memo: "deterministic work effect",
      metadata: { purpose: "retry-idempotency-test" },
    });
    assert.equal(result.success, true);
    replayedOnRetry = attempts > 1 && result.replayed === true;
    if (attempts === 1) throw Object.assign(new Error("TEST_POST_THEN_FAIL"), {
      code: "TEST_POST_THEN_FAIL",
    });
    return { success: true };
  }, TEST_HANDLER_CONTRACT);
  runtime.registerHandler("mismatched_effect", (context) => {
    context.ledger.issue({
      transactionID: "attempt-specific-id",
      toAccountID: "pilot:retry-safe",
      amountCents: "999",
    });
    return { success: true };
  }, TEST_HANDLER_CONTRACT);
  runtime.registerHandler("effect_then_reschedule", (context) => {
    const result = context.ledger.issue({
      toAccountID: "pilot:reschedule-guard",
      amountCents: "50",
      memo: "must not repeat across continuation slices",
    });
    assert.equal(result.success, true);
    return { success: true, rescheduleAtMs: context.nowMs + 1_000 };
  }, TEST_HANDLER_CONTRACT);
  runtime.registerHandler("effect_then_permanent_failure", (context) => {
    const result = context.ledger.issue({
      toAccountID: "pilot:terminal-effect-guard",
      amountCents: "75",
      memo: "terminal post-effect failure guard",
    });
    assert.equal(result.success, true);
    throw Object.assign(new Error("TEST_PERMANENT_POST_EFFECT_FAILURE"), {
      code: "TEST_PERMANENT_POST_EFFECT_FAILURE",
    });
  }, TEST_HANDLER_CONTRACT);

  assert.equal(runtime.start({ force: true }).success, true);
  assert.equal(runtime.scheduleWork({
    workOrderID: "retry-safe:0001",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "retry_safe_issue",
    dueAtMs: nowMs,
    maxAttempts: 3,
  }, { nowMs }).success, true);
  assert.equal(runtime.runDueWork(nowMs, { tickSummaries: ticks(105) }).data.retriedJobs, 1);
  assert.equal(ledger.getAccount("pilot:retry-safe").balanceCents, "100");
  nowMs += 1_000;
  assert.equal(runtime.runDueWork(nowMs, { tickSummaries: ticks(105) }).data.completedJobs, 1);
  assert.equal(attempts, 2);
  assert.equal(replayedOnRetry, true);
  assert.equal(ledger.getAccount("pilot:retry-safe").balanceCents, "100");
  const effectID = "work:retry-safe:0001";
  assert.equal(ledger.getTransaction(effectID).sourceEventID, effectID);

  assert.equal(runtime.scheduleWork({
    workOrderID: "retry-safe:mismatch",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "mismatched_effect",
    dueAtMs: nowMs,
    maxAttempts: 1,
  }, { nowMs }).success, true);
  assert.equal(runtime.runDueWork(nowMs, { tickSummaries: ticks(105) }).data.failedJobs, 1);
  assert.equal(ledger.getAccount("pilot:retry-safe").balanceCents, "100");
  assert.equal(runtime.scheduleWork({
    workOrderID: "retry-safe:reschedule-guard",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "effect_then_reschedule",
    dueAtMs: nowMs,
  }, { nowMs }).success, true);
  let rescheduleGuardResult = null;
  for (let pass = 0; pass < 4; pass += 1) {
    const stored = stateStore.getWorkOrder("retry-safe:reschedule-guard");
    if (stored && stored.status === "quarantined") break;
    rescheduleGuardResult = runtime.runDueWork(nowMs + pass, {
      tickSummaries: ticks(105),
    });
  }
  assert.ok(rescheduleGuardResult && rescheduleGuardResult.success === true);
  assert.equal(
    stateStore.getWorkOrder("retry-safe:reschedule-guard").status,
    "quarantined",
  );
  assert.equal(ledger.getAccount("pilot:reschedule-guard").balanceCents, "50");
  assert.equal(runtime.scheduleWork({
    workOrderID: "retry-safe:terminal-effect-guard",
    workClass: WORK_CLASS.SETTLEMENT,
    handlerType: "effect_then_permanent_failure",
    dueAtMs: nowMs,
    maxAttempts: 2,
  }, { nowMs }).success, true);
  assert.equal(
    runtime.runDueWork(nowMs, { tickSummaries: ticks(105) }).data.retriedJobs,
    1,
  );
  nowMs += 1_000;
  assert.equal(
    runtime.runDueWork(nowMs, { tickSummaries: ticks(105) }).data.failedJobs,
    1,
  );
  assert.equal(
    stateStore.getWorkOrder("retry-safe:terminal-effect-guard").status,
    "quarantined",
  );
  assert.equal(ledger.getAccount("pilot:terminal-effect-guard").balanceCents, "75");
  runtime.stop();
  return {
    handlerAttempts: attempts,
    finalBalanceCents: ledger.getAccount("pilot:retry-safe").balanceCents,
    replayedOnRetry,
    effectTransactionID: effectID,
    mismatchedIDRejected: true,
    effectPlusRescheduleQuarantined: true,
    terminalPostEffectFailureQuarantined: true,
  };
}

function verifyRuntimeStateAudit() {
  const nowMs = 1_700_400_000_000;
  const repairStore = createMemoryStateStore();
  assert.equal(repairStore.ensureInitialized(nowMs).success, true);
  const message = createPersistedInboxRow({
    messageID: "audit-source:audit-event:repair",
    sourceEventID: "audit-event:repair",
    occurredAtMs: nowMs - 1_000,
    receivedAtMs: nowMs - 500,
    payload: { quantity: 10 },
  });
  assert.equal(repairStore.saveInboxMessage(message).success, true);
  const repairRuntime = new XEveRuntime({
    stateStore: repairStore,
    clock: () => nowMs,
    options: { enabled: true, schedulerIntervalMs: 60_000 },
  });
  assert.equal(repairRuntime.start({ force: true }).success, true);
  const repairedWorkID = repairRuntime._receiptID("inbox", message.messageID);
  assert.ok(repairStore.getWorkOrder(repairedWorkID));
  repairRuntime.stop();

  const conflictingRequest = {
    ...message.request,
    payload: { quantity: 11 },
  };
  assert.equal(repairStore.saveReceipt({
    schemaVersion: 1,
    operationID: `event:${message.messageID}`,
    receiptType: "inbox_event",
    status: "observed",
    messageID: message.messageID,
    request: conflictingRequest,
    requestFingerprint: fingerprint(conflictingRequest),
    source: conflictingRequest.source,
    sourceEventID: conflictingRequest.sourceEventID,
    eventType: conflictingRequest.eventType,
    version: conflictingRequest.version,
    occurredAtMs: conflictingRequest.occurredAtMs,
    recordedAtMs: nowMs,
  }).success, true);
  let conflictFlushes = 0;
  const conflictStore = {
    ...repairStore,
    flushDurably() {
      conflictFlushes += 1;
      return repairStore.flushDurably();
    },
  };
  const conflictRuntime = new XEveRuntime({
    stateStore: conflictStore,
    clock: () => nowMs,
    options: { enabled: true, schedulerIntervalMs: 60_000 },
  });
  const conflictStart = conflictRuntime.start({ force: true });
  assert.equal(conflictStart.success, false);
  assert.equal(conflictStart.errorMsg, "X_EVE_EVENT_RECEIPT_CONFLICT");
  assert.equal(conflictFlushes, 0);
  assert.ok(repairStore.getInboxMessage(message.messageID));
  assert.ok(repairStore.getWorkOrder(repairedWorkID));

  const classStore = createMemoryStateStore();
  assert.equal(classStore.ensureInitialized(nowMs).success, true);
  assert.equal(classStore.saveWorkOrder(createPersistedWorkRow({
    workOrderID: "invalid-class:0001",
    workClass: "invalid",
    handlerType: "invalid_class_test",
    dueAtMs: nowMs,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  })).success, true);
  let invalidClassFlushes = 0;
  const guardedClassStore = {
    ...classStore,
    flushDurably() {
      invalidClassFlushes += 1;
      return classStore.flushDurably();
    },
  };
  const classRuntime = new XEveRuntime({
    stateStore: guardedClassStore,
    clock: () => nowMs,
    options: { enabled: true, schedulerIntervalMs: 60_000 },
  });
  classRuntime.registerHandler("invalid_class_test", () => ({ success: true }), TEST_HANDLER_CONTRACT);
  const invalidClassStart = classRuntime.start({ force: true });
  assert.equal(invalidClassStart.success, false);
  assert.equal(invalidClassStart.errorMsg, "X_EVE_WORK_CLASS_INVALID");
  assert.equal(invalidClassFlushes, 0);

  const corruptStore = createMemoryStateStore();
  assert.equal(corruptStore.ensureInitialized(nowMs).success, true);
  const corruptMessage = createPersistedInboxRow({
    messageID: "audit-source:audit-event:corrupt",
    sourceEventID: "audit-event:corrupt",
    occurredAtMs: nowMs,
    receivedAtMs: nowMs,
  });
  corruptMessage.requestFingerprint = "0".repeat(64);
  assert.equal(corruptStore.saveInboxMessage(corruptMessage).success, true);
  const corruptRuntime = new XEveRuntime({
    stateStore: corruptStore,
    clock: () => nowMs,
    options: { enabled: true, schedulerIntervalMs: 60_000 },
  });
  const corruptStart = corruptRuntime.start({ force: true });
  assert.equal(corruptStart.success, false);
  assert.equal(corruptStart.errorMsg, "X_EVE_INBOX_FINGERPRINT_MISMATCH");

  const orphanStore = createMemoryStateStore();
  assert.equal(orphanStore.ensureInitialized(nowMs).success, true);
  assert.equal(orphanStore.saveWorkOrder(createPersistedWorkRow({
    workOrderID: "inbox:orphan-message",
    workClass: WORK_CLASS.MAINTENANCE,
    handlerType: "observe_event",
    dueAtMs: nowMs,
    payload: { messageID: "orphan-message" },
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  })).success, true);
  const orphanRuntime = new XEveRuntime({
    stateStore: orphanStore,
    clock: () => nowMs,
    options: { enabled: true, schedulerIntervalMs: 60_000 },
  });
  const orphanStart = orphanRuntime.start({ force: true });
  assert.equal(orphanStart.success, false);
  assert.equal(orphanStart.errorMsg, "X_EVE_ORPHAN_INBOX_WORK");

  const retryStore = createMemoryStateStore();
  assert.equal(retryStore.ensureInitialized(nowMs).success, true);
  assert.equal(retryStore.saveWorkOrder(createPersistedWorkRow({
    workOrderID: "retry-deadline:0001",
    workClass: WORK_CLASS.DEADLINE,
    handlerType: "retry_audit_test",
    requestedDueAtMs: nowMs - 10_000,
    dueAtMs: nowMs + 10_000,
    status: "retry",
    retryCount: 1,
    lastError: "EXPECTED_RETRY",
    createdAtMs: nowMs - 20_000,
    updatedAtMs: nowMs - 5_000,
  })).success, true);
  const retryRuntime = new XEveRuntime({
    stateStore: retryStore,
    clock: () => nowMs,
    options: { enabled: true, schedulerIntervalMs: 60_000 },
  });
  retryRuntime.registerHandler("retry_audit_test", () => ({ success: true }), TEST_HANDLER_CONTRACT);
  assert.equal(retryRuntime.start({ force: true }).success, true);
  retryRuntime.stop();

  return {
    missingInboxWorkRepaired: Boolean(repairStore.getWorkOrder(repairedWorkID)),
    receiptConflictRejected: conflictStart.errorMsg,
    ambiguousRowsFlushed: conflictFlushes,
    invalidClassRejected: invalidClassStart.errorMsg,
    corruptFingerprintRejected: corruptStart.errorMsg,
    orphanWorkRejected: orphanStart.errorMsg,
    mutableRetryDeadlineAccepted: true,
  };
}

function verifyTelemetryBands() {
  const telemetry = require("../src/space/runtimePerformanceTelemetry");
  const sustained = telemetry._testing.buildCapacitySummary(
    telemetry._testing.summarizeRuntimeTicks({
    _recentTickSummaries: ticks(131, 20),
    }),
  );
  assert.equal(sustained.baselineMs, 100);
  assert.equal(sustained.warningMs, 120);
  assert.equal(sustained.softLimitMs, 130);
  assert.equal(sustained.emergencyShedMs, 500);
  assert.equal(sustained.unplayableMs, 600);
  assert.equal(sustained.status, "soft_limit");
  const isolatedEmergency = telemetry._testing.buildCapacitySummary(
    telemetry._testing.summarizeRuntimeTicks({
      _recentTickSummaries: [...ticks(600, 1), ...ticks(105, 19)],
    }),
  );
  assert.equal(isolatedEmergency.status, "unplayable");
  const coldEmergency = telemetry._testing.buildCapacitySummary(
    telemetry._testing.summarizeRuntimeTicks({
      _recentTickSummaries: ticks(1_200, 1),
    }),
  );
  assert.equal(coldEmergency.status, "unplayable");
  const warming = telemetry._testing.buildCapacitySummary(
    telemetry._testing.summarizeRuntimeTicks({
      _recentTickSummaries: ticks(105, 1),
    }),
  );
  assert.equal(warming.status, "warming");
  return {
    sustained,
    isolatedEmergency,
    coldEmergency,
    warming,
  };
}

function verifyPersistence() {
  const gameStore = require("../src/gameStore");
  const sqliteStore = require("../src/gameStore/sqliteStore");
  const store = createStateStore();
  const ledger = createLedger({ stateStore: store, clock: () => 2_000 });
  assert.equal(ledger.ensureInitialized(2_000, { durable: true }).success, true);
  assert.equal(ledger.createAccount({
    accountID: "firm:persistent-test",
    name: "Persistent Test Firm",
    ownerType: "firm",
    ownerID: "persistent-test",
  }, { nowMs: 2_000, durable: false }).success, true);
  assert.equal(ledger.createAccount({
    accountID: "firm:persistent-counterparty",
    name: "Persistent Test Counterparty",
    ownerType: "firm",
    ownerID: "persistent-counterparty",
  }, { nowMs: 2_000, durable: false }).success, true);
  assert.equal(ledger.openBalance({
    transactionID: "opening:persistent-test",
    accountID: "firm:persistent-test",
    amountCents: "123456789",
  }, { nowMs: 2_000, durable: true }).success, true);
  assert.equal(store.saveOutboxOperation({
    operationID: "projection:test:0001",
    status: "pending",
    adapter: "native-wallet",
    createdAtMs: 2_000,
  }).success, true);
  assert.equal(store.flushDurably().success, true);

  const durableTransferDurationsMs = [];
  const durableIterations = 100;
  for (let index = 0; index < durableIterations; index += 1) {
    const even = index % 2 === 0;
    const startedAt = performance.now();
    const result = ledger.transfer({
      transactionID: `durable-benchmark:${String(index).padStart(4, "0")}`,
      fromAccountID: even ? "firm:persistent-test" : "firm:persistent-counterparty",
      toAccountID: even ? "firm:persistent-counterparty" : "firm:persistent-test",
      amountCents: "1",
      effectiveAtMs: 2_001 + index,
    }, { nowMs: 2_001 + index, durable: true });
    durableTransferDurationsMs.push(performance.now() - startedAt);
    assert.equal(result.success, true);
  }
  const sortedDurations = [...durableTransferDurationsMs].sort((left, right) => left - right);
  const percentile = (fraction) => sortedDurations[
    Math.min(sortedDurations.length - 1, Math.ceil(sortedDurations.length * fraction) - 1)
  ];
  const durableAverageMs = durableTransferDurationsMs.reduce(
    (total, durationMs) => total + durationMs,
    0,
  ) / durableTransferDurationsMs.length;
  const durableP95Ms = percentile(0.95);
  const durableMaximumMs = sortedDurations[sortedDurations.length - 1];
  assert.ok(
    durableMaximumMs < 600,
    `durable SQLite transfer exceeded the 600 ms unplayable boundary (${durableMaximumMs.toFixed(1)} ms)`,
  );

  const batchedIterations = 100;
  for (let index = 0; index < batchedIterations; index += 1) {
    const even = index % 2 === 0;
    const result = ledger.transfer({
      transactionID: `batched-benchmark:${String(index).padStart(4, "0")}`,
      fromAccountID: even ? "firm:persistent-test" : "firm:persistent-counterparty",
      toAccountID: even ? "firm:persistent-counterparty" : "firm:persistent-test",
      amountCents: "1",
      effectiveAtMs: 3_001 + index,
    }, { nowMs: 3_001 + index, durable: false });
    assert.equal(result.success, true);
  }
  const batchedStartedAt = performance.now();
  const batchedHandoff = store.requestDurableHandoff();
  const batchedHandoffMs = performance.now() - batchedStartedAt;
  assert.equal(batchedHandoff.success, true);
  assert.equal(batchedHandoff.blocked, false);
  assert.ok(
    batchedHandoffMs < 600,
    `batched SQLite handoff exceeded the 600 ms unplayable boundary (${batchedHandoffMs.toFixed(1)} ms)`,
  );
  assert.equal(store.flushDurably().success, true);

  const persistedRuntime = new XEveRuntime({
    stateStore: store,
    clock: () => 5_000,
    options: { enabled: true, schedulerIntervalMs: 60_000 },
  });
  assert.equal(persistedRuntime.start({ force: true }).success, true);
  const durableEventStartedAt = performance.now();
  const durableEvent = persistedRuntime.ingestEvent({
    source: "persistence-test",
    sourceEventID: "event:0001",
    eventType: "test_event",
    occurredAtMs: 5_000,
    payload: { quantity: 1 },
  }, { nowMs: 5_000, durable: true });
  const durableEventMs = performance.now() - durableEventStartedAt;
  assert.equal(durableEvent.success, true);
  assert.ok(durableEventMs < 600);
  const eventBatchStartedAt = performance.now();
  for (let index = 0; index < 64; index += 1) {
    assert.equal(persistedRuntime.ingestEvent({
      source: "persistence-test",
      sourceEventID: `batch-event:${String(index).padStart(4, "0")}`,
      eventType: "test_event",
      occurredAtMs: 6_000 + index,
      payload: { index },
    }, { nowMs: 6_000 + index, durable: false }).success, true);
  }
  const eventBatchHandoff = persistedRuntime.maintainPersistence(7_000, { force: true });
  const eventBatchMs = performance.now() - eventBatchStartedAt;
  assert.equal(eventBatchHandoff.success, true);
  assert.ok(eventBatchMs < 120, `64-event durable batch took ${eventBatchMs.toFixed(1)} ms`);
  const replayWindowEvents = 4_096;
  const replayWindowStartedAt = performance.now();
  for (let index = 0; index < replayWindowEvents; index += 1) {
    assert.equal(persistedRuntime.ingestEvent({
      source: "persistence-test",
      sourceEventID: `replay-window:${String(index).padStart(4, "0")}`,
      eventType: "test_event",
      occurredAtMs: 8_000 + index,
      payload: { index },
    }, { nowMs: 8_000 + index, durable: false }).success, true);
  }
  const replayWindowHandoff = persistedRuntime.maintainPersistence(13_000, { force: true });
  const replayWindowTotalMs = performance.now() - replayWindowStartedAt;
  assert.equal(replayWindowHandoff.success, true);
  assert.ok(
    replayWindowTotalMs < 600,
    `4,096-event replay window exceeded the 600 ms boundary (${replayWindowTotalMs.toFixed(1)} ms)`,
  );
  assert.equal(persistedRuntime.stop().success, true);
  const restartRuntime = new XEveRuntime({
    stateStore: store,
    clock: () => 14_000,
    options: { enabled: true, schedulerIntervalMs: 60_000 },
  });
  const restartStartedAt = performance.now();
  const restartResult = restartRuntime.start({ force: true });
  const restartRecoveryMs = performance.now() - restartStartedAt;
  assert.equal(restartResult.success, true);
  assert.ok(
    restartRecoveryMs < 600,
    `4,096-event restart audit exceeded the 600 ms boundary (${restartRecoveryMs.toFixed(1)} ms)`,
  );
  assert.equal(restartRuntime.stop().success, true);

  assert.ok(sqliteStore.rowCount("xEveRuntime") >= 8);
  const dbPath = gameStore._sqliteDbPath;
  const persisted = sqliteStore.loadTableObject("xEveRuntime");
  assert.equal(persisted.accountsByID["firm:persistent-test"].balanceCents, "123456789");
  assert.equal(persisted.transactionsByID["opening:persistent-test"].status, "committed");
  assert.equal(persisted.outboxByID["projection:test:0001"].status, "pending");
  sqliteStore.close();
  sqliteStore.init(dbPath);
  const reopened = sqliteStore.loadTableObject("xEveRuntime");
  assert.equal(reopened.accountsByID["firm:persistent-test"].balanceCents, "123456789");
  assert.equal(reopened.transactionsByID["opening:persistent-test"].requestFingerprint.length, 64);
  assert.equal(store.suspendPersistence("EXPECTED_TEST_QUARANTINE").success, true);
  const suspendedFlush = store.flushDurably();
  assert.equal(suspendedFlush.success, false);
  assert.equal(suspendedFlush.errorMsg, "FLUSH_SUSPENDED");
  assert.equal(store.resumePersistence().success, true);
  assert.equal(store.flushDurably().success, true);

  const livingEconomyState = require(
    "../src/space/npc/ambientTraffic/livingEconomyState"
  );
  const sourceState = livingEconomyState.buildDefaultState();
  sourceState.createdAtMs = 15_000;
  sourceState.updatedAtMs = 15_000;
  sourceState.nextEventNumber = 4_097;
  sourceState.events = Array.from({ length: 4_096 }, (_unused, index) => ({
    eventID: `LEE-${String(index + 1).padStart(8, "0")}`,
    kind: "source_ordering_probe",
    occurredAtMs: 15_000 + index,
    payload: "x".repeat(384),
  }));
  let sourceCheckpointCalls = 0;
  assert.equal(store.registerDurabilityPrerequisite(
    "verification-source-ordering",
    () => {
      sourceCheckpointCalls += 1;
      const writeResult = livingEconomyState.writeState(sourceState, {
        trustedNormalizedState: true,
      });
      if (!writeResult || writeResult.success !== true) return writeResult;
      return livingEconomyState.flushDurably();
    },
  ).success, true);
  const barrierMeta = { ...store.getMeta(), sourceBarrierProbe: 1, updatedAtMs: 15_000 };
  assert.equal(store.saveMeta(barrierMeta).success, true);
  const sourceBarrierStartedAt = performance.now();
  assert.equal(store.flushDurably().success, true);
  const sourceBarrierMs = performance.now() - sourceBarrierStartedAt;
  assert.ok(
    sourceBarrierMs < 600,
    `source-before-sink handoff exceeded 600 ms (${sourceBarrierMs.toFixed(1)} ms)`,
  );
  assert.equal(sourceCheckpointCalls, 1);
  let durableSource = sqliteStore.loadTableObject("npcRuntimeState").livingEconomy;
  let durableSink = sqliteStore.loadTableObject("xEveRuntime");
  assert.equal(durableSource.events.length, 4_096);
  assert.equal(durableSink.meta.sourceBarrierProbe, 1);

  assert.equal(store.registerDurabilityPrerequisite(
    "verification-source-ordering",
    () => ({ success: false, errorMsg: "TEST_SOURCE_CHECKPOINT_FAILED" }),
  ).success, true);
  assert.equal(store.saveMeta({
    ...store.getMeta(),
    sourceBarrierProbe: 2,
    updatedAtMs: 16_000,
  }).success, true);
  const rejectedSinkFlush = store.flushDurably();
  assert.equal(rejectedSinkFlush.success, false);
  assert.equal(rejectedSinkFlush.errorMsg, "TEST_SOURCE_CHECKPOINT_FAILED");
  const rejectedShutdownFlush = gameStore.flushAllSync();
  assert.equal(rejectedShutdownFlush.success, false);
  assert.ok(rejectedShutdownFlush.results.some((row) => (
    row.table === "xEveRuntime" && row.success === false
  )));
  durableSink = sqliteStore.loadTableObject("xEveRuntime");
  assert.equal(durableSink.meta.sourceBarrierProbe, 1);

  sourceState.updatedAtMs = 16_000;
  sourceState.events[sourceState.events.length - 1].payload = "recovered-source-marker";
  assert.equal(store.registerDurabilityPrerequisite(
    "verification-source-ordering",
    () => {
      const writeResult = livingEconomyState.writeState(sourceState, {
        trustedNormalizedState: true,
      });
      if (!writeResult || writeResult.success !== true) return writeResult;
      return livingEconomyState.flushDurably();
    },
  ).success, true);
  assert.equal(store.flushDurably().success, true);
  assert.equal(store.unregisterDurabilityPrerequisite(
    "verification-source-ordering",
  ).success, true);
  durableSource = sqliteStore.loadTableObject("npcRuntimeState").livingEconomy;
  durableSink = sqliteStore.loadTableObject("xEveRuntime");
  assert.equal(
    durableSource.events[durableSource.events.length - 1].payload,
    "recovered-source-marker",
  );
  assert.equal(durableSink.meta.sourceBarrierProbe, 2);
  const expectInvalidSourceJournal = (mutate, expectedPath) => {
    const invalidState = JSON.parse(JSON.stringify(sourceState));
    mutate(invalidState);
    assert.equal(livingEconomyState.writeState(invalidState, {
      trustedNormalizedState: true,
    }).success, true);
    assert.throws(
      () => livingEconomyState.readState({ strict: true }),
      (error) => (
        error &&
        error.code === "LIVING_ECONOMY_SOURCE_JOURNAL_INVALID" &&
        error.path === expectedPath
      ),
    );
  };
  expectInvalidSourceJournal((state) => {
    state.events = {};
  }, "/events");
  expectInvalidSourceJournal((state) => {
    state.events[0] = null;
  }, "/events/0");
  expectInvalidSourceJournal((state) => {
    state.events[1].eventID = state.events[0].eventID;
  }, "/events/1/eventID");
  expectInvalidSourceJournal((state) => {
    state.createdAtMs = 0;
  }, "/createdAtMs");
  expectInvalidSourceJournal((state) => {
    state.nextEventNumber = 4_096;
  }, "/nextEventNumber");
  assert.equal(livingEconomyState.writeState(sourceState, {
    trustedNormalizedState: true,
  }).success, true);
  assert.equal(livingEconomyState.flushDurably().success, true);
  assert.equal(livingEconomyState.readState({ strict: true }).nextEventNumber, 4_097);

  const livingEconomyRuntime = require(
    "../src/space/npc/ambientTraffic/livingEconomyRuntime"
  );
  const livingUniverseState = require(
    "../src/space/npc/ambientTraffic/livingUniverseState"
  );
  const preResetEconomy = livingEconomyState.buildDefaultState();
  preResetEconomy.catalogRevision = 7;
  preResetEconomy.createdAtMs = 17_000;
  preResetEconomy.updatedAtMs = 17_000;
  livingEconomyRuntime._testing.setRuntimeStateForTest(preResetEconomy);
  livingEconomyRuntime._testing.setPulseActiveForTest(true);
  assert.throws(
    () => livingEconomyRuntime.prepareReset(18_000),
    (error) => error && error.code === "LIVING_ECONOMY_RESET_PULSE_ACTIVE",
  );
  livingEconomyRuntime._testing.setPulseActiveForTest(false);

  const preResetUniverse = livingUniverseState.buildDefaultState();
  preResetUniverse.populationRevision = 7;
  preResetUniverse.createdAtMs = 17_000;
  preResetUniverse.updatedAtMs = 17_000;
  assert.equal(livingEconomyState.writeState(preResetEconomy, {
    trustedNormalizedState: true,
  }).success, true);
  assert.equal(livingUniverseState.writeState(preResetUniverse).success, true);
  assert.equal(livingUniverseState.flushDurably().success, true);

  const rollbackProbe = livingEconomyRuntime.prepareReset(16_000);
  assert.equal(rollbackProbe.token.nextState.createdAtMs, 17_001);
  assert.equal(livingEconomyRuntime.stagePreparedReset(rollbackProbe.token).success, true);
  assert.equal(livingEconomyRuntime.rollbackPreparedReset(
    rollbackProbe.token,
    { finalize: false },
  ).success, true);
  assert.equal(livingEconomyRuntime.commitPreparedReset(rollbackProbe.token).success, false);
  assert.equal(livingUniverseState.flushDurably().success, true);
  assert.equal(
    livingEconomyRuntime.finalizePreparedResetRollback(rollbackProbe.token).success,
    true,
  );

  const failedRollbackProbe = livingEconomyRuntime.prepareReset(17_500);
  assert.equal(livingEconomyRuntime.stagePreparedReset(failedRollbackProbe.token).success, true);
  const originalEconomyWriteState = livingEconomyState.writeState;
  livingEconomyState.writeState = () => ({
    success: false,
    errorMsg: "TEST_RESET_ROLLBACK_WRITE_FAILED",
  });
  const failedRollback = livingEconomyRuntime.rollbackPreparedReset(
    failedRollbackProbe.token,
    { durable: true },
  );
  livingEconomyState.writeState = originalEconomyWriteState;
  assert.equal(failedRollback.success, false);
  assert.equal(failedRollback.errorMsg, "TEST_RESET_ROLLBACK_WRITE_FAILED");
  assert.equal(livingEconomyState.flushDurably().errorMsg, "FLUSH_SUSPENDED");
  assert.equal(gameStore.resumeTableFlush("npcRuntimeState").success, true);
  assert.equal(livingEconomyRuntime.rollbackPreparedReset(
    failedRollbackProbe.token,
    { durable: true },
  ).success, true);

  const preparedReset = livingEconomyRuntime.prepareReset(18_000);
  assert.equal(preparedReset.success, true);
  assert.equal(livingEconomyRuntime.stagePreparedReset(preparedReset.token).success, true);
  const postResetUniverse = livingUniverseState.buildDefaultState();
  postResetUniverse.populationRevision = 8;
  postResetUniverse.createdAtMs = 18_000;
  postResetUniverse.updatedAtMs = 18_000;
  assert.equal(livingUniverseState.writeState(postResetUniverse).success, true);
  assert.equal(livingUniverseState.flushDurably().success, true);
  assert.equal(livingEconomyRuntime.commitPreparedReset(preparedReset.token).success, true);
  const pairedResetState = sqliteStore.loadTableObject("npcRuntimeState");
  const pairedUniverseState = livingUniverseState.readState();
  assert.equal(pairedResetState.livingEconomy.createdAtMs, 18_000);
  assert.equal(pairedResetState.livingEconomy.events.length, 0);
  assert.equal(pairedUniverseState.populationRevision, 8);
  assert.equal(pairedUniverseState.createdAtMs, 18_000);
  assert.equal(pairedResetState.livingUniverseStorageV2.status, "complete");
  assert.equal(pairedResetState.livingUniverseMetaV2.populationRevision, 8);
  return {
    rows: Object.keys(sqliteStore.explodeToRows("xEveRuntime", reopened)).length,
    restoredBalanceCents: reopened.accountsByID["firm:persistent-test"].balanceCents,
    durableSQLite: {
      transactions: durableIterations,
      averageMs: Math.round(durableAverageMs * 1_000) / 1_000,
      p95Ms: Math.round(durableP95Ms * 1_000) / 1_000,
      maximumMs: Math.round(durableMaximumMs * 1_000) / 1_000,
    },
    batchedSQLite: {
      transactions: batchedIterations,
      handoffMs: Math.round(batchedHandoffMs * 1_000) / 1_000,
      rows: Number(batchedHandoff.rows) || 0,
      workerHandoff: batchedHandoff.handedOff === true,
    },
    failClosedQuarantine: suspendedFlush.errorMsg,
    durableEventMs: Math.round(durableEventMs * 1_000) / 1_000,
    eventBatch: {
      events: 64,
      totalMs: Math.round(eventBatchMs * 1_000) / 1_000,
      belowWarningMs: eventBatchMs < 120,
    },
    replayWindow: {
      events: replayWindowEvents,
      totalMs: Math.round(replayWindowTotalMs * 1_000) / 1_000,
      belowUnplayableMs: replayWindowTotalMs < 600,
      restartAuditMs: Math.round(restartRecoveryMs * 1_000) / 1_000,
    },
    sourceBeforeSink: {
      sourceRows: durableSource.events.length,
      checkpointCalls: sourceCheckpointCalls,
      handoffMs: Math.round(sourceBarrierMs * 1_000) / 1_000,
      belowUnplayableMs: sourceBarrierMs < 600,
      failedCheckpointBlockedSink: rejectedSinkFlush.success === false,
      failedShutdownFlushReported: rejectedShutdownFlush.success === false,
      recoveredMarkerPersisted: true,
      strictJournalRejections: 5,
    },
    resetAtomicity: {
      activePulseRejected: true,
      monotonicEpochAdvanced: rollbackProbe.token.nextState.createdAtMs === 17_001,
      delayedRollbackFinalized: true,
      failedRollbackSuspendedPersistence: true,
      pairedRootsCommitted: true,
      economyCreatedAtMs: pairedResetState.livingEconomy.createdAtMs,
      universePopulationRevision: pairedUniverseState.populationRevision,
    },
  };
}

function benchmarkLedger() {
  let nowMs = 1_800_000_000_000;
  const stateStore = createMemoryStateStore();
  const ledger = createLedger({ stateStore, clock: () => nowMs });
  ledger.ensureInitialized(nowMs);
  ledger.createAccount({
    accountID: "benchmark:source",
    ownerType: "benchmark",
    ownerID: "source",
  }, { nowMs, durable: false });
  ledger.createAccount({
    accountID: "benchmark:destination",
    ownerType: "benchmark",
    ownerID: "destination",
  }, { nowMs, durable: false });
  ledger.openBalance({
    transactionID: "benchmark:opening",
    accountID: "benchmark:source",
    amountCents: "1000000000",
  }, { nowMs, durable: false });

  const iterations = 2_500;
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    nowMs += 1;
    const even = index % 2 === 0;
    const result = ledger.transfer({
      transactionID: `benchmark:transfer:${String(index).padStart(6, "0")}`,
      fromAccountID: even ? "benchmark:source" : "benchmark:destination",
      toAccountID: even ? "benchmark:destination" : "benchmark:source",
      amountCents: "100",
      effectiveAtMs: nowMs,
    }, { nowMs, durable: false });
    assert.equal(result.success, true);
  }
  const durationMs = performance.now() - startedAt;
  const audit = ledger.audit();
  assert.equal(audit.success, true);
  assert.ok(durationMs < 10_000, `memory ledger benchmark took ${durationMs.toFixed(1)} ms`);
  return {
    transactions: iterations,
    postings: iterations * 2,
    durationMs: Math.round(durationMs * 1000) / 1000,
    transactionsPerSecond: Math.round((iterations / Math.max(1, durationMs)) * 1_000),
    finalImbalanceCents: audit.data.ledgerImbalanceCents,
  };
}

function runVerification() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-x-eve-"));
  const dataDir = path.join(tempRoot, "data");
  const priorDataDir = process.env.EVEJS_GAMESTORE_DATA_DIR;
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.EVEJS_GAMESTORE_DATA_DIR = dataDir;
  try {
    return {
      success: true,
      configuration: verifyConfiguration(),
      ledger: verifyLedger(),
      failClosedReads: verifyFailClosedReads(),
      auditIntegrity: verifyAuditIntegrity(),
      ledgerGuards: verifyLedgerGuards(),
      stateShapes: verifyStateShapes(),
      governor: verifyGovernor(),
      runtime: verifyRuntime(),
      observationBurstCapacity: verifyObservationBurstCapacity(),
      schedulerSafety: verifySchedulerBudgetAndRecovery(),
      handlerQuarantine: verifyHandlerQuarantine(),
      handlerEffectIdempotency: verifyHandlerEffectIdempotency(),
      runtimeStateAudit: verifyRuntimeStateAudit(),
      persistence: verifyPersistence(),
      telemetry: verifyTelemetryBands(),
      benchmark: benchmarkLedger(),
    };
  } finally {
    try {
      require("../src/gameStore")._closeSqliteForTests();
    } catch (_error) {
      // Verification cleanup is best effort; the unique temp directory remains isolated.
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (priorDataDir === undefined) delete process.env.EVEJS_GAMESTORE_DATA_DIR;
    else process.env.EVEJS_GAMESTORE_DATA_DIR = priorDataDir;
  }
}

if (require.main === module) {
  console.log(JSON.stringify(runVerification(), null, 2));
}

module.exports = {
  runVerification,
};
