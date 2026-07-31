"use strict";

// Keep default services inert. This verifier supplies every stateful dependency
// and explicitly enables the feature only on its injected runtime config.
process.env.EVEJS_INDUSTRIAL_HIRELINGS_ENABLED = "false";
process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";

const assert = require("node:assert/strict");
const path = require("path");

const {
  ORDER,
  ROLE,
} = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialHirelingContracts",
));
const {
  createIndustrialHirelingRuntime,
} = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialHirelingRuntime",
));
const crewCatalog = require(path.join(
  __dirname,
  "../src/services/industrialHirelings/industrialMiningCrewCatalog",
));

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function groupEntityIDsByRole(roster, entityIDs) {
  const grouped = {
    miner: [],
    mining_support: [],
    hauler: [],
  };
  roster.forEach((member, index) => {
    grouped[member.role].push(entityIDs[index]);
  });
  return grouped;
}

function verifyObservedPartialCrewIsRepairedToExactRoster() {
  const nowMs = 2_030_000_000_000;
  const systemID = 30_000_142;
  const siteID = 40_000_901;
  const ownerCharacterID = 90_001;
  const contractID = "crew-partial-repair";
  const priorFleetID = 70_001;
  const replacementFleetID = 70_002;
  const roster = crewCatalog.buildIndustrialMiningCrewRoster(
    crewCatalog.CREW_TYPE_ID.VENTURE,
    {
      contractID,
      contractSerial: 1,
    },
  );

  assert.equal(roster.length, 4, "the Venture package must author four exact crew slots");

  const priorEntityIDs = roster.map((_member, index) => 80_001 + index);
  const priorByRole = groupEntityIDsByRole(roster, priorEntityIDs);
  let currentContract = {
    schemaVersion: 2,
    contractKind: crewCatalog.CONTRACT_KIND,
    contractID,
    serial: 1,
    state: "active",
    role: ROLE.MINER,
    order: ORDER.SUPPORT_MINING,
    crewTypeID: crewCatalog.CREW_TYPE_ID.VENTURE,
    crewName: "Partial Repair Verification Crew",
    ownerCharacterID,
    ownerCorporationID: 98_000_901,
    ownerAllianceID: 99_000_901,
    ownerWarFactionID: 0,
    homeStationID: 60_000_001,
    currentSystemID: systemID,
    assignedSystemID: systemID,
    assignedSiteID: siteID,
    navigation: {
      phase: "arrived",
      currentSystemID: systemID,
      destinationSystemID: systemID,
    },
    runtimeFleetID: priorFleetID,
    runtimeEntityIDs: [...priorEntityIDs],
    minerEntityIDs: [...priorByRole.miner],
    supportEntityIDs: [...priorByRole.mining_support],
    haulerEntityIDs: [...priorByRole.hauler],
    members: roster.map((member, index) => ({
      ...clone(member),
      runtimeEntityID: priorEntityIDs[index],
      runtimeShipItemID: priorEntityIDs[index],
      state: "in_space",
    })),
  };

  const bindingCalls = [];
  const contractService = {
    listForAssignedSystem(requestedSystemID) {
      assert.equal(Number(requestedSystemID), systemID);
      return {
        success: true,
        data: { contracts: [clone(currentContract)] },
      };
    },
    listForCharacter(requestedCharacterID) {
      assert.equal(Number(requestedCharacterID), ownerCharacterID);
      return {
        success: true,
        data: { contracts: [clone(currentContract)] },
      };
    },
    setCrewRuntimeBinding(input) {
      assert.equal(Number(input.ownerCharacterID), ownerCharacterID);
      assert.equal(String(input.contractID), contractID);
      const runtimeEntityIDs = [
        ...(input.minerEntityIDs || []),
        ...(input.supportEntityIDs || []),
        ...(input.haulerEntityIDs || []),
      ];
      currentContract = {
        ...currentContract,
        runtimeFleetID: Number(input.runtimeFleetID) || 0,
        runtimeEntityIDs,
        minerEntityIDs: [...(input.minerEntityIDs || [])],
        supportEntityIDs: [...(input.supportEntityIDs || [])],
        haulerEntityIDs: [...(input.haulerEntityIDs || [])],
        members: clone(input.members),
      };
      bindingCalls.push({
        runtimeFleetID: currentContract.runtimeFleetID,
        runtimeEntityIDs: [...runtimeEntityIDs],
        members: clone(currentContract.members),
      });
      return { success: true, data: clone(currentContract) };
    },
  };

  const reservationID = `industrial_hireling:${contractID}`;
  const reservations = new Map([
    [
      reservationID,
      {
        reservationID,
        systemID,
        shipCount: roster.length,
      },
    ],
  ]);
  const reserveCalls = [];
  const releaseCalls = [];
  const physicalBudget = {
    reserve(input) {
      reserveCalls.push(clone(input));
      reservations.set(input.reservationID, clone(input));
      return { success: true, data: clone(input) };
    },
    getReservation(requestedReservationID) {
      return clone(reservations.get(String(requestedReservationID)) || null);
    },
    release(requestedReservationID) {
      const normalized = String(requestedReservationID);
      releaseCalls.push(normalized);
      return reservations.delete(normalized);
    },
  };

  const entities = new Map([
    [
      siteID,
      {
        itemID: siteID,
        itemName: "Partial Repair Asteroid Site",
        position: { x: 10, y: 20, z: 30 },
      },
    ],
  ]);

  // Simulate the real fleet lookup behavior after one managed hull disappears:
  // the fleet still exists and is returned, but only its three surviving hulls
  // remain in the managed roster and entity arrays.
  const survivingRoster = roster.slice(0, -1);
  const survivingEntityIDs = priorEntityIDs.slice(0, -1);
  survivingRoster.forEach((member, index) => {
    entities.set(survivingEntityIDs[index], {
      itemID: survivingEntityIDs[index],
      typeID: member.shipTypeID,
      itemName: `Surviving ${member.shipTypeName}`,
      position: { x: 100 + index, y: 0, z: 0 },
    });
  });
  let partialFleet = {
    fleetID: priorFleetID,
    operatorKind: "industrial_hireling",
    operatorID: contractID,
    systemID,
    entityIDs: [...survivingEntityIDs],
    managedRoster: survivingRoster.map((member, index) => ({
      memberID: member.memberID,
      index,
      entityID: survivingEntityIDs[index],
      role: member.role,
      profileID: member.profileID,
    })),
    miningWorkerEntityIDs: [...survivingEntityIDs],
    miningSupportEntityIDs: [],
    haulerEntityIDs: [],
  };

  const changedSlimItemBatches = [];
  const observerSession = {
    characterID: ownerCharacterID,
    _space: {
      systemID,
      shipID: 88_001,
    },
  };
  const scene = {
    systemID,
    sessions: new Map([["observer", observerSession]]),
    getEntityByID(entityID) {
      return entities.get(Number(entityID)) || null;
    },
    broadcastSlimItemChanges(changedEntities) {
      changedSlimItemBatches.push(changedEntities.map((entity) => entity.itemID));
    },
  };

  let getFleetCount = 0;
  const destroyCalls = [];
  const spawnCalls = [];
  let replacementFleet = null;
  const miningOperations = {
    getManagedMiningFleet(requestedFleetID, ownerOptions = {}) {
      getFleetCount += 1;
      assert.equal(Number(requestedFleetID), priorFleetID);
      assert.equal(ownerOptions.operatorKind, "industrial_hireling");
      assert.equal(ownerOptions.operatorID, contractID);
      return clone(partialFleet);
    },
    destroyManagedMiningFleetsByOwner(ownerOptions = {}) {
      destroyCalls.push(clone(ownerOptions));
      partialFleet = null;
      survivingEntityIDs.forEach((entityID) => entities.delete(entityID));
      return { success: true, data: { destroyedCount: 1 } };
    },
    spawnManagedIndustrialMiningCrew(requestedScene, options = {}) {
      assert.equal(requestedScene, scene);
      spawnCalls.push(clone(options));
      const replacementEntityIDs = options.roster.map(
        (_member, index) => 81_001 + index,
      );
      const replacementByRole = groupEntityIDsByRole(
        options.roster,
        replacementEntityIDs,
      );
      const memberBindings = options.roster.map((member, index) => {
        const entityID = replacementEntityIDs[index];
        entities.set(entityID, {
          itemID: entityID,
          typeID: member.shipTypeID,
          itemName: `Replacement ${member.shipTypeName}`,
          position: { x: 200 + index, y: 0, z: 0 },
        });
        return {
          memberID: member.memberID,
          index,
          entityID,
          role: member.role,
          profileID: member.profileID,
        };
      });
      replacementFleet = {
        fleetID: replacementFleetID,
        operatorKind: String(options.operatorKind || ""),
        operatorID: String(options.operatorID || ""),
        systemID,
        entityIDs: [...replacementEntityIDs],
        managedRoster: clone(memberBindings),
        miningWorkerEntityIDs: [...replacementByRole.miner],
        miningSupportEntityIDs: [...replacementByRole.mining_support],
        haulerEntityIDs: [...replacementByRole.hauler],
      };
      return {
        success: true,
        data: {
          fleetRecord: clone(replacementFleet),
          entityIDs: [...replacementEntityIDs],
          memberBindings: clone(memberBindings),
          minerEntityIDs: [...replacementByRole.miner],
          supportEntityIDs: [...replacementByRole.mining_support],
          haulerEntityIDs: [...replacementByRole.hauler],
        },
      };
    },
  };

  const markCrewInSpaceCalls = [];
  const identityService = {
    markCrewInSpace(contract, requestedSystemID, requestedNowMs) {
      markCrewInSpaceCalls.push({
        contractID: contract.contractID,
        systemID: requestedSystemID,
        nowMs: requestedNowMs,
      });
      const members = contract.members.map((member, index) => ({
        ...clone(member),
        pilotIdentityID: 2_120_090_100 + index,
        pilotActorID: `${contractID}:pilot:${index + 1}`,
        pilotName: `Repair Pilot ${index + 1}`,
      }));
      return {
        success: true,
        data: {
          contract: {
            ...clone(contract),
            members,
          },
          memberIdentities: members.map((member) => ({
            member: clone(member),
            actorID: member.pilotActorID,
            pilot: {
              characterID: member.pilotIdentityID,
              characterName: member.pilotName,
              corporationID: contract.ownerCorporationID,
              allianceID: contract.ownerAllianceID,
              warFactionID: contract.ownerWarFactionID,
              securityStatus: 0,
            },
          })),
        },
      };
    },
    markCrewDocked(contract) {
      return { success: true, data: { contract: clone(contract) } };
    },
  };

  const runtime = createIndustrialHirelingRuntime({
    config: {
      livingUniverseEnabled: true,
      industrialHirelingsEnabled: true,
      industrialHirelingsMiningEnabled: true,
      industrialMiningCrewsEnabled: true,
      industrialHirelingsRemoteSitesEnabled: true,
      industrialHirelingsMaxJobsPerPass: 4,
    },
    contractService,
    crewCatalog,
    identityService,
    miningOperations,
    physicalBudget,
    siteCatalog: {
      validateSite(requestedSiteID, requestedSystemID) {
        assert.equal(Number(requestedSiteID), siteID);
        assert.equal(Number(requestedSystemID), systemID);
        return {
          success: true,
          data: {
            site: {
              siteID,
              systemID,
            },
          },
        };
      },
    },
    spaceRuntime: {
      scenes: new Map([[systemID, scene]]),
    },
  });

  const reconciled = runtime.reconcileForObservedScene(scene, {
    observerSession,
    nowMs,
    maxContracts: 1,
  });

  assert.equal(reconciled.success, true, JSON.stringify(reconciled));
  assert.equal(reconciled.data.processedCount, 1);
  assert.equal(reconciled.data.deployedCount, 1);
  assert.equal(reconciled.data.staleCount, 1);
  assert.equal(reconciled.data.rematerializedCount, 1);
  assert.deepEqual(reconciled.data.failures, []);

  assert.equal(
    getFleetCount,
    2,
    "reconciliation must pass the surviving partial fleet into exact-roster validation",
  );
  assert.equal(destroyCalls.length, 1);
  assert.equal(
    destroyCalls[0].reason,
    "partial_crew_rejected",
    "the incomplete fleet must be rejected as a unit before replacement",
  );
  assert.equal(spawnCalls.length, 1);
  assert.equal(
    spawnCalls[0].roster.length,
    roster.length,
    "repair must spawn the complete authored roster",
  );
  assert.deepEqual(
    spawnCalls[0].roster.map((member) => member.memberID),
    roster.map((member) => member.memberID),
  );

  assert.deepEqual(
    bindingCalls.map((call) => call.runtimeFleetID),
    [0, replacementFleetID],
    "repair must clear the stale binding before persisting its replacement",
  );
  assert.equal(bindingCalls[0].runtimeEntityIDs.length, 0);
  assert.equal(bindingCalls[1].runtimeEntityIDs.length, roster.length);
  assert.equal(
    new Set(bindingCalls[1].runtimeEntityIDs).size,
    roster.length,
    "every repaired crew slot must receive one distinct runtime hull",
  );
  assert.ok(
    bindingCalls[1].members.every(
      (member) => member.state === "in_space" && member.runtimeEntityID > 0,
    ),
  );

  assert.deepEqual(releaseCalls, [reservationID]);
  assert.equal(reserveCalls.length, 1);
  assert.equal(reserveCalls[0].shipCount, roster.length);
  assert.equal(reservations.get(reservationID).shipCount, roster.length);
  assert.equal(markCrewInSpaceCalls.length, 1);
  assert.equal(markCrewInSpaceCalls[0].systemID, systemID);

  assert.ok(replacementFleet);
  assert.equal(replacementFleet.entityIDs.length, roster.length);
  assert.equal(currentContract.runtimeFleetID, replacementFleetID);
  assert.equal(currentContract.runtimeEntityIDs.length, roster.length);
  assert.equal(
    changedSlimItemBatches.flat().length,
    roster.length,
    "repaired hulls must receive their persistent pilot presentation",
  );
}

verifyObservedPartialCrewIsRepairedToExactRoster();
console.log("Industrial mining crew partial-repair verification passed.");
