"use strict";

process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_MINING_NPC_STARTUP_ENABLED = "false";

const assert = require("node:assert/strict");
const path = require("path");

const {
  createStateStore,
} = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialHirelingState",
));
const {
  CONTRACT_STATE,
  ORDER,
  ROLE,
  createContractService,
} = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialHirelingContracts",
));
const {
  executeIndustrialHirelingCommand,
} = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialHirelingCommand",
));
const {
  createIndustrialHirelingRuntime,
} = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialHirelingRuntime",
));
const {
  MANIFEST_STATUS,
  createCargoCustodyService,
} = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialHirelingCargoCustody",
));
const {
  createIndustrialHirelingScheduler,
} = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialHirelingScheduler",
));
const {
  createIndustrialHirelingIdentityService,
} = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialHirelingIdentity",
));

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createFakeRepository() {
  const root = {};
  let readCount = 0;
  let mutationCount = 0;

  function segments(pathArg) {
    return String(pathArg || "")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
  }

  function read(_table, pathArg) {
    readCount += 1;
    const parts = segments(pathArg);
    let current = root;
    for (const part of parts) {
      if (!current || typeof current !== "object" || !(part in current)) {
        return { success: false, errorMsg: "ENTRY_NOT_FOUND" };
      }
      current = current[part];
    }
    return { success: true, data: clone(current) };
  }

  function write(_table, pathArg, value) {
    mutationCount += 1;
    const parts = segments(pathArg);
    if (parts.length === 0) {
      for (const key of Object.keys(root)) delete root[key];
      Object.assign(root, clone(value));
      return { success: true };
    }
    let current = root;
    for (const part of parts.slice(0, -1)) {
      if (!current[part] || typeof current[part] !== "object") {
        current[part] = {};
      }
      current = current[part];
    }
    current[parts[parts.length - 1]] = clone(value);
    return { success: true };
  }

  function remove(_table, pathArg) {
    mutationCount += 1;
    const parts = segments(pathArg);
    let current = root;
    for (const part of parts.slice(0, -1)) {
      if (!current || typeof current !== "object" || !(part in current)) {
        return { success: false, errorMsg: "ENTRY_NOT_FOUND" };
      }
      current = current[part];
    }
    const finalKey = parts[parts.length - 1];
    if (!current || !(finalKey in current)) {
      return { success: false, errorMsg: "ENTRY_NOT_FOUND" };
    }
    delete current[finalKey];
    return { success: true };
  }

  return {
    read,
    write,
    remove,
    snapshot: () => clone(root),
    get readCount() { return readCount; },
    get mutationCount() { return mutationCount; },
  };
}

function makeConfig(overrides = {}) {
  return {
    livingUniverseEnabled: true,
    industrialHirelingsEnabled: true,
    industrialHirelingsMiningEnabled: true,
    industrialHirelingsHaulingEnabled: true,
    industrialHirelingsMaxActivePerCharacter: 2,
    industrialHirelingsDefaultContractHours: 24,
    industrialHirelingsSchedulerIntervalMs: 5000,
    industrialHirelingsMaxJobsPerPass: 4,
    industrialHirelingsHaulerTransitSeconds: 30,
    industrialHirelingsHaulerMaxPickupDistanceMeters: 250000,
    ...overrides,
  };
}

function createFakePhysicalBudget(options = {}) {
  const reservations = new Map();
  return {
    reserve(request) {
      if (options.deny === true) {
        return { success: false, reason: "GLOBAL_LIMIT" };
      }
      const existing = reservations.get(request.reservationID);
      if (existing) return { success: true, reason: "ALREADY_RESERVED", reservation: existing };
      reservations.set(request.reservationID, clone(request));
      return { success: true, reason: "RESERVED", reservation: clone(request) };
    },
    release(reservationID) {
      return reservations.delete(String(reservationID));
    },
    getReservation(reservationID) {
      return clone(reservations.get(String(reservationID)) || null);
    },
    get size() { return reservations.size; },
  };
}

function createFakeIdentityService(contractService, pilotCharacterID, pilotName = "Test Hireling") {
  return {
    markInSpace(contract, _systemID, nowMs) {
      const saved = contractService.setPersistentIdentity({
        ownerCharacterID: contract.ownerCharacterID,
        contractID: contract.contractID,
        pilotIdentityID: pilotCharacterID,
        pilotActorID: `test_hireling_actor_${pilotCharacterID}`,
        pilotName,
      }, nowMs);
      return saved && saved.success === true
        ? {
            success: true,
            data: {
              contract: saved.data,
              actorID: saved.data.pilotActorID,
              pilot: {
                characterID: pilotCharacterID,
                characterName: pilotName,
              },
            },
          }
        : saved;
    },
    markDocked(contract) {
      return { success: true, data: { contract } };
    },
  };
}

function verifyDisabledModeDoesNoWork() {
  const noTouchStore = new Proxy({}, {
    get() {
      throw new Error("disabled mode touched persistent state");
    },
  });
  const service = createContractService({
    config: makeConfig({ industrialHirelingsEnabled: false }),
    stateStore: noTouchStore,
  });
  assert.equal(service.hire({ ownerCharacterID: 9001, role: ROLE.MINER }).success, false);
  const status = service.listForCharacter(9001);
  assert.equal(status.success, true);
  assert.equal(status.data.enabled, false);
  assert.deepEqual(status.data.contracts, []);
  assert.equal(service.reconcileExpired().data.expiredCount, 0);
}

