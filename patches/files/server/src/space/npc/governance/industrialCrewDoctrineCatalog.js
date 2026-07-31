"use strict";

const path = require("path");

const {
  resolveItemByTypeID,
} = require(path.join(__dirname, "../../../services/inventory/itemTypeRegistry"));
const {
  collectRequiredSkillClosure,
} = require("./npcDoctrineGovernance");

const INDUSTRIAL_CREW_DOCTRINE_REVISION = 1;
const INDUSTRIAL_CREW_VALIDATION_PROFILE = "industrial_crew_strict_v1";

const PROFILE_IDS = Object.freeze({
  VENTURE: "industrial_crew_venture",
  RETRIEVER: "industrial_crew_retriever",
  SKIFF: "industrial_crew_skiff",
  HULK: "industrial_crew_hulk",
  PORPOISE: "industrial_crew_porpoise",
  ORCA: "industrial_crew_orca",
  MIASMOS: "industrial_crew_miasmos",
  BUSTARD: "industrial_crew_bustard",
  RORQUAL: "industrial_crew_rorqual",
});

const LOADOUT_IDS = Object.freeze(
  Object.fromEntries(
    Object.entries(PROFILE_IDS).map(([key, profileID]) => [
      key,
      `${profileID}_v1`,
    ]),
  ),
);

const TYPE = Object.freeze({
  VENTURE: 32880,
  RETRIEVER: 17478,
  SKIFF: 22546,
  HULK: 22544,
  PORPOISE: 42244,
  ORCA: 28606,
  MIASMOS: 656,
  BUSTARD: 12731,
  RORQUAL: 28352,

  MINER_II: 482,
  STRIP_MINER_I: 17482,
  MODULATED_STRIP_MINER_II: 17912,
  SIMPLE_ASTEROID_CRYSTAL_A_II: 60281,
  MINING_LASER_UPGRADE_II: 28576,
  MINING_FOREMAN_BURST_II: 43551,
  MINING_FIELD_ENHANCEMENT_CHARGE: 42829,
  MINING_LASER_OPTIMIZATION_CHARGE: 42830,
  MINING_EQUIPMENT_PRESERVATION_CHARGE: 42831,
  SMALL_TRACTOR_BEAM_I: 24348,
  DRONE_LINK_AUGMENTOR_II: 24427,
  MEDIUM_REMOTE_SHIELD_BOOSTER_II: 3598,
  LARGE_REMOTE_SHIELD_BOOSTER_II: 3608,
  CAPITAL_REMOTE_SHIELD_BOOSTER_I: 3616,
  CAPITAL_TRACTOR_BEAM_I: 24644,

  ONE_MN_AFTERBURNER_II: 438,
  TEN_MN_AFTERBURNER_II: 12058,
  ONE_HUNDRED_MN_AFTERBURNER_II: 12068,
  SMALL_SHIELD_EXTENDER_II: 380,
  MEDIUM_SHIELD_EXTENDER_II: 3831,
  MEDIUM_COMPACT_SHIELD_EXTENDER: 8517,
  LARGE_SHIELD_EXTENDER_II: 3841,
  MULTISPECTRUM_SHIELD_HARDENER_II: 2281,
  COMPACT_MULTISPECTRUM_SHIELD_HARDENER: 9632,
  EM_SHIELD_HARDENER_I: 2293,
  THERMAL_SHIELD_HARDENER_I: 2295,
  EM_SHIELD_HARDENER_II: 2301,
  EXPLOSIVE_SHIELD_HARDENER_II: 2297,
  KINETIC_SHIELD_HARDENER_II: 2299,
  THERMAL_SHIELD_HARDENER_II: 2303,
  CAPITAL_SHIELD_BOOSTER_I: 20703,
  CAPITAL_CAP_BATTERY_I: 41484,
  SHIELD_BOOST_AMPLIFIER_II: 24443,

  DAMAGE_CONTROL_II: 2048,
  DRONE_DAMAGE_AMPLIFIER_II: 4405,
  EXPANDED_CARGOHOLD_II: 1319,
  INERTIAL_STABILIZERS_II: 1405,

  SMALL_CORE_DEFENSE_FIELD_EXTENDER_I: 31788,
  MEDIUM_CORE_DEFENSE_FIELD_EXTENDER_I: 31790,
  MEDIUM_PROCESSOR_OVERCLOCKING_UNIT_I: 4395,
  LARGE_CORE_DEFENSE_FIELD_EXTENDER_I: 26088,
  CAPITAL_CORE_DEFENSE_FIELD_EXTENDER_I: 31792,
  MEDIUM_CARGOHOLD_OPTIMIZATION_I: 31119,
  CAPITAL_CAPACITOR_CONTROL_CIRCUIT_I: 31374,

  ACOLYTE_II: 2205,
  HOBGOBLIN_II: 2456,
  HORNET_II: 2466,
  WARRIOR_II: 2488,
  HAMMERHEAD_II: 2185,
  INFILTRATOR_II: 2175,
  VESPA_II: 21638,
  VALKYRIE_II: 21640,
  PRAETOR_II: 2195,
  OGRE_II: 2446,
  WASP_II: 2436,
  BERSERKER_II: 2478,

  SPACESHIP_COMMAND: 3327,
  CPU_MANAGEMENT: 3426,
  POWER_GRID_MANAGEMENT: 3413,
  CAPACITOR_MANAGEMENT: 3418,
  CAPACITOR_SYSTEMS_OPERATION: 3417,
  SHIELD_OPERATION: 3416,
  SHIELD_MANAGEMENT: 3419,
  TACTICAL_SHIELD_MANIPULATION: 3420,
  NAVIGATION: 3449,
  EVASIVE_MANEUVERING: 3453,
  DRONES: 3436,
  DRONE_INTERFACING: 3442,
  DRONE_DURABILITY: 23618,
  DRONE_NAVIGATION: 12305,
  LIGHT_DRONE_OPERATION: 24241,
  MEDIUM_DRONE_OPERATION: 33699,
  HEAVY_DRONE_OPERATION: 3441,
  MINING_FOREMAN: 22536,
  MINING_DIRECTOR: 22552,
});

