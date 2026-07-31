const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const log = require(path.join(__dirname, "../../utils/logger"));
const npcService = require(path.join(__dirname, "../../space/npc"));
const nativeNpcStore = require(path.join(__dirname, "../../space/npc/nativeNpcStore"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  ONE_AU_IN_METERS,
  findSafeWarpOriginAnchor,
} = require(path.join(__dirname, "../../space/npc/npcWarpOrigins"));
const {
  getNpcProfile,
  resolveNpcSpawnGroup,
  resolveNpcProfile,
} = require(path.join(__dirname, "../../space/npc/npcData"));
const {
  buildDefinitionsForSpawnGroup,
} = require(path.join(__dirname, "../../space/npc/npcSelection"));
const {
  buildShipResourceState,
  getAttributeIDByNames,
  getEffectTypeRecord,
  getTypeAttributeValue,
  getTypeEffectRecords,
  isModuleOnline,
} = require(path.join(__dirname, "../fitting/liveFittingState"));
const {
  resolveItemByName,
  resolveItemByTypeID,
} = require(path.join(__dirname, "../inventory/itemTypeRegistry"));
const {
  createSpaceItemForOwner,
  consumeInventoryItemQuantity,
  grantItemToOwnerLocation,
  listContainerItems,
  removeInventoryItem,
} = require(path.join(__dirname, "../inventory/itemStore"));
const {
  getNpcFittedModuleItems,
  getNpcLoadedChargeForModule,
} = require(path.join(__dirname, "../../space/npc/npcEquipment"));
const {
  ensureSceneMiningState,
  getMineableState,
  isMineableStaticEntity,
} = require("./miningRuntimeState");
const {
  buildMiningModuleSnapshot,
} = require("./miningDogma");
const {
  resolveAggressorStandingProfile,
} = require("./miningNpcStandings");
const {
  ENTITY_TYPE,
} = require(path.join(__dirname, "../../space/entityConstants"));
const {
  buildChildEntityScopeMetadata,
  canEntitiesInteractLocally,
  resolveEntityInteractionScope,
} = require(path.join(
  __dirname,
  "../../space/destiny/identity/interactionScope",
));

const MAX_MINING_NPC_COMMAND_SPAWN_COUNT = 25;
const DEFAULT_MINING_FLEET_QUERY = "npc_mining_ops_highsec";
const DEFAULT_MINING_FLEET_QUERY_BY_BAND = Object.freeze({
  highsec: "npc_mining_ops_highsec",
  lowsec: "npc_mining_ops_lowsec",
  nullsec: "npc_mining_ops_nullsec",
});
const DEFAULT_MINING_RESPONSE_QUERY = "npc_laser_hostiles";
const DEFAULT_MINING_HAULER_QUERY = "npc_mining_hauler_highsec";
const DEFAULT_MINING_HAULER_QUERY_BY_BAND = Object.freeze({
  highsec: "npc_mining_hauler_highsec",
  lowsec: "npc_mining_hauler_lowsec",
  nullsec: "npc_mining_hauler_nullsec",
});
const DEFAULT_MINING_FLEET_COUNT = 1;
const DEFAULT_MINING_RESPONSE_COUNT = 8;
const DEFAULT_MINING_HAULER_COUNT = 1;
const DEFAULT_MINING_WARP_INGRESS_DURATION_MS = 2_500;
const DEFAULT_MINING_WARP_LANDING_RADIUS_METERS = 2_500;
const DEFAULT_MINING_FLEET_SPREAD_METERS = 1_500;
const DEFAULT_MINING_HAUL_THRESHOLD_RATIO = 0.85;
const DEFAULT_MINING_HAULER_UNLOAD_DURATION_MS = 8_000;
const DEFAULT_MINING_HAULER_INITIAL_DELAY_MS = 5_400_000;
const DEFAULT_MINING_HAULER_REPEAT_DELAY_MS = 1_800_000;
const DEFAULT_MINING_MINER_CARGO_CAPACITY_M3 = 35_000;
const DEFAULT_MINING_HAULER_CARGO_CAPACITY_M3 = 65_000;
const DEFAULT_MINING_JETCAN_CAPACITY_M3 = 27_500;
const DEFAULT_MINING_JETCAN_LIFETIME_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MINING_SUPPORT_PICKUP_RANGE_METERS = 2_500;
const DEFAULT_MINING_SUPPORT_PICKUP_SETTLE_MS = 8_000;
const MINING_JETTISON_EFFECT_GUID = "effects.Jettison";
const MINING_TRACTOR_EFFECT_NAME = "tractorBeamCan";
const MINING_JETCAN_DESTRUCTION_EFFECT_ID = 3;
const DEFAULT_MINING_AGGRESSION_MEMORY_MS = 180_000;
const DEFAULT_MINING_RESPONSE_COOLDOWN_MS = 60_000;
const DEFAULT_MINING_RESPONSE_RETREAT_DELAY_MS = 120_000;
const FLEET_HANGAR_CAPACITY_ATTRIBUTE_ID =
  getAttributeIDByNames("fleetHangarCapacity") || 912;
const MINING_CARGO_FULL_EPSILON_M3 = 0.000001;
const DEFAULT_MANAGED_MINING_DEFENSE_REQUIRED_OVERMATCH = 3;
const DEFAULT_MANAGED_MINING_DEFENSE_MAX_BOUNTY_ISK = 30_000;
const DEFAULT_MANAGED_MINING_DEFENSE_RETREAT_SHIELD_RATIO = 0.65;
const DEFAULT_MANAGED_MINING_DEFENSE_MAX_ACTIVE_DRONES = 20;
const DEFAULT_MANAGED_MINING_DEFENSE_SCAN_RANGE_METERS = 100_000;
const DEFAULT_MANAGED_MINING_DEFENSE_SCAN_INTERVAL_MS = 5_000;
const DEFAULT_MANAGED_MINING_DEFENSE_RETREAT_COOLDOWN_MS = 30_000;
const MINING_FLEET_COMMAND_BURST_AFFINITY_BASE = 1_500_000_000;
const MANAGED_MINING_DEFENSE_REJECTED_NAME_PATTERN =
  /\b(?:dread|elite|commander|officer|overseer|deadspace|capital|battleship|battlecruiser|cruiser)\b/i;
const MANAGED_MINING_DEFENSE_HOSTILE_UTILITY_GROUP_IDS =
  new Set([
    52, // Warp scramblers/disruptors.
    65, // Stasis webifiers.
    68, // Energy vampires.
    71, // Energy neutralizers.
    201, // ECM.
    379, // Target painters.
  ]);
const MANAGED_INDUSTRIAL_CREW_ROLES = new Set([
  "miner",
  "mining_support",
  "hauler",
]);

const miningFleetStateByID = new Map();
const startupSceneSeedSet = new Set();
const miningCargoCapacitySnapshotByEntity = new WeakMap();
let nextMiningFleetID = 1;

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function distance(left, right) {
  const dx = toFiniteNumber(left && left.x, 0) - toFiniteNumber(right && right.x, 0);
  const dy = toFiniteNumber(left && left.y, 0) - toFiniteNumber(right && right.y, 0);
  const dz = toFiniteNumber(left && left.z, 0) - toFiniteNumber(right && right.z, 0);
  return Math.sqrt((dx ** 2) + (dy ** 2) + (dz ** 2));
}

function getSurfaceDistance(left, right) {
  return Math.max(
    0,
    distance(left && left.position, right && right.position) -
      toFiniteNumber(left && left.radius, 0) -
      toFiniteNumber(right && right.radius, 0),
  );
}

function cloneVector(source = null, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: toFiniteNumber(source && source.x, fallback.x),
    y: toFiniteNumber(source && source.y, fallback.y),
    z: toFiniteNumber(source && source.z, fallback.z),
  };
}

