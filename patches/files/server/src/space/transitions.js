const path = require("path");

const config = require(path.join(__dirname, "../config"));
const log = require(path.join(__dirname, "../utils/logger"));
const sessionRegistry = require(path.join(
  __dirname,
  "../services/chat/sessionRegistry",
));
const {
  describeSessionHydrationState,
  flushPendingCommandSessionEffects,
} = require(path.join(
  __dirname,
  "../services/chat/commandSessionEffects",
));
const {
  queuePostSpaceAttachFittingHydration,
} = require(path.join(__dirname, "./modules/spaceAttachHydration"));
const {
  applyCharacterToSession,
  clearDockedFittingBootstrap,
  clearDeferredDockedShipSessionChange,
  flushCharacterSessionNotificationPlan,
  getCharacterRecord,
  getCharacterShips,
  findCharacterShip,
  getActiveShipRecord,
  updateCharacterRecord,
  syncInventoryItemForSession,
  emitItemsChangedForSession,
} = require(path.join(__dirname, "../services/character/characterState"));
const {
  CAPSULE_TYPE_ID,
  ITEM_FLAGS,
  ensureCapsuleForCharacter,
  findItemById,
  findCharacterShipByType,
  listContainerItems,
  moveShipToSpace,
  dockShipToLocation,
  dockShipToStation,
  normalizeShipConditionState,
  removeInventoryItem,
  setActiveShipForCharacter,
  updateShipItem,
} = require(path.join(__dirname, "../services/inventory/itemStore"));
const {
  SPECIAL_SHIP_HOLD_FLAGS,
} = require(path.join(
  __dirname,
  "../services/inventory/specialShipHoldRegistry",
));
const structureState = require(path.join(
  __dirname,
  "../services/structure/structureState",
));
const {
  getDockedLocationID,
  getDockedLocationKind,
  getSessionStructureID,
  isDockedSession,
  isStructureDockedSession,
} = require(path.join(__dirname, "../services/structure/structureLocation"));
const {
  currentFileTime,
} = require(path.join(__dirname, "../services/_shared/serviceHelpers"));
const {
  getAppliedSkinRecord,
} = require(path.join(__dirname, "../services/ship/shipCosmeticsState"));
const {
  getEnabledCosmeticsEntries,
} = require(path.join(__dirname, "../services/ship/shipLogoFittingState"));
const {
  buildEmergencyWarpReturnSpaceState,
  clearEmergencyWarpReturnState,
  getEmergencyWarpReturnState,
  shipSuppressesEmergencyWarp,
} = require(path.join(__dirname, "../services/_shared/emergencyWarpRuntime"));
const mapTelemetryState = require(path.join(
  __dirname,
  "../services/map/mapTelemetryState",
));
const {
  broadcastStationGuestJoined,
  broadcastStationGuestLeft,
  broadcastStructureGuestJoined,
  broadcastStructureGuestLeft,
} = require(path.join(__dirname, "../services/_shared/guestLists"));
const crimewatchState = require(path.join(__dirname, "../services/security/crimewatchState"));
const worldData = require(path.join(__dirname, "./worldData"));
const spaceRuntime = require(path.join(__dirname, "./runtime"));
const {
  buildSlimItemObject,
} = require(path.join(__dirname, "./destiny/index.js"));
const {
  buildPlayerEgoScopeMetadata,
  canEntitiesInteractLocally,
} = require(path.join(
  __dirname,
  "./destiny/identity/interactionScope.js",
));
const hostileModuleRuntime = require(path.join(
  __dirname,
  "./modules/hostileModuleRuntime",
));
const {
  createSameSceneDestinyPresentationAuthorityHandoff,
  resolveSameSceneEgoAddBallsStamp,
} = require(path.join(__dirname, "./destiny/delivery/transitionStamps.js"));
const {
  hasDestinyStamp,
  normalizeDestinyStamp,
} = require(path.join(__dirname, "./destiny/delivery/stamps.js"));
const {
  getEntityMapKey,
  normalizeEntityIDSet,
} = require(path.join(__dirname, "./destiny/identity/entityID.js"));
const {
  buildSameSceneShipBoardingHandoffPlan,
  buildSameSceneShipEjectHandoffPlan,
  resolveSameSceneShipBoardingFollowingRemoval,
} = require(path.join(
  __dirname,
  "./destiny/presentation/shipBoarding.js",
));
const {
  bindSameSceneShipHandoffDeliveryScope,
  createSameSceneShipHandoffDeliveryScope,
} = require(path.join(
  __dirname,
  "./destiny/delivery/sameSceneShipHandoff.js",
));
const {
  clearSameSceneDynamicClassification,
} = require(path.join(
  __dirname,
  "./destiny/visibility/membershipState.js",
));
const {
  buildPostAttachVisibilityReconciliationOptions,
} = require(path.join(
  __dirname,
  "./destiny/visibility/controlState.js",
));
const {
  resolveStargatePhysicalRadius,
} = require(path.join(__dirname, "./stargateRadius"));
const {
  getStargateSystemForwardDirection,
} = require(path.join(__dirname, "./stargateOrientation"));
const TRANSITION_GUARD_WINDOW_MS = 5000;
const STARGATE_JUMP_HANDOFF_DELAY_MS = 1250;
const STARGATE_JUMP_RANGE_METERS = 2500;
const STARGATE_JUMP_IN_SURFACE_CLEARANCE_METERS = 12000;
const STARGATE_JUMP_QUEUE_SPACE = 1000;
const STARGATE_JUMP_QUEUE_TIMEOUT_SECONDS = 180;
const SPACE_BOARDING_RANGE_METERS = 6550;
const SESSION_CHANGE_COOLDOWN_MS = 7000;
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const UNDOCK_INVULNERABILITY_DURATION_TICKS = 300000000n;
const UNDOCK_INVULNERABILITY_DURATION_MS = Number(
  UNDOCK_INVULNERABILITY_DURATION_TICKS / FILETIME_TICKS_PER_MS,
);
const TYPE_ORCA = 28606;
const stargateJumpQueuesByDestination = new Map();
const DOCKED_SHIP_CONTENT_REFRESH_FLAGS = new Set([
  ITEM_FLAGS.CARGO_HOLD,
  ITEM_FLAGS.DRONE_BAY,
  ITEM_FLAGS.FIGHTER_BAY,
  ITEM_FLAGS.FUEL_BAY,
  ITEM_FLAGS.SHIP_HANGAR,
  ITEM_FLAGS.FLEET_HANGAR,
  ITEM_FLAGS.MOBILE_DEPOT_HOLD,
  ...SPECIAL_SHIP_HOLD_FLAGS,
]);
const SCRIPTED_HIC_STARGATE_BLOCKED_GROUP_IDS = new Set([
  30, // Titan
  485, // Dreadnought
  547, // Carrier
  659, // Supercarrier
  883, // Capital Industrial Ship
  1538, // Force Auxiliary
  4594, // Lancer Dreadnought
  5120, // Command Carrier
]);
const SCRIPTED_HIC_STARGATE_EXEMPT_GROUP_IDS = new Set([
  513, // Freighter
  902, // Jump Freighter
]);
const BOARDED_CAPSULE_REMOVED_JUNK_LOCATION_ID = 10;

let contrabandInspectionRuntimeModule = null;

function getContrabandInspectionRuntimeModule() {
  if (!contrabandInspectionRuntimeModule) {
    contrabandInspectionRuntimeModule = require(path.join(
      __dirname,
      "../services/security/contrabandInspectionRuntime",
    ));
  }
  return contrabandInspectionRuntimeModule;
}

function getCrimewatchReferenceMs(session) {
  if (session && session._space && Number.isFinite(Number(session._space.simTimeMs))) {
    return Number(session._space.simTimeMs);
  }
  return Date.now();
}

function isScriptedHicStargateBlockedShip(ship) {
  const typeID = toInt(ship && ship.typeID, 0);
  const groupID = toInt(ship && ship.groupID, 0);
  if (typeID === TYPE_ORCA) {
    return false;
  }
  if (SCRIPTED_HIC_STARGATE_EXEMPT_GROUP_IDS.has(groupID)) {
    return false;
  }
  return SCRIPTED_HIC_STARGATE_BLOCKED_GROUP_IDS.has(groupID);
}

function topOffShipShieldAndCapacitorForDockingTransition(shipId) {
  return updateShipItem(shipId, (currentShip) => ({
    ...currentShip,
    conditionState: normalizeShipConditionState({
      ...(currentShip.conditionState || {}),
      charge: 1.0,
      shieldCharge: 1.0,
    }),
  }));
}

function deactivateActiveModulesForSpaceTransition(session, reason) {
  if (!session || !session._space) {
    return {
      success: true,
      data: {
        stoppedModuleIDs: [],
        errors: [],
      },
    };
  }

  const result = spaceRuntime.deactivateAllActiveModules(session, {
    reason,
    clampToVisibleStamp: true,
  });
  if (!result || result.success !== true) {
    log.warn(
      `[SpaceTransition] Failed to fully deactivate active modules before ${reason} ` +
      `for ${session.characterName || session.characterID}: ` +
      `${result && result.errorMsg ? result.errorMsg : "ACTIVE_MODULE_DEACTIVATION_FAILED"}`,
    );
  }
  return result || {
    success: false,
    errorMsg: "ACTIVE_MODULE_DEACTIVATION_FAILED",
  };
}

function syncInventoryChangesToSession(session, changes = [], options = {}) {
  if (!session || typeof session.sendNotification !== "function") {
    return 0;
  }

  let syncedCount = 0;
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || !change.item) {
      continue;
    }

    syncInventoryItemForSession(
      session,
      change.item,
      change.previousData || change.previousState || {},
      {
        emitCfgLocation: options.emitCfgLocation !== false,
      },
    );
    syncedCount += 1;
  }

  return syncedCount;
}

function buildEmptyDict() {
  return { type: "dict", entries: [] };
}

function buildEnabledCosmeticsDictForShip(shipID) {
  try {
    const entries = getEnabledCosmeticsEntries(shipID);
    return {
      type: "dict",
      entries: entries.map((entry) => [
        Number(entry.backendSlot) || 0,
        Number(entry.cosmeticType) || 0,
      ]),
    };
  } catch (error) {
    log.warn(
      `[SpaceTransition] Failed to build cosmetics dict ship=${shipID}: ${error.message}`,
    );
    return buildEmptyDict();
  }
}

function getAppliedShipSkinID(shipID) {
  try {
    const record = getAppliedSkinRecord(shipID);
    return Number(record && record.skinID) || 0;
  } catch (error) {
    log.warn(
      `[SpaceTransition] Failed to resolve current skin ship=${shipID}: ${error.message}`,
    );
    return 0;
  }
}

function sendShipCosmeticsChanged(session, shipID) {
  const normalizedShipID = Number(shipID || 0) || 0;
  if (
    normalizedShipID <= 0 ||
    !session ||
    typeof session.sendNotification !== "function"
  ) {
    return false;
  }

  session.sendNotification("OnShipCosmeticsChanged", "clientID", [
    normalizedShipID,
    buildEnabledCosmeticsDictForShip(normalizedShipID),
  ]);
  return true;
}

function sendCurrentShipSkinChange(session, shipID) {
  const normalizedShipID = Number(shipID || 0) || 0;
  if (
    normalizedShipID <= 0 ||
    !session ||
    typeof session.sendNotification !== "function"
  ) {
    return false;
  }

  session.sendNotification("OnCurrentShipSkinChange", "clientID", [
    normalizedShipID,
    getAppliedShipSkinID(normalizedShipID),
  ]);
  return true;
}

function sendPodOrCorvetteAssembly(session, capsuleItem) {
  const capsuleID = Number(capsuleItem && capsuleItem.itemID) || 0;
  const capsuleTypeID = Number(capsuleItem && capsuleItem.typeID) || CAPSULE_TYPE_ID;
  if (
    capsuleID <= 0 ||
    !session ||
    typeof session.sendNotification !== "function"
  ) {
    return false;
  }

  session.sendNotification("OnPodOrCorvetteAssembly", "charid", [
    capsuleID,
    capsuleTypeID,
  ]);
  return true;
}

function buildBoardedCapsuleRemovedNotificationState(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  return {
    ...item,
    locationID: BOARDED_CAPSULE_REMOVED_JUNK_LOCATION_ID,
    flagID: 0,
    quantity: Number(item.singleton) === 2 ? -2 : -1,
    stacksize: 1,
    singleton: Number(item.singleton) || 1,
  };
}

function emitBoardedCapsuleItemsChanged(session, capsuleItem, previousState = {}) {
  const removedState = buildBoardedCapsuleRemovedNotificationState(capsuleItem);
  if (!removedState) {
    return false;
  }

  return emitItemsChangedForSession(
    session,
    removedState,
    {
      locationID:
        previousState.locationID !== undefined
          ? previousState.locationID
          : capsuleItem.locationID,
      flagID:
        previousState.flagID !== undefined ? previousState.flagID : capsuleItem.flagID,
      quantity:
        previousState.quantity !== undefined
          ? previousState.quantity
          : capsuleItem.quantity,
      singleton:
        previousState.singleton !== undefined
          ? previousState.singleton
          : capsuleItem.singleton,
      stacksize:
        previousState.stacksize !== undefined
          ? previousState.stacksize
          : capsuleItem.stacksize,
    },
    {
      idType: "charid",
      locationContext: null,
    },
  );
}

function submitSameSceneShipHandoffPlan(
  session,
  scene,
  expectedGeneration,
  plan,
  failureCode,
  options = {},
) {
  const shouldStageFollowingRemoval =
    options.stageFollowingRemoval === true;
  let followingRemoval = null;
  if (
    !session ||
    !scene ||
    !expectedGeneration ||
    session._space !== expectedGeneration ||
    !plan ||
    !hasDestinyStamp(plan.stamp) ||
    !Array.isArray(plan.updates) ||
    plan.updates.length === 0 ||
    typeof scene.sendDestinyUpdates !== "function" ||
    (
      shouldStageFollowingRemoval &&
      (
        !plan ||
        !plan.followingRemoval ||
        getEntityMapKey(plan.followingRemoval.entityID) === null ||
        typeof scene.sendRemoveBallsToSession !== "function"
      )
    )
  ) {
    destroySessionAfterUnsafeSameSceneBoundary(scene, session, failureCode);
    return null;
  }

  let deliveryCommitted = false;
  let followingRemovalCommitted = !shouldStageFollowingRemoval;
  let followingRemovalAcceptedStamp = null;
  let emittedStamp = null;
  try {
    const handoffDeliveryScope = shouldStageFollowingRemoval
      ? createSameSceneShipHandoffDeliveryScope(
          session,
          plan.sendOptions,
        )
      : null;
    const handoffSendOptionOverrides = {
      // John stages the handoff and old-capsule teardown in one accepted
      // transaction. The explicit flush below is the sole physical boundary.
      deferDirectDestinyFlush: true,
      onDeliveryCommit: () => {
        deliveryCommitted = session._space === expectedGeneration;
      },
      onDeliveryRollback: () => {
        deliveryCommitted = false;
      },
    };
    const handoffSendOptions = shouldStageFollowingRemoval
      ? bindSameSceneShipHandoffDeliveryScope(
          plan.sendOptions,
          handoffDeliveryScope,
          handoffSendOptionOverrides,
        )
      : {
          ...(plan.sendOptions || {}),
          ...handoffSendOptionOverrides,
        };
    emittedStamp = scene.sendDestinyUpdates(
      session,
      plan.updates,
      false,
      handoffSendOptions,
    );
    if (!hasDestinyStamp(emittedStamp)) {
      throw new Error(failureCode);
    }
    if (shouldStageFollowingRemoval) {
      followingRemoval = resolveSameSceneShipBoardingFollowingRemoval(
        plan,
        emittedStamp,
      );
      if (
        !followingRemoval ||
        getEntityMapKey(followingRemoval.entityID) === null ||
        !hasDestinyStamp(followingRemoval.stamp) ||
        !followingRemoval.sendOptions ||
        typeof followingRemoval.sendOptions !== "object"
      ) {
        throw new Error(failureCode);
      }
      const followingRemovalSendOptions =
        bindSameSceneShipHandoffDeliveryScope(
          followingRemoval.sendOptions,
          handoffDeliveryScope,
          { deferDirectDestinyFlush: true },
        );
      const removalDelivery = scene.sendRemoveBallsToSession(
        session,
        [followingRemoval.entityID],
        {
          stampOverride: followingRemoval.stamp,
          sendOptions: followingRemovalSendOptions,
          onDeliveryCommit: (_details) => {
            followingRemovalCommitted =
              session._space === expectedGeneration;
            followingRemovalAcceptedStamp =
              normalizeDestinyStamp(followingRemoval.stamp);
          },
          onDeliveryRollback: () => {
            followingRemovalCommitted = false;
            followingRemovalAcceptedStamp = null;
          },
        },
      );
      if (!removalDelivery || removalDelivery.delivered !== true) {
        throw new Error(failureCode);
      }
    }
    if (
      typeof options.beforeDeliveryFlush === "function" &&
      options.beforeDeliveryFlush() !== true
    ) {
      throw new Error(failureCode);
    }
    if (session._space !== expectedGeneration) {
      throw new Error(failureCode);
    }
    if (!flushSameSceneDestinyDelivery(scene, session, expectedGeneration)) {
      throw new Error(failureCode);
    }
  } catch (_error) {
    destroySessionAfterUnsafeSameSceneBoundary(scene, session, failureCode);
    return null;
  }
  if (
    !deliveryCommitted ||
    !followingRemovalCommitted ||
    (
      shouldStageFollowingRemoval &&
      followingRemovalAcceptedStamp !==
        normalizeDestinyStamp(followingRemoval.stamp)
    )
  ) {
    destroySessionAfterUnsafeSameSceneBoundary(scene, session, failureCode);
    return null;
  }
  return {
    stamp: normalizeDestinyStamp(emittedStamp),
    followingRemovalStamp: shouldStageFollowingRemoval
      ? followingRemovalAcceptedStamp
      : null,
  };
}

