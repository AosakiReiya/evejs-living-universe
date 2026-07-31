const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
const {
  buildBoundObjectResponse,
  buildDbIndexRowset,
  buildDbRowset,
  buildDict,
  buildFiletimeLong,
  buildKeyVal,
  buildList,
  buildPackedRow,
  buildPagedResultSet,
  buildRow,
  buildRowset,
  currentFileTime,
  extractList,
} = require(path.join(__dirname, "../_shared/serviceHelpers"));
const {
  buildCachedMethodCallResult,
} = require(path.join(__dirname, "../cache/objectCacheRuntime"));
const {
  findSessionByCharacterID,
} = require(path.join(__dirname, "../chat/sessionRegistry"));
const {
  getCharacterRecord,
} = require(path.join(__dirname, "../character/characterState"));
const {
  resolveCharacterCreationSchoolProfile,
} = require(path.join(__dirname, "../character/characterCreationData"));
const {
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalance,
  buildNotEnoughMoneyUserErrorValues,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  getAllianceRecord,
  getCorporationInfoRecord,
  getCorporationOwnerRecord,
  getCorporationRecord,
  getOwnerLookupRecord,
  setCharacterAffiliation,
  NPC_STARTER_CORPORATION_ID,
} = require(path.join(__dirname, "./corporationState"));
const {
  CORP_ROLE_DIRECTOR,
  CORPORATION_WALLET_KEY_START,
  DEFAULT_STRUCTURE_REINFORCE_HOUR,
  FULL_ADMIN_ROLE_MASK,
  ensureCharacterMemberState,
  ensureRuntimeInitialized,
  getCorporationDivisionNames,
  getCorporationMember,
  getCorporationRuntime,
  getPageForMembers,
  listCorporationMembers,
  normalizeBoolean,
  normalizeInteger,
  normalizePositiveInteger,
  normalizeText,
  recordCorporationRoleHistory,
  toRoleMaskBigInt,
  updateAllianceRuntime,
  updateCorporationRecord,
  updateCorporationRuntime,
  updateRuntimeState,
  createAllianceWithRuntime,
  createCorporationWithRuntime,
  deleteCorporationWithRuntime,
  setCorporationAlliance,
  syncMemberStateToCharacterRecord,
} = require(path.join(__dirname, "./corporationRuntimeState"));
const {
  NO_REINFORCEMENT_WEEKDAY,
} = require(path.join(__dirname, "../structure/structureConstants"));
const {
  createWarRecord,
} = require(path.join(__dirname, "./warRuntimeState"));
const {
  buildCorporationMemberTrackingRowset,
  queryCorporationMemberIDs,
} = require(path.join(__dirname, "./corpMemberQueryState"));
const {
  getCorporationMemberForRead,
  getSyntheticCorporationEmployeeForRead,
  listCorporationMembersForRead,
} = require(path.join(
  __dirname,
  "./corpReadOnlyEmployeeProjection",
));
const {
  adjustCorporationWalletDivisionBalance,
  getCorporationWalletDivisionsInfo,
  getCorporationWalletBalance,
  normalizeCorporationWalletKey,
  setCorporationWalletDivisionBalance,
} = require(path.join(__dirname, "./corpWalletState"));
const {
  buildCorporationAllianceApplicationsIndexRowset,
} = require(path.join(__dirname, "./allianceViewState"));
const {
  executeCorporationMemberActions,
} = require(path.join(__dirname, "./corpMemberActionState"));
const {
  BILL_TYPE_WAR,
  createBill,
} = require(path.join(__dirname, "../account/billRuntimeState"));
const {
  getCharacterAllyBaseCost,
} = require(path.join(__dirname, "./warCostState"));
const {
  listKillmailsForCorporation,
} = require(path.join(__dirname, "../killmail/killmailState"));
const {
  sendCorporationWelcomeMailToCharacter,
} = require(path.join(__dirname, "../mail/mailState"));
const {
  buildAggressionSettingsPayload,
  readAggressionSettings,
  resolveFriendlyFireLegalAtTime,
  scheduleAggressionSettingsChange,
} = require(path.join(__dirname, "./aggressionSettingsState"));
const {
  addLabelMask,
  allocateNextLabelID,
  removeLabelMask,
  toLabelKey,
  toMarshalMaskValue,
} = require(path.join(__dirname, "./contactLabelState"));
const {
  buildAllianceApplicationSnapshot,
  buildCorporationApplicationRow,
  buildCorporationMemberSnapshot,
  buildCorporationSnapshot,
  notifyAllianceApplicationChanged,
  notifyAllianceChanged,
  notifyAllianceMemberChanged,
  notifyCorporationApplicationChanged,
  notifyCorporationChanged,
  notifyCorporationLiquidationShareTransfer,
  notifyCorporationMemberChanged,
  notifyCorporationRemoved,
  notifyCorporationWelcomeMailChanged,
  refreshCharacterSession,
} = require(path.join(__dirname, "./corporationNotifications"));
const {
  notifyCorporationApplicationAccepted,
  notifyCorporationApplicationAcceptedByCharacter,
  notifyCorporationApplicationInvited,
  notifyCorporationApplicationReceived,
  notifyCorporationApplicationRejected,
  notifyCorporationApplicationRejectedByCharacter,
  notifyCorporationApplicationWithdrawn,
} = require(path.join(__dirname, "./corpApplicationNotifications"));
const {
  notifyCorporationDividendPaid,
  notifyCorporationLiquidation,
  notifyCorporationMemberKicked,
  notifyCorporationMemberLeft,
  notifyCorporationNewCeo,
  notifyCorporationTaxRateChanged,
} = require(path.join(__dirname, "./corpLifecycleNotifications"));

const MEMBER_HEADER = [
  "characterID",
  "corporationID",
  "startDate",
  "title",
  "divisionID",
  "squadronID",
  "roles",
  "grantableRoles",
  "rolesAtHQ",
  "grantableRolesAtHQ",
  "rolesAtBase",
  "grantableRolesAtBase",
  "rolesAtOther",
  "grantableRolesAtOther",
  "baseID",
  "titleMask",
  "blockRoles",
  "accountKey",
  "isCEO",
  "lastOnline",
  "locationID",
  "shipTypeID",
];
const MEMBER_DBROW_COLUMNS = [
  ["characterID", 0x03],
  ["corporationID", 0x03],
  ["divisionID", 0x03],
  ["squadronID", 0x03],
  ["title", 0x82],
  ["roles", 0x40],
  ["grantableRoles", 0x40],
  ["startDateTime", 0x40],
  ["baseID", 0x03],
  ["rolesAtHQ", 0x40],
  ["grantableRolesAtHQ", 0x40],
  ["rolesAtBase", 0x40],
  ["grantableRolesAtBase", 0x40],
  ["rolesAtOther", 0x40],
  ["grantableRolesAtOther", 0x40],
  ["titleMask", 0x03],
  ["accountKey", 0x03],
  ["rowDate", 0x40],
  ["blockRoles", 0x0b],
  ["ownerName", 0x82],
];
const TITLE_HEADER = [
  "titleID",
  "titleName",
  "roles",
  "grantableRoles",
  "rolesAtHQ",
  "grantableRolesAtHQ",
  "rolesAtBase",
  "grantableRolesAtBase",
  "rolesAtOther",
  "grantableRolesAtOther",
];
const TITLE_DBROW_COLUMNS = [
  ["titleID", 0x03],
  ["titleName", 0x82],
  ["roles", 0x14],
  ["grantableRoles", 0x14],
  ["rolesAtHQ", 0x14],
  ["grantableRolesAtHQ", 0x14],
  ["rolesAtBase", 0x14],
  ["grantableRolesAtBase", 0x14],
  ["rolesAtOther", 0x14],
  ["grantableRolesAtOther", 0x14],
];
const BULLETIN_HEADER = [
  "bulletinID",
  "ownerID",
  "createDateTime",
  "editDateTime",
  "editCharacterID",
  "title",
  "body",
  "sortOrder",
];
const BULLETIN_DBROW_COLUMNS = [
  ["bulletinID", 0x03],
  ["ownerID", 0x03],
  ["createCharacterID", 0x03],
  ["createDateTime", 0x40],
  ["editCharacterID", 0x03],
  ["editDateTime", 0x40],
  ["title", 0x82],
  ["body", 0x82],
  ["sortOrder", 0x03],
];
const LABEL_DBROW_COLUMNS = [
  ["labelID", 0x14],
  ["name", 0x82],
  ["color", 0x03],
];
const KILLMAIL_DBROW_COLUMNS = [
  ["killID", 0x03],
  ["solarSystemID", 0x03],
  ["victimCharacterID", 0x03],
  ["victimCorporationID", 0x03],
  ["victimAllianceID", 0x03],
  ["victimFactionID", 0x03],
  ["victimShipTypeID", 0x03],
  ["finalCharacterID", 0x03],
  ["finalCorporationID", 0x03],
  ["finalAllianceID", 0x03],
  ["finalFactionID", 0x03],
  ["finalShipTypeID", 0x03],
  ["finalWeaponTypeID", 0x03],
  ["killBlob", 0x82],
  ["killTime", 0x40],
  ["victimDamageTaken", 0x03],
  ["finalSecurityStatus", 0x05],
  ["finalDamageDone", 0x03],
  ["moonID", 0x03],
  ["warID", 0x03],
  ["iskLost", 0x06],
  ["bountyClaimed", 0x06],
  ["loyaltyPoints", 0x03],
  ["iskDestroyed", 0x06],
  ["killRightSupplied", 0x03],
];
const OWNER_HEADER = [
  "ownerID",
  "ownerName",
  "typeID",
  "gender",
  "ownerNameID",
];
const SHAREHOLDER_HEADER = ["shareholderID", "corporationID", "shares"];
const SHAREHOLDER_DBROW_COLUMNS = [
  ["shareholderID", 0x03],
  ["corporationID", 0x03],
  ["shares", 0x03],
];
const DEFAULT_NPC_CORPORATION_ID = NPC_STARTER_CORPORATION_ID;
const CONCORD_CORPORATION_ID = 1000125;
const WAR_BILL_AMOUNT = 100000000;
const FILETIME_TICKS_PER_WEEK = 7n * 24n * 60n * 60n * 10000000n;
const CORPORATION_FOUNDING_COST = 1599800;
const TICKER_SUGGESTION_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CREATE_MEMBER_CHANGE_HEADER = [
  "grantableRolesAtOther",
  "corporationID",
  "baseID",
  "roles",
  "title",
  "accountKey",
  "grantableRoles",
  "rolesAtBase",
  "grantableRolesAtHQ",
  "ownerName",
  "startDateTime",
  "rowDate",
  "divisionID",
  "blockRoles",
  "grantableRolesAtBase",
  "titleMask",
  "rolesAtHQ",
  "characterID",
  "squadronID",
  "rolesAtOther",
];
const APPLICATION_ACCEPT_MEMBER_CHANGE_HEADER = [
  "corporationID",
  "blockRoles",
  "startDateTime",
  "rowDate",
];
const APP_STATUS_APPLIED_BY_CHARACTER = 0;
const APP_STATUS_RENEGOTIATED_BY_CHARACTER = 1;
const APP_STATUS_ACCEPTED_BY_CHARACTER = 2;
const APP_STATUS_REJECTED_BY_CHARACTER = 3;
const APP_STATUS_REJECTED_BY_CORPORATION = 4;
const APP_STATUS_RENEGOTIATED_BY_CORPORATION = 5;
const APP_STATUS_ACCEPTED_BY_CORPORATION = 6;
const APP_STATUS_WITHDRAWN_BY_CHARACTER = 7;
const APP_STATUS_INVITED_BY_CORPORATION = 8;
const TERMINAL_APPLICATION_STATUSES = new Set([
  APP_STATUS_ACCEPTED_BY_CHARACTER,
  APP_STATUS_REJECTED_BY_CHARACTER,
  APP_STATUS_REJECTED_BY_CORPORATION,
  APP_STATUS_WITHDRAWN_BY_CHARACTER,
]);

function resolveCorporationID(session) {
  return normalizePositiveInteger(
    (session && (session.corporationID || session.corpid)) || DEFAULT_NPC_CORPORATION_ID,
    DEFAULT_NPC_CORPORATION_ID,
  );
}

function resolveCharacterID(session, args) {
  return normalizePositiveInteger(
    (args && args.length > 0 && args[0]) ||
      (session && (session.characterID || session.charid)),
    0,
  );
}

function buildLong(value) {
  return {
    type: "long",
    value: toRoleMaskBigInt(value, 0n),
  };
}

