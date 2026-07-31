"use strict";

// Resident track R1: short-lived player kill-credit map for living-universe losses.
//
// Living loss accounting is absence-based (collectConflictLosses / handleLoss observe that an
// entity vanished, not who destroyed it). The killmail tracker is the honest final-attacker
// source, so recordKillmailFromDestruction writes actorID -> killerCharacterID here at the
// moment of destruction and the living runtime consumes the entry when it books the loss.
// Metrics can then split player kills from cleanup, and R3 rescue verification reads the same
// attribution.
//
// Entries are in-memory with a TTL comfortably longer than the gap between destruction and the
// living runtime's loss sweep. A restart loses pending credits (the loss is then booked as
// unattributed), which only understates player credit — never double-counts.

const TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

// actorID -> { characterID, recordedAtMs }
const creditByActorID = new Map();
let lastSweepAtMs = 0;

const metrics = {
  recorded: 0,
  consumed: 0,
  expired: 0,
};

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function sweepExpired(nowMs) {
  if (nowMs - lastSweepAtMs < SWEEP_INTERVAL_MS) {
    return;
  }
  lastSweepAtMs = nowMs;
  for (const [actorID, entry] of creditByActorID) {
    if (!entry || nowMs - entry.recordedAtMs > TTL_MS) {
      creditByActorID.delete(actorID);
      metrics.expired += 1;
    }
  }
}

function recordPlayerKillCredit(actorID, characterID, nowMs = Date.now()) {
  const normalizedActorID = String(actorID || "").trim();
  const normalizedCharacterID = toPositiveInt(characterID, 0);
  if (!normalizedActorID || !normalizedCharacterID) {
    return false;
  }
  sweepExpired(nowMs);
  creditByActorID.set(normalizedActorID, {
    characterID: normalizedCharacterID,
    recordedAtMs: nowMs,
  });
  metrics.recorded += 1;
  return true;
}

// Consume (and remove) the credit for a living actor's loss. Returns the killer characterID or 0.
function consumeKillCredit(actorID, nowMs = Date.now()) {
  const normalizedActorID = String(actorID || "").trim();
  if (!normalizedActorID) {
    return 0;
  }
  sweepExpired(nowMs);
  const entry = creditByActorID.get(normalizedActorID);
  if (!entry) {
    return 0;
  }
  creditByActorID.delete(normalizedActorID);
  if (nowMs - entry.recordedAtMs > TTL_MS) {
    metrics.expired += 1;
    return 0;
  }
  metrics.consumed += 1;
  return entry.characterID;
}

function peekKillCredit(actorID) {
  const entry = creditByActorID.get(String(actorID || "").trim());
  return entry ? entry.characterID : 0;
}

function getMetrics() {
  return {
    ...metrics,
    pending: creditByActorID.size,
  };
}

// Test/maintenance hook.
function _reset() {
  creditByActorID.clear();
  lastSweepAtMs = 0;
  metrics.recorded = 0;
  metrics.consumed = 0;
  metrics.expired = 0;
}

module.exports = {
  recordPlayerKillCredit,
  consumeKillCredit,
  peekKillCredit,
  getMetrics,
  TTL_MS,
  _reset,
};
