"use strict";

const path = require("path");
const {
  getDockedLocationID,
  isDockedSession,
} = require(path.join(__dirname, "../structure/structureLocation"));
const {
  ORDER,
  ROLE,
  getDefaultContractService,
} = require("./industrialHirelingContracts");
const {
  listIndustrialMiningCrewPackages,
  resolveIndustrialMiningCrewPackage,
} = require("./industrialMiningCrewCatalog");
const {
  getDefaultIndustrialHirelingRuntime,
} = require("./industrialHirelingRuntime");
const {
  startDefaultIndustrialHirelingScheduler,
} = require("./industrialHirelingScheduler");
const {
  formatBookmarkMessage,
  removeContractBookmark,
  syncContractBookmark,
} = require("./industrialHirelingBookmarkLifecycle");

// chatCommands loads this module during normal server bootstrap. The scheduler
// performs no state I/O and creates no timer unless all relevant switches are on.
startDefaultIndustrialHirelingScheduler();

function getDefaultConfig() {
  return require(path.join(__dirname, "../../config"));
}

function buildHelpText(configArg = null) {
  const activeConfig = configArg || getDefaultConfig();
  const lines = [
    "Industrial hirelings:",
    "/hireling status",
  ];
  if (activeConfig.industrialMiningCrewsEnabled === true) {
    const crewTypeIDs = listIndustrialMiningCrewPackages()
      .map((entry) => entry.crewTypeID)
      .join("|");
    lines.push(`/hireling hire crew <${crewTypeIDs}> (while docked)`);
  }
  if (
    activeConfig.industrialMiningCrewsEnabled !== true ||
    activeConfig.industrialMiningCrewsLegacyHiringEnabled !== false
  ) {
    lines.push("/hireling hire <miner|hauler> (legacy individual contract; while docked)");
  }
  lines.push(
    "/hireling order <contract> <mine|haul|standby|home|withdraw>",
    "/hireling destination <contract> <home|current|stationID>",
    "/hireling pause <contract>",
    "/hireling resume <contract>",
    "/hireling dismiss <contract>",
  );
  return lines.join(" ");
}

const HELP_TEXT = buildHelpText();

const ORDER_ALIASES = Object.freeze({
  mine: ORDER.SUPPORT_MINING,
  mining: ORDER.SUPPORT_MINING,
  support: ORDER.SUPPORT_MINING,
  haul: ORDER.HAUL_OPERATION,
  hauling: ORDER.HAUL_OPERATION,
  collect: ORDER.HAUL_OPERATION,
  standby: ORDER.STANDBY,
  wait: ORDER.STANDBY,
  home: ORDER.RETURN_HOME,
  return: ORDER.RETURN_HOME,
  withdraw: ORDER.EMERGENCY_WITHDRAW,
  emergency: ORDER.EMERGENCY_WITHDRAW,
});

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizePositiveIntArray(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => toPositiveInt(value, 0))
      .filter(Boolean),
  )];
}

function formatContractRef(contract) {
  const serial = toPositiveInt(contract && contract.serial, 0);
  return serial > 0 ? `#${serial}` : String(contract && contract.contractID || "unknown");
}

function formatOrder(value) {
  return String(value || ORDER.STANDBY).replace(/_/g, " ");
}

function formatRemainingHours(expiresAtMs, nowMs = Date.now()) {
  const remainingMs = Math.max(0, Number(expiresAtMs) - Number(nowMs));
  if (!Number.isFinite(remainingMs)) return "unknown";
  if (remainingMs <= 60 * 60 * 1000) {
    return `${Math.max(1, Math.ceil(remainingMs / (60 * 1000)))}m`;
  }
  return `${Math.ceil(remainingMs / (60 * 60 * 1000))}h`;
}

