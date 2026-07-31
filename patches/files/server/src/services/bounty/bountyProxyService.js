const path = require("path");

const BaseService = require(path.join(__dirname, "../baseService"));
const log = require(path.join(__dirname, "../../utils/logger"));
// Phase 0 / 0.C: bounty domain state via an ownership-scoped repository.
const {
  createTableRepository,
} = require(path.join(__dirname, "../../gameStore/tableRepository"));
const repo = createTableRepository("service:bounty", { strict: true });
const {
  throwWrappedUserError,
} = require(path.join(__dirname, "../../common/machoErrors"));
const {
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalance,
  buildNotEnoughMoneyUserErrorValues,
  getCharacterWallet,
} = require(path.join(__dirname, "../account/walletState"));
const playerBountyState = require(path.join(__dirname, "./playerBountyState"));
const killRightState = require(path.join(__dirname, "./killRightState"));
const {
  notifyBountyPlacedOnAlliance,
  notifyBountyPlacedOnCharacter,
  notifyBountyPlacedOnCorporation,
} = require(path.join(__dirname, "./bountyNotifications"));
const {
  notifyKillRightAvailable,
  notifyKillRightUnavailable,
} = require(path.join(__dirname, "./killRightNotifications"));
const { buildDict, buildKeyVal, buildList } = require(path.join(
  __dirname,
  "../_shared/serviceHelpers",
));
const { buildFiletimeLong } = require(path.join(
  __dirname,
  "../_shared/serviceHelpers",
));

const bountyAuditEvents = [];

function recordAuditEvent(kind, args = [], session = null) {
  bountyAuditEvents.push({
    kind,
    args: Array.isArray(args) ? [...args] : [],
    characterID: Number(session && (session.characterID || session.charid)) || null,
    timestamp: Date.now(),
  });
}

function normalizeMethodName(method) {
  if (typeof method === "string") {
    return method;
  }
  if (Buffer.isBuffer(method)) {
    return method.toString("utf8");
  }
  if (method && typeof method === "object" && typeof method.value === "string") {
    return method.value;
  }
  if (method === null || method === undefined) {
    return "";
  }
  return String(method);
}

function collectRequestedIds(rawValue, out, depth = 0) {
  if (depth > 8 || rawValue === null || rawValue === undefined) {
    return;
  }

  if (typeof rawValue === "number" || typeof rawValue === "bigint") {
    const numericValue = Number(rawValue);
    if (Number.isInteger(numericValue)) {
      out.push(numericValue);
    }
    return;
  }

  if (typeof rawValue === "string" && rawValue.trim() !== "") {
    const numericValue = Number(rawValue);
    if (Number.isInteger(numericValue)) {
      out.push(numericValue);
    }
    return;
  }

  if (Array.isArray(rawValue)) {
    for (const item of rawValue) {
      collectRequestedIds(item, out, depth + 1);
    }
    return;
  }

  if (rawValue instanceof Set) {
    for (const item of rawValue) {
      collectRequestedIds(item, out, depth + 1);
    }
    return;
  }

  if (rawValue && typeof rawValue === "object") {
    if (
      (rawValue.type === "list" || rawValue.type === "set") &&
      Array.isArray(rawValue.items)
    ) {
      for (const item of rawValue.items) {
        collectRequestedIds(item, out, depth + 1);
      }
      return;
    }

    if (
      (rawValue.type === "objectex1" || rawValue.type === "objectex2") &&
      Array.isArray(rawValue.list)
    ) {
      for (const item of rawValue.list) {
        collectRequestedIds(item, out, depth + 1);
      }
      return;
    }

    if (
      rawValue.type === "object" &&
      Object.prototype.hasOwnProperty.call(rawValue, "args")
    ) {
      collectRequestedIds(rawValue.args, out, depth + 1);
      return;
    }

    if (
      rawValue.type === "dict" &&
      Array.isArray(rawValue.entries)
    ) {
      for (const [, value] of rawValue.entries) {
        collectRequestedIds(value, out, depth + 1);
      }
      return;
    }

    if (
      Object.prototype.hasOwnProperty.call(rawValue, "value") &&
      (
        rawValue.type === "int" ||
        rawValue.type === "long" ||
        rawValue.type === "float" ||
        rawValue.type === "double" ||
        rawValue.type === "token" ||
        rawValue.type === "wstring"
      )
    ) {
      collectRequestedIds(rawValue.value, out, depth + 1);
    }
  }
}

