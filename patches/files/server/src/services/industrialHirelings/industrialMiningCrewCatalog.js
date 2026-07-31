"use strict";

const {
  LOADOUT_IDS,
  PROFILE_IDS,
  TYPE,
} = require("../../space/npc/governance/industrialCrewDoctrineCatalog");

const INDUSTRIAL_MINING_CREW_CATALOG_REVISION = 1;
const CONTRACT_KIND = "mining_crew";

const CREW_TYPE_ID = Object.freeze({
  VENTURE: "venture_crew",
  BARGE: "barge_crew",
  EXHUMER_SECURITY: "exhumer_security_crew",
  EXHUMER_YIELD: "exhumer_yield_crew",
  ORCA_EXTRACTION: "orca_extraction_company",
  RORQUAL_INDUSTRIAL: "rorqual_industrial_division",
});

const CREW_MEMBER_ROLE = Object.freeze({
  MINER: "miner",
  MINING_SUPPORT: "mining_support",
  HAULER: "hauler",
});

const SECURITY_BAND = Object.freeze({
  HIGHSEC: "highsec",
  LOWSEC: "lowsec",
  NULLSEC: "nullsec",
});

const TIER_LABEL = Object.freeze({
  1: "I",
  2: "II",
  3: "III",
  4: "IV",
  5: "V",
  6: "VI",
});

const ALL_SECURITY_BANDS = Object.freeze([
  SECURITY_BAND.HIGHSEC,
  SECURITY_BAND.LOWSEC,
  SECURITY_BAND.NULLSEC,
]);

const LOW_AND_NULL_SECURITY_BANDS = Object.freeze([
  SECURITY_BAND.LOWSEC,
  SECURITY_BAND.NULLSEC,
]);

const HULL = Object.freeze({
  VENTURE: Object.freeze({
    profileID: PROFILE_IDS.VENTURE,
    loadoutID: LOADOUT_IDS.VENTURE,
    shipTypeID: TYPE.VENTURE,
    shipTypeName: "Venture",
  }),
  RETRIEVER: Object.freeze({
    profileID: PROFILE_IDS.RETRIEVER,
    loadoutID: LOADOUT_IDS.RETRIEVER,
    shipTypeID: TYPE.RETRIEVER,
    shipTypeName: "Retriever",
  }),
  SKIFF: Object.freeze({
    profileID: PROFILE_IDS.SKIFF,
    loadoutID: LOADOUT_IDS.SKIFF,
    shipTypeID: TYPE.SKIFF,
    shipTypeName: "Skiff",
  }),
  HULK: Object.freeze({
    profileID: PROFILE_IDS.HULK,
    loadoutID: LOADOUT_IDS.HULK,
    shipTypeID: TYPE.HULK,
    shipTypeName: "Hulk",
  }),
  PORPOISE: Object.freeze({
    profileID: PROFILE_IDS.PORPOISE,
    loadoutID: LOADOUT_IDS.PORPOISE,
    shipTypeID: TYPE.PORPOISE,
    shipTypeName: "Porpoise",
  }),
  ORCA: Object.freeze({
    profileID: PROFILE_IDS.ORCA,
    loadoutID: LOADOUT_IDS.ORCA,
    shipTypeID: TYPE.ORCA,
    shipTypeName: "Orca",
  }),
  RORQUAL: Object.freeze({
    profileID: PROFILE_IDS.RORQUAL,
    loadoutID: LOADOUT_IDS.RORQUAL,
    shipTypeID: TYPE.RORQUAL,
    shipTypeName: "Rorqual",
  }),
  MIASMOS: Object.freeze({
    profileID: PROFILE_IDS.MIASMOS,
    loadoutID: LOADOUT_IDS.MIASMOS,
    shipTypeID: TYPE.MIASMOS,
    shipTypeName: "Miasmos",
  }),
  BUSTARD: Object.freeze({
    profileID: PROFILE_IDS.BUSTARD,
    loadoutID: LOADOUT_IDS.BUSTARD,
    shipTypeID: TYPE.BUSTARD,
    shipTypeName: "Bustard",
  }),
});

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function slot(slotID, role, hull, options = {}) {
  return deepFreeze({
    slotID,
    slotIndex: Math.max(0, Math.trunc(Number(options.slotIndex) || 0)),
    role,
    isCrewChief: options.isCrewChief === true,
    profileID: hull.profileID,
    loadoutID: hull.loadoutID,
    shipTypeID: hull.shipTypeID,
    shipTypeName: hull.shipTypeName,
  });
}