function normalizeVector(source = null, fallback = { x: 1, y: 0, z: 0 }) {
  const vector = cloneVector(source, fallback);
  const length = Math.sqrt(
    (vector.x ** 2) + (vector.y ** 2) + (vector.z ** 2),
  );
  if (!Number.isFinite(length) || length <= 0) {
    return cloneVector(fallback);
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function getSpaceRuntime() {
  return require(path.join(__dirname, "../../space/runtime"));
}

function getManagedDroneRuntime() {
  return require(path.join(__dirname, "../drone/droneRuntime"));
}

function isManagedIndustrialMiningFleet(fleetRecord) {
  return Boolean(
    fleetRecord &&
    String(fleetRecord.operatorKind || "").trim() &&
    String(fleetRecord.operatorID || "").trim(),
  );
}

function normalizeManagedThreatDoctrine(source = {}) {
  const doctrine =
    source && typeof source === "object"
      ? source
      : {};
  return {
    requiredCrewOvermatch: Math.max(
      1,
      toFiniteNumber(
        doctrine.requiredCrewOvermatch,
        toFiniteNumber(
          config.miningNpcManagedDefenseRequiredOvermatch,
          DEFAULT_MANAGED_MINING_DEFENSE_REQUIRED_OVERMATCH,
        ),
      ),
    ),
    maximumThreatBountyISK: Math.max(
      0,
      toFiniteNumber(
        doctrine.maximumThreatBountyISK,
        toFiniteNumber(
          config.miningNpcManagedDefenseMaxBountyISK,
          DEFAULT_MANAGED_MINING_DEFENSE_MAX_BOUNTY_ISK,
        ),
      ),
    ),
    projectedCasualtyProbabilityCeiling: Math.max(
      0,
      toFiniteNumber(
        doctrine.projectedCasualtyProbabilityCeiling,
        0.01,
      ),
    ),
  };
}

function getManagedFleetOwnerCharacterID(fleetRecord) {
  return normalizePositiveInteger(
    fleetRecord &&
      (
        fleetRecord.createdByCharacterID ||
        fleetRecord.cargoOwnerID
      ),
    0,
  );
}

function listCoLocatedManagedIndustrialFleets(
  scene,
  fleetRecord,
) {
  if (
    !scene ||
    !isManagedIndustrialMiningFleet(fleetRecord)
  ) {
    return [fleetRecord].filter(Boolean);
  }
  const ownerCharacterID =
    getManagedFleetOwnerCharacterID(fleetRecord);
  const systemID = normalizePositiveInteger(
    fleetRecord.systemID || scene.systemID,
    0,
  );
  const siteID = normalizePositiveInteger(
    fleetRecord.targetShipID,
    0,
  );
  if (!(ownerCharacterID > 0) || !(siteID > 0)) {
    return [fleetRecord];
  }
  return [...miningFleetStateByID.values()]
    .filter((candidate) => (
      isManagedIndustrialMiningFleet(candidate) &&
      getManagedFleetOwnerCharacterID(candidate) ===
        ownerCharacterID &&
      normalizePositiveInteger(candidate.systemID, 0) ===
        systemID &&
      normalizePositiveInteger(candidate.targetShipID, 0) ===
        siteID &&
      ["mining", "defending"].includes(
        String(candidate.state || ""),
      ) &&
      getFleetEntities(scene, candidate).length > 0
    ))
    .sort(
      (left, right) =>
        toInt(left.fleetID, 0) -
        toInt(right.fleetID, 0),
    );
}

function getManagedFleetDefensiveDroneState(fleetRecord) {
  if (
    !fleetRecord.defensiveDroneFlightIDsByControllerID ||
    typeof fleetRecord.defensiveDroneFlightIDsByControllerID !== "object"
  ) {
    fleetRecord.defensiveDroneFlightIDsByControllerID = {};
  }
  return fleetRecord.defensiveDroneFlightIDsByControllerID;
}

function notifyManagedDroneStockChanged(
  fleetRecord,
  controllerEntity,
  stock,
  event = {},
) {
  if (
    !fleetRecord ||
    typeof fleetRecord.onManagedDroneStockChanged !== "function" ||
    !stock
  ) {
    return null;
  }
  const payload = {
    ...event,
    stock,
    atMs: Math.max(
      0,
      toInt(event.atMs, Date.now()),
    ),
    fleetID: toInt(fleetRecord.fleetID, 0),
    operatorKind: fleetRecord.operatorKind,
    operatorID: fleetRecord.operatorID,
    controllerEntityID: toInt(
      controllerEntity && controllerEntity.itemID,
      0,
    ),
    controllerTypeID: toInt(
      controllerEntity && controllerEntity.typeID,
      0,
    ),
  };
  try {
    return fleetRecord.onManagedDroneStockChanged(payload);
  } catch (error) {
    log.error(
      `[MiningFleet] managed drone stock callback failed ` +
      `fleet=${fleetRecord.fleetID} ` +
      `controller=${payload.controllerEntityID}: ` +
      String(error && error.message || error),
    );
    return {
      success: false,
      errorMsg: "MANAGED_DRONE_STOCK_CALLBACK_FAILED",
    };
  }
}

function resolveManagedEntityDroneDoctrine(entity) {
  const controller = entity
    ? npcService.getControllerByEntityID(
        toInt(entity.itemID, 0),
      )
    : null;
  const definition =
    controller &&
    controller.definitionSnapshot &&
    typeof controller.definitionSnapshot === "object"
      ? controller.definitionSnapshot
      : null;
  const loadout =
    definition &&
    definition.loadout &&
    typeof definition.loadout === "object"
      ? definition.loadout
      : {};
  const governance =
    entity &&
    entity.doctrineGovernance &&
    typeof entity.doctrineGovernance === "object"
      ? entity.doctrineGovernance
      : {};
  const bayEntries = [
    entity && entity.governedDroneBay,
    entity && entity.droneBay,
    entity && entity.npcDroneBay,
    governance.droneBay,
    loadout.droneBay,
  ].find(
    (entries) =>
      Array.isArray(entries) && entries.length > 0,
  ) || [];
  const defenseFlights = [
    entity && entity.defensiveDroneFlights,
    entity && entity.defenseFlights,
    governance.defenseFlights,
    loadout.defenseFlights,
  ].find(
    (entries) =>
      Array.isArray(entries) && entries.length > 0,
  ) || [];
  return {
    bayEntries,
    defenseFlights,
  };
}

function resolveManagedThreatSizeClass(entity) {
  const itemType =
    resolveItemByTypeID(
      toInt(entity && entity.typeID, 0),
    ) || {};
  const groupName = String(
    itemType.groupName ||
    itemType.group ||
    entity && entity.groupName ||
    "",
  ).toLowerCase();
  for (const sizeClass of [
    "frigate",
    "destroyer",
    "cruiser",
    "battlecruiser",
    "battleship",
    "capital",
  ]) {
    if (groupName.includes(sizeClass)) {
      return sizeClass;
    }
  }
  const radius = Math.max(
    0,
    toFiniteNumber(
      entity && entity.radius,
      toFiniteNumber(itemType.radius, 0),
    ),
  );
  if (radius > 0 && radius <= 60) return "frigate";
  if (radius > 0 && radius <= 100) return "destroyer";
  if (radius > 0 && radius <= 250) return "cruiser";
  if (radius > 0 && radius <= 400) {
    return "battlecruiser";
  }
  if (radius > 0 && radius <= 800) return "battleship";
  return "unknown";
}

function selectManagedDefenseFlight(
  defenseFlights,
  targetSizeClass,
) {
  return (
    Array.isArray(defenseFlights)
      ? defenseFlights
      : []
  ).find((flight) => {
    const droneTypeID = toInt(
      flight && (flight.droneTypeID ?? flight.typeID),
      0,
    );
    const launchCount = Math.max(
      0,
      toInt(
        flight &&
          (flight.launchCount ?? flight.quantity),
        0,
      ),
    );
    const targetSizeClasses = Array.isArray(
      flight && flight.targetSizeClasses,
    )
      ? flight.targetSizeClasses.map((entry) =>
          String(entry || "").trim().toLowerCase())
      : [];
    return (
      droneTypeID > 0 &&
      launchCount > 0 &&
      (
        targetSizeClasses.length <= 0 ||
        targetSizeClasses.includes(targetSizeClass)
      )
    );
  }) || null;
}

function getManagedDefenseFlightPower(flight) {
  if (!flight) {
    return 0;
  }
  const droneTypeID = toInt(
    flight.droneTypeID ?? flight.typeID,
    0,
  );
  const launchCount = Math.max(
    0,
    toInt(
      flight.launchCount ?? flight.quantity,
      0,
    ),
  );
  const bandwidthPerDrone = Math.max(
    0,
    toFiniteNumber(
      getTypeAttributeValue(
        droneTypeID,
        "droneBandwidthUsed",
        "droneBandwidthLoad",
      ),
      0,
    ),
  );
  return (
    launchCount *
    Math.max(1, bandwidthPerDrone / 5)
  );
}

function getEntityCombatHealthSnapshot(entity) {
  const condition =
    entity &&
    entity.conditionState &&
    typeof entity.conditionState === "object"
      ? entity.conditionState
      : {};
  return {
    shieldRatio: Math.max(
      0,
      Math.min(
        1,
        toFiniteNumber(condition.shieldCharge, 1),
      ),
    ),
    armorDamageRatio: Math.max(
      0,
      Math.min(
        1,
        toFiniteNumber(condition.armorDamage, 0),
      ),
    ),
    structureDamageRatio: Math.max(
      0,
      Math.min(
        1,
        toFiniteNumber(condition.damage, 0),
      ),
    ),
  };
}

function assessManagedIndustrialThreat(
  scene,
  fleetRecord,
  aggressorEntity,
) {
  if (config.miningNpcManagedDefenseEnabled !== true) {
    return {
      engage: false,
      reason: "DEFENSE_DISABLED",
    };
  }
  if (
    !scene ||
    !fleetRecord ||
    !aggressorEntity ||
    aggressorEntity.nativeNpc !== true
  ) {
    return {
      engage: false,
      reason: "THREAT_NOT_KNOWN_NPC",
    };
  }
  const aggressorController =
    npcService.getControllerByEntityID(
      toInt(aggressorEntity.itemID, 0),
    );
  const definition =
    aggressorController &&
    aggressorController.definitionSnapshot &&
    typeof aggressorController.definitionSnapshot === "object"
      ? aggressorController.definitionSnapshot
      : null;
  if (
    !aggressorController ||
    !definition ||
    aggressorEntity.capitalNpc === true
  ) {
    return {
      engage: false,
      reason: "THREAT_DEFINITION_UNTRUSTED",
    };
  }

  const targetSizeClass =
    resolveManagedThreatSizeClass(aggressorEntity);
  if (
    !["frigate", "destroyer"].includes(
      targetSizeClass,
    )
  ) {
    return {
      engage: false,
      reason: "THREAT_HULL_TOO_LARGE",
      targetSizeClass,
    };
  }
  const threatName = [
    aggressorEntity.itemName,
    aggressorEntity.slimName,
    definition.profile && definition.profile.name,
    definition.profile && definition.profile.profileID,
  ].filter(Boolean).join(" ");
  if (
    MANAGED_MINING_DEFENSE_REJECTED_NAME_PATTERN.test(
      threatName,
    )
  ) {
    return {
      engage: false,
      reason: "THREAT_VARIANT_REJECTED",
      targetSizeClass,
    };
  }
  const participatingFleets =
    listCoLocatedManagedIndustrialFleets(
      scene,
      fleetRecord,
    );
  const participatingDoctrine =
    participatingFleets.map((candidate) =>
      normalizeManagedThreatDoctrine(
        candidate && candidate.threatDoctrine,
      ));
  const bounty = Math.max(
    0,
    toFiniteNumber(aggressorEntity.bounty, 0),
  );
  const maximumBounty = Math.max(
    ...participatingDoctrine.map(
      (doctrine) =>
        doctrine.maximumThreatBountyISK,
    ),
  );
  if (bounty <= 0 || bounty > maximumBounty) {
    return {
      engage: false,
      reason: "THREAT_BOUNTY_OUT_OF_POLICY",
      targetSizeClass,
      bounty,
      maximumBounty,
    };
  }
  const hasHostileUtility =
    getNpcFittedModuleItems(aggressorEntity)
      .some((moduleItem) => {
        const typeRecord =
          resolveItemByTypeID(
            toInt(moduleItem && moduleItem.typeID, 0),
          ) || {};
        return (
          MANAGED_MINING_DEFENSE_HOSTILE_UTILITY_GROUP_IDS
            .has(
              toInt(
                moduleItem && moduleItem.groupID,
                toInt(typeRecord.groupID, 0),
              ),
            )
        );
      });
  if (hasHostileUtility) {
    return {
      engage: false,
      reason: "THREAT_HAS_CONTROL_MODULES",
      targetSizeClass,
    };
  }

  const defensePlans = [];
  let defensePower = 0;
  let plannedDroneCount = 0;
  const maximumActiveDronesPerFleet = Math.max(
    0,
    toInt(
      config.miningNpcManagedDefenseMaxActiveDrones,
      DEFAULT_MANAGED_MINING_DEFENSE_MAX_ACTIVE_DRONES,
    ),
  );
  for (const participatingFleet of participatingFleets) {
    let remainingDroneSlots =
      maximumActiveDronesPerFleet;
    for (
      const entity of getFleetEntities(
        scene,
        participatingFleet,
      )
    ) {
      const health =
        getEntityCombatHealthSnapshot(entity);
      if (
        health.shieldRatio < 0.99 ||
        health.armorDamageRatio > 0 ||
        health.structureDamageRatio > 0
      ) {
        return {
          engage: false,
          reason: "CREW_NOT_PRISTINE",
          targetSizeClass,
        };
      }
      const doctrine =
        resolveManagedEntityDroneDoctrine(entity);
      const selectedFlight = selectManagedDefenseFlight(
        doctrine.defenseFlights,
        targetSizeClass,
      );
      if (
        !selectedFlight ||
        doctrine.bayEntries.length <= 0
      ) {
        continue;
      }
      const authoredLaunchCount = Math.max(
        0,
        toInt(
          selectedFlight.launchCount ??
            selectedFlight.quantity,
          0,
        ),
      );
      const stagedLaunchCount = Math.min(
        authoredLaunchCount,
        remainingDroneSlots,
      );
      if (stagedLaunchCount <= 0) {
        break;
      }
      const stagedFlight = {
        ...selectedFlight,
        launchCount: stagedLaunchCount,
      };
      const flightPower =
        getManagedDefenseFlightPower(stagedFlight);
      if (flightPower <= 0) {
        continue;
      }
      defensePlans.push({
        fleetRecord: participatingFleet,
        controllerEntity: entity,
        bayEntries: doctrine.bayEntries,
        selectedFlight: stagedFlight,
        flightPower,
      });
      defensePower += flightPower;
      plannedDroneCount += stagedLaunchCount;
      remainingDroneSlots -= stagedLaunchCount;
    }
  }
  if (defensePlans.length <= 0) {
    return {
      engage: false,
      reason: "NO_LEGAL_DEFENSE_FLIGHT",
      targetSizeClass,
    };
  }

  const shieldCapacity = Math.max(
    0,
    toFiniteNumber(
      aggressorEntity.shieldCapacity,
      getTypeAttributeValue(
        aggressorEntity.typeID,
        "shieldCapacity",
      ),
    ),
  );
  const armorHP = Math.max(
    0,
    toFiniteNumber(
      aggressorEntity.armorHP,
      getTypeAttributeValue(
        aggressorEntity.typeID,
        "armorHP",
      ),
    ),
  );
  const structureHP = Math.max(
    0,
    toFiniteNumber(
      aggressorEntity.structureHP,
      getTypeAttributeValue(
        aggressorEntity.typeID,
        "hp",
        "structureHP",
      ),
    ),
  );
  const threatPower = Math.max(
    1,
    bounty / 5_000,
    (
      shieldCapacity +
      armorHP +
      structureHP
    ) / 2_000,
  );
  const requiredOvermatch = Math.max(
    ...participatingDoctrine.map(
      (doctrine) =>
        doctrine.requiredCrewOvermatch,
    ),
  );
  if (
    defensePower <
    threatPower * requiredOvermatch
  ) {
    return {
      engage: false,
      reason: "INSUFFICIENT_ZERO_LOSS_MARGIN",
      targetSizeClass,
      defensePower,
      threatPower,
      requiredOvermatch,
    };
  }
  return {
    engage: true,
    reason: "KNOWN_NPC_OVERMATCH",
    targetSizeClass,
    bounty,
    defensePower,
    threatPower,
    requiredOvermatch,
    plannedDroneCount,
    defensePlans,
    participatingFleets,
  };
}

function scanManagedIndustrialFleetThreat(
  scene,
  fleetRecord,
  now = Date.now(),
) {
  const scanAtMs = Math.max(0, toInt(now, 0));
  const fleetEntityIDSet =
    new Set(getFleetEntityIDs(fleetRecord));
  const assignedTarget =
    scene.getEntityByID(
      toInt(fleetRecord.activeAsteroidID, 0),
    ) ||
    scene.getEntityByID(
      toInt(fleetRecord.targetShipID, 0),
    ) ||
    null;
  const interactionSource =
    getFleetEntities(scene, fleetRecord)[0] ||
    assignedTarget ||
    null;
  const isAwayFromSite = [
    "aggressed",
    "panic",
    "returning_to_site",
  ].includes(String(fleetRecord.state || ""));
  const assignedSitePosition =
    assignedTarget && assignedTarget.position ||
    fleetRecord.retreatSitePosition ||
    null;
  const referencePosition =
    isAwayFromSite && assignedSitePosition
      ? assignedSitePosition
      : buildFleetReferencePosition(
          scene,
          fleetRecord,
        );
  const scanRangeMeters = Math.max(
    0,
    toFiniteNumber(
      config.miningNpcManagedDefenseScanRangeMeters,
      DEFAULT_MANAGED_MINING_DEFENSE_SCAN_RANGE_METERS,
    ),
  );
  const isCandidate = (entity) => {
    if (
      !entity ||
      entity.kind !== "ship" ||
      entity.nativeNpc !== true ||
      fleetEntityIDSet.has(toInt(entity.itemID, 0)) ||
      (
        interactionSource &&
        !canEntitiesInteractLocally(
          interactionSource,
          entity,
        )
      )
    ) {
      return false;
    }
    if (toFiniteNumber(entity.bounty, 0) <= 0) {
      return false;
    }
    return (
      !referencePosition ||
      !entity.position ||
      distance(
        referencePosition,
        entity.position,
      ) <= scanRangeMeters
    );
  };

  const scanIntervalMs = Math.max(
    250,
    toInt(
      config.miningNpcManagedDefenseScanIntervalMs,
      DEFAULT_MANAGED_MINING_DEFENSE_SCAN_INTERVAL_MS,
    ),
  );
  const lastScanAtMs = toInt(
    fleetRecord.lastManagedThreatScanAtMs,
    -1,
  );
  if (
    lastScanAtMs >= 0 &&
    scanAtMs >= lastScanAtMs &&
    scanAtMs - lastScanAtMs < scanIntervalMs
  ) {
    const cached =
      fleetRecord.lastManagedThreatScanResult || null;
    if (!cached) {
      return null;
    }
    const cachedEntity = scene.getEntityByID(
      toInt(cached.entityID, 0),
    );
    return isCandidate(cachedEntity)
      ? {
          ...cached,
          entity: cachedEntity,
          cached: true,
        }
      : null;
  }

  fleetRecord.lastManagedThreatScanAtMs =
    scanAtMs;
  fleetRecord.managedThreatScanCount =
    Math.max(
      0,
      toInt(fleetRecord.managedThreatScanCount, 0),
    ) + 1;

  const bubbleIDs = new Set();
  if (assignedTarget) {
    const targetBubbleID = toInt(
      assignedTarget.bubbleID,
      0,
    );
    if (targetBubbleID > 0) {
      bubbleIDs.add(targetBubbleID);
    }
  }
  for (const entityID of fleetEntityIDSet) {
    const crewEntity =
      scene.getEntityByID(entityID);
    const bubbleID = toInt(
      crewEntity && crewEntity.bubbleID,
      0,
    );
    if (bubbleID > 0) {
      bubbleIDs.add(bubbleID);
    }
  }
  const dynamicEntities = [];
  const seenEntityIDs = new Set();
  const appendEntities = (entities) => {
    for (const entity of entities || []) {
      const entityID = toInt(
        entity && entity.itemID,
        0,
      );
      if (
        entityID <= 0 ||
        seenEntityIDs.has(entityID)
      ) {
        continue;
      }
      seenEntityIDs.add(entityID);
      dynamicEntities.push(entity);
    }
  };
  if (
    bubbleIDs.size > 0 &&
    typeof scene.getDynamicEntitiesInBubble ===
      "function"
  ) {
    for (const bubbleID of bubbleIDs) {
      appendEntities(
        scene.getDynamicEntitiesInBubble(bubbleID),
      );
    }
  } else if (
    typeof scene.getDynamicEntities === "function"
  ) {
    appendEntities(scene.getDynamicEntities());
  } else if (scene.dynamicEntities instanceof Map) {
    appendEntities(scene.dynamicEntities.values());
  }

  let selected = null;
  let candidateCount = 0;
  for (const entity of dynamicEntities) {
    if (!isCandidate(entity)) {
      continue;
    }
    candidateCount += 1;
    const itemType =
      resolveItemByTypeID(
        toInt(entity.typeID, 0),
      ) || {};
    const threatName = String(
      entity.itemName ||
      entity.slimName ||
      itemType.name ||
      "",
    );
    const sizeClass =
      resolveManagedThreatSizeClass(entity);
    const sizeRank = {
      unknown: 7,
      capital: 6,
      battleship: 5,
      battlecruiser: 4,
      cruiser: 3,
      destroyer: 2,
      frigate: 1,
    }[sizeClass] || 7;
    const candidate = {
      entity,
      distanceMeters:
        referencePosition && entity.position
          ? distance(
              referencePosition,
              entity.position,
            )
          : 0,
      riskRank:
        (entity.capitalNpc === true ? 100 : 0) +
        (
          MANAGED_MINING_DEFENSE_REJECTED_NAME_PATTERN
            .test(threatName)
            ? 50
            : 0
        ) +
        sizeRank,
      bounty: Math.max(
        0,
        toFiniteNumber(entity.bounty, 0),
      ),
    };
    if (
      !selected ||
      candidate.riskRank > selected.riskRank ||
      (
        candidate.riskRank === selected.riskRank &&
        (
          candidate.bounty > selected.bounty ||
          (
            candidate.bounty === selected.bounty &&
            (
              candidate.distanceMeters <
                selected.distanceMeters ||
              (
                candidate.distanceMeters ===
                  selected.distanceMeters &&
                toInt(candidate.entity.itemID, 0) <
                  toInt(selected.entity.itemID, 0)
              )
            )
          )
        )
      )
    ) {
      selected = candidate;
    }
  }

  fleetRecord.lastManagedThreatScanCandidateCount =
    candidateCount;
  fleetRecord.lastManagedThreatScanEvaluatedEntityCount =
    dynamicEntities.length;
  fleetRecord.lastManagedThreatScanResult = selected
    ? {
        entityID: toInt(selected.entity.itemID, 0),
        distanceMeters: selected.distanceMeters,
        riskRank: selected.riskRank,
        bounty: selected.bounty,
      }
    : null;
  return selected
    ? {
        ...fleetRecord.lastManagedThreatScanResult,
        entity: selected.entity,
        cached: false,
      }
    : null;
}

function buildNpcPseudoSession(entity, hooks = null) {
  if (hooks && typeof hooks.buildNpcPseudoSession === "function") {
    return hooks.buildNpcPseudoSession(entity);
  }
  return {
    characterID: toInt(
      entity && (
        entity.npcPilotCharacterID ??
        entity.pilotCharacterID ??
        entity.characterID
      ),
      0,
    ),
    corporationID: toInt(entity && entity.corporationID, 0),
    allianceID: toInt(entity && entity.allianceID, 0),
    _space: {
      systemID: toInt(entity && entity.systemID, 0),
      shipID: toInt(entity && entity.itemID, 0),
    },
  };
}

function getMiningCommandBurstModules(entity) {
  return getNpcFittedModuleItems(entity)
    .filter((moduleItem) => isModuleOnline(moduleItem))
    .map((moduleItem) => ({
      moduleItem,
      effectRecord: getTypeEffectRecords(toInt(moduleItem && moduleItem.typeID, 0))
        .find((effectRecord) => (
          String(effectRecord && effectRecord.name || "") ===
          "moduleBonusWarfareLinkMining"
        )) || null,
      chargeItem: getNpcLoadedChargeForModule(
        entity,
        moduleItem,
      ),
    }))
    .filter((entry) => entry.effectRecord);
}

function maintainMiningSupportBursts(
  scene,
  fleetRecord,
  hooks = null,
) {
  if (
    !scene ||
    !fleetRecord ||
    fleetRecord.state !== "mining"
  ) {
    return {
      configuredCount: 0,
      activeCount: 0,
      activatedCount: 0,
    };
  }
  const commandBurstEntries =
    getFleetEntities(scene, fleetRecord)
      .flatMap((entity) =>
        getMiningCommandBurstModules(entity)
          .map((entry) => ({
            ...entry,
            entity,
          })));
  if (commandBurstEntries.length <= 0) {
    return {
      configuredCount: 0,
      activeCount: 0,
      activatedCount: 0,
    };
  }

  for (
    const minerEntityID of
    fleetRecord.minerEntityIDs || []
  ) {
    const minerEntity =
      scene.getEntityByID(minerEntityID);
    if (
      minerEntity &&
      minerEntity.npcMiningSupportBonus
    ) {
      delete minerEntity.npcMiningSupportBonus;
    }
  }

  let activeCount = 0;
  let activatedCount = 0;
  const errors = [];
  for (const entry of commandBurstEntries) {
    const moduleItemID = toInt(
      entry.moduleItem && entry.moduleItem.itemID,
      0,
    );
    const activeEffect =
      entry.entity.activeModuleEffects instanceof Map
        ? entry.entity.activeModuleEffects.get(
            moduleItemID,
          )
        : null;
    if (activeEffect) {
      activeCount += 1;
      continue;
    }
    if (
      !entry.chargeItem ||
      toInt(entry.chargeItem.typeID, 0) <= 0
    ) {
      errors.push({
        entityID: toInt(entry.entity.itemID, 0),
        moduleItemID,
        errorMsg:
          "MINING_COMMAND_BURST_CHARGE_REQUIRED",
      });
      continue;
    }
    const activationResult =
      scene.activateGenericModule(
        buildNpcPseudoSession(
          entry.entity,
          hooks,
        ),
        entry.moduleItem,
        entry.effectRecord.name,
        {},
      );
    if (
      activationResult &&
      activationResult.success === true
    ) {
      activeCount += 1;
      activatedCount += 1;
    } else {
      errors.push({
        entityID: toInt(entry.entity.itemID, 0),
        moduleItemID,
        errorMsg:
          activationResult &&
            activationResult.errorMsg ||
          "MINING_COMMAND_BURST_ACTIVATION_FAILED",
      });
    }
  }
  fleetRecord.commandBurstConfiguredCount =
    commandBurstEntries.length;
  fleetRecord.commandBurstActiveCount =
    activeCount;
  fleetRecord.commandBurstLastErrors = errors;
  return {
    configuredCount: commandBurstEntries.length,
    activeCount,
    activatedCount,
    errors,
  };
}

function deactivateMiningSupportBursts(
  scene,
  fleetRecord,
  hooks = null,
  reason = "state",
) {
  if (!scene || !fleetRecord) {
    return 0;
  }
  let deactivatedCount = 0;
  for (const entity of getFleetEntities(scene, fleetRecord)) {
    const pseudoSession = buildNpcPseudoSession(entity, hooks);
    for (const entry of getMiningCommandBurstModules(entity)) {
      const moduleItemID = toInt(entry.moduleItem && entry.moduleItem.itemID, 0);
      const activeEffect = entity.activeModuleEffects instanceof Map
        ? entity.activeModuleEffects.get(moduleItemID)
        : null;
      if (!activeEffect) {
        continue;
      }
      const result = scene.deactivateGenericModule(pseudoSession, moduleItemID, {
        reason,
        deferUntilCycle: false,
      });
      if (!result || result.success !== false) {
        deactivatedCount += 1;
      }
    }
  }
  return deactivatedCount;
}

function recallManagedFleetDefensiveDrones(
  scene,
  fleetRecord,
  reason = "recall",
) {
  if (!fleetRecord || !isManagedIndustrialMiningFleet(fleetRecord)) {
    return 0;
  }
  let droneRuntime;
  try {
    droneRuntime = getManagedDroneRuntime();
  } catch (_error) {
    return 0;
  }
  const activeScene = resolveFleetScene(scene, fleetRecord);
  const flightIDsByControllerID =
    getManagedFleetDefensiveDroneState(fleetRecord);
  let recalledCount = 0;
  for (const entityID of getFleetEntityIDs(fleetRecord)) {
    const controllerEntity =
      activeScene && activeScene.getEntityByID(entityID);
    const flightID = String(
      flightIDsByControllerID[String(entityID)] || "",
    ).trim();
    if (
      flightID &&
      controllerEntity &&
      typeof droneRuntime.recallManagedTransientNpcDroneFlight === "function"
    ) {
      const result = droneRuntime.recallManagedTransientNpcDroneFlight(
        activeScene,
        controllerEntity,
        { flightID, reason },
      );
      if (result && result.success === true) {
        recalledCount += 1;
      }
    }
    if (
      activeScene &&
      typeof droneRuntime.cleanupManagedTransientNpcDroneFlightsForController ===
        "function"
    ) {
      droneRuntime.cleanupManagedTransientNpcDroneFlightsForController(
        activeScene,
        controllerEntity || entityID,
        { reason },
      );
    }
  }
  fleetRecord.defensiveDroneFlightIDsByControllerID = {};
  fleetRecord.defenseDroneLossDetected = false;
  fleetRecord.defenseDecision = null;
  return recalledCount;
}

function beginManagedFleetDroneDefense(
  scene,
  fleetRecord,
  aggressorEntity,
  assessment,
  options = {},
) {
  let droneRuntime;
  try {
    droneRuntime = getManagedDroneRuntime();
  } catch (_error) {
    return {
      success: false,
      errorMsg: "MANAGED_DRONE_RUNTIME_UNAVAILABLE",
    };
  }
  if (
    typeof droneRuntime
      .launchManagedTransientNpcDroneFlight !==
      "function" ||
    typeof droneRuntime
      .engageManagedTransientNpcDroneFlight !==
      "function"
  ) {
    return {
      success: false,
      errorMsg: "MANAGED_DRONE_API_UNAVAILABLE",
    };
  }
  const participatingFleets = (
    Array.isArray(
      assessment && assessment.participatingFleets,
    ) &&
    assessment.participatingFleets.length > 0
      ? assessment.participatingFleets
      : [fleetRecord]
  );
  const recallParticipatingFleets = (reason) => {
    for (const participatingFleet of participatingFleets) {
      recallManagedFleetDefensiveDrones(
        scene,
        participatingFleet,
        reason,
      );
    }
  };
  const touchedEntityIDs = [];
  for (const plan of assessment.defensePlans || []) {
    const defensiveFleet =
      plan && plan.fleetRecord || fleetRecord;
    const activeFlights =
      getManagedFleetDefensiveDroneState(
        defensiveFleet,
      );
    const controllerEntity = plan.controllerEntity;
    const entityID = toInt(
      controllerEntity && controllerEntity.itemID,
      0,
    );
    let flightID = String(
      activeFlights[String(entityID)] || "",
    ).trim();
    if (!flightID) {
      const launchResult =
        droneRuntime
          .launchManagedTransientNpcDroneFlight(
            scene,
            controllerEntity,
            plan.selectedFlight,
            {
              targetEntity: aggressorEntity,
              bayEntries: plan.bayEntries,
              ownerKind:
                "managed_industrial_mining_fleet",
              ownerID: defensiveFleet.fleetID,
              provenance: {
                source:
                  "managed_industrial_defense",
                fleetID: defensiveFleet.fleetID,
                operatorKind:
                  defensiveFleet.operatorKind,
                operatorID:
                  defensiveFleet.operatorID,
              },
              nowMs: options.nowMs,
              onStockChanged(event = {}) {
                notifyManagedDroneStockChanged(
                  defensiveFleet,
                  controllerEntity,
                  event.stock,
                  {
                    ...event,
                    eventKind: "stock_transition",
                  },
                );
              },
              onDroneLost() {
                defensiveFleet.defenseDroneLossDetected =
                  true;
              },
              onFlightClosed() {
                if (
                  activeFlights[String(entityID)] ===
                  flightID
                ) {
                  delete activeFlights[
                    String(entityID)
                  ];
                }
              },
            },
          );
      if (
        !launchResult ||
        launchResult.success !== true ||
        !launchResult.flightID
      ) {
        recallParticipatingFleets("launch_failure");
        return {
          success: false,
          errorMsg:
            launchResult &&
              launchResult.errorMsg ||
            "MANAGED_DRONE_LAUNCH_FAILED",
        };
      }
      flightID = String(launchResult.flightID);
      activeFlights[String(entityID)] = flightID;
      touchedEntityIDs.push(entityID);
      const launchStockPersisted =
        notifyManagedDroneStockChanged(
          defensiveFleet,
          controllerEntity,
          launchResult.stock,
          {
            eventKind: "flight_launched",
            flightID,
            atMs: options.nowMs,
            launchedCount: toInt(
              launchResult.launchedCount,
              0,
            ),
          },
        );
      if (
        launchStockPersisted &&
        launchStockPersisted.success === false
      ) {
        recallParticipatingFleets(
          "stock_persistence_failure",
        );
        return {
          success: false,
          errorMsg:
            launchStockPersisted.errorMsg ||
            "MANAGED_DRONE_STOCK_PERSISTENCE_FAILED",
        };
      }
    }
    const engageResult =
      droneRuntime
        .engageManagedTransientNpcDroneFlight(
          scene,
          controllerEntity,
          aggressorEntity,
          { flightID },
        );
    if (
      !engageResult ||
      engageResult.success !== true
    ) {
      recallParticipatingFleets("engage_failure");
      return {
        success: false,
        errorMsg:
          engageResult && engageResult.errorMsg ||
          "MANAGED_DRONE_ENGAGE_FAILED",
      };
    }
  }
  const flightCount = participatingFleets.reduce(
    (total, participatingFleet) =>
      total +
      Object.keys(
        getManagedFleetDefensiveDroneState(
          participatingFleet,
        ),
      ).length,
    0,
  );
  if (flightCount <= 0) {
    return {
      success: false,
      errorMsg: "NO_MANAGED_DRONES_LAUNCHED",
    };
  }
  return {
    success: true,
    data: {
      flightCount,
      touchedEntityIDs,
      participatingFleetIDs:
        participatingFleets.map(
          (participatingFleet) =>
            toInt(participatingFleet.fleetID, 0),
        ),
    },
  };
}

function isManagedDefenseTargetGone(targetEntity) {
  if (
    !targetEntity ||
    targetEntity.pendingWarp ||
    targetEntity.mode === "WARP"
  ) {
    return true;
  }
  const health =
    getEntityCombatHealthSnapshot(targetEntity);
  return (
    health.structureDamageRatio >= 1 ||
    Boolean(
      targetEntity.conditionState &&
      targetEntity.conditionState.incapacitated,
    )
  );
}

function shouldManagedDefenseRetreat(
  scene,
  fleetRecord,
) {
  if (fleetRecord.defenseDroneLossDetected === true) {
    return "DEFENSIVE_DRONE_LOST";
  }
  const minimumShieldRatio = Math.max(
    0,
    Math.min(
      1,
      toFiniteNumber(
        config
          .miningNpcManagedDefenseRetreatShieldRatio,
        DEFAULT_MANAGED_MINING_DEFENSE_RETREAT_SHIELD_RATIO,
      ),
    ),
  );
  for (
    const entityID of getFleetEntityIDs(fleetRecord)
  ) {
    const entity = scene.getEntityByID(entityID);
    if (!entity) {
      return "CREW_SHIP_MISSING";
    }
    const health =
      getEntityCombatHealthSnapshot(entity);
    if (
      health.structureDamageRatio > 0 ||
      health.armorDamageRatio > 0 ||
      health.shieldRatio < minimumShieldRatio
    ) {
      return "ZERO_LOSS_MARGIN_BROKEN";
    }
  }
  return null;
}

function maintainManagedFleetDroneDefense(
  scene,
  fleetRecord,
  now,
) {
  const targetEntity = scene.getEntityByID(
    toInt(fleetRecord.responseTargetID, 0),
  );
  if (isManagedDefenseTargetGone(targetEntity)) {
    recallManagedFleetDefensiveDrones(
      scene,
      fleetRecord,
      "threat_clear",
    );
    fleetRecord.responseTargetID = 0;
    fleetRecord.state = "mining";
    fleetRecord.resumeAtMs = 0;
    return {
      active: false,
      cleared: true,
    };
  }
  const retreatReason =
    shouldManagedDefenseRetreat(scene, fleetRecord);
  if (retreatReason) {
    retreatFleetToOrigin(fleetRecord, {
      state: "panic",
      scene,
      reason: retreatReason,
    });
    return {
      active: false,
      retreated: true,
      reason: retreatReason,
    };
  }
  let droneRuntime;
  try {
    droneRuntime = getManagedDroneRuntime();
  } catch (_error) {
    droneRuntime = null;
  }
  if (
    !droneRuntime ||
    typeof droneRuntime
      .engageManagedTransientNpcDroneFlight !==
      "function"
  ) {
    retreatFleetToOrigin(fleetRecord, {
      state: "panic",
      scene,
      reason: "managed_drone_api_lost",
    });
    return {
      active: false,
      retreated: true,
      reason: "MANAGED_DRONE_API_LOST",
    };
  }
  const activeFlights =
    getManagedFleetDefensiveDroneState(fleetRecord);
  let engagedFlightCount = 0;
  for (
    const [entityID, flightID] of
    Object.entries(activeFlights)
  ) {
    const controllerEntity = scene.getEntityByID(
      toInt(entityID, 0),
    );
    if (!controllerEntity) {
      continue;
    }
    const result =
      droneRuntime
        .engageManagedTransientNpcDroneFlight(
          scene,
          controllerEntity,
          targetEntity,
          { flightID },
        );
    if (result && result.success === true) {
      engagedFlightCount += 1;
    }
  }
  if (engagedFlightCount <= 0) {
    retreatFleetToOrigin(fleetRecord, {
      state: "panic",
      scene,
      reason: "defense_flight_missing",
    });
    return {
      active: false,
      retreated: true,
      reason: "DEFENSE_FLIGHT_MISSING",
    };
  }
  fleetRecord.nextThinkAtMs = Math.max(
    toInt(fleetRecord.nextThinkAtMs, 0),
    toInt(now, 0),
  );
  return {
    active: true,
    engagedFlightCount,
  };
}

function buildFleetReferencePosition(scene, fleetRecord) {
  const sampledPositions = [];
  for (const entityID of Array.isArray(fleetRecord && fleetRecord.minerEntityIDs)
    ? fleetRecord.minerEntityIDs
    : []) {
    const entity = scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityID)
      : null;
    if (
      !entity ||
      !entity.position ||
      entity.mode === "WARP" ||
      entity.pendingWarp
    ) {
      continue;
    }
    sampledPositions.push(entity.position);
  }

  if (sampledPositions.length > 0) {
    const totals = sampledPositions.reduce((sum, position) => ({
      x: sum.x + toFiniteNumber(position && position.x, 0),
      y: sum.y + toFiniteNumber(position && position.y, 0),
      z: sum.z + toFiniteNumber(position && position.z, 0),
    }), { x: 0, y: 0, z: 0 });
    return {
      x: totals.x / sampledPositions.length,
      y: totals.y / sampledPositions.length,
      z: totals.z / sampledPositions.length,
    };
  }

  const preferredTarget =
    scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(normalizePositiveInteger(fleetRecord && fleetRecord.targetShipID, 0))
      : null;
  return (
    (preferredTarget && preferredTarget.position) ||
    (
      fleetRecord &&
      fleetRecord.originAnchor &&
      fleetRecord.originAnchor.position
    ) ||
    { x: 0, y: 0, z: 0 }
  );
}

function resolveActiveMineableTarget(scene, entityID, interactionSource = null) {
  const normalizedEntityID = normalizePositiveInteger(entityID, 0);
  if (!scene || normalizedEntityID <= 0) {
    return null;
  }
  const entity = typeof scene.getEntityByID === "function"
    ? scene.getEntityByID(normalizedEntityID)
    : null;
  const mineableState = getMineableState(scene, normalizedEntityID);
  if (
    !entity ||
    !mineableState ||
    toInt(mineableState.remainingQuantity, 0) <= 0 ||
    (interactionSource && !canEntitiesInteractLocally(interactionSource, entity))
  ) {
    return null;
  }
  return entity;
}

function resolveFleetInteractionSource(scene, fleetRecord, referenceEntity = null) {
  if (!scene) {
    return null;
  }
  for (const entityID of Array.isArray(fleetRecord && fleetRecord.minerEntityIDs)
    ? fleetRecord.minerEntityIDs
    : []) {
    const minerEntity = scene.getEntityByID(toInt(entityID, 0));
    if (minerEntity) {
      return minerEntity;
    }
  }
  if (referenceEntity) {
    return referenceEntity;
  }
  return scene.getEntityByID(toInt(fleetRecord && fleetRecord.targetShipID, 0));
}

function buildFleetMineableClaimCounts(scene, currentFleetRecord) {
  const claimCounts = new Map();
  const fleets = getMiningFleetsForSystem(scene && scene.systemID);
  for (const fleetRecord of fleets) {
    if (
      !fleetRecord ||
      (currentFleetRecord && toInt(fleetRecord.fleetID, 0) === toInt(currentFleetRecord.fleetID, 0))
    ) {
      continue;
    }
    const claimedTarget = resolveActiveMineableTarget(
      scene,
      fleetRecord.activeAsteroidID,
      resolveFleetInteractionSource(scene, fleetRecord),
    );
    if (!claimedTarget) {
      continue;
    }
    const claimedTargetID = toInt(claimedTarget.itemID, 0);
    claimCounts.set(
      claimedTargetID,
      toInt(claimCounts.get(claimedTargetID), 0) + 1,
    );
  }
  return claimCounts;
}

function resolveFleetMineableStaticEntities(scene, fleetRecord = null, referenceEntity = null) {
  if (!scene) {
    return [];
  }

  const getByBubbleID =
    typeof scene.getBubbleScopedStaticEntitiesForBubbleID === "function"
      ? scene.getBubbleScopedStaticEntitiesForBubbleID.bind(scene)
      : null;
  const getByPosition =
    typeof scene.getBubbleScopedStaticEntitiesForPosition === "function"
      ? scene.getBubbleScopedStaticEntitiesForPosition.bind(scene)
      : null;
  const bubbleCandidateIDs = [];
  const pushBubbleID = (bubbleID) => {
    const normalizedBubbleID = toInt(bubbleID, 0);
    if (normalizedBubbleID > 0 && !bubbleCandidateIDs.includes(normalizedBubbleID)) {
      bubbleCandidateIDs.push(normalizedBubbleID);
    }
  };

  const interactionSource = resolveFleetInteractionSource(
    scene,
    fleetRecord,
    referenceEntity,
  );
  const activeTarget = resolveActiveMineableTarget(
    scene,
    fleetRecord && fleetRecord.activeAsteroidID,
    interactionSource,
  );
  pushBubbleID(activeTarget && activeTarget.bubbleID);
  const targetShipEntity =
    scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(toInt(fleetRecord && fleetRecord.targetShipID, 0))
      : null;
  pushBubbleID(targetShipEntity && targetShipEntity.bubbleID);
  pushBubbleID(referenceEntity && referenceEntity.bubbleID);
  for (const minerEntityID of Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []) {
    const minerEntity =
      scene && typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(minerEntityID)
        : null;
    pushBubbleID(minerEntity && minerEntity.bubbleID);
  }

  if (getByBubbleID) {
    for (const bubbleID of bubbleCandidateIDs) {
      const entities = getByBubbleID(bubbleID);
      if (Array.isArray(entities) && entities.length > 0) {
        return entities;
      }
    }
  }

  if (getByPosition) {
    const positionCandidates = [
      activeTarget && activeTarget.position,
      fleetRecord && fleetRecord.originAnchor && fleetRecord.originAnchor.position,
      targetShipEntity && targetShipEntity.position,
      referenceEntity && referenceEntity.position,
    ];
    for (const position of positionCandidates) {
      if (!position) {
        continue;
      }
      const entities = getByPosition(position);
      if (Array.isArray(entities) && entities.length > 0) {
        return entities;
      }
    }
  }

  return [...(scene.staticEntities || [])];
}

function resolveAvailableMineableTargetEntries(scene, fleetRecord = null, referenceEntity = null) {
  ensureSceneMiningState(scene);
  const interactionSource = resolveFleetInteractionSource(
    scene,
    fleetRecord,
    referenceEntity,
  );
  return resolveFleetMineableStaticEntities(scene, fleetRecord, referenceEntity)
    .filter((entity) => (
      isMineableStaticEntity(entity) &&
      (!interactionSource || canEntitiesInteractLocally(interactionSource, entity))
    ))
    .map((entity) => ({
      entity,
      state: getMineableState(scene, entity.itemID),
    }))
    .filter((entry) => entry.state && toInt(entry.state.remainingQuantity, 0) > 0);
}

function getFleetMinerAssignmentMap(fleetRecord) {
  if (!fleetRecord || typeof fleetRecord !== "object") {
    return {};
  }
  if (
    !fleetRecord.assignedAsteroidIDsByMinerID ||
    typeof fleetRecord.assignedAsteroidIDsByMinerID !== "object"
  ) {
    fleetRecord.assignedAsteroidIDsByMinerID = {};
  }
  return fleetRecord.assignedAsteroidIDsByMinerID;
}

function pruneFleetMinerAssignments(scene, fleetRecord) {
  const assignmentMap = getFleetMinerAssignmentMap(fleetRecord);
  const validMinerIDs = new Set(
    (Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : [])
      .map((entityID) => toInt(entityID, 0))
      .filter((entityID) => entityID > 0),
  );
  for (const [minerEntityID, assignedAsteroidID] of Object.entries(assignmentMap)) {
    const normalizedMinerEntityID = toInt(minerEntityID, 0);
    if (!validMinerIDs.has(normalizedMinerEntityID)) {
      delete assignmentMap[minerEntityID];
      continue;
    }
    const minerEntity = scene.getEntityByID(normalizedMinerEntityID);
    if (!resolveActiveMineableTarget(scene, assignedAsteroidID, minerEntity)) {
      delete assignmentMap[minerEntityID];
    }
  }
  return assignmentMap;
}

function buildAssignedMineableClaimCounts(scene, currentFleetRecord, excludedMinerEntityID = 0) {
  const claimCounts = new Map();
  const normalizedExcludedMinerEntityID = normalizePositiveInteger(excludedMinerEntityID, 0);
  for (const fleetRecord of getMiningFleetsForSystem(scene && scene.systemID)) {
    if (
      !fleetRecord ||
      toInt(fleetRecord.fleetID, 0) === toInt(currentFleetRecord && currentFleetRecord.fleetID, 0)
    ) {
      continue;
    }
    const assignmentMap = pruneFleetMinerAssignments(scene, fleetRecord);
    for (const [minerEntityID, assignedAsteroidID] of Object.entries(assignmentMap)) {
      if (toInt(minerEntityID, 0) === normalizedExcludedMinerEntityID) {
        continue;
      }
      const minerEntity = scene.getEntityByID(toInt(minerEntityID, 0));
      const targetEntity = resolveActiveMineableTarget(
        scene,
        assignedAsteroidID,
        minerEntity,
      );
      if (!targetEntity) {
        continue;
      }
      const targetID = toInt(targetEntity.itemID, 0);
      claimCounts.set(targetID, toInt(claimCounts.get(targetID), 0) + 1);
    }
  }
  return claimCounts;
}

function getMineableClaimPenaltyMeters() {
  return Math.max(
    0,
    toFiniteNumber(
      config.miningNpcFleetTargetClaimPenaltyMeters,
      7_500,
    ),
  );
}

function scoreMineableTargetEntry(entry, referencePosition, claimCounts) {
  const targetID = toInt(entry && entry.entity && entry.entity.itemID, 0);
  const claimCount = claimCounts instanceof Map ? toInt(claimCounts.get(targetID), 0) : 0;
  const distanceMeters = distance(entry && entry.entity && entry.entity.position, referencePosition);
  return (
    distanceMeters +
    (claimCount * getMineableClaimPenaltyMeters())
  );
}

function buildMineableTargetSelectionSnapshots(
  scene,
  minerEntity,
  candidates,
  referencePosition,
  claimCounts,
) {
  const preferredDistanceMeters = Math.max(
    0,
    getEntityTargetLockRangeMeters(scene, minerEntity),
  );
  return candidates.map((entry) => {
    const targetID = toInt(entry && entry.entity && entry.entity.itemID, 0);
    const claimCount = claimCounts instanceof Map ? toInt(claimCounts.get(targetID), 0) : 0;
    const distanceMeters = distance(entry && entry.entity && entry.entity.position, referencePosition);
    return {
      entry,
      targetID,
      claimCount,
      distanceMeters,
      localPreferred:
        preferredDistanceMeters <= 0 ||
        distanceMeters <= preferredDistanceMeters,
      score: scoreMineableTargetEntry(entry, referencePosition, claimCounts),
    };
  });
}

function compareMineableTargetSelectionSnapshots(left, right) {
  const scoreDelta = toFiniteNumber(left && left.score, 0) - toFiniteNumber(right && right.score, 0);
  if (Math.abs(scoreDelta) > 0.000001) {
    return scoreDelta;
  }

  const quantityDelta =
    toInt(right && right.entry && right.entry.state && right.entry.state.remainingQuantity, 0) -
    toInt(left && left.entry && left.entry.state && left.entry.state.remainingQuantity, 0);
  if (quantityDelta !== 0) {
    return quantityDelta;
  }

  return toInt(left && left.targetID, 0) - toInt(right && right.targetID, 0);
}

function isMiningSnapshotCompatibleWithEntry(snapshot, entry, hooks = {}) {
  if (!snapshot || !entry || !entry.state) {
    return false;
  }
  if (typeof hooks.isMiningSnapshotCompatibleWithState === "function") {
    return hooks.isMiningSnapshotCompatibleWithState(snapshot, entry.state) === true;
  }
  if (snapshot.family === "gas") {
    return entry.state.yieldKind === "gas";
  }
  if (snapshot.family === "ice") {
    return entry.state.yieldKind === "ice";
  }
  return entry.state.yieldKind === "ore";
}

function chooseMineableTargetForMiner(
  scene,
  fleetRecord,
  minerEntity,
  availableTargetEntries,
  claimCounts,
  miningSnapshot = null,
  hooks = {},
) {
  if (!scene || !fleetRecord || !minerEntity) {
    return null;
  }

  const assignmentMap = getFleetMinerAssignmentMap(fleetRecord);
  const candidates = Array.isArray(availableTargetEntries)
    ? (
      miningSnapshot
        ? availableTargetEntries.filter((entry) => isMiningSnapshotCompatibleWithEntry(miningSnapshot, entry, hooks))
        : availableTargetEntries
    ).filter((entry) => (
      entry &&
      entry.entity &&
      canEntitiesInteractLocally(minerEntity, entry.entity)
    ))
    : [];
  if (candidates.length <= 0) {
    delete assignmentMap[toInt(minerEntity.itemID, 0)];
    return null;
  }

  const referencePosition = minerEntity.position || buildFleetReferencePosition(scene, fleetRecord);
  const selectionSnapshots = buildMineableTargetSelectionSnapshots(
    scene,
    minerEntity,
    candidates,
    referencePosition,
    claimCounts,
  );
  const currentAssignedTarget = resolveActiveMineableTarget(
    scene,
    assignmentMap[toInt(minerEntity.itemID, 0)],
    minerEntity,
  );
  const currentSelection = currentAssignedTarget
    ? selectionSnapshots.find((snapshot) => snapshot.targetID === toInt(currentAssignedTarget.itemID, 0)) || null
    : null;

  const preferredLocalUnclaimed = selectionSnapshots
    .filter((snapshot) => snapshot.localPreferred === true && snapshot.claimCount <= 0)
    .sort(compareMineableTargetSelectionSnapshots)[0] || null;
  const preferredLocalClaimed = selectionSnapshots
    .filter((snapshot) => snapshot.localPreferred === true && snapshot.claimCount > 0)
    .sort(compareMineableTargetSelectionSnapshots)[0] || null;
  const fallbackGlobalUnclaimed = selectionSnapshots
    .filter((snapshot) => snapshot.claimCount <= 0)
    .sort(compareMineableTargetSelectionSnapshots)[0] || null;
  const fallbackGlobalClaimed = selectionSnapshots
    .filter((snapshot) => snapshot.claimCount > 0)
    .sort(compareMineableTargetSelectionSnapshots)[0] || null;
  const bestSelection =
    preferredLocalUnclaimed ||
    preferredLocalClaimed ||
    fallbackGlobalUnclaimed ||
    fallbackGlobalClaimed ||
    null;

  if (currentSelection && bestSelection) {
    const keepCurrentAssignment =
      currentSelection.localPreferred === true ||
      compareMineableTargetSelectionSnapshots(currentSelection, bestSelection) <= 0;
    if (keepCurrentAssignment) {
      if (claimCounts instanceof Map) {
        claimCounts.set(
          currentSelection.targetID,
          toInt(claimCounts.get(currentSelection.targetID), 0) + 1,
        );
      }
      return currentAssignedTarget;
    }
  }

  const chosenEntry = bestSelection && bestSelection.entry ? bestSelection.entry : null;
  if (!chosenEntry || !chosenEntry.entity) {
    return null;
  }

  const chosenTargetID = toInt(chosenEntry.entity.itemID, 0);
  assignmentMap[toInt(minerEntity.itemID, 0)] = chosenTargetID;
  if (claimCounts instanceof Map) {
    claimCounts.set(chosenTargetID, toInt(claimCounts.get(chosenTargetID), 0) + 1);
  }
  return chosenEntry.entity;
}

function getEntityTargetLockRangeMeters(scene, entity) {
  if (!scene || !entity || typeof scene.getEntityTargetingStats !== "function") {
    return 0;
  }
  const targetingStats = scene.getEntityTargetingStats(entity);
  return Math.max(0, toFiniteNumber(targetingStats && targetingStats.maxTargetRange, 0));
}

function getMiningEngagementRangeMeters(scene, entity, primarySnapshot, rangeBufferMeters) {
  const miningRangeMeters = Math.max(
    0,
    toFiniteNumber(primarySnapshot && primarySnapshot.maxRangeMeters, 0) - Math.max(0, toFiniteNumber(rangeBufferMeters, 0)),
  );
  const lockRangeMeters = Math.max(
    0,
    getEntityTargetLockRangeMeters(scene, entity) - Math.max(0, toFiniteNumber(rangeBufferMeters, 0)),
  );
  if (lockRangeMeters <= 0) {
    return miningRangeMeters;
  }
  if (miningRangeMeters <= 0) {
    return lockRangeMeters;
  }
  return Math.min(miningRangeMeters, lockRangeMeters);
}

function chooseFleetMineableTarget(scene, fleetRecord, hooks = {}) {
  ensureSceneMiningState(scene);
  const interactionSource = resolveFleetInteractionSource(scene, fleetRecord);

  const currentTarget = resolveActiveMineableTarget(
    scene,
    fleetRecord && fleetRecord.activeAsteroidID,
    interactionSource,
  );
  if (currentTarget) {
    return currentTarget;
  }

  const assignmentMap = pruneFleetMinerAssignments(scene, fleetRecord);
  const assignmentCounts = new Map();
  for (const assignedAsteroidID of Object.values(assignmentMap)) {
    const assignedTarget = resolveActiveMineableTarget(
      scene,
      assignedAsteroidID,
      interactionSource,
    );
    if (!assignedTarget) {
      continue;
    }
    const assignedTargetID = toInt(assignedTarget.itemID, 0);
    assignmentCounts.set(
      assignedTargetID,
      toInt(assignmentCounts.get(assignedTargetID), 0) + 1,
    );
  }
  const assignedPrimaryTargetID = [...assignmentCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0];
  if (assignedPrimaryTargetID && assignedPrimaryTargetID[0] > 0) {
    const assignedPrimaryTarget = resolveActiveMineableTarget(
      scene,
      assignedPrimaryTargetID[0],
      interactionSource,
    );
    if (assignedPrimaryTarget) {
      return assignedPrimaryTarget;
    }
  }

  const candidates = resolveAvailableMineableTargetEntries(scene, fleetRecord);
  if (candidates.length <= 0) {
    return typeof hooks.chooseMineableTargetForFleet === "function"
      ? hooks.chooseMineableTargetForFleet(scene, fleetRecord)
      : null;
  }

  const claimCounts = buildFleetMineableClaimCounts(scene, fleetRecord);
  const referencePosition = buildFleetReferencePosition(scene, fleetRecord);
  candidates.sort((left, right) => {
    const leftClaims = toInt(claimCounts.get(toInt(left && left.entity && left.entity.itemID, 0)), 0);
    const rightClaims = toInt(claimCounts.get(toInt(right && right.entity && right.entity.itemID, 0)), 0);
    if (leftClaims !== rightClaims) {
      return leftClaims - rightClaims;
    }

    const distanceDelta =
      distance(left && left.entity && left.entity.position, referencePosition) -
      distance(right && right.entity && right.entity.position, referencePosition);
    if (Math.abs(distanceDelta) > 0.000001) {
      return distanceDelta;
    }

    const quantityDelta =
      toInt(right && right.state && right.state.remainingQuantity, 0) -
      toInt(left && left.state && left.state.remainingQuantity, 0);
    if (quantityDelta !== 0) {
      return quantityDelta;
    }

    return toInt(left && left.entity && left.entity.itemID, 0) -
      toInt(right && right.entity && right.entity.itemID, 0);
  });

  return candidates[0] ? candidates[0].entity : null;
}

function clearStaleMineableTargetLocks(scene, entity, targetEntityID, hooks = {}) {
  if (!scene || !entity) {
    return 0;
  }

  const normalizedTargetID = normalizePositiveInteger(targetEntityID, 0);
  const getTargets =
    typeof hooks.getTargetsForEntity === "function"
      ? hooks.getTargetsForEntity
      : (runtimeScene, runtimeEntity) => (
        runtimeScene && typeof runtimeScene.getTargetsForEntity === "function"
          ? runtimeScene.getTargetsForEntity(runtimeEntity)
          : []
      );
  const lockedTargetIDs = Array.isArray(getTargets(scene, entity))
    ? getTargets(scene, entity)
    : [];

  let clearedCount = 0;
  for (const lockedTargetID of lockedTargetIDs) {
    const normalizedLockedTargetID = normalizePositiveInteger(lockedTargetID, 0);
    if (
      normalizedLockedTargetID <= 0 ||
      normalizedLockedTargetID === normalizedTargetID
    ) {
      continue;
    }
    const lockedTargetEntity =
      typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(normalizedLockedTargetID)
        : null;
    if (
      !isMineableStaticEntity(lockedTargetEntity) &&
      !getMineableState(scene, normalizedLockedTargetID)
    ) {
      continue;
    }
    if (
      typeof scene.removeLockedTarget === "function" &&
      scene.removeLockedTarget(entity, normalizedLockedTargetID, {
        notifySelf: false,
        notifyTarget: false,
        reason: null,
      })
    ) {
      clearedCount += 1;
    }
  }

  if (
    typeof scene.getSortedPendingTargetLocks === "function" &&
    typeof scene.cancelPendingTargetLock === "function"
  ) {
    for (const pendingLock of scene.getSortedPendingTargetLocks(entity) || []) {
      const pendingTargetID = normalizePositiveInteger(pendingLock && pendingLock.targetID, 0);
      if (
        pendingTargetID <= 0 ||
        pendingTargetID === normalizedTargetID
      ) {
        continue;
      }
      const pendingTargetEntity =
        typeof scene.getEntityByID === "function"
          ? scene.getEntityByID(pendingTargetID)
          : null;
      if (
        !isMineableStaticEntity(pendingTargetEntity) &&
        !getMineableState(scene, pendingTargetID)
      ) {
        continue;
      }
      if (scene.cancelPendingTargetLock(entity, pendingTargetID, {
        notifySelf: false,
      })) {
        clearedCount += 1;
      }
    }
  }

  return clearedCount;
}

function syncMiningTargetLock(scene, entity, targetEntity, now, hooks = {}) {
  if (!scene || !entity || !targetEntity) {
    return {
      success: false,
      errorMsg: "TARGET_NOT_FOUND",
    };
  }

  clearStaleMineableTargetLocks(scene, entity, targetEntity.itemID, hooks);

  const getTargets =
    typeof hooks.getTargetsForEntity === "function"
      ? hooks.getTargetsForEntity
      : (runtimeScene, runtimeEntity) => (
        runtimeScene && typeof runtimeScene.getTargetsForEntity === "function"
          ? runtimeScene.getTargetsForEntity(runtimeEntity)
          : []
      );
  const normalizedTargetID = toInt(targetEntity.itemID, 0);
  const lockedTargets = Array.isArray(getTargets(scene, entity)) ? getTargets(scene, entity) : [];
  if (lockedTargets.includes(normalizedTargetID)) {
    return {
      success: true,
      data: {
        pending: false,
        targets: lockedTargets,
      },
    };
  }

  if (typeof scene.finalizeTargetLock !== "function") {
    return {
      success: false,
      errorMsg: "TARGET_LOCK_UNSUPPORTED",
    };
  }

  let lockResult = scene.finalizeTargetLock(entity, targetEntity, {
    nowMs: now,
  });
  if (
    (!lockResult || lockResult.success !== true) &&
    lockResult &&
    lockResult.errorMsg === "TARGET_LOCK_LIMIT_REACHED"
  ) {
    clearStaleMineableTargetLocks(scene, entity, 0, hooks);
    lockResult = scene.finalizeTargetLock(entity, targetEntity, {
      nowMs: now,
    });
  }

  return lockResult || {
    success: false,
    errorMsg: "TARGET_LOCK_FAILED",
  };
}

function normalizePositiveInteger(value, fallback = null) {
  const numeric = toInt(value, 0);
  return numeric > 0 ? numeric : fallback;
}

function parseAmount(value) {
  const text = String(value || "")
    .trim()
    .replace(/,/g, "")
    .replace(/_/g, "");
  if (!text) {
    return null;
  }

  const match = /^(-?\d+(?:\.\d+)?)([kmbt])?$/i.exec(text);
  if (!match) {
    return null;
  }

  const baseValue = Number(match[1]);
  if (!Number.isFinite(baseValue)) {
    return null;
  }

  const multiplier = {
    k: 1_000,
    m: 1_000_000,
    b: 1_000_000_000,
    t: 1_000_000_000_000,
  };
  const suffix = String(match[2] || "").toLowerCase();
  return baseValue * (multiplier[suffix] || 1);
}

function parseNpcSpawnArguments(argumentText, defaultAmount = 1) {
  const trimmed = String(argumentText || "").trim();
  if (!trimmed) {
    return {
      success: true,
      amount: defaultAmount,
      query: "",
    };
  }

  const parts = trimmed.split(/\s+/);
  let amount = defaultAmount;
  let amountIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    const parsed = parseAmount(parts[index]);
    if (parsed === null) {
      continue;
    }
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return {
        success: false,
        errorMsg: "INVALID_AMOUNT",
      };
    }
    amount = parsed;
    amountIndex = index;
    break;
  }

  return {
    success: true,
    amount,
    query: amountIndex >= 0
      ? parts.filter((_, index) => index !== amountIndex).join(" ").trim()
      : trimmed,
  };
}