function sendEjectHandoffDestiny(
  session,
  scene,
  expectedGeneration,
  abandonedShipEntity,
  capsuleEntity,
) {
  let plan;
  try {
    plan = buildSameSceneShipEjectHandoffPlan({
      previousEntity: abandonedShipEntity,
      boardedEntity: capsuleEntity,
      buildSlimItemObject,
      stampOverride: resolveSameSceneEgoAddBallsStamp(scene, session),
    });
  } catch (_error) {
    destroySessionAfterUnsafeSameSceneBoundary(
      scene,
      session,
      "DESTINY_EGO_VISIBILITY_DELIVERY_FAILED",
    );
    return null;
  }
  const result = submitSameSceneShipHandoffPlan(
    session,
    scene,
    expectedGeneration,
    plan,
    "DESTINY_EGO_VISIBILITY_DELIVERY_FAILED",
  );
  return result && result.stamp;
}

function applyTqDockingTransitionSessionChangeShape(plan) {
  if (!plan || !plan.sessionChanges) {
    return plan;
  }
  const sessionChanges = plan.sessionChanges;
  delete sessionChanges.stationid2;

  const orderedChanges = {};
  for (const key of ["stationid", "structureid", "locationid", "solarsystemid"]) {
    if (Object.prototype.hasOwnProperty.call(sessionChanges, key)) {
      orderedChanges[key] = sessionChanges[key];
    }
  }
  for (const [key, value] of Object.entries(sessionChanges)) {
    if (!Object.prototype.hasOwnProperty.call(orderedChanges, key)) {
      orderedChanges[key] = value;
    }
  }
  plan.sessionChanges = orderedChanges;
  return plan;
}

function sendUndockInvulnerabilityUpdated(session, shipID) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  const normalizedShipID = Number(shipID || session.shipid || session.shipID || 0);
  if (!Number.isFinite(normalizedShipID) || normalizedShipID <= 0) {
    return false;
  }

  session.sendNotification("OnInvulunOnUndockingUpdated", "shipid", [
    normalizedShipID,
    currentFileTime() + UNDOCK_INVULNERABILITY_DURATION_TICKS,
    UNDOCK_INVULNERABILITY_DURATION_TICKS,
  ]);
  return true;
}

function sendInvulnerabilityCancelled(session, shipID) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  const normalizedShipID = Number(shipID || session.shipid || session.shipID || 0);
  if (!Number.isFinite(normalizedShipID) || normalizedShipID <= 0) {
    return false;
  }

  session.sendNotification("OnInvulnCancelled", "shipid", [normalizedShipID]);
  return true;
}

function clearPendingUndockInvulnerability(session) {
  if (!session || !session._undockInvulnerabilityCancelTimer) {
    return false;
  }
  clearTimeout(session._undockInvulnerabilityCancelTimer);
  session._undockInvulnerabilityCancelTimer = null;
  return true;
}

function markUndockInvulnerabilityState(session, shipID, durationMs) {
  const scene = spaceRuntime.getSceneForSession(session);
  const entity = scene && typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(shipID)
    : null;
  if (!entity) {
    return false;
  }
  entity.undockInvulnerabilityActive = true;
  entity.undockInvulnerabilityUntilMs =
    scene.getCurrentSimTimeMs() + Math.max(0, Number(durationMs) || 0);
  return true;
}

function scheduleUndockInvulnerabilityCancellation(session, shipID, options = {}) {
  clearPendingUndockInvulnerability(session);
  const delayMs = Math.max(
    0,
    Number.isFinite(Number(options.delayMs))
      ? Number(options.delayMs)
      : UNDOCK_INVULNERABILITY_DURATION_MS,
  );
  markUndockInvulnerabilityState(session, shipID, delayMs);
  const timer = setTimeout(() => {
    if (!session || session._undockInvulnerabilityCancelTimer !== timer) {
      return;
    }
    session._undockInvulnerabilityCancelTimer = null;
    const scene = spaceRuntime.getSceneForSession(session);
    if (scene && typeof scene.flushDirectDestinyNotificationBatchIfIdle === "function") {
      scene.flushDirectDestinyNotificationBatchIfIdle();
    }
    sendInvulnerabilityCancelled(session, shipID);
    if (scene && typeof scene.flushDirectDestinyNotificationBatchIfIdle === "function") {
      scene.flushDirectDestinyNotificationBatchIfIdle();
    }
    const entity = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(shipID)
      : null;
    if (entity) {
      entity.undockInvulnerabilityActive = false;
      entity.undockInvulnerabilityUntilMs = 0;
    }
    if (scene && typeof scene.syncSessionStructureTetherState === "function") {
      const tetherSync = scene.syncSessionStructureTetherState(session, {
        forceReplayFx: true,
        repairOnEngage: true,
        replayFx: false,
      });
      const tetherStructureID =
        tetherSync &&
        tetherSync.success &&
        tetherSync.data &&
        tetherSync.data.active
          ? tetherSync.data.structureID
          : 0;
      if (
        tetherStructureID > 0 &&
        typeof scene.sendTqUndockTetherPresentationToSession === "function"
      ) {
        scene.sendTqUndockTetherPresentationToSession(
          session,
          shipID,
          tetherStructureID,
        );
      }
    }
    if (scene && typeof scene.flushDirectDestinyNotificationBatchIfIdle === "function") {
      scene.flushDirectDestinyNotificationBatchIfIdle();
    }
  }, delayMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  session._undockInvulnerabilityCancelTimer = timer;
  return true;
}

function sendDockingFinished(session, stationID) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  const normalizedStationID = Number(stationID || session.stationid || session.stationID || 0);
  if (!Number.isFinite(normalizedStationID) || normalizedStationID <= 0) {
    return false;
  }

  session.sendNotification("OnDockingFinished", "charid", [normalizedStationID]);
  return true;
}

function getStargateJumpQueue(destinationSolarSystemID) {
  const normalizedDestinationID = Number(destinationSolarSystemID || 0);
  if (!Number.isFinite(normalizedDestinationID) || normalizedDestinationID <= 0) {
    return null;
  }
  if (!stargateJumpQueuesByDestination.has(normalizedDestinationID)) {
    stargateJumpQueuesByDestination.set(normalizedDestinationID, new Map());
  }
  return stargateJumpQueuesByDestination.get(normalizedDestinationID);
}

function cleanupStargateJumpQueue(destinationSolarSystemID, nowMs = Date.now()) {
  const normalizedDestinationID = Number(destinationSolarSystemID || 0);
  const queue = stargateJumpQueuesByDestination.get(normalizedDestinationID);
  if (!queue) {
    return null;
  }
  for (const [characterID, entry] of queue.entries()) {
    if (!entry || Number(entry.expiresAtMs || 0) <= nowMs) {
      queue.delete(characterID);
    }
  }
  if (queue.size === 0) {
    stargateJumpQueuesByDestination.delete(normalizedDestinationID);
    return null;
  }
  return queue;
}

function recordStargateJumpQueueEntry(
  destinationSolarSystemID,
  characterID,
  options = {},
) {
  const normalizedCharacterID = Number(characterID || 0);
  if (!Number.isFinite(normalizedCharacterID) || normalizedCharacterID <= 0) {
    return null;
  }
  const nowMs = Number.isFinite(Number(options.nowMs))
    ? Number(options.nowMs)
    : Date.now();
  cleanupStargateJumpQueue(destinationSolarSystemID, nowMs);
  const queue = getStargateJumpQueue(destinationSolarSystemID);
  if (!queue) {
    return null;
  }
  queue.set(normalizedCharacterID, {
    characterID: normalizedCharacterID,
    fileTime:
      options.fileTime === undefined || options.fileTime === null
        ? currentFileTime()
        : options.fileTime,
    expiresAtMs: nowMs + STARGATE_JUMP_QUEUE_TIMEOUT_SECONDS * 1000,
  });
  return queue;
}

function getStargateJumpQueuePayload(destinationSolarSystemID, activeCharacterID) {
  const activeEntryQueue = recordStargateJumpQueueEntry(
    destinationSolarSystemID,
    activeCharacterID,
  );
  const queue =
    activeEntryQueue || cleanupStargateJumpQueue(destinationSolarSystemID) || null;
  if (!queue || queue.size === 0) {
    return null;
  }
  const characterIDs = [];
  const timestampEntries = [];
  for (const [characterID, entry] of queue.entries()) {
    characterIDs.push(characterID);
    timestampEntries.push([characterID, entry.fileTime]);
  }
  return {
    characterIDs,
    timestampEntries,
  };
}

function sendJumpQueueUpdate(session, destinationSolarSystemID) {
  if (!session || typeof session.sendNotification !== "function") {
    return false;
  }

  const normalizedDestinationID = Number(destinationSolarSystemID || 0);
  const characterID = Number(session.characterID || session.charid || session.charID || 0);
  const queuePayload = getStargateJumpQueuePayload(
    normalizedDestinationID,
    characterID,
  );
  if (
    !Number.isFinite(normalizedDestinationID) ||
    normalizedDestinationID <= 0 ||
    !Number.isFinite(characterID) ||
    characterID <= 0 ||
    !queuePayload
  ) {
    return false;
  }

  session.sendNotification("OnJumpQueueUpdate", "clientID", [
    normalizedDestinationID,
    STARGATE_JUMP_QUEUE_SPACE,
    queuePayload.characterIDs,
    {
      type: "dict",
      entries: queuePayload.timestampEntries,
    },
    STARGATE_JUMP_QUEUE_TIMEOUT_SECONDS,
  ]);
  return true;
}

function collectSessionBoundObjectIDs(session) {
  const objectIDs = [];
  const seen = new Set();
  const addObjectID = (value) => {
    const objectID = typeof value === "string" ? value.trim() : "";
    if (!objectID || seen.has(objectID)) {
      return;
    }
    seen.add(objectID);
    objectIDs.push(objectID);
  };

  if (session && session._boundObjectIDs && typeof session._boundObjectIDs === "object") {
    for (const value of Object.values(session._boundObjectIDs)) {
      addObjectID(value);
    }
  }
  if (session && session._boundObjectState && typeof session._boundObjectState === "object") {
    for (const state of Object.values(session._boundObjectState)) {
      addObjectID(state && state.objectID);
    }
  }
  if (session) {
    addObjectID(session.currentBoundObjectID);
    addObjectID(session.lastBoundObjectID);
  }

  return objectIDs;
}

function sendMachoObjectDisconnects(session) {
  if (!session || typeof session.sendNotification !== "function") {
    return 0;
  }

  const clientID = Number(session.clientID || session.clientid || 0);
  if (!Number.isFinite(clientID) || clientID <= 0) {
    return 0;
  }

  let sentCount = 0;
  for (const objectID of collectSessionBoundObjectIDs(session)) {
    session.sendNotification("OnMachoObjectDisconnect", "+clientID", [
      objectID,
      clientID,
      null,
    ]);
    sentCount += 1;
  }
  return sentCount;
}

function inspectContrabandForTransition(session, shipID, solarSystemID, reason) {
  if (!session || !session.characterID || !shipID || !solarSystemID) {
    return null;
  }
  const { inspectCharacterContraband } = getContrabandInspectionRuntimeModule();
  const result = inspectCharacterContraband(
    session.characterID,
    shipID,
    solarSystemID,
    { reason },
  );
  if (!result || !result.success) {
    log.warn(
      `[SpaceTransition] Contraband inspection failed reason=${reason} char=${session.characterID} ship=${shipID} system=${solarSystemID}: ${(result && result.errorMsg) || "UNKNOWN_ERROR"}`,
    );
    return null;
  }

  const penalties = result.data && result.data.penalties;
  if (penalties && Array.isArray(penalties.removedChanges)) {
    syncInventoryChangesToSession(session, penalties.removedChanges, {
      emitCfgLocation: true,
    });
  }
  return result.data || null;
}

function finalizeBoardedCapsuleConsumption(
  scene,
  session,
  expectedGeneration,
  capsuleEntity,
  options = {},
) {
  if (
    !scene ||
    !session ||
    !expectedGeneration ||
    session._space !== expectedGeneration ||
    !capsuleEntity ||
    capsuleEntity.kind !== "ship" ||
    !hasDestinyStamp(options.acceptedRemovalStamp)
  ) {
    return {
      success: false,
      errorMsg: "CAPSULE_REMOVAL_DELIVERY_FAILED",
    };
  }
  const removeEntityResult = scene.removeDynamicEntity(capsuleEntity.itemID, {
    allowSessionOwned: true,
    // The owner already accepted this exact RemoveBalls in the handoff
    // transaction. Only observers still need the topology broadcast.
    excludedSession: session,
    stampOverride: options.acceptedRemovalStamp,
  });
  if (!removeEntityResult.success) {
    return removeEntityResult;
  }

  const removeItemResult = removeInventoryItem(capsuleEntity.itemID, {
    removeContents: true,
  });
  if (!removeItemResult.success) {
    return removeItemResult;
  }

  return {
    success: true,
    data: {
      entityID: capsuleEntity.itemID,
      changes:
        removeItemResult.data && Array.isArray(removeItemResult.data.changes)
          ? removeItemResult.data.changes
          : [],
    },
  };
}

function buildBoundResult(session) {
  if (!session) {
    return null;
  }

  const preferredBoundId =
    session.currentBoundObjectID ||
    (session._boundObjectIDs && (session._boundObjectIDs.ship || session._boundObjectIDs.beyonce)) ||
    session.lastBoundObjectID ||
    null;
  if (!preferredBoundId) {
    return null;
  }

  const readyAtMs = Date.now() + SESSION_CHANGE_COOLDOWN_MS;
  const readyAtFileTime =
    BigInt(Math.trunc(readyAtMs)) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET;
  if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
    spaceRuntime.recordSessionJumpTimingTrace(session, "build-bound-result", {
      preferredBoundId,
      readyAtMs,
      readyAtFileTime: readyAtFileTime.toString(),
      cooldownMs: SESSION_CHANGE_COOLDOWN_MS,
    });
  }
  return [preferredBoundId, readyAtFileTime];
}

function buildLocationIdentityPatch(record, solarSystemID, extra = {}) {
  const targetSolarSystemID = Number(solarSystemID || 0) || Number(record.solarSystemID || 30000142) || 30000142;
  const system = worldData.getSolarSystemByID(targetSolarSystemID);

  return {
    ...record,
    ...extra,
    solarSystemID: targetSolarSystemID,
    constellationID:
      Number((system && system.constellationID) || record.constellationID || 0) ||
      20000020,
    regionID:
      Number((system && system.regionID) || record.regionID || 0) ||
      10000002,
    worldSpaceID: 0,
  };
}

function resolveDockableLocation(locationID) {
  const numericLocationID = Number(locationID || 0) || 0;
  if (!numericLocationID) {
    return null;
  }

  const station = worldData.getStationByID(numericLocationID);
  if (station) {
    return {
      kind: "station",
      record: station,
      locationID: station.stationID,
      solarSystemID: station.solarSystemID,
      label: station.stationName || `Station ${station.stationID}`,
    };
  }

  const structure = worldData.getStructureByID(numericLocationID);
  if (structure) {
    return {
      kind: "structure",
      record: structure,
      locationID: structure.structureID,
      solarSystemID: structure.solarSystemID,
      label: structure.itemName || structure.name || `Structure ${structure.structureID}`,
    };
  }

  return null;
}

function beginTransition(session, kind, targetID = 0) {
  if (!session) {
    return false;
  }

  const now = Date.now();
  const activeTransition = session._transitionState || null;
  if (
    activeTransition &&
    activeTransition.kind === kind &&
    (now - Number(activeTransition.startedAt || 0)) < TRANSITION_GUARD_WINDOW_MS
  ) {
    return false;
  }

  session._transitionState = {
    kind,
    targetID: Number(targetID || 0) || 0,
    startedAt: now,
  };
  return true;
}

