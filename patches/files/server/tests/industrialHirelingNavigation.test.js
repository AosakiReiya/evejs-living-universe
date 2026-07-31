"use strict";

// Keep any default singleton reached through product imports inert. Every
// service exercised below receives explicit in-memory dependencies.
process.env.EVEJS_INDUSTRIAL_HIRELINGS_ENABLED = "false";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const repoRoot = path.join(__dirname, "..", "..");
const {
  CONTRACT_STATE,
  ORDER,
  ROLE,
  convertLegacyMinerContractToVentureCrew,
  createContractService,
} = require(path.join(
  repoRoot,
  "server/src/services/industrialHirelings/industrialHirelingContracts",
));
const {
  NAVIGATION_PHASE,
  buildStationaryNavigation,
} = require(path.join(
  repoRoot,
  "server/src/services/industrialHirelings/industrialHirelingNavigation",
));
const {
  createIndustrialHirelingRuntime,
  isNavigationAtAssignedSystem,
} = require(path.join(
  repoRoot,
  "server/src/services/industrialHirelings/industrialHirelingRuntime",
));
const {
  createIndustrialHirelingScheduler,
} = require(path.join(
  repoRoot,
  "server/src/services/industrialHirelings/industrialHirelingScheduler",
));
function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createMemoryStateStore(initialContracts = []) {
  const contracts = new Map(
    initialContracts.map((contract) => [
      String(contract.contractID),
      cloneValue(contract),
    ]),
  );
  const archive = new Map();
  const stats = {
    getContractCalls: 0,
    listContractsCalls: 0,
    saveContractCalls: 0,
  };
  return {
    stats,
    getContract(contractID) {
      stats.getContractCalls += 1;
      return cloneValue(contracts.get(String(contractID)) || null);
    },
    getArchivedContract(contractID) {
      return cloneValue(archive.get(String(contractID)) || null);
    },
    listContracts(options = {}) {
      stats.listContractsCalls += 1;
      const ownerCharacterID = Math.trunc(Number(options.ownerCharacterID) || 0);
      const states = Array.isArray(options.states) ? new Set(options.states) : null;
      return [...contracts.values()]
        .filter((contract) => (
          !ownerCharacterID ||
          Number(contract.ownerCharacterID) === ownerCharacterID
        ))
        .filter((contract) => !states || states.has(String(contract.state || "")))
        .sort((left, right) => String(left.contractID).localeCompare(String(right.contractID)))
        .map(cloneValue);
    },
    saveContract(contract) {
      stats.saveContractCalls += 1;
      contracts.set(String(contract.contractID), cloneValue(contract));
      return { success: true, data: cloneValue(contract) };
    },
    archiveContract(contract, reason, nowMs) {
      contracts.delete(String(contract.contractID));
      archive.set(String(contract.contractID), {
        ...cloneValue(contract),
        archiveReason: reason,
        archivedAtMs: nowMs,
      });
      return { success: true, data: cloneValue(archive.get(String(contract.contractID))) };
    },
  };
}

function buildConfig(overrides = {}) {
  return {
    livingUniverseEnabled: true,
    industrialHirelingsEnabled: true,
    industrialHirelingsMiningEnabled: true,
    industrialHirelingsHaulingEnabled: true,
    industrialMiningCrewsEnabled: true,
    industrialHirelingsRemoteSitesEnabled: true,
    industrialHirelingsNavigationLegSeconds: 10,
    industrialHirelingsMaxJobsPerPass: 4,
    industrialHirelingsMaxActivePerCharacter: 2,
    ...overrides,
  };
}

function createTopology() {
  const stationSystems = new Map([
    [100, 1],
    [200, 3],
    [300, 9],
  ]);
  const graph = new Map([
    [1, [2]],
    [2, [1, 3]],
    [3, [2]],
    [9, []],
  ]);
  return {
    getStationSolarSystemID(stationID) {
      return stationSystems.get(Number(stationID)) || 0;
    },
    getShortestPath(fromSystemID, toSystemID) {
      const source = Number(fromSystemID);
      const destination = Number(toSystemID);
      if (!graph.has(source) || !graph.has(destination)) return [];
      if (source === destination) return [source];
      const previous = new Map([[source, 0]]);
      const queue = [source];
      let cursor = 0;
      while (cursor < queue.length && !previous.has(destination)) {
        const current = queue[cursor++];
        for (const neighbor of graph.get(current) || []) {
          if (previous.has(neighbor)) continue;
          previous.set(neighbor, current);
          queue.push(neighbor);
        }
      }
      if (!previous.has(destination)) return [];
      const route = [];
      let current = destination;
      while (current) {
        route.push(current);
        if (current === source) break;
        current = previous.get(current) || 0;
      }
      return route.reverse();
    },
  };
}

