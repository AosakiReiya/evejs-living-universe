"use strict";

// Resident track R1: per-player faction hostility ("taking sides").
//
// Two independent hostility sources, evaluated per (character, faction):
//   1. Aggression timer — attacking one side of a living encounter marks that side's faction
//      hostile to the attacker INSTANTLY for config.livingHostilityMinutes (refreshed on repeat
//      aggression). In-memory only: a restart clears active timers, which is acceptable for a
//      15-minute window (the standings half below is inherently persistent).
//   2. Standings floor — when the character's effective standing with the faction is below
//      config.livingHostilityStandingFloor, the faction is shoot-on-sight until the standing is
//      repaired (see factionKillStandingRuntime for the gain path).
//
// isHostile() sits on the NPC targeting hot path (npcBehaviorLoop.isValidCombatTarget), so the
// standings read is cached with a short TTL. The timer half is a plain Map lookup.
//
// This module owns only hostility state + the player-identity helper; targeting enforcement lives
// in npcBehaviorLoop and the declaration trigger lives in npcService.noteNpcIncomingAggression.

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const standingRuntime = require(path.join(__dirname, "./standingRuntime"));
const sessionRegistry = require(path.join(__dirname, "../chat/sessionRegistry"));

const STANDING_CACHE_TTL_MS = 30 * 1000;
// Per-key deterministic TTL spread: without it every (player, faction) entry written in the
// same targeting scan expires in the same later scan, and one behavior think then pays ALL the
// standings re-reads back-to-back (each miss round-trips the character record). Spreading the
// expiries keeps the worst case at ~one miss per think.
const STANDING_CACHE_TTL_JITTER_MS = 15 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

// `${characterID}:${factionID}` -> hostileUntilMs (wall clock)
const hostileUntilByKey = new Map();
// `${characterID}:${factionID}` -> { standing, expiresAtMs }
const standingCache = new Map();
let lastSweepAtMs = 0;

const metrics = {
  declarations: 0,
  refreshes: 0,
  standingFloorChecks: 0,
};

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function isEnabled() {
  return config.livingHostilityEnabled === true;
}

function getHostilityWindowMs() {
  const minutes = toFiniteNumber(config.livingHostilityMinutes, 15);
  return Math.max(60 * 1000, Math.trunc(minutes * 60 * 1000));
}

function getStandingFloor() {
  const floor = toFiniteNumber(config.livingHostilityStandingFloor, -5);
  return Math.max(-10, Math.min(0, floor));
}

// A characterID counts as a real player only while a live session owns it. Living-universe pilots
// reuse the character-ID shape for ownerID/npcPilotCharacterID but never hold sessions, so this is
// the one test that cleanly separates residents from simulated pilots.
function isActivePlayerCharacterID(characterID) {
  const normalized = toPositiveInt(characterID, 0);
  if (!normalized) {
    return false;
  }
  if (typeof sessionRegistry.findSessionByCharacterID === "function") {
    return Boolean(sessionRegistry.findSessionByCharacterID(normalized));
  }
  return sessionRegistry.getSessions().some((session) => (
    toPositiveInt(session && session.characterID, 0) === normalized
  ));
}

// Resolve the acting player character behind an attacking entity: a piloted ship carries a
// session; a player drone or fighter carries its owner/controller characterID (NPC drones and
// fighters carry simulated-pilot IDs that fail the live-session test above — living NPC SHIPS
// also fail it, since simulated pilots never hold sessions). Returns 0 when the attacker is not
// a player. This is the single player-identity test for hostility declaration, kill-credit
// staging, and the standing-gain path — keep them consistent.
function resolveAttackerPlayerCharacterID(attackerEntity) {
  if (!attackerEntity) {
    return 0;
  }
  const sessionCharacterID = toPositiveInt(
    attackerEntity.session && attackerEntity.session.characterID,
    0,
  );
  if (sessionCharacterID) {
    return sessionCharacterID;
  }
  const kind = String(attackerEntity.kind || "");
  if (kind !== "drone" && kind !== "fighter") {
    return 0;
  }
  const ownerCharacterID = toPositiveInt(
    attackerEntity.controllerOwnerID,
    toPositiveInt(attackerEntity.ownerID, 0),
  );
  return isActivePlayerCharacterID(ownerCharacterID) ? ownerCharacterID : 0;
}

function buildKey(characterID, factionID) {
  return `${characterID}:${factionID}`;
}

function sweepExpired(nowMs) {
  if (nowMs - lastSweepAtMs < SWEEP_INTERVAL_MS) {
    return;
  }
  lastSweepAtMs = nowMs;
  for (const [key, untilMs] of hostileUntilByKey) {
    if (untilMs <= nowMs) {
      hostileUntilByKey.delete(key);
    }
  }
  for (const [key, entry] of standingCache) {
    if (!entry || entry.expiresAtMs <= nowMs) {
      standingCache.delete(key);
    }
  }
}