function endTransition(session, kind) {
  if (
    session &&
    session._transitionState &&
    session._transitionState.kind === kind
  ) {
    session._transitionState = null;
  }
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  const vectorSource =
    source && typeof source === "object"
      ? source
      : null;
  return {
    x: toFiniteNumber(vectorSource ? vectorSource.x : undefined, fallback.x),
    y: toFiniteNumber(vectorSource ? vectorSource.y : undefined, fallback.y),
    z: toFiniteNumber(vectorSource ? vectorSource.z : undefined, fallback.z),
  };
}

function addVectors(left, right) {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}

function subtractVectors(left, right) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function scaleVector(vector, scalar) {
  return {
    x: vector.x * scalar,
    y: vector.y * scalar,
    z: vector.z * scalar,
  };
}

function normalizeVector(vector, fallback = { x: 1, y: 0, z: 0 }) {
  const length = Math.sqrt((vector.x ** 2) + (vector.y ** 2) + (vector.z ** 2));
  if (!Number.isFinite(length) || length <= 0) {
    return cloneVector(fallback);
  }

  return scaleVector(vector, 1 / length);
}

function distance(left, right) {
  const delta = subtractVectors(left, right);
  return Math.sqrt((delta.x ** 2) + (delta.y ** 2) + (delta.z ** 2));
}

function magnitude(vector) {
  return Math.sqrt((vector.x ** 2) + (vector.y ** 2) + (vector.z ** 2));
}

function buildSharedWorldPosition(systemPosition, localPosition) {
  return {
    x: toFiniteNumber(systemPosition && systemPosition.x, 0) -
      toFiniteNumber(localPosition && localPosition.x, 0),
    y: toFiniteNumber(systemPosition && systemPosition.y, 0) +
      toFiniteNumber(localPosition && localPosition.y, 0),
    z: toFiniteNumber(systemPosition && systemPosition.z, 0) +
      toFiniteNumber(localPosition && localPosition.z, 0),
  };
}

function getDirectionFromDunRotation(dunRotation) {
  if (!Array.isArray(dunRotation) || dunRotation.length < 2) {
    return null;
  }

  const yaw = toFiniteNumber(dunRotation[0], 0) * (Math.PI / 180);
  const pitch = toFiniteNumber(dunRotation[1], 0) * (Math.PI / 180);
  return normalizeVector({
    x: Math.sin(yaw) * Math.cos(pitch),
    y: -Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  });
}

function getDerivedStargateForwardDirection(stargate) {
  const sourceSystem = worldData.getSolarSystemByID(stargate && stargate.solarSystemID);
  const destinationGate = worldData.getStargateByID(stargate && stargate.destinationID);
  const destinationSystemID =
    toInt(stargate && stargate.destinationSolarSystemID, 0) ||
    toInt(destinationGate && destinationGate.solarSystemID, 0);
  const destinationSystem = worldData.getSolarSystemByID(
    destinationSystemID,
  );
  if (!sourceSystem || !destinationSystem) {
    return null;
  }

  return getStargateSystemForwardDirection(stargate, sourceSystem, destinationSystem);
}

function getResolvedStargateForwardDirection(stargate) {
  return (
    getDirectionFromDunRotation(stargate && stargate.dunRotation) ||
    getDerivedStargateForwardDirection(stargate) ||
    normalizeVector(cloneVector(stargate && stargate.position), { x: 1, y: 0, z: 0 })
  );
}

function resolveShipRadiusMeters(ship) {
  const directRadius = Math.max(
    0,
    toFiniteNumber(ship && (ship.radius ?? ship.spaceRadius), 0),
  );
  if (directRadius > 0) {
    return directRadius;
  }

  const shipTypeID = Number(ship && (ship.shipTypeID || ship.typeID)) || 0;
  if (shipTypeID <= 0) {
    return 0;
  }

  const movement = worldData.getMovementAttributesForType(shipTypeID);
  return Math.max(0, toFiniteNumber(movement && movement.radius, 0));
}

function buildGateSpawnState(stargate, ship = null) {
  const direction = getResolvedStargateForwardDirection(stargate);
  const offset =
    resolveStargatePhysicalRadius(stargate) +
    resolveShipRadiusMeters(ship) +
    STARGATE_JUMP_IN_SURFACE_CLEARANCE_METERS;

  return {
    direction,
    position: addVectors(
      cloneVector(stargate.position),
      scaleVector(direction, offset),
    ),
  };
}

function buildOffsetSpawnState(anchor, options = {}) {
  const fallbackDirection = cloneVector(
    options.fallbackDirection,
    { x: 1, y: 0, z: 0 },
  );
  const anchorPosition = cloneVector(anchor && anchor.position);
  const direction = normalizeVector(
    magnitude(anchorPosition) > 0 ? anchorPosition : fallbackDirection,
    fallbackDirection,
  );
  const minOffset = Math.max(toFiniteNumber(options.minOffset, 0), 0);
  const clearance = Math.max(toFiniteNumber(options.clearance, 0), 0);
  const offset = Math.max(toFiniteNumber(anchor && anchor.radius, 0) + clearance, minOffset);
  const position = addVectors(anchorPosition, scaleVector(direction, offset));

  return {
    direction,
    position,
  };
}

function buildSolarSystemSpawnState(solarSystemID) {
  const system = worldData.getSolarSystemByID(solarSystemID);
  if (!system) {
    return null;
  }

  const stargates = worldData.getStargatesForSystem(solarSystemID);
  if (stargates.length > 0) {
    const stargate = stargates[0];
    return {
      anchorType: "stargate",
      anchorID: stargate.itemID,
      anchorName: stargate.itemName || `Stargate ${stargate.itemID}`,
      ...buildOffsetSpawnState(stargate, {
        minOffset: Math.max(resolveStargatePhysicalRadius(stargate) * 0.4, 5000),
      }),
    };
  }

  const stations = worldData.getStationsForSystem(solarSystemID);
  if (stations.length > 0) {
    const station = stations[0];
    return {
      anchorType: "station",
      anchorID: station.stationID,
      anchorName: station.stationName || `Station ${station.stationID}`,
      ...buildOffsetSpawnState(station, {
        minOffset: Math.max((station.radius || 15000) * 0.4, 5000),
        clearance: 5000,
      }),
    };
  }

  const celestials = worldData.getCelestialsForSystem(solarSystemID);
  const celestial =
    celestials.find((entry) => entry.kind !== "sun" && entry.groupID !== 6) ||
    celestials.find((entry) => entry.kind === "sun" || entry.groupID === 6) ||
    celestials[0] ||
    null;
  if (celestial) {
    return {
      anchorType: celestial.kind || "celestial",
      anchorID: celestial.itemID,
      anchorName: celestial.itemName || `Celestial ${celestial.itemID}`,
      ...buildOffsetSpawnState(celestial, {
        minOffset: 100000,
        clearance: celestial.kind === "sun" || celestial.groupID === 6
          ? 250000
          : 25000,
      }),
    };
  }

  return {
    anchorType: "fallback",
    anchorID: system.solarSystemID,
    anchorName: system.solarSystemName || `System ${system.solarSystemID}`,
    direction: { x: 1, y: 0, z: 0 },
    position: { x: 1000000, y: 0, z: 0 },
  };
}

function broadcastOnCharNowInStation(session, stationID) {
  broadcastStationGuestJoined(session, stationID);
}

function broadcastOnCharNoLongerInStation(session, stationID) {
  broadcastStationGuestLeft(session, stationID);
}

function broadcastOnCharacterEnteredStructure(session, structureID) {
  broadcastStructureGuestJoined(session, structureID);
}

function broadcastOnCharacterLeftStructure(session, structureID) {
  broadcastStructureGuestLeft(session, structureID);
}

function buildSolarSessionChangeOptions(session, solarSystemID) {
  const sourceNodeID =
    Number(session && session._machoNodeID) ||
    Number(config.proxyNodeId) ||
    0;
  if (session && typeof session === "object" && sourceNodeID > 0) {
    session._machoNodeID = sourceNodeID;
  }
  return {
    sourceNodeID,
    nodesOfInterest: [sourceNodeID],
  };
}

function queuePendingSessionEffects(session, options = {}) {
  if (!session || typeof session !== "object") {
    return;
  }

  if (
    options.forceInitialBallpark ||
    options.awaitBeyonceBoundBallpark
  ) {
    session._pendingCommandInitialBallpark = {
      force: options.forceInitialBallpark === true,
      awaitBeyonceBound: options.awaitBeyonceBoundBallpark === true,
    };
  }

  if (Object.prototype.hasOwnProperty.call(options, "previousLocalChannelID")) {
    session._pendingLocalChannelSync = {
      previousChannelID: Number(options.previousLocalChannelID || 0) || 0,
    };
  }

}

function getSurfaceDistanceBetweenEntities(entity, targetEntity) {
  const centerDistance = distance(entity.position, targetEntity.position);
  return Math.max(
    0,
    centerDistance -
      Math.max(0, toFiniteNumber(entity && entity.radius, 0)) -
      Math.max(0, toFiniteNumber(targetEntity && targetEntity.radius, 0)),
  );
}

function buildStoppedSpaceStateFromEntity(entity) {
  const position = cloneVector(entity && entity.position);
  return {
    ...buildPlayerEgoScopeMetadata(entity),
    position,
    direction: normalizeVector(
      cloneVector(entity && entity.direction, { x: 1, y: 0, z: 0 }),
      { x: 1, y: 0, z: 0 },
    ),
    velocity: { x: 0, y: 0, z: 0 },
    speedFraction: 0,
    mode: "STOP",
    targetPoint: position,
  };
}

function buildCloneVatArrivalSpaceState(targetShipItem, targetEntity = null) {
  const sourceState =
    targetEntity && targetEntity.position
      ? {
          position: targetEntity.position,
          direction: targetEntity.direction,
          radius: targetEntity.radius,
        }
      : (targetShipItem && targetShipItem.spaceState) || {};
  const targetPosition = cloneVector(sourceState.position);
  const targetDirection = normalizeVector(
    cloneVector(sourceState.direction, { x: 1, y: 0, z: 0 }),
    { x: 1, y: 0, z: 0 },
  );
  const offsetMeters = Math.max(
    2500,
    toFiniteNumber(
      sourceState.radius,
      toFiniteNumber(targetShipItem && targetShipItem.spaceRadius, 0),
    ) + 1500,
  );
  const position = addVectors(
    targetPosition,
    scaleVector(targetDirection, -offsetMeters),
  );
  return {
    position,
    direction: targetDirection,
    velocity: { x: 0, y: 0, z: 0 },
    speedFraction: 0,
    mode: "STOP",
    targetPoint: position,
  };
}

function captureSpaceSessionState(session) {
  return {
    beyonceBound: Boolean(session && session._space && session._space.beyonceBound),
    initialStateSent: Boolean(
      session && session._space && session._space.initialStateSent,
    ),
    initialBallparkVisualsSent: Boolean(
      session && session._space && session._space.initialBallparkVisualsSent,
    ),
    initialBallparkClockSynced: Boolean(
      session && session._space && session._space.initialBallparkClockSynced,
    ),
  };
}

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

const SHIP_DESTRUCTION_EJECT_WARP_LANDING_BYPASS = Symbol(
  "shipDestructionEjectWarpLandingBypass",
);

function isPilotWarpLandingPending(session) {
  return Boolean(
    spaceRuntime &&
    typeof spaceRuntime.isPilotWarpLandingPending === "function" &&
    spaceRuntime.isPilotWarpLandingPending(session),
  );
}

function buildWarpLandingPendingResult() {
  return {
    success: false,
    errorMsg: "WARP_LANDING_PENDING",
  };
}

function repairSameSceneSessionViewState(session) {
  if (!session || !session._space) {
    return false;
  }

  // Same-scene ship swaps happen inside an already-live ballpark. If the local
  // bootstrap flags have drifted false, falling back to a fresh
  // ensureInitialBallpark() rebuild replays stale hull state and forces the
  // client through an owner SetState reset. Repair the bookkeeping instead.
  session._space.initialStateSent = true;
  session._space.initialBallparkVisualsSent = true;
  session._space.initialBallparkClockSynced = true;
  return true;
}

function isSameSceneDestinyDeliveryBoundaryUsable(
  scene,
  session,
  expectedGeneration,
) {
  return Boolean(
    scene &&
    session &&
    expectedGeneration &&
    session._space === expectedGeneration &&
    typeof scene.isSessionOpenForDestinyDelivery === "function" &&
    scene.isSessionOpenForDestinyDelivery(session) === true
  );
}

function flushSameSceneDestinyDelivery(
  scene,
  session = null,
  expectedGeneration = null,
) {
  if (typeof scene.flushTickDestinyPresentationBatch === "function") {
    scene.flushTickDestinyPresentationBatch();
  }
  if (typeof scene.flushDirectDestinyNotificationBatch === "function") {
    scene.flushDirectDestinyNotificationBatch();
  }
  return !session || isSameSceneDestinyDeliveryBoundaryUsable(
    scene,
    session,
    expectedGeneration,
  );
}

function destroySessionAfterUnsafeSameSceneBoundary(
  scene,
  session,
  code,
) {
  const error = new Error(code);
  error.code = code;
  if (typeof scene.destroySessionAfterUnsafeDestinyDelivery === "function") {
    scene.destroySessionAfterUnsafeDestinyDelivery(session, error);
  }
  return false;
}

function ensureSameSceneBoardTargetVisible(session, scene, targetEntity) {
  if (!session || !session._space || !scene || !targetEntity) {
    return false;
  }

  const targetShipID = getEntityMapKey(targetEntity.itemID);
  if (
    targetShipID === null ||
    (typeof targetShipID === "bigint" ? targetShipID <= 0n : targetShipID <= 0)
  ) {
    return false;
  }
  const sourceGeneration = session._space;

  // Commit any older queued acquisition before deciding whether this target
  // needs a new accepted delivery.
  if (!flushSameSceneDestinyDelivery(scene, session, sourceGeneration)) {
    return false;
  }
  const visibleDynamicEntityIDs = normalizeEntityIDSet(
    session._space.visibleDynamicEntityIDs,
  );
  if (visibleDynamicEntityIDs.has(targetShipID)) {
    return true;
  }

  const stampOverride = resolveSameSceneEgoAddBallsStamp(scene, session);
  let deliveryCommitted = false;
  const delivery = scene.sendAddBallsToSession(session, [targetEntity], {
    freshAcquire: true,
    visibilityAcquisition: true,
    sessionStampedAddBalls: true,
    stampOverride: stampOverride === null ? undefined : stampOverride,
    bypassTickPresentationBatch: true,
    onDeliveryCommit: () => {
      deliveryCommitted = true;
    },
  });
  if (!delivery || delivery.delivered !== true) {
    return false;
  }
  return Boolean(
    flushSameSceneDestinyDelivery(scene, session, sourceGeneration) &&
    deliveryCommitted
  );
}

function refreshSameSceneSessionView(
  scene,
  session,
  egoEntity,
  additionalEntities = [],
  options = {},
) {
  if (!scene || !session || !session._space || !egoEntity) {
    return false;
  }
  const sourceGeneration = session._space;

  const preserveExistingBallpark = options.preserveExistingBallpark === true;
  const needsFullBootstrap =
    session._space.initialStateSent !== true ||
    session._space.initialBallparkVisualsSent !== true ||
    session._space.initialBallparkClockSynced !== true;
  if (needsFullBootstrap) {
    if (preserveExistingBallpark) {
      repairSameSceneSessionViewState(session);
    } else if (scene.ensureInitialBallpark(session, { force: true })) {
      return true;
    }
  }

  const includeEgoEntity = options.includeEgoEntity !== false;
  const shouldSendStateRefresh = options.sendStateRefresh === true;
  const refreshEntities = [
    ...(includeEgoEntity ? [egoEntity] : []),
    ...additionalEntities,
  ].filter(Boolean);
  if (refreshEntities.length > 0) {
    const delivery = scene.sendAddBallsToSession(session, refreshEntities, {
      visibilityAcquisition: true,
      sessionStampedAddBalls: options.sessionStampedAddBalls === true,
      stampOverride:
        options.stampOverride === undefined || options.stampOverride === null
          ? undefined
          : options.stampOverride,
    });
    if (delivery && delivery.delivered === true) {
      if (!flushSameSceneDestinyDelivery(scene, session, sourceGeneration)) {
        return false;
      }
    }
  }
  if (!isSameSceneDestinyDeliveryBoundaryUsable(
    scene,
    session,
    sourceGeneration,
  )) {
    return false;
  }
  scene.requestFinalSceneVisibilityReconciliation();
  if (!isSameSceneDestinyDeliveryBoundaryUsable(
    scene,
    session,
    sourceGeneration,
  )) {
    return false;
  }
  if (shouldSendStateRefresh) {
    scene.sendStateRefresh(session, egoEntity);
  }
  return true;
}