function createSiteCatalog() {
  return {
    validateSite(siteID, expectedSystemID) {
      if (![900, 901].includes(Number(siteID))) {
        return { success: false, errorMsg: "INDUSTRIAL_HIRELING_SITE_NOT_FOUND" };
      }
      if (Number(expectedSystemID) > 0 && Number(expectedSystemID) !== 3) {
        return { success: false, errorMsg: "INDUSTRIAL_HIRELING_SITE_SYSTEM_MISMATCH" };
      }
      return {
        success: true,
        data: {
          siteDescription: {
            siteID: Number(siteID),
            siteName: `Remote Belt ${Number(siteID)}`,
            systemID: 3,
          },
          systemDescription: {
            systemID: 3,
            systemName: "Destination",
            security: 0.8,
            securityClass: "highsec",
          },
        },
      };
    },
    describeSite(siteID) {
      return [900, 901].includes(Number(siteID))
        ? {
            siteID: Number(siteID),
            siteName: `Remote Belt ${Number(siteID)}`,
            systemID: 3,
          }
        : null;
    },
    describeSystem(systemID) {
      return {
        systemID: Number(systemID),
        systemName: `System ${Number(systemID)}`,
        security: 0.8,
        securityClass: "highsec",
      };
    },
  };
}

function buildContract(overrides = {}) {
  const createdAtMs = 1_000;
  return {
    schemaVersion: 2,
    contractID: "industrial-hireling-00000001",
    serial: 1,
    ownerCharacterID: 42,
    ownerCorporationID: 84,
    role: ROLE.MINER,
    state: CONTRACT_STATE.ACTIVE,
    order: ORDER.SUPPORT_MINING,
    homeStationID: 100,
    assignedSystemID: 1,
    assignedSiteID: 800,
    assignedTargetID: 800,
    destinationStationID: 100,
    currentSystemID: 1,
    navigation: buildStationaryNavigation({
      currentSystemID: 1,
      stationID: 100,
      nowMs: createdAtMs,
      legDurationMs: 10_000,
    }),
    runtimeFleetID: 0,
    runtimeEntityIDs: [],
    members: [],
    activeManifestID: null,
    cargoStatus: "idle",
    createdAtMs,
    updatedAtMs: createdAtMs,
    expiresAtMs: 1_000_000_000,
    revision: 1,
    statistics: {},
    ...cloneValue(overrides),
  };
}

function createService(store) {
  return createContractService({
    config: buildConfig(),
    stateStore: store,
    siteCatalog: createSiteCatalog(),
    navigationTopology: createTopology(),
  });
}

test("setting a destination validates the station and persists a static route", () => {
  const contract = buildContract();
  const store = createMemoryStateStore([contract]);
  const service = createService(store);

  const result = service.setDestination({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    destinationStationID: 200,
    commandID: "map-command-1",
  }, 1_000);

  assert.equal(result.success, true);
  assert.equal(result.data.order, ORDER.STANDBY);
  assert.equal(result.data.currentSystemID, 1);
  assert.equal(result.data.assignedSystemID, 0);
  assert.equal(result.data.assignedSiteID, 0);
  assert.deepEqual(result.data.navigation.routeSystemIDs, [1, 2, 3]);
  assert.equal(result.data.navigation.legIndex, 0);
  assert.equal(result.data.navigation.phase, NAVIGATION_PHASE.IN_TRANSIT);
  assert.equal(result.data.navigation.departureAtMs, 1_000);
  assert.equal(result.data.navigation.arrivalAtMs, 11_000);
  assert.equal(result.data.navigation.lastCommandID, "map-command-1");

  const invalid = service.setDestination({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    destinationStationID: 999,
    commandID: "map-command-invalid",
  }, 2_000);
  assert.equal(invalid.success, false);
  assert.equal(
    invalid.errorMsg,
    "INDUSTRIAL_HIRELING_DESTINATION_STATION_NOT_FOUND",
  );

  const unreachableStore = createMemoryStateStore([contract]);
  const unreachable = createService(unreachableStore).setDestination({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    destinationStationID: 300,
  }, 1_000);
  assert.equal(unreachable.success, false);
  assert.equal(unreachable.errorMsg, "INDUSTRIAL_HIRELING_ROUTE_NOT_FOUND");
  assert.equal(unreachableStore.stats.saveContractCalls, 0);
});

