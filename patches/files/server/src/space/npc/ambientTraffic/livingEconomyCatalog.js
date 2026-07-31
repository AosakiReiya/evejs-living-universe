"use strict";

const path = require("path");
const worldData = require(path.join(__dirname, "../../worldData"));

const PILOT_REGION_ID = 10000002;
const PILOT_REGION_IDS = Object.freeze([
  10000002, // The Forge
  10000016, // Lonetrek
  10000069, // Black Rise
]);
const PILOT_REGION_ID_SET = new Set(PILOT_REGION_IDS);
const EXCLUDED_ECONOMY_REGION_IDS = new Set([
  10000004, // UUA-F4 / Polaris developer space
  10000017, // J7HZ-F / disconnected Jove space
  10000019, // A821-A / disconnected Jove space
]);
const MAJOR_HUB_STATION_IDS = Object.freeze([
  60003760, // Jita 4-4, The Forge
  60008494, // Amarr VIII, Domain
  60011866, // Dodixie IX-20, Sinq Laison
  60004588, // Rens VI-8, Heimatar
  60005686, // Hek VIII-12, Metropolis
]);

const CATEGORY = Object.freeze({
  LOW_MINERAL: "low_mineral",
  HIGH_MINERAL: "high_mineral",
  AMMO: "ammo",
  DRONE: "drone",
  COMBAT_MODULE: "combat_module",
  FREIGHT_MODULE: "freight_module",
  MINING_MODULE: "mining_module",
  EXPLORATION: "exploration",
  REPAIR: "repair",
  SHIP: "ship",
  ICE_PRODUCT: "ice_product",
  ORE: "ore",
  SALVAGE: "salvage",
  SCRAP: "scrap",
  STRUCTURE_COMPONENT: "structure_component",
  STRUCTURE_SERVICE: "structure_service",
});

function good(spec) {
  return Object.freeze({
    targetQuantity: 100,
    shipmentQuantity: 25,
    productionBatch: 25,
    volume: 1,
    ...spec,
  });
}