function flushSameSceneShipSwapNotificationPlan(session, plan, options = {}) {
  const sessionChangeOptions = {
    // Normal same-scene ship swaps keep the live session id and use TQ's empty
    // nodes-of-interest routing for the shipid handoff. Combat destruction can
    // opt into the older remote-style session id separately.
    nodesOfInterest: [],
  };
  if (Object.prototype.hasOwnProperty.call(options, "sessionId")) {
    sessionChangeOptions.sessionId = options.sessionId;
  }
  return flushCharacterSessionNotificationPlan(session, plan, {
    sessionChangeOptions,
  });
}

function retargetCharacterSessionNotificationPlanShip(plan, oldShipID, shipID) {
  if (!plan || !plan.sessionChanges) {
    return false;
  }

  const normalizeShipID = (value) => {
    if (value === undefined || value === null) {
      return null;
    }
    const numericValue = Number(value) || 0;
    return numericValue > 0 ? numericValue : null;
  };

  const normalizedShipID = normalizeShipID(shipID);
  const previousShipID =
    normalizeShipID(oldShipID) ?? normalizeShipID(plan.oldShipID);
  if (normalizedShipID === null || previousShipID === null) {
    return false;
  }

  plan.newShipID = normalizedShipID;
  plan.sessionChanges.shipid = [previousShipID, normalizedShipID];
  if (plan.fittingBootstrap && Number(normalizedShipID) > 0) {
    plan.fittingBootstrap.shipID = Number(normalizedShipID);
  }
  return true;
}

function resolveReusableCapsuleForCharacter(
  characterID,
  excludedShipID,
  currentSolarSystemID,
  preferredStationID,
) {
  const excludedItemID = Number(excludedShipID || 0) || 0;
  const ships = getCharacterShips(characterID).filter(
    (shipItem) =>
      Number(shipItem && shipItem.typeID) === CAPSULE_TYPE_ID &&
      Number(shipItem && shipItem.itemID) !== excludedItemID,
  );

  const currentSystemCapsule = ships.find(
    (shipItem) =>
      Number(shipItem.locationID) === Number(currentSolarSystemID || 0) &&
      Number(shipItem.flagID) === 0,
  );
  if (currentSystemCapsule) {
    return {
      success: true,
      created: false,
      data: currentSystemCapsule,
    };
  }

  const storedCapsule = ships.find(
    (shipItem) => Number(shipItem.flagID) === ITEM_FLAGS.HANGAR,
  );
  if (storedCapsule) {
    return {
      success: true,
      created: false,
      data: storedCapsule,
    };
  }

  const existingCapsule = findCharacterShipByType(characterID, CAPSULE_TYPE_ID);
  if (existingCapsule && Number(existingCapsule.itemID) !== excludedItemID) {
    return {
      success: true,
      created: false,
      data: existingCapsule,
    };
  }

  return ensureCapsuleForCharacter(characterID, preferredStationID);
}

function completeStargateJump(
  session,
  sourceGate,
  destinationGate,
  activeShip,
) {
  if (
    !session ||
    !session.characterID ||
    !sourceGate ||
    !destinationGate ||
    !activeShip
  ) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "INVALID_STARGATE_JUMP_STATE",
    };
  }

  if (
    !session._transitionState ||
    session._transitionState.kind !== "stargate-jump"
  ) {
    return {
      success: false,
      errorMsg: "STARGATE_JUMP_CANCELLED",
    };
  }

  const spawnState = buildGateSpawnState(destinationGate, activeShip);
  const sourceSimTimeMs =
    session && session._space
      ? spaceRuntime.getSimulationTimeMsForSession(session, null)
      : null;
  const sourceTimeDilation =
    session && session._space
      ? spaceRuntime.getSolarSystemTimeDilation(session._space.systemID)
      : null;
  const sourceClockCapturedAtWallclockMs = Date.now();
  if (typeof spaceRuntime.beginSessionJumpTimingTrace === "function") {
    spaceRuntime.beginSessionJumpTimingTrace(session, "stargate-jump", {
      sourceSystemID: sourceGate.solarSystemID,
      destinationSystemID: destinationGate.solarSystemID,
      sourceGateID: sourceGate.itemID,
      destinationGateID: destinationGate.itemID,
      sourceSimTimeMs,
      sourceTimeDilation,
      sourceClockCapturedAtWallclockMs,
      shipID: activeShip.itemID,
    });
  }

  deactivateActiveModulesForSpaceTransition(session, "stargate-jump");
  sendMachoObjectDisconnects(session);
  spaceRuntime.detachSession(session, {
    broadcast: true,
    lifecycleReason: "stargate-jump",
  });

  const moveResult = moveShipToSpace(activeShip.itemID, destinationGate.solarSystemID, {
    position: spawnState.position,
    direction: spawnState.direction,
    velocity: { x: 0, y: 0, z: 0 },
    speedFraction: 0,
    mode: "STOP",
    targetPoint: spawnState.position,
  });
  if (!moveResult.success) {
    endTransition(session, "stargate-jump");
    return moveResult;
  }

  syncInventoryItemForSession(
    session,
    moveResult.data,
    {
      locationID: moveResult.previousData.locationID,
      flagID: moveResult.previousData.flagID,
      quantity: moveResult.previousData.quantity,
      singleton: moveResult.previousData.singleton,
      stacksize: moveResult.previousData.stacksize,
    },
    {
      emitCfgLocation: false,
    },
  );

  const updateResult = updateCharacterRecord(session.characterID, (record) =>
    buildLocationIdentityPatch(record, destinationGate.solarSystemID, {
      stationID: null,
      structureID: null,
    }),
  );
  if (!updateResult.success) {
    endTransition(session, "stargate-jump");
    return updateResult;
  }

  const previousLocalChannelID = Number(
    session.solarsystemid2 ||
    session.solarsystemid ||
    getDockedLocationID(session) ||
    0,
  ) || 0;

  const applyResult = applyCharacterToSession(session, session.characterID, {
    emitNotifications: false,
    logSelection: true,
    selectionEvent: false,
  });
  if (!applyResult.success) {
    endTransition(session, "stargate-jump");
    return applyResult;
  }

  spaceRuntime.attachSession(session, moveResult.data, {
    systemID: destinationGate.solarSystemID,
    beyonceBound: false,
    pendingUndockMovement: false,
    stargateJumpCloak: true,
    broadcast: true,
    emitSimClockRebase: false,
    previousSimTimeMs: sourceSimTimeMs,
    initialBallparkPreviousSimTimeMs: sourceSimTimeMs,
    initialBallparkPreviousTimeDilation: sourceTimeDilation,
    initialBallparkPreviousCapturedAtWallclockMs: sourceClockCapturedAtWallclockMs,
    deferInitialBallparkStateUntilBind: true,
    deferUniverseSiteReconcile: true,
    universeSiteReconcileReason: "stargate-jump",
  });
  const observerArrivalFxResult = spaceRuntime.emitStargateArrivalObserverFx(
    session,
    destinationGate.itemID,
    moveResult.data && moveResult.data.itemID,
  );
  if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
    spaceRuntime.recordSessionJumpTimingTrace(session, "stargate-jump-attached", {
      destinationSystemID: destinationGate.solarSystemID,
      shipID: moveResult.data && moveResult.data.itemID,
      spawnState,
      observerArrivalFx: observerArrivalFxResult.success
        ? observerArrivalFxResult.data
        : {
            success: false,
            errorMsg: observerArrivalFxResult.errorMsg,
          },
    });
  }
  queuePostSpaceAttachFittingHydration(session, moveResult.data && moveResult.data.itemID, {
    inventoryBootstrapPending: false,
    hydrationProfile: "stargate",
  });
  flushCharacterSessionNotificationPlan(session, applyResult.notificationPlan);
  queuePendingSessionEffects(session, {
    awaitBeyonceBoundBallpark: true,
    previousLocalChannelID,
  });
  flushPendingCommandSessionEffects(session);
  try {
    mapTelemetryState.recordSolarSystemJump(session, {
      fromSolarSystemID: sourceGate.solarSystemID,
      toSolarSystemID: destinationGate.solarSystemID,
      kind: "stargate",
      shipID: activeShip.itemID,
      sourceID: sourceGate.itemID,
      destinationID: destinationGate.itemID,
    });
  } catch (error) {
    log.warn(
      `[SpaceTransition] Failed to record map jump characterID=${session.characterID || 0} from=${sourceGate.solarSystemID} to=${destinationGate.solarSystemID}: ${error.message}`,
    );
  }

  log.info(
    `[SpaceTransition] Stargate jump ${session.characterName || session.characterID} ship=${activeShip.itemID} from=${sourceGate.itemID} to=${destinationGate.itemID}`,
  );

  // Advance the "Complete N Jumps" AIR daily goal on each successful inter-system
  // jump. Defensive so daily-goal bookkeeping can never disrupt the jump.
  try {
    require(path.join(
      __dirname,
      "../services/dailyGoals/dailyGoalsState",
    )).recordActivity(session.characterID, "space_jump", 1);
  } catch (dailyGoalError) {
    log.debug(
      `[SpaceTransition] daily-goal space_jump hook failed char=${session.characterID}: ${dailyGoalError.message}`,
    );
  }

  endTransition(session, "stargate-jump");
  return {
    success: true,
    data: {
      stargate: destinationGate,
      spawnState,
      boundResult: buildBoundResult(session),
    },
  };
}

function syncDockedShipTransitionForSession(session, dockResult, options = {}) {
  if (!session || !dockResult || !dockResult.success || !dockResult.data) {
    return;
  }

  const dockedShip = dockResult.data;
  const previousData = dockResult.previousData || {};

  // Docking moves the active hull into the station hangar. The client needs
  // the location/flag delta for the move itself, then a second cache refresh
  // so the hangar scene can resolve the active hull immediately.
  emitItemsChangedForSession(
    session,
    dockedShip,
    {
      locationID: previousData.locationID,
      flagID: previousData.flagID,
      quantity: previousData.quantity,
      singleton: previousData.singleton,
      stacksize: previousData.stacksize,
    },
    {
      locationContext: Object.prototype.hasOwnProperty.call(options, "locationContext")
        ? options.locationContext
        : null,
    },
  );

  if (options.refreshActiveShip !== false) {
    syncInventoryItemForSession(
      session,
      dockedShip,
      {
        locationID: dockedShip.locationID,
        flagID: dockedShip.flagID,
        quantity: dockedShip.quantity,
        singleton: dockedShip.singleton,
        stacksize: dockedShip.stacksize,
      },
      {
        emitCfgLocation: true,
      },
    );
  }

  if (options.refreshShipContents !== false) {
    syncDockedShipContentsForSession(session, dockedShip);
  }
}

function buildDockedShipLocationContext(kind, locationID) {
  const resolvedLocationID = Number(locationID || 0);
  if (!Number.isFinite(resolvedLocationID) || resolvedLocationID <= 0) {
    return null;
  }
  if (kind === "structure") {
    return ["Structure", resolvedLocationID, "StructureShipHangar"];
  }
  if (kind === "station") {
    return ["Station", resolvedLocationID, "StationHangar"];
  }
  return null;
}

function syncDockedShipContentsForSession(session, dockedShip) {
  const characterID = Number(session && session.characterID) || 0;
  const shipID = Number(dockedShip && dockedShip.itemID) || 0;
  if (characterID <= 0 || shipID <= 0) {
    return;
  }

  const shipContents = listContainerItems(characterID, shipID, null);
  for (const item of shipContents) {
    const flagID = Number(item && item.flagID) || 0;
    if (!DOCKED_SHIP_CONTENT_REFRESH_FLAGS.has(flagID)) {
      continue;
    }
    syncInventoryItemForSession(
      session,
      item,
      {
        locationID: item.locationID,
        flagID: item.flagID,
        quantity: item.quantity,
        singleton: item.singleton,
        stacksize: item.stacksize,
      },
      {
        emitCfgLocation: false,
      },
    );
  }
}

function getStrategicCruiserTransitionUseError(charID, shipItem) {
  if (!shipItem) {
    return null;
  }
  // Lazy-load fitting state to avoid widening the already dense transition
  // initialization cycle.
  const {
    getStrategicCruiserUseStatus,
    isStrategicCruiserType,
  } = require(path.join(__dirname, "../services/fitting/liveFittingState"));
  if (!isStrategicCruiserType(shipItem.typeID)) {
    return null;
  }
  const fittedItems = listContainerItems(null, shipItem.itemID, null);
  const status = getStrategicCruiserUseStatus(charID, shipItem, fittedItems);
  return status.complete
    ? null
    : {
        success: false,
        errorMsg: "STRATEGIC_CRUISER_FIT_INCOMPLETE",
        data: {
          missingSubsystemFlags:
            status.subsystemStatus && status.subsystemStatus.missingFlags || [],
          invalidRegularSlotCount: status.invalidRegularSlotItems.length,
          turretOverload: status.turretOverload,
          launcherOverload: status.launcherOverload,
          cpuOverload: status.cpuOverload,
          powerOverload: status.powerOverload,
          droneBayOverload: status.droneBayOverload,
          fighterBayOverload: status.fighterBayOverload,
        },
      };
}

function undockSession(session, options = {}) {
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }

  const dockedLocationID = getDockedLocationID(session);
  if (!dockedLocationID) {
    return {
      success: false,
      errorMsg: "DOCK_REQUIRED",
    };
  }

  const dockable = resolveDockableLocation(dockedLocationID);
  if (!dockable) {
    return {
      success: false,
      errorMsg: "STATION_NOT_FOUND",
    };
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }
  const strategicCruiserUseError = getStrategicCruiserTransitionUseError(
    session.characterID,
    activeShip,
  );
  if (strategicCruiserUseError) {
    return strategicCruiserUseError;
  }

  if (!beginTransition(session, "undock", dockedLocationID)) {
    return {
      success: false,
      errorMsg: "UNDOCK_IN_PROGRESS",
    };
  }

  try {
    const previousLocalChannelID = Number(
      getDockedLocationID(session) ||
      session.solarsystemid2 ||
      session.solarsystemid ||
      0,
    ) || 0;
    if (
      dockable.kind === "structure" &&
      structureState.hasStructureOneWayUndockRestriction(
        dockable.record,
        session.shipTypeID,
      ) &&
      !structureState.hasStructureGmBypass(session)
    ) {
      return {
        success: false,
        errorMsg: "UNDOCK_RESTRICTED_BY_STRUCTURE",
      };
    }
    const ignoreContraband = Boolean(options.ignoreContraband);
    const contrabandInspection = inspectContrabandForTransition(
      session,
      activeShip.itemID,
      dockable.solarSystemID,
      "undock",
    );
    const undockState = spaceRuntime.getStationUndockSpawnState(dockable.record, {
      shipTypeID: session.shipTypeID || (activeShip && activeShip.typeID),
      selectionStrategy: dockable.kind === "structure" ? "random" : "first",
      selectionKey: activeShip && activeShip.itemID,
    });

    const moveResult = moveShipToSpace(activeShip.itemID, dockable.solarSystemID, {
      position: undockState.position,
      direction: undockState.direction,
      velocity: { x: 0, y: 0, z: 0 },
      speedFraction: 0,
      mode: "STOP",
      targetPoint: undockState.position,
      customInfo: `Undocking:${dockedLocationID}`,
    });
    if (!moveResult.success) {
      return moveResult;
    }

    const restoreResult = topOffShipShieldAndCapacitorForDockingTransition(
      moveResult.data.itemID,
    );
    if (restoreResult && restoreResult.success) {
      moveResult.data = restoreResult.data;
    }

    const itemChangeData = dockable.kind === "structure"
      ? {
          ...moveResult.data,
          clientCustomInfo: "UndockingStructure:",
        }
      : moveResult.data;
    emitItemsChangedForSession(
      session,
      itemChangeData,
      {
        locationID: moveResult.previousData.locationID,
        flagID: moveResult.previousData.flagID,
        quantity: moveResult.previousData.quantity,
        singleton: moveResult.previousData.singleton,
        stacksize: moveResult.previousData.stacksize,
      },
    );
    sendMachoObjectDisconnects(session);

    if (dockable.kind === "station") {
      broadcastOnCharNoLongerInStation(session, dockedLocationID);
    } else if (dockable.kind === "structure") {
      broadcastOnCharacterLeftStructure(session, dockedLocationID);
    }

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, dockable.solarSystemID, {
        homeStationID:
          Number(record.homeStationID || record.cloneStationID || session.homeStationID || 60003760) ||
          60003760,
        cloneStationID:
          Number(record.cloneStationID || record.homeStationID || session.cloneStationID || 60003760) ||
          60003760,
        stationID: null,
        structureID: null,
      }),
    );
    if (!updateResult.success) {
      return updateResult;
    }

    clearDeferredDockedShipSessionChange(session);
    clearDockedFittingBootstrap(session);

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
      deferDockedShipSessionChange: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    spaceRuntime.attachSession(session, moveResult.data, {
      systemID: dockable.solarSystemID,
      undockDirection: undockState.direction,
      speedFraction: 1,
      pendingUndockMovement: false,
      undockBootstrapMovementPrime: true,
      skipLegacyStationNormalization: true,
      broadcast: true,
      emitSimClockRebase: false,
      ...buildPostAttachVisibilityReconciliationOptions("undock"),
      deferUniverseSiteReconcile: true,
      universeSiteReconcileReason: "undock",
    });
    const scene = spaceRuntime.getSceneForSession(session);
    if (dockable.kind === "structure" && scene) {
      if (session._space) {
        session._space.pendingUndockStructureSlimItemChangeID = dockedLocationID;
      }
      scene.syncStructureEntitiesFromState({
        broadcast: true,
        excludedSession: session,
      });
    }
    queuePostSpaceAttachFittingHydration(session, moveResult.data.itemID, {
      inventoryBootstrapPending: false,
      hydrationProfile: "undock",
    });
    flushCharacterSessionNotificationPlan(
      session,
      applyTqDockingTransitionSessionChangeShape(applyResult.notificationPlan),
    );
    queuePendingSessionEffects(session, {
      previousLocalChannelID,
    });
    flushPendingCommandSessionEffects(session);
    sendUndockInvulnerabilityUpdated(session, moveResult.data.itemID);
    scheduleUndockInvulnerabilityCancellation(session, moveResult.data.itemID, {
      delayMs: options.undockInvulnerabilityDelayMs,
    });

    log.info(
      `[SpaceTransition] Undocked ${session.characterName || session.characterID} ship=${moveResult.data.itemID} location=${dockedLocationID} kind=${dockable.kind} system=${dockable.solarSystemID}`,
    );

    return {
      success: true,
      data: {
        station: dockable.record,
        ship: moveResult.data,
        contrabandInspection,
        ignoreContraband,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "undock");
  }
}