test("a materialized crew must stand down before its virtual route is committed", () => {
  const contract = buildContract({
    runtimeFleetID: 77,
    runtimeEntityIDs: [701],
  });
  const store = createMemoryStateStore([contract]);
  const result = createService(store).setDestination({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    destinationStationID: 200,
    commandID: "bound-crew-command",
  }, 1_000);

  assert.equal(result.success, false);
  assert.equal(
    result.errorMsg,
    "INDUSTRIAL_HIRELING_NAVIGATION_REQUIRES_STAND_DOWN",
  );
  assert.deepEqual(result.data.routeSystemIDs, [1, 2, 3]);
  assert.equal(store.stats.saveContractCalls, 0);
  assert.equal(store.getContract(contract.contractID).runtimeFleetID, 77);
});

test("navigation command retries are idempotent across progress and reject ID reuse", () => {
  const contract = buildContract();
  const store = createMemoryStateStore([contract]);
  const firstService = createService(store);
  const first = firstService.setDestination({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    destinationStationID: 200,
    commandID: "durable-command-7",
  }, 1_000);
  assert.equal(first.success, true);

  const restartedService = createService(store);
  const progressed = restartedService.reconcileExpired(11_000, { maxJobs: 4 });
  assert.equal(progressed.success, true);
  const beforeReplay = store.getContract(contract.contractID);
  assert.equal(beforeReplay.currentSystemID, 2);
  assert.equal(beforeReplay.navigation.arrivalAtMs, 21_000);

  const replayed = createService(store).setDestination({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    destinationStationID: 200,
    commandID: "durable-command-7",
  }, 15_000);
  assert.equal(replayed.success, true);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.data.revision, beforeReplay.revision);
  assert.equal(replayed.data.navigation.revision, beforeReplay.navigation.revision);
  assert.equal(replayed.data.navigation.arrivalAtMs, 21_000);
  assert.equal(store.stats.saveContractCalls, 2);

  const conflict = createService(store).setDestination({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    destinationStationID: 100,
    commandID: "durable-command-7",
  }, 16_000);
  assert.equal(conflict.success, false);
  assert.equal(
    conflict.errorMsg,
    "INDUSTRIAL_HIRELING_NAVIGATION_COMMAND_CONFLICT",
  );
});

test("the bounded command ledger prevents A, B, late-A route overwrite", () => {
  const contract = buildContract();
  const store = createMemoryStateStore([contract]);
  const service = createService(store);
  const commandA = service.setDestination({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    destinationStationID: 200,
    commandID: "command-A",
  }, 1_000);
  assert.equal(commandA.success, true);
  const commandB = service.setDestination({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    destinationStationID: 100,
    commandID: "command-B",
  }, 2_000);
  assert.equal(commandB.success, true);
  const revisionAfterB = commandB.data.revision;

  const lateA = service.setDestination({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    destinationStationID: 200,
    commandID: "command-A",
  }, 3_000);
  assert.equal(lateA.success, true);
  assert.equal(lateA.replayed, true);
  assert.equal(lateA.data.destinationStationID, 100);
  assert.equal(lateA.data.revision, revisionAfterB);

  const conflictingA = service.setDestination({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    destinationStationID: 300,
    commandID: "command-A",
  }, 4_000);
  assert.equal(conflictingA.success, false);
  assert.equal(
    conflictingA.errorMsg,
    "INDUSTRIAL_HIRELING_NAVIGATION_COMMAND_CONFLICT",
  );

  for (let index = 0; index < 18; index += 1) {
    const result = service.setDestination({
      ownerCharacterID: 42,
      contractID: contract.contractID,
      destinationStationID: index % 2 === 0 ? 200 : 100,
      commandID: `bounded-${index}`,
    }, 5_000 + index);
    assert.equal(result.success, true);
  }
  const persisted = store.getContract(contract.contractID);
  assert.equal(persisted.navigation.recentCommands.length, 16);
  assert.deepEqual(
    persisted.navigation.recentCommands.map((entry) => entry.commandID),
    Array.from({ length: 16 }, (_, index) => `bounded-${index + 2}`),
  );
});

