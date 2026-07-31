const NPC_TABLE = Object.freeze({
  PROFILES: "npcProfiles",
  LOADOUTS: "npcLoadouts",
  LOOT_TABLES: "npcLootTables",
  SPAWN_GROUPS: "npcSpawnGroups",
});

const {
  CARGO_PROFILES,
  TRAFFIC_DOCTRINES,
  TRAFFIC_LOOT_TABLES,
} = require("../governance/trafficDoctrineCatalog");
const {
  REGIONAL_SPAWN_GROUP_DEFINITIONS,
  REGIONAL_TRAFFIC_DOCTRINES,
} = require("../governance/regionalTrafficDoctrineCatalog");

const ALL_TRAFFIC_DOCTRINES = Object.freeze([
  ...TRAFFIC_DOCTRINES,
  ...REGIONAL_TRAFFIC_DOCTRINES,
]);

const PASSIVE_BEHAVIOR_PROFILE_ID = "npc_passive_idle";
const CALDARI_STATE_FACTION_ID = 500001;
const CALDARI_NAVY_CORPORATION_ID = 1000035;

const AMBIENT_TRAFFIC_HAULER_LOADOUT_ID = "ambient_caldari_convoy_hauler_governed_v1";
const AMBIENT_TRAFFIC_ESCORT_LOADOUT_ID = "ambient_caldari_convoy_escort_governed_v1";
const AMBIENT_TRAFFIC_HAULER_PROFILE_ID = "ambient_caldari_state_hauler";
const AMBIENT_TRAFFIC_ESCORT_PROFILE_ID = "ambient_caldari_convoy_escort";
const AMBIENT_TRAFFIC_SPAWN_GROUP_ID = "ambient_caldari_logistics_convoy";
const AMBIENT_TRAFFIC_HAULER_TYPE_ID = 10826;
const AMBIENT_TRAFFIC_ESCORT_TYPE_ID = 10999;
const LIVING_PROFILE_PREFIX = "living_jita_";
const LIVING_LOADOUT_PREFIX = "living_jita_loadout_";

const LIVING_UNIVERSE_GROUPS = Object.freeze({
  shuttle: "living_jita_shuttle_civilian",
  haulerCivilian: "living_jita_hauler_civilian",
  haulerStandard: "living_jita_hauler_standard",
  haulerBulk: "living_jita_hauler_bulk",
  haulerSecure: "living_jita_hauler_secure",
  haulerTrunk: "living_jita_hauler_trunk",
  convoyStandard: "living_jita_convoy_standard",
  convoyVeteran: "living_jita_convoy_veteran",
  convoySecure: "living_jita_convoy_secure_frontier",
  minerStandard: "living_jita_miner_wing_standard",
  minerVeteran: "living_jita_miner_wing_veteran",
  minerElite: "living_jita_miner_wing_elite",
  minerCorporate: "living_jita_miner_wing_corporate",
  minerLowsec: "living_jita_miner_wing_lowsec",
  minerIce: "living_jita_miner_wing_ice",
  policeStandard: "living_jita_police_patrol_standard",
  policeElite: "living_jita_police_patrol_elite",
  policeCommand: "living_jita_police_patrol_command",
  pirateStandard: "living_jita_pirate_gang_standard",
  pirateVeteran: "living_jita_pirate_gang_veteran",
  pirateElite: "living_jita_pirate_gang_elite",
  pirateCommand: "living_jita_pirate_gang_command",
});

function getLivingProfileID(doctrineID) {
  return `${LIVING_PROFILE_PREFIX}${String(doctrineID || "").trim()}`;
}

function getLivingLoadoutID(doctrineID) {
  return `${LIVING_LOADOUT_PREFIX}${String(doctrineID || "").trim()}`;
}