function dockSession(session, stationID) {
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }

  if (isDockedSession(session)) {
    return {
      success: false,
      errorMsg: "ALREADY_DOCKED",
    };
  }

  const targetStationID = Number(stationID || 0);
  const dockable = resolveDockableLocation(targetStationID);
  if (!dockable) {
    return {
      success: false,
      errorMsg: "STATION_NOT_FOUND",
    };
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  if (crimewatchState.isCriminallyFlagged(session.characterID, getCrimewatchReferenceMs(session))) {
    return {
      success: false,
      errorMsg: "CRIMINAL_TIMER_ACTIVE",
    };
  }

  if (dockable.kind === "structure") {
    const dockCheck = structureState.canCharacterDockAtStructure(session, dockable.record, {
      shipTypeID: session.shipTypeID,
    });
    if (!dockCheck.success) {
      return dockCheck;
    }
  }

  if (!beginTransition(session, "dock", targetStationID)) {
    return {
      success: false,
      errorMsg: "DOCK_IN_PROGRESS",
    };
  }

  try {
    deactivateActiveModulesForSpaceTransition(session, "dock");
    clearPendingUndockInvulnerability(session);
    sendInvulnerabilityCancelled(session, activeShip.itemID);
    sendMachoObjectDisconnects(session);
    spaceRuntime.detachSession(session, {
      broadcast: true,
      lifecycleReason: "dock",
      notifySelfOnTargetClear: true,
    });

    const dockResult = dockShipToLocation(activeShip.itemID, dockable.locationID);
    if (!dockResult.success) {
      return dockResult;
    }
    const topOffResult = topOffShipShieldAndCapacitorForDockingTransition(
      dockResult.data.itemID,
    );
    if (topOffResult && topOffResult.success) {
      dockResult.data = topOffResult.data;
    }

    syncDockedShipTransitionForSession(session, dockResult, {
      locationContext: buildDockedShipLocationContext(dockable.kind, dockable.locationID),
      refreshActiveShip: false,
      refreshShipContents: false,
    });

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, dockable.solarSystemID, {
        homeStationID:
          Number(record.homeStationID || record.cloneStationID || session.homeStationID || 60003760) ||
          60003760,
        cloneStationID:
          Number(record.cloneStationID || record.homeStationID || session.cloneStationID || 60003760) ||
          60003760,
        stationID: dockable.kind === "station" ? dockable.locationID : null,
        structureID: dockable.kind === "structure" ? dockable.locationID : null,
      }),
    );
    if (!updateResult.success) {
      return updateResult;
    }

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
      deferDockedShipSessionChange: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    flushCharacterSessionNotificationPlan(
      session,
      applyTqDockingTransitionSessionChangeShape(applyResult.notificationPlan),
    );
    sendDockingFinished(session, dockable.locationID);
    if (dockable.kind === "station") {
      broadcastOnCharNowInStation(session, dockable.locationID);
    } else if (dockable.kind === "structure") {
      broadcastOnCharacterEnteredStructure(session, dockable.locationID);
    }

    log.info(
      `[SpaceTransition] Docked ${session.characterName || session.characterID} ship=${activeShip.itemID} location=${dockable.locationID} kind=${dockable.kind}`,
    );

    try {
      const familyEstatePrologueRuntime = require(path.join(
        __dirname,
        "../services/estate/familyEstatePrologueRuntime",
      ));
      familyEstatePrologueRuntime.handleSessionDocked(session, dockable, {
        nowMs: Date.now(),
      });
    } catch (error) {
      log.warn(
        `[SpaceTransition] Family estate prologue docking hook failed: ${error.message}`,
      );
    }

    return {
      success: true,
      data: {
        station: dockable.record,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "dock");
  }
}

function consumeEmergencyWarpReturnStateForLogin(activeShip, characterID) {
  if (!activeShip || !activeShip.spaceState) {
    return activeShip;
  }

  const returnState = getEmergencyWarpReturnState(activeShip.spaceState);
  if (!returnState) {
    return activeShip;
  }

  const suppressReturnWarp = shipSuppressesEmergencyWarp(characterID);
  const nextSpaceState = suppressReturnWarp
    ? clearEmergencyWarpReturnState(activeShip.spaceState)
    : buildEmergencyWarpReturnSpaceState(activeShip.spaceState);
  if (!nextSpaceState) {
    return activeShip;
  }

  const moveResult = moveShipToSpace(
    activeShip.itemID,
    nextSpaceState.systemID || activeShip.spaceState.systemID,
    nextSpaceState,
  );
  if (!moveResult.success) {
    log.warn(
      `[SpaceTransition] Failed to consume emergency warp return state for ` +
        `char=${characterID} ship=${activeShip.itemID}: ${moveResult.errorMsg}`,
    );
    return activeShip;
  }

  return moveResult.data || activeShip;
}

function getSessionSpaceSystemID(session) {
  if (!session) {
    return 0;
  }
  for (const candidate of [
    session.solarsystemid2,
    session.solarsystemid,
    session.locationid,
    session.locationID,
  ]) {
    const systemID = toInt(candidate, 0);
    if (systemID > 0) {
      return systemID;
    }
  }
  return 0;
}

function buildLoginSpaceRepairState(activeShip, systemID) {
  const rawState =
    activeShip && activeShip.spaceState && typeof activeShip.spaceState === "object"
      ? activeShip.spaceState
      : {};
  const position = cloneVector(rawState.position);
  return {
    ...rawState,
    systemID,
    position,
    direction: normalizeVector(
      cloneVector(rawState.direction, { x: 1, y: 0, z: 0 }),
      { x: 1, y: 0, z: 0 },
    ),
    velocity: { x: 0, y: 0, z: 0 },
    speedFraction: 0,
    mode: "STOP",
    targetPoint: rawState.targetPoint
      ? cloneVector(rawState.targetPoint)
      : position,
    targetEntityID: null,
    followRange: 0,
    orbitDistance: 0,
    orbitNormal: null,
    orbitSign: 1,
    warpState: null,
    pendingWarp: null,
  };
}

function repairActiveShipSpaceStateForLogin(session, activeShip) {
  const systemID = getSessionSpaceSystemID(session);
  if (!activeShip || !activeShip.itemID || systemID <= 0) {
    return activeShip;
  }

  const stateSystemID = toInt(
    activeShip.spaceState && activeShip.spaceState.systemID,
    0,
  );
  const locationID = toInt(activeShip.locationID, 0);
  const flagID = toInt(activeShip.flagID, ITEM_FLAGS.HANGAR);
  if (
    activeShip.spaceState &&
    stateSystemID === systemID &&
    locationID === systemID &&
    flagID === 0
  ) {
    return activeShip;
  }

  const moveResult = moveShipToSpace(
    activeShip.itemID,
    systemID,
    buildLoginSpaceRepairState(activeShip, systemID),
  );
  if (!moveResult.success) {
    log.warn(
      `[SpaceTransition] Failed to repair active ship for space login ` +
        `char=${session.characterID} ship=${activeShip.itemID} system=${systemID}: ${moveResult.errorMsg}`,
    );
    return activeShip;
  }

  log.info(
    `[SpaceTransition] Repaired active ship for space login ` +
      `char=${session.characterID} ship=${activeShip.itemID} system=${systemID} ` +
      `location=${locationID} flag=${flagID} stateSystem=${stateSystemID}`,
  );
  return moveResult.data || activeShip;
}

function restoreSpaceSession(session) {
  if (!session || !session.characterID || isDockedSession(session)) {
    return false;
  }

  if (typeof spaceRuntime.beginSessionJumpTimingTrace === "function") {
    spaceRuntime.beginSessionJumpTimingTrace(session, "space-login", {
      characterID: session.characterID,
      systemID: Number(session.solarsystemid2 || session.solarsystemid || 0) || 0,
      shipID: Number(session.shipid || session.shipID || session.activeShipID || 0) || 0,
    });
  }
  if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
    spaceRuntime.recordSessionJumpTimingTrace(session, "space-login-restore-enter", {
      characterID: session.characterID,
      systemID: Number(session.solarsystemid2 || session.solarsystemid || 0) || 0,
    });
  }

  let activeShip = getActiveShipRecord(session.characterID);
  activeShip = repairActiveShipSpaceStateForLogin(session, activeShip);
  if (!activeShip || !activeShip.spaceState) {
    return false;
  }
  activeShip = consumeEmergencyWarpReturnStateForLogin(
    activeShip,
    session.characterID,
  );

  const attachStartedAtMs = Date.now();
  const shipEntity = spaceRuntime.attachSession(session, activeShip, {
    systemID:
      activeShip.spaceState.systemID ||
      session.solarsystemid ||
      session.solarsystemid2,
    pendingUndockMovement: false,
    broadcast: true,
    emitSimClockRebase: false,
    deferUniverseSiteReconcile: true,
    universeSiteReconcileReason: "space-login",
  });
  const attachElapsedMs = Date.now() - attachStartedAtMs;
  if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
    spaceRuntime.recordSessionJumpTimingTrace(session, "space-login-restore-attached", {
      shipID: Number(activeShip.itemID) || 0,
      systemID:
        Number(activeShip.spaceState && activeShip.spaceState.systemID) ||
        Number(session.solarsystemid2 || session.solarsystemid) ||
        0,
      attachMs: attachElapsedMs,
      attached: Boolean(shipEntity),
    });
  }
  if (attachElapsedMs >= 250) {
    log.info(
      `[SpaceTransition] restoreSpaceSession attach ship=${Number(activeShip.itemID) || 0} ` +
      `system=${Number(activeShip.spaceState && activeShip.spaceState.systemID) || Number(session.solarsystemid2 || session.solarsystemid) || 0} ` +
      `took ${attachElapsedMs}ms`,
    );
  }
  if (!shipEntity) {
    return false;
  }

  const hydrationQueuedAtMs = Date.now();
  queuePostSpaceAttachFittingHydration(session, activeShip.itemID, {
    // Direct login-in-space issues one early ship-inventory List(flag=None)
    // before the HUD stabilizes. Let invbroker suppress only that first call;
    // later explicit None requests still need the full ship contents.
    inventoryBootstrapPending: session._loginInventoryBootstrapPending === true,
    hydrationProfile: "login",
  });
  if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
    spaceRuntime.recordSessionJumpTimingTrace(session, "space-login-restore-hydration-queued", {
      shipID: Number(activeShip.itemID) || 0,
      queueLatencyMs: Date.now() - hydrationQueuedAtMs,
      inventoryBootstrapPending: session._loginInventoryBootstrapPending === true,
    });
  }
  // CCP client parity: Michelle creates its local Ballpark only after the
  // inflight/structure view path calls beyonce.GetFormations. Sending the
  // initial destiny bootstrap from restore-time can arrive before
  // SessionChange/GameUI/AddBallpark, which leaves the client with no bp to
  // consume and can black-screen login. Keep restore to attach-only; Beyonce
  // remains the first safe bootstrap trigger for direct space login.
  log.debug(
    `[space-login-restore] attached shipID=${Number(activeShip.itemID) || 0} ` +
    `systemID=${Number(
      activeShip.spaceState &&
      activeShip.spaceState.systemID,
    ) || Number(session.solarsystemid || session.solarsystemid2) || 0} ` +
    `${describeSessionHydrationState(session, activeShip.itemID)}`,
  );
  flushPendingCommandSessionEffects(session);
  if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
    spaceRuntime.recordSessionJumpTimingTrace(session, "space-login-restore-return", {
      shipID: Number(activeShip.itemID) || 0,
      systemID:
        Number(activeShip.spaceState && activeShip.spaceState.systemID) ||
        Number(session.solarsystemid2 || session.solarsystemid) ||
        0,
      success: true,
    });
  }

  return true;
}

