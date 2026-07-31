"use strict";

const path = require("path");

const log = require(path.join(__dirname, "../../utils/logger"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const structureState = require(path.join(__dirname, "../structure/structureState"));
const {
  STRUCTURE_STATE,
  STRUCTURE_UPKEEP_STATE,
} = require(path.join(__dirname, "../structure/structureConstants"));
const wormholeRuntime = require(path.join(
  __dirname,
  "../exploration/wormholes/wormholeRuntime",
));
const {
  getCorporationRecord,
} = require(path.join(__dirname, "../corporation/corporationState"));
const {
  CORP_ROLE_DIRECTOR,
  getCorporationMember,
  listCorporationMembers,
  toRoleMaskBigInt,
} = require(path.join(__dirname, "../corporation/corporationRuntimeState"));
const characterState = require(path.join(__dirname, "../character/characterState"));
const {
  ESTATE_CAPABILITIES,
  appendHistory,
  ensureFamilyEstateClaimState,
  updateFamilyEstateClaimState,
  writeFamilyEstateClaimState,
} = require("./familyEstateClaimState");
const {
  getFamilyEstateProfile,
  validateFamilyEstateProfile,
} = require("./familyEstateProfile");

const ESTATE_STRUCTURE_OFFSET_METERS = 1_000_000;

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function getEstateClaimContext(profile, structure) {
  return {
    structureID: toPositiveInt(structure && structure.structureID, null),
    holdingCorporationID: toPositiveInt(profile && profile.ownerCorporationID, null),
  };
}

function getSessionCharacterID(session) {
  return toPositiveInt(session && (session.characterID || session.charid), 0);
}

function getSessionCorporationID(session) {
  return toPositiveInt(session && (session.corporationID || session.corpid || session.corpID), 0);
}

function getSessionStructureID(session) {
  return toPositiveInt(session && (session.structureID || session.structureid), 0);
}

function hasCorporationLeadership(corporationID, characterID) {
  const corporation = getCorporationRecord(corporationID);
  const member = getCorporationMember(corporationID, characterID);
  if (!corporation || !member) {
    return false;
  }
  return (
    toPositiveInt(corporation.ceoID, 0) === characterID ||
    member.isCEO === true ||
    (toRoleMaskBigInt(member.roles, 0n) & CORP_ROLE_DIRECTOR) === CORP_ROLE_DIRECTOR
  );
}

function resolveFamilyEstateMemberRole(characterID, corporationID, claimState) {
  const numericCharacterID = toPositiveInt(characterID, 0);
  const numericCorporationID = toPositiveInt(corporationID, 0);
  if (!numericCharacterID || !numericCorporationID || numericCorporationID !== claimState.ownerCorporationID) {
    return "outsider";
  }
  const explicitRole = claimState.explicitRolesByCharacterID[String(numericCharacterID)] || null;
  if (explicitRole === "founder") {
    return "founder";
  }
  if (explicitRole === "steward" || hasCorporationLeadership(numericCorporationID, numericCharacterID)) {
    return "steward";
  }
  return getCorporationMember(numericCorporationID, numericCharacterID) ? "resident" : "outsider";
}

function canManageFamilyEstate(session, claimState) {
  const characterID = getSessionCharacterID(session);
  const corporationID = getSessionCorporationID(session);
  const role = resolveFamilyEstateMemberRole(characterID, corporationID, claimState);
  return role === "founder" || role === "steward";
}

function cloneVector(value = null) {
  return {
    x: Number(value && value.x) || 0,
    y: Number(value && value.y) || 0,
    z: Number(value && value.z) || 0,
  };
}

function normalizeVector(value, fallback = { x: 1, y: 0, z: 0 }) {
  const vector = cloneVector(value);
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (!Number.isFinite(magnitude) || magnitude <= 0) {
    return cloneVector(fallback);
  }
  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
    z: vector.z / magnitude,
  };
}

function buildFamilyEstateStructurePosition(moon) {
  const moonPosition = cloneVector(moon && moon.position);
  const outward = normalizeVector(moonPosition);
  const surfaceClearance = Math.max(
    ESTATE_STRUCTURE_OFFSET_METERS,
    (Number(moon && moon.radius) || 0) + 500_000,
  );
  return {
    x: moonPosition.x + outward.x * surfaceClearance,
    y: moonPosition.y + outward.y * surfaceClearance,
    z: moonPosition.z + outward.z * surfaceClearance,
  };
}

function findFamilyEstateStructure(options = {}) {
  const includeDestroyed = options.includeDestroyed !== false;
  return structureState.listStructures({
    includeDestroyed,
    refresh: false,
  }).find((structure) =>
    structure &&
    structure.devFlags &&
    structure.devFlags.familyEstate === true,
  ) || null;
}

function ensureFamilyEstateStructure(options = {}) {
  const profile = options.profile || getFamilyEstateProfile();
  const validation = options.validation || validateFamilyEstateProfile(profile);
  if (!validation.success || validation.enabled === false) {
    return validation;
  }
  const existing = findFamilyEstateStructure({ includeDestroyed: true });
  if (existing) {
    return {
      success: true,
      enabled: true,
      unchanged: true,
      data: existing,
    };
  }

  const moon = validation.data.moon;
  const createResult = structureState.createStructure({
    typeID: profile.athanorTypeID,
    name: profile.structureName,
    itemName: profile.structureName,
    description:
      "A damaged family refinery and dock recovered in J-space. " +
      "Its basic shelter systems function, but industry, reactions, and moon extraction await restoration.",
    ownerCorpID: profile.ownerCorporationID,
    solarSystemID: profile.homeSystemID,
    moonID: profile.moonID,
    position: buildFamilyEstateStructurePosition(moon),
    rotation: [0, 0, 0],
    state: STRUCTURE_STATE.SHIELD_VULNERABLE,
    stateStartedAt: Date.now(),
    stateEndsAt: null,
    upkeepState: STRUCTURE_UPKEEP_STATE.FULL_POWER,
    hasQuantumCore: true,
    profileID: 1,
    accessProfile: {
      docking: "public",
      tethering: "public",
    },
    conditionState: {
      damage: 0.18,
      armorDamage: 0.45,
      shieldCharge: 0.2,
      charge: 0.35,
      incapacitated: false,
    },
    devFlags: {
      seeded: true,
      familyEstate: true,
      familyEstateVersion: 1,
      estateState: "damaged",
      missionClaimable: true,
      moonID: profile.moonID,
      moonMiningLocationVerified: true,
    },
  }, {
    emitLive: options.emitLive !== false,
  });
  if (!createResult.success) {
    return {
      success: false,
      errorMsg: createResult.errorMsg || "FAMILY_ESTATE_STRUCTURE_CREATE_FAILED",
    };
  }
  return {
    success: true,
    enabled: true,
    unchanged: false,
    data: createResult.data,
  };
}

function getFamilyEstateClaimState(options = {}) {
  const profile = options.profile || getFamilyEstateProfile();
  const structure = options.structure || findFamilyEstateStructure({ includeDestroyed: true });
  const context = getEstateClaimContext(profile, structure);
  const current = ensureFamilyEstateClaimState(context);
  const flags = structure && structure.devFlags || {};
  const structureOwnerCorporationID = toPositiveInt(structure && structure.ownerCorpID, 0);
  const recordedClaimantCharacterID = toPositiveInt(flags.estateClaimantCharacterID, 0);
  const appearsClaimed = Boolean(
    structure &&
    structureOwnerCorporationID > 0 &&
    structureOwnerCorporationID !== toPositiveInt(profile.ownerCorporationID, 0) &&
    recordedClaimantCharacterID > 0,
  );
  if (current.status === "unclaimed" && appearsClaimed) {
    const migrated = {
      ...current,
      status: "claimed",
      ownerCorporationID: structureOwnerCorporationID,
      claimantCharacterID: recordedClaimantCharacterID,
      claimedAtMs: toPositiveInt(flags.estateClaimedAtMs, Date.now()),
      progressStage: String(flags.estateState || "claimed"),
      explicitRolesByCharacterID: {
        ...current.explicitRolesByCharacterID,
        [String(recordedClaimantCharacterID)]: "founder",
      },
    };
    appendHistory(migrated, {
      atMs: Date.now(),
      action: "claim-state-migrated",
      actorCharacterID: recordedClaimantCharacterID,
      corporationID: structureOwnerCorporationID,
      reason: "Recovered claim state from the estate structure record.",
    });
    const writeResult = writeFamilyEstateClaimState(migrated, context);
    return writeResult.success ? writeResult.data : migrated;
  }
  return current;
}

function listFamilyEstateResidents(options = {}) {
  const profile = options.profile || getFamilyEstateProfile();
  const structure = options.structure || findFamilyEstateStructure({ includeDestroyed: true });
  const claimState = options.claimState || getFamilyEstateClaimState({ profile, structure });
  if (claimState.status !== "claimed" || !claimState.ownerCorporationID) {
    return [];
  }
  return listCorporationMembers(claimState.ownerCorporationID).map((member) => {
    const characterID = toPositiveInt(member && member.characterID, 0);
    const character = characterState.getCharacterRecord(characterID) || {};
    return {
      characterID,
      characterName: String(character.characterName || member.characterName || `Character ${characterID}`),
      role: resolveFamilyEstateMemberRole(
        characterID,
        claimState.ownerCorporationID,
        claimState,
      ),
      corporationID: claimState.ownerCorporationID,
    };
  }).filter((entry) => entry.characterID > 0);
}

function claimFamilyEstate(session, options = {}) {
  const profile = options.profile || getFamilyEstateProfile();
  const validation = validateFamilyEstateProfile(profile);
  if (!validation.success || validation.enabled === false) {
    return validation;
  }
  const structureResult = ensureFamilyEstateStructure({
    profile,
    validation,
    emitLive: options.emitLive,
  });
  if (!structureResult.success) {
    return structureResult;
  }
  const structure = structureResult.data;
  if (structure.destroyedAt) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DESTROYED" };
  }

  const characterID = toPositiveInt(options.characterID, getSessionCharacterID(session));
  const corporationID = toPositiveInt(options.corporationID, getSessionCorporationID(session));
  if (!characterID || !corporationID) {
    return { success: false, errorMsg: "FAMILY_ESTATE_CHARACTER_CORPORATION_REQUIRED" };
  }
  const corporation = getCorporationRecord(corporationID);
  if (!corporation || corporation.isNPC === true) {
    return { success: false, errorMsg: "FAMILY_ESTATE_CAPSULEER_CORPORATION_REQUIRED" };
  }
  if (
    options.bypassAuthority !== true &&
    !hasCorporationLeadership(corporationID, characterID)
  ) {
    return { success: false, errorMsg: "FAMILY_ESTATE_CORPORATION_LEADERSHIP_REQUIRED" };
  }
  if (
    options.bypassLocation !== true &&
    getSessionStructureID(session) !== toPositiveInt(structure.structureID, 0)
  ) {
    return { success: false, errorMsg: "FAMILY_ESTATE_DOCKING_REQUIRED" };
  }

  const context = getEstateClaimContext(profile, structure);
  const currentClaimState = getFamilyEstateClaimState({ profile, structure });
  if (currentClaimState.status === "claimed") {
    if (currentClaimState.ownerCorporationID === corporationID) {
      const unchangedResult = {
        success: true,
        unchanged: true,
        data: { structure, claimState: currentClaimState, corporation },
      };
      try {
        require("./familyEstatePrologueRuntime").handleEstateClaimed(
          session,
          unchangedResult,
          { nowMs: options.nowMs || Date.now() },
        );
      } catch (error) {
        log.warn(`[FamilyEstate] Prologue claim hook failed: ${error.message}`);
      }
      return unchangedResult;
    }
    return { success: false, errorMsg: "FAMILY_ESTATE_ALREADY_CLAIMED" };
  }
  if (structure.devFlags && structure.devFlags.missionClaimable === false) {
    return { success: false, errorMsg: "FAMILY_ESTATE_NOT_CLAIMABLE" };
  }

  const nowMs = toPositiveInt(options.nowMs, Date.now());
  const structureUpdate = structureState.updateStructureRecord(
    structure.structureID,
    (next) => {
      next.ownerCorpID = corporationID;
      next.ownerID = corporationID;
      next.accessProfile = { docking: "corp", tethering: "corp" };
      next.devFlags = {
        ...(next.devFlags || {}),
        missionClaimable: false,
        estateState: "claimed",
        estateOwnerCorporationID: corporationID,
        estateClaimantCharacterID: characterID,
        estateClaimedAtMs: nowMs,
      };
      return next;
    },
    { emitLive: options.emitLive !== false },
  );
  if (!structureUpdate.success) {
    return structureUpdate;
  }

  const claimWrite = updateFamilyEstateClaimState((state) => {
    state.status = "claimed";
    state.structureID = structure.structureID;
    state.holdingCorporationID = toPositiveInt(profile.ownerCorporationID, null);
    state.ownerCorporationID = corporationID;
    state.claimantCharacterID = characterID;
    state.claimedAtMs = nowMs;
    state.progressStage = "claimed";
    state.explicitRolesByCharacterID = {
      ...(state.explicitRolesByCharacterID || {}),
      [String(characterID)]: "founder",
    };
    appendHistory(state, {
      atMs: nowMs,
      action: "estate-claimed",
      actorCharacterID: characterID,
      corporationID,
      reason: String(options.reason || "Estate claimed by capsuleer corporation."),
    });
    return state;
  }, context);
  if (!claimWrite.success) {
    structureState.updateStructureRecord(
      structure.structureID,
      () => structure,
      { emitLive: options.emitLive !== false },
    );
    return claimWrite;
  }

  const result = {
    success: true,
    unchanged: false,
    data: {
      structure: structureUpdate.data,
      claimState: claimWrite.data,
      corporation,
    },
  };
  try {
    require("./familyEstatePrologueRuntime").handleEstateClaimed(
      session,
      result,
      { nowMs },
    );
  } catch (error) {
    log.warn(`[FamilyEstate] Prologue claim hook failed: ${error.message}`);
  }
  return result;
}

