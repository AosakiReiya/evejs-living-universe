"use strict";

const {
  chooseWeighted,
  createDeterministicRng,
} = require("./npcDoctrineGovernance");

const DOCTRINE_REVISION = 5;

function corporationIssuedPolicy(overrides = {}) {
  return {
    procurementPolicy: "corporation_issued",
    recoverabilityPolicyID: "phase3_governed_default",
    fittedModuleDropChance: 0,
    fittedModuleDropChances: {
      techOne: 0.25,
      techTwo: 0.05,
      specialGrade: 0,
    },
    cargoSurvivalChance: 0.5,
    bonusLootTableID: null,
    ...overrides,
  };
}

function doctrine(spec) {
  return Object.freeze({
    doctrineRevision: DOCTRINE_REVISION,
    weight: 1,
    modules: [],
    charges: [],
    droneBay: [],
    pilotSkills: [],
    survivabilityProfile: null,
    recoveryPolicy: corporationIssuedPolicy(),
    ...spec,
  });
}

const TRAFFIC_DOCTRINES = Object.freeze([
  doctrine({
    doctrineID: "jita_shuttle_civilian_empty_v1",
    role: "shuttle",
    equipmentBand: "civilian",
    shipTypeID: 672,
  }),
  doctrine({
    doctrineID: "jita_salvager_cormorant_v1",
    role: "salvager",
    equipmentBand: "standard",
    shipTypeID: 16238,
    modules: [
      { typeID: 25861, quantity: 4 },
      { typeID: 24348, quantity: 2 },
      { typeID: 439, quantity: 1 },
      { typeID: 377, quantity: 1 },
      { typeID: 2046, quantity: 1 },
    ],
    pilotSkills: [
      { typeID: 3327, level: 4, name: "Spaceship Command" },
      { typeID: 33096, level: 4, name: "Caldari Destroyer" },
      { typeID: 25863, level: 4, name: "Salvaging" },
      { typeID: 3449, level: 4, name: "Navigation" },
    ],
    recoveryPolicy: corporationIssuedPolicy({
      fittedModuleDropChances: {
        techOne: 0.2,
        techTwo: 0,
        specialGrade: 0,
      },
    }),
  }),
  doctrine({
    doctrineID: "jita_hauler_civilian_badger_v1",
    role: "hauler",
    equipmentBand: "civilian",
    shipTypeID: 648,
    modules: [
      { typeID: 1317, quantity: 1 },
    ],
    logisticsProfile: {
      logisticsClass: "feeder",
      capacityM3: 4_500,
      shipmentMultiplier: 1,
      maximumCargoValueISK: 25_000_000,
      lowSecurityAccess: false,
    },
    recoveryPolicy: corporationIssuedPolicy({
      fittedModuleDropChances: {
        techOne: 0.15,
        techTwo: 0,
        specialGrade: 0,
      },
    }),
  }),
  doctrine({
    doctrineID: "jita_hauler_standard_tayra_v1",
    role: "hauler",
    equipmentBand: "standard",
    shipTypeID: 649,
    modules: [
      { typeID: 1317, quantity: 3 },
    ],
    logisticsProfile: {
      logisticsClass: "regional",
      capacityM3: 12_000,
      shipmentMultiplier: 3,
      maximumCargoValueISK: 100_000_000,
      lowSecurityAccess: false,
    },
  }),
  doctrine({
    doctrineID: "jita_hauler_bulk_tayra_v2",
    role: "hauler",
    equipmentBand: "elite",
    shipTypeID: 649,
    modules: [
      { typeID: 1319, quantity: 4 },
    ],
    logisticsProfile: {
      logisticsClass: "bulk",
      capacityM3: 24_000,
      shipmentMultiplier: 8,
      maximumCargoValueISK: 250_000_000,
      lowSecurityAccess: false,
    },
  }),
  doctrine({
    doctrineID: "jita_hauler_secure_bustard_v3",
    role: "hauler",
    equipmentBand: "elite",
    shipTypeID: 12731,
    modules: [
      { typeID: 1319, quantity: 2 },
      { typeID: 3831, quantity: 3 },
      { typeID: 2281, quantity: 2 },
      { typeID: 2048, quantity: 1 },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 3342, level: 5, name: "Caldari Hauler" },
      { typeID: 19719, level: 5, name: "Transport Ships" },
      { typeID: 3419, level: 5, name: "Shield Management" },
      { typeID: 3416, level: 5, name: "Shield Operation" },
      { typeID: 3420, level: 4, name: "Tactical Shield Manipulation" },
      { typeID: 3449, level: 5, name: "Navigation" },
      { typeID: 3453, level: 4, name: "Evasive Maneuvering" },
    ],
    survivabilityProfile: {
      profileID: "frontier_transport_specialist_v1",
      virtualLossWeight: 0.25,
      casualtyChanceMultiplier: 0.55,
      combatPower: 1.2,
    },
    logisticsProfile: {
      logisticsClass: "secure",
      capacityM3: 18_000,
      shipmentMultiplier: 4,
      maximumCargoValueISK: 500_000_000,
      lowSecurityAccess: true,
    },
  }),
  doctrine({
    doctrineID: "jita_hauler_secure_convoy_bustard_v4",
    role: "hauler",
    equipmentBand: "elite",
    shipTypeID: 12731,
    modules: [
      { typeID: 1319, quantity: 2 },
      { typeID: 3831, quantity: 3 },
      { typeID: 2281, quantity: 2 },
      { typeID: 2048, quantity: 1 },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 3342, level: 5, name: "Caldari Hauler" },
      { typeID: 19719, level: 5, name: "Transport Ships" },
      { typeID: 3419, level: 5, name: "Shield Management" },
      { typeID: 3416, level: 5, name: "Shield Operation" },
      { typeID: 3420, level: 4, name: "Tactical Shield Manipulation" },
      { typeID: 3449, level: 5, name: "Navigation" },
      { typeID: 3453, level: 4, name: "Evasive Maneuvering" },
    ],
    survivabilityProfile: {
      profileID: "frontier_convoy_transport_specialist_v1",
      virtualLossWeight: 0.25,
      casualtyChanceMultiplier: 0.55,
      combatPower: 1.2,
    },
    logisticsProfile: {
      logisticsClass: "secure",
      capacityM3: 60_000,
      shipmentMultiplier: 4,
      maximumCargoValueISK: 1_000_000_000,
      lowSecurityAccess: true,
    },
  }),
  doctrine({
    doctrineID: "jita_hauler_trunk_charon_v2",
    role: "hauler",
    equipmentBand: "elite",
    shipTypeID: 20185,
    modules: [
      { typeID: 1319, quantity: 3 },
    ],
    logisticsProfile: {
      logisticsClass: "trunk",
      capacityM3: 650_000,
      shipmentMultiplier: 50,
      maximumCargoValueISK: 2_500_000_000,
      lowSecurityAccess: false,
    },
  }),
  doctrine({
    doctrineID: "jita_miner_standard_venture_v1",
    role: "miner",
    equipmentBand: "standard",
    shipTypeID: 32880,
    modules: [
      { typeID: 483, quantity: 2 },
      { typeID: 22542, quantity: 1 },
    ],
    miningProfile: { resourceFamily: "ore", operatingBand: "entry" },
  }),
  doctrine({
    doctrineID: "jita_miner_veteran_venture_v1",
    role: "miner",
    equipmentBand: "veteran",
    shipTypeID: 32880,
    modules: [
      { typeID: 482, quantity: 1 },
      { typeID: 483, quantity: 1 },
      { typeID: 22542, quantity: 1 },
    ],
    miningProfile: { resourceFamily: "ore", operatingBand: "independent" },
  }),
  doctrine({
    doctrineID: "jita_miner_elite_retriever_v1",
    role: "miner",
    equipmentBand: "elite",
    shipTypeID: 17478,
    modules: [
      { typeID: 17912, quantity: 2 },
      { typeID: 28576, quantity: 1 },
    ],
    miningProfile: { resourceFamily: "ore", operatingBand: "barge" },
  }),
  doctrine({
    doctrineID: "jita_miner_corporate_retriever_v2",
    role: "miner",
    equipmentBand: "veteran",
    shipTypeID: 17478,
    modules: [
      { typeID: 17482, quantity: 2 },
      { typeID: 22542, quantity: 1 },
    ],
    miningProfile: { resourceFamily: "ore", operatingBand: "corporate" },
  }),
  doctrine({
    doctrineID: "jita_miner_lowsec_skiff_v2",
    role: "miner",
    equipmentBand: "elite",
    shipTypeID: 22546,
    modules: [
      { typeID: 17912, quantity: 2 },
      { typeID: 28576, quantity: 1 },
      { typeID: 3831, quantity: 2 },
      { typeID: 2048, quantity: 1 },
    ],
    miningProfile: { resourceFamily: "ore", operatingBand: "lowsec" },
  }),
  doctrine({
    doctrineID: "jita_miner_elite_hulk_v2",
    role: "miner",
    equipmentBand: "elite",
    shipTypeID: 22544,
    modules: [
      { typeID: 17912, quantity: 2 },
      { typeID: 28576, quantity: 2 },
    ],
    miningProfile: { resourceFamily: "ore", operatingBand: "exhumer" },
  }),
  doctrine({
    doctrineID: "jita_ice_miner_mackinaw_v2",
    role: "miner",
    equipmentBand: "elite",
    shipTypeID: 22548,
    modules: [
      { typeID: 22229, quantity: 2 },
      { typeID: 28576, quantity: 1 },
    ],
    miningProfile: { resourceFamily: "ice", operatingBand: "ice_exhumer" },
  }),
  doctrine({
    doctrineID: "jita_mining_support_orca_v2",
    role: "mining_support",
    equipmentBand: "elite",
    shipTypeID: 28606,
    modules: [
      { typeID: 42528, quantity: 2 },
      { typeID: 24348, quantity: 1 },
      { typeID: 3831, quantity: 2 },
      { typeID: 2048, quantity: 1 },
    ],
    charges: [
      { typeID: 42830, quantityPerModule: 60 },
    ],
    miningSupportProfile: {
      supportClass: "orca",
      cycleTimeMultiplier: 0.85,
      rangeMultiplier: 1.25,
    },
  }),
  doctrine({
    doctrineID: "jita_mining_support_porpoise_v2",
    role: "mining_support",
    equipmentBand: "veteran",
    shipTypeID: 42244,
    modules: [
      { typeID: 42528, quantity: 1 },
      { typeID: 24348, quantity: 1 },
      { typeID: 3829, quantity: 1 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 42830, quantityPerModule: 60 },
    ],
    miningSupportProfile: {
      supportClass: "porpoise",
      cycleTimeMultiplier: 0.90,
      rangeMultiplier: 1.15,
    },
  }),
  doctrine({
    doctrineID: "jita_escort_standard_merlin_v1",
    role: "escort",
    equipmentBand: "standard",
    shipTypeID: 603,
    modules: [
      { typeID: 10678, quantity: 3 },
      { typeID: 377, quantity: 1 },
      { typeID: 439, quantity: 1 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 222, quantityPerModule: 80 },
    ],
  }),
  doctrine({
    doctrineID: "jita_escort_veteran_merlin_v1",
    role: "escort",
    equipmentBand: "veteran",
    shipTypeID: 603,
    modules: [
      { typeID: 10680, quantity: 1 },
      { typeID: 10678, quantity: 2 },
      { typeID: 377, quantity: 1 },
      { typeID: 439, quantity: 1 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 222, quantityPerModule: 80 },
    ],
  }),
  doctrine({
    doctrineID: "jita_escort_elite_caracal_v1",
    role: "escort",
    equipmentBand: "elite",
    shipTypeID: 621,
    modules: [
      { typeID: 2404, quantity: 5 },
      { typeID: 12058, quantity: 1 },
      { typeID: 3831, quantity: 2 },
      { typeID: 22291, quantity: 2 },
      { typeID: 2048, quantity: 1 },
    ],
    charges: [
      { typeID: 210, quantityPerModule: 60 },
    ],
  }),
  doctrine({
    doctrineID: "jita_escort_frontier_caracal_v3",
    role: "escort",
    equipmentBand: "elite",
    shipTypeID: 621,
    modules: [
      { typeID: 2404, quantity: 5 },
      { typeID: 12058, quantity: 1 },
      { typeID: 3831, quantity: 2 },
      { typeID: 22291, quantity: 2 },
      { typeID: 2048, quantity: 1 },
    ],
    charges: [
      { typeID: 210, quantityPerModule: 80 },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 3334, level: 5, name: "Caldari Cruiser" },
      { typeID: 3419, level: 4, name: "Shield Management" },
      { typeID: 3416, level: 4, name: "Shield Operation" },
      { typeID: 3449, level: 4, name: "Navigation" },
      { typeID: 3453, level: 4, name: "Evasive Maneuvering" },
    ],
    survivabilityProfile: {
      profileID: "frontier_missile_escort_v1",
      virtualLossWeight: 0.7,
      casualtyChanceMultiplier: 0.8,
      combatPower: 2.2,
    },
  }),
  doctrine({
    doctrineID: "jita_escort_frontier_moa_drone_v3",
    role: "escort",
    equipmentBand: "elite",
    shipTypeID: 623,
    modules: [
      { typeID: 10680, quantity: 5 },
      { typeID: 12058, quantity: 1 },
      { typeID: 3831, quantity: 2 },
      { typeID: 2281, quantity: 1 },
      { typeID: 10190, quantity: 2 },
      { typeID: 2048, quantity: 1 },
    ],
    charges: [
      { typeID: 222, quantityPerModule: 80 },
    ],
    droneBay: [
      { typeID: 2464, quantity: 3, name: "Hornet I" },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 3334, level: 5, name: "Caldari Cruiser" },
      { typeID: 3419, level: 4, name: "Shield Management" },
      { typeID: 3416, level: 4, name: "Shield Operation" },
      { typeID: 3449, level: 4, name: "Navigation" },
      { typeID: 3453, level: 4, name: "Evasive Maneuvering" },
      { typeID: 3436, level: 5, name: "Drones" },
      { typeID: 3442, level: 4, name: "Drone Interfacing" },
      { typeID: 24241, level: 5, name: "Light Drone Operation" },
      { typeID: 23618, level: 4, name: "Drone Durability" },
    ],
    survivabilityProfile: {
      profileID: "frontier_drone_escort_v1",
      virtualLossWeight: 0.65,
      casualtyChanceMultiplier: 0.75,
      combatPower: 2.6,
    },
  }),
  doctrine({
    doctrineID: "jita_pirate_standard_kestrel_v4",
    role: "highsec_pirate",
    equipmentBand: "standard",
    shipTypeID: 602,
    modules: [
      { typeID: 499, quantity: 4 },
      { typeID: 439, quantity: 1 },
      { typeID: 377, quantity: 1 },
      { typeID: 447, quantity: 1 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 210, quantityPerModule: 80 },
    ],
    pilotSkills: [
      { typeID: 3327, level: 4, name: "Spaceship Command" },
      { typeID: 3330, level: 4, name: "Caldari Frigate" },
      { typeID: 3319, level: 4, name: "Missile Launcher Operation" },
      { typeID: 3321, level: 4, name: "Light Missiles" },
      { typeID: 3419, level: 3, name: "Shield Management" },
      { typeID: 3449, level: 4, name: "Navigation" },
    ],
    survivabilityProfile: {
      profileID: "pirate_light_missile_frigate_v1",
      virtualLossWeight: 1.15,
      casualtyChanceMultiplier: 1.05,
      combatPower: 0.8,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_common_pirate",
      fittedModuleDropChances: { techOne: 0.35, techTwo: 0, specialGrade: 0 },
      bonusLootTableID: "phase3_highsec_pirate_common",
    }),
  }),
  doctrine({
    doctrineID: "jita_pirate_standard_merlin_v4",
    role: "highsec_pirate",
    equipmentBand: "standard",
    shipTypeID: 603,
    modules: [
      { typeID: 10678, quantity: 3 },
      { typeID: 439, quantity: 1 },
      { typeID: 377, quantity: 1 },
      { typeID: 526, quantity: 1 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 222, quantityPerModule: 80 },
    ],
    pilotSkills: [
      { typeID: 3327, level: 4, name: "Spaceship Command" },
      { typeID: 3330, level: 4, name: "Caldari Frigate" },
      { typeID: 3300, level: 4, name: "Gunnery" },
      { typeID: 3301, level: 4, name: "Small Hybrid Turret" },
      { typeID: 3419, level: 3, name: "Shield Management" },
      { typeID: 3449, level: 4, name: "Navigation" },
    ],
    survivabilityProfile: {
      profileID: "pirate_rail_frigate_v1",
      virtualLossWeight: 1.1,
      casualtyChanceMultiplier: 1,
      combatPower: 0.9,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_common_pirate",
      fittedModuleDropChances: { techOne: 0.35, techTwo: 0, specialGrade: 0 },
      bonusLootTableID: "phase3_highsec_pirate_common",
    }),
  }),
  doctrine({
    doctrineID: "jita_pirate_standard_cormorant_v1",
    role: "highsec_pirate",
    equipmentBand: "standard",
    shipTypeID: 16238,
    modules: [
      { typeID: 10678, quantity: 4 },
      { typeID: 377, quantity: 1 },
      { typeID: 439, quantity: 1 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 222, quantityPerModule: 80 },
    ],
    pilotSkills: [
      { typeID: 3327, level: 4, name: "Spaceship Command" },
      { typeID: 33092, level: 4, name: "Caldari Destroyer" },
      { typeID: 3300, level: 4, name: "Gunnery" },
      { typeID: 3301, level: 4, name: "Small Hybrid Turret" },
      { typeID: 3419, level: 3, name: "Shield Management" },
    ],
    survivabilityProfile: {
      profileID: "pirate_rail_destroyer_v1",
      virtualLossWeight: 1,
      casualtyChanceMultiplier: 1,
      combatPower: 1.2,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_common_pirate",
      fittedModuleDropChances: {
        techOne: 0.35,
        techTwo: 0,
        specialGrade: 0,
      },
      bonusLootTableID: "phase3_highsec_pirate_common",
    }),
  }),
  doctrine({
    doctrineID: "jita_pirate_veteran_cormorant_v1",
    role: "highsec_pirate",
    equipmentBand: "veteran",
    shipTypeID: 16238,
    modules: [
      { typeID: 10680, quantity: 1 },
      { typeID: 10678, quantity: 3 },
      { typeID: 377, quantity: 1 },
      { typeID: 439, quantity: 1 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 222, quantityPerModule: 80 },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 33092, level: 5, name: "Caldari Destroyer" },
      { typeID: 3300, level: 5, name: "Gunnery" },
      { typeID: 3301, level: 5, name: "Small Hybrid Turret" },
      { typeID: 3419, level: 4, name: "Shield Management" },
    ],
    survivabilityProfile: {
      profileID: "pirate_veteran_destroyer_v1",
      virtualLossWeight: 0.9,
      casualtyChanceMultiplier: 0.9,
      combatPower: 1.5,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_veteran_pirate",
      fittedModuleDropChances: {
        techOne: 0.4,
        techTwo: 0.1,
        specialGrade: 0,
      },
      bonusLootTableID: "phase3_highsec_pirate_veteran",
    }),
  }),
  doctrine({
    doctrineID: "jita_pirate_elite_caracal_v1",
    role: "highsec_pirate",
    equipmentBand: "elite",
    shipTypeID: 621,
    modules: [
      { typeID: 2404, quantity: 5 },
      { typeID: 12058, quantity: 1 },
      { typeID: 3831, quantity: 2 },
      { typeID: 22291, quantity: 2 },
      { typeID: 2048, quantity: 1 },
    ],
    charges: [
      { typeID: 210, quantityPerModule: 60 },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 3334, level: 5, name: "Caldari Cruiser" },
      { typeID: 3319, level: 5, name: "Missile Launcher Operation" },
      { typeID: 3321, level: 5, name: "Light Missiles" },
      { typeID: 3419, level: 4, name: "Shield Management" },
      { typeID: 3416, level: 4, name: "Shield Operation" },
    ],
    survivabilityProfile: {
      profileID: "pirate_missile_cruiser_v1",
      virtualLossWeight: 0.75,
      casualtyChanceMultiplier: 0.8,
      combatPower: 2.2,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_elite_pirate",
      fittedModuleDropChances: {
        techOne: 0.4,
        techTwo: 0.15,
        specialGrade: 0,
      },
      bonusLootTableID: "phase3_highsec_pirate_elite",
    }),
  }),
  doctrine({
    doctrineID: "jita_pirate_veteran_moa_drone_v4",
    role: "highsec_pirate",
    equipmentBand: "veteran",
    shipTypeID: 623,
    modules: [
      { typeID: 12344, quantity: 4 },
      { typeID: 12056, quantity: 1 },
      { typeID: 3829, quantity: 1 },
      { typeID: 9944, quantity: 2 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 230, quantityPerModule: 100 },
    ],
    droneBay: [
      { typeID: 2464, quantity: 3, name: "Hornet I" },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 3334, level: 4, name: "Caldari Cruiser" },
      { typeID: 3300, level: 4, name: "Gunnery" },
      { typeID: 3304, level: 4, name: "Medium Hybrid Turret" },
      { typeID: 3419, level: 4, name: "Shield Management" },
      { typeID: 3436, level: 5, name: "Drones" },
      { typeID: 3442, level: 3, name: "Drone Interfacing" },
    ],
    survivabilityProfile: {
      profileID: "pirate_drone_cruiser_v1",
      virtualLossWeight: 0.75,
      casualtyChanceMultiplier: 0.82,
      combatPower: 2.5,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_veteran_pirate",
      fittedModuleDropChances: { techOne: 0.4, techTwo: 0.05, specialGrade: 0 },
      bonusLootTableID: "phase3_highsec_pirate_veteran",
    }),
  }),
  doctrine({
    doctrineID: "jita_pirate_elite_blackbird_v4",
    role: "highsec_pirate",
    equipmentBand: "elite",
    shipTypeID: 632,
    modules: [
      { typeID: 499, quantity: 3 },
      { typeID: 12056, quantity: 1 },
      { typeID: 3829, quantity: 2 },
      { typeID: 1957, quantity: 2 },
      { typeID: 12274, quantity: 2 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 210, quantityPerModule: 100 },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 3334, level: 5, name: "Caldari Cruiser" },
      { typeID: 3319, level: 5, name: "Missile Launcher Operation" },
      { typeID: 3419, level: 4, name: "Shield Management" },
    ],
    survivabilityProfile: {
      profileID: "pirate_electronic_cruiser_v1",
      virtualLossWeight: 0.8,
      casualtyChanceMultiplier: 0.85,
      combatPower: 2,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_elite_pirate",
      fittedModuleDropChances: { techOne: 0.4, techTwo: 0.1, specialGrade: 0 },
      bonusLootTableID: "phase3_highsec_pirate_elite",
    }),
  }),
  doctrine({
    doctrineID: "jita_pirate_elite_drake_v4",
    role: "highsec_pirate",
    equipmentBand: "elite",
    shipTypeID: 24698,
    modules: [
      { typeID: 501, quantity: 5 },
      { typeID: 12056, quantity: 1 },
      { typeID: 3839, quantity: 1 },
      { typeID: 12274, quantity: 1 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 209, quantityPerModule: 120 },
    ],
    droneBay: [
      { typeID: 2464, quantity: 5, name: "Hornet I" },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 33096, level: 5, name: "Caldari Battlecruiser" },
      { typeID: 3319, level: 5, name: "Missile Launcher Operation" },
      { typeID: 3324, level: 5, name: "Heavy Missiles" },
      { typeID: 3419, level: 5, name: "Shield Management" },
      { typeID: 3416, level: 5, name: "Shield Operation" },
      { typeID: 3436, level: 5, name: "Drones" },
      { typeID: 3442, level: 4, name: "Drone Interfacing" },
    ],
    survivabilityProfile: {
      profileID: "pirate_missile_battlecruiser_v1",
      virtualLossWeight: 0.45,
      casualtyChanceMultiplier: 0.65,
      combatPower: 4.2,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_elite_pirate",
      fittedModuleDropChances: { techOne: 0.4, techTwo: 0.1, specialGrade: 0 },
      bonusLootTableID: "phase3_highsec_pirate_elite",
    }),
  }),
  doctrine({
    doctrineID: "jita_pirate_command_raven_v4",
    role: "highsec_pirate",
    equipmentBand: "elite",
    shipTypeID: 638,
    modules: [
      { typeID: 13320, quantity: 6 },
      { typeID: 12066, quantity: 1 },
      { typeID: 3839, quantity: 2 },
      { typeID: 10838, quantity: 1 },
      { typeID: 2281, quantity: 1 },
      { typeID: 12274, quantity: 2 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 203, quantityPerModule: 100 },
    ],
    droneBay: [
      { typeID: 2464, quantity: 5, name: "Hornet I" },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 3338, level: 5, name: "Caldari Battleship" },
      { typeID: 3319, level: 5, name: "Missile Launcher Operation" },
      { typeID: 3326, level: 5, name: "Cruise Missiles" },
      { typeID: 3419, level: 5, name: "Shield Management" },
      { typeID: 3416, level: 5, name: "Shield Operation" },
      { typeID: 3436, level: 5, name: "Drones" },
      { typeID: 3442, level: 4, name: "Drone Interfacing" },
    ],
    survivabilityProfile: {
      profileID: "pirate_battleship_command_v1",
      virtualLossWeight: 0.25,
      casualtyChanceMultiplier: 0.5,
      combatPower: 7,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_elite_pirate",
      fittedModuleDropChances: { techOne: 0.35, techTwo: 0.08, specialGrade: 0 },
      bonusLootTableID: "phase3_highsec_pirate_elite",
    }),
  }),
  doctrine({
    doctrineID: "jita_police_standard_caracal_v1",
    role: "police",
    equipmentBand: "standard",
    shipTypeID: 621,
    modules: [
      { typeID: 499, quantity: 5 },
      { typeID: 12056, quantity: 1 },
      { typeID: 3829, quantity: 2 },
      { typeID: 12274, quantity: 2 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 210, quantityPerModule: 60 },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 3334, level: 4, name: "Caldari Cruiser" },
      { typeID: 3319, level: 4, name: "Missile Launcher Operation" },
      { typeID: 3321, level: 4, name: "Light Missiles" },
      { typeID: 3419, level: 4, name: "Shield Management" },
    ],
    survivabilityProfile: {
      profileID: "state_patrol_cruiser_v1",
      virtualLossWeight: 0.7,
      casualtyChanceMultiplier: 0.75,
      combatPower: 2.5,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_state_service_nonrecoverable",
      fittedModuleDropChances: {
        techOne: 0,
        techTwo: 0,
        specialGrade: 0,
      },
    }),
  }),
  doctrine({
    doctrineID: "jita_police_elite_caracal_v1",
    role: "police",
    equipmentBand: "elite",
    shipTypeID: 621,
    modules: [
      { typeID: 2404, quantity: 5 },
      { typeID: 12058, quantity: 1 },
      { typeID: 3831, quantity: 2 },
      { typeID: 22291, quantity: 2 },
      { typeID: 2048, quantity: 1 },
    ],
    charges: [
      { typeID: 210, quantityPerModule: 60 },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 3334, level: 5, name: "Caldari Cruiser" },
      { typeID: 3319, level: 5, name: "Missile Launcher Operation" },
      { typeID: 3321, level: 5, name: "Light Missiles" },
      { typeID: 3419, level: 5, name: "Shield Management" },
      { typeID: 3416, level: 5, name: "Shield Operation" },
    ],
    survivabilityProfile: {
      profileID: "state_veteran_cruiser_v1",
      virtualLossWeight: 0.55,
      casualtyChanceMultiplier: 0.65,
      combatPower: 3,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_state_service_nonrecoverable",
      fittedModuleDropChances: {
        techOne: 0,
        techTwo: 0,
        specialGrade: 0,
      },
    }),
  }),
  doctrine({
    doctrineID: "jita_police_standard_moa_drone_v4",
    role: "police",
    equipmentBand: "standard",
    shipTypeID: 623,
    modules: [
      { typeID: 12344, quantity: 4 },
      { typeID: 12056, quantity: 1 },
      { typeID: 3829, quantity: 1 },
      { typeID: 9944, quantity: 2 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 230, quantityPerModule: 100 },
    ],
    droneBay: [
      { typeID: 2464, quantity: 3, name: "Hornet I" },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 3334, level: 4, name: "Caldari Cruiser" },
      { typeID: 3300, level: 4, name: "Gunnery" },
      { typeID: 3304, level: 4, name: "Medium Hybrid Turret" },
      { typeID: 3419, level: 4, name: "Shield Management" },
      { typeID: 3436, level: 5, name: "Drones" },
      { typeID: 3442, level: 3, name: "Drone Interfacing" },
    ],
    survivabilityProfile: {
      profileID: "state_drone_cruiser_v1",
      virtualLossWeight: 0.65,
      casualtyChanceMultiplier: 0.72,
      combatPower: 2.8,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_state_service_nonrecoverable",
      fittedModuleDropChances: { techOne: 0, techTwo: 0, specialGrade: 0 },
    }),
  }),
  doctrine({
    doctrineID: "jita_police_standard_osprey_v4",
    role: "police",
    equipmentBand: "standard",
    shipTypeID: 620,
    modules: [
      { typeID: 499, quantity: 2 },
      { typeID: 3596, quantity: 2 },
      { typeID: 12056, quantity: 1 },
      { typeID: 3829, quantity: 2 },
      { typeID: 12274, quantity: 1 },
      { typeID: 2046, quantity: 1 },
    ],
    charges: [
      { typeID: 210, quantityPerModule: 100 },
    ],
    droneBay: [
      { typeID: 2464, quantity: 4, name: "Hornet I" },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 3334, level: 4, name: "Caldari Cruiser" },
      { typeID: 3319, level: 4, name: "Missile Launcher Operation" },
      { typeID: 3419, level: 4, name: "Shield Management" },
      { typeID: 3436, level: 5, name: "Drones" },
      { typeID: 3442, level: 3, name: "Drone Interfacing" },
    ],
    survivabilityProfile: {
      profileID: "state_support_cruiser_v1",
      virtualLossWeight: 0.8,
      casualtyChanceMultiplier: 0.8,
      combatPower: 2.1,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_state_service_nonrecoverable",
      fittedModuleDropChances: { techOne: 0, techTwo: 0, specialGrade: 0 },
    }),
  }),
  doctrine({
    doctrineID: "jita_police_elite_ferox_v4",
    role: "police",
    equipmentBand: "elite",
    shipTypeID: 16227,
    modules: [
      { typeID: 12346, quantity: 6 },
      { typeID: 12058, quantity: 1 },
      { typeID: 3831, quantity: 2 },
      { typeID: 2281, quantity: 1 },
      { typeID: 10190, quantity: 2 },
      { typeID: 2048, quantity: 1 },
    ],
    charges: [
      { typeID: 230, quantityPerModule: 120 },
    ],
    droneBay: [
      { typeID: 2464, quantity: 5, name: "Hornet I" },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 33096, level: 5, name: "Caldari Battlecruiser" },
      { typeID: 3300, level: 5, name: "Gunnery" },
      { typeID: 3304, level: 5, name: "Medium Hybrid Turret" },
      { typeID: 3419, level: 5, name: "Shield Management" },
      { typeID: 3416, level: 5, name: "Shield Operation" },
      { typeID: 3436, level: 5, name: "Drones" },
      { typeID: 3442, level: 4, name: "Drone Interfacing" },
    ],
    survivabilityProfile: {
      profileID: "state_battlecruiser_v1",
      virtualLossWeight: 0.4,
      casualtyChanceMultiplier: 0.55,
      combatPower: 4.8,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_state_service_nonrecoverable",
      fittedModuleDropChances: { techOne: 0, techTwo: 0, specialGrade: 0 },
    }),
  }),
  doctrine({
    doctrineID: "jita_police_command_rokh_v4",
    role: "police",
    equipmentBand: "elite",
    shipTypeID: 24688,
    modules: [
      { typeID: 12354, quantity: 8 },
      { typeID: 12066, quantity: 1 },
      { typeID: 3839, quantity: 1 },
      { typeID: 10838, quantity: 1 },
      { typeID: 2281, quantity: 1 },
      { typeID: 9944, quantity: 2 },
      { typeID: 2048, quantity: 1 },
    ],
    charges: [
      { typeID: 238, quantityPerModule: 120 },
    ],
    droneBay: [
      { typeID: 2464, quantity: 5, name: "Hornet I" },
    ],
    pilotSkills: [
      { typeID: 3327, level: 5, name: "Spaceship Command" },
      { typeID: 3338, level: 5, name: "Caldari Battleship" },
      { typeID: 3300, level: 5, name: "Gunnery" },
      { typeID: 3307, level: 5, name: "Large Hybrid Turret" },
      { typeID: 3419, level: 5, name: "Shield Management" },
      { typeID: 3416, level: 5, name: "Shield Operation" },
      { typeID: 3436, level: 5, name: "Drones" },
      { typeID: 3442, level: 4, name: "Drone Interfacing" },
    ],
    survivabilityProfile: {
      profileID: "state_battleship_command_v1",
      virtualLossWeight: 0.2,
      casualtyChanceMultiplier: 0.45,
      combatPower: 8,
    },
    recoveryPolicy: corporationIssuedPolicy({
      recoverabilityPolicyID: "phase3_state_service_nonrecoverable",
      fittedModuleDropChances: { techOne: 0, techTwo: 0, specialGrade: 0 },
    }),
  }),
]);

