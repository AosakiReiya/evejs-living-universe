"use strict";

// Web chat-gateway helper (web-client goal R7).
//
// The thin bridge (evejsWebGatewayRuntime) drives a persistent browser-backed
// session. This module gives that session Local AND Corp chat presence + read +
// send WITHOUT touching core chat mechanics: it only *calls* the existing
// chatRuntime / chatHub surfaces and, for Corp, adds a session-derived path that
// mirrors Local (retail Corp chat is XMPP-only, keyed by real XMPP sockets, so a
// browser session no-ops there). Nothing here reimplements chatRuntime delivery,
// chatHub local logic, xmppStubServer, or channelRules — it reuses them.
//
// Survey ground truth (see docs/bridge-wire-contract.md, R7):
//   - Chat delivery deliberately bypasses the notification drain, so READ is a
//     poll of the backlog store: chatRuntime.getChannelBacklog(roomName).
//   - LOCAL presence is derived live from the session registry
//     (chatRuntime.getVisibleLocalSessions(roomName)); the browser session
//     appears once it is registered + docked in the room's system. join =
//     chatHub.joinLocalChannel(session); on system change =
//     chatHub.moveLocalSession(session, prevSystemID); send =
//     chatRuntime.broadcastLocalMessage(session, msg).
//   - CORP connected-player presence is enumerated from the session registry by
//     corpid. Synthetic service members come from chatRuntime's separate
//     corporation roster; they never become authenticated sessions.

const path = require("path");
const { EventEmitter } = require("events");

const chatRuntime = require(path.join(__dirname, "../../chat/chatRuntime"));
const chatHub = require(path.join(
  __dirname,
  "../../../services/chat/chatHub",
));
const xmppStubServer = require(path.join(
  __dirname,
  "../../../services/chat/xmppStubServer",
));
const sessionRegistry = require(path.join(
  __dirname,
  "../../../services/chat/sessionRegistry",
));
const {
  getCurrentSolarSystemID,
  getLocalChatRoomNameForSession,
} = require(path.join(__dirname, "../../../services/chat/channelRules"));

const CHAT_CHANNELS = Object.freeze(["local", "corp"]);
const DEFAULT_BACKLOG_LIMIT = 50;
const MAX_BACKLOG_LIMIT = 200;
const MAX_MESSAGE_LENGTH = 4096;

// A corp analogue of chatRuntime's local-message event: writing a corp message
// to the backlog emits this so an interested session-derived consumer (or a
// test) can observe delivery, mirroring how broadcastLocalMessage emits
// local-message for the local-chat gateway service to forward. Delivery to the
// browser itself is still poll-of-backlog (retail bypasses the notify drain).
const corpChatEmitter = new EventEmitter();

// R7b: hand the private corp emitter to xmppStubServer so a socketless (browser)
// corp member's join/leave/message is mirrored into the corp_<id> XMPP MUC that
// retail clients read their roster from. xmppStubServer never requires this
// module, so registering the subscription from here is cycle-free.
xmppStubServer.subscribeCorpChatBridge(corpChatEmitter);

// A chat refusal the caller should surface as CALL_REFUSED (a channel access
// failure, a mute, or "not in a corporation") rather than CALL_FAILED.
function chatRefusal(message, code = "chat_refused") {
  const error = new Error(message);
  error.name = "WebChatRefusal";
  error.chatRefusal = true;
  error.chatCode = code;
  return error;
}

function normalizeChannel(channel) {
  const normalized = typeof channel === "string" ? channel.trim().toLowerCase() : "";
  if (!CHAT_CHANNELS.includes(normalized)) {
    const error = new Error(
      `chat channel must be one of ${CHAT_CHANNELS.join(", ")}.`,
    );
    error.name = "WebChatInvalid";
    error.chatInvalid = true;
    throw error;
  }
  return normalized;
}

function normalizeLimit(limit) {
  const numeric = Number(limit);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_BACKLOG_LIMIT;
  }
  return Math.min(MAX_BACKLOG_LIMIT, Math.floor(numeric));
}