function verifyPersistenceLifecycleAndRoleGates() {
  const repo = createFakeRepository();
  const firstStore = createStateStore({ repo });
  const firstService = createContractService({
    config: makeConfig(),
    stateStore: firstStore,
  });
  const nowMs = 1_900_000_000_000;
  const miner = firstService.hire({
    ownerCharacterID: 9001,
    role: ROLE.MINER,
    homeStationID: 60003760,
  }, nowMs);
  const hauler = firstService.hire({
    ownerCharacterID: 9001,
    role: ROLE.HAULER,
    homeStationID: 60003760,
  }, nowMs + 1);
  assert.equal(miner.success, true);
  assert.equal(hauler.success, true);
  assert.equal(miner.data.contractID, "industrial-hireling-00000001");
  assert.equal(hauler.data.contractID, "industrial-hireling-00000002");
  assert.equal(hauler.data.cargoPolicy, "employer_owned_jetcans_only");
  assert.equal(firstService.hire({ ownerCharacterID: 9001, role: ROLE.MINER }, nowMs + 2).errorMsg,
    "INDUSTRIAL_HIRELING_CONTRACT_LIMIT_REACHED");

  // A new service/store pair over the same repository simulates a process restart.
  const secondStore = createStateStore({ repo });
  const secondService = createContractService({
    config: makeConfig(),
    stateStore: secondStore,
  });
  assert.equal(secondService.listForCharacter(9001).data.contracts.length, 2);

  const minerOrder = secondService.issueOrder({
    ownerCharacterID: 9001,
    contractID: miner.data.contractID,
    order: ORDER.SUPPORT_MINING,
    assignedSystemID: 30000142,
    assignedTargetID: 1_400_000_001,
  }, nowMs + 10);
  assert.equal(minerOrder.success, true);
  assert.equal(minerOrder.data.revision, 2);
  assert.equal(minerOrder.data.assignedSystemID, 30000142);

  const invalidHaulerOrder = secondService.issueOrder({
    ownerCharacterID: 9001,
    contractID: hauler.data.contractID,
    order: ORDER.SUPPORT_MINING,
  });
  assert.equal(invalidHaulerOrder.errorMsg,
    "INDUSTRIAL_HIRELING_ORDER_NOT_SUPPORTED_FOR_ROLE");

  const miningDisabledService = createContractService({
    config: makeConfig({ industrialHirelingsMiningEnabled: false }),
    stateStore: secondStore,
  });
  assert.equal(miningDisabledService.issueOrder({
    ownerCharacterID: 9001,
    contractID: miner.data.contractID,
    order: ORDER.STANDBY,
  }).errorMsg, "INDUSTRIAL_HIRELINGS_DISABLED");
  assert.equal(miningDisabledService.issueOrder({
    ownerCharacterID: 9001,
    contractID: hauler.data.contractID,
    order: ORDER.HAUL_OPERATION,
    destinationStationID: 60003760,
  }).success, true);

  const paused = secondService.pause({
    ownerCharacterID: 9001,
    contractID: miner.data.contractID,
  }, nowMs + 20);
  assert.equal(paused.data.state, CONTRACT_STATE.PAUSED);
  const resumed = secondService.resume({
    ownerCharacterID: 9001,
    contractID: miner.data.contractID,
  }, nowMs + 30);
  assert.equal(resumed.data.state, CONTRACT_STATE.ACTIVE);

  const dismissed = secondService.dismiss({
    ownerCharacterID: 9001,
    contractID: hauler.data.contractID,
  }, nowMs + 40);
  assert.equal(dismissed.success, true);
  assert.equal(dismissed.data.state, CONTRACT_STATE.DISMISSED);
  assert.equal(secondStore.listContracts({ ownerCharacterID: 9001 }).length, 1);
  assert.equal(secondStore.listArchivedContracts({ ownerCharacterID: 9001 }).length, 1);

  const expiry = secondService.reconcileExpired(nowMs + (25 * 60 * 60 * 1000));
  assert.equal(expiry.data.expiredCount, 1);
  assert.equal(secondStore.listContracts({ ownerCharacterID: 9001 }).length, 0);
  assert.equal(secondStore.listArchivedContracts({ ownerCharacterID: 9001 }).length, 2);

  const mutationsBeforeDisabledRead = repo.mutationCount;
  const disabledService = createContractService({
    config: makeConfig({ industrialHirelingsEnabled: false }),
    stateStore: secondStore,
  });
  disabledService.listForCharacter(9001);
  disabledService.reconcileExpired(nowMs + (48 * 60 * 60 * 1000));
  assert.equal(repo.mutationCount, mutationsBeforeDisabledRead);
}

function verifyHireCommandReplayProtection() {
  const repo = createFakeRepository();
  const stateStore = createStateStore({ repo });
  const config = makeConfig({
    industrialMiningCrewsEnabled: true,
    industrialMiningCrewsLegacyHiringEnabled: true,
    industrialHirelingsMaxActivePerCharacter: 3,
  });
  const service = createContractService({ config, stateStore });
  const nowMs = 1_905_000_000_000;
  const request = {
    ownerCharacterID: 9010,
    ownerCorporationID: 98_000_010,
    homeStationID: 60003760,
    crewTypeID: "venture_crew",
    commandID: "xc-hire-replay-1",
  };

  const first = service.hire(request, nowMs);
  assert.equal(first.success, true);
  assert.notEqual(first.replayed, true);
  assert.equal(first.data.contractID, "industrial-hireling-00000001");
  assert.equal(first.data.hireCommandID, request.commandID);
  assert.match(first.data.hireCommandFingerprint, /^[a-f0-9]{64}$/);

  const activeReplay = service.hire({
    ...request,
    crewTypeID: "VENTURE_CREW",
  }, nowMs + 1);
  assert.equal(activeReplay.success, true);
  assert.equal(activeReplay.replayed, true);
  assert.equal(activeReplay.data.contractID, first.data.contractID);
  assert.equal(stateStore.listContracts({ ownerCharacterID: 9010 }).length, 1);

  const activeConflict = service.hire({
    ...request,
    crewTypeID: "barge_crew",
  }, nowMs + 2);
  assert.equal(
    activeConflict.errorMsg,
    "INDUSTRIAL_HIRELING_HIRE_COMMAND_CONFLICT",
  );
  assert.equal(stateStore.listContracts({ ownerCharacterID: 9010 }).length, 1);

  const dismissed = service.dismiss({
    ownerCharacterID: 9010,
    contractID: first.data.contractID,
  }, nowMs + 3);
  assert.equal(dismissed.success, true);
  assert.equal(stateStore.listContracts({ ownerCharacterID: 9010 }).length, 0);
  assert.equal(stateStore.listArchivedContracts({ ownerCharacterID: 9010 }).length, 1);

  // A new service instance proves replay identity survives restart and archive.
  const restartedService = createContractService({
    config,
    stateStore: createStateStore({ repo }),
  });
  const archivedReplay = restartedService.hire(request, nowMs + 4);
  assert.equal(archivedReplay.success, true);
  assert.equal(archivedReplay.replayed, true);
  assert.equal(archivedReplay.data.contractID, first.data.contractID);
  assert.equal(archivedReplay.data.state, CONTRACT_STATE.DISMISSED);
  assert.equal(stateStore.listContracts({ ownerCharacterID: 9010 }).length, 0);

  const archivedConflict = restartedService.hire({
    ...request,
    homeStationID: 60003761,
  }, nowMs + 5);
  assert.equal(
    archivedConflict.errorMsg,
    "INDUSTRIAL_HIRELING_HIRE_COMMAND_CONFLICT",
  );

  const invalidCommand = restartedService.hire({
    ...request,
    commandID: "invalid command id",
  }, nowMs + 6);
  assert.equal(
    invalidCommand.errorMsg,
    "INDUSTRIAL_HIRELING_HIRE_COMMAND_ID_INVALID",
  );

  const fresh = restartedService.hire({
    ...request,
    commandID: "xc-hire-replay-2",
  }, nowMs + 7);
  assert.equal(fresh.success, true);
  assert.equal(
    fresh.data.contractID,
    "industrial-hireling-00000002",
    "replays and conflicts must not allocate another contract serial",
  );
  assert.equal(stateStore.listContracts({ ownerCharacterID: 9010 }).length, 1);
}