const TRAFFIC_LOOT_TABLES = Object.freeze([
  Object.freeze({
    lootTableID: "phase3_highsec_pirate_common",
    name: "Phase 3 High-Security Common Pirate Loot",
    minEntries: 0,
    maxEntries: 1,
    allowDuplicates: false,
    entries: Object.freeze([
      { typeID: 15331, weight: 6, minQuantity: 1, maxQuantity: 3 },
      { typeID: 222, weight: 5, minQuantity: 20, maxQuantity: 80 },
      { typeID: 210, weight: 5, minQuantity: 15, maxQuantity: 60 },
    ]),
  }),
  Object.freeze({
    lootTableID: "phase3_highsec_pirate_veteran",
    name: "Phase 3 High-Security Veteran Pirate Loot",
    minEntries: 0,
    maxEntries: 2,
    allowDuplicates: false,
    entries: Object.freeze([
      { typeID: 15331, weight: 5, minQuantity: 1, maxQuantity: 4 },
      { typeID: 222, weight: 4, minQuantity: 30, maxQuantity: 100 },
      { typeID: 210, weight: 4, minQuantity: 20, maxQuantity: 80 },
    ]),
  }),
  Object.freeze({
    lootTableID: "phase3_highsec_pirate_elite",
    name: "Phase 3 High-Security Elite Pirate Loot",
    minEntries: 0,
    maxEntries: 2,
    allowDuplicates: false,
    entries: Object.freeze([
      { typeID: 15331, weight: 4, minQuantity: 2, maxQuantity: 6 },
      { typeID: 222, weight: 3, minQuantity: 40, maxQuantity: 120 },
      { typeID: 210, weight: 3, minQuantity: 30, maxQuantity: 100 },
    ]),
  }),
]);

