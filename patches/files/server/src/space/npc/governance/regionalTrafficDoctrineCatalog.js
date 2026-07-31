"use strict";

// Regional living-universe traffic uses player hulls and real player modules.
// Keep the catalog compact by generating the repeated role/tier combinations
// from racial equipment families rather than hand-authoring every spawn row.

const DOCTRINE_REVISION = 7;

const GROUP_KEYS = Object.freeze({
  shuttle: "shuttle",
  haulerCivilian: "haulerCivilian",
  haulerStandard: "haulerStandard",
  haulerBulk: "haulerBulk",
  haulerSecure: "haulerSecure",
  haulerTrunk: "haulerTrunk",
  convoySecure: "convoySecure",
  policeStandard: "policeStandard",
  policeElite: "policeElite",
  policeCommand: "policeCommand",
  pirateStandard: "pirateStandard",
  pirateVeteran: "pirateVeteran",
  pirateElite: "pirateElite",
  pirateCommand: "pirateCommand",
});

const EMPIRE_DEFINITIONS = Object.freeze({
  caldari: Object.freeze({
    key: "caldari",
    raceID: 1,
    factionID: 500001,
    factionName: "Caldari State",
    corporationID: 1000035,
    corporationName: "Caldari Navy",
    shuttle: 672,
    haulers: Object.freeze([648, 649, 649, 12731, 20185]),
    hulls: Object.freeze({
      small: Object.freeze([602, 603, 16238]),
      medium: Object.freeze([621, 623, 620]),
      battlecruiser: Object.freeze([24698, 16227]),
      battleship: Object.freeze([638, 24688]),
    }),
    weapons: Object.freeze({ small: 499, medium: 501, large: 13320 }),
    charges: Object.freeze({ small: 210, medium: 209, large: 203 }),
    tankStyle: "shield",
    damageModule: 12274,
    supportModule: 3596,
    racialSkills: Object.freeze({ frigate: 3330, cruiser: 3334, battlecruiser: 33096, battleship: 3338, hauler: 3342 }),
    weaponSkills: Object.freeze({ small: 3321, medium: 3324, large: 3326 }),
  }),
  minmatar: Object.freeze({
    key: "minmatar",
    raceID: 2,
    factionID: 500002,
    factionName: "Minmatar Republic",
    corporationID: 1000051,
    corporationName: "Republic Fleet",
    shuttle: 588,
    haulers: Object.freeze([653, 652, 652, 12735, 20189]),
    hulls: Object.freeze({
      small: Object.freeze([585, 587, 16242]),
      medium: Object.freeze([622, 629, 631]),
      battlecruiser: Object.freeze([16231, 24702]),
      battleship: Object.freeze([24694, 639]),
    }),
    weapons: Object.freeze({ small: 486, medium: 491, large: 496 }),
    charges: Object.freeze({ small: 185, medium: 193, large: 201 }),
    tankStyle: "shield",
    damageModule: 520,
    supportModule: 3596,
    racialSkills: Object.freeze({ frigate: 3329, cruiser: 3333, battlecruiser: 33095, battleship: 3337, hauler: 3341 }),
    weaponSkills: Object.freeze({ small: 3302, medium: 3305, large: 3308 }),
  }),
  amarr: Object.freeze({
    key: "amarr",
    raceID: 4,
    factionID: 500003,
    factionName: "Amarr Empire",
    corporationID: 1000084,
    corporationName: "Imperial Navy",
    shuttle: 596,
    haulers: Object.freeze([19744, 1944, 1944, 12753, 20183]),
    hulls: Object.freeze({
      small: Object.freeze([589, 597, 16236]),
      medium: Object.freeze([2006, 624, 625]),
      battlecruiser: Object.freeze([24696, 16233]),
      battleship: Object.freeze([24692, 642]),
    }),
    weapons: Object.freeze({ small: 453, medium: 458, large: 462 }),
    charges: Object.freeze({ small: 246, medium: 254, large: 262 }),
    tankStyle: "armor",
    damageModule: 2363,
    supportModule: 11357,
    racialSkills: Object.freeze({ frigate: 3331, cruiser: 3335, battlecruiser: 33097, battleship: 3339, hauler: 3343 }),
    weaponSkills: Object.freeze({ small: 3303, medium: 3306, large: 3309 }),
  }),
  gallente: Object.freeze({
    key: "gallente",
    raceID: 8,
    factionID: 500004,
    factionName: "Gallente Federation",
    corporationID: 1000120,
    corporationName: "Federation Navy",
    shuttle: 11129,
    haulers: Object.freeze([650, 657, 657, 12745, 20187]),
    hulls: Object.freeze({
      small: Object.freeze([593, 594, 16240]),
      medium: Object.freeze([626, 627, 634]),
      battlecruiser: Object.freeze([24700, 16229]),
      battleship: Object.freeze([24690, 641]),
    }),
    weapons: Object.freeze({ small: 10678, medium: 12344, large: 12354 }),
    charges: Object.freeze({ small: 222, medium: 230, large: 238 }),
    tankStyle: "armor",
    damageModule: 9944,
    supportModule: 11357,
    racialSkills: Object.freeze({ frigate: 3328, cruiser: 3332, battlecruiser: 33094, battleship: 3336, hauler: 3340 }),
    weaponSkills: Object.freeze({ small: 3301, medium: 3304, large: 3307 }),
  }),
});