function buildLivingCargo(doctrine, role) {
  const cargo = role === "hauler"
    ? (CARGO_PROFILES.hauler || []).map((entry, index) => ({
        typeID: entry.typeID,
        quantity: Math.max(
          1,
          Math.trunc((Number(entry.minQuantity || 1) + Number(entry.maxQuantity || 1)) / 2),
        ),
        singleton: false,
        cargoPurpose: index === 0 ? "primary_manifest" : "trade_manifest",
      }))
    : [];
  for (const entry of Array.isArray(doctrine && doctrine.droneBay) ? doctrine.droneBay : []) {
    cargo.push({
      typeID: entry.typeID,
      quantity: Math.max(1, Math.trunc(Number(entry.quantity) || 1)),
      singleton: false,
      flagID: 87,
      cargoPurpose: "drone_bay",
    });
  }
  return cargo;
}

function buildLivingDoctrineRows() {
  const profiles = [];
  const loadouts = [];
  for (const doctrine of ALL_TRAFFIC_DOCTRINES) {
    const role = String(doctrine.role || "traffic");
    const pirate = role === "highsec_pirate";
    const police = role === "police";
    const miner = role === "miner";
    const industrial = miner || role === "mining_support";
    const corporationID = Number(doctrine.corporationID) ||
      (pirate ? 1000127 : (industrial ? 1000129 : CALDARI_NAVY_CORPORATION_ID));
    const factionID = Number(doctrine.factionID) ||
      (pirate ? 500010 : (industrial ? 500014 : CALDARI_STATE_FACTION_ID));
    const lootTableID = doctrine.recoveryPolicy && doctrine.recoveryPolicy.bonusLootTableID
      ? doctrine.recoveryPolicy.bonusLootTableID
      : null;
    const profileID = getLivingProfileID(doctrine.doctrineID);
    const loadoutID = getLivingLoadoutID(doctrine.doctrineID);
    profiles.push({
      profileID,
      name: `Living Universe ${role} (${doctrine.equipmentBand})`,
      description:
        "Governed player-hull NPC used by the persistent regional living-universe population.",
      aliases: [doctrine.doctrineID, `living ${role} ${doctrine.equipmentBand}`],
      entityType: "npc",
      shipTypeID: doctrine.shipTypeID,
      presentationTypeID: doctrine.shipTypeID,
      corporationID,
      allianceID: 0,
      factionID,
      raceID: Number(doctrine.raceID) || undefined,
      behaviorProfileID: pirate ? "npc_brawler" : PASSIVE_BEHAVIOR_PROFILE_ID,
      loadoutID,
      lootTableID,
      shipNameTemplate: String(doctrine.shipNameTemplate || "").trim() || (police
        ? "Caldari Navy Patrol"
        : pirate
          ? "Guristas Roamer"
          : industrial
            ? "Independent Mining Vessel"
            : role === "salvager"
              ? "Corporate Wreck Recovery"
              : role === "hauler"
              ? "Independent Freight Vessel"
              : role === "escort"
                ? "Corporate Escort"
                : "Independent Capsuleer Traffic"),
      securityStatus: pirate ? Number(doctrine.securityStatus || -2) : 0,
      bounty: pirate ? Math.max(1, Number(doctrine.bounty) || 75_000) : 0,
      spawnDistanceMeters: 20_000,
      preferredTargetMode: pirate ? "nearestPlayer" : "none",
      hardwareFamily: "sdeEntityNpc",
      hostileResponseThreshold: pirate ? 10 : -5,
      friendlyResponseThreshold: 5,
      miningRole: miner ? "miner" : undefined,
      livingUniverseTraffic: true,
    });
    loadouts.push({
      loadoutID,
      name: `Living Universe ${doctrine.doctrineID}`,
      modules: doctrine.modules || [],
      charges: doctrine.charges || [],
      cargo: buildLivingCargo(doctrine, role),
      governance: {
        enabled: true,
        doctrineID: doctrine.doctrineID,
        doctrineRevision: doctrine.doctrineRevision,
        role,
        equipmentBand: doctrine.equipmentBand,
        ...(doctrine.logisticsProfile ? { logisticsProfile: doctrine.logisticsProfile } : {}),
        ...(doctrine.miningProfile ? { miningProfile: doctrine.miningProfile } : {}),
        ...(doctrine.miningSupportProfile
          ? { miningSupportProfile: doctrine.miningSupportProfile }
          : {}),
        ...(Array.isArray(doctrine.pilotSkills) && doctrine.pilotSkills.length > 0
          ? { pilotSkills: doctrine.pilotSkills }
          : {}),
        ...(Array.isArray(doctrine.droneBay) && doctrine.droneBay.length > 0
          ? { droneBay: doctrine.droneBay }
          : {}),
        ...(doctrine.survivabilityProfile
          ? { survivabilityProfile: doctrine.survivabilityProfile }
          : {}),
        ...(doctrine.recoveryPolicy || {}),
      },
    });
  }
  return { profiles, loadouts };
}

