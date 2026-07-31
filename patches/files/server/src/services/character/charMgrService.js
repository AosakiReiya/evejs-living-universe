/**
 * Character Manager Service (charMgr)
 *
 * Handles character info queries post-selection.
 * Different from charUnboundMgr — this is bound to a specific character.
 */

const path = require("path");
const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  getCharacterRecord,
  resolveHomeStationInfo,
  updateCharacterRecord,
} = require(path.join(__dirname, "./characterState"));
const livingUniversePilotDirectory = require(path.join(
  __dirname,
  "../../space/npc/ambientTraffic/livingUniversePilotDirectory",
));
const {
  resolvePaperDollState,
} = require(path.join(__dirname, "./paperDollPayloads"));
const {
  normalizeCharacterGender,
} = require(path.join(__dirname, "./characterIdentity"));
const {
  getStationRecord,
} = require(path.join(__dirname, "../_shared/stationStaticData"));
const {
  buildCachedMethodCallResult,
} = require(path.join(__dirname, "../cache/objectCacheRuntime"));
const {
  buildList,
  buildDict,
  extractList,
  buildFiletimeLong,
  buildKeyVal,
  buildRow,
  buildRowset,
  extractDictEntries,
  unwrapMarshalValue,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  CharMgrGlobalAssets,
} = require(path.join(__dirname, "./charMgrGlobalAssets"));
const {
  deleteCharacterSetting,
  getCharacterSettings,
  setCharacterSetting,
} = require(path.join(__dirname, "./characterSettingsState"));
const {
  getCorporationMember,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
const {
  addLabelMask,
  allocateNextLabelID,
  removeLabelMask,
  toLabelKey,
  toMarshalMaskValue,
  toStoredMaskValue,
} = require(path.join(__dirname, "../corporation/contactLabelState"));
const {
  buildKillmailPayload,
  listKillmailsForCharacter,
} = require(path.join(__dirname, "../killmail/killmailState"));
const {
  listOwnerNotes,
  getOwnerNote,
  addOwnerNote,
  editOwnerNote,
  removeOwnerNote,
  getEntityNote,
  setEntityNote,
} = require(path.join(__dirname, "./characterNoteState"));

function resolvePublicCharacterRecord(characterID) {
  return (
    getCharacterRecord(characterID) ||
    (
      typeof livingUniversePilotDirectory.getPilotRecord === "function"
        ? livingUniversePilotDirectory.getPilotRecord(characterID)
        : null
    ) ||
    {}
  );
}

function resolveCharacterInfo(args, session) {
  const charId =
    args && args.length > 0 ? args[0] : session ? session.characterID : 0;

  return {
    charId,
    charData: resolvePublicCharacterRecord(charId),
  };
}

function sessionCharacterID(session) {
  return Number(
    session &&
    (session.characterID || session.charID || session.charid || 0),
  ) || 0;
}

function normalizeInteger(value, fallback = 0) {
  const unwrapped = unwrapMarshalValue(value);
  const numeric = Number(unwrapped);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.trunc(numeric);
}

function normalizeBoolean(value, fallback = false) {
  const unwrapped = unwrapMarshalValue(value);
  if (unwrapped === undefined || unwrapped === null) {
    return fallback;
  }
  if (typeof unwrapped === "string") {
    const normalized = unwrapped.trim().toLowerCase();
    if (!normalized) {
      return fallback;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
    if (normalized === "true" || normalized === "1") {
      return true;
    }
  }
  return Boolean(unwrapped);
}

function extractKwarg(kwargs, key) {
  return extractDictEntries(kwargs).find(([entryKey]) => entryKey === key)?.[1];
}

function normalizePersonalContacts(record = {}) {
  const source =
    record.personalContacts && typeof record.personalContacts === "object"
      ? record.personalContacts
      : {};
  const contacts = {};

  for (const [rawContactID, rawContact] of Object.entries(source)) {
    const contactID = normalizeInteger(
      rawContact && rawContact.contactID !== undefined
        ? rawContact.contactID
        : rawContactID,
      0,
    );
    if (!(contactID > 0)) {
      continue;
    }
    contacts[String(contactID)] = {
      contactID,
      inWatchlist: normalizeBoolean(rawContact && rawContact.inWatchlist, false),
      relationshipID: normalizeInteger(rawContact && rawContact.relationshipID, 0),
      labelMask: toStoredMaskValue(rawContact && rawContact.labelMask),
    };
  }

  return contacts;
}

const INDUSTRIAL_CREW_RELATIONSHIP_ID = 10;
const INDUSTRIAL_CREW_PILOT_SOURCE_ID = "industrial_hirelings";
const ACTIVE_INDUSTRIAL_CREW_CONTRACT_STATES = new Set([
  "active",
  "paused",
]);

function listOwnedIndustrialCrewContracts(characterID) {
  const normalizedCharacterID = normalizeInteger(characterID, 0);
  if (!(normalizedCharacterID > 0)) {
    return [];
  }
  try {
    const contractService = require(path.join(
      __dirname,
      "../industrialHirelings/industrialHirelingContracts",
    )).getDefaultContractService();
    const result = contractService.listForCharacter(normalizedCharacterID);
    return result &&
      result.success === true &&
      result.data &&
      Array.isArray(result.data.contracts)
      ? result.data.contracts
      : [];
  } catch (_error) {
    return [];
  }
}

function listIndustrialCrewPilotIDs(contract) {
  const memberPilotIDs = Array.isArray(contract && contract.members)
    ? contract.members.map((member) =>
        normalizeInteger(member && member.pilotIdentityID, 0),
      )
    : [];
  const legacyPilotID = normalizeInteger(
    contract && contract.pilotIdentityID,
    0,
  );
  return [...new Set([
    ...memberPilotIDs,
    legacyPilotID,
  ].filter((characterID) => characterID > 0))];
}

function mergeOwnedIndustrialCrewContacts(
  contacts,
  contracts,
  ownerCharacterID,
) {
  const normalizedOwnerCharacterID = normalizeInteger(ownerCharacterID, 0);
  const merged = {
    ...(contacts && typeof contacts === "object" ? contacts : {}),
  };
  for (const contract of Array.isArray(contracts) ? contracts : []) {
    if (
      normalizeInteger(contract && contract.ownerCharacterID, 0) !==
        normalizedOwnerCharacterID ||
      !ACTIVE_INDUSTRIAL_CREW_CONTRACT_STATES.has(
        String(contract && contract.state || ""),
      )
    ) {
      continue;
    }
    for (const contactID of listIndustrialCrewPilotIDs(contract)) {
      const pilot = livingUniversePilotDirectory.getPilotRecord(contactID);
      if (
        !pilot ||
        String(pilot.pilotSourceID || "") !==
          INDUSTRIAL_CREW_PILOT_SOURCE_ID
      ) {
        continue;
      }
      const existing = merged[String(contactID)] || {};
      merged[String(contactID)] = {
        ...existing,
        contactID,
        inWatchlist: normalizeBoolean(existing.inWatchlist, false),
        relationshipID: INDUSTRIAL_CREW_RELATIONSHIP_ID,
        labelMask: toStoredMaskValue(existing.labelMask),
      };
    }
  }
  return merged;
}

function normalizePersonalContactLabels(record = {}) {
  const source =
    record.personalContactLabels && typeof record.personalContactLabels === "object"
      ? record.personalContactLabels
      : {};
  const labels = {};

  for (const [rawLabelID, rawLabel] of Object.entries(source)) {
    const labelKey = toLabelKey(rawLabelID, null);
    if (!labelKey) {
      continue;
    }
    const label = rawLabel && typeof rawLabel === "object" ? rawLabel : {};
    labels[labelKey] = {
      name: toPlainString(label.name, ""),
      color: normalizeInteger(label.color, 0),
    };
  }

  return labels;
}

function normalizeBlockedOwners(record = {}) {
  const source =
    record.blockedOwners && typeof record.blockedOwners === "object"
      ? record.blockedOwners
      : {};
  const blocked = {};

  for (const [rawOwnerID, rawBlocked] of Object.entries(source)) {
    const ownerID = normalizeInteger(
      rawBlocked && rawBlocked.senderID !== undefined
        ? rawBlocked.senderID
        : rawBlocked && rawBlocked.contactID !== undefined
          ? rawBlocked.contactID
          : rawOwnerID,
      0,
    );
    if (ownerID > 0) {
      blocked[String(ownerID)] = {
        senderID: ownerID,
      };
    }
  }

  return blocked;
}

function buildContactRow(contact) {
  return [
    normalizeInteger(contact && contact.contactID, 0),
    normalizeBoolean(contact && contact.inWatchlist, false) ? 1 : 0,
    normalizeInteger(contact && contact.relationshipID, 0),
    toMarshalMaskValue(contact && contact.labelMask),
  ];
}

function buildContactLabelKeyVal(labelID, label) {
  return buildKeyVal([
    ["labelID", toMarshalMaskValue(labelID)],
    ["name", toPlainString(label && label.name, "")],
    ["color", normalizeInteger(label && label.color, 0)],
  ]);
}

function buildBlockedRow(blocked) {
  const ownerID = normalizeInteger(
    blocked && (blocked.senderID ?? blocked.contactID),
    0,
  );
  return [ownerID];
}

function upsertPersonalContact(characterID, contactID, options = {}) {
  const normalizedContactID = normalizeInteger(contactID, 0);
  if (!(normalizedContactID > 0)) {
    return { success: false, errorMsg: "CONTACT_REQUIRED" };
  }

  return updateCharacterRecord(characterID, (record) => {
    const contacts = normalizePersonalContacts(record);
    const existing = contacts[String(normalizedContactID)] || {
      contactID: normalizedContactID,
      inWatchlist: false,
      relationshipID: 0,
      labelMask: 0,
    };
    contacts[String(normalizedContactID)] = {
      contactID: normalizedContactID,
      inWatchlist:
        options.inWatchlist !== undefined
          ? normalizeBoolean(options.inWatchlist, false)
          : normalizeBoolean(existing.inWatchlist, false),
      relationshipID:
        options.relationshipID !== undefined
          ? normalizeInteger(options.relationshipID, 0)
          : normalizeInteger(existing.relationshipID, 0),
      labelMask: toStoredMaskValue(existing.labelMask),
    };
    record.personalContacts = contacts;
    return record;
  });
}

function removePersonalContacts(characterID, contactIDs = []) {
  return updateCharacterRecord(characterID, (record) => {
    const contacts = normalizePersonalContacts(record);
    for (const contactID of contactIDs.map((value) => normalizeInteger(value, 0))) {
      delete contacts[String(contactID)];
    }
    record.personalContacts = contacts;
    return record;
  });
}

function updateBlockedOwners(characterID, ownerIDs = [], shouldBlock = true) {
  return updateCharacterRecord(characterID, (record) => {
    const blockedOwners = normalizeBlockedOwners(record);
    for (const ownerID of ownerIDs.map((value) => normalizeInteger(value, 0))) {
      if (!(ownerID > 0)) {
        continue;
      }
      if (shouldBlock) {
        blockedOwners[String(ownerID)] = {
          senderID: ownerID,
        };
      } else {
        delete blockedOwners[String(ownerID)];
      }
    }
    record.blockedOwners = blockedOwners;
    return record;
  });
}

function resolveHomeStationRecord(charData, session) {
  const homeStationInfo = resolveHomeStationInfo(charData, session);

  return {
    station: getStationRecord(session, homeStationInfo.homeStationID),
    homeStationInfo,
  };
}

function resolveCorporationChangeInfo(charId, charData, session) {
  const corporationID =
    Number(charData && charData.corporationID) ||
    Number(session && (session.corporationID || session.corpid)) ||
    0;
  const corporationMember =
    corporationID > 0 ? getCorporationMember(corporationID, charId) : null;
  const corporationDateTime =
    (corporationMember && corporationMember.startDate) ||
    (charData &&
      (charData.startDateTime ||
        (Array.isArray(charData.employmentHistory)
          ? charData.employmentHistory.find(
              (entry) =>
                Number(entry && entry.corporationID) === Number(corporationID),
            )?.startDate
          : null) ||
        charData.createDateTime)) ||
    null;

  return buildKeyVal([
    ["corporationID", corporationID || null],
    ["corporationDateTime", buildFiletimeLong(corporationDateTime)],
  ]);
}

function buildHomeStationPayload(station, homeStationInfo = {}) {
  return buildKeyVal([
    ["id", station.stationID],
    ["station_id", station.stationID],
    ["stationID", station.stationID],
    ["home_station_id", station.stationID],
    ["type_id", station.stationTypeID],
    ["typeID", station.stationTypeID],
    ["station_type_id", station.stationTypeID],
    ["name", station.stationName],
    ["station_name", station.stationName],
    ["stationName", station.stationName],
    ["solar_system_id", station.solarSystemID],
    ["solarSystemID", station.solarSystemID],
    ["constellation_id", station.constellationID],
    ["constellationID", station.constellationID],
    ["region_id", station.regionID],
    ["regionID", station.regionID],
    ["owner_id", station.ownerID],
    ["ownerID", station.ownerID],
    ["clone_station_id", homeStationInfo.cloneStationID || station.stationID],
    ["cloneStationID", homeStationInfo.cloneStationID || station.stationID],
    ["is_fallback", Boolean(homeStationInfo.isFallback)],
    ["isFallback", Boolean(homeStationInfo.isFallback)],
    ["stationTypeID", station.stationTypeID],
  ]);
}

function buildCloneEntries(entries = [], valueBuilder) {
  return buildDict(
    entries.map((entry, index) => [
      Number(entry.cloneID || entry.itemID || index + 1),
      valueBuilder(entry, index),
    ]),
  );
}

function buildPublicInfoEntries(charId, charData, session) {
  const factionID = charData.factionID ?? null;
  const empireID = charData.empireID ?? factionID;
  const corporationID =
    Number(charData.corporationID) ||
    Number(session && (session.corporationID || session.corpid)) ||
    1000009;
  const allianceID =
    Number(charData.allianceID) ||
    Number(session && (session.allianceID || session.allianceid)) ||
    null;
  const stationID =
    charData.stationID ??
    (session ? (session.stationID ?? session.stationid ?? null) : null);
  const solarSystemID =
    charData.solarSystemID || (session ? session.solarsystemid2 : 30000142);
  const createDateTime = buildFiletimeLong(charData.createDateTime);
  const startDateTime = buildFiletimeLong(
    charData.startDateTime || charData.createDateTime,
  );
  const securityStatus = Number(
    charData.securityStatus ?? charData.securityRating ?? 0,
  );

  return [
    ["characterID", charId],
    [
      "characterName",
      charData.characterName || (session ? session.characterName : "Unknown"),
    ],
    ["typeID", charData.typeID || 1373],
    ["raceID", charData.raceID || 1],
    ["bloodlineID", charData.bloodlineID || 1],
    ["ancestryID", charData.ancestryID || 1],
    ["corporationID", corporationID],
    ["allianceID", allianceID],
    ["factionID", factionID],
    ["empireID", empireID],
    ["schoolID", charData.schoolID ?? null],
    ["gender", normalizeCharacterGender(charData.gender, 1)],
    ["createDateTime", createDateTime],
    ["startDateTime", startDateTime],
    ["description", charData.description || ""],
    ["securityRating", securityStatus],
    ["securityStatus", securityStatus],
    ["bounty", Number(charData.bounty || 0)],
    ["title", charData.title || ""],
    ["shortName", charData.shortName || "none"],
    ["stationID", stationID],
    ["solarSystemID", solarSystemID],
    [
      "militiaFactionID",
      charData.militiaFactionID ?? charData.warFactionID ?? null,
    ],
    ["medal1GraphicID", charData.medal1GraphicID ?? null],
  ];
}

function toPlainString(value, fallback = "") {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }

  if (typeof value === "object") {
    if ("value" in value) {
      return toPlainString(value.value, fallback);
    }

    if ("str" in value) {
      return toPlainString(value.str, fallback);
    }
  }

  return fallback;
}

function buildOwnerNotePayload(noteID, label, noteText) {
  return buildList([
    buildKeyVal([
      ["noteID", Number(noteID) || 0],
      ["label", toPlainString(label, "")],
      ["note", toPlainString(noteText, "")],
    ]),
  ]);
}

class CharMgrService extends BaseService {
  constructor() {
    super("charMgr");
    this._globalAssets = new CharMgrGlobalAssets();
  }

  Handle_MachoResolveObject(args, session, kwargs) {
    const result = this._globalAssets.Handle_MachoResolveObject(args, session, kwargs);
    if (result !== null) {
      return result;
    }

    log.warn("[CharMgr] Unsupported MachoResolveObject bind params");
    return null;
  }

  async Handle_MachoBindObject(args, session, kwargs) {
    const result = await this._globalAssets.Handle_MachoBindObject(
      args,
      session,
      kwargs,
      async (boundObjectID, methodName, callArgs, callKwargs) => {
        const previousBoundObjectID = session ? session.currentBoundObjectID : null;
        try {
          if (session) {
            session.currentBoundObjectID = boundObjectID;
          }
          return await this.callMethod(methodName, callArgs, session, callKwargs);
        } finally {
          if (session) {
            session.currentBoundObjectID = previousBoundObjectID || null;
          }
        }
      },
    );
    if (result !== null) {
      return result;
    }

    log.warn("[CharMgr] Unsupported MachoBindObject bind params");
    return null;
  }

  Handle_ListStations(args, session, kwargs) {
    return this._globalAssets.Handle_ListStations(args, session, kwargs);
  }

  Handle_ListStationItems(args, session, kwargs) {
    return this._globalAssets.Handle_ListStationItems(args, session, kwargs);
  }

  Handle_List(args, session, kwargs) {
    return this._globalAssets.Handle_List(args, session, kwargs);
  }

  Handle_ListIncludingContainers(args, session, kwargs) {
    return this._globalAssets.Handle_ListIncludingContainers(args, session, kwargs);
  }

  Handle_GetAssetWorth(args, session, kwargs) {
    return this._globalAssets.Handle_GetAssetWorth(args, session, kwargs);
  }

  Handle_GetPublicInfo(args, session) {
    const { charId, charData } = resolveCharacterInfo(args, session);
    log.debug(`[CharMgr] GetPublicInfo(${charId})`);
    return buildKeyVal(buildPublicInfoEntries(charId, charData, session));
  }

  Handle_GetPublicInfo3(args, session) {
    const { charId, charData } = resolveCharacterInfo(args, session);
    log.debug(`[CharMgr] GetPublicInfo3(${charId})`);
    return {
      type: "list",
      items: [buildKeyVal(buildPublicInfoEntries(charId, charData, session))],
    };
  }

  Handle_GetOrganizationInfoForCharacters(args) {
    const characterIDs = extractList(args && args[0])
      .map((characterID) => Number(characterID) || 0)
      .filter((characterID) => characterID > 0);
    log.debug(`[CharMgr] GetOrganizationInfoForCharacters(${characterIDs.length})`);
    return buildDict(
      characterIDs.map((characterID) => {
        const character = resolvePublicCharacterRecord(characterID);
        return [
          characterID,
          buildKeyVal([
            ["corporationID", Number(character.corporationID) || 0],
            ["allianceID", Number(character.allianceID) || 0],
            [
              "warFactionID",
              Number(character.warFactionID ?? character.militiaFactionID) || 0,
            ],
          ]),
        ];
      }),
    );
  }

  Handle_GetTopBounties() {
    log.debug("[CharMgr] GetTopBounties");
    return { type: "list", items: [] };
  }

  Handle_GetCohortsForCharacter(args, session) {
    const charId = sessionCharacterID(session);
    log.debug(`[CharMgr] GetCohortsForCharacter(${charId || "unknown"})`);
    return buildList([]);
  }

  Handle_GetRecentShipKillsAndLosses(args, session) {
    const charId =
      (session && Number(session.currentBoundObjectID || 0)) ||
      (session && Number(session.characterID || session.charid || 0)) ||
      0;
    const limit = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const startKillID = args && args.length > 1 ? Number(args[1]) || 0 : 0;
    return {
      type: "list",
      items: listKillmailsForCharacter(charId, {
        limit,
        startKillID,
      }).map((record) => buildKillmailPayload(record)),
    };
  }

  Handle_GetPrivateInfo(args, session) {
    log.debug("[CharMgr] GetPrivateInfo");
    const { charId, charData } = resolveCharacterInfo(args, session);
    return buildRow(
      [
        "characterID",
        "gender",
        "createDateTime",
        "raceID",
        "bloodlineID",
        "ancestryID",
        "balance",
        "securityRating",
      ],
      [
        charId,
        normalizeCharacterGender(charData.gender, 1),
        buildFiletimeLong(charData.createDateTime),
        charData.raceID || 1,
        charData.bloodlineID || 1,
        charData.ancestryID || 1,
        Number(charData.balance ?? 0),
        Number(charData.securityStatus ?? charData.securityRating ?? 0),
      ],
    );
  }

  Handle_GetPrivateInfoOnCorpChange(args, session) {
    const { charId, charData } = resolveCharacterInfo(args, session);
    log.debug(`[CharMgr] GetPrivateInfoOnCorpChange(${charId})`);
    return buildCachedMethodCallResult(
      resolveCorporationChangeInfo(charId, charData, session),
      {
        serviceName: this.name,
        method: "GetPrivateInfoOnCorpChange",
        args,
        sessionInfo: "charid",
        sessionInfoValue: charId,
      },
    );
  }

  Handle_GetCharacterDescription(args, session) {
    const { charData } = resolveCharacterInfo(args, session);
    log.debug("[CharMgr] GetCharacterDescription");
    return charData.description || "";
  }

  Handle_GetCloneInfo(args, session) {
    log.debug("[CharMgr] GetCloneInfo");
    const { charData } = resolveCharacterInfo(args, session);
    const { station, homeStationInfo } = resolveHomeStationRecord(charData, session);

    return buildKeyVal([
      ["homeStationID", station.stationID],
      [
        "cloneStationID",
        Number(homeStationInfo.cloneStationID || station.stationID) || station.stationID,
      ],
      [
        "clones",
        buildCloneEntries(charData.jumpClones || [], (entry) =>
          buildKeyVal([
            ["cloneID", Number(entry.cloneID || 0)],
            ["name", entry.name || station.stationName],
            ["stationID", Number(entry.stationID || station.stationID)],
            ["solarSystemID", Number(entry.solarSystemID || station.solarSystemID)],
          ]),
        ),
      ],
      [
        "implants",
        buildCloneEntries(charData.implants || [], (entry) =>
          buildKeyVal([
            ["typeID", Number(entry.typeID || 0)],
            ["name", entry.name || ""],
            ["slot", Number(entry.slot || 0)],
          ]),
        ),
      ],
      ["timeLastJump", buildFiletimeLong(charData.timeLastCloneJump || 0n)],
    ]);
  }

  Handle_GetHomeStation(args, session) {
    log.debug("[CharMgr] GetHomeStation");
    const { charData } = resolveCharacterInfo(args, session);
    const { station, homeStationInfo } = resolveHomeStationRecord(charData, session);
    return buildHomeStationPayload(station, homeStationInfo);
  }

  Handle_GetHomeStationRow(args, session) {
    log.debug("[CharMgr] GetHomeStationRow");

    // V23.02 mapView.py calls:
    //   homeStationRow = sm.GetService('charactersheet').GetHomeStationRow()
    // and then reads:
    //   homeStationRow.stationID
    //   homeStationRow.solarSystemID
    //   homeStationRow.stationTypeID
    //
    // Returning None crashes StarMap with:
    //   AttributeError: 'NoneType' object has no attribute 'stationID'
    //
    // The existing home-station KeyVal payload already exposes those fields,
    // so reuse it for the row-style call.
    return this.Handle_GetHomeStation(args, session);
  }

  Handle_getHomeStationRow(args, session) {
    return this.Handle_GetHomeStationRow(args, session);
  }

  Handle_get_home_station_row(args, session) {
    return this.Handle_GetHomeStationRow(args, session);
  }

  Handle_LogStartOfCharacterCreation() {
    log.debug("[CharMgr] LogStartOfCharacterCreation");
    return null;
  }

  // Paperdoll.State:
  // 0=NoRecustomization, 1=Resculpting, 2=NoExistingCustomization,
  // 3=FullRecustomizing, 4=ForceRecustomize
  Handle_GetPaperdollState(args, session) {
    const { charId, charData } = resolveCharacterInfo(args, session);
    const paperDollState = resolvePaperDollState(charData, 2);
    log.debug(`[CharMgr] GetPaperdollState(${charId}) -> ${paperDollState}`);
    return paperDollState;
  }

  Handle_GetCharacterCreationDate(args, session) {
    const { charId, charData } = resolveCharacterInfo(args, session);
    log.debug(`[CharMgr] GetCharacterCreationDate(${charId})`);
    return buildFiletimeLong(charData.createDateTime);
  }

  Handle_GetCharacterSettings(args, session) {
    log.debug("[CharMgr] GetCharacterSettings called");
    const characterID = sessionCharacterID(session);
    return buildDict(
      Object.entries(getCharacterSettings(characterID)).sort(([left], [right]) => (
        String(left).localeCompare(String(right))
      )),
    );
  }

  Handle_GetSettingsInfo() {
    log.debug("[CharMgr] GetSettingsInfo called");
    const py2codeHex =
      "630000000000000000010000004300000073040000006900005328010000004e280000000028000000002800000000280000000073080000003c737472696e673e740100000066010000007300000000";
    return [Buffer.from(py2codeHex, "hex"), 0];
  }

  Handle_GetContactList(args, session) {
    log.debug("[CharMgr] GetContactList called");
    const characterID = sessionCharacterID(session);
    const character = getCharacterRecord(characterID) || {};
    const contacts = Object.values(mergeOwnedIndustrialCrewContacts(
      normalizePersonalContacts(character),
      listOwnedIndustrialCrewContracts(characterID),
      characterID,
    )).sort(
      (left, right) => Number(left.contactID) - Number(right.contactID),
    );
    const blockedOwners = Object.values(normalizeBlockedOwners(character)).sort(
      (left, right) => Number(left.senderID) - Number(right.senderID),
    );
    return buildKeyVal([
      [
        "addresses",
        buildRowset(
          ["contactID", "inWatchlist", "relationshipID", "labelMask"],
          contacts.map((contact) => buildContactRow(contact)),
          "eve.common.script.sys.rowset.Rowset",
        ),
      ],
      [
        "blocked",
        buildRowset(
          ["senderID"],
          blockedOwners.map((blocked) => buildBlockedRow(blocked)),
          "eve.common.script.sys.rowset.Rowset",
        ),
      ],
    ]);
  }

  Handle_GetLabels(args, session) {
    const characterID = sessionCharacterID(session);
    const character = getCharacterRecord(characterID) || {};
    const labels = normalizePersonalContactLabels(character);
    return buildDict(
      Object.entries(labels).map(([labelID, label]) => [
        toMarshalMaskValue(labelID),
        buildContactLabelKeyVal(labelID, label),
      ]),
    );
  }

  Handle_CreateLabel(args, session) {
    const characterID = sessionCharacterID(session);
    const name = toPlainString(args && args[0], "").trim();
    const color = normalizeInteger(args && args[1], 0);
    let labelID = null;
    updateCharacterRecord(characterID, (record) => {
      const labels = normalizePersonalContactLabels(record);
      const meta =
        record.personalContactLabelMeta &&
        typeof record.personalContactLabelMeta === "object"
          ? { ...record.personalContactLabelMeta }
          : {};
      const allocation = allocateNextLabelID(labels, meta.nextLabelID || 1);
      labelID = allocation.labelID;
      labels[allocation.labelKey] = { name, color };
      meta.nextLabelID = allocation.nextLabelID;
      record.personalContactLabels = labels;
      record.personalContactLabelMeta = meta;
      return record;
    });
    return labelID;
  }

  Handle_DeleteLabel(args, session) {
    const characterID = sessionCharacterID(session);
    const labelKey = toLabelKey(args && args[0], null);
    if (!labelKey) {
      return null;
    }
    updateCharacterRecord(characterID, (record) => {
      const labels = normalizePersonalContactLabels(record);
      const contacts = normalizePersonalContacts(record);
      delete labels[labelKey];
      for (const contact of Object.values(contacts)) {
        contact.labelMask = removeLabelMask(contact.labelMask, labelKey);
      }
      record.personalContactLabels = labels;
      record.personalContacts = contacts;
      return record;
    });
    return null;
  }

  Handle_EditLabel(args, session) {
    const characterID = sessionCharacterID(session);
    const labelKey = toLabelKey(args && args[0], null);
    if (!labelKey) {
      return null;
    }
    const name = args && args.length > 1 ? toPlainString(args[1], "") : undefined;
    const color = args && args.length > 2 ? normalizeInteger(args[2], 0) : undefined;
    updateCharacterRecord(characterID, (record) => {
      const labels = normalizePersonalContactLabels(record);
      const label = labels[labelKey] || { name: "", color: 0 };
      if (name !== undefined) {
        label.name = name;
      }
      if (color !== undefined) {
        label.color = color;
      }
      labels[labelKey] = label;
      record.personalContactLabels = labels;
      return record;
    });
    return null;
  }

  Handle_AssignLabels(args, session) {
    const characterID = sessionCharacterID(session);
    const contactIDs = extractList(args && args[0]);
    const labelMask = toLabelKey(args && args[1], "0");
    updateCharacterRecord(characterID, (record) => {
      const contacts = normalizePersonalContacts(record);
      for (const rawContactID of contactIDs) {
        const contactID = normalizeInteger(rawContactID, 0);
        if (!(contactID > 0)) {
          continue;
        }
        const key = String(contactID);
        const contact = contacts[key] || {
          contactID,
          inWatchlist: false,
          relationshipID: 0,
          labelMask: 0,
        };
        contact.labelMask = addLabelMask(contact.labelMask, labelMask);
        contacts[key] = contact;
      }
      record.personalContacts = contacts;
      return record;
    });
    return null;
  }

  Handle_RemoveLabels(args, session) {
    const characterID = sessionCharacterID(session);
    const contactIDs = extractList(args && args[0]);
    const labelMask = toLabelKey(args && args[1], "0");
    updateCharacterRecord(characterID, (record) => {
      const contacts = normalizePersonalContacts(record);
      for (const rawContactID of contactIDs) {
        const contactID = normalizeInteger(rawContactID, 0);
        if (contacts[String(contactID)]) {
          contacts[String(contactID)].labelMask = removeLabelMask(
            contacts[String(contactID)].labelMask,
            labelMask,
          );
        }
      }
      record.personalContacts = contacts;
      return record;
    });
    return null;
  }

  Handle_AddContact(args, session) {
    const characterID = sessionCharacterID(session);
    const contactID = normalizeInteger(args && args[0], 0);
    const relationshipID =
      args && args.length > 1 ? normalizeInteger(args[1], 0) : 0;
    const inWatchlist =
      args && args.length > 2 ? normalizeBoolean(args[2], false) : false;
    log.debug(`[CharMgr] AddContact(${characterID}, ${contactID})`);
    upsertPersonalContact(characterID, contactID, {
      relationshipID,
      inWatchlist,
    });
    return null;
  }

  Handle_EditContact(args, session) {
    return this.Handle_AddContact(args, session);
  }

  Handle_DeleteContacts(args, session) {
    const characterID = sessionCharacterID(session);
    const contactIDs = extractList(args && args[0]);
    log.debug(`[CharMgr] DeleteContacts(${characterID}, ${contactIDs.length})`);
    removePersonalContacts(characterID, contactIDs);
    return null;
  }

  Handle_EditContactsRelationshipID(args, session) {
    const characterID = sessionCharacterID(session);
    const contactIDs = extractList(args && args[0]);
    const relationshipID = normalizeInteger(args && args[1], 0);
    log.debug(
      `[CharMgr] EditContactsRelationshipID(${characterID}, ${contactIDs.length}, ${relationshipID})`,
    );
    for (const contactID of contactIDs) {
      upsertPersonalContact(characterID, contactID, {
        relationshipID,
      });
    }
    return null;
  }

  Handle_BlockOwners(args, session) {
    const characterID = sessionCharacterID(session);
    const ownerIDs = extractList(args && args[0]);
    log.debug(`[CharMgr] BlockOwners(${characterID}, ${ownerIDs.length})`);
    updateBlockedOwners(characterID, ownerIDs, true);
    return null;
  }

  Handle_UnblockOwners(args, session) {
    const characterID = sessionCharacterID(session);
    const ownerIDs = extractList(args && args[0]);
    log.debug(`[CharMgr] UnblockOwners(${characterID}, ${ownerIDs.length})`);
    updateBlockedOwners(characterID, ownerIDs, false);
    return null;
  }

  Handle_SetCharacterDescription(args, session) {
    const characterID = sessionCharacterID(session);
    const description = toPlainString(args && args[0], "").slice(0, 2500);
    log.debug(`[CharMgr] SetCharacterDescription(${characterID})`);
    updateCharacterRecord(characterID, (record) => ({
      ...record,
      description,
    }));
    return null;
  }

  Handle_SetActivityStatus(args, session, kwargs) {
    const characterID = sessionCharacterID(session);
    const status = normalizeInteger(
      extractKwarg(kwargs, "status") ?? (args && args[0]),
      0,
    );
    const extraInfo = unwrapMarshalValue(
      extractKwarg(kwargs, "extraInfo") ?? (args && args[1]) ?? null,
    );
    log.debug(`[CharMgr] SetActivityStatus(${characterID}, ${status})`);
    updateCharacterRecord(characterID, (record) => ({
      ...record,
      activityStatus: status,
      activityStatusExtraInfo:
        extraInfo === undefined || extraInfo === null ? null : String(extraInfo),
    }));
    return null;
  }

  Handle_LogSettings(args, session) {
    const characterID = sessionCharacterID(session);
    const settings = unwrapMarshalValue(args && args[0]);
    log.debug(`[CharMgr] LogSettings(${characterID})`);
    updateCharacterRecord(characterID, (record) => ({
      ...record,
      lastSettingsTelemetry:
        settings && typeof settings === "object" ? settings : {},
    }));
    return null;
  }

  Handle_GetOwnerNoteLabels(args, session) {
    const characterID = sessionCharacterID(session);
    log.debug(`[CharMgr] GetOwnerNoteLabels(${characterID})`);

    return buildRowset(
      ["noteID", "label"],
      listOwnerNotes(characterID).map((entry) => [
        Number(entry.noteID) || 0,
        entry.label || "",
      ]),
      "eve.common.script.sys.rowset.Rowset",
    );
  }

  Handle_GetOwnerNote(args, session) {
    const characterID = sessionCharacterID(session);
    const noteID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    log.debug(`[CharMgr] GetOwnerNote(${characterID}, ${noteID})`);

    const note = getOwnerNote(characterID, noteID);
    if (!note) {
      return buildOwnerNotePayload(noteID, "", "");
    }

    return buildOwnerNotePayload(note.noteID, note.label, note.note);
  }

  Handle_AddOwnerNote(args, session) {
    const characterID = sessionCharacterID(session);
    const label = args && args.length > 0 ? args[0] : "";
    const noteText = args && args.length > 1 ? args[1] : "";
    log.debug(`[CharMgr] AddOwnerNote(${characterID}, ${toPlainString(label, "")})`);
    return addOwnerNote(characterID, label, noteText);
  }

  Handle_EditOwnerNote(args, session) {
    const characterID = sessionCharacterID(session);
    const noteID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const label = args && args.length > 1 ? args[1] : undefined;
    const noteText = args && args.length > 2 ? args[2] : undefined;
    log.debug(`[CharMgr] EditOwnerNote(${characterID}, ${noteID})`);
    editOwnerNote(characterID, noteID, label, noteText);
    return null;
  }

  Handle_RemoveOwnerNote(args, session) {
    const characterID = sessionCharacterID(session);
    const noteID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    log.debug(`[CharMgr] RemoveOwnerNote(${characterID}, ${noteID})`);
    removeOwnerNote(characterID, noteID);
    return null;
  }

  Handle_GetNote(args, session) {
    const characterID = sessionCharacterID(session);
    const itemID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    log.debug(`[CharMgr] GetNote(${characterID}, ${itemID})`);
    return getEntityNote(characterID, itemID);
  }

  Handle_SetNote(args, session) {
    const characterID = sessionCharacterID(session);
    const itemID = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const noteText = args && args.length > 1 ? args[1] : "";
    log.debug(`[CharMgr] SetNote(${characterID}, ${itemID})`);
    setEntityNote(characterID, itemID, noteText);
    return null;
  }

  Handle_SaveCharacterSetting(args, session) {
    const settingKey = args && args.length > 0 ? args[0] : null;
    const settingValue = args && args.length > 1 ? args[1] : null;
    setCharacterSetting(sessionCharacterID(session), settingKey, settingValue);
    return null;
  }

  Handle_DeleteCharacterSetting(args, session) {
    const settingKey = args && args.length > 0 ? args[0] : null;
    deleteCharacterSetting(sessionCharacterID(session), settingKey);
    return null;
  }
}

module.exports = CharMgrService;
module.exports._testing = {
  INDUSTRIAL_CREW_RELATIONSHIP_ID,
  listIndustrialCrewPilotIDs,
  mergeOwnedIndustrialCrewContacts,
};