const COMMON_PILOT_SKILLS = Object.freeze([
  { typeID: TYPE.SPACESHIP_COMMAND, level: 5 },
  { typeID: TYPE.CPU_MANAGEMENT, level: 5 },
  { typeID: TYPE.POWER_GRID_MANAGEMENT, level: 5 },
  { typeID: TYPE.CAPACITOR_MANAGEMENT, level: 5 },
  { typeID: TYPE.CAPACITOR_SYSTEMS_OPERATION, level: 5 },
  { typeID: TYPE.SHIELD_OPERATION, level: 5 },
  { typeID: TYPE.SHIELD_MANAGEMENT, level: 5 },
  { typeID: TYPE.TACTICAL_SHIELD_MANIPULATION, level: 4 },
  { typeID: TYPE.NAVIGATION, level: 5 },
  { typeID: TYPE.EVASIVE_MANEUVERING, level: 5 },
]);

const DEFENSE_DRONE_PILOT_SKILLS = Object.freeze([
  { typeID: TYPE.DRONES, level: 5 },
  { typeID: TYPE.DRONE_INTERFACING, level: 4 },
  { typeID: TYPE.DRONE_DURABILITY, level: 4 },
  { typeID: TYPE.DRONE_NAVIGATION, level: 4 },
  { typeID: TYPE.LIGHT_DRONE_OPERATION, level: 5 },
  { typeID: TYPE.MEDIUM_DRONE_OPERATION, level: 5 },
  { typeID: TYPE.HEAVY_DRONE_OPERATION, level: 5 },
]);

const PILOT_SKILL_FALLBACK_NAMES = Object.freeze({
  [TYPE.SPACESHIP_COMMAND]: "Spaceship Command",
  [TYPE.CPU_MANAGEMENT]: "CPU Management",
  [TYPE.POWER_GRID_MANAGEMENT]: "Power Grid Management",
  [TYPE.CAPACITOR_MANAGEMENT]: "Capacitor Management",
  [TYPE.CAPACITOR_SYSTEMS_OPERATION]: "Capacitor Systems Operation",
  [TYPE.SHIELD_OPERATION]: "Shield Operation",
  [TYPE.SHIELD_MANAGEMENT]: "Shield Management",
  [TYPE.TACTICAL_SHIELD_MANIPULATION]: "Tactical Shield Manipulation",
  [TYPE.NAVIGATION]: "Navigation",
  [TYPE.EVASIVE_MANEUVERING]: "Evasive Maneuvering",
  [TYPE.DRONES]: "Drones",
  [TYPE.DRONE_INTERFACING]: "Drone Interfacing",
  [TYPE.DRONE_DURABILITY]: "Drone Durability",
  [TYPE.DRONE_NAVIGATION]: "Drone Navigation",
  [TYPE.LIGHT_DRONE_OPERATION]: "Light Drone Operation",
  [TYPE.MEDIUM_DRONE_OPERATION]: "Medium Drone Operation",
  [TYPE.HEAVY_DRONE_OPERATION]: "Heavy Drone Operation",
  [TYPE.MINING_FOREMAN]: "Mining Foreman",
  [TYPE.MINING_DIRECTOR]: "Mining Director",
});

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildPilotSkills(typeIDs, options = {}) {
  const levelFloor = Math.max(
    1,
    Math.min(5, Math.trunc(Number(options.levelFloor) || 4)),
  );
  const levels = collectRequiredSkillClosure(typeIDs);
  const extras = [
    ...COMMON_PILOT_SKILLS,
    ...(options.withDefenseDrones === true ? DEFENSE_DRONE_PILOT_SKILLS : []),
    ...(Array.isArray(options.extraSkills) ? options.extraSkills : []),
  ];
  for (const extra of extras) {
    const typeID = Math.trunc(Number(extra && extra.typeID) || 0);
    const level = Math.max(1, Math.min(5, Math.trunc(Number(extra && extra.level) || 0)));
    if (typeID > 0) {
      levels.set(typeID, Math.max(level, levels.get(typeID) || 0));
    }
  }
  for (const [typeID, level] of levels.entries()) {
    levels.set(typeID, Math.max(level, levelFloor));
  }
  return [...levels.entries()]
    .map(([typeID, level]) => {
      const itemType = resolveItemByTypeID(typeID);
      return {
        typeID,
        level,
        name: String(
          itemType && itemType.name ||
          PILOT_SKILL_FALLBACK_NAMES[typeID] ||
          `Skill ${typeID}`,
        ),
      };
    })
    .sort((left, right) => left.typeID - right.typeID);
}

function defenseDrone(typeID, quantity) {
  const itemType = resolveItemByTypeID(typeID);
  return Object.freeze({
    typeID,
    quantity,
    name: String(itemType && itemType.name || `Drone ${typeID}`),
    role: "defense",
  });
}

function defenseFlight(
  flightID,
  droneTypeID,
  launchCount,
  priority,
  targetSizeClasses,
) {
  return Object.freeze({
    flightID,
    droneTypeID,
    launchCount,
    priority,
    targetSizeClasses: Object.freeze([...targetSizeClasses]),
  });
}

const DEFENSE_DRONE_TYPES_BY_DAMAGE = Object.freeze({
  em: Object.freeze({
    light: TYPE.ACOLYTE_II,
    medium: TYPE.INFILTRATOR_II,
    heavy: TYPE.PRAETOR_II,
  }),
  thermal: Object.freeze({
    light: TYPE.HOBGOBLIN_II,
    medium: TYPE.HAMMERHEAD_II,
    heavy: TYPE.OGRE_II,
  }),
  kinetic: Object.freeze({
    light: TYPE.HORNET_II,
    medium: TYPE.VESPA_II,
    heavy: TYPE.WASP_II,
  }),
  explosive: Object.freeze({
    light: TYPE.WARRIOR_II,
    medium: TYPE.VALKYRIE_II,
    heavy: TYPE.BERSERKER_II,
  }),
});

const DEFENSE_DAMAGE_PROFILE_ALIASES = Object.freeze({
  blood: "em",
  blood_raider: "em",
  sansha: "em",
  sanshas: "em",
  serpentis: "thermal",
  guristas: "kinetic",
  angel: "explosive",
  angels: "explosive",
  angel_cartel: "explosive",
});

function normalizeDefenseDamageProfile(value) {
  const normalized = String(value || "kinetic")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return DEFENSE_DAMAGE_PROFILE_ALIASES[normalized] ||
    (DEFENSE_DRONE_TYPES_BY_DAMAGE[normalized] ? normalized : "kinetic");
}