function buildSlots(rows, crewChiefSlotID) {
  return rows.map((row, index) => slot(
    row.slotID,
    row.role,
    row.hull,
    {
      slotIndex: index,
      isCrewChief: row.slotID === crewChiefSlotID,
    },
  ));
}

function packageRecord({
  crewTypeID,
  tier,
  name,
  composition,
  rows,
  crewChiefSlotID,
  mobilizationFeeISK,
  refundableLossEscrowISK,
  activePayrollISKPerHour,
  requiredCrewOvermatch,
  maximumThreatBountyISK = 30_000,
  allowedSecurityClasses = ALL_SECURITY_BANDS,
}) {
  const memberSlots = buildSlots(rows, crewChiefSlotID);
  return deepFreeze({
    catalogRevision: INDUSTRIAL_MINING_CREW_CATALOG_REVISION,
    contractKind: CONTRACT_KIND,
    crewTypeID,
    tier,
    tierLabel: TIER_LABEL[tier],
    name,
    composition,
    hullCount: memberSlots.length,
    memberSlots,
    pricing: {
      mobilizationFeeISK,
      refundableLossEscrowISK,
      activePayrollISKPerHour,
      upfrontISK: mobilizationFeeISK + refundableLossEscrowISK,
    },
    security: {
      allowedSecurityClasses: [...allowedSecurityClasses],
      highSecurityAllowed: allowedSecurityClasses.includes(SECURITY_BAND.HIGHSEC),
      lowSecurityAllowed: allowedSecurityClasses.includes(SECURITY_BAND.LOWSEC),
      nullSecurityAllowed: allowedSecurityClasses.includes(SECURITY_BAND.NULLSEC),
    },
    threatDoctrine: {
      requiredCrewOvermatch,
      maximumThreatBountyISK,
      projectedCasualtyProbabilityCeiling: 0.01,
    },
  });
}

function memberRows(role, hull, count, prefix) {
  return Array.from({ length: count }, (_unused, index) => ({
    slotID: `${prefix}-${String(index + 1).padStart(2, "0")}`,
    role,
    hull,
  }));
}

