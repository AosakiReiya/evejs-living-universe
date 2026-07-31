"use strict";

const fs = require("fs");
const path = require("path");
const {
  listAgents,
} = require(path.join(__dirname, "../../../services/agent/agentAuthority"));

// The V24 client recognizes generation-3 player owners only in
// 2,100,000,000..2,129,999,999. Keep the synthetic population inside that
// range so cfg.eveowners and GetOwnerLogo treat every identity as a character.
const PILOT_CHARACTER_ID_BASE = 2_120_000_000;
const LEGACY_PILOT_CHARACTER_ID_BASE = 2_140_000_000;
const OWNER_TYPE_ID = 1373;
const DEFAULT_CORPORATION_ID = 1000035;
const DEFAULT_FACTION_ID = 500001;
const PILOT_NAME_REVISION = 2;
const PILOT_AFFILIATION_REVISION = 1;
const PILOT_PORTRAIT_REVISION = 1;
const DEFAULT_PILOT_SOURCE_ID = "default";
const PORTRAIT_MANIFEST_PATH = path.join(
  __dirname,
  "../../../_secondary/image/generated/agents/manifest.json",
);

const GIVEN_NAMES = Object.freeze([
  "Aki", "Akio", "Arata", "Aya", "Chiyo", "Daichi", "Eiko", "Emi",
  "Gen", "Hana", "Haruki", "Hikaru", "Hiro", "Isamu", "Jun", "Kaede",
  "Kaito", "Kana", "Kei", "Kenji", "Kira", "Mai", "Makoto", "Mina",
  "Naoki", "Rei", "Ren", "Riku", "Sora", "Taro", "Yuna", "Yuri",
]);

const FAMILY_NAMES = Object.freeze([
  "Akamatsu", "Arikoma", "Daitoh", "Fujimo", "Hakatain", "Haranen", "Ishukone", "Isuruku",
  "Kaikka", "Kaalaki", "Katsuragi", "Kigurosaka", "Kisune", "Kobayashi", "Korachi", "Lai Dai",
  "Maaten", "Mitsuda", "Nakamuta", "Noh", "Okusaika", "Onikori", "Otsada", "Raata",
  "Sakoda", "Seituoda", "Sukuuvestaa", "Tash Murkon", "Tennen", "Tovil", "Wiyrkomi", "Ytiri",
]);

const ROLE_TITLES = Object.freeze({
  shuttle: "Independent Shuttle Pilot",
  hauler: "Independent Freight Pilot",
  escort: "Corporate Escort Pilot",
  police: "Regional Security Patrol Pilot",
  miner: "Independent Mining Pilot",
  highsec_pirate: "Guristas Roaming Pilot",
});

const ROLE_CAPABILITIES = Object.freeze({
  shuttle: ["shuttle", "courier", "trade"],
  hauler: ["freight", "courier", "trade", "shuttle"],
  escort: ["escort", "patrol", "security_response", "courier"],
  police: ["patrol", "security_response", "escort"],
  miner: ["mining", "resource_survey", "industrial_haul", "shuttle"],
  mining_support: ["mining_support", "industrial_haul", "fleet_boost", "shuttle"],
  highsec_pirate: ["raiding", "combat", "smuggling", "scouting"],
});

let portraitAgentPool = null;
let portraitAgentSet = null;
let nameAuthorityCache = null;
const pilotsByCharacterID = new Map();
const pilotsBySystemID = new Map();
const pilotSourceByCharacterID = new Map();

function cloneValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function toPositiveInteger(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function normalizeSourceID(value) {
  const normalized = String(value || "").trim();
  return normalized || DEFAULT_PILOT_SOURCE_ID;
}

function rebuildPilotsBySystem() {
  pilotsBySystemID.clear();
  for (const pilot of pilotsByCharacterID.values()) {
    if (!pilot.localVisible || toPositiveInteger(pilot.solarSystemID, 0) <= 0) {
      continue;
    }
    if (!pilotsBySystemID.has(pilot.solarSystemID)) {
      pilotsBySystemID.set(pilot.solarSystemID, []);
    }
    pilotsBySystemID.get(pilot.solarSystemID).push(pilot);
  }
  for (const pilots of pilotsBySystemID.values()) {
    pilots.sort((left, right) => left.characterID - right.characterID);
  }
}

function getActorNumber(actor, fallbackIndex = 0) {
  const match = String(actor && actor.actorID || "").match(/(\d+)$/);
  return toPositiveInteger(match && match[1], toPositiveInteger(fallbackIndex, 1));
}

function loadPortraitAgentPool() {
  if (portraitAgentPool) {
    return portraitAgentPool;
  }
  const unique = new Set();
  try {
    const raw = fs.readFileSync(PORTRAIT_MANIFEST_PATH, "utf8");
    for (const match of raw.matchAll(/"agentID"\s*:\s*(\d+)/g)) {
      const agentID = toPositiveInteger(match[1], 0);
      if (agentID > 0) {
        unique.add(agentID);
      }
    }
  } catch (error) {
    // The directory remains functional without the optional portrait authority.
  }
  portraitAgentPool = unique.size > 0
    ? [...unique]
    : [3008416, 3008417, 3008418, 3008419, 3008420, 3008421, 3008422, 3008423];
  portraitAgentSet = new Set(portraitAgentPool);
  return portraitAgentPool;
}

function deterministicShuffle(values, seed) {
  const shuffled = [...values];
  let state = Number(seed) >>> 0;
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

function buildNameAuthority() {
  if (nameAuthorityCache) {
    return nameAuthorityCache;
  }
  const givenNames = new Set();
  const familyNames = new Set();
  try {
    for (const agent of listAgents()) {
      const parts = String(agent && agent.ownerName || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const givenName = String(parts[0] || "").trim();
      const familyName = parts.slice(1).join(" ").trim();
      if (givenName.length >= 2 && givenName.length <= 20) {
        givenNames.add(givenName);
      }
      if (familyName.length >= 2 && familyName.length <= 24) {
        familyNames.add(familyName);
      }
    }
  } catch (error) {
    // The compact fallback remains available in reduced/static-data installs.
  }
  const resolvedGivenNames = givenNames.size >= 400
    ? [...givenNames]
    : [...GIVEN_NAMES];
  const resolvedFamilyNames = familyNames.size >= 400
    ? [...familyNames]
    : [...FAMILY_NAMES];
  nameAuthorityCache = {
    givenNames: deterministicShuffle(resolvedGivenNames, 0x4556454a),
    familyNames: deterministicShuffle(resolvedFamilyNames, 0x50494c4f),
  };
  return nameAuthorityCache;
}

function buildPilotName(actorNumber) {
  const zeroBased = Math.max(0, actorNumber - 1);
  const authority = buildNameAuthority();
  const givenName = authority.givenNames[zeroBased % authority.givenNames.length];
  const familyName = authority.familyNames[
    (zeroBased * 3_571 + 911) % authority.familyNames.length
  ];
  const maxFamilyLength = Math.max(2, 36 - givenName.length);
  return `${givenName} ${familyName.slice(0, maxFamilyLength)}`;
}

function buildCreatedAt(actorNumber) {
  const dayOffset = Math.max(0, actorNumber - 1) % 3650;
  return new Date(Date.UTC(2016, 0, 1 + dayOffset, 12, 0, 0)).toISOString();
}

function buildStablePilotIdentity(actor, actorNumber, profile = {}) {
  const portraitPool = loadPortraitAgentPool();
  const role = String(actor && actor.role || "traffic");
  const existing = actor && actor.pilot && typeof actor.pilot === "object"
    ? actor.pilot
    : {};
  const zeroBased = Math.max(0, actorNumber - 1);
  const existingCharacterID = toPositiveInteger(existing.characterID, 0);
  const isLegacyOutOfRangeCharacterID = (
    existingCharacterID > LEGACY_PILOT_CHARACTER_ID_BASE &&
    existingCharacterID <= LEGACY_PILOT_CHARACTER_ID_BASE + 5_000
  );
  const existingNameRevision = toPositiveInteger(existing.nameRevision, 0);
  const existingAffiliationRevision = toPositiveInteger(existing.affiliationRevision, 0);
  const existingPortraitRevision = toPositiveInteger(existing.portraitRevision, 0);
  const assignedCorporationID = toPositiveInteger(
    actor && actor.corporationID,
    toPositiveInteger(profile && profile.corporationID, DEFAULT_CORPORATION_ID),
  );
  const assignedFactionID = toPositiveInteger(
    actor && actor.factionID,
    toPositiveInteger(profile && profile.factionID, DEFAULT_FACTION_ID),
  );
  const assignedRaceID = toPositiveInteger(
    actor && actor.raceID,
    toPositiveInteger(profile && profile.raceID, 1),
  );
  const assignedAllianceID = toPositiveInteger(
    actor && actor.allianceID,
    toPositiveInteger(profile && profile.allianceID, 0),
  );
  const assignedWarFactionID = toPositiveInteger(
    actor && actor.warFactionID,
    toPositiveInteger(profile && profile.warFactionID, 0),
  );
  const hasAuthoredCorporationID =
    toPositiveInteger(actor && actor.corporationID, 0) > 0;
  const hasAuthoredAllianceID = Boolean(
    actor && Object.prototype.hasOwnProperty.call(actor, "allianceID"),
  );
  const hasAuthoredWarFactionID = Boolean(
    actor && Object.prototype.hasOwnProperty.call(actor, "warFactionID"),
  );
  const hasAuthoredFactionID =
    toPositiveInteger(actor && actor.factionID, 0) > 0;
  const hasAuthoredRaceID =
    toPositiveInteger(actor && actor.raceID, 0) > 0;
  const assignedTitle = role === "highsec_pirate" && String(actor && actor.factionName || "").trim()
    ? `${String(actor.factionName).trim()} Roaming Pilot`
    : ROLE_TITLES[role] || "Independent Capsuleer";
  return {
    characterID: isLegacyOutOfRangeCharacterID
      ? PILOT_CHARACTER_ID_BASE + actorNumber
      : toPositiveInteger(existingCharacterID, PILOT_CHARACTER_ID_BASE + actorNumber),
    characterName: existingNameRevision >= PILOT_NAME_REVISION
      ? String(existing.characterName || buildPilotName(actorNumber))
      : buildPilotName(actorNumber),
    nameRevision: PILOT_NAME_REVISION,
    gender: Number(existing.gender) === 0 || Number(existing.gender) === 1
      ? Number(existing.gender)
      : zeroBased % 2,
    typeID: toPositiveInteger(existing.typeID, OWNER_TYPE_ID),
    raceID: !hasAuthoredRaceID &&
      existingAffiliationRevision >= PILOT_AFFILIATION_REVISION
      ? toPositiveInteger(existing.raceID, assignedRaceID)
      : assignedRaceID,
    bloodlineID: toPositiveInteger(existing.bloodlineID, 1),
    ancestryID: toPositiveInteger(existing.ancestryID, 1),
    schoolID: toPositiveInteger(existing.schoolID, 11),
    corporationID: !hasAuthoredCorporationID &&
      existingAffiliationRevision >= PILOT_AFFILIATION_REVISION
      ? toPositiveInteger(existing.corporationID, assignedCorporationID)
      : assignedCorporationID,
    allianceID: hasAuthoredAllianceID
      ? assignedAllianceID
      : toPositiveInteger(existing.allianceID, assignedAllianceID),
    warFactionID: hasAuthoredWarFactionID
      ? assignedWarFactionID
      : toPositiveInteger(existing.warFactionID, assignedWarFactionID),
    factionID: !hasAuthoredFactionID &&
      existingAffiliationRevision >= PILOT_AFFILIATION_REVISION
      ? toPositiveInteger(existing.factionID, assignedFactionID)
      : assignedFactionID,
    affiliationRevision: PILOT_AFFILIATION_REVISION,
    securityStatus: Number.isFinite(Number(existing.securityStatus))
      ? Number(existing.securityStatus)
      : Number(profile && profile.securityStatus || 0),
    createDateTime: String(existing.createDateTime || buildCreatedAt(actorNumber)),
    portraitSourceCharacterID: existingPortraitRevision >= PILOT_PORTRAIT_REVISION &&
      portraitAgentSet.has(toPositiveInteger(existing.portraitSourceCharacterID, 0))
      ? toPositiveInteger(existing.portraitSourceCharacterID, 0)
      : portraitPool[zeroBased % portraitPool.length],
    portraitRevision: PILOT_PORTRAIT_REVISION,
    title: String(existing.title || assignedTitle),
  };
}

function hasCurrentStablePilotIdentity(actor) {
  const identity = actor && actor.pilot;
  if (!identity || typeof identity !== "object") {
    return false;
  }
  if (
    toPositiveInteger(identity.characterID, 0) <= 0 ||
    !String(identity.characterName || "").trim() ||
    toPositiveInteger(identity.nameRevision, 0) < PILOT_NAME_REVISION ||
    toPositiveInteger(identity.affiliationRevision, 0) < PILOT_AFFILIATION_REVISION ||
    toPositiveInteger(identity.portraitRevision, 0) < PILOT_PORTRAIT_REVISION ||
    toPositiveInteger(identity.portraitSourceCharacterID, 0) <= 0
  ) {
    return false;
  }
  const authoredAffiliations = [
    ["corporationID", "corporationID", false],
    ["allianceID", "allianceID", true],
    ["warFactionID", "warFactionID", true],
    ["factionID", "factionID", false],
    ["raceID", "raceID", false],
  ];
  return authoredAffiliations.every(([actorField, identityField, zeroIsAuthored]) => {
    if (
      zeroIsAuthored &&
      actor &&
      Object.prototype.hasOwnProperty.call(actor, actorField)
    ) {
      return toPositiveInteger(actor[actorField], 0) ===
        toPositiveInteger(identity[identityField], 0);
    }
    const authoredValue = toPositiveInteger(actor[actorField], 0);
    return authoredValue <= 0 ||
      authoredValue === toPositiveInteger(identity[identityField], 0);
  });
}

function resolvePilotCapabilities(actor) {
  const authored = Array.isArray(actor && actor.capabilities)
    ? actor.capabilities.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const role = String(actor && actor.role || "traffic");
  return [...new Set(authored.length > 0 ? authored : (ROLE_CAPABILITIES[role] || [role]))];
}

function buildPilotRecord(actor, identity, options = {}) {
  const role = String(actor && actor.role || "traffic");
  const factionID = toPositiveInteger(identity.factionID, 0) || null;
  const capabilities = resolvePilotCapabilities(actor);
  const presence = options.presence && typeof options.presence === "object"
    ? options.presence
    : {};
  const solarSystemID = toPositiveInteger(
    presence.solarSystemID,
    toPositiveInteger(actor && actor.currentSystemID, 0),
  );
  const stationID = toPositiveInteger(presence.stationID, 0) || null;
  const localVisible = presence.localVisible !== false && solarSystemID > 0;
  const assignment = String(
    presence.assignment || actor && actor.currentAssignment || role,
  ).trim() || role;
  return {
    characterID: identity.characterID,
    characterName: identity.characterName,
    ownerNameID: null,
    typeID: identity.typeID,
    gender: identity.gender,
    raceID: identity.raceID,
    bloodlineID: identity.bloodlineID,
    ancestryID: identity.ancestryID,
    schoolID: identity.schoolID,
    corporationID: identity.corporationID,
    allianceID: identity.allianceID || null,
    warFactionID: identity.warFactionID || null,
    militiaFactionID: identity.warFactionID || null,
    factionID,
    empireID: factionID,
    securityStatus: identity.securityStatus,
    securityRating: identity.securityStatus,
    createDateTime: identity.createDateTime,
    startDateTime: identity.createDateTime,
    solarSystemID,
    stationID,
    homeStationID: toPositiveInteger(actor && actor.homeStationID, 0) || null,
    homeStationName: String(actor && actor.homeStationName || ""),
    homeSolarSystemID: toPositiveInteger(actor && actor.homeSystemID, 0) || null,
    homeSolarSystemName: String(actor && actor.homeSystemName || ""),
    homeCorporationID: toPositiveInteger(actor && actor.corporationID, identity.corporationID),
    homeCorporationName: String(actor && actor.corporationName || ""),
    homeFactionID: toPositiveInteger(actor && actor.factionID, identity.factionID),
    homeFactionName: String(actor && actor.factionName || ""),
    description: `${identity.title}. Qualified for ${capabilities.join(", ")}; currently assigned to ${assignment}.`,
    title: identity.title,
    shortName: "none",
    bounty: 0,
    portraitSourceCharacterID: identity.portraitSourceCharacterID,
    syntheticNpcPilot: true,
    loginDisabled: true,
    accountID: 0,
    actorID: String(actor && actor.actorID || ""),
    role,
    capabilities,
    currentAssignment: assignment,
    presenceState: String(presence.state || (stationID ? "docked" : "in_space")),
    localVisible,
    corporationChatVisible: presence.corporationChatVisible === true,
    pilotSourceID: normalizeSourceID(options.sourceID),
  };
}

function syncActors(actors = [], options = {}) {
  const sourceID = normalizeSourceID(options.sourceID);
  const list = (Array.isArray(actors) ? actors : Object.values(actors || {}))
    .filter((actor) => actor && typeof actor === "object")
    .sort((left, right) => getActorNumber(left, 1) - getActorNumber(right, 1));
  const nextByCharacterID = new Map();
  let identitiesChanged = false;

  for (let index = 0; index < list.length; index += 1) {
    const actor = list[index];
    const actorNumber = getActorNumber(actor, index + 1);
    const reusableIdentity = hasCurrentStablePilotIdentity(actor)
      ? actor.pilot
      : null;
    const profile = !reusableIdentity && typeof options.getProfile === "function"
      ? options.getProfile(actor.profileID, actor) || {}
      : {};
    const identity = reusableIdentity ||
      buildStablePilotIdentity(actor, actorNumber, profile);
    if (!reusableIdentity) {
      actor.pilot = cloneValue(identity);
      identitiesChanged = true;
    }
    const record = buildPilotRecord(actor, identity, {
      sourceID,
      presence: typeof options.resolvePresence === "function"
        ? options.resolvePresence(actor) || {}
        : {},
    });
    nextByCharacterID.set(record.characterID, record);
  }

  const removedCharacterIDs = [];
  for (const [characterID, existingSourceID] of pilotSourceByCharacterID) {
    if (existingSourceID !== sourceID || nextByCharacterID.has(characterID)) {
      continue;
    }
    pilotsByCharacterID.delete(characterID);
    pilotSourceByCharacterID.delete(characterID);
    removedCharacterIDs.push(characterID);
  }
  for (const [characterID, pilot] of nextByCharacterID) {
    pilotsByCharacterID.set(characterID, pilot);
    pilotSourceByCharacterID.set(characterID, sourceID);
  }
  rebuildPilotsBySystem();

  return {
    sourceID,
    identitiesChanged,
    pilots: [...nextByCharacterID.values()].map(cloneValue),
    removedCharacterIDs,
  };
}

function syncActorChanges(actors = [], options = {}) {
  const sourceID = normalizeSourceID(options.sourceID);
  const list = (Array.isArray(actors) ? actors : Object.values(actors || {}))
    .filter((actor) => actor && typeof actor === "object");
  const changedCharacterIDs = new Set();
  const affectedSystemIDs = new Set();
  const changedVisiblePilotsBySystemID = new Map();
  const changedPilots = [];
  let identitiesChanged = false;

  for (let index = 0; index < list.length; index += 1) {
    const actor = list[index];
    const actorNumber = getActorNumber(actor, index + 1);
    const reusableIdentity = hasCurrentStablePilotIdentity(actor)
      ? actor.pilot
      : null;
    const profile = !reusableIdentity && typeof options.getProfile === "function"
      ? options.getProfile(actor.profileID, actor) || {}
      : {};
    const identity = reusableIdentity ||
      buildStablePilotIdentity(actor, actorNumber, profile);
    if (!reusableIdentity) {
      actor.pilot = cloneValue(identity);
      identitiesChanged = true;
    }
    const record = buildPilotRecord(actor, identity, {
      sourceID,
      presence: typeof options.resolvePresence === "function"
        ? options.resolvePresence(actor) || {}
        : {},
    });
    const previous = pilotsByCharacterID.get(record.characterID) || null;
    pilotSourceByCharacterID.set(record.characterID, sourceID);
    if (previous && previous.localVisible && previous.solarSystemID > 0) {
      affectedSystemIDs.add(previous.solarSystemID);
    }
    if (record.localVisible && record.solarSystemID > 0) {
      affectedSystemIDs.add(record.solarSystemID);
    }
    if (previous && JSON.stringify(previous) === JSON.stringify(record)) {
      continue;
    }
    pilotsByCharacterID.set(record.characterID, record);
    changedCharacterIDs.add(record.characterID);
    changedPilots.push(cloneValue(record));
    if (record.localVisible && record.solarSystemID > 0) {
      if (!changedVisiblePilotsBySystemID.has(record.solarSystemID)) {
        changedVisiblePilotsBySystemID.set(record.solarSystemID, []);
      }
      changedVisiblePilotsBySystemID.get(record.solarSystemID).push(record);
    }
  }

  if (changedCharacterIDs.size > 0) {
    for (const systemID of affectedSystemIDs) {
      const nextPilots = (pilotsBySystemID.get(systemID) || [])
        .filter((pilot) => !changedCharacterIDs.has(pilot.characterID));
      nextPilots.push(...(changedVisiblePilotsBySystemID.get(systemID) || []));
      nextPilots.sort((left, right) => left.characterID - right.characterID);
      if (nextPilots.length > 0) {
        pilotsBySystemID.set(systemID, nextPilots);
      } else {
        pilotsBySystemID.delete(systemID);
      }
    }
  }

  return {
    sourceID,
    identitiesChanged,
    pilots: changedPilots,
    affectedSystemIDs: [...affectedSystemIDs],
  };
}

function getPilotRecord(characterID) {
  const pilot = pilotsByCharacterID.get(toPositiveInteger(characterID, 0));
  return pilot ? cloneValue(pilot) : null;
}

function listPilotsForSystem(systemID) {
  return (pilotsBySystemID.get(toPositiveInteger(systemID, 0)) || []).map(cloneValue);
}

function listPilots() {
  return [...pilotsByCharacterID.values()].map(cloneValue);
}

function removePilots(characterIDs = [], options = {}) {
  const sourceID = options.sourceID === undefined
    ? null
    : normalizeSourceID(options.sourceID);
  const removed = [];
  for (const value of Array.isArray(characterIDs) ? characterIDs : [characterIDs]) {
    const characterID = toPositiveInteger(value, 0);
    if (!characterID || !pilotsByCharacterID.has(characterID)) {
      continue;
    }
    if (
      sourceID &&
      pilotSourceByCharacterID.get(characterID) !== sourceID
    ) {
      continue;
    }
    const pilot = pilotsByCharacterID.get(characterID);
    pilotsByCharacterID.delete(characterID);
    pilotSourceByCharacterID.delete(characterID);
    removed.push(cloneValue(pilot));
  }
  if (removed.length > 0) {
    rebuildPilotsBySystem();
  }
  return {
    sourceID,
    removed,
    removedCharacterIDs: removed.map((pilot) => pilot.characterID),
  };
}

function getPortraitSourceCharacterID(characterID) {
  const pilot = pilotsByCharacterID.get(toPositiveInteger(characterID, 0));
  return pilot ? toPositiveInteger(pilot.portraitSourceCharacterID, 0) : 0;
}

function clear(options = {}) {
  if (options && options.sourceID !== undefined) {
    const sourceID = normalizeSourceID(options.sourceID);
    const characterIDs = [...pilotSourceByCharacterID]
      .filter(([, pilotSourceID]) => pilotSourceID === sourceID)
      .map(([characterID]) => characterID);
    return removePilots(characterIDs, { sourceID });
  }
  const removed = [...pilotsByCharacterID.values()].map(cloneValue);
  pilotsByCharacterID.clear();
  pilotsBySystemID.clear();
  pilotSourceByCharacterID.clear();
  return {
    sourceID: null,
    removed,
    removedCharacterIDs: removed.map((pilot) => pilot.characterID),
  };
}

module.exports = {
  PILOT_CHARACTER_ID_BASE,
  PILOT_AFFILIATION_REVISION,
  DEFAULT_PILOT_SOURCE_ID,
  PILOT_NAME_REVISION,
  PILOT_PORTRAIT_REVISION,
  PORTRAIT_MANIFEST_PATH,
  clear,
  getPilotRecord,
  getPortraitSourceCharacterID,
  listPilots,
  listPilotsForSystem,
  loadPortraitAgentPool,
  removePilots,
  syncActorChanges,
  syncActors,
  _testing: {
    buildPilotRecord,
    buildPilotName,
    buildNameAuthority,
    buildStablePilotIdentity,
    getActorNumber,
    resolvePilotCapabilities,
  },
};