test("site-assignment command IDs replay safely and conflict across sites", () => {
  const contract = buildContract({
    order: ORDER.STANDBY,
    assignedSystemID: 0,
    assignedSiteID: 0,
    assignedTargetID: 0,
  });
  const store = createMemoryStateStore([contract]);
  const service = createService(store);
  const commandA = service.assignSite({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    assignedSiteID: 900,
    commandID: "site-A",
  }, 1_000);
  assert.equal(commandA.success, true);
  const commandB = service.assignSite({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    assignedSiteID: 901,
    commandID: "site-B",
  }, 2_000);
  assert.equal(commandB.success, true);

  const lateA = service.assignSite({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    assignedSiteID: 900,
    commandID: "site-A",
  }, 3_000);
  assert.equal(lateA.success, true);
  assert.equal(lateA.replayed, true);
  assert.equal(lateA.data.assignedSiteID, 901);
  assert.equal(lateA.data.revision, commandB.data.revision);

  const conflict = service.assignSite({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    assignedSiteID: 901,
    commandID: "site-A",
  }, 4_000);
  assert.equal(conflict.success, false);
  assert.equal(
    conflict.errorMsg,
    "INDUSTRIAL_HIRELING_NAVIGATION_COMMAND_CONFLICT",
  );
});

test("the existing scheduler contract pass catches up overdue legs after restart", () => {
  const contract = buildContract();
  const store = createMemoryStateStore([contract]);
  const issued = createService(store).setDestination({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    destinationStationID: 200,
  }, 1_000);
  assert.equal(issued.success, true);

  store.stats.listContractsCalls = 0;
  const firstRestart = createService(store);
  const firstPass = firstRestart.reconcileExpired(11_000, { maxJobs: 4 });
  assert.equal(firstPass.success, true);
  assert.equal(store.stats.listContractsCalls, 1);
  assert.equal(firstPass.data.navigation.advancedLegs, 1);
  assert.equal(store.getContract(contract.contractID).currentSystemID, 2);

  const secondRestart = createService(store);
  const secondPass = secondRestart.reconcileExpired(25_000, { maxJobs: 4 });
  assert.equal(secondPass.success, true);
  assert.equal(secondPass.data.navigation.arrivedCount, 1);
  const arrived = store.getContract(contract.contractID);
  assert.equal(arrived.currentSystemID, 3);
  assert.equal(arrived.navigation.currentSystemID, 3);
  assert.equal(arrived.navigation.legIndex, 2);
  assert.equal(arrived.navigation.phase, NAVIGATION_PHASE.ARRIVED);
  assert.equal(arrived.navigation.completedAtMs, 21_000);
});

