"use strict";

const crypto = require("crypto");
const path = require("path");
const {
  CONTRACT_KIND: MINING_CREW_CONTRACT_KIND,
  CREW_MEMBER_ROLE,
  CREW_TYPE_ID,
  INDUSTRIAL_MINING_CREW_CATALOG_REVISION,
  buildIndustrialMiningCrewQuote,
  buildIndustrialMiningCrewRoster,
  isIndustrialMiningCrewSecurityAllowed,
  resolveIndustrialMiningCrewPackage,
  resolveSecurityBand,
} = require("./industrialMiningCrewCatalog");
const {
  NAVIGATION_PHASE,
  advanceNavigation,
  buildStationaryNavigation,
  initializeContractNavigation,
  inspectCommandReplay,
  isNavigationInTransit,
  normalizeRecentCommands,
  planNavigation,
  resolveCurrentSystemID,
} = require("./industrialHirelingNavigation");

const ROLE = Object.freeze({
  MINER: "miner",
  HAULER: "hauler",
});

const CONTRACT_STATE = Object.freeze({
  ACTIVE: "active",
  PAUSED: "paused",
  DISMISSED: "dismissed",
  EXPIRED: "expired",
  LOST: "lost",
});

const ORDER = Object.freeze({
  STANDBY: "standby",
  SUPPORT_MINING: "support_mining",
  HAUL_OPERATION: "haul_operation",
  RETURN_HOME: "return_home",
  EMERGENCY_WITHDRAW: "emergency_withdraw",
});

const SHIP_IDENTITY_BASE = 8_700_000_000_000_000;
const CREW_SHIP_IDENTITY_STRIDE = 100;

const ACTIVE_STATES = Object.freeze([
  CONTRACT_STATE.ACTIVE,
  CONTRACT_STATE.PAUSED,
]);

const ORDERS_BY_ROLE = Object.freeze({
  [ROLE.MINER]: new Set([
    ORDER.STANDBY,
    ORDER.SUPPORT_MINING,
    ORDER.RETURN_HOME,
    ORDER.EMERGENCY_WITHDRAW,
  ]),
  [ROLE.HAULER]: new Set([
    ORDER.STANDBY,
    ORDER.HAUL_OPERATION,
    ORDER.RETURN_HOME,
    ORDER.EMERGENCY_WITHDRAW,
  ]),
});

function getDefaultConfig() {
  return require(path.join(__dirname, "../../config"));
}

function getDefaultStateStore() {
  return require("./industrialHirelingState").getDefaultStateStore();
}

function getDefaultSiteCatalog() {
  return require("./industrialHirelingSites").getDefaultIndustrialMiningSiteCatalog();
}

function getDefaultNavigationTopology() {
  return require(path.join(__dirname, "../market/marketTopology"));
}

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toNonNegativeInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function normalizePositiveIntArray(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => toPositiveInt(value, 0))
      .filter(Boolean),
  )];
}

function buildCrewShipIdentityID(contractSerial, slotIndex) {
  const serial = toPositiveInt(contractSerial, 0);
  const index = toNonNegativeInt(slotIndex, -1);
  if (!serial || index < 0 || index >= CREW_SHIP_IDENTITY_STRIDE) {
    return 0;
  }
  const identityID =
    SHIP_IDENTITY_BASE +
    (serial * CREW_SHIP_IDENTITY_STRIDE) +
    index +
    1;
  return Number.isSafeInteger(identityID) ? identityID : 0;
}

function isMiningCrewContract(contract) {
  return String(contract && contract.contractKind || "") === MINING_CREW_CONTRACT_KIND;
}

function clearCrewMemberRuntime(member) {
  return {
    ...member,
    runtimeEntityID: 0,
    runtimeShipItemID: 0,
    state: member && member.state === "lost" ? "lost" : "unmaterialized",
  };
}

function clearedRuntimeFields(contract) {
  return {
    runtimeFleetID: 0,
    runtimeEntityIDs: [],
    runtimeShipItemID: 0,
    ...(isMiningCrewContract(contract)
      ? {
          minerEntityIDs: [],
          supportEntityIDs: [],
          haulerEntityIDs: [],
          members: (Array.isArray(contract.members) ? contract.members : [])
            .map(clearCrewMemberRuntime),
        }
      : {}),
  };
}

function normalizeRole(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.values(ROLE).includes(normalized) ? normalized : null;
}

function normalizeHireCommandID(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized)
    ? normalized
    : null;
}

function buildHireCommandFingerprint(input = {}) {
  const payload = {
    schemaVersion: 1,
    ownerCharacterID: toPositiveInt(input.ownerCharacterID, 0),
    ownerCorporationID: toPositiveInt(input.ownerCorporationID, 0),
    homeStationID: toPositiveInt(input.homeStationID, 0),
    hireKind: input.crewTypeID ? "crew" : "legacy",
    crewTypeID: String(input.crewTypeID || "").trim().toLowerCase(),
    role: normalizeRole(input.role) || "",
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
}

function normalizeOrder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.values(ORDER).includes(normalized) ? normalized : null;
}

function normalizeCrewName(value, fallback) {
  const normalized = String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return normalized || fallback;
}

function buildMiningCrewContract(input = {}) {
  const packageDefinition = resolveIndustrialMiningCrewPackage(input.crewTypeID);
  const contractID = String(input.contractID || "").trim();
  const serial = toPositiveInt(input.serial, 0);
  if (!packageDefinition || !contractID || !serial) {
    return null;
  }
  const createdAtMs = Math.max(0, Math.trunc(Number(input.createdAtMs) || Date.now()));
  const expiresAtMs = Math.max(
    createdAtMs,
    Math.trunc(Number(input.expiresAtMs) || createdAtMs),
  );
  const quotedDoctrine = buildIndustrialMiningCrewQuote(packageDefinition.crewTypeID);
  const members = buildIndustrialMiningCrewRoster(
    packageDefinition.crewTypeID,
    {
      contractID,
      contractSerial: serial,
      buildShipIdentityID: buildCrewShipIdentityID,
    },
  );
  const crewChief = members.find((member) => member.isCrewChief) || members[0] || null;
  const aggregateStatistics = {
    oreMinedM3: 0,
    cargoHauledM3: 0,
    tripsCompleted: 0,
    hullLosses: 0,
    ...(input.statistics && typeof input.statistics === "object"
      ? cloneValue(input.statistics)
      : {}),
  };
  const pricing = cloneValue(packageDefinition.pricing);
  return {
    schemaVersion: 2,
    contractKind: MINING_CREW_CONTRACT_KIND,
    contractID,
    serial,
    ownerCharacterID: toPositiveInt(input.ownerCharacterID, 0),
    ownerCorporationID: toPositiveInt(input.ownerCorporationID, 0),
    ownerAllianceID: toPositiveInt(input.ownerAllianceID, 0),
    ownerWarFactionID: toPositiveInt(input.ownerWarFactionID, 0),
    hireCommandID: String(input.hireCommandID || ""),
    hireCommandFingerprint: String(input.hireCommandFingerprint || ""),
    role: ROLE.MINER,
    state: String(input.state || CONTRACT_STATE.ACTIVE),
    order: String(input.order || ORDER.STANDBY),
    crewTypeID: packageDefinition.crewTypeID,
    tier: packageDefinition.tier,
    tierLabel: packageDefinition.tierLabel,
    crewName: normalizeCrewName(
      input.crewName,
      `${packageDefinition.name} #${String(serial).padStart(4, "0")}`,
    ),
    packageName: packageDefinition.name,
    composition: packageDefinition.composition,
    catalogRevision: INDUSTRIAL_MINING_CREW_CATALOG_REVISION,
    quotedDoctrine,
    members,
    crewChiefSlotID: crewChief ? crewChief.slotID : null,
    homeStationID: toPositiveInt(input.homeStationID, 0),
    assignedSystemID: toPositiveInt(input.assignedSystemID, 0),
    assignedSiteID: toPositiveInt(input.assignedSiteID, 0),
    assignedTargetID: toPositiveInt(input.assignedTargetID, 0),
    destinationStationID: toPositiveInt(
      input.destinationStationID,
      toPositiveInt(input.homeStationID, 0),
    ),
    currentSystemID: toPositiveInt(input.currentSystemID, 0),
    navigation: buildStationaryNavigation({
      currentSystemID: toPositiveInt(input.currentSystemID, 0),
      stationID: toPositiveInt(input.homeStationID, 0),
      nowMs: createdAtMs,
      legDurationMs: toPositiveInt(input.navigationLegDurationMs, 30_000),
    }),
    runtimeFleetID: 0,
    runtimeEntityIDs: [],
    minerEntityIDs: [],
    supportEntityIDs: [],
    haulerEntityIDs: [],
    runtimeShipItemID: 0,
    shipTypeID: crewChief ? crewChief.shipTypeID : 0,
    shipName: null,
    pilotIdentityID: 0,
    pilotActorID: null,
    pilotName: null,
    shipIdentityID: crewChief ? crewChief.shipIdentityID : 0,
    managedDroneStock: null,
    cargoPolicy: "crew_full_hold_jetcan_cycle",
    activeManifestID: null,
    cargoStatus: "idle",
    cargoState: {
      minerHolds: {},
      sealedCans: [],
      haulerLoads: {},
      activeTrip: null,
    },
    threatState: "clear",
    lastThreatDecision: null,
    lastDeliveryAtMs: 0,
    lastDeliveryStationID: 0,
    mobilizationFeeISK: pricing.mobilizationFeeISK,
    refundableLossEscrowISK: pricing.refundableLossEscrowISK,
    activePayrollISKPerHour: pricing.activePayrollISKPerHour,
    contractBalanceISK: 0,
    paidThroughAtMs: expiresAtMs,
    createdAtMs,
    updatedAtMs: createdAtMs,
    expiresAtMs,
    revision: 1,
    statistics: aggregateStatistics,
  };
}