function setFamilyEstateMemberRole(session, targetCharacterID, role, options = {}) {
  const profile = options.profile || getFamilyEstateProfile();
  const structure = findFamilyEstateStructure({ includeDestroyed: true });
  const claimState = getFamilyEstateClaimState({ profile, structure });
  if (claimState.status !== "claimed") {
    return { success: false, errorMsg: "FAMILY_ESTATE_UNCLAIMED" };
  }
  if (options.bypassAuthority !== true && !canManageFamilyEstate(session, claimState)) {
    return { success: false, errorMsg: "FAMILY_ESTATE_STEWARD_REQUIRED" };
  }
  const numericTargetCharacterID = toPositiveInt(targetCharacterID, 0);
  if (!getCorporationMember(claimState.ownerCorporationID, numericTargetCharacterID)) {
    return { success: false, errorMsg: "FAMILY_ESTATE_TARGET_NOT_RESIDENT" };
  }
  if (numericTargetCharacterID === claimState.claimantCharacterID) {
    return { success: false, errorMsg: "FAMILY_ESTATE_FOUNDER_ROLE_FIXED" };
  }
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole !== "steward" && normalizedRole !== "resident") {
    return { success: false, errorMsg: "FAMILY_ESTATE_ROLE_INVALID" };
  }
  const actorCharacterID = toPositiveInt(options.actorCharacterID, getSessionCharacterID(session));
  return updateFamilyEstateClaimState((state) => {
    state.explicitRolesByCharacterID = { ...(state.explicitRolesByCharacterID || {}) };
    if (normalizedRole === "steward") {
      state.explicitRolesByCharacterID[String(numericTargetCharacterID)] = "steward";
    } else {
      delete state.explicitRolesByCharacterID[String(numericTargetCharacterID)];
    }
    appendHistory(state, {
      atMs: toPositiveInt(options.nowMs, Date.now()),
      action: `role-${normalizedRole}`,
      actorCharacterID,
      corporationID: claimState.ownerCorporationID,
      targetCharacterID: numericTargetCharacterID,
    });
    return state;
  }, getEstateClaimContext(profile, structure));
}