test("expired active navigation advances and defers archival until durable arrival", () => {
  const contract = buildContract({ expiresAtMs: 5_000 });
  const store = createMemoryStateStore([contract]);
  const service = createService(store);
  const issued = service.setDestination({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    destinationStationID: 200,
    commandID: "expires-during-route",
  }, 1_000);
  assert.equal(issued.success, true);

  const archiveInputs = [];
  const reconcileOptions = {
    maxJobs: 4,
    beforeArchive(current) {
      archiveInputs.push(cloneValue(current));
      return { success: true };
    },
  };
  const firstPass = service.reconcileExpired(11_000, reconcileOptions);
  assert.equal(firstPass.success, true);
  assert.equal(firstPass.data.navigation.advancedLegs, 1);
  assert.equal(firstPass.data.expiredCount, 0);
  assert.equal(firstPass.data.deferredCount, 1);
  assert.equal(archiveInputs.length, 0);

  const stillTravelling = store.getContract(contract.contractID);
  assert.equal(stillTravelling.currentSystemID, 2);
  assert.equal(stillTravelling.navigation.phase, NAVIGATION_PHASE.IN_TRANSIT);
  assert.equal(stillTravelling.navigation.arrivalAtMs, 21_000);

  const arrivalPass = service.reconcileExpired(25_000, reconcileOptions);
  assert.equal(arrivalPass.success, true);
  assert.equal(arrivalPass.data.navigation.arrivedCount, 1);
  assert.equal(arrivalPass.data.expiredCount, 1);
  assert.equal(arrivalPass.data.deferredCount, 0);
  assert.equal(archiveInputs.length, 1);
  assert.equal(archiveInputs[0].currentSystemID, 3);
  assert.equal(archiveInputs[0].navigation.phase, NAVIGATION_PHASE.ARRIVED);
  assert.equal(store.getContract(contract.contractID), null);

  const archived = store.getArchivedContract(contract.contractID);
  assert.equal(archived.state, CONTRACT_STATE.EXPIRED);
  assert.equal(archived.currentSystemID, 3);
  assert.equal(archived.navigation.phase, NAVIGATION_PHASE.ARRIVED);
  assert.equal(archived.navigation.completedAtMs, 21_000);
});

test("expiry reconciliation surfaces archive failures and retries safely", () => {
  const contract = buildContract({ expiresAtMs: 500 });
  const store = createMemoryStateStore([contract]);
  const archiveContract = store.archiveContract.bind(store);
  let archiveAttempts = 0;
  store.archiveContract = (...args) => {
    archiveAttempts += 1;
    if (archiveAttempts === 1) {
      return {
        success: false,
        errorMsg: "TEST_ARCHIVE_WRITE_FAILED",
      };
    }
    return archiveContract(...args);
  };
  const service = createService(store);

  const failedPass = service.reconcileExpired(1_000, { maxJobs: 4 });
  assert.equal(failedPass.success, false);
  assert.equal(
    failedPass.errorMsg,
    "INDUSTRIAL_HIRELING_EXPIRY_RECONCILE_FAILED",
  );
  assert.equal(failedPass.data.expiredCount, 0);
  assert.equal(failedPass.data.failedCount, 1);
  assert.notEqual(store.getContract(contract.contractID), null);

  const retryPass = service.reconcileExpired(2_000, { maxJobs: 4 });
  assert.equal(retryPass.success, true);
  assert.equal(retryPass.data.expiredCount, 1);
  assert.equal(retryPass.data.failedCount, 0);
  assert.equal(store.getContract(contract.contractID), null);
  assert.equal(archiveAttempts, 2);
});

test("scheduler reports unsuccessful reconciliation results", () => {
  const reportedErrors = [];
  const scheduler = createIndustrialHirelingScheduler({
    config: buildConfig(),
    now: () => 1_000,
    cargoCustody: {
      reconcileDueManifests() {
        return { success: true, data: { processedCount: 0 } };
      },
    },
    contractService: {
      reconcileExpired(nowMs, options) {
        const cleanup = options.beforeArchive({
          contractID: "industrial-hireling-scheduler-test",
          ownerCharacterID: 42,
        }, nowMs);
        if (!cleanup || cleanup.success !== true) {
          return {
            success: false,
            errorMsg: cleanup && cleanup.errorMsg ||
              "TEST_EXPIRY_RECONCILE_FAILED",
            data: { failedCount: 1 },
          };
        }
        return {
          success: true,
          data: { failedCount: 0 },
        };
      },
    },
    hirelingRuntime: {
      standDown() {
        return { success: true };
      },
    },
    bookmarkLifecycle: {
      removeContractBookmark() {
        return {
          success: false,
          errorMsg: "TEST_BOOKMARK_REMOVE_FAILED",
        };
      },
    },
    reportError(error) {
      reportedErrors.push(String(error && error.message || error));
    },
  });

  const result = scheduler.runPass();
  assert.equal(result.success, false);
  assert.equal(
    result.errorMsg,
    "INDUSTRIAL_HIRELING_SCHEDULER_RECONCILE_FAILED",
  );
  assert.deepEqual(result.data.failures, ["TEST_BOOKMARK_REMOVE_FAILED"]);
  assert.deepEqual(reportedErrors, ["TEST_BOOKMARK_REMOVE_FAILED"]);
});