function buildLivingSpawnGroups() {
  const byDoctrineID = new Map(
    ALL_TRAFFIC_DOCTRINES.map((doctrine) => [doctrine.doctrineID, getLivingProfileID(doctrine.doctrineID)]),
  );
  const entry = (doctrineID, count = 1) => ({
    profileID: byDoctrineID.get(doctrineID),
    count,
  });
  const group = (spawnGroupID, name, entries) => ({
    spawnGroupID,
    name,
    description: "Persistent Jita-area living-universe flight using governed player-ship fittings.",
    aliases: [spawnGroupID.replace(/_/g, " ")],
    entityType: "npc",
    entries,
  });
  return [
    group(LIVING_UNIVERSE_GROUPS.shuttle, "Independent Shuttle", [
      entry("jita_shuttle_civilian_empty_v1"),
    ]),
    group(LIVING_UNIVERSE_GROUPS.haulerCivilian, "Independent Badger Hauler", [
      entry("jita_hauler_civilian_badger_v1"),
    ]),
    group(LIVING_UNIVERSE_GROUPS.haulerStandard, "Independent Tayra Hauler", [
      entry("jita_hauler_standard_tayra_v1"),
    ]),
    group(LIVING_UNIVERSE_GROUPS.haulerBulk, "Bulk Tayra Hauler", [
      entry("jita_hauler_bulk_tayra_v2"),
    ]),
    group(LIVING_UNIVERSE_GROUPS.haulerSecure, "Low-Security Bustard Hauler", [
      entry("jita_hauler_secure_bustard_v3"),
    ]),
    group(LIVING_UNIVERSE_GROUPS.haulerTrunk, "Regional Charon Trunk Hauler", [
      entry("jita_hauler_trunk_charon_v2"),
    ]),
    group(LIVING_UNIVERSE_GROUPS.convoyStandard, "Standard Freight Convoy", [
      entry("jita_hauler_civilian_badger_v1"),
      entry("jita_escort_standard_merlin_v1", 2),
    ]),
    group(LIVING_UNIVERSE_GROUPS.convoyVeteran, "Veteran Freight Convoy", [
      entry("jita_hauler_standard_tayra_v1"),
      entry("jita_escort_veteran_merlin_v1", 2),
    ]),
    group(LIVING_UNIVERSE_GROUPS.convoySecure, "Frontier Secure Freight Convoy", [
      entry("jita_hauler_secure_convoy_bustard_v4"),
      entry("jita_escort_frontier_caracal_v3"),
      entry("jita_escort_frontier_moa_drone_v3"),
    ]),
    group(LIVING_UNIVERSE_GROUPS.minerStandard, "Standard Mining Wing", [
      entry("jita_miner_standard_venture_v1", 4),
    ]),
    group(LIVING_UNIVERSE_GROUPS.minerVeteran, "Veteran Mining Wing", [
      entry("jita_miner_veteran_venture_v1", 4),
    ]),
    group(LIVING_UNIVERSE_GROUPS.minerElite, "Elite Mining Wing", [
      entry("jita_mining_support_orca_v2"),
      entry("jita_miner_elite_hulk_v2", 3),
    ]),
    group(LIVING_UNIVERSE_GROUPS.minerCorporate, "Corporate Mining Wing", [
      entry("jita_mining_support_orca_v2"),
      entry("jita_miner_corporate_retriever_v2", 3),
    ]),
    group(LIVING_UNIVERSE_GROUPS.minerLowsec, "Low-Security Mining Wing", [
      entry("jita_mining_support_porpoise_v2"),
      entry("jita_miner_lowsec_skiff_v2", 3),
    ]),
    group(LIVING_UNIVERSE_GROUPS.minerIce, "Corporate Ice Mining Wing", [
      entry("jita_mining_support_orca_v2"),
      entry("jita_ice_miner_mackinaw_v2", 3),
    ]),
    group(LIVING_UNIVERSE_GROUPS.policeStandard, "Caldari Navy Patrol", [
      entry("jita_police_standard_caracal_v1"),
      entry("jita_police_standard_moa_drone_v4"),
      entry("jita_police_standard_osprey_v4"),
    ]),
    group(LIVING_UNIVERSE_GROUPS.policeElite, "Caldari Navy Veteran Patrol", [
      entry("jita_police_elite_ferox_v4"),
      entry("jita_police_elite_caracal_v1"),
      entry("jita_police_standard_moa_drone_v4"),
    ]),
    group(LIVING_UNIVERSE_GROUPS.policeCommand, "Caldari Navy Command Patrol", [
      entry("jita_police_command_rokh_v4"),
      entry("jita_police_elite_ferox_v4"),
      entry("jita_police_standard_osprey_v4"),
    ]),
    group(LIVING_UNIVERSE_GROUPS.pirateStandard, "Guristas Roaming Gang", [
      entry("jita_pirate_standard_kestrel_v4"),
      entry("jita_pirate_standard_merlin_v4"),
      entry("jita_pirate_standard_cormorant_v1", 2),
    ]),
    group(LIVING_UNIVERSE_GROUPS.pirateVeteran, "Guristas Veteran Gang", [
      entry("jita_pirate_elite_caracal_v1"),
      entry("jita_pirate_veteran_moa_drone_v4"),
      entry("jita_pirate_veteran_cormorant_v1", 2),
    ]),
    group(LIVING_UNIVERSE_GROUPS.pirateElite, "Guristas Elite Gang", [
      entry("jita_pirate_elite_drake_v4"),
      entry("jita_pirate_elite_caracal_v1"),
      entry("jita_pirate_veteran_moa_drone_v4"),
      entry("jita_pirate_elite_blackbird_v4"),
    ]),
    group(LIVING_UNIVERSE_GROUPS.pirateCommand, "Guristas Command Gang", [
      entry("jita_pirate_command_raven_v4"),
      entry("jita_pirate_elite_drake_v4"),
      entry("jita_pirate_elite_caracal_v1"),
      entry("jita_pirate_elite_blackbird_v4"),
    ]),
    ...REGIONAL_SPAWN_GROUP_DEFINITIONS.map((definition) => group(
      definition.spawnGroupID,
      definition.name,
      definition.entries.map((regionalEntry) => entry(
        regionalEntry.doctrineID,
        regionalEntry.count,
      )),
    )),
  ];
}