function unlockFamilyEstateCapability(capabilityKey, options = {}) {
  const normalizedKey = String(capabilityKey || "").trim().toLowerCase();
  const capability = ESTATE_CAPABILITIES[normalizedKey];
  if (!capability) {
    return { success: false, errorMsg: "FAMILY_ESTATE_CAPABILITY_INVALID" };
  }
  const profile = options.profile || getFamilyEstateProfile();
  const structure = findFamilyEstateStructure({ includeDestroyed: true });
  const claimState = getFamilyEstateClaimState({ profile, structure });
  if (claimState.status !== "claimed") {
    return { success: false, errorMsg: "FAMILY_ESTATE_UNCLAIMED" };
  }
  if (
    options.system !== true &&
    options.bypassAuthority !== true &&
    !canManageFamilyEstate(options.session, claimState)
  ) {
    return { success: false, errorMsg: "FAMILY_ESTATE_STEWARD_REQUIRED" };
  }
  const missingDependency = capability.dependencies.find(
    (dependency) => claimState.capabilities[dependency] !== true,
  );
  if (missingDependency) {
    return {
      success: false,
      errorMsg: "FAMILY_ESTATE_CAPABILITY_DEPENDENCY_REQUIRED",
      dependency: missingDependency,
    };
  }
  if (claimState.capabilities[normalizedKey] === true) {
    return { success: true, unchanged: true, data: claimState };
  }
  return updateFamilyEstateClaimState((state) => {
    state.capabilities = { ...(state.capabilities || {}), [normalizedKey]: true };
    state.progressStage = normalizedKey;
    appendHistory(state, {
      atMs: toPositiveInt(options.nowMs, Date.now()),
      action: "capability-unlocked",
      actorCharacterID: toPositiveInt(options.actorCharacterID, getSessionCharacterID(options.session)),
      corporationID: claimState.ownerCorporationID,
      capability: normalizedKey,
      reason: String(options.reason || "Estate progression unlock."),
    });
    return state;
  }, getEstateClaimContext(profile, structure));
}