function ejectSession(session, options = {}) {
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      errorMsg: "NOT_IN_SPACE",
    };
  }
  if (
    options[SHIP_DESTRUCTION_EJECT_WARP_LANDING_BYPASS] !== true &&
    isPilotWarpLandingPending(session)
  ) {
    return buildWarpLandingPendingResult();
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }
  if (Number(activeShip.typeID) === CAPSULE_TYPE_ID) {
    return {
      success: false,
      errorMsg: "ALREADY_IN_CAPSULE",
    };
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const currentEntity = spaceRuntime.getEntity(session, activeShip.itemID);
  if (!scene || !currentEntity) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  if (!beginTransition(session, "eject", activeShip.itemID)) {
    return {
      success: false,
      errorMsg: "EJECT_IN_PROGRESS",
    };
  }

  try {
    const sendAbandonedShipSlimToVictim =
      options.sendAbandonedShipSlimToVictim !== false;
    const refreshAbandonedShipViewForVictim =
      options.refreshAbandonedShipViewForVictim !== false;
    const syncAllSessionsVisibilityAfterSwap =
      options.syncAllSessionsVisibilityAfterSwap !== false;
    const beforeSameSceneShipSwapNotificationPlanFlush =
      typeof options.beforeSameSceneShipSwapNotificationPlanFlush === "function"
        ? options.beforeSameSceneShipSwapNotificationPlanFlush
        : null;
    const sendEjectSpecialFx = options.sendEjectSpecialFx !== false;
    const disconnectBoundObjectsBeforeSwap =
      options.disconnectBoundObjectsBeforeSwap === true;
    const hasSameSceneShipSwapSessionId = Object.prototype.hasOwnProperty.call(
      options,
      "sameSceneShipSwapSessionId",
    );
    const currentSystemID = Number(session._space.systemID || session.solarsystemid2 || session.solarsystemid || 0);
    const characterRecord = getCharacterRecord(session.characterID) || {};
    const preferredStationID =
      Number(
        characterRecord.homeStationID ||
          characterRecord.cloneStationID ||
          session.stationid ||
          session.stationID ||
          60003760,
      ) || 60003760;
    const preservedSpaceState = captureSpaceSessionState(session);
    const capsuleResult = resolveReusableCapsuleForCharacter(
      session.characterID,
      activeShip.itemID,
      currentSystemID,
      preferredStationID,
    );
    if (!capsuleResult.success || !capsuleResult.data) {
      return {
        success: false,
        errorMsg: capsuleResult.errorMsg || "CAPSULE_NOT_FOUND",
      };
    }

    if (disconnectBoundObjectsBeforeSwap) {
      sendMachoObjectDisconnects(session);
    }

    const sourceDestinyGeneration = session._space;
    if (typeof scene.prepareSameSceneSessionTetherRelease === "function") {
      const tetherReleaseResult = scene.prepareSameSceneSessionTetherRelease(
        session,
        currentEntity,
      );
      if (!tetherReleaseResult || tetherReleaseResult.success !== true) {
        return {
          success: false,
          errorMsg:
            tetherReleaseResult && tetherReleaseResult.errorMsg ||
            "DESTINY_TETHER_RELEASE_DELIVERY_FAILED",
        };
      }
    }

    let destinyAuthorityHandoff = null;
    const abandonedShipEntity = spaceRuntime.disembarkSession(session, {
      broadcast: true,
      lifecycleReason: "disembark",
      beforeSessionSpaceRelease: () => {
        if (!flushSameSceneDestinyDelivery(
          scene,
          session,
          sourceDestinyGeneration,
        )) {
          return destroySessionAfterUnsafeSameSceneBoundary(
            scene,
            session,
            "DESTINY_SAME_SCENE_FINAL_DELIVERY_FAILED",
          );
        }
        destinyAuthorityHandoff =
          createSameSceneDestinyPresentationAuthorityHandoff(scene, session);
        return Boolean(destinyAuthorityHandoff) ||
          destroySessionAfterUnsafeSameSceneBoundary(
            scene,
            session,
            "DESTINY_AUTHORITY_HANDOFF_FAILED",
          );
      },
    });
    if (!destinyAuthorityHandoff) {
      return {
        success: false,
        errorMsg: "DESTINY_AUTHORITY_HANDOFF_FAILED",
      };
    }
    if (!abandonedShipEntity) {
      return {
        success: false,
        errorMsg: "ACTIVE_SHIP_ENTITY_NOT_FOUND",
      };
    }

    const capsuleMoveResult = moveShipToSpace(
      capsuleResult.data.itemID,
      currentSystemID,
      buildStoppedSpaceStateFromEntity(currentEntity),
    );
    if (!capsuleMoveResult.success) {
      return capsuleMoveResult;
    }

    sendPodOrCorvetteAssembly(session, capsuleMoveResult.data);

    const activeShipResult = setActiveShipForCharacter(
      session.characterID,
      capsuleMoveResult.data.itemID,
    );
    if (!activeShipResult.success) {
      return activeShipResult;
    }

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, currentSystemID, {
        stationID: null,
        structureID: null,
      }),
    );
    if (!updateResult.success) {
      return updateResult;
    }

    clearDeferredDockedShipSessionChange(session);
    clearDockedFittingBootstrap(session);

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
      deferDockedShipSessionChange: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    const capsuleEntity = spaceRuntime.attachSession(session, capsuleMoveResult.data, {
      systemID: currentSystemID,
      pendingUndockMovement: false,
      spawnStopped: true,
      broadcast: false,
      emitSimClockRebase: false,
      emitEgoBallAdd: true,
      beyonceBound: preservedSpaceState.beyonceBound,
      initialStateSent: preservedSpaceState.initialStateSent,
      initialBallparkVisualsSent: preservedSpaceState.initialBallparkVisualsSent,
      initialBallparkClockSynced: preservedSpaceState.initialBallparkClockSynced,
      deferUniverseSiteReconcile: true,
      universeSiteReconcileReason: "eject",
      sameSceneDestinyPresentationAuthorityHandoff: destinyAuthorityHandoff,
    });
    if (!capsuleEntity) {
      return {
        success: false,
        errorMsg: "CAPSULE_ATTACH_FAILED",
      };
    }
    const capsuleDestinyGeneration = session._space;
    if (!isSameSceneDestinyDeliveryBoundaryUsable(
      scene,
      session,
      capsuleDestinyGeneration,
    )) {
      destroySessionAfterUnsafeSameSceneBoundary(
        scene,
        session,
        "DESTINY_EGO_VISIBILITY_DELIVERY_FAILED",
      );
      return {
        success: false,
        errorMsg: "DESTINY_EGO_VISIBILITY_DELIVERY_FAILED",
      };
    }

    queuePostSpaceAttachFittingHydration(session, capsuleMoveResult.data.itemID, {
      inventoryBootstrapPending: false,
      hydrationProfile: "capsule",
    });
    if (beforeSameSceneShipSwapNotificationPlanFlush) {
      const hookResult = beforeSameSceneShipSwapNotificationPlanFlush({
        session,
        scene,
        activeShip,
        abandonedShipEntity,
        capsuleEntity,
        capsule: capsuleMoveResult.data,
        currentSystemID,
        notificationPlan: applyResult.notificationPlan,
      });
      if (hookResult && hookResult.success === false) {
        return hookResult;
      }
      if (!isSameSceneDestinyDeliveryBoundaryUsable(
        scene,
        session,
        capsuleDestinyGeneration,
      )) {
        destroySessionAfterUnsafeSameSceneBoundary(
          scene,
          session,
          "DESTINY_EGO_VISIBILITY_DELIVERY_FAILED",
        );
        return {
          success: false,
          errorMsg: "DESTINY_EGO_VISIBILITY_DELIVERY_FAILED",
        };
      }
    }
    retargetCharacterSessionNotificationPlanShip(
      applyResult.notificationPlan,
      activeShip.itemID,
      capsuleMoveResult.data.itemID,
    );
    flushSameSceneShipSwapNotificationPlan(
      session,
      applyResult.notificationPlan,
      hasSameSceneShipSwapSessionId
        ? { sessionId: options.sameSceneShipSwapSessionId }
        : {},
    );
    if (!isSameSceneDestinyDeliveryBoundaryUsable(
      scene,
      session,
      capsuleDestinyGeneration,
    )) {
      destroySessionAfterUnsafeSameSceneBoundary(
        scene,
        session,
        "DESTINY_EGO_VISIBILITY_DELIVERY_FAILED",
      );
      return {
        success: false,
        errorMsg: "DESTINY_EGO_VISIBILITY_DELIVERY_FAILED",
      };
    }
    sendShipCosmeticsChanged(session, activeShip.itemID);
    sendShipCosmeticsChanged(session, capsuleMoveResult.data.itemID);
    sendCurrentShipSkinChange(session, capsuleMoveResult.data.itemID);
    if (!isSameSceneDestinyDeliveryBoundaryUsable(
      scene,
      session,
      capsuleDestinyGeneration,
    )) {
      destroySessionAfterUnsafeSameSceneBoundary(
        scene,
        session,
        "DESTINY_EGO_VISIBILITY_DELIVERY_FAILED",
      );
      return {
        success: false,
        errorMsg: "DESTINY_EGO_VISIBILITY_DELIVERY_FAILED",
      };
    }
    repairSameSceneSessionViewState(session);
    const egoAddBallsStamp = resolveSameSceneEgoAddBallsStamp(scene, session);
    let egoVisibilityCommitted = false;
    const egoDelivery = scene.sendAddBallsToSession(session, [capsuleEntity], {
      visibilityAcquisition: true,
      sessionStampedAddBalls: true,
      stampOverride: egoAddBallsStamp === null ? undefined : egoAddBallsStamp,
      onDeliveryCommit: () => {
        egoVisibilityCommitted = true;
      },
    });
    let egoDeliveryBoundaryUsable = false;
    if (egoDelivery && egoDelivery.delivered === true) {
      egoDeliveryBoundaryUsable = flushSameSceneDestinyDelivery(
        scene,
        session,
        capsuleDestinyGeneration,
      );
    }
    if (!egoVisibilityCommitted || !egoDeliveryBoundaryUsable) {
      const deliveryError = new Error(
        "Same-scene capsule visibility delivery was not accepted",
      );
      deliveryError.code = "DESTINY_EGO_VISIBILITY_DELIVERY_FAILED";
      if (typeof scene.destroySessionAfterUnsafeDestinyDelivery === "function") {
        scene.destroySessionAfterUnsafeDestinyDelivery(session, deliveryError);
      }
      return {
        success: false,
        errorMsg: deliveryError.code,
      };
    }

    if (sendAbandonedShipSlimToVictim) {
      // CCP parity: After the ejecting player is attached to their capsule,
      // send an explicit slim-item update for the abandoned ship so the client
      // knows charID is now 0 (unpiloted). The earlier broadcastSlimItemChanges
      // in disembarkSession cannot reach this session because it was already
      // removed from the scene's session map at that point. Without this, the
      // client's cached slim item still shows a pilot, blocking re-boarding.
      scene.sendSlimItemChangesToSession(session, [abandonedShipEntity]);
    }
    if (refreshAbandonedShipViewForVictim) {
      refreshSameSceneSessionView(
        scene,
        session,
        capsuleEntity,
        [abandonedShipEntity],
        {
          includeEgoEntity: false,
          preserveExistingBallpark: true,
          sessionStampedAddBalls: true,
          stampOverride:
            egoAddBallsStamp === null ? undefined : egoAddBallsStamp,
          // Same-scene ship swaps are not a mini bootstrap. `eject.txt` showed
          // the extra owner SetState landing in the held session-change lane
          // with AddBalls2/FX and re-seeding the stale hull view after the
          // client had already adopted the capsule.
          sendStateRefresh: false,
        },
      );
    }
    if (syncAllSessionsVisibilityAfterSwap) {
      scene.requestFinalSceneVisibilityReconciliation();
    }

    if (sendEjectSpecialFx) {
      const ejectHandoffStamp = sendEjectHandoffDestiny(
        session,
        scene,
        capsuleDestinyGeneration,
        abandonedShipEntity,
        capsuleEntity,
      );
      if (!hasDestinyStamp(ejectHandoffStamp)) {
        return {
          success: false,
          errorMsg: "DESTINY_EGO_VISIBILITY_DELIVERY_FAILED",
        };
      }
    }

    log.info(
      `[SpaceTransition] Ejected ${session.characterName || session.characterID} from ship=${activeShip.itemID} into capsule=${capsuleMoveResult.data.itemID} system=${currentSystemID}`,
    );

    return {
      success: true,
      data: {
        abandonedShip: activeShip,
        capsule: capsuleMoveResult.data,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "eject");
  }
}

function ejectSessionForShipDestruction(session, options = {}) {
  return ejectSession(session, {
    ...options,
    [SHIP_DESTRUCTION_EJECT_WARP_LANDING_BYPASS]: true,
  });
}

function boardSpaceShip(session, shipID) {
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      errorMsg: "NOT_IN_SPACE",
    };
  }
  if (isPilotWarpLandingPending(session)) {
    return buildWarpLandingPendingResult();
  }

  const targetShipID = Number(shipID || 0) || 0;
  if (!targetShipID) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const currentShip = getActiveShipRecord(session.characterID);
  if (!currentShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }
  if (Number(currentShip.itemID) === targetShipID) {
    return {
      success: true,
      data: {
        ship: currentShip,
        boundResult: buildBoundResult(session),
      },
    };
  }

  const scene = spaceRuntime.getSceneForSession(session);
  const currentEntity = spaceRuntime.getEntity(session, currentShip.itemID);
  if (!scene || !currentEntity) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  const targetShip = findCharacterShip(session.characterID, targetShipID);
  if (!targetShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_OWNED",
    };
  }
  if (Number(targetShip.locationID) !== Number(scene.systemID)) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_IN_SYSTEM",
    };
  }

  const targetEntity = scene.getEntityByID(targetShipID);
  if (!targetEntity || targetEntity.kind !== "ship") {
    return {
      success: false,
      errorMsg: "TARGET_SHIP_NOT_ON_GRID",
    };
  }
  if (!scene.canSessionSeeDynamicEntity(session, targetEntity)) {
    return {
      success: false,
      errorMsg: "TARGET_SHIP_NOT_ON_GRID",
    };
  }
  if (targetEntity.session && targetEntity.session !== session) {
    return {
      success: false,
      errorMsg: "SHIP_ALREADY_OCCUPIED",
    };
  }
  if (!canEntitiesInteractLocally(currentEntity, targetEntity)) {
    return {
      success: false,
      errorMsg: "TARGET_SHIP_NOT_ON_GRID",
    };
  }

  const boardingDistance = getSurfaceDistanceBetweenEntities(
    currentEntity,
    targetEntity,
  );
  if (boardingDistance > SPACE_BOARDING_RANGE_METERS) {
    return {
      success: false,
      errorMsg: "TOO_FAR_AWAY",
      data: {
        distanceMeters: boardingDistance,
        maxDistanceMeters: SPACE_BOARDING_RANGE_METERS,
      },
    };
  }

  const strategicCruiserUseError = getStrategicCruiserTransitionUseError(
    session.characterID,
    targetShip,
  );
  if (strategicCruiserUseError) {
    return strategicCruiserUseError;
  }

  if (!beginTransition(session, "board", targetShipID)) {
    return {
      success: false,
      errorMsg: "BOARD_IN_PROGRESS",
    };
  }

  try {
    const currentSystemID = Number(scene.systemID || session.solarsystemid2 || session.solarsystemid || 0);
    const preservedSpaceState = captureSpaceSessionState(session);
    const inheritedPlayerEgoScopeState =
      buildPlayerEgoScopeMetadata(currentEntity);
    const targetVisibilityReady = ensureSameSceneBoardTargetVisible(
      session,
      scene,
      targetEntity,
    );
    if (!targetVisibilityReady) {
      return {
        success: false,
        errorMsg: "BOARD_TARGET_VISIBILITY_DELIVERY_FAILED",
      };
    }
    const shouldConsumePreviousCapsule =
      Number(currentShip.typeID) === CAPSULE_TYPE_ID &&
      Number(targetShip.typeID) !== CAPSULE_TYPE_ID;
    const sourceDestinyGeneration = session._space;
    if (typeof scene.prepareSameSceneSessionTetherRelease === "function") {
      const tetherReleaseResult = scene.prepareSameSceneSessionTetherRelease(
        session,
        currentEntity,
      );
      if (!tetherReleaseResult || tetherReleaseResult.success !== true) {
        return {
          success: false,
          errorMsg:
            tetherReleaseResult && tetherReleaseResult.errorMsg ||
            "DESTINY_TETHER_RELEASE_DELIVERY_FAILED",
        };
      }
    }
    let destinyAuthorityHandoff = null;
    const abandonedCurrentEntity = spaceRuntime.disembarkSession(session, {
      broadcast: true,
      lifecycleReason: "disembark",
      beforeSessionSpaceRelease: () => {
        if (!flushSameSceneDestinyDelivery(
          scene,
          session,
          sourceDestinyGeneration,
        )) {
          return destroySessionAfterUnsafeSameSceneBoundary(
            scene,
            session,
            "DESTINY_SAME_SCENE_FINAL_DELIVERY_FAILED",
          );
        }
        destinyAuthorityHandoff =
          createSameSceneDestinyPresentationAuthorityHandoff(scene, session);
        return Boolean(destinyAuthorityHandoff) ||
          destroySessionAfterUnsafeSameSceneBoundary(
            scene,
            session,
            "DESTINY_AUTHORITY_HANDOFF_FAILED",
          );
      },
    });
    if (!destinyAuthorityHandoff) {
      return {
        success: false,
        errorMsg: "DESTINY_AUTHORITY_HANDOFF_FAILED",
      };
    }
    if (!abandonedCurrentEntity) {
      return {
        success: false,
        errorMsg: "ACTIVE_SHIP_ENTITY_NOT_FOUND",
      };
    }

    const activeShipResult = setActiveShipForCharacter(
      session.characterID,
      targetShipID,
    );
    if (!activeShipResult.success) {
      return activeShipResult;
    }

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, currentSystemID, {
        stationID: null,
        structureID: null,
      }),
    );
    if (!updateResult.success) {
      return updateResult;
    }

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
      deferDockedShipSessionChange: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    const boardedEntity = spaceRuntime.attachSessionToExistingEntity(
      session,
      targetShip,
      targetEntity,
      {
        systemID: currentSystemID,
        pendingUndockMovement: false,
        broadcast: false,
        emitSimClockRebase: false,
        beyonceBound: preservedSpaceState.beyonceBound,
        initialStateSent: preservedSpaceState.initialStateSent,
        initialBallparkVisualsSent: preservedSpaceState.initialBallparkVisualsSent,
        initialBallparkClockSynced: preservedSpaceState.initialBallparkClockSynced,
        inheritedPlayerEgoScopeState,
        sameSceneDestinyPresentationAuthorityHandoff: destinyAuthorityHandoff,
      },
    );
    if (!boardedEntity) {
      return {
        success: false,
        errorMsg: "BOARD_ATTACH_FAILED",
      };
    }
    // An unpiloted hull carries its raw type envelope. Apply fitted modules
    // and pilot skills before the first new-ego handoff so Michelle never sees
    // raw max-speed/agility values and then a later hydration correction.
    let boardedDerivedStateResult;
    try {
      boardedDerivedStateResult = scene.refreshShipEntityDerivedState(
        boardedEntity,
        {
          session,
          broadcast: false,
          notifyTargeting: false,
          notifyDerivedAttributes: false,
          notifyGenericModuleAttributes: false,
        },
      );
    } catch (_error) {
      boardedDerivedStateResult = null;
    }
    if (!boardedDerivedStateResult || boardedDerivedStateResult.success !== true) {
      destroySessionAfterUnsafeSameSceneBoundary(
        scene,
        session,
        "BOARD_DERIVED_STATE_REFRESH_FAILED",
      );
      return {
        success: false,
        errorMsg:
          boardedDerivedStateResult && boardedDerivedStateResult.errorMsg ||
          "BOARD_DERIVED_STATE_REFRESH_FAILED",
      };
    }
    const boardedDestinyGeneration = session._space;
    if (!isSameSceneDestinyDeliveryBoundaryUsable(
      scene,
      session,
      boardedDestinyGeneration,
    )) {
      destroySessionAfterUnsafeSameSceneBoundary(
        scene,
        session,
        "BOARD_EGO_VISIBILITY_HANDOFF_FAILED",
      );
      return {
        success: false,
        errorMsg: "BOARD_EGO_VISIBILITY_HANDOFF_FAILED",
      };
    }

    retargetCharacterSessionNotificationPlanShip(
      applyResult.notificationPlan,
      currentShip.itemID,
      targetShipID,
    );
    flushSameSceneShipSwapNotificationPlan(session, applyResult.notificationPlan);
    if (!isSameSceneDestinyDeliveryBoundaryUsable(
      scene,
      session,
      boardedDestinyGeneration,
    )) {
      destroySessionAfterUnsafeSameSceneBoundary(
        scene,
        session,
        "BOARD_EGO_VISIBILITY_HANDOFF_FAILED",
      );
      return {
        success: false,
        errorMsg: "BOARD_EGO_VISIBILITY_HANDOFF_FAILED",
      };
    }
    repairSameSceneSessionViewState(session);
    let boardingHandoffPlan;
    try {
      boardingHandoffPlan = buildSameSceneShipBoardingHandoffPlan({
        previousEntity: abandonedCurrentEntity,
        boardedEntity,
        buildSlimItemObject,
        includeFollowingRemoval: shouldConsumePreviousCapsule,
        stampOverride: resolveSameSceneEgoAddBallsStamp(scene, session),
      });
    } catch (_error) {
      destroySessionAfterUnsafeSameSceneBoundary(
        scene,
        session,
        "BOARD_EGO_VISIBILITY_HANDOFF_FAILED",
      );
      return {
        success: false,
        errorMsg: "BOARD_EGO_VISIBILITY_HANDOFF_FAILED",
      };
    }
    let boardedCapsuleItem = null;
    let boardedCapsulePreviousState = null;
    if (shouldConsumePreviousCapsule) {
      boardedCapsuleItem =
        findItemById(abandonedCurrentEntity.itemID) || abandonedCurrentEntity;
      boardedCapsulePreviousState = {
        locationID: currentSystemID,
        flagID: 0,
        quantity: boardedCapsuleItem.quantity,
        singleton: boardedCapsuleItem.singleton,
        stacksize: boardedCapsuleItem.stacksize,
      };
    }
    const boardingHandoffResult = submitSameSceneShipHandoffPlan(
      session,
      scene,
      boardedDestinyGeneration,
      boardingHandoffPlan,
      "BOARD_EGO_VISIBILITY_HANDOFF_FAILED",
      {
        stageFollowingRemoval: shouldConsumePreviousCapsule,
        beforeDeliveryFlush: shouldConsumePreviousCapsule
          ? () => {
              // Keep TQ's inventory-notification-before-Destiny wire order,
              // while delaying all authoritative deletion until the combined
              // handoff/removal transaction has physically committed.
              emitBoardedCapsuleItemsChanged(
                session,
                boardedCapsuleItem,
                boardedCapsulePreviousState,
              );
              return session._space === boardedDestinyGeneration;
            }
          : undefined,
      },
    );
    if (!boardingHandoffResult) {
      return {
        success: false,
        errorMsg: "BOARD_EGO_VISIBILITY_HANDOFF_FAILED",
      };
    }
    if (!clearSameSceneDynamicClassification(
      boardedDestinyGeneration,
      targetShipID,
    )) {
      destroySessionAfterUnsafeSameSceneBoundary(
        scene,
        session,
        "BOARD_EGO_VISIBILITY_HANDOFF_FAILED",
      );
      return {
        success: false,
        errorMsg: "BOARD_EGO_VISIBILITY_HANDOFF_FAILED",
      };
    }
    scene.recordCommittedDynamicVisibilityClear(session, targetShipID, {
      previousMember: true,
    });
    sendShipCosmeticsChanged(session, targetShipID);
    sendShipCosmeticsChanged(session, currentShip.itemID);

    let previousCapsuleConsumed = false;
    if (shouldConsumePreviousCapsule) {
      let capsuleConsumeResult;
      try {
        capsuleConsumeResult = finalizeBoardedCapsuleConsumption(
          scene,
          session,
          boardedDestinyGeneration,
          abandonedCurrentEntity,
          {
            acceptedRemovalStamp:
              boardingHandoffResult.followingRemovalStamp,
          },
        );
      } catch (_error) {
        capsuleConsumeResult = null;
      }
      if (!capsuleConsumeResult || !capsuleConsumeResult.success) {
        destroySessionAfterUnsafeSameSceneBoundary(
          scene,
          session,
          "CAPSULE_REMOVAL_DELIVERY_FAILED",
        );
        return {
          success: false,
          errorMsg: "CAPSULE_REMOVAL_DELIVERY_FAILED",
        };
      }
      previousCapsuleConsumed = true;
    }

    scene.broadcastSlimItemChanges([boardedEntity]);
    scene.broadcastBallRefresh([boardedEntity], session);
    sendShipCosmeticsChanged(session, targetShipID);
    if (shouldConsumePreviousCapsule) {
      sendShipCosmeticsChanged(session, currentShip.itemID);
    }

    scene.requestFinalSceneVisibilityReconciliation();
    if (!previousCapsuleConsumed) {
      const recoveryAddBallsStamp = resolveSameSceneEgoAddBallsStamp(
        scene,
        session,
      );
      scene.sendSlimItemChangesToSession(session, [abandonedCurrentEntity]);
      refreshSameSceneSessionView(
        scene,
        session,
        boardedEntity,
        [abandonedCurrentEntity],
        {
          includeEgoEntity: false,
          preserveExistingBallpark: true,
          sessionStampedAddBalls: true,
          stampOverride:
            recoveryAddBallsStamp === null
              ? undefined
              : recoveryAddBallsStamp,
          // Same-scene boarding should stay on the live ballpark path. A full
          // owner SetState here is a Michelle reset, not a harmless handoff.
          sendStateRefresh: false,
        },
      );
    }
    queuePostSpaceAttachFittingHydration(session, targetShipID, {
      inventoryBootstrapPending: false,
      hydrationProfile: "transition",
    });

    log.info(
      `[SpaceTransition] Boarded ${session.characterName || session.characterID} ship=${targetShipID} from=${currentShip.itemID} system=${currentSystemID}`,
    );

    return {
      success: true,
      data: {
        ship: targetShip,
        previousShip: currentShip,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "board");
  }
}