function extractIdList(rawValue) {
  const extractedIds = [];
  collectRequestedIds(rawValue, extractedIds, 0);
  return Array.from(
    new Set(
      extractedIds.filter(
        (value) => Number.isInteger(value) && Number.isFinite(value),
      ),
    ),
  );
}

function buildBountyPayload(targetID, bounty = 0, extraEntries = []) {
  const numericTargetID = Number(targetID) || 0;
  const entries = [
    ["targetID", numericTargetID],
    ["bounty", Math.max(0, Number(bounty) || 0)],
  ];
  for (const [key, value] of extraEntries) {
    if (value !== null && value !== undefined && value !== 0) {
      entries.push([key, value]);
    }
  }
  return buildKeyVal(entries);
}

function buildBountyPayloadFromPool(pool = {}) {
  return buildBountyPayload(pool.targetID, pool.bounty, [
    ["corporationID", Number(pool.corporationID) || 0],
    ["allianceID", Number(pool.allianceID) || 0],
  ]);
}

function buildBountyEntry(targetID) {
  const numericTargetID = Number(targetID) || 0;
  const pool = playerBountyState.getPool(null, numericTargetID);
  return [
    numericTargetID,
    buildBountyPayloadFromPool(pool),
  ];
}

function buildBountyEntries(targetIDs) {
  return extractIdList(targetIDs).map((targetID) => buildBountyEntry(targetID));
}

function buildContributionPayload(contribution = {}) {
  return buildKeyVal([
    ["contributionID", Number(contribution.contributionID) || 0],
    ["targetID", Number(contribution.targetID) || 0],
    ["amount", Math.max(0, Number(contribution.amount) || 0)],
    ["corporationID", Number(contribution.corporationID) || 0],
    ["allianceID", Number(contribution.allianceID) || 0],
  ]);
}

function buildRankedBountyResult(ownerKind) {
  return [
    buildList(
      playerBountyState
        .listPoolsByKind(ownerKind)
        .slice(0, 10)
        .map((pool) => buildBountyPayloadFromPool(pool)),
    ),
    buildFiletimeLong(),
  ];
}

function buildBountyHunterPayload(stat = {}) {
  return buildKeyVal([
    ["bountyHunterID", Number(stat.bountyHunterID) || 0],
    ["corporationID", Number(stat.corporationID) || 0],
    ["allianceID", Number(stat.allianceID) || 0],
    ["bountiesClaimed", Math.max(0, Number(stat.bountiesClaimed) || 0)],
    ["numberOfKills", Math.max(0, Number(stat.numberOfKills) || 0)],
    ["rowNumber", Math.max(0, Number(stat.rowNumber) || 0)],
  ]);
}

function buildKillRightPayload(record = {}) {
  return buildKeyVal([
    ["killRightID", Number(record.killRightID) || 0],
    ["fromID", Number(record.fromID) || 0],
    ["toID", Number(record.toID) || 0],
    ["expiryTime", buildFiletimeLong(record.expiryTime)],
    [
      "price",
      record.price === null || record.price === undefined
        ? null
        : Math.max(0, Number(record.price) || 0),
    ],
    [
      "restrictedTo",
      record.restrictedTo === null || record.restrictedTo === undefined
        ? null
        : Number(record.restrictedTo) || null,
    ],
  ]);
}

function buildRankedBountyHunterResult(ownerKind) {
  return [
    buildList(
      playerBountyState
        .listBountyHuntersByKind(ownerKind)
        .slice(0, 10)
        .map((stat) => buildBountyHunterPayload(stat)),
    ),
    buildFiletimeLong(),
  ];
}

function buildSearchResult(targetID, ownerKind) {
  const numericTargetID = Number(targetID) || 0;
  const rankedPools = playerBountyState.listPoolsByKind(ownerKind);
  const index = rankedPools.findIndex((pool) => pool.targetID === numericTargetID);
  if (index < 0) {
    return buildList([]);
  }
  return buildList([
    [
      index,
      buildBountyPayloadFromPool(rankedPools[index]),
    ],
  ]);
}

function getSessionCharacterID(session = null) {
  return Number(session && (session.characterID || session.charid)) || 0;
}

function buildSessionKillRightOwnerIDs(session = null) {
  return [
    Number(session && (session.characterID || session.charid)) || 0,
    Number(session && (session.corporationID || session.corpid)) || 0,
    Number(session && (session.allianceID || session.allianceid)) || 0,
  ].filter((ownerID) => ownerID > 0);
}

function throwNotEnoughMoney(requiredAmount, currentBalance) {
  throwWrappedUserError(
    "NotEnoughMoney",
    buildNotEnoughMoneyUserErrorValues(requiredAmount, currentBalance),
  );
}