const PIRATE_DEFINITIONS = Object.freeze({
  guristas: Object.freeze({
    key: "guristas", factionID: 500010, factionName: "Guristas Pirates",
    corporationID: 1000127, corporationName: "Guristas", raceKey: "caldari", utilityModule: 1957,
    skillRaceKeys: Object.freeze(["caldari", "gallente"]),
    hulls: Object.freeze({ small: 17930, medium: 17715, battleship: 17918 }),
    droneTypeID: 2464,
  }),
  angels: Object.freeze({
    key: "angels", factionID: 500011, factionName: "Angel Cartel",
    corporationID: 1000138, corporationName: "Dominations", raceKey: "minmatar", utilityModule: 3242,
    skillRaceKeys: Object.freeze(["minmatar", "gallente"]),
    hulls: Object.freeze({ small: 17932, medium: 17720, battleship: 17738 }),
  }),
  blood: Object.freeze({
    key: "blood", factionID: 500012, factionName: "Blood Raider Covenant",
    corporationID: 1000134, corporationName: "Blood Raiders", raceKey: "amarr", utilityModule: 12265,
    skillRaceKeys: Object.freeze(["amarr", "minmatar"]),
    hulls: Object.freeze({ small: 17926, medium: 17922, battleship: 17920 }),
  }),
  sanshas: Object.freeze({
    key: "sanshas", factionID: 500019, factionName: "Sansha's Nation",
    corporationID: 1000162, corporationName: "True Power", raceKey: "amarr", tankStyle: "shield", utilityModule: 2108,
    skillRaceKeys: Object.freeze(["amarr", "caldari"]),
    hulls: Object.freeze({ small: 17924, medium: 17718, battleship: 17736 }),
  }),
  serpentis: Object.freeze({
    key: "serpentis", factionID: 500020, factionName: "Serpentis",
    corporationID: 1000135, corporationName: "Serpentis Corporation", raceKey: "gallente", utilityModule: 526,
    skillRaceKeys: Object.freeze(["gallente", "minmatar"]),
    hulls: Object.freeze({ small: 17928, medium: 17722, battleship: 17740 }),
    droneTypeID: 2454,
  }),
});

// Minor empires and pirate-owned civilian stations generally procure ships
// from their closest allied hull line. This also prevents bloodline race data
// (notably Ammatar) from overriding the faction's actual military alignment.
const EMPIRE_KEY_BY_FACTION_ID = Object.freeze({
  500001: "caldari",
  500002: "minmatar",
  500003: "amarr",
  500004: "gallente",
  500007: "amarr", // Ammatar Mandate
  500008: "amarr", // Khanid Kingdom
  500009: "gallente", // Intaki Syndicate
  500010: "caldari", // Guristas civilian/logistics procurement
  500011: "minmatar", // Angel Cartel civilian/logistics procurement
  500012: "amarr", // Blood Raiders civilian/logistics procurement
  500014: "gallente", // ORE industrial procurement
  500015: "minmatar", // Thukker Tribe
  500016: "gallente", // Sisters of EVE
  500018: "caldari", // Mordu's Legion
  500019: "amarr", // Sansha civilian/logistics procurement
  500020: "gallente", // Serpentis civilian/logistics procurement
});

