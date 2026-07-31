const path = require("path");

const {
  buildKillmailItemTreeForLocation,
} = require(path.join(__dirname, "../../services/killmail/killmailItemPayload"));
const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../services/inventory/itemTypeRegistry"));
const {
  JOURNAL_ENTRY_TYPE,
  adjustCharacterBalance,
  getCharacterWallet,
} = require(path.join(__dirname, "../../services/account/walletState"));
const {
  ENTITY_TYPE,
} = require(path.join(__dirname, "../entityConstants"));

const CONCORD_CORPORATION_ID = 1000125;
const CATEGORY_SHIP = 6;
const GROUP_CAPSULE = 29;
const GROUP_SHUTTLE = 31;
const GROUP_CORVETTE = 237;
const KILLMARK_EXCLUDED_GROUP_IDS = new Set([
  GROUP_CAPSULE,
  GROUP_SHUTTLE,
  GROUP_CORVETTE,
]);

const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const LEDGER_TTL_MS = 30 * 60 * 1000;

const ledgersByVictim = new Map();

function getCharacterStateService() {
  return require(path.join(__dirname, "../../services/character/characterState"));
}

function getKillmailStateService() {
  return require(path.join(__dirname, "../../services/killmail/killmailState"));
}

function getKillRightStateService() {
  return require(path.join(__dirname, "../../services/bounty/killRightState"));
}

function getSessionRegistry() {
  return require(path.join(__dirname, "../../services/chat/sessionRegistry"));
}

function getShipKillCounterStateService() {
  return require(path.join(__dirname, "../../services/ship/shipKillCounterState"));
}

function getNotificationStateService() {
  return require(path.join(__dirname, "../../services/notifications/notificationState"));
}

function getNotificationConstants() {
  return require(path.join(__dirname, "../../services/notifications/notificationConstants"));
}

function createKillmailRecord(recordInput) {
  const killmailState = getKillmailStateService();
  return killmailState && typeof killmailState.createKillmailRecord === "function"
    ? killmailState.createKillmailRecord(recordInput)
    : { success: false, errorMsg: "KILLMAIL_STATE_UNAVAILABLE" };
}

function resolveKillmailWarID(recordInput) {
  const killmailState = getKillmailStateService();
  return killmailState && typeof killmailState.resolveKillmailWarID === "function"
    ? killmailState.resolveKillmailWarID(recordInput)
    : null;
}

function resolveCharacterRecord(characterID) {
  const characterState = getCharacterStateService();
  return characterState && typeof characterState.getCharacterRecord === "function"
    ? characterState.getCharacterRecord(characterID)
    : null;
}

