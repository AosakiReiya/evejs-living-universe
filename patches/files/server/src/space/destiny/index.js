"use strict";

const path = require("path");

const {
  buildDict,
  buildFiletimeLong,
  buildList,
  buildRowset,
} = require(path.join(__dirname, "../../services/_shared/serviceHelpers"));
const {
  buildDamageState,
  hasDamageableHealth,
} = require(path.join(__dirname, "../combat/damage"));
const {
  STRUCTURE_STATE,
} = require(path.join(__dirname, "../../services/structure/structureConstants"));
const actions = require(path.join(__dirname, "./stream/actions"));
const statePayloads = require(path.join(__dirname, "./stream/statePayloads"));
const {
  buildPackagedActionPayload,
} = require(path.join(__dirname, "./batching/packagedAction"));
const {
  debugDescribeEntityBall,
  encodeEntityBall,
} = require(path.join(__dirname, "./stream/ballEncoding"));
const {
  buildPackedRow,
} = require(path.join(__dirname, "./stream/primitives"));
const {
  BALL_FLAG,
  BALL_MODE,
  RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND,
} = require(path.join(__dirname, "./constants"));

const SOL_ITEM_COLUMNS = [
  ["itemID", 0x14],
  ["typeID", 0x03],
  ["ownerID", 0x03],
  ["locationID", 0x14],
  ["flagID", 0x02],
  ["contraband", 0x0b],
  ["singleton", 0x02],
  ["quantity", 0x03],
  ["groupID", 0x03],
  ["categoryID", 0x03],
  ["customInfo", 0x81],
];

const DRONE_STATE_HEADERS = [
  "droneID",
  "ownerID",
  "controllerID",
  "activityState",
  "typeID",
  "controllerOwnerID",
  "targetID",
];
const STARGATE_JUMP_HEADERS = ["toCelestialID", "locationID"];
const CLIENT_ROWSET_NAME = "eve.common.script.sys.rowset.Rowset";
const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;

const lazyModules = new Map();

function lazyRequire(relativePath) {
  if (!lazyModules.has(relativePath)) {
    lazyModules.set(relativePath, require(path.join(__dirname, relativePath)));
  }
  return lazyModules.get(relativePath);
}

function getEntityStandingsForType(...args) {
  return lazyRequire("../../services/_shared/clientEntityStandings")
    .getEntityStandingsForType(...args);
}

function getShipDirtTimestamp(...args) {
  return lazyRequire("../../services/ship/shipDirtState")
    .getShipDirtTimestamp(...args);
}

function normalizeFiletime(...args) {
  return lazyRequire("../../services/ship/shipDirtState")
    .normalizeFiletime(...args);
}

function getItemKillCountPlayer(...args) {
  return lazyRequire("../../services/ship/shipKillCounterState")
    .getItemKillCountPlayer(...args);
}

function buildDroneStateRows(...args) {
  return lazyRequire("../../services/drone/droneRuntime")
    .buildDroneStateRows(...args);
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toInt32(value, fallback = 0) {
  return Math.trunc(toFiniteNumber(value, fallback));
}

function toOptionalInt32(value, fallback = -1) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return toInt32(value, fallback);
}

function toOptionalInt64(value, fallback = -1) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  return Math.trunc(toFiniteNumber(value, fallback));
}

function normalizeSlimNullableValue(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized || normalized.toLowerCase() === "none" || normalized.toLowerCase() === "null") {
    return null;
  }
  return value;
}

function buildWallclockFiletimeFromMs(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }
  return buildFiletimeLong(
    BigInt(Math.trunc(numericValue)) * FILETIME_TICKS_PER_MS + FILETIME_EPOCH_OFFSET,
  );
}

function buildOptionalWallclockFiletimeValue(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return buildWallclockFiletimeFromMs(numericValue);
  }
  return value;
}

function buildStructureSlimTimer(entity) {
  const timerStart = buildWallclockFiletimeFromMs(entity && entity.stateStartedAt);
  const timerEnd = buildWallclockFiletimeFromMs(entity && entity.stateEndsAt);
  const timerPaused = buildWallclockFiletimeFromMs(entity && entity.timerPausedAt);
  if (!timerStart || !timerEnd) {
    return null;
  }
  return buildList([timerStart, timerEnd, timerPaused]);
}