function recoveryPolicy({ pirate = false, police = false, band = "standard" } = {}) {
  if (police) {
    return {
      procurementPolicy: "corporation_issued",
      recoverabilityPolicyID: "regional_state_service_nonrecoverable",
      fittedModuleDropChance: 0,
      fittedModuleDropChances: { techOne: 0, techTwo: 0, specialGrade: 0 },
      cargoSurvivalChance: 0.25,
      bonusLootTableID: null,
    };
  }
  const pirateDrop = band === "standard" ? 0.35 : band === "veteran" ? 0.4 : 0.35;
  return {
    procurementPolicy: "corporation_issued",
    recoverabilityPolicyID: pirate ? `regional_${band}_pirate` : "regional_corporate_default",
    fittedModuleDropChance: 0,
    fittedModuleDropChances: {
      techOne: pirate ? pirateDrop : 0.25,
      techTwo: pirate && band !== "standard" ? 0.08 : 0.03,
      specialGrade: 0,
    },
    cargoSurvivalChance: pirate ? 0.45 : 0.5,
    bonusLootTableID: pirate ? `phase3_highsec_pirate_${band === "standard" ? "common" : band}` : null,
  };
}

function tankModules(tankStyle, size, hardened = false) {
  if (tankStyle === "armor") {
    const repairer = size === "large" ? 3538 : size === "medium" ? 3528 : 523;
    return [
      { typeID: repairer, quantity: 1 },
      ...(hardened && size !== "small" ? [{ typeID: 11267, quantity: 1 }] : []),
    ];
  }
  const extender = size === "large" ? 3839 : size === "medium" ? 3829 : 377;
  const booster = size === "large" ? 10838 : size === "medium" ? 10836 : 399;
  return [
    { typeID: extender, quantity: 1 },
    ...(hardened && size !== "small" ? [{ typeID: booster, quantity: 1 }] : []),
  ];
}

function combatSkills(empire, shipClass, size, weaponEmpire = empire, additionalEmpires = []) {
  const racialSkillKey = shipClass === "battleship"
    ? "battleship"
    : shipClass === "battlecruiser"
      ? "battlecruiser"
      : shipClass === "medium"
        ? "cruiser"
        : "frigate";
  const level = shipClass === "small" ? 4 : 5;
  const weaponBaseSkill = weaponEmpire.key === "caldari" ? 3319 : 3300;
  const racialEmpires = [empire, ...additionalEmpires].filter((entry, index, rows) => (
    entry && rows.findIndex((candidate) => candidate.key === entry.key) === index
  ));
  return [
    { typeID: 3327, level: 5, name: "Spaceship Command" },
    ...racialEmpires.map((racialEmpire) => ({
      typeID: racialEmpire.racialSkills[racialSkillKey],
      level,
      name: `${racialEmpire.factionName} ${racialSkillKey}`,
    })),
    { typeID: weaponBaseSkill, level, name: weaponEmpire.key === "caldari" ? "Missile Launcher Operation" : "Gunnery" },
    { typeID: weaponEmpire.weaponSkills[size], level, name: `${weaponEmpire.key} weapon specialization` },
    { typeID: 3449, level: 4, name: "Navigation" },
    ...(racialEmpires.some((entry) => entry.key === "gallente") ? [
      { typeID: 3436, level: 5, name: "Drones" },
      { typeID: 3442, level: 4, name: "Drone Interfacing" },
    ] : []),
  ];
}