function toFiniteNumber(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function toInteger(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.trunc(numericValue);
}

function toPositiveInt(value, fallback = null) {
  const numericValue = toInteger(value, 0);
  return numericValue > 0 ? numericValue : fallback;
}

function cloneValue(value) {
  if (value === undefined || value === null) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function formatKillmailFiletime(whenMs = Date.now()) {
  const numericWhenMs = Number.isFinite(Number(whenMs)) ? Math.trunc(Number(whenMs)) : Date.now();
  return (BigInt(numericWhenMs) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET).toString();
}

function cleanupExpiredLedgers(nowMs = Date.now()) {
  for (const [ledgerKey, ledger] of [...ledgersByVictim.entries()]) {
    if (!ledger || nowMs - toFiniteNumber(ledger.lastUpdatedAtMs, 0) > LEDGER_TTL_MS) {
      ledgersByVictim.delete(ledgerKey);
    }
  }
}

function getVictimLedgerKey(entity) {
  const itemID = toPositiveInt(entity && entity.itemID, 0) || 0;
  return `${String(entity && entity.kind || "entity")}:${itemID}`;
}

function resolveWeaponTypeID(options = {}) {
  const weaponSnapshot = options.weaponSnapshot || null;
  const moduleItem = options.moduleItem || null;
  const chargeItem = options.chargeItem || null;
  return (
    toPositiveInt(
      options.weaponTypeID,
      toPositiveInt(
        weaponSnapshot && weaponSnapshot.chargeTypeID,
        toPositiveInt(
          weaponSnapshot && weaponSnapshot.moduleTypeID,
          toPositiveInt(
            chargeItem && chargeItem.typeID,
            toPositiveInt(moduleItem && moduleItem.typeID, null),
          ),
        ),
      ),
    ) || null
  );
}

function resolveEntityTypeRecord(entity) {
  const typeID = toPositiveInt(
    entity && (entity.typeID || entity.slimTypeID),
    null,
  );
  return typeID ? resolveItemByTypeID(typeID) || null : null;
}

function resolveEntityGroupID(entity, typeRecord = null) {
  return toPositiveInt(
    entity && (entity.groupID || entity.slimGroupID),
    toPositiveInt(typeRecord && typeRecord.groupID, 0),
  ) || 0;
}

function resolveEntityCategoryID(entity, typeRecord = null) {
  return toPositiveInt(
    entity && (entity.categoryID || entity.slimCategoryID),
    toPositiveInt(typeRecord && typeRecord.categoryID, 0),
  ) || 0;
}

function resolveAttackerIdentity(attackerEntity, options = {}) {
  if (!attackerEntity) {
    return {
      characterID: null,
      corporationID: null,
      allianceID: null,
      factionID: null,
      shipTypeID: null,
      weaponTypeID: resolveWeaponTypeID(options),
      securityStatus: null,
    };
  }

  const characterID = toPositiveInt(
    attackerEntity.pilotCharacterID ?? attackerEntity.characterID,
    null,
  );
  const characterRecord = characterID ? resolveCharacterRecord(characterID) || {} : {};
  return {
    characterID,
    corporationID: toPositiveInt(
      characterRecord.corporationID,
      toPositiveInt(attackerEntity.corporationID, toPositiveInt(attackerEntity.ownerID, null)),
    ),
    allianceID: toPositiveInt(characterRecord.allianceID, toPositiveInt(attackerEntity.allianceID, null)),
    factionID: toPositiveInt(
      characterRecord.factionID,
      toPositiveInt(attackerEntity.warFactionID, null),
    ),
    shipTypeID: toPositiveInt(attackerEntity.typeID, null),
    weaponTypeID: resolveWeaponTypeID(options),
    securityStatus:
      characterID && characterRecord
        ? toFiniteNumber(
            characterRecord.securityStatus ?? characterRecord.securityRating,
            0,
          )
        : null,
  };
}

function isCapsuleerPilotedShipVictim(targetEntity, victimIdentity) {
  if (String(targetEntity && targetEntity.kind || "").toLowerCase() !== "ship") {
    return false;
  }
  if (targetEntity && targetEntity.nativeNpc === true) {
    return false;
  }
  if (toPositiveInt(victimIdentity && victimIdentity.victimCharacterID, 0) <= 0) {
    return false;
  }

  const typeRecord = resolveEntityTypeRecord(targetEntity);
  const categoryID = resolveEntityCategoryID(targetEntity, typeRecord);
  const groupID = resolveEntityGroupID(targetEntity, typeRecord);
  return categoryID === CATEGORY_SHIP && !KILLMARK_EXCLUDED_GROUP_IDS.has(groupID);
}

function isNpcVictimEntity(entity) {
  if (!entity) {
    return false;
  }
  const npcEntityType = String(entity.npcEntityType || "").trim().toLowerCase();
  return (
    entity.nativeNpc === true ||
    entity.nativeNpcOccupied === true ||
    npcEntityType === ENTITY_TYPE.NPC ||
    npcEntityType === ENTITY_TYPE.CONCORD
  );
}

function canAwardKillmark(targetEntity, attackerEntity, finalAttacker, victimIdentity) {
  if (!isCapsuleerPilotedShipVictim(targetEntity, victimIdentity)) {
    return false;
  }

  const attackerShipID = resolveKillmarkAwardShipID(attackerEntity);
  const victimShipID = toPositiveInt(targetEntity && targetEntity.itemID, 0);
  const attackerCharacterID = toPositiveInt(finalAttacker && finalAttacker.characterID, 0);
  const victimCharacterID = toPositiveInt(victimIdentity && victimIdentity.victimCharacterID, 0);
  if (
    attackerShipID <= 0 ||
    victimShipID <= 0 ||
    attackerShipID === victimShipID ||
    attackerCharacterID <= 0 ||
    victimCharacterID <= 0 ||
    attackerCharacterID === victimCharacterID
  ) {
    return false;
  }

  const attackerCorporationID = toPositiveInt(finalAttacker && finalAttacker.corporationID, 0);
  const victimCorporationID = toPositiveInt(victimIdentity && victimIdentity.victimCorporationID, 0);
  if (attackerCorporationID > 0 && victimCorporationID > 0 && attackerCorporationID === victimCorporationID) {
    return false;
  }

  return true;
}

function resolveKillmarkAwardShipID(attackerEntity) {
  if (!attackerEntity) {
    return 0;
  }
  if (String(attackerEntity.kind || "").toLowerCase() === "ship") {
    return toPositiveInt(attackerEntity.itemID, 0);
  }
  return (
    toPositiveInt(attackerEntity.controllerID, 0) ||
    toPositiveInt(attackerEntity.launcherID, 0) ||
    toPositiveInt(attackerEntity.sourceShipID, 0) ||
    0
  );
}

function broadcastKillmarkSlimChange(targetEntity, attackerEntity, awardShipID, playerKills) {
  if (!attackerEntity) {
    return false;
  }
  if (toPositiveInt(attackerEntity.itemID, 0) === awardShipID) {
    attackerEntity.kills = playerKills;
  }

  try {
    const spaceRuntime = require(path.join(__dirname, "../runtime"));
    const session = attackerEntity.session || (targetEntity && targetEntity.session) || null;
    const scene =
      session && spaceRuntime && typeof spaceRuntime.getSceneForSession === "function"
        ? spaceRuntime.getSceneForSession(session)
        : spaceRuntime && spaceRuntime.scenes instanceof Map
          ? spaceRuntime.scenes.get(
            toPositiveInt(
              attackerEntity.systemID,
              toPositiveInt(targetEntity && targetEntity.systemID, 0),
            ),
          ) || null
          : null;
    const liveEntity =
      scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(awardShipID)
        : null;
    if (!scene || !liveEntity || typeof scene.broadcastSlimItemChanges !== "function") {
      return false;
    }
    liveEntity.kills = playerKills;
    scene.broadcastSlimItemChanges([liveEntity]);
    return true;
  } catch (error) {
    return false;
  }
}

function awardKillmarkForFinalBlow(targetEntity, attackerEntity, finalAttacker, victimIdentity, record, options = {}) {
  if (!canAwardKillmark(targetEntity, attackerEntity, finalAttacker, victimIdentity)) {
    return null;
  }

  const killID = toPositiveInt(record && record.killID, 0);
  const shipCounterState = getShipKillCounterStateService();
  if (!shipCounterState || typeof shipCounterState.incrementItemKillCountPlayer !== "function") {
    return null;
  }

  const awardShipID = resolveKillmarkAwardShipID(attackerEntity);
  const result = shipCounterState.incrementItemKillCountPlayer(awardShipID, {
    reason: "player_final_blow",
    lastAward: {
      killID: killID || null,
      victimShipID: toPositiveInt(targetEntity && targetEntity.itemID, null),
      victimCharacterID: toPositiveInt(victimIdentity && victimIdentity.victimCharacterID, null),
      victimShipTypeID: toPositiveInt(victimIdentity && victimIdentity.victimShipTypeID, null),
      weaponTypeID: toPositiveInt(finalAttacker && finalAttacker.weaponTypeID, null),
      awardedAt: formatKillmailFiletime(options.whenMs),
    },
  });
  if (!result || result.success !== true) {
    return result || null;
  }
  if (result.changed === true) {
    broadcastKillmarkSlimChange(targetEntity, attackerEntity, awardShipID, result.playerKills);
  }
  return result;
}

function resolveSessionCharacterID(session) {
  return toPositiveInt(
    session && (session.characterID || session.charID || session.charid),
    null,
  );
}

function resolveVictimIdentity(targetEntity, options = {}) {
  if (!targetEntity) {
    return {
      victimCharacterID: null,
      victimCorporationID: null,
      victimAllianceID: null,
      victimFactionID: null,
      victimShipTypeID: null,
    };
  }

  if (String(targetEntity.kind || "").toLowerCase() === "structure") {
    return {
      victimCharacterID: null,
      victimCorporationID: toPositiveInt(
        targetEntity.corporationID,
        toPositiveInt(targetEntity.ownerID, null),
      ),
      victimAllianceID: toPositiveInt(targetEntity.allianceID, null),
      victimFactionID: null,
      victimShipTypeID: toPositiveInt(targetEntity.typeID, null),
    };
  }

  const victimSession = options && options.victimSession
    ? options.victimSession
    : null;
  const sessionCharacterID = resolveSessionCharacterID(victimSession);
  const characterID = isNpcVictimEntity(targetEntity)
    ? null
    : toPositiveInt(
        targetEntity.pilotCharacterID ?? targetEntity.characterID,
        sessionCharacterID,
      );
  const characterRecord = characterID ? resolveCharacterRecord(characterID) || {} : {};
  return {
    victimCharacterID: characterID,
    victimCorporationID: toPositiveInt(
      characterRecord.corporationID,
      toPositiveInt(
        targetEntity.corporationID,
        toPositiveInt(
          victimSession && victimSession.corporationID,
          toPositiveInt(targetEntity.ownerID, null),
        ),
      ),
    ),
    victimAllianceID: toPositiveInt(
      characterRecord.allianceID,
      toPositiveInt(
        targetEntity.allianceID,
        toPositiveInt(victimSession && victimSession.allianceID, null),
      ),
    ),
    victimFactionID: toPositiveInt(
      characterRecord.factionID,
      toPositiveInt(
        targetEntity.warFactionID,
        toPositiveInt(victimSession && victimSession.warFactionID, null),
      ),
    ),
    victimShipTypeID: toPositiveInt(targetEntity.typeID, null),
  };
}

function getOrCreateLedger(targetEntity, whenMs = Date.now()) {
  cleanupExpiredLedgers(whenMs);
  const ledgerKey = getVictimLedgerKey(targetEntity);
  if (!ledgersByVictim.has(ledgerKey)) {
    ledgersByVictim.set(ledgerKey, {
      victimKey: ledgerKey,
      victimItemID: toPositiveInt(targetEntity && targetEntity.itemID, null),
      victimKind: String(targetEntity && targetEntity.kind || "entity"),
      solarSystemID: toPositiveInt(targetEntity && targetEntity.systemID, null),
      damageTaken: 0,
      attackers: {},
      lastUpdatedAtMs: whenMs,
    });
  }
  return ledgersByVictim.get(ledgerKey);
}

function buildAttackerLedgerKey(identity = {}) {
  return [
    toPositiveInt(identity.characterID, 0) || 0,
    toPositiveInt(identity.corporationID, 0) || 0,
    toPositiveInt(identity.allianceID, 0) || 0,
    toPositiveInt(identity.factionID, 0) || 0,
    toPositiveInt(identity.shipTypeID, 0) || 0,
    toPositiveInt(identity.weaponTypeID, 0) || 0,
  ].join(":");
}

function noteDamage(attackerEntity, targetEntity, appliedDamage, options = {}) {
  const damageAmount = Math.max(0, toFiniteNumber(appliedDamage, 0));
  if (!targetEntity || damageAmount <= 0) {
    return null;
  }

  const whenMs = Number.isFinite(Number(options.whenMs)) ? Number(options.whenMs) : Date.now();
  const ledger = getOrCreateLedger(targetEntity, whenMs);
  const identity = resolveAttackerIdentity(attackerEntity, options);
  const attackerKey = buildAttackerLedgerKey(identity);
  const currentEntry = ledger.attackers[attackerKey] || {
    ...identity,
    damageDone: 0,
  };
  currentEntry.damageDone = toFiniteNumber(currentEntry.damageDone, 0) + damageAmount;
  ledger.attackers[attackerKey] = currentEntry;
  ledger.damageTaken = toFiniteNumber(ledger.damageTaken, 0) + damageAmount;
  ledger.lastUpdatedAtMs = whenMs;
  ledger.solarSystemID = toPositiveInt(
    targetEntity.systemID,
    toPositiveInt(ledger.solarSystemID, null),
  );
  return cloneValue(currentEntry);
}

function resolveKillmailItems(destroyResult = {}, lootLocationIDs = []) {
  const lootOutcomeItems =
    destroyResult &&
    destroyResult.data &&
    destroyResult.data.lootOutcome &&
    Array.isArray(destroyResult.data.lootOutcome.items)
      ? cloneValue(destroyResult.data.lootOutcome.items)
      : null;
  if (lootOutcomeItems) {
    return lootOutcomeItems;
  }
  return lootLocationIDs.flatMap((locationID) => buildKillmailItemTreeForLocation(locationID));
}

function sumItemLossValue(items = []) {
  return items.reduce((sum, item) => {
    const basePrice = Math.max(
      0,
      toFiniteNumber((resolveItemByTypeID(item && item.typeID) || {}).basePrice, 0),
    );
    const quantity =
      Math.max(0, toInteger(item && item.qtyDropped, 0)) +
      Math.max(0, toInteger(item && item.qtyDestroyed, 0));
    return sum + basePrice * quantity + sumItemLossValue(item && item.contents ? item.contents : []);
  }, 0);
}

function resolveLootLocationIDs(targetEntity, destroyResult = {}) {
  if (
    String(targetEntity && targetEntity.kind || "").toLowerCase() === "ship" &&
    destroyResult &&
    destroyResult.data &&
    destroyResult.data.wreck
  ) {
    return [toPositiveInt(destroyResult.data.wreck.itemID, null)].filter(Boolean);
  }

  if (
    String(targetEntity && targetEntity.kind || "").toLowerCase() === "structure" &&
    destroyResult &&
    destroyResult.data
  ) {
    const loot = destroyResult.data.loot || null;
    if (loot) {
      const ids = [];
      if (loot.wreck && loot.wreck.itemID) {
        ids.push(toPositiveInt(loot.wreck.itemID, null));
      }
      for (const container of Array.isArray(loot.containers) ? loot.containers : []) {
        ids.push(toPositiveInt(container && container.containerID, null));
      }
      return ids.filter(Boolean);
    }
    if (Array.isArray(destroyResult.data.lootItemIDs)) {
      return destroyResult.data.lootItemIDs.map((value) => toPositiveInt(value, null)).filter(Boolean);
    }
  }

  return [];
}

function resolveBountyPayout(targetEntity, finalAttacker = {}, options = {}) {
  const bountyRuntime = require(path.join(__dirname, "../../services/bounty/bountyRuntime"));
  const result = bountyRuntime.recordNpcBountyKill(targetEntity, finalAttacker, {
    nowMs: options.whenMs,
    solarSystemID: toPositiveInt(targetEntity && targetEntity.systemID, null),
  });
  if (result && result.eligible === true) {
    return result.amount;
  }

  const hunterCharacterID = toPositiveInt(finalAttacker && finalAttacker.characterID, null);
  if (!hunterCharacterID || !getCharacterWallet(hunterCharacterID)) {
    return null;
  }

  const playerBountyState = require(path.join(__dirname, "../../services/bounty/playerBountyState"));
  const payoutResult = playerBountyState.claimBountyPayout({
    victim: options.victimIdentity || {},
    iskLost: options.iskLost,
    hunterCharacterID,
  });
  if (!payoutResult || payoutResult.eligible !== true || !(payoutResult.amount > 0)) {
    return null;
  }

  const creditResult = adjustCharacterBalance(hunterCharacterID, payoutResult.amount, {
    entryTypeID: JOURNAL_ENTRY_TYPE.NPC_BOUNTY_PRIZE,
    description: JSON.stringify({
      playerBounty: true,
      targetIDs: payoutResult.allocations.map((allocation) => allocation.targetID),
      iskLost: payoutResult.lossValue,
      capAmount: payoutResult.capAmount,
    }),
    ownerID1: hunterCharacterID,
    ownerID2:
      toPositiveInt(options.victimIdentity && options.victimIdentity.victimCharacterID, 0) ||
      toPositiveInt(options.victimIdentity && options.victimIdentity.victimCorporationID, 0) ||
      toPositiveInt(options.victimIdentity && options.victimIdentity.victimAllianceID, 0) ||
      0,
    referenceID:
      toPositiveInt(targetEntity && targetEntity.itemID, 0) ||
      toPositiveInt(options.victimIdentity && options.victimIdentity.victimCharacterID, 0) ||
      hunterCharacterID,
  });
  return creditResult.success ? payoutResult.amount : null;
}

function selectKillRightActivationForKill(victimCharacterID, finalAttacker, whenMs) {
  const targetCharacterID = toPositiveInt(victimCharacterID, 0);
  if (targetCharacterID <= 0) {
    return null;
  }

  const killRightState = getKillRightStateService();
  if (
    !killRightState ||
    typeof killRightState.readActiveActivationsForTarget !== "function"
  ) {
    return null;
  }

  const activations = killRightState.readActiveActivationsForTarget(
    targetCharacterID,
    whenMs,
  );
  if (!Array.isArray(activations) || activations.length === 0) {
    return null;
  }

  const finalCharacterID = toPositiveInt(finalAttacker && finalAttacker.characterID, 0);
  return activations.find((activation) => (
    finalCharacterID > 0 &&
    toPositiveInt(activation && activation.activatorID, 0) === finalCharacterID
  )) || activations[0];
}

function uniqueKillRightNotificationSessions(characterIDs, candidateSessions = []) {
  const sessions = [];
  const seen = new Set();
  const characterSet = new Set(
    (Array.isArray(characterIDs) ? characterIDs : [])
      .map((characterID) => toPositiveInt(characterID, 0))
      .filter((characterID) => characterID > 0),
  );

  const addSession = (session) => {
    if (
      !session ||
      typeof session.sendNotification !== "function" ||
      seen.has(session)
    ) {
      return;
    }
    const characterID = toPositiveInt(
      session.characterID || session.charID || session.charid,
      0,
    );
    if (!characterSet.has(characterID)) {
      return;
    }
    seen.add(session);
    sessions.push(session);
  };

  for (const session of Array.isArray(candidateSessions) ? candidateSessions : []) {
    addSession(session);
  }

  const sessionRegistry = getSessionRegistry();
  if (sessionRegistry && typeof sessionRegistry.findSessionByCharacterID === "function") {
    for (const characterID of characterSet) {
      addSession(sessionRegistry.findSessionByCharacterID(characterID));
    }
  }

  return sessions;
}

function notifyKillRightUsed(activation, targetEntity, attackerEntity) {
  if (!activation) {
    return 0;
  }

  const killRightID = toPositiveInt(activation.killRightID, 0);
  const toID = toPositiveInt(activation.toID, 0);
  if (killRightID <= 0 || toID <= 0) {
    return 0;
  }

  const sessions = uniqueKillRightNotificationSessions(
    [
      activation.fromID,
      activation.toID,
      activation.activatorID,
      attackerEntity && (attackerEntity.characterID || attackerEntity.pilotCharacterID),
    ],
    [
      targetEntity && targetEntity.session,
      attackerEntity && attackerEntity.session,
    ],
  );

  for (const session of sessions) {
    session.sendNotification("OnKillRightUsed", "clientID", [killRightID, toID]);
  }
  return sessions.length;
}

function isLiveNotificationSession(session) {
  return Boolean(
    session &&
      typeof session.sendNotification === "function" &&
      (!session.socket || !session.socket.destroyed),
  );
}

function resolveKillmailNotificationSessions(victimCharacterID, extraSessions = []) {
  const targetCharacterID = toPositiveInt(victimCharacterID, 0) || 0;
  if (targetCharacterID <= 0) {
    return [];
  }

  const sessions = [];
  const seen = new Set();
  const addSession = (session) => {
    if (!isLiveNotificationSession(session) || seen.has(session)) {
      return;
    }
    const sessionCharacterID = toPositiveInt(
      session.characterID || session.charID || session.charid,
      0,
    ) || 0;
    if (sessionCharacterID !== targetCharacterID) {
      return;
    }
    seen.add(session);
    sessions.push(session);
  };

  const sessionRegistry = getSessionRegistry();
  if (sessionRegistry && typeof sessionRegistry.getSessions === "function") {
    for (const session of sessionRegistry.getSessions()) {
      addSession(session);
    }
  }
  for (const session of Array.isArray(extraSessions) ? extraSessions : []) {
    addSession(session);
  }
  return sessions;
}

function notifyVictimKillmailAvailable(record, targetEntity, victimIdentity, options = {}) {
  const victimCharacterID = toPositiveInt(
    victimIdentity && victimIdentity.victimCharacterID,
    0,
  ) || 0;
  const killID = toPositiveInt(record && record.killID, 0) || 0;
  if (victimCharacterID <= 0 || killID <= 0) {
    return null;
  }

  const notificationState = getNotificationStateService();
  const notificationConstants = getNotificationConstants();
  if (
    !notificationState ||
    typeof notificationState.createNotification !== "function" ||
    !notificationConstants ||
    !notificationConstants.NOTIFICATION_TYPE
  ) {
    return null;
  }

  const killmailState = getKillmailStateService();
  const killMailHash =
    killmailState && typeof killmailState.getKillmailHashValue === "function"
      ? killmailState.getKillmailHashValue(record)
      : "";
  const extraSessions = [
    targetEntity && targetEntity.session,
    options.victimSession,
  ].filter(Boolean);
  const notificationResult = notificationState.createNotification(victimCharacterID, {
    typeID: notificationConstants.NOTIFICATION_TYPE.KILL_REPORT_AVAILABLE,
    senderID: CONCORD_CORPORATION_ID,
    groupID: notificationConstants.NOTIFICATION_GROUP.WAR,
    processed: false,
    created: record.killTime,
    data: {
      killMailHash,
      killMailID: killID,
      victimShipTypeID:
        toPositiveInt(record.victimShipTypeID, 0) ||
        toPositiveInt(victimIdentity && victimIdentity.victimShipTypeID, 0) ||
        null,
    },
    extraSessions,
  });
  if (!notificationResult || notificationResult.success !== true) {
    return notificationResult || null;
  }

  const sessions = resolveKillmailNotificationSessions(
    victimCharacterID,
    extraSessions,
  );
  for (const session of sessions) {
    session.sendNotification("OnKillNotification", "charid", []);
    session.sendNotification("OnShipDeath", "charid", []);
  }
  return {
    ...notificationResult,
    sentSessionCount: sessions.length,
  };
}

function consumeKillRightAfterKill(activation, targetEntity, attackerEntity, whenMs) {
  if (!activation) {
    return null;
  }

  const killRightID = toPositiveInt(activation.killRightID, 0);
  if (killRightID <= 0) {
    return null;
  }

  const killRightState = getKillRightStateService();
  if (!killRightState || typeof killRightState.markKillRightUsed !== "function") {
    return null;
  }

  const usedBy =
    toPositiveInt(attackerEntity && (attackerEntity.characterID || attackerEntity.pilotCharacterID), 0) ||
    toPositiveInt(activation.activatorID, 0) ||
    null;
  const usedResult = killRightState.markKillRightUsed(killRightID, usedBy, {
    nowMs: whenMs,
  });
  if (!usedResult || !usedResult.success) {
    return null;
  }

  return {
    killRightID,
    suppliedBy: toPositiveInt(activation.fromID, null),
    toID: toPositiveInt(activation.toID, null),
    usedBy,
    notificationCount: notifyKillRightUsed(activation, targetEntity, attackerEntity),
  };
}

function recordKillmailFromDestruction(targetEntity, destroyResult, options = {}) {
  if (!targetEntity || !destroyResult || destroyResult.success !== true) {
    return null;
  }

  const whenMs = Number.isFinite(Number(options.whenMs)) ? Number(options.whenMs) : Date.now();
  const ledgerKey = getVictimLedgerKey(targetEntity);
  const ledger = ledgersByVictim.get(ledgerKey) || getOrCreateLedger(targetEntity, whenMs);
  const finalIdentity = resolveAttackerIdentity(options.attackerEntity || null, options);
  const finalAttackerKey = buildAttackerLedgerKey(finalIdentity);
  const finalAttacker = ledger.attackers[finalAttackerKey] || {
    ...finalIdentity,
    damageDone: 0,
  };
  ledger.attackers[finalAttackerKey] = finalAttacker;
  ledger.lastUpdatedAtMs = whenMs;

  const victimIdentity = resolveVictimIdentity(targetEntity, options);
  const lootLocationIDs = resolveLootLocationIDs(targetEntity, destroyResult);
  const items = resolveKillmailItems(destroyResult, lootLocationIDs);
  const iskLost =
    Math.max(
      0,
      toFiniteNumber((resolveItemByTypeID(victimIdentity.victimShipTypeID) || {}).basePrice, 0),
    ) + sumItemLossValue(items);
  const bountyClaimed = resolveBountyPayout(targetEntity, finalAttacker, {
    whenMs,
    victimIdentity,
    iskLost,
  });
  // Faction standing loss (TQ parity): destroying a faction NPC lowers standing with its faction
  // only (single-faction hit, no derived; debounced per character/faction/system, calibrated from
  // the golden mission logs). Best-effort; never blocks the kill.
  if (isNpcVictimEntity(targetEntity)) {
    try {
      // Both standing paths key on the session-resolved acting player — the single
      // player-identity test (factionHostilityRuntime). finalAttacker.characterID is NOT that
      // test: NPC drone/fighter final blows carry simulated-pilot characterIDs, which must
      // receive neither the TQ-parity loss nor the R1 gain (standing writes for fake pilots
      // would silently accrete rows as the living universe fights itself). For genuine player
      // kills (turret/missile/smartbomb ships, player drones/fighters) both IDs agree.
      const factionHostility = require(path.join(__dirname, "../../services/character/factionHostilityRuntime"));
      const actingPlayerCharacterID = factionHostility.resolveAttackerPlayerCharacterID(
        options.attackerEntity || null,
      );
      if (actingPlayerCharacterID > 0) {
        const factionKillStanding = require(path.join(__dirname, "../../services/character/factionKillStandingRuntime"));
        factionKillStanding.recordNpcFactionStandingLoss(
          targetEntity,
          actingPlayerCharacterID,
          { nowMs: whenMs, systemID: toPositiveInt(targetEntity && targetEntity.systemID, 0) },
        );
        // Resident track R1: the same kill grants a small standing gain with the victim
        // faction's designated enemies (config-gated, non-TQ). Best-effort like the loss path.
        factionKillStanding.recordNpcFactionStandingGains(
          targetEntity,
          actingPlayerCharacterID,
          { nowMs: whenMs, systemID: toPositiveInt(targetEntity && targetEntity.systemID, 0) },
        );
      }
    } catch (error) {
      /* faction-standing loss is best-effort; the kill must still record */
    }
  }
  // Resident track R1: when a living-universe pilot dies to a player's final blow, stage the
  // actorID -> killer credit for the living runtime's absence-based loss accounting. Gated on
  // livingUniverseFlightID (exclusive to living flights — industrial/mining crew hulls reuse
  // livingUniverseActorID and their losses are never booked by the living runtime), and the
  // killer must resolve through the session-backed player test — flag sniffing misses NPC wing
  // drones, which carry bare simulated-pilot characterIDs. Best-effort; never blocks the kill.
  if (targetEntity.livingUniverseActorID && targetEntity.livingUniverseFlightID) {
    try {
      const factionHostility = require(path.join(__dirname, "../../services/character/factionHostilityRuntime"));
      const killerCharacterID = factionHostility.resolveAttackerPlayerCharacterID(
        options.attackerEntity || null,
      );
      if (killerCharacterID > 0) {
        const livingKillCreditLedger = require(path.join(
          __dirname,
          "../npc/ambientTraffic/livingKillCreditLedger",
        ));
        livingKillCreditLedger.recordPlayerKillCredit(
          String(targetEntity.livingUniverseActorID),
          killerCharacterID,
          whenMs,
        );
      }
    } catch (error) {
      /* kill credit is best-effort; the kill must still record */
    }
  }
  const killRightActivation = selectKillRightActivationForKill(
    victimIdentity.victimCharacterID,
    finalAttacker,
    whenMs,
  );
  const killRecordInput = {
    killTime: formatKillmailFiletime(whenMs),
    solarSystemID: toPositiveInt(targetEntity.systemID, toPositiveInt(ledger.solarSystemID, null)),
    moonID: null,
    ...victimIdentity,
    victimDamageTaken: Math.max(0, toFiniteNumber(ledger.damageTaken, 0)),
    finalCharacterID: finalAttacker.characterID,
    finalCorporationID: finalAttacker.corporationID,
    finalAllianceID: finalAttacker.allianceID,
    finalFactionID: finalAttacker.factionID,
    finalShipTypeID: finalAttacker.shipTypeID,
    finalWeaponTypeID: finalAttacker.weaponTypeID,
    finalSecurityStatus: finalAttacker.securityStatus,
    finalDamageDone: Math.max(0, toFiniteNumber(finalAttacker.damageDone, 0)),
    iskLost,
    bountyClaimed,
    loyaltyPoints: null,
    killRightSupplied: killRightActivation
      ? toPositiveInt(killRightActivation.fromID, null)
      : null,
    attackers: Object.entries(ledger.attackers)
      .filter(([attackerKey]) => attackerKey !== finalAttackerKey)
      .map(([, attacker]) => attacker)
      .sort((left, right) => toFiniteNumber(right && right.damageDone, 0) - toFiniteNumber(left && left.damageDone, 0)),
    items,
  };
  killRecordInput.warID = resolveKillmailWarID(killRecordInput);
  const record = createKillmailRecord(killRecordInput);
  if (record && toPositiveInt(record.killID, 0) > 0) {
    notifyVictimKillmailAvailable(record, targetEntity, victimIdentity, options);
    awardKillmarkForFinalBlow(
      targetEntity,
      options.attackerEntity || null,
      finalAttacker,
      victimIdentity,
      record,
      { whenMs },
    );
  }
  if (record && toPositiveInt(record.killID, 0) > 0 && killRightActivation) {
    consumeKillRightAfterKill(
      killRightActivation,
      targetEntity,
      options.attackerEntity || null,
      whenMs,
    );
  }
  ledgersByVictim.delete(ledgerKey);
  return record;
}

module.exports = {
  noteDamage,
  recordKillmailFromDestruction,
};
module.exports._testing = {
  notifyVictimKillmailAvailable,
};