function convertLegacyMinerContractToVentureCrew(
  legacyContract,
  nowMs = Date.now(),
) {
  if (!legacyContract || typeof legacyContract !== "object") {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND",
    };
  }
  if (isMiningCrewContract(legacyContract)) {
    return { success: true, data: cloneValue(legacyContract), converted: false };
  }
  if (normalizeRole(legacyContract.role) !== ROLE.MINER) {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_MINING_CREW_MIGRATION_REQUIRES_MINER",
    };
  }
  const contractID = String(legacyContract.contractID || "").trim();
  const serial = toPositiveInt(legacyContract.serial, 0);
  if (!contractID || !serial) {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_ID_REQUIRED",
    };
  }
  const normalizedNowMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
  const converted = buildMiningCrewContract({
    ...legacyContract,
    contractID,
    serial,
    crewTypeID: CREW_TYPE_ID.VENTURE,
    crewName: legacyContract.crewName,
    currentSystemID: toPositiveInt(
      legacyContract.currentSystemID,
      toPositiveInt(
        legacyContract.navigation && legacyContract.navigation.currentSystemID,
        toPositiveInt(legacyContract.assignedSystemID, 0),
      ),
    ),
    createdAtMs: Math.max(
      0,
      Math.trunc(Number(legacyContract.createdAtMs) || normalizedNowMs),
    ),
    expiresAtMs: Math.max(
      normalizedNowMs,
      Math.trunc(Number(legacyContract.expiresAtMs) || normalizedNowMs),
    ),
    statistics: legacyContract.statistics,
  });
  if (!converted) {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_MINING_CREW_PACKAGE_NOT_FOUND",
    };
  }
  const preservedMember = converted.members[0];
  preservedMember.pilotIdentityID = toPositiveInt(legacyContract.pilotIdentityID, 0);
  preservedMember.pilotActorID =
    String(legacyContract.pilotActorID || "").trim() || null;
  preservedMember.pilotName =
    String(legacyContract.pilotName || "").trim() || null;
  preservedMember.shipIdentityID = toPositiveInt(
    legacyContract.shipIdentityID,
    preservedMember.shipIdentityID,
  );
  preservedMember.shipName =
    String(legacyContract.shipName || "").trim() || null;
  preservedMember.managedDroneStock = cloneValue(
    legacyContract.managedDroneStock || null,
  );
  preservedMember.statistics = {
    ...preservedMember.statistics,
    ...(legacyContract.statistics && typeof legacyContract.statistics === "object"
      ? cloneValue(legacyContract.statistics)
      : {}),
  };
  converted.pilotIdentityID = preservedMember.pilotIdentityID;
  converted.pilotActorID = preservedMember.pilotActorID;
  converted.pilotName = preservedMember.pilotName;
  converted.shipIdentityID = preservedMember.shipIdentityID;
  converted.shipName = preservedMember.shipName;
  converted.managedDroneStock = cloneValue(legacyContract.managedDroneStock || null);
  if (
    legacyContract.navigation &&
    typeof legacyContract.navigation === "object" &&
    !Array.isArray(legacyContract.navigation)
  ) {
    converted.navigation = cloneValue(legacyContract.navigation);
    converted.currentSystemID = toPositiveInt(
      legacyContract.navigation.currentSystemID,
      toPositiveInt(legacyContract.currentSystemID, 0),
    );
  }
  converted.updatedAtMs = normalizedNowMs;
  converted.revision = toPositiveInt(legacyContract.revision, 1) + 1;
  return { success: true, data: converted, converted: true };
}

function getCrewMemberBlueprints(contract) {
  const quotedSlots =
    contract &&
    contract.quotedDoctrine &&
    Array.isArray(contract.quotedDoctrine.memberSlots)
      ? contract.quotedDoctrine.memberSlots
      : null;
  if (quotedSlots && quotedSlots.length > 0) {
    return quotedSlots;
  }
  const crewPackage = resolveIndustrialMiningCrewPackage(
    contract && contract.crewTypeID,
  );
  return crewPackage ? crewPackage.memberSlots : [];
}

function normalizeCrewMembers(contract, suppliedMembers) {
  if (!isMiningCrewContract(contract)) {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_MINING_CREW_CONTRACT_REQUIRED",
    };
  }
  if (!Array.isArray(suppliedMembers)) {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_MINING_CREW_MEMBERS_REQUIRED",
    };
  }
  const blueprints = getCrewMemberBlueprints(contract);
  const currentBySlotID = new Map(
    (Array.isArray(contract.members) ? contract.members : [])
      .map((member) => [String(member && member.slotID || ""), member]),
  );
  const suppliedBySlotID = new Map();
  for (const member of suppliedMembers) {
    const slotID = String(member && member.slotID || "").trim();
    if (!slotID || suppliedBySlotID.has(slotID)) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_MINING_CREW_MEMBER_SLOT_INVALID",
      };
    }
    suppliedBySlotID.set(slotID, member);
  }
  if (
    suppliedBySlotID.size !== blueprints.length ||
    blueprints.some((blueprint) => !suppliedBySlotID.has(blueprint.slotID))
  ) {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_MINING_CREW_ROSTER_MISMATCH",
    };
  }
  const members = blueprints.map((blueprint) => {
    const current = currentBySlotID.get(blueprint.slotID) || {};
    const supplied = suppliedBySlotID.get(blueprint.slotID) || {};
    const memberID =
      String(current.memberID || "").trim() ||
      `${contract.contractID}:${blueprint.slotID}`;
    const identityKey =
      String(current.identityKey || "").trim() ||
      `${contract.contractID}:${blueprint.slotID}`;
    return {
      ...current,
      memberID,
      identityKey,
      ...cloneValue(blueprint),
      pilotIdentityID: toPositiveInt(
        supplied.pilotIdentityID,
        toPositiveInt(current.pilotIdentityID, 0),
      ),
      pilotActorID: supplied.pilotActorID === undefined
        ? String(current.pilotActorID || "").trim() || null
        : String(supplied.pilotActorID || "").trim() || null,
      pilotName: supplied.pilotName === undefined
        ? String(current.pilotName || "").trim() || null
        : String(supplied.pilotName || "").trim().slice(0, 100) || null,
      shipIdentityID: toPositiveInt(current.shipIdentityID, 0),
      shipName: supplied.shipName === undefined
        ? String(current.shipName || "").trim() || null
        : String(supplied.shipName || "").trim().slice(0, 100) || null,
      runtimeEntityID: Object.prototype.hasOwnProperty.call(supplied, "runtimeEntityID")
        ? toNonNegativeInt(supplied.runtimeEntityID, 0)
        : toPositiveInt(current.runtimeEntityID, 0),
      runtimeShipItemID: Object.prototype.hasOwnProperty.call(supplied, "runtimeShipItemID")
        ? toNonNegativeInt(supplied.runtimeShipItemID, 0)
        : toPositiveInt(current.runtimeShipItemID, 0),
      state: String(
        supplied.state === undefined
          ? current.state || "unmaterialized"
          : supplied.state || "unmaterialized",
      ).trim().slice(0, 40) || "unmaterialized",
      managedDroneStock: supplied.managedDroneStock === undefined
        ? cloneValue(current.managedDroneStock || null)
        : cloneValue(supplied.managedDroneStock || null),
      statistics:
        supplied.statistics &&
        typeof supplied.statistics === "object" &&
        !Array.isArray(supplied.statistics)
          ? cloneValue(supplied.statistics)
          : cloneValue(current.statistics || {}),
    };
  });
  const pilotIdentityIDs = members
    .map((member) => member.pilotIdentityID)
    .filter(Boolean);
  const pilotActorIDs = members
    .map((member) => String(member.pilotActorID || "").trim())
    .filter(Boolean);
  const runtimeEntityIDs = members
    .map((member) => member.runtimeEntityID)
    .filter(Boolean);
  if (
    new Set(pilotIdentityIDs).size !== pilotIdentityIDs.length ||
    new Set(pilotActorIDs).size !== pilotActorIDs.length ||
    new Set(runtimeEntityIDs).size !== runtimeEntityIDs.length
  ) {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_MINING_CREW_MEMBER_IDENTITY_COLLISION",
    };
  }
  return { success: true, data: members };
}

