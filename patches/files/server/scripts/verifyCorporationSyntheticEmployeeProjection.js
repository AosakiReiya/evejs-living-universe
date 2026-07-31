"use strict";

process.env.EVEJS_LIVING_UNIVERSE_ENABLED = "false";
process.env.EVEJS_LIVING_ECONOMY_ENABLED = "false";
process.env.EVEJS_INDUSTRIAL_HIRELINGS_ENABLED = "false";
process.env.EVEJS_MINING_NPC_STARTUP_ENABLED = "false";

const assert = require("node:assert/strict");
const path = require("path");

const pilotDirectory = require(path.join(
  __dirname,
  "../src/space/npc/ambientTraffic/livingUniversePilotDirectory",
));
const {
  INDUSTRIAL_HIRELING_PILOT_SOURCE_ID,
  ZERO_ROLE_FIELDS,
  getCorporationMemberForRead,
  listCorporationMembersForRead,
} = require(path.join(
  __dirname,
  "../src/services/corporation/corpReadOnlyEmployeeProjection",
));
const {
  getCorporationInfoRecord,
  getCharacterIDsInCorporation,
} = require(path.join(
  __dirname,
  "../src/services/corporation/corporationState",
));
const {
  getCorporationMember,
  getCorporationRuntime,
  listCorporationMembers,
} = require(path.join(
  __dirname,
  "../src/services/corporation/corporationRuntimeState",
));
const CorpRegistryRuntimeService = require(path.join(
  __dirname,
  "../src/services/corporation/corpRegistryRuntime",
));
const CharMgrService = require(path.join(
  __dirname,
  "../src/services/character/charMgrService",
));
const charMgrTesting = CharMgrService._testing;
const {
  buildSlimItemDict,
} = require(path.join(
  __dirname,
  "../src/space/destiny",
));

const TARGET_CORPORATION_ID = 1000060;
const VERIFY_ALLIANCE_ID = 99009001;
const VERIFY_WAR_FACTION_ID = 500001;
const INDUSTRIAL_ACTOR_ID =
  "industrial_crew_actor_7999001";
const AMBIENT_SOURCE_ID =
  "corporation_projection_ambient_verifier";

function getDictEntry(dict, key) {
  const entry =
    dict &&
    Array.isArray(dict.entries) &&
    dict.entries.find(
      (candidate) =>
        Array.isArray(candidate) &&
        candidate[0] === key,
    );
  return entry ? entry[1] : undefined;
}

function unwrapLong(value) {
  return value &&
    typeof value === "object" &&
    value.type === "long"
    ? value.value
    : value;
}

function buildVerifierActor(actorID) {
  return {
    actorID,
    role: "miner",
    corporationID: TARGET_CORPORATION_ID,
    allianceID: VERIFY_ALLIANCE_ID,
    warFactionID: VERIFY_WAR_FACTION_ID,
    currentSystemID: 30000142,
    currentAssignment: "standby",
  };
}

function syncVerifierPilot(actorID, sourceID) {
  const actor = buildVerifierActor(actorID);
  const result = pilotDirectory.syncActorChanges(
    [actor],
    {
      sourceID,
      getProfile() {
        return {
          corporationID: TARGET_CORPORATION_ID,
          allianceID: VERIFY_ALLIANCE_ID,
          warFactionID: VERIFY_WAR_FACTION_ID,
          factionID: VERIFY_WAR_FACTION_ID,
          raceID: 1,
        };
      },
      resolvePresence() {
        return {
          solarSystemID: 30000142,
          stationID: null,
          localVisible: true,
          corporationChatVisible: true,
          state: "in_space_materialized",
          assignment: "standby",
        };
      },
    },
  );
  assert.equal(result.pilots.length, 1);
  return result.pilots[0];
}