function throwBountyValidationError(message) {
  throwWrappedUserError("CustomNotify", { notify: message });
}

function buildKnownBountyOwnerIds(session = null) {
  const ownerIds = new Set([0]);
  const characterResult = repo.read("characters", "/");
  const characters = characterResult.success ? characterResult.data : {};

  for (const [characterID, characterRecord] of Object.entries(characters)) {
    const numericCharacterID = Number(characterID) || 0;
    const corporationID = Number(characterRecord && characterRecord.corporationID) || 0;
    const allianceID = Number(characterRecord && characterRecord.allianceID) || 0;
    if (numericCharacterID > 0) {
      ownerIds.add(numericCharacterID);
    }
    if (corporationID > 0) {
      ownerIds.add(corporationID);
    }
    if (allianceID > 0) {
      ownerIds.add(allianceID);
    }
  }

  const sessionCharacterID = Number(session && (session.characterID || session.charid)) || 0;
  const sessionCorporationID = Number(session && (session.corporationID || session.corpid)) || 0;
  const sessionAllianceID = Number(session && (session.allianceID || session.allianceid)) || 0;
  if (sessionCharacterID > 0) {
    ownerIds.add(sessionCharacterID);
  }
  if (sessionCorporationID > 0) {
    ownerIds.add(sessionCorporationID);
  }
  if (sessionAllianceID > 0) {
    ownerIds.add(sessionAllianceID);
  }

  return Array.from(ownerIds).sort((left, right) => left - right);
}

function buildEmptyRankedResult() {
  return [
    buildList([]),
    buildFiletimeLong(),
  ];
}

function throwKillRightUserError(errorMsg) {
  if (errorMsg === killRightState.ERROR.KILL_RIGHT_EXPIRED) {
    throwWrappedUserError("KillRightExpired", {});
  }
  if (errorMsg === killRightState.ERROR.KILL_RIGHT_NOT_FOR_SALE) {
    throwWrappedUserError("KillRightNotForSale", {});
  }
  throwWrappedUserError("NoValidKillRight", {});
}

function resolveRequestedBountyIds(rawValue, session = null) {
  const requestedIds = extractIdList(rawValue);
  if (requestedIds.length > 0) {
    return requestedIds;
  }
  return buildKnownBountyOwnerIds(session);
}

class BountyProxyService extends BaseService {
  constructor() {
    super("bountyProxy");
  }

  Handle_AddToBounty(args, session) {
    const targetID = args && args.length > 0 ? args[0] : 0;
    const amount = args && args.length > 1 ? args[1] : 0;
    const characterID = getSessionCharacterID(session);
    const numericAmount = Math.max(0, Number(amount) || 0);
    const wallet = getCharacterWallet(characterID);
    const targetKind = playerBountyState.inferOwnerKind(targetID);
    const minimumAmount = playerBountyState.getMinimumBountyAmount(targetID);
    recordAuditEvent("add_to_bounty", [targetID, amount], session);
    if (!wallet) {
      throwWrappedUserError("CharacterNotFound", { characterID });
    }
    if (targetKind === playerBountyState.OWNER_KIND.UNKNOWN) {
      throwBountyValidationError("Bounty target is not a known character, corporation, or alliance.");
    }
    if (!(numericAmount > 0) || numericAmount < minimumAmount) {
      throwBountyValidationError(
        `Bounty must be at least ${minimumAmount} ISK for this target.`,
      );
    }
    if (wallet.balance < numericAmount) {
      throwNotEnoughMoney(numericAmount, wallet.balance);
    }
    const debitResult = adjustCharacterBalance(characterID, -numericAmount, {
      description: `Bounty placed on ${Number(targetID) || 0}`,
      ownerID1: characterID,
      ownerID2: Number(targetID) || 0,
      referenceID: Number(targetID) || 0,
      entryTypeID: JOURNAL_ENTRY_TYPE.BOUNTY,
    });
    if (!debitResult.success) {
      if (debitResult.errorMsg === "INSUFFICIENT_FUNDS") {
        throwNotEnoughMoney(numericAmount, wallet.balance);
      }
      throwWrappedUserError("CustomNotify", {
        notify: `Unable to place bounty: ${debitResult.errorMsg || "wallet error"}`,
      });
    }
    const placeResult = playerBountyState.placeBounty({
      targetID,
      amount: numericAmount,
      contributorID: characterID,
    });
    if (!placeResult.success) {
      adjustCharacterBalance(characterID, numericAmount, {
        description: `Refund failed bounty placement on ${Number(targetID) || 0}`,
        ownerID1: characterID,
        ownerID2: Number(targetID) || 0,
        referenceID: Number(targetID) || 0,
        entryTypeID: JOURNAL_ENTRY_TYPE.BOUNTY,
      });
      throwWrappedUserError("CustomNotify", {
        notify: `Unable to place bounty: ${placeResult.errorMsg || "invalid bounty"}`,
      });
    }
    log.info(
      `[BountyProxy] AddToBounty placed: target=${targetID} amount=${numericAmount} by=${characterID}`,
    );
    if (targetKind === playerBountyState.OWNER_KIND.CHARACTER) {
      // BountyPlacedChar (112): tell the targeted character a bounty was placed
      // on them, and by whom.
      notifyBountyPlacedOnCharacter({
        targetID,
        bountyPlacerID: characterID,
        amount: numericAmount,
      });
    } else if (targetKind === playerBountyState.OWNER_KIND.CORPORATION) {
      // BountyPlacedCorp (113): tell every member of the targeted corporation.
      notifyBountyPlacedOnCorporation({
        targetID,
        bountyPlacerID: characterID,
        amount: numericAmount,
      });
    } else if (targetKind === playerBountyState.OWNER_KIND.ALLIANCE) {
      // BountyPlacedAlliance (114): tell every member of the targeted alliance.
      notifyBountyPlacedOnAlliance({
        targetID,
        bountyPlacerID: characterID,
        amount: numericAmount,
      });
    }
    return buildBountyPayloadFromPool(placeResult.pool);
  }

