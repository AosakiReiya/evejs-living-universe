"use strict";

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const worldData = require(path.join(__dirname, "../../space/worldData"));
const {
  getSystemAuthority,
  getSystemClassID,
} = require(path.join(
  __dirname,
  "../exploration/wormholes/wormholeAuthority",
));

const FAMILY_ESTATE_ATHANOR_TYPE_ID = 35835;
const FAMILY_ESTATE_HIGHSEC_CODE = "B520";
const FAMILY_ESTATE_LOWSEC_CODE = "R051";
const FAMILY_ESTATE_SLOT_PREFIX = "family-estate";
const FAMILY_ESTATE_RANDOM_DESTINATION_CLASS_IDS = Object.freeze([
  7, // high security
  8, // low security
  9, // null security
  1, // C1
  2, // C2
  3, // C3
]);

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toNonNegativeInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function getFamilyEstateProfile() {
  const homeSystemID = toPositiveInt(config.familyEstateHomeSystemID, 31000355);
  const highSecSystemID = toPositiveInt(config.familyEstateHighSecSystemID, 30030141);
  const lowSecSystemID = toPositiveInt(config.familyEstateLowSecSystemID, 30045347);
  const moonID = toPositiveInt(config.familyEstateMoonID, 40369145);
  return {
    enabled: config.familyEstateEnabled === true,
    homeSystemID,
    highSecSystemID,
    lowSecSystemID,
    moonID,
    ownerCorporationID: toPositiveInt(config.familyEstateOwnerCorporationID, 1000009),
    structureName:
      String(config.familyEstateStructureName || "").trim() || "The Family Holding",
    athanorTypeID: FAMILY_ESTATE_ATHANOR_TYPE_ID,
    randomConnectionCount: toNonNegativeInt(
      config.familyEstateRandomConnectionCount,
      2,
    ),
    randomRespawnDelaySeconds: toNonNegativeInt(
      config.familyEstateRandomRespawnDelaySeconds,
      60,
    ),
    suppressNativeHomeStatics: true,
    permanentConnections: [
      {
        key: "highsec",
        slotKey: `${FAMILY_ESTATE_SLOT_PREFIX}:permanent:highsec`,
        sourceSystemID: homeSystemID,
        destinationSystemID: highSecSystemID,
        sourceCode: FAMILY_ESTATE_HIGHSEC_CODE,
        destinationClassID: 7,
      },
      {
        key: "lowsec",
        slotKey: `${FAMILY_ESTATE_SLOT_PREFIX}:permanent:lowsec`,
        sourceSystemID: homeSystemID,
        destinationSystemID: lowSecSystemID,
        sourceCode: FAMILY_ESTATE_LOWSEC_CODE,
        destinationClassID: 8,
      },
    ],
    randomDestinationClassIDs: [...FAMILY_ESTATE_RANDOM_DESTINATION_CLASS_IDS],
    randomSlotPrefix: `${FAMILY_ESTATE_SLOT_PREFIX}:random:`,
  };
}

function isFamilyEstateHomeSystem(systemID, profile = getFamilyEstateProfile()) {
  return profile.enabled === true &&
    toPositiveInt(systemID, 0) === toPositiveInt(profile.homeSystemID, 0);
}

function isFamilyEstateRelevantSystem(systemID, profile = getFamilyEstateProfile()) {
  const numericSystemID = toPositiveInt(systemID, 0);
  return profile.enabled === true && new Set([
    toPositiveInt(profile.homeSystemID, 0),
    toPositiveInt(profile.highSecSystemID, 0),
    toPositiveInt(profile.lowSecSystemID, 0),
  ]).has(numericSystemID);
}

function validateFamilyEstateProfile(profile = getFamilyEstateProfile()) {
  if (profile.enabled !== true) {
    return { success: true, enabled: false, data: profile };
  }

  const homeSystem = worldData.getSolarSystemByID(profile.homeSystemID);
  const highSecSystem = worldData.getSolarSystemByID(profile.highSecSystemID);
  const lowSecSystem = worldData.getSolarSystemByID(profile.lowSecSystemID);
  const moon = worldData.getCelestialByID(profile.moonID);
  if (!homeSystem || !highSecSystem || !lowSecSystem || !moon) {
    return {
      success: false,
      errorMsg: "FAMILY_ESTATE_STATIC_LOCATION_NOT_FOUND",
      data: { profile, homeSystem, highSecSystem, lowSecSystem, moon },
    };
  }

  const homeAuthority = getSystemAuthority(profile.homeSystemID);
  const homeClassID = getSystemClassID(
    profile.homeSystemID,
    homeAuthority && homeAuthority.securityStatus,
  );
  if (homeClassID !== 2) {
    return {
      success: false,
      errorMsg: "FAMILY_ESTATE_HOME_MUST_BE_CLASS_2",
      data: { profile, homeClassID },
    };
  }
  if (String(homeAuthority && homeAuthority.environmentFamily || "").trim()) {
    return {
      success: false,
      errorMsg: "FAMILY_ESTATE_HOME_MUST_BE_EFFECT_FREE",
      data: { profile, environmentFamily: homeAuthority.environmentFamily },
    };
  }
  if (Number(highSecSystem.security) < 0.5) {
    return {
      success: false,
      errorMsg: "FAMILY_ESTATE_HIGHSEC_ENDPOINT_INVALID",
      data: { profile, security: highSecSystem.security },
    };
  }
  if (!(Number(lowSecSystem.security) > 0 && Number(lowSecSystem.security) < 0.5)) {
    return {
      success: false,
      errorMsg: "FAMILY_ESTATE_LOWSEC_ENDPOINT_INVALID",
      data: { profile, security: lowSecSystem.security },
    };
  }
  if (
    toPositiveInt(moon.solarSystemID, 0) !== profile.homeSystemID ||
    String(moon.kind || "").toLowerCase() !== "moon"
  ) {
    return {
      success: false,
      errorMsg: "FAMILY_ESTATE_MOON_NOT_IN_HOME_SYSTEM",
      data: { profile, moon },
    };
  }

  return {
    success: true,
    enabled: true,
    data: {
      ...profile,
      homeSystem,
      highSecSystem,
      lowSecSystem,
      homeAuthority,
      moon,
    },
  };
}

module.exports = {
  FAMILY_ESTATE_ATHANOR_TYPE_ID,
  FAMILY_ESTATE_SLOT_PREFIX,
  getFamilyEstateProfile,
  isFamilyEstateHomeSystem,
  isFamilyEstateRelevantSystem,
  validateFamilyEstateProfile,
};