function verifyReadOnlySyntheticEmployeeProjection() {
  const corporationBefore =
    getCorporationInfoRecord(TARGET_CORPORATION_ID);
  assert.ok(
    corporationBefore,
    "the verifier requires the static Caldari Provisions corporation",
  );
  const canonicalMembersBefore =
    listCorporationMembers(TARGET_CORPORATION_ID);
  const canonicalCharacterIDsBefore =
    getCharacterIDsInCorporation(TARGET_CORPORATION_ID);
  const runtimeBefore =
    getCorporationRuntime(TARGET_CORPORATION_ID);

  const industrialPilot = syncVerifierPilot(
    INDUSTRIAL_ACTOR_ID,
    INDUSTRIAL_HIRELING_PILOT_SOURCE_ID,
  );
  const ambientPilot = syncVerifierPilot(
    "living_universe_actor_7999002",
    AMBIENT_SOURCE_ID,
  );
  assert.notEqual(
    industrialPilot.characterID,
    ambientPilot.characterID,
  );

  const projectedMembers =
    listCorporationMembersForRead(
      TARGET_CORPORATION_ID,
    );
  const projectedEmployee = projectedMembers.find(
    (member) =>
      Number(member.characterID) ===
      Number(industrialPilot.characterID),
  );
  assert.ok(projectedEmployee);
  assert.equal(
    projectedEmployee.readOnlySyntheticEmployee,
    true,
  );
  assert.equal(projectedEmployee.isCEO, false);
  assert.equal(projectedEmployee.accountKey, 0);
  assert.equal(projectedEmployee.titleMask, 0);
  assert.equal(projectedEmployee.blockRoles, null);
  for (const roleField of ZERO_ROLE_FIELDS) {
    assert.equal(
      projectedEmployee[roleField],
      "0",
      `${roleField} must remain zero`,
    );
  }
  assert.equal(
    projectedMembers.some(
      (member) =>
        Number(member.characterID) ===
        Number(ambientPilot.characterID),
    ),
    false,
    "ordinary Living Universe pilots must not become corporation employees",
  );
  assert.deepEqual(
    getCorporationMemberForRead(
      TARGET_CORPORATION_ID,
      industrialPilot.characterID,
    ),
    projectedEmployee,
  );

  assert.equal(
    getCorporationMember(
      TARGET_CORPORATION_ID,
      industrialPilot.characterID,
    ),
    null,
    "the employee projection must not enter corporation governance",
  );
  assert.deepEqual(
    listCorporationMembers(TARGET_CORPORATION_ID),
    canonicalMembersBefore,
  );
  assert.deepEqual(
    getCharacterIDsInCorporation(
      TARGET_CORPORATION_ID,
    ),
    canonicalCharacterIDsBefore,
  );
  assert.equal(
    getCorporationInfoRecord(TARGET_CORPORATION_ID)
      .memberCount,
    corporationBefore.memberCount,
    "synthetic employees must not consume the corporation member limit",
  );

  const registry = new CorpRegistryRuntimeService();
  const session = {
    characterID: 90000001,
    corporationID: TARGET_CORPORATION_ID,
    corpid: TARGET_CORPORATION_ID,
  };
  const projectedContacts =
    charMgrTesting.mergeOwnedIndustrialCrewContacts(
      {
        90000002: {
          contactID: 90000002,
          inWatchlist: true,
          relationshipID: -5,
          labelMask: 8,
        },
      },
      [
        {
          ownerCharacterID: session.characterID,
          state: "active",
          members: [
            {
              pilotIdentityID:
                industrialPilot.characterID,
            },
            {
              pilotIdentityID:
                ambientPilot.characterID,
            },
          ],
        },
        {
          ownerCharacterID: session.characterID + 1,
          state: "active",
          pilotIdentityID:
            industrialPilot.characterID,
        },
        {
          ownerCharacterID: session.characterID,
          state: "dismissed",
          pilotIdentityID:
            industrialPilot.characterID,
        },
      ],
      session.characterID,
    );
  assert.equal(
    projectedContacts[String(industrialPilot.characterID)]
      .relationshipID,
    charMgrTesting.INDUSTRIAL_CREW_RELATIONSHIP_ID,
    "owned active industrial crew must project as an excellent personal contact",
  );
  assert.equal(
    projectedContacts[String(ambientPilot.characterID)],
    undefined,
    "ordinary Living Universe pilots must not inherit the crew relationship",
  );
  assert.deepEqual(
    projectedContacts["90000002"],
    {
      contactID: 90000002,
      inWatchlist: true,
      relationshipID: -5,
      labelMask: 8,
    },
    "real personal contacts must remain unchanged",
  );
  const paged = registry.Handle_GetMembersPaged(
    [1],
    session,
  );
  const pagedArguments = paged.header[1];
  const pagedRows = pagedArguments[0].items;
  const employeeRow = pagedRows.find(
    (row) =>
      Number(row.fields.characterID) ===
      Number(industrialPilot.characterID),
  );
  assert.ok(employeeRow);
  assert.equal(employeeRow.fields.ownerName, industrialPilot.characterName);
  assert.equal(employeeRow.fields.accountKey, 0);
  assert.equal(employeeRow.fields.roles, 0n);
  assert.equal(employeeRow.fields.grantableRoles, 0n);
  assert.equal(
    pagedArguments[1],
    canonicalMembersBefore.length + 1,
  );

  const directMember = registry.Handle_GetMember(
    [industrialPilot.characterID],
    session,
  );
  assert.equal(
    directMember.fields.characterID,
    industrialPilot.characterID,
  );
  const membersByID =
    registry.Handle_GetMembersByIds(
      [[industrialPilot.characterID]],
      session,
    );
  assert.equal(membersByID.items.length, 1);
  assert.equal(
    membersByID.items[0].fields.characterID,
    industrialPilot.characterID,
  );

  const queriedIDs =
    registry.Handle_GetMemberIDsByQuery(
      [[]],
      session,
    );
  assert.equal(
    queriedIDs.items.includes(
      industrialPilot.characterID,
    ),
    true,
  );
  assert.equal(
    queriedIDs.items.includes(
      ambientPilot.characterID,
    ),
    false,
  );

  const tracking =
    registry.Handle_GetMemberTrackingInfoSimple(
      [],
      session,
    );
  const trackingRow = tracking.list.find(
    (row) =>
      Number(row.values[0]) ===
      Number(industrialPilot.characterID),
  );
  assert.ok(trackingRow);
  assert.equal(trackingRow.values[1], TARGET_CORPORATION_ID);
  assert.equal(unwrapLong(trackingRow.values[3]), 0n);
  assert.equal(unwrapLong(trackingRow.values[4]), 0n);
  assert.equal(
    trackingRow.values[9],
    -1,
    "an active synthetic employee should be online in member tracking",
  );
  assert.equal(trackingRow.values[10], 30000142);

  const owners = registry.Handle_GetEveOwners(
    [],
    session,
  );
  const employeeOwner = owners.items.find((row) => {
    const line = getDictEntry(row.args, "line");
    return (
      line &&
      Number(line.items[0]) ===
        Number(industrialPilot.characterID)
    );
  });
  assert.ok(employeeOwner);

  const infoWindow =
    registry.Handle_GetInfoWindowDataForChar(
      [industrialPilot.characterID],
      {
        ...session,
        corporationID: 1000002,
        corpid: 1000002,
      },
    );
  assert.equal(
    getDictEntry(infoWindow.args, "corpID"),
    TARGET_CORPORATION_ID,
    "the employee's corporation must not be inherited from the viewer",
  );
  assert.equal(
    getDictEntry(infoWindow.args, "title"),
    industrialPilot.title,
  );
  assert.equal(
    getDictEntry(infoWindow.args, "allianceID"),
    VERIFY_ALLIANCE_ID,
  );
  assert.equal(
    getDictEntry(infoWindow.args, "factionID"),
    VERIFY_WAR_FACTION_ID,
  );

  const crossCorporationViewer = {
    characterID: 90000001,
    charid: 90000001,
    corporationID: 1000002,
    corpid: 1000002,
    allianceID: 99009002,
    allianceid: 99009002,
  };
  const charMgr = new CharMgrService();
  const publicInfo = charMgr.Handle_GetPublicInfo(
    [industrialPilot.characterID],
    crossCorporationViewer,
  );
  assert.equal(
    getDictEntry(publicInfo.args, "corporationID"),
    TARGET_CORPORATION_ID,
    "public character info must use the crew's corporation, not the viewer's",
  );
  assert.equal(
    getDictEntry(publicInfo.args, "allianceID"),
    VERIFY_ALLIANCE_ID,
  );
  assert.equal(
    getDictEntry(publicInfo.args, "militiaFactionID"),
    VERIFY_WAR_FACTION_ID,
  );

  const organizationInfo =
    charMgr.Handle_GetOrganizationInfoForCharacters(
      [[industrialPilot.characterID]],
    );
  const organizationRow = getDictEntry(
    organizationInfo,
    industrialPilot.characterID,
  );
  assert.ok(organizationRow);
  assert.equal(
    getDictEntry(organizationRow.args, "corporationID"),
    TARGET_CORPORATION_ID,
  );
  assert.equal(
    getDictEntry(organizationRow.args, "allianceID"),
    VERIFY_ALLIANCE_ID,
  );
  assert.equal(
    getDictEntry(organizationRow.args, "warFactionID"),
    VERIFY_WAR_FACTION_ID,
  );

  const shipSlim = buildSlimItemDict({
    itemID: 980000009999,
    kind: "ship",
    typeID: 22544,
    groupID: 463,
    categoryID: 6,
    ownerID: industrialPilot.characterID,
    npcPilotCharacterID: industrialPilot.characterID,
    corporationID: TARGET_CORPORATION_ID,
    allianceID: VERIFY_ALLIANCE_ID,
    warFactionID: VERIFY_WAR_FACTION_ID,
    itemName: industrialPilot.characterName,
    securityStatus: 0,
    bounty: 0,
  });
  assert.equal(
    getDictEntry(shipSlim, "charID"),
    industrialPilot.characterID,
  );
  assert.equal(
    getDictEntry(shipSlim, "corpID"),
    TARGET_CORPORATION_ID,
  );
  assert.equal(
    getDictEntry(shipSlim, "allianceID"),
    VERIFY_ALLIANCE_ID,
  );
  assert.equal(
    getDictEntry(shipSlim, "warFactionID"),
    VERIFY_WAR_FACTION_ID,
  );

  const potentialCEOs =
    registry.Handle_GetNumberOfPotentialCEOs(
      [],
      session,
    );
  assert.equal(
    potentialCEOs.items.includes(
      industrialPilot.characterID,
    ),
    false,
    "synthetic employees must never enter CEO candidacy",
  );
  assert.equal(
    registry.Handle_CanBeKickedOut(
      [industrialPilot.characterID],
      session,
    ),
    0,
    "governance mutations must reject projected employees",
  );
  registry.Handle_ExecuteActions(
    [
      [industrialPilot.characterID],
      [[3, "roles", 1]],
    ],
    session,
  );
  registry.Handle_MoveCompanyShares(
    [
      TARGET_CORPORATION_ID,
      industrialPilot.characterID,
      1,
    ],
    session,
  );
  registry.Handle_ResignFromCEO(
    [industrialPilot.characterID],
    session,
  );
  assert.equal(
    getCorporationInfoRecord(TARGET_CORPORATION_ID)
      .ceoID,
    corporationBefore.ceoID,
    "a projected employee cannot become CEO through a direct mutation call",
  );

  const runtimeAfterReads =
    getCorporationRuntime(TARGET_CORPORATION_ID);
  assert.deepEqual(
    runtimeAfterReads,
    runtimeBefore,
    "read projections must not mutate roles, shares, voting, wallets, or runtime membership",
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      runtimeAfterReads.shares || {},
      String(industrialPilot.characterID),
    ),
    false,
  );
}

try {
  verifyReadOnlySyntheticEmployeeProjection();
  console.log(
    "Corporation synthetic employee projection verification passed.",
  );
} finally {
  pilotDirectory.clear({
    sourceID: INDUSTRIAL_HIRELING_PILOT_SOURCE_ID,
  });
  pilotDirectory.clear({
    sourceID: AMBIENT_SOURCE_ID,
  });
}