function jumpSessionViaStargate(session, fromStargateID, toStargateID) {
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      errorMsg: "NOT_IN_SPACE",
    };
  }
  if (isPilotWarpLandingPending(session)) {
    return buildWarpLandingPendingResult();
  }

  const sourceGate = worldData.getStargateByID(fromStargateID);
  const destinationGate = worldData.getStargateByID(
    toStargateID || (sourceGate && sourceGate.destinationID),
  );
  if (!sourceGate || !destinationGate) {
    return {
      success: false,
      errorMsg: "STARGATE_NOT_FOUND",
    };
  }
  if (!beginTransition(session, "stargate-jump", sourceGate.itemID)) {
    return {
      success: false,
      errorMsg: "STARGATE_JUMP_IN_PROGRESS",
    };
  }
  if (
    Number(sourceGate.destinationID || 0) !== Number(destinationGate.itemID || 0)
  ) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "STARGATE_DESTINATION_MISMATCH",
    };
  }
  if (
    Number(sourceGate.solarSystemID || 0) !== Number(session._space.systemID || 0)
  ) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "WRONG_SOLAR_SYSTEM",
    };
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  if (crimewatchState.isCriminallyFlagged(session.characterID, getCrimewatchReferenceMs(session))) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "CRIMINAL_TIMER_ACTIVE",
    };
  }

  const shipEntity = spaceRuntime.getEntity(session, activeShip.itemID);
  if (
    shipEntity &&
    isScriptedHicStargateBlockedShip(activeShip) &&
    hostileModuleRuntime.hasScriptedHicGateScramble(shipEntity)
  ) {
    endTransition(session, "stargate-jump");
    return {
      success: false,
      errorMsg: "STARGATE_JUMP_BLOCKED_BY_SCRIPTED_HIC",
    };
  }

  const sourceEntity = spaceRuntime.getEntity(session, sourceGate.itemID);
  if (shipEntity && sourceEntity) {
    const jumpDistance = getSurfaceDistanceBetweenEntities(shipEntity, sourceEntity);
    if (jumpDistance > STARGATE_JUMP_RANGE_METERS) {
      endTransition(session, "stargate-jump");
      return {
        success: false,
        errorMsg: "TOO_FAR_FROM_STARGATE",
      };
    }
  }

  const contrabandInspection = inspectContrabandForTransition(
    session,
    activeShip.itemID,
    destinationGate.solarSystemID,
    "stargate-jump",
  );

  const startResult = spaceRuntime.startStargateJump(session, sourceGate.itemID);
  if (!startResult.success) {
    endTransition(session, "stargate-jump");
    return startResult;
  }
  sendJumpQueueUpdate(session, destinationGate.solarSystemID);

  // Scale the handoff delay by the TiDi factor so the client-side gate FX
  // (which plays in dilated sim time) has enough wallclock time to finish
  // before we detach the session and reset TiDi to 1.0.
  const tidiFactor = spaceRuntime.getSolarSystemTimeDilation(sourceGate.solarSystemID);
  const scaledDelay = Math.round(STARGATE_JUMP_HANDOFF_DELAY_MS / tidiFactor);

  setTimeout(() => {
    const completionResult = completeStargateJump(
      session,
      sourceGate,
      destinationGate,
      activeShip,
    );
    if (!completionResult.success) {
      log.warn(
        `[SpaceTransition] Delayed stargate jump failed for ${session.characterName || session.characterID}: ${completionResult.errorMsg}`,
      );
    }
  }, scaledDelay);

  return {
    success: true,
    data: {
      stargate: destinationGate,
      contrabandInspection,
      jumpOutStamp: startResult.data.stamp,
      boundResult: buildBoundResult(session),
    },
  };
}

function rebuildDockedSessionAtStation(session, stationID, options = {}) {
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }

  const targetStationID = Number(stationID || 0);
  const station = worldData.getStationByID(targetStationID);
  if (!station) {
    return {
      success: false,
      errorMsg: "STATION_NOT_FOUND",
    };
  }

  const previousLocalChannelID = Number(
    session.solarsystemid2 ||
    session.solarsystemid ||
    session.stationid ||
    session.stationID ||
    0,
  ) || 0;
  const preRespawnShipID = Number(
    session.shipID ||
    session.shipid ||
    session.activeShipID ||
    0,
  ) || 0;

  const capsuleResult = ensureCapsuleForCharacter(
    session.characterID,
    station.stationID,
  );
  if (!capsuleResult.success || !capsuleResult.data) {
    return {
      success: false,
      errorMsg: capsuleResult.errorMsg || "CAPSULE_NOT_FOUND",
    };
  }

  const capsuleShip = capsuleResult.data;
  const activeShipResult = setActiveShipForCharacter(
    session.characterID,
    capsuleShip.itemID,
  );
  if (!activeShipResult.success) {
    return activeShipResult;
  }

  const currentRecord = getCharacterRecord(session.characterID);
  const authoritativeHomeStationID =
    Number(
      (currentRecord && (
        currentRecord.homeStationID ||
        currentRecord.cloneStationID
      )) ||
      session.homeStationID ||
      session.homestationid ||
      session.cloneStationID ||
      session.clonestationid ||
      0,
    ) || 0;

  const updateResult = updateCharacterRecord(session.characterID, (record) =>
    buildLocationIdentityPatch(record, station.solarSystemID, {
      homeStationID: authoritativeHomeStationID || station.stationID,
      cloneStationID:
        Number(record.cloneStationID || authoritativeHomeStationID || station.stationID) ||
        station.stationID,
      stationID: station.stationID,
    }),
  );
  if (!updateResult.success) {
    return updateResult;
  }

  const applyResult = applyCharacterToSession(session, session.characterID, {
    emitNotifications: false,
    logSelection: options.logSelection !== false,
    selectionEvent: false,
    deferDockedShipSessionChange: false,
  });
  if (!applyResult.success) {
    return applyResult;
  }

  let newbieShipResult = null;
  if (options.boardNewbieShip === true) {
    const DogmaService = require(path.join(
      __dirname,
      "../services/dogma/dogmaService",
    ));
    if (typeof DogmaService.boardNewbieShipForSession === "function") {
      newbieShipResult = DogmaService.boardNewbieShipForSession(session, {
        emitNotifications: false,
        logSelection: false,
        repairExistingShip: true,
        logLabel: options.newbieShipLogLabel || "PodRespawn",
      });
      if (!newbieShipResult.success) {
        log.warn(
          `[SpaceTransition] Failed to auto-board corvette for ${session.characterName || session.characterID} station=${station.stationID} error=${newbieShipResult.errorMsg}`,
        );
      } else if (
        newbieShipResult.data &&
        newbieShipResult.data.ship &&
        Number(newbieShipResult.data.ship.itemID) > 0
      ) {
        retargetCharacterSessionNotificationPlanShip(
          applyResult.notificationPlan,
          preRespawnShipID,
          newbieShipResult.data.ship.itemID,
        );
      }
    }
  }

  if (options.emitNotifications !== false) {
    flushCharacterSessionNotificationPlan(session, applyResult.notificationPlan);
  }

  const refreshedCapsule =
    Number(capsuleShip && capsuleShip.itemID) > 0
      ? findCharacterShip(session.characterID, capsuleShip.itemID)
      : null;

  if (refreshedCapsule) {
    const capsuleChanges = Array.isArray(capsuleResult.changes)
      ? capsuleResult.changes
      : [];
    for (const change of capsuleChanges) {
      if (!change || !change.item) {
        continue;
      }

      syncInventoryItemForSession(
        session,
        change.item,
        change.previousState || {
          locationID: 0,
          flagID: ITEM_FLAGS.HANGAR,
        },
        {
          emitCfgLocation: true,
        },
      );
    }

    // Pod respawn briefly seeds a docked capsule before the corvette board
    // step runs. If that board consumes the capsule, never replay the stale
    // capsule row back into the hangar or the client materializes a ghost ship.
    syncInventoryItemForSession(
      session,
      refreshedCapsule,
      {
        locationID: refreshedCapsule.locationID,
        flagID: refreshedCapsule.flagID,
        quantity: refreshedCapsule.quantity,
        singleton: refreshedCapsule.singleton,
        stacksize: refreshedCapsule.stacksize,
      },
      {
        emitCfgLocation: true,
      },
    );
  }

  const refreshedActiveShip =
    getActiveShipRecord(session.characterID) ||
    refreshedCapsule ||
    capsuleShip;
  if (
    refreshedCapsule &&
    Number(refreshedActiveShip.itemID) !== Number(refreshedCapsule.itemID)
  ) {
    syncInventoryItemForSession(
      session,
      refreshedActiveShip,
      {
        locationID: refreshedActiveShip.locationID,
        flagID: refreshedActiveShip.flagID,
        quantity: refreshedActiveShip.quantity,
        singleton: refreshedActiveShip.singleton,
        stacksize: refreshedActiveShip.stacksize,
      },
      {
        emitCfgLocation: true,
      },
    );
  }

  queuePendingSessionEffects(session, {
    previousLocalChannelID,
  });
  flushPendingCommandSessionEffects(session);
  broadcastOnCharNowInStation(session, station.stationID);

  const activeShip =
    getActiveShipRecord(session.characterID) ||
    (newbieShipResult && newbieShipResult.data && newbieShipResult.data.ship) ||
    refreshedCapsule;

  log.info(
    `[SpaceTransition] Rebuilt docked session for ${session.characterName || session.characterID} station=${station.stationID} ship=${activeShip && activeShip.itemID}`,
  );

  return {
    success: true,
    data: {
      station,
      capsule: refreshedCapsule,
      ship: activeShip,
      newbieShipResult,
      boundResult: buildBoundResult(session),
    },
  };
}

function jumpSessionToStation(session, stationID) {
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }
  if (isPilotWarpLandingPending(session)) {
    return buildWarpLandingPendingResult();
  }

  const targetStationID = Number(stationID || 0);
  const station = worldData.getStationByID(targetStationID);
  if (!station) {
    return {
      success: false,
      errorMsg: "STATION_NOT_FOUND",
    };
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  if (!beginTransition(session, "station-jump", targetStationID)) {
    return {
      success: false,
      errorMsg: "STATION_JUMP_IN_PROGRESS",
    };
  }

  try {
    const previousLocalChannelID = Number(
      session.solarsystemid2 ||
      session.solarsystemid ||
      session.stationid ||
      session.stationID ||
      0,
    ) || 0;

    if (session._space) {
      deactivateActiveModulesForSpaceTransition(session, "station-jump");
      spaceRuntime.detachSession(session, {
        broadcast: true,
        lifecycleReason: "station-jump",
      });
    }

    const dockResult = dockShipToStation(activeShip.itemID, station.stationID);
    if (!dockResult.success) {
      return dockResult;
    }

    const currentRecord = getCharacterRecord(session.characterID);
    const authoritativeHomeStationID =
      Number(
        (currentRecord && (
          currentRecord.homeStationID ||
          currentRecord.cloneStationID
        )) ||
        session.homeStationID ||
        session.homestationid ||
        session.cloneStationID ||
        session.clonestationid ||
        0,
      ) || 0;

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, station.solarSystemID, {
        homeStationID: authoritativeHomeStationID || station.stationID,
        cloneStationID:
          Number(record.cloneStationID || authoritativeHomeStationID || station.stationID) ||
          station.stationID,
        stationID: station.stationID,
      }),
    );
    if (!updateResult.success) {
      return updateResult;
    }

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
      deferDockedShipSessionChange: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    flushCharacterSessionNotificationPlan(session, applyResult.notificationPlan);
    syncDockedShipTransitionForSession(session, dockResult);

    queuePendingSessionEffects(session, {
      previousLocalChannelID,
    });
    flushPendingCommandSessionEffects(session);
    broadcastOnCharNowInStation(session, station.stationID);

    log.info(
      `[SpaceTransition] Station jump ${session.characterName || session.characterID} ship=${activeShip.itemID} station=${station.stationID} system=${station.solarSystemID}`,
    );

    return {
      success: true,
      data: {
        station,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "station-jump");
  }
}