function buildRegionalDefenseVariants(plan = {}) {
  const lightBayCount = Math.max(0, Math.trunc(Number(plan.lightBayCount) || 0));
  const mediumBayCount = Math.max(0, Math.trunc(Number(plan.mediumBayCount) || 0));
  const heavyBayCount = Math.max(0, Math.trunc(Number(plan.heavyBayCount) || 0));
  return Object.entries(DEFENSE_DRONE_TYPES_BY_DAMAGE).map(([damageProfile, types]) => {
    const droneBay = [];
    const defenseFlights = [];
    if (lightBayCount > 0) {
      droneBay.push(defenseDrone(types.light, lightBayCount));
      defenseFlights.push(defenseFlight(
        `${damageProfile}_light_defense`,
        types.light,
        Math.min(5, lightBayCount),
        10,
        ["frigate", "destroyer"],
      ));
    }
    if (mediumBayCount > 0) {
      droneBay.push(defenseDrone(types.medium, mediumBayCount));
      defenseFlights.push(defenseFlight(
        `${damageProfile}_medium_defense`,
        types.medium,
        Math.min(5, mediumBayCount),
        20,
        ["cruiser", "battlecruiser"],
      ));
    }
    if (heavyBayCount > 0) {
      droneBay.push(defenseDrone(types.heavy, heavyBayCount));
      defenseFlights.push(defenseFlight(
        `${damageProfile}_heavy_defense`,
        types.heavy,
        Math.min(5, heavyBayCount),
        30,
        ["battleship", "capital"],
      ));
    }
    return Object.freeze({
      damageProfile,
      droneBay: Object.freeze(droneBay),
      defenseFlights: Object.freeze(defenseFlights),
    });
  });
}

function resolveIndustrialCrewRegionalDefense(source, damageProfile = "kinetic") {
  const normalizedDamageProfile = normalizeDefenseDamageProfile(damageProfile);
  const variants = Array.isArray(source && source.regionalDefenseVariants)
    ? source.regionalDefenseVariants
    : [];
  const selected = variants.find(
    (variant) => String(variant && variant.damageProfile || "") === normalizedDamageProfile,
  ) || variants.find(
    (variant) => String(variant && variant.damageProfile || "") === "kinetic",
  ) || null;
  if (!selected) {
    return {
      damageProfile: normalizedDamageProfile,
      droneBay: cloneValue(Array.isArray(source && source.droneBay) ? source.droneBay : []),
      defenseFlights: cloneValue(
        Array.isArray(source && source.defenseFlights) ? source.defenseFlights : [],
      ),
    };
  }
  return cloneValue(selected);
}

function recoveryPolicy() {
  return {
    fittedModuleDropChance: 0,
    fittedModuleDropChances: {
      techOne: 0,
      techTwo: 0,
      specialGrade: 0,
    },
    cargoSurvivalChance: 0,
  };
}

function makeDoctrine(spec) {
  const modules = Array.isArray(spec.modules) ? spec.modules : [];
  const charges = Array.isArray(spec.charges) ? spec.charges : [];
  const regionalDefenseVariants = spec.regionalDefensePlan
    ? buildRegionalDefenseVariants(spec.regionalDefensePlan)
    : [];
  const defaultRegionalDefense = regionalDefenseVariants.find(
    (variant) => variant.damageProfile === "kinetic",
  ) || null;
  const droneBay = defaultRegionalDefense
    ? defaultRegionalDefense.droneBay
    : (Array.isArray(spec.droneBay) ? spec.droneBay : []);
  const defenseFlights = defaultRegionalDefense
    ? defaultRegionalDefense.defenseFlights
    : (Array.isArray(spec.defenseFlights) ? spec.defenseFlights : []);
  const regionalDroneTypeIDs = regionalDefenseVariants.flatMap(
    (variant) => variant.droneBay.map((entry) => entry.typeID),
  );
  const pilotSkillTypeIDs = [
    spec.shipTypeID,
    ...modules.map((entry) => entry.typeID),
    ...charges.map((entry) => entry.typeID),
    ...droneBay.map((entry) => entry.typeID),
    ...regionalDroneTypeIDs,
  ];
  return Object.freeze({
    doctrineID: spec.doctrineID,
    loadoutID: spec.loadoutID,
    name: spec.name,
    role: spec.role,
    equipmentBand: spec.equipmentBand,
    shipTypeID: spec.shipTypeID,
    modules: Object.freeze(modules.map((entry) => Object.freeze({ ...entry }))),
    charges: Object.freeze(charges.map((entry) => Object.freeze({ ...entry }))),
    droneBay: Object.freeze(droneBay.map((entry) => Object.freeze({ ...entry }))),
    defenseFlights: Object.freeze(
      defenseFlights.map((entry) => Object.freeze({ ...entry })),
    ),
    regionalDefenseVariants: Object.freeze(regionalDefenseVariants),
    pilotSkills: Object.freeze(
      buildPilotSkills(pilotSkillTypeIDs, {
        levelFloor: spec.pilotLevelFloor,
        withDefenseDrones: defenseFlights.length > 0,
        extraSkills: spec.extraSkills,
      }).map((entry) => Object.freeze(entry)),
    ),
    miningProfile: spec.miningProfile ? Object.freeze({ ...spec.miningProfile }) : null,
    miningSupportProfile: spec.miningSupportProfile
      ? Object.freeze({ ...spec.miningSupportProfile })
      : null,
    logisticsProfile: spec.logisticsProfile
      ? Object.freeze({ ...spec.logisticsProfile })
      : null,
    provisional: spec.provisional === true,
  });
}

