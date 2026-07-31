"use strict";

// Faction standing loss when a player destroys a faction NPC (TQ parity).
//
// Mechanic (calibrated against two independent golden mission logs — AlluringEmanationsLevel1 and
// GoneBerserkLevel1; see tools/TQMissionLogDecoder/docs/COMBAT_MISSION_GAPS.md):
//   - Killing a faction NPC lowers the killer's standing with that NPC's faction ONLY. The golden
//     logs emit exactly one OnNPCStandingChange per combat kill — (500010, new, old) — with NO
//     derived propagation to allies or enemies. (The positive agent/corp OnNPCStandingChange lines
//     later in the same logs are mission-COMPLETION rewards, a separate mechanic.) So we apply the
//     direct hit only, with { disableDerived: true }.
//   - The applied raw modification is a FIXED per-entity base value. CCP's true per-entity table is
//     unpublished and not in the SDE; we use config.factionStandingLossPerKillRaw uniformly. Both
//     golden kills reproduce -0.00006875 exactly via new = S + (10 + S) * base:
//       Alluring:    (10 - 1.6405272743884327) * -0.00006875 -> -1.6411019881383184  (log match)
//       GoneBerserk: (10 - 1.6416766623766341) * -0.00006875 -> -1.6422512971060956  (log match)
//   - The (10 + S) distance-to-floor scaling lives in standingRuntime.calculateStandingsByRawChange.
//   - Debounced per (character, faction, system) on a 10-minute window: only one kill's loss lands
//     per window (matches TQ, where a mission's many same-faction kills produce a single hit).
//
// This module owns only the trigger + debounce; the standing math lives in standingRuntime.

const path = require("path");

const config = require(path.join(__dirname, "../../config"));
const standingRuntime = require(path.join(__dirname, "./standingRuntime"));
const npcStandingsAuthority = require(path.join(__dirname, "./npcStandingsAuthority"));
const factionState = require(path.join(__dirname, "../faction/factionState"));

const EVENT_STANDING_COMBAT_AGGRESSION = 76;
const DEBOUNCE_WINDOW_MS = 10 * 60 * 1000;
// Resident track R1 gain path: a "designated enemy" is a faction the victim faction's own
// authored relations mark at or below this standing. The shipped npcStandingsAuthority payload
// expresses enmity as exactly -1 (sources executiveEnemyFaction / enemyID; global minimum is -1),
// so the threshold MUST be -1 — anything stronger filters every relation out and kills the gain
// path silently. At most ENEMY_FACTION_GAIN_LIMIT enemies receive the gain, ordered by strongest
// enmity, then executiveEnemyFaction (the designated arch-enemy) ahead of ordinary enemy rows,
// then lowest toID — a total order, so ties never pick nondeterministically.
const ENEMY_RELATION_MAX_STANDING = -1;
const ENEMY_FACTION_GAIN_LIMIT = 2;

function enemySourceRank(relation) {
  return String(relation && relation.source || "") === "executiveEnemyFaction" ? 0 : 1;
}

// (characterID:factionID:systemID) -> { appliedAtMs, wallMs }. appliedAtMs is the CALLER's
// clock (the destruction pipeline passes per-scene sim time, which lags wall clock under
// dilation) and is only ever compared against the same caller's later timestamps, so the
// per-key debounce stays consistent. wallMs is a Date.now() stamp used exclusively by the
// sweep: sweeping on a caller clock would delete other scenes' still-valid entries whenever
// their clocks disagree. Retention is 12x the window — at the 0.1 dilation floor a 10-minute
// sim window spans up to 100 wall-minutes, so nothing debounce-valid is ever swept early.
// In-memory: a restart clears the debounce (worst case one extra hit lands), which is harmless.
// Without the sweep, roaming hunters would accrete keys (loss + "gain:" namespaces) for every
// system visited, forever.
const lastAppliedByKey = new Map();
const DEBOUNCE_SWEEP_INTERVAL_MS = 60 * 1000;
const DEBOUNCE_RETENTION_MS = 12 * DEBOUNCE_WINDOW_MS;
let lastDebounceSweepAtWallMs = 0;