function formatContract(contract, nowMs = Date.now()) {
  const runtimeFleetID = toPositiveInt(contract && contract.runtimeFleetID, 0);
  const contractKind = String(contract && contract.contractKind || "");
  const isMiningCrew = contractKind === "mining_crew";
  const members = Array.isArray(contract && contract.members) ? contract.members : [];
  const memberRuntimeEntityIDs = normalizePositiveIntArray(
    members.map((member) => member && member.runtimeEntityID),
  );
  const runtimeEntityIDs = normalizePositiveIntArray([
    ...(Array.isArray(contract && contract.runtimeEntityIDs)
      ? contract.runtimeEntityIDs
      : []),
    ...memberRuntimeEntityIDs,
  ]);
  const crewPackage = isMiningCrew
    ? resolveIndustrialMiningCrewPackage(contract && contract.crewTypeID)
    : null;
  const hullCount = isMiningCrew
    ? Math.max(
        toPositiveInt(contract && contract.hullCount, 0),
        members.length,
        toPositiveInt(crewPackage && crewPackage.hullCount, 0),
      )
    : 1;
  const activeWorkOrder = [ORDER.SUPPORT_MINING, ORDER.HAUL_OPERATION].includes(
    String(contract && contract.order || ""),
  );
  const parts = [
    formatContractRef(contract),
    isMiningCrew
      ? `Tier ${String(contract && contract.tierLabel || crewPackage && crewPackage.tierLabel || "?")} ${String(contract && contract.crewName || contract && contract.packageName || crewPackage && crewPackage.name || "mining crew")}`
      : String(contract && contract.role || "unknown"),
    !isMiningCrew && contract && contract.pilotName ? `pilot=${contract.pilotName}` : null,
    String(contract && contract.state || "unknown"),
    `order=${formatOrder(contract && contract.order)}`,
    `home=${toPositiveInt(contract && contract.homeStationID, 0) || "unset"}`,
    `destination=${toPositiveInt(contract && contract.destinationStationID, 0) || "unset"}`,
    isMiningCrew
      ? `present=${runtimeEntityIDs.length}/${hullCount}`
      : `runtime=${runtimeFleetID > 0 ? "deployed" : activeWorkOrder ? "not deployed" : "stood down"}`,
    `expires=${formatRemainingHours(contract && contract.expiresAtMs, nowMs)}`,
  ].filter(Boolean);
  if (isMiningCrew) {
    parts.push(`composition=${String(
      contract && contract.composition ||
      crewPackage && crewPackage.composition ||
      `${hullCount} industrial hulls`,
    )}`);
    if (runtimeFleetID <= 0 && activeWorkOrder) {
      parts.push("runtime=awaiting deployment");
    }
  }
  if (contract && contract.role === ROLE.HAULER) {
    parts.push(`cargo=${String(contract.cargoStatus || "idle").replace(/_/g, " ")}`);
    parts.push(`trips=${toPositiveInt(contract.statistics && contract.statistics.tripsCompleted, 0)}`);
  }
  return parts.join(" ");
}