function makeCombatDoctrine({
  doctrineID,
  meta,
  empire,
  role,
  band,
  shipTypeID,
  shipClass,
  support = false,
  combatPower = 1,
  pirate = false,
  utilityModule = 0,
}) {
  const size = shipClass === "battleship" ? "large" : shipClass === "battlecruiser" || shipClass === "medium" ? "medium" : "small";
  const caldariHybridHulls = new Set([603, 16238, 623, 16227, 24688]);
  const weaponEmpire = empire.key === "caldari" && caldariHybridHulls.has(Number(shipTypeID))
    ? EMPIRE_DEFINITIONS.gallente
    : empire;
  const hardpointLimitedCount = new Map([
    [16231, 2], // Cyclone
    [17920, 4], // Bhaalgorn
    [17736, 4], // Nightmare
  ]).get(Number(shipTypeID)) || 0;
  const weaponCount = support
    ? 1
    : size === "large"
      ? 5
      : shipClass === "battlecruiser"
        ? 4
        : size === "medium"
          ? 3
          : shipClass === "destroyer"
            ? 4
            : 2;
  const fittedWeaponCount = hardpointLimitedCount > 0
    ? Math.min(weaponCount, hardpointLimitedCount)
    : weaponCount;
  const tankStyle = meta.tankStyle || empire.tankStyle;
  const fittedUtilityModule = meta.key === "blood" && size === "small" ? 533 : utilityModule;
  const omitPropulsion = fittedUtilityModule > 0 && tankStyle === "shield";
  const modules = [
    { typeID: weaponEmpire.weapons[size], quantity: fittedWeaponCount },
    ...(!omitPropulsion ? [{ typeID: size === "large" ? 12066 : size === "medium" ? 12056 : 439, quantity: 1 }] : []),
    ...tankModules(tankStyle, size, band !== "standard"),
    ...(!support ? [{ typeID: weaponEmpire.damageModule, quantity: 1 }] : []),
  ];
  if (support) modules.push({ typeID: empire.supportModule === 3596 ? 3586 : 11355, quantity: 1 });
  if (fittedUtilityModule > 0) modules.push({ typeID: fittedUtilityModule, quantity: 1 });
  const droneEnabled = empire.key === "gallente" || Number(meta.droneTypeID) > 0;
  const droneQuantity = droneEnabled ? (size === "large" ? 5 : size === "medium" ? 4 : 2) : 0;
  const additionalSkillEmpires = Array.isArray(meta.skillRaceKeys)
    ? meta.skillRaceKeys
        .map((key) => EMPIRE_DEFINITIONS[key])
        .filter((entry) => entry && entry.key !== empire.key)
    : [];
  return Object.freeze({
    doctrineRevision: DOCTRINE_REVISION,
    doctrineID,
    role,
    equipmentBand: band,
    shipTypeID,
    modules: Object.freeze(modules),
    charges: Object.freeze([{ typeID: weaponEmpire.charges[size], quantityPerModule: size === "large" ? 120 : 100 }]),
    droneBay: Object.freeze(droneQuantity > 0 ? [{
      typeID: Number(meta.droneTypeID) || 2454,
      quantity: droneQuantity,
      name: Number(meta.droneTypeID) === 2464 ? "Hornet I" : "Hobgoblin I",
    }] : []),
    pilotSkills: Object.freeze(combatSkills(
      empire,
      shipClass === "destroyer" ? "small" : shipClass,
      size,
      weaponEmpire,
      additionalSkillEmpires,
    )),
    survivabilityProfile: Object.freeze({
      profileID: `${meta.key}_${band}_${role}_v1`,
      virtualLossWeight: Math.max(0.2, 1.25 - (combatPower * 0.14)),
      casualtyChanceMultiplier: Math.max(0.4, 1.1 - (combatPower * 0.08)),
      combatPower,
    }),
    recoveryPolicy: Object.freeze(recoveryPolicy({ pirate, police: role === "police", band })),
    factionKey: meta.key,
    raceID: empire.raceID,
    factionID: meta.factionID,
    factionName: meta.factionName,
    corporationID: meta.corporationID,
    corporationName: meta.corporationName,
    shipNameTemplate: `${meta.corporationName} ${pirate ? "Raider" : role === "police" ? "Patrol" : "Escort"}`,
    bounty: pirate ? Math.round(45_000 * Math.max(1, combatPower)) : 0,
    securityStatus: pirate ? -Math.min(10, Math.max(2, combatPower + 1)) : 0,
  });
}