const INDUSTRIAL_MINING_CREW_PACKAGES = deepFreeze([
  packageRecord({
    crewTypeID: CREW_TYPE_ID.VENTURE,
    tier: 1,
    name: "Venture Crew",
    composition: "3 Ventures, 1 Miasmos ore hauler",
    rows: [
      ...memberRows(CREW_MEMBER_ROLE.MINER, HULL.VENTURE, 3, "miner"),
      ...memberRows(CREW_MEMBER_ROLE.HAULER, HULL.MIASMOS, 1, "hauler"),
    ],
    crewChiefSlotID: "miner-01",
    mobilizationFeeISK: 5_000_000,
    refundableLossEscrowISK: 2_500_000,
    activePayrollISKPerHour: 250_000,
    requiredCrewOvermatch: 3,
  }),
  packageRecord({
    crewTypeID: CREW_TYPE_ID.BARGE,
    tier: 2,
    name: "Barge Crew",
    composition: "3 Retrievers, 1 Porpoise, 1 Miasmos ore hauler",
    rows: [
      ...memberRows(CREW_MEMBER_ROLE.MINER, HULL.RETRIEVER, 3, "miner"),
      ...memberRows(CREW_MEMBER_ROLE.MINING_SUPPORT, HULL.PORPOISE, 1, "support"),
      ...memberRows(CREW_MEMBER_ROLE.HAULER, HULL.MIASMOS, 1, "hauler"),
    ],
    crewChiefSlotID: "support-01",
    mobilizationFeeISK: 55_000_000,
    refundableLossEscrowISK: 155_000_000,
    activePayrollISKPerHour: 1_500_000,
    requiredCrewOvermatch: 2.75,
    maximumThreatBountyISK: 40_000,
  }),
  packageRecord({
    crewTypeID: CREW_TYPE_ID.EXHUMER_SECURITY,
    tier: 3,
    name: "Exhumer Security Crew",
    composition: "3 Skiffs, 1 Porpoise, 1 Bustard heavy hauler",
    rows: [
      ...memberRows(CREW_MEMBER_ROLE.MINER, HULL.SKIFF, 3, "miner"),
      ...memberRows(CREW_MEMBER_ROLE.MINING_SUPPORT, HULL.PORPOISE, 1, "support"),
      ...memberRows(CREW_MEMBER_ROLE.HAULER, HULL.BUSTARD, 1, "hauler"),
    ],
    crewChiefSlotID: "support-01",
    mobilizationFeeISK: 285_000_000,
    refundableLossEscrowISK: 810_000_000,
    activePayrollISKPerHour: 8_000_000,
    requiredCrewOvermatch: 2.25,
    maximumThreatBountyISK: 55_000,
  }),
  packageRecord({
    crewTypeID: CREW_TYPE_ID.EXHUMER_YIELD,
    tier: 4,
    name: "Exhumer Yield Crew",
    composition: "4 Hulks, 1 Porpoise, 1 Bustard heavy hauler",
    rows: [
      ...memberRows(CREW_MEMBER_ROLE.MINER, HULL.HULK, 4, "miner"),
      ...memberRows(CREW_MEMBER_ROLE.MINING_SUPPORT, HULL.PORPOISE, 1, "support"),
      ...memberRows(CREW_MEMBER_ROLE.HAULER, HULL.BUSTARD, 1, "hauler"),
    ],
    crewChiefSlotID: "support-01",
    mobilizationFeeISK: 350_000_000,
    refundableLossEscrowISK: 1_000_000_000,
    activePayrollISKPerHour: 10_000_000,
    requiredCrewOvermatch: 3,
    maximumThreatBountyISK: 55_000,
  }),
  packageRecord({
    crewTypeID: CREW_TYPE_ID.ORCA_EXTRACTION,
    tier: 5,
    name: "Orca Extraction Company",
    composition: "4 Hulks, 2 Skiffs, 1 Orca, 1 Bustard heavy hauler",
    rows: [
      ...memberRows(CREW_MEMBER_ROLE.MINER, HULL.HULK, 4, "miner"),
      ...memberRows(CREW_MEMBER_ROLE.MINER, HULL.SKIFF, 2, "security-miner"),
      ...memberRows(CREW_MEMBER_ROLE.MINING_SUPPORT, HULL.ORCA, 1, "support"),
      ...memberRows(CREW_MEMBER_ROLE.HAULER, HULL.BUSTARD, 1, "hauler"),
    ],
    crewChiefSlotID: "support-01",
    mobilizationFeeISK: 800_000_000,
    refundableLossEscrowISK: 2_300_000_000,
    activePayrollISKPerHour: 23_000_000,
    requiredCrewOvermatch: 2,
    maximumThreatBountyISK: 75_000,
  }),
  packageRecord({
    crewTypeID: CREW_TYPE_ID.RORQUAL_INDUSTRIAL,
    tier: 6,
    name: "Rorqual Industrial Division",
    composition: "6 Hulks, 2 Skiffs, 1 Rorqual, 1 Orca, 2 Bustard heavy haulers",
    rows: [
      ...memberRows(CREW_MEMBER_ROLE.MINER, HULL.HULK, 6, "miner"),
      ...memberRows(CREW_MEMBER_ROLE.MINER, HULL.SKIFF, 2, "security-miner"),
      { slotID: "capital-support-01", role: CREW_MEMBER_ROLE.MINING_SUPPORT, hull: HULL.RORQUAL },
      { slotID: "support-01", role: CREW_MEMBER_ROLE.MINING_SUPPORT, hull: HULL.ORCA },
      ...memberRows(CREW_MEMBER_ROLE.HAULER, HULL.BUSTARD, 2, "hauler"),
    ],
    crewChiefSlotID: "capital-support-01",
    mobilizationFeeISK: 2_500_000_000,
    refundableLossEscrowISK: 7_200_000_000,
    activePayrollISKPerHour: 72_000_000,
    requiredCrewOvermatch: 1.75,
    maximumThreatBountyISK: 120_000,
    allowedSecurityClasses: LOW_AND_NULL_SECURITY_BANDS,
  }),
]);

const PACKAGE_BY_TYPE_ID = new Map(
  INDUSTRIAL_MINING_CREW_PACKAGES.map((entry) => [entry.crewTypeID, entry]),
);