// This is intentionally a small, T1-focused basket. It gives the pilot region
// useful essentials without recreating the imported "everything everywhere"
// market. Price anchors are conservative local reference prices, not uncapped
// public-market prices.
const GOODS = Object.freeze([
  good({ typeID: 34, name: "Tritanium", category: CATEGORY.LOW_MINERAL, priceAnchor: 4.25, targetQuantity: 200_000, shipmentQuantity: 100_000, productionBatch: 100_000, volume: 0.01 }),
  good({ typeID: 35, name: "Pyerite", category: CATEGORY.LOW_MINERAL, priceAnchor: 21, targetQuantity: 100_000, shipmentQuantity: 50_000, productionBatch: 50_000, volume: 0.01 }),
  good({ typeID: 36, name: "Mexallon", category: CATEGORY.LOW_MINERAL, priceAnchor: 76, targetQuantity: 40_000, shipmentQuantity: 20_000, productionBatch: 20_000, volume: 0.01 }),
  good({ typeID: 37, name: "Isogen", category: CATEGORY.LOW_MINERAL, priceAnchor: 316, targetQuantity: 16_000, shipmentQuantity: 8_000, productionBatch: 8_000, volume: 0.01 }),
  good({ typeID: 38, name: "Nocxium", category: CATEGORY.HIGH_MINERAL, priceAnchor: 790, targetQuantity: 4_000, shipmentQuantity: 2_000, productionBatch: 2_000, volume: 0.01 }),
  good({ typeID: 39, name: "Zydrine", category: CATEGORY.HIGH_MINERAL, priceAnchor: 1_625, targetQuantity: 1_600, shipmentQuantity: 800, productionBatch: 800, volume: 0.01 }),
  good({ typeID: 40, name: "Megacyte", category: CATEGORY.HIGH_MINERAL, priceAnchor: 3_140, targetQuantity: 800, shipmentQuantity: 400, productionBatch: 400, volume: 0.01 }),

  good({ typeID: 210, name: "Scourge Light Missile", category: CATEGORY.AMMO, priceAnchor: 14.5, targetQuantity: 30_000, shipmentQuantity: 12_000, productionBatch: 12_000, volume: 0.015 }),
  good({ typeID: 209, name: "Scourge Heavy Missile", category: CATEGORY.AMMO, priceAnchor: 58, targetQuantity: 18_000, shipmentQuantity: 6_000, productionBatch: 6_000, volume: 0.03 }),
  good({ typeID: 203, name: "Scourge Cruise Missile", category: CATEGORY.AMMO, priceAnchor: 300, targetQuantity: 6_000, shipmentQuantity: 2_000, productionBatch: 2_000, volume: 0.05 }),
  good({ typeID: 215, name: "Iron Charge S", category: CATEGORY.AMMO, priceAnchor: 11.5, targetQuantity: 24_000, shipmentQuantity: 12_000, productionBatch: 12_000, volume: 0.0025 }),
  good({ typeID: 218, name: "Lead Charge S", category: CATEGORY.AMMO, priceAnchor: 21, targetQuantity: 24_000, shipmentQuantity: 12_000, productionBatch: 12_000, volume: 0.0025 }),
  good({ typeID: 222, name: "Antimatter Charge S", category: CATEGORY.AMMO, priceAnchor: 37.5, targetQuantity: 30_000, shipmentQuantity: 12_000, productionBatch: 12_000, volume: 0.0025 }),
  good({ typeID: 230, name: "Antimatter Charge M", category: CATEGORY.AMMO, priceAnchor: 85, targetQuantity: 18_000, shipmentQuantity: 6_000, productionBatch: 6_000, volume: 0.0125 }),
  good({ typeID: 238, name: "Antimatter Charge L", category: CATEGORY.AMMO, priceAnchor: 210, targetQuantity: 6_000, shipmentQuantity: 2_000, productionBatch: 2_000, volume: 0.025 }),

  good({ typeID: 2454, name: "Hobgoblin I", category: CATEGORY.DRONE, priceAnchor: 8_300, targetQuantity: 160, shipmentQuantity: 60, productionBatch: 60, volume: 5 }),
  good({ typeID: 2464, name: "Hornet I", category: CATEGORY.DRONE, priceAnchor: 7_750, targetQuantity: 160, shipmentQuantity: 60, productionBatch: 60, volume: 5 }),
  good({ typeID: 2486, name: "Warrior I", category: CATEGORY.DRONE, priceAnchor: 17_500, targetQuantity: 120, shipmentQuantity: 40, productionBatch: 40, volume: 5 }),

  good({ typeID: 439, name: "1MN Afterburner I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 24_500, targetQuantity: 80, shipmentQuantity: 30, productionBatch: 30, volume: 5 }),
  good({ typeID: 434, name: "5MN Microwarpdrive I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 58_000, targetQuantity: 50, shipmentQuantity: 20, productionBatch: 20, volume: 10 }),
  good({ typeID: 2046, name: "Damage Control I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 18_000, targetQuantity: 80, shipmentQuantity: 30, productionBatch: 30, volume: 5 }),
  good({ typeID: 399, name: "Small Shield Booster I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 31_500, targetQuantity: 60, shipmentQuantity: 20, productionBatch: 20, volume: 5 }),
  good({ typeID: 377, name: "Small Shield Extender I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 18_500, targetQuantity: 60, shipmentQuantity: 20, productionBatch: 20, volume: 5 }),
  good({ typeID: 3829, name: "Medium Shield Extender I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 61_000, targetQuantity: 40, shipmentQuantity: 15, productionBatch: 15, volume: 10 }),
  good({ typeID: 447, name: "Warp Scrambler I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 105_000, targetQuantity: 40, shipmentQuantity: 15, productionBatch: 15, volume: 5 }),
  good({ typeID: 526, name: "Stasis Webifier I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 43_500, targetQuantity: 40, shipmentQuantity: 15, productionBatch: 15, volume: 5 }),
  good({ typeID: 10678, name: "125mm Railgun I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 17_500, targetQuantity: 90, shipmentQuantity: 30, productionBatch: 30, volume: 5 }),
  good({ typeID: 499, name: "Light Missile Launcher I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 8_500, targetQuantity: 90, shipmentQuantity: 30, productionBatch: 30, volume: 5 }),
  good({ typeID: 501, name: "Heavy Missile Launcher I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 37_000, targetQuantity: 50, shipmentQuantity: 15, productionBatch: 10, volume: 10 }),
  good({ typeID: 13320, name: "Cruise Missile Launcher I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 42_000, targetQuantity: 24, shipmentQuantity: 8, productionBatch: 6, volume: 20 }),
  good({ typeID: 12344, name: "200mm Railgun I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 110_000, targetQuantity: 50, shipmentQuantity: 15, productionBatch: 10, volume: 10 }),
  good({ typeID: 12354, name: "350mm Railgun I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 1_100_000, targetQuantity: 24, shipmentQuantity: 8, productionBatch: 6, volume: 20 }),
  good({ typeID: 3839, name: "Large Shield Extender I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 240_000, targetQuantity: 30, shipmentQuantity: 10, productionBatch: 8, volume: 20 }),
  good({ typeID: 10838, name: "Large Shield Booster I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 220_000, targetQuantity: 24, shipmentQuantity: 8, productionBatch: 6, volume: 25 }),
  good({ typeID: 9944, name: "Magnetic Field Stabilizer I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 31_000, targetQuantity: 40, shipmentQuantity: 15, productionBatch: 10, volume: 5 }),
  good({ typeID: 12056, name: "10MN Afterburner I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 45_000, targetQuantity: 40, shipmentQuantity: 15, productionBatch: 15, volume: 25 }),
  good({ typeID: 12066, name: "100MN Afterburner I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 180_000, targetQuantity: 24, shipmentQuantity: 8, productionBatch: 6, volume: 50 }),
  good({ typeID: 12274, name: "Ballistic Control System I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 30_000, targetQuantity: 60, shipmentQuantity: 20, productionBatch: 20, volume: 5 }),
  good({ typeID: 1957, name: "Multispectral ECM I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 95_000, targetQuantity: 30, shipmentQuantity: 10, productionBatch: 8, volume: 5 }),
  good({ typeID: 3596, name: "Medium Remote Shield Booster I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 125_000, targetQuantity: 24, shipmentQuantity: 8, productionBatch: 6, volume: 10 }),

  good({ typeID: 1317, name: "Expanded Cargohold I", category: CATEGORY.FREIGHT_MODULE, priceAnchor: 4_000, targetQuantity: 100, shipmentQuantity: 40, productionBatch: 40, volume: 5 }),
  good({ typeID: 483, name: "Miner I", category: CATEGORY.MINING_MODULE, priceAnchor: 20_000, targetQuantity: 80, shipmentQuantity: 30, productionBatch: 30, volume: 5 }),
  good({ typeID: 482, name: "Miner II", category: CATEGORY.MINING_MODULE, priceAnchor: 500_000, targetQuantity: 30, shipmentQuantity: 8, productionBatch: 4, volume: 5 }),
  good({ typeID: 22542, name: "Mining Laser Upgrade I", category: CATEGORY.MINING_MODULE, priceAnchor: 22_000, targetQuantity: 60, shipmentQuantity: 20, productionBatch: 20, volume: 5 }),
  good({ typeID: 28576, name: "Mining Laser Upgrade II", category: CATEGORY.MINING_MODULE, priceAnchor: 900_000, targetQuantity: 24, shipmentQuantity: 6, productionBatch: 3, volume: 5 }),
  good({ typeID: 17482, name: "Strip Miner I", category: CATEGORY.MINING_MODULE, priceAnchor: 1_800_000, targetQuantity: 24, shipmentQuantity: 8, productionBatch: 4, volume: 5 }),
  good({ typeID: 17912, name: "Modulated Strip Miner II", category: CATEGORY.MINING_MODULE, priceAnchor: 6_000_000, targetQuantity: 12, shipmentQuantity: 4, productionBatch: 2, volume: 5 }),
  good({ typeID: 22229, name: "Ice Harvester II", category: CATEGORY.MINING_MODULE, priceAnchor: 5_000_000, targetQuantity: 12, shipmentQuantity: 4, productionBatch: 2, volume: 5 }),
  good({ typeID: 24348, name: "Small Tractor Beam I", category: CATEGORY.MINING_MODULE, priceAnchor: 1_308_176, targetQuantity: 12, shipmentQuantity: 4, productionBatch: 2, volume: 50 }),
  good({ typeID: 42528, name: "Mining Foreman Burst I", category: CATEGORY.MINING_MODULE, priceAnchor: 750_000, targetQuantity: 12, shipmentQuantity: 4, productionBatch: 2, volume: 60 }),
  good({ typeID: 42830, name: "Mining Laser Optimization Charge", category: CATEGORY.MINING_MODULE, priceAnchor: 1_000, targetQuantity: 6_000, shipmentQuantity: 1_500, productionBatch: 1_500, volume: 0.01 }),
  good({ typeID: 2048, name: "Damage Control II", category: CATEGORY.COMBAT_MODULE, priceAnchor: 600_000, targetQuantity: 24, shipmentQuantity: 6, productionBatch: 3, volume: 5 }),
  good({ typeID: 3831, name: "Medium Shield Extender II", category: CATEGORY.COMBAT_MODULE, priceAnchor: 1_200_000, targetQuantity: 24, shipmentQuantity: 6, productionBatch: 3, volume: 10 }),
  good({ typeID: 25861, name: "Salvager I", category: CATEGORY.EXPLORATION, priceAnchor: 84_000, targetQuantity: 40, shipmentQuantity: 15, productionBatch: 15, volume: 5 }),
  good({ typeID: 30013, name: "Core Scanner Probe I", category: CATEGORY.EXPLORATION, priceAnchor: 11_000, targetQuantity: 400, shipmentQuantity: 160, productionBatch: 160, volume: 0.1 }),
  good({ typeID: 28668, name: "Nanite Repair Paste", category: CATEGORY.REPAIR, priceAnchor: 53_000, targetQuantity: 2_000, shipmentQuantity: 800, productionBatch: 800, volume: 0.01 }),
  // Foundation bridge products for the family-estate restoration chain. They
  // are manufactured from real mineral stock by the NPC workforce until the
  // full PI/component chain is modeled; they are never seeded as free stock.
  good({ typeID: 21947, name: "Structure Construction Parts", category: CATEGORY.STRUCTURE_COMPONENT, priceAnchor: 22_500_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 3_000 }),
  good({ typeID: 35899, name: "Standup Reprocessing Facility I", category: CATEGORY.STRUCTURE_SERVICE, priceAnchor: 75_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 4_000 }),

  good({ typeID: 32880, name: "Venture", category: CATEGORY.SHIP, priceAnchor: 300_000, targetQuantity: 10, shipmentQuantity: 2, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 648, name: "Badger", category: CATEGORY.SHIP, priceAnchor: 900_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 20_000 }),
  good({ typeID: 605, name: "Heron", category: CATEGORY.SHIP, priceAnchor: 250_000, targetQuantity: 8, shipmentQuantity: 2, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 603, name: "Merlin", category: CATEGORY.SHIP, priceAnchor: 350_000, targetQuantity: 10, shipmentQuantity: 2, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 602, name: "Kestrel", category: CATEGORY.SHIP, priceAnchor: 360_000, targetQuantity: 10, shipmentQuantity: 2, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 649, name: "Tayra", category: CATEGORY.SHIP, priceAnchor: 1_100_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 20_000 }),
  good({ typeID: 621, name: "Caracal", category: CATEGORY.SHIP, priceAnchor: 10_000_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 620, name: "Osprey", category: CATEGORY.SHIP, priceAnchor: 9_000_000, targetQuantity: 5, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 623, name: "Moa", category: CATEGORY.SHIP, priceAnchor: 11_000_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 632, name: "Blackbird", category: CATEGORY.SHIP, priceAnchor: 8_500_000, targetQuantity: 5, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 16238, name: "Cormorant", category: CATEGORY.SHIP, priceAnchor: 1_200_000, targetQuantity: 8, shipmentQuantity: 2, productionBatch: 1, volume: 5_000 }),
  good({ typeID: 16227, name: "Ferox", category: CATEGORY.SHIP, priceAnchor: 55_000_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 15_000 }),
  good({ typeID: 24698, name: "Drake", category: CATEGORY.SHIP, priceAnchor: 60_000_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 15_000 }),
  good({ typeID: 638, name: "Raven", category: CATEGORY.SHIP, priceAnchor: 180_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 50_000 }),
  good({ typeID: 24688, name: "Rokh", category: CATEGORY.SHIP, priceAnchor: 190_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 50_000 }),
  good({ typeID: 17478, name: "Retriever", category: CATEGORY.SHIP, priceAnchor: 25_000_000, targetQuantity: 4, shipmentQuantity: 1, productionBatch: 1, volume: 3_750 }),
  // ORE industrial hulls use conservative static base values. Targets stay
  // deliberately tiny so the NPC economy must replace losses through industry
  // and logistics rather than keeping an effectively infinite reserve.
  good({ typeID: 42244, name: "Porpoise", category: CATEGORY.SHIP, priceAnchor: 64_700_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 400_000 }),
  good({ typeID: 28606, name: "Orca", category: CATEGORY.SHIP, priceAnchor: 957_100_000, targetQuantity: 1, shipmentQuantity: 1, productionBatch: 1, volume: 10_250_000 }),
  good({ typeID: 22546, name: "Skiff", category: CATEGORY.SHIP, priceAnchor: 190_300_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 150_000 }),
  good({ typeID: 22548, name: "Mackinaw", category: CATEGORY.SHIP, priceAnchor: 190_300_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 150_000 }),
  good({ typeID: 22544, name: "Hulk", category: CATEGORY.SHIP, priceAnchor: 190_300_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 150_000 }),

  // Amarr T1 doctrine: laser platforms, crystals, armor repair and haulers.
  good({ typeID: 246, name: "Multifrequency S", category: CATEGORY.AMMO, priceAnchor: 1_000, targetQuantity: 200, shipmentQuantity: 60, productionBatch: 40, volume: 1 }),
  good({ typeID: 254, name: "Multifrequency M", category: CATEGORY.AMMO, priceAnchor: 5_000, targetQuantity: 120, shipmentQuantity: 40, productionBatch: 25, volume: 1 }),
  good({ typeID: 262, name: "Multifrequency L", category: CATEGORY.AMMO, priceAnchor: 25_000, targetQuantity: 60, shipmentQuantity: 20, productionBatch: 12, volume: 1 }),
  good({ typeID: 453, name: "Small Focused Pulse Laser I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 15_000, targetQuantity: 90, shipmentQuantity: 30, productionBatch: 30, volume: 5 }),
  good({ typeID: 458, name: "Heavy Pulse Laser I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 150_000, targetQuantity: 50, shipmentQuantity: 15, productionBatch: 10, volume: 25 }),
  good({ typeID: 462, name: "Mega Pulse Laser I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 1_200_000, targetQuantity: 24, shipmentQuantity: 8, productionBatch: 6, volume: 50 }),
  good({ typeID: 523, name: "Small Armor Repairer I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 20_000, targetQuantity: 60, shipmentQuantity: 20, productionBatch: 20, volume: 5 }),
  good({ typeID: 3528, name: "Medium Armor Repairer I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 150_000, targetQuantity: 40, shipmentQuantity: 15, productionBatch: 10, volume: 10 }),
  good({ typeID: 3538, name: "Large Armor Repairer I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 1_000_000, targetQuantity: 24, shipmentQuantity: 8, productionBatch: 6, volume: 50 }),
  good({ typeID: 589, name: "Executioner", category: CATEGORY.SHIP, priceAnchor: 400_000, targetQuantity: 10, shipmentQuantity: 2, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 597, name: "Punisher", category: CATEGORY.SHIP, priceAnchor: 420_000, targetQuantity: 10, shipmentQuantity: 2, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 16236, name: "Coercer", category: CATEGORY.SHIP, priceAnchor: 1_200_000, targetQuantity: 8, shipmentQuantity: 2, productionBatch: 1, volume: 5_000 }),
  good({ typeID: 2006, name: "Omen", category: CATEGORY.SHIP, priceAnchor: 10_000_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 624, name: "Maller", category: CATEGORY.SHIP, priceAnchor: 11_000_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 24696, name: "Harbinger", category: CATEGORY.SHIP, priceAnchor: 60_000_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 15_000 }),
  good({ typeID: 16233, name: "Prophecy", category: CATEGORY.SHIP, priceAnchor: 58_000_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 15_000 }),
  good({ typeID: 19744, name: "Sigil", category: CATEGORY.SHIP, priceAnchor: 1_100_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 20_000 }),
  good({ typeID: 1944, name: "Bestower", category: CATEGORY.SHIP, priceAnchor: 1_200_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 20_000 }),

  // Gallente T1 doctrine: hybrid weapons, drones and local hulls.
  good({ typeID: 593, name: "Tristan", category: CATEGORY.SHIP, priceAnchor: 420_000, targetQuantity: 10, shipmentQuantity: 2, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 594, name: "Incursus", category: CATEGORY.SHIP, priceAnchor: 400_000, targetQuantity: 10, shipmentQuantity: 2, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 16240, name: "Catalyst", category: CATEGORY.SHIP, priceAnchor: 1_200_000, targetQuantity: 8, shipmentQuantity: 2, productionBatch: 1, volume: 5_000 }),
  good({ typeID: 626, name: "Vexor", category: CATEGORY.SHIP, priceAnchor: 10_500_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 627, name: "Thorax", category: CATEGORY.SHIP, priceAnchor: 10_500_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 24700, name: "Myrmidon", category: CATEGORY.SHIP, priceAnchor: 60_000_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 15_000 }),
  good({ typeID: 16229, name: "Brutix", category: CATEGORY.SHIP, priceAnchor: 58_000_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 15_000 }),
  good({ typeID: 650, name: "Nereus", category: CATEGORY.SHIP, priceAnchor: 1_100_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 20_000 }),
  good({ typeID: 657, name: "Iteron Mark V", category: CATEGORY.SHIP, priceAnchor: 1_300_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 20_000 }),

  // Minmatar T1 doctrine: projectile weapons, ammunition and fast hulls.
  good({ typeID: 185, name: "EMP S", category: CATEGORY.AMMO, priceAnchor: 14, targetQuantity: 30_000, shipmentQuantity: 12_000, productionBatch: 12_000, volume: 0.0025 }),
  good({ typeID: 193, name: "EMP M", category: CATEGORY.AMMO, priceAnchor: 58, targetQuantity: 18_000, shipmentQuantity: 6_000, productionBatch: 6_000, volume: 0.0125 }),
  good({ typeID: 201, name: "EMP L", category: CATEGORY.AMMO, priceAnchor: 210, targetQuantity: 6_000, shipmentQuantity: 2_000, productionBatch: 2_000, volume: 0.025 }),
  good({ typeID: 486, name: "200mm AutoCannon I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 18_000, targetQuantity: 90, shipmentQuantity: 30, productionBatch: 30, volume: 5 }),
  good({ typeID: 491, name: "425mm AutoCannon I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 110_000, targetQuantity: 50, shipmentQuantity: 15, productionBatch: 10, volume: 10 }),
  good({ typeID: 496, name: "800mm Repeating Cannon I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 1_100_000, targetQuantity: 24, shipmentQuantity: 8, productionBatch: 6, volume: 25 }),
  good({ typeID: 585, name: "Slasher", category: CATEGORY.SHIP, priceAnchor: 400_000, targetQuantity: 10, shipmentQuantity: 2, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 587, name: "Rifter", category: CATEGORY.SHIP, priceAnchor: 420_000, targetQuantity: 10, shipmentQuantity: 2, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 16242, name: "Thrasher", category: CATEGORY.SHIP, priceAnchor: 1_200_000, targetQuantity: 8, shipmentQuantity: 2, productionBatch: 1, volume: 5_000 }),
  good({ typeID: 622, name: "Stabber", category: CATEGORY.SHIP, priceAnchor: 10_000_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 629, name: "Rupture", category: CATEGORY.SHIP, priceAnchor: 10_500_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 16231, name: "Cyclone", category: CATEGORY.SHIP, priceAnchor: 58_000_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 15_000 }),
  good({ typeID: 24702, name: "Hurricane", category: CATEGORY.SHIP, priceAnchor: 60_000_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 15_000 }),
  good({ typeID: 653, name: "Wreathe", category: CATEGORY.SHIP, priceAnchor: 1_100_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 20_000 }),
  good({ typeID: 652, name: "Mammoth", category: CATEGORY.SHIP, priceAnchor: 1_300_000, targetQuantity: 6, shipmentQuantity: 1, productionBatch: 1, volume: 20_000 }),

  // Regional traffic and combat replacement stock. T2 transports and
  // freighters intentionally have low targets so losses remain economically
  // meaningful rather than being replaced from an infinite service pool.
  good({ typeID: 1319, name: "Expanded Cargohold II", category: CATEGORY.FREIGHT_MODULE, priceAnchor: 850_000, targetQuantity: 20, shipmentQuantity: 5, productionBatch: 2, volume: 5 }),
  good({ typeID: 1333, name: "Reinforced Bulkheads I", category: CATEGORY.FREIGHT_MODULE, priceAnchor: 35_000, targetQuantity: 40, shipmentQuantity: 10, productionBatch: 8, volume: 5 }),
  good({ typeID: 11267, name: "Multispectrum Energized Membrane I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 45_000, targetQuantity: 40, shipmentQuantity: 10, productionBatch: 8, volume: 5 }),
  good({ typeID: 578, name: "Multispectrum Shield Hardener I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 85_000, targetQuantity: 40, shipmentQuantity: 10, productionBatch: 8, volume: 5 }),
  good({ typeID: 10836, name: "Medium Shield Booster I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 95_000, targetQuantity: 40, shipmentQuantity: 10, productionBatch: 8, volume: 10 }),
  good({ typeID: 520, name: "Gyrostabilizer I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 31_000, targetQuantity: 40, shipmentQuantity: 10, productionBatch: 8, volume: 5 }),
  good({ typeID: 2363, name: "Heat Sink I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 31_000, targetQuantity: 40, shipmentQuantity: 10, productionBatch: 8, volume: 5 }),
  good({ typeID: 11357, name: "Medium Remote Armor Repairer I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 125_000, targetQuantity: 24, shipmentQuantity: 8, productionBatch: 6, volume: 10 }),
  good({ typeID: 3242, name: "Warp Disruptor I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 115_000, targetQuantity: 30, shipmentQuantity: 10, productionBatch: 8, volume: 5 }),
  good({ typeID: 12265, name: "Medium Energy Neutralizer I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 180_000, targetQuantity: 24, shipmentQuantity: 8, productionBatch: 6, volume: 10 }),
  good({ typeID: 533, name: "Small Energy Neutralizer I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 35_000, targetQuantity: 30, shipmentQuantity: 10, productionBatch: 8, volume: 5 }),
  good({ typeID: 11355, name: "Small Remote Armor Repairer I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 45_000, targetQuantity: 30, shipmentQuantity: 10, productionBatch: 8, volume: 5 }),
  good({ typeID: 3586, name: "Small Remote Shield Booster I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 45_000, targetQuantity: 30, shipmentQuantity: 10, productionBatch: 8, volume: 5 }),
  good({ typeID: 2108, name: "Tracking Disruptor I", category: CATEGORY.COMBAT_MODULE, priceAnchor: 80_000, targetQuantity: 30, shipmentQuantity: 10, productionBatch: 8, volume: 5 }),
  good({ typeID: 588, name: "Minmatar Shuttle", category: CATEGORY.SHIP, priceAnchor: 25_000, targetQuantity: 12, shipmentQuantity: 4, productionBatch: 1, volume: 500 }),
  good({ typeID: 596, name: "Amarr Shuttle", category: CATEGORY.SHIP, priceAnchor: 25_000, targetQuantity: 12, shipmentQuantity: 4, productionBatch: 1, volume: 500 }),
  good({ typeID: 11129, name: "Gallente Shuttle", category: CATEGORY.SHIP, priceAnchor: 25_000, targetQuantity: 12, shipmentQuantity: 4, productionBatch: 1, volume: 500 }),
  good({ typeID: 672, name: "Caldari Shuttle", category: CATEGORY.SHIP, priceAnchor: 25_000, targetQuantity: 12, shipmentQuantity: 4, productionBatch: 1, volume: 500 }),
  good({ typeID: 625, name: "Augoror", category: CATEGORY.SHIP, priceAnchor: 9_000_000, targetQuantity: 5, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 634, name: "Exequror", category: CATEGORY.SHIP, priceAnchor: 9_000_000, targetQuantity: 5, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 631, name: "Scythe", category: CATEGORY.SHIP, priceAnchor: 9_000_000, targetQuantity: 5, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 642, name: "Apocalypse", category: CATEGORY.SHIP, priceAnchor: 190_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 50_000 }),
  good({ typeID: 24692, name: "Abaddon", category: CATEGORY.SHIP, priceAnchor: 200_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 50_000 }),
  good({ typeID: 641, name: "Megathron", category: CATEGORY.SHIP, priceAnchor: 190_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 50_000 }),
  good({ typeID: 24690, name: "Hyperion", category: CATEGORY.SHIP, priceAnchor: 200_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 50_000 }),
  good({ typeID: 639, name: "Tempest", category: CATEGORY.SHIP, priceAnchor: 190_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 50_000 }),
  good({ typeID: 24694, name: "Maelstrom", category: CATEGORY.SHIP, priceAnchor: 200_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 50_000 }),
  good({ typeID: 12731, name: "Bustard", category: CATEGORY.SHIP, priceAnchor: 125_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 20_000 }),
  good({ typeID: 20185, name: "Charon", category: CATEGORY.SHIP, priceAnchor: 1_600_000_000, targetQuantity: 1, shipmentQuantity: 1, productionBatch: 1, volume: 100_000 }),
  good({ typeID: 12735, name: "Prowler", category: CATEGORY.SHIP, priceAnchor: 110_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 20_000 }),
  good({ typeID: 20189, name: "Fenrir", category: CATEGORY.SHIP, priceAnchor: 1_600_000_000, targetQuantity: 1, shipmentQuantity: 1, productionBatch: 1, volume: 100_000 }),
  good({ typeID: 12753, name: "Impel", category: CATEGORY.SHIP, priceAnchor: 125_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 20_000 }),
  good({ typeID: 20183, name: "Providence", category: CATEGORY.SHIP, priceAnchor: 1_600_000_000, targetQuantity: 1, shipmentQuantity: 1, productionBatch: 1, volume: 100_000 }),
  good({ typeID: 12745, name: "Occator", category: CATEGORY.SHIP, priceAnchor: 125_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 20_000 }),
  good({ typeID: 20187, name: "Obelisk", category: CATEGORY.SHIP, priceAnchor: 1_600_000_000, targetQuantity: 1, shipmentQuantity: 1, productionBatch: 1, volume: 100_000 }),

  // Pirate-faction combat hulls. Their replacement hulls are assembled only at
  // faction-owned nullsec stations; logistics still uses captured/imported
  // empire industrials because these factions do not field native hauler lines.
  good({ typeID: 17930, name: "Worm", category: CATEGORY.SHIP, priceAnchor: 70_000_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 17715, name: "Gila", category: CATEGORY.SHIP, priceAnchor: 220_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 17918, name: "Rattlesnake", category: CATEGORY.SHIP, priceAnchor: 900_000_000, targetQuantity: 1, shipmentQuantity: 1, productionBatch: 1, volume: 50_000 }),
  good({ typeID: 17932, name: "Dramiel", category: CATEGORY.SHIP, priceAnchor: 70_000_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 17720, name: "Cynabal", category: CATEGORY.SHIP, priceAnchor: 220_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 17738, name: "Machariel", category: CATEGORY.SHIP, priceAnchor: 900_000_000, targetQuantity: 1, shipmentQuantity: 1, productionBatch: 1, volume: 50_000 }),
  good({ typeID: 17926, name: "Cruor", category: CATEGORY.SHIP, priceAnchor: 70_000_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 17922, name: "Ashimmu", category: CATEGORY.SHIP, priceAnchor: 220_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 17920, name: "Bhaalgorn", category: CATEGORY.SHIP, priceAnchor: 900_000_000, targetQuantity: 1, shipmentQuantity: 1, productionBatch: 1, volume: 50_000 }),
  good({ typeID: 17924, name: "Succubus", category: CATEGORY.SHIP, priceAnchor: 70_000_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 17718, name: "Phantasm", category: CATEGORY.SHIP, priceAnchor: 220_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 17736, name: "Nightmare", category: CATEGORY.SHIP, priceAnchor: 900_000_000, targetQuantity: 1, shipmentQuantity: 1, productionBatch: 1, volume: 50_000 }),
  good({ typeID: 17928, name: "Daredevil", category: CATEGORY.SHIP, priceAnchor: 70_000_000, targetQuantity: 3, shipmentQuantity: 1, productionBatch: 1, volume: 2_500 }),
  good({ typeID: 17722, name: "Vigilant", category: CATEGORY.SHIP, priceAnchor: 220_000_000, targetQuantity: 2, shipmentQuantity: 1, productionBatch: 1, volume: 10_000 }),
  good({ typeID: 17740, name: "Vindicator", category: CATEGORY.SHIP, priceAnchor: 900_000_000, targetQuantity: 1, shipmentQuantity: 1, productionBatch: 1, volume: 50_000 }),

  good({ typeID: 16272, name: "Heavy Water", category: CATEGORY.ICE_PRODUCT, priceAnchor: 95, targetQuantity: 120_000, shipmentQuantity: 40_000, productionBatch: 0, volume: 0.4 }),
  good({ typeID: 16273, name: "Liquid Ozone", category: CATEGORY.ICE_PRODUCT, priceAnchor: 215, targetQuantity: 80_000, shipmentQuantity: 25_000, productionBatch: 0, volume: 0.4 }),
  good({ typeID: 16275, name: "Strontium Clathrates", category: CATEGORY.ICE_PRODUCT, priceAnchor: 1_050, targetQuantity: 20_000, shipmentQuantity: 5_000, productionBatch: 0, volume: 3 }),
  good({ typeID: 17888, name: "Nitrogen Isotopes", category: CATEGORY.ICE_PRODUCT, priceAnchor: 620, targetQuantity: 160_000, shipmentQuantity: 50_000, productionBatch: 0, volume: 0.15 }),
]);

const PRODUCT_RACE_BY_TYPE_ID = new Map();
for (const [raceID, typeIDs] of Object.entries({
  // Caldari missiles, shields, electronic warfare and hulls.
  1: [
    203, 209, 210, 2464, 377, 399, 3829, 3839, 10838, 3596,
    499, 501, 13320, 12274, 1957,
    578, 10836, 12731, 20185, 17715, 17918, 17930,
    602, 603, 605, 620, 621, 623, 632, 648, 649, 672, 16227, 16238, 24688, 24698,
  ],
  // Minmatar projectiles and hulls.
  2: [
    185, 193, 201, 486, 491, 496, 520, 2486,
    585, 587, 588, 622, 629, 631, 639, 652, 653, 12735, 16231, 16242, 17720, 17738, 17932, 20189, 24694, 24702,
  ],
  // Amarr lasers, crystals, armor repair and hulls.
  4: [
    246, 254, 262, 453, 458, 462, 523, 533, 2108, 2363, 3528, 3538, 11267, 11355, 11357, 12265,
    589, 596, 597, 624, 625, 642, 1944, 2006, 12753, 17718, 17736, 17920, 17922, 17924, 17926, 19744, 20183, 16233, 16236, 24692, 24696,
  ],
  // Gallente hybrids, drones and hulls.
  8: [
    215, 218, 222, 230, 238, 2454, 10678, 12344, 12354, 9944,
    593, 594, 626, 627, 634, 641, 650, 657, 11129, 12745, 16229, 16240, 17722, 17740, 17928, 20187, 24690, 24700,
  ],
})) {
  for (const typeID of typeIDs) PRODUCT_RACE_BY_TYPE_ID.set(typeID, Number(raceID));
}

const RACE_SPECIALIZATION_NAMES = Object.freeze({
  1: "Caldari missiles, shields, electronic warfare and hulls",
  2: "Minmatar projectiles, mobility and hulls",
  4: "Amarr lasers, crystals, armor repair and hulls",
  8: "Gallente hybrids, drones and hulls",
});

// Raw inputs are bought by funded NPC corporations and may also be carried by
// living-universe haulers. They are intentionally limited to common early-game
// ores, ordinary salvage and scrap so this demand does not short-circuit the T2
// economy before invention/manufacturing consume those materials.
const PROCUREMENT_GOODS = Object.freeze([
  good({ typeID: 1230, name: "Veldspar", category: CATEGORY.ORE, priceAnchor: 10, targetQuantity: 2_000_000, shipmentQuantity: 250_000, productionBatch: 0, volume: 0.1 }),
  good({ typeID: 1228, name: "Scordite", category: CATEGORY.ORE, priceAnchor: 24, targetQuantity: 1_000_000, shipmentQuantity: 125_000, productionBatch: 0, volume: 0.15 }),
  good({ typeID: 1224, name: "Pyroxeres", category: CATEGORY.ORE, priceAnchor: 55, targetQuantity: 500_000, shipmentQuantity: 75_000, productionBatch: 0, volume: 0.3 }),
  good({ typeID: 18, name: "Plagioclase", category: CATEGORY.ORE, priceAnchor: 70, targetQuantity: 400_000, shipmentQuantity: 60_000, productionBatch: 0, volume: 0.35 }),
  good({ typeID: 1227, name: "Omber", category: CATEGORY.ORE, priceAnchor: 100, targetQuantity: 250_000, shipmentQuantity: 40_000, productionBatch: 0, volume: 0.6 }),
  good({ typeID: 20, name: "Kernite", category: CATEGORY.ORE, priceAnchor: 300, targetQuantity: 150_000, shipmentQuantity: 25_000, productionBatch: 0, volume: 1.2 }),
  good({ typeID: 25588, name: "Scorched Telemetry Processor", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25589, name: "Malfunctioning Shield Emitter", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25590, name: "Contaminated Nanite Compound", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25591, name: "Contaminated Lorentz Fluid", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25592, name: "Defective Current Pump", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25593, name: "Smashed Trigger Unit", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25594, name: "Tangled Power Conduit", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25595, name: "Alloyed Tritanium Bar", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25596, name: "Broken Drone Transceiver", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25597, name: "Damaged Artificial Neural Network", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25598, name: "Tripped Power Circuit", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25599, name: "Charred Micro Circuit", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25600, name: "Burned Logic Circuit", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25601, name: "Fried Interface Circuit", category: CATEGORY.SALVAGE, priceAnchor: 1_000, targetQuantity: 2_500, shipmentQuantity: 500, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25602, name: "Thruster Console", category: CATEGORY.SALVAGE, priceAnchor: 2_500, targetQuantity: 1_500, shipmentQuantity: 300, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25603, name: "Melted Capacitor Console", category: CATEGORY.SALVAGE, priceAnchor: 2_500, targetQuantity: 1_500, shipmentQuantity: 300, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25604, name: "Conductive Polymer", category: CATEGORY.SALVAGE, priceAnchor: 2_500, targetQuantity: 1_500, shipmentQuantity: 300, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25605, name: "Armor Plates", category: CATEGORY.SALVAGE, priceAnchor: 2_500, targetQuantity: 1_500, shipmentQuantity: 300, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25606, name: "Ward Console", category: CATEGORY.SALVAGE, priceAnchor: 2_500, targetQuantity: 1_500, shipmentQuantity: 300, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25607, name: "Telemetry Processor", category: CATEGORY.SALVAGE, priceAnchor: 25_000, targetQuantity: 500, shipmentQuantity: 100, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25608, name: "Intact Shield Emitter", category: CATEGORY.SALVAGE, priceAnchor: 25_000, targetQuantity: 500, shipmentQuantity: 100, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25609, name: "Nanite Compound", category: CATEGORY.SALVAGE, priceAnchor: 25_000, targetQuantity: 500, shipmentQuantity: 100, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25611, name: "Current Pump", category: CATEGORY.SALVAGE, priceAnchor: 25_000, targetQuantity: 500, shipmentQuantity: 100, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25612, name: "Trigger Unit", category: CATEGORY.SALVAGE, priceAnchor: 25_000, targetQuantity: 500, shipmentQuantity: 100, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25613, name: "Power Conduit", category: CATEGORY.SALVAGE, priceAnchor: 25_000, targetQuantity: 500, shipmentQuantity: 100, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25614, name: "Single-crystal Superalloy I-beam", category: CATEGORY.SALVAGE, priceAnchor: 25_000, targetQuantity: 500, shipmentQuantity: 100, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25615, name: "Drone Transceiver", category: CATEGORY.SALVAGE, priceAnchor: 25_000, targetQuantity: 500, shipmentQuantity: 100, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25616, name: "Artificial Neural Network", category: CATEGORY.SALVAGE, priceAnchor: 25_000, targetQuantity: 500, shipmentQuantity: 100, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25617, name: "Power Circuit", category: CATEGORY.SALVAGE, priceAnchor: 25_000, targetQuantity: 500, shipmentQuantity: 100, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25622, name: "Capacitor Console", category: CATEGORY.SALVAGE, priceAnchor: 25_000, targetQuantity: 500, shipmentQuantity: 100, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25624, name: "Intact Armor Plates", category: CATEGORY.SALVAGE, priceAnchor: 25_000, targetQuantity: 500, shipmentQuantity: 100, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 25625, name: "Enhanced Ward Console", category: CATEGORY.SALVAGE, priceAnchor: 25_000, targetQuantity: 500, shipmentQuantity: 100, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 15331, name: "Metal Scraps", category: CATEGORY.SCRAP, priceAnchor: 20, targetQuantity: 20_000, shipmentQuantity: 5_000, productionBatch: 0, volume: 0.01 }),
  good({ typeID: 30497, name: "Reinforced Metal Scraps", category: CATEGORY.SCRAP, priceAnchor: 2_000, targetQuantity: 10_000, shipmentQuantity: 2_500, productionBatch: 0, volume: 0.01 }),
]);

const PROCUREMENT_INPUT_GOODS = Object.freeze([
  ...GOODS.filter((entry) => (
    entry.category === CATEGORY.LOW_MINERAL || entry.category === CATEGORY.HIGH_MINERAL
  )),
  ...PROCUREMENT_GOODS,
]);

const TRADE_GOODS = Object.freeze([...GOODS, ...PROCUREMENT_GOODS]);

// Pirate-faction hulls are assembled by their owning NPC factions in nullsec.
// They remain excluded from empire production: the faction mapping below is
// enforced by getProductProductionFactor, while industry consumes a governed
// mineral-value recipe rather than seeding a free replacement.
const PIRATE_FACTION_HULL_TYPE_IDS = Object.freeze([
  17930, 17715, 17918, // Guristas
  17932, 17720, 17738, // Angel Cartel
  17926, 17922, 17920, // Blood Raiders
  17924, 17718, 17736, // Sansha's Nation
  17928, 17722, 17740, // Serpentis
]);
const pirateFactionHullTypeIDs = new Set(PIRATE_FACTION_HULL_TYPE_IDS);
const PIRATE_FACTION_BY_HULL_TYPE_ID = Object.freeze({
  17930: 500010,
  17715: 500010,
  17918: 500010,
  17932: 500011,
  17720: 500011,
  17738: 500011,
  17926: 500012,
  17922: 500012,
  17920: 500012,
  17924: 500019,
  17718: 500019,
  17736: 500019,
  17928: 500020,
  17722: 500020,
  17740: 500020,
});

function station(spec) {
  return Object.freeze({
    initialFillRatio: 0.12,
    hubTier: "local",
    ...spec,
    demand: Object.freeze(spec.demand || {}),
    production: Object.freeze(spec.production || {}),
  });
}

const ALL_MANUFACTURED_DEMAND = Object.freeze({
  [CATEGORY.AMMO]: 1,
  [CATEGORY.DRONE]: 1,
  [CATEGORY.COMBAT_MODULE]: 1,
  [CATEGORY.FREIGHT_MODULE]: 1,
  [CATEGORY.MINING_MODULE]: 1,
  [CATEGORY.EXPLORATION]: 1,
  [CATEGORY.REPAIR]: 1,
  [CATEGORY.SHIP]: 1,
});

const AUTHORED_STATIONS = Object.freeze([
  station({
    stationID: 60003760,
    systemID: 30000142,
    name: "Jita IV-4 Caldari Navy Assembly Plant",
    archetype: "regional_hub",
    hubTier: "regional",
    initialFillRatio: 0.25,
    demand: {
      [CATEGORY.LOW_MINERAL]: 2.5,
      [CATEGORY.HIGH_MINERAL]: 2.5,
      [CATEGORY.ICE_PRODUCT]: 2,
      [CATEGORY.ORE]: 2.5,
      [CATEGORY.SALVAGE]: 2,
      [CATEGORY.SCRAP]: 2,
      ...Object.fromEntries(Object.entries(ALL_MANUFACTURED_DEMAND).map(([key]) => [key, 2])),
      [CATEGORY.STRUCTURE_COMPONENT]: 1,
      [CATEGORY.STRUCTURE_SERVICE]: 1,
    },
    production: {
      [CATEGORY.AMMO]: 1.5,
      [CATEGORY.DRONE]: 1.5,
      [CATEGORY.COMBAT_MODULE]: 1.25,
      [CATEGORY.FREIGHT_MODULE]: 1.5,
      [CATEGORY.EXPLORATION]: 1,
      [CATEGORY.REPAIR]: 1,
      [CATEGORY.SHIP]: 0.5,
      [CATEGORY.STRUCTURE_COMPONENT]: 1,
      [CATEGORY.STRUCTURE_SERVICE]: 1,
    },
  }),
  station({
    stationID: 60003763,
    systemID: 30000140,
    name: "Maurasi IX-12 Caldari Navy Assembly Plant",
    archetype: "assembly_plant",
    demand: { [CATEGORY.AMMO]: 1, [CATEGORY.DRONE]: 1, [CATEGORY.COMBAT_MODULE]: 1, [CATEGORY.REPAIR]: 0.5 },
    production: { [CATEGORY.AMMO]: 1, [CATEGORY.DRONE]: 0.75, [CATEGORY.COMBAT_MODULE]: 0.75, [CATEGORY.SHIP]: 0.25 },
  }),
  station({
    stationID: 60003754,
    systemID: 30000144,
    name: "Perimeter II-1 Caldari Navy Assembly Plant",
    archetype: "transit_assembly",
    hubTier: "satellite",
    demand: { [CATEGORY.AMMO]: 0.75, [CATEGORY.COMBAT_MODULE]: 0.75, [CATEGORY.FREIGHT_MODULE]: 1.25, [CATEGORY.EXPLORATION]: 1, [CATEGORY.REPAIR]: 0.75 },
    production: { [CATEGORY.FREIGHT_MODULE]: 1, [CATEGORY.EXPLORATION]: 1, [CATEGORY.REPAIR]: 0.5 },
  }),
  station({
    stationID: 60000682,
    systemID: 30000145,
    name: "New Caldari IV-1 Poksu Mineral Reserve",
    archetype: "mineral_reserve",
    demand: { [CATEGORY.LOW_MINERAL]: 1, [CATEGORY.MINING_MODULE]: 1, [CATEGORY.FREIGHT_MODULE]: 0.5, [CATEGORY.EXPLORATION]: 0.5, [CATEGORY.ORE]: 1, [CATEGORY.SALVAGE]: 0.5, [CATEGORY.SCRAP]: 0.75 },
    production: { [CATEGORY.LOW_MINERAL]: 1.5, [CATEGORY.MINING_MODULE]: 0.5 },
  }),
  station({
    stationID: 60000763,
    systemID: 30001363,
    name: "Sobaseki XIII-3 Poksu Mineral Reserve",
    archetype: "mineral_reserve",
    demand: { [CATEGORY.LOW_MINERAL]: 1, [CATEGORY.MINING_MODULE]: 1, [CATEGORY.FREIGHT_MODULE]: 0.5, [CATEGORY.ORE]: 1, [CATEGORY.SALVAGE]: 0.5, [CATEGORY.SCRAP]: 0.75 },
    production: { [CATEGORY.LOW_MINERAL]: 1.25, [CATEGORY.MINING_MODULE]: 0.5 },
  }),
  station({
    stationID: 60000004,
    systemID: 30002780,
    name: "Muvolailen X-3 CBD Storage",
    archetype: "commercial_storage",
    demand: { [CATEGORY.LOW_MINERAL]: 0.5, [CATEGORY.FREIGHT_MODULE]: 1.25, [CATEGORY.EXPLORATION]: 1, [CATEGORY.REPAIR]: 0.5 },
  }),
  station({
    stationID: 60000454,
    systemID: 30000143,
    name: "Niyabainen VIII-16 Hyasyoda Mineral Reserve",
    archetype: "mineral_reserve",
    demand: { [CATEGORY.LOW_MINERAL]: 1, [CATEGORY.MINING_MODULE]: 1, [CATEGORY.FREIGHT_MODULE]: 0.5, [CATEGORY.ORE]: 0.75, [CATEGORY.SALVAGE]: 0.4, [CATEGORY.SCRAP]: 0.6 },
    production: { [CATEGORY.LOW_MINERAL]: 1, [CATEGORY.MINING_MODULE]: 0.5 },
  }),
  station({
    stationID: 60000394,
    systemID: 30000138,
    name: "Ikuchi VI-15 Ytiri Storage",
    archetype: "commercial_storage",
    demand: { [CATEGORY.LOW_MINERAL]: 0.5, [CATEGORY.FREIGHT_MODULE]: 1.25, [CATEGORY.EXPLORATION]: 0.75, [CATEGORY.REPAIR]: 0.5 },
  }),
  station({
    stationID: 60000376,
    systemID: 30001376,
    name: "Nourvukaiken VII-18 Ytiri Storage",
    archetype: "border_logistics",
    hubTier: "border",
    demand: { [CATEGORY.AMMO]: 1, [CATEGORY.DRONE]: 0.5, [CATEGORY.COMBAT_MODULE]: 1, [CATEGORY.FREIGHT_MODULE]: 1, [CATEGORY.REPAIR]: 1 },
  }),
  station({
    stationID: 60005203,
    systemID: 30002813,
    name: "Tama VII-9 Republic Security Services Testing Facilities",
    archetype: "lowsec_boundary",
    hubTier: "frontier",
    demand: { [CATEGORY.HIGH_MINERAL]: 0.75, [CATEGORY.AMMO]: 1.5, [CATEGORY.DRONE]: 1, [CATEGORY.COMBAT_MODULE]: 1.5, [CATEGORY.REPAIR]: 1.5 },
    production: { [CATEGORY.HIGH_MINERAL]: 1.5 },
  }),
  station({
    stationID: 60000880,
    systemID: 30002781,
    name: "Halaima VII-6 Caldari Provisions Warehouse",
    archetype: "ice_logistics",
    hubTier: "resource",
    initialFillRatio: 0,
    demand: {
      [CATEGORY.MINING_MODULE]: 1,
      [CATEGORY.FREIGHT_MODULE]: 1,
      [CATEGORY.REPAIR]: 0.5,
    },
  }),
]);

function inferRegionalDemand(stationRow) {
  const label = String(stationRow && stationRow.stationName || "").toLowerCase();
  const industrial = /assembly|factory|production|manufactur|mineral reserve/.test(label);
  const logistics = /storage|warehouse|logistic|distribution|trading/.test(label);
  const military = /navy|security|tribunal|academy/.test(label);
  return {
    [CATEGORY.LOW_MINERAL]: industrial ? 0.8 : 0.25,
    [CATEGORY.HIGH_MINERAL]: industrial ? 0.45 : 0.12,
    [CATEGORY.AMMO]: military ? 0.55 : 0.2,
    [CATEGORY.DRONE]: industrial ? 0.3 : 0.1,
    [CATEGORY.COMBAT_MODULE]: military ? 0.5 : 0.15,
    [CATEGORY.FREIGHT_MODULE]: logistics ? 0.55 : 0.15,
    [CATEGORY.MINING_MODULE]: industrial ? 0.4 : 0.1,
    [CATEGORY.EXPLORATION]: 0.1,
    [CATEGORY.REPAIR]: military || logistics ? 0.35 : 0.15,
    [CATEGORY.SHIP]: industrial || military ? 0.08 : 0.02,
    [CATEGORY.ICE_PRODUCT]: industrial ? 0.25 : 0.08,
    [CATEGORY.ORE]: industrial ? 0.75 : 0,
    [CATEGORY.SALVAGE]: industrial ? 0.45 : 0.1,
    [CATEGORY.SCRAP]: industrial ? 0.6 : 0.15,
  };
}

function inferRegionalProduction(stationRow) {
  const label = String(stationRow && stationRow.stationName || "").toLowerCase();
  if (!/assembly|factory|production|manufactur/.test(label)) {
    return {};
  }
  const base = {
    [CATEGORY.AMMO]: 0.35,
    [CATEGORY.DRONE]: 0.25,
    [CATEGORY.COMBAT_MODULE]: 0.2,
    [CATEGORY.FREIGHT_MODULE]: 0.25,
    [CATEGORY.MINING_MODULE]: 0.2,
    [CATEGORY.REPAIR]: 0.2,
    [CATEGORY.SHIP]: 0.08,
  };
  const regionID = Number(stationRow && stationRow.regionID) || 0;
  const regionalScale = regionID === 10000069 ? 0.25 : regionID === 10000016 ? 0.65 : 1;
  return Object.fromEntries(
    Object.entries(base).map(([category, multiplier]) => [category, multiplier * regionalScale]),
  );
}

function ensureRegionalHubProduction(production) {
  const minimums = {
    [CATEGORY.AMMO]: 0.5,
    [CATEGORY.DRONE]: 0.35,
    [CATEGORY.COMBAT_MODULE]: 0.3,
    [CATEGORY.FREIGHT_MODULE]: 0.35,
    [CATEGORY.MINING_MODULE]: 0.3,
    [CATEGORY.EXPLORATION]: 0.25,
    [CATEGORY.REPAIR]: 0.25,
    [CATEGORY.SHIP]: 0.12,
  };
  return Object.fromEntries(Object.entries(minimums).map(([category, minimum]) => [
    category,
    Math.max(Number(production && production[category]) || 0, minimum),
  ]));
}

function scoreRegionalStation(stationRow) {
  const label = String(stationRow && stationRow.stationName || "").toLowerCase();
  let score = 0;
  if (/assembly|factory|production|manufactur|mineral reserve/.test(label)) score += 6;
  if (/storage|warehouse|logistic|distribution|trading/.test(label)) score += 4;
  if (/navy|security/.test(label)) score += 2;
  return score - ((Number(stationRow && stationRow.stationID) || 0) / 1e12);
}

function buildRegionalStations() {
  const stationRows = worldData.getStations()
    .filter((row) => (
      Number(row && row.regionID) > 0 &&
      Number(row && row.solarSystemID) > 0 &&
      !EXCLUDED_ECONOMY_REGION_IDS.has(Number(row.regionID))
    ));
  const majorHubStationIDSet = new Set(MAJOR_HUB_STATION_IDS);
  const stationsByRegionID = new Map();
  const stationCountBySystemID = new Map();
  const raceCountsByRegionID = new Map();
  for (const row of stationRows) {
    const regionID = Number(row.regionID);
    const systemID = Number(row.solarSystemID);
    if (!stationsByRegionID.has(regionID)) stationsByRegionID.set(regionID, []);
    stationsByRegionID.get(regionID).push(row);
    stationCountBySystemID.set(systemID, (stationCountBySystemID.get(systemID) || 0) + 1);
    const raceID = Number(row.stationRaceID) || 0;
    if (!raceCountsByRegionID.has(regionID)) raceCountsByRegionID.set(regionID, new Map());
    const counts = raceCountsByRegionID.get(regionID);
    if (raceID > 0) counts.set(raceID, (counts.get(raceID) || 0) + 1);
  }
  const raceByRegionID = new Map([...raceCountsByRegionID].map(([regionID, counts]) => [
    regionID,
    [...counts].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0]?.[0] || 0,
  ]));
  const hubStationByRegionID = new Map();
  for (const [regionID, rows] of stationsByRegionID) {
    const explicit = rows.find((row) => majorHubStationIDSet.has(Number(row.stationID)));
    const selected = explicit || [...rows].sort((left, right) => {
      const leftScore = (stationCountBySystemID.get(Number(left.solarSystemID)) || 0) * 20 +
        scoreRegionalStation(left) + Math.max(0, Number(left.security) || 0);
      const rightScore = (stationCountBySystemID.get(Number(right.solarSystemID)) || 0) * 20 +
        scoreRegionalStation(right) + Math.max(0, Number(right.security) || 0);
      return rightScore - leftScore || Number(left.stationID) - Number(right.stationID);
    })[0];
    if (selected) hubStationByRegionID.set(regionID, selected);
  }
  const hubStationIDSet = new Set(
    [...hubStationByRegionID.values()].map((row) => Number(row.stationID)),
  );
  const hubSystemIDSet = new Set(
    [...hubStationByRegionID.values()].map((row) => Number(row.solarSystemID)),
  );
  const authoredBySystemID = new Map(AUTHORED_STATIONS.map((entry) => {
    const row = worldData.getStationByID(entry.stationID) || {};
    const regionHub = hubSystemIDSet.has(Number(entry.systemID));
    return [Number(entry.systemID), station({
      ...entry,
      corporationID: Number(entry.corporationID || row.corporationID || row.ownerID || 0),
      regionID: Number(entry.regionID || row.regionID) || 0,
      regionName: String(entry.regionName || row.regionName || "Unknown Region"),
      raceID: Number(entry.raceID || raceByRegionID.get(Number(entry.regionID || row.regionID)) || row.stationRaceID || 0),
      factionID: Number(entry.factionID || worldData.getSolarSystemByID(entry.systemID)?.factionID || 0),
      security: Number.isFinite(Number(entry.security)) ? Number(entry.security) : Number(row.security) || 0,
      seedBaseStock: regionHub,
    })];
  }));
  const candidatesBySystemID = new Map();
  for (const stationRow of stationRows) {
    const systemID = Number(stationRow.solarSystemID) || 0;
    const current = candidatesBySystemID.get(systemID);
    const isHub = hubStationIDSet.has(Number(stationRow.stationID));
    if (
      !current || isHub ||
      (!hubStationIDSet.has(Number(current.stationID)) &&
        scoreRegionalStation(stationRow) > scoreRegionalStation(current))
    ) {
      candidatesBySystemID.set(systemID, stationRow);
    }
  }
  const generated = [];
  for (const [systemID, stationRow] of candidatesBySystemID) {
    if (authoredBySystemID.has(systemID)) {
      continue;
    }
    const security = Number(stationRow.security) || 0;
    const regionalHub = hubStationIDSet.has(Number(stationRow.stationID));
    const inferredDemand = inferRegionalDemand(stationRow);
    const demand = regionalHub
      ? Object.fromEntries(Object.entries(inferredDemand).map(([category, multiplier]) => [
          category,
          Math.max(Number(multiplier) || 0, ALL_MANUFACTURED_DEMAND[category] ? 1.25 : 0.5),
        ]))
      : inferredDemand;
    const inferredProduction = inferRegionalProduction(stationRow);
    generated.push(station({
      stationID: Number(stationRow.stationID),
      systemID,
      corporationID: Number(stationRow.corporationID || stationRow.ownerID || 0),
      name: String(stationRow.stationName || stationRow.itemName || stationRow.stationID),
      archetype: regionalHub ? "regional_hub" : "regional_spoke",
      hubTier: regionalHub ? "regional" : security < 0.5 ? "frontier" : "local",
      regionID: Number(stationRow.regionID) || 0,
      regionName: String(stationRow.regionName || "Unknown Region"),
      raceID: Number(raceByRegionID.get(Number(stationRow.regionID)) || stationRow.stationRaceID || 0),
      factionID: Number(worldData.getSolarSystemByID(systemID)?.factionID || 0),
      security,
      initialFillRatio: regionalHub ? 0.2 : 0,
      seedBaseStock: regionalHub,
      generated: true,
      demand,
      production: regionalHub
        ? ensureRegionalHubProduction(inferredProduction)
        : inferredProduction,
    }));
  }
  return [...authoredBySystemID.values(), ...generated]
    .sort((left, right) => Number(left.stationID) - Number(right.stationID));
}

const STATIONS = Object.freeze(buildRegionalStations());
const ECONOMY_REGION_IDS = Object.freeze([
  ...new Set(STATIONS.map((entry) => Number(entry.regionID)).filter((regionID) => regionID > 0)),
].sort((left, right) => left - right));
const REGIONAL_HUBS = Object.freeze(
  STATIONS.filter((entry) => String(entry.hubTier || "") === "regional")
    .sort((left, right) => Number(left.regionID) - Number(right.regionID)),
);
const REGIONAL_SPECIALIZATIONS = Object.freeze(REGIONAL_HUBS.map((entry) => Object.freeze({
  regionID: entry.regionID,
  regionName: entry.regionName,
  hubStationID: entry.stationID,
  raceID: Number(entry.raceID) || 0,
  specialization: RACE_SPECIALIZATION_NAMES[Number(entry.raceID)] ||
    (entry.security <= 0 ? "frontier extraction, replacement demand and opportunistic industry" :
      "general trade, extraction and T1 industry"),
})));

const FREIGHT_ROUTES = Object.freeze([
  Object.freeze({ routeID: "jita_maurasi", endpointStationIDs: [60003760, 60003763], routeClass: "feeder", riskBand: "highsec", allowedLogisticsClasses: ["feeder", "regional", "bulk", "secure"] }),
  Object.freeze({ routeID: "jita_perimeter", endpointStationIDs: [60003760, 60003754], routeClass: "trunk", riskBand: "highsec", allowedLogisticsClasses: ["regional", "bulk", "trunk", "secure"] }),
  Object.freeze({ routeID: "jita_new_caldari", endpointStationIDs: [60003760, 60000682], routeClass: "bulk", riskBand: "highsec", allowedLogisticsClasses: ["regional", "bulk", "trunk", "secure"] }),
  Object.freeze({ routeID: "jita_sobaseki", endpointStationIDs: [60003760, 60000763], routeClass: "bulk", riskBand: "highsec", allowedLogisticsClasses: ["regional", "bulk", "trunk", "secure"] }),
  Object.freeze({ routeID: "jita_muvolailen", endpointStationIDs: [60003760, 60000004], routeClass: "regional", riskBand: "highsec", allowedLogisticsClasses: ["feeder", "regional", "bulk", "secure"] }),
  Object.freeze({ routeID: "jita_niyabainen", endpointStationIDs: [60003760, 60000454], routeClass: "bulk", riskBand: "highsec", allowedLogisticsClasses: ["regional", "bulk", "trunk", "secure"] }),
  Object.freeze({ routeID: "jita_ikuchi", endpointStationIDs: [60003760, 60000394], routeClass: "regional", riskBand: "highsec", allowedLogisticsClasses: ["feeder", "regional", "bulk", "secure"] }),
  Object.freeze({ routeID: "jita_nourvukaiken", endpointStationIDs: [60003760, 60000376], routeClass: "regional", riskBand: "highsec", allowedLogisticsClasses: ["regional", "bulk", "secure"] }),
  Object.freeze({ routeID: "jita_halaima", endpointStationIDs: [60003760, 60000880], routeClass: "bulk", riskBand: "highsec", allowedLogisticsClasses: ["bulk", "trunk", "secure"] }),
  Object.freeze({ routeID: "jita_tama", endpointStationIDs: [60003760, 60005203], routeClass: "frontier", riskBand: "lowsec", allowedLogisticsClasses: ["secure"] }),
]);

const stationsByID = new Map(STATIONS.map((entry) => [entry.stationID, entry]));
const goodsByTypeID = new Map(TRADE_GOODS.map((entry) => [entry.typeID, entry]));
const routesByID = new Map(FREIGHT_ROUTES.map((entry) => [entry.routeID, entry]));
const stationsBySystemID = new Map(STATIONS.map((entry) => [entry.systemID, entry]));

function getDemandMultiplier(stationEntry, category) {
  return Math.max(0, Number(stationEntry && stationEntry.demand && stationEntry.demand[category]) || 0);
}

function getProductionMultiplier(stationEntry, category) {
  return Math.max(0, Number(stationEntry && stationEntry.production && stationEntry.production[category]) || 0);
}

function getProductRaceID(goodEntry) {
  return PRODUCT_RACE_BY_TYPE_ID.get(Number(goodEntry && goodEntry.typeID)) || 0;
}

function getProductDemandFactor(stationEntry, goodEntry) {
  const productRaceID = getProductRaceID(goodEntry);
  if (!productRaceID) return 1;
  return Number(stationEntry && stationEntry.raceID) === productRaceID ? 0.75 : 1.1;
}

function getProductProductionFactor(stationEntry, goodEntry) {
  const pirateFactionID = getPirateFactionID(goodEntry);
  if (pirateFactionID > 0) {
    // Faction hulls are assembled only by their owning pirate faction in its
    // NPC nullsec stations. This keeps a replacement economically reachable
    // without allowing an empire factory to manufacture pirate hulls.
    if (
      Number(stationEntry && stationEntry.factionID) !== pirateFactionID ||
      Number(stationEntry && stationEntry.security) > 0
    ) {
      return 0;
    }
    return String(stationEntry && stationEntry.hubTier || "") === "regional" ? 1.5 : 1;
  }
  const productRaceID = getProductRaceID(goodEntry);
  if (!productRaceID) {
    const industrialRegion = Number(stationEntry && stationEntry.regionID) === 10000057;
    if (industrialRegion && [CATEGORY.MINING_MODULE, CATEGORY.FREIGHT_MODULE].includes(goodEntry && goodEntry.category)) {
      return 2.25;
    }
    return 1;
  }
  if (Number(stationEntry && stationEntry.raceID) !== productRaceID) return 0;
  return String(stationEntry && stationEntry.hubTier || "") === "regional" ? 2.25 : 1.5;
}

function getTargetQuantity(stationEntry, goodEntry) {
  const multiplier = getDemandMultiplier(stationEntry, goodEntry && goodEntry.category);
  const demandFactor = getProductDemandFactor(stationEntry, goodEntry);
  return Math.max(0, Math.round((goodEntry && goodEntry.targetQuantity || 0) * multiplier * demandFactor));
}

function getProducerCeiling(stationEntry, goodEntry) {
  const multiplier = getProductionMultiplier(stationEntry, goodEntry && goodEntry.category) *
    getProductProductionFactor(stationEntry, goodEntry);
  if (multiplier <= 0) {
    return 0;
  }
  const target = getTargetQuantity(stationEntry, goodEntry);
  const batch = Math.max(1, Math.round((goodEntry && goodEntry.productionBatch || 1) * multiplier));
  return Math.max(Math.round(target * Math.max(1, multiplier)), batch * 3);
}

function getInitialQuantity(stationEntry, goodEntry) {
  if (stationEntry && stationEntry.seedBaseStock !== true) {
    return 0;
  }
  // A reset seeds only raw industrial feedstock. Finished ammunition, modules,
  // drones and ships must come from the persistent NPC workforce.
  if (!isMineralGood(goodEntry)) return 0;
  const target = getTargetQuantity(stationEntry, goodEntry);
  if (target <= 0) {
    return 0;
  }
  return Math.max(1, Math.round(target * 0.8));
}

function getStation(stationID) {
  return stationsByID.get(Number(stationID)) || null;
}

function getStationForSystem(systemID) {
  return stationsBySystemID.get(Number(systemID)) || null;
}

function isMineralGood(goodEntry) {
  return Boolean(
    goodEntry &&
    (goodEntry.category === CATEGORY.LOW_MINERAL ||
      goodEntry.category === CATEGORY.HIGH_MINERAL),
  );
}

function isProcurementGood(goodEntry) {
  return Boolean(goodEntry && PROCUREMENT_INPUT_GOODS.some(
    (entry) => Number(entry.typeID) === Number(goodEntry.typeID),
  ));
}

function isPirateFactionHull(goodEntryOrTypeID) {
  const typeID = typeof goodEntryOrTypeID === "object"
    ? Number(goodEntryOrTypeID && goodEntryOrTypeID.typeID)
    : Number(goodEntryOrTypeID);
  return pirateFactionHullTypeIDs.has(typeID);
}

function getPirateFactionID(goodEntryOrTypeID) {
  const typeID = typeof goodEntryOrTypeID === "object"
    ? Number(goodEntryOrTypeID && goodEntryOrTypeID.typeID)
    : Number(goodEntryOrTypeID);
  return Number(PIRATE_FACTION_BY_HULL_TYPE_ID[typeID]) || 0;
}

let factionShipyardsByFactionID = null;

function getFactionShipyardStations(pirateFactionID, goodEntry = null) {
  // A faction's shipyards are its own catalog stations at security <= 0.
  // When a hull is supplied, producer-capable stations (the faction's
  // Assembly Plants, getProducerCeiling > 0) sort first: their stock keys
  // are already tracked by the cache bootstrap/reconcile set, and they are
  // the same stations the legacy assembly path used. Testing-facility
  // spokes with no ship production remain only as a fallback. Sorted by
  // stationID within each band for determinism; the first entry is the
  // primary shipyard.
  if (!factionShipyardsByFactionID) {
    factionShipyardsByFactionID = new Map();
    for (const stationEntry of STATIONS) {
      const factionID = Number(stationEntry && stationEntry.factionID) || 0;
      if (
        !Object.values(PIRATE_FACTION_BY_HULL_TYPE_ID).includes(factionID) ||
        Number(stationEntry && stationEntry.security) > 0
      ) {
        continue;
      }
      if (!factionShipyardsByFactionID.has(factionID)) {
        factionShipyardsByFactionID.set(factionID, []);
      }
      factionShipyardsByFactionID.get(factionID).push(stationEntry);
    }
    for (const stations of factionShipyardsByFactionID.values()) {
      stations.sort((left, right) => Number(left.stationID) - Number(right.stationID));
    }
  }
  const stations = factionShipyardsByFactionID.get(Number(pirateFactionID) || 0) || [];
  if (!goodEntry) return stations;
  return [...stations].sort((left, right) => (
    Number(getProducerCeiling(right, goodEntry) > 0) -
      Number(getProducerCeiling(left, goodEntry) > 0) ||
    Number(left.stationID) - Number(right.stationID)
  ));
}

function getGood(typeID) {
  return goodsByTypeID.get(Number(typeID)) || null;
}

function getRoute(routeID) {
  return routesByID.get(String(routeID || "")) || null;
}

module.exports = {
  CATEGORY,
  PILOT_REGION_ID,
  PILOT_REGION_IDS,
  ECONOMY_REGION_IDS,
  REGIONAL_HUBS,
  REGIONAL_SPECIALIZATIONS,
  GOODS,
  PROCUREMENT_GOODS,
  PROCUREMENT_INPUT_GOODS,
  TRADE_GOODS,
  PIRATE_FACTION_HULL_TYPE_IDS,
  PIRATE_FACTION_BY_HULL_TYPE_ID,
  STATIONS,
  FREIGHT_ROUTES,
  getDemandMultiplier,
  getProductionMultiplier,
  getProductDemandFactor,
  getProductProductionFactor,
  getProductRaceID,
  getTargetQuantity,
  getProducerCeiling,
  getInitialQuantity,
  getStation,
  getStationForSystem,
  isMineralGood,
  isProcurementGood,
  isPirateFactionHull,
  getPirateFactionID,
  getFactionShipyardStations,
  getGood,
  getRoute,
};