function normalizeMessage(message) {
  const text = typeof message === "string" ? message : "";
  const trimmed = text.trim();
  if (!trimmed) {
    const error = new Error("chat message must be a non-empty string.");
    error.name = "WebChatInvalid";
    error.chatInvalid = true;
    throw error;
  }
  return trimmed.slice(0, MAX_MESSAGE_LENGTH);
}

function getCorporationID(session) {
  return Number(session && (session.corporationID || session.corpid)) || 0;
}

function getSelectedCharacterID(session) {
  return Number(session && (session.characterID || session.charid)) || 0;
}

function corpRoomName(corporationID) {
  return corporationID > 0 ? `corp_${corporationID}` : "";
}

// Session-derived corp membership (the NEW corp path mirroring Local): every
// live registered session whose corporation matches, collapsed to the single
// preferred session per character (same per-character dedup Local uses so a
// stale duplicate socket never double-lists a member).
function getCorpSessions(corporationID) {
  const corpID = Number(corporationID) || 0;
  if (!corpID) {
    return [];
  }
  const preferredByCharacter = new Map();
  for (const session of sessionRegistry.getSessions()) {
    if (getCorporationID(session) !== corpID) {
      continue;
    }
    const characterID = getSelectedCharacterID(session);
    if (!characterID) {
      continue;
    }
    const current = preferredByCharacter.get(characterID) || null;
    if (
      !current ||
      typeof sessionRegistry.isPreferredCharacterSession !== "function" ||
      sessionRegistry.isPreferredCharacterSession(session, current)
    ) {
      preferredByCharacter.set(characterID, session);
    }
  }
  return [...preferredByCharacter.values()];
}

function getCorpRoster(session) {
  const corporationID = getCorporationID(session);
  const byCharacterID = new Map();
  for (const member of getCorpSessions(corporationID)) {
    const summary = chatRuntime.buildCharacterSummary(member);
    byCharacterID.set(Number(summary.characterID || 0), summary);
  }
  for (const member of chatRuntime.getSyntheticCorporationMembers(corporationID)) {
    const summary = chatRuntime.buildCharacterSummary(member);
    const characterID = Number(summary.characterID || 0);
    if (characterID > 0 && !byCharacterID.has(characterID)) {
      byCharacterID.set(characterID, summary);
    }
  }
  return [...byCharacterID.values()]
    .sort((left, right) => (
      Number(left.characterID || 0) - Number(right.characterID || 0)
    ));
}

// Bring the browser session into Local (and ensure its Corp channel exists) as
// a gateway side-effect. Retail does this from the session-change flow, but the
// browser session's sendSessionChange is a capture stub, so the gateway calls
// this explicitly on select and whenever it polls (which re-syncs Local after a
// dock/system-change). Local membership itself is derived live from the session
// registry, so this is really about emitting the retail join/leave to other
// occupants + tracking the current system to move rooms on a change.
function syncPresence(session) {
  if (!session) {
    return { localRoomName: "", corpRoomName: "" };
  }
  const currentSystemID = getCurrentSolarSystemID(session);
  const previousSystemID = Number(session._webChatLocalSystemID) || 0;
  try {
    if (!previousSystemID) {
      chatHub.joinLocalChannel(session);
    } else if (previousSystemID !== currentSystemID) {
      chatHub.moveLocalSession(session, previousSystemID);
    }
  } catch {
    // Presence sync is best-effort glue; a failure here must never break the
    // read/send the browser asked for.
  }
  session._webChatLocalSystemID = currentSystemID;

  const corporationID = getCorporationID(session);
  const previousCorporationID = Number(session._webChatCorpID) || 0;
  if (corporationID) {
    try {
      chatRuntime.ensureCorpChannel(corporationID);
    } catch {
      // ensureCorpChannel only creates the record; ignore a transient failure.
    }
  }
  // R7b: emit the corp membership transition on corpChatEmitter (which
  // xmppStubServer observes) so retail corp occupants gain/lose the browser
  // member's XMPP presence. Only fires on an actual change, so repeated
  // read/send polls (which re-sync) never re-broadcast a steady-state join.
  if (previousCorporationID !== corporationID) {
    const characterID = getSelectedCharacterID(session);
    if (characterID) {
      if (previousCorporationID) {
        corpChatEmitter.emit("corp-leave", {
          corporationID: previousCorporationID,
          characterID,
        });
      }
      if (corporationID) {
        corpChatEmitter.emit("corp-join", {
          corporationID,
          characterID,
        });
      }
    }
  }
  session._webChatCorpID = corporationID;

  return {
    localRoomName: getLocalChatRoomNameForSession(session),
    corpRoomName: corpRoomName(corporationID),
  };
}

