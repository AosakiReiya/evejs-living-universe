"use strict";

const path = require("path");
const {
  ORDER,
  ROLE,
  getDefaultContractService,
} = require("./industrialHirelingContracts");
const {
  isNavigationInTransit,
} = require("./industrialHirelingNavigation");

const OPERATOR_KIND = "industrial_hireling";

function getDefaultConfig() {
  return require(path.join(__dirname, "../../config"));
}

function getDefaultMiningOperations() {
  return require(path.join(__dirname, "../mining/miningNpcOperations"));
}

function getDefaultDroneRuntime() {
  return require(path.join(__dirname, "../drone/droneRuntime"));
}

function getDefaultSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

function getDefaultCargoCustodyService() {
  return require("./industrialHirelingCargoCustody").getDefaultCargoCustodyService();
}

function getDefaultPhysicalBudget() {
  return require(path.join(__dirname, "../../space/npc/npcPhysicalBudget"));
}

function getDefaultIdentityService() {
  return require("./industrialHirelingIdentity")
    .getDefaultIndustrialHirelingIdentityService();
}

function getDefaultSiteCatalog() {
  return require("./industrialHirelingSites").getDefaultIndustrialMiningSiteCatalog();
}

function getDefaultCrewCatalog() {
  return require("./industrialMiningCrewCatalog");
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function isMiningCrewContract(contract) {
  return String(contract && contract.contractKind || "") === "mining_crew";
}

function isNavigationAtAssignedSystem(contract) {
  const assignedSystemID = toPositiveInt(contract && contract.assignedSystemID, 0);
  if (!assignedSystemID) return true;
  const navigationPhase = String(
    contract && contract.navigation && contract.navigation.phase || "",
  );
  if (["blocked", "in_transit"].includes(navigationPhase)) return false;
  const currentSystemID = toPositiveInt(
    contract && contract.navigation && contract.navigation.currentSystemID,
    toPositiveInt(contract && contract.currentSystemID, 0),
  );
  return currentSystemID > 0 && assignedSystemID === currentSystemID;
}

function createIndustrialHirelingRuntime(options = {}) {
  const config = options.config || getDefaultConfig();
  const contractService = options.contractService || getDefaultContractService();
  const miningOperations = options.miningOperations || getDefaultMiningOperations();
  const spaceRuntime = options.spaceRuntime || getDefaultSpaceRuntime();
  const cargoCustody = options.cargoCustody || getDefaultCargoCustodyService();
  let droneRuntime = options.droneRuntime || null;
  let physicalBudget = options.physicalBudget || null;
  let identityService = options.identityService || null;
  let siteCatalog = options.siteCatalog || null;
  let crewCatalog = options.crewCatalog || null;

  function getDroneRuntime() {
    if (!droneRuntime) droneRuntime = getDefaultDroneRuntime();
    return droneRuntime;
  }

  function getPhysicalBudget() {
    if (!physicalBudget) physicalBudget = getDefaultPhysicalBudget();
    return physicalBudget;
  }

  function getIdentityService() {
    if (!identityService) identityService = getDefaultIdentityService();
    return identityService;
  }

  function getSiteCatalog() {
    if (!siteCatalog) siteCatalog = getDefaultSiteCatalog();
    return siteCatalog;
  }

  function getCrewCatalog() {
    if (!crewCatalog) crewCatalog = getDefaultCrewCatalog();
    return crewCatalog;
  }

  function getReservationID(contract) {
    return `${OPERATOR_KIND}:${String(contract && contract.contractID || "")}`;
  }

  function readPersistedContract(contract) {
    const ownerCharacterID = toPositiveInt(contract && contract.ownerCharacterID, 0);
    const contractID = String(contract && contract.contractID || "").trim();
    if (
      !ownerCharacterID ||
      !contractID ||
      typeof contractService.listForCharacter !== "function"
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const listed = contractService.listForCharacter(ownerCharacterID);
    if (!listed || listed.success !== true || !listed.data) {
      return listed || { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_READ_FAILED" };
    }
    const persisted = (listed.data.contracts || [])
      .find((candidate) => String(candidate && candidate.contractID || "") === contractID) || null;
    return persisted
      ? { success: true, data: persisted }
      : { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
  }

  function persistManagedDroneStock(contract, stock, nowMs = Date.now()) {
    if (
      !contract ||
      !contract.contractID ||
      typeof contractService.setManagedDroneStock !== "function"
    ) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_DRONE_STOCK_PERSISTENCE_UNAVAILABLE",
      };
    }
    return contractService.setManagedDroneStock({
      ownerCharacterID: contract.ownerCharacterID,
      contractID: contract.contractID,
      stock,
    }, nowMs);
  }

  function buildManagedDroneStockChanged(contract) {
    return (event = {}) => persistManagedDroneStock(
      contract,
      event && Object.prototype.hasOwnProperty.call(event, "stock")
        ? event.stock
        : event,
      event && event.atMs,
    );
  }

  function importPersistedManagedDroneStock(
    scene,
    contract,
    controllerEntity,
    nowMs = Date.now(),
  ) {
    const stock = contract && contract.managedDroneStock;
    if (!stock) {
      const governedDroneBay = [
        controllerEntity && controllerEntity.governedDroneBay,
        controllerEntity && controllerEntity.droneBay,
        controllerEntity && controllerEntity.npcDroneBay,
      ].find((entries) => Array.isArray(entries) && entries.length > 0) || [];
      if (governedDroneBay.length <= 0) {
        return { success: true, data: { skipped: true, stock: null } };
      }
      const activeDroneRuntime = getDroneRuntime();
      if (
        !activeDroneRuntime ||
        typeof activeDroneRuntime.exportManagedNpcDroneStock !== "function"
      ) {
        return {
          success: false,
          errorMsg: "INDUSTRIAL_HIRELING_DRONE_STOCK_EXPORT_UNAVAILABLE",
        };
      }
      const initialized = activeDroneRuntime.exportManagedNpcDroneStock(
        scene,
        controllerEntity,
        {
          initialize: true,
          nowMs,
          stockID:
            `industrial-hireling:${toPositiveInt(contract.shipIdentityID, 0) || contract.contractID}`,
        },
      );
      if (!initialized || initialized.success !== true) {
        return initialized || {
          success: false,
          errorMsg: "INDUSTRIAL_HIRELING_DRONE_STOCK_INITIALIZE_FAILED",
        };
      }
      const saved = persistManagedDroneStock(
        contract,
        initialized.data && initialized.data.stock,
        nowMs,
      );
      return saved && saved.success === true
        ? {
            success: true,
            data: {
              contract: saved.data,
              stock: initialized.data && initialized.data.stock,
            },
          }
        : saved;
    }
    const activeDroneRuntime = getDroneRuntime();
    if (
      !activeDroneRuntime ||
      typeof activeDroneRuntime.importManagedNpcDroneStock !== "function"
    ) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_DRONE_STOCK_IMPORT_UNAVAILABLE",
      };
    }
    const imported = activeDroneRuntime.importManagedNpcDroneStock(
      scene,
      controllerEntity,
      stock,
      {
        nowMs,
        stockID:
          `industrial-hireling:${toPositiveInt(contract.shipIdentityID, 0) || contract.contractID}`,
      },
    );
    if (!imported || imported.success !== true) {
      return imported || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_DRONE_STOCK_IMPORT_FAILED",
      };
    }
    const saved = persistManagedDroneStock(
      contract,
      imported.data && imported.data.stock,
      nowMs,
    );
    return saved && saved.success === true
      ? {
          success: true,
          data: {
            contract: saved.data,
            stock: imported.data && imported.data.stock,
          },
        }
      : saved;
  }

  function persistFleetManagedDroneStock(scene, contract, fleetRecord, nowMs = Date.now()) {
    // A virtualized crew may still carry its last durable drone-stock snapshot.
    // With no live scene or fleet there is nothing newer to export, so preserve
    // that snapshot and continue standing the contract down.
    if (!scene || !contract || !fleetRecord) {
      return {
        success: true,
        data: {
          skipped: true,
          reason: "no_materialized_fleet",
          stock: cloneValue(contract && contract.managedDroneStock || null),
        },
      };
    }
    if (!droneRuntime) {
      if (!contract.managedDroneStock) {
        return { success: true, data: { skipped: true, reason: "no_managed_drone_stock" } };
      }
      droneRuntime = getDroneRuntime();
    }
    if (typeof droneRuntime.exportManagedNpcDroneStock !== "function") {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_DRONE_STOCK_EXPORT_UNAVAILABLE",
      };
    }
    const entityIDs = [...new Set([
      ...(Array.isArray(fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []),
      ...(Array.isArray(fleetRecord.miningSupportEntityIDs)
        ? fleetRecord.miningSupportEntityIDs
        : []),
      ...(Array.isArray(fleetRecord.supportEntityIDs) ? fleetRecord.supportEntityIDs : []),
      ...(Array.isArray(fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : []),
    ])];
    let persisted = null;
    for (const entityID of entityIDs) {
      const entity = typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : null;
      if (!entity) continue;
      const exported = droneRuntime.exportManagedNpcDroneStock(scene, entity);
      if (!exported || exported.success !== true) {
        if (
          exported &&
          String(exported.errorMsg || "").includes("DRONE_STOCK_NOT_FOUND")
        ) {
          continue;
        }
        return exported || {
          success: false,
          errorMsg: "INDUSTRIAL_HIRELING_DRONE_STOCK_EXPORT_FAILED",
        };
      }
      persisted = persistManagedDroneStock(
        contract,
        exported.data && exported.data.stock,
        nowMs,
      );
      if (!persisted || persisted.success !== true) {
        return persisted || {
          success: false,
          errorMsg: "INDUSTRIAL_HIRELING_DRONE_STOCK_PERSIST_FAILED",
        };
      }
      if (typeof droneRuntime.forgetManagedNpcDroneStock === "function") {
        const forgotten = droneRuntime.forgetManagedNpcDroneStock(
          scene,
          entity,
          {
            force: true,
            outcome: "recalled",
            reason: "industrial-hireling-dematerialized",
            broadcast: false,
            nowMs,
          },
        );
        if (!forgotten || forgotten.success !== true) {
          return forgotten || {
            success: false,
            errorMsg: "INDUSTRIAL_HIRELING_DRONE_STOCK_FORGET_FAILED",
          };
        }
        persisted = persistManagedDroneStock(
          contract,
          forgotten.data && forgotten.data.stock,
          nowMs,
        );
        if (!persisted || persisted.success !== true) {
          return persisted || {
            success: false,
            errorMsg: "INDUSTRIAL_HIRELING_DRONE_STOCK_PERSIST_FAILED",
          };
        }
      }
    }
    return persisted || { success: true, data: { skipped: true } };
  }

  function isActiveContractOrder(contract, role, order) {
    return Boolean(
      contract &&
      String(contract.state || "") === "active" &&
      contract.role === role &&
      contract.order === order
    );
  }

  function buildStateChangedResult(contract) {
    return {
      success: true,
      data: {
        contract,
        skipped: true,
        stateChanged: true,
        reason: "contract_state_changed",
        message:
          "The previous hull was lost and the contract moved to standby; " +
          "no replacement ship was deployed.",
      },
    };
  }

  function unwrapCatalogValue(value) {
    if (value && value.success === true && Object.prototype.hasOwnProperty.call(value, "data")) {
      return value.data;
    }
    return value;
  }

  function resolveCrewRoster(contract) {
    if (!isMiningCrewContract(contract)) {
      return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_CONTRACT_NOT_FOUND" };
    }
    const catalog = getCrewCatalog();
    if (
      !catalog ||
      typeof catalog.resolveIndustrialMiningCrewPackage !== "function" ||
      typeof catalog.buildIndustrialMiningCrewRoster !== "function"
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_CATALOG_UNAVAILABLE" };
    }
    const crewTypeID = String(contract.crewTypeID || "").trim();
    const crewPackage = unwrapCatalogValue(
      catalog.resolveIndustrialMiningCrewPackage(crewTypeID),
    );
    if (!crewPackage) {
      return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_TYPE_NOT_FOUND" };
    }
    const authoredRosterValue = unwrapCatalogValue(
      catalog.buildIndustrialMiningCrewRoster(crewTypeID, {
        contractID: contract.contractID,
        contractSerial: toPositiveInt(contract.serial, 0),
      }),
    );
    const authoredRoster = Array.isArray(authoredRosterValue)
      ? authoredRosterValue
      : Array.isArray(authoredRosterValue && authoredRosterValue.members)
        ? authoredRosterValue.members
        : [];
    if (authoredRoster.length <= 0 || authoredRoster.length > 32) {
      return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_ROSTER_INVALID" };
    }
    const persistedMembers = Array.isArray(contract.members) ? contract.members : [];
    if (persistedMembers.length > 0 && persistedMembers.length !== authoredRoster.length) {
      return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_ROSTER_CARDINALITY_MISMATCH" };
    }
    const persistedByMemberID = new Map(
      persistedMembers.map((member) => [String(member && member.memberID || ""), member]),
    );
    if (
      persistedMembers.length > 0 &&
      (
        persistedByMemberID.size !== persistedMembers.length ||
        authoredRoster.some((member) => !persistedByMemberID.has(
          String(member && member.memberID || ""),
        ))
      )
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_ROSTER_IDENTITY_MISMATCH" };
    }
    const allowedRoles = new Set(["miner", "mining_support", "hauler"]);
    const memberIDs = new Set();
    const slotIDs = new Set();
    const roster = authoredRoster.map((authoredMember, index) => {
      const memberID = String(authoredMember && authoredMember.memberID || "").trim();
      const persisted = persistedByMemberID.get(memberID) || null;
      return {
        ...cloneValue(authoredMember),
        ...(persisted ? cloneValue(persisted) : {}),
        memberID,
        slotID: String(authoredMember && authoredMember.slotID || "").trim(),
        slotIndex: Math.max(0, Math.trunc(Number(authoredMember && authoredMember.slotIndex) || index)),
        role: String(authoredMember && authoredMember.role || "").trim(),
        profileID: String(authoredMember && authoredMember.profileID || "").trim(),
      };
    });
    for (const member of roster) {
      if (
        !member.memberID ||
        !member.slotID ||
        !member.profileID ||
        !allowedRoles.has(member.role) ||
        memberIDs.has(member.memberID) ||
        slotIDs.has(member.slotID)
      ) {
        return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_ROSTER_INVALID" };
      }
      memberIDs.add(member.memberID);
      slotIDs.add(member.slotID);
    }
    const roleCounts = roster.reduce((counts, member) => {
      counts[member.role] += 1;
      return counts;
    }, { miner: 0, mining_support: 0, hauler: 0 });
    if (roleCounts.miner <= 0 || roleCounts.hauler <= 0) {
      return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_ROSTER_INVALID" };
    }
    return {
      success: true,
      data: {
        crewPackage: cloneValue(crewPackage),
        roster,
        roleCounts,
      },
    };
  }

  function reservePhysicalShips(contract, systemID, shipCount) {
    const normalizedShipCount = toPositiveInt(shipCount, 0);
    if (!normalizedShipCount) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_PHYSICAL_BUDGET_INVALID" };
    }
    const result = getPhysicalBudget().reserve({
      reservationID: getReservationID(contract),
      ownerKind: OPERATOR_KIND,
      ownerID: String(contract && contract.contractID || ""),
      systemID: toPositiveInt(systemID, 0),
      shipCount: normalizedShipCount,
      priority: 40,
      metadata: {
        role: String(contract && contract.role || ""),
        contractKind: String(contract && contract.contractKind || "legacy"),
        crewTypeID: String(contract && contract.crewTypeID || ""),
        ownerCharacterID: toPositiveInt(contract && contract.ownerCharacterID, 0),
      },
    });
    return result && result.success === true
      ? { success: true, data: result }
      : {
          success: false,
          errorMsg: isMiningCrewContract(contract)
            ? "INDUSTRIAL_MINING_CREW_PHYSICAL_BUDGET_FULL"
            : "INDUSTRIAL_HIRELING_PHYSICAL_BUDGET_FULL",
          data: result || null,
        };
  }

  function reservePhysicalShip(contract, systemID) {
    return reservePhysicalShips(contract, systemID, 1);
  }

  function releasePhysicalShip(contract) {
    const budget = getPhysicalBudget();
    const reservationID = getReservationID(contract);
    if (
      typeof budget.getReservation === "function" &&
      !budget.getReservation(reservationID)
    ) {
      return false;
    }
    return budget.release(reservationID);
  }

  function markContractDocked(contract, nowMs = Date.now()) {
    const identities = getIdentityService();
    if (isMiningCrewContract(contract)) {
      return typeof identities.markCrewDocked === "function"
        ? identities.markCrewDocked(contract, nowMs)
        : { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_IDENTITY_UNAVAILABLE" };
    }
    return identities.markDocked(contract, nowMs);
  }

  function reconcileContractPresence(contract, runtimeOptions = {}) {
    const identities = getIdentityService();
    if (!identities || typeof identities.ensureContractPresence !== "function") {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_IDENTITY_UNAVAILABLE",
      };
    }
    return identities.ensureContractPresence(
      contract,
      runtimeOptions.nowMs,
    );
  }

  function reconcileIdentityPresence(runtimeOptions = {}) {
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true
    ) {
      return {
        success: true,
        data: { enabled: false, inspectedCount: 0, pilotCount: 0 },
      };
    }
    if (typeof contractService.listActiveContracts !== "function") {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_ACTIVE_CONTRACT_LIST_UNAVAILABLE",
      };
    }
    const listed = contractService.listActiveContracts();
    if (!listed || listed.success !== true) {
      return listed || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_ACTIVE_CONTRACT_LIST_FAILED",
      };
    }
    const identities = getIdentityService();
    if (!identities || typeof identities.syncActiveContractPresence !== "function") {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_IDENTITY_UNAVAILABLE",
      };
    }
    return identities.syncActiveContractPresence(
      listed.data && listed.data.contracts || [],
      runtimeOptions.nowMs,
    );
  }

  function releaseContractPresence(contract) {
    const identities = getIdentityService();
    if (!identities || typeof identities.releaseContractPresence !== "function") {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_IDENTITY_UNAVAILABLE",
      };
    }
    return identities.releaseContractPresence(contract);
  }

  function buildManagedCleanup(contract) {
    return (event = {}) => {
      releasePhysicalShip(contract);
      if (isMiningCrewContract(contract)) {
        const cleared = clearBinding(contract);
        if (cleared && cleared.success === true) {
          markContractDocked(cleared.data);
        }
        return;
      }
      if (
        String(event.reason || "") === "entities_missing" &&
        typeof contractService.recordHullLoss === "function"
      ) {
        const lossResult = contractService.recordHullLoss({
          ownerCharacterID: contract.ownerCharacterID,
          contractID: contract.contractID,
          lossReason: "controller_destroyed",
        });
        if (lossResult && lossResult.success === true) {
          markContractDocked(lossResult.data);
        }
        return;
      }
      const cleared = clearBinding(contract);
      if (cleared && cleared.success === true) {
        markContractDocked(cleared.data);
      }
    };
  }

  function getLoadedScene(systemID) {
    const normalizedSystemID = toPositiveInt(systemID, 0);
    return normalizedSystemID > 0 && spaceRuntime && spaceRuntime.scenes instanceof Map
      ? spaceRuntime.scenes.get(normalizedSystemID) || null
      : null;
  }

  function hasObservers(scene) {
    return Boolean(scene && scene.sessions instanceof Map && scene.sessions.size > 0);
  }

  function resolveScene(session, contract, runtimeOptions = {}) {
    const sessionSystemID = toPositiveInt(session && session._space && session._space.systemID, 0);
    const contractSystemID = toPositiveInt(contract && contract.assignedSystemID, 0);
    const systemID = config.industrialHirelingsRemoteSitesEnabled === true
      ? toPositiveInt(contractSystemID, sessionSystemID)
      : toPositiveInt(sessionSystemID, contractSystemID);
    const providedScene = runtimeOptions.scene &&
      toPositiveInt(runtimeOptions.scene.systemID, 0) === systemID
      ? runtimeOptions.scene
      : null;
    const persistentRemoteSite = config.industrialHirelingsRemoteSitesEnabled === true &&
      toPositiveInt(contract && contract.assignedSiteID, 0) > 0;
    if (persistentRemoteSite) {
      const loadedScene = providedScene || getLoadedScene(systemID);
      return runtimeOptions.allowUnobservedScene === true || hasObservers(loadedScene)
        ? loadedScene
        : null;
    }
    return systemID > 0 && spaceRuntime && typeof spaceRuntime.ensureScene === "function"
      ? spaceRuntime.ensureScene(systemID)
      : null;
  }

  function getOwnerOptions(contract) {
    return {
      operatorKind: OPERATOR_KIND,
      operatorID: String(contract && contract.contractID || ""),
    };
  }

  function clearBinding(contract, nowMs = Date.now()) {
    if (isMiningCrewContract(contract)) {
      if (typeof contractService.setCrewRuntimeBinding !== "function") {
        return {
          success: false,
          errorMsg: "INDUSTRIAL_MINING_CREW_RUNTIME_PERSISTENCE_UNAVAILABLE",
        };
      }
      return contractService.setCrewRuntimeBinding({
        ownerCharacterID: contract.ownerCharacterID,
        contractID: contract.contractID,
        runtimeFleetID: 0,
        members: (Array.isArray(contract.members) ? contract.members : []).map((member) => ({
          ...cloneValue(member),
          runtimeEntityID: 0,
          runtimeShipItemID: 0,
          state: "docked",
        })),
        minerEntityIDs: [],
        supportEntityIDs: [],
        haulerEntityIDs: [],
      }, nowMs);
    }
    return contractService.setRuntimeBinding({
      ownerCharacterID: contract.ownerCharacterID,
      contractID: contract.contractID,
      runtimeFleetID: 0,
      runtimeEntityIDs: [],
    }, nowMs);
  }

  function standDown(session, contract, runtimeOptions = {}) {
    if (!contract || !contract.contractID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const ownerOptions = getOwnerOptions(contract);
    const fleetID = toPositiveInt(contract.runtimeFleetID, 0);
    const fleetRecord = fleetID > 0 && typeof miningOperations.getManagedMiningFleet === "function"
      ? miningOperations.getManagedMiningFleet(fleetID, ownerOptions)
      : null;
    const fleetSystemID = toPositiveInt(fleetRecord && fleetRecord.systemID, 0);
    const persistentRemoteSite = config.industrialHirelingsRemoteSitesEnabled === true &&
      toPositiveInt(contract && contract.assignedSiteID, 0) > 0;
    const requestedSystemID = toPositiveInt(
      fleetSystemID,
      toPositiveInt(contract && contract.assignedSystemID, 0),
    );
    const providedScene = runtimeOptions.scene &&
      toPositiveInt(runtimeOptions.scene.systemID, 0) === requestedSystemID
      ? runtimeOptions.scene
      : null;
    const scene = persistentRemoteSite
      ? providedScene || getLoadedScene(requestedSystemID)
      : fleetSystemID > 0 && spaceRuntime && typeof spaceRuntime.ensureScene === "function"
        ? spaceRuntime.ensureScene(fleetSystemID)
        : resolveScene(session, contract, runtimeOptions);
    let settledVolumeM3 = 0;
    const persistedDroneStock = persistFleetManagedDroneStock(
      scene,
      contract,
      fleetRecord,
      runtimeOptions.nowMs,
    );
    if (!persistedDroneStock || persistedDroneStock.success !== true) {
      return persistedDroneStock || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_DRONE_STOCK_PERSIST_FAILED",
      };
    }
    if (contract.role === ROLE.HAULER) {
      const manifest = cargoCustody.getOpenManifestForContract(contract.contractID);
      if (manifest && manifest.status === "reserved") {
        const cancelResult = cargoCustody.cancelReservation(
          manifest.manifestID,
          runtimeOptions.nowMs,
        );
        if (!cancelResult || cancelResult.success !== true) {
          return cancelResult || {
            success: false,
            errorMsg: "INDUSTRIAL_HIRELING_CARGO_STAND_DOWN_FAILED",
          };
        }
      }
    }
    if (fleetID > 0 && typeof miningOperations.settleManagedMiningFleetCargo === "function") {
      const settleResult = miningOperations.settleManagedMiningFleetCargo(
        scene,
        fleetID,
        { ...ownerOptions, nowMs: runtimeOptions.nowMs },
      );
      settledVolumeM3 = Number(
        settleResult && settleResult.data && settleResult.data.transferredVolumeM3,
      ) || 0;
    }
    const destroyed = typeof miningOperations.destroyManagedMiningFleetsByOwner === "function"
      ? miningOperations.destroyManagedMiningFleetsByOwner({
          ...ownerOptions,
          reason: "stand_down",
        })
      : { success: true, data: { destroyedCount: 0 } };
    if (!destroyed || destroyed.success !== true) {
      return destroyed || { success: false, errorMsg: "INDUSTRIAL_HIRELING_STAND_DOWN_FAILED" };
    }
    releasePhysicalShip(contract);
    const cleared = clearBinding(contract, runtimeOptions.nowMs);
    if (cleared && cleared.success === true) {
      markContractDocked(cleared.data, runtimeOptions.nowMs);
    }
    return cleared && cleared.success === true
      ? {
          success: true,
          data: {
            contract: cleared.data,
            destroyedCount: toPositiveInt(destroyed.data && destroyed.data.destroyedCount, 0),
            settledVolumeM3,
          },
        }
      : cleared;
  }

  function normalizeEntityIDs(values) {
    return (Array.isArray(values) ? values : [])
      .map((value) => toPositiveInt(value, 0))
      .filter(Boolean);
  }

  function sameEntityIDSet(left, right) {
    const leftIDs = [...new Set(normalizeEntityIDs(left))].sort((a, b) => a - b);
    const rightIDs = [...new Set(normalizeEntityIDs(right))].sort((a, b) => a - b);
    return leftIDs.length === rightIDs.length &&
      leftIDs.every((entityID, index) => entityID === rightIDs[index]);
  }

  function isExactEntityIDArray(values, expected) {
    if (!Array.isArray(values)) return false;
    const normalized = normalizeEntityIDs(values);
    return normalized.length === values.length &&
      new Set(normalized).size === normalized.length &&
      normalized.length === normalizeEntityIDs(expected).length &&
      sameEntityIDSet(normalized, expected);
  }

  function validateMaterializedCrew(scene, roster, spawnedData = {}) {
    const fleetRecord = spawnedData.fleetRecord || null;
    const memberBindings = Array.isArray(spawnedData.memberBindings)
      ? spawnedData.memberBindings
      : Array.isArray(spawnedData.roster)
        ? spawnedData.roster
        : Array.isArray(fleetRecord && fleetRecord.managedRoster)
          ? fleetRecord.managedRoster
          : [];
    const entityIDSource =
      Array.isArray(spawnedData.entityIDs)
        ? spawnedData.entityIDs
        : Array.isArray(fleetRecord && fleetRecord.entityIDs)
          ? fleetRecord.entityIDs
          : [
              ...(Array.isArray(fleetRecord && fleetRecord.miningWorkerEntityIDs)
                ? fleetRecord.miningWorkerEntityIDs
                : []),
              ...(Array.isArray(fleetRecord && fleetRecord.miningSupportEntityIDs)
                ? fleetRecord.miningSupportEntityIDs
                : []),
              ...(Array.isArray(fleetRecord && fleetRecord.haulerEntityIDs)
                ? fleetRecord.haulerEntityIDs
                : []),
            ];
    const entityIDs = normalizeEntityIDs(entityIDSource);
    if (
      !fleetRecord ||
      !Array.isArray(roster) ||
      memberBindings.length !== roster.length ||
      entityIDs.length !== roster.length ||
      new Set(entityIDs).size !== roster.length
    ) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_MINING_CREW_PARTIAL_PRESENCE",
      };
    }
    const rosterByMemberID = new Map(
      roster.map((member) => [String(member.memberID || ""), member]),
    );
    const seenMemberIDs = new Set();
    const normalizedBindings = [];
    const expectedByRole = {
      miner: [],
      mining_support: [],
      hauler: [],
    };
    for (const binding of memberBindings) {
      const memberID = String(binding && binding.memberID || "").trim();
      const entityID = toPositiveInt(binding && binding.entityID, 0);
      const member = rosterByMemberID.get(memberID) || null;
      const role = String(binding && binding.role || member && member.role || "").trim();
      const profileID = String(
        binding && binding.profileID || member && member.profileID || "",
      ).trim();
      const entity = entityID > 0 && scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : null;
      if (
        !member ||
        !entity ||
        seenMemberIDs.has(memberID) ||
        !expectedByRole[role] ||
        role !== String(member.role || "") ||
        profileID !== String(member.profileID || "")
      ) {
        return {
          success: false,
          errorMsg: "INDUSTRIAL_MINING_CREW_MEMBER_BINDING_INVALID",
        };
      }
      seenMemberIDs.add(memberID);
      expectedByRole[role].push(entityID);
      normalizedBindings.push({
        memberID,
        index: Math.max(0, Math.trunc(Number(binding.index) || member.slotIndex || 0)),
        entityID,
        role,
        profileID,
        entity,
        member,
      });
    }
    if (!sameEntityIDSet(entityIDs, normalizedBindings.map((binding) => binding.entityID))) {
      return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_PARTIAL_PRESENCE" };
    }
    const returnedMinerEntityIDs =
      spawnedData.minerEntityIDs ||
      fleetRecord.miningWorkerEntityIDs ||
      fleetRecord.workerEntityIDs;
    const returnedSupportEntityIDs =
      spawnedData.supportEntityIDs ||
      fleetRecord.miningSupportEntityIDs ||
      fleetRecord.supportEntityIDs;
    const returnedHaulerEntityIDs =
      spawnedData.haulerEntityIDs || fleetRecord.haulerEntityIDs;
    if (
      !isExactEntityIDArray(returnedMinerEntityIDs, expectedByRole.miner) ||
      !isExactEntityIDArray(returnedSupportEntityIDs, expectedByRole.mining_support) ||
      !isExactEntityIDArray(returnedHaulerEntityIDs, expectedByRole.hauler)
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_ROLE_ARRAY_MISMATCH" };
    }
    return {
      success: true,
      data: {
        fleetRecord,
        entityIDs,
        memberBindings: normalizedBindings,
        minerEntityIDs: expectedByRole.miner,
        supportEntityIDs: expectedByRole.mining_support,
        haulerEntityIDs: expectedByRole.hauler,
      },
    };
  }

  function applyCrewMemberNames(scene, validatedCrew, memberIdentities) {
    const identitiesByMemberID = new Map(
      (Array.isArray(memberIdentities) ? memberIdentities : [])
        .map((identity) => [String(identity && identity.member && identity.member.memberID || ""), identity]),
    );
    const changedEntities = [];
    for (const binding of validatedCrew.memberBindings) {
      const identity = identitiesByMemberID.get(binding.memberID) || null;
      const member = identity && identity.member || binding.member;
      const pilot = identity && identity.pilot || null;
      const actorID = String(
        identity && identity.actorID || member && member.pilotActorID || "",
      ).trim();
      const pilotName = String(
        pilot && pilot.characterName || member && member.pilotName || member && member.shipName || "",
      ).trim();
      const pilotIdentityID = toPositiveInt(
        pilot && pilot.characterID,
        toPositiveInt(member && member.pilotIdentityID, 0),
      );
      const previousPresentation = JSON.stringify({
        ownerID: binding.entity.ownerID,
        npcPilotCharacterID: binding.entity.npcPilotCharacterID,
        corporationID: binding.entity.corporationID,
        allianceID: binding.entity.allianceID,
        warFactionID: binding.entity.warFactionID,
        itemName: binding.entity.itemName,
      });
      binding.entity.ownerID = pilotIdentityID ||
        toPositiveInt(binding.entity.ownerID, 0);
      binding.entity.npcPilotCharacterID = pilotIdentityID || null;
      binding.entity.corporationID = toPositiveInt(
        pilot && pilot.corporationID,
        toPositiveInt(binding.entity.corporationID, 0),
      );
      binding.entity.allianceID = toPositiveInt(pilot && pilot.allianceID, 0);
      binding.entity.warFactionID = toPositiveInt(pilot && pilot.warFactionID, 0);
      binding.entity.securityStatus = Number.isFinite(Number(pilot && pilot.securityStatus))
        ? Number(pilot.securityStatus)
        : Number(binding.entity.securityStatus || 0);
      binding.entity.livingUniverseActorID = actorID || null;
      binding.entity.npcRole = binding.role;
      binding.entity.persistentShipIdentityID =
        toPositiveInt(member && member.shipIdentityID, 0) || null;
      binding.entity.persistentShipName =
        String(member && member.shipName || "").trim() || null;
      if (pilotName) {
        binding.entity.itemName = pilotName;
        binding.entity.slimName = pilotName;
      }
      const nextPresentation = JSON.stringify({
        ownerID: binding.entity.ownerID,
        npcPilotCharacterID: binding.entity.npcPilotCharacterID,
        corporationID: binding.entity.corporationID,
        allianceID: binding.entity.allianceID,
        warFactionID: binding.entity.warFactionID,
        itemName: binding.entity.itemName,
      });
      if (previousPresentation !== nextPresentation) {
        changedEntities.push(binding.entity);
      }
    }
    if (
      changedEntities.length > 0 &&
      scene &&
      typeof scene.broadcastSlimItemChanges === "function"
    ) {
      scene.broadcastSlimItemChanges(changedEntities);
    }
  }

  function buildCrewRuntimeMembers(contract, validatedCrew) {
    const bindingsByMemberID = new Map(
      validatedCrew.memberBindings.map((binding) => [binding.memberID, binding]),
    );
    return (Array.isArray(contract.members) ? contract.members : []).map((member) => {
      const binding = bindingsByMemberID.get(String(member && member.memberID || "")) || null;
      if (!binding) return cloneValue(member);
      return {
        ...cloneValue(member),
        runtimeEntityID: binding.entityID,
        runtimeShipItemID: toPositiveInt(binding.entity && binding.entity.itemID, binding.entityID),
        shipTypeID: toPositiveInt(binding.entity && binding.entity.typeID, member.shipTypeID),
        state: "in_space",
      };
    });
  }

  function destroyCrewRuntime(contract, reason) {
    if (typeof miningOperations.destroyManagedMiningFleetsByOwner !== "function") {
      return { success: true, data: { destroyedCount: 0 } };
    }
    return miningOperations.destroyManagedMiningFleetsByOwner({
      ...getOwnerOptions(contract),
      reason: String(reason || "crew_runtime_cleanup"),
    });
  }

  function requireCrewRuntimeDestroyed(contract, reason) {
    const destroyed = destroyCrewRuntime(contract, reason);
    return destroyed && destroyed.success === true
      ? destroyed
      : {
          success: false,
          errorMsg: "INDUSTRIAL_MINING_CREW_CLEANUP_FAILED",
          data: {
            reason: String(reason || "crew_runtime_cleanup"),
            cleanupResult: destroyed || null,
          },
        };
  }

  function hasCrewRuntimeBinding(contract) {
    return Boolean(
      toPositiveInt(contract && contract.runtimeFleetID, 0) > 0 ||
      normalizeEntityIDs(contract && contract.runtimeEntityIDs).length > 0 ||
      (Array.isArray(contract && contract.members) ? contract.members : [])
        .some((member) => toPositiveInt(member && member.runtimeEntityID, 0) > 0)
    );
  }

  function materializeMiningCrew(session, contract, runtimeOptions = {}) {
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true ||
      config.industrialHirelingsMiningEnabled !== true ||
      config.industrialMiningCrewsEnabled !== true
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_MINING_CREWS_DISABLED" };
    }
    if (isNavigationInTransit(contract)) {
      return {
        success: true,
        data: {
          contract,
          deferred: true,
          reason: "navigation_in_transit",
          message: "The crew remains virtual while it follows its persisted route.",
        },
      };
    }
    if (!isNavigationAtAssignedSystem(contract)) {
      return {
        success: true,
        data: {
          contract,
          deferred: true,
          reason: "navigation_not_at_assignment",
          message: "The crew remains virtual until its persisted location reaches the assignment.",
        },
      };
    }
    const resolvedRoster = resolveCrewRoster(contract);
    if (!resolvedRoster || resolvedRoster.success !== true) return resolvedRoster;
    const assignedSiteID = config.industrialHirelingsRemoteSitesEnabled === true
      ? toPositiveInt(contract && contract.assignedSiteID, 0)
      : 0;
    const playerShipID = toPositiveInt(session && session._space && session._space.shipID, 0);
    let scene = null;
    let centerTarget = null;
    let miningAnchorID = playerShipID;
    if (assignedSiteID > 0) {
      const validation = getSiteCatalog().validateSite(
        assignedSiteID,
        toPositiveInt(contract && contract.assignedSystemID, 0),
      );
      if (!validation || validation.success !== true) return validation;
      scene = resolveScene(session, contract, runtimeOptions);
      if (!scene) {
        return {
          success: true,
          data: {
            contract,
            deferred: true,
            reason: "awaiting_observer",
            message: "Assignment saved; the complete mining crew will deploy when observed.",
          },
        };
      }
      centerTarget = typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(assignedSiteID)
        : null;
      miningAnchorID = assignedSiteID;
      if (!centerTarget || !centerTarget.position) {
        return { success: false, errorMsg: "INDUSTRIAL_HIRELING_SITE_NOT_MATERIALIZED" };
      }
    } else {
      scene = resolveScene(session, contract, runtimeOptions);
      centerTarget = scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(playerShipID)
        : null;
      if (!scene || !centerTarget) {
        return { success: false, errorMsg: "INDUSTRIAL_HIRELING_EMPLOYER_SHIP_NOT_FOUND" };
      }
    }

    let currentContract = {
      ...contract,
      members: resolvedRoster.data.roster,
    };
    const priorFleetID = toPositiveInt(contract.runtimeFleetID, 0);
    let existingFleet = priorFleetID > 0 &&
      typeof miningOperations.getManagedMiningFleet === "function"
      ? miningOperations.getManagedMiningFleet(priorFleetID, getOwnerOptions(contract))
      : null;
    if (!existingFleet && priorFleetID > 0) {
      const refreshed = readPersistedContract(contract);
      if (!refreshed || refreshed.success !== true) return refreshed;
      if (
        String(refreshed.data.state || "") !== "active" ||
        refreshed.data.order !== ORDER.SUPPORT_MINING
      ) {
        return buildStateChangedResult(refreshed.data);
      }
      const refreshedRoster = resolveCrewRoster(refreshed.data);
      if (!refreshedRoster || refreshedRoster.success !== true) return refreshedRoster;
      currentContract = {
        ...refreshed.data,
        members: refreshedRoster.data.roster,
      };
    }

    if (existingFleet) {
      const existingValidation = validateMaterializedCrew(scene, currentContract.members, {
        fleetRecord: existingFleet,
        entityIDs: existingFleet.entityIDs,
        memberBindings: existingFleet.managedRoster,
        minerEntityIDs: existingFleet.miningWorkerEntityIDs,
        supportEntityIDs: existingFleet.miningSupportEntityIDs,
        haulerEntityIDs: existingFleet.haulerEntityIDs,
      });
      if (!existingValidation || existingValidation.success !== true) {
        const destroyed = requireCrewRuntimeDestroyed(
          currentContract,
          "partial_crew_rejected",
        );
        if (!destroyed || destroyed.success !== true) return destroyed;
        releasePhysicalShip(currentContract);
        existingFleet = null;
      }
    }
    if (!existingFleet) {
      releasePhysicalShip(currentContract);
      if (hasCrewRuntimeBinding(currentContract)) {
        const cleared = clearBinding(currentContract, runtimeOptions.nowMs);
        if (!cleared || cleared.success !== true) return cleared;
        const clearedRoster = resolveCrewRoster(cleared.data);
        if (!clearedRoster || clearedRoster.success !== true) return clearedRoster;
        currentContract = {
          ...cleared.data,
          members: clearedRoster.data.roster,
        };
      }
    }
    const reservation = reservePhysicalShips(
      currentContract,
      scene.systemID,
      currentContract.members.length,
    );
    if (!reservation.success) {
      if (existingFleet) {
        const destroyed = requireCrewRuntimeDestroyed(
          currentContract,
          "crew_budget_denied",
        );
        if (!destroyed || destroyed.success !== true) return destroyed;
      }
      return reservation;
    }
    const identityResult = typeof getIdentityService().markCrewInSpace === "function"
      ? getIdentityService().markCrewInSpace(
          currentContract,
          scene.systemID,
          runtimeOptions.nowMs,
        )
      : { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_IDENTITY_UNAVAILABLE" };
    if (!identityResult || identityResult.success !== true) {
      if (existingFleet) {
        const destroyed = requireCrewRuntimeDestroyed(
          currentContract,
          "crew_identity_failed",
        );
        if (!destroyed || destroyed.success !== true) return destroyed;
      }
      releasePhysicalShip(currentContract);
      return identityResult;
    }
    const identityContract = identityResult.data.contract;
    if (existingFleet) {
      const validated = validateMaterializedCrew(scene, identityContract.members, {
        fleetRecord: existingFleet,
        entityIDs: existingFleet.entityIDs,
        memberBindings: existingFleet.managedRoster,
        minerEntityIDs: existingFleet.miningWorkerEntityIDs,
        supportEntityIDs: existingFleet.miningSupportEntityIDs,
        haulerEntityIDs: existingFleet.haulerEntityIDs,
      });
      if (!validated || validated.success !== true) {
        const destroyed = requireCrewRuntimeDestroyed(
          identityContract,
          "crew_reuse_validation_failed",
        );
        if (!destroyed || destroyed.success !== true) return destroyed;
        releasePhysicalShip(identityContract);
        markContractDocked(identityContract, runtimeOptions.nowMs);
        return validated;
      }
      applyCrewMemberNames(
        scene,
        validated.data,
        identityResult.data.memberIdentities,
      );
      return {
        success: true,
        data: {
          contract: identityContract,
          reused: true,
          fleetRecord: existingFleet,
          entityIDs: validated.data.entityIDs,
          minerEntityIDs: validated.data.minerEntityIDs,
          supportEntityIDs: validated.data.supportEntityIDs,
          haulerEntityIDs: validated.data.haulerEntityIDs,
        },
      };
    }
    if (typeof miningOperations.spawnManagedIndustrialMiningCrew !== "function") {
      releasePhysicalShip(identityContract);
      markContractDocked(identityContract, runtimeOptions.nowMs);
      return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_RUNTIME_UNAVAILABLE" };
    }
    const identitiesByMemberID = new Map(
      identityResult.data.memberIdentities.map((identity) => [
        String(identity.member && identity.member.memberID || ""),
        identity,
      ]),
    );
    const spawnRoster = identityContract.members.map((member) => {
      const identity = identitiesByMemberID.get(String(member.memberID || ""));
      return {
        ...cloneValue(member),
        memberID: String(member.memberID || ""),
        role: String(member.role || ""),
        profileID: String(member.profileID || ""),
        pilotIdentity: cloneValue(identity && identity.pilot),
        livingUniverseActorID: String(identity && identity.actorID || member.pilotActorID || ""),
        managedRole: String(member.role || ""),
      };
    });
    const spawned = miningOperations.spawnManagedIndustrialMiningCrew(scene, {
      ...getOwnerOptions(identityContract),
      source: "industrial_mining_crew",
      createdByCharacterID: identityContract.ownerCharacterID,
      targetShipID: miningAnchorID,
      centerTarget,
      roster: spawnRoster,
      onGridSupport: true,
      physicalShipLimit: spawnRoster.length,
      cargoOwnerID: identityContract.ownerCharacterID,
      cargoCorporationID: toPositiveInt(identityContract.ownerCorporationID, 0),
      cargoTransient: false,
      jetcanNamePrefix: String(identityContract.crewName || "Mining Crew"),
      threatDoctrine: cloneValue({
        ...(
          resolvedRoster.data.crewPackage &&
          resolvedRoster.data.crewPackage.threatDoctrine ||
          {}
        ),
        ...(
          identityContract.quotedDoctrine &&
          identityContract.quotedDoctrine.threatDoctrine ||
          {}
        ),
      }),
      onManagedDroneStockChanged: buildManagedDroneStockChanged(identityContract),
      onManagedFleetDestroyed: buildManagedCleanup(identityContract),
    });
    if (!spawned || spawned.success !== true || !spawned.data) {
      releasePhysicalShip(identityContract);
      markContractDocked(identityContract, runtimeOptions.nowMs);
      return spawned || { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_SPAWN_FAILED" };
    }
    const validated = validateMaterializedCrew(scene, identityContract.members, spawned.data);
    if (!validated || validated.success !== true) {
      const destroyed = requireCrewRuntimeDestroyed(
        identityContract,
        "partial_crew_rejected",
      );
      if (!destroyed || destroyed.success !== true) return destroyed;
      releasePhysicalShip(identityContract);
      markContractDocked(identityContract, runtimeOptions.nowMs);
      return validated;
    }
    applyCrewMemberNames(
      scene,
      validated.data,
      identityResult.data.memberIdentities,
    );
    if (typeof contractService.setCrewRuntimeBinding !== "function") {
      const destroyed = requireCrewRuntimeDestroyed(
        identityContract,
        "crew_binding_unavailable",
      );
      if (!destroyed || destroyed.success !== true) return destroyed;
      releasePhysicalShip(identityContract);
      markContractDocked(identityContract, runtimeOptions.nowMs);
      return {
        success: false,
        errorMsg: "INDUSTRIAL_MINING_CREW_RUNTIME_PERSISTENCE_UNAVAILABLE",
      };
    }
    const bound = contractService.setCrewRuntimeBinding({
      ownerCharacterID: identityContract.ownerCharacterID,
      contractID: identityContract.contractID,
      runtimeFleetID: validated.data.fleetRecord.fleetID,
      members: buildCrewRuntimeMembers(identityContract, validated.data),
      minerEntityIDs: validated.data.minerEntityIDs,
      supportEntityIDs: validated.data.supportEntityIDs,
      haulerEntityIDs: validated.data.haulerEntityIDs,
    }, runtimeOptions.nowMs);
    if (!bound || bound.success !== true) {
      const destroyed = requireCrewRuntimeDestroyed(
        identityContract,
        "crew_bind_failed",
      );
      if (!destroyed || destroyed.success !== true) return destroyed;
      releasePhysicalShip(identityContract);
      markContractDocked(identityContract, runtimeOptions.nowMs);
      return bound || { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_BIND_FAILED" };
    }
    return {
      success: true,
      data: {
        contract: bound.data,
        reused: false,
        fleetRecord: validated.data.fleetRecord,
        entityIDs: validated.data.entityIDs,
        minerEntityIDs: validated.data.minerEntityIDs,
        supportEntityIDs: validated.data.supportEntityIDs,
        haulerEntityIDs: validated.data.haulerEntityIDs,
      },
    };
  }

  function materializeMiner(session, contract, runtimeOptions = {}) {
    if (isMiningCrewContract(contract)) {
      return materializeMiningCrew(session, contract, runtimeOptions);
    }
    if (isNavigationInTransit(contract) || !isNavigationAtAssignedSystem(contract)) {
      return {
        success: true,
        data: {
          contract,
          deferred: true,
          reason: isNavigationInTransit(contract)
            ? "navigation_in_transit"
            : "navigation_not_at_assignment",
          message: "The miner remains virtual until its persisted location reaches the assignment.",
        },
      };
    }
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true ||
      config.industrialHirelingsMiningEnabled !== true
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELINGS_DISABLED" };
    }
    const assignedSiteID = config.industrialHirelingsRemoteSitesEnabled === true
      ? toPositiveInt(contract && contract.assignedSiteID, 0)
      : 0;
    const playerShipID = toPositiveInt(session && session._space && session._space.shipID, 0);
    let scene = null;
    let centerTarget = null;
    let miningAnchorID = playerShipID;
    if (assignedSiteID > 0) {
      const validation = getSiteCatalog().validateSite(
        assignedSiteID,
        toPositiveInt(contract && contract.assignedSystemID, 0),
      );
      if (!validation || validation.success !== true) {
        return validation || {
          success: false,
          errorMsg: "INDUSTRIAL_HIRELING_SITE_NOT_FOUND",
        };
      }
      scene = resolveScene(session, contract, runtimeOptions);
      if (!scene) {
        return {
          success: true,
          data: {
            contract,
            deferred: true,
            reason: "awaiting_observer",
            message: "Assignment saved; the mining ship will deploy when a capsuleer enters that system.",
          },
        };
      }
      centerTarget = scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(assignedSiteID)
        : null;
      miningAnchorID = assignedSiteID;
      if (!scene || !centerTarget || !centerTarget.position) {
        return {
          success: false,
          errorMsg: "INDUSTRIAL_HIRELING_SITE_NOT_MATERIALIZED",
        };
      }
    } else {
      scene = resolveScene(session, contract, runtimeOptions);
      centerTarget = scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(playerShipID)
        : null;
      if (!scene || !centerTarget) {
        return { success: false, errorMsg: "INDUSTRIAL_HIRELING_EMPLOYER_SHIP_NOT_FOUND" };
      }
    }
    let currentContract = contract;
    const priorFleetID = toPositiveInt(contract.runtimeFleetID, 0);
    const existingFleet = priorFleetID > 0 &&
      typeof miningOperations.getManagedMiningFleet === "function"
      ? miningOperations.getManagedMiningFleet(priorFleetID, getOwnerOptions(contract))
      : null;
    if (!existingFleet && priorFleetID > 0) {
      const refreshed = readPersistedContract(contract);
      if (!refreshed || refreshed.success !== true) return refreshed;
      currentContract = refreshed.data;
      if (!isActiveContractOrder(currentContract, ROLE.MINER, ORDER.SUPPORT_MINING)) {
        return buildStateChangedResult(currentContract);
      }
    }
    const ownerOptions = getOwnerOptions(currentContract);
    if (!existingFleet && typeof miningOperations.destroyManagedMiningFleetsByOwner === "function") {
      miningOperations.destroyManagedMiningFleetsByOwner({
        ...ownerOptions,
        reason: "replace_stale_runtime",
      });
    }
    const reservation = reservePhysicalShip(currentContract, scene.systemID);
    if (!reservation.success) return reservation;
    const identityResult = getIdentityService().markInSpace(
      currentContract,
      scene.systemID,
      runtimeOptions.nowMs,
    );
    if (!identityResult || identityResult.success !== true) {
      if (!existingFleet) releasePhysicalShip(currentContract);
      return identityResult;
    }
    const identityContract = identityResult.data.contract;
    const identityOwnerOptions = getOwnerOptions(identityContract);
    if (existingFleet) {
      return {
        success: true,
        data: { contract: identityContract, reused: true, fleetRecord: existingFleet },
      };
    }
    const spawned = miningOperations.spawnManagedMiningFleet(scene, {
      ...identityOwnerOptions,
      source: "industrial_hireling",
      createdByCharacterID: identityContract.ownerCharacterID,
      targetShipID: miningAnchorID,
      centerTarget,
      minerAmount: 1,
      haulerAmount: 0,
      onGridSupport: true,
      physicalShipLimit: 1,
      cargoOwnerID: identityContract.ownerCharacterID,
      cargoCorporationID: toPositiveInt(identityContract.ownerCorporationID, 0),
      cargoTransient: false,
      jetcanNamePrefix: String(identityResult.data.pilot.characterName || "Hireling Miner"),
      pilotIdentity: identityResult.data.pilot,
      livingUniverseActorID: identityResult.data.actorID,
      managedRole: ROLE.MINER,
      onManagedDroneStockChanged: buildManagedDroneStockChanged(identityContract),
      onManagedFleetDestroyed: buildManagedCleanup(identityContract),
    });
    if (!spawned || spawned.success !== true || !spawned.data || !spawned.data.fleetRecord) {
      releasePhysicalShip(identityContract);
      getIdentityService().markDocked(identityContract, runtimeOptions.nowMs);
      return spawned || { success: false, errorMsg: "INDUSTRIAL_HIRELING_MINER_SPAWN_FAILED" };
    }
    const fleetRecord = spawned.data.fleetRecord;
    const entityIDs = Array.isArray(spawned.data.entityIDs) ? spawned.data.entityIDs : [];
    const firstEntity = entityIDs.length > 0 && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityIDs[0])
      : null;
    const importedDroneStock = importPersistedManagedDroneStock(
      scene,
      identityContract,
      firstEntity,
      runtimeOptions.nowMs,
    );
    if (!importedDroneStock || importedDroneStock.success !== true) {
      miningOperations.destroyManagedMiningFleetsByOwner({
        ...identityOwnerOptions,
        reason: "drone_stock_import_failed",
      });
      releasePhysicalShip(identityContract);
      getIdentityService().markDocked(identityContract, runtimeOptions.nowMs);
      return importedDroneStock || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_DRONE_STOCK_IMPORT_FAILED",
      };
    }
    const bound = contractService.setRuntimeBinding({
      ownerCharacterID: identityContract.ownerCharacterID,
      contractID: identityContract.contractID,
      runtimeFleetID: fleetRecord.fleetID,
      runtimeEntityIDs: entityIDs,
      pilotIdentityID: toPositiveInt(
        identityResult.data.pilot.characterID,
        toPositiveInt(identityContract.pilotIdentityID, 0),
      ),
      runtimeShipItemID: toPositiveInt(firstEntity && firstEntity.itemID, 0),
      shipTypeID: toPositiveInt(firstEntity && firstEntity.typeID, 0),
      shipName: String(firstEntity && firstEntity.itemName || "").trim() || null,
    }, runtimeOptions.nowMs);
    if (!bound || bound.success !== true) {
      miningOperations.destroyManagedMiningFleetsByOwner({
        ...identityOwnerOptions,
        reason: "bind_failed",
      });
      releasePhysicalShip(identityContract);
      getIdentityService().markDocked(identityContract, runtimeOptions.nowMs);
      return bound || { success: false, errorMsg: "INDUSTRIAL_HIRELING_BIND_FAILED" };
    }
    return {
      success: true,
      data: {
        contract: bound.data,
        reused: false,
        fleetRecord,
        entityIDs,
      },
    };
  }

  function materializeHauler(session, contract, runtimeOptions = {}) {
    if (isNavigationInTransit(contract) || !isNavigationAtAssignedSystem(contract)) {
      return {
        success: true,
        data: {
          contract,
          deferred: true,
          reason: isNavigationInTransit(contract)
            ? "navigation_in_transit"
            : "navigation_not_at_assignment",
          message: "The hauler remains virtual until its persisted location reaches the assignment.",
        },
      };
    }
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true ||
      config.industrialHirelingsHaulingEnabled !== true
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELINGS_DISABLED" };
    }
    const scene = resolveScene(session, contract);
    const playerShipID = toPositiveInt(session && session._space && session._space.shipID, 0);
    const centerTarget = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(playerShipID)
      : null;
    if (!scene || !centerTarget) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_EMPLOYER_SHIP_NOT_FOUND" };
    }
    let currentContract = contract;
    const priorFleetID = toPositiveInt(contract.runtimeFleetID, 0);
    const existingFleet = priorFleetID > 0 &&
      typeof miningOperations.getManagedMiningFleet === "function"
      ? miningOperations.getManagedMiningFleet(priorFleetID, getOwnerOptions(contract))
      : null;
    if (!existingFleet && priorFleetID > 0) {
      const refreshed = readPersistedContract(contract);
      if (!refreshed || refreshed.success !== true) return refreshed;
      currentContract = refreshed.data;
      if (!isActiveContractOrder(currentContract, ROLE.HAULER, ORDER.HAUL_OPERATION)) {
        return buildStateChangedResult(currentContract);
      }
    }
    const identityResult = getIdentityService().markInSpace(
      currentContract,
      scene.systemID,
      runtimeOptions.nowMs,
    );
    if (!identityResult || identityResult.success !== true) return identityResult;
    const identityContract = identityResult.data.contract;
    const ownerOptions = getOwnerOptions(identityContract);
    if (existingFleet) {
      const reservation = reservePhysicalShip(identityContract, scene.systemID);
      if (!reservation.success) return reservation;
      return {
        success: true,
        data: { contract: identityContract, reused: true, fleetRecord: existingFleet },
      };
    }

    const reserved = cargoCustody.reserveNearestContainer({
      scene,
      contract: identityContract,
      referenceEntity: centerTarget,
    }, runtimeOptions.nowMs);
    if (!reserved || reserved.success !== true || !reserved.data || !reserved.data.manifest) {
      return reserved || { success: false, errorMsg: "INDUSTRIAL_HIRELING_CARGO_RESERVE_FAILED" };
    }
    const manifest = reserved.data.manifest;
    if (manifest.status === "in_transit") {
      return {
        success: true,
        data: {
          contract: identityContract,
          manifest,
          reused: true,
          inTransit: true,
          message: `Cargo is already in transit to ${manifest.destinationStationID}.`,
        },
      };
    }
    const sourceEntity = reserved.data.sourceEntity ||
      (typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(toPositiveInt(manifest.sourceContainerID, 0))
        : null);
    if (!sourceEntity) {
      cargoCustody.cancelReservation(manifest.manifestID, runtimeOptions.nowMs);
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_JETCAN_NOT_FOUND" };
    }
    if (typeof miningOperations.destroyManagedMiningFleetsByOwner === "function") {
      miningOperations.destroyManagedMiningFleetsByOwner({
        ...ownerOptions,
        reason: "replace_stale_runtime",
      });
    }
    if (typeof miningOperations.spawnManagedMiningHauler !== "function") {
      cargoCustody.cancelReservation(manifest.manifestID, runtimeOptions.nowMs);
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_HAULER_RUNTIME_UNAVAILABLE" };
    }
    const reservation = reservePhysicalShip(identityContract, scene.systemID);
    if (!reservation.success) {
      cargoCustody.cancelReservation(manifest.manifestID, runtimeOptions.nowMs);
      return reservation;
    }
    const spawned = miningOperations.spawnManagedMiningHauler(scene, {
      ...ownerOptions,
      source: "industrial_hireling",
      createdByCharacterID: identityContract.ownerCharacterID,
      targetShipID: playerShipID,
      centerTarget,
      externalContainerID: manifest.sourceContainerID,
      externalManifestID: manifest.manifestID,
      physicalShipLimit: 1,
      cargoOwnerID: identityContract.ownerCharacterID,
      cargoCorporationID: toPositiveInt(identityContract.ownerCorporationID, 0),
      pilotIdentity: identityResult.data.pilot,
      livingUniverseActorID: identityResult.data.actorID,
      managedRole: ROLE.HAULER,
      onManagedFleetDestroyed: buildManagedCleanup(identityContract),
      externalContainerCollector(collection) {
        if (toPositiveInt(collection && collection.containerID, 0) !== manifest.sourceContainerID) {
          return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CARGO_SOURCE_MISMATCH" };
        }
        return cargoCustody.collectReservedManifest(
          manifest.manifestID,
          collection && collection.nowMs,
        );
      },
    });
    if (!spawned || spawned.success !== true || !spawned.data || !spawned.data.fleetRecord) {
      releasePhysicalShip(identityContract);
      cargoCustody.cancelReservation(manifest.manifestID, runtimeOptions.nowMs);
      return spawned || { success: false, errorMsg: "INDUSTRIAL_HIRELING_HAULER_SPAWN_FAILED" };
    }
    const fleetRecord = spawned.data.fleetRecord;
    const entityIDs = Array.isArray(spawned.data.entityIDs) ? spawned.data.entityIDs : [];
    const firstEntity = entityIDs.length > 0 && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityIDs[0])
      : null;
    const bound = contractService.setRuntimeBinding({
      ownerCharacterID: identityContract.ownerCharacterID,
      contractID: identityContract.contractID,
      runtimeFleetID: fleetRecord.fleetID,
      runtimeEntityIDs: entityIDs,
      pilotIdentityID: toPositiveInt(
        identityResult.data.pilot.characterID,
        toPositiveInt(identityContract.pilotIdentityID, 0),
      ),
      runtimeShipItemID: toPositiveInt(firstEntity && firstEntity.itemID, 0),
      shipTypeID: toPositiveInt(firstEntity && firstEntity.typeID, 0),
      shipName: String(firstEntity && firstEntity.itemName || "").trim() || null,
    }, runtimeOptions.nowMs);
    if (!bound || bound.success !== true) {
      miningOperations.destroyManagedMiningFleetsByOwner({
        ...ownerOptions,
        reason: "bind_failed",
      });
      releasePhysicalShip(identityContract);
      cargoCustody.cancelReservation(manifest.manifestID, runtimeOptions.nowMs);
      return bound || { success: false, errorMsg: "INDUSTRIAL_HIRELING_BIND_FAILED" };
    }
    return {
      success: true,
      data: {
        contract: bound.data,
        manifest,
        reused: false,
        fleetRecord,
        entityIDs,
        message:
          `Hauler is warping to can ${manifest.sourceContainerID}; ` +
          `delivery is locked to station ${manifest.destinationStationID}.`,
      },
    };
  }

  function applyOrder(session, contract, runtimeOptions = {}) {
    if (!contract || !contract.contractID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    if (isNavigationInTransit(contract)) {
      const virtualized = standDown(session, contract, runtimeOptions);
      if (!virtualized || virtualized.success !== true) return virtualized;
      return {
        success: true,
        data: {
          ...(virtualized.data || {}),
          deferred: true,
          reason: "navigation_in_transit",
          message: "The crew is traveling virtually along its persisted stargate route.",
        },
      };
    }
    if (!isNavigationAtAssignedSystem(contract)) {
      const virtualized = standDown(session, contract, runtimeOptions);
      if (!virtualized || virtualized.success !== true) return virtualized;
      return {
        success: true,
        data: {
          ...(virtualized.data || {}),
          deferred: true,
          reason: "navigation_not_at_assignment",
          message: "The crew remains virtual until its persisted location reaches the assignment.",
        },
      };
    }
    if (isMiningCrewContract(contract)) {
      return String(contract.state || "") === "active" &&
        contract.order === ORDER.SUPPORT_MINING
        ? materializeMiningCrew(session, contract, runtimeOptions)
        : standDown(session, contract, runtimeOptions);
    }
    if (contract.role === ROLE.MINER && contract.order === ORDER.SUPPORT_MINING) {
      return materializeMiner(session, contract, runtimeOptions);
    }
    if (contract.role === ROLE.HAULER && contract.order === ORDER.HAUL_OPERATION) {
      return materializeHauler(session, contract, runtimeOptions);
    }
    return standDown(session, contract, runtimeOptions);
  }

  function isPersistentSiteMiningContract(contract) {
    if (
      config.industrialHirelingsRemoteSitesEnabled !== true ||
      !contract ||
      (
        contract.role !== ROLE.MINER &&
        !isMiningCrewContract(contract)
      ) ||
      String(contract.state || "") !== "active" ||
      contract.order !== ORDER.SUPPORT_MINING ||
      isNavigationInTransit(contract)
    ) {
      return false;
    }
    const assignedSiteID = toPositiveInt(contract.assignedSiteID, 0);
    const assignedSystemID = toPositiveInt(contract.assignedSystemID, 0);
    if (!assignedSiteID || !assignedSystemID) return false;
    if (!isNavigationAtAssignedSystem(contract)) {
      return false;
    }
    const validation = getSiteCatalog().validateSite(assignedSiteID, assignedSystemID);
    return Boolean(validation && validation.success === true);
  }

  function getObservedSceneForContract(contract) {
    const scene = getLoadedScene(toPositiveInt(contract && contract.assignedSystemID, 0));
    return hasObservers(scene) ? scene : null;
  }

  function getReconcileBatchSize(runtimeOptions = {}) {
    return Math.max(
      1,
      Math.min(
        16,
        toPositiveInt(
          runtimeOptions.maxContracts,
          toPositiveInt(config.industrialHirelingsMaxJobsPerPass, 4),
        ),
      ),
    );
  }

  function reconcileForObservedScene(scene, runtimeOptions = {}) {
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true ||
      config.industrialHirelingsRemoteSitesEnabled !== true
    ) {
      return {
        success: true,
        data: {
          enabled: false,
          totalMatchingCount: 0,
          processedCount: 0,
          deployedCount: 0,
          staleCount: 0,
          rematerializedCount: 0,
          hasMore: false,
        },
      };
    }
    const systemID = toPositiveInt(scene && scene.systemID, 0);
    if (!systemID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_SYSTEM_REQUIRED" };
    }
    if (!hasObservers(scene)) {
      return {
        success: true,
        data: {
          enabled: true,
          systemID,
          totalMatchingCount: 0,
          processedCount: 0,
          deployedCount: 0,
          staleCount: 0,
          rematerializedCount: 0,
          hasMore: false,
          skippedReason: "scene_unobserved",
        },
      };
    }
    if (typeof contractService.listForAssignedSystem !== "function") {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_SYSTEM_LIST_UNAVAILABLE" };
    }
    const listed = contractService.listForAssignedSystem(systemID);
    if (!listed || listed.success !== true) return listed;
    const processedContractIDs = new Set(
      (Array.isArray(runtimeOptions.processedContractIDs)
        ? runtimeOptions.processedContractIDs
        : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    );
    const matchingContracts = (listed.data.contracts || [])
      .filter(isPersistentSiteMiningContract)
      .filter((contract) => !processedContractIDs.has(String(contract.contractID || "")));
    const offset = Math.max(0, Math.trunc(Number(runtimeOptions.offset) || 0));
    const maxContracts = getReconcileBatchSize(runtimeOptions);
    const contracts = matchingContracts.slice(offset, offset + maxContracts);
    let deployedCount = 0;
    let staleCount = 0;
    let rematerializedCount = 0;
    const failures = [];
    const observerSession = runtimeOptions.observerSession ||
      (scene.sessions instanceof Map ? scene.sessions.values().next().value : null) ||
      null;
    for (const contract of contracts) {
      const fleetID = toPositiveInt(contract.runtimeFleetID, 0);
      const hasRuntimeBinding = fleetID > 0 ||
        (Array.isArray(contract.runtimeEntityIDs) && contract.runtimeEntityIDs.length > 0);
      const fleet = fleetID > 0 && typeof miningOperations.getManagedMiningFleet === "function"
        ? miningOperations.getManagedMiningFleet(fleetID, getOwnerOptions(contract))
        : null;
      if (fleet) {
        if (isMiningCrewContract(contract)) {
          const reconciledCrew = materializeMiningCrew(
            observerSession,
            contract,
            {
              ...runtimeOptions,
              scene,
            },
          );
          if (
            !reconciledCrew ||
            reconciledCrew.success !== true ||
            (reconciledCrew.data && reconciledCrew.data.deferred === true)
          ) {
            failures.push({
              contractID: contract.contractID,
              errorMsg: reconciledCrew && reconciledCrew.errorMsg ||
                "INDUSTRIAL_MINING_CREW_RECONCILE_FAILED",
            });
            continue;
          }
          deployedCount += 1;
          if (reconciledCrew.data && reconciledCrew.data.reused !== true) {
            staleCount += 1;
            rematerializedCount += 1;
          }
          continue;
        }
        deployedCount += 1;
        continue;
      }
      let current = contract;
      if (hasRuntimeBinding) {
        releasePhysicalShip(contract);
        const cleared = clearBinding(contract, runtimeOptions.nowMs);
        if (!cleared || cleared.success !== true) {
          failures.push({ contractID: contract.contractID, errorMsg: cleared && cleared.errorMsg });
          continue;
        }
        markContractDocked(cleared.data, runtimeOptions.nowMs);
        current = cleared.data;
        staleCount += 1;
      }
      // getManagedMiningFleet can prune a fleet whose entities disappeared. Its
      // cleanup callback records a hull loss, which transitions the persisted
      // contract to standby. Re-check the freshly loaded contract before trying
      // to replace the missing hull; otherwise reconciliation immediately
      // resurrects a standby hireling and re-reserves its physical-ship budget.
      if (!isPersistentSiteMiningContract(current)) {
        continue;
      }
      const materialized = materializeMiner(observerSession, current, {
        ...runtimeOptions,
        scene,
      });
      if (
        !materialized ||
        materialized.success !== true ||
        (materialized.data && materialized.data.deferred === true)
      ) {
        failures.push({
          contractID: contract.contractID,
          errorMsg: materialized && materialized.errorMsg ||
            "INDUSTRIAL_HIRELING_MINER_SPAWN_FAILED",
        });
        continue;
      }
      deployedCount += 1;
      rematerializedCount += 1;
    }
    const nextOffset = offset + contracts.length;
    return {
      success: failures.length === 0,
      errorMsg: failures.length > 0 ? "INDUSTRIAL_HIRELING_SCENE_RECONCILE_FAILED" : null,
      data: {
        enabled: true,
        systemID,
        totalMatchingCount: matchingContracts.length,
        processedCount: contracts.length,
        deployedCount,
        staleCount,
        rematerializedCount,
        failures,
        processedContractIDs: contracts.map((contract) => contract.contractID),
        nextOffset,
        hasMore: nextOffset < matchingContracts.length,
      },
    };
  }

  function virtualizeForUnobservedScene(scene, runtimeOptions = {}) {
    const systemID = toPositiveInt(scene && scene.systemID, 0);
    if (!systemID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_SYSTEM_REQUIRED" };
    }
    if (hasObservers(scene)) {
      return {
        success: true,
        data: {
          enabled: true,
          systemID,
          processedCount: 0,
          virtualizedCount: 0,
          hasMore: false,
          skippedReason: "scene_observed",
        },
      };
    }
    if (typeof contractService.listForAssignedSystem !== "function") {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_SYSTEM_LIST_UNAVAILABLE" };
    }
    const listed = contractService.listForAssignedSystem(systemID);
    if (!listed || listed.success !== true) return listed;
    const processedContractIDs = new Set(
      (Array.isArray(runtimeOptions.processedContractIDs)
        ? runtimeOptions.processedContractIDs
        : [])
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    );
    const matchingContracts = (listed.data.contracts || [])
      .filter(isPersistentSiteMiningContract)
      .filter((contract) => !processedContractIDs.has(String(contract.contractID || "")));
    const offset = Math.max(0, Math.trunc(Number(runtimeOptions.offset) || 0));
    const maxContracts = getReconcileBatchSize(runtimeOptions);
    const contracts = matchingContracts.slice(offset, offset + maxContracts);
    let virtualizedCount = 0;
    const failures = [];
    for (const contract of contracts) {
      const hasRuntimeBinding =
        toPositiveInt(contract.runtimeFleetID, 0) > 0 ||
        (Array.isArray(contract.runtimeEntityIDs) && contract.runtimeEntityIDs.length > 0);
      if (!hasRuntimeBinding) continue;
      const result = standDown(null, contract, {
        ...runtimeOptions,
        scene,
      });
      if (!result || result.success !== true) {
        failures.push({ contractID: contract.contractID, errorMsg: result && result.errorMsg });
        continue;
      }
      virtualizedCount += 1;
    }
    const nextOffset = offset + contracts.length;
    return {
      success: failures.length === 0,
      errorMsg: failures.length > 0 ? "INDUSTRIAL_HIRELING_SCENE_VIRTUALIZE_FAILED" : null,
      data: {
        enabled: true,
        systemID,
        totalMatchingCount: matchingContracts.length,
        processedCount: contracts.length,
        virtualizedCount,
        failures,
        processedContractIDs: contracts.map((contract) => contract.contractID),
        nextOffset,
        hasMore: nextOffset < matchingContracts.length,
      },
    };
  }

  function reconcileForSession(session, runtimeOptions = {}) {
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true
    ) {
      return {
        success: true,
        data: {
          enabled: false,
          inspectedCount: 0,
          deployedCount: 0,
          staleCount: 0,
          rematerializedCount: 0,
        },
      };
    }
    const ownerCharacterID = toPositiveInt(session && session.characterID, 0);
    if (!ownerCharacterID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_EMPLOYER_REQUIRED" };
    }
    const listed = contractService.listForCharacter(ownerCharacterID);
    if (!listed || listed.success !== true) return listed;
    const maxContracts = Math.max(
      1,
      Math.min(8, toPositiveInt(config.industrialHirelingsMaxActivePerCharacter, 2)),
    );
    const contracts = (listed.data.contracts || []).slice(0, maxContracts);
    let deployedCount = 0;
    let staleCount = 0;
    let rematerializedCount = 0;
    let deferredCount = 0;
    const failures = [];
    for (const contract of contracts) {
      const fleetID = toPositiveInt(contract.runtimeFleetID, 0);
      const hasRuntimeBinding = fleetID > 0 ||
        (Array.isArray(contract.runtimeEntityIDs) && contract.runtimeEntityIDs.length > 0);
      const fleet = fleetID > 0 && typeof miningOperations.getManagedMiningFleet === "function"
        ? miningOperations.getManagedMiningFleet(fleetID, getOwnerOptions(contract))
        : null;
      if (fleet) {
        if (isMiningCrewContract(contract)) {
          const observedScene = getObservedSceneForContract(contract);
          if (!observedScene) {
            deferredCount += 1;
            continue;
          }
          const reconciledCrew = materializeMiningCrew(session, contract, {
            ...runtimeOptions,
            scene: observedScene,
          });
          if (!reconciledCrew || reconciledCrew.success !== true) {
            failures.push({
              contractID: contract.contractID,
              errorMsg: reconciledCrew && reconciledCrew.errorMsg ||
                "INDUSTRIAL_MINING_CREW_RECONCILE_FAILED",
            });
            continue;
          }
          deployedCount += 1;
          if (reconciledCrew.data && reconciledCrew.data.reused !== true) {
            staleCount += 1;
            rematerializedCount += 1;
          }
          continue;
        }
        deployedCount += 1;
        continue;
      }
      let current = contract;
      if (hasRuntimeBinding) {
        releasePhysicalShip(contract);
        const cleared = clearBinding(contract, runtimeOptions.nowMs);
        if (!cleared || cleared.success !== true) {
          failures.push({ contractID: contract.contractID, errorMsg: cleared && cleared.errorMsg });
          continue;
        }
        markContractDocked(cleared.data, runtimeOptions.nowMs);
        current = cleared.data;
        staleCount += 1;
      }
      // Fleet lookup may prune a missing fleet and move its contract to standby.
      // Use the post-cleanup record instead of the pre-lookup snapshot.
      if (!isPersistentSiteMiningContract(current)) {
        continue;
      }
      const observedScene = getObservedSceneForContract(current);
      if (!observedScene) {
        deferredCount += 1;
        continue;
      }
      const materialized = materializeMiner(session, current, {
        ...runtimeOptions,
        scene: observedScene,
      });
      if (!materialized || materialized.success !== true) {
        failures.push({
          contractID: contract.contractID,
          errorMsg: materialized && materialized.errorMsg ||
            "INDUSTRIAL_HIRELING_MINER_SPAWN_FAILED",
        });
        continue;
      }
      deployedCount += 1;
      rematerializedCount += 1;
    }
    return {
      success: failures.length === 0,
      errorMsg: failures.length > 0 ? "INDUSTRIAL_HIRELING_RECONCILE_FAILED" : null,
      data: {
        enabled: true,
        inspectedCount: contracts.length,
        deployedCount,
        staleCount,
        rematerializedCount,
        deferredCount,
        failures,
      },
    };
  }

  function handleEmployerSessionDetaching(session, runtimeOptions = {}) {
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true
    ) {
      return {
        success: true,
        data: { enabled: false, inspectedCount: 0, stoodDownCount: 0 },
      };
    }
    const ownerCharacterID = toPositiveInt(session && session.characterID, 0);
    if (!ownerCharacterID) {
      return { success: true, data: { enabled: true, inspectedCount: 0, stoodDownCount: 0 } };
    }
    const listed = contractService.listForCharacter(ownerCharacterID);
    if (!listed || listed.success !== true) return listed;
    const maxContracts = Math.max(
      1,
      Math.min(8, toPositiveInt(config.industrialHirelingsMaxActivePerCharacter, 2)),
    );
    const contracts = (listed.data.contracts || []).slice(0, maxContracts);
    let stoodDownCount = 0;
    let preservedCount = 0;
    const failures = [];
    for (const contract of contracts) {
      if (isPersistentSiteMiningContract(contract)) {
        preservedCount += 1;
        continue;
      }
      const hasRuntimeBinding =
        toPositiveInt(contract.runtimeFleetID, 0) > 0 ||
        (Array.isArray(contract.runtimeEntityIDs) && contract.runtimeEntityIDs.length > 0);
      const hasUncollectedCargo = ["reserved", "collecting"].includes(
        String(contract.cargoStatus || ""),
      );
      if (!hasRuntimeBinding && !hasUncollectedCargo) continue;
      const result = standDown(session, contract, runtimeOptions);
      if (!result || result.success !== true) {
        failures.push({ contractID: contract.contractID, errorMsg: result && result.errorMsg });
        continue;
      }
      stoodDownCount += 1;
    }
    return {
      success: failures.length === 0,
      errorMsg: failures.length > 0 ? "INDUSTRIAL_HIRELING_STAND_DOWN_FAILED" : null,
      data: {
        enabled: true,
        inspectedCount: contracts.length,
        stoodDownCount,
        preservedCount,
        reason: String(runtimeOptions.reason || "session_detach"),
        failures,
      },
    };
  }

  return Object.freeze({
    OPERATOR_KIND,
    applyOrder,
    handleEmployerSessionDetaching,
    materializeHauler,
    materializeMiningCrew,
    materializeMiner,
    reconcileContractPresence,
    reconcileForObservedScene,
    reconcileIdentityPresence,
    reconcileForSession,
    releaseContractPresence,
    standDown,
    virtualizeForUnobservedScene,
  });
}

let defaultRuntime = null;
function getDefaultIndustrialHirelingRuntime() {
  if (!defaultRuntime) {
    defaultRuntime = createIndustrialHirelingRuntime();
  }
  return defaultRuntime;
}

module.exports = {
  OPERATOR_KIND,
  createIndustrialHirelingRuntime,
  getDefaultIndustrialHirelingRuntime,
  isNavigationAtAssignedSystem,
};