const LOGISTICS_PROFILES = Object.freeze({
  haulerCivilian: Object.freeze({ logisticsClass: "feeder", capacityM3: 4_500, shipmentMultiplier: 1, maximumCargoValueISK: 25_000_000, lowSecurityAccess: false }),
  haulerStandard: Object.freeze({ logisticsClass: "regional", capacityM3: 12_000, shipmentMultiplier: 3, maximumCargoValueISK: 100_000_000, lowSecurityAccess: false }),
  haulerBulk: Object.freeze({ logisticsClass: "bulk", capacityM3: 24_000, shipmentMultiplier: 8, maximumCargoValueISK: 250_000_000, lowSecurityAccess: false }),
  haulerSecure: Object.freeze({ logisticsClass: "secure", capacityM3: 18_000, shipmentMultiplier: 4, maximumCargoValueISK: 500_000_000, lowSecurityAccess: true }),
  convoySecure: Object.freeze({ logisticsClass: "secure", capacityM3: 60_000, shipmentMultiplier: 4, maximumCargoValueISK: 1_000_000_000, lowSecurityAccess: true }),
  haulerTrunk: Object.freeze({ logisticsClass: "trunk", capacityM3: 650_000, shipmentMultiplier: 50, maximumCargoValueISK: 2_500_000_000, lowSecurityAccess: false }),
});

function makeHaulerDoctrine(empire, groupKey, shipTypeID, variant = "") {
  const index = [GROUP_KEYS.haulerCivilian, GROUP_KEYS.haulerStandard, GROUP_KEYS.haulerBulk, GROUP_KEYS.haulerSecure, GROUP_KEYS.haulerTrunk].indexOf(groupKey);
  const band = index <= 0 ? "civilian" : index === 1 ? "standard" : "elite";
  const modules = index <= 0
    ? [{ typeID: 1317, quantity: 1 }]
    : index === 1
      ? [{ typeID: 1317, quantity: 3 }]
      : index === 2 || index === 4
        ? [{ typeID: 1319, quantity: index === 4 ? 3 : 4 }]
        : empire.tankStyle === "armor"
          ? [
              { typeID: 1319, quantity: 2 },
              { typeID: 3528, quantity: 1 },
              { typeID: 11267, quantity: 1 },
              { typeID: 2046, quantity: 1 },
            ]
          : [
              { typeID: 1319, quantity: 2 },
              { typeID: 3829, quantity: 2 },
              { typeID: 578, quantity: 1 },
              { typeID: 2046, quantity: 1 },
            ];
  return Object.freeze({
    doctrineRevision: DOCTRINE_REVISION,
    doctrineID: `regional_${empire.key}_${groupKey.toLowerCase()}${variant ? `_${variant}` : ""}_v1`,
    role: "hauler",
    equipmentBand: band,
    shipTypeID,
    modules: Object.freeze(modules),
    charges: Object.freeze([]),
    droneBay: Object.freeze([]),
    pilotSkills: Object.freeze([
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: empire.racialSkills.hauler, level: groupKey === GROUP_KEYS.haulerSecure ? 5 : 4, name: `${empire.factionName} Hauler` },
      { typeID: 3449, level: 5, name: "Navigation" },
      { typeID: 3453, level: 4, name: "Evasive Maneuvering" },
      ...(groupKey === GROUP_KEYS.haulerSecure ? [{ typeID: 19719, level: 5, name: "Transport Ships" }] : []),
    ]),
    logisticsProfile: variant === "convoy"
      ? LOGISTICS_PROFILES.convoySecure
      : LOGISTICS_PROFILES[groupKey],
    survivabilityProfile: groupKey === GROUP_KEYS.haulerSecure ? Object.freeze({
      profileID: `${empire.key}_frontier_transport_v1`,
      virtualLossWeight: 0.25,
      casualtyChanceMultiplier: 0.55,
      combatPower: 1.2,
    }) : null,
    recoveryPolicy: Object.freeze(recoveryPolicy({ band })),
    factionKey: empire.key,
    raceID: empire.raceID,
    factionID: empire.factionID,
    factionName: empire.factionName,
    corporationID: empire.corporationID,
    corporationName: empire.corporationName,
    shipNameTemplate: `${empire.factionName} Freight Vessel`,
    bounty: 0,
  });
}