const INDUSTRIAL_CREW_DOCTRINES = Object.freeze([
  makeDoctrine({
    doctrineID: "industrial_crew_venture_defensive_v1",
    loadoutID: LOADOUT_IDS.VENTURE,
    name: "Industrial Crew Venture Defensive Fit",
    role: "miner",
    equipmentBand: "elite",
    shipTypeID: TYPE.VENTURE,
    pilotLevelFloor: 4,
    modules: [
      { typeID: TYPE.MINER_II, flagIDs: [27, 28] },
      { typeID: TYPE.ONE_MN_AFTERBURNER_II, quantity: 1 },
      { typeID: TYPE.MEDIUM_COMPACT_SHIELD_EXTENDER, quantity: 1 },
      { typeID: TYPE.COMPACT_MULTISPECTRUM_SHIELD_HARDENER, quantity: 1 },
      { typeID: TYPE.DAMAGE_CONTROL_II, quantity: 1 },
      { typeID: TYPE.SMALL_CORE_DEFENSE_FIELD_EXTENDER_I, quantity: 3 },
    ],
    regionalDefensePlan: {
      lightBayCount: 2,
    },
    droneBay: [
      defenseDrone(TYPE.HORNET_II, 2),
    ],
    defenseFlights: [
      defenseFlight("venture_light_kinetic", TYPE.HORNET_II, 2, 10, [
        "frigate",
        "destroyer",
      ]),
    ],
    miningProfile: {
      resourceFamily: "ore",
      operatingBand: "entry",
    },
  }),
  makeDoctrine({
    doctrineID: "industrial_crew_retriever_defensive_v1",
    loadoutID: LOADOUT_IDS.RETRIEVER,
    name: "Industrial Crew Retriever Defensive Fit",
    role: "miner",
    equipmentBand: "elite",
    shipTypeID: TYPE.RETRIEVER,
    pilotLevelFloor: 5,
    modules: [
      { typeID: TYPE.STRIP_MINER_I, flagIDs: [27, 28] },
      { typeID: TYPE.MEDIUM_SHIELD_EXTENDER_II, quantity: 1 },
      { typeID: TYPE.MULTISPECTRUM_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.MINING_LASER_UPGRADE_II, quantity: 2 },
      { typeID: TYPE.DAMAGE_CONTROL_II, quantity: 1 },
      { typeID: TYPE.MEDIUM_PROCESSOR_OVERCLOCKING_UNIT_I, quantity: 1 },
      { typeID: TYPE.MEDIUM_CORE_DEFENSE_FIELD_EXTENDER_I, quantity: 2 },
    ],
    regionalDefensePlan: {
      lightBayCount: 10,
    },
    droneBay: [
      defenseDrone(TYPE.HORNET_II, 5),
      defenseDrone(TYPE.WARRIOR_II, 5),
    ],
    defenseFlights: [
      defenseFlight("retriever_light_kinetic", TYPE.HORNET_II, 5, 10, [
        "frigate",
        "destroyer",
      ]),
      defenseFlight("retriever_light_explosive", TYPE.WARRIOR_II, 5, 20, [
        "frigate",
        "destroyer",
      ]),
    ],
    miningProfile: {
      resourceFamily: "ore",
      operatingBand: "barge",
    },
  }),
  makeDoctrine({
    doctrineID: "industrial_crew_skiff_defensive_v1",
    loadoutID: LOADOUT_IDS.SKIFF,
    name: "Industrial Crew Skiff Defensive Fit",
    role: "miner",
    equipmentBand: "elite",
    shipTypeID: TYPE.SKIFF,
    pilotLevelFloor: 5,
    modules: [
      { typeID: TYPE.STRIP_MINER_I, flagIDs: [27, 28] },
      { typeID: TYPE.MEDIUM_COMPACT_SHIELD_EXTENDER, quantity: 2 },
      { typeID: TYPE.COMPACT_MULTISPECTRUM_SHIELD_HARDENER, quantity: 1 },
      { typeID: TYPE.EM_SHIELD_HARDENER_I, quantity: 1 },
      { typeID: TYPE.THERMAL_SHIELD_HARDENER_I, quantity: 1 },
      { typeID: TYPE.MINING_LASER_UPGRADE_II, quantity: 2 },
      { typeID: TYPE.DAMAGE_CONTROL_II, quantity: 1 },
      { typeID: TYPE.MEDIUM_PROCESSOR_OVERCLOCKING_UNIT_I, quantity: 1 },
      { typeID: TYPE.MEDIUM_CORE_DEFENSE_FIELD_EXTENDER_I, quantity: 1 },
    ],
    regionalDefensePlan: {
      lightBayCount: 10,
      mediumBayCount: 5,
    },
    droneBay: [
      defenseDrone(TYPE.VESPA_II, 5),
      defenseDrone(TYPE.HORNET_II, 5),
      defenseDrone(TYPE.WARRIOR_II, 5),
    ],
    defenseFlights: [
      defenseFlight("skiff_light_kinetic", TYPE.HORNET_II, 5, 10, [
        "frigate",
        "destroyer",
      ]),
      defenseFlight("skiff_light_explosive", TYPE.WARRIOR_II, 5, 20, [
        "frigate",
        "destroyer",
      ]),
      defenseFlight("skiff_medium_kinetic", TYPE.VESPA_II, 5, 30, [
        "cruiser",
        "battlecruiser",
      ]),
    ],
    miningProfile: {
      resourceFamily: "ore",
      operatingBand: "exhumer_tank",
    },
  }),
  makeDoctrine({
    doctrineID: "industrial_crew_hulk_defensive_v1",
    loadoutID: LOADOUT_IDS.HULK,
    name: "Industrial Crew Hulk Defensive Fit",
    role: "miner",
    equipmentBand: "elite",
    shipTypeID: TYPE.HULK,
    pilotLevelFloor: 5,
    modules: [
      { typeID: TYPE.STRIP_MINER_I, flagIDs: [27, 28] },
      { typeID: TYPE.MEDIUM_COMPACT_SHIELD_EXTENDER, quantity: 2 },
      { typeID: TYPE.COMPACT_MULTISPECTRUM_SHIELD_HARDENER, quantity: 1 },
      { typeID: TYPE.EM_SHIELD_HARDENER_I, quantity: 1 },
      { typeID: TYPE.MINING_LASER_UPGRADE_II, quantity: 2 },
      { typeID: TYPE.DAMAGE_CONTROL_II, quantity: 1 },
      { typeID: TYPE.MEDIUM_CORE_DEFENSE_FIELD_EXTENDER_I, quantity: 2 },
    ],
    regionalDefensePlan: {
      lightBayCount: 10,
    },
    droneBay: [
      defenseDrone(TYPE.HORNET_II, 5),
      defenseDrone(TYPE.WARRIOR_II, 5),
    ],
    defenseFlights: [
      defenseFlight("hulk_light_kinetic", TYPE.HORNET_II, 5, 10, [
        "frigate",
        "destroyer",
      ]),
      defenseFlight("hulk_light_explosive", TYPE.WARRIOR_II, 5, 20, [
        "frigate",
        "destroyer",
      ]),
    ],
    miningProfile: {
      resourceFamily: "ore",
      operatingBand: "exhumer_yield",
    },
  }),
  makeDoctrine({
    doctrineID: "industrial_crew_porpoise_support_v1",
    loadoutID: LOADOUT_IDS.PORPOISE,
    name: "Industrial Crew Porpoise Support Fit",
    role: "mining_support",
    equipmentBand: "elite",
    shipTypeID: TYPE.PORPOISE,
    pilotLevelFloor: 5,
    extraSkills: [
      { typeID: TYPE.MINING_FOREMAN, level: 5 },
      { typeID: TYPE.MINING_DIRECTOR, level: 5 },
    ],
    regionalDefensePlan: {
      lightBayCount: 15,
      mediumBayCount: 5,
    },
    modules: [
      { typeID: TYPE.MINING_FOREMAN_BURST_II, flagID: 27 },
      { typeID: TYPE.SMALL_TRACTOR_BEAM_I, flagID: 28 },
      { typeID: TYPE.MEDIUM_REMOTE_SHIELD_BOOSTER_II, flagID: 29 },
      { typeID: TYPE.DRONE_LINK_AUGMENTOR_II, flagID: 30 },
      { typeID: TYPE.TEN_MN_AFTERBURNER_II, quantity: 1 },
      { typeID: TYPE.LARGE_SHIELD_EXTENDER_II, quantity: 1 },
      { typeID: TYPE.MULTISPECTRUM_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.EM_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.DAMAGE_CONTROL_II, quantity: 1 },
      { typeID: TYPE.DRONE_DAMAGE_AMPLIFIER_II, quantity: 1 },
      { typeID: TYPE.MEDIUM_CORE_DEFENSE_FIELD_EXTENDER_I, quantity: 3 },
    ],
    charges: [
      {
        typeID: TYPE.MINING_LASER_OPTIMIZATION_CHARGE,
        quantityPerModule: 60,
        moduleFlagID: 27,
        moduleTypeID: TYPE.MINING_FOREMAN_BURST_II,
      },
    ],
    droneBay: [
      defenseDrone(TYPE.VESPA_II, 5),
      defenseDrone(TYPE.HORNET_II, 5),
      defenseDrone(TYPE.WARRIOR_II, 5),
      defenseDrone(TYPE.HOBGOBLIN_II, 5),
    ],
    defenseFlights: [
      defenseFlight("porpoise_light_kinetic", TYPE.HORNET_II, 5, 10, [
        "frigate",
        "destroyer",
      ]),
      defenseFlight("porpoise_light_explosive", TYPE.WARRIOR_II, 5, 20, [
        "frigate",
        "destroyer",
      ]),
      defenseFlight("porpoise_medium_kinetic", TYPE.VESPA_II, 5, 30, [
        "cruiser",
        "battlecruiser",
      ]),
    ],
    miningSupportProfile: {
      supportClass: "porpoise",
      cycleTimeMultiplier: 1,
      rangeMultiplier: 1,
      syntheticBoostEnabled: false,
      boostSource: "fitted_command_burst",
    },
  }),
  makeDoctrine({
    doctrineID: "industrial_crew_orca_support_v1",
    loadoutID: LOADOUT_IDS.ORCA,
    name: "Industrial Crew Orca Support Fit",
    role: "mining_support",
    equipmentBand: "elite",
    shipTypeID: TYPE.ORCA,
    pilotLevelFloor: 5,
    extraSkills: [
      { typeID: TYPE.MINING_FOREMAN, level: 5 },
      { typeID: TYPE.MINING_DIRECTOR, level: 5 },
    ],
    regionalDefensePlan: {
      lightBayCount: 20,
      mediumBayCount: 10,
    },
    modules: [
      { typeID: TYPE.MINING_FOREMAN_BURST_II, flagIDs: [27, 28] },
      { typeID: TYPE.SMALL_TRACTOR_BEAM_I, flagID: 29 },
      { typeID: TYPE.LARGE_REMOTE_SHIELD_BOOSTER_II, flagID: 30 },
      { typeID: TYPE.DRONE_LINK_AUGMENTOR_II, flagID: 31 },
      { typeID: TYPE.ONE_HUNDRED_MN_AFTERBURNER_II, quantity: 1 },
      { typeID: TYPE.LARGE_SHIELD_EXTENDER_II, quantity: 1 },
      { typeID: TYPE.MULTISPECTRUM_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.EM_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.THERMAL_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.DAMAGE_CONTROL_II, quantity: 1 },
      { typeID: TYPE.DRONE_DAMAGE_AMPLIFIER_II, quantity: 1 },
      { typeID: TYPE.LARGE_CORE_DEFENSE_FIELD_EXTENDER_I, quantity: 3 },
    ],
    charges: [
      {
        typeID: TYPE.MINING_LASER_OPTIMIZATION_CHARGE,
        quantityPerModule: 60,
        moduleFlagID: 27,
        moduleTypeID: TYPE.MINING_FOREMAN_BURST_II,
      },
      {
        typeID: TYPE.MINING_FIELD_ENHANCEMENT_CHARGE,
        quantityPerModule: 60,
        moduleFlagID: 28,
        moduleTypeID: TYPE.MINING_FOREMAN_BURST_II,
      },
    ],
    droneBay: [
      defenseDrone(TYPE.VESPA_II, 5),
      defenseDrone(TYPE.VALKYRIE_II, 5),
      defenseDrone(TYPE.HORNET_II, 5),
      defenseDrone(TYPE.WARRIOR_II, 5),
    ],
    defenseFlights: [
      defenseFlight("orca_light_kinetic", TYPE.HORNET_II, 5, 10, [
        "frigate",
        "destroyer",
      ]),
      defenseFlight("orca_light_explosive", TYPE.WARRIOR_II, 5, 20, [
        "frigate",
        "destroyer",
      ]),
      defenseFlight("orca_medium_kinetic", TYPE.VESPA_II, 5, 30, [
        "cruiser",
        "battlecruiser",
      ]),
      defenseFlight("orca_medium_explosive", TYPE.VALKYRIE_II, 5, 40, [
        "cruiser",
        "battlecruiser",
      ]),
    ],
    miningSupportProfile: {
      supportClass: "orca",
      cycleTimeMultiplier: 1,
      rangeMultiplier: 1,
      syntheticBoostEnabled: false,
      boostSource: "fitted_command_burst",
    },
  }),
  makeDoctrine({
    doctrineID: "industrial_crew_miasmos_hauler_v1",
    loadoutID: LOADOUT_IDS.MIASMOS,
    name: "Industrial Crew Miasmos Hauler Fit",
    role: "hauler",
    equipmentBand: "elite",
    shipTypeID: TYPE.MIASMOS,
    pilotLevelFloor: 5,
    modules: [
      { typeID: TYPE.SMALL_TRACTOR_BEAM_I, flagID: 27 },
      { typeID: TYPE.TEN_MN_AFTERBURNER_II, quantity: 1 },
      { typeID: TYPE.MEDIUM_SHIELD_EXTENDER_II, quantity: 2 },
      { typeID: TYPE.MULTISPECTRUM_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.EXPANDED_CARGOHOLD_II, quantity: 2 },
      { typeID: TYPE.DAMAGE_CONTROL_II, quantity: 1 },
      { typeID: TYPE.INERTIAL_STABILIZERS_II, quantity: 1 },
      { typeID: TYPE.MEDIUM_CARGOHOLD_OPTIMIZATION_I, quantity: 3 },
    ],
    logisticsProfile: {
      logisticsClass: "ore_industrial",
      capacityM3: 42_000,
      maximumCargoValueISK: 250_000_000,
    },
  }),
  makeDoctrine({
    doctrineID: "industrial_crew_bustard_hauler_v1",
    loadoutID: LOADOUT_IDS.BUSTARD,
    name: "Industrial Crew Bustard Hauler Fit",
    role: "hauler",
    equipmentBand: "elite",
    shipTypeID: TYPE.BUSTARD,
    pilotLevelFloor: 5,
    modules: [
      { typeID: TYPE.SMALL_TRACTOR_BEAM_I, flagID: 27 },
      { typeID: TYPE.TEN_MN_AFTERBURNER_II, quantity: 1 },
      { typeID: TYPE.MEDIUM_SHIELD_EXTENDER_II, quantity: 2 },
      { typeID: TYPE.MULTISPECTRUM_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.EM_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.THERMAL_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.EXPANDED_CARGOHOLD_II, quantity: 2 },
      { typeID: TYPE.DAMAGE_CONTROL_II, quantity: 1 },
      { typeID: TYPE.MEDIUM_CARGOHOLD_OPTIMIZATION_I, quantity: 2 },
    ],
    logisticsProfile: {
      logisticsClass: "deep_space_ore_transport",
      capacityM3: 60_000,
      maximumCargoValueISK: 1_000_000_000,
    },
  }),
  makeDoctrine({
    doctrineID: "industrial_crew_rorqual_support_provisional_v1",
    loadoutID: LOADOUT_IDS.RORQUAL,
    name: "Industrial Crew Rorqual Provisional Support Fit",
    role: "mining_support",
    equipmentBand: "elite",
    shipTypeID: TYPE.RORQUAL,
    pilotLevelFloor: 5,
    provisional: true,
    extraSkills: [
      { typeID: TYPE.MINING_FOREMAN, level: 5 },
      { typeID: TYPE.MINING_DIRECTOR, level: 5 },
    ],
    regionalDefensePlan: {
      lightBayCount: 10,
      mediumBayCount: 10,
      heavyBayCount: 10,
    },
    modules: [
      { typeID: TYPE.MINING_FOREMAN_BURST_II, flagIDs: [27, 28] },
      { typeID: TYPE.CAPITAL_REMOTE_SHIELD_BOOSTER_I, flagIDs: [29, 30] },
      { typeID: TYPE.CAPITAL_TRACTOR_BEAM_I, flagID: 31 },
      { typeID: TYPE.DRONE_LINK_AUGMENTOR_II, flagID: 32 },
      { typeID: TYPE.CAPITAL_SHIELD_BOOSTER_I, quantity: 1 },
      { typeID: TYPE.CAPITAL_CAP_BATTERY_I, quantity: 1 },
      { typeID: TYPE.SHIELD_BOOST_AMPLIFIER_II, quantity: 1 },
      { typeID: TYPE.MULTISPECTRUM_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.EM_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.THERMAL_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.KINETIC_SHIELD_HARDENER_II, quantity: 1 },
      { typeID: TYPE.DAMAGE_CONTROL_II, quantity: 1 },
      { typeID: TYPE.DRONE_DAMAGE_AMPLIFIER_II, quantity: 3 },
      { typeID: TYPE.CAPITAL_CORE_DEFENSE_FIELD_EXTENDER_I, quantity: 2 },
      { typeID: TYPE.CAPITAL_CAPACITOR_CONTROL_CIRCUIT_I, quantity: 1 },
    ],
    charges: [
      {
        typeID: TYPE.MINING_LASER_OPTIMIZATION_CHARGE,
        quantityPerModule: 60,
        moduleFlagID: 27,
        moduleTypeID: TYPE.MINING_FOREMAN_BURST_II,
      },
      {
        typeID: TYPE.MINING_FIELD_ENHANCEMENT_CHARGE,
        quantityPerModule: 60,
        moduleFlagID: 28,
        moduleTypeID: TYPE.MINING_FOREMAN_BURST_II,
      },
    ],
    droneBay: [
      defenseDrone(TYPE.WASP_II, 5),
      defenseDrone(TYPE.BERSERKER_II, 5),
      defenseDrone(TYPE.OGRE_II, 5),
      defenseDrone(TYPE.PRAETOR_II, 5),
      defenseDrone(TYPE.VESPA_II, 5),
      defenseDrone(TYPE.VALKYRIE_II, 5),
      defenseDrone(TYPE.HORNET_II, 5),
      defenseDrone(TYPE.WARRIOR_II, 5),
    ],
    defenseFlights: [
      defenseFlight("rorqual_light_kinetic", TYPE.HORNET_II, 5, 10, [
        "frigate",
        "destroyer",
      ]),
      defenseFlight("rorqual_light_explosive", TYPE.WARRIOR_II, 5, 20, [
        "frigate",
        "destroyer",
      ]),
      defenseFlight("rorqual_medium_kinetic", TYPE.VESPA_II, 5, 30, [
        "cruiser",
        "battlecruiser",
      ]),
      defenseFlight("rorqual_medium_explosive", TYPE.VALKYRIE_II, 5, 40, [
        "cruiser",
        "battlecruiser",
      ]),
      defenseFlight("rorqual_heavy_kinetic", TYPE.WASP_II, 5, 50, [
        "battleship",
        "capital",
      ]),
      defenseFlight("rorqual_heavy_explosive", TYPE.BERSERKER_II, 5, 60, [
        "battleship",
        "capital",
      ]),
    ],
    miningSupportProfile: {
      supportClass: "rorqual_provisional",
      cycleTimeMultiplier: 1,
      rangeMultiplier: 1,
      syntheticBoostEnabled: false,
      boostSource: "fitted_command_burst",
      industrialCoreEnabled: false,
      panicEnabled: false,
      compressionEnabled: false,
    },
  }),
]);