const JITA_ROLE_DISTRIBUTION = Object.freeze([
  { role: "shuttle", weight: 30 },
  { role: "hauler", weight: 30 },
  { role: "police", weight: 15 },
  { role: "miner", weight: 10 },
  { role: "escort", weight: 10 },
  { role: "highsec_pirate", weight: 5 },
]);

const JITA_BAND_DISTRIBUTIONS = Object.freeze({
  shuttle: Object.freeze([
    { equipmentBand: "civilian", weight: 100 },
  ]),
  hauler: Object.freeze([
    { equipmentBand: "civilian", weight: 90 },
    { equipmentBand: "standard", weight: 10 },
  ]),
  miner: Object.freeze([
    { equipmentBand: "standard", weight: 70 },
    { equipmentBand: "veteran", weight: 29 },
    { equipmentBand: "elite", weight: 1 },
  ]),
  escort: Object.freeze([
    { equipmentBand: "standard", weight: 75 },
    { equipmentBand: "veteran", weight: 24 },
    { equipmentBand: "elite", weight: 1 },
  ]),
  highsec_pirate: Object.freeze([
    { equipmentBand: "standard", weight: 80 },
    { equipmentBand: "veteran", weight: 19 },
    { equipmentBand: "elite", weight: 1 },
  ]),
  police: Object.freeze([
    { equipmentBand: "standard", weight: 95 },
    { equipmentBand: "elite", weight: 5 },
  ]),
});

