"use strict";

const path = require("path");

const INDUSTRIAL_HIRELING_PILOT_SOURCE_ID = "industrial_hirelings";
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const ZERO_ROLE_FIELDS = Object.freeze([
  "roles",
  "grantableRoles",
  "rolesAtHQ",
  "grantableRolesAtHQ",
  "rolesAtBase",
  "grantableRolesAtBase",
  "rolesAtOther",
  "grantableRolesAtOther",
]);

function cloneValue(value) {
  return value === undefined
    ? undefined
    : JSON.parse(JSON.stringify(value));
}

function toPositiveInteger(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function currentFiletimeString() {
  return (
    (BigInt(Date.now()) * FILETIME_TICKS_PER_MS) +
    FILETIME_EPOCH_OFFSET
  ).toString();
}

function toFiletimeString(value, fallback = currentFiletimeString()) {
  if (typeof value === "bigint" && value > 0n) {
    return value.toString();
  }
  if (
    typeof value === "string" &&
    /^\d+$/.test(value.trim())
  ) {
    try {
      const numeric = BigInt(value.trim());
      if (numeric > 0n) {
        return numeric.toString();
      }
    } catch (_error) {
      // Fall through to ISO/Date parsing.
    }
  }
  const unixMs =
    value instanceof Date
      ? value.getTime()
      : Date.parse(String(value || ""));
  if (Number.isFinite(unixMs) && unixMs >= 0) {
    return (
      (BigInt(Math.trunc(unixMs)) * FILETIME_TICKS_PER_MS) +
      FILETIME_EPOCH_OFFSET
    ).toString();
  }
  return fallback;
}

function getDefaultPilotDirectory() {
  return require(path.join(
    __dirname,
    "../../space/npc/ambientTraffic/livingUniversePilotDirectory",
  ));
}

function getDefaultCorporationRuntimeState() {
  return require("./corporationRuntimeState");
}

function isEligibleIndustrialHirelingPilot(
  pilot,
  corporationID,
) {
  const numericCorporationID = toPositiveInteger(
    corporationID,
    0,
  );
  return Boolean(
    pilot &&
    pilot.syntheticNpcPilot === true &&
    pilot.loginDisabled === true &&
    toPositiveInteger(pilot.accountID, 0) === 0 &&
    String(pilot.pilotSourceID || "") ===
      INDUSTRIAL_HIRELING_PILOT_SOURCE_ID &&
    toPositiveInteger(pilot.characterID, 0) > 0 &&
    numericCorporationID > 0 &&
    toPositiveInteger(pilot.corporationID, 0) ===
      numericCorporationID
  );
}

function buildReadOnlyEmployeeMember(
  pilot,
  nowFiletime = currentFiletimeString(),
) {
  if (
    !isEligibleIndustrialHirelingPilot(
      pilot,
      pilot && pilot.corporationID,
    )
  ) {
    return null;
  }
  const startDate = toFiletimeString(
    pilot.startDateTime || pilot.createDateTime,
    nowFiletime,
  );
  const online =
    pilot.corporationChatVisible === true ||
    pilot.localVisible === true;
  const member = {
    characterID: toPositiveInteger(pilot.characterID, 0),
    corporationID: toPositiveInteger(
      pilot.corporationID,
      0,
    ),
    divisionID: 0,
    squadronID: 0,
    title:
      String(pilot.title || "").trim() ||
      "Industrial Crew",
    startDate,
    rowDate: startDate,
    baseID: null,
    titleMask: 0,
    blockRoles: null,
    // The client row shape requires an account-key field. Zero deliberately
    // represents no corporation wallet division or wallet authority.
    accountKey: 0,
    isCEO: false,
    lastOnline: startDate,
    locationID: toPositiveInteger(
      pilot.stationID,
      toPositiveInteger(pilot.solarSystemID, null),
    ),
    shipTypeID: toPositiveInteger(pilot.shipTypeID, null),
    allianceID: toPositiveInteger(pilot.allianceID, null),
    factionID: toPositiveInteger(
      pilot.warFactionID || pilot.militiaFactionID,
      null,
    ),
    readOnlySyntheticEmployee: true,
    syntheticOnline: online,
    syntheticSourceID:
      INDUSTRIAL_HIRELING_PILOT_SOURCE_ID,
  };
  for (const fieldName of ZERO_ROLE_FIELDS) {
    member[fieldName] = "0";
  }
  return member;
}

function createCorporationReadOnlyEmployeeProjection(
  options = {},
) {
  const pilotDirectory =
    options.pilotDirectory || getDefaultPilotDirectory();
  const corporationRuntimeState =
    options.corporationRuntimeState ||
    getDefaultCorporationRuntimeState();

  function listCanonicalMembers(corporationID) {
    if (
      typeof options.listCanonicalMembers === "function"
    ) {
      return options.listCanonicalMembers(corporationID);
    }
    return corporationRuntimeState.listCorporationMembers(
      corporationID,
    );
  }

  function getCanonicalMember(
    corporationID,
    characterID,
  ) {
    if (
      typeof options.getCanonicalMember === "function"
    ) {
      return options.getCanonicalMember(
        corporationID,
        characterID,
      );
    }
    return corporationRuntimeState.getCorporationMember(
      corporationID,
      characterID,
    );
  }

  function listSyntheticEmployees(corporationID) {
    const numericCorporationID = toPositiveInteger(
      corporationID,
      0,
    );
    if (
      !numericCorporationID ||
      !pilotDirectory ||
      typeof pilotDirectory.listPilots !== "function"
    ) {
      return [];
    }
    const nowFiletime = currentFiletimeString();
    return pilotDirectory
      .listPilots()
      .filter((pilot) =>
        isEligibleIndustrialHirelingPilot(
          pilot,
          numericCorporationID,
        ))
      .map((pilot) =>
        buildReadOnlyEmployeeMember(
          pilot,
          nowFiletime,
        ))
      .filter(Boolean)
      .sort(
        (left, right) =>
          left.characterID - right.characterID,
      );
  }

  function listMembersForRead(corporationID) {
    const rawCanonicalMembers =
      listCanonicalMembers(corporationID);
    const canonicalMembers = (
      Array.isArray(rawCanonicalMembers)
        ? rawCanonicalMembers
        : []
    ).map(cloneValue);
    const canonicalIDs = new Set(
      canonicalMembers.map((member) =>
        toPositiveInteger(member && member.characterID, 0)),
    );
    return [
      ...canonicalMembers,
      ...listSyntheticEmployees(corporationID).filter(
        (member) =>
          !canonicalIDs.has(
            toPositiveInteger(member.characterID, 0),
          ),
      ),
    ].sort(
      (left, right) =>
        toPositiveInteger(left && left.characterID, 0) -
        toPositiveInteger(right && right.characterID, 0),
    );
  }

  function getMemberForRead(corporationID, characterID) {
    const canonicalMember = getCanonicalMember(
      corporationID,
      characterID,
    );
    if (canonicalMember) {
      return cloneValue(canonicalMember);
    }
    if (
      !pilotDirectory ||
      typeof pilotDirectory.getPilotRecord !== "function"
    ) {
      return null;
    }
    const pilot = pilotDirectory.getPilotRecord(characterID);
    if (
      !isEligibleIndustrialHirelingPilot(
        pilot,
        corporationID,
      )
    ) {
      return null;
    }
    return buildReadOnlyEmployeeMember(pilot);
  }

  function getSyntheticEmployeeForRead(characterID) {
    if (
      !pilotDirectory ||
      typeof pilotDirectory.getPilotRecord !== "function"
    ) {
      return null;
    }
    const pilot = pilotDirectory.getPilotRecord(characterID);
    if (
      !isEligibleIndustrialHirelingPilot(
        pilot,
        pilot && pilot.corporationID,
      )
    ) {
      return null;
    }
    return buildReadOnlyEmployeeMember(pilot);
  }

  return Object.freeze({
    getMemberForRead,
    getSyntheticEmployeeForRead,
    listMembersForRead,
    listSyntheticEmployees,
  });
}

let defaultProjection = null;

function getDefaultProjection() {
  if (!defaultProjection) {
    defaultProjection =
      createCorporationReadOnlyEmployeeProjection();
  }
  return defaultProjection;
}

function listCorporationMembersForRead(corporationID) {
  return getDefaultProjection().listMembersForRead(
    corporationID,
  );
}

function getCorporationMemberForRead(
  corporationID,
  characterID,
) {
  return getDefaultProjection().getMemberForRead(
    corporationID,
    characterID,
  );
}

function getSyntheticCorporationEmployeeForRead(characterID) {
  return getDefaultProjection().getSyntheticEmployeeForRead(
    characterID,
  );
}

module.exports = {
  INDUSTRIAL_HIRELING_PILOT_SOURCE_ID,
  ZERO_ROLE_FIELDS,
  buildReadOnlyEmployeeMember,
  createCorporationReadOnlyEmployeeProjection,
  getCorporationMemberForRead,
  getSyntheticCorporationEmployeeForRead,
  isEligibleIndustrialHirelingPilot,
  listCorporationMembersForRead,
  _testing: {
    currentFiletimeString,
    toFiletimeString,
  },
};
