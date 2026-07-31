"use strict";

const path = require("path");

const database = require(path.join(__dirname, "../../../gameStore"));

const FACTIONS = Object.freeze({
  CALDARI_STATE: Object.freeze({ factionID: 500001, factionName: "Caldari State", raceID: 1 }),
  MINMATAR_REPUBLIC: Object.freeze({ factionID: 500002, factionName: "Minmatar Republic", raceID: 2 }),
  AMARR_EMPIRE: Object.freeze({ factionID: 500003, factionName: "Amarr Empire", raceID: 4 }),
  GALLENTE_FEDERATION: Object.freeze({ factionID: 500004, factionName: "Gallente Federation", raceID: 8 }),
  GURISTAS_PIRATES: Object.freeze({ factionID: 500010, factionName: "Guristas Pirates", raceID: 1 }),
  ANGEL_CARTEL: Object.freeze({ factionID: 500011, factionName: "Angel Cartel", raceID: 2 }),
  BLOOD_RAIDER_COVENANT: Object.freeze({ factionID: 500012, factionName: "Blood Raider Covenant", raceID: 4 }),
  SANSHAS_NATION: Object.freeze({ factionID: 500019, factionName: "Sansha's Nation", raceID: 4 }),
  SERPENTIS: Object.freeze({ factionID: 500020, factionName: "Serpentis", raceID: 8 }),
  ORE: Object.freeze({ factionID: 500014, factionName: "ORE", raceID: 8 }),
});

function corporation(corporationID, corporationName, faction) {
  return Object.freeze({
    corporationID,
    corporationName,
    factionID: faction.factionID,
    factionName: faction.factionName,
    raceID: faction.raceID,
  });
}

const CORPORATIONS = Object.freeze({
  // Caldari industrial and resource employers.
  1000005: corporation(1000005, "Hyasyoda Corporation", FACTIONS.CALDARI_STATE),
  1000006: corporation(1000006, "Deep Core Mining Inc.", FACTIONS.CALDARI_STATE),
  1000007: corporation(1000007, "Poksu Mineral Group", FACTIONS.CALDARI_STATE),
  1000008: corporation(1000008, "Minedrill", FACTIONS.CALDARI_STATE),
  1000015: corporation(1000015, "Caldari Steel", FACTIONS.CALDARI_STATE),
  1000026: corporation(1000026, "Caldari Constructions", FACTIONS.CALDARI_STATE),

  // Amarr industrial employers.
  1000063: corporation(1000063, "Amarr Constructions", FACTIONS.AMARR_EMPIRE),
  1000064: corporation(1000064, "Carthum Conglomerate", FACTIONS.AMARR_EMPIRE),
  1000065: corporation(1000065, "Imperial Armaments", FACTIONS.AMARR_EMPIRE),
  1000066: corporation(1000066, "Viziam", FACTIONS.AMARR_EMPIRE),
  1000067: corporation(1000067, "Zoar and Sons", FACTIONS.AMARR_EMPIRE),

  // Gallente and independent industrial employers.
  1000098: corporation(1000098, "Astral Mining Inc.", FACTIONS.GALLENTE_FEDERATION),
  1000101: corporation(1000101, "CreoDron", FACTIONS.GALLENTE_FEDERATION),
  1000102: corporation(1000102, "Roden Shipyards", FACTIONS.GALLENTE_FEDERATION),
  1000103: corporation(1000103, "Allotek Industries", FACTIONS.GALLENTE_FEDERATION),
  1000108: corporation(1000108, "Chemal Tech", FACTIONS.GALLENTE_FEDERATION),
  1000109: corporation(1000109, "Duvolle Laboratories", FACTIONS.GALLENTE_FEDERATION),
  1000129: corporation(1000129, "Outer Ring Excavations", FACTIONS.ORE),

  // Caldari trade, distribution, and civilian employers.
  1000002: corporation(1000002, "CBD Corporation", FACTIONS.CALDARI_STATE),
  1000003: corporation(1000003, "Prompt Delivery", FACTIONS.CALDARI_STATE),
  1000004: corporation(1000004, "Ytiri", FACTIONS.CALDARI_STATE),
  1000009: corporation(1000009, "Caldari Provisions", FACTIONS.CALDARI_STATE),
  1000014: corporation(1000014, "Perkone", FACTIONS.CALDARI_STATE),
  1000017: corporation(1000017, "Nugoeihuvi Corporation", FACTIONS.CALDARI_STATE),
  1000023: corporation(1000023, "Expert Distribution", FACTIONS.CALDARI_STATE),
  1000024: corporation(1000024, "CBD Sell Division", FACTIONS.CALDARI_STATE),
  1000033: corporation(1000033, "Caldari Business Tribunal", FACTIONS.CALDARI_STATE),

  // Caldari security employers.
  1000035: corporation(1000035, "Caldari Navy", FACTIONS.CALDARI_STATE),
  1000036: corporation(1000036, "Internal Security", FACTIONS.CALDARI_STATE),
  1000041: corporation(1000041, "Spacelane Patrol", FACTIONS.CALDARI_STATE),
  1000042: corporation(1000042, "Wiyrkomi Peace Corps", FACTIONS.CALDARI_STATE),
  1000043: corporation(1000043, "Corporate Police Force", FACTIONS.CALDARI_STATE),

  // Minmatar employers represented by the Republic station in Tama.
  1000046: corporation(1000046, "Sebiestor Tribe", FACTIONS.MINMATAR_REPUBLIC),
  1000047: corporation(1000047, "Krusual Tribe", FACTIONS.MINMATAR_REPUBLIC),
  1000048: corporation(1000048, "Vherokior Tribe", FACTIONS.MINMATAR_REPUBLIC),
  1000049: corporation(1000049, "Brutor Tribe", FACTIONS.MINMATAR_REPUBLIC),
  1000051: corporation(1000051, "Republic Fleet", FACTIONS.MINMATAR_REPUBLIC),
  1000052: corporation(1000052, "Republic Justice Department", FACTIONS.MINMATAR_REPUBLIC),
  1000053: corporation(1000053, "Urban Management", FACTIONS.MINMATAR_REPUBLIC),
  1000054: corporation(1000054, "Republic Security Services", FACTIONS.MINMATAR_REPUBLIC),
  1000055: corporation(1000055, "Minmatar Mining Corporation", FACTIONS.MINMATAR_REPUBLIC),
  1000056: corporation(1000056, "Core Complexion Inc.", FACTIONS.MINMATAR_REPUBLIC),
  1000057: corporation(1000057, "Boundless Creation", FACTIONS.MINMATAR_REPUBLIC),
  1000058: corporation(1000058, "Eifyr and Co.", FACTIONS.MINMATAR_REPUBLIC),
  1000059: corporation(1000059, "Six Kin Development", FACTIONS.MINMATAR_REPUBLIC),
  1000060: corporation(1000060, "Native Freshfood", FACTIONS.MINMATAR_REPUBLIC),
  1000061: corporation(1000061, "Freedom Extension", FACTIONS.MINMATAR_REPUBLIC),

  // Regional hostile authority.
  1000127: corporation(1000127, "Guristas", FACTIONS.GURISTAS_PIRATES),
  1000138: corporation(1000138, "Dominations", FACTIONS.ANGEL_CARTEL),
  1000134: corporation(1000134, "Blood Raiders", FACTIONS.BLOOD_RAIDER_COVENANT),
  1000162: corporation(1000162, "True Power", FACTIONS.SANSHAS_NATION),
  1000135: corporation(1000135, "Serpentis Corporation", FACTIONS.SERPENTIS),
});