const PROFILE_METADATA = Object.freeze({
  [PROFILE_IDS.VENTURE]: {
    shipTypeID: TYPE.VENTURE,
    loadoutID: LOADOUT_IDS.VENTURE,
    name: "Industrial Crew Venture",
    aliases: ["crew venture", "hireling venture"],
    miningRole: "miner",
  },
  [PROFILE_IDS.RETRIEVER]: {
    shipTypeID: TYPE.RETRIEVER,
    loadoutID: LOADOUT_IDS.RETRIEVER,
    name: "Industrial Crew Retriever",
    aliases: ["crew retriever", "hireling retriever"],
    miningRole: "miner",
  },
  [PROFILE_IDS.SKIFF]: {
    shipTypeID: TYPE.SKIFF,
    loadoutID: LOADOUT_IDS.SKIFF,
    name: "Industrial Crew Skiff",
    aliases: ["crew skiff", "hireling skiff"],
    miningRole: "miner",
  },
  [PROFILE_IDS.HULK]: {
    shipTypeID: TYPE.HULK,
    loadoutID: LOADOUT_IDS.HULK,
    name: "Industrial Crew Hulk",
    aliases: ["crew hulk", "hireling hulk"],
    miningRole: "miner",
  },
  [PROFILE_IDS.PORPOISE]: {
    shipTypeID: TYPE.PORPOISE,
    loadoutID: LOADOUT_IDS.PORPOISE,
    name: "Industrial Crew Porpoise",
    aliases: ["crew porpoise", "hireling porpoise"],
    miningRole: "mining_support",
  },
  [PROFILE_IDS.ORCA]: {
    shipTypeID: TYPE.ORCA,
    loadoutID: LOADOUT_IDS.ORCA,
    name: "Industrial Crew Orca",
    aliases: ["crew orca", "hireling orca"],
    miningRole: "mining_support",
  },
  [PROFILE_IDS.MIASMOS]: {
    shipTypeID: TYPE.MIASMOS,
    loadoutID: LOADOUT_IDS.MIASMOS,
    name: "Industrial Crew Miasmos",
    aliases: ["crew miasmos", "hireling miasmos", "ore hauler"],
    miningRole: "hauler",
  },
  [PROFILE_IDS.BUSTARD]: {
    shipTypeID: TYPE.BUSTARD,
    loadoutID: LOADOUT_IDS.BUSTARD,
    name: "Industrial Crew Bustard",
    aliases: ["crew bustard", "hireling bustard", "heavy ore hauler"],
    miningRole: "hauler",
  },
  [PROFILE_IDS.RORQUAL]: {
    shipTypeID: TYPE.RORQUAL,
    loadoutID: LOADOUT_IDS.RORQUAL,
    name: "Industrial Crew Rorqual",
    aliases: ["crew rorqual", "hireling rorqual"],
    miningRole: "mining_support",
    capitalNpc: true,
    capitalClassID: "industrial_capital",
  },
});

