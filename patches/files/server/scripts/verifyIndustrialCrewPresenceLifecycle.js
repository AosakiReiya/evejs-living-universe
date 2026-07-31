"use strict";

process.env.EVEJS_SKIP_NPC_STARTUP = "1";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";

const assert = require("assert");
const path = require("path");

const pilotDirectory = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingUniversePilotDirectory",
));
const chatRuntime = require(path.join(
  __dirname,
  "../src/_secondary/chat/chatRuntime",
));
const {
  PILOT_SOURCE_ID,
  createIndustrialHirelingIdentityService,
} = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialHirelingIdentity",
));
const {
  CREW_TYPE_ID,
  buildIndustrialMiningCrewRoster,
} = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialMiningCrewCatalog",
));

const AMBIENT_SOURCE_ID = "ambient_living_universe";
const HOME_SYSTEM_ID = 30000142;
const TRANSIT_SYSTEM_ID = 30000144;
const AMBIENT_SYSTEM_ID = 30000120;
const OWNER_CHARACTER_ID = 2_100_000_001;
const OWNER_CORPORATION_ID = 98_765_001;
const OWNER_ALLIANCE_ID = 99_000_321;
const OWNER_WAR_FACTION_ID = 500001;
const HOME_STATION_ID = 60_003_760;

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function buildActor(actorNumber, options = {}) {
  return {
    actorID: `${String(options.prefix || "living_universe_actor")}_${String(actorNumber).padStart(7, "0")}`,
    role: String(options.role || "hauler"),
    corporationID: Number(options.corporationID || 1000035),
    allianceID: Number(options.allianceID || 0),
    warFactionID: Number(options.warFactionID || 0),
    currentSystemID: Number(options.systemID || HOME_SYSTEM_ID),
    currentAssignment: String(options.assignment || "verification"),
  };
}

function syncActorSource(sourceID, actors) {
  return pilotDirectory.syncActors(actors, {
    sourceID,
    getProfile(_profileID, actor) {
      return {
        corporationID: actor.corporationID,
        allianceID: actor.allianceID,
        warFactionID: actor.warFactionID,
        factionID: 0,
        raceID: 1,
      };
    },
    resolvePresence(actor) {
      return {
        solarSystemID: actor.currentSystemID,
        localVisible: true,
        corporationChatVisible: true,
        state: "in_space_virtual",
      };
    },
  });
}

function verifySourceOwnedPilotDirectory() {
  pilotDirectory.clear();

  const ambientOne = buildActor(11, {
    prefix: "ambient_actor",
    systemID: HOME_SYSTEM_ID,
  });
  const industrial = buildActor(7_900_001, {
    prefix: "industrial_actor",
    corporationID: OWNER_CORPORATION_ID,
    systemID: HOME_SYSTEM_ID,
  });
  const ambientTwo = buildActor(12, {
    prefix: "ambient_actor",
    systemID: TRANSIT_SYSTEM_ID,
  });

  const ambientOneSync = syncActorSource(AMBIENT_SOURCE_ID, [ambientOne]);
  const industrialSync = syncActorSource(PILOT_SOURCE_ID, [industrial]);
  const ambientOneID = ambientOneSync.pilots[0].characterID;
  const industrialID = industrialSync.pilots[0].characterID;

  assert.equal(pilotDirectory.listPilots().length, 2);
  assert.equal(
    pilotDirectory.getPilotRecord(industrialID).pilotSourceID,
    PILOT_SOURCE_ID,
  );

  syncActorSource(AMBIENT_SOURCE_ID, [ambientTwo]);
  assert.equal(pilotDirectory.getPilotRecord(ambientOneID), null);
  assert.ok(pilotDirectory.getPilotRecord(industrialID));
  assert.equal(pilotDirectory.listPilots().length, 2);

  pilotDirectory.clear({ sourceID: AMBIENT_SOURCE_ID });
  assert.ok(pilotDirectory.getPilotRecord(industrialID));
  assert.deepEqual(
    pilotDirectory.listPilots().map((pilot) => pilot.pilotSourceID),
    [PILOT_SOURCE_ID],
  );

  return {
    ambientReplacementPreservedIndustrial: true,
    ambientClearPreservedIndustrial: true,
  };
}