  Handle_GetBounties(args, session) {
    const requestedTargetIDs = args && args.length > 0 ? args[0] : [];
    const requestedIds = resolveRequestedBountyIds(requestedTargetIDs, session);
    log.debug(
      `[BountyProxy] GetBounties: ${JSON.stringify(requestedIds)}`,
    );
    return buildDict(buildBountyEntries(requestedIds));
  }

  Handle_GetBountiesAndKillRights(args, session) {
    const requestedBountyTargetIDs = args && args.length > 0 ? args[0] : [];
    const requestedKillRightTargetIDs = args && args.length > 1 ? args[1] : [];
    const requestedIds = resolveRequestedBountyIds(requestedBountyTargetIDs, session);
    const requestedKillRightIds = extractIdList(requestedKillRightTargetIDs);
    log.debug(
      `[BountyProxy] GetBountiesAndKillRights: ${JSON.stringify(requestedIds)}`,
    );
    return [
      buildDict(buildBountyEntries(requestedIds)),
      buildList(
        killRightState
          .listAvailableKillRightsOnCharacters(
            requestedKillRightIds,
            buildSessionKillRightOwnerIDs(session),
          )
          .map((record) => buildKillRightPayload(record)),
      ),
    ];
  }

  Handle_GetMyBounties(_args, session) {
    log.debug("[BountyProxy] GetMyBounties");
    const characterID = getSessionCharacterID(session);
    return buildList(
      playerBountyState
        .listContributionsForContributor(characterID)
        .map((contribution) => buildContributionPayload(contribution)),
    );
  }

  Handle_GetMyKillRights(_args, session) {
    log.debug("[BountyProxy] GetMyKillRights");
    const characterID = getSessionCharacterID(session);
    return buildList(
      killRightState
        .listMyKillRights(characterID)
        .map((record) => buildKillRightPayload(record)),
    );
  }

  Handle_GetKillRightsOnCharacters(args, session) {
    const toIDs = args && args.length > 0 ? args[0] : [];
    const requestedToIDs = extractIdList(toIDs);
    recordAuditEvent("get_kill_rights_on_characters", [toIDs], session);
    log.debug("[BountyProxy] GetKillRightsOnCharacters");
    return buildList(
      killRightState
        .listAvailableKillRightsOnCharacters(
          requestedToIDs,
          buildSessionKillRightOwnerIDs(session),
        )
        .map((record) => buildKillRightPayload(record)),
    );
  }

  Handle_SellKillRight(args, session) {
    const killRightID = args && args.length > 0 ? args[0] : null;
    const price = args && args.length > 1 ? args[1] : null;
    const restrictedTo = args && args.length > 2 ? args[2] : null;
    const characterID = getSessionCharacterID(session);
    recordAuditEvent("sell_kill_right", [killRightID, price, restrictedTo], session);
    const result = killRightState.sellKillRight(
      killRightID,
      characterID,
      price,
      restrictedTo,
    );
    if (!result.success) {
      throwKillRightUserError(result.errorMsg);
    }
    log.info(
      `[BountyProxy] SellKillRight: killRightID=${killRightID} price=${price} restrictedTo=${restrictedTo}`,
    );
    // KillRightAvailable (115) / KillRightAvailableOpen (116): tell the target a
    // kill right against them was listed for sale, so they may buy it back.
    notifyKillRightAvailable({
      targetID: result.data.toID,
      ownerID: result.data.fromID,
      price: result.data.price,
      toEntityID: result.data.restrictedTo,
    });
    return buildList([buildKillRightPayload(result.data)]);
  }