function verifyPlayerCommandSurface() {
  const repo = createFakeRepository();
  const service = createContractService({
    config: makeConfig(),
    stateStore: createStateStore({ repo }),
  });
  const nowMs = 1_910_000_000_000;
  const runtimeCalls = [];
  const bookmarkRemovals = [];
  const hirelingRuntime = {
    applyOrder(_session, contract) {
      runtimeCalls.push(["apply", contract.contractID, contract.order]);
      return { success: true, data: { contract } };
    },
    standDown(_session, contract) {
      runtimeCalls.push(["standDown", contract.contractID]);
      return { success: true, data: { contract } };
    },
  };
  const dockedSession = {
    characterID: 777,
    stationid: 60003760,
  };
  const hired = executeIndustrialHirelingCommand(
    dockedSession,
    "hire miner",
    { contractService: service, hirelingRuntime, nowMs },
  );
  assert.equal(hired.success, true);
  assert.match(hired.message, /#1 miner contract created/);

  const status = executeIndustrialHirelingCommand(
    dockedSession,
    "status",
    { contractService: service, hirelingRuntime, nowMs },
  );
  assert.equal(status.success, true);
  assert.match(status.message, /#1 miner active/);

  const inSpaceSession = {
    characterID: 777,
    _space: {
      systemID: 30000142,
      shipID: 1_400_000_077,
    },
  };
  const ordered = executeIndustrialHirelingCommand(
    inSpaceSession,
    "order 1 mine",
    { contractService: service, hirelingRuntime, nowMs: nowMs + 1 },
  );
  assert.equal(ordered.success, true);
  assert.match(ordered.message, /accepted order: support mining/);

  const invalidDestination = executeIndustrialHirelingCommand(
    inSpaceSession,
    "destination 1 current",
    { contractService: service, hirelingRuntime, nowMs: nowMs + 2 },
  );
  assert.equal(invalidDestination.success, false);
  assert.match(invalidDestination.message, /requires you to be docked/);

  const destination = executeIndustrialHirelingCommand(
    dockedSession,
    "destination 1 current",
    { contractService: service, hirelingRuntime, nowMs: nowMs + 3 },
  );
  assert.equal(destination.success, true);
  assert.match(destination.message, /60003760/);

  assert.equal(executeIndustrialHirelingCommand(
    inSpaceSession,
    "pause 1",
    { contractService: service, hirelingRuntime, nowMs: nowMs + 4 },
  ).success, true);
  assert.equal(executeIndustrialHirelingCommand(
    inSpaceSession,
    "resume 1",
    { contractService: service, hirelingRuntime, nowMs: nowMs + 5 },
  ).success, true);
  assert.equal(executeIndustrialHirelingCommand(
    inSpaceSession,
    "dismiss 1",
    {
      contractService: service,
      hirelingRuntime,
      nowMs: nowMs + 6,
      config: makeConfig({ industrialHirelingsOperationBookmarksEnabled: true }),
      bookmarkService: {
        removeOperationBookmark(input) {
          bookmarkRemovals.push(clone(input));
          return { success: true, data: { action: "removed" } };
        },
      },
    },
  ).success, true);
  assert.equal(bookmarkRemovals.length, 1);
  assert.equal(bookmarkRemovals[0].contractID, "industrial-hireling-00000001");
  assert.equal(service.listForCharacter(777).data.contracts.length, 0);
  assert.deepEqual(runtimeCalls, [
    ["apply", "industrial-hireling-00000001", ORDER.SUPPORT_MINING],
    ["standDown", "industrial-hireling-00000001"],
    ["standDown", "industrial-hireling-00000001"],
  ]);
}

function verifyManagedDroneStockPersistenceAndHullLoss() {
  const repo = createFakeRepository();
  const config = makeConfig();
  const stateStore = createStateStore({ repo });
  const firstService = createContractService({ config, stateStore });
  const nowMs = 1_915_000_000_000;
  const hired = firstService.hire({
    ownerCharacterID: 778,
    role: ROLE.MINER,
    homeStationID: 60003760,
  }, nowMs);
  assert.equal(hired.success, true);
  assert.equal(hired.data.managedDroneStock, null);

  const stock = {
    schemaVersion: 1,
    stockID: "industrial-hireling:8700000000000001",
    updatedAtMs: nowMs + 1,
    countByStatus: { available: 1, deployed: 1, lost: 0 },
    units: [
      {
        unitIndex: 0,
        unitID: "drone:0",
        typeID: 2486,
        status: "available",
        deployedFlightID: "",
        deployedAtMs: 0,
        lostAtMs: 0,
        lossReason: "",
      },
      {
        unitIndex: 1,
        unitID: "drone:1",
        typeID: 2486,
        status: "deployed",
        deployedFlightID: "flight:test",
        deployedAtMs: nowMs + 1,
        lostAtMs: 0,
        lossReason: "",
      },
    ],
  };
  const persisted = firstService.setManagedDroneStock({
    ownerCharacterID: 778,
    contractID: hired.data.contractID,
    stock,
  }, nowMs + 1);
  assert.equal(persisted.success, true);
  assert.deepEqual(persisted.data.managedDroneStock, stock);

  const restartedService = createContractService({
    config,
    stateStore: createStateStore({ repo }),
  });
  const afterRestart = restartedService.listForCharacter(778).data.contracts[0];
  assert.deepEqual(afterRestart.managedDroneStock, stock);

  const lost = restartedService.recordHullLoss({
    ownerCharacterID: 778,
    contractID: hired.data.contractID,
    lossReason: "controller_destroyed",
  }, nowMs + 2);
  assert.equal(lost.success, true);
  assert.equal(lost.data.order, ORDER.STANDBY);
  assert.deepEqual(lost.data.managedDroneStock.countByStatus, {
    available: 0,
    deployed: 0,
    lost: 2,
  });
  assert.ok(lost.data.managedDroneStock.units.every((unit) => unit.status === "lost"));
  assert.ok(lost.data.managedDroneStock.units.every(
    (unit) => unit.deployedFlightID === "" && unit.deployedAtMs === 0,
  ));
  assert.equal(lost.data.statistics.hullLosses, 1);

  assert.equal(firstService.setManagedDroneStock({
    ownerCharacterID: 778,
    contractID: hired.data.contractID,
    stock: { units: "not-an-array" },
  }).errorMsg, "INDUSTRIAL_HIRELING_DRONE_STOCK_INVALID");
}

function verifyManagedDroneStockRuntimeBridgeAndRestart() {
  const repo = createFakeRepository();
  const config = makeConfig();
  const stateStore = createStateStore({ repo });
  const contractService = createContractService({ config, stateStore });
  const nowMs = 1_916_000_000_000;
  const hired = contractService.hire({
    ownerCharacterID: 779,
    ownerCorporationID: 98_000_779,
    role: ROLE.MINER,
    homeStationID: 60003760,
  }, nowMs);
  const ordered = contractService.issueOrder({
    ownerCharacterID: 779,
    contractID: hired.data.contractID,
    order: ORDER.SUPPORT_MINING,
    assignedSystemID: 30030141,
    assignedTargetID: 1_400_000_779,
  }, nowMs + 1);

  const playerEntity = {
    itemID: 1_400_000_779,
    position: { x: 0, y: 0, z: 0 },
  };
  const hirelingEntity = {
    itemID: 5_779,
    typeID: 32_880,
    pilotCharacterID: 2_120_004_779,
    position: { x: 1_000, y: 0, z: 0 },
    governedDroneBay: [{ typeID: 2_486, quantity: 2 }],
  };
  const scene = {
    systemID: 30030141,
    getEntityByID(entityID) {
      if (Number(entityID) === playerEntity.itemID) return playerEntity;
      if (Number(entityID) === hirelingEntity.itemID) return hirelingEntity;
      return null;
    },
  };
  const makeInitialStock = (stockID) => ({
    schemaVersion: 1,
    stockID,
    systemID: scene.systemID,
    controllerID: hirelingEntity.itemID,
    controllerTypeID: hirelingEntity.typeID,
    definitionSignature: "2486:1=2486|2486:2=2486",
    createdAtMs: nowMs + 2,
    updatedAtMs: nowMs + 2,
    countByStatus: { available: 2, deployed: 0, lost: 0 },
    units: [0, 1].map((index) => ({
      unitIndex: index,
      unitID: `2486:${index + 1}`,
      typeID: 2_486,
      status: "available",
      deployedFlightID: "",
      deployedAtMs: 0,
      lostAtMs: 0,
      lossReason: "",
    })),
  });
  function createFakeDroneRuntime() {
    let ledger = null;
    const importedSnapshots = [];
    return {
      exportManagedNpcDroneStock(_scene, _entity, options = {}) {
        if (!ledger) {
          ledger = makeInitialStock(
            String(options.stockID || "fake-industrial-stock"),
          );
        }
        if (options.stockID) ledger.stockID = String(options.stockID);
        return { success: true, data: { stock: clone(ledger) } };
      },
      importManagedNpcDroneStock(_scene, _entity, snapshot, options = {}) {
        ledger = clone(snapshot);
        ledger.stockID = String(options.stockID || ledger.stockID);
        ledger.systemID = scene.systemID;
        ledger.controllerID = hirelingEntity.itemID;
        ledger.controllerTypeID = hirelingEntity.typeID;
        ledger.units = ledger.units.map((unit) => (
          unit.status === "lost"
            ? { ...unit }
            : {
                ...unit,
                status: "available",
                deployedFlightID: "",
                deployedAtMs: 0,
              }
        ));
        ledger.countByStatus = {
          available: ledger.units.filter((unit) => unit.status === "available").length,
          deployed: 0,
          lost: ledger.units.filter((unit) => unit.status === "lost").length,
        };
        importedSnapshots.push(clone(ledger));
        return { success: true, data: { stock: clone(ledger) } };
      },
      forgetManagedNpcDroneStock() {
        if (!ledger) {
          return { success: false, errorMsg: "NPC_DRONE_STOCK_NOT_FOUND" };
        }
        ledger.units = ledger.units.map((unit) => (
          unit.status === "deployed"
            ? {
                ...unit,
                status: "available",
                deployedFlightID: "",
                deployedAtMs: 0,
              }
            : unit
        ));
        ledger.countByStatus = {
          available: ledger.units.filter((unit) => unit.status === "available").length,
          deployed: 0,
          lost: ledger.units.filter((unit) => unit.status === "lost").length,
        };
        const snapshot = clone(ledger);
        ledger = null;
        return { success: true, data: { stock: snapshot } };
      },
      setLedger(snapshot) {
        ledger = clone(snapshot);
      },
      get importedSnapshots() {
        return clone(importedSnapshots);
      },
    };
  }

  let managedFleet = null;
  let latestSpawnOptions = null;
  const miningOperations = {
    getManagedMiningFleet(fleetID) {
      return managedFleet && Number(fleetID) === managedFleet.fleetID
        ? managedFleet
        : null;
    },
    spawnManagedMiningFleet(_scene, options) {
      latestSpawnOptions = options;
      managedFleet = {
        fleetID: 79,
        minerEntityIDs: [hirelingEntity.itemID],
        haulerEntityIDs: [],
      };
      return {
        success: true,
        data: {
          fleetRecord: managedFleet,
          entityIDs: [hirelingEntity.itemID],
        },
      };
    },
    settleManagedMiningFleetCargo() {
      return { success: true, data: { transferredVolumeM3: 0 } };
    },
    destroyManagedMiningFleetsByOwner() {
      managedFleet = null;
      return { success: true, data: { destroyedCount: 1 } };
    },
  };
  const physicalBudget = createFakePhysicalBudget();
  const firstDroneRuntime = createFakeDroneRuntime();
  const runtime = createIndustrialHirelingRuntime({
    config,
    contractService,
    miningOperations,
    droneRuntime: firstDroneRuntime,
    physicalBudget,
    identityService: createFakeIdentityService(
      contractService,
      hirelingEntity.pilotCharacterID,
      "Durable Drone Miner",
    ),
    cargoCustody: { getOpenManifestForContract: () => null },
    spaceRuntime: { ensureScene: () => scene },
  });
  const session = {
    characterID: 779,
    corporationID: 98_000_779,
    _space: { systemID: scene.systemID, shipID: playerEntity.itemID },
  };
  const materialized = runtime.applyOrder(session, ordered.data, {
    nowMs: nowMs + 2,
  });
  assert.equal(materialized.success, true);
  assert.equal(typeof latestSpawnOptions.onManagedDroneStockChanged, "function");
  let persistedContract = contractService.listForCharacter(779).data.contracts[0];
  assert.deepEqual(persistedContract.managedDroneStock.countByStatus, {
    available: 2,
    deployed: 0,
    lost: 0,
  });

  const lossSnapshot = clone(persistedContract.managedDroneStock);
  lossSnapshot.units[0] = {
    ...lossSnapshot.units[0],
    status: "lost",
    lostAtMs: nowMs + 3,
    lossReason: "destroyed",
  };
  lossSnapshot.units[1] = {
    ...lossSnapshot.units[1],
    status: "deployed",
    deployedFlightID: "flight:survivor",
    deployedAtMs: nowMs + 3,
  };
  lossSnapshot.countByStatus = { available: 0, deployed: 1, lost: 1 };
  firstDroneRuntime.setLedger(lossSnapshot);
  const lossPersisted = latestSpawnOptions.onManagedDroneStockChanged({
    eventKind: "stock_transition",
    outcome: "lost",
    stock: lossSnapshot,
    atMs: nowMs + 3,
  });
  assert.equal(lossPersisted.success, true);
  assert.deepEqual(
    contractService.listForCharacter(779).data.contracts[0]
      .managedDroneStock.countByStatus,
    { available: 0, deployed: 1, lost: 1 },
  );

  const stoodDown = runtime.standDown(
    session,
    contractService.listForCharacter(779).data.contracts[0],
    { scene, nowMs: nowMs + 4 },
  );
  assert.equal(stoodDown.success, true);
  persistedContract = contractService.listForCharacter(779).data.contracts[0];
  assert.deepEqual(persistedContract.managedDroneStock.countByStatus, {
    available: 1,
    deployed: 0,
    lost: 1,
  });
  assert.equal(physicalBudget.size, 0);

  const restartedDroneRuntime = createFakeDroneRuntime();
  const restartedRuntime = createIndustrialHirelingRuntime({
    config,
    contractService,
    miningOperations,
    droneRuntime: restartedDroneRuntime,
    physicalBudget,
    identityService: createFakeIdentityService(
      contractService,
      hirelingEntity.pilotCharacterID,
      "Durable Drone Miner",
    ),
    cargoCustody: { getOpenManifestForContract: () => null },
    spaceRuntime: { ensureScene: () => scene },
  });
  const rematerialized = restartedRuntime.applyOrder(
    session,
    persistedContract,
    { nowMs: nowMs + 5 },
  );
  assert.equal(rematerialized.success, true);
  assert.equal(restartedDroneRuntime.importedSnapshots.length, 1);
  assert.deepEqual(
    restartedDroneRuntime.importedSnapshots[0].countByStatus,
    { available: 1, deployed: 0, lost: 1 },
  );
}

function verifyMinerRuntimeAdapter() {
  const repo = createFakeRepository();
  const config = makeConfig();
  const stateStore = createStateStore({ repo });
  const service = createContractService({ config, stateStore });
  const nowMs = 1_920_000_000_000;
  const hired = service.hire({
    ownerCharacterID: 888,
    ownerCorporationID: 98_000_001,
    role: ROLE.MINER,
    homeStationID: 60003760,
  }, nowMs);
  const ordered = service.issueOrder({
    ownerCharacterID: 888,
    contractID: hired.data.contractID,
    order: ORDER.SUPPORT_MINING,
    assignedSystemID: 30000142,
    assignedTargetID: 1_400_000_888,
  }, nowMs + 1);
  const playerEntity = { itemID: 1_400_000_888, position: { x: 1, y: 2, z: 3 } };
  const hirelingEntity = {
    itemID: 5001,
    pilotCharacterID: 2_120_004_001,
    position: { x: 4, y: 5, z: 6 },
  };
  const scene = {
    systemID: 30000142,
    getEntityByID(id) {
      if (Number(id) === playerEntity.itemID) return playerEntity;
      if (Number(id) === hirelingEntity.itemID) return hirelingEntity;
      return null;
    },
  };
  const miningCalls = [];
  const physicalBudget = createFakePhysicalBudget();
  let managedFleet = null;
  const miningOperations = {
    getManagedMiningFleet(fleetID) {
      return managedFleet && Number(fleetID) === Number(managedFleet.fleetID)
        ? managedFleet
        : null;
    },
    destroyManagedMiningFleetsByOwner(owner) {
      miningCalls.push(["destroy", owner]);
      managedFleet = null;
      return { success: true, data: { destroyedCount: 1 } };
    },
    spawnManagedMiningFleet(spawnScene, options) {
      miningCalls.push(["spawn", spawnScene.systemID, options]);
      managedFleet = { fleetID: 12 };
      return {
        success: true,
        data: {
          fleetRecord: managedFleet,
          entityIDs: [hirelingEntity.itemID],
        },
      };
    },
    settleManagedMiningFleetCargo(settleScene, fleetID, owner) {
      miningCalls.push(["settle", settleScene.systemID, fleetID, owner]);
      return { success: true, data: { transferredVolumeM3: 125 } };
    },
  };
  const runtime = createIndustrialHirelingRuntime({
    config,
    contractService: service,
    miningOperations,
    physicalBudget,
    identityService: createFakeIdentityService(service, 2_120_004_001, "Miner Test"),
    spaceRuntime: { ensureScene: () => scene },
  });
  const session = {
    characterID: 888,
    corporationID: 98_000_001,
    _space: { systemID: 30000142, shipID: playerEntity.itemID },
  };
  const materialized = runtime.applyOrder(session, ordered.data, { nowMs: nowMs + 2 });
  assert.equal(materialized.success, true);
  assert.equal(materialized.data.contract.runtimeFleetID, 12);
  assert.deepEqual(materialized.data.contract.runtimeEntityIDs, [5001]);
  assert.equal(materialized.data.contract.pilotIdentityID, 2_120_004_001);
  assert.equal(physicalBudget.size, 1);
  const spawnCall = miningCalls.find((entry) => entry[0] === "spawn");
  assert.ok(spawnCall);
  assert.equal(spawnCall[2].minerAmount, 1);
  assert.equal(spawnCall[2].haulerAmount, 0);
  assert.equal(spawnCall[2].onGridSupport, true);
  assert.equal(spawnCall[2].cargoOwnerID, 888);
  assert.equal(spawnCall[2].cargoCorporationID, 98_000_001);
  assert.equal(spawnCall[2].pilotIdentity.characterID, 2_120_004_001);
  assert.match(spawnCall[2].livingUniverseActorID, /test_hireling_actor/);

  const healthy = runtime.reconcileForSession(session, { nowMs: nowMs + 3 });
  assert.equal(healthy.success, true);
  assert.equal(healthy.data.deployedCount, 1);
  assert.equal(healthy.data.staleCount, 0);

  const detach = runtime.handleEmployerSessionDetaching(session, {
    nowMs: nowMs + 4,
    reason: "stargate-jump",
  });
  assert.equal(detach.success, true);
  assert.equal(detach.data.stoodDownCount, 1);
  const stoodDownContract = service.listForCharacter(888).data.contracts[0];
  assert.equal(stoodDownContract.runtimeFleetID, 0);
  assert.deepEqual(stoodDownContract.runtimeEntityIDs, []);
  assert.equal(stoodDownContract.order, ORDER.SUPPORT_MINING);
  assert.ok(miningCalls.some((entry) => entry[0] === "settle"));
  assert.equal(physicalBudget.size, 0);

  const rematerialized = runtime.applyOrder(session, stoodDownContract, { nowMs: nowMs + 5 });
  assert.equal(rematerialized.success, true);
  assert.equal(physicalBudget.size, 1);
  managedFleet = null;
  const restartedRuntime = createIndustrialHirelingRuntime({
    config,
    contractService: service,
    miningOperations,
    physicalBudget,
    identityService: createFakeIdentityService(service, 2_120_004_001, "Miner Test"),
    spaceRuntime: { ensureScene: () => scene },
  });
  const stale = restartedRuntime.reconcileForSession(session, { nowMs: nowMs + 6 });
  assert.equal(stale.success, true);
  assert.equal(stale.data.staleCount, 1);
  assert.equal(service.listForCharacter(888).data.contracts[0].runtimeFleetID, 0);
  assert.equal(physicalBudget.size, 0);
}

function verifyHaulerCustodyRuntimeAndRestartRecovery() {
  const repo = createFakeRepository();
  const config = makeConfig();
  const stateStore = createStateStore({ repo });
  const contractService = createContractService({ config, stateStore });
  const nowMs = 1_930_000_000_000;
  const hired = contractService.hire({
    ownerCharacterID: 999,
    ownerCorporationID: 98_000_002,
    role: ROLE.HAULER,
    homeStationID: 60003760,
  }, nowMs);
  const ordered = contractService.issueOrder({
    ownerCharacterID: 999,
    contractID: hired.data.contractID,
    order: ORDER.HAUL_OPERATION,
    assignedSystemID: 30000142,
    assignedTargetID: 1_400_000_999,
    destinationStationID: 60003760,
  }, nowMs + 1);

  const playerEntity = {
    itemID: 1_400_000_999,
    position: { x: 0, y: 0, z: 0 },
  };
  const containerEntity = {
    itemID: 7_001,
    position: { x: 10_000, y: 0, z: 0 },
  };
  const haulerEntity = {
    itemID: 7_002,
    pilotCharacterID: 2_120_004_002,
    position: { x: 9_000, y: 0, z: 0 },
  };
  const scene = {
    systemID: 30000142,
    dynamicEntities: new Map([
      [playerEntity.itemID, playerEntity],
      [containerEntity.itemID, containerEntity],
    ]),
    getEntityByID(id) {
      if (Number(id) === haulerEntity.itemID) return haulerEntity;
      return this.dynamicEntities.get(Number(id)) || null;
    },
  };
  const inventory = new Map([
    [containerEntity.itemID, {
      itemID: containerEntity.itemID,
      typeID: 23,
      ownerID: 999,
      locationID: scene.systemID,
      flagID: 0,
      singleton: 1,
      stacksize: 1,
    }],
    [7_003, {
      itemID: 7_003,
      typeID: 34,
      ownerID: 999,
      locationID: containerEntity.itemID,
      flagID: 4,
      singleton: 0,
      stacksize: 10_000,
      quantity: 10_000,
    }],
  ]);
  const itemStore = {
    ITEM_FLAGS: { HANGAR: 4 },
    findItemById(itemID) {
      return clone(inventory.get(Number(itemID)) || null);
    },
    listContainerItems(ownerID, locationID) {
      return [...inventory.values()]
        .filter((item) => Number(item.locationID) === Number(locationID))
        .filter((item) => ownerID == null || Number(item.ownerID) === Number(ownerID))
        .map(clone);
    },
    moveItemToLocation(itemID, locationID, flagID) {
      const current = inventory.get(Number(itemID));
      if (!current) return { success: false, errorMsg: "ITEM_NOT_FOUND" };
      inventory.set(Number(itemID), { ...current, locationID, flagID });
      return { success: true, data: { changes: [] } };
    },
  };
  const itemTypeRegistry = {
    resolveItemByTypeID(typeID) {
      if (Number(typeID) === 23) return { groupName: "Cargo Container", volume: 10 };
      if (Number(typeID) === 34) return { groupName: "Mineral", volume: 0.01 };
      return null;
    },
  };
  const worldData = {
    getStationByID(stationID) {
      return Number(stationID) === 60003760 ? { stationID: 60003760 } : null;
    },
    getStructureByID() { return null; },
  };
  const cargoCustody = createCargoCustodyService({
    config,
    stateStore,
    contractService,
    itemStore,
    itemTypeRegistry,
    worldData,
  });
  let spawnOptions = null;
  const physicalBudget = createFakePhysicalBudget();
  const miningOperations = {
    getManagedMiningFleet() { return null; },
    destroyManagedMiningFleetsByOwner() {
      return { success: true, data: { destroyedCount: 0 } };
    },
    spawnManagedMiningHauler(_scene, options) {
      spawnOptions = options;
      return {
        success: true,
        data: { fleetRecord: { fleetID: 42 }, entityIDs: [haulerEntity.itemID] },
      };
    },
  };
  const runtime = createIndustrialHirelingRuntime({
    config,
    contractService,
    miningOperations,
    cargoCustody,
    physicalBudget,
    identityService: createFakeIdentityService(
      contractService,
      2_120_004_002,
      "Hauler Test",
    ),
    spaceRuntime: { ensureScene: () => scene },
  });
  const session = {
    characterID: 999,
    corporationID: 98_000_002,
    _space: { systemID: scene.systemID, shipID: playerEntity.itemID },
  };
  const materialized = runtime.applyOrder(session, ordered.data, { nowMs: nowMs + 2 });
  assert.equal(materialized.success, true);
  assert.ok(spawnOptions);
  assert.equal(spawnOptions.externalContainerID, containerEntity.itemID);
  assert.equal(spawnOptions.pilotIdentity.characterID, 2_120_004_002);
  assert.equal(physicalBudget.size, 1);
  const reservedManifest = stateStore.listManifests({
    contractID: hired.data.contractID,
  })[0];
  assert.equal(reservedManifest.status, MANIFEST_STATUS.RESERVED);
  assert.equal(reservedManifest.itemIDs[0], 7_003);
  assert.equal(inventory.get(7_003).locationID, containerEntity.itemID);

  const collected = spawnOptions.externalContainerCollector({
    containerID: containerEntity.itemID,
    nowMs: nowMs + 10,
  });
  assert.equal(collected.success, true);
  const inTransit = stateStore.getManifest(reservedManifest.manifestID);
  assert.equal(inTransit.status, MANIFEST_STATUS.IN_TRANSIT);
  assert.equal(inventory.get(7_003).locationID, inTransit.escrowLocationID);
  assert.equal(inventory.get(7_003).ownerID, 999);

  // A fresh custody object over the same repository and item rows simulates restart.
  const restartedCustody = createCargoCustodyService({
    config,
    stateStore: createStateStore({ repo }),
    contractService: createContractService({
      config,
      stateStore: createStateStore({ repo }),
    }),
    itemStore,
    itemTypeRegistry,
    worldData,
  });
  const waiting = restartedCustody.deliverManifest(
    inTransit.manifestID,
    inTransit.readyAtMs - 1,
  );
  assert.equal(waiting.data.waiting, true);
  const delivered = restartedCustody.deliverManifest(
    inTransit.manifestID,
    inTransit.readyAtMs,
  );
  assert.equal(delivered.success, true);
  assert.equal(delivered.data.manifest.status, MANIFEST_STATUS.DELIVERED);
  assert.equal(inventory.get(7_003).locationID, 60003760);
  assert.equal(inventory.get(7_003).ownerID, 999);
  const completedContract = contractService.listForCharacter(999).data.contracts[0];
  assert.equal(completedContract.activeManifestID, null);
  assert.equal(completedContract.statistics.tripsCompleted, 1);
  assert.equal(completedContract.statistics.cargoHauledM3, 100);
  spawnOptions.onManagedFleetDestroyed({ reason: "external_departure" });
  assert.equal(physicalBudget.size, 0);
  assert.equal(
    contractService.listForCharacter(999).data.contracts[0].runtimeFleetID,
    0,
  );
}

function verifyDisabledRuntimeLifecycleDoesNoWork() {
  const noTouch = new Proxy({}, {
    get() { throw new Error("disabled runtime lifecycle touched a dependency"); },
  });
  const runtime = createIndustrialHirelingRuntime({
    config: makeConfig({ industrialHirelingsEnabled: false }),
    contractService: noTouch,
    miningOperations: noTouch,
    cargoCustody: noTouch,
    physicalBudget: noTouch,
    identityService: noTouch,
    spaceRuntime: noTouch,
  });
  const session = {
    characterID: 1234,
    _space: { systemID: 30000142, shipID: 1_400_001_234 },
  };
  assert.equal(runtime.reconcileForSession(session).data.inspectedCount, 0);
  assert.equal(runtime.handleEmployerSessionDetaching(session).data.inspectedCount, 0);
}

function verifyPhysicalBudgetDenialDoesNotSpawn() {
  const repo = createFakeRepository();
  const config = makeConfig();
  const stateStore = createStateStore({ repo });
  const contractService = createContractService({ config, stateStore });
  const nowMs = 1_940_000_000_000;
  const hired = contractService.hire({
    ownerCharacterID: 1001,
    role: ROLE.MINER,
    homeStationID: 60003760,
  }, nowMs);
  const ordered = contractService.issueOrder({
    ownerCharacterID: 1001,
    contractID: hired.data.contractID,
    order: ORDER.SUPPORT_MINING,
    assignedSystemID: 30000142,
    assignedTargetID: 1_400_001_001,
  }, nowMs + 1);
  let spawnCount = 0;
  const entity = { itemID: 1_400_001_001, position: { x: 0, y: 0, z: 0 } };
  const runtime = createIndustrialHirelingRuntime({
    config,
    contractService,
    physicalBudget: createFakePhysicalBudget({ deny: true }),
    identityService: createFakeIdentityService(contractService, 2_120_004_003),
    cargoCustody: { getOpenManifestForContract: () => null },
    miningOperations: {
      getManagedMiningFleet: () => null,
      destroyManagedMiningFleetsByOwner: () => ({ success: true, data: {} }),
      spawnManagedMiningFleet() {
        spawnCount += 1;
        return { success: false };
      },
    },
    spaceRuntime: {
      ensureScene: () => ({
        systemID: 30000142,
        getEntityByID: () => entity,
      }),
    },
  });
  const result = runtime.applyOrder({
    characterID: 1001,
    _space: { systemID: 30000142, shipID: entity.itemID },
  }, ordered.data, { nowMs: nowMs + 2 });
  assert.equal(result.errorMsg, "INDUSTRIAL_HIRELING_PHYSICAL_BUDGET_FULL");
  assert.equal(spawnCount, 0);
}

function verifyStableLivingUniverseIdentity() {
  const repo = createFakeRepository();
  const config = makeConfig();
  const stateStore = createStateStore({ repo });
  const contractService = createContractService({ config, stateStore });
  const hired = contractService.hire({
    ownerCharacterID: 1101,
    ownerCorporationID: 98_000_010,
    role: ROLE.MINER,
    homeStationID: 60003760,
  }, 1_960_000_000_000);
  const records = new Map();
  const pilotDirectory = {
    syncActorChanges(actors, options) {
      for (const actor of actors) {
        const actorNumber = Number(String(actor.actorID).match(/(\d+)$/)[1]);
        actor.pilot = {
          characterID: 2_120_000_000 + actorNumber,
          characterName: `Stable Pilot ${actorNumber}`,
        };
        const presence = options.resolvePresence(actor);
        records.set(actor.pilot.characterID, {
          ...actor.pilot,
          actorID: actor.actorID,
          corporationID: actor.corporationID,
          solarSystemID: presence.solarSystemID,
          stationID: presence.stationID,
          localVisible: presence.localVisible,
          corporationChatVisible: presence.corporationChatVisible,
        });
      }
      return {
        identitiesChanged: true,
        pilots: actors
          .map((actor) => records.get(actor.pilot.characterID))
          .filter(Boolean)
          .map(clone),
      };
    },
    getPilotRecord(characterID) {
      return clone(records.get(Number(characterID)) || null);
    },
  };
  const localPresence = [];
  const corporationPresence = [];
  const identity = createIndustrialHirelingIdentityService({
    pilotDirectory,
    contractService,
    chatRuntime: {
      upsertSyntheticLocalMembers(pilots) {
        localPresence.push(...pilots.map(clone));
      },
      upsertSyntheticCorporationMembers(pilots) {
        corporationPresence.push(...pilots.map(clone));
      },
    },
  });
  const first = identity.markInSpace(hired.data, 30000142, 1_960_000_000_001);
  assert.equal(first.success, true);
  assert.equal(first.data.pilot.characterID, 2_125_000_001);
  assert.equal(first.data.pilot.localVisible, true);
  assert.equal(first.data.contract.shipIdentityID, 8_700_000_000_000_001);
  const docked = identity.markDocked(first.data.contract, 1_960_000_000_002);
  assert.equal(docked.success, true);
  assert.equal(docked.data.pilot.characterID, first.data.pilot.characterID);
  assert.equal(docked.data.pilot.localVisible, true);
  assert.equal(docked.data.pilot.corporationChatVisible, true);
  assert(localPresence.some((pilot) => pilot.characterID === first.data.pilot.characterID));
  assert(corporationPresence.some((pilot) => pilot.characterID === first.data.pilot.characterID));
}

function verifyDisabledSchedulerCreatesNoTimerOrStateWork() {
  let timerCalls = 0;
  const scheduler = createIndustrialHirelingScheduler({
    config: makeConfig({ industrialHirelingsEnabled: false }),
    cargoCustody: new Proxy({}, {
      get() { throw new Error("disabled scheduler touched cargo custody"); },
    }),
    setIntervalFn() {
      timerCalls += 1;
      return {};
    },
  });
  const started = scheduler.start();
  assert.equal(started.data.started, false);
  assert.equal(timerCalls, 0);
}

function verifySchedulerBoundsCargoAndExpiryWork() {
  const calls = [];
  let intervalCallback = null;
  let intervalDelay = 0;
  let timerCleared = false;
  const scheduler = createIndustrialHirelingScheduler({
    config: makeConfig({ industrialHirelingsOperationBookmarksEnabled: true }),
    now: () => 1_950_000_000_000,
    cargoCustody: {
      reconcileDueManifests(nowMs, options) {
        calls.push(["cargo", nowMs, options.maxJobs]);
        return { success: true, data: { inspected: 0 } };
      },
    },
    contractService: {
      reconcileExpired(nowMs, options) {
        calls.push(["expiry", nowMs, options.maxJobs]);
        const standDown = options.beforeArchive({ contractID: "test" }, nowMs);
        assert.equal(standDown.success, true);
        return { success: true, data: { expiredCount: 1 } };
      },
    },
    hirelingRuntime: {
      standDown(_session, contract, options) {
        calls.push(["standDown", contract.contractID, options.nowMs]);
        return { success: true };
      },
    },
    bookmarkLifecycle: {
      removeContractBookmark(contract) {
        calls.push(["removeBookmark", contract.contractID]);
        return { success: true };
      },
    },
    setIntervalFn(callback, delay) {
      intervalCallback = callback;
      intervalDelay = delay;
      return { unref() {} };
    },
    clearIntervalFn() { timerCleared = true; },
  });
  const started = scheduler.start();
  assert.equal(started.success, true);
  assert.equal(intervalDelay, 5000);
  assert.equal(typeof intervalCallback, "function");
  assert.deepEqual(calls.slice(0, 4).map((entry) => entry[0]), [
    "cargo",
    "expiry",
    "standDown",
    "removeBookmark",
  ]);
  scheduler.stop();
  assert.equal(timerCleared, true);
}

verifyDisabledModeDoesNoWork();
verifyPersistenceLifecycleAndRoleGates();
verifyHireCommandReplayProtection();
verifyPlayerCommandSurface();
verifyManagedDroneStockPersistenceAndHullLoss();
verifyManagedDroneStockRuntimeBridgeAndRestart();
verifyMinerRuntimeAdapter();
verifyHaulerCustodyRuntimeAndRestartRecovery();
verifyDisabledRuntimeLifecycleDoesNoWork();
verifyPhysicalBudgetDenialDoesNotSpawn();
verifyStableLivingUniverseIdentity();
verifyDisabledSchedulerCreatesNoTimerOrStateWork();
verifySchedulerBoundsCargoAndExpiryWork();
console.log("Industrial hireling contract verification passed.");