function buildLoadoutRow(doctrine) {
  const policy = recoveryPolicy();
  return {
    loadoutID: doctrine.loadoutID,
    name: doctrine.name,
    modules: cloneValue(doctrine.modules),
    charges: cloneValue(doctrine.charges),
    droneBay: cloneValue(doctrine.droneBay),
    defenseFlights: cloneValue(doctrine.defenseFlights),
    regionalDefenseVariants: cloneValue(doctrine.regionalDefenseVariants),
    miningProfile: cloneValue(doctrine.miningProfile),
    miningSupportProfile: cloneValue(doctrine.miningSupportProfile),
    logisticsProfile: cloneValue(doctrine.logisticsProfile),
    provisional: doctrine.provisional === true,
    governance: {
      enabled: true,
      doctrineID: doctrine.doctrineID,
      doctrineRevision: INDUSTRIAL_CREW_DOCTRINE_REVISION,
      role: doctrine.role,
      equipmentBand: doctrine.equipmentBand,
      validationProfile: INDUSTRIAL_CREW_VALIDATION_PROFILE,
      strictFitValidation: true,
      procurementPolicy: "industrial_crew_contract",
      recoverabilityPolicyID: "industrial_crew_governed_v1",
      fittedModuleDropChance: policy.fittedModuleDropChance,
      fittedModuleDropChances: policy.fittedModuleDropChances,
      cargoSurvivalChance: policy.cargoSurvivalChance,
      pilotSkills: cloneValue(doctrine.pilotSkills),
    },
  };
}