function buildSuggestionVariants(baseValue, fallback) {
  const normalized = normalizeText(baseValue, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
  const base = normalized.slice(0, 5) || fallback;
  const variants = [base, base.slice(0, 4), `${base.slice(0, 3)}X`]
    .map((value) => value || fallback)
    .filter(Boolean);
  return Array.from(new Set(variants));
}

function buildSuggestionObjects(baseValue, fallback, fieldName) {
  return buildSuggestionVariants(baseValue, fallback).map((value) =>
    buildKeyVal([[fieldName, value]]),
  );
}

function buildRandomTickerSuggestion() {
  let tickerName = "";
  for (let index = 0; index < 4; index += 1) {
    tickerName += TICKER_SUGGESTION_ALPHABET[
      Math.floor(Math.random() * TICKER_SUGGESTION_ALPHABET.length)
    ];
  }
  return tickerName;
}

function buildCreateCorporationMemberSnapshot(corporationID, characterID) {
  const character = getCharacterRecord(characterID) || {};
  const now = character.startDateTime || currentFileTime().toString();
  const zeroRole = buildLong(0n);
  return {
    grantableRolesAtOther: zeroRole,
    corporationID: Number(corporationID),
    baseID: null,
    roles: zeroRole,
    title: "",
    accountKey: null,
    grantableRoles: zeroRole,
    rolesAtBase: zeroRole,
    grantableRolesAtHQ: zeroRole,
    ownerName: character.characterName || `Character ${characterID}`,
    startDateTime: buildFiletimeLong(now),
    rowDate: buildFiletimeLong(now),
    divisionID: null,
    blockRoles: false,
    grantableRolesAtBase: zeroRole,
    titleMask: 0,
    rolesAtHQ: zeroRole,
    characterID: Number(characterID),
    squadronID: null,
    rolesAtOther: zeroRole,
  };
}

function buildApplicationAcceptMemberSnapshot(corporationID, characterID) {
  const member = getCorporationMember(corporationID, characterID) || {};
  const character = getCharacterRecord(characterID) || {};
  const joinDate =
    member.startDate ||
    character.startDateTime ||
    character.createDateTime ||
    currentFileTime().toString();
  return {
    corporationID: Number(corporationID),
    blockRoles: false,
    startDateTime: buildFiletimeLong(joinDate),
    rowDate: buildFiletimeLong(joinDate),
  };
}

function buildPreviousApplicationAcceptMemberSnapshot(corporationID) {
  return {
    corporationID: Number(corporationID),
    blockRoles: null,
    startDateTime: null,
    rowDate: null,
  };
}

function mapCreateCorporationError(errorMsg) {
  switch (errorMsg) {
    case "CORPORATION_NAME_TAKEN":
      return "CorpNameInvalidTaken";
    case "CORPORATION_TICKER_TAKEN":
      return "CorpTickerNameInvalidTaken";
    case "CORPORATION_NAME_REQUIRED":
      return "EnterCorporationName";
    default:
      return errorMsg || "CustomNotify";
  }
}

function getOwnerRecord(ownerID) {
  const character = getCharacterRecord(ownerID);
  if (character) {
    return {
      ownerID: Number(ownerID),
      ownerName: character.characterName || `Character ${ownerID}`,
      typeID: Number(character.typeID || 1373),
      gender: Number(character.gender || 0),
    };
  }
  return getOwnerLookupRecord(ownerID);
}

function memberHasActiveRoles(member) {
  if (!member) {
    return false;
  }
  return (
    toRoleMaskBigInt(member.roles, 0n) !== 0n ||
    toRoleMaskBigInt(member.grantableRoles, 0n) !== 0n ||
    toRoleMaskBigInt(member.rolesAtHQ, 0n) !== 0n ||
    toRoleMaskBigInt(member.grantableRolesAtHQ, 0n) !== 0n ||
    toRoleMaskBigInt(member.rolesAtBase, 0n) !== 0n ||
    toRoleMaskBigInt(member.grantableRolesAtBase, 0n) !== 0n ||
    toRoleMaskBigInt(member.rolesAtOther, 0n) !== 0n ||
    toRoleMaskBigInt(member.grantableRolesAtOther, 0n) !== 0n ||
    Boolean(toRoleMaskBigInt(member.blockRoles, 0n))
  );
}

function recordMemberRoleAuditRows(corporationID, memberID, previousMember, nextMember, session) {
  if (!previousMember || !nextMember) {
    return;
  }
  const issuerID = resolveCharacterID(session, []) || -1;
  for (const [fieldName, grantable] of [
    ["roles", false],
    ["grantableRoles", true],
  ]) {
    const oldRoles = toRoleMaskBigInt(previousMember[fieldName], 0n);
    const newRoles = toRoleMaskBigInt(nextMember[fieldName], 0n);
    if (oldRoles === newRoles) {
      continue;
    }
    recordCorporationRoleHistory(corporationID, {
      charID: memberID,
      issuerID,
      oldRoles: oldRoles.toString(),
      newRoles: newRoles.toString(),
      grantable,
    });
  }
}

function resolveFallbackCorporationID(characterID) {
  const characterRecord = getCharacterRecord(characterID) || {};
  const schoolProfile = resolveCharacterCreationSchoolProfile(
    characterRecord.schoolID,
    {
      raceID: characterRecord.raceID,
      corporationID: DEFAULT_NPC_CORPORATION_ID,
    },
  );
  const schoolCorporationID = normalizePositiveInteger(
    schoolProfile.corporationID,
    null,
  );
  if (schoolCorporationID && getCorporationRecord(schoolCorporationID)) {
    return schoolCorporationID;
  }
  return DEFAULT_NPC_CORPORATION_ID;
}

function moveCharacterToCorporation(
  characterID,
  fromCorporationID,
  toCorporationID,
  options = {},
) {
  const targetCorporation = getCorporationRecord(toCorporationID);
  if (!targetCorporation) {
    return {
      success: false,
      errorMsg: "TARGET_CORPORATION_NOT_FOUND",
    };
  }
  const sourceCorporation = getCorporationRecord(fromCorporationID) || {};
  const sourceIsNpcCorporation =
    Boolean(sourceCorporation.isNPC) ||
    Number(fromCorporationID) === Number(DEFAULT_NPC_CORPORATION_ID);
  const previousFromMember = buildCorporationMemberSnapshot(
    fromCorporationID,
    characterID,
  );
  const previousFromCorporation = buildCorporationSnapshot(fromCorporationID);
  const previousToMember = buildCorporationMemberSnapshot(
    targetCorporation.corporationID,
    characterID,
  );
  const previousToCorporation = buildCorporationSnapshot(
    targetCorporation.corporationID,
  );

  updateCorporationRuntime(fromCorporationID, (runtime) => {
    delete runtime.members[String(characterID)];
    return runtime;
  });

  const affiliationResult = setCharacterAffiliation(
    characterID,
    targetCorporation.corporationID,
    targetCorporation.allianceID || null,
  );
  if (!affiliationResult.success) {
    return affiliationResult;
  }

  ensureCharacterMemberState(targetCorporation.corporationID, characterID);
  syncMemberStateToCharacterRecord(targetCorporation.corporationID, characterID);
  if (options.applicationAccept === true) {
    if (!sourceIsNpcCorporation) {
      notifyCorporationMemberChanged(
        fromCorporationID,
        characterID,
        previousFromMember,
        { refreshSession: false },
      );
      notifyCorporationChanged(fromCorporationID, previousFromCorporation);
    }
    notifyCorporationMemberChanged(
      targetCorporation.corporationID,
      characterID,
      buildPreviousApplicationAcceptMemberSnapshot(fromCorporationID),
      {
        header: APPLICATION_ACCEPT_MEMBER_CHANGE_HEADER,
        nextSnapshot: buildApplicationAcceptMemberSnapshot(
          targetCorporation.corporationID,
          characterID,
        ),
        idTypes: ["clientID"],
        clientCharacterIDs: [characterID],
        refreshSessionOptions: {
          sessionChangeKeys: ["corpid", "hqID"],
          suppressCorpAccountKeyWithCorpChange: true,
        },
        targeted: true,
      },
    );
    notifyCorporationMemberChanged(
      targetCorporation.corporationID,
      characterID,
      null,
      {
        header: CREATE_MEMBER_CHANGE_HEADER,
        nextSnapshot: buildCreateCorporationMemberSnapshot(
          targetCorporation.corporationID,
          characterID,
        ),
        idTypes: ["corpid", "clientID"],
        clientCharacterIDs: [characterID],
        refreshSession: false,
        targeted: true,
      },
    );
  } else {
    notifyCorporationMemberChanged(
      fromCorporationID,
      characterID,
      previousFromMember,
    );
    notifyCorporationChanged(fromCorporationID, previousFromCorporation);
    notifyCorporationMemberChanged(
      targetCorporation.corporationID,
      characterID,
      previousToMember,
    );
  }
  notifyCorporationChanged(
    targetCorporation.corporationID,
    previousToCorporation,
  );
  // CharLeftCorpMsg (21): the character left the source corporation, so its
  // recruiters are told. No-ops for NPC source corporations.
  notifyCorporationMemberLeft(fromCorporationID, characterID);

  if (Number(fromCorporationID) !== Number(targetCorporation.corporationID)) {
    const targetRuntime = getCorporationRuntime(targetCorporation.corporationID) || {};
    const welcomeMailResult = sendCorporationWelcomeMailToCharacter(
      characterID,
      targetCorporation.corporationID,
      {
        corporationRecord: targetCorporation,
        body: targetRuntime.welcomeMail,
      },
    );
    if (!welcomeMailResult.success) {
      log.warn(
        `[CorpRegistry] Failed to send corporation welcome mail for char=${characterID} corp=${targetCorporation.corporationID}: ${welcomeMailResult.errorMsg}`,
      );
    }
  }

  return {
    success: true,
    data: {
      characterID,
      corporationID: targetCorporation.corporationID,
      allianceID: targetCorporation.allianceID || null,
    },
  };
}

function sendResignCeoHqClearSessionChange(characterID) {
  const session = findSessionByCharacterID(characterID);
  if (!session || typeof session.sendSessionChange !== "function") {
    return false;
  }
  const previousHqID = session.hqID ?? null;
  if (previousHqID === null || previousHqID === undefined) {
    return false;
  }
  session.hqID = null;
  session.sendSessionChange({
    hqID: [previousHqID, null],
  });
  return true;
}

function drainCorporationWalletsForLiquidation(corporationID) {
  let totalPayout = 0;
  for (const division of getCorporationWalletDivisionsInfo(corporationID)) {
    const accountKey = normalizeCorporationWalletKey(division && division.key);
    const balance = roundIsk(division && division.balance);
    if (balance > 0) {
      totalPayout = roundIsk(totalPayout + balance);
    }
    setCorporationWalletDivisionBalance(corporationID, accountKey, 0, {
      entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
      ownerID1: corporationID,
      ownerID2: 0,
      referenceID: corporationID,
      description: "Corporation liquidation",
    });
  }
  return totalPayout;
}

function transferLiquidationSharesToCharacter(corporationID, characterID) {
  const runtime = getCorporationRuntime(corporationID) || {};
  const shares = runtime.shares && typeof runtime.shares === "object"
    ? runtime.shares
    : {};
  const corporationShares = Math.max(
    0,
    normalizeInteger(shares[String(corporationID)], 0),
  );
  if (corporationShares <= 0) {
    return 0;
  }

  updateCorporationRuntime(corporationID, (nextRuntime) => {
    nextRuntime.shares =
      nextRuntime.shares && typeof nextRuntime.shares === "object"
        ? nextRuntime.shares
        : {};
    delete nextRuntime.shares[String(corporationID)];
    nextRuntime.shares[String(characterID)] =
      normalizeInteger(nextRuntime.shares[String(characterID)], 0) +
      corporationShares;
    return nextRuntime;
  });
  notifyCorporationLiquidationShareTransfer(
    corporationID,
    characterID,
    corporationShares,
  );
  return corporationShares;
}

function payLiquidationPayoutToCharacter(corporationID, characterID, amount) {
  const payout = roundIsk(amount);
  if (payout > 0) {
    adjustCharacterBalance(characterID, payout, {
      description: "Corporation liquidation",
      ownerID1: corporationID,
      ownerID2: characterID,
      referenceID: corporationID,
      entryTypeID: JOURNAL_ENTRY_TYPE.PLAYER_DONATION,
    });
  }
  notifyCorporationLiquidation(corporationID, characterID, payout);
  return payout;
}

function moveResigningCeoToFallbackCorporation({
  characterID,
  fromCorporationID,
  toCorporationID,
}) {
  const targetCorporation = getCorporationRecord(toCorporationID);
  if (!targetCorporation) {
    return {
      success: false,
      errorMsg: "TARGET_CORPORATION_NOT_FOUND",
    };
  }

  const affiliationResult = setCharacterAffiliation(
    characterID,
    targetCorporation.corporationID,
    targetCorporation.allianceID || null,
  );
  if (!affiliationResult.success) {
    return affiliationResult;
  }

  updateCorporationRuntime(fromCorporationID, (runtime) => {
    if (runtime.members && typeof runtime.members === "object") {
      delete runtime.members[String(characterID)];
    }
    return runtime;
  });
  ensureCharacterMemberState(targetCorporation.corporationID, characterID);
  syncMemberStateToCharacterRecord(targetCorporation.corporationID, characterID);

  return {
    success: true,
    data: {
      characterID,
      corporationID: targetCorporation.corporationID,
      allianceID: targetCorporation.allianceID || null,
    },
  };
}

function refreshResignedCeoSession(characterID) {
  refreshCharacterSession(characterID, {
    sessionChangeKeys: [
      "corpid",
      "corpAccountKey",
      "hqID",
      "corprole",
      "rolesAtAll",
      "rolesAtBase",
      "rolesAtHQ",
      "rolesAtOther",
    ],
    deferCorpAccountKey: true,
    clearCorpAccountKey: true,
    includeRoleChanges: true,
    suppressCorpAccountKeyWithCorpChange: false,
    selectionEvent: false,
    emitNotifications: true,
    logSelection: false,
    inventoryBootstrap: false,
  });
}

function liquidateCorporationForResigningCeo(corporationID, characterID) {
  const corporationRecord = getCorporationRecord(corporationID);
  if (!corporationRecord || corporationRecord.isNPC) {
    return {
      success: false,
      errorMsg: "CORPORATION_NOT_FOUND",
    };
  }
  const targetCorporationID = resolveFallbackCorporationID(characterID);
  const targetCorporation = getCorporationRecord(targetCorporationID);
  if (!targetCorporation) {
    return {
      success: false,
      errorMsg: "TARGET_CORPORATION_NOT_FOUND",
    };
  }

  const previousCorporation = buildCorporationSnapshot(corporationID);
  const previousFromMember = buildCorporationMemberSnapshot(
    corporationID,
    characterID,
  );
  const previousToMember = buildCorporationMemberSnapshot(
    targetCorporation.corporationID,
    characterID,
  );

  transferLiquidationSharesToCharacter(corporationID, characterID);
  const payout = drainCorporationWalletsForLiquidation(corporationID);
  payLiquidationPayoutToCharacter(corporationID, characterID, payout);
  notifyCorporationRemoved(corporationID, previousCorporation, {
    clientCharacterIDs: [characterID],
  });
  sendResignCeoHqClearSessionChange(characterID);

  const moveResult = moveResigningCeoToFallbackCorporation({
    characterID,
    fromCorporationID: corporationID,
    toCorporationID: targetCorporation.corporationID,
  });
  if (!moveResult.success) {
    return moveResult;
  }

  refreshResignedCeoSession(characterID);
  notifyCorporationMemberChanged(corporationID, characterID, previousFromMember, {
    idTypes: ["corpid", "clientID"],
    clientCharacterIDs: [characterID],
    refreshSession: false,
  });
  notifyCorporationMemberChanged(
    targetCorporation.corporationID,
    characterID,
    previousToMember,
    {
      idTypes: ["corpid", "clientID"],
      clientCharacterIDs: [characterID],
      refreshSession: false,
    },
  );

  const deleteResult = deleteCorporationWithRuntime(corporationID);
  if (!deleteResult.success) {
    return deleteResult;
  }

  return {
    success: true,
    data: {
      corporationID,
      characterID,
      fallbackCorporationID: targetCorporation.corporationID,
      payout,
    },
  };
}

function archiveApplication(runtime, application, overrides = {}) {
  const archivedApplication = { ...application, ...overrides };
  runtime.applicationHistory = Array.isArray(runtime.applicationHistory)
    ? runtime.applicationHistory
    : [];
  runtime.applicationHistory.push({ ...archivedApplication });
  delete runtime.applications[String(application.applicationID)];
  return archivedApplication;
}

function resolveAutoArchivedApplicationStatus(application) {
  const status = Number(application && application.status);
  if (
    status === APP_STATUS_ACCEPTED_BY_CORPORATION ||
    status === APP_STATUS_INVITED_BY_CORPORATION
  ) {
    return APP_STATUS_REJECTED_BY_CHARACTER;
  }
  return APP_STATUS_WITHDRAWN_BY_CHARACTER;
}

function archiveAllActiveApplicationsForCharacter(characterID, exceptApplicationID = null) {
  const runtimeTable = ensureRuntimeInitialized();
  for (const corporationID of Object.keys(runtimeTable.corporations || {})) {
    const removedApplications = [];
    updateCorporationRuntime(corporationID, (runtime) => {
      for (const application of Object.values(runtime.applications || {})) {
        if (
          Number(application.characterID) === Number(characterID) &&
          Number(application.applicationID) !== Number(exceptApplicationID)
        ) {
          removedApplications.push(
            archiveApplication(runtime, application, {
              status: resolveAutoArchivedApplicationStatus(application),
            }),
          );
        }
      }
      return runtime;
    });
    for (const application of removedApplications) {
      notifyCorporationApplicationChanged(
        application.corporationID,
        application.characterID,
        application.applicationID,
        buildCorporationApplicationRow(application),
      );
    }
  }
}

function buildCorporationKeyVal(corporationID) {
  const info = getCorporationInfoRecord(corporationID);
  if (!info) {
    return null;
  }
  const runtime = getCorporationRuntime(corporationID) || {};
  const divisionNames = getCorporationDivisionNames(corporationID);
  const header = [
    "corporationID",
    "corporationName",
    "ticker",
    "tickerName",
    "ceoID",
    "creatorID",
    "allianceID",
    "factionID",
    "warFactionID",
    "membership",
    "description",
    "url",
    "stationID",
    "deleted",
    "taxRate",
    "loyaltyPointTaxRate",
    "friendlyFire",
    "memberCount",
    "memberLimit",
    "shares",
    "allowWar",
    "allowedMemberRaceIDs",
    "corporationType",
    "minimumJoinStanding",
    "sendCharTerminationMessage",
    "createDate",
    "aggressionEnableAfter",
    "aggressionDisableAfter",
    "applicationsEnabled",
    "division1",
    "division2",
    "division3",
    "division4",
    "division5",
    "division6",
    "division7",
    "walletDivision1",
    "walletDivision2",
    "walletDivision3",
    "walletDivision4",
    "walletDivision5",
    "walletDivision6",
    "walletDivision7",
    "shape1",
    "shape2",
    "shape3",
    "color1",
    "color2",
    "color3",
    "typeface",
    "isRecruiting",
  ];
  return buildRow(header, [
    info.corporationID,
    info.corporationName,
    info.ticker,
    info.tickerName || info.ticker,
    info.ceoID,
    info.creatorID,
    info.allianceID,
    info.factionID ?? null,
    info.warFactionID ?? info.factionID ?? null,
    1,
    info.description || "",
    info.url || "",
    info.stationID,
    info.deleted,
    info.taxRate,
    info.loyaltyPointTaxRate || 0.0,
    info.friendlyFire || 0,
    info.memberCount,
    info.memberLimit,
    info.shares,
    info.allowWar,
    info.allowedMemberRaceIDs,
    info.corporationType,
    info.minimumJoinStanding,
    info.sendCharTerminationMessage,
    info.createDate ? buildFiletimeLong(info.createDate) : null,
    info.aggressionEnableAfter ? buildFiletimeLong(info.aggressionEnableAfter) : null,
    info.aggressionDisableAfter ? buildFiletimeLong(info.aggressionDisableAfter) : null,
    runtime.applicationsEnabled || 0,
    divisionNames[1],
    divisionNames[2],
    divisionNames[3],
    divisionNames[4],
    divisionNames[5],
    divisionNames[6],
    divisionNames[7],
    divisionNames[8],
    divisionNames[9],
    divisionNames[10],
    divisionNames[11],
    divisionNames[12],
    divisionNames[13],
    divisionNames[14],
    info.shape1 ?? null,
    info.shape2 ?? null,
    info.shape3 ?? null,
    info.color1 ?? null,
    info.color2 ?? null,
    info.color3 ?? null,
    info.typeface ?? null,
    runtime.applicationsEnabled === 0 ? 0 : 1,
  ]);
}

function buildMemberRow(member) {
  const characterID = Number(member.characterID || 0);
  const characterRecord = characterID ? getCharacterRecord(characterID) || {} : {};
  const ownerRecord = getOwnerLookupRecord(characterID) || {};
  return buildPackedRow(MEMBER_DBROW_COLUMNS, {
    characterID,
    corporationID: Number(member.corporationID || 0),
    divisionID: Number(member.divisionID || 0),
    squadronID: Number(member.squadronID || 0),
    title: member.title || "",
    roles: toRoleMaskBigInt(member.roles, 0n),
    grantableRoles: toRoleMaskBigInt(member.grantableRoles, 0n),
    startDateTime: member.startDate || "0",
    baseID: member.baseID || null,
    rolesAtHQ: toRoleMaskBigInt(member.rolesAtHQ, 0n),
    grantableRolesAtHQ: toRoleMaskBigInt(member.grantableRolesAtHQ, 0n),
    rolesAtBase: toRoleMaskBigInt(member.rolesAtBase, 0n),
    grantableRolesAtBase: toRoleMaskBigInt(member.grantableRolesAtBase, 0n),
    rolesAtOther: toRoleMaskBigInt(member.rolesAtOther, 0n),
    grantableRolesAtOther: toRoleMaskBigInt(member.grantableRolesAtOther, 0n),
    titleMask: Number(member.titleMask || 0),
    accountKey:
      member.readOnlySyntheticEmployee === true
        ? 0
        : Number(
            member.accountKey ||
              CORPORATION_WALLET_KEY_START,
          ),
    rowDate: member.rowDate || member.startDate || "0",
    blockRoles: toRoleMaskBigInt(member.blockRoles, 0n) !== 0n ? 1 : 0,
    ownerName:
      characterRecord.characterName ||
      characterRecord.ownerName ||
      ownerRecord.ownerName ||
      `Character ${characterID}`,
  });
}

function buildTitleRowValues(title) {
  return [
    Number(title.titleID || 0),
    title.titleName || "",
    buildLong(title.roles),
    buildLong(title.grantableRoles),
    buildLong(title.rolesAtHQ),
    buildLong(title.grantableRolesAtHQ),
    buildLong(title.rolesAtBase),
    buildLong(title.grantableRolesAtBase),
    buildLong(title.rolesAtOther),
    buildLong(title.grantableRolesAtOther),
  ];
}

function buildApplicationRow(application) {
  return buildCorporationApplicationRow(application);
}

function buildBulletinRow(bulletin) {
  return buildPackedRow(BULLETIN_DBROW_COLUMNS, {
    bulletinID: Number(bulletin.bulletinID || 0),
    ownerID: Number(bulletin.ownerID || 0),
    createCharacterID: Number(bulletin.createCharacterID || bulletin.editCharacterID || 0),
    createDateTime: bulletin.createDateTime || "0",
    editCharacterID: Number(bulletin.editCharacterID || 0),
    editDateTime: bulletin.editDateTime || "0",
    title: bulletin.title || "",
    body: bulletin.body || "",
    sortOrder: Number(bulletin.sortOrder || 0),
  });
}

function buildShareholderRow(shareholderID, corporationID, shares) {
  return buildRow(SHAREHOLDER_HEADER, [
    shareholderID,
    corporationID,
    Number(shares || 0),
  ]);
}

function roundIsk(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return Math.round(numeric * 100) / 100;
}

function buildContactKeyVal(contactID, contact) {
  return buildKeyVal([
    ["contactID", contactID],
    ["relationshipID", Number(contact.relationshipID || 0)],
    ["labelMask", toMarshalMaskValue(contact.labelMask)],
    ["inWatchlist", contact.inWatchlist ? 1 : 0],
  ]);
}

function buildLabelRowValues(labelID, label) {
  return [
    toMarshalMaskValue(labelID),
    label.name || "",
    Number(label.color || 0),
  ];
}

function buildKillmailRows(records = []) {
  return buildDbRowset(
    KILLMAIL_DBROW_COLUMNS,
    records.map((record) => [
      Number(record && record.killID) || 0,
      normalizePositiveInteger(record && record.solarSystemID, null),
      normalizePositiveInteger(record && record.victimCharacterID, null),
      normalizePositiveInteger(record && record.victimCorporationID, null),
      normalizePositiveInteger(record && record.victimAllianceID, null),
      normalizePositiveInteger(record && record.victimFactionID, null),
      normalizePositiveInteger(record && record.victimShipTypeID, null),
      normalizePositiveInteger(record && record.finalCharacterID, null),
      normalizePositiveInteger(record && record.finalCorporationID, null),
      normalizePositiveInteger(record && record.finalAllianceID, null),
      normalizePositiveInteger(record && record.finalFactionID, null),
      normalizePositiveInteger(record && record.finalShipTypeID, null),
      normalizePositiveInteger(record && record.finalWeaponTypeID, null),
      normalizeText(record && record.killBlob, ""),
      buildFiletimeLong(record && record.killTime ? record.killTime : currentFileTime()),
      Math.max(0, normalizeInteger(record && record.victimDamageTaken, 0)),
      Number(record && record.finalSecurityStatus) || 0,
      Math.max(0, normalizeInteger(record && record.finalDamageDone, 0)),
      normalizePositiveInteger(record && record.moonID, null),
      normalizePositiveInteger(record && record.warID, null),
      Number(record && record.iskLost) || 0,
      Number(record && record.bountyClaimed) || 0,
      normalizeInteger(record && record.loyaltyPoints, 0),
      Number(record && record.iskDestroyed) || 0,
      normalizePositiveInteger(record && record.killRightSupplied, null),
    ]),
    "carbon.common.script.sys.crowset.CRowset",
  );
}

function buildActiveRoleErrorDetails(member) {
  const activeRoleFields = [
    "roles",
    "grantableRoles",
    "rolesAtHQ",
    "grantableRolesAtHQ",
    "rolesAtBase",
    "grantableRolesAtBase",
    "rolesAtOther",
    "grantableRolesAtOther",
    "blockRoles",
  ].filter((fieldName) => toRoleMaskBigInt(member && member[fieldName], 0n) !== 0n);
  return buildDict([
    ["rolelist", buildList(activeRoleFields)],
  ]);
}

function buildCachedResult(result, {
  serviceName,
  method,
  args = [],
  versionCheck = "5 minutes",
  sessionInfo = null,
  sessionInfoValue = undefined,
  proxyCache = false,
} = {}) {
  return buildCachedMethodCallResult(result, {
    serviceName,
    method,
    args,
    versionCheck,
    sessionInfo,
    sessionInfoValue,
    proxyCache,
  });
}

function buildApplicationsByCharacter(runtime) {
  const entries = {};
  for (const application of Object.values(runtime.applications || {})) {
    const key = String(application.characterID);
    if (!entries[key]) {
      entries[key] = [];
    }
    entries[key].push(buildApplicationRow(application));
  }
  return buildDict(
    Object.entries(entries).map(([characterID, rows]) => [
      Number(characterID),
      buildList(rows),
    ]),
  );
}

function buildCorporationWelcomeMailPayload(runtime = {}) {
  return buildKeyVal([
    [
      "characterID",
      normalizePositiveInteger(runtime.welcomeMailCharacterID, null),
    ],
    [
      "changeDate",
      buildFiletimeLong(runtime.welcomeMailChangeDate || "0"),
    ],
    ["welcomeMail", normalizeText(runtime.welcomeMail, "")],
  ]);
}

function filterApplicationHistory(applications = [], characterID = null) {
  return applications
    .filter(
      (application) =>
        !characterID || Number(application.characterID) === Number(characterID),
    )
    .map((application) => buildApplicationRow(application));
}

function findApplicationByID(runtime, applicationID) {
  for (const application of Object.values(runtime.applications || {})) {
    if (Number(application.applicationID) === Number(applicationID)) {
      return application;
    }
  }
  return null;
}


function buildEmptyKillReportList() {
  return buildList([]);
}

function buildMemberTrackingRows(corporationID) {
  return buildCorporationMemberTrackingRowset(corporationID);
}

class CorpRegistryRuntimeService extends BaseService {
  constructor() {
    super("corpRegistry");
  }

  Handle_MachoResolveObject() {
    const config = require(path.join(__dirname, "../../config"));
    return config.proxyNodeId;
  }

  Handle_MachoBindObject(args, session, kwargs) {
    return buildBoundObjectResponse(this, args, session, kwargs);
  }

  /**
   * Resolve the corporation a public read call should target. The corp info
   * window binds corpRegistry to the corporation the player opened (carried as
   * the MachoBindObject parameter); honor that binding so foreign corporations
   * return their own data. Falls back to the session corporation for direct
   * (unbound) calls and for the player's own corporation window.
   */
  resolveBoundCorporationID(session) {
    const boundObjectID = session && session.currentBoundObjectID;
    if (
      boundObjectID &&
      this.serviceManager &&
      typeof this.serviceManager.getBoundObjectParams === "function"
    ) {
      const boundCorporationID = normalizePositiveInteger(
        this.serviceManager.getBoundObjectParams(boundObjectID),
        0,
      );
      if (boundCorporationID) {
        return boundCorporationID;
      }
    }
    return resolveCorporationID(session);
  }

  Handle_GetEveOwners(args, session) {
    const corporationID = this.resolveBoundCorporationID(session);
    const owners = listCorporationMembersForRead(corporationID)
      .map((member) => getOwnerRecord(member.characterID))
      .filter(Boolean)
      .map((record) =>
        buildRow(OWNER_HEADER, [
          record.ownerID,
          record.ownerName,
          record.typeID,
          record.gender,
          null,
        ]),
      );
    return buildList(owners);
  }

  Handle_GetCorporation(args, session) {
    return buildCorporationKeyVal(this.resolveBoundCorporationID(session));
  }

  Handle_GetCorporateContacts(args, session) {
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    return buildDict(
      Object.entries(runtime.contacts || {}).map(([contactID, contact]) => [
        Number(contactID),
        buildContactKeyVal(Number(contactID), contact),
      ]),
    );
  }

  Handle_AddCorporateContact(args, session) {
    const corporationID = resolveCorporationID(session);
    const contactID = normalizePositiveInteger(args && args[0], null);
    const relationshipID = normalizeInteger(args && args[1], 0);
    if (!contactID) {
      return null;
    }
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.contacts[String(contactID)] = {
        relationshipID,
        labelMask: 0,
        inWatchlist: false,
      };
      return runtime;
    });
    return null;
  }

  Handle_EditCorporateContact(args, session) {
    return this.Handle_AddCorporateContact(args, session);
  }

  Handle_RemoveCorporateContacts(args, session) {
    const corporationID = resolveCorporationID(session);
    const contactIDs = extractList(args && args[0]);
    updateCorporationRuntime(corporationID, (runtime) => {
      for (const contactID of contactIDs) {
        delete runtime.contacts[String(contactID)];
      }
      return runtime;
    });
    return null;
  }

  Handle_GetContactList(args, session) {
    return this.Handle_GetCorporateContacts(args, session);
  }

  Handle_EditContactsRelationshipID(args, session) {
    const corporationID = resolveCorporationID(session);
    const contactIDs = extractList(args && args[0]);
    const relationshipID = normalizeInteger(args && args[1], 0);
    updateCorporationRuntime(corporationID, (runtime) => {
      for (const contactID of contactIDs) {
        if (!runtime.contacts[String(contactID)]) {
          runtime.contacts[String(contactID)] = {
            relationshipID,
            labelMask: 0,
            inWatchlist: false,
          };
        } else {
          runtime.contacts[String(contactID)].relationshipID = relationshipID;
        }
      }
      return runtime;
    });
    return null;
  }

  Handle_GetLabels(args, session) {
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    return buildDbIndexRowset(
      LABEL_DBROW_COLUMNS,
      Object.entries(runtime.labels || {}).map(([labelID, label]) => [
        toMarshalMaskValue(labelID),
        buildLabelRowValues(labelID, label),
      ]),
      "labelID",
    );
  }

  Handle_CreateLabel(args, session) {
    const corporationID = resolveCorporationID(session);
    const name = normalizeText(args && args[0], "").trim();
    const color = normalizeInteger(args && args[1], 0);
    let labelID = null;
    updateCorporationRuntime(corporationID, (runtime, corporationRecord, table) => {
      const allocation = allocateNextLabelID(
        runtime.labels || {},
        table._meta.nextLabelID,
      );
      labelID = allocation.labelID;
      table._meta.nextLabelID = allocation.nextLabelID;
      runtime.labels[allocation.labelKey] = { name, color };
      return runtime;
    });
    return labelID;
  }

  Handle_DeleteLabel(args, session) {
    const corporationID = resolveCorporationID(session);
    const labelKey = toLabelKey(args && args[0], null);
    updateCorporationRuntime(corporationID, (runtime) => {
      delete runtime.labels[String(labelKey)];
      for (const contact of Object.values(runtime.contacts || {})) {
        contact.labelMask = removeLabelMask(contact.labelMask, labelKey);
      }
      return runtime;
    });
    return null;
  }

  Handle_EditLabel(args, session) {
    const corporationID = resolveCorporationID(session);
    const labelKey = toLabelKey(args && args[0], null);
    const name = args && args.length > 1 ? normalizeText(args[1], "") : undefined;
    const color = args && args.length > 2 ? normalizeInteger(args[2], 0) : undefined;
    updateCorporationRuntime(corporationID, (runtime) => {
      const label = runtime.labels[String(labelKey)] || { name: "", color: 0 };
      if (name !== undefined) {
        label.name = name;
      }
      if (color !== undefined) {
        label.color = color;
      }
      runtime.labels[String(labelKey)] = label;
      return runtime;
    });
    return null;
  }

  Handle_AssignLabels(args, session) {
    const corporationID = resolveCorporationID(session);
    const contactIDs = extractList(args && args[0]);
    const labelMask = toLabelKey(args && args[1], "0");
    updateCorporationRuntime(corporationID, (runtime) => {
      for (const contactID of contactIDs) {
        const key = String(contactID);
        if (!runtime.contacts[key]) {
          runtime.contacts[key] = {
            relationshipID: 0,
            labelMask: addLabelMask(0, labelMask),
            inWatchlist: false,
          };
        } else {
          runtime.contacts[key].labelMask = addLabelMask(
            runtime.contacts[key].labelMask,
            labelMask,
          );
        }
      }
      return runtime;
    });
    return null;
  }

  Handle_RemoveLabels(args, session) {
    const corporationID = resolveCorporationID(session);
    const contactIDs = extractList(args && args[0]);
    const labelMask = toLabelKey(args && args[1], "0");
    updateCorporationRuntime(corporationID, (runtime) => {
      for (const contactID of contactIDs) {
        if (runtime.contacts[String(contactID)]) {
          runtime.contacts[String(contactID)].labelMask = removeLabelMask(
            runtime.contacts[String(contactID)].labelMask,
            labelMask,
          );
        }
      }
      return runtime;
    });
    return null;
  }

  Handle_GetBulletins(args, session) {
    const corporationID = resolveCorporationID(session);
    const runtime = getCorporationRuntime(corporationID) || {};
    return buildDbRowset(
      BULLETIN_DBROW_COLUMNS,
      (runtime.bulletins || [])
        .slice()
        .sort((left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0))
        .map((bulletin) => ({
          bulletinID: Number(bulletin.bulletinID || 0),
          ownerID: Number(bulletin.ownerID || corporationID),
          createCharacterID: Number(bulletin.createCharacterID || bulletin.editCharacterID || 0),
          createDateTime: bulletin.createDateTime || "0",
          editCharacterID: Number(bulletin.editCharacterID || 0),
          editDateTime: bulletin.editDateTime || "0",
          title: bulletin.title || "",
          body: bulletin.body || "",
          sortOrder: Number(bulletin.sortOrder || 0),
        })),
      "carbon.common.script.sys.crowset.CRowset",
    );
  }

  Handle_GetBulletinEntries(args, session) {
    return this.Handle_GetBulletins(args, session);
  }

  Handle_GetBulletin(args, session) {
    const bulletinID = normalizePositiveInteger(args && args[0], null);
    const corporationID = resolveCorporationID(session);
    const runtime = getCorporationRuntime(corporationID) || {};
    const bulletin = (runtime.bulletins || []).find(
      (entry) => Number(entry.bulletinID) === Number(bulletinID),
    );
    return bulletin ? buildBulletinRow(bulletin) : null;
  }

  Handle_AddBulletin(args, session) {
    const corporationID = resolveCorporationID(session);
    const title = normalizeText(args && args[0], "");
    const body = normalizeText(args && args[1], "");
    const bulletinID = normalizePositiveInteger(args && args[2], null);
    const editDateTime = args && args[3] ? args[3] : null;
    let nextBulletinID = bulletinID;
    updateCorporationRuntime(corporationID, (runtime, corporationRecord, table) => {
      if (!nextBulletinID) {
        nextBulletinID = table._meta.nextBulletinID++;
      }
      const index = (runtime.bulletins || []).findIndex(
        (entry) => Number(entry.bulletinID) === Number(nextBulletinID),
      );
      const record = {
        bulletinID: nextBulletinID,
        ownerID: corporationID,
        createDateTime:
          index >= 0
            ? runtime.bulletins[index].createDateTime
            : String(currentFileTime()),
        editDateTime: editDateTime ? String(editDateTime) : String(currentFileTime()),
        editCharacterID: resolveCharacterID(session),
        title,
        body,
        sortOrder: index >= 0 ? runtime.bulletins[index].sortOrder || 0 : runtime.bulletins.length,
      };
      if (index >= 0) {
        runtime.bulletins[index] = record;
      } else {
        runtime.bulletins.push(record);
      }
      return runtime;
    });
    return nextBulletinID;
  }

  Handle_UpdateBulletin(args, session) {
    return this.Handle_AddBulletin(
      [
        args && args[1],
        args && args[2],
        args && args[0],
        args && args.length > 3 ? args[3] : null,
      ],
      session,
    );
  }

  Handle_DeleteBulletin(args, session) {
    const corporationID = resolveCorporationID(session);
    const bulletinID = normalizePositiveInteger(args && args[0], null);
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.bulletins = (runtime.bulletins || []).filter(
        (bulletin) => Number(bulletin.bulletinID) !== Number(bulletinID),
      );
      return runtime;
    });
    return null;
  }

  Handle_UpdateBulletinOrder(args, session) {
    const corporationID = resolveCorporationID(session);
    const newOrder = extractList(args && args[0]);
    updateCorporationRuntime(corporationID, (runtime) => {
      const orderMap = new Map(
        newOrder.map((bulletinID, index) => [Number(bulletinID), index]),
      );
      for (const bulletin of runtime.bulletins || []) {
        if (orderMap.has(Number(bulletin.bulletinID))) {
          bulletin.sortOrder = orderMap.get(Number(bulletin.bulletinID));
        }
      }
      runtime.bulletins.sort(
        (left, right) => Number(left.sortOrder || 0) - Number(right.sortOrder || 0),
      );
      return runtime;
    });
    return null;
  }

  Handle_GetMyApplications(args, session) {
    const characterID = resolveCharacterID(session, []);
    const runtimeTable = ensureRuntimeInitialized();
    const entries = [];
    for (const [corporationID, runtime] of Object.entries(runtimeTable.corporations || {})) {
      const matching = Object.values(runtime.applications || {})
        .filter((application) => Number(application.characterID) === Number(characterID))
        .map((application) => buildApplicationRow(application));
      if (matching.length > 0) {
        entries.push([Number(corporationID), buildList(matching)]);
      }
    }
    return buildDict(entries);
  }

  Handle_GetMyOldApplications(args, session) {
    const characterID = resolveCharacterID(session, []);
    const runtimeTable = ensureRuntimeInitialized();
    const rows = [];
    for (const runtime of Object.values(runtimeTable.corporations || {})) {
      rows.push(...filterApplicationHistory(runtime.applicationHistory || [], characterID));
    }
    return buildList(rows);
  }

  Handle_GetApplications(args, session) {
    const corporationID = resolveCorporationID(session);
    const runtime = getCorporationRuntime(corporationID) || {};
    return buildApplicationsByCharacter(runtime);
  }

  Handle_GetOldApplications(args, session) {
    const corporationID = resolveCorporationID(session);
    const runtime = getCorporationRuntime(corporationID) || {};
    return buildList(filterApplicationHistory(runtime.applicationHistory || []));
  }

  Handle_InsertApplication(args, session) {
    const corporationID = normalizePositiveInteger(args && args[0], null);
    const applicationText = normalizeText(args && args[1], "");
    const characterID = resolveCharacterID(session, []);
    let applicationID = null;
    let createdApplication = null;
    updateCorporationRuntime(corporationID, (runtime, corporationRecord, table) => {
      applicationID = table._meta.nextApplicationID++;
      createdApplication = {
        applicationID,
        corporationID,
        characterID,
        applicationText,
        status: APP_STATUS_APPLIED_BY_CHARACTER,
        applicationDateTime: String(currentFileTime()),
        customMessage: "",
        responseText: null,
        deleted: false,
      };
      runtime.applications[String(applicationID)] = createdApplication;
      return runtime;
    });
    notifyCorporationApplicationChanged(
      corporationID,
      characterID,
      applicationID,
      buildCorporationApplicationRow(createdApplication),
    );
    notifyCorporationApplicationReceived(corporationID, characterID, applicationText);
    return applicationID;
  }

  Handle_UpdateApplicationOffer(args, session) {
    const applicationID = normalizePositiveInteger(args && args[0], null);
    const characterID = normalizePositiveInteger(args && args[1], null);
    const corporationID = normalizePositiveInteger(args && args[2], null);
    const applicationText = normalizeText(args && args[3], "");
    const status = normalizeInteger(args && args[4], 0);
    const customMessage = normalizeText(args && args[5], "");
    let joinedCharacterID = null;
    let nextApplicationRow = null;
    let applicationFound = false;
    let applicantCharacterID = null;
    updateCorporationRuntime(corporationID, (runtime) => {
      const application = findApplicationByID(runtime, applicationID);
      if (!application) {
        return runtime;
      }
      applicationFound = true;
      applicantCharacterID = normalizePositiveInteger(application.characterID, null);
      application.applicationText = applicationText;
      application.status = status;
      application.customMessage = customMessage;
      application.responseText = customMessage;
      application.deleted = false;
      if (status === APP_STATUS_ACCEPTED_BY_CHARACTER) {
        joinedCharacterID = characterID || application.characterID;
      }
      if (TERMINAL_APPLICATION_STATUSES.has(status)) {
        const archivedApplication = archiveApplication(runtime, application);
        nextApplicationRow = buildCorporationApplicationRow(archivedApplication);
      } else {
        nextApplicationRow = buildCorporationApplicationRow(application);
      }
      return runtime;
    });
    if (applicationFound) {
      const delayApplicationChanged =
        status === APP_STATUS_ACCEPTED_BY_CHARACTER;
      if (!delayApplicationChanged) {
        notifyCorporationApplicationChanged(
          corporationID,
          applicantCharacterID || characterID,
          applicationID,
          nextApplicationRow,
        );
      }
      const notifyCharacterID = applicantCharacterID || characterID;
      if (status === APP_STATUS_ACCEPTED_BY_CORPORATION) {
        notifyCorporationApplicationAccepted(
          corporationID,
          notifyCharacterID,
          applicationText,
        );
      } else if (status === APP_STATUS_REJECTED_BY_CORPORATION) {
        notifyCorporationApplicationRejected(
          corporationID,
          notifyCharacterID,
          applicationText,
          customMessage,
        );
      } else if (status === APP_STATUS_ACCEPTED_BY_CHARACTER) {
        notifyCorporationApplicationAcceptedByCharacter(
          corporationID,
          notifyCharacterID,
          applicationText,
        );
      } else if (status === APP_STATUS_REJECTED_BY_CHARACTER) {
        notifyCorporationApplicationRejectedByCharacter(
          corporationID,
          notifyCharacterID,
          applicationText,
        );
      } else if (status === APP_STATUS_WITHDRAWN_BY_CHARACTER) {
        notifyCorporationApplicationWithdrawn(
          corporationID,
          notifyCharacterID,
          applicationText,
        );
      }
    }
    if (joinedCharacterID) {
      const currentCorporationID = normalizePositiveInteger(
        (getCharacterRecord(joinedCharacterID) || {}).corporationID,
        DEFAULT_NPC_CORPORATION_ID,
      );
      const moveResult = moveCharacterToCorporation(
        joinedCharacterID,
        currentCorporationID,
        corporationID,
        { applicationAccept: true },
      );
      if (moveResult.success) {
        archiveAllActiveApplicationsForCharacter(joinedCharacterID, applicationID);
      }
    }
    if (applicationFound && status === APP_STATUS_ACCEPTED_BY_CHARACTER) {
      notifyCorporationApplicationChanged(
        corporationID,
        applicantCharacterID || characterID,
        applicationID,
        nextApplicationRow,
      );
    }
    return null;
  }

  Handle_GetCorpWelcomeMail(args, session) {
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    return buildCorporationWelcomeMailPayload(runtime);
  }

  Handle_SetCorpWelcomeMail(args, session) {
    const corporationID = resolveCorporationID(session);
    const welcomeMail = normalizeText(args && args[0], "");
    const editorCharacterID = resolveCharacterID(session, []);
    const changeDate = String(currentFileTime());
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.welcomeMail = welcomeMail;
      runtime.welcomeMailCharacterID = normalizePositiveInteger(
        editorCharacterID,
        null,
      );
      runtime.welcomeMailChangeDate = changeDate;
      return runtime;
    });
    notifyCorporationWelcomeMailChanged(
      editorCharacterID,
      changeDate,
    );
    return null;
  }

  Handle_InsertInvitation(args, session) {
    const corporationID = resolveCorporationID(session);
    const characterID = normalizePositiveInteger(args && args[0], null);
    let invitationID = null;
    let applicationID = null;
    let invitationApplication = null;
    updateCorporationRuntime(corporationID, (runtime, corporationRecord, table) => {
      invitationID = table._meta.nextInvitationID++;
      applicationID = table._meta.nextApplicationID++;
      invitationApplication = {
        applicationID,
        corporationID,
        characterID,
        applicationText: "",
        status: APP_STATUS_INVITED_BY_CORPORATION,
        applicationDateTime: String(currentFileTime()),
        customMessage: "",
        responseText: "",
        deleted: false,
      };
      runtime.applications[String(applicationID)] = invitationApplication;
      runtime.invitations[String(invitationID)] = {
        invitationID,
        applicationID,
        corporationID,
        characterID,
        status: APP_STATUS_INVITED_BY_CORPORATION,
        invitationDateTime: String(currentFileTime()),
      };
      return runtime;
    });
    notifyCorporationApplicationChanged(
      corporationID,
      characterID,
      applicationID,
      buildCorporationApplicationRow(invitationApplication),
    );
    notifyCorporationApplicationInvited(corporationID, characterID);
    return invitationID;
  }

  Handle_GetMyOpenInvitations(args, session) {
    const characterID = resolveCharacterID(session, []);
    const runtimeTable = ensureRuntimeInitialized();
    const rows = [];
    for (const runtime of Object.values(runtimeTable.corporations || {})) {
      for (const application of Object.values(runtime.applications || {})) {
        if (
          Number(application.characterID) === Number(characterID) &&
          [
            APP_STATUS_ACCEPTED_BY_CORPORATION,
            APP_STATUS_INVITED_BY_CORPORATION,
          ].includes(Number(application.status))
        ) {
          rows.push(
            buildKeyVal([
              ["invitationID", application.applicationID],
              ["corporationID", application.corporationID],
              ["characterID", application.characterID],
              ["status", application.status],
              ["invitationDateTime", buildFiletimeLong(application.applicationDateTime)],
            ]),
          );
        }
      }
    }
    return buildList(rows);
  }

  Handle_GetMembersPaged(args, session) {
    const corporationID = resolveCorporationID(session);
    const page = normalizeInteger(args && args[0], 1);
    const members =
      listCorporationMembersForRead(corporationID);
    const { start, end } = getPageForMembers(page);
    return buildPagedResultSet(
      members.slice(start, end).map((member) => buildMemberRow(member)),
      members.length,
      Math.max(0, page - 1),
      end - start,
    );
  }

  Handle_GetMembersByIds(args, session) {
    const corporationID = resolveCorporationID(session);
    const memberIDs = extractList(args && args[0]);
    return buildList(
      memberIDs
        .map((memberID) =>
          getCorporationMemberForRead(
            corporationID,
            memberID,
          ))
        .filter(Boolean)
        .map((member) => buildMemberRow(member)),
    );
  }

  Handle_GetMember(args, session) {
    const corporationID = resolveCorporationID(session);
    const memberID = normalizePositiveInteger(args && args[0], null);
    const member = getCorporationMemberForRead(
      corporationID,
      memberID,
    );
    return member ? buildMemberRow(member) : null;
  }

  Handle_UpdateMember(args, session) {
    const corporationID = resolveCorporationID(session);
    const memberID = normalizePositiveInteger(args && args[0], null);
    const previousMemberRecord = getCorporationMember(corporationID, memberID);
    const previousMember = buildCorporationMemberSnapshot(corporationID, memberID);
    updateCorporationRuntime(corporationID, (runtime) => {
      const member = runtime.members[String(memberID)];
      if (!member) {
        return runtime;
      }
      member.title = args && args[1] !== undefined ? normalizeText(args[1], "") : member.title;
      member.divisionID = args && args[2] !== undefined ? normalizeInteger(args[2], 0) : member.divisionID;
      member.squadronID = args && args[3] !== undefined ? normalizeInteger(args[3], 0) : member.squadronID;
      if (args && args[4] !== undefined) member.roles = String(toRoleMaskBigInt(args[4], 0n));
      if (args && args[5] !== undefined) member.grantableRoles = String(toRoleMaskBigInt(args[5], 0n));
      if (args && args[6] !== undefined) member.rolesAtHQ = String(toRoleMaskBigInt(args[6], 0n));
      if (args && args[7] !== undefined) member.grantableRolesAtHQ = String(toRoleMaskBigInt(args[7], 0n));
      if (args && args[8] !== undefined) member.rolesAtBase = String(toRoleMaskBigInt(args[8], 0n));
      if (args && args[9] !== undefined) member.grantableRolesAtBase = String(toRoleMaskBigInt(args[9], 0n));
      if (args && args[10] !== undefined) member.rolesAtOther = String(toRoleMaskBigInt(args[10], 0n));
      if (args && args[11] !== undefined) member.grantableRolesAtOther = String(toRoleMaskBigInt(args[11], 0n));
      if (args && args[12] !== undefined) member.baseID = normalizePositiveInteger(args[12], null);
      if (args && args[13] !== undefined) member.titleMask = normalizeInteger(args[13], 0);
      if (args && args[14] !== undefined) member.blockRoles = String(toRoleMaskBigInt(args[14], 0n));
      return runtime;
    });
    recordMemberRoleAuditRows(
      corporationID,
      memberID,
      previousMemberRecord,
      getCorporationMember(corporationID, memberID),
      session,
    );
    syncMemberStateToCharacterRecord(corporationID, memberID);
    notifyCorporationMemberChanged(corporationID, memberID, previousMember);
    return null;
  }

  Handle_UpdateMembers(args, session) {
    const rows = extractList(args && args[0]);
    for (const row of rows) {
      if (Array.isArray(row)) {
        this.Handle_UpdateMember(row, session);
      }
    }
    return null;
  }

  Handle_GetMyGrantableRoles(args, session) {
    const corporationID = resolveCorporationID(session);
    const member = getCorporationMember(corporationID, resolveCharacterID(session, []));
    const roleMask = member ? toRoleMaskBigInt(member.grantableRoles || FULL_ADMIN_ROLE_MASK, FULL_ADMIN_ROLE_MASK) : FULL_ADMIN_ROLE_MASK;
    const locationMask = member ? toRoleMaskBigInt(member.grantableRolesAtHQ || roleMask, roleMask) : roleMask;
    return [buildLong(roleMask), buildLong(locationMask), buildLong(locationMask), buildLong(locationMask)];
  }

  Handle_SetAccountKey(args, session) {
    const corporationID = resolveCorporationID(session);
    const characterID = resolveCharacterID(session, []);
    const previousMember = buildCorporationMemberSnapshot(corporationID, characterID);
    const previousSessionAccountKey =
      session && (session.corpAccountKey ?? session.corpaccountkey ?? null);
    const accountKey = normalizeCorporationWalletKey(
      args && args[0] !== undefined ? args[0] : CORPORATION_WALLET_KEY_START,
    );
    updateCorporationRuntime(corporationID, (runtime) => {
      if (runtime.members[String(characterID)]) {
        runtime.members[String(characterID)].accountKey = accountKey;
      }
      return runtime;
    });
    notifyCorporationMemberChanged(corporationID, characterID, previousMember, {
      refreshSession: false,
    });
    if (session) {
      session.corpAccountKey = accountKey;
      session.corpaccountkey = accountKey;
      if (
        typeof session.sendSessionChange === "function" &&
        previousSessionAccountKey !== accountKey
      ) {
        session.sendSessionChange({
          corpAccountKey: [previousSessionAccountKey, accountKey],
        });
      }
    }
    return true;
  }

  Handle_ExecuteActions(args, session) {
    const corporationID = resolveCorporationID(session);
    const targetIDs = extractList(args && args[0]).map((value) => Number(value) || 0);
    const previousMembersByID = new Map(
      targetIDs
        .filter((targetID) => targetID > 0)
        .map((targetID) => [
          targetID,
          buildCorporationMemberSnapshot(corporationID, targetID),
        ]),
    );
    const result = executeCorporationMemberActions(
      corporationID,
      args && args[0],
      args && args[1],
      session,
    );
    if (!result.success) {
      log.warn(
        `[CorpRegistry] ExecuteActions failed for corp ${resolveCorporationID(session)}: ${result.errorMsg || "UNKNOWN"}`,
      );
    }
    if (result.success) {
      for (const targetID of result.data && Array.isArray(result.data.targetIDs)
        ? result.data.targetIDs
        : []) {
        notifyCorporationMemberChanged(
          corporationID,
          targetID,
          previousMembersByID.get(Number(targetID)) || null,
        );
      }
    }
    return null;
  }

  Handle_GetPendingAutoKicks(args, session) {
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    return buildList((runtime.pendingAutoKicks || []).map((entry) => entry));
  }

  Handle_GetMemberIDsByQuery(args, session) {
    const corporationID = resolveCorporationID(session);
    const includeImplied = normalizeBoolean(args && args[1], false);
    const searchTitles = normalizeBoolean(args && args[2], false);
    return buildList(
      queryCorporationMemberIDs(
        corporationID,
        args && args[0],
        includeImplied,
        searchTitles,
      ),
    );
  }

  Handle_GetMemberTrackingInfo(args, session) {
    const corporationID = resolveCorporationID(session);
    return buildCachedResult(
      buildMemberTrackingRows(corporationID),
      {
        serviceName: "corpRegistry",
        method: "GetMemberTrackingInfo",
        args: [corporationID],
        versionCheck: "5 minutes",
        sessionInfo: "corpid",
        sessionInfoValue: corporationID,
      },
    );
  }

  Handle_GetMemberTrackingInfoSimple(args, session) {
    return buildMemberTrackingRows(resolveCorporationID(session));
  }

  Handle_GetNumberOfPotentialCEOs(args, session) {
    const corporationID = resolveCorporationID(session);
    return buildList(listCorporationMembers(corporationID).map((member) => member.characterID));
  }

  Handle_GetTitles(args, session) {
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    return buildDbIndexRowset(
      TITLE_DBROW_COLUMNS,
      Object.values(runtime.titles || {}).map((title) => [
        Number(title.titleID),
        buildTitleRowValues(title),
      ]),
      "titleID",
    );
  }

  Handle_UpdateTitle(args, session) {
    const corporationID = resolveCorporationID(session);
    const titleID = normalizePositiveInteger(args && args[0], null);
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.titles[String(titleID)] = {
        titleID,
        titleName: normalizeText(args && args[1], ""),
        roles: String(toRoleMaskBigInt(args && args[2], 0n)),
        grantableRoles: String(toRoleMaskBigInt(args && args[3], 0n)),
        rolesAtHQ: String(toRoleMaskBigInt(args && args[4], 0n)),
        grantableRolesAtHQ: String(toRoleMaskBigInt(args && args[5], 0n)),
        rolesAtBase: String(toRoleMaskBigInt(args && args[6], 0n)),
        grantableRolesAtBase: String(toRoleMaskBigInt(args && args[7], 0n)),
        rolesAtOther: String(toRoleMaskBigInt(args && args[8], 0n)),
        grantableRolesAtOther: String(toRoleMaskBigInt(args && args[9], 0n)),
      };
      return runtime;
    });
    return null;
  }

  Handle_UpdateTitles(args, session) {
    for (const row of extractList(args && args[0])) {
      if (Array.isArray(row)) {
        this.Handle_UpdateTitle(row, session);
      }
    }
    return null;
  }

  Handle_DeleteTitle(args, session) {
    const corporationID = resolveCorporationID(session);
    const titleID = normalizePositiveInteger(args && args[0], null);
    updateCorporationRuntime(corporationID, (runtime) => {
      delete runtime.titles[String(titleID)];
      return runtime;
    });
    return null;
  }

  Handle_UpdateDivisionNames(args, session) {
    const corporationID = resolveCorporationID(session);
    const previousCorporation = buildCorporationSnapshot(corporationID);
    updateCorporationRuntime(corporationID, (runtime) => {
      for (let index = 0; index < 14; index += 1) {
        runtime.divisionNames[index + 1] = normalizeText(args && args[index], runtime.divisionNames[index + 1]);
      }
      return runtime;
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    return null;
  }

  Handle_GetSharesByShareholder(args, session) {
    const corporationID = resolveCorporationID(session);
    const runtime = getCorporationRuntime(corporationID) || {};
    const shareholderID =
      normalizeInteger(args && args[0], 0) === 1
        ? corporationID
        : resolveCharacterID(session, []);
    return buildDbRowset(
      SHAREHOLDER_DBROW_COLUMNS,
      [[shareholderID, corporationID, Number((runtime.shares || {})[String(shareholderID)] || 0)]],
      "carbon.common.script.sys.crowset.CRowset",
    );
  }

  Handle_GetShareholders(args, session) {
    const corporationID = normalizePositiveInteger(args && args[0], resolveCorporationID(session));
    const runtime = getCorporationRuntime(corporationID) || {};
    return buildRowset(
      SHAREHOLDER_HEADER,
      Object.entries(runtime.shares || {}).map(([shareholderID, shares]) =>
        buildList([Number(shareholderID), corporationID, Number(shares || 0)]),
      ),
      "eve.common.script.sys.rowset.Rowset",
    );
  }

  Handle_MoveCompanyShares(args, session) {
    return this._MoveShares(args, session, true);
  }

  Handle_MovePrivateShares(args, session) {
    return this._MoveShares(args, session, false);
  }

  _MoveShares(args, session, companyShares) {
    const corporationID = normalizePositiveInteger(args && args[0], resolveCorporationID(session));
    const toShareholderID = normalizePositiveInteger(args && args[1], null);
    const numberOfShares = Math.max(0, normalizeInteger(args && args[2], 0));
    const readMember = getCorporationMemberForRead(
      corporationID,
      toShareholderID,
    );
    if (
      readMember &&
      readMember.readOnlySyntheticEmployee === true
    ) {
      return null;
    }
    const fromShareholderID = companyShares ? corporationID : resolveCharacterID(session, []);
    updateCorporationRuntime(corporationID, (runtime) => {
      const currentFrom = Number((runtime.shares || {})[String(fromShareholderID)] || 0);
      const moved = Math.min(currentFrom, numberOfShares);
      runtime.shares[String(fromShareholderID)] = currentFrom - moved;
      runtime.shares[String(toShareholderID)] =
        Number(runtime.shares[String(toShareholderID)] || 0) + moved;
      return runtime;
    });
    return null;
  }

  Handle_PayoutDividend(args, session) {
    const corporationID = resolveCorporationID(session);
    const payShareholders = normalizeInteger(args && args[0], 1) ? 1 : 0;
    const payoutAmount = roundIsk(args && args[1]);
    if (!(corporationID > 0) || !(payoutAmount > 0)) {
      return null;
    }

    const sourceBalance = getCorporationWalletBalance(
      corporationID,
      CORPORATION_WALLET_KEY_START,
    );
    if (sourceBalance + 0.0001 < payoutAmount) {
      return null;
    }

    const runtime = getCorporationRuntime(corporationID) || {};
    const weightedRecipients = [];
    if (payShareholders) {
      for (const [ownerID, shares] of Object.entries(runtime.shares || {})) {
        const numericOwnerID = Number(ownerID) || 0;
        const numericShares = Number(shares || 0);
        if (!(numericOwnerID > 0) || !(numericShares > 0)) {
          continue;
        }
        if (getCharacterRecord(numericOwnerID)) {
          weightedRecipients.push({
            kind: "character",
            ownerID: numericOwnerID,
            weight: numericShares,
          });
          continue;
        }
        if (getCorporationRecord(numericOwnerID)) {
          weightedRecipients.push({
            kind: "corporation",
            ownerID: numericOwnerID,
            weight: numericShares,
          });
        }
      }
    } else {
      for (const member of listCorporationMembers(corporationID)) {
        if (Number(member && member.characterID) > 0) {
          weightedRecipients.push({
            kind: "character",
            ownerID: Number(member.characterID),
            weight: 1,
          });
        }
      }
    }

    const totalWeight = weightedRecipients.reduce(
      (sum, recipient) => sum + Number(recipient.weight || 0),
      0,
    );
    if (!(totalWeight > 0)) {
      return null;
    }

    const allocations = [];
    let remainingAmount = payoutAmount;
    let remainingWeight = totalWeight;
    for (let index = 0; index < weightedRecipients.length; index += 1) {
      const recipient = weightedRecipients[index];
      const weight = Number(recipient.weight || 0);
      if (!(weight > 0)) {
        continue;
      }
      let amount = remainingAmount;
      if (index < weightedRecipients.length - 1 && remainingWeight > 0) {
        amount = roundIsk((payoutAmount * weight) / totalWeight);
      }
      if (amount > remainingAmount) {
        amount = remainingAmount;
      }
      remainingAmount = roundIsk(remainingAmount - amount);
      remainingWeight -= weight;
      if (amount > 0) {
        allocations.push({
          ...recipient,
          amount,
        });
      }
    }

    const debitResult = adjustCorporationWalletDivisionBalance(
      corporationID,
      CORPORATION_WALLET_KEY_START,
      -payoutAmount,
      {
        entryTypeID: 10,
        ownerID1: corporationID,
        ownerID2: payShareholders ? 0 : corporationID,
        description: payShareholders
          ? "Corporation dividend paid to shareholders"
          : "Corporation dividend paid to members",
      },
    );
    if (!debitResult.success) {
      return null;
    }

    for (const allocation of allocations) {
      if (allocation.kind === "character") {
        adjustCharacterBalance(allocation.ownerID, allocation.amount, {
          entryTypeID: 10,
          ownerID1: corporationID,
          ownerID2: allocation.ownerID,
          description: `Corporation dividend from ${corporationID}`,
        });
        // CorpDividendMsg (23): tell the character recipient about their dividend.
        notifyCorporationDividendPaid(
          corporationID,
          allocation.ownerID,
          allocation.amount,
          !payShareholders,
        );
        continue;
      }

      adjustCorporationWalletDivisionBalance(
        allocation.ownerID,
        CORPORATION_WALLET_KEY_START,
        allocation.amount,
        {
          entryTypeID: 10,
          ownerID1: corporationID,
          ownerID2: allocation.ownerID,
          description: `Corporation dividend from ${corporationID}`,
        },
      );
    }

    return null;
  }

  Handle_CreateAlliance(args, session) {
    const corporationID = resolveCorporationID(session);
    const previousCorporation = buildCorporationSnapshot(corporationID);
    const result = createAllianceWithRuntime(resolveCharacterID(session, []), corporationID, {
      name: normalizeText(args && args[0], ""),
      shortName: normalizeText(args && args[1], ""),
      description: normalizeText(args && args[2], ""),
      url: normalizeText(args && args[3], ""),
    });
    if (result.success && result.data && result.data.allianceID) {
      notifyAllianceChanged(result.data.allianceID, null);
      notifyAllianceMemberChanged(result.data.allianceID, corporationID, null);
      notifyCorporationChanged(corporationID, previousCorporation);
    }
    return result.success ? result.data.allianceID : null;
  }

  Handle_GetAllianceApplications(args, session) {
    const corporationID = resolveCorporationID(session);
    const runtime = getCorporationRuntime(corporationID) || {};
    return buildCorporationAllianceApplicationsIndexRowset(
      corporationID,
      runtime.allianceApplications || {},
    );
  }

  Handle_DeleteAllianceApplication(args, session) {
    const corporationID = resolveCorporationID(session);
    const allianceID = normalizePositiveInteger(args && args[0], null);
    const previousApplication = buildAllianceApplicationSnapshot(
      allianceID,
      corporationID,
    );
    updateCorporationRuntime(corporationID, (runtime) => {
      delete runtime.allianceApplications[String(allianceID)];
      return runtime;
    });
    updateAllianceRuntime(allianceID, (runtime) => {
      delete runtime.applications[String(corporationID)];
      return runtime;
    });
    notifyAllianceApplicationChanged(allianceID, corporationID, previousApplication);
    return null;
  }

  Handle_ApplyToJoinAlliance(args, session) {
    const corporationID = resolveCorporationID(session);
    const allianceID = normalizePositiveInteger(args && args[0], null);
    const applicationText = normalizeText(args && args[1], "");
    const previousApplication = buildAllianceApplicationSnapshot(
      allianceID,
      corporationID,
    );
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.allianceApplications[String(allianceID)] = {
        allianceID,
        corporationID,
        applicationText,
        state: 1,
        applicationDateTime: String(currentFileTime()),
      };
      return runtime;
    });
    updateAllianceRuntime(allianceID, (runtime) => {
      runtime.applications[String(corporationID)] = {
        allianceID,
        corporationID,
        applicationText,
        state: 1,
        applicationDateTime: String(currentFileTime()),
      };
      return runtime;
    });
    notifyAllianceApplicationChanged(allianceID, corporationID, previousApplication);
    return null;
  }

  Handle_UpdateCorporationAbilities(args, session) {
    const corporationID = resolveCorporationID(session);
    const previousCorporation = buildCorporationSnapshot(corporationID);
    const applicationsEnabled = normalizeBoolean(args && args[0], true);
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.applicationsEnabled = applicationsEnabled ? 1 : 0;
      return runtime;
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    return null;
  }

  Handle_UpdateLogo(args, session) {
    const corporationID = resolveCorporationID(session);
    const previousCorporation = buildCorporationSnapshot(corporationID);
    updateCorporationRecord(corporationID, {
      shape1: normalizePositiveInteger(args && args[0], null),
      shape2: normalizePositiveInteger(args && args[1], null),
      shape3: normalizePositiveInteger(args && args[2], null),
      color1: normalizePositiveInteger(args && args[3], null),
      color2: normalizePositiveInteger(args && args[4], null),
      color3: normalizePositiveInteger(args && args[5], null),
      typeface: normalizePositiveInteger(args && args[6], null),
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    return null;
  }

  Handle_UpdateCorporation(args, session) {
    const corporationID = resolveCorporationID(session);
    const previousCorporation = buildCorporationSnapshot(corporationID);
    const previousTaxRate = previousCorporation
      ? Number(previousCorporation.taxRate) || 0
      : 0;
    const nextTaxRate = Number(args && args[2]) || 0;
    updateCorporationRecord(corporationID, {
      description: normalizeText(args && args[0], ""),
      url: normalizeText(args && args[1], ""),
      taxRate: nextTaxRate,
      loyaltyPointTaxRate: Number(args && args[4]) || 0,
    });
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.applicationsEnabled = args && args[3] ? 1 : 0;
      return runtime;
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    // CorpTaxChangeMsg (19): only when the tax rate actually moved (the same
    // handler also persists description/url/recruitment edits). The CEO who made
    // the change is excluded.
    if (nextTaxRate !== previousTaxRate) {
      notifyCorporationTaxRateChanged(corporationID, {
        excludeCharacterID: resolveCharacterID(session, []),
      });
    }
    return null;
  }

  Handle_GetSuggestedTickerNames(args) {
    return buildList([
      buildKeyVal([["tickerName", buildRandomTickerSuggestion()]]),
    ]);
  }

  Handle_GetSuggestedAllianceShortNames(args) {
    return buildList(buildSuggestionObjects(args && args[0], "ALLY", "shortName"));
  }

  Handle_AddCorporation(args, session) {
    const creatorCharacterID = resolveCharacterID(session, []);
    const creatorWallet = getCharacterWallet(creatorCharacterID);
    if (!creatorWallet || creatorWallet.balance < CORPORATION_FOUNDING_COST) {
      throwWrappedUserError(
        "NotEnoughMoney",
        buildNotEnoughMoneyUserErrorValues(
          CORPORATION_FOUNDING_COST,
          creatorWallet ? creatorWallet.balance : 0,
        ),
      );
    }
    const debitResult = adjustCharacterBalance(
      creatorCharacterID,
      -CORPORATION_FOUNDING_COST,
      {
        entryTypeID: JOURNAL_ENTRY_TYPE.CORPORATION_REGISTRATION_FEE,
        ownerID1: creatorCharacterID,
        ownerID2: creatorCharacterID,
        referenceID: creatorCharacterID,
        description: "Corporation registration fee",
      },
    );
    if (!debitResult.success) {
      throwWrappedUserError(
        "NotEnoughMoney",
        buildNotEnoughMoneyUserErrorValues(
          CORPORATION_FOUNDING_COST,
          creatorWallet.balance,
        ),
      );
    }
    const previousCorporationID = normalizePositiveInteger(
      (session && (session.corporationID || session.corpid)) ||
        (getCharacterRecord(creatorCharacterID) || {}).corporationID,
      null,
    );
    const previousCreatorMember = previousCorporationID
      ? buildCorporationMemberSnapshot(previousCorporationID, creatorCharacterID)
      : null;
    const previousCreatorCorporation = previousCorporationID
      ? buildCorporationSnapshot(previousCorporationID)
      : null;
    const result = createCorporationWithRuntime(resolveCharacterID(session, []), {
      name: normalizeText(args && args[0], ""),
      tickerName: normalizeText(args && args[1], ""),
      description: normalizeText(args && args[2], ""),
      url: normalizeText(args && args[3], ""),
      taxRate: Number(args && args[4]) || 0,
      shape1: args && args[5],
      shape2: args && args[6],
      shape3: args && args[7],
      color1: args && args[8],
      color2: args && args[9],
      color3: args && args[10],
      typeface: args && args[11],
      applicationsEnabled: args && args[12],
      friendlyFireEnabled: args && args[13],
      loyaltyPointTaxRate: Number(args && args[14]) || 0,
      stationID: session && (session.stationID || session.stationid),
      solarSystemID: session && (session.solarSystemID || session.solarsystemid2),
    });
    if (!result.success || !result.data || !result.data.corporationID) {
      adjustCharacterBalance(
        creatorCharacterID,
        CORPORATION_FOUNDING_COST,
        {
          entryTypeID: JOURNAL_ENTRY_TYPE.CORPORATION_REGISTRATION_FEE,
          ownerID1: creatorCharacterID,
          ownerID2: creatorCharacterID,
          referenceID: creatorCharacterID,
          description: "Corporation registration fee refund",
        },
      );
      throwWrappedUserError(mapCreateCorporationError(result.errorMsg));
    }
    if (result.success && result.data && result.data.corporationID) {
      if (previousCorporationID) {
        notifyCorporationMemberChanged(
          previousCorporationID,
          creatorCharacterID,
          previousCreatorMember,
          { refreshSession: false },
        );
        notifyCorporationChanged(previousCorporationID, previousCreatorCorporation);
      }
      notifyCorporationChanged(result.data.corporationID, null);
      notifyCorporationMemberChanged(
        result.data.corporationID,
        creatorCharacterID,
        null,
        {
          header: CREATE_MEMBER_CHANGE_HEADER,
          nextSnapshot: buildCreateCorporationMemberSnapshot(
            result.data.corporationID,
            creatorCharacterID,
          ),
          refreshSessionOptions: {
            deferCorpAccountKey: true,
            clearCorpAccountKey: true,
            suppressCorpAccountKeyWithCorpChange: true,
          },
        },
      );
    }
    return buildCorporationKeyVal(result.data.corporationID);
  }

  Handle_GetAggressionSettings(args, session) {
    const corporationID = this.resolveBoundCorporationID(session);
    const corporationRecord = getCorporationRecord(corporationID) || {};
    return buildAggressionSettingsPayload(
      readAggressionSettings(corporationID, {
        isNpcCorporation: Boolean(corporationRecord.isNPC),
      }),
      {
        isNpcCorporation: Boolean(corporationRecord.isNPC),
      },
    );
  }

  Handle_RegisterNewAggressionSettings(args, session) {
    const corporationID = resolveCorporationID(session);
    const previousCorporation = buildCorporationSnapshot(corporationID);
    const corporationRecord = getCorporationRecord(corporationID) || {};
    const isNpcCorporation = Boolean(corporationRecord.isNPC);
    const desiredFriendlyFireLegal = normalizeBoolean(args && args[0], false);
    let updatedSettings = readAggressionSettings(corporationID, {
      isNpcCorporation,
    });
    updateCorporationRuntime(corporationID, (runtime) => {
      updatedSettings = scheduleAggressionSettingsChange(
        runtime && runtime.aggressionSettings,
        desiredFriendlyFireLegal,
        { isNpcCorporation },
      );
      runtime.aggressionSettings = updatedSettings;
      return runtime;
    });
    updateCorporationRecord(corporationID, {
      friendlyFire: resolveFriendlyFireLegalAtTime(updatedSettings, {
        isNpcCorporation,
      })
        ? 1
        : 0,
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    return buildAggressionSettingsPayload(updatedSettings, {
      isNpcCorporation,
    });
  }

  Handle_DoesMyCorpAcceptStructures(args, session) {
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    return runtime.acceptStructures ? 1 : 0;
  }

  Handle_RegisterNewAcceptStructureSettings(args, session) {
    const corporationID = resolveCorporationID(session);
    const previousCorporation = buildCorporationSnapshot(corporationID);
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.acceptStructures = Boolean(args && args[0]);
      return runtime;
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    return null;
  }

  Handle_DoesCorpRestrictCorpMails(args, session) {
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    return runtime.restrictCorpMails ? 1 : 0;
  }

  Handle_RegisterNewCorpMailRestrictionSettings(args, session) {
    const corporationID = resolveCorporationID(session);
    const previousCorporation = buildCorporationSnapshot(corporationID);
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.restrictCorpMails = Boolean(args && args[0]);
      return runtime;
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    return null;
  }

  Handle_GetStructureReinforceDefault(args, session) {
    const runtime = getCorporationRuntime(resolveCorporationID(session)) || {};
    // CCP client deployment and corp settings code both unpack this RPC as
    // `(reinforceWeekday, reinforceHour)`, even though the UI only uses the
    // hour picker for the current Upwell flow.
    return [
      NO_REINFORCEMENT_WEEKDAY,
      normalizeInteger(
        runtime.structureReinforceDefault,
        DEFAULT_STRUCTURE_REINFORCE_HOUR,
      ),
    ];
  }

  Handle_SetStructureReinforceDefault(args, session) {
    const corporationID = resolveCorporationID(session);
    const previousCorporation = buildCorporationSnapshot(corporationID);
    updateCorporationRuntime(corporationID, (runtime) => {
      runtime.structureReinforceDefault = normalizeInteger(args && args[0], 0);
      return runtime;
    });
    notifyCorporationChanged(corporationID, previousCorporation);
    return null;
  }

  Handle_CharGetAllyBaseCost(args, session) {
    return getCharacterAllyBaseCost(resolveCharacterID(session, args));
  }

  Handle_DeclareWarAgainst(args, session) {
    const againstID = normalizePositiveInteger(args && args[0], null);
    const warHQ = normalizePositiveInteger(args && args[1], null);
    const declaredByID = resolveCorporationID(session);
    const bill = createBill({
      billTypeID: BILL_TYPE_WAR,
      amount: WAR_BILL_AMOUNT,
      debtorID: declaredByID,
      creditorID: CONCORD_CORPORATION_ID,
      externalID: againstID || -1,
      externalID2: -1,
      dueDateTime: String(currentFileTime() + FILETIME_TICKS_PER_WEEK),
    });
    return createWarRecord({
      declaredByID,
      againstID,
      warHQ,
      mutual: false,
      billID: bill ? bill.billID : null,
      declaredByCharacterID: resolveCharacterID(session, []),
    });
  }

  Handle_CanLeaveCurrentCorporation(args, session) {
    const corporationID = resolveCorporationID(session);
    const characterID = resolveCharacterID(session, []);
    const corporation = getCorporationRecord(corporationID);
    const member = getCorporationMember(corporationID, characterID);
    if (!corporation || !member) {
      return [0, "CrpAccessDenied", {}];
    }
    if (Number(corporation.ceoID) === Number(characterID) || member.isCEO) {
      return [0, "CrpCEOCanNotQuit", {}];
    }
    if (memberHasActiveRoles(member)) {
      return [0, "CrpCantQuitNotInStasis", buildActiveRoleErrorDetails(member)];
    }
    return [1, null, {}];
  }

  Handle_CanBeKickedOut(args, session) {
    const corporationID = resolveCorporationID(session);
    const characterID = normalizePositiveInteger(args && args[0], null);
    const corporation = getCorporationRecord(corporationID);
    const member = getCorporationMember(corporationID, characterID);
    if (!corporation || !member) {
      return 0;
    }
    return Number(corporation.ceoID) === Number(characterID) || member.isCEO ? 0 : 1;
  }

  Handle_KickOutMember(args, session) {
    const corporationID = resolveCorporationID(session);
    const characterID = normalizePositiveInteger(args && args[0], null);
    if (!this.Handle_CanBeKickedOut([characterID], session)) {
      return null;
    }
    const result = moveCharacterToCorporation(
      characterID,
      corporationID,
      resolveFallbackCorporationID(characterID),
    );
    if (result && result.success) {
      // CorpKicked (92): tell the removed member they were kicked.
      notifyCorporationMemberKicked(corporationID, characterID);
    }
    return result;
  }

  Handle_KickOutMembers(args, session) {
    const corporationID = resolveCorporationID(session);
    const targetIDs = extractList(args && args[0]);
    const kicked = [];
    const notKicked = [];
    for (const characterID of targetIDs) {
      if (!this.Handle_CanBeKickedOut([characterID], session)) {
        notKicked.push(Number(characterID));
        continue;
      }
      const result = moveCharacterToCorporation(
        characterID,
        corporationID,
        resolveFallbackCorporationID(characterID),
      );
      if (result.success) {
        kicked.push(Number(characterID));
        // CorpKicked (92): tell each removed member they were kicked.
        notifyCorporationMemberKicked(corporationID, characterID);
      } else {
        notKicked.push(Number(characterID));
      }
    }
    return {
      kicked,
      notKicked,
    };
  }

  Handle_GetMemberIDsWithMoreThanAvgShares(args, session) {
    const corporationID = resolveCorporationID(session);
    const runtime = getCorporationRuntime(corporationID) || {};
    const members = listCorporationMembers(corporationID);
    if (!members.length) {
      return buildList([]);
    }
    const totalShares = Number(
      (runtime.shares && runtime.shares[String(corporationID)]) || 0,
    );
    const averageShares = totalShares / members.length;
    return buildList(
      members
        .filter(
          (member) =>
            Number((runtime.shares || {})[String(member.characterID)] || 0) >
            averageShares,
        )
        .map((member) => member.characterID),
    );
  }

  Handle_ResignFromCEO(args, session) {
    const corporationID = resolveCorporationID(session);
    const actingCharacterID = resolveCharacterID(session, []);
    const newCEOID = normalizePositiveInteger(args && args[0], null);
    const members = listCorporationMembers(corporationID);
    if (newCEOID) {
      if (!getCorporationMember(corporationID, newCEOID)) {
        return null;
      }
      const previousCorporation = buildCorporationSnapshot(corporationID);
      const previousActingMember = buildCorporationMemberSnapshot(
        corporationID,
        actingCharacterID,
      );
      const previousNewCeoMember = buildCorporationMemberSnapshot(
        corporationID,
        newCEOID,
      );
      updateCorporationRecord(corporationID, {
        ceoID: newCEOID,
      });
      updateCorporationRuntime(corporationID, (runtime) => {
        if (runtime.members[String(actingCharacterID)]) {
          runtime.members[String(actingCharacterID)].isCEO = false;
          runtime.members[String(actingCharacterID)].roles = String(
            toRoleMaskBigInt(runtime.members[String(actingCharacterID)].roles, 0n) &
              ~CORP_ROLE_DIRECTOR,
          );
        }
        if (runtime.members[String(newCEOID)]) {
          runtime.members[String(newCEOID)].isCEO = true;
          runtime.members[String(newCEOID)].roles = String(
            toRoleMaskBigInt(runtime.members[String(newCEOID)].roles, 0n) |
              CORP_ROLE_DIRECTOR,
          );
        }
        return runtime;
      });
      syncMemberStateToCharacterRecord(corporationID, actingCharacterID);
      syncMemberStateToCharacterRecord(corporationID, newCEOID);
      notifyCorporationChanged(corporationID, previousCorporation);
      notifyCorporationMemberChanged(
        corporationID,
        actingCharacterID,
        previousActingMember,
      );
      notifyCorporationMemberChanged(
        corporationID,
        newCEOID,
        previousNewCeoMember,
      );
      // CorpNewCEOMsg (22): tell the membership the CEO changed; the resigning
      // CEO who initiated it is excluded.
      notifyCorporationNewCeo(corporationID, {
        excludeCharacterID: actingCharacterID,
      });
      return null;
    }

    if (
      members.length <= 1 &&
      members.some(
        (member) =>
          Number(member && member.characterID) === Number(actingCharacterID),
      )
    ) {
      const liquidationResult = liquidateCorporationForResigningCeo(
        corporationID,
        actingCharacterID,
      );
      if (!liquidationResult.success) {
        log.warn(
          `[CorpRegistry] ResignFromCEO liquidation failed for corp=${corporationID} char=${actingCharacterID}: ${liquidationResult.errorMsg || "UNKNOWN"}`,
        );
      }
      return null;
    }

    return buildList(
      members
        .map((member) => member.characterID)
        .filter((characterID) => Number(characterID) !== Number(actingCharacterID)),
    );
  }

  Handle_GetRecentKills(args, session) {
    const corporationID = resolveCorporationID(session);
    const limit = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const rawStartKillID = args && args.length > 1 ? args[1] : null;
    const startKillID = rawStartKillID ? Number(rawStartKillID) || 0 : null;
    const rowset = buildKillmailRows(
      listKillmailsForCorporation(corporationID, "kills", {
        limit,
        startKillID,
      }),
    );
    return buildCachedResult(rowset, {
      serviceName: "corpRegistry",
      method: "GetRecentKills",
      args: [limit, rawStartKillID],
      versionCheck: "15 minutes",
    });
  }

  Handle_GetRecentLosses(args, session) {
    const corporationID = resolveCorporationID(session);
    const limit = args && args.length > 0 ? Number(args[0]) || 0 : 0;
    const rawStartKillID = args && args.length > 1 ? args[1] : null;
    const startKillID = rawStartKillID ? Number(rawStartKillID) || 0 : null;
    const rowset = buildKillmailRows(
      listKillmailsForCorporation(corporationID, "losses", {
        limit,
        startKillID,
      }),
    );
    return buildCachedResult(rowset, {
      serviceName: "corpRegistry",
      method: "GetRecentLosses",
      args: [limit, rawStartKillID],
      versionCheck: "15 minutes",
    });
  }

  Handle_GetInfoWindowDataForChar(args, session) {
    const characterID = resolveCharacterID(session, args);
    const characterRecord = getCharacterRecord(characterID) || {};
    const syntheticEmployee =
      getSyntheticCorporationEmployeeForRead(characterID);
    const corporationID = normalizePositiveInteger(
      characterRecord.corporationID,
      normalizePositiveInteger(
        syntheticEmployee && syntheticEmployee.corporationID,
        resolveCorporationID(session),
      ),
    );
    const member =
      getCorporationMemberForRead(
        corporationID,
        characterID,
      ) ||
      syntheticEmployee ||
      {};
    const runtime = getCorporationRuntime(corporationID) || {};
    const payload = [
      ["corpID", corporationID],
      [
        "allianceID",
        characterRecord.allianceID ||
          (syntheticEmployee &&
            syntheticEmployee.allianceID) ||
          null,
      ],
      [
        "factionID",
        characterRecord.factionID ||
          (syntheticEmployee &&
            syntheticEmployee.factionID) ||
          null,
      ],
      ["title", member.title || ""],
    ];
    for (let index = 1; index <= 16; index += 1) {
      const titleID = 2 ** (index - 1);
      const titleRecord =
        runtime.titles && runtime.titles[String(titleID)]
          ? runtime.titles[String(titleID)]
          : null;
      payload.push([
        `title${index}`,
        normalizeText(titleRecord && titleRecord.titleName, ""),
      ]);
    }
    return buildKeyVal(payload);
  }
}

module.exports = CorpRegistryRuntimeService;