function normalizeCrewTypeID(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveIndustrialMiningCrewPackage(crewTypeID) {
  return PACKAGE_BY_TYPE_ID.get(normalizeCrewTypeID(crewTypeID)) || null;
}

function listIndustrialMiningCrewPackages() {
  return INDUSTRIAL_MINING_CREW_PACKAGES;
}

function buildIndustrialMiningCrewQuote(crewTypeID) {
  const packageDefinition = resolveIndustrialMiningCrewPackage(crewTypeID);
  return packageDefinition ? deepFreeze(cloneValue(packageDefinition)) : null;
}

function normalizeSecurityBand(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
  if (["high", "highsec", "highsecurity"].includes(normalized)) {
    return SECURITY_BAND.HIGHSEC;
  }
  if (["low", "lowsec", "lowsecurity"].includes(normalized)) {
    return SECURITY_BAND.LOWSEC;
  }
  if (["null", "nullsec", "nullsecurity", "zerosec", "zerosecurity"].includes(normalized)) {
    return SECURITY_BAND.NULLSEC;
  }
  return null;
}

function resolveSecurityBand(securityArg) {
  if (typeof securityArg === "string") {
    return normalizeSecurityBand(securityArg);
  }
  if (typeof securityArg === "number" && Number.isFinite(securityArg)) {
    return securityArg >= 0.5
      ? SECURITY_BAND.HIGHSEC
      : securityArg > 0
        ? SECURITY_BAND.LOWSEC
        : SECURITY_BAND.NULLSEC;
  }
  if (!securityArg || typeof securityArg !== "object") {
    return null;
  }
  const explicit = normalizeSecurityBand(
    securityArg.securityBand ||
    securityArg.securityClassName ||
    securityArg.band,
  );
  if (explicit) {
    return explicit;
  }
  const status = Number(
    securityArg.securityStatus ??
    securityArg.security ??
    securityArg.securityLevel,
  );
  return Number.isFinite(status) ? resolveSecurityBand(status) : null;
}

function isIndustrialMiningCrewSecurityAllowed(crewTypeID, securityArg) {
  const packageDefinition = resolveIndustrialMiningCrewPackage(crewTypeID);
  const securityBand = resolveSecurityBand(securityArg);
  if (!packageDefinition || !securityBand) {
    return false;
  }
  return packageDefinition.security.allowedSecurityClasses.includes(securityBand);
}

function buildIndustrialMiningCrewRoster(crewTypeID, options = {}) {
  const packageDefinition = resolveIndustrialMiningCrewPackage(crewTypeID);
  if (!packageDefinition) {
    return null;
  }
  const contractID = String(options.contractID || "").trim();
  const contractSerial = Math.max(0, Math.trunc(Number(options.contractSerial) || 0));
  const buildShipIdentityID = typeof options.buildShipIdentityID === "function"
    ? options.buildShipIdentityID
    : () => 0;
  return packageDefinition.memberSlots.map((memberSlot) => ({
    memberID: contractID
      ? `${contractID}:${memberSlot.slotID}`
      : `${packageDefinition.crewTypeID}:${memberSlot.slotID}`,
    identityKey: contractID
      ? `${contractID}:${memberSlot.slotID}`
      : `${packageDefinition.crewTypeID}:${memberSlot.slotID}`,
    ...cloneValue(memberSlot),
    pilotIdentityID: 0,
    pilotActorID: null,
    pilotName: null,
    shipIdentityID: Math.max(
      0,
      Math.trunc(Number(buildShipIdentityID(contractSerial, memberSlot.slotIndex)) || 0),
    ),
    shipName: null,
    runtimeEntityID: 0,
    runtimeShipItemID: 0,
    state: "unmaterialized",
    managedDroneStock: null,
    statistics: {
      oreMinedM3: 0,
      cargoHauledM3: 0,
      tripsCompleted: 0,
      hullLosses: 0,
      droneLosses: 0,
    },
  }));
}

module.exports = {
  ALL_SECURITY_BANDS,
  CONTRACT_KIND,
  CREW_MEMBER_ROLE,
  CREW_TYPE_ID,
  HULL,
  INDUSTRIAL_MINING_CREW_CATALOG_REVISION,
  INDUSTRIAL_MINING_CREW_PACKAGES,
  SECURITY_BAND,
  buildIndustrialMiningCrewQuote,
  buildIndustrialMiningCrewRoster,
  isIndustrialMiningCrewSecurityAllowed,
  listIndustrialMiningCrewPackages,
  normalizeCrewTypeID,
  normalizeSecurityBand,
  resolveIndustrialMiningCrewPackage,
  resolveSecurityBand,
};