function readLocal(session, limit) {
  const roomName = getLocalChatRoomNameForSession(session);
  const roster = [
    ...chatRuntime.getVisibleLocalSessions(roomName),
    ...chatRuntime.getSyntheticLocalMembers(roomName),
  ]
    .map((member) => chatRuntime.buildCharacterSummary(member));
  return {
    channel: "local",
    roomName,
    solarSystemID: getCurrentSolarSystemID(session),
    corporationID: null,
    roster,
    messages: chatRuntime.getChannelBacklog(roomName, limit),
  };
}

function readCorp(session, limit) {
  const corporationID = getCorporationID(session);
  const roomName = corpRoomName(corporationID);
  if (corporationID) {
    chatRuntime.ensureCorpChannel(corporationID);
  }
  return {
    channel: "corp",
    roomName,
    solarSystemID: getCurrentSolarSystemID(session),
    corporationID: corporationID || null,
    roster: getCorpRoster(session),
    messages: roomName ? chatRuntime.getChannelBacklog(roomName, limit) : [],
  };
}

function readChannel(session, channel, limit) {
  const normalizedChannel = normalizeChannel(channel);
  const normalizedLimit = normalizeLimit(limit);
  return normalizedChannel === "local"
    ? readLocal(session, normalizedLimit)
    : readCorp(session, normalizedLimit);
}

// Corp broadcast: the session-derived analogue of broadcastLocalMessage. It
// writes to the corp_<id> backlog through the same core append Local uses
// (chatRuntime.sendChannelMessage — access is enforced by the channel's own
// corp-membership check) and emits a corp-message runtime event. It does NOT
// touch xmppStubServer (retail corp delivery); browser members read via the
// backlog poll.
function broadcastCorpMessage(session, message) {
  const corporationID = getCorporationID(session);
  if (!corporationID) {
    throw chatRefusal("Character is not in a corporation.", "no_corporation");
  }
  const roomName = corpRoomName(corporationID);
  chatRuntime.ensureCorpChannel(corporationID);
  const result = chatRuntime.sendChannelMessage(session, roomName, message);
  if (!result || !result.entry) {
    throw chatRefusal("Corp message was not delivered.", "not_delivered");
  }
  corpChatEmitter.emit("corp-message", {
    roomName,
    corporationID,
    authorCharacterID: getSelectedCharacterID(session),
    message: result.entry.message,
    entry: result.entry,
  });
  return { roomName, entry: result.entry };
}

function sendChannel(session, channel, message) {
  const normalizedChannel = normalizeChannel(channel);
  const normalizedMessage = normalizeMessage(message);
  try {
    if (normalizedChannel === "local") {
      const result = chatRuntime.broadcastLocalMessage(session, normalizedMessage);
      return {
        channel: "local",
        roomName: getLocalChatRoomNameForSession(session),
        entry: result && result.entry ? result.entry : null,
      };
    }
    const result = broadcastCorpMessage(session, normalizedMessage);
    return {
      channel: "corp",
      roomName: result.roomName,
      entry: result.entry,
    };
  } catch (error) {
    if (error && (error.chatInvalid || error.chatRefusal)) {
      throw error;
    }
    // A channel access failure or mute from the core send (assertChannelAccess /
    // the muted guard throw an Error with a `.code`) is a user-facing refusal.
    if (error && typeof error.code === "string") {
      throw chatRefusal(
        error.message || "Chat message refused.",
        error.code,
      );
    }
    throw error;
  }
}

module.exports = {
  CHAT_CHANNELS,
  DEFAULT_BACKLOG_LIMIT,
  corpChatEmitter,
  getCorpRoster,
  getCorpSessions,
  syncPresence,
  readChannel,
  sendChannel,
  broadcastCorpMessage,
  // exposed for the runtime's typed error mapping + tests
  normalizeChannel,
  normalizeLimit,
  normalizeMessage,
};