const PIRATE_CORPORATION_BY_KEY = Object.freeze({
  guristas: 1000127,
  angels: 1000138,
  blood: 1000134,
  sanshas: 1000162,
  serpentis: 1000135,
});

const ROLE_POOLS = Object.freeze({
  500001: Object.freeze({
    miner: Object.freeze([1000005, 1000006, 1000007, 1000008, 1000015, 1000026]),
    hauler: Object.freeze([1000002, 1000003, 1000004, 1000023, 1000024]),
    shuttle: Object.freeze([1000002, 1000004, 1000009, 1000014, 1000017, 1000023, 1000033]),
    police: Object.freeze([1000035, 1000036, 1000041, 1000042, 1000043]),
  }),
  500002: Object.freeze({
    miner: Object.freeze([1000055, 1000056, 1000057, 1000058, 1000059]),
    hauler: Object.freeze([1000053, 1000059, 1000061]),
    shuttle: Object.freeze([1000046, 1000047, 1000048, 1000049, 1000053, 1000060, 1000061]),
    police: Object.freeze([1000051, 1000052, 1000054]),
  }),
  500003: Object.freeze({
    miner: Object.freeze([1000063, 1000064, 1000065, 1000066, 1000067]),
  }),
  500004: Object.freeze({
    miner: Object.freeze([1000098, 1000101, 1000102, 1000103, 1000108, 1000109]),
  }),
  500014: Object.freeze({
    miner: Object.freeze([1000129]),
  }),
});

const INDUSTRIAL_CORPORATION_IDS = Object.freeze([
  ...Object.values(ROLE_POOLS).flatMap((pools) => pools.miner || []),
]);

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function deterministicUnit(...parts) {
  const text = parts.map((part) => String(part)).join("|");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0x100000000;
}

function getStaticCorporationRecord(corporationID) {
  const result = database.read("corporations", `/records/${String(corporationID)}`);
  return result && result.success && result.data && typeof result.data === "object"
    ? result.data
    : null;
}