function buildProfileRow(profileID, metadata, overrides = {}) {
  return {
    profileID,
    name: metadata.name,
    description:
      "Strictly governed industrial-crew hull with a legal persistent fit and defensive drone doctrine.",
    aliases: cloneValue(metadata.aliases || []),
    entityType: "npc",
    shipTypeID: metadata.shipTypeID,
    presentationTypeID: metadata.shipTypeID,
    presentationName: `Industrial Crew ${metadata.name.replace(/^Industrial Crew\s+/, "")}`,
    corporationID: 1000129,
    allianceID: 0,
    factionID: 500014,
    behaviorProfileID: "npc_passive_idle",
    loadoutID: metadata.loadoutID,
    lootTableID: "parity_diamond_entities_pending_loot",
    shipNameTemplate: metadata.name.replace(/^Industrial Crew\s+/, ""),
    securityStatus: 0,
    bounty: 0,
    spawnDistanceMeters: metadata.miningRole === "hauler" ? 16_000 : 12_000,
    preferredTargetMode: "invoker",
    miningRole: metadata.miningRole,
    hostileResponseThreshold: -5,
    friendlyResponseThreshold: 5,
    capitalNpc: metadata.capitalNpc === true,
    capitalClassID: metadata.capitalClassID || null,
    ...overrides,
  };
}