function buildMiningWarpLandingPoint(center, index = 0, total = 1, radiusMeters = DEFAULT_MINING_FLEET_SPREAD_METERS) {
  const divisor = Math.max(1, toInt(total, 1));
  const angle = ((Math.PI * 2) / divisor) * Math.max(0, index);
  const resolvedRadius = Math.max(0, toFiniteNumber(radiusMeters, DEFAULT_MINING_FLEET_SPREAD_METERS));
  return {
    x: toFiniteNumber(center && center.x, 0) + (Math.cos(angle) * resolvedRadius),
    y: toFiniteNumber(center && center.y, 0),
    z: toFiniteNumber(center && center.z, 0) + (Math.sin(angle) * resolvedRadius),
  };
}

function buildOffgridOriginAnchor(scene, target) {
  return findSafeWarpOriginAnchor(scene, target, {
    clearanceMeters: Math.max(
      ONE_AU_IN_METERS,
      toFiniteNumber(config.miningNpcWarpOriginClearanceMeters, ONE_AU_IN_METERS),
    ),
    minDistanceMeters: toFiniteNumber(
      config.miningNpcWarpOriginMinDistanceMeters,
      ONE_AU_IN_METERS * 2,
    ),
    maxDistanceMeters: toFiniteNumber(
      config.miningNpcWarpOriginMaxDistanceMeters,
      ONE_AU_IN_METERS * 4,
    ),
    stepMeters: toFiniteNumber(
      config.miningNpcWarpOriginStepMeters,
      ONE_AU_IN_METERS / 2,
    ),
  });
}

function parseSystemIdList(value) {
  return [...new Set(
    String(value || "")
      .split(/[,\s]+/u)
      .map((entry) => toInt(entry, 0))
      .filter((entry) => entry > 0),
  )];
}

function getSecurityBandForSystemID(systemID) {
  const systemRecord = worldData.getSolarSystemByID(
    normalizePositiveInteger(systemID, 0),
  );
  const securityStatus = toFiniteNumber(
    systemRecord && (systemRecord.securityStatus ?? systemRecord.security),
    0,
  );
  if (securityStatus >= 0.45) {
    return "highsec";
  }
  if (securityStatus >= 0) {
    return "lowsec";
  }
  return "nullsec";
}

function getSecurityBandForScene(scene, fallbackSystemID = 0) {
  const systemID = normalizePositiveInteger(
    scene && scene.systemID,
    normalizePositiveInteger(fallbackSystemID, 0),
  );
  return getSecurityBandForSystemID(systemID);
}

function resolveConfiguredBandQuery(scene, explicitQuery, options = {}) {
  const trimmedExplicitQuery = String(explicitQuery || "").trim();
  if (trimmedExplicitQuery) {
    return trimmedExplicitQuery;
  }

  const configValue = String(
    options.configValue ||
    "",
  ).trim();
  if (configValue) {
    return configValue;
  }

  const securityBand = getSecurityBandForScene(scene, options.systemID);
  const bandConfigValues = options.bandConfigValues && typeof options.bandConfigValues === "object"
    ? options.bandConfigValues
    : {};
  const bandDefaultValues = options.bandDefaultValues && typeof options.bandDefaultValues === "object"
    ? options.bandDefaultValues
    : {};
  const configuredBandValue = String(bandConfigValues[securityBand] || "").trim();
  if (configuredBandValue) {
    return configuredBandValue;
  }

  return String(
    bandDefaultValues[securityBand] ||
    options.fallbackQuery ||
    "",
  ).trim();
}

function buildSpawnTarget(scene, session = null) {
  const shipID = normalizePositiveInteger(session && session._space && session._space.shipID, 0);
  if (shipID) {
    const shipEntity = scene.getEntityByID(shipID);
    if (shipEntity && shipEntity.position) {
      return shipEntity;
    }
  }

  const asteroidEntity = (Array.isArray(scene && scene.staticEntities) ? scene.staticEntities : [])
    .find((entity) => {
      if (!entity || entity.kind !== "asteroid" || !entity.position) {
        return false;
      }
      const scope = resolveEntityInteractionScope(entity);
      return scope.valid && !scope.scoped;
    });
  if (asteroidEntity) {
    return asteroidEntity;
  }

  return {
    position: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 },
    radius: 0,
  };
}

function applyPassiveMiningFleetOverrides(entityID, options = {}) {
  npcService.setBehaviorOverrides(entityID, {
    autoAggro: false,
    autoActivateWeapons: false,
    autoAggroTargetClasses: [],
    targetPreference: "none",
    movementMode: String(options.movementMode || "orbit"),
    orbitDistanceMeters: Math.max(
      100,
      toFiniteNumber(options.orbitDistanceMeters, 1_200),
    ),
    followRangeMeters: Math.max(
      100,
      toFiniteNumber(options.followRangeMeters, 800),
    ),
    idleAnchorOrbit: options.idleAnchorOrbit === true,
    idleAnchorOrbitDistanceMeters: Math.max(
      100,
      toFiniteNumber(options.idleAnchorOrbitDistanceMeters, 1_200),
    ),
    returnToHomeWhenIdle: options.returnToHomeWhenIdle === true,
    leashRangeMeters: Math.max(0, toFiniteNumber(options.leashRangeMeters, 0)),
  });
  const controller = npcService.getControllerByEntityID(entityID);
  if (options.clearCombatPreference !== false) {
    if (controller) {
      controller.preferredTargetID = 0;
      controller.currentTargetID = 0;
      controller.lastAggressorID = 0;
    }
  }
  if (options.issueStopOrder !== false) {
    npcService.issueManualOrder(entityID, {
      type: "stop",
    });
  } else {
    if (controller) {
      controller.manualOrder = null;
      controller.nextThinkAtMs = Number.MAX_SAFE_INTEGER;
    }
  }
}

function getNormalizedManualOrderSignature(order) {
  if (!order || typeof order !== "object") {
    return null;
  }
  return {
    type: String(order.type || "").trim().toLowerCase() || null,
    targetID: normalizePositiveInteger(order.targetID, 0),
    movementMode: String(order.movementMode || "").trim().toLowerCase() || null,
    orbitDistanceMeters: Math.max(0, toFiniteNumber(order.orbitDistanceMeters, 0)),
    followRangeMeters: Math.max(0, toFiniteNumber(order.followRangeMeters, 0)),
    allowWeapons:
      order.allowWeapons === undefined || order.allowWeapons === null
        ? null
        : order.allowWeapons === true,
    keepLock:
      order.keepLock === undefined || order.keepLock === null
        ? null
        : order.keepLock === true,
  };
}

function areManualOrdersEquivalent(leftOrder, rightOrder) {
  const leftSignature = getNormalizedManualOrderSignature(leftOrder);
  const rightSignature = getNormalizedManualOrderSignature(rightOrder);
  if (!leftSignature && !rightSignature) {
    return true;
  }
  if (!leftSignature || !rightSignature) {
    return false;
  }
  return (
    leftSignature.type === rightSignature.type &&
    leftSignature.targetID === rightSignature.targetID &&
    leftSignature.movementMode === rightSignature.movementMode &&
    Math.abs(leftSignature.orbitDistanceMeters - rightSignature.orbitDistanceMeters) < 1 &&
    Math.abs(leftSignature.followRangeMeters - rightSignature.followRangeMeters) < 1 &&
    leftSignature.allowWeapons === rightSignature.allowWeapons &&
    leftSignature.keepLock === rightSignature.keepLock
  );
}

function syncFleetManualOrder(entityID, desiredOrder) {
  const controller = npcService.getControllerByEntityID(entityID);
  if (!controller) {
    return false;
  }
  if (areManualOrdersEquivalent(controller.manualOrder, desiredOrder)) {
    return false;
  }
  npcService.issueManualOrder(entityID, desiredOrder || null);
  npcService.wakeNpcController(entityID, 0);
  return true;
}

function clearFleetManualOrders(entityIDs = []) {
  let changedCount = 0;
  for (const entityID of Array.isArray(entityIDs) ? entityIDs : []) {
    if (syncFleetManualOrder(entityID, null)) {
      changedCount += 1;
    }
  }
  return changedCount;
}

function buildMiningMovementOrder(targetEntityID, movementMode, distanceMeters) {
  const normalizedTargetID = normalizePositiveInteger(targetEntityID, 0);
  if (!normalizedTargetID) {
    return null;
  }
  const normalizedMovementMode = String(movementMode || "orbit").trim().toLowerCase();
  return {
    type: normalizedMovementMode === "follow" ? "follow" : "orbit",
    targetID: normalizedTargetID,
    movementMode: normalizedMovementMode === "follow" ? "follow" : "orbit",
    orbitDistanceMeters:
      normalizedMovementMode === "follow"
        ? 0
        : Math.max(0, toFiniteNumber(distanceMeters, 0)),
    followRangeMeters:
      normalizedMovementMode === "follow"
        ? Math.max(0, toFiniteNumber(distanceMeters, 0))
        : 0,
    allowWeapons: false,
    keepLock: true,
  };
}

function syncMiningApproachOrder(scene, entity, targetEntity, orbitDistanceMeters) {
  if (!scene || !entity || !targetEntity) {
    return false;
  }

  const normalizedOrbitDistance = Math.max(0, toFiniteNumber(orbitDistanceMeters, 0));
  const surfaceDistanceMeters = getSurfaceDistance(entity, targetEntity);
  const sameTarget =
    toInt(entity.targetEntityID, 0) === toInt(targetEntity.itemID, 0);
  const followRangeMatchesOrbit =
    Math.abs(toFiniteNumber(entity.followRange, 0) - normalizedOrbitDistance) <= 1;
  const currentlyFollowingOrbitBand =
    entity.mode === "FOLLOW" &&
    sameTarget &&
    followRangeMatchesOrbit;
  const orbitReacquireDistanceMeters =
    normalizedOrbitDistance + Math.max(5_000, normalizedOrbitDistance * 0.5);
  const orbitSettleDistanceMeters =
    normalizedOrbitDistance + Math.max(1_000, normalizedOrbitDistance * 0.2);
  const desiredMovementMode =
    surfaceDistanceMeters > orbitReacquireDistanceMeters ||
    (
      currentlyFollowingOrbitBand &&
      surfaceDistanceMeters > orbitSettleDistanceMeters
    )
      ? "follow"
      : "orbit";

  if (desiredMovementMode === "follow") {
    return scene.followShipEntity(
      entity,
      targetEntity.itemID,
      normalizedOrbitDistance,
      {
        queueHistorySafeContract: true,
        suppressFreshAcquireReplay: true,
      },
    );
  }

  return scene.orbitShipEntity(
    entity,
    targetEntity.itemID,
    normalizedOrbitDistance,
    {
      queueHistorySafeContract: true,
      suppressFreshAcquireReplay: true,
    },
  );
}

function getNpcOreCargoItems(entity) {
  return (Array.isArray(entity && entity.nativeCargoItems) ? entity.nativeCargoItems : [])
    .filter((entry) => toInt(entry && entry.moduleID, 0) <= 0);
}

function getNpcOreCargoVolume(entity) {
  return getNpcOreCargoItems(entity).reduce((sum, entry) => {
    const quantity = Math.max(0, toInt(entry && (entry.quantity ?? entry.stacksize), 0));
    const volume = Math.max(0, toFiniteNumber(entry && entry.volume, 0));
    return sum + (quantity * volume);
  }, 0);
}

function getNpcOreCargoSummary(entity) {
  const entries = getNpcOreCargoItems(entity);
  return {
    usedVolumeM3: getNpcOreCargoVolume(entity),
    stackCount: entries.length,
    quantity: entries.reduce(
      (sum, entry) => sum + Math.max(0, toInt(entry && entry.quantity, 0)),
      0,
    ),
  };
}

function getNpcSmallestOreUnitVolumeM3(entity) {
  let smallestUnitVolumeM3 = Number.POSITIVE_INFINITY;
  for (const entry of getNpcOreCargoItems(entity)) {
    const quantity = Math.max(
      0,
      toInt(entry && (entry.quantity ?? entry.stacksize), 0),
    );
    const volume = Math.max(0, toFiniteNumber(entry && entry.volume, 0));
    if (quantity > 0 && volume > 0 && volume < smallestUnitVolumeM3) {
      smallestUnitVolumeM3 = volume;
    }
  }
  return Number.isFinite(smallestUnitVolumeM3)
    ? smallestUnitVolumeM3
    : 0;
}

function getNpcMiningCargoFullState(entity, fallbackCapacityM3 = 0) {
  const usedVolumeM3 = Math.max(0, getNpcOreCargoVolume(entity));
  const capacityM3 = Math.max(
    0,
    getNpcCargoCapacityM3(entity, fallbackCapacityM3),
  );
  const freeVolumeM3 = Math.max(0, capacityM3 - usedVolumeM3);
  const smallestUnitVolumeM3 = getNpcSmallestOreUnitVolumeM3(entity);
  const exactFull =
    capacityM3 > 0 &&
    usedVolumeM3 >= capacityM3 - MINING_CARGO_FULL_EPSILON_M3;
  const operationallyFull =
    exactFull ||
    (
      capacityM3 > 0 &&
      usedVolumeM3 > 0 &&
      smallestUnitVolumeM3 > 0 &&
      freeVolumeM3 + MINING_CARGO_FULL_EPSILON_M3 < smallestUnitVolumeM3
    );
  return {
    capacityM3,
    usedVolumeM3,
    freeVolumeM3,
    smallestUnitVolumeM3,
    exactFull,
    operationallyFull,
  };
}

function resolveNpcCargoCapacityFromResourceState(
  resourceState,
  fallbackCapacityM3 = 0,
) {
  const miningHoldCapacityM3 = Math.max(
    0,
    toFiniteNumber(resourceState && resourceState.generalMiningHoldCapacity, 0),
  );
  if (miningHoldCapacityM3 > 0) {
    return miningHoldCapacityM3;
  }

  const cargoCapacityM3 = Math.max(
    0,
    toFiniteNumber(resourceState && resourceState.cargoCapacity, 0),
  );
  const fleetHangarCapacityM3 = Math.max(
    0,
    toFiniteNumber(
      resourceState &&
        resourceState.attributes &&
        resourceState.attributes[FLEET_HANGAR_CAPACITY_ATTRIBUTE_ID],
      0,
    ),
  );
  if (fleetHangarCapacityM3 > 0) {
    return fleetHangarCapacityM3 + cargoCapacityM3;
  }
  if (cargoCapacityM3 > 0) {
    return cargoCapacityM3;
  }
  return Math.max(0, toFiniteNumber(fallbackCapacityM3, 0));
}

function buildNpcCargoResourceState(typeID, options = {}) {
  const numericTypeID = toInt(typeID, 0);
  if (numericTypeID <= 0) {
    return null;
  }
  const shipItem =
    options.shipItem && typeof options.shipItem === "object"
      ? options.shipItem
      : {
          itemID: -numericTypeID,
          typeID: numericTypeID,
          quantity: 1,
          stacksize: 1,
          singleton: 1,
        };
  try {
    return buildShipResourceState(0, shipItem, {
      fittedItems: Array.isArray(options.fittedItems)
        ? options.fittedItems
        : [],
      skillMap: options.skillMap instanceof Map
        ? options.skillMap
        : new Map(),
      includeActiveImplantModifiers: false,
    });
  } catch (error) {
    log.warn(
      `[MiningFleet] dogma cargo capacity resolution failed type=${numericTypeID}: ` +
      String(error && error.message || error),
    );
    return null;
  }
}

function getNpcCargoCapacityM3ForTypeID(
  typeID,
  fallbackCapacityM3,
  options = {},
) {
  const numericTypeID = toInt(typeID, 0);
  const rawMiningHoldCapacityM3 = Math.max(
    0,
    toFiniteNumber(
      getTypeAttributeValue(numericTypeID, "generalMiningHoldCapacity"),
      0,
    ),
  );
  const skillMap =
    options.skillMap instanceof Map ? options.skillMap : new Map();
  const resourceState = buildNpcCargoResourceState(numericTypeID, options);
  if (rawMiningHoldCapacityM3 > 0) {
    // A type-only query must return the literal SDE base. Governed NPCs with
    // authored skills receive the dogma-adjusted mining hold instead.
    if (skillMap.size <= 0) {
      return rawMiningHoldCapacityM3;
    }
    const adjustedMiningHoldCapacityM3 = Math.max(
      0,
      toFiniteNumber(
        resourceState && resourceState.generalMiningHoldCapacity,
        0,
      ),
    );
    return adjustedMiningHoldCapacityM3 > 0
      ? adjustedMiningHoldCapacityM3
      : rawMiningHoldCapacityM3;
  }

  const dogmaCapacityM3 = resolveNpcCargoCapacityFromResourceState(
    resourceState,
    0,
  );
  if (dogmaCapacityM3 > 0) {
    return dogmaCapacityM3;
  }

  const itemType = resolveItemByTypeID(numericTypeID) || null;
  const registryCapacityM3 = Math.max(
    0,
    toFiniteNumber(
      getTypeAttributeValue(numericTypeID, "capacity"),
      toFiniteNumber(itemType && itemType.capacity, 0),
    ),
  );
  return registryCapacityM3 > 0
    ? registryCapacityM3
    : Math.max(0, toFiniteNumber(fallbackCapacityM3, 0));
}

function getNpcCargoCapacityM3(entity, fallbackCapacityM3) {
  if (!entity || typeof entity !== "object") {
    return Math.max(0, toFiniteNumber(fallbackCapacityM3, 0));
  }
  const fittedItems = getNpcFittedModuleItems(entity);
  const skillMap =
    entity.skillMap instanceof Map ? entity.skillMap : new Map();
  const fittedSignature = fittedItems
    .map((item) => [
      toInt(item && item.typeID, 0),
      toInt(item && item.flagID, 0),
      isModuleOnline(item) ? 1 : 0,
    ].join(":"))
    .sort()
    .join("|");
  const cached = miningCargoCapacitySnapshotByEntity.get(entity);
  if (
    cached &&
    cached.typeID === toInt(entity.typeID, 0) &&
    cached.fittedSignature === fittedSignature &&
    cached.skillMap === skillMap
  ) {
    return cached.capacityM3;
  }

  const capacityM3 = getNpcCargoCapacityM3ForTypeID(
    toInt(entity.typeID, 0),
    fallbackCapacityM3,
    {
      shipItem: entity,
      fittedItems,
      skillMap,
    },
  );
  miningCargoCapacitySnapshotByEntity.set(entity, {
    typeID: toInt(entity.typeID, 0),
    fittedSignature,
    skillMap,
    capacityM3,
  });
  return capacityM3;
}

function estimateNpcMiningVolume(options = {}) {
  const shipTypeID = toInt(options.shipTypeID, 0);
  const durationMs = Math.max(0, toInt(options.durationMs, 0));
  const resourceFamily =
    String(options.resourceFamily || "ore").trim().toLowerCase() || "ore";
  const supportBonus =
    options.supportBonus && typeof options.supportBonus === "object"
      ? options.supportBonus
      : {};
  const cycleTimeMultiplier = Math.max(
    0.5,
    Math.min(1, toFiniteNumber(supportBonus.cycleTimeMultiplier, 1)),
  );
  if (shipTypeID <= 0 || durationMs <= 0) {
    return {
      shipTypeID,
      durationMs,
      capacityM3: 0,
      estimatedVolumeM3: 0,
      moduleCycles: [],
    };
  }

  const fittedItems = [];
  const skillMap = options.skillMap instanceof Map ? options.skillMap : new Map();
  let itemNumber = 2;
  for (const entry of Array.isArray(options.modules) ? options.modules : []) {
    const typeID = toInt(entry && entry.typeID, 0);
    const quantity = Math.max(0, toInt(entry && entry.quantity, 0));
    const moduleType = resolveItemByTypeID(typeID) || {};
    for (let index = 0; typeID > 0 && index < quantity; index += 1) {
      fittedItems.push({
        itemID: -itemNumber,
        typeID,
        itemName: String(moduleType.name || moduleType.typeName || ""),
        quantity: 1,
        stacksize: 1,
        singleton: 1,
        flagID: 26 + itemNumber,
        online: true,
      });
      itemNumber += 1;
    }
  }

  const shipItem = {
    itemID: -1,
    typeID: shipTypeID,
    quantity: 1,
    stacksize: 1,
    singleton: 1,
  };
  const moduleCycles = fittedItems
    .map((moduleItem) => {
      const snapshot = buildMiningModuleSnapshot({
        shipItem,
        moduleItem,
        effectRecord: null,
        fittedItems,
        skillMap,
      });
      if (!snapshot || snapshot.family !== resourceFamily) {
        return null;
      }
      const cycleDurationMs = Math.max(
        1,
        snapshot.durationMs * cycleTimeMultiplier,
      );
      const cycles = Math.max(0, Math.floor(durationMs / cycleDurationMs));
      return {
        moduleTypeID: snapshot.moduleTypeID,
        resourceFamily,
        cycleDurationMs,
        yieldPerCycleM3: snapshot.miningAmountM3,
        cycles,
        volumeM3: cycles * snapshot.miningAmountM3,
      };
    })
    .filter(Boolean);
  const capacityM3 = Math.max(
    0,
    toFiniteNumber(
      options.capacityM3,
      getNpcCargoCapacityM3ForTypeID(
        shipTypeID,
        toFiniteNumber(
          config.miningNpcMinerCargoCapacityM3,
          DEFAULT_MINING_MINER_CARGO_CAPACITY_M3,
        ),
        { shipItem, fittedItems, skillMap },
      ),
    ),
  );
  const rawVolumeM3 = moduleCycles.reduce(
    (sum, entry) => sum + toFiniteNumber(entry.volumeM3, 0),
    0,
  );
  return {
    shipTypeID,
    durationMs,
    resourceFamily,
    capacityM3,
    estimatedVolumeM3: Math.min(capacityM3, rawVolumeM3),
    supportBonus:
      Object.keys(supportBonus).length > 0
        ? {
            supportClass: String(
              supportBonus.supportClass || "industrial_command",
            ),
            cycleTimeMultiplier,
            rangeMultiplier: Math.max(
              1,
              toFiniteNumber(supportBonus.rangeMultiplier, 1),
            ),
          }
        : null,
    moduleCycles,
  };
}