function createMemoryContractService(initialContract) {
  let stored = cloneValue(initialContract);
  return {
    getStoredContract() {
      return cloneValue(stored);
    },
    setCrewMembers(command) {
      assert.equal(command.ownerCharacterID, stored.ownerCharacterID);
      assert.equal(command.contractID, stored.contractID);
      stored = {
        ...stored,
        members: cloneValue(command.members),
      };
      return {
        success: true,
        data: cloneValue(stored),
      };
    },
  };
}

function verifyCrewPresenceLifecycle() {
  pilotDirectory.clear();
  chatRuntime._testing.resetRuntimeState({ resetStore: false });

  const ambientActor = buildActor(23, {
    prefix: "ambient_actor",
    corporationID: 1000169,
    systemID: AMBIENT_SYSTEM_ID,
  });
  const ambientSync = syncActorSource(AMBIENT_SOURCE_ID, [ambientActor]);
  const ambientPilot = ambientSync.pilots[0];
  chatRuntime.syncSyntheticLocalMembers(
    [ambientPilot],
    { sourceID: AMBIENT_SOURCE_ID },
  );

  const contract = {
    schemaVersion: 2,
    contractID: "crew-presence-regression",
    contractKind: "mining_crew",
    crewTypeID: CREW_TYPE_ID.VENTURE,
    crewName: "Venture Crew Regression",
    displayName: "Venture Crew Regression",
    serial: 41,
    state: "active",
    order: "standby",
    ownerCharacterID: OWNER_CHARACTER_ID,
    ownerCorporationID: OWNER_CORPORATION_ID,
    ownerAllianceID: OWNER_ALLIANCE_ID,
    ownerWarFactionID: OWNER_WAR_FACTION_ID,
    homeStationID: HOME_STATION_ID,
    currentSystemID: HOME_SYSTEM_ID,
    assignedSystemID: HOME_SYSTEM_ID,
    runtimeEntityIDs: [],
    navigation: {
      phase: "arrived",
      currentSystemID: HOME_SYSTEM_ID,
      destinationSystemID: HOME_SYSTEM_ID,
      destinationStationID: HOME_STATION_ID,
    },
    members: buildIndustrialMiningCrewRoster(CREW_TYPE_ID.VENTURE, {
      contractID: "crew-presence-regression",
      contractSerial: 41,
    }),
  };
  const contractService = createMemoryContractService(contract);
  const identityService = createIndustrialHirelingIdentityService({
    pilotDirectory,
    contractService,
    chatRuntime,
  });

  const hired = identityService.ensureContractPresence(contract, 1_000);
  assert.equal(hired.success, true);
  const hiredContract = hired.data.contract;
  const crewCharacterIDs = hiredContract.members.map(
    (member) => member.pilotIdentityID,
  );
  assert.equal(new Set(crewCharacterIDs).size, contract.members.length);

  const homeLocal = chatRuntime.getSyntheticLocalMembers(HOME_SYSTEM_ID, {
    sourceID: PILOT_SOURCE_ID,
  });
  const corporationRoster = chatRuntime.getSyntheticCorporationMembers(
    OWNER_CORPORATION_ID,
    { sourceID: PILOT_SOURCE_ID },
  );
  assert.deepEqual(
    homeLocal.map((pilot) => pilot.characterID),
    crewCharacterIDs.slice().sort((left, right) => left - right),
  );
  assert.deepEqual(
    corporationRoster.map((pilot) => pilot.characterID),
    crewCharacterIDs.slice().sort((left, right) => left - right),
  );
  for (const characterID of crewCharacterIDs) {
    const pilot = pilotDirectory.getPilotRecord(characterID);
    assert.ok(pilot);
    assert.equal(pilot.pilotSourceID, PILOT_SOURCE_ID);
    assert.equal(pilot.solarSystemID, HOME_SYSTEM_ID);
    assert.equal(pilot.corporationID, OWNER_CORPORATION_ID);
    assert.equal(pilot.allianceID, OWNER_ALLIANCE_ID);
    assert.equal(pilot.warFactionID, OWNER_WAR_FACTION_ID);
    assert.equal(pilot.localVisible, true);
    assert.equal(pilot.corporationChatVisible, true);
  }

  const movingContract = {
    ...hiredContract,
    currentSystemID: TRANSIT_SYSTEM_ID,
    order: "travel",
    navigation: {
      ...hiredContract.navigation,
      phase: "in_transit",
      currentSystemID: TRANSIT_SYSTEM_ID,
      destinationSystemID: AMBIENT_SYSTEM_ID,
      destinationStationID: null,
    },
  };
  const moved = identityService.ensureContractPresence(movingContract, 2_000);
  assert.equal(moved.success, true);
  const movedContract = moved.data.contract;
  assert.equal(
    chatRuntime.getSyntheticLocalMembers(HOME_SYSTEM_ID, {
      sourceID: PILOT_SOURCE_ID,
    }).length,
    0,
  );
  assert.deepEqual(
    chatRuntime.getSyntheticLocalMembers(TRANSIT_SYSTEM_ID, {
      sourceID: PILOT_SOURCE_ID,
    }).map((pilot) => pilot.characterID),
    crewCharacterIDs.slice().sort((left, right) => left - right),
  );
  assert.equal(
    chatRuntime.getSyntheticCorporationMembers(OWNER_CORPORATION_ID, {
      sourceID: PILOT_SOURCE_ID,
    }).length,
    crewCharacterIDs.length,
  );
  assert.deepEqual(
    chatRuntime.getSyntheticLocalMembers(AMBIENT_SYSTEM_ID, {
      sourceID: AMBIENT_SOURCE_ID,
    }).map((pilot) => pilot.characterID),
    [ambientPilot.characterID],
  );

  const dismissedContract = {
    ...movedContract,
    state: "dismissed",
  };
  const released = identityService.releaseContractPresence(dismissedContract);
  assert.equal(released.success, true);
  assert.deepEqual(
    released.data.removedCharacterIDs.slice().sort((left, right) => left - right),
    crewCharacterIDs.slice().sort((left, right) => left - right),
  );
  for (const characterID of crewCharacterIDs) {
    assert.equal(pilotDirectory.getPilotRecord(characterID), null);
  }
  assert.equal(
    chatRuntime.getSyntheticLocalMembers(TRANSIT_SYSTEM_ID, {
      sourceID: PILOT_SOURCE_ID,
    }).length,
    0,
  );
  assert.equal(
    chatRuntime.getSyntheticCorporationMembers(OWNER_CORPORATION_ID, {
      sourceID: PILOT_SOURCE_ID,
    }).length,
    0,
  );
  assert.ok(pilotDirectory.getPilotRecord(ambientPilot.characterID));
  assert.deepEqual(
    chatRuntime.getSyntheticLocalMembers(AMBIENT_SYSTEM_ID, {
      sourceID: AMBIENT_SOURCE_ID,
    }).map((pilot) => pilot.characterID),
    [ambientPilot.characterID],
  );

  return {
    hiredCrewCount: crewCharacterIDs.length,
    localAtHire: true,
    corporationChatAtHire: true,
    movedBetweenLocalSystems: true,
    removedOnDismissal: true,
    ambientSlicePreserved: true,
  };
}

function main() {
  try {
    const sourceOwnership = verifySourceOwnedPilotDirectory();
    const lifecycle = verifyCrewPresenceLifecycle();
    console.log(JSON.stringify({
      success: true,
      sourceOwnership,
      lifecycle,
    }, null, 2));
  } finally {
    pilotDirectory.clear();
    chatRuntime._testing.resetRuntimeState({ resetStore: false });
  }
}

main();