test("standing down an already virtual crew preserves its durable drone stock", () => {
  const contract = buildContract({
    order: ORDER.STANDBY,
    assignedSystemID: 0,
    assignedSiteID: 0,
    runtimeFleetID: 0,
    runtimeEntityIDs: [],
    managedDroneStock: {
      schemaVersion: 1,
      stockID: "industrial-hireling:test",
      units: [{ unitID: "2466:1", typeID: 2466, status: "available" }],
    },
  });
  let clearBindingCalls = 0;
  let droneExportCalls = 0;
  const runtime = createIndustrialHirelingRuntime({
    config: buildConfig(),
    contractService: {
      setRuntimeBinding(input) {
        clearBindingCalls += 1;
        return {
          success: true,
          data: {
            ...cloneValue(contract),
            runtimeFleetID: Number(input.runtimeFleetID) || 0,
            runtimeEntityIDs: cloneValue(input.runtimeEntityIDs || []),
          },
        };
      },
    },
    miningOperations: {
      destroyManagedMiningFleetsByOwner() {
        return { success: true, data: { destroyedCount: 0 } };
      },
    },
    spaceRuntime: { scenes: new Map() },
    cargoCustody: {
      getOpenManifestForContract() {
        return null;
      },
    },
    droneRuntime: {
      exportManagedNpcDroneStock() {
        droneExportCalls += 1;
        return { success: false, errorMsg: "SHOULD_NOT_EXPORT_WITHOUT_A_LIVE_FLEET" };
      },
    },
    physicalBudget: {
      getReservation() {
        return null;
      },
      release() {
        return true;
      },
    },
    identityService: {
      markDocked() {
        return { success: true };
      },
    },
  });

  const result = runtime.standDown(null, contract, { nowMs: 2_000 });
  assert.equal(result.success, true);
  assert.equal(clearBindingCalls, 1);
  assert.equal(droneExportCalls, 0);
  assert.deepEqual(result.data.contract.managedDroneStock, contract.managedDroneStock);
});