function makeShuttleDoctrine(empire) {
  return Object.freeze({
    doctrineRevision: DOCTRINE_REVISION,
    doctrineID: `regional_${empire.key}_shuttle_v1`,
    role: "shuttle",
    equipmentBand: "civilian",
    shipTypeID: empire.shuttle,
    modules: Object.freeze([]),
    charges: Object.freeze([]),
    droneBay: Object.freeze([]),
    pilotSkills: Object.freeze([]),
    recoveryPolicy: Object.freeze(recoveryPolicy({ band: "civilian" })),
    factionKey: empire.key,
    raceID: empire.raceID,
    factionID: empire.factionID,
    factionName: empire.factionName,
    corporationID: empire.corporationID,
    corporationName: empire.corporationName,
    shipNameTemplate: `${empire.factionName} Shuttle`,
    bounty: 0,
  });
}

const doctrines = [];
const spawnGroups = [];
const empireGroupIDs = {};
const pirateGroupIDs = {};

function registerGroup(scope, key, groupKey, name, groupDoctrines) {
  const spawnGroupID = `living_regional_${scope}_${key}_${groupKey.toLowerCase()}`;
  const entries = [];
  for (const doctrine of groupDoctrines) {
    doctrines.push(doctrine);
    entries.push(Object.freeze({ doctrineID: doctrine.doctrineID, count: 1 }));
  }
  spawnGroups.push(Object.freeze({ spawnGroupID, name, entries: Object.freeze(entries) }));
  return spawnGroupID;
}

function empireCombatDoctrine(empire, groupKey, slot, role, band, shipClass, hullIndex, power, support = false) {
  const hulls = empire.hulls[shipClass === "destroyer" ? "small" : shipClass];
  const shipTypeID = shipClass === "destroyer" ? empire.hulls.small[2] : hulls[hullIndex % hulls.length];
  return makeCombatDoctrine({
    doctrineID: `regional_${empire.key}_${groupKey.toLowerCase()}_${slot}_v1`,
    meta: empire,
    empire,
    role,
    band,
    shipTypeID,
    shipClass,
    support,
    combatPower: power,
  });
}

for (const empire of Object.values(EMPIRE_DEFINITIONS)) {
  const groups = {};
  groups[GROUP_KEYS.shuttle] = registerGroup("empire", empire.key, GROUP_KEYS.shuttle, `${empire.factionName} Shuttle`, [makeShuttleDoctrine(empire)]);
  const haulerKeys = [GROUP_KEYS.haulerCivilian, GROUP_KEYS.haulerStandard, GROUP_KEYS.haulerBulk, GROUP_KEYS.haulerSecure, GROUP_KEYS.haulerTrunk];
  haulerKeys.forEach((groupKey, index) => {
    groups[groupKey] = registerGroup("empire", empire.key, groupKey, `${empire.factionName} ${groupKey}`, [makeHaulerDoctrine(empire, groupKey, empire.haulers[index])]);
  });
  groups[GROUP_KEYS.convoySecure] = registerGroup("empire", empire.key, GROUP_KEYS.convoySecure, `${empire.factionName} Frontier Convoy`, [
    makeHaulerDoctrine(empire, GROUP_KEYS.haulerSecure, empire.haulers[3], "convoy"),
    empireCombatDoctrine(empire, GROUP_KEYS.convoySecure, "escort_a", "escort", "elite", "medium", 0, 2.4),
    empireCombatDoctrine(empire, GROUP_KEYS.convoySecure, "escort_b", "escort", "elite", "medium", 1, 2.6),
  ]);
  groups[GROUP_KEYS.policeStandard] = registerGroup("empire", empire.key, GROUP_KEYS.policeStandard, `${empire.factionName} Standard Patrol`, [
    empireCombatDoctrine(empire, GROUP_KEYS.policeStandard, "a", "police", "standard", "medium", 0, 2.4),
    empireCombatDoctrine(empire, GROUP_KEYS.policeStandard, "b", "police", "standard", "medium", 1, 2.6),
    empireCombatDoctrine(empire, GROUP_KEYS.policeStandard, "support", "police", "standard", "medium", 2, 2.1, true),
  ]);
  groups[GROUP_KEYS.policeElite] = registerGroup("empire", empire.key, GROUP_KEYS.policeElite, `${empire.factionName} Veteran Patrol`, [
    empireCombatDoctrine(empire, GROUP_KEYS.policeElite, "a", "police", "elite", "battlecruiser", 0, 4.6),
    empireCombatDoctrine(empire, GROUP_KEYS.policeElite, "b", "police", "elite", "medium", 0, 3.0),
    empireCombatDoctrine(empire, GROUP_KEYS.policeElite, "c", "police", "elite", "medium", 1, 3.1),
  ]);
  groups[GROUP_KEYS.policeCommand] = registerGroup("empire", empire.key, GROUP_KEYS.policeCommand, `${empire.factionName} Command Patrol`, [
    empireCombatDoctrine(empire, GROUP_KEYS.policeCommand, "command", "police", "elite", "battleship", 0, 7.8),
    empireCombatDoctrine(empire, GROUP_KEYS.policeCommand, "guard", "police", "elite", "battlecruiser", 1, 4.8),
    empireCombatDoctrine(empire, GROUP_KEYS.policeCommand, "support", "police", "elite", "medium", 2, 2.8, true),
  ]);
  empireGroupIDs[empire.key] = Object.freeze(groups);
}