function getFleetCargoState(scene, fleetRecord) {
  const minerEntities = (Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : [])
    .map((entityID) => scene.getEntityByID(entityID))
    .filter(Boolean);
  const haulerEntities = (Array.isArray(fleetRecord && fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : [])
    .map((entityID) => scene.getEntityByID(entityID))
    .filter(Boolean);
  const minerCapacityPerHull = Math.max(
    0,
    toFiniteNumber(
      config.miningNpcMinerCargoCapacityM3,
      DEFAULT_MINING_MINER_CARGO_CAPACITY_M3,
    ),
  );
  const haulerCapacityPerHull = Math.max(
    0,
    toFiniteNumber(
      config.miningNpcHaulerCargoCapacityM3,
      DEFAULT_MINING_HAULER_CARGO_CAPACITY_M3,
    ),
  );

  const minerUsedVolumeM3 = minerEntities.reduce(
    (sum, entity) => sum + getNpcOreCargoVolume(entity),
    0,
  );
  const minerCapacityM3 = minerEntities.reduce(
    (sum, entity) => sum + getNpcCargoCapacityM3(entity, minerCapacityPerHull),
    0,
  );
  const haulerCapacityM3 = haulerEntities.reduce(
    (sum, entity) => sum + getNpcCargoCapacityM3(entity, haulerCapacityPerHull),
    0,
  );

  return {
    minerUsedVolumeM3,
    minerCapacityM3,
    haulerCapacityM3,
    minerFillRatio:
      minerCapacityM3 > 0
        ? minerUsedVolumeM3 / minerCapacityM3
        : 0,
  };
}

function getFleetEntityIDs(fleetRecord, options = {}) {
  const includeResponse = options.includeResponse === true;
  return [
    ...(Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []),
    ...(Array.isArray(fleetRecord && fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : []),
    ...(includeResponse && Array.isArray(fleetRecord && fleetRecord.responseEntityIDs)
      ? fleetRecord.responseEntityIDs
      : []),
  ]
    .map((entityID) => normalizePositiveInteger(entityID, null))
    .filter(Boolean);
}

function getFleetEntities(scene, fleetRecord, options = {}) {
  if (!scene) {
    return [];
  }
  return getFleetEntityIDs(fleetRecord, options)
    .map((entityID) => scene.getEntityByID(entityID))
    .filter(Boolean);
}

function isFleetWarpInProgress(scene, fleetRecord) {
  return getFleetEntities(scene, fleetRecord).some((entity) => (
    entity.mode === "WARP" ||
    Boolean(entity.pendingWarp) ||
    Boolean(entity.warpState) ||
    Boolean(entity.sessionlessWarpIngress)
  ));
}

function resolveFleetRepresentativeNpcEntity(scene, fleetRecord) {
  return getFleetEntities(scene, fleetRecord)
    .find((entity) => entity && entity.kind === "ship") || null;
}

function getAggressionMemoryMs() {
  return Math.max(
    0,
    toInt(
      config.miningNpcAggressionMemoryMs,
      DEFAULT_MINING_AGGRESSION_MEMORY_MS,
    ),
  );
}

function getResponseCooldownMs() {
  return Math.max(
    0,
    toInt(
      config.miningNpcResponseCooldownMs,
      DEFAULT_MINING_RESPONSE_COOLDOWN_MS,
    ),
  );
}

function getResponseRetreatDelayMs() {
  return Math.max(
    0,
    toInt(
      config.miningNpcResponseRetreatDelayMs,
      DEFAULT_MINING_RESPONSE_RETREAT_DELAY_MS,
    ),
  );
}

function getHaulerInitialDelayMs() {
  return Math.max(
    0,
    toInt(
      config.miningNpcHaulerInitialDelayMs,
      DEFAULT_MINING_HAULER_INITIAL_DELAY_MS,
    ),
  );
}

function getHaulerRepeatDelayMs() {
  return Math.max(
    0,
    toInt(
      config.miningNpcHaulerRepeatDelayMs,
      DEFAULT_MINING_HAULER_REPEAT_DELAY_MS,
    ),
  );
}

function resolveMiningFleetQuery(scene, explicitQuery = "", systemID = 0) {
  return resolveConfiguredBandQuery(scene, explicitQuery, {
    systemID,
    configValue: config.miningNpcFleetProfileOrPool,
    bandConfigValues: {
      highsec: config.miningNpcFleetHighSecProfileOrPool,
      lowsec: config.miningNpcFleetLowSecProfileOrPool,
      nullsec: config.miningNpcFleetNullSecProfileOrPool,
    },
    bandDefaultValues: DEFAULT_MINING_FLEET_QUERY_BY_BAND,
    fallbackQuery: DEFAULT_MINING_FLEET_QUERY,
  });
}

function resolveMiningHaulerQuery(scene, explicitQuery = "", systemID = 0) {
  return resolveConfiguredBandQuery(scene, explicitQuery, {
    systemID,
    configValue: config.miningNpcHaulerProfileOrPool,
    bandConfigValues: {
      highsec: config.miningNpcHaulerHighSecProfileOrPool,
      lowsec: config.miningNpcHaulerLowSecProfileOrPool,
      nullsec: config.miningNpcHaulerNullSecProfileOrPool,
    },
    bandDefaultValues: DEFAULT_MINING_HAULER_QUERY_BY_BAND,
    fallbackQuery: DEFAULT_MINING_HAULER_QUERY,
  });
}

function getStandingResponseConfig(standingClass) {
  switch (String(standingClass || "neutral").trim().toLowerCase()) {
    case "friendly":
      return {
        profileQuery: String(config.miningNpcFriendlyResponseProfileOrPool || "").trim(),
        amount: Math.max(0, toInt(config.miningNpcFriendlyResponseCount, 0)),
      };
    case "hostile":
      return {
        profileQuery: String(
          config.miningNpcHostileResponseProfileOrPool ||
          config.miningNpcResponseProfileOrPool ||
          DEFAULT_MINING_RESPONSE_QUERY,
        ).trim(),
        amount: Math.max(
          0,
          toInt(
            config.miningNpcHostileResponseCount,
            config.miningNpcResponseDefaultCount || DEFAULT_MINING_RESPONSE_COUNT,
          ),
        ),
      };
    default:
      return {
        profileQuery: String(
          config.miningNpcNeutralResponseProfileOrPool ||
          config.miningNpcResponseProfileOrPool ||
          DEFAULT_MINING_RESPONSE_QUERY,
        ).trim(),
        amount: Math.max(
          0,
          toInt(
            config.miningNpcNeutralResponseCount,
            config.miningNpcResponseDefaultCount || DEFAULT_MINING_RESPONSE_COUNT,
          ),
        ),
      };
  }
}

function resolveResponsePlan(scene, fleetRecord, aggressorEntity, options = {}) {
  const amountOverride = normalizePositiveInteger(options.amount, null);
  const queryOverride = String(options.profileQuery || "").trim();
  const representativeNpcEntity = resolveFleetRepresentativeNpcEntity(scene, fleetRecord);
  const standingProfile =
    config.miningNpcStandingsEnabled === true && representativeNpcEntity && aggressorEntity
      ? resolveAggressorStandingProfile(aggressorEntity, representativeNpcEntity)
      : {
        characterID: 0,
        standing: 0,
        matchedOwnerID: 0,
        matchedSourceID: 0,
        ownerIDs: [],
        thresholds: null,
        standingClass: "neutral",
      };
  const configuredResponse = getStandingResponseConfig(standingProfile.standingClass);
  const resolvedAmount = Math.max(
    0,
    amountOverride !== null ? amountOverride : configuredResponse.amount,
  );
  const resolvedQuery = queryOverride || configuredResponse.profileQuery;
  return {
    amount: resolvedAmount,
    profileQuery: resolvedQuery,
    standingProfile,
  };
}

function getLatestFleetAggression(scene, fleetRecord, now = Date.now()) {
  const aggressionMemoryMs = getAggressionMemoryMs();
  let latestAggression = null;
  for (const entityID of getFleetEntityIDs(fleetRecord)) {
    const controller = npcService.getControllerByEntityID(entityID);
    if (!controller) {
      continue;
    }
    const lastAggressedAtMs = Math.max(
      0,
      toInt(controller.lastAggressedAtMs, 0),
    );
    const lastAggressorID = normalizePositiveInteger(controller.lastAggressorID, 0);
    if (
      lastAggressedAtMs <= 0 ||
      lastAggressorID <= 0 ||
      (
        aggressionMemoryMs > 0 &&
        now - lastAggressedAtMs > aggressionMemoryMs
      )
    ) {
      continue;
    }
    const aggressorEntity = scene && scene.getEntityByID(lastAggressorID);
    if (!aggressorEntity) {
      continue;
    }
    if (!latestAggression || lastAggressedAtMs > latestAggression.lastAggressedAtMs) {
      latestAggression = {
        aggressorEntity,
        aggressorEntityID: lastAggressorID,
        lastAggressedAtMs,
        controllerEntityID: entityID,
      };
    }
  }
  return latestAggression;
}

function ensureNpcCargoStoreEntry(entity, cargoItem) {
  if (!entity || !cargoItem || toInt(cargoItem.itemID, 0) <= 0) {
    return;
  }
  nativeNpcStore.upsertNativeCargo({
    cargoID: toInt(cargoItem.itemID, 0),
    entityID: toInt(entity.itemID, 0),
    ownerID: toInt(entity.ownerID ?? entity.pilotCharacterID ?? entity.characterID, 0),
    moduleID: 0,
    typeID: toInt(cargoItem.typeID, 0),
    groupID: toInt(cargoItem.groupID, 0),
    categoryID: toInt(cargoItem.categoryID, 0),
    itemName: String(cargoItem.itemName || ""),
    quantity: Math.max(0, toInt(cargoItem.quantity, 0)),
    singleton: false,
    transient: entity.transient === true,
  }, {
    transient: entity.transient === true,
  });
}

function appendNpcMiningCargo(entity, typeID, quantity) {
  const numericTypeID = toInt(typeID, 0);
  const numericQuantity = Math.max(0, toInt(quantity, 0));
  if (!entity || numericTypeID <= 0 || numericQuantity <= 0) {
    return;
  }
  if (!Array.isArray(entity.nativeCargoItems)) {
    entity.nativeCargoItems = [];
  }

  const typeRecord = resolveItemByTypeID(numericTypeID) || {};
  const existingEntry = entity.nativeCargoItems.find((entry) => (
    toInt(entry && entry.typeID, 0) === numericTypeID &&
    toInt(entry && entry.moduleID, 0) <= 0
  )) || null;
  if (existingEntry) {
    existingEntry.quantity = toInt(existingEntry.quantity, 0) + numericQuantity;
    existingEntry.stacksize = existingEntry.quantity;
    ensureNpcCargoStoreEntry(entity, existingEntry);
    return;
  }

  const cargoIDResult = nativeNpcStore.allocateCargoID({
    transient: entity.transient === true,
  });
  const nextCargoID = cargoIDResult && cargoIDResult.success && cargoIDResult.data
    ? cargoIDResult.data
    : -(entity.nativeCargoItems.length + 1);
  const cargoItem = {
    itemID: nextCargoID,
    ownerID: toInt(entity.ownerID ?? entity.pilotCharacterID ?? entity.characterID, 0),
    locationID: toInt(entity.itemID, 0),
    moduleID: 0,
    typeID: numericTypeID,
    groupID: toInt(typeRecord.groupID, 0),
    categoryID: toInt(typeRecord.categoryID, 0),
    quantity: numericQuantity,
    stacksize: numericQuantity,
    singleton: 0,
    flagID: 5,
    itemName: String(typeRecord.name || `type ${numericTypeID}`),
    volume: Math.max(0, toFiniteNumber(typeRecord.volume, 0)),
  };
  entity.nativeCargoItems.push(cargoItem);
  ensureNpcCargoStoreEntry(entity, cargoItem);
}

function clearNpcMiningCargo(entity) {
  if (!entity || !Array.isArray(entity.nativeCargoItems)) {
    return 0;
  }

  let removedVolumeM3 = 0;
  const retainedCargoItems = [];
  for (const cargoItem of entity.nativeCargoItems) {
    if (toInt(cargoItem && cargoItem.moduleID, 0) > 0) {
      retainedCargoItems.push(cargoItem);
      continue;
    }
    removedVolumeM3 +=
      Math.max(0, toInt(cargoItem && cargoItem.quantity, 0)) *
      Math.max(0, toFiniteNumber(cargoItem && cargoItem.volume, 0));
    if (toInt(cargoItem && cargoItem.itemID, 0) > 0) {
      nativeNpcStore.removeNativeCargo(cargoItem.itemID);
    }
  }
  entity.nativeCargoItems = retainedCargoItems;
  return removedVolumeM3;
}

function getInventoryStackQuantity(item) {
  return Math.max(
    0,
    toInt(item && (item.quantity ?? item.stacksize), 0),
  );
}

function getInventoryStackVolumeM3(item) {
  const typeRecord =
    resolveItemByTypeID(toInt(item && item.typeID, 0)) || {};
  return getInventoryStackQuantity(item) * Math.max(
    0,
    toFiniteNumber(
      item && item.volume,
      toFiniteNumber(typeRecord.volume, 0),
    ),
  );
}

function getMiningJetcanCapacityM3() {
  return Math.max(
    1_000,
    toFiniteNumber(
      config.miningNpcJetcanCapacityM3,
      DEFAULT_MINING_JETCAN_CAPACITY_M3,
    ),
  );
}

function getMiningJetcanContents(containerID) {
  return listContainerItems(null, toInt(containerID, 0), null)
    .filter((item) => getInventoryStackQuantity(item) > 0);
}

function getMiningJetcanUsedVolumeM3(containerID) {
  return getMiningJetcanContents(containerID).reduce(
    (sum, item) => sum + getInventoryStackVolumeM3(item),
    0,
  );
}

function removeNpcMiningCargoQuantity(entity, cargoItem, quantity) {
  const requestedQuantity = Math.max(0, toInt(quantity, 0));
  const currentQuantity = Math.max(
    0,
    toInt(cargoItem && cargoItem.quantity, 0),
  );
  if (
    !entity ||
    !cargoItem ||
    requestedQuantity <= 0 ||
    currentQuantity <= 0
  ) {
    return 0;
  }
  const removedQuantity = Math.min(currentQuantity, requestedQuantity);
  const remainingQuantity = currentQuantity - removedQuantity;
  if (remainingQuantity > 0) {
    cargoItem.quantity = remainingQuantity;
    cargoItem.stacksize = remainingQuantity;
    ensureNpcCargoStoreEntry(entity, cargoItem);
    return removedQuantity;
  }
  entity.nativeCargoItems = (
    Array.isArray(entity.nativeCargoItems) ? entity.nativeCargoItems : []
  ).filter(
    (entry) =>
      toInt(entry && entry.itemID, 0) !== toInt(cargoItem.itemID, 0),
  );
  if (toInt(cargoItem.itemID, 0) > 0) {
    nativeNpcStore.removeNativeCargo(cargoItem.itemID);
  }
  return removedQuantity;
}

function getMiningJetcanRecord(fleetRecord, containerID) {
  if (!fleetRecord || !fleetRecord.jetcanRecordsByID) {
    return null;
  }
  return (
    fleetRecord.jetcanRecordsByID[String(toInt(containerID, 0))] ||
    null
  );
}

function detachMiningJetcanRecord(fleetRecord, containerID) {
  const normalizedContainerID = toInt(containerID, 0);
  const record = getMiningJetcanRecord(
    fleetRecord,
    normalizedContainerID,
  );
  if (!record) {
    return null;
  }
  const minerKey = String(toInt(record.minerEntityID, 0));
  if (
    toInt(
      fleetRecord.activeJetcanIDByMinerID &&
        fleetRecord.activeJetcanIDByMinerID[minerKey],
      0,
    ) === normalizedContainerID
  ) {
    delete fleetRecord.activeJetcanIDByMinerID[minerKey];
  }
  delete fleetRecord.jetcanRecordsByID[
    String(normalizedContainerID)
  ];
  return record;
}

function createMiningJetcan(scene, fleetRecord, minerEntity, now) {
  if (
    !scene ||
    !fleetRecord ||
    !minerEntity ||
    !npcService.getControllerByEntityID(toInt(minerEntity.itemID, 0))
  ) {
    return null;
  }
  const minerScope = resolveEntityInteractionScope(minerEntity);
  if (!minerScope.valid) {
    return null;
  }
  const containerLookup = resolveItemByName("Cargo Container");
  if (
    !containerLookup ||
    !containerLookup.success ||
    !containerLookup.match
  ) {
    return null;
  }
  const ownerID = normalizePositiveInteger(
    fleetRecord.cargoOwnerID,
    normalizePositiveInteger(
      minerEntity.ownerID ??
        minerEntity.corporationID ??
        minerEntity.pilotCharacterID,
      0,
    ),
  );
  if (ownerID <= 0) {
    return null;
  }
  const direction = normalizeVector(
    minerEntity.direction,
    { x: 1, y: 0, z: 0 },
  );
  const jettisonDistanceMeters = Math.max(
    275,
    toFiniteNumber(config.miningNpcJetcanJettisonDistanceMeters, 750),
  );
  const position = {
    x: toFiniteNumber(minerEntity.position && minerEntity.position.x, 0) +
      (direction.x * jettisonDistanceMeters),
    y: toFiniteNumber(minerEntity.position && minerEntity.position.y, 0) +
      (direction.y * jettisonDistanceMeters),
    z: toFiniteNumber(minerEntity.position && minerEntity.position.z, 0) +
      (direction.z * jettisonDistanceMeters),
  };
  const corporationID = normalizePositiveInteger(
    fleetRecord.cargoCorporationID,
    normalizePositiveInteger(minerEntity.corporationID, 0),
  );
  const itemName = `${String(
    fleetRecord.jetcanNamePrefix ||
      minerEntity.itemName ||
      "Mining Fleet",
  )} Jetcan`;
  const entityScopeMetadata = buildChildEntityScopeMetadata(minerEntity);
  const createResult = createSpaceItemForOwner(
    ownerID,
    scene.systemID,
    containerLookup.match,
    {
      ...entityScopeMetadata,
      itemName,
      position,
      velocity: { x: 0, y: 0, z: 0 },
      direction,
      targetPoint: position,
      mode: "STOP",
      speedFraction: 0,
      transient: fleetRecord.cargoTransient !== false,
      createdAtMs: now,
      expiresAtMs: now + DEFAULT_MINING_JETCAN_LIFETIME_MS,
      launcherID: toInt(minerEntity.itemID, 0),
      customInfo: JSON.stringify({
        evejsLoot: {
          corporationID,
          lootRightCorpID: corporationID,
        },
        evejsNpcMining: {
          fleetID: fleetRecord.fleetID,
          minerEntityID: toInt(minerEntity.itemID, 0),
        },
      }),
    },
  );
  const containerID = toInt(
    createResult && createResult.data && createResult.data.itemID,
    0,
  );
  if (!createResult || !createResult.success || containerID <= 0) {
    return null;
  }

  const spawnResult = getSpaceRuntime().spawnDynamicInventoryEntity(
    scene.systemID,
    containerID,
    {
      broadcast: false,
      entityScopeMetadata,
    },
  );
  const containerEntity =
    spawnResult &&
    spawnResult.success &&
    spawnResult.data &&
    spawnResult.data.entity
      ? spawnResult.data.entity
      : scene.getEntityByID(containerID);
  if (
    !containerEntity ||
    !canEntitiesInteractLocally(minerEntity, containerEntity)
  ) {
    if (containerEntity) {
      getSpaceRuntime().removeDynamicEntity(scene.systemID, containerID, {
        persistSpaceState: false,
      });
    }
    removeInventoryItem(containerID, { removeContents: true });
    return null;
  }
  containerEntity.itemName = itemName;
  containerEntity.slimName = itemName;
  containerEntity.corporationID = corporationID;
  containerEntity.lootRightCorpID = corporationID;
  scene.broadcastAddBalls(
    [containerEntity],
    null,
    { freshAcquire: true },
  );
  scene.broadcastSpecialFx(
    containerEntity.itemID,
    MINING_JETTISON_EFFECT_GUID,
    {
      targetID: null,
      isOffensive: false,
      start: true,
      active: false,
      duration: -1,
      useCurrentVisibleStamp: true,
    },
    containerEntity,
  );

  const record = {
    containerID,
    minerEntityID: toInt(minerEntity.itemID, 0),
    createdAtMs: now,
    sealedAtMs: 0,
    tractorStartedAtMs: 0,
    pickupRangeReachedAtMs: 0,
    collectedAtMs: 0,
  };
  fleetRecord.jetcanRecordsByID[String(containerID)] = record;
  fleetRecord.activeJetcanIDByMinerID[
    String(record.minerEntityID)
  ] = containerID;
  fleetRecord.jetcansCreated += 1;
  log.info(
    `[MiningSupport] fleet=${fleetRecord.fleetID} ` +
    `miner=${record.minerEntityID} jettisoned can=${containerID}`,
  );
  return record;
}

function resolveActiveMiningJetcan(
  scene,
  fleetRecord,
  minerEntity,
  now,
) {
  const minerEntityID = toInt(minerEntity && minerEntity.itemID, 0);
  const activeContainerID = toInt(
    fleetRecord &&
      fleetRecord.activeJetcanIDByMinerID &&
      fleetRecord.activeJetcanIDByMinerID[String(minerEntityID)],
    0,
  );
  if (activeContainerID > 0) {
    const record = getMiningJetcanRecord(
      fleetRecord,
      activeContainerID,
    );
    const entity = scene.getEntityByID(activeContainerID);
    if (
      record &&
      entity &&
      canEntitiesInteractLocally(minerEntity, entity) &&
      record.sealedAtMs <= 0 &&
      record.tractorStartedAtMs <= 0 &&
      record.collectedAtMs <= 0
    ) {
      return record;
    }
    delete fleetRecord.activeJetcanIDByMinerID[
      String(minerEntityID)
    ];
  }
  return createMiningJetcan(scene, fleetRecord, minerEntity, now);
}

function routeMinerCargoToJetcans(
  scene,
  fleetRecord,
  minerEntity,
  now,
  options = {},
) {
  if (
    !scene ||
    !fleetRecord ||
    !minerEntity ||
    !npcService.getControllerByEntityID(toInt(minerEntity.itemID, 0))
  ) {
    return 0;
  }
  if (
    options.force !== true &&
    config.miningNpcJetcansRequireFullHold !== false &&
    !getNpcMiningCargoFullState(
      minerEntity,
      toFiniteNumber(
        config.miningNpcMinerCargoCapacityM3,
        DEFAULT_MINING_MINER_CARGO_CAPACITY_M3,
      ),
    ).operationallyFull
  ) {
    return 0;
  }

  let transferredVolumeM3 = 0;
  const touchedJetcanRecords = new Set();
  const finishJettison = () => {
    for (const jetcanRecord of touchedJetcanRecords) {
      jetcanRecord.sealedAtMs = Math.max(1, toInt(now, Date.now()));
      const minerKey = String(
        toInt(jetcanRecord.minerEntityID, 0),
      );
      if (
        toInt(
          fleetRecord.activeJetcanIDByMinerID &&
            fleetRecord.activeJetcanIDByMinerID[minerKey],
          0,
        ) === toInt(jetcanRecord.containerID, 0)
      ) {
        delete fleetRecord.activeJetcanIDByMinerID[minerKey];
      }
    }
    return transferredVolumeM3;
  };

  for (const cargoItem of [...getNpcOreCargoItems(minerEntity)]) {
    const typeID = toInt(cargoItem && cargoItem.typeID, 0);
    const typeRecord = resolveItemByTypeID(typeID) || null;
    const unitVolumeM3 = Math.max(
      MINING_CARGO_FULL_EPSILON_M3,
      toFiniteNumber(
        cargoItem && cargoItem.volume,
        toFiniteNumber(typeRecord && typeRecord.volume, 0),
      ),
    );
    let remainingQuantity = Math.max(
      0,
      toInt(cargoItem && cargoItem.quantity, 0),
    );
    while (typeRecord && remainingQuantity > 0) {
      const jetcanRecord = resolveActiveMiningJetcan(
        scene,
        fleetRecord,
        minerEntity,
        now,
      );
      if (!jetcanRecord) {
        return finishJettison();
      }
      touchedJetcanRecords.add(jetcanRecord);
      const usedVolumeM3 = getMiningJetcanUsedVolumeM3(
        jetcanRecord.containerID,
      );
      const availableVolumeM3 = Math.max(
        0,
        getMiningJetcanCapacityM3() - usedVolumeM3,
      );
      const quantityThatFits = Math.min(
        remainingQuantity,
        Math.max(0, Math.floor(availableVolumeM3 / unitVolumeM3)),
      );
      if (quantityThatFits <= 0) {
        delete fleetRecord.activeJetcanIDByMinerID[
          String(minerEntity.itemID)
        ];
        continue;
      }
      const grantResult = grantItemToOwnerLocation(
        normalizePositiveInteger(
          fleetRecord.cargoOwnerID,
          normalizePositiveInteger(minerEntity.ownerID, 0),
        ),
        jetcanRecord.containerID,
        0,
        typeRecord,
        quantityThatFits,
        { transient: fleetRecord.cargoTransient !== false },
      );
      if (!grantResult || !grantResult.success) {
        return finishJettison();
      }
      const removedQuantity = removeNpcMiningCargoQuantity(
        minerEntity,
        cargoItem,
        quantityThatFits,
      );
      if (removedQuantity <= 0) {
        return finishJettison();
      }
      remainingQuantity -= removedQuantity;
      transferredVolumeM3 += removedQuantity * unitVolumeM3;
      if (
        getMiningJetcanUsedVolumeM3(jetcanRecord.containerID) >=
        getMiningJetcanCapacityM3() - 1
      ) {
        delete fleetRecord.activeJetcanIDByMinerID[
          String(minerEntity.itemID)
        ];
      }
    }
  }
  return finishJettison();
}

function resolveTractorModule(entity) {
  return getNpcFittedModuleItems(entity)
    .filter((moduleItem) => isModuleOnline(moduleItem))
    .map((moduleItem) => ({
      moduleItem,
      effectRecord: getTypeEffectRecords(
        toInt(moduleItem && moduleItem.typeID, 0),
      ).find(
        (effectRecord) =>
          String(effectRecord && effectRecord.name || "") ===
          MINING_TRACTOR_EFFECT_NAME,
      ) || null,
    }))
    .find((entry) => entry.effectRecord) || null;
}

function removeMiningJetcan(
  scene,
  fleetRecord,
  containerID,
  options = {},
) {
  const normalizedContainerID = toInt(containerID, 0);
  detachMiningJetcanRecord(
    fleetRecord,
    normalizedContainerID,
  );
  removeInventoryItem(normalizedContainerID, {
    removeContents: options.removeContents !== false,
  });
  const systemID = toInt(
    scene && scene.systemID,
    toInt(fleetRecord && fleetRecord.systemID, 0),
  );
  if (systemID > 0) {
    getSpaceRuntime().removeDynamicEntity(
      systemID,
      normalizedContainerID,
      {
        terminalDestructionEffectID:
          MINING_JETCAN_DESTRUCTION_EFFECT_ID,
        persistSpaceState: false,
      },
    );
  }
}

function deactivateFleetTractor(
  scene,
  fleetRecord,
  haulerEntity,
  hooks,
  reason = "cargo",
) {
  const moduleID = toInt(
    fleetRecord && fleetRecord.activeTractorModuleID,
    0,
  );
  if (
    scene &&
    haulerEntity &&
    moduleID > 0 &&
    npcService.getControllerByEntityID(toInt(haulerEntity.itemID, 0))
  ) {
    scene.deactivateGenericModule(
      buildNpcPseudoSession(haulerEntity, hooks),
      moduleID,
      {
        reason,
        deferUntilCycle: false,
      },
    );
  }
  fleetRecord.activeTractorCanID = 0;
  fleetRecord.activeTractorHaulerID = 0;
  fleetRecord.activeTractorModuleID = 0;
}

function collectMiningJetcan(
  scene,
  fleetRecord,
  haulerEntity,
  containerID,
  hooks,
  options = {},
) {
  const containerEntity =
    scene && scene.getEntityByID(toInt(containerID, 0));
  if (
    !scene ||
    !fleetRecord ||
    !haulerEntity ||
    !containerEntity ||
    !npcService.getControllerByEntityID(toInt(haulerEntity.itemID, 0)) ||
    !canEntitiesInteractLocally(haulerEntity, containerEntity)
  ) {
    return false;
  }
  const contents = getMiningJetcanContents(containerID);
  const cargoVolumeM3 = contents.reduce(
    (sum, item) =>
      sum + getInventoryStackVolumeM3(item),
    0,
  );
  const supportCapacityM3 = getNpcCargoCapacityM3(
    haulerEntity,
    DEFAULT_MINING_HAULER_CARGO_CAPACITY_M3,
  );
  const supportUsedVolumeM3 = getNpcOreCargoVolume(haulerEntity);
  let availableVolumeM3 = Math.max(
    0,
    supportCapacityM3 - supportUsedVolumeM3,
  );
  const externalCollector =
    typeof fleetRecord.externalContainerCollector === "function"
      ? fleetRecord.externalContainerCollector
      : null;
  if (
    externalCollector &&
    options.force !== true &&
    cargoVolumeM3 > availableVolumeM3 + 0.001
  ) {
    return false;
  }
  let transferredVolumeM3 = 0;
  if (externalCollector) {
    const collectionNowMs = toFiniteNumber(
      options.nowMs,
      Date.now(),
    );
    if (
      toFiniteNumber(
        fleetRecord.nextExternalCollectionAttemptAtMs,
        0,
      ) > collectionNowMs
    ) {
      return false;
    }
    let collectionResult;
    try {
      collectionResult = externalCollector({
        scene,
        fleetRecord,
        haulerEntity,
        containerID: toInt(containerID, 0),
        manifestID:
          String(fleetRecord.externalManifestID || "").trim() ||
          null,
        contents,
        cargoVolumeM3,
        nowMs: collectionNowMs,
      });
    } catch (error) {
      collectionResult = {
        success: false,
        errorMsg:
          error && error.message ||
          "EXTERNAL_COLLECTION_FAILED",
      };
    }
    if (!collectionResult || collectionResult.success !== true) {
      fleetRecord.externalCollectionError = String(
        collectionResult &&
          collectionResult.errorMsg ||
          "EXTERNAL_COLLECTION_FAILED",
      );
      fleetRecord.nextExternalCollectionAttemptAtMs =
        collectionNowMs + 60_000;
      return false;
    }
    fleetRecord.externalCollectionError = null;
    fleetRecord.nextExternalCollectionAttemptAtMs = 0;
    transferredVolumeM3 = cargoVolumeM3;
  } else {
    for (const item of contents) {
      const quantity = getInventoryStackQuantity(item);
      if (quantity <= 0) {
        continue;
      }
      const typeID = toInt(item.typeID, 0);
      const typeRecord = resolveItemByTypeID(typeID) || null;
      const unitVolumeM3 = Math.max(
        MINING_CARGO_FULL_EPSILON_M3,
        toFiniteNumber(
          item.volume,
          toFiniteNumber(typeRecord && typeRecord.volume, 0),
        ),
      );
      if (!typeRecord || availableVolumeM3 + 0.001 < unitVolumeM3) {
        continue;
      }
      const quantityThatFits = Math.min(
        quantity,
        Math.max(
          0,
          Math.floor(
            (availableVolumeM3 + 0.001) /
            unitVolumeM3,
          ),
        ),
      );
      if (quantityThatFits <= 0) {
        continue;
      }
      const consumeResult = consumeInventoryItemQuantity(
        item.itemID,
        quantityThatFits,
        { removeContents: true },
      );
      if (!consumeResult || consumeResult.success !== true) {
        continue;
      }
      appendNpcMiningCargo(
        haulerEntity,
        typeID,
        quantityThatFits,
      );
      const stackVolumeM3 =
        quantityThatFits * unitVolumeM3;
      transferredVolumeM3 += stackVolumeM3;
      availableVolumeM3 = Math.max(
        0,
        availableVolumeM3 - stackVolumeM3,
      );
    }
  }
  if (transferredVolumeM3 <= 0) {
    fleetRecord.haulerOperationallyFull =
      getNpcMiningCargoFullState(
        haulerEntity,
        DEFAULT_MINING_HAULER_CARGO_CAPACITY_M3,
      ).operationallyFull;
    deactivateFleetTractor(
      scene,
      fleetRecord,
      haulerEntity,
      hooks,
      "cargo_full",
    );
    return false;
  }

  deactivateFleetTractor(
    scene,
    fleetRecord,
    haulerEntity,
    hooks,
    "cargo",
  );
  const record = getMiningJetcanRecord(fleetRecord, containerID);
  const remainingContents = externalCollector
    ? []
    : getMiningJetcanContents(containerID);
  const fullyCollected = remainingContents.length <= 0;
  if (record && fullyCollected) {
    record.collectedAtMs = toFiniteNumber(
      options.nowMs,
      Date.now(),
    );
  } else if (record) {
    record.tractorStartedAtMs = 0;
    record.pickupRangeReachedAtMs = 0;
    record.sealedAtMs = Math.max(
      1,
      toInt(
        record.sealedAtMs,
        toInt(options.nowMs, Date.now()),
      ),
    );
  }
  if (fullyCollected) {
    fleetRecord.jetcansCollected += 1;
  }
  fleetRecord.jetcanVolumeTransferredM3 += transferredVolumeM3;
  fleetRecord.haulerOperationallyFull =
    getNpcMiningCargoFullState(
      haulerEntity,
      DEFAULT_MINING_HAULER_CARGO_CAPACITY_M3,
    ).operationallyFull;
  log.info(
    `[MiningSupport] fleet=${fleetRecord.fleetID} ` +
    `hauler=${toInt(haulerEntity.itemID, 0)} ` +
    `${fullyCollected ? "collected" : "partially collected"} ` +
    `can=${containerID} volumeM3=${transferredVolumeM3.toFixed(3)}`,
  );
  if (fullyCollected) {
    removeMiningJetcan(
      scene,
      fleetRecord,
      containerID,
      { removeContents: false },
    );
  }
  if (externalCollector) {
    const nowMs = toFiniteNumber(
      options.nowMs,
      Date.now(),
    );
    const ingressDurationMs = Math.max(
      250,
      toFiniteNumber(
        config.miningNpcWarpIngressDurationMs,
        DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
      ),
    );
    if (
      fleetRecord.originAnchor &&
      fleetRecord.originAnchor.position
    ) {
      npcService.runtime.warpToPoint(
        haulerEntity.itemID,
        fleetRecord.originAnchor.position,
        {
          forceImmediateStart: true,
          broadcastWarpStartToVisibleSessions: true,
          visibilitySuppressMs: 250,
          ingressDurationMs,
        },
      );
    }
    fleetRecord.state = "external_hauling";
    fleetRecord.haulCompleteAtMs =
      nowMs + ingressDurationMs;
    fleetRecord.nextThinkAtMs =
      fleetRecord.haulCompleteAtMs;
  }
  return true;
}

function startOnGridHaulerDelivery(
  scene,
  fleetRecord,
  haulerEntity,
  now,
  options = {},
) {
  if (
    !scene ||
    !fleetRecord ||
    fleetRecord.onGridSupport !== true ||
    !haulerEntity ||
    !npcService.getControllerByEntityID(toInt(haulerEntity.itemID, 0)) ||
    fleetRecord.externalContainerCollector ||
    String(fleetRecord.supportHaulerState || "idle") !== "idle"
  ) {
    return false;
  }
  const cargoState = getNpcMiningCargoFullState(
    haulerEntity,
    DEFAULT_MINING_HAULER_CARGO_CAPACITY_M3,
  );
  if (
    cargoState.usedVolumeM3 <= 0 ||
    (options.force !== true && !cargoState.operationallyFull)
  ) {
    return false;
  }
  if (!fleetRecord.originAnchor || !fleetRecord.originAnchor.position) {
    return false;
  }
  const ingressDurationMs = Math.max(
    250,
    toFiniteNumber(
      config.miningNpcWarpIngressDurationMs,
      DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
    ),
  );
  const returnPosition =
    buildFleetReferencePosition(scene, fleetRecord) ||
    cloneVector(haulerEntity.position);
  npcService.runtime.warpToPoint(
    haulerEntity.itemID,
    fleetRecord.originAnchor.position,
    {
      forceImmediateStart: true,
      broadcastWarpStartToVisibleSessions: true,
      visibilitySuppressMs: 250,
      ingressDurationMs,
    },
  );
  fleetRecord.supportHaulerState = "delivering";
  fleetRecord.supportHaulerEntityID = toInt(
    haulerEntity.itemID,
    0,
  );
  fleetRecord.supportHaulerReturnPosition =
    cloneVector(returnPosition);
  fleetRecord.supportHaulerDeliveryCompleteAtMs =
    toInt(now, Date.now()) +
    ingressDurationMs +
    Math.max(
      500,
      toFiniteNumber(
        config.miningNpcHaulerUnloadDurationMs,
        DEFAULT_MINING_HAULER_UNLOAD_DURATION_MS,
      ),
    );
  fleetRecord.haulerOperationallyFull = false;
  return true;
}

function tickOnGridHaulerDelivery(scene, fleetRecord, now) {
  const supportHaulerState = String(
    fleetRecord.supportHaulerState || "idle",
  );
  if (supportHaulerState === "idle") {
    return false;
  }
  const haulerEntity = scene.getEntityByID(
    toInt(fleetRecord.supportHaulerEntityID, 0),
  );
  if (!haulerEntity) {
    fleetRecord.supportHaulerState = "idle";
    fleetRecord.supportHaulerEntityID = 0;
    return false;
  }
  const ingressDurationMs = Math.max(
    250,
    toFiniteNumber(
      config.miningNpcWarpIngressDurationMs,
      DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
    ),
  );
  if (
    supportHaulerState === "delivering" &&
    now >= toFiniteNumber(
      fleetRecord.supportHaulerDeliveryCompleteAtMs,
      0,
    )
  ) {
    const deliveredVolumeM3 = clearNpcMiningCargo(haulerEntity);
    fleetRecord.lastHauledVolumeM3 = deliveredVolumeM3;
    fleetRecord.lastHauledAtMs = now;
    fleetRecord.supportDeliveryCount =
      Math.max(0, toInt(fleetRecord.supportDeliveryCount, 0)) + 1;
    npcService.runtime.warpToPoint(
      haulerEntity.itemID,
      fleetRecord.supportHaulerReturnPosition ||
        buildFleetReferencePosition(scene, fleetRecord),
      {
        forceImmediateStart: true,
        broadcastWarpStartToVisibleSessions: true,
        visibilitySuppressMs: 250,
        ingressDurationMs,
      },
    );
    fleetRecord.supportHaulerState = "returning";
    fleetRecord.supportHaulerReturnAtMs =
      now + ingressDurationMs;
    return true;
  }
  if (
    supportHaulerState === "returning" &&
    now >= toFiniteNumber(fleetRecord.supportHaulerReturnAtMs, 0)
  ) {
    fleetRecord.supportHaulerState = "idle";
    fleetRecord.supportHaulerEntityID = 0;
    fleetRecord.supportHaulerDeliveryCompleteAtMs = 0;
    fleetRecord.supportHaulerReturnAtMs = 0;
    fleetRecord.supportHaulerReturnPosition = null;
    return false;
  }
  return true;
}

function processOnGridMiningSupport(
  scene,
  fleetRecord,
  now,
  hooks,
) {
  if (
    !scene ||
    !fleetRecord ||
    fleetRecord.onGridSupport !== true
  ) {
    return;
  }
  for (const minerEntityID of fleetRecord.minerEntityIDs) {
    const minerEntity = scene.getEntityByID(minerEntityID);
    if (minerEntity) {
      routeMinerCargoToJetcans(
        scene,
        fleetRecord,
        minerEntity,
        now,
      );
    }
  }
  if (tickOnGridHaulerDelivery(scene, fleetRecord, now)) {
    return;
  }

  const haulerEntity = fleetRecord.haulerEntityIDs
    .map((entityID) => scene.getEntityByID(entityID))
    .find(
      (entity) =>
        entity &&
        entity.mode !== "WARP" &&
        !entity.pendingWarp &&
        npcService.getControllerByEntityID(
          toInt(entity.itemID, 0),
        ),
    ) || null;
  if (!haulerEntity) {
    return;
  }
  if (
    getNpcMiningCargoFullState(
      haulerEntity,
      DEFAULT_MINING_HAULER_CARGO_CAPACITY_M3,
    ).operationallyFull &&
    startOnGridHaulerDelivery(
      scene,
      fleetRecord,
      haulerEntity,
      now,
    )
  ) {
    return;
  }

  let activeContainerID = toInt(
    fleetRecord.activeTractorCanID,
    0,
  );
  let activeRecord = getMiningJetcanRecord(
    fleetRecord,
    activeContainerID,
  );
  let activeContainer =
    activeContainerID > 0
      ? scene.getEntityByID(activeContainerID)
      : null;
  if (
    !activeRecord ||
    !activeContainer ||
    !canEntitiesInteractLocally(haulerEntity, activeContainer)
  ) {
    deactivateFleetTractor(
      scene,
      fleetRecord,
      haulerEntity,
      hooks,
      "target",
    );
    activeRecord = Object.values(
      fleetRecord.jetcanRecordsByID || {},
    )
      .filter((record) => {
        if (
          !record ||
          record.sealedAtMs <= 0 ||
          record.collectedAtMs > 0
        ) {
          return false;
        }
        const container = scene.getEntityByID(record.containerID);
        return Boolean(
          container &&
          canEntitiesInteractLocally(haulerEntity, container),
        );
      })
      .sort(
        (left, right) =>
          left.createdAtMs - right.createdAtMs ||
          left.containerID - right.containerID,
      )[0] || null;
    activeContainerID = toInt(
      activeRecord && activeRecord.containerID,
      0,
    );
    activeContainer =
      activeContainerID > 0
        ? scene.getEntityByID(activeContainerID)
        : null;
  }
  if (!activeRecord || !activeContainer) {
    return;
  }

  const tractorModule = resolveTractorModule(haulerEntity);
  if (!tractorModule) {
    return;
  }
  const activationRangeMeters = Math.max(
    1_000,
    toFiniteNumber(
      config.miningNpcSupportTractorActivationRangeMeters,
      19_000,
    ),
  );
  if (
    getSurfaceDistance(haulerEntity, activeContainer) >
    activationRangeMeters
  ) {
    syncMiningApproachOrder(
      scene,
      haulerEntity,
      activeContainer,
      2_000,
    );
    return;
  }
  if (
    toInt(fleetRecord.activeTractorCanID, 0) !==
    activeContainerID
  ) {
    const activationResult = scene.activateGenericModule(
      buildNpcPseudoSession(haulerEntity, hooks),
      tractorModule.moduleItem,
      tractorModule.effectRecord.name,
      { targetID: activeContainerID },
    );
    if (!activationResult || activationResult.success !== true) {
      return;
    }
    fleetRecord.activeTractorCanID = activeContainerID;
    fleetRecord.activeTractorHaulerID = toInt(
      haulerEntity.itemID,
      0,
    );
    fleetRecord.activeTractorModuleID = toInt(
      tractorModule.moduleItem.itemID,
      0,
    );
    activeRecord.tractorStartedAtMs = now;
    delete fleetRecord.activeJetcanIDByMinerID[
      String(activeRecord.minerEntityID)
    ];
    log.info(
      `[MiningSupport] fleet=${fleetRecord.fleetID} ` +
      `hauler=${haulerEntity.itemID} ` +
      `tractor module=${tractorModule.moduleItem.itemID} ` +
      `target=${activeContainerID}`,
    );
  }

  const pickupRangeMeters = Math.max(
    500,
    toFiniteNumber(
      config.miningNpcSupportPickupRangeMeters,
      DEFAULT_MINING_SUPPORT_PICKUP_RANGE_METERS,
    ),
  );
  if (
    getSurfaceDistance(haulerEntity, activeContainer) >
    pickupRangeMeters
  ) {
    activeRecord.pickupRangeReachedAtMs = 0;
    return;
  }
  if (activeRecord.pickupRangeReachedAtMs <= 0) {
    activeRecord.pickupRangeReachedAtMs = now;
    return;
  }
  const settleMs = Math.max(
    1_000,
    toFiniteNumber(
      config.miningNpcSupportPickupSettleMs,
      DEFAULT_MINING_SUPPORT_PICKUP_SETTLE_MS,
    ),
  );
  if (now - activeRecord.pickupRangeReachedAtMs < settleMs) {
    return;
  }
  collectMiningJetcan(
    scene,
    fleetRecord,
    haulerEntity,
    activeContainerID,
    hooks,
    { nowMs: now },
  );
  if (fleetRecord.haulerOperationallyFull === true) {
    startOnGridHaulerDelivery(
      scene,
      fleetRecord,
      haulerEntity,
      now,
    );
  }
}

function applyMiningFleetCommandBurstAffinity(
  fleetRecord,
  scene = null,
) {
  if (!fleetRecord) {
    return 0;
  }
  let activeScene = scene;
  if (!activeScene) {
    const runtime = getSpaceRuntime();
    activeScene =
      runtime.scenes instanceof Map
        ? runtime.scenes.get(
            toInt(fleetRecord.systemID, 0),
          ) || null
        : null;
  }
  const affinityGroupID =
    MINING_FLEET_COMMAND_BURST_AFFINITY_BASE +
    Math.max(1, toInt(fleetRecord.fleetID, 1));
  fleetRecord.commandBurstAffinityGroupID =
    affinityGroupID;
  let assignedCount = 0;
  for (const entityID of [
    ...(Array.isArray(fleetRecord.minerEntityIDs)
      ? fleetRecord.minerEntityIDs
      : []),
    ...(Array.isArray(fleetRecord.haulerEntityIDs)
      ? fleetRecord.haulerEntityIDs
      : []),
  ]) {
    const entity =
      activeScene &&
      typeof activeScene.getEntityByID === "function"
        ? activeScene.getEntityByID(entityID)
        : null;
    if (!entity) {
      continue;
    }
    entity.commandBurstAffinityGroupID =
      affinityGroupID;
    entity.remoteRepairBurstAffinityGroupID =
      affinityGroupID;
    assignedCount += 1;
  }
  return assignedCount;
}

function createMiningFleetRecord(options = {}) {
  const minerEntityIDs = (Array.isArray(options.minerEntityIDs) ? options.minerEntityIDs : [])
    .map((value) => normalizePositiveInteger(value, null))
    .filter(Boolean);
  const miningWorkerEntityIDs = (
    Array.isArray(options.miningWorkerEntityIDs)
      ? options.miningWorkerEntityIDs
      : minerEntityIDs
  )
    .map((value) => normalizePositiveInteger(value, null))
    .filter(
      (entityID) =>
        entityID && minerEntityIDs.includes(entityID),
    );
  const miningSupportEntityIDs = (
    Array.isArray(options.miningSupportEntityIDs)
      ? options.miningSupportEntityIDs
      : []
  )
    .map((value) => normalizePositiveInteger(value, null))
    .filter(
      (entityID) =>
        entityID && minerEntityIDs.includes(entityID),
    );
  const haulerEntityIDs = (Array.isArray(options.haulerEntityIDs) ? options.haulerEntityIDs : [])
    .map((value) => normalizePositiveInteger(value, null))
    .filter(Boolean);
  const responseEntityIDs = (Array.isArray(options.responseEntityIDs) ? options.responseEntityIDs : [])
    .map((value) => normalizePositiveInteger(value, null))
    .filter(Boolean);
  const createdAtMs = Math.max(0, toInt(options.createdAtMs, Date.now()));
  const fleetRecord = {
    fleetID: nextMiningFleetID++,
    source: String(options.source || "gm"),
    operatorKind:
      String(options.operatorKind || "").trim() || null,
    operatorID:
      String(options.operatorID || "").trim() || null,
    threatDoctrine: normalizeManagedThreatDoctrine(
      options.threatDoctrine,
    ),
    physicalShipLimit: Math.max(
      0,
      toInt(options.physicalShipLimit, 0),
    ),
    cargoOwnerID: normalizePositiveInteger(options.cargoOwnerID, 0),
    cargoCorporationID: normalizePositiveInteger(
      options.cargoCorporationID,
      0,
    ),
    cargoTransient: options.cargoTransient !== false,
    jetcanNamePrefix: String(options.jetcanNamePrefix || "").trim() || null,
    externalContainerCollector:
      typeof options.externalContainerCollector === "function"
        ? options.externalContainerCollector
        : null,
    externalManifestID:
      String(options.externalManifestID || "").trim() || null,
    externalCollectionError: null,
    nextExternalCollectionAttemptAtMs: 0,
    onManagedFleetDestroyed:
      typeof options.onManagedFleetDestroyed === "function"
        ? options.onManagedFleetDestroyed
        : null,
    onManagedDroneStockChanged:
      typeof options.onManagedDroneStockChanged === "function"
        ? options.onManagedDroneStockChanged
        : null,
    managedResourcesReleased: false,
    startupKey: String(options.startupKey || "").trim() || null,
    createdByCharacterID: normalizePositiveInteger(options.createdByCharacterID, 0),
    systemID: normalizePositiveInteger(options.systemID, 0),
    targetShipID: normalizePositiveInteger(options.targetShipID, 0),
    minerEntityIDs,
    // Support hulls remain in minerEntityIDs so all legacy fleet lifecycle
    // code still sees them. These subsets preserve each managed crew role.
    miningWorkerEntityIDs,
    miningSupportEntityIDs,
    supportEntityIDs: miningSupportEntityIDs,
    haulerEntityIDs,
    responseEntityIDs,
    managedRoster: (
      Array.isArray(options.managedRoster)
        ? options.managedRoster
        : []
    )
      .map((entry) => ({
        memberID:
          String(entry && entry.memberID || "").trim() ||
          null,
        index: Math.max(
          0,
          toInt(entry && entry.index, 0),
        ),
        entityID: normalizePositiveInteger(
          entry && entry.entityID,
          0,
        ),
        role:
          String(entry && entry.role || "").trim() ||
          null,
        profileID:
          String(entry && entry.profileID || "").trim() ||
          null,
        pilotIdentity:
          entry &&
          entry.pilotIdentity &&
          typeof entry.pilotIdentity === "object"
            ? { ...entry.pilotIdentity }
            : null,
        livingUniverseActorID:
          String(
            entry && entry.livingUniverseActorID || "",
          ).trim() || null,
      }))
      .filter((entry) => entry.entityID > 0),
    spawnSelectionName: options.spawnSelectionName ? String(options.spawnSelectionName) : null,
    haulerSelectionName: options.haulerSelectionName ? String(options.haulerSelectionName) : null,
    responseSelectionName: options.responseSelectionName ? String(options.responseSelectionName) : null,
    originAnchor: options.originAnchor || null,
    activeAsteroidID: normalizePositiveInteger(options.activeAsteroidID, 0),
    assignedAsteroidIDsByMinerID:
      options.assignedAsteroidIDsByMinerID &&
      typeof options.assignedAsteroidIDsByMinerID === "object"
        ? { ...options.assignedAsteroidIDsByMinerID }
        : {},
    state: String(options.state || "mining"),
    createdAtMs,
    nextThinkAtMs: 0,
    haulCompleteAtMs: 0,
    haulerReturnAtMs: 0,
    haulerNextArrivalAtMs: Math.max(
      0,
      toInt(
        options.haulerNextArrivalAtMs,
        haulerEntityIDs.length > 0
          ? createdAtMs + getHaulerInitialDelayMs()
          : 0,
      ),
    ),
    resumeAtMs: 0,
    retreatSitePosition: null,
    retreatWarpPendingEntityIDs: [],
    nextRetreatWarpRetryAtMs: 0,
    lastRetreatWarpErrors: [],
    managedSiteReturnAtMs: 0,
    responseDespawnAtMs: 0,
    responseRetreating: options.responseRetreating === true,
    lastHauledVolumeM3: 0,
    lastHauledAtMs: 0,
    lastAggressorID: normalizePositiveInteger(options.lastAggressorID, 0),
    lastAggressedAtMs: Math.max(0, toInt(options.lastAggressedAtMs, 0)),
    lastProcessedAggressionAtMs: Math.max(0, toInt(options.lastProcessedAggressionAtMs, 0)),
    lastResponseAtMs: Math.max(0, toInt(options.lastResponseAtMs, 0)),
    responseTargetID: normalizePositiveInteger(options.responseTargetID, 0),
    responseStandingClass: String(options.responseStandingClass || "").trim() || null,
    responseStandingValue: toFiniteNumber(options.responseStandingValue, 0),
    onGridSupport: options.onGridSupport === true,
    jetcanRecordsByID: {},
    activeJetcanIDByMinerID: {},
    activeTractorCanID: 0,
    activeTractorHaulerID: 0,
    activeTractorModuleID: 0,
    supportHaulerState: "idle",
    supportHaulerEntityID: 0,
    supportHaulerDeliveryCompleteAtMs: 0,
    supportHaulerReturnAtMs: 0,
    supportHaulerReturnPosition: null,
    supportDeliveryCount: 0,
    haulerOperationallyFull: false,
    defensiveDroneFlightIDsByControllerID: {},
    defenseDroneLossDetected: false,
    defenseDecision: null,
    managedThreatScanCount: 0,
    lastManagedThreatScanAtMs: -1,
    lastManagedThreatScanCandidateCount: 0,
    lastManagedThreatScanResult: null,
    jetcansCreated: 0,
    jetcansCollected: 0,
    jetcanVolumeTransferredM3: 0,
  };
  fleetRecord.memberBindings = fleetRecord.managedRoster;
  applyMiningFleetCommandBurstAffinity(
    fleetRecord,
    options.scene || null,
  );
  miningFleetStateByID.set(fleetRecord.fleetID, fleetRecord);
  return fleetRecord;
}

function registerAmbientMiningFleet(options = {}) {
  const systemID = normalizePositiveInteger(options.systemID, 0);
  const minerEntityIDs = (Array.isArray(options.minerEntityIDs)
    ? options.minerEntityIDs
    : [])
    .map((value) => normalizePositiveInteger(value, 0))
    .filter(
      (entityID) =>
        entityID > 0 && npcService.getControllerByEntityID(entityID),
    );
  const haulerEntityIDs = (Array.isArray(options.haulerEntityIDs)
    ? options.haulerEntityIDs
    : [])
    .map((value) => normalizePositiveInteger(value, 0))
    .filter(
      (entityID) =>
        entityID > 0 && npcService.getControllerByEntityID(entityID),
    );
  if (!systemID || minerEntityIDs.length <= 0) {
    return {
      success: false,
      errorMsg: "MINING_FLEET_ENTITIES_REQUIRED",
    };
  }
  for (const entityID of minerEntityIDs) {
    applyPassiveMiningFleetOverrides(entityID, {
      movementMode: "orbit",
      orbitDistanceMeters: 1_200,
      followRangeMeters: 800,
      idleAnchorOrbit: false,
      issueStopOrder: false,
      clearCombatPreference: true,
    });
  }
  for (const entityID of haulerEntityIDs) {
    applyPassiveMiningFleetOverrides(entityID, {
      movementMode: "orbit",
      orbitDistanceMeters: 3_500,
      followRangeMeters: 1_500,
      idleAnchorOrbit: false,
      issueStopOrder: false,
      clearCombatPreference: true,
    });
  }
  const fleetRecord = createMiningFleetRecord({
    ...options,
    source: String(options.source || "ambient"),
    systemID,
    minerEntityIDs,
    haulerEntityIDs,
    responseEntityIDs: [],
    state: "mining",
  });
  return {
    success: true,
    data: fleetRecord,
  };
}

function getMiningFleetsForSystem(systemID) {
  const normalizedSystemID = normalizePositiveInteger(systemID, 0);
  const fleets = [];
  for (const fleetRecord of miningFleetStateByID.values()) {
    if (normalizePositiveInteger(fleetRecord && fleetRecord.systemID, 0) === normalizedSystemID) {
      fleets.push(fleetRecord);
    }
  }
  return fleets;
}

function releaseManagedFleetResources(fleetRecord, reason) {
  if (
    !fleetRecord ||
    fleetRecord.managedResourcesReleased === true
  ) {
    return false;
  }
  fleetRecord.managedResourcesReleased = true;
  if (
    typeof fleetRecord.onManagedFleetDestroyed !== "function"
  ) {
    return false;
  }
  try {
    fleetRecord.onManagedFleetDestroyed({
      fleetID: fleetRecord.fleetID,
      operatorKind: fleetRecord.operatorKind,
      operatorID: fleetRecord.operatorID,
      reason: String(reason || "removed"),
    });
  } catch (error) {
    log.error(
      `[MiningFleet] managed cleanup callback failed fleet=${fleetRecord.fleetID}: ` +
      String(error && error.message || error),
    );
  }
  return true;
}

function cleanupMiningFleetRuntimeResources(
  scene,
  fleetRecord,
  options = {},
) {
  if (!fleetRecord) {
    return {
      burstCount: 0,
      droneFlightCount: 0,
      supportRemovedCount: 0,
    };
  }
  const reason = String(options.reason || "fleet_cleanup");
  const activeScene = resolveFleetScene(scene, fleetRecord);
  const burstCount = deactivateMiningSupportBursts(
    activeScene,
    fleetRecord,
    options.hooks || null,
    reason,
  );
  const droneFlightCount = recallManagedFleetDefensiveDrones(
    activeScene,
    fleetRecord,
    reason,
  );
  const supportResult = cleanupMiningFleetSupport(
    activeScene,
    fleetRecord.fleetID,
    {
      hooks: options.hooks || null,
      unregister: false,
      reason,
    },
  );
  return {
    burstCount,
    droneFlightCount,
    supportRemovedCount: Math.max(
      0,
      toInt(
        supportResult &&
          supportResult.data &&
          supportResult.data.removedCount,
        0,
      ),
    ),
  };
}

function pruneMiningFleet(fleetRecord) {
  if (!fleetRecord) {
    return null;
  }
  fleetRecord.minerEntityIDs = (Array.isArray(fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : [])
    .filter((entityID) => npcService.getControllerByEntityID(entityID));
  fleetRecord.miningWorkerEntityIDs = (
    Array.isArray(fleetRecord.miningWorkerEntityIDs)
      ? fleetRecord.miningWorkerEntityIDs
      : fleetRecord.minerEntityIDs
  ).filter(
    (entityID) =>
      fleetRecord.minerEntityIDs.includes(entityID),
  );
  fleetRecord.miningSupportEntityIDs = (
    Array.isArray(fleetRecord.miningSupportEntityIDs)
      ? fleetRecord.miningSupportEntityIDs
      : []
  ).filter(
    (entityID) =>
      fleetRecord.minerEntityIDs.includes(entityID),
  );
  fleetRecord.supportEntityIDs =
    fleetRecord.miningSupportEntityIDs;
  fleetRecord.haulerEntityIDs = (Array.isArray(fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : [])
    .filter((entityID) => npcService.getControllerByEntityID(entityID));
  fleetRecord.responseEntityIDs = (Array.isArray(fleetRecord.responseEntityIDs) ? fleetRecord.responseEntityIDs : [])
    .filter((entityID) => npcService.getControllerByEntityID(entityID));
  if (fleetRecord.haulerEntityIDs.length <= 0) {
    fleetRecord.haulerNextArrivalAtMs = 0;
  }
  if (fleetRecord.responseEntityIDs.length <= 0) {
    fleetRecord.responseTargetID = 0;
    fleetRecord.responseDespawnAtMs = 0;
    fleetRecord.responseRetreating = false;
  }
  const assignmentMap = getFleetMinerAssignmentMap(fleetRecord);
  for (const minerEntityID of Object.keys(assignmentMap)) {
    if (!fleetRecord.minerEntityIDs.includes(toInt(minerEntityID, 0))) {
      delete assignmentMap[minerEntityID];
    }
  }
  if (Array.isArray(fleetRecord.managedRoster)) {
    const activeEntityIDs = new Set([
      ...fleetRecord.minerEntityIDs,
      ...fleetRecord.haulerEntityIDs,
      ...fleetRecord.responseEntityIDs,
    ]);
    fleetRecord.managedRoster = fleetRecord.managedRoster
      .filter(
        (entry) =>
          activeEntityIDs.has(
            toInt(entry && entry.entityID, 0),
          ),
      );
    fleetRecord.memberBindings = fleetRecord.managedRoster;
  }
  if (
    fleetRecord.minerEntityIDs.length === 0 &&
    fleetRecord.haulerEntityIDs.length === 0 &&
    fleetRecord.responseEntityIDs.length === 0
  ) {
    cleanupMiningFleetRuntimeResources(null, fleetRecord, {
      reason: "entities_missing",
    });
    releaseManagedFleetResources(
      fleetRecord,
      "entities_missing",
    );
    miningFleetStateByID.delete(fleetRecord.fleetID);
    return null;
  }
  return fleetRecord;
}

function destroyFleetEntities(fleetRecord, options = {}) {
  cleanupMiningFleetRuntimeResources(
    options.scene || null,
    fleetRecord,
    {
      hooks: options.hooks || null,
      reason: options.reason || "fleet_destroy",
    },
  );
  const entityIDs = [...new Set([
    ...(Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []),
    ...(Array.isArray(fleetRecord && fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : []),
    ...(Array.isArray(fleetRecord && fleetRecord.responseEntityIDs) ? fleetRecord.responseEntityIDs : []),
  ])];
  let destroyedCount = 0;
  for (const entityID of entityIDs) {
    const destroyResult = npcService.destroyNpcControllerByEntityID(entityID, {
      removeContents: true,
    });
    if (destroyResult && destroyResult.success) {
      destroyedCount += 1;
    }
  }
  return destroyedCount;
}

function normalizeManagedMiningOwner(options = {}) {
  return {
    operatorKind:
      String(options.operatorKind || "").trim(),
    operatorID:
      String(options.operatorID || "").trim(),
  };
}

function managedMiningOwnerMatches(fleetRecord, options = {}) {
  const owner = normalizeManagedMiningOwner(options);
  return Boolean(
    fleetRecord &&
    owner.operatorKind &&
    owner.operatorID &&
    String(fleetRecord.operatorKind || "") ===
      owner.operatorKind &&
    String(fleetRecord.operatorID || "") === owner.operatorID,
  );
}

function getManagedMiningFleet(fleetID, options = {}) {
  const fleetRecord =
    miningFleetStateByID.get(toInt(fleetID, 0)) || null;
  if (
    !fleetRecord ||
    !managedMiningOwnerMatches(fleetRecord, options)
  ) {
    return null;
  }
  return pruneMiningFleet(fleetRecord);
}

function destroyManagedMiningFleet(fleetID, options = {}) {
  const normalizedFleetID = toInt(fleetID, 0);
  const fleetRecord =
    miningFleetStateByID.get(normalizedFleetID) || null;
  if (!fleetRecord) {
    return {
      success: true,
      data: {
        fleetID: normalizedFleetID,
        destroyedCount: 0,
      },
    };
  }
  if (!managedMiningOwnerMatches(fleetRecord, options)) {
    return {
      success: false,
      errorMsg: "MANAGED_MINING_OWNER_MISMATCH",
    };
  }
  const reason = String(
    options.reason || "managed_destroy",
  );
  const destroyedCount = destroyFleetEntities(fleetRecord, {
    scene: options.scene || null,
    hooks: options.hooks || null,
    reason,
  });
  releaseManagedFleetResources(fleetRecord, reason);
  miningFleetStateByID.delete(normalizedFleetID);
  return {
    success: true,
    data: {
      fleetID: normalizedFleetID,
      destroyedCount,
    },
  };
}

function destroyManagedMiningFleetsByOwner(options = {}) {
  const owner = normalizeManagedMiningOwner(options);
  if (!owner.operatorKind || !owner.operatorID) {
    return {
      success: false,
      errorMsg: "MANAGED_MINING_OWNER_REQUIRED",
    };
  }
  const fleetIDs = [...miningFleetStateByID.values()]
    .filter(
      (fleetRecord) =>
        managedMiningOwnerMatches(fleetRecord, owner),
    )
    .map((fleetRecord) => fleetRecord.fleetID);
  let destroyedCount = 0;
  for (const fleetID of fleetIDs) {
    const result = destroyManagedMiningFleet(fleetID, {
      ...owner,
      scene: options.scene || null,
      hooks: options.hooks || null,
      reason: options.reason,
    });
    if (result && result.success === true) {
      destroyedCount += Math.max(
        0,
        toInt(
          result.data && result.data.destroyedCount,
          0,
        ),
      );
    }
  }
  return {
    success: true,
    data: {
      fleetIDs,
      fleetCount: fleetIDs.length,
      destroyedCount,
    },
  };
}

function settleManagedMiningFleetCargo(
  scene,
  fleetID,
  options = {},
) {
  const normalizedFleetID = toInt(fleetID, 0);
  const rawFleetRecord =
    miningFleetStateByID.get(normalizedFleetID) || null;
  if (!rawFleetRecord) {
    return {
      success: true,
      data: {
        fleetID: normalizedFleetID,
        transferredVolumeM3: 0,
        jetcanCount: 0,
        containerIDs: [],
      },
    };
  }
  const owner = normalizeManagedMiningOwner(options);
  if (!owner.operatorKind || !owner.operatorID) {
    return {
      success: false,
      errorMsg: "MANAGED_MINING_OWNER_REQUIRED",
    };
  }
  if (!managedMiningOwnerMatches(rawFleetRecord, owner)) {
    return {
      success: false,
      errorMsg: "MANAGED_MINING_OWNER_MISMATCH",
    };
  }
  const fleetRecord = pruneMiningFleet(rawFleetRecord);
  if (!fleetRecord) {
    return {
      success: true,
      data: {
        fleetID: normalizedFleetID,
        transferredVolumeM3: 0,
        jetcanCount: 0,
        containerIDs: [],
      },
    };
  }

  const activeScene = resolveFleetScene(scene, fleetRecord);
  if (!activeScene || fleetRecord.onGridSupport !== true) {
    const containerIDs = Object.values(
      fleetRecord.jetcanRecordsByID || {},
    )
      .map((record) =>
        toInt(record && record.containerID, 0))
      .filter((containerID) => containerID > 0);
    return {
      success: true,
      data: {
        fleetID: fleetRecord.fleetID,
        transferredVolumeM3: 0,
        jetcanCount: containerIDs.length,
        containerIDs,
      },
    };
  }

  const nowMs = Math.max(
    0,
    toInt(options.nowMs, Date.now()),
  );
  let transferredVolumeM3 = 0;
  for (
    const minerEntityID of
      Array.isArray(fleetRecord.minerEntityIDs)
        ? fleetRecord.minerEntityIDs
        : []
  ) {
    const minerEntity =
      activeScene.getEntityByID(minerEntityID);
    if (!minerEntity) {
      continue;
    }
    transferredVolumeM3 += routeMinerCargoToJetcans(
      activeScene,
      fleetRecord,
      minerEntity,
      nowMs,
      {
        force: options.force !== false,
      },
    );
  }

  const containerIDs = [];
  for (
    const record of Object.values(
      fleetRecord.jetcanRecordsByID || {},
    )
  ) {
    const containerID = toInt(
      record && record.containerID,
      0,
    );
    if (containerID <= 0) {
      continue;
    }
    record.sealedAtMs = Math.max(
      1,
      toInt(record.sealedAtMs, nowMs),
    );
    record.settledAtMs = nowMs;
    containerIDs.push(containerID);
  }
  return {
    success: true,
    data: {
      fleetID: fleetRecord.fleetID,
      transferredVolumeM3,
      jetcanCount: containerIDs.length,
      containerIDs,
    },
  };
}

function buildSpawnResultEntityIDs(spawnResult) {
  return (
    spawnResult &&
    spawnResult.data &&
    Array.isArray(spawnResult.data.spawned)
      ? spawnResult.data.spawned
        .map((entry) => normalizePositiveInteger(entry && entry.entity && entry.entity.itemID, null))
        .filter(Boolean)
      : []
  );
}

function buildCappedGroupProfilePlan(
  groupResolution,
  amount,
  physicalShipLimit,
) {
  const limit = Math.max(
    0,
    toInt(physicalShipLimit, 0),
  );
  if (limit <= 0) {
    return null;
  }
  const profileIDs = [];
  for (
    let iteration = 0;
    iteration < Math.max(1, toInt(amount, 1));
    iteration += 1
  ) {
    const definitionPlan = buildDefinitionsForSpawnGroup(
      groupResolution && groupResolution.data,
      { entityType: "npc" },
    );
    if (
      !definitionPlan ||
      definitionPlan.success !== true ||
      !definitionPlan.data
    ) {
      return definitionPlan || {
        success: false,
        errorMsg: "NPC_GROUP_SPAWN_PLAN_FAILED",
      };
    }
    for (const definition of definitionPlan.data.definitions || []) {
      const profileID = String(
        definition &&
          definition.profile &&
          definition.profile.profileID ||
          "",
      ).trim();
      if (!profileID) {
        return {
          success: false,
          errorMsg: "NPC_DEFINITION_INCOMPLETE",
        };
      }
      profileIDs.push(profileID);
      if (profileIDs.length >= limit) {
        return {
          success: true,
          data: { profileIDs },
        };
      }
    }
  }
  return profileIDs.length > 0
    ? { success: true, data: { profileIDs } }
    : {
        success: false,
        errorMsg: "NPC_GROUP_SPAWN_PLAN_EMPTY",
      };
}

function spawnFleetWing(systemID, centerTarget, options = {}) {
  const amount = Math.max(1, toInt(options.amount, 1));
  const physicalShipLimit = Math.max(
    0,
    toInt(options.physicalShipLimit, 0),
  );
  const profileQuery = String(options.profileQuery || "").trim();
  const originAnchor = options.originAnchor || null;
  const sharedSpawnOptions = {
    ...(options.entityScopeMetadata && typeof options.entityScopeMetadata === "object"
      ? { entityScopeMetadata: options.entityScopeMetadata }
      : {}),
    transient: true,
    broadcast: false,
    skipInitialBehaviorTick: true,
    operatorKind:
      String(options.operatorKind || "").trim() ||
      undefined,
    preferredTargetID: normalizePositiveInteger(options.preferredTargetID, 0),
    anchorDescriptor: originAnchor
      ? {
          kind: "coordinates",
          position: originAnchor.position,
          direction: originAnchor.direction,
          name: String(options.anchorName || "Mining Fleet Warp Origin"),
        }
      : null,
  };
  const groupResolution = profileQuery
    ? resolveNpcSpawnGroup(profileQuery, "")
    : {
      success: false,
    };
  let spawnResult = null;
  if (groupResolution.success && groupResolution.data) {
    const spawned = [];
    let partialFailure = null;
    const cappedProfilePlan = buildCappedGroupProfilePlan(
      groupResolution,
      amount,
      physicalShipLimit,
    );
    if (cappedProfilePlan) {
      // Native group calls materialize every configured entry at once.
      // Spawn an already-capped exact-profile plan so managed fleets never
      // temporarily exceed their reserved physical budget.
      if (
        cappedProfilePlan.success !== true ||
        !cappedProfilePlan.data
      ) {
        return cappedProfilePlan;
      }
      const cappedProfileIDs =
        cappedProfilePlan.data.profileIDs || [];
      for (
        let index = 0;
        index < cappedProfileIDs.length;
        index += 1
      ) {
        const profileSpawnResult =
          npcService.spawnNpcBatchInSystem(systemID, {
            ...sharedSpawnOptions,
            profileQuery: cappedProfileIDs[index],
            amount: 1,
            // The capped plan already selected one exact profile. Do not
            // reinterpret it as a broader pool when aliases overlap.
            preferPools: false,
          });
        if (
          !profileSpawnResult.success ||
          !profileSpawnResult.data ||
          !Array.isArray(profileSpawnResult.data.spawned) ||
          profileSpawnResult.data.spawned.length <= 0
        ) {
          if (spawned.length <= 0) {
            return profileSpawnResult;
          }
          partialFailure = {
            failedAt: index + 1,
            errorMsg:
              profileSpawnResult.errorMsg ||
              "NPC_PROFILE_SPAWN_FAILED",
          };
          break;
        }
        const profileSpawned =
          profileSpawnResult.data.spawned;
        spawned.push(profileSpawned[0]);
        // Guard against a future exact-profile resolver regression.
        for (const unexpectedEntry of profileSpawned.slice(1)) {
          const unexpectedEntityID =
            normalizePositiveInteger(
              unexpectedEntry &&
                unexpectedEntry.entity &&
                unexpectedEntry.entity.itemID,
              0,
            );
          if (unexpectedEntityID > 0) {
            npcService.destroyNpcControllerByEntityID(
              unexpectedEntityID,
              { removeContents: true },
            );
          }
        }
        if (profileSpawned.length > 1) {
          partialFailure = {
            failedAt: index + 1,
            errorMsg:
              "NPC_PROFILE_SPAWN_EXCEEDED_PHYSICAL_LIMIT",
            removedUnexpectedCount:
              profileSpawned.length - 1,
          };
        }
        if (profileSpawnResult.data.partialFailure) {
          partialFailure =
            profileSpawnResult.data.partialFailure;
          break;
        }
      }
    } else {
      // Ambient fleets retain native group semantics: amount one means one
      // complete configured spawn group.
      for (
        let iteration = 0;
        iteration < amount;
        iteration += 1
      ) {
        const groupSpawnResult =
          npcService.spawnNpcGroupInSystem(systemID, {
            ...sharedSpawnOptions,
            spawnGroupQuery: profileQuery,
            entityType: ENTITY_TYPE.NPC,
          });
        if (
          !groupSpawnResult.success ||
          !groupSpawnResult.data ||
          !Array.isArray(groupSpawnResult.data.spawned) ||
          groupSpawnResult.data.spawned.length <= 0
        ) {
          if (spawned.length <= 0) {
            return groupSpawnResult;
          }
          partialFailure = {
            failedAt: iteration + 1,
            errorMsg:
              groupSpawnResult.errorMsg ||
              "NPC_GROUP_SPAWN_FAILED",
          };
          break;
        }
        spawned.push(...groupSpawnResult.data.spawned);
        if (groupSpawnResult.data.partialFailure) {
          partialFailure =
            groupSpawnResult.data.partialFailure;
          break;
        }
      }
    }
    spawnResult = {
      success: true,
      data: {
        selectionKind: "group",
        selectionID: groupResolution.data.spawnGroupID,
        selectionName: groupResolution.data.name || groupResolution.data.spawnGroupID,
        requestedAmount: amount,
        physicalShipLimit,
        spawned,
        partialFailure,
      },
      suggestions: [],
    };
  } else {
    spawnResult = npcService.spawnNpcBatchInSystem(systemID, {
      ...sharedSpawnOptions,
      profileQuery,
      amount:
        physicalShipLimit > 0
          ? Math.min(amount, physicalShipLimit)
          : amount,
    });
  }
  if (!spawnResult.success || !spawnResult.data || !Array.isArray(spawnResult.data.spawned) || spawnResult.data.spawned.length <= 0) {
    return spawnResult;
  }

  if (options.warpIn !== false && centerTarget && centerTarget.position) {
    const landingRadiusMeters = Math.max(
      500,
      toFiniteNumber(
        options.landingRadiusMeters,
        DEFAULT_MINING_WARP_LANDING_RADIUS_METERS,
      ),
    );
    const warpRequests = spawnResult.data.spawned.map((entry, index, list) => ({
      entityID: normalizePositiveInteger(entry && entry.entity && entry.entity.itemID, 0),
      point: buildMiningWarpLandingPoint(
        centerTarget.position,
        index,
        list.length,
        landingRadiusMeters,
      ),
      options: {
        forceImmediateStart: true,
        broadcastWarpStartToVisibleSessions: true,
        visibilitySuppressMs: 250,
        ingressDurationMs: Math.max(
          250,
          toFiniteNumber(
            config.miningNpcWarpIngressDurationMs,
            DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
          ),
        ),
      },
    }));
    const warpResult = npcService.runtime.warpBatchToPoints(warpRequests, {
      groupWake: true,
    });
    if (!warpResult.success) {
      // Callers only receive the failed warp result, so clean up the already
      // spawned entities here rather than leaking an untracked partial wing.
      for (const entityID of buildSpawnResultEntityIDs(spawnResult)) {
        npcService.destroyNpcControllerByEntityID(entityID, {
          removeContents: true,
        });
      }
      return warpResult;
    }
  }

  return spawnResult;
}

function resolveSessionScene(session) {
  if (!session || !session._space) {
    return null;
  }
  const spaceRuntime = require(path.join(__dirname, "../../space/runtime"));
  return spaceRuntime.ensureScene(normalizePositiveInteger(session._space.systemID, 0));
}

function spawnMiningFleetInternal(scene, options = {}) {
  const systemID = normalizePositiveInteger(options.systemID || (scene && scene.systemID), 0);
  const centerTarget = options.centerTarget || buildSpawnTarget(scene);
  if (!systemID || !centerTarget || !centerTarget.position) {
    return {
      success: false,
      errorMsg: "SPAWN_TARGET_NOT_FOUND",
    };
  }

  const originAnchor = options.originAnchor || buildOffgridOriginAnchor(scene, centerTarget);
  const entityScopeMetadata = buildChildEntityScopeMetadata(centerTarget);
  const physicalShipLimit = Math.max(
    0,
    toInt(options.physicalShipLimit, 0),
  );
  const haulerAmount = Math.max(
    0,
    toInt(
      options.haulerAmount,
      toInt(
        config.miningNpcHaulerDefaultCount,
        DEFAULT_MINING_HAULER_COUNT,
      ),
    ),
  );
  const reservedHaulerSlots =
    physicalShipLimit > 0
      ? Math.min(
          haulerAmount,
          Math.max(0, physicalShipLimit - 1),
        )
      : 0;
  const minerPhysicalShipLimit =
    physicalShipLimit > 0
      ? Math.max(1, physicalShipLimit - reservedHaulerSlots)
      : 0;
  const resolvedMinerQuery = resolveMiningFleetQuery(
    scene,
    options.minerQuery,
    systemID,
  );
  const minerSpawnResult = spawnFleetWing(systemID, centerTarget, {
    amount: Math.max(
      1,
      toInt(
        options.minerAmount,
        toInt(config.miningNpcFleetDefaultCount, DEFAULT_MINING_FLEET_COUNT),
      ),
    ),
    profileQuery: resolvedMinerQuery,
    entityScopeMetadata,
    operatorKind: options.operatorKind,
    physicalShipLimit: minerPhysicalShipLimit,
    preferredTargetID: 0,
    originAnchor,
    warpIn: true,
    landingRadiusMeters: toFiniteNumber(
      config.miningNpcFleetLandingRadiusMeters,
      DEFAULT_MINING_WARP_LANDING_RADIUS_METERS,
    ),
  });
  if (!minerSpawnResult.success || !minerSpawnResult.data) {
    return minerSpawnResult;
  }

  const minerEntityCount =
    buildSpawnResultEntityIDs(minerSpawnResult).length;
  const remainingPhysicalShipLimit =
    physicalShipLimit > 0
      ? Math.max(0, physicalShipLimit - minerEntityCount)
      : 0;
  let haulerSpawnResult = null;
  if (
    haulerAmount > 0 &&
    (
      physicalShipLimit <= 0 ||
      remainingPhysicalShipLimit > 0
    )
  ) {
    const resolvedHaulerQuery = resolveMiningHaulerQuery(
      scene,
      options.haulerQuery,
      systemID,
    );
    haulerSpawnResult = spawnFleetWing(systemID, originAnchor, {
      amount:
        physicalShipLimit > 0
          ? Math.min(
              haulerAmount,
              remainingPhysicalShipLimit,
            )
          : haulerAmount,
      profileQuery: resolvedHaulerQuery,
      entityScopeMetadata,
      operatorKind: options.operatorKind,
      physicalShipLimit: remainingPhysicalShipLimit,
      preferredTargetID: 0,
      originAnchor,
      warpIn: false,
    });
    if (!haulerSpawnResult.success || !haulerSpawnResult.data) {
      const minerEntityIDs = buildSpawnResultEntityIDs(minerSpawnResult);
      for (const entityID of minerEntityIDs) {
        npcService.destroyNpcControllerByEntityID(entityID, {
          removeContents: true,
        });
      }
      return haulerSpawnResult;
    }
  }

  for (const entityID of buildSpawnResultEntityIDs(minerSpawnResult)) {
    applyPassiveMiningFleetOverrides(entityID, {
      movementMode: "orbit",
      orbitDistanceMeters: 1_200,
      followRangeMeters: 800,
      idleAnchorOrbit: false,
      issueStopOrder: false,
      clearCombatPreference: true,
    });
  }
  for (const entityID of buildSpawnResultEntityIDs(haulerSpawnResult)) {
    applyPassiveMiningFleetOverrides(entityID, {
      movementMode: "stop",
      orbitDistanceMeters: 500,
      followRangeMeters: 500,
      idleAnchorOrbit: false,
      idleAnchorOrbitDistanceMeters: 500,
      clearCombatPreference: true,
    });
  }

  return {
    success: true,
    data: {
      originAnchor,
      minerSpawnResult,
      haulerSpawnResult,
      centerTarget,
      minerEntityIDs: buildSpawnResultEntityIDs(minerSpawnResult),
      haulerEntityIDs: buildSpawnResultEntityIDs(haulerSpawnResult),
    },
  };
}

function adoptManagedPilotIdentity(
  scene,
  entityIDs,
  options = {},
) {
  const identity =
    options.pilotIdentity &&
    typeof options.pilotIdentity === "object"
      ? options.pilotIdentity
      : null;
  const pilotCharacterID = normalizePositiveInteger(
    identity && identity.characterID,
    0,
  );
  if (!scene || pilotCharacterID <= 0) {
    return;
  }
  const pilotName = String(
    identity.characterName || "Industrial Hireling",
  ).trim();
  const actorID = String(
    options.livingUniverseActorID || "",
  ).trim();
  for (const entityID of Array.isArray(entityIDs) ? entityIDs : []) {
    const entity =
      typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : null;
    if (!entity) {
      continue;
    }
    entity.npcPilotCharacterID = pilotCharacterID;
    entity.livingUniverseActorID = actorID || null;
    entity.npcRole = String(
      options.managedRole ||
        entity.npcRole ||
        "industrial",
    );
    entity.itemName = pilotName;
    entity.slimName = pilotName;
  }
}

function rollbackManagedMiningSpawn(entityIDs) {
  let destroyedCount = 0;
  const normalizedEntityIDs = [...new Set(
    (Array.isArray(entityIDs) ? entityIDs : [])
      .map(
        (entityID) =>
          normalizePositiveInteger(entityID, 0),
      )
      .filter((entityID) => entityID > 0),
  )];
  for (const entityID of normalizedEntityIDs.reverse()) {
    try {
      const result =
        npcService.destroyNpcControllerByEntityID(entityID, {
          removeContents: true,
        });
      if (result && result.success === true) {
        destroyedCount += 1;
      }
    } catch (_error) {
      // Continue rolling back the remaining hulls.
    }
  }
  return destroyedCount;
}

function normalizeManagedIndustrialCrewRoster(roster) {
  if (!Array.isArray(roster) || roster.length <= 0) {
    return {
      success: false,
      errorMsg: "MANAGED_INDUSTRIAL_CREW_ROSTER_REQUIRED",
    };
  }
  if (roster.length > MAX_MINING_NPC_COMMAND_SPAWN_COUNT) {
    return {
      success: false,
      errorMsg: "MANAGED_INDUSTRIAL_CREW_ROSTER_TOO_LARGE",
      data: {
        requestedCount: roster.length,
        maximumCount: MAX_MINING_NPC_COMMAND_SPAWN_COUNT,
      },
    };
  }

  const normalizedRoster = [];
  const memberIDs = new Set();
  for (let index = 0; index < roster.length; index += 1) {
    const source =
      roster[index] && typeof roster[index] === "object"
        ? roster[index]
        : {};
    const role = String(
      source.role || "",
    ).trim().toLowerCase();
    if (!MANAGED_INDUSTRIAL_CREW_ROLES.has(role)) {
      return {
        success: false,
        errorMsg: "MANAGED_INDUSTRIAL_CREW_ROLE_INVALID",
        data: {
          index,
          role: role || null,
        },
      };
    }

    const explicitProfileID = String(
      source.profileID || "",
    ).trim();
    const profileQuery = String(
      source.profileQuery || "",
    ).trim();
    let profile = explicitProfileID
      ? getNpcProfile(explicitProfileID)
      : null;
    if (!profile && !explicitProfileID && profileQuery) {
      const profileResolution =
        resolveNpcProfile(profileQuery, "");
      profile =
        profileResolution &&
        profileResolution.success === true &&
        profileResolution.data
          ? profileResolution.data
          : null;
    }
    if (!profile || !String(profile.profileID || "").trim()) {
      return {
        success: false,
        errorMsg:
          explicitProfileID || profileQuery
            ? "MANAGED_INDUSTRIAL_CREW_PROFILE_NOT_FOUND"
            : "MANAGED_INDUSTRIAL_CREW_PROFILE_REQUIRED",
        data: {
          index,
          requestedProfile:
            explicitProfileID || profileQuery || null,
        },
      };
    }

    const profileID = String(profile.profileID).trim();
    const shipTypeID = normalizePositiveInteger(
      profile.shipTypeID,
      0,
    );
    if (shipTypeID <= 0) {
      return {
        success: false,
        errorMsg:
          "MANAGED_INDUSTRIAL_CREW_PROFILE_INCOMPLETE",
        data: {
          index,
          profileID,
        },
      };
    }
    const declaredRole = String(
      profile.miningRole || "",
    ).trim().toLowerCase();
    if (declaredRole && declaredRole !== role) {
      return {
        success: false,
        errorMsg:
          "MANAGED_INDUSTRIAL_CREW_PROFILE_ROLE_MISMATCH",
        data: {
          index,
          profileID,
          requestedRole: role,
          profileRole: declaredRole,
        },
      };
    }

    const memberID =
      String(source.memberID || "").trim() ||
      `${role}:${index + 1}`;
    if (memberIDs.has(memberID)) {
      return {
        success: false,
        errorMsg:
          "MANAGED_INDUSTRIAL_CREW_MEMBER_DUPLICATE",
        data: {
          index,
          memberID,
        },
      };
    }
    memberIDs.add(memberID);
    normalizedRoster.push({
      ...source,
      index,
      memberID,
      role,
      profileID,
      shipTypeID,
      profile,
      pilotIdentity:
        source.pilotIdentity &&
        typeof source.pilotIdentity === "object"
          ? { ...source.pilotIdentity }
          : null,
      livingUniverseActorID:
        String(
          source.livingUniverseActorID || "",
        ).trim() || null,
    });
  }

  if (
    !normalizedRoster.some(
      (member) => member.role === "miner",
    )
  ) {
    return {
      success: false,
      errorMsg: "MANAGED_INDUSTRIAL_CREW_MINER_REQUIRED",
    };
  }
  return {
    success: true,
    data: {
      roster: normalizedRoster,
    },
  };
}

function rollbackManagedIndustrialCrewSpawn(
  entityIDs,
  fleetRecord = null,
) {
  if (fleetRecord && toInt(fleetRecord.fleetID, 0) > 0) {
    miningFleetStateByID.delete(
      toInt(fleetRecord.fleetID, 0),
    );
  }
  return rollbackManagedMiningSpawn(entityIDs);
}

function resolveManagedIndustrialCrewMemberAffiliation(member) {
  const identity =
    member &&
    member.pilotIdentity &&
    typeof member.pilotIdentity === "object"
      ? member.pilotIdentity
      : null;
  const pilotCharacterID = normalizePositiveInteger(
    identity && identity.characterID,
    0,
  );
  const corporationID = normalizePositiveInteger(
    identity && identity.corporationID,
    0,
  );
  if (pilotCharacterID <= 0 || corporationID <= 0) {
    return {
      success: false,
      errorMsg:
        pilotCharacterID <= 0
          ? "MANAGED_INDUSTRIAL_CREW_PILOT_IDENTITY_REQUIRED"
          : "MANAGED_INDUSTRIAL_CREW_CORPORATION_IDENTITY_REQUIRED",
    };
  }
  return {
    success: true,
    data: {
      pilotCharacterID,
      corporationID,
      allianceID: Math.max(
        0,
        toInt(identity.allianceID, 0),
      ),
      warFactionID: Math.max(
        0,
        toInt(
          identity.warFactionID ??
            identity.militiaFactionID,
          0,
        ),
      ),
    },
  };
}

function validateManagedIndustrialCrewMemberPresentation(
  entity,
  entityRecord,
  affiliation,
) {
  if (
    !entity ||
    !entityRecord ||
    !affiliation
  ) {
    return {
      success: false,
      errorMsg:
        "MANAGED_INDUSTRIAL_CREW_PRESENTATION_REQUIRED",
    };
  }
  const expected = {
    ownerID: affiliation.pilotCharacterID,
    corporationID: affiliation.corporationID,
    allianceID: affiliation.allianceID,
    warFactionID: affiliation.warFactionID,
  };
  const actualEntity = {
    ownerID: normalizePositiveInteger(entity.ownerID, 0),
    corporationID: normalizePositiveInteger(
      entity.corporationID,
      0,
    ),
    allianceID: Math.max(0, toInt(entity.allianceID, 0)),
    warFactionID: Math.max(
      0,
      toInt(entity.warFactionID, 0),
    ),
  };
  const actualRecord = {
    ownerID: normalizePositiveInteger(
      entityRecord.ownerID,
      0,
    ),
    corporationID: normalizePositiveInteger(
      entityRecord.corporationID,
      0,
    ),
    allianceID: Math.max(
      0,
      toInt(entityRecord.allianceID, 0),
    ),
    warFactionID: Math.max(
      0,
      toInt(entityRecord.warFactionID, 0),
    ),
  };
  if (
    Object.keys(expected).some(
      (key) =>
        actualEntity[key] !== expected[key] ||
        actualRecord[key] !== expected[key],
    )
  ) {
    return {
      success: false,
      errorMsg:
        "MANAGED_INDUSTRIAL_CREW_AFFILIATION_MISMATCH",
      data: {
        expected,
        actualEntity,
        actualRecord,
      },
    };
  }
  if (
    entity.nativeNpc !== true ||
    entity.nativeNpcOccupied !== true ||
    entityRecord.nativeNpc !== true ||
    entityRecord.nativeNpcOccupied !== true ||
    entityRecord.loadoutGoverned !== true
  ) {
    return {
      success: false,
      errorMsg:
        "MANAGED_INDUSTRIAL_CREW_NATIVE_GOVERNANCE_REQUIRED",
    };
  }
  const entityBounty = Number(entity.bounty);
  const recordBounty = Number(entityRecord.bounty);
  if (
    !Number.isFinite(entityBounty) ||
    entityBounty !== 0 ||
    !Number.isFinite(recordBounty) ||
    recordBounty !== 0
  ) {
    return {
      success: false,
      errorMsg:
        "MANAGED_INDUSTRIAL_CREW_ZERO_BOUNTY_REQUIRED",
    };
  }
  if (
    normalizePositiveInteger(entity.characterID, 0) > 0 ||
    normalizePositiveInteger(
      entity.pilotCharacterID,
      0,
    ) > 0 ||
    normalizePositiveInteger(
      entity.npcPilotCharacterID,
      0,
    ) !== affiliation.pilotCharacterID
  ) {
    return {
      success: false,
      errorMsg:
        "MANAGED_INDUSTRIAL_CREW_PILOT_PRESENTATION_MISMATCH",
    };
  }
  return {
    success: true,
  };
}

function applyManagedIndustrialCrewMemberState(
  scene,
  member,
  entityID,
  options = {},
) {
  if (member.role === "hauler") {
    applyPassiveMiningFleetOverrides(entityID, {
      movementMode: "stop",
      orbitDistanceMeters: 500,
      followRangeMeters: 500,
      idleAnchorOrbit: false,
      idleAnchorOrbitDistanceMeters: 500,
      clearCombatPreference: true,
    });
  } else if (member.role === "mining_support") {
    applyPassiveMiningFleetOverrides(entityID, {
      movementMode: "orbit",
      orbitDistanceMeters: 3_500,
      followRangeMeters: 1_500,
      idleAnchorOrbit: false,
      issueStopOrder: false,
      clearCombatPreference: true,
    });
  } else {
    applyPassiveMiningFleetOverrides(entityID, {
      movementMode: "orbit",
      orbitDistanceMeters: 1_200,
      followRangeMeters: 800,
      idleAnchorOrbit: false,
      issueStopOrder: false,
      clearCombatPreference: true,
    });
  }

  adoptManagedPilotIdentity(scene, [entityID], {
    ...options,
    ...member,
    pilotIdentity:
      member.pilotIdentity || options.pilotIdentity,
    livingUniverseActorID:
      String(
        member.livingUniverseActorID || "",
      ).trim() ||
      String(
        options.livingUniverseActorID || "",
      ).trim() ||
      null,
    managedRole: member.role,
  });
  const entity =
    scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(entityID)
      : null;
  if (!entity) {
    return false;
  }
  entity.npcRole = member.role;
  entity.managedIndustrialCrewMemberID = member.memberID;
  entity.managedIndustrialCrewProfileID =
    member.profileID;
  entity.managedIndustrialCrewRole = member.role;
  return true;
}

/**
 * Materialize one exact mixed industrial crew. The caller owns any physical
 * budget reservation and must reserve the complete roster before invoking
 * this operation.
 *
 * The roster is fully resolved before the first spawn. Each member then gets
 * exactly one requested profile, the entire crew warps in as one batch, and
 * the managed fleet is registered only after every hull and member identity
 * has been validated. Any failure destroys every hull created by this call.
 */
function spawnManagedIndustrialMiningCrew(
  scene,
  options = {},
) {
  const owner = normalizeManagedMiningOwner(options);
  if (!scene || !owner.operatorKind || !owner.operatorID) {
    return {
      success: false,
      errorMsg: "MANAGED_MINING_OWNER_REQUIRED",
    };
  }
  const rosterResult =
    normalizeManagedIndustrialCrewRoster(options.roster);
  if (!rosterResult.success || !rosterResult.data) {
    return rosterResult;
  }

  const centerTarget =
    options.centerTarget || buildSpawnTarget(scene);
  const systemID = normalizePositiveInteger(
    scene.systemID,
    0,
  );
  if (
    !systemID ||
    !centerTarget ||
    !centerTarget.position
  ) {
    return {
      success: false,
      errorMsg:
        "MANAGED_INDUSTRIAL_CREW_SPAWN_TARGET_REQUIRED",
    };
  }
  const centerScope =
    resolveEntityInteractionScope(centerTarget);
  if (!centerScope.valid) {
    return {
      success: false,
      errorMsg:
        "MANAGED_INDUSTRIAL_CREW_SCOPE_INVALID",
    };
  }
  // The destination target is authoritative for interaction visibility.
  // Always forward an explicit child-scope object, including {} for normal
  // unscoped space, rather than allowing the spawn resolver to infer it.
  const entityScopeMetadata =
    buildChildEntityScopeMetadata(centerTarget);

  ensureSceneMiningState(scene);
  const originAnchor =
    options.originAnchor ||
    buildOffgridOriginAnchor(scene, centerTarget);
  if (!originAnchor || !originAnchor.position) {
    return {
      success: false,
      errorMsg:
        "MANAGED_INDUSTRIAL_CREW_ORIGIN_REQUIRED",
    };
  }

  const roster = rosterResult.data.roster;
  const spawnedEntityIDs = [];
  const memberBindings = [];
  let fleetRecord = null;
  const fail = (errorMsg, data = {}) => {
    const rolledBackEntityCount =
      rollbackManagedIndustrialCrewSpawn(
        spawnedEntityIDs,
        fleetRecord,
      );
    return {
      success: false,
      errorMsg: String(
        errorMsg ||
          "MANAGED_INDUSTRIAL_CREW_SPAWN_FAILED",
      ),
      data: {
        ...data,
        requestedCount: roster.length,
        rolledBackEntityCount,
      },
    };
  };

  try {
    for (const member of roster) {
      const affiliationResult =
        resolveManagedIndustrialCrewMemberAffiliation(
          member,
        );
      if (
        !affiliationResult.success ||
        !affiliationResult.data
      ) {
        return fail(
          affiliationResult.errorMsg,
          {
            failedMemberID: member.memberID,
            failedIndex: member.index,
            profileID: member.profileID,
          },
        );
      }
      const affiliation = affiliationResult.data;
      const spawnResult =
        npcService.spawnNpcBatchInSystem(systemID, {
          transient: true,
          broadcast: false,
          skipInitialBehaviorTick: true,
          entityScopeMetadata: {
            ...entityScopeMetadata,
          },
          operatorKind: owner.operatorKind,
          preferredTargetID: 0,
          anchorDescriptor: {
            kind: "coordinates",
            position: originAnchor.position,
            direction: originAnchor.direction,
            name:
              "Managed Industrial Crew Warp Origin",
          },
          profileQuery: member.profileID,
          amount: 1,
          preferPools: false,
          ownerIDOverride:
            affiliation.pilotCharacterID,
          corporationIDOverride:
            affiliation.corporationID,
          allianceIDOverride:
            affiliation.allianceID,
          warFactionIDOverride:
            affiliation.warFactionID,
        });
      const spawned =
        spawnResult &&
        spawnResult.data &&
        Array.isArray(spawnResult.data.spawned)
          ? spawnResult.data.spawned
          : [];
      const resultEntityIDs = spawned
        .map((entry) =>
          normalizePositiveInteger(
            entry &&
              entry.entity &&
              entry.entity.itemID,
            0,
          ))
        .filter((entityID) => entityID > 0);
      // Record every returned hull before validating cardinality so an
      // accidental exact-profile over-expansion is also rolled back.
      spawnedEntityIDs.push(...resultEntityIDs);
      if (
        !spawnResult ||
        spawnResult.success !== true ||
        !spawnResult.data ||
        spawned.length !== 1 ||
        resultEntityIDs.length !== 1 ||
        spawnResult.data.partialFailure
      ) {
        return fail(
          spawnResult && spawnResult.errorMsg ||
            "MANAGED_INDUSTRIAL_CREW_MEMBER_SPAWN_FAILED",
          {
            failedMemberID: member.memberID,
            failedIndex: member.index,
            profileID: member.profileID,
            spawnedCardinality: spawned.length,
          },
        );
      }

      const selectionID = String(
        spawnResult.data.selectionID || "",
      ).trim();
      const spawnedProfileID = String(
        spawned[0] &&
          spawned[0].profile &&
          spawned[0].profile.profileID ||
          "",
      ).trim();
      if (
        selectionID !== member.profileID ||
        (
          spawnedProfileID &&
          spawnedProfileID !== member.profileID
        )
      ) {
        return fail(
          "MANAGED_INDUSTRIAL_CREW_PROFILE_SELECTION_MISMATCH",
          {
            failedMemberID: member.memberID,
            failedIndex: member.index,
            profileID: member.profileID,
            selectionID: selectionID || null,
            spawnedProfileID:
              spawnedProfileID || null,
          },
        );
      }
      const entity = spawned[0] && spawned[0].entity;
      if (
        !entity ||
        toInt(entity.typeID, 0) !== member.shipTypeID
      ) {
        return fail(
          "MANAGED_INDUSTRIAL_CREW_HULL_SELECTION_MISMATCH",
          {
            failedMemberID: member.memberID,
            failedIndex: member.index,
            profileID: member.profileID,
            expectedTypeID: member.shipTypeID,
            actualTypeID: toInt(
              entity && entity.typeID,
              0,
            ),
          },
        );
      }
      if (
        !applyManagedIndustrialCrewMemberState(
          scene,
          member,
          resultEntityIDs[0],
          options,
        )
      ) {
        return fail(
          "MANAGED_INDUSTRIAL_CREW_ENTITY_NOT_FOUND",
          {
            failedMemberID: member.memberID,
            failedIndex: member.index,
            entityID: resultEntityIDs[0],
          },
        );
      }
      const presentationValidation =
        validateManagedIndustrialCrewMemberPresentation(
          entity,
          spawned[0] && spawned[0].entityRecord,
          affiliation,
        );
      if (!presentationValidation.success) {
        return fail(
          presentationValidation.errorMsg,
          {
            failedMemberID: member.memberID,
            failedIndex: member.index,
            entityID: resultEntityIDs[0],
            ...(
              presentationValidation.data || {}
            ),
          },
        );
      }
      memberBindings.push({
        memberID: member.memberID,
        index: member.index,
        entityID: resultEntityIDs[0],
        role: member.role,
        profileID: member.profileID,
        pilotIdentity:
          member.pilotIdentity
            ? { ...member.pilotIdentity }
            : null,
        livingUniverseActorID:
          member.livingUniverseActorID || null,
      });
    }

    const landingRadiusMeters = Math.max(
      500,
      toFiniteNumber(
        options.landingRadiusMeters,
        toFiniteNumber(
          config.miningNpcFleetLandingRadiusMeters,
          DEFAULT_MINING_WARP_LANDING_RADIUS_METERS,
        ),
      ),
    );
    const ingressDurationMs = Math.max(
      250,
      toFiniteNumber(
        config.miningNpcWarpIngressDurationMs,
        DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
      ),
    );
    const warpResult =
      npcService.runtime.warpBatchToPoints(
        memberBindings.map((binding, index) => ({
          entityID: binding.entityID,
          point: buildMiningWarpLandingPoint(
            centerTarget.position,
            index,
            memberBindings.length,
            landingRadiusMeters,
          ),
          options: {
            forceImmediateStart: true,
            broadcastWarpStartToVisibleSessions: true,
            visibilitySuppressMs: 250,
            ingressDurationMs,
          },
        })),
        {
          groupWake: true,
        },
      );
    if (!warpResult || warpResult.success !== true) {
      return fail(
        warpResult && warpResult.errorMsg ||
          "MANAGED_INDUSTRIAL_CREW_WARP_FAILED",
      );
    }

    const minerEntityIDs = memberBindings
      .filter((binding) => binding.role === "miner")
      .map((binding) => binding.entityID);
    const supportEntityIDs = memberBindings
      .filter(
        (binding) =>
          binding.role === "mining_support",
      )
      .map((binding) => binding.entityID);
    const haulerEntityIDs = memberBindings
      .filter((binding) => binding.role === "hauler")
      .map((binding) => binding.entityID);
    const lifecycleMinerEntityIDs = [
      ...minerEntityIDs,
      ...supportEntityIDs,
    ];

    fleetRecord = createMiningFleetRecord({
      ...options,
      ...owner,
      scene,
      source: String(
        options.source ||
          "managed_industrial_crew",
      ),
      physicalShipLimit: roster.length,
      systemID,
      targetShipID: normalizePositiveInteger(
        options.targetShipID || centerTarget.itemID,
        0,
      ),
      minerEntityIDs: lifecycleMinerEntityIDs,
      miningWorkerEntityIDs: minerEntityIDs,
      miningSupportEntityIDs: supportEntityIDs,
      haulerEntityIDs,
      responseEntityIDs: [],
      managedRoster: memberBindings,
      originAnchor,
      spawnSelectionName:
        String(
          options.spawnSelectionName || "",
        ).trim() ||
        roster
          .filter(
            (member) => member.role !== "hauler",
          )
          .map((member) => member.profileID)
          .join(", "),
      haulerSelectionName:
        String(
          options.haulerSelectionName || "",
        ).trim() ||
        roster
          .filter(
            (member) => member.role === "hauler",
          )
          .map((member) => member.profileID)
          .join(", ") ||
        null,
      onGridSupport: true,
      state: "mining",
      haulerNextArrivalAtMs: 0,
    });
    fleetRecord.memberBindings =
      fleetRecord.managedRoster;
    return {
      success: true,
      data: {
        fleetRecord,
        entityIDs: memberBindings.map(
          (binding) => binding.entityID,
        ),
        minerEntityIDs,
        supportEntityIDs,
        haulerEntityIDs,
        memberBindings: memberBindings.map(
          (binding) => ({ ...binding }),
        ),
        roster: memberBindings.map(
          (binding) => ({ ...binding }),
        ),
      },
    };
  } catch (error) {
    return fail(
      "MANAGED_INDUSTRIAL_CREW_SPAWN_EXCEPTION",
      {
        message: String(
          error && error.message || error,
        ),
      },
    );
  }
}

function spawnManagedMiningFleet(scene, options = {}) {
  const owner = normalizeManagedMiningOwner(options);
  if (!scene || !owner.operatorKind || !owner.operatorID) {
    return {
      success: false,
      errorMsg: "MANAGED_MINING_OWNER_REQUIRED",
    };
  }
  const minerAmount = Math.max(
    1,
    toInt(
      options.minerAmount,
      toInt(
        config.miningNpcFleetDefaultCount,
        DEFAULT_MINING_FLEET_COUNT,
      ),
    ),
  );
  const haulerAmount = Math.max(
    0,
    toInt(
      options.haulerAmount,
      toInt(
        config.miningNpcHaulerDefaultCount,
        DEFAULT_MINING_HAULER_COUNT,
      ),
    ),
  );
  const physicalShipLimit = Math.max(
    1,
    toInt(
      options.physicalShipLimit,
      minerAmount + haulerAmount,
    ),
  );
  ensureSceneMiningState(scene);
  const spawnResult = spawnMiningFleetInternal(scene, {
    ...options,
    ...owner,
    systemID: scene.systemID,
    minerAmount,
    haulerAmount,
    physicalShipLimit,
  });
  if (!spawnResult.success || !spawnResult.data) {
    return spawnResult;
  }

  const entityIDs = [...new Set([
    ...(spawnResult.data.minerEntityIDs || []),
    ...(spawnResult.data.haulerEntityIDs || []),
  ])];
  if (
    entityIDs.length <= 0 ||
    entityIDs.length > physicalShipLimit
  ) {
    const rolledBackEntityCount =
      rollbackManagedMiningSpawn(entityIDs);
    return {
      success: false,
      errorMsg:
        entityIDs.length <= 0
          ? "MANAGED_MINING_SPAWN_EMPTY"
          : "MANAGED_MINING_PHYSICAL_LIMIT_EXCEEDED",
      data: {
        physicalShipLimit,
        actualShipCount: entityIDs.length,
        rolledBackEntityCount,
      },
    };
  }

  adoptManagedPilotIdentity(scene, entityIDs, options);
  let fleetRecord;
  try {
    fleetRecord = createMiningFleetRecord({
      ...options,
      ...owner,
      scene,
      source: String(options.source || "managed"),
      physicalShipLimit,
      systemID: scene.systemID,
      minerEntityIDs: spawnResult.data.minerEntityIDs,
      haulerEntityIDs: spawnResult.data.haulerEntityIDs,
      originAnchor: spawnResult.data.originAnchor,
      spawnSelectionName:
        spawnResult.data.minerSpawnResult &&
        spawnResult.data.minerSpawnResult.data &&
        spawnResult.data.minerSpawnResult.data.selectionName,
      haulerSelectionName:
        spawnResult.data.haulerSpawnResult &&
        spawnResult.data.haulerSpawnResult.data &&
        spawnResult.data.haulerSpawnResult.data.selectionName,
    });
  } catch (error) {
    const rolledBackEntityCount =
      rollbackManagedMiningSpawn(entityIDs);
    return {
      success: false,
      errorMsg: "MANAGED_MINING_FLEET_REGISTER_FAILED",
      data: {
        message: String(error && error.message || error),
        rolledBackEntityCount,
      },
    };
  }
  return {
    success: true,
    data: {
      fleetRecord,
      entityIDs,
    },
  };
}

function spawnManagedMiningHauler(scene, options = {}) {
  const owner = normalizeManagedMiningOwner(options);
  const containerID = normalizePositiveInteger(
    options.externalContainerID,
    0,
  );
  const containerEntity =
    scene && typeof scene.getEntityByID === "function"
      ? scene.getEntityByID(containerID)
      : null;
  if (
    !scene ||
    !owner.operatorKind ||
    !owner.operatorID ||
    !containerEntity ||
    !containerEntity.position
  ) {
    return {
      success: false,
      errorMsg: "MANAGED_MINING_HAULER_TARGET_REQUIRED",
    };
  }
  const centerTarget = options.centerTarget || containerEntity;
  const containerScope =
    resolveEntityInteractionScope(containerEntity);
  const centerScope =
    resolveEntityInteractionScope(centerTarget);
  if (
    !containerScope.valid ||
    !centerScope.valid ||
    !canEntitiesInteractLocally(
      centerTarget,
      containerEntity,
    )
  ) {
    return {
      success: false,
      errorMsg: "MANAGED_MINING_HAULER_SCOPE_MISMATCH",
    };
  }

  ensureSceneMiningState(scene);
  const originAnchor =
    options.originAnchor ||
    buildOffgridOriginAnchor(scene, containerEntity);
  const resolvedHaulerQuery = resolveMiningHaulerQuery(
    scene,
    options.haulerQuery,
    scene.systemID,
  );
  const physicalShipLimit = Math.max(
    1,
    toInt(options.physicalShipLimit, 1),
  );
  const spawnResult = spawnFleetWing(
    scene.systemID,
    containerEntity,
    {
      amount: 1,
      profileQuery: resolvedHaulerQuery,
      entityScopeMetadata:
        buildChildEntityScopeMetadata(containerEntity),
      preferredTargetID: 0,
      originAnchor,
      warpIn: true,
      landingRadiusMeters: toFiniteNumber(
        config.miningNpcFleetLandingRadiusMeters,
        DEFAULT_MINING_WARP_LANDING_RADIUS_METERS,
      ),
      operatorKind: owner.operatorKind,
      physicalShipLimit,
    },
  );
  if (!spawnResult.success || !spawnResult.data) {
    return spawnResult;
  }
  const haulerEntityIDs =
    buildSpawnResultEntityIDs(spawnResult);
  if (
    haulerEntityIDs.length <= 0 ||
    haulerEntityIDs.length > physicalShipLimit
  ) {
    const rolledBackEntityCount =
      rollbackManagedMiningSpawn(haulerEntityIDs);
    return {
      success: false,
      errorMsg:
        haulerEntityIDs.length <= 0
          ? "MANAGED_MINING_HAULER_SPAWN_EMPTY"
          : "MANAGED_MINING_PHYSICAL_LIMIT_EXCEEDED",
      data: {
        physicalShipLimit,
        actualShipCount: haulerEntityIDs.length,
        rolledBackEntityCount,
      },
    };
  }

  adoptManagedPilotIdentity(
    scene,
    haulerEntityIDs,
    options,
  );
  for (const entityID of haulerEntityIDs) {
    applyPassiveMiningFleetOverrides(entityID, {
      movementMode: "approach",
      orbitDistanceMeters: 500,
      followRangeMeters: 500,
      idleAnchorOrbit: false,
      clearCombatPreference: true,
    });
  }

  let fleetRecord;
  try {
    fleetRecord = createMiningFleetRecord({
      ...options,
      ...owner,
      scene,
      source: String(
        options.source || "managed_hauler",
      ),
      physicalShipLimit,
      systemID: scene.systemID,
      minerEntityIDs: [],
      haulerEntityIDs,
      originAnchor,
      haulerSelectionName:
        spawnResult.data.selectionName ||
        resolvedHaulerQuery,
      onGridSupport: true,
      state: "mining",
      haulerNextArrivalAtMs: 0,
    });
    fleetRecord.jetcanRecordsByID[String(containerID)] = {
      containerID,
      minerEntityID: 0,
      createdAtMs: Math.max(
        0,
        toInt(options.createdAtMs, Date.now()),
      ),
      sealedAtMs: Math.max(
        1,
        toInt(options.createdAtMs, Date.now()),
      ),
      tractorStartedAtMs: 0,
      pickupRangeReachedAtMs: 0,
      collectedAtMs: 0,
      external: true,
    };
  } catch (error) {
    if (fleetRecord) {
      miningFleetStateByID.delete(fleetRecord.fleetID);
    }
    const rolledBackEntityCount =
      rollbackManagedMiningSpawn(haulerEntityIDs);
    return {
      success: false,
      errorMsg: "MANAGED_MINING_HAULER_REGISTER_FAILED",
      data: {
        message: String(error && error.message || error),
        rolledBackEntityCount,
      },
    };
  }
  return {
    success: true,
    data: {
      fleetRecord,
      entityIDs: [...haulerEntityIDs],
    },
  };
}

function issueResponseOrders(responseEntityIDs = [], aggressorEntityID = 0) {
  const normalizedAggressorEntityID = normalizePositiveInteger(aggressorEntityID, 0);
  for (const entityID of Array.isArray(responseEntityIDs) ? responseEntityIDs : []) {
    npcService.setBehaviorOverrides(entityID, {
      autoAggro: true,
      autoActivateWeapons: true,
      autoAggroTargetClasses: [ENTITY_TYPE.PLAYER],
      targetPreference: "preferredTargetThenNearestPlayer",
      movementMode: "orbit",
      orbitDistanceMeters: 1_800,
      followRangeMeters: 1_500,
      aggressionRangeMeters: 250_000,
      idleAnchorOrbit: false,
      returnToHomeWhenIdle: true,
      leashRangeMeters: 250_000,
    });
    if (normalizedAggressorEntityID > 0) {
      npcService.issueManualOrder(entityID, {
        type: "attack",
        targetID: normalizedAggressorEntityID,
        allowWeapons: true,
        keepLock: true,
        movementMode: "orbit",
        orbitDistanceMeters: 1_800,
      });
    }
    npcService.wakeNpcController(entityID, 0);
  }
}

function retreatResponseWingToOrigin(fleetRecord, options = {}) {
  if (!fleetRecord || !fleetRecord.originAnchor || !fleetRecord.originAnchor.position) {
    return 0;
  }
  const ingressDurationMs = Math.max(
    250,
    toFiniteNumber(
      config.miningNpcWarpIngressDurationMs,
      DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
    ),
  );
  let retreatedCount = 0;
  for (const entityID of Array.isArray(fleetRecord.responseEntityIDs) ? fleetRecord.responseEntityIDs : []) {
    if (!npcService.getControllerByEntityID(entityID)) {
      continue;
    }
    npcService.issueManualOrder(entityID, {
      type: "returnHome",
      allowWeapons: false,
    });
    npcService.runtime.warpToPoint(entityID, fleetRecord.originAnchor.position, {
      forceImmediateStart: true,
      broadcastWarpStartToVisibleSessions: true,
      visibilitySuppressMs: 250,
      ingressDurationMs,
    });
    retreatedCount += 1;
  }
  if (retreatedCount > 0) {
    fleetRecord.responseRetreating = true;
    fleetRecord.responseTargetID = 0;
    fleetRecord.responseDespawnAtMs = Math.max(
      0,
      toInt(options.nowMs, 0) + ingressDurationMs,
    );
  }
  return retreatedCount;
}

function destroyResponseWing(fleetRecord) {
  let destroyedCount = 0;
  for (const entityID of Array.isArray(fleetRecord && fleetRecord.responseEntityIDs) ? fleetRecord.responseEntityIDs : []) {
    const destroyResult = npcService.destroyNpcControllerByEntityID(entityID, {
      removeContents: true,
    });
    if (destroyResult && destroyResult.success) {
      destroyedCount += 1;
    }
  }
  fleetRecord.responseEntityIDs = [];
  fleetRecord.responseTargetID = 0;
  fleetRecord.responseDespawnAtMs = 0;
  fleetRecord.responseRetreating = false;
  return destroyedCount;
}

function spawnResponseWingForFleet(scene, fleetRecord, aggressorEntity, responsePlan, options = {}) {
  if (
    !scene ||
    !fleetRecord ||
    !aggressorEntity ||
    !responsePlan ||
    responsePlan.amount <= 0 ||
    !String(responsePlan.profileQuery || "").trim()
  ) {
    return {
      success: true,
      data: {
        spawnedEntityIDs: [],
        standingProfile: responsePlan ? responsePlan.standingProfile : null,
        selectionName: null,
      },
    };
  }

  const spawnResult = spawnFleetWing(scene.systemID, aggressorEntity, {
    amount: responsePlan.amount,
    profileQuery: responsePlan.profileQuery,
    entityScopeMetadata: buildChildEntityScopeMetadata(aggressorEntity),
    preferredTargetID: normalizePositiveInteger(aggressorEntity.itemID, 0),
    originAnchor: fleetRecord.originAnchor,
    warpIn: true,
    landingRadiusMeters: toFiniteNumber(
      config.miningNpcFleetLandingRadiusMeters,
      DEFAULT_MINING_WARP_LANDING_RADIUS_METERS,
    ),
  });
  if (!spawnResult.success || !spawnResult.data) {
    return spawnResult;
  }

  const spawnedEntityIDs = buildSpawnResultEntityIDs(spawnResult);
  issueResponseOrders(
    spawnedEntityIDs,
    normalizePositiveInteger(aggressorEntity.itemID, 0),
  );
  fleetRecord.responseEntityIDs.push(...spawnedEntityIDs);
  fleetRecord.responseSelectionName =
    spawnResult.data.selectionName ||
    String(responsePlan.profileQuery || "").trim() ||
    null;
  fleetRecord.responseTargetID = normalizePositiveInteger(aggressorEntity.itemID, 0);
  fleetRecord.responseRetreating = false;
  fleetRecord.responseStandingClass =
    responsePlan.standingProfile && responsePlan.standingProfile.standingClass
      ? responsePlan.standingProfile.standingClass
      : null;
  fleetRecord.responseStandingValue =
    responsePlan.standingProfile && Number.isFinite(responsePlan.standingProfile.standing)
      ? responsePlan.standingProfile.standing
      : 0;
  fleetRecord.lastResponseAtMs = Math.max(0, toInt(options.nowMs, Date.now()));
  fleetRecord.responseDespawnAtMs =
    fleetRecord.lastResponseAtMs + getResponseRetreatDelayMs();
  return {
    success: true,
    data: {
      spawnedEntityIDs,
      standingProfile: responsePlan.standingProfile || null,
      selectionName: fleetRecord.responseSelectionName,
    },
  };
}

function triggerFleetAggression(scene, fleetRecord, options = {}) {
  if (!scene || !fleetRecord) {
    return {
      success: false,
      errorMsg: "SCENE_NOT_FOUND",
    };
  }

  const now = Math.max(0, toInt(options.nowMs, Date.now()));
  const aggressorEntity =
    options.aggressorEntity ||
    scene.getEntityByID(normalizePositiveInteger(options.aggressorEntityID, 0)) ||
    null;
  if (!aggressorEntity) {
    return {
      success: false,
      errorMsg: "AGGRESSOR_NOT_FOUND",
    };
  }

  const aggressionEventAtMs = Math.max(
    0,
    toInt(options.aggressionEventAtMs, now),
  );
  if (
    options.force !== true &&
    aggressionEventAtMs > 0 &&
    aggressionEventAtMs <= Math.max(0, toInt(fleetRecord.lastProcessedAggressionAtMs, 0))
  ) {
    return {
      success: true,
      data: {
        noChange: true,
        standingClass: fleetRecord.responseStandingClass || null,
        retreatedCount: 0,
        responseSpawnedCount: 0,
      },
    };
  }

  if (isManagedIndustrialMiningFleet(fleetRecord)) {
    const aggressorEntityID =
      normalizePositiveInteger(
        aggressorEntity.itemID,
        0,
      );
    fleetRecord.lastAggressorID = aggressorEntityID;
    fleetRecord.lastAggressedAtMs =
      aggressionEventAtMs || now;
    fleetRecord.lastProcessedAggressionAtMs =
      aggressionEventAtMs || now;
    fleetRecord.responseTargetID = aggressorEntityID;
    fleetRecord.responseStandingClass = null;
    fleetRecord.responseStandingValue = 0;
    if (fleetRecord.responseEntityIDs.length > 0) {
      destroyResponseWing(fleetRecord);
    }

    const assessment = options.panic === true
      ? {
          engage: false,
          reason: "PANIC_ORDER",
        }
      : assessManagedIndustrialThreat(
          scene,
          fleetRecord,
          aggressorEntity,
        );
    if (assessment.engage === true) {
      const participatingFleets = (
        Array.isArray(assessment.participatingFleets) &&
        assessment.participatingFleets.length > 0
          ? assessment.participatingFleets
          : [fleetRecord]
      );
      for (const participatingFleet of participatingFleets) {
        clearFleetManualOrders([
          ...participatingFleet.minerEntityIDs,
          ...participatingFleet.haulerEntityIDs,
        ]);
        deactivateMiningModulesForFleet(
          scene,
          participatingFleet,
          options.hooks,
          "defense",
        );
      }
      const defenseResult =
        beginManagedFleetDroneDefense(
          scene,
          fleetRecord,
          aggressorEntity,
          assessment,
          { nowMs: now },
        );
      if (defenseResult.success === true) {
        const defenseDecision = {
          reason: assessment.reason,
          targetSizeClass:
            assessment.targetSizeClass,
          defensePower: assessment.defensePower,
          threatPower: assessment.threatPower,
          requiredOvermatch:
            assessment.requiredOvermatch,
          participatingFleetCount:
            participatingFleets.length,
          participatingFleetIDs:
            participatingFleets.map(
              (participatingFleet) =>
                toInt(
                  participatingFleet.fleetID,
                  0,
                ),
            ),
          decidedAtMs: now,
        };
        for (const participatingFleet of participatingFleets) {
          participatingFleet.state = "defending";
          participatingFleet.resumeAtMs = 0;
          participatingFleet.lastAggressorID =
            aggressorEntityID;
          participatingFleet.lastAggressedAtMs =
            aggressionEventAtMs || now;
          participatingFleet.lastProcessedAggressionAtMs =
            aggressionEventAtMs || now;
          participatingFleet.responseTargetID =
            aggressorEntityID;
          participatingFleet.defenseDecision = {
            ...defenseDecision,
          };
        }
        return {
          success: true,
          data: {
            standingClass: null,
            standingValue: 0,
            defended: true,
            defenseDecision:
              defenseDecision,
            defensiveFlightCount: toInt(
              defenseResult.data &&
                defenseResult.data.flightCount,
              0,
            ),
            retreatedCount: 0,
            responseSpawnedCount: 0,
            responseSelectionName: null,
          },
        };
      }
      assessment.reason =
        defenseResult.errorMsg ||
        "DEFENSE_LAUNCH_FAILED";
    }

    const retreatedCount = retreatFleetToOrigin(
      fleetRecord,
      {
        state:
          options.panic === true
            ? "panic"
            : "aggressed",
        resumeAtMs:
          now +
          Math.max(
            1_000,
            toInt(
              config
                .miningNpcManagedDefenseRetreatCooldownMs,
              DEFAULT_MANAGED_MINING_DEFENSE_RETREAT_COOLDOWN_MS,
            ),
          ),
        scene,
        hooks: options.hooks,
        nowMs: now,
        reason: String(
          assessment.reason || "unsafe_threat",
        ).toLowerCase(),
      },
    );
    fleetRecord.defenseDecision = {
      reason:
        assessment.reason || "UNSAFE_THREAT",
      targetSizeClass:
        assessment.targetSizeClass || null,
      decidedAtMs: now,
    };
    return {
      success: true,
      data: {
        standingClass: null,
        standingValue: 0,
        defended: false,
        defenseDecision:
          fleetRecord.defenseDecision,
        retreatedCount,
        responseSpawnedCount: 0,
        responseSelectionName: null,
      },
    };
  }

  const autoResumeDelayMs = Math.max(
    0,
    toInt(
      config.miningNpcFleetAutoResumeDelayMs,
      0,
    ),
  );
  const responsePlan = resolveResponsePlan(scene, fleetRecord, aggressorEntity, {
    amount: options.responseAmount,
    profileQuery: options.responseQuery,
  });
  const retreatedCount = retreatFleetToOrigin(fleetRecord, {
    state: options.panic === true ? "panic" : "aggressed",
    resumeAtMs: autoResumeDelayMs > 0 ? (now + autoResumeDelayMs) : 0,
    scene,
    hooks: options.hooks,
    nowMs: now,
    reason: "aggression",
  });
  fleetRecord.lastAggressorID = normalizePositiveInteger(aggressorEntity.itemID, 0);
  fleetRecord.lastAggressedAtMs = aggressionEventAtMs || now;
  fleetRecord.lastProcessedAggressionAtMs = aggressionEventAtMs || now;
  fleetRecord.responseTargetID = normalizePositiveInteger(aggressorEntity.itemID, 0);

  let responseSpawnedCount = 0;
  let responseSelectionName = fleetRecord.responseSelectionName || null;
  const cooldownMs = getResponseCooldownMs();
  const hasDeployableResponse =
    responsePlan.amount > 0 &&
    String(responsePlan.profileQuery || "").trim().length > 0;
  const canSpawnResponse =
    hasDeployableResponse &&
    (
      fleetRecord.lastResponseAtMs <= 0 ||
      cooldownMs <= 0 ||
      now - fleetRecord.lastResponseAtMs >= cooldownMs ||
      fleetRecord.responseEntityIDs.length <= 0
    );

  if (canSpawnResponse) {
    const spawnResult = spawnResponseWingForFleet(
      scene,
      fleetRecord,
      aggressorEntity,
      responsePlan,
      { nowMs: now },
    );
    if (!spawnResult.success) {
      return spawnResult;
    }
    responseSpawnedCount = Array.isArray(spawnResult.data && spawnResult.data.spawnedEntityIDs)
      ? spawnResult.data.spawnedEntityIDs.length
      : 0;
    responseSelectionName = spawnResult.data && spawnResult.data.selectionName
      ? spawnResult.data.selectionName
      : responseSelectionName;
  } else if (fleetRecord.responseEntityIDs.length > 0) {
    issueResponseOrders(
      fleetRecord.responseEntityIDs,
      normalizePositiveInteger(aggressorEntity.itemID, 0),
    );
    fleetRecord.responseDespawnAtMs = now + getResponseRetreatDelayMs();
  }

  return {
    success: true,
    data: {
      standingClass:
        responsePlan.standingProfile && responsePlan.standingProfile.standingClass
          ? responsePlan.standingProfile.standingClass
          : null,
      standingValue:
        responsePlan.standingProfile && Number.isFinite(responsePlan.standingProfile.standing)
          ? responsePlan.standingProfile.standing
          : 0,
      retreatedCount,
      responseSpawnedCount,
      responseSelectionName,
    },
  };
}

function handleMiningFleetCommand(session, argumentText) {
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      message: "You must be in space before using /npcminer.",
    };
  }

  const parsedArguments = parseNpcSpawnArguments(
    argumentText,
    Math.max(1, toInt(config.miningNpcFleetDefaultCount, DEFAULT_MINING_FLEET_COUNT)),
  );
  if (!parsedArguments.success) {
    return {
      success: false,
      message: "Usage: /npcminer [amount] [profile|pool|group]",
    };
  }
  if (parsedArguments.amount > MAX_MINING_NPC_COMMAND_SPAWN_COUNT) {
    return {
      success: false,
      message: `Mining fleet spawn count must be between 1 and ${MAX_MINING_NPC_COMMAND_SPAWN_COUNT}.`,
    };
  }

  const scene = resolveSessionScene(session);
  const centerTarget = buildSpawnTarget(scene, session);
  const spawnResult = spawnMiningFleetInternal(scene, {
    systemID: session._space.systemID,
    centerTarget,
    preferredTargetID: normalizePositiveInteger(session._space.shipID, 0),
    minerAmount: parsedArguments.amount,
    minerQuery: parsedArguments.query || String(config.miningNpcFleetProfileOrPool || ""),
    haulerAmount: Math.max(0, toInt(config.miningNpcHaulerDefaultCount, DEFAULT_MINING_HAULER_COUNT)),
    haulerQuery: String(config.miningNpcHaulerProfileOrPool || ""),
  });
  if (!spawnResult.success || !spawnResult.data) {
    const suggestions = Array.isArray(spawnResult && spawnResult.suggestions)
      ? ` Suggestions: ${spawnResult.suggestions.join(", ")}`
      : "";
    return {
      success: false,
      message: `Mining fleet spawn failed: ${spawnResult.errorMsg || "UNKNOWN_ERROR"}.${suggestions}`.trim(),
    };
  }

  const fleetRecord = createMiningFleetRecord({
    source: "gm",
    createdByCharacterID: session.characterID,
    systemID: session._space.systemID,
    targetShipID: session._space.shipID,
    minerEntityIDs: spawnResult.data.minerEntityIDs,
    haulerEntityIDs: spawnResult.data.haulerEntityIDs,
    originAnchor: spawnResult.data.originAnchor,
    spawnSelectionName:
      spawnResult.data.minerSpawnResult &&
      spawnResult.data.minerSpawnResult.data &&
      spawnResult.data.minerSpawnResult.data.selectionName,
    haulerSelectionName:
      spawnResult.data.haulerSpawnResult &&
      spawnResult.data.haulerSpawnResult.data &&
      spawnResult.data.haulerSpawnResult.data.selectionName,
  });
  return {
    success: true,
    message: [
      `Spawned mining fleet ${fleetRecord.fleetID} with ${fleetRecord.minerEntityIDs.length} miner hull${fleetRecord.minerEntityIDs.length === 1 ? "" : "s"}.`,
      fleetRecord.haulerEntityIDs.length > 0
        ? `Attached ${fleetRecord.haulerEntityIDs.length} hauler hull${fleetRecord.haulerEntityIDs.length === 1 ? "" : "s"}.`
        : "No hauler wing was attached.",
      `Selection: ${fleetRecord.spawnSelectionName || parsedArguments.query || resolveMiningFleetQuery(scene, "", session._space.systemID)}.`,
      "The fleet is transient only and will not persist across restart.",
    ].join(" "),
  };
}

function retreatFleetToOrigin(fleetRecord, options = {}) {
  if (!fleetRecord) {
    return 0;
  }
  if (options.scene) {
    const returnTarget =
      options.scene.getEntityByID(
        toInt(fleetRecord.activeAsteroidID, 0),
      ) ||
      options.scene.getEntityByID(
        toInt(fleetRecord.targetShipID, 0),
      ) ||
      null;
    const returnPosition =
      returnTarget && returnTarget.position ||
      buildFleetReferencePosition(
        options.scene,
        fleetRecord,
      );
    if (returnPosition) {
      fleetRecord.retreatSitePosition =
        cloneVector(returnPosition);
    }
  }
  recallManagedFleetDefensiveDrones(
    options.scene || null,
    fleetRecord,
    options.reason || "retreat",
  );
  if (
    !fleetRecord.originAnchor ||
    !fleetRecord.originAnchor.position
  ) {
    return 0;
  }
  clearFleetManualOrders([
    ...(Array.isArray(fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []),
    ...(Array.isArray(fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : []),
  ]);
  if (options.scene && options.hooks) {
    deactivateMiningModulesForFleet(
      options.scene,
      fleetRecord,
      options.hooks,
      options.reason || "state",
    );
  }
  if (options.scene) {
    deactivateMiningSupportBursts(
      options.scene,
      fleetRecord,
      options.hooks || null,
      options.reason || "state",
    );
  }
  const ingressDurationMs = Math.max(
    250,
    toFiniteNumber(
      config.miningNpcWarpIngressDurationMs,
      DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
    ),
  );
  const entityIDs = [
    ...(Array.isArray(fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []),
    ...(Array.isArray(fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : []),
  ];
  let retreatedCount = 0;
  const failedEntityIDs = [];
  const errors = [];
  for (const entityID of entityIDs) {
    if (!npcService.getControllerByEntityID(entityID)) {
      continue;
    }
    const warpResult = npcService.runtime.warpToPoint(entityID, fleetRecord.originAnchor.position, {
      forceImmediateStart: true,
      broadcastWarpStartToVisibleSessions: true,
      visibilitySuppressMs: 250,
      ingressDurationMs,
    });
    if (warpResult && warpResult.success === true) {
      retreatedCount += 1;
    } else {
      failedEntityIDs.push(entityID);
      errors.push({
        entityID,
        errorMsg:
          warpResult &&
            warpResult.errorMsg ||
          "NPC_WARP_FAILED",
      });
    }
  }
  fleetRecord.state = String(options.state || "retreating");
  fleetRecord.resumeAtMs = Math.max(0, toInt(options.resumeAtMs, 0));
  fleetRecord.retreatWarpPendingEntityIDs =
    failedEntityIDs;
  fleetRecord.nextRetreatWarpRetryAtMs =
    failedEntityIDs.length > 0
      ? Math.max(
          0,
          toInt(
            options.nowMs,
            options.scene &&
              typeof options.scene.getCurrentSimTimeMs ===
                "function"
              ? options.scene.getCurrentSimTimeMs()
              : Date.now(),
          ),
        ) + 1_000
      : 0;
  fleetRecord.lastRetreatWarpErrors = errors;
  fleetRecord.nextThinkAtMs = 0;
  return retreatedCount;
}

function retryPendingFleetRetreat(
  scene,
  fleetRecord,
  now = Date.now(),
) {
  const pendingEntityIDs = [
    ...new Set(
      (
        Array.isArray(
          fleetRecord &&
            fleetRecord.retreatWarpPendingEntityIDs,
        )
          ? fleetRecord.retreatWarpPendingEntityIDs
          : []
      )
        .map((entityID) =>
          normalizePositiveInteger(entityID, 0))
        .filter((entityID) => entityID > 0),
    ),
  ];
  if (
    !fleetRecord ||
    pendingEntityIDs.length <= 0 ||
    !fleetRecord.originAnchor ||
    !fleetRecord.originAnchor.position
  ) {
    return {
      attemptedCount: 0,
      startedCount: 0,
      pendingCount: pendingEntityIDs.length,
    };
  }
  const retryAtMs = Math.max(
    0,
    toInt(fleetRecord.nextRetreatWarpRetryAtMs, 0),
  );
  if (retryAtMs > now) {
    return {
      attemptedCount: 0,
      startedCount: 0,
      pendingCount: pendingEntityIDs.length,
    };
  }

  const ingressDurationMs = Math.max(
    250,
    toFiniteNumber(
      config.miningNpcWarpIngressDurationMs,
      DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
    ),
  );
  const remainingEntityIDs = [];
  const errors = [];
  let attemptedCount = 0;
  let startedCount = 0;
  for (const entityID of pendingEntityIDs) {
    if (!npcService.getControllerByEntityID(entityID)) {
      continue;
    }
    const entity =
      scene &&
      typeof scene.getEntityByID === "function"
        ? scene.getEntityByID(entityID)
        : null;
    if (
      entity &&
      (
        entity.mode === "WARP" ||
        entity.pendingWarp ||
        entity.warpState ||
        entity.sessionlessWarpIngress
      )
    ) {
      remainingEntityIDs.push(entityID);
      continue;
    }
    attemptedCount += 1;
    const warpResult = npcService.runtime.warpToPoint(
      entityID,
      fleetRecord.originAnchor.position,
      {
        forceImmediateStart: true,
        broadcastWarpStartToVisibleSessions: true,
        visibilitySuppressMs: 250,
        ingressDurationMs,
      },
    );
    if (warpResult && warpResult.success === true) {
      startedCount += 1;
    } else {
      remainingEntityIDs.push(entityID);
      errors.push({
        entityID,
        errorMsg:
          warpResult &&
            warpResult.errorMsg ||
          "NPC_WARP_FAILED",
      });
    }
  }
  fleetRecord.retreatWarpPendingEntityIDs =
    remainingEntityIDs;
  fleetRecord.nextRetreatWarpRetryAtMs =
    remainingEntityIDs.length > 0
      ? Math.max(0, toInt(now, Date.now())) + 1_000
      : 0;
  fleetRecord.lastRetreatWarpErrors = errors;
  return {
    attemptedCount,
    startedCount,
    pendingCount: remainingEntityIDs.length,
  };
}

function handleMiningFleetAggroCommand(session, argumentText, options = {}) {
  if (!session || !session.characterID || !session._space) {
    return {
      success: false,
      message: "You must be in space before using /npcmineraggro.",
    };
  }

  const fleets = getMiningFleetsForSystem(session._space.systemID)
    .map((fleetRecord) => pruneMiningFleet(fleetRecord))
    .filter(Boolean);
  if (fleets.length <= 0) {
    return {
      success: false,
      message: "No tracked mining fleets are active in your current system.",
    };
  }

  const parsedArguments = parseNpcSpawnArguments(
    argumentText,
    Math.max(1, toInt(config.miningNpcResponseDefaultCount, DEFAULT_MINING_RESPONSE_COUNT)),
  );
  if (!parsedArguments.success) {
    return {
      success: false,
      message: "Usage: /npcmineraggro [amount] [profile|pool|group]",
    };
  }
  if (parsedArguments.amount > MAX_MINING_NPC_COMMAND_SPAWN_COUNT) {
    return {
      success: false,
      message: `Mining response spawn count must be between 1 and ${MAX_MINING_NPC_COMMAND_SPAWN_COUNT}.`,
    };
  }

  const scene = resolveSessionScene(session);
  const aggressorEntity = scene && scene.getEntityByID(
    normalizePositiveInteger(session._space.shipID, 0),
  );
  if (!scene || !aggressorEntity) {
    return {
      success: false,
      message: "Unable to resolve your active ship for /npcmineraggro.",
    };
  }

  let retreatedCount = 0;
  let responseSpawnedCount = 0;
  let lastSelectionName = null;
  let lastStandingClass = null;
  for (const fleetRecord of fleets) {
    const aggressionResult = triggerFleetAggression(scene, fleetRecord, {
      aggressorEntity,
      responseAmount: parsedArguments.amount,
      responseQuery:
        parsedArguments.query ||
        String(config.miningNpcResponseProfileOrPool || DEFAULT_MINING_RESPONSE_QUERY),
      panic: options.panic === true,
      force: true,
      nowMs: Date.now(),
      aggressionEventAtMs: Date.now(),
    });
    if (!aggressionResult.success) {
      return {
        success: false,
        message: `Mining response spawn failed: ${aggressionResult.errorMsg || "UNKNOWN_ERROR"}.`,
      };
    }
    retreatedCount += Math.max(0, toInt(aggressionResult.data && aggressionResult.data.retreatedCount, 0));
    responseSpawnedCount += Math.max(
      0,
      toInt(aggressionResult.data && aggressionResult.data.responseSpawnedCount, 0),
    );
    if (aggressionResult.data && aggressionResult.data.responseSelectionName) {
      lastSelectionName = aggressionResult.data.responseSelectionName;
    }
    if (aggressionResult.data && aggressionResult.data.standingClass) {
      lastStandingClass = aggressionResult.data.standingClass;
    }
  }

  return {
    success: true,
    message: [
      `Simulated aggression against ${fleets.length} tracked mining fleet${fleets.length === 1 ? "" : "s"}.`,
      retreatedCount > 0
        ? `${retreatedCount} miner/hauler hull${retreatedCount === 1 ? "" : "s"} initiated retreat warp.`
        : "No miner retreat warp was needed.",
      responseSpawnedCount > 0
        ? `Spawned ${responseSpawnedCount} response hull${responseSpawnedCount === 1 ? "" : "s"} from ${lastSelectionName || parsedArguments.query || String(config.miningNpcResponseProfileOrPool || DEFAULT_MINING_RESPONSE_QUERY)}.`
        : "No additional response hulls were required.",
      lastStandingClass
        ? `Standing class resolved as ${lastStandingClass}.`
        : "Standing class resolution was unavailable.",
    ].join(" "),
  };
}

function handleMiningFleetClearCommand(session) {
  const systemID = normalizePositiveInteger(
    session &&
      session._space &&
      session._space.systemID,
    0,
  );
  if (!systemID) {
    return {
      success: false,
      message: "You must be in space before using /npcminerclear.",
    };
  }

  const fleets = getMiningFleetsForSystem(systemID);
  let destroyedCount = 0;
  for (const fleetRecord of fleets) {
    destroyedCount += destroyFleetEntities(fleetRecord, {
      reason: "gm_clear",
    });
    releaseManagedFleetResources(fleetRecord, "gm_clear");
    miningFleetStateByID.delete(fleetRecord.fleetID);
  }

  return {
    success: true,
    message: `Cleared ${fleets.length} tracked mining fleet${fleets.length === 1 ? "" : "s"} and destroyed ${destroyedCount} associated NPC hull${destroyedCount === 1 ? "" : "s"}.`,
  };
}

function formatFleetSummary(scene, fleetRecord) {
  const cargoState = scene ? getFleetCargoState(scene, fleetRecord) : {
    minerUsedVolumeM3: 0,
    minerCapacityM3: 0,
    haulerCapacityM3: 0,
    minerFillRatio: 0,
  };
  const nextHaulerMs = Math.max(
    0,
    toInt(fleetRecord.haulerNextArrivalAtMs, 0) - Date.now(),
  );
  return [
    `fleet ${fleetRecord.fleetID}`,
    `state=${fleetRecord.state}`,
    `miners=${fleetRecord.minerEntityIDs.length}`,
    `haulers=${fleetRecord.haulerEntityIDs.length}`,
    `response=${fleetRecord.responseEntityIDs.length}`,
    fleetRecord.lastAggressorID > 0
      ? `aggressor=${fleetRecord.lastAggressorID}`
      : "aggressor=none",
    fleetRecord.responseStandingClass
      ? `standing=${fleetRecord.responseStandingClass}`
      : "standing=unknown",
    fleetRecord.haulerEntityIDs.length > 0
      ? `haulerEta=${Math.ceil(nextHaulerMs / 1000)}s`
      : "haulerEta=off",
    `cargo=${cargoState.minerUsedVolumeM3.toFixed(1)}/${cargoState.minerCapacityM3.toFixed(1)}m3`,
  ].join(", ");
}

function handleMiningFleetStatusCommand(session) {
  const systemID = normalizePositiveInteger(
    session &&
      session._space &&
      session._space.systemID,
    0,
  );
  if (!systemID) {
    return {
      success: false,
      message: "You must be in space before using /npcminerstatus.",
    };
  }

  const scene = resolveSessionScene(session);
  const fleets = getMiningFleetsForSystem(systemID)
    .map((fleetRecord) => pruneMiningFleet(fleetRecord))
    .filter(Boolean);
  if (fleets.length <= 0) {
    return {
      success: true,
      message: "No tracked mining fleets are active in your current system.",
    };
  }

  return {
    success: true,
    message: `Tracked mining fleets in system ${systemID}: ${fleets.map((fleetRecord) => formatFleetSummary(scene, fleetRecord)).join("; ")}.`,
  };
}

function handleMiningFleetRetreatCommand(session) {
  const systemID = normalizePositiveInteger(session && session._space && session._space.systemID, 0);
  if (!systemID) {
    return {
      success: false,
      message: "You must be in space before using /npcminerretreat.",
    };
  }
  const fleets = getMiningFleetsForSystem(systemID)
    .map((fleetRecord) => pruneMiningFleet(fleetRecord))
    .filter(Boolean);
  if (fleets.length <= 0) {
    return {
      success: false,
      message: "No tracked mining fleets are active in your current system.",
    };
  }
  let retreatedCount = 0;
  for (const fleetRecord of fleets) {
    retreatedCount += retreatFleetToOrigin(fleetRecord, {
      state: "retreating",
    });
  }
  return {
    success: true,
    message: `Retreated ${retreatedCount} miner/hauler hull${retreatedCount === 1 ? "" : "s"} across ${fleets.length} fleet${fleets.length === 1 ? "" : "s"}.`,
  };
}

function handleMiningFleetResumeCommand(session) {
  const systemID = normalizePositiveInteger(session && session._space && session._space.systemID, 0);
  if (!systemID) {
    return {
      success: false,
      message: "You must be in space before using /npcminerresume.",
    };
  }
  const fleets = getMiningFleetsForSystem(systemID)
    .map((fleetRecord) => pruneMiningFleet(fleetRecord))
    .filter(Boolean);
  if (fleets.length <= 0) {
    return {
      success: false,
      message: "No tracked mining fleets are active in your current system.",
    };
  }
  for (const fleetRecord of fleets) {
    fleetRecord.state = "mining";
    fleetRecord.resumeAtMs = 0;
    fleetRecord.nextThinkAtMs = 0;
  }
  return {
    success: true,
    message: `Resumed ${fleets.length} tracked mining fleet${fleets.length === 1 ? "" : "s"}.`,
  };
}

function handleMiningFleetHaulCommand(session) {
  const systemID = normalizePositiveInteger(session && session._space && session._space.systemID, 0);
  if (!systemID) {
    return {
      success: false,
      message: "You must be in space before using /npcminerhaul.",
    };
  }
  const fleets = getMiningFleetsForSystem(systemID)
    .map((fleetRecord) => pruneMiningFleet(fleetRecord))
    .filter(Boolean);
  if (fleets.length <= 0) {
    return {
      success: false,
      message: "No tracked mining fleets are active in your current system.",
    };
  }
  for (const fleetRecord of fleets) {
    fleetRecord.state = "hauling";
    fleetRecord.nextThinkAtMs = 0;
    fleetRecord.haulCompleteAtMs = 0;
  }
  return {
    success: true,
    message: `Forced hauling behavior on ${fleets.length} tracked mining fleet${fleets.length === 1 ? "" : "s"}.`,
  };
}

function resolveStartupFleetCount() {
  return Math.max(0, toInt(config.miningNpcStartupFleetCount, 0));
}

function handleSceneCreated(scene) {
  if (!scene || config.miningNpcStartupEnabled !== true) {
    return;
  }
  const allowedSystemIDs = parseSystemIdList(config.miningNpcStartupSystemIDs);
  if (allowedSystemIDs.length > 0 && !allowedSystemIDs.includes(toInt(scene.systemID, 0))) {
    return;
  }

  const startupKey = `${toInt(scene.systemID, 0)}:${resolveStartupFleetCount()}`;
  if (startupSceneSeedSet.has(startupKey)) {
    return;
  }
  startupSceneSeedSet.add(startupKey);

  const fleetCount = resolveStartupFleetCount();
  if (fleetCount <= 0) {
    return;
  }

  ensureSceneMiningState(scene);
  const centerTarget = buildSpawnTarget(scene);
  for (let index = 0; index < fleetCount; index += 1) {
    const operatorKind = "startup_industrial_crew";
    const operatorID =
      `${toInt(scene.systemID, 0)}:${index + 1}`;
    const minerAmount = Math.max(
      1,
      toInt(
        config.miningNpcStartupFleetMinerCount,
        config.miningNpcFleetDefaultCount ||
          DEFAULT_MINING_FLEET_COUNT,
      ),
    );
    const haulerAmount = Math.max(
      0,
      toInt(
        config.miningNpcStartupFleetHaulerCount,
        config.miningNpcHaulerDefaultCount ||
          DEFAULT_MINING_HAULER_COUNT,
      ),
    );
    const spawnResult = spawnMiningFleetInternal(scene, {
      systemID: scene.systemID,
      centerTarget,
      preferredTargetID: 0,
      minerAmount,
      minerQuery: String(config.miningNpcStartupFleetProfileOrPool || config.miningNpcFleetProfileOrPool || ""),
      haulerAmount,
      haulerQuery: String(config.miningNpcStartupHaulerProfileOrPool || config.miningNpcHaulerProfileOrPool || ""),
      physicalShipLimit: minerAmount + haulerAmount,
      operatorKind,
      operatorID,
    });
    if (!spawnResult.success || !spawnResult.data) {
      continue;
    }
    createMiningFleetRecord({
      scene,
      source: "startup",
      startupKey: `${scene.systemID}:${index + 1}`,
      operatorKind,
      operatorID,
      physicalShipLimit: minerAmount + haulerAmount,
      systemID: scene.systemID,
      targetShipID: 0,
      minerEntityIDs: spawnResult.data.minerEntityIDs,
      haulerEntityIDs: spawnResult.data.haulerEntityIDs,
      originAnchor: spawnResult.data.originAnchor,
      onGridSupport: true,
      spawnSelectionName:
        spawnResult.data.minerSpawnResult &&
        spawnResult.data.minerSpawnResult.data &&
        spawnResult.data.minerSpawnResult.data.selectionName,
      haulerSelectionName:
        spawnResult.data.haulerSpawnResult &&
        spawnResult.data.haulerSpawnResult.data &&
        spawnResult.data.haulerSpawnResult.data.selectionName,
    });
  }
}

function deactivateMiningModulesForEntity(scene, entity, hooks, reason = "state") {
  if (!scene || !entity || !hooks || typeof hooks.buildNpcPseudoSession !== "function") {
    return;
  }
  const pseudoSession = hooks.buildNpcPseudoSession(entity);
  for (const moduleItem of getNpcFittedModuleItems(entity)) {
    const effectRecord =
      typeof hooks.findMiningEffectRecordForModule === "function"
        ? hooks.findMiningEffectRecordForModule(moduleItem)
        : getEffectTypeRecord(toInt(moduleItem && moduleItem.effectID, 0));
    if (!effectRecord) {
      continue;
    }
    const activeEffect = entity.activeModuleEffects instanceof Map
      ? entity.activeModuleEffects.get(toInt(moduleItem.itemID, 0))
      : null;
    if (!activeEffect) {
      continue;
    }
    scene.deactivateGenericModule(pseudoSession, moduleItem.itemID, {
      reason,
    });
  }
}

function deactivateMiningModulesForFleet(scene, fleetRecord, hooks, reason = "state") {
  for (const entityID of Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []) {
    const entity = scene.getEntityByID(entityID);
    if (!entity) {
      continue;
    }
    deactivateMiningModulesForEntity(scene, entity, hooks, reason);
  }
}

function startHaulCycle(scene, fleetRecord, now, hooks) {
  if (!scene || !fleetRecord || fleetRecord.haulerEntityIDs.length <= 0) {
    return false;
  }
  clearFleetManualOrders(fleetRecord.minerEntityIDs);
  deactivateMiningModulesForFleet(scene, fleetRecord, hooks, "cargo");
  const gatherTarget =
    scene.getEntityByID(toInt(fleetRecord.activeAsteroidID, 0)) ||
    scene.getEntityByID(toInt(fleetRecord.targetShipID, 0)) ||
    null;
  const gatherPoint =
    (gatherTarget && gatherTarget.position) ||
    (fleetRecord.originAnchor && fleetRecord.originAnchor.position) ||
    { x: 0, y: 0, z: 0 };
  const ingressDurationMs = Math.max(
    250,
    toFiniteNumber(
      config.miningNpcWarpIngressDurationMs,
      DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
    ),
  );
  for (const [index, entityID] of fleetRecord.haulerEntityIDs.entries()) {
    npcService.runtime.warpToPoint(entityID, buildMiningWarpLandingPoint(
      gatherPoint,
      index,
      fleetRecord.haulerEntityIDs.length,
      Math.max(
        250,
        toFiniteNumber(config.miningNpcHaulerLandingRadiusMeters, 750),
      ),
    ), {
      forceImmediateStart: true,
      broadcastWarpStartToVisibleSessions: true,
      visibilitySuppressMs: 250,
      ingressDurationMs,
    });
  }
  fleetRecord.state = "hauling";
  fleetRecord.haulerNextArrivalAtMs = 0;
  fleetRecord.haulCompleteAtMs =
    now +
    ingressDurationMs +
    Math.max(
      500,
      toFiniteNumber(
        config.miningNpcHaulerUnloadDurationMs,
        DEFAULT_MINING_HAULER_UNLOAD_DURATION_MS,
      ),
    );
  fleetRecord.nextThinkAtMs = fleetRecord.haulCompleteAtMs;
  return true;
}

function completeHaulCycle(scene, fleetRecord, now) {
  let hauledVolumeM3 = 0;
  for (const entityID of Array.isArray(fleetRecord && fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []) {
    const entity = scene.getEntityByID(entityID);
    if (!entity) {
      continue;
    }
    hauledVolumeM3 += clearNpcMiningCargo(entity);
  }
  const ingressDurationMs = Math.max(
    250,
    toFiniteNumber(
      config.miningNpcWarpIngressDurationMs,
      DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
    ),
  );
  if (fleetRecord.originAnchor && fleetRecord.originAnchor.position) {
    for (const entityID of Array.isArray(fleetRecord.haulerEntityIDs) ? fleetRecord.haulerEntityIDs : []) {
      npcService.runtime.warpToPoint(entityID, fleetRecord.originAnchor.position, {
        forceImmediateStart: true,
        broadcastWarpStartToVisibleSessions: true,
        visibilitySuppressMs: 250,
        ingressDurationMs,
      });
    }
  }
  fleetRecord.lastHauledVolumeM3 = hauledVolumeM3;
  fleetRecord.lastHauledAtMs = now;
  fleetRecord.haulerNextArrivalAtMs = now + getHaulerRepeatDelayMs();
  fleetRecord.state = "haulereturn";
  fleetRecord.haulerReturnAtMs = now + ingressDurationMs;
  fleetRecord.nextThinkAtMs = fleetRecord.haulerReturnAtMs;
}

function shouldTriggerHauling(scene, fleetRecord, noAsteroidsRemain = false, now = Date.now()) {
  if (!scene || !fleetRecord || fleetRecord.haulerEntityIDs.length <= 0) {
    return false;
  }
  if (
    toFiniteNumber(fleetRecord.haulerNextArrivalAtMs, 0) > 0 &&
    now < toFiniteNumber(fleetRecord.haulerNextArrivalAtMs, 0)
  ) {
    return false;
  }
  const cargoState = getFleetCargoState(scene, fleetRecord);
  const thresholdRatio = Math.max(
    0.01,
    Math.min(
      1,
      toFiniteNumber(
        config.miningNpcHaulThresholdRatio,
        DEFAULT_MINING_HAUL_THRESHOLD_RATIO,
      ),
    ),
  );
  if (noAsteroidsRemain && cargoState.minerUsedVolumeM3 > 0) {
    return true;
  }
  return cargoState.minerFillRatio >= thresholdRatio;
}

function getManagedRetreatCooldownMs() {
  return Math.max(
    1_000,
    toInt(
      config
        .miningNpcManagedDefenseRetreatCooldownMs,
      DEFAULT_MANAGED_MINING_DEFENSE_RETREAT_COOLDOWN_MS,
    ),
  );
}

function isManagedRetreatThreatStillPresent(
  scene,
  fleetRecord,
  now,
) {
  const scanRangeMeters = Math.max(
    0,
    toFiniteNumber(
      config.miningNpcManagedDefenseScanRangeMeters,
      DEFAULT_MANAGED_MINING_DEFENSE_SCAN_RANGE_METERS,
    ),
  );
  const sitePosition =
    fleetRecord.retreatSitePosition ||
    (
      scene.getEntityByID(
        toInt(fleetRecord.activeAsteroidID, 0),
      ) ||
      scene.getEntityByID(
        toInt(fleetRecord.targetShipID, 0),
      ) ||
      {}
    ).position ||
    null;
  const interactionSource =
    getFleetEntities(scene, fleetRecord)[0] ||
    null;
  const lastAggressor = scene.getEntityByID(
    toInt(fleetRecord.lastAggressorID, 0),
  );
  if (
    lastAggressor &&
    (
      !interactionSource ||
      canEntitiesInteractLocally(
        interactionSource,
        lastAggressor,
      )
    ) &&
    (
      !sitePosition ||
      !lastAggressor.position ||
      distance(
        sitePosition,
        lastAggressor.position,
      ) <= scanRangeMeters
    )
  ) {
    return {
      entity: lastAggressor,
      reason: "LAST_AGGRESSOR_PRESENT",
    };
  }
  const proactiveThreat =
    scanManagedIndustrialFleetThreat(
      scene,
      fleetRecord,
      now,
    );
  return proactiveThreat && proactiveThreat.entity
    ? {
        entity: proactiveThreat.entity,
        reason: "HOSTILE_NPC_PRESENT",
      }
    : null;
}

function warpManagedFleetBackToAssignedSite(
  scene,
  fleetRecord,
  now,
) {
  const targetEntity =
    scene.getEntityByID(
      toInt(fleetRecord.activeAsteroidID, 0),
    ) ||
    scene.getEntityByID(
      toInt(fleetRecord.targetShipID, 0),
    ) ||
    null;
  const targetPosition =
    targetEntity && targetEntity.position ||
    fleetRecord.retreatSitePosition ||
    null;
  if (!targetPosition) {
    return false;
  }
  const entityIDs = getFleetEntityIDs(fleetRecord);
  const ingressDurationMs = Math.max(
    250,
    toFiniteNumber(
      config.miningNpcWarpIngressDurationMs,
      DEFAULT_MINING_WARP_INGRESS_DURATION_MS,
    ),
  );
  for (
    const [index, entityID] of entityIDs.entries()
  ) {
    if (
      !npcService.getControllerByEntityID(entityID)
    ) {
      continue;
    }
    npcService.runtime.warpToPoint(
      entityID,
      buildMiningWarpLandingPoint(
        targetPosition,
        index,
        entityIDs.length,
        Math.max(
          500,
          toFiniteNumber(
            config.miningNpcFleetLandingRadiusMeters,
            DEFAULT_MINING_WARP_LANDING_RADIUS_METERS,
          ),
        ),
      ),
      {
        forceImmediateStart: true,
        broadcastWarpStartToVisibleSessions: true,
        visibilitySuppressMs: 250,
        ingressDurationMs,
      },
    );
  }
  fleetRecord.state = "returning_to_site";
  fleetRecord.managedSiteReturnAtMs =
    now + ingressDurationMs;
  fleetRecord.resumeAtMs = 0;
  fleetRecord.lastAggressorID = 0;
  fleetRecord.nextThinkAtMs = 0;
  return true;
}

function tickMiningFleet(scene, fleetRecord, now, hooks) {
  if (!scene || !fleetRecord || !hooks) {
    return;
  }

  const thinkIntervalMs = Math.max(
    250,
    toFiniteNumber(config.miningNpcFleetThinkIntervalMs, 1_000),
  );
  if (toFiniteNumber(fleetRecord.nextThinkAtMs, 0) > now) {
    return;
  }
  fleetRecord.nextThinkAtMs = now + thinkIntervalMs;

  const retreatRetry = retryPendingFleetRetreat(
    scene,
    fleetRecord,
    now,
  );
  if (
    retreatRetry.pendingCount > 0 ||
    retreatRetry.startedCount > 0
  ) {
    return;
  }

  const latestAggression = getLatestFleetAggression(scene, fleetRecord, now);
  if (
    latestAggression &&
    latestAggression.lastAggressedAtMs >
      Math.max(0, toInt(fleetRecord.lastProcessedAggressionAtMs, 0))
  ) {
    triggerFleetAggression(scene, fleetRecord, {
      aggressorEntity: latestAggression.aggressorEntity,
      aggressionEventAtMs: latestAggression.lastAggressedAtMs,
      nowMs: now,
      hooks,
    });
  }

  if (
    isManagedIndustrialMiningFleet(fleetRecord) &&
    fleetRecord.state === "defending"
  ) {
    const defenseState =
      maintainManagedFleetDroneDefense(
        scene,
        fleetRecord,
        now,
      );
    if (
      defenseState.active === true ||
      defenseState.retreated === true
    ) {
      return;
    }
  }

  if (
    isManagedIndustrialMiningFleet(fleetRecord) &&
    (
      fleetRecord.state === "aggressed" ||
      fleetRecord.state === "panic"
    )
  ) {
    if (
      now <
      toFiniteNumber(fleetRecord.resumeAtMs, 0)
    ) {
      return;
    }
    const remainingThreat =
      isManagedRetreatThreatStillPresent(
        scene,
        fleetRecord,
        now,
      );
    if (remainingThreat) {
      fleetRecord.resumeAtMs =
        now + getManagedRetreatCooldownMs();
      fleetRecord.lastAggressorID = toInt(
        remainingThreat.entity.itemID,
        0,
      );
      return;
    }
    if (
      !warpManagedFleetBackToAssignedSite(
        scene,
        fleetRecord,
        now,
      )
    ) {
      fleetRecord.resumeAtMs =
        now + getManagedRetreatCooldownMs();
    }
    return;
  }

  if (
    isManagedIndustrialMiningFleet(fleetRecord) &&
    fleetRecord.state === "returning_to_site"
  ) {
    if (
      now >=
      toFiniteNumber(
        fleetRecord.managedSiteReturnAtMs,
        0,
      )
    ) {
      fleetRecord.state = "mining";
      fleetRecord.managedSiteReturnAtMs = 0;
      fleetRecord.retreatSitePosition = null;
      fleetRecord.lastManagedThreatScanAtMs = -1;
    } else {
      return;
    }
  }

  if (
    isManagedIndustrialMiningFleet(fleetRecord) &&
    fleetRecord.state === "mining"
  ) {
    // A newly materialized crew starts at its safe origin and warps onto the
    // assigned site. Scanning that destination while every hull is still in
    // ingress can detect a belt rat, attempt to retreat to the current origin,
    // and put the fleet into a cooldown even though no retreat warp started.
    // Wait for the complete crew to land before making the first threat
    // decision.
    if (isFleetWarpInProgress(scene, fleetRecord)) {
      return;
    }
    const proactiveThreat =
      scanManagedIndustrialFleetThreat(
        scene,
        fleetRecord,
        now,
      );
    if (
      proactiveThreat &&
      proactiveThreat.entity
    ) {
      triggerFleetAggression(scene, fleetRecord, {
        aggressorEntity: proactiveThreat.entity,
        aggressionEventAtMs: now,
        nowMs: now,
        hooks,
        force: true,
        proactive: true,
      });
      if (fleetRecord.state !== "mining") {
        return;
      }
    }
  }

  if (fleetRecord.responseEntityIDs.length > 0) {
    const activeResponseTarget = scene.getEntityByID(toInt(fleetRecord.responseTargetID, 0));
    if (activeResponseTarget && fleetRecord.responseRetreating !== true) {
      issueResponseOrders(fleetRecord.responseEntityIDs, activeResponseTarget.itemID);
    }
    if (
      fleetRecord.responseDespawnAtMs > 0 &&
      now >= fleetRecord.responseDespawnAtMs
    ) {
      if (fleetRecord.responseRetreating === true) {
        destroyResponseWing(fleetRecord);
      } else {
        retreatResponseWingToOrigin(fleetRecord, { nowMs: now });
      }
    }
  }

  if (
    (fleetRecord.state === "aggressed" || fleetRecord.state === "panic") &&
    fleetRecord.resumeAtMs > 0 &&
    now >= fleetRecord.resumeAtMs &&
    fleetRecord.responseEntityIDs.length <= 0
  ) {
    fleetRecord.state = "mining";
    fleetRecord.resumeAtMs = 0;
  }

  if (fleetRecord.state === "external_hauling") {
    if (
      now >=
      toFiniteNumber(fleetRecord.haulCompleteAtMs, 0)
    ) {
      destroyFleetEntities(fleetRecord, {
        scene,
        reason: "external_departure",
      });
      releaseManagedFleetResources(
        fleetRecord,
        "external_departure",
      );
      miningFleetStateByID.delete(fleetRecord.fleetID);
    }
    return;
  }
  if (fleetRecord.state === "hauling") {
    if (now >= toFiniteNumber(fleetRecord.haulCompleteAtMs, 0)) {
      completeHaulCycle(scene, fleetRecord, now);
    }
    return;
  }
  if (fleetRecord.state === "haulereturn") {
    if (now >= toFiniteNumber(fleetRecord.haulerReturnAtMs, 0)) {
      fleetRecord.state = "mining";
      fleetRecord.haulerReturnAtMs = 0;
    }
    return;
  }
  if (fleetRecord.state !== "mining") {
    return;
  }

  maintainMiningSupportBursts(
    scene,
    fleetRecord,
    hooks,
  );
  processOnGridMiningSupport(scene, fleetRecord, now, hooks);

  const availableTargetEntries = resolveAvailableMineableTargetEntries(scene, fleetRecord);
  if (availableTargetEntries.length <= 0) {
    if (fleetRecord.onGridSupport === true) {
      for (const minerEntityID of fleetRecord.minerEntityIDs || []) {
        const minerEntity = scene.getEntityByID(minerEntityID);
        if (minerEntity) {
          routeMinerCargoToJetcans(
            scene,
            fleetRecord,
            minerEntity,
            now,
            { force: true },
          );
        }
      }
      processOnGridMiningSupport(scene, fleetRecord, now, hooks);
      const remainingMinerCargoM3 = (
        fleetRecord.minerEntityIDs || []
      )
        .map((entityID) => scene.getEntityByID(entityID))
        .filter(Boolean)
        .reduce(
          (sum, entity) => sum + getNpcOreCargoVolume(entity),
          0,
        );
      const outstandingJetcanCount = Object.keys(
        fleetRecord.jetcanRecordsByID || {},
      ).length;
      const haulerEntity = (fleetRecord.haulerEntityIDs || [])
        .map((entityID) => scene.getEntityByID(entityID))
        .find(Boolean) || null;
      const haulerCargoM3 = getNpcOreCargoVolume(haulerEntity);
      if (
        remainingMinerCargoM3 <= 0 &&
        outstandingJetcanCount <= 0 &&
        haulerCargoM3 > 0 &&
        String(fleetRecord.supportHaulerState || "idle") === "idle"
      ) {
        startOnGridHaulerDelivery(
          scene,
          fleetRecord,
          haulerEntity,
          now,
          { force: true },
        );
      }
      if (
        remainingMinerCargoM3 > 0 ||
        outstandingJetcanCount > 0 ||
        haulerCargoM3 > 0 ||
        String(fleetRecord.supportHaulerState || "idle") !== "idle"
      ) {
        return;
      }
    }
    fleetRecord.activeAsteroidID = 0;
    if (shouldTriggerHauling(scene, fleetRecord, true, now) && startHaulCycle(scene, fleetRecord, now, hooks)) {
      return;
    }
    fleetRecord.state = "depleted";
    retreatFleetToOrigin(fleetRecord, {
      state: "depleted",
      scene,
      hooks,
      reason: "depleted",
    });
    return;
  }

  if (shouldTriggerHauling(scene, fleetRecord, false, now) && startHaulCycle(scene, fleetRecord, now, hooks)) {
    return;
  }

  const assignmentMap = pruneFleetMinerAssignments(scene, fleetRecord);
  const claimCounts = buildAssignedMineableClaimCounts(scene, fleetRecord);
  const targetAssignmentCounts = new Map();
  const rangeBufferMeters = Math.max(
    0,
    toFiniteNumber(config.miningNpcFleetMiningRangeBufferMeters, 500),
  );
  const orbitDistanceMeters = Math.max(
    500,
    toFiniteNumber(config.miningNpcFleetOrbitDistanceMeters, 1_000),
  );

  for (const minerEntityID of Array.isArray(fleetRecord.minerEntityIDs) ? fleetRecord.minerEntityIDs : []) {
    const minerEntity = scene.getEntityByID(minerEntityID);
    if (!minerEntity || minerEntity.mode === "WARP" || minerEntity.pendingWarp) {
      continue;
    }

    const miningModules = getNpcFittedModuleItems(minerEntity)
      .filter((moduleItem) => isModuleOnline(moduleItem))
      .map((moduleItem) => ({
        moduleItem,
        effectRecord:
          typeof hooks.findMiningEffectRecordForModule === "function"
            ? hooks.findMiningEffectRecordForModule(moduleItem)
            : getEffectTypeRecord(toInt(moduleItem && moduleItem.effectID, 0)),
      }))
      .filter((entry) => entry.effectRecord);
    if (miningModules.length <= 0) {
      continue;
    }

    const primarySnapshot = hooks.buildEntityMiningSnapshot(
      minerEntity,
      miningModules[0].moduleItem,
      miningModules[0].effectRecord,
    );
    if (!primarySnapshot) {
      continue;
    }

    const targetEntity = chooseMineableTargetForMiner(
      scene,
      fleetRecord,
      minerEntity,
      availableTargetEntries,
      claimCounts,
      primarySnapshot,
      hooks,
    );
    if (!targetEntity) {
      delete assignmentMap[toInt(minerEntity.itemID, 0)];
      continue;
    }
    const targetEntityID = toInt(targetEntity.itemID, 0);
    targetAssignmentCounts.set(
      targetEntityID,
      toInt(targetAssignmentCounts.get(targetEntityID), 0) + 1,
    );

    const distanceToTarget = hooks.getSurfaceDistance(minerEntity, targetEntity);
    const engagementRangeMeters = getMiningEngagementRangeMeters(
      scene,
      minerEntity,
      primarySnapshot,
      rangeBufferMeters,
    );
    if (distanceToTarget > engagementRangeMeters) {
      syncMiningApproachOrder(
        scene,
        minerEntity,
        targetEntity,
        orbitDistanceMeters,
      );
      continue;
    }

    const targetLockResult = syncMiningTargetLock(
      scene,
      minerEntity,
      targetEntity,
      now,
      hooks,
    );
    if (!targetLockResult || targetLockResult.success !== true) {
      syncMiningApproachOrder(
        scene,
        minerEntity,
        targetEntity,
        orbitDistanceMeters,
      );
      continue;
    }

    syncMiningApproachOrder(
      scene,
      minerEntity,
      targetEntity,
      orbitDistanceMeters,
    );
    const pseudoSession = hooks.buildNpcPseudoSession(minerEntity);
    for (const entry of miningModules) {
      const activeEffect = minerEntity.activeModuleEffects instanceof Map
        ? minerEntity.activeModuleEffects.get(toInt(entry.moduleItem.itemID, 0))
        : null;
      if (activeEffect && toInt(activeEffect.targetID, 0) !== toInt(targetEntity.itemID, 0)) {
        scene.deactivateGenericModule(pseudoSession, entry.moduleItem.itemID, {
          reason: "target",
        });
        continue;
      }
      if (!activeEffect) {
      scene.activateGenericModule(pseudoSession, entry.moduleItem, entry.effectRecord.name, {
        targetID: targetEntity.itemID,
      });
      }
    }
  }

  const primaryTargetEntry = [...targetAssignmentCounts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0] - right[0])[0];
  fleetRecord.activeAsteroidID = primaryTargetEntry ? toInt(primaryTargetEntry[0], 0) : 0;
}

function tickScene(scene, now, hooks = {}) {
  const fleets = getMiningFleetsForSystem(scene && scene.systemID)
    .map((fleetRecord) => pruneMiningFleet(fleetRecord))
    .filter(Boolean);
  if (fleets.length <= 0) {
    return;
  }
  for (const fleetRecord of fleets) {
    tickMiningFleet(scene, fleetRecord, now, hooks);
  }
}

function resolveFleetScene(scene, fleetRecord) {
  if (scene) {
    return scene;
  }
  const runtime = getSpaceRuntime();
  return runtime && runtime.scenes instanceof Map
    ? runtime.scenes.get(
        toInt(fleetRecord && fleetRecord.systemID, 0),
      ) || null
    : null;
}

function finalizeOnGridMiningSupport(
  scene,
  fleetID,
  options = {},
) {
  const fleetRecord =
    miningFleetStateByID.get(toInt(fleetID, 0)) || null;
  if (!fleetRecord || fleetRecord.onGridSupport !== true) {
    return {
      success: true,
      data: {
        fleetID: toInt(fleetID, 0),
        collectedCount: 0,
      },
    };
  }
  const activeScene = resolveFleetScene(scene, fleetRecord);
  const haulerEntity = activeScene
    ? fleetRecord.haulerEntityIDs
      .map((entityID) => activeScene.getEntityByID(entityID))
      .find(
        (entity) =>
          entity &&
          npcService.getControllerByEntityID(
            toInt(entity.itemID, 0),
          ),
      ) || null
    : null;
  let collectedCount = 0;
  if (activeScene && haulerEntity) {
    for (
      const record of Object.values({
        ...(fleetRecord.jetcanRecordsByID || {}),
      })
    ) {
      if (!record || toInt(record.containerID, 0) <= 0) {
        continue;
      }
      if (
        collectMiningJetcan(
          activeScene,
          fleetRecord,
          haulerEntity,
          record.containerID,
          options.hooks || null,
          { force: true, nowMs: options.nowMs },
        )
      ) {
        collectedCount += 1;
      }
    }
  }
  return {
    success: true,
    data: {
      fleetID: fleetRecord.fleetID,
      collectedCount,
      remainingCount: Object.keys(
        fleetRecord.jetcanRecordsByID || {},
      ).length,
    },
  };
}

function cleanupMiningFleetSupport(
  scene,
  fleetID,
  options = {},
) {
  const normalizedFleetID = toInt(fleetID, 0);
  const fleetRecord =
    miningFleetStateByID.get(normalizedFleetID) || null;
  if (!fleetRecord) {
    return {
      success: true,
      data: {
        fleetID: normalizedFleetID,
        removedCount: 0,
      },
    };
  }
  const activeScene = resolveFleetScene(scene, fleetRecord);
  const haulerEntity =
    activeScene &&
    toInt(fleetRecord.activeTractorHaulerID, 0) > 0
      ? activeScene.getEntityByID(
          fleetRecord.activeTractorHaulerID,
        )
      : null;
  deactivateFleetTractor(
    activeScene,
    fleetRecord,
    haulerEntity,
    options.hooks || null,
    "cleanup",
  );
  let removedCount = 0;
  let preservedCount = 0;
  for (
    const record of Object.values({
      ...(fleetRecord.jetcanRecordsByID || {}),
    })
  ) {
    if (!record || toInt(record.containerID, 0) <= 0) {
      continue;
    }
    if (
      options.removePersistentCargo !== true &&
      (
        record.external === true ||
        fleetRecord.cargoTransient === false
      )
    ) {
      // External cans belong to another actor, while non-transient mining
      // cans are the employer's settled cargo. Drop only fleet bookkeeping;
      // destroying either container here would erase cargo during stand-down.
      detachMiningJetcanRecord(
        fleetRecord,
        record.containerID,
      );
      preservedCount += 1;
      continue;
    }
    removeMiningJetcan(
      activeScene,
      fleetRecord,
      record.containerID,
      { removeContents: true },
    );
    removedCount += 1;
  }
  if (options.unregister === true) {
    releaseManagedFleetResources(
      fleetRecord,
      options.reason || "support_cleanup",
    );
    miningFleetStateByID.delete(normalizedFleetID);
  }
  return {
    success: true,
    data: {
      fleetID: normalizedFleetID,
      removedCount,
      preservedCount,
    },
  };
}

module.exports = {
  appendNpcMiningCargo,
  clearNpcMiningCargo,
  estimateNpcMiningVolume,
  getNpcCargoCapacityM3,
  getNpcCargoCapacityM3ForTypeID,
  getNpcOreCargoItems,
  getNpcOreCargoSummary,
  getMiningFleetsForSystem,
  getManagedMiningFleet,
  settleManagedMiningFleetCargo,
  destroyManagedMiningFleet,
  destroyManagedMiningFleetsByOwner,
  spawnManagedIndustrialMiningCrew,
  spawnManagedMiningFleet,
  spawnManagedMiningHauler,
  finalizeOnGridMiningSupport,
  cleanupMiningFleetSupport,
  pruneMiningFleet,
  registerAmbientMiningFleet,
  handleSceneCreated,
  handleMiningFleetCommand,
  handleMiningFleetAggroCommand,
  handleMiningFleetClearCommand,
  handleMiningFleetStatusCommand,
  handleMiningFleetRetreatCommand,
  handleMiningFleetResumeCommand,
  handleMiningFleetHaulCommand,
  tickScene,
  _testing: {
    buildCappedGroupProfilePlan,
    normalizeManagedIndustrialCrewRoster,
    rollbackManagedIndustrialCrewSpawn,
    applyManagedIndustrialCrewMemberState,
    spawnFleetWing,
    spawnMiningFleetInternal,
    createMiningFleetRecord,
    getSecurityBandForSystemID,
    resolveMiningFleetQuery,
    resolveMiningHaulerQuery,
    resolveResponsePlan,
    shouldTriggerHauling,
    retreatFleetToOrigin,
    retryPendingFleetRetreat,
    isFleetWarpInProgress,
    triggerFleetAggression,
    assessManagedIndustrialThreat,
    normalizeManagedThreatDoctrine,
    listCoLocatedManagedIndustrialFleets,
    scanManagedIndustrialFleetThreat,
    beginManagedFleetDroneDefense,
    maintainManagedFleetDroneDefense,
    recallManagedFleetDefensiveDrones,
    getNpcMiningCargoFullState,
    getNpcCargoCapacityM3,
    buildMiningMovementOrder,
    areManualOrdersEquivalent,
    applyPassiveMiningFleetOverrides,
    syncMiningApproachOrder,
    chooseFleetMineableTarget,
    chooseMineableTargetForMiner,
    syncMiningTargetLock,
    tickMiningFleet,
    processOnGridMiningSupport,
    routeMinerCargoToJetcans,
    collectMiningJetcan,
    startOnGridHaulerDelivery,
    tickOnGridHaulerDelivery,
    maintainMiningSupportBursts,
    deactivateMiningSupportBursts,
    applyMiningFleetCommandBurstAffinity,
    clearState() {
      for (const fleetRecord of [...miningFleetStateByID.values()]) {
        cleanupMiningFleetRuntimeResources(null, fleetRecord, {
          reason: "test_clear",
        });
        releaseManagedFleetResources(fleetRecord, "test_clear");
      }
      miningFleetStateByID.clear();
      startupSceneSeedSet.clear();
      nextMiningFleetID = 1;
    },
  },
};