test("remote site assignment travels virtually and cannot materialize in the old system", () => {
  const contract = buildContract({
    order: ORDER.STANDBY,
    assignedSystemID: 0,
    assignedSiteID: 0,
    assignedTargetID: 0,
  });
  const store = createMemoryStateStore([contract]);
  const assigned = createService(store).assignSite({
    ownerCharacterID: 42,
    contractID: contract.contractID,
    assignedSiteID: 900,
  }, 1_000);
  assert.equal(assigned.success, true);
  assert.equal(assigned.data.assignedSystemID, 3);
  assert.equal(assigned.data.order, ORDER.SUPPORT_MINING);
  assert.equal(assigned.data.currentSystemID, 1);
  assert.equal(assigned.data.navigation.phase, NAVIGATION_PHASE.IN_TRANSIT);
  assert.deepEqual(assigned.data.navigation.routeSystemIDs, [1, 2, 3]);
  assert.equal(isNavigationAtAssignedSystem(assigned.data), false);

  let spawnCalls = 0;
  let clearBindingCalls = 0;
  const runtime = createIndustrialHirelingRuntime({
    config: buildConfig(),
    contractService: {
      setRuntimeBinding(input) {
        clearBindingCalls += 1;
        return {
          success: true,
          data: {
            ...cloneValue(assigned.data),
            runtimeFleetID: Number(input.runtimeFleetID) || 0,
            runtimeEntityIDs: cloneValue(input.runtimeEntityIDs || []),
          },
        };
      },
    },
    miningOperations: {
      destroyManagedMiningFleetsByOwner() {
        return { success: true, data: { destroyedCount: 0 } };
      },
      spawnManagedMiningFleet() {
        spawnCalls += 1;
        return { success: false, errorMsg: "SHOULD_NOT_SPAWN" };
      },
    },
    spaceRuntime: {
      scenes: new Map(),
      ensureScene() {
        throw new Error("transit must not create a scene");
      },
    },
    cargoCustody: {
      getOpenManifestForContract() {
        return null;
      },
    },
    physicalBudget: {
      getReservation() {
        return null;
      },
      release() {
        return true;
      },
    },
    identityService: {
      markDocked() {
        return { success: true };
      },
    },
    siteCatalog: createSiteCatalog(),
  });

  const transitResult = runtime.applyOrder(null, assigned.data, { nowMs: 1_000 });
  assert.equal(transitResult.success, true);
  assert.equal(transitResult.data.deferred, true);
  assert.equal(transitResult.data.reason, "navigation_in_transit");
  assert.equal(spawnCalls, 0);
  assert.equal(clearBindingCalls, 1);
  const directTransit = runtime.materializeMiner(null, assigned.data, {
    nowMs: 1_500,
  });
  assert.equal(directTransit.success, true);
  assert.equal(directTransit.data.reason, "navigation_in_transit");
  assert.equal(spawnCalls, 0);

  const wrongSystem = {
    ...assigned.data,
    navigation: {
      ...assigned.data.navigation,
      phase: NAVIGATION_PHASE.ARRIVED,
      currentSystemID: 1,
    },
  };
  const mismatchResult = runtime.applyOrder(null, wrongSystem, { nowMs: 2_000 });
  assert.equal(mismatchResult.success, true);
  assert.equal(mismatchResult.data.deferred, true);
  assert.equal(mismatchResult.data.reason, "navigation_not_at_assignment");
  assert.equal(spawnCalls, 0);
  const directMismatch = runtime.materializeMiner(null, wrongSystem, {
    nowMs: 2_500,
  });
  assert.equal(directMismatch.success, true);
  assert.equal(directMismatch.data.reason, "navigation_not_at_assignment");
  assert.equal(spawnCalls, 0);

  for (const unsafeNavigation of [
    {
      ...assigned.data.navigation,
      phase: NAVIGATION_PHASE.ARRIVED,
      currentSystemID: 0,
    },
    {
      ...assigned.data.navigation,
      phase: NAVIGATION_PHASE.BLOCKED,
      currentSystemID: 3,
    },
  ]) {
    const unsafeContract = {
      ...assigned.data,
      currentSystemID: 0,
      navigation: unsafeNavigation,
    };
    assert.equal(isNavigationAtAssignedSystem(unsafeContract), false);
    const unsafeResult = runtime.materializeMiner(null, unsafeContract, {
      nowMs: 2_750,
    });
    assert.equal(unsafeResult.success, true);
    assert.equal(unsafeResult.data.deferred, true);
    assert.equal(spawnCalls, 0);
  }

  const arrivalPass = createService(store).reconcileNavigation(25_000, { maxJobs: 4 });
  assert.equal(arrivalPass.success, true);
  const arrived = store.getContract(contract.contractID);
  assert.equal(arrived.currentSystemID, 3);
  assert.equal(isNavigationAtAssignedSystem(arrived), true);
});

test("legacy miner conversion preserves active persisted navigation", () => {
  const navigation = {
    ...buildStationaryNavigation({
      currentSystemID: 2,
      stationID: 200,
      nowMs: 10_000,
      legDurationMs: 10_000,
    }),
    destinationSystemID: 3,
    routeSystemIDs: [1, 2, 3],
    legIndex: 1,
    phase: NAVIGATION_PHASE.IN_TRANSIT,
    departureAtMs: 20_000,
    arrivalAtMs: 30_000,
    completedAtMs: 0,
    revision: 9,
    lastCommandID: "conversion-command",
    lastCommandFingerprint: "station:200",
    recentCommands: [
      { commandID: "conversion-command", fingerprint: "station:200" },
    ],
  };
  const legacy = buildContract({
    navigation,
    currentSystemID: 2,
    pilotIdentityID: 123,
    pilotActorID: "legacy-pilot",
  });
  const converted = convertLegacyMinerContractToVentureCrew(legacy, 40_000);
  assert.equal(converted.success, true);
  assert.equal(converted.converted, true);
  assert.equal(converted.data.currentSystemID, 2);
  assert.deepEqual(converted.data.navigation, navigation);
});