const PIRATE_TIER_SPECS = Object.freeze({
  pirateStandard: Object.freeze({ band: "standard", rows: Object.freeze([
    ["small", 0.8], ["small", 0.9], ["small", 1.1], ["small", 1.1],
  ]) }),
  pirateVeteran: Object.freeze({ band: "veteran", rows: Object.freeze([
    ["medium", 2.0], ["medium", 2.2], ["medium", 2.4], ["medium", 2.4],
  ]) }),
  pirateElite: Object.freeze({ band: "elite", rows: Object.freeze([
    ["medium", 4.0], ["medium", 3.8], ["medium", 3.6], ["medium", 3.4],
  ]) }),
  pirateCommand: Object.freeze({ band: "elite", rows: Object.freeze([
    ["battleship", 7.0], ["medium", 4.2], ["medium", 3.0], ["medium", 3.0],
  ]) }),
});

for (const pirate of Object.values(PIRATE_DEFINITIONS)) {
  const empire = EMPIRE_DEFINITIONS[pirate.raceKey];
  const groups = {};
  for (const [groupKey, tier] of Object.entries(PIRATE_TIER_SPECS)) {
    const groupDoctrines = tier.rows.map(([shipClass, power], index) => {
      const shipTypeID = pirate.hulls[shipClass];
      return makeCombatDoctrine({
        doctrineID: `regional_${pirate.key}_${groupKey.toLowerCase()}_${index + 1}_v1`,
        meta: pirate,
        empire,
        role: "highsec_pirate",
        band: tier.band,
        shipTypeID,
        shipClass,
        support: index === tier.rows.length - 1 && groupKey !== GROUP_KEYS.pirateStandard,
        combatPower: power,
        pirate: true,
        utilityModule: pirate.utilityModule,
      });
    });
    groups[groupKey] = registerGroup("pirate", pirate.key, groupKey, `${pirate.factionName} ${groupKey}`, groupDoctrines);
  }
  pirateGroupIDs[pirate.key] = Object.freeze(groups);
}

function getEmpireKeyForRaceID(raceID) {
  const numeric = Number(raceID);
  const empire = Object.values(EMPIRE_DEFINITIONS).find((entry) => entry.raceID === numeric);
  return empire ? empire.key : "caldari";
}

function getEmpireKeyForAffiliation(factionID, raceID) {
  return EMPIRE_KEY_BY_FACTION_ID[Number(factionID)] || getEmpireKeyForRaceID(raceID);
}

function getEmpireGroupID(raceID, groupKey, factionID = 0) {
  const empireKey = getEmpireKeyForAffiliation(factionID, raceID);
  return empireGroupIDs[empireKey] && empireGroupIDs[empireKey][groupKey] || null;
}

function getPirateGroupID(factionKey, groupKey) {
  const normalized = String(factionKey || "").trim().toLowerCase();
  return pirateGroupIDs[normalized] && pirateGroupIDs[normalized][groupKey] || null;
}

module.exports = {
  DOCTRINE_REVISION,
  EMPIRE_DEFINITIONS,
  GROUP_KEYS,
  PIRATE_DEFINITIONS,
  REGIONAL_SPAWN_GROUP_DEFINITIONS: Object.freeze(spawnGroups),
  REGIONAL_TRAFFIC_DOCTRINES: Object.freeze(doctrines),
  getEmpireGroupID,
  getEmpireKeyForAffiliation,
  getEmpireKeyForRaceID,
  getPirateGroupID,
};