function buildStructureSlimDeployTimes(entity) {
  const timerStart = buildWallclockFiletimeFromMs(entity && entity.stateStartedAt);
  const timerEnd = buildWallclockFiletimeFromMs(entity && entity.stateEndsAt);
  if (!timerStart || !timerEnd) {
    return null;
  }
  return buildList([timerStart, timerEnd]);
}

function buildStructureSlimDamage(entity) {
  const conditionState =
    entity && entity.conditionState && typeof entity.conditionState === "object"
      ? entity.conditionState
      : {};
  const structureDamage = Math.max(
    0,
    Math.min(1, toFiniteNumber(conditionState.damage, 0)),
  );
  const armorDamage = Math.max(
    0,
    Math.min(1, toFiniteNumber(conditionState.armorDamage, 0)),
  );
  const shieldCharge = Math.max(
    0,
    Math.min(
      1,
      conditionState.shieldCharge === undefined || conditionState.shieldCharge === null
        ? 1
        : toFiniteNumber(conditionState.shieldCharge, 1),
    ),
  );
  return buildList([
    structureDamage,
    armorDamage,
    1 - shieldCharge,
  ]);
}

function appendEntityStandings(entries, entity, slimTypeID) {
  const authoredStandings = getEntityStandingsForType(slimTypeID);
  const hostileResponseThreshold = Number.isFinite(
    Number(entity && entity.hostileResponseThreshold),
  )
    ? Number(entity.hostileResponseThreshold)
    : authoredStandings && authoredStandings.hostileResponseThreshold;
  const friendlyResponseThreshold = Number.isFinite(
    Number(entity && entity.friendlyResponseThreshold),
  )
    ? Number(entity.friendlyResponseThreshold)
    : authoredStandings && authoredStandings.friendlyResponseThreshold;

  if (Number.isFinite(hostileResponseThreshold)) {
    entries.push([
      "hostile_response_threshold",
      toFiniteNumber(hostileResponseThreshold, -11),
    ]);
  }
  if (Number.isFinite(friendlyResponseThreshold)) {
    entries.push([
      "friendly_response_threshold",
      toFiniteNumber(friendlyResponseThreshold, 11),
    ]);
  }
}

