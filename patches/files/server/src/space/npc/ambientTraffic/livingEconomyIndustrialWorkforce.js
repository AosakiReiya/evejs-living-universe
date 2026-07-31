"use strict";

const path = require("path");

const worldData = require(path.join(__dirname, "../../worldData"));
const catalog = require(path.join(__dirname, "./livingEconomyCatalog"));

const PILOT_ID_BASE = 2_126_000_000;
const SKILL = Object.freeze({
  INDUSTRY: 3380,
  MASS_PRODUCTION: 3387,
  ADVANCED_INDUSTRY: 3388,
  SCIENCE: 3402,
  RESEARCH: 3403,
  LABORATORY_OPERATION: 3406,
  METALLURGY: 3409,
  ADVANCED_LABORATORY_OPERATION: 24624,
  ADVANCED_MASS_PRODUCTION: 24625,
});

const GIVEN_NAMES = Object.freeze([
  "Alden", "Anika", "Bren", "Cerys", "Daichi", "Elara", "Farid", "Greta",
  "Harlan", "Inez", "Joon", "Kaori", "Leif", "Mara", "Nadia", "Orin",
  "Priya", "Quinn", "Ravi", "Sable", "Tarin", "Uma", "Viktor", "Wren",
  "Xia", "Yara", "Zane", "Cassian", "Mei", "Oskar", "Rina", "Tomas",
]);
const FAMILY_NAMES = Object.freeze([
  "Aalto", "Bashir", "Chen", "Dall", "Escher", "Fujita", "Galen", "Havel",
  "Ishikawa", "Jensen", "Kade", "Laghari", "Mori", "Novak", "Ortega", "Pahl",
  "Qureshi", "Renn", "Sato", "Tal", "Ueda", "Voss", "Wei", "Yarrow",
  "Zoric", "Kest", "Malkov", "Nayar", "Okafor", "Petrov", "Rhee", "Solari",
]);
const MIDDLE_INITIALS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function deterministic(seed, salt = 0) {
  let value = (toPositiveInt(seed, 1) ^ Math.imul(toPositiveInt(salt, 1), 0x45d9f3b)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

function getSecurity(station) {
  const authored = Number(station && station.security);
  if (Number.isFinite(authored)) return authored;
  const row = worldData.getStationByID(station && station.stationID) || {};
  return toFiniteNumber(row.security, 0);
}

function getSecurityBand(station) {
  const security = getSecurity(station);
  if (security >= 0.5) return "highsec";
  if (security > 0) return "lowsec";
  return "nullsec";
}

function getCorporationID(station) {
  const authored = toPositiveInt(station && station.corporationID, 0);
  if (authored > 0) return authored;
  const row = worldData.getStationByID(station && station.stationID) || {};
  return toPositiveInt(row.corporationID || row.ownerID, 0);
}

function buildSkills(seed, securityBand) {
  const seasonedChance = securityBand === "nullsec" ? 76 : securityBand === "lowsec" ? 62 : 38;
  const seasoned = (deterministic(seed, 17) % 100) < seasonedChance;
  const specialist = (deterministic(seed, 23) % 100) < 28;
  const industry = seasoned ? 5 : 3 + (deterministic(seed, 29) % 2);
  const science = seasoned ? 5 : 3 + (deterministic(seed, 31) % 2);
  return {
    [SKILL.INDUSTRY]: industry,
    [SKILL.ADVANCED_INDUSTRY]: seasoned ? 4 : 2,
    [SKILL.MASS_PRODUCTION]: seasoned ? 5 : 3,
    [SKILL.ADVANCED_MASS_PRODUCTION]: seasoned ? 3 + (specialist ? 1 : 0) : 0,
    [SKILL.SCIENCE]: science,
    [SKILL.RESEARCH]: seasoned ? 4 : 3,
    [SKILL.METALLURGY]: seasoned ? 4 : 3,
    [SKILL.LABORATORY_OPERATION]: seasoned ? 5 : 3,
    [SKILL.ADVANCED_LABORATORY_OPERATION]: seasoned ? 3 + (specialist ? 1 : 0) : 0,
  };
}

function skillLevel(pilot, skillTypeID) {
  return Math.max(0, Math.min(5, Math.trunc(Number(
    pilot && pilot.skills && pilot.skills[String(skillTypeID)],
  ) || 0)));
}

function manufacturingSlots(pilot) {
  return 1 + skillLevel(pilot, SKILL.MASS_PRODUCTION) +
    skillLevel(pilot, SKILL.ADVANCED_MASS_PRODUCTION);
}

function scienceSlots(pilot) {
  return 1 + skillLevel(pilot, SKILL.LABORATORY_OPERATION) +
    skillLevel(pilot, SKILL.ADVANCED_LABORATORY_OPERATION);
}

function ensureState(economyState) {
  if (!economyState.industryPilots || typeof economyState.industryPilots !== "object") {
    economyState.industryPilots = {};
  }
  economyState.nextIndustryPilotNumber = Math.max(
    1,
    toPositiveInt(economyState.nextIndustryPilotNumber, 1),
  );
  return economyState.industryPilots;
}

function makePilot(economyState, station, index, nowMs) {
  const number = economyState.nextIndustryPilotNumber++;
  const seed = deterministic(station.stationID, index + 1);
  const securityBand = getSecurityBand(station);
  const pilotID = PILOT_ID_BASE + number;
  // Walk a 32x26x32 name space so a universe-scale workforce receives unique
  // combinations without the conspicuous repeated-name clusters
  // that made the original ambient population feel generated.
  const nameSpace = GIVEN_NAMES.length * MIDDLE_INITIALS.length * FAMILY_NAMES.length;
  const nameIndex = (((number - 1) * 641) + 173) % nameSpace;
  const given = GIVEN_NAMES[nameIndex % GIVEN_NAMES.length];
  const middle = MIDDLE_INITIALS[
    Math.floor(nameIndex / GIVEN_NAMES.length) % MIDDLE_INITIALS.length
  ];
  const family = FAMILY_NAMES[
    Math.floor(nameIndex / (GIVEN_NAMES.length * MIDDLE_INITIALS.length)) % FAMILY_NAMES.length
  ];
  const skills = buildSkills(seed, securityBand);
  return {
    pilotID,
    characterID: pilotID,
    name: `${given} ${middle}. ${family}`,
    corporationID: getCorporationID(station),
    stationID: Number(station.stationID),
    systemID: Number(station.systemID),
    regionID: Number(station.regionID) || 0,
    security: getSecurity(station),
    securityBand,
    career: index === 0 ? "manufacturer" : "researcher",
    skills,
    manufacturingSlots: 1 + skillLevel({ skills }, SKILL.MASS_PRODUCTION) +
      skillLevel({ skills }, SKILL.ADVANCED_MASS_PRODUCTION),
    scienceSlots: 1 + skillLevel({ skills }, SKILL.LABORATORY_OPERATION) +
      skillLevel({ skills }, SKILL.ADVANCED_LABORATORY_OPERATION),
    createdAtMs: nowMs,
    lastAssignedAtMs: 0,
  };
}

function seed(economyState, nowMs = Date.now()) {
  const pilots = ensureState(economyState);
  if (Object.keys(pilots).length > 0 && toFiniteNumber(economyState.industryWorkforceSeededAtMs, 0) > 0) {
    return { created: 0, total: Object.keys(pilots).length };
  }
  let created = 0;
  for (const station of catalog.STATIONS) {
    if (Object.keys(station.production || {}).length <= 0) continue;
    const count = String(station.hubTier || "") === "regional" ? 3 : 2;
    for (let index = 0; index < count; index += 1) {
      if (Object.values(pilots).some((pilot) => (
        Number(pilot.stationID) === Number(station.stationID) &&
        Number(pilot.seedIndex) === index
      ))) continue;
      const pilot = makePilot(economyState, station, index, nowMs);
      pilot.seedIndex = index;
      pilots[String(pilot.pilotID)] = pilot;
      created += 1;
    }
  }
  economyState.industryWorkforceSeededAtMs = nowMs;
  economyState.metrics.industryPilotsCreated =
    toFiniteNumber(economyState.metrics.industryPilotsCreated, 0) + created;
  return { created, total: Object.keys(pilots).length };
}

function choosePilot(economyState, stationID, activityGroup) {
  const candidates = new Map();
  for (const pilotID in ensureState(economyState)) {
    const pilot = economyState.industryPilots[pilotID];
    if (Number(pilot.stationID) !== Number(stationID)) continue;
    candidates.set(Number(pilot.pilotID), {
      pilot,
      used: 0,
      limit: activityGroup === "science" ? scienceSlots(pilot) : manufacturingSlots(pilot),
    });
  }
  if (candidates.size <= 0) return null;
  for (const jobID in economyState.industryJobs || {}) {
    const job = economyState.industryJobs[jobID];
    if (
      !["reserving", "running", "output_pending"].includes(String(job && job.status || "")) ||
      String(job && job.activityGroup || "manufacturing") !== activityGroup
    ) continue;
    const candidate = candidates.get(Number(job.pilotID));
    if (candidate) candidate.used += 1;
  }
  let selected = null;
  for (const candidate of candidates.values()) {
    if (candidate.used >= candidate.limit) continue;
    if (!selected ||
      (candidate.used / candidate.limit) < (selected.used / selected.limit) ||
      ((candidate.used / candidate.limit) === (selected.used / selected.limit) &&
        toFiniteNumber(candidate.pilot.lastAssignedAtMs, 0) <
          toFiniteNumber(selected.pilot.lastAssignedAtMs, 0)) ||
      ((candidate.used / candidate.limit) === (selected.used / selected.limit) &&
        toFiniteNumber(candidate.pilot.lastAssignedAtMs, 0) ===
          toFiniteNumber(selected.pilot.lastAssignedAtMs, 0) &&
        Number(candidate.pilot.pilotID) < Number(selected.pilot.pilotID))) {
      selected = candidate;
    }
  }
  return selected ? selected.pilot : null;
}

function markAssigned(pilot, nowMs) {
  if (pilot) pilot.lastAssignedAtMs = nowMs;
}

function manufacturingTimeMultiplier(pilot) {
  return Math.max(0.55,
    (1 - (0.04 * skillLevel(pilot, SKILL.INDUSTRY))) *
    (1 - (0.03 * skillLevel(pilot, SKILL.ADVANCED_INDUSTRY))));
}

function scienceTimeMultiplier(pilot, activity) {
  const specialistSkill = activity === "research_material"
    ? SKILL.METALLURGY
    : activity === "research_time"
      ? SKILL.RESEARCH
      : SKILL.SCIENCE;
  return Math.max(0.5, 1 / (
    1 + (0.05 * skillLevel(pilot, SKILL.SCIENCE)) +
    (0.05 * skillLevel(pilot, specialistSkill))
  ));
}

function getStatus(economyState) {
  const pilots = ensureState(economyState);
  let total = 0;
  let highsec = 0;
  let lowsec = 0;
  let nullsec = 0;
  for (const pilotID in pilots) {
    total += 1;
    const band = String(pilots[pilotID] && pilots[pilotID].securityBand || "");
    if (band === "highsec") highsec += 1;
    else if (band === "lowsec") lowsec += 1;
    else if (band === "nullsec") nullsec += 1;
  }
  const activePilotIDs = new Set();
  for (const jobID in economyState.industryJobs || {}) {
    const job = economyState.industryJobs[jobID];
    if (["reserving", "running", "output_pending"].includes(String(job && job.status || ""))) {
      const pilotID = Number(job.pilotID);
      if (pilotID) activePilotIDs.add(pilotID);
    }
  }
  return {
    total,
    highsec,
    lowsec,
    nullsec,
    busy: activePilotIDs.size,
    idle: Math.max(0, total - activePilotIDs.size),
  };
}

module.exports = {
  PILOT_ID_BASE,
  SKILL,
  choosePilot,
  ensureState,
  getSecurity,
  getSecurityBand,
  getStatus,
  manufacturingSlots,
  manufacturingTimeMultiplier,
  markAssigned,
  scienceSlots,
  scienceTimeMultiplier,
  seed,
  skillLevel,
};