function getFamilyEstateStatus(options = {}) {
  const profile = options.profile || getFamilyEstateProfile();
  const validation = validateFamilyEstateProfile(profile);
  const structure = findFamilyEstateStructure({ includeDestroyed: true });
  const connections = wormholeRuntime.listFamilyEstateConnectionViews({
    includeCollapsed: options.includeCollapsed === true,
    includeUndiscovered: true,
    nowMs: options.nowMs,
  });
  const claimState = getFamilyEstateClaimState({ profile, structure });
  const ownerCorporation = claimState.ownerCorporationID
    ? getCorporationRecord(claimState.ownerCorporationID)
    : null;
  const residents = listFamilyEstateResidents({ profile, structure, claimState });
  const projectStatus = require("./familyEstateProjectsRuntime").getEstateProjectStatus({
    profile,
    structure,
    claimState,
    nowMs: options.nowMs,
  });
  return {
    success: validation.success,
    enabled: profile.enabled === true,
    errorMsg: validation.success ? null : validation.errorMsg,
    profile,
    systems: {
      home: worldData.getSolarSystemByID(profile.homeSystemID),
      highSec: worldData.getSolarSystemByID(profile.highSecSystemID),
      lowSec: worldData.getSolarSystemByID(profile.lowSecSystemID),
    },
    moon: worldData.getCelestialByID(profile.moonID),
    structure,
    claimState,
    ownerCorporation,
    residents,
    projectStatus,
    connections,
    activePermanentConnectionCount: connections.filter(
      (entry) => entry.persistent === true,
    ).length,
    activeRandomConnectionCount: connections.filter(
      (entry) => entry.estateConnectionRole === "random",
    ).length,
  };
}

