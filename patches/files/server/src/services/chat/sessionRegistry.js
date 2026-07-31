// Live session registry — the source of truth for connected retail transports.
// Character control and online presence are derived through
// online/characterControlRuntime so browser-pilot leases never need fake
// sessions in this registry.
//
// In addition to the membership Set, an eager characterID -> sessions index is
// maintained so the hot presence lookups (gateway notice routing, online status,
// XMPP client matching, the duplicate-login guard) resolve in O(1) instead of an
// O(N) scan per call. The index is kept complete by:
//   - register(): indexes a session that already carries a characterID,
//   - applyCharacterToSession()/clearCharacterFromSession(): call
//     indexCharacterSession()/deindexCharacterSession() when binding/clearing,
//   - unregister(): removes the session from its bucket.
// findSessionByCharacterID() still falls back to a full scan when the bucket is
// empty, so a session whose characterID was ever set outside those hooks is
// never missed — the index only accelerates, it never changes results.

const sessions = new Set();
const sessionsByCharacterID = new Map(); // characterID -> Set<session>
const characterIDBySession = new Map(); // session -> characterID it is indexed under

function isTrackedControlSession(session) {
  return Boolean(
    session &&
    session.socket &&
    session._characterControlDisconnected !== true,
  );
}

function isLiveSession(session) {
  return Boolean(
    isTrackedControlSession(session) &&
    !session.socket.destroyed,
  );
}

function toSessionTimestamp(value) {
  const numericValue = Number(value || 0);
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function resolveSessionCharacterID(session) {
  if (!session) {
    return 0;
  }

  return Number(
    session.characterID ||
    session.charID ||
    session.charid ||
    0,
  ) || 0;
}

function isPreferredCharacterSession(candidate, current) {
  if (!candidate) {
    return false;
  }
  if (!current) {
    return true;
  }

  const candidateLastActivity = toSessionTimestamp(candidate.lastActivity);
  const currentLastActivity = toSessionTimestamp(current.lastActivity);
  if (candidateLastActivity !== currentLastActivity) {
    return candidateLastActivity > currentLastActivity;
  }

  const candidateConnectTime = toSessionTimestamp(candidate.connectTime);
  const currentConnectTime = toSessionTimestamp(current.connectTime);
  if (candidateConnectTime !== currentConnectTime) {
    return candidateConnectTime > currentConnectTime;
  }

  const candidateClientID = Number(candidate.clientID || candidate.clientId || 0) || 0;
  const currentClientID = Number(current.clientID || current.clientId || 0) || 0;
  return candidateClientID >= currentClientID;
}

function addToIndex(session, characterID) {
  let bucket = sessionsByCharacterID.get(characterID);
  if (!bucket) {
    bucket = new Set();
    sessionsByCharacterID.set(characterID, bucket);
  }
  bucket.add(session);
  characterIDBySession.set(session, characterID);
}

function removeFromIndex(session) {
  const previousCharacterID = characterIDBySession.get(session);
  if (previousCharacterID === undefined) {
    return;
  }
  characterIDBySession.delete(session);
  const bucket = sessionsByCharacterID.get(previousCharacterID);
  if (!bucket) {
    return;
  }
  bucket.delete(session);
  if (bucket.size === 0) {
    sessionsByCharacterID.delete(previousCharacterID);
  }
}

function indexCharacterSession(session) {
  if (!session) {
    return;
  }
  const characterID = resolveSessionCharacterID(session);
  if (characterIDBySession.get(session) === characterID) {
    return;
  }
  removeFromIndex(session);
  if (characterID > 0) {
    addToIndex(session, characterID);
  }
}

function deindexCharacterSession(session) {
  removeFromIndex(session);
}

function register(session) {
  if (session) {
    sessions.add(session);
    indexCharacterSession(session);
  }
}

function unregister(session) {
  if (session) {
    sessions.delete(session);
    removeFromIndex(session);
  }
}

function getSessions() {
  return Array.from(sessions).filter(isLiveSession);
}

function isRegisteredSession(session) {
  return sessions.has(session);
}

function isCharacterSessionIndexed(session, characterID) {
  const expectedCharacterID = Number(characterID || 0);
  return expectedCharacterID > 0 &&
    characterIDBySession.get(session) === expectedCharacterID;
}

function selectPreferredFrom(
  candidates,
  targetCharacterID,
  excludedSession,
  options = {},
) {
  let selectedSession = null;
  const isEligible = options.includeClosing === true
    ? isTrackedControlSession
    : isLiveSession;
  for (const session of candidates) {
    if (
      session === excludedSession ||
      !isEligible(session) ||
      resolveSessionCharacterID(session) !== targetCharacterID
    ) {
      continue;
    }
    if (isPreferredCharacterSession(session, selectedSession)) {
      selectedSession = session;
    }
  }
  return selectedSession;
}

function findSessionByCharacterID(characterID, options = {}) {
  const targetCharacterID = Number(characterID || 0);
  if (!Number.isInteger(targetCharacterID) || targetCharacterID <= 0) {
    return null;
  }

  const excludedSession = options.excludeSession || null;

  const bucket = sessionsByCharacterID.get(targetCharacterID);
  if (bucket && bucket.size > 0) {
    const indexed = selectPreferredFrom(
      bucket,
      targetCharacterID,
      excludedSession,
      options,
    );
    if (indexed) {
      return indexed;
    }
  }

  // High-frequency read models can explicitly
  // opt out of the defensive O(N) fallback. Normal retail-control callers keep
  // the compatibility scan unless they request indexed-only lookup.
  if (options.indexedOnly === true) {
    return null;
  }

  // Defensive fallback: covers any session whose characterID was set without
  // passing through the index hooks. Keeps results identical to a full scan.
  const fallbackSessions = options.includeClosing === true
    ? Array.from(sessions)
    : getSessions();
  return selectPreferredFrom(
    fallbackSessions,
    targetCharacterID,
    excludedSession,
    options,
  );
}

module.exports = {
  register,
  unregister,
  getSessions,
  isRegisteredSession,
  isCharacterSessionIndexed,
  findSessionByCharacterID,
  indexCharacterSession,
  deindexCharacterSession,
  resolveSessionCharacterID,
  isPreferredCharacterSession,
};