const CANONICAL_PROFILE_ROWS = Object.freeze(
  Object.entries(PROFILE_METADATA).map(([profileID, metadata]) => (
    Object.freeze(buildProfileRow(profileID, metadata))
  )),
);

const LEGACY_PROFILE_BRIDGES = Object.freeze([
  ["ore_mining_venture", PROFILE_IDS.VENTURE],
  ["ore_mining_retriever", PROFILE_IDS.RETRIEVER],
  ["ore_mining_skiff", PROFILE_IDS.SKIFF],
  ["ore_mining_hulk", PROFILE_IDS.HULK],
  ["ore_mining_bustard_hauler", PROFILE_IDS.BUSTARD],
].map(([legacyProfileID, canonicalProfileID]) => {
  const metadata = PROFILE_METADATA[canonicalProfileID];
  return Object.freeze(buildProfileRow(legacyProfileID, metadata, {
    name: `${metadata.name} Legacy Bridge`,
    aliases: [
      ...(metadata.aliases || []),
      legacyProfileID,
      canonicalProfileID,
    ],
    canonicalProfileID,
  }));
}));

const ACTIVE_MINING_SPAWN_GROUP_ROWS = Object.freeze([
  {
    spawnGroupID: "npc_mining_ops_highsec",
    name: "Governed NPC Mining Ops Highsec",
    aliases: ["mining highsec", "npc mining highsec"],
    entityType: "npc",
    entries: [
      { profileID: PROFILE_IDS.VENTURE, count: 1 },
    ],
  },
  {
    spawnGroupID: "npc_mining_ops_lowsec",
    name: "Governed NPC Mining Ops Lowsec",
    aliases: ["mining lowsec", "npc mining lowsec"],
    entityType: "npc",
    entries: [
      { profileID: PROFILE_IDS.RETRIEVER, count: 1 },
    ],
  },
  {
    spawnGroupID: "npc_mining_ops_nullsec",
    name: "Governed NPC Mining Ops Nullsec",
    aliases: ["mining nullsec", "npc mining nullsec"],
    entityType: "npc",
    entries: [
      { profileID: PROFILE_IDS.HULK, count: 1 },
    ],
  },
].map((row) => Object.freeze(row)));

const ACTIVE_MINING_SPAWN_POOL_ROWS = Object.freeze([
  {
    spawnPoolID: "npc_mining_ops",
    name: "Governed Mining Operations",
    aliases: ["mining", "miner", "npcminer", "ore mining"],
    entityType: "npc",
    entries: [
      { profileID: PROFILE_IDS.VENTURE, weight: 5 },
      { profileID: PROFILE_IDS.RETRIEVER, weight: 4 },
      { profileID: PROFILE_IDS.SKIFF, weight: 2 },
      { profileID: PROFILE_IDS.HULK, weight: 1 },
    ],
  },
  {
    spawnPoolID: "npc_mining_hauler_t1",
    name: "Governed Mining Hauler T1",
    aliases: ["mining hauler", "hauler", "hauler t1"],
    entityType: "npc",
    entries: [{ profileID: PROFILE_IDS.MIASMOS, weight: 1 }],
  },
  {
    spawnPoolID: "npc_mining_hauler_t2",
    name: "Governed Mining Hauler T2",
    aliases: ["hauler t2", "industrial t2"],
    entityType: "npc",
    entries: [{ profileID: PROFILE_IDS.BUSTARD, weight: 1 }],
  },
  {
    spawnPoolID: "npc_mining_hauler_highsec",
    name: "Governed Mining Hauler Highsec",
    aliases: ["hauler highsec"],
    entityType: "npc",
    entries: [{ profileID: PROFILE_IDS.MIASMOS, weight: 1 }],
  },
  {
    spawnPoolID: "npc_mining_hauler_lowsec",
    name: "Governed Mining Hauler Lowsec",
    aliases: ["hauler lowsec"],
    entityType: "npc",
    entries: [
      { profileID: PROFILE_IDS.MIASMOS, weight: 1 },
      { profileID: PROFILE_IDS.BUSTARD, weight: 3 },
    ],
  },
  {
    spawnPoolID: "npc_mining_hauler_nullsec",
    name: "Governed Mining Hauler Nullsec",
    aliases: ["hauler nullsec"],
    entityType: "npc",
    entries: [{ profileID: PROFILE_IDS.BUSTARD, weight: 1 }],
  },
].map((row) => Object.freeze(row)));

function getIndustrialCrewGeneratedRows(tableName) {
  if (tableName === "npcProfiles") {
    return cloneValue([
      ...CANONICAL_PROFILE_ROWS,
      ...LEGACY_PROFILE_BRIDGES,
    ]);
  }
  if (tableName === "npcLoadouts") {
    return INDUSTRIAL_CREW_DOCTRINES.map(buildLoadoutRow);
  }
  if (tableName === "npcSpawnGroups") {
    return cloneValue(ACTIVE_MINING_SPAWN_GROUP_ROWS);
  }
  if (tableName === "npcSpawnPools") {
    return cloneValue(ACTIVE_MINING_SPAWN_POOL_ROWS);
  }
  return [];
}

module.exports = {
  ACTIVE_MINING_SPAWN_GROUP_ROWS,
  ACTIVE_MINING_SPAWN_POOL_ROWS,
  CANONICAL_PROFILE_ROWS,
  INDUSTRIAL_CREW_DOCTRINES,
  INDUSTRIAL_CREW_DOCTRINE_REVISION,
  INDUSTRIAL_CREW_VALIDATION_PROFILE,
  LEGACY_PROFILE_BRIDGES,
  LOADOUT_IDS,
  PROFILE_IDS,
  TYPE,
  getIndustrialCrewGeneratedRows,
  normalizeDefenseDamageProfile,
  resolveIndustrialCrewRegionalDefense,
};