function jumpSessionToSolarSystem(session, solarSystemID, options = {}) {
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }
  if (isPilotWarpLandingPending(session)) {
    return buildWarpLandingPendingResult();
  }

  const targetSolarSystemID = Number(solarSystemID || 0);
  const system = worldData.getSolarSystemByID(targetSolarSystemID);
  if (!system) {
    return {
      success: false,
      errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
    };
  }

  const activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  if (!beginTransition(session, "solar-jump", targetSolarSystemID)) {
    return {
      success: false,
      errorMsg: "SOLAR_JUMP_IN_PROGRESS",
    };
  }

  try {
    const destinationSceneAlreadyLoaded = Boolean(
      spaceRuntime &&
        spaceRuntime.scenes instanceof Map &&
        spaceRuntime.scenes.has(targetSolarSystemID),
    );
    const sourceStationID = Number(session.stationid || session.stationID || 0);
    const sourceStructureID = Number(session.structureid || session.structureID || 0);
    const wasInSpace = Boolean(session._space);
    const sourceSimTimeMs = wasInSpace
      ? spaceRuntime.getSimulationTimeMsForSession(session, null)
      : null;
    const sourceTimeDilation = wasInSpace
      ? spaceRuntime.getSolarSystemTimeDilation(session._space.systemID)
      : null;
    const sourceClockCapturedAtWallclockMs = wasInSpace ? Date.now() : null;
    if (typeof spaceRuntime.beginSessionJumpTimingTrace === "function") {
      spaceRuntime.beginSessionJumpTimingTrace(session, "solar-jump", {
        sourceSystemID:
          wasInSpace && session && session._space
            ? Number(session._space.systemID || 0) || null
            : null,
        destinationSystemID: targetSolarSystemID,
        sourceSimTimeMs,
        sourceTimeDilation,
        sourceClockCapturedAtWallclockMs,
        shipID: activeShip.itemID,
      });
    }
    const previousLocalChannelID = Number(
      session.solarsystemid2 ||
      session.solarsystemid ||
      getDockedLocationID(session) ||
      0,
    ) || 0;
    const spawnState = options.spawnStateOverride || buildSolarSystemSpawnState(targetSolarSystemID);
    if (!spawnState) {
      return {
        success: false,
        errorMsg: "SOLAR_SYSTEM_NOT_FOUND",
      };
    }

    if (wasInSpace) {
      deactivateActiveModulesForSpaceTransition(session, "solar-jump");
      spaceRuntime.detachSession(session, {
        broadcast: true,
        lifecycleReason: "solar-jump",
      });
    }

    const moveResult = moveShipToSpace(activeShip.itemID, targetSolarSystemID, {
      position: spawnState.position,
      direction: spawnState.direction,
      velocity: { x: 0, y: 0, z: 0 },
      speedFraction: 0,
      mode: "STOP",
      targetPoint: spawnState.position,
    });
    if (!moveResult.success) {
      return moveResult;
    }

    syncInventoryItemForSession(
      session,
      moveResult.data,
      {
        locationID: moveResult.previousData.locationID,
        flagID: moveResult.previousData.flagID,
        quantity: moveResult.previousData.quantity,
        singleton: moveResult.previousData.singleton,
        stacksize: moveResult.previousData.stacksize,
      },
      {
        emitCfgLocation: false,
      },
    );

    if (sourceStationID) {
      broadcastOnCharNoLongerInStation(session, sourceStationID);
    } else if (sourceStructureID) {
      broadcastOnCharacterLeftStructure(session, sourceStructureID);
    }

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, targetSolarSystemID, {
        ...(sourceStationID
          ? {
              homeStationID:
                Number(record.homeStationID || record.cloneStationID || sourceStationID) ||
                sourceStationID,
              cloneStationID:
                Number(record.cloneStationID || record.homeStationID || sourceStationID) ||
                sourceStationID,
            }
          : {}),
        stationID: null,
        structureID: null,
      }),
    );
    if (!updateResult.success) {
      return updateResult;
    }

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    spaceRuntime.attachSession(session, moveResult.data, {
      systemID: targetSolarSystemID,
      beyonceBound: false,
      pendingUndockMovement: false,
      spawnStopped: true,
      stargateJumpCloak: options.stargateJumpCloak === true,
      stargateJumpCloakDurationMs: options.stargateJumpCloakDurationMs,
      broadcast: true,
      emitSimClockRebase: false,
      previousSimTimeMs: sourceSimTimeMs,
      initialBallparkPreviousSimTimeMs: sourceSimTimeMs,
      initialBallparkPreviousTimeDilation: sourceTimeDilation,
      initialBallparkPreviousCapturedAtWallclockMs: sourceClockCapturedAtWallclockMs,
      deferInitialBallparkStateUntilBind: true,
      deferUniverseSiteReconcile: true,
      universeSiteReconcileReason: "solar-jump",
    });
    if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
      spaceRuntime.recordSessionJumpTimingTrace(session, "solar-jump-attached", {
        destinationSystemID: targetSolarSystemID,
        shipID: moveResult.data && moveResult.data.itemID,
        spawnState,
      });
    }
    queuePostSpaceAttachFittingHydration(
      session,
      moveResult.data && moveResult.data.itemID,
      {
        inventoryBootstrapPending: false,
        hydrationProfile: destinationSceneAlreadyLoaded ? "solarWarm" : "solar",
      },
    );
    flushCharacterSessionNotificationPlan(session, applyResult.notificationPlan);
    queuePendingSessionEffects(session, {
      awaitBeyonceBoundBallpark: true,
      previousLocalChannelID,
    });
    flushPendingCommandSessionEffects(session);

    log.info(
      `[SpaceTransition] Solar jump ${session.characterName || session.characterID} ship=${activeShip.itemID} system=${targetSolarSystemID} anchor=${spawnState.anchorType}:${spawnState.anchorID} warmScene=${destinationSceneAlreadyLoaded}`,
    );

    // Advance the "Complete N Jumps" AIR daily goal. This is the shared path for
    // every non-stargate system change (wormhole, jump bridge, titan bridge,
    // cyno, conduit); stargates keep their own hook in completeStargateJump and
    // do not route through here, so there is no double count. Callers that are
    // not player jumps -- GM transport commands, sov auto-navigation -- opt out
    // with countsTowardJumpGoal:false. Defensive so daily-goal bookkeeping can
    // never disrupt the jump.
    if (options.countsTowardJumpGoal !== false) {
      try {
        require(path.join(
          __dirname,
          "../services/dailyGoals/dailyGoalsState",
        )).recordActivity(session.characterID, "space_jump", 1);
      } catch (dailyGoalError) {
        log.debug(
          `[SpaceTransition] daily-goal space_jump hook failed char=${session.characterID}: ${dailyGoalError.message}`,
        );
      }
    }

    return {
      success: true,
      data: {
        solarSystem: system,
        ship: moveResult.data,
        spawnState,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "solar-jump");
  }
}

function jumpSessionToShipCloneBay(session, targetShipID) {
  if (!session || !session.characterID) {
    return {
      success: false,
      errorMsg: "CHARACTER_NOT_SELECTED",
    };
  }
  if (isPilotWarpLandingPending(session)) {
    return buildWarpLandingPendingResult();
  }

  const targetItemID = Number(targetShipID || 0) || 0;
  if (!targetItemID) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const targetShip = findItemById(targetItemID);
  if (!targetShip || Number(targetShip.categoryID || 0) !== 6) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  const targetSystemID =
    Number(targetShip.spaceState && targetShip.spaceState.systemID) ||
    Number(targetShip.locationID || 0) ||
    0;
  if (!targetSystemID || !targetShip.spaceState) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_IN_SPACE",
    };
  }

  let activeShip = getActiveShipRecord(session.characterID);
  if (!activeShip) {
    return {
      success: false,
      errorMsg: "SHIP_NOT_FOUND",
    };
  }

  if (Number(activeShip.typeID) !== CAPSULE_TYPE_ID) {
    if (!isDockedSession(session)) {
      return {
        success: false,
        errorMsg: "PILOT_NOT_IN_CAPSULE",
      };
    }
    const dockedLocationID = getDockedLocationID(session);
    const capsuleResult = resolveReusableCapsuleForCharacter(
      session.characterID,
      activeShip.itemID,
      Number(session.solarsystemid2 || session.solarsystemid || targetSystemID) ||
        targetSystemID,
      dockedLocationID ||
        session.homeStationID ||
        session.cloneStationID ||
        60003760,
    );
    if (!capsuleResult.success || !capsuleResult.data) {
      return {
        success: false,
        errorMsg: capsuleResult.errorMsg || "CAPSULE_NOT_FOUND",
      };
    }
    const activeShipResult = setActiveShipForCharacter(
      session.characterID,
      capsuleResult.data.itemID,
    );
    if (!activeShipResult.success) {
      return activeShipResult;
    }
    activeShip = capsuleResult.data;
  }

  if (!beginTransition(session, "clone-vat-jump", targetItemID)) {
    return {
      success: false,
      errorMsg: "CLONE_VAT_JUMP_IN_PROGRESS",
    };
  }

  try {
    const sourceStationID = Number(session.stationid || session.stationID || 0);
    const sourceStructureID = Number(
      session.structureid || session.structureID || 0,
    );
    const wasInSpace = Boolean(session._space);
    const sourceSimTimeMs = wasInSpace
      ? spaceRuntime.getSimulationTimeMsForSession(session, null)
      : null;
    const sourceTimeDilation = wasInSpace
      ? spaceRuntime.getSolarSystemTimeDilation(session._space.systemID)
      : null;
    const sourceClockCapturedAtWallclockMs = wasInSpace ? Date.now() : null;
    const previousLocalChannelID =
      Number(
        session.solarsystemid2 ||
          session.solarsystemid ||
          getDockedLocationID(session) ||
          0,
      ) || 0;

    const scene = spaceRuntime.ensureScene(targetSystemID);
    let targetEntity = scene ? scene.getEntityByID(targetItemID) : null;
    if (!targetEntity && targetShip.spaceState) {
      const spawnResult = spaceRuntime.spawnDynamicInventoryEntity(
        targetSystemID,
        targetItemID,
        {
          broadcastOptions: {
            freshAcquire: false,
          },
        },
      );
      if (spawnResult && spawnResult.success && spawnResult.data) {
        targetEntity = spawnResult.data.entity || null;
      }
    }
    const spawnState = buildCloneVatArrivalSpaceState(targetShip, targetEntity);

    if (typeof spaceRuntime.beginSessionJumpTimingTrace === "function") {
      spaceRuntime.beginSessionJumpTimingTrace(session, "clone-vat-jump", {
        sourceSystemID:
          wasInSpace && session._space
            ? Number(session._space.systemID || 0) || null
            : null,
        destinationSystemID: targetSystemID,
        targetShipID: targetItemID,
        sourceSimTimeMs,
        sourceTimeDilation,
        sourceClockCapturedAtWallclockMs,
        shipID: activeShip.itemID,
      });
    }

    if (wasInSpace) {
      deactivateActiveModulesForSpaceTransition(session, "clone-vat-jump");
      spaceRuntime.detachSession(session, {
        broadcast: true,
        lifecycleReason: "clone-vat-jump",
      });
    }

    const moveResult = moveShipToSpace(
      activeShip.itemID,
      targetSystemID,
      spawnState,
    );
    if (!moveResult.success) {
      return moveResult;
    }

    syncInventoryItemForSession(
      session,
      moveResult.data,
      {
        locationID: moveResult.previousData.locationID,
        flagID: moveResult.previousData.flagID,
        quantity: moveResult.previousData.quantity,
        singleton: moveResult.previousData.singleton,
        stacksize: moveResult.previousData.stacksize,
      },
      {
        emitCfgLocation: false,
      },
    );

    if (sourceStationID) {
      broadcastOnCharNoLongerInStation(session, sourceStationID);
    } else if (sourceStructureID) {
      broadcastOnCharacterLeftStructure(session, sourceStructureID);
    }

    const updateResult = updateCharacterRecord(session.characterID, (record) =>
      buildLocationIdentityPatch(record, targetSystemID, {
        ...(sourceStationID
          ? {
              homeStationID:
                Number(
                  record.homeStationID ||
                    record.cloneStationID ||
                    sourceStationID,
                ) || sourceStationID,
              cloneStationID:
                Number(
                  record.cloneStationID ||
                    record.homeStationID ||
                    sourceStationID,
                ) || sourceStationID,
            }
          : {}),
        stationID: null,
        structureID: null,
      }),
    );
    if (!updateResult.success) {
      return updateResult;
    }

    clearDeferredDockedShipSessionChange(session);
    clearDockedFittingBootstrap(session);

    const applyResult = applyCharacterToSession(session, session.characterID, {
      emitNotifications: false,
      logSelection: true,
      selectionEvent: false,
      deferDockedShipSessionChange: false,
    });
    if (!applyResult.success) {
      return applyResult;
    }

    spaceRuntime.attachSession(session, moveResult.data, {
      systemID: targetSystemID,
      beyonceBound: false,
      pendingUndockMovement: false,
      spawnStopped: true,
      broadcast: true,
      emitSimClockRebase: false,
      previousSimTimeMs: sourceSimTimeMs,
      initialBallparkPreviousSimTimeMs: sourceSimTimeMs,
      initialBallparkPreviousTimeDilation: sourceTimeDilation,
      initialBallparkPreviousCapturedAtWallclockMs:
        sourceClockCapturedAtWallclockMs,
      deferInitialBallparkStateUntilBind: true,
      deferUniverseSiteReconcile: true,
      universeSiteReconcileReason: "clone-vat-jump",
    });
    if (typeof spaceRuntime.recordSessionJumpTimingTrace === "function") {
      spaceRuntime.recordSessionJumpTimingTrace(
        session,
        "clone-vat-jump-attached",
        {
          destinationSystemID: targetSystemID,
          targetShipID: targetItemID,
          shipID: moveResult.data && moveResult.data.itemID,
          spawnState,
        },
      );
    }

    queuePostSpaceAttachFittingHydration(
      session,
      moveResult.data && moveResult.data.itemID,
      {
        inventoryBootstrapPending: false,
        hydrationProfile: "cloneVat",
      },
    );
    flushCharacterSessionNotificationPlan(session, applyResult.notificationPlan, {
      sessionChangeOptions: buildSolarSessionChangeOptions(
        session,
        targetSystemID,
      ),
    });
    queuePendingSessionEffects(session, {
      awaitBeyonceBoundBallpark: true,
      previousLocalChannelID,
    });
    flushPendingCommandSessionEffects(session);

    log.info(
      `[SpaceTransition] Clone-vat jump ${
        session.characterName || session.characterID
      } capsule=${moveResult.data.itemID} targetShip=${targetItemID} system=${targetSystemID}`,
    );

    return {
      success: true,
      data: {
        ship: moveResult.data,
        targetShip,
        targetEntity,
        spawnState,
        boundResult: buildBoundResult(session),
      },
    };
  } finally {
    endTransition(session, "clone-vat-jump");
  }
}

module.exports = {
  buildBoundResult,
  buildSolarSystemSpawnState,
  undockSession,
  dockSession,
  restoreSpaceSession,
  ejectSession,
  ejectSessionForShipDestruction,
  boardSpaceShip,
  getStrategicCruiserTransitionUseError,
  jumpSessionViaStargate,
  rebuildDockedSessionAtStation,
  jumpSessionToStation,
  jumpSessionToShipCloneBay,
  jumpSessionToSolarSystem,
  resolveSameSceneEgoAddBallsStamp,
  repairSameSceneSessionViewState,
};
module.exports._testing = {
  buildBoundResultForTesting: buildBoundResult,
  buildGateSpawnState,
  completeStargateJumpForTesting: completeStargateJump,
  clearStargateJumpQueuesForTesting() {
    stargateJumpQueuesByDestination.clear();
  },
  getResolvedStargateForwardDirection,
  recordStargateJumpQueueEntryForTesting: recordStargateJumpQueueEntry,
  getSurfaceDistanceBetweenEntities,
  resolveSameSceneEgoAddBallsStamp,
  repairSameSceneSessionViewState,
  sendJumpQueueUpdateForTesting: sendJumpQueueUpdate,
};
