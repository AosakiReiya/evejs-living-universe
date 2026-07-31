"use strict";

const path = require("path");

const ACTOR_NUMBER_BASE = 5_000_000;
const ACTOR_NUMBER_MAX = 9_999_999;
const CREW_ACTOR_NUMBER_BASE = 7_000_000;
const CREW_ACTOR_STRIDE = 32;
const CREW_SHIP_IDENTITY_BASE = 8_800_000_000_000_000;
const PILOT_SOURCE_ID = "industrial_hirelings";

function getDefaultPilotDirectory() {
  return require(path.join(
    __dirname,
    "../../space/npc/ambientTraffic/livingUniversePilotDirectory",
  ));
}

function getDefaultContractService() {
  return require("./industrialHirelingContracts").getDefaultContractService();
}

function getDefaultChatRuntime() {
  return require(path.join(__dirname, "../../_secondary/chat/chatRuntime"));
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

function getContractSystemID(contract) {
  return toPositiveInt(
    contract && contract.navigation && contract.navigation.currentSystemID,
    toPositiveInt(
      contract && contract.currentSystemID,
      toPositiveInt(contract && contract.assignedSystemID, 0),
    ),
  );
}

function createIndustrialHirelingIdentityService(options = {}) {
  const pilotDirectory = options.pilotDirectory || getDefaultPilotDirectory();
  const contractService = options.contractService || getDefaultContractService();
  let chatRuntime = options.chatRuntime || null;

  function publishPilotChanges(syncResult) {
    const pilots = Array.isArray(syncResult && syncResult.pilots)
      ? syncResult.pilots
      : [];
    if (pilots.length <= 0) return;
    if (!chatRuntime) chatRuntime = getDefaultChatRuntime();
    if (
      chatRuntime &&
      typeof chatRuntime.upsertSyntheticLocalMembers === "function"
    ) {
      chatRuntime.upsertSyntheticLocalMembers(pilots, {
        sourceID: PILOT_SOURCE_ID,
      });
    }
    if (
      chatRuntime &&
      typeof chatRuntime.upsertSyntheticCorporationMembers === "function"
    ) {
      chatRuntime.upsertSyntheticCorporationMembers(pilots, {
        sourceID: PILOT_SOURCE_ID,
      });
    }
  }

  function buildActorNumber(contract) {
    const serial = toPositiveInt(contract && contract.serial, 0);
    const actorNumber = ACTOR_NUMBER_BASE + serial;
    return actorNumber <= ACTOR_NUMBER_MAX ? actorNumber : 0;
  }

  function buildActorID(contract) {
    const actorNumber = buildActorNumber(contract);
    return actorNumber > 0
      ? `industrial_hireling_actor_${String(actorNumber).padStart(7, "0")}`
      : null;
  }

  function buildCrewActorNumber(contract, member = {}, memberIndex = 0) {
    const persistedActorNumber = toPositiveInt(
      String(member.pilotActorID || "").match(/(\d+)$/)?.[1],
      0,
    );
    if (
      persistedActorNumber >= ACTOR_NUMBER_BASE &&
      persistedActorNumber <= ACTOR_NUMBER_MAX
    ) {
      return persistedActorNumber;
    }
    const serial = toPositiveInt(contract && contract.serial, 0);
    const slotIndex = Math.max(
      0,
      Math.trunc(Number(member.slotIndex) || Number(memberIndex) || 0),
    );
    if (!serial || slotIndex >= CREW_ACTOR_STRIDE) return 0;
    const actorNumber =
      CREW_ACTOR_NUMBER_BASE +
      ((serial - 1) * CREW_ACTOR_STRIDE) +
      slotIndex;
    return actorNumber <= ACTOR_NUMBER_MAX ? actorNumber : 0;
  }

  function buildCrewActorID(contract, member = {}, memberIndex = 0) {
    const persistedActorID = String(member.pilotActorID || "").trim();
    const persistedActorNumber = toPositiveInt(
      persistedActorID.match(/(\d+)$/)?.[1],
      0,
    );
    if (
      persistedActorID &&
      persistedActorNumber >= ACTOR_NUMBER_BASE &&
      persistedActorNumber <= ACTOR_NUMBER_MAX
    ) {
      return persistedActorID;
    }
    const actorNumber = buildCrewActorNumber(contract, member, memberIndex);
    return actorNumber > 0
      ? `industrial_crew_actor_${String(actorNumber).padStart(7, "0")}`
      : null;
  }

  function buildCrewShipIdentityID(contract, member = {}, memberIndex = 0) {
    const persisted = toPositiveInt(member.shipIdentityID, 0);
    if (persisted) return persisted;
    const actorNumber = buildCrewActorNumber(contract, member, memberIndex);
    if (!actorNumber) return 0;
    const identity = CREW_SHIP_IDENTITY_BASE + actorNumber;
    return Number.isSafeInteger(identity) ? identity : 0;
  }

  function buildCrewActor(contract, member, memberIndex, presence = {}) {
    const actorNumber = buildCrewActorNumber(contract, member, memberIndex);
    const actorID = buildCrewActorID(contract, member, memberIndex);
    if (!actorNumber || !actorID) return null;
    const corporationID = toPositiveInt(contract.ownerCorporationID, 1000035);
    const systemID = toPositiveInt(
      presence.systemID,
      getContractSystemID(contract),
    );
    return {
      actorID,
      profileID: String(member.profileID || "").trim() || undefined,
      role: String(member.role || "miner"),
      corporationID,
      allianceID: toPositiveInt(contract.ownerAllianceID, 0),
      warFactionID: toPositiveInt(contract.ownerWarFactionID, 0),
      homeStationID: toPositiveInt(contract.homeStationID, 0),
      currentSystemID: systemID,
      currentAssignment: String(contract.order || "standby"),
      pilot: toPositiveInt(member.pilotIdentityID, 0) > 0
        ? {
            characterID: toPositiveInt(member.pilotIdentityID, 0),
            characterName: String(member.pilotName || "").trim() || undefined,
          }
        : undefined,
    };
  }

  function ensureCrewIdentities(contract, presence = {}, nowMs = Date.now()) {
    if (!contract || !contract.contractID || !isMiningCrewContract(contract)) {
      return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_CONTRACT_NOT_FOUND" };
    }
    const members = Array.isArray(contract.members) ? contract.members : [];
    if (members.length <= 0 || members.length > CREW_ACTOR_STRIDE) {
      return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_ROSTER_INVALID" };
    }
    if (typeof contractService.setCrewMembers !== "function") {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_MINING_CREW_IDENTITY_PERSISTENCE_UNAVAILABLE",
      };
    }
    const actors = [];
    const actorIDs = new Set();
    const shipIdentityIDs = new Set();
    for (let index = 0; index < members.length; index += 1) {
      const actor = buildCrewActor(contract, members[index], index, presence);
      const shipIdentityID = buildCrewShipIdentityID(contract, members[index], index);
      if (
        !actor ||
        !shipIdentityID ||
        actorIDs.has(actor.actorID) ||
        shipIdentityIDs.has(shipIdentityID)
      ) {
        return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_IDENTITY_COLLISION" };
      }
      actorIDs.add(actor.actorID);
      shipIdentityIDs.add(shipIdentityID);
      actors.push(actor);
    }
    const corporationID = toPositiveInt(contract.ownerCorporationID, 1000035);
    const systemID = toPositiveInt(
      presence.systemID,
      getContractSystemID(contract),
    );
    const directorySync = pilotDirectory.syncActorChanges(actors, {
      sourceID: PILOT_SOURCE_ID,
      getProfile() {
        return {
          corporationID,
          allianceID: toPositiveInt(contract.ownerAllianceID, 0),
          warFactionID: toPositiveInt(contract.ownerWarFactionID, 0),
          factionID: 0,
          raceID: 1,
        };
      },
      resolvePresence() {
        const stationID = toPositiveInt(presence.stationID, 0);
        return {
          solarSystemID: systemID,
          stationID: stationID || null,
          localVisible: presence.localVisible !== false && systemID > 0,
          corporationChatVisible: presence.corporationChatVisible !== false,
          state: String(
            presence.state ||
            (stationID ? "docked_online" : "in_space_materialized"),
          ),
          assignment: String(contract.order || "standby"),
        };
      },
    });
    const memberIdentities = [];
    const nextMembers = [];
    for (let index = 0; index < members.length; index += 1) {
      const actor = actors[index];
      const pilot = actor && actor.pilot && actor.pilot.characterID
        ? pilotDirectory.getPilotRecord(actor.pilot.characterID)
        : null;
      if (!pilot) {
        return { success: false, errorMsg: "INDUSTRIAL_MINING_CREW_IDENTITY_CREATE_FAILED" };
      }
      const member = members[index];
      const shipIdentityID = buildCrewShipIdentityID(contract, member, index);
      const shipName = String(member.shipName || "").trim() ||
        `${pilot.characterName}'s ${String(member.shipTypeName || "industrial ship").trim()}`;
      const nextMember = {
        ...cloneValue(member),
        pilotIdentityID: pilot.characterID,
        pilotActorID: actor.actorID,
        pilotName: pilot.characterName,
        shipIdentityID,
        shipName,
      };
      nextMembers.push(nextMember);
      memberIdentities.push({
        member: cloneValue(nextMember),
        actor: cloneValue(actor),
        actorID: actor.actorID,
        pilot: cloneValue(pilot),
        shipIdentityID,
        shipName,
      });
    }
    const saved = JSON.stringify(nextMembers) === JSON.stringify(members)
      ? { success: true, data: cloneValue(contract) }
      : contractService.setCrewMembers({
          ownerCharacterID: contract.ownerCharacterID,
          contractID: contract.contractID,
          members: nextMembers,
        }, nowMs);
    if (!saved || saved.success !== true) return saved;
    const persistedMembers = Array.isArray(saved.data && saved.data.members)
      ? saved.data.members
      : nextMembers;
    const persistedPilotIDs = persistedMembers.map((member) =>
      toPositiveInt(member && member.pilotIdentityID, 0));
    const persistedActorIDs = persistedMembers.map((member) =>
      String(member && member.pilotActorID || "").trim());
    const persistedShipIDs = persistedMembers.map((member) =>
      toPositiveInt(member && member.shipIdentityID, 0));
    if (
      persistedMembers.length !== members.length ||
      persistedPilotIDs.some((value) => !value) ||
      persistedActorIDs.some((value) => !value) ||
      persistedShipIDs.some((value) => !value) ||
      new Set(persistedPilotIDs).size !== persistedMembers.length ||
      new Set(persistedActorIDs).size !== persistedMembers.length ||
      new Set(persistedShipIDs).size !== persistedMembers.length
    ) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_MINING_CREW_IDENTITY_PERSISTENCE_FAILED",
      };
    }
    publishPilotChanges(directorySync);
    return {
      success: true,
      data: {
        contract: saved.data,
        members: cloneValue(persistedMembers),
        memberIdentities: memberIdentities.map((identity, index) => ({
          ...identity,
          member: cloneValue(persistedMembers[index] || identity.member),
        })),
      },
    };
  }

  function ensureIdentity(contract, presence = {}, nowMs = Date.now()) {
    if (!contract || !contract.contractID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_FOUND" };
    }
    const actorNumber = buildActorNumber(contract);
    const actorID = buildActorID(contract);
    if (!actorNumber || !actorID) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_IDENTITY_RANGE_EXHAUSTED" };
    }
    const corporationID = toPositiveInt(contract.ownerCorporationID, 1000035);
    const systemID = toPositiveInt(
      presence.systemID,
      getContractSystemID(contract),
    );
    const stationID = toPositiveInt(presence.stationID, 0);
    const actor = {
      actorID,
      role: String(contract.role || "hauler"),
      corporationID,
      allianceID: toPositiveInt(contract.ownerAllianceID, 0),
      warFactionID: toPositiveInt(contract.ownerWarFactionID, 0),
      homeStationID: toPositiveInt(contract.homeStationID, 0),
      currentSystemID: systemID,
      currentAssignment: String(contract.order || "standby"),
      pilot: toPositiveInt(contract.pilotIdentityID, 0) > 0
        ? {
            characterID: toPositiveInt(contract.pilotIdentityID, 0),
            characterName: String(contract.pilotName || "").trim() || undefined,
          }
        : undefined,
    };
    const directorySync = pilotDirectory.syncActorChanges([actor], {
      sourceID: PILOT_SOURCE_ID,
      getProfile() {
        return {
          corporationID,
          allianceID: toPositiveInt(contract.ownerAllianceID, 0),
          warFactionID: toPositiveInt(contract.ownerWarFactionID, 0),
          factionID: 0,
          raceID: 1,
        };
      },
      resolvePresence() {
        return {
          solarSystemID: systemID,
          stationID: stationID || null,
          localVisible: presence.localVisible !== false && systemID > 0,
          corporationChatVisible: presence.corporationChatVisible !== false,
          state: String(
            presence.state ||
            (stationID ? "docked_online" : "in_space_materialized"),
          ),
          assignment: String(contract.order || "standby"),
        };
      },
    });
    const pilot = actor.pilot && actor.pilot.characterID
      ? pilotDirectory.getPilotRecord(actor.pilot.characterID)
      : null;
    if (!pilot) {
      return { success: false, errorMsg: "INDUSTRIAL_HIRELING_IDENTITY_CREATE_FAILED" };
    }
    const identityUnchanged =
      toPositiveInt(contract.pilotIdentityID, 0) === pilot.characterID &&
      String(contract.pilotActorID || "") === actorID &&
      String(contract.pilotName || "") === pilot.characterName;
    const saved = identityUnchanged
      ? { success: true, data: cloneValue(contract) }
      : contractService.setPersistentIdentity({
          ownerCharacterID: contract.ownerCharacterID,
          contractID: contract.contractID,
          pilotIdentityID: pilot.characterID,
          pilotActorID: actorID,
          pilotName: pilot.characterName,
        }, nowMs);
    if (!saved || saved.success !== true) return saved;
    publishPilotChanges(directorySync);
    return {
      success: true,
      data: {
        actor,
        actorID,
        pilot,
        contract: saved.data,
      },
    };
  }

  function markInSpace(contract, systemID, nowMs = Date.now()) {
    return ensureIdentity(contract, { systemID, localVisible: true }, nowMs);
  }

  function markDocked(contract, nowMs = Date.now()) {
    return ensureIdentity(contract, {
      systemID: toPositiveInt(
        contract && contract.navigation && contract.navigation.currentSystemID,
        toPositiveInt(
          contract && contract.currentSystemID,
          toPositiveInt(contract && contract.assignedSystemID, 0),
        ),
      ),
      stationID: toPositiveInt(contract && contract.homeStationID, 0),
      localVisible: true,
      corporationChatVisible: true,
      state: "docked_online",
    }, nowMs);
  }

  function markCrewInSpace(contract, systemID, nowMs = Date.now()) {
    return ensureCrewIdentities(contract, { systemID, localVisible: true }, nowMs);
  }

  function markCrewDocked(contract, nowMs = Date.now()) {
    return ensureCrewIdentities(contract, {
      systemID: toPositiveInt(
        contract && contract.navigation && contract.navigation.currentSystemID,
        toPositiveInt(
          contract && contract.currentSystemID,
          toPositiveInt(contract && contract.assignedSystemID, 0),
        ),
      ),
      stationID: toPositiveInt(contract && contract.homeStationID, 0),
      localVisible: true,
      corporationChatVisible: true,
      state: "docked_online",
    }, nowMs);
  }

  function ensureContractPresence(contract, nowMs = Date.now()) {
    if (!contract || !["active", "paused"].includes(String(contract.state || ""))) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_CONTRACT_NOT_ACTIVE",
      };
    }
    const systemID = getContractSystemID(contract);
    if (!systemID) {
      return {
        success: false,
        errorMsg: "INDUSTRIAL_HIRELING_CURRENT_SYSTEM_UNKNOWN",
      };
    }
    const runtimeEntityIDs = [
      ...(Array.isArray(contract.runtimeEntityIDs) ? contract.runtimeEntityIDs : []),
      ...(Array.isArray(contract.members)
        ? contract.members.map((member) => member && member.runtimeEntityID)
        : []),
    ].map((value) => toPositiveInt(value, 0)).filter(Boolean);
    const materialized = runtimeEntityIDs.length > 0;
    const navigationPhase = String(
      contract.navigation && contract.navigation.phase || "",
    );
    const order = String(contract.order || "standby");
    const docked = !materialized && (
      String(contract.state || "") === "paused" ||
      (
        order === "standby" &&
        navigationPhase !== "in_transit"
      )
    );
    const stationID = docked
      ? toPositiveInt(
          contract.navigation && contract.navigation.destinationStationID,
          toPositiveInt(contract.homeStationID, 0),
        )
      : 0;
    const presence = {
      systemID,
      stationID,
      localVisible: true,
      corporationChatVisible: true,
      state: materialized
        ? "in_space_materialized"
        : docked
          ? "docked_online"
          : "in_space_virtual",
    };
    return isMiningCrewContract(contract)
      ? ensureCrewIdentities(contract, presence, nowMs)
      : ensureIdentity(contract, presence, nowMs);
  }

  function syncActiveContractPresence(contracts = [], nowMs = Date.now()) {
    const activeContracts = (Array.isArray(contracts) ? contracts : [])
      .filter((contract) => (
        contract &&
        ["active", "paused"].includes(String(contract.state || ""))
      ));
    const pilots = [];
    const failures = [];
    for (const contract of activeContracts) {
      const result = ensureContractPresence(contract, nowMs);
      if (!result || result.success !== true) {
        failures.push({
          contractID: String(contract.contractID || ""),
          errorMsg: String(
            result && result.errorMsg ||
            "INDUSTRIAL_HIRELING_IDENTITY_RECONCILE_FAILED",
          ),
        });
        continue;
      }
      if (isMiningCrewContract(contract)) {
        for (const identity of result.data && result.data.memberIdentities || []) {
          if (identity && identity.pilot) pilots.push(identity.pilot);
        }
      } else if (result.data && result.data.pilot) {
        pilots.push(result.data.pilot);
      }
    }
    if (failures.length === 0) {
      const activeCharacterIDs = new Set(
        pilots.map((pilot) => toPositiveInt(pilot && pilot.characterID, 0)).filter(Boolean),
      );
      let staleCharacterIDs = [];
      if (
        typeof pilotDirectory.listPilots === "function" &&
        typeof pilotDirectory.removePilots === "function"
      ) {
        staleCharacterIDs = pilotDirectory.listPilots()
          .filter((pilot) => (
            String(pilot && pilot.pilotSourceID || "") === PILOT_SOURCE_ID &&
            !activeCharacterIDs.has(toPositiveInt(pilot.characterID, 0))
          ))
          .map((pilot) => toPositiveInt(pilot.characterID, 0))
          .filter(Boolean);
      }
      if (!chatRuntime) chatRuntime = getDefaultChatRuntime();
      if (
        chatRuntime &&
        typeof chatRuntime.syncSyntheticLocalMembers === "function"
      ) {
        chatRuntime.syncSyntheticLocalMembers(pilots, {
          sourceID: PILOT_SOURCE_ID,
        });
      }
      if (
        chatRuntime &&
        typeof chatRuntime.syncSyntheticCorporationMembers === "function"
      ) {
        chatRuntime.syncSyntheticCorporationMembers(pilots, {
          sourceID: PILOT_SOURCE_ID,
        });
      }
      // Keep the directory identities available until both chat projections
      // have emitted their leave stanzas. XMPP uses that directory to serialize
      // the departing pilot's name and corporation; removing it first produces
      // an invalid corporation-zero presence packet.
      if (staleCharacterIDs.length > 0) {
        pilotDirectory.removePilots(staleCharacterIDs, {
          sourceID: PILOT_SOURCE_ID,
        });
      }
    }
    return {
      success: failures.length === 0,
      errorMsg: failures.length > 0
        ? "INDUSTRIAL_HIRELING_IDENTITY_RECONCILE_FAILED"
        : null,
      data: {
        inspectedCount: activeContracts.length,
        pilotCount: pilots.length,
        failureCount: failures.length,
        failures,
      },
    };
  }

  function releaseContractPresence(contract) {
    const characterIDs = isMiningCrewContract(contract)
      ? (Array.isArray(contract && contract.members) ? contract.members : [])
          .map((member) => toPositiveInt(member && member.pilotIdentityID, 0))
          .filter(Boolean)
      : [toPositiveInt(contract && contract.pilotIdentityID, 0)].filter(Boolean);
    if (!chatRuntime) chatRuntime = getDefaultChatRuntime();
    if (
      chatRuntime &&
      typeof chatRuntime.removeSyntheticPilotMembers === "function"
    ) {
      chatRuntime.removeSyntheticPilotMembers(characterIDs, {
        sourceID: PILOT_SOURCE_ID,
      });
    } else if (
      chatRuntime &&
      typeof chatRuntime.upsertSyntheticLocalMembers === "function"
    ) {
      chatRuntime.upsertSyntheticLocalMembers(
        characterIDs.map((characterID) => ({
          characterID,
          localVisible: false,
          corporationChatVisible: false,
        })),
        { sourceID: PILOT_SOURCE_ID },
      );
    }
    const removed = typeof pilotDirectory.removePilots === "function"
      ? pilotDirectory.removePilots(characterIDs, { sourceID: PILOT_SOURCE_ID })
      : { removedCharacterIDs: [] };
    return {
      success: true,
      data: {
        releasedCharacterIDs: characterIDs,
        removedCharacterIDs: Array.isArray(removed && removed.removedCharacterIDs)
          ? removed.removedCharacterIDs
          : [],
      },
    };
  }

  return Object.freeze({
    ACTOR_NUMBER_BASE,
    ACTOR_NUMBER_MAX,
    CREW_ACTOR_NUMBER_BASE,
    CREW_ACTOR_STRIDE,
    CREW_SHIP_IDENTITY_BASE,
    buildActorID,
    buildActorNumber,
    buildCrewActorID,
    buildCrewActorNumber,
    buildCrewShipIdentityID,
    ensureCrewIdentities,
    ensureContractPresence,
    ensureIdentity,
    markCrewDocked,
    markCrewInSpace,
    markDocked,
    markInSpace,
    releaseContractPresence,
    syncActiveContractPresence,
  });
}

let defaultService = null;
function getDefaultIndustrialHirelingIdentityService() {
  if (!defaultService) defaultService = createIndustrialHirelingIdentityService();
  return defaultService;
}

module.exports = {
  ACTOR_NUMBER_BASE,
  ACTOR_NUMBER_MAX,
  CREW_ACTOR_NUMBER_BASE,
  CREW_ACTOR_STRIDE,
  CREW_SHIP_IDENTITY_BASE,
  PILOT_SOURCE_ID,
  createIndustrialHirelingIdentityService,
  getDefaultIndustrialHirelingIdentityService,
};