// Set/refresh the aggression timer. Returns a small result object, or null when nothing applied.
function markHostile(characterID, factionID, nowMs = Date.now()) {
  if (!isEnabled()) {
    return null;
  }
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  const normalizedFactionID = toPositiveInt(factionID, 0);
  if (!normalizedCharacterID || !normalizedFactionID) {
    return null;
  }
  sweepExpired(nowMs);
  const key = buildKey(normalizedCharacterID, normalizedFactionID);
  const previousUntilMs = toFiniteNumber(hostileUntilByKey.get(key), 0);
  const hostileUntilMs = nowMs + getHostilityWindowMs();
  hostileUntilByKey.set(key, hostileUntilMs);
  const refreshed = previousUntilMs > nowMs;
  if (refreshed) {
    metrics.refreshes += 1;
  } else {
    metrics.declarations += 1;
  }
  return {
    characterID: normalizedCharacterID,
    factionID: normalizedFactionID,
    hostileUntilMs,
    refreshed,
  };
}

function isTimerHostile(characterID, factionID, nowMs) {
  const key = buildKey(toPositiveInt(characterID, 0), toPositiveInt(factionID, 0));
  const untilMs = hostileUntilByKey.get(key);
  if (!Number.isFinite(untilMs)) {
    return false;
  }
  if (untilMs <= nowMs) {
    hostileUntilByKey.delete(key);
    return false;
  }
  return true;
}

function standingCacheTtlFor(key) {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) - hash + key.charCodeAt(index)) | 0;
  }
  return STANDING_CACHE_TTL_MS + (Math.abs(hash) % STANDING_CACHE_TTL_JITTER_MS);
}

function getCachedEffectiveStanding(characterID, factionID, nowMs) {
  const key = buildKey(characterID, factionID);
  const cached = standingCache.get(key);
  if (cached && cached.expiresAtMs > nowMs) {
    return cached.standing;
  }
  metrics.standingFloorChecks += 1;
  let standing = 0;
  try {
    const result = standingRuntime.getCharacterEffectiveStanding(characterID, factionID);
    standing = toFiniteNumber(result && result.standing, 0);
  } catch (error) {
    // A standings read failure must never break targeting; treat as neutral.
    standing = 0;
  }
  standingCache.set(key, {
    standing,
    expiresAtMs: nowMs + standingCacheTtlFor(key),
  });
  return standing;
}

// The single hostility read: aggression timer active OR persistent standing below the floor.
function isHostile(characterID, factionID, nowMs = Date.now()) {
  if (!isEnabled()) {
    return false;
  }
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  const normalizedFactionID = toPositiveInt(factionID, 0);
  if (!normalizedCharacterID || !normalizedFactionID) {
    return false;
  }
  sweepExpired(nowMs);
  if (isTimerHostile(normalizedCharacterID, normalizedFactionID, nowMs)) {
    return true;
  }
  return getCachedEffectiveStanding(normalizedCharacterID, normalizedFactionID, nowMs) <
    getStandingFloor();
}

// Status/debug view: every faction currently timer-hostile to the character.
function getHostileFactionTimers(characterID, nowMs = Date.now()) {
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (!normalizedCharacterID) {
    return [];
  }
  const prefix = `${normalizedCharacterID}:`;
  const entries = [];
  for (const [key, untilMs] of hostileUntilByKey) {
    if (!key.startsWith(prefix) || untilMs <= nowMs) {
      continue;
    }
    entries.push({
      factionID: toPositiveInt(key.slice(prefix.length), 0),
      hostileUntilMs: untilMs,
      remainingMs: untilMs - nowMs,
    });
  }
  return entries.sort((left, right) => right.remainingMs - left.remainingMs);
}

function getMetrics() {
  return {
    ...metrics,
    activeTimers: hostileUntilByKey.size,
  };
}

// Test/maintenance hooks.
function _reset() {
  hostileUntilByKey.clear();
  standingCache.clear();
  lastSweepAtMs = 0;
  metrics.declarations = 0;
  metrics.refreshes = 0;
  metrics.standingFloorChecks = 0;
}

function _invalidateStandingCache(characterID, factionID) {
  if (characterID && factionID) {
    standingCache.delete(buildKey(toPositiveInt(characterID, 0), toPositiveInt(factionID, 0)));
    return;
  }
  standingCache.clear();
}

module.exports = {
  isEnabled,
  getHostilityWindowMs,
  getStandingFloor,
  isActivePlayerCharacterID,
  resolveAttackerPlayerCharacterID,
  markHostile,
  isHostile,
  getHostileFactionTimers,
  getMetrics,
  _reset,
  _invalidateStandingCache,
};