function formatError(result) {
  const code = String(result && result.errorMsg || "UNKNOWN_ERROR");
  const messages = {
    INDUSTRIAL_HIRELINGS_DISABLED:
      "Industrial hirelings are disabled. The server owner must enable livingUniverseEnabled and industrialHirelingsEnabled.",
    INDUSTRIAL_HIRELING_CONTRACT_LIMIT_REACHED:
      "You already have the maximum number of active industrial hireling contracts.",
    INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND:
      "That hireling contract was not found or does not belong to you.",
    INDUSTRIAL_HIRELING_CONTRACT_NOT_ACTIVE:
      "That hireling contract is not active.",
    INDUSTRIAL_HIRELING_ORDER_NOT_SUPPORTED_FOR_ROLE:
      "That order is not supported by this hireling's role.",
    INDUSTRIAL_HIRELING_DESTINATION_REQUIRED:
      "A valid station destination is required.",
    INDUSTRIAL_HIRELING_EMPLOYER_SHIP_NOT_FOUND:
      "Undock at the mining site before ordering this hireling to work.",
    INDUSTRIAL_HIRELING_NO_OWNED_JETCAN:
      "No non-empty jetcan owned by you is within the configured pickup range.",
    INDUSTRIAL_HIRELING_JETCAN_NOT_FOUND:
      "The assigned jetcan is no longer present. Put the hireling on standby, then issue haul again.",
    INDUSTRIAL_HIRELING_DESTINATION_INVALID:
      "The delivery destination is not a known station or structure.",
    INDUSTRIAL_HIRELING_CARGO_IN_TRANSIT:
      "That contract has reserved or in-transit cargo. Let delivery finish before changing its destination or dismissing it.",
    INDUSTRIAL_HIRELING_HAULER_RUNTIME_UNAVAILABLE:
      "The server does not have the visible hauler runtime installed.",
    INDUSTRIAL_HIRELING_PHYSICAL_BUDGET_FULL:
      "The living universe is at its safe materialized-ship limit in this system. Try the order again shortly.",
    INDUSTRIAL_HIRELING_IDENTITY_CREATE_FAILED:
      "The living universe could not register this hireling's pilot identity.",
    INDUSTRIAL_MINING_CREWS_DISABLED:
      "Complete mining crews are disabled on this server.",
    INDUSTRIAL_MINING_CREW_PACKAGE_NOT_FOUND:
      "That mining crew tier does not exist. Use /hireling help to list the available crew package IDs.",
    INDUSTRIAL_HIRELING_LEGACY_HIRING_DISABLED:
      "Individual miner and hauler hires are disabled. Hire a complete crew instead.",
    INDUSTRIAL_MINING_CREW_SECURITY_RESTRICTED:
      "That crew tier is not permitted in the selected system's security class.",
  };
  return messages[code] || `Industrial hireling request failed: ${code}.`;
}