function sweepExpiredDebounce() {
  const nowWallMs = Date.now();
  if (nowWallMs - lastDebounceSweepAtWallMs < DEBOUNCE_SWEEP_INTERVAL_MS) {
    return;
  }
  lastDebounceSweepAtWallMs = nowWallMs;
  for (const [key, entry] of lastAppliedByKey) {
    if (
      !entry ||
      !Number.isFinite(entry.wallMs) ||
      nowWallMs - entry.wallMs >= DEBOUNCE_RETENTION_MS
    ) {
      lastAppliedByKey.delete(key);
    }
  }
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

// Resolve the NPC's faction: rats carry it as warFactionID (npcPresentation); fall back to the
// corp -> faction mapping. Non-faction entities (warFactionID 0, e.g. EoM) resolve to 0 -> skipped.
function resolveVictimFactionID(victimEntity) {
  const direct = toPositiveInt(victimEntity && victimEntity.warFactionID, 0)
    || toPositiveInt(victimEntity && victimEntity.factionID, 0);
  if (direct) {
    return direct;
  }
  const corporationID = toPositiveInt(victimEntity && victimEntity.corporationID, 0);
  if (corporationID) {
    return toPositiveInt(standingRuntime.getOwnerFactionID(corporationID), 0);
  }
  return 0;
}

// Apply faction-standing loss for one NPC kill. Returns a small result object or null when nothing
// was applied (disabled, non-faction victim, no killer, or debounced within the window).
function recordNpcFactionStandingLoss(victimEntity = {}, killerCharacterID, options = {}) {
  if (config.factionStandingLossOnKillEnabled !== true) {
    return null;
  }
  const characterID = toPositiveInt(killerCharacterID, 0);
  if (!characterID) {
    return null;
  }
  const factionID = resolveVictimFactionID(victimEntity);
  if (!factionID) {
    return null;
  }
  const systemID = toPositiveInt(
    options.systemID,
    toPositiveInt(victimEntity && victimEntity.systemID, 0),
  );
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.trunc(Number(options.nowMs)) : Date.now();
  sweepExpiredDebounce();

  // Debounce per (character, faction, system) on a 10-minute window.
  const key = `${characterID}:${factionID}:${systemID}`;
  const lastEntry = lastAppliedByKey.get(key);
  const lastMs = lastEntry ? lastEntry.appliedAtMs : NaN;
  if (Number.isFinite(lastMs) && nowMs - lastMs < DEBOUNCE_WINDOW_MS) {
    return { applied: false, debounced: true, characterID, factionID, systemID };
  }

  const rawChange = Number(config.factionStandingLossPerKillRaw);
  if (!Number.isFinite(rawChange) || rawChange >= 0) {
    return null;
  }

  let result;
  try {
    result = standingRuntime.applyStandingChanges(
      characterID,
      [
        {
          ownerID: factionID,
          rawChange,
          eventTypeID: EVENT_STANDING_COMBAT_AGGRESSION,
          applySocial: false, // standing LOSS is not reduced by the Social skill
          msg: "Combat aggression",
          int_1: toPositiveInt(victimEntity && victimEntity.typeID, null),
        },
      ],
      // Golden logs show a single-faction hit with no derived propagation for combat kills.
      { disableDerived: true },
    );
  } catch (error) {
    // Best-effort: a standing-apply failure must never break the kill pipeline.
    return null;
  }

  if (!result || result.success !== true) {
    return null;
  }
  lastAppliedByKey.set(key, { appliedAtMs: nowMs, wallMs: Date.now() });
  return {
    applied: true,
    characterID,
    factionID,
    systemID,
    rawChange,
    changes: result.appliedChanges || result.data || null,
  };
}

// Resident track R1 (config-gated, NOT TQ parity): the same kill grants a small standing gain
// with the victim faction's designated enemies, giving residents a combat path to repair or build
// empire standing by hunting pirates. Applied per enemy faction with the same 10-minute
// (character, faction, system) debounce idiom as the loss path, using a "gain:"-prefixed key so
// gain and loss windows never suppress each other. Returns applied results, or null.
function recordNpcFactionStandingGains(victimEntity = {}, killerCharacterID, options = {}) {
  if (config.factionStandingGainOnKillEnabled !== true) {
    return null;
  }
  const characterID = toPositiveInt(killerCharacterID, 0);
  if (!characterID) {
    return null;
  }
  const victimFactionID = resolveVictimFactionID(victimEntity);
  if (!victimFactionID) {
    return null;
  }
  const rawChange = Number(config.factionStandingGainPerKillRaw);
  if (!Number.isFinite(rawChange) || rawChange <= 0) {
    return null;
  }
  const systemID = toPositiveInt(
    options.systemID,
    toPositiveInt(victimEntity && victimEntity.systemID, 0),
  );
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Math.trunc(Number(options.nowMs)) : Date.now();
  sweepExpiredDebounce();

  let enemyFactionIDs;
  try {
    enemyFactionIDs = npcStandingsAuthority.getRelationsForOwner(victimFactionID)
      .filter((relation) => (
        Number.isFinite(relation && relation.standing) &&
        relation.standing <= ENEMY_RELATION_MAX_STANDING &&
        factionState.isFactionID(toPositiveInt(relation && relation.toID, 0))
      ))
      .sort((left, right) => (
        (left.standing - right.standing) ||
        (enemySourceRank(left) - enemySourceRank(right)) ||
        (toPositiveInt(left.toID, 0) - toPositiveInt(right.toID, 0))
      ))
      .slice(0, ENEMY_FACTION_GAIN_LIMIT)
      .map((relation) => toPositiveInt(relation.toID, 0))
      .filter(Boolean);
  } catch (error) {
    return null;
  }
  if (!enemyFactionIDs.length) {
    return null;
  }

  const applied = [];
  for (const enemyFactionID of enemyFactionIDs) {
    const key = `gain:${characterID}:${enemyFactionID}:${systemID}`;
    const lastEntry = lastAppliedByKey.get(key);
    const lastMs = lastEntry ? lastEntry.appliedAtMs : NaN;
    if (Number.isFinite(lastMs) && nowMs - lastMs < DEBOUNCE_WINDOW_MS) {
      continue;
    }
    let result;
    try {
      result = standingRuntime.applyStandingChanges(
        characterID,
        [
          {
            ownerID: enemyFactionID,
            rawChange,
            eventTypeID: EVENT_STANDING_COMBAT_AGGRESSION,
            applySocial: false,
            msg: "Combat assistance",
            int_1: toPositiveInt(victimEntity && victimEntity.typeID, null),
          },
        ],
        { disableDerived: true },
      );
    } catch (error) {
      // Best-effort: a standing-apply failure must never break the kill pipeline.
      continue;
    }
    if (!result || result.success !== true) {
      continue;
    }
    lastAppliedByKey.set(key, { appliedAtMs: nowMs, wallMs: Date.now() });
    applied.push({
      factionID: enemyFactionID,
      rawChange,
      changes: result.appliedChanges || result.data || null,
    });
  }
  if (!applied.length) {
    return null;
  }
  return {
    applied: true,
    characterID,
    victimFactionID,
    systemID,
    gains: applied,
  };
}

// Test/maintenance hook.
function _resetDebounce() {
  lastAppliedByKey.clear();
  lastDebounceSweepAtWallMs = 0;
}

module.exports = {
  recordNpcFactionStandingLoss,
  recordNpcFactionStandingGains,
  resolveVictimFactionID,
  DEBOUNCE_WINDOW_MS,
  _resetDebounce,
};