function getFactionDefinition(factionID, fallbackRaceID = 1) {
  const numericFactionID = toPositiveInt(factionID, 0);
  const authored = Object.values(FACTIONS).find((entry) => entry.factionID === numericFactionID);
  if (authored) return authored;
  const result = numericFactionID
    ? database.read("factions", `/records/${String(numericFactionID)}`)
    : null;
  const record = result && result.success && result.data && typeof result.data === "object"
    ? result.data
    : null;
  return numericFactionID
    ? {
        factionID: numericFactionID,
        factionName: String(record && (record.name || record.factionName) || `Regional Faction ${numericFactionID}`),
        raceID: toPositiveInt(fallbackRaceID, 1),
      }
    : null;
}

function getStationOwner(station, fallbackFaction = null) {
  const corporationID = toPositiveInt(station && (station.corporationID || station.ownerID), 0);
  if (!corporationID) return null;
  if (CORPORATIONS[corporationID]) return CORPORATIONS[corporationID];
  const record = getStaticCorporationRecord(corporationID);
  const raceID = toPositiveInt(record && record.raceID, toPositiveInt(station && station.stationRaceID, 0));
  const faction = getFactionDefinition(record && record.factionID, raceID) ||
    fallbackFaction ||
    Object.values(FACTIONS).find((entry) => entry.raceID === raceID) ||
    FACTIONS.CALDARI_STATE;
  return corporation(
    corporationID,
    String(record && record.corporationName || station && station.corporationName || `Regional Corporation ${corporationID}`),
    faction,
  );
}

function getRegionalFaction(station, system) {
  const stationOwner = CORPORATIONS[
    toPositiveInt(station && (station.corporationID || station.ownerID), 0)
  ] || null;
  if (stationOwner) {
    return {
      factionID: stationOwner.factionID,
      factionName: stationOwner.factionName,
      raceID: stationOwner.raceID,
    };
  }
  const corporationID = toPositiveInt(station && (station.corporationID || station.ownerID), 0);
  const corporationRecord = getStaticCorporationRecord(corporationID);
  const corporationFaction = getFactionDefinition(
    corporationRecord && corporationRecord.factionID,
    corporationRecord && corporationRecord.raceID,
  );
  if (corporationFaction) return corporationFaction;
  const systemFactionID = toPositiveInt(system && system.factionID, FACTIONS.CALDARI_STATE.factionID);
  const authoredFaction = Object.values(FACTIONS)
    .find((entry) => entry.factionID === systemFactionID);
  if (authoredFaction) return authoredFaction;
  const raceID = toPositiveInt(station && station.stationRaceID, 0);
  const racialFaction = Object.values(FACTIONS).find((entry) => entry.raceID === raceID);
  if (racialFaction) return racialFaction;
  return {
    factionID: systemFactionID,
    factionName: `Regional Faction ${systemFactionID}`,
    raceID: raceID || 1,
  };
}

function getProfession(family) {
  if (family === "miner") {
    return "miner";
  }
  if (family === "hauler" || family === "convoy") {
    return "hauler";
  }
  if (family === "police") {
    return "police";
  }
  return "shuttle";
}

function resolveAffiliation({ family, station, system, seed, pirateFactionKey = "guristas" }) {
  if (family === "pirate") {
    const pirateCorporationID = PIRATE_CORPORATION_BY_KEY[
      String(pirateFactionKey || "").trim().toLowerCase()
    ] || PIRATE_CORPORATION_BY_KEY.guristas;
    return {
      ...CORPORATIONS[pirateCorporationID],
      profession: "pirate",
      stationCorporationID: toPositiveInt(station && (station.corporationID || station.ownerID), 0),
    };
  }
  const faction = getRegionalFaction(station, system);
  const profession = getProfession(family);
  const stationOwner = getStationOwner(station, faction);
  const pools = ROLE_POOLS[faction.factionID] || null;
  const pool = pools && (pools[profession] || pools.shuttle)
    ? [...(pools[profession] || pools.shuttle)]
    : stationOwner
      ? [stationOwner.corporationID]
      : [...ROLE_POOLS[FACTIONS.CALDARI_STATE.factionID].shuttle];
  if (stationOwner && stationOwner.factionID === faction.factionID && pool.includes(stationOwner.corporationID)) {
    pool.unshift(...pool.splice(pool.indexOf(stationOwner.corporationID), 1));
  }
  const selectedID = pool[Math.min(
    pool.length - 1,
    Math.floor(deterministicUnit(seed, family, station && station.stationID, "corporation") * pool.length),
  )];
  const selected = CORPORATIONS[selectedID] || stationOwner || CORPORATIONS[1000002];
  return {
    ...selected,
    profession,
    stationCorporationID: toPositiveInt(station && (station.corporationID || station.ownerID), 0),
  };
}

module.exports = {
  CORPORATIONS,
  FACTIONS,
  INDUSTRIAL_CORPORATION_IDS,
  PIRATE_CORPORATION_BY_KEY,
  ROLE_POOLS,
  resolveAffiliation,
  _testing: {
    deterministicUnit,
    getProfession,
    getRegionalFaction,
    getStationOwner,
  },
};