const CARGO_PROFILES = Object.freeze({
  shuttle: Object.freeze([]),
  hauler: Object.freeze([
    { typeID: 34, minQuantity: 2_000, maxQuantity: 12_000 },
    { typeID: 35, minQuantity: 1_000, maxQuantity: 6_000 },
    { typeID: 9836, minQuantity: 5, maxQuantity: 30 },
    { typeID: 3689, minQuantity: 5, maxQuantity: 30 },
  ]),
  miner: Object.freeze([
    { typeID: 1230, minQuantity: 500, maxQuantity: 4_000 },
    { typeID: 1228, minQuantity: 500, maxQuantity: 4_000 },
  ]),
  escort: Object.freeze([
    { typeID: 222, minQuantity: 80, maxQuantity: 240 },
  ]),
  highsec_pirate: Object.freeze([
    { typeID: 222, minQuantity: 80, maxQuantity: 240 },
  ]),
  police: Object.freeze([
    { typeID: 210, minQuantity: 60, maxQuantity: 180 },
  ]),
});

function selectJitaDoctrineForActor(actorSeed) {
  const rng = createDeterministicRng(actorSeed);
  const roleEntry = chooseWeighted(JITA_ROLE_DISTRIBUTION, rng);
  if (!roleEntry) {
    return null;
  }
  const role = roleEntry.role;
  const bandEntry = chooseWeighted(JITA_BAND_DISTRIBUTIONS[role], rng);
  if (!bandEntry) {
    return null;
  }
  const equipmentBand = bandEntry.equipmentBand;
  const doctrine = chooseWeighted(
    TRAFFIC_DOCTRINES.filter((candidate) => (
      candidate.role === role && candidate.equipmentBand === equipmentBand
    )),
    rng,
  );
  return doctrine
    ? {
        role,
        equipmentBand,
        doctrine,
        rng,
      }
    : null;
}

module.exports = {
  CARGO_PROFILES,
  DOCTRINE_REVISION,
  JITA_BAND_DISTRIBUTIONS,
  JITA_ROLE_DISTRIBUTION,
  TRAFFIC_DOCTRINES,
  TRAFFIC_LOOT_TABLES,
  corporationIssuedPolicy,
  selectJitaDoctrineForActor,
};