function createContractService(options = {}) {
  const config = options.config || getDefaultConfig();
  let stateStore = options.stateStore || null;
  let siteCatalog = options.siteCatalog || null;
  let navigationTopology = options.navigationTopology || null;

  function getStateStore() {
    if (!stateStore) {
      stateStore = getDefaultStateStore();
    }
    return stateStore;
  }

  function getSiteCatalog() {
    if (!siteCatalog) {
      siteCatalog = getDefaultSiteCatalog();
    }
    return siteCatalog;
  }

  function getNavigationTopology() {
    if (!navigationTopology) {
      navigationTopology = getDefaultNavigationTopology();
    }
    return navigationTopology;
  }

  function getNavigationLegDurationMs() {
    return Math.max(
      1_000,
      toPositiveInt(config.industrialHirelingsNavigationLegSeconds, 30) * 1_000,
    );
  }

  function initializeNavigation(contract, nowMs = Date.now()) {
    const navigation = initializeContractNavigation(contract, {
      topology: getNavigationTopology(),
      nowMs,
      legDurationMs: getNavigationLegDurationMs(),
    });
    return {
      ...contract,
      currentSystemID: toPositiveInt(
        navigation && navigation.currentSystemID,
        toPositiveInt(contract && contract.currentSystemID, 0),
      ),
      navigation,
    };
  }

  function planContractNavigation(contract, input = {}, nowMs = Date.now()) {
    return planNavigation(contract, input, {
      topology: getNavigationTopology(),
      nowMs,
      legDurationMs: getNavigationLegDurationMs(),
    });
  }

  function validateCrewSecurityAssignment(contract, systemDescription) {
    if (!isMiningCrewContract(contract)) {
      return { success: true };
    }
    const securityBand = resolveSecurityBand(systemDescription);
    if (!securityBand) {
      return { success: true, data: { securityBand: null, known: false } };
    }
    if (
      isIndustrialMiningCrewSecurityAllowed(
        contract.crewTypeID,
        securityBand,
      )
    ) {
      return { success: true, data: { securityBand, known: true } };
    }
    const crewPackage = resolveIndustrialMiningCrewPackage(contract.crewTypeID);
    return {
      success: false,
      errorMsg: "INDUSTRIAL_MINING_CREW_SECURITY_RESTRICTED",
      data: {
        crewTypeID: contract.crewTypeID,
        tier: toPositiveInt(contract.tier, 0),
        securityBand,
        allowedSecurityClasses: crewPackage
          ? [...crewPackage.security.allowedSecurityClasses]
          : [],
      },
    };
  }

  function getFeatureState(roleArg = null) {
    const role = roleArg == null ? null : normalizeRole(roleArg);
    const livingUniverseEnabled = config.livingUniverseEnabled === true;
    const masterEnabled = config.industrialHirelingsEnabled === true;
    const roleEnabled = role === ROLE.MINER
      ? config.industrialHirelingsMiningEnabled === true
      : role === ROLE.HAULER
        ? config.industrialHirelingsHaulingEnabled === true
        : true;
    return {
      enabled: livingUniverseEnabled && masterEnabled && roleEnabled,
      livingUniverseEnabled,
      masterEnabled,
      role,
      roleEnabled,
    };
  }

  function getMiningCrewFeatureState() {
    const legacyFeatureState = getFeatureState(ROLE.MINER);
    const crewModeEnabled = config.industrialMiningCrewsEnabled === true;
    return {
      ...legacyFeatureState,
      crewModeEnabled,
      enabled: legacyFeatureState.enabled && crewModeEnabled,
    };
  }

  function featureDisabledResult(roleArg = null) {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_HIRELINGS_DISABLED",
      data: getFeatureState(roleArg),
    };
  }

  function crewFeatureDisabledResult() {
    return {
      success: false,
      errorMsg: "INDUSTRIAL_MINING_CREWS_DISABLED",
      data: getMiningCrewFeatureState(),
    };
  }

  function hire(input = {}, nowMs = Date.now()) {
    const requestedCrewTypeID = String(input.crewTypeID || "").trim().toLowerCase();
    const isCrewHire = Boolean(requestedCrewTypeID);
    const crewPackage = isCrewHire
      ? resolveIndustrialMiningCrewPackage(requestedCrewTypeID)
      : null;
    const role = isCrewHire ? ROLE.MINER : normalizeRole(input.role);
    if (isCrewHire && !crewPackage) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_MINING_CREW_PACKAGE_NOT_FOUND",
      };
    }
    if (isCrewHire) {
      const crewFeatureState = getMiningCrewFeatureState();
      if (!crewFeatureState.enabled) {
        return crewFeatureDisabledResult();
      }
    } else {
      const featureState = getFeatureState(role);
      if (!featureState.enabled) {
        return featureDisabledResult(role);
      }
      if (config.industrialMiningCrewsLegacyHiringEnabled === false) {
        return {
          success: false,
          errorMsg: "INDUSTRIAL_HIRELING_LEGACY_HIRING_DISABLED",
        };
      }
    }
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    if (!ownerCharacterID || !role) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_INVALID_HIRE_REQUEST" };
    }

    const hireCommandID = normalizeHireCommandID(input.commandID);
    if (hireCommandID === null) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_HIRE_COMMAND_ID_INVALID",
      };
    }
    const hireCommandFingerprint = hireCommandID
      ? buildHireCommandFingerprint({
          ownerCharacterID,
          ownerCorporationID: input.ownerCorporationID,
          homeStationID: input.homeStationID,
          crewTypeID: crewPackage ? crewPackage.crewTypeID : "",
          role: crewPackage ? "" : role,
        })
      : "";

    const store = getStateStore();
    if (hireCommandID) {
      const matchingContracts = [
        ...store.listContracts({ ownerCharacterID }),
        ...(
          typeof store.listArchivedContracts === "function"
            ? store.listArchivedContracts({ ownerCharacterID })
            : []
        ),
      ].filter((contract) => (
        String(contract && contract.hireCommandID || "") === hireCommandID
      ));
      if (matchingContracts.length > 0) {
        const hasConflictingFingerprint = matchingContracts.some((contract) => (
          String(contract && contract.hireCommandFingerprint || "") !==
          hireCommandFingerprint
        ));
        if (hasConflictingFingerprint) {
          return {
            success: false,
            errorMsg: "INDUSTRIAL_HIRELING_HIRE_COMMAND_CONFLICT",
          };
        }
        return {
          success: true,
          replayed: true,
          data: cloneValue(matchingContracts[0]),
        };
      }
    }
    const activeContracts = store.listContracts({
      ownerCharacterID,
      states: ACTIVE_STATES,
    });
    const maxActive = Math.max(
      1,
      toPositiveInt(config.industrialHirelingsMaxActivePerCharacter, 2),
    );
    if (activeContracts.length >= maxActive) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_LIMIT_REACHED",
        data: { activeCount: activeContracts.length, maxActive },
      };
    }

    const allocated = store.allocateContractID(nowMs);
    if (!allocated || allocated.success !== true) {
      return allocated;
    }
    const contractHours = Math.max(
      1,
      toPositiveInt(config.industrialHirelingsDefaultContractHours, 24),
    );
    const normalizedNowMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    if (isCrewHire) {
      const crewContract = buildMiningCrewContract({
        ...input,
        contractID: allocated.data.contractID,
        serial: allocated.data.serial,
        crewTypeID: crewPackage.crewTypeID,
        ownerCharacterID,
        hireCommandID,
        hireCommandFingerprint,
        createdAtMs: normalizedNowMs,
        expiresAtMs: normalizedNowMs + (contractHours * 60 * 60 * 1000),
      });
      if (!crewContract) {
        return {
          success: false,
          errorMsg: "INDUSTRIAL_MINING_CREW_CONTRACT_BUILD_FAILED",
        };
      }
      const initializedCrewContract = initializeNavigation(
        crewContract,
        normalizedNowMs,
      );
      const saved = store.saveContract(initializedCrewContract);
      return saved && saved.success === true
        ? { success: true, data: cloneValue(initializedCrewContract) }
        : saved;
    }
    const contract = {
      schemaVersion: 1,
      contractID: allocated.data.contractID,
      serial: allocated.data.serial,
      ownerCharacterID,
      ownerCorporationID: toPositiveInt(input.ownerCorporationID, 0),
      ownerAllianceID: toPositiveInt(input.ownerAllianceID, 0),
      ownerWarFactionID: toPositiveInt(input.ownerWarFactionID, 0),
      hireCommandID,
      hireCommandFingerprint,
      role,
      state: CONTRACT_STATE.ACTIVE,
      order: ORDER.STANDBY,
      homeStationID: toPositiveInt(input.homeStationID, 0),
      assignedSystemID: 0,
      assignedSiteID: 0,
      assignedTargetID: 0,
      destinationStationID: toPositiveInt(input.homeStationID, 0),
      currentSystemID: 0,
      navigation: buildStationaryNavigation({
        currentSystemID: 0,
        stationID: toPositiveInt(input.homeStationID, 0),
        nowMs: normalizedNowMs,
        legDurationMs: getNavigationLegDurationMs(),
      }),
      runtimeFleetID: 0,
      runtimeEntityIDs: [],
      runtimeShipItemID: 0,
      shipTypeID: 0,
      shipName: null,
      pilotIdentityID: 0,
      pilotActorID: null,
      pilotName: null,
      shipIdentityID: SHIP_IDENTITY_BASE + allocated.data.serial,
      managedDroneStock: null,
      cargoPolicy: role === ROLE.HAULER ? "employer_owned_jetcans_only" : null,
      activeManifestID: null,
      cargoStatus: role === ROLE.HAULER ? "idle" : null,
      lastDeliveryAtMs: 0,
      lastDeliveryStationID: 0,
      createdAtMs: normalizedNowMs,
      updatedAtMs: normalizedNowMs,
      expiresAtMs: normalizedNowMs + (contractHours * 60 * 60 * 1000),
      revision: 1,
      statistics: {
        oreMinedM3: 0,
        cargoHauledM3: 0,
        tripsCompleted: 0,
        hullLosses: 0,
      },
    };
    const initializedContract = initializeNavigation(contract, normalizedNowMs);
    const saved = store.saveContract(initializedContract);
    return saved && saved.success === true
      ? { success: true, data: cloneValue(initializedContract) }
      : saved;
  }

  function listForCharacter(ownerCharacterID) {
    const featureState = getFeatureState();
    if (!featureState.livingUniverseEnabled || !featureState.masterEnabled) {
      return {
        success: true,
        data: {
          ...featureState,
          contracts: [],
        },
      };
    }
    const normalizedOwnerID = toPositiveInt(ownerCharacterID, 0);
    if (!normalizedOwnerID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_OWNER_REQUIRED" };
    }
    return {
      success: true,
      data: {
        ...featureState,
        contracts: getStateStore().listContracts({ ownerCharacterID: normalizedOwnerID }),
      },
    };
  }

  function issueOrder(input = {}, nowMs = Date.now()) {
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    const contractID = String(input.contractID || "").trim();
    const order = normalizeOrder(input.order);
    if (!ownerCharacterID || !contractID || !order) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_INVALID_ORDER" };
    }
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true
    ) {
      return featureDisabledResult();
    }
    const store = getStateStore();
    const current = store.getContract(contractID);
    if (!current || toPositiveInt(current.ownerCharacterID, 0) !== ownerCharacterID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const featureState = getFeatureState(current.role);
    if (!featureState.enabled) {
      return featureDisabledResult(current.role);
    }
    if (current.state !== CONTRACT_STATE.ACTIVE) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_ACTIVE" };
    }
    if (!ORDERS_BY_ROLE[current.role] || !ORDERS_BY_ROLE[current.role].has(order)) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_ORDER_NOT_SUPPORTED_FOR_ROLE",
      };
    }
    const hasAssignedSiteOverride = Object.prototype.hasOwnProperty.call(
      input,
      "assignedSiteID",
    );
    const clearsMiningAssignment = [
      ORDER.RETURN_HOME,
      ORDER.EMERGENCY_WITHDRAW,
    ].includes(order);
    const remoteSitesEnabled =
      config.industrialHirelingsRemoteSitesEnabled === true;
    const hasStoredSiteAssignment =
      toPositiveInt(current.assignedSiteID, 0) > 0;
    const preservesMiningAssignment =
      current.role === ROLE.MINER &&
      [ORDER.SUPPORT_MINING, ORDER.STANDBY].includes(order) &&
      !hasAssignedSiteOverride &&
      (remoteSitesEnabled || hasStoredSiteAssignment);
    const requestedSiteID = clearsMiningAssignment
      ? 0
      : preservesMiningAssignment
        ? toPositiveInt(current.assignedSiteID, 0)
        : toPositiveInt(input.assignedSiteID, 0);
    let assignedSystemID = preservesMiningAssignment
      ? toPositiveInt(current.assignedSystemID, 0)
      : toPositiveInt(input.assignedSystemID, 0);
    let assignedTargetID = preservesMiningAssignment
      ? toPositiveInt(current.assignedTargetID, requestedSiteID)
      : toPositiveInt(input.assignedTargetID, requestedSiteID);
    if (requestedSiteID > 0) {
      if (!remoteSitesEnabled && !preservesMiningAssignment) {
        return {
          success: false,
          errorMsg: "INDUSTRIAL_HIRELING_REMOTE_SITES_DISABLED",
        };
      }
      if (
        current.role !== ROLE.MINER ||
        ![ORDER.SUPPORT_MINING, ORDER.STANDBY].includes(order)
      ) {
        return {
          success: false,
          errorMsg: "INDUSTRIAL_HIRELING_SITE_REQUIRES_MINER",
        };
      }
      if (
        remoteSitesEnabled &&
        toPositiveInt(current.runtimeFleetID, 0) > 0 &&
        toPositiveInt(current.assignedSiteID, 0) !== requestedSiteID
      ) {
        return {
          success: false,
          errorMsg: "INDUSTRIAL_HIRELING_SITE_REASSIGN_REQUIRES_STAND_DOWN",
        };
      }
      if (remoteSitesEnabled) {
        const siteValidation = getSiteCatalog().validateSite(
          requestedSiteID,
          assignedSystemID,
        );
        if (!siteValidation || siteValidation.success !== true) {
          return siteValidation || {
            success: false,
            errorMsg: "INDUSTRIAL_HIRELING_SITE_NOT_FOUND",
          };
        }
        const securityValidation = validateCrewSecurityAssignment(
          current,
          siteValidation.data && siteValidation.data.systemDescription,
        );
        if (!securityValidation || securityValidation.success !== true) {
          return securityValidation;
        }
        assignedSystemID = toPositiveInt(
          siteValidation.data &&
            siteValidation.data.siteDescription &&
            siteValidation.data.siteDescription.systemID,
          0,
        );
        assignedTargetID = requestedSiteID;
      }
    } else if (clearsMiningAssignment) {
      assignedSystemID = 0;
      assignedTargetID = 0;
    }
    if (
      assignedSystemID > 0 &&
      requestedSiteID <= 0 &&
      typeof getSiteCatalog().describeSystem === "function"
    ) {
      const securityValidation = validateCrewSecurityAssignment(
        current,
        getSiteCatalog().describeSystem(assignedSystemID),
      );
      if (!securityValidation || securityValidation.success !== true) {
        return securityValidation;
      }
    }
    let plannedNavigation = null;
    if (
      input.navigateToAssignedSystem === true &&
      assignedSystemID > 0
    ) {
      plannedNavigation = planContractNavigation(current, {
        destinationSystemID: assignedSystemID,
        commandID: input.commandID,
        commandFingerprint: input.commandFingerprint,
      }, nowMs);
      if (!plannedNavigation || plannedNavigation.success !== true) {
        return plannedNavigation || {
          success: false,
          errorMsg: "INDUSTRIAL_HIRELING_ROUTE_NOT_FOUND",
        };
      }
    }
    let implicitLocalNavigation = null;
    if (
      !plannedNavigation &&
      !isNavigationInTransit(current) &&
      requestedSiteID <= 0 &&
      assignedSystemID > 0 &&
      [ORDER.SUPPORT_MINING, ORDER.HAUL_OPERATION].includes(order)
    ) {
      const previousNavigation = initializeContractNavigation(current, {
        topology: getNavigationTopology(),
        nowMs,
        legDurationMs: getNavigationLegDurationMs(),
      });
      implicitLocalNavigation = buildStationaryNavigation({
        currentSystemID: assignedSystemID,
        nowMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
        legDurationMs: getNavigationLegDurationMs(),
        phase: NAVIGATION_PHASE.ARRIVED,
        revision: toPositiveInt(previousNavigation.revision, 1) + 1,
      });
      implicitLocalNavigation.lastCommandID =
        String(previousNavigation.lastCommandID || "");
      implicitLocalNavigation.lastCommandFingerprint =
        String(previousNavigation.lastCommandFingerprint || "");
      implicitLocalNavigation.recentCommands =
        normalizeRecentCommands(previousNavigation);
    }
    const next = {
      ...current,
      order,
      assignedSystemID,
      assignedSiteID: requestedSiteID,
      assignedTargetID,
      destinationStationID: toPositiveInt(
        input.destinationStationID,
        toPositiveInt(current.destinationStationID, toPositiveInt(current.homeStationID, 0)),
      ),
      ...(plannedNavigation
        ? {
            currentSystemID: plannedNavigation.data.currentSystemID,
            navigation: plannedNavigation.data.navigation,
          }
        : implicitLocalNavigation
          ? {
              currentSystemID: implicitLocalNavigation.currentSystemID,
              navigation: implicitLocalNavigation,
            }
          : {}),
      updatedAtMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
      revision: toPositiveInt(current.revision, 1) + 1,
    };
    const saved = store.saveContract(next);
    return saved && saved.success === true
      ? { success: true, data: cloneValue(next) }
      : saved;
  }

  function listActiveContracts() {
    const featureState = getFeatureState();
    if (!featureState.livingUniverseEnabled || !featureState.masterEnabled) {
      return {
        success: true,
        data: {
          ...featureState,
          contracts: [],
        },
      };
    }
    return {
      success: true,
      data: {
        ...featureState,
        contracts: getStateStore().listContracts({ states: ACTIVE_STATES }),
      },
    };
  }

  function listForAssignedSystem(assignedSystemID) {
    const featureState = getFeatureState();
    if (!featureState.livingUniverseEnabled || !featureState.masterEnabled) {
      return {
        success: true,
        data: {
          ...featureState,
          contracts: [],
        },
      };
    }
    const normalizedSystemID = toPositiveInt(assignedSystemID, 0);
    if (!normalizedSystemID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_SYSTEM_REQUIRED" };
    }
    return {
      success: true,
      data: {
        ...featureState,
        contracts: getStateStore()
          .listContracts({ states: ACTIVE_STATES })
          .filter((contract) => (
            toPositiveInt(contract && contract.assignedSystemID, 0) === normalizedSystemID
          )),
      },
    };
  }

  function assignSite(input = {}, nowMs = Date.now()) {
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true
    ) {
      return featureDisabledResult(ROLE.MINER);
    }
    if (config.industrialHirelingsRemoteSitesEnabled !== true) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_REMOTE_SITES_DISABLED",
      };
    }
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    const contractID = String(input.contractID || "").trim();
    const assignedSiteID = toPositiveInt(input.assignedSiteID || input.siteID, 0);
    if (!ownerCharacterID || !contractID || !assignedSiteID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_SITE_REQUIRED" };
    }
    const current = getStateStore().getContract(contractID);
    if (!current || toPositiveInt(current.ownerCharacterID, 0) !== ownerCharacterID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    if (current.role !== ROLE.MINER) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_SITE_REQUIRES_MINER" };
    }
    if (current.state !== CONTRACT_STATE.ACTIVE) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_ACTIVE" };
    }
    const siteValidation = getSiteCatalog().validateSite(assignedSiteID, 0);
    if (!siteValidation || siteValidation.success !== true) {
      return siteValidation || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_SITE_NOT_FOUND",
      };
    }
    const systemID = toPositiveInt(
      siteValidation.data &&
        siteValidation.data.siteDescription &&
        siteValidation.data.siteDescription.systemID,
      0,
    );
    const commandFingerprint = `site:${assignedSiteID}:system:${systemID}`;
    const replayInspection = inspectCommandReplay(current, {
      commandID: input.commandID,
      destinationSystemID: systemID,
      commandFingerprint,
    });
    if (!replayInspection || replayInspection.success !== true) {
      return replayInspection;
    }
    if (replayInspection.replayed === true) {
      return {
        success: true,
        replayed: true,
        data: cloneValue(current),
      };
    }
    return issueOrder({
      ownerCharacterID,
      contractID,
      order: ORDER.SUPPORT_MINING,
      assignedSystemID: systemID,
      assignedSiteID,
      assignedTargetID: assignedSiteID,
      destinationStationID: current.destinationStationID,
      navigateToAssignedSystem: true,
      commandID: input.commandID,
      commandFingerprint,
    }, nowMs);
  }

  function pause(input = {}, nowMs = Date.now()) {
    return transitionOwnedContract(input, CONTRACT_STATE.PAUSED, nowMs);
  }

  function resume(input = {}, nowMs = Date.now()) {
    return transitionOwnedContract(input, CONTRACT_STATE.ACTIVE, nowMs);
  }

  function transitionOwnedContract(input, nextState, nowMs) {
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true
    ) {
      return featureDisabledResult();
    }
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    const contractID = String(input.contractID || "").trim();
    const store = getStateStore();
    const current = contractID ? store.getContract(contractID) : null;
    if (!current || toPositiveInt(current.ownerCharacterID, 0) !== ownerCharacterID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const next = {
      ...current,
      state: nextState,
      order: ORDER.STANDBY,
      ...clearedRuntimeFields(current),
      updatedAtMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
      revision: toPositiveInt(current.revision, 1) + 1,
    };
    const saved = store.saveContract(next);
    return saved && saved.success === true
      ? { success: true, data: cloneValue(next) }
      : saved;
  }

  function dismiss(input = {}, nowMs = Date.now()) {
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true
    ) {
      return featureDisabledResult();
    }
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    const contractID = String(input.contractID || "").trim();
    const store = getStateStore();
    const current = contractID ? store.getContract(contractID) : null;
    if (!current || toPositiveInt(current.ownerCharacterID, 0) !== ownerCharacterID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    if (
      String(current.activeManifestID || "").trim() &&
      ["reserved", "collecting", "in_transit", "recovery_required"]
        .includes(String(current.cargoStatus || ""))
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CARGO_IN_TRANSIT" };
    }
    const dismissed = {
      ...current,
      state: CONTRACT_STATE.DISMISSED,
      order: ORDER.RETURN_HOME,
      ...clearedRuntimeFields(current),
      updatedAtMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
      revision: toPositiveInt(current.revision, 1) + 1,
    };
    return store.archiveContract(dismissed, "dismissed", nowMs);
  }

  function setDestination(input = {}, nowMs = Date.now()) {
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true
    ) {
      return featureDisabledResult();
    }
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    const contractID = String(input.contractID || "").trim();
    const destinationStationID = toPositiveInt(input.destinationStationID, 0);
    if (!ownerCharacterID || !contractID || !destinationStationID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_DESTINATION_REQUIRED" };
    }
    const store = getStateStore();
    const current = store.getContract(contractID);
    if (!current || toPositiveInt(current.ownerCharacterID, 0) !== ownerCharacterID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const replayInspection = inspectCommandReplay(current, {
      commandID: input.commandID,
      destinationStationID,
    });
    if (!replayInspection || replayInspection.success !== true) {
      return replayInspection;
    }
    if (replayInspection.replayed === true) {
      return {
        success: true,
        replayed: true,
        data: cloneValue(current),
      };
    }
    if (
      String(current.activeManifestID || "").trim() &&
      ["reserved", "collecting", "in_transit", "recovery_required"]
        .includes(String(current.cargoStatus || ""))
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CARGO_IN_TRANSIT" };
    }
    const featureState = getFeatureState(current.role);
    if (!featureState.enabled) {
      return featureDisabledResult(current.role);
    }
    if (current.state !== CONTRACT_STATE.ACTIVE) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_ACTIVE" };
    }
    const planned = planContractNavigation(current, {
      destinationStationID,
      commandID: input.commandID,
    }, nowMs);
    if (!planned || planned.success !== true) {
      return planned || {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_ROUTE_NOT_FOUND",
      };
    }
    const hasRuntimeBinding = Boolean(
      toPositiveInt(current.runtimeFleetID, 0) > 0 ||
      normalizePositiveIntArray(current.runtimeEntityIDs).length > 0 ||
      (Array.isArray(current.members) ? current.members : [])
        .some((member) => toPositiveInt(member && member.runtimeEntityID, 0) > 0)
    );
    if (hasRuntimeBinding) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_NAVIGATION_REQUIRES_STAND_DOWN",
        data: {
          destinationStationID,
          destinationSystemID: planned.data.destinationSystemID,
          routeSystemIDs: planned.data.routeSystemIDs,
        },
      };
    }
    const next = {
      ...current,
      order: ORDER.STANDBY,
      assignedSystemID: 0,
      assignedSiteID: 0,
      assignedTargetID: 0,
      destinationStationID,
      currentSystemID: planned.data.currentSystemID,
      navigation: planned.data.navigation,
      updatedAtMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
      revision: toPositiveInt(current.revision, 1) + 1,
    };
    const saved = store.saveContract(next);
    return saved && saved.success === true
      ? { success: true, data: cloneValue(next) }
      : saved;
  }

  function setCrewMembers(input = {}, nowMs = Date.now()) {
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    const contractID = String(input.contractID || "").trim();
    if (!ownerCharacterID || !contractID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const store = getStateStore();
    const current = store.getContract(contractID);
    if (
      !current ||
      toPositiveInt(current.ownerCharacterID, 0) !== ownerCharacterID
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const normalized = normalizeCrewMembers(current, input.members);
    if (!normalized || normalized.success !== true) {
      return normalized;
    }
    const members = normalized.data;
    const crewChief =
      members.find((member) => member.isCrewChief) ||
      members[0] ||
      null;
    const next = {
      ...current,
      members,
      crewChiefSlotID: crewChief ? crewChief.slotID : null,
      pilotIdentityID: crewChief ? crewChief.pilotIdentityID : 0,
      pilotActorID: crewChief ? crewChief.pilotActorID : null,
      pilotName: crewChief ? crewChief.pilotName : null,
      shipIdentityID: crewChief ? crewChief.shipIdentityID : 0,
      shipTypeID: crewChief ? crewChief.shipTypeID : 0,
      shipName: crewChief ? crewChief.shipName : null,
      runtimeShipItemID: crewChief ? crewChief.runtimeShipItemID : 0,
      updatedAtMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
      revision: toPositiveInt(current.revision, 1) + 1,
    };
    const saved = store.saveContract(next);
    return saved && saved.success === true
      ? { success: true, data: cloneValue(next) }
      : saved;
  }

  function setCrewRuntimeBinding(input = {}, nowMs = Date.now()) {
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    const contractID = String(input.contractID || "").trim();
    if (!ownerCharacterID || !contractID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const store = getStateStore();
    const current = store.getContract(contractID);
    if (
      !current ||
      toPositiveInt(current.ownerCharacterID, 0) !== ownerCharacterID
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    if (!isMiningCrewContract(current)) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_MINING_CREW_CONTRACT_REQUIRED",
      };
    }

    let suppliedMembers = null;
    if (Array.isArray(input.members)) {
      suppliedMembers = input.members;
    } else if (Array.isArray(input.memberBindings)) {
      const updatesBySlotID = new Map();
      const updatesByMemberID = new Map();
      for (const binding of input.memberBindings) {
        const normalizedBinding = {
          ...binding,
          runtimeEntityID:
            binding && binding.runtimeEntityID !== undefined
              ? binding.runtimeEntityID
              : binding && binding.entityID,
          runtimeShipItemID:
            binding && binding.runtimeShipItemID !== undefined
              ? binding.runtimeShipItemID
              : binding && binding.shipItemID,
        };
        const slotID = String(binding && binding.slotID || "").trim();
        const memberID = String(binding && binding.memberID || "").trim();
        if (slotID) {
          updatesBySlotID.set(slotID, normalizedBinding);
        }
        if (memberID) {
          updatesByMemberID.set(memberID, normalizedBinding);
        }
      }
      suppliedMembers = (Array.isArray(current.members) ? current.members : [])
        .map((member) => ({
          ...member,
          ...(
            updatesBySlotID.get(String(member.slotID || "")) ||
            updatesByMemberID.get(String(member.memberID || "")) ||
            {}
          ),
        }));
    }

    let members;
    if (suppliedMembers) {
      const normalized = normalizeCrewMembers(current, suppliedMembers);
      if (!normalized || normalized.success !== true) {
        return normalized;
      }
      members = normalized.data;
    } else {
      members = cloneValue(Array.isArray(current.members) ? current.members : []);
    }

    const hasRoleArrays = [
      "minerEntityIDs",
      "supportEntityIDs",
      "haulerEntityIDs",
    ].some((key) => Object.prototype.hasOwnProperty.call(input, key));
    let minerEntityIDs = hasRoleArrays
      ? normalizePositiveIntArray(input.minerEntityIDs)
      : normalizePositiveIntArray(
          members
            .filter((member) => member.role === CREW_MEMBER_ROLE.MINER)
            .map((member) => member.runtimeEntityID),
        );
    let supportEntityIDs = hasRoleArrays
      ? normalizePositiveIntArray(input.supportEntityIDs)
      : normalizePositiveIntArray(
          members
            .filter((member) => member.role === CREW_MEMBER_ROLE.MINING_SUPPORT)
            .map((member) => member.runtimeEntityID),
        );
    let haulerEntityIDs = hasRoleArrays
      ? normalizePositiveIntArray(input.haulerEntityIDs)
      : normalizePositiveIntArray(
          members
            .filter((member) => member.role === CREW_MEMBER_ROLE.HAULER)
            .map((member) => member.runtimeEntityID),
        );
    const runtimeEntityIDs = [
      ...minerEntityIDs,
      ...supportEntityIDs,
      ...haulerEntityIDs,
    ];
    if (new Set(runtimeEntityIDs).size !== runtimeEntityIDs.length) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_MINING_CREW_RUNTIME_ENTITY_COLLISION",
      };
    }

    if (hasRoleArrays && suppliedMembers) {
      const allowedByRole = new Map([
        [CREW_MEMBER_ROLE.MINER, new Set(minerEntityIDs)],
        [CREW_MEMBER_ROLE.MINING_SUPPORT, new Set(supportEntityIDs)],
        [CREW_MEMBER_ROLE.HAULER, new Set(haulerEntityIDs)],
      ]);
      if (members.some((member) => (
        member.runtimeEntityID > 0 &&
        !allowedByRole.get(member.role).has(member.runtimeEntityID)
      ))) {
        return {
          success: false,
          errorMsg: "INDUSTRIAL_MINING_CREW_RUNTIME_ROLE_MISMATCH",
        };
      }
    }

    if (runtimeEntityIDs.length === 0 && !suppliedMembers) {
      members = members.map(clearCrewMemberRuntime);
      minerEntityIDs = [];
      supportEntityIDs = [];
      haulerEntityIDs = [];
    }
    const crewChief =
      members.find((member) => member.isCrewChief) ||
      members[0] ||
      null;
    const next = {
      ...current,
      members,
      runtimeFleetID: toPositiveInt(input.runtimeFleetID, 0),
      runtimeEntityIDs,
      minerEntityIDs,
      supportEntityIDs,
      haulerEntityIDs,
      runtimeShipItemID: crewChief ? crewChief.runtimeShipItemID : 0,
      updatedAtMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
      revision: toPositiveInt(current.revision, 1) + 1,
    };
    const saved = store.saveContract(next);
    return saved && saved.success === true
      ? { success: true, data: cloneValue(next) }
      : saved;
  }

  function setRuntimeBinding(input = {}, nowMs = Date.now()) {
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    const contractID = String(input.contractID || "").trim();
    if (!ownerCharacterID || !contractID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const store = getStateStore();
    const current = store.getContract(contractID);
    if (!current || toPositiveInt(current.ownerCharacterID, 0) !== ownerCharacterID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const next = {
      ...current,
      runtimeFleetID: toPositiveInt(input.runtimeFleetID, 0),
      runtimeEntityIDs: (Array.isArray(input.runtimeEntityIDs) ? input.runtimeEntityIDs : [])
        .map((value) => toPositiveInt(value, 0))
        .filter(Boolean),
      pilotIdentityID: toPositiveInt(input.pilotIdentityID, toPositiveInt(current.pilotIdentityID, 0)),
      runtimeShipItemID: toPositiveInt(input.runtimeShipItemID, 0),
      shipTypeID: toPositiveInt(input.shipTypeID, toPositiveInt(current.shipTypeID, 0)),
      shipName: input.shipName === undefined
        ? current.shipName || null
        : String(input.shipName || "").trim() || null,
      updatedAtMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
      revision: toPositiveInt(current.revision, 1) + 1,
    };
    const saved = store.saveContract(next);
    return saved && saved.success === true
      ? { success: true, data: cloneValue(next) }
      : saved;
  }

  function setPersistentIdentity(input = {}, nowMs = Date.now()) {
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    const contractID = String(input.contractID || "").trim();
    const pilotIdentityID = toPositiveInt(input.pilotIdentityID, 0);
    const pilotActorID = String(input.pilotActorID || "").trim();
    if (!ownerCharacterID || !contractID || !pilotIdentityID || !pilotActorID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_IDENTITY_REQUIRED" };
    }
    const store = getStateStore();
    const current = store.getContract(contractID);
    if (!current || toPositiveInt(current.ownerCharacterID, 0) !== ownerCharacterID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const next = {
      ...current,
      pilotIdentityID,
      pilotActorID,
      pilotName: String(input.pilotName || current.pilotName || "").trim() || null,
      updatedAtMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
      revision: toPositiveInt(current.revision, 1) + 1,
    };
    const saved = store.saveContract(next);
    return saved && saved.success === true
      ? { success: true, data: cloneValue(next) }
      : saved;
  }

  function setManagedDroneStock(input = {}, nowMs = Date.now()) {
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    const contractID = String(input.contractID || "").trim();
    if (!ownerCharacterID || !contractID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const store = getStateStore();
    const current = store.getContract(contractID);
    if (!current || toPositiveInt(current.ownerCharacterID, 0) !== ownerCharacterID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const stock = input.stock == null
      ? null
      : cloneValue(input.stock);
    if (
      stock !== null &&
      (
        typeof stock !== "object" ||
        Array.isArray(stock) ||
        !Array.isArray(stock.units)
      )
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_DRONE_STOCK_INVALID" };
    }
    const next = {
      ...current,
      managedDroneStock: stock,
      updatedAtMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
      revision: toPositiveInt(current.revision, 1) + 1,
    };
    const saved = store.saveContract(next);
    return saved && saved.success === true
      ? { success: true, data: cloneValue(next) }
      : saved;
  }

  function setCargoManifest(input = {}, nowMs = Date.now()) {
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    const contractID = String(input.contractID || "").trim();
    if (!ownerCharacterID || !contractID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const store = getStateStore();
    const current = store.getContract(contractID);
    if (
      !current ||
      toPositiveInt(current.ownerCharacterID, 0) !== ownerCharacterID ||
      current.role !== ROLE.HAULER
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const next = {
      ...current,
      activeManifestID: String(input.manifestID || "").trim() || null,
      cargoStatus: String(input.cargoStatus || "idle").trim() || "idle",
      updatedAtMs: Math.max(0, Math.trunc(Number(nowMs) || Date.now())),
      revision: toPositiveInt(current.revision, 1) + 1,
    };
    const saved = store.saveContract(next);
    return saved && saved.success === true
      ? { success: true, data: cloneValue(next) }
      : saved;
  }

  function recordHaulDelivery(input = {}, nowMs = Date.now()) {
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    const contractID = String(input.contractID || "").trim();
    if (!ownerCharacterID || !contractID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const store = getStateStore();
    const current = store.getContract(contractID);
    if (
      !current ||
      toPositiveInt(current.ownerCharacterID, 0) !== ownerCharacterID ||
      current.role !== ROLE.HAULER
    ) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const deliveredAtMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    const deliveredVolumeM3 = Math.max(0, Number(input.deliveredVolumeM3) || 0);
    const currentStatistics = current.statistics && typeof current.statistics === "object"
      ? current.statistics
      : {};
    const next = {
      ...current,
      activeManifestID: null,
      cargoStatus: "delivered",
      order: ORDER.STANDBY,
      runtimeFleetID: 0,
      runtimeEntityIDs: [],
      runtimeShipItemID: 0,
      lastDeliveryAtMs: deliveredAtMs,
      lastDeliveryStationID: toPositiveInt(input.destinationStationID, 0),
      updatedAtMs: deliveredAtMs,
      revision: toPositiveInt(current.revision, 1) + 1,
      statistics: {
        ...currentStatistics,
        cargoHauledM3: Math.max(0, Number(currentStatistics.cargoHauledM3) || 0) + deliveredVolumeM3,
        tripsCompleted: Math.max(0, toPositiveInt(currentStatistics.tripsCompleted, 0)) + 1,
      },
    };
    const saved = store.saveContract(next);
    return saved && saved.success === true
      ? { success: true, data: cloneValue(next) }
      : saved;
  }

  function recordHullLoss(input = {}, nowMs = Date.now()) {
    const ownerCharacterID = toPositiveInt(input.ownerCharacterID, 0);
    const contractID = String(input.contractID || "").trim();
    const store = getStateStore();
    const current = contractID ? store.getContract(contractID) : null;
    if (!current || toPositiveInt(current.ownerCharacterID, 0) !== ownerCharacterID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const normalizedNowMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    const currentStatistics = current.statistics && typeof current.statistics === "object"
      ? current.statistics
      : {};
    const currentDroneStock = current.managedDroneStock &&
      typeof current.managedDroneStock === "object" &&
      Array.isArray(current.managedDroneStock.units)
      ? current.managedDroneStock
      : null;
    const lostDroneStock = currentDroneStock
      ? {
          ...currentDroneStock,
          updatedAtMs: normalizedNowMs,
          countByStatus: {
            available: 0,
            deployed: 0,
            lost: currentDroneStock.units.length,
          },
          units: currentDroneStock.units.map((unit) => ({
            ...unit,
            status: "lost",
            deployedFlightID: "",
            deployedAtMs: 0,
            lostAtMs: Math.max(
              0,
              Number(unit && unit.lostAtMs) || normalizedNowMs,
            ),
            lossReason: String(
              unit && unit.lossReason || input.lossReason || "controller_destroyed",
            ),
          })),
        }
      : null;
    const next = {
      ...current,
      order: ORDER.STANDBY,
      ...clearedRuntimeFields(current),
      managedDroneStock: lostDroneStock,
      updatedAtMs: normalizedNowMs,
      revision: toPositiveInt(current.revision, 1) + 1,
      statistics: {
        ...currentStatistics,
        hullLosses: Math.max(0, toPositiveInt(currentStatistics.hullLosses, 0)) + 1,
      },
    };
    const saved = store.saveContract(next);
    return saved && saved.success === true
      ? { success: true, data: cloneValue(next) }
      : saved;
  }

  function reconcileNavigationContracts(
    contractsArg,
    nowMs,
    reconcileOptions = {},
  ) {
    const normalizedNowMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    const maxJobs = Math.max(
      1,
      toPositiveInt(
        reconcileOptions.maxJobs,
        toPositiveInt(config.industrialHirelingsMaxJobsPerPass, 4),
      ),
    );
    const allDue = (Array.isArray(contractsArg) ? contractsArg : [])
      .filter((contract) => (
        String(contract && contract.state || "") === CONTRACT_STATE.ACTIVE &&
        isNavigationInTransit(contract) &&
        Math.max(
          0,
          Math.trunc(Number(contract.navigation && contract.navigation.arrivalAtMs) || 0),
        ) <= normalizedNowMs
      ))
      .sort((left, right) => {
        const deadlineDelta =
          Number(left.navigation && left.navigation.arrivalAtMs || 0) -
          Number(right.navigation && right.navigation.arrivalAtMs || 0);
        return deadlineDelta ||
          String(left.contractID || "").localeCompare(String(right.contractID || ""));
      });
    const due = allDue.slice(0, maxJobs);
    const store = getStateStore();
    let advancedCount = 0;
    let arrivedCount = 0;
    let blockedCount = 0;
    let failedCount = 0;
    let advancedLegs = 0;
    for (const current of due) {
      const advanced = advanceNavigation(current, normalizedNowMs);
      if (!advanced || advanced.success !== true || advanced.changed !== true) {
        if (!advanced || advanced.success !== true) failedCount += 1;
        continue;
      }
      const next = {
        ...current,
        currentSystemID: toPositiveInt(
          advanced.data &&
            advanced.data.navigation &&
            advanced.data.navigation.currentSystemID,
          toPositiveInt(current.currentSystemID, 0),
        ),
        navigation: advanced.data.navigation,
        updatedAtMs: normalizedNowMs,
        revision: toPositiveInt(current.revision, 1) + 1,
      };
      const saved = store.saveContract(next);
      if (!saved || saved.success !== true) {
        failedCount += 1;
        continue;
      }
      advancedCount += 1;
      advancedLegs += Math.max(
        0,
        Math.trunc(Number(advanced.data && advanced.data.advancedLegs) || 0),
      );
      if (advanced.data && advanced.data.arrived === true) arrivedCount += 1;
      if (advanced.data && advanced.data.blocked === true) blockedCount += 1;
    }
    return {
      success: failedCount === 0,
      errorMsg: failedCount > 0
        ? "INDUSTRIAL_HIRELING_NAVIGATION_RECONCILE_FAILED"
        : null,
      data: {
        enabled: true,
        dueCount: allDue.length,
        processedCount: due.length,
        advancedCount,
        advancedLegs,
        arrivedCount,
        blockedCount,
        failedCount,
        hasMore: allDue.length > due.length,
      },
    };
  }

  function reconcileNavigation(nowMs = Date.now(), reconcileOptions = {}) {
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true
    ) {
      return {
        success: true,
        data: {
          enabled: false,
          dueCount: 0,
          processedCount: 0,
          advancedCount: 0,
          advancedLegs: 0,
          arrivedCount: 0,
          blockedCount: 0,
          failedCount: 0,
          hasMore: false,
        },
      };
    }
    return reconcileNavigationContracts(
      getStateStore().listContracts({ states: ACTIVE_STATES }),
      nowMs,
      reconcileOptions,
    );
  }

  function reconcileExpired(nowMs = Date.now(), reconcileOptions = {}) {
    if (
      config.livingUniverseEnabled !== true ||
      config.industrialHirelingsEnabled !== true
    ) {
      return {
        success: true,
        data: { enabled: false, expiredCount: 0, deferredCount: 0, failedCount: 0 },
      };
    }
    const normalizedNowMs = Math.max(0, Math.trunc(Number(nowMs) || Date.now()));
    const store = getStateStore();
    const maxJobs = Math.max(
      1,
      toPositiveInt(
        reconcileOptions.maxJobs,
        toPositiveInt(config.industrialHirelingsMaxJobsPerPass, 4),
      ),
    );
    const activeContracts = store.listContracts({ states: ACTIVE_STATES });
    // Navigation shares this existing five-second contract lifecycle pass. This
    // avoids a second timer and a second full contract-table read.
    const navigationResult = reconcileNavigationContracts(
      activeContracts,
      normalizedNowMs,
      { maxJobs },
    );
    const due = activeContracts
      .filter((contract) => Math.max(0, Number(contract.expiresAtMs) || 0) <= normalizedNowMs)
      .slice(0, maxJobs);
    let expiredCount = 0;
    let deferredCount = 0;
    let failedCount = 0;
    for (const current of due) {
      // Navigation may have advanced (or arrived) earlier in this same lifecycle
      // pass. Always make the expiry decision from the latest durable contract,
      // not from the pre-navigation list snapshot.
      const latest = store.getContract(current.contractID);
      if (
        !latest ||
        !ACTIVE_STATES.includes(String(latest.state || ""))
      ) {
        continue;
      }
      // A route accepted while the contract was active remains an obligation
      // after its paid-through time. Let it reach its destination before stand
      // down and archival so it cannot be stranded permanently in transit.
      if (isNavigationInTransit(latest)) {
        deferredCount += 1;
        continue;
      }
      if (
        String(latest.activeManifestID || "").trim() &&
        ["reserved", "collecting", "in_transit", "recovery_required"]
          .includes(String(latest.cargoStatus || ""))
      ) {
        deferredCount += 1;
        continue;
      }
      if (typeof reconcileOptions.beforeArchive === "function") {
        const standDownResult = reconcileOptions.beforeArchive(latest, normalizedNowMs);
        if (!standDownResult || standDownResult.success !== true) {
          failedCount += 1;
          continue;
        }
      }
      const expired = {
        ...latest,
        state: CONTRACT_STATE.EXPIRED,
        order: ORDER.RETURN_HOME,
        ...clearedRuntimeFields(latest),
        updatedAtMs: normalizedNowMs,
        revision: toPositiveInt(latest.revision, 1) + 1,
      };
      const result = store.archiveContract(expired, "expired", normalizedNowMs);
      if (result && result.success === true) {
        expiredCount += 1;
        if (typeof reconcileOptions.afterArchive === "function") {
          reconcileOptions.afterArchive(expired, normalizedNowMs);
        }
      } else {
        failedCount += 1;
      }
    }
    return {
      success: Boolean(
        navigationResult &&
        navigationResult.success === true &&
        failedCount === 0
      ),
      errorMsg:
        navigationResult && navigationResult.success !== true
          ? navigationResult.errorMsg
          : failedCount > 0
            ? "INDUSTRIAL_HIRELING_EXPIRY_RECONCILE_FAILED"
            : null,
      data: {
        enabled: true,
        expiredCount,
        deferredCount,
        failedCount,
        navigation: navigationResult && navigationResult.data || null,
      },
    };
  }

  return Object.freeze({
    assignSite,
    dismiss,
    getFeatureState,
    getMiningCrewFeatureState,
    hire,
    issueOrder,
    listActiveContracts,
    listForCharacter,
    listForAssignedSystem,
    pause,
    reconcileExpired,
    reconcileNavigation,
    recordHullLoss,
    resume,
    recordHaulDelivery,
    setDestination,
    setCargoManifest,
    setCrewMembers,
    setCrewRuntimeBinding,
    setManagedDroneStock,
    setPersistentIdentity,
    setRuntimeBinding,
  });
}

let defaultService = null;
function getDefaultContractService() {
  if (!defaultService) {
    defaultService = createContractService();
  }
  return defaultService;
}

module.exports = {
  ACTIVE_STATES,
  CONTRACT_STATE,
  ORDER,
  ORDERS_BY_ROLE,
  ROLE,
  SHIP_IDENTITY_BASE,
  CREW_SHIP_IDENTITY_STRIDE,
  MINING_CREW_CONTRACT_KIND,
  buildCrewShipIdentityID,
  buildMiningCrewContract,
  convertLegacyMinerContractToVentureCrew,
  createContractService,
  getDefaultContractService,
  normalizeOrder,
  normalizeRole,
  isMiningCrewContract,
};