function buildProfile({
  profileID,
  name,
  aliases,
  typeID,
  shipNameTemplate,
  spawnDistanceMeters,
  loadoutID,
}) {
  return {
    profileID,
    name,
    description:
      "Passive Caldari civilian traffic used by the virtual ambient-traffic route runtime.",
    aliases,
    entityType: "npc",
    shipTypeID: typeID,
    presentationTypeID: typeID,
    corporationID: CALDARI_NAVY_CORPORATION_ID,
    allianceID: 0,
    factionID: CALDARI_STATE_FACTION_ID,
    behaviorProfileID: PASSIVE_BEHAVIOR_PROFILE_ID,
    loadoutID,
    lootTableID: null,
    shipNameTemplate,
    securityStatus: 0,
    bounty: 0,
    spawnDistanceMeters,
    preferredTargetMode: "none",
    // Civilian convoy hulls are SDE entity ships with no combat fitting. Use
    // the native pass-through hardware family instead of a player-race label;
    // npcHardwareCatalog validates hardware capabilities, not hull ethnicity.
    hardwareFamily: "sdeEntityNpc",
    hostileResponseThreshold: -11,
    friendlyResponseThreshold: -11,
    ambientTraffic: true,
  };
}

function buildGeneratedRows() {
  const livingDoctrineRows = buildLivingDoctrineRows();
  return Object.freeze({
    [NPC_TABLE.PROFILES]: Object.freeze([
      buildProfile({
        profileID: AMBIENT_TRAFFIC_HAULER_PROFILE_ID,
        name: "Caldari State Logistics Hauler",
        aliases: ["state logistics hauler", "ambient hauler", "civilian hauler"],
        typeID: AMBIENT_TRAFFIC_HAULER_TYPE_ID,
        shipNameTemplate: "State Logistics Hauler",
        spawnDistanceMeters: 28_000,
        loadoutID: AMBIENT_TRAFFIC_HAULER_LOADOUT_ID,
      }),
      buildProfile({
        profileID: AMBIENT_TRAFFIC_ESCORT_PROFILE_ID,
        name: "Caldari State Convoy Escort",
        aliases: ["state convoy escort", "ambient escort", "convoy escort"],
        typeID: AMBIENT_TRAFFIC_ESCORT_TYPE_ID,
        shipNameTemplate: "State Convoy Escort",
        spawnDistanceMeters: 24_000,
        loadoutID: AMBIENT_TRAFFIC_ESCORT_LOADOUT_ID,
      }),
      ...livingDoctrineRows.profiles,
    ]),
    [NPC_TABLE.LOADOUTS]: Object.freeze([
      {
        loadoutID: AMBIENT_TRAFFIC_HAULER_LOADOUT_ID,
        name: "Ambient Caldari Convoy Governed Civilian Hauler",
        modules: [],
        charges: [],
        cargo: [],
        governance: {
          enabled: true,
          doctrineID: "ambient_caldari_convoy_hauler_v1",
          doctrineRevision: 1,
          role: "hauler",
          equipmentBand: "civilian",
          procurementPolicy: "corporation_issued",
          recoverabilityPolicyID: "phase3_governed_default",
          fittedModuleDropChance: 0,
          cargoSurvivalChance: 0.5,
        },
      },
      {
        loadoutID: AMBIENT_TRAFFIC_ESCORT_LOADOUT_ID,
        name: "Ambient Caldari Convoy Governed Standard Escort",
        modules: [],
        charges: [],
        cargo: [],
        governance: {
          enabled: true,
          doctrineID: "ambient_caldari_convoy_escort_v1",
          doctrineRevision: 1,
          role: "escort",
          equipmentBand: "standard",
          procurementPolicy: "corporation_issued",
          recoverabilityPolicyID: "phase3_governed_default",
          fittedModuleDropChance: 0,
          cargoSurvivalChance: 0.5,
        },
      },
      ...livingDoctrineRows.loadouts,
    ]),
    [NPC_TABLE.LOOT_TABLES]: TRAFFIC_LOOT_TABLES,
    [NPC_TABLE.SPAWN_GROUPS]: Object.freeze([
      {
        spawnGroupID: AMBIENT_TRAFFIC_SPAWN_GROUP_ID,
        name: "Caldari State Logistics Convoy",
        description:
          "One civilian Caldari hauler with two passive escorts for scheduled ambient traffic.",
        aliases: ["ambient convoy", "state logistics convoy", "jita convoy"],
        entityType: "npc",
        entries: [
          {
            profileID: AMBIENT_TRAFFIC_HAULER_PROFILE_ID,
            count: 1,
          },
          {
            profileID: AMBIENT_TRAFFIC_ESCORT_PROFILE_ID,
            count: 2,
          },
        ],
      },
      ...buildLivingSpawnGroups(),
    ]),
  });
}

let cachedRowsByTableName = null;

function getAmbientTrafficGeneratedRows(tableName) {
  if (!cachedRowsByTableName) {
    cachedRowsByTableName = buildGeneratedRows();
  }
  return cachedRowsByTableName[tableName] || [];
}

module.exports = {
  AMBIENT_TRAFFIC_HAULER_PROFILE_ID,
  AMBIENT_TRAFFIC_ESCORT_PROFILE_ID,
  AMBIENT_TRAFFIC_SPAWN_GROUP_ID,
  AMBIENT_TRAFFIC_HAULER_TYPE_ID,
  AMBIENT_TRAFFIC_ESCORT_TYPE_ID,
  LIVING_UNIVERSE_GROUPS,
  getLivingProfileID,
  getAmbientTrafficGeneratedRows,
};