function resolveContract(service, ownerCharacterID, selector) {
  const listed = service.listForCharacter(ownerCharacterID);
  if (!listed || listed.success !== true) {
    return { success: false, result: listed };
  }
  const contracts = Array.isArray(listed.data && listed.data.contracts)
    ? listed.data.contracts
    : [];
  const normalizedSelector = String(selector || "").trim().toLowerCase();
  const numericSelector = toPositiveInt(normalizedSelector.replace(/^#/, ""), 0);
  const matches = contracts.filter((contract) => (
    String(contract.contractID || "").toLowerCase() === normalizedSelector ||
    (numericSelector > 0 && toPositiveInt(contract.serial, 0) === numericSelector) ||
    String(contract.contractID || "").toLowerCase().endsWith(normalizedSelector)
  ));
  return matches.length === 1
    ? { success: true, contract: matches[0] }
    : { success: false, ambiguous: matches.length > 1 };
}

function resolveSessionSystemID(session) {
  return toPositiveInt(
    session && session._space && session._space.systemID,
    toPositiveInt(
      session && (session.solarsystemid2 || session.solarsystemid),
      0,
    ),
  );
}

function resolveSessionShipID(session) {
  return toPositiveInt(session && session._space && session._space.shipID, 0);
}

function executeIndustrialHirelingCommand(session, argumentText = "", options = {}) {
  const service = options.contractService || getDefaultContractService();
  const hirelingRuntime = options.hirelingRuntime || getDefaultIndustrialHirelingRuntime();
  const activeConfig = options.config || getDefaultConfig();
  const serviceCrewFeatureState =
    service && typeof service.getMiningCrewFeatureState === "function"
      ? service.getMiningCrewFeatureState()
      : null;
  const crewModeEnabled = serviceCrewFeatureState
    ? serviceCrewFeatureState.crewModeEnabled === true
    : activeConfig.industrialMiningCrewsEnabled === true;
  const legacyHiringDisabled =
    crewModeEnabled &&
    activeConfig.industrialMiningCrewsLegacyHiringEnabled === false;
  const helpText = buildHelpText({
    ...activeConfig,
    industrialMiningCrewsEnabled: crewModeEnabled,
    industrialMiningCrewsLegacyHiringEnabled: legacyHiringDisabled
      ? false
      : true,
  });
  const ownerCharacterID = toPositiveInt(session && session.characterID, 0);
  if (!ownerCharacterID) {
    return { success: false, message: "Select a character before using /hireling." };
  }
  const tokens = String(argumentText || "").trim().split(/\s+/).filter(Boolean);
  const subcommand = String(tokens.shift() || "status").toLowerCase();

  if (["help", "?"].includes(subcommand)) {
    return { success: true, message: helpText };
  }

  if (["status", "list"].includes(subcommand)) {
    if (hirelingRuntime && typeof hirelingRuntime.reconcileForSession === "function") {
      hirelingRuntime.reconcileForSession(session, { nowMs: options.nowMs });
    }
    const result = service.listForCharacter(ownerCharacterID);
    if (!result || result.success !== true) {
      return { success: false, message: formatError(result) };
    }
    if (!result.data.enabled) {
      return {
        success: true,
        message:
          "Industrial hirelings are disabled. Contracts are frozen and preserved; no ships or cargo are being advanced.",
      };
    }
    const contracts = result.data.contracts || [];
    const needsRedeploy = contracts.some((contract) => (
      [ORDER.SUPPORT_MINING, ORDER.HAUL_OPERATION].includes(String(contract.order || "")) &&
      toPositiveInt(contract.runtimeFleetID, 0) <= 0 &&
      String(contract.cargoStatus || "") !== "in_transit"
    ));
    return {
      success: true,
      message: contracts.length > 0
        ? `Industrial contracts (${contracts.length}): ${contracts.map((contract) => formatContract(contract, options.nowMs)).join("; ")}` +
          (needsRedeploy ? " A working order is awaiting deployment; undock at the desired site and issue /hireling order <contract> mine or haul." : "")
        : crewModeEnabled
          ? "You have no industrial crews. Dock and use /hireling hire crew <crewTypeID>; use /hireling help to list the available tiers."
          : "You have no industrial hireling contracts. Dock and use /hireling hire miner or /hireling hire hauler.",
    };
  }

  if (subcommand === "hire") {
    const firstHireToken = String(tokens.shift() || "").toLowerCase();
    const crewTypeID = firstHireToken === "crew"
      ? String(tokens.shift() || "").toLowerCase()
      : resolveIndustrialMiningCrewPackage(firstHireToken)
        ? firstHireToken
        : "";
    const crewPackage = crewTypeID
      ? resolveIndustrialMiningCrewPackage(crewTypeID)
      : null;
    const role = crewPackage ? null : firstHireToken;
    if (crewTypeID && !crewPackage) {
      return {
        success: false,
        message: "Unknown crew package. Use /hireling help to list the available crew package IDs.",
      };
    }
    if (!crewPackage && ![ROLE.MINER, ROLE.HAULER].includes(role)) {
      return { success: false, message: helpText };
    }
    if (
      !crewPackage &&
      legacyHiringDisabled
    ) {
      return {
        success: false,
        message: "Individual pilot hiring is disabled. Use /hireling hire crew <crewTypeID>.",
      };
    }
    if (!isDockedSession(session)) {
      return {
        success: false,
        message: crewPackage
          ? "Dock before commissioning a mining crew so the contract has a home station."
          : "Dock before hiring an industrial pilot so the contract has a home station.",
      };
    }
    const result = service.hire({
      ownerCharacterID,
      ownerCorporationID: toPositiveInt(session && session.corporationID, 0),
      ownerAllianceID: toPositiveInt(
        session && (session.allianceID || session.allianceid),
        0,
      ),
      ownerWarFactionID: toPositiveInt(
        session && (session.warFactionID || session.warfactionid),
        0,
      ),
      ...(crewPackage
        ? { crewTypeID: crewPackage.crewTypeID }
        : { role }),
      homeStationID: getDockedLocationID(session),
      currentSystemID: resolveSessionSystemID(session),
    }, options.nowMs);
    let presenceResult = null;
    if (
      result &&
      result.success === true &&
      ["active", "paused"].includes(String(result.data && result.data.state || "")) &&
      typeof hirelingRuntime.reconcileContractPresence === "function"
    ) {
      presenceResult = hirelingRuntime.reconcileContractPresence(
        result.data,
        { nowMs: options.nowMs },
      );
      if (
        presenceResult &&
        presenceResult.success === true &&
        presenceResult.data &&
        presenceResult.data.contract
      ) {
        result.data = presenceResult.data.contract;
      }
    }
    return result && result.success === true
      ? {
          success: true,
          message: crewPackage
            ? `${formatContractRef(result.data)} Tier ${crewPackage.tierLabel} ${crewPackage.name} commissioned at home ${result.data.homeStationID}: ${crewPackage.composition}. Undock at the mining site, then issue /hireling order <contract> mine.`
            : `${formatContractRef(result.data)} ${role} contract created at home ${result.data.homeStationID}. ` +
              `Use /hireling order ${result.data.serial} ${role === ROLE.MINER ? "mine" : "haul"} when ready.` +
              (
                presenceResult && presenceResult.success !== true
                  ? " Pilot presence will retry automatically."
                  : ""
              ),
        }
      : { success: false, message: formatError(result) };
  }

  if (["order", "pause", "resume", "dismiss", "destination"].includes(subcommand)) {
    const selector = tokens.shift();
    if (!selector) {
      return { success: false, message: `A contract number is required. ${helpText}` };
    }
    const resolved = resolveContract(service, ownerCharacterID, selector);
    if (!resolved.success) {
      return {
        success: false,
        message: resolved.ambiguous
          ? "That contract selector matches more than one hireling. Use its full contract ID."
          : "That hireling contract was not found.",
      };
    }
    const contractID = resolved.contract.contractID;

    if (subcommand === "order") {
      const orderAlias = String(tokens.shift() || "").toLowerCase();
      const order = ORDER_ALIASES[orderAlias] || null;
      if (!order) {
        return {
          success: false,
          message: "Usage: /hireling order <contract> <mine|haul|standby|home|withdraw>",
        };
      }
      const result = service.issueOrder({
        ownerCharacterID,
        contractID,
        order,
        assignedSystemID: resolveSessionSystemID(session),
        assignedTargetID: resolveSessionShipID(session),
      }, options.nowMs);
      let runtimeMessage = "";
      let bookmarkMessage = "";
      if (result && result.success === true) {
        const runtimeResult = hirelingRuntime.applyOrder(session, result.data, {
          nowMs: options.nowMs,
        });
        if (!runtimeResult || runtimeResult.success !== true) {
          service.issueOrder({
            ownerCharacterID,
            contractID,
            order: ORDER.STANDBY,
          }, options.nowMs);
          return { success: false, message: formatError(runtimeResult) };
        }
        if (runtimeResult.data && runtimeResult.data.contract) {
          result.data = runtimeResult.data.contract;
        }
        runtimeMessage = String(runtimeResult.data && runtimeResult.data.message || "").trim();
        const bookmarkOptions = {
          bookmarkService: options.bookmarkService,
          config: options.config,
        };
        const bookmarkResult = [ORDER.RETURN_HOME, ORDER.EMERGENCY_WITHDRAW].includes(order)
          ? removeContractBookmark(resolved.contract, bookmarkOptions)
          : syncContractBookmark(result.data, bookmarkOptions);
        bookmarkMessage = formatBookmarkMessage(bookmarkResult);
      }
      return result && result.success === true
        ? {
            success: true,
            message:
              `${formatContractRef(result.data)} accepted order: ${formatOrder(result.data.order)}.` +
              (runtimeMessage ? ` ${runtimeMessage}` : "") +
              (bookmarkMessage ? ` ${bookmarkMessage}` : ""),
          }
        : { success: false, message: formatError(result) };
    }

    if (subcommand === "destination") {
      const destinationToken = String(tokens.shift() || "").toLowerCase();
      const destinationStationID = destinationToken === "home"
        ? toPositiveInt(resolved.contract.homeStationID, 0)
        : destinationToken === "current"
          ? getDockedLocationID(session)
          : toPositiveInt(destinationToken, 0);
      if (!destinationStationID) {
        return {
          success: false,
          message: "Usage: /hireling destination <contract> <home|current|stationID>. 'current' requires you to be docked.",
        };
      }
      let result = service.setDestination({
        ownerCharacterID,
        contractID,
        destinationStationID,
        commandID: options.commandID,
      }, options.nowMs);
      if (
        result &&
        result.success !== true &&
        result.errorMsg === "INDUSTRIAL_HIRELING_NAVIGATION_REQUIRES_STAND_DOWN"
      ) {
        const standDownResult = hirelingRuntime.standDown(
          session,
          resolved.contract,
          { nowMs: options.nowMs },
        );
        if (!standDownResult || standDownResult.success !== true) {
          return { success: false, message: formatError(standDownResult) };
        }
        result = service.setDestination({
          ownerCharacterID,
          contractID,
          destinationStationID,
          commandID: options.commandID,
        }, options.nowMs);
      }
      return result && result.success === true
        ? {
            success: true,
            message:
              `${formatContractRef(result.data)} is navigating to station ${destinationStationID}.`,
          }
        : { success: false, message: formatError(result) };
    }

    if (subcommand === "pause" || subcommand === "dismiss") {
      const standDownResult = hirelingRuntime.standDown(
        session,
        resolved.contract,
        { nowMs: options.nowMs },
      );
      if (!standDownResult || standDownResult.success !== true) {
        return { success: false, message: formatError(standDownResult) };
      }
    }
    const method = subcommand === "pause"
      ? service.pause
      : subcommand === "resume"
        ? service.resume
        : service.dismiss;
    const result = method({ ownerCharacterID, contractID }, options.nowMs);
    let bookmarkMessage = "";
    if (result && result.success === true) {
      if (
        subcommand === "dismiss" &&
        typeof hirelingRuntime.releaseContractPresence === "function"
      ) {
        hirelingRuntime.releaseContractPresence(result.data);
      } else if (
        ["pause", "resume"].includes(subcommand) &&
        typeof hirelingRuntime.reconcileContractPresence === "function"
      ) {
        hirelingRuntime.reconcileContractPresence(result.data, {
          nowMs: options.nowMs,
        });
      }
      const bookmarkOptions = {
        bookmarkService: options.bookmarkService,
        config: options.config,
      };
      const bookmarkResult = subcommand === "dismiss"
        ? removeContractBookmark(resolved.contract, bookmarkOptions)
        : subcommand === "resume"
          ? syncContractBookmark(result.data, bookmarkOptions)
          : null;
      bookmarkMessage = bookmarkResult ? formatBookmarkMessage(bookmarkResult) : "";
    }
    return result && result.success === true
      ? {
          success: true,
          message: subcommand === "dismiss"
            ? `${formatContractRef(resolved.contract)} dismissed. The contract is archived after safe stand-down.` +
              (bookmarkMessage ? ` ${bookmarkMessage}` : "")
            : `${formatContractRef(result.data)} is now ${result.data.state}.` +
              (bookmarkMessage ? ` ${bookmarkMessage}` : ""),
        }
      : { success: false, message: formatError(result) };
  }

  return { success: false, message: helpText };
}

module.exports = {
  HELP_TEXT,
  ORDER_ALIASES,
  buildHelpText,
  executeIndustrialHirelingCommand,
  formatContract,
  resolveContract,
};