function hasOwnProperty(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function resolveShipSlimDirtTime(entity) {
  if (hasOwnProperty(entity, "dirtTime")) {
    return {
      explicit: true,
      dirtTime: normalizeFiletime(entity.dirtTime, 0n) || 0n,
    };
  }

  return {
    explicit: false,
    dirtTime: getShipDirtTimestamp(entity.itemID, {
      createIfMissing: false,
      reason: "slim",
    }),
  };
}

function buildShipStanceSlimValue(value) {
  if (!Array.isArray(value) || value.length < 3) {
    return null;
  }

  const oldStanceID = toInt32(value[0], 0);
  const newStanceID = toInt32(value[2], 0);
  if (oldStanceID <= 0 || newStanceID <= 0) {
    return null;
  }

  return [
    oldStanceID,
    buildFiletimeLong(value[1]),
    newStanceID,
  ];
}

function buildSlimNameIDValue(value) {
  if (!value) {
    return null;
  }
  if (Array.isArray(value) && value.length >= 2) {
    const label = String(value[0] || "").trim();
    if (!label) {
      return null;
    }
    const payload = value[1];
    if (payload && typeof payload === "object" && payload.type === "dict") {
      return [label, payload];
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      return [label, buildDict(Object.entries(payload))];
    }
    return [label, payload ?? null];
  }
  if (typeof value === "object") {
    const label = String(value.label || value.path || value.key || "").trim();
    if (!label) {
      return null;
    }
    const payload = value.args || value.payload || {};
    if (payload && typeof payload === "object" && payload.type === "dict") {
      return [label, payload];
    }
    return [
      label,
      buildDict(
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? Object.entries(payload)
          : [],
      ),
    ];
  }
  return null;
}

function buildSlimItemDict(entity) {
  const hasEntityField = (fieldName) => hasOwnProperty(entity, fieldName);
  const slimTypeID = toInt32(
    entity && entity.slimTypeID,
    toInt32(entity && entity.typeID, 0),
  );
  const slimGroupID = toInt32(
    entity && entity.slimGroupID,
    toInt32(entity && entity.groupID, 0),
  );
  const slimCategoryID = toInt32(
    entity && entity.slimCategoryID,
    toInt32(entity && entity.categoryID, 0),
  );
  const suppressSlimName = entity && entity.suppressSlimName === true;
  const slimName = suppressSlimName
    ? ""
    : String(
        entity && (
          hasEntityField("slimName")
            ? entity.slimName
            : entity.itemName
        ) || "",
      );
  const entries = [
    ["itemID", entity.itemID],
    ["typeID", slimTypeID],
    ["ownerID", entity.ownerID || 0],
  ];
  const slimNameID = buildSlimNameIDValue(entity && entity.nameID);

  if (slimName && !slimNameID) {
    entries.push(["name", slimName]);
  }
  if (slimNameID) {
    entries.push(["nameID", slimNameID]);
  }
  if (slimGroupID > 0) {
    entries.push(["groupID", slimGroupID]);
  }
  if (slimCategoryID > 0) {
    entries.push(["categoryID", slimCategoryID]);
  }
  const slimGraphicID = toInt32(
    entity && entity.slimGraphicID,
    toInt32(entity && entity.graphicID, 0),
  );
  if (slimGraphicID > 0 && !(entity && entity.suppressSlimGraphicID === true)) {
    entries.push(["graphicID", slimGraphicID]);
  }

  const dunObjectID = toInt32(
    entity && (entity.dunObjectID || entity.dungeonObjectID),
    0,
  );
  if (dunObjectID > 0) {
    entries.push(["dunObjectID", dunObjectID]);
  }
  if (hasEntityField("dunObjectNameID")) {
    entries.push(["dunObjectNameID", entity.dunObjectNameID ?? null]);
  }
  if (hasEntityField("objectiveTargetGroup")) {
    entries.push(["objectiveTargetGroup", normalizeSlimNullableValue(entity.objectiveTargetGroup)]);
  }
  if (Array.isArray(entity && entity.dunPosition) && entity.dunPosition.length === 3) {
    entries.push(["dunPosition", entity.dunPosition]);
  } else if (
    entity &&
    entity.dunPosition &&
    typeof entity.dunPosition === "object" &&
    ["x", "y", "z"].every((axis) => Number.isFinite(Number(entity.dunPosition[axis])))
  ) {
    entries.push([
      "dunPosition",
      [entity.dunPosition.x, entity.dunPosition.y, entity.dunPosition.z],
    ]);
  }
  if (
    Array.isArray(entity && entity.dunRotation) &&
    entity.dunRotation.length === 3 &&
    !["station", "structure", "orbital", "stargate"].includes(String(entity && entity.kind || ""))
  ) {
    entries.push(["dunRotation", entity.dunRotation]);
  }
  const gateActivationRange = toFiniteNumber(entity && entity.gateActivationRange, 0);
  if (gateActivationRange > 0) {
    entries.push(["gateActivationRange", gateActivationRange]);
  }
  if (entity && Object.prototype.hasOwnProperty.call(entity, "dunMusicUrl")) {
    entries.push(["dunMusicUrl", entity.dunMusicUrl || null]);
  }
  if (
    slimGroupID === 548 ||
    (
      entity &&
      (
        entity.warpDisruptionStartTimeMs !== undefined ||
        entity.warpDisruptionStartTime !== undefined
      )
    )
  ) {
    const startTimeMs =
      entity && entity.warpDisruptionStartTimeMs !== undefined
        ? entity.warpDisruptionStartTimeMs
        : entity && entity.warpDisruptionStartTime;
    entries.push([
      "warpDisruptionStartTime",
      buildWallclockFiletimeFromMs(startTimeMs),
    ]);
  }

  if (entity.kind === "ship") {
    entries.push(["corpID", entity.corporationID || 0]);
    entries.push(["allianceID", entity.allianceID || 0]);
    entries.push(["warFactionID", entity.warFactionID || 0]);
    entries.push([
      "charID",
      entity.npcPilotCharacterID || entity.characterID || 0,
    ]);
    const dirtState = resolveShipSlimDirtTime(entity);
    if (dirtState.explicit || dirtState.dirtTime > 0n) {
      entries.push(["dirtTime", buildFiletimeLong(dirtState.dirtTime)]);
    }
    entries.push(["kills", getItemKillCountPlayer(entity.itemID)]);
    if (Array.isArray(entity.cosmeticsItems) && entity.cosmeticsItems.length > 0) {
      entries.push(["cosmeticsItems", buildList(entity.cosmeticsItems)]);
    }
    entries.push(["skinMaterialSetID", entity.skinMaterialSetID ?? null]);
    entries.push([
      "modules",
      buildList(Array.isArray(entity.modules) ? entity.modules : []),
    ]);
    const shipStance = buildShipStanceSlimValue(entity.shipStance);
    if (shipStance) {
      entries.push(["shipStance", shipStance]);
    }
    entries.push([
      "securityStatus",
      toFiniteNumber(entity.securityStatus, 0.0),
    ]);
    entries.push(["bounty", toFiniteNumber(entity.bounty, 0.0)]);
    if (
      Array.isArray(entity.compressionFacilityTypelists) &&
      entity.compressionFacilityTypelists.length > 0
    ) {
      entries.push([
        "compression_facility_typelists",
        buildDict(
          entity.compressionFacilityTypelists
            .map((entry) => ([
              toInt32(entry && entry[0], 0),
              Math.max(1, toInt32(entry && entry[1], 0)),
            ]))
            .filter((entry) => entry[0] > 0 && entry[1] > 0),
        ),
      ]);
    }
  } else if (entity.kind === "station") {
    entries.push(["corpID", entity.corporationID || 0]);
    entries.push(["allianceID", entity.allianceID || 0]);
    entries.push(["warFactionID", entity.warFactionID || 0]);
    entries.push(["online", 1]);
    entries.push(["incapacitated", 0]);
    entries.push(["activityLevel", entity.activityLevel ?? null]);
    entries.push(["skinMaterialSetID", entity.skinMaterialSetID ?? null]);
    if (entity.celestialEffect !== undefined && entity.celestialEffect !== null) {
      entries.push(["celestialEffect", entity.celestialEffect]);
    }
    if (Array.isArray(entity.dunRotation) && entity.dunRotation.length === 3) {
      entries.push(["dunRotation", entity.dunRotation]);
    }
  } else if (entity.kind === "structure") {
    if (!entries.some((entry) => Array.isArray(entry) && entry[0] === "nameID")) {
      entries.push(["nameID", null]);
    }
    entries.push(["corpID", entity.corporationID || 0]);
    entries.push(["allianceID", entity.allianceID || null]);
    entries.push(["warFactionID", entity.warFactionID || null]);
    entries.push(["state", entity.state ?? null]);
    entries.push(["upkeepState", entity.upkeepState ?? null]);
    entries.push([
      "deedState",
      entity.deedState === undefined || entity.deedState === null
        ? null
        : entity.deedState === true || Number(entity.deedState) === 1,
    ]);
    entries.push([
      "unanchoring",
      entity.unanchoring
        ? buildWallclockFiletimeFromMs(entity.unanchoring)
        : false,
    ]);
    entries.push([
      "repairing",
      entity.repairing === undefined || entity.repairing === null
        ? null
        : entity.repairing === true || Number(entity.repairing) === 1,
    ]);
    entries.push([
      "timer",
      buildStructureSlimTimer(entity),
    ]);
    entries.push([
      "deployTimes",
      entity.state === STRUCTURE_STATE.DEPLOY_VULNERABLE
        ? buildStructureSlimDeployTimes(entity)
        : buildList([null, null]),
    ]);
    entries.push([
      "modules",
      buildList(Array.isArray(entity.modules) ? entity.modules : []),
    ]);
    entries.push(["docked", toInt32(entity.docked, 0)]);
    entries.push(["damage", buildStructureSlimDamage(entity)]);
    if (Array.isArray(entity.dunRotation) && entity.dunRotation.length === 3) {
      entries.push(["dunRotation", entity.dunRotation]);
    }
  } else if (entity.kind === "orbital") {
    entries.push(["locationID", entity.locationID || entity.systemID || 0]);
    entries.push(["corpID", entity.corporationID || entity.ownerID || 0]);
    entries.push(["allianceID", entity.allianceID || 0]);
    entries.push(["warFactionID", entity.warFactionID || 0]);
    entries.push(["planetID", entity.planetID || 0]);
    entries.push(["level", entity.level ?? 1]);
    entries.push(["orbitalState", entity.orbitalState ?? null]);
    entries.push(["orbitalTimestamp", buildWallclockFiletimeFromMs(entity.orbitalTimestampMs)]);
    entries.push(["orbitalHackerID", entity.orbitalHackerID ?? null]);
    entries.push(["orbitalHackerProgress", entity.orbitalHackerProgress ?? null]);
    entries.push(["online", 1]);
    entries.push(["incapacitated", 0]);
    // A Customs Office is a combat target, so it reports its damage layers the
    // same way an Upwell structure does - without this the client shows full
    // shield/armor/structure no matter how hard the office is being hit.
    entries.push(["damage", buildStructureSlimDamage(entity)]);
    if (Array.isArray(entity.dunRotation) && entity.dunRotation.length === 3) {
      entries.push(["dunRotation", entity.dunRotation]);
    }
  } else if (entity.kind === "stargate") {
    entries.push(["nameID", null]);
    entries.push(["activationState", entity.activationState ?? 2]);
    entries.push(["poseID", entity.poseID ?? 0]);
    entries.push([
      "localCorruptionStageAndMaximum",
      buildList(entity.localCorruptionStageAndMaximum || [0, 1]),
    ]);
    entries.push([
      "destinationCorruptionStageAndMaximum",
      buildList(entity.destinationCorruptionStageAndMaximum || [0, 1]),
    ]);
    entries.push([
      "localSuppressionStageAndMaximum",
      buildList(entity.localSuppressionStageAndMaximum || [0, 1]),
    ]);
    entries.push([
      "destinationSuppressionStageAndMaximum",
      buildList(entity.destinationSuppressionStageAndMaximum || [0, 1]),
    ]);
    entries.push([
      "hasVolumetricDrifterCloud",
      entity.hasVolumetricDrifterCloud ? 1 : 0,
    ]);
    entries.push(["originSystemOwnerID", entity.originSystemOwnerID ?? null]);
    entries.push([
      "destinationSystemOwnerID",
      entity.destinationSystemOwnerID ?? null,
    ]);
    entries.push([
      "destinationSystemStatusIcons",
      buildList(entity.destinationSystemStatusIcons || []),
    ]);
    entries.push([
      "destinationSystemWarning",
      entity.destinationSystemWarning ?? null,
    ]);
    entries.push([
      "destinationSystemWarningIcon",
      entity.destinationSystemWarningIcon ?? null,
    ]);
    if (Array.isArray(entity.dunRotation) && entity.dunRotation.length === 3) {
      entries.push(["dunRotation", entity.dunRotation]);
    }
    entries.push(["jumps", buildStargateJumps(entity)]);
  } else if (entity.kind === "wormhole") {
    entries.push(["nebulaType", entity.nebulaType ?? null]);
    entries.push(["wormholeSize", toFiniteNumber(entity.wormholeSize, 1)]);
    entries.push(["wormholeAge", toInt32(entity.wormholeAge, 0)]);
    entries.push(["maxShipJumpMass", toInt32(entity.maxShipJumpMass, 0)]);
    entries.push(["isDestTriglavian", entity.isDestTriglavian ? 1 : 0]);
    entries.push([
      "otherSolarSystemClass",
      toInt32(entity.otherSolarSystemClass, 0),
    ]);
  } else if (entity.kind === "container" || entity.kind === "wreck") {
    entries.push(["corpID", entity.corporationID || 0]);
    entries.push(["allianceID", entity.allianceID || 0]);
    entries.push(["warFactionID", entity.warFactionID || 0]);
    entries.push([
      "securityStatus",
      toFiniteNumber(entity.securityStatus, 0.0),
    ]);
    entries.push(["isEmpty", entity.isEmpty ? 1 : 0]);
    // Loot rights drive the client's looting/abandon UI: the tuple is
    // (ownerID, corpID, fleetID, abandoned). Michelle.HaveLootRight /
    // IsAbandoned read this to decide whether a pilot may loot freely and
    // whether the "Abandon Wreck"/"Abandon All Wrecks" menu is offered.
    if (entity.deferLootRightsSlimUpdate !== true) {
      entries.push([
        "lootRights",
        buildList([
          toInt32(entity.ownerID, 0),
          toInt32(entity.lootRightCorpID ?? entity.corporationID, 0),
          entity.lootRightFleetID ?? null,
          Boolean(entity.lootAbandoned),
        ]),
      ]);
    }
    const launcherID = toInt32(entity.launcherID, 0);
    if (launcherID > 0) {
      entries.push(["launcherID", launcherID]);
    }
    if (Array.isArray(entity.dunRotation) && entity.dunRotation.length === 3) {
      entries.push(["dunRotation", entity.dunRotation]);
    }
  } else if (entity.kind === "missile") {
    entries.push(["sourceShipID", entity.sourceShipID || 0]);
    entries.push([
      "launchModules",
      buildList(
        Array.isArray(entity.launchModules)
          ? entity.launchModules.map((value) => Number(value) || 0)
          : [],
      ),
    ]);
  } else if (entity.kind === "fighter") {
    entries.push([
      "fighter.squadronSize",
      Math.max(0, toInt32(entity.squadronSize, 0)),
    ]);
  }

  if (entity && entity.activityState !== undefined && entity.activityState !== null) {
    entries.push(["activityState", toInt32(entity.activityState, 0)]);
  }
  if (entity && entity.component_activate !== undefined && entity.component_activate !== null) {
    const componentActivate = Array.isArray(entity.component_activate)
      ? entity.component_activate
      : [Boolean(entity.component_activate), null];
    entries.push([
      "component_activate",
      buildList([
        Boolean(componentActivate[0]),
        buildOptionalWallclockFiletimeValue(componentActivate[1]),
      ]),
    ]);
  }
  if (
    entity &&
    entity.activate_comp_durationSeconds !== undefined &&
    entity.activate_comp_durationSeconds !== null
  ) {
    entries.push([
      "activate_comp_durationSeconds",
      Math.max(0, toInt32(entity.activate_comp_durationSeconds, 0)),
    ]);
  }
  if (
    entity &&
    entity.component_microJumpDriver !== undefined &&
    entity.component_microJumpDriver !== null
  ) {
    entries.push([
      "component_microJumpDriver",
      buildFiletimeLong(entity.component_microJumpDriver),
    ]);
  }
  if (
    entity &&
    entity.component_linkWithShip !== undefined &&
    entity.component_linkWithShip !== null
  ) {
    const componentLinkWithShip = Array.isArray(entity.component_linkWithShip)
      ? entity.component_linkWithShip
      : [null, 1, null, null];
    entries.push([
      "component_linkWithShip",
      buildList([
        buildOptionalWallclockFiletimeValue(componentLinkWithShip[0]),
        toInt32(componentLinkWithShip[1], 1),
        buildOptionalWallclockFiletimeValue(componentLinkWithShip[2]),
        componentLinkWithShip[3] === undefined ||
        componentLinkWithShip[3] === null ||
        componentLinkWithShip[3] === ""
          ? null
          : toOptionalInt64(componentLinkWithShip[3], null),
      ]),
    ]);
  }
  if (
    entity &&
    entity.component_decloakemitter_nextPing !== undefined &&
    entity.component_decloakemitter_nextPing !== null
  ) {
    entries.push([
      "component_decloakemitter_nextPing",
      buildOptionalWallclockFiletimeValue(entity.component_decloakemitter_nextPing),
    ]);
  }
  if (
    entity &&
    entity.component_phaseStabilizer !== undefined &&
    entity.component_phaseStabilizer !== null
  ) {
    const componentPhaseStabilizer = Array.isArray(entity.component_phaseStabilizer)
      ? entity.component_phaseStabilizer
      : [0, null, 0, null, false, false];
    entries.push([
      "component_phaseStabilizer",
      buildList([
        toInt32(componentPhaseStabilizer[0], 0),
        buildOptionalWallclockFiletimeValue(componentPhaseStabilizer[1]),
        toInt32(componentPhaseStabilizer[2], 0),
        componentPhaseStabilizer[3] === undefined ||
        componentPhaseStabilizer[3] === null ||
        componentPhaseStabilizer[3] === ""
          ? null
          : toOptionalInt64(componentPhaseStabilizer[3], null),
        Boolean(componentPhaseStabilizer[4]),
        Boolean(componentPhaseStabilizer[5]),
      ]),
    ]);
  }
  if (entity && entity.component_reinforce !== undefined && entity.component_reinforce !== null) {
    const componentReinforce = Array.isArray(entity.component_reinforce)
      ? entity.component_reinforce
      : [Boolean(entity.component_reinforce), null];
    entries.push([
      "component_reinforce",
      buildList([
        Boolean(componentReinforce[0]),
        buildWallclockFiletimeFromMs(componentReinforce[1]),
      ]),
    ]);
  }
  if (entity && entity.component_decay !== undefined && entity.component_decay !== null) {
    entries.push([
      "component_decay",
      buildWallclockFiletimeFromMs(entity.component_decay),
    ]);
  }
  if (entity && entity.component_turboshield !== undefined && entity.component_turboshield !== null) {
    entries.push(["component_turboshield", toInt32(entity.component_turboshield, 0)]);
  }
  appendEntityStandings(entries, entity, slimTypeID);

  return buildDict(entries);
}

function buildSlimItemObject(entity) {
  return {
    type: "object",
    name: "foo.SlimItem",
    args: buildSlimItemDict(entity),
  };
}

function buildDroneState(entities = []) {
  // V23.02 rejects util.Rowset here during remote SetState unmarshal.
  return buildRowset(
    DRONE_STATE_HEADERS,
    buildDroneStateRows(entities),
    CLIENT_ROWSET_NAME,
  );
}

function buildStargateJumps(entity) {
  const rows =
    entity && entity.destinationID && entity.destinationSolarSystemID
      ? [[entity.destinationID, entity.destinationSolarSystemID]]
      : [];

  return buildRowset(STARGATE_JUMP_HEADERS, rows, CLIENT_ROWSET_NAME);
}

function buildSolItem(system) {
  return buildPackedRow(SOL_ITEM_COLUMNS, {
    itemID: system.solarSystemID,
    typeID: 5,
    ownerID: 1,
    locationID: system.constellationID,
    flagID: 0,
    contraband: false,
    singleton: 1,
    quantity: -1,
    groupID: 5,
    categoryID: 2,
    customInfo: "",
  });
}

function buildAddBalls2Payload(stateStamp, entities, simFileTime) {
  return statePayloads.buildAddBalls2Payload(
    stateStamp,
    entities,
    simFileTime,
    {
      encodeEntityBall,
      buildSlimItemDict,
      buildDamageState,
      hasDamageableHealth,
    },
  );
}

function buildSetStatePayload(
  stateStamp,
  system,
  egoEntityID,
  entities,
  simFileTime,
  dbuffStateEntries = [],
  effectStateEntries = [],
) {
  return statePayloads.buildSetStatePayload(
    stateStamp,
    system,
    egoEntityID,
    entities,
    simFileTime,
    dbuffStateEntries,
    effectStateEntries,
    {
      encodeEntityBall,
      buildSlimItemObject,
      buildDroneState,
      buildSolItem,
      buildDamageState,
      hasDamageableHealth,
    },
  );
}

module.exports = {
  BALL_FLAG,
  BALL_MODE,
  RUNTIME_UNANCHORED_STRUCTURE_HULL_KIND,
  ...actions,
  buildAddBalls2Payload,
  buildDamageState,
  buildDestinyUpdatePayload: statePayloads.buildDestinyUpdatePayload,
  buildPackagedActionPayload,
  buildSetStatePayload,
  buildSlimItemDict,
  buildSlimItemObject,
  debugDescribeEntityBall,
  restampPayloadState: statePayloads.restampPayloadState,
};