  Handle_CancelSellKillRight(args, session) {
    const killRightID = args && args.length > 0 ? args[0] : null;
    const toID = args && args.length > 1 ? args[1] : null;
    const characterID = getSessionCharacterID(session);
    recordAuditEvent("cancel_sell_kill_right", [killRightID, toID], session);
    // Capture the listing before it is cleared so we know whether it was a
    // restricted or open sale (cancel resets price/restrictedTo to null).
    const previousRecord = killRightState.getKillRight(killRightID);
    const result = killRightState.cancelSellKillRight(
      killRightID,
      characterID,
      toID,
    );
    if (!result.success) {
      log.debug(
        `[BountyProxy] CancelSellKillRight ignored stale/invalid right: killRightID=${killRightID} error=${result.errorMsg}`,
      );
      return null;
    }
    log.info(
      `[BountyProxy] CancelSellKillRight: killRightID=${killRightID}`,
    );
    // KillRightUnavailable (119) / KillRightUnavailableOpen (120): only when the
    // right was actually for sale, tell the target it is no longer available.
    if (
      previousRecord &&
      previousRecord.price !== null &&
      previousRecord.price !== undefined
    ) {
      notifyKillRightUnavailable({
        targetID: previousRecord.toID,
        ownerID: previousRecord.fromID,
        toEntityID: previousRecord.restrictedTo,
      });
    }
    return null;
  }

  Handle_GetTopPilotBounties() {
    return buildRankedBountyResult(playerBountyState.OWNER_KIND.CHARACTER);
  }

  Handle_GetTopCorpBounties() {
    return buildRankedBountyResult(playerBountyState.OWNER_KIND.CORPORATION);
  }

  Handle_GetTopAllianceBounties() {
    return buildRankedBountyResult(playerBountyState.OWNER_KIND.ALLIANCE);
  }

  Handle_GetTopPilotBountyHunters() {
    return buildRankedBountyHunterResult(playerBountyState.OWNER_KIND.CHARACTER);
  }

  Handle_GetTopCorporationBountyHunters() {
    return buildRankedBountyHunterResult(playerBountyState.OWNER_KIND.CORPORATION);
  }

  Handle_GetTopAllianceBountyHunters() {
    return buildRankedBountyHunterResult(playerBountyState.OWNER_KIND.ALLIANCE);
  }

  Handle_SearchCharBounties(args = []) {
    return buildSearchResult(args[0], playerBountyState.OWNER_KIND.CHARACTER);
  }

  Handle_SearchCorpBounties(args = []) {
    return buildSearchResult(args[0], playerBountyState.OWNER_KIND.CORPORATION);
  }

  Handle_SearchAllianceBounties(args = []) {
    return buildSearchResult(args[0], playerBountyState.OWNER_KIND.ALLIANCE);
  }

  Handle_GMReimburseBounties(args, session) {
    recordAuditEvent("gm_reimburse_bounties", args, session);
    log.info("[BountyProxy] GMReimburseBounties acknowledged without side effects");
    return null;
  }

  Handle_GMClearBountyCache(args, session) {
    recordAuditEvent("gm_clear_bounty_cache", args, session);
    log.info("[BountyProxy] GMClearBountyCache acknowledged without side effects");
    return null;
  }

  callMethod(method, args, session, kwargs) {
    const normalizedMethod = normalizeMethodName(method);
    const handlerName = `Handle_${normalizedMethod}`;
    if (typeof this[handlerName] === "function") {
      return this[handlerName](args, session, kwargs);
    }
    if (typeof this[normalizedMethod] === "function") {
      return this[normalizedMethod](args, session, kwargs);
    }

    log.warn(`[BountyProxy] Unhandled method fallback: ${normalizedMethod}`);
    return buildList([]);
  }
}

BountyProxyService._testing = {
  getAuditEvents() {
    return bountyAuditEvents.map((entry) => ({ ...entry }));
  },
  resetForTests() {
    bountyAuditEvents.length = 0;
  },
};

module.exports = BountyProxyService;