function ensureFamilyEstate(options = {}) {
  const profile = options.profile || getFamilyEstateProfile();
  const validation = validateFamilyEstateProfile(profile);
  if (!validation.success || validation.enabled === false) {
    return validation;
  }
  const connectionResult = wormholeRuntime.ensureFamilyEstateConnections(
    options.nowMs || Date.now(),
  );
  if (!connectionResult.success) {
    return connectionResult;
  }
  const structureResult = ensureFamilyEstateStructure({
    profile,
    validation,
    emitLive: options.emitLive,
  });
  if (!structureResult.success) {
    return structureResult;
  }
  getFamilyEstateClaimState({ profile, structure: structureResult.data });
  require("./familyEstateProjectsRuntime").startFamilyEstateProjectScheduler();
  const status = getFamilyEstateStatus({ profile, nowMs: options.nowMs });
  log.info(
    `[FamilyEstate] ${status.systems.home.solarSystemName} ready | ` +
    `structure=${status.structure && status.structure.structureID || 0} ` +
    `permanent=${status.activePermanentConnectionCount} ` +
    `random=${status.activeRandomConnectionCount}`,
  );
  return {
    success: true,
    enabled: true,
    data: {
      profile,
      structure: structureResult.data,
      structureCreated: structureResult.unchanged !== true,
      connectionsCreated: connectionResult.data.createdPairs,
      status,
    },
  };
}

module.exports = {
  ESTATE_CAPABILITIES,
  ESTATE_STRUCTURE_OFFSET_METERS,
  buildFamilyEstateStructurePosition,
  canManageFamilyEstate,
  claimFamilyEstate,
  ensureFamilyEstate,
  ensureFamilyEstateStructure,
  findFamilyEstateStructure,
  getFamilyEstateClaimState,
  getFamilyEstateStatus,
  listFamilyEstateResidents,
  resolveFamilyEstateMemberRole,
  setFamilyEstateMemberRole,
  unlockFamilyEstateCapability,
};
